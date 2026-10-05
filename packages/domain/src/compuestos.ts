import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql } from "@ladino/db";
import { parseDecimal, toCents, type Decimal } from "@ladino/money";
import { explodeRecipe, type RecipeLine } from "@ladino/inventory";
import type { InventoryMoveResponse } from "@ladino/schemas";
import { receiveStockFor } from "./inventory.js";

/**
 * LA VENTA DE UN PRODUCTO COMPUESTO (I-04 del recorrido 2026-09-24 · ADR-0035) — RIGOR MÁXIMO.
 *
 * Un compuesto no lleva existencia: venderlo saca sus ingredientes. Aquí viven las tres piezas
 * que la venta y la devolución necesitan, fuera de `sales.ts` para que se lean juntas:
 *
 *   1. `explotarCompuestos`: de las líneas vendidas a las salidas de ingredientes, con la receta
 *      de ESTE momento (un nivel, sin anidar: LAD44);
 *   2. `registrarSalidasDeCompuestos`: deja escrito qué movimiento de kardex produjo cada línea
 *      (`sale_line_components`). Es lo que separa el pan del compuesto del pan suelto de la misma
 *      venta, y lo que hace que una receta que cambia mañana no cambie lo vendido;
 *   3. `reingresarCompuesto`: la devolución devuelve los ingredientes en proporción a lo devuelto
 *      y AL COSTO CON QUE SALIERON, de forma que devolver todo deja la venta en cero exacto.
 *
 * El costo de la línea vendida es la SUMA de los valores de sus salidas —cada una al céntimo y a
 * su propio promedio—, nunca cantidad × un promedio redondeado: la suma la hace quien asienta el
 * costo de ventas, sobre los movimientos reales.
 *
 * Quién mira que esto se cumpla: `platform.composite_sale_gaps()`.
 */

export type CompuestoError =
  { code: "VALIDATION_FAILED"; message: string } | { code: "PERMISSION_REQUIRED"; message: string };

export interface LineaCompuesta {
  /** Posición de la línea en el documento (1..n): con ella se encuentra su `document_lines.id`. */
  readonly lineNumber: number;
  readonly productId: string;
  readonly nombre: string;
  readonly quantity: Decimal;
}

export interface ComponenteDeVenta {
  readonly lineNumber: number;
  readonly parentProductId: string;
  readonly parentName: string;
  readonly childProductId: string;
  /** Lo que sale, en la unidad del ingrediente. */
  readonly quantity: string;
  /** La receta de este momento: cantidad por unidad del compuesto y factor a la unidad del hijo. */
  readonly recipeQuantity: string;
  readonly unitFactor: string;
}

export async function explotarCompuestos(
  sql: TransactionSql,
  companyId: string,
  lineas: readonly LineaCompuesta[],
): Promise<Result<ComponenteDeVenta[], CompuestoError>> {
  if (lineas.length === 0) return ok([]);
  const padres = [...new Set(lineas.map((l) => l.productId))];
  const recetas = await sql<
    {
      parent_product_id: string;
      child_product_id: string;
      child_name: string;
      quantity: string;
      line_unit: string;
      product_unit: string;
      factor: string | null;
    }[]
  >`
    select r.parent_product_id, r.child_product_id, hijo.name as child_name,
           r.quantity::text as quantity, r.unit_code as line_unit,
           hijo.unit_code as product_unit,
           platform.convert_quantity(1, r.unit_code, hijo.unit_code)::text as factor
      from public.product_recipes r
      join public.products hijo on hijo.id = r.child_product_id
     where r.company_id = ${companyId} and r.parent_product_id = any(${padres}::uuid[])
     order by r.parent_product_id, r.child_product_id`;

  const salida: ComponenteDeVenta[] = [];
  for (const linea of lineas) {
    const receta = recetas.filter((r) => r.parent_product_id === linea.productId);
    if (receta.length === 0) {
      return err({
        code: "VALIDATION_FAILED",
        message: `«${linea.nombre}» es un compuesto y no tiene ingredientes: escribe su receta antes de venderlo.`,
      });
    }
    const resueltas: RecipeLine[] = [];
    for (const r of receta) {
      const cantidad = parseDecimal(r.quantity);
      if (!cantidad.ok) return err({ code: "VALIDATION_FAILED", message: cantidad.error.message });
      if (r.factor === null) {
        return err({
          code: "VALIDATION_FAILED",
          message: `La receta de «${linea.nombre}» pide «${r.child_name}» en ${r.line_unit}, y ese producto se lleva en ${r.product_unit}: no hay cómo pasar de una a otra. Corrige la unidad en la receta.`,
        });
      }
      const factor = parseDecimal(r.factor);
      if (!factor.ok) return err({ code: "VALIDATION_FAILED", message: factor.error.message });
      resueltas.push({
        childProductId: r.child_product_id,
        quantity: cantidad.value,
        factorToProductUnit: factor.value,
        lineUnitCode: r.line_unit,
        productUnitCode: r.product_unit,
      });
    }
    const explotada = explodeRecipe(resueltas, linea.quantity);
    if (!explotada.ok) {
      return err({
        code: "VALIDATION_FAILED",
        message: `«${linea.nombre}»: ${explotada.error.message}`,
      });
    }
    for (const e of explotada.value) {
      const r = receta.find((x) => x.child_product_id === e.childProductId)!;
      salida.push({
        lineNumber: linea.lineNumber,
        parentProductId: linea.productId,
        parentName: linea.nombre,
        childProductId: e.childProductId,
        quantity: e.quantity.toFixed(),
        recipeQuantity: r.quantity,
        unitFactor: r.factor!,
      });
    }
  }
  return ok(salida);
}

/**
 * A QUÉ LÍNEA PEDIDA PERTENECE CADA MOVIMIENTO. La salida en lote devuelve los movimientos en el
 * orden de las líneas pedidas, pero una línea de un producto con lotes produce VARIOS (uno por
 * lote, por vencimiento) que suman exactamente lo pedido. Se recorren en orden, acumulando hasta
 * completar cada línea. Si algo no cuadra se devuelve `null`: quien llama aborta la venta, que es
 * mejor que atribuir una salida a la línea equivocada.
 */
export function movimientosPorLinea(
  pedidas: readonly { readonly product_id: string; readonly quantity: string }[],
  movimientos: readonly InventoryMoveResponse[],
): InventoryMoveResponse[][] | null {
  const resultado: InventoryMoveResponse[][] = [];
  let cursor = 0;
  for (const pedida of pedidas) {
    const meta = parseDecimal(pedida.quantity);
    if (!meta.ok) return null;
    let falta = meta.value;
    const suyos: InventoryMoveResponse[] = [];
    while (falta.greaterThan(0)) {
      const m = movimientos[cursor];
      if (m === undefined || m.product_id !== pedida.product_id) return null;
      const q = parseDecimal(m.quantity);
      if (!q.ok) return null;
      falta = falta.minus(q.value.abs());
      suyos.push(m);
      cursor += 1;
    }
    if (!falta.isZero()) return null;
    resultado.push(suyos);
  }
  return cursor === movimientos.length ? resultado : null;
}

/**
 * LA PROPORCIÓN ACUMULADA de una devolución (pura): cuánto debe HABER VUELTO de una salida, en
 * cantidad (8 decimales) y en valor (al céntimo), cuando van devueltas `acumulada` de `vendida`
 * unidades del compuesto. Devuelta la última, vuelve exactamente lo que salió: sin residuo.
 */
export function debeHaberVueltoDe(
  salio: Decimal,
  valor: Decimal,
  acumulada: Decimal,
  vendida: Decimal,
): { cantidad: Decimal; valor: Decimal } {
  if (acumulada.equals(vendida)) return { cantidad: salio, valor };
  return {
    cantidad: salio.times(acumulada).dividedBy(vendida).toDecimalPlaces(8, 4),
    valor: toCents(valor.times(acumulada).dividedBy(vendida)),
  };
}

export async function registrarSalidasDeCompuestos(
  sql: TransactionSql,
  input: {
    readonly tenantId: string;
    readonly companyId: string;
    readonly documentId: string;
    readonly componentes: readonly ComponenteDeVenta[];
    /** Los movimientos de cada componente, en el mismo orden que `componentes`. */
    readonly movimientos: readonly InventoryMoveResponse[][];
  },
): Promise<Result<number, CompuestoError>> {
  const filas: Record<string, string | number>[] = [];
  for (let i = 0; i < input.componentes.length; i += 1) {
    const c = input.componentes[i]!;
    for (const m of input.movimientos[i] ?? []) {
      filas.push({
        line_number: c.lineNumber,
        parent: c.parentProductId,
        child: c.childProductId,
        move_id: m.id,
        quantity: m.quantity.replace("-", ""),
        amount: m.functional_amount.replace("-", ""),
        recipe_quantity: c.recipeQuantity,
        unit_factor: c.unitFactor,
      });
    }
  }
  if (filas.length === 0) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La venta de un compuesto no sacó ningún ingrediente: no se registra.",
    });
  }
  const escritas = await sql<{ id: string }[]>`
    insert into public.sale_line_components
      (tenant_id, company_id, document_id, document_line_id, parent_product_id,
       child_product_id, direction, move_id, quantity, functional_amount, recipe_quantity,
       unit_factor)
    select ${input.tenantId}, ${input.companyId}, ${input.documentId}, dl.id, x.parent, x.child,
           'out', x.move_id, x.quantity, x.amount, x.recipe_quantity, x.unit_factor
      from jsonb_to_recordset(${sql.json(filas)}::jsonb) as x(
             line_number integer, parent uuid, child uuid, move_id uuid, quantity numeric,
             amount numeric, recipe_quantity numeric, unit_factor numeric)
      join public.document_lines dl
        on dl.document_id = ${input.documentId} and dl.line_number = x.line_number
    returning id`;
  if (escritas.length !== filas.length) {
    return err({
      code: "VALIDATION_FAILED",
      message: "No se pudo ligar cada ingrediente con su línea de venta: la venta no se registra.",
    });
  }
  return ok(escritas.length);
}

/**
 * LA DEVOLUCIÓN DE UNA LÍNEA DE COMPUESTO. Devuelve `null` si la línea no es de un compuesto (no
 * tiene salidas de ingredientes escritas): la devolución sigue entonces su camino de siempre.
 *
 * Proporción ACUMULADA, no por devolución: tras devolver `d` de `v` vendidas, de cada salida debe
 * haber vuelto `round8(cantidad × d / v)` y `céntimo(valor × d / v)`; esta devolución reingresa
 * la diferencia con lo que YA volvió. Así el redondeo de una devolución lo corrige la siguiente,
 * y al devolver la última unidad vuelve exactamente lo que faltaba: la venta netea a cero en
 * cantidad y en valor, sin residuo. Cada reingreso va al MISMO lote del que salió.
 */
export async function reingresarCompuesto(
  uow: UnitOfWork,
  input: {
    readonly tenantId: string;
    readonly companyId: string;
    readonly functionalCurrency: string;
    readonly returnId: string;
    readonly sourceDocumentId: string;
    readonly sourceLineId: string;
    readonly warehouseId: string;
    readonly pedida: Decimal;
  },
): Promise<Result<Decimal | null, CompuestoError>> {
  const { sql } = uow;
  const salidas = await sql<
    {
      move_id: string;
      parent_product_id: string;
      child_product_id: string;
      lot_id: string | null;
      quantity: string;
      valor: string;
      volvio: string;
      valor_volvio: string;
      recipe_quantity: string;
      unit_factor: string;
    }[]
  >`
    select c.move_id, c.parent_product_id, c.child_product_id, m.lot_id,
           c.quantity::text as quantity, c.functional_amount::text as valor,
           coalesce(v.volvio, 0)::text as volvio, coalesce(v.valor_volvio, 0)::text as valor_volvio,
           c.recipe_quantity::text as recipe_quantity, c.unit_factor::text as unit_factor
      from public.sale_line_components c
      join public.inventory_moves m on m.id = c.move_id
      left join lateral (
        select sum(b.quantity) as volvio, sum(b.functional_amount) as valor_volvio
          from public.sale_line_components b
         where b.reverses_move_id = c.move_id and b.direction = 'back') v on true
     where c.company_id = ${input.companyId} and c.document_line_id = ${input.sourceLineId}
       and c.direction = 'out'
     order by c.created_at, c.id`;
  if (salidas.length === 0) return ok(null);

  const [tope] = await sql<{ vendida: string; devuelta: string }[]>`
    select dl.quantity::text as vendida,
           coalesce((select sum(rl.quantity) from public.return_lines rl
                      join public.returns r on r.id = rl.return_id
                     where rl.source_line_id = dl.id and r.status = 'confirmed'), 0)::text
             as devuelta
      from public.document_lines dl where dl.id = ${input.sourceLineId}`;
  const vendida = parseDecimal(tope?.vendida ?? "0");
  const devuelta = parseDecimal(tope?.devuelta ?? "0");
  if (!vendida.ok || !devuelta.ok || !vendida.value.greaterThan(0)) {
    return err({ code: "VALIDATION_FAILED", message: "Cantidades no interpretables." });
  }
  const acumulada = devuelta.value.plus(input.pedida);
  if (acumulada.greaterThan(vendida.value)) {
    return err({
      code: "VALIDATION_FAILED",
      message: `No se puede devolver más de lo vendido: la línea tiene ${vendida.value.toFixed()} y ya se devolvieron ${devuelta.value.toFixed()}.`,
    });
  }

  let reingresado = input.pedida.minus(input.pedida);
  for (const s of salidas) {
    const salio = parseDecimal(s.quantity);
    const valor = parseDecimal(s.valor);
    const volvio = parseDecimal(s.volvio);
    const valorVolvio = parseDecimal(s.valor_volvio);
    if (!salio.ok || !valor.ok || !volvio.ok || !valorVolvio.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Importes no interpretables." });
    }
    const debe = debeHaberVueltoDe(salio.value, valor.value, acumulada, vendida.value);
    const debeValer = debe.valor;
    const cantidad = debe.cantidad.minus(volvio.value);
    // Una fracción tan pequeña que no llega a la escala del kardex: la recoge la devolución
    // siguiente (la proporción es acumulada).
    if (!cantidad.greaterThan(0)) continue;
    const bruto = debeValer.minus(valorVolvio.value);
    const importe = bruto.lessThan(0) ? bruto.minus(bruto) : bruto;

    const mov = await receiveStockFor(
      uow,
      {
        company_id: input.companyId,
        warehouse_id: input.warehouseId,
        product_id: s.child_product_id,
        ...(s.lot_id === null ? {} : { lot_id: s.lot_id }),
        quantity: cantidad.toFixed(),
        amount: importe.toFixed(8),
        currency: input.functionalCurrency,
        sourceDocumentId: input.returnId,
        accounting: "document",
      },
      "sales.return.manage",
    );
    if (!mov.ok) {
      return err(
        mov.error.code === "PERMISSION_REQUIRED"
          ? { code: "PERMISSION_REQUIRED", message: mov.error.message }
          : { code: "VALIDATION_FAILED", message: mov.error.message },
      );
    }
    await sql`
      insert into public.sale_line_components
        (tenant_id, company_id, document_id, document_line_id, parent_product_id,
         child_product_id, direction, move_id, return_id, reverses_move_id, quantity,
         functional_amount, recipe_quantity, unit_factor)
      values (${input.tenantId}, ${input.companyId}, ${input.sourceDocumentId},
              ${input.sourceLineId}, ${s.parent_product_id}, ${s.child_product_id}, 'back',
              ${mov.value.id}, ${input.returnId}, ${s.move_id}, ${mov.value.quantity},
              ${mov.value.functional_amount}, ${s.recipe_quantity}, ${s.unit_factor})`;
    const v = parseDecimal(mov.value.functional_amount);
    if (!v.ok) return err({ code: "VALIDATION_FAILED", message: v.error.message });
    reingresado = reingresado.plus(v.value);
  }
  return ok(reingresado);
}

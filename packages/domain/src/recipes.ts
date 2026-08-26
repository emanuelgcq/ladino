import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql } from "@ladino/db";
import { Money, parseDecimal } from "@ladino/money";
import { explodeRecipe, totalCost, type RecipeLine } from "@ladino/inventory";
import type {
  ConsumeRecipeRequest,
  ConsumeRecipeResponse,
  InventoryMoveResponse,
} from "@ladino/schemas";
import { issueStock, type InventoryError } from "./inventory.js";

/**
 * Consumo de un producto COMPUESTO (ADR-0035) — RIGOR MÁXIMO: define el costo de
 * lo que se vende.
 *
 * Vender doce arepas no descuenta arepas: descuenta harina y leche. Este caso de
 * uso explota la receta, convierte cada línea a la unidad del ingrediente y
 * genera UNA salida por ingrediente, todas ligadas por `source_document_id` y
 * todas en la MISMA transacción — media receta consumida sería un inventario
 * mentiroso y un costo imposible de explicar.
 *
 * El costo del compuesto es la SUMA de lo que costó cada salida real, no una
 * estimación: cada ingrediente sale a su propio promedio móvil.
 */
export type RecipeError = InventoryError;

interface LineaCruda {
  child_product_id: string;
  quantity: string;
  line_unit: string;
  product_unit: string;
  factor: string | null;
}

/**
 * Trae la receta con la conversión YA RESUELTA por la base: `convert_quantity`
 * devuelve NULL cuando no hay fila, y ese NULL viaja hasta el paquete puro, que
 * es quien decide que sin conversión no se consume. La alternativa —convertir
 * aquí— repartiría la regla entre dos sitios.
 */
async function lineasDeReceta(
  sql: TransactionSql,
  companyId: string,
  parentId: string,
): Promise<LineaCruda[]> {
  return sql<LineaCruda[]>`
    select r.child_product_id,
           r.quantity::text as quantity,
           r.unit_code as line_unit,
           hijo.unit_code as product_unit,
           platform.convert_quantity(1, r.unit_code, hijo.unit_code)::text as factor
      from public.product_recipes r
      join public.products hijo on hijo.id = r.child_product_id
     where r.company_id = ${companyId} and r.parent_product_id = ${parentId}
     order by r.child_product_id`;
}

export async function consumeRecipe(
  uow: UnitOfWork,
  input: ConsumeRecipeRequest,
): Promise<Result<ConsumeRecipeResponse, RecipeError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Consumir una receta exige un usuario real.",
    });
  }

  const [compuesto] = await sql<{ is_composed: boolean; name: string }[]>`
    select is_composed, name from public.products
     where id = ${input.product_id} and company_id = ${input.company_id}`;
  if (!compuesto) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (!compuesto.is_composed) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Ese producto no es compuesto: se despacha con una salida normal, no consumiendo una receta.",
    });
  }

  const crudas = await lineasDeReceta(sql, input.company_id, input.product_id);
  const veces = parseDecimal(input.quantity);
  if (!veces.ok) return err({ code: "VALIDATION_FAILED", message: veces.error.message });

  const lineas: RecipeLine[] = [];
  for (const c of crudas) {
    const cantidad = parseDecimal(c.quantity);
    if (!cantidad.ok) return err({ code: "VALIDATION_FAILED", message: cantidad.error.message });
    let factor = null;
    if (c.factor !== null) {
      const f = parseDecimal(c.factor);
      if (!f.ok) return err({ code: "VALIDATION_FAILED", message: f.error.message });
      factor = f.value;
    }
    lineas.push({
      childProductId: c.child_product_id,
      quantity: cantidad.value,
      factorToProductUnit: factor,
      lineUnitCode: c.line_unit,
      productUnitCode: c.product_unit,
    });
  }

  const explotada = explodeRecipe(lineas, veces.value);
  if (!explotada.ok) {
    return err(
      explotada.error.code === "UNIT_CONVERSION_MISSING"
        ? { code: "UNIT_CONVERSION_MISSING", message: explotada.error.message }
        : { code: "VALIDATION_FAILED", message: explotada.error.message },
    );
  }

  // Un solo documento de origen para todas las salidas: es UN hecho.
  const [ids] = await sql<{ documento: string }[]>`select platform.uuidv7() as documento`;
  const documento = input.source_document_id ?? ids!.documento;

  const salidas: InventoryMoveResponse[] = [];
  const costos: Money[] = [];
  for (const linea of explotada.value) {
    const r = await issueStock(uow, {
      company_id: input.company_id,
      warehouse_id: input.warehouse_id,
      product_id: linea.childProductId,
      quantity: linea.quantity.toFixed(),
      ...(input.occurred_at !== undefined ? { occurred_at: input.occurred_at } : {}),
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      sourceDocumentId: documento,
    });
    // Sin savepoint a propósito: si un ingrediente no alcanza, la venta entera
    // no ocurrió. Media receta consumida es peor que ninguna — el plato no se
    // sirvió y el inventario diría que sí.
    if (!r.ok) return r;
    salidas.push(r.value);
    const costo = Money.of(r.value.functional_amount.replace("-", ""), r.value.functional_currency);
    if (!costo.ok) return err({ code: "VALIDATION_FAILED", message: costo.error.message });
    costos.push(costo.value);
  }

  const total = totalCost(costos);
  if (!total.ok) return err({ code: "VALIDATION_FAILED", message: total.error.message });

  return ok({
    source_document_id: documento,
    product_id: input.product_id,
    quantity: input.quantity,
    total_cost: total.value.toAmountString(),
    currency: total.value.currency,
    moves: salidas,
  });
}

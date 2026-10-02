import { err, ok, type Result } from "@ladino/core";
import { withTransaction, type Sql, type UnitOfWork } from "@ladino/db";
import type {
  ImportNumberFormat,
  MoneyInput,
  ProductImportJobResponse,
  ProductImportJobRowResult,
  ProductImportRow,
} from "@ladino/schemas";
import { companyScope } from "./company-scope.js";
import {
  createProductSimple,
  listaDeDestino,
  ponerPrecioEnLista,
  type ProductError,
} from "./products.js";
import { RULES_VERSION } from "./create-company.js";

/**
 * LA IMPORTACIÓN DE PRODUCTOS COMO TRABAJO (ADR-0074; hallazgos C-01, C-04 y C-05 del recorrido
 * 2026-09-24, y la revisión H1–H11 de la familia). Tres piezas, en este orden:
 *
 *   1. `interpretarFilasProductos` — PURA. De la matriz de celdas-texto a filas interpretadas,
 *      con el formato numérico DECLARADO (C-01) y coherente por archivo (H6). Lo que devuelve es
 *      exactamente lo que se va a guardar: la vista previa y el trabajo leen lo mismo, y nada se
 *      descarta en silencio (C-05).
 *   2. `crearTrabajoImportacion` — la petición SOLO crea el trabajo. La llave natural es
 *      (empresa, hash del archivo, formato), parcial sobre los trabajos no fallados (H1-d).
 *   3. `procesarTrabajoImportacion` — lo llama el worker. UNA fila por transacción, y en esa
 *      misma transacción avanza el contador del trabajo: una fila o se hizo y consta, o no se hizo
 *      y no consta. Una fila que la base rechaza queda rechazada con su motivo, no tumba el
 *      trabajo (H1). Dentro del trabajo, el CÓDIGO del producto es la llave.
 *
 * Los importes son TEXTO de punta a punta (regla 7): aquí no hay un solo `number` de dinero.
 */

export type ProductImportError = ProductError;

/** Máximo de filas por archivo (vista previa y trabajo). */
export const MAX_FILAS_IMPORTACION = 500;

/** Los largos de los CHECK de `products` y `product_categories` (H1-a). */
const LARGO_MAXIMO = { nombre: 200, codigo: 60, barras: 64, categoria: 100 } as const;

/** El mensaje de H2: cambiar un precio no lo autoriza el alta (§2.8). */
export const SIN_PERMISO_DE_PRECIO =
  "Necesitas el permiso para cambiar precios. Pídeselo a quien administra.";

// ── 1. Los números con formato declarado (C-01) ─────────────────────────────

type Lectura =
  | {
      ok: true;
      value: string;
      aviso?: string;
      /** Se leyó con el formato CONTRARIO al declarado (la única lectura posible). */
      contrario?: boolean;
      /** Leída con el formato declarado, pero con el contrario sería otro número: «1.250». */
      alternativa?: string;
    }
  | { ok: false; motivo: string };

const NOMBRE_FORMATO: Record<ImportNumberFormat, string> = {
  comma_decimal: "coma decimal (1.234,50)",
  dot_decimal: "punto decimal (1,234.50)",
};

function escapar(c: string): string {
  return c === "." ? "\\." : c;
}

/** «0.500» → «0.5»; «007» → «7»; «12.000» → «12». Solo representación, nunca redondeo. */
function normalizar(canonico: string): string {
  const [entera = "0", decimal = ""] = canonico.split(".");
  const ent = entera.replace(/^0+(?=\d)/, "");
  const dec = decimal.replace(/0+$/, "");
  return dec === "" ? ent : `${ent}.${dec}`;
}

/** Cómo se enseña un número normalizado en el formato elegido (solo texto, sin aritmética). */
function enFormato(valor: string, formato: ImportNumberFormat): string {
  return formato === "comma_decimal" ? valor.replace(".", ",") : valor;
}

function opuesto(formato: ImportNumberFormat): ImportNumberFormat {
  return formato === "comma_decimal" ? "dot_decimal" : "comma_decimal";
}

/**
 * Lee un número con el formato DECLARADO. Tres salidas:
 *
 *   · la lectura canónica del formato («1.234,56» o «0,5» con coma decimal) → el valor;
 *   · una celda que solo se entiende con el formato CONTRARIO y que no tiene otra lectura
 *     («0.90» con coma decimal: el punto no puede ser de miles) → el valor, con AVISO visible;
 *   · una celda con DOS lecturas bajo el formato elegido — la que el lector viejo tomaba por
 *     separador de miles («0.500» → 500) y la del formato contrario («0.500» → 0,5) → se
 *     RECHAZA como ambigua, con el motivo. Es C-01: el lector viejo elegía por su cuenta.
 */
export function leerNumeroDeclarado(crudo: string, formato: ImportNumberFormat): Lectura {
  const t = crudo.trim().replace(/\s/g, ""); // \s incluye el espacio duro (U+00A0) de Excel
  if (t === "") return { ok: false, motivo: "vacío" };
  const D = formato === "comma_decimal" ? "," : ".";
  const G = formato === "comma_decimal" ? "." : ",";
  const d = escapar(D);
  const g = escapar(G);
  const canonico = new RegExp(`^(\\d+|[1-9]\\d{0,2}(${g}\\d{3})+)(${d}\\d+)?$`);
  const contrario = new RegExp(`^(\\d+|[1-9]\\d{0,2}(${d}\\d{3})+)(${g}\\d+)?$`);
  // Lo que un lector «tolerante» toma por miles aunque el primer grupo sea 0: «0.500».
  const milesLaxo = new RegExp(`^\\d{1,3}(${g}\\d{3})+(${d}\\d+)?$`);

  let valor: string;
  let aviso: string | undefined;
  let leidoContrario = false;
  let alternativa: string | undefined;
  if (canonico.test(t)) {
    valor = normalizar(t.split(G).join("").replace(D, "."));
    // «1.250» con coma decimal es 1250; con punto decimal sería 1,25 (H6).
    if (t.includes(G) && contrario.test(t)) {
      alternativa = normalizar(t.split(D).join("").replace(G, "."));
    }
  } else if (contrario.test(t)) {
    const comoContrario = normalizar(t.split(D).join("").replace(G, "."));
    if (milesLaxo.test(t)) {
      const comoMiles = normalizar(t.split(G).join("").replace(D, "."));
      return {
        ok: false,
        motivo:
          `«${crudo.trim()}» es ambiguo con ${NOMBRE_FORMATO[formato]}: ` +
          `¿${enFormato(comoContrario, formato)} o ${enFormato(comoMiles, formato)}? ` +
          `Escríbelo como «${enFormato(comoContrario, formato)}» (o «${enFormato(comoMiles, formato)}»), ` +
          "o elige el otro formato de números.",
      };
    }
    valor = comoContrario;
    leidoContrario = true;
    aviso =
      `«${crudo.trim()}» se leyó como ${enFormato(valor, formato)}: usa ` +
      `${formato === "comma_decimal" ? "punto" : "coma"} decimal, y el formato elegido es ` +
      `${NOMBRE_FORMATO[formato]}.`;
  } else {
    return { ok: false, motivo: `«${crudo.trim()}» no se entiende como número` };
  }
  if (!/^\d{1,16}(\.\d{1,8})?$/.test(valor)) {
    return {
      ok: false,
      motivo: `«${crudo.trim()}» tiene demasiadas cifras: hasta 16 enteros y 8 decimales`,
    };
  }
  return {
    ok: true,
    value: valor,
    ...(aviso === undefined ? {} : { aviso }),
    ...(leidoContrario ? { contrario: true } : {}),
    ...(alternativa === undefined ? {} : { alternativa }),
  };
}

// ── 1b. Las filas interpretadas (C-01, C-05, H1, H6) ────────────────────────

/** Lo que se va a guardar de una fila lista. */
export interface FilaLista {
  name: string;
  price: MoneyInput;
  sku?: string;
  barcode?: string;
  category_name?: string;
  is_service: boolean;
  initial_stock: { quantity: string; unit_cost: MoneyInput } | null;
  reference_cost: MoneyInput | null;
}

export interface Interpretacion {
  filas: ProductImportRow[];
  /**
   * H6: el formato que el archivo PARECE usar cuando alguna celda solo se entiende con el
   * contrario al declarado. `null` si el archivo es coherente con lo declarado.
   */
  formatoSospechoso: ImportNumberFormat | null;
}

function sinAcentos(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/**
 * De la matriz de celdas-TEXTO (la fila 0 son los títulos) a las filas interpretadas. PURA: sin
 * I/O ni reloj. Las filas vacías se saltan pero conservan la numeración del archivo.
 *
 * COHERENCIA POR ARCHIVO (H6, decidido por criterio): si alguna celda numérica del archivo solo
 * se entiende con el formato contrario al declarado, el archivo no es de fiar en ese punto, y las
 * celdas con grupo de miles que en el otro formato serían otro número («1.250»: ¿1.250 o 1,25?)
 * se rechazan como ambiguas. Alternativa descartada: detectar el formato por archivo.
 */
export function interpretarFilasProductos(
  matriz: readonly (readonly string[])[],
  formato: ImportNumberFormat,
): Result<Interpretacion, { code: "VALIDATION_FAILED"; message: string }> {
  if (matriz.length < 2) {
    return err({
      code: "VALIDATION_FAILED",
      message: "El archivo no tiene filas de productos: la primera fila son los títulos.",
    });
  }
  if (matriz.length > MAX_FILAS_IMPORTACION + 1) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Máximo ${MAX_FILAS_IMPORTACION} productos por archivo. Divide el archivo y sube las partes.`,
    });
  }
  // El encabezado, normalizado sin acentos ni mayúsculas: «Código de barras» o «codigo barras».
  const columnas = new Map<string, number>();
  matriz[0]!.forEach((celda, i) => columnas.set(sinAcentos(celda), i));
  const col = (...nombres: string[]): number | undefined => {
    for (const n of nombres) {
      const c = columnas.get(n);
      if (c !== undefined) return c;
    }
    return undefined;
  };
  const colNombre = col("nombre", "producto", "descripcion");
  const colPrecio = col("precio", "precio detal", "pvp");
  if (colNombre === undefined || colPrecio === undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message: "El archivo necesita al menos las columnas «Nombre» y «Precio» en la fila 1.",
    });
  }
  const colMoneda = col("moneda", "moneda precio");
  const colSku = col("codigo", "sku");
  const colBarras = col("codigo de barras", "codigo barras", "barras", "ean");
  const colCategoria = col("categoria");
  const colExistencia = col("existencia", "cantidad", "stock");
  const colCosto = col("costo", "costo unitario");
  const colMonedaCosto = col("moneda costo", "moneda del costo");
  const colServicio = col("es servicio", "servicio");

  // H6: ¿alguna celda numérica del archivo solo se entiende con el formato contrario?
  let sospechoso = false;
  for (let i = 1; i < matriz.length && !sospechoso; i++) {
    for (const c of [colPrecio, colExistencia, colCosto]) {
      if (c === undefined) continue;
      const celda = (matriz[i]![c] ?? "").trim();
      if (celda === "") continue;
      const r = leerNumeroDeclarado(celda, formato);
      if (r.ok && r.contrario === true) sospechoso = true;
    }
  }
  const leer = (crudo: string): Lectura => {
    const r = leerNumeroDeclarado(crudo, formato);
    if (sospechoso && r.ok && r.alternativa !== undefined) {
      return {
        ok: false,
        motivo:
          `«${crudo.trim()}» es ambiguo: otras celdas del archivo usan ` +
          `${formato === "comma_decimal" ? "punto" : "coma"} decimal, así que puede ser ` +
          `${enFormato(r.alternativa, formato)} o ${enFormato(r.value, formato)}. Revisa el ` +
          "formato de los números del archivo.",
      };
    }
    return r;
  };

  const filas: ProductImportRow[] = [];
  for (let i = 1; i < matriz.length; i++) {
    const celdas = matriz[i]!;
    const row = i + 1; // número de fila HUMANO (1 = títulos), como en el Excel
    const texto = (c: number | undefined): string =>
      c === undefined ? "" : (celdas[c] ?? "").trim();
    const nombre = texto(colNombre);
    const precioCrudo = texto(colPrecio);
    if (nombre === "" && precioCrudo === "") continue; // fila vacía: se ignora

    const avisos: string[] = [];
    const rechazar = (message: string): void => {
      filas.push({
        row,
        status: "rejected",
        message,
        warnings: avisos,
        ...(nombre === "" ? {} : { name: nombre.slice(0, LARGO_MAXIMO.nombre) }),
      });
    };
    if (nombre === "") {
      rechazar("Falta el nombre del producto.");
      continue;
    }
    const sku = texto(colSku);
    const barras = texto(colBarras);
    const categoria = texto(colCategoria);
    // H1-a: los largos de la base, dichos antes de intentarlo.
    const largo = (
      [
        ["El nombre", nombre, LARGO_MAXIMO.nombre],
        ["El código", sku, LARGO_MAXIMO.codigo],
        ["El código de barras", barras, LARGO_MAXIMO.barras],
        ["La categoría", categoria, LARGO_MAXIMO.categoria],
      ] as const
    ).find(([, v, max]) => v.length > max);
    if (largo) {
      rechazar(
        `${largo[0]} tiene ${largo[1].length} caracteres; el máximo es ${largo[2]}. Acórtalo en el archivo.`,
      );
      continue;
    }
    const precio = leer(precioCrudo);
    if (!precio.ok) {
      rechazar(
        precio.motivo.includes("ambiguo") || precio.motivo.includes("demasiadas cifras")
          ? `El precio ${precio.motivo}`
          : `El precio no se entiende («${precioCrudo || "vacío"}»). Escribe solo el número, por ejemplo ${formato === "comma_decimal" ? "2,50" : "2.50"}.`,
      );
      continue;
    }
    if (precio.aviso) avisos.push(`Precio: ${precio.aviso}`);
    const moneda = (texto(colMoneda) || "USD").toUpperCase();
    if (!/^[A-Z]{3}$/.test(moneda)) {
      rechazar(`La moneda «${texto(colMoneda)}» no se entiende. El precio va en dólares (USD).`);
      continue;
    }

    const esServicio = /^(si|sí|x|true|1)$/i.test(texto(colServicio));
    const existenciaCruda = texto(colExistencia);
    const costoCrudo = texto(colCosto);
    // Como el precio, el costo va en dólares si la fila no dice otra cosa. «Bs» es VES.
    const monedaCostoCruda = (texto(colMonedaCosto) || "USD").toUpperCase();
    const monedaCosto = /^BS\.?$/.test(monedaCostoCruda) ? "VES" : monedaCostoCruda;

    let inicial: FilaLista["initial_stock"] = null;
    let referencia: MoneyInput | null = null;

    if (esServicio && existenciaCruda !== "") {
      // C-05: antes se descartaba sin decir nada.
      avisos.push(
        `Es un servicio: la existencia («${existenciaCruda}») se ignora — un servicio no lleva inventario.`,
      );
    }
    if (!esServicio && existenciaCruda !== "") {
      const cantidad = leer(existenciaCruda);
      if (!cantidad.ok || !/[1-9]/.test(cantidad.value)) {
        rechazar(
          !cantidad.ok && cantidad.motivo.includes("ambiguo")
            ? `La existencia ${cantidad.motivo}`
            : `La existencia no se entiende («${existenciaCruda}»).`,
        );
        continue;
      }
      if (cantidad.aviso) avisos.push(`Existencia: ${cantidad.aviso}`);
      const costo = leer(costoCrudo);
      if (!costo.ok) {
        rechazar(
          costo.motivo.includes("ambiguo")
            ? `El costo ${costo.motivo}`
            : `Para cargar existencia hace falta el costo unitario, y «${costoCrudo || "vacío"}» no se entiende.`,
        );
        continue;
      }
      if (costo.aviso) avisos.push(`Costo: ${costo.aviso}`);
      inicial = {
        quantity: cantidad.value,
        unit_cost: { amount: costo.value, currency: monedaCosto },
      };
    } else if (costoCrudo !== "") {
      // C-05: el costo sin existencia (o el de un servicio) se acepta como costo de REFERENCIA,
      // con aviso, y se guarda en el producto (H11). No mueve inventario ni contabilidad.
      const costo = leer(costoCrudo);
      if (!costo.ok) {
        rechazar(`El costo ${costo.motivo}.`);
        continue;
      }
      if (costo.aviso) avisos.push(`Costo: ${costo.aviso}`);
      referencia = { amount: costo.value, currency: monedaCosto };
      avisos.push(
        `El costo («${costoCrudo}») sin existencia se acepta como costo de referencia: se guarda ` +
          "en el producto y no mueve inventario ni contabilidad.",
      );
    }

    filas.push({
      row,
      status: "ready",
      warnings: avisos,
      name: nombre,
      price: { amount: precio.value, currency: moneda },
      is_service: esServicio,
      initial_stock: inicial,
      reference_cost: referencia,
      ...(sku === "" ? {} : { sku }),
      ...(barras === "" ? {} : { barcode: barras }),
      ...(categoria === "" ? {} : { category_name: categoria }),
    });
  }
  return ok({ filas, formatoSospechoso: sospechoso ? opuesto(formato) : null });
}

/**
 * La vista previa dice la VERDAD sobre los códigos que ya existen (H1): esa fila actualiza
 * solo el precio — no cambia ni la existencia ni el nombre — y, sin `price_list.manage`, un
 * precio distinto la rechazará (H2). Solo lee.
 */
export async function anotarCodigosExistentes(
  uow: UnitOfWork,
  companyId: string,
  filas: ProductImportRow[],
): Promise<Result<ProductImportRow[], ProductImportError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, companyId, "product.manage");
  if (!scope.ok) return scope;
  const codigos = filas.flatMap((f) => (f.status === "ready" && f.sku ? [f.sku] : []));
  if (codigos.length === 0) return ok(filas);
  const existentes = await sql<{ sku: string; name: string }[]>`
    select sku, name from public.products
     where company_id = ${companyId} and sku = any(${codigos}::text[])`;
  if (existentes.length === 0) return ok(filas);
  const porCodigo = new Map(existentes.map((e) => [e.sku, e.name]));
  const precios = await companyScope(sql, actor.userId, companyId, "price_list.manage");
  return ok(
    filas.map((f) => {
      const nombre = f.sku === undefined ? undefined : porCodigo.get(f.sku);
      if (f.status !== "ready" || nombre === undefined) return f;
      const avisos = [
        ...f.warnings,
        `El código ${f.sku} ya existe («${nombre}»): esta fila solo actualiza su precio; no cambia ` +
          "ni la existencia ni el nombre.",
      ];
      if (!precios.ok) {
        avisos.push(`Si el precio cambia, la fila se rechazará: ${SIN_PERMISO_DE_PRECIO}`);
      }
      return { ...f, warnings: avisos, updates_existing: true };
    }),
  );
}

/** La fila lista, tal como la guarda `importarFila`. */
export function datosDeFila(f: ProductImportRow): FilaLista {
  return {
    name: f.name!,
    price: f.price!,
    is_service: f.is_service === true,
    initial_stock: f.initial_stock ?? null,
    reference_cost: f.reference_cost ?? null,
    ...(f.sku === undefined ? {} : { sku: f.sku }),
    ...(f.barcode === undefined ? {} : { barcode: f.barcode }),
    ...(f.category_name === undefined ? {} : { category_name: f.category_name }),
  };
}

// ── 2. Guardar una fila: el código es la llave (C-04) ───────────────────────

export interface FilaGuardada {
  status: "created" | "updated";
  product_id: string;
  sku: string;
  warnings: string[];
}

/**
 * El costo de referencia (H11, decidido por criterio — §2.12), GUARDADO en el producto. Lo
 * autoriza el alta (`product.manage`): es un dato del maestro, no un precio.
 */
export async function guardarCostoReferencia(
  uow: UnitOfWork,
  companyId: string,
  productId: string,
  costo: MoneyInput,
): Promise<void> {
  await uow.sql`
    update public.products
       set reference_cost = ${costo.amount}::numeric, reference_cost_currency = ${costo.currency}
     where id = ${productId} and company_id = ${companyId}`;
}

/**
 * Guarda UNA fila lista. Con código y un producto de la empresa que ya lo tiene, ACTUALIZA: el
 * precio si cambió (una vigencia nueva, y solo con `price_list.manage`: el alta autoriza su
 * precio, modificarlo no — §2.8, H2) y el costo de referencia si vino. La existencia NO se
 * vuelve a cargar (sería un segundo kardex del mismo inventario) y el nombre no se pisa; los dos
 * salen como aviso. Sin código, o con uno nuevo, crea por el alta simple de siempre.
 */
export async function importarFila(
  uow: UnitOfWork,
  companyId: string,
  fila: FilaLista,
): Promise<Result<FilaGuardada, ProductImportError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const avisos: string[] = [];
  if (fila.sku !== undefined) {
    const [existente] = await sql<{ id: string; name: string; sku: string }[]>`
      select id, name, sku from public.products
       where company_id = ${companyId} and sku = ${fila.sku}`;
    if (existente) {
      const scope = await companyScope(sql, actor.userId, companyId, "product.manage");
      if (!scope.ok) return scope;
      if (scope.value.companyStatus === "suspended") {
        return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
      }
      if (existente.name !== fila.name) {
        avisos.push(
          `El código ${fila.sku} ya era «${existente.name}»: el nombre no se cambia desde la importación.`,
        );
      }
      if (fila.initial_stock !== null) {
        avisos.push(
          "El producto ya existía: la existencia no se vuelve a cargar (para sumar mercancía, usa «Llegó mercancía»).",
        );
      }
      // A1: «el precio ya era ese» se mira SOLO en la lista donde se escribiría el detal, con el
      // mismo helper que la escribe. Otra lista de la moneda (la de mayor) no cuenta.
      const [empresa] = await sql<{ moneda: string }[]>`
        select functional_currency_code as moneda from public.companies where id = ${companyId}`;
      const destino = await listaDeDestino(
        sql,
        companyId,
        empresa!.moneda,
        "detal",
        fila.price.currency,
      );
      const [vigente] =
        destino.id === null
          ? [{ n: 0 }]
          : await sql<{ n: number }[]>`
              select count(*)::int as n
                from public.price_list_items i
               where i.price_list_id = ${destino.id} and i.product_id = ${existente.id}
                 and i.amount = ${fila.price.amount}::numeric
                 and i.effective_from <= now()
                 and (i.effective_to is null or i.effective_to > now())`;
      if ((vigente?.n ?? 0) === 0) {
        const permiso = await companyScope(sql, actor.userId, companyId, "price_list.manage");
        if (!permiso.ok) {
          return err({ code: "PERMISSION_REQUIRED", message: SIN_PERMISO_DE_PRECIO });
        }
        const puesto = await ponerPrecioEnLista(
          uow,
          companyId,
          empresa!.moneda,
          "detal",
          existente.id,
          fila.price,
        );
        if (!puesto.ok) return puesto;
      } else {
        avisos.push("El precio ya era ese: no se creó una vigencia nueva.");
      }
      if (fila.reference_cost !== null) {
        await guardarCostoReferencia(uow, companyId, existente.id, fila.reference_cost);
      }
      return ok({
        status: "updated",
        product_id: existente.id,
        sku: existente.sku,
        warnings: avisos,
      });
    }
  }
  const creado = await createProductSimple(uow, {
    company_id: companyId,
    name: fila.name,
    price: fila.price,
    ...(fila.is_service ? { is_service: true } : {}),
    ...(fila.initial_stock === null ? {} : { initial_stock: fila.initial_stock }),
    ...(fila.sku === undefined ? {} : { sku: fila.sku }),
    ...(fila.barcode === undefined ? {} : { barcode: fila.barcode }),
    ...(fila.category_name === undefined ? {} : { category_name: fila.category_name }),
  });
  if (!creado.ok) return creado;
  if (fila.reference_cost !== null) {
    await guardarCostoReferencia(uow, companyId, creado.value.product.id, fila.reference_cost);
  }
  return ok({
    status: "created",
    product_id: creado.value.product.id,
    sku: creado.value.product.sku,
    warnings: avisos,
  });
}

// ── 3. El trabajo (C-04) ────────────────────────────────────────────────────

/** La fila de `product_import_jobs`. `row_count` es el número de filas del archivo. */
interface FilaTrabajo {
  id: string;
  tenant_id: string;
  company_id: string;
  created_by: string;
  file_name: string;
  file_hash: string;
  number_format: ImportNumberFormat;
  status: ProductImportJobResponse["status"];
  row_count: number;
  processed_rows: number;
  created_count: number;
  updated_count: number;
  rejected_count: number;
  report: ProductImportJobRowResult[];
  last_error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

const COLUMNAS_TRABAJO = `id, tenant_id, company_id, created_by, file_name, file_hash,
  number_format, status, row_count, processed_rows, created_count, updated_count,
  rejected_count, report, last_error, created_at, finished_at`;

function aRespuesta(t: FilaTrabajo, reused: boolean): ProductImportJobResponse {
  return {
    id: t.id,
    company_id: t.company_id,
    file_name: t.file_name,
    file_hash: t.file_hash,
    number_format: t.number_format,
    status: t.status,
    total_rows: t.row_count,
    processed_rows: t.processed_rows,
    created_count: t.created_count,
    updated_count: t.updated_count,
    rejected_count: t.rejected_count,
    report: t.report,
    last_error: t.last_error,
    created_at: new Date(t.created_at).toISOString(),
    finished_at: t.finished_at === null ? null : new Date(t.finished_at).toISOString(),
    reused,
  };
}

export interface CrearTrabajoInput {
  company_id: string;
  file_name: string;
  file_hash: string;
  number_format: ImportNumberFormat;
  filas: ProductImportRow[];
}

/**
 * Crea el trabajo, o devuelve el que ya existe para el mismo archivo y formato (C-04). La llave
 * es el ÚNICO PARCIAL del esquema (company_id, file_hash, number_format) `where status <>
 * 'failed'`, no una lectura previa: dos subidas simultáneas del mismo archivo producen un solo
 * trabajo, y un trabajo fallado no impide volver a subir el archivo (H1-d).
 */
export async function crearTrabajoImportacion(
  uow: UnitOfWork,
  input: CrearTrabajoInput,
): Promise<Result<ProductImportJobResponse, ProductImportError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "product.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const [nuevo] = await sql<FilaTrabajo[]>`
    insert into public.product_import_jobs
      (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
    values (${scope.value.tenantId}, ${input.company_id}, ${input.file_name.slice(0, 255)},
            ${input.file_hash}, ${input.number_format}, ${input.filas.length},
            ${sql.json(input.filas)})
    on conflict (company_id, file_hash, number_format) where status <> 'failed' do nothing
    returning ${sql.unsafe(COLUMNAS_TRABAJO)}`;
  if (nuevo) {
    // A7: crear el trabajo es un hecho auditable — quién subió qué archivo, con qué formato y
    // cuántas filas. La reutilización (mismo archivo) no audita: no crea nada.
    await sql`
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      values (${nuevo.tenant_id}, ${nuevo.company_id}, 'product_import_job', ${nuevo.id},
              'product.import_job.created', 'user', now(), ${RULES_VERSION},
              ${sql.json({
                file_name: nuevo.file_name,
                file_hash: nuevo.file_hash,
                number_format: nuevo.number_format,
                row_count: nuevo.row_count,
              })})`;
    return ok(aRespuesta(nuevo, false));
  }
  const [existente] = await sql<FilaTrabajo[]>`
    select ${sql.unsafe(COLUMNAS_TRABAJO)} from public.product_import_jobs
     where company_id = ${input.company_id} and file_hash = ${input.file_hash}
       and number_format = ${input.number_format} and status <> 'failed'`;
  if (!existente) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  return ok(aRespuesta(existente, true));
}

/** El estado del trabajo, con su progreso y su informe. */
export async function leerTrabajoImportacion(
  uow: UnitOfWork,
  companyId: string,
  jobId: string,
): Promise<Result<ProductImportJobResponse, ProductImportError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, companyId, "product.manage");
  if (!scope.ok) return scope;
  const [t] = await sql<FilaTrabajo[]>`
    select ${sql.unsafe(COLUMNAS_TRABAJO)} from public.product_import_jobs
     where id = ${jobId} and company_id = ${companyId}`;
  if (!t) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  return ok(aRespuesta(t, false));
}

class RevertirFila extends Error {
  constructor(readonly motivo: string) {
    super(motivo);
  }
}

/**
 * ¿Es un error de los DATOS de esta fila? (H1-b, acotado en la re-revisión A2). Solo si la
 * restricción violada es del producto, de su categoría o de su precio (`products_*`,
 * `product_categories_*`, `price_list_items_*`), o si el valor mismo no cabe o no se entiende
 * (22001 cadena demasiado larga, 22003 número fuera de rango, 22P02 texto que no se convierte).
 * Esa fila se rechaza con un motivo legible; el savepoint ya deshizo lo que hubiera escrito.
 *
 * Todo lo demás se RELANZA y el worker suma `attempts`: un 23503 de otra tabla (un almacén que
 * no es de la empresa en el kardex) no es un defecto del dato del producto, y el 23505 de una
 * carrera entre dos trabajos con el mismo código se resuelve reintentando — la segunda vez el
 * código ya existe y la fila actualiza.
 */
const DATOS_DE_FILA = /^(products|product_categories|price_list_items)_/;
function motivoDeDatos(e: unknown): string | null {
  const pg = e as { code?: unknown; constraint_name?: unknown; message?: unknown };
  if (typeof pg.code !== "string") return null;
  if (pg.code === "23505") return null;
  const restriccion = typeof pg.constraint_name === "string" ? pg.constraint_name : "";
  const deLaFila =
    ["22001", "22003", "22P02"].includes(pg.code) ||
    (/^2[23]/.test(pg.code) && DATOS_DE_FILA.test(restriccion));
  if (!deLaFila) return null;
  const detalle =
    restriccion !== ""
      ? `la regla «${restriccion}»`
      : typeof pg.message === "string"
        ? pg.message
        : pg.code;
  return `La fila no se pudo guardar: un dato no cumple ${detalle}. Corrígelo en el archivo y súbelo de nuevo.`;
}

/**
 * UNA fila del trabajo, en la transacción del llamante: bloquea el trabajo, lee SOLO la fila que
 * toca (`rows -> processed_rows`, H10), la guarda en un savepoint (la fila mala se revierte sola
 * y queda como rechazada) y avanza el contador en la MISMA transacción, reiniciando `attempts`
 * (H1-c). Si el proceso muere antes del commit, ni la fila ni el avance existen; el reintento la
 * hace de nuevo, una sola vez.
 */
export async function procesarFilaDeTrabajo(
  uow: UnitOfWork,
  jobId: string,
): Promise<Result<{ procesada: boolean; terminado: boolean }, ProductImportError>> {
  const { sql } = uow;
  const [t] = await sql<
    {
      company_id: string;
      status: FilaTrabajo["status"];
      row_count: number;
      processed_rows: number;
      fila: ProductImportRow | null;
    }[]
  >`
    select company_id, status, row_count, processed_rows, rows -> processed_rows as fila
      from public.product_import_jobs
     where id = ${jobId} for update`;
  if (!t) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (t.status === "done" || t.status === "failed") {
    return ok({ procesada: false, terminado: true });
  }
  if (t.processed_rows >= t.row_count || t.fila === null) {
    await sql`
      update public.product_import_jobs
         set status = 'done', finished_at = coalesce(finished_at, now())
       where id = ${jobId}`;
    return ok({ procesada: false, terminado: true });
  }

  const fila = t.fila;
  let resultado: ProductImportJobRowResult;
  if (fila.status === "rejected") {
    resultado = {
      row: fila.row,
      status: "rejected",
      message: fila.message ?? "Fila rechazada.",
      warnings: fila.warnings,
      ...(fila.name === undefined ? {} : { name: fila.name }),
    };
  } else {
    const datos = datosDeFila(fila);
    try {
      const guardada = await sql.savepoint(async (sp) => {
        const r = await importarFila({ sql: sp, actor: uow.actor }, t.company_id, datos);
        if (!r.ok) throw new RevertirFila(r.error.message);
        return r.value;
      });
      resultado = {
        row: fila.row,
        status: guardada.status,
        warnings: [...fila.warnings, ...guardada.warnings],
        name: datos.name,
        sku: guardada.sku,
        product_id: guardada.product_id,
        reference_cost: datos.reference_cost,
      };
    } catch (e) {
      const motivo = e instanceof RevertirFila ? e.motivo : motivoDeDatos(e);
      if (motivo === null) throw e;
      resultado = {
        row: fila.row,
        status: "rejected",
        message: motivo,
        warnings: fila.warnings,
        name: datos.name.slice(0, LARGO_MAXIMO.nombre),
      };
    }
  }

  const ultima = t.processed_rows + 1 >= t.row_count;
  await sql`
    update public.product_import_jobs
       set processed_rows = processed_rows + 1,
           created_count  = created_count  + ${resultado.status === "created" ? 1 : 0},
           updated_count  = updated_count  + ${resultado.status === "updated" ? 1 : 0},
           rejected_count = rejected_count + ${resultado.status === "rejected" ? 1 : 0},
           report = report || ${sql.json([resultado] as never)}::jsonb,
           attempts = 0,
           status = ${ultima ? "done" : "running"},
           started_at = coalesce(started_at, now()),
           finished_at = ${ultima ? sql`now()` : null}
     where id = ${jobId}`;
  return ok({ procesada: true, terminado: ultima });
}

/**
 * Procesa el trabajo fila a fila, cada una en SU transacción y como el usuario que lo subió: la
 * autorización es la suya (si perdió el permiso, sus filas se rechazan con el motivo). La
 * conexión adopta `ladino_api` dentro de cada transacción: el worker no tiene privilegios de
 * negocio propios (ADR-0031, enmendado por ADR-0074 §«Quién procesa el trabajo»), y con la API
 * no cambia nada (adoptarse a sí misma no hace nada).
 *
 * `hastaMs` es un instante (ms de época) a partir del cual no se empieza otra fila: el
 * presupuesto de tiempo por vuelta del worker (H10). `maxFilas` acota por número.
 */
export async function procesarTrabajoImportacion(
  sql: Sql,
  jobId: string,
  actorId: string,
  opciones: { maxFilas?: number; hastaMs?: number } = {},
): Promise<{ procesadas: number; terminado: boolean }> {
  const max = opciones.maxFilas ?? Number.POSITIVE_INFINITY;
  const hasta = opciones.hastaMs ?? Number.POSITIVE_INFINITY;
  let procesadas = 0;
  while (procesadas < max && Date.now() < hasta) {
    const r = await withTransaction(sql, { kind: "user", userId: actorId }, async (uow) => {
      await uow.sql`set local role ladino_api`;
      return procesarFilaDeTrabajo(uow, jobId);
    });
    if (!r.ok) throw new Error(`trabajo de importación ${jobId}: ${r.error.message}`);
    if (r.value.procesada) procesadas += 1;
    if (r.value.terminado) return { procesadas, terminado: true };
  }
  return { procesadas, terminado: false };
}

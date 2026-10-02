import { createHash } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import {
  CreateProductRequest,
  CreateProductSimpleRequest,
  UpdateProductRequest,
  SetProductTaxCategoryRequest,
  ImportNumberFormat,
  type ProductImportRow,
} from "@ladino/schemas";
import {
  createProduct,
  createProductSimple,
  updateProduct,
  setProductTaxCategory,
  setProductImage,
  interpretarFilasProductos,
  anotarCodigosExistentes,
  guardarCostoReferencia,
  crearTrabajoImportacion,
  leerTrabajoImportacion,
} from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { CTX } from "../middleware/context.js";
import { leerMatriz } from "../csv.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { subirObjeto, firmarUrls } from "../storage.js";
import type { StorageConfig } from "../config.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rutas de productos — la forma de companies.ts (handler delgado, errores
 * LANZADOS al onError, rutas sobre la app principal), con la novedad de este
 * módulo: TODO exige `X-Company-Id` ya validado por el middleware de scope.
 * El `company_id` del cuerpo tiene que COINCIDIR con el del header: dos
 * fuentes para el mismo hecho solo se aceptan si dicen lo mismo.
 */
export function requireCompany(c: Context): { companyId: string; tenantId: string } {
  const ctx = c.get(CTX);
  if (ctx.companyId === null || ctx.tenantId === null) {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message: "Esta operación exige el header X-Company-Id.",
    });
  }
  return { companyId: ctx.companyId, tenantId: ctx.tenantId };
}

function exigirCoherencia(companyIdHeader: string, companyIdBody: string): void {
  if (companyIdHeader !== companyIdBody) {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message: "El company_id del cuerpo no coincide con X-Company-Id.",
    });
  }
}

/** Escapa los comodines de LIKE: un término de búsqueda es dato, no patrón. */
function comoPatron(termino: string): string {
  return `%${termino.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

const PRODUCT_SELECT = `id, tenant_id, company_id, sku, name, kind, status,
  unit_code, tax_category_code, category_id, barcode, image_path,
  is_composed, tracks_lots, tracks_serials, is_manufactured, tracks_expiry,
  template_id, attributes,
  reference_cost::text as reference_cost_amount, reference_cost_currency,
  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;

/** El mismo select, con el alias `p.` del listado (los joins de la cuadrícula). */
const PRODUCT_SELECT_P = `p.id, p.tenant_id, p.company_id, p.sku, p.name, p.kind, p.status,
  p.unit_code, p.tax_category_code, p.category_id, p.barcode, p.image_path,
  p.is_composed, p.tracks_lots, p.tracks_serials, p.is_manufactured, p.tracks_expiry,
  p.template_id, p.attributes,
  p.reference_cost::text as reference_cost_amount, p.reference_cost_currency,
  to_char(p.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;

const BUCKET_IMAGENES = "product-images";

/**
 * Deriva la ruta de la miniatura de cuadrícula a partir de la del original.
 * El contrato de rutas es `<company>/products/<id>/<v>/original.webp` con sus
 * `thumb-400.webp` y `thumb-96.webp` al lado, generados AL SUBIR.
 */
function rutaThumb(imagePath: string, tam: 400 | 96): string {
  return imagePath.replace(/original\.webp$/, `thumb-${tam}.webp`);
}

export function productsRoutes(
  app: Hono,
  sql: Sql,
  idempotencia: MiddlewareHandler,
  storage?: StorageConfig,
): void {
  // Listado con búsqueda y PAGINACIÓN EN SERVIDOR (WEBAPP_SPEC §Rendimiento):
  // filtros en el query string para que una vista sea compartible.
  app.get("/v1/products", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const search = c.req.query("search")?.trim() ?? "";
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 20) || 20, 1), 100);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
    // Los extras de la CUADRÍCULA de Vender (Fase C): precio de lista, stock
    // total y solo-activos. Opt-in por query para que el listado admin no
    // pague joins que no muestra.
    const soloActivos = c.req.query("only_active") === "1";
    const conPrecio = c.req.query("with_price") === "1";
    const conStock = c.req.query("with_stock") === "1";
    const listaPedida = c.req.query("price_list_id") ?? null;

    const filas = await withTransaction(sql, actor, async ({ sql: tx }) => {
      // La búsqueda incluye el código de barras: la cuadrícula tiene lector.
      const filtro =
        search === ""
          ? tx``
          : tx`and (p.sku ilike ${comoPatron(search)} escape '\\'
                 or p.name ilike ${comoPatron(search)} escape '\\'
                 or p.barcode ilike ${comoPatron(search)} escape '\\')`;
      const activos = soloActivos ? tx`and p.status = 'active'` : tx``;
      // Lo EXACTO primero (2026-09-14): el lector busca un código entero, y
      // con códigos cortos («12») la coincidencia parcial ordenada por nombre
      // podía dejar el producto exacto fuera de la primera página.
      const orden =
        search === ""
          ? tx`p.name`
          : // coalesce: sin código de barras la comparación es NULL, y un NULL
            // en `desc` va PRIMERO en Postgres.
            tx`coalesce(lower(p.barcode) = lower(${search}) or lower(p.sku) = lower(${search}), false) desc, p.name`;

      // La lista de precios: la pedida, o «detal» de la empresa (la del alta
      // simple). Resolverla aquí y no en el cliente es lo que permite que la
      // cuadrícula funcione sin saber de listas.
      let listaId: string | null = null;
      if (conPrecio) {
        if (listaPedida !== null && UUID_RE.test(listaPedida)) {
          listaId = listaPedida;
        } else {
          // La MISMA resolución de la caja que resolverLista (migración 36):
          // el dato del dueño primero, la heurística por nombre después. Si
          // divergieran, la cuadrícula enseñaría un precio y el carrito
          // cobraría otro.
          const [l] = await tx<{ id: string }[]>`
            select l.id from public.price_lists l
             where l.company_id = ${companyId} and l.status = 'active'
             order by (l.id = (select cs.default_price_list_id from public.company_settings cs
                                where cs.company_id = ${companyId})) desc,
                      (l.name = 'detal') desc, (l.name like 'detal%') desc, l.created_at
             limit 1`;
          listaId = l?.id ?? null;
        }
      }

      // ADR-0046: la cuadrícula enseña las DOS monedas — el precio de lista
      // (ancla, USD) y su equivalente funcional con la tasa vigente HOY,
      // calculado por el SERVIDOR. Sin tasa → null, jamás un cero. Es una
      // vista previa: la que manda al cobrar es la que congela el documento.
      const precioJoin = conPrecio
        ? tx`left join lateral (
              select i.amount::text as price_amount, l.currency_code as price_currency,
                     l.id as price_list_id,
                     -- Lista en divisa → equivalente en Bs; lista en Bs →
                     -- equivalente en el ANCLA (USD): la cuadrícula es dual
                     -- siempre (orden del dueño, 2026-09-13).
                     case when l.currency_code = c.functional_currency_code
                          then round(i.amount / nullif(platform.rate_at(c.id, 'USD',
                                       c.functional_currency_code,
                                       (now() at time zone 'America/Caracas')::date), 0), 2)
                               ::numeric(24,8)::text
                          else round(i.amount * platform.rate_at(c.id, l.currency_code,
                                       c.functional_currency_code,
                                       (now() at time zone 'America/Caracas')::date), 2)::numeric(24,8)::text
                     end as price_equivalent_amount,
                     case when l.currency_code = c.functional_currency_code
                          then case when c.functional_currency_code = 'USD' then null else 'USD' end
                          else c.functional_currency_code
                     end as price_equivalent_currency
                from public.price_list_items i
                join public.price_lists l on l.id = i.price_list_id
                join public.companies c on c.id = l.company_id
               where i.price_list_id = ${listaId} and i.product_id = p.id
                 and i.effective_from <= now()
                 and (i.effective_to is null or i.effective_to > now())
               order by i.effective_from desc limit 1
            ) precio on true`
        : tx``;
      const stockJoin = conStock
        ? tx`left join lateral (
              select coalesce(sum(b.quantity), 0)::text as stock_quantity
                from public.stock_balances b
               where b.company_id = p.company_id and b.product_id = p.id
            ) existencia on true`
        : tx``;
      const extras = `${conPrecio ? ", precio.price_amount, precio.price_currency, precio.price_list_id, precio.price_equivalent_amount, precio.price_equivalent_currency" : ""}${conStock ? ", existencia.stock_quantity" : ""}`;

      return tx<Record<string, unknown>[]>`
        select ${tx.unsafe(PRODUCT_SELECT_P)} ${tx.unsafe(extras)}, count(*) over ()::int as total
          from public.products p
          ${precioJoin}
          ${stockJoin}
         where p.company_id = ${companyId} ${filtro} ${activos}
         order by ${orden}
         limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
    });

    const total = filas.length > 0 ? (filas[0]!["total"] as number) : 0;
    const items = filas.map(({ total: _total, ...resto }) => resto);

    // Las URLs FIRMADAS de las miniaturas, en LOTE y fuera de la transacción.
    // Sin storage configurado (o si una ruta no firma), image_url va null y la
    // cuadrícula enseña el placeholder de inicial — que es diseño, no error.
    if (storage !== undefined) {
      const conFoto = items.filter((i) => typeof i["image_path"] === "string");
      const rutas = conFoto.map((i) => rutaThumb(i["image_path"] as string, 400));
      const firmadas = await firmarUrls(storage, BUCKET_IMAGENES, rutas);
      for (const i of items) {
        const p = i["image_path"];
        i["image_url"] = typeof p === "string" ? (firmadas.get(rutaThumb(p, 400)) ?? null) : null;
      }
    }
    return c.json({ items, total }, 200);
  });

  app.get("/v1/products/:id", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    const [fila] = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select ${tx.unsafe(PRODUCT_SELECT)} from public.products
         where id = ${id} and company_id = ${companyId}`,
    );
    if (!fila) throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    if (storage !== undefined && typeof fila["image_path"] === "string") {
      const firmadas = await firmarUrls(storage, BUCKET_IMAGENES, [fila["image_path"]]);
      fila["image_url"] = firmadas.get(fila["image_path"]) ?? null;
    }
    return c.json(fila, 200);
  });

  /**
   * La FOTO del producto: multipart, convertida a webp y con sus miniaturas
   * generadas AL SUBIR (400 y 96 px — la cuadrícula no carga originales). La
   * escritura al bucket va con la credencial de servicio; el hecho de dominio
   * (la ruta, la auditoría, el evento) lo escribe `setProductImage`.
   *
   * Sin `Idempotency-Key` a propósito: resubir la misma foto es idempotente
   * por naturaleza (upsert de objeto + UPDATE de la misma columna).
   */
  app.post("/v1/products/:id/image", async (c) => {
    const { companyId } = requireCompany(c);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    if (storage === undefined) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Este servidor no tiene almacenamiento de imágenes configurado.",
      });
    }
    const cuerpo = await c.req.parseBody();
    const archivo = cuerpo["file"];
    if (!(archivo instanceof File)) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Manda la foto en el campo `file` (multipart/form-data).",
      });
    }
    if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(archivo.type)) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "La foto tiene que ser JPG, PNG o WebP.",
      });
    }

    const original = Buffer.from(await archivo.arrayBuffer());
    const { default: sharp } = await import("sharp");
    let grande: Buffer, t400: Buffer, t96: Buffer;
    try {
      const base = sharp(original).rotate(); // respeta la orientación EXIF
      grande = await base
        .clone()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      t400 = await base
        .clone()
        .resize({ width: 400, height: 400, fit: "cover" })
        .webp({ quality: 78 })
        .toBuffer();
      t96 = await base
        .clone()
        .resize({ width: 96, height: 96, fit: "cover" })
        .webp({ quality: 74 })
        .toBuffer();
    } catch {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Esa imagen no se pudo leer. Prueba con otra foto.",
      });
    }

    const version = Date.now().toString(36);
    const rutaBase = `${companyId}/products/${id}/${version}`;
    const rutaOriginal = `${rutaBase}/original.webp`;
    await subirObjeto(storage, BUCKET_IMAGENES, rutaOriginal, grande, "image/webp");
    await subirObjeto(storage, BUCKET_IMAGENES, `${rutaBase}/thumb-400.webp`, t400, "image/webp");
    await subirObjeto(storage, BUCKET_IMAGENES, `${rutaBase}/thumb-96.webp`, t96, "image/webp");

    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      setProductImage(uow, id, { company_id: companyId, image_path: rutaOriginal }),
    );
    if (!r.ok) throw new DominioError(r.error);

    const firmadas = await firmarUrls(storage, BUCKET_IMAGENES, [rutaOriginal]);
    return c.json({ image_path: rutaOriginal, image_url: firmadas.get(rutaOriginal) ?? null }, 201);
  });

  app.post("/v1/products", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateProductRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    exigirCoherencia(companyId, parsed.data.company_id);

    const { actor } = c.get("ladino.auth");
    const resultado = await withTransaction(sql, actor, (uow) => createProduct(uow, parsed.data));
    if (!resultado.ok) throw new DominioError(resultado.error);
    return c.json(resultado.value, 201);
  });

  /**
   * El archivo y el formato de números de una subida multipart (ADR-0074). El formato lo declara
   * la persona; por omisión, el venezolano (coma decimal, punto de miles). Devuelve la matriz de
   * celdas-texto y el sha256 del archivo, que es la llave del trabajo.
   */
  async function leerSubida(c: Context): Promise<{
    matriz: string[][];
    formato: ImportNumberFormat;
    hash: string;
    nombre: string;
  }> {
    const cuerpo = await c.req.parseBody();
    const archivo = cuerpo["file"];
    if (!(archivo instanceof File)) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Manda el archivo (.csv o .xlsx) en el campo `file` (multipart/form-data).",
      });
    }
    const crudo = cuerpo["number_format"];
    const formato = ImportNumberFormat.safeParse(
      typeof crudo === "string" && crudo !== "" ? crudo : "comma_decimal",
    );
    if (!formato.success) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "`number_format` es «comma_decimal» (1.234,50) o «dot_decimal» (1,234.50).",
      });
    }
    const bytes = new Uint8Array(await archivo.arrayBuffer());
    const hash = createHash("sha256").update(bytes).digest("hex");
    // CSV o Excel, el MISMO camino: todo se aplana a una matriz de celdas-texto. Las celdas
    // NUMÉRICAS de un .xlsx se escriben en el formato declarado (C-01: el 0,125 de Excel no es 125).
    const matriz = await leerMatriz(archivo, formato.data);
    return {
      matriz,
      formato: formato.data,
      hash,
      nombre: archivo.name || "archivo",
    };
  }

  function interpretar(
    matriz: string[][],
    formato: ImportNumberFormat,
  ): { filas: ProductImportRow[]; sospechoso: ImportNumberFormat | null } {
    const r = interpretarFilasProductos(matriz, formato);
    if (!r.ok) throw new DominioError(r.error);
    return { filas: r.value.filas, sospechoso: r.value.formatoSospechoso };
  }

  /**
   * El hash CANÓNICO de una subida para la idempotencia (H4): sha256 de los bytes del ARCHIVO más
   * el formato declarado — no del multipart crudo, cuyo boundary cambia en cada reenvío.
   */
  const idempotenciaSubida = idempotencyMiddleware({
    sql,
    canonicalHash: async (c) => {
      const cuerpo = await c.req.parseBody();
      const archivo = cuerpo["file"];
      const formato = typeof cuerpo["number_format"] === "string" ? cuerpo["number_format"] : "";
      const h = createHash("sha256");
      if (archivo instanceof File) {
        h.update(
          createHash("sha256")
            .update(new Uint8Array(await archivo.arrayBuffer()))
            .digest("hex"),
        );
      }
      return h
        .update("\n")
        .update(formato || "comma_decimal")
        .digest();
    },
  });

  /**
   * IMPORT de Excel (Fase C), el camino SÍNCRONO de siempre. Desde ADR-0074 interpreta con el
   * formato declarado (C-01) y devuelve los avisos por fila (C-05), pero corre dentro de la
   * petición: por eso admite hasta MAX_FILAS_SINCRONAS filas, lejos de los 30 s de la API (C-04).
   * Lo grande va por el trabajo (/v1/products/import/jobs), que es lo que usa la web.
   */
  const MAX_FILAS_SINCRONAS = 50;
  app.post("/v1/products/import", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const { matriz, formato } = await leerSubida(c);
    if (matriz.length > MAX_FILAS_SINCRONAS + 1) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: `Por esta vía, máximo ${MAX_FILAS_SINCRONAS} productos por archivo. Para más, usa la importación en segundo plano.`,
      });
    }
    const { filas } = interpretar(matriz, formato);

    interface FilaResultado {
      row: number;
      status: "creado" | "error";
      message?: string;
      product_id?: string;
      sku?: string;
      name?: string;
      warnings?: string[];
    }
    const resultados: FilaResultado[] = [];
    for (const f of filas) {
      const avisos = f.warnings.length === 0 ? {} : { warnings: f.warnings };
      if (f.status === "rejected") {
        resultados.push({
          row: f.row,
          status: "error",
          message: f.message ?? "Fila rechazada.",
          ...(f.name === undefined ? {} : { name: f.name }),
          ...avisos,
        });
        continue;
      }
      // Cada fila en SU transacción: la fila mala no arrastra a las buenas.
      const r = await withTransaction(sql, actor, async (uow) => {
        const creado = await createProductSimple(uow, {
          company_id: companyId,
          name: f.name!,
          price: f.price!,
          ...(f.is_service === true ? { is_service: true } : {}),
          ...(f.initial_stock ? { initial_stock: f.initial_stock } : {}),
          ...(f.sku === undefined ? {} : { sku: f.sku }),
          ...(f.barcode === undefined ? {} : { barcode: f.barcode }),
          ...(f.category_name === undefined ? {} : { category_name: f.category_name }),
        });
        // El costo de referencia se GUARDA en el producto (H11), también por esta vía.
        if (creado.ok && f.reference_cost) {
          await guardarCostoReferencia(uow, companyId, creado.value.product.id, f.reference_cost);
        }
        return creado;
      });
      if (r.ok) {
        resultados.push({
          row: f.row,
          status: "creado",
          product_id: r.value.product.id,
          sku: r.value.product.sku,
          name: f.name!,
          ...avisos,
        });
      } else {
        resultados.push({
          row: f.row,
          status: "error",
          name: f.name!,
          message: r.error.message,
          ...avisos,
        });
      }
    }

    const created = resultados.filter((r) => r.status === "creado").length;
    return c.json(
      {
        total: resultados.length,
        created,
        failed: resultados.length - created,
        rows: resultados,
      },
      201,
    );
  });

  /**
   * VISTA PREVIA (ADR-0074, C-05): las diez primeras filas COMO SE VAN A GUARDAR, con sus avisos,
   * y todas las rechazadas con su número y su motivo. No escribe nada.
   */
  app.post("/v1/products/import/preview", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const { matriz, formato, hash, nombre } = await leerSubida(c);
    const interpretadas = interpretar(matriz, formato);
    // La verdad sobre los códigos que ya existen: solo cambia el precio (H1).
    const anotadas = await withTransaction(sql, actor, (uow) =>
      anotarCodigosExistentes(uow, companyId, interpretadas.filas),
    );
    if (!anotadas.ok) throw new DominioError(anotadas.error);
    const filas = anotadas.value;
    const rechazadas = filas.filter((f) => f.status === "rejected");
    return c.json(
      {
        number_format: formato,
        file_name: nombre,
        file_hash: hash,
        total: filas.length,
        ready: filas.length - rechazadas.length,
        rejected: rechazadas.length,
        rows: filas.slice(0, 10),
        rejected_rows: rechazadas,
        warned_rows: filas.filter((f) => f.warnings.length > 0),
        suspected_format: interpretadas.sospechoso,
      },
      200,
    );
  });

  /**
   * CONFIRMAR (ADR-0074, C-04): la petición SOLO crea el trabajo y lo devuelve (202); el worker
   * lo procesa. El mismo archivo con el mismo formato devuelve el trabajo existente (200,
   * `reused: true`): la llave es el hash, garantizada por el único del esquema. EXIGE y HONRA
   * `Idempotency-Key` (regla 4, H4), con el hash canónico del archivo: la misma llave con el mismo
   * archivo reenviado devuelve la misma respuesta; con otro archivo, 409 IDEMPOTENCY_KEY_REUSED.
   */
  app.post("/v1/products/import/jobs", idempotenciaSubida, async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const { matriz, formato, hash, nombre } = await leerSubida(c);
    const { filas } = interpretar(matriz, formato);
    if (filas.length === 0) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El archivo no tiene filas de productos: la primera fila son los títulos.",
      });
    }
    const r = await withTransaction(sql, actor, (uow) =>
      crearTrabajoImportacion(uow, {
        company_id: companyId,
        file_name: nombre,
        file_hash: hash,
        number_format: formato,
        filas,
      }),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, r.value.reused ? 200 : 202);
  });

  /** El progreso y el informe del trabajo. La web lo consulta mientras el worker avanza. */
  app.get("/v1/products/import/jobs/:id", async (c) => {
    const { companyId } = requireCompany(c);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      throw new DominioError({
        code: "NOT_FOUND",
        message: "Recurso no encontrado.",
      });
    }
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      leerTrabajoImportacion(uow, companyId, id),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });
  /** El ALTA SIMPLE de la Fase C: nombre + precio (+ stock inicial) en un paso. */
  app.post("/v1/products/simple", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateProductSimpleRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    exigirCoherencia(companyId, parsed.data.company_id);

    const { actor } = c.get("ladino.auth");
    const resultado = await withTransaction(sql, actor, (uow) =>
      createProductSimple(uow, parsed.data),
    );
    if (!resultado.ok) throw new DominioError(resultado.error);
    return c.json(resultado.value, 201);
  });

  app.patch("/v1/products/:id", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    const parsed = UpdateProductRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    exigirCoherencia(companyId, parsed.data.company_id);

    const { actor } = c.get("ladino.auth");
    const resultado = await withTransaction(sql, actor, (uow) =>
      updateProduct(uow, id, parsed.data),
    );
    if (!resultado.ok) throw new DominioError(resultado.error);
    return c.json(resultado.value, 200);
  });

  // El mapeo tributario tiene endpoint y PERMISO propios (D-10, segregación):
  // que exista PATCH no significa que cualquiera reclasifique impuestos.
  app.put("/v1/products/:id/tax-category", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    const parsed = SetProductTaxCategoryRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    exigirCoherencia(companyId, parsed.data.company_id);

    const { actor } = c.get("ladino.auth");
    const resultado = await withTransaction(sql, actor, (uow) =>
      setProductTaxCategory(uow, id, parsed.data),
    );
    if (!resultado.ok) throw new DominioError(resultado.error);
    return c.json(resultado.value, 200);
  });
}

import type { Context, Hono } from "hono";
import { withTransaction, type Sql, type TransactionSql } from "@ladino/db";
import {
  cashClosingsReport,
  igtfReport,
  inventoryReport,
  ivaReport,
  marginReport,
  payablesReport,
  receivablesReport,
  salesReport,
} from "@ladino/domain";
import {
  CashClosingsReportQuery,
  MarginReportQuery,
  PayablesReportQuery,
  RangeReportQuery,
  ReceivablesReportQuery,
  SalesReportQuery,
  type ReportFormat,
  type ReportTable,
} from "@ladino/schemas";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { csvDeReporte, nombreDeArchivo, xlsxDeReporte } from "../report-export.js";
import { requireCompany } from "./products.js";

/**
 * QUIÉN VE CADA REPORTE (P-07, RESPUESTA §2.8: cada oficio hace su trabajo). Un reporte agrega
 * dinero de toda la empresa: pertenecer a ella no lo abre (ADR-0048). Basta UNO de los permisos
 * de cada lista. Ninguno es nuevo: son los de lectura que ya gobernaban esas cifras en su módulo.
 *
 *   · ventas y margen: el dinero del negocio → `treasury.read` o `accounting.read` (los mismos
 *     del diferencial cambiario). El cajero y el encargado no los tienen.
 *   · IVA e IGTF: los libros → `fiscal_book.read` (contador y dueño).
 *   · inventario: las EXISTENCIAS, quien opera el almacén; el VALOR, además, `accounting.read` o
 *     `treasury.read`. Sin él, el valor viaja en null con `sin_permiso`.
 *   · carteras: `ar.read` y `ap.read`, como el estado de cuenta.
 *   · cierres de caja: `treasury.read`, el mismo de su lista (`GET /v1/cash-closings`).
 *     `cash_register.read` («Consultar cajas») NO lo abre: enseñaría lo esperado, lo contado y
 *     la diferencia de todos los cajeros a quien solo consulta las cajas.
 *
 * DESCARGAR (csv o xlsx) exige ADEMÁS `report.export` («Exportar reportes y libros»): ver en
 * pantalla no es llevarse el archivo.
 */
export const PERMISOS_DE_REPORTE = {
  sales: ["treasury.read", "accounting.read"],
  margin: ["treasury.read", "accounting.read"],
  iva: ["fiscal_book.read"],
  igtf: ["fiscal_book.read"],
  inventory: [
    "warehouse.read",
    "inventory.move",
    "inventory.adjust",
    "accounting.read",
    "treasury.read",
  ],
  receivables: ["ar.read"],
  payables: ["ap.read"],
  "cash-closings": ["treasury.read"],
} as const satisfies Record<ReportTable["report"], readonly string[]>;

/** Quién ve el VALOR del inventario (y no solo las existencias). */
export const PERMISOS_VALOR_DE_INVENTARIO = ["accounting.read", "treasury.read"] as const;

const PERMISO_DE_DESCARGA = "report.export";

async function tieneUno(
  tx: TransactionSql,
  userId: string,
  companyId: string,
  permisos: readonly string[],
): Promise<boolean> {
  const [r] = await tx<{ ok: boolean | null }[]>`
    select bool_or(platform.ladino_user_has_permission(${userId}, p, ${companyId})) as ok
      from unnest(${[...permisos]}::text[]) as p`;
  return r?.ok === true;
}

type Lectura = (
  tx: TransactionSql,
  companyId: string,
  userId: string,
  todas: boolean,
) => Promise<ReportTable | null>;

/**
 * El cuerpo común: autentica, autoriza (leer y, si se descarga, exportar), llama a la lectura del
 * dominio y mapea a JSON o a archivo. Ninguna cifra se toca aquí.
 */
async function servir(
  c: Context,
  sql: Sql,
  reporte: ReportTable["report"],
  formato: ReportFormat,
  leer: Lectura,
): Promise<Response> {
  const { companyId } = requireCompany(c);
  const { actor } = c.get("ladino.auth");
  if (actor.kind !== "user") {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Consultar un reporte exige un usuario real.",
    });
  }
  const userId = actor.userId;
  const permisos = PERMISOS_DE_REPORTE[reporte];
  const tabla = await withTransaction(sql, actor, async ({ sql: tx }) => {
    if (!(await tieneUno(tx, userId, companyId, permisos))) {
      throw new DominioError({
        code: "PERMISSION_REQUIRED",
        message: `Este reporte exige el permiso ${permisos.join(" o ")}.`,
      });
    }
    if (formato !== "json" && !(await tieneUno(tx, userId, companyId, [PERMISO_DE_DESCARGA]))) {
      throw new DominioError({
        code: "PERMISSION_REQUIRED",
        message: `Descargar un reporte exige el permiso ${PERMISO_DE_DESCARGA}.`,
      });
    }
    return leer(tx, companyId, userId, formato !== "json");
  });
  if (tabla === null) {
    throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  }
  if (formato === "json") return c.json(tabla, 200);
  const bytes = formato === "csv" ? csvDeReporte(tabla) : await xlsxDeReporte(tabla);
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type":
        formato === "csv"
          ? "text/csv; charset=utf-8"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${nombreDeArchivo(tabla, formato)}"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Los parámetros de la consulta, como objeto plano para Zod. */
function consulta(c: Context): Record<string, string> {
  return c.req.query();
}

/**
 * LOS REPORTES (P-07) Y LAS CARTERAS (F-13, H-11). Solo lectura. Cada ruta valida su consulta,
 * exige su permiso y llama a UNA lectura del dominio (`packages/domain/src/reports.ts`).
 */
export function reportsRoutes(app: Hono, sql: Sql): void {
  app.get("/v1/reports/sales", (c) => {
    const q = SalesReportQuery.safeParse(consulta(c));
    if (!q.success) throw new ValidacionError(q.error.issues);
    return servir(c, sql, "sales", q.data.format ?? "json", (tx, companyId, _u, todas) =>
      salesReport(tx, companyId, {
        from: q.data.from,
        to: q.data.to,
        group: q.data.group,
        page: q.data.page,
        perPage: q.data.per_page,
        all: todas,
      }),
    );
  });

  app.get("/v1/reports/margin", (c) => {
    const q = MarginReportQuery.safeParse(consulta(c));
    if (!q.success) throw new ValidacionError(q.error.issues);
    return servir(c, sql, "margin", q.data.format ?? "json", (tx, companyId, _u, todas) =>
      marginReport(tx, companyId, {
        from: q.data.from,
        to: q.data.to,
        group: q.data.group,
        page: q.data.page,
        perPage: q.data.per_page,
        all: todas,
      }),
    );
  });

  app.get("/v1/reports/iva", (c) => {
    const q = RangeReportQuery.safeParse(consulta(c));
    if (!q.success) throw new ValidacionError(q.error.issues);
    return servir(c, sql, "iva", q.data.format ?? "json", (tx, companyId, _u, todas) =>
      ivaReport(tx, companyId, {
        from: q.data.from,
        to: q.data.to,
        page: q.data.page,
        perPage: q.data.per_page,
        all: todas,
      }),
    );
  });

  app.get("/v1/reports/inventory", (c) => {
    const q = RangeReportQuery.safeParse(consulta(c));
    if (!q.success) throw new ValidacionError(q.error.issues);
    return servir(
      c,
      sql,
      "inventory",
      q.data.format ?? "json",
      async (tx, companyId, userId, todas) =>
        inventoryReport(tx, companyId, {
          from: q.data.from,
          to: q.data.to,
          page: q.data.page,
          perPage: q.data.per_page,
          all: todas,
          canSeeValue: await tieneUno(tx, userId, companyId, PERMISOS_VALOR_DE_INVENTARIO),
        }),
    );
  });

  app.get("/v1/reports/receivables", (c) => {
    const q = ReceivablesReportQuery.safeParse(consulta(c));
    if (!q.success) throw new ValidacionError(q.error.issues);
    return servir(c, sql, "receivables", q.data.format ?? "json", (tx, companyId, _u, todas) =>
      receivablesReport(tx, companyId, {
        sort: q.data.sort,
        page: q.data.page,
        perPage: q.data.per_page,
        all: todas,
      }),
    );
  });

  app.get("/v1/reports/payables", (c) => {
    const q = PayablesReportQuery.safeParse(consulta(c));
    if (!q.success) throw new ValidacionError(q.error.issues);
    return servir(c, sql, "payables", q.data.format ?? "json", (tx, companyId, _u, todas) =>
      payablesReport(tx, companyId, {
        sort: q.data.sort,
        page: q.data.page,
        perPage: q.data.per_page,
        all: todas,
      }),
    );
  });

  app.get("/v1/reports/cash-closings", (c) => {
    const q = CashClosingsReportQuery.safeParse(consulta(c));
    if (!q.success) throw new ValidacionError(q.error.issues);
    return servir(c, sql, "cash-closings", q.data.format ?? "json", (tx, companyId, _u, todas) =>
      cashClosingsReport(tx, companyId, {
        from: q.data.from,
        to: q.data.to,
        group: q.data.group,
        page: q.data.page,
        perPage: q.data.per_page,
        all: todas,
      }),
    );
  });

  app.get("/v1/reports/igtf", (c) => {
    const q = RangeReportQuery.safeParse(consulta(c));
    if (!q.success) throw new ValidacionError(q.error.issues);
    return servir(c, sql, "igtf", q.data.format ?? "json", (tx, companyId, _u, todas) =>
      igtfReport(tx, companyId, {
        from: q.data.from,
        to: q.data.to,
        page: q.data.page,
        perPage: q.data.per_page,
        all: todas,
      }),
    );
  });
}

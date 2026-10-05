import type { Hono } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import { SearchDocumentsQuery } from "@ladino/schemas";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

/**
 * Quién puede LEER una venta por su número (P-06, ADR-0081): `ar.read` o un permiso de operación
 * de ventas. La lista de documentos de ventas todavía no exige permiso propio (se cierra en la
 * ola 6); esta ruta nace con el suyo.
 *
 * Incluye los permisos con los que el menú abre «Ventas» (`sales.invoice.annul`,
 * `accounting.read`): quien entra a la pantalla encuentra en la paleta lo que la pantalla lista.
 */
export const PERMISOS_BUSCAR_VENTAS = [
  "ar.read",
  "accounting.read",
  "sales.invoice.issue",
  "sales.invoice.annul",
  "sales.quote.manage",
  "sales.order.manage",
  "sales.return.manage",
  "sales.payment.register",
] as const;

/**
 * Quién puede leer una compra: la MISMA convención de `GET /v1/supplier-invoices`
 * (`exigeLecturaDeCompras`): `ap.read`, o registrar o pagar facturas de proveedor. Recibir
 * mercancía (`purchase.receive`) no abre las facturas: el almacén no las encuentra.
 */
export const PERMISOS_BUSCAR_COMPRAS = [
  "ap.read",
  "purchase.invoice.register",
  "purchase.payment.register",
] as const;

/**
 * Los tipos de `documents` que se buscan por número; la compra sale de `supplier_invoices`.
 * La factura de retiro y su nota de crédito (ADR-0082) comparten correlativo con la factura y con
 * la nota de crédito: quien busca «A-23» la encuentra, y abre en el mismo detalle.
 */
const TIPOS_DE_VENTA = [
  "invoice",
  "receipt",
  "credit_note",
  "debit_note",
  "quote",
  "withdrawal_invoice",
  "withdrawal_credit_note",
] as const;
const POR_GRUPO = 6;

/** El texto va dentro de un `ilike`: `%`, `_` y `\` de la persona son letras, no comodines. */
function patron(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

interface Fila {
  type: string;
  id: string;
  number: string;
  party_name: string | null;
  date: string;
  status: string;
}

/**
 * LA BÚSQUEDA DE DOCUMENTOS POR NÚMERO (recorrido 2026-09-24, P-06; ADR-0081). La usa la paleta.
 *
 * Solo lectura y sin importes. Acotada a la empresa de `X-Company-Id` y a lo que el rol puede
 * leer: el grupo que el rol no abre NI SE CONSULTA, así que no aparece ni se cuenta (la respuesta
 * no lleva total). Quien no abre ninguno recibe una lista vacía, igual que quien busca algo que
 * no existe: la búsqueda no revela si el número existe.
 */
export function searchRoutes(app: Hono, sql: Sql): void {
  app.get("/v1/search/documents", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const parsed = SearchDocumentsQuery.safeParse({ q: c.req.query("q") ?? "" });
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    const q = parsed.data.q;
    if (actor.kind !== "user") {
      throw new DominioError({
        code: "PERMISSION_REQUIRED",
        message: "Buscar documentos exige un usuario real.",
      });
    }
    const userId = actor.userId;
    const items = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [puede] = await tx<{ ventas: boolean | null; compras: boolean | null }[]>`
        select (select bool_or(platform.ladino_user_has_permission(${userId}, p, ${companyId}))
                  from unnest(${[...PERMISOS_BUSCAR_VENTAS]}::text[]) as p) as ventas,
               (select bool_or(platform.ladino_user_has_permission(${userId}, p, ${companyId}))
                  from unnest(${[...PERMISOS_BUSCAR_COMPRAS]}::text[]) as p) as compras`;
      const like = patron(q);
      const ventas =
        puede?.ventas === true
          ? await tx<Fila[]>`
              select n.type, n.id, n.corto as number, n.party_name, n.date, n.status
                from (select d.kind as type, d.id, d.status,
                             case when d.series = '' then d.document_number::text
                                  else d.series || '-' || d.document_number::text end as corto,
                             case when d.series = '' then lpad(d.document_number::text, 8, '0')
                                  else d.series || '-' || lpad(d.document_number::text, 8, '0')
                             end as largo,
                             coalesce(d.customer_name_snapshot, cu.legal_name) as party_name,
                             -- El DÍA del documento, en Caracas: dos fechas, nunca un instante.
                             ((coalesce(d.issued_at, d.created_at)
                               at time zone ${"America/Caracas"})::date)::text as date,
                             coalesce(d.issued_at, d.created_at) as orden
                        from public.documents d
                        left join public.customers cu
                          on cu.id = d.customer_id and cu.company_id = d.company_id
                       where d.company_id = ${companyId}
                         and d.kind = any(${[...TIPOS_DE_VENTA]}::text[])
                         -- Un borrador todavía no tiene número: no hay por qué encontrarlo.
                         and d.document_number is not null) n
               where n.corto ilike ${like} escape '\\' or n.largo ilike ${like} escape '\\'
               order by (lower(n.corto) = lower(${q}) or lower(n.largo) = lower(${q})) desc,
                        n.orden desc, n.id
               limit ${POR_GRUPO}`
          : [];
      const compras =
        puede?.compras === true
          ? await tx<Fila[]>`
              select 'purchase' as type, i.id,
                     coalesce(i.supplier_document_number, i.supplier_document_ref,
                              i.supplier_control_number) as number,
                     coalesce(i.supplier_name_snapshot, s.legal_name) as party_name,
                     i.invoice_date::text as date, i.status
                from public.supplier_invoices i
                left join public.suppliers s
                  on s.id = i.supplier_id and s.company_id = i.company_id
               where i.company_id = ${companyId}
                 and (i.supplier_document_number ilike ${like} escape '\\'
                      or i.supplier_document_ref ilike ${like} escape '\\'
                      or i.supplier_control_number ilike ${like} escape '\\')
               order by (lower(coalesce(i.supplier_document_number, '')) = lower(${q})
                         or lower(coalesce(i.supplier_document_ref, '')) = lower(${q})
                         or lower(coalesce(i.supplier_control_number, '')) = lower(${q})) desc,
                        i.invoice_date desc, i.id
               limit ${POR_GRUPO}`
          : [];
      return [...ventas, ...compras];
    });
    return c.json({ items }, 200);
  });
}

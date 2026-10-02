import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql, type TransactionSql } from "@ladino/db";
import {
  CorrectRetentionVoucherRequest,
  DeliverRetentionVoucherRequest,
  SetRetentionVoucherModeRequest,
  formatearDocumento,
} from "@ladino/schemas";
import {
  correctRetentionVoucher,
  deliverRetentionVoucher,
  leerComprobante,
  setRetentionVoucherMode,
} from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

/**
 * COMPROBANTES DE RETENCIÓN DE IVA (ADR-0072 §4, H-04; contrato 2026-10-02). Se emiten solos al
 * registrar la factura del agente (`POST /v1/supplier-invoices` y la llegada de mercancía); aquí
 * se consultan, se imprimen, se anota su entrega y se corrigen con una versión nueva.
 *
 * El correo es opcional y NO se envía nada: el PDF se descarga y se entrega por el canal que la
 * empresa use.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function idValido(id: string): string {
  if (!UUID_RE.test(id)) {
    throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  }
  return id;
}

function coherente(cabecera: string, cuerpo: string): void {
  if (cabecera !== cuerpo) {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message: "La empresa del cuerpo no coincide con la de la cabecera X-Company-Id.",
    });
  }
}

/** Leer comprobantes: quien lee compras (ap.read) o quien registra facturas o emite comprobantes. */
async function exigeLectura(
  tx: TransactionSql,
  actor: { kind: string; userId?: string },
  companyId: string,
): Promise<void> {
  if (actor.kind !== "user" || actor.userId === undefined) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Consultar exige un usuario real.",
    });
  }
  const permisos = ["ap.read", "purchase.invoice.register", "retention.receipt.issue"];
  const [permiso] = await tx<{ ok: boolean }[]>`
    select bool_or(platform.ladino_user_has_permission(${actor.userId}, p, ${companyId})) as ok
      from unnest(${permisos}::text[]) as p`;
  if (!permiso?.ok) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message:
        "Consultar comprobantes de retención exige ap.read, purchase.invoice.register o retention.receipt.issue.",
    });
  }
}

/**
 * Céntimos de un importe decimal en texto, redondeado HALF_UP a 2 decimales, con BigInt: solo
 * presentación del PDF, sin pasar por un double (regla 7).
 */
function centimos(v: unknown): bigint | null {
  const m = typeof v === "string" ? /^(-?)(\d+)(?:\.(\d+))?$/.exec(v) : null;
  if (!m) return null;
  const frac = (m[3] ?? "").padEnd(3, "0");
  let c = BigInt(m[2]!) * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) c += 1n;
  return m[1] === "-" ? -c : c;
}

/** Bs con separador de miles y coma decimal, a 2 decimales. */
function bs(v: unknown): string {
  const c = centimos(v);
  if (c === null) return "—";
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const ent = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const dec = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${ent},${dec}`;
}

export function retentionVoucherRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  /** El catálogo de exclusiones del art. 3 que la persona puede MARCAR (las automáticas no). */
  app.get("/v1/retention-exclusions", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const items = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      return tx<Record<string, unknown>[]>`
        select code, description, legal_norm, legal_article, numeral_verified
          from public.retention_exclusions
         where applies = 'marked'
           and effective_from <= (now() at time zone 'America/Caracas')::date
           and (effective_to is null
                or effective_to > (now() at time zone 'America/Caracas')::date)
         order by code`;
    });
    return c.json({ items }, 200);
  });

  app.get("/v1/retention-vouchers", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const desde = c.req.query("from") ?? "";
    const hasta = c.req.query("to") ?? "";
    const proveedor = c.req.query("supplier_id") ?? "";
    if ((desde !== "" && !FECHA_RE.test(desde)) || (hasta !== "" && !FECHA_RE.test(hasta))) {
      throw new DominioError({ code: "VALIDATION_FAILED", message: "Fechas en AAAA-MM-DD." });
    }
    const items = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      return tx<Record<string, unknown>[]>`
        select v.id, v.supplier_id, v.voucher_number, v.version_no, v.mode,
               v.issued_on::text as issued_on, v.delivery_due_on::text as delivery_due_on,
               v.delivered_on::text as delivered_on, v.supplier_tax_id, v.supplier_name,
               v.functional_currency,
               case when exists (select 1 from public.retention_vouchers n
                                  where n.replaces_voucher_id = v.id)
                    then 'annulled' else 'issued' end as status,
               (select coalesce(sum(l.retained_amount), 0) from public.retention_voucher_lines l
                 where l.retention_voucher_id = v.id)::text as total_retained
          from public.retention_vouchers v
         where v.company_id = ${companyId}
           ${desde === "" ? tx`` : tx`and v.issued_on >= ${desde}::date`}
           ${hasta === "" ? tx`` : tx`and v.issued_on <= ${hasta}::date`}
           ${proveedor === "" ? tx`` : tx`and v.supplier_id = ${idValido(proveedor)}`}
         order by v.issued_on desc, v.sequence desc
         limit 500`;
    });
    return c.json({ items }, 200);
  });

  app.get("/v1/retention-vouchers/:id", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = idValido(c.req.param("id"));
    const v = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      return leerComprobante(tx, companyId, id);
    });
    if (v === null)
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    return c.json(v, 200);
  });

  /** El PDF del comprobante, con el contenido del art. 16 de la PA SNAT/2025/000054. */
  app.get("/v1/retention-vouchers/:id/pdf", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = idValido(c.req.param("id"));
    const v = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      return leerComprobante(tx, companyId, id);
    });
    if (v === null)
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });

    const { default: PDFDocument } = await import("pdfkit");
    const pdf = new PDFDocument({ size: "LETTER", layout: "landscape", margin: 40 });
    const trozos: Buffer[] = [];
    pdf.on("data", (b: Buffer) => trozos.push(b));
    const terminado = new Promise<Buffer>((resolve) =>
      pdf.on("end", () => resolve(Buffer.concat(trozos))),
    );
    pdf.fontSize(13).text("COMPROBANTE DE RETENCIÓN DEL IMPUESTO AL VALOR AGREGADO", {
      align: "center",
    });
    pdf.fontSize(8).text("PA SNAT/2025/000054, art. 16", { align: "center" }).moveDown(0.6);
    pdf.fontSize(10).text(`N.º de comprobante: ${v.voucher_number}`);
    pdf.text(`Fecha de emisión: ${v.issued_on}    Entrega a más tardar: ${v.delivery_due_on}`);
    pdf.text(`Fecha de entrega: ${v.delivered_on ?? "pendiente"}`);
    if (v.status === "annulled") {
      pdf
        .fillColor("red")
        .text("ANULADO: reemplazado por una versión corregida.")
        .fillColor("black");
    }
    if (v.version_no > 1) pdf.text(`Versión ${v.version_no}. Motivo: ${v.correction_reason ?? ""}`);
    pdf.moveDown(0.5);
    pdf.text(`Agente de retención: ${v.agent_name} · RIF ${formatearDocumento(v.agent_tax_id)}`);
    pdf.text(`Domicilio fiscal: ${v.agent_address ?? "—"}`);
    pdf.text(`Proveedor: ${v.supplier_name} · RIF ${formatearDocumento(v.supplier_tax_id)}`);
    pdf.text(`Domicilio fiscal: ${v.supplier_address ?? "—"}`).moveDown(0.6);

    const cols = [
      ["Fecha", 60],
      ["Tipo", 30],
      ["Documento", 70],
      ["Control", 70],
      ["Afectado", 55],
      ["Total", 80],
      ["Base", 80],
      ["Exento", 70],
      ["Alícuota", 45],
      ["IVA causado", 75],
      ["% ret.", 40],
      ["IVA retenido", 80],
    ] as const;
    const fila = (valores: string[]): void => {
      const y = pdf.y;
      let x = 40;
      valores.forEach((t, i) => {
        pdf.text(t, x, y, { width: cols[i]![1], lineBreak: false });
        x += cols[i]![1];
      });
      pdf.moveDown(0.4);
      pdf.x = 40;
    };
    pdf.fontSize(8);
    fila(cols.map((c) => c[0]));
    for (const l of v.lines) {
      // La porción (0,75) en porcentaje: sus céntimos SON el porcentaje entero.
      const porcion = centimos(l.portion);
      fila([
        l.document_date,
        l.document_type,
        l.document_number ?? "—",
        l.control_number ?? "—",
        l.affected_document ?? "—",
        bs(l.total_amount),
        bs(l.taxable_base),
        bs(l.exempt_amount),
        l.tax_rate === null ? "—" : `${bs(l.tax_rate)} %`,
        bs(l.iva_amount),
        porcion === null ? "—" : `${porcion.toString()} %`,
        bs(l.retained_amount),
      ]);
    }
    pdf
      .moveDown(0.5)
      .fontSize(10)
      .text(`Total IVA retenido: Bs. ${bs(v.total_retained)}`, 40);
    pdf
      .moveDown(2)
      .fontSize(9)
      .text("Firma y sello del agente de retención: ______________________", 40);
    pdf.end();
    const cuerpo = await terminado;
    return new Response(new Uint8Array(cuerpo), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="comprobante-retencion-${v.voucher_number}.pdf"`,
      },
    });
  });

  app.post("/v1/retention-vouchers/:id/delivery", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = idValido(c.req.param("id"));
    const parsed = DeliverRetentionVoucherRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      deliverRetentionVoucher(uow, id, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  app.post("/v1/retention-vouchers/:id/corrections", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = idValido(c.req.param("id"));
    const parsed = CorrectRetentionVoucherRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      correctRetentionVoucher(uow, id, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.put("/v1/retention-vouchers/settings", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = SetRetentionVoucherModeRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => setRetentionVoucherMode(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });
}

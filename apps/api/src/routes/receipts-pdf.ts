import type { Hono } from "hono";
import { withTransaction, type Sql, type TransactionSql } from "@ladino/db";
import { esMarcadorSinRif, formatearDocumento, serieYNumero } from "@ladino/schemas";
import { DominioError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";
import { vestirImporte } from "./documents-pdf.js";

/**
 * LOS COMPROBANTES NO FISCALES DE DINERO (ola 4; F-10 «con recibo», G-15 «documento de reembolso»).
 *
 *   · GET /v1/payments/:id/pdf — el comprobante de un cobro: cuánto se recibió, cuánto se aplicó
 *     al documento y, si el cliente pagó de más, el saldo a favor que nació, en su moneda;
 *   · GET /v1/customer-refunds/:id/pdf — el comprobante del reembolso de un saldo a favor: lo
 *     que se devolvió del saldo a favor, lo que salió de la caja y en qué moneda, la tasa del
 *     día, la cuenta, quién lo hizo y el motivo.
 *
 * NINGUNO ES UN DOCUMENTO FISCAL y los dos lo dicen. No llevan número de control, ni impuesto,
 * ni serie fiscal, ni citan la providencia de facturación: son constancia de un movimiento de
 * dinero. El RIF de la empresa se imprime solo si lo tiene: el marcador «todavía sin RIF» nunca
 * llega al papel (`esMarcadorSinRif`).
 *
 * IDENTIFICADOR. Ni `payments` ni `customer_refunds` tienen un correlativo legible: su única
 * identidad es el uuid. Se imprime entero y, como referencia corta para decirla por teléfono, sus
 * ocho últimos caracteres. NO es un correlativo: no es consecutivo ni promete serlo. Un número
 * propio por empresa sería una columna y una secuencia nuevas: es una decisión del dueño.
 *
 * Aquí no se calcula nada: cada cifra es la que guardó el caso de uso. Solo se viste el texto.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FORMA: Record<string, string> = {
  // Las llaves son las del catálogo de `payments.instrument` (payments_instrument_chk).
  efectivo_bs: "Efectivo en bolívares",
  efectivo_usd: "Efectivo en dólares",
  transferencia: "Transferencia",
  pago_movil: "Pago móvil",
  punto_venta: "Punto de venta",
  tarjeta: "Tarjeta",
  cashea: "Cashea",
  zelle: "Zelle",
  usdt: "USDT",
  saldo_a_favor: "Saldo a favor",
  retencion_iva: "Retención de IVA",
  otro: "Otra forma de pago",
};
const KIND: Record<string, string> = {
  invoice: "Factura",
  receipt: "Recibo",
  debit_note: "Nota de débito",
  credit_note: "Nota de crédito",
  receipt_return: "Recibo de devolución",
};

function idValido(crudo: string): string {
  if (!UUID_RE.test(crudo)) {
    throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  }
  return crudo;
}
/** «USD 5,00» · «Bs. 1.098,00»: el importe exacto, vestido, con su moneda delante. */
function dinero(importe: string, moneda: string): string {
  return `${moneda === "VES" ? "Bs." : moneda} ${vestirImporte(importe)}`;
}
/** dd/mm/aaaa hh:mm, del texto que ya viene en hora de Caracas. */
function fechaHora(texto: string): string {
  const [dia = "", hora = ""] = texto.split(" ");
  const [y, m, d] = dia.split("-");
  return `${d}/${m}/${y} ${hora.slice(0, 5)}`;
}
function referenciaCorta(id: string): string {
  return id.slice(-8).toUpperCase();
}

/** Lo ve quien tiene CUALQUIERA de los permisos: quien cobra o reembolsa, y quien lee la cartera. */
async function exigeAlguno(
  tx: TransactionSql,
  actor: { kind: string; userId?: string },
  companyId: string,
  permisos: readonly string[],
): Promise<void> {
  if (actor.kind !== "user" || actor.userId === undefined) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Ver un comprobante exige un usuario real.",
    });
  }
  for (const p of permisos) {
    const [fila] = await tx<{ ok: boolean }[]>`
      select platform.ladino_user_has_permission(${actor.userId}, ${p}, ${companyId}) as ok`;
    if (fila?.ok) return;
  }
  throw new DominioError({
    code: "PERMISSION_REQUIRED",
    message: `La operación exige el permiso ${permisos[0]} sobre esta empresa.`,
  });
}

interface Cabecera {
  empresa: string;
  empresa_rif: string | null;
  cliente: string | null;
  cliente_doc: string | null;
}

/** Monta el PDF: título, empresa, cliente, los renglones y la leyenda. Una página, texto corrido. */
async function componer(
  titulo: string,
  id: string,
  cab: Cabecera,
  renglones: readonly string[],
  nombreArchivo: string,
): Promise<Response> {
  const { default: PDFDocument } = await import("pdfkit");
  const pdf = new PDFDocument({ size: "LETTER", margin: 54 });
  const trozos: Buffer[] = [];
  pdf.on("data", (b: Buffer) => trozos.push(b));
  const terminado = new Promise<Buffer>((resolve) =>
    pdf.on("end", () => resolve(Buffer.concat(trozos))),
  );
  pdf.fontSize(14).text(titulo, { align: "center" });
  pdf.fontSize(9).text("Documento no fiscal", { align: "center" }).moveDown(0.8);
  pdf.fontSize(11).text(cab.empresa);
  // El RIF solo si lo tiene: el marcador «todavía sin RIF» no se imprime.
  if (cab.empresa_rif !== null && cab.empresa_rif !== "" && !esMarcadorSinRif(cab.empresa_rif)) {
    pdf.fontSize(9).text(`RIF ${formatearDocumento(cab.empresa_rif)}`);
  }
  pdf.moveDown(0.6).fontSize(10);
  pdf.text(`Referencia: ${referenciaCorta(id)}`);
  if (cab.cliente !== null) {
    const doc =
      cab.cliente_doc !== null && cab.cliente_doc !== "" && !esMarcadorSinRif(cab.cliente_doc)
        ? ` · ${formatearDocumento(cab.cliente_doc)}`
        : "";
    pdf.text(`Cliente: ${cab.cliente}${doc}`);
  }
  pdf.moveDown(0.4);
  for (const r of renglones) pdf.text(r);
  pdf.moveDown(2).fontSize(9);
  pdf.text("Recibí conforme: ______________________");
  pdf.moveDown(1.2).fontSize(7).fillColor("#555555");
  pdf.text(
    "Documento no fiscal. Constancia de un movimiento de dinero: no sustituye a una factura ni a una nota de crédito.",
  );
  pdf.text(`Identificador: ${id}`);
  pdf.end();
  const cuerpo = await terminado;
  return new Response(new Uint8Array(cuerpo), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${nombreArchivo}-${referenciaCorta(id)}.pdf"`,
    },
  });
}

export function receiptsPdfRoutes(app: Hono, sql: Sql): void {
  /** El comprobante de un cobro (F-10). */
  app.get("/v1/payments/:id/pdf", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = idValido(c.req.param("id"));
    const f = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeAlguno(tx, actor, companyId, ["sales.payment.register", "ar.read"]);
      const [fila] = await tx<Record<string, string | null>[]>`
        select co.legal_name as empresa, co.tax_id as empresa_rif,
               co.functional_currency_code as funcional,
               cu.legal_name as cliente, cu.tax_id as cliente_doc,
               to_char(p.paid_at at time zone 'America/Caracas', 'YYYY-MM-DD HH24:MI') as fecha,
               p.currency, p.amount::text as amount, p.fx_rate::text as fx_rate,
               p.functional_amount::text as functional_amount, p.instrument, p.reference,
               p.settled_transaction_amount::text as aplicado,
               d.transaction_currency as doc_moneda, d.kind as doc_kind, d.series as doc_serie,
               d.document_number::text as doc_numero,
               (select ca.name from public.company_accounts ca
                 where ca.company_id = p.company_id and ca.id = p.account_id) as cuenta,
               (select cc.amount::text from public.customer_credits cc
                 where cc.company_id = p.company_id and cc.source_payment_id = p.id) as sobrante,
               (select cc.currency from public.customer_credits cc
                 where cc.company_id = p.company_id and cc.source_payment_id = p.id)
                 as sobrante_moneda,
               (select cc.status from public.customer_credits cc
                 where cc.company_id = p.company_id and cc.source_payment_id = p.id)
                 as sobrante_estado,
               (select nullif(btrim(up.full_name), '') from public.users_profile up
                 where up.user_id = p.created_by) as autor,
               (select to_char(pr.reversed_at at time zone 'America/Caracas', 'YYYY-MM-DD HH24:MI')
                  from public.payment_reversals pr
                 where pr.company_id = p.company_id and pr.payment_id = p.id) as reversado
          from public.payments p
          join public.documents d on d.id = p.document_id and d.company_id = p.company_id
          join public.companies co on co.id = p.company_id
          left join public.customers cu on cu.id = d.customer_id and cu.company_id = d.company_id
         where p.id = ${id} and p.company_id = ${companyId}`;
      return fila ?? null;
    });
    if (f === null) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    const documento = `${KIND[f["doc_kind"] ?? ""] ?? "Documento"} ${
      f["doc_numero"] === null ? "" : serieYNumero(f["doc_serie"] ?? "", Number(f["doc_numero"]))
    }`.trim();
    const renglones: string[] = [
      `Fecha: ${fechaHora(f["fecha"] ?? "")}`,
      `Documento que se cobra: ${documento}`,
      `Forma de pago: ${FORMA[f["instrument"] ?? ""] ?? (f["instrument"] ?? "").replace(/_/g, " ")}`,
    ];
    if (f["reference"] !== null && f["reference"] !== "") {
      renglones.push(`Referencia del pago: ${f["reference"]}`);
    }
    if (f["cuenta"] !== null) renglones.push(`Entró en la cuenta: ${f["cuenta"]}`);
    renglones.push(`Recibido: ${dinero(f["amount"] ?? "0", f["currency"] ?? "")}`);
    if (f["currency"] !== f["funcional"] && f["instrument"] !== "saldo_a_favor") {
      renglones.push(
        `Tasa del día: ${vestirImporte(f["fx_rate"] ?? "0")} (${dinero(f["functional_amount"] ?? "0", f["funcional"] ?? "")})`,
      );
    }
    // Un cobro anterior a 20261003170000 no guarda lo que saldó en la moneda del documento.
    if (f["aplicado"] !== null) {
      renglones.push(
        `Aplicado al documento: ${dinero(f["aplicado"] ?? "0", f["doc_moneda"] ?? "")}`,
      );
    }
    if (f["sobrante"] !== null) {
      // Un cobro reversado ya devolvió TODO el dinero: su saldo a favor se retiró con él. El
      // comprobante lo dice en vez de seguir prometiendo un saldo que ya no existe.
      if (f["reversado"] !== null || f["sobrante_estado"] === "expired") {
        renglones.push(
          `Saldo a favor: ${dinero(f["sobrante"] ?? "0", f["sobrante_moneda"] ?? "")} (retirado)`,
        );
        renglones.push(
          "El cliente había pagado de más: ese saldo a favor se retiró al reversar el cobro y ya no está a su nombre.",
        );
      } else {
        renglones.push(
          `Saldo a favor: ${dinero(f["sobrante"] ?? "0", f["sobrante_moneda"] ?? "")}`,
        );
        renglones.push(
          "El cliente pagó de más: ese saldo a favor queda a su nombre y se aplica a otra compra o se le devuelve.",
        );
      }
    }
    if (f["autor"] !== null) renglones.push(`Registrado por: ${f["autor"]}`);
    if (f["reversado"] !== null) {
      renglones.push(`ESTE COBRO FUE REVERSADO el ${fechaHora(f["reversado"] ?? "")}.`);
    }
    return componer(
      "COMPROBANTE DE COBRO",
      id,
      {
        empresa: f["empresa"] ?? "",
        empresa_rif: f["empresa_rif"] ?? null,
        cliente: f["cliente"] ?? null,
        cliente_doc: f["cliente_doc"] ?? null,
      },
      renglones,
      "comprobante-cobro",
    );
  });

  /** El comprobante del reembolso de un saldo a favor (G-15). */
  app.get("/v1/customer-refunds/:id/pdf", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = idValido(c.req.param("id"));
    const f = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeAlguno(tx, actor, companyId, ["sales.refund", "ar.read"]);
      const [fila] = await tx<Record<string, string | null>[]>`
        select co.legal_name as empresa, co.tax_id as empresa_rif,
               cu.legal_name as cliente, cu.tax_id as cliente_doc,
               to_char(r.refunded_at at time zone 'America/Caracas', 'YYYY-MM-DD HH24:MI') as fecha,
               r.reason, r.transaction_currency as sale_moneda,
               r.amount_transaction_currency::text as sale, r.fx_rate::text as fx_rate,
               r.functional_currency as funcional, r.functional_amount::text as sale_funcional,
               -- Un reembolso anterior a 20261004150000: saldo y caja en la misma moneda.
               coalesce(r.credit_amount, r.amount_transaction_currency)::text as devuelto,
               coalesce(r.credit_currency, r.transaction_currency) as devuelto_moneda,
               ca.name as cuenta,
               -- Anterior a 20261004190100: la tasa de la caja (saldo y caja, misma moneda).
               coalesce(r.credit_fx_rate, r.fx_rate)::text as tasa_del_dia,
               (select nullif(btrim(up.full_name), '') from public.users_profile up
                 where up.user_id = r.created_by) as autor
          from public.customer_refunds r
          join public.customer_credits cc
            on cc.id = r.customer_credit_id and cc.company_id = r.company_id
          join public.companies co on co.id = r.company_id
          join public.company_accounts ca on ca.id = r.account_id and ca.company_id = r.company_id
          left join public.customers cu on cu.id = cc.customer_id and cu.company_id = cc.company_id
         where r.id = ${id} and r.company_id = ${companyId}`;
      return fila ?? null;
    });
    if (f === null) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    const renglones: string[] = [
      `Fecha: ${fechaHora(f["fecha"] ?? "")}`,
      `Saldo a favor devuelto: ${dinero(f["devuelto"] ?? "0", f["devuelto_moneda"] ?? "")}`,
      `Salió de la cuenta: ${dinero(f["sale"] ?? "0", f["sale_moneda"] ?? "")}`,
      `Cuenta: ${f["cuenta"] ?? ""}`,
    ];
    // La tasa del día solo dice algo si hubo divisa de por medio. Es la que el reembolso GUARDÓ
    // (20261004190100), no una que se vuelva a leer hoy.
    if (
      (f["sale_moneda"] !== f["funcional"] || f["devuelto_moneda"] !== f["funcional"]) &&
      f["tasa_del_dia"] !== null
    ) {
      renglones.push(`Tasa del día: ${vestirImporte(f["tasa_del_dia"] ?? "0")}`);
    }
    renglones.push(`Motivo: ${f["reason"] ?? ""}`);
    if (f["autor"] !== null) renglones.push(`Registrado por: ${f["autor"]}`);
    return componer(
      "COMPROBANTE DE REEMBOLSO DE SALDO A FAVOR",
      id,
      {
        empresa: f["empresa"] ?? "",
        empresa_rif: f["empresa_rif"] ?? null,
        cliente: f["cliente"] ?? null,
        cliente_doc: f["cliente_doc"] ?? null,
      },
      renglones,
      "comprobante-reembolso",
    );
  });
}

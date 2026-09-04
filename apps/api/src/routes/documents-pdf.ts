import type { Hono } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import { DominioError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

/**
 * El PDF de un documento de venta — FORMATO LIBRE, y lo dice en el pie.
 *
 * VALIDAR-SENIAT: este layout NO es un formato homologado ni pretende serlo.
 * La homologación de la emisión fiscal productiva está bloqueada por los
 * puntos de OPEN_QUESTIONS.md; mientras tanto, el negocio necesita ENTREGAR
 * algo impreso o por WhatsApp, y ese algo dice honestamente lo que es. El pie
 * de página lleva la marca; quitarla es una decisión de homologación, no de
 * código.
 *
 * Desde la migración 33 el documento CONGELA al cliente y desde la 34 al
 * EMISOR (R-05, ambos lados; PA 00071 art. 13.5): aquí se imprimen ESOS
 * snapshots, y los `coalesce` contra las filas vivas existen solo para
 * documentos anteriores a cada migración. Del art. 13 de la PA 00071 este
 * layout cumple además: fecha en ocho dígitos (13.6), marcador «(E)» en
 * líneas exentas/exoneradas/no sujetas leído del tratamiento congelado
 * (13.9), «SIN DERECHO A CRÉDITO FISCAL» en toda copia (13.13, `?copia=1`) y
 * ambas monedas con su tipo de cambio cuando la operación se expresó en
 * moneda extranjera (13.14).
 *
 * Generación en la API (pdfkit) y no en el worker — desviación declarada de
 * la spec de fase: es render puro de datos ya persistidos, tarda milisegundos
 * y un viaje por outbox solo añadiría una espera a la pantalla de éxito.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KIND_TITULO: Record<string, string> = {
  invoice: "FACTURA",
  credit_note: "NOTA DE CRÉDITO",
  debit_note: "NOTA DE DÉBITO",
  quote: "COTIZACIÓN",
  order: "PEDIDO",
};

/**
 * Viste un importe EXACTO para imprimir: separador de miles con punto, coma
 * decimal, ceros de cola recortados sin bajar de 2 decimales. Solo texto —
 * jamás un Number: el importe impreso es el persistido, no una aproximación.
 */
export function vestirImporte(exacto: string): string {
  const [enteroCrudo = "0", decimalCrudo = ""] = exacto.split(".");
  const entero = enteroCrudo.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  let decimal = decimalCrudo.replace(/0+$/, "");
  if (decimal.length < 2) decimal = decimal.padEnd(2, "0");
  return `${entero},${decimal}`;
}

function vestirCantidad(exacto: string): string {
  const [entero = "0", decimalCrudo = ""] = exacto.split(".");
  const decimal = decimalCrudo.replace(/0+$/, "");
  return decimal === "" ? entero : `${entero},${decimal}`;
}

function fechaLegible(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Viste un documento de identidad NORMALIZADO para imprimirlo: «V12345678» →
 * «V-12.345.678», «J401234567» → «J-40123456-7». Solo presentación — los
 * separadores no se guardan ni significan nada. Lo que no tenga la forma
 * prefijo+alfanumérico (datos anteriores a la migración 33) se imprime tal
 * cual: vestir no es corregir.
 */
export function vestirDocumento(crudo: string): string {
  const m = /^([VEJGP])([0-9A-Z]+)$/.exec(crudo.toUpperCase());
  if (!m) return crudo;
  const prefijo = m[1]!;
  const resto = m[2]!;
  if (prefijo === "V" || prefijo === "E") {
    return `${prefijo}-${resto.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
  }
  if ((prefijo === "J" || prefijo === "G") && resto.length > 1) {
    return `${prefijo}-${resto.slice(0, -1)}-${resto.slice(-1)}`;
  }
  return `${prefijo}-${resto}`;
}

export function documentsPdfRoutes(app: Hono, sql: Sql): void {
  app.get("/v1/documents/:id/pdf", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    // `?copia=1` genera una COPIA: idéntica al original salvo la leyenda que
    // exige PA 00071 art. 13.13 — «SIN DERECHO A CRÉDITO FISCAL» en toda copia.
    const esCopia = c.req.query("copia") === "1";

    const datos = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [doc] = await tx<Record<string, string | number | null>[]>`
        select d.kind, d.series, d.document_number::int as document_number,
               d.control_number::int as control_number, d.status,
               to_char(d.issued_at at time zone 'America/Caracas', 'YYYY-MM-DD') as issued_on,
               d.transaction_currency, d.functional_currency, d.fx_rate::text as fx_rate,
               d.rate_source, d.subtotal_amount::text as subtotal_amount,
               d.tax_amount::text as tax_amount, d.total_amount::text as total_amount,
               d.functional_amount::text as functional_amount,
               d.amount_transaction_currency::text as amount_transaction,
               d.annul_reason,
               coalesce(d.issuer_name_snapshot, e.legal_name) as company_name,
               coalesce(d.issuer_tax_id_snapshot, e.tax_id) as company_tax_id,
               coalesce(d.issuer_address_snapshot, e.fiscal_address) as company_address,
               coalesce(d.issuer_branch_address_snapshot, b.fiscal_address) as branch_address,
               coalesce(d.customer_name_snapshot, cu.legal_name) as customer_name,
               coalesce(d.customer_tax_id_snapshot, cu.tax_id) as customer_tax_id,
               coalesce(d.customer_address_snapshot, cu.fiscal_address) as customer_address,
               cu.is_system as customer_is_system
          from public.documents d
          join public.companies e on e.id = d.company_id
          join public.customers cu on cu.id = d.customer_id
          left join public.branches b on b.id = d.branch_id
         where d.id = ${id} and d.company_id = ${companyId}`;
      if (!doc) return null;
      const lineas = await tx<Record<string, string>[]>`
        select description, quantity::text as quantity,
               unit_price_transaction::text as unit_price,
               tax_rate_snapshot::text as tax_rate,
               tax_treatment,
               line_total_transaction::text as line_total
          from public.document_lines where document_id = ${id} order by line_number`;
      return { doc, lineas };
    });
    if (datos === null) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    const { doc, lineas } = datos;

    const { default: PDFDocument } = await import("pdfkit");
    const pdf = new PDFDocument({ size: "LETTER", margin: 48 });
    const trozos: Buffer[] = [];
    pdf.on("data", (b: Buffer) => trozos.push(b));
    const terminado = new Promise<Buffer>((resolve) =>
      pdf.on("end", () => resolve(Buffer.concat(trozos))),
    );

    const moneda = String(doc["transaction_currency"]);
    const funcional = String(doc["functional_currency"]);

    // ── Membrete (PA 00071 art. 13.5: nombre, RIF y domicilio del EMISOR;
    //    desde la migración 34 salen del SNAPSHOT congelado — el coalesce al
    //    vivo existe solo para documentos anteriores) ─────────────────────────
    pdf.font("Helvetica-Bold").fontSize(14).text(String(doc["company_name"]));
    pdf
      .font("Helvetica")
      .fontSize(10)
      .text(`RIF: ${vestirDocumento(String(doc["company_tax_id"]))}`);
    if (doc["company_address"]) {
      pdf.text(`Domicilio fiscal: ${String(doc["company_address"])}`);
    }
    if (doc["branch_address"]) {
      pdf.text(`Sucursal: ${String(doc["branch_address"])}`);
    }
    pdf.moveDown(0.8);

    // ── Identidad del documento ────────────────────────────────────────────
    const titulo = KIND_TITULO[String(doc["kind"])] ?? String(doc["kind"]).toUpperCase();
    pdf
      .font("Helvetica-Bold")
      .fontSize(13)
      .text(
        `${titulo}  ${String(doc["series"])}-${String(doc["document_number"] ?? "s/n").padStart(8, "0")}`,
      );
    if (doc["control_number"] !== null) {
      pdf
        .font("Helvetica")
        .fontSize(10)
        .text(`N° de control: ${String(doc["control_number"]).padStart(8, "0")}`);
    }
    // Ocho dígitos con separadores, DD/MM/AAAA (PA 00071 art. 13.6).
    pdf.fontSize(10).text(`Fecha de emisión: ${fechaLegible(doc["issued_on"] as string | null)}`);
    if (esCopia) {
      pdf.moveDown(0.3);
      pdf.font("Helvetica-Bold").fontSize(11).text("SIN DERECHO A CRÉDITO FISCAL"); // PA 00071 art. 13.13: en toda copia
      pdf.font("Helvetica").fontSize(10);
    }
    if (doc["status"] === "annulled") {
      pdf.moveDown(0.3);
      pdf.font("Helvetica-Bold").fillColor("#b91c1c").fontSize(12).text("ANULADA");
      if (doc["annul_reason"]) {
        pdf
          .font("Helvetica")
          .fontSize(9)
          .text(`Motivo: ${String(doc["annul_reason"])}`);
      }
      pdf.fillColor("#000000");
    }
    pdf.moveDown(0.6);

    // ── Cliente ────────────────────────────────────────────────────────────
    if (doc["customer_is_system"]) {
      pdf.font("Helvetica").fontSize(10).text("Cliente: Consumidor final");
    } else {
      pdf
        .font("Helvetica")
        .fontSize(10)
        .text(`Cliente: ${String(doc["customer_name"])}`);
      if (doc["customer_tax_id"]) {
        pdf.text(`RIF/C.I.: ${vestirDocumento(String(doc["customer_tax_id"]))}`);
      }
      if (doc["customer_address"]) {
        pdf.text(`Domicilio: ${String(doc["customer_address"])}`);
      }
    }
    pdf.moveDown(0.8);

    // ── Líneas ─────────────────────────────────────────────────────────────
    const xCant = 48;
    const xDesc = 100;
    const xPrecio = 380;
    const xTotal = 480;
    pdf.font("Helvetica-Bold").fontSize(9);
    const yCab = pdf.y;
    pdf.text("Cant.", xCant, yCab, { width: 46 });
    pdf.text("Descripción", xDesc, yCab, { width: 270 });
    pdf.text("Precio", xPrecio, yCab, { width: 90, align: "right" });
    pdf.text("Total", xTotal, yCab, { width: 84, align: "right" });
    pdf
      .moveTo(48, pdf.y + 2)
      .lineTo(564, pdf.y + 2)
      .stroke();
    pdf.moveDown(0.4);
    pdf.font("Helvetica").fontSize(9);
    for (const l of lineas) {
      const y = pdf.y;
      // «(E)» junto a la descripción para exentas, exoneradas o no sujetas
      // (PA 00071 art. 13.9), leído del TRATAMIENTO CONGELADO al emitir
      // (migración 27). Una línea sin tratamiento (anterior a la 27) no se
      // marca: no se sabe, y marcar sin saber es declarar mal.
      const exenta =
        l["tax_treatment"] === "exento" ||
        l["tax_treatment"] === "exonerado" ||
        l["tax_treatment"] === "no_sujeto";
      pdf.text(vestirCantidad(l["quantity"]!), xCant, y, { width: 46 });
      pdf.text(`${l["description"]!}${exenta ? " (E)" : ""}`, xDesc, y, { width: 270 });
      pdf.text(vestirImporte(l["unit_price"]!), xPrecio, y, { width: 90, align: "right" });
      pdf.text(vestirImporte(l["line_total"]!), xTotal, y, { width: 84, align: "right" });
      pdf.moveDown(0.2);
    }
    pdf
      .moveTo(48, pdf.y + 2)
      .lineTo(564, pdf.y + 2)
      .stroke();
    pdf.moveDown(0.5);

    // ── Totales ────────────────────────────────────────────────────────────
    const totalFila = (etiqueta: string, importe: string, negrita = false): void => {
      const y = pdf.y;
      pdf.font(negrita ? "Helvetica-Bold" : "Helvetica").fontSize(10);
      pdf.text(etiqueta, 330, y, { width: 140, align: "right" });
      pdf.text(`${moneda} ${vestirImporte(importe)}`, 470, y, { width: 94, align: "right" });
      pdf.moveDown(0.15);
    };
    totalFila("Subtotal:", String(doc["subtotal_amount"]));
    totalFila("IVA:", String(doc["tax_amount"]));
    totalFila("TOTAL:", String(doc["total_amount"]), true);
    // PA 00071 art. 13.14: operación expresada en moneda extranjera → el
    // documento lleva AMBAS monedas y el tipo de cambio aplicable. Los tres
    // datos vienen congelados en la fila; aquí solo se visten.
    if (moneda !== funcional) {
      pdf.moveDown(0.2);
      pdf
        .font("Helvetica")
        .fontSize(9)
        .text(
          `Equivalente en ${funcional === "VES" ? "bolívares" : funcional}: ` +
            `${funcional === "VES" ? "Bs." : funcional} ${vestirImporte(String(doc["functional_amount"]))}`,
          280,
          pdf.y,
          { width: 284, align: "right" },
        )
        .text(
          `Tipo de cambio: ${vestirCantidad(String(doc["fx_rate"]))} ${funcional}/${moneda} — ${String(doc["rate_source"])} (art. 13.14, PA 00071)`,
          280,
          pdf.y,
          { width: 284, align: "right" },
        );
    }

    // ── Pie ────────────────────────────────────────────────────────────────
    pdf
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#666666")
      .text(
        "Documento en formato libre, pendiente de homologación SENIAT (VALIDAR-SENIAT). Generado por Ladino.",
        48,
        720,
        { width: 516, align: "center" },
      );

    pdf.end();
    const buffer = await terminado;
    c.header("Content-Type", "application/pdf");
    c.header(
      "Content-Disposition",
      `inline; filename="${String(doc["kind"])}-${String(doc["series"])}-${String(doc["document_number"] ?? "sn")}.pdf"`,
    );
    return c.body(new Uint8Array(buffer));
  });
}

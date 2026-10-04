import type { Hono } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import { DominioError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";
import { descargarObjeto } from "../storage.js";
import type { StorageConfig } from "../config.js";
import {
  esMarcadorSinRif,
  formatearDocumento,
  filasDeDescripcion,
  filasDelMotivo,
  leerDocumentoCliente,
  serieYNumeroImpreso,
} from "@ladino/schemas";

/**
 * El PDF de un documento de venta. Ladino emite sobre FORMAS LIBRES (PA SNAT/2011/00071 arts. 6
 * num. 2 y 31; «formatos», art. 30, es otro medio) y este PDF tiene TRES destinos (ADR-0071 §4,
 * RESPUESTA 2026-09-24 §2.3):
 *
 *   · cortesía (por omisión: lo que se descarga o se envía por correo). NO es la factura: lleva la
 *     marca «Copia de cortesía · La factura válida es la impresa en forma libre con control N° …»
 *     y muestra todo, también lo que preimprime la imprenta. La factura digital solo existe por la
 *     PA SNAT/2024/000102 con imprenta digital autorizada (adaptador pendiente, fuera de Ladino).
 *   · `?destino=papel`: se imprime SOBRE la forma libre. Lo que la imprenta preimprime (art. 31:
 *     control, RIF del emisor, sus datos y providencia, rango, fecha de elaboración) queda EN
 *     BLANCO: nunca se imprime encima. El control se repite en el cuerpo si la empresa lo tiene
 *     encendido (`company_settings.print_control_number`, por omisión sí).
 *   · `?destino=vista`: la vista previa en pantalla. Lo preimpreso sale SOMBREADO y rotulado
 *     «preimpreso en la forma libre», para que la persona compare con su hoja.
 *
 * `?copia=1` añade «SIN DERECHO A CRÉDITO FISCAL» (13.13), la ÚNICA leyenda legal del papel: nada
 * de homologación ni de la PA 121, derogada por la PA SNAT/2026/00084 (A-11, FC-28).
 *
 * Desde la migración 33 el documento CONGELA al cliente y desde la 34 al EMISOR (R-05, ambos
 * lados; PA 00071 art. 13.5): aquí se imprimen ESOS snapshots, y los `coalesce` contra las filas
 * vivas existen solo para documentos anteriores a cada migración. Del art. 13 cumple además:
 * fecha en ocho dígitos (13.6), «(E)» en líneas exentas, exoneradas o no sujetas leído del
 * tratamiento congelado (13.8), base e IVA por alícuota con su porcentaje (13.10-11) y ambas
 * monedas con su tipo de cambio cuando la operación se expresó en moneda extranjera (13.14). La
 * NC y la ND citan la factura que corrigen —fecha, número, control y monto (arts. 23-24)—, su
 * motivo (art. 22) y la tasa de la factura con su fecha (FC-23 a FC-26). La lista entera vive en
 * docs/02_COMPLIANCE/FACTURA_CHECKLIST.md y la recorre e2e-checklist-factura.test.ts.
 *
 * El RECIBO y el RECIBO DE DEVOLUCIÓN (empresa sin RIF, ADR-0050 y ADR-0061) no son fiscales: sin
 * RIF del emisor, sin IVA, sin cita de providencia y sin copia fiscal (A-06, G-03).
 *
 * Generación en la API (pdfkit) y no en el worker — desviación declarada de la spec de fase: es
 * render puro de datos ya persistidos, tarda milisegundos y un viaje por outbox solo añadiría una
 * espera a la pantalla de éxito.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KIND_TITULO: Record<string, string> = {
  invoice: "FACTURA",
  credit_note: "NOTA DE CRÉDITO",
  debit_note: "NOTA DE DÉBITO",
  quote: "COTIZACIÓN",
  order: "PEDIDO",
  receipt: "RECIBO",
  receipt_return: "RECIBO DE DEVOLUCIÓN",
};

/** Cómo se nombra la clase en la marca de cortesía. */
const KIND_NOMBRE: Record<string, string> = {
  invoice: "La factura",
  credit_note: "La nota de crédito",
  debit_note: "La nota de débito",
};

/** Alto reservado abajo para la marca de cortesía y el pie, en cada página (H1). */
const MARGEN_PIE = 96;

/** Los tres destinos del PDF (ADR-0071 §4). */
type Destino = "cortesia" | "papel" | "vista";

/**
 * Serie y número como se imprimen, con el formateador ÚNICO de @ladino/schemas: la serie vacía
 * (el papel no trae serie) no deja guion colgante.
 */
type Escalar = string | number | boolean | null | undefined;

function numeroImpreso(series: Escalar, numero: Escalar): string {
  const serie = series === null || series === undefined ? "" : String(series);
  return numero === null || numero === undefined
    ? serieYNumeroImpreso(serie, "s/n")
    : serieYNumeroImpreso(serie, String(numero), 8);
}

/** El control como se imprime: `00-00001234` (PA 00071 art. 44; FC-29). */
function vestirControl(identificador: Escalar, numero: Escalar): string | null {
  if (numero === null || numero === undefined) return null;
  return `${String(identificador ?? "00")}-${String(numero).padStart(8, "0")}`;
}

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

/** «0.03000000» → «3.00000000»: la tasa como porcentaje, en texto, sin pasar por un Number. */
function multiplicarPorCien(tasa: string): string {
  const [entero = "0", decimal = ""] = tasa.split(".");
  const d = decimal.padEnd(2, "0");
  const resto = d.slice(2);
  const ent = (entero + d.slice(0, 2)).replace(/^0+(?=\d)/, "");
  return resto === "" ? ent : `${ent}.${resto}`;
}

function vestirCantidad(exacto: string): string {
  const [entero = "0", decimalCrudo = ""] = exacto.split(".");
  const decimal = decimalCrudo.replace(/0+$/, "");
  return decimal === "" ? entero : `${entero},${decimal}`;
}

/**
 * La tasa impresa, limpia: «Tasa BCV: 842,2067». La fuente completa —servicio y marca de
 * tiempo— queda en la fila, no en el papel (dueño, 2026-09-16). Un documento emitido antes de la
 * migración 66 con una tasa tecleada no se rotula «BCV»: dice «Tipo de cambio» (ADR-0064 §1).
 */
function nombreDeTasa(fuente: string): string {
  return /\bbcv\b/i.test(fuente) ? "Tasa BCV" : "Tipo de cambio";
}

/** La tasa exacta, con miles y coma decimal, sin ceros de cola. */
function vestirTasa(exacto: string): string {
  const [entero = "0", decimalCrudo = ""] = exacto.split(".");
  const miles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const decimal = decimalCrudo.replace(/0+$/, "");
  return decimal === "" ? miles : `${miles},${decimal}`;
}

function fechaLegible(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Viste un documento de identidad para imprimirlo. Delega en la función COMPARTIDA de
 * @ladino/schemas (la misma de la web): un RIF sale `V-12345678-9`, una cédula
 * `V-12.345.678`. Antes esta copia agrupaba un RIF V o E de 9 dígitos como cédula (M-05).
 * Acepta las dos grafías: el snapshot de un documento emitido no se toca (regla 1).
 */
export function vestirDocumento(crudo: string): string {
  return formatearDocumento(crudo);
}

export function documentsPdfRoutes(app: Hono, sql: Sql, storage?: StorageConfig): void {
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
    // H7 (decidido por criterio, menor sorpresa): «cortesia» explícito es lo mismo que sin destino.
    const destinoPedido = c.req.query("destino");
    if (
      destinoPedido !== undefined &&
      destinoPedido !== "cortesia" &&
      destinoPedido !== "papel" &&
      destinoPedido !== "vista"
    ) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message:
          "El destino del PDF es «cortesia», «papel» o «vista»; sin destino, la copia de cortesía.",
      });
    }
    const destino: Destino = destinoPedido ?? "cortesia";

    const datos = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [doc] = await tx<Record<string, string | number | boolean | null>[]>`
        select d.kind, d.series, d.document_number::int as document_number,
               d.control_number::int as control_number, d.control_identifier, d.status,
               d.source_document_id,
               -- El MOTIVO de la nota (art. 22): la NC directa y la ND lo guardan en notes;
               -- la NC de una devolución, en la devolución. Una nota sin él imprime «—».
               case when d.kind in ('credit_note', 'debit_note')
                    then coalesce(nullif(btrim(d.notes), ''),
                                  (select r.reason from public.returns r
                                    where r.credit_note_id = d.id and r.company_id = d.company_id
                                    limit 1))
               end as motivo,
               coalesce((select cs.print_control_number from public.company_settings cs
                          where cs.company_id = d.company_id), true) as print_control_number,
               to_char(d.issued_at at time zone 'America/Caracas', 'YYYY-MM-DD') as issued_on,
               d.transaction_currency, d.functional_currency, d.fx_rate::text as fx_rate,
               d.rate_source, d.rate_basis, d.subtotal_amount::text as subtotal_amount,
               d.tax_amount::text as tax_amount, d.total_amount::text as total_amount,
               d.functional_amount::text as functional_amount,
               d.amount_transaction_currency::text as amount_transaction,
               (select coalesce(sum(l.line_subtotal_transaction), 0)
                  from public.document_lines l where l.document_id = d.id)::text
                 as subtotal_transaction,
               (select coalesce(sum(l.tax_amount), 0)
                  from public.document_lines l where l.document_id = d.id)::text
                 as tax_transaction,
               d.annul_reason,
               e.logo_path as company_logo_path,
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
      // El PDF habla en bolívares (ADR-0047): las líneas salen del LADO
      // FUNCIONAL congelado al emitir — no de una conversión de hoy.
      const lineas = await tx<Record<string, string>[]>`
        select description, quantity::text as quantity,
               unit_price_functional::text as unit_price,
               tax_rate_snapshot::text as tax_rate,
               tax_treatment,
               line_subtotal_functional::text as line_subtotal,
               line_total_functional::text as line_total
          from public.document_lines where document_id = ${id} order by line_number`;
      // PA 00071 art. 13.10 y 13.11 (FC-10, FC-11; E-04): base e IVA DISCRIMINADOS POR
      // ALÍCUOTA, con su porcentaje, y lo exento, exonerado o no sujeto aparte. El IVA de cada
      // alícuota es total − subtotal funcionales de sus líneas: la misma derivación con la que el
      // documento congela su IVA, así que las alícuotas suman exactamente el IVA del documento.
      const alicuotas = await tx<
        { tratamiento: string | null; porcentaje: string; base: string; impuesto: string }[]
      >`
        select tax_treatment as tratamiento,
               replace(trim_scale(tax_rate_snapshot * 100)::text, '.', ',') as porcentaje,
               sum(line_subtotal_functional)::text as base,
               sum(line_total_functional - line_subtotal_functional)::text as impuesto
          from public.document_lines where document_id = ${id}
         group by tax_treatment, tax_rate_snapshot
         order by (tax_treatment is distinct from 'gravado'), tax_rate_snapshot desc,
                  tax_treatment`;
      // FC-31 (E-10): el subtotal es la SUMA DE LA COLUMNA de totales de línea sin IVA.
      const [columna] = await tx<{ subtotal: string }[]>`
        select coalesce(sum(line_subtotal_functional), 0)::text as subtotal
          from public.document_lines where document_id = ${id}`;
      // ADR-0071: el talonario del que salió el control — los datos que la imprenta preimprime
      // (art. 31) y que el documento cita (13.4, 13.15, 13.16). Con la exclusión de la migración
      // 160000 hay a lo sumo uno vivo por empresa, identificador y número.
      const [talonario] =
        doc["control_number"] === null
          ? []
          : await tx<Record<string, string | null>[]>`
        select r.printer_legal_name, r.printer_tax_id, r.printer_authorization,
               to_char(r.printer_authorization_date, 'YYYY-MM-DD') as printer_authorization_date,
               to_char(r.printed_on, 'YYYY-MM-DD') as printed_on,
               r.printer_identifier, r.range_from::text as range_from, r.range_to::text as range_to
          from public.fiscal_number_ranges r
         where r.company_id = ${companyId} and r.series = ${String(doc["series"])}
           and r.printer_identifier = ${String(doc["control_identifier"] ?? "00")}
           and r.kind is distinct from 'retention_receipt'
           and ${String(doc["control_number"])}::bigint between r.range_from and r.range_to
         order by (r.status = 'cancelled'), r.created_at desc
         limit 1`;
      // La factura que corrige la NC o la ND (arts. 23-24; FC-23, FC-24, FC-26).
      const [origen] =
        doc["source_document_id"] !== null &&
        (doc["kind"] === "credit_note" || doc["kind"] === "debit_note")
          ? await tx<Record<string, string | number | null>[]>`
        select o.kind, o.series, o.document_number::int as document_number,
               o.control_number::int as control_number, o.control_identifier,
               to_char(o.issued_at at time zone 'America/Caracas', 'YYYY-MM-DD') as issued_on,
               o.total_amount::text as total_amount, o.fx_rate::text as fx_rate, o.rate_source
          from public.documents o
         where o.id = ${String(doc["source_document_id"])} and o.company_id = ${companyId}`
          : [];
      // E-03 (PA SNAT/2022/000013 art. 6): el IGTF percibido, con alícuota y monto, en la divisa
      // del pago y en Bs a la tasa del día del COBRO (la de la percepción, congelada). La factura
      // imprime el que se percibió en su propia venta; el de un cobro POSTERIOR va en su ND por
      // IGTF, y la ND imprime el suyo. Lo absorbido no se le cobró al cliente: no se imprime.
      const igtf = await tx<
        {
          rate: string;
          base_amount: string;
          currency: string;
          amount: string;
          functional_amount: string;
          fx_rate: string;
          paid_on: string;
        }[]
      >`
        select rate::text as rate, base_amount::text as base_amount, currency,
               amount::text as amount, functional_amount::text as functional_amount,
               fx_rate::text as fx_rate,
               to_char(platform.caracas_day(occurred_at), 'YYYY-MM-DD') as paid_on
          from public.igtf_perceptions
         where company_id = ${companyId} and not absorbed
           and ${
             doc["kind"] === "debit_note"
               ? tx`debit_note_id = ${id}`
               : tx`document_id = ${id} and debit_note_id is null`
           }
         order by occurred_at, id`;
      // E-22 (P-05): una venta CON SALDO lo dice en su papel. El saldo es el de la única función
      // de deuda (ADR-0075 §5) A LA FECHA EN QUE SE IMPRIME, y el vencimiento, el de
      // platform.document_due_day (el acordado o, sin él, el día de la emisión). Solo factura y
      // recibo emitidos: un documento pagado o anulado no trae fila con `debe`.
      const [credito] =
        (doc["kind"] === "invoice" || doc["kind"] === "receipt") && doc["status"] === "issued"
          ? await tx<
              {
                currency: string;
                nominal: string | null;
                functional_today: string | null;
                rate_date: string;
                debe: boolean;
                due_on: string;
              }[]
            >`
        select dd.currency, dd.nominal::text as nominal,
               round(dd.functional_today, platform.currency_minor_units(dd.functional_currency))::text
                 as functional_today,
               to_char(dd.rate_date, 'YYYY-MM-DD') as rate_date,
               (dd.nominal is null or dd.nominal > 0) as debe,
               to_char(platform.document_due_day(d.due_date, d.issued_at), 'YYYY-MM-DD') as due_on
          from public.documents d
         cross join lateral platform.document_debt(${companyId}, d.id) dd
         where d.id = ${id} and d.company_id = ${companyId}`
          : [];
      return {
        doc,
        lineas,
        alicuotas,
        subtotalColumna: columna!.subtotal,
        talonario: talonario ?? null,
        origen: origen ?? null,
        igtf,
        credito: credito !== undefined && credito.debe ? credito : null,
      };
    });
    if (datos === null) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    const { doc, lineas, alicuotas, subtotalColumna, talonario, origen, igtf, credito } = datos;
    // El recibo y el recibo de devolución no son documentos fiscales (ADR-0050, ADR-0061).
    const esRecibo = doc["kind"] === "receipt" || doc["kind"] === "receipt_return";
    const esNota = doc["kind"] === "credit_note" || doc["kind"] === "debit_note";
    // Solo la factura, la NC y la ND salen sobre forma libre y llevan la marca de cortesía (H2):
    // la cotización y el pedido imprimen su PDF sin ella.
    const esFiscal = doc["kind"] === "invoice" || esNota;

    // Un recibo NO FISCAL no tiene «copia» fiscal (A6): la leyenda «SIN DERECHO A
    // CRÉDITO FISCAL» de PA 00071 art. 13.13 es de la factura. La pantalla ya no
    // ofrecía el botón; la API tampoco lo sirve.
    if (esCopia && esRecibo) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Un recibo no fiscal no tiene copia fiscal: descarga el recibo.",
      });
    }

    // El LOGO: presentación pura, FUERA del snapshot del emisor (LAD68
    // intacto — la ley congela nombre/RIF/domicilio; el logo vive y puede
    // cambiar). pdfkit no lee webp: se incrusta la variante logo-pdf.png
    // generada al subir. Fallback SILENCIOSO a solo-texto: sin logo, sin
    // storage o con la descarga caída, el papel sale igual de legal.
    let logo: Buffer | null = null;
    if (storage !== undefined && doc["company_logo_path"]) {
      const rutaPng = String(doc["company_logo_path"]).replace(/logo-256\.webp$/, "logo-pdf.png");
      logo = await descargarObjeto(storage, "company-logos", rutaPng);
    }

    const { default: PDFDocument } = await import("pdfkit");
    // H1: `bufferPages` para estampar la marca de cortesía y el pie en TODAS las páginas antes de
    // cerrar. El margen inferior reserva la franja del pie: el cuerpo nunca la pisa.
    const pdf = new PDFDocument({
      size: "LETTER",
      margins: { top: 48, left: 48, right: 48, bottom: MARGEN_PIE },
      bufferPages: true,
    });
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
    if (logo !== null) {
      try {
        // Arriba a la derecha, junto al membrete: ~90px (68pt), contenido.
        pdf.image(logo, 612 - 48 - 68, 44, { fit: [68, 68] });
      } catch {
        // Un PNG corrupto no tumba la factura: sale solo el texto.
      }
    }
    pdf.font("Helvetica-Bold").fontSize(14).text(String(doc["company_name"]));
    pdf.font("Helvetica").fontSize(10);
    /**
     * Lo que la imprenta PREIMPRIME en la forma libre (PA 00071 art. 31): en el papel, en blanco
     * (se reserva el alto y no se imprime nada encima); en la vista previa, sombreado y rotulado;
     * en la copia de cortesía, como texto corriente — no hay forma libre debajo.
     */
    const zonaPreimpresa = (textos: readonly string[]): void => {
      if (textos.length === 0) return;
      // H9: el MISMO alto en la vista y en el papel — la vista previa enseña la hoja tal cual.
      const alto = textos.length * 12 + (destino === "cortesia" ? 4 : 16);
      const y = pdf.y;
      if (destino === "papel") {
        pdf.y = y + alto;
        return;
      }
      if (destino === "vista") {
        pdf.save().rect(48, y, 516, alto).fill("#e5e7eb").restore();
        pdf
          .font("Helvetica-Oblique")
          .fontSize(7)
          .fillColor("#6b7280")
          .text("preimpreso en la forma libre", 52, y + 2, { width: 508 });
        pdf.fillColor("#4b5563");
      }
      pdf.font("Helvetica").fontSize(9);
      for (const t of textos) pdf.text(t, 52, pdf.y, { width: 508 });
      pdf.fillColor("#000000").fontSize(10);
      pdf.x = 48;
      pdf.y = y + alto;
    };
    const control = vestirControl(doc["control_identifier"], doc["control_number"]);
    // El RECIBO (migración 37) no lleva RIF del emisor: el negocio aún no lo tiene, y un documento
    // no fiscal no finge campos de factura. El marcador «PEND-…» no es un RIF: nunca se imprime.
    const taxIdEmisor = String(doc["company_tax_id"] ?? "");
    const rifEmisor =
      esRecibo || taxIdEmisor === "" || esMarcadorSinRif(taxIdEmisor)
        ? null
        : vestirDocumento(taxIdEmisor);
    if (!esRecibo) {
      if (doc["company_address"]) {
        pdf.text(`Domicilio fiscal: ${String(doc["company_address"])}`);
      }
      if (doc["branch_address"]) {
        pdf.text(`Sucursal: ${String(doc["branch_address"])}`);
      }
    }
    pdf.moveDown(0.4);
    if (!esRecibo) {
      zonaPreimpresa([
        ...(rifEmisor === null ? [] : [`RIF: ${rifEmisor}`]),
        ...(control === null ? [] : [`N° de control: ${control}`]),
      ]);
    }
    pdf.moveDown(0.4);

    // ── Identidad del documento ────────────────────────────────────────────
    const titulo = KIND_TITULO[String(doc["kind"])] ?? String(doc["kind"]).toUpperCase();
    pdf
      .font("Helvetica-Bold")
      .fontSize(13)
      .text(`${titulo}  ${numeroImpreso(doc["series"], doc["document_number"])}`);
    // El control en el CUERPO (ADR-0071 §4): ajuste por empresa, por omisión encendido. Nunca
    // sobre la casilla preimpresa (arriba); en la cortesía ya va en su zona y en la marca.
    if (control !== null && destino !== "cortesia" && doc["print_control_number"] !== false) {
      pdf.font("Helvetica").fontSize(10).text(`N° de control: ${control}`);
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
        // Art. 13.7: RIF, cédula o pasaporte; el rótulo dice cuál cuando es pasaporte.
        const docCliente = String(doc["customer_tax_id"]);
        const lectura = leerDocumentoCliente(docCliente);
        pdf.text(
          lectura.valido && lectura.tipo === "pasaporte"
            ? `Pasaporte: ${lectura.normalizado}`
            : `RIF/C.I.: ${vestirDocumento(docCliente)}`,
        );
      }
      if (doc["customer_address"]) {
        pdf.text(`Domicilio: ${String(doc["customer_address"])}`);
      }
    }
    const funcionalVestida = funcional === "VES" ? "Bs." : funcional;
    // ── La NC y la ND citan la factura que corrigen (arts. 22-24; G-02, G-09) ──
    if (esNota) {
      pdf.moveDown(0.5);
      pdf.font("Helvetica").fontSize(10);
      if (origen !== null) {
        const numeroOrigen = numeroImpreso(origen["series"], origen["document_number"]);
        const controlOrigen = vestirControl(origen["control_identifier"], origen["control_number"]);
        pdf.text(
          `Factura que corrige: ${numeroOrigen} · Control ${controlOrigen ?? "—"} · ` +
            `del ${fechaLegible(origen["issued_on"] as string | null)} · ` +
            `por ${funcionalVestida} ${vestirImporte(String(origen["total_amount"]))}`,
        );
        pdf.text(
          `Descripción del ajuste: ${doc["kind"] === "credit_note" ? "crédito" : "débito"} de ` +
            `${funcionalVestida} ${vestirImporte(String(doc["total_amount"]))} sobre la factura ${numeroOrigen}`,
        );
      } else {
        pdf.text("Factura que corrige: —");
      }
      // Una nota vieja sin motivo imprime «—», nunca un texto inventado.
      // A-2: el motivo, en filas partidas con la misma regla que cuenta el dominio.
      pdf.text(filasDelMotivo(doc["motivo"] ? String(doc["motivo"]) : null).join("\n"));
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
    // FC-31 (E-10): en la factura, el precio unitario y el total de la línea van SIN IVA; el
    // IVA va abajo, por alícuota. El recibo no separa impuesto y conserva sus rótulos.
    pdf.text(esRecibo ? "Precio" : "P. unit. sin IVA", xPrecio, yCab, {
      width: 90,
      align: "right",
    });
    pdf.text(esRecibo ? "Total" : "Total sin IVA", xTotal, yCab, { width: 84, align: "right" });
    pdf
      .moveTo(48, pdf.y + 2)
      .lineTo(564, pdf.y + 2)
      .stroke();
    pdf.moveDown(0.4);
    pdf.font("Helvetica").fontSize(9);
    for (const l of lineas) {
      // «(E)» junto a la descripción para exentas, exoneradas o no sujetas
      // (PA 00071 art. 13.8; E-24), leído del TRATAMIENTO CONGELADO al emitir
      // (migración 27). Una línea sin tratamiento (anterior a la 27) no se
      // marca: no se sabe, y marcar sin saber es declarar mal.
      const exenta =
        l["tax_treatment"] === "exento" ||
        l["tax_treatment"] === "exonerado" ||
        l["tax_treatment"] === "no_sujeto";
      // A-2: la descripción se parte en filas con la MISMA regla que cuenta el dominio al emitir
      // (`filasDeDescripcion`), no con el ajuste automático de pdfkit: el tope de la forma libre
      // (art. 33) es exacto. Ninguna fila la vuelve a partir pdfkit (los anchos están medidos).
      const textoDescripcion = filasDeDescripcion(l["description"]!, exenta).join("\n");
      // A-8: una línea no se parte entre dos páginas. Si no cabe entera, empieza en la siguiente,
      // y su cantidad, precio y total van a la altura de su descripción en esa página.
      const altoLinea = pdf.heightOfString(textoDescripcion, { width: 270 });
      if (pdf.y + altoLinea > pdf.page.height - pdf.page.margins.bottom) pdf.addPage();
      const y = pdf.y;
      pdf.text(vestirCantidad(l["quantity"]!), xCant, y, { width: 46 });
      pdf.text(textoDescripcion, xDesc, y, { width: 270 });
      const yTrasDescripcion = pdf.y;
      pdf.text(vestirImporte(l["unit_price"]!), xPrecio, y, { width: 90, align: "right" });
      pdf.text(vestirImporte(esRecibo ? l["line_total"]! : l["line_subtotal"]!), xTotal, y, {
        width: 84,
        align: "right",
      });
      pdf.y = Math.max(pdf.y, yTrasDescripcion);
      pdf.moveDown(0.2);
    }
    pdf
      .moveTo(48, pdf.y + 2)
      .lineTo(564, pdf.y + 2)
      .stroke();
    pdf.moveDown(0.5);

    // ── Totales ────────────────────────────────────────────────────────────
    // ADR-0047: el papel habla en BOLÍVARES. Los totales del pie
    // (subtotal/IVA/total) están congelados en moneda funcional desde la
    // emisión, y se visten «Bs.» como se dice en Venezuela — no el código ISO.
    const totalFila = (etiqueta: string, importe: string, negrita = false): void => {
      const y = pdf.y;
      pdf.font(negrita ? "Helvetica-Bold" : "Helvetica").fontSize(10);
      pdf.text(etiqueta, 330, y, { width: 140, align: "right" });
      pdf.text(`${funcionalVestida} ${vestirImporte(importe)}`, 470, y, {
        width: 94,
        align: "right",
      });
      pdf.moveDown(0.15);
    };
    // El recibo no separa IVA: no hay impuesto que separar (migración 37).
    if (!esRecibo) {
      totalFila("Subtotal:", subtotalColumna);
      const EXENTAS: Record<string, string> = {
        exento: "Exento (E):",
        exonerado: "Exonerado (E):",
        no_sujeto: "No sujeto (E):",
      };
      for (const a of alicuotas) {
        const rotuloExento = a.tratamiento === null ? undefined : EXENTAS[a.tratamiento];
        if (rotuloExento !== undefined) {
          totalFila(rotuloExento, a.base);
        } else if (a.tratamiento === null && a.porcentaje === "0") {
          // Anterior a la migración 27: sin tratamiento congelado, no se afirma que sea exenta.
          totalFila("Base sin clasificar:", a.base);
        } else {
          totalFila(`Base imponible ${a.porcentaje} %:`, a.base);
          totalFila(`IVA ${a.porcentaje} %:`, a.impuesto);
        }
      }
    }
    totalFila("TOTAL:", String(doc["total_amount"]), true);
    // PA 00071 art. 13.14: operación expresada en moneda extranjera → el
    // documento lleva AMBAS monedas y el tipo de cambio aplicable. El cuerpo
    // va en Bs (arriba); aquí, base, IVA y total en la moneda del documento y la
    // tasa de emisión — congelados en la fila. Es además la
    // deuda ANCLADA (ADR-0047): lo que se fía se debe en esta moneda.
    if (moneda !== funcional) {
      pdf.moveDown(0.2);
      // La cita de PA 00071 art. 13.14 es de la FACTURA (A6): el recibo no
      // fiscal muestra la tasa, sin invocar una norma que no le aplica.
      const cita = esRecibo ? "" : " (art. 13.14, PA 00071)";
      const nombreMoneda = moneda === "USD" ? "dólares" : moneda;
      pdf.font("Helvetica").fontSize(9);
      // LIVA art. 69 (G.O. Ext. 6.507): la factura en divisa lleva base imponible, impuesto y
      // total en la moneda de la operación Y en bolívares (ADR-0064 §2). El recibo no fiscal
      // no separa impuesto: solo su total.
      if (!esRecibo) {
        pdf
          .text(
            `Base imponible en ${nombreMoneda}: ${moneda} ${vestirImporte(String(doc["subtotal_transaction"]))}`,
            280,
            pdf.y,
            { width: 284, align: "right" },
          )
          .text(
            `IVA en ${nombreMoneda}: ${moneda} ${vestirImporte(String(doc["tax_transaction"]))}`,
            280,
            pdf.y,
            { width: 284, align: "right" },
          );
      }
      // FC-26 (G-11): la NC y la ND que corrigen van a la tasa de la FACTURA, y lo dicen con su
      // fecha. La ND por un concepto nuevo (rate_basis = own_day, hallazgo 13) va a la tasa de SU
      // día y la imprime con su fecha.
      const tasaImpresa =
        esNota && doc["rate_basis"] === "own_day"
          ? `${nombreDeTasa(String(doc["rate_source"]))} del ${fechaLegible(doc["issued_on"] as string | null)}: Bs ${vestirTasa(String(doc["fx_rate"]))}`
          : esNota && origen !== null
            ? `${nombreDeTasa(String(origen["rate_source"]))} de la factura ` +
              `${numeroImpreso(origen["series"], origen["document_number"])} ` +
              `del ${fechaLegible(origen["issued_on"] as string | null)}: Bs ${vestirTasa(String(origen["fx_rate"]))}`
            : `${nombreDeTasa(String(doc["rate_source"]))}: ${vestirTasa(String(doc["fx_rate"]))}${cita}`;
      pdf
        .text(
          `Total en ${nombreMoneda}: ` +
            `${moneda} ${vestirImporte(String(doc["amount_transaction"]))}`,
          280,
          pdf.y,
          { width: 284, align: "right" },
        )
        .text(tasaImpresa, 280, pdf.y, {
          width: 284,
          align: "right",
        });
    }

    // ── El IGTF percibido (E-03; PA SNAT/2022/000013 art. 6) ─────────────────
    // En los TRES destinos: no es lo que preimprime la imprenta, es dato del documento. El
    // porcentaje sale de la percepción (la regla vigente el día del cobro), nunca de un literal.
    if (igtf.length > 0) {
      pdf.moveDown(0.3);
      pdf.font("Helvetica").fontSize(9);
      for (const p of igtf) {
        const pct = vestirCantidad(multiplicarPorCien(p.rate));
        pdf.text(
          `IGTF ${pct} % sobre ${p.currency} ${vestirImporte(p.base_amount)} pagados en divisas: ` +
            `${p.currency} ${vestirImporte(p.amount)} · Bs. ${vestirImporte(p.functional_amount)} ` +
            `a la tasa del ${fechaLegible(p.paid_on)} (Bs ${vestirTasa(p.fx_rate)})`,
          280,
          pdf.y,
          { width: 284, align: "right" },
        );
      }
    }

    // ── La venta a crédito lo dice (E-22, P-05) ──────────────────────────────
    // Tres leyendas NO fiscales: no cambian base, IVA ni numeración. Van en el recibo (no es
    // forma libre) y en la copia de cortesía de la factura. NO van en `papel` ni en `vista` de
    // la factura: el tope de filas de la forma libre (PA 00071 art. 33) está medido contra este
    // cuerpo, y tres renglones más podrían sacar de la hoja una factura que hoy cabe justa.
    if (credito !== null && (esRecibo || destino === "cortesia")) {
      pdf.moveDown(0.5);
      const derecha = { width: 284, align: "right" as const };
      pdf.font("Helvetica-Bold").fontSize(10).text("A CRÉDITO", 280, pdf.y, derecha);
      pdf.font("Helvetica").fontSize(9);
      // La deuda se debe en la moneda del documento (ADR-0047): el nominal primero. Sin tasa de
      // hoy no se inventa el equivalente; sin nominal calculable se dice, nunca «0».
      const saldo =
        credito.nominal === null
          ? "no se puede calcular hoy (falta una tasa)"
          : credito.currency === funcional
            ? `${funcionalVestida} ${vestirImporte(credito.nominal)}`
            : `${credito.currency} ${vestirImporte(credito.nominal)}` +
              (credito.functional_today === null
                ? ""
                : ` · ${funcionalVestida} ${vestirImporte(credito.functional_today)} a la tasa ` +
                  `del ${fechaLegible(credito.rate_date)}`);
      pdf.text(`Saldo pendiente: ${saldo}`, 280, pdf.y, derecha);
      pdf.text(`Vence: ${fechaLegible(credito.due_on)}`, 280, pdf.y, derecha);
    }

    // ── Lo que preimprime la imprenta abajo (art. 31; 13.4, 13.15, 13.16) ──
    if (!esRecibo && talonario !== null) {
      pdf.x = 48;
      pdf.moveDown(1);
      const ident = String(talonario["printer_identifier"] ?? "00");
      zonaPreimpresa([
        ...(talonario["printer_legal_name"]
          ? [
              `Imprenta: ${talonario["printer_legal_name"]}` +
                (talonario["printer_tax_id"]
                  ? ` · RIF ${vestirDocumento(talonario["printer_tax_id"])}`
                  : ""),
            ]
          : []),
        ...(talonario["printer_authorization"]
          ? [
              `Providencia ${talonario["printer_authorization"]} del ` +
                fechaLegible(talonario["printer_authorization_date"] ?? null),
            ]
          : []),
        `Control desde el N° ${vestirControl(ident, talonario["range_from"])} ` +
          `hasta el N° ${vestirControl(ident, talonario["range_to"])}`,
        ...(talonario["printed_on"]
          ? [`Fecha de elaboración: ${fechaLegible(talonario["printed_on"])}`]
          : []),
      ]);
    }

    // ── Pie ────────────────────────────────────────────────────────────────
    // Ninguna leyenda legal más que la de la copia (FC-28): la de homologación se borró (A-11).
    // El recibo de devolución de una empresa sin RIF lleva la suya (RESPUESTA A-06; el asesor
    // afina la redacción en P-16).
    const pie =
      doc["kind"] === "receipt_return"
        ? "Recibo de devolución · Documento no fiscal: no es factura ni nota de crédito y no otorga derecho a crédito fiscal"
        : esRecibo
          ? "Documento no fiscal — no es una factura. Generado por Ladino."
          : destino === "papel"
            ? null
            : "Generado por Ladino.";
    // FC-32: el PDF descargado o enviado NO es la factura (RESPUESTA §2.3), y lo dice en CADA
    // página (H1): una hoja suelta de una factura larga no puede pasar por el original.
    const marca =
      destino === "cortesia" && esFiscal
        ? `Copia de cortesía · ${KIND_NOMBRE[String(doc["kind"])]} válida es la impresa en forma ` +
          `libre con control N° ${control ?? "—"}`
        : null;
    const paginas = pdf.bufferedPageRange();
    // PA 00071 art. 33 (auditoría fiscal 2026-10-02): una factura, NC o ND sobre forma libre ocupa
    // UNA forma. El tope de líneas del dominio lo previene; esto es la defensa del papel (una
    // descripción larga ocupa varias filas). La cortesía sí puede tener varias páginas.
    // A-7: también si el cuerpo, tras la última zona, invade la franja del pie de la única página.
    const desbordaPie = pdf.y > pdf.page.height - MARGEN_PIE;
    if (destino === "papel" && esFiscal && (paginas.count > 1 || desbordaPie)) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message:
          `Este documento no cabe en una forma libre (ocupa ${Math.max(paginas.count, 2)} páginas): cada factura, ` +
          "nota de crédito o nota de débito ocupa una sola (PA 00071 art. 33). Imprime la copia de " +
          "cortesía y divide la venta en varios documentos.",
      });
    }
    for (let i = paginas.start; i < paginas.start + paginas.count; i++) {
      pdf.switchToPage(i);
      // Escribir en la franja reservada sin que pdfkit abra otra página.
      pdf.page.margins.bottom = 0;
      if (marca !== null) {
        pdf
          .font("Helvetica-Bold")
          .fontSize(8)
          .fillColor("#1d4ed8")
          .text(marca, 48, 708, { width: 516, align: "center" });
      }
      if (pie !== null) {
        pdf
          .font("Helvetica")
          .fontSize(8)
          .fillColor("#666666")
          .text(pie, 48, 732, { width: 516, align: "center" });
      }
      pdf.page.margins.bottom = MARGEN_PIE;
    }

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

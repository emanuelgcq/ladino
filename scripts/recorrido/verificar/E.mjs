/**
 * Bloque E · Vender. Comprobaciones de `pnpm recorrido E` (ver `_app.mjs`).
 *
 * E-04 (ADR-0073, PA 00071 art. 13.10 y 13.11): la factura discrimina base e IVA por alícuota, con
 * su porcentaje. Antes el pie decía «Subtotal» e «IVA» sin porcentaje. Con E-10 (FC-31): las
 * columnas de la línea van sin IVA.
 * E-18 (ADR-0073 §4, LIVA art. 18.1): la cesta básica del escenario queda EXENTA
 * (corregir-escenario-post.sql) y el catálogo trae el literal con su cita.
 */
import { inflateSync } from "node:zlib";
import { comprobaciones, pedir, pedirBytes, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";
import { textoDe, tiene, idDocumento } from "./_pdf.mjs";

const c = comprobaciones("E");

/** Infla los streams del PDF y decodifica los <hex> de los TJ (como en los E2E). */
function textoDelPdf(bruto) {
  let texto = "";
  let i = 0;
  for (;;) {
    const s = bruto.indexOf("stream", i);
    if (s === -1) break;
    let inicio = s + 6;
    if (bruto[inicio] === 0x0d) inicio++;
    if (bruto[inicio] === 0x0a) inicio++;
    const fin = bruto.indexOf("endstream", inicio);
    if (fin === -1) break;
    const trozo = bruto.subarray(inicio, fin);
    try {
      texto += inflateSync(trozo).toString("latin1");
    } catch {
      texto += trozo.toString("latin1");
    }
    i = fin + 9;
  }
  return [...texto.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map((m) => Buffer.from(m[1], "hex").toString("latin1"))
    .join("");
}

c.caso(
  "E-04",
  "el PDF de la factura A-1 de E2 dice «Base imponible 16 %» e «IVA 16 %»",
  async () => {
    const [doc] = await sql`
    select id from public.documents
     where company_id = ${EMPRESAS.E2} and kind = 'invoice' and series = 'A'
       and document_number = 1`;
    afirmar(doc, "no está la factura A-1 de E2");
    const r = await pedirBytes(PERSONAS.duenoE2E3, "E2", `/v1/documents/${doc.id}/pdf`);
    afirmar(r.status === 200, `PDF: ${r.status}`);
    const texto = textoDelPdf(r.bytes);
    afirmar(texto.includes("Base imponible 16 %:"), "falta «Base imponible 16 %:»");
    afirmar(texto.includes("IVA 16 %:"), "falta «IVA 16 %:»");
    afirmar(texto.includes("Total sin IVA"), "la columna del total no dice «sin IVA» (E-10)");
  },
);

c.caso(
  "E-18",
  "la harina de E1 y la de E2 están EXENTAS, y el literal 18.1.d trae su cita",
  async () => {
    const filas = await sql`
    select name, tax_category_code from public.products
     where company_id in (${EMPRESAS.E1}, ${EMPRESAS.E2}) and name ilike 'harina%'`;
    afirmar(filas.length >= 2, `harinas encontradas: ${filas.length}`);
    for (const f of filas)
      afirmar(f.tax_category_code === "exento", `${f.name}: ${f.tax_category_code}`);
    const [lit] = await sql`
    select description, source_status from public.tax_exemption_literals where code = '18.1.d'`;
    afirmar(/harina/i.test(lit?.description ?? ""), `18.1.d: ${lit?.description}`);
    afirmar(lit.source_status === "fuente_secundaria", `18.1.d: ${lit.source_status}`);
  },
);

c.caso(
  "E-18",
  "vender la harina de E2 hoy resuelve IVA 0 con la cita de la LIVA arts. 17-19",
  async () => {
    const [r] = await sql`
    select rate::text as rate, legal_source
      from platform.resolve_tax(${EMPRESAS.E2}, (now() at time zone 'America/Caracas')::date,
                                'VE', 'iva', 'ordinario', 'exento')`;
    afirmar(r?.rate === "0.00000000", `exento: ${r?.rate}`);
    afirmar(/arts\. 17/.test(r.legal_source), `cita: ${r.legal_source}`);
  },
);

// ── E-01 / E-17 (ADR-0071): la serie la dicta el talonario ─────────────────────────────────────
// E3 registró su talonario en serie B y la caja facturaba siempre en «A» (sales.ts:1329). Los
// talonarios del escenario nacieron antes de ADR-0071, sin los datos de la imprenta: el dueño los
// completa (una vez) y la caja emite en B. Re-ejecutable: si ya están completos, no los toca.
const E3 = EMPRESAS.E3;
const IMPRENTA_E3 = {
  printer_legal_name: "Gráficas Lara, C.A.",
  printer_tax_id: "J-12345678-9",
  printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
  printer_authorization_date: "2020-01-15",
  printed_on: "2026-09-01",
};

async function facturaE3(series) {
  // Emitir necesita la tasa BCV del día. Si la base local no la trae (el volcado es del 24/09, o
  // un E2E borró las «BCV…»), se siembra la del escenario SOLO si falta. Solo base local.
  await sql`
    insert into public.exchange_rates
      (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
    select 'USD', 'VES', 854.46, 'BCV', (now() at time zone 'America/Caracas')::date, now()
     where not exists (
       select 1 from public.exchange_rates
        where from_currency = 'USD' and to_currency = 'VES'
          and rate_date = (now() at time zone 'America/Caracas')::date)`;
  const [w] = await sql`select id from public.warehouses where company_id = ${E3} limit 1`;
  const [p] = await sql`
    select sb.product_id from public.stock_balances sb
      join public.products pr on pr.id = sb.product_id
     where sb.company_id = ${E3} and sb.quantity > 1 and pr.status = 'active'
       and pr.name ilike 'tornillo%'
     limit 1`;
  const [cl] = await sql`
    select id from public.customers where company_id = ${E3} and not is_system
     order by legal_name limit 1`;
  afirmar(w && p && cl, "E3 no trae depósito, tornillos con existencia o un cliente");
  return pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/invoices", {
    company_id: E3,
    customer_id: cl.id,
    warehouse_id: w.id,
    ...(series === undefined ? {} : { series }),
    lines: [{ product_id: p.product_id, quantity: "1" }],
  });
}

c.caso("E-01", "E3 completa su talonario B y la caja emite en serie B", async () => {
  const [b] = await sql`
    select id, printer_data_complete from public.fiscal_number_ranges
     where company_id = ${E3} and series = 'B' and status = 'active'
     order by range_from limit 1`;
  afirmar(b, "E3 no tiene el talonario B activo");
  if (!b.printer_data_complete) {
    const r = await pedir(
      PERSONAS.duenoE2E3,
      "E3",
      "POST",
      `/v1/fiscal-number-ranges/${b.id}/printer`,
      { company_id: E3, ...IMPRENTA_E3 },
    );
    afirmar(r.status === 200, `completar: ${r.status} ${r.texto.slice(0, 200)}`);
  }
  const f = await facturaE3("B");
  afirmar(f.status === 201, `facturar en B: ${f.status} ${f.texto.slice(0, 200)}`);
  afirmar(f.json?.series === "B", `la factura salió en serie ${f.json?.series}`);
  afirmar(f.json?.control_identifier === "00", `identificador ${f.json?.control_identifier}`);
});

c.caso(
  "E-01",
  "sin datos de imprenta no se registra un talonario: 422 que dice qué falta",
  async () => {
    const r = await pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/fiscal-number-ranges", {
      company_id: E3,
      series: "C",
      range_from: "20001",
      range_to: "21000",
      printer_source: "Imprenta autorizada",
    });
    afirmar(r.status === 422, `esperaba 422, llegó ${r.status}`);
    afirmar(
      /Sin los datos de la imprenta no se registra el talonario/.test(r.json?.message ?? ""),
      `mensaje: ${r.json?.message}`,
    );
  },
);

c.caso("E-17", "sin talonario para la serie pedida: 409 en palabras de persona", async () => {
  const r = await facturaE3("SIN-TALONARIO");
  afirmar(r.status === 409, `esperaba 409, llegó ${r.status}`);
  afirmar(
    r.json?.message ===
      "No quedan números de control para facturas (identificador 00). Carga el talonario nuevo.",
    `mensaje: ${r.json?.message}`,
  );
});

// ── Ola 2 · el control impreso y la copia de cortesía (ADR-0071 §4; RESPUESTA §2.1, §2.3) ─
c.caso(
  "ADR-0071",
  "la factura A-1 de E2: la cortesía lo dice, el papel deja en blanco lo preimpreso, la vista lo sombrea",
  async () => {
    const id = await idDocumento("E2", "invoice", "A", 1);
    afirmar(id, "no está la factura A-1 de E2");
    const [d] =
      await sql`select control_identifier || '-' || lpad(control_number::text, 8, '0') as c
                          from public.documents where id = ${id}`;
    const cortesia = await textoDe(PERSONAS.duenoE2E3, "E2", id);
    afirmar(
      tiene(
        cortesia.texto,
        `Copia de cortesía · La factura válida es la impresa en forma libre con control N° ${d.c}`,
      ),
      "falta la marca de cortesía con el control",
    );
    const papel = await textoDe(PERSONAS.duenoE2E3, "E2", id, "destino=papel");
    afirmar(
      !tiene(papel.texto, "preimpreso en la forma libre") && !/RIF: J-/.test(papel.texto),
      "el papel imprime encima de lo preimpreso (RIF del emisor)",
    );
    afirmar(
      tiene(papel.texto, `N° de control: ${d.c}`),
      "el control no va en el cuerpo (ajuste por omisión encendido)",
    );
    const vista = await textoDe(PERSONAS.duenoE2E3, "E2", id, "destino=vista");
    afirmar(
      tiene(vista.texto, "preimpreso en la forma libre"),
      "la vista previa no sombrea lo preimpreso",
    );
  },
);

c.caso(
  "ADR-0071",
  "el diálogo de impresión: el servidor da el control ya vestido (Próximo control)",
  async () => {
    const id = await idDocumento("E2", "invoice", "A", 1);
    // El LISTADO, no el detalle: el detalle calcula el saldo de HOY y pide la tasa de hoy, que el
    // escenario restaurado no tiene.
    const r = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "GET",
      "/v1/documents?kind=invoice&per_page=100",
    );
    afirmar(r.status === 200, `listado: ${r.status} ${r.texto.slice(0, 200)}`);
    const fila = (r.json?.items ?? []).find((x) => x.id === id);
    afirmar(fila, "la factura A-1 no está en el listado");
    afirmar(
      /^\d{2}-\d{8}$/.test(fila.control_display ?? ""),
      `control_display: ${fila.control_display}`,
    );
  },
);

c.caso(
  "E-24",
  "la documentación sitúa la «(E)» en el numeral 8 y el adquirente en el 7 (G.O. 39.795)",
  async () => {
    const fs = await import("node:fs");
    const doc = fs.readFileSync(
      new URL("../../../docs/02_COMPLIANCE/EMISION_FACTURAS.md", import.meta.url),
      "utf8",
    );
    afirmar(
      /\| 13\.8 \| Descripción con cantidad y monto, y marcador \*\*«\(E\)»\*\*/.test(doc),
      "la (E) no está en el 13.8",
    );
    afirmar(/\| 13\.7 \| Adquirente/.test(doc), "el adquirente no está en el 13.7");
    const pdf = fs.readFileSync(
      new URL("../../../apps/api/src/routes/documents-pdf.ts", import.meta.url),
      "utf8",
    );
    afirmar(
      !/\(E\)[^\n]*13\.9|13\.9[^\n]*\(E\)/.test(pdf),
      "el código sigue citando la (E) en el 13.9",
    );
  },
);

// ── E-16: la pantalla de IGTF recibe el tipo VIGENTE de la empresa de la sesión ──
c.caso(
  "E-16",
  "GET /v1/companies da E3 como especial: /admin/igtf dice «eres especial y no percibes»",
  async () => {
    const r = await pedir(PERSONAS.duenoE2E3, "E3", "GET", "/v1/companies");
    afirmar(r.status === 200, `dio ${r.status}`);
    const e3 = (r.json ?? []).find((e) => e.id === EMPRESAS.E3);
    afirmar(e3?.taxpayer_type_code === "especial", JSON.stringify(e3?.taxpayer_type_code));
  },
);

export default c.correr;

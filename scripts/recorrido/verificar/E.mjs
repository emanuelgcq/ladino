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
import fsMonedaB from "node:fs";
import { textoDe, tiene, idDocumento } from "./_pdf.mjs";
import { pedir as pedirIgtf, EMPRESAS as EMP_IGTF, PERSONAS as PER_IGTF } from "./_app.mjs";
import { textoDe as textoIgtf, tiene as tieneIgtf } from "./_pdf.mjs";
import * as v0076 from "./_app.mjs";
import * as monedaA from "./_moneda.mjs";

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
  // R-82.1: la factura de administración nace fiada; el cliente necesita su límite.
  await monedaA.conLimiteDeFiado("E3", E3, cl.id);
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

// ── IGTF del especial (ADR-0072 §2; RESPUESTA §2.6) ─────────────────────────────────────────
/** Una venta de caja de E3 con 1,03 USD por Zelle (1 a la venta, 0,03 de IGTF) y el resto fiado. */
async function ventaZelleIgtfE3() {
  const E3i = EMP_IGTF.E3;
  await sql`
    insert into public.exchange_rates
      (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
    select 'USD', 'VES', 854.46, 'BCV', (now() at time zone 'America/Caracas')::date, now()
     where not exists (
       select 1 from public.exchange_rates
        where from_currency = 'USD' and to_currency = 'VES'
          and rate_date = (now() at time zone 'America/Caracas')::date)`;
  const [w] = await sql`select id from public.warehouses where company_id = ${E3i} limit 1`;
  const [p] = await sql`
    select sb.product_id from public.stock_balances sb
      join public.products pr on pr.id = sb.product_id
     where sb.company_id = ${E3i} and sb.quantity > 1 and pr.status = 'active'
       and pr.name ilike 'tornillo%'
     limit 1`;
  const [cl] = await sql`
    select id from public.customers where company_id = ${E3i} and not is_system
       and status <> 'blocked' order by legal_name limit 1`;
  afirmar(w && p && cl, "E3 no trae depósito, tornillos con existencia o un cliente");
  // E-09: el tornillo vale más que el USD 1,03 que se paga por Zelle, así que el resto de la
  // venta queda FIADO (deuda de verdad, documento `issued`). Fiar exige que el cliente tenga
  // límite: lo fija el dueño por el camino real, una vez. Es una ENTRADA del guion.
  const [lim] = await sql`
    select credit_limit_usd = 100000 as fijado from public.customers where id = ${cl.id}`;
  if (!lim.fijado) {
    const fija = await pedirIgtf(
      PER_IGTF.duenoE2E3,
      "E3",
      "PUT",
      `/v1/customers/${cl.id}/credit-limit`,
      { company_id: E3i, credit_limit_usd: "100000" },
    );
    afirmar(fija.status === 200, `fijar el límite de fiado: ${fija.status} ${fija.texto}`);
  }
  const r = await pedirIgtf(PER_IGTF.duenoE2E3, "E3", "POST", "/v1/pos/sales", {
    company_id: E3i,
    customer_id: cl.id,
    warehouse_id: w.id,
    lines: [{ product_id: p.product_id, quantity: "1" }],
    // P-05: el abono deja saldo, y una venta que deja saldo dice cuándo se paga (entrada del
    // guion: el día de Caracas más 15, nunca toISOString()).
    due_date: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(
      new Date(Date.now() + 15 * 86_400_000),
    ),
    payments: [{ instrument: "zelle", currency: "USD", amount: "1.03" }],
  });
  afirmar(r.status === 201, `venta de caja de E3: ${r.status} ${r.texto}`);
  return r.json;
}

c.caso(
  "E-02",
  "E3, especial, percibe sin activar nada: el estado y el aviso de la caja lo dicen",
  async () => {
    const st = await pedirIgtf(PER_IGTF.duenoE2E3, "E3", "GET", "/v1/igtf/status");
    afirmar(st.status === 200 && st.json.perceiving === true, `E3 no percibe: ${st.texto}`);
    const av = await pedirIgtf(
      PER_IGTF.duenoE2E3,
      "E3",
      "GET",
      "/v1/pos/igtf?amount=10.00&currency=USD&instrument=zelle",
    );
    afirmar(av.json?.applies === true && av.json.amount === "0.30000000", `aviso: ${av.texto}`);
  },
);

c.caso(
  "E-03",
  "la factura de una venta de caja de E3 por Zelle imprime alícuota y monto del IGTF",
  async () => {
    const v = await ventaZelleIgtfE3();
    afirmar(v.payments[0].igtf?.amount === "0.03000000", "la venta no percibió 0,03");
    for (const q of ["", "?destino=papel", "?destino=vista"]) {
      const { status, texto: t } = await textoIgtf(PER_IGTF.duenoE2E3, "E3", v.document.id, q);
      afirmar(status === 200, `PDF ${q || "cortesía"}: ${status}`);
      afirmar(
        tieneIgtf(t, "IGTF 3 % sobre USD 1,00 pagados en divisas: USD 0,03"),
        `falta el IGTF en ${q || "cortesía"}`,
      );
    }
  },
);

// E-12 (ola 3): ninguna tabla con tenant_id deja a ladino_api con `true` (las siete del hallazgo y
// cualquiera que venga). La consulta del REPRODUCIR, restringida a tablas con tenant_id.
c.caso("E-12", "cero policies de ladino_api con true en tablas con tenant_id", async () => {
  const filas = await sql`
    select p.tablename, p.cmd from pg_policies p
     where p.schemaname = 'public' and 'ladino_api' = any (p.roles)
       and (p.qual = 'true' or p.with_check = 'true')
       and exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = p.tablename
                      and c.column_name = 'tenant_id')`;
  afirmar(filas.length === 0, filas.map((f) => `${f.tablename}/${f.cmd}`).join(", "));
});

// ── ADR-0076 · de quién es la cuenta (E-08) ─────────────────────────────────────────────────
c.caso(
  "E-08 (ADR-0076)",
  "la cuenta del dueño se ve en la caja del cajero con autor y hora, en solo lectura; el administrativo la gestiona (el encargado no: §2.8)",
  async () => {
    const id = crypto.randomUUID();
    const crear = await v0076.pedir(v0076.PERSONAS.duenoE2E3, "E2", "PUT", `/v1/pos/carts/${id}`, {
      company_id: v0076.EMPRESAS.E2,
      label: "Cuenta del dueño",
      customer_id: null,
      lines: [],
      station_id: crypto.randomUUID(),
    });
    v0076.afirmar(crear.status === 200, `el PUT del dueño dio ${crear.status}`);
    try {
      const delCajero = await v0076.pedir(v0076.PERSONAS.cajero, "E2", "GET", "/v1/pos/carts");
      const vista = delCajero.json.items.find((x) => x.id === id);
      v0076.afirmar(vista, "el cajero no ve la cuenta");
      v0076.afirmar(vista.editable === false, "para el cajero no es de solo lectura");
      v0076.afirmar(vista.created_by && vista.created_at, "no dice autor y hora");
      const pisar = await v0076.pedir(v0076.PERSONAS.cajero, "E2", "PUT", `/v1/pos/carts/${id}`, {
        company_id: v0076.EMPRESAS.E2,
        label: "Secuestrada",
        customer_id: null,
        lines: [],
      });
      v0076.afirmar(pisar.status === 403, `el cajero la pisó: ${pisar.status}`);
      const borrar = await v0076.pedir(
        v0076.PERSONAS.cajero,
        "E2",
        "DELETE",
        `/v1/pos/carts/${id}`,
      );
      v0076.afirmar(borrar.status === 403, `el cajero la borró: ${borrar.status}`);
      const delAdministrativo = await v0076.pedir(
        v0076.PERSONAS.administrativo,
        "E2",
        "GET",
        "/v1/pos/carts",
      );
      v0076.afirmar(
        delAdministrativo.json.items.find((x) => x.id === id)?.editable === true,
        "el administrativo no la gestiona",
      );
    } finally {
      await v0076.pedir(v0076.PERSONAS.duenoE2E3, "E2", "DELETE", `/v1/pos/carts/${id}`);
    }
  },
);

// ── ADR-0077 §2 (E-15, A-10): con documentos, «Cambiar el RIF» manda a la corrección ────────────
c.caso(
  "E-15",
  "E2 con facturas: cambiar el RIF dice «Corregir RIF» y «Crear otra empresa», no una salida falsa",
  async () => {
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "PUT", "/v1/companies/tax-id", {
      tax_id: "J-40555123-7",
    });
    afirmar(r.status === 422, `PUT /v1/companies/tax-id dio ${r.status}`);
    const m = r.json?.message ?? "";
    afirmar(m.includes("«Corregir RIF»"), `no nombra la corrección: ${m}`);
    afirmar(m.includes("art. 13.5 de la PA 00071"), `sin el aviso del dueño: ${m}`);
    afirmar(m.includes("«Crear otra empresa»"), `no nombra la otra empresa: ${m}`);
  },
);

// E-11 (ADR-0075 §6, familia «moneda B»): la línea de caja de un hecho en divisa guarda su moneda, su
// importe original y su tasa. Se mira en lo ya asentado después del arreglo: ninguna línea de una
// subcuenta de caja EN DIVISA escrita por el generador desde el acta de regularización está en
// VES/identidad (las de un asiento manual o de la revaluación al cierre sí pueden: no mueven dólares).
c.caso(
  "E-11",
  "desde la regularización, ningún cobro, pago, gasto o cierre en divisa se asienta como bolívares",
  async () => {
    for (const e of ["E1", "E2", "E3"]) {
      const [corte] = await sql`
        select max(occurred_at) as desde from public.audit_events
         where company_id = ${EMPRESAS[e]} and event_type = 'treasury.currency_regularized'`;
      const malas = await sql`
        select en.source_kind, en.entry_number
          from public.journal_lines l
          join public.journal_entries en on en.id = l.entry_id
          join public.company_accounts ca
            on ca.company_id = l.company_id and ca.ledger_account_id = l.account_id
          join public.companies co on co.id = l.company_id
         where l.company_id = ${EMPRESAS[e]}
           and ca.currency <> co.functional_currency_code
           and l.transaction_currency = co.functional_currency_code
           and en.source_kind in ('payment_received', 'payment_made', 'expense', 'cash_closing',
                                  'cash_closing_overdraft', 'igtf_perception', 'customer_refund', 'treasury_transfer')
           and en.created_at > coalesce(${corte?.desde ?? null}::timestamptz, 'infinity')`;
      afirmar(
        malas.length === 0,
        `${e}: ${malas.map((m) => `${m.source_kind} #${m.entry_number}`).join(", ")}`,
      );
    }
  },
);

c.caso("E-11", "el generador toma el original de platform.treasury_original_of", async () => {
  const gen = fsMonedaB.readFileSync("packages/domain/src/journal-generator.ts", "utf8");
  afirmar(gen.includes("platform.treasury_original_of"), "el generador no lee el importe original");
  const [f] = await sql`
    select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform' and p.proname = 'treasury_original_of'`;
  afirmar(f.n === 1, "falta platform.treasury_original_of");
});

// ── Moneda A (ADR-0075 §1) ───────────────────────────────────────────────────
c.caso(
  "E-05",
  "una factura nueva de E2 en USD: el IVA en Bs es la alícuota de la base en Bs, línea por línea",
  async () => {
    const { doc, importes } = await monedaA.ventaUsdCobradaEnBs();
    const lineas = await monedaA.sql`
      select line_subtotal_functional::text as base,
             (line_total_functional - line_subtotal_functional)::text as iva,
             round(line_subtotal_functional * tax_rate_snapshot, 2)::text as esperado,
             round(line_subtotal_transaction * fx_rate, 2)::text as base_esperada
        from public.document_lines where document_id = ${doc.id}`;
    monedaA.afirmar(lineas.length > 0, "la factura no tiene líneas");
    for (const l of lineas) {
      monedaA.afirmar(
        Number(l.base) === Number(l.base_esperada),
        `base ${l.base} ≠ ${l.base_esperada}`,
      );
      monedaA.afirmar(
        Number(l.iva) === Number(l.esperado),
        `IVA ${l.iva} ≠ ${l.esperado} (alícuota × base)`,
      );
    }
    const suma = lineas.reduce((a, l) => a + Math.round(Number(l.iva) * 100), 0);
    monedaA.afirmar(
      suma === Math.round(Number(importes.iva) * 100),
      `el pie (${importes.iva}) no suma sus líneas`,
    );
  },
);

c.caso(
  "E-05",
  "fiscal_amount_gaps = 0 en E1, E2 y E3: lo emitido desde el corte cumple la regla",
  async () => {
    await monedaA.ventaUsdCobradaEnBs();
    for (const e of Object.values(monedaA.EMPRESAS)) {
      const filas = await monedaA.sql`select * from platform.fiscal_amount_gaps(${e})`;
      monedaA.afirmar(filas.length === 0, `${filas.length} hueco(s): ${JSON.stringify(filas[0])}`);
    }
  },
);

// ── Moneda X, «el cobro y el cierre» (ADR-0075 §1-4, nota de aplicación) ─────
/** La factura de E2 en USD de `_moneda.mjs`, con su línea: producto, cantidad y cliente. */
async function ventaConSuLinea() {
  const { doc, importes } = await monedaA.ventaUsdCobradaEnBs();
  const [l] = await monedaA.sql`
    select l.product_id, l.quantity::text as quantity, d.customer_id,
           (select w.id from public.warehouses w where w.company_id = d.company_id limit 1)
             as warehouse_id
      from public.document_lines l join public.documents d on d.id = l.document_id
     where l.document_id = ${doc.id} order by l.line_number limit 1`;
  monedaA.afirmar(l, "la factura de E2 no tiene línea");
  return { importes, linea: l };
}

c.caso(
  "E-05",
  "la caja cotiza en Bs EXACTAMENTE lo que la factura emitida dice: base, IVA y total",
  async () => {
    const { importes, linea } = await ventaConSuLinea();
    const q = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/pos/quote", {
      company_id: monedaA.E2,
      customer_id: linea.customer_id,
      lines: [{ product_id: linea.product_id, quantity: linea.quantity }],
    });
    monedaA.afirmar(q.status === 200, `cotizar: ${q.status} ${q.texto.slice(0, 300)}`);
    const caja = {
      base: q.json.functional_subtotal,
      iva: q.json.functional_tax_amount,
      total: q.json.functional_total,
      usd: q.json.total,
    };
    const factura = {
      base: importes.base,
      iva: importes.iva,
      total: importes.total,
      usd: importes.usd,
    };
    monedaA.afirmar(
      JSON.stringify(caja) === JSON.stringify(factura),
      `la caja dice ${JSON.stringify(caja)} y la factura ${JSON.stringify(factura)}`,
    );
  },
);

c.caso(
  "E-05",
  "pagar en Bs el total de la factura el mismo día la cierra en cero exacto, sin diferencial",
  async () => {
    const { linea } = await ventaConSuLinea();
    // R-82.1: la factura de administración nace fiada; el cliente necesita su límite.
    await monedaA.conLimiteDeFiado("E2", monedaA.E2, linea.customer_id);
    const f = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/invoices", {
      company_id: monedaA.E2,
      customer_id: linea.customer_id,
      warehouse_id: linea.warehouse_id,
      lines: [{ product_id: linea.product_id, quantity: linea.quantity }],
    });
    monedaA.afirmar(f.status === 201, `emitir en E2: ${f.status} ${f.texto.slice(0, 300)}`);
    const [d] = await monedaA.sql`
      select total_amount::text as total, amount_transaction_currency::text as usd,
             (select functional_today::text from platform.document_debt(${monedaA.E2}, d.id)) as deuda
        from public.documents d where d.id = ${f.json.id}`;
    monedaA.afirmar(
      Number(d.deuda) === Number(d.total),
      `la deuda del día (${d.deuda}) no es el total en Bs de la factura (${d.total})`,
    );
    const banco = await monedaA.bancoBsE2();
    const cobro = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/payments", {
      company_id: monedaA.E2,
      document_id: f.json.id,
      currency: "VES",
      amount: d.total,
      instrument: "transferencia",
      account_id: banco.id,
    });
    monedaA.afirmar(cobro.status === 201, `cobrar: ${cobro.status} ${cobro.texto.slice(0, 300)}`);
    monedaA.afirmar(
      cobro.json.document_status === "paid" && cobro.json.exchange_difference === null,
      `quedó ${cobro.json.document_status} con diferencial ${JSON.stringify(cobro.json.exchange_difference)}`,
    );
    const [p] = await monedaA.sql`
      select settled_transaction_amount::text as saldado from public.payments
       where id = ${cobro.json.payment.id}`;
    monedaA.afirmar(p.saldado === d.usd, `saldó ${p.saldado} USD de ${d.usd}`);
    const abierto = await monedaA.abiertoEnMayor("ar", f.json.id);
    monedaA.afirmar(
      abierto === null || Number(abierto) === 0,
      `el mayor todavía le carga ${abierto} a la factura`,
    );
  },
);

// ── Ola 4 · la caja: E-07, E-09, E-13 y E-14 ────────────────────────────────
const VENDER_TSX = "apps/web/src/pages/negocio/Vender.tsx";

c.caso(
  "E-07",
  "la tarjeta de la cuadrícula enseña el precio de la lista del cliente, el mismo que cobra el carrito",
  async () => {
    const [m] = await sql`
      select cu.id as cliente, i.product_id, i.amount::text as precio
        from public.customers cu
        join public.price_list_items i on i.price_list_id = cu.default_price_list_id
         and i.effective_from <= now() and (i.effective_to is null or i.effective_to > now())
        join public.products p on p.id = i.product_id and p.status = 'active'
         and p.system_code is null
       where cu.company_id = ${EMPRESAS.E2} and cu.default_price_list_id is not null
         and not cu.is_system
       order by cu.created_at, i.effective_from desc limit 1`;
    afirmar(m, "E2 no tiene un cliente con lista preferida y precio en ella");
    const base = "/v1/products?only_active=1&with_price=1&with_stock=1&per_page=100";
    const r = await pedir(PERSONAS.cajero, "E2", "GET", `${base}&customer_id=${m.cliente}`);
    afirmar(r.status === 200, `cuadrícula del cliente: ${r.status} ${r.texto.slice(0, 200)}`);
    const tarjeta = r.json.items.find((i) => i.id === m.product_id);
    afirmar(tarjeta, "el producto de la lista del cliente no sale en la cuadrícula");
    const q = await pedir(PERSONAS.cajero, "E2", "POST", "/v1/pos/quote", {
      company_id: EMPRESAS.E2,
      customer_id: m.cliente,
      lines: [{ product_id: m.product_id, quantity: "1" }],
    });
    afirmar(q.status === 200, `cotizar: ${q.status} ${q.texto.slice(0, 200)}`);
    afirmar(
      tarjeta.price_amount === q.json.lines[0].unit_price,
      `la tarjeta dice ${tarjeta.price_amount} y el carrito cobra ${q.json.lines[0].unit_price}`,
    );
    const pantalla = fsMonedaB.readFileSync(VENDER_TSX, "utf8");
    afirmar(pantalla.includes("&customer_id="), "la caja no pide la cuadrícula por cliente");
    afirmar(pantalla.includes("Precio de mostrador"), "falta el rótulo «Precio de mostrador»");
  },
);

c.caso(
  "E-09",
  "el cajero fía, no fija límites; un cliente con límite 0 no se fía y el rechazo no deja documento",
  async () => {
    const roles = await sql`
      select r.key, rp.permission_key from public.role_permissions rp
        join public.roles r on r.id = rp.role_id and r.tenant_id is null
       where rp.permission_key in ('sales.credit', 'customers.credit.set')`;
    const tiene = (rol, permiso) =>
      roles.some((x) => x.key === rol && x.permission_key === permiso);
    afirmar(tiene("cashier", "sales.credit"), "el cajero no tiene sales.credit");
    afirmar(!tiene("cashier", "customers.credit.set"), "el cajero fija límites de fiado");
    afirmar(
      tiene("back_office", "customers.credit.set") && tiene("owner", "customers.credit.set"),
      "ni el administrativo ni el dueño fijan límites",
    );

    // Un cliente nuevo, creado por el cajero: nace en 0, y el cajero no le sube el límite.
    const alta = await pedir(PERSONAS.cajero, "E2", "POST", "/v1/customers", {
      company_id: EMPRESAS.E2,
      tax_id: `V${String(Date.now()).slice(-8)}`,
      legal_name: "Cliente de la comprobación E-09",
      person_type_code: "natural",
    });
    afirmar(alta.status === 201, `alta del cliente: ${alta.status} ${alta.texto.slice(0, 200)}`);
    afirmar(
      alta.json.credit_limit_usd === "0.00000000",
      `nació con límite ${alta.json.credit_limit_usd}`,
    );
    const sube = await pedir(
      PERSONAS.cajero,
      "E2",
      "PUT",
      `/v1/customers/${alta.json.id}/credit-limit`,
      { company_id: EMPRESAS.E2, credit_limit_usd: "1000" },
    );
    afirmar(sube.status === 403, `el cajero fijó el límite: ${sube.status}`);
    afirmar(
      sube.json.message.includes("customers.credit.set"),
      `el 403 no nombra el permiso: ${sube.json.message}`,
    );

    // Fiarle una venta: 409 con el mensaje del límite, y ni un documento.
    const { linea } = await ventaConSuLinea();
    const fiar = await pedir(PERSONAS.cajero, "E2", "POST", "/v1/pos/sales", {
      company_id: EMPRESAS.E2,
      warehouse_id: linea.warehouse_id,
      customer_id: alta.json.id,
      lines: [{ product_id: linea.product_id, quantity: "1" }],
    });
    afirmar(
      fiar.status === 409,
      `fiar a un cliente con límite 0: ${fiar.status} ${fiar.texto.slice(0, 300)}`,
    );
    afirmar(
      fiar.json.code === "CREDIT_LIMIT_EXCEEDED" &&
        fiar.json.message.includes("límite de fiado es 0"),
      `rechazó por otra cosa: ${fiar.texto.slice(0, 300)}`,
    );
    const [docs] = await sql`
      select count(*)::int as n from public.documents where customer_id = ${alta.json.id}`;
    afirmar(docs.n === 0, `el rechazo dejó ${docs.n} documento(s)`);

    // El administrativo lo fija, y queda el acta con el antes y el después.
    const fija = await pedir(
      PERSONAS.administrativo,
      "E2",
      "PUT",
      `/v1/customers/${alta.json.id}/credit-limit`,
      { company_id: EMPRESAS.E2, credit_limit_usd: "25" },
    );
    afirmar(
      fija.status === 200,
      `el administrativo no pudo fijarlo: ${fija.status} ${fija.texto.slice(0, 200)}`,
    );
    const [acta] = await sql`
      select payload->>'credit_limit_usd_anterior' as antes,
             payload->>'credit_limit_usd_nuevo' as despues
        from public.audit_events
       where aggregate_id = ${alta.json.id} and event_type = 'customer.credit_limit_set'`;
    afirmar(
      acta && acta.antes === "0.00000000" && acta.despues === "25.00000000",
      `el acta dice ${JSON.stringify(acta)}`,
    );
    // Ningún límite distinto de 0 sin su acta, en toda la base.
    const [sinActa] = await sql`
      select count(*)::int as n from public.customers cu
       where cu.credit_limit_usd <> 0
         and not exists (select 1 from public.audit_events a
                          where a.aggregate_id = cu.id
                            and a.event_type = 'customer.credit_limit_set')`;
    afirmar(sinActa.n === 0, `${sinActa.n} cliente(s) con límite y sin acta`);
    // La caja lo dice antes.
    const q = await pedir(PERSONAS.cajero, "E2", "POST", "/v1/pos/quote", {
      company_id: EMPRESAS.E2,
      customer_id: alta.json.id,
      lines: [{ product_id: linea.product_id, quantity: "1" }],
    });
    afirmar(
      q.status === 200 && q.json.credit && q.json.credit.limit_usd === "25.00",
      `la cotización no dice el fiado: ${q.texto.slice(0, 300)}`,
    );
    const pantalla = fsMonedaB.readFileSync(VENDER_TSX, "utf8");
    afirmar(pantalla.includes("pos-fiado-cerrado"), "la caja no dice por qué no se puede fiar");
  },
);

c.caso(
  "E-13",
  "el ajuste «vender sin existencia» no se lee ni se ofrece; la caja ofrece la llegada rápida",
  async () => {
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "GET", "/v1/company-settings");
    afirmar(r.status === 200, `ajustes: ${r.status}`);
    afirmar(
      !("block_sale_without_stock" in r.json),
      "los ajustes todavía ofrecen block_sale_without_stock",
    );
    for (const fichero of [
      VENDER_TSX,
      "packages/domain/src/company-settings.ts",
      "packages/schemas/src/negocio.ts",
    ]) {
      const texto = fsMonedaB.readFileSync(fichero, "utf8");
      const usos = texto
        .split("\n")
        .filter((l) => l.includes("block_sale_without_stock") && !/^\s*(\*|\/\/|\/\*)/.test(l));
      afirmar(usos.length === 0, `${fichero} todavía usa el ajuste: ${usos[0]}`);
    }
    const pantalla = fsMonedaB.readFileSync(VENDER_TSX, "utf8");
    afirmar(
      pantalla.includes("Registrar llegada rápida") && pantalla.includes("/admin/llego-mercancia"),
      "la caja no ofrece «Registrar llegada rápida»",
    );
  },
);

c.caso(
  "E-14",
  "la caja pregunta si el J es contribuyente especial; cambiarlo después exige permiso",
  async () => {
    const textos = fsMonedaB.readFileSync("apps/web/src/components/capa-fiscal/textos.ts", "utf8");
    afirmar(
      textos.includes("¿Es contribuyente especial (retiene IVA)?"),
      "falta la pregunta en textos.ts",
    );
    const pantalla = fsMonedaB.readFileSync(VENDER_TSX, "utf8");
    afirmar(
      pantalla.includes("CLIENTE_ESPECIAL.pregunta") &&
        pantalla.includes("const [especial, setEspecial] = useState(false)"),
      "la caja no pregunta por el contribuyente especial con «no» por defecto",
    );
    const ficha = fsMonedaB.readFileSync("apps/web/src/pages/clientes/Clientes.tsx", "utf8");
    afirmar(
      ficha.includes("/taxpayer-type") && ficha.includes("Lista de precios preferida"),
      "la ficha no deja cambiar la clasificación ni la lista preferida",
    );
    const [j] = await sql`
      select id, taxpayer_type_code from public.customers
       where company_id = ${EMPRESAS.E2} and person_type_code = 'juridica' and not is_system
       order by created_at limit 1`;
    afirmar(j, "E2 no tiene un cliente jurídico");
    const r = await pedir(PERSONAS.cajero, "E2", "PUT", `/v1/customers/${j.id}/taxpayer-type`, {
      company_id: EMPRESAS.E2,
      taxpayer_type_code: j.taxpayer_type_code === "especial" ? "ordinario" : "especial",
    });
    afirmar(r.status === 403, `el cajero cambió la clasificación: ${r.status}`);
    const [igual] = await sql`
      select taxpayer_type_code from public.customers where id = ${j.id}`;
    afirmar(igual.taxpayer_type_code === j.taxpayer_type_code, "la clasificación cambió");
  },
);

// E-22 / P-05 (ola 4): el fiado tiene vencimiento. La caja lo exige al fiar, el documento lo
// lleva y el papel de una venta con saldo lo dice (migración 20261004210000).
c.caso(
  "E-22",
  "fiar por la caja sin fecha → 422 y ningún documento; con fecha → el papel dice A CRÉDITO, el saldo y «Vence»",
  async () => {
    const enDias = (n) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(
        new Date(Date.now() + n * 86_400_000),
      );
    const alta = await pedir(PERSONAS.cajero, "E2", "POST", "/v1/customers", {
      company_id: EMPRESAS.E2,
      tax_id: `V${String(Date.now() + 22).slice(-8)}`,
      legal_name: "Cliente de la comprobación E-22",
      person_type_code: "natural",
      fiscal_address: "Av. Lara, Barquisimeto",
    });
    afirmar(alta.status === 201, `alta del cliente: ${alta.status} ${alta.texto.slice(0, 200)}`);
    const fija = await pedir(
      PERSONAS.administrativo,
      "E2",
      "PUT",
      `/v1/customers/${alta.json.id}/credit-limit`,
      { company_id: EMPRESAS.E2, credit_limit_usd: "100000" },
    );
    afirmar(fija.status === 200, `fijar el límite: ${fija.status} ${fija.texto.slice(0, 200)}`);

    const { linea } = await ventaConSuLinea();
    const venta = (extra) =>
      pedir(PERSONAS.cajero, "E2", "POST", "/v1/pos/sales", {
        company_id: EMPRESAS.E2,
        warehouse_id: linea.warehouse_id,
        customer_id: alta.json.id,
        lines: [{ product_id: linea.product_id, quantity: "1" }],
        ...extra,
      });
    const documentos = async () =>
      (
        await sql`select count(*)::int as n from public.documents
                   where customer_id = ${alta.json.id}`
      )[0].n;

    const sinFecha = await venta({});
    afirmar(
      sinFecha.status === 422 && sinFecha.json.message.includes("Di cuándo paga el cliente"),
      `fiar sin fecha: ${sinFecha.status} ${sinFecha.texto.slice(0, 300)}`,
    );
    afirmar((await documentos()) === 0, "el rechazo por falta de fecha dejó un documento");
    const pasada = await venta({ due_date: enDias(-1) });
    afirmar(
      pasada.status === 422 && pasada.json.message.includes("anterior al día de la venta"),
      `fiar con fecha pasada: ${pasada.status} ${pasada.texto.slice(0, 300)}`,
    );
    afirmar((await documentos()) === 0, "el rechazo por fecha pasada dejó un documento");

    const vence = enDias(15);
    const fiada = await venta({ due_date: vence });
    afirmar(fiada.status === 201, `fiar con fecha: ${fiada.status} ${fiada.texto.slice(0, 300)}`);
    afirmar(
      fiada.json.document.due_date === vence,
      `el documento no lleva la fecha: ${fiada.json.document.due_date}`,
    );
    const ddmmaaaa = `${vence.slice(8, 10)}/${vence.slice(5, 7)}/${vence.slice(0, 4)}`;
    const papel = await textoDe(PERSONAS.cajero, "E2", fiada.json.document.id);
    afirmar(papel.status === 200, `el PDF dio ${papel.status}`);
    afirmar(tiene(papel.texto, "A CRÉDITO"), "el papel de la venta fiada no dice «A CRÉDITO»");
    afirmar(tiene(papel.texto, "Saldo pendiente:"), "el papel no dice el saldo pendiente");
    afirmar(tiene(papel.texto, `Vence: ${ddmmaaaa}`), `el papel no dice «Vence: ${ddmmaaaa}»`);

    // Una venta pagada no dice nada de eso (la de `_moneda.mjs`, cobrada entera).
    const [pagada] = await sql`
      select d.id from public.documents d
       where d.company_id = ${EMPRESAS.E2} and d.kind in ('invoice', 'receipt')
         and d.status = 'paid'
       order by d.issued_at desc limit 1`;
    afirmar(pagada, "E2 no tiene ninguna venta pagada");
    const contado = await textoDe(PERSONAS.duenoE2E3, "E2", pagada.id);
    afirmar(contado.status === 200, `el PDF de la pagada dio ${contado.status}`);
    afirmar(
      !tiene(contado.texto, "A CRÉDITO") && !tiene(contado.texto, "Saldo pendiente:"),
      "el papel de una venta pagada dice que es a crédito",
    );
  },
);

// ── Ola 5 · E-06 (ADR-0081): «Compartir» es la hoja del navegador; WhatsApp no se repone ──
c.caso(
  "E-06",
  "«Venta lista» comparte el PDF solo donde el navegador puede, y la documentación lo dice así",
  async () => {
    const fs = await import("node:fs");
    const leer = (ruta) => fs.readFileSync(new URL(`../../../${ruta}`, import.meta.url), "utf8");
    const vender = leer("apps/web/src/pages/negocio/Vender.tsx");
    afirmar(
      /\{puedeCompartir && \(/.test(vender) && vender.includes("compartirPdf("),
      "«Venta lista» no ofrece «Compartir» condicionado a lo que el navegador puede",
    );
    afirmar(!/wa\.me|api\.whatsapp|whatsapp:\/\//i.test(vender), "la caja enlaza a WhatsApp");
    const compartir = leer("apps/web/src/compartir.ts");
    afirmar(
      /canShare\(\{ files:/.test(compartir) && /\.share\(\{ files:/.test(compartir),
      "compartir.ts no comparte el PDF como archivo por la hoja del navegador",
    );
    const doc = leer("docs/02_COMPLIANCE/EMISION_FACTURAS.md");
    const fila = doc.split("\n").find((l) => l.startsWith("| Entrega por medio digital"));
    afirmar(fila, "EMISION_FACTURAS.md no tiene la fila «Entrega por medio digital»");
    afirmar(!/WhatsApp desde el POS/.test(doc), "la documentación da WhatsApp por construido");
    afirmar(/«Compartir»/.test(fila), "la fila no nombra «Compartir»");
    afirmar(/hoja de compartir/.test(fila), "la fila no dice que es la hoja del navegador");
    afirmar(/no se repone/.test(fila), "la fila no dice que el botón de WhatsApp no se repone");
  },
);

export default c.correr;

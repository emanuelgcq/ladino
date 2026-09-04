/**
 * Semilla HTTP de la demo: rangos, tasas, plan contable y documentos reales
 * creados POR LA API (misma vía que la webapp). Requiere la API en :3000 y el
 * SQL de seed-demo.sql ya aplicado.
 *
 * ⚠ `pnpm verify` la BORRA: su paso 10 es `db:reset`. Es lo correcto —el gate
 * reconstruye la base desde cero— y por eso esta semilla vive en el repo y se
 * relanza con `pnpm demo:seed` después de cada verify si se quiere volver a
 * mirar la webapp con datos. Usuario demo: demo@ladino.dev / LadinoDemo2026!
 */
const SUPA = "http://127.0.0.1:54321";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const API = "http://127.0.0.1:3000";
const EMAIL = "demo@ladino.dev";
const PASS = "LadinoDemo2026!";
const COMPANY = "deade001-0000-4000-8000-0000000000c0";
const CLI = {
  espiga: "deade001-0000-4000-8000-0000000000b1",
  caroni: "deade001-0000-4000-8000-0000000000b2",
  andes: "deade001-0000-4000-8000-0000000000b3",
};
const PROD = {
  harina: "deade001-0000-4000-8000-0000000000d1",
  cafe: "deade001-0000-4000-8000-0000000000d2",
  arroz: "deade001-0000-4000-8000-0000000000d3",
  azucar: "deade001-0000-4000-8000-0000000000d4",
  aceite: "deade001-0000-4000-8000-0000000000d5",
  pasta: "deade001-0000-4000-8000-0000000000d6",
};
const ALMACEN = "deade001-0000-4000-8000-0000000000a1";

const hoy = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const ayer = new Date(hoy.getTime() - 86_400_000);

async function auth() {
  let r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  if (!r.ok) {
    const s = await fetch(`${SUPA}/auth/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    });
    if (!s.ok) throw new Error(`signup: ${s.status} ${await s.text()}`);
    r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    });
    if (!r.ok) throw new Error(`login tras signup: ${r.status} ${await r.text()}`);
  }
  const j = await r.json();
  return j.access_token;
}

let TOKEN = "";
async function api(metodo, path, body, ok = [200, 201]) {
  const r = await fetch(`${API}${path}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "X-Company-Id": COMPANY,
      ...(metodo === "GET" ? {} : { "Idempotency-Key": crypto.randomUUID() }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (!ok.includes(r.status)) {
    console.log(`  !! ${metodo} ${path} -> ${r.status}`, JSON.stringify(j).slice(0, 220));
    return null;
  }
  return j;
}

const paso = (m) => console.log(`== ${m}`);

const token = await auth();
TOKEN = token;
paso("autenticado");

// ¿Ya sembrado? (idempotencia de la parte HTTP)
const docs = await api("GET", "/v1/documents?per_page=1");
if (docs !== null && docs.total > 0) {
  console.log("ya hay documentos: semilla HTTP omitida");
  process.exit(0);
}

paso("rango de numeración");
await api("POST", "/v1/fiscal-number-ranges", {
  company_id: COMPANY,
  kind: "invoice",
  series: "A",
  range_from: "1",
  range_to: "5000",
  printer_source: "Imprenta Gráficas Miranda C.A. — autorización demo",
});

paso("tasas BCV (ayer y hoy)");
for (const [d, rate] of [
  [ayer, "119.35000000"],
  [hoy, "125.50000000"],
]) {
  await api("POST", "/v1/exchange-rates", {
    from_currency: "USD",
    to_currency: "VES",
    rate,
    source: "BCV",
    rate_date: iso(d),
  });
}

paso("plan contable + mapeo");
await api("POST", "/v1/accounts/import-template", {
  company_id: COMPANY,
  template_code: "ve_basico",
});
await api("POST", "/v1/journal-templates/import-preset", {
  company_id: COMPANY,
  preset_code: "ve_basico",
});

paso("facturas VES de hoy");
const facturas = [];
for (const f of [
  {
    c: CLI.espiga,
    lines: [
      { product_id: PROD.harina, quantity: "24" },
      { product_id: PROD.arroz, quantity: "12" },
    ],
  },
  {
    c: CLI.caroni,
    lines: [
      { product_id: PROD.cafe, quantity: "6" },
      { product_id: PROD.azucar, quantity: "10" },
      { product_id: PROD.aceite, quantity: "4" },
    ],
  },
  { c: CLI.espiga, lines: [{ product_id: PROD.pasta, quantity: "30" }] },
  {
    c: CLI.caroni,
    lines: [
      { product_id: PROD.harina, quantity: "50" },
      { product_id: PROD.aceite, quantity: "12" },
    ],
  },
  {
    c: CLI.espiga,
    lines: [
      { product_id: PROD.azucar, quantity: "8" },
      { product_id: PROD.cafe, quantity: "2" },
    ],
  },
]) {
  const doc = await api("POST", "/v1/invoices", {
    company_id: COMPANY,
    customer_id: f.c,
    warehouse_id: ALMACEN,
    lines: f.lines,
  });
  if (doc !== null) facturas.push(doc);
}

paso("factura USD de AYER (Mayorista USD, tasa 119.35 — la deuda se ancla en USD, ADR-0047)");
const usd = await api("POST", "/v1/invoices", {
  company_id: COMPANY,
  customer_id: CLI.andes,
  warehouse_id: ALMACEN,
  issued_at: `${iso(ayer)}T15:30:00.000Z`,
  lines: [
    { product_id: PROD.harina, quantity: "24" },
    { product_id: PROD.cafe, quantity: "12" },
  ],
});

paso("cobros");
if (usd !== null) {
  // Se cobra HOY los USD completos: la deuda está anclada en USD (ADR-0047)
  // y el diferencial —(24×0.75 + 12×1.40) × 1.16 = 40.368 USD × (125.50 −
  // 119.35)— lo calcula y asienta el servidor.
  await api("POST", "/v1/payments", {
    company_id: COMPANY,
    document_id: usd.id,
    currency: "USD",
    amount: "40.36800000",
    instrument: "zelle",
    reference: "ZLL-88412",
  });
}
if (facturas[0] !== undefined) {
  await api("POST", "/v1/payments", {
    company_id: COMPANY,
    document_id: facturas[0].id,
    currency: "VES",
    amount: "1500.00000000",
    instrument: "punto_venta",
    reference: "PV-002913",
  });
}

paso("una cotización y una anulación, para que el listado tenga estados");
await api("POST", "/v1/quotes", {
  company_id: COMPANY,
  customer_id: CLI.caroni,
  lines: [{ product_id: PROD.aceite, quantity: "20" }],
});
if (facturas[4] !== undefined) {
  await api("POST", `/v1/invoices/${facturas[4].id}/annul`, {
    company_id: COMPANY,
    reason: "Error de digitación en la cantidad — se reemplaza por la factura correcta",
  });
}

console.log("SEED HTTP OK ·", facturas.length + 1, "facturas");

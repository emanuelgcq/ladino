import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { fiadoDeFixture } from "./_fiado-de-fixture.js";
import { borrarTasasOficiales, sembrarTasaOficial } from "./_tasa-oficial.js";

/**
 * LA CHECKLIST QUE SE PRUEBA (RESPUESTA 2026-09-24 §2.1-2.4, Ola 0 punto 6(b); ADR-0071):
 * `docs/02_COMPLIANCE/FACTURA_CHECKLIST.md` recorrida sobre el PDF REAL de cada clase de
 * documento —factura, nota de crédito, nota de débito, recibo y recibo de devolución—, leyendo el
 * TEXTO del PDF como lo leería un fiscal, en tres empresas equivalentes a las del escenario:
 *
 *   · ESP — con RIF, contribuyente especial, factura en USD (13.14 y la tasa de la nota, FC-26);
 *   · ORD — con RIF, ordinaria, factura en Bs, y el control APAGADO en el cuerpo
 *     (`print_control_number = false`);
 *   · SIN — sin RIF (marcador `PEND-`): recibo y recibo de devolución (A-06, G-03).
 *
 * El PDF tiene tres destinos (ADR-0071 §4):
 *   · cortesía (por omisión: el que se descarga o se envía) — lo muestra todo y lleva la marca
 *     «Copia de cortesía · La factura válida es la impresa en forma libre con control N° …»;
 *   · `?destino=papel` — se imprime SOBRE la forma libre: lo que la imprenta preimprime (art. 31)
 *     queda en blanco;
 *   · `?destino=vista` — la vista previa en pantalla: lo preimpreso, sombreado y rotulado
 *     «preimpreso en la forma libre».
 *
 * Cada FC que no aplica a una clase queda anotado con su razón. Lo que depende del contribuyente
 * especial (FC-27, IGTF impreso, PA 000013 art. 6) queda `todo` con referencia a E-03.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const HOY_IMPRESO = `${HOY.slice(8, 10)}/${HOY.slice(5, 7)}/${HOY.slice(0, 4)}`;
const FUENTE_TASA = `BCV e2e-checklist-${RUN}`;
const USUARIO = crypto.randomUUID();
const ROL = crypto.randomUUID();

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;

/** Nueve dígitos aleatorios: los RIF del fixture no chocan entre corridas. */
const nueveDigitos = (): string => String(Math.floor(Math.random() * 1e9)).padStart(9, "0");

interface Empresa {
  clave: "ESP" | "ORD" | "SIN";
  tenant: string;
  company: string;
  warehouse: string;
  cliente: string;
  rif: string; // normalizado, o el marcador PEND-
  prod: { general: string; exento: string };
  moneda: "VES" | "USD";
}

const EMP: Record<Empresa["clave"], Empresa> = {
  ESP: {
    clave: "ESP",
    tenant: crypto.randomUUID(),
    company: crypto.randomUUID(),
    warehouse: crypto.randomUUID(),
    cliente: crypto.randomUUID(),
    rif: `J${nueveDigitos()}`,
    prod: { general: "", exento: "" },
    moneda: "USD",
  },
  ORD: {
    clave: "ORD",
    tenant: crypto.randomUUID(),
    company: crypto.randomUUID(),
    warehouse: crypto.randomUUID(),
    cliente: crypto.randomUUID(),
    rif: `J${nueveDigitos()}`,
    prod: { general: "", exento: "" },
    moneda: "VES",
  },
  SIN: {
    clave: "SIN",
    tenant: crypto.randomUUID(),
    company: crypto.randomUUID(),
    warehouse: crypto.randomUUID(),
    cliente: crypto.randomUUID(),
    rif: `PEND-${RUN.toUpperCase()}`,
    prod: { general: "", exento: "" },
    moneda: "VES",
  },
};

const IMPRENTA = {
  printer_legal_name: "Imprenta Checklist, C.A.",
  printer_tax_id: "J-12345678-9",
  printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000777",
  printer_authorization_date: "2020-01-15",
  printed_on: "2026-09-01",
};

const tokenDe = (sub: string) =>
  new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);

async function pedir(e: Empresa, metodo: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(USUARIO)}`,
    "X-Company-Id": e.company,
  };
  if (metodo !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await app.request(path, {
    method: metodo,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (process.env["LADINO_E2E_DEBUG"] === "1" && r.status >= 400) {
    // eslint-disable-next-line no-console
    console.log(metodo, path, r.status, await r.clone().text());
  }
  return r;
}

/**
 * El TEXTO del PDF: infla los streams y decodifica los <hex> de los TJ en WinAnsi (la
 * codificación de las fuentes estándar de pdfkit: «—», «·» y «°» salen como son). Sin
 * dependencias: la misma técnica de e2e-fiscal-legal y e2e-alicuotas.
 */
async function textoDelPdf(r: Response): Promise<string> {
  expect(r.status).toBe(200);
  const bruto = Buffer.from(await r.arrayBuffer());
  const { inflateSync } = await import("node:zlib");
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
  const win = new TextDecoder("windows-1252");
  return [...texto.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map((m) => win.decode(Buffer.from(m[1]!, "hex")))
    .join("");
}

/** Sin espacios: pdfkit parte las líneas largas y el espacio del corte desaparece. */
const plano = (s: string): string => s.replace(/\s+/g, "");
const tiene = (texto: string, aguja: string): boolean => plano(texto).includes(plano(aguja));

/** Los PDF de un documento en sus destinos. */
async function pdfs(
  e: Empresa,
  id: string,
): Promise<{ cortesia: string; papel: string; copia: string; vista: string }> {
  return {
    cortesia: await textoDelPdf(await pedir(e, "GET", `/v1/documents/${id}/pdf`)),
    papel: await textoDelPdf(await pedir(e, "GET", `/v1/documents/${id}/pdf?destino=papel`)),
    copia: await textoDelPdf(
      await pedir(e, "GET", `/v1/documents/${id}/pdf?destino=papel&copia=1`),
    ),
    vista: await textoDelPdf(await pedir(e, "GET", `/v1/documents/${id}/pdf?destino=vista`)),
  };
}

async function sembrarEmpresa(e: Empresa): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${USUARIO}, true)`;
    await tx`insert into public.tenants (id, name) values (${e.tenant}, ${`Checklist ${e.clave}`})`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name, fiscal_address,
                                           functional_currency_code, taxpayer_type_code)
             values (${e.company}, ${e.tenant}, ${e.rif}, ${`Checklist ${e.clave}, C.A.`},
                     ${`Av. Principal ${e.clave}, Barquisimeto`}, 'VES',
                     ${e.clave === "ESP" ? "especial" : "ordinario"})`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${e.warehouse}, ${e.tenant}, ${e.company}, ${`CHK-${e.clave}`}, 'Principal')`;
    // ADR-0072 §1: el tipo de contribuyente es una HISTORIA con vigencia; sin tipo vigente, una
    // empresa con RIF no factura. La empresa sin RIF no lo necesita.
    if (e.clave !== "SIN") {
      await tx`insert into public.company_taxpayer_types
                 (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason,
                  rules_version)
               values (${e.tenant}, ${e.company}, ${e.clave === "ESP" ? "especial" : "ordinario"},
                       (now() - interval '30 days')::date,
                       ${e.clave === "ESP" ? sql`(now() - interval '30 days')::date` : null},
                       'Fixture de la checklist', 'domain-s0.5')`;
    }
    const mem = crypto.randomUUID();
    const asig = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${mem}, ${e.tenant}, ${USUARIO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id)
             values (${asig}, ${e.tenant}, ${mem}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${e.tenant}, ${e.company}, ${asig}, 'warehouse', ${e.warehouse})`;
    await tx`insert into public.customers (id, tenant_id, company_id, legal_name,
                                           person_type_code, taxpayer_type_code, is_system)
             values (${crypto.randomUUID()}, ${e.tenant}, ${e.company}, 'Consumidor final',
                     'natural', 'consumidor_final', true)`;
    await tx`insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                                           person_type_code, taxpayer_type_code, fiscal_address)
             values (${e.cliente}, ${e.tenant}, ${e.company}, ${`J${nueveDigitos()}`},
                     ${`Cliente ${e.clave}`}, 'juridica', 'ordinario', 'Calle 8, Maracay')`;
    // R-82.1: la factura de administración nace fiada — la empresa de prueba declara que fía.
    await fiadoDeFixture(tx, e.company, [ROL]);
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${e.tenant}, ${e.company}, ${`chk-${RUN}`}, ${e.moneda}) returning id`;
    for (const [clave, categoria, nombre] of [
      ["general", "gravado_general", "Producto general"],
      ["exento", "exento", "Harina de maiz"],
    ] as const) {
      const [p] = await tx<{ id: string }[]>`
        insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                     tax_category_code)
        values (${e.tenant}, ${e.company}, ${`CHK-${e.clave}-${clave}-${RUN}`}, ${nombre},
                'service', 'active', 'unidad', ${categoria}) returning id`;
      e.prod[clave] = p!.id;
      await tx`insert into public.price_list_items
                 (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
               values (${e.tenant}, ${e.company}, ${l!.id}, ${p!.id}, 100, now() - interval '1 day')`;
    }
    await tx`update public.customers set default_price_list_id = ${l!.id} where id = ${e.cliente}`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${e.tenant}, ${e.company},
                     ${e.clave === "SIN" ? "sin_facturacion" : "formatos_libres"},
                     now() - interval '30 days')`;
  });
  if (e.clave === "SIN") return;
  expect((await pedir(e, "POST", "/v1/fiscal/iva-general", { rate: "0.16" })).status).toBe(201);
  const rango = await pedir(e, "POST", "/v1/fiscal-number-ranges", {
    company_id: e.company,
    series: "T",
    range_from: "1",
    range_to: "500",
    ...IMPRENTA,
  });
  expect(rango.status).toBe(201);
}

interface Emitidos {
  factura: string;
  nc: string;
  nd: string;
}
const DOCS: Partial<Record<"ESP" | "ORD", Emitidos>> = {};
let RECIBO = "";
let DEVOLUCION = "";
/** H1 y art. 33: una factura de ORD dentro del tope que, por sus descripciones, ocupa varias páginas. */
let LARGA = "";
let LARGO = "";
/** El «Consumidor final» de sistema de ORD. */
let CONSUMIDOR_ORD = "";
const NOMBRE_LARGO =
  "Servicio de mantenimiento preventivo y correctivo de equipos de refrigeración industrial " +
  "con reposición de piezas, calibración de termostatos, limpieza de condensadores y garantía";
/** H8: la NC de una devolución confirmada sobre una factura de ORD, y su motivo. */
let NC_DEVOLUCION = "";
const MOTIVO_DEVOLUCION = "El cliente devolvió la mercancía por defecto de fábrica";
/** H8: una ND «vieja», sin motivo guardado (simulada por SQL: dato anterior al motivo). */
let ND_VIEJA = "";
/** H2: una cotización de ORD: no es documento fiscal. */
let COTIZACION = "";

async function emitirFiscales(e: Empresa): Promise<Emitidos> {
  const f = await pedir(e, "POST", "/v1/invoices", {
    company_id: e.company,
    customer_id: e.cliente,
    warehouse_id: e.warehouse,
    series: "T",
    lines: [
      { product_id: e.prod.general, quantity: "2" },
      { product_id: e.prod.exento, quantity: "1" },
    ],
  });
  expect(f.status).toBe(201);
  const factura = ((await f.json()) as { id: string }).id;
  const lineasFactura = await sql<{ id: string }[]>`
    select id from public.document_lines where document_id = ${factura} order by line_number`;
  // H6: la NC acredita una línea gravada Y la exenta, para que FC-08 tenga qué marcar en la nota.
  const nc = await pedir(e, "POST", "/v1/credit-notes", {
    company_id: e.company,
    source_document_id: factura,
    reason: "Descuento por pronto pago acordado",
    lines: [
      { source_line_id: lineasFactura[0]!.id, quantity: "1" },
      { source_line_id: lineasFactura[1]!.id, quantity: "1" },
    ],
  });
  expect(nc.status).toBe(201);
  const nd = await pedir(e, "POST", "/v1/debit-notes", {
    company_id: e.company,
    source_document_id: factura,
    reason: "Diferencia de precio de la lista",
    lines: [{ product_id: e.prod.general, quantity: "1", unit_price: "10" }],
  });
  expect(nd.status).toBe(201);
  return {
    factura,
    nc: ((await nc.json()) as { document: { id: string } }).document.id,
    nd: ((await nd.json()) as { id: string }).id,
  };
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  // Un solo usuario hace todas las peticiones del fichero, y con el FC-27 real (E-03) pasa de las
  // 300 por minuto del límite por omisión: el fichero prueba el papel, no el límite (que tiene su
  // propio test), así que se le da holgura explícita.
  app = buildApp({
    sql: sqlApi,
    auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER },
    rateLimitPorMinuto: 1000,
  });
  await sql`insert into auth.users (id) values (${USUARIO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${USUARIO}, true)`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2echk_dueno_${RUN}`}, 'Dueño', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'tax.rules.manage'),
             (${ROL}, 'fiscal.range.manage'),
             (${ROL}, 'sales.invoice.issue'),
             (${ROL}, 'sales.return.manage'),
             (${ROL}, 'sales.credit_note.direct'),
             (${ROL}, 'sales.payment.register'),
             (${ROL}, 'company.settings.manage'),
             (${ROL}, 'inventory.move'),
             (${ROL}, 'ar.read'),
             (${ROL}, 'sales.quote.manage'),
             (${ROL}, 'fiscal.contingency.manage')`;
  });
  await sembrarTasaOficial(sql, { rate: "40", rate_date: HOY, source: FUENTE_TASA });
  for (const e of Object.values(EMP)) await sembrarEmpresa(e);

  // ORD apaga el control en el cuerpo ANTES de emitir: el ajuste manda en el papel.
  const ajuste = await pedir(EMP.ORD, "PUT", "/v1/company-settings", {
    print_control_number: false,
  });
  expect(ajuste.status).toBe(200);

  DOCS.ESP = await emitirFiscales(EMP.ESP);
  DOCS.ORD = await emitirFiscales(EMP.ORD);

  // H1, A-3 y A-4: quince líneas con una descripción de 200 caracteres cada una NO caben en una
  // forma libre (A-2: el tope cuenta filas). Una factura de CONTINGENCIA las registra igual,
  // porque refleja un papel que ya existe (A-3: ni el tope ni el adquirente aplican), y va al
  // «Consumidor final»: es la «factura vieja» a la que A-4 tiene que poder hacerle su nota.
  const [largo] = await sql<{ id: string }[]>`
    insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                 tax_category_code)
    values (${EMP.ORD.tenant}, ${EMP.ORD.company}, ${`CHK-ORD-largo-${RUN}`}, ${NOMBRE_LARGO},
            'service', 'active', 'unidad', 'gravado_general') returning id`;
  await sql`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             select ${EMP.ORD.tenant}, ${EMP.ORD.company}, default_price_list_id, ${largo!.id}, 10,
                    now() - interval '1 day'
               from public.customers where id = ${EMP.ORD.cliente}`;
  LARGO = largo!.id;
  const contingencia = await pedir(EMP.ORD, "POST", "/v1/fiscal/contingency-ranges", {
    company_id: EMP.ORD.company,
    series: "contingencia-1",
    range_from: "1",
    range_to: "50",
    printer_source: "Imprenta de la checklist — talonario físico",
    reason: "Falla del proveedor de internet en el local",
    failure_started_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
  });
  expect(contingencia.status).toBe(201);
  const [mostrador] = await sql<{ id: string; lista: string }[]>`
    select cf.id, (select default_price_list_id from public.customers
                    where id = ${EMP.ORD.cliente}) as lista
      from public.customers cf where cf.company_id = ${EMP.ORD.company} and cf.is_system`;
  CONSUMIDOR_ORD = mostrador!.id;
  const larga = await pedir(EMP.ORD, "POST", "/v1/fiscal/contingency-invoices", {
    company_id: EMP.ORD.company,
    contingency_range_id: ((await contingencia.json()) as { id: string }).id,
    customer_id: mostrador!.id,
    warehouse_id: EMP.ORD.warehouse,
    price_list_id: mostrador!.lista,
    issued_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    lines: Array.from({ length: 15 }, () => ({ product_id: largo!.id, quantity: "1" })),
    paper_document_number: "1",
    paper_control_number: "1",
  });
  expect(larga.status).toBe(201);
  LARGA = ((await larga.json()) as { document: { id: string } }).document.id;

  // H8: una devolución confirmada sobre una factura: su NC imprime el motivo de la devolución.
  const [lineaLarga] = await sql<{ id: string }[]>`
    select id from public.document_lines where document_id = ${LARGA} and line_number = 1`;
  const devFactura = await pedir(EMP.ORD, "POST", "/v1/returns", {
    company_id: EMP.ORD.company,
    source_document_id: LARGA,
    warehouse_id: EMP.ORD.warehouse,
    reason: MOTIVO_DEVOLUCION,
    lines: [{ source_line_id: lineaLarga!.id, quantity: "1" }],
  });
  expect(devFactura.status).toBe(201);
  const devId = ((await devFactura.json()) as { id: string }).id;
  const devOk = await pedir(EMP.ORD, "POST", `/v1/returns/${devId}/confirm`, {});
  expect(devOk.status).toBe(200);
  NC_DEVOLUCION = ((await devOk.json()) as { credit_note_id: string }).credit_note_id;

  // H8: una ND con motivo, al que se le quita el motivo por SQL para simular un documento
  // anterior a que la nota lo guardara (base LOCAL de pruebas; nunca se hace con datos reales).
  const ndVieja = await pedir(EMP.ORD, "POST", "/v1/debit-notes", {
    company_id: EMP.ORD.company,
    source_document_id: LARGA,
    reason: "Motivo que se borrará",
    lines: [{ product_id: EMP.ORD.prod.general, quantity: "1", unit_price: "5" }],
  });
  expect(ndVieja.status).toBe(201);
  ND_VIEJA = ((await ndVieja.json()) as { id: string }).id;
  await sql`update public.documents set notes = null where id = ${ND_VIEJA}`;

  // H2: una cotización.
  const cot = await pedir(EMP.ORD, "POST", "/v1/quotes", {
    company_id: EMP.ORD.company,
    customer_id: EMP.ORD.cliente,
    lines: [{ product_id: EMP.ORD.prod.general, quantity: "1" }],
  });
  expect(cot.status).toBe(201);
  COTIZACION = ((await cot.json()) as { id: string }).id;

  // SIN: un recibo cobrado y su devolución (ADR-0061: recibo de devolución, no NC).
  const venta = await pedir(EMP.SIN, "POST", "/v1/pos/sales", {
    company_id: EMP.SIN.company,
    warehouse_id: EMP.SIN.warehouse,
    customer_id: EMP.SIN.cliente,
    lines: [{ product_id: EMP.SIN.prod.general, quantity: "2" }],
    payments: [{ instrument: "efectivo_bs", amount: "200.00000000", currency: "VES" }],
  });
  expect(venta.status).toBe(201);
  RECIBO = ((await venta.json()) as { document: { id: string } }).document.id;
  const [lr] = await sql<{ id: string }[]>`
    select id from public.document_lines where document_id = ${RECIBO}`;
  const borrador = await pedir(EMP.SIN, "POST", "/v1/returns", {
    company_id: EMP.SIN.company,
    source_document_id: RECIBO,
    warehouse_id: EMP.SIN.warehouse,
    reason: "El cliente devolvió uno",
    lines: [{ source_line_id: lr!.id, quantity: "1" }],
  });
  expect(borrador.status).toBe(201);
  const dev = ((await borrador.json()) as { id: string }).id;
  const confirmada = await pedir(EMP.SIN, "POST", `/v1/returns/${dev}/confirm`, {});
  expect(confirmada.status).toBe(200);
  DEVOLUCION = ((await confirmada.json()) as { credit_note_id: string }).credit_note_id;
}, 120_000);

afterAll(async () => {
  await borrarTasasOficiales(sql, FUENTE_TASA);
  await sql?.end();
  await sqlApi?.end();
});

/** Número y control del documento, como se imprimen. */
async function identidad(
  id: string,
): Promise<{ numero: string; impreso: string; control: string; total: string; fecha: string }> {
  const [d] = await sql<
    { series: string; n: number; ci: string; cn: number; total: string; fecha: string }[]
  >`
    select series, document_number::int as n, control_identifier as ci,
           control_number::int as cn, total_amount::text as total,
           to_char(issued_at at time zone 'America/Caracas', 'DD/MM/YYYY') as fecha
      from public.documents where id = ${id}`;
  return {
    numero: `${d!.series}-${String(d!.n).padStart(8, "0")}`,
    // PA 00071 arts. 26-27: con serie, «Serie T N° 00000001»; sin serie, solo «N° 00000001».
    impreso:
      d!.series === ""
        ? `N° ${String(d!.n).padStart(8, "0")}`
        : `Serie ${d!.series} N° ${String(d!.n).padStart(8, "0")}`,
    control: `${d!.ci}-${String(d!.cn).padStart(8, "0")}`,
    total: d!.total,
    fecha: d!.fecha,
  };
}

/** Un importe como lo viste el PDF (miles con punto, coma decimal, mínimo dos decimales). */
function vestido(exacto: string): string {
  const [e = "0", dRaw = ""] = exacto.split(".");
  let d = dRaw.replace(/0+$/, "");
  if (d.length < 2) d = d.padEnd(2, "0");
  return `${e.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${d}`;
}

/** H4: los VALORES que el documento debe imprimir, leídos de la base. */
async function valores(id: string): Promise<{
  subtotal: string;
  total: string;
  totalUsd: string;
  tasa: string;
  primeraLinea: string;
}> {
  const [v] = await sql<
    { subtotal: string; total: string; usd: string; tasa: string; primera: string }[]
  >`
    select (select sum(line_subtotal_functional) from public.document_lines
             where document_id = d.id)::text as subtotal,
           d.total_amount::text as total, d.amount_transaction_currency::text as usd,
           d.fx_rate::text as tasa,
           (select line_subtotal_functional from public.document_lines
             where document_id = d.id order by line_number limit 1)::text as primera
      from public.documents d where d.id = ${id}`;
  return {
    subtotal: v!.subtotal,
    total: v!.total,
    totalUsd: v!.usd,
    tasa: v!.tasa,
    primeraLinea: v!.primera,
  };
}

/** La tasa como la imprime el PDF: miles con punto, coma decimal, sin ceros de cola. */
function tasaVestida(exacto: string): string {
  const [e = "0", dRaw = ""] = exacto.split(".");
  const d = dRaw.replace(/0+$/, "");
  const miles = e.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return d === "" ? miles : `${miles},${d}`;
}

const rifImpreso = (normalizado: string): string =>
  `${normalizado[0]}-${normalizado.slice(1, 9)}-${normalizado[9]}`;

for (const clave of ["ESP", "ORD"] as const) {
  const e = EMP[clave];
  const clases = [
    ["factura", "FACTURA"],
    ["nc", "NOTA DE CRÉDITO"],
    ["nd", "NOTA DE DÉBITO"],
  ] as const;

  for (const [clase, denominacion] of clases) {
    describe(`${clave} · ${clase} · FACTURA_CHECKLIST sobre el PDF real`, () => {
      it("FC-01/FC-21 · denominación · FC-02 número · FC-06 fecha en 8 dígitos", async () => {
        const id = DOCS[clave]![clase];
        const { cortesia, papel } = await pdfs(e, id);
        const yo = await identidad(id);
        for (const t of [cortesia, papel]) {
          expect(t).toContain(denominacion);
          expect(t).toContain(yo.impreso);
          expect(tiene(t, `Fecha de emisión: ${HOY_IMPRESO}`)).toBe(true);
        }
      });

      it("FC-03/FC-29 · el control, registrado y mostrado con su identificador; FC-32 · la marca de cortesía", async () => {
        const id = DOCS[clave]![clase];
        const yo = await identidad(id);
        expect(yo.control).toMatch(/^00-\d{8}$/);
        const { cortesia } = await pdfs(e, id);
        expect(
          tiene(
            cortesia,
            `Copia de cortesía · ${clase === "factura" ? "La factura" : clase === "nc" ? "La nota de crédito" : "La nota de débito"} válida es la impresa en forma libre con control N° ${yo.control}`,
          ),
        ).toBe(true);
      });

      it("FC-18 · lo preimpreso por la imprenta (art. 31) queda EN BLANCO en el papel y SOMBREADO en la vista previa", async () => {
        const id = DOCS[clave]![clase];
        const yo = await identidad(id);
        const { papel, vista } = await pdfs(e, id);
        // En el papel: ni RIF del emisor, ni rango, ni datos de la imprenta, ni su providencia.
        expect(tiene(papel, rifImpreso(e.rif))).toBe(false);
        expect(tiene(papel, IMPRENTA.printer_legal_name)).toBe(false);
        expect(tiene(papel, IMPRENTA.printer_authorization)).toBe(false);
        expect(tiene(papel, "hasta el N°")).toBe(false);
        expect(tiene(papel, "preimpreso en la forma libre")).toBe(false);
        // …pero sí lo que imprime Ladino: denominación, número, nombre y domicilio del emisor.
        expect(papel).toContain(yo.impreso);
        expect(tiene(papel, `Checklist ${clave}, C.A.`)).toBe(true);
        expect(tiene(papel, `Av. Principal ${clave}`)).toBe(true);
        // En la vista previa: rotulado.
        expect(tiene(vista, "preimpreso en la forma libre")).toBe(true);
        expect(tiene(vista, rifImpreso(e.rif))).toBe(true);
        expect(tiene(vista, yo.control)).toBe(true);
      });

      it("FC-04 rango · FC-15 imprenta y providencia · FC-16 fecha de elaboración: registrados, y en la cortesía y la vista", async () => {
        const id = DOCS[clave]![clase];
        const { cortesia, vista } = await pdfs(e, id);
        for (const t of [cortesia, vista]) {
          expect(tiene(t, "desde el N° 00-00000001 hasta el N° 00-00000500")).toBe(true);
          expect(tiene(t, IMPRENTA.printer_legal_name)).toBe(true);
          expect(tiene(t, "J-12345678-9")).toBe(true);
          expect(tiene(t, `${IMPRENTA.printer_authorization} del 15/01/2020`)).toBe(true);
          expect(tiene(t, "Fecha de elaboración: 01/09/2026")).toBe(true);
        }
      });

      it("FC-05/FC-30 · emisor con nombre, domicilio y RIF con guiones · FC-07 · adquirente con su RIF", async () => {
        const id = DOCS[clave]![clase];
        const { cortesia, papel } = await pdfs(e, id);
        expect(tiene(cortesia, `Checklist ${clave}, C.A.`)).toBe(true);
        expect(tiene(cortesia, `Av. Principal ${clave}, Barquisimeto`)).toBe(true);
        expect(tiene(cortesia, `RIF: ${rifImpreso(e.rif)}`)).toBe(true);
        expect(tiene(cortesia, `Cliente ${clave}`)).toBe(true);
        expect(cortesia).toMatch(/RIF\/C\.I\.: J-\d{8}-\d/);
        // H5: en el papel, lo mismo SALVO el RIF del emisor, que preimprime la imprenta (art. 31).
        expect(tiene(papel, `Checklist ${clave}, C.A.`)).toBe(true);
        expect(tiene(papel, `Av. Principal ${clave}, Barquisimeto`)).toBe(true);
        expect(tiene(papel, `RIF: ${rifImpreso(e.rif)}`)).toBe(false);
        expect(tiene(papel, `Cliente ${clave}`)).toBe(true);
        expect(papel).toMatch(/RIF\/C\.I\.: J-\d{8}-\d/);
      });

      it("FC-08 (E) · FC-10/FC-11 base e IVA por alícuota con porcentaje · FC-12 total · FC-31 columnas sin IVA", async () => {
        const id = DOCS[clave]![clase];
        const { cortesia, papel } = await pdfs(e, id);
        const v = await valores(id);
        for (const t of [cortesia, papel]) {
          expect(tiene(t, "IVA 16 %:")).toBe(true);
          expect(tiene(t, "Base imponible 16 %:")).toBe(true);
          expect(tiene(t, "P. unit. sin IVA")).toBe(true);
          expect(tiene(t, "Total sin IVA")).toBe(true);
          // H4: VALORES, no rótulos. Subtotal = Σ de la columna de totales sin IVA (FC-31).
          expect(tiene(t, `Subtotal: Bs. ${vestido(v.subtotal)}`)).toBe(true);
          expect(tiene(t, `TOTAL: Bs. ${vestido(v.total)}`)).toBe(true);
          // El total sin IVA de la primera línea, tal cual.
          expect(tiene(t, vestido(v.primeraLinea))).toBe(true);
          if (clase !== "nd") {
            // La factura y la NC llevan la exenta (H6): «(E)» en la línea y su total aparte.
            expect(tiene(t, "Harina de maiz (E)")).toBe(true);
            expect(tiene(t, "Exento (E):")).toBe(true);
          }
        }
        // La ND del fixture no lleva línea exenta: FC-08 no tiene qué marcar en ella.
      });

      it("FC-13 · «SIN DERECHO A CRÉDITO FISCAL» en la copia y no en el original · FC-17 · mismo control en los dos", async () => {
        const id = DOCS[clave]![clase];
        const yo = await identidad(id);
        const { papel, copia } = await pdfs(e, id);
        expect(copia).toContain("SIN DERECHO A CRÉDITO FISCAL");
        expect(papel).not.toContain("SIN DERECHO A CRÉDITO FISCAL");
        if (clave === "ESP") {
          // Con el ajuste encendido (por omisión), el control va en el CUERPO del original y de la copia.
          expect(tiene(papel, `N° de control: ${yo.control}`)).toBe(true);
          expect(tiene(copia, `N° de control: ${yo.control}`)).toBe(true);
        } else {
          // ORD lo apagó: el papel no lo imprime en el cuerpo (queda el preimpreso de la imprenta).
          expect(tiene(papel, yo.control)).toBe(false);
          expect(tiene(copia, yo.control)).toBe(false);
          // H3: ni el rótulo.
          expect(tiene(papel, "N° de control")).toBe(false);
          expect(tiene(copia, "N° de control")).toBe(false);
        }
      });

      it("FC-14 · en moneda extranjera, ambas cantidades, el total y el tipo de cambio", async () => {
        const id = DOCS[clave]![clase];
        const { cortesia } = await pdfs(e, id);
        if (clave === "ESP") {
          const v = await valores(id);
          expect(tiene(cortesia, `Total en dólares: USD ${vestido(v.totalUsd)}`)).toBe(true);
          expect(v.tasa).toBe("40.00000000");
          if (clase === "factura") {
            expect(tiene(cortesia, `Tasa BCV: ${tasaVestida(v.tasa)} (art. 13.14, PA 00071)`)).toBe(
              true,
            );
          }
        } else {
          // No aplica: ORD factura en bolívares, no hay moneda extranjera que mostrar.
          expect(tiene(cortesia, "Total en dólares")).toBe(false);
        }
      });

      it("FC-28 · ninguna leyenda de homologación ni cita de la PA 121", async () => {
        const id = DOCS[clave]![clase];
        for (const t of Object.values(await pdfs(e, id))) {
          expect(t.toLowerCase()).not.toContain("homolog");
          expect(t).not.toMatch(/000121|PA 121|VALIDAR-/);
        }
      });

      if (clase !== "factura") {
        it("FC-23 fecha, número y monto de la factura · FC-24 su control · FC-25 motivo, ajuste y porcentaje", async () => {
          const id = DOCS[clave]![clase];
          const fac = await identidad(DOCS[clave]!.factura);
          const yo = await identidad(id);
          const { cortesia, papel } = await pdfs(e, id);
          for (const t of [cortesia, papel]) {
            expect(tiene(t, `Factura que corrige: ${fac.impreso}`)).toBe(true);
            expect(tiene(t, `Control ${fac.control}`)).toBe(true);
            expect(tiene(t, `del ${fac.fecha}`)).toBe(true);
            expect(tiene(t, `por Bs. ${vestido(fac.total)}`)).toBe(true);
            expect(
              tiene(
                t,
                clase === "nc"
                  ? "Motivo: Descuento por pronto pago acordado"
                  : "Motivo: Diferencia de precio de la lista",
              ),
            ).toBe(true);
            expect(
              tiene(
                t,
                `Descripción del ajuste: ${clase === "nc" ? "crédito" : "débito"} de Bs. ${vestido(yo.total)} sobre la factura ${fac.impreso}`,
              ),
            ).toBe(true);
            expect(tiene(t, "IVA 16 %:")).toBe(true);
          }
        });

        it("FC-26 · a la tasa de la factura, impresa con su fecha", async () => {
          const id = DOCS[clave]![clase];
          const fac = await identidad(DOCS[clave]!.factura);
          const { cortesia } = await pdfs(e, id);
          if (clave === "ESP") {
            expect(
              tiene(cortesia, `Tasa BCV de la factura ${fac.impreso} del ${fac.fecha}: Bs 40`),
            ).toBe(true);
          } else {
            // No aplica: una nota en bolívares sobre una factura en bolívares no tiene tasa.
            expect(tiene(cortesia, "Tasa BCV")).toBe(false);
          }
        });
      }

      // FC-09 (recargos, descuentos y anulaciones de la factura): la factura del fixture no lleva
      // ninguno; en la NC y la ND el ajuste se describe con su valor (FC-25, arriba).
      // FC-19 (conservación de lo anulado, art. 36) y FC-20 (control único por emisor, art. 44) no
      // se miran en el PDF: los prueban el append-only de `documents` y el pgTAP 080.
      // FC-22 (la nota cumple el art. 13 salvo el numeral 1): es este mismo bloque, corrido sobre
      // la NC y la ND. FC-33 (anulación como ajuste): familia G-10, no esta entrega.
      it("FC-27 · el IGTF percibido por un SPE, con alícuota y monto (PA 000013 art. 6) — lo cierra E-03", async () => {
        if (clave === "ESP" && clase === "factura") {
          // La factura del cobro en la caja: 1 × 100 USD exento, cobrado por Zelle con su IGTF
          // dentro (103 USD). Imprime alícuota y monto, en divisa y en Bs a la tasa del cobro.
          const v = await pedir(e, "POST", "/v1/pos/sales", {
            company_id: e.company,
            customer_id: e.cliente,
            warehouse_id: e.warehouse,
            lines: [{ product_id: e.prod.exento, quantity: "1" }],
            payments: [{ instrument: "zelle", currency: "USD", amount: "103" }],
          });
          expect(v.status, await v.clone().text()).toBe(201);
          const id = ((await v.json()) as { document: { id: string } }).document.id;
          // Los tres destinos, sin la copia: este fichero vive cerca del límite de peticiones por
          // minuto (RATE_LIMIT_PER_MINUTE) y cada PDF cuenta.
          const destinos = await Promise.all(
            ["", "?destino=papel", "?destino=vista"].map(
              async (q) => await textoDelPdf(await pedir(e, "GET", `/v1/documents/${id}/pdf${q}`)),
            ),
          );
          for (const t of destinos) {
            expect(tiene(t, "IGTF 3 % sobre USD 100,00 pagados en divisas: USD 3,00")).toBe(true);
            expect(tiene(t, `Bs. 120,00 a la tasa del ${HOY_IMPRESO}`)).toBe(true);
          }
        } else {
          // No aplica: ORD no es agente de percepción, la NC no lleva IGTF (G-06) y la ND del
          // fixture es por diferencia de precio, no por IGTF (la ND por IGTF y su PDF los prueba
          // e2e-igtf-especial). Sin percepción no hay nada que imprimir: se mira el dato, no un
          // PDF más (el límite de peticiones por minuto de este fichero).
          const id = DOCS[clave]![clase];
          const [n] = await sql<{ n: number }[]>`
            select count(*)::int as n from public.igtf_perceptions
             where document_id = ${id} or debit_note_id = ${id}`;
          expect(n!.n).toBe(0);
        }
      });
    });
  }
}

describe("ORD · print_control_number apagado", () => {
  it("el ajuste se lee apagado, y la cortesía y la vista siguen mostrando el control (se registra siempre)", async () => {
    const r = await pedir(EMP.ORD, "GET", "/v1/company-settings");
    expect(((await r.json()) as { print_control_number: boolean }).print_control_number).toBe(
      false,
    );
    const yo = await identidad(DOCS.ORD!.factura);
    const { cortesia, vista } = await pdfs(EMP.ORD, DOCS.ORD!.factura);
    expect(tiene(cortesia, yo.control)).toBe(true);
    expect(tiene(vista, yo.control)).toBe(true);
  });

  it("ESP no lo tocó: por omisión, encendido", async () => {
    const r = await pedir(EMP.ESP, "GET", "/v1/company-settings");
    expect(((await r.json()) as { print_control_number: boolean }).print_control_number).toBe(true);
  });
});

describe("el diálogo de impresión: el servidor da «Próximo control»", () => {
  it("el documento trae su control ya vestido, 00-00000001", async () => {
    const r = await pedir(EMP.ESP, "GET", `/v1/documents/${DOCS.ESP!.factura}`);
    expect(r.status).toBe(200);
    const yo = await identidad(DOCS.ESP!.factura);
    expect(
      ((await r.json()) as { document: { control_display: string | null } }).document
        .control_display,
    ).toBe(yo.control);
  });
});

describe("SIN · recibo y recibo de devolución (A-06, G-03): documentos no fiscales", () => {
  // Del art. 13 no aplica NINGÚN FC: el recibo no es factura (EMISION_FACTURAS, ADR-0050). Lo
  // que se prueba es lo contrario: que no finja campos de factura.
  it("el recibo de devolución lleva su leyenda y no finge RIF, IVA ni providencia", async () => {
    const t = await textoDelPdf(await pedir(EMP.SIN, "GET", `/v1/documents/${DEVOLUCION}/pdf`));
    expect(
      tiene(
        t,
        "Recibo de devolución · Documento no fiscal: no es factura ni nota de crédito y no otorga derecho a crédito fiscal",
      ),
    ).toBe(true);
    expect(t).toContain("RECIBO DE DEVOLUCIÓN");
    expect(t).not.toContain("RECEIPT_RETURN");
    expect(t).not.toMatch(/P-END|PEND-|RIF:/);
    expect(t).not.toMatch(/IVA/);
    expect(t).not.toMatch(/PA 00071|art\. 13|providencia/i);
    expect(t.toLowerCase()).not.toContain("homolog");
  });

  it("el recibo de devolución no tiene copia fiscal: 422", async () => {
    const r = await pedir(EMP.SIN, "GET", `/v1/documents/${DEVOLUCION}/pdf?copia=1`);
    expect(r.status).toBe(422);
  });

  it("el recibo tampoco finge RIF ni providencia", async () => {
    const t = await textoDelPdf(await pedir(EMP.SIN, "GET", `/v1/documents/${RECIBO}/pdf`));
    expect(t).toContain("Documento no fiscal");
    expect(t).not.toMatch(/P-END|PEND-|RIF:/);
    expect(t).not.toMatch(/PA 00071|art\. 13/);
  });
});

describe("H1 · la marca de cortesía y el pie van en TODAS las páginas", () => {
  it("una factura que ocupa varias páginas: tantas marcas y pies como páginas", async () => {
    const r = await pedir(EMP.ORD, "GET", `/v1/documents/${LARGA}/pdf`);
    expect(r.status).toBe(200);
    const bytes = Buffer.from(await r.clone().arrayBuffer());
    const paginas = (bytes.toString("latin1").match(/\/Type \/Page(?!s)/g) ?? []).length;
    expect(paginas).toBeGreaterThan(1);
    const t = plano(await textoDelPdf(r));
    expect(t.split(plano("Copia de cortesía · La factura válida")).length - 1).toBe(paginas);
    expect(t.split(plano("Generado por Ladino.")).length - 1).toBe(paginas);
  });

  it("art. 33 · el papel la rechaza: una forma libre es UNA página (422 con el mensaje)", async () => {
    const r = await pedir(EMP.ORD, "GET", `/v1/documents/${LARGA}/pdf?destino=papel`);
    expect(r.status).toBe(422);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("VALIDATION_FAILED");
    expect(cuerpo.message).toMatch(
      /^Este documento no cabe en una forma libre \(ocupa \d+ páginas\): cada factura, nota de crédito o nota de débito ocupa una sola \(PA 00071 art\. 33\)\./,
    );
  });
});

describe("H2 · la marca de cortesía es solo de las clases fiscales", () => {
  it("la cotización imprime su PDF sin marca de cortesía ni forma libre", async () => {
    const t = await textoDelPdf(await pedir(EMP.ORD, "GET", `/v1/documents/${COTIZACION}/pdf`));
    expect(t).toContain("COTIZACIÓN");
    expect(tiene(t, "Copia de cortesía")).toBe(false);
    expect(tiene(t, "forma libre")).toBe(false);
  });
});

describe("H7 · el destino del PDF (decidido por criterio: menor sorpresa)", () => {
  it("?destino=cortesia explícito es lo mismo que sin destino", async () => {
    const t = await textoDelPdf(
      await pedir(EMP.ORD, "GET", `/v1/documents/${DOCS.ORD!.factura}/pdf?destino=cortesia`),
    );
    expect(tiene(t, "Copia de cortesía · La factura válida")).toBe(true);
  });

  it("?destino=impresora → 422 con el mensaje que dice los destinos válidos", async () => {
    const r = await pedir(
      EMP.ORD,
      "GET",
      `/v1/documents/${DOCS.ORD!.factura}/pdf?destino=impresora`,
    );
    expect(r.status).toBe(422);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("VALIDATION_FAILED");
    expect(cuerpo.message).toBe(
      "El destino del PDF es «cortesia», «papel» o «vista»; sin destino, la copia de cortesía.",
    );
  });
});

describe("H8 · el motivo de la nota sale del dato, nunca inventado", () => {
  it("la NC de una devolución confirmada imprime el motivo de la devolución", async () => {
    const t = await textoDelPdf(await pedir(EMP.ORD, "GET", `/v1/documents/${NC_DEVOLUCION}/pdf`));
    expect(t).toContain("NOTA DE CRÉDITO");
    expect(tiene(t, `Motivo: ${MOTIVO_DEVOLUCION}`)).toBe(true);
  });

  it("una nota sin motivo guardado imprime «Motivo: —»", async () => {
    const t = await textoDelPdf(await pedir(EMP.ORD, "GET", `/v1/documents/${ND_VIEJA}/pdf`));
    expect(tiene(t, "Motivo: —")).toBe(true);
    expect(tiene(t, "Motivo que se borrará")).toBe(false);
  });
});

describe("FC-34 · PA 00071 art. 33: un documento, una forma libre (tope de líneas por empresa)", () => {
  it("el tope por omisión es 15 y se lee en los ajustes", async () => {
    const r = await pedir(EMP.ORD, "GET", "/v1/company-settings");
    expect(((await r.json()) as { rows_per_free_form: number }).rows_per_free_form).toBe(15);
  });

  it("una factura de 16 líneas no se emite: 422 que dice cómo dividirla, y no deja factura", async () => {
    const antes = await sql<{ n: number }[]>`
      select count(*)::int as n from public.documents where company_id = ${EMP.ORD.company}`;
    const r = await pedir(EMP.ORD, "POST", "/v1/invoices", {
      company_id: EMP.ORD.company,
      customer_id: EMP.ORD.cliente,
      warehouse_id: EMP.ORD.warehouse,
      series: "T",
      lines: Array.from({ length: 16 }, () => ({
        product_id: EMP.ORD.prod.general,
        quantity: "1",
      })),
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toBe(
      "No cabe en una forma libre: divide la venta en varias facturas (máximo 15 filas impresas; esta ocupa 16)",
    );
    const despues = await sql<{ n: number }[]>`
      select count(*)::int as n from public.documents where company_id = ${EMP.ORD.company}`;
    expect(despues[0]!.n).toBe(antes[0]!.n);
  });

  it("el tope es un ajuste: con 3, una nota de débito de 4 líneas tampoco cabe", async () => {
    expect(
      (await pedir(EMP.ORD, "PUT", "/v1/company-settings", { rows_per_free_form: 3 })).status,
    ).toBe(200);
    try {
      const r = await pedir(EMP.ORD, "POST", "/v1/debit-notes", {
        company_id: EMP.ORD.company,
        source_document_id: DOCS.ORD!.factura,
        reason: "Cargos varios",
        lines: Array.from({ length: 4 }, () => ({
          product_id: EMP.ORD.prod.general,
          quantity: "1",
          unit_price: "1",
        })),
      });
      expect(r.status).toBe(422);
      expect(((await r.json()) as { message: string }).message).toBe(
        "No cabe en una forma libre: divide la nota en varias notas (máximo 3 filas impresas; esta ocupa 5)",
      );
    } finally {
      await pedir(EMP.ORD, "PUT", "/v1/company-settings", { rows_per_free_form: 15 });
    }
  });

  it("un tope fuera de 1..18 se rechaza (422)", async () => {
    const r = await pedir(EMP.ORD, "PUT", "/v1/company-settings", { rows_per_free_form: 40 });
    expect(r.status).toBe(422);
  });

  it("el recibo no tiene tope: no es forma libre", async () => {
    const r = await pedir(EMP.SIN, "POST", "/v1/pos/sales", {
      company_id: EMP.SIN.company,
      warehouse_id: EMP.SIN.warehouse,
      customer_id: EMP.SIN.cliente,
      lines: Array.from({ length: 16 }, () => ({
        product_id: EMP.SIN.prod.general,
        quantity: "1",
      })),
      payments: [{ instrument: "efectivo_bs", amount: "1600.00000000", currency: "VES" }],
    });
    expect(r.status).toBe(201);
  });
});

describe("FC-07 · art. 13.7 con el cliente de mostrador (VALIDAR-SENIAT P-57, lectura conservadora)", () => {
  it("sobre forma libre, la caja no factura al «Consumidor final»: 422 que pide identificarlo", async () => {
    const r = await pedir(EMP.ORD, "POST", "/v1/pos/sales", {
      company_id: EMP.ORD.company,
      warehouse_id: EMP.ORD.warehouse,
      lines: [{ product_id: EMP.ORD.prod.general, quantity: "1" }],
      payments: [{ instrument: "efectivo_bs", amount: "116.00000000", currency: "VES" }],
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toBe(
      "Para facturar sobre forma libre hacen falta el nombre del cliente y su RIF, cédula o " +
        "pasaporte (PA 00071 art. 13.7). Identifícalo: el «Consumidor final» es solo para recibos.",
    );
  });

  it("identificado en la caja con nombre y cédula, factura; el PDF imprime los dos", async () => {
    const cliente = crypto.randomUUID();
    await sql`insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                                              person_type_code, taxpayer_type_code,
                                              default_price_list_id)
               select ${cliente}, ${EMP.ORD.tenant}, ${EMP.ORD.company}, 'V12345678',
                      'María Pérez', 'natural', 'consumidor_final', default_price_list_id
                 from public.customers where id = ${EMP.ORD.cliente}`;
    const r = await pedir(EMP.ORD, "POST", "/v1/pos/sales", {
      company_id: EMP.ORD.company,
      warehouse_id: EMP.ORD.warehouse,
      customer_id: cliente,
      lines: [{ product_id: EMP.ORD.prod.general, quantity: "1" }],
      payments: [{ instrument: "efectivo_bs", amount: "116.00000000", currency: "VES" }],
    });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as { document: { id: string; kind: string } }).document.id;
    const t = await textoDelPdf(await pedir(EMP.ORD, "GET", `/v1/documents/${id}/pdf`));
    expect(tiene(t, "Cliente: María Pérez")).toBe(true);
    expect(tiene(t, "RIF/C.I.: V-12.345.678")).toBe(true);
  });

  it("con pasaporte, el rótulo dice «Pasaporte»", async () => {
    const cliente = crypto.randomUUID();
    await sql`insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                                              person_type_code, taxpayer_type_code,
                                              default_price_list_id)
               select ${cliente}, ${EMP.ORD.tenant}, ${EMP.ORD.company}, 'PAB123456',
                      'John Smith', 'natural', 'consumidor_final', default_price_list_id
                 from public.customers where id = ${EMP.ORD.cliente}`;
    const r = await pedir(EMP.ORD, "POST", "/v1/pos/sales", {
      company_id: EMP.ORD.company,
      warehouse_id: EMP.ORD.warehouse,
      customer_id: cliente,
      lines: [{ product_id: EMP.ORD.prod.general, quantity: "1" }],
      payments: [{ instrument: "efectivo_bs", amount: "116.00000000", currency: "VES" }],
    });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as { document: { id: string } }).document.id;
    const t = await textoDelPdf(await pedir(EMP.ORD, "GET", `/v1/documents/${id}/pdf`));
    expect(tiene(t, "Pasaporte: PAB123456")).toBe(true);
    expect(tiene(t, "RIF/C.I.: PAB123456")).toBe(false);
  });

  it("el recibo sí puede ir al «Consumidor final» (allow_unidentified_sales queda para recibos)", async () => {
    const r = await pedir(EMP.SIN, "POST", "/v1/pos/sales", {
      company_id: EMP.SIN.company,
      warehouse_id: EMP.SIN.warehouse,
      lines: [{ product_id: EMP.SIN.prod.general, quantity: "1" }],
      payments: [{ instrument: "efectivo_bs", amount: "100.00000000", currency: "VES" }],
    });
    expect(r.status).toBe(201);
  });
});

describe("A-2 · el tope cuenta FILAS IMPRESAS, no líneas", () => {
  it("15 líneas de 200 caracteres no se emiten: 422 al EMITIR, sin documento creado", async () => {
    const antes = await sql<{ n: number }[]>`
      select count(*)::int as n from public.documents where company_id = ${EMP.ORD.company}`;
    const r = await pedir(EMP.ORD, "POST", "/v1/invoices", {
      company_id: EMP.ORD.company,
      customer_id: EMP.ORD.cliente,
      warehouse_id: EMP.ORD.warehouse,
      series: "T",
      lines: Array.from({ length: 15 }, () => ({ product_id: LARGO, quantity: "1" })),
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toMatch(
      /^No cabe en una forma libre: divide la venta en varias facturas \(máximo 15 filas impresas; esta ocupa \d+\)$/,
    );
    const despues = await sql<{ n: number }[]>`
      select count(*)::int as n from public.documents where company_id = ${EMP.ORD.company}`;
    expect(despues[0]!.n).toBe(antes[0]!.n);
  });
});

describe("A-3 y A-4 · la contingencia refleja el papel; la nota identifica como la factura", () => {
  it("A-3 · la factura de contingencia al «Consumidor final» y de 15 líneas largas se registró", async () => {
    const [d] = await sql<{ customer_id: string; n: number }[]>`
      select d.customer_id, (select count(*)::int from public.document_lines l
                              where l.document_id = d.id) as n
        from public.documents d where d.id = ${LARGA}`;
    expect(d!.customer_id).toBe(CONSUMIDOR_ORD);
    expect(d!.n).toBe(15);
  });

  it("A-4 · la NC de esa factura al «Consumidor final» se emite: 201, al mismo adquirente", async () => {
    const [linea] = await sql<{ id: string }[]>`
      select id from public.document_lines where document_id = ${LARGA} and line_number = 2`;
    const r = await pedir(EMP.ORD, "POST", "/v1/credit-notes", {
      company_id: EMP.ORD.company,
      source_document_id: LARGA,
      reason: "Descuento acordado",
      lines: [{ source_line_id: linea!.id, quantity: "1" }],
    });
    expect(r.status).toBe(201);
    const nc = ((await r.json()) as { document: { id: string; customer_id: string } }).document;
    expect(nc.customer_id).toBe(CONSUMIDOR_ORD);
  });
});

import { inflateSync } from "node:zlib";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { digitoVerificadorRif } from "@ladino/schemas";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";
import { fiadoDeFixture } from "./_fiado-de-fixture.js";

const FUENTE_TASA_FIADO = `BCV e2e-talonario-fiado-${Date.now().toString(36)}`;

/**
 * EL TALONARIO DE LA IMPRENTA, DE PUNTA A PUNTA (ADR-0071; G-01, E-01, B-03, E-17, G-16).
 *
 *   1. sin los datos de la imprenta no se registra un talonario: 422 que dice QUÉ falta (B-03);
 *   2. un talonario que pisa otro, sea de la clase que sea, es un 409 que dice CUÁL (G-01);
 *   3. la caja emite en la serie del talonario registrado (B), no en una «A» del servidor (E-01);
 *   4. la NC consume el SIGUIENTE control del mismo talonario: un solo correlativo (G-01);
 *   5. sin talonario para la serie pedida, el 409 dice en español qué falta (E-17, G-16);
 *   6. un talonario sin datos de imprenta no emite hasta completarlos, una sola vez.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";

const TENANT = crypto.randomUUID();
const COMPANY = crypto.randomUUID();
const W1 = crypto.randomUUID();
const DUENO = crypto.randomUUID();
const CLIENTE = crypto.randomUUID();
const ROL = crypto.randomUUID();
const MEM = crypto.randomUUID();
const ASIG = crypto.randomUUID();
const RUN = Date.now().toString(36);
const AYER = diaCaracas(-1);

const IMPRENTA = {
  printer_legal_name: "Gráficas Lara, C.A.",
  printer_tax_id: "J-12345678-9",
  printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
  printer_authorization_date: "2020-01-15",
  printed_on: "2026-09-01",
};

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PROD = "";

const tokenDe = (sub: string) =>
  new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);

async function pedir(
  metodo: string,
  path: string,
  body?: unknown,
  empresa: string = COMPANY,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(DUENO)}`,
    "X-Company-Id": empresa,
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

/** Infla los streams del PDF y decodifica los <hex> de los TJ (como en los E2E del papel). */
function textoDelPdf(bruto: Buffer): string {
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
    .map((m) => Buffer.from(m[1]!, "hex").toString("latin1"))
    .join("");
}

type Doc = {
  id: string;
  kind: string;
  series: string;
  control_number: number | null;
  control_identifier: string | null;
};

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  // R-82.1 / R-82.3: fiar (la factura de administración nace fiada) exige la tasa de hoy para
  // medir la deuda contra el límite. Entrada del fixture, bajo el candado de las tasas y solo si
  // no hay ya una de hoy: ninguna cifra de este fichero depende de USD→VES.
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, (now() at time zone 'America/Caracas')::date, now(),
             ${FUENTE_TASA_FIADO}
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = (now() at time zone 'America/Caracas')::date)`;
  });
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e talonario')`;
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-TAL-${RUN}`}, 'Empresa e2e talonario', 'VES',
                     'ordinario')`;
    await declararTipoDeFixture(tx, COMPANY);
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-TW1', 'Principal')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, ${`e2etal_${RUN}`}, 'Dueño e2e talonario', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.return.manage'),
             (${ROL}, 'sales.credit_note.direct'),
             (${ROL}, 'fiscal.range.manage'), (${ROL}, 'inventory.move'), (${ROL}, 'ar.read')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${MEM}, ${TENANT}, ${DUENO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id)
             values (${ASIG}, ${TENANT}, ${MEM}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, ${ASIG}, 'warehouse', ${W1})`;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, ${`e2e-tal-${RUN}`}, 'VES') returning id`;
    await tx`insert into public.customers
               (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                taxpayer_type_code, default_price_list_id)
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, ${`J-CLT-${RUN}`}, 'Cliente e2e talonario',
                     'juridica', 'ordinario', ${l!.id})`;
    // R-82.1: la factura de administración nace fiada — la empresa de prueba declara que fía.
    await fiadoDeFixture(tx, COMPANY, [ROL]);
    const [p] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2ETAL-${RUN}`}, 'Producto e2e talonario', 'good',
              'active', 'unidad', 'gravado_general')
      returning id`;
    PROD = p!.id;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${l!.id}, ${PROD}, '1000.00000000', ${AYER}::date)`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${TENANT}, ${COMPANY}, 'formatos_libres', ${AYER}::timestamptz)`;
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
    await tx`
      insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                                    rate, effective_from, legal_source, priority, transaction_type)
      select 'VE', 'iva', 'ordinario', 'gravado_general', 0.16, ${AYER}::date,
             'Carga de prueba E2E — VALIDAR-SENIAT antes de producción.', 10, 'sale'
       where not exists (select 1 from public.tax_rules
                          where company_id is null and jurisdiction = 'VE' and tax_code = 'iva'
                            and taxpayer_type = 'ordinario'
                            and product_tax_category = 'gravado_general'
                            and transaction_type = 'sale')`;
    // El caso del «Hallazgo 3» reclasifica un producto como exento: en una base limpia nadie
    // más siembra la regla exenta, y la ND global a la condición de hoy no la encontraría.
    await tx`
      insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                                    rate, effective_from, legal_source, priority, transaction_type)
      select 'VE', 'iva', 'ordinario', 'exento', 0, ${AYER}::date,
             'Carga de prueba E2E — VALIDAR-SENIAT antes de producción.', 10, 'sale'
       where not exists (select 1 from public.tax_rules
                          where company_id is null and jurisdiction = 'VE' and tax_code = 'iva'
                            and taxpayer_type = 'ordinario'
                            and product_tax_category = 'exento'
                            and transaction_type = 'sale')`;
    await tx`insert into public.inventory_moves
               (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
                amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
                functional_currency, rate_source, rate_timestamp, rounding_policy_id,
                occurred_at, reference)
             values (${TENANT}, ${COMPANY}, ${W1}, ${PROD}, 'entrada', 100, 50000, 'VES', 1,
                     50000, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', now(),
                     ${`e2e-tal-seed-${RUN}`})`;
  });
});

afterAll(async () => {
  if (sql) await sql`delete from public.exchange_rates where source = ${FUENTE_TASA_FIADO}`;
  await sql?.end();
  await sqlApi?.end();
});

async function facturar(series?: string): Promise<Response> {
  return pedir("POST", "/v1/invoices", {
    company_id: COMPANY,
    customer_id: CLIENTE,
    warehouse_id: W1,
    ...(series === undefined ? {} : { series }),
    lines: [{ product_id: PROD, quantity: "1" }],
  });
}

describe("el talonario de la imprenta (ADR-0071)", () => {
  it("B-03: sin los datos de la imprenta no se registra: 422 que dice qué falta", async () => {
    const r = await pedir("POST", "/v1/fiscal-number-ranges", {
      company_id: COMPANY,
      series: "B",
      range_from: "1",
      range_to: "5000",
      printer_source: "Gráficas Lara, C.A.",
    });
    expect(r.status).toBe(422);
    const b = (await r.json()) as { code: string; message: string };
    expect(b.code).toBe("VALIDATION_FAILED");
    expect(b.message).toContain("Sin los datos de la imprenta no se registra el talonario");
    expect(b.message).toContain("el RIF de la imprenta");

    const rifMalo = await pedir("POST", "/v1/fiscal-number-ranges", {
      company_id: COMPANY,
      series: "B",
      range_from: "1",
      range_to: "5000",
      ...IMPRENTA,
      printer_tax_id: "12345",
    });
    expect(rifMalo.status).toBe(422);
    expect(((await rifMalo.json()) as { message: string }).message).toContain(
      "no tiene la forma de un RIF",
    );
  });

  it("E-01: la caja emite en la serie del talonario B, con el control y su identificador", async () => {
    const r = await pedir("POST", "/v1/fiscal-number-ranges", {
      company_id: COMPANY,
      series: "B",
      range_from: "1",
      range_to: "5000",
      ...IMPRENTA,
    });
    expect(r.status).toBe(201);
    const t = (await r.json()) as Record<string, unknown>;
    expect(t["kind"]).toBeNull();
    expect(t["printer_identifier"]).toBe("00");
    expect(t["printer_tax_id"]).toBe("J123456789");
    expect(t["printer_data_complete"]).toBe(true);

    // Sin decir la serie: el único talonario activo la dicta. Antes era «A» fija (sales.ts:1329).
    const f = await facturar();
    expect(f.status).toBe(201);
    const d = (await f.json()) as Doc;
    expect(d.series).toBe("B");
    expect(d.control_number).toBe(1);
    expect(d.control_identifier).toBe("00");
  });

  it("G-01: un rango de notas que pisa el talonario se rechaza con un 409 que dice cuál pisa", async () => {
    const r = await pedir("POST", "/v1/fiscal-number-ranges", {
      company_id: COMPANY,
      kind: "credit_note",
      series: "B",
      range_from: "1",
      range_to: "500",
      ...IMPRENTA,
    });
    expect(r.status).toBe(409);
    const b = (await r.json()) as { code: string; message: string };
    expect(b.code).toBe("DUPLICATE");
    expect(b.message).toContain("pisa el talonario serie B 1–5000");
  });

  it("G-01: la NC consume el SIGUIENTE control del mismo talonario", async () => {
    const f = await facturar("B");
    expect(f.status).toBe(201);
    const factura = (await f.json()) as Doc;
    expect(factura.control_number).toBe(2);
    const det = (await (await pedir("GET", `/v1/documents/${factura.id}`)).json()) as {
      lines: { id: string }[];
    };
    const nc = await pedir("POST", "/v1/credit-notes", {
      company_id: COMPANY,
      source_document_id: factura.id,
      reason: "Descuento acordado tras la venta",
      lines: [{ source_line_id: det.lines[0]!.id, quantity: "1" }],
    });
    expect(nc.status).toBe(201);
    const n = ((await nc.json()) as { document: Doc }).document;
    expect(n.kind).toBe("credit_note");
    expect(n.series).toBe("B");
    expect(n.control_identifier).toBe("00");
    expect(n.control_number).toBe(3);

    const [ninguno] = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.control_number_collisions()
       where company_id = ${COMPANY}`;
    expect(ninguno!.n).toBe(0);
  });

  it("E-17 / G-16: sin talonario para la serie pedida, un 409 en español y sin «invoice»", async () => {
    const r = await facturar("Q");
    expect(r.status).toBe(409);
    const b = (await r.json()) as { code: string; message: string };
    expect(b.code).toBe("FISCAL_NUMBERING_INVALID");
    expect(b.message).toBe(
      "No quedan números de control para facturas (identificador 00). Carga el talonario nuevo.",
    );
    expect(b.message).not.toMatch(/invoice|debit_note|credit_note/);
  });

  it("B-03: un talonario sin datos de imprenta no emite hasta completarlos, y se completan una vez", async () => {
    const [viejo] = await sql<{ id: string }[]>`
      insert into public.fiscal_number_ranges
        (tenant_id, company_id, kind, series, printer_identifier, range_from, range_to,
         next_available, printer_source, created_at, version)
      values (${TENANT}, ${COMPANY}, 'invoice', 'V', '01', 1, 100, 1, 'Imprenta de antes',
              now(), 1)
      returning id`;
    const sinDatos = await facturar("V");
    expect(sinDatos.status).toBe(409);
    expect(((await sinDatos.json()) as { message: string }).message).toBe(
      "Al talonario serie V (identificador 01) le faltan los datos de la imprenta: complétalos en la puesta a punto fiscal antes de volver a emitir.",
    );

    const completar = await pedir("POST", `/v1/fiscal-number-ranges/${viejo!.id}/printer`, {
      company_id: COMPANY,
      ...IMPRENTA,
    });
    expect(completar.status).toBe(200);
    expect(
      ((await completar.json()) as { printer_data_complete: boolean }).printer_data_complete,
    ).toBe(true);
    const ahora = await facturar("V");
    expect(ahora.status).toBe(201);
    const d = (await ahora.json()) as Doc;
    expect([d.series, d.control_identifier, d.control_number]).toEqual(["V", "01", 1]);

    const otraVez = await pedir("POST", `/v1/fiscal-number-ranges/${viejo!.id}/printer`, {
      company_id: COMPANY,
      ...IMPRENTA,
      printer_legal_name: "Otra imprenta, C.A.",
    });
    expect(otraVez.status).toBe(409);
    const b = (await otraVez.json()) as { code: string; message: string };
    expect(b.code).toBe("DUPLICATE");
    expect(b.message).toContain("ya tiene los datos de la imprenta");
  }, 20_000);
  it("H1: una serie «contingencia…» no se registra como talonario normal: 422", async () => {
    const r = await pedir("POST", "/v1/fiscal-number-ranges", {
      company_id: COMPANY,
      series: "Contingencia-B",
      range_from: "1",
      range_to: "5000",
      ...IMPRENTA,
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(await r.json())).toContain("contingencia");
  });

  it("H4: el registro deja su acta, y la emisión lleva el identificador en su payload", async () => {
    const [registro] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where company_id = ${COMPANY} and event_type = 'fiscal.range.registered'`;
    expect(registro!.n).toBeGreaterThanOrEqual(1);
    const [emision] = await sql<{ control_identifier: string | null }[]>`
      select payload->>'control_identifier' as control_identifier from public.audit_events
       where company_id = ${COMPANY} and event_type = 'fiscal.invoice.issued'
       order by created_at limit 1`;
    expect(emision!.control_identifier).toBe("00");
  });

  it("H3: anular exige motivo, deja acta, y solo vale para un talonario que no emitió", async () => {
    const r = await pedir("POST", "/v1/fiscal-number-ranges", {
      company_id: COMPANY,
      series: "Z",
      range_from: "9000",
      range_to: "9100",
      ...IMPRENTA,
    });
    expect(r.status).toBe(201);
    const z = (await r.json()) as { id: string };
    const corto = await pedir("POST", `/v1/fiscal-number-ranges/${z.id}/cancel`, {
      company_id: COMPANY,
      reason: "corto",
    });
    expect(corto.status).toBe(422);
    const anulado = await pedir("POST", `/v1/fiscal-number-ranges/${z.id}/cancel`, {
      company_id: COMPANY,
      reason: "Talonario cargado por error: el papel es de otra sucursal",
    });
    expect(anulado.status).toBe(200);
    expect(((await anulado.json()) as { status: string }).status).toBe("cancelled");
    const [acta] = await sql<{ reason: string }[]>`
      select payload->>'reason' as reason from public.audit_events
       where aggregate_id = ${z.id} and event_type = 'fiscal.range.cancelled'`;
    expect(acta!.reason).toContain("otra sucursal");

    const [b] = await sql<{ id: string }[]>`
      select id from public.fiscal_number_ranges
       where company_id = ${COMPANY} and series = 'B' and printer_identifier = '00'`;
    const emitio = await pedir("POST", `/v1/fiscal-number-ranges/${b!.id}/cancel`, {
      company_id: COMPANY,
      reason: "Quiero anular el talonario que ya usé",
    });
    expect(emitio.status).toBe(409);
    expect(((await emitio.json()) as { message: string }).message).toContain(
      "ya emitió documentos",
    );
  });

  it("H3: la imprenta se corrige con motivo y acta de antes y después; el identificador no, si emitió", async () => {
    const [b] = await sql<{ id: string }[]>`
      select id from public.fiscal_number_ranges
       where company_id = ${COMPANY} and series = 'B' and printer_identifier = '00'`;
    const r = await pedir("POST", `/v1/fiscal-number-ranges/${b!.id}/printer-correction`, {
      company_id: COMPANY,
      ...IMPRENTA,
      printer_legal_name: "Gráficas Lara del Centro, C.A.",
      reason: "La imprenta cambió de razón social en su providencia",
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { printer_legal_name: string }).printer_legal_name).toBe(
      "Gráficas Lara del Centro, C.A.",
    );
    const [acta] = await sql<{ antes: string; despues: string }[]>`
      select payload->'antes'->>'printer_legal_name' as antes,
             payload->'despues'->>'printer_legal_name' as despues
        from public.audit_events
       where aggregate_id = ${b!.id} and event_type = 'fiscal.range.printer_corrected'`;
    expect([acta!.antes, acta!.despues]).toEqual([
      "Gráficas Lara, C.A.",
      "Gráficas Lara del Centro, C.A.",
    ]);

    const ident = await pedir("POST", `/v1/fiscal-number-ranges/${b!.id}/printer-correction`, {
      company_id: COMPANY,
      ...IMPRENTA,
      printer_identifier: "07",
      reason: "El identificador del papel es otro",
    });
    expect(ident.status).toBe(409);
    expect(((await ident.json()) as { message: string }).message).toContain("ya emitió no cambia");
  });

  it("RIF de la imprenta: un dígito verificador que no cuadra se acepta y deja acta", async () => {
    const esperado = digitoVerificadorRif("J30000001");
    const malo = String(((esperado ?? 0) + 1) % 10);
    const r = await pedir("POST", "/v1/fiscal-number-ranges", {
      company_id: COMPANY,
      series: "W",
      printer_identifier: "03",
      range_from: "1",
      range_to: "50",
      ...IMPRENTA,
      printer_tax_id: `J-30000001-${malo}`,
    });
    expect(r.status).toBe(201);
    const w = (await r.json()) as { id: string; printer_tax_id: string };
    expect(w.printer_tax_id).toBe(`J30000001${malo}`);
    const [acta] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where aggregate_id = ${w.id} and event_type = 'fiscal_number_range.tax_id_check_digit_mismatch'`;
    expect(acta!.n).toBe(1);
  });

  it("H11: un talonario SIN serie emite; su número es propio y no lleva guion", async () => {
    const r = await pedir("POST", "/v1/fiscal-number-ranges", {
      company_id: COMPANY,
      series: "",
      printer_identifier: "02",
      range_from: "1",
      range_to: "100",
      ...IMPRENTA,
    });
    expect(r.status).toBe(201);
    const uno = await facturar("");
    expect(uno.status).toBe(201);
    const dos = await facturar("");
    expect(dos.status).toBe(201);
    const [d1, d2] = [
      (await uno.json()) as Doc & { document_number: number },
      (await dos.json()) as Doc & { document_number: number },
    ];
    expect([d1.series, d1.document_number, d1.control_identifier, d1.control_number]).toEqual([
      "",
      1,
      "02",
      1,
    ]);
    expect(d2.document_number).toBe(2);
    const pdf = await pedir("GET", `/v1/documents/${d1.id}/pdf`);
    expect(pdf.status).toBe(200);
  }, 20_000);
  it("H10: el 409 de numeración dice su motivo en details.reason, uno por caso", async () => {
    type Err = { code: string; details?: { reason?: string } };
    // Sin talonario para la serie pedida.
    const sinRango = (await (await facturar("SIN-TALONARIO")).json()) as Err;
    expect([sinRango.code, sinRango.details?.reason]).toEqual([
      "FISCAL_NUMBERING_INVALID",
      "no_range",
    ]);

    // Un talonario sin los datos de la imprenta.
    await sql`
      insert into public.fiscal_number_ranges
        (tenant_id, company_id, kind, series, printer_identifier, range_from, range_to,
         next_available, printer_source, created_at, version)
      values (${TENANT}, ${COMPANY}, 'invoice', 'U', '04', 1, 100, 1, 'Imprenta de antes',
              now(), 1)`;
    const sinImprenta = (await (await facturar("U")).json()) as Err;
    expect([sinImprenta.code, sinImprenta.details?.reason]).toEqual([
      "FISCAL_NUMBERING_INVALID",
      "printer_data_incomplete",
    ]);

    // Una fecha anterior al régimen vigente: sin régimen.
    const r = await pedir("POST", "/v1/invoices", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      series: "B",
      issued_at: `${diaCaracas(-10)}T15:00:00Z`,
      lines: [{ product_id: PROD, quantity: "1" }],
    });
    expect(r.status).toBe(409);
    const sinRegimen = (await r.json()) as Err;
    expect([sinRegimen.code, sinRegimen.details?.reason]).toEqual([
      "FISCAL_NUMBERING_INVALID",
      "regime_missing",
    ]);
  });
  it("Hallazgo 3: la NC revierte el IVA a la alícuota y la condición de la FACTURA, no las de hoy", async () => {
    // Un producto propio, gravado al 16 %, con existencia y precio en la lista de la empresa.
    const [lista] = await sql<{ id: string }[]>`
      select id from public.price_lists where company_id = ${COMPANY} and currency_code = 'VES'
       order by created_at limit 1`;
    const P2 = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`insert into public.products (id, tenant_id, company_id, sku, name, kind, status,
                                             unit_code, tax_category_code)
               values (${P2}, ${TENANT}, ${COMPANY}, ${`E2ETAL-NC-${RUN}`}, 'Producto que cambia',
                       'good', 'active', 'unidad', 'gravado_general')`;
      await tx`insert into public.price_list_items
                 (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
               values (${TENANT}, ${COMPANY}, ${lista!.id}, ${P2}, '1000.00000000', ${AYER}::date)`;
      await tx`insert into public.inventory_moves
                 (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
                  amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
                  functional_currency, rate_source, rate_timestamp, rounding_policy_id,
                  occurred_at, reference)
               values (${TENANT}, ${COMPANY}, ${W1}, ${P2}, 'entrada', 10, 5000, 'VES', 1, 5000,
                       'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', now(),
                       ${`e2e-tal-nc-${RUN}`})`;
    });
    const f = await pedir("POST", "/v1/invoices", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      series: "B",
      lines: [{ product_id: P2, quantity: "2" }],
    });
    expect(f.status).toBe(201);
    const factura = (await f.json()) as Doc & { tax_amount: string };
    expect(factura.tax_amount).toBe("320.00000000");

    // Después de facturar, el producto se reclasifica como exento Y se renombra.
    await sql`update public.products set tax_category_code = 'exento', name = 'Nombre de hoy'
               where id = ${P2}`;

    const det = (await (await pedir("GET", `/v1/documents/${factura.id}`)).json()) as {
      lines: { id: string }[];
    };
    const nc = await pedir("POST", "/v1/credit-notes", {
      company_id: COMPANY,
      source_document_id: factura.id,
      reason: "Devolución del precio de una unidad",
      // B-3: una NC PARCIAL, 1 de las 2 unidades.
      lines: [{ source_line_id: det.lines[0]!.id, quantity: "1" }],
    });
    expect(nc.status).toBe(201);
    const n = ((await nc.json()) as { document: Doc & { tax_amount: string } }).document;
    expect(n.tax_amount).toBe("160.00000000");
    type Linea = {
      tasa: string;
      categoria: string;
      descripcion: string;
      regla: string | null;
      operacion: string | null;
    };
    const lineaDe = async (doc: string): Promise<Linea> => {
      const [l] = await sql<Linea[]>`
        select tax_rate_snapshot::text as tasa, tax_category_snapshot as categoria,
               description as descripcion, tax_rule_id as regla, operation_type as operacion
          from public.document_lines where document_id = ${doc}`;
      return l!;
    };
    const deLaFactura = await lineaDe(factura.id);
    const deLaNc = await lineaDe(n.id);
    // El nombre VIEJO, no «Nombre de hoy»; la regla y el tipo de operación de la factura.
    expect(deLaNc).toEqual({ ...deLaFactura });
    expect([deLaNc.tasa, deLaNc.categoria, deLaNc.descripcion]).toEqual([
      "0.16000000",
      "gravado_general",
      "Producto que cambia",
    ]);
    expect(deLaNc.regla).not.toBeNull();

    // En el libro, la NC cae en la fila de la alícuota general, no en la exenta.
    const [libro] = await sql<{ base_general: string; iva_general: string; exenta: string }[]>`
      select base_alicuota_general::text as base_general, iva_alicuota_general::text as iva_general,
             base_exenta::text as exenta
        from platform.sales_book_by_rate(${COMPANY}, (now() at time zone 'America/Caracas')::date,
                                         (now() at time zone 'America/Caracas')::date)
       where document_id = ${n.id}`;
    expect(Math.abs(Number(libro!.iva_general))).toBe(160);
    expect(Math.abs(Number(libro!.base_general))).toBe(1000);
    expect(Number(libro!.exenta)).toBe(0);

    // B-5: la ND que corrige una línea de la factura también va a su alícuota…
    const nd = await pedir("POST", "/v1/debit-notes", {
      company_id: COMPANY,
      source_document_id: factura.id,
      reason: "Diferencia de precio de la línea",
      lines: [
        {
          product_id: P2,
          quantity: "1",
          unit_price: "100.00000000",
          source_line_id: det.lines[0]!.id,
        },
      ],
    });
    expect(nd.status).toBe(201);
    const ndDoc = (await nd.json()) as Doc;
    const deLaNd = await lineaDe(ndDoc.id);
    expect([deLaNd.tasa, deLaNd.categoria, deLaNd.regla]).toEqual([
      "0.16000000",
      "gravado_general",
      deLaFactura.regla,
    ]);
    // …y sin línea (un ajuste global) va a la condición de HOY: el producto ya es exento.
    const global = await pedir("POST", "/v1/debit-notes", {
      company_id: COMPANY,
      source_document_id: factura.id,
      reason: "Ajuste global",
      lines: [{ product_id: P2, quantity: "1", unit_price: "100.00000000" }],
    });
    expect(global.status).toBe(201);
    const deLaGlobal = await lineaDe(((await global.json()) as Doc).id);
    expect([deLaGlobal.categoria, Number(deLaGlobal.tasa), deLaGlobal.descripcion]).toEqual([
      "exento",
      0,
      "Nombre de hoy",
    ]);
  }, 30_000);

  it("Hallazgo 13: la ND que corrige va a la tasa de la factura; la de un concepto nuevo, a la de su día", async () => {
    // Una empresa con moneda funcional USD que vende en Bs: el par VES→USD es solo de este test,
    // así sus tasas no tocan a los E2E que corren en paralelo con USD→VES.
    const C2 = crypto.randomUUID();
    const W2 = crypto.randomUUID();
    const CL2 = crypto.randomUUID();
    const fuente = `BCV e2e talonario ${RUN}`;
    // Lo que dejó una pasada anterior que no llegó a limpiar.
    await sql`delete from public.exchange_rates
               where from_currency = 'VES' and to_currency = 'USD' and source like 'BCV e2e talonario%'`;
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`insert into public.companies
                 (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
               values (${C2}, ${TENANT}, ${`J-TAL2-${RUN}`}, 'Empresa en dólares', 'USD',
                       'ordinario')`;
      await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
               values (${W2}, ${TENANT}, ${C2}, 'E2E-TW2', 'Principal')`;
      // La puerta de emisión pide el tipo de contribuyente declarado (ADR-0072).
      await tx`insert into public.company_taxpayer_types
                 (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason,
                  rules_version)
               values (${TENANT}, ${C2}, 'ordinario', '2026-01-01', null, 'E2E talonario',
                       'domain-s0.5')`;
      await tx`insert into public.scope_bindings
                 (tenant_id, company_id, assignment_id, scope_type, scope_id)
               values (${TENANT}, ${C2}, ${ASIG}, 'warehouse', ${W2})`;
      const [l] = await tx<{ id: string }[]>`
        insert into public.price_lists (tenant_id, company_id, name, currency_code)
        values (${TENANT}, ${C2}, ${`e2e-tal2-${RUN}`}, 'VES') returning id`;
      await tx`insert into public.customers
                 (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                  taxpayer_type_code, default_price_list_id)
               values (${CL2}, ${TENANT}, ${C2}, ${`J-CL2-${RUN}`}, 'Cliente de la empresa en dólares',
                       'juridica', 'ordinario', ${l!.id})`;
      await fiadoDeFixture(tx, C2);
      const [p] = await tx<{ id: string }[]>`
        insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                     tax_category_code)
        values (${TENANT}, ${C2}, ${`E2ETAL2-${RUN}`}, 'Producto en dólares', 'good', 'active',
                'unidad', 'gravado_general') returning id`;
      await tx`insert into public.price_list_items
                 (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
               values (${TENANT}, ${C2}, ${l!.id}, ${p!.id}, '1000.00000000', ${AYER}::date)`;
      await tx`insert into public.company_fiscal_regimes
                 (tenant_id, company_id, regime_code, effective_from)
               values (${TENANT}, ${C2}, 'formatos_libres', ${AYER}::timestamptz)`;
      await tx`insert into public.inventory_moves
                 (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
                  amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
                  functional_currency, rate_source, rate_timestamp, rounding_policy_id,
                  occurred_at, reference)
               values (${TENANT}, ${C2}, ${W2}, ${p!.id}, 'entrada', 10, 100, 'USD', 1, 100,
                       'USD', 'identidad', now(), 'inventory:cost:8:HALF_UP', now(),
                       ${`e2e-tal2-seed-${RUN}`})`;
      await tx`insert into public.exchange_rates
                 (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
               values ('VES', 'USD', 0.02, ${fuente}, ${AYER}::date, now())`;
      // R-82.1 / R-82.3: la factura de administración nace fiada y la deuda se mide a la tasa
      // de HOY: la del día abre igual que la de ayer (0,02) y el BCV publica otra más tarde.
      await tx`insert into public.exchange_rates
                 (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
               values ('VES', 'USD', 0.02, ${`${fuente} (apertura)`},
                       (now() at time zone 'America/Caracas')::date, now())`;
    });
    const [prod] = await sql<{ id: string }[]>`
      select id from public.products where company_id = ${C2}`;
    const t = await pedir(
      "POST",
      "/v1/fiscal-number-ranges",
      { company_id: C2, series: "D", range_from: "1", range_to: "100", ...IMPRENTA },
      C2,
    );
    expect(t.status).toBe(201);
    const f = await pedir(
      "POST",
      "/v1/invoices",
      {
        company_id: C2,
        customer_id: CL2,
        warehouse_id: W2,
        lines: [{ product_id: prod!.id, quantity: "1" }],
      },
      C2,
    );
    expect(f.status).toBe(201);
    const factura = (await f.json()) as Doc & { fx_rate: string };
    expect(Number(factura.fx_rate)).toBe(0.02);

    // Después de la factura, el BCV publica la de hoy.
    await sql`insert into public.exchange_rates
                 (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
               values ('VES', 'USD', 0.025, ${fuente},
                       (now() at time zone 'America/Caracas')::date, now())`;
    const linea = [{ product_id: prod!.id, quantity: "1", unit_price: "100.00000000" }];
    const corrige = await pedir(
      "POST",
      "/v1/debit-notes",
      {
        company_id: C2,
        source_document_id: factura.id,
        reason: "Diferencia de precio",
        lines: linea,
      },
      C2,
    );
    expect(corrige.status).toBe(201);
    const ndCorrige = (await corrige.json()) as Doc & { fx_rate: string };
    expect(Number(ndCorrige.fx_rate)).toBe(0.02);

    const nuevo = await pedir(
      "POST",
      "/v1/debit-notes",
      {
        company_id: C2,
        source_document_id: factura.id,
        reason: "Flete del despacho",
        basis: "new_concept",
        lines: linea,
      },
      C2,
    );
    expect(nuevo.status).toBe(201);
    const ndNuevo = (await nuevo.json()) as Doc & { fx_rate: string };
    expect(Number(ndNuevo.fx_rate)).toBe(0.025);
    const bases = await sql<{ id: string; rate_basis: string | null }[]>`
      select id, rate_basis from public.documents where id in (${ndCorrige.id}, ${ndNuevo.id})`;
    expect(Object.fromEntries(bases.map((b) => [b.id, b.rate_basis]))).toEqual({
      [ndCorrige.id]: "origin",
      [ndNuevo.id]: "own_day",
    });
    const textoDe = async (id: string): Promise<string> => {
      const r = await pedir("GET", `/v1/documents/${id}/pdf`, undefined, C2);
      expect(r.status).toBe(200);
      return textoDelPdf(Buffer.from(await r.arrayBuffer()));
    };
    expect(await textoDe(ndCorrige.id)).toMatch(
      /Tasa BCV de la factura .+ del \d{2}\/\d{2}\/\d{4}: Bs /,
    );
    const textoNuevo = await textoDe(ndNuevo.id);
    expect(textoNuevo).toMatch(/Tasa BCV del \d{2}\/\d{2}\/\d{4}: Bs /);
    expect(textoNuevo).not.toContain("Tasa BCV de la factura");
    await sql`delete from public.exchange_rates where source = ${fuente}`;
    await sql`delete from public.exchange_rates where source = ${`${fuente} (apertura)`}`;
  }, 30_000);
});

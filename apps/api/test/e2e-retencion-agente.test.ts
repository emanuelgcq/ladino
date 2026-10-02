import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";

/**
 * EL AGENTE RETIENE SOLO Y EL COMPROBANTE ES UN DOCUMENTO (ADR-0072 §3, §4 y §6; H-01, H-04,
 * H-12, L-03). JWT real, como `ladino_api`.
 *
 * Lo que este fichero demuestra: que una empresa ESPECIAL que registra una compra a un ordinario
 * retiene el 75 % SIN enviar `retention_concepts` (antes ninguna pantalla lo enviaba y no se
 * retenía nunca); que nace el comprobante `AAAAMM########` con la identidad congelada; que la
 * exclusión marcada queda auditada; que sin regla vigente la factura se detiene; que corregir
 * versiona; que el libro de compras identifica el comprobante; que el TXT sigue P-7 y la quincena;
 * que la llegada de mercancía retiene igual; y que el pago en partes no toca el comprobante.
 *
 * La regla de retención es PROPIA de la empresa (como e2e-accounting-hooks): `resolve_retention`
 * solo mira las de la empresa si las tiene, así que este fichero no depende del catálogo global ni
 * compite con los otros E2E. El 100 % (`iva_compras_total`) NO se carga: es la ausencia.
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
const USUARIO = crypto.randomUUID();
const ROL = crypto.randomUUID();
const MEM = crypto.randomUUID();
const ASIG = crypto.randomUUID();
const RUN = Date.now().toString(36);
const RIF_AGENTE = `J-E2ERET-${RUN}`;
const HOY = diaCaracas();
const AYER = diaCaracas(-1);
const PERIODO = HOY.slice(0, 7).replace("-", "");

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PROV = "";
let PROV_RIF = "";
let PROV_FORMAL = "";
let PROD = "";
let PROD_EXENTO = "";
let PROV_NO_SUJETO = "";
let FACTURA_1 = "";
let COMPROBANTE_1 = "";
let NUMERO_1 = "";
let COMPROBANTE_2 = "";

const tokenDe = (sub: string) =>
  new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);

async function pedir(metodo: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(USUARIO)}`,
    "X-Company-Id": COMPANY,
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
 * El TEXTO del PDF: infla los streams y decodifica los <hex> de los TJ en WinAnsi. La misma técnica
 * de e2e-checklist-factura, e2e-fiscal-legal y e2e-alicuotas, sin dependencias.
 */
async function textoDelPdf(r: Response): Promise<string> {
  expect(r.status).toBe(200);
  expect(r.headers.get("Content-Type")).toBe("application/pdf");
  const bruto = Buffer.from(await r.arrayBuffer());
  expect(bruto.subarray(0, 4).toString("latin1")).toBe("%PDF");
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

/** El 2.º día de lunes a viernes después del fin de la quincena de `dia` (art. 16). */
function venceEntrega(dia: string): string {
  const [y, m, d] = dia.split("-").map(Number) as [number, number, number];
  const x = d <= 15 ? new Date(Date.UTC(y, m - 1, 15)) : new Date(Date.UTC(y, m, 0));
  let habiles = 0;
  while (habiles < 2) {
    x.setUTCDate(x.getUTCDate() + 1);
    const w = x.getUTCDay();
    if (w !== 0 && w !== 6) habiles += 1;
  }
  return x.toISOString().slice(0, 10);
}

async function registrar(cuerpo: Record<string, unknown>): Promise<Response> {
  return pedir("POST", "/v1/supplier-invoices", {
    company_id: COMPANY,
    supplier_id: PROV,
    invoice_date: HOY,
    currency: "VES",
    lines: [{ product_id: PROD, quantity: "10", unit_price: "4000" }],
    ...cuerpo,
  });
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${USUARIO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${USUARIO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e agente')`;
    // CONTRIBUYENTE ESPECIAL: agente de retención (ADR-0072 §1; el fixture declara su historia).
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code,
                fiscal_address)
             values (${COMPANY}, ${TENANT}, ${RIF_AGENTE}, 'Agente e2e, C.A.', 'VES', 'especial',
                     'Av. Principal, Caracas')`;
    await declararTipoDeFixture(tx, COMPANY);
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-RW1', 'Principal')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, ${`e2eret_${RUN}`}, 'Agente', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'supplier.manage'), (${ROL}, 'purchase.order.manage'),
             (${ROL}, 'purchase.receive'), (${ROL}, 'purchase.invoice.register'),
             (${ROL}, 'purchase.payment.register'), (${ROL}, 'retention.receipt.issue'),
             (${ROL}, 'inventory.move'), (${ROL}, 'ap.read'), (${ROL}, 'fiscal_book.export'),
             (${ROL}, 'company.settings.manage')`;
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${MEM}, ${TENANT}, ${USUARIO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id)
             values (${ASIG}, ${TENANT}, ${MEM}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, ${ASIG}, 'warehouse', ${W1})`;
    const [p] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2ERET-${RUN}`}, 'Harina e2e agente', 'good', 'active',
              'unidad', 'gravado_general')
      returning id`;
    PROD = p!.id;
    const [px] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2ERET-X-${RUN}`}, 'Libro e2e exento', 'good', 'active',
              'unidad', 'exento')
      returning id`;
    PROD_EXENTO = px!.id;
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
    await tx`
      insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, transaction_type,
                                    product_tax_category, rate, effective_from, legal_source,
                                    priority)
      select 'VE', 'iva', null, 'purchase', 'gravado_general', 0.16, ${AYER}::date,
             ${`REGLA DE PRUEBA E2E agente ${RUN}`}, 50
       where not exists (select 1 from public.tax_rules
                          where company_id is null and transaction_type = 'purchase'
                            and jurisdiction = 'VE' and tax_code = 'iva'
                            and taxpayer_type is null
                            and product_tax_category = 'gravado_general')`;
    await tx`
      insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, transaction_type,
                                    product_tax_category, rate, effective_from, legal_source,
                                    priority)
      select 'VE', 'iva', null, 'purchase', 'exento', 0, ${AYER}::date,
             ${`REGLA DE PRUEBA E2E agente exento ${RUN}`}, 50
       where not exists (select 1 from public.tax_rules
                          where company_id is null and transaction_type = 'purchase'
                            and jurisdiction = 'VE' and tax_code = 'iva'
                            and taxpayer_type is null
                            and product_tax_category = 'exento')`;
    // El 75 %, PROPIO de la empresa, para cualquier proveedor (taxpayer_type null).
    await tx`insert into public.retention_rules
               (tenant_id, company_id, jurisdiction, retention_code, concept_code,
                taxpayer_type, formula_kind, rate, effective_from, legal_source, priority)
             values (${TENANT}, ${COMPANY}, 'VE', 'iva', 'iva_compras', null, 'rate', 0.75,
                     ${AYER}::date,
                     'Carga de prueba E2E — PA SNAT/2025/000054 art. 4. VALIDAR-SENIAT.', 50)`;
  });

  PROV_RIF = `J-5${String(Date.now()).slice(-7)}-0`;
  const prov = await pedir("POST", "/v1/suppliers", {
    company_id: COMPANY,
    tax_id: PROV_RIF,
    legal_name: "Proveedor ordinario e2e",
    supplier_kind: "nacional",
    person_type_code: "juridica",
    taxpayer_type_code: "ordinario",
    fiscal_address: "Calle 1, Valencia",
  });
  expect(prov.status).toBe(201);
  PROV = ((await prov.json()) as { id: string }).id;
  const formal = await pedir("POST", "/v1/suppliers", {
    company_id: COMPANY,
    tax_id: `V-1${String(Date.now()).slice(-7)}-0`,
    legal_name: "Proveedor formal e2e",
    supplier_kind: "nacional",
    person_type_code: "natural",
    taxpayer_type_code: "formal",
  });
  expect(formal.status).toBe(201);
  PROV_FORMAL = ((await formal.json()) as { id: string }).id;
  const noSujeto = await pedir("POST", "/v1/suppliers", {
    company_id: COMPANY,
    tax_id: `J-6${String(Date.now()).slice(-7)}-0`,
    legal_name: "Proveedor no sujeto e2e",
    supplier_kind: "nacional",
    person_type_code: "juridica",
    taxpayer_type_code: "no_sujeto",
  });
  expect(noSujeto.status).toBe(201);
  PROV_NO_SUJETO = ((await noSujeto.json()) as { id: string }).id;
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("el agente retiene solo y el comprobante es un documento", () => {
  it("H-01 · un especial registra una compra a un ordinario SIN retention_concepts: retiene el 75 % y emite el comprobante AAAAMM########", async () => {
    const r = await registrar({
      supplier_document_number: `F-${RUN}-1`,
      supplier_control_number: "00-0001001",
    });
    expect(r.status).toBe(201);
    const f = (await r.json()) as Record<string, unknown> & {
      retentions: Record<string, string>[];
    };
    FACTURA_1 = f["id"] as string;
    // 10 × 4 000 = 40 000; IVA 16 % = 6 400; retención 75 % = 4 800.
    expect(f["tax_amount"]).toBe("6400.00000000");
    expect(f["retention_total"]).toBe("4800.00000000");
    expect(f.retentions).toHaveLength(1);
    expect(f.retentions[0]!["concept_code"]).toBe("iva_compras");
    expect(f.retentions[0]!["rate_snapshot"]).toBe("0.75000000");
    const numero = f["retention_voucher_number"] as string;
    expect(numero).toMatch(new RegExp(`^${PERIODO}\\d{8}$`));
    COMPROBANTE_1 = f["retention_voucher_id"] as string;
    NUMERO_1 = numero;

    const v = await pedir("GET", `/v1/retention-vouchers/${COMPROBANTE_1}`);
    expect(v.status).toBe(200);
    const c = (await v.json()) as Record<string, unknown> & { lines: Record<string, string>[] };
    expect(c["voucher_number"]).toBe(numero);
    expect(c["issued_on"]).toBe(HOY);
    expect(c["mode"]).toBe("per_operation");
    expect(c["status"]).toBe("issued");
    expect(c["delivery_due_on"]).toBe(venceEntrega(HOY));
    expect(c["delivered_on"]).toBeNull();
    expect(c["agent_tax_id"]).toBe(RIF_AGENTE);
    expect(c["supplier_name"]).toBe("Proveedor ordinario e2e");
    expect(c["supplier_address"]).toBe("Calle 1, Valencia");
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toMatchObject({
      document_type: "01",
      document_number: `F-${RUN}-1`,
      control_number: "00-0001001",
      total_amount: "46400.00000000",
      taxable_base: "40000.00000000",
      exempt_amount: "0.00000000",
      iva_amount: "6400.00000000",
      tax_rate: "16.00000000",
      portion: "0.75000000",
      retained_amount: "4800.00000000",
    });
  });

  it("H-04 · el comprobante congela la identidad: cambiar el maestro no lo toca; corregirlo emite la versión 2 y anula la 1", async () => {
    await sql`update public.suppliers set fiscal_address = 'Calle 2, Maracay' where id = ${PROV}`;
    const antes = (await (
      await pedir("GET", `/v1/retention-vouchers/${COMPROBANTE_1}`)
    ).json()) as Record<string, string>;
    expect(antes["supplier_address"]).toBe("Calle 1, Valencia");

    const corto = await pedir("POST", `/v1/retention-vouchers/${COMPROBANTE_1}/corrections`, {
      company_id: COMPANY,
      reason: "corto",
    });
    expect(corto.status).toBe(422);

    const r = await pedir("POST", `/v1/retention-vouchers/${COMPROBANTE_1}/corrections`, {
      company_id: COMPANY,
      reason: "El proveedor mudó su domicilio fiscal antes de la entrega",
    });
    expect(r.status).toBe(201);
    const nuevo = (await r.json()) as Record<string, unknown> & { lines: unknown[] };
    COMPROBANTE_2 = nuevo["id"] as string;
    expect(nuevo["version_no"]).toBe(2);
    expect(nuevo["replaces_voucher_id"]).toBe(COMPROBANTE_1);
    expect(nuevo["supplier_address"]).toBe("Calle 2, Maracay");
    expect(nuevo["voucher_number"]).not.toBe(NUMERO_1);
    expect(nuevo["voucher_number"]).toMatch(new RegExp(`^${PERIODO}\\d{8}$`));
    expect(nuevo.lines).toHaveLength(1);

    const viejo = (await (
      await pedir("GET", `/v1/retention-vouchers/${COMPROBANTE_1}`)
    ).json()) as Record<string, string>;
    expect(viejo["status"]).toBe("annulled");
    expect(viejo["replaced_by_voucher_id"]).toBe(COMPROBANTE_2);

    // Una versión ya reemplazada no se corrige otra vez: se corrige la vigente.
    const otra = await pedir("POST", `/v1/retention-vouchers/${COMPROBANTE_1}/corrections`, {
      company_id: COMPANY,
      reason: "Segundo intento sobre la versión anulada",
    });
    expect(otra.status).toBe(422);
    // Y la factura dice cuál es su comprobante vigente.
    const [f] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.audit_events
       where aggregate_id = ${COMPROBANTE_2} and event_type = 'ap.retention_voucher_corrected'`;
    expect(f!.n).toBe("1");
  });

  it("H-04 · la entrega se anota una vez", async () => {
    // H11: ni en una versión anulada ni en el futuro.
    const anulada = await pedir("POST", `/v1/retention-vouchers/${COMPROBANTE_1}/delivery`, {
      company_id: COMPANY,
      delivered_on: HOY,
    });
    expect(anulada.status).toBe(422);
    expect(((await anulada.json()) as { message: string }).message).toMatch(/anulada/);
    const futura = await pedir("POST", `/v1/retention-vouchers/${COMPROBANTE_2}/delivery`, {
      company_id: COMPANY,
      delivered_on: diaCaracas(3),
    });
    expect(futura.status).toBe(422);
    expect(((await futura.json()) as { message: string }).message).toMatch(/futuro/);
    const r = await pedir("POST", `/v1/retention-vouchers/${COMPROBANTE_2}/delivery`, {
      company_id: COMPANY,
      delivered_on: HOY,
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as Record<string, string>)["delivered_on"]).toBe(HOY);
    const otra = await pedir("POST", `/v1/retention-vouchers/${COMPROBANTE_2}/delivery`, {
      company_id: COMPANY,
      delivered_on: HOY,
    });
    expect(otra.status).toBe(422);
    expect(((await otra.json()) as { message: string }).message).toMatch(/ya se entregó/);
  });

  it("H-01 · una exclusión marcada con motivo no retiene y queda auditada; la automática no se marca", async () => {
    const r = await registrar({
      supplier_document_number: `F-${RUN}-EX`,
      supplier_control_number: "00-0001002",
      // H7: 1 × 500 + 16 % = 580 Bs, por debajo de 20 UT (860 Bs con la UT de Bs 43).
      lines: [{ product_id: PROD, quantity: "1", unit_price: "500" }],
      retention_exclusion: {
        code: "caja_chica_20ut",
        reason: "Compra menor pagada con la caja chica del local",
      },
    });
    expect(r.status).toBe(201);
    const f = (await r.json()) as Record<string, unknown>;
    expect(f["retention_total"]).toBe("0.00000000");
    expect(f["retention_voucher_number"]).toBeNull();
    expect(f["retention_exclusion_code"]).toBe("caja_chica_20ut");
    const [a] = await sql<{ p: Record<string, string> }[]>`
      select payload as p from public.audit_events
       where aggregate_id = ${f["id"] as string} and event_type = 'ap.retention_excluded'`;
    expect(a!.p["reason"]).toBe("Compra menor pagada con la caja chica del local");

    // H7 (art. 3 num. 6 y 7): la caja chica vale hasta 20 UT por operación; 46 400 Bs no.
    const grande = await registrar({
      supplier_document_number: `F-${RUN}-EXG`,
      supplier_control_number: "00-0001011",
      retention_exclusion: { code: "caja_chica_20ut", reason: "Compra grande por la caja chica" },
    });
    expect(grande.status).toBe(422);
    expect(((await grande.json()) as { message: string }).message).toMatch(/20 UT/);
    // H8: la de los entes públicos (num. 11 y 12) no la marca una empresa privada.
    const ente = await registrar({
      supplier_document_number: `F-${RUN}-EXE`,
      supplier_control_number: "00-0001012",
      lines: [{ product_id: PROD, quantity: "1", unit_price: "500" }],
      retention_exclusion: { code: "ente_publico", reason: "Intento de marcar la de entes" },
    });
    expect(ente.status).toBe(422);
    expect(((await ente.json()) as { message: string }).message).toMatch(/entes públicos/);

    const auto = await registrar({
      supplier_document_number: `F-${RUN}-EX2`,
      supplier_control_number: "00-0001003",
      retention_exclusion: { code: "proveedor_formal", reason: "Intento de marcar la automática" },
    });
    expect(auto.status).toBe(422);
    expect(((await auto.json()) as { message: string }).message).toMatch(/servidor solo/);

    const formal = await registrar({
      supplier_id: PROV_FORMAL,
      supplier_document_number: `F-${RUN}-FOR`,
      supplier_control_number: "00-0001004",
    });
    expect(formal.status).toBe(201);
    const ff = (await formal.json()) as Record<string, unknown>;
    expect(ff["retention_total"]).toBe("0.00000000");
    expect(ff["retention_voucher_number"]).toBeNull();
  });

  it("H6 · al proveedor no sujeto: sin IVA se registra sin pedir nada; con IVA, hay que decir qué hacer", async () => {
    const sinIva = await registrar({
      supplier_id: PROV_NO_SUJETO,
      supplier_document_number: `F-${RUN}-NS0`,
      supplier_control_number: "00-0001013",
      lines: [{ product_id: PROD_EXENTO, quantity: "2", unit_price: "100" }],
    });
    expect(sinIva.status).toBe(201);
    const f = (await sinIva.json()) as Record<string, unknown>;
    expect(f["tax_amount"]).toBe("0.00000000");
    expect(f["retention_voucher_number"]).toBeNull();
    const conIva = await registrar({
      supplier_id: PROV_NO_SUJETO,
      supplier_document_number: `F-${RUN}-NS1`,
      supplier_control_number: "00-0001014",
    });
    expect(conIva.status).toBe(422);
    expect(((await conIva.json()) as { message: string }).message).toMatch(/Retención de IVA/);
  });

  it("H-01 · sin regla vigente del 100 % (art. 5), la factura se detiene con RETENTION_RULE_MISSING y no existe", async () => {
    const r = await registrar({
      supplier_document_number: `F-${RUN}-100`,
      supplier_control_number: "00-0001005",
      iva_retention_full_reason: "factura_sin_requisitos",
    });
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("RETENTION_RULE_MISSING");
    // El mensaje del esquema: dice QUÉ concepto falta, no uno genérico.
    expect(cuerpo.message).toMatch(/iva_compras_total/);
    const [n] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.supplier_invoices
       where company_id = ${COMPANY} and supplier_document_number = ${`F-${RUN}-100`}`;
    expect(n!.n).toBe("0");
  });

  it("H-12 · el libro de compras identifica el comprobante emitido en el período: número, fecha e IVA retenido", async () => {
    const filas = await sql<Record<string, string | null>[]>`
      select invoice_id, status, retention_voucher_number,
             retention_voucher_date::text as retention_voucher_date,
             retention_voucher_iva::text as retention_voucher_iva
        from platform.purchases_book_with_vouchers(${COMPANY}, ${HOY}::date, ${HOY}::date)
       where invoice_id = ${FACTURA_1}`;
    expect(filas).toHaveLength(1);
    const [vigente] = await sql<{ n: string }[]>`
      select voucher_number as n from public.retention_vouchers where id = ${COMPROBANTE_2}`;
    expect(filas[0]).toEqual({
      invoice_id: FACTURA_1,
      status: "posted",
      retention_voucher_number: vigente!.n,
      retention_voucher_date: HOY,
      retention_voucher_iva: "4800.00000000",
    });
  });

  it("L-03 · el TXT de la quincena lleva los 16 campos de P-7, solo la versión vigente y solo sus operaciones", async () => {
    const [d] = await sql<
      { desde: string; hasta: string; otra_desde: string; otra_hasta: string }[]
    >`
      select q.fortnight_start::text as desde, q.fortnight_end::text as hasta,
             o.fortnight_start::text as otra_desde, o.fortnight_end::text as otra_hasta
        from platform.retention_fortnight(${HOY}::date) q
       cross join lateral platform.retention_fortnight(
         case when extract(day from ${HOY}::date) <= 15 then q.fortnight_end + 1
              else q.fortnight_start - 1 end) o`;
    const exportar = async (desde: string, hasta: string) => {
      const r = await pedir("POST", "/v1/fiscal-books/export", {
        company_id: COMPANY,
        book_kind: "retenciones_iva",
        period_from: desde,
        period_to: hasta,
        format_code: "txt_retenciones_iva",
        timezone: "America/Caracas",
      });
      expect(r.status).toBe(201);
      return ((await r.json()) as { content: string }).content;
    };
    const txt = await exportar(d!.desde, d!.hasta);
    const lineas = txt.split("\r\n").filter((l) => l.includes(`F-${RUN}-1\t`));
    // La versión 1 (anulada) no sale: solo la 2.
    expect(lineas).toHaveLength(1);
    const [vigente] = await sql<{ n: string }[]>`
      select voucher_number as n from public.retention_vouchers where id = ${COMPROBANTE_2}`;
    const sinGuiones = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    expect(lineas[0]).toBe(
      [
        sinGuiones(RIF_AGENTE),
        d!.desde.slice(0, 7).replace("-", ""),
        HOY,
        "C",
        "01",
        sinGuiones(PROV_RIF),
        `F-${RUN}-1`,
        "00-0001001",
        "46400.00",
        "40000.00",
        "4800.00",
        "0",
        vigente!.n,
        "0.00",
        "16.00",
        "0",
      ].join("\t"),
    );
    // La OTRA quincena del mismo mes no contiene nada de esta.
    if (d!.otra_desde.slice(0, 7) === d!.desde.slice(0, 7)) {
      const otra = await exportar(d!.otra_desde, d!.otra_hasta);
      expect(otra.includes(`F-${RUN}-`)).toBe(false);
    }
  });

  it("pago en partes: el comprobante ya existe desde el registro, el proveedor cobra el neto y nada se retiene otra vez", async () => {
    const r = await registrar({
      supplier_document_number: `F-${RUN}-2`,
      supplier_control_number: "00-0001006",
    });
    expect(r.status).toBe(201);
    const f = (await r.json()) as Record<string, string>;
    const numero = f["retention_voucher_number"];
    expect(numero).toMatch(/^\d{14}$/);
    // Lo que se le debe al proveedor es el NETO: 46 400 − 4 800.
    const [saldo] = await sql<{ s: string }[]>`
      select platform.supplier_invoice_balance(${COMPANY}, ${f["id"]!})::text as s`;
    expect(saldo!.s).toBe("41600.00000000");
    for (const monto of ["20000", "21600"]) {
      const p = await pedir("POST", "/v1/supplier-payments", {
        company_id: COMPANY,
        supplier_invoice_id: f["id"],
        gross_amount: monto,
        currency: "VES",
        instrument: "transferencia",
        allow_negative_balance: true,
      });
      expect(p.status).toBe(201);
      const pago = (await p.json()) as { payment: Record<string, string> };
      expect(pago.payment["retained_amount"]).toBe("0.00000000");
      expect(pago.payment["net_amount"]).toBe(`${monto}.00000000`);
    }
    const [despues] = await sql<{ status: string; comprobantes: string; numero: string }[]>`
      select i.status,
             (select count(distinct l.retention_voucher_id) from public.retention_voucher_lines l
               where l.supplier_invoice_id = i.id)::text as comprobantes,
             (select v.voucher_number from public.retention_voucher_lines l
                join public.retention_vouchers v on v.id = l.retention_voucher_id
               where l.supplier_invoice_id = i.id) as numero
        from public.supplier_invoices i where i.id = ${f["id"]!}`;
    expect(despues).toEqual({ status: "paid", comprobantes: "1", numero });
  });

  it("H-01 · la llegada de mercancía con factura retiene igual y emite su comprobante", async () => {
    const r = await pedir("POST", "/v1/arrivals", {
      company_id: COMPANY,
      warehouse_id: W1,
      currency: "VES",
      supplier_id: PROV,
      invoice: "present",
      supplier_document_number: `F-${RUN}-LL`,
      supplier_control_number: "00-0001007",
      lines: [{ product_id: PROD, quantity: "5", unit_amount: "1000" }],
    });
    expect(r.status).toBe(201);
    const llegada = (await r.json()) as { invoice: Record<string, string> };
    // 5 000 + 800 de IVA; retención 600.
    expect(llegada.invoice["retention_total"]).toBe("600.00000000");
    expect(llegada.invoice["retention_voucher_number"]).toMatch(/^\d{14}$/);
  });

  it("el modo por quincena agrupa en un comprobante las compras al mismo proveedor", async () => {
    const m = await pedir("PUT", "/v1/retention-vouchers/settings", {
      company_id: COMPANY,
      mode: "per_fortnight",
    });
    expect(m.status).toBe(200);
    const a = (await (
      await registrar({
        supplier_document_number: `F-${RUN}-Q1`,
        supplier_control_number: "00-0001008",
      })
    ).json()) as Record<string, string>;
    const b = (await (
      await registrar({
        supplier_document_number: `F-${RUN}-Q2`,
        supplier_control_number: "00-0001009",
      })
    ).json()) as Record<string, string>;
    expect(a["retention_voucher_id"]).toBe(b["retention_voucher_id"]);
    const c = (await (
      await pedir("GET", `/v1/retention-vouchers/${a["retention_voucher_id"]!}`)
    ).json()) as { mode: string; lines: unknown[]; total_retained: string };
    expect(c.mode).toBe("per_fortnight");
    expect(c.lines).toHaveLength(2);
    expect(c.total_retained).toBe("9600.00000000");

    // H9(b): una vez ENTREGADO, el de la quincena no recibe más renglones: la compra siguiente
    // abre otro comprobante.
    const e = await pedir("POST", `/v1/retention-vouchers/${a["retention_voucher_id"]!}/delivery`, {
      company_id: COMPANY,
      delivered_on: HOY,
    });
    expect(e.status).toBe(200);
    const d = (await (
      await registrar({
        supplier_document_number: `F-${RUN}-Q3`,
        supplier_control_number: "00-0001010",
      })
    ).json()) as Record<string, string>;
    expect(d["retention_voucher_id"]).not.toBe(a["retention_voucher_id"]);
    const viejo = (await (
      await pedir("GET", `/v1/retention-vouchers/${a["retention_voucher_id"]!}`)
    ).json()) as { lines: unknown[] };
    expect(viejo.lines).toHaveLength(2);
  });

  it("H7 · el catálogo de exclusiones marcables viene del servidor (sin las automáticas)", async () => {
    const r = await pedir("GET", "/v1/retention-exclusions");
    expect(r.status).toBe(200);
    const codigos = ((await r.json()) as { items: { code: string }[] }).items.map((x) => x.code);
    expect(codigos).toContain("caja_chica_20ut");
    expect(codigos).toContain("servicio_publico_domiciliado");
    expect(codigos).not.toContain("proveedor_formal");
  });

  it("el PDF del comprobante sale", async () => {
    const r = await pedir("GET", `/v1/retention-vouchers/${COMPROBANTE_2}/pdf`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("application/pdf");
    const texto = await textoDelPdf(r);
    // H2: los importes con miles y coma decimal (antes la regex sin barras daba «—»).
    expect(texto).toContain("4.800,00"); // IVA retenido del renglón
    expect(texto).toContain("46.400,00"); // total del documento
    expect(texto).toContain("Total IVA retenido: Bs. 4.800,00");
    expect(texto).toContain("75 %");
  });
  it("A-1 · en modo por quincena, una compra nueva tras corregir un comprobante de la quincena anterior sale en el TXT", async () => {
    const modo = await pedir("PUT", "/v1/retention-vouchers/settings", {
      company_id: COMPANY,
      mode: "per_fortnight",
    });
    expect(modo.status).toBe(200);
    // Modo por quincena (propio de este caso). Una compra que abre o llena el comprobante
    // de la quincena, que se lleva a la quincena ANTERIOR (como si se hubiera emitido entonces).
    const x = (await (
      await registrar({
        supplier_document_number: `F-${RUN}-A1X`,
        supplier_control_number: "00-0001016",
      })
    ).json()) as Record<string, string>;
    const v1 = x["retention_voucher_id"]!;
    const [q] = await sql<{ desde: string; hasta: string; ant_desde: string; ant_hasta: string }[]>`
      select q.fortnight_start::text as desde, q.fortnight_end::text as hasta,
             a.fortnight_start::text as ant_desde, a.fortnight_end::text as ant_hasta
        from platform.retention_fortnight(${HOY}::date) q
       cross join lateral platform.retention_fortnight(q.fortnight_start - 1) a`;
    await sql.begin(async (tx) => {
      // Solo en el fixture: se salta el guardián para fechar el comprobante en la quincena pasada.
      await tx`set local session_replication_role = replica`;
      await tx`update public.retention_vouchers
                 set issued_on = ${q!.ant_desde}::date,
                     voucher_period = to_char(${q!.ant_desde}::date, 'YYYYMM'),
                     fortnight_start = ${q!.ant_desde}::date, fortnight_end = ${q!.ant_hasta}::date,
                     delivery_due_on = platform.retention_voucher_due_on(${q!.ant_hasta}::date)
               where id = ${v1}`;
    });
    const c = await pedir("POST", `/v1/retention-vouchers/${v1}/corrections`, {
      company_id: COMPANY,
      reason: "El RIF del proveedor estaba mal escrito en el comprobante",
    });
    expect(c.status).toBe(201);
    const v2 = ((await c.json()) as { id: string }).id;
    // La compra NUEVA no cae en la corrección (a): abre su propio comprobante.
    const y = (await (
      await registrar({
        supplier_document_number: `F-${RUN}-A1Y`,
        supplier_control_number: "00-0001017",
      })
    ).json()) as Record<string, string>;
    expect(y["retention_voucher_id"]).not.toBe(v2);
    // Y el TXT de esta quincena la trae; la corrección de lo ya declarado no, y se avisa (b).
    const r = await pedir("POST", "/v1/fiscal-books/export", {
      company_id: COMPANY,
      book_kind: "retenciones_iva",
      period_from: q!.desde,
      period_to: q!.hasta,
      format_code: "txt_retenciones_iva",
      timezone: "America/Caracas",
    });
    expect(r.status).toBe(201);
    const cuerpo = (await r.json()) as { content: string; warnings?: string[] };
    expect(cuerpo.content).toContain(`F-${RUN}-A1Y\t`);
    expect(cuerpo.content).not.toContain(`F-${RUN}-A1X\t`);
    expect(cuerpo.warnings?.join(" ")).toMatch(/P-65/);
    // El invariante sigue en cero.
    const [g] = await sql<{ n: string }[]>`
      select count(*)::text as n from platform.retention_voucher_gaps(${COMPANY})`;
    expect(g!.n).toBe("0");
  });

  it("A-4 · un documento con varias alícuotas detiene el TXT con su lista y P-69, y no registra la generación", async () => {
    const [p8] = await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${USUARIO}, true)`;
      await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
      await tx`
        insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, transaction_type,
                                      product_tax_category, rate, effective_from, legal_source,
                                      priority)
        select 'VE', 'iva', null, 'purchase', 'gravado_reducida', 0.08, ${AYER}::date,
               ${`REGLA DE PRUEBA E2E agente reducida ${RUN}`}, 50
         where not exists (select 1 from public.tax_rules
                            where company_id is null and transaction_type = 'purchase'
                              and jurisdiction = 'VE' and tax_code = 'iva'
                              and taxpayer_type is null
                              and product_tax_category = 'gravado_reducida')`;
      return tx<{ id: string }[]>`
        insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                     tax_category_code)
        values (${TENANT}, ${COMPANY}, ${`E2ERET-R-${RUN}`}, 'Alimento e2e reducida', 'good',
                'active', 'unidad', 'gravado_reducida')
        returning id`;
    });
    const f = await registrar({
      supplier_document_number: `F-${RUN}-MIX`,
      supplier_control_number: "00-0001018",
      lines: [
        { product_id: PROD, quantity: "1", unit_price: "1000" },
        { product_id: p8!.id, quantity: "1", unit_price: "1000" },
      ],
    });
    expect(f.status).toBe(201);
    const [antes] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.fiscal_book_runs where company_id = ${COMPANY}`;
    const r = await pedir("POST", "/v1/fiscal-books/export", {
      company_id: COMPANY,
      book_kind: "retenciones_iva",
      period_from: HOY,
      period_to: HOY,
      format_code: "txt_retenciones_iva",
      timezone: "America/Caracas",
    });
    expect(r.status).toBe(422);
    const m = ((await r.json()) as { message: string }).message;
    expect(m).toContain(`F-${RUN}-MIX (`);
    expect(m).toMatch(/más de una alícuota/);
    expect(m).toMatch(/P-69/);
    const [despues] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.fiscal_book_runs where company_id = ${COMPANY}`;
    expect(despues!.n).toBe(antes!.n);
  });

  // ÚLTIMO a propósito: cambia el tipo de la empresa desde hoy.
  it("H12 · el agente se decide por el día del REGISTRO: ordinario desde hoy no retiene una factura de ayer", async () => {
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${USUARIO}, true)`;
      await tx`insert into public.company_taxpayer_types
                 (tenant_id, company_id, taxpayer_type_code, effective_from, reason, rules_version)
               values (${TENANT}, ${COMPANY}, 'ordinario', ${HOY}::date,
                       'E2E H12: deja de ser especial desde hoy', 'e2e')`;
    });
    const r = await registrar({
      supplier_document_number: `F-${RUN}-H12`,
      supplier_control_number: "00-0001015",
      invoice_date: AYER,
    });
    expect(r.status).toBe(201);
    const f = (await r.json()) as Record<string, unknown>;
    // Ayer era especial; hoy, el día del abono en cuenta (R-3), ya no es agente: no retiene.
    expect(f["retention_total"]).toBe("0.00000000");
    expect(f["retention_voucher_number"]).toBeNull();
  });
});

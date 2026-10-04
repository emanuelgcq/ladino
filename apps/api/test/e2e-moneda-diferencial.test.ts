import { describe, expect, it, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";
import { fiadoDeFixture } from "./_fiado-de-fixture.js";
import { borrarTasasOficiales } from "./_tasa-oficial.js";

/**
 * MONEDA A (ADR-0075 §1-4): el cálculo fiscal en Bs, el pago cruzado y el diferencial al pagar.
 *
 *   E-05 — el IVA en Bs de la factura es alícuota × base en Bs, por línea;
 *   D-02 — una factura se paga en la otra moneda, a la tasa del día del pago;
 *   D-07 / H-02 — el pago a proveedor reconoce el diferencial y cancela la CxP a la tasa de registro;
 *   F-15 / G-12 — el cobro o pago que cierra deja el mayor del documento en cero exacto;
 *   F-02 — lo saldado por cada cobro queda congelado en la moneda del documento.
 *
 * Las tasas son las del recorrido (854,4637 → 855,6625): con ellas el IVA en USD no cae exacto.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
// `let`: el bloque «ola 4 · cobros» corre en una empresa PROPIA y las cambia mientras dura.
let TENANT = crypto.randomUUID();
let COMPANY = crypto.randomUUID();
let W1 = crypto.randomUUID();
const DUENO = crypto.randomUUID();
let CLIENTE = crypto.randomUUID();
const PROVEEDOR = crypto.randomUUID();
const ROL = crypto.randomUUID();
// La empresa SIN contabilidad: todo asiento va a la cola y el cierre usa el respaldo calculado.
const TENANT2 = crypto.randomUUID();
const COMPANY2 = crypto.randomUUID();
const W2 = crypto.randomUUID();
const CLIENTE2 = crypto.randomUUID();
const PROVEEDOR2 = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const AYER = diaCaracas(-1);
const FUENTE = `e2e-moneda-a-${RUN}`;

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let BROCHA = "";
let HARINA = "";
let LISTA_BS = "";
let BANCO_USD = "";
let BANCO_BS = "";
let BROCHA2 = "";
let HARINA2 = "";

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

// La tabla de tasas es GLOBAL y este fichero necesita UNA para hoy, la suya. Cada caso corre con
// el candado común de los E2E tomado (a nivel de sesión, en una conexión reservada): quien
// siembre su tasa bajo ese candado espera a que el caso termine, y no la cambia a mitad de un
// cobro. Bajo el candado se retira la que haya para hoy y se pone la propia: ningún test depende
// de «a igual día manda la guardada más tarde».
let candado: Awaited<ReturnType<ReturnType<typeof createClient>["reserve"]>>;
const tomarCandado = async (): Promise<void> => {
  await candado`select pg_advisory_lock(hashtext('ladino-e2e-rates'))`;
};
const soltarCandado = async (): Promise<void> => {
  await candado`select pg_advisory_unlock_all()`;
};
/** Pone LA tasa de hoy. Se llama siempre con el candado tomado. */
async function tasa(rate: string): Promise<void> {
  await candado`
    delete from public.exchange_rates
     where company_id is null and from_currency = 'USD' and to_currency = 'VES'
       and rate_date = ${HOY}::date`;
  await candado`
    insert into public.exchange_rates
      (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
    values ('USD', 'VES', ${rate}::numeric, ${FUENTE}, ${HOY}::date, now())`;
}
beforeEach(tomarCandado);
afterEach(soltarCandado);

/** Factura de N brochas (2,40 USD c/u, o 1.000 Bs en la lista en bolívares). */
async function facturar(cantidad: string, lista?: string): Promise<Record<string, string>> {
  const r = await pedir("POST", "/v1/invoices", {
    company_id: COMPANY,
    customer_id: CLIENTE,
    warehouse_id: W1,
    series: "A",
    ...(lista === undefined ? {} : { price_list_id: lista }),
    lines: [{ product_id: BROCHA, quantity: cantidad }],
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return (await r.json()) as Record<string, string>;
}

/** Factura de varias líneas de brochas (una cantidad por línea), en la empresa que se diga. */
async function facturarLineas(
  cantidades: readonly string[],
  e: { company: string; cliente: string; w: string; brocha: string } = {
    company: COMPANY,
    cliente: CLIENTE,
    w: W1,
    brocha: BROCHA,
  },
): Promise<Record<string, string>> {
  const r = await pedir(
    "POST",
    "/v1/invoices",
    {
      company_id: e.company,
      customer_id: e.cliente,
      warehouse_id: e.w,
      series: "A",
      lines: cantidades.map((q) => ({ product_id: e.brocha, quantity: q })),
    },
    e.company,
  );
  expect(r.status, await r.clone().text()).toBe(201);
  return (await r.json()) as Record<string, string>;
}

interface Cobro {
  payment: Record<string, string>;
  exchange_difference: Record<string, string> | null;
  document_status: string;
}
async function cobrar(
  doc: string,
  cuerpo: Record<string, string>,
  empresa: string = COMPANY,
): Promise<Cobro> {
  const r = await pedir(
    "POST",
    "/v1/payments",
    { company_id: empresa, document_id: doc, ...cuerpo },
    empresa,
  );
  expect(r.status, await r.clone().text()).toBe(201);
  return (await r.json()) as Cobro;
}

/** Lo que el mayor todavía le carga al documento en cuentas por cobrar / por pagar. */
async function abierto(
  lado: "ar" | "ap",
  id: string,
  empresa: string = COMPANY,
): Promise<string | null> {
  const [f] = await sql<{ v: string | null }[]>`
    select platform.settlement_ledger_open(${empresa}, ${lado}, ${id})::text as v`;
  return f!.v;
}

/** La deuda por la ÚNICA función de deuda (de la familia «moneda B»): nominal y Bs de hoy. */
async function deuda(id: string): Promise<{ nominal: string; hoy: string }> {
  const [f] = await sql<{ nominal: string; hoy: string }[]>`
    select nominal::text as nominal, functional_today::text as hoy
      from platform.document_debt(${COMPANY}, ${id})`;
  return f!;
}

/** Un cobro que el dominio DEBE rechazar: devuelve el cuerpo del error. */
async function rechazado(
  path: string,
  cuerpo: Record<string, unknown>,
): Promise<{ status: number; code: string; message: string }> {
  const r = await pedir("POST", path, { company_id: COMPANY, ...cuerpo });
  const b = (await r.json()) as { code: string; message: string };
  return { status: r.status, code: b.code, message: b.message };
}

/** Las líneas del asiento de un hecho, por papel de cuenta. */
async function asiento(
  sourceKind: string,
  sourceId: string,
): Promise<{ papel: string | null; debe: string; haber: string }[]> {
  return sql<{ papel: string | null; debe: string; haber: string }[]>`
    select (select min(s.purpose) from public.company_account_settings s
             where s.company_id = l.company_id and s.account_id = l.account_id
               and s.purpose in ('ap_general', 'ar_general', 'exchange_gain', 'exchange_loss',
                                 'rounding_difference')) as papel,
           -- En BOLÍVARES: debit_amount / credit_amount llevan el original en divisa (H1, H6).
           l.functional_debit::text as debe, l.functional_credit::text as haber
      from public.journal_entries e
      join public.journal_lines l on l.entry_id = e.id
     where e.company_id = ${COMPANY} and e.source_kind = ${sourceKind}
       and e.source_id = ${sourceId} and e.status = 'posted'
     order by l.line_number`;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e moneda A')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J${String(Date.now()).slice(-9)}`},
                     'Ferretería del diferencial', 'VES', 'ordinario')`;
    await declararTipoDeFixture(tx, COMPANY);
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-MONA', 'Local')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2emoneda_${RUN}`}, 'Dueño', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.payment.register'),
             (${ROL}, 'ar.read'), (${ROL}, 'supplier.manage'),
             (${ROL}, 'purchase.invoice.register'), (${ROL}, 'purchase.payment.register'),
             (${ROL}, 'ap.read'), (${ROL}, 'treasury.read'),
             (${ROL}, 'treasury.account.manage'), (${ROL}, 'inventory.move'),
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.entry.post'), (${ROL}, 'accounting.read'),
             (${ROL}, 'fiscal.range.manage'), (${ROL}, 'sales.price_list.override'),
             (${ROL}, 'ar.retention.register'), (${ROL}, 'ar.payment.reverse'), (${ROL}, 'purchase.credit_note.register')
             on conflict do nothing`;
    const mem = crypto.randomUUID();
    const asig = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${mem}, ${TENANT}, ${DUENO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${asig}, ${TENANT}, ${mem}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, ${asig}, 'warehouse', ${W1})`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${TENANT}, ${COMPANY}, 'formatos_libres', '2026-01-01'::timestamptz)`;
    await tx`insert into public.customers
               (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                taxpayer_type_code)
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, ${`J${String(Date.now() + 7).slice(-9)}`},
                     'Constructora e2e moneda', 'juridica', 'ordinario')`;
    // R-82.1: la factura de administración nace fiada — la empresa de prueba declara que fía.
    await fiadoDeFixture(tx, COMPANY, [ROL]);
    await tx`insert into public.suppliers
               (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code,
                taxpayer_type_code)
             values (${PROVEEDOR}, ${TENANT}, ${COMPANY}, ${`J${String(Date.now() + 13).slice(-9)}`},
                     'Distribuidora e2e moneda', 'nacional', 'juridica', 'ordinario')`;
    const [b] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`MONA-BRO-${RUN}`}, 'Brocha (servicio de pintura)',
              'service', 'active', 'unidad', 'gravado_general') returning id`;
    BROCHA = b!.id;
    const [h] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`MONA-HAR-${RUN}`}, 'Harina', 'good', 'active', 'unidad',
              'gravado_general') returning id`;
    HARINA = h!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, 'detal', 'USD') returning id`;
    const [lb] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, 'detal en bolívares', 'VES') returning id`;
    LISTA_BS = lb!.id;
    await tx`insert into public.company_settings (company_id, tenant_id, default_price_list_id)
             values (${COMPANY}, ${TENANT}, ${l!.id})`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${l!.id}, ${BROCHA}, 2.40, now() - interval '1 day'),
                    (${TENANT}, ${COMPANY}, ${LISTA_BS}, ${BROCHA}, 1000,
                     now() - interval '1 day')`;
    // La segunda empresa: igual, pero SIN plan de cuentas ni plantillas.
    await tx`insert into public.tenants (id, name) values (${TENANT2}, 'Tenant e2e moneda X')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code)
             values (${COMPANY2}, ${TENANT2}, ${`J${String(Date.now() + 101).slice(-9)}`},
                     'Bodega sin contabilidad', 'VES', 'ordinario')`;
    await declararTipoDeFixture(tx, COMPANY2);
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W2}, ${TENANT2}, ${COMPANY2}, 'E2E-MONX', 'Local')`;
    const mem2 = crypto.randomUUID();
    const asig2 = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${mem2}, ${TENANT2}, ${DUENO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${asig2}, ${TENANT2}, ${mem2}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT2}, ${COMPANY2}, ${asig2}, 'warehouse', ${W2})`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${TENANT2}, ${COMPANY2}, 'formatos_libres', '2026-01-01'::timestamptz)`;
    await tx`insert into public.customers
               (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                taxpayer_type_code)
             values (${CLIENTE2}, ${TENANT2}, ${COMPANY2},
                     ${`J${String(Date.now() + 107).slice(-9)}`},
                     'Constructora e2e moneda X', 'juridica', 'ordinario')`;
    await fiadoDeFixture(tx, COMPANY2, [ROL]);
    await tx`insert into public.suppliers
               (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code,
                taxpayer_type_code)
             values (${PROVEEDOR2}, ${TENANT2}, ${COMPANY2},
                     ${`J${String(Date.now() + 113).slice(-9)}`},
                     'Distribuidora e2e moneda X', 'nacional', 'juridica', 'ordinario')`;
    const [b2] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT2}, ${COMPANY2}, ${`MONX-BRO-${RUN}`}, 'Brocha (servicio de pintura)',
              'service', 'active', 'unidad', 'gravado_general') returning id`;
    BROCHA2 = b2!.id;
    const [h2] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT2}, ${COMPANY2}, ${`MONX-HAR-${RUN}`}, 'Harina', 'good', 'active', 'unidad',
              'gravado_general') returning id`;
    HARINA2 = h2!.id;
    const [l2] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT2}, ${COMPANY2}, 'detal', 'USD') returning id`;
    await tx`insert into public.company_settings (company_id, tenant_id, default_price_list_id)
             values (${COMPANY2}, ${TENANT2}, ${l2!.id})`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT2}, ${COMPANY2}, ${l2!.id}, ${BROCHA2}, 2.40,
                     now() - interval '1 day')`;
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
    for (const tipo of ["sale", "purchase"]) {
      await tx`
        insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                                      rate, effective_from, legal_source, priority,
                                      transaction_type)
        select 'VE', 'iva', 'ordinario', 'gravado_general', 0.16, ${AYER}::date,
               'Carga de prueba E2E — VALIDAR-SENIAT antes de producción.', 10, ${tipo}
         where not exists (select 1 from public.tax_rules
                            where company_id is null and jurisdiction = 'VE' and tax_code = 'iva'
                              and taxpayer_type = 'ordinario'
                              and product_tax_category = 'gravado_general'
                              and transaction_type = ${tipo})`;
    }
  });
  candado = await sql.reserve();
  await tomarCandado();
  await tasa("854.46370000");
  for (const [ruta, cuerpo] of [
    ["/v1/accounts/import-template", { company_id: COMPANY, template_code: "ve_basico" }],
    ["/v1/journal-templates/import-preset", { company_id: COMPANY, preset_code: "ve_basico" }],
  ] as const) {
    expect((await pedir("POST", ruta, cuerpo)).status).toBe(201);
  }
  for (const empresa of [COMPANY, COMPANY2]) {
    const rango = await pedir(
      "POST",
      "/v1/fiscal-number-ranges",
      {
        company_id: empresa,
        kind: "invoice",
        series: "A",
        range_from: "1",
        range_to: "500",
        printer_source: "Imprenta E2E moneda",
        printer_legal_name: "Imprenta E2E, C.A.",
        printer_tax_id: "J-12345678-9",
        printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
        printer_authorization_date: "2020-01-15",
        printed_on: "2026-01-01",
      },
      empresa,
    );
    if (rango.status !== 201) throw new Error(`rango: ${rango.status} ${await rango.text()}`);
  }
  for (const [nombre, moneda] of [
    ["Banco USD", "USD"],
    ["Banco Bs", "VES"],
  ] as const) {
    const r = await pedir("POST", "/v1/treasury/accounts", {
      company_id: COMPANY,
      name: `${nombre} ${RUN}`,
      currency: moneda,
      kind: "bank",
    });
    if (r.status !== 201) throw new Error(`cuenta: ${r.status} ${await r.text()}`);
    const id = ((await r.json()) as { id: string }).id;
    if (moneda === "USD") BANCO_USD = id;
    else BANCO_BS = id;
  }
  await soltarCandado();
});

afterAll(async () => {
  await borrarTasasOficiales(sql, FUENTE);
  candado?.release();
  await sql?.end();
  await sqlApi?.end();
});

describe("moneda A: el fiscal en Bs, el pago cruzado y el diferencial al pagar (ADR-0075 §1-4)", () => {
  let A = "";
  let B = "";

  it("E-05 · el IVA en Bs es el 16 % de la base en Bs, y la deuda sigue siendo el total en USD", async () => {
    await tasa("854.46370000"); // la tabla es global: cada caso pone la suya
    // 4 brochas a 2,40 = 9,60 USD; su IVA en USD es 1,536 → 1,54. A 854,4637:
    //   base Bs = round(9,60 × 854,4637, 2) = 8.202,85
    //   IVA Bs  = round(8.202,85 × 0,16, 2) = 1.312,46   (antes: 1,54 × tasa = 1.315,87)
    const doc = await facturar("4");
    A = doc["id"]!;
    const [d] = await sql<Record<string, string>[]>`
      select subtotal_amount::text as base, tax_amount::text as iva, total_amount::text as total,
             amount_transaction_currency::text as usd
        from public.documents where id = ${A}`;
    expect(d).toEqual({
      base: "8202.85000000",
      iva: "1312.46000000",
      total: "9515.31000000",
      usd: "11.14000000",
    });
    const huecos = await sql`select * from platform.fiscal_amount_gaps(${COMPANY})`;
    expect(huecos).toEqual([]);
  });

  it("D-02 + F-15 · ganancia: se abona en USD y se cierra en Bs a otra tasa; la CxC queda en cero exacto", async () => {
    await tasa("855.66250000");
    // La factura B nace a 855,6625 (se cobrará después, a una tasa menor).
    B = (await facturar("4"))["id"]!;

    const abono = await cobrar(A, {
      currency: "USD",
      amount: "5.00000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    // 5 USD × (855,6625 − 854,4637) = 5,99 de ganancia.
    expect(abono.exchange_difference?.["difference"]).toBe("5.99000000");
    expect(abono.document_status).toBe("issued");

    // El resto, 6,14 USD, en BOLÍVARES a la tasa del día: 6,14 × 855,6625 = 5.253,77.
    const cierre = await cobrar(A, {
      currency: "VES",
      amount: "5253.77000000",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect(cierre.document_status).toBe("paid");

    // Lo saldado por cada cobro, congelado en la moneda del documento, suma el total exacto.
    const saldado = await sql<{ s: string | null }[]>`
      select settled_transaction_amount::text as s from public.payments
       where document_id = ${A} order by created_at, id`;
    expect(saldado.map((x) => x.s)).toEqual(["5.00000000", "6.14000000"]);

    // El mayor: lo acreditado a cuentas por cobrar por los dos cobros es EXACTAMENTE lo que la
    // factura cargó (9.515,31), y todo lo demás fue a ganancia en diferencial.
    expect(await abierto("ar", A)).toBe("0.00000000");
    const [suma] = await sql<{ dif: string }[]>`
      select sum(difference)::text as dif from public.exchange_gain_loss where document_id = ${A}`;
    // Entró 5 × 855,6625 + 5.253,77 = 9.532,08; la factura pesaba 9.515,31.
    expect(suma!.dif).toBe("16.77000000");
  });

  it("pérdida en ventas: la tasa baja, se cobra todo en USD y la CxC queda en cero", async () => {
    await tasa("850.00000000");
    const cobro = await cobrar(B, {
      currency: "USD",
      amount: "11.14000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(cobro.document_status).toBe("paid");
    expect(Number(cobro.exchange_difference?.["difference"])).toBeLessThan(0);
    const lineas = await asiento("payment_received", cobro.payment["id"]!);
    expect(lineas.find((l) => l.papel === "exchange_loss")?.debe).toBe(
      cobro.exchange_difference!["difference"]!.replace("-", ""),
    );
    expect(await abierto("ar", B)).toBe("0.00000000");
  });

  it("F-02 · la factura cobrada entera en Bs guarda lo saldado en USD: una tasa tardía no lo mueve", async () => {
    await tasa("850.00000000"); // la tabla es global: cada caso pone la suya
    const doc = await facturar("4");
    const cobro = await cobrar(doc["id"]!, {
      currency: "VES",
      // El total en Bs de la factura a 850: 8.160,00 + 1.305,60 (regla 2: es la deuda del día).
      amount: "9465.60000000",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect(cobro.document_status).toBe("paid");
    // El BCV «publica tarde» otra tasa para hoy.
    await tasa("860.00000000");
    const [p] = await sql<{ s: string; estado: string }[]>`
      select p.settled_transaction_amount::text as s, d.status as estado
        from public.payments p join public.documents d on d.id = p.document_id
       where p.document_id = ${doc["id"]!}`;
    expect(p).toEqual({ s: "11.14000000", estado: "paid" });
    expect(await abierto("ar", doc["id"]!)).toBe("0.00000000");
    // Lo que el título dice: con la tasa tardía (860) el saldo en USD sigue en cero. Sin lo
    // saldado congelado, 9.465,60 / 860 = 11,01 USD y la factura volvía a deber 0,13.
    const [saldo] = await sql<{ s: string }[]>`
      select platform.document_balance_transaction(${COMPANY}, ${doc["id"]!})::text as s`;
    expect(Number(saldo!.s)).toBe(0);
    const d = await deuda(doc["id"]!);
    expect([Number(d.nominal), Number(d.hoy)]).toEqual([0, 0]);
  });

  it("D-02 · USD a una factura en Bs: se cobra a la tasa del día y queda pagada sin diferencial", async () => {
    await tasa("860.00000000"); // la tabla es global: cada caso pone la suya
    const doc = await facturar("1", LISTA_BS); // 1.000 + 160 = 1.160 Bs
    expect(doc["transaction_currency"]).toBe("VES");
    // 1.160 / 860 = 1,3488… → 1,35 USD.
    const cobro = await cobrar(doc["id"]!, {
      currency: "USD",
      amount: "1.35000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(cobro.document_status).toBe("paid");
    expect(cobro.exchange_difference).toBeNull();
    expect(await abierto("ar", doc["id"]!)).toBe("0.00000000");
  });

  it("H-02 / D-07 · pérdida en compras: el pago a otra tasa cancela la CxP a la tasa de registro", async () => {
    await tasa("860.00000000"); // la tabla es global: cada caso pone la suya
    // Factura del proveedor en USD, registrada a 860: 2 × 10 + 16 % = 23,20 USD.
    const factura = await pedir("POST", "/v1/supplier-invoices", {
      company_id: COMPANY,
      supplier_id: PROVEEDOR,
      supplier_document_number: `FAC-MA-${RUN}`,
      supplier_control_number: "00-0000091",
      invoice_date: HOY,
      currency: "USD",
      lines: [{ product_id: HARINA, quantity: "2", unit_price: "10" }],
    });
    expect(factura.status, await factura.clone().text()).toBe(201);
    const inv = ((await factura.json()) as { id: string }).id;

    await tasa("870.00000000");
    const abono = await pedir("POST", "/v1/supplier-payments", {
      company_id: COMPANY,
      supplier_invoice_id: inv,
      gross_amount: "10.00000000",
      currency: "USD",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(abono.status, await abono.clone().text()).toBe(201);
    const a = (await abono.json()) as { payment: { id: string }; invoice_status: string };
    expect(a.invoice_status).toBe("posted");
    // Salen 10 × 870 = 8.700; la deuda pesaba 10 × 860 = 8.600; pérdida 100.
    const lineas = await asiento("payment_made", a.payment.id);
    expect(lineas.find((l) => l.papel === "ap_general")?.debe).toBe("8600.00000000");
    expect(lineas.find((l) => l.papel === "exchange_loss")?.debe).toBe("100.00000000");

    // D-02: el resto (13,20 USD) se paga desde el banco en BOLÍVARES, a la tasa del día.
    const cierre = await pedir("POST", "/v1/supplier-payments", {
      company_id: COMPANY,
      supplier_invoice_id: inv,
      gross_amount: "13.20000000",
      currency: "USD",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect(cierre.status, await cierre.clone().text()).toBe(201);
    const c = (await cierre.json()) as { payment: { id: string }; invoice_status: string };
    expect(c.invoice_status).toBe("paid");
    const [fila] = await sql<Record<string, string>[]>`
      select transaction_currency as moneda, net_amount::text as salio,
             settled_amount::text as saldado, settled_currency as moneda_saldada,
             exchange_difference::text as dif
        from public.supplier_payments where id = ${c.payment.id}`;
    // 13,20 × 870 = 11.484,00 Bs salen del banco; cancelan 13,20 USD que pesaban 11.352,00.
    expect(fila).toEqual({
      moneda: "VES",
      salio: "11484.00000000",
      saldado: "13.20000000",
      moneda_saldada: "USD",
      dif: "132.00000000",
    });
    expect(await abierto("ap", inv)).toBe("0.00000000");
  });

  it("ganancia en compras, con el pago declarado en Bs: cancela la factura en USD y la CxP cierra en cero", async () => {
    await tasa("870.00000000"); // la tabla es global: cada caso pone la suya
    // Registrada a 870: 1 × 1 + 16 % = 1,16 USD = 1.009,20 Bs.
    const factura = await pedir("POST", "/v1/supplier-invoices", {
      company_id: COMPANY,
      supplier_id: PROVEEDOR,
      supplier_document_number: `FAC-MB-${RUN}`,
      supplier_control_number: "00-0000092",
      invoice_date: HOY,
      currency: "USD",
      lines: [{ product_id: HARINA, quantity: "1", unit_price: "1" }],
    });
    expect(factura.status, await factura.clone().text()).toBe(201);
    const inv = ((await factura.json()) as { id: string }).id;

    await tasa("840.00000000");
    // 1,16 USD × 840 = 974,40 Bs.
    const pago = await pedir("POST", "/v1/supplier-payments", {
      company_id: COMPANY,
      supplier_invoice_id: inv,
      gross_amount: "974.40000000",
      currency: "VES",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect(pago.status, await pago.clone().text()).toBe(201);
    const p = (await pago.json()) as { payment: { id: string }; invoice_status: string };
    expect(p.invoice_status).toBe("paid");
    const lineas = await asiento("payment_made", p.payment.id);
    expect(lineas.find((l) => l.papel === "ap_general")?.debe).toBe("1009.20000000");
    expect(lineas.find((l) => l.papel === "exchange_gain")?.haber).toBe("34.80000000");
    expect(await abierto("ap", inv)).toBe("0.00000000");
  });

  it("F-01 · la retención soportada entra en una factura en USD con la tasa cambiada, sin diferencial, y lo demás cierra en cero", async () => {
    await tasa("840.00000000"); // la tabla es global: cada caso pone la suya
    // Emitida a 840: base 8.064,00 Bs; IVA 1.290,24; el 75 % retenido son 967,68.
    const doc = await facturar("4");
    await tasa("845.00000000");
    const r = await pedir("POST", "/v1/fiscal-declarations/supported-retentions", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      document_id: doc["id"],
      receipt_number: `${HOY.slice(0, 4)}${HOY.slice(5, 7)}00000777`,
      retained_on: HOY,
      base: "1290.24",
      rate: "0.75",
      amount: "967.68",
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const cuerpo = (await r.json()) as {
      payment: { payment: Record<string, string>; exchange_difference: unknown };
    };
    expect(cuerpo.payment.exchange_difference).toBeNull();
    const lineas = await asiento("payment_received", cuerpo.payment.payment["id"]!);
    // Abona la CxC por su importe, a la tasa de la factura: ni ganancia ni pérdida ni redondeo.
    expect(lineas.find((l) => l.papel === "ar_general")?.haber).toBe("967.68000000");
    expect(lineas.filter((l) => l.papel !== "ar_general" && l.papel !== null)).toEqual([]);

    // Quedan 11,14 − 967,68 / 840 = 9,988 USD: el cliente paga 9,99 y la factura cierra.
    const cobro = await cobrar(doc["id"]!, {
      currency: "USD",
      amount: "9.99000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(cobro.document_status).toBe("paid");
    expect(await abierto("ar", doc["id"]!)).toBe("0.00000000");
  });

  it("los invariantes que cruzan siguen en cero, y los dos nuevos también", async () => {
    const [n] = await sql<Record<string, number>[]>`
      select (select count(*)::int from platform.accounting_coverage_gaps(${COMPANY})) as cobertura,
             (select count(*)::int from platform.treasury_ledger_gaps(${COMPANY})) as tesoreria,
             (select count(*)::int from platform.fiscal_amount_gaps(${COMPANY})) as fiscal,
             (select count(*)::int from platform.settled_ledger_gaps(${COMPANY})) as saldados,
             (select count(*)::int
                from platform.book_ledger_reconciliation(${COMPANY}, date '1900-01-01',
                                                         date '2999-12-31')
               where not cuadra) as libro,
             (select count(*)::int from public.journal_generation_queue
               where company_id = ${COMPANY} and status = 'pending') as cola`;
    expect(n).toEqual({ cobertura: 0, tesoreria: 0, fiscal: 0, saldados: 0, libro: 0, cola: 0 });
    const [b] = await sql<{ d: string }[]>`
      select coalesce(sum(period_debit) - sum(period_credit), 0)::text as d
        from platform.trial_balance(${COMPANY}, ${HOY}::date, null)`;
    expect(Number(b!.d)).toBe(0);
  });

  it("VARIANTE ROTA · una factura marcada pagada con CxC viva en el mayor pone settled_ledger_gaps en rojo", async () => {
    const doc = await facturar("4");
    await cobrar(doc["id"]!, {
      currency: "USD",
      amount: "5.00000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    // Lo que el cierre exacto impide: «pagada» con saldo en cuentas por cobrar. Dentro de una
    // transacción que se DESHACE: antes cada corrida dejaba una empresa con el invariante en rojo.
    let filas: { side: string; document_id: string; residual: string }[] = [];
    await sql
      .begin(async (tx) => {
        await tx`update public.documents set status = 'paid' where id = ${doc["id"]!}`;
        filas = await tx<{ side: string; document_id: string; residual: string }[]>`
          select side, document_id, residual::text as residual
            from platform.settled_ledger_gaps(${COMPANY})`;
        throw new Error("deshacer");
      })
      .catch((e: unknown) => {
        if (!(e instanceof Error) || e.message !== "deshacer") throw e;
      });
    expect(filas.map((f) => [f.side, f.document_id])).toEqual([["ar", doc["id"]]]);
    expect(Number(filas[0]!.residual)).toBeGreaterThan(0);
    expect(await sql`select * from platform.settled_ledger_gaps(${COMPANY})`).toEqual([]);
  });

  it("VARIANTE ROTA · lado ap: una factura de compra marcada pagada con CxP viva también salta", async () => {
    const factura = await pedir("POST", "/v1/supplier-invoices", {
      company_id: COMPANY,
      supplier_id: PROVEEDOR,
      supplier_document_number: `FAC-ROTA-${RUN}`,
      supplier_control_number: "00-0000099",
      invoice_date: HOY,
      currency: "USD",
      lines: [{ product_id: HARINA, quantity: "2", unit_price: "10" }],
    });
    expect(factura.status, await factura.clone().text()).toBe(201);
    const inv = ((await factura.json()) as { id: string }).id;
    const abono = await pedir("POST", "/v1/supplier-payments", {
      company_id: COMPANY,
      supplier_invoice_id: inv,
      gross_amount: "10.00000000",
      currency: "USD",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(abono.status, await abono.clone().text()).toBe(201);
    let filas: { side: string; document_id: string; residual: string }[] = [];
    await sql
      .begin(async (tx) => {
        await tx`update public.supplier_invoices set status = 'paid' where id = ${inv}`;
        filas = await tx<{ side: string; document_id: string; residual: string }[]>`
          select side, document_id, residual::text as residual
            from platform.settled_ledger_gaps(${COMPANY})`;
        throw new Error("deshacer");
      })
      .catch((e: unknown) => {
        if (!(e instanceof Error) || e.message !== "deshacer") throw e;
      });
    expect(filas.map((f) => [f.side, f.document_id])).toEqual([["ap", inv]]);
    expect(Number(filas[0]!.residual)).toBeGreaterThan(0);
  });
});

/**
 * MONEDA X (ADR-0075 §1-4, nota de aplicación «el cobro y el cierre»):
 *   regla 2 — a la tasa del documento, la deuda en Bs ES su total en Bs: pagarla cierra en cero;
 *   regla 3 — lo saldado por un cobro en Bs a la tasa del documento es proporcional;
 *   regla 4 — el diferencial del cierre tiene tope: fuera del redondeo, el cobro no se registra.
 * Tres líneas de 4 brochas a 854,4637: cada una pesa 11,14 USD y 9.515,31 Bs; el total en USD
 * por la tasa (28.556,18) se aparta 10,25 Bs del total en Bs (28.545,93).
 */
describe("moneda X: la caja cotiza lo que la factura dice, el total en Bs cierra y el diferencial tiene tope", () => {
  const TRES = ["4", "4", "4"] as const;
  // La tabla de tasas es global y otro fichero puede cambiarla entre dos casos: cada uno
  // empieza poniendo la suya.
  beforeEach(() => tasa("854.46370000"));
  const MENSAJE = /no cuadra con lo que .* todavía debe\. No se registró/;

  async function facturaDeCompra(
    numero: string,
    lineas: unknown[],
    empresa: string = COMPANY,
  ): Promise<string> {
    const r = await pedir(
      "POST",
      "/v1/supplier-invoices",
      {
        company_id: empresa,
        supplier_id: empresa === COMPANY ? PROVEEDOR : PROVEEDOR2,
        supplier_document_number: `${numero}-${RUN}`,
        supplier_control_number: `00-${numero.replace(/\D/g, "").padStart(7, "0")}`,
        invoice_date: HOY,
        currency: "USD",
        lines: lineas,
      },
      empresa,
    );
    expect(r.status, await r.clone().text()).toBe(201);
    return ((await r.json()) as { id: string }).id;
  }
  async function pagar(
    cuerpo: Record<string, unknown>,
    empresa: string = COMPANY,
  ): Promise<{ payment: { id: string }; invoice_status: string }> {
    const r = await pedir(
      "POST",
      "/v1/supplier-payments",
      { company_id: empresa, ...cuerpo },
      empresa,
    );
    expect(r.status, await r.clone().text()).toBe(201);
    return (await r.json()) as { payment: { id: string }; invoice_status: string };
  }
  const filaDePago = async (id: string): Promise<Record<string, string>> =>
    (
      await sql<Record<string, string>[]>`
        select transaction_currency as moneda, net_amount::text as salio,
               settled_amount::text as saldado, exchange_difference::text as dif
          from public.supplier_payments where id = ${id}`
    )[0]!;

  it("X1 · la cotización de la caja = los importes de la factura emitida, céntimo a céntimo", async () => {
    await tasa("854.46370000");
    const lines = TRES.map((q) => ({ product_id: BROCHA, quantity: q }));
    const r = await pedir("POST", "/v1/pos/quote", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      lines,
    });
    expect(r.status, await r.clone().text()).toBe(200);
    const q = (await r.json()) as {
      functional_subtotal: string;
      functional_tax_amount: string;
      functional_total: string;
      total: string;
      lines: { functional_total: string }[];
    };
    const doc = await facturarLineas(TRES);
    const [d] = await sql<Record<string, string>[]>`
      select subtotal_amount::text as base, tax_amount::text as iva, total_amount::text as total,
             amount_transaction_currency::text as usd
        from public.documents where id = ${doc["id"]!}`;
    const lineas = await sql<{ t: string }[]>`
      select line_total_functional::text as t from public.document_lines
       where document_id = ${doc["id"]!} order by line_number`;
    expect({
      base: q.functional_subtotal,
      iva: q.functional_tax_amount,
      total: q.functional_total,
      usd: q.total,
    }).toEqual({ ...d });
    expect(q.lines.map((l) => l.functional_total)).toEqual(lineas.map((l) => l.t));
    // Las cifras del hallazgo E-05, por tres: 1.312,46 de IVA por línea, no 1.315,88.
    expect({ ...d }).toEqual({
      base: "24608.55000000",
      iva: "3937.38000000",
      total: "28545.93000000",
      usd: "33.42000000",
    });
    // Y la única función de deuda dice lo mismo que la caja y que la factura (regla 2).
    expect({ ...(await deuda(doc["id"]!)) }).toEqual({ nominal: "33.42", hoy: "28545.93" });
  });

  it("X2 · pagar el total en Bs el mismo día cierra en cero exacto, sin diferencial", async () => {
    const doc = await facturarLineas(TRES);
    const cobro = await cobrar(doc["id"]!, {
      currency: "VES",
      amount: "28545.93000000",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect(cobro.document_status).toBe("paid");
    expect(cobro.exchange_difference).toBeNull();
    const [p] = await sql<{ s: string }[]>`
      select settled_transaction_amount::text as s from public.payments
       where document_id = ${doc["id"]!}`;
    expect(p!.s).toBe("33.42000000");
    expect(await abierto("ar", doc["id"]!)).toBe("0.00000000");
    const lineas = await asiento("payment_received", cobro.payment["id"]!);
    expect(lineas.find((l) => l.papel === "ar_general")?.haber).toBe("28545.93000000");
    expect(lineas.filter((l) => l.papel !== "ar_general" && l.papel !== null)).toEqual([]);
  });

  it("X2 · un abono en Bs a la misma tasa y luego el resto: lo saldado suma el total en USD", async () => {
    const doc = await facturarLineas(TRES);
    const abono = await cobrar(doc["id"]!, {
      currency: "VES",
      amount: "10000.00000000",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect(abono.document_status).toBe("issued");
    expect(abono.exchange_difference).toBeNull();
    // La deuda que se enseña es la parte del total en Bs que queda (document_debt, de «moneda B»).
    expect((await deuda(doc["id"]!)).hoy).toBe("18545.93");
    const resto = await cobrar(doc["id"]!, {
      currency: "VES",
      amount: "18545.93000000",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect(resto.document_status).toBe("paid");
    expect(resto.exchange_difference).toBeNull();
    const [s] = await sql<{ s: string }[]>`
      select sum(settled_transaction_amount)::text as s from public.payments
       where document_id = ${doc["id"]!}`;
    expect(s!.s).toBe("33.42000000");
    expect(await abierto("ar", doc["id"]!)).toBe("0.00000000");
  });

  it("X2 · compras: pagar en Bs lo que la factura debe el mismo día cierra en cero, en las dos formas", async () => {
    const lineas = [
      { product_id: HARINA, quantity: "3", unit_price: "3.33" },
      { product_id: HARINA, quantity: "7", unit_price: "1.19" },
    ];
    // Forma 1: el pago declarado en Bs.
    const f1 = await facturaDeCompra("FX-21", lineas);
    const debe1 = (await abierto("ap", f1))!;
    const p1 = await pagar({
      supplier_invoice_id: f1,
      gross_amount: debe1,
      currency: "VES",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect(p1.invoice_status).toBe("paid");
    const [total] = await sql<{ t: string }[]>`
      select total_amount::text as t from public.supplier_invoices where id = ${f1}`;
    expect({ ...(await filaDePago(p1.payment.id)) }).toEqual({
      moneda: "VES",
      salio: debe1,
      saldado: total!.t,
      dif: "0.00000000",
    });
    expect(await abierto("ap", f1)).toBe("0.00000000");
    // Forma 2: «pagué la factura en dólares desde el banco en bolívares».
    const f2 = await facturaDeCompra("FX-22", lineas);
    const debe2 = (await abierto("ap", f2))!;
    const p2 = await pagar({
      supplier_invoice_id: f2,
      gross_amount: total!.t,
      currency: "USD",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect(p2.invoice_status).toBe("paid");
    expect({ ...(await filaDePago(p2.payment.id)) }).toEqual({
      moneda: "VES",
      salio: debe2,
      saldado: total!.t,
      dif: "0.00000000",
    });
    expect(await abierto("ap", f2)).toBe("0.00000000");
  });

  it("X3 · el último cobro de 0,01 USD con el mayor ya sobre-abonado cierra en cero", async () => {
    const doc = await facturarLineas(TRES);
    // 33,41 USD × 854,4637 = 28.547,63: ya abona MÁS que los 28.545,93 que la factura cargó.
    const casi = await cobrar(doc["id"]!, {
      currency: "USD",
      amount: "33.41000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(casi.document_status).toBe("issued");
    // El cobro «casi entero» ya dejó el mayor sin nada que cargar (o sobre-abonado).
    expect(Number(await abierto("ar", doc["id"]!))).toBeLessThanOrEqual(0);
    const ultimo = await cobrar(doc["id"]!, {
      currency: "USD",
      amount: "0.01000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(ultimo.document_status).toBe("paid");
    expect(await abierto("ar", doc["id"]!)).toBe("0.00000000");
    expect(await sql`select * from platform.settled_ledger_gaps(${COMPANY})`).toEqual([]);
  });

  it("X7 · la retención soportada que CIERRA: cancela lo que el mayor carga y el resto va a redondeo", async () => {
    const doc = await facturar("4"); // 11,14 USD · 9.515,31 Bs · IVA 1.312,46
    await cobrar(doc["id"]!, {
      currency: "USD",
      amount: "9.99000000", // 8.536,09 Bs: el mayor queda cargando 979,22
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    const r = await pedir("POST", "/v1/fiscal-declarations/supported-retentions", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      document_id: doc["id"],
      receipt_number: `${HOY.slice(0, 4)}${HOY.slice(5, 7)}00000778`,
      retained_on: HOY,
      base: "1312.46",
      rate: "0.75",
      amount: "984.35",
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const cuerpo = (await r.json()) as {
      payment: { payment: Record<string, string>; document_status: string };
    };
    expect(cuerpo.payment.document_status).toBe("paid");
    const lineas = await asiento("payment_received", cuerpo.payment.payment["id"]!);
    expect(lineas.find((l) => l.papel === "ar_general")?.haber).toBe("979.22000000");
    const redondeo = lineas.find((l) => l.papel === "rounding_difference");
    expect([redondeo?.debe, redondeo?.haber]).toContain("5.13000000");
    expect(lineas.filter((l) => l.papel?.startsWith("exchange_"))).toEqual([]);
    expect(await abierto("ar", doc["id"]!)).toBe("0.00000000");
  });

  it("X7 · el saldo a favor que cierra: aplica lo que el mayor carga y la CxC queda en cero", async () => {
    const doc = await facturar("4");
    await cobrar(doc["id"]!, {
      currency: "USD",
      amount: "6.14000000", // 5.246,41 Bs: quedan 5,00 USD y 4.268,90 en el mayor
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(await abierto("ar", doc["id"]!)).toBe("4268.90000000");
    const [credito] = await sql<{ id: string }[]>`
      insert into public.customer_credits
        (tenant_id, company_id, customer_id, source_document_id, amount, currency)
      values (${TENANT}, ${COMPANY}, ${CLIENTE}, ${doc["id"]!}, 4268.90, 'VES')
      returning id`;
    const cierre = await cobrar(doc["id"]!, {
      currency: "VES",
      amount: "4268.90000000",
      instrument: "saldo_a_favor",
      customer_credit_id: credito!.id,
    });
    expect(cierre.document_status).toBe("paid");
    expect(cierre.exchange_difference).toBeNull();
    expect(await abierto("ar", doc["id"]!)).toBe("0.00000000");
  });

  /**
   * Un descuadre REAL entre el saldo del documento y su mayor: un asiento posteado, atribuido al
   * documento (`source_id`), que carga 3.000,00 de más en su cuenta por cobrar (o por pagar). Es
   * el camino legítimo de un asiento (borrador → líneas → posteado); lo que no es legítimo es
   * lo que dice. No se puede retirar (un asiento posteado no se borra): el documento de esta
   * prueba se queda abierto, y la contrapartida va a una cuenta de resultado.
   */
  async function asientoAjeno(
    lado: "ar" | "ap",
    sourceId: string,
    importe: string = "3000",
  ): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      const cuentas = await tx<{ purpose: string; account_id: string }[]>`
        select purpose, account_id from public.company_account_settings
         where company_id = ${COMPANY}
           and purpose in ('ar_general', 'ap_general', 'exchange_gain')`;
      const de = (p: string): string => cuentas.find((c) => c.purpose === p)!.account_id;
      const cartera = de(lado === "ar" ? "ar_general" : "ap_general");
      const [e] = await tx<{ id: string }[]>`
        insert into public.journal_entries
          (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
           description, rules_version)
        values (${TENANT}, ${COMPANY},
                platform.period_for_date(${COMPANY}, platform.caracas_day(now())),
                platform.caracas_day(now()), 'exchange_diff', ${sourceId}, 'e2e.asiento_ajeno',
                'E2E moneda X: un asiento ajeno atribuido al documento', 'e2e-moneda-x')
        returning id`;
      // ar: debe a cuentas por cobrar; ap: haber a cuentas por pagar. La otra línea, a resultado.
      const filas = [
        { n: 1, cuenta: lado === "ar" ? cartera : de("exchange_gain"), debe: importe, haber: "0" },
        { n: 2, cuenta: lado === "ar" ? de("exchange_gain") : cartera, debe: "0", haber: importe },
      ];
      for (const f of filas) {
        await tx`
          insert into public.journal_lines
            (tenant_id, company_id, entry_id, line_number, account_id, debit_amount,
             credit_amount, amount_transaction_currency, transaction_currency, fx_rate,
             functional_amount, functional_currency, rate_source, rate_timestamp,
             functional_debit, functional_credit)
          values (${TENANT}, ${COMPANY}, ${e!.id}, ${f.n}, ${f.cuenta}, ${f.debe}, ${f.haber},
                  ${importe}, 'VES', 1, ${importe}, 'VES', 'identidad', now(), ${f.debe},
                  ${f.haber})`;
      }
      await tx`
        update public.journal_entries
           set status = 'posted', posted_at = now(), posted_by = ${DUENO},
               entry_number = platform.claim_entry_number(
                 ${COMPANY}, extract(year from platform.caracas_day(now()))::int)
         where id = ${e!.id}`;
    });
  }

  it("X4 · el tope del diferencial, por cada camino: un descuadre real NO se asienta", async () => {
    const doc = await facturar("4"); // 11,14 USD · 9.515,31 Bs
    await cobrar(doc["id"]!, {
      currency: "USD",
      amount: "9.99000000", // quedan 1,15 USD; el mayor carga 979,22
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    await asientoAjeno("ar", doc["id"]!);
    expect(await abierto("ar", doc["id"]!)).toBe("3979.22000000");
    const cuantos = async (): Promise<number> =>
      (
        await sql<{ n: number }[]>`
          select count(*)::int as n from public.payments where document_id = ${doc["id"]!}`
      )[0]!.n;

    // (a) la retención soportada que cerraría (984,35 Bs a la tasa de la factura = 1,152 USD).
    const ret = await rechazado("/v1/fiscal-declarations/supported-retentions", {
      customer_id: CLIENTE,
      document_id: doc["id"],
      receipt_number: `${HOY.slice(0, 4)}${HOY.slice(5, 7)}00000779`,
      retained_on: HOY,
      base: "1312.46",
      rate: "0.75",
      amount: "984.35",
    });
    expect([ret.code, ret.message]).toEqual([
      "SETTLEMENT_MISMATCH",
      expect.stringMatching(MENSAJE),
    ]);

    // (b) el cobro en la moneda del documento.
    const usd = await rechazado("/v1/payments", {
      document_id: doc["id"],
      currency: "USD",
      amount: "1.15000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect([usd.code, usd.message]).toEqual([
      "SETTLEMENT_MISMATCH",
      expect.stringMatching(MENSAJE),
    ]);

    // (c) el cobro en Bs A LA TASA DEL DOCUMENTO: lo que la deuda dice (la parte proporcional
    //     del total). Al mayor no se le cree como «saldo en Bs» porque no cuadra.
    const hoy = (await deuda(doc["id"]!)).hoy;
    expect(hoy).toBe("982.28");
    const bs = await rechazado("/v1/payments", {
      document_id: doc["id"],
      currency: "VES",
      amount: `${hoy}000000`,
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect([bs.code, bs.message]).toEqual(["SETTLEMENT_MISMATCH", expect.stringMatching(MENSAJE)]);

    // (d) el cobro en Bs a OTRA tasa: 1,15 × 860 = 989,00.
    await tasa("860.00000000");
    const otra = await rechazado("/v1/payments", {
      document_id: doc["id"],
      currency: "VES",
      amount: "989.00000000",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    await tasa("854.46370000");
    expect([otra.code, otra.message]).toEqual([
      "SETTLEMENT_MISMATCH",
      expect.stringMatching(MENSAJE),
    ]);

    // Nada se registró: ni cobro, ni comprobante de retención, ni un céntimo en el mayor.
    expect(await cuantos()).toBe(1);
    expect(await abierto("ar", doc["id"]!)).toBe("3979.22000000");
    const [comprobantes] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.supported_retention_receipts
       where document_id = ${doc["id"]!}`;
    expect(comprobantes!.n).toBe(0);
    // Y un abono que NO cierra sigue entrando: el tope es del cierre, no del documento.
    const parcial = await cobrar(doc["id"]!, {
      currency: "USD",
      amount: "0.50000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(parcial.document_status).toBe("issued");
  });

  it("X4 · compras: el pago que cerraría una factura cuyo saldo no cuadra con el mayor NO se registra", async () => {
    const lineas = [{ product_id: HARINA, quantity: "2", unit_price: "10" }]; // 23,20 USD
    const inv = await facturaDeCompra("FX-41", lineas);
    await pagar({
      supplier_invoice_id: inv,
      gross_amount: "10.00000000",
      currency: "USD",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    await asientoAjeno("ap", inv);
    const pagos = async (): Promise<number> =>
      (
        await sql<{ n: number }[]>`
          select count(*)::int as n from public.supplier_payments
           where supplier_invoice_id = ${inv}`
      )[0]!.n;
    // En la moneda de la factura, y en Bs a la tasa de la factura (13,20 × 854,4637).
    for (const cuerpo of [
      { gross_amount: "13.20000000", currency: "USD", instrument: "zelle", account_id: BANCO_USD },
      {
        gross_amount: "11278.92000000",
        currency: "VES",
        instrument: "transferencia",
        account_id: BANCO_BS,
      },
    ]) {
      const malo = await rechazado("/v1/supplier-payments", {
        supplier_invoice_id: inv,
        ...cuerpo,
      });
      expect([malo.code, malo.message]).toEqual([
        "SETTLEMENT_MISMATCH",
        expect.stringMatching(MENSAJE),
      ]);
    }
    expect(await pagos()).toBe(1);
    // La misma operación sobre una factura gemela SIN el asiento ajeno entra y cierra en cero.
    const gemela = await facturaDeCompra("FX-42", lineas);
    await pagar({
      supplier_invoice_id: gemela,
      gross_amount: "10.00000000",
      currency: "USD",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    const cierre = await pagar({
      supplier_invoice_id: gemela,
      gross_amount: "13.20000000",
      currency: "USD",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(cierre.invoice_status).toBe("paid");
    expect((await filaDePago(cierre.payment.id))["dif"]).toBe("0.00000000");
    expect(await abierto("ap", gemela)).toBe("0.00000000");
  });

  /**
   * EL BORDE DEL TOPE (regla 4). Hasta aquí el tope solo se probaba con 3.000 Bs de descuadre.
   * La cota, a la tasa 854,4637 y con UNA línea: (media + 0,01) × líneas + media + 0,01 × (cobros
   * previos + 1), con media = 0,005 USD × tasa = 4,2723185.
   */
  it("Z3 · ventas: un descuadre justo DENTRO de la cota cierra, y justo FUERA responde SETTLEMENT_MISMATCH", async () => {
    // Sin cobros previos: cota = 4,2823185 + 4,2723185 + 0,01 = 8,564637 → 8,56 pasa, 8,57 no.
    // La gemela dice cuánto entra en Bs al cobrar los 11,14 USD sin ningún asiento ajeno.
    const gemela = await facturar("4");
    const g = await cobrar(gemela["id"]!, {
      currency: "USD",
      amount: "11.14000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(g.document_status).toBe("paid");
    const [fila] = await sql<{ entro: string; pesaba: string }[]>`
      select p.functional_amount::text as entro, d.total_amount::text as pesaba
        from public.payments p join public.documents d on d.id = p.document_id
       where p.id = ${g.payment["id"]!}`;
    const base = Number(fila!.entro) - Number(fila!.pesaba); // lo que entra − lo que el mayor carga
    const cuerpo = (id: string) => ({
      document_id: id,
      currency: "USD",
      amount: "11.14000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });

    // FUERA: el mayor carga 8,57 más de lo que el cobro puede explicar.
    const fuera = await facturar("4");
    await asientoAjeno("ar", fuera["id"]!, (base + 8.57).toFixed(2));
    const malo = await rechazado("/v1/payments", cuerpo(fuera["id"]!));
    expect([malo.status, malo.code, malo.message]).toEqual([
      409,
      "SETTLEMENT_MISMATCH",
      expect.stringMatching(MENSAJE),
    ]);

    // DENTRO: 8,56. El cobro entra, cierra, y la cuenta por cobrar queda en cero.
    const dentro = await facturar("4");
    await asientoAjeno("ar", dentro["id"]!, (base + 8.56).toFixed(2));
    const bueno = await cobrar(dentro["id"]!, cuerpo(dentro["id"]!));
    expect(bueno.document_status).toBe("paid");
    expect(await abierto("ar", dentro["id"]!)).toBe("0.00000000");
  });

  it("Z3 · compras: el mismo borde en registerSupplierPayment", async () => {
    // Un pago previo: cota = 4,2823185 + 4,2723185 + 0,01 × 2 = 8,574637 → 8,57 pasa, 8,58 no.
    const lineas = [{ product_id: HARINA, quantity: "2", unit_price: "10" }]; // 23,20 USD
    const preparar = async (numero: string, ajeno: string): Promise<string> => {
      const inv = await facturaDeCompra(numero, lineas);
      await pagar({
        supplier_invoice_id: inv,
        gross_amount: "10.00000000",
        currency: "USD",
        instrument: "zelle",
        account_id: BANCO_USD,
      });
      await asientoAjeno("ap", inv, ajeno);
      return inv;
    };
    const cierre = (inv: string) => ({
      supplier_invoice_id: inv,
      gross_amount: "13.20000000",
      currency: "USD",
      instrument: "zelle",
      account_id: BANCO_USD,
    });

    const fuera = await preparar("FZ-31", "8.58");
    const malo = await rechazado("/v1/supplier-payments", cierre(fuera));
    expect([malo.status, malo.code, malo.message]).toEqual([
      409,
      "SETTLEMENT_MISMATCH",
      expect.stringMatching(MENSAJE),
    ]);

    const dentro = await preparar("FZ-32", "8.57");
    const bueno = await pagar(cierre(dentro));
    expect(bueno.invoice_status).toBe("paid");
    expect(await abierto("ap", dentro)).toBe("0.00000000");
  });

  it("X5 · sin contabilidad, un abono REVERSADO no cuenta en el cierre: diferencial 0", async () => {
    const e = { company: COMPANY2, cliente: CLIENTE2, w: W2, brocha: BROCHA2 };
    const doc = await facturarLineas(["4"], e);
    const abono = await cobrar(
      doc["id"]!,
      { currency: "USD", amount: "5.00000000", instrument: "zelle" },
      COMPANY2,
    );
    const rev = await pedir(
      "POST",
      `/v1/payments/${abono.payment["id"]!}/reversal`,
      { company_id: COMPANY2, reason: "El Zelle era de otro cliente" },
      COMPANY2,
    );
    expect(rev.status, await rev.clone().text()).toBe(201);
    // Nada tiene asiento: el mayor no responde y el cierre usa el respaldo calculado.
    expect(await abierto("ar", doc["id"]!, COMPANY2)).toBeNull();
    const cierre = await cobrar(
      doc["id"]!,
      { currency: "USD", amount: "11.14000000", instrument: "zelle" },
      COMPANY2,
    );
    expect(cierre.document_status).toBe("paid");
    // Antes: el respaldo restaba también el abono reversado y «ganaba» 4.272,32 de diferencial.
    expect(cierre.exchange_difference).toBeNull();
  });

  it("X7 · sin contabilidad, compras: el respaldo calculado cierra la factura sin diferencial", async () => {
    const inv = await facturaDeCompra(
      "FX-71",
      [{ product_id: HARINA2, quantity: "1", unit_price: "5" }], // 5,80 USD
      COMPANY2,
    );
    const abono = await pagar(
      {
        supplier_invoice_id: inv,
        gross_amount: "2.00000000",
        currency: "USD",
        instrument: "zelle",
      },
      COMPANY2,
    );
    expect(abono.invoice_status).toBe("posted");
    expect(await abierto("ap", inv, COMPANY2)).toBeNull();
    const cierre = await pagar(
      {
        supplier_invoice_id: inv,
        gross_amount: "3.80000000",
        currency: "USD",
        instrument: "zelle",
      },
      COMPANY2,
    );
    expect(cierre.invoice_status).toBe("paid");
    expect((await filaDePago(cierre.payment.id))["dif"]).toBe("0.00000000");
  });

  it("los invariantes siguen en cero en las dos empresas", async () => {
    for (const empresa of [COMPANY, COMPANY2]) {
      const [n] = await sql<Record<string, number>[]>`
        select (select count(*)::int from platform.accounting_coverage_gaps(${empresa})) as cobertura,
               (select count(*)::int from platform.fiscal_amount_gaps(${empresa})) as fiscal,
               (select count(*)::int from platform.settled_ledger_gaps(${empresa})) as saldados,
               (select count(*)::int from platform.cent_gaps(${empresa})) as centimo`;
      expect({ ...n }).toEqual({ cobertura: 0, fiscal: 0, saldados: 0, centimo: 0 });
    }
    const [b] = await sql<{ d: string }[]>`
      select coalesce(sum(period_debit) - sum(period_credit), 0)::text as d
        from platform.trial_balance(${COMPANY}, ${HOY}::date, null)`;
    expect(Number(b!.d)).toBe(0);
  });
});

describe("revisión final · un diferencial REAL no va a redondeo, y la marca viaja por la cola (AF-M03)", () => {
  const R = "854.46370000";
  beforeEach(() => tasa(R));

  async function compra(numero: string, lineas: unknown[]): Promise<string> {
    const r = await pedir("POST", "/v1/supplier-invoices", {
      company_id: COMPANY,
      supplier_id: PROVEEDOR,
      supplier_document_number: `${numero}-${RUN}`,
      supplier_control_number: `00-${numero.replace(/\D/g, "").padStart(7, "0")}`,
      invoice_date: HOY,
      currency: "USD",
      lines: lineas,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    return ((await r.json()) as { id: string }).id;
  }
  async function pagarUsd(inv: string, importe: string): Promise<{ id: string; estado: string }> {
    const r = await pedir("POST", "/v1/supplier-payments", {
      company_id: COMPANY,
      supplier_invoice_id: inv,
      gross_amount: importe,
      currency: "USD",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const b = (await r.json()) as { payment: { id: string }; invoice_status: string };
    return { id: b.payment.id, estado: b.invoice_status };
  }
  /** Las líneas de resultado (diferencial o redondeo) del asiento de un hecho, por su origen. */
  async function resultadoDe(sourceId: string): Promise<{ papel: string; importe: string }[]> {
    return sql<{ papel: string; importe: string }[]>`
      select s.purpose as papel, (l.functional_debit + l.functional_credit)::text as importe
        from public.journal_entries e
        join public.journal_lines l on l.entry_id = e.id
        join lateral (select min(x.purpose) as purpose from public.company_account_settings x
                       where x.company_id = l.company_id and x.account_id = l.account_id
                         and x.purpose in ('exchange_gain', 'exchange_loss',
                                           'rounding_difference')) s on s.purpose is not null
       where e.company_id = ${COMPANY} and e.source_id = ${sourceId} and e.status = 'posted'
       order by l.line_number`;
  }
  /** El banco en dólares no se sobregira: una venta cobrada en USD (27,84) le pone fondos. */
  async function fondear(): Promise<void> {
    const doc = await facturar("10");
    await cobrar(doc["id"]!, {
      currency: "USD",
      amount: "27.84000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
  }
  const difDe = async (pago: string): Promise<string> =>
    (
      await sql<{ d: string }[]>`
        select exchange_difference::text as d from public.supplier_payments where id = ${pago}`
    )[0]!.d;

  it("compras · factura a R, nota de crédito a otra tasa, y el resto pagado un día de tasa R: el residuo es DIFERENCIAL, no redondeo", async () => {
    await fondear();
    // 2 × 10 + 16 % = 23,20 USD a 854,4637.
    const inv = await compra("FZ-11", [{ product_id: HARINA, quantity: "2", unit_price: "10" }]);
    // La nota de crédito del proveedor, 5,80 USD, entra a 900: baja la CxP por 5.220,00 Bs, no
    // por los 4.955,89 que esos dólares pesaban en la factura.
    await tasa("900.00000000");
    const nota = await pedir("POST", "/v1/supplier-credit-notes", {
      company_id: COMPANY,
      supplier_invoice_id: inv,
      supplier_document_number: `NC-FZ-11-${RUN}`,
      supplier_control_number: `00-NCFZ11${RUN}`,
      note_date: HOY,
      currency: "USD",
      reason: "Devolución parcial",
      lines: [{ product_id: HARINA, quantity: "1", unit_price: "5", tax_amount: "0.80000000" }],
    });
    expect(nota.status, await nota.clone().text()).toBe(201);
    // El resto (17,40 USD) se paga un día en que la tasa vuelve a ser la de la factura.
    await tasa(R);
    const cierre = await pagarUsd(inv, "17.40000000");
    expect(cierre.estado).toBe("paid");
    const lineas = await resultadoDe(cierre.id);
    // 5,80 USD × (900 − 854,4637) ≈ 264,11 Bs: diferencia cambiaria real, sin cota de redondeo.
    expect(lineas.map((l) => l.papel)).toEqual(["exchange_loss"]);
    expect(Number(lineas[0]!.importe)).toBeGreaterThan(264);
    expect(Number(lineas[0]!.importe)).toBeLessThan(264.3);
    expect(lineas[0]!.importe).toBe(await difDe(cierre.id));
    expect(await abierto("ap", inv)).toBe("0.00000000");
  });

  it("compras · el caso limpio: misma tasa y sin notas, el céntimo del cierre va a redondeo y no hay línea de diferencial", async () => {
    // 1 × 1 + 16 % = 1,16 USD = 991,18 Bs. 0,01 USD cancela 8,54; quedan 982,64 en el mayor y
    // 1,15 USD × 854,4637 = 982,63: un céntimo de redondeo, a la tasa de la factura.
    const inv = await compra("FZ-12", [{ product_id: HARINA, quantity: "1", unit_price: "1" }]);
    expect((await pagarUsd(inv, "0.01000000")).estado).toBe("posted");
    const cierre = await pagarUsd(inv, "1.15000000");
    expect(cierre.estado).toBe("paid");
    expect(await difDe(cierre.id)).toBe("-0.01000000");
    expect(await resultadoDe(cierre.id)).toEqual([
      { papel: "rounding_difference", importe: "0.01000000" },
    ]);
    expect(await abierto("ap", inv)).toBe("0.00000000");
  });

  it("ventas · un saldo a favor aplicado a OTRA tasa reconoce su diferencial al aplicarlo: el cierre a la tasa del documento solo deja redondeo", async () => {
    const doc = await facturar("4"); // 11,14 USD a 854,4637
    await tasa("900.00000000");
    const [credito] = await sql<{ id: string }[]>`
      insert into public.customer_credits
        (tenant_id, company_id, customer_id, source_document_id, amount, currency)
      values (${TENANT}, ${COMPANY}, ${CLIENTE}, ${doc["id"]!}, 4500, 'VES')
      returning id`;
    // 4.500 Bs a 900 saldan 5,00 USD que pesaban 4.272,32: el diferencial es de ESTE cobro.
    const aplicado = await cobrar(doc["id"]!, {
      currency: "VES",
      amount: "4500.00000000",
      instrument: "saldo_a_favor",
      customer_credit_id: credito!.id,
    });
    expect(aplicado.document_status).toBe("issued");
    const delSaldo = await resultadoDe(aplicado.payment["id"]!);
    expect(delSaldo.map((l) => l.papel)).toEqual(["exchange_gain"]);
    // 5 USD × (900 − 854,4637) = 227,68: entero, en el cobro que lo causó.
    expect(Number(delSaldo[0]!.importe)).toBeGreaterThan(227.6);
    expect(Number(delSaldo[0]!.importe)).toBeLessThan(227.8);
    await tasa(R);
    const cierre = await cobrar(doc["id"]!, {
      currency: "USD",
      amount: "6.14000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(cierre.document_status).toBe("paid");
    // Lo que el cierre deja es REDONDEO: los 3,42 Bs del medio céntimo de dólar con que se
    // redondeó el total (11,136 → 11,14 USD; el mayor carga 9.515,31 y no 9.518,73), dentro de
    // la cota de una línea (4,28). Nunca los 227 Bs del saldo a favor: en ventas cada cobro
    // reconoce su diferencial al aplicarse y el cierre no hereda ninguno.
    for (const l of await resultadoDe(cierre.payment["id"]!)) {
      expect(l.papel).toBe("rounding_difference");
      expect(Number(l.importe)).toBeLessThan(4.28);
    }
    expect(await abierto("ar", doc["id"]!)).toBe("0.00000000");
  });

  it("la cola · una fila encolada con la marca genera su asiento a redondeo; una fila vieja sin la marca, a diferencial", async () => {
    const plantilla = async (activa: boolean): Promise<void> => {
      await sql.begin(async (tx) => {
        await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
        const filas = await tx`
          update public.journal_templates set is_active = ${activa}
           where company_id = ${COMPANY} and source_kind = 'payment_made'
             and source_event = 'ap.payment_made'
          returning id`;
        expect(filas.length).toBeGreaterThan(0);
      });
    };
    const UNA = [{ product_id: HARINA, quantity: "1", unit_price: "1" }];
    const conMarca = await compra("FZ-13", UNA);
    const vieja = await compra("FZ-14", UNA);
    await pagarUsd(conMarca, "0.01000000");
    await pagarUsd(vieja, "0.01000000");
    // Sin plantilla vigente, el pago que cierra se ENCOLA con sus importes y su marca.
    await plantilla(false);
    let pagoMarca: { id: string; estado: string };
    let pagoViejo: { id: string; estado: string };
    try {
      pagoMarca = await pagarUsd(conMarca, "1.15000000");
      pagoViejo = await pagarUsd(vieja, "1.15000000");
    } finally {
      await plantilla(true);
    }
    const marcas = await sql<{ source_id: string; marca: boolean | null }[]>`
      select source_id, (context -> 'difference_is_rounding')::boolean as marca
        from public.journal_generation_queue
       where company_id = ${COMPANY} and status = 'pending'
         and source_id in (${pagoMarca.id}, ${pagoViejo.id})`;
    expect(marcas).toHaveLength(2);
    expect(marcas.every((m) => m.marca === true)).toBe(true);
    // La fila «vieja»: encolada antes de que existiera la marca (20261003210000).
    await sql`
      update public.journal_generation_queue set context = context - 'difference_is_rounding'
       where company_id = ${COMPANY} and source_id = ${pagoViejo.id}`;
    const r = await pedir("POST", "/v1/accounting/pending/process", { limit: 500 });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await resultadoDe(pagoMarca.id)).toEqual([
      { papel: "rounding_difference", importe: "0.01000000" },
    ]);
    expect(await resultadoDe(pagoViejo.id)).toEqual([
      { papel: "exchange_gain", importe: "0.01000000" },
    ]);
  });

  it("y los invariantes siguen en cero", async () => {
    const [n] = await sql<Record<string, number>[]>`
      select (select count(*)::int from platform.accounting_coverage_gaps(${COMPANY})) as cobertura,
             (select count(*)::int from platform.settled_ledger_gaps(${COMPANY})) as saldados,
             (select count(*)::int from platform.cent_gaps(${COMPANY})) as centimo`;
    expect({ ...n }).toEqual({ cobertura: 0, saldados: 0, centimo: 0 });
  });
});

describe("ola 4 · cobros: el pago de más, el saldo a favor en su moneda, su reembolso y la cartera contra el mayor (F-07, F-10, F-12, G-04, G-05, G-15)", () => {
  let CREDITO_USD = "";
  let CREDITO_BS = "";
  let PAGO_BS = "";
  let FACTURA_BS = "";
  let FACTURA_ABIERTA = "";
  // EMPRESA PROPIA (revisión, punto 4). Este bloque compartía empresa con los casos X4 y Z3 de
  // arriba, que escriben a propósito líneas sueltas en la cuenta por cobrar, y aseveraba «la
  // brecha no se mueve»: «uno, pero es el conocido». Ahora funda la suya y asevera CERO filas.
  const PROPIA = {
    tenant: crypto.randomUUID(),
    company: crypto.randomUUID(),
    w: crypto.randomUUID(),
    cliente: crypto.randomUUID(),
  };
  let AJENA: {
    tenant: string;
    company: string;
    w: string;
    cliente: string;
    brocha: string;
    listaBs: string;
    bancoUsd: string;
    bancoBs: string;
  } | null = null;
  const brecha = async (tx: Pick<typeof sql, "unsafe"> | typeof sql = sql): Promise<number> => {
    const f = await (tx as typeof sql)<{ g: string }[]>`
      select coalesce((select gap from platform.receivables_ledger_gap(${COMPANY})), 0)::text
               as g`;
    return Number(f[0]!.g);
  };

  /** Las líneas del asiento de un hecho, con el pasivo de saldos a favor y la caja. */
  async function lineas(
    sourceKind: string,
    sourceId: string,
  ): Promise<{ papel: string; debe: string; haber: string }[]> {
    return sql<{ papel: string; debe: string; haber: string }[]>`
      select coalesce((select min(s.purpose) from public.company_account_settings s
                        where s.company_id = l.company_id and s.account_id = l.account_id
                          and s.purpose in ('ar_general', 'exchange_gain', 'exchange_loss',
                                            'rounding_difference', 'customer_credit_liability')),
                      'caja') as papel,
             l.functional_debit::text as debe, l.functional_credit::text as haber
        from public.journal_entries e
        join public.journal_lines l on l.entry_id = e.id
       where e.company_id = ${COMPANY} and e.source_kind = ${sourceKind}
         and e.source_id = ${sourceId} and e.status = 'posted'
       order by l.line_number`;
  }
  const de = (ls: { papel: string; debe: string; haber: string }[], papel: string) =>
    ls.find((l) => l.papel === papel);
  async function saldoDeCuenta(id: string): Promise<string> {
    const [b] = await sql<{ b: string }[]>`
      select coalesce((select balance from public.company_account_balances
                        where account_id = ${id}), 0)::text as b`;
    return b!.b;
  }
  async function credito(id: string): Promise<Record<string, string | null>> {
    const [c] = await sql<Record<string, string | null>[]>`
      select amount::text as amount, applied_amount::text as applied, currency, status,
             fx_rate::text as fx_rate, functional_amount::text as functional,
             source_payment_id
        from public.customer_credits where id = ${id}`;
    return c!;
  }

  beforeAll(async () => {
    await sql`insert into public.role_permissions (role_id, permission_key) values
              (${ROL}, 'sales.refund'), (${ROL}, 'sales.return.manage'),
              (${ROL}, 'sales.credit_note.direct')
              on conflict do nothing`;
    AJENA = {
      tenant: TENANT,
      company: COMPANY,
      w: W1,
      cliente: CLIENTE,
      brocha: BROCHA,
      listaBs: LISTA_BS,
      bancoUsd: BANCO_USD,
      bancoBs: BANCO_BS,
    };
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`insert into public.tenants (id, name) values (${PROPIA.tenant}, 'Tenant e2e cobros')`;
      await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                             functional_currency_code, taxpayer_type_code)
               values (${PROPIA.company}, ${PROPIA.tenant},
                       ${`J${String(Date.now() + 211).slice(-9)}`},
                       'Ferretería de los cobros', 'VES', 'ordinario')`;
      await declararTipoDeFixture(tx, PROPIA.company);
      await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
               values (${PROPIA.w}, ${PROPIA.tenant}, ${PROPIA.company}, 'E2E-COBR', 'Local')`;
      const mem = crypto.randomUUID();
      const asig = crypto.randomUUID();
      await tx`insert into public.memberships (id, tenant_id, user_id) values
               (${mem}, ${PROPIA.tenant}, ${DUENO})`;
      await tx`insert into public.user_role_assignments
                 (id, tenant_id, membership_id, role_id, company_id) values
               (${asig}, ${PROPIA.tenant}, ${mem}, ${ROL}, null)`;
      await tx`insert into public.scope_bindings
                 (tenant_id, company_id, assignment_id, scope_type, scope_id)
               values (${PROPIA.tenant}, ${PROPIA.company}, ${asig}, 'warehouse', ${PROPIA.w})`;
      await tx`insert into public.company_fiscal_regimes
                 (tenant_id, company_id, regime_code, effective_from)
               values (${PROPIA.tenant}, ${PROPIA.company}, 'formatos_libres',
                       '2026-01-01'::timestamptz)`;
      await tx`insert into public.customers
                 (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                  taxpayer_type_code)
               values (${PROPIA.cliente}, ${PROPIA.tenant}, ${PROPIA.company},
                       ${`J${String(Date.now() + 217).slice(-9)}`},
                       'Constructora e2e cobros', 'juridica', 'ordinario')`;
      await fiadoDeFixture(tx, PROPIA.company, [ROL]);
      const [b] = await tx<{ id: string }[]>`
        insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                     tax_category_code)
        values (${PROPIA.tenant}, ${PROPIA.company}, ${`COBR-BRO-${RUN}`},
                'Brocha (servicio de pintura)', 'service', 'active', 'unidad', 'gravado_general')
        returning id`;
      const [l] = await tx<{ id: string }[]>`
        insert into public.price_lists (tenant_id, company_id, name, currency_code)
        values (${PROPIA.tenant}, ${PROPIA.company}, 'detal', 'USD') returning id`;
      const [lb] = await tx<{ id: string }[]>`
        insert into public.price_lists (tenant_id, company_id, name, currency_code)
        values (${PROPIA.tenant}, ${PROPIA.company}, 'detal en bolívares', 'VES') returning id`;
      await tx`insert into public.company_settings (company_id, tenant_id, default_price_list_id)
               values (${PROPIA.company}, ${PROPIA.tenant}, ${l!.id})`;
      await tx`insert into public.price_list_items
                 (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
               values (${PROPIA.tenant}, ${PROPIA.company}, ${l!.id}, ${b!.id}, 2.40,
                       now() - interval '1 day'),
                      (${PROPIA.tenant}, ${PROPIA.company}, ${lb!.id}, ${b!.id}, 1000,
                       now() - interval '1 day')`;
      BROCHA = b!.id;
      LISTA_BS = lb!.id;
    });
    // Desde aquí, los ayudantes del fichero (facturar, cobrar, deuda…) hablan de la empresa propia.
    TENANT = PROPIA.tenant;
    COMPANY = PROPIA.company;
    W1 = PROPIA.w;
    CLIENTE = PROPIA.cliente;
    for (const [ruta, cuerpo] of [
      ["/v1/accounts/import-template", { company_id: COMPANY, template_code: "ve_basico" }],
      ["/v1/journal-templates/import-preset", { company_id: COMPANY, preset_code: "ve_basico" }],
    ] as const) {
      const r = await pedir("POST", ruta, cuerpo);
      if (r.status !== 201) throw new Error(`${ruta}: ${r.status} ${await r.text()}`);
    }
    const rango = await pedir("POST", "/v1/fiscal-number-ranges", {
      company_id: COMPANY,
      kind: "invoice",
      series: "A",
      range_from: "1",
      range_to: "500",
      printer_source: "Imprenta E2E cobros",
      printer_legal_name: "Imprenta E2E, C.A.",
      printer_tax_id: "J-12345678-9",
      printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
      printer_authorization_date: "2020-01-15",
      printed_on: "2026-01-01",
    });
    if (rango.status !== 201) throw new Error(`rango: ${rango.status} ${await rango.text()}`);
    for (const [nombre, moneda] of [
      ["Banco USD", "USD"],
      ["Banco Bs", "VES"],
    ] as const) {
      const r = await pedir("POST", "/v1/treasury/accounts", {
        company_id: COMPANY,
        name: `${nombre} cobros ${RUN}`,
        currency: moneda,
        kind: "bank",
      });
      if (r.status !== 201) throw new Error(`cuenta: ${r.status} ${await r.text()}`);
      const id = ((await r.json()) as { id: string }).id;
      if (moneda === "USD") BANCO_USD = id;
      else BANCO_BS = id;
    }
  });

  afterAll(() => {
    if (AJENA === null) return;
    TENANT = AJENA.tenant;
    COMPANY = AJENA.company;
    W1 = AJENA.w;
    CLIENTE = AJENA.cliente;
    BROCHA = AJENA.brocha;
    LISTA_BS = AJENA.listaBs;
    BANCO_USD = AJENA.bancoUsd;
    BANCO_BS = AJENA.bancoBs;
  });

  it("F-07 · un cobro en USD que cierra a otra tasa: entra lo que se dijo, el asiento cuadra y la CxC queda en cero", async () => {
    await tasa("854.46370000");
    const doc = await facturar("1"); // 2,78 USD · 2.378,82 Bs
    await tasa("855.66250000");
    const antes = await saldoDeCuenta(BANCO_USD);
    const cobro = await cobrar(doc["id"]!, {
      currency: "USD",
      amount: "2.78000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(cobro.document_status).toBe("paid");
    // Lo que entra en la caja es lo que la persona dijo que recibió.
    expect(cobro.payment["amount"]).toBe("2.78000000");
    expect(Number(await saldoDeCuenta(BANCO_USD)) - Number(antes)).toBeCloseTo(2.78, 8);
    // Ningún residuo en cuentas por cobrar.
    expect(await abierto("ar", doc["id"]!)).toBe("0.00000000");
    // El asiento: la caja = lo cancelado ± el diferencial. Ni caja corta ni diferencial doble.
    const ls = await lineas("payment_received", cobro.payment["id"]!);
    const caja = Number(de(ls, "caja")!.debe);
    const cxc = Number(de(ls, "ar_general")!.haber);
    const ganancia = Number(de(ls, "exchange_gain")?.haber ?? 0);
    const perdida = Number(de(ls, "exchange_loss")?.debe ?? 0);
    const redondeo =
      Number(de(ls, "rounding_difference")?.haber ?? 0) -
      Number(de(ls, "rounding_difference")?.debe ?? 0);
    expect(cxc).toBe(2378.82);
    expect(caja).toBeCloseTo(cxc + ganancia - perdida + redondeo, 2);
    // La caja en el mayor vale lo mismo que el cobro guardó como funcional.
    expect(caja).toBeCloseTo(Number(cobro.payment["functional_amount"]), 2);
  });

  it("F-10 · un pago de más en USD se acepta: el documento queda pagado y el sobrante nace como saldo a favor en USD, con su tasa", async () => {
    await tasa("855.66250000");
    const doc = await facturar("1"); // 2,78 USD · 2.382,16 Bs a 855,6625
    const r = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: doc["id"]!,
      currency: "USD",
      amount: "5.00000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const cuerpo = (await r.json()) as Cobro & {
      customer_credit: { id: string; amount: string; currency: string } | null;
    };
    expect(cuerpo.document_status).toBe("paid");
    expect(cuerpo.payment["amount"]).toBe("5.00000000");
    expect(cuerpo.customer_credit).toMatchObject({ amount: "2.22000000", currency: "USD" });
    CREDITO_USD = cuerpo.customer_credit!.id;
    expect(await credito(CREDITO_USD)).toEqual({
      amount: "2.22000000",
      applied: "0.00000000",
      currency: "USD",
      status: "available",
      fx_rate: "855.66250000",
      functional: "1899.57000000",
      source_payment_id: cuerpo.payment["id"],
    });
    // Lo saldado es lo que se debía, no lo entregado; y el documento no debe nada.
    const [p] = await sql<{ s: string; c: string; k: string }[]>`
      select settled_transaction_amount::text as s, credited_functional_amount::text as c,
             cancelled_functional_amount::text as k
        from public.payments where id = ${cuerpo.payment["id"]!}`;
    expect(p).toEqual({ s: "2.78000000", c: "1899.57000000", k: "2382.16000000" });
    expect(Number((await deuda(doc["id"]!)).nominal)).toBe(0);
    expect(await abierto("ar", doc["id"]!)).toBe("0.00000000");
    // El asiento: Dr caja 4.278,31 + Dr redondeo 3,42 = Cr CxC 2.382,16 + Cr saldos a favor 1.899,57.
    const ls = await lineas("payment_received", cuerpo.payment["id"]!);
    expect(de(ls, "caja")?.debe).toBe("4278.31000000");
    expect(de(ls, "ar_general")?.haber).toBe("2382.16000000");
    expect(de(ls, "customer_credit_liability")?.haber).toBe("1899.57000000");
    expect(de(ls, "rounding_difference")?.debe).toBe("3.42000000");
  });

  it("F-10 · un pago de más en Bs de una factura en Bs: el sobrante es saldo a favor en Bs y el saldo queda en cero", async () => {
    FACTURA_BS = (await facturar("1", LISTA_BS))["id"]!; // 1.000 + 160 de IVA
    const r = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: FACTURA_BS,
      currency: "VES",
      amount: "4000.00000000",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const cuerpo = (await r.json()) as Cobro & {
      customer_credit: { id: string; amount: string; currency: string } | null;
    };
    expect(cuerpo.document_status).toBe("paid");
    expect(cuerpo.customer_credit).toMatchObject({ amount: "2840.00000000", currency: "VES" });
    CREDITO_BS = cuerpo.customer_credit!.id;
    PAGO_BS = cuerpo.payment["id"]!;
    const [b] = await sql<{ saldo: string }[]>`
      select platform.document_balance(${COMPANY}, ${FACTURA_BS})::text as saldo`;
    expect(b!.saldo).toBe("0.00000000");
    const ls = await lineas("payment_received", PAGO_BS);
    expect(de(ls, "caja")?.debe).toBe("4000.00000000");
    expect(de(ls, "ar_general")?.haber).toBe("1160.00000000");
    expect(de(ls, "customer_credit_liability")?.haber).toBe("2840.00000000");
  });

  it("G-05 · un saldo a favor en USD se aplica a otra factura en USD nominal contra nominal: la tasa de hoy no entra", async () => {
    await tasa("854.46370000");
    const doc = await facturar("1"); // 2,78 USD a 854,4637
    await tasa("900.00000000"); // la tasa de HOY no decide nada
    const cobro = await cobrar(doc["id"]!, {
      currency: "USD",
      amount: "2.00000000",
      instrument: "saldo_a_favor",
      customer_credit_id: CREDITO_USD,
    });
    expect(cobro.document_status).toBe("issued");
    // Nominal contra nominal: 2,00 USD menos de deuda y 2,00 USD menos de saldo a favor.
    expect(Number((await deuda(doc["id"]!)).nominal)).toBe(0.78);
    expect((await credito(CREDITO_USD))["applied"]).toBe("2.00000000");
    // El pasivo baja por la PARTE PROPORCIONAL de lo que cargó al nacer (ADR-0075 decisión 5,
    // tercera ronda): 2,00 × 1.899,57 ÷ 2,22 = 1.711,32 (antes, 2 × 855,6625 = 1.711,33: el
    // céntimo que dejaba el pasivo en −0,01 al agotarse). La CxC, a la tasa de la factura
    // (2 × 854,4637 = 1.708,93); la diferencia, 2,39, es ganancia en diferencial.
    const ls = await lineas("payment_received", cobro.payment["id"]!);
    expect(de(ls, "customer_credit_liability")?.debe).toBe("1711.32000000");
    expect(de(ls, "ar_general")?.haber).toBe("1708.93000000");
    expect(de(ls, "exchange_gain")?.haber).toBe("2.39000000");
    expect(de(ls, "caja")).toBeUndefined();
  });

  it("G-05 · al cierre, el saldo a favor en USD que queda se revalúa como pasivo", async () => {
    await tasa("900.00000000");
    const filas = await sql<Record<string, string>[]>`
      select item_kind, currency, original_balance::text as original, carried::text as lleva,
             target::text as objetivo, adjustment::text as ajuste
        from platform.fx_revaluation_items(${COMPANY}, ${HOY}::date)
       where item_kind = 'customer_credit'`;
    // Quedan 0,22 USD: el mayor carga por ellos 1.899,57 − 1.711,32 = 188,25 y a 900 pesan 198,00.
    // El pasivo sube 9,75: en términos de débito, −9,75 (pérdida). (Lo que carga sale ahora de
    // platform.customer_credit_carried, a ocho decimales: misma cifra, otra escala en el texto.)
    expect(filas).toEqual([
      {
        item_kind: "customer_credit",
        currency: "USD",
        original: "0.22000000",
        lleva: "188.25000000",
        objetivo: "198.00",
        ajuste: "-9.75000000",
      },
    ]);
  });

  it("G-15 · el saldo a favor en USD se reembolsa en bolívares a la tasa del día, con su diferencial", async () => {
    await tasa("900.00000000");
    const antes = await saldoDeCuenta(BANCO_BS);
    const r = await pedir("POST", `/v1/customer-credits/${CREDITO_USD}/refunds`, {
      company_id: COMPANY,
      account_id: BANCO_BS,
      amount: "0.22000000",
      reason: "El cliente pidió su dinero",
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const cuerpo = (await r.json()) as Record<string, string>;
    expect(cuerpo).toMatchObject({
      amount: "0.22000000",
      currency: "USD",
      paid_amount: "198.00000000",
      paid_currency: "VES",
      exchange_difference: "-9.75000000",
      credit_remaining: "0.00000000",
      accounting: "posted",
    });
    expect(Number(antes) - Number(await saldoDeCuenta(BANCO_BS))).toBeCloseTo(198, 8);
    expect((await credito(CREDITO_USD))["status"]).toBe("applied");
    // Dr saldos a favor 188,25 (a la tasa con que nació) + Dr pérdida 9,75 = Cr caja 198,00.
    const ls = await lineas("customer_refund", cuerpo["id"]!);
    expect(de(ls, "customer_credit_liability")?.debe).toBe("188.25000000");
    expect(de(ls, "exchange_loss")?.debe).toBe("9.75000000");
    expect(de(ls, "caja")?.haber).toBe("198.00000000");
    // El pasivo de ESE saldo a favor quedó en cero EXACTO: nació 1.899,57 y salieron 1.711,32 +
    // 188,25 (el uso que agota se lleva el resto).
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.fx_revaluation_items(${COMPANY}, ${HOY}::date)
       where item_kind = 'customer_credit'`;
    expect(n!.n).toBe(0);
  });

  it("G-15 · un saldo a favor en Bs se reembolsa en Bs sin diferencial, y la clave natural impide consumir de más", async () => {
    const r = await pedir("POST", `/v1/customer-credits/${CREDITO_BS}/refunds`, {
      company_id: COMPANY,
      account_id: BANCO_BS,
      amount: "840.00000000",
      reason: "Devolución parcial del anticipo",
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const cuerpo = (await r.json()) as Record<string, string>;
    expect(cuerpo).toMatchObject({
      paid_amount: "840.00000000",
      paid_currency: "VES",
      exchange_difference: "0.00000000",
      credit_remaining: "2000.00000000",
    });
    const ls = await lineas("customer_refund", cuerpo["id"]!);
    expect(ls).toEqual([
      { papel: "customer_credit_liability", debe: "840.00000000", haber: "0.00000000" },
      { papel: "caja", debe: "0.00000000", haber: "840.00000000" },
    ]);
    const deMas = await rechazado(`/v1/customer-credits/${CREDITO_BS}/refunds`, {
      account_id: BANCO_BS,
      amount: "2000.01000000",
      reason: "Más de lo que hay",
    });
    expect(deMas.status).toBe(422);
    expect(deMas.message).toContain("disponible");
  });

  it("F-10 · el cobro cuyo sobrante ya se usó no se reversa; el que no, sí, y su saldo a favor deja de estar disponible", async () => {
    // PAGO_BS dejó 2.840 de saldo a favor y ya se reembolsaron 840: no se reversa.
    const no = await rechazado(`/v1/payments/${PAGO_BS}/reversal`, {
      reason: "Se registró en la factura equivocada",
    });
    expect(no.status).toBe(422);
    expect(no.message).toContain("saldo a favor que ya se usó");
    const [sigue] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.payment_reversals where payment_id = ${PAGO_BS}`;
    expect(sigue!.n).toBe(0);

    const doc = (await facturar("1", LISTA_BS))["id"]!;
    const r = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: doc,
      currency: "VES",
      amount: "1200.00000000",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const pago = (await r.json()) as Cobro & { customer_credit: { id: string } };
    const rev = await pedir("POST", `/v1/payments/${pago.payment["id"]!}/reversal`, {
      company_id: COMPANY,
      reason: "Se registró en la factura equivocada",
    });
    expect(rev.status, await rev.clone().text()).toBe(201);
    expect((await credito(pago.customer_credit.id))["status"]).toBe("expired");
    const [d] = await sql<{ status: string; saldo: string }[]>`
      select status, platform.document_balance(${COMPANY}, id)::text as saldo
        from public.documents where id = ${doc}`;
    expect(d).toEqual({ status: "issued", saldo: "1160.00000000" });
    FACTURA_ABIERTA = doc;
  });

  it("el reporte de diferencial cambiario descuenta el diferencial de un cobro reversado, como el mayor", async () => {
    await tasa("854.46370000");
    const doc = await facturar("4");
    await tasa("900.00000000");
    const reporte = async (): Promise<string> => {
      const r = await pedir("GET", `/v1/reports/exchange-difference?from=${HOY}&to=${HOY}`);
      expect(r.status, await r.clone().text()).toBe(200);
      return JSON.stringify(await r.json());
    };
    const antes = await reporte();
    const cobro = await cobrar(doc["id"]!, {
      currency: "USD",
      amount: "5.00000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(cobro.exchange_difference?.["difference"]).toBe("227.68000000");
    expect(await reporte()).not.toBe(antes);
    const rev = await pedir("POST", `/v1/payments/${cobro.payment["id"]!}/reversal`, {
      company_id: COMPANY,
      reason: "El Zelle nunca llegó a la cuenta",
    });
    expect(rev.status, await rev.clone().text()).toBe(201);
    // La fila queda (append-only) y el reporte no la cuenta: vuelve a decir lo de antes.
    expect(await reporte()).toBe(antes);
  });

  it("G-04 · el estado de cuenta enseña la nota de crédito restando, no debiendo, y cuadra con la única función de deuda", async () => {
    await tasa("854.46370000");
    const doc = await facturar("4");
    const [linea] = await sql<{ id: string }[]>`
      select id from public.document_lines where document_id = ${doc["id"]!} limit 1`;
    const nc = await pedir("POST", "/v1/credit-notes", {
      company_id: COMPANY,
      source_document_id: doc["id"]!,
      reason: "Una brocha llegó dañada",
      lines: [{ source_line_id: linea!.id, quantity: "1" }],
    });
    expect(nc.status, await nc.clone().text()).toBe(201);
    const [nota] = await sql<{ id: string }[]>`
      select id from public.documents
       where company_id = ${COMPANY} and kind = 'credit_note'
         and source_document_id = ${doc["id"]!}`;
    if (!nota) throw new Error("la nota de crédito no quedó");
    // G-05: el saldo a favor de la nota nace en la moneda de la nota (USD), con su tasa.
    const [cr] = await sql<Record<string, string>[]>`
      select amount::text as amount, currency, fx_rate::text as fx_rate,
             functional_amount::text as functional
        from public.customer_credits where source_document_id = ${nota.id}`;
    expect(cr).toEqual({
      amount: "2.78000000",
      currency: "USD",
      fx_rate: "854.46370000",
      functional: "2378.82000000",
    });
    await tasa("900.00000000");
    const r = await pedir("GET", `/v1/customers/${CLIENTE}/statement`);
    expect(r.status, await r.clone().text()).toBe(200);
    const estado = (await r.json()) as {
      documents: { id: string; kind: string; balance: string | null; debt_nominal: string }[];
      credits: { source_document_id: string; currency: string }[];
      total_outstanding: string;
    };
    const fila = estado.documents.find((d) => d.id === nota.id)!;
    // 2,78 USD a la tasa de hoy (900) = 2.502,00, RESTANDO.
    expect(fila.balance).toBe("-2502.00");
    expect(fila.debt_nominal).toBe("-2.78000000");
    // Ninguna nota de crédito aparece debiendo.
    for (const d of estado.documents.filter((x) => x.kind === "credit_note")) {
      expect(Number(d.balance)).toBeLessThanOrEqual(0);
    }
    // Y la deuda total es la suma de lo que DEBEN los documentos de deuda (la única función).
    const debe = estado.documents
      .filter((d) => d.kind !== "credit_note" && Number(d.balance) > 0)
      .reduce((a, d) => a + Math.round(Number(d.balance) * 100), 0);
    expect(Math.abs(debe - Math.round(Number(estado.total_outstanding) * 100))).toBeLessThanOrEqual(
      estado.documents.length,
    );
    expect(estado.credits.find((c) => c.source_document_id === nota.id)?.currency).toBe("USD");
  });

  /** Una NC de UNA brocha sobre una factura de cuatro, en USD a 854,4637: saldo a favor 2,78 USD. */
  async function saldoAFavorPorNota(): Promise<{ id: string; nota: string }> {
    const doc = await facturar("4");
    const [linea] = await sql<{ id: string }[]>`
      select id from public.document_lines where document_id = ${doc["id"]!} limit 1`;
    const nc = await pedir("POST", "/v1/credit-notes", {
      company_id: COMPANY,
      source_document_id: doc["id"]!,
      reason: "Una brocha llegó dañada",
      lines: [{ source_line_id: linea!.id, quantity: "1" }],
    });
    expect(nc.status, await nc.clone().text()).toBe(201);
    const [cr] = await sql<{ id: string; nota: string; functional: string; amount: string }[]>`
      select c.id, c.source_document_id as nota, c.functional_amount::text as functional,
             c.amount::text as amount
        from public.customer_credits c
        join public.documents n on n.id = c.source_document_id
       where c.company_id = ${COMPANY} and n.source_document_id = ${doc["id"]!}`;
    // El dato del hallazgo: 2,78 USD que el mayor cargó por 2.378,82 (y 2,78 × 854,4637 = 2.375,41).
    expect({ amount: cr!.amount, functional: cr!.functional }).toEqual({
      amount: "2.78000000",
      functional: "2378.82000000",
    });
    return { id: cr!.id, nota: cr!.nota };
  }
  /** Lo que el MAYOR todavía carga en el pasivo por ESE saldo a favor: nació − sus usos. */
  async function pasivoEnElMayor(c: { id: string; nota: string }): Promise<string> {
    const [f] = await sql<{ v: string }[]>`
      select coalesce(sum(l.functional_credit - l.functional_debit), 0)::text as v
        from public.journal_entries e
        join public.journal_lines l on l.entry_id = e.id
       where e.company_id = ${COMPANY} and e.status = 'posted'
         and l.account_id in (select s.account_id from public.company_account_settings s
                               where s.company_id = ${COMPANY}
                                 and s.purpose = 'customer_credit_liability')
         and (e.source_id = ${c.nota}
              or e.source_id in (select p.id from public.payments p
                                  where p.customer_credit_id = ${c.id})
              or e.source_id in (select r.id from public.customer_refunds r
                                  where r.customer_credit_id = ${c.id}))`;
    return f!.v;
  }

  it("revisión 3 · punto 1: un saldo a favor RETIRADO por la reversa de su cobro no se aplica ni se reembolsa", async () => {
    const doc = (await facturar("1", LISTA_BS))["id"]!; // 1.160 Bs
    const r = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: doc,
      currency: "VES",
      amount: "1500.00000000",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const pago = (await r.json()) as Cobro & { customer_credit: { id: string } };
    const retirado = pago.customer_credit.id;
    const rev = await pedir("POST", `/v1/payments/${pago.payment["id"]!}/reversal`, {
      company_id: COMPANY,
      reason: "Se registró en la factura equivocada",
    });
    expect(rev.status, await rev.clone().text()).toBe(201);
    expect(await credito(retirado)).toMatchObject({ status: "expired", applied: "0.00000000" });

    // El dinero ya salió y el contra-asiento ya deshizo el pasivo: ese saldo no se aplica…
    const aplicar = await rechazado("/v1/payments", {
      document_id: doc,
      currency: "VES",
      amount: "340.00000000",
      instrument: "saldo_a_favor",
      customer_credit_id: retirado,
    });
    expect(aplicar.status).toBe(422);
    expect(aplicar.message).toContain("se retiró");
    // …ni se reembolsa.
    const reembolsar = await rechazado(`/v1/customer-credits/${retirado}/refunds`, {
      account_id: BANCO_BS,
      whole: true,
      reason: "El cliente pidió su dinero",
    });
    expect(reembolsar.status).toBe(422);
    expect(reembolsar.message).toContain("se retiró");
    // Cero filas nuevas, y el saldo sigue retirado y sin tocar.
    const [n] = await sql<{ pagos: number; reembolsos: number }[]>`
      select (select count(*)::int from public.payments
               where customer_credit_id = ${retirado}) as pagos,
             (select count(*)::int from public.customer_refunds
               where customer_credit_id = ${retirado}) as reembolsos`;
    expect({ ...n }).toEqual({ pagos: 0, reembolsos: 0 });
    expect(await credito(retirado)).toMatchObject({ status: "expired", applied: "0.00000000" });
    // El documento sigue debiendo lo suyo.
    const [b] = await sql<{ saldo: string }[]>`
      select platform.document_balance(${COMPANY}, ${doc})::text as saldo`;
    expect(b!.saldo).toBe("1160.00000000");
  });

  it("revisión 3 · punto 14: un saldo a favor no se aplica por más de lo que el documento debe, y lo que sobra no se consume", async () => {
    // CREDITO_BS: nació 2.840 y se reembolsaron 840. Quedan 2.000; el documento debe 1.160.
    const doc = (await facturar("1", LISTA_BS))["id"]!;
    const deMas = await rechazado("/v1/payments", {
      document_id: doc,
      currency: "VES",
      amount: "2000.00000000",
      instrument: "saldo_a_favor",
      customer_credit_id: CREDITO_BS,
    });
    expect(deMas.status).toBe(422);
    expect(deMas.message).toContain("supera lo pendiente");
    expect(deMas.message).toContain("1160.00");
    expect((await credito(CREDITO_BS))["applied"]).toBe("840.00000000");
    const [b] = await sql<{ saldo: string; pagos: number }[]>`
      select platform.document_balance(${COMPANY}, ${doc})::text as saldo,
             (select count(*)::int from public.payments where document_id = ${doc}) as pagos`;
    expect({ ...b }).toEqual({ saldo: "1160.00000000", pagos: 0 });
    // Por lo que debe, sí: el documento queda pagado y el saldo conserva su resto (840).
    const justo = await cobrar(doc, {
      currency: "VES",
      amount: "1160.00000000",
      instrument: "saldo_a_favor",
      customer_credit_id: CREDITO_BS,
    });
    expect(justo.document_status).toBe("paid");
    expect(await credito(CREDITO_BS)).toMatchObject({
      applied: "2000.00000000",
      status: "available",
    });
  });

  it("revisión 3 · punto 2: el pasivo de un saldo a favor en USD nacido de una NC con IVA vuelve a CERO al agotarse, en dos aplicaciones y con reembolso parcial", async () => {
    await tasa("854.46370000");
    // (a) Usado en dos partes, en dos facturas que NO cierran (ningún ajuste de cierre lo tapa).
    const a = await saldoAFavorPorNota();
    const x = (await facturar("4"))["id"]!;
    const y = (await facturar("4"))["id"]!;
    const uno = await cobrar(x, {
      currency: "USD",
      amount: "1.00000000",
      instrument: "saldo_a_favor",
      customer_credit_id: a.id,
    });
    // La parte proporcional de lo que el mayor cargó: 1,00 × 2.378,82 ÷ 2,78 = 855,69.
    const lsUno = await lineas("payment_received", uno.payment["id"]!);
    expect(de(lsUno, "customer_credit_liability")?.debe).toBe("855.69000000");
    // La cuenta por cobrar baja a la tasa del documento (1,00 × 854,4637); el resto es redondeo.
    expect(de(lsUno, "ar_general")?.haber).toBe("854.46000000");
    expect(de(lsUno, "rounding_difference")?.haber).toBe("1.23000000");
    const dos = await cobrar(y, {
      currency: "USD",
      amount: "1.78000000",
      instrument: "saldo_a_favor",
      customer_credit_id: a.id,
    });
    // El uso que AGOTA se lleva el resto exacto: 2.378,82 − 855,69 = 1.523,13.
    const lsDos = await lineas("payment_received", dos.payment["id"]!);
    expect(de(lsDos, "customer_credit_liability")?.debe).toBe("1523.13000000");
    expect((await credito(a.id))["status"]).toBe("applied");
    expect(await pasivoEnElMayor(a)).toBe("0.00000000");

    // (b) Reembolso parcial y después aplicación del resto.
    const b = await saldoAFavorPorNota();
    const r = await pedir("POST", `/v1/customer-credits/${b.id}/refunds`, {
      company_id: COMPANY,
      account_id: BANCO_BS,
      amount: "1.00000000",
      reason: "El cliente pidió parte de su dinero",
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const reembolso = (await r.json()) as Record<string, string>;
    // Sale 1,00 USD a la tasa del día (854,46 Bs); el pasivo baja 855,69; la diferencia, 1,23.
    expect(reembolso).toMatchObject({
      paid_amount: "854.46000000",
      exchange_difference: "1.23000000",
    });
    await cobrar(y, {
      currency: "USD",
      amount: "1.78000000",
      instrument: "saldo_a_favor",
      customer_credit_id: b.id,
    });
    expect((await credito(b.id))["status"]).toBe("applied");
    expect(await pasivoEnElMayor(b)).toBe("0.00000000");
    // Al cierre, lo agotado no deja nada que revaluar: el único saldo a favor en USD vivo de la
    // empresa es el de la nota del caso G-04 (2,78 USD, que el mayor lleva por 2.378,82).
    await tasa("900.00000000");
    const filas = await sql<{ original: string; lleva: string }[]>`
      select original_balance::text as original, carried::text as lleva
        from platform.fx_revaluation_items(${COMPANY}, ${HOY}::date)
       where item_kind = 'customer_credit'`;
    expect(filas).toEqual([{ original: "2.78000000", lleva: "2378.82000000" }]);
  });

  it("revisión 3 · punto 5: el pago de más cruzado (Bs a una factura en USD a otra tasa; USD a una factura en Bs), a un documento ya pagado, y el sobrante usado en parte", async () => {
    // (a) Factura en USD a 854,4637, pagada de más en BOLÍVARES a 900: debe 2,78 USD = 2.502,00;
    // entran 3.000,00; sobran 498,00 Bs, que a 900 son 0,55 USD de saldo a favor (en la moneda
    // del documento, a la tasa del cobro).
    await tasa("854.46370000");
    const enUsd = (await facturar("1"))["id"]!;
    await tasa("900.00000000");
    const r1 = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: enUsd,
      currency: "VES",
      amount: "3000.00000000",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect(r1.status, await r1.clone().text()).toBe(201);
    const c1 = (await r1.json()) as Cobro & { customer_credit: { id: string } | null };
    expect(c1.document_status).toBe("paid");
    expect(await credito(c1.customer_credit!.id)).toMatchObject({
      amount: "0.55000000",
      currency: "USD",
      fx_rate: "900.00000000",
      functional: "495.00000000",
    });
    expect(await abierto("ar", enUsd)).toBe("0.00000000");

    // (b) Factura en Bs (1.160,00) pagada de más en DÓLARES: 2,00 USD a 900 = 1.800,00; sobran
    // 640,00 Bs de saldo a favor, en la moneda del documento.
    const enBs = (await facturar("1", LISTA_BS))["id"]!;
    const r2 = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: enBs,
      currency: "USD",
      amount: "2.00000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(r2.status, await r2.clone().text()).toBe(201);
    const c2 = (await r2.json()) as Cobro & { customer_credit: { id: string } | null };
    expect(c2.document_status).toBe("paid");
    expect(await credito(c2.customer_credit!.id)).toMatchObject({
      amount: "640.00000000",
      currency: "VES",
      functional: "640.00000000",
    });

    // (c) A un documento que ya no debe nada no se le cobra: ni pago de más ni saldo a favor.
    const yaPagado = await rechazado("/v1/payments", {
      document_id: enBs,
      currency: "VES",
      amount: "50.00000000",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect(yaPagado.status).toBe(422);
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.payments where document_id = ${enBs}`;
    expect(n!.n).toBe(1);

    // (d) El sobrante de (b) usado EN PARTE por una aplicación: su cobro ya no se reversa, y el
    // mensaje dice qué hacer (reversar primero la aplicación), no habla de un reembolso.
    const otra = (await facturar("1", LISTA_BS))["id"]!;
    await cobrar(otra, {
      currency: "VES",
      amount: "100.00000000",
      instrument: "saldo_a_favor",
      customer_credit_id: c2.customer_credit!.id,
    });
    const no = await rechazado(`/v1/payments/${c2.payment["id"]!}/reversal`, {
      reason: "Se registró en la factura equivocada",
    });
    expect(no.status).toBe(422);
    expect(no.message).toContain("Reversa primero el cobro que lo aplicó");
    expect(no.message).not.toContain("reembolso");
    expect(await credito(c2.customer_credit!.id)).toMatchObject({
      status: "available",
      applied: "100.00000000",
    });
    // Y el caso del reembolso dice lo suyo: PAGO_BS dejó un saldo que se reembolsó en parte.
    const reembolsado = await rechazado(`/v1/payments/${PAGO_BS}/reversal`, {
      reason: "Se registró en la factura equivocada",
    });
    expect(reembolsado.status).toBe(422);
    expect(reembolsado.message).toContain("un reembolso no se deshace");
  });

  it("revisión 3 · punto 5: un saldo a favor en USD se reembolsa desde una cuenta en USD — salen los dólares, el pasivo baja lo que cargaba y la diferencia va al diferencial", async () => {
    await tasa("854.46370000");
    const s = await saldoAFavorPorNota(); // 2,78 USD que el mayor carga por 2.378,82
    await tasa("900.00000000");
    const antes = await saldoDeCuenta(BANCO_USD);
    const r = await pedir("POST", `/v1/customer-credits/${s.id}/refunds`, {
      company_id: COMPANY,
      account_id: BANCO_USD,
      whole: true,
      reason: "El cliente pidió su dinero en dólares",
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const cuerpo = (await r.json()) as Record<string, string>;
    // Salen 2,78 USD, que hoy pesan 2.502,00; el pasivo cargaba 2.378,82: pérdida de 123,18.
    expect(cuerpo).toMatchObject({
      amount: "2.78000000",
      currency: "USD",
      paid_amount: "2.78000000",
      paid_currency: "USD",
      exchange_difference: "-123.18000000",
      credit_remaining: "0.00000000",
      accounting: "posted",
    });
    expect(Number(antes) - Number(await saldoDeCuenta(BANCO_USD))).toBeCloseTo(2.78, 8);
    const ls = await lineas("customer_refund", cuerpo["id"]!);
    expect(de(ls, "customer_credit_liability")?.debe).toBe("2378.82000000");
    expect(de(ls, "exchange_loss")?.debe).toBe("123.18000000");
    expect(de(ls, "caja")?.haber).toBe("2502.00000000");
    expect(await pasivoEnElMayor(s)).toBe("0.00000000");
    // El original en dólares de la subcuenta cuadra con el saldo de la caja en su moneda.
    const divisa = await sql`select * from platform.treasury_currency_gaps(${COMPANY})`;
    expect(divisa).toEqual([]);
  });

  it("F-12 · la cartera por documento es la cuenta por cobrar del mayor, y los demás invariantes siguen en cero", async () => {
    const [n] = await sql<Record<string, number>[]>`
      select (select count(*)::int from platform.accounting_coverage_gaps(${COMPANY})) as cobertura,
             (select count(*)::int from platform.settled_ledger_gaps(${COMPANY})) as saldados,
             (select count(*)::int from platform.treasury_ledger_gaps(${COMPANY})) as tesoreria,
             (select count(*)::int from platform.treasury_currency_gaps(${COMPANY})) as divisa,
             (select count(*)::int from platform.cent_gaps(${COMPANY})) as centimo`;
    // F-12: once operaciones después (pagos de más, saldos a favor aplicados y reembolsados,
    // reversas, una nota de crédito), la cartera sigue siendo la cuenta por cobrar del mayor.
    // En su empresa propia: CERO filas, sin «la brecha conocida».
    const carteraFilas = await sql`select * from platform.receivables_ledger_gap(${COMPANY})`;
    expect(carteraFilas).toEqual([]);
    // Y los saldos a favor vivos son el pasivo del mayor (customer_credit_ledger_gap).
    const pasivoFilas = await sql`select * from platform.customer_credit_ledger_gap(${COMPANY})`;
    expect(pasivoFilas).toEqual([]);
    expect({ ...n }).toEqual({
      cobertura: 0,
      saldados: 0,
      tesoreria: 0,
      divisa: 0,
      centimo: 0,
    });
    const [b] = await sql<{ d: string }[]>`
      select coalesce(sum(period_debit) - sum(period_credit), 0)::text as d
        from platform.trial_balance(${COMPANY}, '2000-01-01'::date, '2100-01-01'::date)`;
    expect(Number(b!.d)).toBe(0);
  });

  it("VARIANTE ROTA · F-12: un asiento que mueve la cuenta por cobrar sin documento, y un cobro que dice haber cancelado otra cifra, dan fila", async () => {
    // (a) Una factura que deja de contar sin que su asiento se revierta: su cargo queda en la
    // cuenta por cobrar y ningún documento lo explica.
    let conLinea = 0;
    // (b) Un cobro cuyo «cancelado» guardado no es lo que su asiento acreditó.
    let conCobro = 0;
    await sql
      .begin(async (tx) => {
        await tx`set local lock_timeout = '4s'`;
        await tx`alter table public.documents disable trigger user`;
        await tx`update public.documents set status = 'annulled', annulled_at = now(),
                        annul_reason = 'variante rota'
                  where id = ${FACTURA_ABIERTA}`;
        conLinea = await brecha(tx);
        throw new Error("deshacer");
      })
      .catch((e: unknown) => {
        if (!(e instanceof Error) || e.message !== "deshacer") throw e;
      });
    await sql
      .begin(async (tx) => {
        await tx`set local lock_timeout = '4s'`;
        await tx`alter table public.payments disable trigger user`;
        await tx`update public.payments set cancelled_functional_amount = 1000
                  where id = ${PAGO_BS}`;
        conCobro = await brecha(tx);
        throw new Error("deshacer");
      })
      .catch((e: unknown) => {
        if (!(e instanceof Error) || e.message !== "deshacer") throw e;
      });
    // (a) El mayor conserva los 1.160 que la factura cargó; los documentos ya no los explican.
    expect(conLinea).toBeCloseTo(-1160, 8);
    // (b) El cobro canceló 1.160 y dice 1.000: sobran 160 en lo esperado.
    expect(conCobro).toBeCloseTo(160, 8);
    expect(await brecha()).toBe(0);
  });
});

describe("ola 4 · cobros, segunda pasada: el reporte ve el saldo a favor cruzado, la clave natural del sobrante, el sobregiro, el permiso y los comprobantes", () => {
  let CREDITO = "";
  let PAGO_CON_SOBRANTE = "";

  /** Infla los streams del PDF y decodifica los <hex> de los TJ (como en e2e-fiscal-legal). */
  async function textoDelPdf(r: Response): Promise<string> {
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
    return [...texto.matchAll(/<([0-9a-fA-F]+)>/g)]
      .map((m) => Buffer.from(m[1]!, "hex").toString("latin1"))
      .join("");
  }
  const reporte = async (): Promise<{ ganancia: string; perdida: string; neto: string }> => {
    const r = await pedir("GET", `/v1/reports/exchange-difference?from=${HOY}&to=${HOY}`);
    expect(r.status, await r.clone().text()).toBe(200);
    return (await r.json()) as { ganancia: string; perdida: string; neto: string };
  };
  /** El resultado cambiario que el MAYOR lleva por un hecho: ganancia − pérdida. */
  const resultadoEnElMayor = async (sourceId: string): Promise<number> => {
    const [f] = await sql<{ v: string }[]>`
      select coalesce(sum(l.functional_credit - l.functional_debit), 0)::text as v
        from public.journal_entries e
        join public.journal_lines l on l.entry_id = e.id
       where e.company_id = ${COMPANY} and e.source_id = ${sourceId} and e.status = 'posted'
         and l.account_id in (select s.account_id from public.company_account_settings s
                               where s.company_id = ${COMPANY}
                                 and s.purpose in ('exchange_gain', 'exchange_loss'))`;
    return Number(f!.v);
  };
  const conPermiso = async (permiso: string, tiene: boolean): Promise<void> => {
    if (tiene) {
      await sql`insert into public.role_permissions (role_id, permission_key)
                values (${ROL}, ${permiso}) on conflict do nothing`;
    } else {
      await sql`delete from public.role_permissions
                 where role_id = ${ROL} and permission_key = ${permiso}`;
    }
  };

  beforeAll(async () => {
    await conPermiso("sales.refund", true);
    await conPermiso("sales.return.manage", true);
  });

  it("F-10 · la clave natural del sobrante: el reintento con la misma llave no duplica el saldo a favor, y un segundo sobrante del mismo cobro muere en el esquema", async () => {
    await tasa("855.66250000");
    const doc = await facturar("1"); // 2,78 USD
    const llave = crypto.randomUUID();
    const cobrarConLlave = async (): Promise<Response> =>
      app.request("/v1/payments", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await tokenDe(DUENO)}`,
          "X-Company-Id": COMPANY,
          "Idempotency-Key": llave,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          company_id: COMPANY,
          document_id: doc["id"]!,
          currency: "USD",
          amount: "5.00000000",
          instrument: "zelle",
          account_id: BANCO_USD,
        }),
      });
    const primera = await cobrarConLlave();
    expect(primera.status, await primera.clone().text()).toBe(201);
    const a = (await primera.json()) as Cobro & { customer_credit: { id: string } };
    const segunda = await cobrarConLlave();
    expect(segunda.status, await segunda.clone().text()).toBe(201);
    const b = (await segunda.json()) as Cobro & { customer_credit: { id: string } };
    expect(b.payment["id"]).toBe(a.payment["id"]);
    expect(b.customer_credit.id).toBe(a.customer_credit.id);
    const [n] = await sql<{ cobros: number; saldos: number }[]>`
      select (select count(*)::int from public.payments where document_id = ${doc["id"]!}) as cobros,
             (select count(*)::int from public.customer_credits
               where source_payment_id = ${a.payment["id"]!}) as saldos`;
    expect(n).toEqual({ cobros: 1, saldos: 1 });
    CREDITO = a.customer_credit.id;
    PAGO_CON_SOBRANTE = a.payment["id"]!;

    // La segunda defensa, ejercida sin pasar por la idempotencia: otro saldo a favor del MISMO
    // cobro muere en el único parcial (source_payment_id).
    let sqlstate = "";
    await sql`
      insert into public.customer_credits
        (tenant_id, company_id, customer_id, source_document_id, source_payment_id, amount,
         currency, fx_rate, rate_source, functional_amount)
      values (${TENANT}, ${COMPANY}, ${CLIENTE}, ${doc["id"]!}, ${a.payment["id"]!}, 1, 'USD',
              855.6625, 'e2e', 855.66)`.catch((e: unknown) => {
      sqlstate = (e as { code?: string }).code ?? "";
      expect((e as { constraint_name?: string }).constraint_name).toBe(
        "customer_credits_source_payment_key",
      );
    });
    expect(sqlstate).toBe("23505");
  });

  it("F-10 · el comprobante del cobro dice cuánto se pagó, cuánto se aplicó y el saldo a favor, y que no es fiscal", async () => {
    const r = await pedir("GET", `/v1/payments/${PAGO_CON_SOBRANTE}/pdf`);
    expect(r.status, await r.clone().text()).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/pdf");
    const texto = await textoDelPdf(r);
    expect(texto).toContain("COMPROBANTE DE COBRO");
    expect(texto).toContain("Documento no fiscal");
    // La forma de pago con su nombre de persona, no la llave del catálogo.
    expect(texto).toContain("Forma de pago: Zelle");
    expect(texto).toContain("Recibido: USD 5,00");
    expect(texto).toContain("Aplicado al documento: USD 2,78");
    expect(texto).toContain("Saldo a favor: USD 2,22");
    expect(texto).toContain("Constructora e2e moneda");
    expect(texto).not.toContain("PEND-");
    expect(texto).not.toContain("N° de Control");
    expect(texto).not.toContain("IVA");
  });

  it("G-05 · un saldo a favor en USD aplicado a una factura en BOLÍVARES deja su diferencial donde el reporte lo ve: el reporte cuenta lo mismo que el asiento", async () => {
    await tasa("900.00000000");
    const doc = (await facturar("1", LISTA_BS))["id"]!; // 1.160,00 Bs
    const antes = await reporte();
    const cobro = await cobrar(doc, {
      currency: "USD",
      amount: "1.00000000",
      instrument: "saldo_a_favor",
      customer_credit_id: CREDITO,
    });
    // 1 USD vale hoy 900,00 (lo que baja la factura); el pasivo lo llevaba a 855,66: 44,34 de
    // pérdida en diferencial.
    const enMayor = await resultadoEnElMayor(cobro.payment["id"]!);
    expect(enMayor).toBeCloseTo(-44.34, 2);
    const despues = await reporte();
    expect(Number(despues.neto) - Number(antes.neto)).toBeCloseTo(enMayor, 2);
    expect(Number(despues.perdida) - Number(antes.perdida)).toBeCloseTo(-44.34, 2);
    const [fila] = await sql<Record<string, string>[]>`
      select difference::text as difference, transaction_currency,
             amount_transaction::text as amount_transaction
        from public.exchange_gain_loss where payment_id = ${cobro.payment["id"]!}`;
    expect(fila).toEqual({
      difference: "-44.34000000",
      transaction_currency: "USD",
      amount_transaction: "1.00000000",
    });
    const [b] = await sql<{ saldo: string }[]>`
      select platform.document_balance(${COMPANY}, ${doc})::text as saldo`;
    expect(b!.saldo).toBe("260.00000000");
  });

  it("G-15 · reembolsar exige sales.refund: sin él, 403 con su mensaje de persona, y nada sale de la caja", async () => {
    await conPermiso("sales.refund", false);
    try {
      const r = await pedir("POST", `/v1/customer-credits/${CREDITO}/refunds`, {
        company_id: COMPANY,
        account_id: BANCO_USD,
        whole: true,
        reason: "Sin el permiso",
      });
      expect(r.status).toBe(403);
      const cuerpo = (await r.json()) as { code: string; message: string; person_message: string };
      expect(cuerpo.code).toBe("PERMISSION_REQUIRED");
      expect(cuerpo.message).toContain("sales.refund");
      expect(cuerpo.person_message).toContain("devolver dinero a un cliente");
      const [n] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.customer_refunds
         where customer_credit_id = ${CREDITO}`;
      expect(n!.n).toBe(0);
    } finally {
      await conPermiso("sales.refund", true);
    }
  });

  it("G-15 · el cuerpo del reembolso lleva EXACTAMENTE uno de `amount` o `whole`", async () => {
    const base = { account_id: BANCO_USD, reason: "Forma del cuerpo" };
    // Las cuatro combinaciones: ninguno y los dos, aquí (422 con SU mensaje, no un 422 cualquiera);
    // solo `amount`, en «G-15 · un saldo a favor en Bs se reembolsa en Bs…»; solo `whole`, en el
    // caso del sobregiro de más abajo. Los dos últimos mueven dinero y dan 201.
    // El texto LITERAL que lee la persona (packages/schemas/src/sales.ts, MENSAJE_IMPORTE_O_TODO).
    const MENSAJE_IMPORTE_O_TODO =
      "Di cuánto se devuelve: un importe, o todo lo que queda disponible. Una de las dos cosas, no las dos.";
    const mensajes = async (cuerpo: Record<string, unknown>): Promise<string[]> => {
      const r = await pedir("POST", `/v1/customer-credits/${CREDITO}/refunds`, {
        company_id: COMPANY,
        ...cuerpo,
      });
      expect(r.status).toBe(422);
      const b = (await r.json()) as { code: string; details: { message: string }[] };
      expect(b.code).toBe("VALIDATION_FAILED");
      return b.details.map((d) => d.message);
    };
    const ninguno = await rechazado(`/v1/customer-credits/${CREDITO}/refunds`, base);
    expect(ninguno.status).toBe(422);
    expect(await mensajes(base)).toContain(MENSAJE_IMPORTE_O_TODO);
    const losDos = await rechazado(`/v1/customer-credits/${CREDITO}/refunds`, {
      ...base,
      amount: "1.00000000",
      whole: true,
    });
    expect(losDos.status).toBe(422);
    expect(await mensajes({ ...base, amount: "1.00000000", whole: true })).toContain(
      MENSAJE_IMPORTE_O_TODO,
    );
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.customer_refunds where customer_credit_id = ${CREDITO}`;
    expect(n!.n).toBe(0);
  });

  it("G-15 + D-11 · sin saldo en la cuenta: 409 que dice qué hacer; sobregirar exige treasury.overdraft y el motivo; con los dos, sale y deja su comprobante", async () => {
    await tasa("900.00000000");
    // Una cuenta nueva, vacía: el reembolso la dejaría en negativo.
    const cta = await pedir("POST", "/v1/treasury/accounts", {
      company_id: COMPANY,
      name: `Caja vacía ${RUN}`,
      currency: "VES",
      kind: "cash",
    });
    expect(cta.status, await cta.clone().text()).toBe(201);
    const VACIA = ((await cta.json()) as { id: string }).id;
    const cuerpo = {
      company_id: COMPANY,
      account_id: VACIA,
      whole: true,
      reason: "El cliente pidió su dinero",
    };

    await conPermiso("treasury.overdraft", false);
    const sinSaldo = await pedir("POST", `/v1/customer-credits/${CREDITO}/refunds`, cuerpo);
    expect(sinSaldo.status).toBe(409);
    const e1 = (await sinSaldo.json()) as { code: string; message: string };
    expect(e1.code).toBe("INSUFFICIENT_FUNDS");
    expect(e1.message).toContain("Elige otra cuenta");

    const sinPermiso = await pedir("POST", `/v1/customer-credits/${CREDITO}/refunds`, {
      ...cuerpo,
      allow_negative_balance: true,
      overdraft_reason: "La caja se repone mañana",
    });
    expect(sinPermiso.status).toBe(403);
    expect(((await sinPermiso.json()) as { message: string }).message).toContain(
      "treasury.overdraft",
    );

    await conPermiso("treasury.overdraft", true);
    try {
      const sinMotivo = await pedir("POST", `/v1/customer-credits/${CREDITO}/refunds`, {
        ...cuerpo,
        allow_negative_balance: true,
      });
      expect(sinMotivo.status).toBe(422);
      const [nada] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.customer_refunds
         where customer_credit_id = ${CREDITO}`;
      expect(nada!.n).toBe(0);

      const ok = await pedir("POST", `/v1/customer-credits/${CREDITO}/refunds`, {
        ...cuerpo,
        allow_negative_balance: true,
        overdraft_reason: "La caja se repone mañana",
      });
      expect(ok.status, await ok.clone().text()).toBe(201);
      const reembolso = (await ok.json()) as Record<string, string>;
      // Quedaban 1,22 USD (2,22 − 1,00 aplicado): a 900 salen 1.098,00 Bs.
      expect(reembolso).toMatchObject({
        amount: "1.22000000",
        currency: "USD",
        paid_amount: "1098.00000000",
        paid_currency: "VES",
        credit_remaining: "0.00000000",
      });
      const [saldo] = await sql<{ b: string }[]>`
        select balance::text as b from public.company_account_balances where account_id = ${VACIA}`;
      expect(saldo!.b).toBe("-1098.00000000");
      const [acta] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.audit_events
         where company_id = ${COMPANY} and event_type = 'treasury.overdraft.confirmed'
           and aggregate_id = ${VACIA}`;
      expect(acta!.n).toBe(1);

      // El comprobante del reembolso: documento no fiscal, con todo lo que pasó.
      const pdf = await pedir("GET", `/v1/customer-refunds/${reembolso["id"]!}/pdf`);
      expect(pdf.status, await pdf.clone().text()).toBe(200);
      expect(pdf.headers.get("content-type")).toBe("application/pdf");
      const texto = await textoDelPdf(pdf);
      expect(texto).toContain("COMPROBANTE DE REEMBOLSO");
      expect(texto).toContain("Documento no fiscal");
      expect(texto).toContain("Ferretería del diferencial");
      expect(texto).toContain("Constructora e2e moneda");
      expect(texto).toContain("Saldo a favor devuelto: USD 1,22");
      expect(texto).toContain("Salió de la cuenta: Bs. 1.098,00");
      expect(texto).toContain("Tasa del día: 900,00");
      expect(texto).toContain(`Caja vacía ${RUN}`);
      expect(texto).toContain("Motivo: El cliente pidió su dinero");
      expect(texto).toContain(reembolso["id"]!.slice(-8).toUpperCase());
      expect(texto).not.toContain("PEND-");
      expect(texto).not.toContain("N° de Control");
      expect(texto).not.toContain("IVA");
    } finally {
      await conPermiso("treasury.overdraft", false);
    }
  });

  it("revisión 3 · puntos 5 y 9: el comprobante de un cobro REVERSADO dice que su saldo a favor se retiró; y los comprobantes no se leen desde otra empresa ni sin permiso", async () => {
    const doc = (await facturar("1", LISTA_BS))["id"]!;
    const r = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: doc,
      currency: "VES",
      amount: "1500.00000000",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const pago = (await r.json()) as Cobro;
    const antes = await textoDelPdf(await pedir("GET", `/v1/payments/${pago.payment["id"]!}/pdf`));
    expect(antes).toContain("queda a su nombre");
    const rev = await pedir("POST", `/v1/payments/${pago.payment["id"]!}/reversal`, {
      company_id: COMPANY,
      reason: "Se registró en la factura equivocada",
    });
    expect(rev.status, await rev.clone().text()).toBe(201);
    const pdf = await pedir("GET", `/v1/payments/${pago.payment["id"]!}/pdf`);
    expect(pdf.status, await pdf.clone().text()).toBe(200);
    const texto = await textoDelPdf(pdf);
    expect(texto).toContain("ESTE COBRO FUE REVERSADO");
    expect(texto).toContain("Saldo a favor: Bs. 340,00 (retirado)");
    expect(texto).toContain("se retiró al reversar el cobro");
    expect(texto).not.toContain("queda a su nombre");

    // Aislamiento: la MISMA persona es miembro de las dos empresas (el atacante realista). Desde
    // la otra, el comprobante de un cobro y el de un reembolso de ESTA no existen.
    const [reembolso] = await sql<{ id: string }[]>`
      select id from public.customer_refunds where company_id = ${COMPANY} limit 1`;
    for (const ruta of [
      `/v1/payments/${PAGO_CON_SOBRANTE}/pdf`,
      `/v1/customer-refunds/${reembolso!.id}/pdf`,
    ]) {
      const ajeno = await pedir("GET", ruta, undefined, COMPANY2);
      expect(ajeno.status, ruta).toBe(404);
      expect(ajeno.headers.get("content-type") ?? "").not.toContain("application/pdf");
    }
    // Sin permiso: 403, y tampoco sale el PDF.
    const permisos = ["sales.payment.register", "ar.read", "sales.refund"];
    try {
      for (const p of permisos) await conPermiso(p, false);
      for (const ruta of [
        `/v1/payments/${PAGO_CON_SOBRANTE}/pdf`,
        `/v1/customer-refunds/${reembolso!.id}/pdf`,
      ]) {
        const sin = await pedir("GET", ruta);
        expect(sin.status, ruta).toBe(403);
      }
    } finally {
      for (const p of permisos) await conPermiso(p, true);
    }
  });

  it("y la cartera, el diferencial y los demás invariantes siguen en su sitio", async () => {
    const [n] = await sql<Record<string, number>[]>`
      select (select count(*)::int from platform.accounting_coverage_gaps(${COMPANY})) as cobertura,
             (select count(*)::int from platform.settled_ledger_gaps(${COMPANY})) as saldados,
             (select count(*)::int from platform.treasury_ledger_gaps(${COMPANY})) as tesoreria,
             (select count(*)::int from platform.treasury_currency_gaps(${COMPANY})) as divisa,
             (select count(*)::int from platform.cent_gaps(${COMPANY})) as centimo`;
    expect({ ...n }).toEqual({ cobertura: 0, saldados: 0, tesoreria: 0, divisa: 0, centimo: 0 });
  });
});

describe("ola 4 · compras: el pago cruzado a TASA REAL cierra — factura en Bs pagada desde una cuenta en USD (D-02, ADR-0075 nota «el pago que cierra»)", () => {
  /**
   * Los E2E del pago cruzado usaban 40 Bs/USD, donde toda conversión cae exacta: pasaban gracias
   * a una tasa cómoda. A 854,4637, lo que sale de una cuenta en USD se redondea al céntimo de
   * dólar (hasta medio céntimo × tasa ≈ 4,27 Bs), y el pago que cerraba una factura en Bs se
   * rechazaba con SETTLEMENT_MISMATCH casi siempre.
   */
  const TASA_REAL = "854.46370000";
  const SOBREGIRO = {
    allow_negative_balance: true,
    overdraft_reason: "Fixture E2E: se confirma el sobregiro con su motivo",
  };
  // Las cuentas de este fichero no tienen fondos: el sobregiro se confirma, y eso exige el
  // permiso (D-11). El bloque anterior lo retira al terminar; aquí se pone y se vuelve a quitar.
  beforeAll(async () => {
    await sql`insert into public.role_permissions (role_id, permission_key)
              values (${ROL}, 'treasury.overdraft') on conflict do nothing`;
  });
  afterAll(async () => {
    await sql`delete from public.role_permissions
               where role_id = ${ROL} and permission_key = 'treasury.overdraft'`;
  });
  async function factura(numero: string, moneda: "VES" | "USD", precio: string): Promise<string> {
    const r = await pedir("POST", "/v1/supplier-invoices", {
      company_id: COMPANY,
      supplier_id: PROVEEDOR,
      supplier_document_number: `${numero}-${RUN}`,
      supplier_control_number: `00-${numero.replace(/\D/g, "").padStart(7, "0")}`,
      invoice_date: HOY,
      currency: moneda,
      lines: [{ product_id: HARINA, quantity: "10", unit_price: precio }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    return ((await r.json()) as { id: string }).id;
  }
  const pago = (cuerpo: Record<string, unknown>): Promise<Response> =>
    pedir("POST", "/v1/supplier-payments", { company_id: COMPANY, ...SOBREGIRO, ...cuerpo });
  /** El saldo de la factura en su moneda, y ese saldo llevado a USD al céntimo, a la tasa real. */
  const saldoDe = async (id: string): Promise<{ saldo: string; enUsd: string }> => {
    const [f] = await sql<{ saldo: string; en_usd: string }[]>`
      select b.s::numeric(24,8)::text as saldo,
             round(b.s / ${TASA_REAL}::numeric, 2)::numeric(24,8)::text as en_usd
        from (select platform.supplier_invoice_balance(${COMPANY}, ${id}::uuid) as s) b`;
    return { saldo: f!.saldo, enUsd: f!.en_usd };
  };
  const filaDe = async (id: string): Promise<Record<string, string>> =>
    (
      await sql<Record<string, string>[]>`
        select transaction_currency as moneda, net_amount::text as salio,
               settled_amount::text as saldado, settled_currency as moneda_saldada,
               functional_amount::text as funcional, exchange_difference::text as dif
          from public.supplier_payments where id = ${id}`
    )[0]!;
  const estadoDe = async (id: string): Promise<string> =>
    (
      await sql<{ s: string }[]>`select status as s from public.supplier_invoices where id = ${id}`
    )[0]!.s;
  const invariantes = async (): Promise<void> => {
    const [n] = await sql<Record<string, number>[]>`
      select (select count(*)::int from platform.settled_ledger_gaps(${COMPANY})) as saldados,
             (select count(*)::int from platform.treasury_currency_gaps(${COMPANY})) as divisa,
             (select count(*)::int from platform.treasury_ledger_gaps(${COMPANY})) as tesoreria,
             (select count(*)::int from platform.cent_gaps(${COMPANY})) as centimo`;
    expect({ ...n }).toEqual({ saldados: 0, divisa: 0, tesoreria: 0, centimo: 0 });
    const [b] = await sql<{ d: string }[]>`
      select coalesce(sum(period_debit) - sum(period_credit), 0)::text as d
        from platform.trial_balance(${COMPANY}, ${HOY}::date, null)`;
    expect(Number(b!.d)).toBe(0);
  };

  it("a · una factura de mercancía en Bs pagada ENTERA desde una cuenta en USD a 854,4637 cierra: sale lo redondeado al céntimo de dólar, lo funcional es lo que se debía y no hay diferencial", async () => {
    await tasa(TASA_REAL);
    const f = await factura("TR-1", "VES", "124");
    const debe = await saldoDe(f);
    // La conversión NO cae exacta: si lo hiciera, este caso no probaría nada.
    const [exacta] = await sql<{ si: boolean }[]>`
      select round(${debe.enUsd}::numeric * ${TASA_REAL}::numeric, 2) = ${debe.saldo}::numeric as si`;
    expect(exacta!.si).toBe(false);
    // LA VISTA PREVIA dice lo que sale y lo que cancela ANTES de confirmar (antes: 409).
    const previa = await pedir("POST", "/v1/supplier-payments/preview", {
      company_id: COMPANY,
      supplier_invoice_id: f,
      gross_amount: debe.saldo,
      currency: "VES",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(previa.status, await previa.clone().text()).toBe(200);
    expect((await previa.json()) as Record<string, unknown>).toMatchObject({
      money_amount: debe.enUsd,
      money_currency: "USD",
      settled_amount: debe.saldo,
      settled_currency: "VES",
      crossed: true,
      fx_rate: TASA_REAL,
      balance_after: "0.00000000",
    });
    const r = await pago({
      supplier_invoice_id: f,
      gross_amount: debe.saldo,
      currency: "VES",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const p = (await r.json()) as { payment: { id: string }; invoice_status: string };
    expect(p.invoice_status).toBe("paid");
    // El asiento: cuenta por pagar contra la caja, por lo que se debía. Sin tercera línea: ni
    // diferencial cambiario ni redondeo inventados por el céntimo de dólar.
    const lineas = await asiento("payment_made", p.payment.id);
    expect(lineas.map((l) => [l.papel, l.debe, l.haber])).toEqual([
      ["ap_general", debe.saldo, "0.00000000"],
      [null, "0.00000000", debe.saldo],
    ]);
    expect({ ...(await filaDe(p.payment.id)) }).toEqual({
      moneda: "USD",
      salio: debe.enUsd,
      saldado: debe.saldo,
      moneda_saldada: "VES",
      // Lo funcional del pago que cierra es lo PENDIENTE, no «lo que salió × tasa».
      funcional: debe.saldo,
      dif: "0.00000000",
    });
    expect(await abierto("ap", f)).toBe("0.00000000");
    await invariantes();
  });

  it("c · el sentido contrario: una factura en USD pagada entera desde una cuenta en Bs a 854,4637 cierra", async () => {
    await tasa(TASA_REAL);
    const f = await factura("TR-3", "USD", "3.33");
    const debe = await saldoDe(f);
    const r = await pago({
      supplier_invoice_id: f,
      gross_amount: debe.saldo,
      currency: "USD",
      instrument: "transferencia",
      account_id: BANCO_BS,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const p = (await r.json()) as { payment: { id: string }; invoice_status: string };
    expect(p.invoice_status).toBe("paid");
    const fila = await filaDe(p.payment.id);
    expect(fila["moneda"]).toBe("VES");
    expect(fila["saldado"]).toBe(debe.saldo);
    expect(fila["dif"]).toBe("0.00000000");
    expect(await abierto("ap", f)).toBe("0.00000000");
    await invariantes();
  });

  it("d · un abono cruzado de 0,50 USD y luego el pago que cierra, escrito en dólares: la factura en Bs queda pagada y la cuenta por pagar en cero", async () => {
    await tasa(TASA_REAL);
    const f = await factura("TR-4", "VES", "124");
    const abono = await pago({
      supplier_invoice_id: f,
      gross_amount: "0.50",
      currency: "USD",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(abono.status, await abono.clone().text()).toBe(201);
    expect(((await abono.json()) as { invoice_status: string }).invoice_status).toBe("posted");
    const queda = await saldoDe(f);
    const cierre = await pago({
      supplier_invoice_id: f,
      gross_amount: queda.enUsd,
      currency: "USD",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(cierre.status, await cierre.clone().text()).toBe(201);
    const p = (await cierre.json()) as { payment: { id: string }; invoice_status: string };
    expect(p.invoice_status).toBe("paid");
    const fila = await filaDe(p.payment.id);
    expect(fila["salio"]).toBe(queda.enUsd);
    expect(fila["saldado"]).toBe(queda.saldo);
    expect(fila["dif"]).toBe("0.00000000");
    expect(await abierto("ap", f)).toBe("0.00000000");
    expect((await saldoDe(f)).saldo).toBe("0.00000000");
    await invariantes();
  });

  it("d2 · un abono que NO cierra, escrito en Bs (lo que se CANCELA) desde la cuenta en USD: salen céntimos de dólar, lo funcional es lo que SALIÓ y la diferencia con lo cancelado se asienta en el acto", async () => {
    await tasa(TASA_REAL);
    const f = await factura("TR-8", "VES", "124");
    const r = await pago({
      supplier_invoice_id: f,
      gross_amount: "500.00000000",
      currency: "VES",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const p = (await r.json()) as { payment: { id: string }; invoice_status: string };
    expect(p.invoice_status).toBe("posted");
    // 500 / 854,4637 = 0,5851… → 0,59 USD, que a la tasa son 504,13 Bs. La alineación de lo
    // funcional es SOLO del pago que cierra (como ventas): un abono se asienta por lo que salió,
    // y los 4,13 Bs van al diferencial en el acto, no se quedan en la valoración de la caja.
    expect({ ...(await filaDe(p.payment.id)) }).toEqual({
      moneda: "USD",
      salio: "0.59000000",
      saldado: "500.00000000",
      moneda_saldada: "VES",
      funcional: "504.13000000",
      dif: "4.13000000",
    });
    const lineas = await asiento("payment_made", p.payment.id);
    expect(lineas.map((l) => [l.papel, l.debe, l.haber])).toEqual([
      ["ap_general", "500.00000000", "0.00000000"],
      [null, "0.00000000", "504.13000000"],
      ["exchange_loss", "4.13000000", "0.00000000"],
    ]);
    expect(await abierto("ap", f)).toBe("938.40000000");
    await invariantes();
  });

  it("d3 · TRES abonos en Bs desde la cuenta en USD y el que cierra: cada abono asienta su diferencia, el que cierra no, la cuenta por pagar queda en cero y de la caja salió lo que salió", async () => {
    await tasa(TASA_REAL);
    const f = await factura("TR-11", "VES", "124"); // 1.240,00 + 16 % = 1.438,40 Bs
    expect((await saldoDe(f)).saldo).toBe("1438.40000000");
    const [antesCaja] = await sql<{ s: string }[]>`
      select coalesce(sum(net_amount), 0)::text as s from public.supplier_payments
       where account_id = ${BANCO_USD}`;
    // [lo que se cancela en Bs, lo que sale en USD, lo funcional, la diferencia, el papel]
    const pasos = [
      // 500 ÷ 854,4637 = 0,5851… → 0,59 USD = 504,13 Bs: pérdida de 4,13.
      ["500.00000000", "0.59000000", "504.13000000", "4.13000000", "exchange_loss"],
      // 300 ÷ 854,4637 = 0,3510… → 0,35 USD = 299,06 Bs: ganancia de 0,94.
      ["300.00000000", "0.35000000", "299.06000000", "-0.94000000", "exchange_gain"],
      // 200 ÷ 854,4637 = 0,2340… → 0,23 USD = 196,53 Bs: ganancia de 3,47.
      ["200.00000000", "0.23000000", "196.53000000", "-3.47000000", "exchange_gain"],
      // EL QUE CIERRA: 438,40 ÷ 854,4637 = 0,5130… → 0,51 USD = 435,78 Bs. Lo funcional es lo
      // que se debía y no hay línea de diferencial (el redondeo queda a la revaluación: P-100).
      ["438.40000000", "0.51000000", "438.40000000", "0.00000000", null],
    ] as const;
    for (const [i, [cancela, sale, funcional, dif, papel]] of pasos.entries()) {
      const ultimo = i === pasos.length - 1;
      const r = await pago({
        supplier_invoice_id: f,
        gross_amount: cancela,
        currency: "VES",
        instrument: "zelle",
        account_id: BANCO_USD,
      });
      expect(r.status, await r.clone().text()).toBe(201);
      const p = (await r.json()) as { payment: { id: string }; invoice_status: string };
      expect(p.invoice_status).toBe(ultimo ? "paid" : "posted");
      expect({ ...(await filaDe(p.payment.id)) }).toEqual({
        moneda: "USD",
        salio: sale,
        saldado: cancela,
        moneda_saldada: "VES",
        funcional,
        dif,
      });
      const lineas = await asiento("payment_made", p.payment.id);
      const importe = dif.replace("-", "");
      expect(lineas.map((l) => [l.papel, l.debe, l.haber])).toEqual(
        papel === null
          ? [
              ["ap_general", cancela, "0.00000000"],
              [null, "0.00000000", funcional],
            ]
          : papel === "exchange_loss"
            ? [
                ["ap_general", cancela, "0.00000000"],
                [null, "0.00000000", funcional],
                ["exchange_loss", importe, "0.00000000"],
              ]
            : [
                ["ap_general", cancela, "0.00000000"],
                [null, "0.00000000", funcional],
                ["exchange_gain", "0.00000000", importe],
              ],
      );
    }
    expect(await abierto("ap", f)).toBe("0.00000000");
    expect((await saldoDe(f)).saldo).toBe("0.00000000");
    expect(await estadoDe(f)).toBe("paid");
    // Lo que salió de la caja en USD: 0,59 + 0,35 + 0,23 + 0,51, el dinero real, intacto.
    const [caja] = await sql<{ salio: string; de_la_factura: string }[]>`
      select (coalesce(sum(net_amount), 0) - ${antesCaja!.s}::numeric)::numeric(24,8)::text as salio,
             (sum(net_amount) filter (where supplier_invoice_id = ${f}))::numeric(24,8)::text
               as de_la_factura
        from public.supplier_payments where account_id = ${BANCO_USD}`;
    expect({ ...caja }).toEqual({ salio: "1.68000000", de_la_factura: "1.68000000" });
    await invariantes();
  });

  it("e · el tope NO se abre: un dólar de más se rechaza y no se escribe nada; un dólar de menos es un abono y la factura sigue debiendo", async () => {
    await tasa(TASA_REAL);
    const f = await factura("TR-5", "VES", "124");
    const debe = await saldoDe(f);
    // La factura debe 1.438,40 Bs: a 854,4637 son 1,6833… → 1,68 USD (1.435,50 Bs; el redondeo
    // de caja son 2,90 Bs, dentro de la tolerancia de 4,27). Las entradas son fijas, y los dos
    // importes caen SIEMPRE fuera de la tolerancia: se comprueba, no se supone.
    expect(debe).toEqual({ saldo: "1438.40000000", enUsd: "1.68000000" });
    const fuera = [
      // Un dólar de más: 2,68 USD = 2.289,96 Bs.
      ["2.68000000", "El pago (2289.96 VES) supera el saldo pendiente de la factura (1438.4)."],
      // Un céntimo de dólar de más que el redondeo: 1,69 USD = 1.444,04 Bs, 5,64 Bs por encima.
      ["1.69000000", "El pago (1444.04 VES) supera el saldo pendiente de la factura (1438.4)."],
    ] as const;
    for (const [importe, mensaje] of fuera) {
      const [tol] = await sql<{ fuera: boolean }[]>`
        select ${importe}::numeric * ${TASA_REAL}::numeric - ${debe.saldo}::numeric
               > 0.005 * ${TASA_REAL}::numeric as fuera`;
      expect(tol!.fuera).toBe(true);
      const malo = await rechazado("/v1/supplier-payments", {
        ...SOBREGIRO,
        supplier_invoice_id: f,
        gross_amount: importe,
        currency: "USD",
        instrument: "zelle",
        account_id: BANCO_USD,
      });
      expect([malo.status, malo.code, malo.message]).toEqual([422, "VALIDATION_FAILED", mensaje]);
      const [n] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.supplier_payments where supplier_invoice_id = ${f}`;
      expect(n!.n).toBe(0);
    }
    expect(await estadoDe(f)).toBe("posted");
    const menos = await pago({
      supplier_invoice_id: f,
      gross_amount: "0.68000000",
      currency: "USD",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(menos.status, await menos.clone().text()).toBe(201);
    expect(((await menos.json()) as { invoice_status: string }).invoice_status).toBe("posted");
    expect(Number((await saldoDe(f)).saldo)).toBeGreaterThan(800);
    await invariantes();
  });

  it("ventas, el espejo (solo comprobación: el dominio de ventas no se tocó): una factura en Bs cobrada ENTERA en USD a 854,4637 queda pagada, con su cuenta por cobrar en cero y sin diferencial", async () => {
    await tasa(TASA_REAL);
    const doc = await facturar("1", LISTA_BS); // 1.000 + 160 = 1.160,00 Bs
    expect(doc["transaction_currency"]).toBe("VES");
    // 1.160 / 854,4637 = 1,3576… → 1,36 USD, que a la tasa son 1.162,07 Bs: no cae exacto.
    const cobro = await cobrar(doc["id"]!, {
      currency: "USD",
      amount: "1.36000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(cobro.document_status).toBe("paid");
    expect(cobro.exchange_difference).toBeNull();
    expect(cobro.payment["amount"]).toBe("1.36000000");
    const [d] = await sql<{ saldo: string; funcional: string }[]>`
      select platform.document_balance(${COMPANY}, ${doc["id"]!})::text as saldo,
             (select p.functional_amount::text from public.payments p
               where p.id = ${cobro.payment["id"]!}) as funcional`;
    // Lo funcional del cobro es lo pendiente (1.160,00), no «1,36 × 854,4637».
    expect(d).toEqual({ saldo: "0.00000000", funcional: "1160.00000000" });
    expect(await abierto("ar", doc["id"]!)).toBe("0.00000000");
    await invariantes();
  });

  it("e2 · la tolerancia de caja NO tapa un descuadre con el mayor, en NINGÚN sentido: con la cuenta por pagar cargada de más o de MENOS —un dólar (854,46 Bs), o solo 3,00 Bs, menos que el redondeo de caja— el pago cruzado que cerraría responde 409 SETTLEMENT_MISMATCH con su mensaje y no escribe nada", async () => {
    await tasa(TASA_REAL);
    /**
     * Un asiento posteado, atribuido a la factura, que mueve `importe` en cuentas por pagar:
     * `mas` la ABONA (el mayor carga de más); `menos` la DEBITA (un débito ajeno: carga de menos).
     */
    const asientoAjenoAp = async (
      sourceId: string,
      importe: string,
      sentido: "mas" | "menos",
    ): Promise<void> => {
      await sql.begin(async (tx) => {
        await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
        const cuentas = await tx<{ purpose: string; account_id: string }[]>`
          select purpose, account_id from public.company_account_settings
           where company_id = ${COMPANY} and purpose in ('ap_general', 'exchange_gain')`;
        const de = (p: string): string => cuentas.find((c) => c.purpose === p)!.account_id;
        const [e] = await tx<{ id: string }[]>`
          insert into public.journal_entries
            (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
             description, rules_version)
          values (${TENANT}, ${COMPANY},
                  platform.period_for_date(${COMPANY}, platform.caracas_day(now())),
                  platform.caracas_day(now()), 'exchange_diff', ${sourceId}, 'e2e.asiento_ajeno',
                  'E2E tasa real: un asiento ajeno atribuido a la factura', 'e2e-moneda-x')
          returning id`;
        const [alDebe, alHaber] =
          sentido === "mas"
            ? [de("exchange_gain"), de("ap_general")]
            : [de("ap_general"), de("exchange_gain")];
        const filas = [
          { n: 1, cuenta: alDebe, debe: importe, haber: "0" },
          { n: 2, cuenta: alHaber, debe: "0", haber: importe },
        ];
        for (const f of filas) {
          await tx`
            insert into public.journal_lines
              (tenant_id, company_id, entry_id, line_number, account_id, debit_amount,
               credit_amount, amount_transaction_currency, transaction_currency, fx_rate,
               functional_amount, functional_currency, rate_source, rate_timestamp,
               functional_debit, functional_credit)
            values (${TENANT}, ${COMPANY}, ${e!.id}, ${f.n}, ${f.cuenta}, ${f.debe}, ${f.haber},
                    ${importe}, 'VES', 1, ${importe}, 'VES', 'identidad', now(), ${f.debe},
                    ${f.haber})`;
        }
        await tx`
          update public.journal_entries
             set status = 'posted', posted_at = now(), posted_by = ${DUENO},
                 entry_number = platform.claim_entry_number(
                   ${COMPANY}, extract(year from platform.caracas_day(now()))::int)
           where id = ${e!.id}`;
      });
    };
    for (const [numero, descuadre, sentido] of [
      ["TR-6", "854.46", "mas"],
      ["TR-7", "3.00", "mas"],
      // El sentido contrario: un débito ajeno deja la cuenta por pagar cargada de MENOS.
      ["TR-9", "854.46", "menos"],
      ["TR-10", "3.00", "menos"],
    ] as const) {
      const f = await factura(numero, "VES", "124");
      const debe = await saldoDe(f);
      await asientoAjenoAp(f, descuadre, sentido);
      // El descuadre está de verdad en el mayor, con su signo.
      expect(await abierto("ap", f)).toBe(
        {
          mas: { "854.46": "2292.86000000", "3.00": "1441.40000000" },
          menos: { "854.46": "583.94000000", "3.00": "1435.40000000" },
        }[sentido][descuadre],
      );
      // Por los dos caminos: lo que se cancela (en Bs) y el dinero que sale (en USD).
      for (const cuerpo of [
        { gross_amount: debe.saldo, currency: "VES" },
        { gross_amount: debe.enUsd, currency: "USD" },
      ]) {
        const malo = await rechazado("/v1/supplier-payments", {
          ...SOBREGIRO,
          supplier_invoice_id: f,
          instrument: "zelle",
          account_id: BANCO_USD,
          ...cuerpo,
        });
        expect([malo.status, malo.code, malo.message]).toEqual([
          409,
          "SETTLEMENT_MISMATCH",
          "Este pago no cuadra con lo que la factura todavía debe. No se registró: revisa la factura.",
        ]);
      }
      const [n] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.supplier_payments where supplier_invoice_id = ${f}`;
      expect(n!.n).toBe(0);
      expect(await estadoDe(f)).toBe("posted");
    }
    // Cuatro facturas con su asiento ajeno y ocho pagos rechazados: no caben en los 5 s por omisión.
  }, 30_000);
});

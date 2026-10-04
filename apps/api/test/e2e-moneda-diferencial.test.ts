import { describe, expect, it, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";
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
const TENANT = crypto.randomUUID();
const COMPANY = crypto.randomUUID();
const W1 = crypto.randomUUID();
const DUENO = crypto.randomUUID();
const CLIENTE = crypto.randomUUID();
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

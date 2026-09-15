import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * LA CUENTA DE EFECTIVO SALE DE LA CAJA REAL (ADR-0060 §4, migración 56).
 *
 * Cuatro caminos asentaban siempre en «Caja y bancos en bolívares» aunque el
 * dinero entrara o saliera de una cuenta en dólares: el cobro, el pago a
 * proveedor, el gasto y el cierre de caja (el quinto, la percepción de IGTF,
 * se prueba en e2e-igtf). Para que la aserción diga «ESA caja» y no solo «la
 * de dólares», la cuenta de tesorería de estas pruebas está mapeada a una
 * cuenta contable PROPIA (1.1.90 «Banco USD Mercantil»), distinta de las dos
 * del plan: si el asiento cayera en cash_bs o en cash_usd, falla.
 *
 * Variante rota: una caja a la que se le quita el mapeo. El gasto no se asienta
 * en otra cuenta: va a la cola con `treasury_account_unmapped`; al volver a
 * mapearla, «contabilizar pendientes» lo asienta en ella.
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
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const AYER = diaCaracas(-1);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let SERVICIO = "";
let HARINA = "";
let MAYOR_BANCO = "";
let BANCO_USD = "";
let CAJA_USD = "";
let CASH_BS = "";
let CASH_USD = "";

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
    Authorization: `Bearer ${await tokenDe(DUENO)}`,
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

/** Las líneas del asiento de un hecho: cuenta y lado. */
async function lineasDe(
  sourceKind: string,
  sourceId: string,
): Promise<{ account_id: string; lado: "debe" | "haber" }[]> {
  return sql<{ account_id: string; lado: "debe" | "haber" }[]>`
    select l.account_id,
           case when l.debit_amount > 0 then 'debe' else 'haber' end as lado
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
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e caja real')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-CAJA-${RUN}`}, 'Bodega caja real', 'VES',
                     'ordinario')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-CRW1', 'Local')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2ecaja_${RUN}`}, 'Dueño', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.payment.register'),
             (${ROL}, 'ar.read'), (${ROL}, 'supplier.manage'),
             (${ROL}, 'purchase.invoice.register'), (${ROL}, 'purchase.payment.register'),
             (${ROL}, 'ap.read'), (${ROL}, 'expense.register'), (${ROL}, 'expense.read'),
             (${ROL}, 'cash.close'), (${ROL}, 'treasury.read'),
             (${ROL}, 'treasury.account.manage'), (${ROL}, 'inventory.move'),
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.entry.post'), (${ROL}, 'accounting.read')
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
             values (${TENANT}, ${COMPANY}, 'sin_facturacion', now() - interval '10 days')`;
    await tx`insert into public.customers (id, tenant_id, company_id, legal_name,
                                           person_type_code, taxpayer_type_code)
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, 'Vecino Pedro', 'natural',
                     'consumidor_final')`;
    await tx`insert into public.suppliers
               (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code,
                taxpayer_type_code)
             values (${PROVEEDOR}, ${TENANT}, ${COMPANY}, ${`J-PRV-CR-${RUN}`},
                     'Distribuidora caja real', 'nacional', 'juridica', 'ordinario')`;
    const [s] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`CR-SERV-${RUN}`}, 'Servicio de entrega', 'service',
              'active', 'unidad', 'gravado_general') returning id`;
    SERVICIO = s!.id;
    const [h] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`CR-HAR-${RUN}`}, 'Harina', 'good', 'active', 'unidad',
              'gravado_general') returning id`;
    HARINA = h!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, 'detal', 'USD') returning id`;
    await tx`insert into public.company_settings (company_id, tenant_id, default_price_list_id)
             values (${COMPANY}, ${TENANT}, ${l!.id})`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${l!.id}, ${SERVICIO}, 20, now() - interval '1 day')`;
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), 'e2e-caja-real'
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = ${HOY}::date)`;
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
    await tx`
      insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                                    rate, effective_from, legal_source, priority, transaction_type)
      select 'VE', 'iva', 'ordinario', 'gravado_general', 0.16, ${AYER}::date,
             'Carga de prueba E2E — VALIDAR-SENIAT antes de producción.', 10, 'purchase'
       where not exists (select 1 from public.tax_rules
                          where company_id is null and jurisdiction = 'VE' and tax_code = 'iva'
                            and taxpayer_type = 'ordinario'
                            and product_tax_category = 'gravado_general'
                            and transaction_type = 'purchase')`;
  });
  for (const [ruta, cuerpo] of [
    ["/v1/accounts/import-template", { company_id: COMPANY, template_code: "ve_basico" }],
    ["/v1/journal-templates/import-preset", { company_id: COMPANY, preset_code: "ve_basico" }],
  ] as const) {
    expect((await pedir("POST", ruta, cuerpo)).status).toBe(201);
  }
  const papeles = await sql<{ purpose: string; account_id: string }[]>`
    select purpose, account_id from public.company_account_settings
     where company_id = ${COMPANY} and purpose in ('cash_bs', 'cash_usd') and effective_to is null`;
  CASH_BS = papeles.find((p) => p.purpose === "cash_bs")!.account_id;
  CASH_USD = papeles.find((p) => p.purpose === "cash_usd")!.account_id;

  // Una cuenta contable PROPIA para el banco en dólares, hija de «Activo circulante».
  const [padre] = await sql<{ id: string }[]>`
    select id from public.accounts where company_id = ${COMPANY} and code = '1.1'`;
  const cuenta = await pedir("POST", "/v1/accounts", {
    company_id: COMPANY,
    code: "1.1.90",
    name: "Banco USD Mercantil",
    parent_id: padre!.id,
    kind: "activo",
  });
  expect(cuenta.status).toBe(201);
  MAYOR_BANCO = ((await cuenta.json()) as { id: string }).id;
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("la cuenta de efectivo sale de la caja real del movimiento", () => {
  it("toda caja nace mapeada: una en dólares, a cash_usd; un mapeo explícito se respeta", async () => {
    const caja = await pedir("POST", "/v1/treasury/accounts", {
      company_id: COMPANY,
      name: `Caja USD ${RUN}`,
      currency: "USD",
      kind: "cash",
    });
    expect(caja.status).toBe(201);
    const c = (await caja.json()) as { id: string; ledger_account_id: string | null };
    CAJA_USD = c.id;
    expect(c.ledger_account_id).toBe(CASH_USD);

    const banco = await pedir("POST", "/v1/treasury/accounts", {
      company_id: COMPANY,
      name: `Mercantil USD ${RUN}`,
      currency: "USD",
      kind: "bank",
      ledger_account_id: MAYOR_BANCO,
    });
    expect(banco.status).toBe(201);
    const b = (await banco.json()) as { id: string; ledger_account_id: string | null };
    BANCO_USD = b.id;
    expect(b.ledger_account_id).toBe(MAYOR_BANCO);
  });

  it("COBRO · un cobro en USD al banco en USD debita la cuenta contable de ESE banco", async () => {
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: SERVICIO, quantity: "1" }],
    });
    expect(venta.status).toBe(201);
    const recibo = ((await venta.json()) as { document: { id: string } }).document.id;
    const cobro = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: recibo,
      currency: "USD",
      amount: "5.00000000",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(cobro.status).toBe(201);
    const pago = ((await cobro.json()) as { payment: { id: string } }).payment.id;

    const lineas = await lineasDe("payment_received", pago);
    expect(lineas.filter((l) => l.lado === "debe").map((l) => l.account_id)).toEqual([MAYOR_BANCO]);
    expect(lineas.map((l) => l.account_id)).not.toContain(CASH_BS);
    expect(lineas.map((l) => l.account_id)).not.toContain(CASH_USD);
  });

  it("PAGO A PROVEEDOR · pagar en USD desde el banco en USD acredita la cuenta de ESE banco", async () => {
    const factura = await pedir("POST", "/v1/supplier-invoices", {
      company_id: COMPANY,
      supplier_id: PROVEEDOR,
      supplier_document_number: `FAC-CR-${RUN}`,
      supplier_control_number: "00-0000077",
      invoice_date: HOY,
      currency: "USD",
      lines: [{ product_id: HARINA, quantity: "2", unit_price: "10" }],
    });
    expect(factura.status).toBe(201);
    const inv = (await factura.json()) as { id: string };
    const [total] = await sql<{ total: string }[]>`
      select total_amount::text as total from public.supplier_invoices where id = ${inv.id}`;

    const pago = await pedir("POST", "/v1/supplier-payments", {
      company_id: COMPANY,
      supplier_invoice_id: inv.id,
      gross_amount: total!.total,
      currency: "USD",
      instrument: "zelle",
      account_id: BANCO_USD,
    });
    expect(pago.status).toBe(201);
    const p = ((await pago.json()) as { payment: { id: string } }).payment.id;

    const lineas = await lineasDe("payment_made", p);
    expect(lineas.filter((l) => l.lado === "haber").map((l) => l.account_id)).toContain(
      MAYOR_BANCO,
    );
    expect(lineas.map((l) => l.account_id)).not.toContain(CASH_BS);
    expect(lineas.map((l) => l.account_id)).not.toContain(CASH_USD);
  });

  it("GASTO · un gasto pagado desde el banco en USD acredita la cuenta de ESE banco", async () => {
    const r = await pedir("POST", "/v1/expenses", {
      company_id: COMPANY,
      category: "Publicidad",
      account_id: BANCO_USD,
      amount: "3.00000000",
    });
    expect(r.status).toBe(201);
    const g = (await r.json()) as { id: string; accounting: string };
    expect(g.accounting).toBe("posted");

    const lineas = await lineasDe("expense", g.id);
    expect(lineas.filter((l) => l.lado === "haber").map((l) => l.account_id)).toEqual([
      MAYOR_BANCO,
    ]);
    expect(lineas.map((l) => l.account_id)).not.toContain(CASH_BS);
  });

  it("CIERRE · la diferencia del cierre del banco en USD cae en la cuenta de ESE banco", async () => {
    const r = await pedir("POST", "/v1/cash-closings", {
      company_id: COMPANY,
      account_id: BANCO_USD,
      counted_amount: "0.00000000",
      reason: "conciliación e2e: se cuenta cero para forzar la diferencia",
    });
    expect(r.status).toBe(201);
    const c = (await r.json()) as { id: string; accounting: string; difference: string };
    expect(c.accounting).toBe("posted");

    const lineas = await lineasDe("cash_closing", c.id);
    expect(lineas.map((l) => l.account_id)).toContain(MAYOR_BANCO);
    expect(lineas.map((l) => l.account_id)).not.toContain(CASH_BS);
    expect(lineas.map((l) => l.account_id)).not.toContain(CASH_USD);
  });

  it("VARIANTE ROTA · sin mapeo, el gasto NO cae en cash_bs: va a la cola diciendo qué caja, y se recupera", async () => {
    const quitar = await pedir("PATCH", `/v1/treasury/accounts/${CAJA_USD}`, {
      company_id: COMPANY,
      ledger_account_id: null,
    });
    expect(quitar.status).toBe(200);

    const r = await pedir("POST", "/v1/expenses", {
      company_id: COMPANY,
      category: "Transporte",
      account_id: CAJA_USD,
      amount: "2.00000000",
    });
    expect(r.status).toBe(201);
    const g = (await r.json()) as { id: string; accounting: string };
    expect(g.accounting).toBe("queued");
    expect(await lineasDe("expense", g.id)).toEqual([]);
    const [cola] = await sql<{ reason: string }[]>`
      select reason from public.journal_generation_queue
       where company_id = ${COMPANY} and source_id = ${g.id} and status = 'pending'`;
    expect(cola!.reason.startsWith("treasury_account_unmapped")).toBe(true);
    expect(cola!.reason).toContain(`Caja USD ${RUN}`);

    // Se vuelve a mapear y «contabilizar pendientes» lo asienta en ESA caja.
    const poner = await pedir("PATCH", `/v1/treasury/accounts/${CAJA_USD}`, {
      company_id: COMPANY,
      ledger_account_id: CASH_USD,
    });
    expect(poner.status).toBe(200);
    const proceso = await pedir("POST", "/v1/accounting/pending/process", {});
    expect(proceso.status).toBe(200);
    const lineas = await lineasDe("expense", g.id);
    expect(lineas.filter((l) => l.lado === "haber").map((l) => l.account_id)).toEqual([CASH_USD]);
  });

  it("y el invariante de cobertura sigue en cero", async () => {
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.accounting_coverage_gaps(${COMPANY})`;
    expect(n!.n).toBe(0);
  });
});

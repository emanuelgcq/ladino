import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * OLA 0 (plan «Ladino sin RIF», 2026-09-14): dos afirmaciones del plan que
 * estaban marcadas «no verificado» y podían ser bugs vivos en producción. Se
 * prueban EJECUTANDO el sistema, no leyendo el código.
 *
 *   V1 · B3 — la venta de un producto CON LOTE: ¿descuenta del lote que tiene
 *        la existencia, o del lote nulo (y entonces falla con NEGATIVE_STOCK)?
 *   V2 · B6 — un cobro en USD que entra a una cuenta de efectivo en USD: ¿a qué
 *        cuenta contable va el débito del asiento?
 *
 * Cada caso asevera el comportamiento CORRECTO. Si el sistema no lo cumple, el
 * caso queda como `it.fails` —un bug vivo documentado que la suite vigila— y
 * se invierte a `it` en la ola que lo arregle (Ola 2, ADR-1).
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
const RUN = Date.now().toString(36);
const HOY = diaCaracas();

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let QUESO = "";
let SERVICIO = "";
let LOTE = "";

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

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e ola 0')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code)
             values (${COMPANY}, ${TENANT}, ${`PEND-O0-${RUN}`}, 'Bodega Ola 0', 'VES')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-O0W1', 'Local')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2eola0_dueno_${RUN}`}, 'Dueño', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'),
             (${ROL}, 'sales.payment.register'),
             (${ROL}, 'inventory.move'),
             (${ROL}, 'ar.read'),
             (${ROL}, 'treasury.read'),
             (${ROL}, 'treasury.account.manage'),
             (${ROL}, 'accounting.account.manage'),
             (${ROL}, 'accounting.template.manage')`;
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
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, 'Vecina Carmen', 'natural',
                     'consumidor_final')`;
    const [q] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code, tracks_lots, tracks_expiry)
      values (${TENANT}, ${COMPANY}, ${`O0-QUESO-${RUN}`}, 'Queso con lote', 'good', 'active',
              'unidad', 'gravado_general', true, true) returning id`;
    QUESO = q!.id;
    const [s] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`O0-SERV-${RUN}`}, 'Servicio', 'service', 'active',
              'unidad', 'gravado_general') returning id`;
    SERVICIO = s!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, 'detal', 'VES') returning id`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${l!.id}, ${QUESO}, 50, now() - interval '1 day'),
                    (${TENANT}, ${COMPANY}, ${l!.id}, ${SERVICIO}, 400, now() - interval '1 day')`;
    const [lote] = await tx<{ id: string }[]>`
      insert into public.lots (tenant_id, company_id, product_id, code, expires_at)
      values (${TENANT}, ${COMPANY}, ${QUESO}, ${`O0-L1-${RUN}`}, current_date + 30)
      returning id`;
    LOTE = lote!.id;
    // La tasa USD→VES del día, GLOBAL y compartida con otros E2E: este fichero
    // no asevera cifras funcionales contra un número fijo.
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), 'e2e-ola0'
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = ${HOY}::date)`;
  });
  for (const [ruta, cuerpo] of [
    ["/v1/accounts/import-template", { company_id: COMPANY, template_code: "ve_basico" }],
    ["/v1/journal-templates/import-preset", { company_id: COMPANY, preset_code: "ve_basico" }],
  ] as const) {
    expect((await pedir("POST", ruta, cuerpo)).status).toBe(201);
  }
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("Ola 0 · verificaciones ejecutadas", () => {
  // V1 — BUG confirmado al ejecutarlo (2026-09-14): la venta descontaba del lote
  // nulo y el producto con lote no se podía vender. CERRADO en la Ola 2
  // (ADR-0060 §3, migración 57: reparto FEFO): pasó de `it.fails` a `it` sin
  // cambiar su aserción.
  it("V1 · un producto con lote y existencia en ese lote se vende (descuenta del lote)", async () => {
    const entrada = await pedir("POST", "/v1/inventory/receipts", {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: QUESO,
      lot_id: LOTE,
      quantity: "5",
      amount: "150",
      currency: "VES",
    });
    expect(entrada.status).toBe(201);

    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: QUESO, quantity: "1" }],
      payments: [{ instrument: "efectivo_bs", amount: "50.00000000", currency: "VES" }],
    });
    expect(venta.status).toBe(201);
    const [pos] = await sql<{ quantity: string }[]>`
        select quantity::text as quantity from public.stock_balances
         where company_id = ${COMPANY} and product_id = ${QUESO} and lot_id = ${LOTE}`;
    expect(pos!.quantity).toBe("4.00000000");
  });

  // V2 — BUG confirmado al ejecutarlo (2026-09-14): el asiento del cobro debitaba
  // la cuenta de efectivo en BOLÍVARES aunque el dinero entró en dólares a una
  // caja en dólares. CERRADO en la Ola 2 (ADR-0060 §4, migración 56): pasó de
  // `it.fails` a `it` sin cambiar su aserción.
  it("V2 · un cobro en USD a una caja en USD debita la cuenta contable de efectivo en USD", async () => {
    const caja = await pedir("POST", "/v1/treasury/accounts", {
      company_id: COMPANY,
      name: `Caja USD ${RUN}`,
      currency: "USD",
      kind: "cash",
    });
    expect(caja.status).toBe(201);
    const CAJA_USD = ((await caja.json()) as { id: string }).id;

    // Fiado a la vecina: el recibo nace con saldo y se cobra después en USD.
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
      amount: "1.00000000",
      instrument: "efectivo_usd",
      account_id: CAJA_USD,
    });
    expect(cobro.status).toBe(201);
    const pagoId = ((await cobro.json()) as { payment: { id: string } }).payment.id;

    const debitos = await sql<{ purpose: string }[]>`
        select s.purpose
          from public.journal_entries e
          join public.journal_lines l on l.entry_id = e.id
          join public.company_account_settings s
            on s.company_id = e.company_id and s.account_id = l.account_id
         where e.company_id = ${COMPANY} and e.source_kind = 'payment_received'
           and e.source_id = ${pagoId} and l.debit_amount > 0`;
    expect(debitos.map((d) => d.purpose)).toContain("cash_usd");
    expect(debitos.map((d) => d.purpose)).not.toContain("cash_bs");
  });
});

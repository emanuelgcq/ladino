import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * LA VENTA CON LOTES REPARTE POR FEFO (ADR-0060 §3, migración 57).
 *
 *   · una venta que no cabe en un lote se reparte entre varios, primero el que
 *     vence antes, y CADA lote sale a SU costo: el valor que deja el kardex es
 *     la suma de los costos de los lotes tocados, no un promedio inventado;
 *   · VARIANTE ROTA: si lo único que hay está vencido, no hay reparto posible y
 *     vuelve el 409 de V1 — ahora con el mensaje que dice por qué, y sin tocar
 *     la existencia.
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
let YOGUR = "";
let PRONTO = "";
let LEJOS = "";
let VENCIDO = "";

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

async function existencia(lote: string): Promise<{ quantity: string; value: string }> {
  const [b] = await sql<{ quantity: string; value: string }[]>`
    select quantity::text as quantity, value::text as value from public.stock_balances
     where company_id = ${COMPANY} and warehouse_id = ${W1} and lot_id = ${lote}`;
  return b ?? { quantity: "0", value: "0" };
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e lotes')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code)
             values (${COMPANY}, ${TENANT}, ${`PEND-LOT-${RUN}`}, 'Quesera e2e', 'VES')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-LTW1', 'Local')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2elotes_${RUN}`}, 'Dueño', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.payment.register'),
             (${ROL}, 'inventory.move'), (${ROL}, 'ar.read')`;
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
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, 'Vecina Rosa', 'natural',
                     'consumidor_final')`;
    const [q] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code, tracks_lots, tracks_expiry)
      values (${TENANT}, ${COMPANY}, ${`LT-QUESO-${RUN}`}, 'Queso llanero', 'good', 'active',
              'unidad', 'gravado_general', true, true) returning id`;
    QUESO = q!.id;
    const [y] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code, tracks_lots, tracks_expiry)
      values (${TENANT}, ${COMPANY}, ${`LT-YOGUR-${RUN}`}, 'Yogur', 'good', 'active',
              'unidad', 'gravado_general', true, true) returning id`;
    YOGUR = y!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, 'detal', 'VES') returning id`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${l!.id}, ${QUESO}, 100, now() - interval '1 day'),
                    (${TENANT}, ${COMPANY}, ${l!.id}, ${YOGUR}, 30, now() - interval '1 day')`;
    const lotes = await tx<{ id: string; code: string }[]>`
      insert into public.lots (tenant_id, company_id, product_id, code, expires_at) values
        (${TENANT}, ${COMPANY}, ${QUESO}, ${`PRONTO-${RUN}`}, current_date + 5),
        (${TENANT}, ${COMPANY}, ${QUESO}, ${`LEJOS-${RUN}`}, current_date + 60),
        (${TENANT}, ${COMPANY}, ${YOGUR}, ${`VENCIDO-${RUN}`}, current_date - 3)
      returning id, code`;
    PRONTO = lotes.find((x) => x.code.startsWith("PRONTO"))!.id;
    LEJOS = lotes.find((x) => x.code.startsWith("LEJOS"))!.id;
    VENCIDO = lotes.find((x) => x.code.startsWith("VENCIDO"))!.id;
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), 'e2e-lotes'
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = ${HOY}::date)`;
  });
  // Existencia por la API: 3 quesos a 30 en el lote que vence pronto, 5 a 50
  // en el lejano, y 4 yogures en un lote ya vencido (entrar sí se puede).
  for (const [producto, lote, cantidad, total] of [
    [QUESO, PRONTO, "3", "90"],
    [QUESO, LEJOS, "5", "250"],
    [YOGUR, VENCIDO, "4", "40"],
  ] as const) {
    const r = await pedir("POST", "/v1/inventory/receipts", {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: producto,
      lot_id: lote,
      quantity: cantidad,
      amount: total,
      currency: "VES",
    });
    expect(r.status).toBe(201);
  }
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("venta con lotes: FEFO en el servidor", () => {
  it("vender 4 quesos reparte 3 del lote que vence antes y 1 del lejano, cada uno a su costo", async () => {
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: QUESO, quantity: "4" }],
      payments: [{ instrument: "efectivo_bs", amount: "400.00000000", currency: "VES" }],
    });
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;

    expect((await existencia(PRONTO)).quantity).toBe("0.00000000");
    expect((await existencia(LEJOS)).quantity).toBe("4.00000000");

    const salidas = await sql<{ lot_id: string; quantity: string; costo: string }[]>`
      select lot_id, quantity::text as quantity, (-functional_amount)::text as costo
        from public.inventory_moves
       where company_id = ${COMPANY} and source_document_id = ${doc} and kind = 'salida'
       order by inventory_moves.quantity`;
    expect(salidas).toEqual([
      { lot_id: PRONTO, quantity: "-3.00000000", costo: "90.00000000" },
      { lot_id: LEJOS, quantity: "-1.00000000", costo: "50.00000000" },
    ]);
  });

  it("VARIANTE ROTA · con solo existencia vencida no hay reparto: vuelve el 409 de V1, con su porqué, y nada se mueve", async () => {
    const antes = await existencia(VENCIDO);
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: YOGUR, quantity: "1" }],
      payments: [{ instrument: "efectivo_bs", amount: "30.00000000", currency: "VES" }],
    });
    expect(venta.status).toBe(409);
    const cuerpo = (await venta.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("NEGATIVE_STOCK");
    expect(cuerpo.message).toContain("lotes vigentes");
    expect(cuerpo.message).toContain("Yogur");
    expect(await existencia(VENCIDO)).toEqual(antes);
  });
});

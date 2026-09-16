import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * EL CÉNTIMO DE LA CAJA (ADR-0063). Cinco cosas que el QA de pantalla del 2026-09-15 encontró
 * y que se prueban aquí contra la API real:
 *
 *   §1 — lo que la caja anuncia es lo que el recibo dice (h. 19, 57);
 *   §2 — el cobro que cierra se guarda en céntimos de su moneda y deja el documento en CERO,
 *        no en «Saldo Bs. 0,0000758» (h. 17, 28, 56);
 *   §2 — el vuelto de 5 dólares sobre 2,80 es 2,20, no 2,19 (h. 16);
 *   §3 — cobrar a la MISMA tasa no escribe un diferencial de 0,00000302 (h. 18, 29);
 *   §4 — la deuda de una factura sin cobros es su total, no seis decimales más abajo (h. 56).
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
/** La tasa del QA: la que destapaba los decimales sueltos. */
const TASA = "842.20670000";

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let REFRESCO = "";
let DELIVERY = "";
let LISTA_USD = "";

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
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e céntimo')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-CEN-${RUN}`}, 'Bodega del céntimo', 'VES',
                     'ordinario')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-CENW1', 'Local')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2ecentimo_${RUN}`}, 'Dueño', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.payment.register'),
             (${ROL}, 'ar.read'), (${ROL}, 'treasury.read'),
             (${ROL}, 'treasury.account.manage'), (${ROL}, 'inventory.move'),
             (${ROL}, 'accounting.read')
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
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, 'Vecino Luis', 'natural',
                     'consumidor_final')`;
    // Los dos productos del QA: 2 refrescos a 2,80 y un delivery de 1,00.
    const [r] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`CEN-REF-${RUN}`}, 'Refresco', 'service', 'active',
              'unidad', 'gravado_general') returning id`;
    REFRESCO = r!.id;
    const [d] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`CEN-DEL-${RUN}`}, 'Delivery', 'service', 'active',
              'unidad', 'gravado_general') returning id`;
    DELIVERY = d!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, 'detal', 'USD') returning id`;
    LISTA_USD = l!.id;
    await tx`insert into public.company_settings (company_id, tenant_id, default_price_list_id)
             values (${COMPANY}, ${TENANT}, ${LISTA_USD})`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${LISTA_USD}, ${REFRESCO}, 2.80,
                     now() - interval '1 day'),
                    (${TENANT}, ${COMPANY}, ${LISTA_USD}, ${DELIVERY}, 1.00,
                     now() - interval '1 day')`;
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', ${TASA}::numeric, ${HOY}::date, now(), 'e2e-centimo'
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = ${HOY}::date)`;
  });
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("el céntimo de la caja: lo que se anuncia, lo que se guarda y lo que queda debiéndose", () => {
  it("§1 · el total que anuncia la caja es EXACTAMENTE el del recibo emitido", async () => {
    const lineas = [
      { product_id: REFRESCO, quantity: "2" },
      { product_id: DELIVERY, quantity: "1" },
    ];
    const cotiza = await pedir("POST", "/v1/pos/quote", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      lines: lineas,
    });
    expect(cotiza.status).toBe(200);
    const q = (await cotiza.json()) as { functional_total: string; total: string };

    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: lineas,
    });
    expect(venta.status).toBe(201);
    const v = (await venta.json()) as { document: { total_amount: string } };
    // Antes: la caja decía Bs 5.558,56 y el recibo guardaba 5.558,57.
    expect(v.document.total_amount).toBe(q.functional_total);
  });

  it("§2 · el vuelto de 5 dólares sobre una cuenta de 2,80 es 2,20", async () => {
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: REFRESCO, quantity: "1" }],
      payments: [{ instrument: "efectivo_usd", currency: "USD", amount: "5.00" }],
    });
    expect(venta.status).toBe(201);
    const v = (await venta.json()) as {
      change: { amount: string; currency: string } | null;
      payments: { payment: { amount: string; currency: string } }[];
      document: { status: string };
    };
    expect(v.change?.currency).toBe("USD");
    expect(v.change?.amount.slice(0, 4)).toBe("2.20");
    // Y lo que entró en la caja son céntimos de verdad, no 2,80000147.
    expect(v.payments[0]!.payment.amount.slice(0, 4)).toBe("2.80");
    expect(v.document.status).toBe("paid");
  });

  it("§2 · un recibo cobrado completo queda en CERO, sin polvo en el saldo", async () => {
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: REFRESCO, quantity: "2" }],
      payments: [{ instrument: "efectivo_usd", currency: "USD", amount: "5.60" }],
    });
    expect(venta.status).toBe(201);
    const v = (await venta.json()) as { document: { id: string; status: string } };
    expect(v.document.status).toBe("paid");

    const detalle = await pedir("GET", `/v1/documents/${v.document.id}`);
    const d = (await detalle.json()) as { balance: string };
    expect(d.balance).toBe("0.00");

    // Y en la base tampoco queda polvo: el saldo funcional es cero exacto.
    const [saldo] = await sql<{ s: string }[]>`
      select platform.document_balance(${COMPANY}, ${v.document.id})::text as s`;
    expect(Number(saldo!.s)).toBe(0);
  });

  it("§3 · cobrar en bolívares el total exacto a la MISMA tasa no escribe diferencial", async () => {
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: DELIVERY, quantity: "1" }],
    });
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string; total_amount: string } })
      .document;

    const cobro = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: doc.id,
      currency: "VES",
      amount: doc.total_amount,
      instrument: "efectivo_bs",
    });
    expect(cobro.status).toBe(201);
    const c = (await cobro.json()) as { exchange_difference: unknown | null };
    // Antes: «Ganancia cambiaria 0,00000302» en cada venta cobrada a la tasa del día.
    expect(c.exchange_difference).toBeNull();

    const [filas] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.exchange_gain_loss
       where company_id = ${COMPANY} and document_id = ${doc.id}`;
    expect(filas!.n).toBe(0);
  });

  it("§4 · la deuda de un recibo sin cobros es su total, al céntimo", async () => {
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [
        { product_id: REFRESCO, quantity: "3" },
        { product_id: DELIVERY, quantity: "1" },
      ],
    });
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string; total_amount: string } })
      .document;

    const detalle = await pedir("GET", `/v1/documents/${doc.id}`);
    const d = (await detalle.json()) as { balance: string; document: { total_amount: string } };
    // Antes: Total Bs 21.493,12 y Saldo Bs 21.493,114984, dos cifras para lo mismo.
    expect(Number(d.balance)).toBe(Number(doc.total_amount));
  });
});

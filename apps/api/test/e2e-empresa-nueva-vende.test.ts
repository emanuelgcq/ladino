import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * EMPRESA NUEVA → CARGA UN PRODUCTO → LO VENDE. Nada más (bug de producción,
 * 2026-09-15, «Pollos y víveres paola»).
 *
 * El defecto: `createCompany` sembraba «detal» y «mayor» en la moneda
 * FUNCIONAL (VES) y sin lista predeterminada; el alta simple, con el precio
 * anclado en USD (ADR-0046/0047), no cabía en «detal» VES y lo escribía en una
 * lista nueva «detal USD»; la caja, sin predeterminada, resolvía «detal» por
 * nombre — la lista VES, vacía — y la cotización respondía 422/409 sin precio.
 * El alta escribía en una lista y la caja leía en otra.
 *
 * Criterio: sin pasos intermedios (sin Ajustes, sin SQL salvo la tasa oficial
 * del día, que en producción la trae el BCV) y sin un solo 4xx en el camino.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const DUENO = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let COMPANY = "";
let DEPOSITO = "";
let PRODUCTO = "";
const errores: string[] = [];

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
  const headers: Record<string, string> = { Authorization: `Bearer ${await tokenDe(DUENO)}` };
  if (COMPANY !== "") headers["X-Company-Id"] = COMPANY;
  if (metodo !== "GET" && path !== "/v1/onboarding") {
    headers["Idempotency-Key"] = crypto.randomUUID();
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await app.request(path, {
    method: metodo,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status >= 400) errores.push(`${metodo} ${path} → ${r.status}: ${await r.clone().text()}`);
  return r;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id, email) values (${DUENO}, ${`nueva-${RUN}@e2e.ladino`})
            on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), 'e2e-empresa-nueva'
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = ${HOY}::date)`;
  });
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("empresa nueva → cargar un producto en USD → venderlo", () => {
  it("funda la empresa", async () => {
    const r = await pedir("POST", "/v1/onboarding", { business_name: `Víveres ${RUN}` });
    expect(r.status).toBe(201);
    const f = (await r.json()) as { company_id: string; warehouse_id: string };
    COMPANY = f.company_id;
    DEPOSITO = f.warehouse_id;
  });

  it("carga un producto con precio en USD y existencia", async () => {
    const r = await pedir("POST", "/v1/products/simple", {
      company_id: COMPANY,
      name: "Pollo entero",
      price: { amount: "5", currency: "USD" },
      initial_stock: { quantity: "20", unit_cost: { amount: "120", currency: "VES" } },
    });
    expect(r.status).toBe(201);
    PRODUCTO = ((await r.json()) as { product: { id: string } }).product.id;
  });

  it("lo vende en la caja y lo cobra, con el precio DUAL calculado por el servidor", async () => {
    const cot = await pedir("POST", "/v1/pos/quote", {
      company_id: COMPANY,
      lines: [{ product_id: PRODUCTO, quantity: "2" }],
    });
    expect(cot.status).toBe(200);
    const q = (await cot.json()) as {
      currency: string;
      total: string;
      functional_total: string;
    };
    // Anclado en USD (5 × 2) y su equivalente en Bs a la tasa del día: el
    // servidor da los dos lados; aquí solo se comparan, en numeric.
    expect(q.currency).toBe("USD");
    const [dual] = await sql<{ usd: boolean; bs: boolean }[]>`
      select ${q.total}::numeric = 10 as usd,
             ${q.functional_total}::numeric > 0 as bs`;
    expect(dual).toEqual({ usd: true, bs: true });

    const v = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: DEPOSITO,
      lines: [{ product_id: PRODUCTO, quantity: "2" }],
      payments: [{ instrument: "efectivo_bs", amount: q.functional_total, currency: "VES" }],
    });
    expect(v.status).toBe(201);
    expect(((await v.json()) as { document_status: string }).document_status).toBe("paid");
  });

  it("y la cuadrícula de Vender enseña el precio que la caja cobra", async () => {
    const r = await pedir("GET", `/v1/products?only_active=1&with_price=1`);
    expect(r.status).toBe(200);
    const items = ((await r.json()) as { items: Record<string, unknown>[] }).items;
    const p = items.find((i) => i["id"] === PRODUCTO)!;
    expect(p["price_currency"]).toBe("USD");
    expect(p["price_amount"]).toBe("5.00000000");
  });

  it("todo el recorrido: ni un 4xx", () => {
    expect(errores).toEqual([]);
  });
  it("el precio se ancla en USD: un precio en bolívares se rechaza con la salida escrita", async () => {
    const r = await pedir("POST", "/v1/products/simple", {
      company_id: COMPANY,
      name: "Bolsa plástica",
      price: { amount: "10", currency: "VES" },
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain(
      "se carga en dólares (USD)",
    );
  });
});

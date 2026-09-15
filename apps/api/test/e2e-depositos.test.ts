import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * EL SEGUNDO DEPÓSITO NO ROMPE LA CAJA (migración 60, QA de pantalla 2026-09-15 h. 40/46/47/49).
 *
 * El defecto: la caja y la compra simple tomaban «el primer depósito por código» y el dueño
 * solo tenía alcance sobre el depósito que nació con la empresa. Un depósito nuevo con un
 * código que ordenaba antes que W1 pasaba a ser el de la caja, y cobrar respondía 422
 * «exige el permiso inventory.move sobre ese almacén concreto» — al dueño.
 *
 * Criterio: el dueño crea «A0» (ordena antes que W1) y la caja sigue vendiendo desde W1; el
 * dueño transfiere a A0 sin 403; puede hacerlo principal; no puede apagar el principal ni un
 * depósito con mercancía; un código con espacios o tildes se rechaza.
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
let W1 = "";
let A0 = "";
let PRODUCTO = "";

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
  return app.request(path, {
    method: metodo,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface Deposito {
  id: string;
  code: string;
  status: string;
  is_default: boolean;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id, email) values (${DUENO}, ${`depositos-${RUN}@e2e.ladino`})
            on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), 'e2e-depositos'
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = ${HOY}::date)`;
  });
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("un segundo depósito no le quita la caja al dueño", () => {
  it("funda la empresa con su depósito principal y un producto con existencia", async () => {
    const r = await pedir("POST", "/v1/onboarding", { business_name: `Depósitos ${RUN}` });
    expect(r.status).toBe(201);
    const f = (await r.json()) as { company_id: string; warehouse_id: string };
    COMPANY = f.company_id;
    W1 = f.warehouse_id;
    const p = await pedir("POST", "/v1/products/simple", {
      company_id: COMPANY,
      name: "Harina",
      price: { amount: "2", currency: "USD" },
      initial_stock: { quantity: "10", unit_cost: { amount: "40", currency: "VES" } },
    });
    expect(p.status).toBe(201);
    PRODUCTO = ((await p.json()) as { product: { id: string } }).product.id;
  });

  it("rechaza un código con espacios o tildes, como dice la ayuda", async () => {
    const r = await pedir("POST", "/v1/warehouses", {
      company_id: COMPANY,
      code: "Depósito trasero",
      name: "Trasero",
    });
    expect(r.status).toBe(422);
  });

  it("crea «A0» (ordena antes que W1) y el principal SIGUE siendo W1", async () => {
    const r = await pedir("POST", "/v1/warehouses", {
      company_id: COMPANY,
      code: "a0",
      name: "Trasero",
    });
    expect(r.status).toBe(201);
    const creado = (await r.json()) as Deposito;
    A0 = creado.id;
    expect(creado.code).toBe("A0");
    expect(creado.is_default).toBe(false);

    const l = await pedir("GET", "/v1/warehouses");
    const lista = (await l.json()) as Deposito[];
    expect(lista[0]!.id).toBe(W1);
    expect(lista.find((d) => d.id === W1)!.is_default).toBe(true);
  });

  it("la caja vende desde el principal sin 4xx", async () => {
    const cot = await pedir("POST", "/v1/pos/quote", {
      company_id: COMPANY,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
    });
    expect(cot.status).toBe(200);
    const q = (await cot.json()) as { functional_total: string };
    const v = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
      payments: [{ instrument: "efectivo_bs", amount: q.functional_total, currency: "VES" }],
    });
    expect(v.status).toBe(201);
  });

  it("el dueño transfiere al depósito nuevo sin 403: quedó atado a él al crearlo", async () => {
    const t = await pedir("POST", "/v1/inventory/transfers", {
      company_id: COMPANY,
      product_id: PRODUCTO,
      from_warehouse_id: W1,
      to_warehouse_id: A0,
      quantity: "3",
    });
    expect(t.status).toBe(201);
  });

  it("vender desde un depósito sin alcance responde 403, no 422 «dato inválido»", async () => {
    // Un depósito insertado por fuera del caso de uso (sin binding): el camino que antes daba 422.
    const [suelto] = await sql<{ id: string }[]>`
      insert into public.warehouses (tenant_id, company_id, code, name)
      select tenant_id, id, 'SUELTO', 'Sin binding' from public.companies where id = ${COMPANY}
      returning id`;
    const v = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: suelto!.id,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
      payments: [{ instrument: "efectivo_bs", amount: "80", currency: "VES" }],
    });
    expect(v.status).toBe(403);
    await sql`update public.warehouses set status = 'inactive' where id = ${suelto!.id}`;
  });

  it("no apaga el principal ni un depósito con mercancía; lo dice con 409", async () => {
    const principal = await pedir("PATCH", `/v1/warehouses/${W1}`, {
      company_id: COMPANY,
      status: "inactive",
    });
    expect(principal.status).toBe(409);
    const conMercancia = await pedir("PATCH", `/v1/warehouses/${A0}`, {
      company_id: COMPANY,
      status: "inactive",
    });
    expect(conMercancia.status).toBe(409);
    expect(((await conMercancia.json()) as { code: string }).code).toBe("WAREHOUSE_IN_USE");
  });

  it("hace principal a A0 y lo renombra; el principal pasa a ser A0", async () => {
    const r = await pedir("PATCH", `/v1/warehouses/${A0}`, {
      company_id: COMPANY,
      make_default: true,
      name: "Depósito del fondo",
    });
    expect(r.status).toBe(200);
    const d = (await r.json()) as Deposito & { name: string };
    expect(d.is_default).toBe(true);
    expect(d.name).toBe("Depósito del fondo");
    const [pr] = await sql<{ id: string }[]>`select platform.default_warehouse(${COMPANY}) as id`;
    expect(pr!.id).toBe(A0);
  });
});

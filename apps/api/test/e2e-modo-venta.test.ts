import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * EL MODO DE VENTA POR LA API (migración 54, plan «Ladino sin RIF» Ola 1.0).
 * `GET /v1/fiscal/setup` expone `sales_mode`, la definición única que la web lee
 * en lugar de comparar nombres de régimen. Se recorre la vida de una empresa:
 * nace sin régimen (ninguno), declara que vende con recibos (recibos) y saca su
 * RIF (facturas) — esta última transición pasa por la ruta que ahora decide
 * «vende con recibos» con esa misma definición.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const TENANT = crypto.randomUUID();
const COMPANY = crypto.randomUUID();
const DUENO = crypto.randomUUID();
const ROL = crypto.randomUUID();
const RUN = Date.now().toString(36);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;

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
  return app.request(path, {
    method: metodo,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function modo(): Promise<string> {
  const r = await pedir("GET", "/v1/fiscal/setup");
  expect(r.status).toBe(200);
  return ((await r.json()) as { sales_mode: string }).sales_mode;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e modo de venta')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code)
             values (${COMPANY}, ${TENANT}, ${`PEND-MV-${RUN}`}, 'Negocio modo de venta', 'VES')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2emodo_dueno_${RUN}`}, 'Dueño', false)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'fiscal.regime.manage')`;
    const mem = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${mem}, ${TENANT}, ${DUENO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${crypto.randomUUID()}, ${TENANT}, ${mem}, ${ROL}, null)`;
  });
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("sales_mode en /v1/fiscal/setup", () => {
  it("sin régimen vigente el modo es «ninguno»", async () => {
    expect(await modo()).toBe("ninguno");
  });

  it("al declarar que vende con recibos el modo es «recibos»", async () => {
    const r = await pedir("POST", "/v1/fiscal/regime", { regime_code: "sin_facturacion" });
    expect(r.status).toBe(201);
    expect(await modo()).toBe("recibos");
  });

  it("al sacar su RIF el modo pasa a «facturas», y desde ahí no se vuelve a recibos", async () => {
    const sube = await pedir("POST", "/v1/fiscal/regime", { regime_code: "formatos_libres" });
    expect(sube.status).toBe(201);
    expect(await modo()).toBe("facturas");

    const baja = await pedir("POST", "/v1/fiscal/regime", { regime_code: "sin_facturacion" });
    expect(baja.status).toBe(409);
    expect(await modo()).toBe("facturas");
  });
});

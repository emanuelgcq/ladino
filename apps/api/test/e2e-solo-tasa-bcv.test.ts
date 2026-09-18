import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { sembrarTasaOficial, borrarTasasOficiales } from "./_tasa-oficial.js";

/**
 * SOLO EXISTE LA TASA DEL BCV (ADR-0064 §1, migración 66). El dueño, 2026-09-16: «no existen
 * tasas propias, solo la del BCV» y «ya no permitas escribir ninguna tasa a mano».
 *
 *   §1 — una tasa tecleada ANTES de la migración (900, el caso del QA h. 70) ya no convierte:
 *        manda la oficial del día (842,2067);
 *   §2 — y tampoco aparece en el listado de tasas como si rigiera;
 *   §3 — cargar una tasa a mano se rechaza con su motivo, y no escribe nada;
 *   §4 — y una entrada de inventario tampoco acepta «otra tasa».
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
const HOY = diaCaracas();
const FUENTE_OFICIAL = "BCV e2e-solo-bcv";
const FUENTE_TECLEADA = `Carga manual e2e-solo-bcv ${RUN}`;

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
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e solo BCV')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code)
             values (${COMPANY}, ${TENANT}, ${`J-BCV-${RUN}`}, 'Comercial Solo BCV', 'VES')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2esolobcv_${RUN}`}, 'Dueño', false)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'fx.rate.manage') on conflict do nothing`;
    const mem = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${mem}, ${TENANT}, ${DUENO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${crypto.randomUUID()}, ${TENANT}, ${mem}, ${ROL}, null)`;
  });
  // La oficial del día, guardada después de cualquier otra de hoy: manda en este fichero.
  await sembrarTasaOficial(sql, { rate: "842.20670000", source: FUENTE_OFICIAL, rate_date: HOY });
  // Una tasa TECLEADA antes de la migración 66 (como postgres: hoy nadie puede escribirla).
  await sql`
    insert into public.exchange_rates
      (tenant_id, company_id, from_currency, to_currency, rate, source, rate_date, rate_timestamp)
    values (${TENANT}, ${COMPANY}, 'USD', 'VES', 900, ${FUENTE_TECLEADA}, ${HOY}::date, now())`;
});

afterAll(async () => {
  await borrarTasasOficiales(sql, FUENTE_OFICIAL);
  await sql`delete from public.exchange_rates where source = ${FUENTE_TECLEADA}`;
  await sql?.end();
  await sqlApi?.end();
});

describe("solo existe la tasa del BCV", () => {
  it("§1 — la tasa tecleada (900) ya no convierte: manda la oficial del día", async () => {
    const r = await pedir("GET", "/v1/negocio/convertir?amount=1&from=USD&to=VES");
    expect(r.status, await r.clone().text()).toBe(200);
    const c = (await r.json()) as { rate: string; rate_source: string; converted: string };
    expect(c.rate).toBe("842.20670000");
    expect(c.rate_source).toBe(FUENTE_OFICIAL);
    expect(c.converted).toBe("842.21");
  });

  it("§2 — la tecleada no aparece en el listado de tasas", async () => {
    const r = await pedir("GET", "/v1/exchange-rates?from=USD&to=VES");
    expect(r.status).toBe(200);
    const filas = (await r.json()) as { source: string; scope: string }[];
    expect(filas.some((f) => f.source === FUENTE_TECLEADA)).toBe(false);
    expect(filas.every((f) => f.scope === "plataforma")).toBe(true);
    expect(filas[0]?.source).toBe(FUENTE_OFICIAL);
  });

  it("§3 — cargar una tasa a mano se rechaza con su motivo y no escribe nada", async () => {
    const fuente = `Intento a mano ${RUN}`;
    const r = await pedir("POST", "/v1/exchange-rates", {
      from_currency: "USD",
      to_currency: "VES",
      rate: "950.00000000",
      source: fuente,
      rate_date: HOY,
    });
    expect(r.status).toBe(409);
    const e = (await r.json()) as { code: string; message: string };
    expect(e.code).toBe("RATE_ONLY_FROM_BCV");
    expect(e.message).toContain("Traer del BCV");
    const [n] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.exchange_rates where source = ${fuente}`;
    expect(n!.n).toBe("0");
  });

  it("§4 — una entrada de inventario ya no se valora a «otra tasa»", async () => {
    // Ids cualesquiera: el rechazo va antes de mirar producto, depósito o permisos.
    const r = await pedir("POST", "/v1/inventory/receipts", {
      origin: "aporte",
      company_id: COMPANY,
      warehouse_id: crypto.randomUUID(),
      product_id: crypto.randomUUID(),
      quantity: "1",
      amount: "10.00000000",
      currency: "USD",
      fx: {
        rate: "950.00000000",
        source: "Pactada con el proveedor",
        at: new Date().toISOString(),
      },
    });
    expect(r.status).toBe(409);
    const e = (await r.json()) as { code: string; message: string };
    expect(e.code).toBe("RATE_ONLY_FROM_BCV");
    expect(e.message).toContain("tasa del BCV del día");
  });
});

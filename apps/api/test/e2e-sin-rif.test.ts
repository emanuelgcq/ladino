import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * SIN RIF, RECIBOS (regla del dueño, 2026-09-16): «si tienes RIF tienes facturas; si NO
 * tienes RIF, das recibos».
 *
 *   1. un negocio sin RIF crea un producto sin que nadie le pregunte por el IVA: la
 *      clasificación es la de la empresa;
 *   2. registra a un cliente empresa (J-…) sin «domicilio fiscal»: un recibo no lo imprime;
 *   3. VARIANTE ROTA: el mismo cliente, en una empresa CON RIF, sigue exigiendo la dirección
 *      — la regla de la factura no se relajó para quien factura.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const TENANT = crypto.randomUUID();
const SIN_RIF = crypto.randomUUID();
const CON_RIF = crypto.randomUUID();
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

async function pedir(empresa: string, path: string, body: unknown): Promise<Response> {
  const r = await app.request(path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await tokenDe(DUENO)}`,
      "X-Company-Id": empresa,
      "Idempotency-Key": crypto.randomUUID(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (process.env["LADINO_E2E_DEBUG"] === "1" && r.status >= 400) {
    // eslint-disable-next-line no-console
    console.log(path, r.status, await r.clone().text());
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
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e sin RIF')`;
    // La empresa sin RIF lleva el marcador que le pone el registro.
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code)
             values (${SIN_RIF}, ${TENANT}, ${`PEND-${RUN.toUpperCase()}`}, 'Bodega Doña Carmen',
                     'VES'),
                    (${CON_RIF}, ${TENANT}, ${`J-SR-${RUN}`}, 'Ferretería Formal', 'VES')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2esinrif_${RUN}`}, 'Dueño', false)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'product.manage'), (${ROL}, 'customer.manage')
             on conflict do nothing`;
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

describe("sin RIF, recibos: nada de IVA ni de domicilio fiscal", () => {
  it("un producto nace sin que nadie pregunte por el IVA: toma la clasificación de la empresa", async () => {
    const r = await pedir(SIN_RIF, "/v1/products", {
      company_id: SIN_RIF,
      sku: `HARINA-${RUN}`,
      name: "Harina PAN",
      kind: "good",
      unit_code: "unidad",
    });
    expect(r.status).toBe(201);
    const p = (await r.json()) as { tax_category_code: string };
    const [ajuste] = await sql<{ c: string | null }[]>`
      select default_tax_category_code as c from public.company_settings
       where company_id = ${SIN_RIF}`;
    expect(p.tax_category_code).toBe(ajuste?.c ?? "gravado_general");
  });

  it("un cliente empresa se registra sin «domicilio fiscal»: un recibo no lo imprime", async () => {
    const r = await pedir(SIN_RIF, "/v1/customers", {
      company_id: SIN_RIF,
      tax_id: `J${RUN.length}0${Date.now() % 100000000}`,
      legal_name: "Abasto La Esquina",
    });
    expect(r.status).toBe(201);
  });

  it("VARIANTE ROTA: con RIF, el mismo cliente sigue exigiendo la dirección de la factura", async () => {
    const r = await pedir(CON_RIF, "/v1/customers", {
      company_id: CON_RIF,
      tax_id: `J${RUN.length}1${Date.now() % 100000000}`,
      legal_name: "Constructora Formal",
    });
    expect(r.status).toBe(422);
    // El mensaje, no solo el código: otro 422 del esquema diría lo mismo.
    expect(((await r.json()) as { message: string }).message).toContain("domicilio fiscal");
  });
});

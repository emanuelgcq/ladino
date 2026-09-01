import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/** Clientes de extremo a extremo con JWT real, como ladino_api: segregación de
 *  los tres permisos, RIF nullable con único parcial, y el valor anterior del
 *  RIF en la auditoría tras el PUT. */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const TENANT = "e2ec0000-0000-4000-8000-000000000001";
const COMPANY = "e2ec0000-0000-4000-8000-000000000002";
const GESTOR = "e2ec0000-0000-4000-8000-00000000000a";
const RIF = "e2ec0000-0000-4000-8000-00000000000b";
const COBRANZAS = "e2ec0000-0000-4000-8000-00000000000c";
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

async function pedir(metodo: string, path: string, sub: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(sub)}`,
    "X-Company-Id": COMPANY,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = crypto.randomUUID();
  }
  return app.request(path, {
    method: metodo,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${GESTOR}), (${RIF}), (${COBRANZAS}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${GESTOR}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e cli') on conflict (id) do nothing`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name)
             values (${COMPANY}, ${TENANT}, 'J-E2ECLI', 'Empresa e2e clientes') on conflict (id) do nothing`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             ('e2ec0000-0000-4000-8000-0000000000e1', null, 'e2ec_gestor', 'Gestor', false),
             ('e2ec0000-0000-4000-8000-0000000000e2', null, 'e2ec_rif', 'RIF', false),
             ('e2ec0000-0000-4000-8000-0000000000e3', null, 'e2ec_cobranzas', 'Cobranzas', false)
             on conflict (id) do nothing`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             ('e2ec0000-0000-4000-8000-0000000000e1', 'customer.manage'),
             ('e2ec0000-0000-4000-8000-0000000000e2', 'customer.tax_id.manage'),
             ('e2ec0000-0000-4000-8000-0000000000e3', 'customer.block')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             ('e2ec0000-0000-4000-8000-0000000000a1', ${TENANT}, ${GESTOR}),
             ('e2ec0000-0000-4000-8000-0000000000b1', ${TENANT}, ${RIF}),
             ('e2ec0000-0000-4000-8000-0000000000c1', ${TENANT}, ${COBRANZAS})
             on conflict (id) do nothing`;
    await tx`insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
             ('e2ec0000-0000-4000-8000-0000000000a2', ${TENANT}, 'e2ec0000-0000-4000-8000-0000000000a1', 'e2ec0000-0000-4000-8000-0000000000e1', null),
             ('e2ec0000-0000-4000-8000-0000000000b2', ${TENANT}, 'e2ec0000-0000-4000-8000-0000000000b1', 'e2ec0000-0000-4000-8000-0000000000e2', null),
             ('e2ec0000-0000-4000-8000-0000000000c2', ${TENANT}, 'e2ec0000-0000-4000-8000-0000000000c1', 'e2ec0000-0000-4000-8000-0000000000e3', null)
             on conflict (id) do nothing`;
  });
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("clientes de extremo a extremo", () => {
  let id: string;
  const base = {
    company_id: COMPANY,
    person_type_code: "juridica",
    taxpayer_type_code: "ordinario",
  };

  it("los catálogos de contraparte responden (6 y 4)", async () => {
    // 6 desde la migración 32: consumidor_final se sumó a los cinco de ADR-0033.
    expect(
      ((await (await pedir("GET", "/v1/taxpayer-types", GESTOR)).json()) as unknown[]).length,
    ).toBe(6);
    expect(
      ((await (await pedir("GET", "/v1/person-types", GESTOR)).json()) as unknown[]).length,
    ).toBe(4);
  });

  it("POST crea; el mismo RIF (otra caja) → 409 con el mensaje del dominio; natural sin RIF ×2 → 201", async () => {
    const r = await pedir("POST", "/v1/customers", GESTOR, {
      ...base,
      tax_id: `J-E2E-${RUN}`,
      legal_name: "Cliente e2e",
    });
    expect(r.status).toBe(201);
    id = ((await r.json()) as { id: string }).id;

    const dup = await pedir("POST", "/v1/customers", GESTOR, {
      ...base,
      tax_id: `j-e2e-${RUN}`,
      legal_name: "Duplicado",
    });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { message: string }).message).toContain(
      "Ya existe un cliente con ese RIF",
    );

    const n1 = await pedir("POST", "/v1/customers", GESTOR, {
      ...base,
      tax_id: null,
      person_type_code: "natural",
      taxpayer_type_code: "no_sujeto",
      legal_name: `Final ${RUN} 1`,
    });
    const n2 = await pedir("POST", "/v1/customers", GESTOR, {
      ...base,
      tax_id: null,
      person_type_code: "natural",
      taxpayer_type_code: "no_sujeto",
      legal_name: `Final ${RUN} 2`,
    });
    expect([n1.status, n2.status]).toEqual([201, 201]);
  });

  it("GET con búsqueda por RIF y paginación", async () => {
    const r = await pedir("GET", `/v1/customers?search=J-E2E-${RUN}&per_page=5`, GESTOR);
    expect(r.status).toBe(200);
    const pagina = (await r.json()) as { items: { id: string }[]; total: number };
    expect(pagina.total).toBe(1);
    expect(pagina.items[0]?.id).toBe(id);
  });

  it("PUT tax-id: gestor 403; usuario con customer.tax_id.manage 200 y el valor anterior queda en la auditoría", async () => {
    expect(
      (
        await pedir("PUT", `/v1/customers/${id}/tax-id`, GESTOR, {
          company_id: COMPANY,
          tax_id: `J-NEW-${RUN}`,
        })
      ).status,
    ).toBe(403);
    const ok = await pedir("PUT", `/v1/customers/${id}/tax-id`, RIF, {
      company_id: COMPANY,
      tax_id: `J-NEW-${RUN}`,
    });
    expect(ok.status).toBe(200);
    const [hecho] = await sql<{ payload: { tax_id_anterior: string; tax_id_nuevo: string } }[]>`
      select payload from public.audit_events where aggregate_id = ${id} and event_type = 'customer.tax_id_changed'`;
    expect(hecho?.payload).toMatchObject({
      tax_id_anterior: `J-E2E-${RUN}`,
      tax_id_nuevo: `J-NEW-${RUN}`,
    });
  });

  it("PUT blocked: gestor 403; cobranzas 200; PATCH de estado sobre un bloqueado → 422", async () => {
    expect(
      (
        await pedir("PUT", `/v1/customers/${id}/blocked`, GESTOR, {
          company_id: COMPANY,
          blocked: true,
        })
      ).status,
    ).toBe(403);
    const b = await pedir("PUT", `/v1/customers/${id}/blocked`, COBRANZAS, {
      company_id: COMPANY,
      blocked: true,
      reason: "mora",
    });
    expect(b.status).toBe(200);
    expect(((await b.json()) as { status: string }).status).toBe("blocked");
    const patch = await pedir("PATCH", `/v1/customers/${id}`, GESTOR, {
      company_id: COMPANY,
      status: "active",
    });
    expect(patch.status).toBe(422);
  });
});

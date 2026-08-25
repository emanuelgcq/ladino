import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { createClient } from "@ladino/db";
import { contextMiddleware } from "../src/middleware/scope.js";
import { CTX } from "../src/middleware/context.js";
import type { AuthResult } from "../src/middleware/auth.js";

/**
 * El middleware de scope contra la base REAL y como `ladino_api` — el camino
 * de producción. Lo que gobierna el fichero es la regla 404/403: una company
 * que existe pero no es visible para el actor responde EXACTAMENTE igual que
 * una que no existe, cuerpo incluido. Tres casos indistinguibles: inexistente,
 * de otro tenant, y —el que separa visibilidad de membership— del propio
 * tenant pero sin asignación que la alcance.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";

const TENANT = "5c0be000-0000-4000-8000-000000000001";
const TENANT_B = "5c0be000-0000-4000-8000-000000000002";
const USUARIO = "5c0be000-0000-4000-8000-00000000000a";
const CO_ASIGNADA = "5c0be000-0000-4000-8000-0000000000c1"; // ura directa
const CO_SIN_ASIGNAR = "5c0be000-0000-4000-8000-0000000000c2"; // mismo tenant, sin ura
const CO_AJENA = "5c0be000-0000-4000-8000-0000000000c3"; // otro tenant
const CO_INEXISTENTE = "5c0be000-0000-4000-8000-0000000000c9";

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: Hono;

function pedir(headers: Record<string, string> = {}) {
  return app.request("/v1/eco", { headers });
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  await sql`insert into auth.users (id) values (${USUARIO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${USUARIO}, true)`;
    await tx`insert into public.tenants (id, name) values
             (${TENANT}, 'Tenant scope'), (${TENANT_B}, 'Tenant scope B')
             on conflict (id) do nothing`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name) values
             (${CO_ASIGNADA}, ${TENANT}, 'J-SCOPE-1', 'Asignada'),
             (${CO_SIN_ASIGNAR}, ${TENANT}, 'J-SCOPE-2', 'Sin asignar'),
             (${CO_AJENA}, ${TENANT_B}, 'J-SCOPE-3', 'Ajena')
             on conflict (id) do nothing`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             ('5c0be000-0000-4000-8000-0000000000e1', null, 'scope_lector', 'Lector', false)
             on conflict (id) do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             ('5c0be000-0000-4000-8000-0000000000a1', ${TENANT}, ${USUARIO})
             on conflict (id) do nothing`;
    await tx`insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
             ('5c0be000-0000-4000-8000-0000000000a2', ${TENANT},
              '5c0be000-0000-4000-8000-0000000000a1', '5c0be000-0000-4000-8000-0000000000e1',
              ${CO_ASIGNADA})
             on conflict (id) do nothing`;
  });

  app = new Hono();
  // Stub de auth (el JWT tiene su fichero); el middleware BAJO PRUEBA es el real.
  app.use("*", async (c, next) => {
    const auth: AuthResult = { actor: { kind: "user", userId: USUARIO }, userId: USUARIO };
    c.set("ladino.auth", auth);
    await next();
  });
  app.use("*", contextMiddleware(sqlApi));
  app.get("/v1/eco", (c) => {
    const ctx = c.get(CTX);
    return c.json({ companyId: ctx.companyId, tenantId: ctx.tenantId, requestId: ctx.requestId });
  });
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("X-Company-Id contra ladino_user_company_ids (migración 15)", () => {
  it("company asignada → pasa, y el contexto lleva companyId y el tenant REAL de la company", async () => {
    const res = await pedir({ "X-Company-Id": CO_ASIGNADA });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ companyId: CO_ASIGNADA, tenantId: TENANT });
  });

  it("sin header → pasa con companyId y tenantId null: el alcance company es opcional", async () => {
    const res = await pedir();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ companyId: null, tenantId: null });
  });

  it("los TRES 404 son indistinguibles: sin asignación, de otro tenant, inexistente", async () => {
    const cuerpos = [];
    for (const id of [CO_SIN_ASIGNAR, CO_AJENA, CO_INEXISTENTE]) {
      const res = await pedir({ "X-Company-Id": id, "X-Request-Id": "req-404" });
      expect(res.status).toBe(404);
      cuerpos.push(await res.json());
    }
    // El MISMO cuerpo (con el request_id fijado para poder comparar): responder
    // distinto confirmaría qué companies existen.
    expect(cuerpos[1]).toEqual(cuerpos[0]);
    expect(cuerpos[2]).toEqual(cuerpos[0]);
    expect(cuerpos[0]).toMatchObject({ code: "NOT_FOUND", request_id: "req-404" });
  });

  it("malformado → 422 sin tocar la base (la lección H-5: nunca un 500 disparable)", async () => {
    const res = await pedir({ "X-Company-Id": "no-es-uuid" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("X-Request-Id acotado: uno con forma se honra, uno hostil se sustituye", async () => {
    const ok = await pedir({ "X-Request-Id": "req_1.a-b" });
    expect((await ok.json()).requestId).toBe("req_1.a-b");
    // (Un \n literal ni siquiera pasa el constructor de Headers de fetch: el
    // caso que este middleware cubre es el valor largo o con caracteres raros
    // que Headers SÍ deja pasar.)
    const hostil = await pedir({ "X-Request-Id": "x".repeat(200) + "{}|;" });
    const cuerpo = (await hostil.json()) as { requestId: string };
    expect(cuerpo.requestId).not.toContain("xxxx");
    expect(cuerpo.requestId).toMatch(/^[0-9a-f-]{36}$/); // se generó un uuid
  });
});

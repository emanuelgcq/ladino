import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { RULES_VERSION } from "@ladino/domain";
import { buildApp } from "../src/app.js";

/**
 * EXTREMO A EXTREMO, POR EL CAMINO DE PRODUCCIÓN. La petición entra con un JWT
 * firmado de verdad y atraviesa authMiddleware → contexto → idempotencia →
 * handler → caso de uso → Postgres real. NADA se inyecta en el contexto a
 * mano: si el endpoint solo se probara con el middleware simulado, la
 * plantilla enseñaría a saltárselo — y esto lo copian diez módulos.
 *
 * El secreto y el emisor son los del stack local de Supabase: el token es tan
 * real como el que emitiría GoTrue local.
 */

const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";

const TENANT = "dddddddd-dddd-4ddd-8ddd-000000000001";
const ADMIN = "dddddddd-dddd-4ddd-8ddd-00000000000a"; // company.manage tenant-wide
const MIEMBRO = "dddddddd-dddd-4ddd-8ddd-00000000000b"; // membership sin permiso
const FORASTERO = "dddddddd-dddd-4ddd-8ddd-00000000000c"; // sin membership
const ROL = "dddddddd-dddd-4ddd-8ddd-00000000000d";
const ACOTADO = "dddddddd-dddd-4ddd-8ddd-00000000000e"; // rol requires_scope=true, tenant-wide
const ROL_ACOTADO = "dddddddd-dddd-4ddd-8ddd-00000000000f";

let sql: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;

async function tokenDe(sub: string, expiraEn = "1h"): Promise<string> {
  return new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(expiraEn)
    .sign(JWT_SECRET);
}

// RIFs únicos por corrida: las companies creadas NO se pueden borrar entre
// corridas (audit_events_company_fk es NO ACTION — F-9, conservación).
const RUN = Date.now().toString(36);
const rif = (n: number): string => `J-E2E-${RUN}-${n}`;

async function crear(opts: {
  token?: string | null;
  key?: string | null;
  body?: object;
}): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token !== null) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.key !== undefined && opts.key !== null) headers["Idempotency-Key"] = opts.key;
  return app.request("/v1/companies", {
    method: "POST",
    headers,
    body: JSON.stringify(
      opts.body ?? { tenant_id: TENANT, legal_name: "Empresa E2E", tax_id: rif(0) },
    ),
  });
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  app = buildApp({ sql, auth: { jwtSecret: JWT_SECRET, issuer: ISSUER } });

  await sql`delete from public.idempotency_keys where tenant_id = ${TENANT}`;
  await sql`insert into auth.users (id) values (${ADMIN}), (${MIEMBRO}), (${FORASTERO}), (${ACOTADO})
            on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${ADMIN}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant E2E')
             on conflict (id) do nothing`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, 'e2e_admin', 'Admin E2E', false)
             on conflict (id) do nothing`;
    await tx`insert into public.role_permissions (role_id, permission_key)
             values (${ROL}, 'company.manage') on conflict do nothing`;
    // ADMIN: asignación TENANT-WIDE (company_id null) — es lo que autoriza a
    // crear companies. MIEMBRO: membership sin asignación ninguna.
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             ('dddddddd-dddd-4ddd-8ddd-0000000000a1', ${TENANT}, ${ADMIN}),
             ('dddddddd-dddd-4ddd-8ddd-0000000000b1', ${TENANT}, ${MIEMBRO}),
             ('dddddddd-dddd-4ddd-8ddd-0000000000c1', ${TENANT}, ${ACOTADO})
             on conflict (id) do nothing`;
    // Y el contraejemplo de la auditoría: un rol ACOTADO (requires_scope) con
    // company.manage, asignado tenant-wide. ADR-0025 §4: sin bindings no opera
    // nada — y en nivel tenant no hay recurso al que atar un binding.
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL_ACOTADO}, null, 'e2e_acotado', 'Acotado E2E', true)
             on conflict (id) do nothing`;
    await tx`insert into public.role_permissions (role_id, permission_key)
             values (${ROL_ACOTADO}, 'company.manage') on conflict do nothing`;
    await tx`insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id)
             values ('dddddddd-dddd-4ddd-8ddd-0000000000a2', ${TENANT},
                     'dddddddd-dddd-4ddd-8ddd-0000000000a1', ${ROL}, null),
                    ('dddddddd-dddd-4ddd-8ddd-0000000000c2', ${TENANT},
                     'dddddddd-dddd-4ddd-8ddd-0000000000c1', ${ROL_ACOTADO}, null)
             on conflict (id) do nothing`;
  });
});

afterAll(async () => {
  await sql`delete from public.idempotency_keys where tenant_id = ${TENANT}`;
  await sql.end();
});

describe("POST /v1/companies — la plantilla, de extremo a extremo", () => {
  it("el camino feliz: 201, y las CUATRO escrituras de la transacción están", async () => {
    const body = { tenant_id: TENANT, legal_name: "Alfa C.A.", tax_id: rif(1) };
    const res = await crear({ token: await tokenDe(ADMIN), key: `${RUN}-K1`, body });

    expect(res.status).toBe(201);
    const empresa = (await res.json()) as { id: string; status: string; created_at: string };
    expect(empresa.status).toBe("onboarding");

    // 1. La company, con la PROCEDENCIA posta por el helper — el GUC lo fijó
    //    withTransaction, ni el handler ni el caso de uso lo tocan.
    const [fila] = await sql<{ created_by: string }[]>`
      select created_by from public.companies where id = ${empresa.id}`;
    expect(fila?.created_by).toBe(ADMIN);

    // 2. El evento de negocio del caso de uso...
    const eventos = await sql<{ event_type: string; rules_version: string }[]>`
      select event_type, rules_version from public.audit_events
       where company_id = ${empresa.id} order by event_type`;
    expect(eventos.map((e) => e.event_type)).toEqual([
      "company.created",
      "company.tax_id_established",
    ]);
    // ...y el del trigger M4 — DOS hechos, no un duplicado. Y el del trigger
    // lleva la rules_version REAL del caso de uso, no 'db-guard': el paso 5
    // fijó el GUC antes de persistir.
    expect(eventos.every((e) => e.rules_version === RULES_VERSION)).toBe(true);

    // 3. El outbox, en LA MISMA transacción.
    const [ob] = await sql<{ event_type: string; schema_version: number }[]>`
      select event_type, schema_version from public.outbox
       where company_id = ${empresa.id}`;
    expect(ob).toEqual({ event_type: "company.created", schema_version: 1 });

    // 4. La clave de idempotencia, cerrada por T2 con la respuesta.
    const [k] = await sql<{ status: string }[]>`
      select status from public.idempotency_keys
       where tenant_id = ${TENANT} and key = ${`${RUN}-K1`}`;
    expect(k?.status).toBe("completed");
  });

  it("replay: misma clave y cuerpo → el MISMO 201, y sigue habiendo UNA empresa", async () => {
    const body = { tenant_id: TENANT, legal_name: "Beta C.A.", tax_id: rif(2) };
    const t = await tokenDe(ADMIN);
    const primera = await crear({ token: t, key: `${RUN}-K2`, body });
    const replay = await crear({ token: t, key: `${RUN}-K2`, body });

    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(await primera.json());
    const [n] = await sql<{ c: string }[]>`
      select count(*)::text as c from public.companies
       where tenant_id = ${TENANT} and tax_id = ${rif(2)}`;
    expect(n?.c).toBe("1");
  });

  it("misma clave, cuerpo distinto → 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const t = await tokenDe(ADMIN);
    await crear({
      token: t,
      key: `${RUN}-K3`,
      body: { tenant_id: TENANT, legal_name: "Gamma", tax_id: rif(3) },
    });
    const res = await crear({
      token: t,
      key: `${RUN}-K3`,
      body: { tenant_id: TENANT, legal_name: "OTRA", tax_id: rif(33) },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("miembro SIN company.manage → 403 PERMISSION_REQUIRED, y la clave queda failed (reintentable)", async () => {
    const res = await crear({
      token: await tokenDe(MIEMBRO),
      key: `${RUN}-K4`,
      body: { tenant_id: TENANT, legal_name: "Delta", tax_id: rif(4) },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("PERMISSION_REQUIRED");

    const [k] = await sql<{ status: string }[]>`
      select status from public.idempotency_keys
       where tenant_id = ${TENANT} and key = ${`${RUN}-K4`}`;
    expect(k?.status).toBe("failed");
  });

  it("un rol ACOTADO con company.manage tenant-wide NO autoriza: 403", async () => {
    // El contraejemplo que encontró la auditoría de S0.5: al JOIN de
    // autorización le faltaba `not r.requires_scope`, y este usuario creaba
    // empresas. Un rol acotado sin bindings no opera nada (ADR-0025 §4), y en
    // una operación de nivel tenant no existe recurso al que atar un binding.
    const res = await crear({
      token: await tokenDe(ACOTADO),
      key: `${RUN}-KC`,
      body: { tenant_id: TENANT, legal_name: "Iota", tax_id: rif(10) },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("PERMISSION_REQUIRED");
  });

  it("SIN membership en el tenant → 404, indistinguible de un tenant inexistente", async () => {
    const ajeno = await crear({
      token: await tokenDe(FORASTERO),
      key: `${RUN}-K5`,
      body: { tenant_id: TENANT, legal_name: "Epsilon", tax_id: rif(5) },
    });
    const inexistente = await crear({
      token: await tokenDe(FORASTERO),
      key: `${RUN}-K6`,
      body: {
        tenant_id: "00000000-0000-4000-8000-0000000000ee",
        legal_name: "Zeta",
        tax_id: rif(6),
      },
    });

    // La regla 404/403: las DOS respuestas deben ser IDÉNTICAS en código. Si
    // difirieran, quien sondea distinguiría «existe y no es mío» de «no
    // existe» — y enumeraría tenants sin leer un dato.
    expect(ajeno.status).toBe(404);
    expect(inexistente.status).toBe(404);
    // Cuerpos COMPLETOS salvo request_id: esta aserción cazó una fuga real —
    // los dos caminos devolvían 404 con code distinto (TENANT_NOT_FOUND vs
    // NOT_FOUND), y el code revelaba lo que el status ocultaba.
    const a = (await ajeno.json()) as Record<string, unknown>;
    const b = (await inexistente.json()) as Record<string, unknown>;
    delete a["request_id"];
    delete b["request_id"];
    expect(a).toEqual(b);
  });

  it("RIF duplicado en el tenant → 409 DUPLICATE", async () => {
    const t = await tokenDe(ADMIN);
    await crear({
      token: t,
      key: `${RUN}-K7`,
      body: { tenant_id: TENANT, legal_name: "Eta", tax_id: rif(7) },
    });
    const res = await crear({
      token: t,
      key: `${RUN}-K8`,
      body: { tenant_id: TENANT, legal_name: "Theta", tax_id: rif(7) },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("DUPLICATE");
  });

  it("cuerpo inválido → 422 VALIDATION_FAILED con request_id, mapeado por el MIDDLEWARE", async () => {
    const res = await crear({
      token: await tokenDe(ADMIN),
      key: `${RUN}-K9`,
      body: { tenant_id: TENANT, tax_id: rif(9) }, // sin legal_name
    });
    expect(res.status).toBe(422);
    const cuerpo = (await res.json()) as { code: string; request_id: string | null };
    expect(cuerpo.code).toBe("VALIDATION_FAILED");
    expect(cuerpo.request_id).not.toBeNull();
  });

  it("sin token → 401; token expirado → 401 TOKEN_EXPIRED", async () => {
    const sinToken = await crear({ token: null, key: `${RUN}-KA` });
    expect(sinToken.status).toBe(401);

    const expirado = await crear({ token: await tokenDe(ADMIN, "-1h"), key: `${RUN}-KB` });
    expect(expirado.status).toBe(401);
    expect(((await expirado.json()) as { code: string }).code).toBe("TOKEN_EXPIRED");
  });

  it("sin Idempotency-Key → 400: la operación está en la lista de críticas", async () => {
    const res = await crear({ token: await tokenDe(ADMIN), key: null });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});

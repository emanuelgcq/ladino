import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * La puesta a punto fiscal del asistente (/empezar) de extremo a extremo.
 *
 * Lo que este fichero demuestra: que el catálogo llega CON su norma citada;
 * que asignar régimen exige permiso, ocurre una vez y la segunda es 409; y
 * que la aceptación del IVA deja SIEMPRE su acta en la auditoría —con quién
 * y cuándo— aunque las reglas globales ya existieran de antes. El acta es lo
 * que separa «la persona aceptó la alícuota» de «el sistema la sembró solo».
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const TENANT = crypto.randomUUID();
const COMPANY = crypto.randomUUID();
const GERENTE = crypto.randomUUID();
const MIRON = crypto.randomUUID();
const ROL_GERENTE = crypto.randomUUID();
const ROL_MIRON = crypto.randomUUID();
const MEM_GERENTE = crypto.randomUUID();
const MEM_MIRON = crypto.randomUUID();
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
  await sql`insert into auth.users (id) values (${GERENTE}), (${MIRON})
            on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${GERENTE}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e empezar')`;
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-E2EFS-${RUN}`}, 'Empresa e2e empezar', 'VES',
                     'ordinario')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL_GERENTE}, null, ${`e2efs_gerente_${RUN}`}, 'Gerente', false),
             (${ROL_MIRON}, null, ${`e2efs_miron_${RUN}`}, 'Mirón', false)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL_GERENTE}, 'fiscal.regime.manage'),
             (${ROL_GERENTE}, 'tax.rules.manage')`;
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${MEM_GERENTE}, ${TENANT}, ${GERENTE}),
             (${MEM_MIRON}, ${TENANT}, ${MIRON})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${crypto.randomUUID()}, ${TENANT}, ${MEM_GERENTE}, ${ROL_GERENTE}, null),
             (${crypto.randomUUID()}, ${TENANT}, ${MEM_MIRON}, ${ROL_MIRON}, ${COMPANY})`;
  });
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("puesta a punto fiscal", () => {
  it("el catálogo llega con su norma citada y sin régimen vigente", async () => {
    const r = await pedir("GET", "/v1/fiscal/setup", GERENTE);
    expect(r.status).toBe(200);
    const cuerpo = (await r.json()) as {
      regimes: { code: string; legal_source: string }[];
      current_regime: string | null;
    };
    expect(cuerpo.current_regime).toBeNull();
    const libre = cuerpo.regimes.find((x) => x.code === "formatos_libres");
    expect(libre).toBeDefined();
    // La norma viene de la MIGRACIÓN, no de esta API: si esto falla, alguien
    // borró la cita y el asistente estaría enseñando un régimen sin sustento.
    expect(libre!.legal_source).toMatch(/Providencia/);
    // Los documentos internos no son un régimen que una persona elija.
    expect(cuerpo.regimes.some((x) => x.code === "interno_no_fiscal")).toBe(false);
  });

  it("asignar régimen exige el permiso", async () => {
    const r = await pedir("POST", "/v1/fiscal/regime", MIRON, { regime_code: "formatos_libres" });
    expect(r.status).toBe(403);
  });

  it("asigna el régimen una vez; la segunda es 409", async () => {
    const r = await pedir("POST", "/v1/fiscal/regime", GERENTE, {
      regime_code: "formatos_libres",
    });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { regime_code: string }).regime_code).toBe("formatos_libres");

    const otra = await pedir("POST", "/v1/fiscal/regime", GERENTE, { regime_code: "sin_emision" });
    expect(otra.status).toBe(409);

    const estado = await pedir("GET", "/v1/fiscal/setup", GERENTE);
    expect(((await estado.json()) as { current_regime: string }).current_regime).toBe(
      "formatos_libres",
    );
  });

  it("aceptar la alícuota exige el permiso", async () => {
    const r = await pedir("POST", "/v1/fiscal/iva-general", MIRON, { rate: "0.16" });
    expect(r.status).toBe(403);
  });

  it("una alícuota que no es fracción se rechaza", async () => {
    const r = await pedir("POST", "/v1/fiscal/iva-general", GERENTE, { rate: "16" });
    expect(r.status).toBe(422);
  });

  it("la aceptación deja su acta y la regla general queda vigente", async () => {
    const r = await pedir("POST", "/v1/fiscal/iva-general", GERENTE, { rate: "0.16" });
    expect(r.status).toBe(201);
    const cuerpo = (await r.json()) as { rate: string; accepted_on: string };
    expect(cuerpo.rate).toBe("0.16");
    expect(cuerpo.accepted_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // El acta es de ESTA empresa aunque las reglas globales ya existieran.
    const actas = await sql<{ payload: { rate: string; accepted_by: string } }[]>`
      select payload from public.audit_events
       where company_id = ${COMPANY} and event_type = 'fiscal.iva.accepted'`;
    expect(actas).toHaveLength(1);
    expect(actas[0]!.payload.rate).toBe("0.16");
    expect(actas[0]!.payload.accepted_by).toBe(GERENTE);

    // Y la regla general de venta está activa y VE-iva la resuelve.
    const estado = await pedir("GET", "/v1/fiscal/setup", GERENTE);
    const cuerpoEstado = (await estado.json()) as { iva_general: { rate: string } | null };
    expect(cuerpoEstado.iva_general).not.toBeNull();
  });

  it("aceptar de nuevo no duplica reglas: solo deja otra acta", async () => {
    const antes = await sql<{ n: string }[]>`
      select count(*)::text as n from public.tax_rules
       where jurisdiction = 'VE' and tax_code = 'iva' and taxpayer_type is null
         and status = 'active'`;
    const r = await pedir("POST", "/v1/fiscal/iva-general", GERENTE, { rate: "0.16" });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { rules_created: number }).rules_created).toBe(0);
    const despues = await sql<{ n: string }[]>`
      select count(*)::text as n from public.tax_rules
       where jurisdiction = 'VE' and tax_code = 'iva' and taxpayer_type is null
         and status = 'active'`;
    expect(despues[0]!.n).toBe(antes[0]!.n);
    const actas = await sql<{ n: string }[]>`
      select count(*)::text as n from public.audit_events
       where company_id = ${COMPANY} and event_type = 'fiscal.iva.accepted'`;
    expect(actas[0]!.n).toBe("2");
  });
});

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient, withTransaction } from "@ladino/db";
import { guardarTasaOficial, RULES_VERSION } from "@ladino/domain";
import { digitoVerificadorRif } from "@ladino/schemas";
import { buildApp } from "../src/app.js";

/**
 * ACTAS, ORIGEN DE LA AUDITORÍA Y VERSIÓN DE REGLAS, DE PUNTA A PUNTA (A-16, B-06, B-14 ·
 * RESPUESTA §2.15 · ADR-0079 · migración 20261004120000).
 *
 *   1. una escritura por la API deja en SUS actas el canal, la ip, el user-agent, la sesión y el
 *      build — sin que el caso de uso los pase: los pone el middleware (A-16);
 *   2. el canal lo dice el `Origin` de la webapp o `X-Ladino-Client`; sin nada, es `api`;
 *   3. ip y user-agent no salen en la respuesta;
 *   4. lo que queda como `rules_version` es una versión REGISTRADA (semver + hash), no la cadena
 *      fija (B-06);
 *   5. guardar la tasa oficial deja su acta de plataforma: actor system, URL, hora de captura,
 *      valor y hash; la misma publicación dos veces es un hecho y un acta (B-14).
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const WEB = "http://127.0.0.1:5174";

const TENANT = crypto.randomUUID();
const ADMIN = crypto.randomUUID();
const ROL = crypto.randomUUID();
const MEM = crypto.randomUUID();
const SESION = crypto.randomUUID();
const RUN = Date.now().toString(36);
const D6 = String(Date.now()).slice(-6);
const rif = (n: number): string => {
  const base = `J${D6}${String(n).padStart(2, "0")}`;
  return `${base}${digitoVerificadorRif(base)}`;
};

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
const tasasSembradas: string[] = [];

const token = () =>
  new SignJWT({ role: "authenticated", session_id: SESION })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(ADMIN)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);

type Acta = {
  event_type: string;
  channel: string | null;
  ip: string | null;
  user_agent: string | null;
  session_id: string | null;
  app_build: string | null;
  rules_version: string;
  registrada: boolean;
};

async function crearEmpresa(
  n: number,
  cabeceras: Record<string, string>,
): Promise<{ status: number; cuerpo: Record<string, unknown>; actas: Acta[] }> {
  const res = await app.request("/v1/companies", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await token()}`,
      "Idempotency-Key": `${RUN}-actas-${n}`,
      ...cabeceras,
    },
    body: JSON.stringify({ tenant_id: TENANT, legal_name: `Actas ${n} C.A.`, tax_id: rif(n) }),
  });
  const cuerpo = (await res.json()) as Record<string, unknown>;
  const actas = await sql<Acta[]>`
    select a.event_type, a.channel, host(a.ip) as ip, a.user_agent, a.session_id, a.app_build,
           a.rules_version,
           exists (select 1 from platform.rules_versions v where v.version = a.rules_version)
             as registrada
      from public.audit_events a
     where a.company_id = ${String(cuerpo["id"])}
     order by a.event_type`;
  return { status: res.status, cuerpo, actas };
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({
    sql: sqlApi,
    auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER },
    corsOrigin: WEB,
    build: "e2e-actas",
  });
  await sql`insert into auth.users (id) values (${ADMIN})`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${ADMIN}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant E2E actas')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, ${TENANT}, ${"e2e_actas_" + RUN}, 'Admin E2E actas', false)`;
    await tx`insert into public.role_permissions (tenant_id, role_id, permission_key)
             values (${TENANT}, ${ROL}, 'company.manage')`;
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${MEM}, ${TENANT}, ${ADMIN})`;
    await tx`insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
             values (${TENANT}, ${MEM}, ${ROL}, null)`;
  });
});

afterAll(async () => {
  await sql`delete from public.idempotency_keys where tenant_id = ${TENANT}`;
  // Las tasas del test tienen fecha de 2001: no las lee nadie. Su acta es append-only y se queda.
  if (tasasSembradas.length > 0) {
    await sql`delete from public.exchange_rates where id = any(${tasasSembradas}::uuid[])`;
  }
  await sql.end();
  await sqlApi.end();
});

describe("A-16 — el acta guarda de dónde vino la escritura", () => {
  it("desde la webapp: canal web, la ip del último salto, user-agent, sesión y build", async () => {
    const r = await crearEmpresa(1, {
      Origin: WEB,
      "User-Agent": "Mozilla/5.0 (E2E actas)",
      // El primer salto lo escribe quien llama; el último lo añade el proxy propio.
      "X-Forwarded-For": "9.9.9.9, 203.0.113.9",
    });
    expect(r.status).toBe(201);
    // Las DOS actas —la del caso de uso y la del trigger M4— sin que ninguno pase el origen.
    expect(r.actas.map((a) => a.event_type)).toEqual([
      "company.created",
      "company.tax_id_established",
    ]);
    for (const a of r.actas) {
      expect(a.channel).toBe("web");
      expect(a.ip).toBe("203.0.113.9");
      expect(a.user_agent).toBe("Mozilla/5.0 (E2E actas)");
      expect(a.session_id).toBe(SESION);
      expect(a.app_build).toBe("api@e2e-actas");
    }
    // Privacidad: ni la ip ni el user-agent salen en la respuesta.
    const texto = JSON.stringify(r.cuerpo);
    expect(texto).not.toContain("203.0.113.9");
    expect(texto).not.toContain("Mozilla");
  });

  it("desde el móvil: lo declara X-Ladino-Client, con su build", async () => {
    const r = await crearEmpresa(2, { "X-Ladino-Client": "mobile/1.4.0" });
    expect(r.status).toBe(201);
    expect(r.actas.every((a) => a.channel === "mobile")).toBe(true);
    expect(r.actas[0]?.app_build).toBe("mobile@1.4.0 api@e2e-actas");
  });

  it("sin declarar nada es api; una ip que no es ip queda vacía y no tumba la escritura", async () => {
    const r = await crearEmpresa(3, {
      "X-Ladino-Client": "root/9; drop",
      "X-Forwarded-For": "no-es-una-ip",
    });
    expect(r.status).toBe(201);
    expect(r.actas).toHaveLength(2);
    expect(r.actas.every((a) => a.channel === "api" && a.ip === null)).toBe(true);
    expect(r.actas[0]?.app_build).toBe("api@e2e-actas");
  });
});

describe("B-06 — la versión de reglas que queda guardada", () => {
  it("es una versión registrada (semver + hash), no la cadena fija", async () => {
    const r = await crearEmpresa(4, {});
    expect(r.status).toBe(201);
    for (const a of r.actas) {
      expect(a.rules_version).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{16}$/);
      expect(a.rules_version).not.toBe(RULES_VERSION);
      expect(a.registrada).toBe(true);
    }
  });
});

describe("B-14 — la tasa oficial se guarda con su acta", () => {
  // Una publicación de 2001: no es la tasa de ningún día que alguien use.
  const captura = {
    rate: "36.12345678",
    rateDate: "2001-01-02",
    actualizada: `2001-01-02T00:00:00-04:00#${RUN}`,
    sourceUrl: "https://fuente.invalid/v1/dolares/oficial",
    capturedAt: "2026-10-04T12:00:00.000Z",
    responseSha256: "a".repeat(64),
  };

  it("actor system, URL de origen, hora de captura, valor y hash; y quién la pidió", async () => {
    const { fila, nueva } = await withTransaction(sqlApi, { kind: "system" }, ({ sql: tx }) =>
      guardarTasaOficial(tx, captura, { trigger: "button", requestedBy: ADMIN }),
    );
    tasasSembradas.push(fila.id);
    expect(nueva).toBe(true);
    const actas = await sql<
      {
        actor_type: string;
        event_type: string;
        requested_by: string | null;
        payload: Record<string, string>;
        con_hash: boolean;
      }[]
    >`
      select actor_type, event_type, requested_by, payload, payload_hash is not null as con_hash
        from public.system_audit_events
       where aggregate_type = 'exchange_rate' and aggregate_id = ${fila.id}`;
    expect(actas).toHaveLength(1);
    expect(actas[0]).toMatchObject({
      actor_type: "system",
      event_type: "fx.rate.captured",
      requested_by: ADMIN,
      con_hash: true,
    });
    expect(actas[0]!.payload).toMatchObject({
      rate: "36.12345678",
      rate_date: "2001-01-02",
      source_url: captura.sourceUrl,
      captured_at: captura.capturedAt,
      response_sha256: captura.responseSha256,
      trigger: "button",
    });
  });

  it("la misma publicación otra vez: ni fila nueva ni acta nueva", async () => {
    const { fila, nueva } = await withTransaction(sqlApi, { kind: "system" }, ({ sql: tx }) =>
      guardarTasaOficial(tx, captura, { trigger: "refresh" }),
    );
    expect(nueva).toBe(false);
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.system_audit_events where aggregate_id = ${fila.id}`;
    expect(n?.n).toBe(1);
  });

  it("una persona no escribe una tasa global ni su acta: solo el actor de sistema", async () => {
    await expect(
      withTransaction(sqlApi, { kind: "user", userId: ADMIN }, ({ sql: tx }) =>
        guardarTasaOficial(
          tx,
          { ...captura, rateDate: "2001-01-03", actualizada: `2001-01-03#${RUN}` },
          { trigger: "button", requestedBy: ADMIN },
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("S3: una tasa global que la API commitea SIN acta (el camino de la API desplegada) recibe la suya al cierre", async () => {
    // Exactamente lo que hace la API anterior a esta entrega: como ladino_api, con el actor de
    // sistema, un insert a secas — y un COMMIT de verdad, que es cuando dispara el trigger
    // diferido (migración 20261004120100).
    const fila = await withTransaction(sqlApi, { kind: "system" }, async ({ sql: tx }) => {
      const [f] = await tx<{ id: string }[]>`
        insert into public.exchange_rates
          (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
        values ('USD', 'VES', 36.5, ${`API anterior ${RUN}`}, '2001-01-04', now())
        returning id`;
      return f!;
    });
    tasasSembradas.push(fila.id);
    const actas = await sql<{ event_type: string; rol: string; rate: string }[]>`
      select event_type, payload->>'written_by_role' as rol, payload->>'rate' as rate
        from public.system_audit_events where aggregate_id = ${fila.id}`;
    expect(actas).toEqual([
      { event_type: "fx.rate.inserted_without_capture", rol: "ladino_api", rate: "36.50000000" },
    ]);
  });
});

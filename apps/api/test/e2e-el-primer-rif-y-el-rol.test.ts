import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * RECORRIDO 2026-09-24, BLOQUE A (ola 4).
 *
 * A-05 · Una empresa que nació SIN RIF guarda como razón social el nombre del negocio
 *   (onboarding.ts). Al poner su PRIMER RIF el servidor solo miraba la dirección fiscal, y la
 *   primera factura congelaba «Bodega La Esquina» como razón social del emisor. ADR-0050: «RIF
 *   real exige razón social y domicilio fiscal». Ahora el primer RIF llega CON su razón social.
 *
 * A-04 · El menú enseña Contabilidad y Libros «cuando hay datos o cuando el rol es contador».
 *   La web solo conocía permisos, y el dueño los tiene todos: `GET /v1/me/permissions` dice
 *   además los roles de sistema de la persona en la empresa.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";

const DUENA = crypto.randomUUID();
const CONTADOR = crypto.randomUUID();
const EXTRANA = crypto.randomUUID();
const RUN = Date.now().toString(36);
const D6 = String(Date.now()).slice(-6);
const NEGOCIO = `Bodega La Esquina ${RUN}`;
const RAZON = `Inversiones La Esquina ${RUN}, C.A.`;
const CORREO_CONTADOR = `contador-${RUN}@e2e.ladino`;

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let COMPANY = "";

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
  const headers: Record<string, string> = { Authorization: `Bearer ${await tokenDe(sub)}` };
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

async function empresa(): Promise<{ tax_id: string; legal_name: string; trade_name: string }> {
  const [c] = await sql<{ tax_id: string; legal_name: string; trade_name: string }[]>`
    select tax_id, legal_name, trade_name from public.companies where id = ${COMPANY}`;
  return c!;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id, email) values
            (${DUENA}, ${`duena-rif-${RUN}@e2e.ladino`}), (${CONTADOR}, ${CORREO_CONTADOR}),
            (${EXTRANA}, ${`extrana-rif-${RUN}@e2e.ladino`})
            on conflict (id) do nothing`;
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("A-05 · el primer RIF llega con su razón social", () => {
  it("sin RIF, la razón social guardada es el nombre del negocio (el punto de partida)", async () => {
    const r = await pedir("POST", "/v1/onboarding", DUENA, { business_name: NEGOCIO });
    expect(r.status).toBe(201);
    COMPANY = ((await r.json()) as { company_id: string }).company_id;
    const c = await empresa();
    expect(c.tax_id.startsWith("PEND-")).toBe(true);
    expect(c.legal_name).toBe(NEGOCIO);
    const dir = await pedir("PUT", "/v1/companies/fiscal-address", DUENA, {
      fiscal_address: "Av. Bolívar, local 3, Valencia, Carabobo",
    });
    expect(dir.status).toBe(200);
  }, 30_000);

  it("poner el primer RIF SIN razón social es 422 con su mensaje, y no cambia nada", async () => {
    const r = await pedir("PUT", "/v1/companies/tax-id", DUENA, { tax_id: `J-66${D6}-1` });
    expect(r.status).toBe(422);
    // El mensaje es lo único que distingue este 422 del de la dirección o el de la estructura.
    expect(((await r.json()) as { message: string }).message).toContain(
      "Con tu RIF, dinos la razón social",
    );
    const c = await empresa();
    expect(c.tax_id.startsWith("PEND-")).toBe(true);
    expect(c.legal_name).toBe(NEGOCIO);
  });

  it("la CORRECCIÓN no es el camino del primer RIF: 422 que dice cuál es la puerta, y nada cambia", async () => {
    // Esa puerta no tiene por dónde recibir la razón social; en HEAD ponía el primer RIF sin ella.
    const r = await pedir("POST", "/v1/companies/tax-id/correct", DUENA, {
      tax_id: `J-66${D6}-1`,
      reason: "Probar que la corrección no pone el primer RIF",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain(
      "todavía no tiene RIF, así que no hay nada que corregir",
    );
    const c = await empresa();
    expect(c.tax_id.startsWith("PEND-")).toBe(true);
    expect(c.legal_name).toBe(NEGOCIO);
  });

  it("con la razón social: el RIF y la razón social quedan juntos, el nombre comercial no se toca, y hay acta", async () => {
    const r = await pedir("PUT", "/v1/companies/tax-id", DUENA, {
      tax_id: `J-66${D6}-1`,
      legal_name: RAZON,
    });
    expect(r.status).toBe(200);
    const c = await empresa();
    expect(c.tax_id).toBe(`J66${D6}1`);
    // Lo que la factura congela como razón social del emisor (sales.ts, snapshot del emisor).
    expect(c.legal_name).toBe(RAZON);
    expect(c.trade_name).toBe(NEGOCIO);
    const [acta] = await sql<
      { payload: { cambios: Record<string, { from: string; to: string }> } }[]
    >`
      select payload from public.audit_events
       where company_id = ${COMPANY} and event_type = 'company.profile_updated'
       order by occurred_at desc limit 1`;
    expect(acta?.payload.cambios["legal_name"]).toEqual({ from: NEGOCIO, to: RAZON });
  });

  it("ya con RIF, la razón social no entra por la puerta del RIF: 422 y nada cambia", async () => {
    const r = await pedir("PUT", "/v1/companies/tax-id", DUENA, {
      tax_id: `J-55${D6}-1`,
      legal_name: "Otra Razón, C.A.",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain(
      "La razón social se cambia en «Editar»",
    );
    const c = await empresa();
    expect(c.tax_id).toBe(`J66${D6}1`);
    expect(c.legal_name).toBe(RAZON);
  });
});

describe("A-04 · /v1/me/permissions dice los roles de sistema de la persona", () => {
  it("la fundadora es dueña y operación de almacén; no es contadora", async () => {
    const r = await pedir("GET", "/v1/me/permissions", DUENA);
    expect(r.status).toBe(200);
    const { roles } = (await r.json()) as { roles: string[] };
    expect([...roles].sort()).toEqual(["owner", "warehouse_ops"]);
  });

  it("el contador invitado lee «accountant», y solo eso", async () => {
    const alta = await pedir("POST", "/v1/members", DUENA, {
      company_id: COMPANY,
      email: CORREO_CONTADOR,
      role_key: "accountant",
    });
    expect(alta.status).toBe(201);
    const r = await pedir("GET", "/v1/me/permissions", CONTADOR);
    expect(r.status).toBe(200);
    const cuerpo = (await r.json()) as { roles: string[]; permissions: string[] };
    expect(cuerpo.roles).toEqual(["accountant"]);
    expect(cuerpo.permissions).toContain("accounting.read");
  });

  /**
   * Los joins de `roles` (routes/companies.ts) son una segunda copia de los de
   * `platform.ladino_user_permissions`. Si divergen, este test lo dice: los permisos que da la
   * función tienen que ser EXACTAMENTE los de los roles que la ruta devuelve.
   */
  it("los roles devueltos explican exactamente los permisos de la función, para el contador y para la dueña", async () => {
    for (const persona of [CONTADOR, DUENA]) {
      const r = await pedir("GET", "/v1/me/permissions", persona);
      const cuerpo = (await r.json()) as { roles: string[]; permissions: string[] };
      expect(cuerpo.roles.length).toBeGreaterThan(0);
      const deLosRoles = await sql<{ permission_key: string }[]>`
        select distinct rp.permission_key
          from public.role_permissions rp
          join public.roles ro on ro.id = rp.role_id
         where ro.tenant_id is null and ro.key = any(${cuerpo.roles})
         order by 1`;
      // Se ordenan los dos en JS: la colación de Postgres no ordena «.» y «_» como JS.
      expect([...cuerpo.permissions].sort()).toEqual(
        deLosRoles.map((f) => f.permission_key).sort(),
      );
    }
  });

  it("quien es de OTRO negocio no lee ni roles ni permisos de esta empresa: el 404 de siempre", async () => {
    // La extraña tiene su propio negocio (y ahí es dueña): con la cabecera de ESTA empresa, nada.
    const ajena = COMPANY;
    COMPANY = "";
    const alta = await pedir("POST", "/v1/onboarding", EXTRANA, {
      business_name: `Negocio ajeno ${RUN}`,
    });
    COMPANY = ajena;
    expect(alta.status).toBe(201);
    const r = await pedir("GET", "/v1/me/permissions", EXTRANA);
    expect(r.status).toBe(404);
    const cuerpo = (await r.json()) as { code: string; roles?: unknown; permissions?: unknown };
    expect(cuerpo.code).toBe("NOT_FOUND");
    expect(cuerpo.roles).toBeUndefined();
    expect(cuerpo.permissions).toBeUndefined();
  }, 30_000);
});

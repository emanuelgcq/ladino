import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * EL PRIMER DÍA REAL, de extremo a extremo (ADR-0049). Lo que ningún test
 * unitario ve: que un usuario RECIÉN REGISTRADO — sin tenant, sin membresía,
 * sin nada sembrado por SQL — funda su negocio por HTTP y sale del otro lado
 * pudiendo operar: permisos completos (par dueño+almacén con binding), plan
 * contable y plantillas importados, y su primer empleado agregado POR CORREO
 * con exactamente los permisos de su oficio.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";

const FUNDADOR = crypto.randomUUID();
const CAJERA = crypto.randomUUID();
const RUN = Date.now().toString(36);
const CORREO_CAJERA = `cajera-${RUN}@e2e.ladino`;

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

async function pedir(
  metodo: string,
  path: string,
  sub: string,
  body?: unknown,
  conEmpresa = true,
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await tokenDe(sub)}` };
  if (conEmpresa && COMPANY !== "") headers["X-Company-Id"] = COMPANY;
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

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  // Los DOS usuarios existen en auth (se registraron solos); NADA más se
  // siembra: ese es el punto del test.
  await sql`insert into auth.users (id, email) values
            (${FUNDADOR}, ${`fundador-${RUN}@e2e.ladino`}), (${CAJERA}, ${CORREO_CAJERA})
            on conflict (id) do nothing`;
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("onboarding y miembros de extremo a extremo", () => {
  it("un usuario recién registrado funda su negocio y sale pudiendo operar", async () => {
    const r = await pedir(
      "POST",
      "/v1/onboarding",
      FUNDADOR,
      { business_name: `Bodega Fundación ${RUN}` },
      false,
    );
    expect(r.status).toBe(201);
    const fundado = (await r.json()) as {
      tenant_id: string;
      company_id: string;
      warehouse_id: string;
    };
    COMPANY = fundado.company_id;

    // La empresa aparece en SU lista, con el placeholder honesto de RIF.
    const empresas = await pedir("GET", "/v1/companies", FUNDADOR, undefined, false);
    const lista = (await empresas.json()) as { id: string; tax_id: string }[];
    expect(lista.some((c) => c.id === COMPANY)).toBe(true);
    expect(lista.find((c) => c.id === COMPANY)!.tax_id.startsWith("PEND-")).toBe(true);

    // El par dueño+almacén: nivel tenant Y los verbos de almacén con binding.
    const permisos = await pedir("GET", "/v1/me/permissions", FUNDADOR);
    const { permissions } = (await permisos.json()) as { permissions: string[] };
    expect(permissions).toContain("company.manage");
    expect(permissions).toContain("membership.manage");
    expect(permissions).toContain("inventory.move");
    expect(permissions).toContain("sales.invoice.issue");

    // El plan contable y las plantillas de asiento quedaron importados: sin
    // esto, toda venta viviría en la cola contable para siempre.
    const cuentas = await pedir("GET", "/v1/accounts", FUNDADOR);
    expect(((await cuentas.json()) as unknown[]).length).toBeGreaterThan(0);
    const [plantillas] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.journal_templates
       where company_id = ${COMPANY}`;
    expect(plantillas!.n).toBeGreaterThan(0);

    // Y el depósito existe.
    const almacenes = await pedir("GET", "/v1/warehouses", FUNDADOR);
    const ws = (await almacenes.json()) as { id: string }[];
    expect(ws.some((w) => w.id === fundado.warehouse_id)).toBe(true);
  });

  it("fundar dos veces responde DUPLICATE: la idempotencia es estructural", async () => {
    const r = await pedir(
      "POST",
      "/v1/onboarding",
      FUNDADOR,
      { business_name: "Otra Bodega" },
      false,
    );
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("DUPLICATE");
  });

  it("la cajera se agrega POR CORREO y recibe exactamente su oficio", async () => {
    // Un correo sin cuenta: 404 con el mensaje que dice qué hacer.
    const fantasma = await pedir("POST", "/v1/members", FUNDADOR, {
      company_id: COMPANY,
      email: `nadie-${RUN}@e2e.ladino`,
      role_key: "cashier",
    });
    expect(fantasma.status).toBe(404);

    const alta = await pedir("POST", "/v1/members", FUNDADOR, {
      company_id: COMPANY,
      email: CORREO_CAJERA.toUpperCase(),
      role_key: "cashier",
    });
    expect(alta.status).toBe(201);
    const miembro = (await alta.json()) as {
      membership_id: string;
      assignments: { id: string; role_key: string }[];
    };
    expect(miembro.assignments.some((a) => a.role_key === "cashier")).toBe(true);

    // La cajera ve EXACTAMENTE sus 5 permisos: vende y cobra, no ve el dinero.
    const permisos = await pedir("GET", "/v1/me/permissions", CAJERA);
    const { permissions } = (await permisos.json()) as { permissions: string[] };
    expect(permissions.sort()).toEqual(
      [
        "ar.read",
        "customer.manage",
        "sales.invoice.issue",
        "sales.payment.register",
        "sales.quote.manage",
      ].sort(),
    );
    const resumen = await pedir("GET", "/v1/negocio/resumen", CAJERA);
    expect(resumen.status).toBe(403);

    // La lista de miembros la ve el dueño (membership.read); la cajera no.
    const miembros = await pedir("GET", "/v1/members", FUNDADOR);
    expect(miembros.status).toBe(200);
    const { members } = (await miembros.json()) as {
      members: { email: string | null; assignments: { id: string; role_key: string }[] }[];
    };
    expect(members.some((m) => m.email?.toLowerCase() === CORREO_CAJERA)).toBe(true);
    expect((await pedir("GET", "/v1/members", CAJERA)).status).toBe(403);
  });

  it("quitar el rol la deja sin permisos; desactivarla la saca del negocio; y el dueño no puede soltarse el timón", async () => {
    const miembros = await pedir("GET", "/v1/members", FUNDADOR);
    const { members } = (await miembros.json()) as {
      members: {
        membership_id: string;
        user_id: string;
        assignments: { id: string; role_key: string }[];
      }[];
    };
    const cajera = members.find((m) => m.user_id === CAJERA)!;
    const asignacion = cajera.assignments.find((a) => a.role_key === "cashier")!;

    const quitar = await pedir("DELETE", `/v1/members/assignments/${asignacion.id}`, FUNDADOR);
    expect(quitar.status).toBe(200);
    // Sin NINGUNA asignación, la empresa se vuelve INVISIBLE para ella — la
    // regla 404-antes-que-403 del catálogo de errores, aplicada al header.
    const sinRol = await pedir("GET", "/v1/me/permissions", CAJERA);
    expect(sinRol.status).toBe(404);

    const apagar = await pedir("PUT", `/v1/members/${cajera.membership_id}/status`, FUNDADOR, {
      company_id: COMPANY,
      status: "inactive",
    });
    expect(apagar.status).toBe(200);
    // Sin membresía activa, la empresa desaparece de su lista: el corte entero.
    const empresas = await pedir("GET", "/v1/companies", CAJERA, undefined, false);
    expect(((await empresas.json()) as { id: string }[]).some((c) => c.id === COMPANY)).toBe(false);

    // El timón: el dueño no se quita a sí mismo el rol de dueño.
    const fundador = members.find((m) => m.user_id === FUNDADOR)!;
    const suya = fundador.assignments.find((a) => a.role_key === "owner")!;
    const autogolpe = await pedir("DELETE", `/v1/members/assignments/${suya.id}`, FUNDADOR);
    expect(autogolpe.status).toBe(422);
  });
});

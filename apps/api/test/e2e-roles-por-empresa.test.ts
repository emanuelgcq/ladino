import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * LOS ROLES SON POR EMPRESA (ADR-0068 §3, hallazgo N-02), con DOS empresas en el mismo tenant.
 *
 * El Titular de la cuenta (el fundador, asignación de nivel tenant) funda A y crea B. Agrega a
 * un Dueño INVITADO a A (asignación acotada a A) y, con él como gestor acotado, se prueba:
 *   · la lista de personas de A no trae a quien solo está en B, ni las asignaciones de B;
 *   · al Titular no le quita un rol ni lo desactiva: 403 MEMBER_PROTECTED con su frase;
 *   · una asignación de B responde 404 ANTES que cualquier MEMBER_PROTECTED;
 *   · no desactiva a quien también tiene rol en B (403 MEMBER_PROTECTED), ni a quien no tiene
 *     rol en A (404), ni REACTIVA agregándolo a quien el Titular desactivó y trabaja en B;
 *   · sí desactiva a quien solo trabaja en A (control positivo: la guarda no es un «no» total);
 *   · recibe mercancía en su almacén por /v1/inventory/receipts, que solo concede
 *     `inventory.move` con su binding: el `warehouse_ops` acotado que ahora le da addMember.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const RUN = Date.now().toString(36);

const TITULAR = crypto.randomUUID();
const GESTOR = crypto.randomUUID();
/** Cajero en A y en B. */
const X = crypto.randomUUID();
/** Cajero solo en B. */
const Y = crypto.randomUUID();
/** Miembro sin ningún rol (se le quitó el único que tenía en A). */
const W = crypto.randomUUID();
/** Cajero solo en A: el que el gestor sí puede desactivar. */
const V = crypto.randomUUID();
const correo = (quien: string) => `${quien}-roles-empresa-${RUN}@e2e.ladino`;

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let A = "";
let B = "";
let DEPOSITO_A = "";
let PRODUCTO_A = "";

interface Miembro {
  membership_id: string;
  user_id: string;
  status: string;
  assignments: { id: string; role_key: string; company_id: string | null }[];
}

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
  empresa: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await tokenDe(sub)}` };
  if (empresa !== "") headers["X-Company-Id"] = empresa;
  if (metodo !== "GET" && path !== "/v1/onboarding") {
    headers["Idempotency-Key"] = crypto.randomUUID();
  }
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

async function miembrosSegun(sub: string): Promise<Miembro[]> {
  const r = await pedir("GET", "/v1/members", sub, A);
  expect(r.status).toBe(200);
  return ((await r.json()) as { members: Miembro[] }).members;
}

async function estadoDe(usuario: string): Promise<string | undefined> {
  const [m] = await sql<{ status: string }[]>`
    select m.status from public.memberships m
      join public.companies c on c.tenant_id = m.tenant_id
     where c.id = ${A} and m.user_id = ${usuario}`;
  return m?.status;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  for (const [id, quien] of [
    [TITULAR, "titular"],
    [GESTOR, "gestor"],
    [X, "x"],
    [Y, "y"],
    [W, "w"],
    [V, "v"],
  ] as const) {
    await sql`insert into auth.users (id, email) values (${id}, ${correo(quien)})
              on conflict (id) do nothing`;
  }
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("los roles son por empresa: dos empresas en el mismo tenant", () => {
  it("el Titular funda A, crea B y reparte los roles", async () => {
    const f = await pedir("POST", "/v1/onboarding", TITULAR, "", {
      business_name: `Roles por empresa ${RUN}`,
    });
    expect(f.status).toBe(201);
    const fundado = (await f.json()) as { company_id: string; warehouse_id: string };
    A = fundado.company_id;
    DEPOSITO_A = fundado.warehouse_id;

    const [t] = await sql<{ tenant_id: string }[]>`
      select tenant_id from public.companies where id = ${A}`;
    const b = await pedir("POST", "/v1/companies", TITULAR, A, {
      tenant_id: t!.tenant_id,
      legal_name: `Empresa B ${RUN}, C.A.`,
      tax_id: `J-66${RUN.slice(-6)
        .replace(/[^0-9]/g, "6")
        .padStart(6, "6")}-2`,
    });
    expect(b.status).toBe(201);
    B = ((await b.json()) as { id: string }).id;

    const p = await pedir("POST", "/v1/products/simple", TITULAR, A, {
      company_id: A,
      name: `Producto roles ${RUN}`,
      price: { amount: "2", currency: "USD" },
    });
    expect(p.status).toBe(201);
    PRODUCTO_A = ((await p.json()) as { product: { id: string } }).product.id;

    for (const [empresa, quien, rol] of [
      [A, "gestor", "owner"],
      [A, "x", "cashier"],
      [B, "x", "cashier"],
      [B, "y", "cashier"],
      [A, "w", "cashier"],
      [A, "v", "cashier"],
    ] as const) {
      const r = await pedir("POST", "/v1/members", TITULAR, empresa, {
        company_id: empresa,
        email: correo(quien),
        role_key: rol,
      });
      expect(r.status).toBe(201);
    }
    // W se queda sin ningún rol: miembro de la cuenta, de ninguna empresa.
    const w = (await miembrosSegun(TITULAR)).find((m) => m.user_id === W)!;
    const quitar = await pedir(
      "DELETE",
      `/v1/members/assignments/${w.assignments[0]!.id}`,
      TITULAR,
      A,
    );
    expect(quitar.status).toBe(200);
  }, 30_000);

  it("la lista del gestor de A no trae a quien solo está en B ni las asignaciones de B", async () => {
    const lista = await miembrosSegun(GESTOR);
    const ids = new Set(lista.map((m) => m.user_id));
    expect(ids.has(TITULAR)).toBe(true);
    expect(ids.has(X)).toBe(true);
    expect(ids.has(Y)).toBe(false);
    for (const m of lista) {
      expect(m.assignments.some((a) => a.company_id === B)).toBe(false);
    }
  });

  it("al Titular no le quita un rol: 403 MEMBER_PROTECTED con su frase", async () => {
    const titular = (await miembrosSegun(TITULAR)).find((m) => m.user_id === TITULAR)!;
    const deCuenta = titular.assignments.find((a) => a.company_id === null)!;
    const r = await pedir("DELETE", `/v1/members/assignments/${deCuenta.id}`, GESTOR, A);
    expect(r.status).toBe(403);
    const cuerpo = (await r.json()) as { code: string; person_message: string };
    expect(cuerpo.code).toBe("MEMBER_PROTECTED");
    expect(cuerpo.person_message).toBe(
      "Esa persona es el Titular de la cuenta: sus roles y su acceso solo los cambia el propio Titular.",
    );
  });

  it("al Titular no lo desactiva: 403 MEMBER_PROTECTED", async () => {
    const titular = (await miembrosSegun(TITULAR)).find((m) => m.user_id === TITULAR)!;
    const r = await pedir("PUT", `/v1/members/${titular.membership_id}/status`, GESTOR, A, {
      company_id: A,
      status: "inactive",
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { code: string }).code).toBe("MEMBER_PROTECTED");
    expect(await estadoDe(TITULAR)).toBe("active");
  });

  it("una asignación de B responde 404, antes que cualquier MEMBER_PROTECTED", async () => {
    // Una asignación del TITULAR acotada a B: la única que podría dar MEMBER_PROTECTED y 404 a la
    // vez. Con otra persona el test pasaría aunque el orden se invirtiera (F4, revisor de la ola 1).
    const alta = await pedir("POST", "/v1/members", TITULAR, B, {
      company_id: B,
      email: correo("titular"),
      role_key: "accountant",
    });
    expect(alta.status).toBe(201);
    const titular = (await miembrosSegun(TITULAR)).find((m) => m.user_id === TITULAR)!;
    const deB = titular.assignments.find((a) => a.company_id === B)!;
    const r = await pedir("DELETE", `/v1/members/assignments/${deB.id}`, GESTOR, A);
    expect(r.status).toBe(404);
    const [sigue] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.user_role_assignments where id = ${deB.id}`;
    expect(sigue?.n).toBe(1);
  });

  it("no desactiva a quien también tiene rol en B: 403 MEMBER_PROTECTED", async () => {
    const x = (await miembrosSegun(TITULAR)).find((m) => m.user_id === X)!;
    const r = await pedir("PUT", `/v1/members/${x.membership_id}/status`, GESTOR, A, {
      company_id: A,
      status: "inactive",
    });
    expect(r.status).toBe(403);
    const cuerpo = (await r.json()) as { code: string; person_message: string };
    expect(cuerpo.code).toBe("MEMBER_PROTECTED");
    expect(cuerpo.person_message).toContain("también trabaja en otra empresa");
    expect(await estadoDe(X)).toBe("active");
  });

  it("no desactiva a quien no tiene rol en A: 404 (sin rol, o solo en B)", async () => {
    const todos = await miembrosSegun(TITULAR);
    for (const quien of [W, Y]) {
      const m = todos.find((x) => x.user_id === quien)!;
      const r = await pedir("PUT", `/v1/members/${m.membership_id}/status`, GESTOR, A, {
        company_id: A,
        status: "inactive",
      });
      expect(r.status).toBe(404);
      expect(await estadoDe(quien)).toBe("active");
    }
  });

  it("no REACTIVA agregándolo a quien el Titular desactivó y trabaja en B: 403 MEMBER_PROTECTED", async () => {
    const x = (await miembrosSegun(TITULAR)).find((m) => m.user_id === X)!;
    const apagar = await pedir("PUT", `/v1/members/${x.membership_id}/status`, TITULAR, A, {
      company_id: A,
      status: "inactive",
    });
    expect(apagar.status).toBe(200);

    // Un rol que X NO tiene en A: así el único motivo de rechazo posible es la guarda (con
    // «cashier», el índice único de la asignación daría 409 y el test pasaría por otra razón).
    const r = await pedir("POST", "/v1/members", GESTOR, A, {
      company_id: A,
      email: correo("x"),
      role_key: "accountant",
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { code: string }).code).toBe("MEMBER_PROTECTED");
    expect(await estadoDe(X)).toBe("inactive");
  });

  it("control positivo: desactiva a quien solo trabaja en A", async () => {
    const v = (await miembrosSegun(GESTOR)).find((m) => m.user_id === V)!;
    const r = await pedir("PUT", `/v1/members/${v.membership_id}/status`, GESTOR, A, {
      company_id: A,
      status: "inactive",
    });
    expect(r.status).toBe(200);
    expect(await estadoDe(V)).toBe("inactive");
  });

  it("el Dueño invitado recibe mercancía en su almacén (warehouse_ops acotado de addMember)", async () => {
    const r = await pedir("POST", "/v1/inventory/receipts", GESTOR, A, {
      origin: "aporte",
      company_id: A,
      warehouse_id: DEPOSITO_A,
      product_id: PRODUCTO_A,
      quantity: "4",
      amount: "400",
      currency: "VES",
    });
    expect(r.status).toBe(201);
    const [mov] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.inventory_moves
       where company_id = ${A} and product_id = ${PRODUCTO_A} and kind = 'entrada'`;
    expect(mov?.n).toBeGreaterThan(0);
  });
});

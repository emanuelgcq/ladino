import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * PERMISOS QUE TERMINAN EN VERDE (ola 3 del recorrido 2026-09-24; ADR-0068 §7 y §8).
 *
 * Una empresa sin RIF fundada por un dueño real y cuatro personas agregadas con su rol de sistema:
 * encargado, cajero, almacenista y administrativo. Cada caso asevera lo que puede el oficio y lo
 * que no, por el camino real de la API, y lo que SOLO produce el arreglo:
 *   · J-03: el cierre de caja solo acepta cajas. El encargado no ve el banco (404, sin saldo en el
 *     mensaje); el dueño, que sí lo ve, recibe «solo se cierran cajas» sin el saldo; el encargado
 *     cierra SU caja (201);
 *   · P-04: la deuda de cada cliente se lee con `ar.read`: el cajero la recibe, el almacenista
 *     recibe 403 con el permiso en palabras de persona;
 *   · O-03: las altas de personas, roles y alcances guardan su autor en la fila;
 *   · N-10: quitar un rol queda en el historial de la MEMBRESÍA, y reactivar desde «Agregar
 *     persona» deja su acta;
 *   · A-07 / C-09: un 403 (o un 404) del logo o de la foto no deja objetos en el almacenamiento;
 *   · A-14: el logo se guarda por su contenido: el mismo archivo es la misma ruta, otro archivo es
 *     otra, y la anterior se conserva.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const RUN = Date.now().toString(36);

const DUENO = crypto.randomUUID();
const ENCARGADO = crypto.randomUUID();
const CAJERO = crypto.randomUUID();
const ALMACENISTA = crypto.randomUUID();
const ADMINISTRATIVO = crypto.randomUUID();

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let COMPANY = "";
let CAJA = "";
let BANCO = "";
/** A-14: la primera versión del logo (queda vieja) y la vigente. */
let LOGO_VIEJO = "";
let LOGO_VIGENTE = "";
let SERVICE_KEY = "";

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

async function subirImagen(ruta: string, sub: string, color: string): Promise<Response> {
  const { default: sharp } = await import("sharp");
  const png = await sharp({ create: { width: 120, height: 120, channels: 4, background: color } })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append("file", new File([new Uint8Array(png)], "imagen.png", { type: "image/png" }));
  return app.request(ruta, {
    method: "POST",
    headers: { Authorization: `Bearer ${await tokenDe(sub)}`, "X-Company-Id": COMPANY },
    body: form,
  });
}

/** Objetos del almacenamiento bajo el prefijo de la empresa, en los dos buckets. */
async function objetosDeLaEmpresa(): Promise<number> {
  const [f] = await sql<{ n: number }[]>`
    select count(*)::int as n from storage.objects
     where bucket_id in ('company-logos', 'product-images') and name like ${`${COMPANY}/%`}`;
  return f!.n;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  const serviceKey = await new SignJWT({ role: "service_role" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("supabase-demo")
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(JWT_SECRET);
  app = buildApp({
    sql: sqlApi,
    auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER },
    storage: { url: "http://127.0.0.1:54321/storage/v1", serviceKey },
  });
  SERVICE_KEY = serviceKey;
  await sql`insert into auth.users (id, email) values
            (${DUENO}, ${`dueno-verde-${RUN}@e2e.ladino`}),
            (${ENCARGADO}, ${`encargado-verde-${RUN}@e2e.ladino`}),
            (${CAJERO}, ${`cajero-verde-${RUN}@e2e.ladino`}),
            (${ALMACENISTA}, ${`almacenista-verde-${RUN}@e2e.ladino`}),
            (${ADMINISTRATIVO}, ${`administrativo-verde-${RUN}@e2e.ladino`})
            on conflict (id) do nothing`;
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("permisos que terminan en verde", { timeout: 30_000 }, () => {
  it("el dueño funda (sin RIF), crea una caja y un banco, y agrega a cuatro personas", async () => {
    const r = await pedir("POST", "/v1/onboarding", DUENO, {
      business_name: `Bodega Verde ${RUN}`,
    });
    expect(r.status).toBe(201);
    COMPANY = ((await r.json()) as { company_id: string }).company_id;

    for (const [nombre, kind] of [
      ["Caja verde", "cash"],
      ["Banco verde", "bank"],
    ] as const) {
      const c = await pedir("POST", "/v1/treasury/accounts", DUENO, {
        company_id: COMPANY,
        name: nombre,
        currency: "VES",
        kind,
      });
      expect(c.status).toBe(201);
      const id = ((await c.json()) as { id: string }).id;
      if (kind === "cash") CAJA = id;
      else BANCO = id;
    }

    for (const [rol, sub, correo] of [
      ["store_manager", ENCARGADO, `encargado-verde-${RUN}@e2e.ladino`],
      ["cashier", CAJERO, `cajero-verde-${RUN}@e2e.ladino`],
      ["warehouse_ops", ALMACENISTA, `almacenista-verde-${RUN}@e2e.ladino`],
      ["back_office", ADMINISTRATIVO, `administrativo-verde-${RUN}@e2e.ladino`],
    ] as const) {
      void sub;
      const a = await pedir("POST", "/v1/members", DUENO, {
        company_id: COMPANY,
        email: correo,
        role_key: rol,
      });
      expect(a.status).toBe(201);
    }
  });

  // ── J-03 ──────────────────────────────────────────────────────────────────
  it("J-03: el encargado no cierra el banco ni lee su saldo (404, sin «esperaba»)", async () => {
    const r = await pedir("POST", "/v1/cash-closings", ENCARGADO, {
      company_id: COMPANY,
      account_id: BANCO,
      counted_amount: "5.00",
    });
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(r.status).toBe(404);
    expect(cuerpo.code).toBe("NOT_FOUND");
    expect(cuerpo.message).not.toContain("esperaba");
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.cash_closings where account_id = ${BANCO}`;
    expect(n!.n).toBe(0);
  });

  it("J-03: el dueño, que sí ve el banco, recibe «solo se cierran cajas» sin el saldo", async () => {
    const r = await pedir("POST", "/v1/cash-closings", DUENO, {
      company_id: COMPANY,
      account_id: BANCO,
      counted_amount: "5.00",
      reason: "Probando si el banco se cierra como una caja",
    });
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(r.status).toBe(422);
    expect(cuerpo.message).toContain("Solo se cierran cajas");
    expect(cuerpo.message).not.toContain("esperaba");
  });

  it("J-03: el encargado cierra SU caja (lo que sí puede)", async () => {
    const r = await pedir("POST", "/v1/cash-closings", ENCARGADO, {
      company_id: COMPANY,
      account_id: CAJA,
      counted_amount: "0.00",
    });
    expect(r.status).toBe(201);
  });

  // ── P-04 ──────────────────────────────────────────────────────────────────
  it("P-04: el cajero recibe la deuda de cada cliente (ar.read, para fiar)", async () => {
    const r = await pedir("GET", "/v1/customers?with_debt=1", CAJERO);
    expect(r.status).toBe(200);
    const { items } = (await r.json()) as { items: Record<string, unknown>[] };
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => typeof i["debt"] === "string")).toBe(true);
  });

  it("P-04: el almacenista no recibe la deuda: 403 con el permiso en palabras", async () => {
    const r = await pedir("GET", "/v1/customers?with_debt=1", ALMACENISTA);
    const cuerpo = (await r.json()) as { code: string; message: string; person_message: string };
    expect(r.status).toBe(403);
    expect(cuerpo.message).toContain("ar.read");
    expect(cuerpo.person_message).toBe(
      "Necesitas el permiso para ver lo que deben los clientes. Pídeselo a quien administra el negocio.",
    );
  });

  // ── O-03 ──────────────────────────────────────────────────────────────────
  it("O-03: la membresía, la asignación y sus alcances guardan quién los dio de alta", async () => {
    const filas = await sql<{ tabla: string; sin_autor: number; total: number }[]>`
      select 'memberships' as tabla,
             count(*) filter (where m.created_by is distinct from ${DUENO})::int as sin_autor,
             count(*)::int as total
        from public.memberships m
       where m.user_id in (${ENCARGADO}, ${CAJERO}, ${ALMACENISTA}, ${ADMINISTRATIVO})
      union all
      select 'user_role_assignments',
             count(*) filter (where u.created_by is distinct from ${DUENO})::int, count(*)::int
        from public.user_role_assignments u
       where u.company_id = ${COMPANY}
      union all
      select 'scope_bindings',
             count(*) filter (where s.created_by is distinct from ${DUENO})::int, count(*)::int
        from public.scope_bindings s
        join public.user_role_assignments u on u.id = s.assignment_id
       where u.company_id = ${COMPANY}`;
    for (const f of filas) {
      expect(f.total, `${f.tabla} sin filas`).toBeGreaterThan(0);
      expect(f.sin_autor, `${f.tabla}: filas sin el dueño como autor`).toBe(0);
    }
  });

  // ── N-10 ──────────────────────────────────────────────────────────────────
  it("N-10: quitar un rol queda en el historial de la membresía; reactivar al agregar deja acta", async () => {
    const [asig] = await sql<{ id: string; membership_id: string }[]>`
      select u.id, u.membership_id from public.user_role_assignments u
        join public.memberships m on m.id = u.membership_id
       where m.user_id = ${ALMACENISTA} and u.company_id = ${COMPANY}`;
    const quitar = await pedir(
      "DELETE",
      `/v1/members/assignments/${asig!.id}?company_id=${COMPANY}`,
      DUENO,
    );
    expect(quitar.status).toBe(200);
    const [revocado] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where event_type = 'member.role_revoked' and aggregate_type = 'membership'
         and aggregate_id = ${asig!.membership_id}`;
    expect(revocado!.n).toBe(1);

    const apagar = await pedir("PUT", `/v1/members/${asig!.membership_id}/status`, DUENO, {
      company_id: COMPANY,
      status: "inactive",
    });
    expect(apagar.status).toBe(200);
    const volver = await pedir("POST", "/v1/members", DUENO, {
      company_id: COMPANY,
      email: `almacenista-verde-${RUN}@e2e.ladino`,
      role_key: "warehouse_ops",
    });
    expect(volver.status).toBe(201);
    const [reactivado] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where event_type = 'member.reactivated' and aggregate_id = ${asig!.membership_id}`;
    expect(reactivado!.n).toBe(1);
  });

  // ── A-07 / C-09 ───────────────────────────────────────────────────────────
  it("A-07: el logo de un cajero da 403 y no deja nada en el almacenamiento", async () => {
    const antes = await objetosDeLaEmpresa();
    const r = await subirImagen("/v1/companies/logo", CAJERO, "#aa3300");
    expect(r.status).toBe(403);
    expect(await objetosDeLaEmpresa()).toBe(antes);
  });

  it("C-09: la foto de un cajero (403) o de un producto inventado (404) no deja objetos", async () => {
    const antes = await objetosDeLaEmpresa();
    const inventado = crypto.randomUUID();
    const cajero = await subirImagen(`/v1/products/${inventado}/image`, CAJERO, "#0033aa");
    expect(cajero.status).toBe(403);
    const dueno = await subirImagen(`/v1/products/${inventado}/image`, DUENO, "#0033aa");
    expect(dueno.status).toBe(404);
    expect(await objetosDeLaEmpresa()).toBe(antes);
  });

  // ── A-14 ──────────────────────────────────────────────────────────────────
  it("A-14: el logo se guarda por su contenido y la versión anterior se conserva", async () => {
    const primera = await subirImagen("/v1/companies/logo", DUENO, "#117711");
    expect(primera.status).toBe(201);
    const { logo_path: p1 } = (await primera.json()) as { logo_path: string };
    const tras1 = await objetosDeLaEmpresa();

    // El MISMO archivo otra vez: la misma ruta, ni un objeto nuevo.
    const repetida = await subirImagen("/v1/companies/logo", DUENO, "#117711");
    expect(repetida.status).toBe(201);
    const { logo_path: p2 } = (await repetida.json()) as { logo_path: string };
    expect(p2).toBe(p1);
    expect(await objetosDeLaEmpresa()).toBe(tras1);

    // Otro archivo: otra ruta, y la anterior sigue ahí hasta que la purga la tome (30 días desde que
    // quedó huérfana). El PDF usa siempre el logo VIGENTE (ADR-0068 §9): no hay versión congelada.
    const otra = await subirImagen("/v1/companies/logo", DUENO, "#771111");
    const { logo_path: p3 } = (await otra.json()) as { logo_path: string };
    expect(p3).not.toBe(p1);
    expect(p3.startsWith(`${COMPANY}/logo/`)).toBe(true);
    const [sigue] = await sql<{ n: number }[]>`
      select count(*)::int as n from storage.objects
       where bucket_id = 'company-logos' and name = ${p1}`;
    expect(sigue!.n).toBe(1);
    LOGO_VIEJO = p1;
    LOGO_VIGENTE = p3;
  });

  it("A-14: la gracia de 30 días cuenta desde que el logo QUEDA huérfano, no desde que nace", async () => {
    const carpeta = (p: string) => p.replace(/\/[^/]+$/, "/");
    // `p_at` es el reloj de la función: «dentro de N días» sin tocar el acta, que es append-only.
    const purgables = async (dentroDeDias = 0) =>
      sql.begin(async (tx) => {
        await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
        const filas = await tx<{ object_name: string }[]>`
          select object_name from platform.company_logo_purgeable(
            ${COMPANY}, interval '30 days', now() + make_interval(days => ${dentroDeDias}))`;
        return filas.map((f) => f.object_name);
      });
    expect(await purgables()).toEqual([]);

    // Los objetos nacieron hace 31 días, pero la versión vieja quedó huérfana HOY (la reemplazó la
    // vigente en el caso anterior): todavía no se purga.
    await sql`
      update storage.objects set created_at = now() - interval '31 days'
       where bucket_id = 'company-logos' and name like ${`${COMPANY}/logo/%`}`;
    expect(await purgables()).toEqual([]);

    // Treinta y un días después del reemplazo: la vieja sí; la vigente nunca.
    const lista = await purgables(31);
    expect(lista.length).toBe(3);
    expect(lista.every((n) => n.startsWith(carpeta(LOGO_VIEJO)))).toBe(true);
    expect(lista.some((n) => n.startsWith(carpeta(LOGO_VIGENTE)))).toBe(false);
  });

  it("A-14: el logo nuevo purga por Storage la huérfana vencida y conserva la recién reemplazada", async () => {
    // Una versión que se subió y nunca quedó puesta (la subida murió antes de guardarse), de hace
    // 31 días: huérfana desde que nació.
    const huerfana = `${COMPANY}/logo/nunca-puesta/logo-256.webp`;
    const subida = await fetch(
      `http://127.0.0.1:54321/storage/v1/object/company-logos/${huerfana}`,
      {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "image/webp",
          "x-upsert": "true",
        },
        body: new Uint8Array([1, 2, 3]),
      },
    );
    expect(subida.ok).toBe(true);
    await sql`
      update storage.objects set created_at = now() - interval '31 days'
       where bucket_id = 'company-logos' and name = ${huerfana}`;

    const nueva = await subirImagen("/v1/companies/logo", DUENO, "#222222");
    expect(nueva.status).toBe(201);
    const carpeta = (p: string) => p.replace(/\/[^/]+$/, "/");
    const [quedan] = await sql<{ huerfana: number; vieja: number; reemplazada: number }[]>`
      select count(*) filter (where name = ${huerfana})::int as huerfana,
             count(*) filter (where name like ${`${carpeta(LOGO_VIEJO)}%`})::int as vieja,
             count(*) filter (where name like ${`${carpeta(LOGO_VIGENTE)}%`})::int as reemplazada
        from storage.objects where bucket_id = 'company-logos'`;
    expect(quedan!.huerfana).toBe(0);
    expect(quedan!.vieja).toBe(3);
    expect(quedan!.reemplazada).toBe(3);
  });

  // ── H6 (revisión): el aviso de sobregiro no revela el saldo a quien no ve el dinero ──────────
  it("sobregiro: sin treasury.read el aviso no dice el saldo; con él, sí", async () => {
    const PAGADOR = crypto.randomUUID();
    await sql`insert into auth.users (id, email) values (${PAGADOR}, ${`pagador-verde-${RUN}@e2e.ladino`})`;
    await sql.begin(async (tx) => {
      const [t] = await tx<
        { tenant_id: string }[]
      >`select tenant_id from public.companies where id = ${COMPANY}`;
      const [rol] = await tx<{ id: string }[]>`
        insert into public.roles (tenant_id, key, name, requires_scope)
        values (${t!.tenant_id}, ${`pagador_${RUN}`}, 'Pagador sin ver el dinero', false) returning id`;
      await tx`insert into public.role_permissions (role_id, permission_key, tenant_id)
               values (${rol!.id}, 'expense.register', ${t!.tenant_id})`;
      const [m] = await tx<{ id: string }[]>`
        insert into public.memberships (tenant_id, user_id) values (${t!.tenant_id}, ${PAGADOR}) returning id`;
      await tx`insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
               values (${t!.tenant_id}, ${m!.id}, ${rol!.id}, ${COMPANY})`;
    });
    const gasto = {
      company_id: COMPANY,
      category: "Transporte",
      account_id: CAJA,
      amount: "999999.00",
    };
    const sinVer = await pedir("POST", "/v1/expenses", PAGADOR, gasto);
    const a = (await sinVer.json()) as { code: string; message: string };
    expect(a.code).toBe("INSUFFICIENT_FUNDS");
    expect(a.message).not.toMatch(/ tiene /);
    const dueno = await pedir("POST", "/v1/expenses", DUENO, gasto);
    const b = (await dueno.json()) as { code: string; message: string };
    expect(b.code).toBe("INSUFFICIENT_FUNDS");
    expect(b.message).toMatch(/ tiene /);
  });
});

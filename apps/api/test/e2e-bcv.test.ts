import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * El adaptador BCV de extremo a extremo, contra un MOCK local de DolarAPI:
 * la tasa llega EXACTA (string, jamás float), con el día PUBLICADO por la
 * fuente y la fuente citada; sin permiso es 403 sin tocar la red; y con la
 * fuente caída es un 502 limpio cuyo fallback es la carga manual de siempre.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const TENANT = crypto.randomUUID();
const COMPANY = crypto.randomUUID();
const CAJERO = crypto.randomUUID();
const MIRON = crypto.randomUUID();
const ROL_CAJA = crypto.randomUUID();
const ROL_MIRON = crypto.randomUUID();
const RUN = Date.now().toString(36);

/** La respuesta real de DolarAPI del 2026-09-02, con una tasa reconocible. */
const CUERPO_MOCK = `{
  "moneda": "USD",
  "fuente": "oficial",
  "nombre": "Dólar",
  "compra": null,
  "venta": null,
  "promedio": 801.1752,
  "fechaActualizacion": "2026-09-02T00:00:00-04:00"
}`;

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let mock: Server;
let mockUrl = "";
let peticionesAlMock = 0;

const tokenDe = (sub: string) =>
  new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);

async function pedir(sub: string, app_ = app): Promise<Response> {
  return app_.request("/v1/exchange-rates/bcv", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await tokenDe(sub)}`,
      "X-Company-Id": COMPANY,
      "Idempotency-Key": crypto.randomUUID(),
    },
  });
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  mock = createServer((req, res) => {
    peticionesAlMock += 1;
    if (req.url === "/v1/dolares/oficial") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(CUERPO_MOCK);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const dir = mock.address();
  if (dir === null || typeof dir === "string") throw new Error("mock sin puerto");
  mockUrl = `http://127.0.0.1:${dir.port}`;
  app = buildApp({
    sql: sqlApi,
    auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER },
    bcv: { url: mockUrl },
  });

  // `exchange_rates` es global y sobrevive entre corridas; el mock publica la
  // misma fecha que la fuente real, así que un smoke previo dejaría la fila y
  // el primer insert daría 200 en vez de 201. Se barre SOLO la fuente del
  // adaptador — el espacio de nombres de esta suite.
  await sql`delete from public.exchange_rates where source like 'BCV oficial vía DolarAPI%'`;
  await sql`insert into auth.users (id) values (${CAJERO}), (${MIRON})
            on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${CAJERO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e bcv')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name)
             values (${COMPANY}, ${TENANT}, ${`J-E2EBCV-${RUN}`}, 'Empresa e2e bcv')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL_CAJA}, null, ${`e2ebcv_caja_${RUN}`}, 'Caja', false),
             (${ROL_MIRON}, null, ${`e2ebcv_miron_${RUN}`}, 'Mirón', false)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL_CAJA}, 'fx.rate.manage')`;
    const memCaja = crypto.randomUUID();
    const memMiron = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${memCaja}, ${TENANT}, ${CAJERO}),
             (${memMiron}, ${TENANT}, ${MIRON})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${crypto.randomUUID()}, ${TENANT}, ${memCaja}, ${ROL_CAJA}, null),
             (${crypto.randomUUID()}, ${TENANT}, ${memMiron}, ${ROL_MIRON}, ${COMPANY})`;
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  await sql?.end();
  await sqlApi?.end();
});

describe("el adaptador BCV", () => {
  it("sin permiso es 403 y NO toca la red", async () => {
    const antes = peticionesAlMock;
    const r = await pedir(MIRON);
    expect(r.status).toBe(403);
    expect(peticionesAlMock).toBe(antes);
  });

  it("trae la tasa EXACTA, con el día publicado y la fuente citada", async () => {
    const r = await pedir(CAJERO);
    expect(r.status).toBe(201);
    const cuerpo = (await r.json()) as {
      rate: string;
      rate_date: string;
      source: string;
      from_currency: string;
      to_currency: string;
    };
    // El string EXACTO del cuerpo del mock: si esto dijera "801.17520000" ya
    // habría pasado por el numeric — bien; lo que jamás debe verse es un
    // 801.17519999… de float.
    expect(cuerpo.rate).toBe("801.17520000");
    expect(cuerpo.rate_date).toBe("2026-09-02");
    expect(cuerpo.from_currency).toBe("USD");
    expect(cuerpo.to_currency).toBe("VES");
    expect(cuerpo.source).toContain("BCV oficial vía DolarAPI");
    expect(cuerpo.source).toContain("2026-09-02T00:00:00-04:00");

    const [fila] = await sql<{ rate: string }[]>`
      select rate::text as rate from public.exchange_rates
       where source like 'BCV oficial vía DolarAPI%' order by created_at desc limit 1`;
    expect(fila?.rate).toBe("801.17520000");

    // La MISMA publicación otra vez es UN hecho: 200 con la fila que ya está,
    // no un 409 que asuste al cajero ni una fila duplicada.
    const replay = await pedir(CAJERO);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { rate: string }).rate).toBe("801.17520000");
    const [conteo] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.exchange_rates
       where source = ${"BCV oficial vía DolarAPI (2026-09-02T00:00:00-04:00)"}
         and rate_date = '2026-09-02'`;
    expect(conteo!.n).toBe("1");
  });

  it("con la fuente caída: 502 UPSTREAM_UNAVAILABLE, y el fallback manual queda dicho", async () => {
    const caido = buildApp({
      sql: sqlApi,
      auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER },
      // Un puerto sin nadie escuchando: la red falla rápido.
      bcv: { url: "http://127.0.0.1:9" },
    });
    const r = await pedir(CAJERO, caido);
    expect(r.status).toBe(502);
    const cuerpo = (await r.json()) as { code: string; person_message: string };
    expect(cuerpo.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(cuerpo.person_message).toContain("a mano");
  });

  it("sin adaptador configurado también es 502, no un 500 mudo", async () => {
    const sinBcv = buildApp({
      sql: sqlApi,
      auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER },
    });
    const r = await pedir(CAJERO, sinBcv);
    expect(r.status).toBe(502);
  });
});

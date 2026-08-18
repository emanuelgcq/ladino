import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { createClient } from "@ladino/db";
import { idempotencyMiddleware } from "../src/middleware/idempotency.js";
import type { RequestContext } from "../src/middleware/context.js";
import type { AuthResult } from "../src/middleware/auth.js";

/**
 * Integración contra la base LOCAL, por el mismo camino que producción: el
 * middleware real, la tabla real, los CHECK reales. Un test que simulara la
 * tabla probaría el middleware contra un esquema imaginario.
 *
 * El caso que gobierna el fichero es el 4: DOS ACTORES, MISMA CLAVE. Es la
 * fuga que ALTO-3 encontró en S0.4 —el segundo usuario recibía la respuesta
 * del primero con un 200— y la razón de que el lookup filtre por actor.
 */

const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const TENANT = "ffffffff-ffff-4fff-8fff-000000000001";
const COMPANY = "ffffffff-ffff-4fff-8fff-000000000002";
const USUARIO_A = "ffffffff-ffff-4fff-8fff-00000000000a";
const USUARIO_B = "ffffffff-ffff-4fff-8fff-00000000000b";

let sql: ReturnType<typeof createClient>;
let ejecuciones: number;

function appPara(userId: string): Hono {
  const app = new Hono();
  // Stub de auth y contexto: este fichero prueba idempotencia, no el JWT — el
  // JWT tiene su propio fichero. El middleware real lee estas dos claves.
  app.use("*", async (c, next) => {
    const auth: AuthResult = { actor: { kind: "user", userId }, userId };
    const ctx: RequestContext = {
      requestId: "req-test",
      actor: auth.actor,
      userId,
      companyId: COMPANY,
      tenantId: TENANT,
      idempotencyKey: c.req.header("Idempotency-Key") ?? null,
    };
    c.set("ladino.auth", auth);
    c.set("ladino.ctx", ctx);
    await next();
  });
  app.use("/v1/cosas", idempotencyMiddleware({ sql }));
  app.post("/v1/cosas", async (c) => {
    ejecuciones += 1;
    const body = await c.req.json<{ nombre: string }>();
    return c.json({ id: "cosa-1", nombre: body.nombre, ejecucion: ejecuciones }, 201);
  });
  return app;
}

function pedir(app: Hono, key: string | null, cuerpo: object) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Idempotency-Key"] = key;
  return app.request("/v1/cosas", { method: "POST", headers, body: JSON.stringify(cuerpo) });
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  await sql`delete from public.idempotency_keys where tenant_id = ${TENANT}`;
  await sql`insert into auth.users (id) values (${USUARIO_A}), (${USUARIO_B}) on conflict (id) do nothing`;
  // Tenant y company se REUTILIZAN entre corridas, no se borran: desde la
  // migración 5/5, crear una company deja su evento en audit_events, y
  // `audit_events_company_fk` es NO ACTION — una company con auditoría no se
  // puede borrar, a propósito (F-9: conservación). Es la misma lección que el
  // script de concurrencia: se adapta el sembrado, no la restricción.
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${USUARIO_A}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant idem')
             on conflict (id) do nothing`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name)
             values (${COMPANY}, ${TENANT}, 'J-IDEM', 'Empresa idem')
             on conflict (id) do nothing`;
  });
});

afterAll(async () => {
  await sql`delete from public.idempotency_keys where tenant_id = ${TENANT}`;
  await sql.end();
});

beforeEach(async () => {
  ejecuciones = 0;
  await sql`delete from public.idempotency_keys where tenant_id = ${TENANT}`;
});

describe("idempotencia de extremo a extremo", () => {
  it("1. la primera llamada ejecuta y deja la clave completed con la respuesta", async () => {
    const res = await pedir(appPara(USUARIO_A), "K-1", { nombre: "alfa" });
    expect(res.status).toBe(201);
    expect(ejecuciones).toBe(1);

    const [fila] = await sql<{ status: string; response: { status: number } }[]>`
      select status, response from public.idempotency_keys
       where tenant_id = ${TENANT} and key = 'K-1'`;
    expect(fila?.status).toBe("completed");
    expect(fila?.response.status).toBe(201);
  });

  it("2. el replay devuelve LA MISMA respuesta sin reejecutar: status y cuerpo originales", async () => {
    const app = appPara(USUARIO_A);
    const primera = await pedir(app, "K-2", { nombre: "beta" });
    const replay = await pedir(app, "K-2", { nombre: "beta" });

    expect(ejecuciones).toBe(1); // el handler corrió UNA vez
    expect(replay.status).toBe(201); // replay de un 201 devuelve 201
    expect(await replay.json()).toEqual(await primera.json());
  });

  it("3. misma clave, cuerpo distinto → 409 IDEMPOTENCY_KEY_REUSED, sin ejecutar", async () => {
    const app = appPara(USUARIO_A);
    await pedir(app, "K-3", { nombre: "gamma" });
    const res = await pedir(app, "K-3", { nombre: "OTRA COSA" });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(ejecuciones).toBe(1);
  });

  it("4. EL QUE GOBIERNA: otro actor con la misma clave y el mismo cuerpo EJECUTA su propia operación", async () => {
    // En S0.4, antes del arreglo, B recibía aquí la respuesta de A con un 200
    // y su operación no se ejecutaba. El lookup filtrado por actor es lo que
    // este caso prueba; el índice solo no lo garantiza.
    await pedir(appPara(USUARIO_A), "K-4", { nombre: "delta" });
    const deB = await pedir(appPara(USUARIO_B), "K-4", { nombre: "delta" });

    expect(deB.status).toBe(201);
    expect(ejecuciones).toBe(2); // DOS efectos: son dos operaciones de dos actores
    expect((await deB.json()).ejecucion).toBe(2); // y B recibió LA SUYA, no la de A
  });

  it("5. clave en vuelo → 409 IDEMPOTENCY_IN_PROGRESS con Retry-After, sin ejecutar", async () => {
    // El hash del fixture debe ser EL DEL CUERPO que se va a mandar: si no
    // coincide, gana la comprobación de hash y responde REUSED — y eso es
    // correcto (reusar la clave con otro cuerpo es REUSED aunque la original
    // siga en vuelo). La primera versión de este fixture usaba ceros y probaba
    // esa rama sin querer.
    const { createHash } = await import("node:crypto");
    const hashEpsilon = createHash("sha256")
      .update(JSON.stringify({ nombre: "epsilon" }))
      .digest();
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${USUARIO_A}, true)`;
      await tx`insert into public.idempotency_keys
        (tenant_id, company_id, actor_id, key, endpoint, request_hash, expires_at)
        values (${TENANT}, ${COMPANY}, ${USUARIO_A}, 'K-5', 'POST /v1/cosas',
                ${hashEpsilon}, now() + interval '1 hour')`;
    });

    const res = await pedir(appPara(USUARIO_A), "K-5", { nombre: "epsilon" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(ejecuciones).toBe(0);
  });

  it("6. una clave failed admite el reintento y se reejecuta — es la razón de que failed exista", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      const auth: AuthResult = { actor: { kind: "user", userId: USUARIO_A }, userId: USUARIO_A };
      c.set("ladino.auth", auth);
      c.set("ladino.ctx", {
        requestId: "req-test",
        actor: auth.actor,
        userId: USUARIO_A,
        companyId: COMPANY,
        tenantId: TENANT,
        idempotencyKey: c.req.header("Idempotency-Key") ?? null,
      });
      await next();
    });
    app.use("/v1/cosas", idempotencyMiddleware({ sql }));
    let falla = true;
    app.post("/v1/cosas", (c) => {
      ejecuciones += 1;
      if (falla) return c.json({ code: "VALIDATION_FAILED", message: "no" }, 422);
      return c.json({ id: "cosa-6" }, 201);
    });

    const r1 = await pedir(app, "K-6", { nombre: "zeta" });
    expect(r1.status).toBe(422);
    const [f1] = await sql<{ status: string }[]>`
      select status from public.idempotency_keys where tenant_id = ${TENANT} and key = 'K-6'`;
    expect(f1?.status).toBe("failed");

    falla = false;
    const r2 = await pedir(app, "K-6", { nombre: "zeta" });
    expect(r2.status).toBe(201);
    expect(ejecuciones).toBe(2);
  });

  it("7. sin Idempotency-Key en una ruta crítica → 400, sin ejecutar", async () => {
    const res = await pedir(appPara(USUARIO_A), null, { nombre: "eta" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(ejecuciones).toBe(0);
  });
});

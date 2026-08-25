import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { SignJWT } from "jose";
import type { Sql } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { rateLimitMiddleware } from "../src/middleware/rate-limit.js";
import { timeoutMiddleware } from "../src/middleware/timeout.js";

/**
 * Los tres controles que la auditoría de S0.6a echó en falta (F-5/F-6/F-7):
 * rate limit por usuario, plazo por petición y una readiness que no se cuelga.
 * Se prueban con apps mínimas y sin base: lo que importa es el contrato HTTP.
 */
const SECRETO = new TextEncoder().encode("un-secreto-de-al-menos-treinta-y-dos-caracteres");
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const USUARIO = "11111111-1111-4111-8111-111111111111";

async function token(sub = USUARIO): Promise<string> {
  return new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(SECRETO);
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("rate limit por usuario", () => {
  function appCon(porMinuto: number, reloj: { t: number }) {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("ladino.auth", {
        actor: { kind: "user", userId: c.req.header("X-U") ?? USUARIO },
        userId: c.req.header("X-U") ?? USUARIO,
      });
      await next();
    });
    app.use("*", rateLimitMiddleware({ porMinuto, ahora: () => reloj.t }));
    app.get("/x", (c) => c.text("ok"));
    return app;
  }

  it("la petición N+1 dentro del minuto recibe 429 RATE_LIMITED con Retry-After", async () => {
    const reloj = { t: 1_000_000 };
    const app = appCon(2, reloj);
    expect((await app.request("/x")).status).toBe(200);
    expect((await app.request("/x")).status).toBe(200);
    const r = await app.request("/x");
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(Number(r.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
  });

  it("la clave es el USUARIO: otro usuario no comparte cupo", async () => {
    const reloj = { t: 1_000_000 };
    const app = appCon(1, reloj);
    expect((await app.request("/x")).status).toBe(200);
    expect((await app.request("/x")).status).toBe(429);
    const otro = await app.request("/x", {
      headers: { "X-U": "22222222-2222-4222-8222-222222222222" },
    });
    expect(otro.status).toBe(200);
  });

  it("pasado el minuto, el cupo se renueva", async () => {
    const reloj = { t: 1_000_000 };
    const app = appCon(1, reloj);
    expect((await app.request("/x")).status).toBe(200);
    expect((await app.request("/x")).status).toBe(429);
    reloj.t += 60_001;
    expect((await app.request("/x")).status).toBe(200);
  });
});

describe("plazo por petición", () => {
  it("un handler que no responde a tiempo → 504 GATEWAY_TIMEOUT; uno rápido pasa", async () => {
    const app = new Hono();
    app.use("*", timeoutMiddleware(50));
    app.get("/lento", async (c) => {
      await dormir(200);
      return c.text("tarde");
    });
    app.get("/rapido", (c) => c.text("ok"));

    const lento = await app.request("/lento");
    expect(lento.status).toBe(504);
    expect(await lento.json()).toMatchObject({ code: "GATEWAY_TIMEOUT" });
    expect((await app.request("/rapido")).status).toBe(200);
  });
});

describe("sondas", () => {
  const auth = { mode: "hs256" as const, jwtSecret: SECRETO, issuer: ISSUER };

  it("/readyz con una base que NO responde devuelve 503 dentro del plazo, no se cuelga", async () => {
    const sqlColgado = (() => new Promise(() => {})) as unknown as Sql;
    const app = buildApp({ sql: sqlColgado, auth, readyTimeoutMs: 50 });
    const inicio = Date.now();
    const r = await app.request("/readyz");
    expect(r.status).toBe(503);
    expect(Date.now() - inicio).toBeLessThan(1000);
    // La respuesta no dice QUÉ falló: eso va al log.
    expect(await r.json()).toEqual({ ok: false });
  });

  it("/healthz no toca la base y /v1 sigue exigiendo token con la app completa", async () => {
    const sqlColgado = (() => new Promise(() => {})) as unknown as Sql;
    const app = buildApp({ sql: sqlColgado, auth });
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/v1/companies", { method: "POST" })).status).toBe(401);
  });

  it("el rate limit está montado en /v1: con cupo 1, la segunda petición autenticada es 429", async () => {
    const sqlColgado = (() => new Promise(() => {})) as unknown as Sql;
    const app = buildApp({ sql: sqlColgado, auth, rateLimitPorMinuto: 1, requestTimeoutMs: 100 });
    const headers = { Authorization: `Bearer ${await token()}` };
    // La primera pasa el cupo (y muere más adentro por falta de Idempotency-Key
    // o de cuerpo: lo que importa es que NO es 429). La segunda, sí.
    const primera = await app.request("/v1/companies", { method: "POST", headers });
    expect(primera.status).not.toBe(429);
    expect(primera.status).not.toBe(401);
    expect((await app.request("/v1/companies", { method: "POST", headers })).status).toBe(429);
  });
});

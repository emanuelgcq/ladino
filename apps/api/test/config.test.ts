import { describe, expect, it } from "vitest";
import { ConfigError, configAuth, configServidor } from "../src/config.js";

/**
 * La regla «hs256 no arranca fuera del stack local» no estaba probada
 * (F-2 de la auditoría de S0.6a): si alguien invertía la condición, `verify`
 * seguía en verde. Aquí cada rechazo tiene su test, y las DOS capas se prueban
 * por separado — cada una sola tiene que bastar.
 */
const getKeyFalso = (() => {
  throw new Error("no se llama en estos tests");
}) as never;

const LOCAL = {
  SUPABASE_AUTH_ISSUER: "http://127.0.0.1:54321/auth/v1",
  SUPABASE_JWT_SECRET: "un-secreto-de-al-menos-treinta-y-dos-caracteres",
};
const REMOTO = { SUPABASE_AUTH_ISSUER: "https://igpfrwdgmicgyirwdbgs.supabase.co/auth/v1" };

describe("configAuth", () => {
  it("por defecto es jwks, y exige la URL del JWKS", () => {
    const jwks = (url: string) => (() => url) as never;
    const cfg = configAuth({ ...REMOTO, SUPABASE_JWKS_URL: "https://x/jwks.json" }, jwks);
    expect(cfg.mode).toBe("jwks");
    expect(() => configAuth(REMOTO, jwks)).toThrow(/SUPABASE_JWKS_URL/);
  });

  it("hs256 contra el emisor LOCAL, sin NODE_ENV: arranca", () => {
    const cfg = configAuth({ ...LOCAL, LADINO_AUTH_MODE: "hs256" }, getKeyFalso);
    expect(cfg.mode).toBe("hs256");
  });

  it("capa 1: hs256 con NODE_ENV=production NO arranca aunque el emisor sea local", () => {
    expect(() =>
      configAuth({ ...LOCAL, LADINO_AUTH_MODE: "hs256", NODE_ENV: "production" }, getKeyFalso),
    ).toThrow(ConfigError);
    expect(() =>
      configAuth({ ...LOCAL, LADINO_AUTH_MODE: "hs256", NODE_ENV: "production" }, getKeyFalso),
    ).toThrow(/NODE_ENV=production/);
  });

  it("capa 2: hs256 contra un emisor REMOTO no arranca aunque NODE_ENV no esté", () => {
    const env = {
      ...REMOTO,
      LADINO_AUTH_MODE: "hs256",
      SUPABASE_JWT_SECRET: LOCAL.SUPABASE_JWT_SECRET,
    };
    expect(() => configAuth(env, getKeyFalso)).toThrow(/emisor local/);
  });

  it("modo inválido y emisor malformado fallan con ConfigError, no con TypeError", () => {
    expect(() => configAuth({ ...LOCAL, LADINO_AUTH_MODE: "rs256" }, getKeyFalso)).toThrow(
      /inválido/,
    );
    expect(() =>
      configAuth(
        {
          LADINO_AUTH_MODE: "hs256",
          SUPABASE_AUTH_ISSUER: "no es una url",
          SUPABASE_JWT_SECRET: "x",
        },
        getKeyFalso,
      ),
    ).toThrow(ConfigError);
  });

  it("falta el secreto en hs256 → ConfigError con el nombre de la variable", () => {
    expect(() =>
      configAuth(
        { SUPABASE_AUTH_ISSUER: LOCAL.SUPABASE_AUTH_ISSUER, LADINO_AUTH_MODE: "hs256" },
        getKeyFalso,
      ),
    ).toThrow(/SUPABASE_JWT_SECRET/);
  });
});

describe("configServidor", () => {
  const base = { ...LOCAL, LADINO_AUTH_MODE: "hs256", DATABASE_URL: "postgres://x" };

  it("valores por defecto: 3000, 300/min, 30 s — y el timeout queda muy por debajo del reaper", () => {
    const cfg = configServidor(base);
    expect(cfg.port).toBe(3000);
    expect(cfg.rateLimitPorMinuto).toBe(300);
    expect(cfg.requestTimeoutMs).toBe(30_000);
    expect(cfg.requestTimeoutMs).toBeLessThan((15 * 60_000) / 10); // ≪ 15 min (reaperIdempotencia)
  });

  it("un entero inválido no se ignora en silencio", () => {
    expect(() => configServidor({ ...base, PORT: "abc" })).toThrow(/PORT/);
    expect(() => configServidor({ ...base, RATE_LIMIT_PER_MINUTE: "0" })).toThrow(
      /RATE_LIMIT_PER_MINUTE/,
    );
  });
});

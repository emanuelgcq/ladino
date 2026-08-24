import { describe, expect, it, beforeAll } from "vitest";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type KeyLike } from "jose";
import { verificarToken, type AuthConfig } from "../src/middleware/auth.js";

/**
 * Cada aserción de rechazo nombra QUÉ validación la produce. La lista de seis
 * está en el comentario de `auth.ts`; este fichero la ejerce entera en los DOS
 * modos, incluida la pregunta explícita del encargo: qué pasa con un token
 * VÁLIDO de otro proyecto Supabase (muere en la firma, y si la clave
 * coincidiera, en el emisor — dos capas, probadas por separado).
 */

const ISSUER = "http://127.0.0.1:54321/auth/v1";
const ISSUER_AJENO = "https://otro-proyecto.supabase.co/auth/v1";
const SUB = "aaaaaaaa-1111-4111-8111-00000000000a";

// ── modo hs256 (stack local) ────────────────────────────────────────────────
const SECRETO = new TextEncoder().encode("secreto-de-este-proyecto-con-32-bytes!!");
const SECRETO_AJENO = new TextEncoder().encode("secreto-de-OTRO-proyecto-con-32-bytes!!");
const CFG_HS: AuthConfig = { mode: "hs256", jwtSecret: SECRETO, issuer: ISSUER };

interface Opciones {
  secreto?: Uint8Array;
  issuer?: string;
  audience?: string;
  role?: string | null;
  sub?: string | null;
  expiraEn?: string;
}

async function tokenHs(o: Opciones = {}): Promise<string> {
  let jwt = new SignJWT({ ...(o.role === null ? {} : { role: o.role ?? "authenticated" }) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(o.issuer ?? ISSUER)
    .setAudience(o.audience ?? "authenticated")
    .setIssuedAt()
    .setExpirationTime(o.expiraEn ?? "1h");
  if (o.sub !== null) jwt = jwt.setSubject(o.sub ?? SUB);
  return jwt.sign(o.secreto ?? SECRETO);
}

describe("modo hs256 (local) — las seis validaciones, una a una", () => {
  it("un token correcto produce el actor con su sub", async () => {
    const r = await verificarToken(await tokenHs(), CFG_HS);
    expect(r).toEqual({ ok: true, value: { actor: { kind: "user", userId: SUB }, userId: SUB } });
  });

  it("1. FIRMA: un token válido de OTRO proyecto se rechaza — otro secreto", async () => {
    const r = await verificarToken(await tokenHs({ secreto: SECRETO_AJENO }), CFG_HS);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("2. EMISOR: la segunda capa contra el token ajeno, probada POR SEPARADO", async () => {
    // Mismo secreto (en local todos comparten el legacy por defecto), otro
    // emisor. Sin esta aserción la capa 2 solo estaría probada mientras la
    // capa 1 funcione — que es no estar probada.
    const r = await verificarToken(await tokenHs({ issuer: ISSUER_AJENO }), CFG_HS);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("3. AUDIENCIA: un token para otro consumidor se rechaza", async () => {
    const r = await verificarToken(await tokenHs({ audience: "otro-servicio" }), CFG_HS);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("4. EXPIRACIÓN: expirado hace una hora → TOKEN_EXPIRED, el único motivo detallado", async () => {
    const r = await verificarToken(await tokenHs({ expiraEn: "-1h" }), CFG_HS);
    expect(r).toEqual({ ok: false, code: "TOKEN_EXPIRED" });
  });

  it("4b. la tolerancia de reloj absorbe 20 s de deriva, no más", async () => {
    expect((await verificarToken(await tokenHs({ expiraEn: "-20s" }), CFG_HS)).ok).toBe(true);
    expect(await verificarToken(await tokenHs({ expiraEn: "-40s" }), CFG_HS)).toEqual({
      ok: false,
      code: "TOKEN_EXPIRED",
    });
  });

  it("5. ROL: un token `anon` es válido criptográficamente y NO identifica a nadie", async () => {
    const r = await verificarToken(await tokenHs({ role: "anon" }), CFG_HS);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("6. SUB: sin sub, o con un sub que no es UUID, no hay actor que construir", async () => {
    expect(await verificarToken(await tokenHs({ sub: null }), CFG_HS)).toEqual({
      ok: false,
      code: "UNAUTHENTICATED",
    });
    expect(await verificarToken(await tokenHs({ sub: "admin" }), CFG_HS)).toEqual({
      ok: false,
      code: "UNAUTHENTICATED",
    });
  });

  it("VARIANTE ROTA del algoritmo: un token sin firmar (alg none) no cuela", async () => {
    const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
    const sinFirma =
      b64({ alg: "none", typ: "JWT" }) +
      "." +
      b64({
        sub: SUB,
        role: "authenticated",
        iss: ISSUER,
        aud: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }) +
      ".";
    expect(await verificarToken(sinFirma, CFG_HS)).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });
});

// ── modo jwks (producción: ES256 asimétrico, como el proyecto remoto) ───────
describe("modo jwks (producción) — clave pública, sin secreto que proteger", () => {
  let privada: KeyLike;
  let privadaAjena: KeyLike;
  let cfg: AuthConfig;

  beforeAll(async () => {
    const propia = await generateKeyPair("ES256");
    const ajena = await generateKeyPair("ES256");
    privada = propia.privateKey;
    privadaAjena = ajena.privateKey;
    // El JWKS que publicaría ESTE proyecto: solo la pública, con su kid.
    const jwk = { ...(await exportJWK(propia.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
    cfg = { mode: "jwks", getKey: createLocalJWKSet({ keys: [jwk] }), issuer: ISSUER };
  });

  async function tokenEs(key: KeyLike, o: Opciones = {}): Promise<string> {
    return new SignJWT({ role: o.role ?? "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setSubject(o.sub ?? SUB)
      .setIssuer(o.issuer ?? ISSUER)
      .setAudience(o.audience ?? "authenticated")
      .setIssuedAt()
      .setExpirationTime(o.expiraEn ?? "1h")
      .sign(key);
  }

  it("un token ES256 firmado con la clave del proyecto produce el actor", async () => {
    const r = await verificarToken(await tokenEs(privada), cfg);
    expect(r).toEqual({ ok: true, value: { actor: { kind: "user", userId: SUB }, userId: SUB } });
  });

  it("1. FIRMA: un token válido de OTRO proyecto —otra clave privada— se rechaza", async () => {
    const r = await verificarToken(await tokenEs(privadaAjena), cfg);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("2. EMISOR: misma clave, otro emisor → rechazado. Segunda capa por separado", async () => {
    const r = await verificarToken(await tokenEs(privada, { issuer: ISSUER_AJENO }), cfg);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("CONFUSIÓN DE ALGORITMO: un token HS256 no cuela en modo jwks, con ningún secreto", async () => {
    // El ataque clásico: firmar con HMAC usando la clave PÚBLICA como secreto,
    // esperando que el verificador la use como clave simétrica. Con
    // `algorithms: ["ES256"]` fijado por el modo, el token muere antes de que
    // se mire ninguna clave. Y en este modo no existe secreto HMAC alguno.
    const r = await verificarToken(await tokenHs({ secreto: SECRETO }), cfg);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("4. EXPIRACIÓN → TOKEN_EXPIRED también en jwks", async () => {
    const r = await verificarToken(await tokenEs(privada, { expiraEn: "-1h" }), cfg);
    expect(r).toEqual({ ok: false, code: "TOKEN_EXPIRED" });
  });

  it("5. ROL anon rechazado también con firma asimétrica válida", async () => {
    const r = await verificarToken(await tokenEs(privada, { role: "anon" }), cfg);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("y al revés: un token ES256 no cuela en modo hs256 — el modo es configuración, no detección", async () => {
    const r = await verificarToken(await tokenEs(privada), CFG_HS);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  // Los seis en los DOS modos (hueco señalado por la auditoría de S0.6a).
  it("3. AUDIENCIA distinta → rechazado también en jwks", async () => {
    const r = await verificarToken(await tokenEs(privada, { audience: "otra" }), cfg);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("6. SUB sin forma de UUID → rechazado también en jwks", async () => {
    const r = await verificarToken(await tokenEs(privada, { sub: "no-es-uuid" }), cfg);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("un `kid` que el JWKS no publica es culpa del TOKEN → 401, no 503", async () => {
    const forjado = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid: "desconocido" })
      .setSubject(SUB)
      .setIssuer(ISSUER)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privada);
    const r = await verificarToken(forjado, cfg);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  // F-1: un token que NO PUDO verificarse no es un token inválido.
  it("JWKS inalcanzable (fetch failed) → AUTH_BACKEND_UNAVAILABLE, no UNAUTHENTICATED", async () => {
    const caido: AuthConfig = {
      mode: "jwks",
      getKey: () => Promise.reject(new TypeError("fetch failed")),
      issuer: ISSUER,
    };
    const r = await verificarToken(await tokenEs(privada), caido);
    expect(r).toEqual({ ok: false, code: "AUTH_BACKEND_UNAVAILABLE" });
  });

  it("timeout del JWKS (código de jose) → AUTH_BACKEND_UNAVAILABLE", async () => {
    const lento: AuthConfig = {
      mode: "jwks",
      getKey: () =>
        Promise.reject(Object.assign(new Error("timeout"), { code: "ERR_JWKS_TIMEOUT" })),
      issuer: ISSUER,
    };
    const r = await verificarToken(await tokenEs(privada), lento);
    expect(r).toEqual({ ok: false, code: "AUTH_BACKEND_UNAVAILABLE" });
  });

  it("el middleware traduce AUTH_BACKEND_UNAVAILABLE a 503 con Retry-After, y el 401 sigue siendo 401", async () => {
    const { Hono } = await import("hono");
    const { authMiddleware } = await import("../src/middleware/auth.js");
    const caido: AuthConfig = {
      mode: "jwks",
      getKey: () => Promise.reject(new TypeError("fetch failed")),
      issuer: ISSUER,
    };
    const app = new Hono();
    app.use("*", authMiddleware(caido));
    app.get("/x", (c) => c.text("ok"));
    const r = await app.request("/x", {
      headers: { Authorization: `Bearer ${await tokenEs(privada)}` },
    });
    expect(r.status).toBe(503);
    expect(r.headers.get("Retry-After")).toBe("5");
    expect(await r.json()).toMatchObject({ code: "AUTH_BACKEND_UNAVAILABLE" });

    const sano = new Hono();
    sano.use("*", authMiddleware(cfg));
    sano.get("/x", (c) => c.text("ok"));
    const r401 = await sano.request("/x", {
      headers: { Authorization: `Bearer ${await tokenEs(privadaAjena)}` },
    });
    expect(r401.status).toBe(401);
  });
});

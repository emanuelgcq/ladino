import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { verificarToken, type AuthConfig } from "../src/middleware/auth.js";

/**
 * Cada aserción de rechazo nombra QUÉ validación la produce. La lista de seis
 * está en el comentario de `auth.ts`; este fichero la ejerce entera, incluida
 * la pregunta explícita del encargo: qué pasa con un token VÁLIDO de otro
 * proyecto Supabase (respuesta: muere en la firma, y si los secretos
 * coincidieran, en el emisor — dos capas, probadas por separado).
 */

const SECRETO = new TextEncoder().encode("secreto-de-este-proyecto-con-32-bytes!!");
const SECRETO_AJENO = new TextEncoder().encode("secreto-de-OTRO-proyecto-con-32-bytes!!");
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const ISSUER_AJENO = "https://otro-proyecto.supabase.co/auth/v1";
const CFG: AuthConfig = { jwtSecret: SECRETO, issuer: ISSUER };

const SUB = "aaaaaaaa-1111-4111-8111-00000000000a";

interface Opciones {
  secreto?: Uint8Array;
  issuer?: string;
  audience?: string;
  role?: string | null;
  sub?: string | null;
  expiraEn?: string;
}

async function token(o: Opciones = {}): Promise<string> {
  let jwt = new SignJWT({ ...(o.role === null ? {} : { role: o.role ?? "authenticated" }) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(o.issuer ?? ISSUER)
    .setAudience(o.audience ?? "authenticated")
    .setIssuedAt()
    .setExpirationTime(o.expiraEn ?? "1h");
  if (o.sub !== null) jwt = jwt.setSubject(o.sub ?? SUB);
  return jwt.sign(o.secreto ?? SECRETO);
}

describe("verificarToken — las seis validaciones, una a una", () => {
  it("un token correcto produce el actor con su sub", async () => {
    const r = await verificarToken(await token(), CFG);
    expect(r).toEqual({ ok: true, value: { actor: { kind: "user", userId: SUB }, userId: SUB } });
  });

  it("1. FIRMA: un token válido de OTRO proyecto Supabase se rechaza — otro secreto", async () => {
    // Es la pregunta central: el token es criptográficamente válido EN SU
    // proyecto. Aquí muere en la firma, sin llegar a mirar ningún claim.
    const r = await verificarToken(await token({ secreto: SECRETO_AJENO }), CFG);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("2. EMISOR: la segunda capa contra el token ajeno, probada POR SEPARADO", async () => {
    // Mismo secreto (la rotación mal hecha, el default reutilizado en local),
    // otro emisor. Si esta aserción no existiera, la capa 2 solo estaría
    // probada mientras la capa 1 funcione — que es no estar probada.
    const r = await verificarToken(await token({ issuer: ISSUER_AJENO }), CFG);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("3. AUDIENCIA: un token para otro consumidor se rechaza", async () => {
    const r = await verificarToken(await token({ audience: "otro-servicio" }), CFG);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("4. EXPIRACIÓN: expirado hace una hora → TOKEN_EXPIRED, el único motivo detallado", async () => {
    // El cliente necesita distinguir «refresca» de «vete». Ningún otro rechazo
    // se detalla: decir qué falló no ayuda a un cliente legítimo y sí a quien
    // sondea.
    const r = await verificarToken(await token({ expiraEn: "-1h" }), CFG);
    expect(r).toEqual({ ok: false, code: "TOKEN_EXPIRED" });
  });

  it("4b. la tolerancia de reloj absorbe 20 s de deriva, no más", async () => {
    const r = await verificarToken(await token({ expiraEn: "-20s" }), CFG);
    expect(r.ok).toBe(true);
    const r2 = await verificarToken(await token({ expiraEn: "-40s" }), CFG);
    expect(r2).toEqual({ ok: false, code: "TOKEN_EXPIRED" });
  });

  it("5. ROL: un token `anon` es válido criptográficamente y NO identifica a nadie", async () => {
    const r = await verificarToken(await token({ role: "anon" }), CFG);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("6. SUB: sin sub, o con un sub que no es UUID, no hay actor que construir", async () => {
    expect(await verificarToken(await token({ sub: null }), CFG)).toEqual({
      ok: false,
      code: "UNAUTHENTICATED",
    });
    expect(await verificarToken(await token({ sub: "admin" }), CFG)).toEqual({
      ok: false,
      code: "UNAUTHENTICATED",
    });
  });

  it("VARIANTE ROTA del algoritmo: un token sin firmar (alg none) no cuela", async () => {
    // jose no firma con `none`, así que se fabrica a mano: header {alg:"none"},
    // payload correcto, sin firma. Si esto pasara, todo lo demás daría igual.
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
    const r = await verificarToken(sinFirma, CFG);
    expect(r).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });
});

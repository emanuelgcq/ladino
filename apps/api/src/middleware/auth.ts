import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import type { Context, Next } from "hono";
import type { Actor } from "@ladino/db";

/**
 * LA API VERIFICA LA FIRMA DEL JWT ELLA MISMA. No delega.
 *
 * La razón es consecuencia directa de ADR-0025 §9: la API escribe con
 * `service_role`, que tiene BYPASSRLS. La RLS —lo que protege el camino
 * `authenticated`— NO protege a la API. Si la API no verifica el token, no lo
 * verifica nadie: se estaría confiando en un `sub` que cualquiera puede
 * escribir. Documentado en API_SPEC.md §La API verifica la firma.
 *
 * DOS MODOS DE FIRMA, y el que manda es el asimétrico:
 *
 *   · `jwks` (ES256, clave pública del proyecto vía JWKS) — el modo de
 *     PRODUCCIÓN. Es el que usa el proyecto remoto (comprobado contra su
 *     `/auth/v1/.well-known/jwks.json`). La API solo necesita la clave
 *     PÚBLICA: no hay secreto de verificación que proteger ni rotar, y la
 *     clase entera de «confusión de algoritmo» desaparece — no existe secreto
 *     HMAC con el que un atacante pueda firmar un token RS/ES reinterpretado.
 *     Rotar la clave del proyecto es transparente: el JWKS publica la nueva
 *     con su `kid` y jose la resuelve.
 *   · `hs256` (secreto compartido) — SOLO el stack local de Supabase, que
 *     sigue firmando con el secreto legacy. Los secretos compartidos no
 *     escalan y no rotan bien; en producción no se aceptan.
 *
 * El modo es CONFIGURACIÓN, no detección: un token no elige cómo se le
 * verifica. Si el modo es `jwks`, un token HS256 muere aunque su secreto
 * coincidiera con algo, porque `algorithms` solo admite ES256.
 *
 * QUÉ SE VALIDA, explícitamente y en este orden:
 *
 *   1. FIRMA — con la clave del modo configurado, y SOLO el algoritmo de ese
 *      modo. Un token de OTRO proyecto Supabase muere aquí: otra clave.
 *   2. EMISOR (`iss`) — la URL de auth de ESTE proyecto. Segunda capa contra
 *      el token ajeno: si algún día dos proyectos compartieran clave (en local
 *      todos comparten el secreto legacy por defecto), el emisor sigue sin
 *      coincidir. Dos capas, como en todo lo demás.
 *   3. AUDIENCIA (`aud`) — `authenticated`.
 *   4. EXPIRACIÓN (`exp`) — tolerancia de reloj EXPLÍCITA de 30 s (la misma
 *      cifra y motivo que el trigger de `occurred_at`: deriva NTP, no permiso
 *      para tokens viejos).
 *   5. `role` === "authenticated" — un token `anon` es válido
 *      criptográficamente y NO identifica a nadie.
 *   6. `sub` presente y con forma de UUID — es lo que se convierte en Actor.
 *
 * jose valida 1–4 dentro de `jwtVerify`; 5 y 6 se comprueban aparte porque son
 * claims de Supabase, no del estándar.
 */
export type AuthConfig =
  | {
      readonly mode: "jwks";
      /** Resuelve la clave pública por `kid`. En producción, `remoteJwks(url)`. */
      readonly getKey: JWTVerifyGetKey;
      readonly issuer: string;
    }
  | {
      readonly mode: "hs256";
      /** Secreto legacy del stack LOCAL. En producción este modo no se acepta. */
      readonly jwtSecret: Uint8Array;
      readonly issuer: string;
    };

/**
 * JWKS remoto con caché y refresco automáticos (jose): una rotación de clave
 * en el proyecto se absorbe sin redeploy. `cooldownDuration` evita que un
 * `kid` desconocido —un token forjado— dispare una tormenta de fetches.
 */
export function remoteJwks(jwksUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUrl), {
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });
}

const AUDIENCE = "authenticated";
const CLOCK_TOLERANCE_S = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthResult {
  readonly actor: Actor;
  readonly userId: string;
}

/**
 * Verifica el token y devuelve el actor, o el motivo del rechazo.
 *
 * Separado del middleware para poder probarlo sin montar Hono. Devuelve
 * `TOKEN_EXPIRED` como código propio —el cliente lo necesita para saber que
 * debe refrescar— y `UNAUTHENTICATED` para todo lo demás SIN detallar qué
 * falló: distinguir «firma inválida» de «emisor incorrecto» no ayuda a ningún
 * cliente legítimo y sí a quien está sondeando.
 */
export type AuthFailure = "TOKEN_EXPIRED" | "UNAUTHENTICATED" | "AUTH_BACKEND_UNAVAILABLE";

/**
 * Un token que NO PUDO verificarse no es un token inválido. jose lanza con
 * `code`; los de verificación (firma, claims, algoritmo, `kid` sin clave)
 * son culpa del token → 401. Los de INFRAESTRUCTURA del JWKS —timeout,
 * respuesta malformada— y cualquier error sin código de jose (un
 * `TypeError: fetch failed` por DNS o red) son culpa nuestra → 503, y se
 * registran. Sin esta distinción, una caída del endpoint de auth de Supabase
 * era un 401 para el 100 % del tráfico, sin una línea de log: los clientes
 * borraban la sesión y el panel decía «fallos de autenticación» en vez de
 * «dependencia caída» (F-1 de la auditoría de S0.6a).
 */
const CODIGOS_DE_INFRA = new Set(["ERR_JWKS_TIMEOUT", "ERR_JWKS_INVALID"]);

function clasificarFallo(e: unknown): AuthFailure {
  const code = (e as { code?: unknown }).code;
  if (code === "ERR_JWT_EXPIRED") return "TOKEN_EXPIRED";
  if (typeof code === "string" && code.startsWith("ERR_J") && !CODIGOS_DE_INFRA.has(code)) {
    return "UNAUTHENTICATED";
  }
  console.error(
    JSON.stringify({
      nivel: "error",
      evento: "auth.backend_unavailable",
      code: typeof code === "string" ? code : null,
      error: String((e as Error).message ?? e),
    }),
  );
  return "AUTH_BACKEND_UNAVAILABLE";
}

export async function verificarToken(
  token: string,
  cfg: AuthConfig,
): Promise<{ ok: true; value: AuthResult } | { ok: false; code: AuthFailure }> {
  let payload: Record<string, unknown>;
  try {
    const opciones = {
      issuer: cfg.issuer,
      audience: AUDIENCE,
      clockTolerance: CLOCK_TOLERANCE_S,
    };
    const r =
      cfg.mode === "jwks"
        ? await jwtVerify(token, cfg.getKey, { ...opciones, algorithms: ["ES256"] })
        : await jwtVerify(token, cfg.jwtSecret, { ...opciones, algorithms: ["HS256"] });
    payload = r.payload;
  } catch (e) {
    return { ok: false, code: clasificarFallo(e) };
  }

  // 5. Un token `anon` pasa la firma, el emisor y la expiración, y aun así no
  //    identifica a nadie. Se rechaza por rol, no por ausencia de sub, para que
  //    el motivo quede escrito y no dependa de qué claims trae ese token hoy.
  if (payload["role"] !== "authenticated") return { ok: false, code: "UNAUTHENTICATED" };

  // 6. `sub` es lo que se convierte en Actor.
  const sub = payload["sub"];
  if (typeof sub !== "string" || !UUID_RE.test(sub)) return { ok: false, code: "UNAUTHENTICATED" };

  return { ok: true, value: { actor: { kind: "user", userId: sub }, userId: sub } };
}

/** Middleware: exige `Authorization: Bearer <jwt>` y deja el resultado en el contexto. */
export function authMiddleware(cfg: AuthConfig) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    // El esquema es case-insensitive por RFC 7235: `bearer` y `BEARER` valen.
    // Con `startsWith("Bearer ")` un cliente legítimo recibía 401 sin motivo.
    const header = c.req.header("Authorization");
    const m = header ? /^bearer\s+(\S+)$/i.exec(header.trim()) : null;
    const token = m?.[1] ?? null;
    if (!token) {
      return c.json({ code: "UNAUTHENTICATED", message: "Autenticación requerida." }, 401);
    }

    const r = await verificarToken(token, cfg);
    if (!r.ok) {
      if (r.code === "AUTH_BACKEND_UNAVAILABLE") {
        // 503 genérico: el detalle está en el log, no se filtra al cliente.
        c.header("Retry-After", "5");
        return c.json({ code: r.code, message: "No se pudo verificar la autenticación." }, 503);
      }
      const message =
        r.code === "TOKEN_EXPIRED" ? "El token ha expirado." : "Autenticación requerida.";
      return c.json({ code: r.code, message }, 401);
    }

    c.set("ladino.auth", r.value);
    await next();
  };
}

declare module "hono" {
  interface ContextVariableMap {
    "ladino.auth": AuthResult;
  }
}

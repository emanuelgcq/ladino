import { jwtVerify } from "jose";
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
 * QUÉ SE VALIDA, explícitamente y en este orden:
 *
 *   1. FIRMA — HS256 con el secreto JWT del proyecto. Un token de OTRO proyecto
 *      Supabase muere aquí: está firmado con otro secreto.
 *   2. EMISOR (`iss`) — la URL de auth de ESTE proyecto. Es la segunda capa
 *      contra el token ajeno: si algún día los secretos coincidieran (una
 *      rotación mal hecha, un secreto por defecto reutilizado en local), el
 *      emisor sigue sin coincidir. Dos capas, como en todo lo demás.
 *   3. AUDIENCIA (`aud`) — `authenticated`. Rechaza tokens emitidos para otro
 *      consumidor.
 *   4. EXPIRACIÓN (`exp`) — con tolerancia de reloj EXPLÍCITA (30 s, la misma
 *      cifra y el mismo motivo que el trigger de `occurred_at`: deriva NTP, no
 *      permiso para tokens viejos).
 *   5. `role` === "authenticated" — un token `anon` es válido criptográficamente
 *      y NO identifica a nadie; aceptarlo sería autenticar al público.
 *   6. `sub` presente y con forma de UUID — es lo que se convierte en Actor y
 *      de él cuelgan created_by, permisos y el alcance de idempotencia.
 *
 * jose valida 1–4 dentro de `jwtVerify`; 5 y 6 se comprueban aparte porque son
 * claims de Supabase, no del estándar.
 */
export interface AuthConfig {
  /** Secreto JWT del proyecto (HS256). En local: el que imprime `supabase start`. */
  readonly jwtSecret: Uint8Array;
  /** `iss` esperado. En local: `http://127.0.0.1:54321/auth/v1`. */
  readonly issuer: string;
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
export async function verificarToken(
  token: string,
  cfg: AuthConfig,
): Promise<
  { ok: true; value: AuthResult } | { ok: false; code: "TOKEN_EXPIRED" | "UNAUTHENTICATED" }
> {
  let payload: Record<string, unknown>;
  try {
    const r = await jwtVerify(token, cfg.jwtSecret, {
      algorithms: ["HS256"],
      issuer: cfg.issuer,
      audience: AUDIENCE,
      clockTolerance: CLOCK_TOLERANCE_S,
    });
    payload = r.payload;
  } catch (e) {
    const code =
      (e as { code?: string }).code === "ERR_JWT_EXPIRED" ? "TOKEN_EXPIRED" : "UNAUTHENTICATED";
    return { ok: false, code };
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
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return c.json({ code: "UNAUTHENTICATED", message: "Autenticación requerida." }, 401);
    }

    const r = await verificarToken(token, cfg);
    if (!r.ok) {
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

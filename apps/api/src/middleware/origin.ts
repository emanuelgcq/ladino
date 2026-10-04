import { isIP } from "node:net";
import type { Context, Next } from "hono";
import { withOrigin, type Origin } from "@ladino/db";

/**
 * EL ORIGEN DE LA PETICIÓN (A-16, RESPUESTA §2.15): canal, ip, user-agent, sesión y build.
 *
 * Se resuelve UNA vez aquí, después de auth —la sesión sale del JWT ya verificado— y antes de
 * que nada abra transacción, y envuelve el resto de la petición con `withOrigin`: cada
 * `withTransaction` de debajo lo aterriza como GUC y el trigger `audit_events_origin` lo copia a
 * cada acta. Ningún handler ni caso de uso lo toca.
 *
 * QUÉ ES CADA COSA, y cuánto vale como prueba:
 *
 *   · canal — `web` si el `Origin` es el de la webapp (el de CORS) o el cliente dice
 *     `X-Ladino-Client: web/…`; `mobile` si dice `mobile/…`; `api` todo lo demás. Lo DECLARA el
 *     cliente: sirve para saber por dónde se trabaja, no para acusar a nadie.
 *   · ip — el ÚLTIMO salto de `X-Forwarded-For`, que es el que añade el proxy propio (Traefik);
 *     los anteriores los escribe quien llama. Sin la cabecera, la del socket. Si delante de
 *     Traefik se pusiera otro proxy, esta sería la ip de ese proxy: no verificado en producción.
 *   · sesión — el `session_id` del JWT verificado.
 *   · build — el de la API (`LADINO_BUILD`) y, si el cliente declaró el suyo, también.
 *
 * PRIVACIDAD: ip y user-agent son datos personales. Se guardan en `audit_events` y no salen en
 * ninguna respuesta de la API; los lee quien tiene `fiscal.audit.read`, por la RLS.
 */
export interface OriginConfig {
  /** El origen de la webapp (el mismo de CORS). */
  readonly webOrigin: string;
  /** El build de la API. Sin declarar, se dice. */
  readonly build?: string | undefined;
}

const CLIENTE_RE = /^(web|mobile)(?:\/([A-Za-z0-9._+-]{1,40}))?$/;

function ipValida(texto: string | undefined | null): string | null {
  if (!texto) return null;
  const limpia = texto.trim().replace(/^::ffff:/, "");
  return isIP(limpia) !== 0 ? limpia : null;
}

/** La ip del socket, si el servidor la expone (en los tests con `app.request` no hay socket). */
function ipDelSocket(c: Context): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return ipValida(env?.incoming?.socket?.remoteAddress);
}

export function resolverOrigen(c: Context, cfg: OriginConfig): Origin {
  const cliente = CLIENTE_RE.exec(c.req.header("X-Ladino-Client")?.trim() ?? "");
  const channel: Origin["channel"] =
    cliente?.[1] === "mobile"
      ? "mobile"
      : cliente?.[1] === "web" || c.req.header("Origin") === cfg.webOrigin
        ? "web"
        : "api";
  const reenviada = c.req.header("X-Forwarded-For")?.split(",").at(-1);
  const buildApi = `api@${cfg.build ?? "sin-declarar"}`;
  const auth = c.get("ladino.auth") as { sessionId?: string | null } | undefined;
  return {
    channel,
    ip: ipValida(reenviada) ?? ipDelSocket(c),
    userAgent: c.req.header("User-Agent")?.slice(0, 512) ?? null,
    sessionId: auth?.sessionId ?? null,
    appBuild: cliente?.[2] ? `${cliente[1]}@${cliente[2]} ${buildApi}` : buildApi,
  };
}

export function originMiddleware(cfg: OriginConfig) {
  return (c: Context, next: Next): Promise<void> => withOrigin(resolverOrigen(c, cfg), next);
}

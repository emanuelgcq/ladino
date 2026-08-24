import type { Context, Next } from "hono";

/**
 * Límite de peticiones POR USUARIO AUTENTICADO. La clave es `userId`, nunca la
 * IP: el NAT móvil venezolano agrupa a miles de usuarios tras una IP, y el
 * móvil cambia de IP constantemente. Un límite por IP en la API castigaría a
 * los legítimos y no vería al abusador que rota. (El límite por IP existe,
 * pero MUCHO más laxo y en el borde: los labels de Traefik del compose.)
 *
 * Ventana fija de un minuto, en memoria. Es deliberadamente simple: hay UNA
 * réplica de la API, y un contador compartido (Redis) sería infraestructura
 * nueva para un problema que hoy no existe. Cuando haya más de una réplica,
 * este fichero es lo que cambia, no el contrato: 429 `RATE_LIMITED` con
 * `Retry-After` en segundos.
 *
 * Va DESPUÉS de auth (necesita el actor verificado) y ANTES de todo lo que
 * cueste: la idempotencia abre transacción y reserva clave — la idempotencia
 * protege del reintento, no del abuso (F-6 de la auditoría de S0.6a).
 */
export interface RateLimitConfig {
  readonly porMinuto: number;
  /** Inyectable para los tests. */
  readonly ahora?: () => number;
}

interface Ventana {
  inicio: number;
  cuenta: number;
}

const VENTANA_MS = 60_000;

export function rateLimitMiddleware(cfg: RateLimitConfig) {
  const ahora = cfg.ahora ?? Date.now;
  const ventanas = new Map<string, Ventana>();
  let ultimaPoda = ahora();

  // Sin poda, cada usuario que pasó una vez ocupa memoria para siempre.
  function podar(t: number) {
    if (t - ultimaPoda < VENTANA_MS) return;
    ultimaPoda = t;
    for (const [k, v] of ventanas) if (t - v.inicio >= VENTANA_MS) ventanas.delete(k);
  }

  return async (c: Context, next: Next): Promise<Response | void> => {
    const userId = c.get("ladino.auth").userId;
    const t = ahora();
    podar(t);

    let v = ventanas.get(userId);
    if (!v || t - v.inicio >= VENTANA_MS) {
      v = { inicio: t, cuenta: 0 };
      ventanas.set(userId, v);
    }
    v.cuenta += 1;
    if (v.cuenta > cfg.porMinuto) {
      const retryAfter = Math.max(1, Math.ceil((v.inicio + VENTANA_MS - t) / 1000));
      c.header("Retry-After", String(retryAfter));
      return c.json(
        {
          code: "RATE_LIMITED",
          message: `Límite de ${cfg.porMinuto} peticiones por minuto superado.`,
        },
        429,
      );
    }
    await next();
  };
}

/**
 * EL ADAPTADOR BCV — el que la carga manual llevaba esperando desde ADR-0028
 * («NullBCVAdapter»). Fuente: DolarAPI Venezuela, `GET /v1/dolares/oficial`,
 * que publica la tasa OFICIAL del BCV:
 *
 *   { "promedio": 801.1752, "fechaActualizacion": "2026-09-02T00:00:00-04:00", … }
 *
 * Dos decisiones que importan:
 *
 *   1. La tasa se extrae del TEXTO CRUDO de la respuesta, nunca de
 *      `JSON.parse` — `promedio` viaja como número JSON y pasarlo por un
 *      float de JS antes de guardarlo en `numeric(24,8)` es exactamente el
 *      viaje que la regla 7 prohíbe. Regex sobre el cuerpo, string de punta
 *      a punta.
 *   2. El día de la tasa es el DÍA PUBLICADO por la fuente: los primeros 10
 *      caracteres de `fechaActualizacion`, que DolarAPI emite a medianoche
 *      de Caracas (-04:00). Sin conversión de zona: convertir es cómo se
 *      cuela la familia de bugs fecha-contra-reloj (CLAUDE.md §3) — y a
 *      medianoche VET el día UTC coincide, así que el corte es estable.
 */

export interface BcvConfig {
  /** Base de DolarAPI, p. ej. https://ve.dolarapi.com — los tests apuntan a un mock local. */
  readonly url: string;
}

export interface TasaBcv {
  /** La tasa como STRING decimal, tal como vino en el cuerpo. */
  readonly rate: string;
  /** El día publicado (YYYY-MM-DD), leído de `fechaActualizacion`. */
  readonly rateDate: string;
  /** El instante completo publicado, para la fuente citada. */
  readonly actualizada: string;
}

/** `promedio` del cuerpo crudo, como string exacto. `null` si no está o no es tasa. */
export function extraerPromedio(crudo: string): string | null {
  const m = /"promedio"\s*:\s*(\d{1,16}(?:\.\d{1,8})?)(?=\s*[,}])/.exec(crudo);
  if (m === null) return null;
  const tasa = m[1]!;
  // Una tasa de cero no es una tasa: la fuente está rota, no el bolívar.
  return /[1-9]/.test(tasa) ? tasa : null;
}

/** `fechaActualizacion` del cuerpo crudo. `null` si falta o no empieza por fecha. */
export function extraerFecha(crudo: string): string | null {
  const m = /"fechaActualizacion"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/.exec(crudo);
  return m?.[1] ?? null;
}

export class BcvNoDisponible extends Error {}

/** Trae la tasa oficial. Lanza `BcvNoDisponible` con el motivo si no se pudo. */
export async function tasaOficialBcv(cfg: BcvConfig): Promise<TasaBcv> {
  let cuerpo: string;
  try {
    const r = await fetch(`${cfg.url}/v1/dolares/oficial`, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/json" },
    });
    if (!r.ok) throw new BcvNoDisponible(`la fuente respondió HTTP ${r.status}`);
    cuerpo = await r.text();
  } catch (e) {
    if (e instanceof BcvNoDisponible) throw e;
    throw new BcvNoDisponible("la fuente no respondió (red o timeout)");
  }
  const rate = extraerPromedio(cuerpo);
  const fecha = extraerFecha(cuerpo);
  if (rate === null || fecha === null) {
    throw new BcvNoDisponible("la respuesta no trae promedio o fecha reconocibles");
  }
  return { rate, rateDate: fecha.slice(0, 10), actualizada: fecha };
}

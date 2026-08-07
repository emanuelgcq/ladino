/**
 * Instante en el tiempo, como string ISO-8601 en UTC.
 *
 * **No es `Date`.** `Date` es mutable, arrastra zona horaria y su representación textual
 * depende del entorno. Un `rate_timestamp` que se serializa distinto según el runtime es un
 * dato de auditoría que no reproduce (ADR-0020).
 *
 * Y no hay ningún `now()` aquí: el reloj se inyecta desde el borde de la aplicación
 * (ENGINEERING_STANDARDS.md §Fechas). Este módulo solo sabe validar y comparar.
 */
import type { Brand } from "./brand.js";
import { err, ok, type Result } from "./result.js";

export type Instant = Brand<string, "Instant">;

/** ISO-8601 estricto en UTC: solo sufijo `Z`, sin offsets. Milisegundos opcionales. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export const INVALID_INSTANT = "INVALID_INSTANT";

/**
 * Única vía de construcción. Rechaza offsets (`+04:00`), fechas sueltas y valores que el
 * calendario no admite (`2026-02-30`).
 */
export function parseInstant(value: string): Result<Instant> {
  if (!ISO_UTC.test(value)) {
    return err({
      code: INVALID_INSTANT,
      message: "El instante debe ser ISO-8601 en UTC con sufijo Z.",
      details: { value },
    });
  }

  // Validación de calendario. El regex acepta 2026-02-30, y `Date.parse` TAMPOCO lo rechaza:
  // hace rollover silencioso al 2 de marzo. Por eso la comprobación es de ida y vuelta —
  // si el instante reconstruido no coincide con el texto, la fecha no existía.
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) {
    return err({
      code: INVALID_INSTANT,
      message: "El instante no corresponde a una fecha real.",
      details: { value },
    });
  }

  const roundTrip = new Date(millis).toISOString();
  if (roundTrip.slice(0, 19) !== value.slice(0, 19)) {
    return err({
      code: INVALID_INSTANT,
      message: "El instante no corresponde a una fecha real.",
      details: { value, interpretadoComo: roundTrip },
    });
  }

  return ok(value as Instant);
}

export function isInstant(value: string): value is Instant {
  return parseInstant(value).ok;
}

/** Orden cronológico. Los ISO-8601 UTC de igual precisión ordenan lexicográficamente. */
export function compareInstants(a: Instant, b: Instant): -1 | 0 | 1 {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (ta < tb) return -1;
  if (ta > tb) return 1;
  return 0;
}

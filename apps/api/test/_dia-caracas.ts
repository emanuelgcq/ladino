/**
 * El día de HOY para los E2E es el de CARACAS, no el de UTC.
 *
 * `new Date().toISOString().slice(0, 10)` es el día de Greenwich: a partir de
 * las 20:00 de Venezuela ya es «mañana». Desde ADR-0054 el dominio y el esquema
 * cortan por el día de Caracas, así que una tasa o una factura fechadas con el
 * día UTC caen en el día siguiente y la venta de hoy no las ve. Es la familia
 * de bugs fecha-contra-reloj de CLAUDE.md §3, esta vez en los tests: pasaban a
 * las tres de la tarde y fallaban a las 21:55 (2026-09-12).
 */
export function diaCaracas(desplazamientoDias = 0): string {
  const instante = new Date(Date.now() + desplazamientoDias * 86_400_000);
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Caracas",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instante);
  const de = (tipo: string): string => partes.find((p) => p.type === tipo)?.value ?? "";
  return `${de("year")}-${de("month")}-${de("day")}`;
}

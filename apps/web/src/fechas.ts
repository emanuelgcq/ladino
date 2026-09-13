/**
 * Fechas para la pantalla, SIEMPRE en el día de Venezuela.
 *
 * La familia de bugs de CLAUDE.md §3: un instante ISO cortado con
 * `slice(0, 10)` es el día UTC, que de 20:00 a 23:59 en Caracas ya es
 * mañana; y `toISOString()` como «hoy» manda al servidor la fecha de
 * mañana. Aquí vive la única forma de convertir instantes en días para lo
 * que se muestra o se envía como fecha calendario. La zona es la del
 * negocio (America/Caracas), no la del navegador: un dueño de viaje sigue
 * viendo las fechas de su negocio.
 */
export const ZONA_NEGOCIO = "America/Caracas";

const diaCaracas = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONA_NEGOCIO,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const fechaCorta = new Intl.DateTimeFormat("es-VE", {
  timeZone: ZONA_NEGOCIO,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const fechaHora = new Intl.DateTimeFormat("es-VE", {
  timeZone: ZONA_NEGOCIO,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** «YYYY-MM-DD» del día de Caracas para un instante (ISO o Date). Cadena vacía si no hay dato. */
export function diaLocal(instante: string | Date | null | undefined): string {
  if (instante === null || instante === undefined || instante === "") return "";
  // Una fecha calendario pura («2026-09-11») ya ES un día: no se reinterpreta.
  if (typeof instante === "string" && /^\d{4}-\d{2}-\d{2}$/.test(instante)) return instante;
  const d = typeof instante === "string" ? new Date(instante) : instante;
  if (Number.isNaN(d.getTime())) return "";
  return diaCaracas.format(d);
}

/** El día de HOY en Caracas, «YYYY-MM-DD»: lo que se manda como fecha por defecto. */
export function hoyLocal(): string {
  return diaCaracas.format(new Date());
}

/** Día de Caracas desplazado N días (N puede ser negativo). */
export function diaLocalMas(dias: number, desde: Date = new Date()): string {
  return diaCaracas.format(new Date(desde.getTime() + dias * 86_400_000));
}

/** «dd/mm/aaaa» en Caracas, para leer. «—» si no hay dato. */
export function fechaLocal(instante: string | Date | null | undefined): string {
  if (instante === null || instante === undefined || instante === "") return "—";
  if (typeof instante === "string" && /^\d{4}-\d{2}-\d{2}$/.test(instante)) {
    const [a, m, d] = instante.split("-");
    return `${d}/${m}/${a}`;
  }
  const d = typeof instante === "string" ? new Date(instante) : instante;
  if (Number.isNaN(d.getTime())) return "—";
  return fechaCorta.format(d);
}

/** «dd/mm/aaaa, hh:mm» en Caracas, para leer. «—» si no hay dato. */
export function fechaHoraLocal(instante: string | Date | null | undefined): string {
  if (instante === null || instante === undefined || instante === "") return "—";
  const d = typeof instante === "string" ? new Date(instante) : instante;
  if (Number.isNaN(d.getTime())) return "—";
  return fechaHora.format(d);
}

function rangoMes(a: number, m: number): { desde: string; hasta: string } {
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { desde: `${a}-${mm}-01`, hasta: `${a}-${mm}-${String(ultimo).padStart(2, "0")}` };
}

/** Primer y último día del mes de Caracas al que pertenece el instante. */
export function mesLocal(desde: Date = new Date()): { desde: string; hasta: string } {
  const [a, m] = diaCaracas.format(desde).split("-").map(Number) as [number, number];
  return rangoMes(a, m);
}

/** El mes de Caracas ANTERIOR al del instante (el período que se declara). */
export function mesLocalAnterior(desde: Date = new Date()): { desde: string; hasta: string } {
  const [a, m] = diaCaracas.format(desde).split("-").map(Number) as [number, number];
  return m === 1 ? rangoMes(a - 1, 12) : rangoMes(a, m - 1);
}

/** La quincena de Caracas en curso: 1–15 o 16–fin de mes (IGTF se entera por quincena). */
export function quincenaLocal(desde: Date = new Date()): { desde: string; hasta: string } {
  const [a, m, d] = diaCaracas.format(desde).split("-").map(Number) as [number, number, number];
  const mes = rangoMes(a, m);
  const mm = String(m).padStart(2, "0");
  return d <= 15
    ? { desde: `${a}-${mm}-01`, hasta: `${a}-${mm}-15` }
    : { desde: `${a}-${mm}-16`, hasta: mes.hasta };
}

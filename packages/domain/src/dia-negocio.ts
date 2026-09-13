/**
 * El DÍA del negocio: la fecha calendario de Venezuela (America/Caracas) a la
 * que pertenece un instante.
 *
 * Es la única forma admitida de convertir un instante en un día para lo que
 * tiene sentido contable o fiscal — `posting_date`, el día de una tasa, el
 * `occurred_on` de un diferencial. La familia de bugs de CLAUDE.md §3 nació
 * de `toISOString().slice(0, 10)`: el día UTC, que de 20:00 a 23:59 en
 * Caracas ya es mañana, mandaba una venta nocturna de fin de mes al período
 * siguiente y elegía la tasa de mañana (auditoría 2026-09-11, A-24).
 *
 * Cero dependencias: `Intl` es parte del runtime. Un día calendario que ya
 * viene como «YYYY-MM-DD» se devuelve tal cual: no se reinterpreta.
 */
export const ZONA_NEGOCIO = "America/Caracas";

const SOLO_DIA = /^\d{4}-\d{2}-\d{2}$/;

const formato = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONA_NEGOCIO,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * «YYYY-MM-DD» de Caracas para un instante ISO o un `Date`. No hay «hoy»
 * implícito: el reloj se inyecta desde el borde (ENGINEERING_STANDARDS §Fechas).
 * Un instante ilegible lanza: un día inventado en un asiento es peor que un
 * fallo ruidoso.
 */
export function diaNegocio(instante: string | Date): string {
  if (typeof instante === "string" && SOLO_DIA.test(instante)) return instante;
  const d = typeof instante === "string" ? new Date(instante) : instante;
  if (Number.isNaN(d.getTime())) {
    throw new Error(`diaNegocio: instante ilegible «${String(instante)}»`);
  }
  return formato.format(d);
}

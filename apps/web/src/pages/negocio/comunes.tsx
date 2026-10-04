import { leerCantidad } from "../../components/forms.js";
import { diaLocal } from "../../fechas.js";
/**
 * Fechas RELATIVAS para el mundo del negocio (PARTE 16): «hoy», «ayer»,
 * «hace 3 días» — y a partir de la semana, la fecha corta de verdad. Compara
 * DÍAS calendario, no milisegundos: a las 8 am, lo de anoche es «ayer».
 */
export function fechaRelativa(iso: string): string {
  // Una fecha calendario pura («2026-09-15», p. ej. la fecha de una factura de
  // proveedor) YA es un día de Caracas: `new Date()` la leería como medianoche
  // UTC y a las 20:00 de Caracas del día anterior — «ayer» para algo de hoy
  // (QA de pantalla 2026-09-15, hallazgo 78).
  const soloDia = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const fecha = soloDia ? new Date(`${iso}T12:00:00-04:00`) : new Date(iso);
  if (Number.isNaN(fecha.getTime())) return "—";
  // Días de CARACAS comparados como días: la versión anterior sumaba el huso
  // con el signo invertido y «hoy» pasaba a «ayer» a las 16:00 (auditoría
  // 2026-09-11).
  const dia = (d: Date) => Math.floor(Date.parse(`${diaLocal(d)}T00:00:00Z`) / 86_400_000);
  const diferencia = dia(new Date()) - dia(fecha);
  if (diferencia <= 0) return "hoy";
  if (diferencia === 1) return "ayer";
  if (diferencia < 7) return `hace ${diferencia} días`;
  return fecha.toLocaleDateString("es-VE", { day: "numeric", month: "short" });
}

/**
 * Los dos conversores del asistente de /empezar: entre el «16%» que escribe
 * la persona y la fracción «0.16» que viaja a la API, moviendo la coma sobre
 * STRINGS. Ni un float toca el porcentaje que la persona acepta.
 */
export function porcentajeAFraccion(p: string): string | null {
  // F-06: el lector único de porcentajes y cantidades; aquí solo se acota la forma.
  const leido = leerCantidad(p);
  if (!leido.ok) return null;
  const limpio = leido.cantidad;
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(limpio)) return null;
  const [ent = "0", dec = ""] = limpio.split(".");
  const fraccion = `0.${ent.padStart(2, "0")}${dec}`.replace(/0+$/, "").replace(/\.$/, "");
  return fraccion === "0" || fraccion === "" ? "0" : fraccion;
}

/**
 * Viste una cédula o RIF para enseñarlo. Es la función COMPARTIDA de @ladino/schemas (la misma
 * que imprime el PDF): antes había dos espejos, y el documento de nueve cifras de una persona
 * natural salía agrupado como cédula (M-05). Se reexporta con su nombre para no tocar a quien
 * la usa.
 */
export { formatearDocumento } from "@ladino/schemas";

/** La vuelta: «0.16000000» → «16», «0.125» → «12,5». Igual: solo la coma. */
export function fraccionAPorcentaje(f: string): string {
  const [ent = "0", dec = ""] = f.split(".");
  const rellena = dec.length < 2 ? `${dec}00`.slice(0, 2) : dec;
  const entera = (ent === "0" ? "" : ent) + rellena.slice(0, 2);
  const resto = rellena.slice(2).replace(/0+$/, "");
  const cabeza = entera.replace(/^0+(?=\d)/, "");
  return resto === "" ? cabeza : `${cabeza},${resto}`;
}

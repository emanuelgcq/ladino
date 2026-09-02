/**
 * Fechas RELATIVAS para el mundo del negocio (PARTE 16): «hoy», «ayer»,
 * «hace 3 días» — y a partir de la semana, la fecha corta de verdad. Compara
 * DÍAS calendario, no milisegundos: a las 8 am, lo de anoche es «ayer».
 */
export function fechaRelativa(iso: string): string {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return "—";
  const dia = (d: Date) => Math.floor(d.getTime() / 86_400_000 + d.getTimezoneOffset() / 1440);
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
  const limpio = p.trim().replace(",", ".");
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(limpio)) return null;
  const [ent = "0", dec = ""] = limpio.split(".");
  const fraccion = `0.${ent.padStart(2, "0")}${dec}`.replace(/0+$/, "").replace(/\.$/, "");
  return fraccion === "0" || fraccion === "" ? "0" : fraccion;
}

/** La vuelta: «0.16000000» → «16», «0.125» → «12,5». Igual: solo la coma. */
export function fraccionAPorcentaje(f: string): string {
  const [ent = "0", dec = ""] = f.split(".");
  const rellena = dec.length < 2 ? `${dec}00`.slice(0, 2) : dec;
  const entera = (ent === "0" ? "" : ent) + rellena.slice(0, 2);
  const resto = rellena.slice(2).replace(/0+$/, "");
  const cabeza = entera.replace(/^0+(?=\d)/, "");
  return resto === "" ? cabeza : `${cabeza},${resto}`;
}

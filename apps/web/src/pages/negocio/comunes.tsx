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

/**
 * Viste una cédula o RIF NORMALIZADO para enseñarlo: «V12345678» →
 * «V-12.345.678», «J401234567» → «J-40123456-7». Solo presentación: el guion
 * y los puntos no se guardan ni significan nada. Lo que no tenga la forma
 * prefijo+alfanumérico (datos viejos con otro formato) se enseña tal cual —
 * vestir no es corregir. Espejo de `vestirDocumento` del PDF de la API.
 */
export function formatearDocumento(crudo: string): string {
  const m = /^([VEJGP])([0-9A-Z]+)$/.exec(crudo.toUpperCase());
  if (!m) return crudo;
  const prefijo = m[1]!;
  const resto = m[2]!;
  if (prefijo === "V" || prefijo === "E") {
    return `${prefijo}-${resto.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
  }
  if ((prefijo === "J" || prefijo === "G") && resto.length > 1) {
    return `${prefijo}-${resto.slice(0, -1)}-${resto.slice(-1)}`;
  }
  return `${prefijo}-${resto}`;
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

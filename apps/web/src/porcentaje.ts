/**
 * Porcentajes para la pantalla, SIN tocar un float.
 *
 * El servidor manda las tasas como FRACCIÓN en string («0.16000000» es el 16 %,
 * «0.03000000» el 3 %, «1» el 100 %). Enseñarlas como porcentaje es mover la
 * coma dos lugares, y eso se hace sobre el STRING: `Number(x) * 100` produce
 * 16.000000000000004 en el caso bueno y en el malo redondea lo que la ley
 * escribió con tres decimales. Misma técnica que `fraccionAPorcentaje` del
 * asistente de /empezar (pages/negocio/comunes.tsx), aquí para toda la app.
 */

/** «0.16000000» → «16», «0.125» → «12,5», «1» → «100», «0.75» → «75». Coma decimal (es-VE). */
export function porcentajeDeFraccion(fraccion: string): string {
  const neg = fraccion.startsWith("-");
  const cuerpo = neg ? fraccion.slice(1) : fraccion;
  const [ent = "0", dec = ""] = cuerpo.split(".");
  // Dos decimales de la fracción pasan a la parte entera del porcentaje.
  const rellena = dec.length < 2 ? `${dec}00`.slice(0, 2) : dec;
  const entera = ((ent === "0" ? "" : ent) + rellena.slice(0, 2)).replace(/^0+(?=\d)/, "");
  const resto = rellena.slice(2).replace(/0+$/, "");
  const cabeza = entera === "" ? "0" : entera;
  return `${neg ? "-" : ""}${resto === "" ? cabeza : `${cabeza},${resto}`}`;
}

/** Lo mismo, con su signo de porcentaje: «0.16000000» → «16 %». */
export function mostrarPorcentaje(fraccion: string): string {
  return `${porcentajeDeFraccion(fraccion)} %`;
}

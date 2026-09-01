/**
 * Comparación de dos importes decimales EN STRING, sin pasar por un float.
 *
 * Existe para UNA cosa: decidir la dirección de un delta en el dashboard
 * (¿subió o bajó respecto al mes anterior?). Devuelve -1 | 0 | 1 y NUNCA un
 * importe: producir cifras nuevas a partir de dinero está prohibido en el
 * cliente (apps/web/CLAUDE.md), y comparar no es producir.
 *
 * Algoritmo: signo primero; luego se alinean las partes enteras por longitud
 * (más dígitos = mayor) y se comparan lexicográficamente entero y decimal con
 * relleno de ceros a la derecha. Vale para cualquier precisión — que es
 * justamente lo que un double no garantiza pasados 15-16 dígitos.
 */
export function compararImportes(a: string, b: string): -1 | 0 | 1 {
  const pa = partir(a);
  const pb = partir(b);
  if (pa === null || pb === null) return 0; // ilegible: sin dirección, no una inventada
  if (pa.neg !== pb.neg) return pa.neg ? -1 : 1;
  const magnitud = compararMagnitud(pa, pb);
  if (magnitud === 0) return 0;
  return pa.neg ? (magnitud === 1 ? -1 : 1) : magnitud;
}

interface Partes {
  neg: boolean;
  ent: string;
  dec: string;
}

function partir(v: string): Partes | null {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (m === null) return null;
  const ent = (m[2] ?? "0").replace(/^0+(?=\d)/, "");
  const dec = (m[3] ?? "").replace(/0+$/, "");
  // -0 es 0.
  const neg = m[1] === "-" && !(ent === "0" && dec === "");
  return { neg, ent, dec };
}

function compararMagnitud(a: Partes, b: Partes): -1 | 0 | 1 {
  if (a.ent.length !== b.ent.length) return a.ent.length > b.ent.length ? 1 : -1;
  if (a.ent !== b.ent) return a.ent > b.ent ? 1 : -1;
  const ancho = Math.max(a.dec.length, b.dec.length);
  const da = a.dec.padEnd(ancho, "0");
  const db = b.dec.padEnd(ancho, "0");
  if (da === db) return 0;
  return da > db ? 1 : -1;
}

/** ¿Es cero, con cualquier número de decimales? */
export function esCero(v: string): boolean {
  return /^-?0*(?:\.0*)?$/.test(v.trim());
}

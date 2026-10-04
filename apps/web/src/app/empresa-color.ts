/**
 * CÓMO SE DISTINGUE UNA EMPRESA DE OTRA SIN LEER (O-05, recorrido 2026-09-24).
 *
 * Quien lleva dos negocios solo tenía el nombre, en letra pequeña, para saber en cuál estaba. La
 * insignia (`components/InsigniaEmpresa.tsx`) enseña el logo que ya existe y, cuando no lo hay, la
 * inicial sobre un color.
 *
 * EL COLOR SE DERIVA, NO SE GUARDA: sale del id de la empresa, así que es el mismo en cada
 * pestaña, en cada equipo y después de cada recarga, sin tabla ni columna nueva. El precio: dos
 * empresas pueden caer en tonos vecinos, y nadie puede elegir el suyo — para eso está el logo.
 *
 * Sin imports a propósito: `scripts/recorrido/verificar/O.mjs` lo carga tal cual.
 */

/** FNV-1a de 32 bits: reparte bien cadenas que solo difieren en un carácter (dos UUID v7 seguidos). */
function huella(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i += 1) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * El color de fondo de la insignia: un tono por empresa, con saturación y luz FIJAS. Con 55 % y
 * 30 % el texto blanco encima pasa de 4,5:1 en todos los tonos (el peor, el amarillo, ≈ 4,7:1), en
 * tema claro y en oscuro.
 */
export function colorDeEmpresa(id: string): string {
  return `hsl(${huella(id.toLowerCase()) % 360} 55% 30%)`;
}

/** La letra de la insignia: la primera letra o cifra del nombre con el que se conoce el negocio. */
export function inicialDeEmpresa(empresa: {
  readonly trade_name: string | null;
  readonly legal_name: string;
}): string {
  const nombre =
    empresa.trade_name !== null && empresa.trade_name.trim() !== ""
      ? empresa.trade_name
      : empresa.legal_name;
  const letra = /[\p{L}\p{N}]/u.exec(nombre);
  return letra === null ? "?" : letra[0].toLocaleUpperCase("es");
}

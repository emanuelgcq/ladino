/**
 * EN QUÉ PASO DE /empezar IBA LA PERSONA (recorrido 2026-09-24, B-10 y M-06).
 *
 * El asistente arrancaba siempre en el paso 1: quien salía a vender y volvía, o quien llegaba
 * desde la banda de la caja que invita a facturar, tenía que adivinar el camino. Ahora:
 *   1. manda el enlace (`?paso=facturas`, `?paso=recibos`…): quien lo trae pidió ese paso. Se
 *      CONSUME una vez: la pantalla lo recuerda y lo quita de la URL, para que una recarga
 *      posterior obedezca a lo recordado y no al enlace viejo;
 *   2. si no, el paso donde quedó esta pestaña en esta empresa (sessionStorage);
 *   3. si no, el primero.
 *
 * Módulo hoja y puro salvo las dos funciones de almacenamiento: se prueba sin navegador.
 */
const TOTAL_PASOS = 4;

/** Los nombres que acepta `?paso=`. El cuarto paso se llama facturas o recibos según la empresa. */
const POR_NOMBRE: Record<string, number> = {
  productos: 0,
  dinero: 1,
  tasa: 2,
  facturas: 3,
  recibos: 3,
};

/** El paso que pide el enlace, o null si no pide ninguno que exista. */
export function pasoPedido(search: string): number | null {
  const pedido = new URLSearchParams(search).get("paso");
  return pedido !== null && Object.hasOwn(POR_NOMBRE, pedido) ? POR_NOMBRE[pedido]! : null;
}

/** ¿La URL trae `paso`, valga o no? Si lo trae, se quita. */
export function traePaso(search: string): boolean {
  return new URLSearchParams(search).has("paso");
}

/** La misma búsqueda sin `paso` (con su «?» si queda algo; vacía si no). */
export function sinPaso(search: string): string {
  const resto = new URLSearchParams(search);
  resto.delete("paso");
  const texto = resto.toString();
  return texto === "" ? "" : `?${texto}`;
}

export function pasoInicial(search: string, guardado: number | null): number {
  const pedido = pasoPedido(search);
  if (pedido !== null) return pedido;
  if (guardado !== null && Number.isInteger(guardado) && guardado >= 0 && guardado < TOTAL_PASOS) {
    return guardado;
  }
  return 0;
}

const clave = (empresaId: string): string => `ladino.empezar.paso.${empresaId}`;

/** El paso recordado de esta pestaña para esta empresa, o null. Nunca lanza. */
export function pasoGuardado(empresaId: string): number | null {
  try {
    const crudo = window.sessionStorage.getItem(clave(empresaId));
    return crudo === null ? null : Number(crudo);
  } catch {
    return null;
  }
}

/** Recuerda el paso. Si el almacenamiento no está disponible, no pasa nada: se pierde el recuerdo. */
export function recordarPaso(empresaId: string, paso: number): void {
  try {
    window.sessionStorage.setItem(clave(empresaId), String(paso));
  } catch {
    // Modo privado o cuota llena: el asistente funciona igual, solo no recuerda.
  }
}

/**
 * LA EMPRESA ACTIVA VIVE EN LA PESTAÑA (ADR-0077 §1, hallazgo O-01).
 *
 * Antes se guardaba en UNA clave del disco por usuario y cada carga la releía: si otra pestaña
 * cambiaba de empresa, esta, al recargar, aparecía en la otra sin avisar, con la caja llena de
 * productos ajenos. Ahora:
 *   · la empresa de la pestaña va en `sessionStorage`, que es de la pestaña y sobrevive al F5;
 *   · el disco (`localStorage`) solo guarda la ÚLTIMA elegida, como punto de partida de una
 *     pestaña NUEVA — nunca le cambia la empresa a una pestaña que ya tiene la suya;
 *   · cada petición manda `X-Company-Id` desde el estado de la pestaña (session.tsx → `llamar`).
 *
 * Funciones puras sobre dos almacenes inyectados: así se prueba el caso de las dos pestañas.
 */
export interface Almacen {
  getItem(clave: string): string | null;
  setItem(clave: string, valor: string): void;
}

const clavePestana = (userId: string) => `ladino.company.tab.${userId}`;
/** La misma clave de siempre: la última elegida por ESTE usuario en esta máquina. */
const claveUltima = (userId: string) => `ladino.company.${userId}`;

/** El almacenamiento puede LANZAR (modo privado, datos bloqueados): sin él, se elige por la lista. */
function leer(almacen: Almacen | null, clave: string): string | null {
  try {
    return almacen === null ? null : almacen.getItem(clave);
  } catch {
    return null;
  }
}

function escribir(almacen: Almacen | null, clave: string, valor: string): void {
  try {
    almacen?.setItem(clave, valor);
  } catch {
    // Sin almacenamiento la pestaña conserva su empresa mientras no recargue: no hay más que hacer.
  }
}

export function leerEmpresa(
  userId: string,
  pestana: Almacen | null,
  disco: Almacen | null,
): { porPestana: string | null; ultima: string | null } {
  return {
    porPestana: leer(pestana, clavePestana(userId)),
    ultima: leer(disco, claveUltima(userId)),
  };
}

export function recordarEmpresa(
  userId: string,
  companyId: string,
  pestana: Almacen | null,
  disco: Almacen | null,
): void {
  escribir(pestana, clavePestana(userId), companyId);
  escribir(disco, claveUltima(userId), companyId);
}

/**
 * La empresa con la que arranca la pestaña: la SUYA si sigue visible; si la pestaña es nueva, la
 * última elegida; si solo hay una, esa; si no, ninguna (el selector pregunta).
 */
export function empresaInicial<T extends { readonly id: string }>(
  empresas: readonly T[],
  porPestana: string | null,
  ultima: string | null,
): T | null {
  const deLaPestana = empresas.find((e) => e.id === porPestana);
  if (deLaPestana !== undefined) return deLaPestana;
  if (porPestana === null) {
    const laUltima = empresas.find((e) => e.id === ultima);
    if (laUltima !== undefined) return laUltima;
  }
  return empresas.length === 1 ? (empresas[0] ?? null) : null;
}

/**
 * H3 (revisión ADR-0077): lo que hace `recargar` en session.tsx. Resuelve la empresa con la que
 * arranca la pestaña y la FIJA en su sessionStorage. Sin esa escritura, una pestaña nueva que
 * arrancaba en la última elegida no guardaba nada propio, y tras un F5 volvía a leer el disco, que
 * otra pestaña ya había cambiado: O-01 seguía reproduciendo. El disco no se toca: elegir es de
 * `recordarEmpresa`.
 */
export function resolverEmpresaDePestana<T extends { readonly id: string }>(
  userId: string,
  empresas: readonly T[],
  pestana: Almacen | null,
  disco: Almacen | null,
): T | null {
  const { porPestana, ultima } = leerEmpresa(userId, pestana, disco);
  const elegida = empresaInicial(empresas, porPestana, ultima);
  if (elegida !== null) escribir(pestana, clavePestana(userId), elegida.id);
  return elegida;
}

/** Los dos almacenes del navegador, o null donde no existan (pruebas, SSR). */
export function almacenesDelNavegador(): { pestana: Almacen | null; disco: Almacen | null } {
  try {
    return {
      pestana: typeof sessionStorage === "undefined" ? null : sessionStorage,
      disco: typeof localStorage === "undefined" ? null : localStorage,
    };
  } catch {
    return { pestana: null, disco: null };
  }
}

export interface ModulosActivos {
  compras: boolean;
  contabilidad: boolean;
  libros: boolean;
}

/** La clave del rol de sistema «Contador» (`public.roles.key`). */
export const ROL_CONTADOR = "accountant";

/**
 * La SONDA de la divulgación progresiva, separada del shell para poder
 * testearla con un cajero puro. Cada `.catch` es semántica, no descuido:
 * varios de estos GET exigen permiso de lectura (`/v1/journal-entries` →
 * accounting.read — cierre RBAC del 2026-09-08), y para quien no lo tiene el
 * 403 significa «este módulo no es tuyo», jamás un error. La sonda no lanza
 * NUNCA: la caja entra, vende y no ve Administración — sin ruido en consola ni
 * promesas sin capturar.
 *
 * A-04 (regla del dueño, 2026-09-28): «Contabilidad y Libros aparecen cuando hay datos (primer
 * asiento posteado o primer documento fiscal) o cuando el rol es contador». Antes la sonda daba
 * Contabilidad por activa si había PLAN DE CUENTAS —que el alta importa siempre— y Libros si
 * Contabilidad lo estaba: los dos aparecían el primer día, sin un dato, contra lo que promete
 * Configuración → Módulos. Ahora:
 *   · Contabilidad: hay al menos un asiento POSTEADO, o la persona es contadora;
 *   · Libros: hay al menos una FACTURA (el primer documento fiscal: una nota nace de una
 *     factura), o la persona es contadora.
 * Decidido por criterio: cada módulo con SU dato. Alternativa: que cualquiera de los dos datos
 * encienda los dos módulos.
 */
export async function sondearModulosActivos(
  llamar: <T>(path: string) => Promise<T>,
  opciones: { readonly esContador?: boolean } = {},
): Promise<ModulosActivos> {
  const sinFilas = { total: 0 };
  const [proveedores, asientos, facturas] = await Promise.all([
    llamar<{ total: number }>("/v1/suppliers?per_page=1").catch(() => sinFilas),
    llamar<{ total: number }>("/v1/journal-entries?status=posted&per_page=1").catch(() => sinFilas),
    llamar<{ total: number }>("/v1/documents?kind=invoice&per_page=1").catch(() => sinFilas),
  ]);
  const esContador = opciones.esContador === true;
  return {
    compras: proveedores.total > 0,
    contabilidad: esContador || asientos.total > 0,
    libros: esContador || facturas.total > 0,
  };
}

/** Lo que acaba de pasar en la empresa y puede encender un módulo del menú. */
export type HechoDeModulo = "factura" | "recibo" | "asiento";

/**
 * ¿Hay que volver a sondear después de este hecho? La sonda se cachea cinco minutos: sin esto, la
 * dueña que emite su PRIMERA factura no vería Contabilidad ni Libros hasta que caducara. Solo se
 * resondea si el hecho puede encender algo que todavía está apagado — la venta mil no cuesta tres
 * GET más. Una factura deja documento fiscal y asiento; un recibo y un asiento posteado, asiento.
 * Sin sonda todavía (undefined) no hay nada que refrescar: la primera lectura ya verá el dato.
 */
export function debeResondear(actual: ModulosActivos | undefined, hecho: HechoDeModulo): boolean {
  if (actual === undefined) return false;
  if (hecho === "factura") return !actual.contabilidad || !actual.libros;
  return !actual.contabilidad;
}

/**
 * «¿Esta empresa tiene contabilidad configurada y esta persona puede leerla?» — la pregunta de
 * las PANTALLAS (el detalle de un documento, el tablero), que no es la del menú. Es lo que la
 * sonda respondía antes de A-04: hay plan de cuentas legible. Un 403 es «no es tuyo», no un error.
 */
export async function sondearContabilidadConfigurada(
  llamar: <T>(path: string) => Promise<T>,
): Promise<boolean> {
  const cuentas = await llamar<unknown[]>("/v1/accounts").catch(() => []);
  return cuentas.length > 0;
}

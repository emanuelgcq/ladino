export interface ModulosActivos {
  compras: boolean;
  contabilidad: boolean;
  libros: boolean;
}

/**
 * La SONDA de la divulgación progresiva, separada del shell para poder
 * testearla con un cajero puro. Cada `.catch` es semántica, no descuido:
 * varios de estos GET exigen permiso de lectura (`/v1/accounts` →
 * accounting.read, `/v1/fiscal-books/runs` → fiscal_book.read — cierre RBAC
 * del 2026-09-08), y para quien no lo tiene el 403 significa «este módulo no
 * es tuyo», jamás un error. La sonda no lanza NUNCA: la caja entra, vende y
 * no ve Administración — sin ruido en consola ni promesas sin capturar.
 */
export async function sondearModulosActivos(
  llamar: <T>(path: string) => Promise<T>,
): Promise<ModulosActivos> {
  const [proveedores, cuentas, generaciones] = await Promise.all([
    llamar<{ total: number }>("/v1/suppliers?per_page=1").catch(() => ({ total: 0 })),
    llamar<unknown[]>("/v1/accounts").catch(() => []),
    llamar<{ runs: unknown[] }>("/v1/fiscal-books/runs").catch(() => ({ runs: [] })),
  ]);
  const contabilidad = cuentas.length > 0;
  return {
    compras: proveedores.total > 0,
    contabilidad,
    libros: contabilidad || generaciones.runs.length > 0,
  };
}

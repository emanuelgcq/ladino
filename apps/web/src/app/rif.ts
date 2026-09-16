/**
 * LA REGLA (dueño, 2026-09-16): **si tienes RIF, das facturas; si NO tienes RIF, das
 * recibos.** Con RIF se ve todo lo fiscal, con su lenguaje técnico. Sin RIF: recibos,
 * lenguaje sencillo, y nada de IVA, alícuota ni nada fiscal.
 *
 * Módulo HOJA a propósito (sin imports): lo usan la sesión, el menú y las pantallas, y
 * ninguno de ellos puede importarse al revés.
 *
 * La pantalla decide con el RIF de la empresa, que ya viene en la sesión: no espera a
 * ninguna consulta, así que un campo de IVA no puede asomarse «mientras carga». Una empresa
 * sin RIF lleva el marcador `PEND-…` que le pone el registro (packages/domain onboarding.ts).
 * Antes la regla era «el modo es exactamente recibos», y una empresa sin RIF que no había
 * terminado Empezar veía el IVA, la alícuota y los libros.
 */
export function tieneRif(empresa: { readonly tax_id: string }): boolean {
  const rif = empresa.tax_id.trim();
  return rif !== "" && !rif.startsWith("PEND-");
}

/** Lo que se enseña bajo el nombre de una empresa: su RIF, o que todavía no lo tiene. */
export function rifParaMostrar(empresa: { readonly tax_id: string }): string {
  return tieneRif(empresa) ? empresa.tax_id : "Sin RIF";
}

/**
 * El sufijo de un archivo descargado: el RIF si lo hay; si no, el nombre del negocio en
 * minúsculas y sin espacios. Un «productos-PEND-01A0B1C2D3.csv» no le dice nada a nadie.
 */
export function sufijoDeArchivo(empresa: {
  readonly tax_id: string;
  readonly legal_name: string;
}): string {
  if (tieneRif(empresa)) return empresa.tax_id;
  const limpio = empresa.legal_name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return limpio === "" ? "mi-negocio" : limpio;
}

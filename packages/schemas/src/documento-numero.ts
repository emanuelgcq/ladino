/**
 * EL número de un documento junto a su serie, en UN solo sitio (ADR-0071, H11): la web, el dominio
 * y el PDF lo escriben igual. Con serie vacía (el papel no trae serie) no hay guion colgante:
 * `serieYNumero("", 12)` es «12», `serieYNumero("A", 12, 8)` es «A-00000012».
 *
 * Puro: sin I/O. `relleno` es el ancho con ceros a la izquierda (0 = sin rellenar).
 * VALIDAR-SENIAT (PENDIENTES_ASESOR): qué se imprime en el art. 13.2 cuando el papel no trae serie.
 */
export function serieYNumero(series: string, numero: number | string, relleno = 0): string {
  const n = relleno > 0 ? String(numero).padStart(relleno, "0") : String(numero);
  return series === "" ? n : `${series}-${n}`;
}

/**
 * El número como se IMPRIME en la forma libre (PA 00071 arts. 26-27; auditoría fiscal 2026-10-02):
 * con serie, el número va precedido de la palabra «Serie» — «Serie A N° 00000001» —; sin serie,
 * solo el número — «N° 00000001». La pantalla sigue escribiendo `serieYNumero` («A-00000001»).
 * VALIDAR-SENIAT (PENDIENTES_ASESOR P-54): con un sistema centralizado (art. 27), ¿hacen falta series?
 */
export function serieYNumeroImpreso(series: string, numero: number | string, relleno = 0): string {
  const n = relleno > 0 ? String(numero).padStart(relleno, "0") : String(numero);
  return series === "" ? `N° ${n}` : `Serie ${series} N° ${n}`;
}

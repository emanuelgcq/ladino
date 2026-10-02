import { serieYNumero } from "@ladino/schemas";

/**
 * El número de un documento tal como lo imprime el POS y el PDF:
 * `SERIE-00000012`, o `00000012` si el papel no trae serie (ADR-0071, H11: el formateador
 * único, sin guion colgante). Un borrador no tiene número y se dice.
 */
export function numeroDocumento(series: string, n: number | null | undefined): string {
  if (n === null || n === undefined) return "borrador";
  return serieYNumero(series, n, 8);
}

/**
 * El número de un documento tal como lo imprime el POS y el PDF:
 * `SERIE-00000012`. Un borrador no tiene número y se dice.
 */
export function numeroDocumento(series: string, n: number | null | undefined): string {
  if (n === null || n === undefined) return "borrador";
  return `${series}-${String(n).padStart(8, "0")}`;
}

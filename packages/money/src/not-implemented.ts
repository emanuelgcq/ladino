/**
 * Andamio de la fase roja de S0.2.
 *
 * Las firmas públicas existen para que los tests compilen y el rojo sea legible —31 propiedades
 * con nombre, no doscientos errores de "no exported member"—, pero **no hay una sola línea de
 * lógica**. Cada función lanza. ADR-0016: en `money` el test se escribe antes que la
 * implementación.
 *
 * Este fichero desaparece cuando la implementación esté completa.
 */
export function notImplemented(fn: string, ..._args: readonly unknown[]): never {
  throw new Error(
    `S0.2 fase roja: ${fn} todavía no está implementado. El test va primero (ADR-0016).`,
  );
}

/**
 * @ladino/worker — consumo del outbox y reapers.
 *
 * El arranque del proceso está en main.ts; esto exporta las piezas para
 * poder probarlas sin bucle ni señales.
 */
export { procesarLote, backoffSegundos } from "./outbox.js";
export { reaperOutbox, reaperIdempotencia, purgarIdempotencia } from "./reapers.js";
export const PACKAGE_NAME = "@ladino/worker" as const;

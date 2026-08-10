/**
 * @ladino/core — el kernel del monorepo. Cero dependencias (ADR-0021).
 *
 * Regla de admisión: algo entra aquí solo si lo necesitan al menos dos paquetes que no
 * pueden importarse entre sí. Nada de dinero, validación, I/O, logging ni configuración.
 */
export type { Brand } from "./brand.js";
export type { DomainError, Err, Ok, Result } from "./result.js";
export { all, andThen, err, isErr, isOk, map, mapErr, ok, unwrap, unwrapOr } from "./result.js";
export type { Instant } from "./instant.js";
export { compareInstants, INVALID_INSTANT, isInstant, parseInstant } from "./instant.js";

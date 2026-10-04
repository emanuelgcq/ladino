import { AsyncLocalStorage } from "node:async_hooks";

/**
 * EL ORIGEN DE UNA ESCRITURA (A-16, RESPUESTA §2.15): por dónde entró lo que se audita.
 *
 * Lo resuelve QUIEN RECIBE la petición —el middleware de la API, el arranque del worker— y lo
 * aterriza `withTransaction` como GUC locales a la transacción (`ladino.origin_*`), en la misma
 * sentencia que el actor. El trigger `audit_events_origin` (migración 20261004120000) los copia a
 * cada acta. Ningún caso de uso lo pasa ni lo ve: por eso viaja en un `AsyncLocalStorage` y no
 * como parámetro de las 227 llamadas a `withTransaction`.
 *
 * Es el mismo reparto que el actor: el middleware resuelve, quien abre la transacción aterriza.
 * Y la misma razón para no fijarlo con `set` de sesión: sobre un pool, sobreviviría a la petición.
 */
export interface Origin {
  /** `web` y `mobile` los declara el cliente (no son prueba); `api` es todo lo demás por HTTP. */
  readonly channel: "web" | "mobile" | "api" | "worker";
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  /** La sesión del JWT verificado (`session_id`), no un valor del cliente. */
  readonly sessionId?: string | null;
  readonly appBuild?: string | null;
}

const almacen = new AsyncLocalStorage<Origin>();

/** Ejecuta `fn` con ese origen: toda transacción abierta dentro lo lleva. */
export function withOrigin<T>(origin: Origin, fn: () => T): T {
  return almacen.run(origin, fn);
}

/** El origen vigente, o `undefined` fuera de `withOrigin`. */
export function currentOrigin(): Origin | undefined {
  return almacen.getStore();
}

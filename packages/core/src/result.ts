/**
 * Errores de dominio como valores, no como excepciones de control de flujo.
 * ENGINEERING_STANDARDS.md §Estructura del código.
 *
 * Los códigos de error son estables y forman parte del contrato: cambiarlos es un cambio
 * incompatible, igual que cambiar una firma.
 */

export interface DomainError {
  /** Código estable. Parte del contrato de la API. */
  readonly code: string;
  /** Mensaje para humanos, en español (UI). No es el contrato: el contrato es `code`. */
  readonly message: string;
  /** Contexto estructurado. Nunca secretos ni payload fiscal completo. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E extends DomainError = DomainError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E extends DomainError>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E extends DomainError>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function isErr<T, E extends DomainError>(r: Result<T, E>): r is Err<E> {
  return !r.ok;
}

export function map<T, U, E extends DomainError>(
  r: Result<T, E>,
  f: (value: T) => U,
): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}

export function mapErr<T, E extends DomainError, F extends DomainError>(
  r: Result<T, E>,
  f: (error: E) => F,
): Result<T, F> {
  return r.ok ? r : err(f(r.error));
}

export function andThen<T, U, E extends DomainError>(
  r: Result<T, E>,
  f: (value: T) => Result<U, E>,
): Result<U, E> {
  return r.ok ? f(r.value) : r;
}

export function unwrapOr<T, E extends DomainError>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/**
 * Colapsa una lista de Result en un Result de lista. Se queda con el PRIMER error.
 * Útil para validar líneas de un documento sin escribir el bucle a mano cada vez.
 */
export function all<T, E extends DomainError>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    values.push(r.value);
  }
  return ok(values);
}

/**
 * Extrae el valor o lanza. **Solo para tests y para el borde de la aplicación**, donde un
 * error ya se tradujo a respuesta HTTP. Usarlo dentro del dominio anula el propósito del tipo.
 */
export function unwrap<T, E extends DomainError>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw new Error(`unwrap sobre Err: ${r.error.code} — ${r.error.message}`);
}

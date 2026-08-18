import type { Sql, TransactionSql } from "postgres";

/**
 * Actor de una operación. Es lo que el middleware resuelve del JWT verificado y
 * deja en el contexto de la petición; NUNCA sale del payload.
 *
 * `kind: "system"` es trabajo de servidor sin usuario detrás (jobs, reproceso).
 * Ver `SYSTEM_ACTOR_ID` para dónde vale y dónde no.
 */
export type Actor =
  { readonly kind: "user"; readonly userId: string } | { readonly kind: "system" };

/**
 * Centinela para el trabajo de sistema sin usuario.
 *
 * ⚠ VALE EN UNAS COLUMNAS Y NO EN OTRAS, y la asimetría es deliberada:
 *
 *   · `idempotency_keys.actor_id` — SÍ. No tiene FK a propósito. Es semántica de
 *     la clave («en nombre de quién se reserva»), y el trabajo de sistema
 *     necesita un valor EXPLÍCITO: un NULL ahí significaría «no me acordé».
 *   · `companies.created_by` — NO. Tiene FK a `auth.users`, así que el actor
 *     debe ser un usuario real. Es procedencia («quién hizo esto»), y atribuirla
 *     a un uuid que no corresponde a nadie es peor que dejarla nula.
 *
 * Consecuencia: un alta de company NO se puede ejecutar con actor de sistema.
 * Falla con `companies_created_by_fkey`, y es correcto que falle.
 *
 * Ver `docs/04_PLATFORM/API_SPEC.md` §El centinela de sistema.
 */
export const SYSTEM_ACTOR_ID = "00000000-0000-4000-8000-000000000000";

/** Lo que recibe un caso de uso: la transacción abierta y quién la abrió. */
export interface UnitOfWork {
  readonly sql: TransactionSql;
  readonly actor: Actor;
}

/**
 * Abre una transacción y fija el GUC de procedencia como PRIMERA sentencia.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTE ES EL ÚNICO PUNTO DE ENTRADA A LA BASE. Nadie llama al cliente
 * directamente, y la regla 13 de `.dependency-cruiser.cjs` lo verifica.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * POR QUÉ EL GUC SE FIJA AQUÍ Y NO EN EL MIDDLEWARE
 *
 * `set local` tiene alcance de TRANSACCIÓN. Fijarlo en el middleware —antes de
 * que la transacción exista— es una de dos cosas, y las dos malas:
 *
 *   · inútil, si luego se abre una transacción distinta: el valor no viaja;
 *   · peligroso, si se hace con `set` de sesión sobre un pool compartido: el
 *     actor de una petición SOBREVIVE a la conexión y contamina la siguiente,
 *     que puede ser de otro tenant. Filas de auditoría atribuidas al usuario
 *     equivocado, sin un solo error.
 *
 * Por eso el pooling va en MODO TRANSACCIÓN y el GUC es `set local`: en modo
 * transacción, `set local` no puede filtrar entre peticiones.
 *
 * El middleware resuelve el actor del JWT verificado y lo deja en el contexto.
 * Quien abre la transacción lo aterriza. Son dos responsabilidades distintas.
 *
 * POR QUÉ ESTO HACE IMPOSIBLE OLVIDAR EL GUC
 *
 * `set_row_provenance()` deja `created_by` en NULL EN SILENCIO si el GUC no
 * está: sin error, con `201` de vuelta, y el vacío aparece meses después en una
 * auditoría sobre datos que ya no se pueden reconstruir. Es el peor modo de
 * fallo que hay para una pista de auditoría.
 *
 * Un contrato documentado no basta —`CLAUDE.md` §2: ausencia de mecanismo no es
 * prohibición—. Al ser este helper la única forma de llegar a la base, olvidar
 * el GUC deja de ser improbable y pasa a ser imposible.
 */
export async function withTransaction<T>(
  sql: Sql,
  actor: Actor,
  fn: (uow: UnitOfWork) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    // PRIMERA sentencia de la transacción, sin excepción. Cualquier cosa que
    // escriba antes de esto queda sin autor.
    //
    // `set_config(..., true)` es el equivalente de `SET LOCAL` en forma de
    // función, que es lo que permite parametrizar el valor sin interpolarlo en
    // el texto del SQL: `SET LOCAL` no admite parámetros de bind.
    const actorId = actor.kind === "user" ? actor.userId : SYSTEM_ACTOR_ID;
    await tx`select set_config('ladino.actor_id', ${actorId}, true)`;

    return fn({ sql: tx, actor });
  }) as Promise<T>;
}

/**
 * Crea el cliente. **Solo lo llama la composición raíz de una app** (`apps/api`,
 * `apps/worker`), y el resultado se pasa a `withTransaction`.
 *
 * El `import` real de `postgres` vive en `./client.ts` y **en ningún otro sitio
 * del repositorio**: es lo que la regla `db-client-only-in-db-package` del gate
 * de fronteras verifica.
 *
 * `prepare: false` NO ES OPCIONAL con pooling en modo transacción: los prepared
 * statements viven en la SESIÓN, y en modo transacción la sesión no pertenece a
 * la petición. Con `prepare: true` el fallo es intermitente y desconcertante
 * —«prepared statement ya existe», solo bajo carga—, que es la peor forma de
 * fallar: la que no se reproduce en desarrollo.
 */
export { createClient } from "./client.js";

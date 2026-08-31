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
 * Envuelve el `err` devuelto por un caso de uso para forzar el ROLLBACK, y lo
 * transporta intacto al otro lado. No es un error de programa: es el mecanismo.
 */
class RollbackPorError extends Error {
  constructor(readonly resultado: unknown) {
    super("el caso de uso devolvió err: se revierte la transacción");
  }
}

/**
 * ¿Es un `Result` en fallo? Se comprueba por FORMA y no importando `Result` de
 * `@ladino/core`: `packages/db` no depende de core (tabla de fronteras), y
 * hacerlo por una comprobación de tipo sería invertir esa dependencia.
 *
 * La comprobación es estrecha a propósito —`ok === false` **y** propiedad
 * `error`— para no confundirla con una fila de consulta que traiga `ok`, como
 * las de `ladino_user_has_permission(...) as ok`.
 */
function esErr(v: unknown): boolean {
  return typeof v === "object" && v !== null && "ok" in v && v.ok === false && "error" in v;
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
 *
 * ── Y DESDE 2026-08-28, ADEMÁS ────────────────────────────────────────────
 *
 * ⚠ UN CASO DE USO QUE DEVUELVE `err` NO OCURRIÓ: se revierte.
 *
 * Hasta 2026-08-28 esto no era así, y es el defecto más caro que ha tenido el
 * proyecto. `sql.begin()` COMMITEA cuando la promesa resuelve, sin mirar el
 * valor; devolver `err` resolvía la promesa. O sea que un caso de uso podía
 * responder 409 y dejar escrito lo que había hecho antes del fallo.
 *
 * Pasó de verdad: `registerSupplierInvoice` creaba la factura, la retención se
 * rechazaba, la API contestaba 409 y **la factura quedaba en la tabla**. El
 * E2E de compras miraba la respuesta y cuadraba. Los pgTAP miraban tablas
 * aisladas y también. Lo cazó una consulta cross-módulo —el invariante de
 * cobertura de ADR-0042— preguntando «¿todos los documentos tienen asiento o
 * fila en cola?». Una auditoría posterior encontró el MISMO patrón en otras
 * treinta y cinco funciones: factura emitida sin kardex, recepción confirmada
 * sin movimiento, devolución sin líneas.
 *
 * Que un caso de uso pueda decir «hubo error» y aun así commitear es lo
 * contrario de lo que significa «transacción». Ahora `err` revierte.
 *
 * **Consecuencia deliberada:** lo escrito antes del fallo desaparece, incluida
 * la auditoría de un hecho que no ocurrió — que es lo correcto. Si algún caso
 * de uso necesitara de verdad persistir algo pese a fallar, tiene que hacerlo
 * en OTRA transacción y decir por qué; no puede conseguirlo por descuido.
 */
export async function withTransaction<T>(
  sql: Sql,
  actor: Actor,
  fn: (uow: UnitOfWork) => Promise<T>,
): Promise<T> {
  try {
    return (await sql.begin(async (tx) => {
      // PRIMERA sentencia de la transacción, sin excepción. Cualquier cosa que
      // escriba antes de esto queda sin autor.
      //
      // `set_config(..., true)` es el equivalente de `SET LOCAL` en forma de
      // función, que es lo que permite parametrizar el valor sin interpolarlo en
      // el texto del SQL: `SET LOCAL` no admite parámetros de bind.
      const actorId = actor.kind === "user" ? actor.userId : SYSTEM_ACTOR_ID;
      await tx`select set_config('ladino.actor_id', ${actorId}, true)`;

      const resultado = await fn({ sql: tx, actor });
      // Lanzar es lo ÚNICO que revierte en postgres.js. El valor viaja dentro
      // de la excepción para devolverlo tal cual: el llamante ve su `err`
      // original, con su código y su mensaje, y no sabe que hubo un rollback.
      if (esErr(resultado)) throw new RollbackPorError(resultado);
      return resultado;
    })) as T;
  } catch (e) {
    if (e instanceof RollbackPorError) return e.resultado as T;
    throw e;
  }
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

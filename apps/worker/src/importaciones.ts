import { withTransaction, type Sql } from "@ladino/db";
import { procesarTrabajoImportacion } from "@ladino/domain";
import { backoffSegundos } from "./outbox.js";

/**
 * TRABAJOS DE IMPORTACIÓN DE PRODUCTOS (ADR-0074, C-04). El worker toma el trabajo pendiente más
 * antiguo y lo avanza fila a fila con el paso del DOMINIO (`procesarTrabajoImportacion`): cada
 * fila en su transacción, como el usuario que subió el archivo, con el avance del contador en la
 * misma transacción. Reintentar es seguro por construcción — no hay nada que deduplicar aquí.
 *
 * Lo que es del worker es solo la contabilidad de FALLOS INESPERADOS (la base caída, un bug): un
 * error que no es una fila rechazada suma `attempts` y deja `last_error`; al `MAX_INTENTOS` el
 * trabajo pasa a `failed`, visible en la web con su motivo. `attempts` vuelve a cero cada vez que
 * el trabajo avanza (H1-c), así que lo que mata un trabajo son cinco caídas SEGUIDAS, no cinco
 * repartidas a lo largo de un archivo largo.
 *
 * BACKOFF (A5): tras un fallo, `next_attempt_at` aplaza el reintento con el backoff exponencial y
 * jitter del outbox; el worker no toma el trabajo antes.
 *
 * `presupuestoMs` acota una vuelta del bucle por TIEMPO (H10): la vuelta tiene que seguir
 * latiendo, y una fila con existencia cuesta ~200 ms pero puede costar más con la base cargada.
 * El resto queda para la siguiente vuelta.
 *
 * MÉTRICA (apps/worker/CLAUDE.md: «profundidad de cola»): `en_cola` es cuántos trabajos quedan
 * pendientes o en curso, y sale en el log del ciclo como las demás cifras del worker.
 */
export const MAX_INTENTOS_IMPORTACION = 5;

export interface ResultadoImportaciones {
  trabajo: string | null;
  procesadas: number;
  terminado: boolean;
  fallo: string | null;
  /** Profundidad de la cola: trabajos pending/running que se pueden reintentar. */
  en_cola: number;
}

export async function procesarImportaciones(
  sql: Sql,
  opciones: {
    presupuestoMs?: number;
    maxFilas?: number;
    /** Solo este trabajo (los tests, que comparten la base con otros suites). */
    trabajo?: string;
  } = {},
): Promise<ResultadoImportaciones> {
  const hastaMs = Date.now() + (opciones.presupuestoMs ?? 5_000);
  const [cola] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.product_import_jobs
     where status in ('pending', 'running') and attempts < ${MAX_INTENTOS_IMPORTACION}`;
  const enCola = cola?.n ?? 0;
  const [siguiente] = opciones.trabajo
    ? await sql<{ id: string; created_by: string; attempts: number }[]>`
        select id, created_by, attempts from public.product_import_jobs
         where id = ${opciones.trabajo} and status in ('pending', 'running')
           and attempts < ${MAX_INTENTOS_IMPORTACION}
           and (next_attempt_at is null or next_attempt_at <= now())`
    : await sql<{ id: string; created_by: string; attempts: number }[]>`
        select id, created_by, attempts from public.product_import_jobs
         where status in ('pending', 'running') and attempts < ${MAX_INTENTOS_IMPORTACION}
           and (next_attempt_at is null or next_attempt_at <= now())
         order by created_at
         limit 1`;
  if (!siguiente) {
    return { trabajo: null, procesadas: 0, terminado: false, fallo: null, en_cola: enCola };
  }
  try {
    const r = await procesarTrabajoImportacion(sql, siguiente.id, siguiente.created_by, {
      hastaMs,
      ...(opciones.maxFilas === undefined ? {} : { maxFilas: opciones.maxFilas }),
    });
    return { trabajo: siguiente.id, ...r, fallo: null, en_cola: enCola };
  } catch (e) {
    const mensaje = String((e as Error).message ?? e).slice(0, 2000) || "error desconocido";
    // A5: el reintento espera un backoff exponencial con jitter (el mismo del outbox), no la vuelta
    // siguiente: una base caída no se martillea cada 2 s.
    const espera = backoffSegundos(siguiente.attempts + 1);
    await withTransaction(sql, { kind: "system" }, async ({ sql: tx }) => {
      await tx`
        update public.product_import_jobs
           set attempts = attempts + 1,
               last_error = ${mensaje},
               next_attempt_at = now() + make_interval(secs => ${espera}),
               status = case when attempts + 1 >= ${MAX_INTENTOS_IMPORTACION}
                             then 'failed' else status end,
               finished_at = case when attempts + 1 >= ${MAX_INTENTOS_IMPORTACION}
                                  then now() else finished_at end
         where id = ${siguiente.id} and status in ('pending', 'running')`;
    });
    return {
      trabajo: siguiente.id,
      procesadas: 0,
      terminado: false,
      fallo: mensaje,
      en_cola: enCola,
    };
  }
}

import { withTransaction, type Sql } from "@ladino/db";
import { backoffSegundos } from "./outbox.js";

/**
 * LOS REAPERS — los procesos que S0.4 dejó sin dueño, los dos primeros de
 * DISPONIBILIDAD del camino crítico. Ninguno es de corrección: sin ellos no se
 * duplica nada, pero se BLOQUEA algo. El tercero (la purga) es de retención.
 *
 * Los dos primeros comparten forma: una fila quedó en un estado transitorio
 * porque el proceso que la tenía murió entre sus dos fases. Un estado
 * transitorio con más de N minutos no es una operación lenta: es un cadáver.
 * Se devuelve al estado desde el que se puede reintentar.
 *
 * INVARIANTES DE UMBRAL, los dos escritos donde se leen:
 *   · outbox: `minutosHuerfana` (10) > `timeoutMs` de la entrega (5 min). Una
 *     entrega viva nunca parece huérfana. Segunda capa: el testigo `attempts`
 *     de outbox.ts.
 *   · idempotencia: `minutosHuerfana` (15) ≫ timeout de petición de la API
 *     (30 s, config.ts). Una petición viva nunca parece huérfana. Segunda
 *     capa: la guarda `status = 'in_progress'` del T2 de la API.
 */
export interface OpcionesReaper {
  /** Minutos en estado transitorio a partir de los cuales una fila se considera huérfana. */
  readonly minutosHuerfana?: number;
  readonly maxIntentos?: number;
}

/**
 * Outbox: `in_flight` huérfano → `pending` (o `dead` si agotó intentos).
 *
 * El índice `outbox_in_flight_idx` existe desde S0.4 «para encontrar lo que un
 * worker muerto dejó colgado», y este es el proceso que lo recorre. La marca
 * de tiempo es `available_at`, que T1 fija a now() al tomar la fila (ver
 * outbox.ts sobre el doble papel de esa columna).
 *
 * La devolución lleva BACKOFF por intentos, no `now()`: un evento venenoso
 * que cuelga al worker no se vuelve a tomar en caliente en cuanto se repone
 * (F-13 de la auditoría de S0.6a).
 */
export async function reaperOutbox(
  sql: Sql,
  opciones: OpcionesReaper = {},
): Promise<{ devueltas: number; muertas: number }> {
  const minutos = opciones.minutosHuerfana ?? 10;
  const maxIntentos = opciones.maxIntentos ?? 8;

  return withTransaction(sql, { kind: "system" }, async ({ sql: tx }) => {
    const muertas = await tx<{ id: string }[]>`
      update public.outbox
         set status = 'dead',
             last_error = coalesce(last_error, '') || ' [reaper: in_flight huérfano, intentos agotados]'
       where status = 'in_flight'
         and available_at < now() - make_interval(mins => ${minutos})
         and attempts >= ${maxIntentos}
      returning id`;
    const huerfanas = await tx<{ id: string; attempts: number }[]>`
      select id, attempts from public.outbox
       where status = 'in_flight'
         and available_at < now() - make_interval(mins => ${minutos})
       for update skip locked`;
    for (const h of huerfanas) {
      const espera = backoffSegundos(h.attempts);
      await tx`
        update public.outbox
           set status = 'pending',
               available_at = now() + make_interval(secs => ${espera}),
               last_error = coalesce(last_error, '') || ' [reaper: in_flight huérfano, devuelta]'
         where id = ${h.id}`;
    }
    return { devueltas: huerfanas.length, muertas: muertas.length };
  });
}

/**
 * Idempotencia: `in_progress` huérfano → `failed`.
 *
 * Es el reaper que ADR-0018 (enmendado) exige con el protocolo de dos
 * transacciones: un proceso que muere entre T1 y T2 deja la clave clavada y
 * BLOQUEA el reintento legítimo del cliente —409 IN_PROGRESS— hasta
 * `expires_at`, es decir, 24 h. En emisión fiscal eso es «no puedo emitir el
 * documento». Este reaper acorta la ventana a `minutosHuerfana`.
 *
 * `failed` es el estado correcto y no `completed`: no sabemos si el efecto se
 * hizo. El reintento del cliente reejecuta el cuerpo, y lo que impide el doble
 * efecto si SÍ se hizo es la clave natural única del esquema — el borde
 * documentado en idempotency.ts. La `response` deja rastro de que fue el
 * reaper, no el caso de uso, quien cerró la clave.
 *
 * Libera también las CADUCADAS (`expires_at` pasado): antes exigía
 * `expires_at > now()` y una clave clavada que caducaba se quedaba
 * `in_progress` para siempre (F-12). Marcarla `failed` es inocuo —T1 ya
 * reclama las caducadas— y deja la tabla en un estado que la purga entiende.
 */
export async function reaperIdempotencia(
  sql: Sql,
  opciones: OpcionesReaper = {},
): Promise<{ liberadas: number }> {
  const minutos = opciones.minutosHuerfana ?? 15;

  return withTransaction(sql, { kind: "system" }, async ({ sql: tx }) => {
    const liberadas = await tx<{ id: string }[]>`
      update public.idempotency_keys
         set status = 'failed',
             response = ${tx.json({
               status: 503,
               body: { code: "IDEMPOTENCY_ORPHANED", message: "liberada por el reaper" },
             })}
       where status = 'in_progress'
         and created_at < now() - make_interval(mins => ${minutos})
      returning id`;
    return { liberadas: liberadas.length };
  });
}

export interface OpcionesPurga {
  /** Días tras `expires_at` a partir de los cuales la clave se borra. */
  readonly diasRetencion?: number;
  readonly lote?: number;
}

/**
 * Purga de claves de idempotencia caducadas. `idempotency_keys` NO es
 * append-only (ADR-0026): guarda `request_hash` y la `response` completa de
 * cada operación crítica, y sin purga crece sin cota y retiene datos de
 * cliente sin política (F-12). Retención: `expires_at` + 7 días por defecto —
 * bastante más que cualquier ventana de reintento razonable, y escrita en
 * SECURITY.md. Por lotes, para no bloquear la tabla con un DELETE masivo.
 */
export async function purgarIdempotencia(
  sql: Sql,
  opciones: OpcionesPurga = {},
): Promise<{ borradas: number }> {
  const dias = opciones.diasRetencion ?? 7;
  const lote = opciones.lote ?? 1000;

  return withTransaction(sql, { kind: "system" }, async ({ sql: tx }) => {
    const borradas = await tx<{ id: string }[]>`
      delete from public.idempotency_keys
       where id in (
         select id from public.idempotency_keys
          where expires_at < now() - make_interval(days => ${dias})
          limit ${lote}
       )
      returning id`;
    return { borradas: borradas.length };
  });
}

import { withTransaction, type Sql } from "@ladino/db";
import type { SeniatTransmitter, EventoOutbox } from "@ladino/fiscal";

/**
 * Consumo del outbox — la mitad asíncrona del patrón de ADR-0005.
 *
 * DOS FASES, igual que la idempotencia de la API y por la misma razón: la
 * entrega puede ser un viaje externo (SENIAT, imprenta) y no puede vivir
 * dentro de una transacción de base de datos.
 *
 *   T1  toma hasta N filas `pending` con FOR UPDATE SKIP LOCKED, las marca
 *       `in_flight`, incrementa `attempts` y COMMITEA. Es el pickup que
 *       `scripts/outbox-concurrency.mjs` prueba bajo carga real: dos workers
 *       no se llevan la misma fila.
 *   —   entrega, fuera de transacción y CON PLAZO (ver abajo).
 *   T2  `published` con `published_at`, o vuelta a `pending` con backoff, o
 *       `dead` al agotar intentos. Los CHECK de coherencia del esquema son el
 *       detector de carrera activo (S0.4): un estado incoherente no se puede
 *       escribir.
 *
 * At-least-once: si el proceso muere entre T1 y T2, la fila queda `in_flight`
 * y la recoge el reaper (reapers.ts). Todo consumidor es idempotente
 * (ADR-0005); el NullTransmitter lo es trivialmente.
 *
 * `available_at` cumple DOS papeles y conviene saberlo: para `pending` es «no
 * antes de» (el backoff); para `in_flight` se fija a now() al tomar la fila y
 * hace de «tomada en», que es lo que el reaper necesita para detectar filas
 * huérfanas. No hay columna `claimed_at` y añadirla es una migración: si el
 * doble papel se vuelve confuso, ese es el arreglo.
 *
 * TESTIGO DE RESERVA (F-9 de la auditoría de S0.6a). `status = 'in_flight'`
 * en T2 no dice DE QUIÉN es ese in_flight: si el reaper devolvió la fila a
 * `pending` (porque la entrega tardó más que su umbral) y otro worker la
 * tomó, el T2 tardío del primero pisaría la reserva viva del segundo. Por
 * eso T2 exige además `attempts = <el valor que T1 me dio>`: cada toma
 * incrementa `attempts`, así que el número identifica la reserva. Un T2 que
 * no afecta filas ha perdido su reserva: se registra `worker.claim_lost` y
 * NO se cuenta. Y la entrega tiene plazo (`timeoutMs`, 5 min por defecto)
 * ESTRICTAMENTE menor que el umbral del reaper (10 min), para que el caso
 * sea imposible por construcción y el testigo sea la segunda capa.
 */
export interface OpcionesOutbox {
  readonly lote?: number;
  readonly maxIntentos?: number;
  /** Plazo de cada entrega. Debe ser menor que `minutosHuerfana` del reaper. */
  readonly timeoutMs?: number;
}

export interface ResultadoLote {
  publicados: number;
  reintentos: number;
  muertos: number;
  /** T2 que no aplicó porque otro proceso ya tenía la fila. Siempre debería ser 0. */
  reservasPerdidas: number;
}

interface Fila {
  id: string;
  tenant_id: string;
  company_id: string | null;
  event_type: string;
  schema_version: number;
  payload: unknown;
  attempts: number;
}

/** Backoff exponencial con jitter (ADR-0005): 2^n segundos, ±25 %, techo 1 h. */
export function backoffSegundos(intento: number, aleatorio: () => number = Math.random): number {
  const base = Math.min(2 ** intento, 3600);
  const jitter = 1 + (aleatorio() - 0.5) * 0.5;
  return Math.round(base * jitter);
}

async function entregarConPlazo(
  transmitter: SeniatTransmitter,
  evento: EventoOutbox,
  timeoutMs: number,
): Promise<string | null> {
  const control = new AbortController();
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      transmitter.transmit(evento, control.signal),
      new Promise<never>((_, reject) => {
        temporizador = setTimeout(() => {
          control.abort();
          reject(new Error(`entrega sin respuesta en ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    ]);
    return null;
  } catch (e) {
    return String((e as Error).message ?? e).slice(0, 1000);
  } finally {
    clearTimeout(temporizador);
  }
}

export async function procesarLote(
  sql: Sql,
  transmitter: SeniatTransmitter,
  opciones: OpcionesOutbox = {},
): Promise<ResultadoLote> {
  const lote = opciones.lote ?? 50;
  const maxIntentos = opciones.maxIntentos ?? 8;
  const timeoutMs = opciones.timeoutMs ?? 5 * 60_000;

  // ── T1: tomar ──────────────────────────────────────────────────────────────
  const tomadas = await withTransaction(sql, { kind: "system" }, async ({ sql: tx }) => {
    return tx<Fila[]>`
      with candidatas as (
        select id from public.outbox
         where status = 'pending' and available_at <= now()
         order by available_at, id
         for update skip locked
         limit ${lote}
      )
      update public.outbox o
         set status = 'in_flight', attempts = o.attempts + 1, available_at = now()
        from candidatas c
       where o.id = c.id
      returning o.id, o.tenant_id, o.company_id, o.event_type, o.schema_version,
                o.payload, o.attempts`;
  });

  const resultado: ResultadoLote = {
    publicados: 0,
    reintentos: 0,
    muertos: 0,
    reservasPerdidas: 0,
  };

  for (const fila of tomadas) {
    const evento: EventoOutbox = {
      id: fila.id,
      tenantId: fila.tenant_id,
      companyId: fila.company_id,
      eventType: fila.event_type,
      schemaVersion: fila.schema_version,
      payload: fila.payload,
    };

    // ── entrega, FUERA de transacción y con plazo ───────────────────────────
    const error = await entregarConPlazo(transmitter, evento, timeoutMs);

    // ── T2: cerrar SOLO la reserva propia ──────────────────────────────────
    const aplicadas = await withTransaction(sql, { kind: "system" }, async ({ sql: tx }) => {
      if (error === null) {
        return tx<{ id: string }[]>`
          update public.outbox
             set status = 'published', published_at = now()
           where id = ${fila.id} and status = 'in_flight' and attempts = ${fila.attempts}
          returning id`;
      }
      if (fila.attempts >= maxIntentos) {
        return tx<{ id: string }[]>`
          update public.outbox
             set status = 'dead', last_error = ${error}
           where id = ${fila.id} and status = 'in_flight' and attempts = ${fila.attempts}
          returning id`;
      }
      const espera = backoffSegundos(fila.attempts);
      return tx<{ id: string }[]>`
        update public.outbox
           set status = 'pending', last_error = ${error},
               available_at = now() + make_interval(secs => ${espera})
         where id = ${fila.id} and status = 'in_flight' and attempts = ${fila.attempts}
        returning id`;
    });

    if (aplicadas.length === 0) {
      resultado.reservasPerdidas += 1;
      console.error(
        JSON.stringify({
          nivel: "error",
          evento: "worker.claim_lost",
          outbox_id: fila.id,
          attempts: fila.attempts,
          resultado_entrega: error === null ? "ok" : "error",
        }),
      );
    } else if (error === null) resultado.publicados += 1;
    else if (fila.attempts >= maxIntentos) resultado.muertos += 1;
    else resultado.reintentos += 1;
  }

  return resultado;
}

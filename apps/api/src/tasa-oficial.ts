/**
 * REFRESCO AUTOMÁTICO de la tasa oficial (orden del dueño, 2026-09-05): la
 * tasa BCV se actualiza sola PARA TODOS los tenants — `exchange_rates` es
 * global, una fila sirve a todo el mundo — y la BASE es la caché: cada tick
 * pregunta primero si la tasa del día (día Caracas, el MISMO corte que el
 * `es_de_hoy` del resumen) ya está guardada, y solo si falta hace UNA llamada
 * a DolarAPI y la persiste. Miles de usuarios, cero llamadas extra: la fuente
 * se toca a lo sumo una vez por tick de un solo proceso.
 *
 * El botón manual (POST /v1/exchange-rates/bcv) y la carga manual (ADR-0028)
 * siguen intactos: son el fallback con la fuente caída o sin internet.
 */
import type { createClient } from "@ladino/db";
import { tasaOficialBcv, BcvNoDisponible, type BcvConfig } from "./bcv.js";

type Sql = ReturnType<typeof createClient>;
type Log = (nivel: "info" | "error", evento: string, extra?: Record<string, unknown>) => void;

export type ResultadoRefresco =
  /** La tasa de hoy ya estaba en la base: NO se tocó la fuente. */
  | "ya_estaba"
  /** Se llamó a la fuente y su publicación quedó guardada (fila nueva). */
  | "guardada"
  /** Se llamó a la fuente y su publicación ya estaba (fin de semana: DolarAPI
   *  repite el último día hábil, y esa fila ya existe). */
  | "publicacion_repetida"
  /** La fuente no respondió o respondió basura. El fallback manual sigue. */
  | "sin_fuente";

/**
 * Asegura la tasa oficial del día: base primero, fuente solo si falta, insert
 * idempotente por (par, fuente, día) — el mismo del endpoint manual. NUNCA
 * lanza: el refresco es mejor-esfuerzo y quien decide sigue siendo el que
 * emite (sin tasa, no hay emisión — regla de ventas).
 */
export async function asegurarTasaOficial(sql: Sql, bcv: BcvConfig): Promise<ResultadoRefresco> {
  const [hay] = await sql<{ ok: boolean }[]>`
    select exists (
      select 1 from public.exchange_rates
       where from_currency = 'USD' and to_currency = 'VES'
         and rate_date = (now() at time zone 'America/Caracas')::date
    ) as ok`;
  if (hay?.ok === true) return "ya_estaba";

  let tasa;
  try {
    tasa = await tasaOficialBcv(bcv);
  } catch (e) {
    if (e instanceof BcvNoDisponible) return "sin_fuente";
    throw e;
  }

  // La MISMA fuente citada que el botón manual: quien lea el documento no
  // distingue si la tasa la trajo una persona o el refresco — y no debe.
  const fuente = `BCV oficial vía DolarAPI (${tasa.actualizada})`;
  const [insertada] = await sql<{ id: string }[]>`
    insert into public.exchange_rates
      (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
    values ('USD', 'VES', ${tasa.rate}, ${fuente}, ${tasa.rateDate}::date, now())
    on conflict on constraint exchange_rates_day_key do nothing
    returning id`;
  return insertada ? "guardada" : "publicacion_repetida";
}

/**
 * Arranca el refresco periódico: un intento al arrancar y uno por intervalo,
 * en un solo vuelo (un tick lento no se solapa con el siguiente) y con el
 * timer en `unref` — el refresco jamás mantiene vivo el proceso ni estorba
 * el apagado ordenado. Devuelve la función que lo detiene.
 */
export function iniciarRefrescoBcv(
  sql: Sql,
  bcv: BcvConfig,
  opts: { intervaloMs?: number; log?: Log } = {},
): () => void {
  const intervaloMs = opts.intervaloMs ?? 30 * 60_000;
  const log: Log = opts.log ?? (() => {});
  let enVuelo = false;

  const tick = async (): Promise<void> => {
    if (enVuelo) return;
    enVuelo = true;
    try {
      const resultado = await asegurarTasaOficial(sql, bcv);
      if (resultado === "guardada") log("info", "api.bcv_refresh_saved");
      else if (resultado === "sin_fuente") log("error", "api.bcv_refresh_source_down");
    } catch (e) {
      // Un fallo del refresco no puede tumbar el servidor: se registra y el
      // siguiente tick lo reintenta. El botón manual sigue existiendo.
      log("error", "api.bcv_refresh_failed", { error: String(e) });
    } finally {
      enVuelo = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervaloMs);
  timer.unref();
  return () => clearInterval(timer);
}

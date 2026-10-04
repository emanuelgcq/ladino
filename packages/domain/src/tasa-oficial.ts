import type { TransactionSql } from "@ladino/db";

/**
 * GUARDAR LA TASA OFICIAL DEL BCV, CON SU ACTA (B-14, RESPUESTA §2.15).
 *
 * De esta fila salen todas las conversiones del día de todos los inquilinos: es una operación
 * auditable. La tasa es de la PLATAFORMA (`company_id` nulo), así que su acta no cabe en
 * `audit_events` —que exige inquilino— y va a `system_audit_events` (migración 20261004120000):
 * actor `system`, URL de origen, hora de captura, valor y hash de la respuesta de la fuente.
 *
 * La regla vive aquí y no en quien llama: el refresco automático y el botón «Traer del BCV»
 * guardan por esta función, y los dos dejan la misma acta. Quien llama abre la transacción con
 * el actor de SISTEMA (ADR-0057: es el único al que la RLS deja escribir una tasa global).
 *
 * La misma publicación dos veces es UN hecho (el único por par, fuente y día): la segunda no
 * inserta ni deja acta, y devuelve la fila que ya estaba.
 */
export interface TasaOficialCapturada {
  /** La tasa como string decimal, tal como vino de la fuente. */
  readonly rate: string;
  /** El día publicado (YYYY-MM-DD, Caracas). */
  readonly rateDate: string;
  /** El instante publicado por la fuente, para la fuente citada. */
  readonly actualizada: string;
  /** La URL exacta que se consultó. */
  readonly sourceUrl: string;
  /** Cuándo respondió la fuente (ISO 8601). */
  readonly capturedAt: string;
  /** SHA-256 (hex) del cuerpo crudo de la respuesta. */
  readonly responseSha256: string;
}

export interface FilaTasaOficial {
  readonly id: string;
  readonly from_currency: string;
  readonly to_currency: string;
  readonly rate: string;
  readonly source: string;
  readonly rate_date: string;
}

export async function guardarTasaOficial(
  sql: TransactionSql,
  tasa: TasaOficialCapturada,
  opciones: {
    /** `refresh` = el refresco automático; `button` = a demanda. */
    readonly trigger: "refresh" | "button";
    /** La persona que pulsó «Traer del BCV», si la hubo. */
    readonly requestedBy?: string | null;
  },
): Promise<{ fila: FilaTasaOficial; nueva: boolean }> {
  // La MISMA fuente citada para el refresco y para el botón: quien lea el documento no
  // distingue cómo llegó la tasa — y no debe. Eso lo dice el acta.
  const fuente = `BCV oficial vía DolarAPI (${tasa.actualizada})`;
  const [insertada] = await sql<FilaTasaOficial[]>`
    insert into public.exchange_rates
      (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
    values ('USD', 'VES', ${tasa.rate}, ${fuente}, ${tasa.rateDate}::date, now())
    on conflict on constraint exchange_rates_day_key do nothing
    returning id, from_currency, to_currency, rate::text as rate, source,
              rate_date::text as rate_date`;
  if (!insertada) {
    const [existente] = await sql<FilaTasaOficial[]>`
      select id, from_currency, to_currency, rate::text as rate, source,
             rate_date::text as rate_date
        from public.exchange_rates
       where from_currency = 'USD' and to_currency = 'VES' and company_id is null
         and source = ${fuente} and rate_date = ${tasa.rateDate}::date`;
    return { fila: existente!, nueva: false };
  }
  await sql`
    insert into public.system_audit_events
      (aggregate_type, aggregate_id, event_type, requested_by, occurred_at, payload)
    values ('exchange_rate', ${insertada.id}, 'fx.rate.captured',
            ${opciones.requestedBy ?? null}, now(),
            ${sql.json({
              from_currency: "USD",
              to_currency: "VES",
              rate: insertada.rate,
              rate_date: insertada.rate_date,
              source: fuente,
              source_url: tasa.sourceUrl,
              published_at: tasa.actualizada,
              captured_at: tasa.capturedAt,
              response_sha256: tasa.responseSha256,
              trigger: opciones.trigger,
            })})`;
  return { fila: insertada, nueva: true };
}

/**
 * EL MENSAJE DE PERSONA DE `EXCHANGE_RATE_MISSING` (regla 8; migración 20261004195900).
 *
 * «La tasa del día» de una fecha es la oficial más reciente no posterior y no más antigua que el
 * margen de plataforma (`platform.rate_for`, la única regla). Cuando no la hay, la operación que
 * convierte se detiene y lo dice con el DÍA que le falta —el del hecho, no «hoy»—, que es lo que
 * la persona tiene que traer.
 *
 * `dia` y `hoy` son días de calendario `YYYY-MM-DD` (día de Caracas). Los dos los decide quien
 * llama: aquí no hay reloj. Lo que la persona puede HACER depende de cuál sea el día:
 *   · hoy: la tasa se trae en Mi dinero. Si se sabe de qué día es la última guardada
 *     (`ultimaGuardada`), se dice: «no hay tasa» era mentira cuando la hay y es vieja;
 *   · un día FUTURO: esa tasa todavía no se ha publicado y Mi dinero no puede traerla; se dice,
 *     y se manda a fechar la operación hoy o en un día con tasa;
 *   · un día PASADO: Mi dinero solo trae la publicada hoy (ADR-0064: no hay carga a mano), así
 *     que mandar allí sería prometer lo que no existe. Cargar la oficial de un día pasado es hoy
 *     una operación de plataforma sin pantalla (R-85, P-22): se dice lo que sí se puede hacer.
 */
export function mensajeFaltaTasa(dia: string, hoy: string, ultimaGuardada?: string | null): string {
  const d = dia.slice(0, 10);
  if (d < hoy.slice(0, 10)) {
    return `No hay tasa BCV guardada para el ${ddmmaaaa(d)}. Fecha la operación en un día con tasa, o escribe a soporte para cargar la oficial de ese día.`;
  }
  // Un día FUTURO. Ninguna validación rechaza antes una operación fechada más adelante (un gasto,
  // un pago o una factura de proveedor), así que llega hasta aquí cuando ese día queda más allá
  // del margen de la última guardada. Mi dinero trae la publicada HOY: no puede traer esa.
  if (d > hoy.slice(0, 10)) {
    return `La tasa BCV del ${ddmmaaaa(d)} todavía no se ha publicado: ese día aún no llega. Fecha la operación hoy o en un día que ya tenga tasa.`;
  }
  if (ultimaGuardada != null && ultimaGuardada !== "") {
    return `Falta la tasa BCV del ${ddmmaaaa(d)}: la última guardada es del ${ddmmaaaa(ultimaGuardada)}. Tráela en Mi dinero.`;
  }
  return `Falta la tasa BCV del ${ddmmaaaa(d)}. Tráela en Mi dinero.`;
}

function ddmmaaaa(dia: string): string {
  const [anio, mes, d] = dia.slice(0, 10).split("-");
  return `${d}/${mes}/${anio}`;
}

/**
 * El mismo mensaje, para quien solo tiene la conexión: pregunta a la base qué día es hoy en
 * Caracas y de qué día es la última oficial guardada del par (no posterior al día pedido), y lo
 * dice con `mensajeFaltaTasa`. Es para las vistas previas, que antes respondían «No hay tasa»
 * también cuando la había y estaba fuera del margen. Solo lee.
 *
 * Granularidad: `date` contra `date`; sin `dia`, el día de Caracas de ahora.
 */
export async function explicarFaltaDeTasa(
  sql: TransactionSql,
  desde: string,
  hasta: string,
  dia?: string | null,
): Promise<string> {
  const [f] = await sql<{ dia: string; hoy: string; ultima: string | null }[]>`
    select d.dia::text as dia, d.hoy::text as hoy,
           (select max(r.rate_date) from public.exchange_rates r
             where r.company_id is null and r.from_currency = ${desde}
               and r.to_currency = ${hasta} and r.rate_date <= d.dia)::text as ultima
      from (select h.hoy, coalesce(${dia ?? null}::date, h.hoy) as dia
              from (select (now() at time zone 'America/Caracas')::date as hoy) h) d`;
  return mensajeFaltaTasa(f!.dia, f!.hoy, f!.ultima);
}

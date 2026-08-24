/**
 * PUERTO de transmisión fiscal (ADR-0028). Aquí solo hay TIPOS y la
 * implementación nula: ninguna I/O, ninguna dependencia. El adaptador real
 * —cuando exista un régimen al que transmitir— vive fuera de este paquete,
 * que es puro (ADR-0021: fiscal no importa clientes HTTP ni de base).
 *
 * Contrato temporal del puerto, que el consumidor (apps/worker) hace cumplir:
 * una llamada a `transmit` tiene un PLAZO estrictamente menor que el umbral
 * del reaper del outbox (por defecto 5 min ≪ 10 min). Una entrega que dura
 * más se da por fallida y se reintenta con backoff; una entrega sin plazo
 * dejaría la fila `in_flight` hasta que el reaper la devolviera a `pending`
 * mientras el primer envío sigue vivo — dos entregas compitiendo por la misma
 * fila (F-9 de la auditoría de S0.6a). Los adaptadores reales deben, además,
 * honrar la señal de aborto que reciban.
 */
export interface EventoOutbox {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string | null;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly payload: unknown;
}

export interface SeniatTransmitter {
  /** Rechaza (lanza) si la entrega falla; el consumidor decide reintento o `dead`. */
  transmit(evento: EventoOutbox, señal?: AbortSignal): Promise<void>;
}

/**
 * La implementación CORRECTA del estado regulatorio actual: la PA 121 está
 * derogada sin sustituta (ADR-0027 §5, REGULATORY_STATUS.md), así que no hay
 * a quién transmitir. No es un stub que finge éxito en silencio: registra
 * cada evento que «entregó» a nadie, para que el día que exista un régimen la
 * cola de lo no transmitido sea visible y no una sorpresa.
 */
export class NullTransmitter implements SeniatTransmitter {
  /**
   * El sumidero de log es OBLIGATORIO, sin valor por defecto: un `console.log`
   * por defecto sería I/O escondida en un paquete puro. Quien compone (el
   * worker) decide dónde se escribe.
   */
  constructor(private readonly log: (linea: string) => void) {}

  transmit(evento: EventoOutbox): Promise<void> {
    this.log(
      JSON.stringify({
        nivel: "info",
        evento: "seniat.null_transmitter",
        outbox_id: evento.id,
        event_type: evento.eventType,
        tenant_id: evento.tenantId,
      }),
    );
    return Promise.resolve();
  }
}

/**
 * PUERTO de la IMPRENTA DIGITAL (PA 102, ADR-0045). Aquí solo hay TIPOS y la
 * implementación nula, como en el transmitter (ADR-0028): ninguna I/O,
 * ninguna dependencia — el adaptador real, cuando el operador elija imprenta
 * digital autorizada, vive fuera de este paquete (ADR-0021: fiscal es puro).
 *
 * Qué modela: bajo PA 102 la imprenta digital asigna el número de control
 * DOCUMENTO A DOCUMENTO (no por rangos preasignados). Es el modo
 * `per_document` de ADR-0037 — el documento se emite con `control_number`
 * NULL y se completa cuando la imprenta responde. El formato del control lo
 * fija el art. 30 de la PA 102: la expresión «N° de Control», un
 * identificador de DOS dígitos y un secuencial de HASTA OCHO dígitos,
 * arrancando en 00-1.
 *
 * VALIDAR-SENIAT: la lista vigente de imprentas digitales AUTORIZADAS no
 * está en este repositorio y no se inventa. Elegir proveedor es una decisión
 * del operador con esa lista en la mano; hasta entonces, el puerto rechaza.
 */

/** Lo que la imprenta necesita para asignar control a UN documento. */
export interface DocumentoParaControl {
  readonly documentId: string;
  readonly companyId: string;
  /** RIF del emisor, normalizado (sin separadores). */
  readonly issuerTaxId: string;
  readonly kind: "invoice" | "credit_note" | "debit_note" | "delivery_note";
  readonly series: string;
  /** Correlativo del emisor ya asignado (el control llega después: dos fases). */
  readonly documentNumber: string;
  readonly issuedAt: string;
  /** Total en moneda de transacción, como string decimal (regla 7). */
  readonly totalAmount: string;
  readonly transactionCurrency: string;
}

/** La asignación que responde la imprenta (PA 102 art. 30). */
export interface ControlAsignado {
  /**
   * El número de control COMPLETO como lo formó la imprenta: identificador de
   * dos dígitos + secuencial de hasta ocho (p. ej. «00-00000001»). String,
   * nunca number: el guion y los ceros a la izquierda son parte del dato.
   */
  readonly control_number: string;
  /** Cuándo lo asignó la imprenta (ISO 8601 con offset). */
  readonly assigned_at: string;
  /** RIF de la imprenta digital autorizada que respondió. */
  readonly print_shop_rif: string;
}

export interface DigitalPrintShopAdapter {
  /**
   * Pide el control para UN documento emitido (fase 2 de ADR-0037
   * `per_document`). Rechaza (lanza) si la imprenta no responde o responde
   * mal; el consumidor decide reintento o contingencia (PA 102: talonario
   * físico con la palabra «contingencia», migración 35). Debe honrar la
   * señal de aborto y responder DENTRO del plazo que el consumidor imponga.
   */
  assignControlNumber(
    documento: DocumentoParaControl,
    señal?: AbortSignal,
  ): Promise<ControlAsignado>;
}

/**
 * El formato del art. 30, verificable sin red: dos dígitos, guion, uno a ocho
 * dígitos. Exportado para que el consumidor valide TAMBIÉN lo que un adaptador
 * real devuelva — la imprenta es externa y su respuesta no se presume bien
 * formada.
 */
export const CONTROL_NUMBER_RE = /^\d{2}-\d{1,8}$/;

/**
 * La implementación CORRECTA del estado actual: no hay imprenta digital
 * elegida (decisión del operador sobre la lista autorizada vigente,
 * VALIDAR-SENIAT), así que el puerto RECHAZA con el motivo — nunca finge un
 * control, porque un número de control inventado es un documento fiscal
 * falso. Ningún régimen `per_document` puede habilitarse mientras el
 * adaptador sea este (ADR-0037 §per_document, OPEN_QUESTIONS 10).
 */
export class NullDigitalPrintShop implements DigitalPrintShopAdapter {
  assignControlNumber(documento: DocumentoParaControl): Promise<ControlAsignado> {
    return Promise.reject(
      new Error(
        `no hay imprenta digital configurada: el documento ${documento.documentId} no puede ` +
          `recibir número de control. Configurar una exige elegir un proveedor de la lista de ` +
          `imprentas digitales autorizadas vigente (VALIDAR-SENIAT) — ver ADR-0045.`,
      ),
    );
  }
}

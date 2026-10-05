/**
 * LA SALIDA DE INVENTARIO DICE QUÉ EMITE ANTES DE CONFIRMAR (ADR-0082; RLIVA art. 31).
 *
 * Viven aquí porque nombran el IVA y la factura. Lo que de verdad se emite lo decide el SERVIDOR
 * (si el negocio factura, el precio, la alícuota, el número del talonario): estos textos dicen la
 * regla, no una cifra, y la pantalla no calcula nada.
 */
export const SALIDA_QUE_EMITE = {
  retiro:
    "Es un retiro: si tu negocio factura, al confirmar se emite una factura de retiro a nombre del propio negocio, con su IVA sobre el precio de venta y un número de control de tu talonario. No genera cuenta por cobrar. Si tu negocio no factura, solo sale del inventario.",
  noGravado:
    "No se emite ningún documento: sale del inventario al costo, sin IVA. Úsalo solo si el producto se queda trabajando en el negocio, y di adónde fue.",
  /** AF5-02: a quien mueve mercancía y no factura. Si el negocio factura, lo dirá el servidor. */
  retiroSinPermiso:
    "Es un retiro: si tu negocio factura, emite una factura a nombre de tu negocio y lo registra quien puede facturar. Si tu negocio no factura, solo sale del inventario.",
  perdida: "No se emite ningún documento: va a pérdidas, con la evidencia que la respalda.",
} as const;

/** El resumen de la salida, en la tarjeta del verbo. */
export const CONSECUENCIA_SALIDA =
  "Sale al costo promedio vigente, que calcula el servidor. Merma, rotura, vencido y faltante van a «Pérdidas por mermas y faltantes» con su evidencia; consumo propio, regalo, donación y muestra son un retiro: si facturas, se emite una factura de retiro con su IVA; lo que se usa en el negocio, pasa a activo fijo o se incorpora a un inmueble del negocio sale sin IVA y sin documento.";

/**
 * ANTES de confirmar, con las cifras que el servidor ensayó (`/v1/inventory/issues/preview`). El
 * número no se promete: lo asigna el talonario al emitir.
 */
export function avisoPrevioDeFacturaDeRetiro(serie: string, base: string, iva: string): string {
  return (
    `Se emitirá una factura de retiro de la serie ${serie} con base ${base} e IVA ${iva}, a nombre ` +
    "del propio negocio. Gasta un número de control de tu talonario y no genera cuenta por cobrar."
  );
}
/** Y cuando el servidor dice que no se emite nada, por qué. */
export const SALIDA_NO_EMITE: Record<"retiro" | "no_gravado" | "perdida" | "sin_rif", string> = {
  retiro: "No se emite ningún documento.",
  no_gravado:
    "No se emite ningún documento: sale del inventario al costo, sin IVA, a la cuenta de gasto o de activo que le corresponde.",
  perdida: "No se emite ningún documento: va a pérdidas, con la evidencia que la respalda.",
  sin_rif:
    "No se emite ningún documento: tu negocio no factura. Sale del inventario y queda como gasto.",
};

/**
 * CORREGIR UN RETIRO FACTURADO (ADR-0082, AF3-06), en el detalle de la factura de retiro. Lo que
 * va a pasar se dice ANTES de confirmar; cuál de los dos caminos toca lo decide el servidor.
 */
export const CORREGIR_RETIRO = {
  boton: "Corregir este retiro",
  anular:
    "Se anula la factura de retiro: conserva su número y su control, la mercancía vuelve al inventario y se revierte su IVA. Solo si tienes en la mano el original y todas las copias.",
  nota: "Esta factura ya no se puede anular. Se emite una nota de crédito por el retiro ENTERO: gasta un número de control de tu talonario, la mercancía vuelve al inventario al costo con que salió y el IVA del retiro se resta en el libro de ventas y en la declaración de este período. Para corregir solo una parte, deja sin efecto el retiro entero con la nota y regístralo de nuevo.",
  motivo: "¿Por qué se deja sin efecto?",
  hecho: "Retiro corregido",
} as const;

/** AF5-07: la nota de DESTINO de una salida sin IVA (uso en el negocio, activo fijo, inmueble). */
export const DESTINO_DE_LA_SALIDA = {
  etiqueta: "Destino",
  ayuda:
    "Adónde fue la mercancía, con al menos dos palabras: por ejemplo «Cloro para la limpieza del local». Es lo que respalda que salga sin IVA.",
} as const;

/** Tras confirmar un retiro que emitió su factura: se dice y se ofrece abrirla. */
export const RETIRO_EMITIDO = {
  titulo: "Retiro registrado",
  ver: "Ver la factura de retiro",
  cerrar: "Cerrar",
} as const;

/**
 * Los tipos de documento que son FISCALES para la pantalla del detalle: gastan número de control
 * y se imprimen sobre la forma libre. Una sola lista (el servidor tiene la suya en documents-pdf).
 */
export const TIPOS_FISCALES: readonly string[] = [
  "invoice",
  "credit_note",
  "debit_note",
  "withdrawal_invoice",
  "withdrawal_credit_note",
];

/** Lo que la pantalla dice cuando la salida emitió su factura de retiro. Las cifras son del servidor. */
export function avisoFacturaDeRetiro(numero: string, control: string | null, iva: string): string {
  return (
    `Se emitió la factura de retiro ${numero}` +
    (control !== null ? ` (control ${control})` : "") +
    ` con IVA de ${iva}.`
  );
}

/** El aviso del precio de compra: el impuesto lo resuelve el servidor con la regla vigente. */
export const AVISO_PRECIO_COMPRA =
  "El precio es por unidad y sin IVA: el impuesto lo pone el sistema con la regla vigente.";

/**
 * LAS TRES RESPUESTAS A «¿TIENES LA FACTURA?» (ADR-0066, paso 3 de la llegada).
 *
 * Viven aquí, y no en la pantalla, porque nombran el IVA y el crédito fiscal: un negocio que
 * vende con recibos no habla de eso, y el gate del glosario lo vigila. La pantalla las pinta
 * tal cual; lo que cambia según el caso lo decide el servidor, no el texto.
 */
/**
 * D-01 y D-12 (ola 3): la empresa SIN RIF no es contribuyente y no registra crédito fiscal (LIVA
 * art. 33, respuesta del dueño a D-01). Su «Sí, aquí está» no promete libro ni crédito: la factura
 * del proveedor es el soporte de su costo, y el IVA entra al costo de la mercancía.
 */
export const DETALLE_FACTURA_SIN_RIF =
  "Es el soporte de lo que te costó: su IVA entra al costo de la mercancía. Sin RIF no hay crédito fiscal.";

/** D-01 y D-12: el resumen de «¿Todo bien?» para la compra con factura, según la empresa. */
export const RESUMEN_FACTURA_CON_RIF =
  "Con su factura: entra al libro de compras y puede contar como crédito fiscal.";
export const RESUMEN_FACTURA_SIN_RIF =
  "Con su factura: su IVA entra al costo. Sin RIF no hay crédito fiscal.";

/**
 * D-05 (ola 3): el precio se escribe SIN IVA, como viene en la factura; si la persona copió el del
 * papel con IVA, lo dice con este interruptor y el SERVIDOR se lo quita. La pantalla no calcula.
 */
export const INTERRUPTOR_PRECIO_CON_IVA = {
  titulo: "El precio que escribí ya incluye IVA",
  ayuda:
    "Escríbelo sin IVA, como viene en la factura. Si copiaste el precio con IVA, marca esto y el sistema se lo quita.",
};

/** D-05: las filas del resumen que calcula el servidor (vista previa de la llegada). */
export const FILAS_VISTA_LLEGADA = {
  base: "Base (sin IVA)",
  impuesto: "IVA",
  impuestoPendiente: "Lo dirá la factura",
  total: "Total",
};

/** D-06: el precio de la factura que llega después, por línea. */
export const PRECIO_DE_LA_FACTURA = (linea: number, unidades: string): string =>
  `Precio de cada una en la factura (sin IVA) — línea ${linea}, ${unidades} unidades`;

export const TARJETAS_FACTURA = [
  {
    valor: "present" as const,
    titulo: "Sí, aquí está",
    // AF3-15: «puede contar»: con ventas exentas hay prorrata, y la pantalla no promete el efecto.
    detalle: "Entra al libro de compras y su IVA puede contar como crédito fiscal.",
  },
  {
    valor: "pending" as const,
    titulo: "Todavía no me la dan",
    detalle: "La mercancía entra igual. Queda en «Falta la factura» hasta que llegue.",
  },
  {
    valor: "none" as const,
    titulo: "No va a haber factura",
    detalle: "Entra al costo que pagaste. No va al libro de compras ni da crédito fiscal.",
  },
];

/**
 * La pantalla de IGTF (libros/Igtf.tsx), percepciones del período. El total y lo pendiente de
 * reintegro llegan CALCULADOS del servidor (`platform.igtf_period_totals`, PA SNAT/2022/000013
 * art. 4; VALIDAR-TRIBUTARIO P-89): aquí solo se escriben.
 */
export const IGTF_PERCEPCIONES = {
  descripcion:
    "Una fila por cobro que causó. El total es lo que esta quincena declaró o va a declarar: un cobro reversado antes de cerrarla no cuenta; uno reversado después sigue contando, porque ya se declaró.",
  pendienteDeReintegro: (importe: string, cobros: number): string =>
    `De eso, pendiente de reintegro: ${importe} (${
      cobros === 1 ? "1 cobro reversado" : `${String(cobros)} cobros reversados`
    } después de cerrar la quincena).`,
  avisoPendientes: (cuantas: number, soloEstaPagina: boolean): string =>
    `${
      cuantas === 1
        ? "Hay 1 percepción pendiente de reintegro"
        : `Hay ${String(cuantas)} percepciones pendientes de reintegro`
    }${soloEstaPagina ? " en esta página" : ""}: su cobro se reversó o su factura se anuló después de percibir. Habla con tu contador antes de devolver.`,
} as const;

/**
 * C-02: la clasificación tributaria del alta de producto (la misma alta en /empezar y en
 * administración). Los textos nombran el IVA y la LIVA: viven aquí. La regla (qué se ofrece, qué
 * exige literal o justificación) la aplica el servidor (ADR-0073).
 */
export const CLASIFICACION_DEL_PRODUCTO = {
  etiqueta: "Clasificación tributaria",
  ayuda:
    "Si no la cambias, nace con la de tu empresa. Es la que se congela en cada documento al emitir. VALIDAR-TRIBUTARIO: la confirma el contador.",
  laDeLaEmpresa: "La de la empresa",
  suntuarioEtiqueta: "Por qué es suntuario",
  suntuarioAyuda:
    "La alícuota adicional (LIVA art. 61) no tiene una lista con fuente: escribe la razón. Queda en el acta.",
};

/** M-09: la banda de la caja de un negocio que pasó de recibos a facturas (respuesta del dueño). */
export const AVISO_YA_FACTURAS = "Ya facturas con tu RIF: tus ventas salen como factura.";

/**
 * M-10: qué significa «Formal», para decirlo ANTES de elegirlo. Hoy la opción sigue oculta
 * (PENDIENTES_ASESOR P-38: falta la fuente de la periodicidad de la PA SNAT/2003/1677) y este
 * texto es un BORRADOR: no se enseña a nadie. Fuente de la primera frase: LIVA art. 8
 * (REGULATORY_STATUS §2-bis, fuente secundaria).
 *
 * VALIDAR-TRIBUTARIO antes de ofrecerlo, porque dos frases afirman lo que todavía es pregunta:
 *   · «el IVA de tus compras va al costo» — P-17, sin artículo citado;
 *   · «si vendes aunque sea un producto gravado, eres ordinario» — P-38, pregunta 4 (abierta).
 * Si el asesor responde otra cosa, cambian aquí.
 */
export const DETALLE_FORMAL =
  "Contribuyente formal (Ley de IVA, art. 8): tu negocio SOLO vende productos o servicios exentos o exonerados. No cobras IVA, no puedes vender nada gravado y el IVA de tus compras va al costo. Si vendes aunque sea un producto gravado, eres ordinario.";

/**
 * H-09: el gasto con factura fiscal. La regla (libro de compras, crédito fiscal, retención) la
 * aplica el servidor: aquí solo está lo que la pantalla dice. Fuente: LIVA art. 33 y PA
 * SNAT/2025/000054 (RESPUESTA del dueño del 2026-09-28, H-09).
 */
export const GASTO_CON_FACTURA = {
  pregunta: "¿Te dieron factura fiscal?",
  sin: "Sin factura",
  con: "Con factura fiscal",
  /**
   * Qué pasa con la factura, según la empresa. La que NO tiene RIF no lleva libro de compras ni
   * crédito fiscal (su IVA va al costo): no se le promete. El dato —si tiene RIF— es el de la
   * empresa en la sesión, que lo dice el servidor; aquí solo se elige la frase.
   */
  ayudaCon: (conRif: boolean): string =>
    conRif
      ? "La luz, el teléfono, el alquiler: con su factura el gasto entra al libro de compras y su IVA puede contar como crédito fiscal. Copia las bases tal como vienen impresas, en la moneda de la factura: el IVA, lo que se retiene y lo que sale de tu cuenta los calcula el sistema."
      : "La luz, el teléfono, el alquiler: la factura queda guardada como soporte del gasto. Tu negocio todavía no tiene RIF, así que no lleva libro de compras y el IVA de la factura va al costo. Copia las bases tal como vienen impresas, en la moneda de la factura: lo demás lo calcula el sistema.",
  moneda: "La factura viene en",
  ayudaMoneda:
    "La moneda impresa en la factura. Si pagas desde una cuenta en otra moneda, se convierte a la tasa BCV del día.",
  resumenTasa: (c: { fecha: string; tasa: string; divisa: string }): string =>
    `A la tasa BCV del ${c.fecha}: Bs. ${c.tasa} por ${c.divisa}.`,
  proveedor: "¿Quién te facturó?",
  ayudaProveedor: "Con su RIF. Si no está, agrégalo en Compras → Proveedores.",
  numero: "N.º de factura",
  control: "N.º de control",
  fecha: "Fecha de la factura",
  bases: "Base de la factura, por tipo",
  ayudaBases: "Llena solo las que trae la factura. Sin IVA.",
  /** El resumen ANTES de confirmar: los rótulos de las cifras que calcula el servidor. */
  resumenTitulo: "Lo que se va a registrar",
  resumenBase: (categoria: string): string => `Base ${categoria}`,
  resumenImpuesto: "IVA",
  resumenTotal: "Total de la factura",
  resumenRetenido: "IVA que retienes (lo enteras tú al SENIAT)",
  resumenSale: "Sale de tu cuenta",
  resumenCredito: "El IVA de esta factura puede contar como crédito fiscal.",
  resumenCosto: "El IVA de esta factura va al costo: no es crédito fiscal.",
  resumenFalta: "Completa la factura para ver cuánto es.",
  hecho: (c: { total: string; iva: string; retenido: string | null; sale: string }): string =>
    `Factura por ${c.total} (IVA ${c.iva})${
      c.retenido === null ? "" : `, se retuvo ${c.retenido}`
    }. Salió ${c.sale} de tu cuenta.`,
};

/**
 * G-10 / G-14 / G-07 (ola 4): anular o nota de crédito, y la devolución de quien no reembolsa.
 * La REGLA (mismo día, antes del cierre de caja, período sin declarar) la aplica el servidor y su
 * motivo llega ya escrito en `annulment.message`: aquí solo vive lo que la pantalla PREGUNTA.
 * Fuente: PA SNAT/2011/00071, arts. 22 (nota de crédito) y 36 (conservar original y copias).
 */
export const ANULACION = {
  /** La confirmación que la persona da antes de anular una factura (art. 36). */
  papelEnMano: "Tengo en la mano el original y todas las copias de esta factura.",
  ayudaPapel:
    "Solo se anula una factura que no salió del negocio: el mismo día, antes de cerrar la caja. Guarda el original y las copias anulados. Si el cliente ya se la llevó, no se anula: se corrige con una nota de crédito.",
  /** Título del aviso cuando «Anular» no aplica. */
  noSeAnula: "Este documento no se anula",
  /** G-07: quien inicia la devolución sin permiso para reembolsar. */
  sinReembolso:
    "La devolución deja el dinero como saldo a favor del cliente. Sacarlo de la caja lo hace quien tiene permiso para reembolsar.",
  sinReembolsoMostrador:
    "La devolución queda registrada y el dinero pendiente: lo entrega quien tiene permiso para reembolsar.",
  /**
   * G-10, en compras (PA 00071 art. 36): la factura que el PROVEEDOR anuló nunca salió de su
   * negocio; no hay nada que registrar. Lo ya registrado y luego anulado sigue la regla R-2.
   */
  proveedorAnulo: "Si tu proveedor anuló la factura, no la registres.",
};

/**
 * E-14 (RESPUESTA del dueño del 2026-09-28): al crear un cliente con RIF J desde la caja se
 * pregunta si es contribuyente especial, con «no» por defecto. El texto vive aquí; la regla
 * (quién retiene y cuánto) es del servidor. La clasificación se cambia después en la ficha del
 * cliente, con permiso.
 */
export const CLIENTE_ESPECIAL = {
  pregunta: "¿Es contribuyente especial (retiene IVA)?",
  no: "No",
  si: "Sí, es especial",
  ayuda:
    "Si no lo sabes, deja «No»: quien administra puede cambiarlo después en la ficha del cliente.",
  /** El código que el servidor entiende; la pantalla solo lo transporta. */
  codigo: "especial",
  fichaTitulo: "Clasificación fiscal — permiso propio, auditado",
  fichaAyuda:
    "De la clasificación depende quién retiene IVA. Cambiarla deja acta con el valor anterior.",
};

/**
 * H-03 (RESPUESTA del dueño del 2026-09-28; ADR-0083): la nota de crédito que EMITE el proveedor.
 * Los textos viven aquí; las reglas (qué va al libro, el impuesto, el kardex, el saldo) son del
 * servidor. PA 00071 art. 23 → art. 13: la nota de un contribuyente lleva número de control.
 */
export const NC_PROVEEDOR = {
  descripcion:
    "Copia los datos del papel que emitió tu proveedor. Rebaja lo que se debe de ESA factura; si ya estaba pagada, queda anotado a tu favor con el proveedor.",
  sinControl:
    "Sin número de control la nota se registra igual y baja tu crédito fiscal, y queda marcada como documento incompleto. Esa marca no se quita después: si tienes el papel con su número de control, escríbelo ahora.",
  noFiscal:
    "Esta compra se registró sin factura fiscal: su nota no es una nota de crédito fiscal y no va al libro de compras.",
  conRetencion:
    "A esta factura se le practicó retención de IVA. La nota no cambia lo retenido ni su comprobante. La providencia de retenciones (PA SNAT/2025/000054, art. 11) trata este caso: si la retención todavía no se enteró, lo retenido de más se le devuelve al proveedor; si ya se enteró, lo descuenta él. Confírmalo con tu contador antes de pagarle o devolverle dinero.",
  preguntaClase: "¿Qué pasó con la mercancía?",
  devolucion: "La devolví al proveedor",
  rebaja: "Me la quedé: me rebajó el precio",
  ayudaDevolucion: "La mercancía sale de tu inventario, a su costo.",
  ayudaRebaja: "La mercancía se queda: baja el costo de la que todavía tienes.",
  deposito: "¿De qué depósito sale la mercancía?",
  ayudaLineas: (moneda: string): string =>
    `Llena solo las líneas que la nota abona, con los importes sin IVA, en ${moneda}: el impuesto lo pone el sistema con la alícuota de la factura.`,
  /** G-10 en compras: una factura de proveedor no se anula. */
  porError:
    "Una factura de proveedor registrada por error no se anula: se corrige con la nota de crédito del proveedor por todo su importe.",
  bajoLaDeuda: "La deuda con el proveedor bajó.",
  quedoAFavor:
    "La factura ya no debía ese importe: queda anotado a tu favor con el proveedor. Todavía no se descuenta solo de la próxima factura: tenlo en cuenta al pagarle.",
  faltaElLote:
    "Este producto se lleva por lotes y su factura no viene de una recepción: di de qué lote sale lo que devuelves.",
  lote: (producto: string): string => `Lote de ${producto} que devuelves`,
  loteVencido: "vencido",
  sinLotes:
    "No hay lotes con existencia de este producto en el depósito elegido: elige otro depósito o regístrala como rebaja.",
  ayudaLoteVencido: "Devolver un lote vencido exige el permiso de despachar mercancía vencida.",
  aTuFavor: "A tu favor con este proveedor",
  aTuFavorAyuda:
    "Viene de notas de crédito que abonaron más de lo que se le debía en esa factura. No está restado de lo que debes y todavía no se descuenta solo: tenlo en cuenta al pagarle.",
  listaTitulo: "Notas de crédito del proveedor",
  noFiscalEtiqueta: "No fiscal",
  incompletaTitulo: "Documento incompleto",
  incompleta: "La nota quedó registrada sin número de control y marcada como documento incompleto.",
};

/**
 * I-04 (ola 5, C7): el consumo SUELTO de una receta (Administración → Inventario → Recetas) saca
 * los ingredientes otra vez sobre un producto cuya venta ya los saca. La confirmación lo dice.
 */
export const CONSUMO_SUELTO_DE_RECETA =
  "La venta de este producto ya descuenta sus ingredientes. Usa esto solo para registrar un consumo que NO se vendió (una prueba, una preparación que se perdió).";

/**
 * I-04 (ola 5, tercera ronda; ADR-0084): al confirmar un pedido, la línea de un producto que se
 * arma con otros no reserva nada. Lo dice la confirmación del pedido, donde se habla de reservar.
 */
export const PEDIDO_COMPUESTO_NO_RESERVA =
  "Los productos que se arman con otros no se reservan: su existencia se comprueba al facturar.";

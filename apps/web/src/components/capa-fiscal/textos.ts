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

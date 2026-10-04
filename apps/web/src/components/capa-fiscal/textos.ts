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

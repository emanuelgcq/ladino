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
export const TARJETAS_FACTURA = [
  {
    valor: "present" as const,
    titulo: "Sí, aquí está",
    detalle: "Entra al libro de compras y su IVA cuenta como crédito fiscal.",
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

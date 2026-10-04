/**
 * H-06 (ADR-0075 §1): la moneda en que NACE un pedido a proveedor.
 *
 * El pedido nace en la moneda del precio de la empresa: la de la lista con la que vende; si
 * ninguna está marcada, la de la primera lista activa; y sin listas (o sin permiso para
 * leerlas), dólares, que es el precio de referencia (ADR-0046). Antes nacía fijo en bolívares,
 * y «18» escrito pensando en dólares quedaba como 18 Bs la caja.
 *
 * No calcula nada (R5): solo elige una etiqueta. La persona puede cambiarla.
 */
export function monedaDelPedido(
  listas:
    readonly { currency_code: string; status: string; is_caja_default?: boolean }[] | undefined,
): string {
  const activas = (listas ?? []).filter((l) => l.status === "active");
  return (activas.find((l) => l.is_caja_default === true) ?? activas[0])?.currency_code ?? "USD";
}

/**
 * La moneda que el selector del pedido ENSEÑA (revisión de moneda, ola 3). Tres reglas:
 *   · lo que la persona eligió manda siempre, y nadie se lo cambia;
 *   · mientras las listas cargan no se propone NADA (`null`): antes proponía dólares y saltaba
 *     solo a bolívares al llegar la respuesta, con precios ya escritos;
 *   · con la respuesta (o su fallo) en la mano, la propuesta de `monedaDelPedido`.
 */
export function monedaQueSeEnsena(
  elegida: string | null,
  cargando: boolean,
  listas: Parameters<typeof monedaDelPedido>[0],
): string | null {
  if (elegida !== null) return elegida;
  if (cargando) return null;
  return monedaDelPedido(listas);
}

/** Cómo se le dice la moneda a la persona junto al precio. */
export function nombreCortoDeMoneda(moneda: string): string {
  return moneda === "VES" ? "Bs." : moneda;
}

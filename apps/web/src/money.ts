import { formatMoney } from "@ladino/money/format";
import type { MoneyJSON } from "@ladino/money/format";

/**
 * ÚNICA puerta de dinero de la webapp: formateo con el helper de
 * packages/money (lo único que un cliente puede importar de money — regla de
 * fronteras). CERO aritmética monetaria aquí, ni para «previsualizar un
 * total».
 *
 * `formatMoney` FALLA a propósito si el importe trae más decimales de los que
 * la moneda muestra — formatear no redondea (MONEY_AND_ROUNDING_SPEC §5). Un
 * precio de LISTA puede traer hasta 8 decimales legítimos, así que el
 * fallback es mostrar el string EXACTO con su código: enseñar el dato, no
 * inventarle un redondeo en el cliente.
 */
export function mostrarImporte(value: MoneyJSON): string {
  try {
    return formatMoney(value, { locale: "es-VE" });
  } catch {
    return `${value.amount} ${value.currency}`;
  }
}

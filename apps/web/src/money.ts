import { formatMoney } from "@ladino/money/format";
import type { MoneyJSON } from "@ladino/money/format";

/**
 * ÚNICA puerta de dinero de la webapp: formateo con el helper de
 * packages/money (lo único que un cliente puede importar de money — regla de
 * fronteras). CERO aritmética monetaria aquí, ni para «previsualizar un
 * total».
 *
 * `formatMoney` FALLA a propósito si el importe trae más decimales de los que
 * la moneda muestra — formatear no redondea (MONEY_AND_ROUNDING_SPEC §5). El
 * fallback tampoco: enseña el importe EXACTO, pero VESTIDO — separadores de
 * miles, coma decimal y el mismo prefijo de moneda que formatMoney, quitando
 * solo los CEROS FINALES, que son representación y no precisión
 * («664.54080000» y «664.5408» son el mismo número; «664.54» no lo sería y por
 * eso jamás se produce aquí). Antes el fallback soltaba el string crudo con
 * ocho decimales y el componente de firma parecía un volcado de base de datos.
 */
const PREFIJO: Record<string, string> = { VES: "Bs.S", USD: "USD" };

function exactoVestido(value: MoneyJSON): string {
  const neg = value.amount.startsWith("-");
  const cuerpo = neg ? value.amount.slice(1) : value.amount;
  const [entera = "0", decimal = ""] = cuerpo.split(".");
  const ent = entera.replace(/^0+(?=\d)/, "");
  const dec = decimal.replace(/0+$/, "");
  const miles = ent.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const prefijo = PREFIJO[value.currency] ?? value.currency;
  return `${neg ? "-" : ""}${prefijo} ${miles}${dec === "" ? "" : `,${dec}`}`;
}

export function mostrarImporte(value: MoneyJSON): string {
  try {
    return formatMoney(value, { locale: "es-VE" });
  } catch {
    return exactoVestido(value);
  }
}

/**
 * Cantidades y tasas NO son dinero: llegan como numeric(24,8) en string y se
 * enseñan exactas quitando solo los ceros finales. «24.00000000» es «24».
 */
export function mostrarCantidad(v: string): string {
  const [ent = "0", dec = ""] = v.split(".");
  const d = dec.replace(/0+$/, "");
  return d === "" ? ent : `${ent}.${d}`;
}

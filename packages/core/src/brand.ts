/**
 * Tipos nominales sobre primitivos.
 *
 * `Brand<string, 'CurrencyCode'>` no es asignable desde un `string` cualquiera, así que un
 * código de moneda no puede colarse donde se espera una fuente de tasa. El truco es la
 * propiedad fantasma: existe solo en el sistema de tipos, no en runtime.
 *
 * Límite conocido y aceptado: `'' as CurrencyCode` compila. El compilador garantiza que el
 * valor VIENE de algún sitio, no que sea válido. La validación es responsabilidad del
 * constructor (`makeFxRate`, `Money.of`, …). Ver packages/money/CLAUDE.md.
 */
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

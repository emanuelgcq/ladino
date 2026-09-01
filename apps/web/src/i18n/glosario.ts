/**
 * EL GLOSARIO DE PERSONA (Fase C, PARTE 3) — la frontera de los dos mundos.
 *
 * Las pantallas de negocio (`pages/negocio/**`) hablan el idioma de quien
 * atiende un mostrador en Venezuela. Las palabras del sistema — SKU, kardex,
 * asiento, instrumento, aging — viven en `/admin`, donde trabajan el contador
 * y quien configura. La frontera la vigila un TEST DE VERDAD
 * (`test/glosario.test.ts`, dentro de `pnpm verify`): no es una guía de
 * estilo, es un gate que se pone rojo.
 *
 * La regla para añadir un término: si la persona del mostrador no lo diría en
 * voz alta atendiendo a un cliente, está prohibido aquí y se anota con qué se
 * dice en su lugar.
 */

/** El vocabulario que SÍ se usa: una sola forma para cada concepto. */
export const VOZ = {
  codigo: "Código",
  movimientos: "Movimientos",
  loQueMeDeben: "Lo que me deben",
  loQueDebo: "Lo que debo",
  desdeHaceCuanto: "Desde hace cuánto",
  formaDePago: "Forma de pago",
  tasaDelDia: "Tasa del día",
  entroMercancia: "Entró mercancía",
  salioMercancia: "Salió mercancía",
  loQueGane: "Lo que gané",
  miDinero: "Mi dinero",
  porAgotarse: "Por agotarse",
  consumidorFinal: "Consumidor final",
  cobrar: "Cobrar",
  vuelto: "Vuelto",
  cerrarCaja: "Cerrar la caja",
} as const;

export interface TerminoProhibido {
  /** El patrón que delata el término. Sobre el TEXTO FUENTE de la pantalla. */
  readonly patron: RegExp;
  /** Qué se dice en su lugar — o dónde vive el término si no se dice. */
  readonly usa: string;
}

/**
 * Los términos que NO entran en `pages/negocio/**`. Cada uno con su
 * reemplazo: un gate que solo dice «no» enseña a esquivarlo; uno que dice
 * «di esto» enseña a escribir.
 */
export const TERMINOS_PROHIBIDOS: readonly TerminoProhibido[] = [
  { patron: /\bSKU\b/, usa: "«Código»" },
  { patron: /\balmac[eé]n(es)?\b/iu, usa: "el NOMBRE real del depósito (o «depósito»)" },
  { patron: /\bkardex\b/iu, usa: "«Movimientos»" },
  { patron: /\bCxC\b/i, usa: "«Lo que me deben»" },
  { patron: /\bCxP\b/i, usa: "«Lo que debo»" },
  { patron: /\baging\b/i, usa: "«Desde hace cuánto»" },
  { patron: /\binstrumentos?\b/iu, usa: "«Forma de pago»" },
  { patron: /\bfx_rate\b/, usa: "«tasa del día»" },
  {
    patron: /\basientos?\s+contables?\b|\basientos?\b/iu,
    usa: "nada: la contabilidad vive en /admin",
  },
  { patron: /\bdraft\b/i, usa: "nada: en el mostrador no existen borradores" },
  { patron: /n[úu]mero\s+de\s+control/iu, usa: "nada: eso vive en /admin y en el PDF" },
  { patron: /\br[ée]g[íi]men(es)?\b/iu, usa: "nada: eso vive en /admin/facturacion-fiscal" },
  { patron: /\brules_version\b/, usa: "nada: es procedencia interna" },
  { patron: /\bLAD\d+\b/, usa: "el person_message del error, nunca el código" },
  { patron: /\bSQLSTATE\b/i, usa: "el person_message del error" },
  { patron: /Bs\.S/, usa: "«Bs.» a secas: la reconversión ya pasó" },
];

export interface Violacion {
  readonly termino: string;
  readonly usa: string;
}

/** Todas las violaciones de un texto fuente. Vacío es lo correcto. */
export function violaciones(texto: string): Violacion[] {
  const halladas: Violacion[] = [];
  for (const t of TERMINOS_PROHIBIDOS) {
    const m = texto.match(t.patron);
    if (m !== null) halladas.push({ termino: m[0], usa: t.usa });
  }
  return halladas;
}

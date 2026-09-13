/**
 * Las formas de pago que la web OFRECE al cobrar — compartidas entre el POS
 * (Vender) y el diálogo de cobro de documentos (CobrarDocumento), para que un
 * instrumento signifique lo mismo, con la misma moneda y la misma etiqueta,
 * se cobre desde donde se cobre.
 *
 * Nada de aquí decide dinero: la moneda del instrumento solo elige en qué
 * moneda se teclea el importe; la conversión y el diferencial los calcula el
 * servidor al registrar.
 */
export const ETIQUETA_FORMA: Record<string, string> = {
  efectivo_bs: "Efectivo Bs.",
  efectivo_usd: "Efectivo USD",
  pago_movil: "Pago móvil",
  transferencia: "Transferencia",
  punto_venta: "Punto de venta",
  tarjeta: "Tarjeta",
  zelle: "Zelle",
  usdt: "USDT",
  cashea: "Cashea",
  otro: "Otra",
};
export const MONEDA_FORMA: Record<string, string> = {
  efectivo_bs: "VES",
  efectivo_usd: "USD",
  pago_movil: "VES",
  transferencia: "VES",
  punto_venta: "VES",
  tarjeta: "VES",
  zelle: "USD",
  usdt: "USD",
  cashea: "VES",
  otro: "VES",
};

/**
 * Las formas que se OFRECEN SIEMPRE, configuradas o no (decisión del dueño,
 * 2026-09-05): el cobro registra la forma de pago + referencia desde hoy; la
 * cuenta la refina una forma configurada, y sin ella el dinero cae en
 * «Sin asignar» hasta que se conecten las APIs (POS, pago móvil, Cashea…).
 */
export const FORMAS_BASE = [
  "efectivo_bs",
  "efectivo_usd",
  "punto_venta",
  "pago_movil",
  "transferencia",
  "zelle",
  "usdt",
  "cashea",
] as const;

/** Una forma de pago configurada por el negocio (`GET /v1/payment-methods`). */
export interface FormaDePago {
  id: string;
  name: string;
  kind: string;
  account_id: string;
  is_active: boolean;
}

/** Una opción de cobro ya resuelta: qué instrumento, en qué moneda, a qué cuenta. */
export interface OpcionDeCobro {
  clave: string;
  etiqueta: string;
  instrument: string;
  currency: string;
  account_id?: string;
}

/**
 * Las opciones que se ofrecen: las configuradas ACTIVAS del negocio (con su
 * cuenta) primero, y después todas las formas base que ninguna configurada
 * cubra. Es la misma regla que aplica el POS.
 */
export function opcionesDeCobro(formas: readonly FormaDePago[] | undefined): OpcionDeCobro[] {
  const configuradas = (formas ?? []).filter((f) => f.is_active);
  const opciones: OpcionDeCobro[] = configuradas.map((f) => ({
    clave: `m:${f.id}`,
    etiqueta: f.name,
    instrument: f.kind,
    currency: MONEDA_FORMA[f.kind] ?? "VES",
    account_id: f.account_id,
  }));
  for (const inst of FORMAS_BASE) {
    if (!configuradas.some((f) => f.kind === inst)) {
      opciones.push({
        clave: `i:${inst}`,
        etiqueta: ETIQUETA_FORMA[inst]!,
        instrument: inst,
        currency: MONEDA_FORMA[inst]!,
      });
    }
  }
  return opciones;
}

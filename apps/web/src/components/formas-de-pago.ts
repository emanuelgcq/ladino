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

/**
 * El nombre con el que el NEGOCIO llama a un instrumento ya cobrado. Un pago guarda el
 * instrumento, no la forma configurada, así que la única lectura honesta es: si el negocio
 * tiene UNA sola forma activa de ese tipo, ese es su nombre; si tiene varias o ninguna, la
 * etiqueta genérica. Nunca el código crudo («efectivo_bs»), que es lo que se veía antes
 * (QA de pantalla 2026-09-15, h. 39).
 */
export function nombreDeInstrumento(
  instrument: string,
  formas: readonly FormaDePago[] | undefined,
): string {
  const candidatas = (formas ?? []).filter((f) => f.is_active && f.kind === instrument);
  if (candidatas.length === 1) return candidatas[0]!.name;
  return ETIQUETA_FORMA[instrument] ?? instrument.replace(/_/g, " ");
}

/**
 * Con qué se le PAGA a un proveedor: el `PurchaseInstrument` de `packages/schemas`. Es un
 * subconjunto de las formas de COBRO — «Cashea» cobra, pero no se le paga a un proveedor con
 * ella— y a la vez trae dos que el cobro no ofrece, «Tarjeta» y «Otra».
 *
 * Vivía dentro de «Compras y gastos». Se sube aquí porque la puerta de la mercancía necesita
 * exactamente la misma lista, y la primera versión de esa pantalla, por no tenerla, ofrecía
 * SOLO las formas configuradas: con `payment_methods` vacía —que es como están las ocho
 * empresas de producción— el desplegable salía sin una sola opción y no se podía seguir.
 */
export const FORMAS_DE_COMPRA = [
  { value: "transferencia", label: "Transferencia", moneda: "VES" },
  { value: "pago_movil", label: "Pago móvil", moneda: "VES" },
  { value: "efectivo_bs", label: "Efectivo Bs.", moneda: "VES" },
  { value: "efectivo_usd", label: "Efectivo USD", moneda: "USD" },
  { value: "zelle", label: "Zelle", moneda: "USD" },
  { value: "usdt", label: "USDT", moneda: "USD" },
  { value: "punto_venta", label: "Punto de venta", moneda: "VES" },
  { value: "tarjeta", label: "Tarjeta", moneda: "VES" },
  { value: "otro", label: "Otra", moneda: "VES" },
] as const;
export type FormaDeCompra = (typeof FORMAS_DE_COMPRA)[number]["value"];
const ES_FORMA_DE_COMPRA = new Set<string>(FORMAS_DE_COMPRA.map((i) => i.value));
export function esFormaDeCompra(kind: string): kind is FormaDeCompra {
  return ES_FORMA_DE_COMPRA.has(kind);
}

/**
 * Con qué pagarle al proveedor: las formas CONFIGURADAS que sirven para comprar —con su cuenta,
 * que es lo que evita que el pago caiga en «Sin asignar»— y detrás los instrumentos que ninguna
 * cubra. Sin ninguna configurada quedan los nueve, y el servidor resuelve la cuenta propia de esa
 * familia (ADR-0062 §1). La lista NUNCA sale vacía: es la misma regla que el POS.
 */
export function opcionesDePagoDeCompra(
  formas: readonly FormaDePago[] | undefined,
): OpcionDeCobro[] {
  const configuradas = (formas ?? []).filter((f) => f.is_active && esFormaDeCompra(f.kind));
  const cubiertos = new Set(configuradas.map((f) => f.kind));
  return [
    ...configuradas.map((f) => ({
      clave: f.id,
      etiqueta: f.name,
      instrument: f.kind,
      currency: MONEDA_FORMA[f.kind] ?? "VES",
      account_id: f.account_id,
    })),
    ...FORMAS_DE_COMPRA.filter((i) => !cubiertos.has(i.value)).map((i) => ({
      clave: i.value,
      etiqueta: i.label,
      instrument: i.value,
      currency: i.moneda,
    })),
  ];
}

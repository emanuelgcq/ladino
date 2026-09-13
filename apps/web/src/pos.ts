/**
 * El ADAPTADOR del punto de venta: traduce el contrato de la API al
 * vocabulario de persona ANTES de que llegue a `pages/negocio/**`. El gate
 * del glosario escanea el fuente de esas pantallas — también los
 * identificadores — y los nombres de campo del contrato (`fx_rate`) no
 * tienen por qué colarse en el mundo del mostrador. La traducción vive aquí,
 * en la frontera, no regada por los componentes.
 */

export interface LineaCotizada {
  readonly product_id: string;
  readonly description: string;
  readonly quantity: string;
  /** El precio en la moneda ancla de la lista (USD). */
  readonly unit_price: string;
  readonly total: string;
  /** ADR-0047: el mismo lado en Bs que congelará el documento, por línea. */
  readonly precio_bs: string;
  readonly total_bs: string;
  /** El ancla (USD) por línea, del servidor; null sin tasa del día. */
  readonly precio_usd: string | null;
  readonly total_usd: string | null;
}

export interface CotizacionPos {
  readonly customer_id: string;
  readonly price_list_id: string;
  /** La moneda ancla del documento (la de la lista: USD, o Bs si la lista es en Bs). */
  readonly currency: string;
  /** La tasa del día que usó el servidor (el contrato la llama fx_rate). */
  readonly tasa: string;
  readonly lines: readonly LineaCotizada[];
  readonly subtotal: string;
  readonly tax_amount: string;
  readonly total: string;
  /** El pie en Bs, derivado por el servidor igual que en la emisión. */
  readonly subtotal_bs: string;
  readonly impuesto_bs: string;
  readonly functional_total: string;
  readonly functional_currency: string;
  /** El total en el ancla (USD), del servidor; null si no hay tasa del día. */
  readonly anchor_currency: string;
  readonly anchor_total: string | null;
  readonly anchor_rate: string | null;
}

type Llamar = <T>(path: string, init?: RequestInit) => Promise<T>;

export async function cotizarPos(
  llamar: Llamar,
  req: {
    company_id: string;
    customer_id?: string;
    lines: { product_id: string; quantity: string }[];
  },
): Promise<CotizacionPos> {
  const r = await llamar<
    Omit<CotizacionPos, "tasa" | "subtotal_bs" | "impuesto_bs" | "lines"> & {
      fx_rate: string;
      rate_source: string;
      functional_subtotal: string;
      functional_tax_amount: string;
      lines: readonly (Omit<
        LineaCotizada,
        "precio_bs" | "total_bs" | "precio_usd" | "total_usd"
      > & {
        functional_unit_price: string;
        functional_total: string;
        anchor_unit_price: string | null;
        anchor_total: string | null;
      })[];
    }
  >("/v1/pos/quote", {
    method: "POST",
    body: JSON.stringify(req),
  });
  const {
    fx_rate,
    rate_source: _fuente,
    functional_subtotal,
    functional_tax_amount,
    lines,
    ...resto
  } = r;
  return {
    ...resto,
    tasa: fx_rate,
    subtotal_bs: functional_subtotal,
    impuesto_bs: functional_tax_amount,
    lines: lines.map(
      ({ functional_unit_price, functional_total, anchor_unit_price, anchor_total, ...l }) => ({
        ...l,
        precio_bs: functional_unit_price,
        total_bs: functional_total,
        precio_usd: anchor_unit_price,
        total_usd: anchor_total,
      }),
    ),
  };
}

/** Una forma de pago según la vista previa del cobro (ADR-0059). */
export interface FilaCobro {
  readonly instrument: string;
  readonly currency: string;
  /** Lo que abona a la venta, en la moneda de la forma. */
  readonly abono: string | null;
  readonly abonoFuncional: string | null;
  /** El IGTF que va DENTRO de lo recibido. */
  readonly igtf: string | null;
  readonly vuelto: string | null;
  readonly cubre: boolean;
  readonly error: string | null;
}

/** Cuánto pedir en una forma de pago para cerrar lo que falta, IGTF incluido. */
export interface SugerenciaCobro {
  readonly instrument: string;
  readonly currency: string;
  readonly monto: string | null;
  readonly igtf: string | null;
}

export interface CobroPrevisto {
  readonly pagado: string;
  readonly falta: string;
  readonly completo: boolean;
  readonly vuelto: { readonly amount: string; readonly currency: string } | null;
  readonly filas: readonly FilaCobro[];
  readonly sugerencias: readonly SugerenciaCobro[];
}

/** La vista previa del cobro: el MISMO cálculo que hará la venta, sin escribir. */
export async function previsualizarCobro(
  llamar: Llamar,
  req: {
    company_id: string;
    total: string;
    payments: { instrument: string; currency: string; amount: string }[];
    offer: { instrument: string; currency: string }[];
  },
): Promise<CobroPrevisto> {
  const r = await llamar<{
    paid_functional: string;
    remaining_functional: string;
    complete: boolean;
    change: { amount: string; currency: string } | null;
    rows: {
      instrument: string;
      currency: string;
      applied: string | null;
      applied_functional: string | null;
      igtf: string | null;
      change: string | null;
      covers: boolean;
      error: string | null;
    }[];
    suggestions: {
      instrument: string;
      currency: string;
      amount: string | null;
      igtf: string | null;
    }[];
  }>("/v1/pos/tender", { method: "POST", body: JSON.stringify(req) });
  return {
    pagado: r.paid_functional,
    falta: r.remaining_functional,
    completo: r.complete,
    vuelto: r.change,
    filas: r.rows.map((f) => ({
      instrument: f.instrument,
      currency: f.currency,
      abono: f.applied,
      abonoFuncional: f.applied_functional,
      igtf: f.igtf,
      vuelto: f.change,
      cubre: f.covers,
      error: f.error,
    })),
    sugerencias: r.suggestions.map((s) => ({
      instrument: s.instrument,
      currency: s.currency,
      monto: s.amount,
      igtf: s.igtf,
    })),
  };
}

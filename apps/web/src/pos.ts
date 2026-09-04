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
      lines: readonly (Omit<LineaCotizada, "precio_bs" | "total_bs"> & {
        functional_unit_price: string;
        functional_total: string;
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
    lines: lines.map(({ functional_unit_price, functional_total, ...l }) => ({
      ...l,
      precio_bs: functional_unit_price,
      total_bs: functional_total,
    })),
  };
}

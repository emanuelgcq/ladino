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
  readonly unit_price: string;
  /** El precio de lista exacto en la moneda ancla (contrato: reference_unit_price). */
  readonly precio_referencia: string | null;
  readonly total: string;
}

export interface CotizacionPos {
  readonly customer_id: string;
  readonly price_list_id: string;
  readonly currency: string;
  /** La tasa del día que usó el servidor (el contrato la llama fx_rate). */
  readonly tasa: string;
  /** La moneda ancla de la lista y su tasa aplicada (contrato: pricing_*). */
  readonly moneda_referencia: string | null;
  readonly tasa_precios: string | null;
  /** El total dividido por esa tasa, del servidor (contrato: reference_total). */
  readonly total_referencia: string | null;
  readonly lines: readonly LineaCotizada[];
  readonly subtotal: string;
  readonly tax_amount: string;
  readonly total: string;
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
    Omit<
      CotizacionPos,
      "tasa" | "moneda_referencia" | "tasa_precios" | "total_referencia" | "lines"
    > & {
      fx_rate: string;
      pricing_currency: string | null;
      pricing_fx_rate: string | null;
      pricing_rate_source: string | null;
      reference_total: string | null;
      lines: readonly (Omit<LineaCotizada, "precio_referencia"> & {
        reference_unit_price: string | null;
      })[];
    }
  >("/v1/pos/quote", {
    method: "POST",
    body: JSON.stringify(req),
  });
  const {
    fx_rate,
    pricing_currency,
    pricing_fx_rate,
    pricing_rate_source: _fuente,
    reference_total,
    lines,
    ...resto
  } = r;
  return {
    ...resto,
    tasa: fx_rate,
    moneda_referencia: pricing_currency,
    tasa_precios: pricing_fx_rate,
    total_referencia: reference_total,
    lines: lines.map(({ reference_unit_price, ...l }) => ({
      ...l,
      precio_referencia: reference_unit_price,
    })),
  };
}

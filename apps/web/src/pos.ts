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
  readonly total: string;
}

export interface CotizacionPos {
  readonly customer_id: string;
  readonly price_list_id: string;
  readonly currency: string;
  /** La tasa del día que usó el servidor (el contrato la llama fx_rate). */
  readonly tasa: string;
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
  const r = await llamar<CotizacionPos & { fx_rate: string }>("/v1/pos/quote", {
    method: "POST",
    body: JSON.stringify(req),
  });
  const { fx_rate, ...resto } = r;
  return { ...resto, tasa: fx_rate };
}

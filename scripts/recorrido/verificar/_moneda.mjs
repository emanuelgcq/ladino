/**
 * Familia «moneda A» (ADR-0075 §1-4): lo que comparten las comprobaciones de D, E, F, G y H.
 *
 * Todo ocurre en E2 (Ferretería, precios en USD, con contabilidad) sobre documentos NUEVOS, para
 * no gastar los del escenario. El pago a proveedor sale del banco en bolívares con más saldo: es
 * el REPRODUCIR de D-02 («factura en USD → Transferencia → Banco Mercantil»).
 */
import { pedir, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";

export { afirmar, sql, EMPRESAS };

export const E2 = EMPRESAS.E2;
const RUN = Date.now().toString(36);

/** La cuenta en bolívares de E2 con más saldo, y cuánto tiene. */
export async function bancoBsE2() {
  const [c] = await sql`
    select a.id, a.name, coalesce(b.balance, 0)::text as saldo
      from public.company_accounts a
      left join public.company_account_balances b on b.account_id = a.id
     where a.company_id = ${E2} and a.currency = 'VES' and a.is_active and not a.is_system
     order by coalesce(b.balance, 0) desc limit 1`;
  afirmar(c, "E2 no trae una cuenta en bolívares");
  return c;
}

let compra = null;
/**
 * Una compra de E2 en USD (2 × 10 + IVA) pagada ENTERA desde el banco en bolívares, sin decir
 * otra cosa que la cuenta: la moneda del pago es la de la factura y el dinero sale en Bs a la
 * tasa del día. Devuelve la factura, la respuesta del pago y la fila del pago.
 */
export async function compraUsdPagadaEnBs() {
  if (compra !== null) return compra;
  const [base] = await sql`
    select i.supplier_id, l.product_id
      from public.supplier_invoices i
      join public.supplier_invoice_lines l on l.supplier_invoice_id = i.id
     where i.company_id = ${E2} and i.supplier_document_number = '000123'
     limit 1`;
  afirmar(base, "no está la factura 000123 en E2: el escenario no es el del recorrido");
  const [hoy] = await sql`select (now() at time zone 'America/Caracas')::date::text as d`;
  const f = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/supplier-invoices", {
    company_id: E2,
    supplier_id: base.supplier_id,
    supplier_document_number: `MA-${RUN}`,
    supplier_control_number: `00-${RUN}`,
    invoice_date: hoy.d,
    currency: "USD",
    lines: [{ product_id: base.product_id, quantity: "2", unit_price: "10" }],
  });
  afirmar(f.status === 201, `registrar la compra: ${f.status} ${f.texto.slice(0, 300)}`);
  const [saldo] = await sql`
    select platform.supplier_invoice_balance(${E2}, ${f.json.id})::text as s`;
  const banco = await bancoBsE2();
  const pago = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/supplier-payments", {
    company_id: E2,
    supplier_invoice_id: f.json.id,
    gross_amount: saldo.s,
    currency: "USD",
    instrument: "transferencia",
    account_id: banco.id,
    allow_negative_balance: true,
    overdraft_reason: "Comprobación del recorrido: pago cruzado USD desde el banco en Bs",
  });
  const [fila] =
    pago.status === 201
      ? await sql`
          select transaction_currency, net_amount::text as salio, fx_rate::text as tasa,
                 settled_amount::text as saldado, settled_currency,
                 exchange_difference::text as diferencial,
                 round(settled_amount * platform.rate_at(${E2}, settled_currency, functional_currency,
                                                         platform.caracas_day(paid_at)), 2)::text as esperado_bs
            from public.supplier_payments where id = ${pago.json.payment.id}`
      : [null];
  compra = { factura: f.json, saldo: saldo.s, pago, fila, banco };
  return compra;
}

let venta = null;
/**
 * Una factura de E2 en USD (un producto con existencia) cobrada ENTERA en bolívares a la tasa
 * del día. Devuelve el documento, la respuesta del cobro y la fila del cobro.
 */
export async function ventaUsdCobradaEnBs() {
  if (venta !== null) return venta;
  const [w] = await sql`select id from public.warehouses where company_id = ${E2} limit 1`;
  const [p] = await sql`
    select sb.product_id from public.stock_balances sb
      join public.products pr on pr.id = sb.product_id
     where sb.company_id = ${E2} and sb.quantity > 2 and pr.status = 'active'
       and pr.tax_category_code = 'gravado_general' and pr.system_code is null
     order by sb.quantity desc limit 1`;
  const [cl] = await sql`
    select id from public.customers
     where company_id = ${E2} and not is_system and tax_id is not null and status = 'active'
     order by legal_name limit 1`;
  afirmar(w && p && cl, "E2 no trae depósito, producto gravado con existencia o cliente con RIF");
  const f = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/invoices", {
    company_id: E2,
    customer_id: cl.id,
    warehouse_id: w.id,
    lines: [{ product_id: p.product_id, quantity: "1" }],
  });
  afirmar(f.status === 201, `emitir en E2: ${f.status} ${f.texto.slice(0, 300)}`);
  const [d] = await sql`
    select transaction_currency as moneda, fx_rate, amount_transaction_currency::text as usd,
           subtotal_amount::text as base, tax_amount::text as iva, total_amount::text as total,
           round(amount_transaction_currency
                 * platform.rate_at(${E2}, transaction_currency, functional_currency,
                                    (now() at time zone 'America/Caracas')::date), 2)::text as bs_hoy
      from public.documents where id = ${f.json.id}`;
  afirmar(d.moneda === "USD", `la factura de E2 nació en ${d.moneda}, no en USD`);
  const banco = await bancoBsE2();
  const cobro = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/payments", {
    company_id: E2,
    document_id: f.json.id,
    currency: "VES",
    amount: d.bs_hoy,
    instrument: "transferencia",
    account_id: banco.id,
  });
  const [fila] =
    cobro.status === 201
      ? await sql`
          select settled_transaction_amount::text as saldado
            from public.payments where id = ${cobro.json.payment.id}`
      : [null];
  venta = { doc: f.json, importes: d, cobro, fila };
  return venta;
}

/** Lo que el mayor todavía le carga al documento ('ar' | 'ap'); null si alguna pieza está en cola. */
export async function abiertoEnMayor(lado, id) {
  const [f] = await sql`select platform.settlement_ledger_open(${E2}, ${lado}, ${id})::text as v`;
  return f.v;
}

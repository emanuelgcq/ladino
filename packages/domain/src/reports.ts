import type { TransactionSql } from "@ladino/db";
import type { ReportColumn, ReportSummaryLine, ReportTable } from "@ladino/schemas";

/**
 * LOS REPORTES Y LAS CARTERAS, como lecturas con nombre del dominio (recorrido 2026-09-24:
 * P-07, F-13 y H-11).
 *
 * Reglas de la casa que valen para todas:
 *
 *  1. NO autorizan: el permiso lo exige quien llama (la ruta), y quien llama dice además si el rol
 *     puede ver el VALOR del inventario (`canSeeValue`).
 *  2. Ninguna cifra se suma en JavaScript: filas y totales salen de SQL `numeric`, redondeados al
 *     servir. Aquí solo se colocan en la tabla.
 *  3. La deuda sale de las funciones únicas de deuda (ADR-0075 §5): `platform.ar_aging`,
 *     `platform.customer_overdue_today`, `platform.document_debt`, `platform.ap_aging`,
 *     `platform.supplier_debt_today`. `null` NO es cero: es «falta la tasa de hoy».
 *  4. El IVA del período se LEE de `iva_period_results` (lo que calculó `recompute_iva_period`) y
 *     el IGTF de `platform.igtf_period_totals`: aquí no se recalcula ningún impuesto.
 *  5. Todo rango es de DÍAS de Caracas: dos `date` contra `platform.caracas_day(instante)`, nunca
 *     un `timestamptz` contra un `date` (CLAUDE.md §3). «Hoy» es `platform.caracas_day(now())`.
 *  6. Qué es una VENTA aquí: factura, recibo y nota de débito emitidos, menos notas de crédito y
 *     recibos de devolución. La nota de débito por IGTF no es venta (su línea es la percepción) y
 *     la factura de retiro de inventario tampoco (ADR-0082): están en el libro de ventas, no aquí.
 */

export interface ReportPaging {
  /** 1 por omisión. */
  readonly page?: number | undefined;
  /** 200 por omisión; `all` lo ignora (la descarga lleva todas las filas). */
  readonly perPage?: number | undefined;
  readonly all?: boolean | undefined;
}

export interface ReportRange extends ReportPaging {
  readonly from: string;
  readonly to: string;
}

type Fila = Record<string, string | null>;
type Pagina = Pick<ReportTable, "rows" | "row_count" | "page" | "per_page">;

const POR_PAGINA = 200;

/** La página pedida. No es aritmética de dinero: reparte filas ya calculadas. */
function paginar(filas: readonly Fila[], p: ReportPaging): Pagina {
  if (p.all === true) {
    return { rows: [...filas], row_count: filas.length, page: 1, per_page: filas.length };
  }
  const porPagina = p.perPage ?? POR_PAGINA;
  const pagina = p.page ?? 1;
  return {
    rows: filas.slice((pagina - 1) * porPagina, pagina * porPagina),
    row_count: filas.length,
    page: pagina,
    per_page: porPagina,
  };
}

interface Empresa {
  readonly moneda: string;
  readonly hoy: string;
}

async function empresaYHoy(tx: TransactionSql, companyId: string): Promise<Empresa | null> {
  const [e] = await tx<{ moneda: string; hoy: string }[]>`
    select functional_currency_code as moneda, platform.caracas_day(now())::text as hoy
      from public.companies where id = ${companyId}`;
  return e ?? null;
}

/**
 * Los documentos que son VENTA en el rango (regla 6), con su signo. Un documento cuyas líneas son
 * todas la percepción de IGTF no es venta: se queda fuera, igual que su total vale cero en el
 * libro de ventas.
 */
function ventasDelRango(
  tx: TransactionSql,
  companyId: string,
  from: string,
  to: string,
): ReturnType<TransactionSql> {
  return tx`
    select d.id, d.kind, platform.caracas_day(d.issued_at) as dia, d.created_by,
           coalesce(d.customer_name_snapshot, c.legal_name, 'Sin cliente') as cliente,
           d.customer_id,
           case when d.kind in ('credit_note', 'receipt_return') then -1 else 1 end as signo,
           d.subtotal_amount, d.tax_amount, d.total_amount
      from public.documents d
      left join public.customers c on c.id = d.customer_id
     where d.company_id = ${companyId}
       and d.kind in ('invoice', 'receipt', 'debit_note', 'credit_note', 'receipt_return')
       and d.status in ('issued', 'paid')
       and platform.caracas_day(d.issued_at) between ${from}::date and ${to}::date
       and (not exists (select 1 from public.document_lines l where l.document_id = d.id)
            or exists (select 1 from public.document_lines l
                         left join public.products p on p.id = l.product_id
                        where l.document_id = d.id
                          and p.system_code is distinct from 'igtf'))`;
}

const FORMAS_DE_PAGO: Record<string, string> = {
  efectivo_bs: "Efectivo en bolívares",
  efectivo_usd: "Efectivo en dólares",
  zelle: "Zelle",
  usdt: "USDT",
  transferencia: "Transferencia",
  punto_venta: "Punto de venta",
  pago_movil: "Pago móvil",
  tarjeta: "Tarjeta",
  cashea: "Cashea",
  saldo_a_favor: "Saldo a favor",
  retencion_iva: "Retención de IVA",
  otro: "Otro",
};

export type SalesGroup = "day" | "month" | "product" | "customer" | "payment_method" | "seller";

const NOTA_VENTA =
  "Venta = facturas, recibos y notas de débito emitidos, menos notas de crédito y devoluciones. Las anuladas no cuentan.";

/**
 * «Ventas con factura» NO es el libro de ventas: el libro lleva además las facturas de retiro de
 * inventario (ADR-0082) con sus notas y las notas de débito por IGTF, que no son ventas. La
 * conciliación es ventas con factura + retiros del libro (las facturas de retiro Y sus notas:
 * `kind like 'withdrawal%'`) = total del libro (la nota de débito por IGTF va en el libro con
 * total de venta cero y lo percibido en su columna).
 */
const NOTA_CON_FACTURA =
  "«Ventas con factura» son las facturas y sus notas. No cuenta las facturas de retiro de inventario ni las notas de débito por IGTF: están en el libro de ventas, no son ventas.";

/** (1) VENTAS del rango, agrupadas. `null` si la empresa no existe o no es visible. */
export async function salesReport(
  tx: TransactionSql,
  companyId: string,
  q: ReportRange & { readonly group?: SalesGroup | undefined },
): Promise<ReportTable | null> {
  const e = await empresaYHoy(tx, companyId);
  if (!e) return null;
  const grupo = q.group ?? "day";
  const docs = ventasDelRango(tx, companyId, q.from, q.to);
  let columns: ReportColumn[];
  let filas: Fila[];
  let totals: Fila;
  const notes = [NOTA_VENTA, NOTA_CON_FACTURA];

  // El total del rango, SIEMPRE por documento (no por línea): es el pie de cada documento.
  const [t] = await tx<Fila[]>`
    with docs as (${docs})
    select count(*)::text as documents,
           round(coalesce(sum(x.signo * x.subtotal_amount), 0), 2)::text as base,
           round(coalesce(sum(x.signo * x.tax_amount), 0), 2)::text as tax,
           round(coalesce(sum(x.signo * x.total_amount), 0), 2)::text as total,
           round(coalesce(sum(x.signo * x.total_amount)
                 filter (where x.kind in ('invoice', 'credit_note', 'debit_note')), 0), 2)::text
             as fiscal_total,
           round(coalesce(sum(x.signo * x.total_amount)
                 filter (where x.kind in ('receipt', 'receipt_return')), 0), 2)::text
             as receipts_total
      from docs x`;

  if (grupo === "payment_method") {
    // Lo COBRADO en el rango, por forma de pago y moneda: es dinero que entró, no ventas del
    // rango (un cobro de hoy puede ser de una venta de ayer). Un cobro reversado no cuenta.
    const cobros = tx`
      select p.instrument, p.currency, p.amount, p.functional_amount
        from public.payments p
        join public.documents d on d.id = p.document_id
       where p.company_id = ${companyId}
         and d.kind in ('invoice', 'receipt', 'debit_note')
         and platform.caracas_day(p.paid_at) between ${q.from}::date and ${q.to}::date
         and not exists (select 1 from public.payment_reversals pr where pr.payment_id = p.id)`;
    const r = await tx<Fila[]>`
      with cobros as (${cobros})
      select instrument, currency as moneda, count(*)::text as payments,
             round(sum(amount), 2)::text as nominal,
             round(sum(functional_amount), 2)::text as collected
        from cobros group by instrument, currency
       order by sum(functional_amount) desc, instrument, currency`;
    filas = r.map((f) => ({
      ...f,
      label: FORMAS_DE_PAGO[f["instrument"] ?? ""] ?? f["instrument"] ?? "",
    }));
    const [c] = await tx<Fila[]>`
      with cobros as (${cobros})
      select count(*)::text as payments,
             round(coalesce(sum(functional_amount), 0), 2)::text as collected from cobros`;
    totals = c ?? {};
    columns = [
      { key: "label", label: "Forma de pago", kind: "text" },
      { key: "moneda", label: "Moneda", kind: "text" },
      { key: "payments", label: "Cobros", kind: "integer" },
      { key: "nominal", label: "Cobrado en su moneda", kind: "quantity" },
      { key: "collected", label: `Cobrado en ${e.moneda}`, kind: "money" },
    ];
    notes.push(
      "Por forma de pago se enseña lo COBRADO en el período, a la tasa de cada cobro: incluye cobros de ventas anteriores, y un cobro reversado no cuenta. Por eso no tiene que coincidir con lo vendido.",
    );
  } else if (grupo === "product") {
    const lineas = tx`
      select l.product_id, coalesce(p.name, l.description) as producto, p.sku,
             x.signo * l.quantity as cantidad,
             x.signo * l.line_subtotal_functional as base,
             x.signo * (l.line_total_functional - l.line_subtotal_functional) as impuesto,
             x.signo * l.line_total_functional as importe
        from docs x
        join public.document_lines l on l.document_id = x.id
        left join public.products p on p.id = l.product_id
       where p.system_code is distinct from 'igtf'`;
    filas = await tx<Fila[]>`
      with docs as (${docs}), lineas as (${lineas})
      select producto as label, sku, trim_scale(sum(cantidad))::text as quantity,
             round(sum(base), 2)::text as base, round(sum(impuesto), 2)::text as tax,
             round(sum(importe), 2)::text as total
        from lineas group by product_id, producto, sku
       order by sum(importe) desc, producto`;
    const [l] = await tx<Fila[]>`
      with docs as (${docs}), lineas as (${lineas})
      select round(coalesce(sum(base), 0), 2)::text as base,
             round(coalesce(sum(impuesto), 0), 2)::text as tax,
             round(coalesce(sum(importe), 0), 2)::text as total from lineas`;
    totals = l ?? {};
    columns = [
      { key: "label", label: "Producto", kind: "text" },
      { key: "sku", label: "Código", kind: "text" },
      { key: "quantity", label: "Cantidad", kind: "quantity" },
      { key: "base", label: "Sin impuesto", kind: "money" },
      { key: "tax", label: "Impuesto", kind: "money" },
      { key: "total", label: "Total", kind: "money" },
    ];
  } else {
    const clave =
      grupo === "day"
        ? tx`x.dia::text`
        : grupo === "month"
          ? tx`to_char(x.dia, 'YYYY-MM')`
          : grupo === "customer"
            ? tx`x.cliente`
            : tx`coalesce((select nullif(btrim(up.full_name), '') from public.users_profile up
                            where up.user_id = x.created_by), 'Sin nombre')`;
    const orden =
      grupo === "day" || grupo === "month" ? tx`1` : tx`sum(x.signo * x.total_amount) desc, 1`;
    filas = await tx<Fila[]>`
      with docs as (${docs})
      select ${clave} as label, count(*)::text as documents,
             round(sum(x.signo * x.subtotal_amount), 2)::text as base,
             round(sum(x.signo * x.tax_amount), 2)::text as tax,
             round(sum(x.signo * x.total_amount), 2)::text as total
        from docs x
       group by ${grupo === "seller" ? tx`x.created_by` : grupo === "customer" ? tx`x.customer_id, x.cliente` : tx`1`}
       order by ${orden}`;
    columns = [
      {
        key: "label",
        label:
          grupo === "day"
            ? "Día"
            : grupo === "month"
              ? "Mes"
              : grupo === "customer"
                ? "Cliente"
                : "Vendedor",
        kind: grupo === "day" ? "date" : "text",
      },
      { key: "documents", label: "Documentos", kind: "integer" },
      { key: "base", label: "Sin impuesto", kind: "money" },
      { key: "tax", label: "Impuesto", kind: "money" },
      { key: "total", label: "Total", kind: "money" },
    ];
    totals = {
      documents: t?.["documents"] ?? "0",
      base: t?.["base"] ?? "0.00",
      tax: t?.["tax"] ?? "0.00",
      total: t?.["total"] ?? "0.00",
    };
    if (grupo === "seller") notes.push("El vendedor es quien emitió el documento.");
  }

  const summary: ReportSummaryLine[] = [
    { key: "total", label: "Vendido en el período", kind: "money", value: t?.["total"] ?? "0.00" },
    {
      key: "fiscal_total",
      label: "Ventas con factura",
      kind: "money",
      value: t?.["fiscal_total"] ?? "0.00",
    },
    {
      key: "receipts_total",
      label: "Con recibo",
      kind: "money",
      value: t?.["receipts_total"] ?? "0.00",
    },
  ];
  return {
    report: "sales",
    title: "Ventas",
    from: q.from,
    to: q.to,
    as_of: e.hoy,
    currency: e.moneda,
    group: grupo,
    columns,
    totals,
    summary,
    notes,
    ...paginar(filas, q),
  };
}

export type MarginGroup = "product" | "month" | "day";

/**
 * (2) MARGEN: ventas (sin impuesto) menos el costo con que salió la mercancía. La MISMA regla que
 * «lo que gané» del resumen del negocio: un servicio no tiene costo de mercancía; una devolución
 * con mercancía devuelve su costo; una línea de mercancía sin costo cargado NO entra en el margen
 * (no se inventa un costo cero) y se dice aparte.
 *
 * Un producto COMPUESTO (I-04, ADR-0035) no lleva `cost_snapshot` en su línea: su costo es lo que
 * sacaron sus ingredientes, y está en `public.sale_line_components`. El costo de la venta es la
 * suma del valor de sus filas de salida (`out`) y el de su devolución, la de sus filas de
 * reingreso (`back`): valores de kardex, ya al céntimo, leídos tal cual. No se reconstruye un
 * costo unitario (53 / 3 × 3 no da 53). Una línea de compuesto sin filas de salida —lo que
 * `platform.composite_sale_gaps` llama `sin_salidas`— sigue siendo «venta sin costo».
 *
 * El diferencial cambiario es una línea del resumen (P-07): el REALIZADO, de `exchange_gain_loss`
 * sin los cobros reversados. La revaluación de saldos en divisa no es un hecho que Ladino
 * registre hoy: va en `null` con su motivo, nunca en cero.
 */
export async function marginReport(
  tx: TransactionSql,
  companyId: string,
  q: ReportRange & { readonly group?: MarginGroup | undefined },
): Promise<ReportTable | null> {
  const e = await empresaYHoy(tx, companyId);
  if (!e) return null;
  const grupo = q.group ?? "product";
  const docs = ventasDelRango(tx, companyId, q.from, q.to);
  const lineas = tx`
    select x.dia, x.kind, l.product_id, coalesce(p.name, l.description) as producto,
           x.signo * l.line_subtotal_functional as venta,
           case -- La devolución de una línea que se vendió SIN costo cargado resta de donde
                -- sumó la venta: de «venta sin costo», no de la venta con costo (si no, el
                -- margen baja por una venta que nunca entró en él). Se reconoce por la línea de
                -- origen de la devolución; una nota de crédito SIN devolución no tiene línea de
                -- origen y resta de la venta con costo.
                when x.kind in ('credit_note', 'receipt_return')
                     and exists (select 1
                                   from public.returns r
                                   join public.return_lines rl on rl.return_id = r.id
                                   join public.document_lines ol on ol.id = rl.source_line_id
                                   left join public.products op on op.id = ol.product_id
                                  where r.credit_note_id = x.id and r.status = 'confirmed'
                                    and rl.product_id is not distinct from l.product_id
                                    and ol.cost_snapshot is null
                                    and op.kind is distinct from 'service'
                                    -- La línea de un compuesto SÍ tuvo costo: el de sus salidas.
                                    and not exists (select 1 from public.sale_line_components sc
                                                     where sc.document_line_id = ol.id
                                                       and sc.direction = 'out')) then null
                when x.kind not in ('invoice', 'receipt') then 0
                when l.cost_snapshot is not null then l.cost_snapshot * l.quantity
                -- Compuesto: lo que sacaron sus ingredientes (sin filas, la suma es NULL y sigue).
                when comp.costo is not null then comp.costo
                when p.kind = 'service' then 0
                else null end as costo
      from docs x
      join public.document_lines l on l.document_id = x.id
      left join public.products p on p.id = l.product_id
      left join lateral (select sum(sc.functional_amount) as costo
                           from public.sale_line_components sc
                          where sc.document_line_id = l.id and sc.direction = 'out') comp on true
     where p.system_code is distinct from 'igtf'
    union all
    -- El costo que VUELVE con una devolución confirmada: el de la línea de origen o, si es de un
    -- compuesto, el de los reingresos ('back') de ESA devolución sobre esa línea.
    select x.dia, x.kind, ol.product_id, coalesce(p.name, ol.description),
           0, -coalesce(rl.quantity * ol.cost_snapshot,
                        (select sum(sc.functional_amount)
                           from public.sale_line_components sc
                          where sc.return_id = r.id and sc.document_line_id = ol.id
                            and sc.direction = 'back'),
                        0)
      from docs x
      join public.returns r on r.credit_note_id = x.id and r.status = 'confirmed'
      join public.return_lines rl on rl.return_id = r.id
      join public.document_lines ol on ol.id = rl.source_line_id
      left join public.products p on p.id = ol.product_id
     where x.kind in ('credit_note', 'receipt_return')`;
  const cifras = tx`
    round(coalesce(sum(venta) filter (where costo is not null), 0), 2)::text as sales,
    round(coalesce(sum(costo), 0), 2)::text as cost,
    round(coalesce(sum(venta - costo), 0), 2)::text as margin,
    (case when coalesce(sum(venta) filter (where costo is not null), 0) = 0 then null
          else round(sum(venta - costo) * 100
                     / (sum(venta) filter (where costo is not null)), 2) end)::text as margin_pct,
    round(coalesce(sum(venta) filter (where costo is null), 0), 2)::text as sales_without_cost`;
  const filas =
    grupo === "product"
      ? await tx<Fila[]>`
          with docs as (${docs}), lineas as (${lineas})
          select producto as label, ${cifras}
            from lineas group by product_id, producto
           order by sum(venta - costo) desc nulls last, producto`
      : await tx<Fila[]>`
          with docs as (${docs}), lineas as (${lineas})
          select ${grupo === "month" ? tx`to_char(dia, 'YYYY-MM')` : tx`dia::text`} as label,
                 ${cifras}
            from lineas group by 1 order by 1`;
  const [t] = await tx<Fila[]>`
    with docs as (${docs}), lineas as (${lineas})
    select ${cifras},
           -- Solo las líneas VENDIDAS: la devolución de una línea sin costo también lleva el costo
           -- en null (resta de «venta sin costo»), pero no es otra línea vendida.
           (count(*) filter (where costo is null and kind in ('invoice', 'receipt')))::text
             as lines_without_cost
      from lineas`;
  const [dif] = await tx<Fila[]>`
    select round(coalesce(sum(difference) filter (where difference > 0), 0), 2)::text as ganancia,
           round(coalesce(sum(difference) filter (where difference < 0), 0), 2)::text as perdida,
           round(coalesce(sum(difference), 0), 2)::text as neto,
           round(${t?.["margin"] ?? "0"}::numeric + coalesce(sum(difference), 0), 2)::text
             as con_diferencial
      from public.exchange_gain_loss x
     where x.company_id = ${companyId}
       and not exists (select 1 from public.payment_reversals pr
                        where pr.payment_id = x.payment_id)
       and x.occurred_on between ${q.from}::date and ${q.to}::date`;
  const sinCosto = t?.["lines_without_cost"] ?? "0";
  const notes = [
    NOTA_VENTA,
    "El costo es el del kardex en el momento de cada venta. Gastos, mermas y faltantes de caja no están aquí: están en el estado de resultados.",
    "Ladino no registra todavía la revaluación de los saldos en divisa: esa línea va vacía, no en cero.",
  ];
  if (sinCosto !== "0") {
    notes.push(
      `${sinCosto} línea(s) de mercancía se vendieron sin costo cargado: su venta va en «Venta sin costo» y no entra en el margen.`,
    );
  }
  const dinero = (key: string, label: string, value: string): ReportSummaryLine => ({
    key,
    label,
    kind: "money",
    value,
  });
  return {
    report: "margin",
    title: "Margen",
    from: q.from,
    to: q.to,
    as_of: e.hoy,
    currency: e.moneda,
    group: grupo,
    columns: [
      {
        key: "label",
        label: grupo === "product" ? "Producto" : grupo === "month" ? "Mes" : "Día",
        kind: grupo === "day" ? "date" : "text",
      },
      { key: "sales", label: "Venta sin impuesto", kind: "money" },
      { key: "cost", label: "Costo", kind: "money" },
      { key: "margin", label: "Margen", kind: "money" },
      { key: "margin_pct", label: "Margen %", kind: "percent" },
      { key: "sales_without_cost", label: "Venta sin costo", kind: "money" },
    ],
    totals: {
      sales: t?.["sales"] ?? "0.00",
      cost: t?.["cost"] ?? "0.00",
      margin: t?.["margin"] ?? "0.00",
      margin_pct: t?.["margin_pct"] ?? null,
      sales_without_cost: t?.["sales_without_cost"] ?? "0.00",
    },
    summary: [
      dinero("margin", "Margen de lo vendido", t?.["margin"] ?? "0.00"),
      dinero("exchange_gain", "Diferencial cambiario: ganancia", dif?.["ganancia"] ?? "0.00"),
      dinero("exchange_loss", "Diferencial cambiario: pérdida", dif?.["perdida"] ?? "0.00"),
      dinero(
        "exchange_realized",
        "Diferencial cambiario realizado (neto)",
        dif?.["neto"] ?? "0.00",
      ),
      {
        key: "exchange_revaluation",
        label: "Revaluación de saldos en divisa",
        kind: "money",
        value: null,
        reason: "sin_dato",
      },
      dinero(
        "margin_with_exchange",
        "Margen más diferencial realizado",
        dif?.["con_diferencial"] ?? t?.["margin"] ?? "0.00",
      ),
    ],
    notes,
    ...paginar(filas, q),
  };
}

/**
 * (3) IVA DEL PERÍODO: lo que YA calculó `recompute_iva_period` y quedó en `iva_period_results`
 * (la última corrida de cada período que toca el rango). No recalcula. Las retenciones
 * PRACTICADAS son las de IVA no canceladas de `supplier_retentions`, por el día en que se
 * practicaron.
 */
export async function ivaReport(
  tx: TransactionSql,
  companyId: string,
  q: ReportRange,
): Promise<ReportTable | null> {
  const e = await empresaYHoy(tx, companyId);
  if (!e) return null;
  const filas = await tx<Fila[]>`
    select distinct on (r.period_from, r.period_to)
           r.period_from::text as period_from, r.period_to::text as period_to,
           round(r.debitos, 2)::text as debits,
           round(r.creditos, 2)::text as credits,
           round(r.creditos_deducibles, 2)::text as deductible_credits,
           round(r.retenciones_soportadas, 2)::text as withholdings_suffered,
           (select round(coalesce(sum(sr.retained_amount), 0), 2)::text
              from public.supplier_retentions sr
             where sr.company_id = r.company_id and sr.retention_code = 'iva'
               and sr.status <> 'cancelled'
               and platform.caracas_day(sr.applied_at) between r.period_from and r.period_to)
             as withholdings_practiced,
           round(r.excedente_anterior, 2)::text as previous_surplus,
           round(r.cuota_a_pagar, 2)::text as payable,
           round(r.excedente_siguiente, 2)::text as next_surplus,
           platform.caracas_day(r.created_at)::text as computed_on
      from public.iva_period_results r
     where r.company_id = ${companyId}
       and r.period_to >= ${q.from}::date and r.period_from <= ${q.to}::date
     order by r.period_from, r.period_to, r.created_at desc`;
  const notes = [
    "Cada renglón es un período ya calculado en «Declarar IVA» (quincena o mes, según el tipo de contribuyente): su última corrida. Este reporte no recalcula.",
    "Las retenciones practicadas son las que la empresa hizo a sus proveedores en el período.",
    // Lo que este reporte es y lo que no (auditoría fiscal, AF5-16). Textos literales.
    'Es un resumen de gestión: no es la declaración ni la Forma 30. Las cifras son las de "Declarar IVA", que tu contador confirma antes de presentar.',
    'Las retenciones practicadas no restan de "A pagar": se enteran aparte, por quincena.',
  ];
  if (filas.length === 0) {
    notes.push(
      "Ningún período del rango tiene el IVA calculado todavía: calcúlalo en «Declarar IVA».",
    );
  }
  return {
    report: "iva",
    title: "IVA del período",
    from: q.from,
    to: q.to,
    as_of: e.hoy,
    currency: e.moneda,
    group: null,
    columns: [
      { key: "period_from", label: "Desde", kind: "date" },
      { key: "period_to", label: "Hasta", kind: "date" },
      { key: "debits", label: "Débitos", kind: "money" },
      { key: "credits", label: "Créditos", kind: "money" },
      { key: "deductible_credits", label: "Créditos deducibles", kind: "money" },
      { key: "withholdings_suffered", label: "Retenciones soportadas", kind: "money" },
      { key: "withholdings_practiced", label: "Retenciones practicadas", kind: "money" },
      { key: "previous_surplus", label: "Excedente anterior", kind: "money" },
      { key: "payable", label: "A pagar", kind: "money" },
      { key: "next_surplus", label: "Excedente para el siguiente", kind: "money" },
      { key: "computed_on", label: "Calculado el", kind: "date" },
    ],
    // Los períodos no se suman: el excedente de uno es el punto de partida del siguiente.
    totals: {},
    summary: [],
    notes,
    ...paginar(filas, q),
  };
}

/**
 * (4) INVENTARIO VALORIZADO Y ROTACIÓN. La existencia y el valor son los de HOY
 * (`stock_balances`); la rotación mide el rango: unidades que salieron por ventas (salidas del
 * kardex de facturas y recibos, menos lo que volvió por devolución) y los días que dura la
 * existencia a ese ritmo.
 *
 * `canSeeValue` lo decide quien llama: sin él, el valor y el costo van en `null` con
 * `sin_permiso` (el almacén cuenta unidades; el valor es un hecho del mayor).
 */
export async function inventoryReport(
  tx: TransactionSql,
  companyId: string,
  q: ReportRange & { readonly canSeeValue: boolean },
): Promise<ReportTable | null> {
  const e = await empresaYHoy(tx, companyId);
  if (!e) return null;
  const todas = await tx<Fila[]>`
    with saldo as (
      select b.product_id, sum(b.quantity) as cantidad, sum(b.value) as valor
        from public.stock_balances b
       where b.company_id = ${companyId}
       group by b.product_id
    ),
    movimientos_de_venta as (
      -- Lo que salió por una factura o un recibo, y lo que volvió al ANULARLOS (la reposición
      -- de la anulación lleva el documento como origen).
      select m.product_id, m.quantity
        from public.inventory_moves m
        join public.documents d on d.id = m.source_document_id
       where m.company_id = ${companyId}
         and m.kind in ('salida', 'entrada')
         and d.kind in ('invoice', 'receipt')
         and platform.caracas_day(m.occurred_at) between ${q.from}::date and ${q.to}::date
      union all
      -- Lo que volvió por una DEVOLUCIÓN confirmada: su reingreso lleva como origen la
      -- devolución (returns.id), no un documento (confirmReturn, packages/domain/src/sales.ts).
      -- Resta en el período en que la mercancía VUELVE, igual que la salida cuenta cuando sale.
      select m.product_id, m.quantity
        from public.inventory_moves m
        join public.returns r on r.id = m.source_document_id and r.company_id = m.company_id
        join public.documents d on d.id = r.source_document_id
       where m.company_id = ${companyId}
         and m.kind = 'entrada'
         and r.status = 'confirmed'
         and d.kind in ('invoice', 'receipt')
         and platform.caracas_day(m.occurred_at) between ${q.from}::date and ${q.to}::date
    ),
    vendido as (
      select product_id, -sum(quantity) as cantidad from movimientos_de_venta group by product_id
    )
    select p.name as label, p.sku,
           trim_scale(coalesce(s.cantidad, 0))::text as quantity,
           round(coalesce(s.valor, 0), 2)::text as value,
           (case when coalesce(s.cantidad, 0) > 0
                 then round(s.valor / s.cantidad, 8) end)::text as unit_cost,
           trim_scale(coalesce(v.cantidad, 0))::text as sold,
           (case when coalesce(v.cantidad, 0) > 0 and coalesce(s.cantidad, 0) > 0
                 then round(s.cantidad * (${q.to}::date - ${q.from}::date + 1) / v.cantidad, 0)
                 end)::text as days_of_stock
      from public.products p
      left join saldo s on s.product_id = p.id
      left join vendido v on v.product_id = p.id
     where p.company_id = ${companyId}
       and (s.product_id is not null or v.product_id is not null)
     -- Quien no ve el valor tampoco lo adivina por el orden: sin él, por nombre.
     order by ${q.canSeeValue ? tx`coalesce(s.valor, 0) desc, p.name` : tx`p.name`}`;
  const ve = q.canSeeValue;
  const filas = ve ? todas : todas.map((f) => ({ ...f, value: null, unit_cost: null }));
  const columns: ReportColumn[] = [
    { key: "label", label: "Producto", kind: "text" },
    { key: "sku", label: "Código", kind: "text" },
    { key: "quantity", label: "Existencia", kind: "quantity" },
    ...(ve
      ? ([
          { key: "unit_cost", label: "Costo promedio", kind: "quantity" },
          { key: "value", label: "Valor", kind: "money" },
        ] satisfies ReportColumn[])
      : []),
    { key: "sold", label: "Vendido en el período", kind: "quantity" },
    { key: "days_of_stock", label: "Días de existencia", kind: "integer" },
  ];
  const notes = [
    "La existencia y el valor son los de hoy. «Vendido en el período» son las unidades que salieron por ventas en el rango, menos las que volvieron en ese mismo rango por una devolución o una anulación (aunque la venta sea anterior).",
    "«Días de existencia» = lo que dura la existencia de hoy al ritmo de venta del rango. Vacío si no hubo ventas o no hay existencia.",
  ];
  let totals: Fila = {};
  let summary: ReportSummaryLine[];
  if (ve) {
    // El valor y su cuadre con el mayor SOLO se consultan si el rol los puede ver.
    const [t] = await tx<Fila[]>`
      select round(coalesce(sum(b.value), 0), 2)::text as value
        from public.stock_balances b where b.company_id = ${companyId}`;
    const [g] = await tx<Fila[]>`
      select round(mayor, 2)::text as mayor, round(diferencia, 2)::text as diferencia,
             round(en_cola, 2)::text as en_cola
        from platform.inventory_ledger_gap(${companyId})`;
    totals = { value: t?.["value"] ?? "0.00" };
    const delMayor = (key: string, label: string, v: string | null | undefined) =>
      ({
        key,
        label,
        kind: "money",
        value: v ?? null,
        reason: v == null ? "sin_dato" : null,
      }) satisfies ReportSummaryLine;
    summary = [
      { key: "value", label: "Valor del inventario hoy", kind: "money", value: totals["value"]! },
      delMayor("ledger", "Inventario según la contabilidad", g?.["mayor"]),
      delMayor("ledger_gap", "Diferencia entre kardex y contabilidad", g?.["diferencia"]),
      delMayor("ledger_queue", "Movimientos todavía sin contabilizar", g?.["en_cola"]),
    ];
  } else {
    summary = [
      {
        key: "value",
        label: "Valor del inventario hoy",
        kind: "money",
        value: null,
        reason: "sin_permiso",
      },
    ];
    notes.push("Tu rol ve las existencias, no su valor.");
  }
  return {
    report: "inventory",
    title: "Inventario valorizado y rotación",
    from: q.from,
    to: q.to,
    as_of: e.hoy,
    currency: e.moneda,
    group: null,
    columns,
    totals,
    summary,
    notes,
    ...paginar(filas, q),
  };
}

const TRAMOS = ["0-30", "31-60", "61-90", "90+"] as const;

/** Coloca el nominal por moneda de cada fila en su columna (`nominal_USD`…). No suma nada. */
function conNominales(
  filas: readonly Fila[],
  nominales: readonly { id: string; currency: string; nominal: string | null }[],
  monedas: readonly string[],
): Fila[] {
  const porId = new Map<string, Fila>();
  for (const n of nominales) {
    const f = porId.get(n.id) ?? {};
    f[`nominal_${n.currency}`] = n.nominal;
    porId.set(n.id, f);
  }
  return filas.map((f) => {
    const propios = porId.get(f["id"] ?? "") ?? {};
    const lleno: Fila = { ...f };
    for (const m of monedas) {
      const k = `nominal_${m}`;
      lleno[k] = k in propios ? (propios[k] ?? null) : "0.00";
    }
    return lleno;
  });
}

function lineaDeDeuda(
  key: string,
  label: string,
  value: string | null | undefined,
): ReportSummaryLine {
  const v = value ?? null;
  return { key, label, kind: "money", value: v, reason: v === null ? "sin_tasa" : null };
}

/** Los tramos de `ar_aging` / `ap_aging`, una fila por tercero. NULL de un tramo no es cero. */
const PIVOTE = `
  sum(a.document_count) as documentos,
  case when bool_or(a.amount is null) then null else sum(a.amount) end as deuda,
  coalesce(bool_or(a.amount is null) filter (where a.bucket = '0-30'), false) as n1,
  coalesce(sum(a.amount) filter (where a.bucket = '0-30'), 0) as b1,
  coalesce(bool_or(a.amount is null) filter (where a.bucket = '31-60'), false) as n2,
  coalesce(sum(a.amount) filter (where a.bucket = '31-60'), 0) as b2,
  coalesce(bool_or(a.amount is null) filter (where a.bucket = '61-90'), false) as n3,
  coalesce(sum(a.amount) filter (where a.bucket = '61-90'), 0) as b3,
  coalesce(bool_or(a.amount is null) filter (where a.bucket = '90+'), false) as n4,
  coalesce(sum(a.amount) filter (where a.bucket = '90+'), 0) as b4`;
const TRAMOS_DE_FILA = `
  (case when t.n1 then null else round(t.b1, 2) end)::text as "b_0-30",
  (case when t.n2 then null else round(t.b2, 2) end)::text as "b_31-60",
  (case when t.n3 then null else round(t.b3, 2) end)::text as "b_61-90",
  (case when t.n4 then null else round(t.b4, 2) end)::text as "b_90+"`;
const TRAMOS_DEL_TOTAL = `
  (select coalesce(sum(documentos), 0)::text from t) as documents,
  (select (case when bool_or(deuda is null) then null
                else round(coalesce(sum(deuda), 0), 2) end)::text from t) as debt,
  (select (case when bool_or(n1) then null else round(coalesce(sum(b1), 0), 2) end)::text
     from t) as "b_0-30",
  (select (case when bool_or(n2) then null else round(coalesce(sum(b2), 0), 2) end)::text
     from t) as "b_31-60",
  (select (case when bool_or(n3) then null else round(coalesce(sum(b3), 0), 2) end)::text
     from t) as "b_61-90",
  (select (case when bool_or(n4) then null else round(coalesce(sum(b4), 0), 2) end)::text
     from t) as "b_90+"`;

/** Lo que devuelve la sentencia única de una cartera: todo ya calculado en Postgres. */
interface UnaPasada {
  readonly filas: Fila[];
  readonly nominales: { id: string; currency: string; nominal: string | null }[];
  readonly por_moneda: { currency: string; nominal: string | null }[];
  readonly total: Fila;
}

export type ReceivablesSortKey = "debt_desc" | "overdue_desc" | "oldest" | "name";

/**
 * (5a) «QUIÉN ME DEBE» (F-13): la cartera de clientes, sin elegir cliente antes. Una fila por
 * cliente que debe, con su deuda a la tasa de hoy, lo vencido, los tramos de antigüedad y el
 * nominal por moneda. Todo de las funciones únicas de deuda; sin tasa, `null` (y el nominal, que
 * sí se conoce, sigue ahí).
 */
export async function receivablesReport(
  tx: TransactionSql,
  companyId: string,
  q: ReportPaging & { readonly sort?: ReceivablesSortKey | undefined },
): Promise<ReportTable | null> {
  const e = await empresaYHoy(tx, companyId);
  if (!e) return null;
  const orden =
    q.sort === "overdue_desc"
      ? tx`(v.customer_id is not null and v.vencido is null) desc, coalesce(v.vencido, 0) desc, c.legal_name`
      : q.sort === "oldest"
        ? tx`n.vence asc nulls last, c.legal_name`
        : q.sort === "name"
          ? tx`c.legal_name`
          : tx`(t.deuda is null) desc, t.deuda desc, c.legal_name`;
  const tramos = tx`
    select a.customer_id, ${tx.unsafe(PIVOTE)}
      from platform.ar_aging(${companyId}, null, ${e.hoy}::date) a
     group by a.customer_id`;
  const vencido = tx`
    select o.customer_id,
           case when bool_or(o.nominal is null or o.functional_today is null) then null
                else sum(o.functional_today) end as vencido
      from platform.customer_overdue_today(${companyId}, null, ${e.hoy}::date) o
     group by o.customer_id`;
  // El nominal y el vencimiento, documento a documento, con la misma función de deuda.
  const porDocumento = tx`
    select d.customer_id, dd.currency, dd.nominal,
           platform.document_due_day(d.due_date, d.issued_at) as vence
      from public.documents d
     cross join lateral platform.document_debt(${companyId}, d.id) dd
     where d.company_id = ${companyId}
       and d.kind in ('invoice', 'receipt', 'debit_note')
       and d.status in ('issued', 'paid')
       and platform.caracas_day(d.issued_at) <= ${e.hoy}::date
       and (dd.nominal > 0 or dd.nominal is null)`;
  // UNA sentencia. Cada función de deuda recorre los documentos UNA vez (los tres CTE se
  // materializan) y de ahí salen las filas, los nominales y los totales: tres pasadas de
  // platform.document_debt por petición (ar_aging, customer_overdue_today y el nominal con su
  // vencimiento), que es el mínimo sin escribir una cuarta regla de deuda. Antes eran cuatro
  // sentencias y siete pasadas.
  const [todo] = await tx<UnaPasada[]>`
    with t as materialized (${tramos}), v as materialized (${vencido}),
         doc as materialized (${porDocumento}),
         n as (select customer_id, min(vence) as vence from doc group by customer_id),
         filas as (
           select c.id::text as id, c.legal_name as label, t.documentos::text as documents,
                  round(t.deuda, 2)::text as debt,
                  (case when v.customer_id is null then round(0::numeric, 2)
                        else round(v.vencido, 2) end)::text as overdue,
                  n.vence::text as oldest_due,
                  greatest(0, ${e.hoy}::date - n.vence)::text as days_overdue,
                  ${tx.unsafe(TRAMOS_DE_FILA)},
                  row_number() over (order by ${orden}) as pos
             from t
             join public.customers c on c.id = t.customer_id
             left join v on v.customer_id = t.customer_id
             left join n on n.customer_id = t.customer_id
         )
    select (select coalesce(jsonb_agg(to_jsonb(x) - 'pos' order by x.pos), '[]'::jsonb)
              from filas x) as filas,
           (select coalesce(jsonb_agg(to_jsonb(x) order by x.currency), '[]'::jsonb)
              from (select customer_id::text as id, currency,
                           (case when bool_or(nominal is null) then null
                                 else round(sum(nominal), 2) end)::text as nominal
                      from doc group by customer_id, currency) x) as nominales,
           (select coalesce(jsonb_agg(to_jsonb(x) order by x.currency), '[]'::jsonb)
              from (select currency,
                           (case when bool_or(nominal is null) then null
                                 else round(sum(nominal), 2) end)::text as nominal
                      from doc group by currency) x) as por_moneda,
           (select to_jsonb(z)
              from (select ${tx.unsafe(TRAMOS_DEL_TOTAL)},
                           (select (case when bool_or(vencido is null) then null
                                         else round(coalesce(sum(vencido), 0), 2) end)::text
                              from v) as overdue) z) as total`;
  const base = todo?.filas ?? [];
  const nominales = todo?.nominales ?? [];
  const porMoneda = todo?.por_moneda ?? [];
  const t = todo?.total;
  const monedas = porMoneda.map((m) => m.currency);
  const totals: Fila = { ...(t ?? {}) };
  for (const m of porMoneda) totals[`nominal_${m.currency}`] = m.nominal;
  return {
    report: "receivables",
    title: "Quién me debe",
    from: null,
    to: null,
    as_of: e.hoy,
    currency: e.moneda,
    group: null,
    columns: [
      { key: "label", label: "Cliente", kind: "text" },
      { key: "documents", label: "Documentos", kind: "integer" },
      ...monedas.map((m): ReportColumn => ({
        key: `nominal_${m}`,
        label: `Debe en ${m}`,
        kind: "money",
        currency: m,
      })),
      { key: "debt", label: "Deuda a la tasa de hoy", kind: "money" },
      { key: "overdue", label: "Vencido", kind: "money" },
      { key: "oldest_due", label: "Vence desde", kind: "date" },
      { key: "days_overdue", label: "Días de vencido", kind: "integer" },
      ...TRAMOS.map((b): ReportColumn => ({ key: `b_${b}`, label: `${b} días`, kind: "money" })),
    ],
    totals,
    summary: [
      lineaDeDeuda("debt", "Me deben, a la tasa de hoy", t?.["debt"]),
      lineaDeDeuda("overdue", "De eso, ya vencido", t?.["overdue"]),
      ...porMoneda.map((m): ReportSummaryLine => ({
        key: `nominal_${m.currency}`,
        label: `Me deben en ${m.currency}`,
        kind: "money",
        value: m.nominal,
        currency: m.currency,
        reason: m.nominal === null ? "sin_dato" : null,
      })),
    ],
    notes: [
      "La deuda en divisa se enseña a la tasa de hoy; lo que se debe de verdad es el importe en su moneda.",
      "Los tramos cuentan los días desde que se emitió cada documento. «Vencido» es lo que ya pasó de su fecha acordada.",
    ],
    ...paginar(conNominales(base, nominales, monedas), q),
  };
}

export type PayablesSortKey = "debt_desc" | "overdue_desc" | "due" | "name";

/**
 * (5b) «QUÉ DEBO» (H-11): la cartera de proveedores, sin elegir proveedor antes. Una fila por
 * proveedor al que se le debe: deuda a la tasa de hoy (`platform.ap_aging`, que la saca de
 * `platform.supplier_debt_today`), lo vencido, cuándo vence lo próximo y el nominal por moneda.
 * Sin tasa: `null`, nunca cero, y el nominal sigue ahí.
 */
export async function payablesReport(
  tx: TransactionSql,
  companyId: string,
  q: ReportPaging & { readonly sort?: PayablesSortKey | undefined },
): Promise<ReportTable | null> {
  const e = await empresaYHoy(tx, companyId);
  if (!e) return null;
  const orden =
    q.sort === "overdue_desc"
      ? tx`coalesce(n.vencido_nulo, false) desc, coalesce(n.vencido, 0) desc, s.legal_name`
      : q.sort === "due"
        ? tx`n.vence asc nulls last, s.legal_name`
        : q.sort === "name"
          ? tx`s.legal_name`
          : tx`(t.deuda is null) desc, t.deuda desc, s.legal_name`;
  const tramos = tx`
    select a.supplier_id, ${tx.unsafe(PIVOTE)}
      from platform.ap_aging(${companyId}, null, ${e.hoy}::date) a
     group by a.supplier_id`;
  // Factura a factura, la MISMA pregunta que platform.ap_aging (su CTE «saldos», última
  // definición en 20261004200000_a_payables_list_never_falls.sql): se debe si la deuda de hoy es
  // positiva, o si no se puede valorar (NULL) y el saldo nominal es positivo; y VENCE el día
  // acordado o, sin él, el de la factura (`coalesce(due_date, invoice_date)`). No existe una
  // función de día de vencimiento para proveedores (la de ventas es platform.document_due_day):
  // esta expresión es una COPIA de la de ap_aging. La vigila el E2E «lo vencido con proveedores»
  // (e2e-reportes-y-carteras), que compara este «vencido» contra ap_aging con una factura con
  // fecha acordada y otra sin ella. Si ap_aging cambia su regla, cambia aquí.
  const porFactura = tx`
    select x.* from (
      select i.supplier_id, i.transaction_currency as currency,
             coalesce(i.due_date, i.invoice_date) as vence,
             platform.supplier_invoice_balance(${companyId}, i.id) as nominal,
             platform.supplier_debt_today(${companyId}, i.id) as deuda
        from public.supplier_invoices i
       where i.company_id = ${companyId}
         and i.status in ('posted', 'paid')
         and i.invoice_date <= ${e.hoy}::date
    ) x
    where x.deuda > 0 or (x.deuda is null and x.nominal > 0)`;
  // UNA sentencia, como la cartera de clientes: ap_aging recorre las facturas una vez y la
  // lectura factura a factura, otra. Antes eran cuatro sentencias y seis pasadas.
  const [todo] = await tx<UnaPasada[]>`
    with t as materialized (${tramos}), f as materialized (${porFactura}),
         n as (select supplier_id, min(vence) as vence,
                      coalesce(bool_or(deuda is null) filter (where vence < ${e.hoy}::date), false)
                        as vencido_nulo,
                      coalesce(sum(deuda) filter (where vence < ${e.hoy}::date), 0) as vencido
                 from f group by supplier_id),
         filas as (
           select s.id::text as id, s.legal_name as label, t.documentos::text as documents,
                  round(t.deuda, 2)::text as debt,
                  (case when n.vencido_nulo then null
                        else round(coalesce(n.vencido, 0), 2) end)::text as overdue,
                  n.vence::text as next_due,
                  greatest(0, ${e.hoy}::date - n.vence)::text as days_overdue,
                  ${tx.unsafe(TRAMOS_DE_FILA)},
                  row_number() over (order by ${orden}) as pos
             from t
             join public.suppliers s on s.id = t.supplier_id
             left join n on n.supplier_id = t.supplier_id
         )
    select (select coalesce(jsonb_agg(to_jsonb(x) - 'pos' order by x.pos), '[]'::jsonb)
              from filas x) as filas,
           (select coalesce(jsonb_agg(to_jsonb(x) order by x.currency), '[]'::jsonb)
              from (select supplier_id::text as id, currency,
                           round(sum(nominal), 2)::text as nominal
                      from f group by supplier_id, currency) x) as nominales,
           (select coalesce(jsonb_agg(to_jsonb(x) order by x.currency), '[]'::jsonb)
              from (select currency, round(sum(nominal), 2)::text as nominal
                      from f group by currency) x) as por_moneda,
           (select to_jsonb(z)
              from (select ${tx.unsafe(TRAMOS_DEL_TOTAL)},
                           (select (case when coalesce(bool_or(deuda is null), false) then null
                                         else round(coalesce(sum(deuda), 0), 2) end)::text
                              from f where vence < ${e.hoy}::date) as overdue) z) as total`;
  const base = todo?.filas ?? [];
  const nominales = todo?.nominales ?? [];
  const porMoneda = todo?.por_moneda ?? [];
  const t = todo?.total;
  const monedas = porMoneda.map((m) => m.currency);
  const totals: Fila = { ...(t ?? {}) };
  for (const m of porMoneda) totals[`nominal_${m.currency}`] = m.nominal;
  return {
    report: "payables",
    title: "Qué debo",
    from: null,
    to: null,
    as_of: e.hoy,
    currency: e.moneda,
    group: null,
    columns: [
      { key: "label", label: "Proveedor", kind: "text" },
      { key: "documents", label: "Facturas", kind: "integer" },
      ...monedas.map((m): ReportColumn => ({
        key: `nominal_${m}`,
        label: `Debo en ${m}`,
        kind: "money",
        currency: m,
      })),
      { key: "debt", label: "Deuda a la tasa de hoy", kind: "money" },
      { key: "overdue", label: "Vencido", kind: "money" },
      { key: "next_due", label: "Vence", kind: "date" },
      { key: "days_overdue", label: "Días de vencido", kind: "integer" },
      ...TRAMOS.map((b): ReportColumn => ({ key: `b_${b}`, label: `${b} días`, kind: "money" })),
    ],
    totals,
    summary: [
      lineaDeDeuda("debt", "Debo, a la tasa de hoy", t?.["debt"]),
      lineaDeDeuda("overdue", "De eso, ya vencido", t?.["overdue"]),
      ...porMoneda.map((m): ReportSummaryLine => ({
        key: `nominal_${m.currency}`,
        label: `Debo en ${m.currency}`,
        kind: "money",
        value: m.nominal,
        currency: m.currency,
      })),
    ],
    notes: [
      "La deuda en divisa se enseña a la tasa de hoy; lo que se debe de verdad es el importe en su moneda.",
      "«Vence» es la fecha de vencimiento más próxima (o más atrasada) de lo que se le debe a ese proveedor; sin fecha acordada, la de la factura. Los tramos cuentan los días desde ese vencimiento.",
    ],
    ...paginar(conNominales(base, nominales, monedas), q),
  };
}

export type CashClosingsGroup = "closing" | "cashier";

/**
 * (6) CIERRES DE CAJA con sus diferencias. Cada cierre guarda lo esperado, lo contado y la
 * diferencia (en la moneda de la caja y en la de la empresa): aquí se lee, no se recalcula. Por
 * cajero = quien hizo el cierre.
 */
export async function cashClosingsReport(
  tx: TransactionSql,
  companyId: string,
  q: ReportRange & { readonly group?: CashClosingsGroup | undefined },
): Promise<ReportTable | null> {
  const e = await empresaYHoy(tx, companyId);
  if (!e) return null;
  const grupo = q.group ?? "closing";
  const cierres = tx`
    select k.closing_date, a.name as caja, k.transaction_currency as moneda,
           coalesce((select nullif(btrim(up.full_name), '') from public.users_profile up
                      where up.user_id = k.created_by), 'Sin nombre') as cajero,
           k.expected_amount, k.counted_amount,
           k.amount_transaction_currency as diferencia, k.functional_amount as diferencia_funcional,
           k.reason, k.closed_at, k.created_by
      from public.cash_closings k
      join public.company_accounts a on a.id = k.account_id
     where k.company_id = ${companyId}
       and k.closing_date between ${q.from}::date and ${q.to}::date`;
  const agregados = tx`
    count(*)::text as closings,
    (count(*) filter (where diferencia <> 0))::text as with_difference,
    round(coalesce(sum(diferencia_funcional) filter (where diferencia < 0), 0), 2)::text
      as shortage,
    round(coalesce(sum(diferencia_funcional) filter (where diferencia > 0), 0), 2)::text
      as surplus,
    round(coalesce(sum(diferencia_funcional), 0), 2)::text as difference_functional`;
  const filas =
    grupo === "cashier"
      ? await tx<Fila[]>`
          with c as (${cierres})
          select cajero as label, ${agregados}
            from c group by created_by, cajero order by sum(diferencia_funcional), cajero`
      : await tx<Fila[]>`
          with c as (${cierres})
          select closing_date::text as closing_date, caja as label, cajero as cashier, moneda,
                 round(expected_amount, 2)::text as expected,
                 round(counted_amount, 2)::text as counted,
                 round(diferencia, 2)::text as difference,
                 round(diferencia_funcional, 2)::text as difference_functional,
                 reason
            from c order by closing_date, closed_at`;
  const [t] = await tx<Fila[]>`with c as (${cierres}) select ${agregados} from c`;
  const columns: ReportColumn[] =
    grupo === "cashier"
      ? [
          { key: "label", label: "Cajero", kind: "text" },
          { key: "closings", label: "Cierres", kind: "integer" },
          { key: "with_difference", label: "Con diferencia", kind: "integer" },
          { key: "shortage", label: "Faltantes", kind: "money" },
          { key: "surplus", label: "Sobrantes", kind: "money" },
          { key: "difference_functional", label: "Diferencia neta", kind: "money" },
        ]
      : [
          { key: "closing_date", label: "Día", kind: "date" },
          { key: "label", label: "Caja", kind: "text" },
          { key: "cashier", label: "Cajero", kind: "text" },
          { key: "moneda", label: "Moneda", kind: "text" },
          { key: "expected", label: "Esperado", kind: "quantity" },
          { key: "counted", label: "Contado", kind: "quantity" },
          { key: "difference", label: "Diferencia", kind: "quantity" },
          { key: "difference_functional", label: `Diferencia en ${e.moneda}`, kind: "money" },
          { key: "reason", label: "Motivo", kind: "text" },
        ];
  return {
    report: "cash-closings",
    title: "Cierres de caja",
    from: q.from,
    to: q.to,
    as_of: e.hoy,
    currency: e.moneda,
    group: grupo,
    columns,
    totals:
      grupo === "cashier"
        ? { ...(t ?? {}) }
        : { difference_functional: t?.["difference_functional"] ?? "0.00" },
    summary: [
      { key: "closings", label: "Cierres", kind: "integer", value: t?.["closings"] ?? "0" },
      {
        key: "with_difference",
        label: "Con diferencia",
        kind: "integer",
        value: t?.["with_difference"] ?? "0",
      },
      { key: "shortage", label: "Faltantes", kind: "money", value: t?.["shortage"] ?? "0.00" },
      { key: "surplus", label: "Sobrantes", kind: "money", value: t?.["surplus"] ?? "0.00" },
    ],
    notes: [
      "Esperado, contado y diferencia van en la moneda de cada caja. La diferencia en la moneda de la empresa es la que quedó asentada al cerrar.",
      "El cajero es quien hizo el cierre.",
    ],
    ...paginar(filas, q),
  };
}

/**
 * (7) IGTF PERCIBIDO POR QUINCENA. Cada quincena que toca el rango, ENTERA (del 1 al 15 y del 16
 * al fin de mes: es la unidad en que se declara), con el total de `platform.igtf_period_totals`,
 * la única regla de qué percepción cuenta y cuál queda por reintegrar.
 */
export async function igtfReport(
  tx: TransactionSql,
  companyId: string,
  q: ReportRange,
): Promise<ReportTable | null> {
  const e = await empresaYHoy(tx, companyId);
  if (!e) return null;
  // Las quincenas se arman con fechas sin zona: ningún instante entra en la cuenta.
  const quincenas = tx`
    select qq.q_from, qq.q_to
      from generate_series(
             make_date(extract(year from ${q.from}::date)::int,
                       extract(month from ${q.from}::date)::int, 1)::timestamp,
             ${q.to}::date::timestamp, interval '1 month') as m(mes)
     cross join lateral (
       values (m.mes::date, m.mes::date + 14),
              (m.mes::date + 15, (m.mes + interval '1 month' - interval '1 day')::date)
     ) as qq(q_from, q_to)
     where qq.q_to >= ${q.from}::date and qq.q_from <= ${q.to}::date`;
  const filas = await tx<Fila[]>`
    with qs as (${quincenas})
    select qs.q_from::text as period_from, qs.q_to::text as period_to,
           round(t.total_functional, 2)::text as perceived,
           round(t.pending_refund_functional, 2)::text as pending_refund,
           t.pending_refund_count::text as pending_refund_count
      from qs
     cross join lateral platform.igtf_period_totals(${companyId}, qs.q_from, qs.q_to) t
     order by qs.q_from`;
  const [t] = await tx<Fila[]>`
    with qs as (${quincenas})
    select round(coalesce(sum(t.total_functional), 0), 2)::text as perceived,
           round(coalesce(sum(t.pending_refund_functional), 0), 2)::text as pending_refund,
           coalesce(sum(t.pending_refund_count), 0)::text as pending_refund_count
      from qs
     cross join lateral platform.igtf_period_totals(${companyId}, qs.q_from, qs.q_to) t`;
  return {
    report: "igtf",
    title: "IGTF percibido por quincena",
    from: q.from,
    to: q.to,
    as_of: e.hoy,
    currency: e.moneda,
    group: null,
    columns: [
      { key: "period_from", label: "Desde", kind: "date" },
      { key: "period_to", label: "Hasta", kind: "date" },
      { key: "perceived", label: "IGTF percibido", kind: "money" },
      { key: "pending_refund", label: "De eso, por reintegrar", kind: "money" },
      { key: "pending_refund_count", label: "Percepciones por reintegrar", kind: "integer" },
    ],
    totals: { ...(t ?? {}) },
    summary: [
      {
        key: "perceived",
        label: "IGTF percibido en las quincenas del rango",
        kind: "money",
        value: t?.["perceived"] ?? "0.00",
      },
    ],
    notes: [
      "Cada renglón es una quincena completa (del 1 al 15 y del 16 al fin de mes), aunque el rango pedido la corte.",
      "«Por reintegrar» es lo percibido de un cobro que se reversó después de cerrada su quincena: ya se declaró y queda por reintegrar; cómo se recupera lo confirma tu contador.",
    ],
    ...paginar(filas, q),
  };
}

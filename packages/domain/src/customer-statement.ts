import type { TransactionSql } from "@ladino/db";

/**
 * EL ESTADO DE CUENTA DE UN CLIENTE, como lectura con nombre del dominio (ADR-0075, ola 4 ·
 * cobros, cuarta ronda; R-84).
 *
 * Estas dos lecturas vivían como SQL dentro de `apps/api/src/routes/sales.ts`, y con ellas
 * vivían allí dos REGLAS de dinero: cómo se valora lo que resta una nota de crédito y cómo se
 * valora un saldo a favor en divisa. `apps/api` no contiene reglas de negocio (CLAUDE.md §7):
 * el handler autentica, autoriza, valida, llama aquí y mapea.
 *
 * Se mudaron SIN cambiar una cifra: el SQL es el mismo, sentencia por sentencia. Las reglas
 * que quedan escritas aquí —y en ningún otro sitio de TypeScript—:
 *
 *  1. Una nota de crédito y un recibo de devolución NO pasan por la función de deuda
 *     (`platform.document_debt*`): no son deuda, RESTAN. Su «saldo» es lo que queda de su saldo
 *     a favor, en negativo (G-04).
 *  2. Ese saldo de la NC, en divisa, se enseña a la tasa de HOY, y sin ella va en null: por
 *     documento nunca se inventa una cifra.
 *  3. El TOTAL de saldo a favor disponible se valora «a la tasa de hoy; sin ella, a la tasa con
 *     que nació cada saldo» (G-05): nunca una suma parcial.
 *  4. Lo vencido (P-05) es null con `sin_tasa` en cuanto UNA moneda no se puede valorar hoy.
 *
 * Todo «hoy» es el día de Caracas (`platform.caracas_day(now())`), un `date` contra otro `date`
 * (CLAUDE.md §3: una fecha contra un punto de reloj).
 */

export interface CustomerOverdue {
  readonly overdue: string | null;
  readonly overdue_reason: "sin_tasa" | null;
}

/**
 * P-05: lo VENCIDO de un cliente a una fecha (un `date`: el día de Caracas), de
 * platform.customer_overdue_today —la única función de deuda, filtrada por vencimiento—.
 * Sin filas, «0.00». Si alguna moneda no se puede valorar hoy: null con `sin_tasa`.
 */
export async function customerOverdue(
  tx: TransactionSql,
  companyId: string,
  customerId: string,
  dia: string,
): Promise<CustomerOverdue> {
  const [v] = await tx<{ overdue: string | null; overdue_reason: "sin_tasa" | null }[]>`
    select case when bool_or(o.nominal is null or o.functional_today is null) then null
                else round(coalesce(sum(o.functional_today), 0), 2)::text end as overdue,
           case when bool_or(o.nominal is null or o.functional_today is null)
                then 'sin_tasa' end as overdue_reason
      from platform.customer_overdue_today(${companyId}, ${customerId}, ${dia}::date) o`;
  return { overdue: v?.overdue ?? null, overdue_reason: v?.overdue_reason ?? null };
}

export interface CustomerStatement {
  readonly customer_id: string;
  readonly currency: string;
  readonly documents: Record<string, unknown>[];
  readonly credits: Record<string, unknown>[];
  readonly total_outstanding: string | null;
  readonly debt: {
    readonly functional_currency: string;
    readonly as_of: string;
    readonly by_currency: Record<string, unknown>[];
    readonly unvalued_documents: number;
  };
  readonly total_credit_available: string;
  readonly aging: {
    readonly reference_date: string;
    readonly buckets: Record<string, unknown>[];
    readonly total: string | null;
  } & CustomerOverdue;
}

/**
 * El estado de cuenta de un cliente. `null` si la empresa no existe (o no es visible).
 * NO autoriza: el permiso de lectura de cuentas por cobrar lo exige quien llama.
 */
export async function customerStatement(
  tx: TransactionSql,
  companyId: string,
  id: string,
): Promise<CustomerStatement | null> {
  const [empresa] = await tx<{ moneda: string }[]>`
    select functional_currency_code as moneda from public.companies where id = ${companyId}`;
  if (!empresa) return null;
  // El estado de cuenta ENSEÑA dinero: pagado y saldo viajan a 2 decimales
  // (2026-09-08) — la persona paga lo que ve, y la regla del último
  // centavo (registerPayment) cierra el documento sin residuo fantasma.
  const documentos = await tx<Record<string, unknown>[]>`
    select d.id, d.kind, d.series, d.document_number::int as document_number,
           to_char(d.issued_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as issued_at,
           d.status, d.total_amount::text as total_amount,
           -- Lo pagado = total − el saldo ÚNICO (platform.document_balance, 20261002100000):
           -- la ND por IGTF la paga su percepción, no un cobro. La copia en línea «Σ cobros» la
           -- enseñaba como no pagada. Una anulada no tiene saldo: se enseñan sus cobros.
           round(coalesce(d.total_amount - platform.document_balance(${companyId}, d.id),
                          (select sum(p.functional_amount) from public.payments p
                            where p.document_id = d.id
                              and not exists (select 1 from public.payment_reversals pr where pr.payment_id = p.id)), 0), 2)::text as paid_amount,
           -- G-04: una nota de crédito (o un recibo de devolución) NO es deuda: RESTA. Su
           -- «saldo» es lo que queda de su saldo a favor, en negativo; en divisa, a la tasa de
           -- hoy solo para mostrar (null si falta). Lo demás, por la única función de deuda.
           (case when d.kind in ('credit_note', 'receipt_return') then
                   (select round(-sum(case when cc.status = 'available'
                                           then (cc.amount - cc.applied_amount)
                                                * case when cc.currency = d.functional_currency
                                                       then 1
                                                       else platform.rate_at(
                                                              ${companyId}, cc.currency,
                                                              d.functional_currency,
                                                              platform.caracas_day(now())) end
                                           else 0 end), 2)::text
                      from public.customer_credits cc
                     where cc.company_id = ${companyId} and cc.source_document_id = d.id
                       and cc.source_payment_id is null)
                 else round(platform.document_debt_today(${companyId}, d.id), 2)::text end)
             as balance,
           -- La deuda NOMINAL, en la moneda del documento (ADR-0075 §5).
           d.transaction_currency as debt_currency,
           -- Una anulada no debe: «0». Una emitida cuyo nominal no se puede calcular (un
           -- cobro viejo en otra moneda sin tasa): NULL, nunca «0» — diría que no debe.
           (case when d.status = 'annulled' then '0'
                 when d.kind in ('credit_note', 'receipt_return') then
                   coalesce((select (-sum(case when cc.status = 'available'
                                               then cc.amount - cc.applied_amount
                                               else 0 end))::text
                               from public.customer_credits cc
                              where cc.company_id = ${companyId}
                                and cc.source_document_id = d.id
                                and cc.source_payment_id is null), '0')
                 else (select dd.nominal::text
                         from platform.document_debt(${companyId}, d.id) dd) end)
             as debt_nominal,
           -- El día de CARACAS, no el UTC (CLAUDE.md §3: una fecha contra un reloj).
           greatest(0, platform.caracas_day(now()) - platform.caracas_day(d.issued_at))::int
             as days_outstanding,
           -- P-05: el día en que vence (el acordado o, sin él, el de emisión) y si YA venció:
           -- dos date, y solo si el documento debe (la deuda, de la única función).
           to_char(platform.document_due_day(d.due_date, d.issued_at), 'YYYY-MM-DD')
             as due_date,
           (d.kind in ('invoice', 'receipt', 'debit_note') and d.status = 'issued'
            and platform.document_due_day(d.due_date, d.issued_at) < platform.caracas_day(now())
            and coalesce((select dd.nominal is null or dd.nominal > 0
                            from platform.document_debt(${companyId}, d.id) dd), false))
             as overdue
      from public.documents d
     where d.company_id = ${companyId} and d.customer_id = ${id}
       and d.status in ('issued', 'paid', 'annulled')
     order by d.issued_at, d.id`;
  const credits = await tx<Record<string, unknown>[]>`
    select id, source_document_id, amount::text as amount,
           applied_amount::text as applied_amount, status, currency,
           fx_rate::text as fx_rate, source_payment_id is not null as from_overpayment
      from public.customer_credits
     where company_id = ${companyId} and customer_id = ${id} order by created_at, id`;
  const [totales] = await tx<{ pendiente: string | null; credito: string }[]>`
    select round(platform.customer_debt_today(${companyId}, ${id}), 2)::text as pendiente,
           -- G-05: los saldos a favor en divisa, a la tasa de HOY para mostrar (sin tasa de
           -- hoy, a la tasa con que nacieron: nunca una suma parcial).
           round(coalesce((select sum((cc.amount - cc.applied_amount)
                                      * case when cc.currency = ${empresa.moneda} then 1
                                             else coalesce(
                                                    platform.rate_at(
                                                      ${companyId}, cc.currency,
                                                      ${empresa.moneda},
                                                      platform.caracas_day(now())),
                                                    cc.fx_rate) end)
                       from public.customer_credits cc
                      where cc.company_id = ${companyId} and cc.customer_id = ${id}
                        and cc.status = 'available'), 0), 2)::text as credito`;
  // LA DEUDA POR MONEDA (F-04): nominal y, para mostrar, a la tasa de hoy. Misma función y
  // mismos documentos que `total_outstanding`: la suma de functional_today ES ese total.
  const porMoneda = await tx<Record<string, unknown>[]>`
    select dd.currency, sum(dd.nominal)::text as nominal, max(dd.rate)::text as rate,
           round(sum(dd.functional_today), 2)::text as functional_today
      from public.documents d
      cross join lateral platform.document_debt(${companyId}, d.id) dd
     where d.company_id = ${companyId} and d.customer_id = ${id}
       and d.kind in ('invoice', 'receipt', 'debit_note')
       and d.status in ('issued', 'paid')
       and dd.nominal <> 0
     group by dd.currency
     order by dd.currency`;
  const buckets = await tx<Record<string, unknown>[]>`
    select customer_id, bucket, document_count::int as document_count,
           round(amount, 2)::text as amount
      from platform.ar_aging(${companyId}, ${id}, platform.caracas_day(now()))`;
  const [ref] = await tx<{ d: string }[]>`select platform.caracas_day(now())::text as d`;
  const [totalAging] = await tx<{ t: string | null }[]>`
    select round(case when bool_or(amount is null) then null
                      else coalesce(sum(amount), 0) end, 2)::text as t
      from platform.ar_aging(${companyId}, ${id}, platform.caracas_day(now()))`;
  const vencido = await customerOverdue(tx, companyId, id, ref!.d);
  return {
    customer_id: id,
    currency: empresa.moneda,
    documents: documentos,
    credits,
    // H12: null = hay deuda en divisa y falta la tasa de hoy. El nominal va en `debt`.
    total_outstanding: totales === undefined ? "0" : totales.pendiente,
    debt: {
      functional_currency: empresa.moneda,
      as_of: ref!.d,
      by_currency: porMoneda,
      // Los que `by_currency` no puede sumar: se dicen, no se callan.
      unvalued_documents: documentos.filter(
        (d) => d["status"] !== "annulled" && d["debt_nominal"] === null,
      ).length,
    },
    total_credit_available: totales?.credito ?? "0",
    aging: {
      reference_date: ref!.d,
      buckets,
      total: totalAging === undefined ? "0" : totalAging.t,
      ...vencido,
    },
  };
}

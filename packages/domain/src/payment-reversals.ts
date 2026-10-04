import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, JSONValue } from "@ladino/db";
import { parseDecimal } from "@ladino/money";
import { RULES_VERSION } from "./create-company.js";
import { companyScope } from "./company-scope.js";
import { reverseJournalEntryForPaymentReversal } from "./accounting.js";

export type PaymentReversalError =
  | { code: "PERMISSION_REQUIRED"; message: string }
  | { code: "NOT_FOUND"; message: string }
  | { code: "COMPANY_SUSPENDED"; message: string }
  | { code: "VALIDATION_FAILED"; message: string }
  | { code: "PAYMENT_ALREADY_REVERSED"; message: string }
  | { code: "IGTF_NOTE_ISSUED"; message: string }
  | { code: "PERIOD_CLOSED"; message: string }
  | { code: "RETENTION_PERIOD_DECLARED"; message: string };

export interface ReversePaymentInput {
  readonly company_id: string;
  readonly reason: string;
}

export interface PaymentReversalResult {
  readonly id: string;
  readonly payment_id: string;
  readonly document_id: string;
  readonly kind: string;
  readonly reason: string;
  readonly reversed_at: string;
  readonly currency: string;
  readonly amount: string;
  readonly functional_amount: string;
  readonly reversal_entry_id: string | null;
  readonly igtf_reversal_entry_id: string | null;
  readonly document: { readonly id: string; readonly status: string };
  /** La deuda del documento después de la reversa, por la única función (ADR-0075 §5). */
  readonly debt: {
    readonly currency: string;
    readonly nominal: string | null;
    readonly functional_currency: string;
    readonly rate: string | null;
    readonly rate_date: string;
    readonly functional_today: string | null;
  } | null;
  /** El IGTF que ese cobro percibió: queda pendiente de reintegro ante el SENIAT (P-67). */
  readonly igtf: {
    readonly perception_id: string;
    readonly status: "pendiente_reintegro";
    readonly currency: string;
    readonly restituted_amount: string;
    readonly absorbed: boolean;
  } | null;
  readonly supported_retention: { readonly id: string; readonly status: "annulled" } | null;
}

/**
 * LA REVERSA DE UN COBRO (ADR-0075 §8; R-61, P-67).
 *
 * Un cobro es un hecho de caja y `payments` es append-only con `amount > 0`: no se edita, no se
 * borra y no admite una fila negativa. Reversarlo es escribir OTRO hecho —una fila en
 * `payment_reversals`, con motivo— que hace cuatro cosas a la vez, en una transacción:
 *
 *   1. el cobro deja de contar en el saldo del documento (la única función de deuda lo excluye);
 *   2. sale de la caja lo que entró: el cobro y, si lo hubo, el IGTF que se restituye;
 *   3. su asiento se REVIERTE con un contra-asiento (regla 2), y el de su percepción también;
 *   4. un documento `paid` cuyo saldo deja de ser cero vuelve a `issued`.
 *
 * EL IGTF (PA SNAT/2022/000013 art. 4): la percepción de un cobro reversado fue indebida. Se
 * marca `pendiente_reintegro`, se restituye al cliente (sale de la caja con el cobro) y el
 * reintegro queda pendiente ante el SENIAT, con acta. Con qué soporte se documenta ante el fisco
 * es VALIDAR-TRIBUTARIO (P-67). Si la percepción se documentó con una NOTA DE DÉBITO, la reversa
 * PARA: un documento fiscal emitido no se deshace desde un cobro (regla 1).
 *
 * LA RETENCIÓN SOPORTADA (`modo = "supported_retention"`): el abono de un comprobante se reversa
 * por esta misma vía y el comprobante queda `annulled` con el motivo. Corregirlo es anularlo y
 * volver a cargarlo. Lo autoriza `ar.retention.correct` (contador); un cobro, `ar.payment.reverse`.
 *
 * No hay cuatro ojos: permiso propio + motivo + acta (no existe un flujo de aprobación pendiente).
 */
export async function reversePayment(
  uow: UnitOfWork,
  paymentId: string,
  input: ReversePaymentInput,
  modo: "payment" | "supported_retention" = "payment",
): Promise<Result<PaymentReversalResult, PaymentReversalError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Reversar un cobro exige un usuario real.",
    });
  }
  const permiso = modo === "supported_retention" ? "ar.retention.correct" : "ar.payment.reverse";
  const scope = await companyScope(sql, actor.userId, input.company_id, permiso);
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const tenantId = scope.value.tenantId;
  const motivo = input.reason.trim();
  if (motivo.length < 10 || motivo.length > 300) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Escribe el motivo de la reversa (entre 10 y 300 caracteres): queda en el acta.",
    });
  }

  const [pago] = await sql<
    {
      id: string;
      document_id: string;
      instrument: string;
      amount: string;
      currency: string;
      journal_entry_id: string | null;
      customer_credit_id: string | null;
      supported_retention_id: string | null;
    }[]
  >`select id, document_id, instrument, amount::text as amount, currency, journal_entry_id,
           customer_credit_id, supported_retention_id
      from public.payments
     where id = ${paymentId} and company_id = ${input.company_id}`;
  if (!pago) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });

  if (modo === "payment" && pago.supported_retention_id !== null) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Este abono es un comprobante de retención de IVA: no se reversa como un cobro. Lo corrige el contador desde el comprobante (Retenciones que nos practican).",
    });
  }
  if (modo === "supported_retention" && pago.supported_retention_id === null) {
    return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  }

  // EL DOCUMENTO BLOQUEADO: un cobro o una anulación concurrentes esperan (ADR-0061 §1).
  const [doc] = await sql<
    { id: string; status: string; transaction_currency: string; functional_currency: string }[]
  >`select id, status, transaction_currency, functional_currency
      from public.documents
     where id = ${pago.document_id} and company_id = ${input.company_id}
       for update`;
  if (!doc) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (doc.status !== "issued" && doc.status !== "paid") {
    return err({
      code: "VALIDATION_FAILED",
      message: `El documento de este cobro está en ${doc.status}: su cobro ya no se reversa.`,
    });
  }

  const [ya] = await sql<{ id: string }[]>`
    select id from public.payment_reversals
     where company_id = ${input.company_id} and payment_id = ${paymentId}`;
  if (ya) {
    return err({
      code: "PAYMENT_ALREADY_REVERSED",
      message: "Este cobro ya fue reversado. Un cobro se reversa una sola vez.",
    });
  }

  const [percepcion] = await sql<
    {
      id: string;
      currency: string;
      amount: string;
      absorbed: boolean;
      status: string;
      debit_note_id: string | null;
      nd: string | null;
    }[]
  >`select ip.id, ip.currency, ip.amount::text as amount, ip.absorbed, ip.status,
           ip.debit_note_id,
           (select coalesce(d.series || '-', '') || d.document_number::text
              from public.documents d where d.id = ip.debit_note_id) as nd
      from public.igtf_perceptions ip
     where ip.company_id = ${input.company_id} and ip.payment_id = ${paymentId}
       for update`;
  if (percepcion && percepcion.debit_note_id !== null) {
    return err({
      code: "IGTF_NOTE_ISSUED",
      message: `Este cobro documentó su IGTF con la nota de débito ${percepcion.nd ?? ""}. Una nota de débito emitida es un documento fiscal y no se deshace reversando el cobro: consulta con tu contador cómo corregirla antes de reversar.`,
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  // 1. Los asientos. Posteado → contra-asiento; todavía en la cola → se descarta con el cobro.
  const reversarAsientoDe = async (
    sourceKind: "payment_received" | "igtf_perception",
    sourceId: string,
    enlace: string | null,
    etiqueta: string,
  ): Promise<Result<string | null, PaymentReversalError>> => {
    const [asiento] =
      enlace !== null
        ? [{ id: enlace }]
        : await sql<{ id: string }[]>`
            select id from public.journal_entries
             where company_id = ${input.company_id} and source_kind = ${sourceKind}
               and source_id = ${sourceId} and status = 'posted'`;
    if (asiento === undefined) {
      await sql`
        update public.journal_generation_queue
           set status = 'discarded', processed_at = now()
         where company_id = ${input.company_id} and source_id = ${sourceId}
           and source_kind = ${sourceKind} and status = 'pending'`;
      return ok(null);
    }
    const r = await reverseJournalEntryForPaymentReversal(
      uow,
      asiento.id,
      { company_id: input.company_id, reason: `${etiqueta}: ${motivo}` },
      permiso,
    );
    if (!r.ok) {
      return err(
        r.error.code === "PERMISSION_REQUIRED"
          ? { code: "PERMISSION_REQUIRED", message: r.error.message }
          : r.error.code === "NOT_FOUND"
            ? { code: "NOT_FOUND", message: r.error.message }
            : r.error.code === "PERIOD_CLOSED"
              ? // H13: el contra-asiento va con fecha de HOY, en el período en curso (ADR-0069:
                // un período cerrado no recibe asientos). Si el período de hoy está cerrado, la
                // reversa se rechaza con SU código (409) y no aplanada a un 422 genérico.
                {
                  code: "PERIOD_CLOSED",
                  message:
                    "El período contable de hoy está cerrado: el contra-asiento de esta reversa no tiene dónde asentarse. Reabre el período o espera al siguiente, y vuelve a reversar.",
                }
              : { code: "VALIDATION_FAILED", message: r.error.message },
      );
    }
    return ok(r.value.id);
  };

  const asientoCobro = await reversarAsientoDe(
    "payment_received",
    paymentId,
    pago.journal_entry_id,
    modo === "supported_retention" ? "Reversa de la retención soportada" : "Reversa del cobro",
  );
  if (!asientoCobro.ok) return asientoCobro;
  let asientoIgtf: string | null = null;
  if (percepcion) {
    const r = await reversarAsientoDe(
      "igtf_perception",
      percepcion.id,
      null,
      "Restitución del IGTF percibido",
    );
    if (!r.ok) return r;
    asientoIgtf = r.value;
  }

  // 2. El saldo a favor que ese cobro consumió vuelve a estar disponible.
  if (pago.customer_credit_id !== null) {
    await sql`
      update public.customer_credits
         set applied_amount = applied_amount - ${pago.amount}::numeric,
             status = case when status = 'applied' then 'available' else status end
       where id = ${pago.customer_credit_id} and company_id = ${input.company_id}`;
  }

  // 3. LA REVERSA. El trigger copia del cobro la cuenta, la moneda, los importes y el IGTF que
  // se restituye; y baja el saldo de la caja. El único (company_id, payment_id) es la clave
  // natural: una reejecución muere aquí.
  const [reversa] = await sql<
    {
      id: string;
      payment_id: string;
      document_id: string;
      kind: string;
      reason: string;
      reversed_at: string;
      currency: string;
      amount: string;
      functional_amount: string;
      igtf_restituted_amount: string;
      reversal_entry_id: string | null;
      igtf_reversal_entry_id: string | null;
    }[]
  >`insert into public.payment_reversals
      (tenant_id, company_id, payment_id, document_id, reason, currency, amount,
       functional_amount, reversal_entry_id, igtf_reversal_entry_id)
    values (${tenantId}, ${input.company_id}, ${paymentId}, ${pago.document_id}, ${motivo},
            ${pago.currency}, ${pago.amount}::numeric, ${pago.amount}::numeric,
            ${asientoCobro.value}, ${asientoIgtf})
    returning id, payment_id, document_id, kind, reason,
              to_char(reversed_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as reversed_at,
              currency, amount::text as amount, functional_amount::text as functional_amount,
              igtf_restituted_amount::text as igtf_restituted_amount,
              reversal_entry_id, igtf_reversal_entry_id`;

  // 4. El IGTF: indebido, restituido al cliente y pendiente de reintegro (PA 000013 art. 4).
  if (percepcion) {
    await sql`
      update public.igtf_perceptions
         set status = 'pendiente_reintegro',
             status_reason = ${`Reversa del cobro: ${motivo}`}
       where id = ${percepcion.id} and company_id = ${input.company_id}`;
  }

  // 5. El comprobante de retención queda anulado, con su motivo.
  if (pago.supported_retention_id !== null) {
    await sql`
      update public.supported_retention_receipts
         set status = 'annulled', annul_reason = ${motivo}
       where id = ${pago.supported_retention_id} and company_id = ${input.company_id}`;
  }

  // 6. El documento vuelve a deber. `paid → issued` solo lo admite el esquema si hay reversa.
  let estado = doc.status;
  if (doc.status === "paid") {
    const [s] = await sql<{ saldo: string | null }[]>`
      select (case when ${doc.transaction_currency === doc.functional_currency}
                   then platform.document_balance(${input.company_id}, ${doc.id})
                   else platform.document_balance_transaction(${input.company_id}, ${doc.id})
              end)::text as saldo`;
    const saldo = s?.saldo == null ? null : parseDecimal(s.saldo);
    if (saldo !== null && saldo.ok && saldo.value.greaterThan(0)) {
      await sql`
        update public.documents set status = 'issued'
         where id = ${doc.id} and company_id = ${input.company_id}`;
      estado = "issued";
    }
  }

  // 7. El acta.
  const acta: Record<string, JSONValue> = {
    reversal_id: reversa!.id,
    payment_id: paymentId,
    document_id: doc.id,
    kind: reversa!.kind,
    reason: motivo,
    currency: reversa!.currency,
    amount: reversa!.amount,
    instrument: pago.instrument,
    document_status_before: doc.status,
    document_status_after: estado,
    reversal_entry_id: reversa!.reversal_entry_id,
    igtf_perception_id: percepcion?.id ?? null,
    igtf_restituted_amount: reversa!.igtf_restituted_amount,
    igtf_reversal_entry_id: reversa!.igtf_reversal_entry_id,
    supported_retention_id: pago.supported_retention_id,
    customer_credit_id: pago.customer_credit_id,
  };
  const eventos = [
    modo === "supported_retention" ? "ar.retention_reversed" : "ar.payment_reversed",
    ...(percepcion ? ["igtf.perception_pending_refund"] : []),
  ];
  for (const evento of eventos) {
    await sql`
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      values (${tenantId}, ${input.company_id}, 'payment', ${paymentId}, ${evento},
              'user', now(), ${RULES_VERSION}, ${sql.json(acta)})`;
    await sql`
      insert into public.outbox
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
      values (${tenantId}, ${input.company_id}, 'payment', ${paymentId}, ${evento}, 1,
              ${sql.json({ id: paymentId, ...acta })})`;
  }

  // La deuda que queda, por LA función. No lanza por una tasa (20261003210000 y 210200): sin
  // tasa de hoy `functional_today` va en null, y si ni el nominal se puede calcular, `nominal`
  // también. La pantalla lo dice.
  const [deudaFila] = await sql<NonNullable<PaymentReversalResult["debt"]>[]>`
    select currency, nominal::text as nominal, functional_currency, rate::text as rate,
           rate_date::text as rate_date, functional_today::text as functional_today
      from platform.document_debt(${input.company_id}, ${doc.id})`;
  const deuda: PaymentReversalResult["debt"] = deudaFila ?? null;

  return ok({
    id: reversa!.id,
    payment_id: reversa!.payment_id,
    document_id: reversa!.document_id,
    kind: reversa!.kind,
    reason: reversa!.reason,
    reversed_at: reversa!.reversed_at,
    currency: reversa!.currency,
    amount: reversa!.amount,
    functional_amount: reversa!.functional_amount,
    reversal_entry_id: reversa!.reversal_entry_id,
    igtf_reversal_entry_id: reversa!.igtf_reversal_entry_id,
    document: { id: doc.id, status: estado },
    debt: deuda,
    igtf: percepcion
      ? {
          perception_id: percepcion.id,
          status: "pendiente_reintegro",
          currency: percepcion.currency,
          restituted_amount: reversa!.igtf_restituted_amount,
          absorbed: percepcion.absorbed,
        }
      : null,
    supported_retention:
      pago.supported_retention_id !== null
        ? { id: pago.supported_retention_id, status: "annulled" }
        : null,
  });
}

/**
 * Reversa o anula el comprobante de RETENCIÓN SOPORTADA (`ar.retention.correct`, ADR-0072 §5):
 * busca su abono y lo reversa por la vía de `reversePayment`. Corregir un comprobante es
 * anularlo y cargarlo de nuevo: su número queda libre al anularse.
 */
export async function reverseSupportedRetention(
  uow: UnitOfWork,
  receiptId: string,
  input: ReversePaymentInput,
): Promise<Result<PaymentReversalResult, PaymentReversalError>> {
  const { sql } = uow;
  // El permiso se comprueba ANTES de decir si el comprobante existe.
  if (uow.actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Corregir una retención exige un usuario real.",
    });
  }
  const scope = await companyScope(sql, uow.actor.userId, input.company_id, "ar.retention.correct");
  if (!scope.ok) return scope;
  const [comprobante] = await sql<{ status: string; pago: string | null }[]>`
    select r.status,
           (select p.id from public.payments p
             where p.company_id = r.company_id and p.supported_retention_id = r.id
             order by p.created_at desc limit 1) as pago
      from public.supported_retention_receipts r
     where r.id = ${receiptId} and r.company_id = ${input.company_id}
       for update`;
  if (!comprobante) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (comprobante.status === "annulled") {
    return err({
      code: "PAYMENT_ALREADY_REVERSED",
      message: "Este comprobante de retención ya está anulado.",
    });
  }
  // H9 (ADR-0075 §8, decidido por criterio — lo más estrecho y reversible): si el comprobante YA
  // ENTRÓ en una declaración de IVA presentada, anularlo cambiaría el libro y la declaración de
  // un período declarado sin dejar rastro. Qué tratamiento fiscal lleva (ajuste en el período en
  // que se detecta, o sustitutiva) es VALIDAR-TRIBUTARIO (P-89): aquí no se inventa, se RECHAZA.
  // «Su período» es el mismo que usa `recompute_iva_period` (20261002120200, H4): el de la fecha
  // del comprobante, o el de su entrega si aquel ya estaba declarado al entregarse. «Declarado»
  // es B-1: una generación hecha DESPUÉS de cerrar el período. Día contra día (caracas_day).
  const [declarado] = await sql<{ desde: string; hasta: string }[]>`
    with dia as (
      select case when exists (
                    select 1 from public.iva_period_results p
                     where p.company_id = r.company_id
                       and r.retained_on between p.period_from and p.period_to
                       and p.period_to < platform.caracas_day(p.created_at)
                       and platform.caracas_day(p.created_at)
                             <= coalesce(r.received_on, r.retained_on))
                  then coalesce(r.received_on, r.retained_on)
                  else r.retained_on end as d
        from public.supported_retention_receipts r
       where r.id = ${receiptId} and r.company_id = ${input.company_id}
    )
    select to_char(p.period_from, 'DD/MM/YYYY') as desde, to_char(p.period_to, 'DD/MM/YYYY') as hasta
      from public.iva_period_results p, dia
     where p.company_id = ${input.company_id}
       and dia.d between p.period_from and p.period_to
       and p.period_to < platform.caracas_day(p.created_at)
     order by p.created_at desc
     limit 1`;
  if (declarado) {
    return err({
      code: "RETENTION_PERIOD_DECLARED",
      message:
        "Este comprobante ya entró en una declaración presentada. Corregirlo exige una declaración sustitutiva o un ajuste: habla con tu contador.",
    });
  }
  if (comprobante.pago === null) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Este comprobante no tiene un abono registrado: no hay nada que reversar.",
    });
  }
  return reversePayment(uow, comprobante.pago, input, "supported_retention");
}

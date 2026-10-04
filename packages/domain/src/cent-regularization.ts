import type { TransactionSql, JSONValue } from "@ladino/db";
import { RULES_VERSION } from "./create-company.js";
import { SYSTEM_POSTER_ID } from "./treasury.js";

export type CentRegularization = {
  readonly company_id: string;
  readonly regularized: boolean;
  readonly dry_run?: boolean;
  /** El asiento posteado; null si la empresa no lleva contabilidad (va a la cola). */
  readonly entry_id?: string | null;
  /** La fila de cola, DESCARTADA con acta, cuando no va a haber asiento (20261003190200). */
  readonly queue_id?: string | null;
  /** Posiciones VACÍAS que quedan con valor: diferencia de costo, no redondeo (C4). */
  readonly visible_empty_positions?: JSONValue;
  readonly would_queue?: boolean;
  /** Solo en el ensayo: el período de hoy está cerrado y el asiento no se podría postear. */
  readonly period_closed?: boolean;
  readonly posting_date?: string;
  readonly rounding_line?: string;
  readonly inventory_adjustment?: string;
  readonly kardex?: JSONValue;
  readonly ledger?: JSONValue;
};

/**
 * LA REGULARIZACIÓN DEL CÉNTIMO AL CORTE (ADR-0075 §7; P-01, P-03, K-08).
 *
 * Desde la migración 20261003140000 todo lo nuevo nace al céntimo. Lo viejo no se toca
 * (append-only): esta reparación lleva a «Diferencias por redondeo» la fracción de céntimo que
 * arrastran el kardex (por posición) y el mayor (por cuenta), con un asiento por empresa y un
 * acta `accounting.cent_regularized`, que es también el corte del invariante `cent_gaps`.
 *
 * Mismo reparto que la de ADR-0070: la base PREPARA (movimientos del kardex + asiento en
 * borrador) y CIERRA (comprobación de `inventory_ledger_gap` + acta); el POSTEO vive aquí, en el
 * dominio, porque ninguna función SQL postea asientos. Todo en la transacción de quien llama.
 * Idempotente: la segunda vez no encuentra nada y no escribe nada.
 *
 * NINGUNA EMPRESA SE SALTA (C1, C5b; migración 20261003190000). La que lleva mayor y no tiene
 * papel de inventario (servicios) regulariza su mayor. La que no lleva contabilidad regulariza
 * su KARDEX igual y NO produce asiento: deja una fila de cola DESCARTADA con su motivo y su
 * acta (`accounting.pending_discarded`), nunca pendiente — ninguna plantilla podría resolverla y
 * una fila pendiente bloquearía para siempre el cierre de períodos cuando la empresa adopte la
 * contabilidad; el corte de ADR-0060 valora entonces el kardex. `cent_gaps` da cero también ahí,
 * sin «el conocido», e `inventory_coverage_gaps` acepta lo descartado con acta. Lo mismo cuando
 * las fracciones del kardex netean a cero exacto (no hay asiento de importe cero). Si el período de hoy
 * está CERRADO, el posteo falla (LAD61) y la transacción entera se deshace: no queda kardex
 * regularizado sin su asiento; se reabre el período o se corre al abrir el siguiente.
 *
 * No es un caso de uso de la API: lo corre el dueño de la base con
 * `node scripts/reparar/adr-0075-centimo.mjs`, después del git pull.
 */
export async function repairCents(
  sql: TransactionSql,
  companyId: string,
  ensayo = false,
): Promise<CentRegularization> {
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const [p] = await sql<{ r: CentRegularization }[]>`
    select platform.cent_regularization_prepare(${companyId}, ${ensayo}) as r`;
  const preparado = p!.r;
  if (!preparado.regularized) return preparado;
  // Sin asiento (empresa sin contabilidad): el kardex ya está regularizado y la cola lo cubre.
  if (!preparado.entry_id) {
    const [soloCola] = await sql<{ r: CentRegularization }[]>`
      select platform.cent_regularization_finish(${sql.json(preparado)}) as r`;
    return soloCola!.r;
  }

  const [num] = await sql<{ n: string }[]>`
    select platform.claim_entry_number(${companyId},
           extract(year from ${preparado.posting_date!}::date)::int)::text as n`;
  await sql`
    update public.journal_entries
       set status = 'posted', posted_at = now(), posted_by = ${SYSTEM_POSTER_ID},
           entry_number = ${num!.n}::bigint
     where id = ${preparado.entry_id} and company_id = ${companyId} and status = 'draft'`;
  // El mismo rastro que todo posteo (postJournalEntry, repairTreasurySubaccounts).
  const [e] = await sql<
    { tenant_id: string; entry_number: number; posting_date: string; total_debit: string }[]
  >`
    select e.tenant_id, e.entry_number::int as entry_number, e.posting_date::text as posting_date,
           (select sum(l.functional_debit) from public.journal_lines l
             where l.entry_id = e.id)::text as total_debit
      from public.journal_entries e where e.id = ${preparado.entry_id}`;
  const payload = {
    entry_number: e!.entry_number,
    posting_date: e!.posting_date,
    total_debit: e!.total_debit,
    description: "Regularización del céntimo al corte (ADR-0075 §7)",
  };
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${e!.tenant_id}, ${companyId}, 'journal_entry', ${preparado.entry_id},
            'journal.posted', 'system', now(), ${RULES_VERSION}, ${sql.json(payload)})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${e!.tenant_id}, ${companyId}, 'journal_entry', ${preparado.entry_id},
            'journal.posted', 1, ${sql.json({ id: preparado.entry_id, ...payload })})`;
  const [f] = await sql<{ r: CentRegularization }[]>`
    select platform.cent_regularization_finish(${sql.json(preparado)}) as r`;
  return f!.r;
}

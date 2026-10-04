import type { TransactionSql, JSONValue } from "@ladino/db";
import { RULES_VERSION } from "./create-company.js";
import { SYSTEM_POSTER_ID } from "./treasury.js";

export type TreasuryCurrencyRegularization = {
  readonly company_id: string;
  readonly regularized: boolean;
  readonly skipped?: string;
  readonly entry_id?: string | null;
  readonly posting_date?: string;
  readonly accounts?: JSONValue;
  readonly without_rate?: JSONValue;
};

/**
 * LA REGULARIZACIÓN DE LA DIVISA DE LAS CAJAS AL CORTE (ADR-0075 §6; E-11, J-04).
 *
 * Hasta la migración 20261003180000 toda línea de asiento se escribía en moneda funcional
 * (VES/1/identidad): el mayor no sabía cuántos dólares tenía cada caja. Lo nuevo nace con su
 * moneda; lo viejo no se toca (`journal_lines` es append-only). Esta reparación escribe, con un
 * asiento por empresa, el saldo EN DIVISA de cada caja en su subcuenta, sin cambiar un céntimo
 * de su saldo funcional. Después, `platform.treasury_currency_gaps` da cero sin corte ni lista.
 *
 * Mismo reparto que ADR-0070 y la del céntimo: la base PREPARA (asiento en borrador) y el
 * POSTEO vive aquí, porque ninguna función SQL postea asientos. Idempotente: sin hueco no
 * escribe nada. No es un caso de uso de la API: lo corre el dueño de la base con
 * `node scripts/reparar/adr-0075-divisa-del-mayor.mjs`, después del git pull.
 */
export async function repairTreasuryCurrency(
  sql: TransactionSql,
  companyId: string,
): Promise<TreasuryCurrencyRegularization> {
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const [p] = await sql<{ r: TreasuryCurrencyRegularization }[]>`
    select platform.treasury_currency_regularization_prepare(${companyId}) as r`;
  const preparado = p!.r;
  if (!preparado.regularized || !preparado.entry_id) return preparado;

  const [num] = await sql<{ n: string }[]>`
    select platform.claim_entry_number(${companyId},
           extract(year from ${preparado.posting_date!}::date)::int)::text as n`;
  await sql`
    update public.journal_entries
       set status = 'posted', posted_at = now(), posted_by = ${SYSTEM_POSTER_ID},
           entry_number = ${num!.n}::bigint
     where id = ${preparado.entry_id} and company_id = ${companyId} and status = 'draft'`;
  const [e] = await sql<{ tenant_id: string; entry_number: number; posting_date: string }[]>`
    select e.tenant_id, e.entry_number::int as entry_number, e.posting_date::text as posting_date
      from public.journal_entries e where e.id = ${preparado.entry_id}`;
  // La comprobación que no se delega: después de postear, ninguna caja en divisa queda con hueco
  // (salvo las que no tenían tasa, que el acta nombra).
  const [quedan] = await sql<{ n: number }[]>`
    select count(*)::int as n
      from platform.treasury_currency_gaps(${companyId}) g
      join public.companies c on c.id = ${companyId}
     where g.currency <> c.functional_currency_code
       and not (${sql.json(preparado.without_rate ?? [])}::jsonb
                @> jsonb_build_array(jsonb_build_object('company_account_id', g.account_id)))`;
  if ((quedan?.n ?? 0) > 0) {
    throw new Error(
      `regularización de la divisa de ${companyId}: quedan ${quedan!.n} caja(s) con hueco tras postear`,
    );
  }
  const acta = {
    adr: "ADR-0075 §6",
    entry_id: preparado.entry_id,
    entry_number: e!.entry_number,
    posting_date: e!.posting_date,
    accounts: preparado.accounts ?? [],
    without_rate: preparado.without_rate ?? [],
  };
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${e!.tenant_id}, ${companyId}, 'company', ${companyId},
            'treasury.currency_regularized', 'system', now(), ${RULES_VERSION},
            ${sql.json(acta)})`;
  return preparado;
}

import type { TransactionSql } from "@ladino/db";

/**
 * Tesorería (migración 29): a qué CUENTA entra o sale el efectivo de un pago.
 *
 * La escalera de resolución, en orden:
 *   1. un instrumento SIN efectivo (saldo a favor, nota de crédito) no lleva
 *      cuenta: el CHECK de la tabla lo exige en NULL, porque atribuirle una
 *      cuenta inventaría dinero en el saldo materializado;
 *   2. la forma de pago configurada para ese instrumento, si su cuenta vive en
 *      la moneda del pago («Pago móvil → Banesco»);
 *   3. la cuenta de sistema «Sin asignar (<moneda>)», creada al vuelo la
 *      primera vez: el dinero queda visible y el contador lo redistribuye
 *      después, que es exactamente el diseño del backfill de la migración 29.
 */
const SIN_EFECTIVO = new Set(["saldo_a_favor", "nota_credito"]);

export async function resolverCuentaEfectivo(
  sql: TransactionSql,
  tenantId: string,
  companyId: string,
  instrument: string,
  currency: string,
): Promise<string | null> {
  if (SIN_EFECTIVO.has(instrument)) return null;

  const [porMetodo] = await sql<{ id: string }[]>`
    select ca.id
      from public.payment_methods pm
      join public.company_accounts ca on ca.id = pm.account_id
     where pm.company_id = ${companyId} and pm.kind = ${instrument}
       and pm.is_active and ca.is_active and ca.currency = ${currency}
     order by pm.created_at
     limit 1`;
  if (porMetodo) return porMetodo.id;

  const nombre = `Sin asignar (${currency})`;
  const [existente] = await sql<{ id: string }[]>`
    select id from public.company_accounts
     where company_id = ${companyId} and is_system and name = ${nombre}`;
  if (existente) return existente.id;

  await sql`
    insert into public.company_accounts (tenant_id, company_id, name, currency, kind, is_system)
    values (${tenantId}, ${companyId}, ${nombre}, ${currency}, 'cash', true)
    on conflict (company_id, name) do nothing`;
  const [creada] = await sql<{ id: string }[]>`
    select id from public.company_accounts
     where company_id = ${companyId} and is_system and name = ${nombre}`;
  return creada!.id;
}

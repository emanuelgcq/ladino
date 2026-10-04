import type { TransactionSql } from "@ladino/db";

/**
 * El fixture DECLARA el tipo de contribuyente de su empresa de prueba (ADR-0072 §1, migración
 * 20260928190000): desde que el tipo tiene historia y sin tipo vigente no se factura, una empresa
 * con RIF creada por SQL necesita su declaración como la necesitaría una real.
 *
 * Declara el tipo que el fixture ya ponía en `companies.taxpayer_type_code` (la columna espejo);
 * si no ponía ninguno, `ordinario`, que es lo que la empresa de prueba venía siendo de hecho. Rige
 * desde el 2000-01-01 para que ninguna fecha del fichero quede fuera. Una empresa sin RIF
 * (`PEND-`) no declara nada: es no_contribuyente por hecho.
 */
export async function declararTipoDeFixture(
  tx: TransactionSql | ((...a: never[]) => unknown),
  companyId: string,
): Promise<void> {
  const sql = tx as TransactionSql;
  await sql`
    insert into public.company_taxpayer_types
      (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason,
       rules_version)
    select c.tenant_id, c.id, coalesce(c.taxpayer_type_code, 'ordinario'), '2000-01-01',
           case when c.taxpayer_type_code = 'especial' then '2000-01-01'::date end,
           'Fixture E2E: el tipo que la empresa de prueba declara', 'domain-s0.5'
      from public.companies c
     where c.id = ${companyId} and upper(btrim(c.tax_id)) not like 'PEND-%'
       and not exists (select 1 from public.company_taxpayer_types h where h.company_id = c.id)`;
}

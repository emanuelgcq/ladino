-- =============================================================================
-- Ladino — migración 63 · SIN RIF, RECIBOS (regla del dueño, 2026-09-16)
--
-- «Si tienes RIF tienes facturas; si NO tienes RIF, das recibos. Es así.»
--
-- Desde 2026-09-14 el registro asigna `sin_facturacion` a la empresa que nace
-- sin RIF (packages/domain/src/onboarding.ts, plan «Ladino sin RIF», A2). Las
-- que se registraron ANTES sin RIF y nunca terminaron Empezar quedaron SIN
-- régimen: el modo de venta les daba «ninguno», la caja respondía 409 y la web
-- les enseñaba el IVA, la alícuota y los libros fiscales. Esta migración les
-- aplica la misma regla que el registro, con la misma acta.
--
-- Qué hace:
--   1. `platform.assign_receipts_to_companies_without_rif()`: a toda empresa con
--      el marcador `PEND-…` (sin RIF) y SIN régimen vigente le abre el régimen
--      `sin_facturacion` desde ahora, con su evento de auditoría. Idempotente:
--      la segunda llamada no hace nada. Devuelve cuántas tocó.
--   2. La llama una vez.
--
-- Qué NO hace: no cambia el régimen de ninguna empresa que ya tenga uno. Una
-- empresa sin RIF con un régimen que factura es un caso aparte que se revisa
-- con el dueño (la consulta está en el HANDOFF); cambiarlo aquí sería decidir
-- por él sobre documentos que quizá ya emitió.
--
-- Por qué `now()` como inicio: una empresa sin régimen no pudo emitir nada (el
-- trigger de emisión lo rechaza), así que no hay pasado que cubrir.
--
-- Reversibilidad: las filas insertadas llevan su evento
-- `fiscal.regime.assigned` con `origin = 'migration_20260916150000'`; se
-- identifican por él. No se borra nada en producción (R8): si hiciera falta
-- deshacer, se cierra la vigencia con otra migración.
-- HOMOLOGATION_IMPACT = NO (el régimen de recibos no emite documentos fiscales).
-- =============================================================================

create function platform.assign_receipts_to_companies_without_rif()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c record;
  v_n integer := 0;
begin
  for v_c in
    select c.id, c.tenant_id
      from public.companies c
     where c.tax_id like 'PEND-%'
       and not exists (
         select 1 from public.company_fiscal_regimes r
          where r.company_id = c.id
            and r.effective_from <= now()
            and (r.effective_to is null or r.effective_to > now()))
       -- Ni un régimen futuro ya programado: ese lo decidió alguien.
       and not exists (
         select 1 from public.company_fiscal_regimes r
          where r.company_id = c.id and r.effective_from > now())
     order by c.created_at
     for update of c
  loop
    insert into public.company_fiscal_regimes (tenant_id, company_id, regime_code, effective_from)
    values (v_c.tenant_id, v_c.id, 'sin_facturacion', now());

    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_c.tenant_id, v_c.id, 'company', v_c.id, 'fiscal.regime.assigned',
            'system', now(), 'db-migration',
            jsonb_build_object(
              'to', 'sin_facturacion',
              'origin', 'migration_20260916150000',
              'declaration',
              'Regla del dueño (2026-09-16): sin RIF, recibos. La empresa no tenía RIF ni régimen.'));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
comment on function platform.assign_receipts_to_companies_without_rif() is
  'Sin RIF, recibos: abre `sin_facturacion` a las empresas con marcador PEND-… y sin régimen. '
  'Idempotente; devuelve cuántas tocó. Regla del dueño, 2026-09-16.';
revoke execute on function platform.assign_receipts_to_companies_without_rif() from public;

select platform.assign_receipts_to_companies_without_rif();

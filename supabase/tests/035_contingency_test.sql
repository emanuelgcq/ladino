-- =============================================================================
-- Ladino — pgTAP 35 · CONTINGENCIA (migración 35) — RIGOR MÁXIMO
--
-- El talonario físico de la PA 102, con sus variantes rotas:
--   1. un rango cuya serie NO dice «contingencia» no puede registrarse como
--      talonario de contingencia (LAD69) — nadie se disfraza;
--   2. del registro solo se cierra el período, UNA vez: reescribir motivo o
--      rango es LAD06, y reabrir también;
--   3. borrar no existe (append-only, LAD06);
--   4. el permiso propio está sembrado.
-- =============================================================================

begin;
select plan(8);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into public.tenants (id, name) values
  ('aaaa0035-0000-4000-8000-00000000000a', 'Tenant 35');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0035-0000-4000-8000-0000000000a2', 'aaaa0035-0000-4000-8000-00000000000a',
   'J-35-A', 'Empresa 35', 'ordinario');
insert into public.fiscal_number_ranges
  (id, tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
values
  ('aaaa0035-0000-4000-8000-00000000e001', 'aaaa0035-0000-4000-8000-00000000000a',
   'aaaa0035-0000-4000-8000-0000000000a2', 'invoice', 'A', 1, 100, 1,
   'Imprenta normal — NO es de contingencia'),
  ('aaaa0035-0000-4000-8000-00000000e002', 'aaaa0035-0000-4000-8000-00000000000a',
   'aaaa0035-0000-4000-8000-0000000000a2', 'invoice', 'contingencia-1', 1, 50, 1,
   'Talonario físico de contingencia');

-- ── 1. La serie manda ────────────────────────────────────────────────────────
select throws_ok(
  $$insert into public.contingency_ranges
      (tenant_id, company_id, fiscal_number_range_id, reason, failure_started_at)
    values ('aaaa0035-0000-4000-8000-00000000000a', 'aaaa0035-0000-4000-8000-0000000000a2',
            'aaaa0035-0000-4000-8000-00000000e001', 'Se cayó el sistema toda la mañana',
            '2026-09-02T08:00:00-04:00')$$,
  'LAD69',
  null,
  'Un rango de serie normal NO puede registrarse como contingencia (LAD69)');

select lives_ok(
  $$insert into public.contingency_ranges
      (id, tenant_id, company_id, fiscal_number_range_id, reason, failure_started_at)
    values ('aaaa0035-0000-4000-8000-00000000cc01',
            'aaaa0035-0000-4000-8000-00000000000a', 'aaaa0035-0000-4000-8000-0000000000a2',
            'aaaa0035-0000-4000-8000-00000000e002', 'Se cayó el sistema toda la mañana',
            '2026-09-02T08:00:00-04:00')$$,
  'La serie «contingencia-1» sí entra');

-- ── 2. Solo se cierra el período, una vez ────────────────────────────────────
select throws_ok(
  $$update public.contingency_ranges
       set reason = 'Otro motivo que reescribe por qué existieron esas facturas'
     where id = 'aaaa0035-0000-4000-8000-00000000cc01'$$,
  'LAD06',
  null,
  'Reescribir el motivo de una falla registrada es LAD06');

select lives_ok(
  $$update public.contingency_ranges
       set failure_ended_at = '2026-09-02T13:30:00-04:00'
     where id = 'aaaa0035-0000-4000-8000-00000000cc01'$$,
  'Cerrar el período (una vez) pasa');

select throws_ok(
  $$update public.contingency_ranges set failure_ended_at = null
     where id = 'aaaa0035-0000-4000-8000-00000000cc01'$$,
  'LAD06',
  null,
  'Reabrir un período cerrado es LAD06');

select throws_ok(
  $$update public.contingency_ranges
       set failure_ended_at = '2026-09-02T18:00:00-04:00'
     where id = 'aaaa0035-0000-4000-8000-00000000cc01'$$,
  'LAD06',
  null,
  'Moverlo tampoco: cerrado es cerrado');

-- ── 3. Borrar no existe ──────────────────────────────────────────────────────
select throws_ok(
  $$delete from public.contingency_ranges
     where id = 'aaaa0035-0000-4000-8000-00000000cc01'$$,
  'LAD06',
  null,
  'El registro de una contingencia no se borra (append-only)');

-- ── 4. El permiso existe ─────────────────────────────────────────────────────
select is(
  (select count(*) from public.permissions where key = 'fiscal.contingency.manage'),
  1::bigint,
  'El permiso fiscal.contingency.manage está sembrado');

select * from finish();
rollback;

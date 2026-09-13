-- =============================================================================
-- Ladino — pgTAP 50 · LA PRIMERA VIGENCIA CONTABLE RIGE DESDE SIEMPRE
--                     (migración 50, ADR-0055)
--
-- Regla de familia, con respuesta cero: en TODA la tabla, la vigencia más
-- antigua de cada (empresa, hecho) es -infinity. Y el ciclo completo: la
-- primera plantilla nace desde siempre, la segunda cierra a la primera y
-- empieza ahora — sin que el EXCLUDE de vigencias se queje.
-- =============================================================================

begin;
select plan(5);

insert into public.tenants (id, name) values ('aaaa0050-0000-4000-8000-00000000000a', 'Tenant 50');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0050-0000-4000-8000-0000000000a2', 'aaaa0050-0000-4000-8000-00000000000a',
   'J-50-A', 'Empresa 50', 'ordinario');

-- La primera plantilla del hecho: desde siempre (lo que hace el dominio).
insert into public.journal_templates
  (id, tenant_id, company_id, source_kind, source_event, description, effective_from)
values ('aaaa0050-0000-4000-8000-00000000e001', 'aaaa0050-0000-4000-8000-00000000000a',
        'aaaa0050-0000-4000-8000-0000000000a2', 'sales_invoice', 'fiscal.invoice.issued',
        'Venta v1', '-infinity');

select is(
  (select effective_from from public.journal_templates
    where id = 'aaaa0050-0000-4000-8000-00000000e001'),
  '-infinity'::timestamptz, 'la primera vigencia queda abierta hacia atrás');

-- Un documento anterior a la configuración ENCUENTRA la plantilla: es la
-- misma comparación que hace journal-generator.ts.
select is(
  (select count(*) from public.journal_templates
    where company_id = 'aaaa0050-0000-4000-8000-0000000000a2'
      and (effective_from at time zone 'America/Caracas')::date <= '2020-01-01'::date
      and (effective_to is null
           or (effective_to at time zone 'America/Caracas')::date > '2020-01-01'::date)),
  1::bigint, 'un hecho del año 2020 tiene plantilla vigente: la cola de antes no habría existido');

-- La segunda versión: cierra la primera y empieza ahora.
update public.journal_templates set effective_to = now()
 where id = 'aaaa0050-0000-4000-8000-00000000e001';
insert into public.journal_templates
  (id, tenant_id, company_id, source_kind, source_event, description)
values ('aaaa0050-0000-4000-8000-00000000e002', 'aaaa0050-0000-4000-8000-00000000000a',
        'aaaa0050-0000-4000-8000-0000000000a2', 'sales_invoice', 'fiscal.invoice.issued',
        'Venta v2');
select cmp_ok(
  (select effective_from from public.journal_templates
    where id = 'aaaa0050-0000-4000-8000-00000000e002'),
  '>', '-infinity'::timestamptz, 'la segunda versión empieza ahora, no desde siempre');

-- Regla de familia sobre TODA la tabla: cero grupos cuya vigencia más antigua
-- no sea -infinity. La respuesta útil de un gate es cero, sin lista de perdones.
select is(
  (select count(*) from (
     select company_id, source_kind, source_event, min(effective_from) as primera
       from public.journal_templates
      group by 1, 2, 3
     having min(effective_from) <> '-infinity'::timestamptz) g),
  0::bigint, 'ningún (empresa, hecho) tiene su primera plantilla fechada: todas rigen desde siempre');
select is(
  (select count(*) from (
     select company_id, purpose, min(effective_from) as primera
       from public.company_account_settings
      group by 1, 2
     having min(effective_from) <> '-infinity'::timestamptz) g),
  0::bigint, 'ídem para los papeles contables');

select * from finish();
rollback;

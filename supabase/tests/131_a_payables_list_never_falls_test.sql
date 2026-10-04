-- =============================================================================
-- Ladino — pgTAP 131 · UNA LISTA DE CUENTAS POR PAGAR NUNCA SE CAE, Y EL MARGEN DEJA ACTA
-- (migración 20261004200000; arreglos de la revisión de 20261004195900)
--
-- La última tasa oficial EUR→VES tiene 8 días y el margen es 7: hoy NO hay «tasa del día».
-- EUR a propósito: `exchange_rates` global la comparten todas las pruebas y los E2E, y nadie más
-- deja tasas de euros; el margen se FIJA en 7 dentro de la transacción.
--
--   1.     la precondición, medida: hoy no hay tasa EUR→VES dentro del margen;
--   2-3.   una factura en divisa PAGADA, y una asentada con saldo CERO, deben 0 sin pedir tasa;
--   4-5.   una factura en divisa que SÍ se debe: NULL, sin excepción;
--   6.     una factura en la moneda de la empresa no depende de ninguna tasa;
--   7-9.   `ap_aging` responde: el proveedor que no debe no tiene tramos; el que debe en divisa
--          tiene su tramo con el importe en NULL y sus DOS facturas contadas;
--   10.    aislamiento: con la empresa equivocada la factura no existe (NULL, no una cifra);
--   11-12. con la tasa dentro del margen (30 días) vuelven las cifras de siempre;
--   13.    VARIANTE ROTA — con la definición anterior (20260916170000) la factura PAGADA lanza
--          LAD51: lo que miden 2-9 es la rama nueva;
--   14-17. cambiar el margen deja acta: DOS filas cambian (el dato y su alias), dos actas, y la
--          del espejo dice de dónde viene; en las dos direcciones; sin cambio no hay acta;
--   18-19. alta y baja de un parámetro dejan la suya, con el valor;
--   20-21. `authenticated` no puede cambiar el margen (42501) y el intento no deja acta;
--   (migración 20261004200100)
--   22-23. un cambio del margen hecho DESDE OTRO TRIGGER no se etiqueta como espejo: el espejo
--          se reconoce por su marca, no por la profundidad (que ahí ya es 2);
--   24.    la marca no se queda puesta: el cambio directo siguiente no es espejo;
--   25-26. TRUNCATE de platform.parameters se rechaza con su mensaje y no borra nada;
--   27.    VARIANTE ROTA — sin parameters_a_record, el cambio no deja rastro;
--   28.    VARIANTE ROTA — sin parameters_no_truncate, el TRUNCATE vacía la tabla.
-- =============================================================================

begin;
select plan(28);

insert into public.tenants (id, name) values
  ('aaaa0131-0000-4000-8000-00000000000a', 'Tenant 131'),
  ('aaaa0131-0000-4000-8000-00000000000b', 'Tenant 131 B');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0131-0000-4000-8000-0000000000a1', 'aaaa0131-0000-4000-8000-00000000000a',
   'J-131-A', 'Compras 131', 'ordinario'),
  ('aaaa0131-0000-4000-8000-0000000000b1', 'aaaa0131-0000-4000-8000-00000000000b',
   'J-131-B', 'Ajena 131', 'ordinario');
insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0131-0000-4000-8000-00000000e001', 'aaaa0131-0000-4000-8000-00000000000a',
   'aaaa0131-0000-4000-8000-0000000000a1', 'J-PRO-131-1', 'Proveedor que no debe', 'nacional',
   'juridica', 'ordinario'),
  ('aaaa0131-0000-4000-8000-00000000e002', 'aaaa0131-0000-4000-8000-00000000000a',
   'aaaa0131-0000-4000-8000-0000000000a1', 'J-PRO-131-2', 'Proveedor al que se debe', 'nacional',
   'juridica', 'ordinario');

update platform.parameters set value = 7 where key = 'official_rate_max_age_days';
-- El euro no está en el catálogo: se da de alta dentro de la transacción (se deshace al final).
insert into public.currencies (code, name, symbol, display_decimals) values ('EUR', 'Euro', '€', 2);
insert into public.exchange_rates
  (from_currency, to_currency, rate, source, rate_date, rate_timestamp, tenant_id, company_id)
values ('EUR', 'VES', 50, 'BCV oficial prueba-131', platform.caracas_day(now()) - 8, now() - interval '8 days',
        null, null);

-- Proveedor 1: f101 PAGADA (EUR 58); f102 asentada y retenida entera (saldo 0).
-- Proveedor 2: f201 debida (EUR 116); f202 debida en bolívares (1.000).
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount, retention_total,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate,
   amount_transaction_currency, functional_amount)
values
  ('aaaa0131-0000-4000-8000-00000000f101', 'aaaa0131-0000-4000-8000-00000000000a',
   'aaaa0131-0000-4000-8000-0000000000a1', 'aaaa0131-0000-4000-8000-00000000e001',
   'FP-131-1', 'CTRL-131-1', platform.caracas_day(now()), 'paid', now(), 50, 8, 58, 0, true,
   'EUR', 'VES', 40, 58, 2320),
  ('aaaa0131-0000-4000-8000-00000000f102', 'aaaa0131-0000-4000-8000-00000000000a',
   'aaaa0131-0000-4000-8000-0000000000a1', 'aaaa0131-0000-4000-8000-00000000e001',
   'FP-131-2', 'CTRL-131-2', platform.caracas_day(now()), 'posted', now(), 50, 8, 58, 2320, true,
   'EUR', 'VES', 40, 58, 2320),
  ('aaaa0131-0000-4000-8000-00000000f201', 'aaaa0131-0000-4000-8000-00000000000a',
   'aaaa0131-0000-4000-8000-0000000000a1', 'aaaa0131-0000-4000-8000-00000000e002',
   'FP-131-3', 'CTRL-131-3', platform.caracas_day(now()), 'posted', now(), 100, 16, 116, 0, true,
   'EUR', 'VES', 40, 116, 4640),
  ('aaaa0131-0000-4000-8000-00000000f202', 'aaaa0131-0000-4000-8000-00000000000a',
   'aaaa0131-0000-4000-8000-0000000000a1', 'aaaa0131-0000-4000-8000-00000000e002',
   'FP-131-4', 'CTRL-131-4', platform.caracas_day(now()), 'posted', now(), 1000, 0, 1000, 0, true,
   'VES', 'VES', 1, 1000, 1000);

-- ── La precondición ──────────────────────────────────────────────────────────
select is(
  platform.rate_at('aaaa0131-0000-4000-8000-0000000000a1', 'EUR', 'VES', platform.caracas_day(now())),
  null::numeric, 'hoy no hay tasa EUR→VES dentro del margen: la última tiene 8 días');

-- ── Lo que no se debe no necesita tasa ───────────────────────────────────────
select is(
  platform.supplier_debt_today('aaaa0131-0000-4000-8000-0000000000a1',
                               'aaaa0131-0000-4000-8000-00000000f101'),
  0.00::numeric, 'una factura en divisa PAGADA debe 0, sin tasa y sin excepción');
select is(
  platform.supplier_debt_today('aaaa0131-0000-4000-8000-0000000000a1',
                               'aaaa0131-0000-4000-8000-00000000f102'),
  0.00::numeric, 'una factura en divisa asentada y con saldo CERO debe 0, sin tasa');

-- ── Lo que se debe y no se puede valorar: NULL, no excepción ─────────────────
select lives_ok($$
  select platform.supplier_debt_today('aaaa0131-0000-4000-8000-0000000000a1',
                                      'aaaa0131-0000-4000-8000-00000000f201')
$$, 'una factura en divisa con saldo y sin tasa NO lanza');
select is(
  platform.supplier_debt_today('aaaa0131-0000-4000-8000-0000000000a1',
                               'aaaa0131-0000-4000-8000-00000000f201'),
  null::numeric, 'devuelve NULL: se debe, y hoy no se puede valorar (NULL no es cero)');
select is(
  platform.supplier_debt_today('aaaa0131-0000-4000-8000-0000000000a1',
                               'aaaa0131-0000-4000-8000-00000000f202'),
  1000.00::numeric, 'una factura en la moneda de la empresa no depende de ninguna tasa');

-- ── La antigüedad ────────────────────────────────────────────────────────────
select lives_ok($$
  select * from platform.ap_aging('aaaa0131-0000-4000-8000-0000000000a1')
$$, 'ap_aging responde para toda la empresa sin tasa del día');
select is(
  (select count(*) from platform.ap_aging('aaaa0131-0000-4000-8000-0000000000a1',
                                          'aaaa0131-0000-4000-8000-00000000e001')),
  0::bigint, 'el proveedor al que no se le debe nada no tiene tramos (y su lista no se cae)');
select results_eq(
  $$select bucket, document_count, amount
      from platform.ap_aging('aaaa0131-0000-4000-8000-0000000000a1',
                             'aaaa0131-0000-4000-8000-00000000e002')$$,
  $$values ('0-30'::text, 2::bigint, null::numeric)$$,
  'el proveedor al que se debe en divisa: su tramo cuenta las DOS facturas y el importe va en NULL');

-- ── Aislamiento: la empresa equivocada no ve la factura ──────────────────────
select is(
  platform.supplier_debt_today('aaaa0131-0000-4000-8000-0000000000b1',
                               'aaaa0131-0000-4000-8000-00000000f202'),
  null::numeric, 'con la empresa de OTRO inquilino la factura no existe: NULL, no sus 1.000');

-- ── Con tasa dentro del margen, las cifras de siempre ────────────────────────
update platform.parameters set value = 30 where key = 'official_rate_max_age_days';
select is(
  platform.supplier_debt_today('aaaa0131-0000-4000-8000-0000000000a1',
                               'aaaa0131-0000-4000-8000-00000000f201'),
  5800.00::numeric, 'con la tasa dentro del margen, la deuda es el saldo a la tasa: 116 × 50');
select results_eq(
  $$select bucket, document_count, amount
      from platform.ap_aging('aaaa0131-0000-4000-8000-0000000000a1',
                             'aaaa0131-0000-4000-8000-00000000e002')$$,
  $$values ('0-30'::text, 2::bigint, 6800.00::numeric)$$,
  'y el tramo suma: 5.800 + 1.000');
update platform.parameters set value = 7 where key = 'official_rate_max_age_days';

-- ── VARIANTE ROTA: la definición anterior ────────────────────────────────────
savepoint antes_de_romper;
create or replace function platform.supplier_debt_today(p_company uuid, p_invoice uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_inv record;
  v_rate numeric;
  v_saldo numeric;
  v_escala int;
begin
  select i.transaction_currency, i.functional_currency
    into v_inv
    from public.supplier_invoices i
   where i.id = p_invoice and i.company_id = p_company and i.status in ('posted', 'paid');
  if not found then return null; end if;
  v_escala := platform.currency_minor_units(v_inv.functional_currency);
  v_saldo := platform.supplier_invoice_balance(p_company, p_invoice);
  if v_inv.transaction_currency = v_inv.functional_currency then
    return round(v_saldo, v_escala);
  end if;
  v_rate := platform.rate_at(p_company, v_inv.transaction_currency, v_inv.functional_currency,
                             platform.caracas_day(now()));
  if v_rate is null then
    raise exception 'no hay tasa % → % vigente hoy', v_inv.transaction_currency,
      v_inv.functional_currency using errcode = 'LAD51';
  end if;
  return round(v_saldo * v_rate, v_escala);
end;
$$;
select throws_ok($$
  select * from platform.ap_aging('aaaa0131-0000-4000-8000-0000000000a1',
                                  'aaaa0131-0000-4000-8000-00000000e001')
$$, 'LAD51', null,
  'VARIANTE ROTA: con la definición anterior, la lista del proveedor que NO debe nada se cae');
rollback to savepoint antes_de_romper;

-- ── Cambiar el margen deja acta ──────────────────────────────────────────────
-- Las actas de esta transacción se reconocen por `created_at = now()` (la hora de inicio de la
-- transacción, que es la que pone la procedencia). Las de arriba (7 → 30 → 7) ya están: se
-- cuenta desde aquí con una marca.
create temporary table marca_131 on commit drop as
  select count(*) as n from public.system_audit_events
   where event_type = 'platform.parameter_changed' and created_at = now();

update platform.parameters set value = 9 where key = 'official_rate_max_age_days';
select is(
  (select count(*) from public.system_audit_events
    where event_type = 'platform.parameter_changed' and created_at = now())
    - (select n from marca_131),
  2::bigint, 'cambiar el margen deja DOS actas —el dato y su alias—, no una ni un bucle');
select results_eq(
  $$select payload->>'key', payload->>'old_value', payload->>'new_value',
           payload->>'mirrored_from', payload->>'operation'
      from public.system_audit_events
     where event_type = 'platform.parameter_changed' and created_at = now()
       and payload->>'new_value' = '9'
     order by payload->>'key' desc$$,
  $$values ('official_rate_max_age_days'::text, '7'::text, '9'::text, null::text, 'update'::text),
           ('closing_rate_max_age_days', '7', '9', 'official_rate_max_age_days', 'update')$$,
  'cada acta dice clave, valor anterior y nuevo; la del alias dice que es el espejo de la otra');

update platform.parameters set value = 11 where key = 'closing_rate_max_age_days';
select results_eq(
  $$select payload->>'key', payload->>'old_value', payload->>'mirrored_from'
      from public.system_audit_events
     where event_type = 'platform.parameter_changed' and created_at = now()
       and payload->>'new_value' = '11'
     order by payload->>'key'$$,
  $$values ('closing_rate_max_age_days'::text, '9'::text, null::text),
           ('official_rate_max_age_days', '9', 'closing_rate_max_age_days')$$,
  'escrito por el nombre viejo, lo mismo al revés: el espejo es el dato nuevo');

update platform.parameters set value = 11 where key = 'official_rate_max_age_days';
select is(
  (select count(*) from public.system_audit_events
    where event_type = 'platform.parameter_changed' and created_at = now())
    - (select n from marca_131),
  4::bigint, 'escribir el mismo valor no deja acta: no cambió nada');

-- ── Alta y baja ──────────────────────────────────────────────────────────────
insert into platform.parameters (key, value, note)
values ('prueba_131_parametro', 3, 'Parámetro de la prueba 131, no lo lee ninguna regla.');
select results_eq(
  $$select payload->>'operation', payload->>'old_value', payload->>'new_value',
           aggregate_type, aggregate_id
      from public.system_audit_events
     where event_type = 'platform.parameter_changed' and created_at = now()
       and payload->>'key' = 'prueba_131_parametro'$$,
  $$values ('insert'::text, null::text, '3'::text, 'platform_parameter'::text,
            md5('platform.parameters:prueba_131_parametro')::uuid)$$,
  'el alta de un parámetro deja su acta, con el valor con que nace');
delete from platform.parameters where key = 'prueba_131_parametro';
select results_eq(
  $$select payload->>'old_value', payload->>'new_value'
      from public.system_audit_events
     where event_type = 'platform.parameter_changed' and created_at = now()
       and payload->>'key' = 'prueba_131_parametro' and payload->>'operation' = 'delete'$$,
  $$values ('3'::text, null::text)$$,
  'y la baja, con el valor que tenía');

-- ── Quien no puede cambiarlo, no lo cambia ni deja acta ──────────────────────
set local role authenticated;
select throws_ok($$
  update platform.parameters set value = 365 where key = 'official_rate_max_age_days'
$$, '42501', null, 'authenticated no puede cambiar el margen de la tasa');
reset role;
select is(
  (select count(*) from public.system_audit_events
    where event_type = 'platform.parameter_changed' and created_at = now()
      and payload->>'new_value' = '365'),
  0::bigint, 'y el intento rechazado no deja acta');

-- ── El espejo se reconoce por SU MARCA, no por la profundidad (20261004200100) ──
-- Un cambio del margen hecho desde dentro de OTRO trigger (una tabla cualquiera cuyo trigger
-- escribe el parámetro) corre a profundidad 2. Con `pg_trigger_depth() > 1` su acta decía
-- «espejo de closing_rate_max_age_days»: una decisión etiquetada como eco de otra que no hubo.
create temporary table disparador_131 (id int, profundidad int) on commit drop;
create function pg_temp.cambia_el_margen_131() returns trigger language plpgsql as $$
begin
  new.profundidad := pg_trigger_depth();
  update platform.parameters set value = 12 where key = 'official_rate_max_age_days';
  return new;
end;
$$;
create trigger cambia_el_margen before insert on disparador_131
  for each row execute function pg_temp.cambia_el_margen_131();
insert into disparador_131 (id) values (1);
select results_eq(
  $$select payload->>'key', payload->>'old_value', payload->>'mirrored_from'
      from public.system_audit_events
     where event_type = 'platform.parameter_changed' and created_at = now()
       and payload->>'new_value' = '12'
     order by payload->>'key' desc$$,
  $$values ('official_rate_max_age_days'::text, '11'::text, null::text),
           ('closing_rate_max_age_days', '11', 'official_rate_max_age_days')$$,
  'el margen cambiado desde OTRO trigger NO es espejo; su alias sí, y dice de quién');
select is((select profundidad from disparador_131 where id = 1), 1,
  'y ese cambio corrió de verdad dentro de un trigger: los del parámetro, a profundidad 2 (la regla vieja lo llamaba espejo)');

update platform.parameters set value = 14 where key = 'closing_rate_max_age_days';
select results_eq(
  $$select payload->>'key', payload->>'mirrored_from'
      from public.system_audit_events
     where event_type = 'platform.parameter_changed' and created_at = now()
       and payload->>'new_value' = '14'
     order by payload->>'key'$$,
  $$values ('closing_rate_max_age_days'::text, null::text),
           ('official_rate_max_age_days', 'closing_rate_max_age_days')$$,
  'la marca no se queda puesta: el cambio directo siguiente no es espejo, y el suyo sí');

-- ── Nadie vacía los parámetros ───────────────────────────────────────────────
-- TRUNCATE no dispara los triggers de fila: vaciaba la tabla SIN acta, y sin el margen
-- platform.rate_for no devuelve ninguna tasa (toda conversión se detiene).
select throws_ok($$ truncate platform.parameters $$, '0A000',
  'LADINO_PARAMETERS_TRUNCATE: platform.parameters no se vacía. Sin sus parámetros la regla de la tasa del día (platform.rate_for) no devuelve ninguna tasa y toda conversión se detiene. Para retirar un parámetro, bórralo por su clave: deja acta.',
  'TRUNCATE de platform.parameters se rechaza, con un mensaje que dice por qué y qué hacer');
select is(
  (select count(*) from platform.parameters
    where key in ('official_rate_max_age_days', 'closing_rate_max_age_days')),
  2::bigint, 'y los parámetros siguen ahí: el dato del margen y su alias');

-- ── VARIANTE ROTA: sin el trigger, el cambio no deja rastro ──────────────────
drop trigger parameters_a_record on platform.parameters;
update platform.parameters set value = 13 where key = 'official_rate_max_age_days';
select is(
  (select count(*) from public.system_audit_events
    where event_type = 'platform.parameter_changed' and created_at = now()
      and payload->>'new_value' = '13'),
  0::bigint, 'VARIANTE ROTA: sin parameters_a_record el margen cambia sin acta (lo que miden 14-19 es el trigger)');

-- ── VARIANTE ROTA: sin el trigger de sentencia, el TRUNCATE entra y vacía ────
-- Lo último de la prueba: el TRUNCATE toma un candado exclusivo sobre la tabla hasta el
-- rollback de abajo. El `lock_timeout` evita dejar esperando a quien lea el margen.
set local lock_timeout = '4s';
drop trigger parameters_no_truncate on platform.parameters;
truncate platform.parameters;
select is((select count(*) from platform.parameters), 0::bigint,
  'VARIANTE ROTA: sin parameters_no_truncate la tabla se vacía (lo que mide 25 es el trigger)');

select * from finish();
rollback;

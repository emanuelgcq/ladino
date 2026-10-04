-- =============================================================================
-- Ladino — pgTAP 121 · EL RECIBO SE DEVUELVE CON RECIBO, Y EL FORMAL NO VENDE GRAVADO
-- Migración 20261004110000_a_receipt_is_returned_with_a_receipt.sql (recorrido M-12 y M-10).
--
--   M-12. Una empresa que vendía con recibos y ya factura (régimen `formatos_libres`) devuelve un
--         recibo viejo con RECIBO DE DEVOLUCIÓN: sin número de control y fuera del gate de kind.
--         Lo demás del gate sigue vivo: no vende por recibo, una factura no se corrige con recibo
--         de devolución, y el recibo de devolución nunca consume control. Variante rota: sin la
--         excepción, el mismo documento vuelve a dar LAD49.
--   M-10. Defensa en la base (LIVA art. 8): una empresa `formal` no emite factura con una línea
--         gravada, ni se le agrega después. `formal` hoy NO se puede declarar (CHECK
--         `company_taxpayer_types_declarable_chk`, P-38): el test lo quita DENTRO de su
--         transacción para ejercer la defensa que espera a que se reabra. Variante rota: sin la
--         guarda, la factura gravada del formal entra.
-- =============================================================================

begin;
select plan(17);
-- El test quita un CHECK y desactiva un trigger dentro de su transacción: que no deje esperando
-- a nadie en la base compartida si no consigue el candado.
set local lock_timeout = '4s';

insert into auth.users (id) values ('aaaa0121-0000-4000-8000-0000000000e1');
insert into public.tenants (id, name) values ('aaaa0121-0000-4000-8000-00000000000a', 'Tenant 121');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code) values
  ('aaaa0121-0000-4000-8000-0000000000a1', 'aaaa0121-0000-4000-8000-00000000000a',
   'V121000019', 'Bodega 121', 'VES');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0121-0000-4000-8000-0000000000b1', 'aaaa0121-0000-4000-8000-00000000000a',
   'aaaa0121-0000-4000-8000-0000000000e1');
insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
select 'aaaa0121-0000-4000-8000-00000000000a', 'aaaa0121-0000-4000-8000-0000000000b1', r.id, null
  from public.roles r where r.key = 'owner' and r.tenant_id is null;
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                              taxpayer_type_code) values
  ('aaaa0121-0000-4000-8000-0000000000c1', 'aaaa0121-0000-4000-8000-00000000000a',
   'aaaa0121-0000-4000-8000-0000000000a1', 'J412100002', 'Cliente 121', 'juridica', 'ordinario');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code) values
  ('aaaa0121-0000-4000-8000-0000000000d1', 'aaaa0121-0000-4000-8000-00000000000a',
   'aaaa0121-0000-4000-8000-0000000000a1', 'P-121-G', 'Gravado 121', 'good', 'active', 'unidad',
   'gravado_general'),
  ('aaaa0121-0000-4000-8000-0000000000d2', 'aaaa0121-0000-4000-8000-00000000000a',
   'aaaa0121-0000-4000-8000-0000000000a1', 'P-121-E', 'Exento 121', 'good', 'active', 'unidad',
   'exento');
-- Vendía con recibos hasta el 1 de junio; desde entonces factura sobre forma libre.
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from,
                                           effective_to)
values ('aaaa0121-0000-4000-8000-0000000000f1', 'aaaa0121-0000-4000-8000-00000000000a',
        'aaaa0121-0000-4000-8000-0000000000a1', 'sin_facturacion', '2026-01-01 00:00-04',
        '2026-06-01 00:00-04'),
       ('aaaa0121-0000-4000-8000-0000000000f2', 'aaaa0121-0000-4000-8000-00000000000a',
        'aaaa0121-0000-4000-8000-0000000000a1', 'formatos_libres', '2026-06-01 00:00-04', null);
insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                           effective_from, reason, rules_version)
values ('aaaa0121-0000-4000-8000-00000000000a', 'aaaa0121-0000-4000-8000-0000000000a1',
        'ordinario', '2026-06-01', 'Declaración del dueño', 'v1');
select set_config('ladino.actor_id', 'aaaa0121-0000-4000-8000-0000000000e1', true);

-- Un documento ya emitido, de un golpe (como el pgTAP 088).
create function pg_temp.emitir(p_id uuid, p_kind text, p_serie text, p_n int, p_control int,
                               p_regimen uuid, p_cuando timestamptz, p_origen uuid) returns void
language sql as $$
  insert into public.documents
    (id, tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
     control_number, regime_version_id, rules_version, source_document_id,
     transaction_currency, functional_currency, fx_rate, rate_source,
     amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
  values (p_id, 'aaaa0121-0000-4000-8000-00000000000a', 'aaaa0121-0000-4000-8000-0000000000a1',
          p_kind, p_serie, 'aaaa0121-0000-4000-8000-0000000000c1', 'issued', p_cuando, p_n,
          p_control, p_regimen, 'test-121', p_origen,
          'VES', 'VES', 1, 'identidad', 100, 100, 100, 0, 100);
$$;

create function pg_temp.linea(p_doc uuid, p_n int, p_producto uuid, p_categoria text) returns void
language sql as $$
  insert into public.document_lines
    (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
     unit_price_transaction, unit_price_functional, tax_rate_snapshot, tax_amount,
     line_subtotal_transaction, line_subtotal_functional,
     line_total_transaction, line_total_functional,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, rounding_policy_id,
     tax_category_snapshot, tax_treatment)
  values ('aaaa0121-0000-4000-8000-00000000000a', 'aaaa0121-0000-4000-8000-0000000000a1',
          p_doc, p_n, p_producto, 'Línea 121', 1, 100, 100,
          case when p_categoria = 'exento' then 0 else 0.16 end,
          case when p_categoria = 'exento' then 0 else 16 end,
          100, 100,
          case when p_categoria = 'exento' then 100 else 116 end,
          case when p_categoria = 'exento' then 100 else 116 end,
          case when p_categoria = 'exento' then 100 else 116 end, 'VES', 1,
          case when p_categoria = 'exento' then 100 else 116 end,
          'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP',
          p_categoria, platform.tax_treatment_of(p_categoria));
$$;
-- Un borrador con UNA línea (gravada o exenta), listo para emitirse: el camino del dominio.
create function pg_temp.borrador(p_id uuid, p_producto uuid, p_categoria text) returns void
language sql as $$
  insert into public.documents
    (id, tenant_id, company_id, kind, series, customer_id, status, rules_version,
     transaction_currency, functional_currency, fx_rate, rate_source,
     amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
  values (p_id, 'aaaa0121-0000-4000-8000-00000000000a', 'aaaa0121-0000-4000-8000-0000000000a1',
          'invoice', 'A', 'aaaa0121-0000-4000-8000-0000000000c1', 'draft', 'test-121',
          'VES', 'VES', 1, 'identidad',
          case when p_categoria = 'exento' then 100 else 116 end,
          case when p_categoria = 'exento' then 100 else 116 end, 100,
          case when p_categoria = 'exento' then 0 else 16 end,
          case when p_categoria = 'exento' then 100 else 116 end);
  select pg_temp.linea(p_id, 1, p_producto, p_categoria);
$$;
create function pg_temp.emitir_borrador(p_id uuid, p_n int, p_cuando timestamptz) returns void
language sql as $$
  update public.documents
     set status = 'issued', issued_at = p_cuando, document_number = p_n, control_number = p_n,
         control_identifier = '00', regime_version_id = 'aaaa0121-0000-4000-8000-0000000000f2'
   where id = p_id;
$$;

-- ── M-12 · el recibo viejo se devuelve con recibo de devolución ──────────────
-- El recibo R-1, de marzo: la empresa todavía vendía con recibos.
select pg_temp.emitir('aaaa0121-0000-4000-8000-000000000101', 'receipt', 'R', 1, null,
                      'aaaa0121-0000-4000-8000-0000000000f1', '2026-03-10 10:00-04', null);

select lives_ok($$ select pg_temp.emitir('aaaa0121-0000-4000-8000-000000000102', 'receipt_return',
                     'D', 1, null, 'aaaa0121-0000-4000-8000-0000000000f2',
                     '2026-07-01 10:00-04', 'aaaa0121-0000-4000-8000-000000000101') $$,
  'M-12: ya facturando, el recibo de marzo se devuelve con recibo de devolución, sin control');

select is((select count(*)::int from public.documents
            where id = 'aaaa0121-0000-4000-8000-000000000102' and kind = 'receipt_return'
              and control_number is null and status = 'issued'), 1,
  'M-12: el recibo de devolución quedó emitido, y sin número de control');

select throws_ok($$ select pg_temp.emitir('aaaa0121-0000-4000-8000-000000000103', 'receipt_return',
                      'D', 2, 77, 'aaaa0121-0000-4000-8000-0000000000f2',
                      '2026-07-01 11:00-04', 'aaaa0121-0000-4000-8000-000000000101') $$,
  'LAD49', null, 'M-12: el recibo de devolución no consume número de control del talonario');

select throws_ok($$ select pg_temp.emitir('aaaa0121-0000-4000-8000-000000000104', 'receipt',
                      'R', 2, null, 'aaaa0121-0000-4000-8000-0000000000f2',
                      '2026-07-01 12:00-04', null) $$,
  'LAD49', null, 'el gate de kind sigue vivo: quien factura no VENDE por recibo');

-- Una factura de julio (ordinario): se corrige con nota de crédito, nunca con recibo de devolución.
select pg_temp.borrador('aaaa0121-0000-4000-8000-000000000105',
                        'aaaa0121-0000-4000-8000-0000000000d1', 'gravado_general');
select lives_ok($$ select pg_temp.emitir_borrador('aaaa0121-0000-4000-8000-000000000105', 1,
                                                   '2026-07-10 10:00-04') $$,
  'el ordinario emite su factura gravada: la guarda del formal no lo toca');
select throws_ok($$ select pg_temp.emitir('aaaa0121-0000-4000-8000-000000000106', 'receipt_return',
                      'D', 3, null, 'aaaa0121-0000-4000-8000-0000000000f2',
                      '2026-07-11 10:00-04', 'aaaa0121-0000-4000-8000-000000000105') $$,
  'LAD49', null, 'una FACTURA no se devuelve con recibo de devolución: la excepción es solo del recibo');

create temp table viva as
  select pg_get_functiondef('platform.assert_document_issuance()'::regprocedure) as def;
-- Sin la excepción del recibo de devolución, el mismo documento vuelve a caer en el gate de kind:
-- el lives_ok de arriba medía la excepción, no otra cosa.
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('platform.assert_document_issuance()'::regprocedure);
  v_def := replace(v_def, 'and not v_devuelve_recibo', '');
  execute v_def;
end $$;
select throws_ok($$ select pg_temp.emitir('aaaa0121-0000-4000-8000-000000000107', 'receipt_return',
                      'D', 4, null, 'aaaa0121-0000-4000-8000-0000000000f2',
                      '2026-07-02 10:00-04', 'aaaa0121-0000-4000-8000-000000000101') $$,
  'LAD49', null, 'SIN la excepción, el recibo de devolución de quien ya factura da LAD49');
-- Se restituye la definición viva (sin savepoint: un rollback borraría la cuenta de pgTAP).
do $$ begin execute (select def from pg_temp.viva); end $$;

-- ── M-10 · el formal no vende una línea gravada (defensa a la espera de P-38) ─
alter table public.company_taxpayer_types drop constraint company_taxpayer_types_declarable_chk;
insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                           effective_from, reason, rules_version)
values ('aaaa0121-0000-4000-8000-00000000000a', 'aaaa0121-0000-4000-8000-0000000000a1',
        'formal', '2026-08-01', 'Solo vende exento', 'v1');

select pg_temp.borrador('aaaa0121-0000-4000-8000-000000000201',
                        'aaaa0121-0000-4000-8000-0000000000d1', 'gravado_general');
select throws_ok($$ select pg_temp.emitir_borrador('aaaa0121-0000-4000-8000-000000000201', 2,
                                                    '2026-08-10 10:00-04') $$,
  'LAD99', null, 'M-10: la factura de un formal con una línea gravada no se emite');
select throws_like($$ select pg_temp.emitir_borrador('aaaa0121-0000-4000-8000-000000000201', 2,
                                                      '2026-08-10 10:00-04') $$,
  '%no puedes vender productos gravados%',
  'M-10: y lo dice con el texto de la respuesta del dueño, no con el de otro rechazo');

select pg_temp.borrador('aaaa0121-0000-4000-8000-000000000202',
                        'aaaa0121-0000-4000-8000-0000000000d2', 'exento');
select lives_ok($$ select pg_temp.emitir_borrador('aaaa0121-0000-4000-8000-000000000202', 3,
                                                   '2026-08-10 11:00-04') $$,
  'M-10: la factura exenta del formal sí se emite');
select throws_ok($$ select pg_temp.linea('aaaa0121-0000-4000-8000-000000000202', 2,
                      'aaaa0121-0000-4000-8000-0000000000d1', 'gravado_general') $$,
  'LAD99', null, 'M-10: a la factura ya emitida de un formal no se le agrega una línea gravada');
-- LAD99 tiene dos significados en el gate (formal y adquirente): se asevera el MENSAJE.
select throws_like($$ select pg_temp.linea('aaaa0121-0000-4000-8000-000000000202', 2,
                        'aaaa0121-0000-4000-8000-0000000000d1', 'gravado_general') $$,
  '%no puedes vender productos gravados%',
  'M-10: y la puerta de la línea lo dice con el texto del formal');
select is((select count(*)::int from public.document_lines
            where document_id = 'aaaa0121-0000-4000-8000-000000000202'), 1,
  'M-10: la factura exenta del formal sigue con su única línea');

-- Variante rota de la SEGUNDA puerta: sin el trigger `document_lines_formal`, la línea gravada
-- entra en la factura ya emitida. Los dos throws de arriba medían ese trigger y no otra defensa.
alter table public.document_lines disable trigger document_lines_formal;
select lives_ok($$ select pg_temp.linea('aaaa0121-0000-4000-8000-000000000202', 2,
                     'aaaa0121-0000-4000-8000-0000000000d1', 'gravado_general') $$,
  'SIN el trigger document_lines_formal, la línea gravada entra en la factura emitida del formal');
alter table public.document_lines enable trigger document_lines_formal;
select throws_like($$ select pg_temp.linea('aaaa0121-0000-4000-8000-000000000202', 3,
                        'aaaa0121-0000-4000-8000-0000000000d1', 'gravado_general') $$,
  '%no puedes vender productos gravados%',
  'con el trigger de vuelta, la línea gravada se rechaza otra vez');

-- Sin la guarda, la factura gravada del formal entra: los throws de arriba medían la guarda.
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('platform.assert_document_issuance()'::regprocedure);
  v_def := replace(v_def, 'v_tipo = ''formal''', 'v_tipo = ''nunca''');
  execute v_def;
end $$;
select lives_ok($$ select pg_temp.emitir_borrador('aaaa0121-0000-4000-8000-000000000201', 2,
                                                   '2026-08-10 10:00-04') $$,
  'SIN la guarda, la factura gravada del formal se emite');
-- Se restituye la definición viva (sin savepoint: un rollback borraría la cuenta de pgTAP).
do $$ begin execute (select def from pg_temp.viva); end $$;
-- Un borrador gravado NUEVO: lo juzga la función restituida (no la puerta de la línea, que mira
-- documentos ya emitidos).
select pg_temp.borrador('aaaa0121-0000-4000-8000-000000000203',
                        'aaaa0121-0000-4000-8000-0000000000d1', 'gravado_general');
select throws_like($$ select pg_temp.emitir_borrador('aaaa0121-0000-4000-8000-000000000203', 4,
                                                      '2026-08-10 12:00-04') $$,
  '%no puedes vender productos gravados%',
  'restituida la definición viva, el gate de emisión vuelve a rechazar la factura gravada del formal');

select * from finish();
rollback;

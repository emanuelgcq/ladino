-- =============================================================================
-- pgTAP 105 · EL MAYOR AL CÉNTIMO, INCLUIDO EL INVENTARIO (ADR-0075 §7 · migración 20261003140000)
--
--   · round_cents es half-up (la mitad lejos del cero) y es LA función del céntimo;
--   · sobre una posición al céntimo, el oráculo rechaza un valor con fracción de céntimo (LAD41) y
--     acepta la salida redondeada al céntimo (valor × q / existencia, tolerancia medio céntimo);
--   · el valor acumulado es la suma de los redondeados, y vaciar saca todo (residuo 0);
--   · I-05 (ADR-0078): un producto INACTIVO admite una salida por vencido; un BORRADOR no;
--   · cent_gaps da cero;
--   · y la VARIANTE ROTA: sin el oráculo, la fracción entra y cent_gaps la ve.
-- =============================================================================
begin;
select plan(12);

insert into auth.users (id) values ('aaaa0103-0000-4000-8000-0000000000aa');
select set_config('ladino.actor_id', 'aaaa0103-0000-4000-8000-0000000000aa', true);
select set_config('ladino.rules_version', 'pgtap-105', true);
insert into public.tenants (id, name) values ('aaaa0103-0000-4000-8000-00000000000a', 'Tenant 103');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa0103-0000-4000-8000-0000000000a1', 'aaaa0103-0000-4000-8000-00000000000a',
        'J-103-A', 'Bodega 103', 'VES', 'ordinario');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0103-0000-4000-8000-0000000000b1', 'aaaa0103-0000-4000-8000-00000000000a',
   'aaaa0103-0000-4000-8000-0000000000a1', 'W103', 'Principal');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code) values
  ('aaaa0103-0000-4000-8000-00000000d001', 'aaaa0103-0000-4000-8000-00000000000a',
   'aaaa0103-0000-4000-8000-0000000000a1', 'SKU-103', 'Harina 103', 'good', 'active', 'unidad',
   'gravado_general'),
  ('aaaa0103-0000-4000-8000-00000000d002', 'aaaa0103-0000-4000-8000-00000000000a',
   'aaaa0103-0000-4000-8000-0000000000a1', 'SKU-103-I', 'Cloro 103', 'good', 'active', 'unidad',
   'gravado_general'),
  ('aaaa0103-0000-4000-8000-00000000d003', 'aaaa0103-0000-4000-8000-00000000000a',
   'aaaa0103-0000-4000-8000-0000000000a1', 'SKU-103-D', 'Borrador 103', 'good', 'draft', 'unidad',
   'gravado_general');

create function pg_temp.mover(p_kind text, p_q numeric, p_val numeric, p_producto uuid,
                              p_motivo text default null)
returns void language sql as $$
  insert into public.inventory_moves
    (tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, rounding_policy_id,
     occurred_at, exit_reason, exit_evidence)
  values ('aaaa0103-0000-4000-8000-00000000000a', 'aaaa0103-0000-4000-8000-0000000000a1',
          'aaaa0103-0000-4000-8000-0000000000b1', p_producto, null, p_kind, p_q,
          p_val, 'VES', 1, p_val, 'VES', 'identidad', now(), 'ledger:cents:2:HALF_UP', now(),
          p_motivo, case when p_motivo is not null then 'acta pgTAP 105' end);
$$;

select is(platform.round_cents(2.345), 2.35, 'round_cents: la mitad sube (half-up)');
select is(platform.round_cents(-2.345), -2.35, 'round_cents: la mitad negativa se aleja del cero, como ROUND_HALF_UP');

select lives_ok($$ select pg_temp.mover('entrada', 3, 100, 'aaaa0103-0000-4000-8000-00000000d001') $$,
  'una entrada al céntimo entra');
select throws_ok($$ select pg_temp.mover('entrada', 1, 10.123, 'aaaa0103-0000-4000-8000-00000000d001') $$,
  'LAD41', null, 'sobre una posición al céntimo, un valor con fracción de céntimo es LAD41');
select throws_ok($$ select pg_temp.mover('salida', -1, -33.33333333, 'aaaa0103-0000-4000-8000-00000000d001') $$,
  'LAD41', null, 'la salida a 8 decimales ya no vale: el valor de la salida va al céntimo');
select lives_ok($$ select pg_temp.mover('salida', -1, -33.33, 'aaaa0103-0000-4000-8000-00000000d001') $$,
  'la salida de 1 de 3 a 100 vale round_cents(33,333…) = 33,33');
select lives_ok($$ select pg_temp.mover('salida', -2, -66.67, 'aaaa0103-0000-4000-8000-00000000d001') $$,
  'vaciar saca TODO el valor que queda (66,67): la suma de los redondeados');
select is((select value from public.stock_balances
            where product_id = 'aaaa0103-0000-4000-8000-00000000d001'), 0::numeric,
  'cantidad 0 con valor 0: ningún céntimo residual');

-- I-05: inactivo = no se vende, no = no existe.
select pg_temp.mover('entrada', 2, 20, 'aaaa0103-0000-4000-8000-00000000d002');
update public.products set status = 'inactive' where id = 'aaaa0103-0000-4000-8000-00000000d002';
select lives_ok($$ select pg_temp.mover('salida', -1, -10, 'aaaa0103-0000-4000-8000-00000000d002', 'vencido') $$,
  'I-05: un producto INACTIVO admite la salida por vencido');
select throws_ok($$ select pg_temp.mover('entrada', 1, 10, 'aaaa0103-0000-4000-8000-00000000d003') $$,
  'LAD38', null, 'I-05, su variante: un BORRADOR sigue sin admitir movimientos');

select is((select count(*) from platform.cent_gaps('aaaa0103-0000-4000-8000-0000000000a1')), 0::bigint,
  'cent_gaps: cero');

-- VARIANTE ROTA: sin el oráculo, la fracción entra y el invariante la ve. Si esto diera cero, el
-- cero de arriba no estaría midiendo nada.
set constraints all immediate;
alter table public.inventory_moves disable trigger inventory_moves_10_apply;
insert into public.inventory_moves
  (tenant_id, company_id, warehouse_id, product_id, kind, quantity, amount_transaction_currency,
   transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
   rate_timestamp, rounding_policy_id, unit_cost, quantity_after, value_after, occurred_at)
values ('aaaa0103-0000-4000-8000-00000000000a', 'aaaa0103-0000-4000-8000-0000000000a1',
        'aaaa0103-0000-4000-8000-0000000000b1', 'aaaa0103-0000-4000-8000-00000000d001', 'entrada',
        1, 10.123, 'VES', 1, 10.123, 'VES', 'identidad', now(), 'pgtap-roto', 10.123, 1, 10.123, now());
select ok((select count(*) from platform.cent_gaps('aaaa0103-0000-4000-8000-0000000000a1')) > 0,
  'variante rota: sin el oráculo la fracción entra y cent_gaps la detecta');

select * from finish();
rollback;

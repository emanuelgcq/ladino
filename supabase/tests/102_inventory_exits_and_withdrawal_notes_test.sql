-- =============================================================================
-- pgTAP 102 · SALIDAS Y RETIROS DE INVENTARIO (ADR-0078 · migración 20261003110000)
--
-- Lo que el esquema garantiza por sí mismo, sin la API delante:
--   · el motivo de una salida es de una lista cerrada y solo vive en salidas (I-01);
--   · la Nota de retiro solo nace de una salida de retiro de SU empresa, una por salida, con
--     correlativo de la base, y no se edita (append-only, R4);
--   · el libro de ventas la lee como venta a la propia empresa;
--   · «por agotarse» suma los lotes y excluye los inactivos (I-12, P-10);
--   · y la VARIANTE ROTA: sin el CHECK, el motivo inventado entra — el primer test mide el CHECK.
-- =============================================================================
begin;
select plan(16);

insert into auth.users (id) values ('aaaa0102-0000-4000-8000-0000000000aa');
select set_config('ladino.actor_id', 'aaaa0102-0000-4000-8000-0000000000aa', true);
select set_config('ladino.rules_version', 'pgtap-102', true);
insert into public.tenants (id, name) values ('aaaa0102-0000-4000-8000-00000000000a', 'Tenant 102');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa0102-0000-4000-8000-0000000000a1', 'aaaa0102-0000-4000-8000-00000000000a',
        'J-102-A', 'Bodega 102', 'VES', 'ordinario');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0102-0000-4000-8000-0000000000b1', 'aaaa0102-0000-4000-8000-00000000000a',
   'aaaa0102-0000-4000-8000-0000000000a1', 'W102', 'Principal');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code) values
  ('aaaa0102-0000-4000-8000-00000000d001', 'aaaa0102-0000-4000-8000-00000000000a',
   'aaaa0102-0000-4000-8000-0000000000a1', 'SKU-102', 'Harina 102', 'good', 'active', 'unidad',
   'gravado_general'),
  ('aaaa0102-0000-4000-8000-00000000d002', 'aaaa0102-0000-4000-8000-00000000000a',
   'aaaa0102-0000-4000-8000-0000000000a1', 'SKU-102-I', 'Cloro 102', 'good', 'active', 'unidad',
   'gravado_general');

-- Un movimiento como lo escribe el dominio: el oráculo del kardex (LAD41) lo verifica.
create function pg_temp.mover(p_id uuid, p_kind text, p_q numeric, p_val numeric,
                              p_q_after numeric, p_v_after numeric, p_motivo text,
                              p_producto uuid default 'aaaa0102-0000-4000-8000-00000000d001')
returns void language sql as $$
  insert into public.inventory_moves
    (id, tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost,
     quantity_after, value_after, occurred_at, exit_reason, exit_evidence)
  values (p_id, 'aaaa0102-0000-4000-8000-00000000000a', 'aaaa0102-0000-4000-8000-0000000000a1',
          'aaaa0102-0000-4000-8000-0000000000b1', p_producto, null, p_kind, p_q,
          p_val, 'VES', 1, p_val, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', 10,
          p_q_after, p_v_after, now(), p_motivo,
          -- La pérdida lleva su soporte (20261003110100, RLIVA art. 14).
          case when p_motivo in ('merma', 'rotura', 'vencido', 'faltante') then 'acta pgTAP' end);
$$;

select lives_ok($$ select pg_temp.mover('aaaa0102-0000-4000-8000-00000000e001', 'entrada',
                                        10, 100, 10, 100, null) $$,
  'una entrada sin motivo de salida entra');
select throws_ok($$ select pg_temp.mover(gen_random_uuid(), 'salida', -1, -10, 9, 90, 'robo') $$,
  '23514', null, 'un motivo fuera de la lista cerrada se rechaza (I-01)');
select throws_ok($$ select pg_temp.mover(gen_random_uuid(), 'entrada', 1, 10, 11, 110, 'merma') $$,
  '23514', null, 'el motivo de salida no vive en una entrada');
select lives_ok($$ select pg_temp.mover('aaaa0102-0000-4000-8000-00000000e002', 'salida',
                                        -2, -20, 8, 80, 'merma') $$,
  'la salida por merma entra con su motivo');
select lives_ok($$ select pg_temp.mover('aaaa0102-0000-4000-8000-00000000e003', 'salida',
                                        -1, -10, 7, 70, 'consumo_propio') $$,
  'la salida por consumo propio entra con su motivo');

create function pg_temp.nota(p_move uuid, p_motivo text) returns void language sql as $$
  insert into public.inventory_withdrawal_notes
    (tenant_id, company_id, note_number, move_id, warehouse_id, product_id, quantity, exit_reason,
     price_list_id, list_unit_price, list_currency, fx_rate, rate_source, base_functional,
     tax_category_snapshot, tax_treatment, tax_rate_snapshot, tax_functional,
     functional_currency, rules_version)
  values ('aaaa0102-0000-4000-8000-00000000000a', 'aaaa0102-0000-4000-8000-0000000000a1', 0,
          p_move, 'aaaa0102-0000-4000-8000-0000000000b1', 'aaaa0102-0000-4000-8000-00000000d001',
          1, p_motivo, gen_random_uuid(), 100, 'VES', 1, 'identidad', 100, 'gravado_general',
          'gravado', 0.16, 16, 'VES', 'pgtap-102');
$$;

select lives_ok($$ select pg_temp.nota('aaaa0102-0000-4000-8000-00000000e003', 'consumo_propio') $$,
  'la Nota de retiro de una salida de retiro entra');
select is((select note_number from public.inventory_withdrawal_notes
            where move_id = 'aaaa0102-0000-4000-8000-00000000e003'), 1::bigint,
  'el correlativo lo pone la base (se mandó 0, quedó 1)');
select throws_ok($$ select pg_temp.nota('aaaa0102-0000-4000-8000-00000000e002', 'merma') $$,
  '23514', null, 'una merma no emite Nota de retiro');
select throws_ok($$ select pg_temp.nota('aaaa0102-0000-4000-8000-00000000e003', 'consumo_propio') $$,
  '23505', null, 'una salida, una nota');
select throws_ok($$ update public.inventory_withdrawal_notes set base_functional = 0
                     where move_id = 'aaaa0102-0000-4000-8000-00000000e003' $$,
  null, null, 'la Nota de retiro no se edita (append-only)');
select is((select kind || '·' || customer_tax_id || '·' || iva_debito::text
             from platform.sales_book('aaaa0102-0000-4000-8000-0000000000a1',
                                      current_date - 3, current_date + 3)),
  'withdrawal_note·J-102-A·16.00000000',
  'el libro de ventas lee la nota como venta a la propia empresa');

-- AISLAMIENTO como ladino_api (ADR-0031): el usuario de OTRO tenant no lee ni inserta notas de A;
-- el usuario de los DOS tenants (el atacante realista, y el caso central) sí ve las de A.
insert into auth.users (id) values ('aaaa0102-0000-4000-8000-0000000000bb'), ('aaaa0102-0000-4000-8000-0000000000cc');
insert into public.tenants (id, name) values ('aaaa0102-0000-4000-8000-00000000000b', 'Tenant 102 B');
insert into public.memberships (id, tenant_id, user_id) values
  (gen_random_uuid(), 'aaaa0102-0000-4000-8000-00000000000b', 'aaaa0102-0000-4000-8000-0000000000bb'),
  (gen_random_uuid(), 'aaaa0102-0000-4000-8000-00000000000b', 'aaaa0102-0000-4000-8000-0000000000cc'),
  (gen_random_uuid(), 'aaaa0102-0000-4000-8000-00000000000a', 'aaaa0102-0000-4000-8000-0000000000cc');
select set_config('ladino.actor_id', 'aaaa0102-0000-4000-8000-0000000000bb', true);
-- Una salida de retiro de A sin nota: el trigger la acepta y lo que decide es la RLS.
select pg_temp.mover('aaaa0102-0000-4000-8000-00000000e004', 'salida', -1, -10, 6, 60, 'consumo_propio');
set local role ladino_api;
select is((select count(*)::int from public.inventory_withdrawal_notes), 0,
  'ladino_api con un actor de OTRO tenant no lee las notas de A');
select throws_ok($$ select pg_temp.nota('aaaa0102-0000-4000-8000-00000000e004', 'consumo_propio') $$,
  '42501', null, 'ni inserta una nota en A');
reset role;
select set_config('ladino.actor_id', 'aaaa0102-0000-4000-8000-0000000000cc', true);
set local role ladino_api;
select is((select count(*)::int from public.inventory_withdrawal_notes
            where company_id = 'aaaa0102-0000-4000-8000-0000000000a1'), 1,
  'el usuario de los dos tenants sí ve la nota de A (el camino autorizado vive)');
reset role;
select set_config('ladino.actor_id', 'aaaa0102-0000-4000-8000-0000000000aa', true);

-- «Por agotarse»: un mínimo de 20 sobre 7 en el Principal; inactivo, no cuenta.
insert into public.product_stock_thresholds (tenant_id, company_id, warehouse_id, product_id, stock_min)
values ('aaaa0102-0000-4000-8000-00000000000a', 'aaaa0102-0000-4000-8000-0000000000a1',
        'aaaa0102-0000-4000-8000-0000000000b1', 'aaaa0102-0000-4000-8000-00000000d002', 5);
update public.products set status = 'inactive' where id = 'aaaa0102-0000-4000-8000-00000000d002';
select is((select count(*)::int from platform.low_stock_products('aaaa0102-0000-4000-8000-0000000000a1')),
  0, 'un producto inactivo no está «por agotarse» (I-12)');

-- VARIANTE ROTA: sin el CHECK, el motivo inventado entra. Si no entrara, el test 2 estaría
-- pasando por otro motivo y no mediría el CHECK.
-- Los constraint triggers diferidos del kardex (LAD40) se resuelven antes del ALTER.
set constraints all immediate;
alter table public.inventory_moves drop constraint inventory_moves_exit_reason_chk;
select lives_ok($$ select pg_temp.mover(gen_random_uuid(), 'salida', -1, -10, 5, 50, 'robo') $$,
  'VARIANTE ROTA: sin inventory_moves_exit_reason_chk el motivo inventado entra');

select * from finish();
rollback;

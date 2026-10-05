-- =============================================================================
-- pgTAP 103 · NOTA DE RETIRO: adquirente congelado e invariante (20261003110100, ADR-0078)
--
--   · cambiar el RIF o el nombre de la empresa NO reescribe el renglón de una nota ya emitida;
--   · `withdrawal_note_gaps()` da CERO en el estado correcto y señala cada estado roto: el retiro
--     sin nota de una empresa que factura, y la nota con IVA sin ese IVA en su asiento (ni en cola).
-- =============================================================================
begin;
select plan(7);

-- ENTRADA del fixture (20261005100000, ADR-0082): este fichero prueba la Nota de retiro (serie NR),
-- que desde el corte `withdrawal_invoice` ya no cubre un retiro —lo cubre su FACTURA de retiro
-- (pgTAP 134)—. Aquí el corte se lleva al futuro dentro de la transacción de prueba, para que los
-- retiros del fixture sean ANTERIORES al corte: el enunciado (2) de withdrawal_note_gaps, que es
-- el que sigue vigilando las notas ya emitidas. Ninguna aserción cambia.
update platform.invariant_cutoffs set since = now() + interval '1 day'
 where invariant = 'withdrawal_invoice';

insert into auth.users (id) values ('aaaa0103-0000-4000-8000-0000000000aa');
select set_config('ladino.actor_id', 'aaaa0103-0000-4000-8000-0000000000aa', true);
select set_config('ladino.rules_version', 'pgtap-103', true);
insert into public.tenants (id, name) values ('aaaa0103-0000-4000-8000-00000000000a', 'Tenant 103');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa0103-0000-4000-8000-0000000000a1', 'aaaa0103-0000-4000-8000-00000000000a',
        'J-103-A', 'Bodega 103 original', 'VES', 'ordinario');
insert into public.company_fiscal_regimes (tenant_id, company_id, regime_code, effective_from)
values ('aaaa0103-0000-4000-8000-00000000000a', 'aaaa0103-0000-4000-8000-0000000000a1',
        'formatos_libres', '2026-01-01');
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, reason, rules_version)
values ('aaaa0103-0000-4000-8000-00000000000a', 'aaaa0103-0000-4000-8000-0000000000a1',
        'ordinario', '2000-01-01', 'pgTAP 103', 'pgtap');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0103-0000-4000-8000-0000000000b1', 'aaaa0103-0000-4000-8000-00000000000a',
   'aaaa0103-0000-4000-8000-0000000000a1', 'W103', 'Principal');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code) values
  ('aaaa0103-0000-4000-8000-00000000d001', 'aaaa0103-0000-4000-8000-00000000000a',
   'aaaa0103-0000-4000-8000-0000000000a1', 'SKU-103', 'Harina 103', 'good', 'active', 'unidad',
   'gravado_general');

create function pg_temp.mover(p_id uuid, p_kind text, p_q numeric, p_val numeric,
                              p_q_after numeric, p_v_after numeric, p_motivo text)
returns void language sql as $$
  insert into public.inventory_moves
    (id, tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost,
     quantity_after, value_after, occurred_at, exit_reason)
  values (p_id, 'aaaa0103-0000-4000-8000-00000000000a', 'aaaa0103-0000-4000-8000-0000000000a1',
          'aaaa0103-0000-4000-8000-0000000000b1', 'aaaa0103-0000-4000-8000-00000000d001', null,
          p_kind, p_q, p_val, 'VES', 1, p_val, 'VES', 'identidad', now(),
          'inventory:cost:8:HALF_UP', 10, p_q_after, p_v_after, now(), p_motivo);
$$;
create function pg_temp.nota(p_move uuid, p_motivo text, p_iva numeric) returns void
language sql as $$
  insert into public.inventory_withdrawal_notes
    (tenant_id, company_id, note_number, move_id, warehouse_id, product_id, quantity, exit_reason,
     price_list_id, list_unit_price, list_currency, fx_rate, rate_source, base_functional,
     tax_category_snapshot, tax_treatment, tax_rate_snapshot, tax_functional,
     functional_currency, rules_version)
  values ('aaaa0103-0000-4000-8000-00000000000a', 'aaaa0103-0000-4000-8000-0000000000a1', 0,
          p_move, 'aaaa0103-0000-4000-8000-0000000000b1', 'aaaa0103-0000-4000-8000-00000000d001',
          1, p_motivo, gen_random_uuid(), 100, 'VES', 1, 'identidad', 100, 'gravado_general',
          'gravado', case when p_iva = 0 then 0 else 0.16 end, p_iva, 'VES', 'pgtap-103');
$$;

select pg_temp.mover('aaaa0103-0000-4000-8000-00000000e001', 'entrada', 10, 100, 10, 100, null);
select pg_temp.mover('aaaa0103-0000-4000-8000-00000000e002', 'salida', -1, -10, 9, 90,
                     'consumo_propio');

-- ROTO 1: el retiro de una empresa que factura, sin su nota.
select is((select string_agg(problem, ',') from platform.withdrawal_note_gaps(
             'aaaa0103-0000-4000-8000-0000000000a1')),
  'retiro_sin_nota', 'un retiro sin nota en una empresa que factura es un hueco');

-- CORRECTO: con su nota (sin IVA que asentar), cero.
select pg_temp.nota('aaaa0103-0000-4000-8000-00000000e002', 'consumo_propio', 0);
select is((select count(*)::int from platform.withdrawal_note_gaps(
             'aaaa0103-0000-4000-8000-0000000000a1')),
  0, 'con su nota, withdrawal_note_gaps da cero');

-- ROTO 2: una nota con IVA cuyo asiento no lo lleva al débito fiscal (ni está en cola).
select pg_temp.mover('aaaa0103-0000-4000-8000-00000000e003', 'salida', -1, -10, 8, 80, 'regalo');
select pg_temp.nota('aaaa0103-0000-4000-8000-00000000e003', 'regalo', 16);
select is((select string_agg(problem, ',') from platform.withdrawal_note_gaps(
             'aaaa0103-0000-4000-8000-0000000000a1')),
  'nota_sin_iva_en_el_asiento', 'una nota con IVA sin su débito en el asiento es un hueco');

-- EL ADQUIRENTE CONGELADO.
select is((select company_tax_id_snapshot || '·' || company_name_snapshot
             from public.inventory_withdrawal_notes
            where move_id = 'aaaa0103-0000-4000-8000-00000000e002'),
  'J-103-A·Bodega 103 original', 'el trigger congela el RIF y el nombre al emitir');
-- Sin actor (como una migración): el guardián del RIF (company.tax_id.manage) es de otra prueba.
select set_config('ladino.actor_id', '', true);
update public.companies set tax_id = 'J-103-B', legal_name = 'Bodega 103 renombrada'
 where id = 'aaaa0103-0000-4000-8000-0000000000a1';
select is((select string_agg(distinct customer_tax_id, ',')
             from platform.sales_book('aaaa0103-0000-4000-8000-0000000000a1',
                                      current_date - 3, current_date + 3)),
  'J-103-A', 'cambiar el RIF de la empresa no reescribe el renglón de la nota');
select is((select string_agg(distinct customer_name, ',')
             from platform.sales_book('aaaa0103-0000-4000-8000-0000000000a1',
                                      current_date - 3, current_date + 3)),
  'Bodega 103 original', 'ni cambiar su nombre');
select throws_ok($$ update public.inventory_withdrawal_notes set company_tax_id_snapshot = 'X'
                     where move_id = 'aaaa0103-0000-4000-8000-00000000e002' $$,
  null, null, 'el snapshot no se edita: la nota sigue siendo append-only tras el backfill');

select * from finish();
rollback;

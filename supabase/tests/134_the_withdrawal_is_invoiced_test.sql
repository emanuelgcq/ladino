-- =============================================================================
-- pgTAP 134 · EL RETIRO DE INVENTARIO SE FACTURA (ADR-0082; migraciones 20261005100000,
-- 20261005100100 y 20261005100200)
--
-- Qué fija, con datos puestos a mano (el camino entero lo ejerce el E2E e2e-salidas-inventario):
--   · `withdrawal_note_gaps()`: desde el corte, un retiro gravado sin su FACTURA es un hueco, y con
--     ella da cero; una factura de retiro con IVA sin su débito en el asiento es otro hueco;
--   · la forma del documento, por SQLSTATE: adquirente = emisor (LAD72), la salida que documenta
--     (LAD72, al confirmar), nunca `paid` (23514), la salida congelada (LAD06), una salida una
--     factura (23505), sin cobro, sin devolución y sin nota (LAD72);
--   · el correlativo compartido con la factura: `claim_document_number` cuenta los dos kinds, y el
--     índice que los cruza rechaza el número repetido (23505);
--   · la deuda: una factura de retiro emitida, sin cobrar, no es deuda de nadie.
-- Cada defensa lleva su variante rota: sin ella, el caso malo pasa (o falla por otro motivo).
-- =============================================================================
begin;
select plan(33);

insert into auth.users (id) values ('aaaa0134-0000-4000-8000-0000000000aa');
select set_config('ladino.actor_id', 'aaaa0134-0000-4000-8000-0000000000aa', true);
select set_config('ladino.rules_version', 'domain-s0.5', true);
insert into public.tenants (id, name) values ('aaaa0134-0000-4000-8000-00000000000a', 'Tenant 134');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa0134-0000-4000-8000-0000000000a1', 'aaaa0134-0000-4000-8000-00000000000a',
        'J-134-A', 'Bodega 134', 'VES', 'ordinario');
insert into public.company_fiscal_regimes (tenant_id, company_id, regime_code, effective_from)
values ('aaaa0134-0000-4000-8000-00000000000a', 'aaaa0134-0000-4000-8000-0000000000a1',
        'formatos_libres', '2026-01-01');
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, reason, rules_version)
values ('aaaa0134-0000-4000-8000-00000000000a', 'aaaa0134-0000-4000-8000-0000000000a1',
        'ordinario', '2000-01-01', 'pgTAP 134', 'pgtap');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0134-0000-4000-8000-0000000000b1', 'aaaa0134-0000-4000-8000-00000000000a',
   'aaaa0134-0000-4000-8000-0000000000a1', 'W134', 'Principal');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code) values
  ('aaaa0134-0000-4000-8000-00000000d001', 'aaaa0134-0000-4000-8000-00000000000a',
   'aaaa0134-0000-4000-8000-0000000000a1', 'SKU-134', 'Harina 134', 'good', 'active', 'unidad',
   'gravado_general');
-- La ficha del adquirente: la propia empresa. Y un tercero, para el caso malo.
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                              taxpayer_type_code) values
  ('aaaa0134-0000-4000-8000-00000000c001', 'aaaa0134-0000-4000-8000-00000000000a',
   'aaaa0134-0000-4000-8000-0000000000a1', 'J-134-A', 'Bodega 134', 'juridica', 'ordinario'),
  ('aaaa0134-0000-4000-8000-00000000c002', 'aaaa0134-0000-4000-8000-00000000000a',
   'aaaa0134-0000-4000-8000-0000000000a1', 'J-134-TERCERO', 'Un tercero', 'juridica',
   'ordinario');

create function pg_temp.mover(p_id uuid, p_kind text, p_q numeric, p_val numeric,
                              p_q_after numeric, p_v_after numeric, p_motivo text, p_doc uuid)
returns void language sql as $$
  insert into public.inventory_moves
    (id, tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost,
     quantity_after, value_after, occurred_at, exit_reason, source_document_id)
  values (p_id, 'aaaa0134-0000-4000-8000-00000000000a', 'aaaa0134-0000-4000-8000-0000000000a1',
          'aaaa0134-0000-4000-8000-0000000000b1', 'aaaa0134-0000-4000-8000-00000000d001', null,
          p_kind, p_q, p_val, 'VES', 1, p_val, 'VES', 'identidad', now(),
          'inventory:cost:8:HALF_UP', 10, p_q_after, p_v_after, now(), p_motivo, p_doc);
$$;
-- Un documento en borrador, con el adquirente que se le diga congelado.
create function pg_temp.borrador(p_id uuid, p_kind text, p_customer uuid, p_rif text,
                                 p_nombre text, p_iva numeric, p_origen uuid) returns void
language sql as $$
  insert into public.documents
    (id, tenant_id, company_id, kind, series, customer_id, source_document_id,
     transaction_currency, functional_currency, amount_transaction_currency, functional_amount,
     subtotal_amount, tax_amount, total_amount, customer_name_snapshot,
     customer_tax_id_snapshot, customer_taxpayer_type_snapshot, issuer_name_snapshot,
     issuer_tax_id_snapshot)
  values (p_id, 'aaaa0134-0000-4000-8000-00000000000a', 'aaaa0134-0000-4000-8000-0000000000a1',
          p_kind, 'A', p_customer, p_origen, 'VES', 'VES', 100 + p_iva, 100 + p_iva, 100, p_iva,
          100 + p_iva, p_nombre, p_rif, 'ordinario', 'Bodega 134', 'J134A');
$$;
create function pg_temp.emitir(p_id uuid, p_numero bigint, p_control bigint, p_move uuid)
returns void language sql as $$
  update public.documents
     set status = 'issued', issued_at = now(), document_number = p_numero,
         control_number = p_control, control_identifier = '00',
         regime_version_id = (select r.regime_version_id
                                from platform.regime_at('aaaa0134-0000-4000-8000-0000000000a1',
                                                        now()) r),
         rules_version = 'domain-s0.5', withdrawal_move_id = p_move
   where id = p_id;
$$;

-- El SQLSTATE con el que muere una sentencia ('ok' si vive): para las variantes rotas.
create function pg_temp.sqlstate_de(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end $$;

select pg_temp.mover('aaaa0134-0000-4000-8000-00000000e001', 'entrada', 10, 100, 10, 100, null,
                     null);
-- La factura nace en borrador, la salida la señala, y entonces se emite.
select pg_temp.borrador('aaaa0134-0000-4000-8000-00000000f001', 'withdrawal_invoice',
                        'aaaa0134-0000-4000-8000-00000000c001', 'J134A', 'Bodega 134', 0, null);
select pg_temp.mover('aaaa0134-0000-4000-8000-00000000e002', 'salida', -1, -10, 9, 90,
                     'consumo_propio', 'aaaa0134-0000-4000-8000-00000000f001');

-- ── 1. El invariante: retiro ⇒ factura de retiro ────────────────────────────
-- ROTO: el retiro existe y su factura sigue en borrador.
select is((select string_agg(problem, ',') from platform.withdrawal_note_gaps(
             'aaaa0134-0000-4000-8000-0000000000a1')),
  'retiro_sin_factura', 'desde el corte, un retiro gravado sin su factura emitida es un hueco');

-- Una Nota de retiro (serie NR) ya NO lo cubre.
insert into public.inventory_withdrawal_notes
  (tenant_id, company_id, note_number, move_id, warehouse_id, product_id, quantity, exit_reason,
   price_list_id, list_unit_price, list_currency, fx_rate, rate_source, base_functional,
   tax_category_snapshot, tax_treatment, tax_rate_snapshot, tax_functional,
   functional_currency, rules_version)
values ('aaaa0134-0000-4000-8000-00000000000a', 'aaaa0134-0000-4000-8000-0000000000a1', 0,
        'aaaa0134-0000-4000-8000-00000000e002', 'aaaa0134-0000-4000-8000-0000000000b1',
        'aaaa0134-0000-4000-8000-00000000d001', 1, 'consumo_propio', gen_random_uuid(), 100,
        'VES', 1, 'identidad', 100, 'gravado_general', 'gravado', 0, 0, 'VES', 'domain-s0.5');
select is((select string_agg(problem, ',') from platform.withdrawal_note_gaps(
             'aaaa0134-0000-4000-8000-0000000000a1')),
  'retiro_sin_factura', 'una Nota de retiro NR no cubre un retiro posterior al corte');

-- ── 2. La forma: el adquirente es la propia empresa ─────────────────────────
select pg_temp.borrador('aaaa0134-0000-4000-8000-00000000f002', 'withdrawal_invoice',
                        'aaaa0134-0000-4000-8000-00000000c002', 'J134TERCERO', 'Un tercero', 0,
                        null);
select throws_ok(
  $$ select pg_temp.emitir('aaaa0134-0000-4000-8000-00000000f002', 9, 9,
                           'aaaa0134-0000-4000-8000-00000000e002') $$,
  'LAD72', null, 'una factura de retiro a nombre de un tercero no se emite');

-- CORRECTO: se emite a nombre de la empresa.
select lives_ok(
  $$ select pg_temp.emitir('aaaa0134-0000-4000-8000-00000000f001', 1, 1,
                           'aaaa0134-0000-4000-8000-00000000e002') $$,
  'la factura de retiro a nombre de la propia empresa se emite');
select lives_ok($$ set constraints all immediate $$,
  'y al confirmar, la salida que documenta es un retiro de la empresa que la señala');
set constraints all deferred;
select is((select count(*)::int from platform.withdrawal_note_gaps(
             'aaaa0134-0000-4000-8000-0000000000a1')),
  0, 'con su factura de retiro emitida, withdrawal_note_gaps da cero');

-- EL CORTE QUE FALTA HACE RUIDO (20261005100800). El invariante lee su corte de
-- platform.invariant_cutoffs; sin esa fila, un producto cartesiano contra cero filas daba un cero
-- falso. Ahora lo dice, con nombre. (Se quita y se repone dentro de la transacción del test.)
create temp table corte_134 as
  select * from platform.invariant_cutoffs where invariant = 'withdrawal_invoice';
delete from platform.invariant_cutoffs where invariant = 'withdrawal_invoice';
select is((select string_agg(problem, ',' order by problem) from platform.withdrawal_note_gaps(
             'aaaa0134-0000-4000-8000-0000000000a1')),
  'falta_el_corte', 'sin la fila del corte, withdrawal_note_gaps NO calla: falta_el_corte');
insert into platform.invariant_cutoffs select * from corte_134;
select is((select count(*)::int from platform.withdrawal_note_gaps(
             'aaaa0134-0000-4000-8000-0000000000a1')),
  0, 'y con el corte de vuelta, cero otra vez: la fila de arriba la daba la falta del corte');

-- ── 3. La salida que documenta, al confirmar ────────────────────────────────
-- Una merma no es un retiro gravado: una factura de retiro no puede documentarla.
select pg_temp.mover('aaaa0134-0000-4000-8000-00000000e003', 'salida', -1, -10, 8, 80, 'regalo',
                     null);
select pg_temp.borrador('aaaa0134-0000-4000-8000-00000000f003', 'withdrawal_invoice',
                        'aaaa0134-0000-4000-8000-00000000c001', 'J134A', 'Bodega 134', 0, null);
select throws_ok(
  $$ do $do$ begin
       perform pg_temp.emitir('aaaa0134-0000-4000-8000-00000000f003', 2, 2,
                              'aaaa0134-0000-4000-8000-00000000e003');
       set constraints all immediate;
     end $do$ $$,
  'LAD72', null,
  'una factura de retiro cuya salida NO la señala como su documento no llega a confirmarse');
-- Desde 20261005100960 `withdrawal_move_id` no tiene clave foránea: lo que la FK daba lo da ESTE
-- trigger. Los dos casos que la FK (y su tenant) habrían cortado, ejercidos contra él:
-- (a) una salida que no existe;
select throws_ok(
  $$ do $do$ begin
       perform pg_temp.emitir('aaaa0134-0000-4000-8000-00000000f003', 2, 2,
                              'aaaa0134-0000-4000-8000-00000000eeee');
       set constraints all immediate;
     end $do$ $$,
  'LAD72', null, 'una factura de retiro cuya salida NO EXISTE no llega a confirmarse');
-- (b) una salida de retiro gravado de OTRA empresa (otro tenant), que además la señala.
insert into public.tenants (id, name) values ('bbbb0134-0000-4000-8000-00000000000b', 'Tenant 134 B');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('bbbb0134-0000-4000-8000-0000000000b1', 'bbbb0134-0000-4000-8000-00000000000b',
        'J-134-B', 'Otra bodega 134', 'VES', 'ordinario');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('bbbb0134-0000-4000-8000-0000000000b2', 'bbbb0134-0000-4000-8000-00000000000b',
   'bbbb0134-0000-4000-8000-0000000000b1', 'W134B', 'Principal B');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code) values
  ('bbbb0134-0000-4000-8000-00000000d00b', 'bbbb0134-0000-4000-8000-00000000000b',
   'bbbb0134-0000-4000-8000-0000000000b1', 'SKU-134-B', 'Harina 134 B', 'good', 'active',
   'unidad', 'gravado_general');
insert into public.inventory_moves
  (id, tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost,
   quantity_after, value_after, occurred_at, exit_reason, source_document_id)
values
  ('bbbb0134-0000-4000-8000-00000000e00a', 'bbbb0134-0000-4000-8000-00000000000b',
   'bbbb0134-0000-4000-8000-0000000000b1', 'bbbb0134-0000-4000-8000-0000000000b2',
   'bbbb0134-0000-4000-8000-00000000d00b', null, 'entrada', 10, 100, 'VES', 1, 100, 'VES',
   'identidad', now(), 'inventory:cost:8:HALF_UP', 10, 10, 100, now(), null, null);
insert into public.inventory_moves
  (id, tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost,
   quantity_after, value_after, occurred_at, exit_reason, source_document_id)
values
  ('bbbb0134-0000-4000-8000-00000000e00b', 'bbbb0134-0000-4000-8000-00000000000b',
   'bbbb0134-0000-4000-8000-0000000000b1', 'bbbb0134-0000-4000-8000-0000000000b2',
   'bbbb0134-0000-4000-8000-00000000d00b', null, 'salida', -1, -10, 'VES', 1, -10, 'VES',
   'identidad', now(), 'inventory:cost:8:HALF_UP', 10, 9, 90, now(), 'regalo',
   'aaaa0134-0000-4000-8000-00000000f003');
select throws_ok(
  $$ do $do$ begin
       perform pg_temp.emitir('aaaa0134-0000-4000-8000-00000000f003', 2, 2,
                              'bbbb0134-0000-4000-8000-00000000e00b');
       set constraints all immediate;
     end $do$ $$,
  'LAD72', null,
  'una factura de retiro cuya salida es de OTRA empresa no llega a confirmarse, aunque la señale');

-- ── 4. Sin cartera ──────────────────────────────────────────────────────────
select throws_ok(
  $$ update public.documents set status = 'paid'
      where id = 'aaaa0134-0000-4000-8000-00000000f001' $$,
  '23514', null, 'una factura de retiro nunca queda «pagada»: no hay cuenta por cobrar');
select throws_ok(
  $$ insert into public.payments (document_id)
     values ('aaaa0134-0000-4000-8000-00000000f001') $$,
  'LAD72', null, 'una factura de retiro no admite un cobro');
-- VARIANTE ROTA: sin el trigger, el mismo INSERT ya no muere por LAD72 (muere por lo que le
-- falta a la fila): el rechazo de arriba lo daba el trigger y no otra cosa.
alter table public.payments disable trigger payments_05_no_withdrawal_invoice;
select isnt(
  (select pg_temp.sqlstate_de($$ insert into public.payments (document_id)
                                 values ('aaaa0134-0000-4000-8000-00000000f001') $$)),
  'LAD72', 'sin el trigger, el cobro ya no se rechaza por LAD72: la aserción anterior lo medía');
alter table public.payments enable trigger payments_05_no_withdrawal_invoice;
select throws_ok(
  $$ insert into public.returns (source_document_id)
     values ('aaaa0134-0000-4000-8000-00000000f001') $$,
  'LAD72', null, 'una factura de retiro no admite una devolución');
-- LO PERMITIDO, EJERCIDO (20261005100300): la guarda no puede cerrar el cobro ni la devolución de
-- los DEMÁS documentos. La primera versión los rompía todos con 42703 (la función compartida
-- nombraba una columna de la otra tabla). Sobre un documento que no es factura de retiro, el
-- INSERT pasa la guarda: muere después, por lo que a esta fila mínima le falta, nunca por ella.
select pg_temp.borrador('aaaa0134-0000-4000-8000-00000000f006', 'invoice',
                        'aaaa0134-0000-4000-8000-00000000c002', 'J134TERCERO', 'Un tercero', 0,
                        null);
select ok(
  (select pg_temp.sqlstate_de($$ insert into public.payments (document_id)
                                 values ('aaaa0134-0000-4000-8000-00000000f006') $$))
    not in ('LAD72', '42703', 'ok'),
  'el cobro de un documento que no es factura de retiro pasa la guarda');
select ok(
  (select pg_temp.sqlstate_de($$ insert into public.returns (source_document_id)
                                 values ('aaaa0134-0000-4000-8000-00000000f006') $$))
    not in ('LAD72', '42703', 'ok'),
  'la devolución de un documento que no es factura de retiro pasa la guarda');
select throws_ok(
  $$ select pg_temp.borrador('aaaa0134-0000-4000-8000-00000000f004', 'credit_note',
                             'aaaa0134-0000-4000-8000-00000000c001', 'J134A', 'Bodega 134', 0,
                             'aaaa0134-0000-4000-8000-00000000f001') $$,
  'LAD72', null, 'la nota de crédito GENERAL sobre una factura de retiro falla activamente: se corrige con la suya (134b)');
select is((select coalesce(platform.customer_debt_today(
                             'aaaa0134-0000-4000-8000-0000000000a1'), 0)),
  0::numeric, 'una factura de retiro emitida y sin cobrar no es deuda de nadie');
select is((select count(*)::int from platform.ar_aging('aaaa0134-0000-4000-8000-0000000000a1')),
  0, 'ni aparece en la antigüedad de la cartera');

-- ── 5. Congelada y única ────────────────────────────────────────────────────
select throws_ok(
  $$ update public.documents set withdrawal_move_id = 'aaaa0134-0000-4000-8000-00000000e003'
      where id = 'aaaa0134-0000-4000-8000-00000000f001' $$,
  'LAD06', null, 'la salida que documenta una factura de retiro emitida no se cambia');
select throws_ok(
  $$ update public.documents set withdrawal_move_id = 'aaaa0134-0000-4000-8000-00000000e002'
      where id = 'aaaa0134-0000-4000-8000-00000000f003' $$,
  '23505', null, 'una salida, una factura de retiro: la segunda muere en el único');
select throws_ok(
  $$ insert into public.documents
       (tenant_id, company_id, kind, series, customer_id, transaction_currency,
        functional_currency, withdrawal_move_id)
     values ('aaaa0134-0000-4000-8000-00000000000a', 'aaaa0134-0000-4000-8000-0000000000a1',
             'invoice', 'A', 'aaaa0134-0000-4000-8000-00000000c002', 'VES', 'VES',
             'aaaa0134-0000-4000-8000-00000000e003') $$,
  '23514', null, 'solo una factura de retiro lleva la salida de un retiro');

-- ── 6. El correlativo compartido con la factura ─────────────────────────────
-- EL COSTE (20261005100700). La numeración de TODO documento busca el último correlativo con el
-- candado de la serie tomado: tiene que ser un salto por índice. 20261005100100 lo había
-- convertido en un recorrido de todos los documentos de la empresa en la serie (un CASE sobre
-- `kind` como filtro) y ningún test lo vio, porque todos miraban el NÚMERO. Aquí se lee el cuerpo
-- VIVO de la función, se saca cada consulta del máximo y se le pide el plan. Con el recorrido
-- secuencial y el de mapa de bits apagados (para que no dependa del tamaño de la tabla), una
-- consulta bien escrita no lleva filtro: todo lo que pide está en la condición del índice.
create function pg_temp.planes_del_maximo() returns table (n int, indice text, plan text)
language plpgsql as $fn$
declare
  v_sql text; i int := 0; v_plan json;
begin
  set local enable_seqscan = off;
  set local enable_bitmapscan = off;
  for v_sql in
    select m[1] from regexp_matches(
      (select p.prosrc from pg_proc p
        where p.oid = 'platform.claim_document_number(uuid,text,text)'::regprocedure),
      '(select coalesce\(max\(d\.document_number\).*?);', 'g') m
  loop
    i := i + 1;
    v_sql := replace(replace(replace(replace(v_sql, 'into v_next', ''),
               'p_company', '''aaaa0134-0000-4000-8000-0000000000a1''::uuid'),
               'p_series', '''A'''), 'p_kind', '''receipt''');
    begin
      execute 'explain (format json, costs off) ' || v_sql into v_plan;
      plan := v_plan::text;
    exception when others then
      -- Una consulta que ya no se puede planificar sola (lee una variable de la función) no es
      -- un salto por índice demostrable: cuenta como rota, con su motivo.
      plan := 'NO SE PUDO PLANIFICAR: ' || sqlerrm;
    end;
    n := i;
    indice := substring(plan from '"Index Name": "([a-z_]+)"');
    return next;
  end loop;
  reset enable_seqscan;
  reset enable_bitmapscan;
end $fn$;
select is((select count(*)::int from pg_temp.planes_del_maximo()), 3,
  'claim_document_number busca el máximo con tres consultas estáticas: facturas, notas de crédito y el resto');
select is(
  (select string_agg(coalesce(indice, '(ninguno)'), ',' order by n) from pg_temp.planes_del_maximo()),
  'documents_invoice_number_uidx,documents_credit_note_number_uidx,documents_number_uidx',
  'y cada una salta por el índice de su familia');
select ok(
  (select coalesce(bool_and(plan !~ '(Seq Scan|Bitmap|"Filter"|NO SE PUDO)'), false)
     from pg_temp.planes_del_maximo()),
  'sin recorrido ni filtro: el tipo, la empresa y la serie están en la condición del índice');
select is(platform.claim_document_number('aaaa0134-0000-4000-8000-0000000000a1', 'invoice', 'A'),
  2::bigint, 'la factura que sigue a la factura de retiro n.º 1 es la n.º 2, no otra n.º 1');
-- Y si alguien numerara sin pasar por la función, el índice que cruza los dos kinds lo rechaza.
select pg_temp.borrador('aaaa0134-0000-4000-8000-00000000f005', 'invoice',
                        'aaaa0134-0000-4000-8000-00000000c002', 'J134TERCERO', 'Un tercero', 0,
                        null);
select throws_ok(
  $$ select pg_temp.emitir('aaaa0134-0000-4000-8000-00000000f005', 1, 5, null) $$,
  '23505', null, 'una factura con el número de una factura de retiro de su serie se rechaza');
-- VARIANTE ROTA: sin ese índice, el número repetido entra.
drop index public.documents_invoice_number_uidx;
select lives_ok(
  $$ select pg_temp.emitir('aaaa0134-0000-4000-8000-00000000f005', 1, 5, null) $$,
  'sin el índice que cruza los kinds el número repetido entra: la aserción anterior medía el índice');
-- VARIANTE ROTA del coste: sin ese índice la rama de las facturas ya no salta por él, y la
-- aserción de los índices lo nota (no era un verde de adorno).
select isnt(
  (select string_agg(coalesce(indice, '(ninguno)'), ',' order by n) from pg_temp.planes_del_maximo()),
  'documents_invoice_number_uidx,documents_credit_note_number_uidx,documents_number_uidx',
  'sin el índice de las facturas, el plan de su rama cambia: la aserción del coste medía el plan');

-- ── 7. El libro ─────────────────────────────────────────────────────────────
select is(
  (select string_agg(s.kind || ':' || s.control_number, ',' order by s.control_number)
     from platform.sales_book('aaaa0134-0000-4000-8000-0000000000a1',
                              platform.caracas_day(now()), platform.caracas_day(now())) s
    where s.kind = 'withdrawal_invoice'),
  'withdrawal_invoice:1', 'la factura de retiro está en el libro de ventas con su control');

-- ── 8. VARIANTE ROTA de la rama «a un tercero» del invariante ───────────────
-- La guarda (documents_07_withdrawal_invoice, LAD72: aserción 3) impide emitirla. Sin la guarda,
-- la factura de retiro a nombre de un tercero ENTRA, y entonces es el invariante quien la ve: la
-- rama no era decoración detrás de la guarda. (Los triggers se apagan con
-- session_replication_role y no con ALTER TABLE: la tabla tiene eventos diferidos pendientes.)
set local session_replication_role = replica;
select pg_temp.emitir('aaaa0134-0000-4000-8000-00000000f002', 9, 9,
                      'aaaa0134-0000-4000-8000-00000000e003');
set local session_replication_role = origin;
select is(
  (select string_agg(problem, ',' order by problem) from platform.withdrawal_note_gaps(
             'aaaa0134-0000-4000-8000-0000000000a1')
    where problem = 'factura_de_retiro_a_un_tercero'),
  'factura_de_retiro_a_un_tercero',
  'ROTO: sin la guarda, una factura de retiro a nombre de un tercero la ve withdrawal_note_gaps');

-- ── 9. VARIANTE ROTA de la rama «sin su salida» (20261005100970) ─────────────
-- El invariante cruza también DESDE la factura. Con las guardas apagadas hay ya dos facturas
-- de retiro con la salida colgando, cada una de una forma: la f002 de arriba apunta a una salida
-- que existe y NO la señala (e003); y ahora la f003 apunta a una salida que NO EXISTE. Sin clave
-- foránea (20261005100960), si el trigger faltara un día, esto es lo único que lo diría. (Con
-- la f001 bien enlazada el invariante daba cero: aserciones de §1 y §2.)
set local session_replication_role = replica;
select pg_temp.emitir('aaaa0134-0000-4000-8000-00000000f003', 8, 8,
                      'aaaa0134-0000-4000-8000-00000000eeee');
set local session_replication_role = origin;
select is(
  (select string_agg(move_id::text, ',' order by move_id::text)
     from platform.withdrawal_note_gaps('aaaa0134-0000-4000-8000-0000000000a1')
    where problem = 'factura_de_retiro_sin_su_salida'),
  'aaaa0134-0000-4000-8000-00000000e003,aaaa0134-0000-4000-8000-00000000eeee',
  'ROTO: sin la guarda, la factura cuya salida no la señala y la factura cuya salida no existe las ve withdrawal_note_gaps');

select * from finish();
rollback;

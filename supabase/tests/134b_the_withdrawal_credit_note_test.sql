-- =============================================================================
-- pgTAP 134b · LA NOTA DE CRÉDITO DE UN RETIRO (ADR-0082, AF3-06; migración 20261005100500)
--
-- Con datos puestos a mano (el camino entero lo ejerce el E2E e2e-salidas-inventario):
--   · la forma, por SQLSTATE: corrige SOLO una factura de retiro (LAD72), es total (LAD72), una
--     por factura (23505), nunca `paid` (23514), sin cobro ni saldo a favor (LAD72), y la factura
--     ya corregida no se anula (LAD72);
--   · el correlativo compartido con la nota de crédito (función e índice que cruza los kinds);
--   · `withdrawal_note_gaps`: un retiro corregido cuya mercancía NO volvió es un hueco, y con su
--     reingreso deja de serlo;
--   · `accounting_coverage_gaps` la ve sin asiento; el libro la lee en negativo;
--   · `document_debt` no responde por una factura de retiro y SÍ por una factura normal.
-- Cada defensa con su variante rota, y lo permitido, ejercido.
-- =============================================================================
begin;
select plan(27);

insert into auth.users (id) values ('aaaa0136-0000-4000-8000-0000000000aa');
select set_config('ladino.actor_id', 'aaaa0136-0000-4000-8000-0000000000aa', true);
select set_config('ladino.rules_version', 'domain-s0.5', true);
insert into public.tenants (id, name) values ('aaaa0136-0000-4000-8000-00000000000a', 'Tenant 134b');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa0136-0000-4000-8000-0000000000a1', 'aaaa0136-0000-4000-8000-00000000000a',
        'J-136-A', 'Bodega 134b', 'VES', 'ordinario');
insert into public.company_fiscal_regimes (tenant_id, company_id, regime_code, effective_from)
values ('aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a1',
        'formatos_libres', '2026-01-01');
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, reason, rules_version)
values ('aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a1',
        'ordinario', '2000-01-01', 'pgTAP 134b', 'pgtap');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0136-0000-4000-8000-0000000000b1', 'aaaa0136-0000-4000-8000-00000000000a',
   'aaaa0136-0000-4000-8000-0000000000a1', 'W136', 'Principal');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code) values
  ('aaaa0136-0000-4000-8000-00000000d001', 'aaaa0136-0000-4000-8000-00000000000a',
   'aaaa0136-0000-4000-8000-0000000000a1', 'SKU-136', 'Harina 134b', 'good', 'active', 'unidad',
   'gravado_general');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                              taxpayer_type_code) values
  ('aaaa0136-0000-4000-8000-00000000c001', 'aaaa0136-0000-4000-8000-00000000000a',
   'aaaa0136-0000-4000-8000-0000000000a1', 'J-136-A', 'Bodega 134b', 'juridica', 'ordinario'),
  ('aaaa0136-0000-4000-8000-00000000c002', 'aaaa0136-0000-4000-8000-00000000000a',
   'aaaa0136-0000-4000-8000-0000000000a1', 'J-136-TERCERO', 'Un tercero', 'juridica',
   'ordinario');

create function pg_temp.mover(p_id uuid, p_kind text, p_q numeric, p_val numeric,
                              p_q_after numeric, p_v_after numeric, p_motivo text, p_doc uuid)
returns void language sql as $$
  insert into public.inventory_moves
    (id, tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost,
     quantity_after, value_after, occurred_at, exit_reason, source_document_id)
  values (p_id, 'aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a1',
          'aaaa0136-0000-4000-8000-0000000000b1', 'aaaa0136-0000-4000-8000-00000000d001', null,
          p_kind, p_q, p_val, 'VES', 1, p_val, 'VES', 'identidad', now(),
          'inventory:cost:8:HALF_UP', 10, p_q_after, p_v_after, now(), p_motivo, p_doc);
$$;
create function pg_temp.borrador(p_id uuid, p_kind text, p_customer uuid, p_rif text,
                                 p_nombre text, p_iva numeric, p_origen uuid) returns void
language sql as $$
  insert into public.documents
    (id, tenant_id, company_id, kind, series, customer_id, source_document_id,
     transaction_currency, functional_currency, amount_transaction_currency, functional_amount,
     subtotal_amount, tax_amount, total_amount, customer_name_snapshot,
     customer_tax_id_snapshot, customer_taxpayer_type_snapshot, issuer_name_snapshot,
     issuer_tax_id_snapshot)
  values (p_id, 'aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a1',
          p_kind, 'A', p_customer, p_origen, 'VES', 'VES', 100 + p_iva, 100 + p_iva, 100, p_iva,
          100 + p_iva, p_nombre, p_rif, 'ordinario', 'Bodega 134b', 'J136A');
$$;
create function pg_temp.emitir(p_id uuid, p_numero bigint, p_control bigint, p_move uuid)
returns void language sql as $$
  update public.documents
     set status = 'issued', issued_at = now(), document_number = p_numero,
         control_number = p_control, control_identifier = '00',
         regime_version_id = (select r.regime_version_id
                                from platform.regime_at('aaaa0136-0000-4000-8000-0000000000a1',
                                                        now()) r),
         rules_version = 'domain-s0.5', withdrawal_move_id = p_move
   where id = p_id;
$$;
create function pg_temp.sqlstate_de(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end $$;

-- Dos retiros facturados (IVA 16 cada uno) y una factura de venta normal.
select pg_temp.mover('aaaa0136-0000-4000-8000-00000000e001', 'entrada', 10, 100, 10, 100, null,
                     null);
select pg_temp.borrador('aaaa0136-0000-4000-8000-00000000f001', 'withdrawal_invoice',
                        'aaaa0136-0000-4000-8000-00000000c001', 'J136A', 'Bodega 134b', 16, null);
select pg_temp.mover('aaaa0136-0000-4000-8000-00000000e002', 'salida', -1, -10, 9, 90,
                     'consumo_propio', 'aaaa0136-0000-4000-8000-00000000f001');
select pg_temp.emitir('aaaa0136-0000-4000-8000-00000000f001', 1, 1,
                      'aaaa0136-0000-4000-8000-00000000e002');
select pg_temp.borrador('aaaa0136-0000-4000-8000-00000000f002', 'withdrawal_invoice',
                        'aaaa0136-0000-4000-8000-00000000c001', 'J136A', 'Bodega 134b', 16, null);
select pg_temp.mover('aaaa0136-0000-4000-8000-00000000e003', 'salida', -1, -10, 8, 80, 'regalo',
                     'aaaa0136-0000-4000-8000-00000000f002');
select pg_temp.emitir('aaaa0136-0000-4000-8000-00000000f002', 2, 2,
                      'aaaa0136-0000-4000-8000-00000000e003');
select pg_temp.borrador('aaaa0136-0000-4000-8000-00000000f003', 'invoice',
                        'aaaa0136-0000-4000-8000-00000000c002', 'J136TERCERO', 'Un tercero', 16,
                        null);
select pg_temp.emitir('aaaa0136-0000-4000-8000-00000000f003', 3, 3, null);

-- ── 1. Qué corrige y cómo ───────────────────────────────────────────────────
select throws_ok(
  $$ select pg_temp.borrador('aaaa0136-0000-4000-8000-000000000a01', 'withdrawal_credit_note',
                             'aaaa0136-0000-4000-8000-00000000c002', 'J136TERCERO',
                             'Un tercero', 16, 'aaaa0136-0000-4000-8000-00000000f003') $$,
  'LAD72', null, 'la nota de crédito de un retiro no corrige una factura de venta');
select throws_ok(
  $$ select pg_temp.borrador('aaaa0136-0000-4000-8000-000000000a02', 'credit_note',
                             'aaaa0136-0000-4000-8000-00000000c001', 'J136A', 'Bodega 134b', 16,
                             'aaaa0136-0000-4000-8000-00000000f001') $$,
  'LAD72', null, 'la nota de crédito GENERAL sobre una factura de retiro sigue rechazada');

-- No es total (IVA 0 contra una factura con IVA 16): no se emite.
select pg_temp.borrador('aaaa0136-0000-4000-8000-000000000b02', 'withdrawal_credit_note',
                        'aaaa0136-0000-4000-8000-00000000c001', 'J136A', 'Bodega 134b', 0,
                        'aaaa0136-0000-4000-8000-00000000f002');
select throws_ok(
  $$ select pg_temp.emitir('aaaa0136-0000-4000-8000-000000000b02', 9, 9, null) $$,
  'LAD72', null, 'una nota de crédito de un retiro que no es total no se emite');

-- CORRECTO: total y al mismo adquirente.
select pg_temp.borrador('aaaa0136-0000-4000-8000-000000000b01', 'withdrawal_credit_note',
                        'aaaa0136-0000-4000-8000-00000000c001', 'J136A', 'Bodega 134b', 16,
                        'aaaa0136-0000-4000-8000-00000000f001');
select lives_ok(
  $$ select pg_temp.emitir('aaaa0136-0000-4000-8000-000000000b01', 1, 4, null) $$,
  'la nota de crédito total de una factura de retiro se emite');

-- ── 2. Una por factura ──────────────────────────────────────────────────────
select throws_ok(
  $$ select pg_temp.borrador('aaaa0136-0000-4000-8000-000000000b03', 'withdrawal_credit_note',
                             'aaaa0136-0000-4000-8000-00000000c001', 'J136A', 'Bodega 134b', 16,
                             'aaaa0136-0000-4000-8000-00000000f001') $$,
  '23505', null, 'una factura de retiro, una nota: la segunda muere en el único');

-- ── 3. Sin cartera ──────────────────────────────────────────────────────────
select throws_ok(
  $$ update public.documents set status = 'paid'
      where id = 'aaaa0136-0000-4000-8000-000000000b01' $$,
  '23514', null, 'la nota de crédito de un retiro nunca queda «pagada»');
select throws_ok(
  $$ insert into public.payments (document_id)
     values ('aaaa0136-0000-4000-8000-000000000b01') $$,
  'LAD72', null, 'la nota de crédito de un retiro no admite un cobro');
select throws_ok(
  $$ insert into public.customer_credits (source_document_id)
     values ('aaaa0136-0000-4000-8000-000000000b01') $$,
  'LAD72', null, 'la nota de crédito de un retiro no deja saldo a favor');
-- LO PERMITIDO: el saldo a favor de la nota de una venta normal PASA la guarda (muere después,
-- por lo que a esta fila mínima le falta; nunca por la guarda ni por una columna que no existe).
select ok(
  (select pg_temp.sqlstate_de($$ insert into public.customer_credits (source_document_id)
                                 values ('aaaa0136-0000-4000-8000-00000000f003') $$))
    not in ('LAD72', '42703', 'ok'),
  'el saldo a favor de un documento que no es de retiro pasa la guarda');
-- VARIANTE ROTA: sin el trigger, el saldo a favor de la nota ya no muere por LAD72.
alter table public.customer_credits disable trigger customer_credits_05_no_withdrawal;
select isnt(
  (select pg_temp.sqlstate_de($$ insert into public.customer_credits (source_document_id)
                                 values ('aaaa0136-0000-4000-8000-000000000b01') $$)),
  'LAD72', 'sin el trigger ya no se rechaza por LAD72: la aserción de arriba lo medía');
alter table public.customer_credits enable trigger customer_credits_05_no_withdrawal;

-- ── 4. La factura corregida no se anula ─────────────────────────────────────
select throws_ok(
  $$ update public.documents
        set status = 'annulled', annulled_at = now(), annul_reason = 'por error'
      where id = 'aaaa0136-0000-4000-8000-00000000f001' $$,
  'LAD72', null, 'una factura de retiro ya corregida con su nota no se anula');

-- ── 5. La deuda ─────────────────────────────────────────────────────────────
select is(
  (select count(*)::int from platform.document_debt('aaaa0136-0000-4000-8000-0000000000a1',
                                                    'aaaa0136-0000-4000-8000-00000000f002')),
  0, 'document_debt no responde por una factura de retiro: no carga cartera');
select is(
  (select nominal from platform.document_debt('aaaa0136-0000-4000-8000-0000000000a1',
                                              'aaaa0136-0000-4000-8000-00000000f003')),
  116.00::numeric, 'y SÍ por una factura de venta: debe su total');
select is(
  (select count(*)::int from platform.document_debt('aaaa0136-0000-4000-8000-0000000000a1',
                                                    'aaaa0136-0000-4000-8000-000000000b01')),
  0, 'ni por la nota de crédito de un retiro');

-- ── 6. El invariante: el retiro corregido netea en cero ─────────────────────
select is(
  (select string_agg(problem, ',' order by problem)
     from platform.withdrawal_note_gaps('aaaa0136-0000-4000-8000-0000000000a1')
    where problem = 'retiro_corregido_sin_reingreso'),
  'retiro_corregido_sin_reingreso',
  'ROTO: una nota de crédito de retiro cuya mercancía no volvió al kardex es un hueco');
select is(
  (select count(*)::int
     from platform.accounting_coverage_gaps('aaaa0136-0000-4000-8000-0000000000a1')
    where source_kind = 'withdrawal_credit_note'),
  1, 'ROTO: y accounting_coverage_gaps la ve sin el asiento de su reingreso');
select pg_temp.mover('aaaa0136-0000-4000-8000-00000000e004', 'entrada', 1, 10, 9, 90, null,
                     'aaaa0136-0000-4000-8000-000000000b01');
select is(
  (select count(*)::int
     from platform.withdrawal_note_gaps('aaaa0136-0000-4000-8000-0000000000a1')
    where problem = 'retiro_corregido_sin_reingreso'),
  0, 'con su reingreso por la misma cantidad y el mismo valor, el retiro corregido netea en cero');

-- ── 7. El correlativo compartido con la nota de crédito ─────────────────────
select is(
  platform.claim_document_number('aaaa0136-0000-4000-8000-0000000000a1', 'credit_note', 'A'),
  2::bigint, 'la nota de crédito que sigue a la nota de un retiro n.º 1 es la n.º 2');
select pg_temp.borrador('aaaa0136-0000-4000-8000-000000000a03', 'credit_note',
                        'aaaa0136-0000-4000-8000-00000000c002', 'J136TERCERO', 'Un tercero', 16,
                        'aaaa0136-0000-4000-8000-00000000f003');
select throws_ok(
  $$ select pg_temp.emitir('aaaa0136-0000-4000-8000-000000000a03', 1, 7, null) $$,
  '23505', null, 'una nota de crédito con el número de la nota de un retiro de su serie se rechaza');
-- VARIANTE ROTA: sin el índice que cruza los kinds, el número repetido entra.
drop index public.documents_credit_note_number_uidx;
select lives_ok(
  $$ select pg_temp.emitir('aaaa0136-0000-4000-8000-000000000a03', 1, 7, null) $$,
  'sin ese índice el número repetido entra: la aserción anterior medía el índice');

-- LA REGRESIÓN DE 20261005100500 (cerrada en 20261005100700): document_debt había dejado de
-- responder por la nota de crédito GENERAL, que no es de retiro, y el detalle del documento
-- mostraba «0». Responde por ella como antes de la familia; quien suma cartera filtra aparte.
select is(
  (select count(*)::int from platform.document_debt('aaaa0136-0000-4000-8000-0000000000a1',
                                                    'aaaa0136-0000-4000-8000-000000000a03')),
  1, 'document_debt SÍ responde por una nota de crédito general emitida, como antes de ADR-0082');
select is((select coalesce(platform.customer_debt_today(
                             'aaaa0136-0000-4000-8000-0000000000a1'), 0)),
  116.00::numeric,
  'y la cartera sigue siendo solo la factura de venta: ni el retiro ni las notas suman deuda');

-- ── 8. El libro: en negativo ────────────────────────────────────────────────
select is(
  (select s.iva_debito
     from platform.sales_book('aaaa0136-0000-4000-8000-0000000000a1',
                              platform.caracas_day(now()), platform.caracas_day(now())) s
    where s.kind = 'withdrawal_credit_note'),
  -16.00000000::numeric, 'la nota de crédito de un retiro resta su IVA en el libro de ventas');

-- ── 9. VARIANTES ROTAS de las ramas del invariante que nadie había visto en rojo ────────────
-- (a) y (b): aquí las facturas y la nota llevan IVA 16 y NADIE asentó nada (los datos están
-- puestos a mano): ni asiento ni cola. Las dos ramas del IVA lo dicen. Su verde —con el asiento
-- de verdad— lo da el E2E e2e-salidas-inventario (enVerde tras cada retiro y cada nota); y en el
-- pgTAP 134, con IVA 0, el invariante da cero.
select is(
  (select count(*)::int from platform.withdrawal_note_gaps('aaaa0136-0000-4000-8000-0000000000a1')
    where problem = 'factura_de_retiro_sin_iva_en_el_asiento'
      and move_id = 'aaaa0136-0000-4000-8000-00000000e003'),
  1, 'ROTO: una factura de retiro con IVA cuyo débito no está en el asiento ni en la cola es un hueco');
select is(
  (select count(*)::int from platform.withdrawal_note_gaps('aaaa0136-0000-4000-8000-0000000000a1')
    where problem = 'nota_de_credito_de_retiro_sin_iva_en_el_asiento'
      and move_id = 'aaaa0136-0000-4000-8000-00000000e002'),
  1, 'ROTO: una nota de crédito de retiro con IVA sin su débito revertido en el asiento del reingreso es un hueco');

-- (c) «no es total». La guarda (documents_07_withdrawal_invoice, LAD72: aserción 3) impide
-- emitirla. Sin la guarda entra, y el invariante la ve.
-- (Los triggers se apagan con session_replication_role y no con ALTER TABLE: la tabla tiene
-- eventos diferidos pendientes.)
set local session_replication_role = replica;
select pg_temp.emitir('aaaa0136-0000-4000-8000-000000000b02', 9, 9, null);
set local session_replication_role = origin;
select is(
  (select count(*)::int from platform.withdrawal_note_gaps('aaaa0136-0000-4000-8000-0000000000a1')
    where problem = 'nota_de_credito_de_retiro_no_es_total'
      and move_id = 'aaaa0136-0000-4000-8000-00000000e003'),
  1, 'ROTO: sin la guarda, una nota de crédito de retiro que no es total la ve withdrawal_note_gaps');

-- (d) «con cartera». Tres guardas lo impiden: el CHECK de «nunca pagada» (23514: aserciones de
-- §3 aquí y de §4 en 134) y los triggers de cobro y de saldo a favor (LAD72). Sin el CHECK, una
-- factura de retiro marcada como pagada ENTRA, y el invariante la ve.
set constraints all immediate;
do $$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.documents'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%withdrawal_invoice%'
              and pg_get_constraintdef(oid) like '%paid%'
  loop
    execute format('alter table public.documents drop constraint %I', c);
  end loop;
end $$;
set local session_replication_role = replica;
update public.documents set status = 'paid' where id = 'aaaa0136-0000-4000-8000-00000000f002';
set local session_replication_role = origin;
select is(
  (select count(*)::int from platform.withdrawal_note_gaps('aaaa0136-0000-4000-8000-0000000000a1')
    where problem = 'factura_de_retiro_con_cartera'
      and move_id = 'aaaa0136-0000-4000-8000-00000000e003'),
  1, 'ROTO: sin el CHECK, una factura de retiro «pagada» la ve withdrawal_note_gaps como cartera');

select * from finish();
rollback;

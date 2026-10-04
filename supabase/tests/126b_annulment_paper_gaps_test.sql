-- =============================================================================
-- Ladino — pgTAP 126b · EL PAPEL DE LA ANULACIÓN TIENE QUIEN LO MIRE, Y EL ADMINISTRATIVO REEMBOLSA
-- Migraciones 20261004160200 y 20261004160300 (G-10, G-07; ADR-0061 nota de la ola 4; ADR-0068 §8).
--
--   Invariante `platform.annulment_paper_gaps(empresa)`: toda FACTURA anulada desde el corte se
--   anuló el mismo día de Caracas, con el período sin declarar (declarado = generado después de
--   cerrar el período, B-1: una vista previa no), antes del cierre de cualquier caja de la
--   empresa, y su acta lleva `originals_in_hand = true`. Una factura bien anulada no da fila; y por CADA
--   cláusula, una anulación hecha por SQL que la rompe (la variante rota: lo que `annulInvoice`
--   no dejaría pasar) da SU fila, por su nombre. El corte está en el enunciado: lo anterior al
--   corte no se juzga, y sin la fila del corte la función LANZA.
--   El test mueve el corte dentro de su transacción (a julio) para fechar sus casos en el pasado.
--
--   Permisos: el administrativo reembolsa (`sales.refund`); el cajero y el encargado no.
-- =============================================================================

begin;
select plan(18);
set local lock_timeout = '4s';

insert into auth.users (id) values
  ('aaaa126b-0000-4000-8000-0000000000e1'),
  ('aaaa126b-0000-4000-8000-0000000000e3');
insert into public.tenants (id, name) values
  ('aaaa126b-0000-4000-8000-00000000000a', 'Tenant 126b A'),
  ('aaaa126b-0000-4000-8000-00000000000b', 'Tenant 126b B');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code) values
  ('aaaa126b-0000-4000-8000-0000000000a1', 'aaaa126b-0000-4000-8000-00000000000a',
   'V126100018', 'Bodega 126b A', 'VES'),
  ('aaaa126b-0000-4000-8000-0000000000b1', 'aaaa126b-0000-4000-8000-00000000000b',
   'V126100026', 'Bodega 126b B', 'VES');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa126b-0000-4000-8000-0000000001a1', 'aaaa126b-0000-4000-8000-00000000000a',
   'aaaa126b-0000-4000-8000-0000000000e1'),
  ('aaaa126b-0000-4000-8000-0000000001b3', 'aaaa126b-0000-4000-8000-00000000000b',
   'aaaa126b-0000-4000-8000-0000000000e3');
insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
select m.tenant_id, m.id, r.id, null
  from public.memberships m
  join public.roles r on r.key = 'owner' and r.tenant_id is null
 where m.id in ('aaaa126b-0000-4000-8000-0000000001a1', 'aaaa126b-0000-4000-8000-0000000001b3');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                              taxpayer_type_code) values
  ('aaaa126b-0000-4000-8000-0000000000c1', 'aaaa126b-0000-4000-8000-00000000000a',
   'aaaa126b-0000-4000-8000-0000000000a1', 'J412610001', 'Cliente 126b', 'juridica', 'ordinario');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code) values
  ('aaaa126b-0000-4000-8000-0000000000d1', 'aaaa126b-0000-4000-8000-00000000000a',
   'aaaa126b-0000-4000-8000-0000000000a1', 'P-126B-G', 'Gravado 126b', 'good', 'active', 'unidad',
   'gravado_general');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from,
                                           effective_to)
values ('aaaa126b-0000-4000-8000-0000000000f2', 'aaaa126b-0000-4000-8000-00000000000a',
        'aaaa126b-0000-4000-8000-0000000000a1', 'formatos_libres', '2026-06-01 00:00-04', null);
insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                           effective_from, reason, rules_version)
values ('aaaa126b-0000-4000-8000-00000000000a', 'aaaa126b-0000-4000-8000-0000000000a1',
        'ordinario', '2026-06-01', 'Declaración del dueño', 'v1');
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa126b-0000-4000-8000-0000000000c8', 'aaaa126b-0000-4000-8000-00000000000a',
   'aaaa126b-0000-4000-8000-0000000000a1', 'Caja 126b', 'VES', 'cash');
select set_config('ladino.actor_id', 'aaaa126b-0000-4000-8000-0000000000e1', true);

-- Una factura emitida (como el pgTAP 126) ...
create function pg_temp.emitir(p_id uuid, p_n int, p_cuando timestamptz) returns void
language sql as $$
  insert into public.documents
    (id, tenant_id, company_id, kind, series, customer_id, status, rules_version,
     transaction_currency, functional_currency, fx_rate, rate_source,
     amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
  values (p_id, 'aaaa126b-0000-4000-8000-00000000000a', 'aaaa126b-0000-4000-8000-0000000000a1',
          'invoice', 'A', 'aaaa126b-0000-4000-8000-0000000000c1', 'draft', 'test-126b',
          'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116);
  insert into public.document_lines
    (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
     unit_price_transaction, unit_price_functional, tax_rate_snapshot, tax_amount,
     line_subtotal_transaction, line_subtotal_functional,
     line_total_transaction, line_total_functional,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, rounding_policy_id,
     tax_category_snapshot, tax_treatment)
  values ('aaaa126b-0000-4000-8000-00000000000a', 'aaaa126b-0000-4000-8000-0000000000a1',
          p_id, 1, 'aaaa126b-0000-4000-8000-0000000000d1', 'Línea 126b', 1, 100, 100, 0.16, 16,
          100, 100, 116, 116, 116, 'VES', 1, 116, 'VES', 'identidad', now(),
          'inventory:cost:8:HALF_UP', 'gravado_general',
          platform.tax_treatment_of('gravado_general'));
  update public.documents
     set status = 'issued', issued_at = p_cuando, document_number = p_n, control_number = p_n,
         control_identifier = '00', regime_version_id = 'aaaa126b-0000-4000-8000-0000000000f2'
   where id = p_id;
$$;
-- ... y su anulación POR SQL, la vía que annulInvoice no vigila. Con acta o sin ella.
create function pg_temp.anular(p_id uuid, p_cuando timestamptz, p_papel boolean) returns void
language plpgsql as $$
begin
  update public.documents
     set status = 'annulled', annulled_at = p_cuando, annul_reason = 'Anulada en el pgTAP 126b'
   where id = p_id;
  if p_papel is not null then
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, actor_type, occurred_at,
       rules_version, payload)
    values ('aaaa126b-0000-4000-8000-00000000000a', 'aaaa126b-0000-4000-8000-0000000000a1',
            'document', p_id, 'fiscal.invoice.annulled', 'system', p_cuando, 'test-126b',
            jsonb_build_object('reason', 'pgTAP 126b', 'originals_in_hand', p_papel));
  end if;
end $$;
create function pg_temp.huecos() returns text
language sql as $$
  select coalesce(string_agg(right(document_id::text, 3) || ':' || problem, ','
                             order by document_id, problem), '')
    from platform.annulment_paper_gaps('aaaa126b-0000-4000-8000-0000000000a1');
$$;

-- El corte, a julio, dentro de esta transacción: los casos se fechan en el pasado.
update platform.invariant_cutoffs set since = '2026-07-01 00:00-04'
 where invariant = 'annulment_paper_gaps';

-- ── 1. La factura bien anulada no da fila ────────────────────────────────────
select pg_temp.emitir('aaaa126b-0000-4000-8000-000000000101', 1, '2026-07-10 19:00-04');
select pg_temp.anular('aaaa126b-0000-4000-8000-000000000101', '2026-07-10 21:00-04', true);
select is(pg_temp.huecos(), '',
  'anulada a las 21:00 de Caracas del mismo día (ya otro día en UTC), con su acta: cero filas');

-- ── 2. Una variante rota por cláusula ────────────────────────────────────────
-- (a) otro día de Caracas.
select pg_temp.emitir('aaaa126b-0000-4000-8000-000000000102', 2, '2026-07-11 19:00-04');
select pg_temp.anular('aaaa126b-0000-4000-8000-000000000102', '2026-07-12 00:10-04', true);
select is(pg_temp.huecos(), '102:not_same_day',
  'VARIANTE ROTA (a): anulada al día siguiente por SQL → not_same_day');

-- (d) sin acta; y con acta que dice que NO tenía el papel.
select pg_temp.emitir('aaaa126b-0000-4000-8000-000000000103', 3, '2026-07-13 10:00-04');
select pg_temp.anular('aaaa126b-0000-4000-8000-000000000103', '2026-07-13 10:30-04', null);
select pg_temp.emitir('aaaa126b-0000-4000-8000-000000000104', 4, '2026-07-13 11:00-04');
select pg_temp.anular('aaaa126b-0000-4000-8000-000000000104', '2026-07-13 11:30-04', false);
select is(pg_temp.huecos(),
  '102:not_same_day,103:originals_not_confirmed,104:originals_not_confirmed',
  'VARIANTE ROTA (d): sin acta, o con originals_in_hand = false → originals_not_confirmed');

-- (c) la caja se cerró entre la emisión y la anulación.
select pg_temp.emitir('aaaa126b-0000-4000-8000-000000000105', 5, '2026-07-14 10:00-04');
insert into public.cash_closings
  (tenant_id, company_id, account_id, closing_date, closed_at, expected_amount, counted_amount,
   amount_transaction_currency, transaction_currency, functional_amount, functional_currency)
values ('aaaa126b-0000-4000-8000-00000000000a', 'aaaa126b-0000-4000-8000-0000000000a1',
        'aaaa126b-0000-4000-8000-0000000000c8', '2026-07-14', '2026-07-14 12:00-04', 0, 0,
        0, 'VES', 0, 'VES');
select pg_temp.anular('aaaa126b-0000-4000-8000-000000000105', '2026-07-14 13:00-04', true);
select ok(pg_temp.huecos() like '%105:cash_closed%',
  'VARIANTE ROTA (c): anulada después del cierre de caja → cash_closed');
select ok(pg_temp.huecos() not like '%101:%',
  'el cierre del 14 de julio no toca a la factura bien anulada el 10');

-- (b) el período ya estaba DECLARADO al anular. «Declarado» es el de la casa (B-1, 20261002120400;
-- 20261004160300): una generación hecha DESPUÉS de cerrar su período. Julio se declara AHORA
-- (created_at = now()), con julio cerrado hace meses; la factura es del 20 de julio y se anula
-- ahora. Con esa definición `period_declared` nunca llega solo: la anulación es, por fuerza, de
-- otro día. Son DOS filas para el mismo documento.
insert into public.iva_period_results
  (tenant_id, company_id, period_from, period_to, debitos, creditos, creditos_deducibles,
   retenciones_soportadas, excedente_anterior, cuota_a_pagar, excedente_siguiente, detalle,
   generator_version, dataset_hash)
values ('aaaa126b-0000-4000-8000-00000000000a', 'aaaa126b-0000-4000-8000-0000000000a1',
        '2026-07-01', '2026-07-31', 0, 0, 0, 0, 0, 0, 0, '{}'::jsonb, 'test-126b', 'hash-126b');
select pg_temp.emitir('aaaa126b-0000-4000-8000-000000000106', 6, '2026-07-20 10:00-04');
select pg_temp.anular('aaaa126b-0000-4000-8000-000000000106', now(), true);
select ok(pg_temp.huecos() like '%106:not_same_day,106:period_declared%',
  'VARIANTE ROTA (b): anulada con su período de IVA ya declarado → period_declared (y not_same_day)');
select ok(pg_temp.huecos() not like '%102:period_declared%'
          and pg_temp.huecos() not like '%105:period_declared%',
  'la declaración de julio hecha AHORA no alcanza a las anuladas en julio: no existía a esa hora');

-- Una VISTA PREVIA del período en curso no declara: la factura emitida y anulada hoy, con su
-- acta, no da fila aunque el contador haya generado hoy la planilla del mes.
insert into public.iva_period_results
  (tenant_id, company_id, period_from, period_to, debitos, creditos, creditos_deducibles,
   retenciones_soportadas, excedente_anterior, cuota_a_pagar, excedente_siguiente, detalle,
   generator_version, dataset_hash)
values ('aaaa126b-0000-4000-8000-00000000000a', 'aaaa126b-0000-4000-8000-0000000000a1',
        date_trunc('month', platform.caracas_day(now()))::date,
        (date_trunc('month', platform.caracas_day(now())) + interval '1 month - 1 day')::date,
        0, 0, 0, 0, 0, 0, 0, '{}'::jsonb, 'test-126b', 'hash-126b-previa');
select pg_temp.emitir('aaaa126b-0000-4000-8000-000000000107', 7, now());
select pg_temp.anular('aaaa126b-0000-4000-8000-000000000107', now(), true);
select ok(pg_temp.huecos() not like '%107:%',
  'una vista previa del período en curso NO declara: la anulada hoy con su acta no da fila');
select is(
  (select count(*)::int from platform.annulment_paper_gaps('aaaa126b-0000-4000-8000-0000000000a1')),
  6, 'seis filas en total: una por cada cláusula rota (la del período, con su «otro día»), ninguna de más');

-- ── 3. El corte está en el enunciado, y sin corte la función no calla ─────────
update platform.invariant_cutoffs set since = '2026-07-13 00:00-04'
 where invariant = 'annulment_paper_gaps';
select ok(pg_temp.huecos() not like '%102:%' and pg_temp.huecos() like '%103:%',
  'con el corte el 13 de julio, la anulada el 12 ya no se juzga y la del 13 sí');
delete from platform.invariant_cutoffs where invariant = 'annulment_paper_gaps';
select throws_ok(
  $$ select * from platform.annulment_paper_gaps('aaaa126b-0000-4000-8000-0000000000a1') $$,
  'LAD37', null, 'sin la fila del corte la función LANZA: un invariante que calla no es un invariante');
insert into platform.invariant_cutoffs (invariant, since, reason)
values ('annulment_paper_gaps', '2026-07-01 00:00-04', 'Corte restituido por el pgTAP 126b.');

-- ── 4. Aislamiento y privilegio ──────────────────────────────────────────────
-- UB, que solo es del tenant B, pregunta por la empresa A por el camino de la API: no ve nada
-- de A (ni sus huecos).
select set_config('ladino.actor_id', 'aaaa126b-0000-4000-8000-0000000000e3', true);
set local role ladino_api;
select set_config('t126b.ub', (select count(*)::text
  from platform.annulment_paper_gaps('aaaa126b-0000-4000-8000-0000000000a1')), true);
reset role;
select is(current_setting('t126b.ub'), '0',
  'aislamiento: por ladino_api, quien solo es del tenant B no recibe los huecos de A');
select set_config('ladino.actor_id', 'aaaa126b-0000-4000-8000-0000000000e1', true);
set local role anon;
select throws_ok(
  $$ select * from platform.annulment_paper_gaps('aaaa126b-0000-4000-8000-0000000000a1') $$,
  '42501', null, 'la función no es de PUBLIC: anon no la ejecuta');
reset role;
-- Ni de authenticated (20261004160300): solo la ejecuta la API, que la ejerció arriba.
set local role authenticated;
select throws_ok(
  $$ select * from platform.annulment_paper_gaps('aaaa126b-0000-4000-8000-0000000000a1') $$,
  '42501', null, 'el invariante no es de authenticated: solo lo ejecuta la API');
reset role;

-- ── 5. El administrativo reembolsa; el cajero y el encargado no ──────────────
create function pg_temp.rol_tiene(p_rol text, p_permiso text) returns boolean
language sql as $$
  select exists (select 1 from public.role_permissions rp
                   join public.roles r on r.id = rp.role_id and r.tenant_id is null
                  where r.key = p_rol and rp.permission_key = p_permiso);
$$;
select ok(pg_temp.rol_tiene('back_office', 'sales.refund'),
  'G-07: el administrativo tiene sales.refund (anula y aprueba, §2.8)');
select ok(not pg_temp.rol_tiene('cashier', 'sales.refund'),
  'G-07: el cajero sigue sin sales.refund');
select ok(not pg_temp.rol_tiene('store_manager', 'sales.refund'),
  'G-07: el encargado tampoco');
delete from public.role_permissions rp using public.roles r
 where rp.role_id = r.id and r.key = 'back_office' and r.tenant_id is null
   and rp.permission_key = 'sales.refund';
select ok(not pg_temp.rol_tiene('back_office', 'sales.refund'),
  'VARIANTE ROTA G-07: sin la fila de la migración, el administrativo no reembolsa');

select * from finish();
rollback;

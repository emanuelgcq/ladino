-- =============================================================================
-- Ladino — pgTAP 81c · ALÍCUOTAS: LA REPARACIÓN ES UNA FUNCIÓN Y LA GUARDA NO DEPENDE DE LA RLS
-- (ADR-0073; re-revisión de la familia: B2, B3, B6)
--
--   1. B2 · `platform.repair_retired_referenced_tax_rules()`: una regla propia inactiva que alguna
--      línea emitida usa vuelve a `active` con vigencia de un día, y su sustituta sin líneas empieza
--      al día siguiente. Idempotente: la segunda llamada no toca nada.
--   2. B3 · los índices sobre `tax_rule_id` de las líneas de venta y de compra existen.
--   3. B6 · `platform.tax_rule_is_referenced` es SECURITY DEFINER: responde lo mismo aunque quien
--      pregunta no vea las líneas (actor de OTRO tenant). Variante ROTA: como INVOKER, miente.
-- =============================================================================

begin;
select plan(11);

insert into auth.users (id) values ('aaaa0083-0000-4000-8000-0000000000b1');
insert into public.tenants (id, name) values
  ('aaaa0083-0000-4000-8000-00000000000a', 'Tenant 81c-A'),
  ('aaaa0083-0000-4000-8000-00000000000b', 'Tenant 81c-B');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa0083-0000-4000-8000-0000000000a2', 'aaaa0083-0000-4000-8000-00000000000a',
        'J-83-A', 'Alícuotas 81c A', 'VES', 'ordinario'),
       ('aaaa0083-0000-4000-8000-0000000000b2', 'aaaa0083-0000-4000-8000-00000000000b',
        'J-83-B', 'Alícuotas 81c B', 'VES', 'ordinario');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0083-0000-4000-8000-0000000000b3', 'aaaa0083-0000-4000-8000-00000000000b',
   'aaaa0083-0000-4000-8000-0000000000b1');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0083-0000-4000-8000-00000000c00a', 'aaaa0083-0000-4000-8000-00000000000a',
   'aaaa0083-0000-4000-8000-0000000000a2', 'J-CLI-83A', 'Cliente 81c', 'juridica', 'ordinario');
insert into public.products (id, tenant_id, company_id, sku, name, kind, unit_code,
                             tax_category_code) values
  ('aaaa0083-0000-4000-8000-00000000d00a', 'aaaa0083-0000-4000-8000-00000000000a',
   'aaaa0083-0000-4000-8000-0000000000a2', 'SKU-83A', 'Producto 81c', 'good', 'unidad', 'exento');
-- El tipo de contribuyente con su vigencia (ADR-0072, migración 20260928190000): sin él no se emite.
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason, rules_version)
values
  ('aaaa0083-0000-4000-8000-00000000000a', 'aaaa0083-0000-4000-8000-0000000000a2', 'ordinario',
   '2026-01-01', null, 'Fixture pgTAP 81', 'test-081');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0083-0000-4000-8000-00000000e10a', 'aaaa0083-0000-4000-8000-00000000000a',
        'aaaa0083-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01');

-- R: la exenta propia del 10-07, RETIRADA el mismo día (como hacía 150100); Q: su sustituta, del
-- mismo día, sin líneas. Una factura del 10-07 usa R.
insert into public.tax_rules
  (id, tenant_id, company_id, jurisdiction, tax_code, taxpayer_type, transaction_type,
   product_tax_category, rate, effective_from, legal_source, priority, status)
values
  ('aaaa0083-0000-4000-8000-0000000000f1', 'aaaa0083-0000-4000-8000-00000000000a',
   'aaaa0083-0000-4000-8000-0000000000a2', 'VE', 'iva', null, 'sale', 'exento', 0, '2026-07-10',
   'REGLA DE PRUEBA 81c — retirada', 5, 'inactive'),
  ('aaaa0083-0000-4000-8000-0000000000f2', 'aaaa0083-0000-4000-8000-00000000000a',
   'aaaa0083-0000-4000-8000-0000000000a2', 'VE', 'iva', null, 'sale', 'exento', 0, '2026-07-10',
   'REGLA DE PRUEBA 81c — sustituta', 5, 'active');
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version, transaction_currency,
   functional_currency, fx_rate, rate_source, amount_transaction_currency, functional_amount,
   subtotal_amount, tax_amount, total_amount)
values ('aaaa0083-0000-4000-8000-00000000f101', 'aaaa0083-0000-4000-8000-00000000000a',
        'aaaa0083-0000-4000-8000-0000000000a2', 'invoice', 'A',
        'aaaa0083-0000-4000-8000-00000000c00a', 1, 8301, 'issued', '2026-07-10T15:00:00Z',
        'aaaa0083-0000-4000-8000-00000000e10a', 'test-081c', 'VES', 'VES', 1, 'identidad',
        100, 100, 100, 0, 100);
insert into public.document_lines
  (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
   unit_price_transaction, unit_price_functional, tax_rule_id, tax_rate_snapshot, tax_amount,
   line_subtotal_transaction, line_subtotal_functional, line_total_transaction,
   line_total_functional, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, rate_source, rate_timestamp, rounding_policy_id,
   tax_category_snapshot, tax_treatment)
values ('aaaa0083-0000-4000-8000-00000000000a', 'aaaa0083-0000-4000-8000-0000000000a2',
        'aaaa0083-0000-4000-8000-00000000f101', 1, 'aaaa0083-0000-4000-8000-00000000d00a',
        'Exenta', 1, 100, 100, 'aaaa0083-0000-4000-8000-0000000000f1', 0, 0, 100, 100, 100, 100,
        100, 'VES', 1, 100, 'VES', 'identidad', now(), 'sales:document:8:HALF_UP', 'exento',
        'exento');

-- ── 1. B2 · la reparación ────────────────────────────────────────────────────
select ok(platform.repair_retired_referenced_tax_rules() >= 1,
  'la reparación encuentra la regla retirada que una línea emitida usa');
select is(
  (select array[status, effective_from::text, effective_to::text] from public.tax_rules
    where id = 'aaaa0083-0000-4000-8000-0000000000f1'),
  array['active', '2026-07-10', '2026-07-11'],
  'la regla usada vuelve a active, con su vigencia de un día cerrada');
select is(
  (select array[status, effective_from::text] from public.tax_rules
    where id = 'aaaa0083-0000-4000-8000-0000000000f2'),
  array['active', '2026-07-11'], 'la sustituta sin líneas empieza al día siguiente');
select is(
  (select rate from platform.resolve_tax('aaaa0083-0000-4000-8000-0000000000a2', '2026-07-10',
     'VE', 'iva', 'ordinario', 'exento')),
  0::numeric, 'el 10-07 no queda ambiguo: resuelve una sola regla');
select is(platform.repair_retired_referenced_tax_rules(), 0,
  'idempotente: la segunda llamada no toca nada');

-- ── 2. B3 · los índices ──────────────────────────────────────────────────────
select ok(
  exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid
                                                      and a.attnum = i.indkey[0]
           where i.indrelid = 'public.document_lines'::regclass and a.attname = 'tax_rule_id'),
  'document_lines tiene un índice que empieza por tax_rule_id');
select ok(
  exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid
                                                      and a.attnum = i.indkey[0]
           where i.indrelid = 'public.supplier_invoice_lines'::regclass
             and a.attname = 'tax_rule_id'),
  'supplier_invoice_lines tiene un índice que empieza por tax_rule_id');

-- ── 3. B6 · la guarda no depende de lo que ve quien pregunta ────────────────
select ok(
  (select prosecdef from pg_proc where oid = 'platform.tax_rule_is_referenced(uuid)'::regprocedure),
  'tax_rule_is_referenced es SECURITY DEFINER');
select set_config('ladino.actor_id', 'aaaa0083-0000-4000-8000-0000000000b1', true);
set local role ladino_api;
select is(
  (select count(*) from public.document_lines
    where tax_rule_id = 'aaaa0083-0000-4000-8000-0000000000f1'),
  0::bigint, 'el actor de B no ve la línea de A que usa la regla');
select ok(platform.tax_rule_is_referenced('aaaa0083-0000-4000-8000-0000000000f1'),
  'y aun así la guarda responde que la regla está en uso');
reset role;
alter function platform.tax_rule_is_referenced(uuid) security invoker;
set local role ladino_api;
select ok(not platform.tax_rule_is_referenced('aaaa0083-0000-4000-8000-0000000000f1'),
  'ROTA: como INVOKER, la guarda dice «no se usa» a quien no ve las líneas');
reset role;
alter function platform.tax_rule_is_referenced(uuid) security definer;

select * from finish();
rollback;

-- =============================================================================
-- pgTAP 107 · LOS LIBROS SON DE QUIEN TIENE RIF (AF3-13 · migración 20261003190100)
--
--   · una empresa SIN RIF (marcador reservado PEND-) con una factura de proveedor con soporte no
--     tiene renglones en el libro de compras, ni en el libro por alícuota, ni en el resumen;
--   · datos hostiles: el marcador en minúsculas y con espacios sigue siendo «sin RIF»; un RIF
--     que solo CONTIENE «PEND-» más adelante no lo es;
--   · la VARIANTE: la misma factura en una empresa gemela CON RIF sí tiene su renglón (si la
--     puerta mirara otra cosa —el soporte, el IVA al costo— ese renglón tampoco saldría);
--   · book_ledger_reconciliation sigue en cero para la empresa sin RIF;
--   · se mira el RIF y no el modo: la gemela con RIF no tiene régimen de facturación y lleva libro.
-- =============================================================================
begin;
select plan(9);

insert into auth.users (id) values ('aaaa0107-0000-4000-8000-0000000000e1');
select set_config('ladino.actor_id', 'aaaa0107-0000-4000-8000-0000000000e1', true);
insert into public.tenants (id, name) values ('aaaa0107-0000-4000-8000-00000000000a', 'Tenant 107');
-- a1: sin RIF · a2: el marcador escrito con descuido · a3: con RIF · a4: un RIF que contiene PEND-.
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code) values
  ('aaaa0107-0000-4000-8000-0000000000a1', 'aaaa0107-0000-4000-8000-00000000000a', 'PEND-107-A',
   'Bodega 107 sin RIF', 'VES'),
  ('aaaa0107-0000-4000-8000-0000000000a2', 'aaaa0107-0000-4000-8000-00000000000a', '  pend-107-b',
   'Bodega 107 con el marcador en minúsculas', 'VES'),
  ('aaaa0107-0000-4000-8000-0000000000a3', 'aaaa0107-0000-4000-8000-00000000000a', 'J-107-C',
   'Bodega 107 con RIF', 'VES'),
  ('aaaa0107-0000-4000-8000-0000000000a4', 'aaaa0107-0000-4000-8000-00000000000a', 'J-PEND-107-D',
   'Bodega 107 cuyo RIF contiene PEND-', 'VES');

insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              taxpayer_type_code, person_type_code)
select ('aaaa0107-0000-4000-8000-0000000000c' || n)::uuid, 'aaaa0107-0000-4000-8000-00000000000a',
       ('aaaa0107-0000-4000-8000-0000000000a' || n)::uuid, 'J-107-PROV-' || n, 'Proveedor 107',
       'nacional', 'ordinario', 'juridica'
  from generate_series(1, 4) n;
insert into public.products (id, tenant_id, company_id, sku, name, kind, unit_code,
                             tax_category_code)
select ('aaaa0107-0000-4000-8000-00000000d00' || n)::uuid, 'aaaa0107-0000-4000-8000-00000000000a',
       ('aaaa0107-0000-4000-8000-0000000000a' || n)::uuid, 'SKU-107-' || n, 'Producto 107',
       'service', 'unidad', 'gravado_general'
  from generate_series(1, 4) n;

-- La MISMA factura en las cuatro: con soporte fiscal, 1.000 + 160 de IVA al costo.
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source,
   fiscal_support)
select ('aaaa0107-0000-4000-8000-0000000000f' || n)::uuid, 'aaaa0107-0000-4000-8000-00000000000a',
       ('aaaa0107-0000-4000-8000-0000000000a' || n)::uuid,
       ('aaaa0107-0000-4000-8000-0000000000c' || n)::uuid, 'F107-' || n, '00-107' || n,
       platform.caracas_day(now()), 'posted', now(), 1000, 160, 1160, false, 'VES', 'VES', 1,
       'identidad', true
  from generate_series(1, 4) n;
insert into public.supplier_invoice_lines
  (tenant_id, company_id, supplier_invoice_id, line_number, product_id, description, quantity,
   unit_price_transaction, unit_price_functional, line_subtotal_transaction,
   line_total_transaction, tax_amount, tax_rate_snapshot, tax_category_snapshot, tax_treatment,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id)
select 'aaaa0107-0000-4000-8000-00000000000a', ('aaaa0107-0000-4000-8000-0000000000a' || n)::uuid,
       ('aaaa0107-0000-4000-8000-0000000000f' || n)::uuid, 1,
       ('aaaa0107-0000-4000-8000-00000000d00' || n)::uuid, 'Línea', 1, 1000, 1000, 1000, 1160, 160,
       0.16, 'gravado_general', 'gravado', 1160, 'VES', 1, 1160, 'VES', 'identidad', now(),
       'purchases:document:8:HALF_UP'
  from generate_series(1, 4) n;

create function pg_temp.renglones(p_company uuid) returns int language sql as $$
  select count(*)::int from platform.purchases_book(p_company, platform.caracas_day(now()),
                                                    platform.caracas_day(now()));
$$;

select is(pg_temp.renglones('aaaa0107-0000-4000-8000-0000000000a1'), 0,
  'la empresa SIN RIF (PEND-) con una factura con soporte: 0 renglones en el libro de compras');
select is(
  (select count(*)::int from platform.purchases_book_by_rate('aaaa0107-0000-4000-8000-0000000000a1',
     platform.caracas_day(now()), platform.caracas_day(now()))), 0,
  'ni en el libro por alícuota, que lee del libro');
select is(
  (select coalesce(sum(s.documents), 0)::int
     from platform.purchases_book_summary('aaaa0107-0000-4000-8000-0000000000a1',
       platform.caracas_day(now()), platform.caracas_day(now())) s), 0,
  'ni en el resumen: ningún documento');
select is(pg_temp.renglones('aaaa0107-0000-4000-8000-0000000000a2'), 0,
  'dato hostil: el marcador en minúsculas y con espacios delante sigue siendo «sin RIF»');
select is(pg_temp.renglones('aaaa0107-0000-4000-8000-0000000000a3'), 1,
  'VARIANTE: la misma factura en la empresa CON RIF tiene su renglón — lo que filtra es el RIF');
select is(
  (select iva_al_costo from platform.purchases_book('aaaa0107-0000-4000-8000-0000000000a3',
     platform.caracas_day(now()), platform.caracas_day(now()))), 160.00000000::numeric,
  'y el renglón es el de siempre: 160 de IVA al costo (para quien tiene RIF nada cambia)');
select is(pg_temp.renglones('aaaa0107-0000-4000-8000-0000000000a4'), 1,
  'dato hostil: un RIF que solo CONTIENE «PEND-» más adelante no es el marcador: lleva libro');
select is(
  (select count(*)::int from platform.book_ledger_reconciliation('aaaa0107-0000-4000-8000-0000000000a1',
     platform.caracas_day(now()), platform.caracas_day(now())) r where not r.cuadra), 0,
  'book_ledger_reconciliation sigue en cero para la empresa sin RIF (libro vacío, IVA al costo)');
-- Se mira el RIF, no el modo: a3 no tiene régimen de facturación y lleva libro igual.
select ok(
  not exists (select 1 from public.company_fiscal_regimes r
               where r.company_id = 'aaaa0107-0000-4000-8000-0000000000a3')
  and pg_temp.renglones('aaaa0107-0000-4000-8000-0000000000a3') = 1,
  'una empresa con RIF que aún no activó la facturación SÍ lleva libro de compras');

select * from finish();
rollback;

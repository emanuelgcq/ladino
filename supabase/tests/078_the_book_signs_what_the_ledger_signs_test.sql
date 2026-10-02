-- =============================================================================
-- Ladino — pgTAP 78 · EL LIBRO FIRMA LO QUE FIRMA EL MAYOR
-- (migración 20260928120000; RESPUESTA_RECORRIDO_2026-09-24 L-01, L-07, G-10 y
--  la regla añadida a R-2 del 2026-09-28)
--
-- Tres cosas que el 074 no cubre:
--   A. el libro de VENTAS con factura, NC, ND y una ANULADA: la NC resta, la ND
--      suma, la anulada sale con su número e importes en CERO (G-10) — y el
--      total del libro es el débito de la planilla (el cruce libro↔declaración
--      que el 046 hacía aplicando el signo él mismo, L-02);
--   B. R-2 ampliada: la factura de proveedor anulada cuando su período YA está
--      cerrado y su libro ya se generó (fiscal_book_runs) o se declaró
--      (iva_period_results): ese libro no cambia, y la anulación entra en el
--      período en curso como reversa del crédito, en negativo, marcada
--      «ajuste_periodo_anterior»; la planilla la lleva en su casilla propia;
--   C. R-2 tal cual cuando el período no está cerrado ni generado, y cuando está
--      cerrado pero nadie generó ni declaró su libro: en cero, en su período.
--
-- Las fechas de B y C son RELATIVAS al día de Caracas de hoy: la anulación
-- ocurre «ahora», y el ajuste cae en el mes en curso, sea cual sea.
-- =============================================================================

begin;
select plan(25);

-- ── Fixtures comunes ─────────────────────────────────────────────────────────
insert into auth.users (id) values ('aaaa0078-0000-4000-8000-0000000000aa');
select set_config('ladino.actor_id', 'aaaa0078-0000-4000-8000-0000000000aa', true);
insert into public.tenants (id, name) values
  ('aaaa0078-0000-4000-8000-00000000000a', 'Tenant 78');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa0078-0000-4000-8000-0000000000a1', 'aaaa0078-0000-4000-8000-00000000000a',
        'J-78-A', 'Libros 78', 'VES', 'ordinario');

-- Los meses relativos: m0 = el mes en curso (Caracas); m1..m8 hacia atrás.
create temporary table mes (k int primary key, desde date, hasta date) on commit drop;
insert into mes
select k, d, (d + interval '1 month - 1 day')::date
  from (select k, (date_trunc('month', platform.caracas_day(now())) - make_interval(months => k))::date as d
          from generate_series(0, 8) k) x;

-- =============================================================================
-- A. VENTAS: factura, NC, ND y anulada (julio de 2026, fechas fijas)
-- =============================================================================
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0078-0000-4000-8000-00000000c001', 'aaaa0078-0000-4000-8000-00000000000a',
   'aaaa0078-0000-4000-8000-0000000000a1', 'J-CLI-78', 'Cliente 78', 'juridica', 'ordinario');
insert into public.products (id, tenant_id, company_id, sku, name, kind, unit_code,
                             tax_category_code) values
  ('aaaa0078-0000-4000-8000-00000000d001', 'aaaa0078-0000-4000-8000-00000000000a',
   'aaaa0078-0000-4000-8000-0000000000a1', 'SKU-78', 'Producto 78', 'good', 'unidad',
   'gravado_general');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0078-0000-4000-8000-00000000e101', 'aaaa0078-0000-4000-8000-00000000000a',
        'aaaa0078-0000-4000-8000-0000000000a1', 'formatos_libres', '2026-01-01');

-- f001 factura 1000+160 · f002 NC 500+80 sobre f001 · f003 ND 200+32 sobre f001
-- · f004 factura ANULADA 300+48 (número 2, conserva su correlativo).
-- ADR-0072 §1 (migración 20260928190100): el montaje declara el tipo de contribuyente de sus
-- empresas con RIF; sin tipo vigente la base no deja emitir factura, NC ni ND (LAD98).
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason, rules_version)
select c.tenant_id, c.id,
       case when c.taxpayer_type_code in ('ordinario', 'especial', 'formal')
            then c.taxpayer_type_code else 'ordinario' end,
       '2000-01-01', case when c.taxpayer_type_code = 'especial' then '2000-01-01'::date end,
       'Montaje pgTAP: el tipo que declara la empresa de prueba', 'pgtap'
  from public.companies c
 where c.created_at = now() and upper(btrim(c.tax_id)) not like 'PEND-%'
   and not exists (select 1 from public.company_taxpayer_types h where h.company_id = c.id);

insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version, source_document_id,
   annulled_at, annul_reason,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0078-0000-4000-8000-00000000f001', 'aaaa0078-0000-4000-8000-00000000000a',
   'aaaa0078-0000-4000-8000-0000000000a1', 'invoice', 'A', 'aaaa0078-0000-4000-8000-00000000c001',
   1, 7801, 'issued', '2026-07-05T14:00:00Z', 'aaaa0078-0000-4000-8000-00000000e101', 'test-078',
   null, null, null, 'VES', 'VES', 1, 'identidad', 1160, 1160, 1000, 160, 1160),
  ('aaaa0078-0000-4000-8000-00000000f002', 'aaaa0078-0000-4000-8000-00000000000a',
   'aaaa0078-0000-4000-8000-0000000000a1', 'credit_note', 'A',
   'aaaa0078-0000-4000-8000-00000000c001', 1, 7802, 'issued', '2026-07-06T14:00:00Z',
   'aaaa0078-0000-4000-8000-00000000e101', 'test-078', 'aaaa0078-0000-4000-8000-00000000f001',
   null, null, 'VES', 'VES', 1, 'identidad', 580, 580, 500, 80, 580),
  ('aaaa0078-0000-4000-8000-00000000f003', 'aaaa0078-0000-4000-8000-00000000000a',
   'aaaa0078-0000-4000-8000-0000000000a1', 'debit_note', 'A',
   'aaaa0078-0000-4000-8000-00000000c001', 1, 7803, 'issued', '2026-07-07T14:00:00Z',
   'aaaa0078-0000-4000-8000-00000000e101', 'test-078', 'aaaa0078-0000-4000-8000-00000000f001',
   null, null, 'VES', 'VES', 1, 'identidad', 232, 232, 200, 32, 232),
  ('aaaa0078-0000-4000-8000-00000000f004', 'aaaa0078-0000-4000-8000-00000000000a',
   'aaaa0078-0000-4000-8000-0000000000a1', 'invoice', 'A', 'aaaa0078-0000-4000-8000-00000000c001',
   2, 7804, 'annulled', '2026-07-08T14:00:00Z', 'aaaa0078-0000-4000-8000-00000000e101',
   'test-078', null, '2026-07-08T15:00:00Z', 'No salió del establecimiento',
   'VES', 'VES', 1, 'identidad', 348, 348, 300, 48, 348);
insert into public.document_lines
  (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
   unit_price_transaction, unit_price_functional, tax_rate_snapshot, tax_amount,
   line_subtotal_transaction, line_subtotal_functional, line_total_transaction,
   line_total_functional, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, rate_source, rate_timestamp, rounding_policy_id,
   tax_category_snapshot, tax_treatment)
select 'aaaa0078-0000-4000-8000-00000000000a', 'aaaa0078-0000-4000-8000-0000000000a1',
       v.doc, 1, 'aaaa0078-0000-4000-8000-00000000d001', 'Gravada', 1, v.base, v.base, 0.16,
       v.iva, v.base, v.base, v.base + v.iva, v.base + v.iva, v.base + v.iva, 'VES', 1,
       v.base + v.iva, 'VES', 'identidad', now(), 'sales:document:8:HALF_UP', 'gravado_general',
       'gravado'
  from (values ('aaaa0078-0000-4000-8000-00000000f001'::uuid, 1000::numeric, 160::numeric),
               ('aaaa0078-0000-4000-8000-00000000f002'::uuid, 500, 80),
               ('aaaa0078-0000-4000-8000-00000000f003'::uuid, 200, 32),
               ('aaaa0078-0000-4000-8000-00000000f004'::uuid, 300, 48)) v(doc, base, iva);

select is(
  (select array[base_gravada, iva_debito, total_amount]
     from platform.sales_book('aaaa0078-0000-4000-8000-0000000000a1', '2026-07-01', '2026-07-31')
    where kind = 'credit_note'),
  array[-500, -80, -580]::numeric[],
  'L-01: la NC entra al libro de ventas con base, IVA y total en NEGATIVO (criterio R-1)');

select is(
  (select array[base_gravada, iva_debito, total_amount]
     from platform.sales_book('aaaa0078-0000-4000-8000-0000000000a1', '2026-07-01', '2026-07-31')
    where kind = 'debit_note'),
  array[200, 32, 232]::numeric[],
  'la ND es un cargo más: en POSITIVO');

select is(
  (select array[document_number::numeric, base_gravada, iva_debito, base_exenta,
                base_sin_clasificar, total_amount]
     from platform.sales_book('aaaa0078-0000-4000-8000-0000000000a1', '2026-07-01', '2026-07-31')
    where status = 'annulled'),
  array[2, 0, 0, 0, 0, 0]::numeric[],
  'L-07 / G-10: la ANULADA sale con su número y TODOS sus importes en cero: se conserva, no suma');

select is(
  (select sum(iva_debito)
     from platform.sales_book('aaaa0078-0000-4000-8000-0000000000a1', '2026-07-01', '2026-07-31')),
  (select debitos from platform.recompute_iva_period('aaaa0078-0000-4000-8000-0000000000a1',
                                                     '2026-07-01', '2026-07-31', 0)),
  'L-02: la columna del libro, sumada TAL CUAL (sin signo aplicado por el test), es el débito de la planilla: 160 − 80 + 32');

select is(
  (select sum(total_amount)
     from platform.sales_book('aaaa0078-0000-4000-8000-0000000000a1', '2026-07-01', '2026-07-31')),
  812::numeric,
  'el resumen del libro (suma de la columna total) es 1160 − 580 + 232 + 0 = 812');

-- =============================================================================
-- B y C. COMPRAS: R-2 y su regla añadida
-- =============================================================================
insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              taxpayer_type_code, person_type_code)
values ('aaaa0078-0000-4000-8000-0000000000b1', 'aaaa0078-0000-4000-8000-00000000000a',
        'aaaa0078-0000-4000-8000-0000000000a1', 'J-78-PROV', 'Proveedor 78', 'nacional',
        'ordinario', 'juridica');

-- c1: m2, período CERRADO + libro de compras GENERADO   → ajuste en m0
-- c2: m3, período CERRADO + planilla DECLARADA          → ajuste en m0
-- c3: m1, período abierto, sin libro                     → R-2 tal cual
-- c4: m4, período CERRADO pero sin libro ni planilla     → R-2 tal cual
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
select v.id, 'aaaa0078-0000-4000-8000-00000000000a', 'aaaa0078-0000-4000-8000-0000000000a1',
       'aaaa0078-0000-4000-8000-0000000000b1', v.num, v.ctl, (select desde + 9 from mes where k = v.k),
       'posted', now(), 5000, 800, 5800, true, 'VES', 'VES', 1, 'identidad'
  from (values ('aaaa0078-0000-4000-8000-0000000000c1'::uuid, 'F78-1', '00-781', 2),
               ('aaaa0078-0000-4000-8000-0000000000c2'::uuid, 'F78-2', '00-782', 3),
               ('aaaa0078-0000-4000-8000-0000000000c3'::uuid, 'F78-3', '00-783', 1),
               ('aaaa0078-0000-4000-8000-0000000000c4'::uuid, 'F78-4', '00-784', 4)) v(id, num, ctl, k);

-- Los períodos contables de m2, m3 y m4, CERRADOS.
insert into public.fiscal_periods (tenant_id, company_id, year, month, status, closed_at, closed_by)
select 'aaaa0078-0000-4000-8000-00000000000a', 'aaaa0078-0000-4000-8000-0000000000a1',
       extract(year from desde)::int, extract(month from desde)::int, 'closed', now(),
       'aaaa0078-0000-4000-8000-0000000000aa'
  from mes where k in (2, 3, 4);

-- m2: el libro de compras se GENERÓ (exportación registrada).
insert into public.fiscal_book_runs
  (tenant_id, company_id, book_kind, period_from, period_to, timezone, generator_version,
   dataset_hash, row_count, format_code)
select 'aaaa0078-0000-4000-8000-00000000000a', 'aaaa0078-0000-4000-8000-0000000000a1',
       'compras', desde, hasta, 'America/Caracas', 'test', repeat('c', 64), 1,
       'csv_columnas_legales'
  from mes where k = 2;

-- m3: la planilla se DECLARÓ.
insert into public.iva_period_results
  (tenant_id, company_id, period_from, period_to, debitos, creditos, creditos_deducibles,
   prorrata_pct, retenciones_soportadas, excedente_anterior, cuota_a_pagar,
   excedente_siguiente, detalle, generator_version, dataset_hash)
select 'aaaa0078-0000-4000-8000-00000000000a', 'aaaa0078-0000-4000-8000-0000000000a1',
       desde, hasta, 0, 800, 800, null, 0, 0, 0, 800, '[]'::jsonb, 'test', repeat('d', 64)
  from mes where k = 3;

-- Las cuatro se anulan AHORA.
update public.supplier_invoices set status = 'annulled'
 where company_id = 'aaaa0078-0000-4000-8000-0000000000a1';

select is(
  (select count(*) from public.supplier_invoices
    where company_id = 'aaaa0078-0000-4000-8000-0000000000a1' and annulled_at is not null),
  4::bigint,
  'anular deja el momento de la anulación (annulled_at): es lo que decide en qué período cae');

-- ── B.1 El libro del período cerrado y generado NO cambia ───────────────────
select is(
  (select array[iva_credito, total_amount]
     from platform.purchases_book('aaaa0078-0000-4000-8000-0000000000a1',
                                  (select desde from mes where k = 2), (select hasta from mes where k = 2))
    where supplier_document_number = 'F78-1'),
  array[800, 5800]::numeric[],
  'R-2 ampliada: el libro de compras de un período cerrado y GENERADO no cambia al anular después');

select is(
  (select status
     from platform.purchases_book('aaaa0078-0000-4000-8000-0000000000a1',
                                  (select desde from mes where k = 2), (select hasta from mes where k = 2))
    where supplier_document_number = 'F78-1'),
  'posted',
  'y dice lo mismo que decía cuando se generó: registrada');

select is(
  (select creditos from platform.recompute_iva_period('aaaa0078-0000-4000-8000-0000000000a1',
     (select desde from mes where k = 3), (select hasta from mes where k = 3), 0)),
  800::numeric,
  'la planilla de un período DECLARADO tampoco cambia: una sustitutiva daría lo mismo que la original');

-- ── B.2 La anulación entra en el período en curso, en negativo, marcada ─────
select is(
  (select array_agg(supplier_document_number || ':' || iva_credito::text || ':' || invoice_date::text
                    order by supplier_document_number)
     from platform.purchases_book('aaaa0078-0000-4000-8000-0000000000a1',
                                  (select desde from mes where k = 0), (select hasta from mes where k = 0))
    where status = 'ajuste_periodo_anterior'),
  array['F78-1:-800.00000000:' || platform.caracas_day(now())::text,
        'F78-2:-800.00000000:' || platform.caracas_day(now())::text],
  'el período en curso lleva la reversa del crédito de F78-1 y F78-2: en negativo, con la fecha de la anulación, marcada «ajuste_periodo_anterior»');

select is(
  (select array[ajuste_creditos_anteriores, creditos, creditos_deducibles]
     from platform.recompute_iva_period('aaaa0078-0000-4000-8000-0000000000a1',
       (select desde from mes where k = 0), (select hasta from mes where k = 0), 0)),
  array[-1600, 0, 0]::numeric[],
  'la planilla del período en curso lleva −1.600 en su casilla de ajustes de créditos de períodos anteriores, APARTE del crédito deducible del período (migración 20260928120300)');

select is(
  (select cuota_a_pagar
     from platform.recompute_iva_period('aaaa0078-0000-4000-8000-0000000000a1',
       (select desde from mes where k = 0), (select hasta from mes where k = 0), 0)),
  1600::numeric,
  'y la casilla entra en la cuota: revertir 1.600 de crédito, sin ventas, deja 1.600 que pagar');

select is(
  (select coalesce(sum(iva_credito), 0)
     from platform.purchases_book('aaaa0078-0000-4000-8000-0000000000a1',
                                  (select desde from mes where k = 0), (select hasta from mes where k = 0))),
  (select creditos + ajuste_creditos_anteriores
     from platform.recompute_iva_period('aaaa0078-0000-4000-8000-0000000000a1',
       (select desde from mes where k = 0), (select hasta from mes where k = 0), 0)),
  'libro de compras y planilla siguen diciendo la misma cifra con el ajuste de por medio');

select is(
  (select cuadra from platform.book_ledger_reconciliation('aaaa0078-0000-4000-8000-0000000000a1',
     (select desde from mes where k = 0), (select hasta from mes where k = 0))
    where concepto = 'iva_credito_fiscal'),
  true,
  'y la conciliación del período en curso cuadra: el ajuste sin contra-asiento todavía cuenta como cola');

-- ── C. R-2 tal cual ──────────────────────────────────────────────────────────
select is(
  (select iva_credito
     from platform.purchases_book('aaaa0078-0000-4000-8000-0000000000a1',
                                  (select desde from mes where k = 1), (select hasta from mes where k = 1))
    where supplier_document_number = 'F78-3'),
  0::numeric,
  'R-2: período abierto y sin libro generado → la anulada va en CERO en su propio período');

select is(
  (select iva_credito
     from platform.purchases_book('aaaa0078-0000-4000-8000-0000000000a1',
                                  (select desde from mes where k = 4), (select hasta from mes where k = 4))
    where supplier_document_number = 'F78-4'),
  0::numeric,
  'R-2: período cerrado pero sin libro generado ni planilla → también en cero en su período');

select is(
  (select count(*)
     from platform.purchases_book('aaaa0078-0000-4000-8000-0000000000a1',
                                  (select desde from mes where k = 0), (select hasta from mes where k = 0))
    where supplier_document_number in ('F78-3', 'F78-4')),
  0::bigint,
  'y ninguna de las dos deja ajuste en el período en curso: no hay nada presentado que corregir');

-- ── Variante rota: la generación que cuenta es la del libro de COMPRAS ──────
-- c5: m5, período cerrado y con un libro GENERADO… pero el de ventas. Si la
-- regla mirara «cualquier generación», F78-5 no bajaría a cero y B.1 no estaría
-- midiendo lo que dice (sin tocar la protección append-only de fiscal_book_runs).
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
select 'aaaa0078-0000-4000-8000-0000000000c5', 'aaaa0078-0000-4000-8000-00000000000a',
       'aaaa0078-0000-4000-8000-0000000000a1', 'aaaa0078-0000-4000-8000-0000000000b1',
       'F78-5', '00-785', desde + 9, 'posted', now(), 5000, 800, 5800, true, 'VES', 'VES', 1,
       'identidad'
  from mes where k = 5;
insert into public.fiscal_periods (tenant_id, company_id, year, month, status, closed_at, closed_by)
select 'aaaa0078-0000-4000-8000-00000000000a', 'aaaa0078-0000-4000-8000-0000000000a1',
       extract(year from desde)::int, extract(month from desde)::int, 'closed', now(),
       'aaaa0078-0000-4000-8000-0000000000aa'
  from mes where k = 5;
insert into public.fiscal_book_runs
  (tenant_id, company_id, book_kind, period_from, period_to, timezone, generator_version,
   dataset_hash, row_count, format_code)
select 'aaaa0078-0000-4000-8000-00000000000a', 'aaaa0078-0000-4000-8000-0000000000a1',
       'ventas', desde, hasta, 'America/Caracas', 'test', repeat('e', 64), 0,
       'csv_columnas_legales'
  from mes where k = 5;
update public.supplier_invoices set status = 'annulled'
 where id = 'aaaa0078-0000-4000-8000-0000000000c5';
select is(
  (select iva_credito
     from platform.purchases_book('aaaa0078-0000-4000-8000-0000000000a1',
                                  (select desde from mes where k = 5), (select hasta from mes where k = 5))
    where supplier_document_number = 'F78-5'),
  0::numeric,
  'variante rota: con el libro de VENTAS generado (no el de compras), la anulada vuelve a cero — B.1 medía la generación del libro de compras');

-- ── Reabierto ANTES de anular: a la hora de anular el período estaba abierto ──
-- c6: m6 se cerró anteayer, se REABRIÓ ayer y tiene su libro de compras generado.
-- La fila conserva closed_at (K-01); lo que decide es que la reapertura cae entre
-- ese cierre y la anulación. R-2 tal cual: en cero en su período.
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
select 'aaaa0078-0000-4000-8000-0000000000c6', 'aaaa0078-0000-4000-8000-00000000000a',
       'aaaa0078-0000-4000-8000-0000000000a1', 'aaaa0078-0000-4000-8000-0000000000b1',
       'F78-6', '00-786', desde + 9, 'posted', now(), 5000, 800, 5800, true, 'VES', 'VES', 1,
       'identidad'
  from mes where k = 6;
insert into public.fiscal_periods (tenant_id, company_id, year, month, status, closed_at, closed_by,
                                   reopened_at, reopened_by, reopened_reason)
select 'aaaa0078-0000-4000-8000-00000000000a', 'aaaa0078-0000-4000-8000-0000000000a1',
       extract(year from desde)::int, extract(month from desde)::int, 'reopened',
       now() - interval '2 days', 'aaaa0078-0000-4000-8000-0000000000aa',
       now() - interval '1 day', 'aaaa0078-0000-4000-8000-0000000000aa',
       'El contador pidió corregir una compra'
  from mes where k = 6;
insert into public.fiscal_book_runs
  (tenant_id, company_id, book_kind, period_from, period_to, timezone, generator_version,
   dataset_hash, row_count, format_code)
select 'aaaa0078-0000-4000-8000-00000000000a', 'aaaa0078-0000-4000-8000-0000000000a1',
       'compras', desde, hasta, 'America/Caracas', 'test', repeat('f', 64), 1,
       'csv_columnas_legales'
  from mes where k = 6;
update public.supplier_invoices set status = 'annulled'
 where id = 'aaaa0078-0000-4000-8000-0000000000c6';
select is(
  (select iva_credito
     from platform.purchases_book('aaaa0078-0000-4000-8000-0000000000a1',
                                  (select desde from mes where k = 6), (select hasta from mes where k = 6))
    where supplier_document_number = 'F78-6'),
  0::numeric,
  'reabierto antes de anular: a esa hora el período estaba abierto, y vale R-2 tal cual aunque la fila guarde su cierre anterior');

-- ── El sello de la anulación no se elige ni se mueve (migración 20260928120200) ──
-- c7: m2 (cerrado y con libro generado). Se anula PIDIENDO un sello de 2001.
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
select 'aaaa0078-0000-4000-8000-0000000000c7', 'aaaa0078-0000-4000-8000-00000000000a',
       'aaaa0078-0000-4000-8000-0000000000a1', 'aaaa0078-0000-4000-8000-0000000000b1',
       'F78-7', '00-787', desde + 11, 'posted', now(), 5000, 800, 5800, true, 'VES', 'VES', 1,
       'identidad'
  from mes where k = 2;

select throws_ok($$
  update public.supplier_invoices set annulled_at = now()
   where id = 'aaaa0078-0000-4000-8000-0000000000c7'
$$, '23514', null,
  'una factura NO anulada no lleva sello de anulación: el CHECK lo rechaza');

update public.supplier_invoices set status = 'annulled', annulled_at = '2001-01-01T00:00:00Z'
 where id = 'aaaa0078-0000-4000-8000-0000000000c7';
select is(
  (select annulled_at from public.supplier_invoices
    where id = 'aaaa0078-0000-4000-8000-0000000000c7'),
  now(),
  'anular pidiendo un sello de 2001 deja el sello en now(): el momento no se elige');

select throws_ok($$
  update public.supplier_invoices set annulled_at = '2001-01-01T00:00:00Z'
   where id = 'aaaa0078-0000-4000-8000-0000000000c7'
$$, 'LAD06', null,
  'en una ya anulada, MOVER el sello es LAD06: movería la línea a otro libro');

select throws_ok($$
  update public.supplier_invoices set annulled_at = null
   where id = 'aaaa0078-0000-4000-8000-0000000000c7'
$$, 'LAD06', null,
  'y BORRARLO también es LAD06: sin sello, una anulación tardía volvería a R-2 tal cual');

-- ── F4: el orden en el tiempo, con instantes distintos de now() ──────────────
-- c8: m7 con libro generado, pero el período se cierra DESPUÉS de anular (dentro de un
-- minuto). A la hora de anular estaba abierto: R-2 tal cual.
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
select 'aaaa0078-0000-4000-8000-0000000000c8', 'aaaa0078-0000-4000-8000-00000000000a',
       'aaaa0078-0000-4000-8000-0000000000a1', 'aaaa0078-0000-4000-8000-0000000000b1',
       'F78-8', '00-788', desde + 9, 'posted', now(), 5000, 800, 5800, true, 'VES', 'VES', 1,
       'identidad'
  from mes where k = 7;
insert into public.fiscal_periods (tenant_id, company_id, year, month, status, closed_at, closed_by)
select 'aaaa0078-0000-4000-8000-00000000000a', 'aaaa0078-0000-4000-8000-0000000000a1',
       extract(year from desde)::int, extract(month from desde)::int, 'closed',
       now() + interval '1 minute', 'aaaa0078-0000-4000-8000-0000000000aa'
  from mes where k = 7;
insert into public.fiscal_book_runs
  (tenant_id, company_id, book_kind, period_from, period_to, timezone, generator_version,
   dataset_hash, row_count, format_code)
select 'aaaa0078-0000-4000-8000-00000000000a', 'aaaa0078-0000-4000-8000-0000000000a1',
       'compras', desde, hasta, 'America/Caracas', 'test', repeat('7', 64), 1,
       'csv_columnas_legales'
  from mes where k = 7;
update public.supplier_invoices set status = 'annulled'
 where id = 'aaaa0078-0000-4000-8000-0000000000c8';
select is(
  (select iva_credito
     from platform.purchases_book('aaaa0078-0000-4000-8000-0000000000a1',
                                  (select desde from mes where k = 7), (select hasta from mes where k = 7))
    where supplier_document_number = 'F78-8'),
  0::numeric,
  'F4 · período cerrado DESPUÉS de anular (closed_at = now() + 1 min): R-2 tal cual, en cero');

-- c9: m8 cerrado ayer; la factura se anuló hace una hora (nace anulada por SQL: es la
-- única vía de fijar un sello anterior, y la migración 120200 la deja dicha) y el libro
-- se genera AHORA, después. Nada presentado a la hora de anular: R-2 tal cual.
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, annulled_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
select 'aaaa0078-0000-4000-8000-0000000000c9', 'aaaa0078-0000-4000-8000-00000000000a',
       'aaaa0078-0000-4000-8000-0000000000a1', 'aaaa0078-0000-4000-8000-0000000000b1',
       'F78-9', '00-789', desde + 9, 'annulled', now() - interval '2 hours',
       now() - interval '1 hour', 5000, 800, 5800, true, 'VES', 'VES', 1, 'identidad'
  from mes where k = 8;
insert into public.fiscal_periods (tenant_id, company_id, year, month, status, closed_at, closed_by)
select 'aaaa0078-0000-4000-8000-00000000000a', 'aaaa0078-0000-4000-8000-0000000000a1',
       extract(year from desde)::int, extract(month from desde)::int, 'closed',
       now() - interval '1 day', 'aaaa0078-0000-4000-8000-0000000000aa'
  from mes where k = 8;
insert into public.fiscal_book_runs
  (tenant_id, company_id, book_kind, period_from, period_to, timezone, generator_version,
   dataset_hash, row_count, format_code)
select 'aaaa0078-0000-4000-8000-00000000000a', 'aaaa0078-0000-4000-8000-0000000000a1',
       'compras', desde, hasta, 'America/Caracas', 'test', repeat('8', 64), 1,
       'csv_columnas_legales'
  from mes where k = 8;
select is(
  (select iva_credito
     from platform.purchases_book('aaaa0078-0000-4000-8000-0000000000a1',
                                  (select desde from mes where k = 8), (select hasta from mes where k = 8))
    where supplier_document_number = 'F78-9'),
  0::numeric,
  'F4 · libro generado DESPUÉS de anular: a la hora de anular no había nada presentado, R-2 tal cual');

select * from finish();
rollback;

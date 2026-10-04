-- =============================================================================
-- pgTAP 111 · LA DECLARACIÓN CONVIERTE COMO EL LIBRO DE COMPRAS (AF3-09 · ADR-0075 §7 ·
-- migración 20261003190000 §2; RLIVA art. 72: el resumen del libro coincide con lo declarado)
--
-- `recompute_iva_period` NO lee del libro: suma por su cuenta. Tiene TRES conversiones a
-- bolívares — los créditos de las facturas, las notas de crédito recibidas y el ajuste de
-- períodos anteriores — y las tres tienen que ir al céntimo por documento, como
-- `purchases_book`. Aquí cada rama tiene un documento en DIVISA cuya conversión deja fracción de
-- céntimo, con cifras calculadas a mano: devolver CUALQUIERA de las tres a round(…, 8) pone
-- una aserción en rojo.
--   factura f1: IVA 3,20 USD × 36,12345679 = 115,595061728 → 115,60
--   NC e1:      IVA 1,11 USD × 36,12345679 =  40,097037037 →  40,10
--   factura f5: IVA 2,22 USD × 36,12345679 =  80,194074074 →  80,19 (anulada tras cerrar y
--               generar el libro de su período: ajuste de período anterior en el mes en curso)
-- =============================================================================
begin;
select plan(9);

insert into auth.users (id) values ('aaaa0109-0000-4000-8000-0000000000a9'),
                                   ('aaaa0109-0000-4000-8000-0000000000b1');
select set_config('ladino.actor_id', 'aaaa0109-0000-4000-8000-0000000000a9', true);
insert into public.tenants (id, name) values
  ('aaaa0109-0000-4000-8000-00000000000a', 'Tenant 109-A'),
  ('aaaa0109-0000-4000-8000-00000000000b', 'Tenant 109-B');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa0109-0000-4000-8000-0000000000a2', 'aaaa0109-0000-4000-8000-00000000000a',
        'J-109-A', 'Compras 109 A', 'VES', 'ordinario'),
       ('aaaa0109-0000-4000-8000-0000000000b2', 'aaaa0109-0000-4000-8000-00000000000b',
        'J-109-B', 'Compras 109 B', 'VES', 'ordinario');
insert into public.memberships (tenant_id, user_id) values
  ('aaaa0109-0000-4000-8000-00000000000a', 'aaaa0109-0000-4000-8000-0000000000a9'),
  ('aaaa0109-0000-4000-8000-00000000000b', 'aaaa0109-0000-4000-8000-0000000000b1');
insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              taxpayer_type_code, person_type_code)
values ('aaaa0109-0000-4000-8000-0000000000c1', 'aaaa0109-0000-4000-8000-00000000000a',
        'aaaa0109-0000-4000-8000-0000000000a2', 'J-109-PROV', 'Proveedor 109', 'nacional',
        'ordinario', 'juridica');

-- m0 = el mes en curso (Caracas); m2 = dos meses atrás.
create temporary table mes (k int primary key, desde date, hasta date) on commit drop;
insert into mes
select k, d, (d + interval '1 month - 1 day')::date
  from (select k, (date_trunc('month', platform.caracas_day(now())) - make_interval(months => k))::date as d
          from generate_series(0, 2) k) x;

insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
values
  ('aaaa0109-0000-4000-8000-0000000000f1', 'aaaa0109-0000-4000-8000-00000000000a',
   'aaaa0109-0000-4000-8000-0000000000a2', 'aaaa0109-0000-4000-8000-0000000000c1', 'F109-1',
   '00-1091', '2026-07-05', 'posted', now(), 20.00, 3.20, 23.20, true, 'USD', 'VES',
   36.12345679, 'BCV'),
  ('aaaa0109-0000-4000-8000-0000000000f5', 'aaaa0109-0000-4000-8000-00000000000a',
   'aaaa0109-0000-4000-8000-0000000000a2', 'aaaa0109-0000-4000-8000-0000000000c1', 'F109-5',
   '00-1095', (select desde + 9 from mes where k = 2), 'posted', now(), 13.88, 2.22, 16.10,
   true, 'USD', 'VES', 36.12345679, 'BCV');
insert into public.supplier_credit_notes
  (id, tenant_id, company_id, supplier_id, supplier_invoice_id, supplier_document_number,
   supplier_control_number, note_date, status, posted_at, reason, subtotal_amount, tax_amount,
   total_amount, transaction_currency, functional_currency, fx_rate, rate_source)
values ('aaaa0109-0000-4000-8000-0000000000e1', 'aaaa0109-0000-4000-8000-00000000000a',
        'aaaa0109-0000-4000-8000-0000000000a2', 'aaaa0109-0000-4000-8000-0000000000c1',
        'aaaa0109-0000-4000-8000-0000000000f1', 'NC109-1', '00-1099', '2026-07-07', 'posted',
        now(), 'Devolución parcial', 6.94, 1.11, 8.05, 'USD', 'VES', 36.12345679, 'BCV');

-- m2: período CERRADO y su libro de compras GENERADO; f5 se anula AHORA → ajuste en m0.
insert into public.fiscal_periods (tenant_id, company_id, year, month, status, closed_at, closed_by)
select 'aaaa0109-0000-4000-8000-00000000000a', 'aaaa0109-0000-4000-8000-0000000000a2',
       extract(year from desde)::int, extract(month from desde)::int, 'closed', now(),
       'aaaa0109-0000-4000-8000-0000000000a9'
  from mes where k = 2;
insert into public.fiscal_book_runs
  (tenant_id, company_id, book_kind, period_from, period_to, timezone, generator_version,
   dataset_hash, row_count, format_code)
select 'aaaa0109-0000-4000-8000-00000000000a', 'aaaa0109-0000-4000-8000-0000000000a2',
       'compras', desde, hasta, 'America/Caracas', 'test', repeat('d', 64), 1,
       'csv_columnas_legales'
  from mes where k = 2;
update public.supplier_invoices set status = 'annulled'
 where id = 'aaaa0109-0000-4000-8000-0000000000f5';

create function pg_temp.declarado(p_from date, p_to date)
returns table (creditos numeric, ajuste numeric) language sql as $$
  select d.creditos, d.ajuste_creditos_anteriores
    from platform.recompute_iva_period('aaaa0109-0000-4000-8000-0000000000a2', p_from, p_to, 0, 0) d;
$$;

-- El fixture MUERDE: las tres conversiones dejan fracción de céntimo.
select ok(
  (select bool_and(x <> round(x, 2))
     from unnest(array[3.20 * 36.12345679, 1.11 * 36.12345679, 2.22 * 36.12345679]) x),
  'las tres conversiones a bolívares dejan fracción de céntimo: si no, este test no probaría nada');

-- ── Julio: la rama de las facturas y la de las notas de crédito ─────────────
select is((select creditos from pg_temp.declarado('2026-07-01', '2026-07-31')), 75.50::numeric,
  'créditos de julio, A MANO: 115,60 (factura) − 40,10 (nota de crédito) = 75,50, cada documento al céntimo');
select is(
  (select creditos from pg_temp.declarado('2026-07-01', '2026-07-31')),
  (select sum(iva_credito) from platform.purchases_book('aaaa0109-0000-4000-8000-0000000000a2',
                                                        '2026-07-01', '2026-07-31')),
  'y es EXACTAMENTE el crédito del libro de compras de julio (RLIVA art. 72)');
select isnt(
  (select creditos from pg_temp.declarado('2026-07-01', '2026-07-31')),
  round(3.20 * 36.12345679, 8) - round(1.11 * 36.12345679, 8),
  'variante rota: a 8 decimales daría 75,49802469 — la declaración ya no convierte así');
select is(
  (select array_agg(iva_credito order by iva_credito)
     from platform.purchases_book('aaaa0109-0000-4000-8000-0000000000a2', '2026-07-01', '2026-07-31')),
  array[-40.10, 115.60]::numeric[],
  'el libro de julio trae la factura en positivo y la NC en negativo, las dos al céntimo');

-- ── El mes en curso: la rama del ajuste de períodos anteriores ──────────────
select is(
  (select ajuste from pg_temp.declarado((select desde from mes where k = 0),
                                        (select hasta from mes where k = 0))),
  -80.19::numeric,
  'ajuste de períodos anteriores, A MANO: −round(2,22 × 36,12345679, 2) = −80,19 (a 8 daría −80,19407407)');
select is(
  (select ajuste from pg_temp.declarado((select desde from mes where k = 0),
                                        (select hasta from mes where k = 0))),
  (select sum(iva_credito)
     from platform.purchases_book('aaaa0109-0000-4000-8000-0000000000a2',
                                  (select desde from mes where k = 0),
                                  (select hasta from mes where k = 0))
    where status = 'ajuste_periodo_anterior'),
  'y es el renglón «ajuste_periodo_anterior» del libro del mes en curso');
select is(
  (select creditos from pg_temp.declarado((select desde from mes where k = 2),
                                          (select hasta from mes where k = 2))),
  80.19::numeric,
  'en su propio período, ya cerrado y generado, la anulada tarde sigue contando: 80,19, como salió en su libro');

-- ── Aislamiento ─────────────────────────────────────────────────────────────
set local role ladino_api;
select set_config('ladino.actor_id', 'aaaa0109-0000-4000-8000-0000000000b1', true);
select is(
  (select d.creditos from platform.recompute_iva_period(
     'aaaa0109-0000-4000-8000-0000000000a2', '2026-07-01', '2026-07-31', 0, 0) d),
  0::numeric, 'el actor de OTRO tenant no declara los créditos de esta empresa: cero');
reset role;

select * from finish();
rollback;

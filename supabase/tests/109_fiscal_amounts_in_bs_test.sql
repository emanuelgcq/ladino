-- =============================================================================
-- pgTAP 109 · EL FISCAL EN Bs SALE DE LA BASE EN Bs (ADR-0075 §1, E-05 · migración 20261003170000)
--
--   · fiscal_amount_gaps da cero con un documento en Bs y con uno en USD calculado por la regla:
--     base_bs = round(base_usd × tasa, 2) · iva_bs = round(base_bs × alícuota, 2) · total = suma;
--   · y las VARIANTES ROTAS, cada una por su nombre:
--       - el IVA convertido desde el IVA en divisa (la regla vieja)  → line_tax_is_not_rate_times_base
--       - un pie que no es la suma de sus líneas                     → *_is_not_the_sum_of_lines
--       - un total en divisa que no corresponde al funcional         → conversion_beyond_line_rounding
--   · el corte va en el enunciado: lo anterior al corte no cuenta, sin lista de perdones;
--   · settlement_ledger_open: NULL para un lado que no existe y para un documento sin asiento.
-- =============================================================================
begin;
select plan(19);

insert into auth.users (id) values ('aaaa0106-0000-4000-8000-0000000000aa');
select set_config('ladino.actor_id', 'aaaa0106-0000-4000-8000-0000000000aa', true);
insert into public.tenants (id, name) values
  ('aaaa0106-0000-4000-8000-00000000000a', 'Tenant 106');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-00000000000a',
        'J-106-A', 'Ferretería 106', 'VES', 'ordinario');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0106-0000-4000-8000-00000000c001', 'aaaa0106-0000-4000-8000-00000000000a',
   'aaaa0106-0000-4000-8000-0000000000a1', 'J-CLI-106', 'Constructora 106', 'juridica',
   'ordinario');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code) values
  ('aaaa0106-0000-4000-8000-00000000d001', 'aaaa0106-0000-4000-8000-00000000000a',
   'aaaa0106-0000-4000-8000-0000000000a1', 'SKU-106', 'Brocha 106', 'service', 'active', 'unidad',
   'gravado_general');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0106-0000-4000-8000-00000000e101', 'aaaa0106-0000-4000-8000-00000000000a',
        'aaaa0106-0000-4000-8000-0000000000a1', 'formatos_libres', '2026-01-01');
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, reason, rules_version)
values ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a1',
        'ordinario', '2000-01-01', 'pgTAP 106', 'pgtap');

-- Un documento de una línea. Los importes del pie y los de la línea se dan por separado para
-- poder romper cada cosa por su nombre.
create function pg_temp.doc(
  p_id uuid, p_kind text, p_numero bigint, p_moneda text, p_tasa numeric,
  p_total_tx numeric, p_base numeric, p_iva numeric, p_total numeric,
  p_linea_base numeric, p_linea_total numeric, p_alicuota numeric default 0.16)
returns void language plpgsql as $$
begin
  insert into public.documents
    (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
     status, issued_at, regime_version_id, rules_version,
     transaction_currency, functional_currency, fx_rate, rate_source,
     amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
  values
    (p_id, 'aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a1',
     p_kind, 'A', 'aaaa0106-0000-4000-8000-00000000c001', p_numero,
     10600 + p_numero,
     'issued', now(),
     'aaaa0106-0000-4000-8000-00000000e101'::uuid,
     'test-106', p_moneda, 'VES', p_tasa, 'pgtap', p_total_tx, p_total, p_base, p_iva, p_total);
  insert into public.document_lines
    (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
     unit_price_transaction, unit_price_functional, tax_rate_snapshot, tax_amount,
     line_subtotal_transaction, line_subtotal_functional, line_total_transaction,
     line_total_functional, amount_transaction_currency, transaction_currency, fx_rate,
     functional_amount, functional_currency, rate_source, rate_timestamp, rounding_policy_id,
     tax_category_snapshot, tax_treatment)
  values
    ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a1', p_id, 1,
     'aaaa0106-0000-4000-8000-00000000d001', 'Brocha', 1, p_total_tx, p_linea_base, p_alicuota,
     0, p_total_tx, p_linea_base, p_total_tx, p_linea_total, p_total_tx, p_moneda, p_tasa,
     p_linea_total, 'VES', 'pgtap', now(), 'sales:document:2:HALF_UP',
     'gravado_general', 'gravado');
end $$;

create function pg_temp.problemas() returns text language sql as $$
  select coalesce(string_agg(distinct problem, ',' order by problem), '')
    from platform.fiscal_amount_gaps('aaaa0106-0000-4000-8000-0000000000a1')
$$;

-- 1. Bien calculados: uno en Bs, uno en USD por la regla nueva (la línea «Brocha» de E-05:
--    9,60 USD a 854,4637 → base 8.202,85; IVA 16 % de ESA base = 1.312,46; total 9.515,31;
--    la contraprestación son 11,14 USD).
select pg_temp.doc('aaaa0106-0000-4000-8000-00000000f001', 'invoice', 1, 'VES', 1,
                   1160, 1000, 160, 1160, 1000, 1160);
select pg_temp.doc('aaaa0106-0000-4000-8000-00000000f002', 'invoice', 2, 'USD', 854.4637,
                   11.14, 8202.85, 1312.46, 9515.31, 8202.85, 9515.31);
select is(pg_temp.problemas(), '', 'un documento en Bs y uno en USD por la regla nueva: cero');
select is(round(8202.85 * 0.16, 2), 1312.46,
  'la cifra del hallazgo: el 16 % de 8.202,85 es 1.312,46, no 1.315,87');

-- 2. VARIANTE ROTA · la regla vieja: IVA = IVA en divisa ya redondeado × tasa (1,54 × 854,4637).
select pg_temp.doc('aaaa0106-0000-4000-8000-00000000f003', 'invoice', 3, 'USD', 854.4637,
                   11.14, 8202.85, 1315.87, 9518.72, 8202.85, 9518.72);
select is(pg_temp.problemas(), 'line_tax_is_not_rate_times_base',
  'rota: el IVA convertido desde el IVA en divisa lo caza la regla de la línea, por su nombre');
select is((select expected from platform.fiscal_amount_gaps('aaaa0106-0000-4000-8000-0000000000a1')
            where document_id = 'aaaa0106-0000-4000-8000-00000000f003'), 1312.46,
  'y dice cuánto debía ser');

-- 3. VARIANTE ROTA · un pie que no es la suma de sus líneas (la línea está bien).
select pg_temp.doc('aaaa0106-0000-4000-8000-00000000f004', 'invoice', 4, 'USD', 854.4637,
                   11.14, 8202.85, 1312.47, 9515.32, 8202.85, 9515.31);
select is((select string_agg(problem, ',' order by problem)
             from platform.fiscal_amount_gaps('aaaa0106-0000-4000-8000-0000000000a1')
            where document_id = 'aaaa0106-0000-4000-8000-00000000f004'),
  'tax_is_not_the_sum_of_lines,total_is_not_the_sum_of_lines',
  'rota: un pie que no suma sus líneas sale por IVA y por total');

-- 4. VARIANTE ROTA · el total en divisa no corresponde: 12,00 USD contra 9.515,31 Bs.
--    Y el borde que SÍ se tolera: 11,14 USD × tasa = 9.518,73, a 3,42 Bs del total — es el
--    redondeo del IVA al céntimo de dólar (media unidad × tasa = 4,27) y no es un hueco (doc f002).
select pg_temp.doc('aaaa0106-0000-4000-8000-00000000f005', 'invoice', 5, 'USD', 854.4637,
                   12.00, 8202.85, 1312.46, 9515.31, 8202.85, 9515.31);
select is((select string_agg(problem, ',' order by problem)
             from platform.fiscal_amount_gaps('aaaa0106-0000-4000-8000-0000000000a1')
            where document_id = 'aaaa0106-0000-4000-8000-00000000f005'),
  'conversion_beyond_line_rounding',
  'rota: 12,00 USD no son 9.515,31 Bs a 854,4637 — más allá del redondeo por línea');
select is((select count(*) from platform.fiscal_amount_gaps('aaaa0106-0000-4000-8000-0000000000a1')
            where document_id = 'aaaa0106-0000-4000-8000-00000000f002'), 0::bigint,
  'el redondeo del IVA al céntimo de dólar (3,42 Bs en esta línea) está dentro de la tolerancia');

-- 5. El corte va en el ENUNCIADO: lo emitido antes del corte no cuenta, y no hay lista de perdones.
select is((select count(*) from platform.invariant_cutoffs
            where invariant in ('fiscal_amount_gaps', 'settled_ledger_gaps')), 2::bigint,
  'los dos invariantes declaran su corte');
update platform.invariant_cutoffs set since = now() + interval '1 hour'
 where invariant = 'fiscal_amount_gaps';
select is(pg_temp.problemas(), '', 'con el corte después, los mismos documentos rotos no cuentan');
update platform.invariant_cutoffs set since = now() - interval '1 hour'
 where invariant = 'fiscal_amount_gaps';
select isnt(pg_temp.problemas(), '', 'y con el corte antes, vuelven a contar');

-- 6. settlement_ledger_open no inventa: sin asiento (o con un lado que no existe) responde NULL,
--    y el invariante settled_ledger_gaps salta lo que el mayor no puede responder.
select is((select platform.settlement_ledger_open('aaaa0106-0000-4000-8000-0000000000a1', 'ar',
                                                  'aaaa0106-0000-4000-8000-00000000f001')
             is null
           and platform.settlement_ledger_open('aaaa0106-0000-4000-8000-0000000000a1', 'zz',
                                               'aaaa0106-0000-4000-8000-00000000f001')
             is null), true,
  'settlement_ledger_open: NULL sin asiento y NULL para un lado que no existe');

-- 7. EL BORDE de la tolerancia de conversión, por los dos lados (una línea a 854,4637: media
--    unidad mínima × tasa + 0,01 = 4,2823185). El caso 4 solo probaba 3,42 (dentro) y 738 (fuera).
--      11,14101 USD × tasa − 9.515,31 = 4,2784 → dentro;   11,14102 → 4,2869 → fuera.
select pg_temp.doc('aaaa0106-0000-4000-8000-00000000f006', 'invoice', 6, 'USD', 854.4637,
                   11.14101, 8202.85, 1312.46, 9515.31, 8202.85, 9515.31);
select pg_temp.doc('aaaa0106-0000-4000-8000-00000000f007', 'invoice', 7, 'USD', 854.4637,
                   11.14102, 8202.85, 1312.46, 9515.31, 8202.85, 9515.31);
select is((select count(*) from platform.fiscal_amount_gaps('aaaa0106-0000-4000-8000-0000000000a1')
            where document_id = 'aaaa0106-0000-4000-8000-00000000f006'), 0::bigint,
  'el borde, por dentro: 4,2784 Bs de separación (≤ 4,2823) no es un hueco');
select is((select string_agg(problem, ',') from platform.fiscal_amount_gaps('aaaa0106-0000-4000-8000-0000000000a1')
            where document_id = 'aaaa0106-0000-4000-8000-00000000f007'),
  'conversion_beyond_line_rounding',
  'el borde, por fuera: 4,2869 Bs (> 4,2823) sí lo es — la tolerancia corta donde dice');

-- 8. settlement_ledger_open CON ASIENTO devuelve una CIFRA (migración 20261003200000), en moneda
--    funcional, y no se queda en NULL por un cobro reversado que nunca llegó al mayor.
--    Una factura de 11,60 USD a 40 = 464,00 Bs, con su línea de cuentas por cobrar EN DIVISA
--    (importe 11,60 USD; funcional 464,00), como las escribirá el mayor en divisa.
insert into public.accounts (id, tenant_id, company_id, code, name, kind, nature, is_leaf, level)
values
  ('aaaa0106-0000-4000-8000-0000000ac001', 'aaaa0106-0000-4000-8000-00000000000a',
   'aaaa0106-0000-4000-8000-0000000000a1', '1.1.03.109', 'Cuentas por cobrar 109', 'activo',
   'deudora', true, 1),
  ('aaaa0106-0000-4000-8000-0000000ac002', 'aaaa0106-0000-4000-8000-00000000000a',
   'aaaa0106-0000-4000-8000-0000000000a1', '4.1.01.109', 'Ventas 109', 'ingreso', 'acreedora',
   true, 1);
insert into public.company_account_settings (tenant_id, company_id, purpose, account_id) values
  ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a1', 'ar_general',
   'aaaa0106-0000-4000-8000-0000000ac001');
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0106-0000-4000-8000-00000000ca01', 'aaaa0106-0000-4000-8000-00000000000a',
   'aaaa0106-0000-4000-8000-0000000000a1', 'Caja USD 109', 'USD', 'cash');
select pg_temp.doc('aaaa0106-0000-4000-8000-00000000f008', 'invoice', 8, 'USD', 40,
                   11.60, 400, 64, 464, 400, 464);

-- Un asiento posteado de dos líneas: la de cuentas por cobrar y su contrapartida en Ventas.
-- p_cxc_debe: la CxC al debe (la factura) o al haber (el cobro). p_tx: el importe en divisa.
create function pg_temp.asiento(
  p_kind text, p_source uuid, p_event text, p_cxc_debe boolean, p_tx numeric, p_func numeric)
returns void language plpgsql as $$
declare v_e uuid;
begin
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
     description, rules_version)
  values ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a1',
          platform.period_for_date('aaaa0106-0000-4000-8000-0000000000a1',
                                   platform.caracas_day(now())),
          platform.caracas_day(now()), p_kind, p_source, p_event, 'Montaje pgTAP 109', 'pgtap-109')
  returning id into v_e;
  insert into public.journal_lines
    (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit)
  values
    ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a1', v_e, 1,
     'aaaa0106-0000-4000-8000-0000000ac001',
     case when p_cxc_debe then p_tx else 0 end, case when p_cxc_debe then 0 else p_tx end,
     p_tx, 'USD', p_func / p_tx, p_func, 'VES', 'BCV test', now(),
     case when p_cxc_debe then p_func else 0 end, case when p_cxc_debe then 0 else p_func end),
    ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a1', v_e, 2,
     'aaaa0106-0000-4000-8000-0000000ac002',
     case when p_cxc_debe then 0 else p_func end, case when p_cxc_debe then p_func else 0 end,
     p_func, 'VES', 1, p_func, 'VES', 'identidad', now(),
     case when p_cxc_debe then 0 else p_func end, case when p_cxc_debe then p_func else 0 end);
  update public.journal_entries
     set status = 'posted', posted_at = now(), posted_by = 'aaaa0106-0000-4000-8000-0000000000aa',
         entry_number = platform.claim_entry_number(
           'aaaa0106-0000-4000-8000-0000000000a1',
           extract(year from platform.caracas_day(now()))::int)
   where id = v_e;
end $$;

create function pg_temp.abierto() returns numeric language sql as $$
  select platform.settlement_ledger_open('aaaa0106-0000-4000-8000-0000000000a1', 'ar',
                                         'aaaa0106-0000-4000-8000-00000000f008')
$$;

-- LA VARIANTE ROTA: la definición anterior (20261003180000 §8), copiada tal cual con otro nombre.
-- Si con ella los casos de abajo dieran lo mismo, las aserciones no medirían la migración.
create function pg_temp.abierto_180000(p_company uuid, p_side text, p_document uuid)
returns numeric language sql stable as $$
  with piezas as (
    select d.id, 'documento'::text as clase, d.journal_entry_id as entry_id
      from public.documents d
     where p_side = 'ar' and d.company_id = p_company and d.id = p_document
    union all
    select p.id, 'payment_received', p.journal_entry_id
      from public.payments p
     where p_side = 'ar' and p.company_id = p_company and p.document_id = p_document
  ),
  asientos as (
    select z.id as pieza, z.entry_id from piezas z where z.entry_id is not null
    union
    select z.id, e.id
      from piezas z
      join public.journal_entries e
        on e.company_id = p_company and e.source_id = z.id and e.status in ('posted', 'reversed')
       and e.is_reversal_of is null
       and (z.clase = 'documento' or e.source_kind = z.clase)
  )
  select case
           when not exists (select 1 from piezas) then null
           when exists (select 1 from piezas z
                         where not exists (select 1 from asientos a where a.pieza = z.id))
             then null
           else (
             select coalesce(sum(l.debit_amount - l.credit_amount), 0)
               from public.journal_lines l
               join public.journal_entries e on e.id = l.entry_id
              where l.company_id = p_company
                and e.status in ('posted', 'reversed')
                and (e.id in (select entry_id from asientos)
                     or e.is_reversal_of in (select entry_id from asientos))
                and l.account_id in (
                      select s.account_id from public.company_account_settings s
                       where s.company_id = p_company and s.purpose = 'ar_general'))
         end
$$;

select pg_temp.asiento('sales_invoice', 'aaaa0106-0000-4000-8000-00000000f008',
                       'sales.invoice_issued', true, 11.60, 464);
select is(pg_temp.abierto(), 464::numeric,
  'con asiento devuelve una CIFRA, y en moneda funcional: 464,00 Bs, no los 11,60 USD de la línea');
select is(pg_temp.abierto_180000('aaaa0106-0000-4000-8000-0000000000a1', 'ar',
                                 'aaaa0106-0000-4000-8000-00000000f008'), 11.60::numeric,
  'ROTA: la definición anterior suma el importe de la transacción y responde 11,60');

-- Un cobro de 5 USD cuyo asiento está en la cola: el mayor todavía no puede responder.
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values ('aaaa0106-0000-4000-8000-00000000e001', 'aaaa0106-0000-4000-8000-00000000000a',
        'aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-00000000f008',
        now(), 'USD', 5, 40, 'BCV test', now(), 200, 'efectivo_usd',
        'aaaa0106-0000-4000-8000-00000000ca01');
select is(pg_temp.abierto(), null::numeric,
  'un cobro VIVO sin asiento (en la cola): NULL, el mayor no puede responder todavía');

-- Se reversa ese cobro: la reversa descarta la fila de cola y no postea nada. Ya no es una pieza.
insert into public.payment_reversals
  (tenant_id, company_id, payment_id, document_id, reason, currency, amount, functional_amount)
values ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a1',
        'aaaa0106-0000-4000-8000-00000000e001', 'aaaa0106-0000-4000-8000-00000000f008',
        'El efectivo era de otra factura', 'USD', 5, 200);
select is(pg_temp.abierto(), 464::numeric,
  'el cobro REVERSADO que nunca tuvo asiento no es una pieza: la función vuelve a dar la cifra');
select is(pg_temp.abierto_180000('aaaa0106-0000-4000-8000-0000000000a1', 'ar',
                                 'aaaa0106-0000-4000-8000-00000000f008'), null::numeric,
  'ROTA: con la definición anterior ese documento respondía NULL para siempre (invariante inerte)');

-- Y un cobro vivo CON asiento baja la cifra: 464,00 − 200,00.
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values ('aaaa0106-0000-4000-8000-00000000e002', 'aaaa0106-0000-4000-8000-00000000000a',
        'aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-00000000f008',
        now(), 'USD', 5, 40, 'BCV test', now(), 200, 'efectivo_usd',
        'aaaa0106-0000-4000-8000-00000000ca01');
select pg_temp.asiento('payment_received', 'aaaa0106-0000-4000-8000-00000000e002',
                       'ar.payment_applied', false, 5, 200);
select is(pg_temp.abierto(), 264::numeric,
  'con el asiento de un cobro vivo: lo que el mayor todavía carga es 464,00 − 200,00');

select * from finish();
rollback;

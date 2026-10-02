-- =============================================================================
-- Ladino — pgTAP 89 · UN DOCUMENTO, UNA FORMA LIBRE, CON EL ADQUIRENTE IDENTIFICADO
-- Migraciones 20260928180300, 20260928190400 y 20260928190500 (auditoría fiscal 2026-10-02 y
-- su revisión: A-2, A-3, A-4/A-6, A-5, F3).
--
--   1. `company_settings.rows_per_free_form` (art. 33, en FILAS): nace en 15, el CHECK rechaza 0
--      y 19 (23514), y SIN el CHECK entran (variante rota);
--   2. la FACTURA sobre forma libre (art. 13.7, P-57): LAD99 al «Consumidor final», a un cliente
--      sin documento y al marcador PEND-; se emite con RIF o cédula; lo congelado manda sobre lo
--      vivo; SIN el bloque, la del Consumidor final entra (variante rota);
--   3. la NC y la ND (A-4/A-6): identifican como la factura que corrigen — la NC de una factura al
--      «Consumidor final» se emite; la ND a OTRO cliente, o con otra identificación congelada, LAD99;
--   4. la CONTINGENCIA (A-3): la factura de un talonario de contingency_ranges al «Consumidor
--      final» se registra;
--   5. el RECIBO (régimen internal_only) al «Consumidor final» no se ve afectado;
--   6. la definición viva conserva LAD98 (tipo de contribuyente, 190100).
-- =============================================================================

begin;
select plan(18);

insert into auth.users (id) values ('aaaa0089-0000-4000-8000-0000000000e1');
insert into public.tenants (id, name) values ('aaaa0089-0000-4000-8000-00000000000a', 'Tenant 89');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code) values
  ('aaaa0089-0000-4000-8000-0000000000a1', 'aaaa0089-0000-4000-8000-00000000000a',
   'J408900001', 'Empresa 89', 'VES'),
  ('aaaa0089-0000-4000-8000-0000000000a2', 'aaaa0089-0000-4000-8000-00000000000a',
   'PEND-89', 'Bodega 89 sin RIF', 'VES');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                              taxpayer_type_code, is_system) values
  ('aaaa0089-0000-4000-8000-0000000000c1', 'aaaa0089-0000-4000-8000-00000000000a',
   'aaaa0089-0000-4000-8000-0000000000a1', null, 'Consumidor final', 'natural',
   'consumidor_final', true),
  ('aaaa0089-0000-4000-8000-0000000000c2', 'aaaa0089-0000-4000-8000-00000000000a',
   'aaaa0089-0000-4000-8000-0000000000a1', 'J408900002', 'Cliente con RIF', 'juridica',
   'ordinario', false),
  ('aaaa0089-0000-4000-8000-0000000000c3', 'aaaa0089-0000-4000-8000-00000000000a',
   'aaaa0089-0000-4000-8000-0000000000a1', 'V12345678', 'María Pérez', 'natural',
   'consumidor_final', false),
  ('aaaa0089-0000-4000-8000-0000000000c4', 'aaaa0089-0000-4000-8000-00000000000a',
   'aaaa0089-0000-4000-8000-0000000000a1', null, 'Sin documento', 'natural',
   'consumidor_final', false),
  ('aaaa0089-0000-4000-8000-0000000000c5', 'aaaa0089-0000-4000-8000-00000000000a',
   'aaaa0089-0000-4000-8000-0000000000a1', 'PEND-X1', 'Con marcador', 'natural',
   'consumidor_final', false),
  ('aaaa0089-0000-4000-8000-0000000000c9', 'aaaa0089-0000-4000-8000-00000000000a',
   'aaaa0089-0000-4000-8000-0000000000a2', null, 'Consumidor final', 'natural',
   'consumidor_final', true);
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0089-0000-4000-8000-0000000000f1', 'aaaa0089-0000-4000-8000-00000000000a',
        'aaaa0089-0000-4000-8000-0000000000a1', 'formatos_libres', '2026-01-01'),
       ('aaaa0089-0000-4000-8000-0000000000f2', 'aaaa0089-0000-4000-8000-00000000000a',
        'aaaa0089-0000-4000-8000-0000000000a2', 'sin_facturacion', '2026-01-01');
select set_config('ladino.actor_id', 'aaaa0089-0000-4000-8000-0000000000e1', true);
insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                           effective_from, reason, rules_version)
values ('aaaa0089-0000-4000-8000-00000000000a', 'aaaa0089-0000-4000-8000-0000000000a1',
        'ordinario', '2026-01-01', 'Declaración del dueño', 'v1');
insert into public.company_settings (company_id, tenant_id) values
  ('aaaa0089-0000-4000-8000-0000000000a1', 'aaaa0089-0000-4000-8000-00000000000a');

-- El talonario de contingencia (PA 102): su serie es «contingencia…» y tiene su registro.
insert into public.fiscal_number_ranges
  (id, tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
values ('aaaa0089-0000-4000-8000-0000000000b1', 'aaaa0089-0000-4000-8000-00000000000a',
        'aaaa0089-0000-4000-8000-0000000000a1', null, 'contingencia-89', 1, 50, 1,
        'Talonario físico 89');
insert into public.contingency_ranges (tenant_id, company_id, fiscal_number_range_id, reason,
                                       failure_started_at)
values ('aaaa0089-0000-4000-8000-00000000000a', 'aaaa0089-0000-4000-8000-0000000000a1',
        'aaaa0089-0000-4000-8000-0000000000b1', 'Falla de internet', '2026-09-20 08:00-04');

-- Emite un documento directo en `issued` (el trigger juzga): clase, serie, cliente, origen y la
-- identificación congelada (null = la toma del maestro vivo).
create function pg_temp.emitir(p_id uuid, p_n int, p_kind text, p_series text, p_cliente uuid,
                               p_origen uuid default null, p_nombre text default null,
                               p_documento text default null,
                               p_empresa uuid default 'aaaa0089-0000-4000-8000-0000000000a1',
                               p_regimen uuid default 'aaaa0089-0000-4000-8000-0000000000f1',
                               p_control int default -1) returns void
language sql as $$
  insert into public.documents
    (id, tenant_id, company_id, kind, series, customer_id, source_document_id, status, issued_at,
     document_number, control_number, regime_version_id, rules_version,
     transaction_currency, functional_currency, fx_rate, rate_source,
     amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount,
     customer_name_snapshot, customer_tax_id_snapshot)
  values (p_id, 'aaaa0089-0000-4000-8000-00000000000a', p_empresa, p_kind, p_series, p_cliente,
          p_origen, 'issued', '2026-09-20 10:00-04', p_n,
          case when p_control = -1 then p_n when p_control = 0 then null else p_control end,
          p_regimen, 'test-089', 'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116,
          p_nombre, p_documento);
$$;

-- ── 1. El tope, en filas ─────────────────────────────────────────────────────
select is((select rows_per_free_form from public.company_settings
            where company_id = 'aaaa0089-0000-4000-8000-0000000000a1'),
  15, 'el tope nace en 15 filas (medido: caben 22; holgura para las notas)');
select throws_ok($$ update public.company_settings set rows_per_free_form = 0
                     where company_id = 'aaaa0089-0000-4000-8000-0000000000a1' $$,
  '23514', null, 'un tope de 0 filas no es un tope');
select throws_ok($$ update public.company_settings set rows_per_free_form = 19
                     where company_id = 'aaaa0089-0000-4000-8000-0000000000a1' $$,
  '23514', null, 'más de 18 filas no caben con holgura en una forma libre (art. 33)');
savepoint roto_tope;
alter table public.company_settings drop constraint company_settings_rows_per_free_form_chk;
select lives_ok($$ update public.company_settings set rows_per_free_form = 19
                    where company_id = 'aaaa0089-0000-4000-8000-0000000000a1' $$,
  'SIN el CHECK, 19 entra: el throws_ok medía el CHECK');
rollback to savepoint roto_tope;

-- ── 2. La factura ────────────────────────────────────────────────────────────
select throws_ok($$ select pg_temp.emitir('aaaa0089-0000-4000-8000-0000000000d1', 1, 'invoice', 'A',
                                           'aaaa0089-0000-4000-8000-0000000000c1') $$,
  'LAD99', null, 'sobre forma libre, una factura al «Consumidor final» se rechaza (art. 13.7)');
select throws_ok($$ select pg_temp.emitir('aaaa0089-0000-4000-8000-0000000000d2', 2, 'invoice', 'A',
                                           'aaaa0089-0000-4000-8000-0000000000c4') $$,
  'LAD99', null, 'ni a un cliente con nombre y sin RIF, cédula o pasaporte');
select throws_ok($$ select pg_temp.emitir('aaaa0089-0000-4000-8000-0000000000d5', 5, 'invoice', 'A',
                                           'aaaa0089-0000-4000-8000-0000000000c5') $$,
  'LAD99', null, 'ni con el marcador PEND- por documento');
select lives_ok($$ select pg_temp.emitir('aaaa0089-0000-4000-8000-0000000000d3', 3, 'invoice', 'A',
                                          'aaaa0089-0000-4000-8000-0000000000c2') $$,
  'a un cliente con RIF, la factura se emite');
select lives_ok($$ select pg_temp.emitir('aaaa0089-0000-4000-8000-0000000000d4', 4, 'invoice', 'A',
                                          'aaaa0089-0000-4000-8000-0000000000c3') $$,
  'a una persona natural con nombre y cédula, también');
select lives_ok($$ select pg_temp.emitir('aaaa0089-0000-4000-8000-0000000000d6', 6, 'invoice', 'A',
                                          'aaaa0089-0000-4000-8000-0000000000c4', null,
                                          'Pedro Gómez', 'V7654321') $$,
  'lo CONGELADO manda sobre lo vivo: el maestro sin documento, la factura con nombre y cédula');

savepoint roto;
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('platform.assert_document_issuance()'::regprocedure);
  v_def := regexp_replace(v_def,
    'if v_regime\.numbering_mode = ''range''\s+and new\.kind = any.*?end if;\s*end if;\s*end if;',
    '', '');
  execute v_def;
end $$;
select lives_ok($$ select pg_temp.emitir('aaaa0089-0000-4000-8000-0000000000d9', 9, 'invoice', 'A',
                                          'aaaa0089-0000-4000-8000-0000000000c1') $$,
  'SIN el bloque del adquirente, la factura al Consumidor final entra: el throws_ok medía LAD99');
rollback to savepoint roto;

-- ── 4. La contingencia (A-3), que además sirve de factura al «Consumidor final» para 3 ───────
select lives_ok($$ select pg_temp.emitir('aaaa0089-0000-4000-8000-0000000000e9', 1, 'invoice',
                                          'contingencia-89',
                                          'aaaa0089-0000-4000-8000-0000000000c1') $$,
  'A-3: la factura de contingencia al «Consumidor final» se registra (refleja el papel)');

-- ── 3. Las notas (A-4/A-6) ───────────────────────────────────────────────────
select lives_ok($$ select pg_temp.emitir('aaaa0089-0000-4000-8000-0000000000e1', 20, 'credit_note',
                                          'A', 'aaaa0089-0000-4000-8000-0000000000c1',
                                          'aaaa0089-0000-4000-8000-0000000000e9') $$,
  'la NC de una factura al «Consumidor final» se emite: identifica como la factura');
select lives_ok($$ select pg_temp.emitir('aaaa0089-0000-4000-8000-0000000000e2', 21, 'debit_note',
                                          'A', 'aaaa0089-0000-4000-8000-0000000000c2',
                                          'aaaa0089-0000-4000-8000-0000000000d3') $$,
  'la ND de una factura con RIF, al mismo cliente, se emite');
select throws_ok($$ select pg_temp.emitir('aaaa0089-0000-4000-8000-0000000000e3', 22, 'debit_note',
                                           'A', 'aaaa0089-0000-4000-8000-0000000000c3',
                                           'aaaa0089-0000-4000-8000-0000000000d3') $$,
  'LAD99', null, 'la ND a OTRO cliente que el de la factura se rechaza');
select throws_ok($$ select pg_temp.emitir('aaaa0089-0000-4000-8000-0000000000e4', 23, 'credit_note',
                                           'A', 'aaaa0089-0000-4000-8000-0000000000c4',
                                           'aaaa0089-0000-4000-8000-0000000000d6',
                                           'Otro nombre', 'V7654321') $$,
  'LAD99', null, 'la NC con OTRA identificación congelada que la de la factura se rechaza');

-- ── 5. El recibo no se ve afectado ───────────────────────────────────────────
select lives_ok($$ select pg_temp.emitir('aaaa0089-0000-4000-8000-0000000000f9', 1, 'receipt', 'R',
                                          'aaaa0089-0000-4000-8000-0000000000c9', null, null, null,
                                          'aaaa0089-0000-4000-8000-0000000000a2',
                                          'aaaa0089-0000-4000-8000-0000000000f2', 0) $$,
  'un recibo (internal_only) al «Consumidor final» se emite: el bloque es de la forma libre');

-- ── 6. La puerta del tipo sigue ──────────────────────────────────────────────
select ok(pg_get_functiondef('platform.assert_document_issuance()'::regprocedure) like '%LAD98%',
  'la definición viva conserva la puerta del tipo de contribuyente (LAD98) de 190100');

select * from finish();
rollback;

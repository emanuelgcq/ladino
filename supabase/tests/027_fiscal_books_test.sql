-- =============================================================================
-- Ladino — pgTAP 27 · LIBROS FISCALES (migración 27) — RIGOR MÁXIMO
--
-- Un libro se entrega al SENIAT y en fiscalización se compara CONTRA LAS
-- FACTURAS. Si no cuadra con la suma de sus documentos origen es una infracción
-- formal aunque sea por error. Esto prueba lo que el código de dominio no puede
-- romper aunque cambie:
--
--   1. el snapshot ampliado es NULLABLE y SIN default — un default habría
--      backfilleado el pasado, que es lo que ADR-0044 §1 prohíbe;
--   2. `tax_treatment_of()` es TOTAL sobre el vocabulario real de
--      `product_tax_categories`, y devuelve NULL —no «gravado»— ante lo que no
--      conoce;
--   3. ningún adaptador de formato es OFICIAL, y `fiscal_book_runs` es
--      append-only en las dos capas;
--   4. el libro de ventas incluye la ANULADA, excluye la de otro período y
--      excluye el borrador;
--   5. una línea sin tratamiento va a `base_sin_clasificar` y NO se cuela en la
--      gravada — el pasado no se reinterpreta;
--   6. el importe en moneda extranjera lleva la tasa DEL DÍA DE EMISIÓN;
--   7. una retención sin comprobante emitido SÍ está en el libro: esconderla
--      sería declarar de menos;
--   8. `libro = mayor + cola` cuadra, y CON LA VARIANTE ROTA: si el asiento no
--      dice lo que dice el libro, la conciliación tiene que ponerse en rojo. Un
--      invariante que solo se prueba cuando se cumple no se ha probado.
-- =============================================================================

begin;
select plan(35);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values ('aaaa0027-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0027-0000-4000-8000-00000000000a', 'Tenant 27');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0027-0000-4000-8000-0000000000a2', 'aaaa0027-0000-4000-8000-00000000000a',
   'J-27-A', 'Empresa 27', 'ordinario');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0027-0000-4000-8000-00000000c001', 'aaaa0027-0000-4000-8000-00000000000a',
   'aaaa0027-0000-4000-8000-0000000000a2', 'J-CLI-27', 'Cliente 27', 'juridica', 'ordinario');
insert into public.products (id, tenant_id, company_id, sku, name, kind, unit_code,
                             tax_category_code) values
  ('aaaa0027-0000-4000-8000-00000000d001', 'aaaa0027-0000-4000-8000-00000000000a',
   'aaaa0027-0000-4000-8000-0000000000a2', 'SKU-27', 'Producto 27', 'good', 'unidad',
   'gravado_general');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0027-0000-4000-8000-00000000e101', 'aaaa0027-0000-4000-8000-00000000000a',
        'aaaa0027-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01');

-- ── 1. El snapshot ampliado: nullable, sin default, con vocabulario cerrado ──
select is(
  (select count(*) from information_schema.columns
    where table_schema = 'public'
      and table_name in ('document_lines', 'supplier_invoice_lines')
      and column_name in ('tax_category_snapshot', 'tax_treatment', 'operation_type')),
  6::bigint, 'las tres columnas de snapshot existen en ventas Y en compras');
select is(
  (select count(*) from information_schema.columns
    where table_schema = 'public'
      and table_name in ('document_lines', 'supplier_invoice_lines')
      and column_name in ('tax_category_snapshot', 'tax_treatment', 'operation_type')
      and (is_nullable = 'NO' or column_default is not null)),
  0::bigint,
  'ninguna es NOT NULL ni tiene default: un default habría rellenado el pasado por inferencia');

-- ── 2. `tax_treatment_of` es TOTAL sobre el vocabulario real ────────────────
-- Se recorre `product_tax_categories`, no una lista escrita a mano aquí: si
-- mañana alguien añade una categoría y no la clasifica, esto se pone rojo.
select is(
  (select count(*) from public.product_tax_categories c
    where c.status = 'active' and platform.tax_treatment_of(c.code) is null),
  0::bigint,
  'toda categoría ACTIVA del catálogo tiene tratamiento: ninguna quedaría fuera del libro');
select is(platform.tax_treatment_of('gravado_reducida'), 'gravado',
  'las tres alícuotas gravadas colapsan a un solo tratamiento, que es como lo pide la norma');
select is(platform.tax_treatment_of('exonerado'), 'exonerado',
  'exonerado NO es exento: son columnas distintas del libro y una alícuota de 0 no las separa');
select is(platform.tax_treatment_of('categoria_que_no_existe'), null,
  'y lo desconocido devuelve NULL, no «gravado»: clasificar a ciegas produce una declaración falsa');

-- ── 3. Catálogo de formatos: NINGUNO oficial ────────────────────────────────
select is((select count(*) from public.book_format_adapters where is_official), 0::bigint,
  'ningún adaptador OFICIAL: el layout del SENIAT no está en el repositorio y no se inventa');
select is((select count(*) from public.book_format_adapters
            where description not like '%VALIDAR-SENIAT%'), 0::bigint,
  'y todos van marcados VALIDAR-SENIAT');
select cmp_ok((select count(*) from public.book_format_adapters), '>=', 1::bigint,
  'sí hay UNO no oficial, para que exportar hoy sea posible');

-- ── 4. `fiscal_book_runs`: append-only en las DOS capas ─────────────────────
select is((select count(*) from public.fiscal_book_runs), 0::bigint,
  'nace vacía: una generación es un HECHO, nunca un seed');
select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('fiscal_book_runs', 'book_format_adapters')
      and c.relrowsecurity and c.relforcerowsecurity),
  2::bigint, 'las dos tablas con RLS habilitada y FORZADA');
select is((select count(*) from information_schema.role_table_grants
            where table_schema = 'public' and table_name = 'fiscal_book_runs'
              and grantee in ('anon','authenticated','service_role','ladino_api','ladino_worker')
              and privilege_type in ('UPDATE','DELETE','TRUNCATE')), 0::bigint,
  'y sin un solo GRANT de mutación: capa uno');

-- El «quién» no puede faltar. Sin el GUC de actor, `set_row_provenance()` deja
-- created_by en NULL EN SILENCIO — y en la tabla que prueba quién presentó qué,
-- ese silencio es el peor modo de fallo. El CHECK lo convierte en ruido.
select throws_ok($$
  insert into public.fiscal_book_runs
    (tenant_id, company_id, book_kind, period_from, period_to, timezone, generator_version,
     dataset_hash, row_count, format_code)
  values ('aaaa0027-0000-4000-8000-00000000000a', 'aaaa0027-0000-4000-8000-0000000000a2',
          'ventas', '2026-08-01', '2026-08-31', 'America/Caracas', 'test',
          repeat('a', 64), 0, 'csv_columnas_legales')
$$, '23514', null,
  'sin actor en el GUC la generación NO se registra: una exportación anónima no prueba nada');

select set_config('ladino.actor_id', 'aaaa0027-0000-4000-8000-0000000000a1', true);
select throws_ok($$
  insert into public.fiscal_book_runs
    (tenant_id, company_id, book_kind, period_from, period_to, timezone, generator_version,
     dataset_hash, row_count, format_code)
  values ('aaaa0027-0000-4000-8000-00000000000a', 'aaaa0027-0000-4000-8000-0000000000a2',
          'ventas', '2026-08-01', '2026-08-31', 'America/Caracas', 'test',
          'NO-ES-UN-HASH', 0, 'csv_columnas_legales')
$$, '23514', null, 'un hash que no es un SHA-256 se rechaza: firmar con cualquier cosa no es firmar');

insert into public.fiscal_book_runs
  (id, tenant_id, company_id, book_kind, period_from, period_to, timezone, generator_version,
   dataset_hash, row_count, format_code)
values ('aaaa0027-0000-4000-8000-00000000b201', 'aaaa0027-0000-4000-8000-00000000000a',
        'aaaa0027-0000-4000-8000-0000000000a2', 'ventas', '2026-08-01', '2026-08-31',
        'America/Caracas', 'test', repeat('b', 64), 3, 'csv_columnas_legales');
select throws_ok($$
  update public.fiscal_book_runs set row_count = 4
   where id = 'aaaa0027-0000-4000-8000-00000000b201'
$$, 'LAD06', null,
  'reescribir una generación ya hecha es imposible: borraría la prueba de qué se presentó');
select throws_ok($$
  delete from public.fiscal_book_runs where id = 'aaaa0027-0000-4000-8000-00000000b201'
$$, 'LAD06', null, 'y borrarla tampoco');

-- ── 5. UN comprobante de retención vivo por factura ─────────────────────────
insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0027-0000-4000-8000-00000000e001', 'aaaa0027-0000-4000-8000-00000000000a',
   'aaaa0027-0000-4000-8000-0000000000a2', 'J-PRO-27', 'Proveedor 27', 'nacional',
   'juridica', 'ordinario');
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate,
   amount_transaction_currency, functional_amount) values
  ('aaaa0027-0000-4000-8000-00000000f101', 'aaaa0027-0000-4000-8000-00000000000a',
   'aaaa0027-0000-4000-8000-0000000000a2', 'aaaa0027-0000-4000-8000-00000000e001',
   'FP-001', 'CTRL-001', '2026-08-10', 'posted', now(), 1000, 160, 1160, true,
   'VES', 'VES', 1, 1160, 1160);
insert into public.retention_receipts
  (id, tenant_id, company_id, supplier_id, supplier_invoice_id, series, receipt_number, status,
   issued_at, fiscal_period, total_retained, functional_currency) values
  ('aaaa0027-0000-4000-8000-00000000e201', 'aaaa0027-0000-4000-8000-00000000000a',
   'aaaa0027-0000-4000-8000-0000000000a2', 'aaaa0027-0000-4000-8000-00000000e001',
   'aaaa0027-0000-4000-8000-00000000f101', 'A', 1, 'issued', '2026-08-12', '2026-08', 120, 'VES');
select throws_ok($$
  insert into public.retention_receipts
    (tenant_id, company_id, supplier_id, supplier_invoice_id, series, receipt_number, status,
     issued_at, fiscal_period, total_retained, functional_currency)
  values ('aaaa0027-0000-4000-8000-00000000000a', 'aaaa0027-0000-4000-8000-0000000000a2',
          'aaaa0027-0000-4000-8000-00000000e001', 'aaaa0027-0000-4000-8000-00000000f101',
          'B', 2, 'issued', '2026-08-13', '2026-08', 120, 'VES')
$$, '23505', null,
  'dos comprobantes VIVOS para la misma factura: imposible — el join del libro los duplicaría y el libro declararía el doble de retenido');

-- ── 6. EL LIBRO DE VENTAS ───────────────────────────────────────────────────
-- Cuatro documentos a propósito: uno normal, uno anulado, uno de otro mes y un
-- borrador. Y una línea SIN tratamiento, que es el pasado que no se adivina.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0027-0000-4000-8000-00000000f001', 'aaaa0027-0000-4000-8000-00000000000a',
   'aaaa0027-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0027-0000-4000-8000-00000000c001', 1, 5001, 'issued', '2026-08-05T14:00:00Z',
   'aaaa0027-0000-4000-8000-00000000e101', 'test-027', 'VES', 'VES', 1, 'identidad',
   1160, 1160, 1000, 160, 1160),
  ('aaaa0027-0000-4000-8000-00000000f002', 'aaaa0027-0000-4000-8000-00000000000a',
   'aaaa0027-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0027-0000-4000-8000-00000000c001', 2, 5002, 'issued', '2026-08-06T14:00:00Z',
   'aaaa0027-0000-4000-8000-00000000e101', 'test-027', 'VES', 'VES', 1, 'identidad',
   232, 232, 200, 32, 232),
  ('aaaa0027-0000-4000-8000-00000000f003', 'aaaa0027-0000-4000-8000-00000000000a',
   'aaaa0027-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0027-0000-4000-8000-00000000c001', 3, 5003, 'issued', '2026-07-20T14:00:00Z',
   'aaaa0027-0000-4000-8000-00000000e101', 'test-027', 'VES', 'VES', 1, 'identidad',
   580, 580, 500, 80, 580);
update public.documents
   set status = 'annulled', annulled_at = now(), annul_reason = 'error de digitación'
 where id = 'aaaa0027-0000-4000-8000-00000000f002';
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, status,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0027-0000-4000-8000-00000000f004', 'aaaa0027-0000-4000-8000-00000000000a',
        'aaaa0027-0000-4000-8000-0000000000a2', 'invoice', 'A',
        'aaaa0027-0000-4000-8000-00000000c001', 'draft', 'VES', 'VES', 1, 'identidad',
        116, 116, 100, 16, 116);

-- La factura de agosto: 800 gravado + 200 exento. Y una línea del «pasado», sin
-- tratamiento, que NO puede sumarse a ninguna de las dos.
insert into public.document_lines
  (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
   unit_price_transaction, unit_price_functional, tax_rate_snapshot, tax_amount,
   line_subtotal_transaction, line_subtotal_functional, line_total_transaction,
   line_total_functional, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, rate_source, rate_timestamp, rounding_policy_id,
   tax_category_snapshot, tax_treatment)
values
  ('aaaa0027-0000-4000-8000-00000000000a', 'aaaa0027-0000-4000-8000-0000000000a2',
   'aaaa0027-0000-4000-8000-00000000f001', 1, 'aaaa0027-0000-4000-8000-00000000d001',
   'Gravada', 1, 800, 800, 0.16, 128, 800, 800, 928, 928, 928, 'VES', 1, 928, 'VES',
   'identidad', now(), 'sales:document:8:HALF_UP', 'gravado_general', 'gravado'),
  ('aaaa0027-0000-4000-8000-00000000000a', 'aaaa0027-0000-4000-8000-0000000000a2',
   'aaaa0027-0000-4000-8000-00000000f001', 2, 'aaaa0027-0000-4000-8000-00000000d001',
   'Exenta', 1, 100, 100, 0, 0, 100, 100, 100, 100, 100, 'VES', 1, 100, 'VES',
   'identidad', now(), 'sales:document:8:HALF_UP', 'exento', 'exento'),
  ('aaaa0027-0000-4000-8000-00000000000a', 'aaaa0027-0000-4000-8000-0000000000a2',
   'aaaa0027-0000-4000-8000-00000000f001', 3, 'aaaa0027-0000-4000-8000-00000000d001',
   'Emitida antes de la migración 27', 1, 100, 100, 0.16, 16, 100, 100, 116, 116, 116,
   'VES', 1, 116, 'VES', 'identidad', now(), 'sales:document:8:HALF_UP', null, null);

select is((select count(*) from platform.sales_book('aaaa0027-0000-4000-8000-0000000000a2',
                                                    '2026-08-01', '2026-08-31')),
  2::bigint,
  'el libro de agosto trae DOS documentos: la emitida y la anulada — ni la de julio ni el borrador');
select is((select status from platform.sales_book('aaaa0027-0000-4000-8000-0000000000a2',
             '2026-08-01', '2026-08-31') where document_number = 2), 'annulled',
  'la ANULADA aparece marcada: su correlativo se consumió y omitirla dejaría un hueco inexplicable');
select is((select base_gravada from platform.sales_book('aaaa0027-0000-4000-8000-0000000000a2',
             '2026-08-01', '2026-08-31') where document_number = 1), 800::numeric,
  'la base gravada suma SOLO las líneas gravadas: 800');
select is((select base_exenta from platform.sales_book('aaaa0027-0000-4000-8000-0000000000a2',
             '2026-08-01', '2026-08-31') where document_number = 1), 100::numeric,
  'y la exenta va en su columna: 100');
select is((select base_sin_clasificar from platform.sales_book(
             'aaaa0027-0000-4000-8000-0000000000a2', '2026-08-01', '2026-08-31')
            where document_number = 1), 100::numeric,
  'la línea SIN tratamiento va a su propia columna, visible: el pasado se declara, no se adivina');
select is((select iva_debito from platform.sales_book('aaaa0027-0000-4000-8000-0000000000a2',
             '2026-08-01', '2026-08-31') where document_number = 1), 160::numeric,
  'el IVA sale de la CABECERA, que es lo que se emitió y lo que tiene que cuadrar con el mayor');

-- ADR-0046: la venta se denomina en funcional; la lista USD deja su tasa
-- congelada en pricing_*. La base del libro es la del DÍA DE EMISIÓN, leída
-- del documento — si el libro la recalculara con la tasa de hoy, cambiaría sola.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source, rate_timestamp,
   pricing_currency, pricing_fx_rate, pricing_rate_source, pricing_rate_timestamp,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0027-0000-4000-8000-00000000f005', 'aaaa0027-0000-4000-8000-00000000000a',
        'aaaa0027-0000-4000-8000-0000000000a2', 'invoice', 'B',
        'aaaa0027-0000-4000-8000-00000000c001', 1, 5004, 'issued', '2026-08-07T14:00:00Z',
        'aaaa0027-0000-4000-8000-00000000e101', 'test-027', 'VES', 'VES', 1, 'identidad',
        '2026-08-07T10:00:00Z', 'USD', 40, 'BCV', '2026-08-07T10:00:00Z',
        4000, 4000, 4000, 0, 4000);
select is((select total_amount from platform.sales_book('aaaa0027-0000-4000-8000-0000000000a2',
             '2026-08-01', '2026-08-31') where series = 'B'), 4000::numeric,
  'el total sale de la CABECERA congelada (4 000 Bs, preciada de USD a 40): el libro no recalcula con la tasa de hoy');

-- ── 7. Libro de retenciones: la que aún no tiene comprobante SÍ está ────────
insert into public.retention_rules
  (id, jurisdiction, retention_code, concept_code, formula_kind, rate, effective_from,
   legal_source) values
  ('aaaa0027-0000-4000-8000-00000000e301', 'VE', 'iva', 'iva_compras', 'rate', 0.75,
   '2026-01-01', 'REGLA DE PRUEBA 027 — no es una norma real');
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate,
   amount_transaction_currency, functional_amount) values
  ('aaaa0027-0000-4000-8000-00000000f102', 'aaaa0027-0000-4000-8000-00000000000a',
   'aaaa0027-0000-4000-8000-0000000000a2', 'aaaa0027-0000-4000-8000-00000000e001',
   'FP-002', 'CTRL-002', '2026-08-20', 'posted', now(), 500, 80, 580, true,
   'VES', 'VES', 1, 580, 580);
insert into public.supplier_retentions
  (tenant_id, company_id, supplier_id, supplier_invoice_id, retention_code, concept_code,
   retention_rule_id, formula_kind, rate_snapshot, legal_source_snapshot, base_amount,
   retained_amount, functional_currency, rules_version) values
  ('aaaa0027-0000-4000-8000-00000000000a', 'aaaa0027-0000-4000-8000-0000000000a2',
   'aaaa0027-0000-4000-8000-00000000e001', 'aaaa0027-0000-4000-8000-00000000f102',
   'iva', 'iva_compras', 'aaaa0027-0000-4000-8000-00000000e301', 'rate', 0.75,
   'REGLA DE PRUEBA 027', 80, 60, 'VES', 'test-027');
select is((select count(*) from platform.iva_retention_book(
             'aaaa0027-0000-4000-8000-0000000000a2', '2026-08-01', '2026-08-31')),
  1::bigint,
  'la retención practicada SIN comprobante emitido está en el libro: esconderla sería declarar de menos');
select is((select receipt_number from platform.iva_retention_book(
             'aaaa0027-0000-4000-8000-0000000000a2', '2026-08-01', '2026-08-31')), null,
  'y aparece con el comprobante en NULL, que es lo que de verdad pasa: falta emitirlo');
select is((select legal_source from platform.iva_retention_book(
             'aaaa0027-0000-4000-8000-0000000000a2', '2026-08-01', '2026-08-31')),
  'REGLA DE PRUEBA 027',
  'con la norma COPIADA: sin ella el libro dice cuánto se retuvo, no con qué derecho');
select is((select count(*) from platform.islr_retention_book(
             'aaaa0027-0000-4000-8000-0000000000a2', '2026-08-01', '2026-08-31')),
  0::bigint,
  'y el libro de ISLR no la ve: se enteran por separado, mezclarlos invita a presentarlos mezclados');

-- ── 8. Libro de compras ─────────────────────────────────────────────────────
select is((select iva_credito from platform.purchases_book(
             'aaaa0027-0000-4000-8000-0000000000a2', '2026-08-01', '2026-08-31')
            where supplier_document_number = 'FP-001'), 160::numeric,
  'para el contribuyente ORDINARIO el IVA soportado es crédito fiscal');
select is((select iva_al_costo from platform.purchases_book(
             'aaaa0027-0000-4000-8000-0000000000a2', '2026-08-01', '2026-08-31')
            where supplier_document_number = 'FP-001'), 0::numeric,
  'y por tanto NO es costo: las dos columnas son excluyentes por construcción');
select is((select retenido_iva from platform.purchases_book(
             'aaaa0027-0000-4000-8000-0000000000a2', '2026-08-01', '2026-08-31')
            where supplier_document_number = 'FP-002'), 60::numeric,
  'la retención practicada viaja en la fila de SU factura, que es donde la busca un fiscalizador');

-- ── 9. LA CONCILIACIÓN CRUZADA, y su variante ROTA ──────────────────────────
-- El libro de agosto tiene 160 + 0 (la de divisa) de IVA débito en documentos
-- NO anulados. Se asienta exactamente eso y tiene que cuadrar.
insert into public.accounts (id, tenant_id, company_id, code, name, kind, nature) values
  ('aaaa0027-0000-4000-8000-00000000a001', 'aaaa0027-0000-4000-8000-00000000000a',
   'aaaa0027-0000-4000-8000-0000000000a2', '2.1', 'IVA débito fiscal', 'pasivo', 'acreedora'),
  ('aaaa0027-0000-4000-8000-00000000a002', 'aaaa0027-0000-4000-8000-00000000000a',
   'aaaa0027-0000-4000-8000-0000000000a2', '1.1', 'Caja', 'activo', 'deudora');
insert into public.company_account_settings (tenant_id, company_id, purpose, account_id) values
  ('aaaa0027-0000-4000-8000-00000000000a', 'aaaa0027-0000-4000-8000-0000000000a2',
   'iva_debit_fiscal', 'aaaa0027-0000-4000-8000-00000000a001');
insert into public.fiscal_periods (id, tenant_id, company_id, year, month) values
  ('aaaa0027-0000-4000-8000-00000000b001', 'aaaa0027-0000-4000-8000-00000000000a',
   'aaaa0027-0000-4000-8000-0000000000a2', 2026, 8);
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
   description) values
  ('aaaa0027-0000-4000-8000-00000000b101', 'aaaa0027-0000-4000-8000-00000000000a',
   'aaaa0027-0000-4000-8000-0000000000a2', 'aaaa0027-0000-4000-8000-00000000b001',
   '2026-08-05', 'sales_invoice', 'aaaa0027-0000-4000-8000-00000000f001',
   'fiscal.invoice.issued', 'Factura 1');
insert into public.journal_lines
  (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
   amount_transaction_currency, transaction_currency, functional_amount, functional_currency,
   functional_debit, functional_credit) values
  ('aaaa0027-0000-4000-8000-00000000000a', 'aaaa0027-0000-4000-8000-0000000000a2',
   'aaaa0027-0000-4000-8000-00000000b101', 1, 'aaaa0027-0000-4000-8000-00000000a002',
   160, 0, 160, 'VES', 160, 'VES', 160, 0),
  ('aaaa0027-0000-4000-8000-00000000000a', 'aaaa0027-0000-4000-8000-0000000000a2',
   'aaaa0027-0000-4000-8000-00000000b101', 2, 'aaaa0027-0000-4000-8000-00000000a001',
   0, 160, 160, 'VES', 160, 'VES', 0, 160);
update public.journal_entries
   set status = 'posted', posted_at = now(), posted_by = 'aaaa0027-0000-4000-8000-0000000000a1',
       entry_number = 1
 where id = 'aaaa0027-0000-4000-8000-00000000b101';
update public.documents set journal_entry_id = 'aaaa0027-0000-4000-8000-00000000b101'
 where id = 'aaaa0027-0000-4000-8000-00000000f001';

select is(
  (select cuadra from platform.book_ledger_reconciliation(
     'aaaa0027-0000-4000-8000-0000000000a2', '2026-08-01', '2026-08-31')
    where concepto = 'iva_debito_fiscal'),
  true, 'libro = mayor + cola: cuadra cuando el asiento dice lo mismo que el libro');
select is(
  (select en_cola from platform.book_ledger_reconciliation(
     'aaaa0027-0000-4000-8000-0000000000a2', '2026-08-01', '2026-08-31')
    where concepto = 'iva_debito_fiscal'),
  0::numeric,
  'y la cola está en cero: el otro documento de agosto tiene 0 de IVA, así que no aporta');

-- LA VARIANTE ROTA. Un asiento que dice 200 donde el libro dice 160 tiene que
-- poner la conciliación en ROJO. Un invariante que solo se prueba cuando se
-- cumple no se ha probado: es el patrón de ADR-0023 —ausencia de fallo leída
-- como éxito— y aquí se rompe a propósito.
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, description) values
  ('aaaa0027-0000-4000-8000-00000000b102', 'aaaa0027-0000-4000-8000-00000000000a',
   'aaaa0027-0000-4000-8000-0000000000a2', 'aaaa0027-0000-4000-8000-00000000b001',
   '2026-08-09', 'manual', 'IVA que el libro no respalda');
insert into public.journal_lines
  (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
   amount_transaction_currency, transaction_currency, functional_amount, functional_currency,
   functional_debit, functional_credit) values
  ('aaaa0027-0000-4000-8000-00000000000a', 'aaaa0027-0000-4000-8000-0000000000a2',
   'aaaa0027-0000-4000-8000-00000000b102', 1, 'aaaa0027-0000-4000-8000-00000000a002',
   40, 0, 40, 'VES', 40, 'VES', 40, 0),
  ('aaaa0027-0000-4000-8000-00000000000a', 'aaaa0027-0000-4000-8000-0000000000a2',
   'aaaa0027-0000-4000-8000-00000000b102', 2, 'aaaa0027-0000-4000-8000-00000000a001',
   0, 40, 40, 'VES', 40, 'VES', 0, 40);
update public.journal_entries
   set status = 'posted', posted_at = now(), posted_by = 'aaaa0027-0000-4000-8000-0000000000a1',
       entry_number = 2
 where id = 'aaaa0027-0000-4000-8000-00000000b102';

select is(
  (select cuadra from platform.book_ledger_reconciliation(
     'aaaa0027-0000-4000-8000-0000000000a2', '2026-08-01', '2026-08-31')
    where concepto = 'iva_debito_fiscal'),
  false,
  'VARIANTE ROTA: 40 Bs de IVA en el mayor que ningún documento respalda y la conciliación se pone en ROJO');
select is(
  (select diferencia from platform.book_ledger_reconciliation(
     'aaaa0027-0000-4000-8000-0000000000a2', '2026-08-01', '2026-08-31')
    where concepto = 'iva_debito_fiscal'),
  -40::numeric,
  'y dice CUÁNTO sobra, con signo: un «no cuadra» pelado obliga a volver a sumar, y quien vuelve a sumar suma distinto');

select * from finish();
rollback;

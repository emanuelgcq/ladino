-- =============================================================================
-- Ladino — pgTAP 26 · EL GANCHO CONTABLE (migración 26) — RIGOR MÁXIMO
--
-- El E2E prueba el generador desde HTTP con documentos reales. Esto prueba lo
-- que el generador NO puede romper aunque el código de dominio cambie:
--
--   1. el catálogo de presets es GLOBAL y de SOLO LECTURA;
--   2. sus enums son LOS MISMOS que los de `journal_templates` — si divergieran,
--      un preset podría traer una forma que la tabla real rechaza y el import
--      fallaría a mitad, dejando media plantilla;
--   3. `journal_templates` sigue naciendo VACÍA: el preset es un catálogo del
--      que copiar, no un default (ADR-0041);
--   4. cada papel que el preset usa tiene cuenta en el plan `ve_basico`, o
--      importar los dos dejaría el mapeo sin cuenta y todo en la cola;
--   5. la cola admite UNA fila por hecho: encolar dos veces el mismo evento
--      generaría dos asientos;
--   6. el enlace al asiento CABE en un documento de compra confirmado, y nada
--      más cabe;
--   7. las dos mitades del invariante de ADR-0042 son excluyentes por
--      construcción, y `accounting_coverage_gaps()` las mide.
-- =============================================================================

begin;
select plan(26);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values ('aaaa0026-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0026-0000-4000-8000-00000000000a', 'Tenant 26');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0026-0000-4000-8000-0000000000a2', 'aaaa0026-0000-4000-8000-00000000000a',
   'J-26-A', 'Empresa 26', 'ordinario');

-- ── 1. El catálogo de presets: global y de solo lectura ─────────────────────
select cmp_ok((select count(*) from public.journal_template_presets), '>=', 1::bigint,
  'hay al menos un preset de mapeo contable, para que arrancar sea posible');
select is((select count(*) from public.journal_template_presets
            where description not like '%VALIDAR-CONTABLE%'), 0::bigint,
  'y va marcado VALIDAR-CONTABLE: Ladino no afirma que sea el mapeo correcto de nadie');
select is((select count(*) from public.journal_template_presets
            where length(btrim(legal_source)) < 3), 0::bigint,
  'ningún preset sin fuente citada');
select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('journal_template_presets', 'journal_template_preset_entries',
                        'journal_template_preset_lines')
      and c.relrowsecurity and c.relforcerowsecurity),
  3::bigint, 'las tres tablas del catálogo con RLS habilitada y FORZADA');
select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'journal_template_presets'
      and cmd in ('INSERT', 'UPDATE', 'DELETE') and coalesce(qual, with_check) = 'false'),
  3::bigint,
  'el catálogo deniega INSERT, UPDATE y DELETE POR ESCRITO: se carga con migraciones');
select is((select count(*) from information_schema.role_table_grants
            where table_schema = 'public' and table_name = 'journal_template_presets'
              and grantee in ('anon', 'authenticated', 'service_role', 'ladino_api', 'ladino_worker')
              and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')), 0::bigint,
  'y tampoco hay GRANT de escritura para ningún rol de la aplicación: las dos capas, como siempre');

-- ── 2. Los enums del preset son LOS MISMOS que los de la tabla real ─────────
-- Si divergieran, el import fallaría a mitad y dejaría media plantilla: unas
-- líneas copiadas y otras no, que es un asiento que cuadra mal.
select is(
  (select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'journal_template_preset_lines_amount_chk'),
  (select replace(pg_get_constraintdef(oid), 'journal_template_lines', 'x') from pg_constraint
    where conname = 'journal_template_lines_amount_chk'),
  'el enum de `amount_source` del preset es idéntico al de la tabla real');
select is(
  (select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'journal_template_preset_lines_condition_chk'),
  (select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'journal_template_lines_condition_chk'),
  'y el de `condition_kind` también');
select is(
  (select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'journal_template_preset_lines_side_chk'),
  (select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'journal_template_lines_side_chk'),
  'y el de `side`');

select throws_ok($$
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side)
  select id, 99, 'ar_general', 'select * from users', 'debit'
    from public.journal_template_preset_entries limit 1
$$, '23514', null,
  'un `amount_source` libre lo rechaza el ENUM antes de llegar siquiera a la RLS: el CHECK se evalúa primero, y esa es la capa que no depende de quién escriba');

-- ── 3. `journal_templates` sigue naciendo vacía ─────────────────────────────
select is((select count(*) from public.journal_templates), 0::bigint,
  'journal_templates sigue VACÍA (ADR-0041): el preset es un catálogo, no un default');
select is((select count(*) from public.accounts), 0::bigint,
  'y accounts también: la migración no le siembra el plan a nadie');

-- ── 4. Cobertura: cada papel del preset tiene cuenta en el plan ─────────────
-- Es la comprobación que evita el peor modo de fallo del gancho: importar plan
-- y preset y que TODO siga yendo a la cola porque falta una cuenta.
select is(
  (select count(*) from public.journal_template_preset_lines l
    where not exists (select 1 from public.chart_template_accounts a
                       where a.template_code = 've_basico'
                         and a.suggested_purpose = l.account_purpose)),
  0::bigint,
  'todo papel usado por el preset ve_basico tiene cuenta en el plan ve_basico');

select cmp_ok((select count(*) from public.journal_template_preset_entries
                where preset_code = 've_basico'), '>=', 6::bigint,
  'el preset cubre los seis hechos contabilizables que los módulos ya emiten');

-- Y los eventos que declara son los REALES del outbox, no unos paralelos.
select is(
  (select count(*) from public.journal_template_preset_entries
    where preset_code = 've_basico'
      and source_event not in ('fiscal.invoice.issued', 'ar.payment_applied',
                               'ap.invoice_posted', 'ap.payment_made',
                               'purchase.landed_cost_applied', 'stock.adjusted')),
  0::bigint,
  'los eventos del preset son los del OUTBOX, con su nombre real: no se inventa un vocabulario paralelo');

-- ── 5. Las plantillas del preset producen asientos CUADRADOS ───────────────
-- Se comprueba la FORMA, que es lo comprobable sin documentos: cada plantilla
-- tiene al menos un débito y un crédito. Una con todo del mismo lado no podría
-- cuadrar nunca, y el defecto viviría hasta la primera factura.
select is(
  (select count(*) from public.journal_template_preset_entries e
    where not exists (select 1 from public.journal_template_preset_lines l
                       where l.entry_id = e.id and l.side = 'debit')
       or not exists (select 1 from public.journal_template_preset_lines l
                       where l.entry_id = e.id and l.side = 'credit')),
  0::bigint,
  'cada plantilla del preset tiene al menos un débito Y un crédito: una con todo de un lado no cuadraría nunca');

-- La venta: CxC al débito por el total, ingreso e IVA al crédito. Si el IVA
-- fuera a ingresos, la empresa declararía como suyo un impuesto de terceros.
select is(
  (select l.account_purpose from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_event = 'fiscal.invoice.issued'
      and l.side = 'debit'),
  'ar_general', 'en la venta, el único débito es cuentas por cobrar');
select is(
  (select l.amount_source from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_event = 'fiscal.invoice.issued'
      and l.account_purpose = 'income_general'),
  'subtotal',
  'y el ingreso es la BASE, no el total: el IVA no es ingreso de la empresa');

-- La compra: las dos ramas del IVA son excluyentes por construcción.
select is(
  (select count(*) from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_event = 'ap.invoice_posted'
      and l.condition_kind in ('if_tax_recoverable', 'if_tax_not_recoverable')),
  3::bigint,
  'la compra tiene las dos ramas del IVA —crédito fiscal o costo— condicionadas y excluyentes');

-- El cobro: el diferencial cambiario se reconoce EXPLÍCITAMENTE, en dos líneas
-- separadas por signo, porque una línea de asiento no lleva importes negativos.
select is(
  (select count(*) from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_event = 'ar.payment_applied'
      and l.amount_source = 'exchange_difference'),
  2::bigint,
  'el cobro reconoce el diferencial en DOS líneas por signo: nunca se absorbe en el redondeo');

-- ── 6. La cola: una fila por hecho ─────────────────────────────────────────
insert into public.journal_generation_queue
  (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
values ('aaaa0026-0000-4000-8000-00000000000a', 'aaaa0026-0000-4000-8000-0000000000a2',
        'sales_invoice', 'aaaa0026-0000-4000-8000-00000000fa01', 'fiscal.invoice.issued',
        '{"total": "100"}'::jsonb, 'Sin plantilla configurada');
select throws_ok($$
  insert into public.journal_generation_queue
    (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
  values ('aaaa0026-0000-4000-8000-00000000000a', 'aaaa0026-0000-4000-8000-0000000000a2',
          'sales_invoice', 'aaaa0026-0000-4000-8000-00000000fa01', 'fiscal.invoice.issued',
          '{"total": "100"}'::jsonb, 'Duplicado')
$$, '23505', null,
  'el mismo hecho no se encola dos veces: dos filas generarían dos asientos');

-- Pero OTRO evento del mismo documento sí, igual que en journal_entries.
select lives_ok($$
  insert into public.journal_generation_queue
    (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
  values ('aaaa0026-0000-4000-8000-00000000000a', 'aaaa0026-0000-4000-8000-0000000000a2',
          'sales_invoice', 'aaaa0026-0000-4000-8000-00000000fa01', 'fiscal.invoice.annulled',
          '{"total": "100"}'::jsonb, 'Sin plantilla para la anulación')
$$, 'pero otro evento del MISMO documento sí: el eje de la idempotencia es el hecho, no el papel');

select throws_ok($$
  insert into public.journal_generation_queue
    (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
  values ('aaaa0026-0000-4000-8000-00000000000a', 'aaaa0026-0000-4000-8000-0000000000a2',
          'sales_invoice', 'aaaa0026-0000-4000-8000-00000000fa02', 'fiscal.invoice.issued',
          '"no soy un objeto"'::jsonb, 'Contexto mal formado')
$$, '23514', null,
  'el contexto congelado tiene que ser un OBJETO: un escalar no explica ningún importe');

-- ── 7. El enlace al asiento cabe en una compra confirmada, y nada más ───────
select ok(
  (select pg_get_functiondef(p.oid) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'platform' and p.proname = 'assert_purchase_doc_immutable')
    like '%journal_entry_id%',
  'el trigger de compras admite escribir el enlace al asiento DESPUÉS de asentar');

select is(
  (select count(*) from information_schema.columns
    where table_schema = 'public' and column_name = 'journal_entry_id'
      and table_name in ('documents', 'supplier_invoices', 'supplier_payments', 'payments',
                         'goods_receipts', 'landed_costs', 'retention_receipts')),
  7::bigint,
  'los siete documentos tienen la columna de enlace; que se pueda ESCRIBIR en todos es otra cosa');

-- ── 8. El invariante de ADR-0042, medido ────────────────────────────────────
select is((select count(*) from platform.accounting_coverage_gaps(
             'aaaa0026-0000-4000-8000-0000000000a2')), 0::bigint,
  'sin documentos emitidos no hay huecos de cobertura, y la función EXISTE para poder decirlo');

select * from finish();
rollback;

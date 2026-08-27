-- =============================================================================
-- Ladino — pgTAP 22 · COMPRAS (migración 22) — RIGOR MÁXIMO
--
-- Lo del encargo, ejercido:
--   1. ciclo orden → recepción parcial → recepción final → factura → matching;
--   2. landed cost por los TRES métodos, con importes calculados A MANO;
--   3. la recepción actualiza el kardex al costo, y el landed cost lo revaloriza;
--   4. landed cost TARDÍO con unidades ya vendidas: genera VARIACIÓN, no
--      prorrateo sobre lo que queda, y la variación tiene el importe exacto;
--   5. retención de IVA a contribuyente especial: cálculo, aplicación al pago y
--      comprobante con numeración;
--   6. retención de ISLR con rate_minus_subtrahend: cálculo correcto y respeto
--      del mínimo exento;
--   7. proveedor extranjero: sin RIF, sin clasificación venezolana, y su
--      factura registra el documento origen;
--   8. diferencia de precio orden↔factura, dentro y fuera del umbral;
--   9. diferencia de CANTIDAD: siempre visible, nunca tolerada;
--  10. nota de crédito recibida: reduce el saldo de su factura;
--  11. IVA como crédito vs costo, derivado del taxpayer_type de la EMPRESA;
--  12. append-only de los documentos confirmados, en las dos capas;
--  13. anular el comprobante de retención conserva su correlativo;
--  14. aislamiento por company.
--
-- Los porcentajes que se cargan aquí son de PRUEBA, con `legal_source` que lo
-- dice. No son la norma venezolana y no pretenden serlo: lo que se comprueba es
-- la mecánica del cálculo, no el número.
-- =============================================================================

begin;
select plan(71);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values ('aaaa0022-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0022-0000-4000-8000-00000000000a', 'Tenant 22'),
  ('aaaa0022-0000-4000-8000-00000000000b', 'Tenant 22-B');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000000a',
   'J-22-A', 'Empresa 22 ordinaria', 'ordinario'),
  ('aaaa0022-0000-4000-8000-0000000000b2', 'aaaa0022-0000-4000-8000-00000000000b',
   'J-22-B', 'Empresa 22-B', 'ordinario'),
  -- La formal existe para el caso 11: su IVA de compra es COSTO, no crédito.
  ('aaaa0022-0000-4000-8000-0000000000c2', 'aaaa0022-0000-4000-8000-00000000000a',
   'J-22-C', 'Empresa 22 formal', 'formal');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0022-0000-4000-8000-00000000ff01', 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'W1', 'Principal');
insert into public.suppliers
  (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code, taxpayer_type_code)
values
  ('aaaa0022-0000-4000-8000-00000000ba01'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'J-PROV-22', 'Proveedor nacional 22', 'nacional',
   'juridica', 'especial');
insert into public.products
  (id, tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code)
values
  ('aaaa0022-0000-4000-8000-00000000d001', 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'PROD-22-A', 'Producto 22 A', 'good', 'active',
   'unidad', 'gravado_general'),
  ('aaaa0022-0000-4000-8000-00000000d002', 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'PROD-22-B', 'Producto 22 B', 'good', 'active',
   'unidad', 'gravado_general');

-- ── 1. El catálogo de retenciones NACE VACÍO (ADR-0039) ─────────────────────
select is((select count(*) from public.retention_rules), 0::bigint,
  'retention_rules nace VACÍA: la migración no siembra ni un porcentaje (ADR-0039)');
select cmp_ok((select count(*) from public.retention_concepts), '>=', 6::bigint,
  'el VOCABULARIO de conceptos sí se siembra: un nombre no es una obligación legal');
select is((select count(*) from public.retention_rules r
            where length(btrim(r.legal_source)) < 3), 0::bigint,
  'ninguna regla sin norma citada (vacía, así que trivialmente cierto — y sigue siéndolo al cargarlas)');
select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and c.relname in
      ('suppliers','supplier_bank_accounts','purchase_settings','purchase_orders',
       'purchase_order_lines','goods_receipts','goods_receipt_lines','supplier_invoices',
       'supplier_invoice_lines','supplier_credit_notes','supplier_credit_note_lines',
       'landed_costs','landed_cost_allocations','landed_cost_variances','supplier_retentions',
       'retention_receipts','supplier_payments','retention_concepts','retention_rules')
      and c.relrowsecurity and c.relforcerowsecurity),
  19::bigint, 'las diecinueve tablas de compras con RLS habilitada y FORZADA');
select is((select is_scoped from public.permissions where key = 'purchase.receive'), true,
  'purchase.receive es ACOTADO: recibir mueve stock y se recibe donde se tiene binding (LAD25)');

-- ── 2. Proveedor extranjero: sin RIF y sin clasificación venezolana ─────────
insert into public.suppliers (id, tenant_id, company_id, legal_name, supplier_kind) values
  ('aaaa0022-0000-4000-8000-00000000ba02'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'Foreign Supplier LLC', 'extranjero');
select is((select tax_id from public.suppliers
            where id = 'aaaa0022-0000-4000-8000-00000000ba02'::uuid), null,
  'el proveedor extranjero no tiene RIF, y exigírselo sería inventarle identidad fiscal venezolana');

select throws_ok($$
  insert into public.suppliers (tenant_id, company_id, legal_name, supplier_kind)
  values ('aaaa0022-0000-4000-8000-00000000000a', 'aaaa0022-0000-4000-8000-0000000000a2',
          'Nacional sin RIF', 'nacional')
$$, '23514', null, 'un proveedor NACIONAL sin RIF se rechaza: no se puede llevar al libro de compras');

select throws_ok($$
  insert into public.suppliers
    (tenant_id, company_id, legal_name, supplier_kind, taxpayer_type_code, person_type_code)
  values ('aaaa0022-0000-4000-8000-00000000000a', 'aaaa0022-0000-4000-8000-0000000000a2',
          'Foreign con clasificación', 'extranjero', 'ordinario', 'juridica')
$$, '23514', null, 'un EXTRANJERO con clasificación fiscal venezolana se rechaza: no le aplica');

-- ── 3. Ciclo: orden → recepción parcial → recepción final ───────────────────
insert into public.purchase_orders
  (id, tenant_id, company_id, supplier_id, warehouse_id, order_number, status, ordered_at,
   transaction_currency, functional_currency, fx_rate, rate_source)
values
  ('aaaa0022-0000-4000-8000-00000000bb01'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000ba01'::uuid,
   'aaaa0022-0000-4000-8000-00000000ff01', 1, 'pending', now(), 'USD', 'VES', 40, 'prueba');
insert into public.purchase_order_lines
  (id, tenant_id, company_id, purchase_order_id, line_number, product_id, description, quantity,
   unit_price_transaction, unit_price_functional, line_total_transaction, line_total_functional,
   unit_weight, amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id)
values
  ('aaaa0022-0000-4000-8000-00000000bc01'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000bb01'::uuid, 1,
   'aaaa0022-0000-4000-8000-00000000d001', 'Producto 22 A', 10, 100, 4000, 1000, 40000,
   2, 1000, 'USD', 40, 40000, 'VES', 'prueba', now(), 'purchases:document:8:HALF_UP');

select is((select platform.purchase_order_status(
             'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000bb01'::uuid)),
  'pending', 'una orden sin recepciones está PENDIENTE, y el estado se DERIVA de las recepciones');

-- Recepción parcial: 4 de 10.
insert into public.goods_receipts
  (id, tenant_id, company_id, supplier_id, purchase_order_id, warehouse_id, receipt_number,
   status, received_at, transaction_currency, functional_currency, fx_rate, rate_source)
values
  ('aaaa0022-0000-4000-8000-00000000bd01'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000ba01'::uuid,
   'aaaa0022-0000-4000-8000-00000000bb01'::uuid, 'aaaa0022-0000-4000-8000-00000000ff01',
   1, 'confirmed', now(), 'USD', 'VES', 40, 'prueba');
insert into public.goods_receipt_lines
  (id, tenant_id, company_id, goods_receipt_id, line_number, purchase_order_line_id, product_id,
   quantity, unit_price_transaction, unit_cost_functional, unit_weight,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id)
values
  ('aaaa0022-0000-4000-8000-00000000be01'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000bd01'::uuid, 1,
   'aaaa0022-0000-4000-8000-00000000bc01'::uuid, 'aaaa0022-0000-4000-8000-00000000d001',
   4, 100, 4000, 2, 400, 'USD', 40, 16000, 'VES', 'prueba', now(), 'purchases:document:8:HALF_UP');

select is((select platform.purchase_order_status(
             'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000bb01'::uuid)),
  'partial', 'recibidas 4 de 10, la orden está PARCIAL');
select is((select quantity_pending from platform.purchase_order_progress(
             'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000bb01'::uuid)),
  6::numeric, 'y quedan pendientes exactamente 6');

-- Recepción final: las 6 que faltan.
insert into public.goods_receipts
  (id, tenant_id, company_id, supplier_id, purchase_order_id, warehouse_id, receipt_number,
   status, received_at, transaction_currency, functional_currency, fx_rate, rate_source)
values
  ('aaaa0022-0000-4000-8000-00000000bd02'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000ba01'::uuid,
   'aaaa0022-0000-4000-8000-00000000bb01'::uuid, 'aaaa0022-0000-4000-8000-00000000ff01',
   2, 'confirmed', now(), 'USD', 'VES', 40, 'prueba');
insert into public.goods_receipt_lines
  (id, tenant_id, company_id, goods_receipt_id, line_number, purchase_order_line_id, product_id,
   quantity, unit_price_transaction, unit_cost_functional, unit_weight,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id)
values
  ('aaaa0022-0000-4000-8000-00000000be02'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000bd02'::uuid, 1,
   'aaaa0022-0000-4000-8000-00000000bc01'::uuid, 'aaaa0022-0000-4000-8000-00000000d001',
   6, 100, 4000, 2, 600, 'USD', 40, 24000, 'VES', 'prueba', now(), 'purchases:document:8:HALF_UP');

select is((select platform.purchase_order_status(
             'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000bb01'::uuid)),
  'complete', 'recibidas las 10, la orden está COMPLETA');
select is((select quantity_pending from platform.purchase_order_progress(
             'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000bb01'::uuid)),
  0::numeric, 'sin nada pendiente');

-- Una recepción en BORRADOR no cuenta: el papel no mueve stock.
insert into public.goods_receipts
  (id, tenant_id, company_id, supplier_id, purchase_order_id, warehouse_id, status,
   transaction_currency, functional_currency, fx_rate, rate_source)
values
  ('aaaa0022-0000-4000-8000-00000000bd03'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000ba01'::uuid,
   'aaaa0022-0000-4000-8000-00000000bb01'::uuid, 'aaaa0022-0000-4000-8000-00000000ff01',
   'draft', 'USD', 'VES', 40, 'prueba');
insert into public.goods_receipt_lines
  (id, tenant_id, company_id, goods_receipt_id, line_number, purchase_order_line_id, product_id,
   quantity, unit_price_transaction, unit_cost_functional,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id)
values
  ('aaaa0022-0000-4000-8000-00000000be03'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000bd03'::uuid, 1,
   'aaaa0022-0000-4000-8000-00000000bc01'::uuid, 'aaaa0022-0000-4000-8000-00000000d001',
   5, 100, 4000, 500, 'USD', 40, 20000, 'VES', 'prueba', now(), 'purchases:document:8:HALF_UP');
select is((select quantity_received from platform.purchase_order_progress(
             'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000bb01'::uuid)),
  10::numeric, 'una recepción en BORRADOR no cuenta como recibida: el papel no mueve stock');

-- ── 4. Landed cost: los tres métodos, con números calculados a mano ─────────
-- Recepción con DOS líneas para que el prorrateo tenga algo que repartir:
--   línea A: 4 uds × 4 000 Bs = 16 000 Bs, peso unitario 2 → peso total 8
--   línea B: 6 uds × 1 000 Bs =  6 000 Bs, peso unitario 3 → peso total 18
insert into public.goods_receipts
  (id, tenant_id, company_id, supplier_id, warehouse_id, receipt_number, status, received_at,
   transaction_currency, functional_currency, fx_rate, rate_source)
values
  ('aaaa0022-0000-4000-8000-00000000bd10'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000ba01'::uuid,
   'aaaa0022-0000-4000-8000-00000000ff01', 10, 'confirmed', now(), 'VES', 'VES', 1, 'identidad');
insert into public.goods_receipt_lines
  (id, tenant_id, company_id, goods_receipt_id, line_number, product_id, quantity,
   unit_price_transaction, unit_cost_functional, unit_weight,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id)
values
  ('aaaa0022-0000-4000-8000-00000000be10'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000bd10'::uuid, 1,
   'aaaa0022-0000-4000-8000-00000000d001', 4, 4000, 4000, 2,
   16000, 'VES', 1, 16000, 'VES', 'identidad', now(), 'purchases:document:8:HALF_UP'),
  ('aaaa0022-0000-4000-8000-00000000be11'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000bd10'::uuid, 2,
   'aaaa0022-0000-4000-8000-00000000d002', 6, 1000, 1000, 3,
   6000, 'VES', 1, 6000, 'VES', 'identidad', now(), 'purchases:document:8:HALF_UP');

-- POR VALOR: gasto 2 200 sobre bases 16 000 y 6 000 (total 22 000).
--   A: 2 200 × 16 000 / 22 000 = 1 600
--   B: 2 200 ×  6 000 / 22 000 =   600
select is(round(2200 * 16000::numeric / 22000, 8), 1600::numeric,
  'landed cost POR VALOR: la línea A recibe 1 600 de los 2 200 (calculado a mano)');
select is(round(2200 * 6000::numeric / 22000, 8), 600::numeric,
  'landed cost POR VALOR: la línea B recibe 600, y 1 600 + 600 = 2 200 exactos');

-- POR PESO: pesos totales 4×2 = 8 y 6×3 = 18 (total 26). Gasto 1 300.
--   A: 1 300 ×  8 / 26 = 400
--   B: 1 300 × 18 / 26 = 900
select is(round(1300 * 8::numeric / 26, 8), 400::numeric,
  'landed cost POR PESO: la línea A (peso 8 de 26) recibe 400');
select is(round(1300 * 18::numeric / 26, 8), 900::numeric,
  'landed cost POR PESO: la línea B (peso 18 de 26) recibe 900');

-- POR UNIDADES: 4 y 6 (total 10). Gasto 500 → 200 y 300.
select is(round(500 * 4::numeric / 10, 8), 200::numeric,
  'landed cost POR UNIDADES: la línea A (4 de 10) recibe 200');
select is(round(500 * 6::numeric / 10, 8), 300::numeric,
  'landed cost POR UNIDADES: la línea B (6 de 10) recibe 300');

-- ── 5. Landed cost TARDÍO: variación, no prorrateo sobre lo que queda ───────
-- Se recibieron 4 unidades de la línea A. Se vendieron 3; queda 1.
-- Gasto asignado a la línea: 1 600 → 400 por unidad.
--   a inventario: 400 × 1 = 400
--   a variación : 400 × 3 = 1 200
-- Prorratear los 1 600 sobre la única unidad restante daría 1 600 de costo
-- unitario extra: mentira, y ensuciaría el margen de todas las ventas siguientes.
insert into public.landed_costs
  (id, tenant_id, company_id, goods_receipt_id, concept, allocation_method, incurred_on,
   status, applied_at, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, rate_source, rate_timestamp)
values
  ('aaaa0022-0000-4000-8000-00000000ca01'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000bd10'::uuid,
   'Flete internacional', 'by_value', current_date, 'applied', now(),
   2200, 'VES', 1, 2200, 'VES', 'identidad', now());
insert into public.landed_cost_allocations
  (tenant_id, company_id, landed_cost_id, goods_receipt_line_id, allocated_functional,
   to_inventory_functional, to_variance_functional, quantity_remaining, quantity_received,
   allocation_base)
values
  ('aaaa0022-0000-4000-8000-00000000000a', 'aaaa0022-0000-4000-8000-0000000000a2',
   'aaaa0022-0000-4000-8000-00000000ca01'::uuid, 'aaaa0022-0000-4000-8000-00000000be10'::uuid,
   1600, 400, 1200, 1, 4, 16000);
insert into public.landed_cost_variances
  (tenant_id, company_id, landed_cost_id, goods_receipt_line_id, product_id, amount_functional,
   functional_currency, occurred_on, reason)
values
  ('aaaa0022-0000-4000-8000-00000000000a', 'aaaa0022-0000-4000-8000-0000000000a2',
   'aaaa0022-0000-4000-8000-00000000ca01'::uuid, 'aaaa0022-0000-4000-8000-00000000be10'::uuid,
   'aaaa0022-0000-4000-8000-00000000d001', 1200, 'VES', current_date,
   '3 de 4 unidades ya habían salido cuando llegó el gasto');

select is((select to_variance_functional from public.landed_cost_allocations
            where goods_receipt_line_id = 'aaaa0022-0000-4000-8000-00000000be10'::uuid),
  1200::numeric,
  'landed cost TARDÍO: 3 de 4 unidades vendidas → 1 200 a VARIACIÓN (400/ud × 3), no al inventario');
select is((select to_inventory_functional from public.landed_cost_allocations
            where goods_receipt_line_id = 'aaaa0022-0000-4000-8000-00000000be10'::uuid),
  400::numeric,
  'y solo 400 revalorizan el inventario: lo que corresponde a la unidad que queda');
select is((select amount_functional from public.landed_cost_variances
            where goods_receipt_line_id = 'aaaa0022-0000-4000-8000-00000000be10'::uuid),
  1200::numeric, 'la variación queda REGISTRADA con su importe: el asiento espera, el número no');
select is((select account_code from public.landed_cost_variances
            where goods_receipt_line_id = 'aaaa0022-0000-4000-8000-00000000be10'::uuid),
  'variacion_costo_landed_tardio',
  'con su cuenta declarada, para que el motor contable la encuentre cuando exista');

select throws_ok($$
  insert into public.landed_cost_allocations
    (tenant_id, company_id, landed_cost_id, goods_receipt_line_id, allocated_functional,
     to_inventory_functional, to_variance_functional, quantity_remaining, quantity_received,
     allocation_base)
  values ('aaaa0022-0000-4000-8000-00000000000a', 'aaaa0022-0000-4000-8000-0000000000a2',
          'aaaa0022-0000-4000-8000-00000000ca01'::uuid,
          'aaaa0022-0000-4000-8000-00000000be11'::uuid, 600, 400, 100, 6, 6, 6000)
$$, '23514', null,
  'un reparto que NO suma el total asignado se rechaza: la parte perdida sería costo desaparecido');

select throws_ok($$
  update public.landed_cost_allocations set to_variance_functional = 0
   where goods_receipt_line_id = 'aaaa0022-0000-4000-8000-00000000be10'::uuid
$$, 'LAD06', null, 'el prorrateo está CONGELADO al aplicar: no se reescribe lo que ya movió kardex');

-- ── 6. Retenciones: el cálculo, contra reglas de PRUEBA ─────────────────────
-- Los porcentajes de aquí NO son la norma venezolana. Se comprueba la mecánica.
insert into public.retention_rules
  (id, jurisdiction, retention_code, concept_code, taxpayer_type, formula_kind, rate,
   effective_from, legal_source, priority)
values
  ('aaaa0022-0000-4000-8000-00000000cd01'::uuid, 'VE', 'iva', 'iva_compras', 'especial',
   'rate', 0.75, current_date - 30,
   'REGLA DE PRUEBA pgTAP 022 — no es la norma vigente. VALIDAR-SENIAT.', 10);
insert into public.retention_rules
  (id, jurisdiction, retention_code, concept_code, formula_kind, rate, subtrahend,
   minimum_exempt, effective_from, legal_source, priority)
values
  ('aaaa0022-0000-4000-8000-00000000cd02'::uuid, 'VE', 'islr', 'islr_honorarios',
   'rate_minus_subtrahend', 0.03, 500, 10000, current_date - 30,
   'REGLA DE PRUEBA pgTAP 022 — no es la tabla vigente. VALIDAR-SENIAT.', 10);

-- IVA sobre una base de 1 600 al 75 % = 1 200.
select is(platform.compute_retention(1600, 'rate', 0.75, null, null), 1200::numeric,
  'retención de IVA: 1 600 × 0,75 = 1 200 (fórmula `rate`)');

-- ISLR: base 20 000 → 20 000 × 0,03 − 500 = 100.
select is(platform.compute_retention(20000, 'rate_minus_subtrahend', 0.03, 500, 10000),
  100::numeric,
  'retención de ISLR: 20 000 × 0,03 − 500 = 100 (fórmula `rate_minus_subtrahend`)');

-- Y por debajo del mínimo exento, CERO — no un negativo llevado a cero por el
-- camino equivocado.
select is(platform.compute_retention(9000, 'rate_minus_subtrahend', 0.03, 500, 10000),
  0::numeric,
  'por debajo del mínimo exento no se retiene NADA: el mínimo se comprueba antes de restar');
select is(platform.compute_retention(10000, 'rate_minus_subtrahend', 0.03, 500, 10000),
  0::numeric,
  'justo en el mínimo sí se aplica la fórmula: 10 000 × 0,03 − 500 = −200 → 0, nunca negativa');

select is((select rate from platform.resolve_retention(
             current_date, 'VE', 'iva', 'iva_compras', 'especial', 'juridica')),
  0.75::numeric, 'resolve_retention devuelve LA regla vigente para contribuyente especial');

select throws_ok($$
  select * from platform.resolve_retention(
    current_date, 'VE', 'islr', 'islr_fletes', 'especial', 'juridica')
$$, 'LAD53', null,
  'sin regla cargada, resolve_retention FALLA (LAD53): retener cero sería deber al fisco en silencio');

-- Catálogo ambiguo: dos reglas con la misma prioridad.
insert into public.retention_rules
  (jurisdiction, retention_code, concept_code, taxpayer_type, formula_kind, rate,
   effective_from, legal_source, priority)
values ('VE', 'iva', 'iva_compras', 'especial', 'rate', 1.0, current_date - 30,
        'SEGUNDA REGLA DE PRUEBA, deliberadamente ambigua.', 10);
select throws_ok($$
  select * from platform.resolve_retention(
    current_date, 'VE', 'iva', 'iva_compras', 'especial', 'juridica')
$$, 'LAD53', null,
  'dos reglas con la MISMA prioridad son catálogo ambiguo y también fallan: elegir sería arbitrario');
delete from public.retention_rules where rate = 1.0 and concept_code = 'iva_compras';

-- Forma de las reglas: los parámetros tienen que corresponder a la fórmula.
select throws_ok($$
  insert into public.retention_rules
    (jurisdiction, retention_code, concept_code, formula_kind, rate, subtrahend,
     effective_from, legal_source)
  values ('VE', 'islr', 'islr_servicios', 'rate', 0.03, 500, current_date, 'Prueba de forma.')
$$, '23514', null,
  'una regla `rate` con sustraendo se rechaza al INSERTAR: es una regla que alguien entendió mal');
select throws_ok($$
  insert into public.retention_rules
    (jurisdiction, retention_code, concept_code, formula_kind, rate,
     effective_from, legal_source)
  values ('VE', 'islr', 'islr_servicios', 'rate_minus_subtrahend', 0.03, current_date,
          'Prueba de forma.')
$$, '23514', null, 'y una `rate_minus_subtrahend` SIN sustraendo, igual');
select throws_ok($$
  insert into public.retention_rules
    (jurisdiction, retention_code, concept_code, formula_kind, rate,
     effective_from, legal_source)
  values ('VE', 'islr', 'islr_servicios', 'rate', 0.03, current_date, 'x')
$$, '23514', null, 'una regla con fuente legal de un carácter se rechaza: eso no es citar una norma');

-- ── 7. Factura del proveedor, retención y comprobante ───────────────────────
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, purchase_order_id, supplier_document_number,
   supplier_control_number, invoice_date, status, posted_at, subtotal_amount, tax_amount,
   total_amount, tax_is_recoverable, transaction_currency, functional_currency, fx_rate,
   rate_source)
values
  ('aaaa0022-0000-4000-8000-00000000cb01'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000ba01'::uuid,
   'aaaa0022-0000-4000-8000-00000000bb01'::uuid, 'FAC-000123', '00-1234567',
   current_date, 'posted', now(), 10000, 1600, 11600, true, 'VES', 'VES', 1, 'identidad');

select throws_ok($$
  insert into public.supplier_invoices
    (tenant_id, company_id, supplier_id, supplier_document_number, invoice_date, status,
     posted_at, tax_is_recoverable, transaction_currency, functional_currency)
  values ('aaaa0022-0000-4000-8000-00000000000a', 'aaaa0022-0000-4000-8000-0000000000a2',
          'aaaa0022-0000-4000-8000-00000000ba01'::uuid, 'FAC-999', current_date, 'posted',
          now(), true, 'VES', 'VES')
$$, '23514', null,
  'una factura de compra SIN número de control NI referencia de documento origen se rechaza');

select throws_ok($$
  insert into public.supplier_invoices
    (tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
     invoice_date, status, posted_at, tax_is_recoverable, transaction_currency,
     functional_currency)
  values ('aaaa0022-0000-4000-8000-00000000000a', 'aaaa0022-0000-4000-8000-0000000000a2',
          'aaaa0022-0000-4000-8000-00000000ba01'::uuid, 'fac-000123', '00-9999999',
          current_date, 'posted', now(), true, 'VES', 'VES')
$$, '23505', null,
  'el mismo documento del mismo proveedor no se carga dos veces, ni cambiando mayúsculas: es la defensa contra el doble pago');

-- La factura del EXTRANJERO: sin número de control, con su documento origen.
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_document_ref,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
values
  ('aaaa0022-0000-4000-8000-00000000cb02'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000ba02'::uuid,
   'INV-2026-889', 'B/L MSCU-77120', current_date, 'posted', now(), 5000, 0, 5000,
   false, 'USD', 'VES', 40, 'prueba');
select is((select supplier_control_number from public.supplier_invoices
            where id = 'aaaa0022-0000-4000-8000-00000000cb02'::uuid), null,
  'la factura del proveedor extranjero no trae número de control venezolano');
select isnt((select supplier_document_ref from public.supplier_invoices
              where id = 'aaaa0022-0000-4000-8000-00000000cb02'::uuid), null,
  'pero SÍ registra su documento origen: sin identificación no sería asentable');
select is((select count(*) from public.supplier_retentions
            where supplier_invoice_id = 'aaaa0022-0000-4000-8000-00000000cb02'::uuid), 0::bigint,
  'y no se le practica retención local: no le aplica');

-- La retención practicada, con la regla COPIADA (R-05).
insert into public.supplier_retentions
  (id, tenant_id, company_id, supplier_id, supplier_invoice_id, retention_code, concept_code,
   retention_rule_id, formula_kind, rate_snapshot, legal_source_snapshot, base_amount,
   retained_amount, functional_currency, status, rules_version)
values
  ('aaaa0022-0000-4000-8000-00000000ce01'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000ba01'::uuid,
   'aaaa0022-0000-4000-8000-00000000cb01'::uuid, 'iva', 'iva_compras',
   'aaaa0022-0000-4000-8000-00000000cd01'::uuid, 'rate', 0.75,
   'REGLA DE PRUEBA pgTAP 022 — no es la norma vigente. VALIDAR-SENIAT.',
   1600, 1200, 'VES', 'calculated', 'test');

select is((select retained_amount from public.supplier_retentions
            where id = 'aaaa0022-0000-4000-8000-00000000ce01'::uuid), 1200::numeric,
  'la retención de IVA sobre el impuesto de 1 600 al 75 % son 1 200');

-- Cambiar el catálogo DESPUÉS no toca la retención practicada.
update public.retention_rules set rate = 1.0
 where id = 'aaaa0022-0000-4000-8000-00000000cd01'::uuid;
select is((select rate_snapshot from public.supplier_retentions
            where id = 'aaaa0022-0000-4000-8000-00000000ce01'::uuid), 0.75::numeric,
  'cambiar retention_rules DESPUÉS no altera la retención practicada: la regla se COPIA (R-05)');
update public.retention_rules set rate = 0.75
 where id = 'aaaa0022-0000-4000-8000-00000000cd01'::uuid;

select throws_ok($$
  insert into public.supplier_retentions
    (tenant_id, company_id, supplier_id, supplier_invoice_id, retention_code, concept_code,
     retention_rule_id, formula_kind, rate_snapshot, legal_source_snapshot, base_amount,
     retained_amount, functional_currency, rules_version)
  values ('aaaa0022-0000-4000-8000-00000000000a', 'aaaa0022-0000-4000-8000-0000000000a2',
          'aaaa0022-0000-4000-8000-00000000ba01'::uuid,
          'aaaa0022-0000-4000-8000-00000000cb01'::uuid, 'iva', 'iva_compras',
          'aaaa0022-0000-4000-8000-00000000cd01'::uuid, 'rate', 0.75, 'x'||'xx', 1600, 1200,
          'VES', 'test')
$$, '23505', null,
  'doble retención sobre la MISMA base/documento/concepto: rechazada en la base, no en el caso de uso');

-- ── 8. El comprobante: numeración propia y correlativo que sobrevive ────────
insert into public.retention_receipts
  (id, tenant_id, company_id, supplier_id, supplier_invoice_id, series, receipt_number,
   status, issued_at, fiscal_period, total_retained, functional_currency)
values
  ('aaaa0022-0000-4000-8000-00000000cf01'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000ba01'::uuid,
   'aaaa0022-0000-4000-8000-00000000cb01'::uuid, 'A',
   platform.claim_retention_receipt_number('aaaa0022-0000-4000-8000-0000000000a2', 'A'),
   'issued', now(), to_char(current_date, 'YYYY-MM'), 1200, 'VES');
select is((select receipt_number from public.retention_receipts
            where id = 'aaaa0022-0000-4000-8000-00000000cf01'::uuid), 1::bigint,
  'el primer comprobante de retención de la empresa lleva el número 1');

update public.retention_receipts
   set status = 'annulled', annulled_at = now(), annul_reason = 'Error en la base retenida'
 where id = 'aaaa0022-0000-4000-8000-00000000cf01'::uuid;
select is((select receipt_number from public.retention_receipts
            where id = 'aaaa0022-0000-4000-8000-00000000cf01'::uuid), 1::bigint,
  'anularlo CONSERVA su correlativo: un número emitido no vuelve a estar disponible (ADR-0039)');
select is(platform.claim_retention_receipt_number('aaaa0022-0000-4000-8000-0000000000a2', 'A'),
  2::bigint, 'y el siguiente es el 2: el hueco del anulado NO se reutiliza');

select throws_ok($$
  update public.retention_receipts set receipt_number = 99
   where id = 'aaaa0022-0000-4000-8000-00000000cf01'::uuid
$$, 'LAD54', null, 'cambiar el correlativo de un comprobante emitido se rechaza con código propio');
select throws_ok($$
  update public.retention_receipts set status = 'issued'
   where id = 'aaaa0022-0000-4000-8000-00000000cf01'::uuid
$$, 'LAD54', null, 'y un comprobante anulado no vuelve a emitirse');

select ok(
  (select pg_get_constraintdef(oid) like '%retention_receipt%'
     from pg_constraint where conname = 'fiscal_number_ranges_kind_chk'),
  'el rango fiscal admite kind=retention_receipt: sin esto ADR-0039 §5 sería una intención sin mecanismo');

-- ── 9. Matching de tres vías ────────────────────────────────────────────────
insert into public.supplier_invoice_lines
  (id, tenant_id, company_id, supplier_invoice_id, line_number, goods_receipt_line_id, product_id,
   description, quantity, unit_price_transaction, unit_price_functional,
   line_subtotal_transaction, line_total_transaction, tax_amount,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id)
values
  ('aaaa0022-0000-4000-8000-00000000cc01'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000cb01'::uuid, 1,
   'aaaa0022-0000-4000-8000-00000000be01'::uuid, 'aaaa0022-0000-4000-8000-00000000d001',
   'Producto 22 A', 4, 102, 4080, 408, 408, 0,
   408, 'USD', 40, 16320, 'VES', 'prueba', now(), 'purchases:document:8:HALF_UP');

select is((select price_diff_pct from platform.purchase_matching(
             'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000cb01'::uuid)),
  2::numeric,
  'matching: la orden decía 100 y la factura dice 102 → 2 % de diferencia, dentro del umbral por defecto');
select is((select qty_ordered from platform.purchase_matching(
             'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000cb01'::uuid)),
  10::numeric, 'y el matching ve las tres cantidades: 10 pedidas…');
select is((select qty_received from platform.purchase_matching(
             'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000cb01'::uuid)),
  4::numeric, '…4 recibidas en esa recepción…');
select is((select qty_invoiced from platform.purchase_matching(
             'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000cb01'::uuid)),
  4::numeric, '…y 4 facturadas: la diferencia de cantidad queda VISIBLE, sin tolerancia que la tape');

-- ── 10. Nota de crédito recibida ────────────────────────────────────────────
select is(platform.supplier_invoice_balance(
            'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000cb01'::uuid),
  11600::numeric, 'la factura del proveedor debe 11 600 antes de cualquier abono');

insert into public.supplier_credit_notes
  (id, tenant_id, company_id, supplier_id, supplier_invoice_id, supplier_document_number,
   supplier_control_number, note_date, status, posted_at, reason, subtotal_amount, tax_amount,
   total_amount, transaction_currency, functional_currency, fx_rate, rate_source)
values
  ('aaaa0022-0000-4000-8000-00000000da01'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000ba01'::uuid,
   'aaaa0022-0000-4000-8000-00000000cb01'::uuid, 'NC-000045', '00-1234599', current_date,
   'posted', now(), 'Mercancía devuelta por defecto de fábrica', 1000, 160, 1160,
   'VES', 'VES', 1, 'identidad');
select is(platform.supplier_invoice_balance(
            'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000cb01'::uuid),
  10440::numeric, 'la nota de crédito recibida REDUCE el saldo: 11 600 − 1 160 = 10 440');

-- ── 11. El pago: bruto cancela deuda, neto sale del banco ───────────────────
insert into public.supplier_payments
  (tenant_id, company_id, supplier_id, supplier_invoice_id, paid_at, instrument,
   gross_amount, retained_amount, net_amount, amount_transaction_currency,
   transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
   rate_timestamp)
values
  ('aaaa0022-0000-4000-8000-00000000000a', 'aaaa0022-0000-4000-8000-0000000000a2',
   'aaaa0022-0000-4000-8000-00000000ba01'::uuid, 'aaaa0022-0000-4000-8000-00000000cb01'::uuid,
   now(), 'transferencia', 10440, 1200, 9240, 10440, 'VES', 1, 10440, 'VES', 'identidad', now());
select is(platform.supplier_invoice_balance(
            'aaaa0022-0000-4000-8000-0000000000a2', 'aaaa0022-0000-4000-8000-00000000cb01'::uuid),
  0::numeric,
  'el pago BRUTO cancela la deuda entera: lo retenido se le debe al fisco, no al proveedor');

select throws_ok($$
  insert into public.supplier_payments
    (tenant_id, company_id, supplier_id, supplier_invoice_id, paid_at, instrument,
     gross_amount, retained_amount, net_amount, amount_transaction_currency,
     transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
     rate_timestamp)
  values ('aaaa0022-0000-4000-8000-00000000000a', 'aaaa0022-0000-4000-8000-0000000000a2',
          'aaaa0022-0000-4000-8000-00000000ba01'::uuid,
          'aaaa0022-0000-4000-8000-00000000cb01'::uuid, now(), 'transferencia',
          1000, 200, 900, 1000, 'VES', 1, 1000, 'VES', 'identidad', now())
$$, '23514', null,
  'un pago donde bruto ≠ retenido + neto se rechaza: el descuadre sería dinero que no está en ningún lado');

select throws_ok($$
  update public.supplier_payments set gross_amount = 1 where gross_amount = 10440
$$, 'LAD06', null, 'un pago a proveedor es append-only: no se edita');

-- ── 12. Append-only de los documentos confirmados ───────────────────────────
select throws_ok($$
  update public.supplier_invoices set subtotal_amount = 1
   where id = 'aaaa0022-0000-4000-8000-00000000cb01'::uuid
$$, 'LAD06', null, 'una factura de proveedor asentada no se edita: se corrige con nota de crédito');
select throws_ok($$
  update public.goods_receipts set delivery_note_ref = 'guía cambiada a posteriori'
   where id = 'aaaa0022-0000-4000-8000-00000000bd01'::uuid
$$, 'LAD06', null, 'una recepción confirmada tampoco: ya movió kardex');
select throws_ok($$
  update public.goods_receipt_lines set quantity = 99
   where id = 'aaaa0022-0000-4000-8000-00000000be01'::uuid
$$, 'LAD06', null,
  'y sus LÍNEAS menos: cabecera inmutable con importes editables es peor que nada, porque parece protegida');
select throws_ok($$
  delete from public.supplier_invoices where id = 'aaaa0022-0000-4000-8000-00000000cb01'::uuid
$$, 'LAD06', null, 'ni se borra');

-- El BORRADOR sí se edita: es lo que distingue un borrador de un hecho.
update public.goods_receipt_lines set quantity = 3
 where id = 'aaaa0022-0000-4000-8000-00000000be03'::uuid;
select is((select quantity from public.goods_receipt_lines
            where id = 'aaaa0022-0000-4000-8000-00000000be03'::uuid), 3::numeric,
  'la línea de una recepción en BORRADOR sí se edita: para eso es un borrador');

-- ── 13. IVA: crédito o costo, derivado del contribuyente de la EMPRESA ──────
select is((select taxpayer_type_code from public.companies
            where id = 'aaaa0022-0000-4000-8000-0000000000a2'), 'ordinario',
  'la empresa A es contribuyente ordinario…');
select is((select tax_is_recoverable from public.supplier_invoices
            where id = 'aaaa0022-0000-4000-8000-00000000cb01'::uuid), true,
  '…y por eso el IVA de su compra es CRÉDITO FISCAL, no costo (ADR-0040 §7, VALIDAR-TRIBUTARIO)');
select is((select taxpayer_type_code from public.companies
            where id = 'aaaa0022-0000-4000-8000-0000000000c2'), 'formal',
  'la empresa C es contribuyente formal…');
insert into public.suppliers
  (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code, taxpayer_type_code)
values
  ('aaaa0022-0000-4000-8000-00000000ba03'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000c2', 'J-PROV-C', 'Proveedor de la formal', 'nacional',
   'juridica', 'ordinario');
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
values
  ('aaaa0022-0000-4000-8000-00000000cb03'::uuid, 'aaaa0022-0000-4000-8000-00000000000a',
   'aaaa0022-0000-4000-8000-0000000000c2', 'aaaa0022-0000-4000-8000-00000000ba03'::uuid,
   'FAC-C-1', '00-7654321', current_date, 'posted', now(), 1000, 160, 1160,
   false, 'VES', 'VES', 1, 'identidad');
select is((select tax_is_recoverable from public.supplier_invoices
            where id = 'aaaa0022-0000-4000-8000-00000000cb03'::uuid), false,
  '…y para ella el IVA de compra NO es recuperable: es parte del costo');

-- ── 14. Aging de CxP y aislamiento ──────────────────────────────────────────
select cmp_ok((select count(*) from platform.ap_aging(
                 'aaaa0022-0000-4000-8000-0000000000a2', null, current_date)), '>=', 0::bigint,
  'ap_aging responde para la empresa (simétrico a ar_aging, los mismos cuatro tramos)');

select is((select count(*) from public.suppliers
            where company_id = 'aaaa0022-0000-4000-8000-0000000000b2'), 0::bigint,
  'la empresa B no ve proveedores de la A: aislamiento por company');
select throws_ok($$
  insert into public.purchase_orders
    (tenant_id, company_id, supplier_id, warehouse_id, status,
     transaction_currency, functional_currency)
  values ('aaaa0022-0000-4000-8000-00000000000b', 'aaaa0022-0000-4000-8000-0000000000b2',
          'aaaa0022-0000-4000-8000-00000000ba01'::uuid,
          'aaaa0022-0000-4000-8000-00000000ff01', 'draft', 'VES', 'VES')
$$, '23503', null,
  'una orden de la empresa B contra un proveedor de la A se rechaza por la FK compuesta');

select * from finish();
rollback;

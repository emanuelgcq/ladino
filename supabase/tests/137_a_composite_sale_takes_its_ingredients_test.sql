-- =============================================================================
-- Ladino — pgTAP 137 · I-04 y C-07 (migraciones 20261005130000 y 20261005130100)
--
-- LA VENTA DE UN COMPUESTO SACA SUS INGREDIENTES, Y «VENCIDO» ES DÍA CONTRA DÍA.
--
-- Dos tenants (A y B) y TRES usuarios: e1 es de A, e3 es de B, y e2 es de LOS DOS (el atacante
-- realista: el usuario legítimo de los dos lados).
--
--   1-3.  el invariante `composite_sale_gaps`: una línea vendida de un compuesto sin rastro da
--         `sin_salidas`; con su rastro, cero;
--   4-6.  la guarda de `sale_line_components`: no acepta una fila que no coincide con su
--         movimiento, ni una que junta la línea de A con el movimiento de B (aunque quien la
--         escribe sea de los dos tenants), ni el reingreso que no revierte una salida de la línea;
--   7-13. aislamiento en las cuatro operaciones, comprobando el DATO: B no lee, no inserta, y
--         nadie actualiza ni borra (la API no tiene el privilegio: 42501; el dueño de la tabla
--         muere en el trigger LAD06; y la fila sigue intacta);
--   14-15. VARIANTE ROTA del invariante: con la proporción alterada da `fuera_de_proporcion`, y
--         con el valor alterado `movimiento_no_coincide`;
--   16-17. un compuesto vendido no deja de serlo (LAD44); uno sin vender y sin receta, sí;
--   18-19. el vencimiento se congela con movimientos (LAD38), y SIN el trigger el cambio entra:
--         la guarda es el trigger;
--   20-23. LAD46 día contra día en Caracas: a las 21:00 de Caracas del día en que vence, el lote
--         todavía sale; a las 00:30 del día siguiente, no. Y el dato de la 18 es justo el que la
--         expresión anterior (`occurred_at::date`, en UTC) juzgaba vencido.
--
-- SEGUNDA RONDA (C4), ocho aserciones más, intercaladas tras las variantes rotas (la numeración
-- de arriba es la de la primera ronda): la rama de la guarda «revierte una salida de la MISMA
-- línea»; un reingreso (`back`) VÁLIDO por el camino de la API, con el invariante en cero;
-- `devuelto_de_mas` con su variante rota (la guarda de la fila no suma: solo lo ve el invariante);
-- LAD43 (un compuesto no recibe movimientos) y `compuesto_con_existencia` con su variante rota por
-- el lado que LAD43 no cubre (un producto con movimientos marcado compuesto, que impide LAD44).
-- =============================================================================

begin;
select plan(31);
set local lock_timeout = '4s';

insert into auth.users (id) values
  ('aaaa0137-0000-4000-8000-0000000000e1'),
  ('aaaa0137-0000-4000-8000-0000000000e2'),
  ('aaaa0137-0000-4000-8000-0000000000e3'),
  ('aaaa0137-0000-4000-8000-0000000000e9');
insert into public.tenants (id, name) values
  ('aaaa0137-0000-4000-8000-00000000000a', 'Tenant 137 A'),
  ('aaaa0137-0000-4000-8000-00000000000b', 'Tenant 137 B');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code) values
  ('aaaa0137-0000-4000-8000-0000000000a1', 'aaaa0137-0000-4000-8000-00000000000a',
   'V137100018', 'Arepera 137 A', 'VES'),
  ('aaaa0137-0000-4000-8000-0000000000b1', 'aaaa0137-0000-4000-8000-00000000000b',
   'V137100026', 'Arepera 137 B', 'VES');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0137-0000-4000-8000-0000000001a1', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000e1'),
  ('aaaa0137-0000-4000-8000-0000000001a2', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000e2'),
  ('aaaa0137-0000-4000-8000-0000000001b2', 'aaaa0137-0000-4000-8000-00000000000b',
   'aaaa0137-0000-4000-8000-0000000000e2'),
  ('aaaa0137-0000-4000-8000-0000000001b3', 'aaaa0137-0000-4000-8000-00000000000b',
   'aaaa0137-0000-4000-8000-0000000000e3');
insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
select m.tenant_id, m.id, r.id, null
  from public.memberships m
  join public.roles r on r.key = 'owner' and r.tenant_id is null
 where m.id in ('aaaa0137-0000-4000-8000-0000000001a1', 'aaaa0137-0000-4000-8000-0000000001a2',
                'aaaa0137-0000-4000-8000-0000000001b2', 'aaaa0137-0000-4000-8000-0000000001b3');
select set_config('ladino.actor_id', 'aaaa0137-0000-4000-8000-0000000000e1', true);

insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0137-0000-4000-8000-0000000000f1', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000a1', 'W137-A', 'Local A'),
  ('aaaa0137-0000-4000-8000-0000000000f2', 'aaaa0137-0000-4000-8000-00000000000b',
   'aaaa0137-0000-4000-8000-0000000000b1', 'W137-B', 'Local B');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                              taxpayer_type_code) values
  ('aaaa0137-0000-4000-8000-0000000000c1', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000a1', 'J413710001', 'Cliente 137 A', 'juridica', 'ordinario'),
  ('aaaa0137-0000-4000-8000-0000000000c2', 'aaaa0137-0000-4000-8000-00000000000b',
   'aaaa0137-0000-4000-8000-0000000000b1', 'J413710002', 'Cliente 137 B', 'juridica', 'ordinario');
-- d1 harina A · d2 arepa A (compuesto) · d3 plato A (compuesto, sin vender, sin receta)
-- d4 queso A (lote y vencimiento) · d5 harina B · d6 arepa B (compuesto)
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code, is_composed, tracks_lots, tracks_expiry) values
  ('aaaa0137-0000-4000-8000-0000000000d1', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000a1', 'H-137', 'Harina 137', 'good', 'active', 'unidad',
   'gravado_general', false, false, false),
  ('aaaa0137-0000-4000-8000-0000000000d2', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000a1', 'A-137', 'Arepa 137', 'good', 'active', 'unidad',
   'gravado_general', true, false, false),
  ('aaaa0137-0000-4000-8000-0000000000d3', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000a1', 'P-137', 'Plato 137', 'good', 'active', 'unidad',
   'gravado_general', true, false, false),
  ('aaaa0137-0000-4000-8000-0000000000d4', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000a1', 'Q-137', 'Queso 137', 'good', 'active', 'unidad',
   'gravado_general', false, true, true),
  ('aaaa0137-0000-4000-8000-0000000000d5', 'aaaa0137-0000-4000-8000-00000000000b',
   'aaaa0137-0000-4000-8000-0000000000b1', 'H-137', 'Harina 137 B', 'good', 'active', 'unidad',
   'gravado_general', false, false, false),
  ('aaaa0137-0000-4000-8000-0000000000d6', 'aaaa0137-0000-4000-8000-00000000000b',
   'aaaa0137-0000-4000-8000-0000000000b1', 'A-137', 'Arepa 137 B', 'good', 'active', 'unidad',
   'gravado_general', true, false, false);
insert into public.product_recipes (tenant_id, company_id, parent_product_id, child_product_id,
                                    quantity, unit_code) values
  ('aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
   'aaaa0137-0000-4000-8000-0000000000d2', 'aaaa0137-0000-4000-8000-0000000000d1', 0.5, 'unidad');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from,
                                           effective_to) values
  ('aaaa0137-0000-4000-8000-0000000000a7', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000a1', 'formatos_libres', '2026-06-01 00:00-04', null),
  ('aaaa0137-0000-4000-8000-0000000000b7', 'aaaa0137-0000-4000-8000-00000000000b',
   'aaaa0137-0000-4000-8000-0000000000b1', 'formatos_libres', '2026-06-01 00:00-04', null);
insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                           effective_from, reason, rules_version) values
  ('aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
   'ordinario', '2026-06-01', 'Declaración del dueño', 'v1'),
  ('aaaa0137-0000-4000-8000-00000000000b', 'aaaa0137-0000-4000-8000-0000000000b1',
   'ordinario', '2026-06-01', 'Declaración del dueño', 'v1');
insert into public.lots (id, tenant_id, company_id, product_id, code, expires_at) values
  ('aaaa0137-0000-4000-8000-000000000101', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000a1', 'aaaa0137-0000-4000-8000-0000000000d4', 'VENCE-ANTEAYER',
   (now() at time zone 'America/Caracas')::date - 2);

-- Una factura emitida con UNA línea, y la entrada y la salida de kardex que la venta produce.
create function pg_temp.factura(p_tenant uuid, p_company uuid, p_cliente uuid, p_regimen uuid,
                                p_doc uuid, p_linea uuid, p_producto uuid, p_cantidad numeric)
returns void language plpgsql as $$
begin
  insert into public.documents
    (id, tenant_id, company_id, kind, series, customer_id, status, rules_version,
     transaction_currency, functional_currency, fx_rate, rate_source,
     amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
  values (p_doc, p_tenant, p_company, 'invoice', 'A', p_cliente, 'draft', 'domain-s0.5',
          'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116);
  insert into public.document_lines
    (id, tenant_id, company_id, document_id, line_number, product_id, description, quantity,
     unit_price_transaction, unit_price_functional, tax_rate_snapshot, tax_amount,
     line_subtotal_transaction, line_subtotal_functional,
     line_total_transaction, line_total_functional,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, rounding_policy_id,
     tax_category_snapshot, tax_treatment)
  values (p_linea, p_tenant, p_company, p_doc, 1, p_producto, 'Línea 137', p_cantidad,
          100 / p_cantidad, 100 / p_cantidad, 0.16, 16, 100, 100, 116, 116, 116, 'VES', 1, 116,
          'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', 'gravado_general',
          platform.tax_treatment_of('gravado_general'));
  update public.documents
     set status = 'issued', issued_at = now(), document_number = 1, control_number = 1,
         control_identifier = '00', regime_version_id = p_regimen
   where id = p_doc;
end $$;
create function pg_temp.mover(p_id uuid, p_tenant uuid, p_company uuid, p_almacen uuid,
                              p_producto uuid, p_lote uuid, p_cantidad numeric, p_valor numeric,
                              p_origen uuid, p_cuando timestamptz)
returns void language sql as $$
  insert into public.inventory_moves
    (id, tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, rounding_policy_id, occurred_at,
     source_document_id)
  values (p_id, p_tenant, p_company, p_almacen, p_producto, p_lote,
          case when p_cantidad > 0 then 'entrada' else 'salida' end, p_cantidad,
          p_valor, 'VES', 1, p_valor, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP',
          p_cuando, p_origen);
$$;
create function pg_temp.huecos(p_company uuid) returns text
language sql as $$
  select coalesce(string_agg(distinct gap, ',' order by gap), '')
    from platform.composite_sale_gaps(p_company);
$$;

-- A: 10 de harina por 30 (3 c/u); se venden 2 arepas → sale 1 de harina por 3.
select pg_temp.mover('aaaa0137-0000-4000-8000-000000000201', 'aaaa0137-0000-4000-8000-00000000000a',
  'aaaa0137-0000-4000-8000-0000000000a1', 'aaaa0137-0000-4000-8000-0000000000f1',
  'aaaa0137-0000-4000-8000-0000000000d1', null, 10, 30, null, now());
select pg_temp.factura('aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
  'aaaa0137-0000-4000-8000-0000000000c1', 'aaaa0137-0000-4000-8000-0000000000a7',
  'aaaa0137-0000-4000-8000-000000000301', 'aaaa0137-0000-4000-8000-000000000401',
  'aaaa0137-0000-4000-8000-0000000000d2', 2);
select pg_temp.mover('aaaa0137-0000-4000-8000-000000000202', 'aaaa0137-0000-4000-8000-00000000000a',
  'aaaa0137-0000-4000-8000-0000000000a1', 'aaaa0137-0000-4000-8000-0000000000f1',
  'aaaa0137-0000-4000-8000-0000000000d1', null, -1, -3,
  'aaaa0137-0000-4000-8000-000000000301', now());
-- B: lo mismo, con su rastro escrito.
select pg_temp.mover('aaaa0137-0000-4000-8000-000000000211', 'aaaa0137-0000-4000-8000-00000000000b',
  'aaaa0137-0000-4000-8000-0000000000b1', 'aaaa0137-0000-4000-8000-0000000000f2',
  'aaaa0137-0000-4000-8000-0000000000d5', null, 10, 30, null, now());
select pg_temp.factura('aaaa0137-0000-4000-8000-00000000000b', 'aaaa0137-0000-4000-8000-0000000000b1',
  'aaaa0137-0000-4000-8000-0000000000c2', 'aaaa0137-0000-4000-8000-0000000000b7',
  'aaaa0137-0000-4000-8000-000000000311', 'aaaa0137-0000-4000-8000-000000000411',
  'aaaa0137-0000-4000-8000-0000000000d6', 2);
select pg_temp.mover('aaaa0137-0000-4000-8000-000000000212', 'aaaa0137-0000-4000-8000-00000000000b',
  'aaaa0137-0000-4000-8000-0000000000b1', 'aaaa0137-0000-4000-8000-0000000000f2',
  'aaaa0137-0000-4000-8000-0000000000d5', null, -1, -3,
  'aaaa0137-0000-4000-8000-000000000311', now());
insert into public.sale_line_components
  (id, tenant_id, company_id, document_id, document_line_id, parent_product_id, child_product_id,
   direction, move_id, quantity, functional_amount, recipe_quantity, unit_factor)
values ('aaaa0137-0000-4000-8000-000000000511', 'aaaa0137-0000-4000-8000-00000000000b',
        'aaaa0137-0000-4000-8000-0000000000b1', 'aaaa0137-0000-4000-8000-000000000311',
        'aaaa0137-0000-4000-8000-000000000411', 'aaaa0137-0000-4000-8000-0000000000d6',
        'aaaa0137-0000-4000-8000-0000000000d5', 'out', 'aaaa0137-0000-4000-8000-000000000212',
        1, 3, 0.5, 1);

-- ── 1-3 · el invariante ─────────────────────────────────────────────────────
select is(pg_temp.huecos('aaaa0137-0000-4000-8000-0000000000a1'), 'sin_salidas',
  'una línea vendida de un compuesto SIN rastro de ingredientes da sin_salidas');

-- El camino autorizado, EJERCIDO: la API (ladino_api) escribe el rastro.
set local role ladino_api;
select lives_ok($$
  insert into public.sale_line_components
    (id, tenant_id, company_id, document_id, document_line_id, parent_product_id,
     child_product_id, direction, move_id, quantity, functional_amount, recipe_quantity,
     unit_factor)
  values ('aaaa0137-0000-4000-8000-000000000501', 'aaaa0137-0000-4000-8000-00000000000a',
          'aaaa0137-0000-4000-8000-0000000000a1', 'aaaa0137-0000-4000-8000-000000000301',
          'aaaa0137-0000-4000-8000-000000000401', 'aaaa0137-0000-4000-8000-0000000000d2',
          'aaaa0137-0000-4000-8000-0000000000d1', 'out', 'aaaa0137-0000-4000-8000-000000000202',
          1, 3, 0.5, 1) $$,
  'como ladino_api con un actor de A, el rastro de la venta se escribe de verdad');
reset role;
select is(pg_temp.huecos('aaaa0137-0000-4000-8000-0000000000a1'), '',
  'con el rastro escrito y en proporción (0,5 × 2 = 1), el invariante da cero');

-- ── 4-6 · la guarda ─────────────────────────────────────────────────────────
select pg_temp.mover('aaaa0137-0000-4000-8000-000000000203', 'aaaa0137-0000-4000-8000-00000000000a',
  'aaaa0137-0000-4000-8000-0000000000a1', 'aaaa0137-0000-4000-8000-0000000000f1',
  'aaaa0137-0000-4000-8000-0000000000d1', null, -2, -6,
  'aaaa0137-0000-4000-8000-000000000301', now());
select throws_ok($$
  insert into public.sale_line_components
    (tenant_id, company_id, document_id, document_line_id, parent_product_id, child_product_id,
     direction, move_id, quantity, functional_amount, recipe_quantity, unit_factor)
  values ('aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
          'aaaa0137-0000-4000-8000-000000000301', 'aaaa0137-0000-4000-8000-000000000401',
          'aaaa0137-0000-4000-8000-0000000000d2', 'aaaa0137-0000-4000-8000-0000000000d1', 'out',
          'aaaa0137-0000-4000-8000-000000000203', 1, 3, 0.5, 1) $$,
  '23514', 'el componente no coincide con su movimiento de kardex',
  'una fila que dice 1 por 3 sobre un movimiento de 2 por 6 no entra');

-- El atacante realista: e2 es de A y de B. La policy lo deja escribir en los dos; la guarda no
-- lo deja juntar la línea de A con el movimiento de B.
select set_config('ladino.actor_id', 'aaaa0137-0000-4000-8000-0000000000e2', true);
set local role ladino_api;
select throws_ok($$
  insert into public.sale_line_components
    (tenant_id, company_id, document_id, document_line_id, parent_product_id, child_product_id,
     direction, move_id, quantity, functional_amount, recipe_quantity, unit_factor)
  values ('aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
          'aaaa0137-0000-4000-8000-000000000301', 'aaaa0137-0000-4000-8000-000000000401',
          'aaaa0137-0000-4000-8000-0000000000d2', 'aaaa0137-0000-4000-8000-0000000000d1', 'out',
          'aaaa0137-0000-4000-8000-000000000212', 1, 3, 0.5, 1) $$,
  '23514', 'el componente no coincide con su movimiento de kardex',
  'un usuario de los DOS tenants no junta la línea de A con el movimiento de B');
reset role;
select set_config('ladino.actor_id', 'aaaa0137-0000-4000-8000-0000000000e1', true);

select pg_temp.mover('aaaa0137-0000-4000-8000-000000000204', 'aaaa0137-0000-4000-8000-00000000000a',
  'aaaa0137-0000-4000-8000-0000000000a1', 'aaaa0137-0000-4000-8000-0000000000f1',
  'aaaa0137-0000-4000-8000-0000000000d1', null, 1, 3, null, now());
select throws_ok($$
  insert into public.sale_line_components
    (tenant_id, company_id, document_id, document_line_id, parent_product_id, child_product_id,
     direction, move_id, return_id, reverses_move_id, quantity, functional_amount,
     recipe_quantity, unit_factor)
  values ('aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
          'aaaa0137-0000-4000-8000-000000000301', 'aaaa0137-0000-4000-8000-000000000401',
          'aaaa0137-0000-4000-8000-0000000000d2', 'aaaa0137-0000-4000-8000-0000000000d1', 'back',
          'aaaa0137-0000-4000-8000-000000000204', null,
          'aaaa0137-0000-4000-8000-000000000202', 1, 3, 0.5, 1) $$,
  '23514', null,
  'un reingreso sin su devolución no entra (CHECK): no hay vuelta sin documento');

-- ── 7-11 · aislamiento en las cuatro operaciones, mirando el DATO ───────────
select set_config('ladino.actor_id', 'aaaa0137-0000-4000-8000-0000000000e3', true);
set local role ladino_api;
select is((select count(*)::int from public.sale_line_components
            where company_id = 'aaaa0137-0000-4000-8000-0000000000a1'), 0,
  'como ladino_api con un actor de B, el rastro de A no se lee');
select throws_ok($$
  insert into public.sale_line_components
    (tenant_id, company_id, document_id, document_line_id, parent_product_id, child_product_id,
     direction, move_id, quantity, functional_amount, recipe_quantity, unit_factor)
  values ('aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
          'aaaa0137-0000-4000-8000-000000000301', 'aaaa0137-0000-4000-8000-000000000401',
          'aaaa0137-0000-4000-8000-0000000000d2', 'aaaa0137-0000-4000-8000-0000000000d1', 'out',
          'aaaa0137-0000-4000-8000-000000000203', 2, 6, 0.5, 1) $$,
  '42501', null, 'un actor de B no inserta en el tenant de A (42501)');
reset role;

select set_config('ladino.actor_id', 'aaaa0137-0000-4000-8000-0000000000e2', true);
set local role ladino_api;
-- Dos capas, y la de abajo actúa primero: la API no tiene GRANT de UPDATE ni de DELETE, así que
-- recibe 42501 antes de llegar a la policy `false`. Se asevera por SQLSTATE y después el dato.
select throws_ok($$ update public.sale_line_components set quantity = 99
                     where id = 'aaaa0137-0000-4000-8000-000000000501' $$,
  '42501', null, 'la API no tiene privilegio de UPDATE sobre el rastro (42501)');
select throws_ok($$ delete from public.sale_line_components
                     where id = 'aaaa0137-0000-4000-8000-000000000501' $$,
  '42501', null, 'ni de DELETE (42501)');
reset role;
select set_config('ladino.actor_id', 'aaaa0137-0000-4000-8000-0000000000e1', true);
select is((select quantity from public.sale_line_components
            where id = 'aaaa0137-0000-4000-8000-000000000501'), 1::numeric,
  'ni el UPDATE ni el DELETE de la API cambian NADA: la fila sigue, con su cantidad');
select throws_ok($$ update public.sale_line_components set quantity = 99
                     where id = 'aaaa0137-0000-4000-8000-000000000501' $$,
  'LAD06', null, 'y sin la policy, el trigger: el UPDATE del dueño de la tabla muere en LAD06');

select set_config('request.jwt.claims',
  '{"sub":"aaaa0137-0000-4000-8000-0000000000e3","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.sale_line_components
            where company_id = 'aaaa0137-0000-4000-8000-0000000000a1'), 0,
  'como authenticated de B, el rastro de A no se ve');
reset role;

-- ── 12-13 · VARIANTE ROTA del invariante ────────────────────────────────────
create temp table roto (caso text, huecos text);
alter table public.sale_line_components disable trigger user;
update public.sale_line_components set recipe_quantity = 0.75
 where id = 'aaaa0137-0000-4000-8000-000000000501';
insert into roto values ('proporcion', pg_temp.huecos('aaaa0137-0000-4000-8000-0000000000a1'));
update public.sale_line_components set recipe_quantity = 0.5, functional_amount = 3.01
 where id = 'aaaa0137-0000-4000-8000-000000000501';
insert into roto values ('valor', pg_temp.huecos('aaaa0137-0000-4000-8000-0000000000a1'));
update public.sale_line_components set functional_amount = 3
 where id = 'aaaa0137-0000-4000-8000-000000000501';
alter table public.sale_line_components enable trigger user;
select is((select huecos from roto where caso = 'proporcion'), 'fuera_de_proporcion',
  'ROTA: si lo que salió no es la receta por lo vendido, el invariante lo señala');
select is((select huecos from roto where caso = 'valor'), 'movimiento_no_coincide',
  'ROTA: si la fila no vale lo que su movimiento, el invariante lo señala');

-- ── SEGUNDA RONDA (C4) · el reingreso válido, su guarda, y las dos ramas sin variante rota ──
-- Una devolución de la factura de A, y su reingreso: 0,5 de harina por 1,50 (la mitad de lo que
-- salió), como entrada de kardex que cuelga de la devolución.
insert into public.returns (id, tenant_id, company_id, source_document_id, status, reason,
                            warehouse_id)
values ('aaaa0137-0000-4000-8000-000000000601', 'aaaa0137-0000-4000-8000-00000000000a',
        'aaaa0137-0000-4000-8000-0000000000a1', 'aaaa0137-0000-4000-8000-000000000301', 'draft',
        'Devolución 137', 'aaaa0137-0000-4000-8000-0000000000f1');
select pg_temp.mover('aaaa0137-0000-4000-8000-000000000208', 'aaaa0137-0000-4000-8000-00000000000a',
  'aaaa0137-0000-4000-8000-0000000000a1', 'aaaa0137-0000-4000-8000-0000000000f1',
  'aaaa0137-0000-4000-8000-0000000000d1', null, 0.5, 1.5,
  'aaaa0137-0000-4000-8000-000000000601', now());
select pg_temp.mover('aaaa0137-0000-4000-8000-000000000209', 'aaaa0137-0000-4000-8000-00000000000a',
  'aaaa0137-0000-4000-8000-0000000000a1', 'aaaa0137-0000-4000-8000-0000000000f1',
  'aaaa0137-0000-4000-8000-0000000000d1', null, 0.75, 2.25,
  'aaaa0137-0000-4000-8000-000000000601', now());

-- La rama de la guarda «revierte una salida de la MISMA línea»: el movimiento 203 es una salida
-- de esa venta, pero NO está escrito como salida de la línea. (El caso de arriba, sin devolución,
-- muere antes, en el CHECK; este llega a la guarda y se asevera por su mensaje.)
select throws_ok($$
  insert into public.sale_line_components
    (tenant_id, company_id, document_id, document_line_id, parent_product_id, child_product_id,
     direction, move_id, return_id, reverses_move_id, quantity, functional_amount,
     recipe_quantity, unit_factor)
  values ('aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
          'aaaa0137-0000-4000-8000-000000000301', 'aaaa0137-0000-4000-8000-000000000401',
          'aaaa0137-0000-4000-8000-0000000000d2', 'aaaa0137-0000-4000-8000-0000000000d1', 'back',
          'aaaa0137-0000-4000-8000-000000000208', 'aaaa0137-0000-4000-8000-000000000601',
          'aaaa0137-0000-4000-8000-000000000203', 0.5, 1.5, 0.5, 1) $$,
  '23514', 'el reingreso de un componente revierte una salida de la MISMA línea',
  'un reingreso que dice revertir una salida que no es de esa línea no entra (la guarda, no el CHECK)');

-- El reingreso VÁLIDO, por el camino autorizado (la API): entra, y el invariante sigue en cero.
set local role ladino_api;
select lives_ok($$
  insert into public.sale_line_components
    (id, tenant_id, company_id, document_id, document_line_id, parent_product_id,
     child_product_id, direction, move_id, return_id, reverses_move_id, quantity,
     functional_amount, recipe_quantity, unit_factor)
  values ('aaaa0137-0000-4000-8000-000000000502', 'aaaa0137-0000-4000-8000-00000000000a',
          'aaaa0137-0000-4000-8000-0000000000a1', 'aaaa0137-0000-4000-8000-000000000301',
          'aaaa0137-0000-4000-8000-000000000401', 'aaaa0137-0000-4000-8000-0000000000d2',
          'aaaa0137-0000-4000-8000-0000000000d1', 'back', 'aaaa0137-0000-4000-8000-000000000208',
          'aaaa0137-0000-4000-8000-000000000601', 'aaaa0137-0000-4000-8000-000000000202',
          0.5, 1.5, 0.5, 1) $$,
  'como ladino_api, el reingreso de la mitad de lo que salió se escribe de verdad');
reset role;
select is(pg_temp.huecos('aaaa0137-0000-4000-8000-0000000000a1'), '',
  'con un reingreso válido (0,5 de 1; 1,50 de 3), el invariante sigue en cero');

-- ROTA · `devuelto_de_mas`. La guarda NO suma lo ya devuelto (lo calcula el dominio, con la
-- proporción acumulada): un segundo reingreso que coincide con su movimiento ENTRA aunque con él
-- vuelva más de lo que salió (0,5 + 0,75 > 1). La única defensa es el invariante. La fila se
-- escribe y se quita con los triggers apagados, para dejar el escenario como estaba.
alter table public.sale_line_components disable trigger sale_line_components_immutable;
insert into public.sale_line_components
  (id, tenant_id, company_id, document_id, document_line_id, parent_product_id, child_product_id,
   direction, move_id, return_id, reverses_move_id, quantity, functional_amount, recipe_quantity,
   unit_factor)
values ('aaaa0137-0000-4000-8000-000000000503', 'aaaa0137-0000-4000-8000-00000000000a',
        'aaaa0137-0000-4000-8000-0000000000a1', 'aaaa0137-0000-4000-8000-000000000301',
        'aaaa0137-0000-4000-8000-000000000401', 'aaaa0137-0000-4000-8000-0000000000d2',
        'aaaa0137-0000-4000-8000-0000000000d1', 'back', 'aaaa0137-0000-4000-8000-000000000209',
        'aaaa0137-0000-4000-8000-000000000601', 'aaaa0137-0000-4000-8000-000000000202',
        0.75, 2.25, 0.5, 1);
insert into roto values ('de_mas', pg_temp.huecos('aaaa0137-0000-4000-8000-0000000000a1'));
delete from public.sale_line_components where id = 'aaaa0137-0000-4000-8000-000000000503';
alter table public.sale_line_components enable trigger sale_line_components_immutable;
select is((select huecos from roto where caso = 'de_mas'), 'devuelto_de_mas',
  'ROTA: si de una salida vuelve más de lo que salió, el invariante lo señala (la guarda de la fila no lo impide)');
select is(pg_temp.huecos('aaaa0137-0000-4000-8000-0000000000a1'), '',
  'y quitada esa fila, vuelve a cero');

-- `compuesto_con_existencia`. Su primera capa es LAD43: el kardex no acepta un movimiento de un
-- compuesto. Se prueba la guarda…
select throws_ok($$
  select pg_temp.mover('aaaa0137-0000-4000-8000-00000000020a',
    'aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
    'aaaa0137-0000-4000-8000-0000000000f1', 'aaaa0137-0000-4000-8000-0000000000d2', null, 1, 3,
    null, now()) $$,
  'LAD43', null, 'un compuesto no recibe movimientos de kardex (LAD43)');
-- …y la rama del invariante por el otro lado, que LAD43 no cubre: un producto que YA tiene
-- movimientos y aparece marcado compuesto (LAD44 lo impide; aquí se apaga para romperlo).
alter table public.products disable trigger user;
update public.products set is_composed = true where id = 'aaaa0137-0000-4000-8000-0000000000d5';
insert into roto values ('existencia', pg_temp.huecos('aaaa0137-0000-4000-8000-0000000000b1'));
update public.products set is_composed = false where id = 'aaaa0137-0000-4000-8000-0000000000d5';
alter table public.products enable trigger user;
select is((select huecos from roto where caso = 'existencia'), 'compuesto_con_existencia',
  'ROTA: un producto con movimientos marcado compuesto, y el invariante lo señala');
select throws_ok($$ update public.products set is_composed = true
                     where id = 'aaaa0137-0000-4000-8000-0000000000d5' $$,
  'LAD44', null, 'con el trigger puesto, un producto con movimientos no se vuelve compuesto (LAD44)');

-- ── 14-15 · un compuesto vendido no deja de serlo ───────────────────────────
select throws_ok($$ update public.products set is_composed = false
                     where id = 'aaaa0137-0000-4000-8000-0000000000d2' $$,
  'LAD44', 'este producto compuesto ya se vendió: no deja de ser compuesto. Crea otro producto.',
  'un compuesto que ya se vendió no deja de ser compuesto (LAD44), aunque tenga receta');
select lives_ok($$ update public.products set is_composed = false
                    where id = 'aaaa0137-0000-4000-8000-0000000000d3' $$,
  'uno sin vender y sin receta sí deja de serlo');

-- ── 16-17 · el vencimiento se congela con movimientos ───────────────────────
select pg_temp.mover('aaaa0137-0000-4000-8000-000000000205', 'aaaa0137-0000-4000-8000-00000000000a',
  'aaaa0137-0000-4000-8000-0000000000a1', 'aaaa0137-0000-4000-8000-0000000000f1',
  'aaaa0137-0000-4000-8000-0000000000d4', 'aaaa0137-0000-4000-8000-000000000101', 3, 60, null,
  now() - interval '5 days');
select throws_ok($$ update public.products set tracks_expiry = false
                     where id = 'aaaa0137-0000-4000-8000-0000000000d4' $$,
  'LAD38', null, 'con movimientos, la bandera de vencimiento no se cambia (LAD38)');
alter table public.products disable trigger products_tracking_frozen;
select lives_ok($$ update public.products set tracks_expiry = false
                    where id = 'aaaa0137-0000-4000-8000-0000000000d4' $$,
  'ROTA: sin el trigger el cambio entra; lo que lo impide es el trigger, no otra cosa');
update public.products set tracks_expiry = true where id = 'aaaa0137-0000-4000-8000-0000000000d4';
alter table public.products enable trigger products_tracking_frozen;

-- ── 18-21 · LAD46, día contra día en Caracas ────────────────────────────────
-- El lote vence ANTEAYER (día de Caracas). e9 no tiene ningún rol: no puede despachar vencido.
select set_config('ladino.actor_id', 'aaaa0137-0000-4000-8000-0000000000e9', true);
create temp table reloj as
  select (((now() at time zone 'America/Caracas')::date - 2) + time '21:00')
           at time zone 'America/Caracas' as su_dia_de_noche,
         (((now() at time zone 'America/Caracas')::date - 1) + time '00:30')
           at time zone 'America/Caracas' as el_dia_siguiente,
         (now() at time zone 'America/Caracas')::date - 2 as vence;
select is((select (su_dia_de_noche at time zone 'America/Caracas')::date from reloj),
          (select vence from reloj),
  'las 21:00 de Caracas del día en que vence siguen siendo SU día en Caracas');
select is((select (su_dia_de_noche at time zone 'UTC')::date from reloj),
          (select vence + 1 from reloj),
  'ROTA: ese mismo instante, pasado a fecha en UTC, ya es el día siguiente: la expresión anterior lo juzgaba vencido');
select lives_ok($$
  select pg_temp.mover('aaaa0137-0000-4000-8000-000000000206',
    'aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
    'aaaa0137-0000-4000-8000-0000000000f1', 'aaaa0137-0000-4000-8000-0000000000d4',
    'aaaa0137-0000-4000-8000-000000000101', -1, -20, null,
    (select su_dia_de_noche from reloj)) $$,
  'a las 21:00 de Caracas del día en que vence, el lote todavía sale sin el permiso de vencido');
select throws_ok($$
  select pg_temp.mover('aaaa0137-0000-4000-8000-000000000207',
    'aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
    'aaaa0137-0000-4000-8000-0000000000f1', 'aaaa0137-0000-4000-8000-0000000000d4',
    'aaaa0137-0000-4000-8000-000000000101', -1, -20, null,
    (select el_dia_siguiente from reloj)) $$,
  'LAD46', null, 'a las 00:30 del día siguiente ya no sale sin inventory.expired (LAD46)');

select * from finish();
rollback;

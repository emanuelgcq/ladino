-- =============================================================================
-- Ladino — pgTAP 17 · Listas de precios (migración 17, ADR-0032 — dinero)
--
-- Las cuatro pruebas del encargo, con sus negativos:
--   1. price_at contra FECHA PARÁMETRO, y la VARIANTE ROTA con now(): para un
--      documento fechado antes del último cambio de precio, las dos funciones
--      responden importes DISTINTOS — la razón escrita de la firma.
--   2. SOLAPAMIENTO IMPOSIBLE: el EXCLUDE rechaza rangos que se tocan (23P01),
--      y su roto (sin el constraint, el solape entra).
--   3. UPDATE/DELETE imposibles por DOS capas distintas y distinguibles:
--      LAD35 (guardián, ejercido como postgres) y 42501 (GRANT, como la API).
--      El autocierre y close_price() son las únicas mutaciones, y se asertan
--      por el DATO resultante.
--   4. El importe sobrevive al esquema en el límite de numeric(24,8) — y el
--      viaje completo hasta {amount, currency} vive en packages/db
--      (money-roundtrip.test.ts), del lado del cliente.
-- =============================================================================

begin;
select plan(33);

-- ── Fixtures (postgres) ──────────────────────────────────────────────────────
insert into auth.users (id) values ('aaaa0017-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0017-0000-4000-8000-00000000000a', 'Tenant 17-A'),
  ('aaaa0017-0000-4000-8000-00000000000b', 'Tenant 17-B');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0017-0000-4000-8000-0000000000a2', 'aaaa0017-0000-4000-8000-00000000000a', 'J-17-A1', 'Empresa 17-A1'),
  ('aaaa0017-0000-4000-8000-0000000000b2', 'aaaa0017-0000-4000-8000-00000000000b', 'J-17-B1', 'Empresa 17-B1');
insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('aaaa0017-0000-4000-8000-0000000000e1', null, 'lector17', 'Lector', false);
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0017-0000-4000-8000-0000000000a4', 'aaaa0017-0000-4000-8000-00000000000a', 'aaaa0017-0000-4000-8000-0000000000a1');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('aaaa0017-0000-4000-8000-0000000000a5', 'aaaa0017-0000-4000-8000-00000000000a',
   'aaaa0017-0000-4000-8000-0000000000a4', 'aaaa0017-0000-4000-8000-0000000000e1', null);
insert into public.products (id, tenant_id, company_id, sku, name, kind, unit_code, tax_category_code) values
  ('aaaa0017-0000-4000-8000-0000000000d1', 'aaaa0017-0000-4000-8000-00000000000a',
   'aaaa0017-0000-4000-8000-0000000000a2', 'PRECIO-1', 'Producto con precio', 'good', 'unidad', 'gravado_general'),
  ('aaaa0017-0000-4000-8000-0000000000d2', 'aaaa0017-0000-4000-8000-00000000000a',
   'aaaa0017-0000-4000-8000-0000000000a2', 'PRECIO-2', 'Producto límite 24,8', 'good', 'unidad', 'gravado_general');
-- Una lista del tenant B: invisible e inescribible para el actor de A.
insert into public.price_lists (id, tenant_id, company_id, name, currency_code) values
  ('aaaa0017-0000-4000-8000-0000000000c9', 'aaaa0017-0000-4000-8000-00000000000b',
   'aaaa0017-0000-4000-8000-0000000000b2', 'Lista de B', 'USD');

-- ── Estructural ──────────────────────────────────────────────────────────────
select is((select count(*) from pg_extension where extname = 'btree_gist'), 1::bigint,
  'btree_gist instalada: el EXCLUDE por rango existe de verdad');
select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('price_lists','price_list_items')
      and c.relrowsecurity and c.relforcerowsecurity),
  2::bigint, 'RLS habilitada y FORZADA en las dos tablas');

-- ── Como ladino_api, actor UA ────────────────────────────────────────────────
select set_config('ladino.actor_id', 'aaaa0017-0000-4000-8000-0000000000a1', true);
set local role ladino_api;

select lives_ok(
  $$ insert into public.price_lists (id, tenant_id, company_id, name, currency_code)
     values ('aaaa0017-0000-4000-8000-0000000000c1', 'aaaa0017-0000-4000-8000-00000000000a',
             'aaaa0017-0000-4000-8000-0000000000a2', 'PVP', 'VES') $$,
  'la API crea una lista con moneda del catálogo');
select throws_ok(
  $$ insert into public.price_lists (tenant_id, company_id, name, currency_code)
     values ('aaaa0017-0000-4000-8000-00000000000a', 'aaaa0017-0000-4000-8000-0000000000a2',
             'Euros', 'EUR') $$,
  '23503', null, 'una moneda fuera de la tabla currencies muere en el FK (tabla, no CHECK: D-5)');

select lives_ok(
  $$ insert into public.price_list_items (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
     values ('aaaa0017-0000-4000-8000-00000000000a', 'aaaa0017-0000-4000-8000-0000000000a2',
             'aaaa0017-0000-4000-8000-0000000000c1', 'aaaa0017-0000-4000-8000-0000000000d1',
             100.00000000, '2026-08-01T00:00:00Z') $$,
  'primer precio: vigencia abierta desde el 1-ago');
select is(
  (select amount::text from public.price_list_items
    where product_id = 'aaaa0017-0000-4000-8000-0000000000d1' and effective_from = '2026-08-01T00:00:00Z'),
  '100.00000000', 'el importe se guarda con los 8 decimales exactos');

-- El único camino de mutación: un INSERT nuevo AUTOCIERRA al abierto anterior.
select lives_ok(
  $$ insert into public.price_list_items (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
     values ('aaaa0017-0000-4000-8000-00000000000a', 'aaaa0017-0000-4000-8000-0000000000a2',
             'aaaa0017-0000-4000-8000-0000000000c1', 'aaaa0017-0000-4000-8000-0000000000d1',
             123.45678901, '2026-08-05T00:00:00Z') $$,
  'precio nuevo el 5-ago: el INSERT vive y cierra al anterior');
select is(
  (select effective_to from public.price_list_items
    where product_id = 'aaaa0017-0000-4000-8000-0000000000d1' and effective_from = '2026-08-01T00:00:00Z'),
  '2026-08-05T00:00:00Z'::timestamptz,
  'AUTOCIERRE asertado por el DATO: el período anterior terminó donde empieza el nuevo');

-- Solapamiento: imposible, no improbable.
select throws_ok(
  $$ insert into public.price_list_items (tenant_id, company_id, price_list_id, product_id, amount, effective_from, effective_to)
     values ('aaaa0017-0000-4000-8000-00000000000a', 'aaaa0017-0000-4000-8000-0000000000a2',
             'aaaa0017-0000-4000-8000-0000000000c1', 'aaaa0017-0000-4000-8000-0000000000d1',
             1, '2026-08-03T00:00:00Z', '2026-08-04T00:00:00Z') $$,
  '23P01', null, 'un rango dentro de un período CERRADO muere en el EXCLUDE');
select throws_ok(
  $$ insert into public.price_list_items (tenant_id, company_id, price_list_id, product_id, amount, effective_from, effective_to)
     values ('aaaa0017-0000-4000-8000-00000000000a', 'aaaa0017-0000-4000-8000-0000000000a2',
             'aaaa0017-0000-4000-8000-0000000000c1', 'aaaa0017-0000-4000-8000-0000000000d1',
             1, '2026-08-04T00:00:00Z', '2026-08-07T00:00:00Z') $$,
  '23P01', null, 'un rango que cruza la frontera de dos períodos también');
select lives_ok(
  $$ insert into public.price_list_items (tenant_id, company_id, price_list_id, product_id, amount, effective_from, effective_to)
     values ('aaaa0017-0000-4000-8000-00000000000a', 'aaaa0017-0000-4000-8000-0000000000a2',
             'aaaa0017-0000-4000-8000-0000000000c1', 'aaaa0017-0000-4000-8000-0000000000d1',
             50.00000000, '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z') $$,
  'un backfill CERRADO que solo TOCA la frontera vive: los rangos son [)');

-- price_at: la fecha es parámetro. Cuatro fechas, cuatro respuestas correctas.
select is(platform.price_at('aaaa0017-0000-4000-8000-0000000000c1', 'aaaa0017-0000-4000-8000-0000000000d1',
                            '2026-08-06T00:00:00Z'), 123.45678901::numeric,
  'price_at en el período nuevo: el precio del 5-ago');
select is(platform.price_at('aaaa0017-0000-4000-8000-0000000000c1', 'aaaa0017-0000-4000-8000-0000000000d1',
                            '2026-08-02T00:00:00Z'), 100.00000000::numeric,
  'price_at el 2-ago: el precio VIEJO — un documento de ayer recalcula con el precio de ayer');
select is(platform.price_at('aaaa0017-0000-4000-8000-0000000000c1', 'aaaa0017-0000-4000-8000-0000000000d1',
                            '2026-07-15T00:00:00Z'), 50.00000000::numeric,
  'price_at dentro del backfill');
select is(platform.price_at('aaaa0017-0000-4000-8000-0000000000c1', 'aaaa0017-0000-4000-8000-0000000000d1',
                            '2026-06-01T00:00:00Z'), null::numeric,
  'antes de toda vigencia: NULL, no un invento');

-- El importe en el LÍMITE de numeric(24,8): 16 enteros + 8 decimales.
select lives_ok(
  $$ insert into public.price_list_items (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
     values ('aaaa0017-0000-4000-8000-00000000000a', 'aaaa0017-0000-4000-8000-0000000000a2',
             'aaaa0017-0000-4000-8000-0000000000c1', 'aaaa0017-0000-4000-8000-0000000000d2',
             1234567890123456.12345678, '2026-08-01T00:00:00Z') $$,
  'el importe máximo representable entra');
select is(
  (select amount::text from public.price_list_items
    where product_id = 'aaaa0017-0000-4000-8000-0000000000d2'),
  '1234567890123456.12345678',
  'y sale con los 24 dígitos intactos (el viaje al cliente: packages/db money-roundtrip)');

-- Capa GRANT: la API no puede ni intentar mutar.
select throws_ok(
  $$ update public.price_list_items set amount = 999 where product_id = 'aaaa0017-0000-4000-8000-0000000000d1' $$,
  '42501', null, 'UPDATE como la API: 42501 — ni siquiera llega al guardián (capa de privilegio)');
select throws_ok(
  $$ delete from public.price_list_items where product_id = 'aaaa0017-0000-4000-8000-0000000000d1' $$,
  '42501', null, 'DELETE como la API: 42501');
-- Aislamiento: la lista de B no existe para el actor de A.
select is((select count(*) from public.price_lists), 1::bigint,
  'el actor de A ve UNA lista: la suya; la de B no existe');
select throws_ok(
  $$ insert into public.price_list_items (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
     values ('aaaa0017-0000-4000-8000-00000000000b', 'aaaa0017-0000-4000-8000-0000000000b2',
             'aaaa0017-0000-4000-8000-0000000000c9', 'aaaa0017-0000-4000-8000-0000000000d1',
             1, '2026-08-01T00:00:00Z') $$,
  '42501', null, 'cargar un precio en la lista de OTRO tenant: 42501 (RLS de ladino_api)');

-- close_price(): el retiro sin sustituto, el único UPDATE sancionado para la API.
select lives_ok(
  $$ select platform.close_price(
       (select id from public.price_list_items
         where product_id = 'aaaa0017-0000-4000-8000-0000000000d1' and effective_to is null),
       '2026-09-01T00:00:00Z') $$,
  'close_price cierra la vigencia abierta desde la API');
select is(
  (select effective_to from public.price_list_items
    where product_id = 'aaaa0017-0000-4000-8000-0000000000d1' and effective_from = '2026-08-05T00:00:00Z'),
  '2026-09-01T00:00:00Z'::timestamptz, 'y el cierre quedó en el dato');
select is(platform.price_at('aaaa0017-0000-4000-8000-0000000000c1', 'aaaa0017-0000-4000-8000-0000000000d1',
                            '2026-09-02T00:00:00Z'), null::numeric,
  'retirado sin sustituto: después del cierre no hay precio');
select throws_ok(
  $$ select platform.close_price(
       (select id from public.price_list_items
         where product_id = 'aaaa0017-0000-4000-8000-0000000000d1' and effective_from = '2026-08-05T00:00:00Z'),
       '2026-10-01T00:00:00Z') $$,
  'LAD35', null, 'cerrar dos veces: LAD35 — una vigencia cerrada no se reabre ni se mueve');
reset role;

-- ── Capa GUARDIÁN (como postgres, que SÍ tiene privilegios): LAD35 ──────────
select throws_ok(
  $$ update public.price_list_items set amount = 999
      where product_id = 'aaaa0017-0000-4000-8000-0000000000d1' and effective_from = '2026-08-05T00:00:00Z' $$,
  'LAD35', null, 'cambiar amount: LAD35 — corregir un precio es una fila nueva, estructural');
select throws_ok(
  $$ update public.price_list_items set effective_from = '2026-08-06T00:00:00Z'
      where product_id = 'aaaa0017-0000-4000-8000-0000000000d1' and effective_from = '2026-08-05T00:00:00Z' $$,
  'LAD35', null, 'mover effective_from: LAD35');
select throws_ok(
  $$ update public.price_list_items set effective_to = null
      where product_id = 'aaaa0017-0000-4000-8000-0000000000d1' and effective_from = '2026-08-05T00:00:00Z' $$,
  'LAD35', null, 'REABRIR un período cerrado: LAD35 — la única transición es NULL→valor');
select throws_ok(
  $$ delete from public.price_list_items
      where product_id = 'aaaa0017-0000-4000-8000-0000000000d1' $$,
  'LAD35', null, 'DELETE: LAD35 incluso para quien tiene el privilegio');

-- ── VARIANTE ROTA 1: price_at con now() ─────────────────────────────────────
-- La función que alguien escribiría al «simplificar» la firma en dos años.
create function pg_temp.roto_price_at_now(p_list uuid, p_product uuid)
returns numeric language sql stable as $$
  select i.amount from public.price_list_items i
   where i.price_list_id = p_list and i.product_id = p_product
     and i.effective_from <= now()
     and (i.effective_to is null or i.effective_to > now());
$$;
-- Hoy (fecha del test) el vigente es el del 5-ago (123.456…); un documento
-- fechado el 2-ago debe llevar 100. La función rota responde lo de HOY.
select is(pg_temp.roto_price_at_now('aaaa0017-0000-4000-8000-0000000000c1',
                                    'aaaa0017-0000-4000-8000-0000000000d1'),
  123.45678901::numeric,
  'ROTO: la variante con now() responde el precio de HOY…');
select isnt(
  pg_temp.roto_price_at_now('aaaa0017-0000-4000-8000-0000000000c1', 'aaaa0017-0000-4000-8000-0000000000d1'),
  platform.price_at('aaaa0017-0000-4000-8000-0000000000c1', 'aaaa0017-0000-4000-8000-0000000000d1',
                    '2026-08-02T00:00:00Z'),
  '…y DIFIERE de price_at con la fecha del documento: por esto la fecha es parámetro y no se «simplifica»');

-- ── VARIANTE ROTA 2: sin el EXCLUDE, el solape ENTRA ────────────────────────
alter table public.price_list_items drop constraint price_list_items_no_overlap;
select lives_ok(
  $$ insert into public.price_list_items (tenant_id, company_id, price_list_id, product_id, amount, effective_from, effective_to)
     values ('aaaa0017-0000-4000-8000-00000000000a', 'aaaa0017-0000-4000-8000-0000000000a2',
             'aaaa0017-0000-4000-8000-0000000000c1', 'aaaa0017-0000-4000-8000-0000000000d1',
             1, '2026-08-03T00:00:00Z', '2026-08-04T00:00:00Z') $$,
  'ROTO: sin el EXCLUDE, el mismo rango que el test 8 rechazó ENTRA — la aserción mide el constraint');
select is(
  (select count(*) from public.price_list_items
    where product_id = 'aaaa0017-0000-4000-8000-0000000000d1'
      and effective_from <= '2026-08-03T12:00:00Z'
      and (effective_to is null or effective_to > '2026-08-03T12:00:00Z')),
  2::bigint,
  'y el 3-ago a mediodía hay DOS precios «vigentes»: exactamente el estado que el EXCLUDE hace imposible');

select * from finish();
rollback;

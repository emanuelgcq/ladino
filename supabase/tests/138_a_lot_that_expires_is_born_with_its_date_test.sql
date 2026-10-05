-- =============================================================================
-- Ladino — pgTAP 138 · C-07, segunda ronda (migración 20261005130200)
--
-- UN LOTE DE UN PRODUCTO QUE VENCE NACE CON SU FECHA.
--
-- «Lote nuevo con fecha» vivía solo en el dominio (`resolverLote`). Un lote sin fecha de un
-- producto con `tracks_expiry` queda siempre al final del reparto por vencimiento y no vence
-- nunca. La guarda es del esquema, por los dos lados: el lote (alta y cambio) y el producto
-- (encender el vencimiento).
--
-- Dos tenants (A y B) y TRES usuarios: e1 es de A, e3 es de B, y e2 es de LOS DOS.
--
--   1-2.  el lote sin fecha de un producto que vence no entra: ni por el dueño de la tabla ni por
--         el camino de la API (LAD73, por SQLSTATE y por mensaje);
--   3-4.  lo permitido, EJERCIDO como ladino_api: el lote con fecha entra, y el lote sin fecha de
--         un producto que NO vence también (el caso legítimo que la guarda no debe romper);
--   5-6.  por UPDATE tampoco: ni quitarle la fecha a un lote, ni pasar un lote sin fecha a un
--         producto que vence; y el dato sigue como estaba;
--   7-8.  encender el vencimiento de un producto con un lote sin fecha no entra (LAD73), y con el
--         lote ya fechado sí;
--   9-10. VARIANTES ROTAS: sin cada trigger, el caso malo entra; lo que lo impide es el trigger;
--   11-14. aislamiento: como ladino_api con un actor de B, el lote de A no se lee, no se
--         actualiza (0 filas, dato intacto) y no se inserta en A (42501); el usuario de los DOS
--         tenants no cuelga un lote de A de un producto de B (23503);
--   15.   la pregunta del despliegue da cero: ningún lote sin fecha de un producto que vence.
-- =============================================================================

begin;
select plan(15);
set local lock_timeout = '4s';

insert into auth.users (id) values
  ('aaaa0138-0000-4000-8000-0000000000e1'),
  ('aaaa0138-0000-4000-8000-0000000000e2'),
  ('aaaa0138-0000-4000-8000-0000000000e3');
insert into public.tenants (id, name) values
  ('aaaa0138-0000-4000-8000-00000000000a', 'Tenant 138 A'),
  ('aaaa0138-0000-4000-8000-00000000000b', 'Tenant 138 B');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code) values
  ('aaaa0138-0000-4000-8000-0000000000a1', 'aaaa0138-0000-4000-8000-00000000000a',
   'V138100018', 'Quesera 138 A', 'VES'),
  ('aaaa0138-0000-4000-8000-0000000000b1', 'aaaa0138-0000-4000-8000-00000000000b',
   'V138100026', 'Quesera 138 B', 'VES');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0138-0000-4000-8000-0000000001a1', 'aaaa0138-0000-4000-8000-00000000000a',
   'aaaa0138-0000-4000-8000-0000000000e1'),
  ('aaaa0138-0000-4000-8000-0000000001a2', 'aaaa0138-0000-4000-8000-00000000000a',
   'aaaa0138-0000-4000-8000-0000000000e2'),
  ('aaaa0138-0000-4000-8000-0000000001b2', 'aaaa0138-0000-4000-8000-00000000000b',
   'aaaa0138-0000-4000-8000-0000000000e2'),
  ('aaaa0138-0000-4000-8000-0000000001b3', 'aaaa0138-0000-4000-8000-00000000000b',
   'aaaa0138-0000-4000-8000-0000000000e3');
insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
select m.tenant_id, m.id, r.id, null
  from public.memberships m
  join public.roles r on r.key = 'owner' and r.tenant_id is null
 where m.id in ('aaaa0138-0000-4000-8000-0000000001a1', 'aaaa0138-0000-4000-8000-0000000001a2',
                'aaaa0138-0000-4000-8000-0000000001b2', 'aaaa0138-0000-4000-8000-0000000001b3');
select set_config('ladino.actor_id', 'aaaa0138-0000-4000-8000-0000000000e1', true);

-- d1 queso A (lote y vencimiento) · d2 tornillo A (lote, SIN vencimiento) · d3 jamón A (lote, sin
-- vencimiento: el que se intenta encender) · d4 queso B (lote y vencimiento)
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code, is_composed, tracks_lots, tracks_expiry) values
  ('aaaa0138-0000-4000-8000-0000000000d1', 'aaaa0138-0000-4000-8000-00000000000a',
   'aaaa0138-0000-4000-8000-0000000000a1', 'Q-138', 'Queso 138', 'good', 'active', 'unidad',
   'gravado_general', false, true, true),
  ('aaaa0138-0000-4000-8000-0000000000d2', 'aaaa0138-0000-4000-8000-00000000000a',
   'aaaa0138-0000-4000-8000-0000000000a1', 'T-138', 'Tornillo 138', 'good', 'active', 'unidad',
   'gravado_general', false, true, false),
  ('aaaa0138-0000-4000-8000-0000000000d3', 'aaaa0138-0000-4000-8000-00000000000a',
   'aaaa0138-0000-4000-8000-0000000000a1', 'J-138', 'Jamón 138', 'good', 'active', 'unidad',
   'gravado_general', false, true, false),
  ('aaaa0138-0000-4000-8000-0000000000d4', 'aaaa0138-0000-4000-8000-00000000000b',
   'aaaa0138-0000-4000-8000-0000000000b1', 'Q-138', 'Queso 138 B', 'good', 'active', 'unidad',
   'gravado_general', false, true, true);

-- ── 1-2 · el lote sin fecha de un producto que vence no entra ───────────────
select throws_ok($$
  insert into public.lots (tenant_id, company_id, product_id, code, expires_at)
  values ('aaaa0138-0000-4000-8000-00000000000a', 'aaaa0138-0000-4000-8000-0000000000a1',
          'aaaa0138-0000-4000-8000-0000000000d1', 'SIN-FECHA', null) $$,
  'LAD73', 'el lote «SIN-FECHA» de «Queso 138» no tiene fecha de vencimiento: este producto lleva vencimiento y cada lote suyo nace con su fecha',
  'el dueño de la tabla tampoco crea un lote sin fecha para un producto que vence (LAD73)');
set local role ladino_api;
select throws_ok($$
  insert into public.lots (tenant_id, company_id, product_id, code)
  values ('aaaa0138-0000-4000-8000-00000000000a', 'aaaa0138-0000-4000-8000-0000000000a1',
          'aaaa0138-0000-4000-8000-0000000000d1', 'SIN-FECHA-API') $$,
  'LAD73', null, 'ni la API, omitiendo la columna (LAD73, no 42501: llegó al trigger)');

-- ── 3-4 · lo permitido, ejercido ────────────────────────────────────────────
select lives_ok($$
  insert into public.lots (id, tenant_id, company_id, product_id, code, expires_at)
  values ('aaaa0138-0000-4000-8000-000000000101', 'aaaa0138-0000-4000-8000-00000000000a',
          'aaaa0138-0000-4000-8000-0000000000a1', 'aaaa0138-0000-4000-8000-0000000000d1',
          'CON-FECHA', (now() at time zone 'America/Caracas')::date + 30) $$,
  'como ladino_api, el lote CON fecha de un producto que vence entra');
select lives_ok($$
  insert into public.lots (id, tenant_id, company_id, product_id, code)
  values ('aaaa0138-0000-4000-8000-000000000102', 'aaaa0138-0000-4000-8000-00000000000a',
          'aaaa0138-0000-4000-8000-0000000000a1', 'aaaa0138-0000-4000-8000-0000000000d2',
          'TORNILLOS-1'),
         ('aaaa0138-0000-4000-8000-000000000103', 'aaaa0138-0000-4000-8000-00000000000a',
          'aaaa0138-0000-4000-8000-0000000000a1', 'aaaa0138-0000-4000-8000-0000000000d3',
          'JAMON-1') $$,
  'y el lote SIN fecha de un producto que no vence también: la guarda no rompe el caso legítimo');

-- ── 5-6 · por UPDATE tampoco ────────────────────────────────────────────────
select throws_ok($$ update public.lots set expires_at = null
                     where id = 'aaaa0138-0000-4000-8000-000000000101' $$,
  'LAD73', null, 'a un lote de un producto que vence no se le quita la fecha (LAD73)');
reset role;
select throws_ok($$ update public.lots set product_id = 'aaaa0138-0000-4000-8000-0000000000d1'
                     where id = 'aaaa0138-0000-4000-8000-000000000102' $$,
  'LAD73', null, 'ni se pasa un lote sin fecha a un producto que vence (LAD73)');

-- ── 7-8 · encender el vencimiento ───────────────────────────────────────────
select throws_ok($$ update public.products set tracks_expiry = true
                     where id = 'aaaa0138-0000-4000-8000-0000000000d3' $$,
  'LAD73', 'el producto «Jamón 138» tiene 1 lote(s) sin fecha de vencimiento: ponles su fecha antes de encender el vencimiento',
  'encender el vencimiento de un producto con un lote sin fecha no entra (LAD73), aunque no tenga movimientos');
update public.lots set expires_at = (now() at time zone 'America/Caracas')::date + 10
 where id = 'aaaa0138-0000-4000-8000-000000000103';
select lives_ok($$ update public.products set tracks_expiry = true
                    where id = 'aaaa0138-0000-4000-8000-0000000000d3' $$,
  'con el lote ya fechado, el vencimiento se enciende');

-- ── 9-10 · VARIANTES ROTAS ──────────────────────────────────────────────────
alter table public.lots disable trigger lots_10_expiry_date;
select lives_ok($$
  insert into public.lots (id, tenant_id, company_id, product_id, code)
  values ('aaaa0138-0000-4000-8000-000000000109', 'aaaa0138-0000-4000-8000-00000000000a',
          'aaaa0138-0000-4000-8000-0000000000a1', 'aaaa0138-0000-4000-8000-0000000000d1',
          'ROTO') $$,
  'ROTA: sin el trigger del lote, el lote sin fecha entra; lo que lo impide es el trigger');
delete from public.lots where id = 'aaaa0138-0000-4000-8000-000000000109';
alter table public.lots enable trigger lots_10_expiry_date;

update public.products set tracks_expiry = false where id = 'aaaa0138-0000-4000-8000-0000000000d3';
update public.lots set expires_at = null where id = 'aaaa0138-0000-4000-8000-000000000103';
alter table public.products disable trigger products_expiry_needs_dated_lots;
select lives_ok($$ update public.products set tracks_expiry = true
                    where id = 'aaaa0138-0000-4000-8000-0000000000d3' $$,
  'ROTA: sin el trigger del producto, el vencimiento se enciende con un lote sin fecha');
update public.products set tracks_expiry = false where id = 'aaaa0138-0000-4000-8000-0000000000d3';
alter table public.products enable trigger products_expiry_needs_dated_lots;

-- ── 11-13 · aislamiento, mirando el DATO ────────────────────────────────────
select set_config('ladino.actor_id', 'aaaa0138-0000-4000-8000-0000000000e3', true);
set local role ladino_api;
select is((select count(*)::int from public.lots
            where company_id = 'aaaa0138-0000-4000-8000-0000000000a1'), 0,
  'como ladino_api con un actor de B, los lotes de A no se leen');
update public.lots set code = 'SECUESTRADO' where id = 'aaaa0138-0000-4000-8000-000000000101';
select throws_ok($$
  insert into public.lots (tenant_id, company_id, product_id, code, expires_at)
  values ('aaaa0138-0000-4000-8000-00000000000a', 'aaaa0138-0000-4000-8000-0000000000a1',
          'aaaa0138-0000-4000-8000-0000000000d1', 'DE-B', (now() at time zone 'America/Caracas')::date + 5) $$,
  '42501', null, 'un actor de B no inserta un lote en el tenant de A (42501)');
reset role;
select is((select code from public.lots where id = 'aaaa0138-0000-4000-8000-000000000101'),
          'CON-FECHA', 'y su UPDATE sobre el lote de A no cambió NADA');

-- El usuario de los DOS tenants: la policy lo deja escribir en A y en B; no cuelga un lote de A
-- de un producto de B (la FK compuesta por empresa), y la guarda no le dice nada del producto ajeno.
select set_config('ladino.actor_id', 'aaaa0138-0000-4000-8000-0000000000e2', true);
set local role ladino_api;
select throws_ok($$
  insert into public.lots (tenant_id, company_id, product_id, code)
  values ('aaaa0138-0000-4000-8000-00000000000a', 'aaaa0138-0000-4000-8000-0000000000a1',
          'aaaa0138-0000-4000-8000-0000000000d4', 'CRUZADO') $$,
  '23503', null,
  'un usuario de los DOS tenants no cuelga un lote de A de un producto de B (23503, no LAD73)');
reset role;

-- ── 14 · la pregunta del despliegue ─────────────────────────────────────────
select is((select count(*)::int
             from public.lots l
             join public.products p on p.id = l.product_id
            where p.tracks_expiry and l.expires_at is null
              and l.company_id in ('aaaa0138-0000-4000-8000-0000000000a1',
                                   'aaaa0138-0000-4000-8000-0000000000b1')), 0,
  'al final no queda ningún lote sin fecha de un producto que vence');

select * from finish();
rollback;

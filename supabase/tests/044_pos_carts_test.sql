-- =============================================================================
-- Ladino — pgTAP 44 · Las cuentas abiertas del POS (migración 44)
--
--   1. la tabla lleva su ancla de aislamiento (familia del test 006);
--   2. se crea, se actualiza (mutable A PROPÓSITO: no es documento) y se
--      borra — el borrado es el CIERRE al cobrar;
--   3. las líneas tienen que ser un array JSON: un objeto suelto se rechaza;
--   4. mover el carrito de tenant se rechaza (el ancla muerde).
-- =============================================================================

begin;
select plan(6);

insert into public.tenants (id, name) values
  ('aaaa0044-0000-4000-8000-00000000000a', 'Tenant 44'),
  ('aaaa0044-0000-4000-8000-00000000000b', 'Tenant 44-B');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0044-0000-4000-8000-0000000000a1', 'aaaa0044-0000-4000-8000-00000000000a',
   'J-44-A', 'Bodega multicuenta');

-- ── 1. El ancla existe (la familia manda: cero excepciones) ──────────────────
select is(
  (select count(*) from pg_trigger
    where tgrelid = 'public.pos_carts'::regclass and tgname = 'pos_carts_01_anchors'),
  1::bigint, 'pos_carts lleva su trigger de ancla de aislamiento');

-- ── 2. Nace, muta y muere ────────────────────────────────────────────────────
select lives_ok(
  $$insert into public.pos_carts (id, tenant_id, company_id, label, lines)
    values ('aaaa0044-0000-4000-8000-00000000cc01',
            'aaaa0044-0000-4000-8000-00000000000a', 'aaaa0044-0000-4000-8000-0000000000a1',
            'Cuenta 1', '[{"product_id":"x","qty":"2"}]')$$,
  'una cuenta abierta se crea');

select lives_ok(
  $$update public.pos_carts
      set lines = '[{"product_id":"x","qty":"3"}]', label = 'Vecina Carmen'
    where id = 'aaaa0044-0000-4000-8000-00000000cc01'$$,
  'y MUTA sin drama: es intención, no documento');

select lives_ok(
  $$delete from public.pos_carts where id = 'aaaa0044-0000-4000-8000-00000000cc01'$$,
  'y muere al cobrarse: el DELETE es el cierre');

-- ── 3. Las líneas son un array o no son ──────────────────────────────────────
select throws_ok(
  $$insert into public.pos_carts (id, tenant_id, company_id, label, lines)
    values ('aaaa0044-0000-4000-8000-00000000cc02',
            'aaaa0044-0000-4000-8000-00000000000a', 'aaaa0044-0000-4000-8000-0000000000a1',
            'Rota', '{"product_id":"x"}')$$,
  '23514', null,
  'un objeto suelto en lines se rechaza: el CHECK exige array');

-- ── 4. El ancla muerde ───────────────────────────────────────────────────────
insert into public.pos_carts (id, tenant_id, company_id, label, lines)
values ('aaaa0044-0000-4000-8000-00000000cc03',
        'aaaa0044-0000-4000-8000-00000000000a', 'aaaa0044-0000-4000-8000-0000000000a1',
        'Anclada', '[]');
select throws_ok(
  $$update public.pos_carts set tenant_id = 'aaaa0044-0000-4000-8000-00000000000b'
     where id = 'aaaa0044-0000-4000-8000-00000000cc03'$$,
  null, null,
  'cambiar el tenant de una cuenta se rechaza: el ancla es inmutable');

select * from finish();
rollback;

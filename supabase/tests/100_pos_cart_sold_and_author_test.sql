-- =============================================================================
-- Ladino — pgTAP 100 · La cuenta vendida muere en el servidor, y cada cuenta tiene dueño
-- (migración 20261003100000, ADR-0076: M-01, M-02, M-03, E-08, O-02)
--
--   1. las columnas nuevas existen y el par vendida/venta va junto (CHECK);
--   2. sale_id apunta a un documento DE LA EMPRESA (FK compuesta);
--   3. una cuenta vendida no se edita ni se borra (LAD06) — y su variante rota: sin el
--      trigger, la edición entra, así que el rechazo de arriba lo pone el trigger;
--   4. una cuenta ABIERTA sigue mutando y borrándose sin drama (el camino permitido, ejercido);
--   5. el permiso pos.carts.manage está en dueño y administrativo, y NO en cajero ni encargado
--      (20261003100100: §2.8, el encargado no vende); la función del trigger no la ejecuta anon;
--   6. la RLS de ladino_api: con el actor de A no se lee, no se cambia (0 filas, dato intacto)
--      ni se inserta (42501) una cuenta de B; el usuario de los DOS tenants ve las dos.
-- =============================================================================

begin;
select plan(20);

insert into auth.users (id) values
  ('aaaa0100-0000-4000-8000-0000000000a1'),   -- UA: solo tenant A
  ('aaaa0100-0000-4000-8000-0000000000c1');   -- UM: A y B (el atacante realista)
insert into public.tenants (id, name) values
  ('aaaa0100-0000-4000-8000-00000000000a', 'Tenant 100-A'),
  ('aaaa0100-0000-4000-8000-00000000000b', 'Tenant 100-B');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0100-0000-4000-8000-0000000000a2', 'aaaa0100-0000-4000-8000-00000000000a', 'J-100-A', 'Bodega A'),
  ('aaaa0100-0000-4000-8000-0000000000b2', 'aaaa0100-0000-4000-8000-00000000000b', 'J-100-B', 'Bodega B');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0100-0000-4000-8000-0000000000a3', 'aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a1'),
  ('aaaa0100-0000-4000-8000-0000000000c3', 'aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000c1'),
  ('aaaa0100-0000-4000-8000-0000000000c4', 'aaaa0100-0000-4000-8000-00000000000b', 'aaaa0100-0000-4000-8000-0000000000c1');

-- Un documento de A para hacer de venta (borrador: sin numeración, sin régimen).
insert into public.customers (id, tenant_id, company_id, legal_name, person_type_code,
                              taxpayer_type_code)
values ('aaaa0100-0000-4000-8000-0000000000a5', 'aaaa0100-0000-4000-8000-00000000000a',
        'aaaa0100-0000-4000-8000-0000000000a2', 'Cliente 100', 'natural', 'consumidor_final');
insert into public.documents
  (id, tenant_id, company_id, kind, customer_id, transaction_currency, functional_currency,
   fx_rate, rate_source, amount_transaction_currency, functional_amount, subtotal_amount,
   tax_amount, total_amount)
values ('aaaa0100-0000-4000-8000-0000000000d1', 'aaaa0100-0000-4000-8000-00000000000a',
        'aaaa0100-0000-4000-8000-0000000000a2', 'quote', 'aaaa0100-0000-4000-8000-0000000000a5',
        'VES', 'VES', 1, 'identidad', 0, 0, 0, 0, 0);

insert into public.pos_carts (id, tenant_id, company_id, label, lines) values
  ('aaaa0100-0000-4000-8000-00000000cc01', 'aaaa0100-0000-4000-8000-00000000000a',
   'aaaa0100-0000-4000-8000-0000000000a2', 'Cuenta A', '[]'),
  ('aaaa0100-0000-4000-8000-00000000cc02', 'aaaa0100-0000-4000-8000-00000000000b',
   'aaaa0100-0000-4000-8000-0000000000b2', 'Cuenta B', '[]');

-- ── 1. Columnas y par ────────────────────────────────────────────────────────
select has_column('public', 'pos_carts', 'sold_at', 'pos_carts.sold_at existe');
select has_column('public', 'pos_carts', 'sale_id', 'pos_carts.sale_id existe');
select has_column('public', 'pos_carts', 'station_id', 'pos_carts.station_id (la caja) existe');
select throws_ok(
  $$update public.pos_carts set sold_at = now() where id = 'aaaa0100-0000-4000-8000-00000000cc01'$$,
  '23514', null, 'vendida sin venta se rechaza: sold_at y sale_id van juntos');

-- ── 2. La venta es de la empresa ─────────────────────────────────────────────
select throws_ok(
  $$update public.pos_carts set sold_at = now(), sale_id = gen_random_uuid()
     where id = 'aaaa0100-0000-4000-8000-00000000cc01'$$,
  '23503', null, 'sale_id sin documento de la empresa se rechaza (FK compuesta)');

-- ── 3. La lápida ─────────────────────────────────────────────────────────────
select lives_ok(
  $$update public.pos_carts set sold_at = now(), sale_id = 'aaaa0100-0000-4000-8000-0000000000d1'
     where id = 'aaaa0100-0000-4000-8000-00000000cc01'$$,
  'la venta MARCA la cuenta (el camino permitido, ejercido)');
select throws_ok(
  $$update public.pos_carts set lines = '[{"product_id":"x","qty":"9"}]'
     where id = 'aaaa0100-0000-4000-8000-00000000cc01'$$,
  'LAD06', null, 'una cuenta vendida no se edita: la subida tardía no la resucita');
select throws_ok(
  $$delete from public.pos_carts where id = 'aaaa0100-0000-4000-8000-00000000cc01'$$,
  'LAD06', null, 'una cuenta vendida no se borra: es la constancia de quién la armó');

-- Variante rota: sin el trigger, la edición entra. El rechazo de arriba lo pone el trigger,
-- no otra cosa (ni RLS, ni privilegios, ni un CHECK).
alter table public.pos_carts disable trigger pos_carts_02_sold_is_final;
select lives_ok(
  $$update public.pos_carts set label = 'Resucitada' where id = 'aaaa0100-0000-4000-8000-00000000cc01'$$,
  'variante rota: sin el trigger la cuenta vendida se edita — el test de arriba mide el trigger');
alter table public.pos_carts enable trigger pos_carts_02_sold_is_final;

-- ── 4. La abierta sigue siendo intención ─────────────────────────────────────
insert into public.pos_carts (id, tenant_id, company_id, label, lines) values
  ('aaaa0100-0000-4000-8000-00000000cc03', 'aaaa0100-0000-4000-8000-00000000000a',
   'aaaa0100-0000-4000-8000-0000000000a2', 'Abierta', '[]');
select lives_ok(
  $$update public.pos_carts set label = 'Abierta 2' where id = 'aaaa0100-0000-4000-8000-00000000cc03'$$,
  'una cuenta abierta muta');
select lives_ok(
  $$delete from public.pos_carts where id = 'aaaa0100-0000-4000-8000-00000000cc03'$$,
  'y se descarta');

-- ── 5. El permiso de las cuentas ajenas ──────────────────────────────────────
select is(
  (select count(*) from public.role_permissions rp
     join public.roles r on r.id = rp.role_id and r.tenant_id is null
    where rp.permission_key = 'pos.carts.manage'
      and r.key in ('owner', 'back_office')),
  2::bigint, 'pos.carts.manage: dueño y administrativo');
select is(
  (select count(*) from public.role_permissions rp
     join public.roles r on r.id = rp.role_id and r.tenant_id is null
    where rp.permission_key = 'pos.carts.manage' and r.key in ('cashier', 'store_manager')),
  0::bigint, 'ni el cajero ni el encargado lo tienen: el caso que la regla separa, y §2.8');
select ok(
  not has_function_privilege('anon', 'platform.pos_cart_sold_is_final()', 'execute'),
  'la función del trigger no es una API: anon no la ejecuta');

-- ── 6. RLS de ladino_api ─────────────────────────────────────────────────────
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select is(
  (select count(*) from public.pos_carts where id = 'aaaa0100-0000-4000-8000-00000000cc02'),
  0::bigint, 'ladino_api con el actor de A no LEE la cuenta de B');
update public.pos_carts set label = 'SECUESTRADA' where id = 'aaaa0100-0000-4000-8000-00000000cc02';
select throws_ok(
  $$insert into public.pos_carts (id, tenant_id, company_id, label, lines)
    values ('aaaa0100-0000-4000-8000-00000000cc04', 'aaaa0100-0000-4000-8000-00000000000b',
            'aaaa0100-0000-4000-8000-0000000000b2', 'Colada', '[]')$$,
  '42501', null, 'ladino_api con el actor de A no INSERTA en B');
select lives_ok(
  $$insert into public.pos_carts (id, tenant_id, company_id, label, lines)
    values ('aaaa0100-0000-4000-8000-00000000cc05', 'aaaa0100-0000-4000-8000-00000000000a',
            'aaaa0100-0000-4000-8000-0000000000a2', 'Propia', '[]')$$,
  'y en su tenant sí inserta: la policy no cierra el camino autorizado');
delete from public.pos_carts where id = 'aaaa0100-0000-4000-8000-00000000cc02';
reset role;
select is(
  (select label from public.pos_carts where id = 'aaaa0100-0000-4000-8000-00000000cc02'),
  'Cuenta B', 'el UPDATE y el DELETE de A sobre B afectaron CERO filas: el dato está intacto');

select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000c1', true);
set local role ladino_api;
select is(
  (select count(*) from public.pos_carts
    where id in ('aaaa0100-0000-4000-8000-00000000cc01', 'aaaa0100-0000-4000-8000-00000000cc02')),
  2::bigint, 'el usuario de los DOS tenants ve las dos (la RLS es por tenant del actor)');
reset role;

select set_config('ladino.actor_id', '', true);
set local role ladino_api;
select is(
  (select count(*) from public.pos_carts where tenant_id in
     ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-00000000000b')),
  0::bigint, 'sin actor, ladino_api no ve NINGUNA cuenta (antes: using (true), todas)');
reset role;

select * from finish();
rollback;

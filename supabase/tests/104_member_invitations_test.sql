-- =============================================================================
-- Ladino — pgTAP 104 · LA INVITACIÓN POR ENLACE Y LA SEGUNDA EMPRESA (ADR-0077)
-- Migración 20261003120000_invitations_and_another_company.sql. Hallazgos A-13, N-08, N-03.
--
-- Qué se prueba (cada defensa con su variante rota):
--   1. RLS habilitada y forzada; cada CHECK rechaza su valor inválido;
--   2. el guardián: de una invitación abierta solo cambia su cierre, una cerrada no cambia, no se
--      borra; y SIN el guardián el cambio de fecha entra (el throws_ok medía el guardián);
--   3. aislamiento como ladino_api con un actor de DOS tenants (A y C, no B): lee los suyos, no
--      ve B, no inserta en B (42501), un UPDATE sobre B afecta CERO filas y el dato queda intacto;
--      `authenticated` no inserta (42501) y quien no tiene membership.read no la lee;
--   4. aceptar: una vez (LAD86 a la segunda persona), vencida (LAD87), ligada a otro correo
--      (LAD88), la misma persona repite sin efecto doble; y la invitación de B solo lleva a B;
--   5. el acceso perdido solo cuenta la historia propia: el extraño no sabe que B existe;
--   6. «Crear otra empresa»: solo el Titular (LAD93), y no la misma dos veces (LAD94);
--   7. las funciones nuevas no las ejecuta `authenticated`;
--   8. la revisión (migración 20261003120200): una invitación NUNCA reactiva una membresía
--      desactivada (LAD89, y sigue sin acceso a la empresa donde era Dueño); quien invitó sin
--      membership.manage (LAD90); vencida (LAD87); la de Dueño exige correo; el acceso perdido
--      «sin rol» exige el acta member.role_revoked de esa empresa (también para quien conserva
--      otra); bootstrap_another_tenant solo para el propio actor (42501).
-- =============================================================================

begin;
select plan(59);

-- Titular de A y de C (el usuario de dos tenants); B es ajeno. Invitada, intruso y extraño.
insert into auth.users (id, email) values
  ('aaaa0100-0000-4000-8000-0000000000a1', 'titular-100@e2e.ladino'),
  ('aaaa0100-0000-4000-8000-0000000000b1', 'titular-b-100@e2e.ladino'),
  ('aaaa0100-0000-4000-8000-0000000000e1', 'invitada-100@e2e.ladino'),
  ('aaaa0100-0000-4000-8000-0000000000e2', 'intruso-100@e2e.ladino'),
  ('aaaa0100-0000-4000-8000-0000000000e3', 'extrano-100@e2e.ladino');
insert into public.tenants (id, name) values
  ('aaaa0100-0000-4000-8000-00000000000a', 'Negocio 100 A'),
  ('aaaa0100-0000-4000-8000-00000000000b', 'Negocio 100 B'),
  ('aaaa0100-0000-4000-8000-00000000000c', 'Negocio 100 C');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0100-0000-4000-8000-0000000000a2', 'aaaa0100-0000-4000-8000-00000000000a',
   'J100000001', 'Empresa 100 A'),
  ('aaaa0100-0000-4000-8000-0000000000b2', 'aaaa0100-0000-4000-8000-00000000000b',
   'J100000002', 'Empresa 100 B (ajena)'),
  ('aaaa0100-0000-4000-8000-0000000000c2', 'aaaa0100-0000-4000-8000-00000000000c',
   'J100000003', 'Empresa 100 C');
insert into public.warehouses (tenant_id, company_id, code, name) values
  ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a2', 'W1', 'P'),
  ('aaaa0100-0000-4000-8000-00000000000b', 'aaaa0100-0000-4000-8000-0000000000b2', 'W1', 'P');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0100-0000-4000-8000-0000000000aa', 'aaaa0100-0000-4000-8000-00000000000a',
   'aaaa0100-0000-4000-8000-0000000000a1'),
  ('aaaa0100-0000-4000-8000-0000000000cc', 'aaaa0100-0000-4000-8000-00000000000c',
   'aaaa0100-0000-4000-8000-0000000000a1'),
  ('aaaa0100-0000-4000-8000-0000000000bb', 'aaaa0100-0000-4000-8000-00000000000b',
   'aaaa0100-0000-4000-8000-0000000000b1');
insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
select m.tenant_id, m.id, r.id, null
  from public.memberships m cross join public.roles r
 where m.id in ('aaaa0100-0000-4000-8000-0000000000aa', 'aaaa0100-0000-4000-8000-0000000000cc',
                'aaaa0100-0000-4000-8000-0000000000bb')
   and r.key = 'owner' and r.tenant_id is null;

-- Una invitación por tenant, creada por su Titular (la procedencia toma el actor del GUC).
-- Tokens conocidos: 'tok-a', 'tok-b', 'tok-c', 'tok-mail', 'tok-vieja'.
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000a1', true);
insert into public.member_invitations (id, tenant_id, company_id, role_key, email, token_hash,
                                       expires_at) values
  ('aaaa0100-0000-4000-8000-0000000001a1', 'aaaa0100-0000-4000-8000-00000000000a',
   'aaaa0100-0000-4000-8000-0000000000a2', 'cashier', null,
   encode(extensions.digest('tok-a', 'sha256'), 'hex'), now() + interval '7 days'),
  ('aaaa0100-0000-4000-8000-0000000001a2', 'aaaa0100-0000-4000-8000-00000000000a',
   'aaaa0100-0000-4000-8000-0000000000a2', 'accountant', 'invitada-100@e2e.ladino',
   encode(extensions.digest('tok-mail', 'sha256'), 'hex'), now() + interval '7 days'),
  ('aaaa0100-0000-4000-8000-0000000001a3', 'aaaa0100-0000-4000-8000-00000000000a',
   'aaaa0100-0000-4000-8000-0000000000a2', 'cashier', null,
   encode(extensions.digest('tok-vieja', 'sha256'), 'hex'), now() + interval '7 days'),
  ('aaaa0100-0000-4000-8000-0000000001c1', 'aaaa0100-0000-4000-8000-00000000000c',
   'aaaa0100-0000-4000-8000-0000000000c2', 'cashier', null,
   encode(extensions.digest('tok-c', 'sha256'), 'hex'), now() + interval '7 days');
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000b1', true);
insert into public.member_invitations (id, tenant_id, company_id, role_key, token_hash,
                                       expires_at) values
  ('aaaa0100-0000-4000-8000-0000000001b1', 'aaaa0100-0000-4000-8000-00000000000b',
   'aaaa0100-0000-4000-8000-0000000000b2', 'cashier',
   encode(extensions.digest('tok-b', 'sha256'), 'hex'), now() + interval '7 days');

-- ── 1. RLS y forma ───────────────────────────────────────────────────────────
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.member_invitations'::regclass),
  'member_invitations tiene la RLS habilitada y forzada');
select throws_ok($$
  insert into public.member_invitations (tenant_id, company_id, role_key, token_hash, expires_at)
  values ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a2',
          'superadmin', repeat('a', 64), now() + interval '1 day') $$,
  '23514', null, 'un rol que no es de los seis asignables se rechaza');
select throws_ok($$
  insert into public.member_invitations (tenant_id, company_id, role_key, token_hash, expires_at)
  values ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a2',
          'cashier', 'tok-en-claro', now() + interval '1 day') $$,
  '23514', null, 'el token en claro no entra: solo una huella sha256 en hex');
select throws_ok($$
  insert into public.member_invitations (tenant_id, company_id, role_key, email, token_hash,
                                         expires_at)
  values ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a2',
          'cashier', ' Alguien@Ejemplo.com', repeat('b', 64), now() + interval '1 day') $$,
  '23514', null, 'el correo se guarda normalizado (minúsculas, sin espacios)');
select throws_ok($$
  insert into public.member_invitations (tenant_id, company_id, role_key, token_hash, expires_at)
  values ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a2',
          'cashier', repeat('c', 64), now() + interval '31 days') $$,
  '23514', null, 'una invitación no vive más de 30 días');
select throws_ok($$
  insert into public.member_invitations (tenant_id, company_id, role_key, token_hash, expires_at)
  values ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a2',
          'cashier', repeat('d', 64), now() - interval '1 second') $$,
  '23514', null, 'una invitación no nace vencida');
select throws_ok($$
  insert into public.member_invitations (tenant_id, company_id, role_key, token_hash, expires_at)
  values ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000b2',
          'cashier', repeat('e', 64), now() + interval '1 day') $$,
  '23503', null, 'la empresa tiene que ser del tenant de la fila (FK compuesta)');

-- ── 2. El guardián, con su variante rota ─────────────────────────────────────
select throws_ok($$
  update public.member_invitations set expires_at = now() + interval '20 days'
   where id = 'aaaa0100-0000-4000-8000-0000000001a3' $$,
  'LAD06', null, 'de una invitación abierta no se alarga la fecha');
select throws_ok($$
  update public.member_invitations set role_key = 'owner'
   where id = 'aaaa0100-0000-4000-8000-0000000001a3' $$,
  'LAD06', null, 'ni se sube el rol');
select throws_ok($$
  delete from public.member_invitations where id = 'aaaa0100-0000-4000-8000-0000000001a3' $$,
  'LAD06', null, 'no se borra');
update public.member_invitations set revoked_at = now()
 where id = 'aaaa0100-0000-4000-8000-0000000001a3';
select throws_ok($$
  update public.member_invitations set revoked_at = null
   where id = 'aaaa0100-0000-4000-8000-0000000001a3' $$,
  'LAD06', null, 'una revocada no se reabre');
savepoint roto;
alter table public.member_invitations disable trigger member_invitations_02_guard;
update public.member_invitations set role_key = 'accountant'
 where id = 'aaaa0100-0000-4000-8000-0000000001a1';
select is((select role_key from public.member_invitations
            where id = 'aaaa0100-0000-4000-8000-0000000001a1'), 'accountant',
  'SIN el guardián el rol se sube: los throws_ok de arriba medían el guardián');
rollback to savepoint roto;

-- ── 3. Aislamiento: ladino_api con el actor de A y C ─────────────────────────
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select is((select count(*)::int from public.member_invitations), 4,
  'ladino_api ve las invitaciones de los DOS tenants del actor (3 de A, 1 de C)');
select is((select count(*)::int from public.member_invitations
            where tenant_id = 'aaaa0100-0000-4000-8000-00000000000b'), 0,
  'ladino_api NO ve las de B');
select throws_ok($$
  insert into public.member_invitations (tenant_id, company_id, role_key, token_hash, expires_at)
  values ('aaaa0100-0000-4000-8000-00000000000b', 'aaaa0100-0000-4000-8000-0000000000b2',
          'accountant', repeat('f', 64), now() + interval '1 day') $$,
  '42501', null, 'ladino_api NO inserta una invitación en B');
select lives_ok($$
  insert into public.member_invitations (tenant_id, company_id, role_key, token_hash, expires_at)
  values ('aaaa0100-0000-4000-8000-00000000000c', 'aaaa0100-0000-4000-8000-0000000000c2',
          'accountant', repeat('1', 64), now() + interval '1 day') $$,
  'ladino_api SÍ inserta en el otro tenant del mismo actor (el camino permitido vive)');
update public.member_invitations set revoked_at = now()
 where id = 'aaaa0100-0000-4000-8000-0000000001b1';
reset role;
select is((select revoked_at from public.member_invitations
            where id = 'aaaa0100-0000-4000-8000-0000000001b1'), null,
  'un UPDATE de ladino_api sobre la invitación de B no cambia NADA (cero filas)');
select set_config('request.jwt.claims',
  '{"sub":"aaaa0100-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$
  insert into public.member_invitations (tenant_id, company_id, role_key, token_hash, expires_at)
  values ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a2',
          'accountant', repeat('2', 64), now() + interval '1 day') $$,
  '42501', null, 'authenticated no inserta invitaciones (la única vía es la API)');
reset role;
select set_config('request.jwt.claims',
  '{"sub":"aaaa0100-0000-4000-8000-0000000000e3","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.member_invitations), 0,
  'quien no es miembro no lee ninguna invitación por PostgREST');
reset role;

-- ── 4. Aceptar ───────────────────────────────────────────────────────────────
select set_config('ladino.rules_version', 'pgtap-100', true);
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e1', true);
set local role ladino_api;
select is(platform.accept_member_invitation('tok-b'), 'aaaa0100-0000-4000-8000-0000000000b2'::uuid,
  'la invitada acepta la de B y llega a la empresa de B');
select is(platform.accept_member_invitation('tok-b'), 'aaaa0100-0000-4000-8000-0000000000b2'::uuid,
  'la misma persona repite: ya está dentro, sin error');
select throws_ok($$ select platform.accept_member_invitation('tok-mail-no') $$, 'LAD85', null,
  'un token que no existe: LAD85');
reset role;
select is((select count(*)::int from public.memberships
            where user_id = 'aaaa0100-0000-4000-8000-0000000000e1'), 1,
  'la invitación de B la llevó SOLO a B: una sola membresía, ningún otro tenant');
select is((select count(*)::int from public.user_role_assignments u
             join public.memberships m on m.id = u.membership_id
            where m.user_id = 'aaaa0100-0000-4000-8000-0000000000e1'), 1,
  'repetir no duplica la asignación');
select is(exists (select 1 from public.scope_bindings sb
                   join public.user_role_assignments u on u.id = sb.assignment_id
                   join public.memberships m on m.id = u.membership_id
                  where m.user_id = 'aaaa0100-0000-4000-8000-0000000000e1'),
  (select requires_scope from public.roles where key = 'cashier' and tenant_id is null),
  'los bindings de almacén siguen al rol: los recibe solo un rol acotado, como en addMember');
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e2', true);
set local role ladino_api;
select throws_ok($$ select platform.accept_member_invitation('tok-b') $$, 'LAD86', null,
  'otra persona con el mismo enlace: ya se usó');
select throws_ok($$ select platform.accept_member_invitation('tok-mail') $$, 'LAD88', null,
  'la ligada al correo de la invitada no la acepta otra cuenta');
select throws_ok($$ select platform.accept_member_invitation('tok-vieja') $$, 'LAD86', null,
  'una revocada tampoco');
reset role;

-- ── 5. El acceso perdido: solo la historia propia ────────────────────────────
update public.memberships set status = 'inactive'
 where user_id = 'aaaa0100-0000-4000-8000-0000000000e1';
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e1', true);
set local role ladino_api;
select ok(platform.lost_access_to_company('aaaa0100-0000-4000-8000-0000000000b2'),
  'la desactivada TUVO acceso a B: el middleware le dirá que ya no está activo');
reset role;
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e3', true);
set local role ladino_api;
select ok(not platform.lost_access_to_company('aaaa0100-0000-4000-8000-0000000000b2')
          and not exists (select 1 from platform.my_lost_access()),
  'el extraño no sabe que B existe: ni acceso perdido ni negocios en su historia');
reset role;
-- Migración 20261003120100: un miembro con rol en OTRA empresa del tenant que pide una a la que
-- nunca tuvo acceso sigue recibiendo el 404 (no se le revela que existe).
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0100-0000-4000-8000-0000000000a3', 'aaaa0100-0000-4000-8000-00000000000a',
   'J100000004', 'Empresa 100 A-bis');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0100-0000-4000-8000-0000000000ae', 'aaaa0100-0000-4000-8000-00000000000a',
   'aaaa0100-0000-4000-8000-0000000000e2');
insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
select 'aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000ae', r.id,
       'aaaa0100-0000-4000-8000-0000000000a2'
  from public.roles r where r.key = 'cashier' and r.tenant_id is null;
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e2', true);
set local role ladino_api;
select ok(not platform.lost_access_to_company('aaaa0100-0000-4000-8000-0000000000a3'),
  'el cajero de A-1 que pide A-bis, donde nunca trabajó, no recibe «acceso perdido»: el 404');

-- ── 6. Crear otra empresa ────────────────────────────────────────────────────
-- Cada llamada con su propio actor: desde 20261003120200, p_user tiene que ser el actor.
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e3', true);
select throws_ok($$ select platform.bootstrap_another_tenant(
  'aaaa0100-0000-4000-8000-0000000000e3', 'Negocio del extraño', null) $$, 'LAD93', null,
  'quien no es Titular de ninguna cuenta no crea otra empresa');
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000a1', true);
select throws_ok($$ select platform.bootstrap_another_tenant(
  'aaaa0100-0000-4000-8000-0000000000a1', '  negocio   100 a ', null) $$, 'LAD94', null,
  'el Titular no funda dos veces el mismo negocio (nombre normalizado)');
reset role;

-- ── 7. authenticated no ejecuta las funciones ───────────────────────────────
set local role authenticated;
select throws_ok($$ select platform.accept_member_invitation('tok-c') $$, '42501', null,
  'authenticated no acepta invitaciones por PostgREST (la API es la única vía)');
reset role;

-- ── 8. La revisión (migración 20261003120200) ──────────────────────────────
insert into auth.users (id, email) values
  ('aaaa0100-0000-4000-8000-0000000000e4', 'desactivado-104@e2e.ladino'),
  ('aaaa0100-0000-4000-8000-0000000000e5', 'sinrol-104@e2e.ladino');
insert into public.memberships (id, tenant_id, user_id, status) values
  ('aaaa0100-0000-4000-8000-0000000000af', 'aaaa0100-0000-4000-8000-00000000000a',
   'aaaa0100-0000-4000-8000-0000000000e4', 'inactive'),
  ('aaaa0100-0000-4000-8000-0000000000a9', 'aaaa0100-0000-4000-8000-00000000000a',
   'aaaa0100-0000-4000-8000-0000000000e5', 'active');
insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
select 'aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000af', r.id,
       'aaaa0100-0000-4000-8000-0000000000a2'
  from public.roles r where r.key = 'owner' and r.tenant_id is null;
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000a1', true);
insert into public.member_invitations (tenant_id, company_id, role_key, token_hash, expires_at)
values
  ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a3', 'cashier',
   encode(extensions.digest('tok-reactivar', 'sha256'), 'hex'), now() + interval '7 days'),
  ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a3', 'cashier',
   encode(extensions.digest('tok-vencida', 'sha256'), 'hex'), now() + interval '7 days');
-- La invitación de quien NO gestiona personas (el cajero e2): la base la admite (la API no).
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e2', true);
insert into public.member_invitations (tenant_id, company_id, role_key, token_hash, expires_at)
values ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a2', 'cashier',
        encode(extensions.digest('tok-sin-permiso', 'sha256'), 'hex'), now() + interval '7 days');
set local session_replication_role = replica;
update public.member_invitations
   set created_at = now() - interval '9 days', expires_at = now() - interval '2 days'
 where token_hash = encode(extensions.digest('tok-vencida', 'sha256'), 'hex');
set local session_replication_role = origin;

select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e4', true);
set local role ladino_api;
select throws_ok($$ select platform.accept_member_invitation('tok-reactivar') $$, 'LAD89', null,
  'H1: una invitación NUNCA reactiva una membresía desactivada');
reset role;
select ok((select status from public.memberships
            where id = 'aaaa0100-0000-4000-8000-0000000000af') = 'inactive'
          and 'aaaa0100-0000-4000-8000-0000000000a2'::uuid not in
              (select platform.ladino_user_company_ids('aaaa0100-0000-4000-8000-0000000000e4')),
  'H1: y después sigue desactivada, sin su owner sobre A2');

select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e3', true);
set local role ladino_api;
select throws_ok($$ select platform.accept_member_invitation('tok-sin-permiso') $$, 'LAD90', null,
  'quien invitó sin membership.manage sobre la empresa: LAD90');
select throws_ok($$ select platform.accept_member_invitation('tok-vencida') $$, 'LAD87', null,
  'vencida: LAD87');
select throws_ok($$ select platform.bootstrap_another_tenant(
  'aaaa0100-0000-4000-8000-0000000000a1', 'Negocio ajeno 104', null) $$, '42501', null,
  'H6: nadie abre un negocio a nombre de otro (p_user distinto del actor)');
reset role;

select throws_ok($$
  insert into public.member_invitations (tenant_id, company_id, role_key, token_hash, expires_at)
  values ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a2',
          'owner', repeat('9', 64), now() + interval '1 day') $$,
  '23514', null, 'H7: una invitación de Dueño sin correo se rechaza');

-- H4 + E1 (migración 20261003120300): «sin rol» exige HISTORIA, y la historia dice de qué empresa
-- era la ASIGNACIÓN, no desde qué empresa se quitó.
-- pgTAP no puede llamar al dominio: las actas de abajo reproducen EXACTAMENTE lo que escribe
-- removeAssignment (packages/domain/src/members.ts): aggregate = la membresía, company_id = la
-- empresa de la asignación (la de la cabecera solo si la asignación era de nivel tenant) y el
-- payload {user_id, role_key, assignment_id, assignment_company_id}. El productor REAL lo ejerce
-- el E2E (apps/api/test/e2e-empresa-e-invitaciones.test.ts, «E1»).
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e5', true);
set local role ladino_api;
select ok(not platform.lost_access_to_company('aaaa0100-0000-4000-8000-0000000000a3'),
  'H4: un miembro sin rol y sin acta que pide A-bis no recibe «acceso perdido»');
select is((select count(*)::int from platform.my_lost_access()), 0,
  'E1: y my_lost_access dice lo MISMO: sin acta ni desactivación no hay negocio perdido');
reset role;

-- e5 perdió su rol en A-bis. El Titular lo quitó con la cabecera de A-1: el acta se ancla a
-- A-bis (la empresa de la asignación), no a A-1.
insert into public.audit_events (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
                                 actor_type, occurred_at, rules_version, payload) values
  ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a3', 'membership', 'aaaa0100-0000-4000-8000-0000000000a9', 'member.role_revoked', 'user', now(),
   'pgtap-104',
   jsonb_build_object('user_id', 'aaaa0100-0000-4000-8000-0000000000e5'::uuid, 'role_key', 'cashier',
                      'assignment_id', platform.uuidv7(),
                      'assignment_company_id', 'aaaa0100-0000-4000-8000-0000000000a3'::uuid));
set local role ladino_api;
select ok(platform.lost_access_to_company('aaaa0100-0000-4000-8000-0000000000a3'),
  'E1: con el acta de que perdió su rol en A-bis, A-bis le dice «acceso perdido»');
select ok(not platform.lost_access_to_company('aaaa0100-0000-4000-8000-0000000000a2'),
  'E1: y A-1, donde nunca trabajó, le sigue respondiendo el 404 (no se revela)');
select is((select business_name from platform.my_lost_access()), 'Negocio 100 A',
  'E1: my_lost_access nombra el negocio que perdió');
reset role;

-- La variante ROTA, que es el defecto: el acta como la escribía removeAssignment antes (anclada a
-- la empresa de la CABECERA y sin assignment_company_id). No cuenta: ni para la empresa de la
-- cabecera ni para ninguna.
insert into public.audit_events (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
                                 actor_type, occurred_at, rules_version, payload) values
  ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a3', 'membership', 'aaaa0100-0000-4000-8000-0000000000ae', 'member.role_revoked', 'user', now(),
   'pgtap-104',
   jsonb_build_object('user_id', 'aaaa0100-0000-4000-8000-0000000000e2'::uuid, 'role_key', 'cashier',
                      'assignment_id', platform.uuidv7()));
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e2', true);
set local role ladino_api;
select ok(not platform.lost_access_to_company('aaaa0100-0000-4000-8000-0000000000a3'),
  'E1 (rota): un acta vieja, anclada a la empresa de la cabecera y sin alcance, NO cuenta');
reset role;
-- Y con su acta de verdad: perdió A-bis y conserva A-1.
insert into public.audit_events (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
                                 actor_type, occurred_at, rules_version, payload) values
  ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a3', 'membership', 'aaaa0100-0000-4000-8000-0000000000ae', 'member.role_revoked', 'user', now(),
   'pgtap-104',
   jsonb_build_object('user_id', 'aaaa0100-0000-4000-8000-0000000000e2'::uuid, 'role_key', 'cashier',
                      'assignment_id', platform.uuidv7(),
                      'assignment_company_id', 'aaaa0100-0000-4000-8000-0000000000a3'::uuid));
set local role ladino_api;
select ok(platform.lost_access_to_company('aaaa0100-0000-4000-8000-0000000000a3'),
  'H4/N-06: quien perdió A-bis y conserva A-1 recibe «acceso perdido» en A-bis');
reset role;

-- Una asignación de NIVEL TENANT quitada: alcanzaba TODAS las empresas del negocio. Lo que
-- escribe removeAssignment en ese caso: company_id = la empresa de la CABECERA (aquí A-1) y
-- assignment_company_id = null. La consulta es por OTRA empresa del negocio (A-bis): con la
-- definición de 20261003120200 (que leía el company_id del acta) daba false; la rama null de
-- 20261003120300 es la que la hace true.
insert into auth.users (id, email) values ('aaaa0100-0000-4000-8000-0000000000e6', 'exgerente-104@e2e.ladino');
insert into public.memberships (id, tenant_id, user_id) values ('aaaa0100-0000-4000-8000-0000000000a8', 'aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000e6');
insert into public.audit_events (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
                                 actor_type, occurred_at, rules_version, payload) values
  ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a2', 'membership', 'aaaa0100-0000-4000-8000-0000000000a8', 'member.role_revoked', 'user', now(), 'pgtap-104',
   jsonb_build_object('user_id', 'aaaa0100-0000-4000-8000-0000000000e6'::uuid, 'role_key', 'owner',
                      'assignment_id', platform.uuidv7(), 'assignment_company_id', null));
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e6', true);
set local role ladino_api;
select ok(platform.lost_access_to_company('aaaa0100-0000-4000-8000-0000000000a3'),
  'E1: el acta de nivel tenant, anclada a A-1, vale para A-bis (otra empresa del mismo negocio)');
select ok(not platform.lost_access_to_company('aaaa0100-0000-4000-8000-0000000000b2'),
  'E1 (control): y NO vale para una empresa de otro tenant');
reset role;

-- La COTA TEMPORAL (migración 20261003120500): «solo a quien lo tuvo» incluye el cuándo. Un rol
-- de nivel tenant alcanzaba las empresas que EXISTÍAN cuando se quitó (o cuando se desactivó la
-- membresía), no las que se crearon después. Dentro de esta transacción todas las empresas nacen
-- en now(): un acta de hace una hora es «antes de que existieran»; una de now(), «cuando ya
-- existían» (instante contra instante, las dos timestamptz).
insert into auth.users (id, email) values
  ('aaaa0100-0000-4000-8000-0000000000e7', 'antes-104@e2e.ladino'), ('aaaa0100-0000-4000-8000-0000000000e8', 'apagado-104@e2e.ladino'),
  ('aaaa0100-0000-4000-8000-0000000000e9', 'apagado-antes-104@e2e.ladino');
insert into public.memberships (id, tenant_id, user_id, status) values
  ('aaaa0100-0000-4000-8000-0000000000b7', 'aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000e7', 'active'),
  ('aaaa0100-0000-4000-8000-0000000000b8', 'aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000e8', 'inactive'),
  ('aaaa0100-0000-4000-8000-0000000000b9', 'aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000e9', 'inactive');
insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
select 'aaaa0100-0000-4000-8000-00000000000a', x.id, r.id, null
  from (values ('aaaa0100-0000-4000-8000-0000000000b8'::uuid), ('aaaa0100-0000-4000-8000-0000000000b9'::uuid)) x(id)
 cross join public.roles r where r.key = 'owner' and r.tenant_id is null;

-- Rama (b): el rol de nivel tenant se quitó ANTES de que A-bis existiera.
insert into public.audit_events (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
                                 actor_type, occurred_at, rules_version, payload) values
  ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a2', 'membership', 'aaaa0100-0000-4000-8000-0000000000b7', 'member.role_revoked', 'user', now() - interval '1 hour', 'pgtap-104',
   jsonb_build_object('user_id', 'aaaa0100-0000-4000-8000-0000000000e7'::uuid, 'role_key', 'owner',
                      'assignment_id', platform.uuidv7(), 'assignment_company_id', null));
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e7', true);
set local role ladino_api;
select ok(not platform.lost_access_to_company('aaaa0100-0000-4000-8000-0000000000a3'),
  'cota (b): una empresa creada DESPUÉS de quitarle el rol de nivel tenant no es acceso perdido');
select is((select count(*)::int from platform.my_lost_access()), 0,
  'cota: y my_lost_access hereda la regla (ningún negocio perdido)');
reset role;

-- Rama (a): desactivada con un rol de nivel tenant. Sin acta de desactivación, no cuenta.
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e8', true);
set local role ladino_api;
select ok(not platform.lost_access_to_company('aaaa0100-0000-4000-8000-0000000000a3'),
  'cota (a): desactivada con rol de nivel tenant y SIN acta member.deactivated: no cuenta');
reset role;
insert into public.audit_events (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
                                 actor_type, occurred_at, rules_version, payload) values
  ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a2', 'membership', 'aaaa0100-0000-4000-8000-0000000000b8', 'member.deactivated', 'user', now(), 'pgtap-104',
   jsonb_build_object('user_id', 'aaaa0100-0000-4000-8000-0000000000e8'::uuid));
set local role ladino_api;
select ok(platform.lost_access_to_company('aaaa0100-0000-4000-8000-0000000000a3'),
  'cota (a): desactivada cuando A-bis ya existía: acceso perdido');
reset role;
insert into public.audit_events (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
                                 actor_type, occurred_at, rules_version, payload) values
  ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a2', 'membership', 'aaaa0100-0000-4000-8000-0000000000b9', 'member.deactivated', 'user', now() - interval '1 hour', 'pgtap-104',
   jsonb_build_object('user_id', 'aaaa0100-0000-4000-8000-0000000000e9'::uuid));
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e9', true);
set local role ladino_api;
select ok(not platform.lost_access_to_company('aaaa0100-0000-4000-8000-0000000000a3'),
  'cota (a): desactivada ANTES de que A-bis existiera: no es acceso perdido');
reset role;

-- E7 (migración 20261003120400): quien NO es el destinatario de una invitación ligada a un correo
-- no ve empresa, negocio ni quién invita en NINGÚN estado. Un caso por estado; lee e2.
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000a1', true);
insert into public.member_invitations (tenant_id, company_id, role_key, email, token_hash,
                                       expires_at) values
  ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a2', 'accountant', 'invitada-100@e2e.ladino', encode(extensions.digest('tok-m-usada', 'sha256'), 'hex'),
   now() + interval '7 days'),
  ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a2', 'accountant', 'invitada-100@e2e.ladino', encode(extensions.digest('tok-m-anulada', 'sha256'), 'hex'),
   now() + interval '7 days'),
  ('aaaa0100-0000-4000-8000-00000000000a', 'aaaa0100-0000-4000-8000-0000000000a2', 'accountant', 'invitada-100@e2e.ladino', encode(extensions.digest('tok-m-vencida', 'sha256'), 'hex'),
   now() + interval '7 days');
update public.member_invitations set revoked_at = now()
 where token_hash = encode(extensions.digest('tok-m-anulada', 'sha256'), 'hex');
update public.member_invitations set accepted_at = now(), accepted_by = 'aaaa0100-0000-4000-8000-0000000000e1'
 where token_hash = encode(extensions.digest('tok-m-usada', 'sha256'), 'hex');
set local session_replication_role = replica;
update public.member_invitations
   set created_at = now() - interval '9 days', expires_at = now() - interval '2 days'
 where token_hash = encode(extensions.digest('tok-m-vencida', 'sha256'), 'hex');
set local session_replication_role = origin;

select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e2', true);
set local role ladino_api;
select is((select row(status, company_name, business_name, role_key, inviter_name, expires_at)::text
             from platform.invitation_preview('tok-mail')), '(other_email,,,,,)',
  'E7: pendiente, a quien no es el destinatario: solo el estado');
select is((select row(status, company_name, business_name, role_key, inviter_name, expires_at)::text
             from platform.invitation_preview('tok-m-usada')), '(other_email,,,,,)',
  'E7: usada, a quien no es el destinatario: solo other_email, sin datos');
select is((select row(status, company_name, business_name, role_key, inviter_name, expires_at)::text
             from platform.invitation_preview('tok-m-anulada')), '(other_email,,,,,)',
  'E7: anulada, a quien no es el destinatario: solo other_email, sin datos');
select is((select row(status, company_name, business_name, role_key, inviter_name, expires_at)::text
             from platform.invitation_preview('tok-m-vencida')), '(other_email,,,,,)',
  'E7: vencida, a quien no es el destinatario: solo other_email, sin datos');
reset role;
-- El destinatario sí ve de qué negocio era la que venció («Tu invitación a X venció»).
select set_config('ladino.actor_id', 'aaaa0100-0000-4000-8000-0000000000e1', true);
set local role ladino_api;
select is((select status || '|' || company_name from platform.invitation_preview('tok-m-vencida')),
  'expired|Empresa 100 A',
  'E7: el destinatario sigue viendo el estado real y la empresa');
reset role;

select * from finish();
rollback;

-- =============================================================================
-- Ladino — pgTAP 101 · Permisos que terminan en verde (migración 20261003130000; ADR-0068 §7–§8)
--
-- LO QUE PRUEBA:
--   1. N-07 · membresías, asignaciones y alcances se leen con membership.read; cada quien ve las
--      suyas. Con un usuario de DOS tenants (cajero en A, Dueño en B): en A ve solo lo suyo, en B
--      todo. Variante rota: la policy vieja (ladino_tenant_ids) le devuelve al cajero todo A.
--   2. E-12 · ninguna tabla con tenant_id deja a ladino_api con `true` (consulta del catálogo =
--      0), y el aislamiento EJERCIDO en dos de las seis: con actor A no se lee, no se borra y no
--      se inserta lo de B; con el actor de dos tenants se ven los dos. Variante rota: una policy
--      `true` pone la consulta en 1 y deja ver B.
--   3. O-03 · toda tabla de public con created_by lleva set_row_provenance (= 0), y el alta de una
--      membresía y una asignación guarda al actor. Variante rota: sin el trigger, la consulta da 1.
--   4. Separación de funciones · los tres permisos nuevos existen y son del Dueño; los cuatro ojos
--      se encienden POR PERMISO, solo si más de una persona puede aprobar (dueño + cajero: apagados
--      para pagar, encendidos para vender); el ajuste explícito manda; quien registró no
--      aprueba con cuatro ojos, y sí en la bodega de una persona.
-- =============================================================================

begin;
select plan(51);

-- ── Fixtures (como postgres) ────────────────────────────────────────────────
insert into auth.users (id) values
  ('aaaa0101-0000-4000-8000-0000000000a1'),   -- OA: Dueño en A1
  ('aaaa0101-0000-4000-8000-0000000000a2'),   -- CA: cajero en A1
  ('aaaa0101-0000-4000-8000-0000000000c1'),   -- UM: cajero en A1 y Dueño en B1 (dos tenants)
  ('aaaa0101-0000-4000-8000-0000000000b1'),   -- OB: Dueño en B1
  ('aaaa0101-0000-4000-8000-0000000000e1'),   -- MA2: Dueño solo de A2 (mismo tenant que A1)
  ('aaaa0101-0000-4000-8000-0000000000f9'),   -- FA: Titular de A (nivel cuenta)
  ('aaaa0101-0000-4000-8000-0000000000d7'),   -- OC: Dueño en C1
  ('aaaa0101-0000-4000-8000-0000000000d8');   -- CC: cajero en C1
insert into public.tenants (id, name) values
  ('aaaa0101-0000-4000-8000-00000000000a', 'Tenant A 101'),
  ('aaaa0101-0000-4000-8000-00000000000b', 'Tenant B 101'),
  ('aaaa0101-0000-4000-8000-00000000000c', 'Tenant C 101');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0101-0000-4000-8000-0000000000aa', 'aaaa0101-0000-4000-8000-00000000000a', 'J-A101', 'A1'),
  ('aaaa0101-0000-4000-8000-0000000000bb', 'aaaa0101-0000-4000-8000-00000000000b', 'J-B101', 'B1'),
  ('aaaa0101-0000-4000-8000-0000000000a7', 'aaaa0101-0000-4000-8000-00000000000a', 'J-A102', 'A2'),
  ('aaaa0101-0000-4000-8000-0000000000cc', 'aaaa0101-0000-4000-8000-00000000000c', 'J-C101', 'C1');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0101-0000-4000-8000-0000000000f1', 'aaaa0101-0000-4000-8000-00000000000a',
   'aaaa0101-0000-4000-8000-0000000000aa', 'W101', 'Principal');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0101-0000-4000-8000-0000000001a1', 'aaaa0101-0000-4000-8000-00000000000a', 'aaaa0101-0000-4000-8000-0000000000a1'),
  ('aaaa0101-0000-4000-8000-0000000001a2', 'aaaa0101-0000-4000-8000-00000000000a', 'aaaa0101-0000-4000-8000-0000000000a2'),
  ('aaaa0101-0000-4000-8000-0000000001c1', 'aaaa0101-0000-4000-8000-00000000000a', 'aaaa0101-0000-4000-8000-0000000000c1'),
  ('aaaa0101-0000-4000-8000-0000000001c2', 'aaaa0101-0000-4000-8000-00000000000b', 'aaaa0101-0000-4000-8000-0000000000c1'),
  ('aaaa0101-0000-4000-8000-0000000001b1', 'aaaa0101-0000-4000-8000-00000000000b', 'aaaa0101-0000-4000-8000-0000000000b1'),
  ('aaaa0101-0000-4000-8000-0000000001e1', 'aaaa0101-0000-4000-8000-00000000000a', 'aaaa0101-0000-4000-8000-0000000000e1'),
  ('aaaa0101-0000-4000-8000-0000000001f9', 'aaaa0101-0000-4000-8000-00000000000a', 'aaaa0101-0000-4000-8000-0000000000f9'),
  ('aaaa0101-0000-4000-8000-0000000001d7', 'aaaa0101-0000-4000-8000-00000000000c', 'aaaa0101-0000-4000-8000-0000000000d7'),
  ('aaaa0101-0000-4000-8000-0000000001d8', 'aaaa0101-0000-4000-8000-00000000000c', 'aaaa0101-0000-4000-8000-0000000000d8');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id)
select v.id::uuid, v.tenant::uuid, v.membership::uuid, r.id, v.company::uuid
  from (values
    ('aaaa0101-0000-4000-8000-0000000002a1', 'aaaa0101-0000-4000-8000-00000000000a', 'aaaa0101-0000-4000-8000-0000000001a1', 'owner',         'aaaa0101-0000-4000-8000-0000000000aa'),
    ('aaaa0101-0000-4000-8000-0000000002a9', 'aaaa0101-0000-4000-8000-00000000000a', 'aaaa0101-0000-4000-8000-0000000001a1', 'warehouse_ops', 'aaaa0101-0000-4000-8000-0000000000aa'),
    ('aaaa0101-0000-4000-8000-0000000002a2', 'aaaa0101-0000-4000-8000-00000000000a', 'aaaa0101-0000-4000-8000-0000000001a2', 'cashier',       'aaaa0101-0000-4000-8000-0000000000aa'),
    ('aaaa0101-0000-4000-8000-0000000002c1', 'aaaa0101-0000-4000-8000-00000000000a', 'aaaa0101-0000-4000-8000-0000000001c1', 'cashier',       'aaaa0101-0000-4000-8000-0000000000aa'),
    ('aaaa0101-0000-4000-8000-0000000002c2', 'aaaa0101-0000-4000-8000-00000000000b', 'aaaa0101-0000-4000-8000-0000000001c2', 'owner',         'aaaa0101-0000-4000-8000-0000000000bb'),
    ('aaaa0101-0000-4000-8000-0000000002b1', 'aaaa0101-0000-4000-8000-00000000000b', 'aaaa0101-0000-4000-8000-0000000001b1', 'owner',         'aaaa0101-0000-4000-8000-0000000000bb'),
    ('aaaa0101-0000-4000-8000-0000000002e1', 'aaaa0101-0000-4000-8000-00000000000a', 'aaaa0101-0000-4000-8000-0000000001e1', 'owner',         'aaaa0101-0000-4000-8000-0000000000a7'),
    ('aaaa0101-0000-4000-8000-0000000002f9', 'aaaa0101-0000-4000-8000-00000000000a', 'aaaa0101-0000-4000-8000-0000000001f9', 'owner',         null),
    ('aaaa0101-0000-4000-8000-0000000002d7', 'aaaa0101-0000-4000-8000-00000000000c', 'aaaa0101-0000-4000-8000-0000000001d7', 'owner',         'aaaa0101-0000-4000-8000-0000000000cc'),
    ('aaaa0101-0000-4000-8000-0000000002d8', 'aaaa0101-0000-4000-8000-00000000000c', 'aaaa0101-0000-4000-8000-0000000001d8', 'cashier',       'aaaa0101-0000-4000-8000-0000000000cc')
  ) as v(id, tenant, membership, rol, company)
  join public.roles r on r.key = v.rol and r.tenant_id is null;
insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id) values
  ('aaaa0101-0000-4000-8000-00000000000a', 'aaaa0101-0000-4000-8000-0000000000aa',
   'aaaa0101-0000-4000-8000-0000000002a9', 'warehouse', 'aaaa0101-0000-4000-8000-0000000000f1');
insert into public.company_fiscal_deadlines
  (tenant_id, company_id, obligation, period_from, period_to, due_date, legal_source) values
  ('aaaa0101-0000-4000-8000-00000000000a', 'aaaa0101-0000-4000-8000-0000000000aa', 'iva',
   '2026-09-01', '2026-09-30', '2026-10-15', 'Fixture pgTAP 101, calendario de prueba'),
  ('aaaa0101-0000-4000-8000-00000000000b', 'aaaa0101-0000-4000-8000-0000000000bb', 'iva',
   '2026-09-01', '2026-09-30', '2026-10-15', 'Fixture pgTAP 101, calendario de prueba');
insert into public.inventory_ledger_cutovers
  (tenant_id, company_id, cutover_at, kardex_value, ledger_balance, difference, reason) values
  ('aaaa0101-0000-4000-8000-00000000000a', 'aaaa0101-0000-4000-8000-0000000000aa', now(), 0, 0, 0,
   'Fixture pgTAP 101'),
  ('aaaa0101-0000-4000-8000-00000000000b', 'aaaa0101-0000-4000-8000-0000000000bb', now(), 0, 0, 0,
   'Fixture pgTAP 101');

-- Las filas de los fixtures de este fichero (otras suites pueden haber dejado las suyas).
create or replace function pg_temp.vistas(p_tabla text, p_tenant uuid) returns bigint
language plpgsql as $$
declare n bigint;
begin
  execute format('select count(*) from public.%I where tenant_id = $1', p_tabla) into n using p_tenant;
  return n;
end $$;
grant execute on function pg_temp.vistas(text, uuid) to authenticated, ladino_api;

-- ── 1. N-07 / H5 ─────────────────────────────────────────────────────────────
-- El cajero de A: solo lo suyo.
select set_config('request.jwt.claims',
  '{"sub":"aaaa0101-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select is(pg_temp.vistas('memberships', 'aaaa0101-0000-4000-8000-00000000000a'), 1::bigint,
  'N-07: el cajero de A ve UNA membresía de A: la suya');
select is((select user_id from public.memberships
            where tenant_id = 'aaaa0101-0000-4000-8000-00000000000a'),
  'aaaa0101-0000-4000-8000-0000000000a2'::uuid, 'y es la suya');
select is(pg_temp.vistas('user_role_assignments', 'aaaa0101-0000-4000-8000-00000000000a'), 1::bigint,
  'N-07: el cajero ve UNA asignación: la suya');
select is(pg_temp.vistas('scope_bindings', 'aaaa0101-0000-4000-8000-00000000000a'), 0::bigint,
  'N-07: el cajero no ve los alcances de otros');
reset role;

-- El Dueño de A1 (membership.read en A1): las membresías con asignación en A1 y la del Titular;
-- no la del gestor de A2.
select set_config('request.jwt.claims',
  '{"sub":"aaaa0101-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is(pg_temp.vistas('memberships', 'aaaa0101-0000-4000-8000-00000000000a'), 4::bigint,
  'H5: el Dueño de A1 ve 4 membresías: las tres con asignación en A1 y la del Titular');
select is(pg_temp.vistas('user_role_assignments', 'aaaa0101-0000-4000-8000-00000000000a'), 5::bigint,
  'N-07: y las cinco asignaciones de A1 y del nivel cuenta (no la de A2)');
select is(pg_temp.vistas('scope_bindings', 'aaaa0101-0000-4000-8000-00000000000a'), 1::bigint,
  'N-07: y el alcance de A1');
select is(pg_temp.vistas('memberships', 'aaaa0101-0000-4000-8000-00000000000b'), 0::bigint,
  'N-07: y NADA de B');
reset role;

-- El gestor de A2 (Dueño solo de A2), en el MISMO tenant: no ve a la gente de A1.
select set_config('request.jwt.claims',
  '{"sub":"aaaa0101-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
select is(pg_temp.vistas('memberships', 'aaaa0101-0000-4000-8000-00000000000a'), 2::bigint,
  'H5: el gestor de A2 ve 2 membresías del tenant: la suya y la del Titular');
select is((select count(*) from public.memberships
            where user_id = 'aaaa0101-0000-4000-8000-0000000000a2'), 0::bigint,
  'H5: y no ve al cajero de A1, aunque es del mismo tenant');
reset role;

-- El Titular (membership.read de nivel cuenta): todas.
select set_config('request.jwt.claims',
  '{"sub":"aaaa0101-0000-4000-8000-0000000000f9","role":"authenticated"}', true);
set local role authenticated;
select is(pg_temp.vistas('memberships', 'aaaa0101-0000-4000-8000-00000000000a'), 5::bigint,
  'H5: el Titular ve las cinco membresías de la cuenta');
reset role;

-- El usuario de dos tenants: cajero en A (solo lo suyo), Dueño en B (todo B).
select set_config('request.jwt.claims',
  '{"sub":"aaaa0101-0000-4000-8000-0000000000c1","role":"authenticated"}', true);
set local role authenticated;
select is(pg_temp.vistas('memberships', 'aaaa0101-0000-4000-8000-00000000000a'), 1::bigint,
  'N-07 (dos tenants): en A, donde es cajero, ve solo su membresía');
select is(pg_temp.vistas('user_role_assignments', 'aaaa0101-0000-4000-8000-00000000000a'), 1::bigint,
  'N-07 (dos tenants): en A, solo su asignación');
select is(pg_temp.vistas('memberships', 'aaaa0101-0000-4000-8000-00000000000b'), 2::bigint,
  'N-07 (dos tenants): en B, donde es Dueño, ve las dos membresías');
select is(pg_temp.vistas('user_role_assignments', 'aaaa0101-0000-4000-8000-00000000000b'), 2::bigint,
  'N-07 (dos tenants): en B, las dos asignaciones');
reset role;

-- Variantes rotas: la policy original (N-07) y la de 20261003130000 (H5).
drop policy memberships_select on public.memberships;
create policy memberships_select on public.memberships for select to authenticated
  using (tenant_id in (select platform.ladino_tenant_ids()) or user_id = (select auth.uid()));
select set_config('request.jwt.claims',
  '{"sub":"aaaa0101-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select is(pg_temp.vistas('memberships', 'aaaa0101-0000-4000-8000-00000000000a'), 5::bigint,
  'VARIANTE ROTA N-07: con la policy original el cajero ve las cinco');
reset role;
drop policy memberships_select on public.memberships;
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = (select auth.uid())
         or tenant_id in (select platform.ladino_membership_reader_tenant_ids()));
select set_config('request.jwt.claims',
  '{"sub":"aaaa0101-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
select is(pg_temp.vistas('memberships', 'aaaa0101-0000-4000-8000-00000000000a'), 5::bigint,
  'VARIANTE ROTA H5: con la policy por tenant el gestor de A2 ve las cinco (mide la policy)');
reset role;
drop policy memberships_select on public.memberships;
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = (select auth.uid())
         or id in (select platform.ladino_visible_membership_ids()));
select set_config('request.jwt.claims', '', true);

-- ── 2. E-12 ──────────────────────────────────────────────────────────────────
create or replace function pg_temp.api_true() returns bigint language sql as $$
  select count(*) from pg_policies p
   where p.schemaname = 'public' and 'ladino_api' = any (p.roles)
     and (p.qual = 'true' or p.with_check = 'true')
     and exists (select 1 from information_schema.columns c
                  where c.table_schema = 'public' and c.table_name = p.tablename
                    and c.column_name = 'tenant_id')
$$;
select is(pg_temp.api_true(), 0::bigint,
  'E-12: CERO policies de ladino_api con `true` en tablas con tenant_id');

select set_config('ladino.actor_id', 'aaaa0101-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select is(pg_temp.vistas('company_fiscal_deadlines', 'aaaa0101-0000-4000-8000-00000000000b'), 0::bigint,
  'E-12: con actor A, ladino_api no ve los plazos de B');
select is(pg_temp.vistas('company_fiscal_deadlines', 'aaaa0101-0000-4000-8000-00000000000a'), 1::bigint,
  'E-12: y sí los de A');
select is(pg_temp.vistas('inventory_ledger_cutovers', 'aaaa0101-0000-4000-8000-00000000000b'), 0::bigint,
  'E-12: con actor A no ve los cortes de B');
delete from public.company_fiscal_deadlines where tenant_id = 'aaaa0101-0000-4000-8000-00000000000b';
select throws_ok(
  $$ insert into public.company_fiscal_deadlines
       (tenant_id, company_id, obligation, period_from, period_to, due_date, legal_source)
     values ('aaaa0101-0000-4000-8000-00000000000b', 'aaaa0101-0000-4000-8000-0000000000bb', 'igtf',
             '2026-09-01', '2026-09-15', '2026-09-20', 'Colado desde A en el tenant B') $$,
  '42501', null, 'E-12: insertar un plazo en B con actor A → 42501');
select lives_ok(
  $$ insert into public.company_fiscal_deadlines
       (tenant_id, company_id, obligation, period_from, period_to, due_date, legal_source)
     values ('aaaa0101-0000-4000-8000-00000000000a', 'aaaa0101-0000-4000-8000-0000000000aa', 'igtf',
             '2026-09-01', '2026-09-15', '2026-09-20', 'Alta legítima en el propio tenant') $$,
  'E-12: insertar en el propio tenant funciona de verdad');
reset role;
select is(pg_temp.vistas('company_fiscal_deadlines', 'aaaa0101-0000-4000-8000-00000000000b'), 1::bigint,
  'E-12: el DELETE de A sobre B no borró nada (dato intacto)');

select set_config('ladino.actor_id', 'aaaa0101-0000-4000-8000-0000000000c1', true);
set local role ladino_api;
select is(pg_temp.vistas('company_fiscal_deadlines', 'aaaa0101-0000-4000-8000-00000000000a')
          + pg_temp.vistas('company_fiscal_deadlines', 'aaaa0101-0000-4000-8000-00000000000b'),
  3::bigint, 'E-12 (dos tenants): el actor de A y B ve los plazos de los dos');
reset role;

-- Variante rota: la policy de antes.
drop policy cfd_api_select on public.company_fiscal_deadlines;
create policy cfd_api_select on public.company_fiscal_deadlines for select to ladino_api
  using (true);
select is(pg_temp.api_true(), 1::bigint,
  'VARIANTE ROTA E-12: con `true` la consulta del catálogo da 1');
select set_config('ladino.actor_id', 'aaaa0101-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select is(pg_temp.vistas('company_fiscal_deadlines', 'aaaa0101-0000-4000-8000-00000000000b'), 1::bigint,
  'VARIANTE ROTA E-12: y el actor A ve los plazos de B (la aserción mide la policy)');
reset role;
drop policy cfd_api_select on public.company_fiscal_deadlines;
create policy cfd_api_select on public.company_fiscal_deadlines for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
select set_config('ladino.actor_id', '', true);

-- ── 3. O-03 ──────────────────────────────────────────────────────────────────
create or replace function pg_temp.sin_procedencia() returns bigint language sql as $$
  select count(*) from information_schema.columns c
    join pg_class t on t.relname = c.table_name
    join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
   where c.table_schema = 'public' and c.column_name = 'created_by' and t.relkind = 'r'
     and not exists (select 1 from pg_trigger g
                      where g.tgrelid = t.oid and not g.tgisinternal
                        and g.tgfoid = 'platform.set_row_provenance'::regproc)
$$;
select is(pg_temp.sin_procedencia(), 0::bigint,
  'O-03: CERO tablas de public con created_by sin set_row_provenance');

insert into auth.users (id) values ('aaaa0101-0000-4000-8000-0000000000d1');
select set_config('ladino.actor_id', 'aaaa0101-0000-4000-8000-0000000000a1', true);
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0101-0000-4000-8000-0000000001d1', 'aaaa0101-0000-4000-8000-00000000000a',
   'aaaa0101-0000-4000-8000-0000000000d1');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id)
select 'aaaa0101-0000-4000-8000-0000000002d1', 'aaaa0101-0000-4000-8000-00000000000a',
       'aaaa0101-0000-4000-8000-0000000001d1', r.id, 'aaaa0101-0000-4000-8000-0000000000aa'
  from public.roles r where r.key = 'cashier' and r.tenant_id is null;
select is((select created_by from public.memberships where id = 'aaaa0101-0000-4000-8000-0000000001d1'),
  'aaaa0101-0000-4000-8000-0000000000a1'::uuid, 'O-03: la membresía nueva guarda a su autor');
select is((select created_by from public.user_role_assignments
            where id = 'aaaa0101-0000-4000-8000-0000000002d1'),
  'aaaa0101-0000-4000-8000-0000000000a1'::uuid, 'O-03: la asignación nueva guarda a su autor');
select set_config('ladino.actor_id', 'aaaa0101-0000-4000-8000-0000000000b1', true);
update public.memberships set status = 'inactive' where id = 'aaaa0101-0000-4000-8000-0000000001d1';
select is((select created_by from public.memberships where id = 'aaaa0101-0000-4000-8000-0000000001d1'),
  'aaaa0101-0000-4000-8000-0000000000a1'::uuid, 'O-03: un UPDATE de otro no reescribe el autor');
select set_config('ladino.actor_id', '', true);

drop trigger memberships_00_provenance on public.memberships;
select is(pg_temp.sin_procedencia(), 1::bigint,
  'VARIANTE ROTA O-03: sin el trigger la consulta da 1 (mide el trigger, no la columna)');
create trigger memberships_00_provenance
  before insert or update on public.memberships
  for each row execute function platform.set_row_provenance();

-- ── 4. Separación de funciones (cuatro ojos POR PERMISO, H4) ─────────────────
select is(
  (select count(*) from public.role_permissions rp
     join public.roles r on r.id = rp.role_id and r.tenant_id is null and r.key = 'owner'
    where rp.permission_key in ('sales.refund', 'treasury.overdraft', 'purchase.payment.approve')),
  3::bigint, 'los tres permisos de aprobación existen y son del Dueño');
select is(
  (select count(*) from public.role_permissions rp
     join public.roles r on r.id = rp.role_id and r.tenant_id is null and r.key = 'cashier'
    where rp.permission_key in ('sales.refund', 'treasury.overdraft', 'purchase.payment.approve')),
  0::bigint, 'el cajero no tiene ninguno (inicia la devolución; el reembolso lo aprueba otro)');

-- B1: dos Dueños activos (OB y UM), los dos pueden aprobar el pago.
-- Desde 20261003130300 la función responde solo por una empresa de un tenant del ACTOR de servicio
-- (C1): cada bloque declara quién pregunta, como hace el servidor.
select set_config('ladino.actor_id', 'aaaa0101-0000-4000-8000-0000000000b1', true);
select ok(platform.four_eyes_active('aaaa0101-0000-4000-8000-0000000000bb', 'purchase.payment.approve'),
  'cuatro ojos: con dos personas que pueden aprobar, activos por omisión');
select ok(not platform.approval_allowed('aaaa0101-0000-4000-8000-0000000000bb', 'purchase.payment.approve',
    'aaaa0101-0000-4000-8000-0000000000b1', 'aaaa0101-0000-4000-8000-0000000000b1'),
  'cuatro ojos: quien registró no aprueba');
select ok(platform.approval_allowed('aaaa0101-0000-4000-8000-0000000000bb', 'purchase.payment.approve',
    'aaaa0101-0000-4000-8000-0000000000b1', 'aaaa0101-0000-4000-8000-0000000000c1'),
  'cuatro ojos: otra persona sí aprueba');
select ok(not platform.approval_allowed('aaaa0101-0000-4000-8000-0000000000bb', 'purchase.payment.approve',
    'aaaa0101-0000-4000-8000-0000000000b1', null),
  'sin aprobador no hay aprobación');

-- C1: dueño + cajero. Solo el dueño puede aprobar un pago: no hay cuatro ojos para ESO.
select set_config('ladino.actor_id', 'aaaa0101-0000-4000-8000-0000000000d7', true);
select ok(not platform.four_eyes_active('aaaa0101-0000-4000-8000-0000000000cc', 'purchase.payment.approve'),
  'H4: dueño + cajero → apagados para purchase.payment.approve (el cajero no puede aprobar)');
select ok(platform.four_eyes_active('aaaa0101-0000-4000-8000-0000000000cc', 'sales.invoice.issue'),
  'H4: y encendidos para vender, que pueden los dos: el conteo es POR permiso');
-- Variante rota: si el cajero pudiera aprobar, se encenderían (mide el permiso, no las personas).
insert into public.role_permissions (role_id, permission_key, tenant_id)
select r.id, 'purchase.payment.approve', null from public.roles r
 where r.key = 'cashier' and r.tenant_id is null;
select ok(platform.four_eyes_active('aaaa0101-0000-4000-8000-0000000000cc', 'purchase.payment.approve'),
  'VARIANTE ROTA H4: con el permiso en el cajero, dueño + cajero sí tienen cuatro ojos');
delete from public.role_permissions rp using public.roles r
 where rp.role_id = r.id and r.key = 'cashier' and r.tenant_id is null
   and rp.permission_key = 'purchase.payment.approve';

-- La bodega de una persona: se apaga UM en B (la desactivación es de la cuenta).
select set_config('ladino.actor_id', 'aaaa0101-0000-4000-8000-0000000000b1', true);
update public.memberships set status = 'inactive' where id = 'aaaa0101-0000-4000-8000-0000000001c2';
select ok(not platform.four_eyes_active('aaaa0101-0000-4000-8000-0000000000bb', 'purchase.payment.approve'),
  'una sola persona activa: cuatro ojos apagados');
select ok(platform.approval_allowed('aaaa0101-0000-4000-8000-0000000000bb', 'purchase.payment.approve',
    'aaaa0101-0000-4000-8000-0000000000b1', 'aaaa0101-0000-4000-8000-0000000000b1'),
  'en la bodega de una persona, el mismo aprueba (el permiso y el motivo los exige el caso de uso)');

-- El ajuste explícito manda sobre el conteo, en los dos sentidos.
insert into public.company_settings (company_id, tenant_id, four_eyes) values
  ('aaaa0101-0000-4000-8000-0000000000bb', 'aaaa0101-0000-4000-8000-00000000000b', true);
select ok(platform.four_eyes_active('aaaa0101-0000-4000-8000-0000000000bb', 'purchase.payment.approve'),
  'four_eyes = true: activos aunque haya una sola persona');
update public.company_settings set four_eyes = false
 where company_id = 'aaaa0101-0000-4000-8000-0000000000bb';
update public.memberships set status = 'active' where id = 'aaaa0101-0000-4000-8000-0000000001c2';
select ok(not platform.four_eyes_active('aaaa0101-0000-4000-8000-0000000000bb', 'purchase.payment.approve'),
  'four_eyes = false: apagados aunque haya dos personas');

-- C1 (20261003130300): la guarda de tenant. B1 tiene four_eyes = false; quien no es de su tenant
-- no lo aprende: recibe TRUE, constante y cerrado.
select set_config('ladino.actor_id', 'aaaa0101-0000-4000-8000-0000000000a1', true);
select ok(platform.four_eyes_active('aaaa0101-0000-4000-8000-0000000000bb', 'purchase.payment.approve'),
  'C1: el actor de OTRO tenant no lee el ajuste de B1 (recibe encendidos, no el false real)');
select set_config('ladino.actor_id', '', true);
select ok(platform.four_eyes_active('aaaa0101-0000-4000-8000-0000000000bb', 'purchase.payment.approve'),
  'C1: sin actor de servicio tampoco responde por ninguna empresa');
-- El usuario de DOS tenants (cajero en A, Dueño en B) sí es de B: recibe la respuesta real.
select set_config('ladino.actor_id', 'aaaa0101-0000-4000-8000-0000000000c1', true);
select ok(not platform.four_eyes_active('aaaa0101-0000-4000-8000-0000000000bb', 'purchase.payment.approve'),
  'C1 (dos tenants): quien pertenece al tenant de B1 recibe la respuesta real (false)');
-- Variante rota: con una membresía activa de OA en B, OA pasa a recibir el false real. La aserción
-- de arriba medía la pertenencia al tenant, no otra cosa.
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0101-0000-4000-8000-0000000001ab', 'aaaa0101-0000-4000-8000-00000000000b',
   'aaaa0101-0000-4000-8000-0000000000a1');
select set_config('ladino.actor_id', 'aaaa0101-0000-4000-8000-0000000000a1', true);
select ok(not platform.four_eyes_active('aaaa0101-0000-4000-8000-0000000000bb', 'purchase.payment.approve'),
  'VARIANTE ROTA C1: con membresía en el tenant de B1, el mismo actor ya recibe el false real');
select set_config('ladino.actor_id', '', true);
select is((select supplier_payment_approval_threshold::text || ' ' || supplier_payment_approval_currency
             from public.company_settings
            where company_id = 'aaaa0101-0000-4000-8000-0000000000bb'),
  '1000.00000000 USD', 'el umbral por omisión es USD 1.000 (regla interna, decidido por criterio)');
select throws_ok(
  $$ update public.company_settings set supplier_payment_approval_threshold = -1
      where company_id = 'aaaa0101-0000-4000-8000-0000000000bb' $$,
  '23514', null, 'el umbral no puede ser negativo');

select * from finish();
rollback;

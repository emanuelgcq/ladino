-- =============================================================================
-- Ladino — pgTAP 4/4 · Aislamiento multi-tenant
--
-- Es el test que da por cumplido S0.3: "un usuario de la empresa A no ve nada
-- de la empresa B, ni leyendo ni escribiendo".
--
-- Se prueba en las CUATRO operaciones. Probar solo SELECT dejaría abierto que
-- A pueda modificar o borrar filas de B sin verlas — un UPDATE con WHERE que no
-- devuelve filas no es un fallo visible, es una fuga silenciosa.
-- =============================================================================

begin;
select plan(28);

-- =============================================================================
-- Estructura: policies separadas por operación, nunca FOR ALL
-- =============================================================================

select is(
  (select count(*) from pg_policy p
     join pg_class c on c.oid = p.polrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and p.polcmd = '*'),
  0::bigint,
  'ninguna policy es FOR ALL: separadas por operación, sin excepción');

-- CORREGIDO EN S0.4: esto decía `= 11`, el número de tablas que había en S0.3.
-- Un recuento fijo no comprueba la propiedad "toda tabla tiene policy": pasa a
-- rojo cuando se AÑADE una tabla con policies —que es correcto— y seguiría en
-- verde si a una tabla se le quitaran las suyas y otra nueva las trajera. Se
-- comprueba la propiedad: CERO tablas de public sin una sola policy.
select is(
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid)),
  0::bigint,
  'CERO tablas de public sin policy. Una tabla con RLS forzada y sin policies '
  'no filtra: cierra a todo el mundo, que es una avería con aspecto de defensa');

-- Cero tablas de `public` sin RLS. Es la condición que el rls-security-auditor
-- comprueba, aquí como test para que no dependa de que alguien lo ejecute.
select is(
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and not (c.relrowsecurity and c.relforcerowsecurity)),
  0::bigint,
  'CERO tablas de public sin RLS habilitada Y forzada');

-- =============================================================================
-- Escritura del bloque RBAC: ninguna para authenticated (ADR-0025 §9)
-- =============================================================================

-- ADR-0025 §9 decía "ninguna policy de escritura". La migración hace algo
-- distinto y MEJOR: policies de escritura que DENIEGAN, con `using (false)` y
-- `with check (false)`.
--
-- La diferencia importa. Sin policy, la denegación es implícita —la RLS deniega
-- por defecto— y no la ve nadie: ni un grep, ni el rls-security-auditor, ni
-- quien lea el esquema. Con `false`, la prohibición está escrita, comentada y
-- es auditable.
--
-- Comprobado empíricamente: con `grant all on all tables in schema public to
-- authenticated` concedido, el INSERT sigue devolviendo 42501. `false` no
-- depende de los privilegios de tabla.
select is(
  (select count(*) from pg_policy p
     join pg_class c on c.oid = p.polrelid
    where c.relname in ('memberships','roles','permissions','role_permissions',
                        'user_role_assignments','scope_bindings')
      and p.polcmd in ('a','w','d')
      and coalesce(pg_get_expr(p.polqual, p.polrelid), 'false') <> 'false'),
  0::bigint,
  'toda policy de escritura sobre el bloque RBAC tiene USING (false): la '
  'denegación está ESCRITA, no es la ausencia de una policy (ADR-0025 §9)');

select is(
  (select count(*) from pg_policy p
     join pg_class c on c.oid = p.polrelid
    where c.relname in ('memberships','roles','permissions','role_permissions',
                        'user_role_assignments','scope_bindings')
      and p.polcmd = 'a'
      and coalesce(pg_get_expr(p.polwithcheck, p.polrelid), 'false') <> 'false'),
  0::bigint,
  'y toda policy de INSERT tiene WITH CHECK (false)');

select ok(not has_table_privilege('authenticated', 'public.role_permissions', 'INSERT'),
  'segunda capa: authenticated ni siquiera tiene el privilegio INSERT sobre '
  'role_permissions');
select ok(not has_table_privilege('authenticated', 'public.permissions', 'INSERT'),
  'permissions se puebla por migración, no por API');
select ok(not has_table_privilege('anon', 'public.companies', 'SELECT'),
  'anon no lee nada: ni siquiera el privilegio de tabla');

-- =============================================================================
-- Dos tenants completos
-- =============================================================================

insert into auth.users (id)
values ('aaaaaaaa-1111-4111-8111-00000000000a'),
       ('bbbbbbbb-2222-4222-8222-00000000000b');

insert into public.tenants (id, name)
values ('11111111-1111-4111-8111-000000000001', 'Tenant A'),
       ('22222222-2222-4222-8222-000000000001', 'Tenant B');

insert into public.companies (id, tenant_id, tax_id, legal_name)
values ('11111111-1111-4111-8111-000000000002',
        '11111111-1111-4111-8111-000000000001', 'J-000000001', 'Empresa A'),
       ('22222222-2222-4222-8222-000000000002',
        '22222222-2222-4222-8222-000000000001', 'J-000000002', 'Empresa B');

insert into public.branches (id, tenant_id, company_id, code, name)
values ('11111111-1111-4111-8111-000000000003',
        '11111111-1111-4111-8111-000000000001',
        '11111111-1111-4111-8111-000000000002', 'S-A', 'Sucursal de A'),
       ('22222222-2222-4222-8222-000000000003',
        '22222222-2222-4222-8222-000000000001',
        '22222222-2222-4222-8222-000000000002', 'S-B', 'Sucursal de B');

insert into public.memberships (id, tenant_id, user_id)
values ('11111111-1111-4111-8111-00000000000d',
        '11111111-1111-4111-8111-000000000001',
        'aaaaaaaa-1111-4111-8111-00000000000a'),
       ('22222222-2222-4222-8222-00000000000d',
        '22222222-2222-4222-8222-000000000001',
        'bbbbbbbb-2222-4222-8222-00000000000b');

insert into public.roles (id, tenant_id, key, name, requires_scope)
values ('11111111-1111-4111-8111-00000000000c', null, 'company_admin', 'Admin', false);

-- El rol necesita el permiso concedido de verdad: la policy de INSERT sobre
-- branches exige platform.ladino_has_permission('branch.manage', company_id).
-- Tener un rol no es tener un permiso — que es exactamente lo que el modelo
-- debe garantizar, y la primera versión de este test lo comprobó sin querer:
-- el INSERT "de A en su propia company" fue denegado porque el rol estaba vacío.
insert into public.role_permissions (role_id, permission_key)
select '11111111-1111-4111-8111-00000000000c', key
  from public.permissions
 where key = 'branch.manage' and not is_scoped;

insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id)
values ('11111111-1111-4111-8111-00000000000e',
        '11111111-1111-4111-8111-000000000001',
        '11111111-1111-4111-8111-00000000000d',
        '11111111-1111-4111-8111-00000000000c',
        '11111111-1111-4111-8111-000000000002'),
       ('22222222-2222-4222-8222-00000000000e',
        '22222222-2222-4222-8222-000000000001',
        '22222222-2222-4222-8222-00000000000d',
        '11111111-1111-4111-8111-00000000000c',
        '22222222-2222-4222-8222-000000000002');

-- =============================================================================
-- AISLAMIENTO — A no ve nada de B (SELECT)
-- =============================================================================

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-1111-4111-8111-00000000000a","role":"authenticated"}', true);
set local role authenticated;

select is((select count(*) from public.companies), 1::bigint,
  'A ve exactamente UNA company: la suya');
select is((select legal_name from public.companies), 'Empresa A',
  'y es Empresa A');
select is((select count(*) from public.branches), 1::bigint,
  'A ve exactamente UNA sucursal');
select is((select code from public.branches), 'S-A',
  'y es la suya');
select is((select count(*) from public.tenants), 1::bigint,
  'A ve exactamente UN tenant');
select is((select count(*) from public.memberships), 1::bigint,
  'A ve solo su propio membership');

-- Las funciones de alcance resuelven lo que deben.
select is((select count(*) from platform.ladino_tenant_ids()), 1::bigint,
  'ladino_tenant_ids() devuelve un tenant para A');
select is((select count(*) from platform.ladino_company_ids()), 1::bigint,
  'ladino_company_ids() devuelve una company para A');

-- =============================================================================
-- AISLAMIENTO EN ESCRITURA — lo que un test de solo SELECT dejaría abierto
-- =============================================================================

-- UPDATE: no falla, simplemente no afecta a ninguna fila. Por eso se cuenta.
update public.branches set name = 'SECUESTRADA'
 where id = '22222222-2222-4222-8222-000000000003';
reset role;
select is(
  (select name from public.branches where id = '22222222-2222-4222-8222-000000000003'),
  'Sucursal de B',
  'UPDATE de A sobre una fila de B no cambia NADA: un update que no afecta '
  'filas no lanza error, así que hay que comprobar el dato, no la excepción');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-1111-4111-8111-00000000000a","role":"authenticated"}', true);
set local role authenticated;

delete from public.branches where id = '22222222-2222-4222-8222-000000000003';
reset role;
select is(
  (select count(*) from public.branches where id = '22222222-2222-4222-8222-000000000003'),
  1::bigint,
  'DELETE de A sobre una fila de B no borra NADA');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-1111-4111-8111-00000000000a","role":"authenticated"}', true);
set local role authenticated;

-- INSERT: la WITH CHECK impide crear filas en otro tenant.
select throws_ok(
  $$ insert into public.branches (tenant_id, company_id, code, name)
     values ('22222222-2222-4222-8222-000000000001',
             '22222222-2222-4222-8222-000000000002', 'INTRUSA', 'De A en B') $$,
  '42501'::char(5), null::text,
  'A no puede INSERTAR una sucursal en la company de B: la WITH CHECK lo corta');

-- Y sí puede en la suya.
select lives_ok(
  $$ insert into public.branches (tenant_id, company_id, code, name)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-000000000002', 'S-A2', 'Segunda de A') $$,
  'A sí puede crear una sucursal en su propia company');

reset role;

-- =============================================================================
-- El lado B — la simetría importa: que A no vea B no implica que B no vea A
-- =============================================================================

select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-2222-4222-8222-00000000000b","role":"authenticated"}', true);
set local role authenticated;

select is((select count(*) from public.companies), 1::bigint,
  'B ve exactamente UNA company');
select is((select legal_name from public.companies), 'Empresa B',
  'y es Empresa B: el aislamiento es simétrico');
select is((select count(*) from public.branches), 1::bigint,
  'B sigue viendo UNA sucursal — la que A intentó crear no está en su lado');

reset role;

-- =============================================================================
-- Sin sesión: anon no ve nada
-- =============================================================================

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok(
  $$ select count(*) from public.companies $$,
  '42501'::char(5), null::text,
  'anon recibe permission denied: no llega ni a la RLS');
reset role;

-- Un usuario autenticado SIN membership no ve nada. Es distinto de anon: tiene
-- los privilegios de tabla, así que el corte lo hace la policy, no el GRANT.
insert into auth.users (id) values ('cccccccc-3333-4333-8333-00000000000c');
select set_config('request.jwt.claims',
  '{"sub":"cccccccc-3333-4333-8333-00000000000c","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.companies), 0::bigint,
  'un usuario autenticado sin membership ve CERO companies: aquí el corte lo '
  'hace la policy, no el privilegio de tabla');
select is((select count(*) from public.branches), 0::bigint,
  'y cero sucursales');
reset role;

-- =============================================================================
-- LÍNEA BASE DE RENDIMIENTO (ADR-0025 §7)
--
-- "Medir es parte de S0.3, no de después". Lo que esto falsaría: que el
-- planificador evalúe platform.ladino_*() POR FILA en vez de una sola vez. La
-- diferencia es de tres órdenes de magnitud y decide si se cumple el p95 < 500 ms
-- de ADR-0014.
-- =============================================================================

insert into public.branches (tenant_id, company_id, code, name)
select '11111111-1111-4111-8111-000000000001',
       '11111111-1111-4111-8111-000000000002', 'VOL-A-' || g, 'Volumen A ' || g
  from generate_series(1, 5000) g;

insert into public.branches (tenant_id, company_id, code, name)
select '22222222-2222-4222-8222-000000000001',
       '22222222-2222-4222-8222-000000000002', 'VOL-B-' || g, 'Volumen B ' || g
  from generate_series(1, 5000) g;

-- ANALYZE lo tiene que correr el dueño de la tabla: con estadísticas vacías la
-- línea base no vale nada.
analyze public.branches;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-1111-4111-8111-00000000000a","role":"authenticated"}', true);
set local role authenticated;

select is((select count(*) from public.branches), 5002::bigint,
  'con 10.000 sucursales en la base, A ve exactamente las 5.002 suyas: el '
  'aislamiento aguanta con volumen');

select performs_ok(
  $$ select count(*) from public.branches $$,
  1000,
  'línea base: recorrer 5.000 filas bajo la policy tarda menos de 1 s. Si esto '
  'se dispara, la función de alcance pasó a evaluarse por fila');

reset role;

select * from finish();
rollback;

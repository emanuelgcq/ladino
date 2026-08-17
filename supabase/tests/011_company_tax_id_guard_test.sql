-- =============================================================================
-- Ladino — pgTAP 11 · M4: guardia del RIF
--
-- Cubre la migración 4/4 de S0.4.
--
-- Lo que hay que comprobar aquí no es «el trigger existe»: es que el rastro
-- lleva el VALOR ANTERIOR. Un evento que dice «se modificó tax_id» sin el valor
-- previo no responde la pregunta de una fiscalización, que no es «¿cambió?»
-- sino «¿bajo qué RIF se emitió esto?».
--
-- Y el camino autorizado se EJERCE, no se deduce: si esta guardia cerrara el
-- cambio de RIF para todo el mundo, todas las aserciones de negación seguirían
-- en verde y la empresa no podría corregir un RIF mal tecleado el primer día.
-- =============================================================================

begin;
select plan(22);

insert into auth.users (id) values
  ('aaaaaaaa-1111-4111-8111-00000000000a'),   -- con company.tax_id.manage
  ('bbbbbbbb-2222-4222-8222-00000000000b');   -- solo con company.manage

insert into public.tenants (id, name) values
  ('11111111-1111-4111-8111-000000000001', 'Tenant A');

insert into public.companies (id, tenant_id, tax_id, legal_name, trade_name) values
  ('11111111-1111-4111-8111-0000000000a1', '11111111-1111-4111-8111-000000000001',
   'J-11111111-1', 'Empresa A1', 'A1');

-- Dos roles: uno puede tocar el RIF, el otro solo gestionar la empresa.
insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('33333333-3333-4333-8333-000000000001', null, 'fiscal_admin', 'Admin fiscal', false),
  ('33333333-3333-4333-8333-000000000002', null, 'gestor', 'Gestor', false);

insert into public.role_permissions (role_id, permission_key) values
  ('33333333-3333-4333-8333-000000000001', 'company.manage'),
  ('33333333-3333-4333-8333-000000000001', 'company.tax_id.manage'),
  ('33333333-3333-4333-8333-000000000002', 'company.manage');

insert into public.memberships (id, tenant_id, user_id) values
  ('44444444-4444-4444-8444-00000000000a', '11111111-1111-4111-8111-000000000001',
   'aaaaaaaa-1111-4111-8111-00000000000a'),
  ('44444444-4444-4444-8444-00000000000b', '11111111-1111-4111-8111-000000000001',
   'bbbbbbbb-2222-4222-8222-00000000000b');

insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('55555555-5555-4555-8555-000000000001', '11111111-1111-4111-8111-000000000001',
   '44444444-4444-4444-8444-00000000000a', '33333333-3333-4333-8333-000000000001',
   '11111111-1111-4111-8111-0000000000a1'),
  ('55555555-5555-4555-8555-000000000002', '11111111-1111-4111-8111-000000000001',
   '44444444-4444-4444-8444-00000000000b', '33333333-3333-4333-8333-000000000002',
   '11111111-1111-4111-8111-0000000000a1');


-- =============================================================================
-- 1. El permiso existe y es distinto de company.manage
-- =============================================================================

select ok(exists (select 1 from public.permissions where key = 'company.tax_id.manage'),
  'company.tax_id.manage tiene fila en permissions');

select ok(
  (select not is_scoped from public.permissions where key = 'company.tax_id.manage'),
  'y no es scoped: el RIF es de la company entera, no de un recurso');

select isnt(
  (select count(*) from public.role_permissions
    where permission_key = 'company.tax_id.manage'),
  (select count(*) from public.role_permissions
    where permission_key = 'company.manage'),
  'y NO se concede con company.manage: son permisos separados, que es el punto '
  'entero — editar el nombre comercial y reescribir el RIF ya no cuestan igual');


-- =============================================================================
-- 2. CAPA 1: `authenticated` perdió el privilegio sobre la columna
-- =============================================================================

select ok(
  not exists (select 1 from information_schema.column_privileges
               where table_schema = 'public' and table_name = 'companies'
                 and grantee = 'authenticated' and privilege_type = 'UPDATE'
                 and column_name = 'tax_id'),
  'CAPA 1: authenticated ya no tiene UPDATE sobre la columna tax_id');

select ok(
  exists (select 1 from information_schema.column_privileges
           where table_schema = 'public' and table_name = 'companies'
             and grantee = 'authenticated' and privilege_type = 'UPDATE'
             and column_name = 'legal_name'),
  'pero SÍ sobre legal_name: esto no cierra ningún otro camino. Una guardia que '
  'bloquea de más es una avería, no una guardia');

-- El usuario CON el permiso tampoco puede por PostgREST: la columna está
-- cerrada para `authenticated` sin excepción, y eso es deliberado.
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-1111-4111-8111-00000000000a","role":"authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$ update public.companies set tax_id = 'J-99999999-9'
      where id = '11111111-1111-4111-8111-0000000000a1' $$,
  '42501', null,
  'ni con company.tax_id.manage se cambia el RIF por PostgREST: pasa por la API '
  'con service_role, como todo lo que hay que poder explicar en una fiscalización');

select lives_ok(
  $$ update public.companies set trade_name = 'A1 renombrada'
      where id = '11111111-1111-4111-8111-0000000000a1' $$,
  'y el resto de la gestión sigue funcionando igual que antes');

reset role;
select set_config('request.jwt.claims', null, true);


-- =============================================================================
-- 3. EL RASTRO — con el valor anterior, que es lo que importa
-- =============================================================================

select is((select count(*) from public.audit_events
            where event_type = 'company.tax_id_changed'), 0::bigint,
  'de partida no hay ningún evento de cambio de RIF');

-- El camino autorizado: servidor, con el actor identificado y con permiso.
select set_config('ladino.actor_id', 'aaaaaaaa-1111-4111-8111-00000000000a', true);
select set_config('ladino.rules_version', '2026.08', true);

select lives_ok(
  $$ update public.companies set tax_id = 'J-22222222-2'
      where id = '11111111-1111-4111-8111-0000000000a1' $$,
  'CAMINO AUTORIZADO: con el permiso y por el camino del servidor, el RIF SÍ se '
  'cambia. Sin esto, corregir un RIF mal tecleado sería imposible y todas las '
  'negaciones de arriba seguirían en verde');

select is((select count(*) from public.audit_events
            where event_type = 'company.tax_id_changed'), 1::bigint,
  'y quedó exactamente UN evento de auditoría');

select is(
  (select payload ->> 'tax_id_anterior' from public.audit_events
    where event_type = 'company.tax_id_changed'),
  'J-11111111-1',
  'EL VALOR ANTERIOR está en el rastro. Es la pregunta de una fiscalización: no '
  '«¿cambió?» sino «¿bajo qué RIF se emitió esto?»');

select is(
  (select payload ->> 'tax_id_nuevo' from public.audit_events
    where event_type = 'company.tax_id_changed'),
  'J-22222222-2',
  'y el nuevo');

select is(
  (select created_by from public.audit_events
    where event_type = 'company.tax_id_changed'),
  'aaaaaaaa-1111-4111-8111-00000000000a'::uuid,
  'con el autor real, tomado del GUC y no del payload');

select is(
  (select rules_version from public.audit_events
    where event_type = 'company.tax_id_changed'),
  '2026.08',
  'y la versión de reglas que declaró el llamante');

select is(
  (select company_id from public.audit_events
    where event_type = 'company.tax_id_changed'),
  '11111111-1111-4111-8111-0000000000a1'::uuid,
  'anclado a la company correcta');

-- Sin versión de reglas declarada, la fila se marca como lo que es.
select set_config('ladino.rules_version', null, true);
update public.companies set tax_id = 'J-33333333-3'
 where id = '11111111-1111-4111-8111-0000000000a1';

select is(
  (select rules_version from public.audit_events
    where payload ->> 'tax_id_nuevo' = 'J-33333333-3'),
  'db-guard',
  'sin rules_version declarada queda `db-guard`: se distingue la fila escrita '
  'por la red del esquema de la escrita por un caso de uso versionado. Un '
  '0.0 inventado las haría indistinguibles');

select set_config('ladino.actor_id', null, true);


-- =============================================================================
-- 4. CAPA 2: el permiso, comprobado en el trigger
--
-- Es la capa que cubre el día en que alguien reponga el GRANT de la columna
-- «para desbloquear un caso urgente» y nadie recuerde por qué estaba quitado.
-- Se repone AQUÍ a propósito, dentro de la transacción de prueba, para llegar
-- al trigger: sin apartar la capa de arriba, no se puede auditar la de abajo.
-- =============================================================================

grant update (tax_id) on public.companies to authenticated;

select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-2222-4222-8222-00000000000b","role":"authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$ update public.companies set tax_id = 'J-44444444-4'
      where id = '11111111-1111-4111-8111-0000000000a1' $$,
  'LAD29', null,
  'CAPA 2: repuesto el GRANT, el usuario con company.manage pero SIN '
  'company.tax_id.manage lo tiene prohibido igual. La guardia no dependía solo '
  'del privilegio de columna');

reset role;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-1111-4111-8111-00000000000a","role":"authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$ update public.companies set tax_id = 'J-55555555-5'
      where id = '11111111-1111-4111-8111-0000000000a1' $$,
  'y el que SÍ tiene company.tax_id.manage pasa: la capa 2 discrimina por '
  'permiso, no bloquea a todos');

reset role;
select set_config('request.jwt.claims', null, true);

revoke update (tax_id) on public.companies from authenticated;

select is(
  (select payload ->> 'tax_id_anterior' from public.audit_events
    where payload ->> 'tax_id_nuevo' = 'J-55555555-5'),
  'J-33333333-3',
  'y ese cambio también dejó rastro con su valor anterior: la cadena de RIF es '
  'reconstruible entera desde audit_events');


-- =============================================================================
-- 5. Lo que NO debe pasar
-- =============================================================================

select set_config('ladino.actor_id', 'aaaaaaaa-1111-4111-8111-00000000000a', true);

-- Se mide el antes en vez de escribir un número. Un literal aquí obliga a
-- recontar a mano cada vez que se añade un cambio de RIF más arriba, y falla
-- por un motivo que no tiene nada que ver con lo que la aserción dice medir.
create temporary table eventos_antes as
  select count(*) as n from public.audit_events
   where event_type = 'company.tax_id_changed';

update public.companies set tax_id = 'J-55555555-5'
 where id = '11111111-1111-4111-8111-0000000000a1';

select is(
  (select count(*) from public.audit_events where event_type = 'company.tax_id_changed'),
  (select n from eventos_antes),
  'reescribir el RIF con EL MISMO valor no genera evento: el `when` del trigger '
  'filtra por cambio real, y un log lleno de no-cambios es un log que nadie lee');

update public.companies set trade_name = 'otra vez'
 where id = '11111111-1111-4111-8111-0000000000a1';

select is(
  (select count(*) from public.audit_events where event_type = 'company.tax_id_changed'),
  (select n from eventos_antes),
  'y tocar otras columnas tampoco lo dispara');

select set_config('ladino.actor_id', null, true);

-- El rastro es append-only como todo lo demás: no se puede reescribir la
-- historia del RIF.
set local role service_role;
select throws_ok(
  $$ update public.audit_events set payload = '{"tax_id_anterior":"otro"}'
      where event_type = 'company.tax_id_changed' $$,
  '42501', null,
  'y el rastro no se puede reescribir: audit_events sigue siendo append-only, '
  'que es lo que hace que este registro valga algo');
reset role;

select * from finish();
rollback;

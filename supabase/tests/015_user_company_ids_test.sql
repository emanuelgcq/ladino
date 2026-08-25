-- =============================================================================
-- Ladino — pgTAP 15 · ladino_user_company_ids(uuid) (migración 15)
--
-- TRES cosas, cada una con su negativo:
--   1. CORRECCIÓN del JOIN parametrizado: asignación directa, tenant-wide,
--      membership inactivo, usuario sin nada, NULL. Con la VARIANTE ROTA que
--      ensancha la visibilidad (ignorar ura.company_id) y comprueba que la
--      aserción de espejo la caza.
--   2. ESPEJO: para el mismo usuario, la parametrizada y ladino_company_ids()
--      (bajo su JWT) devuelven EXACTAMENTE lo mismo. Es el contrato de la
--      delegación: si alguien las hace divergir, la visibilidad de la API y la
--      del cliente dejan de ser la misma cosa sin que nadie lo note.
--   3. DETECTOR DE COSTE sobre 20.000 filas — deliberadamente SIN variante
--      rota, porque las dos candidatas se midieron y ninguna dispara (los
--      números y el porqué, en el bloque 3). No se fabrica un roto que no
--      falla: sería enseñar confianza falsa.
-- =============================================================================

begin;
select plan(10);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values
  ('aaaa0015-0000-4000-8000-0000000000a1'),   -- UA: directa a A1, nada más
  ('aaaa0015-0000-4000-8000-0000000000b1'),   -- UB: tenant-wide en T-A
  ('aaaa0015-0000-4000-8000-0000000000c1'),   -- UC: membership INACTIVO
  ('aaaa0015-0000-4000-8000-0000000000d1');   -- UD: membership sin asignación
insert into public.tenants (id, name) values
  ('aaaa0015-0000-4000-8000-00000000000a', 'Tenant 15-A');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0015-0000-4000-8000-0000000000a2', 'aaaa0015-0000-4000-8000-00000000000a', 'J-15-A1', 'Empresa 15-A1'),
  ('aaaa0015-0000-4000-8000-0000000000a3', 'aaaa0015-0000-4000-8000-00000000000a', 'J-15-A2', 'Empresa 15-A2');
insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('aaaa0015-0000-4000-8000-0000000000e1', null, 'lector15', 'Lector', false);
insert into public.memberships (id, tenant_id, user_id, status) values
  ('aaaa0015-0000-4000-8000-0000000000a4', 'aaaa0015-0000-4000-8000-00000000000a', 'aaaa0015-0000-4000-8000-0000000000a1', 'active'),
  ('aaaa0015-0000-4000-8000-0000000000b4', 'aaaa0015-0000-4000-8000-00000000000a', 'aaaa0015-0000-4000-8000-0000000000b1', 'active'),
  ('aaaa0015-0000-4000-8000-0000000000c4', 'aaaa0015-0000-4000-8000-00000000000a', 'aaaa0015-0000-4000-8000-0000000000c1', 'inactive'),
  ('aaaa0015-0000-4000-8000-0000000000d4', 'aaaa0015-0000-4000-8000-00000000000a', 'aaaa0015-0000-4000-8000-0000000000d1', 'active');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  -- UA: DIRECTA a A1 (no ve A2)
  ('aaaa0015-0000-4000-8000-0000000000a5', 'aaaa0015-0000-4000-8000-00000000000a',
   'aaaa0015-0000-4000-8000-0000000000a4', 'aaaa0015-0000-4000-8000-0000000000e1',
   'aaaa0015-0000-4000-8000-0000000000a2'),
  -- UB: TENANT-WIDE (ve A1 y A2)
  ('aaaa0015-0000-4000-8000-0000000000b5', 'aaaa0015-0000-4000-8000-00000000000a',
   'aaaa0015-0000-4000-8000-0000000000b4', 'aaaa0015-0000-4000-8000-0000000000e1', null),
  -- UC: asignación válida… sobre membership INACTIVO (no ve nada)
  ('aaaa0015-0000-4000-8000-0000000000c5', 'aaaa0015-0000-4000-8000-00000000000a',
   'aaaa0015-0000-4000-8000-0000000000c4', 'aaaa0015-0000-4000-8000-0000000000e1', null);

-- ── 1. Corrección ────────────────────────────────────────────────────────────
select set_eq(
  $$ select * from platform.ladino_user_company_ids('aaaa0015-0000-4000-8000-0000000000a1') $$,
  array['aaaa0015-0000-4000-8000-0000000000a2'::uuid],
  'asignación DIRECTA: exactamente esa company, no todo el tenant');
select set_eq(
  $$ select * from platform.ladino_user_company_ids('aaaa0015-0000-4000-8000-0000000000b1') $$,
  array['aaaa0015-0000-4000-8000-0000000000a2'::uuid, 'aaaa0015-0000-4000-8000-0000000000a3'::uuid],
  'asignación TENANT-WIDE (company_id null): todas las companies del tenant');
select is(
  (select count(*) from platform.ladino_user_company_ids('aaaa0015-0000-4000-8000-0000000000c1')),
  0::bigint, 'membership INACTIVO: nada, aunque la asignación exista');
select is(
  (select count(*) from platform.ladino_user_company_ids('aaaa0015-0000-4000-8000-0000000000d1')),
  0::bigint, 'membership activo SIN asignación: nada — la visibilidad exige rol');
select is(
  (select count(*) from platform.ladino_user_company_ids(null)),
  0::bigint, 'NULL: conjunto vacío, no un error ni todo el catálogo');
select is(
  (select count(*) from platform.ladino_user_company_ids('aaaa0015-0000-4000-8000-00000000000f')),
  0::bigint, 'un uuid que no existe: conjunto vacío');

-- ── 2. Espejo con ladino_company_ids() bajo JWT ──────────────────────────────
-- Puente del TEST (lo borra el rollback): authenticated no ejecuta la
-- parametrizada, así que se le da una vista congelada del resultado de UB.
create function platform.espejo_015()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select * from platform.ladino_user_company_ids('aaaa0015-0000-4000-8000-0000000000b1');
$$;
grant execute on function platform.espejo_015() to authenticated;

select set_config('request.jwt.claims',
  '{"sub":"aaaa0015-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select set_eq(
  $$ select * from platform.ladino_company_ids() $$,
  $$ select * from platform.espejo_015() $$,
  'ESPEJO: ladino_company_ids() bajo el JWT de UB == la parametrizada con UB. '
  'Si divergen, la API y el cliente ven mundos distintos');
reset role;
select set_config('request.jwt.claims', '', true);

-- ── VARIANTE ROTA de corrección: ensanchar la visibilidad ────────────────────
create or replace function platform.ladino_user_company_ids(p_user uuid)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select c.id from public.companies c
   where exists (select 1 from public.memberships m
                  where m.user_id = p_user and m.status = 'active'
                    and m.tenant_id = c.tenant_id);  -- SIN exigir asignación
$$;
select set_eq(
  $$ select * from platform.ladino_user_company_ids('aaaa0015-0000-4000-8000-0000000000a1') $$,
  array['aaaa0015-0000-4000-8000-0000000000a2'::uuid, 'aaaa0015-0000-4000-8000-0000000000a3'::uuid],
  'ROTO: sin exigir asignación, UA ve TODO el tenant — la aserción 1 mide el JOIN completo');

-- Restaurar el cuerpo real antes del gate de coste.
create or replace function platform.ladino_user_company_ids(p_user uuid)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select c.id
    from public.companies c
   where exists (
     select 1
       from public.memberships m
       join public.user_role_assignments ura on ura.membership_id = m.id
      where m.user_id   = p_user
        and m.status    = 'active'
        and m.tenant_id = c.tenant_id
        and (ura.company_id = c.id or ura.company_id is null)
   );
$$;
select set_eq(
  $$ select * from platform.ladino_user_company_ids('aaaa0015-0000-4000-8000-0000000000a1') $$,
  array['aaaa0015-0000-4000-8000-0000000000a2'::uuid],
  'restaurada: la asignación directa vuelve a acotar');

-- ── 3. GATE DE COSTE — 500 invocaciones sobre 20.000 filas ──────────────────
-- La primera versión de este gate midió el envoltorio SQL del 28× de S0.4 y
-- SU ROTO NO DISPARABA: directa 839 ms, envoltorio 882 ms. Para una función
-- tan barata de planificar, esa trampa no cuesta nada — el gate estaba
-- midiendo una tabla casi vacía, que es literalmente el caso contra el que la
-- skill advierte. El modo de fallo REAL de esta función (una llamada por
-- petición del middleware) es la degradación de plan con volumen: sin los
-- índices de memberships/ura, cada llamada recorre las tablas enteras. Ese es
-- el roto, y con 20.000 filas dispara con holgura.
insert into auth.users (id)
select md5('u15-' || g)::uuid from generate_series(1, 20000) g;
insert into public.memberships (id, tenant_id, user_id, status)
select md5('m15-' || g)::uuid, 'aaaa0015-0000-4000-8000-00000000000a',
       md5('u15-' || g)::uuid, 'active'
  from generate_series(1, 20000) g;
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id)
select md5('r15-' || g)::uuid, 'aaaa0015-0000-4000-8000-00000000000a',
       md5('m15-' || g)::uuid, 'aaaa0015-0000-4000-8000-0000000000e1', null
  from generate_series(1, 20000) g;
analyze public.memberships, public.user_role_assignments, public.companies;

create table medicion_015 (variante text, ms numeric);

do $medir$
declare t0 timestamptz; t1 timestamptz; n int := 0; r uuid;
begin
  t0 := clock_timestamp();
  for i in 1..500 loop
    for r in select * from platform.ladino_user_company_ids('aaaa0015-0000-4000-8000-0000000000b1') loop
      n := n + 1;
    end loop;
  end loop;
  t1 := clock_timestamp();
  insert into medicion_015 values ('directa', extract(epoch from (t1 - t0)) * 1000);
end $medir$;

-- Presupuesto con margen amplio sobre el coste real medido (~150-250 ms):
-- detector de regresión, no objetivo de rendimiento (013).
-- ═══ POR QUÉ ESTE DETECTOR NO TIENE VARIANTE ROTA — y eso es un HALLAZGO ═══
-- Se midieron LOS DOS candidatos a roto y NINGUNO dispara:
--   · el envoltorio SQL del 28× de S0.4: directa 839 ms vs envoltorio 882 ms
--     sobre 2.000 llamadas — esta función es tan barata de PLANIFICAR que
--     replanificarla no cuesta nada (el 28× necesitaba el cuerpo de
--     ladino_has_permission evaluado POR FILA);
--   · quitar los índices de memberships/ura con 20.000 filas: 254 ms con
--     índices, 245 ms sin ellos — un seqscan de 20k filas ronda 0,3 ms, y a
--     UNA llamada por petición no hay catástrofe que detectar.
-- Un «roto» que no falla convertiría este detector en teatro (la regla de la
-- skill). Así que la aserción de abajo queda como detector de DESASTRE
-- (>6× sobre datos reales la disparan), declaradamente SIN negativo, y el
-- gate de coste por fila del camino RLS sigue siendo 013 — ese sí tiene roto
-- que dispara. Si esta función algún día entra en una policy POR FILA, ahí
-- será cuando el gate con roto sea posible y obligatorio.
select cmp_ok((select ms from medicion_015 where variante = 'directa'), '<', 1500::numeric,
  'DETECTOR: 500 invocaciones (una por petición del middleware) sobre 20.000 '
  'memberships/asignaciones, bajo 1.500 ms — sin variante rota POSIBLE, ver '
  'cabecera del bloque: dos candidatas medidas y ninguna mueve la aguja');

select * from finish();
rollback;

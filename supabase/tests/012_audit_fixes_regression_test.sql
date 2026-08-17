-- =============================================================================
-- Ladino — pgTAP 12 · Regresión de las correcciones de auditoría (migración 5/5)
--
-- Cada aserción de este fichero corresponde a un defecto que los 316 tests
-- anteriores NO detectaron. Todos pasaban, y todos pasaban por el mismo motivo:
-- los datos de prueba evitaban el caso malo sin querer.
--
--   · `event_type` de tres segmentos     -> los tests usaban nombres inventados
--                                            de dos, no los del catálogo real
--   · `occurred_at` con reloj de pared   -> los tests mandaban now(), que es la
--                                            hora de inicio de transacción
--   · `payload` escalar                  -> los tests siempre mandaban objetos
--   · clave de idempotencia por actor    -> los tests usaban un solo usuario
--
-- La lección, y va escrita aquí porque este fichero es su consecuencia: un test
-- que elige sus propios datos tiende a elegir los que funcionan. Cuando exista
-- un catálogo, el test recorre el CATÁLOGO, no una muestra escrita a mano.
-- =============================================================================

begin;
select plan(27);

insert into auth.users (id) values
  ('aaaaaaaa-1111-4111-8111-00000000000a'),
  ('bbbbbbbb-2222-4222-8222-00000000000b');

insert into public.tenants (id, name) values
  ('11111111-1111-4111-8111-000000000001', 'Tenant A');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('11111111-1111-4111-8111-0000000000a1', '11111111-1111-4111-8111-000000000001',
   'J-A1', 'Empresa A1');


-- =============================================================================
-- 1. ALTO-1 — los eventos REALES del catálogo entran
--
-- No se prueban nombres inventados: se prueba `EVENT_CATALOG.md` tal como está.
-- Los siete fiscales son los de tres segmentos, que el CHECK anterior rechazaba
-- y que habrían hecho fallar la primera emisión de la Fase 11 — no el log: la
-- emisión, porque auditoría y outbox van dentro de la transacción del caso de uso.
-- =============================================================================

create temporary table catalogo (event_type text) on commit drop;
insert into catalogo (event_type) values
  -- Fiscal (los siete de TRES segmentos)
  ('fiscal.invoice.issuing'), ('fiscal.invoice.issued'), ('fiscal.invoice.failed'),
  ('fiscal.credit_note.issued'), ('fiscal.debit_note.issued'),
  ('fiscal.contingency.started'), ('fiscal.contingency.ended'),
  -- Accounting
  ('journal.posted'), ('journal.reversed'), ('period.closed'), ('period.reopened'),
  -- Inventario
  ('stock.received'), ('stock.shipped'), ('stock.transferred'), ('stock.adjusted'),
  -- Tesorería
  ('payment.received'), ('payment.sent'), ('payment.applied'), ('bank.reconciled');

insert into public.audit_events
  (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
   actor_type, occurred_at, rules_version, payload)
select '11111111-1111-4111-8111-000000000001',
       '11111111-1111-4111-8111-0000000000a1', 'invoice',
       platform.uuidv7(), c.event_type, 'system', now(), '2026.1', '{}'
  from catalogo c;

select is(
  (select count(*) from public.audit_events
    where event_type in (select event_type from catalogo)),
  (select count(*) from catalogo),
  'audit_events admite los 19 event_type del catálogo, incluidos los SIETE '
  'fiscales de tres segmentos que el CHECK anterior rechazaba');

insert into public.outbox
  (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
   schema_version, payload)
select '11111111-1111-4111-8111-000000000001',
       '11111111-1111-4111-8111-0000000000a1', 'invoice',
       platform.uuidv7(), c.event_type, 1, '{}'
  from catalogo c;

select is(
  (select count(*) from public.outbox
    where event_type in (select event_type from catalogo)),
  (select count(*) from catalogo),
  'y outbox también: era el mismo defecto en las dos tablas');

-- El CHECK sigue rechazando lo que debía rechazar. Sin esto, «lo arreglamos»
-- podría significar «lo quitamos».
select throws_ok(
  $$ insert into public.audit_events
       (tenant_id, aggregate_type, aggregate_id, event_type, actor_type,
        occurred_at, rules_version)
     values ('11111111-1111-4111-8111-000000000001', 'invoice',
             '77777777-7777-4777-8777-000000000001', 'Se emitió la factura',
             'system', now(), '2026.1') $$,
  '23514', null,
  'y sigue rechazando prosa: la corrección amplía la forma, no la elimina');

select throws_ok(
  $$ insert into public.audit_events
       (tenant_id, aggregate_type, aggregate_id, event_type, actor_type,
        occurred_at, rules_version)
     values ('11111111-1111-4111-8111-000000000001', 'invoice',
             '77777777-7777-4777-8777-000000000001', 'invoice',
             'system', now(), '2026.1') $$,
  '23514', null,
  'un solo segmento tampoco: sigue exigiendo al menos agregado.acción');


-- =============================================================================
-- 2. ALTO-2 — el reloj de pared
--
-- `created_at` es now(), la hora de INICIO de transacción. Antes, cualquier
-- timestamp tomado tras el BEGIN violaba el CHECK.
-- =============================================================================

select lives_ok(
  $$ do $inner$ begin
       perform pg_sleep(0.05);
       insert into public.audit_events
         (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
          actor_type, occurred_at, rules_version, payload)
       values ('11111111-1111-4111-8111-000000000001',
               '11111111-1111-4111-8111-0000000000a1', 'invoice',
               '77777777-7777-4777-8777-00000000e001', 'invoice.issued',
               'system', clock_timestamp(), '2026.1', '{}');
     end $inner$ $$,
  'un evento con clock_timestamp() TRAS 50 ms de trabajo entra. Antes fallaba '
  'con 23514, y como la auditoría comparte commit con el hecho de negocio, lo '
  'que abortaba era el pago o el asiento, no el log');

select lives_ok(
  $$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version, payload)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1', 'invoice',
             '77777777-7777-4777-8777-00000000e002', 'invoice.issued',
             'system', now() + interval '25 seconds', '2026.1', '{}') $$,
  'y 25 s de deriva de reloj se absorben: es un NTP degradado, no una mentira');

select throws_ok(
  $$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version, payload)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1', 'invoice',
             '77777777-7777-4777-8777-00000000e003', 'invoice.issued',
             'system', now() + interval '10 minutes', '2026.1', '{}') $$,
  'LAD30', null,
  'pero 10 minutos en el futuro se siguen rechazando: la tolerancia es para '
  'deriva de reloj, no para inventar cuándo ocurrió algo');

select lives_ok(
  $$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version, payload)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1', 'invoice',
             '77777777-7777-4777-8777-00000000e004', 'invoice.issued',
             'system', now() - interval '9 days', '2026.1', '{}') $$,
  'y hacia el PASADO no hay cota: en modo offline el hecho pudo ocurrir hace '
  'días, y el dispositivo sincroniza al reconectar');


-- =============================================================================
-- 3. MEDIO-2 — el hash devolvía NULL y colisionaba
-- =============================================================================

select throws_ok(
  $$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version, payload)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1', 'invoice',
             '77777777-7777-4777-8777-00000000e005', 'invoice.issued',
             'system', now(), '2026.1', 'null'::jsonb) $$,
  '23502', null,
  'el escalar `null` se rechaza — pero con 23502 (NOT NULL de payload_hash), no '
  'con el CHECK nuevo. HALLAZGO DE ORDEN: las columnas GENERADAS se calculan '
  'ANTES de evaluar los CHECK, así que el NOT NULL de payload_hash dispara '
  'primero. Es el orden CONTRARIO al de los triggers BEFORE ROW, que sí van '
  'antes que los CHECK (en lo que se apoya audit_events_occurred_at_chk). Dos '
  'reglas de orden opuestas en la misma tabla: conviene no deducir una de la otra');

select throws_ok(
  $$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version, payload)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1', 'invoice',
             '77777777-7777-4777-8777-00000000e006', 'invoice.issued',
             'system', now(), '2026.1', to_jsonb('{"a": 1}'::text)) $$,
  '23514', null,
  'y una CADENA que deletrea un objeto también: era la colisión — tenía el '
  'mismo hash que el objeto real');

select throws_ok(
  $$ insert into public.outbox
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        schema_version, payload)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1', 'invoice',
             '77777777-7777-4777-8777-00000000e007', 'invoice.issued', 1,
             '[1,2]'::jsonb) $$,
  '23514', null,
  'en outbox igual: un array no es un payload de evento');

-- Y ahora la parte incómoda, dicha como es: el CHECK NO arregla la función.
--
-- `audit_payload_hash` sigue colisionando sobre jsonb arbitrario — un objeto y
-- la cadena que deletrea su texto comparten huella. Lo que el CHECK consigue es
-- que la colisión sea INALCANZABLE a través de la tabla, porque uno de los dos
-- operandos ya no se puede almacenar. Es una defensa más débil que «la función
-- es inyectiva», y merece decirse en vez de darse por resuelta.
--
-- No se arregla la función a propósito: cambiar su cuerpo NO recalcula los
-- `payload_hash` ya almacenados (columna generada stored), así que una función
-- «mejorada» dejaría filas viejas con hashes que ya nadie puede reproducir —
-- exactamente el modo de fallo que MEDIO-3 de la auditoría señaló.
select is(
  platform.audit_payload_hash('{}'::jsonb),
  platform.audit_payload_hash(to_jsonb('{}'::text)),
  'LÍMITE CONOCIDO: la función sigue colisionando sobre jsonb arbitrario. El '
  'CHECK hace la colisión inalcanzable por la tabla, no imposible en la función');

select throws_ok(
  $$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version, payload)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1', 'invoice',
             '77777777-7777-4777-8777-00000000e008', 'invoice.issued',
             'system', now(), '2026.1', to_jsonb('{}'::text)) $$,
  '23514', null,
  'y por eso lo que importa: el operando que produce la colisión no se puede '
  'almacenar. Los dos lados de una colisión no pueden coexistir en la tabla');


-- =============================================================================
-- 4. MEDIO-1 — la resolución de permisos, con UNA sola implementación
-- =============================================================================

insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('33333333-3333-4333-8333-000000000001', null, 'fiscal_admin', 'Admin fiscal', false);
insert into public.role_permissions (role_id, permission_key) values
  ('33333333-3333-4333-8333-000000000001', 'company.tax_id.manage');
insert into public.memberships (id, tenant_id, user_id) values
  ('44444444-4444-4444-8444-00000000000a', '11111111-1111-4111-8111-000000000001',
   'aaaaaaaa-1111-4111-8111-00000000000a');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('55555555-5555-4555-8555-000000000001', '11111111-1111-4111-8111-000000000001',
   '44444444-4444-4444-8444-00000000000a', '33333333-3333-4333-8333-000000000001',
   '11111111-1111-4111-8111-0000000000a1');

select ok(
  platform.ladino_user_has_permission(
    'aaaaaaaa-1111-4111-8111-00000000000a', 'company.tax_id.manage',
    '11111111-1111-4111-8111-0000000000a1'),
  'la variante parametrizada resuelve el permiso SIN JWT: es lo que permite '
  'autorizar en el camino de servidor, y no solo atribuir');

select ok(
  not platform.ladino_user_has_permission(
    'bbbbbbbb-2222-4222-8222-00000000000b', 'company.tax_id.manage',
    '11111111-1111-4111-8111-0000000000a1'),
  'y niega a quien no lo tiene');

-- La delegación: la original debe dar EXACTAMENTE lo mismo que la nueva con
-- auth.uid(). Si divergen, hay dos copias de la resolución RBAC, que es lo que
-- esta migración vino a impedir.
-- El valor de referencia se calcula ANTES de cambiar de rol: desde la migración
-- 6/6, `authenticated` ya no puede ejecutar la parametrizada —era un oráculo de
-- permisos ajenos— así que llamarla bajo ese rol da 42501. Se guarda primero.
create temporary table referencia as
  select platform.ladino_user_has_permission(
           'aaaaaaaa-1111-4111-8111-00000000000a', 'company.tax_id.manage',
           '11111111-1111-4111-8111-0000000000a1') as esperado;
-- La tabla temporal es del owner: sin este grant, leerla bajo `authenticated`
-- da 42501 y el fichero muere a mitad.
grant select on referencia to authenticated;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-1111-4111-8111-00000000000a","role":"authenticated"}', true);
set local role authenticated;
select is(
  platform.ladino_has_permission('company.tax_id.manage',
    '11111111-1111-4111-8111-0000000000a1'),
  (select esperado from referencia),
  'ladino_has_permission() delega: mismo resultado que la parametrizada con '
  'auth.uid(). Una sola implementación, no dos que puedan divergir');
reset role;
select set_config('request.jwt.claims', null, true);

-- Las dos conservan el pin de search_path. `create or replace` es un reemplazo
-- completo y lo resetea; ya nos costó una función en S0.3.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'platform'
      and p.proname in ('ladino_has_permission', 'ladino_user_has_permission')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
                       where cfg like 'search_path=%')),
  0::bigint,
  'las dos conservan `set search_path` tras el create or replace. En proconfig '
  'el elemento es `search_path=""`, no `search_path=`: comparar por igualdad '
  'exacta daba un falso negativo que este mismo test cazó');

select ok(
  not has_function_privilege('anon',
    'platform.ladino_user_has_permission(uuid,text,uuid)', 'EXECUTE'),
  'y anon no puede ejecutar la parametrizada: dejaría preguntar por los '
  'permisos de cualquier usuario');


-- =============================================================================
-- 5. F-3 — el alta del RIF deja rastro
-- =============================================================================

select is(
  (select count(*) from public.audit_events
    where event_type = 'company.tax_id_established'
      and company_id = '11111111-1111-4111-8111-0000000000a1'), 1::bigint,
  'crear una company deja evento del RIF con el que nace. Antes, la identidad '
  'fiscal bajo la que se emitirían los primeros documentos no tenía rastro');

select is(
  (select payload ->> 'tax_id_nuevo' from public.audit_events
    where event_type = 'company.tax_id_established'
      and company_id = '11111111-1111-4111-8111-0000000000a1'),
  'J-A1',
  'con el valor establecido');

select ok(
  (select payload ? 'tax_id_anterior' from public.audit_events
    where event_type = 'company.tax_id_established'
      and company_id = '11111111-1111-4111-8111-0000000000a1'),
  'y la clave `tax_id_anterior` EXISTE con valor NULL, en vez de faltar: quien '
  'lea el payload distingue «no había anterior» de «no se registró»');

-- El alta NO exige company.tax_id.manage: pedirlo haría imposible crear una
-- empresa, que es cerrar el camino autorizado otra vez.
select lives_ok(
  $$ insert into public.companies (id, tenant_id, tax_id, legal_name)
     values ('11111111-1111-4111-8111-0000000000a9',
             '11111111-1111-4111-8111-000000000001', 'J-A9', 'Empresa A9') $$,
  'y dar de alta una company NO exige company.tax_id.manage: en el alta el RIF '
  'se establece, no se cambia. Exigirlo cerraría el alta de empresas');


-- =============================================================================
-- 6. MEDIO-1 — la capa 2 de M4 autoriza en el camino de servidor
-- =============================================================================

select set_config('ladino.actor_id', 'bbbbbbbb-2222-4222-8222-00000000000b', true);
select throws_ok(
  $$ update public.companies set tax_id = 'J-ROBADO'
      where id = '11111111-1111-4111-8111-0000000000a1' $$,
  'LAD29', null,
  'CAPA 2 VIVA: por el camino de servidor (GUC, sin JWT), un actor SIN el '
  'permiso ya no pasa. Antes la base atribuía la fila a ese actor sin haber '
  'comprobado nada sobre él: confiaba en el GUC para atribuir y no para autorizar');

select set_config('ladino.actor_id', 'aaaaaaaa-1111-4111-8111-00000000000a', true);
select lives_ok(
  $$ update public.companies set tax_id = 'J-A1-CORREGIDO'
      where id = '11111111-1111-4111-8111-0000000000a1' $$,
  'y el actor CON el permiso pasa por el mismo camino: la capa 2 discrimina, '
  'no bloquea');

select is(
  (select payload ->> 'tax_id_anterior' from public.audit_events
    where event_type = 'company.tax_id_changed'
      and payload ->> 'tax_id_nuevo' = 'J-A1-CORREGIDO'),
  'J-A1',
  'con su valor anterior, encadenando con el evento del alta');

select set_config('ladino.actor_id', null, true);


-- =============================================================================
-- 7. ALTO-3 — la clave de idempotencia lleva actor
--
-- SUPERSEDIDO POR LA MIGRACIÓN 6/6. Esta sección probaba el alcance por actor
-- usando `created_by`, que la 5/5 metió en el índice único. Era un error: se
-- construyó una restricción de unicidad sobre una columna cuyo contrato
-- documentado es best-effort —si la API olvida el GUC, `created_by` queda NULL
-- en silencio— y el reintento sin GUC creaba una segunda reserva.
--
-- La 6/6 separó las dos cosas: `created_by` es PROCEDENCIA y `actor_id` es
-- SEMÁNTICA DE LA CLAVE, explícita y NOT NULL. **El alcance por actor se prueba
-- ahora en el test 013 §5**, con la columna correcta.
--
-- Lo que queda aquí es la comprobación de que el cambio se aplicó.
-- =============================================================================

select ok(
  not exists (select 1 from pg_attribute a
                join pg_index i on i.indexrelid = 'public.idempotency_keys_scope_uq'::regclass
               where a.attrelid = 'public.idempotency_keys'::regclass
                 and a.attnum = any(i.indkey) and a.attname = 'created_by'),
  'created_by ya NO gobierna la unicidad de la clave de idempotencia: era una '
  'columna best-effort sosteniendo una restricción que no admite «best»');

select ok(
  (select indnullsnotdistinct from pg_index
    where indexrelid = 'public.idempotency_keys_scope_uq'::regclass),
  'el índice conserva NULLS NOT DISTINCT por company_id, que sigue siendo '
  'nullable para las operaciones de nivel tenant');

select * from finish();
rollback;

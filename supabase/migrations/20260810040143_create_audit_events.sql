-- =============================================================================
-- Ladino — 1/4 de S0.4 · `audit_events`, la pista de auditoría append-only
--
-- Módulo:         auditoría (S0.4)
-- Spec:           ADR-0026 (D1, D2, D3, D8, D9, D10), ADR-0006 (append-only),
--                 ADR-0025 §6 (dos capas), AUDIT_TRAIL_AND_IMMUTABILITY.md,
--                 SENIAT_ART121_CONTROL_MATRIX.md (trazabilidad, inalterabilidad)
-- Reversibilidad: SÍ, pero solo mientras la tabla esté VACÍA.
--                 drop table public.audit_events cascade;
--                 drop function platform.audit_payload_hash(jsonb);
--                 delete from public.permissions where key = 'fiscal.audit.read';
--                 Con datos dentro DEJA de ser reversible: es la pista de
--                 auditoría, y borrarla es exactamente lo que la tabla existe
--                 para impedir. Ver `PRIVACY_AND_DATA_GOVERNANCE.md` §conservación.
-- HOMOLOGATION_IMPACT: YES
--
-- Primera de cuatro. Depende de las seis de S0.3: `platform.uuidv7()`,
-- `reject_mutation()`, `set_row_provenance()`, `assert_isolation_anchors_immutable()`
-- y las funciones `ladino_*`.
--
-- LO QUE ESTA TABLA NO ES: no lleva cadena hash (ADR-0026 D1). La razón es
-- ESTRUCTURAL, no de rendimiento: una cadena exige orden total sobre las
-- inserciones, y eso es un punto de serialización en la tabla que más crece de
-- la plataforma, atravesada por cada caso de uso de cada tenant. No es un
-- cuello que se optimice después con un índice mejor — es la definición de la
-- cadena la que obliga a escribir de una en una. Si SENIAT la exige, el diseño
-- está escrito en ADR-0026 §D1: particionada por company, calculada por un
-- verificador asíncrono sobre `audit_chain`, NUNCA en el camino de escritura.
--
-- QUIÉN ESCRIBE: el caso de uso, dentro de su misma transacción (ADR-0026 D2).
-- No el worker. Una fila de auditoría escrita por un consumidor at-least-once
-- vive fuera de la transacción del hecho que audita, y entonces existen dos
-- estados que no deberían existir: el hecho ocurrió y la auditoría no está, o
-- el hecho se revirtió y la auditoría se escribió igual.
-- =============================================================================


-- =============================================================================
-- 1. La promesa de inmutabilidad de `audit_payload_hash` se VERIFICA, no se asume
--
-- La función de abajo se declara IMMUTABLE porque una columna generada lo
-- exige. `convert_to(text, 'UTF8')` es STABLE en el catálogo, y lo es por una
-- sola razón: la codificación de ORIGEN es una propiedad de la base de datos.
-- Fijada la base a UTF8, la conversión es la identidad sobre los bytes y la
-- función es genuinamente inmutable.
--
-- Declarar IMMUTABLE algo que no lo es corrompe índices y columnas generadas en
-- silencio, que es la peor clase de fallo que hay en este repositorio. Así que
-- la premisa no se da por buena: se comprueba aquí, y la migración FALLA si la
-- base no es UTF8. Una base con otra codificación no puede cambiarla sin
-- dump/restore, y un restore recalcula las columnas generadas de todos modos.
-- =============================================================================

do $$
begin
  if current_setting('server_encoding') <> 'UTF8' then
    raise exception
      'LADINO_ENCODING: audit_events exige server_encoding = UTF8, encontrado %. '
      'platform.audit_payload_hash() no puede declararse IMMUTABLE sin esa premisa.',
      current_setting('server_encoding')
      using errcode = 'LAD26';
  end if;
end;
$$;

create or replace function platform.audit_payload_hash(payload jsonb)
returns bytea
language sql
immutable
parallel safe
set search_path = ''
as $$
  -- `payload #>> '{}'` es la extracción del jsonb completo como texto, y es
  -- IMMUTABLE (jsonb_extract_path_text). El cast `payload::text` NO sirve: va
  -- por la función de salida del tipo y el planificador lo trata como STABLE.
  select sha256(convert_to(payload #>> '{}', 'UTF8'))
$$;

comment on function platform.audit_payload_hash(jsonb) is
  'SHA-256 del payload de auditoría. La forma canónica no se implementa a mano: '
  'Postgres almacena jsonb con claves ORDENADAS y DEDUPLICADAS, así que el hash '
  'es reproducible con independencia de cómo serialice el cliente. IMMUTABLE '
  'apoyado en server_encoding = UTF8, verificado por esta misma migración. '
  'ADR-0026 D1.';

revoke execute on function platform.audit_payload_hash(jsonb) from public;

-- Y se concede a quien escribe. NO es un detalle: una columna generada evalúa
-- su expresión con los privilegios del que INSERTA, así que sin este GRANT
-- `service_role` —el único rol autorizado a escribir auditoría— recibe
-- «permission denied for function audit_payload_hash» y la tabla queda
-- ESCRIBIBLE POR NADIE. Todos los checks de privilegio de tabla seguirían en
-- verde: `has_table_privilege(service_role, …, 'INSERT')` es cierto, y la
-- escritura falla igual, dos capas más abajo.
--
-- Lo encontró el test 008 al intentar el INSERT de verdad, no al consultar el
-- bit. Es la avería silenciosa de ADR-0023: una defensa que cierra el único
-- camino autorizado. `authenticated` no lo recibe porque no inserta.
grant execute on function platform.audit_payload_hash(jsonb) to service_role;


-- =============================================================================
-- 2. La tabla
-- =============================================================================

create table public.audit_events (
  id              uuid        primary key default platform.uuidv7(),

  -- Anclas de aislamiento. `tenant_id` sin excepción (regla 5 de CLAUDE.md).
  tenant_id       uuid        not null,
  -- `company_id` es NULLABLE a propósito: crear una company es un evento de
  -- nivel TENANT y no tiene company contra la que anclarse.
  company_id      uuid,

  -- Qué ocurrió.
  aggregate_type  text        not null,
  aggregate_id    uuid        not null,
  event_type      text        not null,

  -- Quién y cuándo. `actor_id` y `server_received_at` NO existen: son
  -- `created_by` y `created_at`, gobernados por trigger (ADR-0026 D8). Dos
  -- columnas para el mismo dato es una invitación a que diverjan.
  actor_type      text        not null,
  occurred_at     timestamptz not null,

  -- Con qué reglas se calculó. Columna propia, no un campo dentro del payload
  -- (ADR-0026 D9): es el dato que hay que poder responder en una fiscalización,
  -- y enterrado en un jsonb no es indexable ni exigible con NOT NULL.
  rules_version   text        not null,

  -- El hecho, y su huella.
  payload         jsonb       not null default '{}'::jsonb,
  payload_hash    bytea       not null
                    generated always as (platform.audit_payload_hash(payload)) stored,

  -- Contexto del cliente. Todo nullable: `API_SPEC.md` §Headers define cuatro
  -- cabeceras y NINGUNA transporta esto todavía. Exigirlo hoy sería exigir algo
  -- que ninguna capa puede proveer.
  ip              inet,
  device_id       text,
  session_id      text,
  app_build       text,

  -- Procedencia, gobernada por platform.set_row_provenance().
  created_by      uuid,
  created_at      timestamptz not null,
  version         integer     not null,

  -- FK compuesta al par (tenant, company): impide colgar el evento de una
  -- company de OTRO tenant. Con `company_id` NULL la restricción no se evalúa
  -- (MATCH SIMPLE), que es justo lo que queremos para los eventos de tenant.
  constraint audit_events_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint audit_events_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),

  -- Forma de `event_type`, no catálogo. Qué eventos son válidos es la política
  -- que ADR-0026 D10 difiere y R-04 registra con dueño. Esto solo impide que el
  -- campo degenere en texto libre mientras tanto: restringir después a un
  -- conjunto cerrado es fácil; recuperar seis meses de event_type inventados
  -- sobre la marcha, no.
  constraint audit_events_event_type_chk
    check (event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),

  constraint audit_events_actor_type_chk
    check (actor_type in ('user', 'system')),

  -- Un cliente no declara que algo ocurrió en el futuro. Funciona porque los
  -- triggers BEFORE ROW disparan ANTES que las CHECK constraints (verificado en
  -- S0.3): cuando esto se evalúa, `created_at` ya tiene la hora del servidor.
  -- Escrito al revés —sin el trigger— la comparación sería contra NULL y
  -- pasaría siempre, en silencio.
  constraint audit_events_occurred_at_chk
    check (occurred_at <= created_at),

  constraint audit_events_aggregate_type_chk
    check (aggregate_type ~ '^[a-z][a-z0-9_]*$'),

  constraint audit_events_rules_version_chk
    check (length(rules_version) between 1 and 64)
);

comment on table public.audit_events is
  'Pista de auditoría append-only. La escribe el CASO DE USO dentro de su '
  'transacción, nunca el worker (ADR-0026 D2). Inmutable en dos capas: sin '
  'privilegios de UPDATE/DELETE/TRUNCATE para nadie, y reject_mutation() en '
  'trigger, que alcanza a service_role donde los GRANT no llegan (ADR-0006).';

comment on column public.audit_events.company_id is
  'NULL para eventos de nivel tenant (p. ej. el alta de una company). '
  'Consecuencia deliberada: esos eventos NO son legibles por authenticated — '
  'ver la policy de SELECT.';
comment on column public.audit_events.payload_hash is
  'Columna GENERADA: el cliente no puede fijarla ni con service_role, porque no '
  'se puede nombrar en un INSERT. Más fuerte que un trigger, que se puede '
  'olvidar de enganchar en una tabla futura.';
comment on column public.audit_events.rules_version is
  'Versión del motor de reglas con que se calculó el hecho. Regla 3 de CLAUDE.md.';
comment on column public.audit_events.version is
  'Columna MUERTA en esta tabla: nunca hay UPDATE. Se conserva por uniformidad '
  'de set_row_provenance() — cuatro bytes cuestan menos que una excepción en un '
  'trigger compartido, y un trigger con casos especiales se aplica mal '
  '(ADR-0026, bloqueante 1 de S0.3).';


-- =============================================================================
-- 3. Índices
--
-- La PK ya es uuidv7, ordenable en el tiempo: los recorridos «lo más reciente»
-- salen casi ordenados sin índice adicional, y es lo que hace viable la cadena
-- diferida de ADR-0026 D1 sin imponer orden en la escritura.
-- =============================================================================

-- El acceso natural: el timeline de un agregado (PA121 «trazabilidad → timeline»).
create index audit_events_aggregate_idx
  on public.audit_events (tenant_id, aggregate_type, aggregate_id, id desc);

-- El timeline de una company, que es la vista de auditoría del producto.
create index audit_events_company_idx
  on public.audit_events (company_id, id desc)
  where company_id is not null;

-- Búsqueda por tipo de evento dentro de un tenant.
create index audit_events_type_idx
  on public.audit_events (tenant_id, event_type, id desc);

-- Quién hizo qué. Parcial: `created_by` es NULL en el trabajo de sistema, y esas
-- filas no se buscan por actor.
create index audit_events_actor_idx
  on public.audit_events (tenant_id, created_by, id desc)
  where created_by is not null;


-- =============================================================================
-- 4. Los tres bloqueantes heredados de S0.3
-- =============================================================================

-- Bloqueante 1 — procedencia gobernada por el servidor.
create trigger audit_events_provenance
  before insert or update on public.audit_events
  for each row execute function platform.set_row_provenance();

-- Bloqueante 3 — las anclas de aislamiento no se mueven.
-- Aquí es redundante con reject_mutation() (no hay UPDATE que pueda moverlas),
-- pero el test 006 lo comprueba como PROPIEDAD SOBRE EL CATÁLOGO: toda tabla
-- con tenant_id lo lleva. Una excepción «porque aquí no hace falta» convierte
-- una propiedad verificable en una lista de casos que alguien tiene que
-- recordar. Se paga el trigger y se conserva la propiedad.
create trigger audit_events_anchors
  before update on public.audit_events
  for each row execute function platform.assert_isolation_anchors_immutable();

-- Bloqueante 2 — reject_mutation() se engancha DOS veces.
-- El de fila cubre UPDATE y DELETE. El de statement cubre TRUNCATE, que ignora
-- la RLS, no dispara triggers de fila, y que Supabase concede a anon y
-- authenticated en toda tabla nueva de `public`.
create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function platform.reject_mutation();

create trigger audit_events_no_truncate
  before truncate on public.audit_events
  for each statement execute function platform.reject_mutation();


-- =============================================================================
-- 5. El permiso del que depende la policy de lectura: se COMPRUEBA que existe
--
-- La policy de SELECT de abajo exige `fiscal.audit.read`. Ese permiso ya existe
-- desde S0.3 (migración 3/4, catálogo de 23 filas) — cosa que conviene no dar
-- por supuesta en ninguna de las dos direcciones.
--
-- Una policy que exige un permiso SIN FILA en `permissions` no es una lectura
-- acotada: es una lectura cerrada a todo el mundo con aspecto de estar
-- configurada. Sin error de sintaxis, sin aviso, y sin una sola fila devuelta.
-- La comprobación es de tres líneas y convierte ese fallo silencioso en una
-- migración que no aplica, así que se paga:
-- =============================================================================

do $$
begin
  if not exists (select 1 from public.permissions where key = 'fiscal.audit.read') then
    raise exception
      'LADINO_PERMISO_FANTASMA: audit_events_select exige el permiso '
      'fiscal.audit.read y no hay fila en public.permissions. Una policy sobre '
      'un permiso que nadie puede tener cierra la lectura a todo el mundo con '
      'aspecto de estar configurada.'
      using errcode = 'LAD27';
  end if;
end;
$$;


-- =============================================================================
-- 6. Privilegios de tabla — la capa que actúa ANTES de la RLS
--
-- `anon` no recibe nada.
-- `authenticated` recibe SELECT y nada más.
-- `service_role` recibe SELECT e INSERT y NADA MÁS: ni UPDATE, ni DELETE, ni
--    TRUNCATE. Tiene BYPASSRLS, pero los GRANT sí le aplican.
--
-- Esto hace que la inmutabilidad tenga DOS capas independientes también frente
-- a service_role: primero le falta el privilegio (42501), y si alguien se lo
-- concediera, el trigger sigue ahí (LAD06). El test comprueba LAS DOS por
-- separado — concediendo el privilegio a propósito dentro de la transacción de
-- prueba para poder llegar al trigger. Si solo se probara el estado final,
-- «falla» sería indistinguible de «falla por el motivo equivocado», y el día
-- que alguien concediera el UPDATE nos quedaríamos sin defensa creyendo tener dos.
-- =============================================================================

revoke all on public.audit_events from anon, authenticated, service_role;

grant select                 on public.audit_events to authenticated;
grant select, insert         on public.audit_events to service_role;


-- =============================================================================
-- 7. RLS
-- =============================================================================

alter table public.audit_events enable  row level security;
alter table public.audit_events force   row level security;

-- SELECT: dentro de mis tenants, y solo en las companies donde tengo
-- `fiscal.audit.read`.
--
-- `company_id is not null` es una DENEGACIÓN DELIBERADA, no un descuido: los
-- eventos de nivel tenant no son legibles por authenticated. El motivo es el
-- mismo que ADR-0025 §9 dio para las escrituras de nivel tenant — las cuatro
-- funciones `ladino_*` resuelven permisos POR COMPANY y no existe una función
-- de permiso a nivel de tenant. La alternativa tentadora, `company_id is null
-- or has_permission(...)`, haría visibles los eventos de tenant a CUALQUIER
-- miembro del tenant sin permiso ninguno: no es abrir menos, es abrir más.
create policy audit_events_select on public.audit_events
  for select to authenticated
  using (
    tenant_id in (select platform.ladino_tenant_ids())
    and company_id is not null
    and platform.ladino_has_permission('fiscal.audit.read', company_id)
  );

-- Las tres escrituras: denegación ESCRITA, no ausencia de policy. Una policy
-- ausente es indistinguible de un olvido; una que dice `false` es una decisión
-- que alguien tomó y firmó (ADR-0025 §9, y el episodio de las quince policies
-- del RBAC que estuve a punto de borrar tomándolas por un agujero).
create policy audit_events_insert on public.audit_events
  for insert to authenticated
  with check (false);

create policy audit_events_update on public.audit_events
  for update to authenticated
  using (false);

create policy audit_events_delete on public.audit_events
  for delete to authenticated
  using (false);

comment on policy audit_events_select on public.audit_events is
  'Acotada por tenant Y por fiscal.audit.read en la company. Los eventos de '
  'nivel tenant (company_id NULL) quedan fuera: no hay función de permiso a '
  'nivel de tenant (ADR-0025 §5). Pasan por la API con service_role.';
comment on policy audit_events_insert on public.audit_events is
  'Denegación deliberada: la auditoría la escribe el caso de uso con '
  'service_role, dentro de su transacción (ADR-0026 D2). Que un cliente no '
  'pueda fabricar eventos de auditoría es el punto entero de la tabla.';
comment on policy audit_events_update on public.audit_events is
  'Denegación deliberada: append-only (ADR-0006). Segunda capa: reject_mutation().';
comment on policy audit_events_delete on public.audit_events is
  'Denegación deliberada: append-only (ADR-0006). Segunda capa: reject_mutation().';

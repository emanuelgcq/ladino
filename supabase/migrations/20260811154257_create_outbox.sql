-- =============================================================================
-- Ladino — 2/4 de S0.4 · `outbox`, publicación transaccional de efectos
--
-- Módulo:         outbox (S0.4)
-- Spec:           ADR-0005 (outbox transaccional), ADR-0026 (D3, D6, D7),
--                 ADR-0025 §6, EVENT_CATALOG.md §schema version
-- Reversibilidad: SÍ. drop table public.outbox cascade;
--                 A diferencia de audit_events, esta tabla es de TRABAJO: sus
--                 filas se consumen y su pérdida es un incidente operativo, no
--                 una falsificación de pista de auditoría. Reversible incluso
--                 con datos, aceptando que se pierden efectos sin publicar.
-- HOMOLOGATION_IMPACT: YES (ADR-0005 está marcado impacto fiscal SÍ)
--
-- Segunda de cuatro. Depende de S0.3 y NO de `audit_events`.
--
-- QUÉ ES: la mitad transaccional del patrón. El caso de uso escribe su efecto y
-- encola aquí EN LA MISMA TRANSACCIÓN; si el commit falla, no hay evento
-- huérfano, y si el commit va, el evento está garantizado. Lo que NO garantiza
-- es cuándo ni cuántas veces se entrega: at-least-once, y todo consumidor es
-- idempotente (ADR-0005). Ese contrato no se relaja aquí.
--
-- NO ES APPEND-ONLY (ADR-0026 D7). ADR-0006 no la lista, y con razón: necesita
-- UPDATE por diseño para marcar estado e incrementar intentos. Prohibírselo la
-- dejaría inservible — una defensa que cierra el único camino autorizado.
-- =============================================================================


-- =============================================================================
-- 1. La tabla
-- =============================================================================

create table public.outbox (
  id              uuid        primary key default platform.uuidv7(),

  -- Anclas de aislamiento. Mismo criterio que audit_events: tenant_id sin
  -- excepción, company_id nullable para efectos de nivel tenant.
  tenant_id       uuid        not null,
  company_id      uuid,

  -- De qué habla el evento.
  aggregate_type  text        not null,
  aggregate_id    uuid        not null,
  event_type      text        not null,

  -- `EVENT_CATALOG.md` §30 exige que cada evento lleve su versión de esquema.
  -- Sin ella, un consumidor desplegado después no puede distinguir un payload
  -- viejo de uno nuevo y tiene que adivinar por su forma — que es exactamente
  -- el fallo que ADR-0019 (expand/contract) existe para evitar.
  schema_version  integer     not null,
  payload         jsonb       not null default '{}'::jsonb,

  -- Estado del trabajo. Los valores los fija ADR-0026 D6 porque NINGÚN
  -- documento los enumeraba, y `ENGINEERING_STANDARDS.md` §64 exige CHECK sobre
  -- todo estado: los estados viven en el esquema, no solo en TypeScript.
  status          text        not null default 'pending',
  attempts        integer     not null default 0,
  available_at    timestamptz not null default now(),
  last_error      text,
  published_at    timestamptz,

  -- Procedencia, gobernada por platform.set_row_provenance(). Aquí `version` NO
  -- es columna muerta: la tabla se actualiza, y sirve de concurrencia optimista.
  created_by      uuid,
  created_at      timestamptz not null,
  version         integer     not null,

  constraint outbox_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint outbox_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),

  constraint outbox_status_chk
    check (status in ('pending', 'in_flight', 'published', 'dead')),

  constraint outbox_event_type_chk
    check (event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint outbox_aggregate_type_chk
    check (aggregate_type ~ '^[a-z][a-z0-9_]*$'),
  constraint outbox_schema_version_chk
    check (schema_version >= 1),
  constraint outbox_attempts_chk
    check (attempts >= 0),

  -- COHERENCIA ESTADO/DATO. Sin esto, `published` sin `published_at` y `dead`
  -- sin `last_error` son estados representables, y un panel de operaciones que
  -- filtre por published_at daría un recuento distinto al que filtra por
  -- status. Dos fuentes de verdad para el mismo hecho acaban divergiendo.
  --
  -- Y hace algo más de lo que se escribió para hacer, comprobado con pgbench:
  -- ES UN DETECTOR DE CARRERA ACTIVO. Si dos workers se llevan la misma fila,
  -- el segundo intenta devolver a `in_flight` una fila que el primero ya dejó
  -- con `published_at` puesto, y este CHECK aborta la transacción antes de que
  -- el estado corrupto llegue a existir. En `scripts/outbox-concurrency.mjs
  -- --roto` es el PRIMERO en disparar, antes que el contador `attempts` de la
  -- propia prueba. Quitarlo no relaja una comprobación de higiene: desarma la
  -- defensa principal contra la doble toma.
  constraint outbox_published_coherence_chk
    check ((status = 'published') = (published_at is not null)),
  constraint outbox_dead_coherence_chk
    check (status <> 'dead' or last_error is not null)
);

comment on table public.outbox is
  'Publicación transaccional de efectos (ADR-0005). El caso de uso encola aquí '
  'en la MISMA transacción que su efecto. Entrega at-least-once: el consumidor '
  'es idempotente, siempre. No es append-only (ADR-0026 D7): necesita UPDATE '
  'para marcar estado.';

comment on column public.outbox.available_at is
  'No antes de esta hora. Es el backoff: un reintento la empuja al futuro. '
  'ADR-0005 pide exponencial con jitter; los parámetros los fija el worker '
  '(S0.6), no el esquema.';
comment on column public.outbox.status is
  'pending → in_flight → published | dead. `dead` es un ESTADO, no una tabla '
  'aparte: reprocesar es un UPDATE y no mover filas entre tablas (ADR-0026 D6).';
comment on column public.outbox.schema_version is
  'Versión del esquema del payload (EVENT_CATALOG.md). Un consumidor nuevo '
  'tiene que poder distinguir un payload viejo sin adivinar por su forma.';


-- =============================================================================
-- 2. Índices
--
-- El índice que importa es el de la TOMA DE TRABAJO, y es parcial a propósito.
-- Un índice sobre todo `status` degenera: `published` crece sin límite y
-- `pending` es un puñado de filas. El parcial solo indexa lo que está por
-- hacer, así que su tamaño depende del ATRASO, no del histórico.
-- =============================================================================

create index outbox_pickup_idx
  on public.outbox (available_at, id)
  where status = 'pending';

comment on index public.outbox_pickup_idx is
  'Para la toma de trabajo con FOR UPDATE SKIP LOCKED. Parcial sobre pending: '
  'su tamaño depende del atraso, no del histórico publicado.';

-- Reintentos en vuelo: encontrar lo que un worker muerto dejó colgado.
create index outbox_in_flight_idx
  on public.outbox (created_at)
  where status = 'in_flight';

-- Cola de fallos, para el panel de operaciones.
create index outbox_dead_idx
  on public.outbox (tenant_id, id desc)
  where status = 'dead';

-- Trazar los eventos de un agregado concreto.
create index outbox_aggregate_idx
  on public.outbox (tenant_id, aggregate_type, aggregate_id, id desc);


-- =============================================================================
-- 3. Los bloqueantes heredados de S0.3
--
-- Aquí van DOS de los tres: procedencia y anclas. `reject_mutation()` NO, por
-- ADR-0026 D7 — la tabla se actualiza por diseño.
-- =============================================================================

create trigger outbox_provenance
  before insert or update on public.outbox
  for each row execute function platform.set_row_provenance();

-- El nombre sigue la convención `%_anchors_immutable`, pero lo que hace que el
-- test de 006 lo encuentre es la FUNCIÓN, no el nombre: desde S0.4 esa
-- comprobación mira `tgfoid`. El nombre es para quien lea el esquema.
create trigger outbox_anchors_immutable
  before update on public.outbox
  for each row execute function platform.assert_isolation_anchors_immutable();


-- =============================================================================
-- 4. Privilegios
--
-- `authenticated` y `anon` no reciben NADA. El outbox es fontanería: ningún
-- cliente tiene por qué verlo, y menos escribirlo — encolar un evento a mano es
-- fabricar un efecto que nadie autorizó.
--
-- `service_role` sí, incluido UPDATE: es quien encola (caso de uso) y quien
-- consume (worker). DELETE también, porque la purga de publicados es una tarea
-- operativa real y sin ella la tabla crece sin límite. TRUNCATE no: vaciar el
-- outbox entero es perder efectos sin publicar, y eso no debe ser un descuido
-- de una línea.
-- =============================================================================

revoke all on public.outbox from anon, authenticated, service_role;

grant select, insert, update, delete on public.outbox to service_role;


-- =============================================================================
-- 5. RLS
--
-- Con cero privilegios para `authenticated`, la RLS aquí no protege de nadie:
-- el 42501 llega antes. Se pone igual, y con las cuatro denegaciones ESCRITAS,
-- por dos razones concretas:
--
--   1. `rls-security-auditor` y el test 004 comprueban como PROPIEDAD que no
--      hay tabla en `public` sin RLS forzada ni sin policy. Una excepción
--      «porque aquí no hace falta» convierte una propiedad verificable en una
--      lista de casos que alguien tiene que recordar.
--   2. El día que alguien conceda un GRANT amplio —y ocurre— la RLS es lo único
--      que queda. Depender de que el privilegio nunca cambie es depender de que
--      nadie se equivoque.
--
-- Es `CLAUDE.md` §2 aplicado: ausencia de mecanismo no es prohibición.
-- =============================================================================

alter table public.outbox enable row level security;
alter table public.outbox force  row level security;

create policy outbox_select on public.outbox
  for select to authenticated
  using (false);

create policy outbox_insert on public.outbox
  for insert to authenticated
  with check (false);

create policy outbox_update on public.outbox
  for update to authenticated
  using (false);

create policy outbox_delete on public.outbox
  for delete to authenticated
  using (false);

comment on policy outbox_select on public.outbox is
  'Denegación deliberada: el outbox no es un producto para el usuario. Lo que '
  'el usuario debe ver del estado de un efecto se expone como estado del '
  'agregado, no como fila de la cola.';
comment on policy outbox_insert on public.outbox is
  'Denegación deliberada: encolar a mano es fabricar un efecto que ningún caso '
  'de uso autorizó. Solo service_role, dentro de la transacción del efecto.';
comment on policy outbox_update on public.outbox is
  'Denegación deliberada: el avance de estado es del worker.';
comment on policy outbox_delete on public.outbox is
  'Denegación deliberada: la purga es tarea operativa, no de usuario.';

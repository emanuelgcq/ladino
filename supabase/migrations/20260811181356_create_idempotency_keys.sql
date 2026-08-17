-- =============================================================================
-- Ladino — 3/4 de S0.4 · `idempotency_keys`
--
-- Módulo:         idempotencia (S0.4)
-- Spec:           ADR-0018, ADR-0026 (D3, D4, D5, D6, D7), API_SPEC.md §135-142,
--                 FISCAL_DOCUMENTS_SPEC.md §60 (100 reintentos, un documento)
-- Reversibilidad: SÍ. drop table public.idempotency_keys cascade;
--                 Con datos, la pérdida abre una ventana de reproceso: las
--                 claves en vuelo dejan de deduplicar. No es corrupción, es
--                 riesgo de efecto duplicado mientras dure la ventana.
-- HOMOLOGATION_IMPACT: YES (ADR-0018 está marcado impacto fiscal SÍ)
--
-- Tercera de cuatro. Depende de S0.3. Independiente de audit_events y outbox.
--
-- LO QUE ESTA TABLA HACE CUMPLIR: regla 4 de CLAUDE.md — toda operación crítica
-- es idempotente. El criterio de aceptación fiscal es literal: «100 reintentos
-- de una misma idempotency key producen un solo documento».
--
-- LO QUE NO DECIDE, y es de S0.5: el formato de la clave, el TTL concreto, el
-- código de estado del replay, y la canonicalización del `request_hash`. Este
-- esquema deja esas decisiones POSIBLES sin tomarlas — que no es lo mismo que
-- olvidarlas.
-- =============================================================================


create table public.idempotency_keys (
  id              uuid        primary key default platform.uuidv7(),

  -- `tenant_id` lo exige la regla 5 de CLAUDE.md y ADR-0025 §2. ADR-0018 definió
  -- la tabla solo con `company_id`, y es anterior: ADR-0026 D4 lo corrige. Sin
  -- esta columna, además, assert_isolation_anchors_immutable() no tiene nada que
  -- comparar y el test de 006 haría fallar S0.4 solo.
  tenant_id       uuid        not null,
  company_id      uuid,

  key             text        not null,
  endpoint        text        not null,

  -- Huella del cuerpo de la petición. La calcula la API, no la base: el cuerpo
  -- HTTP no está aquí. La CANONICALIZACIÓN es de S0.5 y no es un detalle —sin
  -- forma canónica, dos cuerpos semánticamente iguales dan hashes distintos y
  -- producen 409 espurios sobre peticiones correctas.
  request_hash    bytea       not null,

  -- La respuesta original, para devolverla en un replay. Nullable porque
  -- mientras la operación está en vuelo todavía no existe.
  response        jsonb,

  status          text        not null default 'in_progress',

  -- Sin DEFAULT a propósito. ADR-0018 §22 deja la retención pendiente («mínimo
  -- 24 h») y poner aquí un `now() + interval '24 hours'` sería TOMAR esa
  -- decisión disfrazándola de detalle de esquema. Que sea obligatorio y sin
  -- valor por defecto obliga a la API a elegir, que es donde corresponde.
  expires_at      timestamptz not null,

  created_by      uuid,
  created_at      timestamptz not null,
  version         integer     not null,

  constraint idempotency_keys_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint idempotency_keys_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),

  constraint idempotency_keys_status_chk
    check (status in ('in_progress', 'completed', 'failed')),

  -- Cota de longitud. NO es una decisión de contrato —el formato de la clave es
  -- de S0.5— sino infraestructura: `key` entra en un índice btree, y un btree
  -- rechaza entradas de más de ~2700 bytes con un error que aparecería en
  -- producción con la primera clave larga que mande un cliente.
  constraint idempotency_keys_key_len_chk
    check (length(key) between 1 and 255),
  constraint idempotency_keys_endpoint_len_chk
    check (length(endpoint) between 1 and 255),

  -- COHERENCIA ESTADO/DATO, en las dos direcciones.
  --
  -- `completed` sin respuesta es el peor estado representable de esta tabla: un
  -- replay encontraría la clave, concluiría que ya se hizo, y devolvería NADA.
  -- El cliente vería un éxito vacío sobre una operación que sí ocurrió.
  constraint idempotency_keys_completed_chk
    check (status <> 'completed' or response is not null),
  -- Y al revés: mientras está en vuelo no puede haber respuesta guardada, o el
  -- replay devolvería una respuesta a medio construir.
  constraint idempotency_keys_in_progress_chk
    check (status <> 'in_progress' or response is null),

  -- Una clave que caduca antes de existir no deduplica nada. Funciona porque
  -- set_row_provenance() es BEFORE ROW y llena `created_at` antes de que se
  -- evalúen los CHECK.
  constraint idempotency_keys_expiry_chk
    check (expires_at > created_at)
);

comment on table public.idempotency_keys is
  'Deduplicación de operaciones críticas por clave de cliente (ADR-0018). La '
  'clave se persiste DENTRO de la transacción del caso de uso: un replay no '
  'reejecuta el cuerpo, así que tampoco reinserta en el outbox. Regla 4 de '
  'CLAUDE.md.';

comment on column public.idempotency_keys.endpoint is
  'Se guarda pero NO entra en el índice único (ADR-0026 D5): sirve para que el '
  '409 pueda decir qué endpoint reclamó la clave primero.';
comment on column public.idempotency_keys.status is
  'in_progress → completed | failed. `in_progress` existe para el caso que la '
  'documentación no cubría y que en producción pasa a diario: la misma clave '
  'llega mientras la primera sigue en vuelo.';
comment on column public.idempotency_keys.expires_at is
  'Sin DEFAULT deliberadamente: la retención sigue pendiente en ADR-0018 §22 y '
  'un default la decidiría por la puerta de atrás.';
comment on column public.idempotency_keys.request_hash is
  'Huella del cuerpo, calculada por la API. La canonicalización es de S0.5: sin '
  'forma canónica, dos cuerpos iguales dan 409 espurios.';


-- =============================================================================
-- El índice único, y el detalle que lo hace funcionar
--
-- Alcance `(tenant_id, company_id, key)`. `endpoint` NO entra (ADR-0026 D5): si
-- entrara, un cliente que reusa la clave en otro endpoint obtendría DOS efectos
-- —dos facturas, dos pagos— y ninguno parecería un error. Fuera, obtiene un
-- 409, que es ruidoso y no genera un documento fiscal de más.
--
-- ⚠  `NULLS NOT DISTINCT` NO ES ADORNO Y NO ES OPCIONAL.
--
-- `company_id` es nullable: hay operaciones de nivel tenant. En SQL, NULL no es
-- igual a NULL, así que un UNIQUE ordinario **deja pasar tantas claves
-- repetidas como se quiera** mientras `company_id` sea NULL — sin error, sin
-- aviso, sin una sola señal. La idempotencia quedaría rota exactamente en las
-- operaciones de nivel tenant y nadie se enteraría hasta ver dos efectos.
--
-- Es ausencia de fallo leída como éxito (ADR-0023). El test 010 no comprueba el
-- caso fácil: ejerce el caso NULL, y además QUITA la cláusula a propósito para
-- ver que sin ella el duplicado entra.
-- =============================================================================

create unique index idempotency_keys_scope_uq
  on public.idempotency_keys (tenant_id, company_id, key)
  nulls not distinct;

comment on index public.idempotency_keys_scope_uq is
  'NULLS NOT DISTINCT es imprescindible: company_id es nullable y un UNIQUE '
  'ordinario no deduplica NULLs, dejando pasar claves repetidas en silencio en '
  'las operaciones de nivel tenant. ADR-0026 D5.';

-- Para la purga por caducidad. Parcial: lo que ya está resuelto y caducado es
-- lo único purgable, y es lo que crece.
create index idempotency_keys_expiry_idx
  on public.idempotency_keys (expires_at)
  where status <> 'in_progress';


-- =============================================================================
-- Bloqueantes heredados de S0.3. Sin reject_mutation(): la tabla se actualiza
-- por diseño (in_progress → completed), y ADR-0006 no la lista.
-- =============================================================================

create trigger idempotency_keys_provenance
  before insert or update on public.idempotency_keys
  for each row execute function platform.set_row_provenance();

create trigger idempotency_keys_anchors_immutable
  before update on public.idempotency_keys
  for each row execute function platform.assert_isolation_anchors_immutable();


-- =============================================================================
-- Privilegios y RLS
--
-- Igual que el outbox: fontanería. `authenticated` no recibe nada, y la
-- prohibición va ESCRITA en policies, no dejada a la ausencia. Ver el comentario
-- largo de la migración del outbox para las dos razones.
-- =============================================================================

revoke all on public.idempotency_keys from anon, authenticated, service_role;

grant select, insert, update, delete on public.idempotency_keys to service_role;

alter table public.idempotency_keys enable row level security;
alter table public.idempotency_keys force  row level security;

create policy idempotency_keys_select on public.idempotency_keys
  for select to authenticated
  using (false);

create policy idempotency_keys_insert on public.idempotency_keys
  for insert to authenticated
  with check (false);

create policy idempotency_keys_update on public.idempotency_keys
  for update to authenticated
  using (false);

create policy idempotency_keys_delete on public.idempotency_keys
  for delete to authenticated
  using (false);

comment on policy idempotency_keys_select on public.idempotency_keys is
  'Denegación deliberada: leer las claves ajenas permitiría adivinar qué '
  'operaciones ha hecho otro usuario del tenant.';
comment on policy idempotency_keys_insert on public.idempotency_keys is
  'Denegación deliberada: reservar una clave a mano bloquearía la operación '
  'legítima de otro. La escribe el middleware con service_role (S0.5).';
comment on policy idempotency_keys_update on public.idempotency_keys is
  'Denegación deliberada: marcar `completed` a mano con una respuesta falsa '
  'haría que el replay devolviera esa respuesta.';
comment on policy idempotency_keys_delete on public.idempotency_keys is
  'Denegación deliberada: borrar una clave reabre la ventana de duplicado. La '
  'purga es tarea operativa.';

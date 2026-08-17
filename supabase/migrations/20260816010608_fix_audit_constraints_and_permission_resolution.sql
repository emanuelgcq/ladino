-- =============================================================================
-- Ladino — 5/5 de S0.4 · Correcciones de la auditoría de cierre
--
-- Módulo:         auditoría, outbox, idempotencia, identidad fiscal (S0.4)
-- Spec:           ADR-0026, ADR-0028, EVENT_CATALOG.md, ADR-0018 (enmendado)
-- Reversibilidad: SÍ. Todo son constraints, un índice y dos funciones. Restaurar
--                 los CHECK anteriores es escribir otra migración — pero no se
--                 debe: los anteriores rechazan la emisión fiscal (ver 1).
-- HOMOLOGATION_IMPACT: YES
--
-- Corrige lo que encontraron `rls-security-auditor` y `fiscal-reviewer` al
-- cerrar S0.4. Ninguno de estos defectos lo detectaron los 316 tests: todos
-- pasaban porque los tests usaban datos que evitaban el caso malo sin querer.
--
-- Las migraciones aplicadas no se editan (ADR-0019). Esta las corrige encima.
-- =============================================================================


-- =============================================================================
-- 1. ALTO-1 — el CHECK de `event_type` rechaza LOS SIETE EVENTOS FISCALES
--
-- El CHECK original exige EXACTAMENTE dos segmentos: '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
-- `docs/04_PLATFORM/EVENT_CATALOG.md` define los eventos fiscales con TRES:
--
--     fiscal.invoice.issuing      fiscal.invoice.issued     fiscal.invoice.failed
--     fiscal.credit_note.issued   fiscal.debit_note.issued
--     fiscal.contingency.started  fiscal.contingency.ended
--
-- Consecuencia si no se corrige: el día que la Fase 11 emita la primera
-- factura, ni la fila de auditoría ni el evento de outbox entran — y como
-- ambos van DENTRO de la transacción del caso de uso (ADR-0026 D2, ADR-0005),
-- lo que revienta no es el log: es la emisión.
--
-- Por qué no lo cazó nadie: ADR-0026 D10 escribió la forma sin contrastarla
-- contra el catálogo, y los tests 008/009 usan nombres inventados de dos
-- segmentos. Es el error de `fiscal.audit.read` en la otra dirección: la
-- documentación y el esquema son dos fuentes, y esta vez la que se quedó atrás
-- fue el esquema.
--
-- La forma nueva admite N segmentos, que es la que ya usaba el catálogo de
-- permisos desde S0.3 (`supplier.bank_account.approve`).
-- =============================================================================

alter table public.audit_events drop constraint audit_events_event_type_chk;
alter table public.audit_events add  constraint audit_events_event_type_chk
  check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');

alter table public.outbox drop constraint outbox_event_type_chk;
alter table public.outbox add  constraint outbox_event_type_chk
  check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');


-- =============================================================================
-- 2. ALTO-2 — `occurred_at <= created_at` compara contra el reloj equivocado
--
-- `created_at` lo pone set_row_provenance() con now(), que es la hora de INICIO
-- DE TRANSACCIÓN. Cualquier timestamp real tomado después del BEGIN es mayor.
-- Reproducido: un INSERT con occurred_at = clock_timestamp() tras 50 ms de
-- trabajo falla con 23514. Con 1 ms de deriva NTP entre el app server y
-- Postgres, también.
--
-- Es decir: la única forma de escribir auditoría era que la API mandase la hora
-- de arranque de la transacción de la BASE — justo el dato que `occurred_at` no
-- debe llevar, porque ADR-0026 D8 lo justifica por el modo offline: es dato del
-- CLIENTE. Y con el commit compartido de D2, el rechazo aborta el hecho de
-- negocio, no solo la auditoría.
--
-- El razonamiento original sobre el orden de disparo era correcto —los BEFORE
-- ROW van antes que los CHECK, y por eso `created_at` ya tiene valor cuando
-- esto se evalúa—. Lo que estaba mal es el RELOJ contra el que se compara.
--
-- TOLERANCIA: 30 segundos hacia el futuro. No es una cifra bonita, es la
-- respuesta a una pregunta concreta: ¿cuánta deriva de reloj entre el app
-- server y Postgres se acepta antes de considerar que el cliente miente? Con
-- NTP funcionando, la deriva es de milisegundos; 30 s absorbe un NTP degradado
-- sin llegar a admitir un timestamp inventado. Hacia el PASADO no hay cota, y
-- es deliberado: en modo offline el hecho pudo ocurrir hace días.
-- =============================================================================

alter table public.audit_events drop constraint audit_events_occurred_at_chk;
alter table public.audit_events add  constraint audit_events_occurred_at_chk
  check (occurred_at <= created_at + interval '30 seconds');

comment on constraint audit_events_occurred_at_chk on public.audit_events is
  'Tolerancia de 30 s hacia el futuro: absorbe deriva de reloj entre el app '
  'server y Postgres (created_at es now(), la hora de INICIO de transacción), '
  'sin admitir un occurred_at inventado. Hacia el pasado no hay cota: el modo '
  'offline permite que el hecho sea de hace días.';


-- =============================================================================
-- 3. MEDIO-2 — el hash devuelve NULL y colisiona entre tipos jsonb
--
-- `payload #>> '{}'` no es inyectivo sobre jsonb. Reproducido:
--
--   platform.audit_payload_hash('null'::jsonb)                    -> NULL
--   platform.audit_payload_hash('{"a": 1}'::jsonb)
--     = platform.audit_payload_hash(to_jsonb('{"a": 1}'::text))   -> true
--
-- Lo primero hace que `payload_hash` viole su NOT NULL con un error engañoso
-- («null value in column payload_hash») que aborta la transacción de negocio.
-- Lo segundo es una colisión construible en una línea: un objeto y la cadena
-- que deletrea su texto comparten huella.
--
-- Un CHECK cierra los dos casos POR LA TABLA. Y conviene ser exacto sobre qué
-- consigue y qué no, porque las dos cosas se midieron:
--
--   · La función SIGUE colisionando sobre jsonb arbitrario. El CHECK no la
--     arregla: hace que uno de los dos operandos de la colisión no se pueda
--     almacenar, así que los dos lados no pueden coexistir en la tabla. Es una
--     garantía más débil que «la función es inyectiva», y se documenta como tal.
--   · La función NO se corrige a propósito: `payload_hash` es una columna
--     generada STORED, y cambiar el cuerpo de la función NO recalcula las filas
--     ya escritas. Una función «mejorada» dejaría hashes históricos que nadie
--     puede reproducir — el modo de fallo que la auditoría marcó como MEDIO-3.
--   · Para el escalar `null`, el error que sale sigue siendo 23502 sobre
--     `payload_hash`, no el 23514 de este CHECK: **las columnas generadas se
--     calculan ANTES de evaluar los CHECK**. Es el orden CONTRARIO al de los
--     triggers BEFORE ROW, que sí van antes (y en el que se apoya el CHECK de
--     `occurred_at`). Dos reglas de orden opuestas en la misma tabla; no se
--     deduce una de la otra.
--
-- Con todo, restringir a objetos es además la forma correcta del dato: un
-- payload de evento es un objeto, no un escalar.
-- =============================================================================

alter table public.audit_events add constraint audit_events_payload_object_chk
  check (jsonb_typeof(payload) = 'object');

alter table public.outbox add constraint outbox_payload_object_chk
  check (jsonb_typeof(payload) = 'object');

comment on constraint audit_events_payload_object_chk on public.audit_events is
  'Restringir a objetos no es higiene: sobre jsonb arbitrario, `payload #>> ''{}''` '
  'devuelve NULL para el escalar `null` (y rompe el NOT NULL de payload_hash con '
  'un error engañoso) y colisiona entre un objeto y la cadena que deletrea su '
  'texto. Sobre objetos es inyectivo y total.';


-- =============================================================================
-- 4. MEDIO-1 — la «capa 2» de M4 estaba inerte en el único camino real
--
-- El trigger de M4 condicionaba la comprobación de permiso a `auth.uid() is not
-- null`. Pero `authenticated` ya no puede disparar el trigger —le falta el
-- privilegio de columna sobre tax_id, comprobado sin escape en la auditoría— así
-- que la ÚNICA vía real es service_role, donde `auth.uid()` es NULL.
--
-- Resultado: la fila de auditoría afirmaba «el usuario X cambió el RIF» sin que
-- la base comprobase nada sobre X. Se confiaba en el GUC para ATRIBUIR y no
-- para AUTORIZAR, y «dos capas» solo era cierto en un camino cerrado.
--
-- La causa raíz es que `ladino_has_permission()` resuelve contra `auth.uid()` y
-- no acepta un usuario. Se añade la variante parametrizada y se redefine la
-- original EN TÉRMINOS DE ELLA, para que exista UNA sola copia de la resolución
-- RBAC. Dos copias divergen; siempre.
--
-- ⚠ `create or replace` es un reemplazo COMPLETO: repite `stable`,
--   `security definer` y `set search_path` aunque solo cambie el cuerpo. Es la
--   lección MEDIO-2 de la migración 6/6 de S0.3, donde perder `proconfig` dejó
--   una función sin el pin de search_path.
-- =============================================================================

create or replace function platform.ladino_user_has_permission(
  p_user       uuid,
  p_permission text,
  p_company_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.companies c
      join public.memberships m
        on m.tenant_id = c.tenant_id
       and m.user_id   = p_user
       and m.status    = 'active'
      join public.user_role_assignments ura
        on ura.membership_id = m.id
       and (ura.company_id = c.id or ura.company_id is null)
      join public.roles r
        on r.id = ura.role_id
      join public.role_permissions rp
        on rp.role_id = r.id
       and rp.permission_key = p_permission
     where c.id = p_company_id
       and (
             not r.requires_scope
          -- ADR-0025 §4: un rol acotado SIN bindings no opera nada. Aquí la
          -- pregunta es "¿puede hacer esto en algún sitio de esta company?",
          -- así que basta con que exista al menos un binding en ella.
          or exists (
               select 1
                 from public.scope_bindings sb
                where sb.assignment_id = ura.id
                  and sb.company_id    = c.id
             )
       )
  );
$$;

comment on function platform.ladino_user_has_permission(uuid, text, uuid) is
  'Resolución RBAC parametrizada por usuario. Es la implementación ÚNICA: '
  'ladino_has_permission() delega aquí pasando auth.uid(). Existe porque el '
  'camino de servidor (service_role + GUC ladino.actor_id) no tiene auth.uid() '
  'y necesitaba poder autorizar, no solo atribuir.';

revoke execute on function platform.ladino_user_has_permission(uuid, text, uuid) from public;
grant  execute on function platform.ladino_user_has_permission(uuid, text, uuid) to authenticated;

-- La original pasa a delegar. Misma firma, mismo comportamiento observable.
create or replace function platform.ladino_has_permission(
  p_permission text,
  p_company_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select platform.ladino_user_has_permission(auth.uid(), p_permission, p_company_id);
$$;

comment on function platform.ladino_has_permission(text, uuid) is
  'Permiso del usuario del JWT sobre una company. Delega en '
  'ladino_user_has_permission(auth.uid(), …) para que la resolución RBAC tenga '
  'UNA sola implementación. ADR-0025 §5.';

revoke execute on function platform.ladino_has_permission(text, uuid) from public;
grant  execute on function platform.ladino_has_permission(text, uuid) to authenticated;


-- =============================================================================
-- 5. F-3 y MEDIO-1 — el trigger de M4: alta del RIF y autorización real
--
-- DOS correcciones sobre `platform.audit_tax_id_change()`:
--
-- (a) F-3 — el RIF INICIAL no dejaba ningún evento. El trigger era `after
--     update of tax_id`, así que crear una company con su RIF no registraba
--     nada, y R-04 difiere el catálogo de eventos, de modo que tampoco hay caso
--     de uso que lo audite. La identidad fiscal bajo la que se emitirían los
--     primeros documentos no tenía UNA SOLA FILA en audit_events. Es el mismo
--     defecto que M4 vino a corregir, un paso más arriba.
--
-- (b) MEDIO-1 — el permiso se comprueba ahora contra el actor COALESCIDO, con
--     la función parametrizada. El camino de servidor pasa a autorizar de
--     verdad, no solo a atribuir.
--
-- Sobre el alta NO se exige `company.tax_id.manage`: crear una company ya exige
-- `company.manage`, y pedir además el permiso del RIF haría imposible dar de
-- alta una empresa — cerrar el camino autorizado, otra vez. En el alta el RIF
-- se ESTABLECE; en el update se CAMBIA, que es la operación que M4 controla.
--
-- Hacen falta DOS triggers y no uno: Postgres no admite `WHEN (old...)` en un
-- trigger de INSERT, porque OLD no existe ahí.
-- =============================================================================

create or replace function platform.audit_tax_id_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  v_actor := coalesce(
    auth.uid(),
    nullif(current_setting('ladino.actor_id', true), '')::uuid
  );

  -- Solo en el CAMBIO. En el alta, el RIF se establece junto con la company y
  -- el permiso que gobierna esa operación es `company.manage`.
  if tg_op = 'UPDATE'
     and v_actor is not null
     and not platform.ladino_user_has_permission(
               v_actor, 'company.tax_id.manage', new.id) then
    raise exception
      'LADINO_RIF_SIN_PERMISO: cambiar el RIF de una empresa exige el permiso '
      'company.tax_id.manage, que es distinto de company.manage. El RIF '
      'identifica al contribuyente ante el SENIAT.'
      using errcode = 'LAD29',
            hint = 'Conceda company.tax_id.manage en la company, o realice el '
                   'cambio por el caso de uso de la API.';
  end if;

  insert into public.audit_events
    (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
     actor_type, occurred_at, rules_version, payload)
  values
    (new.tenant_id, new.id, 'company', new.id,
     case when tg_op = 'INSERT' then 'company.tax_id_established'
                                else 'company.tax_id_changed' end,
     case when v_actor is null then 'system' else 'user' end,
     now(),
     coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-guard'),
     jsonb_build_object(
       -- En el alta no hay anterior, y se dice con NULL explícito en vez de
       -- omitir la clave: un consumidor que lea el payload distingue «no había»
       -- de «no se registró».
       'tax_id_anterior', case when tg_op = 'INSERT' then null else old.tax_id end,
       'tax_id_nuevo',    new.tax_id,
       'legal_name',      new.legal_name
     ));

  return null;
end;
$$;

comment on function platform.audit_tax_id_change() is
  'M4: registra en audit_events el ESTABLECIMIENTO y todo CAMBIO de '
  'companies.tax_id, con el valor anterior. En el cambio exige '
  'company.tax_id.manage contra el actor coalescido (JWT o GUC), no solo contra '
  'auth.uid(). Excepción consciente a ADR-0026 D2, justificada allí.';

revoke execute on function platform.audit_tax_id_change() from public;

create trigger companies_audit_tax_id_insert
  after insert on public.companies
  for each row
  execute function platform.audit_tax_id_change();

comment on trigger companies_audit_tax_id_insert on public.companies is
  'Alta: registra el RIF con el que nace la company. Sin esto, la identidad '
  'fiscal bajo la que se emiten los primeros documentos no tiene rastro, y '
  'reconstruirla a posteriori es inferencia (F-3 de la auditoría de S0.4).';


-- =============================================================================
-- 6. ALTO-3 — la clave de idempotencia no tenía actor en su alcance
--
-- El único era `(tenant_id, company_id, key)`. Dos usuarios de la MISMA company
-- que usen la misma clave chocan, y las dos ramas son malas:
--
--   · mismo cuerpo  -> por contrato la API devuelve la respuesta guardada: el
--                      segundo usuario recibe la respuesta del PRIMERO —datos
--                      de otro— y su operación no se ejecuta, con un 200.
--   · cuerpo distinto -> 409 sobre una operación correcta.
--
-- Y permite a un insider pre-reservar claves para bloquear a otro.
--
-- Es intra-tenant, no cross-tenant. Lo que obliga a arreglarlo AHORA es que el
-- esquema no dejaba arreglarlo en S0.5: no había columna por la que acotar.
--
-- `created_by` ya existe y lo gobierna set_row_provenance(). `NULLS NOT
-- DISTINCT` sigue cubriendo el caso de company de nivel tenant, y ahora también
-- el de `created_by` NULL —trabajo de servidor sin actor—, que sin la cláusula
-- volvería a dejar pasar duplicados en silencio.
--
-- Adenda a ADR-0026 D5: D5 razonó sobre `endpoint` y no sobre el actor.
-- =============================================================================

drop index public.idempotency_keys_scope_uq;

create unique index idempotency_keys_scope_uq
  on public.idempotency_keys (tenant_id, company_id, created_by, key)
  nulls not distinct;

comment on index public.idempotency_keys_scope_uq is
  'Alcance: tenant + company + ACTOR + clave. El actor entra porque dos usuarios '
  'de la misma company con la misma clave se pisaban: el segundo recibía la '
  'respuesta del primero y su operación no se ejecutaba. NULLS NOT DISTINCT '
  'cubre company de nivel tenant y actor de servidor. ADR-0026 D5 + adenda.';

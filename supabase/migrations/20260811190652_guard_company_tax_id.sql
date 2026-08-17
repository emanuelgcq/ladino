-- =============================================================================
-- Ladino — 4/4 de S0.4 · M4: el RIF deja de ser texto libre sin rastro
--
-- Módulo:         identidad fiscal del contribuyente (S0.4)
-- Spec:           HANDOFF.md §M4, ADR-0026, ADR-0025 §9,
--                 SENIAT_ART121_CONTROL_MATRIX.md (trazabilidad, integridad)
-- Reversibilidad: SÍ mientras no haya cambios de RIF registrados.
--                 drop trigger companies_audit_tax_id on public.companies;
--                 drop function platform.audit_tax_id_change();
--                 grant update (tax_id) on public.companies to authenticated;
--                 delete from public.permissions where key = 'company.tax_id.manage';
--                 Las filas de audit_events que deje NO se revierten: son
--                 append-only, y ese es el punto.
-- HOMOLOGATION_IMPACT: YES
--
-- Cuarta y última de S0.4. Depende de `audit_events` (1/4).
--
-- EL PROBLEMA, tal como quedó escrito en el handoff de S0.3:
-- `companies.tax_id` es texto libre que cualquiera con `company.manage`
-- reescribe, sin rastro, y es quien identifica al contribuyente en los
-- documentos emitidos. Editar el nombre comercial y reescribir el RIF costaban
-- exactamente lo mismo.
--
-- LO QUE ESTA MIGRACIÓN NO HACE: validar el FORMATO del RIF. No está en
-- `docs/02_COMPLIANCE/` con fuente citada. **VALIDAR-SENIAT.** Inventar aquí un
-- `check (tax_id ~ '^[VEJPG]-\d{8}-\d$')` sería inventar una obligación legal,
-- y una migración aplicada no se edita: el día que el formato real no encaje,
-- el error estaría escrito en piedra.
-- =============================================================================


-- =============================================================================
-- 1. Permiso propio. Cambiar el RIF no es editar el nombre comercial.
--
-- `company.manage` cubre el alta y la modificación de una empresa: nombre,
-- nombre comercial, estado. Son datos de gestión, y equivocarse se arregla con
-- otro UPDATE.
--
-- El RIF no es un dato de gestión: es QUIÉN ES el contribuyente ante el SENIAT.
-- Un RIF equivocado no se arregla con otro UPDATE, porque para entonces ya se
-- emitieron documentos a nombre de otro. Merece un permiso que pocos tengan, y
-- que se pueda auditar por separado: «quién puede cambiar el RIF» debe ser una
-- pregunta con respuesta corta.
-- =============================================================================

insert into public.permissions (key, description, is_scoped) values
  ('company.tax_id.manage',
   'Modificar el RIF de la empresa. Identifica al contribuyente ante el SENIAT',
   false);


-- =============================================================================
-- 2. Capa 1 — `authenticated` pierde el privilegio sobre la columna
--
-- Desde 5/6, `authenticated` tiene UPDATE por columna sobre
-- (legal_name, trade_name, tax_id, status). Se le retira `tax_id`.
--
-- Consecuencia deliberada: el cambio de RIF NO se puede hacer por PostgREST,
-- ni siquiera teniendo el permiso nuevo. Pasa por la API con service_role,
-- igual que todo el bloque RBAC (ADR-0025 §9). El motivo es el mismo que allí:
-- una operación que hay que poder explicar ante una fiscalización merece pasar
-- por una capa donde se pueda exigir contexto, no por un PATCH genérico.
--
-- El resto de columnas siguen como estaban: esto no cierra ningún otro camino.
-- =============================================================================

revoke update (tax_id) on public.companies from authenticated;


-- =============================================================================
-- 3. Capa 2 — el trigger: permiso comprobado y rastro con el VALOR ANTERIOR
--
-- ⚠  EXCEPCIÓN CONSCIENTE A ADR-0026 D2, y por eso va explicada.
--
-- ADR-0026 decidió que la auditoría la escribe el CASO DE USO, no un trigger, y
-- descartó los triggers con este argumento: «un trigger ve la fila, no la
-- intención; sabe que `invoices` cambió, no si fue una emisión, una anulación o
-- una corrección». El argumento sigue siendo bueno y sigue vigente para la
-- auditoría de negocio.
--
-- Aquí no aplica, por dos razones concretas:
--
--   1. En este caso la intención SÍ está determinada por el dato. `tax_id` pasó
--      de X a Y: no hay otra lectura posible del hecho, y `event_type` no
--      depende de qué quería hacer el llamante.
--   2. M4 existe precisamente porque la capa de aplicación NO lo registraba.
--      Una red que depende de que el caso de uso se acuerde es la que ya falló.
--
-- Así que esto NO sustituye a la auditoría del caso de uso: es la RED del
-- esquema, la misma lógica de dos capas que se usa en todo el proyecto. El caso
-- de uso escribirá su propio evento, más rico; este garantiza que el rastro
-- existe aunque no lo haga.
--
-- Y el rastro lleva el VALOR ANTERIOR. Un evento que dice «se modificó tax_id»
-- sin el valor previo no responde la pregunta que se hará en una fiscalización,
-- que no es «¿cambió?» sino «¿bajo qué RIF se emitió esto?».
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

  -- Capa 2 del permiso. La condición es `auth.uid()`, NO el actor coalescido, y
  -- la diferencia no es cosmética: `platform.ladino_has_permission()` resuelve
  -- los memberships contra `auth.uid()` y NO conoce el GUC `ladino.actor_id`.
  --
  -- Condicionarlo al actor coalescido cerraba el camino del servidor: con el
  -- GUC puesto y sin JWT, `v_actor` no es NULL, la función devuelve `false`
  -- porque no ve usuario, y el cambio legítimo de RIF quedaba prohibido para
  -- todo el mundo — con todas las aserciones de negación en verde. Lo cazó el
  -- test 011 al ejercer el camino autorizado en vez de darlo por supuesto.
  --
  -- Así que: si hay JWT de usuario (camino authenticated, o service_role
  -- actuando con los claims del usuario puestos), se exige el permiso aquí.
  -- Si no lo hay, esto es trabajo de servidor puro y quien responde por el
  -- permiso es la API. Esa es la frontera, y es la misma que ADR-0025 §9 usa
  -- para todo el bloque RBAC.
  if auth.uid() is not null
     and not platform.ladino_has_permission('company.tax_id.manage', new.id) then
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
    (new.tenant_id, new.id, 'company', new.id, 'company.tax_id_changed',
     case when v_actor is null then 'system' else 'user' end,
     now(),
     -- Si el caso de uso declaró su versión de reglas, se respeta. Si no, queda
     -- marcado como lo que es: una fila escrita por la red del esquema, no por
     -- un caso de uso versionado. Mentir aquí con un '0.0' inventado haría
     -- indistinguibles las dos procedencias.
     coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-guard'),
     jsonb_build_object(
       'tax_id_anterior', old.tax_id,
       'tax_id_nuevo',    new.tax_id,
       'legal_name',      new.legal_name
     ));

  return null;   -- AFTER trigger: el valor de retorno se ignora
end;
$$;

comment on function platform.audit_tax_id_change() is
  'M4: registra en audit_events todo cambio de companies.tax_id CON EL VALOR '
  'ANTERIOR, y exige company.tax_id.manage cuando hay contexto de usuario. '
  'Excepción consciente a ADR-0026 D2 (la auditoría la escribe el caso de uso): '
  'aquí la intención está determinada por el dato, y M4 existe porque la capa '
  'de aplicación no lo registraba. Es red del esquema, no sustituto.';

revoke execute on function platform.audit_tax_id_change() from public;

create trigger companies_audit_tax_id
  after update of tax_id on public.companies
  for each row
  when (old.tax_id is distinct from new.tax_id)
  execute function platform.audit_tax_id_change();

comment on trigger companies_audit_tax_id on public.companies is
  'El `when` filtra por cambio REAL: un UPDATE que reescribe tax_id con el '
  'mismo valor no genera evento. `is distinct from` y no `<>` para que un NULL '
  'no haga desaparecer la comparación en silencio.';


-- =============================================================================
-- 4. Los documentos ya emitidos bajo el RIF anterior
--
-- DECISIÓN, escrita aquí porque es donde se buscará:
--
-- **El RIF de un documento fiscal es el VIGENTE AL EMITIR, no el actual de la
-- company.** Un documento emitido no se edita ni se borra (regla 1 de
-- CLAUDE.md), y eso incluye no reinterpretarlo: si la factura se emitió con
-- J-12345678-9, esa factura sigue siendo de J-12345678-9 aunque la company de
-- hoy tenga otro RIF. Lo contrario —resolver el RIF por JOIN contra `companies`
-- al imprimir o al declarar— haría que un documento inmutable CAMBIARA de
-- contribuyente retroactivamente con un solo UPDATE. Sería editar el pasado sin
-- tocar una sola fila del pasado.
--
-- Esta migración NO toca ningún documento: no existen todavía, y si existieran
-- serían inmutables.
--
-- REQUISITO QUE SE HEREDA A LA FASE 11: las tablas de documentos fiscales deben
-- llevar el RIF del emisor COPIADO en el documento, no referenciado. Es una
-- columna, no un JOIN. Queda registrado en RISK_REGISTER.md como R-05, con
-- dueño y disparador, para que no se descubra sin decidir cuando ya haya
-- documentos emitidos — que es cuando deja de tener arreglo barato.
-- =============================================================================

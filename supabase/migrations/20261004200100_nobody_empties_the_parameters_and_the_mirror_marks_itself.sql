-- =============================================================================
-- Ladino — NADIE VACÍA LOS PARÁMETROS, Y EL ESPEJO SE RECONOCE POR SU MARCA
-- (arreglos de la re-revisión de 20261004200000; regla 8 de CLAUDE.md; ADR-0075 §6)
--
-- Módulo: auditoría de plataforma (el margen de la tasa oficial). Rigor máximo.
-- Spec:   docs/04_PLATFORM/MONEY_AND_ROUNDING_SPEC.md · ADR-0075 (nota «ola 4 · una sola regla
--         de la tasa del día») · RISK_REGISTER R-85.
-- Reversible: SÍ en esquema (ver al final); las actas escritas quedan (append-only).
-- HOMOLOGATION_IMPACT: NO — no cambia ningún documento, libro, asiento, cifra ni regla. No sube
--   el semver de las reglas (ADR-0079): `platform.parameters` conserva sus filas y sus valores,
--   y el hash de reglas no lee triggers.
--
-- Qué pasaba.
--   1. `TRUNCATE platform.parameters` no dejaba acta: `parameters_a_record` (20261004200000) es
--      un trigger DE FILA y TRUNCATE no los dispara. La tabla quedaba vacía sin rastro, y sin el
--      margen `platform.rate_for` no devuelve ninguna tasa: toda conversión se detiene.
--   2. El acta reconocía la escritura espejo del alias con `pg_trigger_depth() > 1`. Eso es
--      «estoy dentro de algún trigger», no «soy el espejo»: un cambio del margen hecho desde el
--      trigger de CUALQUIER otra tabla quedaba etiquetado `mirrored_from`, como el eco de una
--      decisión que no existió.
--
-- Qué cambia.
--   1. Trigger de SENTENCIA `parameters_no_truncate` (BEFORE TRUNCATE): lo rechaza con un mensaje
--      que dice por qué y qué hacer. Ausencia de mecanismo no es prohibición (CLAUDE.md §2).
--   2. El trigger espejo pone una marca propia antes de escribir —el GUC local
--      `ladino.parameter_mirror_of`, con la clave de la que es eco— y la retira al terminar. El
--      acta lee la marca; la profundidad ya no decide nada.
--
-- Funciones que redefine, desde su definición VIVA en el orden limpio de timestamps:
--   · platform.mirror_official_rate_age()  — única definición: 20261004195900.
--   · platform.record_parameter_change()   — única definición: 20261004200000.
-- Ninguna migración posterior a esta las toca (comprobado contra 20261004205000 y 20261004205200).
-- Lee solo objetos anteriores: `platform.parameters` (20261003210000), sus dos triggers
-- (20261004195900 y 20261004200000) y `public.system_audit_events` (20261004120000).
-- No crea tablas: no hay RLS, ancla ni policies nuevas que escribir.
-- =============================================================================

-- ── 1. Nadie vacía los parámetros ────────────────────────────────────────────
create function platform.reject_parameters_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'LADINO_PARAMETERS_TRUNCATE: platform.parameters no se vacía. Sin sus parámetros la regla de la tasa del día (platform.rate_for) no devuelve ninguna tasa y toda conversión se detiene. Para retirar un parámetro, bórralo por su clave: deja acta.'
    using errcode = '0A000';
end;
$$;
revoke all on function platform.reject_parameters_truncate() from public;
comment on function platform.reject_parameters_truncate() is
  'Rechaza TRUNCATE sobre platform.parameters (SQLSTATE 0A000). TRUNCATE no dispara los triggers '
  'de fila: vaciaría la tabla sin acta (parameters_a_record no lo ve) y dejaría a '
  'platform.rate_for sin margen, es decir, sin tasa para nadie. Quitar este trigger reabre las '
  'dos cosas.';

create trigger parameters_no_truncate
  before truncate on platform.parameters
  for each statement execute function platform.reject_parameters_truncate();

-- ── 2. El espejo pone su marca ───────────────────────────────────────────────
-- Parte de la definición VIVA (20261004195900). Diferencia: pone la marca antes de escribir y la
-- devuelve a lo que valía al terminar. Los triggers AFTER de la fila espejo corren al final de
-- ESA sentencia —dentro de esta función, entre las dos llamadas a set_config—, así que ven la
-- marca. `set_config(..., true)` es local a la transacción y se deshace con ella (o con el
-- savepoint) si la escritura falla: la marca no sobrevive a un error.
create or replace function platform.mirror_official_rate_age()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_antes text := coalesce(pg_catalog.current_setting('ladino.parameter_mirror_of', true), '');
begin
  perform pg_catalog.set_config('ladino.parameter_mirror_of', new.key, true);
  -- `is distinct from` es lo que detiene la recursión: el espejo solo escribe si hay diferencia.
  update platform.parameters p
     set value = new.value, updated_at = new.updated_at
   where p.key = case new.key when 'official_rate_max_age_days' then 'closing_rate_max_age_days'
                              else 'official_rate_max_age_days' end
     and p.value is distinct from new.value;
  perform pg_catalog.set_config('ladino.parameter_mirror_of', v_antes, true);
  return null;
end;
$$;
comment on function platform.mirror_official_rate_age() is
  'El alias del margen de la tasa oficial: official_rate_max_age_days (el dato que lee '
  'platform.rate_for) y closing_rate_max_age_days (su nombre hasta la ola 3) valen siempre lo '
  'mismo. Quitar este trigger antes de retirar el nombre viejo deja a quien todavía lo escribe '
  'cambiando un dato que ninguna regla lee. Mientras escribe la otra fila deja puesta la marca '
  'ladino.parameter_mirror_of (la clave de la que es eco): es lo que platform.record_parameter_change '
  'lee para decir mirrored_from. Quitar la marca deja las actas del espejo sin etiquetar.';
revoke execute on function platform.mirror_official_rate_age() from public;

-- ── 3. El acta lee la marca, no la profundidad ───────────────────────────────
-- Parte de la definición VIVA (20261004200000 §3). Única diferencia: cómo se reconoce el espejo.
create or replace function platform.record_parameter_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_old numeric;
  v_new numeric;
  v_nota boolean := false;
  v_espejo text;
  v_marca text;
begin
  if tg_op = 'INSERT' then
    v_key := new.key; v_new := new.value;
  elsif tg_op = 'DELETE' then
    v_key := old.key; v_old := old.value;
  else
    if new.key is not distinct from old.key and new.value is not distinct from old.value
       and new.note is not distinct from old.note then
      return null;  -- no cambió nada que decir (solo `updated_at`)
    end if;
    v_key := new.key; v_old := old.value; v_new := new.value;
    v_nota := new.note is distinct from old.note;
  end if;

  -- LA ESCRITURA ESPEJO SE RECONOCE POR SU MARCA. El trigger del alias la pone mientras escribe
  -- la otra fila, con la clave de la que es eco. Solo vale si esa clave es LA OTRA del par: un
  -- cambio hecho desde el trigger de cualquier otra tabla no lleva marca, y no es espejo aunque
  -- corra a profundidad 2 (antes se miraba `pg_trigger_depth() > 1`).
  v_marca := coalesce(pg_catalog.current_setting('ladino.parameter_mirror_of', true), '');
  if (v_key = 'official_rate_max_age_days' and v_marca = 'closing_rate_max_age_days')
     or (v_key = 'closing_rate_max_age_days' and v_marca = 'official_rate_max_age_days') then
    v_espejo := v_marca;
  end if;

  insert into public.system_audit_events
    (aggregate_type, aggregate_id, event_type, occurred_at, payload)
  values ('platform_parameter',
          -- El acta pide un uuid y el parámetro se identifica por su clave: uno estable por clave.
          pg_catalog.md5('platform.parameters:' || v_key)::uuid,
          'platform.parameter_changed', pg_catalog.now(),
          pg_catalog.jsonb_build_object(
            'key', v_key,
            'operation', pg_catalog.lower(tg_op),
            'old_value', v_old::text,
            'new_value', v_new::text,
            'previous_key', case when tg_op = 'UPDATE' and new.key is distinct from old.key
                                 then old.key end,
            'note_changed', v_nota,
            'mirrored_from', v_espejo,
            'written_by_role', session_user::text));
  return null;
end;
$$;
revoke all on function platform.record_parameter_change() from public;
comment on function platform.record_parameter_change() is
  'Acta de plataforma (system_audit_events, platform.parameter_changed) de cada alta, cambio o '
  'baja de platform.parameters: clave, valor anterior y nuevo, y el rol que lo escribió. El '
  'margen de la tasa oficial vive ahí y de él depende toda conversión: quitar este trigger deja '
  'cambiarlo sin rastro. La escritura espejo del alias deja su propia acta con mirrored_from, y '
  'se reconoce por la marca ladino.parameter_mirror_of que pone platform.mirror_official_rate_age '
  '—no por la profundidad de triggers—. TRUNCATE no pasa por aquí: lo rechaza parameters_no_truncate.';

-- =============================================================================
-- AUDITORÍA DE ESTA MIGRACIÓN (una corrección es una migración entera: CLAUDE.md §3)
--   · Datos: no toca ninguna fila. `platform.parameters` tiene hoy dos (el margen y su alias).
--   · La marca es un GUC de sesión que cualquiera puede escribir. No abre nada: solo quien puede
--     escribir `platform.parameters` (hoy, `postgres`) llega al acta, y una marca falsa solo
--     etiqueta `mirrored_from` si además nombra LA OTRA clave del par. La marca no autoriza ni
--     salta ningún control; decide una etiqueta descriptiva del acta.
--   · Orden de los triggers de fila en la escritura espejo: `parameters_a_record` (lee la marca)
--     corre antes que `parameters_official_rate_age_alias` (que la sobrescribe con la otra clave
--     y la devuelve a lo que valía). Si un día se reordenaran, el acta del espejo saldría sin
--     etiqueta: el pgTAP 131 lo mide en las dos direcciones.
--   · `zz_rule_set_state` (AFTER … OR TRUNCATE, de sentencia) ya no llega a correr en un
--     TRUNCATE: el BEFORE lo aborta antes. En INSERT/UPDATE/DELETE no cambia nada.
--   · Restaurar una copia: `pg_restore --clean` de datos usa DELETE/COPY o DROP+CREATE de la
--     tabla, no TRUNCATE de `platform.parameters`. `supabase db reset` recrea la base. Una
--     herramienta que sí trunque (`pg_restore --data-only --disable-triggers`, `TRUNCATE …
--     CASCADE` desde otra tabla) recibirá el error salvo que deshabilite triggers: no verificado
--     contra el procedimiento de restore del proveedor.
--
-- REVERSIBILIDAD (con datos vivos)
--   · Esquema: `drop trigger parameters_no_truncate on platform.parameters; drop function
--     platform.reject_parameters_truncate();` y otra migración con los cuerpos de
--     `mirror_official_rate_age` (20261004195900) y `record_parameter_change` (20261004200000).
--     Ninguna función guarda estado.
--   · Lo que NO se deshace: las actas `platform.parameter_changed` ya escritas (append-only).
--     Las escritas ENTRE 20261004200000 y esta migración pueden llevar un `mirrored_from` puesto
--     por la profundidad: no se corrigen (no se actualiza un acta); se leen sabiendo esto.
--   · Ningún dato existente cambia: no hay backfill ni reescritura.
--
-- CON LA API HOY DESPLEGADA: compatible. La API no escribe ni trunca `platform.parameters` (solo
-- la lee, por `platform.rate_for`). Va en la misma ventana que 20261004195900 y 20261004200000,
-- JUSTO DESPUÉS del git pull, porque depende de las dos y aquellas lo exigen; por sí sola no
-- añade ninguna restricción de orden.
-- =============================================================================

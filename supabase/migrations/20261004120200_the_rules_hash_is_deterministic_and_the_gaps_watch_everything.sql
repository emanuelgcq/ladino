-- Módulo: auditoría y versión de reglas   ADR: docs/00_GOVERNANCE/adr/ADR-0079-*.md
-- Revisión en contexto limpio de la 20261004120000 (misma entrega): H1, S1, H2, H3, S2, H4, S4.
-- Reversible: SÍ en el esquema; las versiones registradas y las filas selladas se quedan.
-- Homologación: YES (cambia qué reglas entran en la versión que congela cada documento fiscal).
--
-- EXPAND: redefine funciones propias de la 20261004120000 y añade triggers y columnas. La API
-- desplegada no las llama directamente.
--
--   H1  El hash dependía del huso de la sesión: `to_jsonb` serializa una `timestamptz`
--       (company_fiscal_regimes.effective_from) con el `TimeZone` vigente. Las dos funciones que
--       serializan fijan `timezone = 'UTC'` en su definición.
--   S1  El orden del hash usaba la colación por omisión: ahora `collate "C"` (bytes).
--   H2  `system_audit_events` conservaba REFERENCES, TRIGGER y TRUNCATE para service_role (los
--       privilegios por omisión de Supabase), que tiene BYPASSRLS.
--   H3  `rules_version_gaps` solo miraba `documents`. Ahora mira TODA tabla de public con
--       `rules_version`, y las cadenas de sistema (db-guard, db-migration…) dejan de ser un
--       perdón implícito: se REGISTRAN, con su clase. Un solo enunciado.
--   S2  El corte se compara con `created_at` (instante contra instante), no con `issued_at`.
--   H4  Entran en el hash las reglas que faltaban (IGTF por instrumento, exenciones, catálogo de
--       alícuotas, ajustes fiscales y umbrales de la empresa, su calendario propio).
--   S4  Las funciones del hash leen tablas con RLS forzada como su dueño: si ese rol no tiene
--       BYPASSRLS leerían cero filas en silencio. Ahora fallan ruidosamente.
--
-- QUÉ PASA CON LO YA REGISTRADO. El hash de TODAS las empresas cambia con esta migración (entran
-- tablas nuevas y cambia el orden). Las versiones registradas antes siguen en
-- `platform.rules_versions` —es append-only— y las filas que las llevan no se tocan: son
-- versiones que existieron bajo la definición anterior del hash. Lo que se escriba desde aquí
-- lleva la nueva. Por eso sube la versión semántica (1.1.0): el cambio de definición del hash es
-- un cambio de lógica, y así una versión 1.0.0+… y una 1.1.0+… no se comparan hash con hash.
-- `platform.rule_set_state` se recalcula al final: `rule_set_drift()` queda en cero.

-- ════════════════════════════════════════════════════════════════════════════
-- H2 · privilegios exactos del acta de plataforma
-- ════════════════════════════════════════════════════════════════════════════
revoke all on public.system_audit_events from service_role, ladino_worker;

-- ════════════════════════════════════════════════════════════════════════════
-- H3 · el registro admite versiones DECLARADAS de sistema
-- ════════════════════════════════════════════════════════════════════════════
alter table platform.rules_versions
  add column kind text not null default 'rules',
  add column note text,
  alter column semver drop not null,
  alter column rules_hash drop not null,
  drop constraint rules_versions_shape_chk;

alter table platform.rules_versions
  add constraint rules_versions_kind_chk check (kind in ('rules', 'system')),
  add constraint rules_versions_shape_chk check (
    (kind = 'rules' and semver is not null and rules_hash is not null
       and version = semver || '+' || left(rules_hash, 16))
    or
    (kind = 'system' and semver is null and rules_hash is null
       and position('+' in version) = 0 and length(btrim(coalesce(note, ''))) >= 10));

comment on column platform.rules_versions.kind is
  '`rules` = semver + hash, la congela platform.stamp_rules_version. `system` = una cadena DECLARADA por algo que no es un caso de uso (un trigger de la base, una migración, una reparación): dice quién escribió, no con qué reglas. Se registra por migración, con su nota. Una cadena que no esté aquí pone rules_version_gaps en rojo.';

insert into platform.rules_versions (version, kind, note) values
  ('db-guard', 'system',
   'Un trigger de la base escribió el acta y ningún caso de uso había declarado su versión (GUC ladino.rules_version vacío).'),
  ('db-trigger', 'system',
   'Fila creada por un trigger de la base (p. ej. la subcuenta contable de una cuenta de tesorería).'),
  ('db-migration', 'system',
   'Fila escrita por una migración o por una función de la base que actúa sin caso de uso.'),
  ('db-repair', 'system',
   'Fila escrita por una función de reparación de la base (subcuentas de tesorería, céntimo, revalorización).'),
  ('repair-p02', 'system',
   'Reparación P-02 de los documentos y el libro (migraciones 20260928170000 y 20260928170100).'),
  ('regularizacion-ola2', 'system',
   'Regularización de inventario y caja de la ola 2 (scripts/ola2/regularizacion-inventario-y-caja.sql).');

-- ════════════════════════════════════════════════════════════════════════════
-- H1 · S1 · H4 · S4 · el hash
-- ════════════════════════════════════════════════════════════════════════════

-- S4: el dueño de estas funciones lee tablas con RLS FORZADA. Sin BYPASSRLS leería lo que le
-- dejen las policies —nada— y el hash saldría de cero reglas, sin un solo error.
create or replace function platform.assert_rules_reader_sees_all()
returns void
language plpgsql
stable
set search_path to ''
as $function$
begin
  if not coalesce((select r.rolbypassrls or r.rolsuper
                     from pg_catalog.pg_roles r where r.rolname = current_user), false) then
    raise exception
      'LADINO_RULES_HASH_BLIND: el rol % calcula el hash de reglas sin BYPASSRLS: leería cero '
      'reglas en silencio y toda versión sería la misma.', current_user
      using errcode = 'LAD00',
            hint = 'El dueño de platform.rules_global_hash y platform.current_rules_version '
                   'tiene que poder leer todas las tablas de reglas.';
  end if;
end;
$function$;

revoke all on function platform.assert_rules_reader_sees_all() from public;

create or replace function platform.rules_global_hash()
returns text
language plpgsql
stable
security definer
set search_path to ''
set timezone to 'UTC'
as $function$
declare
  v text;
begin
  perform platform.assert_rules_reader_sees_all();
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(
           pg_catalog.string_agg(
             f.t || '|' || f.k || '|'
               || ((f.j - array['created_at', 'created_by', 'version', 'updated_at'])::text),
             E'\n' order by f.t collate "C", f.k collate "C", (f.j::text) collate "C"), ''),
           'UTF8')), 'hex')
    into v
    from (
      select 'tax_calendar_entries'::text as t, r.id::text as k, pg_catalog.to_jsonb(r) as j
        from public.tax_calendar_entries r
      union all
      select 'tax_units', r.id::text, pg_catalog.to_jsonb(r) from public.tax_units r
      union all
      select 'igtf_rules', r.id::text, pg_catalog.to_jsonb(r) from public.igtf_rules r
      union all
      select 'igtf_instrument_classes', r.instrument, pg_catalog.to_jsonb(r)
        from public.igtf_instrument_classes r
      union all
      select 'igtf_exemptions', r.id::text, pg_catalog.to_jsonb(r) from public.igtf_exemptions r
      union all
      select 'iva_retention_portions', r.id::text, pg_catalog.to_jsonb(r)
        from public.iva_retention_portions r
      union all
      select 'retention_concepts', r.code::text, pg_catalog.to_jsonb(r)
        from public.retention_concepts r
      union all
      select 'retention_exclusions', r.code::text, pg_catalog.to_jsonb(r)
        from public.retention_exclusions r
      union all
      select 'tax_exemption_literals', r.code::text, pg_catalog.to_jsonb(r)
        from public.tax_exemption_literals r
      union all
      select 'tax_reduced_rate_literals', r.code::text, pg_catalog.to_jsonb(r)
        from public.tax_reduced_rate_literals r
      union all
      select 'tax_rule_templates', r.id::text, pg_catalog.to_jsonb(r)
        from public.tax_rule_templates r
      union all
      select 'fiscal_regimes', r.code::text, pg_catalog.to_jsonb(r) from public.fiscal_regimes r
      union all
      select 'parameters', r.key, pg_catalog.to_jsonb(r) from platform.parameters r
    ) f;
  return v;
end;
$function$;

create or replace function platform.current_rules_version(p_company uuid)
returns table (version text, semver text, rules_hash text)
language plpgsql
stable
security definer
set search_path to ''
set timezone to 'UTC'
as $function$
declare
  v_semver  text;
  v_global  text;
  v_company text;
  v_hash    text;
begin
  perform platform.assert_rules_reader_sees_all();
  select r.semver into v_semver
    from platform.rules_releases r
   order by pg_catalog.string_to_array(r.semver, '.')::int[] desc
   limit 1;
  select s.global_hash into v_global from platform.rule_set_state s where s.id;
  if v_semver is null or v_global is null then
    raise exception 'LADINO_RULES_VERSION: falta la versión semántica o el hash global de reglas.'
      using errcode = 'LAD00';
  end if;

  -- La parte de la empresa: las reglas que le aplican (globales y propias), su régimen, su tipo
  -- de contribuyente, qué instrumentos le causan IGTF, su calendario propio y, de sus ajustes,
  -- SOLO los que son regla o umbral (se leen por nombre del jsonb de la fila: el resto de
  -- company_settings —lista de precios, almacén, impresión— no es regla y no entra).
  -- `rules_version` y `actor_id` de company_taxpayer_types son procedencia, no regla.
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(
           pg_catalog.string_agg(
             f.t || '|' || f.k || '|'
               || ((f.j - array['created_at', 'created_by', 'version', 'updated_at',
                                'rules_version', 'actor_id'])::text),
             E'\n' order by f.t collate "C", f.k collate "C"), ''), 'UTF8')), 'hex')
    into v_company
    from (
      select 'tax_rules'::text as t, r.id::text as k, pg_catalog.to_jsonb(r) as j
        from public.tax_rules r
       where r.company_id is null or r.company_id = p_company
      union all
      select 'retention_rules', r.id::text, pg_catalog.to_jsonb(r)
        from public.retention_rules r
       where r.company_id is null or r.company_id = p_company
      union all
      select 'company_fiscal_regimes', r.id::text, pg_catalog.to_jsonb(r)
        from public.company_fiscal_regimes r
       where r.company_id = p_company
      union all
      select 'company_taxpayer_types', r.id::text, pg_catalog.to_jsonb(r)
        from public.company_taxpayer_types r
       where r.company_id = p_company
      union all
      select 'igtf_company_instruments', r.instrument, pg_catalog.to_jsonb(r)
        from public.igtf_company_instruments r
       where r.company_id = p_company
      union all
      select 'company_fiscal_deadlines', r.id::text, pg_catalog.to_jsonb(r)
        from public.company_fiscal_deadlines r
       where r.company_id = p_company
      union all
      select 'company_settings', 'rules',
             pg_catalog.jsonb_build_object(
               'absorb_igtf', s.j -> 'absorb_igtf',
               'retention_received_voucher_rate', s.j -> 'retention_received_voucher_rate',
               'four_eyes', s.j -> 'four_eyes',
               'supplier_payment_approval_threshold', s.j -> 'supplier_payment_approval_threshold',
               'supplier_payment_approval_currency', s.j -> 'supplier_payment_approval_currency')
        from (select pg_catalog.to_jsonb(r) as j from public.company_settings r
               where r.company_id = p_company) s
      union all
      select 'purchase_settings', 'rules',
             pg_catalog.jsonb_build_object(
               'price_tolerance_pct', s.j -> 'price_tolerance_pct',
               'retention_voucher_mode', s.j -> 'retention_voucher_mode')
        from (select pg_catalog.to_jsonb(r) as j from public.purchase_settings r
               where r.company_id = p_company) s
    ) f;

  v_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_global || '|' || v_company, 'UTF8')), 'hex');
  version := v_semver || '+' || pg_catalog.left(v_hash, 16);
  semver := v_semver;
  rules_hash := v_hash;
  return next;
end;
$function$;

revoke all on function platform.rules_global_hash() from public;
revoke all on function platform.current_rules_version(uuid) from public;

-- H4: los triggers de las tablas que entran ahora. Las globales recalculan el hash global; las
-- de empresa olvidan la versión recordada en la transacción.
do $crear$
declare
  t text;
begin
  foreach t in array array['igtf_instrument_classes', 'igtf_exemptions', 'tax_rule_templates']
  loop
    execute format(
      'create trigger %I after insert or update or delete or truncate on public.%I '
      'for each statement execute function platform.refresh_rule_set_state()',
      'zz_rule_set_state', t);
  end loop;
  foreach t in array array['igtf_company_instruments', 'company_fiscal_deadlines',
                           'company_settings', 'purchase_settings']
  loop
    execute format(
      'create trigger %I after insert or update or delete or truncate on public.%I '
      'for each statement execute function platform.forget_rules_version_cache()',
      'zz_rules_version_cache', t);
  end loop;
end
$crear$;

-- La definición del hash cambió: es un cambio de lógica y sube la versión semántica.
insert into platform.rules_releases (semver, note) values
  ('1.1.0', 'El hash fija huso UTC y colación C, y cubre IGTF por instrumento, exenciones, catálogo de alícuotas, ajustes fiscales y umbrales de la empresa (revisión de ADR-0079).');

-- Y el hash global guardado se recalcula con la definición nueva: rule_set_drift() en cero.
update platform.rule_set_state s
   set global_hash = platform.rules_global_hash(), computed_at = now()
 where s.id;

-- ════════════════════════════════════════════════════════════════════════════
-- H3 · S2 · el invariante mira todo lo que lleva versión
-- ════════════════════════════════════════════════════════════════════════════
drop function platform.rules_version_gaps(uuid);

create function platform.rules_version_gaps(p_company uuid)
returns table (table_name text, row_id uuid, rules_version text, problem text)
language plpgsql
stable
set search_path to ''
as $function$
declare
  v_since timestamptz;
  t       text;
begin
  -- ENUNCIADO: desde el corte (platform.invariant_cutoffs; se compara con `created_at`, un
  -- instante contra otro), en TODA tabla de public que lleva `rules_version`:
  --   (1) toda `rules_version` escrita está REGISTRADA en platform.rules_versions —sea la
  --       versión de reglas que congeló la base, sea una cadena de sistema declarada—;
  --   (2) todo documento fiscal emitido (factura, nota de crédito, nota de débito) lleva una;
  --   (3) todo asiento posteado o revertido lleva una.
  -- La lista de tablas sale del catálogo: no hay lista de excepciones.
  select c.since into v_since
    from platform.invariant_cutoffs c where c.invariant = 'rules_version_gaps';
  for t in
    select c.table_name::text
      from information_schema.columns c
      join information_schema.tables b
        on b.table_schema = c.table_schema and b.table_name = c.table_name
       and b.table_type = 'BASE TABLE'
     where c.table_schema = 'public' and c.column_name = 'rules_version'
     order by 1
  loop
    return query execute format(
      'select %L::text, x.id, x.rules_version::text, ''unregistered''::text '
      '  from public.%I x '
      ' where x.company_id = $1 and x.created_at >= $2 and x.rules_version is not null '
      '   and not exists (select 1 from platform.rules_versions v '
      '                    where v.version = x.rules_version)', t, t)
      using p_company, v_since;
  end loop;
  return query
    select 'documents'::text, d.id, null::text, 'issued_without_version'::text
      from public.documents d
     where d.company_id = p_company and d.created_at >= v_since
       and d.kind in ('invoice', 'credit_note', 'debit_note')
       and d.status in ('issued', 'paid', 'annulled')
       and d.rules_version is null;
  return query
    select 'journal_entries'::text, e.id, null::text, 'posted_without_version'::text
      from public.journal_entries e
     where e.company_id = p_company and e.created_at >= v_since
       and e.status in ('posted', 'reversed')
       and e.rules_version is null;
end;
$function$;

revoke all on function platform.rules_version_gaps(uuid) from public;

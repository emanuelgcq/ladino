-- Módulo: auditoría y versión de reglas   ADR: docs/00_GOVERNANCE/adr/ADR-0079-*.md
-- Segunda revisión en contexto limpio de la familia (20261004120000 a 120300): C1 a C7 y el
-- invariante de la tasa global.
-- Reversible: SÍ en el esquema (restituir las definiciones de 120000, 120200 y 120300); las filas
--   selladas desde aquí conservan su versión y el registro no se borra (append-only).
-- Homologación: YES (cambia qué versión de reglas congela cada documento fiscal y cada asiento).
--
-- EXPAND: redefine funciones de la propia familia y añade una. La API desplegada no las llama.
-- Va después de la 20261004195900 (que subió la versión semántica a 1.2.0) y no lee nada de una
-- migración posterior.
--
--   C1  `stamp_rules_version` daba por «registrada» cualquier fila del registro, también una
--       cadena de sistema: con la memoria de la transacción apuntando a `db-migration`, una fila
--       nacía con esa cadena y pasaba el invariante. Las comprobaciones exigen `kind = 'rules'`.
--   C3  Un documento fiscal y un movimiento contable llevan versión de REGLAS, nunca una cadena
--       de sistema (regla 3). En esas tablas el trigger sustituye todo lo que no sea una versión
--       de reglas registrada —nulo, `domain-s0.5`, `db-repair`, lo que sea— por la vigente. La
--       procedencia («lo escribió una reparación») no vive en `rules_version` ahí.
--   C4  La factura de proveedor posteada entra en el invariante.
--   C2  `sin-version` (platform.accept_member_invitation) se registra como cadena de sistema.
--   C5  Un invariante sin su corte no devuelve cero: revienta.
--   C7  `platform.parameters` entra en el hash global solo con su clave y su valor normalizado:
--       reescribir una nota ya no cambia la versión de todas las empresas, y 7 = 7.0.
--   +   `platform.global_rate_record_gaps()`: toda tasa global desde el corte tiene su acta.

-- ════════════════════════════════════════════════════════════════════════════
-- C2 · la séptima cadena de sistema
-- ════════════════════════════════════════════════════════════════════════════
insert into platform.rules_versions (version, kind, note) values
  ('sin-version', 'system',
   'platform.accept_member_invitation escribió el acta y ningún caso de uso había declarado su versión (GUC ladino.rules_version vacío). Significa lo mismo que db-guard.');

-- ════════════════════════════════════════════════════════════════════════════
-- C1 · C3 · el único sitio donde se congela la versión
-- (parte de la definición de 20261004120000)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function platform.stamp_rules_version()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  -- Documento fiscal o movimiento contable (regla 3): solo admite una versión de REGLAS.
  -- Una tabla nueva con `rules_version` que sea una de las dos cosas se añade AQUÍ y al
  -- enunciado de platform.rules_version_gaps.
  v_estricta boolean := tg_table_name in (
    'documents', 'supplier_invoices', 'retention_vouchers', 'supplier_retentions',
    'inventory_withdrawal_notes', 'journal_entries');
  v_key   text;
  v_cache text;
  v       text;
  v_estado text;
begin
  -- Lo que trae la fila: ¿es ya una versión de reglas registrada? Entonces se respeta.
  if new.rules_version is not null and new.rules_version <> 'domain-s0.5' then
    if exists (select 1 from platform.rules_versions r
                where r.version = new.rules_version and r.kind = 'rules') then
      return new;
    end if;
    -- En un acta, una cuenta o la historia del tipo de contribuyente, otra cadena es
    -- PROCEDENCIA (db-guard, db-migration…) y se deja; si no está registrada, lo dice el
    -- invariante. En un documento o un asiento no se admite: se sella.
    if not v_estricta then
      return new;
    end if;
  elsif new.rules_version is null and not v_estricta then
    return new;
  end if;

  -- Congelada es congelada: un UPDATE que vuelve a declarar no cambia la versión de reglas de
  -- una fila ya emitida. Un borrador (draft, confirmed, cancelled) todavía no congeló nada: al
  -- emitirse declara de nuevo y se sella con la versión del día en que se emite.
  if tg_op = 'UPDATE' and exists (
       select 1 from platform.rules_versions r
        where r.version = old.rules_version and r.kind = 'rules') then
    v_estado := pg_catalog.to_jsonb(old) ->> 'status';
    if v_estado is null or v_estado not in ('draft', 'confirmed', 'cancelled') then
      new.rules_version := old.rules_version;
      return new;
    end if;
  end if;

  -- Una transacción, una versión por empresa. La memoria es un GUC local que borra todo cambio
  -- de regla; solo vale si nombra una versión de REGLAS registrada (C1): escribir a mano una
  -- cadena de sistema en el GUC no hace nacer una fila con ella.
  v_key := coalesce(new.company_id::text, '-');
  v_cache := pg_catalog.current_setting('ladino.rules_version_cache', true);
  if v_cache is not null and pg_catalog.split_part(v_cache, '|', 1) = v_key then
    v := pg_catalog.split_part(v_cache, '|', 2);
    if exists (select 1 from platform.rules_versions r
                where r.version = v and r.kind = 'rules') then
      new.rules_version := v;
      return new;
    end if;
  end if;
  v := platform.freeze_rules_version(new.company_id);
  perform pg_catalog.set_config('ladino.rules_version_cache', v_key || '|' || v, true);
  new.rules_version := v;
  return new;
end;
$function$;

revoke all on function platform.stamp_rules_version() from public;

-- ════════════════════════════════════════════════════════════════════════════
-- C7 · el hash global (parte de la definición de 20261004120200)
-- ════════════════════════════════════════════════════════════════════════════
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
      -- El umbral es su clave y su valor; la nota es prosa y 7 = 7.0 (C7).
      select 'parameters', r.key,
             pg_catalog.jsonb_build_object('value', pg_catalog.trim_scale(r.value))
        from platform.parameters r
    ) f;
  return v;
end;
$function$;

revoke all on function platform.rules_global_hash() from public;

-- La definición del hash cambió: sube la versión semántica. Y BASTA UNA SUBIDA POR VENTANA DE
-- DESPLIEGUE que cambie lógica de reglas (ADR-0079): entre dos migraciones de la misma ventana
-- no puede emitirse ningún documento. Esta recoge, además, la lógica que la ola 4 cambió en
-- migraciones que no subieron versión.
insert into platform.rules_releases (semver, note) values
  ('1.3.0',
   'Hash: platform.parameters entra solo con clave y valor normalizado; en documentos y asientos solo vale una versión de reglas (20261004205000). '
   || 'Lógica de reglas de la ola 4 que no subió versión — 20261004110000: un recibo se devuelve con recibo de devolución y el contribuyente formal no vende gravado; '
   || '20261004140000: fiar exige permiso y límite de crédito; '
   || '20261004150000 y 20261004190000: el pago de más nace como saldo a favor, en su moneda y con su asiento; '
   || '20261004160000 y 20261004160100: una factura solo se anula el mismo día, antes del cierre de caja y sin haber salido, y la regla falla cerrada; '
   || '20261004170000 y 20261004170100: el gasto con factura es una compra de servicio (libro de compras, IVA y retención); '
   || '20261004180000 a 20261004180300: el sobregiro cubierto al cerrar la caja es un pasivo con el dueño, con origen y plantilla propios.');

update platform.rule_set_state s
   set global_hash = platform.rules_global_hash(), computed_at = now()
 where s.id;

-- ════════════════════════════════════════════════════════════════════════════
-- C3 · C4 · C5 · el invariante (parte de la definición de 20261004120200)
-- ════════════════════════════════════════════════════════════════════════════

-- El corte se mueve a esta migración: lo que el enunciado afirma lo garantiza el trigger de
-- arriba, y entre la 20261004120000 y esta (la misma ventana de despliegue) no se emite nada.
update platform.invariant_cutoffs
   set since = now(),
       reason = 'Antes de la entrega de ADR-0079 (migraciones 20261004120000 a 20261004205000) la versión de reglas era la cadena fija domain-s0.5 (B-06) y un documento o un asiento podía llevar una cadena de sistema. Un documento fiscal emitido no se edita (regla 1): los anteriores conservan la suya.'
 where invariant = 'rules_version_gaps';

create or replace function platform.rules_version_gaps(p_company uuid)
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
  -- instante contra otro):
  --   (1) en TODA tabla de public que lleva `rules_version` (la lista sale del catálogo), toda
  --       versión escrita está REGISTRADA en platform.rules_versions —sea una versión de reglas
  --       o una cadena de sistema declarada—;
  --   (2) todo documento fiscal EMITIDO y todo movimiento contable lleva una versión de REGLAS
  --       (`kind = 'rules'`), nunca una cadena de sistema ni nada:
  --         · `documents` en issued, paid o annulled, de toda clase;
  --         · `supplier_invoices` en posted, paid o annulled;
  --         · `retention_vouchers`, `supplier_retentions` e `inventory_withdrawal_notes`, todas;
  --         · `journal_entries` en posted o reversed.
  --       Estas seis tablas son las mismas que platform.stamp_rules_version sella.
  select c.since into v_since
    from platform.invariant_cutoffs c where c.invariant = 'rules_version_gaps';
  if v_since is null then
    raise exception
      'LADINO_INVARIANT_WITHOUT_CUTOFF: falta la fila rules_version_gaps en '
      'platform.invariant_cutoffs. Un invariante sin corte no puede afirmar cero.'
      using errcode = 'LAD00';
  end if;

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
    select 'documents'::text, d.id, d.rules_version, 'emitted_without_rules_version'::text
      from public.documents d
     where d.company_id = p_company and d.created_at >= v_since
       and d.status in ('issued', 'paid', 'annulled')
       and not exists (select 1 from platform.rules_versions v
                        where v.version = d.rules_version and v.kind = 'rules');
  return query
    select 'supplier_invoices'::text, s.id, s.rules_version, 'emitted_without_rules_version'::text
      from public.supplier_invoices s
     where s.company_id = p_company and s.created_at >= v_since
       and s.status in ('posted', 'paid', 'annulled')
       and not exists (select 1 from platform.rules_versions v
                        where v.version = s.rules_version and v.kind = 'rules');
  return query
    select 'retention_vouchers'::text, r.id, r.rules_version, 'emitted_without_rules_version'::text
      from public.retention_vouchers r
     where r.company_id = p_company and r.created_at >= v_since
       and not exists (select 1 from platform.rules_versions v
                        where v.version = r.rules_version and v.kind = 'rules');
  return query
    select 'supplier_retentions'::text, r.id, r.rules_version,
           'emitted_without_rules_version'::text
      from public.supplier_retentions r
     where r.company_id = p_company and r.created_at >= v_since
       and not exists (select 1 from platform.rules_versions v
                        where v.version = r.rules_version and v.kind = 'rules');
  return query
    select 'inventory_withdrawal_notes'::text, n.id, n.rules_version,
           'emitted_without_rules_version'::text
      from public.inventory_withdrawal_notes n
     where n.company_id = p_company and n.created_at >= v_since
       and not exists (select 1 from platform.rules_versions v
                        where v.version = n.rules_version and v.kind = 'rules');
  return query
    select 'journal_entries'::text, e.id, e.rules_version, 'posted_without_rules_version'::text
      from public.journal_entries e
     where e.company_id = p_company and e.created_at >= v_since
       and e.status in ('posted', 'reversed')
       and not exists (select 1 from platform.rules_versions v
                        where v.version = e.rules_version and v.kind = 'rules');
end;
$function$;

revoke all on function platform.rules_version_gaps(uuid) from public;

-- ════════════════════════════════════════════════════════════════════════════
-- Toda tasa global tiene su acta: el invariante que mira al trigger desde fuera
-- ════════════════════════════════════════════════════════════════════════════
insert into platform.invariant_cutoffs (invariant, since, reason) values
  ('global_rate_record_gaps', now(),
   'Antes de las migraciones 20261004120000 y 20261004120100 la tasa oficial se guardaba sin acta (B-14). El acta no se fabrica hacia atrás.');

create or replace function platform.global_rate_record_gaps()
returns table (rate_id uuid, rate_date date, source text)
language plpgsql
stable
set search_path to ''
as $function$
declare
  v_since timestamptz;
begin
  -- ENUNCIADO: toda tasa GLOBAL (company_id nulo) de public.exchange_rates creada desde el
  -- corte (platform.invariant_cutoffs, contra `created_at`) tiene su acta en
  -- public.system_audit_events: `fx.rate.captured` (la dejó el dominio, con URL, hora y hash) o
  -- `fx.rate.inserted_without_capture` (la dejó la base al cierre de la transacción).
  select c.since into v_since
    from platform.invariant_cutoffs c where c.invariant = 'global_rate_record_gaps';
  if v_since is null then
    raise exception
      'LADINO_INVARIANT_WITHOUT_CUTOFF: falta la fila global_rate_record_gaps en '
      'platform.invariant_cutoffs. Un invariante sin corte no puede afirmar cero.'
      using errcode = 'LAD00';
  end if;
  return query
    select r.id, r.rate_date, r.source
      from public.exchange_rates r
     where r.company_id is null and r.created_at >= v_since
       and not exists (
         select 1 from public.system_audit_events a
          where a.aggregate_type = 'exchange_rate' and a.aggregate_id = r.id
            and a.event_type in ('fx.rate.captured', 'fx.rate.inserted_without_capture'));
end;
$function$;

revoke all on function platform.global_rate_record_gaps() from public;

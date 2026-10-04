-- Módulo: auditoría y versión de reglas   ADR: docs/00_GOVERNANCE/adr/ADR-0079-*.md (nota de la
--   quinta pasada)   Riesgo: R-81
-- Quinta pasada de la familia (20261004120000 a 120300 y 205000): B1 y B3.
-- Reversible: SÍ en el esquema, también con datos vivos (restituir las dos definiciones de la
--   20261004205000). No escribe ni cambia ninguna fila. Lo que no se deshace: las filas que
--   mientras esté aplicada conserven una versión que la 205000 habría resellado, y las que al
--   revertir vuelvan a poder resellarse. En los dos sentidos, solo ante un UPDATE que nombre la
--   columna sobre una fila ya emitida, que el dominio no hace.
-- Homologación: YES (cambia qué versión de reglas conserva un documento fiscal o un asiento ya
--   emitido ante un UPDATE, y qué documentos juzga el invariante).
--
-- EXPAND: redefine dos funciones de la propia familia. La API desplegada no las llama, y el
-- trigger actúa igual para ella. Va JUSTO DESPUÉS de la 20261004205000 (parte de sus
-- definiciones, que son las vivas: ninguna migración posterior redefine
-- platform.stamp_rules_version ni platform.rules_version_gaps) y en la MISMA ventana de
-- despliegue: la versión semántica NO sube (ADR-0079 §8, una subida por ventana: la 1.3.0 de la
-- 205000). El corte del invariante tampoco se mueve.
--
--   B1  «Congelada es congelada» valía solo para la fila cuya versión vieja era una versión de
--       REGLAS. Una fila HEREDADA ya emitida o posteada, con `domain-s0.5` (o sin versión), se
--       resellaba con la versión de HOY ante un UPDATE que nombrara la columna (en
--       journal_entries, supplier_invoices, retention_vouchers, supplier_retentions e
--       inventory_withdrawal_notes. En documents lo rechaza documents_immutable, LAD06): una
--       versión de reglas que no regía cuando el hecho ocurrió. Y una fila ya emitida aceptaba
--       OTRA versión de reglas registrada si el UPDATE la traía. Ahora, en esas seis tablas, la
--       fila que YA estaba en estado final conserva su `rules_version` vieja, sea la que sea.
--       La vigente se sella solo al NACER en estado final o al PASAR a él.
--   B3  La cláusula (2) de platform.rules_version_gaps juzgaba por `created_at`: un borrador
--       creado antes del corte y emitido después no se juzgaba (la 20261004120000 miraba
--       `coalesce(issued_at, created_at)`). Vuelve a juzgar por el instante en que el documento
--       llegó a su estado final, sin dejar de mirar el de creación.
--
-- B2 (el asiento manual guardado como borrador y posteado otro día declara de nuevo al postear)
-- no es de la base: el trigger es `UPDATE OF rules_version` y solo ve el posteo si el caso de uso
-- nombra la columna. Lo hace `postJournalEntry` (packages/domain/src/accounting.ts), como ventas
-- al emitir. Aquí queda el lado de la base: al PASAR a estado final, se sella la vigente.

-- ════════════════════════════════════════════════════════════════════════════
-- B1 · el único sitio donde se congela la versión
-- (parte de la definición de 20261004205000, la viva)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function platform.stamp_rules_version()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  -- Documento fiscal o movimiento contable (regla 3): solo admite una versión de REGLAS.
  -- Una tabla nueva con `rules_version` que sea una de las dos cosas se añade AQUÍ (a la lista y
  -- a sus estados finales) y al enunciado de platform.rules_version_gaps.
  v_estricta boolean := tg_table_name in (
    'documents', 'supplier_invoices', 'retention_vouchers', 'supplier_retentions',
    'inventory_withdrawal_notes', 'journal_entries');
  v_key   text;
  v_cache text;
  v       text;
  v_estado text;
  v_final  boolean;
begin
  -- B1 · CONGELADA ES CONGELADA, para toda fila ya emitida o posteada y sea cual sea la clase
  -- de su versión: de reglas, la cadena heredada `domain-s0.5`, una de sistema o ninguna. Un
  -- UPDATE que nombre la columna no la cambia: ni por la vigente (sería afirmar que el hecho se
  -- calculó con reglas que no existían) ni por otra registrada que traiga la sentencia.
  -- Los estados finales son los MISMOS que juzga platform.rules_version_gaps:
  --   · documents: issued, paid, annulled
  --   · supplier_invoices: posted, paid, annulled
  --   · journal_entries: posted, reversed
  --   · retention_vouchers, supplier_retentions, inventory_withdrawal_notes: siempre.
  -- (En una variable: el IF de plpgsql corta su condición en el primer THEN, también el de un
  -- CASE.)
  if tg_op = 'UPDATE' and v_estricta then
    v_estado := pg_catalog.to_jsonb(old) ->> 'status';
    v_final :=
         (tg_table_name = 'documents' and v_estado in ('issued', 'paid', 'annulled'))
      or (tg_table_name = 'supplier_invoices' and v_estado in ('posted', 'paid', 'annulled'))
      or (tg_table_name = 'journal_entries' and v_estado in ('posted', 'reversed'))
      or tg_table_name in ('retention_vouchers', 'supplier_retentions',
                           'inventory_withdrawal_notes');
    if coalesce(v_final, false) then
      new.rules_version := old.rules_version;
      return new;
    end if;
  end if;

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

  -- Fuera de las seis tablas (una cuenta, la historia del tipo de contribuyente): un UPDATE que
  -- vuelve a declarar no cambia la versión de reglas con la que la fila nació. En las seis, lo
  -- que llega aquí es un borrador: todavía no congeló nada, y al emitirse o postearse declara de
  -- nuevo y se sella con la versión del día en que eso ocurre.
  if tg_op = 'UPDATE' and not v_estricta and exists (
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
-- B3 · el invariante juzga por el instante en que el documento llegó a su estado final
-- (parte de la definición de 20261004205000, la viva)
-- ════════════════════════════════════════════════════════════════════════════
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
  -- ENUNCIADO: desde el corte (platform.invariant_cutoffs; siempre un instante contra otro,
  -- dos `timestamptz`):
  --   (1) en TODA tabla de public que lleva `rules_version` (la lista sale del catálogo), toda
  --       versión escrita en una fila CREADA desde el corte (`created_at`) está REGISTRADA en
  --       platform.rules_versions —sea una versión de reglas o una cadena de sistema declarada—;
  --   (2) todo documento fiscal y todo movimiento contable que LLEGÓ A SU ESTADO FINAL desde el
  --       corte lleva una versión de REGLAS (`kind = 'rules'`), nunca una cadena de sistema ni
  --       nada. El instante que se compara es el más tardío entre el de creación y el del
  --       estado final de cada tabla: un borrador anterior al corte que se emite o se postea
  --       después SE JUZGA, y un documento creado después con una fecha de emisión anterior
  --       también:
  --         · `documents` en issued, paid o annulled, de toda clase: `issued_at`;
  --         · `supplier_invoices` en posted, paid o annulled: `posted_at`;
  --         · `journal_entries` en posted o reversed: `posted_at`;
  --         · `inventory_withdrawal_notes`, todas: `issued_at`;
  --         · `supplier_retentions`, todas: `applied_at` (nulo mientras no se aplica);
  --         · `retention_vouchers`, todos: no tienen otro instante que `created_at`.
  --       Estas seis tablas y estos estados son los mismos que platform.stamp_rules_version
  --       congela. Lo que NO ve: un borrador anterior al corte emitido después con una fecha de
  --       emisión también anterior al corte (ninguna columna guarda el instante del cambio).
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
     where d.company_id = p_company
       and greatest(d.created_at, coalesce(d.issued_at, d.created_at)) >= v_since
       and d.status in ('issued', 'paid', 'annulled')
       and not exists (select 1 from platform.rules_versions v
                        where v.version = d.rules_version and v.kind = 'rules');
  return query
    select 'supplier_invoices'::text, s.id, s.rules_version, 'emitted_without_rules_version'::text
      from public.supplier_invoices s
     where s.company_id = p_company
       and greatest(s.created_at, coalesce(s.posted_at, s.created_at)) >= v_since
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
     where r.company_id = p_company
       and greatest(r.created_at, coalesce(r.applied_at, r.created_at)) >= v_since
       and not exists (select 1 from platform.rules_versions v
                        where v.version = r.rules_version and v.kind = 'rules');
  return query
    select 'inventory_withdrawal_notes'::text, n.id, n.rules_version,
           'emitted_without_rules_version'::text
      from public.inventory_withdrawal_notes n
     where n.company_id = p_company
       and greatest(n.created_at, coalesce(n.issued_at, n.created_at)) >= v_since
       and not exists (select 1 from platform.rules_versions v
                        where v.version = n.rules_version and v.kind = 'rules');
  return query
    select 'journal_entries'::text, e.id, e.rules_version, 'posted_without_rules_version'::text
      from public.journal_entries e
     where e.company_id = p_company
       and greatest(e.created_at, coalesce(e.posted_at, e.created_at)) >= v_since
       and e.status in ('posted', 'reversed')
       and not exists (select 1 from platform.rules_versions v
                        where v.version = e.rules_version and v.kind = 'rules');
end;
$function$;

revoke all on function platform.rules_version_gaps(uuid) from public;

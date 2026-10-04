-- Módulo: auditoría y versión de reglas   ADR: docs/00_GOVERNANCE/adr/ADR-0079-*.md
-- Corrige la 20261004120200 (misma entrega), que introdujo un defecto al cerrar H4.
-- Reversible: SÍ en el esquema; las versiones registradas y las filas selladas se quedan.
-- Homologación: YES (cambia la versión de reglas que congela cada documento fiscal).
--
-- EL DEFECTO. La 120200 metió en el hash los ajustes de la empresa (`company_settings`,
-- `purchase_settings`) leyendo su FILA: una empresa sin fila y la misma empresa con la fila en
-- sus valores por omisión daban versiones distintas, aunque se comportan igual. Al nacer una
-- empresa, el acta que escribe el trigger del RIF (antes de que exista la fila de ajustes) y el
-- acta `company.created` (después) llevaban dos versiones: lo cazó `e2e-create-company`.
--
-- EL ARREGLO. Los ajustes entran SIEMPRE, haya fila o no; sin fila valen lo que vale el valor
-- por omisión de la columna. Y los importes se normalizan (`trim_scale`) para que 1000 y
-- 1000.00000000 sean la misma regla. Los valores por omisión están escritos aquí: el pgTAP 122
-- comprueba que «sin fila» y «fila por omisión» dan la misma versión, de modo que cambiar un
-- DEFAULT sin tocar esta función pone el gate en rojo.
--
-- La definición del hash vuelve a cambiar, así que sube la versión semántica (1.1.1). Las
-- versiones 1.1.0+… que se hayan registrado entre las dos migraciones se quedan en el registro.
-- Parte de la definición de `platform.current_rules_version` de la 20261004120200.

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
  -- SOLO los que son regla o umbral. El resto de company_settings —lista de precios, almacén,
  -- impresión— no es regla y no entra. `rules_version` y `actor_id` de company_taxpayer_types
  -- son procedencia, no regla.
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
      -- SIEMPRE una entrada, haya fila o no: sin fila, los valores por omisión de las columnas
      -- (los mismos DEFAULT de la tabla; el pgTAP 122 vigila que sigan siendo los mismos).
      select 'company_settings', 'rules',
             pg_catalog.jsonb_build_object(
               'absorb_igtf', coalesce((s.j ->> 'absorb_igtf')::boolean, false),
               'retention_received_voucher_rate',
                 coalesce((s.j ->> 'retention_received_voucher_rate')::boolean, false),
               'four_eyes', (s.j ->> 'four_eyes')::boolean,
               'supplier_payment_approval_threshold',
                 pg_catalog.trim_scale(
                   coalesce((s.j ->> 'supplier_payment_approval_threshold')::numeric, 1000)),
               'supplier_payment_approval_currency',
                 coalesce(s.j ->> 'supplier_payment_approval_currency', 'USD'))
        from (select 1) u
        left join (select pg_catalog.to_jsonb(r) as j from public.company_settings r
                    where r.company_id = p_company) s on true
       where p_company is not null
      union all
      select 'purchase_settings', 'rules',
             pg_catalog.jsonb_build_object(
               'price_tolerance_pct',
                 pg_catalog.trim_scale(coalesce((s.j ->> 'price_tolerance_pct')::numeric, 5)),
               'retention_voucher_mode',
                 coalesce(s.j ->> 'retention_voucher_mode', 'per_operation'))
        from (select 1) u
        left join (select pg_catalog.to_jsonb(r) as j from public.purchase_settings r
                    where r.company_id = p_company) s on true
       where p_company is not null
    ) f;

  v_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_global || '|' || v_company, 'UTF8')), 'hex');
  version := v_semver || '+' || pg_catalog.left(v_hash, 16);
  semver := v_semver;
  rules_hash := v_hash;
  return next;
end;
$function$;

revoke all on function platform.current_rules_version(uuid) from public;

insert into platform.rules_releases (semver, note) values
  ('1.1.1', 'Los ajustes de la empresa entran en el hash haya fila o no (sin fila valen su valor por omisión) y sus importes se normalizan (corrección de la 20261004120200).');

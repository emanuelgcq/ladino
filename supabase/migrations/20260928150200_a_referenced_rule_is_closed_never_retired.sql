-- =============================================================================
-- Ladino — UNA REGLA CON LÍNEAS EMITIDAS SE CIERRA, NUNCA SE RETIRA; Y EL LIBRO POR ALÍCUOTA
-- CUADRA ENTERO
-- (ADR-0073, revisión de la familia «alícuotas»: H1, H2, H5, H7)
--
-- Módulo: motor tributario · libros fiscales. Rigor máximo (fiscal, con datos vivos).
-- Spec:   docs/02_COMPLIANCE/IVA_SPEC.md · REPORTING_AND_FISCAL_BOOKS.md · ADR-0073 · ADR-0038.
-- Reversible: SÍ, con datos vivos — ver «Reversibilidad» al final.
-- HOMOLOGATION_IMPACT: YES — la reaceptación de la general el mismo día en que ya se facturó se
--   rechaza (LAD97) y el libro de ventas gana dos columnas. No cambia ninguna alícuota ni lo emitido.
--
-- Qué cambia (las migraciones 20260928150000 y 150100 no se editan: están aplicadas):
--   1. `platform.tax_rule_is_referenced(id)`: si alguna línea de venta o de compra copió la regla.
--   2. H2 · decidido por criterio (§2.16): una regla que alguna línea referencia NUNCA pasa a
--      `inactive`; se cierra con `effective_to`. Alternativa descartada: mover la tasa nueva a
--      mañana en silencio. Lo aplican:
--        · `platform.accept_general_vat` (create or replace sobre la definición VIVA de la
--          migración 20260928150000, §4): reaceptar el MISMO día en que la regla del día ya tiene
--          líneas → LAD97 «Hoy ya se facturó al 16 %: la nueva tasa puede regir desde mañana».
--          Sin líneas, se reemplaza como antes;
--        · el trigger `tax_rules_03_referenced_is_not_retired`, para cualquier otro camino;
--        · §3: corrige el efecto de 150100 y de la aceptación vieja, idempotente: reactiva, con
--          su vigencia cerrada, toda regla propia `inactive` que alguna línea referencia.
--   3. H5: `platform.sales_book_by_rate` gana `base_gravada_sin_alicuota` e `iva_sin_clasificar`,
--      para que Σ por alícuota cuadre con `base_gravada` e `iva_debito` también con líneas sin
--      categoría congelada (anteriores a la migración 27). Cambia el tipo de retorno: drop +
--      create sobre la definición VIVA de 150000 §7.
--   4. H1 y H7: comentarios. El aislamiento de las funciones de alícuotas depende de SECURITY
--      INVOKER; `tax_exemption_literals` es un catálogo de referencia que no se vincula al producto.
-- =============================================================================

-- ── 1. ¿Alguna línea copió esta regla? ───────────────────────────────────────
create function platform.tax_rule_is_referenced(p_rule uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.document_lines l where l.tax_rule_id = p_rule)
      or exists (select 1 from public.supplier_invoice_lines l where l.tax_rule_id = p_rule);
$$;
comment on function platform.tax_rule_is_referenced(uuid) is
  'Verdadero si una línea de venta (document_lines) o de compra (supplier_invoice_lines) copió la '
  'regla. Una regla referenciada se cierra con effective_to, nunca pasa a inactive (ADR-0073, H2). '
  'SECURITY INVOKER: con RLS, solo ve las líneas que el que llama puede ver.';
revoke execute on function platform.tax_rule_is_referenced(uuid) from public;
grant execute on function platform.tax_rule_is_referenced(uuid) to ladino_api;

-- ── 2a. La aceptación: no retira una regla del día que ya se facturó ─────────
create or replace function platform.accept_general_vat(p_company uuid, p_rate numeric, p_effective date)
returns table (rules_created integer, rules_closed integer, previous_rate numeric,
               legal_source text)
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_tenant   uuid;
  v_tpl      public.tax_rule_templates%rowtype;
  v_actual   numeric;
  v_fuente   text;
  v_creadas  integer := 0;
  v_cerradas integer := 0;
  v_n        integer;
begin
  -- El mismo candado que las semillas de reglas: dos aceptaciones simultáneas no se cruzan.
  perform pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'));
  select c.tenant_id into v_tenant from public.companies c where c.id = p_company;
  if v_tenant is null then
    raise exception 'la empresa % no existe', p_company using errcode = '23503';
  end if;

  select t.* into v_tpl from public.tax_rule_templates t
   where t.jurisdiction = 'VE' and t.tax_code = 'iva' and t.product_tax_category = 'gravado_general'
     and t.requires_acceptance
     and t.effective_from <= p_effective
     and (t.effective_to is null or t.effective_to > p_effective);
  if not found then
    raise exception 'no hay alícuota general en el catálogo para el %', p_effective
      using errcode = 'LAD97',
            hint = 'ADR-0073: la general se acepta desde el catálogo, con su fuente';
  end if;
  if p_rate is null or p_rate = 0 then
    raise exception 'el 0 %% no es una alícuota general (LIVA art. 27): lo exento se clasifica por producto'
      using errcode = 'LAD97';
  end if;
  if p_rate < v_tpl.rate_min or p_rate > v_tpl.rate_max then
    raise exception 'la alícuota general tiene que estar entre 8 %% y 16,5 %% (%)',
      v_tpl.legal_source
      using errcode = 'LAD97';
  end if;

  v_fuente := left(
    v_tpl.legal_source || '. Aceptada por la empresa desde el ' || p_effective::text
    || case when p_rate <> v_tpl.rate
            then '; distinta de la del catálogo (' || trim_scale(v_tpl.rate * 100)::text
                 || ' %): VALIDAR-TRIBUTARIO'
            else '' end,
    300);

  select r.rate into v_actual from public.tax_rules r
   where r.company_id = p_company and r.jurisdiction = 'VE' and r.tax_code = 'iva'
     and r.taxpayer_type is null and r.product_tax_category = 'gravado_general'
     and r.transaction_type = 'sale' and r.status = 'active'
     and r.effective_from <= p_effective
     and (r.effective_to is null or r.effective_to > p_effective)
   order by r.effective_from desc limit 1;

  if v_actual is distinct from p_rate then
    -- H2 (decidido por criterio): la regla que empieza ESE MISMO día solo se puede retirar si
    -- nadie la usó. Si ya se facturó con ella, retirarla dejaría líneas emitidas colgando de una
    -- regla inactiva; cerrarla en el mismo día que empieza es una vigencia de cero días. La
    -- persona elige otra fecha efectiva.
    if exists (
      select 1 from public.tax_rules r
       where r.company_id = p_company and r.jurisdiction = 'VE' and r.tax_code = 'iva'
         and r.taxpayer_type is null
         and r.product_tax_category in ('gravado_general', 'gravado_adicional')
         and r.status = 'active' and r.effective_from >= p_effective
         and platform.tax_rule_is_referenced(r.id)) then
      raise exception 'Hoy ya se facturó al % %%: la nueva tasa puede regir desde mañana (%).',
        replace(trim_scale(coalesce(v_actual, 0) * 100)::text, '.', ','), p_effective + 1
        using errcode = 'LAD97',
              hint = 'ADR-0073 H2: una regla con líneas emitidas se cierra, nunca se retira';
    end if;

    -- La general y la adicional (que la sigue) vigentes se CIERRAN en la fecha efectiva...
    update public.tax_rules r set effective_to = p_effective
     where r.company_id = p_company and r.jurisdiction = 'VE' and r.tax_code = 'iva'
       and r.taxpayer_type is null
       and r.product_tax_category in ('gravado_general', 'gravado_adicional')
       and r.status = 'active' and r.effective_from < p_effective
       and (r.effective_to is null or r.effective_to > p_effective);
    get diagnostics v_n = row_count;
    v_cerradas := v_n;
    -- ...y las que empezaban ese mismo día (o después), sin líneas, se retiran.
    update public.tax_rules r set status = 'inactive'
     where r.company_id = p_company and r.jurisdiction = 'VE' and r.tax_code = 'iva'
       and r.taxpayer_type is null
       and r.product_tax_category in ('gravado_general', 'gravado_adicional')
       and r.status = 'active' and r.effective_from >= p_effective;
    get diagnostics v_n = row_count;
    v_cerradas := v_cerradas + v_n;

    insert into public.tax_rules
      (tenant_id, company_id, jurisdiction, tax_code, taxpayer_type, product_tax_category,
       rate, effective_from, legal_source, priority, transaction_type)
    select v_tenant, p_company, 'VE', 'iva', null, 'gravado_general', p_rate, p_effective,
           v_fuente, 5, t
      from unnest(array['sale', 'purchase']) t;
    v_creadas := 2;
  end if;

  v_creadas := v_creadas + platform.seed_catalog_tax_rules(p_company, p_rate, p_effective);
  return query select v_creadas, v_cerradas, v_actual, v_fuente;
end;
$$;
comment on function platform.accept_general_vat(uuid, numeric, date) is
  'B-02 (ADR-0073 §3): acepta la general de la empresa desde el catálogo. 0 % y fuera de '
  '[rate_min, rate_max] → LAD97. Otra tasa cierra la vigencia actual (general y adicional) en la '
  'fecha efectiva y abre otra; la misma tasa no crea nada; la regla del mismo día que ya tiene '
  'líneas emitidas no se retira: LAD97 (H2). SECURITY INVOKER a propósito: la empresa ajena no se '
  've por RLS y da 23503; convertirla en SECURITY DEFINER la abre a cualquier empresa (pgTAP 081b, '
  'variante rota). El permiso y el acta los pone el caso de uso.';

-- ── 2b. Por cualquier otro camino, tampoco ───────────────────────────────────
create function platform.assert_referenced_tax_rule_not_retired()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'active' and new.status <> 'active'
     and platform.tax_rule_is_referenced(old.id) then
    raise exception 'la regla tributaria % tiene líneas emitidas: se cierra con su vigencia (effective_to), no se retira',
      old.id
      using errcode = 'LAD97',
            hint = 'ADR-0073 H2: lo emitido conserva su regla vigente en su día';
  end if;
  return new;
end;
$$;
create trigger tax_rules_03_referenced_is_not_retired
  before update of status on public.tax_rules
  for each row execute function platform.assert_referenced_tax_rule_not_retired();
comment on trigger tax_rules_03_referenced_is_not_retired on public.tax_rules is
  'H2 (ADR-0073): una regla que alguna línea de venta o compra copió no pasa a inactive. Se cierra '
  'con effective_to. Quitar este trigger deja líneas emitidas colgando de reglas retiradas.';

-- ── 3. El efecto ya aplicado: reactivar lo referenciado, con su vigencia cerrada ─
-- Idempotente. Por cada regla PROPIA inactiva que alguna línea referencia (la exenta que retiró
-- 150100 el día en que empezaba, o una general reemplazada el mismo día por la aceptación vieja):
--   · la sustituta que empieza el mismo día y NADIE usó se corre al día siguiente (o se retira si
--     ya no tenía vigencia que correr);
--   · la referenciada vuelve a `active` con vigencia de un día: [su inicio, el día siguiente).
-- Si la sustituta también tiene líneas, las dos se usaron el mismo día y no hay forma honesta de
-- elegir: se deja como está y se avisa (NOTICE); lo resuelve una persona.
do $$
declare
  v_r record;
  v_dia date;
begin
  for v_r in
    select r.* from public.tax_rules r
     where r.company_id is not null and r.status = 'inactive'
       and platform.tax_rule_is_referenced(r.id)
  loop
    v_dia := v_r.effective_from + 1;
    if exists (
      select 1 from public.tax_rules q
       where q.id <> v_r.id and q.company_id = v_r.company_id and q.status = 'active'
         and q.jurisdiction = v_r.jurisdiction and q.tax_code = v_r.tax_code
         and q.taxpayer_type is not distinct from v_r.taxpayer_type
         and q.product_tax_category is not distinct from v_r.product_tax_category
         and q.transaction_type = v_r.transaction_type
         and q.effective_from <= v_r.effective_from
         and (q.effective_to is null or q.effective_to > v_r.effective_from)
         and platform.tax_rule_is_referenced(q.id)) then
      raise notice 'H2: la regla % y su sustituta tienen líneas del mismo día; se deja para revisión',
        v_r.id;
      continue;
    end if;
    -- La sustituta sin líneas: sin vigencia que correr, se retira; si no, empieza al día siguiente.
    update public.tax_rules q set status = 'inactive'
     where q.id <> v_r.id and q.company_id = v_r.company_id and q.status = 'active'
       and q.jurisdiction = v_r.jurisdiction and q.tax_code = v_r.tax_code
       and q.taxpayer_type is not distinct from v_r.taxpayer_type
       and q.product_tax_category is not distinct from v_r.product_tax_category
       and q.transaction_type = v_r.transaction_type
       and q.effective_from = v_r.effective_from
       and q.effective_to is not null and q.effective_to <= v_dia;
    update public.tax_rules q set effective_from = v_dia
     where q.id <> v_r.id and q.company_id = v_r.company_id and q.status = 'active'
       and q.jurisdiction = v_r.jurisdiction and q.tax_code = v_r.tax_code
       and q.taxpayer_type is not distinct from v_r.taxpayer_type
       and q.product_tax_category is not distinct from v_r.product_tax_category
       and q.transaction_type = v_r.transaction_type
       and q.effective_from = v_r.effective_from;
    update public.tax_rules set status = 'active', effective_to = v_dia where id = v_r.id;
  end loop;
end $$;

-- ── 4. El libro por alícuota, cuadrado también con lo que no tiene categoría ─
drop function platform.sales_book_by_rate(uuid, date, date);
create function platform.sales_book_by_rate(p_company uuid, p_from date, p_to date)
returns table (
  document_id uuid, issued_on date, kind text, series text, document_number bigint,
  control_number bigint, status text, customer_tax_id text, customer_name text,
  customer_taxpayer_type text, transaction_currency text, fx_rate numeric,
  base_gravada numeric, iva_debito numeric, base_exenta numeric, base_exonerada numeric,
  base_no_sujeta numeric, base_sin_clasificar numeric, total_amount numeric,
  journal_entry_id uuid,
  base_alicuota_general numeric, iva_alicuota_general numeric, alicuota_general numeric,
  base_alicuota_adicional numeric, iva_alicuota_adicional numeric, alicuota_adicional numeric,
  base_alicuota_reducida numeric, iva_alicuota_reducida numeric, alicuota_reducida numeric,
  base_gravada_sin_alicuota numeric, iva_sin_clasificar numeric
)
language sql
stable
set search_path = ''
as $$
  -- El renglón de `sales_book` tal cual (mismo signo, misma anulada en cero), más la base y el
  -- IVA de cada alícuota, leídos de la CATEGORÍA CONGELADA en la línea (ADR-0044 §1) y con el
  -- IVA derivado como total − subtotal funcionales, igual que el documento y la planilla.
  -- H5: lo que no cae en ninguna de las tres alícuotas va a `base_gravada_sin_alicuota` (base
  -- gravada sin categoría reconocida: debería ser cero) y a `iva_sin_clasificar` (IVA de las
  -- líneas fuera de las tres: las anteriores a la migración 27). Así, por renglón,
  --   Σ base_alicuota_* + base_gravada_sin_alicuota = base_gravada, y
  --   Σ iva_alicuota_*  + iva_sin_clasificar        = iva_debito (pgTAP 081b).
  select s.document_id, s.issued_on, s.kind, s.series, s.document_number, s.control_number,
         s.status, s.customer_tax_id, s.customer_name, s.customer_taxpayer_type,
         s.transaction_currency, s.fx_rate, s.base_gravada, s.iva_debito, s.base_exenta,
         s.base_exonerada, s.base_no_sujeta, s.base_sin_clasificar, s.total_amount,
         s.journal_entry_id,
         r.base_g, r.iva_g, r.rate_g, r.base_a, r.iva_a, r.rate_a, r.base_r, r.iva_r, r.rate_r,
         r.base_x, r.iva_x
    from platform.sales_book(p_company, p_from, p_to) with ordinality as s
    cross join lateral (
      select case when s.status = 'annulled' then 0
                  when s.kind = 'credit_note' then -1 else 1 end as factor
    ) f
    cross join lateral (
      select
        coalesce(sum(dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_general'), 0) * f.factor as base_g,
        coalesce(sum(dl.line_total_functional - dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_general'), 0) * f.factor as iva_g,
        max(dl.tax_rate_snapshot) filter (where dl.tax_category_snapshot = 'gravado_general') as rate_g,
        coalesce(sum(dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_adicional'), 0) * f.factor as base_a,
        coalesce(sum(dl.line_total_functional - dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_adicional'), 0) * f.factor as iva_a,
        max(dl.tax_rate_snapshot) filter (where dl.tax_category_snapshot = 'gravado_adicional') as rate_a,
        coalesce(sum(dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_reducida'), 0) * f.factor as base_r,
        coalesce(sum(dl.line_total_functional - dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_reducida'), 0) * f.factor as iva_r,
        max(dl.tax_rate_snapshot) filter (where dl.tax_category_snapshot = 'gravado_reducida') as rate_r,
        coalesce(sum(dl.line_subtotal_functional)
                 filter (where dl.tax_treatment = 'gravado'
                           and dl.tax_category_snapshot is distinct from 'gravado_general'
                           and dl.tax_category_snapshot is distinct from 'gravado_adicional'
                           and dl.tax_category_snapshot is distinct from 'gravado_reducida'), 0)
          * f.factor as base_x,
        coalesce(sum(dl.line_total_functional - dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot is null
                           or dl.tax_category_snapshot not in
                              ('gravado_general', 'gravado_adicional', 'gravado_reducida')), 0)
          * f.factor as iva_x
        from public.document_lines dl
       where dl.document_id = s.document_id
    ) r
   order by s.ordinality
$$;
comment on function platform.sales_book_by_rate(uuid, date, date) is
  'Libro de ventas con la base y el IVA POR ALÍCUOTA (general, general + adicional, reducida) y lo '
  'que no cae en ninguna (base_gravada_sin_alicuota, iva_sin_clasificar), como pide el RLIVA arts. '
  '72 y 76 (L-08). Mismo renglón y signo que sales_book. SECURITY INVOKER a propósito: su '
  'aislamiento entre empresas es la RLS de documents y document_lines del que llama; como SECURITY '
  'DEFINER devolvería el libro de cualquier empresa (pgTAP 081b, variante rota).';
revoke execute on function platform.sales_book_by_rate(uuid, date, date) from public;
grant execute on function platform.sales_book_by_rate(uuid, date, date) to authenticated, ladino_api;

-- ── 5. Comentarios de aislamiento (H1) y del catálogo de literales (H7) ──────
comment on function platform.sales_book_summary(uuid, date, date) is
  'Resumen del libro de ventas (RLIVA art. 72, L-08): base e IVA por alícuota, exentas, '
  'exoneradas, no sujetas y ajustes por notas. Exportaciones: Ladino no las implementa '
  '(VALIDAR-SENIAT), no aparecen. SECURITY INVOKER a propósito: su aislamiento entre empresas es la '
  'RLS del que llama; como SECURITY DEFINER resumiría el libro de cualquier empresa (pgTAP 081b).';
comment on function platform.seed_catalog_tax_rules(uuid, numeric, date) is
  'Copia a la empresa, como reglas PROPIAS con la cita del catálogo, lo que no se acepta: '
  'reducida, exenta y adicional (general de la empresa + 15 %, LIVA art. 61). Idempotente: no '
  'duplica lo que ya rige en la fecha (ADR-0073). SECURITY INVOKER a propósito: para una empresa '
  'ajena, la policy de insert de tax_rules la rechaza con 42501 (pgTAP 081b).';
comment on table public.tax_exemption_literals is
  'LIVA art. 18 num. 1, por literal (ADR-0073 §4). Catálogo de REFERENCIA: todavía no se vincula '
  'al producto (el producto solo lleva su categoría, p. ej. exento). Fuente: reproducción del '
  'art. 18 en la G.O. 6.396 Ext. cotejada con prensa posterior a la G.O. 6.507; NO cotejado con el '
  'texto de la G.O. 6.507: cada literal es «fuente secundaria» (VALIDAR-TRIBUTARIO). El literal '
  'pendiente de fuente no se siembra.';

-- =============================================================================
-- Reversibilidad (con datos vivos)
--
-- SÍ:
--   · `accept_general_vat` vuelve a su definición de 20260928150000 §4 con otro create or replace
--     (la única diferencia es el rechazo del mismo día con líneas).
--   · El trigger y `tax_rule_is_referenced` se retiran con drop.
--   · `sales_book_by_rate`: drop + create con la definición de 150000 §7 (dos columnas menos). El
--     CSV de ventas vuelve a su forma anterior; un período exportado daría otro hash.
--   · §3 solo reactivó reglas que alguna línea emitida referencia (vigencia de un día) y corrió al
--     día siguiente su sustituta sin líneas. Deshacerlo es volver a retirarlas, que es justamente lo
--     que este cambio prohíbe: no se recomienda. Nada se borró; ninguna línea emitida cambió.
-- =============================================================================

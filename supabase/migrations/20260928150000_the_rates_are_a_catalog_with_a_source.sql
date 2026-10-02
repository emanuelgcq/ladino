-- =============================================================================
-- Ladino — LAS ALÍCUOTAS SON UN CATÁLOGO CON FUENTE
-- (ADR-0073; RESPUESTA_RECORRIDO_2026-09-24 §2.4 y §2.5: B-02, B-04, B-11, E-04, E-18, L-08)
--
-- Módulo: motor tributario · libros fiscales. Rigor máximo (fiscal).
-- Spec:   docs/02_COMPLIANCE/IVA_SPEC.md (tabla «Fuentes normativas», verificada 2026-09-28)
--         · ADR-0038 · ADR-0057 (conciliadas por ADR-0073) · ADR-0044.
-- Reversible: SÍ, con datos vivos — ver «Reversibilidad» al final.
-- HOMOLOGATION_IMPACT: YES — qué alícuota resuelve cada empresa (reducida, adicional y exenta
--   pasan a venderse), cómo se acepta la general (rango del art. 27, cierre de vigencia) y qué
--   columnas trae el libro de ventas. No toca la numeración ni el cálculo de la línea.
--
-- Qué cambia:
--   1. `tax_rule_templates`: el catálogo de PLATAFORMA, una fila por alícuota con norma,
--      artículo, Gaceta, vigencia y estado de la fuente, copiado de IVA_SPEC.md. Lo «pendiente de
--      fuente» NO se siembra: `no_sujeto` (art. 16) ni la adicional del art. 62. Lo exonerado solo
--      con el Decreto 5.196, que es de importación: no se ofrece en ventas.
--      NO son reglas: `resolve_tax` no las mira. `tax_rules` sigue naciendo vacía (ADR-0038) y
--      las reglas siguen siendo de cada empresa (ADR-0057).
--   2. `tax_exemption_literals`: la cesta básica del art. 18.1, literal por literal (a–u), cada
--      uno «fuente secundaria». El literal pendiente de fuente no se siembra.
--   3. `platform.seed_catalog_tax_rules`: copia a una empresa, como reglas PROPIAS con la cita del
--      catálogo, lo que no necesita aceptación: la reducida, la exenta y la adicional (sumada a
--      la general de la empresa).
--   4. `platform.accept_general_vat`: la aceptación de la general (B-02). Solo 8–16,5 % (art. 27,
--      rango del catálogo), el 0 % se rechaza; otra tasa CIERRA la vigencia actual y abre otra
--      desde la fecha efectiva; la misma tasa no crea nada. LAD97.
--   5. Trigger `tax_rules_02_general_in_range`: la general propia fuera de rango no entra por
--      ningún camino (defensa en la tabla, no solo en la API).
--   6. Las empresas que YA aceptaron su general reciben reducida, exenta y adicional desde hoy.
--   7. `platform.sales_book_by_rate` y `platform.sales_book_summary`: el libro de ventas por
--      alícuota y el resumen del art. 72 del RLIVA (L-08). `sales_book` NO se toca.
--
-- LAD97: la general propuesta no es una alícuota general del catálogo (0 %, fuera de rango o sin
-- plantilla vigente).
-- =============================================================================

-- ── 1. El catálogo de plataforma ─────────────────────────────────────────────
create table public.tax_rule_templates (
  id                   uuid          primary key default platform.uuidv7(),
  jurisdiction         text          not null default 'VE',
  tax_code             text          not null default 'iva',
  product_tax_category text          not null,
  -- La alícuota del catálogo. En la general es la REFERENCIA (la del decreto vigente); la
  -- empresa acepta la suya dentro de [rate_min, rate_max].
  rate                 numeric(24,8) not null,
  rate_min             numeric(24,8),
  rate_max             numeric(24,8),
  -- La adicional se SUMA a la general de la empresa (LIVA art. 61): su regla vale general + rate.
  adds_to_category     text,
  -- Solo la general se acepta. Lo demás es ley y viene del catálogo (ADR-0073 §3).
  requires_acceptance  boolean       not null,
  offered_in_sales     boolean       not null,
  -- `interna`: ventas y compras nacionales. `importacion`: solo la importación (Decreto 5.196).
  scope                text          not null,
  legal_norm           text          not null,
  legal_article        text          not null,
  gazette              text,
  effective_from       date          not null,
  effective_to         date,
  -- `pendiente de fuente` no es un estado admitido: lo que no tiene fuente no se siembra.
  source_status        text          not null,
  legal_source         text          not null,
  created_at           timestamptz   not null default now(),
  constraint tax_rule_templates_category_fk
    foreign key (product_tax_category) references public.product_tax_categories (code),
  constraint tax_rule_templates_adds_to_fk
    foreign key (adds_to_category) references public.product_tax_categories (code),
  constraint tax_rule_templates_rate_chk check (rate >= 0 and rate <= 1),
  constraint tax_rule_templates_range_chk check (
    (rate_min is null and rate_max is null)
    or (rate_min is not null and rate_max is not null and rate_min > 0
        and rate_min <= rate and rate <= rate_max)),
  constraint tax_rule_templates_adds_to_chk check (adds_to_category <> product_tax_category),
  constraint tax_rule_templates_scope_chk check (scope in ('interna', 'importacion')),
  constraint tax_rule_templates_sales_chk check (not offered_in_sales or scope = 'interna'),
  constraint tax_rule_templates_period_chk check (effective_to is null or effective_to > effective_from),
  constraint tax_rule_templates_source_status_chk
    check (source_status in ('verificada', 'fuente_secundaria')),
  constraint tax_rule_templates_legal_source_chk
    check (length(btrim(legal_source)) between 3 and 300),
  constraint tax_rule_templates_key
    unique (jurisdiction, tax_code, product_tax_category, effective_from)
);
comment on table public.tax_rule_templates is
  'Catálogo de PLATAFORMA de alícuotas con su fuente (ADR-0073), copiado de IVA_SPEC.md. No son '
  'reglas: resolve_tax no las lee. La general se ACEPTA por empresa dentro de [rate_min, '
  'rate_max] (accept_general_vat); reducida, exenta y adicional se copian a la empresa con su '
  'cita (seed_catalog_tax_rules). Lo pendiente de fuente no se siembra.';

insert into public.tax_rule_templates
  (product_tax_category, rate, rate_min, rate_max, adds_to_category, requires_acceptance,
   offered_in_sales, scope, legal_norm, legal_article, gazette, effective_from, effective_to,
   source_status, legal_source)
values
  ('gravado_general', 0.16, 0.08, 0.165, null, true, true, 'interna',
   'Decreto N.º 4.079', 'LIVA art. 27', 'G.O. 41.788 del 26-12-2019', '2020-01-01', null,
   'verificada',
   'LIVA art. 27 (rango 8–16,5 %, lo fija el Ejecutivo) + Decreto N.º 4.079, G.O. 41.788 del '
   '26-12-2019, rige desde el 01-01-2020'),
  ('gravado_reducida', 0.08, null, null, null, false, true, 'interna',
   'LIVA (G.O. 6.507 Ext.)', 'LIVA art. 64', 'G.O. 6.507 Ext. del 29-01-2020', '2020-01-29', null,
   'fuente_secundaria',
   'LIVA art. 64 (art. 63 antes de la reforma 2020), G.O. 6.507 Ext. del 29-01-2020: alícuota '
   'reducida 8 %. Bienes alcanzados pendientes de fuente (VALIDAR-TRIBUTARIO)'),
  ('gravado_adicional', 0.15, null, null, 'gravado_general', false, true, 'interna',
   'LIVA (G.O. 6.507 Ext.)', 'LIVA art. 61', 'G.O. 6.507 Ext. del 29-01-2020', '2020-01-29', null,
   'fuente_secundaria',
   'LIVA art. 61, G.O. 6.507 Ext. del 29-01-2020: alícuota adicional de 15 % a bienes y '
   'servicios suntuarios, sumada a la general'),
  ('exento', 0, null, null, null, false, true, 'interna',
   'LIVA (G.O. 6.507 Ext.)', 'LIVA arts. 17-19', 'G.O. 6.507 Ext. del 29-01-2020', '2020-01-29',
   null, 'fuente_secundaria',
   'LIVA arts. 17 (importaciones), 18 (ventas) y 19 (servicios), G.O. 6.507 Ext. del '
   '29-01-2020: operaciones exentas, 0 %, «(E)» en la factura'),
  ('exonerado', 0, null, null, null, false, false, 'importacion',
   'Decreto N.º 5.196', 'LIVA art. 17 num. 1 (suspendido)', 'G.O. 6.952 Ext. del 31-12-2025',
   '2026-01-01', '2027-01-01', 'verificada',
   'Decreto N.º 5.196, G.O. 6.952 Ext. del 31-12-2025, vigente hasta el 31-12-2026: exonera la '
   'importación de las subpartidas de su Apéndice I. No afecta a las ventas internas');

-- ── 2. La cesta básica, literal por literal ──────────────────────────────────
create table public.tax_exemption_literals (
  code                 text        primary key,
  product_tax_category text        not null default 'exento',
  description          text        not null,
  legal_source         text        not null,
  source_status        text        not null,
  created_at           timestamptz not null default now(),
  constraint tax_exemption_literals_code_chk check (code ~ '^[0-9]+\.[0-9]+\.[a-z]$'),
  constraint tax_exemption_literals_category_fk
    foreign key (product_tax_category) references public.product_tax_categories (code),
  constraint tax_exemption_literals_exento_chk check (product_tax_category = 'exento'),
  constraint tax_exemption_literals_source_status_chk
    check (source_status in ('verificada', 'fuente_secundaria')),
  constraint tax_exemption_literals_legal_source_chk
    check (length(btrim(legal_source)) between 3 and 300)
);
comment on table public.tax_exemption_literals is
  'LIVA art. 18 num. 1, por literal (ADR-0073 §4). Fuente: reproducción del art. 18 en la G.O. '
  '6.396 Ext. cotejada con prensa posterior a la G.O. 6.507; NO cotejado con el texto de la G.O. '
  '6.507: cada literal es «fuente secundaria» (VALIDAR-TRIBUTARIO). El literal pendiente de '
  'fuente no se siembra. Sirve para clasificar un producto como exento con su cita.';

insert into public.tax_exemption_literals (code, description, legal_source, source_status)
select l.code, l.description,
       'LIVA art. ' || l.code || ' (G.O. 6.507 Ext.) — fuente secundaria, VALIDAR-TRIBUTARIO',
       'fuente_secundaria'
  from (values
    ('18.1.a', 'Productos del reino vegetal en estado natural para consumo humano; semillas certificadas, material de reproducción animal e insumos biológicos agrícolas y pecuarios'),
    ('18.1.b', 'Especies avícolas reproductoras, huevos fértiles de gallina y pollitos, pollitas y pollonas para reproducción'),
    ('18.1.c', 'Arroz'),
    ('18.1.d', 'Harina de origen vegetal, incluidas las sémolas'),
    ('18.1.e', 'Pan y pastas alimenticias'),
    ('18.1.f', 'Huevos de gallina'),
    ('18.1.g', 'Sal'),
    ('18.1.h', 'Azúcar y papelón, salvo los de uso industrial'),
    ('18.1.i', 'Café tostado, molido o en grano'),
    ('18.1.j', 'Mortadela'),
    ('18.1.k', 'Atún enlatado en presentación natural'),
    ('18.1.l', 'Sardinas enlatadas en presentación cilíndrica de hasta 170 g'),
    ('18.1.m', 'Leche cruda, pasteurizada, en polvo, modificada, maternizada o humanizada, y fórmulas lácteas, incluidas las de soya'),
    ('18.1.n', 'Queso blanco'),
    ('18.1.o', 'Margarina y mantequilla'),
    ('18.1.p', 'Carnes de pollo, bovino y porcino en estado natural, refrigeradas, congeladas, saladas o en salmuera'),
    ('18.1.q', 'Mayonesa'),
    ('18.1.r', 'Avena'),
    ('18.1.s', 'Animales vivos destinados al matadero (bovino y porcino)'),
    ('18.1.t', 'Ganado bovino y porcino para la cría'),
    ('18.1.u', 'Aceites comestibles, salvo el de oliva')
  ) as l(code, description);

-- Catálogos GLOBALES: lectura para todos, escritura denegada POR ESCRITO (como fiscal_regimes).
alter table public.tax_rule_templates      enable row level security;
alter table public.tax_rule_templates      force  row level security;
alter table public.tax_exemption_literals  enable row level security;
alter table public.tax_exemption_literals  force  row level security;
create policy tax_rule_templates_select on public.tax_rule_templates
  for select to authenticated, ladino_api using (true);
create policy tax_rule_templates_insert on public.tax_rule_templates
  for insert to authenticated, ladino_api with check (false);
create policy tax_rule_templates_update on public.tax_rule_templates
  for update to authenticated, ladino_api using (false);
create policy tax_rule_templates_delete on public.tax_rule_templates
  for delete to authenticated, ladino_api using (false);
create policy tax_exemption_literals_select on public.tax_exemption_literals
  for select to authenticated, ladino_api using (true);
create policy tax_exemption_literals_insert on public.tax_exemption_literals
  for insert to authenticated, ladino_api with check (false);
create policy tax_exemption_literals_update on public.tax_exemption_literals
  for update to authenticated, ladino_api using (false);
create policy tax_exemption_literals_delete on public.tax_exemption_literals
  for delete to authenticated, ladino_api using (false);
revoke all on public.tax_rule_templates, public.tax_exemption_literals
  from public, anon, authenticated, ladino_api;
grant select on public.tax_rule_templates, public.tax_exemption_literals
  to authenticated, ladino_api;

-- ── 3. Lo que viene del catálogo, copiado a una empresa ──────────────────────
create function platform.seed_catalog_tax_rules(p_company uuid, p_general numeric, p_effective date)
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_tenant  uuid;
  v_t       record;
  v_tipo    text;
  v_rate    numeric;
  v_n       integer;
  v_creadas integer := 0;
begin
  select c.tenant_id into v_tenant from public.companies c where c.id = p_company;
  for v_t in
    select t.* from public.tax_rule_templates t
     where t.jurisdiction = 'VE' and t.tax_code = 'iva'
       and t.offered_in_sales and not t.requires_acceptance and t.scope = 'interna'
       and t.effective_from <= p_effective
       and (t.effective_to is null or t.effective_to > p_effective)
  loop
    v_rate := case when v_t.adds_to_category = 'gravado_general' then p_general + v_t.rate
                   else v_t.rate end;
    foreach v_tipo in array array['sale', 'purchase'] loop
      insert into public.tax_rules
        (tenant_id, company_id, jurisdiction, tax_code, taxpayer_type, product_tax_category,
         rate, effective_from, legal_source, priority, transaction_type)
      select v_tenant, p_company, 'VE', 'iva', null, v_t.product_tax_category, v_rate,
             p_effective, v_t.legal_source, 5, v_tipo
       where not exists (
         select 1 from public.tax_rules r
          where r.company_id = p_company and r.jurisdiction = 'VE' and r.tax_code = 'iva'
            and r.taxpayer_type is null and r.product_tax_category = v_t.product_tax_category
            and r.transaction_type = v_tipo and r.status = 'active'
            and r.effective_from <= p_effective
            and (r.effective_to is null or r.effective_to > p_effective));
      get diagnostics v_n = row_count;
      v_creadas := v_creadas + v_n;
    end loop;
  end loop;
  return v_creadas;
end;
$$;
comment on function platform.seed_catalog_tax_rules(uuid, numeric, date) is
  'Copia a la empresa, como reglas PROPIAS con la cita del catálogo, lo que no se acepta: '
  'reducida, exenta y adicional (general de la empresa + 15 %, LIVA art. 61). Idempotente: no '
  'duplica lo que ya rige en la fecha (ADR-0073).';
revoke execute on function platform.seed_catalog_tax_rules(uuid, numeric, date) from public;
grant execute on function platform.seed_catalog_tax_rules(uuid, numeric, date) to ladino_api;

-- ── 4. La aceptación de la general (B-02) ────────────────────────────────────
create function platform.accept_general_vat(p_company uuid, p_rate numeric, p_effective date)
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
    -- La general y la adicional (que la sigue) vigentes se CIERRAN en la fecha efectiva...
    update public.tax_rules r set effective_to = p_effective
     where r.company_id = p_company and r.jurisdiction = 'VE' and r.tax_code = 'iva'
       and r.taxpayer_type is null
       and r.product_tax_category in ('gravado_general', 'gravado_adicional')
       and r.status = 'active' and r.effective_from < p_effective
       and (r.effective_to is null or r.effective_to > p_effective);
    get diagnostics v_n = row_count;
    v_cerradas := v_n;
    -- ...y las que empezaban ese mismo día (o después) se retiran: no hay vigencia de cero días.
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
  'fecha efectiva y abre otra; la misma tasa no crea nada. Siempre completa lo que viene del '
  'catálogo. El permiso y el acta los pone el caso de uso.';
revoke execute on function platform.accept_general_vat(uuid, numeric, date) from public;
grant execute on function platform.accept_general_vat(uuid, numeric, date) to ladino_api;

-- ── 5. La defensa en la tabla ────────────────────────────────────────────────
create function platform.assert_general_vat_in_range()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is not null and new.status = 'active'
     and new.jurisdiction = 'VE' and new.tax_code = 'iva'
     and new.product_tax_category = 'gravado_general'
     and not exists (
       select 1 from public.tax_rule_templates t
        where t.jurisdiction = 'VE' and t.tax_code = 'iva'
          and t.product_tax_category = 'gravado_general' and t.requires_acceptance
          and t.effective_from <= new.effective_from
          and (t.effective_to is null or t.effective_to > new.effective_from)
          and new.rate between t.rate_min and t.rate_max) then
    raise exception 'una alícuota general de % no es una general del catálogo (8 %%–16,5 %%, LIVA art. 27)',
      new.rate
      using errcode = 'LAD97';
  end if;
  return new;
end;
$$;
create trigger tax_rules_02_general_in_range
  before insert or update of rate, effective_from, status, product_tax_category
  on public.tax_rules
  for each row execute function platform.assert_general_vat_in_range();
comment on trigger tax_rules_02_general_in_range on public.tax_rules is
  'B-02: la general PROPIA de una empresa está en el rango del catálogo (art. 27). Las de '
  'plataforma (company_id nulo) las siembra el sistema o un test, y no pasan por aquí.';

-- ── 6. Las empresas que ya aceptaron su general ──────────────────────────────
-- Con datos vivos: solo se AÑADEN reglas (reducida, exenta, adicional) desde hoy, con la cita del
-- catálogo. Nada existente cambia. Una general propia fuera de rango (no debería haberla) no
-- recibe nada: la corrige su dueño aceptando de nuevo.
select platform.seed_catalog_tax_rules(g.company_id, g.rate,
                                       (now() at time zone 'America/Caracas')::date)
  from (select distinct on (r.company_id) r.company_id, r.rate
          from public.tax_rules r
         where r.company_id is not null and r.status = 'active'
           and r.jurisdiction = 'VE' and r.tax_code = 'iva' and r.taxpayer_type is null
           and r.product_tax_category = 'gravado_general' and r.transaction_type = 'sale'
           and r.effective_from <= (now() at time zone 'America/Caracas')::date
           and (r.effective_to is null
                or r.effective_to > (now() at time zone 'America/Caracas')::date)
           and r.rate between 0.08 and 0.165
         order by r.company_id, r.effective_from desc) g;

-- ── 7. El libro de ventas por alícuota y su resumen (L-08) ───────────────────
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
  base_alicuota_reducida numeric, iva_alicuota_reducida numeric, alicuota_reducida numeric
)
language sql
stable
set search_path = ''
as $$
  -- El renglón de `sales_book` tal cual (mismo signo, misma anulada en cero), más la base y el
  -- IVA de cada alícuota, leídos de la CATEGORÍA CONGELADA en la línea (ADR-0044 §1) y con el
  -- IVA derivado como total − subtotal funcionales, igual que el documento y la planilla.
  select s.document_id, s.issued_on, s.kind, s.series, s.document_number, s.control_number,
         s.status, s.customer_tax_id, s.customer_name, s.customer_taxpayer_type,
         s.transaction_currency, s.fx_rate, s.base_gravada, s.iva_debito, s.base_exenta,
         s.base_exonerada, s.base_no_sujeta, s.base_sin_clasificar, s.total_amount,
         s.journal_entry_id,
         r.base_g, r.iva_g, r.rate_g, r.base_a, r.iva_a, r.rate_a, r.base_r, r.iva_r, r.rate_r
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
        max(dl.tax_rate_snapshot) filter (where dl.tax_category_snapshot = 'gravado_reducida') as rate_r
        from public.document_lines dl
       where dl.document_id = s.document_id
    ) r
   order by s.ordinality
$$;
comment on function platform.sales_book_by_rate(uuid, date, date) is
  'Libro de ventas con la base y el IVA POR ALÍCUOTA (general, general + adicional, reducida), '
  'como pide el RLIVA arts. 72 y 76 (L-08). Mismo renglón y signo que sales_book.';
revoke execute on function platform.sales_book_by_rate(uuid, date, date) from public;
grant execute on function platform.sales_book_by_rate(uuid, date, date) to authenticated, ladino_api;

create function platform.sales_book_summary(p_company uuid, p_from date, p_to date)
returns table (concept text, rate numeric, base numeric, tax numeric,
               adjustments_base numeric, adjustments_tax numeric, documents bigint)
language sql
stable
set search_path = ''
as $$
  -- El RESUMEN del art. 72 del RLIVA: base e impuesto por alícuota, las exentas, exoneradas y no
  -- sujetas, y la parte que viene de notas de crédito y débito (ajustes). Mismo signo que el
  -- libro; lo anulado no suma. Lo emitido antes de la migración 27 va a `sin_clasificar`.
  select x.concept, x.rate, sum(x.base), sum(x.tax),
         coalesce(sum(x.base) filter (where x.kind <> 'invoice'), 0),
         coalesce(sum(x.tax) filter (where x.kind <> 'invoice'), 0),
         count(distinct x.doc)
    from (
      select case when dl.tax_treatment = 'gravado'
                    then coalesce(dl.tax_category_snapshot, 'gravado')
                  when dl.tax_treatment is null then 'sin_clasificar'
                  else dl.tax_treatment end as concept,
             case when dl.tax_treatment = 'gravado' then dl.tax_rate_snapshot end as rate,
             dl.line_subtotal_functional * f.factor as base,
             (dl.line_total_functional - dl.line_subtotal_functional) * f.factor as tax,
             d.kind, d.id as doc
        from public.documents d
        join public.document_lines dl on dl.document_id = d.id
        cross join lateral (
          select case when d.kind = 'credit_note' then -1 else 1 end as factor) f
       where d.company_id = p_company
         and d.kind in ('invoice', 'credit_note', 'debit_note')
         and d.status in ('issued', 'paid')
         and platform.caracas_day(d.issued_at) between p_from and p_to
    ) x
   group by x.concept, x.rate
   order by case x.concept when 'gravado_general' then 1 when 'gravado_adicional' then 2
                           when 'gravado_reducida' then 3 when 'exento' then 4
                           when 'exonerado' then 5 when 'no_sujeto' then 6 else 7 end,
            x.rate
$$;
comment on function platform.sales_book_summary(uuid, date, date) is
  'Resumen del libro de ventas (RLIVA art. 72, L-08): base e IVA por alícuota, exentas, '
  'exoneradas, no sujetas y ajustes por notas. Exportaciones: Ladino no las implementa '
  '(VALIDAR-SENIAT), no aparecen.';
revoke execute on function platform.sales_book_summary(uuid, date, date) from public;
grant execute on function platform.sales_book_summary(uuid, date, date) to authenticated, ladino_api;

-- =============================================================================
-- Reversibilidad (con datos vivos)
--
-- SÍ, hacia adelante y sin perder nada:
--   · Las plantillas y los literales son catálogo: una migración nueva los desactiva o los
--     corrige (UPDATE de la fila, o `offered_in_sales = false`). No hay FK que apunte a ellas.
--   · Las reglas que el §6 añade a las empresas existentes llevan la cita del catálogo en
--     `legal_source` y `created_by` nulo: se retiran con `status = 'inactive'`. Las líneas ya
--     emitidas con ellas conservan su copia de la regla y su alícuota (ADR-0038): no cambia un
--     céntimo de lo emitido. NO se borran (FK de document_lines.tax_rule_id).
--   · Las vigencias que cierre `accept_general_vat` se reabren poniendo `effective_to = null`
--     en la anterior y `status = 'inactive'` en la nueva.
--   · Las funciones y el trigger se retiran con `drop`; `sales_book` no se tocó.
-- =============================================================================

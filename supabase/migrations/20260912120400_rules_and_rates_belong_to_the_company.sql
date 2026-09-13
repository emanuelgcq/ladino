-- =============================================================================
-- Migración 52 · LO MANUAL ES DE CADA EMPRESA; LO OFICIAL, DE LA PLATAFORMA
--
-- Módulos: ventas · compras · puesta a punto fiscal · RLS. Rigor máximo
-- (fiscal, aislamiento multi-tenant). ADR-0057. Hallazgo A-22 de la auditoría
-- del 2026-09-11.
--
-- `tax_rules`, `exchange_rates` y `retention_rules` eran globales y las
-- escribían permisos DE EMPRESA: una empresa tecleaba una tasa de 1,00 y todas
-- emitían con ella; la primera que aceptaba la alícuota la fijaba para la
-- instancia; una regla de retención de un tenant retenía a todos.
--
-- Cada fila declara ahora de quién es: `tenant_id`+`company_id` nulos = de la
-- plataforma (BCV oficial, siembras del sistema); con valor = de esa empresa.
-- Lo propio gana a lo de la plataforma. Las firmas SIN empresa de rate_at,
-- resolve_tax y resolve_retention se ELIMINAN: una lectura sin empresa no
-- devuelve la tasa de otro, falla al compilar.
--
-- Expand/contract: la API saliente llama a las firmas viejas (hoy eliminadas)
-- y no manda company_id en sus inserts. Esta migración se aplica en la MISMA
-- ventana que el despliegue de la API nueva (HANDOFF lo dice). Reversible con
-- otra migración: quitar columnas y policies y recrear las firmas viejas; las
-- filas atribuidas a una empresa vuelven a ser globales sin perder datos.
-- HOMOLOGATION_IMPACT: SÍ (qué regla y qué tasa resuelve cada empresa; no el
-- cálculo ni el formato).
-- =============================================================================

-- ── 0. Quién es el actor de sistema ──────────────────────────────────────────
create or replace function platform.ladino_actor_is_system()
returns boolean
language sql
stable security definer
set search_path = ''
as $$
  select platform.ladino_service_actor_id() = '00000000-0000-4000-8000-000000000000'::uuid;
$$;
comment on function platform.ladino_actor_is_system() is
  'Verdadero cuando withTransaction() corre con actor de SISTEMA (jobs, refresco '
  'del BCV). Es el único que puede escribir filas de plataforma en las tablas de '
  'reglas y tasas (ADR-0057).';
revoke execute on function platform.ladino_actor_is_system() from public;
grant execute on function platform.ladino_actor_is_system() to ladino_api;

-- ── 1. Las columnas de pertenencia, ambas o ninguna ──────────────────────────
alter table public.exchange_rates
  add column tenant_id  uuid,
  add column company_id uuid,
  add constraint exchange_rates_scope_chk
    check ((tenant_id is null) = (company_id is null)),
  add constraint exchange_rates_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id);
alter table public.tax_rules
  add column tenant_id  uuid,
  add column company_id uuid,
  add constraint tax_rules_scope_chk
    check ((tenant_id is null) = (company_id is null)),
  add constraint tax_rules_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id);
alter table public.retention_rules
  add column tenant_id  uuid,
  add column company_id uuid,
  add constraint retention_rules_scope_chk
    check ((tenant_id is null) = (company_id is null)),
  add constraint retention_rules_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id);

comment on column public.exchange_rates.company_id is
  'NULL = tasa de la PLATAFORMA (BCV oficial, sistema). Con valor = tasa propia de '
  'esa empresa (tecleada, confirmada). Lo propio gana a lo oficial del mismo día '
  '(ADR-0057).';
comment on column public.tax_rules.company_id is
  'NULL = regla de la PLATAFORMA (siembra del sistema). Con valor = regla propia de '
  'esa empresa (alícuota aceptada en el asistente). Si la empresa tiene reglas '
  'propias vigentes, resolve_tax solo mira las suyas (ADR-0057).';
comment on column public.retention_rules.company_id is
  'NULL = regla de la PLATAFORMA. Con valor = regla propia de esa empresa. Si la '
  'empresa tiene reglas propias vigentes, resolve_retention solo mira las suyas '
  '(ADR-0057).';

-- ── 2. Lo ya cargado se atribuye a quien lo cargó ───────────────────────────
-- Cada fila con autor pasa a la ÚNICA empresa de ese autor. Las tasas cuya
-- fuente es la oficial del BCV y las filas sin autor quedan en la plataforma;
-- un autor con varias empresas también deja la fila en la plataforma:
-- atribuirla a una sería inventar. Va ANTES del trigger de ancla, que a partir
-- de aquí prohíbe cambiar la pertenencia.
update public.exchange_rates r
   set tenant_id = o.tenant_id, company_id = o.company_id
  from (select r2.id, min(c.tenant_id::text)::uuid as tenant_id, min(c.id::text)::uuid as company_id
          from public.exchange_rates r2
          join public.companies c
            on c.id in (select platform.ladino_user_company_ids(r2.created_by))
         where r2.created_by is not null
           and r2.source not like 'BCV oficial vía DolarAPI%'
         group by r2.id
        having count(*) = 1) o
 where o.id = r.id;

update public.tax_rules t
   set tenant_id = o.tenant_id, company_id = o.company_id
  from (select t2.id, min(c.tenant_id::text)::uuid as tenant_id, min(c.id::text)::uuid as company_id
          from public.tax_rules t2
          join public.companies c
            on c.id in (select platform.ladino_user_company_ids(t2.created_by))
         where t2.created_by is not null
         group by t2.id
        having count(*) = 1) o
 where o.id = t.id;

update public.retention_rules r
   set tenant_id = o.tenant_id, company_id = o.company_id
  from (select r2.id, min(c.tenant_id::text)::uuid as tenant_id, min(c.id::text)::uuid as company_id
          from public.retention_rules r2
          join public.companies c
            on c.id in (select platform.ladino_user_company_ids(r2.created_by))
         where r2.created_by is not null
         group by r2.id
        having count(*) = 1) o
 where o.id = r.id;

-- ── 3. El ancla inmutable, como en toda tabla con tenant_id (test 006) ──────
create trigger exchange_rates_01_anchors
  before update on public.exchange_rates
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger tax_rules_01_anchors
  before update on public.tax_rules
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger retention_rules_01_anchors
  before update on public.retention_rules
  for each row execute function platform.assert_isolation_anchors_immutable();

-- ── 4. Unicidad por par, fuente, día Y ámbito ────────────────────────────────
-- El nombre se conserva: `on conflict on constraint exchange_rates_day_key`
-- sigue siendo válido en la API y en los tests.
alter table public.exchange_rates
  add column scope_key uuid generated always as
    (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored;
alter table public.exchange_rates drop constraint exchange_rates_day_key;
alter table public.exchange_rates
  add constraint exchange_rates_day_key
    unique (from_currency, to_currency, source, rate_date, scope_key);
comment on column public.exchange_rates.scope_key is
  'company_id, o el uuid cero para la plataforma: la parte del único por par, '
  'fuente y día que permite a dos empresas teclear su propia tasa del mismo día.';

create index exchange_rates_scope_lookup_idx
  on public.exchange_rates (company_id, from_currency, to_currency, rate_date desc);
create index tax_rules_scope_idx on public.tax_rules (company_id) where company_id is not null;
create index retention_rules_scope_idx
  on public.retention_rules (company_id) where company_id is not null;

-- ── 5. La tasa vigente PARA UNA EMPRESA ─────────────────────────────────────
drop function platform.rate_at(text, text, date, text);

create function platform.rate_for(
  p_company uuid, p_from text, p_to text, p_fecha date, p_source text default null)
returns table (rate numeric, source text, rate_date date, rate_timestamp timestamptz)
language sql
stable
set search_path = ''
as $$
  select r.rate, r.source, r.rate_date, r.rate_timestamp
    from public.exchange_rates r
   where r.from_currency = p_from and r.to_currency = p_to
     and r.rate_date <= p_fecha
     and (r.company_id is null or r.company_id = p_company)
     and (p_source is null or r.source = p_source)
   order by r.rate_date desc, (r.company_id is not null) desc, r.created_at desc
   limit 1
$$;
comment on function platform.rate_for(uuid, text, text, date, text) is
  'LA tasa vigente a la fecha para la empresa: la más reciente que no sea '
  'posterior; a igual día, la propia antes que la de la plataforma; a igual '
  'todo, la más recientemente creada (ADR-0057). Security INVOKER: la RLS de '
  'exchange_rates es la que decide qué filas existen para quien pregunta.';
revoke execute on function platform.rate_for(uuid, text, text, date, text) from public;
grant execute on function platform.rate_for(uuid, text, text, date, text)
  to authenticated, ladino_api;

create function platform.rate_at(
  p_company uuid, p_from text, p_to text, p_fecha date, p_source text default null)
returns numeric
language sql
stable
set search_path = ''
as $$
  select f.rate from platform.rate_for(p_company, p_from, p_to, p_fecha, p_source) f
$$;
comment on function platform.rate_at(uuid, text, text, date, text) is
  'rate_for() reducido al número. Fecha PARÁMETRO, nunca now(); empresa '
  'PARÁMETRO, nunca «la última de cualquiera» (ADR-0020, ADR-0057).';
revoke execute on function platform.rate_at(uuid, text, text, date, text) from public;
grant execute on function platform.rate_at(uuid, text, text, date, text)
  to authenticated, ladino_api;

-- Las dos funciones de saldo de la migración 48 llamaban a la firma eliminada:
-- se recrean pasando la empresa (mismo cuerpo, ADR-0054 intacto).
create or replace function platform.document_balance_transaction(p_company uuid, p_document uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_doc record;
  v_paid numeric := 0;
  v_p record;
  v_rate numeric;
begin
  select d.id, d.transaction_currency, d.functional_currency,
         d.amount_transaction_currency
    into v_doc
    from public.documents d
   where d.id = p_document and d.company_id = p_company
     and d.status in ('issued', 'paid');
  if not found then return null; end if;

  for v_p in
    select p.currency, p.amount, p.functional_amount,
           platform.caracas_day(p.paid_at) as paid_on
      from public.payments p where p.document_id = v_doc.id
  loop
    if v_p.currency = v_doc.transaction_currency then
      v_paid := v_paid + v_p.amount;
    else
      v_rate := platform.rate_at(p_company, v_doc.transaction_currency,
                                 v_doc.functional_currency, v_p.paid_on);
      if v_rate is null then
        raise exception
          'no hay tasa % → % vigente al % para valorar un cobro: cárgala con su fuente',
          v_doc.transaction_currency, v_doc.functional_currency, v_p.paid_on
          using errcode = 'LAD51';
      end if;
      v_paid := v_paid + round(v_p.functional_amount / v_rate, 8);
    end if;
  end loop;

  return v_doc.amount_transaction_currency - v_paid;
end;
$$;

create or replace function platform.document_debt_today(p_company uuid, p_document uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_doc record;
  v_rate numeric;
begin
  select d.transaction_currency, d.functional_currency
    into v_doc
    from public.documents d
   where d.id = p_document and d.company_id = p_company
     and d.status in ('issued', 'paid');
  if not found then return null; end if;

  if v_doc.transaction_currency = v_doc.functional_currency then
    return platform.document_balance(p_company, p_document);
  end if;

  v_rate := platform.rate_at(p_company, v_doc.transaction_currency, v_doc.functional_currency,
                             platform.caracas_day(now()));
  if v_rate is null then
    raise exception
      'no hay tasa % → % vigente hoy para valorar la deuda: cárgala con su fuente',
      v_doc.transaction_currency, v_doc.functional_currency
      using errcode = 'LAD51';
  end if;
  return round(platform.document_balance_transaction(p_company, p_document) * v_rate, 8);
end;
$$;

-- ── 6. La regla tributaria PARA UNA EMPRESA ─────────────────────────────────
drop function platform.resolve_tax(date, text, text, text, text, text);

create function platform.resolve_tax(
  p_company      uuid,
  p_fecha        date,
  p_jurisdiction text,
  p_tax_code     text,
  p_taxpayer     text,
  p_category     text,
  p_transaction  text default 'sale'
)
returns table (tax_rule_id uuid, rate numeric, legal_source text)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_propia boolean;
  v_n integer;
begin
  -- El NIVEL: si la empresa tiene alguna regla propia vigente para este hecho,
  -- se resuelve solo entre las suyas; si no, solo entre las de la plataforma.
  select exists (
    select 1 from public.tax_rules t
     where t.status = 'active' and t.company_id = p_company
       and t.jurisdiction = p_jurisdiction and t.tax_code = p_tax_code
       and t.transaction_type = p_transaction
       and t.effective_from <= p_fecha
       and (t.effective_to is null or t.effective_to > p_fecha)
       and (t.taxpayer_type is null or t.taxpayer_type = p_taxpayer)
       and (t.product_tax_category is null or t.product_tax_category = p_category))
    into v_propia;

  select count(*) into v_n
    from public.tax_rules t
   where t.status = 'active'
     and ((v_propia and t.company_id = p_company) or (not v_propia and t.company_id is null))
     and t.jurisdiction = p_jurisdiction
     and t.tax_code = p_tax_code
     and t.transaction_type = p_transaction
     and t.effective_from <= p_fecha
     and (t.effective_to is null or t.effective_to > p_fecha)
     and (t.taxpayer_type is null or t.taxpayer_type = p_taxpayer)
     and (t.product_tax_category is null or t.product_tax_category = p_category)
     and t.priority = (
       select max(t2.priority) from public.tax_rules t2
        where t2.status = 'active'
          and ((v_propia and t2.company_id = p_company) or (not v_propia and t2.company_id is null))
          and t2.jurisdiction = p_jurisdiction
          and t2.tax_code = p_tax_code and t2.transaction_type = p_transaction
          and t2.effective_from <= p_fecha
          and (t2.effective_to is null or t2.effective_to > p_fecha)
          and (t2.taxpayer_type is null or t2.taxpayer_type = p_taxpayer)
          and (t2.product_tax_category is null or t2.product_tax_category = p_category));

  if v_n = 0 then
    raise exception
      'no hay regla tributaria vigente para % / % el % (contraparte %, categoría %): cárgala en tax_rules con su fuente legal antes de emitir',
      p_jurisdiction, p_tax_code, p_fecha, p_taxpayer, p_category
      using errcode = 'LAD50',
            hint = 'ADR-0038: el catálogo nace vacío a propósito; sin regla no hay emisión';
  end if;
  if v_n > 1 then
    raise exception
      'hay % reglas tributarias con la MISMA prioridad para % / % el %: el catálogo es ambiguo y el sistema no puede elegir',
      v_n, p_jurisdiction, p_tax_code, p_fecha
      using errcode = 'LAD50',
            hint = 'ajusta `priority` para que una regla sea más específica que la otra';
  end if;

  return query
    select t.id, t.rate, t.legal_source
      from public.tax_rules t
     where t.status = 'active'
       and ((v_propia and t.company_id = p_company) or (not v_propia and t.company_id is null))
       and t.jurisdiction = p_jurisdiction
       and t.tax_code = p_tax_code
       and t.transaction_type = p_transaction
       and t.effective_from <= p_fecha
       and (t.effective_to is null or t.effective_to > p_fecha)
       and (t.taxpayer_type is null or t.taxpayer_type = p_taxpayer)
       and (t.product_tax_category is null or t.product_tax_category = p_category)
     order by t.priority desc
     limit 1;
end;
$$;
comment on function platform.resolve_tax(uuid, date, text, text, text, text, text) is
  'La regla tributaria vigente PARA LA EMPRESA, o LAD50. Si tiene reglas propias '
  'vigentes solo cuentan las suyas; si no, las de la plataforma (ADR-0057). Dentro '
  'del nivel, lo específico gana por `priority` y la ambigüedad falla (ADR-0038). '
  'NUNCA devuelve cero.';
revoke execute on function platform.resolve_tax(uuid, date, text, text, text, text, text) from public;
grant execute on function platform.resolve_tax(uuid, date, text, text, text, text, text)
  to authenticated, ladino_api;

-- ── 7. La regla de retención PARA UNA EMPRESA ───────────────────────────────
drop function platform.resolve_retention(date, text, text, text, text, text);

create function platform.resolve_retention(
  p_company      uuid,
  p_fecha        date,
  p_jurisdiction text,
  p_retention    text,
  p_concept      text,
  p_taxpayer     text,
  p_person_type  text
)
returns table (
  retention_rule_id uuid, formula_kind text, rate numeric,
  subtrahend numeric, minimum_exempt numeric, legal_source text
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_propia boolean;
  v_n integer;
begin
  select exists (
    select 1 from public.retention_rules r
     where r.status = 'active' and r.company_id = p_company
       and r.jurisdiction = p_jurisdiction and r.retention_code = p_retention
       and r.concept_code = p_concept
       and r.effective_from <= p_fecha
       and (r.effective_to is null or r.effective_to > p_fecha)
       and (r.taxpayer_type is null or r.taxpayer_type = p_taxpayer)
       and (r.supplier_person_type is null or r.supplier_person_type = p_person_type))
    into v_propia;

  select count(*) into v_n
    from public.retention_rules r
   where r.status = 'active'
     and ((v_propia and r.company_id = p_company) or (not v_propia and r.company_id is null))
     and r.jurisdiction = p_jurisdiction
     and r.retention_code = p_retention
     and r.concept_code = p_concept
     and r.effective_from <= p_fecha
     and (r.effective_to is null or r.effective_to > p_fecha)
     and (r.taxpayer_type is null or r.taxpayer_type = p_taxpayer)
     and (r.supplier_person_type is null or r.supplier_person_type = p_person_type)
     and r.priority = (
       select max(r2.priority) from public.retention_rules r2
        where r2.status = 'active'
          and ((v_propia and r2.company_id = p_company) or (not v_propia and r2.company_id is null))
          and r2.jurisdiction = p_jurisdiction
          and r2.retention_code = p_retention and r2.concept_code = p_concept
          and r2.effective_from <= p_fecha
          and (r2.effective_to is null or r2.effective_to > p_fecha)
          and (r2.taxpayer_type is null or r2.taxpayer_type = p_taxpayer)
          and (r2.supplier_person_type is null or r2.supplier_person_type = p_person_type));

  if v_n = 0 then
    raise exception
      'no hay regla de retención vigente para % / % el % (contraparte %, persona %): cárgala en retention_rules con su fuente legal antes de retener',
      p_retention, p_concept, p_fecha, p_taxpayer, p_person_type
      using errcode = 'LAD53',
            hint = 'ADR-0039: el catálogo nace vacío a propósito; sin regla no se retiene, y retener cero sería deber al fisco en silencio';
  end if;
  if v_n > 1 then
    raise exception
      'hay % reglas de retención con la MISMA prioridad para % / % el %: el catálogo es ambiguo y el sistema no puede elegir',
      v_n, p_retention, p_concept, p_fecha
      using errcode = 'LAD53',
            hint = 'ajusta `priority` para que una regla sea más específica que la otra';
  end if;

  return query
    select r.id, r.formula_kind, r.rate, r.subtrahend, r.minimum_exempt, r.legal_source
      from public.retention_rules r
     where r.status = 'active'
       and ((v_propia and r.company_id = p_company) or (not v_propia and r.company_id is null))
       and r.jurisdiction = p_jurisdiction
       and r.retention_code = p_retention
       and r.concept_code = p_concept
       and r.effective_from <= p_fecha
       and (r.effective_to is null or r.effective_to > p_fecha)
       and (r.taxpayer_type is null or r.taxpayer_type = p_taxpayer)
       and (r.supplier_person_type is null or r.supplier_person_type = p_person_type)
     order by r.priority desc
     limit 1;
end;
$$;
comment on function platform.resolve_retention(uuid, date, text, text, text, text, text) is
  'La regla de retención vigente PARA LA EMPRESA, o LAD53. Si tiene reglas propias '
  'vigentes solo cuentan las suyas; si no, las de la plataforma (ADR-0057). Dentro '
  'del nivel, prioridad y ambigüedad como ADR-0039.';
revoke execute on function platform.resolve_retention(uuid, date, text, text, text, text, text)
  from public;
grant execute on function platform.resolve_retention(uuid, date, text, text, text, text, text)
  to authenticated, ladino_api;

-- ── 8. La base decide quién escribe qué ─────────────────────────────────────
-- Lectura: la plataforma + lo propio. Escritura con empresa: dentro de los
-- tenants del actor. Escritura de plataforma: solo el actor de sistema.
drop policy tax_rules_select on public.tax_rules;
create policy tax_rules_select on public.tax_rules for select to authenticated
  using (company_id is null or company_id in (select platform.ladino_company_ids()));
create policy tax_rules_api_select on public.tax_rules for select to ladino_api
  using (company_id is null or tenant_id in (select platform.ladino_service_tenant_ids()));
drop policy tax_rules_api_insert on public.tax_rules;
create policy tax_rules_api_insert on public.tax_rules for insert to ladino_api
  with check ((company_id is not null and tenant_id in (select platform.ladino_service_tenant_ids()))
              or (company_id is null and platform.ladino_actor_is_system()));
drop policy tax_rules_api_update on public.tax_rules;
create policy tax_rules_api_update on public.tax_rules for update to ladino_api
  using (company_id is not null and tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (company_id is not null and tenant_id in (select platform.ladino_service_tenant_ids()));

drop policy exchange_rates_select on public.exchange_rates;
create policy exchange_rates_select on public.exchange_rates for select to authenticated
  using (company_id is null or company_id in (select platform.ladino_company_ids()));
create policy exchange_rates_api_select on public.exchange_rates for select to ladino_api
  using (company_id is null or tenant_id in (select platform.ladino_service_tenant_ids()));
drop policy exchange_rates_api_insert on public.exchange_rates;
create policy exchange_rates_api_insert on public.exchange_rates for insert to ladino_api
  with check ((company_id is not null and tenant_id in (select platform.ladino_service_tenant_ids()))
              or (company_id is null and platform.ladino_actor_is_system()));

drop policy retention_rules_select on public.retention_rules;
create policy retention_rules_select on public.retention_rules for select to authenticated
  using (company_id is null or company_id in (select platform.ladino_company_ids()));
create policy retention_rules_api_select on public.retention_rules for select to ladino_api
  using (company_id is null or tenant_id in (select platform.ladino_service_tenant_ids()));
drop policy retention_rules_api_insert on public.retention_rules;
create policy retention_rules_api_insert on public.retention_rules for insert to ladino_api
  with check ((company_id is not null and tenant_id in (select platform.ladino_service_tenant_ids()))
              or (company_id is null and platform.ladino_actor_is_system()));
drop policy retention_rules_api_update on public.retention_rules;
create policy retention_rules_api_update on public.retention_rules for update to ladino_api
  using (company_id is not null and tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (company_id is not null and tenant_id in (select platform.ladino_service_tenant_ids()));

comment on table public.exchange_rates is
  'Tasas con FUENTE, FECHA y DUEÑO (ADR-0020, ADR-0057). company_id nulo = oficial '
  'de la plataforma (BCV); con valor = propia de la empresa, que gana a la oficial '
  'del mismo día. La emisión consume la vigente al día para la empresa; si no hay, '
  'RECHAZA (LAD51).';
comment on table public.tax_rules is
  'Reglas tributarias con vigencia y fuente legal. NACEN VACÍAS (ADR-0038). '
  'company_id nulo = de la plataforma; con valor = de la empresa que las aceptó, '
  'y para esa empresa ocultan a las de la plataforma (ADR-0057).';
comment on table public.retention_rules is
  'Reglas de retención con vigencia y fuente legal. NACE VACÍA (ADR-0039): sin '
  'regla no se retiene. company_id nulo = de la plataforma; con valor = de la '
  'empresa que la cargó, y para ella ocultan a las de la plataforma (ADR-0057).';

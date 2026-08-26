-- =============================================================================
-- Ladino — migración 18 · Clientes (segundo maestro) — ADR-0033, D-1..D-14
--
-- Módulo: customers   Spec: docs/03_MODULES/CUSTOMERS_CRM_SPEC.md · ADR-0033
-- Reversible: SÍ mientras las tablas estén vacías; las filas de auditoría que
--             deje un cambio de RIF no se revierten (append-only, es el punto).
-- Homologación: NO (clasificación referencial sin tasas; RIF sin validación de formato)
--
-- ALCANCE (D-1..D-14): el cliente por company, con UNA dirección fiscal inline,
-- email y teléfono inline, lista de precios preferida opcional. FUERA de este
-- maestro, con razón: contactos y direcciones múltiples (ventas/logística),
-- perfiles de crédito (módulo de crédito, dueño natural del esquema), etiquetas,
-- y la unificación cliente/proveedor en un «party» (R-12 en RISK_REGISTER,
-- disparador: el módulo de proveedores).
--
-- DOS EJES FISCALES, DOS CATÁLOGOS, CERO TASAS (ADR-0033): taxpayer_types (lo
-- que el motor tributario cruzará con tax_rules.taxpayer_type) y person_types.
-- Son ejes independientes —ISLR mira persona y residencia, IVA mira la
-- designación de especial— y fundirlos obliga a un producto cartesiano. El
-- «agente de retención» NO es un booleano: se deriva de taxpayer_type cuando
-- exista el motor; dos campos para el mismo hecho divergen.
--
-- EL RIF: sin validación de formato (OPEN_QUESTIONS 9; la migración 10 hizo lo
-- mismo con companies — inventar un regex es inventar una obligación legal),
-- nullable SOLO para persona natural, único PARCIAL por company, y su cambio
-- es el patrón M4 completo: permiso propio + trigger que deja el VALOR
-- ANTERIOR en la auditoría (LAD36, reservado en ERROR_CATALOG.md).
-- =============================================================================

-- ── 1. Catálogos GLOBALES (sin tenant_id: la excepción declarada de permissions) ──

create table public.taxpayer_types (
  code        text        primary key,
  name        text        not null,
  description text        not null,
  status      text        not null default 'active',
  created_at  timestamptz not null default now(),
  constraint taxpayer_types_code_chk   check (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint taxpayer_types_status_chk check (status in ('active', 'inactive'))
);
comment on table public.taxpayer_types is
  'Clasificación del SUJETO PASIVO (TAX_ENGINE_SPEC: tax_rules.taxpayer_type '
  'apunta aquí). Sin tasa ni regla: el motor tributario las cruzará con '
  'vigencia y fuente legal. Seed VALIDAR-TRIBUTARIO (ADR-0033).';

create table public.person_types (
  code        text        primary key,
  name        text        not null,
  description text        not null,
  status      text        not null default 'active',
  created_at  timestamptz not null default now(),
  constraint person_types_code_chk   check (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint person_types_status_chk check (status in ('active', 'inactive'))
);
comment on table public.person_types is
  'Tipo de persona de la contraparte. Eje INDEPENDIENTE de taxpayer_types: '
  'ISLR mira persona y residencia; IVA mira la designación de especial '
  '(ADR-0033).';

-- ── 2. El cliente ────────────────────────────────────────────────────────────

create table public.customers (
  id                    uuid        primary key default platform.uuidv7(),
  tenant_id             uuid        not null,
  company_id            uuid        not null,

  -- El RIF. Texto libre SIN formato (VALIDAR-SENIAT); nullable solo para
  -- persona natural; único parcial por company (índice abajo). Cambiarlo es
  -- M4: permiso propio + auditoría con valor anterior.
  tax_id                text,
  legal_name            text        not null,
  trade_name            text,
  person_type_code      text        not null,
  taxpayer_type_code    text        not null,
  fiscal_address        text,
  email                 text,
  phone                 text,
  status                text        not null default 'active',
  default_price_list_id uuid,

  created_by            uuid,
  created_at            timestamptz not null,
  version               integer     not null,

  constraint customers_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint customers_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint customers_person_type_fk
    foreign key (person_type_code) references public.person_types (code),
  constraint customers_taxpayer_type_fk
    foreign key (taxpayer_type_code) references public.taxpayer_types (code),
  -- Compuesto por company: una lista de precios de OTRA company no se puede
  -- preferir (la misma defensa que products ↔ price_lists).
  constraint customers_default_price_list_fk
    foreign key (company_id, default_price_list_id) references public.price_lists (company_id, id),

  constraint customers_tax_id_chk
    check (tax_id is null or (tax_id = btrim(tax_id) and length(tax_id) between 1 and 30)),
  -- D-2: sin RIF solo una persona natural. Una jurídica sin RIF es un error.
  constraint customers_tax_id_required_chk
    check (tax_id is not null or person_type_code = 'natural'),
  constraint customers_legal_name_chk
    check (legal_name = btrim(legal_name) and length(legal_name) between 1 and 200),
  constraint customers_trade_name_chk
    check (trade_name is null or (trade_name = btrim(trade_name) and length(trade_name) between 1 and 200)),
  constraint customers_fiscal_address_chk
    check (fiscal_address is null or (fiscal_address = btrim(fiscal_address) and length(fiscal_address) between 1 and 500)),
  constraint customers_email_chk
    check (email is null or (email = btrim(email) and length(email) between 3 and 254 and position('@' in email) > 1)),
  constraint customers_phone_chk
    check (phone is null or (phone = btrim(phone) and length(phone) between 3 and 40)),
  constraint customers_status_chk
    check (status in ('lead', 'active', 'blocked', 'inactive')),
  constraint customers_company_id_key unique (company_id, id)
);
comment on table public.customers is
  'Clientes (contrapartes de venta), por company (D-1). Sin crédito, sin '
  'contactos múltiples, sin direcciones múltiples: ADR-0033 §Alcance. Los '
  'documentos fiscales COPIAN razón social, RIF y domicilio al emitir (R-05), '
  'nunca los referencian.';
comment on column public.customers.tax_id is
  'RIF/cédula. Sin validación de formato (VALIDAR-SENIAT, OPEN_QUESTIONS 9). '
  'Nullable solo para persona natural. Único PARCIAL por company '
  '(case-insensitive). Cambiarlo exige customer.tax_id.manage y deja el valor '
  'anterior en audit_events (trigger M4, LAD36).';
comment on column public.customers.taxpayer_type_code is
  'Clasificación del sujeto pasivo (taxpayer_types). NUNCA una regla ni una '
  'tasa aquí; «agente de retención» se DERIVA de esto cuando exista el motor.';

-- Único PARCIAL por company: dos sin RIF conviven; dos con el mismo (en
-- cualquier combinación de mayúsculas) no. Ejercido en pgTAP 018.
create unique index customers_company_tax_id_uidx
  on public.customers (company_id, upper(tax_id)) where tax_id is not null;
create index customers_tenant_company_idx on public.customers (tenant_id, company_id);
create index customers_company_status_idx on public.customers (company_id, status);
create index customers_company_name_idx on public.customers (company_id, lower(legal_name));

-- ── 3. Triggers: procedencia, anclas y el M4 del RIF ────────────────────────

create trigger customers_provenance
  before insert or update on public.customers
  for each row execute function platform.set_row_provenance();
create trigger customers_anchors_immutable
  before update on public.customers
  for each row execute function platform.assert_isolation_anchors_immutable();

-- M4 para clientes (la excepción consciente a ADR-0026 D2 explicada en la
-- migración 10: la intención está determinada por el dato, y la red existe
-- porque la capa de aplicación es la que puede olvidarse). El permiso se exige
-- solo con JWT presente: en el camino de servidor responde la API
-- (companyScope + customer.tax_id.manage). Devuelve el VALOR ANTERIOR.
create function platform.audit_customer_tax_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  v_actor := coalesce(auth.uid(), nullif(current_setting('ladino.actor_id', true), '')::uuid);

  if tg_op = 'INSERT' then
    if new.tax_id is null then return null; end if;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values
      (new.tenant_id, new.company_id, 'customer', new.id, 'customer.tax_id_established',
       case when v_actor is null then 'system' else 'user' end, now(),
       coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-guard'),
       jsonb_build_object('tax_id', new.tax_id, 'legal_name', new.legal_name));
    return null;
  end if;

  if auth.uid() is not null
     and not platform.ladino_has_permission('customer.tax_id.manage', new.company_id) then
    raise exception
      'LADINO_RIF_CLIENTE_SIN_PERMISO: cambiar el RIF de un cliente exige el permiso '
      'customer.tax_id.manage, distinto de customer.manage.'
      using errcode = 'LAD36',
            hint = 'Conceda customer.tax_id.manage en la company, o use el caso de uso de la API.';
  end if;

  insert into public.audit_events
    (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
     actor_type, occurred_at, rules_version, payload)
  values
    (new.tenant_id, new.company_id, 'customer', new.id, 'customer.tax_id_changed',
     case when v_actor is null then 'system' else 'user' end, now(),
     coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-guard'),
     jsonb_build_object(
       'tax_id_anterior', old.tax_id,
       'tax_id_nuevo',    new.tax_id,
       'legal_name',      new.legal_name));
  return null;
end;
$$;
comment on function platform.audit_customer_tax_id() is
  'M4 para clientes: alta con RIF → customer.tax_id_established; cambio de '
  'RIF → customer.tax_id_changed CON EL VALOR ANTERIOR, exigiendo '
  'customer.tax_id.manage cuando hay JWT (LAD36). Red del esquema, no '
  'sustituto de la auditoría del caso de uso (ADR-0033).';
revoke execute on function platform.audit_customer_tax_id() from public;

create trigger customers_audit_tax_id_insert
  after insert on public.customers
  for each row execute function platform.audit_customer_tax_id();
create trigger customers_audit_tax_id
  after update of tax_id on public.customers
  for each row
  when (old.tax_id is distinct from new.tax_id)
  execute function platform.audit_customer_tax_id();

-- ── 4. RLS y grants ─────────────────────────────────────────────────────────

alter table public.taxpayer_types enable row level security;
alter table public.taxpayer_types force row level security;
alter table public.person_types   enable row level security;
alter table public.person_types   force row level security;
alter table public.customers      enable row level security;
alter table public.customers      force row level security;

create policy taxpayer_types_select on public.taxpayer_types for select to authenticated, ladino_api using (true);
create policy taxpayer_types_insert on public.taxpayer_types for insert to authenticated, ladino_api with check (false);
create policy taxpayer_types_update on public.taxpayer_types for update to authenticated, ladino_api using (false);
create policy taxpayer_types_delete on public.taxpayer_types for delete to authenticated, ladino_api using (false);
create policy person_types_select on public.person_types for select to authenticated, ladino_api using (true);
create policy person_types_insert on public.person_types for insert to authenticated, ladino_api with check (false);
create policy person_types_update on public.person_types for update to authenticated, ladino_api using (false);
create policy person_types_delete on public.person_types for delete to authenticated, ladino_api using (false);

create policy customers_select on public.customers for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy customers_insert on public.customers for insert to authenticated with check (false);
create policy customers_update on public.customers for update to authenticated using (false);
create policy customers_delete on public.customers for delete to authenticated, ladino_api using (false);
create policy customers_api_select on public.customers for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy customers_api_insert on public.customers for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy customers_api_update on public.customers for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));

revoke all on public.taxpayer_types, public.person_types, public.customers
  from anon, authenticated, service_role, ladino_api, ladino_worker;
grant select on public.taxpayer_types, public.person_types to authenticated, ladino_api;
grant select on public.customers to authenticated;
grant select, insert, update on public.customers to ladino_api;

-- ── 5. Seeds ────────────────────────────────────────────────────────────────

-- ⚠ VALIDAR-TRIBUTARIO — SEED PROVISIONAL, decisión D-4 (2026-08-26).
-- Clasificación del sujeto pasivo en la normativa venezolana de IVA e ISLR
-- (no invención del proyecto), SIN tasa, artículo ni regla: hoy son etiquetas
-- sin consecuencia. ANTES de que tax_rules las consuma, el vocabulario se
-- confirma con el asesor tributario. Un cambio va por migración de datos.
insert into public.taxpayer_types (code, name, description) values
  ('ordinario',      'Contribuyente ordinario',
   'Sujeto pasivo ordinario del IVA. VALIDAR-TRIBUTARIO.'),
  ('especial',       'Contribuyente especial',
   'Designado sujeto pasivo especial por el SENIAT (agente de retención se DERIVA de aquí). VALIDAR-TRIBUTARIO.'),
  ('formal',         'Contribuyente formal',
   'Realiza exclusivamente operaciones exentas o exoneradas. VALIDAR-TRIBUTARIO.'),
  ('no_sujeto',      'No sujeto',
   'Fuera del hecho imponible. VALIDAR-TRIBUTARIO.'),
  ('no_domiciliado', 'No domiciliado',
   'Contraparte sin domicilio fiscal en Venezuela. VALIDAR-TRIBUTARIO.');

insert into public.person_types (code, name, description) values
  ('natural',    'Persona natural',   'Persona física. Puede carecer de RIF (D-2).'),
  ('juridica',   'Persona jurídica',  'Sociedad u otra entidad con personalidad jurídica.'),
  ('gobierno',   'Ente público',      'Órgano o ente del Estado.'),
  ('extranjera', 'Persona extranjera','Contraparte constituida fuera de Venezuela.');

-- Permisos (D-11): gestión, RIF (segregado, M4) y bloqueo (segregado: cobranzas
-- bloquea, ventas no).
insert into public.permissions (key, description, is_scoped) values
  ('customer.manage',        'Crear y editar clientes', false),
  ('customer.tax_id.manage', 'Modificar el RIF de un cliente. Identifica a la contraparte en los documentos', false),
  ('customer.block',         'Bloquear y desbloquear clientes (cobranzas)', false)
on conflict (key) do nothing;

-- La migración comprueba lo que sembró (LAD37, una sola ejecución).
do $$
begin
  if (select count(*) from public.taxpayer_types where status = 'active') <> 5
     or (select count(*) from public.person_types where status = 'active') <> 4
     or (select count(*) from public.permissions
          where key in ('customer.manage', 'customer.tax_id.manage', 'customer.block')) <> 3 then
    raise exception 'LAD37: el seed de clientes no dejó los catálogos y permisos esperados';
  end if;
end $$;

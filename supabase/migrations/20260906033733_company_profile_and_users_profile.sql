-- =============================================================================
-- Ladino — migración 43: el perfil del negocio y el de la persona (REGISTRO)
--
-- Módulo: registro premium / Mi empresa (orden del dueño 2026-09-05 + deltas).
-- Spec: la PARTE 6 del encargo; patrón product-images para el logo.
-- Reversibilidad: columnas y tabla nuevas, todas NULL o vacías — se revierte
--   con otra migración que las quite; ninguna fila existente cambia.
-- Impacto de homologación: NO. El logo es PRESENTACIÓN: no entra al snapshot
--   del emisor (migración 34, trigger LAD68) ni a ningún dato fiscal.
--
-- La REGLA DURA «RIF real exige razón social y domicilio fiscal» se decide
-- EN DOMINIO, no en CHECK, y queda documentada aquí: un CHECK de esquema
-- rompería decenas de fixtures legítimos (pgTAP y e2e crean companies con
-- RIF y sin domicilio desde S0) y el único camino de escritura real es la
-- API. onboardBusiness/updateCompanyProfile la imponen con 422; el e2e la
-- prueba por las dos caras. Si algún día el esquema debe respaldarla, será
-- una migración propia con la limpieza de fixtures como parte del trabajo.
-- =============================================================================

-- ── 1. companies gana su perfil (lo que el registro pregunta) ────────────────
-- trade_name y fiscal_address YA existen (creación y migración 34): no se
-- duplican. business_type es INFORMATIVO hoy (verticalización mañana): texto
-- corto, sin catálogo, para no exigir migración por cada rubro nuevo.
alter table public.companies add column business_type text;
alter table public.companies add column phone text;
alter table public.companies add column whatsapp text;
alter table public.companies add column city text;
alter table public.companies add column state text;
alter table public.companies add column logo_path text;

alter table public.companies add constraint companies_business_type_chk
  check (business_type is null
         or (business_type = btrim(business_type) and length(business_type) between 2 and 40));
alter table public.companies add constraint companies_phone_chk
  check (phone is null or (phone = btrim(phone) and length(phone) between 3 and 40));
alter table public.companies add constraint companies_whatsapp_chk
  check (whatsapp is null or (whatsapp = btrim(whatsapp) and length(whatsapp) between 3 and 40));
alter table public.companies add constraint companies_city_chk
  check (city is null or (city = btrim(city) and length(city) between 2 and 80));
alter table public.companies add constraint companies_state_chk
  check (state is null or (state = btrim(state) and length(state) between 2 and 80));
-- El logo se guarda como RUTA del bucket (patrón product-images), nunca URL.
alter table public.companies add constraint companies_logo_path_chk
  check (logo_path is null
         or (logo_path = btrim(logo_path) and length(logo_path) between 3 and 300));

-- ── 2. users_profile: quién administra la cuenta ─────────────────────────────
-- Por USUARIO, no por tenant: no lleva tenant_id y por eso queda fuera de la
-- familia del ancla (test 006) por ENUNCIADO, no por excepción.
create table public.users_profile (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null,
  national_id text,

  created_by  uuid,
  created_at  timestamptz not null,
  version     integer not null,

  constraint users_profile_full_name_chk
    check (full_name = btrim(full_name) and length(full_name) between 2 and 200),
  constraint users_profile_national_id_chk
    check (national_id is null
           or (national_id = btrim(national_id) and length(national_id) between 3 and 30))
);

create trigger users_profile_00_provenance
  before insert or update on public.users_profile
  for each row execute function platform.set_row_provenance();

alter table public.users_profile enable row level security;
alter table public.users_profile force row level security;

revoke all on public.users_profile from anon, authenticated, service_role, ladino_worker;
grant select on public.users_profile to authenticated;
grant select, insert, update on public.users_profile to ladino_api;

-- Cada quien lee SOLO su propia ficha; escribe únicamente la API, que en el
-- caso de uso impone que el actor solo toque la suya.
create policy users_profile_select_own on public.users_profile
  for select to authenticated using (user_id = auth.uid());
create policy users_profile_api_select on public.users_profile
  for select to ladino_api using (true);
create policy users_profile_api_insert on public.users_profile
  for insert to ladino_api with check (true);
create policy users_profile_api_update on public.users_profile
  for update to ladino_api using (true) with check (true);

-- ── 3. ¿La empresa ya emitió documentos fiscales? ────────────────────────────
-- El helper que la política de RIF (tres niveles) y el cambio de régimen
-- consultan. EXCLUYE los recibos A PROPÓSITO: un recibo no lleva RIF, y pasar
-- del placeholder PEND-* al RIF real ES la transición de modo recibos a
-- facturación — un recibo jamás debe bloquearla.
create function platform.company_has_fiscal_documents(p_company uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.documents d
     where d.company_id = p_company
       and d.kind in ('invoice', 'credit_note', 'debit_note')
       and d.status in ('issued', 'paid', 'annulled'))
  or exists (
    select 1 from public.supplier_invoices i
     where i.company_id = p_company and i.status in ('posted', 'paid'))
  or exists (
    select 1 from public.retention_receipts r
     where r.company_id = p_company and r.status in ('issued', 'annulled'))
$$;

-- La familia manda (test 005): ninguna función de platform queda ejecutable
-- por anon. La usa el DOMINIO vía la API; nadie más la necesita.
revoke execute on function platform.company_has_fiscal_documents(uuid) from public, anon;
grant execute on function platform.company_has_fiscal_documents(uuid) to ladino_api;

-- ── 4. LAD81 a prueba de carreras: el doble clic no funda dos negocios ──────
-- El guard de la migración 41 comprobaba la membresía SIN serializar: dos
-- peticiones simultáneas del mismo usuario podían pasar el check las dos y
-- fundar dos tenants. El candado consultivo por usuario cierra la ventana:
-- la segunda espera a la primera y muere en LAD81 → DUPLICATE, que el
-- registro trata como «ya está fundado, recarga». (El middleware de
-- idempotencia no puede cubrir esta ruta: su clave exige un tenant EXISTENTE
-- y visible —defensa H-2— y aquí el tenant aún no nació.)
create or replace function platform.bootstrap_tenant(p_user uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_membership uuid;
begin
  if p_user is null or length(btrim(coalesce(p_name, ''))) < 2 then
    raise exception 'el negocio necesita un nombre' using errcode = 'LAD80';
  end if;
  -- Serializa los bootstraps DEL MISMO usuario; usuarios distintos no compiten.
  perform pg_advisory_xact_lock(hashtext('ladino-bootstrap-' || p_user::text));
  -- Un usuario autoservicio funda UN negocio. Pertenecer ya a un tenant
  -- (fundado o invitado) cierra esta puerta: la segunda empresa se crea
  -- DENTRO del tenant, y unirse a otro negocio es una invitación, no un
  -- bootstrap.
  if exists (select 1 from public.memberships m
              where m.user_id = p_user and m.status = 'active') then
    raise exception 'este usuario ya pertenece a un negocio' using errcode = 'LAD81';
  end if;

  insert into public.tenants (name) values (btrim(p_name)) returning id into v_tenant;
  insert into public.memberships (tenant_id, user_id, created_by)
  values (v_tenant, p_user, p_user) returning id into v_membership;
  -- Las DOS asignaciones del fundador, a nivel tenant (company null): el
  -- owner plano manda en todo; warehouse_ops concede los verbos de almacén
  -- cuando existan sus bindings — que crea el caso de uso al crear almacenes.
  insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id, created_by)
  select v_tenant, v_membership, r.id, null, p_user
    from public.roles r
   where r.tenant_id is null and r.key in ('owner', 'warehouse_ops');

  return v_tenant;
end;
$$;

-- ── 5. El bucket de logos: privado, por tenant, escrito solo por la API ─────
do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public)
    values ('company-logos', 'company-logos', false)
    on conflict (id) do nothing;
    -- Lectura para usuarios autenticados SOLO de las carpetas de sus
    -- empresas (primer segmento de la ruta = company_id). La ESCRITURA no se
    -- concede a nadie por policy: sube la API con su credencial de servicio,
    -- que valida tipo y tamaño antes. Espejo de product_images_select.
    if not exists (select 1 from pg_policies
                    where schemaname = 'storage' and tablename = 'objects'
                      and policyname = 'company_logos_select') then
      execute $pol$
        create policy company_logos_select on storage.objects for select to authenticated
          using (bucket_id = 'company-logos'
                 and split_part(name, '/', 1) in
                     (select id::text from public.companies
                       where id in (select platform.ladino_company_ids())))
      $pol$;
    end if;
  end if;
end $$;

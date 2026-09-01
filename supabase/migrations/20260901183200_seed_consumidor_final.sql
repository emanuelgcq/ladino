-- =============================================================================
-- Ladino — migración 32 · FASE C: CONSUMIDOR FINAL — el cliente que ya está
--
-- Módulo: customers (rigor normal, con un eje fiscal: VALIDAR-TRIBUTARIO)
-- Spec: Fase C partes 5 y 14
-- Reversible: NO para las filas ya usadas en documentos; el vocabulario sí.
-- Homologación: NO (clasificación referencial sin tasa, igual que ADR-0033).
--
-- La venta de mostrador no le pide nombre a nadie: el carrito de Vender nace
-- apuntando a «Consumidor final», un cliente de sistema que existe en toda
-- empresa, no se edita y no se borra. Quien quiera factura con su RIF, se
-- registra como cliente normal en dos toques.
-- =============================================================================

-- ── 1. El eje fiscal: un consumidor final NO es un contribuyente ordinario ──
-- VALIDAR-TRIBUTARIO, como todo taxpayer_types (ADR-0033): clasificación sin
-- tasa ni regla. Las reglas que le aplican son las GENERALES — las que se
-- cargan con taxpayer_type NULL, como la que el asistente de /empezar siembra
-- con su fuente legal. Clasificarlo 'ordinario' habría sido mentir para que
-- cuadrara con la regla de la demo.
insert into public.taxpayer_types (code, name, description) values
  ('consumidor_final', 'Consumidor final',
   'Comprador de mostrador sin identificación fiscal. Le aplican las reglas generales (taxpayer_type NULL en tax_rules). VALIDAR-TRIBUTARIO.')
on conflict (code) do nothing;

-- ── 2. La marca de sistema ──────────────────────────────────────────────────
alter table public.customers add column is_system boolean not null default false;

-- A lo sumo UNO por empresa: el índice lo dice, no una convención.
create unique index customers_one_system_uidx
  on public.customers (company_id) where is_system;

-- Un cliente de sistema está CONGELADO: sin él la venta de mostrador se queda
-- sin contraparte, así que ni se edita, ni se desactiva, ni se borra, ni un
-- cliente normal puede ascender a sistema por una vía que no sea esta
-- migración o el alta de empresa.
create function platform.assert_system_customer_frozen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system then
      raise exception
        '«Consumidor final» no se puede borrar: es el cliente de las ventas de mostrador'
        using errcode = 'LAD06';
    end if;
    return old;
  end if;
  if old.is_system then
    raise exception
      '«Consumidor final» no se edita: para vender con datos fiscales, registra al cliente'
      using errcode = 'LAD06';
  end if;
  if new.is_system is distinct from old.is_system then
    raise exception
      'is_system no se cambia: un cliente normal no asciende a cliente de sistema'
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_system_customer_frozen() from public;

create trigger customers_02_system_frozen
  before update or delete on public.customers
  for each row execute function platform.assert_system_customer_frozen();

-- ── 3. La siembra: uno por cada empresa existente ───────────────────────────
-- Las empresas futuras lo reciben en el alta (caso de uso createCompany); las
-- de hoy, aquí. Persona natural sin RIF: exactamente el caso que D-2 permite.
insert into public.customers
  (tenant_id, company_id, legal_name, person_type_code, taxpayer_type_code, status, is_system)
select c.tenant_id, c.id, 'Consumidor final', 'natural', 'consumidor_final', 'active', true
  from public.companies c
 where not exists (select 1 from public.customers x
                    where x.company_id = c.id and x.is_system);

-- ── 4. Autochequeo ─────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from public.companies c
              where not exists (select 1 from public.customers x
                                 where x.company_id = c.id and x.is_system)) then
    raise exception 'migración 32: hay empresas sin su Consumidor final';
  end if;
  if exists (select 1 from public.customers
              where is_system and (tax_id is not null or status <> 'active')) then
    raise exception 'migración 32: un cliente de sistema nació con datos que no le tocan';
  end if;
end $$;

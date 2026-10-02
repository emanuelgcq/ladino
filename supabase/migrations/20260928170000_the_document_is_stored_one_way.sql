-- =============================================================================
-- Ladino — el documento de identidad se guarda de UNA manera (recorrido 2026-09-24: P-02)
--
-- Módulo:         documento de identidad (A-08, M-05, O-04, P-02, A-17)
-- Fuente:         RESPUESTA_RECORRIDO_2026-09-24.md A-08 y P-02, §7.6 (las reparaciones de
--                 datos corren DESPUÉS del git pull); regla del dueño del 2026-09-28: el RIF se
--                 guarda normalizado (`V123456789`) y se muestra `V-12345678-9`.
-- Reversibilidad: SÍ para el esquema — `drop function platform.tax_id_normalization_repair(boolean);`
--                 Esta migración NO toca datos: solo crea la función. Los datos los cambia la
--                 reparación (scripts/reparar/p-02-rif-normalizado.mjs) cuando el dueño la corre.
--                 Con datos vivos, lo que la reparación normalizó NO vuelve solo a su grafía
--                 anterior: cada fila deja su acta `<agregado>.tax_id_normalized` con `from` y
--                 `to`, y con ella se podría reescribir la grafía vieja fila a fila — pero no hay
--                 motivo: las dos grafías son el mismo documento, y el formateador compartido
--                 enseña las dos igual.
-- HOMOLOGATION_IMPACT: NO — los documentos emitidos NO se tocan (regla 1): sus snapshots
--                 (`issuer_tax_id_snapshot`, `customer_tax_id_snapshot`) conservan la grafía con
--                 que se emitieron. Cambia el dato MAESTRO de clientes, proveedores y empresas.
--
-- POR QUÉ UNA FUNCIÓN Y NO UN UPDATE EN LA MIGRACIÓN: §7.6 manda que las reparaciones de datos
-- corran después del pull, cuando el dueño avise que la API nueva está arriba. Si se normalizara
-- aquí, la API VIEJA seguiría guardando grafías sueltas entre la migración y el despliegue. La
-- función es idempotente: se puede correr antes, después y dos veces.
--
-- LA NORMALIZACIÓN es la misma expresión del único de clientes (`customers_company_tax_id_uidx`,
-- migración 20260902173849) y la de `normalizarDocumento` en @ladino/schemas (rif.ts):
-- mayúsculas y fuera todo lo que no sea letra o dígito. El marcador `PEND-…` de la empresa sin
-- RIF no se toca: es la ausencia declarada del RIF, no un RIF.
--
-- SI NORMALIZAR CREA UN DUPLICADO (dos proveedores «J-1…» y «j1…» de la misma empresa; dos
-- empresas del mismo tenant), la función FALLA con la lista entera ANTES de cambiar nada. Los
-- únicos del esquema también lo impedirían, pero con un 23505 opaco a mitad de camino y sin
-- decir cuáles: la lista es lo que permite fusionar a mano.
-- =============================================================================

create or replace function platform.tax_id_normalization_repair(p_dry_run boolean default false)
returns table (entity text, changed integer)
language plpgsql
set search_path = ''
as $$
declare
  v_choques text;
  v_n integer;
begin
  -- ── 1. Los choques, todos, antes de tocar una fila ────────────────────────
  select string_agg(format('%s en %s: %s → %s', c.entidad, c.ambito, c.formas, c.normalizado),
                    '; ' order by c.entidad, c.ambito, c.normalizado)
    into v_choques
    from (
      select 'clientes' as entidad, 'empresa ' || x.company_id::text as ambito, x.normalizado,
             string_agg(x.tax_id, ' | ' order by x.tax_id) as formas
        from (select company_id, tax_id,
                     upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')) as normalizado
                from public.customers
               where tax_id is not null and upper(tax_id) not like 'PEND-%') x
       group by x.company_id, x.normalizado having count(*) > 1
      union all
      select 'proveedores', 'empresa ' || x.company_id::text, x.normalizado,
             string_agg(x.tax_id, ' | ' order by x.tax_id)
        from (select company_id, tax_id,
                     upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')) as normalizado
                from public.suppliers
               where tax_id is not null and upper(tax_id) not like 'PEND-%') x
       group by x.company_id, x.normalizado having count(*) > 1
      union all
      select 'empresas', 'tenant ' || x.tenant_id::text, x.normalizado,
             string_agg(x.tax_id, ' | ' order by x.tax_id)
        from (select tenant_id, tax_id,
                     upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')) as normalizado
                from public.companies
               where upper(tax_id) not like 'PEND-%') x
       group by x.tenant_id, x.normalizado having count(*) > 1
    ) c;
  if v_choques is not null then
    raise exception
      'tax_id_normalization_repair: normalizar crearía documentos duplicados — fusiónalos a mano y vuelve a correrla: %',
      v_choques;
  end if;

  -- La versión de reglas del acta que escribe el trigger M4 de companies/customers.
  perform set_config('ladino.rules_version', 'repair-p02', true);

  -- ── 2. Clientes ───────────────────────────────────────────────────────────
  if p_dry_run then
    select count(*)::int into v_n from public.customers
     where tax_id is not null and upper(tax_id) not like 'PEND-%'
       and tax_id <> upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g'));
  else
    with cambiados as (
      update public.customers c
         set tax_id = upper(regexp_replace(c.tax_id, '[^a-zA-Z0-9]', '', 'g'))
        from public.customers viejo
       where viejo.id = c.id
         and c.tax_id is not null and upper(c.tax_id) not like 'PEND-%'
         and c.tax_id <> upper(regexp_replace(c.tax_id, '[^a-zA-Z0-9]', '', 'g'))
      returning c.id, c.tenant_id, c.company_id, viejo.tax_id as anterior, c.tax_id as nuevo
    )
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    select tenant_id, company_id, 'customer', id, 'customer.tax_id_normalized',
           'system', now(), 'repair-p02',
           jsonb_build_object('from', anterior, 'to', nuevo, 'reparacion', 'P-02')
      from cambiados;
    get diagnostics v_n = row_count;
  end if;
  entity := 'customers'; changed := v_n; return next;

  -- ── 3. Proveedores (sin trigger de acta propio: la única acta es esta) ────
  if p_dry_run then
    select count(*)::int into v_n from public.suppliers
     where tax_id is not null and upper(tax_id) not like 'PEND-%'
       and tax_id <> upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g'));
  else
    with cambiados as (
      update public.suppliers s
         set tax_id = upper(regexp_replace(s.tax_id, '[^a-zA-Z0-9]', '', 'g'))
        from public.suppliers viejo
       where viejo.id = s.id
         and s.tax_id is not null and upper(s.tax_id) not like 'PEND-%'
         and s.tax_id <> upper(regexp_replace(s.tax_id, '[^a-zA-Z0-9]', '', 'g'))
      returning s.id, s.tenant_id, s.company_id, viejo.tax_id as anterior, s.tax_id as nuevo
    )
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    select tenant_id, company_id, 'supplier', id, 'supplier.tax_id_normalized',
           'system', now(), 'repair-p02',
           jsonb_build_object('from', anterior, 'to', nuevo, 'reparacion', 'P-02')
      from cambiados;
    get diagnostics v_n = row_count;
  end if;
  entity := 'suppliers'; changed := v_n; return next;

  -- ── 4. Empresas (el trigger M4 deja además company.tax_id_changed) ────────
  if p_dry_run then
    select count(*)::int into v_n from public.companies
     where upper(tax_id) not like 'PEND-%'
       and tax_id <> upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g'));
  else
    with cambiados as (
      update public.companies co
         set tax_id = upper(regexp_replace(co.tax_id, '[^a-zA-Z0-9]', '', 'g'))
        from public.companies viejo
       where viejo.id = co.id
         and upper(co.tax_id) not like 'PEND-%'
         and co.tax_id <> upper(regexp_replace(co.tax_id, '[^a-zA-Z0-9]', '', 'g'))
      returning co.id, co.tenant_id, viejo.tax_id as anterior, co.tax_id as nuevo
    )
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    select tenant_id, id, 'company', id, 'company.tax_id_normalized',
           'system', now(), 'repair-p02',
           jsonb_build_object('from', anterior, 'to', nuevo, 'reparacion', 'P-02')
      from cambiados;
    get diagnostics v_n = row_count;
  end if;
  entity := 'companies'; changed := v_n; return next;
end;
$$;

comment on function platform.tax_id_normalization_repair(boolean) is
  'P-02 (recorrido 2026-09-24): normaliza tax_id de customers, suppliers y companies a la forma '
  'que se guarda (mayúsculas, sin separadores; PEND- intacto), con un acta por fila cambiada. '
  'Idempotente. Falla con la lista si normalizar crea un duplicado. NO toca los snapshots de los '
  'documentos emitidos (regla 1). La corre el dueño después del git pull '
  '(scripts/reparar/p-02-rif-normalizado.mjs); con p_dry_run = true solo cuenta.';

-- Nadie más que el dueño de la base: es una reparación, no una operación de la API.
revoke execute on function platform.tax_id_normalization_repair(boolean) from public;

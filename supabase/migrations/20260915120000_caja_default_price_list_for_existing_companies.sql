-- =============================================================================
-- LA CAJA DE LAS EMPRESAS EXISTENTES LEE LA LISTA DONDE EL ALTA ESCRIBE
-- (bug de producción 2026-09-15, «Pollos y víveres paola»)
--
-- Módulo: catálogo / listas de precios · Spec: ADR-0046/0047 (precio anclado en
-- USD, pantalla dual), migración 36 (company_settings.default_price_list_id).
-- HOMOLOGATION_IMPACT: NO (no toca emisión, numeración ni libros).
-- Aislamiento: no crea tabla ni expone la función (revoke a public); cada
-- escritura lleva el tenant de SU empresa y la FK compuesta de la migración 36
-- impide apuntar a una lista ajena.
--
-- Hasta hoy, `createCompany` sembraba «detal» y «mayor» en la moneda FUNCIONAL
-- y sin lista predeterminada. El alta simple ancla el precio en USD
-- (ADR-0046/0047): no cabía en «detal» VES y lo escribía en «detal USD». La
-- caja, sin predeterminada, resolvía «detal» por nombre —la VES, vacía— y la
-- primera venta respondía «el producto no tiene precio». El dominio ya nace
-- bien (listas en USD, «detal» predeterminada); esta migración repara a las
-- empresas que nacieron antes.
--
-- REGLA DE REPARACIÓN, por empresa sin predeterminada:
--   · si la lista que la caja resuelve HOY ya tiene precio para algún producto
--     ACTIVO, NO se toca: esa caja vende hoy, y cambiarle la lista cambiaría
--     lo que cobra (es el caso de una empresa con su catálogo en Bs: se reporta,
--     no se toca — regla de precios del dueño);
--   · si no vende nada, la predeterminada pasa a ser la lista USD «detal…» con
--     más precios de productos activos; si no hay ninguna, se crea «detal USD».
--
-- No borra ni edita precios. Solo fija el dato que faltaba y deja su acta en
-- `audit_events` (actor system, origen migración).
--
-- REVERSIBILIDAD: total. Deshacer = poner `default_price_list_id` en NULL en las
-- empresas que nombra el acta `company.settings.updated` con
-- payload->>'origin' = 'migration_20260915120000' (la caja vuelve a la
-- heurística de nombre). Una lista «detal USD» creada aquí puede quedar
-- `inactive` si no tiene precios; nunca se borra (R8). Si el dueño ya cargó
-- productos en ella después, deshacer los dejaría sin vender: por eso NO se
-- deshace sin revisar el acta empresa por empresa.
-- =============================================================================

create or replace function platform.assign_caja_default_price_list(p_company uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_tenant    uuid;
  v_resuelta  uuid;
  v_destino   uuid;
begin
  select c.tenant_id into v_tenant from public.companies c where c.id = p_company;
  if v_tenant is null then
    return null;
  end if;

  if exists (select 1 from public.company_settings cs
              where cs.company_id = p_company and cs.default_price_list_id is not null) then
    return null;
  end if;

  -- La MISMA resolución que la caja (sales.ts resolverLista, products.ts):
  -- sin predeterminada, «detal» por nombre, luego «detal…», luego la más vieja.
  select l.id into v_resuelta
    from public.price_lists l
   where l.company_id = p_company and l.status = 'active'
   order by (l.name = 'detal') desc, (l.name like 'detal%') desc, l.created_at
   limit 1;

  if v_resuelta is not null and exists (
       select 1 from public.price_list_items i
         join public.products p on p.id = i.product_id and p.status = 'active'
        where i.price_list_id = v_resuelta) then
    return null;
  end if;

  select l.id into v_destino
    from public.price_lists l
   where l.company_id = p_company and l.status = 'active'
     and l.currency_code = 'USD' and l.name like 'detal%'
   order by (select count(*) from public.price_list_items i
               join public.products p on p.id = i.product_id and p.status = 'active'
              where i.price_list_id = l.id) desc,
            (l.name = 'detal') desc, l.created_at
   limit 1;

  if v_destino is null then
    insert into public.price_lists (tenant_id, company_id, name, currency_code)
    values (v_tenant, p_company,
            case when exists (select 1 from public.price_lists x
                               where x.company_id = p_company and x.name = 'detal USD')
                 then 'detal USD caja' else 'detal USD' end,
            'USD')
    returning id into v_destino;
  end if;

  insert into public.company_settings (company_id, tenant_id, default_price_list_id)
  values (p_company, v_tenant, v_destino)
  on conflict (company_id) do update set default_price_list_id = excluded.default_price_list_id;

  insert into public.audit_events
    (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
     actor_type, occurred_at, rules_version, payload)
  values
    (v_tenant, p_company, 'company', p_company, 'company.settings.updated',
     'system', now(),
     coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-migration'),
     jsonb_build_object(
       'default_price_list_id', v_destino,
       'origin', 'migration_20260915120000',
       'motivo', 'La caja no tenía precio para ningún producto activo en la lista que '
                 'resolvía por nombre; se fija la lista USD donde el alta simple escribe.'));

  return v_destino;
end;
$$;

comment on function platform.assign_caja_default_price_list(uuid) is
  'Repara una empresa sin lista predeterminada cuya caja no vende nada: fija la '
  'lista USD «detal…» (o la crea). No toca una caja que ya vende. Deja acta.';

revoke execute on function platform.assign_caja_default_price_list(uuid) from public;

-- La reparación, una vez, para todas las empresas existentes.
do $$
declare
  v_c record;
begin
  for v_c in select id from public.companies order by created_at loop
    perform platform.assign_caja_default_price_list(v_c.id);
  end loop;
end $$;

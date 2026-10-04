-- Módulo: permisos y aislamiento (A-14)   Spec: RESPUESTA_RECORRIDO_2026-09-24.md §2.15
-- Reversible: SÍ (volver a la definición de 20261003130000). Homologación: NO.
--
-- Corrige la función de la migración anterior de esta misma ola (20261003130000): la edad de un
-- objeto de logo se leía con greatest(created_at, updated_at), y el trigger de Storage
-- (storage.update_updated_at_column) pone updated_at = now() en CUALQUIER UPDATE, también en el
-- upsert de un logo que se vuelve a subir igual. Con eso un objeto nunca envejecía si alguien lo
-- había tocado. Lo destapó el E2E de la purga (e2e-permisos-que-terminan-en-verde, A-14), que
-- envejece los objetos y no veía ninguno purgable.
--
-- Auditoría de este arreglo (CLAUDE.md §3): misma firma, mismo security definer, mismos grants,
-- misma guarda de tenant; solo cambia la columna de la edad. Ninguna migración posterior la toca.

create or replace function platform.company_logo_purgeable(
  p_company_id uuid, p_grace interval default interval '30 days')
returns table (object_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if to_regclass('storage.objects') is null then
    return;
  end if;
  -- Solo la empresa de un tenant del actor de servicio: la función ve storage.objects entero.
  if not exists (select 1 from public.companies c
                  where c.id = p_company_id
                    and c.tenant_id in (select platform.ladino_service_tenant_ids())) then
    return;
  end if;
  return query
    with ventanas as (
      select regexp_replace(a.payload ->> 'to', '/[^/]+$', '') as dir,
             a.occurred_at as desde,
             lead(a.occurred_at) over (order by a.occurred_at, a.id) as hasta
        from public.audit_events a
       where a.company_id = p_company_id and a.event_type = 'company.logo_set'
    ),
    referenciadas as (
      select v.dir from ventanas v
       where v.dir is not null
         and (exists (select 1 from public.documents d
                       where d.company_id = p_company_id and d.issued_at is not null
                         and d.issued_at >= v.desde
                         and (v.hasta is null or d.issued_at < v.hasta))
              or exists (select 1 from public.retention_receipts r
                          where r.company_id = p_company_id and r.issued_at is not null
                            and r.issued_at >= v.desde
                            and (v.hasta is null or r.issued_at < v.hasta)))
    ),
    vigente as (
      select regexp_replace(c.logo_path, '/[^/]+$', '') as dir
        from public.companies c where c.id = p_company_id
    )
    select o.name::text
      from storage.objects o
     where o.bucket_id = 'company-logos'
       and o.name like p_company_id::text || '/logo/%'
       -- created_at, no updated_at: el trigger de Storage pone updated_at = now() en todo UPDATE,
       -- y el upsert del mismo contenido no es uso. Borde aceptado: un logo que se vuelve a subir
       -- tal cual pasados 30 días y cuya purga se cruza con otra subida de la MISMA empresa antes
       -- de quedar vigente perdería sus objetos; su siguiente subida los recrea.
       and o.created_at < now() - p_grace
       and regexp_replace(o.name, '/[^/]+$', '') is distinct from (select dir from vigente)
       and not exists (select 1 from referenciadas r
                        where r.dir = regexp_replace(o.name, '/[^/]+$', ''));
end;
$$;
revoke all on function platform.company_logo_purgeable(uuid, interval) from public;
revoke all on function platform.company_logo_purgeable(uuid, interval) from public;
grant execute on function platform.company_logo_purgeable(uuid, interval) to ladino_api;

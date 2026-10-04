-- Módulo: permisos y aislamiento (ola 3, re-revisión C1)   Spec: ADR-0068 §8
-- Reversible: SÍ, con datos vivos (ver REVERSIÓN). Homologación: NO.
--
-- QUÉ PASABA: `platform.four_eyes_active(empresa, permiso)` (20261003130200 §H4) es
-- `security definer` y respondía por CUALQUIER empresa: con el id de una empresa ajena, el actor
-- de servicio aprendía el ajuste de cuatro ojos de otro tenant y si allí hay más de una persona
-- con un permiso dado. `company_logo_purgeable`, de la misma migración, sí tiene la guarda.
--
-- QUÉ HACE: la misma guarda (`platform.ladino_service_tenant_ids()`): la función solo responde por
-- una empresa de un tenant del actor de servicio. Para una empresa ajena (o sin actor) devuelve
-- TRUE —cuatro ojos encendidos—, que es constante (no revela nada de la empresa) y es el lado
-- que falla cerrado: un llamante que la use en un `if` no aprueba de más. Decidido por criterio;
-- alternativa: NULL («no se sabe»), que en un `if` de plpgsql cuenta como falso y fallaría
-- abierto, o lanzar 42501, que rompería a `approval_allowed` con un error en vez de un «no».
--
-- Parte de la ÚLTIMA definición en el orden limpio (20261003130200 §H4); ninguna migración
-- posterior redefine `four_eyes_active`. `approval_allowed` no se toca: delega en esta, y para
-- una empresa ajena queda en «quien registró no aprueba», función solo de sus argumentos.
-- No lee nada que cree una migración posterior.
-- =============================================================================

create or replace function platform.four_eyes_active(p_company_id uuid, p_permission text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ajuste boolean;
  v_personas int;
begin
  -- Solo la empresa de un tenant del actor de servicio: la función ve company_settings y
  -- memberships enteras (20261003130300). Fuera de alcance: encendidos, constante y cerrado.
  if not exists (select 1 from public.companies c
                  where c.id = p_company_id
                    and c.tenant_id in (select platform.ladino_service_tenant_ids())) then
    return true;
  end if;
  select s.four_eyes into v_ajuste from public.company_settings s where s.company_id = p_company_id;
  if v_ajuste is not null then
    return v_ajuste;
  end if;
  -- Personas activas que pueden aprobar ESO en la empresa: la misma resolución que el servidor.
  select count(*) into v_personas
    from public.companies c
    join public.memberships m on m.tenant_id = c.tenant_id and m.status = 'active'
   where c.id = p_company_id
     and platform.ladino_user_has_permission(m.user_id, p_permission, c.id);
  return v_personas > 1;
end;
$$;

revoke all on function platform.four_eyes_active(uuid, text) from public;
grant execute on function platform.four_eyes_active(uuid, text) to ladino_api;

-- =============================================================================
-- REVERSIÓN, con datos vivos (otra migración): `create or replace` con la definición de
-- 20261003130200 §H4 (sin la guarda). No escribe datos; ningún caso de uso la llama todavía.
-- =============================================================================

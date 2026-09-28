-- =============================================================================
-- Ladino — EL DUEÑO INVITADO OPERA SUS ALMACENES (ADR-0068 §3, hallazgo N-02)
--
-- Módulo: miembros y roles   Spec: docs/04_PLATFORM/MULTITENANCY_AND_RBAC.md
-- Reversible: SÍ (ver abajo)  Homologación: NO (cambia quién opera, no ningún documento)
--
-- El fundador nace con `owner` y `warehouse_ops` a nivel tenant (platform.bootstrap_tenant). Al
-- Dueño que se agrega a una empresa (`addMember`, role_key = 'owner') solo se le daba `owner`
-- acotado a la empresa, y el rol `owner` NO trae `inventory.move` (lo trae `warehouse_ops`): no
-- podía recibir ni mover mercancía en SU empresa. Desde esta entrega `addMember` le da también
-- `warehouse_ops` acotado a la empresa, con bindings a sus almacenes
-- (packages/domain/src/members.ts). Esta migración lo hace con los Dueños invitados que YA
-- existen.
--
-- Lo que hace, y nada más:
--   · por cada asignación `owner` ACOTADA a una empresa cuya membresía no tenga `warehouse_ops`
--     en esa empresa ni a nivel tenant, inserta la asignación `warehouse_ops` acotada a esa
--     empresa y un binding a cada almacén de la empresa;
--   · deja su rastro en audit_events (`member.role_assigned`, actor `system`).
-- Aditiva e idempotente: no borra ni cambia ninguna fila existente, y una segunda ejecución no
-- encuentra a quién darle nada (el `not exists` y los índices únicos
-- user_role_assignments_company_uidx y scope_bindings_assignment_scope_key).
--
-- La lógica vive en una función para que el pgTAP (077) la ejerza con su variante rota; la
-- migración la llama una vez. No es invocable por los roles de la aplicación.
--
-- REVERSIBILIDAD, CON DATOS VIVOS: las filas nuevas se distinguen por su rastro de auditoría
-- (payload.origin = '20260928100000'). Revertir = borrar esos bindings y esas asignaciones
-- (ninguna tabla append-only interviene: user_role_assignments y scope_bindings admiten DELETE,
-- que es lo que hace `removeAssignment`). El coste real de revertir: esos Dueños vuelven a no
-- poder mover mercancía, y cualquier movimiento que hicieran entretanto queda registrado igual
-- (el kardex es append-only y no depende de que la asignación siga existiendo).
-- =============================================================================

create or replace function platform.grant_invited_owner_warehouse_ops()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_creadas integer := 0;
  v_fila record;
  v_asignacion uuid;
begin
  perform set_config('ladino.rules_version', 'domain-s0.5', true);

  for v_fila in
    select distinct ura.tenant_id, ura.membership_id, ura.company_id, m.user_id
      from public.user_role_assignments ura
      join public.roles ro on ro.id = ura.role_id and ro.tenant_id is null and ro.key = 'owner'
      join public.memberships m on m.id = ura.membership_id
     where ura.company_id is not null
       and not exists (
             select 1
               from public.user_role_assignments u
               join public.roles rw
                 on rw.id = u.role_id and rw.tenant_id is null and rw.key = 'warehouse_ops'
              where u.membership_id = ura.membership_id
                and (u.company_id = ura.company_id or u.company_id is null))
  loop
    insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
    select v_fila.tenant_id, v_fila.membership_id, r.id, v_fila.company_id
      from public.roles r
     where r.tenant_id is null and r.key = 'warehouse_ops'
    returning id into v_asignacion;

    insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id)
    select v_fila.tenant_id, v_fila.company_id, v_asignacion, 'warehouse', w.id
      from public.warehouses w
     where w.company_id = v_fila.company_id;

    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_fila.tenant_id, v_fila.company_id, 'membership', v_fila.membership_id,
            'member.role_assigned', 'system', now(), 'domain-s0.5',
            jsonb_build_object('user_id', v_fila.user_id, 'role_key', 'warehouse_ops',
                               'assignment_id', v_asignacion,
                               'origin', '20260928100000',
                               'reason', 'Dueño invitado: opera los almacenes de su empresa (ADR-0068 §3)'));
    v_creadas := v_creadas + 1;
  end loop;

  return v_creadas;
end;
$$;

comment on function platform.grant_invited_owner_warehouse_ops() is
  'ADR-0068 §3: da warehouse_ops acotado (con bindings a los almacenes) a cada owner acotado a una '
  'empresa que no lo tenga. Idempotente. La llama la migración 20260928100000; no la llama la API.';

revoke all on function platform.grant_invited_owner_warehouse_ops() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function platform.grant_invited_owner_warehouse_ops() from anon, authenticated';
  end if;
end $$;

select platform.grant_invited_owner_warehouse_ops();

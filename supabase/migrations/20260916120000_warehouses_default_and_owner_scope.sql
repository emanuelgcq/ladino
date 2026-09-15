-- =============================================================================
-- Ladino — migración 60 · EL DEPÓSITO PRINCIPAL Y EL ALCANCE DEL DUEÑO
--
-- QA de pantalla 2026-09-15, hallazgos 40, 46, 47 y 49. Crear un segundo
-- depósito dejaba la caja sin poder vender:
--
--   1. No existía «depósito principal»: la caja y la compra simple usaban
--      `company_settings.default_warehouse_id` (nulo en toda empresa nueva) o, en
--      su defecto, el PRIMERO que devolvía /v1/warehouses ordenado por código.
--      Un depósito cuyo código ordenaba antes que «W1» pasaba a ser el de la caja.
--   2. El dueño recibe los verbos acotados (inventory.move, purchase.receive,
--      inventory.transfer) por su asignación de `warehouse_ops`, atada SOLO al
--      depósito que nació con la empresa (onboarding). POST /v1/warehouses no le
--      ataba el nuevo: vender, recibir o mover mercancía ahí respondía «exige el
--      permiso … sobre ese almacén concreto» — al propio dueño.
--
-- Esta migración:
--   a) `platform.default_warehouse(company)`: EL depósito principal, una sola
--      definición. El elegido en ajustes si sigue activo; si no, el ACTIVO más
--      antiguo (el que nació con la empresa). Crear otro no cambia el principal.
--   b) `platform.bind_owner_warehouse_scope(company)`: ata la asignación de
--      `warehouse_ops` de quien es DUEÑO a TODOS los depósitos de la empresa.
--      Idempotente. La usa el alta de depósito (dominio) y el relleno de abajo.
--   c) Relleno: toda empresa existente queda con sus dueños atados a todos sus
--      depósitos. Solo AÑADE bindings que faltan; no quita ni cambia ninguno.
--
-- No se usa un trigger sobre warehouses a propósito: el alta de empresa ya crea
-- su binding a mano justo después del depósito, y un trigger lo duplicaría. El
-- camino único de alta posterior es el caso de uso `createWarehouse`.
--
-- Reversibilidad: las funciones se eliminan con DROP FUNCTION; los bindings
-- añadidos se identifican (created_by nulo, creados en la ventana de esta
-- migración) y se pueden retirar sin tocar los del alta de empresa.
-- =============================================================================

create function platform.default_warehouse(p_company uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select w.id
       from public.company_settings s
       join public.warehouses w on w.company_id = s.company_id and w.id = s.default_warehouse_id
      where s.company_id = p_company and w.status = 'active'),
    (select w.id
       from public.warehouses w
      where w.company_id = p_company and w.status = 'active'
      order by w.created_at, w.id
      limit 1))
$$;

comment on function platform.default_warehouse(uuid) is
  'El depósito principal de la empresa: el de ajustes si sigue activo; si no, el activo más '
  'antiguo. La caja, la compra simple y el inventario inicial parten de aquí (QA 2026-09-15).';

revoke execute on function platform.default_warehouse(uuid) from public;
grant execute on function platform.default_warehouse(uuid) to authenticated, ladino_api;

create function platform.bind_owner_warehouse_scope(p_company uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_insertados integer;
begin
  -- Las asignaciones de warehouse_ops (de empresa o de tenant) de las membresías
  -- que tienen el rol owner en esta empresa (o en todo el tenant), contra cada
  -- depósito de la empresa que todavía no tengan atado.
  insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id)
  select wo.tenant_id, w.company_id, wo.id, 'warehouse', w.id
    from public.warehouses w
    join public.user_role_assignments wo
      on wo.tenant_id = w.tenant_id
     and (wo.company_id is null or wo.company_id = w.company_id)
    join public.roles rw
      on rw.id = wo.role_id and rw.tenant_id is null and rw.key = 'warehouse_ops'
   where w.company_id = p_company
     and exists (
       select 1
         from public.user_role_assignments ow
         join public.roles ro
           on ro.id = ow.role_id and ro.tenant_id is null and ro.key = 'owner'
        where ow.membership_id = wo.membership_id
          and (ow.company_id is null or ow.company_id = w.company_id))
  on conflict (assignment_id, scope_type, scope_id) do nothing;
  get diagnostics v_insertados = row_count;
  return v_insertados;
end;
$$;

comment on function platform.bind_owner_warehouse_scope(uuid) is
  'Ata la asignación warehouse_ops de los dueños a todos los depósitos de la empresa. '
  'Idempotente: solo inserta los bindings que faltan.';

revoke execute on function platform.bind_owner_warehouse_scope(uuid) from public;
grant execute on function platform.bind_owner_warehouse_scope(uuid) to ladino_api;

-- Relleno: los dueños de toda empresa existente, atados a todos sus depósitos.
select platform.bind_owner_warehouse_scope(c.id) from public.companies c;

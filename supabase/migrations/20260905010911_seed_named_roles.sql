-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 40 — Los cinco roles con nombre, y la lista de permisos (ADR-0048)
--
-- El sistema tenía el MECANISMO (roles → permisos → membresías) y ningún rol
-- definido: cada tenant inventaba el suyo. Se siembran los cinco oficios del
-- negocio venezolano (mismo patrón que Alegra/Siigo: roles de oficio, no
-- matrices de checkboxes), como roles de SISTEMA (tenant_id null):
--
--   · owner (Dueño)            — todo el catálogo, leído de la tabla misma;
--   · cashier (Cajero)         — vende, cobra, fía; NO ve el dinero agregado
--                                ni registra mercancía;
--   · store_manager (Encargado)— lo del cajero + mercancía, alta de producto,
--                                cierre de caja y tasa del día; sin saldos;
--   · back_office (Administrador) — la operación completa de los dos mundos;
--                                lee contabilidad (KPIs) pero NO asienta;
--   · accountant (Contador)    — contabilidad, cierres, libros, clasificación
--                                tributaria y reglas de retención; no opera.
--
-- Segregación (MULTITENANCY_AND_RBAC §Segregación): el cajero NO tiene
-- cash.close — cierra el encargado o el administrador. supplier.bank_account
-- .approve y los overrides peligrosos (inventory.negative/expired, company.*)
-- quedan SOLO en owner.
--
-- Además: `platform.ladino_user_permissions()` — la MISMA resolución de
-- ladino_user_has_permission, devolviendo el conjunto entero, para que la
-- webapp forme el menú una vez por sesión en vez de preguntar permiso por
-- permiso.
--
-- Cada lista se inserta CONTRA la tabla `permissions` y se cuenta: si una
-- clave no existe (typo, permiso renombrado), la migración FALLA — una lista
-- sembrada a medias es un rol que parece funcionar.
-- Reversibilidad: filas de catálogo y una función; se revierte con otra
-- migración que las retire. HOMOLOGATION_IMPACT: NO.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. La lista de permisos del usuario en una empresa ──────────────────────
create function platform.ladino_user_permissions(p_user uuid, p_company_id uuid)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select distinct rp.permission_key
    from public.companies c
    join public.memberships m
      on m.tenant_id = c.tenant_id
     and m.user_id   = p_user
     and m.status    = 'active'
    join public.user_role_assignments ura
      on ura.membership_id = m.id
     and (ura.company_id = c.id or ura.company_id is null)
    join public.roles r
      on r.id = ura.role_id
    join public.role_permissions rp
      on rp.role_id = r.id
   where c.id = p_company_id
     and (
           not r.requires_scope
        or exists (
             select 1
               from public.scope_bindings sb
              where sb.assignment_id = ura.id
                and sb.company_id    = c.id
           )
     )
   order by 1
$$;
comment on function platform.ladino_user_permissions(uuid, uuid) is
  'ADR-0048: el conjunto de permisos del usuario en la empresa — la MISMA '
  'resolución de ladino_user_has_permission, devuelta entera. La webapp forma '
  'el menú con esto; la autorización real sigue siendo por operación.';
revoke execute on function platform.ladino_user_permissions(uuid, uuid) from public;
grant execute on function platform.ladino_user_permissions(uuid, uuid)
  to authenticated, ladino_api;

-- ── 2. Los cinco roles ──────────────────────────────────────────────────────
-- requires_scope, DECIDIDO rol por rol (ADR-0025 §4 prohíbe heredarlo):
--   · cashier y accountant no llevan ningún permiso acotado → false;
--   · store_manager, back_office y owner llevan los verbos de almacén
--     (inventory.move/adjust/transfer, purchase.receive, cash_register.operate)
--     → TRUE por coherencia (LAD25): su asignación exige scope_bindings que
--     digan EN QUÉ almacenes operan — típicamente todos los de la empresa —
--     y sin binding el rol no concede nada, que es el fallo cerrado correcto.
do $$
declare
  v_owner uuid; v_cashier uuid; v_manager uuid; v_admin uuid; v_accountant uuid;
  v_n int; v_total int;
begin
  insert into public.roles (tenant_id, key, name, requires_scope) values
    (null, 'owner',         'Dueño',         true)  returning id into v_owner;
  insert into public.roles (tenant_id, key, name, requires_scope) values
    (null, 'cashier',       'Cajero',        false) returning id into v_cashier;
  insert into public.roles (tenant_id, key, name, requires_scope) values
    (null, 'store_manager', 'Encargado',     true)  returning id into v_manager;
  insert into public.roles (tenant_id, key, name, requires_scope) values
    (null, 'back_office',   'Administrador', true)  returning id into v_admin;
  insert into public.roles (tenant_id, key, name, requires_scope) values
    (null, 'accountant',    'Contador',      false) returning id into v_accountant;

  -- DUEÑO: el catálogo ENTERO, leído de la tabla — sin lista que se desactualice.
  -- Un permiso nuevo en una migración futura debe concedérsele ahí mismo (el
  -- pgTAP 040 exige cobertura total: si se olvida, se pone rojo).
  insert into public.role_permissions (role_id, permission_key, tenant_id)
  select v_owner, p.key, null from public.permissions p;
  select count(*) into v_total from public.permissions;
  select count(*) into v_n from public.role_permissions where role_id = v_owner;
  if v_n <> v_total or v_n = 0 then
    raise exception 'LAD52: owner debía cubrir % permisos y cubrió %', v_total, v_n;
  end if;

  -- CAJERO: vender, cobrar, fiar y anotar al vecino. Nada más — sin dinero
  -- agregado (treasury.read), sin mercancía (inventory.*), sin gastos.
  insert into public.role_permissions (role_id, permission_key, tenant_id)
  select v_cashier, p.key, null from public.permissions p where p.key in
    ('sales.invoice.issue', 'sales.quote.manage', 'sales.payment.register',
     'ar.read', 'customer.manage');
  select count(*) into v_n from public.role_permissions where role_id = v_cashier;
  if v_n <> 5 then raise exception 'LAD52: cashier debía tener 5 permisos y tiene %', v_n; end if;

  -- ENCARGADO: cajero + la mercancía (los cuatro verbos y la compra directa),
  -- el alta de producto, la tasa del día y el CIERRE de caja (SoD: el cajero
  -- no supervisa su propio cierre). Sin saldos, sin gastos, sin reportes.
  insert into public.role_permissions (role_id, permission_key, tenant_id)
  select v_manager, p.key, null from public.permissions p where p.key in
    ('sales.invoice.issue', 'sales.quote.manage', 'sales.payment.register',
     'ar.read', 'customer.manage',
     'product.manage', 'inventory.move', 'inventory.adjust', 'inventory.transfer',
     'purchase.receive', 'purchase.invoice.register', 'supplier.manage',
     'cash.close', 'fx.rate.manage', 'warehouse.read');
  select count(*) into v_n from public.role_permissions where role_id = v_manager;
  if v_n <> 15 then raise exception 'LAD52: store_manager debía tener 15 y tiene %', v_n; end if;

  -- ADMINISTRADOR: la operación completa de los dos mundos — anula, maneja
  -- precios, órdenes, CxP, tesorería, gastos, rangos fiscales y reportes.
  -- accounting.read es para los KPIs (utilidad, diferencial): el MÓDULO de
  -- contabilidad se abre con accounting.entry.create, que no tiene — quien
  -- opera no asienta.
  insert into public.role_permissions (role_id, permission_key, tenant_id)
  select v_admin, p.key, null from public.permissions p where p.key in
    ('sales.invoice.issue', 'sales.quote.manage', 'sales.payment.register',
     'ar.read', 'customer.manage',
     'product.manage', 'inventory.move', 'inventory.adjust', 'inventory.transfer',
     'purchase.receive', 'purchase.invoice.register', 'supplier.manage',
     'cash.close', 'fx.rate.manage', 'warehouse.read',
     'sales.invoice.annul', 'sales.order.manage', 'sales.return.manage',
     'sales.price_list.override', 'customer.tax_id.manage', 'customer.block',
     'product.variant.manage', 'product.recipe.manage', 'inventory.threshold.manage',
     'warehouse.manage', 'price_list.manage',
     'purchase.order.manage', 'purchase.payment.register', 'purchase.credit_note.register',
     'purchase.landed_cost.apply', 'purchase.price_variance.approve', 'ap.read',
     'retention.receipt.issue', 'expense.register', 'expense.read',
     'treasury.read', 'treasury.account.manage', 'treasury.reassign',
     'cash_register.manage', 'cash_register.operate', 'cash_register.read',
     'fiscal.range.manage', 'fiscal.contingency.manage',
     'report.export', 'accounting.read', 'company.read', 'branch.read');
  select count(*) into v_n from public.role_permissions where role_id = v_admin;
  if v_n <> 47 then raise exception 'LAD52: back_office debía tener 47 y tiene %', v_n; end if;

  -- CONTADOR: contabilidad completa, cierres, libros, clasificación
  -- tributaria, reglas de retención y de impuestos, y LECTURA de CxC/CxP.
  -- No vende, no cobra, no toca maestros.
  insert into public.role_permissions (role_id, permission_key, tenant_id)
  select v_accountant, p.key, null from public.permissions p where p.key in
    ('accounting.account.manage', 'accounting.template.manage',
     'accounting.entry.create', 'accounting.entry.post', 'accounting.entry.reverse',
     'accounting.read', 'accounting.period.close', 'accounting.period.reopen',
     'period.close', 'period.reopen', 'journal.post', 'journal.reverse',
     'fiscal_book.read', 'fiscal_book.export', 'fiscal.audit.read',
     'retention.rules.manage', 'tax.rules.manage', 'product.tax_category.set',
     'report.export', 'ar.read', 'ap.read', 'company.read');
  select count(*) into v_n from public.role_permissions where role_id = v_accountant;
  if v_n <> 22 then raise exception 'LAD52: accountant debía tener 22 y tiene %', v_n; end if;
end $$;

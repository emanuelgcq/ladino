-- =============================================================================
-- Ladino — Fiar exige permiso y límite (recorrido 2026-09-24, E-09; RESPUESTA §2.8 y §3 E-09)
--
-- Módulo: clientes / ventas   Spec: docs/03_MODULES/SALES_SPEC.md, ADR-0033
-- Reversible: SÍ, con datos vivos — ver «Reversibilidad» abajo.   Homologación: NO
--
-- Qué pasaba: el cajero podía fiar cualquier importe a cualquier cliente, incluido uno que
-- acababa de crear. `quickSale` solo pedía cliente identificado y no bloqueado; no había permiso
-- de crédito ni límite (la tabla `customers` no tenía dónde guardarlo).
--
-- Qué hace esta migración (solo AÑADE: es «expand», la API desplegada no lee nada de esto):
--
--   1. Dos permisos: `sales.credit` (fiar en la caja) y `customers.credit.set` (fijar el límite
--      de un cliente). Reparto por oficio, §2.8 — decidido por criterio (§2.16):
--        · `sales.credit`: cajero, encargado, administrativo y dueño. El cajero fía («cajero
--          vende contado y fiado con permiso de crédito y límite»); lo que le acota es el límite
--          del cliente, que él no puede fijar. Alternativa: no dárselo al cajero y que el dueño
--          lo conceda rol por rol.
--        · `customers.credit.set`: administrativo y dueño. El cajero NO.
--
--   2. `customers.credit_limit_usd numeric(24,8) not null default 0`, con CHECK >= 0. En USD: el
--      fiado se ancla en USD. Los clientes EXISTENTES quedan en 0 (decidido por criterio: lo más
--      estrecho; conservan su deuda y no fían más hasta que alguien con permiso les fije el
--      límite. Alternativa: sembrarles como límite su deuda de hoy). Añadir una columna NOT NULL
--      con DEFAULT constante no reescribe la tabla.
--
--   3. Dos defensas en el esquema (la API valida antes, con un 403 legible; esto es la red):
--        · LAD78 — un cliente NACE con límite 0: un INSERT con otro valor muere, venga de quien
--          venga;
--        · LAD79 — cambiar el límite por el camino de servidor (`ladino.actor_id`) exige
--          `customers.credit.set` sobre la empresa. Sin actor (migración, soporte como owner de
--          la base) pasa, y queda en el acta como `system`.
--      Y el ACTA: todo cambio del límite escribe `customer.credit_limit_set` en `audit_events`
--      con el valor anterior y el nuevo. La escribe el trigger, no el caso de uso: no hay camino
--      que cambie el límite sin dejarla.
--
--   4. `platform.customer_credit(empresa, cliente)`: límite, deuda y disponible, en USD. La deuda
--      es la de LA función de deuda (`platform.customer_debt_today`, que suma
--      `platform.document_debt`): aquí solo se convierte a USD con la tasa oficial de hoy. No es
--      otra función de deuda. Si la deuda no se puede decir (falta la tasa de hoy, o un cobro
--      viejo sin tasa), `debt_usd` y `available_usd` van en NULL — quien la use rechaza el fiado
--      (modo de fallo ruidoso), jamás lo deja pasar.
--
-- Reversibilidad (honesta, con datos vivos):
--   · los permisos y sus filas de `role_permissions` se borran sin pérdida — salvo las
--     asignaciones que un dueño haya hecho a roles propios, que habría que recrear;
--   · la columna se puede soltar, pero con ella se van los límites fijados desde el deploy. No
--     se pierden del todo: cada uno está en `audit_events` (`customer.credit_limit_set`, con su
--     valor), que es append-only y no se toca. Restaurarlos sería releer el acta;
--   · soltar triggers y función no pierde nada.
--   No reescribe ni borra ningún dato existente: ningún documento, cobro ni asiento cambia.
--
-- Funciones que esta migración redefine: NINGUNA (las dos son nuevas).
-- =============================================================================

-- ── 1. Los permisos y su reparto ─────────────────────────────────────────────
insert into public.permissions (key, description, is_scoped) values
  ('sales.credit',
   'Fiar en la caja: dejar una venta sin cobrar del todo, dentro del límite de fiado del cliente',
   false),
  ('customers.credit.set',
   'Fijar el límite de fiado de un cliente; deja acta con el valor anterior y el nuevo', false)
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key, tenant_id)
select r.id, v.permiso, null
  from (values ('cashier', 'sales.credit'),
               ('store_manager', 'sales.credit'),
               ('back_office', 'sales.credit'),
               ('owner', 'sales.credit'),
               ('back_office', 'customers.credit.set'),
               ('owner', 'customers.credit.set')) as v(rol, permiso)
  join public.roles r on r.key = v.rol and r.tenant_id is null
on conflict (role_id, permission_key) do nothing;

do $$
begin
  if (select count(*) from public.role_permissions rp
        join public.roles r on r.id = rp.role_id and r.tenant_id is null
       where (rp.permission_key = 'sales.credit'
              and r.key in ('cashier', 'store_manager', 'back_office', 'owner'))
          or (rp.permission_key = 'customers.credit.set' and r.key in ('back_office', 'owner')))
     <> 6 then
    raise exception 'LAD37: los permisos de fiado no quedaron en sus seis roles de sistema';
  end if;
  if exists (select 1 from public.role_permissions rp
               join public.roles r on r.id = rp.role_id and r.tenant_id is null
              where rp.permission_key = 'customers.credit.set' and r.key = 'cashier') then
    raise exception 'LAD37: el cajero no fija límites de fiado';
  end if;
end $$;

-- ── 2. El límite ─────────────────────────────────────────────────────────────
alter table public.customers
  add column credit_limit_usd numeric(24,8) not null default 0;
alter table public.customers
  add constraint customers_credit_limit_chk check (credit_limit_usd >= 0);
comment on column public.customers.credit_limit_usd is
  'Límite de fiado del cliente, en USD (el fiado se ancla en USD). 0 = no se le fía. Nace en 0 '
  '(LAD78) y solo lo cambia quien tenga customers.credit.set (LAD79); cada cambio deja acta '
  '(customer.credit_limit_set). Se compara contra platform.customer_credit().';
comment on constraint customers_credit_limit_chk on public.customers is
  'Un límite de fiado negativo no significa nada: «no se le fía» es 0.';

-- ── 3. Las defensas y el acta ────────────────────────────────────────────────
create function platform.guard_customer_credit_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Solo el GUC del camino de servidor: `authenticated` no tiene UPDATE sobre customers.
  v_actor uuid := platform.ladino_service_actor_id();
begin
  if tg_op = 'INSERT' then
    raise exception
      'LADINO_LIMITE_DE_FIADO_AL_NACER: un cliente nace con límite de fiado 0; lo fija después '
      'quien tenga el permiso customers.credit.set.'
      using errcode = 'LAD78';
  end if;

  if v_actor is not null
     and not platform.ladino_user_has_permission(v_actor, 'customers.credit.set', new.company_id)
  then
    raise exception
      'LADINO_LIMITE_DE_FIADO_SIN_PERMISO: fijar el límite de fiado de un cliente exige el '
      'permiso customers.credit.set.'
      using errcode = 'LAD79',
            hint = 'Conceda customers.credit.set en la empresa, o use el caso de uso de la API.';
  end if;

  insert into public.audit_events
    (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
     actor_type, occurred_at, rules_version, payload)
  values
    (new.tenant_id, new.company_id, 'customer', new.id, 'customer.credit_limit_set',
     case when v_actor is null then 'system' else 'user' end, now(),
     coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-guard'),
     jsonb_build_object(
       'credit_limit_usd_anterior', old.credit_limit_usd::text,
       'credit_limit_usd_nuevo',    new.credit_limit_usd::text,
       'currency',                  'USD',
       'legal_name',                new.legal_name));
  return null;
end;
$$;
revoke execute on function platform.guard_customer_credit_limit() from public;

create trigger customers_credit_limit_born_zero
  after insert on public.customers
  for each row when (new.credit_limit_usd <> 0)
  execute function platform.guard_customer_credit_limit();
create trigger customers_credit_limit_guard
  after update of credit_limit_usd on public.customers
  for each row when (old.credit_limit_usd is distinct from new.credit_limit_usd)
  execute function platform.guard_customer_credit_limit();
comment on trigger customers_credit_limit_guard on public.customers is
  'E-09: el límite de fiado solo lo cambia quien tenga customers.credit.set (LAD79) y cada cambio '
  'deja acta. Quitarlo deja el límite editable por cualquier camino de la API y sin rastro.';

-- ── 4. Límite, deuda y disponible, en USD ────────────────────────────────────
create function platform.customer_credit(p_company uuid, p_customer uuid)
returns table (limit_usd numeric, debt_usd numeric, available_usd numeric)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_limite numeric;
  v_funcional text;
  v_deuda numeric;
  v_tasa numeric;
  v_deuda_usd numeric;
begin
  select cu.credit_limit_usd, c.functional_currency_code
    into v_limite, v_funcional
    from public.customers cu
    join public.companies c on c.id = cu.company_id
   where cu.id = p_customer and cu.company_id = p_company;
  if not found then return; end if;

  -- LA deuda (ADR-0075 §5): en moneda funcional, a la tasa de hoy. NULL = no se puede decir.
  v_deuda := platform.customer_debt_today(p_company, p_customer);
  if v_deuda is null then
    return query select v_limite, null::numeric, null::numeric;
    return;
  end if;

  if v_deuda = 0 then
    v_deuda_usd := 0;
  elsif v_funcional = 'USD' then
    v_deuda_usd := round(v_deuda, 2);
  else
    -- La fecha, declarada: el DÍA de Caracas de ahora (date contra date dentro de rate_at).
    v_tasa := platform.rate_at(p_company, 'USD', v_funcional, platform.caracas_day(now()));
    if v_tasa is null or v_tasa = 0 then
      return query select v_limite, null::numeric, null::numeric;
      return;
    end if;
    v_deuda_usd := round(v_deuda / v_tasa, 2);
  end if;

  return query select v_limite, v_deuda_usd, greatest(v_limite - v_deuda_usd, 0);
end;
$$;
revoke execute on function platform.customer_credit(uuid, uuid) from public;
grant execute on function platform.customer_credit(uuid, uuid) to authenticated, ladino_api;
comment on function platform.customer_credit(uuid, uuid) is
  'E-09: límite de fiado, deuda y disponible de un cliente, en USD. La deuda es la de '
  'platform.customer_debt_today (LA función de deuda), convertida a USD con la tasa oficial de '
  'hoy. debt_usd y available_usd en NULL = la deuda no se puede decir (sin tasa de hoy): quien '
  'decide un fiado con esto lo RECHAZA, nunca lo deja pasar.';

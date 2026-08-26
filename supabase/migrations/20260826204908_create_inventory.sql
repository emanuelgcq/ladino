-- =============================================================================
-- Ladino — migración 19 · Inventario: movimientos, existencias, lotes y costeo
--
-- Módulo: inventory   Spec: docs/03_MODULES/INVENTORY_SPEC.md ·
--                           docs/03_MODULES/WAREHOUSE_OPERATIONS_SPEC.md ·
--                           ADR-0006 (append-only, dos capas) · ADR-0020 (siete campos) ·
--                           ADR-0024 (política de redondeo) · ADR-0034 (este módulo)
-- Reversible: SÍ mientras inventory_moves esté VACÍA (drop de tablas, funciones y
--             columnas nuevas). Con movimientos, NO: es el kardex, y borrarlo es lo
--             que la tabla existe para impedir.
-- Homologación: NO (costeo interno; ningún documento fiscal se emite aquí. El COGS lo
--               consumirá contabilidad con su propio asiento).
--
-- DENTRO: inventory_moves (append-only), stock_balances (kardex MATERIALIZADO por
-- trigger, en la misma transacción), lots, inventory_settings (método de costeo y
-- política de negativo por company), las banderas de products, la moneda funcional
-- de la company (ADR-0020 la exige «por empresa» y no existía), recompute_stock() y
-- stock_at() con la FECHA como parámetro.
--
-- FUERA, con razón (ADR-0034 §Alcance):
--   · reservations → van con VENTAS: son compromiso de pedido, no existencia.
--   · counts (draft→counting→review→posted) → módulo propio: es un flujo con
--     aprobación (STATE_MACHINES.md), no una tabla.
--   · serials → la bandera products.tracks_serials SÍ entra; la estructura se difiere
--     como se hizo con BOM en la 16. Un producto con la bandera NO PUEDE MOVERSE hasta
--     que exista el rastreo (LAD38): ausencia de mecanismo no es prohibición.
--   · bom_components → la bandera products.is_manufactured SÍ entra; la estructura
--     (qué consume producir) es del módulo de producción.
--   · «en tránsito» → NO EXISTE: la transferencia es INSTANTÁNEA, salida y entrada
--     en la misma transacción con referencia mutua y un constraint trigger diferido
--     que exige las dos patas cuadradas al COMMIT (LAD40). El stock no puede
--     desaparecer en ningún intervalo porque no hay intervalo. Si logística necesita
--     tránsito, se modela como un almacén más (tipo «tránsito»): es compatible.
--
-- COSTEO (decisión 1): PROMEDIO PONDERADO MÓVIL por posición (company, almacén,
-- producto, lote), recalculado en cada entrada. La regla vive UNA vez en
-- packages/inventory (TypeScript, tests de propiedad) y el esquema la VERIFICA con
-- un oráculo de multiplicaciones exactas —sin dividir— en el trigger de aplicación
-- (LAD41): dos implementaciones que tienen que coincidir, y el desacuerdo es un
-- error ruidoso, no un dato mal costeado en silencio. Siempre en moneda funcional
-- (decisión 5); una entrada en otra moneda persiste los siete campos de ADR-0020 y
-- la política de redondeo (ADR-0024), y sin fuente de tasa no entra.
--
-- NEGATIVO (decisión 2): jamás silencioso. Exige inventory_settings.allow_negative_stock
-- Y el permiso acotado inventory.negative del ACTOR sobre el almacén (LAD39), en el
-- esquema, para los dos caminos (JWT o GUC de servicio).
--
-- ORDEN: el costeo sigue el orden de REGISTRO (el id uuidv7 es monótono); stock_at()
-- sigue occurred_at, que es parámetro y nunca now() — un backdate cambia la
-- existencia histórica a una fecha, no el promedio ya calculado.
-- =============================================================================

-- ── 0. Moneda funcional por company (ADR-0020 §Decisión: «se configura por empresa») ──
-- Default el bolívar, moneda de curso legal. La moneda funcional es un JUICIO
-- contable de la entidad (VEN-NIF); cambiarla es un UPDATE con company.manage
-- cuando exista el caso de uso. VALIDAR-TRIBUTARIO: default provisional.
alter table public.companies
  add column functional_currency_code text not null default 'VES';
alter table public.companies
  add constraint companies_functional_currency_fk
    foreign key (functional_currency_code) references public.currencies (code);
comment on column public.companies.functional_currency_code is
  'Moneda funcional de la company (ADR-0020). El costeo de inventario y la '
  'contabilidad cuadran en ella. Default VES provisional (VALIDAR-TRIBUTARIO): '
  'es juicio contable de la entidad, no regla del sistema.';

-- ── 1. Banderas de existencia en products (decisión 4: la estructura vive aquí) ──
alter table public.products
  add column tracks_lots     boolean not null default false,
  add column tracks_serials  boolean not null default false,
  add column is_manufactured boolean not null default false;
alter table public.products
  add constraint products_tracking_goods_only_chk
    check (kind = 'good' or (not tracks_lots and not tracks_serials and not is_manufactured));
comment on column public.products.tracks_lots is
  'Las existencias de este producto se llevan por lote (lots). Bandera de '
  'catálogo; la estructura es de inventario (ADR-0034). Congelada cuando hay movimientos (LAD38).';
comment on column public.products.tracks_serials is
  'Declara seriales. El rastreo NO existe todavía: un producto con esta bandera '
  'no puede moverse (LAD38) hasta que el módulo lo implemente — ausencia de '
  'mecanismo no es prohibición.';
comment on column public.products.is_manufactured is
  'Producto fabricado (tendrá BOM en producción). Sin efecto sobre movimientos.';

-- ── 2. Configuración de inventario por company ─────────────────────────────
create table public.inventory_settings (
  company_id           uuid        primary key,
  tenant_id            uuid        not null,
  costing_method       text        not null default 'promedio_ponderado_movil',
  allow_negative_stock boolean     not null default false,
  created_by           uuid,
  created_at           timestamptz not null,
  version              integer     not null,
  constraint inventory_settings_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint inventory_settings_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  -- Un solo método hoy. FIFO mañana es una fila más aquí y un módulo más en
  -- packages/inventory, no rehacer este (decisión 1).
  constraint inventory_settings_method_chk
    check (costing_method in ('promedio_ponderado_movil'))
);
comment on table public.inventory_settings is
  'Política de inventario por company (ADR-0034): método de costeo (dato, no '
  'hard-coded) y si se permite existencia negativa. SIN FILA = defaults '
  'conservadores (promedio, negativo NO permitido). La fila la crea el operador '
  'o un caso de uso futuro con company.manage.';

-- ── 3. Lotes: atributo de EXISTENCIA, no de catálogo ────────────────────────
create table public.lots (
  id          uuid        primary key default platform.uuidv7(),
  tenant_id   uuid        not null,
  company_id  uuid        not null,
  product_id  uuid        not null,
  code        text        not null,
  expires_at  date,
  status      text        not null default 'active',
  created_by  uuid,
  created_at  timestamptz not null,
  version     integer     not null,
  constraint lots_tenant_fk  foreign key (tenant_id) references public.tenants (id),
  constraint lots_company_fk foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint lots_product_fk foreign key (company_id, product_id) references public.products (company_id, id),
  constraint lots_code_chk   check (code = btrim(code) and length(code) between 1 and 60),
  constraint lots_status_chk check (status in ('active', 'inactive')),
  constraint lots_product_code_key unique (product_id, code),
  constraint lots_company_id_key   unique (company_id, id)
);
comment on table public.lots is
  'Lote de un producto: instancia física de existencia (ADR-0034 §Frontera). Se '
  'crea al RECIBIR (el lote aparece cuando entra). El vencimiento es dato; qué '
  'hacer con un lote vencido es del módulo que vende.';

-- ── 4. El kardex: inventory_moves, APPEND-ONLY (ADR-0006, dos capas) ────────
create table public.inventory_moves (
  id            uuid          primary key default platform.uuidv7(),
  tenant_id     uuid          not null,
  company_id    uuid          not null,
  warehouse_id  uuid          not null,
  product_id    uuid          not null,
  lot_id        uuid,
  kind          text          not null,
  -- CON SIGNO: entrada > 0, salida < 0, ajuste ≠ 0. Sumar es recomputar.
  quantity      numeric(24,8) not null,

  -- Los SIETE campos de ADR-0020, con los nombres exactos del ADR, más la
  -- política de redondeo de ADR-0024. Con el signo de quantity.
  amount_transaction_currency numeric(24,8) not null,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null,
  functional_amount           numeric(24,8) not null,
  functional_currency         text          not null,
  rate_source                 text          not null,
  rate_timestamp              timestamptz   not null,
  rounding_policy_id          text          not null,

  -- Kardex: costo unitario RESULTANTE y saldos tras el movimiento. Los calcula
  -- el trigger; si el caso de uso los trae, tienen que coincidir (LAD41).
  unit_cost       numeric(24,8) not null,
  quantity_after  numeric(24,8) not null,
  value_after     numeric(24,8) not null,

  occurred_at   timestamptz   not null,
  reference     text,
  reason        text,
  note          text,
  transfer_id          uuid,
  counterpart_move_id  uuid,

  created_by    uuid,
  created_at    timestamptz   not null,
  version       integer       not null,

  constraint inventory_moves_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint inventory_moves_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint inventory_moves_warehouse_fk
    foreign key (company_id, warehouse_id) references public.warehouses (company_id, id),
  constraint inventory_moves_product_fk
    foreign key (company_id, product_id) references public.products (company_id, id),
  constraint inventory_moves_lot_fk
    foreign key (company_id, lot_id) references public.lots (company_id, id),
  constraint inventory_moves_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint inventory_moves_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  -- La pata contraria puede no existir todavía cuando se inserta la primera:
  -- DIFERIDA al commit, donde LAD40 exige las dos.
  constraint inventory_moves_counterpart_fk
    foreign key (counterpart_move_id) references public.inventory_moves (id)
    deferrable initially deferred,

  constraint inventory_moves_kind_chk
    check (kind in ('entrada', 'salida', 'ajuste', 'transferencia_in', 'transferencia_out')),
  constraint inventory_moves_sign_chk check (
    case kind
      when 'entrada'           then quantity > 0 and functional_amount >= 0 and amount_transaction_currency >= 0
      when 'transferencia_in'  then quantity > 0 and functional_amount >= 0 and amount_transaction_currency >= 0
      when 'salida'            then quantity < 0 and functional_amount <= 0 and amount_transaction_currency <= 0
      when 'transferencia_out' then quantity < 0 and functional_amount <= 0 and amount_transaction_currency <= 0
      else quantity <> 0
           and sign(functional_amount) in (0, sign(quantity))
           and sign(amount_transaction_currency) in (0, sign(quantity))
    end),
  constraint inventory_moves_fx_rate_chk    check (fx_rate > 0),
  constraint inventory_moves_rate_source_chk check (length(btrim(rate_source)) between 1 and 120),
  constraint inventory_moves_policy_chk      check (length(btrim(rounding_policy_id)) between 1 and 64),
  -- Misma moneda ⇒ tasa 1 e importes iguales: la identidad no es una conversión.
  constraint inventory_moves_identity_chk check (
    transaction_currency <> functional_currency
    or (fx_rate = 1 and amount_transaction_currency = functional_amount)),
  constraint inventory_moves_unit_cost_chk check (unit_cost >= 0),
  constraint inventory_moves_transfer_chk check (
    ((kind in ('transferencia_in', 'transferencia_out')) = (transfer_id is not null))
    and ((transfer_id is not null) = (counterpart_move_id is not null))
    and (counterpart_move_id is null or counterpart_move_id <> id)),
  constraint inventory_moves_reason_chk check (
    (kind = 'ajuste') = (reason is not null)
    and (reason is null or (reason = btrim(reason) and length(reason) between 3 and 500))),
  constraint inventory_moves_reference_chk
    check (reference is null or (reference = btrim(reference) and length(reference) between 1 and 60)),
  constraint inventory_moves_note_chk
    check (note is null or (note = btrim(note) and length(note) between 1 and 500)),
  -- Un movimiento no ocurre en el futuro. Funciona porque los BEFORE ROW fijan
  -- created_at antes de que se evalúe el CHECK (verificado en S0.3).
  constraint inventory_moves_occurred_at_chk check (occurred_at <= created_at)
);
comment on table public.inventory_moves is
  'Kardex. APPEND-ONLY en dos capas (ADR-0006): sin policies ni GRANT de '
  'UPDATE/DELETE para nadie, y reject_mutation() en trigger de fila y de TRUNCATE, '
  'que alcanza a service_role. Un error se corrige con un ajuste nuevo. Cada fila '
  'lleva los siete campos de ADR-0020, la política de redondeo (ADR-0024) y el '
  'saldo/costo unitario resultante (ADR-0034).';
comment on column public.inventory_moves.unit_cost is
  'Costo unitario promedio RESULTANTE tras el movimiento, en moneda funcional, '
  'proyectado a 8 decimales con rounding_policy_id. Si el cociente valor/cantidad '
  'no significa nada (cantidad ≤ 0 o valor < 0), se arrastra el último conocido.';

-- Clave natural del caso de uso: la referencia del documento de origen, única
-- por company y tipo cuando existe (T1/T2 de idempotencia, como el SKU).
create unique index inventory_moves_company_kind_reference_uidx
  on public.inventory_moves (company_id, kind, reference) where reference is not null;
create index inventory_moves_tenant_company_idx on public.inventory_moves (tenant_id, company_id);
create index inventory_moves_position_idx
  on public.inventory_moves (company_id, warehouse_id, product_id, lot_id, id);
create index inventory_moves_product_occurred_idx
  on public.inventory_moves (company_id, product_id, occurred_at, id);
create index inventory_moves_company_occurred_idx
  on public.inventory_moves (company_id, occurred_at desc, id desc);
create index inventory_moves_transfer_idx
  on public.inventory_moves (transfer_id) where transfer_id is not null;

-- ── 5. Existencias MATERIALIZADAS (decisión 6): una fila por posición ────────
create table public.stock_balances (
  id              uuid          primary key default platform.uuidv7(),
  tenant_id       uuid          not null,
  company_id      uuid          not null,
  warehouse_id    uuid          not null,
  product_id      uuid          not null,
  lot_id          uuid,
  -- lot_id nullable no deduplica bajo UNIQUE: se materializa la clave.
  lot_key         uuid          generated always as
                    (coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  quantity        numeric(24,8) not null default 0,
  value           numeric(24,8) not null default 0,
  currency_code   text          not null,
  last_unit_cost  numeric(24,8) not null default 0,
  last_move_id    uuid,
  moves_count     bigint        not null default 0,
  updated_at      timestamptz   not null default now(),
  created_by      uuid,
  created_at      timestamptz   not null,
  version         integer       not null,
  constraint stock_balances_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint stock_balances_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint stock_balances_warehouse_fk
    foreign key (company_id, warehouse_id) references public.warehouses (company_id, id),
  constraint stock_balances_product_fk
    foreign key (company_id, product_id) references public.products (company_id, id),
  constraint stock_balances_lot_fk
    foreign key (company_id, lot_id) references public.lots (company_id, id),
  constraint stock_balances_currency_fk
    foreign key (currency_code) references public.currencies (code),
  constraint stock_balances_last_unit_cost_chk check (last_unit_cost >= 0),
  constraint stock_balances_position_key unique (warehouse_id, product_id, lot_key)
);
comment on table public.stock_balances is
  'Kardex MATERIALIZADO por (company, almacén, producto, lote): lo consulta el POS. '
  'La escribe SOLO el trigger de inventory_moves, en la misma transacción; nadie '
  'tiene INSERT/UPDATE/DELETE por GRANT. platform.recompute_stock() lo recalcula '
  'desde los movimientos y platform.stock_reconciliation() lista divergencias: '
  'el criterio de aceptación «kardex reproduce balance» es un test (pgTAP 019).';

create index stock_balances_tenant_company_idx on public.stock_balances (tenant_id, company_id);
create index stock_balances_company_product_idx on public.stock_balances (company_id, product_id);
create index stock_balances_company_warehouse_idx on public.stock_balances (company_id, warehouse_id);

-- ── 6. Procedencia y anclas en todo lo nuevo ────────────────────────────────
create trigger inventory_settings_provenance
  before insert or update on public.inventory_settings
  for each row execute function platform.set_row_provenance();
create trigger inventory_settings_anchors_immutable
  before update on public.inventory_settings
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger lots_provenance
  before insert or update on public.lots
  for each row execute function platform.set_row_provenance();
create trigger lots_anchors_immutable
  before update on public.lots
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger stock_balances_provenance
  before insert or update on public.stock_balances
  for each row execute function platform.set_row_provenance();
create trigger stock_balances_anchors_immutable
  before update on public.stock_balances
  for each row execute function platform.assert_isolation_anchors_immutable();
-- En inventory_moves los BEFORE van NUMERADOS: Postgres dispara los triggers de
-- una tabla por ORDEN ALFABÉTICO de nombre, y la aplicación tiene que correr
-- después de la procedencia. Que el orden sea explícito y no una casualidad.
create trigger inventory_moves_00_provenance
  before insert or update on public.inventory_moves
  for each row execute function platform.set_row_provenance();
create trigger inventory_moves_01_anchors_immutable
  before update on public.inventory_moves
  for each row execute function platform.assert_isolation_anchors_immutable();

-- ── 7. Capa 2 del append-only: reject_mutation() en fila y en TRUNCATE ──────
create trigger inventory_moves_append_only
  before update or delete on public.inventory_moves
  for each row execute function platform.reject_mutation();
create trigger inventory_moves_no_truncate
  before truncate on public.inventory_moves
  for each statement execute function platform.reject_mutation();
-- Las existencias no se truncan ni se borran a mano: se recomputan desde el kardex.
create trigger stock_balances_no_truncate
  before truncate on public.stock_balances
  for each statement execute function platform.reject_mutation();
create trigger stock_balances_no_delete
  before delete on public.stock_balances
  for each row execute function platform.reject_mutation();

-- ── 8. Banderas de rastreo congeladas con movimientos (LAD38) ───────────────
create function platform.assert_product_tracking_frozen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.tracks_lots is distinct from old.tracks_lots
      or new.tracks_serials is distinct from old.tracks_serials)
     and exists (select 1 from public.inventory_moves m where m.product_id = old.id) then
    raise exception
      'las banderas de rastreo (lotes/seriales) no se cambian con movimientos registrados: '
      'las existencias ya están llevadas de una forma. Crea otro producto.'
      using errcode = 'LAD38', hint = 'ADR-0034: la frontera lotes/seriales es de existencia';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_product_tracking_frozen() from public;
create trigger products_tracking_frozen
  before update of tracks_lots, tracks_serials on public.products
  for each row execute function platform.assert_product_tracking_frozen();

-- ── 9. Alcance por recurso con actor explícito: UNA implementación ──────────
-- ladino_has_scope() (S0.3) resolvía con auth.uid(). El camino de servidor y el
-- trigger de negativo necesitan preguntar por un ACTOR dado, igual que
-- ladino_user_has_permission() hizo con ladino_has_permission() en la 11. La
-- original pasa a delegar (envoltorio plpgsql, no SQL: la regresión de 28× de S0.4).
create function platform.ladino_user_has_scope(
  p_user       uuid,
  p_permission text,
  p_scope_type text,
  p_scope_id   uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
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
       and rp.permission_key = p_permission
     where c.id = platform.resource_company_id(p_scope_type, p_scope_id)
       and (
             not r.requires_scope
          or exists (
               select 1
                 from public.scope_bindings sb
                where sb.assignment_id = ura.id
                  and sb.scope_type    = p_scope_type
                  and sb.scope_id      = p_scope_id
             )
       )
  );
$$;
comment on function platform.ladino_user_has_scope(uuid, text, text, uuid) is
  'Resolución de alcance por RECURSO parametrizada por usuario. Implementación '
  'ÚNICA: ladino_has_scope() delega aquí con auth.uid(). NO se concede a '
  'authenticated: sería un oráculo de permisos ajenos (la 12 hizo lo mismo con '
  'ladino_user_has_permission).';
revoke execute on function platform.ladino_user_has_scope(uuid, text, text, uuid) from public;
grant  execute on function platform.ladino_user_has_scope(uuid, text, text, uuid) to ladino_api;

create or replace function platform.ladino_has_scope(
  p_permission text,
  p_scope_type text,
  p_scope_id   uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return platform.ladino_user_has_scope(auth.uid(), p_permission, p_scope_type, p_scope_id);
end;
$$;

-- ── 10. La posición: crear-si-no-existe y BLOQUEAR ──────────────────────────
-- Interna (sin GRANT): la usan el trigger y lock_stock_position(). Bloquea la fila
-- FOR UPDATE hasta el commit: dos movimientos sobre la misma posición se
-- serializan, y el segundo calcula sobre el estado que dejó el primero.
create function platform.stock_position_lock(
  p_tenant    uuid,
  p_company   uuid,
  p_warehouse uuid,
  p_product   uuid,
  p_lot       uuid,
  p_currency  text
)
returns public.stock_balances
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.stock_balances;
begin
  insert into public.stock_balances (tenant_id, company_id, warehouse_id, product_id, lot_id, currency_code)
  values (p_tenant, p_company, p_warehouse, p_product, p_lot, p_currency)
  on conflict on constraint stock_balances_position_key do nothing;

  select * into v_row
    from public.stock_balances b
   where b.warehouse_id = p_warehouse
     and b.product_id   = p_product
     and b.lot_key      = coalesce(p_lot, '00000000-0000-0000-0000-000000000000'::uuid)
     for update;
  return v_row;
end;
$$;
revoke execute on function platform.stock_position_lock(uuid, uuid, uuid, uuid, uuid, text) from public;

-- La pública, para el caso de uso: MISMA visibilidad que todo lo demás (la copia
-- única de ladino_user_company_ids con el actor del GUC o del JWT), y devuelve la
-- posición bloqueada para calcular el costeo sobre ella.
create function platform.lock_stock_position(
  p_company   uuid,
  p_warehouse uuid,
  p_product   uuid,
  p_lot       uuid
)
returns table (quantity numeric, value numeric, currency_code text, last_unit_cost numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid;
  v_tenant   uuid;
  v_currency text;
  v_row      public.stock_balances;
begin
  v_actor := coalesce(auth.uid(), platform.ladino_service_actor_id());
  if v_actor is null
     or p_company not in (select platform.ladino_user_company_ids(v_actor)) then
    -- El mismo cuerpo que un 404: invisible e inexistente son indistinguibles.
    raise exception 'posición de existencias no encontrada' using errcode = '23503';
  end if;
  select c.tenant_id, c.functional_currency_code into v_tenant, v_currency
    from public.companies c where c.id = p_company;
  v_row := platform.stock_position_lock(v_tenant, p_company, p_warehouse, p_product, p_lot, v_currency);
  return query select v_row.quantity, v_row.value, v_row.currency_code, v_row.last_unit_cost;
end;
$$;
comment on function platform.lock_stock_position(uuid, uuid, uuid, uuid) is
  'Crea (si no existe) y BLOQUEA la posición (company, almacén, producto, lote) '
  'hasta el commit, devolviendo cantidad, valor, moneda y último costo unitario. '
  'El caso de uso calcula el costeo sobre esto; el trigger lo verifica (LAD41). '
  'Un almacén o producto de otra company muere en el FK compuesto (23503 → 404).';
revoke execute on function platform.lock_stock_position(uuid, uuid, uuid, uuid) from public;
grant  execute on function platform.lock_stock_position(uuid, uuid, uuid, uuid) to ladino_api;

-- ── 11. EL TRIGGER: aplica el movimiento al kardex materializado ────────────
-- BEFORE INSERT, SECURITY DEFINER (escribe stock_balances, que nadie más puede).
--   1. producto: bien, activo, sin seriales (diferidos), lote obligatorio/prohibido;
--   2. almacén activo y de la company; moneda funcional = la de la company;
--   3. bloquea la posición;
--   4. NEGATIVO: política de la company Y permiso acotado del actor (LAD39);
--   5. ORÁCULO DEL COSTEO para salidas (LAD41), con multiplicaciones exactas;
--   6. calcula saldos y costo unitario resultante; si el caso de uso los trajo,
--      tienen que coincidir (LAD41);
--   7. actualiza la posición.
create function platform.apply_inventory_move()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_functional text;
  v_tenant     uuid;
  p            record;
  w_status     text;
  l            record;
  b            public.stock_balances;
  v_q          numeric;   -- |quantity|
  v_cost       numeric;   -- |functional_amount| de una salida
  v_qty_after  numeric;
  v_val_after  numeric;
  v_unit       numeric;
  v_meaningful boolean;
  v_allow      boolean;
  v_actor      uuid;
  v_tol        constant numeric := 0.000000005; -- media unidad de la 8.ª cifra
begin
  -- 0. company y moneda funcional
  select c.tenant_id, c.functional_currency_code into v_tenant, v_functional
    from public.companies c where c.id = new.company_id;
  if v_tenant is null then
    raise exception 'la company del movimiento no existe' using errcode = '23503';
  end if;
  if new.functional_currency <> v_functional then
    raise exception
      'la moneda funcional del movimiento (%) no es la de la empresa (%): el costeo se lleva en moneda funcional (ADR-0020)',
      new.functional_currency, v_functional
      using errcode = 'LAD38';
  end if;

  -- 1. producto
  select pr.kind, pr.status, pr.tracks_lots, pr.tracks_serials into p
    from public.products pr where pr.id = new.product_id and pr.company_id = new.company_id;
  if p.kind is null then
    raise exception 'el producto no pertenece a esta empresa' using errcode = '23503';
  end if;
  if p.kind <> 'good' then
    raise exception 'un servicio no tiene existencias' using errcode = 'LAD38';
  end if;
  if p.status <> 'active' then
    raise exception 'el producto no está activo (%): actívalo antes de mover existencias', p.status
      using errcode = 'LAD38';
  end if;
  if p.tracks_serials then
    raise exception
      'el producto declara seriales y el rastreo de seriales no existe todavía: no puede moverse (ADR-0034, diferido con razón)'
      using errcode = 'LAD38';
  end if;
  if p.tracks_lots and new.lot_id is null then
    raise exception 'el producto se lleva por lotes: el movimiento exige lote' using errcode = 'LAD38';
  end if;
  if not p.tracks_lots and new.lot_id is not null then
    raise exception 'el producto no se lleva por lotes: el movimiento no admite lote' using errcode = 'LAD38';
  end if;
  if new.lot_id is not null then
    select lo.product_id, lo.status into l from public.lots lo
     where lo.id = new.lot_id and lo.company_id = new.company_id;
    if l.product_id is null then
      raise exception 'el lote no pertenece a esta empresa' using errcode = '23503';
    end if;
    if l.product_id <> new.product_id then
      raise exception 'el lote es de otro producto' using errcode = 'LAD38';
    end if;
    if l.status <> 'active' then
      raise exception 'el lote está inactivo' using errcode = 'LAD38';
    end if;
  end if;

  -- 2. almacén
  select wh.status into w_status from public.warehouses wh
   where wh.id = new.warehouse_id and wh.company_id = new.company_id;
  if w_status is null then
    raise exception 'el almacén no pertenece a esta empresa' using errcode = '23503';
  end if;
  if w_status <> 'active' then
    raise exception 'el almacén está inactivo' using errcode = 'LAD38';
  end if;

  -- 3. la posición, bloqueada
  b := platform.stock_position_lock(v_tenant, new.company_id, new.warehouse_id, new.product_id, new.lot_id, v_functional);
  if b.currency_code <> v_functional then
    raise exception
      'la posición está valorada en % y la empresa lleva %: regulariza antes de mover', b.currency_code, v_functional
      using errcode = 'LAD38';
  end if;

  v_q         := abs(new.quantity);
  v_qty_after := b.quantity + new.quantity;
  v_val_after := b.value + new.functional_amount;

  -- 4. negativo: nunca silencioso
  if v_qty_after < 0 then
    v_allow := coalesce((select s.allow_negative_stock from public.inventory_settings s
                          where s.company_id = new.company_id), false);
    if not v_allow then
      raise exception
        'la existencia quedaría en % y la empresa no permite existencia negativa (inventory_settings.allow_negative_stock)',
        v_qty_after
        using errcode = 'LAD39';
    end if;
    v_actor := coalesce(auth.uid(), platform.ladino_service_actor_id());
    if v_actor is null
       or not platform.ladino_user_has_scope(v_actor, 'inventory.negative', 'warehouse', new.warehouse_id) then
      raise exception
        'la empresa permite existencia negativa pero el actor no tiene inventory.negative sobre este almacén'
        using errcode = 'LAD39';
    end if;
  end if;

  -- 5. oráculo del costeo de salidas (ADR-0034 §Costeo): SIN dividir.
  if new.quantity < 0 then
    v_cost       := -new.functional_amount;
    v_meaningful := b.quantity > 0 and b.value >= 0;
    if not v_meaningful then
      if abs(v_cost - v_q * b.last_unit_cost) > v_tol then
        raise exception
          'costeo: sin promedio significativo la salida vale q × último costo (% × % = %), llegó %',
          v_q, b.last_unit_cost, v_q * b.last_unit_cost, v_cost
          using errcode = 'LAD41';
      end if;
    elsif v_q = b.quantity then
      if v_cost <> b.value then
        raise exception 'costeo: vaciar la posición saca TODO el valor (%), llegó %', b.value, v_cost
          using errcode = 'LAD41';
      end if;
    elsif v_q < b.quantity then
      if abs(v_cost * b.quantity - b.value * v_q) > v_tol * b.quantity then
        raise exception
          'costeo: la salida no es el redondeo a 8 decimales de valor × q / existencia (% × % / %), llegó %',
          b.value, v_q, b.quantity, v_cost
          using errcode = 'LAD41';
      end if;
    else
      if abs((v_cost - b.value) * b.quantity - b.value * (v_q - b.quantity)) > v_tol * b.quantity then
        raise exception
          'costeo: al pasar a negativo la salida vale todo el valor (%) más el exceso al promedio, llegó %',
          b.value, v_cost
          using errcode = 'LAD41';
      end if;
    end if;
  end if;

  -- 6. saldos y costo unitario resultante
  if v_qty_after > 0 and v_val_after >= 0 then
    v_unit := round(v_val_after / v_qty_after, 8);
    if new.unit_cost is not null
       and abs(new.unit_cost * v_qty_after - v_val_after) > v_tol * v_qty_after then
      raise exception
        'costeo: el costo unitario resultante no es valor/cantidad a 8 decimales (% / %), llegó %',
        v_val_after, v_qty_after, new.unit_cost
        using errcode = 'LAD41';
    end if;
  else
    v_unit := b.last_unit_cost;
    if new.unit_cost is not null and new.unit_cost <> v_unit then
      raise exception
        'costeo: sin promedio significativo se arrastra el último costo unitario (%), llegó %',
        v_unit, new.unit_cost
        using errcode = 'LAD41';
    end if;
  end if;
  if new.quantity_after is not null and new.quantity_after <> v_qty_after then
    raise exception 'kardex: quantity_after declarado % ≠ calculado %', new.quantity_after, v_qty_after
      using errcode = 'LAD41';
  end if;
  if new.value_after is not null and new.value_after <> v_val_after then
    raise exception 'kardex: value_after declarado % ≠ calculado %', new.value_after, v_val_after
      using errcode = 'LAD41';
  end if;
  new.quantity_after := v_qty_after;
  new.value_after    := v_val_after;
  new.unit_cost      := coalesce(new.unit_cost, v_unit);

  -- 7. la posición
  update public.stock_balances
     set quantity       = v_qty_after,
         value          = v_val_after,
         last_unit_cost = new.unit_cost,
         last_move_id   = new.id,
         moves_count    = moves_count + 1,
         updated_at     = now()
   where id = b.id;
  return new;
end;
$$;
comment on function platform.apply_inventory_move() is
  'Aplica un movimiento al kardex materializado en la MISMA transacción (ADR-0034 '
  'decisión 6) y verifica el costeo con un oráculo exacto (LAD41): dos '
  'implementaciones —packages/inventory y esta— que tienen que coincidir. '
  'Negativo: política de la company Y permiso acotado del actor (LAD39).';
revoke execute on function platform.apply_inventory_move() from public;

create trigger inventory_moves_10_apply
  before insert on public.inventory_moves
  for each row execute function platform.apply_inventory_move();

-- ── 12. Transferencia ATÓMICA: las dos patas cuadradas al COMMIT (LAD40) ────
create function platform.assert_transfer_balanced()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
begin
  if new.transfer_id is null then return null; end if;
  select count(*)                                              as n,
         sum(m.quantity)                                       as q,
         sum(m.functional_amount)                              as v,
         count(distinct m.warehouse_id)                        as almacenes,
         count(distinct m.product_id)                          as productos,
         count(distinct coalesce(m.lot_id, '00000000-0000-0000-0000-000000000000'::uuid)) as lotes,
         count(distinct m.company_id)                          as companies,
         count(*) filter (where m.kind = 'transferencia_out')  as salidas,
         count(*) filter (where m.kind = 'transferencia_in')   as entradas,
         bool_and(exists (select 1 from public.inventory_moves o
                           where o.id = m.counterpart_move_id and o.transfer_id = m.transfer_id
                             and o.counterpart_move_id = m.id)) as mutuas
    into t
    from public.inventory_moves m
   where m.transfer_id = new.transfer_id;
  if t.n <> 2 or t.q <> 0 or t.v <> 0 or t.almacenes <> 2 or t.productos <> 1
     or t.lotes <> 1 or t.companies <> 1 or t.salidas <> 1 or t.entradas <> 1
     or not coalesce(t.mutuas, false) then
    raise exception
      'transferencia %: exige exactamente una salida y una entrada, mismo producto y lote, almacenes distintos, cantidades y valor que suman cero y referencia mutua (patas=%, Σq=%, Σv=%)',
      new.transfer_id, t.n, t.q, t.v
      using errcode = 'LAD40';
  end if;
  return null;
end;
$$;
revoke execute on function platform.assert_transfer_balanced() from public;

-- El WHEN no es una optimización cosmética: un constraint trigger sin él ENCOLA un
-- evento diferido por CADA fila insertada, aunque la función salga en la primera
-- línea. Con una carga de diez mil movimientos eso son diez mil eventos vivos hasta
-- el COMMIT, y además cualquier TRUNCATE o ALTER TABLE en la misma transacción muere
-- con 55006 «pending trigger events». Con el WHEN, solo las transferencias encolan.
create constraint trigger inventory_moves_transfer_balanced
  after insert on public.inventory_moves
  deferrable initially deferred
  for each row
  when (new.transfer_id is not null)
  execute function platform.assert_transfer_balanced();

-- ── 13. Recomputar y la existencia A FECHA (parámetro, nunca now()) ─────────
-- INVOKER y STABLE: responden bajo la RLS de quien pregunta, como price_at().
create function platform.recompute_stock(
  p_company uuid, p_warehouse uuid, p_product uuid, p_lot uuid default null
)
returns table (quantity numeric, value numeric)
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(m.quantity), 0), coalesce(sum(m.functional_amount), 0)
    from public.inventory_moves m
   where m.company_id   = p_company
     and m.warehouse_id = p_warehouse
     and m.product_id   = p_product
     and m.lot_id is not distinct from p_lot
$$;
comment on function platform.recompute_stock(uuid, uuid, uuid, uuid) is
  'La existencia y el valor de una posición RECALCULADOS desde el kardex. El '
  'materializado (stock_balances) tiene que coincidir: pgTAP 019 lo exige y '
  'stock_reconciliation() lo lista.';

create function platform.stock_reconciliation(p_company uuid)
returns table (
  warehouse_id uuid, product_id uuid, lot_id uuid,
  materialized_quantity numeric, recomputed_quantity numeric,
  materialized_value numeric, recomputed_value numeric
)
language sql
stable
set search_path = ''
as $$
  with k as (
    select m.warehouse_id, m.product_id, m.lot_id,
           sum(m.quantity) as q, sum(m.functional_amount) as v
      from public.inventory_moves m
     where m.company_id = p_company
     group by m.warehouse_id, m.product_id, m.lot_id
  )
  select coalesce(b.warehouse_id, k.warehouse_id),
         coalesce(b.product_id, k.product_id),
         coalesce(b.lot_id, k.lot_id),
         b.quantity, coalesce(k.q, 0), b.value, coalesce(k.v, 0)
    from public.stock_balances b
    full outer join k
      on k.warehouse_id = b.warehouse_id and k.product_id = b.product_id
     and k.lot_id is not distinct from b.lot_id
   where (b.company_id = p_company or b.company_id is null)
     and (b.quantity is distinct from coalesce(k.q, 0)
          or b.value is distinct from coalesce(k.v, 0))
$$;
comment on function platform.stock_reconciliation(uuid) is
  'Posiciones cuyo materializado NO coincide con el kardex recalculado. Vacío = '
  'el criterio «kardex reproduce balance» se cumple. Es lo que pgTAP 019 asserta '
  'y lo que un operador consulta ante la duda.';

create function platform.stock_at(
  p_company uuid, p_warehouse uuid, p_product uuid, p_fecha timestamptz
)
returns table (quantity numeric, value numeric)
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(m.quantity), 0), coalesce(sum(m.functional_amount), 0)
    from public.inventory_moves m
   where m.company_id   = p_company
     and m.warehouse_id = p_warehouse
     and m.product_id   = p_product
     and m.occurred_at <= p_fecha
$$;
comment on function platform.stock_at(uuid, uuid, uuid, timestamptz) is
  'Existencia y valor de un producto en un almacén A LA FECHA DADA (todos los '
  'lotes). La fecha es parámetro, nunca now() — igual que price_at (ADR-0032): '
  'un inventario al cierre de ayer se responde con los movimientos de ayer.';

revoke execute on function platform.recompute_stock(uuid, uuid, uuid, uuid) from public;
revoke execute on function platform.stock_reconciliation(uuid) from public;
revoke execute on function platform.stock_at(uuid, uuid, uuid, timestamptz) from public;
grant execute on function platform.recompute_stock(uuid, uuid, uuid, uuid) to authenticated, ladino_api;
grant execute on function platform.stock_reconciliation(uuid) to authenticated, ladino_api;
grant execute on function platform.stock_at(uuid, uuid, uuid, timestamptz) to authenticated, ladino_api;

-- ── 14. RLS y grants ────────────────────────────────────────────────────────
alter table public.inventory_settings enable row level security;
alter table public.inventory_settings force  row level security;
alter table public.lots               enable row level security;
alter table public.lots               force  row level security;
alter table public.inventory_moves    enable row level security;
alter table public.inventory_moves    force  row level security;
alter table public.stock_balances     enable row level security;
alter table public.stock_balances     force  row level security;

create policy inventory_settings_select on public.inventory_settings for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy inventory_settings_insert on public.inventory_settings for insert to authenticated with check (false);
create policy inventory_settings_update on public.inventory_settings for update to authenticated using (false);
create policy inventory_settings_delete on public.inventory_settings for delete to authenticated, ladino_api using (false);
create policy inventory_settings_api_select on public.inventory_settings for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy inventory_settings_api_insert on public.inventory_settings for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy inventory_settings_api_update on public.inventory_settings for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));

create policy lots_select on public.lots for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy lots_insert on public.lots for insert to authenticated with check (false);
create policy lots_update on public.lots for update to authenticated using (false);
create policy lots_delete on public.lots for delete to authenticated, ladino_api using (false);
create policy lots_api_select on public.lots for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy lots_api_insert on public.lots for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy lots_api_update on public.lots for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));

-- inventory_moves: capa 1 del append-only — UPDATE y DELETE denegados POR ESCRITO
-- para los dos roles; INSERT solo por la API.
create policy inventory_moves_select on public.inventory_moves for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy inventory_moves_insert on public.inventory_moves for insert to authenticated with check (false);
create policy inventory_moves_update on public.inventory_moves for update to authenticated, ladino_api using (false);
create policy inventory_moves_delete on public.inventory_moves for delete to authenticated, ladino_api using (false);
create policy inventory_moves_api_select on public.inventory_moves for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy inventory_moves_api_insert on public.inventory_moves for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));

-- stock_balances: SOLO lectura para todos. La escribe el trigger (definer).
create policy stock_balances_select on public.stock_balances for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy stock_balances_api_select on public.stock_balances for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy stock_balances_insert on public.stock_balances for insert to authenticated, ladino_api with check (false);
create policy stock_balances_update on public.stock_balances for update to authenticated, ladino_api using (false);
create policy stock_balances_delete on public.stock_balances for delete to authenticated, ladino_api using (false);

revoke all on public.inventory_settings, public.lots, public.inventory_moves, public.stock_balances
  from anon, authenticated, service_role, ladino_api, ladino_worker;
grant select on public.inventory_settings, public.lots, public.inventory_moves, public.stock_balances
  to authenticated;
grant select, insert, update on public.inventory_settings, public.lots to ladino_api;
-- El kardex: INSERT y SELECT. Ni UPDATE ni DELETE ni TRUNCATE, ni por GRANT.
grant select, insert on public.inventory_moves to ladino_api;
grant select on public.stock_balances to ladino_api;

-- ── 15. Permisos ────────────────────────────────────────────────────────────
-- Los de MOVIMIENTO son is_scoped = true: un almacenista opera los almacenes que
-- tiene enlazados (scope_bindings). `inventory.negative` también: dejar una
-- posición en negativo es una atribución sobre ESE almacén. Los ajustes con
-- aprobación de supervisor son segregación: inventory.adjust es un permiso
-- distinto de inventory.move, no un flujo de aprobación (todavía).
-- `warehouse.move` (S0.3) queda en el catálogo SIN usarse: los permisos no se
-- renombran ni se borran, se añade el nuevo y se deja de conceder el viejo.
insert into public.permissions (key, description, is_scoped) values
  ('inventory.move',     'Registrar entradas y salidas de existencias en un almacén', true),
  ('inventory.adjust',   'Registrar ajustes de existencias con motivo (supervisor)', true),
  ('inventory.transfer', 'Transferir existencias entre almacenes (exige alcance en los dos)', true),
  ('inventory.negative', 'Dejar una posición en existencia negativa cuando la empresa lo permite', true)
on conflict (key) do nothing;

-- ── 16. Lo que esta migración GARANTIZA sobre sí misma (LAD42, una ejecución) ─
do $$
begin
  if (select count(*) from public.permissions
       where key in ('inventory.move', 'inventory.adjust', 'inventory.transfer', 'inventory.negative')
         and is_scoped) <> 4 then
    raise exception 'LAD42: faltan permisos acotados de inventario tras el seed';
  end if;
  if not exists (select 1 from public.permissions where key = 'warehouse.manage') then
    raise exception 'LAD42: warehouse.manage no existe y el caso de uso de almacenes lo exige';
  end if;
  if (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relname = 'inventory_moves'
         and t.tgfoid = 'platform.reject_mutation()'::regprocedure) <> 2 then
    raise exception 'LAD42: inventory_moves no tiene las dos capas de reject_mutation (fila y TRUNCATE)';
  end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('inventory_settings', 'lots', 'inventory_moves', 'stock_balances')
         and c.relrowsecurity and c.relforcerowsecurity) <> 4 then
    raise exception 'LAD42: alguna tabla de inventario no tiene RLS habilitada y forzada';
  end if;
end $$;

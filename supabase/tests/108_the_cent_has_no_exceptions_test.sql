-- =============================================================================
-- pgTAP 108 · EL CÉNTIMO NO TIENE EXCEPCIONES (ADR-0075 §7 · migraciones 20261003190000 y 190200)
--
--   · al postear, una línea con más de dos decimales es LAD71, con el mensaje de persona; y sin la
--     regla (variante rota) la fracción entra. La excepción es un MECANISMO: la API, escribiendo
--     la etiqueta de la regularización, NO postea fracciones, y no puede escribir en el registro;
--   · las CUATRO ramas de cent_gaps, cada una con su variante rota, y el corte con acta: lo
--     anterior al acta no cuenta, lo posterior sí — también la «reversa exacta» que antes se
--     perdonaba;
--   · la regularización del KARDEX: cantidad > 0 (los dos signos del ajuste), cantidad 0 con polvo
--     (entero a redondeo), el BORDE del polvo (0,011 con 2 movimientos: ya no es polvo) y
--     cantidad 0 con valor real (solo la fracción; el resto queda visible y se lista); las
--     fracciones que netean a cero; `finish` exige el asiento posteado, deja el acta y no mueve
--     kardex = mayor;
--   · un período CERRADO: la regularización falla diciéndolo (LAD61) y no deja nada a medias;
--   · la empresa SIN contabilidad: kardex regularizado + fila de cola DESCARTADA con acta (nunca
--     pendiente: bloquearía el cierre); cent_gaps = 0; y una descartada SIN acta no cubre nada;
--   · aislamiento: el actor de un tenant no ve las fracciones de otro; el de los dos, sí; y las
--     funciones de la regularización no las ejecuta la API.
-- Fechas: todo corre en UNA transacción (now() constante). «Posterior al corte» se fabrica con
-- created_at = now() + 1 minuto, con el trigger de procedencia apagado dentro del test.
-- =============================================================================
begin;
select plan(55);

insert into auth.users (id) values
  ('aaaa0106-0000-4000-8000-0000000000e1'), ('aaaa0106-0000-4000-8000-0000000000e2');
select set_config('ladino.actor_id', 'aaaa0106-0000-4000-8000-0000000000e1', true);
select set_config('ladino.rules_version', 'pgtap-106', true);

insert into public.tenants (id, name) values
  ('aaaa0106-0000-4000-8000-00000000000a', 'Tenant 106'),
  ('aaaa0106-0000-4000-8000-00000000000b', 'Tenant 106 ajeno');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code) values
  ('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-00000000000a', 'J-106-A',
   'Bodega 106 con contabilidad', 'VES', 'ordinario'),
  ('aaaa0106-0000-4000-8000-0000000000a2', 'aaaa0106-0000-4000-8000-00000000000a', 'J-106-B',
   'Bodega 106 sin contabilidad', 'VES', 'ordinario'),
  ('aaaa0106-0000-4000-8000-0000000000a3', 'aaaa0106-0000-4000-8000-00000000000a', 'J-106-C',
   'Servicios 106 con el período cerrado', 'VES', 'ordinario'),
  ('aaaa0106-0000-4000-8000-0000000000a4', 'aaaa0106-0000-4000-8000-00000000000b', 'J-106-D',
   'Bodega del otro tenant', 'VES', 'ordinario');
-- e1 es de los DOS tenants (la firma contable); e2 solo del primero.
insert into public.memberships (tenant_id, user_id) values
  ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000e1'),
  ('aaaa0106-0000-4000-8000-00000000000b', 'aaaa0106-0000-4000-8000-0000000000e1'),
  ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000e2');

insert into public.warehouses (id, tenant_id, company_id, code, name)
select ('aaaa0106-0000-4000-8000-0000000000b' || n)::uuid, c.tenant_id, c.id, 'W106-' || n, 'Local'
  from (values (1, 'aaaa0106-0000-4000-8000-0000000000a1'::uuid),
               (2, 'aaaa0106-0000-4000-8000-0000000000a2'::uuid),
               (4, 'aaaa0106-0000-4000-8000-0000000000a4'::uuid)) v(n, cid)
  join public.companies c on c.id = v.cid;
-- Productos: A tiene cuatro (d1..d4), B uno (d5), D uno (d6).
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code)
select ('aaaa0106-0000-4000-8000-00000000d00' || n)::uuid, c.tenant_id, c.id, 'SKU-106-' || n,
       'Producto 106-' || n, 'good', 'active', 'unidad', 'gravado_general'
  from (values (1, 'aaaa0106-0000-4000-8000-0000000000a1'::uuid),
               (2, 'aaaa0106-0000-4000-8000-0000000000a1'::uuid),
               (3, 'aaaa0106-0000-4000-8000-0000000000a1'::uuid),
               (4, 'aaaa0106-0000-4000-8000-0000000000a1'::uuid),
               (7, 'aaaa0106-0000-4000-8000-0000000000a1'::uuid),
               (8, 'aaaa0106-0000-4000-8000-0000000000a1'::uuid),
               (9, 'aaaa0106-0000-4000-8000-0000000000a1'::uuid),
               (5, 'aaaa0106-0000-4000-8000-0000000000a2'::uuid),
               (6, 'aaaa0106-0000-4000-8000-0000000000a4'::uuid)) v(n, cid)
  join public.companies c on c.id = v.cid;

-- Planes: A (inventario, aportes, caja, ventas, otros, redondeo) y C (caja, ventas, redondeo).
insert into public.accounts (id, tenant_id, company_id, code, name, kind, nature, rules_version)
select ('aaaa0106-0000-4000-8000-0000000' || v.suf)::uuid, 'aaaa0106-0000-4000-8000-00000000000a',
       v.cid, v.code, v.name, v.kind, v.nature, 'test'
  from (values
    ('00ac1', 'aaaa0106-0000-4000-8000-0000000000a1'::uuid, '1', 'Inventario', 'activo', 'deudora'),
    ('00ac2', 'aaaa0106-0000-4000-8000-0000000000a1'::uuid, '3', 'Aportes', 'patrimonio', 'acreedora'),
    ('00ac3', 'aaaa0106-0000-4000-8000-0000000000a1'::uuid, '2', 'Caja', 'activo', 'deudora'),
    ('00ac4', 'aaaa0106-0000-4000-8000-0000000000a1'::uuid, '4', 'Ventas', 'ingreso', 'acreedora'),
    ('00ac5', 'aaaa0106-0000-4000-8000-0000000000a1'::uuid, '5', 'Otros ingresos', 'ingreso', 'acreedora'),
    ('00ac6', 'aaaa0106-0000-4000-8000-0000000000a1'::uuid, '6', 'Diferencias por redondeo', 'gasto', 'deudora'),
    ('00cc3', 'aaaa0106-0000-4000-8000-0000000000a3'::uuid, '2', 'Caja', 'activo', 'deudora'),
    ('00cc4', 'aaaa0106-0000-4000-8000-0000000000a3'::uuid, '4', 'Ventas', 'ingreso', 'acreedora'),
    ('00cc6', 'aaaa0106-0000-4000-8000-0000000000a3'::uuid, '6', 'Diferencias por redondeo', 'gasto', 'deudora')
  ) v(suf, cid, code, name, kind, nature);
insert into public.company_account_settings (tenant_id, company_id, purpose, account_id) values
  ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a1',
   'inventory_general', 'aaaa0106-0000-4000-8000-000000000ac1'),
  ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a1',
   'rounding_difference', 'aaaa0106-0000-4000-8000-000000000ac6'),
  ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a3',
   'rounding_difference', 'aaaa0106-0000-4000-8000-000000000cc6');
insert into public.fiscal_periods (tenant_id, company_id, year, month)
select c.tenant_id, c.id, extract(year from current_date)::int, extract(month from current_date)::int
  from public.companies c
 where c.id in ('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000a3')
   and not exists (select 1 from public.fiscal_periods p where p.company_id = c.id);

-- ── Ayudas ──────────────────────────────────────────────────────────────────
-- Un asiento de dos o tres líneas, en borrador. `p_lineas`: {cuenta, debe, haber}.
create function pg_temp.borrador(p_id uuid, p_company uuid, p_kind text, p_source uuid,
                                 p_lineas jsonb, p_reversa_de uuid default null)
returns void language plpgsql as $$
declare v_t uuid; l jsonb; n int := 0;
begin
  select tenant_id into v_t from public.companies where id = p_company;
  insert into public.journal_entries
    (id, tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
     description, rules_version, is_reversal_of)
  select p_id, v_t, p_company, p.id, current_date, p_kind, p_source,
         case when p_kind = 'manual' then null else 'stock.received' end, 'Asiento 106', 'test',
         p_reversa_de
    from public.fiscal_periods p where p.company_id = p_company limit 1;
  for l in select * from jsonb_array_elements(p_lineas) loop
    n := n + 1;
    insert into public.journal_lines
      (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit)
    values (v_t, p_company, p_id, n, (l ->> 0)::uuid, (l ->> 1)::numeric, (l ->> 2)::numeric,
            greatest((l ->> 1)::numeric, (l ->> 2)::numeric), 'VES', 1,
            greatest((l ->> 1)::numeric, (l ->> 2)::numeric), 'VES', 'identidad', now(),
            (l ->> 1)::numeric, (l ->> 2)::numeric);
  end loop;
end $$;
create sequence pg_temp.numero_106 start 9000;
create function pg_temp.postear(p_id uuid) returns void language sql as $$
  update public.journal_entries
     set status = 'posted', posted_at = now(), posted_by = 'aaaa0106-0000-4000-8000-0000000000e1',
         entry_number = nextval('pg_temp.numero_106')
   where id = p_id;
$$;
-- Un movimiento HEREDADO: se escribe con el oráculo apagado y sus «después» a mano.
create function pg_temp.heredado(p_company uuid, p_wh uuid, p_prod uuid, p_kind text, p_q numeric,
                                 p_val numeric, p_q_after numeric, p_v_after numeric, p_doc uuid)
returns void language sql as $$
  insert into public.inventory_moves
    (tenant_id, company_id, warehouse_id, product_id, kind, quantity, amount_transaction_currency,
     transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
     rate_timestamp, rounding_policy_id, unit_cost, quantity_after, value_after, occurred_at,
     source_document_id, exit_reason, exit_evidence)
  select c.tenant_id, p_company, p_wh, p_prod, p_kind, p_q, p_val, 'VES', 1, p_val, 'VES',
         'identidad', now(), 'inventory:cost:8:HALF_UP', 1, p_q_after, p_v_after, now(), p_doc,
         case when p_kind = 'salida' then 'merma' end,
         case when p_kind = 'salida' then 'acta pgTAP 106' end
    from public.companies c where c.id = p_company;
$$;
create function pg_temp.posicion(p_company uuid, p_wh uuid, p_prod uuid, p_q numeric, p_v numeric,
                                 p_n bigint)
returns void language sql as $$
  insert into public.stock_balances
    (tenant_id, company_id, warehouse_id, product_id, quantity, value, currency_code,
     last_unit_cost, moves_count)
  select c.tenant_id, p_company, p_wh, p_prod, p_q, p_v, 'VES', 1, p_n
    from public.companies c where c.id = p_company;
$$;
create function pg_temp.valor(p_prod uuid) returns numeric language sql as $$
  select value from public.stock_balances where product_id = p_prod;
$$;

-- ── 1. LAD71: al postear, ninguna línea con más de dos decimales ────────────
select pg_temp.borrador('aaaa0106-0000-4000-8000-0000000e0001', 'aaaa0106-0000-4000-8000-0000000000a1',
  'manual', null,
  '[["aaaa0106-0000-4000-8000-000000000ac3", 10.123, 0], ["aaaa0106-0000-4000-8000-000000000ac4", 0, 10.123]]');
select throws_ok(
  $$ select pg_temp.postear('aaaa0106-0000-4000-8000-0000000e0001') $$,
  'LAD71', 'Los importes del asiento llevan como máximo dos decimales',
  'postear un asiento con una línea de tres decimales es LAD71, con el mensaje de persona');
select is((select status from public.journal_entries where id = 'aaaa0106-0000-4000-8000-0000000e0001'),
  'draft', 'y el asiento sigue en borrador: no entró al mayor');
select pg_temp.borrador('aaaa0106-0000-4000-8000-0000000e0002', 'aaaa0106-0000-4000-8000-0000000000a1',
  'manual', null,
  '[["aaaa0106-0000-4000-8000-000000000ac3", 10.12, 0], ["aaaa0106-0000-4000-8000-000000000ac4", 0, 10.12]]');
select lives_ok($$ select pg_temp.postear('aaaa0106-0000-4000-8000-0000000e0002') $$,
  'el mismo asiento al céntimo se postea');
-- C1 · LA EXCEPCIÓN NO ES UNA ETIQUETA. La API puede escribir source_kind / source_event (tiene
-- INSERT y UPDATE sobre journal_entries); con la etiqueta de la regularización NO postea
-- fracciones: lo que exime es estar en platform.cent_regularization_entries, y ahí no escribe.
select pg_temp.borrador('aaaa0106-0000-4000-8000-0000000e0008', 'aaaa0106-0000-4000-8000-0000000000a1',
  'inventory_move', 'aaaa0106-0000-4000-8000-0000000000f7',
  '[["aaaa0106-0000-4000-8000-000000000ac3", 0.004, 0], ["aaaa0106-0000-4000-8000-000000000ac4", 0, 0.004]]');
set local role ladino_api;
select lives_ok(
  $$ update public.journal_entries set source_event = 'stock.cent_regularized'
      where id = 'aaaa0106-0000-4000-8000-0000000e0008' $$,
  'la API SÍ puede escribir la etiqueta de la regularización en un borrador suyo…');
select throws_ok(
  $$ update public.journal_entries
        set status = 'posted', posted_at = now(),
            posted_by = 'aaaa0106-0000-4000-8000-0000000000e1', entry_number = 9500
      where id = 'aaaa0106-0000-4000-8000-0000000e0008' $$,
  'LAD71', null,
  '…y con la etiqueta NO postea fracciones: LAD71 — la excepción es el registro, no la etiqueta');
select throws_ok(
  $$ insert into platform.cent_regularization_entries (entry_id, company_id)
     values ('aaaa0106-0000-4000-8000-0000000e0008', 'aaaa0106-0000-4000-8000-0000000000a1') $$,
  '42501', null, 'ni puede fabricarse la excepción: no escribe en el registro privado');
reset role;
select is(
  (select source_event || '/' || status from public.journal_entries
    where id = 'aaaa0106-0000-4000-8000-0000000e0008'),
  'stock.cent_regularized/draft', 'el asiento etiquetado sigue en borrador: no entró al mayor');

-- Para que el resto del fixture parta de saldos conocidos, este asiento al céntimo se compensa.
select pg_temp.borrador('aaaa0106-0000-4000-8000-0000000e0003', 'aaaa0106-0000-4000-8000-0000000000a1',
  'manual', null,
  '[["aaaa0106-0000-4000-8000-000000000ac4", 10.12, 0], ["aaaa0106-0000-4000-8000-000000000ac3", 0, 10.12]]');
select pg_temp.postear('aaaa0106-0000-4000-8000-0000000e0003');

-- ── 2. LA HISTORIA HEREDADA (lo anterior a la migración), con los guardas apagados ──
set constraints all immediate;
alter table public.journal_entries disable trigger journal_entries_02_balanced;
alter table public.inventory_moves disable trigger inventory_moves_10_apply;

-- VARIANTE ROTA de LAD71: sin la regla, la misma fracción entra al mayor.
select lives_ok($$ select pg_temp.postear('aaaa0106-0000-4000-8000-0000000e0001') $$,
  'variante rota: sin el trigger, el asiento de tres decimales se postea — lo paraba la regla');
-- (queda como historia: caja 10,123 / ventas 10,123, dos saldos con fracción)

-- A · kardex: d1 y d2 con existencia; d3 vacía con polvo; d4 vacía con valor REAL.
select pg_temp.heredado('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1',
  'aaaa0106-0000-4000-8000-00000000d001', 'entrada', 3, 10.00345678, 3, 10.00345678,
  'aaaa0106-0000-4000-8000-0000000000f1');
select pg_temp.posicion('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1',
  'aaaa0106-0000-4000-8000-00000000d001', 3, 10.00345678, 1);
select pg_temp.heredado('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1',
  'aaaa0106-0000-4000-8000-00000000d002', 'entrada', 2, 20.006, 2, 20.006,
  'aaaa0106-0000-4000-8000-0000000000f1');
select pg_temp.posicion('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1',
  'aaaa0106-0000-4000-8000-00000000d002', 2, 20.006, 1);
select pg_temp.heredado('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1',
  'aaaa0106-0000-4000-8000-00000000d003', 'entrada', 1, 5.007, 1, 5.007,
  'aaaa0106-0000-4000-8000-0000000000f1');
select pg_temp.heredado('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1',
  'aaaa0106-0000-4000-8000-00000000d003', 'salida', -1, -5.00, 0, 0.007,
  'aaaa0106-0000-4000-8000-0000000000f1');
select pg_temp.posicion('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1',
  'aaaa0106-0000-4000-8000-00000000d003', 0, 0.007, 2);
select pg_temp.heredado('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1',
  'aaaa0106-0000-4000-8000-00000000d004', 'entrada', 1, 20.00, 1, 20.00,
  'aaaa0106-0000-4000-8000-0000000000f1');
select pg_temp.heredado('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1',
  'aaaa0106-0000-4000-8000-00000000d004', 'salida', -1, -7.65433, 0, 12.34567,
  'aaaa0106-0000-4000-8000-0000000000f1');
select pg_temp.posicion('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1',
  'aaaa0106-0000-4000-8000-00000000d004', 0, 12.34567, 2);
-- d7 · EL BORDE: vacía con 0,011 y 2 movimientos. El tope es 0,005 × 2 = 0,010: 0,011 ya NO es
-- polvo. (Si el tope fuera 0,05 en vez de 0,005, esto se iría entero a redondeo.)
select pg_temp.heredado('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1',
  'aaaa0106-0000-4000-8000-00000000d007', 'entrada', 1, 5.011, 1, 5.011,
  'aaaa0106-0000-4000-8000-0000000000f1');
select pg_temp.heredado('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1',
  'aaaa0106-0000-4000-8000-00000000d007', 'salida', -1, -5.00, 0, 0.011,
  'aaaa0106-0000-4000-8000-0000000000f1');
select pg_temp.posicion('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1',
  'aaaa0106-0000-4000-8000-00000000d007', 0, 0.011, 2);
-- El asiento de ese kardex: 10,00345678 + 20,006 + 0,007 + 12,34567 + 0,011 = 42,37312678.
select pg_temp.borrador('aaaa0106-0000-4000-8000-0000000e0004', 'aaaa0106-0000-4000-8000-0000000000a1',
  'stock_opening', 'aaaa0106-0000-4000-8000-0000000000f1',
  '[["aaaa0106-0000-4000-8000-000000000ac1", 42.37312678, 0], ["aaaa0106-0000-4000-8000-000000000ac2", 0, 42.37312678]]');
select pg_temp.postear('aaaa0106-0000-4000-8000-0000000e0004');
-- Y un asiento cuyas fracciones NO se compensan al redondear cada saldo: caja 0,003 / ventas
-- 0,0015 / otros 0,0015. Con el de arriba (caja 10,123 / ventas 10,123): caja 10,126,
-- ventas 10,1245, otros 0,0015.
select pg_temp.borrador('aaaa0106-0000-4000-8000-0000000e0005', 'aaaa0106-0000-4000-8000-0000000000a1',
  'manual', null,
  '[["aaaa0106-0000-4000-8000-000000000ac3", 0.003, 0], ["aaaa0106-0000-4000-8000-000000000ac4", 0, 0.0015], ["aaaa0106-0000-4000-8000-000000000ac5", 0, 0.0015]]');
select pg_temp.postear('aaaa0106-0000-4000-8000-0000000e0005');

-- B (sin contabilidad): una posición con fracción; su movimiento, en la cola como todos.
select pg_temp.heredado('aaaa0106-0000-4000-8000-0000000000a2', 'aaaa0106-0000-4000-8000-0000000000b2',
  'aaaa0106-0000-4000-8000-00000000d005', 'entrada', 4, 7.77123, 4, 7.77123,
  'aaaa0106-0000-4000-8000-0000000000f2');
select pg_temp.posicion('aaaa0106-0000-4000-8000-0000000000a2', 'aaaa0106-0000-4000-8000-0000000000b2',
  'aaaa0106-0000-4000-8000-00000000d005', 4, 7.77123, 1);
insert into public.journal_generation_queue
  (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
values ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a2',
        'inventory_move', 'aaaa0106-0000-4000-8000-0000000000f2', 'stock.received', '{}'::jsonb,
        'La empresa no lleva contabilidad');
-- C (servicios, sin kardex): un asiento heredado con fracción.
select pg_temp.borrador('aaaa0106-0000-4000-8000-0000000e0006', 'aaaa0106-0000-4000-8000-0000000000a3',
  'manual', null,
  '[["aaaa0106-0000-4000-8000-000000000cc3", 1.005, 0], ["aaaa0106-0000-4000-8000-000000000cc4", 0, 1.005]]');
select pg_temp.postear('aaaa0106-0000-4000-8000-0000000e0006');
-- D (otro tenant): una posición con fracción.
select pg_temp.heredado('aaaa0106-0000-4000-8000-0000000000a4', 'aaaa0106-0000-4000-8000-0000000000b4',
  'aaaa0106-0000-4000-8000-00000000d006', 'entrada', 1, 3.33333, 1, 3.33333,
  'aaaa0106-0000-4000-8000-0000000000f4');
select pg_temp.posicion('aaaa0106-0000-4000-8000-0000000000a4', 'aaaa0106-0000-4000-8000-0000000000b4',
  'aaaa0106-0000-4000-8000-00000000d006', 1, 3.33333, 1);

alter table public.journal_entries enable trigger journal_entries_02_balanced;
alter table public.inventory_moves enable trigger inventory_moves_10_apply;

-- ── 3. cent_gaps ve las cuatro cosas (sin acta, cuenta TODO) ────────────────
select is(
  (select array_agg(distinct kind order by kind)
     from platform.cent_gaps('aaaa0106-0000-4000-8000-0000000000a1')),
  array['account_balance', 'inventory_move', 'journal_line', 'stock_balance'],
  'antes de regularizar, las CUATRO ramas de cent_gaps señalan la historia con fracción');
select is((select diferencia from platform.inventory_ledger_gap('aaaa0106-0000-4000-8000-0000000000a1')),
  0::numeric, 'el fixture parte de kardex = mayor');

-- ── 4. La regularización del kardex y del mayor (empresa A) ─────────────────
select is(
  (platform.cent_regularization_prepare('aaaa0106-0000-4000-8000-0000000000a1', true) ->> 'dry_run'),
  'true', 'el ensayo dice qué haría');
select is((select count(*)::int from public.inventory_moves
            where company_id = 'aaaa0106-0000-4000-8000-0000000000a1' and kind = 'revaluacion'),
  0, 'y el ensayo no escribe nada');

create temp table _prep_a as
  select platform.cent_regularization_prepare('aaaa0106-0000-4000-8000-0000000000a1') as r;
select is(pg_temp.valor('aaaa0106-0000-4000-8000-00000000d001'), 10.00::numeric,
  'cantidad > 0, fracción por debajo del medio céntimo: el ajuste es NEGATIVO y deja 10,00');
select is(pg_temp.valor('aaaa0106-0000-4000-8000-00000000d002'), 20.01::numeric,
  'cantidad > 0, fracción por encima: el ajuste es POSITIVO y deja 20,01');
select is(pg_temp.valor('aaaa0106-0000-4000-8000-00000000d003'), 0::numeric,
  'cantidad 0 con polvo (0,007 ≤ 0,005 × 2 movimientos): va ENTERO a redondeo, queda 0');
select is(pg_temp.valor('aaaa0106-0000-4000-8000-00000000d004'), 12.35::numeric,
  'cantidad 0 con valor real (12,34567): solo la fracción va a redondeo; 12,35 queda visible');
select is(pg_temp.valor('aaaa0106-0000-4000-8000-00000000d007'), 0.01::numeric,
  'EL BORDE: cantidad 0 con 0,011 y 2 movimientos (tope 0,010) NO es polvo: solo la fracción va a redondeo y queda 0,01');
select is(
  (select jsonb_agg(jsonb_build_object('p', v ->> 'product', 'd', v ->> 'warehouse', 'v', v ->> 'value')
                    order by v ->> 'product')
     from _prep_a, jsonb_array_elements(r -> 'visible_empty_positions') v),
  '[{"p": "SKU-106-4", "d": "W106-1", "v": "12.35000000"}, {"p": "SKU-106-7", "d": "W106-1", "v": "0.01000000"}]'::jsonb,
  'y la función la LISTA con producto, depósito e importe (nada se esconde en 5.1.10)');
select is(
  (select array_agg(m.functional_amount order by m.functional_amount)
     from public.inventory_moves m, _prep_a
    where m.kind = 'revaluacion' and m.quantity = 0
      and m.source_document_id = (r ->> 'regularization_id')::uuid),
  array[-0.007, -0.00345678, -0.001, 0.004, 0.00433]::numeric[],
  'cinco revalorizaciones de cantidad 0, una por posición, con el signo de cada ajuste');

select throws_ok($$ select platform.cent_regularization_finish((select r from _prep_a)) $$,
  'LAD41', null, 'finish exige el asiento POSTEADO: en borrador no cierra');
select lives_ok($$ select pg_temp.postear(((select r from _prep_a) ->> 'entry_id')::uuid) $$,
  'el asiento de la regularización (con fracciones: es su oficio) se postea — la excepción escrita en el enunciado de LAD71');
select lives_ok($$ select platform.cent_regularization_finish((select r from _prep_a)) $$,
  'finish cierra con el asiento posteado');
select is((select count(*)::int from public.audit_events
            where company_id = 'aaaa0106-0000-4000-8000-0000000000a1'
              and event_type = 'accounting.cent_regularized'), 1, 'deja UN acta: el corte');
select is((select count(*)::int from platform.cent_gaps('aaaa0106-0000-4000-8000-0000000000a1')), 0,
  'cent_gaps = 0: la historia anterior al acta ya no cuenta y los saldos están al céntimo');
select is((select diferencia from platform.inventory_ledger_gap('aaaa0106-0000-4000-8000-0000000000a1')),
  0::numeric, 'kardex = mayor sigue en cero');
select is((select count(*)::int from platform.inventory_coverage_gaps('aaaa0106-0000-4000-8000-0000000000a1')),
  0, 'y cada revalorización tiene su asiento');
select is(
  (select sum(jl.functional_debit - jl.functional_credit) from public.journal_lines jl
     join public.journal_entries e on e.id = jl.entry_id and e.status = 'posted'
    where jl.account_id = 'aaaa0106-0000-4000-8000-000000000ac6'),
  -0.01::numeric,
  '«Diferencias por redondeo» recibe el residuo: un céntimo al haber, y su saldo queda al céntimo');
select is(
  (platform.cent_regularization_prepare('aaaa0106-0000-4000-8000-0000000000a1') ->> 'regularized'),
  'false', 'la segunda vez no encuentra nada (idempotente)');

-- ── 4b. Las fracciones del kardex NETEAN A CERO y el mayor no trae ninguna ──
-- No hay asiento posible (importe cero, LAD59). Antes fallaba con «revísala a mano»; ahora el
-- kardex se regulariza y la fila de cola nace descartada con su acta.
alter table public.inventory_moves disable trigger inventory_moves_10_apply;
select pg_temp.heredado('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1',
  'aaaa0106-0000-4000-8000-00000000d008', 'entrada', 1, 5.004, 1, 5.004, 'aaaa0106-0000-4000-8000-0000000000f8');
select pg_temp.posicion('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1', 'aaaa0106-0000-4000-8000-00000000d008', 1, 5.004, 1);
select pg_temp.heredado('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1',
  'aaaa0106-0000-4000-8000-00000000d009', 'entrada', 1, 5.006, 1, 5.006, 'aaaa0106-0000-4000-8000-0000000000f8');
select pg_temp.posicion('aaaa0106-0000-4000-8000-0000000000a1', 'aaaa0106-0000-4000-8000-0000000000b1', 'aaaa0106-0000-4000-8000-00000000d009', 1, 5.006, 1);
alter table public.inventory_moves enable trigger inventory_moves_10_apply;
select pg_temp.borrador('aaaa0106-0000-4000-8000-0000000e0009', 'aaaa0106-0000-4000-8000-0000000000a1',
  'stock_opening', 'aaaa0106-0000-4000-8000-0000000000f8',
  '[["aaaa0106-0000-4000-8000-000000000ac1", 10.01, 0], ["aaaa0106-0000-4000-8000-000000000ac2", 0, 10.01]]');
select pg_temp.postear('aaaa0106-0000-4000-8000-0000000e0009');
create temp table _prep_n as
  select platform.cent_regularization_prepare('aaaa0106-0000-4000-8000-0000000000a1') as r;
select ok((select (r ->> 'regularized')::boolean and r ->> 'entry_id' is null
                  and r ->> 'queue_id' is not null from _prep_n),
  'neteo a cero: se regulariza SIN asiento (no lo hay de importe cero) y con fila de cola');
select lives_ok($$ select platform.cent_regularization_finish((select r from _prep_n)) $$,
  'y finish cierra: kardex = mayor no se movió');
select is((select count(*)::int from platform.cent_gaps('aaaa0106-0000-4000-8000-0000000000a1')), 0,
  'cent_gaps = 0 tras el neteo a cero');
select is((select count(*)::int from platform.inventory_coverage_gaps('aaaa0106-0000-4000-8000-0000000000a1')), 0,
  'y las dos revalorizaciones quedan cubiertas por la fila descartada con acta');
select is((select diferencia from platform.inventory_ledger_gap('aaaa0106-0000-4000-8000-0000000000a1')), 0::numeric,
  'kardex = mayor sigue en cero');

-- ── 5. El corte: lo posterior al acta SÍ cuenta. Las cuatro ramas, rotas una a una ──
alter table public.inventory_moves disable trigger inventory_moves_10_apply;
alter table public.inventory_moves disable trigger inventory_moves_00_provenance;
insert into public.inventory_moves
  (tenant_id, company_id, warehouse_id, product_id, kind, quantity, amount_transaction_currency,
   transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
   rate_timestamp, rounding_policy_id, unit_cost, quantity_after, value_after, occurred_at,
   created_at, version, reason, source_document_id)
values ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a1',
        'aaaa0106-0000-4000-8000-0000000000b1', 'aaaa0106-0000-4000-8000-00000000d001',
        'revaluacion', 0, 0.001, 'VES', 1, 0.001, 'VES', 'identidad', now(), 'pgtap-roto', 1, 3,
        10.001, now(), now() + interval '1 minute', 1, 'variante rota 106',
        'aaaa0106-0000-4000-8000-0000000000f9');
alter table public.inventory_moves enable trigger inventory_moves_00_provenance;
alter table public.inventory_moves enable trigger inventory_moves_10_apply;
select is((select array_agg(kind) from platform.cent_gaps('aaaa0106-0000-4000-8000-0000000000a1')),
  array['inventory_move'],
  'rama inventory_move, rota: un movimiento con fracción POSTERIOR al acta se ve (y solo esa rama)');

update public.stock_balances set value = 10.001
 where product_id = 'aaaa0106-0000-4000-8000-00000000d001';
select is((select array_agg(kind order by kind) from platform.cent_gaps('aaaa0106-0000-4000-8000-0000000000a1')),
  array['inventory_move', 'stock_balance'],
  'rama stock_balance, rota: una posición con fracción se ve, con o sin acta');

-- La «reversa exacta» de un asiento anterior al corte, que el enunciado viejo perdonaba.
select pg_temp.borrador('aaaa0106-0000-4000-8000-0000000e0007', 'aaaa0106-0000-4000-8000-0000000000a1',
  'manual', null,
  '[["aaaa0106-0000-4000-8000-000000000ac4", 10.123, 0], ["aaaa0106-0000-4000-8000-000000000ac3", 0, 10.123]]',
  'aaaa0106-0000-4000-8000-0000000e0001');
alter table public.journal_entries disable trigger journal_entries_02_balanced;
alter table public.journal_entries disable trigger journal_entries_00_provenance;
update public.journal_entries
   set created_at = now() + interval '1 minute', version = 1,
       status = 'posted', posted_at = now(), posted_by = 'aaaa0106-0000-4000-8000-0000000000e1',
       entry_number = nextval('pg_temp.numero_106')
 where id = 'aaaa0106-0000-4000-8000-0000000e0007';
alter table public.journal_entries enable trigger journal_entries_00_provenance;
alter table public.journal_entries enable trigger journal_entries_02_balanced;
select is(
  (select count(*)::int from platform.cent_gaps('aaaa0106-0000-4000-8000-0000000000a1')
    where kind = 'journal_line'), 2,
  'rama journal_line, rota: las dos líneas de una reversa EXACTA posterior al corte se ven — ya no hay salvedad');
select is(
  (select count(*)::int from platform.cent_gaps('aaaa0106-0000-4000-8000-0000000000a1')
    where kind = 'account_balance'), 2,
  'rama account_balance, rota: y deja dos saldos en −fracción, que es por lo que la reversa va al céntimo');

-- ── 6. Período CERRADO: falla diciéndolo y no deja nada a medias (empresa C) ──
update public.fiscal_periods
   set status = 'closed', closed_at = now(), closed_by = 'aaaa0106-0000-4000-8000-0000000000e1'
 where company_id = 'aaaa0106-0000-4000-8000-0000000000a3';
select throws_ok($$
  do $do$
  declare r jsonb;
  begin
    r := platform.cent_regularization_prepare('aaaa0106-0000-4000-8000-0000000000a3');
    perform pg_temp.postear((r ->> 'entry_id')::uuid);
    perform platform.cent_regularization_finish(r);
  end $do$ $$,
  'LAD61', null,
  'con el período de hoy CERRADO la regularización falla diciéndolo (LAD61): no asienta en un período cerrado');
select is(
  (select count(*)::int from public.journal_entries
    where company_id = 'aaaa0106-0000-4000-8000-0000000000a3' and source_event = 'stock.cent_regularized')
  + (select count(*)::int from public.audit_events
      where company_id = 'aaaa0106-0000-4000-8000-0000000000a3'
        and event_type = 'accounting.cent_regularized'),
  0, 'y no deja ni borrador ni acta: la transacción entera se deshace');
-- Reabierto, la empresa de SERVICIOS (mayor sin papel de inventario) regulariza su mayor (C1).
update public.fiscal_periods
   set status = 'open', reopened_at = now(), reopened_by = 'aaaa0106-0000-4000-8000-0000000000e1',
       reopened_reason = 'pgTAP 106: reabrir para regularizar'
 where company_id = 'aaaa0106-0000-4000-8000-0000000000a3';
create temp table _prep_c as
  select platform.cent_regularization_prepare('aaaa0106-0000-4000-8000-0000000000a3') as r;
select pg_temp.postear(((select r from _prep_c) ->> 'entry_id')::uuid);
select platform.cent_regularization_finish((select r from _prep_c));
select is((select count(*)::int from platform.cent_gaps('aaaa0106-0000-4000-8000-0000000000a3')), 0,
  'C1: una empresa con mayor y SIN papel de inventario regulariza su mayor; cent_gaps = 0');

-- ── 7. La empresa SIN contabilidad: kardex regularizado, asiento en la cola (empresa B) ──
select ok((select count(*) from platform.cent_gaps('aaaa0106-0000-4000-8000-0000000000a2')) > 0,
  'B, antes: cent_gaps la señala (no es «el conocido»: tiene que poder llegar a cero)');
create temp table _prep_b as
  select platform.cent_regularization_prepare('aaaa0106-0000-4000-8000-0000000000a2') as r;
select ok((select (r ->> 'regularized')::boolean and r ->> 'entry_id' is null
                  and r ->> 'queue_id' is not null from _prep_b),
  'B: se regulariza SIN asiento y CON fila de cola');
select lives_ok($$ select platform.cent_regularization_finish((select r from _prep_b)) $$,
  'finish cierra con la fila descartada en vez del asiento');
select is(pg_temp.valor('aaaa0106-0000-4000-8000-00000000d005'), 7.77::numeric,
  'su kardex queda al céntimo (7,77123 → 7,77)');
select is((select count(*)::int from platform.cent_gaps('aaaa0106-0000-4000-8000-0000000000a2')), 0,
  'cent_gaps = 0 también en la empresa sin contabilidad: cero, sin perdones');
select is((select count(*)::int from platform.inventory_coverage_gaps('aaaa0106-0000-4000-8000-0000000000a2')),
  0, 'inventory_coverage_gaps acepta la revalorización: su fila está descartada CON ACTA');
select is(
  (select q.source_event || '/' || q.status from public.journal_generation_queue q, _prep_b
    where q.id = (r ->> 'queue_id')::uuid),
  'stock.cent_regularized/discarded',
  'la fila de la regularización nace DESCARTADA: una pendiente bloquearía el cierre para siempre');
select is(
  (select count(*)::int from public.audit_events a, _prep_b
    where a.company_id = 'aaaa0106-0000-4000-8000-0000000000a2'
      and a.event_type = 'accounting.pending_discarded'
      and a.payload ->> 'queue_id' = r ->> 'queue_id'
      and a.payload ->> 'reason' like 'Regularización del céntimo sin contabilidad%'),
  1, 'con su acta y su motivo, en la misma transacción');
select is(
  (select count(*)::int from public.journal_generation_queue q
    where q.company_id = 'aaaa0106-0000-4000-8000-0000000000a2' and q.status = 'pending'
      and q.source_event = 'stock.cent_regularized'),
  0, 'la regularización no deja NADA pendiente en la cola');
-- VARIANTE ROTA: una fila descartada SIN acta no cubre nada. (La del movimiento heredado de B,
-- que estaba pendiente, se descarta a mano sin dejar acta.)
update public.journal_generation_queue
   set status = 'discarded', processed_at = now()
 where company_id = 'aaaa0106-0000-4000-8000-0000000000a2' and source_event = 'stock.received';
select is(
  (select array_agg(problem) from platform.inventory_coverage_gaps('aaaa0106-0000-4000-8000-0000000000a2')),
  array['missing'],
  'variante rota: descartar SIN acta deja el movimiento como missing — lo que cubre es el acta');

-- ── 8. Aislamiento y privilegios ────────────────────────────────────────────
select ok((select count(*) from platform.cent_gaps('aaaa0106-0000-4000-8000-0000000000a4')) > 0,
  'D (otro tenant) tiene una posición con fracción');
set local role ladino_api;
select set_config('ladino.actor_id', 'aaaa0106-0000-4000-8000-0000000000e2', true);
select is((select count(*)::int from platform.cent_gaps('aaaa0106-0000-4000-8000-0000000000a4')), 0,
  'el actor de UN solo tenant no ve las fracciones de la empresa del otro');
select set_config('ladino.actor_id', 'aaaa0106-0000-4000-8000-0000000000e1', true);
select ok((select count(*) from platform.cent_gaps('aaaa0106-0000-4000-8000-0000000000a4')) > 0,
  'el actor de los DOS tenants sí las ve: el filtro es la pertenencia, no la empresa pedida');
select throws_ok(
  $$ select platform.cent_regularization_prepare('aaaa0106-0000-4000-8000-0000000000a4') $$,
  '42501', null, 'y la API no ejecuta la regularización: la corre el dueño de la base');
reset role;
select is(pg_temp.valor('aaaa0106-0000-4000-8000-00000000d006'), 3.33333::numeric,
  'la posición de D sigue intacta');

select * from finish();
rollback;

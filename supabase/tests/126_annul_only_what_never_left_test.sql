-- =============================================================================
-- Ladino — pgTAP 126 · ANULAR SOLO LO QUE NO SALIÓ, Y EL CAJERO INICIA LA DEVOLUCIÓN
-- Migraciones 20261004160000, 20261004160100 y 20261004160300 (recorrido G-10 y G-07; PA 00071
-- arts. 22 y 36).
--
--   G-10. `platform.invoice_annulment_blockers(empresa, documento, instante)`:
--         · «mismo día» es DÍA DE CARACAS contra DÍA DE CARACAS. El caso hostil: emitida a las
--           19:00 y preguntada a las 21:00 de Caracas, que en UTC ya es el día siguiente — sigue
--           siendo el mismo día. Variante rota: con el día en UTC, ese caso da `not_same_day`.
--         · «antes del cierre de caja» es instante contra instante, contra el cierre de CUALQUIER
--           CAJA de la empresa (160300): el cierre anterior a la emisión no cuenta, el posterior a
--           la pregunta tampoco, y el de un banco tampoco. Una factura cuyo único cobro fue por
--           banco y se reversó SÍ ve el cierre de la caja física (variante rota: la regla anterior,
--           que miraba solo las cuentas de sus cobros, no lo veía).
--         · «período no declarado»: una declaración posterior a la pregunta no cuenta, y una
--           VISTA PREVIA del período en curso tampoco (B-1: declara solo la generación hecha
--           después de cerrar su período). Variante rota: sin esa condición, la vista previa bloquea.
--         · no es de `authenticated` (para ese rol la cláusula del período callaba).
--         · falla CERRADA: lo que quien llama no ve responde `not_found`, nunca cero filas. Con
--           el usuario de DOS tenants y con el de uno solo, por el camino de la API (ladino_api).
--   G-07. El cajero tiene `sales.return.manage` y NO tiene `sales.refund`; el Dueño sí.
--         La nota de crédito DIRECTA tiene su permiso (`sales.credit_note.direct`, 160300): el
--         cajero no lo tiene; el Dueño y el administrativo sí. Ejercido con
--         `platform.ladino_user_has_permission`, no solo leído del catálogo.
-- =============================================================================

begin;
select plan(41);
set local lock_timeout = '4s';

insert into auth.users (id) values
  ('aaaa0126-0000-4000-8000-0000000000e1'),   -- UA: solo del tenant A
  ('aaaa0126-0000-4000-8000-0000000000e2'),   -- UM: de A y de B (el atacante realista)
  ('aaaa0126-0000-4000-8000-0000000000e3'),   -- UB: solo del tenant B
  ('aaaa0126-0000-4000-8000-0000000000e4');   -- UC: cajero del tenant A
insert into public.tenants (id, name) values
  ('aaaa0126-0000-4000-8000-00000000000a', 'Tenant 126 A'),
  ('aaaa0126-0000-4000-8000-00000000000b', 'Tenant 126 B');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code) values
  ('aaaa0126-0000-4000-8000-0000000000a1', 'aaaa0126-0000-4000-8000-00000000000a',
   'V126000019', 'Bodega 126 A', 'VES'),
  ('aaaa0126-0000-4000-8000-0000000000b1', 'aaaa0126-0000-4000-8000-00000000000b',
   'V126000027', 'Bodega 126 B', 'VES');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0126-0000-4000-8000-0000000001a1', 'aaaa0126-0000-4000-8000-00000000000a',
   'aaaa0126-0000-4000-8000-0000000000e1'),
  ('aaaa0126-0000-4000-8000-0000000001a2', 'aaaa0126-0000-4000-8000-00000000000a',
   'aaaa0126-0000-4000-8000-0000000000e2'),
  ('aaaa0126-0000-4000-8000-0000000001b2', 'aaaa0126-0000-4000-8000-00000000000b',
   'aaaa0126-0000-4000-8000-0000000000e2'),
  ('aaaa0126-0000-4000-8000-0000000001b3', 'aaaa0126-0000-4000-8000-00000000000b',
   'aaaa0126-0000-4000-8000-0000000000e3'),
  ('aaaa0126-0000-4000-8000-0000000001a4', 'aaaa0126-0000-4000-8000-00000000000a',
   'aaaa0126-0000-4000-8000-0000000000e4');
insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
select m.tenant_id, m.id, r.id, null
  from public.memberships m
  join public.roles r on r.key = 'owner' and r.tenant_id is null
 where m.id in ('aaaa0126-0000-4000-8000-0000000001a1', 'aaaa0126-0000-4000-8000-0000000001a2',
                'aaaa0126-0000-4000-8000-0000000001b2', 'aaaa0126-0000-4000-8000-0000000001b3');
insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
select m.tenant_id, m.id, r.id, null
  from public.memberships m
  join public.roles r on r.key = 'cashier' and r.tenant_id is null
 where m.id = 'aaaa0126-0000-4000-8000-0000000001a4';
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                              taxpayer_type_code) values
  ('aaaa0126-0000-4000-8000-0000000000c1', 'aaaa0126-0000-4000-8000-00000000000a',
   'aaaa0126-0000-4000-8000-0000000000a1', 'J412600002', 'Cliente 126', 'juridica', 'ordinario');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code) values
  ('aaaa0126-0000-4000-8000-0000000000d1', 'aaaa0126-0000-4000-8000-00000000000a',
   'aaaa0126-0000-4000-8000-0000000000a1', 'P-126-G', 'Gravado 126', 'good', 'active', 'unidad',
   'gravado_general');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from,
                                           effective_to)
values ('aaaa0126-0000-4000-8000-0000000000f2', 'aaaa0126-0000-4000-8000-00000000000a',
        'aaaa0126-0000-4000-8000-0000000000a1', 'formatos_libres', '2026-06-01 00:00-04', null);
insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                           effective_from, reason, rules_version)
values ('aaaa0126-0000-4000-8000-00000000000a', 'aaaa0126-0000-4000-8000-0000000000a1',
        'ordinario', '2026-06-01', 'Declaración del dueño', 'v1');
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0126-0000-4000-8000-0000000000c8', 'aaaa0126-0000-4000-8000-00000000000a',
   'aaaa0126-0000-4000-8000-0000000000a1', 'Caja X 126', 'VES', 'cash'),
  ('aaaa0126-0000-4000-8000-0000000000c9', 'aaaa0126-0000-4000-8000-00000000000a',
   'aaaa0126-0000-4000-8000-0000000000a1', 'Caja Y 126', 'VES', 'cash'),
  ('aaaa0126-0000-4000-8000-0000000000ca', 'aaaa0126-0000-4000-8000-00000000000a',
   'aaaa0126-0000-4000-8000-0000000000a1', 'Banco 126', 'VES', 'bank');
select set_config('ladino.actor_id', 'aaaa0126-0000-4000-8000-0000000000e1', true);

-- Un borrador con una línea gravada y su emisión, por el camino del esquema (como el pgTAP 121).
create function pg_temp.borrador(p_id uuid) returns void
language sql as $$
  insert into public.documents
    (id, tenant_id, company_id, kind, series, customer_id, status, rules_version,
     transaction_currency, functional_currency, fx_rate, rate_source,
     amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
  values (p_id, 'aaaa0126-0000-4000-8000-00000000000a', 'aaaa0126-0000-4000-8000-0000000000a1',
          'invoice', 'A', 'aaaa0126-0000-4000-8000-0000000000c1', 'draft', 'test-126',
          'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116);
  insert into public.document_lines
    (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
     unit_price_transaction, unit_price_functional, tax_rate_snapshot, tax_amount,
     line_subtotal_transaction, line_subtotal_functional,
     line_total_transaction, line_total_functional,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, rounding_policy_id,
     tax_category_snapshot, tax_treatment)
  values ('aaaa0126-0000-4000-8000-00000000000a', 'aaaa0126-0000-4000-8000-0000000000a1',
          p_id, 1, 'aaaa0126-0000-4000-8000-0000000000d1', 'Línea 126', 1, 100, 100, 0.16, 16,
          100, 100, 116, 116, 116, 'VES', 1, 116, 'VES', 'identidad', now(),
          'inventory:cost:8:HALF_UP', 'gravado_general',
          platform.tax_treatment_of('gravado_general'));
$$;
create function pg_temp.emitir(p_id uuid, p_n int, p_cuando timestamptz) returns void
language sql as $$
  select pg_temp.borrador(p_id);
  update public.documents
     set status = 'issued', issued_at = p_cuando, document_number = p_n, control_number = p_n,
         control_identifier = '00', regime_version_id = 'aaaa0126-0000-4000-8000-0000000000f2'
   where id = p_id;
$$;
-- Las razones, en orden de prioridad, como una sola cadena ('' = nada impide).
create function pg_temp.razones(p_doc uuid, p_at timestamptz) returns text
language sql as $$
  select coalesce(string_agg(reason, ',' order by priority), '')
    from platform.invoice_annulment_blockers('aaaa0126-0000-4000-8000-0000000000a1', p_doc, p_at);
$$;
create function pg_temp.cierre(p_cuenta uuid, p_cuando timestamptz) returns void
language sql as $$
  insert into public.cash_closings
    (tenant_id, company_id, account_id, closing_date, closed_at, expected_amount, counted_amount,
     amount_transaction_currency, transaction_currency, functional_amount, functional_currency)
  values ('aaaa0126-0000-4000-8000-00000000000a', 'aaaa0126-0000-4000-8000-0000000000a1',
          p_cuenta, platform.caracas_day(p_cuando), p_cuando,
          coalesce((select balance from public.company_account_balances
                     where account_id = p_cuenta), 0),
          coalesce((select balance from public.company_account_balances
                     where account_id = p_cuenta), 0),
          0, 'VES', 0, 'VES');
$$;

-- F1: emitida el 10 de julio a las 19:00 de Caracas (23:00 UTC del mismo día).
select pg_temp.emitir('aaaa0126-0000-4000-8000-000000000101', 1, '2026-07-10 19:00-04');

-- ── 1. El mismo día es el día de CARACAS ─────────────────────────────────────
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000101', '2026-07-10 19:00-04'), '',
  'G-10: en el instante mismo de la emisión nada de papel impide anular');
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000101', '2026-07-10 21:00-04'), '',
  'G-10: a las 21:00 de Caracas (ya 11 de julio en UTC) sigue siendo el MISMO día');
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000101', '2026-07-11 00:10-04'),
  'not_same_day', 'G-10: diez minutos después de la medianoche de Caracas ya es otro día');

-- VARIANTE ROTA: con el día tomado en UTC, las 21:00 de Caracas pasan a ser «otro día». Si esto
-- no cambiara, el caso de las 21:00 de arriba no mediría la granularidad.
create temp table viva as
  select pg_get_functiondef(
    'platform.invoice_annulment_blockers(uuid, uuid, timestamptz)'::regprocedure) as def;
do $$
declare v_def text;
begin
  v_def := (select def from pg_temp.viva);
  v_def := replace(v_def,
    'platform.caracas_day(d.issued_at) <> platform.caracas_day(p_at)',
    '(d.issued_at at time zone ''utc'')::date <> (p_at at time zone ''utc'')::date');
  if v_def = (select def from pg_temp.viva) then
    raise exception 'la variante rota no encontró la comparación de días';
  end if;
  execute v_def;
end $$;
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000101', '2026-07-10 21:00-04'),
  'not_same_day', 'VARIANTE ROTA: con el día en UTC, las 21:00 de Caracas serían otro día');
do $$ begin execute (select def from pg_temp.viva); end $$;
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000101', '2026-07-10 21:00-04'), '',
  'restituida la definición viva, las 21:00 vuelven a ser el mismo día');

-- ── 2. Antes del cierre de caja: instante contra instante ────────────────────
-- La caja X se cierra a las 20:00. F1 (19:00) no tiene cobros: cuenta cualquier cierre.
select pg_temp.cierre('aaaa0126-0000-4000-8000-0000000000c8', '2026-07-10 20:00-04');
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000101', '2026-07-10 21:00-04'),
  'cash_closed', 'G-10: emitida a las 19:00 y la caja cerrada a las 20:00: ya no se anula');
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000101', '2026-07-10 19:30-04'), '',
  'G-10: preguntada a las 19:30, el cierre de las 20:00 todavía no ocurrió');
-- F2: emitida a las 20:30, DESPUÉS del cierre: ese cierre no la toca.
select pg_temp.emitir('aaaa0126-0000-4000-8000-000000000102', 2, '2026-07-10 20:30-04');
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000102', '2026-07-10 21:00-04'), '',
  'G-10: un cierre ANTERIOR a la emisión no impide anular');

-- F3: emitida a las 19:10 y cobrada en la caja Y. La caja X cerró a las 20:00: desde 160300 la
-- regla es una sola —cualquier caja de la empresa—, tenga o no cobros el documento.
select pg_temp.emitir('aaaa0126-0000-4000-8000-000000000103', 3, '2026-07-10 19:10-04');
insert into public.payments
  (tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values ('aaaa0126-0000-4000-8000-00000000000a', 'aaaa0126-0000-4000-8000-0000000000a1',
        'aaaa0126-0000-4000-8000-000000000103', '2026-07-10 19:15-04', 'VES', 116, 1, 'identidad',
        '2026-07-10 19:15-04', 116, 'efectivo_bs', 'aaaa0126-0000-4000-8000-0000000000c9');
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000103', '2026-07-10 21:00-04'),
  'cash_closed',
  'G-10: cobrada en la caja Y, el cierre de la caja X (otra caja de la empresa) también impide anular');
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000103', '2026-07-10 19:30-04'), '',
  'G-10: preguntada antes de cualquier cierre, la cobrada en la caja Y no tiene impedimento de papel');

-- F5: emitida a las 19:20; su ÚNICO cobro fue por BANCO y se reversó. La caja física (X) cerró
-- a las 20:00: la factura ya no se anula. La regla anterior miraba solo las cuentas de sus
-- cobros (el banco, que no se cierra) y respondía «nada lo impide».
select pg_temp.emitir('aaaa0126-0000-4000-8000-000000000105', 5, '2026-07-10 19:20-04');
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values ('aaaa0126-0000-4000-8000-0000000005f1', 'aaaa0126-0000-4000-8000-00000000000a',
        'aaaa0126-0000-4000-8000-0000000000a1', 'aaaa0126-0000-4000-8000-000000000105',
        '2026-07-10 19:25-04', 'VES', 116, 1, 'identidad', '2026-07-10 19:25-04', 116,
        'transferencia', 'aaaa0126-0000-4000-8000-0000000000ca');
insert into public.payment_reversals
  (tenant_id, company_id, payment_id, document_id, reversed_at, reason, account_id, currency,
   amount, functional_amount)
values ('aaaa0126-0000-4000-8000-00000000000a', 'aaaa0126-0000-4000-8000-0000000000a1',
        'aaaa0126-0000-4000-8000-0000000005f1', 'aaaa0126-0000-4000-8000-000000000105',
        '2026-07-10 19:40-04', 'Transferencia registrada por error (pgTAP 126)',
        'aaaa0126-0000-4000-8000-0000000000ca', 'VES', 116, 116);
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000105', '2026-07-10 21:00-04'),
  'cash_closed',
  'G-10: cobro por banco reversado + cierre de la caja física después de emitir: ya no se anula');

-- VARIANTE ROTA: la cláusula de 20261004160100 («sus cajas son las cuentas de sus cobros»). Con
-- ella, F5 no ve el cierre de la caja física. Si esto no cambiara, el caso de arriba no mediría
-- la regla uniforme.
create temp table viva2 as
  select pg_get_functiondef(
    'platform.invoice_annulment_blockers(uuid, uuid, timestamptz)'::regprocedure) as def;
do $$
declare v_def text;
begin
  v_def := (select def from pg_temp.viva2);
  v_def := replace(v_def,
    'and (cc.branch_id is null or d.branch_id is null or cc.branch_id = d.branch_id))',
    'and (cc.account_id in (select p.account_id from public.payments p
                             where p.document_id = d.id and p.account_id is not null)
          or (not exists (select 1 from public.payments p
                           where p.document_id = d.id and p.account_id is not null)
              and (cc.branch_id is null or d.branch_id is null
                   or cc.branch_id = d.branch_id))))');
  if v_def = (select def from pg_temp.viva2) then
    raise exception 'la variante rota no encontró la cláusula del cierre de caja';
  end if;
  execute v_def;
end $$;
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000105', '2026-07-10 21:00-04'), '',
  'VARIANTE ROTA: mirando solo las cuentas de sus cobros, el cierre de la caja física no se ve');
do $$ begin execute (select def from pg_temp.viva2); end $$;
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000105', '2026-07-10 21:00-04'),
  'cash_closed', 'restituida la definición viva, el cierre de la caja física vuelve a impedir');

-- El cierre de un BANCO no es un cierre de caja. F6 se emite a las 20:40, después de los cierres
-- de las cajas; a las 20:50 aparece un cierre sobre la cuenta de banco (el esquema lo admite; el
-- caso de uso no): no impide anular.
select pg_temp.cierre('aaaa0126-0000-4000-8000-0000000000c9', '2026-07-10 20:10-04');
select pg_temp.emitir('aaaa0126-0000-4000-8000-000000000106', 6, '2026-07-10 20:40-04');
select pg_temp.cierre('aaaa0126-0000-4000-8000-0000000000ca', '2026-07-10 20:50-04');
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000106', '2026-07-10 21:00-04'), '',
  'G-10: el cierre de una cuenta de BANCO no es un cierre de caja: no impide anular');
-- VARIANTE ROTA: sin el filtro del tipo de cuenta, el cierre del banco bloquearía.
do $$
declare v_def text;
begin
  v_def := replace((select def from pg_temp.viva2), 'and ca.kind = ''cash''', '');
  if v_def = (select def from pg_temp.viva2) then
    raise exception 'la variante rota no encontró el filtro del tipo de cuenta';
  end if;
  execute v_def;
end $$;
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000106', '2026-07-10 21:00-04'),
  'cash_closed', 'VARIANTE ROTA: sin kind = cash, el cierre de un banco contaría como cierre de caja');
do $$ begin execute (select def from pg_temp.viva2); end $$;
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000106', '2026-07-10 21:00-04'), '',
  'restituida la definición viva, el cierre del banco vuelve a no contar');

-- ── 3. Período no declarado ──────────────────────────────────────────────────
-- La declaración de julio se guarda AHORA (created_at = now()): para una pregunta hecha en julio
-- todavía no existía; para una hecha desde ahora, sí.
insert into public.iva_period_results
  (tenant_id, company_id, period_from, period_to, debitos, creditos, creditos_deducibles,
   retenciones_soportadas, excedente_anterior, cuota_a_pagar, excedente_siguiente, detalle,
   generator_version, dataset_hash)
values ('aaaa0126-0000-4000-8000-00000000000a', 'aaaa0126-0000-4000-8000-0000000000a1',
        '2026-07-01', '2026-07-31', 0, 0, 0, 0, 0, 0, 0, '{}'::jsonb, 'test-126', 'hash-126');
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000102', '2026-07-10 21:00-04'), '',
  'G-10: una declaración POSTERIOR a la pregunta no cuenta');
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000102', now()),
  'not_same_day,period_declared',
  'G-10: con el período ya declarado, la factura de julio no se anula (y además es de otro día)');

-- Una VISTA PREVIA del período en curso NO declara (B-1, 20261002120400): F7 se emite ahora, y
-- el contador genera ahora la planilla del mes en curso. La factura de hoy se sigue anulando hoy.
select pg_temp.emitir('aaaa0126-0000-4000-8000-000000000107', 7, now());
insert into public.iva_period_results
  (tenant_id, company_id, period_from, period_to, debitos, creditos, creditos_deducibles,
   retenciones_soportadas, excedente_anterior, cuota_a_pagar, excedente_siguiente, detalle,
   generator_version, dataset_hash)
values ('aaaa0126-0000-4000-8000-00000000000a', 'aaaa0126-0000-4000-8000-0000000000a1',
        date_trunc('month', platform.caracas_day(now()))::date,
        (date_trunc('month', platform.caracas_day(now())) + interval '1 month - 1 day')::date,
        0, 0, 0, 0, 0, 0, 0, '{}'::jsonb, 'test-126', 'hash-126-previa');
-- Y la del período que TERMINA HOY, generada hoy: tampoco declara (period_to < día de generación
-- es estricto: el período no ha cerrado mientras dure su último día).
insert into public.iva_period_results
  (tenant_id, company_id, period_from, period_to, debitos, creditos, creditos_deducibles,
   retenciones_soportadas, excedente_anterior, cuota_a_pagar, excedente_siguiente, detalle,
   generator_version, dataset_hash)
values ('aaaa0126-0000-4000-8000-00000000000a', 'aaaa0126-0000-4000-8000-0000000000a1',
        platform.caracas_day(now()) - 14, platform.caracas_day(now()),
        0, 0, 0, 0, 0, 0, 0, '{}'::jsonb, 'test-126', 'hash-126-ultimo-dia');
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000107', now()), '',
  'G-10: una vista previa del período en curso (o del que termina hoy) NO bloquea la anulación');
-- VARIANTE ROTA: sin la condición B-1, la vista previa pasa por declaración y la factura de hoy
-- deja de anularse con un mensaje falso.
do $$
declare v_def text;
begin
  v_def := replace((select def from pg_temp.viva2),
    'and r.period_to < platform.caracas_day(r.created_at)', '');
  if v_def = (select def from pg_temp.viva2) then
    raise exception 'la variante rota no encontró la condición B-1';
  end if;
  execute v_def;
end $$;
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000107', now()), 'period_declared',
  'VARIANTE ROTA: sin B-1, la vista previa del período en curso bloquearía como «declarado»');
do $$ begin execute (select def from pg_temp.viva2); end $$;
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000107', now()), '',
  'restituida la definición viva, la vista previa vuelve a no bloquear');

-- ── 4. Solo juzga facturas emitidas, y falla cerrada ─────────────────────────
select pg_temp.borrador('aaaa0126-0000-4000-8000-000000000104');
select is(pg_temp.razones('aaaa0126-0000-4000-8000-000000000104', now()), '',
  'un borrador visible no es papel fiscal emitido: la función no lo juzga (cero filas)');
select is(pg_temp.razones('aaaa0126-0000-4000-8000-0000000009ff', now()), 'not_found',
  'falla cerrada: un documento que no existe responde not_found, nunca cero filas');

-- Por el camino de la API. UB, que solo es del tenant B, pregunta por la factura de A.
select set_config('ladino.actor_id', 'aaaa0126-0000-4000-8000-0000000000e3', true);
set local role ladino_api;
select set_config('t126.ub', coalesce((select string_agg(reason, ',' order by priority)
  from platform.invoice_annulment_blockers('aaaa0126-0000-4000-8000-0000000000a1',
         'aaaa0126-0000-4000-8000-000000000101', '2026-07-10 19:30-04')), ''), true);
reset role;
select is(current_setting('t126.ub'), 'not_found',
  'aislamiento: quien solo es del tenant B no ve la factura de A — not_found, no «se puede»');

-- UM, de los DOS tenants: con la empresa B y la factura de A, not_found; con la empresa A, la
-- respuesta de verdad (lo permitido se ejerce, no solo se cierra lo prohibido).
select set_config('ladino.actor_id', 'aaaa0126-0000-4000-8000-0000000000e2', true);
set local role ladino_api;
select set_config('t126.um_b', coalesce((select string_agg(reason, ',' order by priority)
  from platform.invoice_annulment_blockers('aaaa0126-0000-4000-8000-0000000000b1',
         'aaaa0126-0000-4000-8000-000000000101', '2026-07-10 19:30-04')), ''), true);
select set_config('t126.um_a', coalesce((select string_agg(reason, ',' order by priority)
  from platform.invoice_annulment_blockers('aaaa0126-0000-4000-8000-0000000000a1',
         'aaaa0126-0000-4000-8000-000000000101', '2026-07-11 00:10-04')), ''), true);
reset role;
select is(current_setting('t126.um_b'), 'not_found',
  'multi-tenant: la factura de A pedida con la empresa B responde not_found');
select is(current_setting('t126.um_a'), 'not_same_day,cash_closed',
  'multi-tenant: con la empresa A, ladino_api recibe la respuesta de verdad');
select set_config('ladino.actor_id', 'aaaa0126-0000-4000-8000-0000000000e1', true);

set local role anon;
select throws_ok($$ select * from platform.invoice_annulment_blockers(
    'aaaa0126-0000-4000-8000-0000000000a1', 'aaaa0126-0000-4000-8000-000000000101', now()) $$,
  '42501', null, 'la función no es de PUBLIC: anon no la ejecuta');
reset role;
-- Ni de authenticated (160300): para ese rol la cláusula del período callaba (no ve
-- iva_period_results) y la regla fallaba abierta. La API (ladino_api) la ejecutó arriba.
set local role authenticated;
select throws_ok($$ select * from platform.invoice_annulment_blockers(
    'aaaa0126-0000-4000-8000-0000000000a1', 'aaaa0126-0000-4000-8000-000000000101', now()) $$,
  '42501', null, 'la regla no es de authenticated: solo la ejecuta la API');
reset role;

-- ── 5. G-07: el cajero inicia la devolución; el reembolso es de otro ─────────
create function pg_temp.rol_tiene(p_rol text, p_permiso text) returns boolean
language sql as $$
  select exists (select 1 from public.role_permissions rp
                   join public.roles r on r.id = rp.role_id and r.tenant_id is null
                  where r.key = p_rol and rp.permission_key = p_permiso);
$$;
select ok(pg_temp.rol_tiene('cashier', 'sales.return.manage'),
  'G-07: el cajero tiene sales.return.manage: inicia y confirma devoluciones');
select ok(not pg_temp.rol_tiene('cashier', 'sales.refund'),
  'G-07: el cajero NO tiene sales.refund: no saca el dinero de la caja');
select ok(pg_temp.rol_tiene('owner', 'sales.refund'),
  'G-07: el Dueño sí reembolsa (el camino del cajero termina en alguien)');
-- VARIANTE ROTA: sin la fila de la migración, el cajero vuelve a no tener camino.
delete from public.role_permissions rp using public.roles r
 where rp.role_id = r.id and r.key = 'cashier' and r.tenant_id is null
   and rp.permission_key = 'sales.return.manage';
select ok(not pg_temp.rol_tiene('cashier', 'sales.return.manage'),
  'VARIANTE ROTA G-07: sin la fila, el cajero no tiene el permiso (se mide la fila)');
insert into public.role_permissions (role_id, permission_key, tenant_id)
select r.id, 'sales.return.manage', null from public.roles r
 where r.key = 'cashier' and r.tenant_id is null;

-- ── 6. G-07: la nota de crédito DIRECTA tiene su permiso (160300) ────────────
select ok(not pg_temp.rol_tiene('cashier', 'sales.credit_note.direct'),
  'G-07: el cajero NO tiene sales.credit_note.direct: devuelve, no acredita sin mercancía');
select ok(pg_temp.rol_tiene('owner', 'sales.credit_note.direct'),
  'G-07: el Dueño conserva la nota de crédito directa');
select ok(pg_temp.rol_tiene('back_office', 'sales.credit_note.direct'),
  'G-07: el administrativo conserva la nota de crédito directa');
select is(
  (select count(*)::int from public.role_permissions rp
     join public.roles r on r.id = rp.role_id and r.tenant_id is null
    where r.key in ('owner', 'back_office', 'cashier', 'accountant', 'store_manager', 'warehouse_ops')
      and rp.permission_key = 'sales.credit_note.direct'),
  2, 'G-07: de los seis roles de sistema, solo dos tienen la nota de crédito directa');
-- Ejercido, no solo leído del catálogo: lo que la API pregunta antes de emitir la nota.
select ok(platform.ladino_user_has_permission('aaaa0126-0000-4000-8000-0000000000e4',
            'sales.return.manage', 'aaaa0126-0000-4000-8000-0000000000a1'),
  'G-07: el cajero de la empresa A puede iniciar una devolución');
select ok(not platform.ladino_user_has_permission('aaaa0126-0000-4000-8000-0000000000e4',
            'sales.credit_note.direct', 'aaaa0126-0000-4000-8000-0000000000a1'),
  'G-07: el cajero de la empresa A NO puede emitir una nota de crédito directa');
select ok(platform.ladino_user_has_permission('aaaa0126-0000-4000-8000-0000000000e1',
            'sales.credit_note.direct', 'aaaa0126-0000-4000-8000-0000000000a1'),
  'G-07: el Dueño de la empresa A sí');
select ok(not platform.ladino_user_has_permission('aaaa0126-0000-4000-8000-0000000000e3',
            'sales.credit_note.direct', 'aaaa0126-0000-4000-8000-0000000000a1'),
  'aislamiento: el Dueño del tenant B no la emite en la empresa A');
-- VARIANTE ROTA: con la fila que la migración NO le da, el cajero pasaría la autorización.
insert into public.role_permissions (role_id, permission_key, tenant_id)
select r.id, 'sales.credit_note.direct', null from public.roles r
 where r.key = 'cashier' and r.tenant_id is null;
select ok(platform.ladino_user_has_permission('aaaa0126-0000-4000-8000-0000000000e4',
            'sales.credit_note.direct', 'aaaa0126-0000-4000-8000-0000000000a1'),
  'VARIANTE ROTA G-07: con la fila, el cajero emitiría la nota directa (se mide la fila que falta)');

select * from finish();
rollback;

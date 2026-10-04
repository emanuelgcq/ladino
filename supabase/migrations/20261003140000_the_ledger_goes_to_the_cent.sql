-- =============================================================================
-- Ladino — EL MAYOR AL CÉNTIMO, INCLUIDO EL INVENTARIO (ADR-0075 §7; P-01, P-03, K-08)
--
-- Módulo: contabilidad · inventario · libros. Rigor máximo (dinero, con datos vivos).
-- Spec:   MONEY_AND_ROUNDING_SPEC.md §6.6 (enmendado) · ADR-0063 (enmendado) · ADR-0060.
-- Reversible: SÍ para el esquema, con datos vivos — ver al final. Las regularizaciones que
--   produzca `cent_regularization_repair` son asientos posteados y movimientos de kardex
--   append-only: se revierten con su reversa, no se borran.
-- HOMOLOGATION_IMPACT: YES — el libro de compras (y con él la declaración que lo lee) pasa a
--   convertir a bolívares al céntimo: round(importe × tasa, 2) en vez de a 8 decimales.
--
-- Qué cambia:
--   1. `platform.round_cents(numeric)`: LA función de redondeo al céntimo, half-up. Su gemela en
--      TS es `toCents` de @ladino/money. La familia «moneda y diferencial» la reutiliza.
--   2. El papel `rounding_difference` y la cuenta 5.1.10 «Diferencias por redondeo» en ve_basico
--      y en los planes ya importados, con acta. No existía una cuenta de redondeo: ADR-0063
--      absorbía el residuo del cobro en la conversión, sin cuenta propia.
--   3. `platform.apply_inventory_move`, create or replace sobre la definición VIVA (migración
--      20260826222915 §9, F5). Tres diferencias, nada más:
--        · el costo de una salida se verifica contra el redondeo AL CÉNTIMO (tolerancia medio
--          céntimo); el costo unitario sigue verificado a 8 decimales;
--        · sobre una posición al céntimo, un movimiento con fracción de céntimo es LAD41;
--        · I-05 (ADR-0078, por coordinación): solo el producto BORRADOR rechaza movimientos; un
--          inactivo admite salida, conteo, traslado y regularización.
--   4. `platform.purchases_book` y `platform.purchases_book_by_rate`, create or replace sobre la
--      VIVA (20260928170400 §1 y §2). Única diferencia: toda conversión `round(x × tasa, 8)` pasa
--      a `round(x × tasa, 2)` (21 sitios), y el residuo puro de redondeo que va a la alícuota
--      mayor pasa de «< 0,01» a «≤ 0,01» (con todo al céntimo el residuo de redondeo es un número
--      entero de céntimos). Sin esto, el asiento al céntimo y el libro a 8 decimales romperían
--      `book_ledger_reconciliation` en cada factura en divisa.
--   5. `platform.cent_gaps(company)`: el INVARIANTE nuevo. Cero filas.
--   6. `platform.cent_regularization_repair(company, ensayo)`: la regularización al corte, por
--      posición del kardex y por cuenta del mayor, con acta. Corre DESPUÉS del pull
--      (scripts/reparar/adr-0075-centimo.mjs). Sin GRANT a nadie.
-- =============================================================================

-- ── 1. La función única del céntimo ─────────────────────────────────────────
create or replace function platform.round_cents(p numeric)
returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $$ select round(p, 2) $$;
comment on function platform.round_cents(numeric) is
  'ADR-0075 §7: el importe funcional al céntimo, half-up (round() de numeric redondea la mitad '
  'lejos del cero, igual que ROUND_HALF_UP de decimal.js). Gemela de toCents (@ladino/money). '
  'Ocho decimales quedan solo para costos unitarios y tasas. VALIDAR-CONTABLE: half-up.';
grant execute on function platform.round_cents(numeric) to authenticated, ladino_api;

-- ── 2. «Diferencias por redondeo» ───────────────────────────────────────────
insert into public.account_purposes (code, name, description) values
  ('rounding_difference', 'Diferencias por redondeo',
   'Residuo de llevar al céntimo el importe funcional de un asiento, y la fracción de céntimo '
   'que la regularización al corte saca del kardex y del mayor (ADR-0075 §7). Cuenta de '
   'resultado. VALIDAR-CONTABLE: la cuenta y half-up.')
on conflict (code) do nothing;

insert into public.chart_template_accounts
  (template_code, code, name, parent_code, kind, nature, is_leaf, level, suggested_purpose)
values
  ('ve_basico', '5.1.10', 'Diferencias por redondeo', '5.1', 'gasto', 'deudora', true, 3,
   'rounding_difference')
on conflict (template_code, code) do nothing;

do $$
declare
  v_c record;
  v_padre uuid;
  v_cuenta uuid;
  v_ahora timestamptz := now();
begin
  -- Toda empresa con plan importado (tiene 5.1) y sin el papel.
  for v_c in
    select distinct a.company_id, a.tenant_id from public.accounts a where a.code = '5.1'
  loop
    continue when exists (select 1 from public.company_account_settings s
                           where s.company_id = v_c.company_id and s.purpose = 'rounding_difference');
    select id into v_padre from public.accounts where company_id = v_c.company_id and code = '5.1';
    select id into v_cuenta from public.accounts
     where company_id = v_c.company_id and code = '5.1.10' and name = 'Diferencias por redondeo';
    if v_cuenta is null then
      -- El código ocupado por otra cuenta NO se pisa: la empresa queda sin el papel y el
      -- generador encola diciendo «Falta configurar la cuenta de: rounding_difference».
      continue when exists (select 1 from public.accounts
                             where company_id = v_c.company_id and code = '5.1.10');
      insert into public.accounts
        (tenant_id, company_id, code, name, parent_id, kind, nature, rules_version)
      values (v_c.tenant_id, v_c.company_id, '5.1.10', 'Diferencias por redondeo', v_padre,
              'gasto', 'deudora', 'db-migration')
      returning id into v_cuenta;
    end if;
    insert into public.company_account_settings
      (tenant_id, company_id, purpose, account_id, effective_from)
    values (v_c.tenant_id, v_c.company_id, 'rounding_difference', v_cuenta, '-infinity');
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_c.tenant_id, v_c.company_id, 'company', v_c.company_id,
            'accounting.account_added', 'system', v_ahora, 'db-migration',
            jsonb_build_object('origin', 'migration_20261003140000', 'code', '5.1.10',
                               'purpose', 'rounding_difference', 'account_id', v_cuenta,
                               'adr', 'ADR-0075 §7'));
  end loop;
end $$;

-- ── 3. El oráculo del kardex al céntimo (+ I-05) ────────────────────────────
create or replace function platform.apply_inventory_move()
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
  v_q          numeric;
  v_cost       numeric;
  v_qty_after  numeric;
  v_val_after  numeric;
  v_unit       numeric;
  v_meaningful boolean;
  v_allow      boolean;
  v_actor      uuid;
  v_tol        constant numeric := 0.000000005;
  -- ADR-0075 §7: el VALOR de una salida va al céntimo half-up; su tolerancia es medio céntimo.
  -- v_tol (8 decimales) queda solo para el costo unitario.
  v_tol_c      constant numeric := 0.005;
begin
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

  select pr.kind, pr.status, pr.tracks_lots, pr.tracks_serials, pr.is_composed, pr.tracks_expiry
    into p
    from public.products pr where pr.id = new.product_id and pr.company_id = new.company_id;
  if p.kind is null then
    raise exception 'el producto no pertenece a esta empresa' using errcode = '23503';
  end if;
  if p.kind <> 'good' then
    raise exception 'un servicio no tiene existencias' using errcode = 'LAD38';
  end if;
  -- NUEVO (LAD43): el compuesto no se mueve. Se venden sus ingredientes.
  if p.is_composed then
    raise exception
      'un producto compuesto no tiene existencias propias: vender uno descuenta los ingredientes de su receta, no el plato (ADR-0035)'
      using errcode = 'LAD43',
            hint = 'usa el caso de uso de consumo de receta, que genera una salida por ingrediente';
  end if;
  -- I-05 (ADR-0078, §2.12 «inactivo significa no se vende, no no existe»): un producto INACTIVO
  -- admite salida, conteo, traslado y regularización; la venta la sigue impidiendo el dominio
  -- (sales.ts filtra status = 'active'). Solo el BORRADOR no tiene existencias.
  if p.status = 'draft' then
    raise exception 'el producto es un borrador (%): actívalo antes de mover existencias', p.status
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
    select lo.product_id, lo.status, lo.expires_at into l from public.lots lo
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
    -- NUEVO (LAD46): vencido + SALIDA + sin permiso = no sale. Contra
    -- occurred_at, no contra now(): el pasado se juzga con lo de entonces.
    if p.tracks_expiry and new.quantity < 0
       and l.expires_at is not null and l.expires_at < new.occurred_at::date then
      v_actor := coalesce(auth.uid(), platform.ladino_service_actor_id());
      if v_actor is null
         or not platform.ladino_user_has_scope(v_actor, 'inventory.expired', 'warehouse', new.warehouse_id) then
        raise exception
          'el lote % venció el % y despachar existencia vencida exige el permiso inventory.expired sobre este almacén',
          new.lot_id, l.expires_at
          using errcode = 'LAD46';
      end if;
    end if;
  end if;

  select wh.status into w_status from public.warehouses wh
   where wh.id = new.warehouse_id and wh.company_id = new.company_id;
  if w_status is null then
    raise exception 'el almacén no pertenece a esta empresa' using errcode = '23503';
  end if;
  if w_status <> 'active' then
    raise exception 'el almacén está inactivo' using errcode = 'LAD38';
  end if;

  b := platform.stock_position_lock(v_tenant, new.company_id, new.warehouse_id, new.product_id, new.lot_id, v_functional);
  if b.currency_code <> v_functional then
    raise exception
      'la posición está valorada en % y la empresa lleva %: regulariza antes de mover', b.currency_code, v_functional
      using errcode = 'LAD38';
  end if;

  -- ADR-0075 §7: sobre una posición al céntimo, ningún movimiento trae fracción de céntimo. Una
  -- posición con fracción heredada (anterior a esta migración) la conserva hasta la
  -- regularización al corte (platform.cent_regularization_repair), que es la que la limpia.
  if b.value = round(b.value, 2) and new.functional_amount <> round(new.functional_amount, 2) then
    raise exception
      'kardex: el valor de un movimiento va al céntimo (ADR-0075 §7), llegó %', new.functional_amount
      using errcode = 'LAD41';
  end if;

  v_q         := abs(new.quantity);
  v_qty_after := b.quantity + new.quantity;
  v_val_after := b.value + new.functional_amount;

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

  if new.quantity < 0 then
    v_cost       := -new.functional_amount;
    v_meaningful := b.quantity > 0 and b.value >= 0;
    if not v_meaningful then
      if abs(v_cost - v_q * b.last_unit_cost) > v_tol_c then
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
      if abs(v_cost * b.quantity - b.value * v_q) > v_tol_c * b.quantity then
        raise exception
          'costeo: la salida no es el redondeo al céntimo de valor × q / existencia (% × % / %), llegó %',
          b.value, v_q, b.quantity, v_cost
          using errcode = 'LAD41';
      end if;
    else
      if abs((v_cost - b.value) * b.quantity - b.value * (v_q - b.quantity)) > v_tol_c * b.quantity then
        raise exception
          'costeo: al pasar a negativo la salida vale todo el valor (%) más el exceso al promedio, llegó %',
          b.value, v_cost
          using errcode = 'LAD41';
      end if;
    end if;
  end if;

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

-- ── 4. El libro de compras al céntimo (HOMOLOGATION_IMPACT) ─────────────────
create or replace function platform.purchases_book(p_company uuid, p_from date, p_to date)
 RETURNS TABLE(invoice_id uuid, invoice_date date, supplier_tax_id text, supplier_name text, supplier_kind text, supplier_document_number text, supplier_control_number text, supplier_document_ref text, status text, transaction_currency text, fx_rate numeric, base_gravada numeric, iva_credito numeric, iva_al_costo numeric, base_exenta numeric, base_exonerada numeric, base_no_sujeta numeric, base_sin_clasificar numeric, retenido_iva numeric, retenido_islr numeric, total_amount numeric, tax_is_recoverable boolean, journal_entry_id uuid, booked_on date, received_late boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  -- LIBRO DE COMPRAS EN MONEDA FUNCIONAL (migración 65): cada documento a la tasa con la que se
  -- asentó. Cinco reglas, con su norma:
  --   · la factura ANULADA se registra con importes en CERO: conserva la traza cronológica que
  --     pide el Reglamento art. 70 sin llevar al libro un crédito fiscal que la Ley art. 37
  --     manda deducir (R-2);
  --   · la anulada DESPUÉS de cerrar su período y de generar o declarar su libro no cambia ese
  --     libro —sale como se generó, «posted»— y entra en el período de la anulación como
  --     reversa del crédito, en NEGATIVO, con estado «ajuste_periodo_anterior» (regla añadida a
  --     R-2, 2026-09-28; ver platform.supplier_invoice_late_annulment_day);
  --   · la NOTA DE CRÉDITO recibida se registra como documento propio, en NEGATIVO, en el
  --     período de su recepción (LIVA arts. 56 y 37; Reglamento arts. 70 y 75 lit. a);
  --   · una nota anulada, como la factura anulada: en cero;
  --   · la compra SIN SOPORTE FISCAL no se registra: el libro relaciona documentos, y ahí no hay
  --     documento que relacionar (ADR-0066 §2);
  --   · la RECIBIDA CON RETRASO (ADR-0069 §4, K-04): su fecha cae en un período cerrado (o antes
  --     del inicio de actividades) y se REGISTRÓ en el período abierto. Entra al libro del período
  --     de registro (booked_on = accounting_date), marcada received_late, con su fecha original en
  --     invoice_date; su crédito se deduce en ese período. La ventana legal para deducirlo
  --     (LIVA art. 33, «doce períodos») NO se aplica: pendiente de fuente (P-35).
  with base as (
    select i.*,
           coalesce(i.accounting_date, i.invoice_date) as fecha_libro,
           case when i.status = 'annulled'
                then platform.supplier_invoice_late_annulment_day(
                       i.company_id, coalesce(i.accounting_date, i.invoice_date), i.annulled_at)
           end as dia_ajuste
      from public.supplier_invoices i
     where i.company_id = p_company
       and i.status in ('posted', 'paid', 'annulled')
       and i.fiscal_support
  ),
  f as (
    select b.*,
           round(b.tax_amount * b.fx_rate, 2) as iva_lleno,
           round(b.subtotal_amount * b.fx_rate, 2) as sub_lleno
      from base b
     where b.fecha_libro between p_from and p_to
        or b.dia_ajuste between p_from and p_to
  ),
  -- Los importes de cada factura COMO SI NO se hubiera anulado; cada uso decide su factor.
  lleno as (
    -- Hallazgo 1: el proveedor COMO SE REGISTRÓ la factura (snapshot de la 170100); las
    -- anteriores, sin snapshot e inmutables, caen al maestro.
    select f.id, f.invoice_date, f.dia_ajuste,
           -- B1 (170200): discrimina por el snapshot del NOMBRE, que el registro llena siempre.
           case when f.supplier_name_snapshot is not null then f.supplier_tax_id_snapshot
                else s.tax_id end as tax_id,
           coalesce(f.supplier_name_snapshot, s.legal_name) as legal_name, s.supplier_kind,
           f.supplier_document_number, f.supplier_control_number, f.supplier_document_ref,
           f.status, f.transaction_currency, f.fx_rate,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'gravado'), 0) * f.fx_rate, 2) as gravada,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'exento'), 0) * f.fx_rate, 2) as exenta,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'exonerado'), 0) * f.fx_rate, 2)
             as exonerada,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'no_sujeto'), 0) * f.fx_rate, 2)
             as no_sujeta,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment is null), 0) * f.fx_rate, 2)
             as sin_clasificar,
           coalesce((select sum(r.retained_amount) from public.supplier_retentions r
                      where r.supplier_invoice_id = f.id and r.retention_code = 'iva'
                        and r.status <> 'cancelled'), 0) as ret_iva,
           coalesce((select sum(r.retained_amount) from public.supplier_retentions r
                      where r.supplier_invoice_id = f.id and r.retention_code = 'islr'
                        and r.status <> 'cancelled'), 0) as ret_islr,
           f.iva_lleno, f.sub_lleno, f.tax_is_recoverable, f.journal_entry_id,
           f.fecha_libro, f.accounting_date
      from f
      join public.suppliers s on s.id = f.supplier_id
      left join public.supplier_invoice_lines l on l.supplier_invoice_id = f.id
     group by f.id, f.invoice_date, f.dia_ajuste, f.supplier_document_number,
              f.supplier_control_number, f.supplier_document_ref, f.status,
              f.transaction_currency, f.fx_rate, f.tax_is_recoverable, f.journal_entry_id,
              f.iva_lleno, f.sub_lleno, f.fecha_libro, f.accounting_date,
              f.supplier_tax_id_snapshot, f.supplier_name_snapshot,
              s.tax_id, s.legal_name, s.supplier_kind
  ),
  facturas as (
    select x.id, x.invoice_date, x.tax_id, x.legal_name, x.supplier_kind,
           x.supplier_document_number, x.supplier_control_number, x.supplier_document_ref,
           -- La anulada tarde sale como se generó: el libro de ese período no cambia.
           case when x.status = 'annulled' and x.dia_ajuste is not null then 'posted'
                else x.status end as status,
           x.transaction_currency, x.fx_rate,
           x.gravada * k.factor as base_gravada,
           case when x.tax_is_recoverable then x.iva_lleno * k.factor else 0 end as iva_credito,
           case when x.tax_is_recoverable then 0 else x.iva_lleno * k.factor end as iva_al_costo,
           x.exenta * k.factor as base_exenta,
           x.exonerada * k.factor as base_exonerada,
           x.no_sujeta * k.factor as base_no_sujeta,
           x.sin_clasificar * k.factor as base_sin_clasificar,
           x.ret_iva * k.factor as retenido_iva,
           x.ret_islr * k.factor as retenido_islr,
           (x.sub_lleno + x.iva_lleno) * k.factor as total_amount,
           x.tax_is_recoverable, x.journal_entry_id,
           x.fecha_libro as booked_on, x.accounting_date is not null as received_late
      from lleno x
     cross join lateral (
       select case when x.status = 'annulled' and x.dia_ajuste is null then 0 else 1 end as factor
     ) k
     where x.fecha_libro between p_from and p_to
  ),
  -- La reversa del crédito en el período de la anulación. Sus retenciones no se tocan: la
  -- línea corrige el crédito fiscal, no el comprobante. Su asiento es el contra-asiento del
  -- original, si ya existe; si no, NULL, y la conciliación la cuenta como cola.
  ajustes as (
    select x.id, x.dia_ajuste as invoice_date, x.tax_id, x.legal_name, x.supplier_kind,
           x.supplier_document_number, x.supplier_control_number, x.supplier_document_ref,
           'ajuste_periodo_anterior'::text as status,
           x.transaction_currency, x.fx_rate,
           -x.gravada,
           case when x.tax_is_recoverable then -x.iva_lleno else 0 end,
           case when x.tax_is_recoverable then 0 else -x.iva_lleno end,
           -x.exenta, -x.exonerada, -x.no_sujeta, -x.sin_clasificar,
           0::numeric, 0::numeric,
           -(x.sub_lleno + x.iva_lleno),
           x.tax_is_recoverable,
           (select e.reversed_by_entry_id from public.journal_entries e
             where e.id = x.journal_entry_id),
           x.dia_ajuste, false
      from lleno x
     where x.dia_ajuste between p_from and p_to
  ),
  notas as (
    select n.id, n.note_date,
           case when i.supplier_name_snapshot is not null then i.supplier_tax_id_snapshot
                else s.tax_id end as tax_id,
           coalesce(i.supplier_name_snapshot, s.legal_name) as legal_name, s.supplier_kind,
           n.supplier_document_number, n.supplier_control_number, n.supplier_document_ref,
           n.status, n.transaction_currency, n.fx_rate,
           case when n.status = 'annulled' then 0 else 1 end as factor,
           round(n.subtotal_amount * n.fx_rate, 2) as sub_func,
           round(n.tax_amount * n.fx_rate, 2) as iva_func,
           -- A2 (150600): la NC se reparte por el TRATAMIENTO de la línea de factura que devuelve.
           -- Lo exento, exonerado o no sujeto resta de su columna; una línea sin línea de origen
           -- sigue en gravadas, como antes; la nota sin líneas, entera en gravadas.
           o.exenta_n, o.exonerada_n, o.no_sujeta_n, o.sin_n,
           i.tax_is_recoverable, n.journal_entry_id, n.accounting_date
      from public.supplier_credit_notes n
      join public.suppliers s on s.id = n.supplier_id
      join public.supplier_invoices i on i.id = n.supplier_invoice_id
      cross join lateral (
        select round(coalesce(sum(cl.line_subtotal_transaction)
                              filter (where il.tax_treatment = 'exento'), 0) * n.fx_rate, 2) as exenta_n,
               round(coalesce(sum(cl.line_subtotal_transaction)
                              filter (where il.tax_treatment = 'exonerado'), 0) * n.fx_rate, 2)
                 as exonerada_n,
               round(coalesce(sum(cl.line_subtotal_transaction)
                              filter (where il.tax_treatment = 'no_sujeto'), 0) * n.fx_rate, 2)
                 as no_sujeta_n,
               round(coalesce(sum(cl.line_subtotal_transaction)
                              filter (where cl.supplier_invoice_line_id is not null
                                        and il.tax_treatment is null), 0) * n.fx_rate, 2) as sin_n
          from public.supplier_credit_note_lines cl
          left join public.supplier_invoice_lines il on il.id = cl.supplier_invoice_line_id
         where cl.supplier_credit_note_id = n.id
      ) o
     where n.company_id = p_company
       and n.status in ('posted', 'annulled')
       and i.fiscal_support
       and coalesce(n.accounting_date, n.note_date) between p_from and p_to
  )
  select * from facturas
  union all
  select * from ajustes
  union all
  select n.id, n.note_date, n.tax_id, n.legal_name, n.supplier_kind,
         n.supplier_document_number, n.supplier_control_number, n.supplier_document_ref,
         n.status, n.transaction_currency, n.fx_rate,
         -(n.sub_func - n.exenta_n - n.exonerada_n - n.no_sujeta_n - n.sin_n) * n.factor,
         case when n.tax_is_recoverable then -n.iva_func * n.factor else 0 end,
         case when n.tax_is_recoverable then 0 else -n.iva_func * n.factor end,
         -n.exenta_n * n.factor, -n.exonerada_n * n.factor, -n.no_sujeta_n * n.factor,
         -n.sin_n * n.factor, 0, 0,
         -(n.sub_func + n.iva_func) * n.factor,
         n.tax_is_recoverable, n.journal_entry_id,
         coalesce(n.accounting_date, n.note_date), n.accounting_date is not null
    from notas n
   order by 2, 6
$function$;

create or replace function platform.purchases_book_by_rate(p_company uuid, p_from date, p_to date)
returns table (
  invoice_id uuid, invoice_date date, supplier_tax_id text, supplier_name text,
  supplier_kind text, supplier_document_number text, supplier_control_number text,
  supplier_document_ref text, status text, transaction_currency text, fx_rate numeric,
  base_gravada numeric, iva_credito numeric, iva_al_costo numeric, base_exenta numeric,
  base_exonerada numeric, base_no_sujeta numeric, base_sin_clasificar numeric,
  retenido_iva numeric, retenido_islr numeric, total_amount numeric, tax_is_recoverable boolean,
  journal_entry_id uuid, booked_on date, received_late boolean,
  base_alicuota_general numeric, iva_alicuota_general numeric, alicuota_general numeric,
  base_alicuota_adicional numeric, iva_alicuota_adicional numeric, alicuota_adicional numeric,
  base_alicuota_reducida numeric, iva_alicuota_reducida numeric, alicuota_reducida numeric,
  base_gravada_sin_alicuota numeric, iva_sin_clasificar numeric
)
language sql
stable
set search_path = ''
as $$
  -- El renglón de `purchases_book` tal cual, más la base y el IVA por alícuota de sus líneas a la
  -- tasa del documento. Cada alícuota redondea su suma; el renglón redondea la suma entera: entre
  -- los dos puede quedar 1e-8. Ese residuo (si es menor que un céntimo) va a la alícuota MAYOR del
  -- renglón (A1). «Sin alícuota» y «sin clasificar» son lo que las líneas de verdad no explican:
  -- líneas sin categoría, una NC sin línea de origen, o una diferencia de un céntimo o más.
  select p.invoice_id, p.invoice_date, p.supplier_tax_id, p.supplier_name, p.supplier_kind,
         p.supplier_document_number, p.supplier_control_number, p.supplier_document_ref,
         p.status, p.transaction_currency, p.fx_rate, p.base_gravada, p.iva_credito,
         p.iva_al_costo, p.base_exenta, p.base_exonerada, p.base_no_sujeta,
         p.base_sin_clasificar, p.retenido_iva, p.retenido_islr, p.total_amount,
         p.tax_is_recoverable, p.journal_entry_id, p.booked_on, p.received_late,
         r.base_g + case when d.base_a_quien = 'g' then d.res_b else 0 end,
         r.iva_g + case when d.iva_a_quien = 'g' then d.res_i else 0 end, r.rate_g,
         r.base_a + case when d.base_a_quien = 'a' then d.res_b else 0 end,
         r.iva_a + case when d.iva_a_quien = 'a' then d.res_i else 0 end, r.rate_a,
         r.base_r + case when d.base_a_quien = 'r' then d.res_b else 0 end,
         r.iva_r + case when d.iva_a_quien = 'r' then d.res_i else 0 end, r.rate_r,
         r.base_x + case when d.base_a_quien = 'x' then d.res_b else 0 end,
         r.iva_x + case when d.iva_a_quien = 'x' then d.res_i else 0 end
    from platform.purchases_book(p_company, p_from, p_to) with ordinality as p
    cross join lateral (
      select exists (select 1 from public.supplier_credit_notes n where n.id = p.invoice_id)
               as es_nota
    ) t
    cross join lateral (
      select case when p.status = 'ajuste_periodo_anterior' then -1
                  when p.total_amount = 0 then 0
                  when t.es_nota then -1
                  else 1 end as factor
    ) k
    cross join lateral (
      select
        round(coalesce(sum(x.sub) filter (where x.cat = 'gravado_general'), 0) * p.fx_rate, 2)
          * k.factor as base_g,
        round(coalesce(sum(x.iva) filter (where x.cat = 'gravado_general'), 0) * p.fx_rate, 2)
          * k.factor as iva_g,
        max(x.rate) filter (where x.cat = 'gravado_general') as rate_g,
        round(coalesce(sum(x.sub) filter (where x.cat = 'gravado_adicional'), 0) * p.fx_rate, 2)
          * k.factor as base_a,
        round(coalesce(sum(x.iva) filter (where x.cat = 'gravado_adicional'), 0) * p.fx_rate, 2)
          * k.factor as iva_a,
        max(x.rate) filter (where x.cat = 'gravado_adicional') as rate_a,
        round(coalesce(sum(x.sub) filter (where x.cat = 'gravado_reducida'), 0) * p.fx_rate, 2)
          * k.factor as base_r,
        round(coalesce(sum(x.iva) filter (where x.cat = 'gravado_reducida'), 0) * p.fx_rate, 2)
          * k.factor as iva_r,
        max(x.rate) filter (where x.cat = 'gravado_reducida') as rate_r,
        -- Lo gravado sin categoría reconocida, y el IVA de lo que no está en las tres alícuotas.
        round(coalesce(sum(x.sub) filter (
                where x.trat = 'gravado'
                  and (x.cat is null
                       or x.cat not in ('gravado_general', 'gravado_adicional', 'gravado_reducida'))),
              0) * p.fx_rate, 2) * k.factor as base_x,
        round(coalesce(sum(x.iva) filter (
                where x.cat is null
                   or x.cat not in ('gravado_general', 'gravado_adicional', 'gravado_reducida')),
              0) * p.fx_rate, 2) * k.factor as iva_x
        from (
          select l.line_subtotal_transaction as sub, l.tax_amount as iva,
                 l.tax_category_snapshot as cat, l.tax_rate_snapshot as rate,
                 l.tax_treatment as trat
            from public.supplier_invoice_lines l
           where not t.es_nota and l.supplier_invoice_id = p.invoice_id
          union all
          -- La NC toma la categoría y el tratamiento de la línea que devuelve; sin línea de
          -- origen, el libro la lleva a gravadas, y aquí queda «sin alícuota».
          select cl.line_subtotal_transaction, cl.tax_amount, il.tax_category_snapshot,
                 il.tax_rate_snapshot,
                 coalesce(il.tax_treatment,
                          case when cl.supplier_invoice_line_id is null then 'gravado' end)
            from public.supplier_credit_note_lines cl
            left join public.supplier_invoice_lines il on il.id = cl.supplier_invoice_line_id
           where t.es_nota and cl.supplier_credit_note_id = p.invoice_id
        ) x
    ) r
    cross join lateral (
      select p.base_gravada - (r.base_g + r.base_a + r.base_r + r.base_x) as res_b,
             (p.iva_credito + p.iva_al_costo) - (r.iva_g + r.iva_a + r.iva_r + r.iva_x) as res_i,
             -- La alícuota mayor presente en el renglón, si la hay.
             case
               when greatest(coalesce(r.rate_g, -1), coalesce(r.rate_a, -1),
                             coalesce(r.rate_r, -1)) < 0 then 'x'
               when coalesce(r.rate_a, -1) >= greatest(coalesce(r.rate_g, -1),
                                                      coalesce(r.rate_r, -1)) then 'a'
               when coalesce(r.rate_g, -1) >= coalesce(r.rate_r, -1) then 'g'
               else 'r'
             end as mayor
    ) e
    cross join lateral (
      select e.res_b, e.res_i,
             case when abs(e.res_b) <= 0.01 then e.mayor else 'x' end as base_a_quien,
             case when abs(e.res_i) <= 0.01 then e.mayor else 'x' end as iva_a_quien
    ) d
   order by p.ordinality
$$;

-- ── 5. El invariante: nada nuevo con fracción de céntimo ────────────────────
-- El corte es el acta de la regularización (`accounting.cent_regularized`). Lo que la propia
-- regularización escribe nace en su mismo instante (now() de su transacción) y queda fuera por
-- el `>`; todo lo posterior cuenta. Sin acta, cuenta TODO: una empresa nueva nace al céntimo, y
-- una vieja sin regularizar sale en rojo hasta que la reparación corra, que es lo que se quiere.
-- La única línea con fracción que el enunciado admite es la REVERSA EXACTA de un asiento
-- anterior al corte: revertir un asiento viejo tiene que deshacer sus mismos importes.
create or replace function platform.cent_gaps(p_company uuid)
returns table (kind text, id uuid, amount numeric)
language sql
stable
set search_path = ''
as $$
  with corte as (
    select max(a.occurred_at) as t from public.audit_events a
     where a.company_id = p_company and a.event_type = 'accounting.cent_regularized'
  )
  select 'journal_line'::text, jl.id, greatest(jl.functional_debit, jl.functional_credit)
    from public.journal_lines jl
    join public.journal_entries e on e.id = jl.entry_id and e.company_id = p_company
    cross join corte
   where jl.company_id = p_company
     and (jl.functional_debit <> round(jl.functional_debit, 2)
          or jl.functional_credit <> round(jl.functional_credit, 2))
     and (corte.t is null or e.created_at > corte.t)
     and not exists (select 1 from public.journal_entries o
                      where o.company_id = p_company and o.id = e.is_reversal_of
                        and corte.t is not null and o.created_at <= corte.t)
  union all
  select 'inventory_move', m.id, m.functional_amount
    from public.inventory_moves m cross join corte
   where m.company_id = p_company
     and m.functional_amount <> round(m.functional_amount, 2)
     and (corte.t is null or m.created_at > corte.t)
  union all
  select 'stock_balance', b.id, b.value
    from public.stock_balances b
   where b.company_id = p_company and b.value <> round(b.value, 2)
  union all
  select 'account_balance', s.account_id, s.saldo
    from (select jl.account_id, sum(jl.functional_debit - jl.functional_credit) as saldo
            from public.journal_lines jl
            join public.journal_entries e on e.id = jl.entry_id
           where jl.company_id = p_company and e.status in ('posted', 'reversed')
           group by jl.account_id) s
   where s.saldo <> round(s.saldo, 2)
$$;
comment on function platform.cent_gaps(uuid) is
  'INVARIANTE (ADR-0075 §7): ninguna línea de asiento ni movimiento de kardex posterior a la '
  'regularización del céntimo con más de dos decimales (salvo la reversa exacta de un asiento '
  'anterior al corte), ningún valor de posición y ningún saldo de cuenta con fracción de céntimo. '
  'La respuesta correcta es CERO filas.';
revoke execute on function platform.cent_gaps(uuid) from public;
grant execute on function platform.cent_gaps(uuid) to authenticated, ladino_api;

-- ── 6. La regularización al corte: preparar (aquí) · postear (dominio) · cerrar (aquí) ──
-- El patrón de ADR-0070: ninguna función SQL postea asientos. `prepare` escribe los movimientos
-- del kardex y el asiento en BORRADOR; `repairCents` (packages/domain) lo postea; `finish`
-- comprueba el invariante kardex = mayor y deja el acta. Todo en la transacción del llamante.
--   · kardex: cada posición con fracción recibe una revalorización de cantidad 0 por
--     round_cents(valor) − valor (o −valor entero si la cantidad es 0: el residuo de una
--     posición vacía va todo a redondeo). Append-only: no se toca ningún movimiento;
--   · mayor: cada cuenta con saldo fraccionario recibe round_cents(saldo) − saldo, salvo la de
--     inventario, que recibe exactamente lo del kardex más la fracción de céntimo de
--     `inventory_ledger_gap` (la que solo un redondeo pudo producir) — así el invariante
--     kardex = mayor queda como estaba;
--   · todo contra «Diferencias por redondeo». La segunda vez no encuentra nada (idempotente).
create or replace function platform.cent_regularization_prepare(
  p_company uuid, p_ensayo boolean default false)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_moneda text;
  v_reg uuid := gen_random_uuid();
  v_fecha date := (now() at time zone 'America/Caracas')::date;
  v_inv uuid;
  v_red uuid;
  v_k record;
  v_l record;
  v_k_total numeric := 0;
  v_gap numeric;
  v_adj_inv numeric;
  v_entry uuid;
  v_linea int := 0;
  v_suma numeric := 0;
  v_kardex jsonb;
  v_mayor jsonb;
  v_vacio constant jsonb := jsonb_build_array();
begin
  select c.tenant_id, c.functional_currency_code into v_tenant, v_moneda
    from public.companies c where c.id = p_company;
  if v_tenant is null then
    raise exception 'la empresa % no existe', p_company using errcode = '23503';
  end if;
  select s.account_id into v_inv from public.company_account_settings s
   where s.company_id = p_company and s.purpose = 'inventory_general' and s.effective_to is null
   order by s.effective_from desc limit 1;
  select s.account_id into v_red from public.company_account_settings s
   where s.company_id = p_company and s.purpose = 'rounding_difference' and s.effective_to is null
   order by s.effective_from desc limit 1;

  drop table if exists _cent_k;
  drop table if exists _cent_l;
  create temp table _cent_k on commit drop as
    select b.id, b.warehouse_id, b.product_id, b.lot_id, b.quantity, b.value,
           case when b.quantity = 0 then -b.value else round(b.value, 2) - b.value end as adj
      from public.stock_balances b
     where b.company_id = p_company and b.value <> round(b.value, 2);
  select coalesce(sum(adj), 0) into v_k_total from _cent_k;
  select g.diferencia into v_gap from platform.inventory_ledger_gap(p_company) g;
  v_gap := coalesce(v_gap, 0);

  create temp table _cent_l on commit drop as
    select jl.account_id, sum(jl.functional_debit - jl.functional_credit) as saldo,
           round(sum(jl.functional_debit - jl.functional_credit), 2)
             - sum(jl.functional_debit - jl.functional_credit) as adj
      from public.journal_lines jl
      join public.journal_entries e on e.id = jl.entry_id
     where jl.company_id = p_company and e.status in ('posted', 'reversed')
       and jl.account_id is distinct from v_inv and jl.account_id is distinct from v_red
     group by jl.account_id
    having sum(jl.functional_debit - jl.functional_credit)
           <> round(sum(jl.functional_debit - jl.functional_credit), 2);
  v_adj_inv := v_k_total + (v_gap - round(v_gap, 2));

  if not exists (select 1 from _cent_k) and not exists (select 1 from _cent_l)
     and v_adj_inv = 0 then
    return jsonb_build_object('company_id', p_company, 'regularized', false);
  end if;
  if (exists (select 1 from _cent_k) or v_adj_inv <> 0) and v_inv is null then
    raise exception 'la empresa % tiene kardex con fracción y no tiene cuenta de inventario: configúrala y vuelve a correr',
      p_company using errcode = 'LAD41';
  end if;
  if v_red is null then
    raise exception 'la empresa % no tiene «Diferencias por redondeo» (rounding_difference): asígnala y vuelve a correr',
      p_company using errcode = 'LAD41';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('stock_balance_id', k.id, 'warehouse_id',
           k.warehouse_id, 'product_id', k.product_id, 'lot_id', k.lot_id,
           'quantity', k.quantity::text, 'value', k.value::text, 'adjustment', k.adj::text)
           order by k.id), v_vacio) into v_kardex from _cent_k k;
  select coalesce(jsonb_agg(jsonb_build_object('account_id', l.account_id,
           'balance', l.saldo::text, 'adjustment', l.adj::text) order by l.account_id), v_vacio)
    into v_mayor from _cent_l l;
  if p_ensayo then
    return jsonb_build_object('company_id', p_company, 'regularized', false, 'dry_run', true,
                              'kardex', v_kardex, 'ledger', v_mayor,
                              'inventory_adjustment', v_adj_inv::text,
                              'inventory_ledger_gap', v_gap::text);
  end if;

  -- El kardex: una revalorización por posición, con la regularización como documento de origen.
  for v_k in select * from _cent_k where adj <> 0 order by id loop
    insert into public.inventory_moves
      (tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, rounding_policy_id,
       occurred_at, reason, source_document_id)
    values (v_tenant, p_company, v_k.warehouse_id, v_k.product_id, v_k.lot_id, 'revaluacion', 0,
            v_k.adj, v_moneda, 1, v_k.adj, v_moneda, 'identidad', now(),
            'ledger:cents:2:HALF_UP', now(),
            'Regularización del céntimo al corte (ADR-0075 §7)', v_reg);
  end loop;

  -- El asiento, en BORRADOR: del kardex y del mayor contra «Diferencias por redondeo».
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
     description, memo, rules_version)
  values (v_tenant, p_company, platform.period_for_date(p_company, v_fecha), v_fecha,
          'inventory_move', v_reg, 'stock.cent_regularized',
          'Regularización del céntimo al corte (ADR-0075 §7)',
          'Asiento del sistema. Lleva a «Diferencias por redondeo» la fracción de céntimo que el '
          || 'kardex y el mayor arrastraban de antes de llevar todo al céntimo. No mueve dinero.',
          coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-repair'))
  returning id into v_entry;

  for v_l in
    select x.account_id, x.adj, x.d from (
      select l.account_id, l.adj, 'Fracción de céntimo del saldo'::text as d from _cent_l l
      union all
      select v_inv, v_adj_inv, 'Fracción de céntimo del inventario (kardex)' where v_adj_inv <> 0
    ) x order by x.account_id
  loop
    v_linea := v_linea + 1;
    v_suma := v_suma + v_l.adj;
    insert into public.journal_lines
      (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
       description)
    values (v_tenant, p_company, v_entry, v_linea, v_l.account_id,
            greatest(v_l.adj, 0), greatest(-v_l.adj, 0), abs(v_l.adj), v_moneda, 1, abs(v_l.adj),
            v_moneda, 'identidad', now(), greatest(v_l.adj, 0), greatest(-v_l.adj, 0), v_l.d);
  end loop;
  if v_suma <> 0 then
    v_linea := v_linea + 1;
    insert into public.journal_lines
      (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
       description)
    values (v_tenant, p_company, v_entry, v_linea, v_red,
            greatest(-v_suma, 0), greatest(v_suma, 0), abs(v_suma), v_moneda, 1, abs(v_suma),
            v_moneda, 'identidad', now(), greatest(-v_suma, 0), greatest(v_suma, 0),
            'Diferencias por redondeo (ADR-0075 §7)');
  end if;
  if v_linea < 2 then
    raise exception 'regularización de %: el asiento no tiene dos líneas (ajuste %)', p_company, v_suma
      using errcode = 'LAD41';
  end if;

  return jsonb_build_object('company_id', p_company, 'regularized', true,
                            'regularization_id', v_reg, 'entry_id', v_entry,
                            'posting_date', v_fecha, 'kardex', v_kardex, 'ledger', v_mayor,
                            'inventory_adjustment', v_adj_inv::text,
                            'rounding_line', (-v_suma)::text,
                            'inventory_ledger_gap_before', v_gap::text);
end;
$$;
comment on function platform.cent_regularization_prepare(uuid, boolean) is
  'ADR-0075 §7: prepara la regularización del céntimo de una empresa (kardex + asiento en '
  'borrador). Idempotente; con ensayo solo cuenta. La postea repairCents (dominio) y la cierra '
  'cent_regularization_finish. Sin GRANT: la corre el dueño de la base, después del pull.';
revoke execute on function platform.cent_regularization_prepare(uuid, boolean) from public;

create or replace function platform.cent_regularization_finish(p_prep jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_company uuid := (p_prep ->> 'company_id')::uuid;
  v_entry uuid := (p_prep ->> 'entry_id')::uuid;
  v_antes numeric := (p_prep ->> 'inventory_ledger_gap_before')::numeric;
  v_despues numeric;
  v_tenant uuid;
begin
  if not coalesce((p_prep ->> 'regularized')::boolean, false) then
    return p_prep;
  end if;
  if not exists (select 1 from public.journal_entries e
                  where e.id = v_entry and e.company_id = v_company and e.status = 'posted') then
    raise exception 'regularización de %: el asiento % no está posteado', v_company, v_entry
      using errcode = 'LAD41';
  end if;
  -- La comprobación que no se delega: kardex = mayor no se movió más que su fracción de céntimo.
  select g.diferencia into v_despues from platform.inventory_ledger_gap(v_company) g;
  if coalesce(v_despues, 0) <> round(v_antes, 2) then
    raise exception 'regularización de %: inventory_ledger_gap pasó de % a %', v_company,
      v_antes, v_despues using errcode = 'LAD41';
  end if;
  select c.tenant_id into v_tenant from public.companies c where c.id = v_company;
  -- El acta es también el CORTE de cent_gaps: nace en el mismo now() que lo regularizado.
  insert into public.audit_events
    (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
     actor_type, occurred_at, rules_version, payload)
  values (v_tenant, v_company, 'company', v_company, 'accounting.cent_regularized', 'system',
          now(), coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-repair'),
          p_prep || jsonb_build_object('adr', 'ADR-0075 §7',
                                       'inventory_ledger_gap_after', coalesce(v_despues, 0)::text));
  return p_prep || jsonb_build_object('inventory_ledger_gap_after', coalesce(v_despues, 0)::text);
end;
$$;
comment on function platform.cent_regularization_finish(jsonb) is
  'ADR-0075 §7: cierra la regularización del céntimo — exige el asiento posteado, comprueba '
  'inventory_ledger_gap y deja el acta accounting.cent_regularized (el corte de cent_gaps).';
revoke execute on function platform.cent_regularization_finish(jsonb) from public;

-- ── Reversibilidad (con datos vivos) ────────────────────────────────────────
-- · round_cents, cent_gaps y las dos de la regularización: drop function; no guardan estado.
-- · apply_inventory_move y los dos libros: create or replace con las definiciones de
--   20260826222915 §9 y 20260928170400 §1-§2. El oráculo corre en INSERT: revertirlo no invalida
--   los movimientos ya escritos al céntimo, solo cambia lo que acepta en adelante (y con la
--   tolerancia vieja, a 8 decimales, la TS nueva fallaría: se revierte junto con el código).
-- · El libro de compras revertido vuelve a sus 8 decimales; los libros generados mientras tanto
--   (fiscal_book_runs, append-only) quedan con el hash que tenían.
-- · La cuenta 5.1.10 y su papel: quedan (un plan de cuentas no se poda con asientos encima).
-- · Las regularizaciones ya corridas: asientos posteados y kardex append-only; se deshacen con su
--   reversa y una revalorización de signo contrario, nunca con DELETE.

-- =============================================================================
-- Ladino — EL DIFERENCIAL SE RECONOCE AL PAGAR, Y LO PAGADO CIERRA EN CERO
-- (ADR-0075 §1-4; E-05, D-02, D-07, H-02, F-02, G-12, F-15)
--
-- Módulo: ventas · compras · contabilidad. Rigor máximo (dinero, con datos vivos).
-- Spec:   MONEY_AND_ROUNDING_SPEC.md · ADR-0047 · ADR-0058 (enmendado) · ADR-0063.
-- Reversible: SÍ para el esquema, con datos vivos — ver al final. Los pagos y asientos que se
--   escriban con las columnas y plantillas nuevas son append-only: no se «desescriben»; se
--   corrigen con su reversa.
-- HOMOLOGATION_IMPACT: YES — el IVA en Bs de la factura pasa a ser alícuota × base en Bs por
--   línea (lo calcula el dominio; aquí vive el invariante que lo vigila). Esta migración no
--   toca ningún documento emitido (regla 1).
--
-- Qué cambia:
--   1. `payments.settled_transaction_amount`: lo que el cobro saldó EN LA MONEDA DEL DOCUMENTO,
--      congelado al cobrar (F-02, G-12). Lo escribe `registerPayment`. La función de saldo
--      (`document_balance_transaction`, de la familia «moneda B», migración 180000) es quien
--      debe leerlo: aquí NO se redefine.
--   2. `supplier_payments.settled_amount` / `settled_currency` / `exchange_difference`: el pago
--      cruzado (D-02) y el diferencial al pagar (D-07, H-02). La fila del pago sigue en la moneda
--      del DINERO (la de la cuenta de la que sale: LAD67 no cambia); lo saldado va en la moneda
--      de la factura.
--   3. `platform.supplier_invoice_balance`, create or replace sobre la VIVA (20260917130000 §3):
--      única diferencia, resta `coalesce(settled_amount, net_amount)`.
--   4. Plantillas: `payment_made` debita la CxP por lo que CANCELA (a la tasa de la factura) y
--      lleva la diferencia con lo que salió a pérdida o ganancia en diferencial cambiario;
--      `ar.retention_applied` lleva el céntimo del cierre a «Diferencias por redondeo».
--   5. Las cuentas de diferencial (papeles `exchange_gain` / `exchange_loss`, 4.1.02 y 5.1.02 de
--      ve_basico desde la migración 20260827233538) en los planes que no las tengan, con acta.
--   6. `platform.settlement_ledger_open`: lo que el mayor todavía le carga a un documento en
--      cuentas por cobrar (o por pagar). La usan el cobro/pago que cierra y el invariante.
--   7. Dos invariantes: `platform.fiscal_amount_gaps` (E-05) y `platform.settled_ledger_gaps`
--      (documento saldado ⇒ sin residuo en el mayor). Cada uno con su corte en el enunciado
--      (`platform.invariant_cutoffs`), sin lista de perdones.
-- =============================================================================

-- ── 1. Lo saldado por un cobro, en la moneda del documento ───────────────────
-- Nullable y sin default: los cobros anteriores no lo tienen y NO se rellenan (append-only; y
-- rellenarlos sería recalcular con la tasa de hoy lo que F-02 dice que no se recalcule).
alter table public.payments
  add column settled_transaction_amount numeric(24,8);
alter table public.payments
  add constraint payments_settled_chk
  check (settled_transaction_amount is null or settled_transaction_amount > 0);
comment on column public.payments.settled_transaction_amount is
  'Lo que este cobro saldó EN LA MONEDA DEL DOCUMENTO, congelado al cobrar (ADR-0075 §4, F-02): '
  'una tasa cargada después no lo cambia. El cobro que cierra guarda exactamente lo que faltaba. '
  'NULL en los cobros anteriores a la migración 20261003170000.';

-- ── 2. El pago a proveedor: lo saldado en la moneda de la factura y su diferencial ──
alter table public.supplier_payments
  add column settled_amount numeric(24,8),
  add column settled_currency text references public.currencies(code),
  add column exchange_difference numeric(24,8) not null default 0;
alter table public.supplier_payments
  add constraint supplier_payments_settled_chk
  check ((settled_amount is null) = (settled_currency is null)
         and (settled_amount is null or settled_amount > 0));
comment on column public.supplier_payments.settled_amount is
  'Lo que este pago cancela de la factura, EN LA MONEDA DE LA FACTURA (ADR-0075 §3). La fila '
  'del pago (gross/net, transaction_currency) va en la moneda del dinero que salió. NULL en los '
  'pagos anteriores a la migración 20261003170000, que solo se admitían en la moneda de la '
  'factura: para ellos lo saldado es net_amount.';
comment on column public.supplier_payments.exchange_difference is
  'Diferencial cambiario reconocido AL PAGAR, en moneda funcional (ADR-0075 §4): lo que salió '
  '(functional_amount) − lo que se canceló de la cuenta por pagar a la tasa de la factura. '
  'Positivo = pérdida; negativo = ganancia. Incluye el céntimo del pago que cierra.';

-- ── 3. El saldo de la factura de compra resta lo SALDADO ────────────────────
-- Parte de la definición VIVA (20260917130000 §3; ninguna migración posterior la redefine).
-- Sigue en SQL y sigue siendo una sola expresión.
create or replace function platform.supplier_invoice_balance(p_company uuid, p_invoice uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select i.total_amount
         - round(coalesce(i.retention_total, 0) / nullif(i.fx_rate, 0),
                 platform.currency_minor_units(i.transaction_currency))
         - coalesce((select sum(coalesce(p.settled_amount, p.net_amount))
                       from public.supplier_payments p
                      where p.supplier_invoice_id = i.id), 0)
         - coalesce((select sum(n.total_amount) from public.supplier_credit_notes n
                      where n.supplier_invoice_id = i.id and n.status = 'posted'), 0)
    from public.supplier_invoices i
   where i.id = p_invoice and i.company_id = p_company and i.status in ('posted', 'paid')
$$;
comment on function platform.supplier_invoice_balance(uuid, uuid) is
  'Lo que se le debe al PROVEEDOR por esta factura, en la moneda de la factura: total − lo '
  'retenido (que se le debe al fisco desde el abono en cuenta, PA SNAT/2025/000054) − lo saldado '
  'por cada pago (settled_amount; en los pagos anteriores al pago cruzado, net_amount) − notas '
  'de crédito recibidas (ADR-0065 §3, migración 68; ADR-0075 §3).';

-- ── 4. Las plantillas ────────────────────────────────────────────────────────
do $$
declare
  v_pago uuid;
  v_ret  uuid;
begin
  select id into v_pago from public.journal_template_preset_entries
   where preset_code = 've_basico' and source_kind = 'payment_made'
     and source_event = 'ap.payment_made';
  select id into v_ret from public.journal_template_preset_entries
   where preset_code = 've_basico' and source_kind = 'payment_received'
     and source_event = 'ar.retention_applied';
  if v_pago is null or v_ret is null then
    raise exception 'LAD83: falta en el preset ve_basico un hecho que esta migración corrige'
      using errcode = 'LAD83';
  end if;

  update public.journal_template_preset_lines
     set amount_source = 'total',
         description = 'Se cancela la deuda con el proveedor a la tasa con que se registró'
   where entry_id = v_pago and account_purpose = 'ap_general' and amount_source = 'net_amount';
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  select v_pago, (select max(line_number) from public.journal_template_preset_lines
                   where entry_id = v_pago) + n.orden,
         n.purpose, 'exchange_difference', n.side, n.cond, n.descr
    from (values
      (1, 'exchange_loss', 'debit',  'if_positive',
       'Salió más de lo que pesaba la deuda: pérdida en diferencial cambiario'),
      (2, 'exchange_gain', 'credit', 'if_negative',
       'Salió menos de lo que pesaba la deuda: ganancia en diferencial cambiario')
    ) as n(orden, purpose, side, cond, descr)
   where not exists (select 1 from public.journal_template_preset_lines l
                      where l.entry_id = v_pago and l.amount_source = 'exchange_difference');

  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  select v_ret, (select max(line_number) from public.journal_template_preset_lines
                  where entry_id = v_ret) + n.orden,
         'rounding_difference', 'exchange_difference', n.side, n.cond, n.descr
    from (values
      (1, 'credit', 'if_positive',
       'El céntimo del abono que cierra la factura: a diferencias por redondeo'),
      (2, 'debit',  'if_negative',
       'El céntimo del abono que cierra la factura: a diferencias por redondeo')
    ) as n(orden, side, cond, descr)
   where not exists (select 1 from public.journal_template_preset_lines l
                      where l.entry_id = v_ret and l.amount_source = 'exchange_difference');
end $$;

-- Las empresas que ya importaron las plantillas. NO se reescribe la plantilla entera (una
-- empresa pudo ajustar la suya): se corrige la línea de la CxP si sigue como nació y se añaden
-- las del diferencial si no las tiene. Con acta.
do $$
declare
  v_t record;
  v_cambio boolean;
  v_n integer;
begin
  for v_t in
    select t.id, t.tenant_id, t.company_id, t.source_kind, t.source_event
      from public.journal_templates t
     where t.effective_to is null
       and ((t.source_kind = 'payment_made' and t.source_event = 'ap.payment_made')
         or (t.source_kind = 'payment_received' and t.source_event = 'ar.retention_applied'))
  loop
    v_cambio := false;
    if v_t.source_kind = 'payment_made' then
      update public.journal_template_lines
         set amount_source = 'total',
             description = 'Se cancela la deuda con el proveedor a la tasa con que se registró'
       where template_id = v_t.id and account_purpose = 'ap_general'
         and amount_source = 'net_amount';
      get diagnostics v_n = row_count;
      v_cambio := v_n > 0;
    end if;
    if not exists (select 1 from public.journal_template_lines l
                    where l.template_id = v_t.id and l.amount_source = 'exchange_difference') then
      select coalesce(max(line_number), 0) into v_n
        from public.journal_template_lines where template_id = v_t.id;
      if v_t.source_kind = 'payment_made' then
        insert into public.journal_template_lines
          (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
           side, condition_kind, description)
        values
          (v_t.tenant_id, v_t.company_id, v_t.id, v_n + 1, 'exchange_loss',
           'exchange_difference', 'debit', 'if_positive',
           'Salió más de lo que pesaba la deuda: pérdida en diferencial cambiario'),
          (v_t.tenant_id, v_t.company_id, v_t.id, v_n + 2, 'exchange_gain',
           'exchange_difference', 'credit', 'if_negative',
           'Salió menos de lo que pesaba la deuda: ganancia en diferencial cambiario');
      else
        insert into public.journal_template_lines
          (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
           side, condition_kind, description)
        values
          (v_t.tenant_id, v_t.company_id, v_t.id, v_n + 1, 'rounding_difference',
           'exchange_difference', 'credit', 'if_positive',
           'El céntimo del abono que cierra la factura: a diferencias por redondeo'),
          (v_t.tenant_id, v_t.company_id, v_t.id, v_n + 2, 'rounding_difference',
           'exchange_difference', 'debit', 'if_negative',
           'El céntimo del abono que cierra la factura: a diferencias por redondeo');
      end if;
      v_cambio := true;
    end if;
    if v_cambio then
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      values (v_t.tenant_id, v_t.company_id, 'company', v_t.company_id,
              'accounting.templates_imported', 'system', now(), 'db-migration',
              jsonb_build_object('origin', 'migration_20261003170000', 'preset_code', 've_basico',
                                 'facts', v_t.source_event,
                                 'motivo', 'el diferencial se reconoce al pagar (ADR-0075 §4)'));
    end if;
  end loop;
end $$;

-- ── 5. Las cuentas de diferencial en los planes que no las tengan ────────────
-- ve_basico las trae desde el principio (4.1.02 «Ganancia cambiaria», 5.1.02 «Pérdida
-- cambiaria»). Una empresa con plan importado y sin el papel recibe la cuenta con el código de
-- ve_basico si está libre; si el código lo ocupa otra cuenta NO se pisa: queda sin el papel y el
-- generador encola diciendo cuál falta. Los códigos los confirma el contador (PENDIENTES_ASESOR).
do $$
declare
  v_c record;
  v_p record;
  v_padre uuid;
  v_cuenta uuid;
begin
  for v_c in
    select distinct a.company_id, a.tenant_id from public.accounts a
  loop
    for v_p in
      select * from (values
        ('exchange_gain', '4.1.02', 'Ganancia en diferencial cambiario', '4.1', 'ingreso', 'acreedora'),
        ('exchange_loss', '5.1.02', 'Pérdida en diferencial cambiario',  '5.1', 'gasto',   'deudora')
      ) as x(purpose, code, name, parent_code, kind, nature)
    loop
      continue when exists (select 1 from public.company_account_settings s
                             where s.company_id = v_c.company_id and s.purpose = v_p.purpose);
      select id into v_padre from public.accounts
       where company_id = v_c.company_id and code = v_p.parent_code;
      continue when v_padre is null;
      continue when exists (select 1 from public.accounts
                             where company_id = v_c.company_id and code = v_p.code);
      insert into public.accounts
        (tenant_id, company_id, code, name, parent_id, kind, nature, rules_version)
      values (v_c.tenant_id, v_c.company_id, v_p.code, v_p.name, v_padre, v_p.kind, v_p.nature,
              'db-migration')
      returning id into v_cuenta;
      insert into public.company_account_settings
        (tenant_id, company_id, purpose, account_id, effective_from)
      values (v_c.tenant_id, v_c.company_id, v_p.purpose, v_cuenta, '-infinity');
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      values (v_c.tenant_id, v_c.company_id, 'company', v_c.company_id,
              'accounting.account_added', 'system', now(), 'db-migration',
              jsonb_build_object('origin', 'migration_20261003170000', 'code', v_p.code,
                                 'purpose', v_p.purpose, 'account_id', v_cuenta,
                                 'adr', 'ADR-0075 §4'));
    end loop;
  end loop;
end $$;

-- ── 6. Lo que el mayor todavía le carga a un documento ───────────────────────
-- Suma, en las cuentas que la empresa tiene (o tuvo) como cuentas por cobrar —o por pagar—, las
-- líneas de los asientos del documento y de todo lo que lo salda (cobros, pagos, notas de crédito
-- de proveedor), más las reversas de esos asientos. NULL si alguna de esas piezas no tiene
-- asiento todavía (está en la cola): ahí el mayor no puede responder y quien pregunta decide.
create or replace function platform.settlement_ledger_open(
  p_company uuid, p_side text, p_document uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  with fuentes as (
    select d.journal_entry_id as entry_id
      from public.documents d
     where p_side = 'ar' and d.company_id = p_company and d.id = p_document
    union all
    select p.journal_entry_id
      from public.payments p
     where p_side = 'ar' and p.company_id = p_company and p.document_id = p_document
    union all
    select i.journal_entry_id
      from public.supplier_invoices i
     where p_side = 'ap' and i.company_id = p_company and i.id = p_document
    union all
    select p.journal_entry_id
      from public.supplier_payments p
     where p_side = 'ap' and p.company_id = p_company and p.supplier_invoice_id = p_document
    union all
    select n.journal_entry_id
      from public.supplier_credit_notes n
     where p_side = 'ap' and n.company_id = p_company and n.supplier_invoice_id = p_document
       and n.status = 'posted'
  )
  select case
           when p_side not in ('ar', 'ap') then null
           when not exists (select 1 from fuentes) then null
           when exists (select 1 from fuentes where entry_id is null) then null
           else (
             select coalesce(sum(case when p_side = 'ar'
                                      then l.debit_amount - l.credit_amount
                                      else l.credit_amount - l.debit_amount end), 0)
               from public.journal_lines l
               join public.journal_entries e on e.id = l.entry_id
              where l.company_id = p_company
                and e.status = 'posted'
                and (e.id in (select entry_id from fuentes)
                     or e.is_reversal_of in (select entry_id from fuentes))
                and l.account_id in (
                      select s.account_id from public.company_account_settings s
                       where s.company_id = p_company
                         and s.purpose = case p_side when 'ar' then 'ar_general'
                                                     else 'ap_general' end))
         end
$$;
comment on function platform.settlement_ledger_open(uuid, text, uuid) is
  'Lo que el mayor todavía le carga a un documento en cuentas por cobrar (''ar'') o por pagar '
  '(''ap''): su asiento, los de sus cobros o pagos y notas, y sus reversas. NULL si alguna pieza '
  'no tiene asiento (cola). La usan el cobro/pago que cierra (ADR-0075 §4: cierra en cero '
  'exacto) y el invariante settled_ledger_gaps.';
revoke all on function platform.settlement_ledger_open(uuid, text, uuid) from public;
grant execute on function platform.settlement_ledger_open(uuid, text, uuid)
  to authenticated, ladino_api;

-- ── 7. Los invariantes, con su corte en el enunciado ─────────────────────────
insert into platform.invariant_cutoffs (invariant, reason) values
  ('fiscal_amount_gaps',
   'Antes de esta migración el IVA en Bs de un documento en divisa era la conversión del IVA ya '
   'redondeado en divisa (E-05). Un documento fiscal emitido no se edita (regla 1): los '
   'anteriores quedan como se emitieron y el asesor decide si se regularizan (PENDIENTES_ASESOR).'),
  ('settled_ledger_gaps',
   'Antes de esta migración el pago a proveedor no reconocía diferencial (H-02) y el cobro que '
   'cerraba dejaba ±0,01 en cuentas por cobrar (F-15). Los documentos saldados antes del corte '
   'conservan su residuo en el mayor hasta que el contador lo regularice (PENDIENTES_ASESOR).');

create or replace function platform.fiscal_amount_gaps(p_company uuid)
returns table (document_id uuid, problem text, expected numeric, found numeric)
language sql
stable
set search_path = ''
as $$
  -- ENUNCIADO: en todo documento fiscal (factura, nota de crédito, nota de débito) emitido
  -- desde el corte (platform.invariant_cutoffs):
  --   (1) en cada línea, el IVA en moneda funcional es round(base funcional × alícuota, 2) —y
  --       por tanto, por alícuota, Σ IVA = Σ round(base × alícuota, 2)—;
  --   (2) base, IVA y total del pie son la SUMA de sus líneas;
  --   (3) el total en la moneda del documento, llevado a funcional con la tasa del documento,
  --       no se aparta del total funcional más que el redondeo por línea: media unidad mínima de
  --       la moneda del documento a la tasa, más un céntimo funcional, por línea.
  with docs as (
    select d.id, d.subtotal_amount, d.tax_amount, d.total_amount,
           d.amount_transaction_currency, d.fx_rate, d.transaction_currency
      from public.documents d
     where d.company_id = p_company
       and d.kind in ('invoice', 'credit_note', 'debit_note')
       and d.status in ('issued', 'paid', 'annulled')
       and d.created_at >= (select c.since from platform.invariant_cutoffs c
                             where c.invariant = 'fiscal_amount_gaps')
  ),
  lineas as (
    select l.document_id,
           l.line_subtotal_functional as base,
           l.line_total_functional - l.line_subtotal_functional as iva,
           round(l.line_subtotal_functional * l.tax_rate_snapshot, 2) as iva_esperado,
           l.line_total_functional as total
      from public.document_lines l
     where l.company_id = p_company and l.document_id in (select id from docs)
  ),
  pie as (
    select document_id, sum(base) as base, sum(iva) as iva, sum(total) as total,
           count(*) as n
      from lineas group by document_id
  )
  select l.document_id, 'line_tax_is_not_rate_times_base', l.iva_esperado, l.iva
    from lineas l
   where l.iva <> l.iva_esperado
  union all
  select d.id, 'subtotal_is_not_the_sum_of_lines', p.base, d.subtotal_amount
    from docs d join pie p on p.document_id = d.id
   where d.subtotal_amount <> p.base
  union all
  select d.id, 'tax_is_not_the_sum_of_lines', p.iva, d.tax_amount
    from docs d join pie p on p.document_id = d.id
   where d.tax_amount <> p.iva
  union all
  select d.id, 'total_is_not_the_sum_of_lines', p.total, d.total_amount
    from docs d join pie p on p.document_id = d.id
   where d.total_amount <> p.total
  union all
  select d.id, 'conversion_beyond_line_rounding',
         round(d.amount_transaction_currency * d.fx_rate, 2), d.total_amount
    from docs d join pie p on p.document_id = d.id
   where abs(d.amount_transaction_currency * d.fx_rate - d.total_amount)
         > p.n * (0.5 * power(10::numeric,
                              -platform.currency_minor_units(d.transaction_currency))
                      * d.fx_rate + 0.01)
$$;
comment on function platform.fiscal_amount_gaps(uuid) is
  'INVARIANTE (ADR-0075 §1, E-05): en todo documento fiscal emitido desde el corte, el IVA '
  'funcional de cada línea es round(base funcional × alícuota, 2), el pie es la suma de las '
  'líneas, y el total en divisa a la tasa del documento no se aparta del total funcional más '
  'que el redondeo por línea. Cero filas.';
revoke all on function platform.fiscal_amount_gaps(uuid) from public;
grant execute on function platform.fiscal_amount_gaps(uuid) to authenticated, ladino_api;

create or replace function platform.settled_ledger_gaps(p_company uuid)
returns table (side text, document_id uuid, residual numeric)
language sql
stable
set search_path = ''
as $$
  -- ENUNCIADO: todo documento SALDADO (venta `paid`, factura de compra `paid`) cuyo último
  -- cobro o pago es posterior al corte (platform.invariant_cutoffs), y cuyas piezas tienen todas
  -- su asiento, no deja NADA en cuentas por cobrar (o por pagar) del mayor.
  select 'ar'::text, d.id, x.abierto
    from public.documents d
    cross join lateral (select platform.settlement_ledger_open(p_company, 'ar', d.id)
                               as abierto) x
   where d.company_id = p_company and d.status = 'paid'
     and (select max(p.created_at) from public.payments p where p.document_id = d.id)
         >= (select c.since from platform.invariant_cutoffs c
              where c.invariant = 'settled_ledger_gaps')
     and x.abierto is not null and x.abierto <> 0
  union all
  select 'ap'::text, i.id, x.abierto
    from public.supplier_invoices i
    cross join lateral (select platform.settlement_ledger_open(p_company, 'ap', i.id)
                               as abierto) x
   where i.company_id = p_company and i.status = 'paid'
     and (select max(p.created_at) from public.supplier_payments p
           where p.supplier_invoice_id = i.id)
         >= (select c.since from platform.invariant_cutoffs c
              where c.invariant = 'settled_ledger_gaps')
     and x.abierto is not null and x.abierto <> 0
$$;
comment on function platform.settled_ledger_gaps(uuid) is
  'INVARIANTE (ADR-0075 §4; F-15, H-02): ningún documento saldado desde el corte tiene residuo '
  'en cuentas por cobrar o por pagar del mayor. Cero filas.';
revoke all on function platform.settled_ledger_gaps(uuid) from public;
grant execute on function platform.settled_ledger_gaps(uuid) to authenticated, ladino_api;

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos)
--   · Las tres columnas nuevas se pueden soltar SOLO mientras ningún pago cruzado exista: en
--     cuanto un pago a proveedor en otra moneda se registre, `settled_amount` es el único sitio
--     donde vive lo que canceló, y soltarla descuadra `supplier_invoice_balance` de esa factura.
--     Lo mismo `payments.settled_transaction_amount` una vez que la función de saldo la lea.
--   · `supplier_invoice_balance` vuelve a la definición de 20260917130000 §3 con otra migración
--     (misma salvedad).
--   · Las líneas de plantilla añadidas se quitan con otra migración; los asientos ya posteados
--     con ellas no cambian (regla 2): se revierten con su reversa.
--   · Las cuentas añadidas a planes importados no se borran si ya tienen movimientos.
--   · Los invariantes y `settlement_ledger_open` son solo lectura: se sueltan sin efecto.
-- Ninguna migración posterior a esta (a la fecha: ninguna en el árbol) redefine
-- `supplier_invoice_balance`, `settlement_ledger_open`, `fiscal_amount_gaps` ni
-- `settled_ledger_gaps`.
-- =============================================================================

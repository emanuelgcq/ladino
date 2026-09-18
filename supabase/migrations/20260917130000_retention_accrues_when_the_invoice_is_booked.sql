-- =============================================================================
-- Ladino — migración 68 · LA RETENCIÓN NACE AL REGISTRAR LA FACTURA
--                         (ADR-0065 §3)
--
-- NORMA: PA SNAT/2025/000054 (G.O. 43.171 del 16/07/2025; vigente desde el
-- 01/08/2025; deroga la PA SNAT/2015/0049). La retención se practica AL PAGO O
-- AL ABONO EN CUENTA, LO QUE OCURRA PRIMERO. Registrar la factura del proveedor
-- como cuenta por pagar ES el abono en cuenta (criterio confirmado por el dueño
-- con su asesoría, 2026-09-17).
--
-- Antes: la retención se calculaba al registrar la factura —con la regla
-- vigente ese día, y el libro de compras ya la mostraba— pero el PASIVO con el
-- fisco no nacía hasta pagarle al proveedor. Una factura registrada y no pagada
-- al cierre dejaba al negocio debiéndole al SENIAT un importe que su balance no
-- reconocía, y acreditando al proveedor un bruto que nunca iba a cobrar.
--
-- Ahora:
--   1. el asiento de la FACTURA acredita las retenciones por pagar y acredita
--      cuentas por pagar por el NETO;
--   2. el asiento del PAGO debita cuentas por pagar por lo que sale del banco y
--      ya no crea el pasivo con el fisco: ya existe;
--   3. el saldo del auxiliar de proveedores descuenta la retención, para que el
--      auxiliar y el mayor digan lo mismo.
-- El comprobante de retención se sigue emitiendo al pagar, con su numeración y
-- su permiso: cuándo se ENTREGA el comprobante es otra pregunta, y está abierta
-- con el asesor (PENDIENTES_ASESOR, P-26).
--
-- POR QUÉ ESTAS PLANTILLAS SE CORRIGEN EN SITIO Y NO SE VERSIONAN. Versionar
-- (ADR-0055) es lo correcto cuando cambia la REGLA en una fecha: cada hecho se
-- asienta con la plantilla vigente el día del hecho. Aquí no cambió la regla
-- —la providencia rige desde 2025-08-01—, cambió NUESTRA lectura: estábamos
-- asentando mal. Versionar por fecha del hecho haría que una factura o un pago
-- con fecha anterior a hoy se siguieran asentando con el error, a propósito.
-- Los asientos ya generados no se tocan (son inmutables); lo que se corrige es
-- cómo se asienta de aquí en adelante, incluidos los documentos con fecha
-- pasada.
--
-- CONSECUENCIA CONOCIDA, y es el precio de corregir: una factura registrada
-- ANTES de esta migración, con retención calculada y sin pagar, tiene su asiento
-- viejo acreditando el bruto a cuentas por pagar. Su saldo en el auxiliar baja
-- ahora por la retención, y al pagarla el asiento debitará ese neto: quedan en
-- cuentas por pagar los bolívares de la retención, que se sacan con un asiento
-- manual (débito cuentas por pagar / crédito retención de IVA por pagar). Las
-- facturas afectadas se listan con:
--   select i.id, i.supplier_document_number, i.retention_total
--     from public.supplier_invoices i
--    where i.retention_total > 0 and i.status = 'posted'
--      and i.created_at < '2026-09-17';
-- En producción son 2, las dos de la empresa de pruebas «ferretería».
--
-- Reversibilidad: total, escribiendo otra migración que devuelva las líneas de
-- plantilla a la forma de la migración 28 y la función a la de la 66.
-- HOMOLOGATION_IMPACT = YES (cuándo nace el pasivo con el fisco).
-- =============================================================================

-- ── 1. El preset: lo que importará cualquier empresa desde ahora ────────────
do $$
declare
  v_compra uuid;
  v_pago   uuid;
begin
  select id into v_compra from public.journal_template_preset_entries
   where preset_code = 've_basico' and source_kind = 'purchase_invoice';
  select id into v_pago from public.journal_template_preset_entries
   where preset_code = 've_basico' and source_kind = 'payment_made';
  if v_compra is null or v_pago is null then
    raise exception 'LAD83: falta en el preset ve_basico un hecho que esta migración corrige'
      using errcode = 'LAD83';
  end if;

  -- La compra: al proveedor se le acredita el NETO, y lo retenido se le acredita
  -- al fisco en el mismo asiento.
  update public.journal_template_preset_lines
     set amount_source = 'net_amount',
         description = 'Al proveedor se le debe el NETO: el bruto menos lo retenido'
   where entry_id = v_compra and account_purpose = 'ap_general';
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_compra, 5, 'retention_iva_payable',  'retained_iva',  'credit', 'if_amount_nonzero',
     'Lo retenido de IVA se le debe al FISCO desde el abono en cuenta (PA SNAT/2025/000054)'),
    (v_compra, 6, 'retention_islr_payable', 'retained_islr', 'credit', 'if_amount_nonzero',
     'Y lo retenido de ISLR, igual: el pasivo nace con el registro, no con el pago');

  -- El pago: cancela lo que quedaba debiéndosele al proveedor, que ya es el neto.
  -- Las dos líneas toman el MISMO importe: el asiento cuadra por construcción.
  update public.journal_template_preset_lines
     set amount_source = 'net_amount',
         description = 'Se cancela lo que se le debía al proveedor, que es lo que sale del banco'
   where entry_id = v_pago and account_purpose = 'ap_general';
  delete from public.journal_template_preset_lines
   where entry_id = v_pago
     and account_purpose in ('retention_iva_payable', 'retention_islr_payable');
end $$;

-- ── 2. Las empresas que ya lo importaron ───────────────────────────────────
do $$
declare
  v_t record;
begin
  for v_t in
    select t.id, t.tenant_id, t.company_id, t.source_kind
      from public.journal_templates t
     where t.source_kind in ('purchase_invoice', 'payment_made')
       and t.effective_to is null
  loop
    delete from public.journal_template_lines where template_id = v_t.id;
    insert into public.journal_template_lines
      (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
       side, condition_kind, description)
    select v_t.tenant_id, v_t.company_id, v_t.id, l.line_number, l.account_purpose,
           l.amount_source, l.side, l.condition_kind, l.description
      from public.journal_template_preset_lines l
      join public.journal_template_preset_entries e on e.id = l.entry_id
     where e.preset_code = 've_basico' and e.source_kind = v_t.source_kind
     order by l.line_number;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_t.tenant_id, v_t.company_id, 'company', v_t.company_id,
            'accounting.templates_imported', 'system', now(), 'db-migration',
            jsonb_build_object('origin', 'migration_20260917130000', 'preset_code', 've_basico',
                               'facts', v_t.source_kind,
                               'motivo', 'la retención nace al registrar (ADR-0065 §3)'));
  end loop;
end $$;

-- ── 3. El auxiliar de proveedores descuenta la retención ───────────────────
-- Y la descuenta EN LA MONEDA DE LA FACTURA. `retention_total` vive en moneda
-- funcional (la retención se calcula sobre la base convertida, migración 65) y
-- `total_amount` en la moneda del papel: restarlos sin convertir sería restarle
-- 480 bolívares a 116 dólares, que es el error que este proyecto ya cometió dos
-- veces. Se divide por la tasa de la factura —la misma con la que se calculó la
-- retención— y se redondea a los céntimos de esa moneda, porque el saldo
-- pendiente es algo que alguien tiene que poder pagar exactamente.
create or replace function platform.supplier_invoice_balance(p_company uuid, p_invoice uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select i.total_amount
         - round(coalesce(i.retention_total, 0) / nullif(i.fx_rate, 0),
                 platform.currency_minor_units(i.transaction_currency))
         - coalesce((select sum(p.net_amount) from public.supplier_payments p
                      where p.supplier_invoice_id = i.id), 0)
         - coalesce((select sum(n.total_amount) from public.supplier_credit_notes n
                      where n.supplier_invoice_id = i.id and n.status = 'posted'), 0)
    from public.supplier_invoices i
   where i.id = p_invoice and i.company_id = p_company and i.status in ('posted', 'paid')
$$;
comment on function platform.supplier_invoice_balance(uuid, uuid) is
  'Lo que se le debe al PROVEEDOR por esta factura, en la moneda de la factura: total − lo '
  'retenido (que se le debe al fisco desde el abono en cuenta, PA SNAT/2025/000054) − pagos − '
  'notas de crédito recibidas (ADR-0065 §3, migración 68).';

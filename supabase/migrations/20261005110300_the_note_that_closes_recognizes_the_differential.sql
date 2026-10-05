-- Módulo: compras · contabilidad   Spec: ADR-0083 §5 · ADR-0075 §4
-- Reversible: SÍ mientras ninguna nota haya cerrado una factura a otra tasa (ver abajo)
-- Homologación: NO (no cambia el libro ni el IVA)
--
-- Familia H-03 (ola 5). Va con 20261005110000, 110100 y 110200, justo después del `git pull`
-- y en ese orden.
--
-- QUÉ PASABA
--   Una nota de crédito que CIERRA una factura (deja su saldo en cero) a una tasa distinta de la
--   de la factura dejaba en cuentas por pagar la diferencia de cambio: la factura debía 5,80 USD
--   (4.955,89 Bs en el mayor), la nota los abonaba a 900 (5.220,00 Bs) y quedaban −264,11 Bs en
--   la cuenta por pagar de un documento que ya no debe nada. Con un PAGO que cierra, esa
--   diferencia se reconoce en el acto (ADR-0075 §4); con una nota, no.
--
-- QUÉ HACE
--   Las dos plantillas de la nota (`ap.credit_note_received` y `ap.expense_credit_note_received`)
--   ganan cuatro líneas por `exchange_difference`, con la misma convención que el pago a
--   proveedor (positivo = pérdida):
--     · positivo → débito a pérdida en cambio, crédito a cuentas por pagar;
--     · negativo → débito a cuentas por pagar, crédito a ganancia en cambio.
--   El caso de uso solo manda ese importe cuando la nota deja el saldo de la factura en cero; una
--   nota de la API anterior no lo trae y vale 0 (el generador ya lo trata así): su asiento sale
--   como antes. Preset y empresas que ya tienen las plantillas, con acta.
--
-- REVERSIBILIDAD, CON DATOS VIVOS
--   Aditiva: las líneas se quitan mientras ningún asiento las haya usado. Después, el asiento es
--   append-only y quitar las líneas deja sin explicación sus renglones de diferencial.
--
-- No redefine ninguna función.

do $$
declare
  v_e record;
  v_t record;
  v_n int;
  v_ahora timestamptz := now();
begin
  for v_e in
    select e.id from public.journal_template_preset_entries e
     where e.preset_code = 've_basico' and e.source_kind = 'purchase_credit_note'
       and e.source_event in ('ap.credit_note_received', 'ap.expense_credit_note_received')
  loop
    continue when exists (select 1 from public.journal_template_preset_lines l
                           where l.entry_id = v_e.id and l.amount_source = 'exchange_difference');
    select max(l.line_number) into v_n
      from public.journal_template_preset_lines l where l.entry_id = v_e.id;
    insert into public.journal_template_preset_lines
      (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
    values
      (v_e.id, v_n + 1, 'exchange_loss', 'exchange_difference', 'debit', 'if_positive',
       'La nota cierra la factura a una tasa mayor que la de la factura: pérdida en cambio'),
      (v_e.id, v_n + 2, 'ap_general', 'exchange_difference', 'credit', 'if_positive',
       'La cuenta por pagar del documento queda en cero'),
      (v_e.id, v_n + 3, 'ap_general', 'exchange_difference', 'debit', 'if_negative',
       'La cuenta por pagar del documento queda en cero'),
      (v_e.id, v_n + 4, 'exchange_gain', 'exchange_difference', 'credit', 'if_negative',
       'La nota cierra la factura a una tasa menor que la de la factura: ganancia en cambio');
  end loop;

  for v_t in
    select t.id, t.tenant_id, t.company_id, t.source_kind, t.source_event
      from public.journal_templates t
     where t.source_kind = 'purchase_credit_note'
       and t.source_event in ('ap.credit_note_received', 'ap.expense_credit_note_received')
  loop
    continue when exists (select 1 from public.journal_template_lines l
                           where l.template_id = v_t.id
                             and l.amount_source = 'exchange_difference');
    select coalesce(max(l.line_number), 0) into v_n
      from public.journal_template_lines l where l.template_id = v_t.id;
    insert into public.journal_template_lines
      (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
       side, condition_kind, description)
    values
      (v_t.tenant_id, v_t.company_id, v_t.id, v_n + 1, 'exchange_loss', 'exchange_difference',
       'debit', 'if_positive',
       'La nota cierra la factura a una tasa mayor que la de la factura: pérdida en cambio'),
      (v_t.tenant_id, v_t.company_id, v_t.id, v_n + 2, 'ap_general', 'exchange_difference',
       'credit', 'if_positive', 'La cuenta por pagar del documento queda en cero'),
      (v_t.tenant_id, v_t.company_id, v_t.id, v_n + 3, 'ap_general', 'exchange_difference',
       'debit', 'if_negative', 'La cuenta por pagar del documento queda en cero'),
      (v_t.tenant_id, v_t.company_id, v_t.id, v_n + 4, 'exchange_gain', 'exchange_difference',
       'credit', 'if_negative',
       'La nota cierra la factura a una tasa menor que la de la factura: ganancia en cambio');
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_t.tenant_id, v_t.company_id, 'company', v_t.company_id,
            'accounting.templates_imported', 'system', v_ahora, 'db-migration',
            jsonb_build_object('origin', 'migration_20261005110300',
                               'source_kind', v_t.source_kind, 'source_event', v_t.source_event,
                               'template_id', v_t.id, 'lines_added', 4));
  end loop;

  if exists (select 1 from public.journal_template_preset_entries e
              where e.preset_code = 've_basico' and e.source_kind = 'purchase_credit_note'
                and (select count(*) from public.journal_template_preset_lines l
                      where l.entry_id = e.id and l.amount_source = 'exchange_difference') <> 4) then
    raise exception 'LAD82: una plantilla de la nota de crédito no tiene sus cuatro líneas del diferencial'
      using errcode = 'LAD82';
  end if;
end $$;

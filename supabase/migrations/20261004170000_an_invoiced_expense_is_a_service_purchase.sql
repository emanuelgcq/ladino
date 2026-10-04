-- Módulo: compras y gastos   Spec: docs/02_COMPLIANCE/IVA_SPEC.md · RETENTIONS_SPEC.md · ADR-0066
-- Reversible: NO con datos vivos (ver abajo)   Homologación: YES
--
-- Recorrido 2026-09-24, ola 4, bloque H: H-09 (un gasto con factura fiscal es una compra de
-- servicio) y H-08 (el comprobante del gasto lo ve quien tiene `expense.read`).
--
-- QUÉ PASABA
--   H-09. Un gasto con factura (la luz, el teléfono, el alquiler) se registraba como gasto llano:
--         sin RIF, sin número, sin control y sin IVA. No entraba al libro de compras ni daba
--         crédito fiscal (LIVA art. 33), y la empresa agente no le retenía. La factura de
--         proveedor —el único camino al libro— exige un PRODUCTO por línea, y la luz no es un
--         producto del catálogo.
--   H-08. La policy de lectura del bucket `receipts` miraba solo la pertenencia a la empresa:
--         cualquier miembro (un cajero) leía todos los comprobantes de gastos. El bucket no tenía
--         límite de tamaño ni de tipos.
--
-- QUÉ HACE
--   1. `supplier_invoices.expense_category`: la factura de un GASTO (compra de servicio) lleva su
--      categoría de persona («Luz»). Nula en toda factura de mercancía. Es la misma tabla, el
--      mismo libro, las mismas retenciones y el mismo comprobante: no hay rama fiscal paralela.
--   2. `supplier_invoice_lines.product_id` deja de ser obligatorio SOLO para la línea de servicio:
--      sin producto, la línea no puede venir de una recepción y lleva su categoría tributaria
--      congelada (que es de donde el libro saca la base por alícuota). Una línea de mercancía
--      sigue necesitando su producto: lo dice el CHECK, no la costumbre.
--   3. La plantilla contable `purchase_invoice` / `ap.expense_invoice_posted`: lo mismo que la de
--      la compra, pero el débito va a GASTO y no a «mercancía recibida por facturar» (un servicio
--      no pasa por el almacén, y dejaría el puente abierto para siempre). Preset + las empresas
--      que ya tienen plantillas.
--   4. El bucket `receipts`: 6 MB, solo JPG/PNG/WebP/PDF, y se lee con `expense.read`.
--
-- REVERSIBILIDAD, CON DATOS VIVOS
--   · 1 y 3 son aditivos: se revierten quitando la columna y las plantillas MIENTRAS no exista una
--     factura de gasto. En cuanto exista una, quitar la columna la convierte en una compra de
--     mercancía sin producto y quitar la plantilla deja su asiento sin plantilla que lo explique:
--     no se revierte, se corrige hacia delante.
--   · 2: volver a poner NOT NULL falla en cuanto exista una línea de servicio. No reversible con
--     datos.
--   · 4: la policy se revierte recreando la anterior; el límite del bucket, poniéndolo a null.
--   Es «expand»: la API hoy desplegada no escribe `expense_category` ni líneas sin producto, y
--   sigue funcionando igual con esta migración aplicada. La policy nueva SÍ cambia lo que ve hoy
--   un miembro sin `expense.read` por Storage: deja de leer comprobantes, que es el arreglo.
--
-- No redefine ninguna función.

-- ── 1. La factura de un gasto ────────────────────────────────────────────────
alter table public.supplier_invoices add column expense_category text;
alter table public.supplier_invoices
  add constraint supplier_invoices_expense_category_chk
  check (expense_category is null
         or (expense_category = btrim(expense_category)
             and length(expense_category) between 2 and 60
             -- Sin factura es un gasto llano (tabla `expenses`), y un servicio no tiene orden de
             -- compra ni recepción.
             and fiscal_support
             and purchase_order_id is null));
comment on column public.supplier_invoices.expense_category is
  'H-09 (recorrido 2026-09-24): no nula = la factura es de un GASTO (compra de servicio: luz, '
  'teléfono, alquiler), registrada desde «Registrar gasto → con factura fiscal». Va al libro de '
  'compras y retiene como cualquier factura de proveedor (LIVA art. 33; PA SNAT/2025/000054); su '
  'asiento debita gasto, no «mercancía recibida por facturar» (plantilla ap.expense_invoice_posted).';

create index supplier_invoices_expense_idx
  on public.supplier_invoices (company_id, invoice_date desc)
  where expense_category is not null;

-- ── 2. La línea de servicio no tiene producto ───────────────────────────────
alter table public.supplier_invoice_lines alter column product_id drop not null;
alter table public.supplier_invoice_lines
  add constraint supplier_invoice_lines_product_or_service_chk
  check (product_id is not null
         or (goods_receipt_line_id is null
             and tax_category_snapshot is not null
             and tax_treatment is not null));
comment on constraint supplier_invoice_lines_product_or_service_chk
  on public.supplier_invoice_lines is
  'H-09: una línea SIN producto es una línea de servicio de una factura de gasto: no viene de una '
  'recepción y lleva congelada su categoría tributaria, que es de donde el libro de compras saca '
  'la base por alícuota. Quitar este CHECK deja entrar mercancía sin producto, que el kardex y el '
  'tope de facturación no ven.';

-- La línea sin producto solo vive en una factura de gasto. Un CHECK no cruza tablas: trigger.
create or replace function platform.assert_service_line_on_expense_invoice()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.product_id is null and not exists (
       select 1 from public.supplier_invoices i
        where i.id = new.supplier_invoice_id and i.expense_category is not null) then
    raise exception
      'una línea sin producto solo va en la factura de un gasto (expense_category): la mercancía lleva su producto'
      using errcode = 'LAD98';
  end if;
  return new;
end;
$$;
revoke all on function platform.assert_service_line_on_expense_invoice() from public;

create trigger supplier_invoice_lines_02_service_line
  before insert or update on public.supplier_invoice_lines
  for each row execute function platform.assert_service_line_on_expense_invoice();

-- ── 3. La plantilla contable de la factura de un gasto ──────────────────────
do $$
declare
  v_entry uuid;
  v_c     record;
  v_tpl   uuid;
begin
  if not exists (select 1 from public.journal_template_preset_entries
                  where preset_code = 've_basico' and source_kind = 'purchase_invoice'
                    and source_event = 'ap.expense_invoice_posted') then
    insert into public.journal_template_preset_entries
      (preset_code, source_kind, source_event, description)
    values ('ve_basico', 'purchase_invoice', 'ap.expense_invoice_posted',
            'Factura de un gasto (compra de servicio): gasto y crédito fiscal contra cuentas por pagar')
    returning id into v_entry;
    insert into public.journal_template_preset_lines
      (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
    values
      (v_entry, 1, 'operating_expense', 'subtotal', 'debit', 'if_tax_recoverable',
       'El gasto, sin el IVA'),
      (v_entry, 2, 'iva_credit_fiscal', 'tax_amount', 'debit', 'if_tax_recoverable',
       'IVA crédito fiscal del gasto'),
      (v_entry, 3, 'operating_expense', 'total', 'debit', 'if_tax_not_recoverable',
       'El gasto con su IVA: no es crédito fiscal y va al costo'),
      (v_entry, 4, 'ap_general', 'net_amount', 'credit', 'always',
       'Lo que se le debe al proveedor, neto de lo retenido'),
      (v_entry, 5, 'retention_iva_payable', 'retained_iva', 'credit', 'if_amount_nonzero',
       'IVA retenido por enterar'),
      (v_entry, 6, 'retention_islr_payable', 'retained_islr', 'credit', 'if_amount_nonzero',
       'ISLR retenido por enterar');
  else
    select id into v_entry from public.journal_template_preset_entries
     where preset_code = 've_basico' and source_kind = 'purchase_invoice'
       and source_event = 'ap.expense_invoice_posted';
  end if;

  -- Las empresas que ya importaron plantillas reciben la nueva (las que nazcan después la
  -- reciben del preset). Solo se añade: ninguna plantilla existente cambia.
  for v_c in
    select distinct t.company_id, t.tenant_id from public.journal_templates t
     where t.source_kind = 'purchase_invoice' and t.source_event = 'ap.invoice_posted'
  loop
    continue when exists (select 1 from public.journal_templates t
                           where t.company_id = v_c.company_id
                             and t.source_kind = 'purchase_invoice'
                             and t.source_event = 'ap.expense_invoice_posted');
    insert into public.journal_templates
      (tenant_id, company_id, source_kind, source_event, description, effective_from)
    values (v_c.tenant_id, v_c.company_id, 'purchase_invoice', 'ap.expense_invoice_posted',
            'Factura de un gasto (compra de servicio): gasto y crédito fiscal contra cuentas por pagar',
            '-infinity')
    returning id into v_tpl;
    insert into public.journal_template_lines
      (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
       side, condition_kind, description)
    select v_c.tenant_id, v_c.company_id, v_tpl, l.line_number, l.account_purpose,
           l.amount_source, l.side, l.condition_kind, l.description
      from public.journal_template_preset_lines l
     where l.entry_id = v_entry order by l.line_number;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_c.tenant_id, v_c.company_id, 'company', v_c.company_id,
            'accounting.templates_imported', 'system', now(), 'db-migration',
            jsonb_build_object('migration', '20261004170000',
                               'source_kind', 'purchase_invoice',
                               'source_event', 'ap.expense_invoice_posted'));
  end loop;
end $$;

-- ── 4. El bucket de comprobantes: límites y quién lo lee (H-08) ──────────────
do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'storage' and table_name = 'buckets') then
    update storage.buckets
       set file_size_limit = 6291456,
           allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
     where id = 'receipts';
    execute 'drop policy if exists receipts_select on storage.objects';
    -- Antes: cualquier miembro de la empresa. Ahora: quien tiene `expense.read` EN ESA empresa.
    -- La carpeta raíz del objeto es el id de la empresa; se compara como texto para que un
    -- nombre que no sea un uuid no reviente el cast: simplemente no casa con ninguna.
    execute $pol$
      create policy receipts_select on storage.objects for select to authenticated
        using (bucket_id = 'receipts'
               and exists (select 1 from public.companies c
                            where c.id::text = split_part(name, '/', 1)
                              and c.id in (select platform.ladino_company_ids())
                              and platform.ladino_has_permission('expense.read', c.id)))
    $pol$;
  end if;
end $$;

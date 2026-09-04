-- =============================================================================
-- MODO RECIBOS — Ladino para el negocio que aún no tiene RIF
--
-- Sin RIF no existe factura: la PA 00071 art. 13.5 exige RIF y domicilio del
-- EMISOR en el documento. Un negocio no inscrito puede administrarse entero —
-- vender, inventario, clientes, deudas, cuentas, gastos, contabilidad — pero
-- lo que emite es un RECIBO no fiscal, rotulado como tal, que jamás entra a
-- libros. La PA SNAT/2026/00080 hizo el RIF digital y sin caducidad: activar
-- la facturación después es cambiar de régimen, no rehacer nada.
--
-- Cinco piezas:
--   1. `documents.kind` gana 'receipt'; su correlativo es el de siempre
--      (company, kind, serie), gapless, SIN número de control.
--   2. Régimen `sin_facturacion` (numbering_mode `internal_only`, que ya
--      existía en ADR-0037): allowed_kinds = {receipt}.
--   3. El GATE de kind por régimen, en el trigger de emisión: cada régimen
--      emite SOLO sus allowed_kinds. Con RIF no se vende por recibo (evita el
--      uso evasor) y sin RIF no se emite factura. Regla de esquema, no de UI.
--   4. `tax_treatment` gana 'no_fiscal': la línea de un recibo no lleva regla
--      (un no-inscrito no puede repercutir IVA) y su snapshot lo DICE en vez
--      de fingir un «exento» que significaría otra cosa.
--   5. La contabilidad y el coverage tratan el recibo como venta:
--      preset `sales_receipt`/`sales.receipt.issued` (CxC contra ingresos,
--      sin línea de IVA) y `accounting_coverage_gaps()` amplía su ENUNCIADO
--      para exigir asiento-o-cola también a los recibos — el invariante
--      cambia su texto, no gana una lista de perdones (CLAUDE.md §3).
-- =============================================================================

-- ── 1. El kind ──────────────────────────────────────────────────────────────
alter table public.documents drop constraint documents_kind_chk;
alter table public.documents add constraint documents_kind_chk
  check (kind in ('quote', 'order', 'invoice', 'credit_note', 'debit_note', 'receipt'));

-- ── 2. El régimen ───────────────────────────────────────────────────────────
insert into public.fiscal_regimes
  (code, name, description, allowed_kinds, numbering_mode, requires_transmission, legal_source)
values
  ('sin_facturacion', 'Ventas con recibo (sin RIF)',
   'El negocio aún no está inscrito en el RIF: administra todo y vende con recibos NO fiscales. Al obtener el RIF, se activa la facturación.',
   array['receipt'], 'internal_only', false,
   'PA SNAT/2011/00071 art. 13.5: la factura exige RIF y domicilio del emisor — sin RIF no existe factura. PA SNAT/2026/00080: el RIF es digital y sin caducidad.')
on conflict (code) do nothing;

-- ── 3. El gate de kind por régimen ──────────────────────────────────────────
-- regime_at gana `allowed_kinds` en su retorno. Cambiar el RETURNS TABLE exige
-- drop + recreate; los llamadores seleccionan por NOMBRE de columna, así que
-- ganar una columna no rompe a nadie (sales.ts, fiscal-setup, este trigger).
drop function platform.regime_at(uuid, timestamptz);
create function platform.regime_at(p_company uuid, p_fecha timestamptz)
returns table (regime_version_id uuid, regime_code text, numbering_mode text, allowed_kinds text[])
language sql
stable
set search_path = ''
as $$
  select r.id, r.regime_code, fr.numbering_mode, fr.allowed_kinds
    from public.company_fiscal_regimes r
    join public.fiscal_regimes fr on fr.code = r.regime_code
   where r.company_id = p_company
     and r.effective_from <= p_fecha
     and (r.effective_to is null or r.effective_to > p_fecha)
$$;
comment on function platform.regime_at(uuid, timestamptz) is
  'El régimen fiscal vigente de una empresa A LA FECHA DADA, con sus kinds '
  'permitidos. El EXCLUDE garantiza como mucho UNA fila. Sin fila = sin '
  'régimen: no se emite (LAD49).';
revoke execute on function platform.regime_at(uuid, timestamptz) from public;
grant execute on function platform.regime_at(uuid, timestamptz) to authenticated, ladino_api;

create or replace function platform.assert_document_issuance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_regime record;
begin
  if new.status <> 'issued' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'issued' then return new; end if;

  select * into v_regime from platform.regime_at(new.company_id, new.issued_at);
  if v_regime.regime_version_id is null then
    raise exception
      'la empresa no tiene régimen fiscal vigente a la fecha de emisión: asígnalo antes de emitir (ADR-0029)'
      using errcode = 'LAD49';
  end if;
  if new.regime_version_id is distinct from v_regime.regime_version_id then
    raise exception
      'el documento declara un régimen que no es el vigente a su fecha de emisión'
      using errcode = 'LAD49';
  end if;

  -- EL GATE DE KIND (migración 37): cada régimen emite SOLO sus allowed_kinds.
  -- Con datos fiscales no se vende por recibo; sin RIF no se emite factura.
  if not (new.kind = any(v_regime.allowed_kinds)) then
    raise exception
      'el régimen % no emite documentos de tipo %: sus kinds permitidos son %',
      v_regime.regime_code, new.kind, v_regime.allowed_kinds
      using errcode = 'LAD49';
  end if;

  if v_regime.numbering_mode = 'none' then
    raise exception 'el régimen fiscal de esta empresa no permite emitir documentos'
      using errcode = 'LAD49';
  end if;

  if v_regime.numbering_mode in ('none', 'internal_only') and new.control_number is not null then
    raise exception
      'el régimen % no usa número de control y el documento trae uno: un número de control sin imprenta autorizada es un dato inventado',
      v_regime.regime_code
      using errcode = 'LAD49';
  end if;
  if v_regime.numbering_mode = 'range' and new.control_number is null then
    raise exception
      'el régimen % exige número de control de un rango autorizado y el documento no lo trae',
      v_regime.regime_code
      using errcode = 'LAD49';
  end if;

  if new.document_number is null then
    raise exception 'un documento emitido necesita su correlativo' using errcode = 'LAD49';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_document_issuance() from public;

-- ── 4. El tratamiento no_fiscal ─────────────────────────────────────────────
alter table public.document_lines drop constraint document_lines_treatment_chk;
alter table public.document_lines add constraint document_lines_treatment_chk
  check (tax_treatment is null
         or tax_treatment in ('gravado', 'exento', 'exonerado', 'no_sujeto', 'no_fiscal'));
comment on constraint document_lines_treatment_chk on public.document_lines is
  'Los cuatro tratamientos del libro (migración 27) + no_fiscal (migración 37): '
  'la línea de un RECIBO no lleva regla tributaria y su snapshot lo dice — un '
  '«exento» fingido clasificaría en el libro algo que jamás debe pisarlo.';

-- ── 5. Contabilidad: preset del recibo y coverage ampliado ──────────────────
-- El vocabulario de source_kind vive en TRES casas (entries, templates,
-- preset entries — la migración 30 pagó por descubrirlo) y las tres ganan
-- 'sales_receipt' a la vez.
-- OJO con la trampa que esta migración pisó DOS veces al escribirse: la lista
-- de journal_entries lleva ADEMÁS 'manual', 'period_close' y 'year_end_close'
-- (que plantillas y preset no llevan, porque nadie plantilla un asiento
-- manual). Reconstruir un CHECK desde una copia incompleta borra vocabulario
-- en silencio — se copia la lista VIGENTE y se añade lo nuevo.
alter table public.journal_entries
  drop constraint journal_entries_source_kind_chk;
alter table public.journal_entries
  add constraint journal_entries_source_kind_chk
  check (source_kind in (
    'manual', 'sales_invoice', 'sales_credit_note', 'payment_received',
    'purchase_invoice', 'purchase_credit_note', 'payment_made', 'goods_receipt',
    'inventory_move', 'retention_receipt', 'landed_cost', 'landed_cost_variance',
    'exchange_diff', 'period_close', 'year_end_close', 'expense', 'cash_closing',
    'sales_receipt'));
alter table public.journal_templates
  drop constraint journal_templates_source_kind_chk;
alter table public.journal_templates
  add constraint journal_templates_source_kind_chk
  check (source_kind in (
    'sales_invoice', 'sales_credit_note', 'payment_received', 'purchase_invoice',
    'purchase_credit_note', 'payment_made', 'goods_receipt', 'inventory_move',
    'retention_receipt', 'landed_cost', 'landed_cost_variance', 'exchange_diff',
    'expense', 'cash_closing', 'sales_receipt'));
alter table public.journal_template_preset_entries
  drop constraint journal_template_preset_entries_kind_chk;
alter table public.journal_template_preset_entries
  add constraint journal_template_preset_entries_kind_chk
  check (source_kind in (
    'sales_invoice', 'sales_credit_note', 'payment_received', 'purchase_invoice',
    'purchase_credit_note', 'payment_made', 'goods_receipt', 'inventory_move',
    'retention_receipt', 'landed_cost', 'landed_cost_variance', 'exchange_diff',
    'expense', 'cash_closing', 'sales_receipt'));

do $$
declare
  v_entry uuid;
begin
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'sales_receipt', 'sales.receipt.issued',
          'Venta por RECIBO (modo sin RIF): cuentas por cobrar contra ingresos, sin línea de IVA — un no-inscrito no repercute')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'ar_general',     'total', 'debit',  'always',
     'El cliente debe el total del recibo'),
    (v_entry, 2, 'income_general', 'total', 'credit', 'always',
     'Todo el recibo es ingreso: no hay IVA que separar');
end $$;

-- El invariante de cobertura APRENDE los recibos: la base es la versión
-- VIGENTE (migración 31, con gastos y cierres — reemplazar desde una versión
-- vieja habría borrado esa cobertura en silencio: la trampa de «el arreglo
-- introduce otros», cazada al escribir esta migración). Mismo enunciado,
-- familia más grande — nunca una lista de perdones.
create or replace function platform.accounting_coverage_gaps(p_company uuid)
returns table (source_kind text, source_id uuid, problem text)
language sql
stable
set search_path = ''
as $$
  with documentos as (
    select 'sales_invoice'::text as k, d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'invoice' and d.status in ('issued', 'paid')
    union all
    select 'sales_receipt', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'receipt' and d.status in ('issued', 'paid')
    union all
    select 'purchase_invoice', i.id, i.journal_entry_id
      from public.supplier_invoices i
     where i.company_id = p_company and i.status in ('posted', 'paid')
    union all
    select 'expense', e.id, e.journal_entry_id
      from public.expenses e
     where e.company_id = p_company
    union all
    select 'cash_closing', c.id, c.journal_entry_id
      from public.cash_closings c
     where c.company_id = p_company and c.amount_transaction_currency <> 0
  ),
  estado as (
    select d.k, d.id,
           d.journal_entry_id is not null as tiene_asiento,
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.source_id = d.id
                      and q.status = 'pending') as tiene_pendiente
      from documentos d
  )
  select k, id,
         case when not tiene_asiento and not tiene_pendiente then 'missing'
              else 'duplicated' end
    from estado
   where (not tiene_asiento and not tiene_pendiente)
      or (tiene_asiento and tiene_pendiente)
$$;

-- ── LAD52 ───────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from public.fiscal_regimes
                  where code = 'sin_facturacion' and numbering_mode = 'internal_only'
                    and allowed_kinds = array['receipt']) then
    raise exception 'LAD52: el régimen sin_facturacion no quedó con {receipt}/internal_only';
  end if;
  if not exists (select 1 from public.journal_template_preset_entries
                  where preset_code = 've_basico' and source_kind = 'sales_receipt') then
    raise exception 'LAD52: el preset del recibo no quedó sembrado';
  end if;
end $$;

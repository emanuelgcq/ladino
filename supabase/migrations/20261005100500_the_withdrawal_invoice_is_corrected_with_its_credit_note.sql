-- =============================================================================
-- Ladino — 20261005100500 · LA FACTURA DE RETIRO SE CORRIGE CON SU NOTA DE CRÉDITO (AF3-06)
--
-- Módulo: ventas · inventario · fiscal · contabilidad (RIGOR MÁXIMO)
-- Spec: ADR-0082 (segunda ronda) · ADR-0071 · ADR-0061 · PA 00071 arts. 22 y 23
-- HOMOLOGATION_IMPACT: YES — un documento fiscal nuevo (nota de crédito de un retiro), con
--   correlativo de la serie de notas de crédito y control del talonario; resta en el libro de
--   ventas y en la declaración del período en que se emite.
--
-- EL DEFECTO. Tras 20261005100000, un retiro facturado por error solo se podía anular el mismo
--   día. Descubierto al día siguiente, no tenía corrección fiscal: la base rechazaba toda nota
--   sobre una factura de retiro (LAD67) porque el camino general de la nota mueve cartera y saldo
--   a favor del cliente, y aquí el cliente es la propia empresa.
--
-- LA DECISIÓN (del dueño, por §2.16):
--   1. un kind propio, `withdrawal_credit_note`. La misma razón que el kind de la factura: las
--      lecturas de deuda y de venta enumeran en positivo (`credit_note` RESTA ventas del día y
--      aparece en el estado de cuenta del cliente: con `credit_note` el olvido sería silencioso);
--      con kind propio, lo que hay que ampliar son las lecturas FISCALES, y ese olvido hace ruido;
--   2. la nota es TOTAL: deja sin efecto el retiro entero (PA 00071 art. 22). Una por factura
--      (índice único), con los mismos importes y el mismo adquirente que su factura (trigger);
--   3. numera como una nota de crédito: el correlativo de la serie de notas de crédito (el mismo
--      contador; un índice único cruza los dos kinds) y el control de su talonario;
--   4. no toca cartera ni crea saldo a favor: ni cobro, ni devolución, ni `customer_credits`
--      (triggers), y nunca `paid` (CHECK);
--   5. su asiento es el CONTRA-ASIENTO del retiro: un hecho nuevo del preset,
--      `inventory_move / stock.received` (el nombre del evento que la entrada publica, como
--      `sales_cost / stock.received` en la anulación): inventario contra gasto por retiro, al
--      costo con que salió, y débito fiscal contra gasto por retiro, por el IVA de la factura;
--   6. `platform.document_debt` deja de responder por un documento que no carga cartera: enumera
--      en positivo, como todas las lecturas que la llaman. La primera ronda dijo «por
--      construcción» y había un hueco: el estado de cuenta de la ficha la llamaba documento a
--      documento y una factura de retiro habría salido con «debe» su total;
--   7. la factura de retiro con nota de crédito ya no se anula (se corrigió una vez).
--
-- COMPATIBILIDAD: expand. La API saliente no conoce el kind. `claim_document_number` con
--   'credit_note' bloquea la misma clave de antes. `document_debt` devuelve lo mismo para
--   factura, recibo y nota de débito, que son los únicos kinds por los que alguien la llama.
--   Va JUSTO DESPUÉS del `git pull`, tras 20261005100400, en la misma ventana que las demás.
-- REVERSIBILIDAD (con datos vivos): sin notas de crédito de retiro emitidas, reversible entera
--   (funciones a su definición anterior —la de 20261005100000 a 100300—, soltar triggers, índices
--   y CHECK). Con una emitida, NO: documento fiscal con control consumido, y su reingreso al
--   kardex es append-only.
-- =============================================================================

-- ── 1. El kind y su forma ───────────────────────────────────────────────────
alter table public.documents drop constraint documents_kind_chk;
alter table public.documents add constraint documents_kind_chk
  check (kind = any (array['quote', 'order', 'invoice', 'credit_note', 'debit_note', 'receipt',
                           'receipt_return', 'withdrawal_invoice', 'withdrawal_credit_note']));

-- La nota de un retiro va a la tasa de su factura (`origin`), como toda nota de crédito.
alter table public.documents drop constraint documents_rate_basis_only_notes_chk;
alter table public.documents add constraint documents_rate_basis_only_notes_chk
  check (rate_basis is null
         or kind = any (array['credit_note', 'debit_note', 'withdrawal_credit_note']));

alter table public.documents add constraint documents_withdrawal_credit_note_shape_chk check (
  kind <> 'withdrawal_credit_note'
  or (source_document_id is not null and status <> 'paid' and due_date is null));

-- Una factura de retiro, una nota (es total). La clave natural del caso de uso.
create unique index documents_withdrawal_credit_note_uidx
  on public.documents (source_document_id) where kind = 'withdrawal_credit_note';
-- La nota de crédito y la de un retiro comparten correlativo (el contador de 'credit_note').
create unique index documents_credit_note_number_uidx
  on public.documents (company_id, series, document_number)
  where document_number is not null and kind in ('credit_note', 'withdrawal_credit_note');

-- ── 2. El correlativo: la familia de numeración ─────────────────────────────
-- Definición VIVA: 20261005100100. Se añade la segunda familia.
create or replace function platform.claim_document_number(p_company uuid, p_kind text, p_series text)
 returns bigint
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_next bigint;
  -- ADR-0082: la factura de retiro numera con las facturas, y su nota con las notas de crédito.
  v_familia text := case p_kind when 'withdrawal_invoice' then 'invoice'
                                when 'withdrawal_credit_note' then 'credit_note'
                                else p_kind end;
begin
  -- El bloqueo es sobre la company+tipo+serie, no sobre una tabla de contadores:
  -- pg_advisory_xact_lock serializa las emisiones de la misma serie sin crear
  -- una fila que mantener. Se libera solo al terminar la transacción.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company::text || '|' || v_familia || '|' || p_series, 0));
  select coalesce(max(d.document_number), 0) + 1 into v_next
    from public.documents d
   where d.company_id = p_company
     and (case d.kind when 'withdrawal_invoice' then 'invoice'
                      when 'withdrawal_credit_note' then 'credit_note'
                      else d.kind end) = v_familia
     and d.series = p_series
     and d.document_number is not null;
  return v_next;
end;
$function$;

-- ── 3. La forma de la factura de retiro y de su nota ────────────────────────
-- Definición VIVA: 20261005100000 §3. Cambia: la nota de crédito PROPIA se acepta (y se juzga);
-- la general sigue rechazada; la factura ya corregida no se anula.
create or replace function platform.assert_withdrawal_invoice()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_o record;
begin
  -- La nota de crédito o de débito GENERAL sobre una factura de retiro mueve cartera y saldo a
  -- favor de un cliente que es la propia empresa: sigue rechazada. Se corrige con la suya.
  if new.kind in ('credit_note', 'debit_note') and new.source_document_id is not null
     and (tg_op = 'INSERT' or new.source_document_id is distinct from old.source_document_id) then
    if exists (select 1 from public.documents o
                where o.id = new.source_document_id and o.kind = 'withdrawal_invoice') then
      raise exception
        'Una factura de retiro se corrige con su propia nota de crédito, que deja sin efecto el retiro entero: usa «Corregir este retiro» (ADR-0082).'
        using errcode = 'LAD67';
    end if;
  end if;

  if new.kind = 'withdrawal_credit_note' then
    select o.kind, o.status, o.company_id, o.customer_id, o.subtotal_amount, o.tax_amount,
           o.total_amount, o.amount_transaction_currency, o.customer_tax_id_snapshot,
           o.customer_name_snapshot
      into v_o
      from public.documents o where o.id = new.source_document_id;
    if not found or v_o.kind <> 'withdrawal_invoice' or v_o.company_id <> new.company_id then
      raise exception
        'la nota de crédito de un retiro corrige una factura de retiro de la misma empresa (ADR-0082)'
        using errcode = 'LAD67';
    end if;
    if tg_op = 'UPDATE' and old.status in ('issued', 'paid', 'annulled') then
      if new.status = 'annulled' and old.status <> 'annulled' then
        raise exception
          'La nota de crédito de un retiro no se anula: si el retiro sí ocurrió, regístralo de nuevo (ADR-0082).'
          using errcode = 'LAD67';
      end if;
      return new;
    end if;
    if new.status = 'issued' then
      if v_o.status <> 'issued' then
        raise exception
          'La factura de retiro que se quiere corregir no está vigente (está anulada).'
          using errcode = 'LAD67';
      end if;
      -- ES TOTAL (PA 00071 art. 22: la operación queda sin efecto) y al MISMO adquirente.
      if new.subtotal_amount is distinct from v_o.subtotal_amount
         or new.tax_amount is distinct from v_o.tax_amount
         or new.total_amount is distinct from v_o.total_amount
         or new.amount_transaction_currency is distinct from v_o.amount_transaction_currency
         or new.customer_id is distinct from v_o.customer_id
         or new.customer_tax_id_snapshot is distinct from v_o.customer_tax_id_snapshot
         or new.customer_name_snapshot is distinct from v_o.customer_name_snapshot then
        raise exception
          'la nota de crédito de un retiro es total: los mismos importes y el mismo adquirente que su factura (ADR-0082)'
          using errcode = 'LAD67';
      end if;
    end if;
    return new;
  end if;

  if new.kind <> 'withdrawal_invoice' then return new; end if;

  if tg_op = 'UPDATE' and old.status in ('issued', 'paid', 'annulled') then
    if new.withdrawal_move_id is distinct from old.withdrawal_move_id then
      raise exception
        'la salida que documenta una factura de retiro emitida no se cambia (ADR-0082)'
        using errcode = 'LAD06';
    end if;
    -- Corregida con su nota de crédito, ya no se anula: se corregiría dos veces.
    if new.status = 'annulled' and old.status <> 'annulled'
       and exists (select 1 from public.documents n
                    where n.source_document_id = new.id and n.kind = 'withdrawal_credit_note'
                      and n.status = 'issued') then
      raise exception
        'Esta factura de retiro ya se corrigió con su nota de crédito: no se anula.'
        using errcode = 'LAD67';
    end if;
    return new;
  end if;
  if new.status <> 'issued' then return new; end if;

  -- EL ADQUIRENTE ES LA PROPIA EMPRESA, congelado: el mismo RIF y la misma razón social que el
  -- emisor. No se lee `companies` en vivo: se comparan los dos congelados del documento.
  if nullif(btrim(coalesce(new.issuer_tax_id_snapshot, '')), '') is null
     or upper(regexp_replace(coalesce(new.customer_tax_id_snapshot, ''), '[^a-zA-Z0-9]', '', 'g'))
        is distinct from
        upper(regexp_replace(coalesce(new.issuer_tax_id_snapshot, ''), '[^a-zA-Z0-9]', '', 'g'))
     or new.customer_name_snapshot is distinct from new.issuer_name_snapshot then
    raise exception
      'el adquirente de una factura de retiro es la propia empresa: su RIF y su razón social, congelados (ADR-0082, RLIVA art. 31)'
      using errcode = 'LAD67';
  end if;
  -- AF3-07: el tipo de contribuyente congelado es el de la HISTORIA al día de la emisión.
  if new.customer_taxpayer_type_snapshot is distinct from
     platform.taxpayer_type_at(new.company_id, platform.caracas_day(new.issued_at)) then
    raise exception
      'la factura de retiro congela el tipo de contribuyente que la empresa tenía el día de la emisión (ADR-0072, ADR-0082)'
      using errcode = 'LAD67';
  end if;
  return new;
end;
$$;

-- ── 4. Sin cartera: cobro, devolución y saldo a favor ───────────────────────
-- Definición VIVA: 20261005100300. Cada función nombra SOLO columnas de su tabla.
create or replace function platform.reject_withdrawal_invoice_settlement()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  -- SOLO para `payments`: nombra `document_id`, que es columna de esa tabla.
  if exists (select 1 from public.documents d
              where d.id = new.document_id
                and d.kind in ('withdrawal_invoice', 'withdrawal_credit_note')) then
    raise exception
      'Una factura de retiro y su nota de crédito no se cobran: el adquirente es la propia empresa y no hay cuenta por cobrar (ADR-0082).'
      using errcode = 'LAD67';
  end if;
  return new;
end;
$$;

create or replace function platform.reject_withdrawal_invoice_return()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  -- SOLO para `returns`: nombra `source_document_id`, que es columna de esa tabla.
  if exists (select 1 from public.documents d
              where d.id = new.source_document_id
                and d.kind in ('withdrawal_invoice', 'withdrawal_credit_note')) then
    raise exception
      'Una factura de retiro no se devuelve: se corrige con su nota de crédito, que deja sin efecto el retiro entero (ADR-0082).'
      using errcode = 'LAD67';
  end if;
  return new;
end;
$$;

create function platform.reject_withdrawal_customer_credit()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  -- SOLO para `customer_credits`: nombra `source_document_id`, que es columna de esa tabla.
  if new.source_document_id is not null
     and exists (select 1 from public.documents d
                  where d.id = new.source_document_id
                    and d.kind in ('withdrawal_invoice', 'withdrawal_credit_note')) then
    raise exception
      'La nota de crédito de un retiro no deja saldo a favor: el adquirente es la propia empresa (ADR-0082).'
      using errcode = 'LAD67';
  end if;
  return new;
end;
$$;
revoke all on function platform.reject_withdrawal_customer_credit()
  from public, anon, authenticated;
create trigger customer_credits_05_no_withdrawal
  before insert on public.customer_credits
  for each row execute function platform.reject_withdrawal_customer_credit();

-- ── 5. El contra-asiento del retiro: hecho del preset ───────────────────────
do $$
declare
  v_entry uuid;
  v_c record;
  v_tpl uuid;
begin
  insert into public.journal_template_preset_entries (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'inventory_move', 'stock.received',
          'Reingreso de un retiro que su nota de crédito dejó sin efecto: contra-asiento del retiro')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'inventory_general', 'cost_amount', 'debit', 'always',
     'La mercancía vuelve al inventario, al costo con que salió'),
    (v_entry, 2, 'inventory_withdrawal', 'cost_amount', 'credit', 'always',
     'y se revierte el gasto del retiro'),
    (v_entry, 3, 'iva_debit_fiscal', 'tax_amount', 'debit', 'always',
     'Se revierte el débito fiscal del retiro (nota de crédito)'),
    (v_entry, 4, 'inventory_withdrawal', 'tax_amount', 'credit', 'always',
     'que había sido gasto del retiro');

  -- Las empresas que ya importaron el preset lo reciben, con acta (ADR-0055).
  for v_c in select distinct t.company_id, t.tenant_id from public.journal_templates t loop
    continue when exists (select 1 from public.journal_templates t
                           where t.company_id = v_c.company_id
                             and t.source_kind = 'inventory_move'
                             and t.source_event = 'stock.received');
    insert into public.journal_templates
      (tenant_id, company_id, source_kind, source_event, description, effective_from)
    values (v_c.tenant_id, v_c.company_id, 'inventory_move', 'stock.received',
            'Reingreso de un retiro que su nota de crédito dejó sin efecto: contra-asiento del retiro',
            '-infinity')
    returning id into v_tpl;
    insert into public.journal_template_lines
      (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
       side, condition_kind, description)
    select v_c.tenant_id, v_c.company_id, v_tpl, l.line_number, l.account_purpose,
           l.amount_source, l.side, l.condition_kind, l.description
      from public.journal_template_preset_lines l where l.entry_id = v_entry order by l.line_number;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_c.tenant_id, v_c.company_id, 'company', v_c.company_id,
            'accounting.templates_imported', 'system', now(), 'db-migration',
            jsonb_build_object('origin', 'migration_20261005100500', 'preset_code', 've_basico',
                               'source_kind', 'inventory_move', 'source_event', 'stock.received',
                               'template_id', v_tpl));
  end loop;
end $$;

-- ── 6. La emisión juzga la nota de un retiro como nota de crédito ──
-- Definición VIVA: 20261005100000 §6. Se añade el kind en el régimen y en el tipo de contribuyente. El bloque del adquirente sobre forma libre no la nombra: su adquirente lo juzga platform.assert_withdrawal_invoice (el mismo que su factura).
CREATE OR REPLACE FUNCTION platform.assert_document_issuance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_regime record;
  v_tipo text;
  v_cliente record;
  v_devuelve_recibo boolean := false;
begin
  if new.status <> 'issued' then return new; end if;
  -- Ya emitido: `issued` que sigue `issued`, o `paid` que vuelve a `issued` porque se reversó un
  -- cobro (ADR-0075 §8). La emisión se juzgó cuando se emitió.
  if tg_op = 'UPDATE' and old.status in ('issued', 'paid') then return new; end if;

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

  -- M-12: un recibo se devuelve con recibo de devolución, aunque la empresa ya facture. La
  -- excepción es SOLO esa: el origen es un recibo de la misma empresa.
  v_devuelve_recibo := new.kind = 'receipt_return' and exists (
    select 1 from public.documents o
     where o.id = new.source_document_id and o.company_id = new.company_id
       and o.kind = 'receipt');

  -- EL GATE DE KIND (migración 37): cada régimen emite SOLO sus allowed_kinds.
  -- Con datos fiscales no se vende por recibo; sin RIF no se emite factura.
  -- ADR-0082: la factura de retiro ES una factura: la emite el régimen que emite facturas.
  if not ((case new.kind when 'withdrawal_invoice' then 'invoice'
                          when 'withdrawal_credit_note' then 'credit_note'
                          else new.kind end)
            = any(v_regime.allowed_kinds))
     and not v_devuelve_recibo then
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
  -- M-12: el recibo de devolución no es documento fiscal y no gasta papel del talonario.
  if new.kind = 'receipt_return' and new.control_number is not null then
    raise exception
      'el recibo de devolución no es un documento fiscal: no lleva número de control del talonario'
      using errcode = 'LAD49';
  end if;
  if v_regime.numbering_mode = 'range' and new.control_number is null and not v_devuelve_recibo then
    raise exception
      'el régimen % exige número de control de un rango autorizado y el documento no lo trae',
      v_regime.regime_code
      using errcode = 'LAD49';
  end if;

  if new.document_number is null then
    raise exception 'un documento emitido necesita su correlativo' using errcode = 'LAD49';
  end if;

  -- ADR-0072 §1 (A-03): factura, NC y ND exigen tipo de contribuyente vigente en el DÍA de
  -- Caracas de la emisión, y declarable. Nunca «ordinario por omisión». El recibo no lo pide.
  if new.kind in ('invoice', 'withdrawal_invoice', 'credit_note', 'withdrawal_credit_note',
                  'debit_note') then
    v_tipo := platform.taxpayer_type_at(new.company_id, platform.caracas_day(new.issued_at));
    if v_tipo is null or v_tipo not in ('ordinario', 'especial', 'formal') then
      raise exception
        'la empresa no tiene tipo de contribuyente declarado vigente al %: declárelo antes de emitir (ADR-0072)',
        platform.caracas_day(new.issued_at)
        using errcode = 'LAD98';
    end if;
  end if;

  -- M-10 (LIVA art. 8): el contribuyente formal solo realiza operaciones exentas o exoneradas.
  -- Su factura y su nota de débito no llevan una línea gravada. La NC revierte un débito que ya
  -- existió (el de cuando era ordinario) y no se juzga aquí.
  if v_tipo = 'formal' and new.kind in ('invoice', 'withdrawal_invoice', 'debit_note') and exists (
       select 1 from public.document_lines l
        where l.document_id = new.id
          and (l.tax_treatment = 'gravado' or l.tax_amount > 0)) then
    raise exception
      'Con esta condición no puedes vender productos gravados; si tu negocio cambió, actualiza el tipo de contribuyente (contribuyente formal: LIVA art. 8)'
      using errcode = 'LAD99';
  end if;

  -- EL ADQUIRENTE SOBRE FORMA LIBRE (numeración por rango).
  --  · delivery_note (orden de entrega o guía de despacho) queda FUERA a propósito: si la PA 00071
  --    le exige nombre y RIF o cédula del adquirente es la pregunta P-60 (VALIDAR-SENIAT).
  --  · el registro a posteriori de CONTINGENCIA (A-3) refleja un papel que ya existe: su serie es
  --    la de un talonario de `contingency_ranges` y el bloque no aplica.
  if v_regime.numbering_mode = 'range'
     and new.kind = any (array['invoice', 'credit_note', 'debit_note'])
     and not exists (select 1
                       from public.contingency_ranges cr
                       join public.fiscal_number_ranges r on r.id = cr.fiscal_number_range_id
                      where r.company_id = new.company_id and r.series = new.series) then
    if new.kind = 'invoice' then
      -- PA 00071 art. 13.7 (VALIDAR-SENIAT P-57, lectura conservadora): la factura lleva al
      -- adquirente identificado — ni el «Consumidor final» de sistema, ni un cliente sin nombre o
      -- sin RIF, cédula o pasaporte, ni el marcador PEND-. Lo congelado manda; lo vivo, si no hay.
      select cu.is_system,
             nullif(btrim(coalesce(new.customer_name_snapshot, cu.legal_name)), '') as nombre,
             nullif(btrim(coalesce(new.customer_tax_id_snapshot, cu.tax_id)), '') as documento
        into v_cliente
        from public.customers cu
       where cu.id = new.customer_id;
      if v_cliente.is_system is distinct from false
         or v_cliente.nombre is null
         or v_cliente.documento is null
         or upper(v_cliente.documento) like 'PEND-%' then
        raise exception
          'sobre forma libre, la factura lleva el nombre del adquirente y su RIF, cédula o pasaporte (PA 00071 art. 13.7): el «Consumidor final» es solo para recibos'
          using errcode = 'LAD99';
      end if;
    else
      -- A-4/A-6 (decidido por criterio; regla 1: toda factura se corrige con nota): la NC y la ND
      -- identifican al adquirente EXACTAMENTE como lo hizo la factura que corrigen — el mismo
      -- cliente y la identificación congelada del origen (lo vivo, si el origen es anterior a la
      -- migración 33). Así una factura vieja al «Consumidor final» tiene su nota.
      select (o.customer_id = new.customer_id
              and coalesce(o.customer_name_snapshot, cu.legal_name)
                  is not distinct from coalesce(new.customer_name_snapshot, cu.legal_name)
              and upper(regexp_replace(coalesce(o.customer_tax_id_snapshot, cu.tax_id, ''),
                                       '[^a-zA-Z0-9]', '', 'g'))
                  is not distinct from
                  upper(regexp_replace(coalesce(new.customer_tax_id_snapshot, cu.tax_id, ''),
                                       '[^a-zA-Z0-9]', '', 'g'))) as igual
        into v_cliente
        from public.documents o
        join public.customers cu on cu.id = o.customer_id
       where o.id = new.source_document_id and o.company_id = new.company_id;
      if v_cliente.igual is distinct from true then
        raise exception
          '% identifica al adquirente exactamente como la factura que corrige: el mismo cliente y su identificación congelada',
          case new.kind when 'credit_note' then 'la nota de crédito' else 'la nota de débito' end
          using errcode = 'LAD99';
      end if;
    end if;
  end if;
  return new;
end;
$function$;

-- ── 7. El libro de ventas lee la nota de crédito de un retiro, en negativo ──
-- Definición VIVA: 20261005100200. Se añade el kind, el signo y de dónde sale su asiento.
CREATE OR REPLACE FUNCTION platform.sales_book(p_company uuid, p_from date, p_to date)
 RETURNS TABLE(document_id uuid, issued_on date, kind text, series text, document_number bigint, control_number bigint, status text, customer_tax_id text, customer_name text, customer_taxpayer_type text, transaction_currency text, fx_rate numeric, base_gravada numeric, iva_debito numeric, base_exenta numeric, base_exonerada numeric, base_no_sujeta numeric, base_sin_clasificar numeric, total_amount numeric, journal_entry_id uuid, igtf_percibido numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select x.* from (
  -- Definición viva de 20260928170200 §3 (signo R-1, anulada en cero G-10, adquirente por el
  -- snapshot del nombre B1/B3), más H1 (20261002120200): la línea de la ND por IGTF (producto de
  -- sistema LADINO-IGTF) no suma en ninguna base ni en el total de venta; su monto va a
  -- `igtf_percibido`. El renglón se conserva con su número, control y estado: el correlativo se
  -- consumió y el libro lo registra. VALIDAR-TRIBUTARIO P-70.
  select d.id, platform.caracas_day(d.issued_at), d.kind, d.series, d.document_number,
         d.control_number, d.status,
         case when d.customer_name_snapshot is not null then d.customer_tax_id_snapshot
              else c.tax_id end,
         coalesce(d.customer_name_snapshot, c.legal_name),
         case when d.customer_name_snapshot is not null then d.customer_taxpayer_type_snapshot
              else c.taxpayer_type_code end,
         d.transaction_currency, d.fx_rate,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'gravado'
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         d.tax_amount * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'exento'
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'exonerado'
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'no_sujeto'
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment is null
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         -- La ND por IGTF tiene una sola línea, la del IGTF: su total de VENTA es cero.
         case when coalesce(bool_and(pr.system_code = 'igtf'), false) then 0
              else d.total_amount end * f.factor,
         -- 20261005100000 (ADR-0082): el asiento de la factura de retiro ES el de su salida del
         -- kardex (gasto por retiro + débito fiscal contra inventario). Se busca por el movimiento
         -- y no por un enlace guardado: así vale igual si el hecho pasó por la cola de pendientes.
         case when d.kind = 'withdrawal_invoice' then
                (select e.id from public.journal_entries e
                  where e.company_id = d.company_id and e.source_kind = 'inventory_move'
                    and e.source_id = d.withdrawal_move_id
                    and e.source_event = 'stock.withdrawn'
                    -- 20261005100200: también el asiento REVERSADO (la factura de retiro anulada
                    -- sigue señalando su asiento original, como la factura de venta anulada), y
                    -- nunca el contra-asiento.
                    and e.status in ('posted', 'reversed') and e.is_reversal_of is null
                  limit 1)
              -- 20261005100500: la nota de crédito de un retiro enlaza el asiento de su
              -- REINGRESO al kardex (el contra-asiento del retiro).
              when d.kind = 'withdrawal_credit_note' then
                (select e.id from public.journal_entries e
                   join public.inventory_moves m on m.id = e.source_id
                  where e.company_id = d.company_id and m.source_document_id = d.id
                    and m.kind = 'entrada' and e.source_kind = 'inventory_move'
                    and e.source_event = 'stock.received'
                    and e.status in ('posted', 'reversed') and e.is_reversal_of is null
                  limit 1)
              else d.journal_entry_id end,
         coalesce(sum(dl.line_total_functional) filter (where pr.system_code = 'igtf'), 0)
           * f.factor
    from public.documents d
    cross join lateral (
      select case when d.status = 'annulled' then 0
                  when d.kind in ('credit_note', 'withdrawal_credit_note') then -1
                  else 1 end as factor
    ) f
    join public.customers c on c.id = d.customer_id
    left join public.document_lines dl on dl.document_id = d.id
    left join public.products pr on pr.id = dl.product_id
   where d.company_id = p_company
     and d.kind in ('invoice', 'withdrawal_invoice', 'credit_note', 'withdrawal_credit_note',
                    'debit_note')
     and d.status in ('issued', 'paid', 'annulled')
     and platform.caracas_day(d.issued_at) between p_from and p_to
   group by d.id, f.factor, c.tax_id, c.legal_name, c.taxpayer_type_code
  union all
  -- 20261003110000 (ADR-0078 §3): la Nota de retiro, venta a la propia empresa (LIVA art. 4.3).
  -- Documento interno: sin número de control; el adquirente es la empresa misma.
  select n.id, platform.caracas_day(n.issued_at), 'withdrawal_note'::text, 'NR'::text,
         n.note_number, null::bigint, 'issued'::text,
         -- 20261003110100: el adquirente CONGELADO en la nota, no companies en vivo.
         n.company_tax_id_snapshot, n.company_name_snapshot, n.company_taxpayer_type_snapshot,
         n.functional_currency, 1::numeric,
         case when n.tax_treatment = 'gravado' then n.base_functional else 0 end,
         n.tax_functional,
         case when n.tax_treatment = 'exento' then n.base_functional else 0 end,
         case when n.tax_treatment = 'exonerado' then n.base_functional else 0 end,
         case when n.tax_treatment = 'no_sujeto' then n.base_functional else 0 end,
         case when n.tax_treatment is null then n.base_functional else 0 end,
         n.base_functional + n.tax_functional,
         (select e.id from public.journal_entries e
           where e.company_id = n.company_id and e.source_kind = 'inventory_move'
             and e.source_id = n.move_id and e.source_event = 'stock.withdrawn'
             and e.status = 'posted'
           limit 1),
         0::numeric
    from public.inventory_withdrawal_notes n
   where n.company_id = p_company
     and platform.caracas_day(n.issued_at) between p_from and p_to
  ) x (document_id, issued_on, kind, series, document_number, control_number, status,
       customer_tax_id, customer_name, customer_taxpayer_type, transaction_currency, fx_rate,
       base_gravada, iva_debito, base_exenta, base_exonerada, base_no_sujeta, base_sin_clasificar,
       total_amount, journal_entry_id, igtf_percibido)
   order by coalesce((select d.issued_at from public.documents d where d.id = x.document_id),
                     (select n.issued_at from public.inventory_withdrawal_notes n
                       where n.id = x.document_id)),
            x.series, x.document_number
$function$;

-- ── 8. El libro por alícuota: el signo ──
-- Definición VIVA: 20261003190100 (la del catálogo). Se añade el kind al signo.
CREATE OR REPLACE FUNCTION platform.sales_book_by_rate(p_company uuid, p_from date, p_to date)
 RETURNS TABLE(document_id uuid, issued_on date, kind text, series text, document_number bigint, control_number bigint, status text, customer_tax_id text, customer_name text, customer_taxpayer_type text, transaction_currency text, fx_rate numeric, base_gravada numeric, iva_debito numeric, base_exenta numeric, base_exonerada numeric, base_no_sujeta numeric, base_sin_clasificar numeric, total_amount numeric, journal_entry_id uuid, base_alicuota_general numeric, iva_alicuota_general numeric, alicuota_general numeric, base_alicuota_adicional numeric, iva_alicuota_adicional numeric, alicuota_adicional numeric, base_alicuota_reducida numeric, iva_alicuota_reducida numeric, alicuota_reducida numeric, base_gravada_sin_alicuota numeric, iva_sin_clasificar numeric, control_identifier text, igtf_percibido numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  -- Definición viva de 20260928170300 §3, más `igtf_percibido` (H1, 20261002120200). La línea de
  -- la ND por IGTF es no sujeta: no cae en ninguna alícuota, y su impuesto es cero.
  select s.document_id, s.issued_on, s.kind, s.series, s.document_number, s.control_number,
         s.status, s.customer_tax_id, s.customer_name, s.customer_taxpayer_type,
         s.transaction_currency, s.fx_rate, s.base_gravada, s.iva_debito, s.base_exenta,
         s.base_exonerada, s.base_no_sujeta, s.base_sin_clasificar, s.total_amount,
         s.journal_entry_id,
         r.base_g, r.iva_g, r.rate_g, r.base_a, r.iva_a, r.rate_a, r.base_r, r.iva_r, r.rate_r,
         r.base_x, r.iva_x,
         (select d.control_identifier from public.documents d where d.id = s.document_id),
         s.igtf_percibido
    from platform.sales_book(p_company, p_from, p_to) with ordinality as s
    cross join lateral (
      select case when s.status = 'annulled' then 0
                  when s.kind in ('credit_note', 'withdrawal_credit_note') then -1 else 1 end as factor
    ) f
    cross join lateral (
      select
        coalesce(sum(dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_general'), 0) * f.factor as base_g,
        coalesce(sum(dl.line_total_functional - dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_general'), 0) * f.factor as iva_g,
        max(dl.tax_rate_snapshot) filter (where dl.tax_category_snapshot = 'gravado_general') as rate_g,
        coalesce(sum(dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_adicional'), 0) * f.factor as base_a,
        coalesce(sum(dl.line_total_functional - dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_adicional'), 0) * f.factor as iva_a,
        max(dl.tax_rate_snapshot) filter (where dl.tax_category_snapshot = 'gravado_adicional') as rate_a,
        coalesce(sum(dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_reducida'), 0) * f.factor as base_r,
        coalesce(sum(dl.line_total_functional - dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_reducida'), 0) * f.factor as iva_r,
        max(dl.tax_rate_snapshot) filter (where dl.tax_category_snapshot = 'gravado_reducida') as rate_r,
        coalesce(sum(dl.line_subtotal_functional)
                 filter (where dl.tax_treatment = 'gravado'
                           and dl.tax_category_snapshot is distinct from 'gravado_general'
                           and dl.tax_category_snapshot is distinct from 'gravado_adicional'
                           and dl.tax_category_snapshot is distinct from 'gravado_reducida'), 0)
          * f.factor as base_x,
        coalesce(sum(dl.line_total_functional - dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot is null
                           or dl.tax_category_snapshot not in
                              ('gravado_general', 'gravado_adicional', 'gravado_reducida')), 0)
          * f.factor as iva_x
        -- 20261003110000: la Nota de retiro es un renglón con la misma forma que una línea.
        from (select l.tax_category_snapshot, l.tax_treatment, l.tax_rate_snapshot,
                     l.line_subtotal_functional, l.line_total_functional
                from public.document_lines l
               where l.document_id = s.document_id
              union all
              select n.tax_category_snapshot, n.tax_treatment, n.tax_rate_snapshot,
                     n.base_functional, n.base_functional + n.tax_functional
                from public.inventory_withdrawal_notes n
               where n.id = s.document_id) dl
    ) r
   order by s.ordinality
$function$;

-- ── 9. El resumen del libro (art. 72) ──
-- Definición VIVA: 20261005100000 §9. La nota de un retiro es un ajuste, como toda nota.
CREATE OR REPLACE FUNCTION platform.sales_book_summary(p_company uuid, p_from date, p_to date)
 RETURNS TABLE(concept text, rate numeric, base numeric, tax numeric, adjustments_base numeric, adjustments_tax numeric, documents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  -- Definición viva de 20260928150000 §7. H1 (20261002120200): la línea de la ND por IGTF no es
  -- una venta no sujeta y no entra en el resumen (VALIDAR-TRIBUTARIO P-70).
  select x.concept, x.rate, sum(x.base), sum(x.tax),
         coalesce(sum(x.base) filter (where x.kind not in ('invoice', 'withdrawal_invoice', 'withdrawal_note')), 0),
         coalesce(sum(x.tax) filter (where x.kind not in ('invoice', 'withdrawal_invoice', 'withdrawal_note')), 0),
         count(distinct x.doc)
    from (
      select case when dl.tax_treatment = 'gravado'
                    then coalesce(dl.tax_category_snapshot, 'gravado')
                  when dl.tax_treatment is null then 'sin_clasificar'
                  else dl.tax_treatment end as concept,
             case when dl.tax_treatment = 'gravado' then dl.tax_rate_snapshot end as rate,
             dl.line_subtotal_functional * f.factor as base,
             (dl.line_total_functional - dl.line_subtotal_functional) * f.factor as tax,
             d.kind, d.id as doc
        from public.documents d
        join public.document_lines dl on dl.document_id = d.id
        cross join lateral (
          select case when d.kind in ('credit_note', 'withdrawal_credit_note') then -1
                      else 1 end as factor) f
       where d.company_id = p_company
         and d.kind in ('invoice', 'withdrawal_invoice', 'credit_note', 'withdrawal_credit_note',
                    'debit_note')
         and d.status in ('issued', 'paid')
         and platform.caracas_day(d.issued_at) between p_from and p_to
         and not exists (select 1 from public.products pr
                          where pr.id = dl.product_id and pr.system_code = 'igtf')
      union all
      -- 20261003110000: la Nota de retiro es venta (no ajuste) a la propia empresa.
      select case when n.tax_treatment = 'gravado'
                    then coalesce(n.tax_category_snapshot, 'gravado')
                  when n.tax_treatment is null then 'sin_clasificar'
                  else n.tax_treatment end,
             case when n.tax_treatment = 'gravado' then n.tax_rate_snapshot end,
             n.base_functional, n.tax_functional, 'withdrawal_note'::text, n.id
        from public.inventory_withdrawal_notes n
       where n.company_id = p_company
         and platform.caracas_day(n.issued_at) between p_from and p_to
    ) x
   group by x.concept, x.rate
   order by case x.concept when 'gravado_general' then 1 when 'gravado_adicional' then 2
                           when 'gravado_reducida' then 3 when 'exento' then 4
                           when 'exonerado' then 5 when 'no_sujeto' then 6 else 7 end,
            x.rate
$function$;

-- ── 10. La declaración de IVA resta la nota en su período ──
-- Definición VIVA: 20261005100000 §10.
CREATE OR REPLACE FUNCTION platform.recompute_iva_period(p_company uuid, p_from date, p_to date, p_excedente_anterior numeric, p_retenciones_anteriores numeric DEFAULT 0)
 RETURNS TABLE(debitos numeric, creditos numeric, creditos_deducibles numeric, prorrata_pct numeric, retenciones_soportadas numeric, cuota_a_pagar numeric, excedente_siguiente numeric, detalle jsonb, ajuste_creditos_anteriores numeric, retenciones_acumuladas_por_descontar numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  -- 20261003190400: los créditos, las notas de crédito y el ajuste convierten con la escala del
  -- libro de compras a los dos lados del corte del céntimo (ver platform.purchases_book).
  with corte as (select platform.cent_cutover_at(p_company) as t),
  ventas as (
    -- TODO en moneda funcional: la base es el subtotal funcional del renglón y el
    -- impuesto es total − subtotal funcionales, la misma derivación con la que el
    -- documento congela su IVA y el mayor lo asienta (sales.ts, insertarDocumento).
    -- `tax_amount` del renglón está en la moneda de la TRANSACCIÓN: sumarlo
    -- declaraba dólares como bolívares (QA 2026-09-15, h. 63).
    select case when d.kind in ('credit_note', 'withdrawal_credit_note') then -1 else 1 end as signo,
           l.tax_rate_snapshot as alicuota,
           l.line_subtotal_functional as base,
           (l.line_total_functional - l.line_subtotal_functional) as impuesto,
           l.tax_amount as impuesto_transaccion,
           d.kind
      from public.documents d
      join public.document_lines l on l.document_id = d.id
     where d.company_id = p_company
       and d.kind in ('invoice', 'withdrawal_invoice', 'credit_note', 'withdrawal_credit_note',
                    'debit_note')
       and d.status in ('issued', 'paid')
       and (d.issued_at at time zone 'America/Caracas')::date between p_from and p_to
       -- H1 (20261002120200; PA SNAT/2022/000013 arts. 5-6, LIVA art. 34): la línea de la ND por
       -- IGTF (producto de sistema LADINO-IGTF) NO es una venta: ni débito, ni base, ni «sin
       -- impuesto» que active la prorrata. VALIDAR-TRIBUTARIO P-70.
       and not exists (select 1 from public.products pr
                        where pr.id = l.product_id and pr.system_code = 'igtf')
    union all
    -- 20261003110000 (ADR-0078 §3, LIVA art. 4.3): el débito fiscal del retiro, por su alícuota.
    select 1, n.tax_rate_snapshot, n.base_functional, n.tax_functional, n.tax_functional,
           'withdrawal_note'::text
      from public.inventory_withdrawal_notes n
     where n.company_id = p_company
       and (n.issued_at at time zone 'America/Caracas')::date between p_from and p_to
  ),
  por_alicuota as (
    select alicuota,
           sum(signo * base) as base,
           sum(signo * impuesto) as impuesto
      from ventas group by alicuota
  ),
  deb as (select coalesce(sum(impuesto), 0) as total from por_alicuota),
  bases_venta as (
    select coalesce(sum(signo * base) filter (where impuesto_transaccion <> 0), 0) as gravadas,
           coalesce(sum(signo * base) filter (where impuesto_transaccion = 0), 0) as sin_impuesto
      from ventas
  ),
  cred as (
    -- AF3-09 (20261003190000, ADR-0075 §7; RLIVA art. 72): la MISMA regla que el libro de compras.
    -- Cada documento se convierte a bolívares AL CÉNTIMO —round(iva × tasa, 2), como
    -- platform.purchases_book— y la declaración suma esos céntimos. Antes convertía a 8 decimales
    -- mientras el libro iba a 2: el resumen del libro y lo declarado diferían en la fracción.
    -- Vale para los créditos, las notas de crédito y el ajuste de períodos anteriores.
    -- El IVA de la factura de proveedor, a la tasa con la que se asentó, MENOS el de las NOTAS
    -- DE CRÉDITO recibidas en el período. LIVA art. 37: el impuesto de la operación
    -- posteriormente anulada se deduce del crédito fiscal; art. 56: se registran las notas que
    -- se emitan o RECIBAN. El período es el de la NOTA, no el de la factura que corrige.
    -- La anulada DESPUÉS de cerrar y presentar su período sigue contando en él: esa planilla
    -- no cambia (R-2 ampliada); su reversa va en `ajuste` del período de la anulación.
    select coalesce((select sum(round(i.tax_amount * i.fx_rate, case when (select t from corte) is not null and i.created_at <= (select t from corte) then 8 else 2 end) + 0.00000000)
                       from public.supplier_invoices i
                      where i.company_id = p_company
                        and (i.status in ('posted', 'paid')
                             or (i.status = 'annulled'
                                 and platform.supplier_invoice_late_annulment_day(
                                       i.company_id, coalesce(i.accounting_date, i.invoice_date),
                                       i.annulled_at) is not null))
                        and i.tax_is_recoverable
                        -- ADR-0069 §4: la recibida con retraso, en su período de REGISTRO.
                        -- Sin ventana de LIVA art. 33 (P-35, pendiente de fuente).
                        and coalesce(i.accounting_date, i.invoice_date)
                              between p_from and p_to), 0)
         - coalesce((select sum(round(n.tax_amount * n.fx_rate, case when (select t from corte) is not null and n.created_at <= (select t from corte) then 8 else 2 end) + 0.00000000)
                       from public.supplier_credit_notes n
                       join public.supplier_invoices i on i.id = n.supplier_invoice_id
                      where n.company_id = p_company
                        and n.status = 'posted'
                        and i.tax_is_recoverable
                        and coalesce(n.accounting_date, n.note_date)
                              between p_from and p_to), 0) as total
  ),
  ajuste as (
    -- Casilla de AJUSTES A LOS CRÉDITOS FISCALES DE PERÍODOS ANTERIORES: la reversa del crédito
    -- de las facturas anuladas tarde, en el período (día de Caracas) de la anulación.
    select -coalesce(sum(round(i.tax_amount * i.fx_rate, case when (select t from corte) is not null and i.created_at <= (select t from corte) then 8 else 2 end) + 0.00000000), 0) as total
      from public.supplier_invoices i
     where i.company_id = p_company
       and i.status = 'annulled'
       and i.tax_is_recoverable
       and platform.supplier_invoice_late_annulment_day(
             i.company_id, coalesce(i.accounting_date, i.invoice_date), i.annulled_at)
           between p_from and p_to
  ),
  ret as (
    -- L-04: la retención soportada, en el período (quincena o mes) de la FECHA DEL COMPROBANTE.
    -- H4 (20261002120200; PA SNAT/2025/000054 art. 7): si ese período ya estaba DECLARADO cuando
    -- se entregó el comprobante (una generación que lo cubre, creada el día de la entrega o antes),
    -- la retención va al período de la ENTREGA. Sin fecha de entrega, la de la retención: nada
    -- cambia para lo cargado antes. Granularidad: día contra día (caracas_day de la generación
    -- contra la fecha de entrega). VALIDAR-TRIBUTARIO P-68.
    select coalesce(sum(r.amount), 0) as total
      from public.supported_retention_receipts r
     where r.company_id = p_company and r.status = 'registered'
       and case when exists (
                  select 1 from public.iva_period_results p
                   where p.company_id = r.company_id
                     and r.retained_on between p.period_from and p.period_to
                     -- B-1 (20261002120400): solo una generación hecha DESPUÉS de cerrar su
                     -- período declara; una vista previa a mitad de quincena, o la de un período
                     -- futuro, no. Día contra día (caracas_day de la generación).
                     and p.period_to < platform.caracas_day(p.created_at)
                     and platform.caracas_day(p.created_at)
                           <= coalesce(r.received_on, r.retained_on))
                then coalesce(r.received_on, r.retained_on)
                else r.retained_on end
           between p_from and p_to
  ),
  prorrata as (
    -- GLOBAL v1 (H-11, VALIDAR-TRIBUTARIO): solo cuando hubo ventas sin
    -- impuesto en el período; pct = gravadas / (gravadas + sin impuesto).
    select case
             when b.sin_impuesto > 0 and (b.gravadas + b.sin_impuesto) > 0
               then round(b.gravadas / (b.gravadas + b.sin_impuesto), 8)
             else null
           end as pct
      from bases_venta b
  ),
  calc as (
    -- El ajuste NO pasa por la prorrata del período en curso: corrige un crédito que ya se
    -- dedujo con la prorrata de SU período (VALIDAR-TRIBUTARIO P-46). Y NO se suma en
    -- `deducibles`: esa columna es el crédito del PERÍODO tras la prorrata, que nunca es
    -- negativo (CHECK ipr_amounts_chk). El ajuste va en su casilla y entra en la cuota.
    select d.total as debitos,
           c.total as creditos,
           case when p.pct is null then c.total
                else round(c.total * p.pct, 8) end as deducibles,
           p.pct, r.total as retenciones, a.total as ajuste
      from deb d, cred c, ret r, prorrata p, ajuste a
  ),
  neto as (
    -- L-05 · LOS DOS ARRASTRES DE LA FORMA 00030. Primero el impuesto: débitos − créditos
    -- (con su ajuste) − excedente de CRÉDITO anterior. Si es negativo, ESE es el excedente de
    -- crédito fiscal que pasa. Después las retenciones (las acumuladas que llegan + las del
    -- período) se descuentan SOLO de la cuota positiva; lo que no absorbe pasa aparte, como
    -- retenciones acumuladas por descontar. Una retención nunca se convierte en crédito fiscal
    -- (PA SNAT/2025/000054 arts. 7 y 8; VALIDAR-TRIBUTARIO P-37).
    select calc.*,
           calc.debitos - (calc.deducibles + calc.ajuste) - p_excedente_anterior as impuesto,
           p_retenciones_anteriores + calc.retenciones as retenciones_disponibles
      from calc
  )
  select
    n.debitos, n.creditos, n.deducibles, n.pct, n.retenciones,
    greatest(0, greatest(0, n.impuesto) - n.retenciones_disponibles) as cuota_a_pagar,
    greatest(0, -n.impuesto) as excedente_siguiente,
    (select coalesce(jsonb_agg(jsonb_build_object(
              'alicuota', a.alicuota::text,
              'base', a.base::text,
              'impuesto', a.impuesto::text) order by a.alicuota), '[]'::jsonb)
       from por_alicuota a) as detalle,
    n.ajuste,
    greatest(0, n.retenciones_disponibles - greatest(0, n.impuesto))
      as retenciones_acumuladas_por_descontar
  from neto n
$function$;

-- ── 11. fiscal_amount_gaps ──
-- Definición VIVA: 20261005100000 §11.
CREATE OR REPLACE FUNCTION platform.fiscal_amount_gaps(p_company uuid)
 RETURNS TABLE(document_id uuid, problem text, expected numeric, found numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  -- ENUNCIADO: en todo documento fiscal (factura, factura de retiro, nota de crédito, nota de crédito de un retiro, nota de débito) emitido
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
       and d.kind in ('invoice', 'withdrawal_invoice', 'credit_note', 'withdrawal_credit_note',
                    'debit_note')
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
$function$;

-- ── 12. company_has_fiscal_documents ──
-- Definición VIVA: 20261005100000 §12.
CREATE OR REPLACE FUNCTION platform.company_has_fiscal_documents(p_company uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.documents d
     where d.company_id = p_company
       and d.kind in ('invoice', 'withdrawal_invoice', 'credit_note', 'withdrawal_credit_note',
                    'debit_note')
       and d.status in ('issued', 'paid', 'annulled'))
  or exists (
    select 1 from public.supplier_invoices i
     where i.company_id = p_company and i.status in ('posted', 'paid'))
  or exists (
    select 1 from public.retention_receipts r
     where r.company_id = p_company and r.status in ('issued', 'annulled'))
$function$;

-- ── 13. accounting_coverage_gaps: la nota, cubierta por el asiento de su reingreso ──
-- Definición VIVA: 20261005100000 §13. Solo se AÑADE la última rama.
CREATE OR REPLACE FUNCTION platform.accounting_coverage_gaps(p_company uuid)
 RETURNS TABLE(source_kind text, source_id uuid, problem text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with documentos as (
    select 'sales_invoice'::text as k, d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'invoice' and d.status in ('issued', 'paid')
    union all
    select 'sales_receipt', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'receipt' and d.status in ('issued', 'paid')
    union all
    select 'sales_credit_note', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'credit_note' and d.status in ('issued', 'paid')
    union all
    select 'sales_debit_note', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'debit_note' and d.status in ('issued', 'paid')
    union all
    select 'sales_receipt_return', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'receipt_return' and d.status in ('issued', 'paid')
    union all
    select 'purchase_invoice', i.id, i.journal_entry_id
      from public.supplier_invoices i
     where i.company_id = p_company and i.status in ('posted', 'paid')
    union all
    -- ADR-0065 §1: la nota de crédito recibida es un hecho contable como la factura.
    select 'purchase_credit_note', n.id, n.journal_entry_id
      from public.supplier_credit_notes n
     where n.company_id = p_company and n.status = 'posted'
    union all
    select 'expense', e.id, e.journal_entry_id
      from public.expenses e
     where e.company_id = p_company
    union all
    select 'cash_closing', c.id, c.journal_entry_id
      from public.cash_closings c
     where c.company_id = p_company and c.amount_transaction_currency <> 0
    union all
    select 'customer_refund', r.id, r.journal_entry_id
      from public.customer_refunds r
     where r.company_id = p_company
    union all
    select 'treasury_transfer', t.id, t.journal_entry_id
      from public.treasury_transfers t
     where t.company_id = p_company
  ),
  -- El COBRO, el PAGO a proveedor y la PERCEPCIÓN de IGTF generan asiento pero no guardan el
  -- enlace (el generador los trata como «sin backlink»): su cobertura se comprueba buscando el
  -- asiento por origen. Ninguno queda huérfano hoy —el caso de uso propaga el error y la
  -- transacción se revierte—, pero el invariante que no existe no caza nada (R-20, ADR-0065 §6).
  sin_enlace as (
    select 'payment_received'::text as k, p.id
      from public.payments p where p.company_id = p_company
       and not exists (select 1 from public.payment_reversals r where r.payment_id = p.id)
    union all
    select 'payment_made', sp.id
      from public.supplier_payments sp where sp.company_id = p_company
    union all
    select 'igtf_perception', ip.id
      from public.igtf_perceptions ip where ip.company_id = p_company
       and not exists (select 1 from public.payment_reversals r
                        where r.payment_id = ip.payment_id)
  ),
  -- La ND por IGTF (20261002100000) no tiene asiento propio: su asiento ES el de su percepción
  -- (backlink). El enunciado lo dice: queda cubierta si su percepción tiene asiento O está en cola
  -- (re-revisión 3, CLAUDE.md §3: se cambia el enunciado, no se perdona).
  nd_igtf as (
    select ip.debit_note_id as id,
           bool_or(exists (select 1 from public.journal_entries e
                            where e.company_id = p_company and e.source_kind = 'igtf_perception'
                              and e.source_id = ip.id and e.status in ('posted', 'reversed')))
             as con_asiento,
           bool_or(exists (select 1 from public.journal_generation_queue q
                            where q.company_id = p_company and q.source_id = ip.id
                              and q.status = 'pending')) as en_cola
      from public.igtf_perceptions ip
     where ip.company_id = p_company and ip.debit_note_id is not null
     group by ip.debit_note_id
  ),
  estado as (
    select d.k, d.id,
           d.journal_entry_id is not null or coalesce(n.con_asiento, false) as tiene_asiento,
           (exists (select 1 from public.journal_generation_queue q
                     where q.company_id = p_company and q.source_id = d.id
                       and q.status = 'pending')
            or (d.journal_entry_id is null and coalesce(n.en_cola, false))) as tiene_pendiente
      from documentos d
      left join nd_igtf n on n.id = d.id
    union all
    select s.k, s.id,
           exists (select 1 from public.journal_entries e
                    where e.company_id = p_company and e.source_id = s.id
                      and e.source_kind = s.k and e.status in ('posted', 'reversed')),
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.source_id = s.id
                      and q.status = 'pending')
      from sin_enlace s
  )
  select k, id,
         case when not tiene_asiento and not tiene_pendiente then 'missing'
              else 'duplicated' end
    from estado
   where (not tiene_asiento and not tiene_pendiente)
      or (tiene_asiento and tiene_pendiente)
  union all
  -- EL COBRO REVERSADO y su percepción (ADR-0075 §8): su asiento quedó `reversed` (o se
  -- descartó de la cola). Un asiento vivo o una fila pendiente es una reversa a medias.
  select x.k, x.id, 'reversal_not_posted'
    from (select 'payment_received'::text as k, r.payment_id as id
            from public.payment_reversals r where r.company_id = p_company
          union all
          select 'igtf_perception', ip.id
            from public.payment_reversals r
            join public.igtf_perceptions ip
              on ip.company_id = r.company_id and ip.payment_id = r.payment_id
           where r.company_id = p_company) x
   where exists (select 1 from public.journal_entries e
                  where e.company_id = p_company and e.source_id = x.id
                    and e.source_kind = x.k and e.status = 'posted')
      or exists (select 1 from public.journal_generation_queue q
                  where q.company_id = p_company and q.source_id = x.id
                    and q.status = 'pending')
  union all
  -- 20261005100000 (ADR-0082) · LA FACTURA DE RETIRO no tiene asiento propio: su asiento ES el de
  -- su salida del kardex (hecho inventory_move / stock.withdrawn). El enunciado lo dice: queda
  -- cubierta si ese hecho tiene asiento O espera en la cola. Sin valor (costo cero e IVA cero) no
  -- hay nada que asentar.
  select 'withdrawal_invoice', d.id, 'missing'
    from public.documents d
    join public.inventory_moves m on m.id = d.withdrawal_move_id
   where d.company_id = p_company and d.kind = 'withdrawal_invoice' and d.status = 'issued'
     and (m.functional_amount <> 0 or d.tax_amount <> 0)
     and not exists (select 1 from public.journal_entries e
                      where e.company_id = p_company and e.source_kind = 'inventory_move'
                        and e.source_id = m.id and e.source_event = 'stock.withdrawn'
                        and e.status in ('posted', 'reversed'))
     and not exists (select 1 from public.journal_generation_queue q
                      where q.company_id = p_company and q.source_kind = 'inventory_move'
                        and q.source_id = m.id and q.source_event = 'stock.withdrawn'
                        and q.status = 'pending')
  union all
  -- 20261005100500 (ADR-0082) · LA NOTA DE CRÉDITO DE UN RETIRO tampoco tiene asiento propio: su
  -- asiento ES el del reingreso de la mercancía (hecho inventory_move / stock.received, el
  -- contra-asiento del retiro). Cubierta si ese hecho tiene asiento O espera en la cola; y sin
  -- reingreso no hay hecho que la cubra: es un hueco.
  select 'withdrawal_credit_note', d.id, 'missing'
    from public.documents d
   where d.company_id = p_company and d.kind = 'withdrawal_credit_note' and d.status = 'issued'
     and not exists (select 1 from public.inventory_moves m
                      where m.company_id = p_company and m.source_document_id = d.id
                        and m.kind = 'entrada'
                        and ((m.functional_amount = 0 and d.tax_amount = 0)
                             or exists (select 1 from public.journal_entries e
                                         where e.company_id = p_company
                                           and e.source_kind = 'inventory_move'
                                           and e.source_id = m.id
                                           and e.source_event = 'stock.received'
                                           and e.status in ('posted', 'reversed'))
                             or exists (select 1 from public.journal_generation_queue q
                                         where q.company_id = p_company
                                           and q.source_kind = 'inventory_move'
                                           and q.source_id = m.id
                                           and q.source_event = 'stock.received'
                                           and q.status = 'pending')))
$function$;

-- ── 14. document_debt enumera en positivo ──
-- Definición VIVA: 20261003210200 (la única). Solo se añade la condición del kind.
CREATE OR REPLACE FUNCTION platform.document_debt(p_company uuid, p_document uuid)
 RETURNS TABLE(currency text, nominal numeric, functional_currency text, rate numeric, rate_date date, functional_today numeric)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_doc record;
  v_rate numeric;
  v_saldo_tx numeric;
  v_escala int;
  v_hoy date := platform.caracas_day(now());
  v_func numeric;
begin
  select d.id, d.status, d.transaction_currency, d.functional_currency, d.fx_rate,
         d.amount_transaction_currency, d.total_amount
    into v_doc
    from public.documents d
   where d.id = p_document and d.company_id = p_company
     and d.status in ('issued', 'paid')
     -- 20261005100500 (ADR-0082): SOLO los documentos que cargan cartera deben algo —la misma
     -- lista positiva de customer_debt_today, customer_overdue_today, ar_aging y
     -- receivables_ledger_gap, que son quienes llaman a esta función—. Una factura de retiro, su
     -- nota, una cotización: no hay fila. Ningún kind futuro debe por omisión.
     and d.kind in ('invoice', 'receipt', 'debit_note');
  if not found then return; end if;

  v_escala := platform.currency_minor_units(v_doc.functional_currency);

  -- ADR-0075 §4: un documento pagado está CERRADO. No debe nada, ni un residuo, ni lo que una
  -- tasa cargada después diga. Si un cobro se reversa, el documento vuelve a `issued` y debe.
  if v_doc.status = 'paid' then
    return query select v_doc.transaction_currency,
                        round(0::numeric, platform.currency_minor_units(v_doc.transaction_currency)),
                        v_doc.functional_currency, null::numeric, v_hoy,
                        round(0::numeric, v_escala);
    return;
  end if;

  if v_doc.transaction_currency = v_doc.functional_currency then
    v_func := round(platform.document_balance(p_company, p_document), v_escala);
    return query select v_doc.transaction_currency, v_func, v_doc.functional_currency,
                        1::numeric, v_hoy, v_func;
    return;
  end if;

  v_saldo_tx := platform.document_balance_transaction_at(p_company, p_document, null, false);
  if v_saldo_tx is null then
    -- Un cobro viejo sin tasa con que valorarlo: lo que se debe no se puede decir. Se dice eso.
    return query select v_doc.transaction_currency, null::numeric, v_doc.functional_currency,
                        null::numeric, v_hoy, null::numeric;
    return;
  end if;

  v_rate := platform.rate_at(p_company, v_doc.transaction_currency, v_doc.functional_currency,
                             v_hoy);
  if v_rate is null then
    -- Sin tasa de hoy: el nominal se debe igual; su equivalente funcional no se inventa.
    return query select v_doc.transaction_currency,
                        round(v_saldo_tx, platform.currency_minor_units(v_doc.transaction_currency)),
                        v_doc.functional_currency, null::numeric, v_hoy, null::numeric;
    return;
  end if;

  if v_doc.amount_transaction_currency is null or v_doc.amount_transaction_currency = 0
     or v_doc.fx_rate is null or v_doc.fx_rate = 0 then
    v_func := round(v_saldo_tx * v_rate, v_escala);
  elsif v_rate = v_doc.fx_rate and v_saldo_tx > 0
        and exists (select 1 from public.payments p
                     where p.document_id = v_doc.id
                       and not exists (select 1 from public.payment_reversals pr
                                        where pr.payment_id = p.id)) then
    -- LO MOSTRADO ES LO QUE CIERRA: a la tasa del documento y con cobros previos, la deuda en Bs
    -- es la base contra la que `registerPayment` cierra. Solo aquí se lee el mayor.
    v_func := round(platform.document_settlement_base(p_company, p_document), v_escala);
  else
    -- La deuda es la PARTE del total que sigue debiéndose, reindexada por la tasa: a la tasa de
    -- emisión y sin cobros da exactamente `total_amount` (ADR-0063 §4).
    v_func := round(
      v_doc.total_amount
        * (v_saldo_tx / v_doc.amount_transaction_currency)
        * (v_rate / v_doc.fx_rate),
      v_escala);
  end if;
  return query select v_doc.transaction_currency,
                      round(v_saldo_tx, platform.currency_minor_units(v_doc.transaction_currency)),
                      v_doc.functional_currency, v_rate, v_hoy, v_func;
end;
$function$;

-- ── 15. withdrawal_note_gaps: el retiro corregido netea en cero ─────────────
-- Definición VIVA: 20261005100000 §17. Se AÑADEN los enunciados (6) a (8) y la nota entra en (4).
create or replace function platform.withdrawal_note_gaps(p_company uuid)
 returns table(move_id uuid, problem text)
 language sql
 stable
 set search_path to ''
as $function$
  -- ENUNCIADO (ADR-0082; RLIVA art. 31). En una empresa que FACTURABA en el instante de la salida:
  --   (1) todo retiro GRAVADO (consumo propio, regalo, donación, muestra) registrado desde el corte
  --       (platform.invariant_cutoffs, `withdrawal_invoice`) tiene su FACTURA DE RETIRO, emitida o
  --       anulada. Una Nota de retiro (serie NR) ya no lo cubre;
  --   (2) todo retiro gravado ANTERIOR al corte tiene su Nota de retiro o su factura de retiro: las
  --       notas emitidas no se reescriben (append-only) y siguen en el libro;
  --   (3) la nota o la factura de retiro vigente con IVA tiene ese IVA acreditado al débito fiscal
  --       en el asiento de su salida, o el hecho espera en la cola de pendientes;
  --   (4) ni la factura de retiro ni su nota de crédito cargan cartera: ni cobro, ni saldo a favor,
  --       ni una línea en las cuentas por cobrar dentro del asiento de su salida;
  --   (5) su adquirente es la propia empresa: el RIF congelado del adquirente es el del emisor;
  --   (6) un retiro CORREGIDO —su factura tiene nota de crédito emitida— netea en cero: el kardex
  --       de la factura y de su nota suma cero en cantidad y en valor (la mercancía volvió, al
  --       costo con que salió);
  --   (7) la nota de crédito de un retiro es TOTAL: los importes de su factura;
  --   (8) y su IVA está debitado al débito fiscal en el asiento de su reingreso, o espera en cola.
  -- Los motivos no gravados (uso_en_negocio, activo_fijo, incorporado_inmueble) y las pérdidas
  -- justificadas no son retiro gravado y no entran: está en el enunciado, no en una exclusión.
  with corte as (
    select c.since from platform.invariant_cutoffs c where c.invariant = 'withdrawal_invoice'
  ),
  retiros as (
    select m.id, m.created_at
      from public.inventory_moves m
     where m.company_id = p_company and m.kind = 'salida'
       and m.exit_reason in ('consumo_propio', 'regalo', 'donacion', 'muestra')
       and platform.sales_mode_at(p_company, m.occurred_at) = 'facturas'
  ),
  facturas as (
    select d.id, d.withdrawal_move_id, d.status, d.subtotal_amount, d.tax_amount, d.total_amount,
           d.customer_tax_id_snapshot, d.issuer_tax_id_snapshot
      from public.documents d
     where d.company_id = p_company and d.kind = 'withdrawal_invoice'
       and d.status in ('issued', 'paid', 'annulled')
  ),
  notas as (
    select n.id, n.source_document_id, n.status, n.subtotal_amount, n.tax_amount, n.total_amount,
           f.withdrawal_move_id, f.subtotal_amount as f_subtotal, f.tax_amount as f_tax,
           f.total_amount as f_total
      from public.documents n
      join facturas f on f.id = n.source_document_id
     where n.company_id = p_company and n.kind = 'withdrawal_credit_note'
       and n.status in ('issued', 'paid')
  ),
  debito as (
    select s.account_id from public.company_account_settings s
     where s.company_id = p_company and s.purpose = 'iva_debit_fiscal'
  )
  select r.id, 'retiro_sin_factura'::text
    from retiros r, corte
   where r.created_at >= corte.since
     and not exists (select 1 from facturas f where f.withdrawal_move_id = r.id)
  union all
  select r.id, 'retiro_sin_nota'
    from retiros r, corte
   where r.created_at < corte.since
     and not exists (select 1 from public.inventory_withdrawal_notes n where n.move_id = r.id)
     and not exists (select 1 from facturas f where f.withdrawal_move_id = r.id)
  union all
  select n.move_id, 'nota_sin_iva_en_el_asiento'
    from public.inventory_withdrawal_notes n
   where n.company_id = p_company and n.tax_functional <> 0
     and not exists (
       select 1 from public.journal_generation_queue q
        where q.company_id = p_company and q.status = 'pending'
          and q.source_kind = 'inventory_move' and q.source_id = n.move_id
          and q.source_event = 'stock.withdrawn')
     and coalesce((
       select sum(jl.functional_credit - jl.functional_debit)
         from public.journal_entries e
         join public.journal_lines jl on jl.entry_id = e.id
        where e.company_id = p_company and e.status = 'posted'
          and jl.account_id in (select d.account_id from debito d)
          and e.source_kind = 'inventory_move' and e.source_id = n.move_id
          and e.source_event = 'stock.withdrawn'), 0) <> n.tax_functional
  union all
  select f.withdrawal_move_id, 'factura_de_retiro_sin_iva_en_el_asiento'
    from facturas f
   where f.status = 'issued' and f.tax_amount <> 0
     and not exists (
       select 1 from public.journal_generation_queue q
        where q.company_id = p_company and q.status = 'pending'
          and q.source_kind = 'inventory_move' and q.source_id = f.withdrawal_move_id
          and q.source_event = 'stock.withdrawn')
     and coalesce((
       select sum(jl.functional_credit - jl.functional_debit)
         from public.journal_entries e
         join public.journal_lines jl on jl.entry_id = e.id
        where e.company_id = p_company and e.status = 'posted'
          and jl.account_id in (select d.account_id from debito d)
          and e.source_kind = 'inventory_move' and e.source_id = f.withdrawal_move_id
          and e.source_event = 'stock.withdrawn'), 0) <> f.tax_amount
  union all
  select x.withdrawal_move_id, 'factura_de_retiro_con_cartera'
    from (select f.id, f.withdrawal_move_id, f.status from facturas f
          union all
          select n.id, n.withdrawal_move_id, n.status from notas n) x
   where x.status = 'paid'
      or exists (select 1 from public.payments p where p.document_id = x.id)
      or exists (select 1 from public.customer_credits cc where cc.source_document_id = x.id)
      or exists (
        select 1 from public.journal_entries e
          join public.journal_lines jl on jl.entry_id = e.id
         where e.company_id = p_company
           and e.source_kind = 'inventory_move' and e.source_id = x.withdrawal_move_id
           and jl.account_id in (select s.account_id from public.company_account_settings s
                                  where s.company_id = p_company and s.purpose = 'ar_general'))
  union all
  select f.withdrawal_move_id, 'factura_de_retiro_a_un_tercero'
    from facturas f
   where upper(regexp_replace(coalesce(f.customer_tax_id_snapshot, ''), '[^a-zA-Z0-9]', '', 'g'))
         is distinct from
         upper(regexp_replace(coalesce(f.issuer_tax_id_snapshot, ''), '[^a-zA-Z0-9]', '', 'g'))
  union all
  select n.withdrawal_move_id, 'retiro_corregido_sin_reingreso'
    from notas n
   where exists (
           select 1 from public.inventory_moves m
            where m.company_id = p_company
              and m.source_document_id in (n.id, n.source_document_id)
           having coalesce(sum(m.quantity), 0) <> 0 or coalesce(sum(m.functional_amount), 0) <> 0)
      or not exists (select 1 from public.inventory_moves m
                      where m.company_id = p_company and m.source_document_id = n.id
                        and m.kind = 'entrada')
  union all
  select n.withdrawal_move_id, 'nota_de_credito_de_retiro_no_es_total'
    from notas n
   where n.subtotal_amount <> n.f_subtotal or n.tax_amount <> n.f_tax
      or n.total_amount <> n.f_total
  union all
  select n.withdrawal_move_id, 'nota_de_credito_de_retiro_sin_iva_en_el_asiento'
    from notas n
   where n.tax_amount <> 0
     and not exists (
       select 1 from public.journal_generation_queue q
         join public.inventory_moves m on m.id = q.source_id
        where q.company_id = p_company and q.status = 'pending'
          and q.source_kind = 'inventory_move' and q.source_event = 'stock.received'
          and m.source_document_id = n.id)
     and coalesce((
       select sum(jl.functional_debit - jl.functional_credit)
         from public.journal_entries e
         join public.journal_lines jl on jl.entry_id = e.id
         join public.inventory_moves m on m.id = e.source_id
        where e.company_id = p_company and e.status = 'posted'
          and jl.account_id in (select d.account_id from debito d)
          and e.source_kind = 'inventory_move' and e.source_event = 'stock.received'
          and m.source_document_id = n.id), 0) <> n.tax_amount
$function$;

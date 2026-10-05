-- =============================================================================
-- Ladino — 20261005100800 · LAS GUARDAS DEL RETIRO TIENEN SU PROPIO SQLSTATE (LAD72), Y EL
--   INVARIANTE HACE RUIDO SI LE FALTA SU CORTE (tercera ronda de ADR-0082)
--
-- Módulo: ventas · inventario · fiscal (RIGOR MÁXIMO)
-- Spec: ADR-0082 (nota de la tercera ronda) · docs/04_PLATFORM/ERROR_CATALOG.md
-- HOMOLOGATION_IMPACT: NO — ninguna guarda cambia QUÉ rechaza ni CUÁNDO; cambia el código con
--   que lo dice. El invariante afirma lo mismo y, además, deja de callar si falta su corte.
--
-- DEFECTO 1. `LAD67` significaba dos cosas: «la moneda del pago no es la de su cuenta de
--   tesorería» (migración 29, `platform.assert_payment_account_currency`) y, desde
--   20261005100000, «esto no se puede hacer con una factura de retiro». Un SQLSTATE con dos
--   significados no se puede mapear a un mensaje: quien lo reciba fuera de un `traducir` no sabe
--   cuál de los dos es. Las guardas del retiro pasan a `LAD72`, el siguiente libre.
--   Mensajes, condiciones y orden de las comprobaciones: IDÉNTICOS a su definición viva. El
--   único cambio en cada función es el `errcode`.
--
-- DEFECTO 2. `platform.withdrawal_note_gaps` leía su corte con `from retiros r, corte`: si la
--   fila de `platform.invariant_cutoffs` faltara (una restauración parcial, un borrado), el
--   producto cartesiano daría CERO filas y el invariante respondería «todo bien» sin haber
--   mirado un solo retiro. Ausencia de fallo leída como éxito (ADR-0023).
-- ARREGLO. Sin corte: (a) una fila `falta_el_corte`, sin movimiento, que dice por qué; y (b)
--   todo retiro se juzga como POSTERIOR al corte —lo más estricto: exige factura—. Se eligió el
--   modo de fallo ruidoso: un hueco de más se ve y se corrige; un cero falso, nunca.
--
-- FUNCIONES REDEFINIDAS, y de cuál parten (la última en orden limpio):
--   platform.assert_withdrawal_invoice            ← 20261005100500 §3
--   platform.assert_withdrawal_invoice_move       ← 20261005100000 §3
--   platform.reject_withdrawal_invoice_settlement ← 20261005100500 §4
--   platform.reject_withdrawal_invoice_return     ← 20261005100500 §4
--   platform.reject_withdrawal_customer_credit    ← 20261005100500 §4
--   platform.withdrawal_note_gaps                 ← 20261005100500 §15
--   Ninguna migración posterior (1100xx-1106xx, 1300xx, 140000, 150000) las redefine.
-- COMPATIBILIDAD: expand. La API saliente no conoce la factura de retiro; la entrante traduce
--   `LAD72` (dominio y `POR_SQLSTATE`). `LAD67` sigue siendo, solo, la moneda de la cuenta.
--   Va JUSTO DESPUÉS del `git pull`, tras 20261005100700, en la misma ventana que la familia.
-- REVERSIBILIDAD (con datos vivos): SÍ, entera: son `create or replace` sin datos. Volver atrás
--   es reaplicar las definiciones de 20261005100500 y 20261005100000 (y recuperar el código con
--   dos significados y el silencio sin corte). Ningún dato guarda el SQLSTATE.
-- =============================================================================

-- ── 1. La forma de la factura de retiro y de su nota ────────────────────────
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
        using errcode = 'LAD72';
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
        using errcode = 'LAD72';
    end if;
    if tg_op = 'UPDATE' and old.status in ('issued', 'paid', 'annulled') then
      if new.status = 'annulled' and old.status <> 'annulled' then
        raise exception
          'La nota de crédito de un retiro no se anula: si el retiro sí ocurrió, regístralo de nuevo (ADR-0082).'
          using errcode = 'LAD72';
      end if;
      return new;
    end if;
    if new.status = 'issued' then
      if v_o.status <> 'issued' then
        raise exception
          'La factura de retiro que se quiere corregir no está vigente (está anulada).'
          using errcode = 'LAD72';
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
          using errcode = 'LAD72';
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
        using errcode = 'LAD72';
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
      using errcode = 'LAD72';
  end if;
  -- AF3-07: el tipo de contribuyente congelado es el de la HISTORIA al día de la emisión.
  if new.customer_taxpayer_type_snapshot is distinct from
     platform.taxpayer_type_at(new.company_id, platform.caracas_day(new.issued_at)) then
    raise exception
      'la factura de retiro congela el tipo de contribuyente que la empresa tenía el día de la emisión (ADR-0072, ADR-0082)'
      using errcode = 'LAD72';
  end if;
  return new;
end;
$$;

-- ── 2. La salida que documenta, al confirmar ────────────────────────────────
create or replace function platform.assert_withdrawal_invoice_move()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.kind <> 'withdrawal_invoice' or new.status not in ('issued', 'annulled') then
    return null;
  end if;
  if not exists (
       select 1 from public.inventory_moves m
        where m.id = new.withdrawal_move_id and m.company_id = new.company_id
          and m.kind = 'salida'
          and m.exit_reason in ('consumo_propio', 'regalo', 'donacion', 'muestra')
          and m.source_document_id = new.id) then
    raise exception
      'una factura de retiro documenta una salida de inventario de la misma empresa, con motivo de retiro, que la señala como su documento (ADR-0082)'
      using errcode = 'LAD72';
  end if;
  return null;
end;
$$;

-- ── 3. Sin cartera: cobro, devolución y saldo a favor ───────────────────────
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
      using errcode = 'LAD72';
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
      using errcode = 'LAD72';
  end if;
  return new;
end;
$$;

create or replace function platform.reject_withdrawal_customer_credit()
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
      using errcode = 'LAD72';
  end if;
  return new;
end;
$$;

-- ── 4. withdrawal_note_gaps: sin corte, ruido ───────────────────────────────
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
  --   (0) el corte EXISTE. Si faltara su fila, este invariante no calla: da una fila
  --       `falta_el_corte` y juzga todo retiro como posterior al corte (20261005100800);
  -- Los motivos no gravados (uso_en_negocio, activo_fijo, incorporado_inmueble) y las pérdidas
  -- justificadas no son retiro gravado y no entran: está en el enunciado, no en una exclusión.
  with corte as (
    -- SIEMPRE una fila. Sin corte registrado, '-infinity': todo retiro es posterior al corte y
    -- exige factura. Un `from retiros r, corte` contra cero filas daría un cero falso.
    select coalesce((select c.since from platform.invariant_cutoffs c
                      where c.invariant = 'withdrawal_invoice'),
                    '-infinity'::timestamptz) as since
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
  select null::uuid, 'falta_el_corte'::text
   where not exists (select 1 from platform.invariant_cutoffs c
                      where c.invariant = 'withdrawal_invoice')
  union all
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

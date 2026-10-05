-- =============================================================================
-- Ladino — 20261005100000 · EL RETIRO DE INVENTARIO SE FACTURA (ADR-0082)
--
-- Módulo: inventario · ventas · fiscal · contabilidad (RIGOR MÁXIMO)
-- Spec: ADR-0082 (enmienda ADR-0078 decisión 2; toca ADR-0071) · ADR-0061 · ADR-0079
-- Hallazgos: AF3-01, AF3-03, AF3-05, AF3-07 (auditoría fiscal de la ola 3). AF3-06: solo la
--   anulación del mismo día; la nota de crédito sobre la factura de retiro queda ABIERTA y falla
--   activamente (§4). AF3-02b y AF3-04: sin cambio de esquema (P-81, P-77).
-- HOMOLOGATION_IMPACT: YES — el retiro deja de emitir un documento interno (Nota de retiro, serie
--   NR, sin control) y emite una FACTURA: correlativo de la serie de facturas y número de CONTROL
--   del talonario (ADR-0071). Entra al libro de ventas y a la declaración como venta a la propia
--   empresa. Norma: RLIVA art. 31, leído en reproducción no oficial (VALIDAR-SENIAT P-76).
--
-- EL DEFECTO (AF3-01). El RLIVA art. 31 manda emitir «obligatoriamente la correspondiente
--   factura» por el retiro, la desincorporación, el autoconsumo y el faltante. Ladino emitía una
--   Nota de retiro interna, sin número de control.
--
-- LA DECISIÓN, en el esquema:
--   1. un KIND nuevo de documento, `withdrawal_invoice`. Es factura para todo lo fiscal (numeración,
--      control, libro, declaración, importes, regla del papel) y NO es cartera para nadie: todas
--      las lecturas de deuda enumeran en positivo los kinds que cargan cartera
--      (`invoice`, `receipt`, `debit_note`: customer_debt_today, customer_overdue_today, ar_aging,
--      receivables_ledger_gap, fx_revaluation_items), así que un kind nuevo queda fuera POR
--      CONSTRUCCIÓN, sin tocar ninguna y sin lista de exclusiones. El olvido posible es el
--      contrario —una lectura FISCAL que no lo incluya— y ese hace ruido: lo cazan
--      withdrawal_note_gaps, book_ledger_reconciliation y accounting_coverage_gaps;
--   2. `documents.withdrawal_move_id`: la salida del kardex que la factura documenta. Única (clave
--      natural: una salida, una factura), obligatoria al emitir y congelada después;
--   3. el correlativo es el de la serie de FACTURAS (el mismo contador, `claim_document_number`
--      con 'invoice'): un índice único cruza los dos kinds para que el esquema lo sostenga;
--   4. una factura de retiro no se cobra, no pasa a `paid`, no lleva vencimiento, no admite (todavía)
--      nota de crédito, de débito ni devolución: cada cosa FALLA activamente (CHECK o trigger);
--   5. tres motivos de salida NO gravados (LIVA art. 4.3 in fine; VALIDAR-TRIBUTARIO P-82):
--      `uso_en_negocio`, `activo_fijo`, `incorporado_inmueble`. CHECK ampliado (expand);
--   6. las funciones del libro, la declaración, la emisión y los invariantes leen el kind nuevo.
--      Cada una parte de su definición VIVA (pg_get_functiondef sobre la base con todas las
--      migraciones hasta 20261004210100) con sustituciones puntuales; la última migración que
--      define cada una va citada en su bloque;
--   7. `withdrawal_note_gaps` cambia de enunciado: desde el corte, retiro ⇒ FACTURA de retiro.
--
-- LAS NOTAS DE RETIRO YA EMITIDAS (serie NR) no se tocan (append-only): siguen en el libro por la
--   rama que ya las leía. En producción la tabla está vacía. El corte va en el ENUNCIADO del
--   invariante (`platform.invariant_cutoffs`, fila `withdrawal_invoice`), no en una lista de perdones.
--   La tabla `inventory_withdrawal_notes` sigue aceptando INSERT: la API saliente los hace hasta
--   que se despliega la nueva (expand/contract); cerrarla es de una migración posterior.
--
-- COMPATIBILIDAD CON LA API DESPLEGADA (migración y deploy no son atómicos):
--   · la API saliente no conoce el kind ni la columna: sus INSERT dejan `withdrawal_move_id` NULL,
--     que el CHECK admite en todo kind que no sea el nuevo. Nada de lo que ya escribe cambia;
--   · un retiro hecho por la API saliente DESPUÉS de esta migración emite todavía una Nota NR, y
--     `withdrawal_note_gaps` lo señala (`retiro_sin_factura`): es el modo de fallo ruidoso y es
--     cierto —la norma pide factura—. Los retiros no están liberados en producción (R-70).
--   Va JUSTO DESPUÉS del `git pull` (depende de las migraciones de las olas 3 y 4).
--
-- REVERSIBILIDAD (con datos vivos):
--   · SIN facturas de retiro emitidas: reversible entera. Se restituyen las funciones a su
--     definición anterior (la citada en cada bloque), se sueltan los triggers, los índices, el
--     CHECK y la columna, y `documents_kind_chk` vuelve a su lista;
--   · CON facturas de retiro emitidas: NO reversible. Son documentos fiscales con número de control
--     consumido (regla 1): no se borran ni cambian de kind. Volver las funciones atrás las sacaría
--     del libro con su débito en el mayor (`book_ledger_reconciliation` lo señalaría). Lo único
--     que se puede hacer es dejar de emitirlas;
--   · los motivos nuevos: con salidas ya registradas con ellos no se estrecha el CHECK (kardex
--     append-only); se dejan de ofrecer.
-- =============================================================================

-- ── 1. El kind y la salida que documenta ────────────────────────────────────
alter table public.documents drop constraint documents_kind_chk;
alter table public.documents add constraint documents_kind_chk
  check (kind = any (array['quote', 'order', 'invoice', 'credit_note', 'debit_note', 'receipt',
                           'receipt_return', 'withdrawal_invoice']));

alter table public.documents add column withdrawal_move_id uuid;
-- DIFERIDA: la factura se emite ANTES de mover el kardex (mismo orden de candados que la venta:
-- talonario → existencia), con el id de la salida ya decidido; la salida entra en la misma
-- transacción y la FK se comprueba al confirmar.
alter table public.documents add constraint documents_withdrawal_move_fk
  foreign key (withdrawal_move_id) references public.inventory_moves (id)
  deferrable initially deferred;
alter table public.documents add constraint documents_withdrawal_shape_chk check (
  (kind = 'withdrawal_invoice' or withdrawal_move_id is null)
  and (kind <> 'withdrawal_invoice'
       or (status in ('draft', 'confirmed', 'cancelled') or withdrawal_move_id is not null))
  -- No hay cuenta por cobrar: nunca queda «pagada», ni vence, ni corrige a otro documento.
  and (kind <> 'withdrawal_invoice'
       or (status <> 'paid' and due_date is null and source_document_id is null)));
comment on column public.documents.withdrawal_move_id is
  'ADR-0082: la salida del kardex (retiro: consumo propio, regalo, donación, muestra) que esta '
  'factura de retiro documenta. Solo en kind = withdrawal_invoice; única, obligatoria al emitir y '
  'congelada después. El asiento de la factura es el de esa salida (inventory_move/stock.withdrawn).';

-- La clave natural del caso de uso (la segunda defensa tras la Idempotency-Key): una salida, una
-- factura de retiro.
create unique index documents_withdrawal_move_uidx
  on public.documents (withdrawal_move_id) where withdrawal_move_id is not null;
-- La factura y la factura de retiro comparten correlativo (el contador de 'invoice'). El índice
-- de siempre es por kind: este cruza los dos, para que un número repetido entre ellos no dependa
-- de que todo el mundo llame al mismo contador.
create unique index documents_invoice_number_uidx
  on public.documents (company_id, series, document_number)
  where document_number is not null and kind in ('invoice', 'withdrawal_invoice');
create index documents_withdrawal_idx
  on public.documents (company_id, issued_at) where kind = 'withdrawal_invoice';

-- ── 2. El corte del invariante ───────────────────────────────────────────────
insert into platform.invariant_cutoffs (invariant, reason) values
  ('withdrawal_invoice',
   'Antes de 20261005100000 el retiro de inventario emitía una Nota de retiro interna (serie NR, sin número de control; ADR-0078 decisión 2). Esas notas son append-only y siguen en el libro de ventas como se emitieron; desde el corte, el retiro emite factura (RLIVA art. 31, ADR-0082).');

-- ── 3. La forma de la factura de retiro ─────────────────────────────────────
create function platform.assert_withdrawal_invoice()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_origen text;
begin
  -- AF3-06, ABIERTO: la nota de crédito o de débito sobre una factura de retiro no está construida.
  -- El camino general de la nota mueve cartera y saldo a favor del cliente, y aquí el adquirente
  -- es la propia empresa: dejarlo pasar escribiría una deuda que nadie tiene. Falla activamente.
  if new.kind in ('credit_note', 'debit_note') and new.source_document_id is not null
     and (tg_op = 'INSERT' or new.source_document_id is distinct from old.source_document_id) then
    select o.kind into v_origen from public.documents o where o.id = new.source_document_id;
    if v_origen = 'withdrawal_invoice' then
      raise exception
        'Una factura de retiro todavía no se corrige con nota: si se emitió por error, anúlala el mismo día con el original y las copias en la mano (ADR-0082).'
        using errcode = 'LAD67';
    end if;
  end if;

  if new.kind <> 'withdrawal_invoice' then return new; end if;

  if tg_op = 'UPDATE' and old.status in ('issued', 'paid', 'annulled') then
    if new.withdrawal_move_id is distinct from old.withdrawal_move_id then
      raise exception
        'la salida que documenta una factura de retiro emitida no se cambia (ADR-0082)'
        using errcode = 'LAD06';
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
revoke all on function platform.assert_withdrawal_invoice() from public, anon, authenticated;

create trigger documents_07_withdrawal_invoice
  before insert or update on public.documents
  for each row execute function platform.assert_withdrawal_invoice();

-- Y la salida que documenta, comprobada AL CONFIRMAR (la salida entra después que la factura): de
-- esta empresa, una salida, con motivo de retiro GRAVADO, y que apunta a esta factura.
create function platform.assert_withdrawal_invoice_move()
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
      using errcode = 'LAD67';
  end if;
  return null;
end;
$$;
revoke all on function platform.assert_withdrawal_invoice_move() from public, anon, authenticated;

create constraint trigger documents_95_withdrawal_move
  after insert or update on public.documents
  deferrable initially deferred
  for each row when (new.kind = 'withdrawal_invoice')
  execute function platform.assert_withdrawal_invoice_move();

-- ── 4. Sin cartera: ni cobro ni devolución ──────────────────────────────────
-- La exclusión de la deuda es por construcción (el kind no está en ninguna lectura de cartera).
-- Esto cierra la otra mitad: que nadie pueda ESCRIBIR un hecho de cartera sobre ella.
create function platform.reject_withdrawal_invoice_settlement()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_doc uuid;
begin
  v_doc := case tg_table_name when 'payments' then new.document_id
                              else new.source_document_id end;
  if exists (select 1 from public.documents d
              where d.id = v_doc and d.kind = 'withdrawal_invoice') then
    raise exception
      'Una factura de retiro no se cobra ni se devuelve: el adquirente es la propia empresa y no hay cuenta por cobrar (ADR-0082).'
      using errcode = 'LAD67';
  end if;
  return new;
end;
$$;
revoke all on function platform.reject_withdrawal_invoice_settlement()
  from public, anon, authenticated;

create trigger payments_05_no_withdrawal_invoice
  before insert on public.payments
  for each row execute function platform.reject_withdrawal_invoice_settlement();
create trigger returns_05_no_withdrawal_invoice
  before insert on public.returns
  for each row execute function platform.reject_withdrawal_invoice_settlement();

-- ── 5. Los motivos no gravados (AF3-03) ─────────────────────────────────────
-- Expand: se AÑADEN tres valores. La API saliente no los escribe.
alter table public.inventory_moves drop constraint inventory_moves_exit_reason_chk;
alter table public.inventory_moves add constraint inventory_moves_exit_reason_chk
  check (exit_reason is null
         or (kind = 'salida'
             and exit_reason in ('merma', 'rotura', 'vencido', 'faltante',
                                 'consumo_propio', 'regalo', 'donacion', 'muestra',
                                 'uso_en_negocio', 'activo_fijo', 'incorporado_inmueble')));
comment on column public.inventory_moves.exit_reason is
  'Motivo de una salida con motivo (ADR-0078 §2, ADR-0082): merma, rotura, vencido y faltante son '
  'pérdida (5.1.08, con evidencia); consumo_propio, regalo, donacion y muestra son retiro gravado '
  '(LIVA art. 4.3; RLIVA art. 31: FACTURA de retiro en una empresa que factura); uso_en_negocio, '
  'activo_fijo e incorporado_inmueble son salidas NO gravadas (LIVA art. 4.3 in fine, '
  'VALIDAR-TRIBUTARIO P-82): sin débito y sin factura. NULL en toda salida anterior a '
  '20261003110000 y en las salidas de una venta o una receta.';

-- ── 6. La emisión juzga la factura de retiro como factura ──
-- Definición VIVA: la del catálogo tras 20261004210100 (última redefinición en el orden limpio; ver el informe). Cambian tres condiciones, marcadas con ADR-0082 o con el kind añadido.
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
  if not ((case when new.kind = 'withdrawal_invoice' then 'invoice' else new.kind end)
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
  if new.kind in ('invoice', 'withdrawal_invoice', 'credit_note', 'debit_note') then
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

-- ── 7. El contribuyente formal tampoco retira con línea gravada ──
-- Definición VIVA: la del catálogo tras 20261004210100. Se añade el kind.
CREATE OR REPLACE FUNCTION platform.assert_formal_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_doc record;
begin
  select d.company_id, d.kind, d.status, d.issued_at into v_doc
    from public.documents d where d.id = new.document_id;
  if v_doc.status in ('issued', 'paid')
     and v_doc.kind in ('invoice', 'withdrawal_invoice', 'debit_note')
     and platform.taxpayer_type_at(v_doc.company_id, platform.caracas_day(v_doc.issued_at))
         = 'formal' then
    raise exception
      'Con esta condición no puedes vender productos gravados; si tu negocio cambió, actualiza el tipo de contribuyente (contribuyente formal: LIVA art. 8)'
      using errcode = 'LAD99';
  end if;
  return new;
end;
$function$;

-- ── 8. El libro de ventas lee la factura de retiro ──
-- Definición VIVA: 20261003110100 (sales_book). Se añade el kind y de dónde sale su asiento. La rama de las Notas de retiro (serie NR) queda como estaba: las ya emitidas siguen en el libro.
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
                    and e.source_event = 'stock.withdrawn' and e.status = 'posted'
                  limit 1)
              else d.journal_entry_id end,
         coalesce(sum(dl.line_total_functional) filter (where pr.system_code = 'igtf'), 0)
           * f.factor
    from public.documents d
    cross join lateral (
      select case when d.status = 'annulled' then 0
                  when d.kind = 'credit_note' then -1
                  else 1 end as factor
    ) f
    join public.customers c on c.id = d.customer_id
    left join public.document_lines dl on dl.document_id = d.id
    left join public.products pr on pr.id = dl.product_id
   where d.company_id = p_company
     and d.kind in ('invoice', 'withdrawal_invoice', 'credit_note', 'debit_note')
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

-- ── 9. El resumen del libro (art. 72) ──
-- Definición VIVA: 20261003110000 (sales_book_summary). La factura de retiro es venta, no ajuste.
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
          select case when d.kind = 'credit_note' then -1 else 1 end as factor) f
       where d.company_id = p_company
         and d.kind in ('invoice', 'withdrawal_invoice', 'credit_note', 'debit_note')
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

-- ── 10. La declaración de IVA ──
-- Definición VIVA: la del catálogo tras 20261004210100 (recompute_iva_period). Se añade el kind.
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
    select case d.kind when 'credit_note' then -1 else 1 end as signo,
           l.tax_rate_snapshot as alicuota,
           l.line_subtotal_functional as base,
           (l.line_total_functional - l.line_subtotal_functional) as impuesto,
           l.tax_amount as impuesto_transaccion,
           d.kind
      from public.documents d
      join public.document_lines l on l.document_id = d.id
     where d.company_id = p_company
       and d.kind in ('invoice', 'withdrawal_invoice', 'credit_note', 'debit_note')
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

-- ── 11. fiscal_amount_gaps cubre la factura de retiro ──
-- Definición VIVA: la del catálogo tras 20261004210100. Se añade el kind, y se dice en el enunciado.
CREATE OR REPLACE FUNCTION platform.fiscal_amount_gaps(p_company uuid)
 RETURNS TABLE(document_id uuid, problem text, expected numeric, found numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  -- ENUNCIADO: en todo documento fiscal (factura, factura de retiro, nota de crédito, nota de débito) emitido
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
       and d.kind in ('invoice', 'withdrawal_invoice', 'credit_note', 'debit_note')
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
-- Definición VIVA: la del catálogo tras 20261004210100. Se añade el kind.
CREATE OR REPLACE FUNCTION platform.company_has_fiscal_documents(p_company uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.documents d
     where d.company_id = p_company
       and d.kind in ('invoice', 'withdrawal_invoice', 'credit_note', 'debit_note')
       and d.status in ('issued', 'paid', 'annulled'))
  or exists (
    select 1 from public.supplier_invoices i
     where i.company_id = p_company and i.status in ('posted', 'paid'))
  or exists (
    select 1 from public.retention_receipts r
     where r.company_id = p_company and r.status in ('issued', 'annulled'))
$function$;

-- ── 13. accounting_coverage_gaps: la factura de retiro, cubierta por el asiento de su salida ──
-- Definición VIVA: la del catálogo tras 20261004210100. Solo se AÑADE la última rama.
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
$function$;

-- ── 14. La regla del papel vale para la factura de retiro ──
-- Definición VIVA: 20261004160300 (invoice_annulment_blockers). Se añade el kind.
CREATE OR REPLACE FUNCTION platform.invoice_annulment_blockers(p_company uuid, p_document uuid, p_at timestamp with time zone)
 RETURNS TABLE(reason text, priority integer)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select x.reason, x.priority from (
    -- Falla cerrada: lo que no se ve no se puede anular.
    select 'not_found'::text as reason, 0 as priority
     where not exists (select 1 from public.documents d
                        where d.id = p_document and d.company_id = p_company)
    union all
    select b.reason, b.priority
      from public.documents d
     cross join lateral (
       -- Día de Caracas contra día de Caracas: nunca un date contra un instante.
       select 'not_same_day'::text as reason, 1 as priority
        where platform.caracas_day(d.issued_at) <> platform.caracas_day(p_at)
       union all
       -- El día de la emisión cae en un período de IVA DECLARADO antes de p_at. Declara solo una
       -- generación hecha después de cerrar su período (B-1, 20261002120400): una vista previa
       -- del período en curso no. Día contra día (caracas_day de la generación contra period_to).
       select 'period_declared', 2
        where exists (
          select 1 from public.iva_period_results r
           where r.company_id = d.company_id
             and platform.caracas_day(d.issued_at) between r.period_from and r.period_to
             and r.period_to < platform.caracas_day(r.created_at)
             and r.created_at <= p_at)
       union all
       -- Instante contra instante: una CAJA de la empresa se cerró DESPUÉS de emitir y antes de
       -- p_at. Cualquier caja (kind = 'cash'), tenga o no cobros el documento; de la misma
       -- sucursal cuando el cierre y el documento la llevan.
       select 'cash_closed', 3
        where exists (
          select 1 from public.cash_closings cc
            join public.company_accounts ca on ca.id = cc.account_id
           where cc.company_id = d.company_id
             and ca.kind = 'cash'
             and cc.closed_at >= d.issued_at
             and cc.closed_at <= p_at
             and (cc.branch_id is null or d.branch_id is null or cc.branch_id = d.branch_id))
     ) b
     where d.id = p_document
       and d.company_id = p_company
       and d.kind in ('invoice', 'withdrawal_invoice')
       and d.issued_at is not null
  ) x
  order by x.priority
$function$;

-- ── 15. annulment_paper_gaps la vigila ──
-- Definición VIVA: 20261004160300 (annulment_paper_gaps). Se añade el kind en sus dos ramas.
CREATE OR REPLACE FUNCTION platform.annulment_paper_gaps(p_company uuid)
 RETURNS TABLE(document_id uuid, problem text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_since timestamptz;
begin
  select c.since into v_since
    from platform.invariant_cutoffs c where c.invariant = 'annulment_paper_gaps';
  if v_since is null then
    raise exception 'annulment_paper_gaps: falta su corte en platform.invariant_cutoffs'
      using errcode = 'LAD37';
  end if;

  -- (a), (b), (c): la misma regla que obedece annulInvoice, preguntada a la hora de la anulación.
  return query
    select d.id, b.reason
      from public.documents d
     cross join lateral platform.invoice_annulment_blockers(d.company_id, d.id, d.annulled_at) b
     where d.company_id = p_company
       and d.kind in ('invoice', 'withdrawal_invoice')
       and d.status = 'annulled'
       and d.annulled_at >= v_since;

  -- (d): el acta de la anulación dice que la persona respondió por el original y las copias.
  return query
    select d.id, 'originals_not_confirmed'::text
      from public.documents d
     where d.company_id = p_company
       and d.kind in ('invoice', 'withdrawal_invoice')
       and d.status = 'annulled'
       and d.annulled_at >= v_since
       and not exists (
         select 1 from public.audit_events a
          where a.company_id = d.company_id
            and a.aggregate_id = d.id
            and a.event_type = 'fiscal.invoice.annulled'
            and a.payload ->> 'originals_in_hand' = 'true');
end;
$function$;

-- ── 16. annulled_stock_gaps: la factura de retiro anulada netea su kardex ──
-- Definición VIVA: 20260915160000 (annulled_stock_gaps). Se añade el kind.
CREATE OR REPLACE FUNCTION platform.annulled_stock_gaps(p_company uuid)
 RETURNS TABLE(document_id uuid, kind text, quantity numeric, value numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select d.id, d.kind, sum(m.quantity), sum(m.functional_amount)
    from public.documents d
    join public.inventory_moves m
      on m.company_id = d.company_id and m.source_document_id = d.id
   where d.company_id = p_company
     and d.status = 'annulled'
     and d.kind in ('invoice', 'receipt', 'withdrawal_invoice')
   group by d.id, d.kind
  having sum(m.quantity) <> 0 or sum(m.functional_amount) <> 0
$function$;

-- ── 17. withdrawal_note_gaps: retiro ⇒ FACTURA de retiro con su IVA ─────────
-- Definición VIVA: 20261003110100. Cambia el ENUNCIADO (CLAUDE.md §3: no se perdona, se dice).
-- Sigue siendo `security invoker` como toda la familia `*_gaps` (ADR-0078, re-revisión B2): lee
-- tablas que comparten la policy de lectura por empresa.
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
  --   (4) una factura de retiro no carga cartera: ni cobro, ni saldo a favor, ni una línea en las
  --       cuentas por cobrar dentro del asiento de su salida;
  --   (5) su adquirente es la propia empresa: el RIF congelado del adquirente es el del emisor.
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
    select d.id, d.withdrawal_move_id, d.status, d.tax_amount,
           d.customer_tax_id_snapshot, d.issuer_tax_id_snapshot
      from public.documents d
     where d.company_id = p_company and d.kind = 'withdrawal_invoice'
       and d.status in ('issued', 'paid', 'annulled')
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
          and jl.account_id in (select s.account_id from public.company_account_settings s
                                 where s.company_id = p_company
                                   and s.purpose = 'iva_debit_fiscal')
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
          and jl.account_id in (select s.account_id from public.company_account_settings s
                                 where s.company_id = p_company
                                   and s.purpose = 'iva_debit_fiscal')
          and e.source_kind = 'inventory_move' and e.source_id = f.withdrawal_move_id
          and e.source_event = 'stock.withdrawn'), 0) <> f.tax_amount
  union all
  select f.withdrawal_move_id, 'factura_de_retiro_con_cartera'
    from facturas f
   where f.status = 'paid'
      or exists (select 1 from public.payments p where p.document_id = f.id)
      or exists (select 1 from public.customer_credits cc where cc.source_document_id = f.id)
      or exists (
        select 1 from public.journal_entries e
          join public.journal_lines jl on jl.entry_id = e.id
         where e.company_id = p_company
           and e.source_kind = 'inventory_move' and e.source_id = f.withdrawal_move_id
           and jl.account_id in (select s.account_id from public.company_account_settings s
                                  where s.company_id = p_company and s.purpose = 'ar_general'))
  union all
  select f.withdrawal_move_id, 'factura_de_retiro_a_un_tercero'
    from facturas f
   where upper(regexp_replace(coalesce(f.customer_tax_id_snapshot, ''), '[^a-zA-Z0-9]', '', 'g'))
         is distinct from
         upper(regexp_replace(coalesce(f.issuer_tax_id_snapshot, ''), '[^a-zA-Z0-9]', '', 'g'))
$function$;

comment on function platform.withdrawal_note_gaps(uuid) is
  'Invariante (respuesta correcta: cero filas). ADR-0082: desde el corte, retiro gravado de inventario ⇒ factura de retiro con su IVA en el asiento de su salida, sin cartera y a nombre de la propia empresa. Antes del corte, la Nota de retiro (serie NR) sigue valiendo.';

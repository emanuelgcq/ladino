-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 39 — La deuda se ancla en la moneda del documento (ADR-0047)
--
-- ADR-0046 (migración 38) denominó la venta en funcional y el dueño lo tumbó
-- con una bodega: fiar 1 USD el lunes a 100 Bs y cobrar 100 Bs el viernes,
-- cuando el dólar vale 150, es regalar el margen. Se restituye ADR-0020 (el
-- documento nace en la moneda de la lista) y se corrige lo que aquel modelo
-- tampoco decía: el saldo vivía en funcional CONGELADO a la tasa de emisión,
-- así que el cobro en Bs días después pedía los Bs del día de la venta.
--
--   1. El gate LAD70 de la migración 38 se elimina (trigger al cuerpo de la
--      37) y las columnas pricing_* se van: con la denominación restituida,
--      la procedencia vuelve a los siete campos de ADR-0020. Ningún dato
--      productivo las usó — la 38 jamás corrió bajo una API desplegada.
--   2. `document_balance_transaction`: la deuda EN LA MONEDA DEL DOCUMENTO.
--      Cada cobro se valora en esa moneda: si vino en ella, su importe; si
--      vino en otra, su funcional ÷ tasa (doc→funcional) DEL DÍA DEL PAGO.
--   3. `document_debt_today`: lo que se debe HOY, en funcional — para
--      documentos en divisa, saldo transacción × tasa de HOY; para el resto,
--      el saldo funcional de siempre. Deudas y estado de cuenta cobran por
--      esta función.
--
-- Sin tasa no se valora: las dos funciones RECHAZAN antes que inventar.
-- Reversibilidad: funciones nuevas y drop de columnas sin datos productivos.
-- HOMOLOGATION_IMPACT: NO (numeración y libros intactos).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1a. El trigger vuelve al cuerpo de la migración 37 (cae el gate LAD70) ──
-- Copia ENTERA del cuerpo vigente menos el bloque de denominación: una
-- reconstrucción parcial es cómo se pierde vocabulario en silencio.
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

-- ── 1b. Las columnas del interregno se van ──────────────────────────────────
alter table public.documents
  drop constraint documents_pricing_coherence_chk,
  drop constraint documents_pricing_currency_fk,
  drop column pricing_currency,
  drop column pricing_fx_rate,
  drop column pricing_rate_source,
  drop column pricing_rate_timestamp;

-- ── 2. La deuda en la moneda del documento ──────────────────────────────────
create function platform.document_balance_transaction(p_company uuid, p_document uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_doc record;
  v_paid numeric := 0;
  v_p record;
  v_rate numeric;
begin
  select d.id, d.transaction_currency, d.functional_currency,
         d.amount_transaction_currency
    into v_doc
    from public.documents d
   where d.id = p_document and d.company_id = p_company
     and d.status in ('issued', 'paid');
  if not found then return null; end if;

  for v_p in
    select p.currency, p.amount, p.functional_amount, p.paid_at::date as paid_on
      from public.payments p where p.document_id = v_doc.id
  loop
    if v_p.currency = v_doc.transaction_currency then
      v_paid := v_paid + v_p.amount;
    else
      -- El cobro vino en otra moneda: se valora en la del documento con la
      -- tasa doc→funcional DEL DÍA DEL PAGO. Sin tasa no se inventa.
      v_rate := platform.rate_at(v_doc.transaction_currency, v_doc.functional_currency,
                                 v_p.paid_on);
      if v_rate is null then
        raise exception
          'no hay tasa % → % vigente al % para valorar un cobro: cárgala con su fuente',
          v_doc.transaction_currency, v_doc.functional_currency, v_p.paid_on
          using errcode = 'LAD51';
      end if;
      v_paid := v_paid + round(v_p.functional_amount / v_rate, 8);
    end if;
  end loop;

  return v_doc.amount_transaction_currency - v_paid;
end;
$$;
comment on function platform.document_balance_transaction(uuid, uuid) is
  'ADR-0047: la deuda EN LA MONEDA DEL DOCUMENTO. Un cobro en otra moneda se '
  'valora con la tasa del DÍA DEL PAGO. Es el saldo que decide `paid` cuando '
  'el documento está en divisa: pagar los USD completos salda, suba o baje la '
  'tasa — el ajuste es del diferencial, no del estado.';
revoke execute on function platform.document_balance_transaction(uuid, uuid) from public;
grant execute on function platform.document_balance_transaction(uuid, uuid)
  to authenticated, ladino_api;

-- ── 3. Lo que se debe HOY, en funcional ─────────────────────────────────────
create function platform.document_debt_today(p_company uuid, p_document uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_doc record;
  v_rate numeric;
begin
  select d.transaction_currency, d.functional_currency into v_doc
    from public.documents d
   where d.id = p_document and d.company_id = p_company
     and d.status in ('issued', 'paid');
  if not found then return null; end if;

  if v_doc.transaction_currency = v_doc.functional_currency then
    return platform.document_balance(p_company, p_document);
  end if;

  v_rate := platform.rate_at(v_doc.transaction_currency, v_doc.functional_currency,
                             current_date);
  if v_rate is null then
    raise exception
      'no hay tasa % → % vigente hoy para valorar la deuda: cárgala con su fuente',
      v_doc.transaction_currency, v_doc.functional_currency
      using errcode = 'LAD51';
  end if;
  return round(platform.document_balance_transaction(p_company, p_document) * v_rate, 8);
end;
$$;
comment on function platform.document_debt_today(uuid, uuid) is
  'ADR-0047: lo que se debe HOY, en funcional. La deuda del lunes se cobra a '
  'la tasa del viernes: divisa → saldo transacción × tasa de HOY; funcional → '
  'el saldo de siempre. Deudas, estado de cuenta y el POS preguntan AQUÍ.';
revoke execute on function platform.document_debt_today(uuid, uuid) from public;
grant execute on function platform.document_debt_today(uuid, uuid)
  to authenticated, ladino_api;

-- ── Autochequeo ─────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'documents'
                and column_name like 'pricing%') then
    raise exception 'LAD52: las columnas pricing_* debían eliminarse';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'platform'
         and p.proname in ('document_balance_transaction', 'document_debt_today')) <> 2 then
    raise exception 'LAD52: faltan las funciones de deuda de ADR-0047';
  end if;
end $$;

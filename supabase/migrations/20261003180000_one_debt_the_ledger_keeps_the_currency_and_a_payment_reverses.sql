-- =============================================================================
-- Ladino — UNA SOLA DEUDA, EL MAYOR GUARDA LA DIVISA Y UN COBRO SE PUEDE REVERSAR
-- (ADR-0075 §5, §6 y §8; E-11, F-04, J-04; R-61, P-67, `ar.retention.correct`)
--
-- Módulo: ventas · tesorería · contabilidad. Rigor máximo (dinero, con datos vivos).
-- Spec:   ADR-0075 · ADR-0020 · ADR-0061 · JOURNAL_AND_CLOSING_SPEC.md · IGTF_SPEC.md.
-- Reversible: SÍ para el esquema mientras no exista ninguna reversa; con reversas escritas, NO
--   sin perder hechos — ver al final.
-- HOMOLOGATION_IMPACT: YES — anular un comprobante de retención soportada lo saca del libro de
--   ventas y de la declaración del período (los lectores ya filtraban `status = 'registered'`);
--   la restitución de un IGTF percibido lo deja `pendiente_reintegro` (VALIDAR-TRIBUTARIO P-67).
--
-- Qué cambia:
--   1. `public.payment_reversals`: la reversa de un cobro, fila propia y append-only de verdad
--      (sin UPDATE). `payments` no se toca (`amount > 0`, ADR-0061): un cobro reversado es un
--      cobro CON reversa, y todo Σ cobros lo excluye por esa fila.
--   2. Permiso `ar.payment.reverse` (dueño y contador).
--   3. El comprobante de retención soportada se anula sin tropezar con el CHECK NOT VALID de los
--      14 dígitos (R-61), y su número queda libre para cargarlo corregido.
--   4. `paid → issued` es una transición sancionada: la produce la reversa de un cobro.
--   5. La única función de deuda: `platform.document_debt` (nominal en la moneda del documento;
--      funcional a la tasa de hoy solo para mostrar). `document_debt_today`, `ar_aging`,
--      `document_balance` y `document_balance_transaction` salen de ella o excluyen lo reversado.
--   6. El saldo de la caja resta lo reversado y el IGTF restituido.
--   7. `accounting_coverage_gaps` dice en su enunciado qué pasa con un cobro reversado.
--   8. `settlement_ledger_open` (de 20261003170000) cuenta el asiento reversado junto a su
--      contra-asiento: sin eso un cobro reversado se contaba al revés.
--   9. E-11: `platform.treasury_original_of`, de donde el generador saca moneda, importe original
--      y tasa de cada línea de caja. J-04: `platform.treasury_currency_gaps` (invariante) y la
--      regularización al corte de las cajas en divisa (`…_regularization_prepare`).
--  10. La revaluación al cierre: `platform.fx_revaluation_items`.
-- =============================================================================

-- ── 1. La reversa de un cobro ────────────────────────────────────────────────
create table public.payment_reversals (
  id                 uuid          primary key default platform.uuidv7(),
  tenant_id          uuid          not null,
  company_id         uuid          not null,
  payment_id         uuid          not null,
  document_id        uuid          not null,
  kind               text          not null default 'payment',
  reversed_at        timestamptz   not null default now(),
  reason             text          not null,
  -- Copia del cobro, escrita por el trigger (nunca por quien inserta): lo que sale de la caja.
  account_id         uuid,
  currency           text          not null,
  amount             numeric(24,8) not null,
  functional_amount  numeric(24,8) not null,
  customer_credit_id uuid,
  supported_retention_id uuid,
  -- El IGTF que ese cobro percibió y que se restituye al cliente (0 si no hubo o si lo asumió
  -- la empresa: lo absorbido nunca entró a la caja).
  igtf_perception_id uuid,
  igtf_restituted_amount numeric(24,8) not null default 0,
  -- Los contra-asientos. NULL si el asiento del cobro seguía en la cola (se descartó con él).
  reversal_entry_id      uuid,
  igtf_reversal_entry_id uuid,

  created_by  uuid,
  created_at  timestamptz not null,
  version     integer     not null,

  constraint payment_reversals_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint payment_reversals_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint payment_reversals_payment_fk
    foreign key (company_id, payment_id) references public.payments (company_id, id),
  constraint payment_reversals_document_fk
    foreign key (company_id, document_id) references public.documents (company_id, id),
  constraint payment_reversals_account_fk
    foreign key (company_id, account_id) references public.company_accounts (company_id, id),
  constraint payment_reversals_entry_fk
    foreign key (company_id, reversal_entry_id) references public.journal_entries (company_id, id),
  constraint payment_reversals_igtf_entry_fk
    foreign key (company_id, igtf_reversal_entry_id)
    references public.journal_entries (company_id, id),
  constraint payment_reversals_igtf_fk
    foreign key (company_id, igtf_perception_id) references public.igtf_perceptions (company_id, id),
  constraint payment_reversals_kind_chk check (kind in ('payment', 'supported_retention')),
  constraint payment_reversals_kind_shape_chk
    check ((kind = 'supported_retention') = (supported_retention_id is not null)),
  constraint payment_reversals_reason_chk check (length(btrim(reason)) between 10 and 300),
  constraint payment_reversals_amount_chk
    check (amount > 0 and functional_amount > 0 and igtf_restituted_amount >= 0),
  constraint payment_reversals_igtf_shape_chk
    check (igtf_perception_id is not null or igtf_restituted_amount = 0),
  -- LA CLAVE NATURAL: un cobro se reversa una sola vez. Es lo que cierra la ventana que la
  -- Idempotency-Key solo acota.
  constraint payment_reversals_payment_key unique (company_id, payment_id),
  constraint payment_reversals_company_id_key unique (company_id, id)
);
create index payment_reversals_payment_idx on public.payment_reversals (payment_id);
create index payment_reversals_document_idx on public.payment_reversals (document_id);
create index payment_reversals_account_idx on public.payment_reversals (account_id);
create index payment_reversals_tenant_company_idx on public.payment_reversals (tenant_id, company_id);
comment on table public.payment_reversals is
  'La reversa de un cobro (ADR-0075 §8, R-61): una fila por cobro reversado, con motivo. '
  'Append-only: ni UPDATE ni DELETE. El cobro original no se toca; todo Σ cobros excluye los que '
  'tienen fila aquí. account_id, currency, amount, el IGTF restituido y los enlaces los copia del '
  'cobro el trigger payment_reversals_05_fill, nunca quien inserta.';

create function platform.fill_payment_reversal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p  record;
  v_ip record;
begin
  select p.document_id, p.account_id, p.currency, p.amount, p.functional_amount,
         p.customer_credit_id, p.supported_retention_id
    into v_p
    from public.payments p
   where p.id = new.payment_id and p.company_id = new.company_id and p.tenant_id = new.tenant_id;
  if not found then
    raise exception 'la reversa apunta a un cobro que no existe en esta empresa'
      using errcode = 'LAD95';
  end if;
  new.document_id := v_p.document_id;
  new.account_id := v_p.account_id;
  new.currency := v_p.currency;
  new.amount := v_p.amount;
  new.functional_amount := v_p.functional_amount;
  new.customer_credit_id := v_p.customer_credit_id;
  new.supported_retention_id := v_p.supported_retention_id;
  new.kind := case when v_p.supported_retention_id is null then 'payment'
                   else 'supported_retention' end;

  select ip.id, ip.amount, ip.absorbed, ip.debit_note_id into v_ip
    from public.igtf_perceptions ip
   where ip.company_id = new.company_id and ip.payment_id = new.payment_id;
  if found then
    if v_ip.debit_note_id is not null then
      raise exception
        'este cobro documentó su IGTF con una nota de débito: un documento fiscal emitido no se deshace con la reversa del cobro'
        using errcode = 'LAD95';
    end if;
    new.igtf_perception_id := v_ip.id;
    new.igtf_restituted_amount := case when v_ip.absorbed then 0 else v_ip.amount end;
  else
    new.igtf_perception_id := null;
    new.igtf_restituted_amount := 0;
    new.igtf_reversal_entry_id := null;
  end if;
  return new;
end;
$$;
revoke execute on function platform.fill_payment_reversal() from public;

create function platform.apply_payment_reversal_to_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Sale de la caja lo que el cobro metió: su importe y el IGTF que se restituye. Un cobro sin
  -- cuenta (saldo a favor, retención) no movió efectivo y su reversa tampoco.
  if new.account_id is not null then
    perform platform.bump_account_balance(new.account_id,
                                          -(new.amount + new.igtf_restituted_amount));
  end if;
  return new;
end;
$$;
revoke execute on function platform.apply_payment_reversal_to_balance() from public;

create trigger payment_reversals_00_provenance
  before insert or update on public.payment_reversals
  for each row execute function platform.set_row_provenance();
create trigger payment_reversals_01_anchors
  before update on public.payment_reversals
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger payment_reversals_05_fill
  before insert on public.payment_reversals
  for each row execute function platform.fill_payment_reversal();
create trigger payment_reversals_immutable
  before update or delete on public.payment_reversals
  for each row execute function platform.reject_mutation();
create trigger payment_reversals_no_truncate
  before truncate on public.payment_reversals
  for each statement execute function platform.reject_mutation();
create trigger payment_reversals_zz_balance
  after insert on public.payment_reversals
  for each row execute function platform.apply_payment_reversal_to_balance();

alter table public.payment_reversals enable row level security;
alter table public.payment_reversals force row level security;
create policy payment_reversals_select on public.payment_reversals for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy payment_reversals_insert on public.payment_reversals for insert to authenticated
  with check (false);
create policy payment_reversals_update on public.payment_reversals for update to authenticated
  using (false);
create policy payment_reversals_delete on public.payment_reversals for delete to authenticated
  using (false);
create policy payment_reversals_api_select on public.payment_reversals for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy payment_reversals_api_insert on public.payment_reversals for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy payment_reversals_api_update on public.payment_reversals for update to ladino_api
  using (false);
create policy payment_reversals_api_delete on public.payment_reversals for delete to ladino_api
  using (false);
revoke all on public.payment_reversals from anon, authenticated, service_role, ladino_api, ladino_worker;
grant select on public.payment_reversals to authenticated;
grant select, insert on public.payment_reversals to ladino_api;

-- ── 2. El permiso de la reversa ──────────────────────────────────────────────
insert into public.permissions (key, description, is_scoped) values
  ('ar.payment.reverse',
   'Reversar un cobro registrado, con motivo y acta: reabre el saldo del documento (contador y dueño)',
   false)
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key, tenant_id)
select r.id, 'ar.payment.reverse', null
  from public.roles r
 where r.tenant_id is null and r.key in ('owner', 'accountant')
on conflict (role_id, permission_key) do nothing;

do $$
begin
  if (select count(*) from public.role_permissions rp
        join public.roles r on r.id = rp.role_id and r.tenant_id is null
       where rp.permission_key = 'ar.payment.reverse'
         and r.key in ('owner', 'accountant')) <> 2 then
    raise exception 'LAD37: ar.payment.reverse no quedó en el dueño y el contador';
  end if;
  if not exists (select 1 from public.permissions where key = 'ar.retention.correct') then
    raise exception 'LAD37: falta el permiso ar.retention.correct (20260928190000)';
  end if;
end $$;

-- ── 3. Anular un comprobante de retención soportada (R-61) ───────────────────
-- LA TRAMPA: `srr_receipt_14_digits_chk` es NOT VALID, y un CHECK NOT VALID se evalúa en TODO
-- UPDATE. Anular un comprobante viejo con un número de otro formato fallaba con 23514. El CHECK
-- pasa a decir lo que protege: el formato se exige a lo que está VIGENTE. Sigue NOT VALID (las
-- filas vigentes anteriores a 20260928190000 no se juzgan al crearlo).
alter table public.supported_retention_receipts drop constraint srr_receipt_14_digits_chk;
alter table public.supported_retention_receipts
  add constraint srr_receipt_14_digits_chk
  check (status = 'annulled' or receipt_number ~ '^[0-9]{14}$') not valid;
comment on constraint srr_receipt_14_digits_chk on public.supported_retention_receipts is
  'PA SNAT/2025/000054: el comprobante de retención lleva 14 dígitos. Se exige a los comprobantes '
  'VIGENTES; uno anulado conserva el número que tuviera (R-61: NOT VALID no perdona un UPDATE).';
-- El prefijo de período (srr_receipt_period_prefix_chk, 20260928190300) es NOT VALID también: la
-- misma trampa, la misma salida.
alter table public.supported_retention_receipts drop constraint srr_receipt_period_prefix_chk;
alter table public.supported_retention_receipts
  add constraint srr_receipt_period_prefix_chk
  check (status = 'annulled'
         or receipt_number ~ '^(19|20)[0-9]{2}(0[1-9]|1[0-2])[0-9]{8}$') not valid;
-- El mismo comprobante del mismo agente no se carga dos veces contra la misma factura… VIGENTE.
-- Uno anulado deja su número libre: la corrección es anular y volver a cargar (decidido por
-- criterio, ADR-0075). Mismas columnas que srr_unique_receipt_per_document (20260928190300).
alter table public.supported_retention_receipts drop constraint srr_unique_receipt_per_document;
create unique index srr_unique_receipt_per_document on public.supported_retention_receipts
  (company_id, customer_id, receipt_number, document_id) where status = 'registered';

-- ── 4. `paid → issued`: la transición que produce la reversa de un cobro ─────
-- Parte de la definición VIVA (20260827192216 §13, la única). Única diferencia: la fila de
-- transiciones admite paid → issued.
create or replace function platform.assert_document_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('issued', 'paid', 'annulled') then
      raise exception
        'un documento emitido no se borra: se anula, y su número se conserva (ADR-0037)'
        using errcode = 'LAD06';
    end if;
    return old;
  end if;

  if old.status in ('draft', 'confirmed', 'cancelled') then
    return new;  -- un borrador sí se edita: todavía no es un documento fiscal
  end if;

  -- A partir de aquí, old.status es issued | paid | annulled.
  if new.document_number is distinct from old.document_number
     or new.control_number is distinct from old.control_number
     or new.kind is distinct from old.kind
     or new.series is distinct from old.series
     or new.customer_id is distinct from old.customer_id
     or new.issued_at is distinct from old.issued_at
     or new.total_amount is distinct from old.total_amount
     or new.subtotal_amount is distinct from old.subtotal_amount
     or new.tax_amount is distinct from old.tax_amount
     or new.fx_rate is distinct from old.fx_rate
     or new.regime_version_id is distinct from old.regime_version_id
     or new.rules_version is distinct from old.rules_version then
    raise exception
      'la identidad fiscal de un documento emitido es inmutable: número, control, cliente, importes, tasa y anclas de versión no se tocan. Corrige con nota de crédito o débito.'
      using errcode = 'LAD06',
            hint = 'FISCAL_DOCUMENTS_SPEC: issued → adjusted vía NC/ND, nunca editando';
  end if;

  if not (
    (old.status = 'issued'   and new.status in ('issued', 'paid', 'annulled'))
    -- paid → issued: solo si el documento tiene un cobro reversado (ADR-0075 §8). No es «editar
    -- la factura»: es que dejó de estar pagada.
    or (old.status = 'paid'    and new.status in ('paid', 'annulled'))
    or (old.status = 'paid'    and new.status = 'issued'
        and exists (select 1 from public.payment_reversals r where r.document_id = old.id))
    or (old.status = 'annulled' and new.status = 'annulled')
  ) then
    raise exception 'transición de estado no permitida: % → %', old.status, new.status
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;

-- La emisión no se vuelve a juzgar cuando un documento YA emitido vuelve de `paid` a `issued`.
-- Parte de la definición VIVA (20260928190500); única diferencia: la guarda de la segunda línea.
create or replace function platform.assert_document_issuance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_regime record;
  v_tipo text;
  v_cliente record;
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

  -- ADR-0072 §1 (A-03): factura, NC y ND exigen tipo de contribuyente vigente en el DÍA de
  -- Caracas de la emisión, y declarable. Nunca «ordinario por omisión». El recibo no lo pide.
  if new.kind in ('invoice', 'credit_note', 'debit_note') then
    v_tipo := platform.taxpayer_type_at(new.company_id, platform.caracas_day(new.issued_at));
    if v_tipo is null or v_tipo not in ('ordinario', 'especial', 'formal') then
      raise exception
        'la empresa no tiene tipo de contribuyente declarado vigente al %: declárelo antes de emitir (ADR-0072)',
        platform.caracas_day(new.issued_at)
        using errcode = 'LAD98';
    end if;
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
$$;

-- ── 5. La única función de deuda (F-04, ADR-0075 §5) ─────────────────────────
-- 5.1 El saldo en la moneda del documento, a una fecha. Parte de la definición VIVA de
-- `document_balance_transaction` (20260928190000). Diferencias: (a) un cobro reversado no cuenta;
-- (b) lee `payments.settled_transaction_amount` (20261003170000 §1) cuando el cobro lo congeló;
-- (c) admite una fecha de corte (la revaluación al cierre); (d) en un documento en la moneda
-- funcional resta la percepción que paga una ND por IGTF, igual que `document_balance`.
create function platform.document_balance_transaction_at(
  p_company uuid, p_document uuid, p_as_of date)
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
  select d.id, d.company_id, d.transaction_currency, d.functional_currency,
         d.amount_transaction_currency, d.fx_rate
    into v_doc
    from public.documents d
   where d.id = p_document and d.company_id = p_company
     and d.status in ('issued', 'paid');
  if not found then return null; end if;

  for v_p in
    select p.currency, p.amount, p.functional_amount, p.settled_transaction_amount,
           platform.caracas_day(p.paid_at) as paid_on,
           r.ar_valuation
      from public.payments p
      left join public.supported_retention_receipts r
        on r.company_id = p.company_id and r.id = p.supported_retention_id
     where p.document_id = v_doc.id
       and (p_as_of is null or platform.caracas_day(p.paid_at) <= p_as_of)
       and not exists (select 1 from public.payment_reversals pr
                        where pr.payment_id = p.id
                          and (p_as_of is null
                               or platform.caracas_day(pr.reversed_at) <= p_as_of))
  loop
    if v_p.settled_transaction_amount is not null then
      -- ADR-0075 §4 (F-02): lo que el cobro saldó quedó congelado al cobrar.
      v_paid := v_paid + v_p.settled_transaction_amount;
    elsif v_p.currency = v_doc.transaction_currency then
      v_paid := v_paid + v_p.amount;
    elsif v_p.ar_valuation = 'invoice_rate' then
      -- ADR-0072 §5: la retención es una fracción fija del IVA DE LA FACTURA; salda
      -- la divisa a la tasa con que se emitió, sin diferencial.
      v_paid := v_paid + round(v_p.functional_amount / v_doc.fx_rate, 8);
    else
      v_rate := platform.rate_at(p_company, v_doc.transaction_currency,
                                 v_doc.functional_currency, v_p.paid_on);
      if v_rate is null then
        raise exception
          'no hay tasa % → % vigente al % para valorar un cobro: cárgala con su fuente',
          v_doc.transaction_currency, v_doc.functional_currency, v_p.paid_on
          using errcode = 'LAD51';
      end if;
      v_paid := v_paid + round(v_p.functional_amount / v_rate, 8);
    end if;
  end loop;

  if v_doc.transaction_currency = v_doc.functional_currency then
    v_paid := v_paid + coalesce((select sum(ip.functional_amount)
                                   from public.igtf_perceptions ip
                                  where ip.company_id = v_doc.company_id
                                    and ip.debit_note_id = v_doc.id), 0);
  end if;

  return v_doc.amount_transaction_currency - v_paid;
end;
$$;
comment on function platform.document_balance_transaction_at(uuid, uuid, date) is
  'Saldo de un documento EN SU MONEDA, a una fecha (NULL = ahora): importe − lo saldado por cada '
  'cobro no reversado. Es la base de platform.document_debt y de la revaluación al cierre.';
revoke execute on function platform.document_balance_transaction_at(uuid, uuid, date) from public;
grant execute on function platform.document_balance_transaction_at(uuid, uuid, date)
  to authenticated, ladino_api;

-- El envoltorio va en plpgsql (un envoltorio SQL sobre una función no inlinable replanifica
-- por fila: migracion-supabase, S0.4).
create or replace function platform.document_balance_transaction(p_company uuid, p_document uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
begin
  return platform.document_balance_transaction_at(p_company, p_document, null);
end;
$$;

-- 5.2 El saldo funcional. Parte de la definición VIVA (20261002100000 §4): conserva la resta de
-- la percepción que paga una ND por IGTF. Única diferencia: un cobro reversado no cuenta.
create or replace function platform.document_balance(p_company uuid, p_document uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select d.total_amount
         - coalesce((select sum(p.functional_amount) from public.payments p
                      where p.document_id = d.id
                        and not exists (select 1 from public.payment_reversals pr
                                         where pr.payment_id = p.id)), 0)
         - coalesce((select sum(ip.functional_amount) from public.igtf_perceptions ip
                      where ip.company_id = d.company_id and ip.debit_note_id = d.id), 0)
    from public.documents d
   where d.id = p_document and d.company_id = p_company and d.status in ('issued', 'paid')
$$;
comment on function platform.document_balance(uuid, uuid) is
  'Saldo pendiente = total − Σ cobros NO reversados − la percepción que paga una ND por IGTF, en '
  'moneda funcional. Calculado, nunca persistido. Para ENSEÑAR una deuda se usa '
  'platform.document_debt (ADR-0075 §5), no esta cifra.';

-- 5.3 LA función de deuda.
create function platform.document_debt(p_company uuid, p_document uuid)
returns table (currency text, nominal numeric, functional_currency text,
               rate numeric, rate_date date, functional_today numeric)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_doc record;
  v_rate numeric;
  v_saldo_tx numeric;
  v_escala int;
  v_hoy date := platform.caracas_day(now());
  v_func numeric;
begin
  select d.status, d.transaction_currency, d.functional_currency, d.fx_rate,
         d.amount_transaction_currency, d.total_amount
    into v_doc
    from public.documents d
   where d.id = p_document and d.company_id = p_company
     and d.status in ('issued', 'paid');
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

  v_rate := platform.rate_at(p_company, v_doc.transaction_currency, v_doc.functional_currency,
                             v_hoy);
  if v_rate is null then
    raise exception
      'no hay tasa % → % vigente hoy para valorar la deuda: cárgala con su fuente',
      v_doc.transaction_currency, v_doc.functional_currency
      using errcode = 'LAD51';
  end if;

  v_saldo_tx := platform.document_balance_transaction_at(p_company, p_document, null);

  if v_doc.amount_transaction_currency is null or v_doc.amount_transaction_currency = 0
     or v_doc.fx_rate is null or v_doc.fx_rate = 0 then
    v_func := round(v_saldo_tx * v_rate, v_escala);
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
$$;
comment on function platform.document_debt(uuid, uuid) is
  'LA función de deuda (ADR-0075 §5, F-04). Una fila por documento emitido: lo que se debe en la '
  'moneda del documento (nominal) y, SOLO PARA MOSTRAR, su valor en moneda funcional a la tasa de '
  'hoy, con la tasa y la fecha. Un documento pagado debe cero. Toda pantalla y todo aviso al '
  'cliente salen de aquí.';
revoke execute on function platform.document_debt(uuid, uuid) from public;
grant execute on function platform.document_debt(uuid, uuid) to authenticated, ladino_api;

create or replace function platform.document_debt_today(p_company uuid, p_document uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v numeric;
begin
  select d.functional_today into v from platform.document_debt(p_company, p_document) d;
  return v;
end;
$$;
comment on function platform.document_debt_today(uuid, uuid) is
  'Lo que el cliente debe HOY por este documento, en moneda funcional: la columna '
  'functional_today de platform.document_debt (la única función de deuda, ADR-0075 §5).';

-- 5.4 La antigüedad sale de la misma función. Parte de la definición VIVA (20261002100100).
-- Única diferencia: el saldo es `document_debt_today`, no `document_balance`.
create or replace function platform.ar_aging(
  p_company uuid, p_customer uuid default null,
  p_reference date default (now() at time zone 'America/Caracas')::date
)
returns table (
  customer_id uuid, bucket text, document_count bigint, amount numeric
)
language sql
stable
set search_path = ''
as $$
  with saldos as (
    select d.customer_id, d.id,
           (p_reference - platform.caracas_day(d.issued_at)) as dias,
           -- LA deuda (ADR-0075 §5): la misma cifra que la ficha, la lista y el aviso. El cast
           -- conserva la escala de la columna (numeric(24,8)) que esta función siempre devolvió.
           platform.document_debt_today(p_company, d.id)::numeric(24,8) as saldo
      from public.documents d
     where d.company_id = p_company
       and d.kind in ('invoice', 'receipt', 'debit_note')
       and d.status in ('issued', 'paid')
       and (p_customer is null or d.customer_id = p_customer)
       and platform.caracas_day(d.issued_at) <= p_reference
  )
  select s.customer_id,
         case when s.dias <= 30 then '0-30'
              when s.dias <= 60 then '31-60'
              when s.dias <= 90 then '61-90'
              else '90+' end,
         count(*), sum(s.saldo)
    from saldos s
   where s.saldo > 0
   group by 1, 2
   order by 1, 2
$$;

-- 5.5 La deuda de un cliente (o de todos): la suma de LA función sobre el trío de documentos que
-- deben (factura, recibo fiado, nota de débito). La lista de clientes, la ficha, «Lo que me
-- deben» y el estado de cuenta llaman a esta, no a cuatro copias de la misma suma.
create function platform.customer_debt_today(p_company uuid, p_customer uuid default null)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(platform.document_debt_today(p_company, d.id)), 0)
    from public.documents d
   where d.company_id = p_company
     and (p_customer is null or d.customer_id = p_customer)
     and d.kind in ('invoice', 'receipt', 'debit_note')
     and d.status in ('issued', 'paid')
$$;
comment on function platform.customer_debt_today(uuid, uuid) is
  'Lo que un cliente (o todos, con NULL) debe HOY, en moneda funcional: Σ de '
  'platform.document_debt_today sobre factura, recibo y nota de débito (ADR-0075 §5, F-04).';
revoke execute on function platform.customer_debt_today(uuid, uuid) from public;
grant execute on function platform.customer_debt_today(uuid, uuid) to authenticated, ladino_api;

-- ── 6. El saldo de la caja resta lo reversado ────────────────────────────────
-- Parte de la definición VIVA (20261002100000 §3). Única diferencia: el último sumando.
create or replace function platform.recompute_account_balance(p_account uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce((select sum(amount) from public.payments where account_id = p_account), 0)
       + coalesce((select sum(ip.amount)
                     from public.igtf_perceptions ip
                     join public.payments p on p.id = ip.payment_id
                    where p.account_id = p_account and not ip.absorbed), 0)
       - coalesce((select sum(net_amount) from public.supplier_payments
                    where account_id = p_account), 0)
       - coalesce((select sum(amount_transaction_currency) from public.expenses
                    where account_id = p_account), 0)
       + coalesce((select sum(amount_transaction_currency) from public.cash_closings
                    where account_id = p_account), 0)
       - coalesce((select sum(amount_transaction_currency) from public.customer_refunds
                    where account_id = p_account), 0)
       - coalesce((select sum(amount_transaction_currency) from public.treasury_transfers
                    where from_account_id = p_account), 0)
       + coalesce((select sum(amount_transaction_currency) from public.treasury_transfers
                    where to_account_id = p_account), 0)
       - coalesce((select sum(r.amount + r.igtf_restituted_amount)
                     from public.payment_reversals r where r.account_id = p_account), 0)
$$;
comment on function platform.recompute_account_balance(uuid) is
  'El saldo de una cuenta desde sus hechos: cobros + IGTF percibido (salvo el absorbido, que no '
  'entró) − pagos a proveedor − gastos + cierres − reembolsos ± transferencias − cobros '
  'reversados con el IGTF que se restituyó (ADR-0075 §8).';

-- ── 7. La cobertura contable dice qué pasa con un cobro reversado ────────────
-- Parte de la definición VIVA (20261002100200). Diferencias: el cobro reversado y su percepción
-- salen de «asiento O cola» y entran en su propio enunciado: no pueden conservar un asiento VIVO
-- (posted) ni una fila pendiente en la cola.
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
$$;
comment on function platform.accounting_coverage_gaps(uuid) is
  'INVARIANTE: todo hecho posteado tiene asiento O fila en cola, nunca ninguno y nunca los dos. '
  'Catorce fuentes: los documentos de venta, la factura y la NOTA DE CRÉDITO de compra, el '
  'gasto, el cierre, el reembolso, la transferencia, y —por origen, que no guardan enlace— el '
  'cobro, el pago a proveedor y la percepción de IGTF (ADR-0065 §§1 y 6). La ND por IGTF queda '
  'cubierta por el asiento o la fila en cola de su percepción (20261002100200). Un cobro '
  'REVERSADO (y su percepción) cumple otra cosa: no conserva asiento vivo ni fila pendiente '
  '(problem = reversal_not_posted; ADR-0075 §8).';

-- ── 8. Lo que el mayor le carga a un documento, con un cobro reversado ───────
-- Parte de la definición VIVA (20261003170100, familia «moneda A»). Única diferencia: cuenta
-- los asientos `reversed` además de los `posted`. Reversar pone el original en `reversed` y
-- postea un contra-asiento con `is_reversal_of`: contando solo `posted`, el original desaparecía
-- y su contra-asiento quedaba solo, y un cobro reversado SUMABA a la cuenta por cobrar dos veces.
create or replace function platform.settlement_ledger_open(
  p_company uuid, p_side text, p_document uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  with piezas as (
    select d.id, 'documento'::text as clase, d.journal_entry_id as entry_id
      from public.documents d
     where p_side = 'ar' and d.company_id = p_company and d.id = p_document
    union all
    select p.id, 'payment_received', p.journal_entry_id
      from public.payments p
     where p_side = 'ar' and p.company_id = p_company and p.document_id = p_document
    union all
    select i.id, 'documento', i.journal_entry_id
      from public.supplier_invoices i
     where p_side = 'ap' and i.company_id = p_company and i.id = p_document
    union all
    select p.id, 'payment_made', p.journal_entry_id
      from public.supplier_payments p
     where p_side = 'ap' and p.company_id = p_company and p.supplier_invoice_id = p_document
    union all
    select n.id, 'documento', n.journal_entry_id
      from public.supplier_credit_notes n
     where p_side = 'ap' and n.company_id = p_company and n.supplier_invoice_id = p_document
       and n.status = 'posted'
  ),
  asientos as (
    select z.id as pieza, z.entry_id
      from piezas z
     where z.entry_id is not null
    union
    select z.id, e.id
      from piezas z
      join public.journal_entries e
        on e.company_id = p_company and e.source_id = z.id and e.status in ('posted', 'reversed')
       and e.is_reversal_of is null
       and (z.clase = 'documento' or e.source_kind = z.clase)
  )
  select case
           when p_side not in ('ar', 'ap') then null
           when not exists (select 1 from piezas) then null
           when exists (select 1 from piezas z
                         where not exists (select 1 from asientos a where a.pieza = z.id))
             then null
           else (
             select coalesce(sum(case when p_side = 'ar'
                                      then l.debit_amount - l.credit_amount
                                      else l.credit_amount - l.debit_amount end), 0)
               from public.journal_lines l
               join public.journal_entries e on e.id = l.entry_id
              where l.company_id = p_company
                and e.status in ('posted', 'reversed')
                and (e.id in (select entry_id from asientos)
                     or e.is_reversal_of in (select entry_id from asientos))
                and l.account_id in (
                      select s.account_id from public.company_account_settings s
                       where s.company_id = p_company
                         and s.purpose = case p_side when 'ar' then 'ar_general'
                                                     else 'ap_general' end))
         end
$$;

-- ── 9. E-11 y J-04: la divisa de la caja, en el mayor ────────────────────────
-- 9.1 De dónde saca el generador la moneda, el importe original y la fuente de la tasa de la
-- línea de caja. Mismas fuentes que `platform.treasury_account_of` (20260916130000).
create function platform.treasury_original_of(
  p_company uuid, p_source_kind text, p_source_id uuid)
returns table (currency text, amount numeric, rate_source text, rate_timestamp timestamptz)
language sql
stable
set search_path = ''
as $$
  select p.currency, p.amount, p.rate_source, p.rate_timestamp
    from public.payments p
   where p_source_kind = 'payment_received' and p.id = p_source_id and p.company_id = p_company
  union all
  select sp.transaction_currency, sp.net_amount, sp.rate_source, sp.rate_timestamp
    from public.supplier_payments sp
   where p_source_kind = 'payment_made' and sp.id = p_source_id and sp.company_id = p_company
  union all
  select e.transaction_currency, e.amount_transaction_currency, e.rate_source, e.rate_timestamp
    from public.expenses e
   where p_source_kind = 'expense' and e.id = p_source_id and e.company_id = p_company
  union all
  select c.transaction_currency, abs(c.amount_transaction_currency), c.rate_source,
         c.rate_timestamp
    from public.cash_closings c
   where p_source_kind = 'cash_closing' and c.id = p_source_id and c.company_id = p_company
  union all
  select ip.currency, ip.amount, ip.rate_source, ip.occurred_at
    from public.igtf_perceptions ip
   where p_source_kind = 'igtf_perception' and ip.id = p_source_id and ip.company_id = p_company
  union all
  select r.transaction_currency, r.amount_transaction_currency, r.rate_source, r.rate_timestamp
    from public.customer_refunds r
   where p_source_kind = 'customer_refund' and r.id = p_source_id and r.company_id = p_company
  union all
  select t.transaction_currency, t.amount_transaction_currency, t.rate_source, t.rate_timestamp
    from public.treasury_transfers t
   where p_source_kind = 'treasury_transfer' and t.id = p_source_id and t.company_id = p_company
$$;
comment on function platform.treasury_original_of(uuid, text, uuid) is
  'E-11 (ADR-0075 §6): lo que un hecho movió en su cuenta de tesorería, EN LA MONEDA DE LA '
  'CUENTA, con la fuente de su tasa. El generador de asientos lo escribe en la línea de caja '
  '(los siete campos de ADR-0020). Mismas fuentes que treasury_account_of.';
revoke execute on function platform.treasury_original_of(uuid, text, uuid) from public;
grant execute on function platform.treasury_original_of(uuid, text, uuid)
  to ladino_api, ladino_worker;

-- 9.2 El saldo de una subcuenta de caja EN LA MONEDA DE LA CAJA, hasta una fecha.
create function platform.treasury_ledger_original(
  p_company uuid, p_ledger_account uuid, p_currency text, p_as_of date)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(case when l.debit_amount > 0 then l.amount_transaction_currency
                           else -l.amount_transaction_currency end), 0)
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
   where l.company_id = p_company and l.account_id = p_ledger_account
     and l.transaction_currency = p_currency
     and e.status in ('posted', 'reversed')
     and (p_as_of is null or e.posting_date <= p_as_of)
$$;
revoke execute on function platform.treasury_ledger_original(uuid, uuid, text, date) from public;
grant execute on function platform.treasury_ledger_original(uuid, uuid, text, date)
  to authenticated, ladino_api, ladino_worker;

-- 9.3 EL INVARIANTE (J-04): el saldo de cada cuenta de tesorería, en su moneda, es la suma de
-- los importes ORIGINALES en esa moneda de su subcuenta contable. En una caja en bolívares eso
-- es su saldo funcional; en una caja en dólares, sus dólares. Cero filas. Sin corte y sin lista:
-- lo anterior a esta migración se lleva al mayor con la regularización de 9.4.
create function platform.treasury_currency_gaps(p_company uuid)
returns table (account_id uuid, account_name text, currency text,
               treasury_balance numeric, ledger_original numeric)
language sql
stable
set search_path = ''
as $$
  select ca.id, ca.name, ca.currency, coalesce(b.balance, 0), x.original
    from public.company_accounts ca
    left join public.company_account_balances b on b.account_id = ca.id
    cross join lateral (
      select platform.treasury_ledger_original(p_company, ca.ledger_account_id, ca.currency, null)
             as original) x
   where ca.company_id = p_company
     and ca.ledger_account_id is not null
     and coalesce(b.balance, 0) <> x.original
$$;
comment on function platform.treasury_currency_gaps(uuid) is
  'INVARIANTE tesorería ↔ mayor en la moneda de la caja (ADR-0075 §6, J-04). Debe dar 0 filas: '
  'el saldo de cada cuenta de tesorería con cuenta contable = Σ de los importes originales, en '
  'la moneda de la caja, de las líneas de su subcuenta (asientos posteados y reversados). En '
  'bolívares es su saldo funcional; en divisa, lo que treasury_ledger_gaps no comparaba.';
revoke execute on function platform.treasury_currency_gaps(uuid) from public;
grant execute on function platform.treasury_currency_gaps(uuid)
  to authenticated, ladino_api, ladino_worker;

-- 9.4 La regularización al corte. Las líneas anteriores a esta migración están en VES/1/identidad
-- (E-11) y `journal_lines` es append-only: no se reescriben. Un asiento por empresa lleva al mayor
-- el saldo en divisa de cada caja: por caja, una línea EN LA DIVISA con el importe funcional que
-- la subcuenta ya tenía, y su contraria en la MISMA subcuenta en moneda funcional. El saldo
-- funcional de la subcuenta no cambia; aparece el original. Deja el asiento en BORRADOR: lo
-- postea el dominio (`repairTreasuryCurrency`), que es quien deja el acta.
create function platform.treasury_currency_regularization_prepare(p_company uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_co      public.companies;
  v_fecha   date := (now() at time zone 'America/Caracas')::date;
  v_periodo uuid;
  v_entry   uuid;
  v_linea   integer := 0;
  v_g       record;
  v_func    numeric;
  v_f       numeric;
  v_rate    numeric;
  v_acta    jsonb := '[]'::jsonb;
  v_sin     jsonb := '[]'::jsonb;
begin
  select * into v_co from public.companies where id = p_company;
  if v_co.id is null then
    return jsonb_build_object('company_id', p_company, 'regularized', false, 'skipped', 'no_company');
  end if;
  if not exists (select 1 from platform.treasury_currency_gaps(p_company) g
                  where g.currency <> v_co.functional_currency_code) then
    return jsonb_build_object('company_id', p_company, 'regularized', false);
  end if;
  if exists (select 1 from public.journal_generation_queue q
              where q.company_id = p_company and q.status = 'pending') then
    return jsonb_build_object('company_id', p_company, 'regularized', false,
                              'skipped', 'cola_pendiente');
  end if;
  if exists (select 1 from public.fiscal_periods fp
              where fp.company_id = p_company and fp.status = 'closed'
                and fp.year = extract(year from v_fecha)::int
                and fp.month = extract(month from v_fecha)::int) then
    return jsonb_build_object('company_id', p_company, 'regularized', false,
                              'skipped', 'periodo_cerrado');
  end if;

  for v_g in
    select g.account_id, g.account_name, g.currency, ca.ledger_account_id,
           g.treasury_balance - g.ledger_original as gap
      from platform.treasury_currency_gaps(p_company) g
      join public.company_accounts ca on ca.id = g.account_id
     where g.currency <> v_co.functional_currency_code
     order by g.account_id
  loop
    -- El importe funcional de la línea en divisa: el que la subcuenta ya lleva, si tiene el
    -- mismo signo que lo que falta; si no, lo que falta a la tasa de hoy.
    select r.balance into v_func from platform.recompute_ledger(p_company, v_g.ledger_account_id) r;
    v_func := coalesce(v_func, 0);
    if v_func <> 0 and sign(v_func) = sign(v_g.gap) then
      v_f := platform.round_cents(abs(v_func));
    else
      v_rate := platform.rate_at(p_company, v_g.currency, v_co.functional_currency_code, v_fecha);
      v_f := platform.round_cents(abs(v_g.gap) * v_rate);
    end if;
    if v_f is null or v_f <= 0 or round(v_f / abs(v_g.gap), 8) <= 0 then
      v_sin := v_sin || jsonb_build_object('company_account_id', v_g.account_id,
                                           'account_name', v_g.account_name);
      continue;
    end if;
    if v_entry is null then
      v_periodo := platform.period_for_date(p_company, v_fecha);
      insert into public.journal_entries
        (tenant_id, company_id, period_id, posting_date, source_kind, description, memo,
         rules_version)
      values (v_co.tenant_id, p_company, v_periodo, v_fecha, 'manual',
              'Regularización: el saldo en divisa de cada caja pasa al mayor (ADR-0075 §6)',
              'Asiento del sistema. No mueve dinero ni cambia el saldo en bolívares de ninguna '
              || 'cuenta: escribe en cada subcuenta de caja en divisa su importe original.',
              coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-repair'))
      returning id into v_entry;
    end if;
    -- La línea en la divisa.
    v_linea := v_linea + 1;
    insert into public.journal_lines
      (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
       description)
    values (v_co.tenant_id, p_company, v_entry, v_linea, v_g.ledger_account_id,
            case when v_g.gap > 0 then abs(v_g.gap) else 0 end,
            case when v_g.gap < 0 then abs(v_g.gap) else 0 end,
            abs(v_g.gap), v_g.currency, round(v_f / abs(v_g.gap), 8), v_f,
            v_co.functional_currency_code, 'regularizacion-adr-0075', now(),
            case when v_g.gap > 0 then v_f else 0 end,
            case when v_g.gap < 0 then v_f else 0 end,
            'Saldo en ' || v_g.currency || ' de «' || v_g.account_name || '»');
    -- Su contraria, en la misma subcuenta y en moneda funcional.
    v_linea := v_linea + 1;
    insert into public.journal_lines
      (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
       description)
    values (v_co.tenant_id, p_company, v_entry, v_linea, v_g.ledger_account_id,
            case when v_g.gap < 0 then v_f else 0 end,
            case when v_g.gap > 0 then v_f else 0 end,
            v_f, v_co.functional_currency_code, 1, v_f,
            v_co.functional_currency_code, 'identidad', now(),
            case when v_g.gap < 0 then v_f else 0 end,
            case when v_g.gap > 0 then v_f else 0 end,
            'Lo que «' || v_g.account_name || '» tenía asentado solo en moneda funcional');
    v_acta := v_acta || jsonb_build_object(
      'company_account_id', v_g.account_id, 'account_name', v_g.account_name,
      'currency', v_g.currency, 'original', v_g.gap::text, 'functional', v_f::text);
  end loop;

  return jsonb_build_object(
    'company_id', p_company, 'regularized', v_entry is not null, 'entry_id', v_entry,
    'posting_date', v_fecha, 'accounts', v_acta, 'without_rate', v_sin);
end;
$$;
comment on function platform.treasury_currency_regularization_prepare(uuid) is
  'ADR-0075 §6 (J-04): prepara, en BORRADOR, el asiento que lleva al mayor el saldo en divisa de '
  'cada caja anterior a E-11. Idempotente (sin hueco no escribe). Lo postea el dominio.';
revoke execute on function platform.treasury_currency_regularization_prepare(uuid) from public;
grant execute on function platform.treasury_currency_regularization_prepare(uuid) to ladino_api;

-- ── 10. La revaluación al cierre (VEN-NIF PYME secc. 30) ─────────────────────
-- Las partidas monetarias en divisa, medidas a la tasa de cierre. Una fila por partida con lo que
-- el mayor lleva (carried), lo que debe llevar (target) y el ajuste EN TÉRMINOS DE DÉBITO de su
-- cuenta. Sin estado propio: el ajuste es siempre «lo que debe llevar − lo que lleva», así que
-- cerrar dos veces el mismo período da cero la segunda, y lo ya revaluado de un documento que se
-- cobró después sale solo en el cierre siguiente.
--   · caja en divisa: su subcuenta. carried = saldo funcional de la subcuenta a la fecha.
--   · cuentas por cobrar / por pagar: la cuenta del papel ar_general / ap_general. Lo que el
--     mayor lleva de sus documentos en divisa es su saldo a la tasa de cada documento más las
--     revaluaciones ya asentadas en esa cuenta.
create function platform.fx_revaluation_items(p_company uuid, p_as_of date)
returns table (item_kind text, account_id uuid, label text, currency text,
               original_balance numeric, rate numeric, carried numeric, target numeric,
               adjustment numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_func text;
  v_c record;
  v_rate numeric;
  v_cuenta uuid;
  v_orig numeric;
  v_hist numeric;
  v_target numeric;
  v_prior numeric;
  v_lado text;
begin
  select c.functional_currency_code into v_func from public.companies c where c.id = p_company;
  if v_func is null then return; end if;

  -- Las cajas en divisa.
  for v_c in
    select ca.id, ca.name, ca.currency, ca.ledger_account_id
      from public.company_accounts ca
     where ca.company_id = p_company and ca.currency <> v_func
       and ca.ledger_account_id is not null
     order by ca.id
  loop
    v_rate := platform.rate_at(p_company, v_c.currency, v_func, p_as_of);
    if v_rate is null then
      raise exception 'no hay tasa % → % vigente al % para revaluar al cierre: cárgala con su fuente',
        v_c.currency, v_func, p_as_of using errcode = 'LAD51';
    end if;
    v_orig := platform.treasury_ledger_original(p_company, v_c.ledger_account_id, v_c.currency,
                                                p_as_of);
    select coalesce(sum(l.functional_debit - l.functional_credit), 0) into v_hist
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
     where l.company_id = p_company and l.account_id = v_c.ledger_account_id
       and e.status in ('posted', 'reversed') and e.posting_date <= p_as_of;
    v_target := platform.round_cents(v_orig * v_rate);
    return query select 'treasury'::text, v_c.ledger_account_id, v_c.name, v_c.currency,
                        v_orig, v_rate, v_hist, v_target, v_target - v_hist;
  end loop;

  -- Cuentas por cobrar y por pagar, por moneda.
  foreach v_lado in array array['ar', 'ap'] loop
    select s.account_id into v_cuenta
      from public.company_account_settings s
     where s.company_id = p_company
       and s.purpose = case v_lado when 'ar' then 'ar_general' else 'ap_general' end
       and (s.effective_from at time zone 'America/Caracas')::date <= p_as_of
       and (s.effective_to is null
            or (s.effective_to at time zone 'America/Caracas')::date > p_as_of)
     order by s.effective_from desc limit 1;
    continue when v_cuenta is null;

    for v_c in
      select x.currency, sum(x.saldo) as original,
             sum(platform.round_cents(x.saldo * x.fx_rate)) as historico
        from (
          select d.transaction_currency as currency, d.fx_rate,
                 platform.document_balance_transaction_at(p_company, d.id, p_as_of) as saldo
            from public.documents d
           where v_lado = 'ar' and d.company_id = p_company
             and d.kind in ('invoice', 'receipt', 'debit_note')
             and d.status in ('issued', 'paid')
             and d.transaction_currency <> v_func
             and platform.caracas_day(d.issued_at) <= p_as_of
          union all
          select i.transaction_currency, i.fx_rate,
                 i.total_amount
                 - round(coalesce(i.retention_total, 0) / nullif(i.fx_rate, 0),
                         platform.currency_minor_units(i.transaction_currency))
                 - coalesce((select sum(coalesce(p.settled_amount, p.net_amount))
                               from public.supplier_payments p
                              where p.supplier_invoice_id = i.id
                                and platform.caracas_day(p.paid_at) <= p_as_of), 0)
                 - coalesce((select sum(n.total_amount) from public.supplier_credit_notes n
                              where n.supplier_invoice_id = i.id and n.status = 'posted'
                                and coalesce(n.accounting_date, n.note_date) <= p_as_of), 0)
            from public.supplier_invoices i
           where v_lado = 'ap' and i.company_id = p_company
             and i.status in ('posted', 'paid')
             and i.transaction_currency <> v_func
             and coalesce(i.accounting_date, i.invoice_date) <= p_as_of
        ) x
       where x.saldo > 0
       group by x.currency
       order by x.currency
    loop
      v_rate := platform.rate_at(p_company, v_c.currency, v_func, p_as_of);
      if v_rate is null then
        raise exception 'no hay tasa % → % vigente al % para revaluar al cierre: cárgala con su fuente',
          v_c.currency, v_func, p_as_of using errcode = 'LAD51';
      end if;
      v_target := platform.round_cents(v_c.original * v_rate);
      if v_lado = 'ar' then
        return query select 'receivable'::text, v_cuenta, 'Cuentas por cobrar en ' || v_c.currency,
                            v_c.currency, v_c.original, v_rate, v_c.historico, v_target,
                            v_target - v_c.historico;
      else
        return query select 'payable'::text, v_cuenta, 'Cuentas por pagar en ' || v_c.currency,
                            v_c.currency, v_c.original, v_rate, v_c.historico, v_target,
                            -(v_target - v_c.historico);
      end if;
    end loop;

    -- Lo ya revaluado en esa cuenta (todas las divisas juntas) se descuenta UNA vez: fila
    -- propia, de signo contrario, para que el asiento lleve la diferencia.
    select coalesce(sum(l.functional_debit - l.functional_credit), 0) into v_prior
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
      left join public.journal_entries o on o.id = e.is_reversal_of
     where l.company_id = p_company and l.account_id = v_cuenta
       and e.status in ('posted', 'reversed') and e.posting_date <= p_as_of
       and ((e.source_kind = 'exchange_diff' and e.source_event = 'fx.revaluation_at_close')
            or (o.source_kind = 'exchange_diff' and o.source_event = 'fx.revaluation_at_close'));
    if v_prior <> 0 then
      return query select case v_lado when 'ar' then 'receivable_prior' else 'payable_prior' end,
                          v_cuenta, 'Revaluación ya asentada en cierres anteriores', v_func,
                          0::numeric, 1::numeric, v_prior, 0::numeric, -v_prior;
    end if;
  end loop;
end;
$$;
comment on function platform.fx_revaluation_items(uuid, date) is
  'ADR-0075 §6 (E-11, F-04, J-04; VEN-NIF PYME secc. 30): las partidas monetarias en divisa a una '
  'fecha de cierre —cajas, cuentas por cobrar y por pagar—, con lo que el mayor lleva, lo que debe '
  'llevar a la tasa de cierre y el ajuste en términos de débito. El asiento lo escribe '
  'closeFiscalPeriod. No guarda estado.';
revoke execute on function platform.fx_revaluation_items(uuid, date) from public;
grant execute on function platform.fx_revaluation_items(uuid, date) to ladino_api;

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos)
--   · `payment_reversals` VACÍA: drop table, y las funciones de 4-8 vuelven a sus definiciones
--     anteriores (20260827192216 §13, 20260928190500, 20260928190000, 20261002100000,
--     20261002100100, 20261002100200, 20261003170100) con otra migración.
--   · `payment_reversals` CON FILAS: no se revierte sin perder hechos. Cada fila es un cobro que
--     dejó de contar, una caja que bajó y un contra-asiento posteado: soltar la tabla haría que
--     el cobro vuelva a contar en el saldo con su asiento reversado en el mayor (documento
--     «pagado» que el mayor da por debido). Para deshacer una reversa se registra el cobro otra vez.
--   · El permiso `ar.payment.reverse`: delete de role_permissions y permissions; sin efecto.
--   · El CHECK de 14 dígitos y el único del comprobante: se restauran SOLO si ningún comprobante
--     anulado tiene otro formato y ningún número anulado se volvió a cargar; si no, fallan al
--     recrearse (y está bien que fallen).
--   · `document_debt`, `document_balance_transaction_at`, `treasury_original_of`,
--     `treasury_ledger_original`, `treasury_currency_gaps`, `fx_revaluation_items` y la
--     regularización son de lectura o no guardan estado: drop function. Los asientos de
--     regularización y de revaluación ya posteados no se borran: se reversan.
--   · Las líneas de asiento escritas con divisa (E-11) son append-only: quedan.
-- Funciones que esta migración redefine: assert_document_immutable, assert_document_issuance,
-- document_balance_transaction, document_balance, document_debt_today, ar_aging,
-- recompute_account_balance, accounting_coverage_gaps, settlement_ledger_open. A la fecha,
-- ninguna migración posterior a esta existe en el árbol.
-- =============================================================================

-- =============================================================================
-- El IGTF lo percibe quien ES especial, la caja lo suma, la factura lo imprime y el cobro
-- posterior lo documenta con una Nota de Débito (ADR-0072 §2; RESPUESTA §2.6; E-02, E-03,
-- F-05, G-06, L-15).
-- Módulo: ventas · IGTF   Spec: docs/02_COMPLIANCE/IGTF_SPEC.md
--
-- Qué cambia en el esquema (el resto vive en el dominio):
--
--   1. `company_settings.absorb_igtf` (por omisión, NO): la empresa asume el IGTF como gasto y
--      el cliente paga el documento justo (F-05). El IGTF se percibe y se entera igual.
--   2. `igtf_perceptions` gana dos columnas, las dos fijadas al insertar:
--        · `absorbed`: la percepción la asumió la empresa — NO entró dinero del cliente por
--          ella, así que no suma a la caja y su asiento es Dr gasto / Cr IGTF por enterar;
--        · `debit_note_id`: la Nota de Débito por IGTF que la documenta (cobro posterior a la
--          factura, E-03). La ND queda pagada por su percepción.
--   3. El saldo de caja deja de sumar lo absorbido (trigger, redistribución y recómputo: las
--      tres caras del mismo invariante, `treasury_ledger_gaps`).
--   4. `platform.document_balance`: la ND por IGTF la paga su percepción. Sin esto, la ND
--      quedaba como deuda del cliente por un dinero que ya entró en el mismo acto.
--   5. La plantilla del IGTF asumido en el preset `ve_basico`, y en las empresas que ya lo
--      importaron (mismo patrón que 20260916130000 §5).
--
-- Reversibilidad, con datos vivos: SÍ mientras no haya filas con `absorbed = true` ni
-- `debit_note_id` no nulo (en producción no hay clientes reales, 2026-09-28). Con filas, revertir
-- exige decidir qué hacer con ellas: devolver la definición anterior de las funciones haría que
-- las absorbidas sumaran a la caja (un saldo falso) y que las ND por IGTF reaparecieran como
-- deuda. La reversión honesta es OTRA migración que restaure las definiciones de
-- 20260913120000 (trigger y redistribución), 20260916130000 (recómputo) y 20260827192216
-- (saldo), después de dar de baja las ND por IGTF con su NC y de reasentar lo absorbido.
-- HOMOLOGATION_IMPACT: YES — cambia quién percibe, qué imprime la factura y añade un documento
-- fiscal (la ND por IGTF). La homologación de software está derogada (PA SNAT/2026/00084); lo que
-- gobierna es la PA 00071 y la PA SNAT/2022/000013 art. 6. VALIDAR-TRIBUTARIO en
-- PENDIENTES_ASESOR (P-40 ampliado, P-9).
-- =============================================================================

-- ── 1. El ajuste de la empresa ───────────────────────────────────────────────
alter table public.company_settings
  add column absorb_igtf boolean not null default false;
comment on column public.company_settings.absorb_igtf is
  'F-05 (RESPUESTA §2.6): la empresa asume el IGTF como gasto y el cliente paga el documento '
  'justo. Por omisión NO: la caja suma el 3 % de la parte en divisas al total a pagar.';

-- ── 2. La percepción dice cómo entró ─────────────────────────────────────────
alter table public.igtf_perceptions
  add column absorbed boolean not null default false,
  add column debit_note_id uuid;
alter table public.igtf_perceptions
  add constraint ip_debit_note_fk foreign key (company_id, debit_note_id)
    references public.documents (company_id, id),
  -- Lo absorbido no se le cobró al cliente: no hay nada que documentarle con una ND.
  add constraint ip_absorbed_no_note_chk check (not (absorbed and debit_note_id is not null));
-- Una ND documenta UNA percepción: la ND es su papel, y su saldo se cancela con ella.
create unique index ip_debit_note_key on public.igtf_perceptions (company_id, debit_note_id)
  where debit_note_id is not null;
comment on column public.igtf_perceptions.absorbed is
  'La asumió la empresa (company_settings.absorb_igtf): no entró dinero del cliente por ella, no '
  'suma a la caja y su asiento es Dr gasto / Cr IGTF por enterar. Se entera igual.';
comment on column public.igtf_perceptions.debit_note_id is
  'La Nota de Débito por IGTF que documenta esta percepción (cobro posterior a la factura, E-03; '
  'PA SNAT/2022/000013 art. 6). La ND queda pagada por la percepción (platform.document_balance).';

-- ── 3. La caja no suma lo que no entró ───────────────────────────────────────
-- Parte de la definición de 20260913120000 (la única).
create or replace function platform.apply_igtf_perception_to_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account  uuid;
  v_currency text;
begin
  -- Lo absorbido lo paga la empresa con su gasto: el cliente no entregó ese dinero (F-05).
  if new.absorbed then
    return new;
  end if;
  select p.account_id, ca.currency into v_account, v_currency
    from public.payments p
    left join public.company_accounts ca on ca.id = p.account_id
   where p.id = new.payment_id;
  if v_account is null then
    return new;
  end if;
  if v_currency is distinct from new.currency then
    raise exception
      'la percepción de IGTF va en % y la cuenta de su pago es en %: el saldo no mezcla monedas',
      new.currency, v_currency
      using errcode = '23514';
  end if;
  perform platform.bump_account_balance(v_account, new.amount);
  return new;
end;
$$;
revoke execute on function platform.apply_igtf_perception_to_balance() from public;

-- Parte de la definición de 20260913120000 (la última).
create or replace function platform.apply_payment_to_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_igtf numeric;
begin
  -- Un pago sin cuenta (saldo a favor) no mueve saldo: no hay efectivo.
  if tg_op = 'INSERT' and new.account_id is not null then
    perform platform.bump_account_balance(new.account_id, new.amount);
  elsif tg_op = 'UPDATE' and new.account_id is distinct from old.account_id then
    -- Redistribución: el dinero se muda de cuenta, el saldo lo sigue — el
    -- cobro Y su IGTF, que entraron juntos en la misma caja (migración 53).
    -- Lo absorbido no entró (20261002100000): no se muda.
    select coalesce(sum(ip.amount), 0) into v_igtf
      from public.igtf_perceptions ip where ip.payment_id = new.id and not ip.absorbed;
    if old.account_id is not null then
      perform platform.bump_account_balance(old.account_id, -(old.amount + v_igtf));
    end if;
    if new.account_id is not null then
      perform platform.bump_account_balance(new.account_id, new.amount + v_igtf);
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function platform.apply_payment_to_balance() from public;

-- Parte de la definición de 20260916130000 (la última).
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
$$;
comment on function platform.recompute_account_balance(uuid) is
  'El saldo de una cuenta desde sus hechos: cobros + IGTF percibido (salvo el absorbido, que no '
  'entró) − pagos a proveedor − gastos + cierres − reembolsos ± transferencias.';

-- ── 4. La ND por IGTF la paga su percepción ──────────────────────────────────
-- Parte de la definición de 20260827192216 (la única). Sigue en SQL y sigue siendo una sola
-- expresión: la invocan políticas y listas por fila.
create or replace function platform.document_balance(p_company uuid, p_document uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select d.total_amount
         - coalesce((select sum(p.functional_amount) from public.payments p
                      where p.document_id = d.id), 0)
         - coalesce((select sum(ip.functional_amount) from public.igtf_perceptions ip
                      where ip.company_id = d.company_id and ip.debit_note_id = d.id), 0)
    from public.documents d
   where d.id = p_document and d.company_id = p_company and d.status in ('issued', 'paid')
$$;
comment on function platform.document_balance(uuid, uuid) is
  'Saldo pendiente = total − Σ cobros − la percepción que paga una ND por IGTF, en moneda '
  'funcional. Calculado, nunca persistido: un saldo guardado es un segundo sitio donde la verdad '
  'diverge.';

-- ── 5. El asiento del IGTF asumido ───────────────────────────────────────────
-- Dr gastos operativos / Cr IGTF por enterar. La cuenta de gasto es la general (5.1.05) y no
-- una propia: VALIDAR-CONTABLE en PENDIENTES_ASESOR (si el IGTF asumido es deducible y en qué
-- cuenta va).
do $$
declare
  v_entry uuid;
begin
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'igtf_perception', 'igtf.perception_absorbed',
          'IGTF asumido por la empresa: gasto contra el pasivo por enterar — no entra efectivo')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'operating_expense', 'functional_amount', 'debit', 'always',
     'El 3 % que la empresa decidió asumir: el cliente pagó el documento justo'),
    (v_entry, 2, 'igtf_percibido_por_enterar', 'functional_amount', 'credit', 'always',
     'Deuda con el fisco hasta enterarlo, igual que el percibido');
end $$;

do $$
declare
  v_c record;
  v_e record;
  v_tpl uuid;
begin
  for v_c in select distinct t.company_id, t.tenant_id from public.journal_templates t loop
    for v_e in
      select e.id, e.source_kind, e.source_event, e.description
        from public.journal_template_preset_entries e
       where e.preset_code = 've_basico'
         and e.source_kind = 'igtf_perception'
         and e.source_event = 'igtf.perception_absorbed'
    loop
      continue when exists (select 1 from public.journal_templates t
                             where t.company_id = v_c.company_id
                               and t.source_kind = v_e.source_kind
                               and t.source_event = v_e.source_event);
      insert into public.journal_templates
        (tenant_id, company_id, source_kind, source_event, description, effective_from)
      values (v_c.tenant_id, v_c.company_id, v_e.source_kind, v_e.source_event, v_e.description,
              '-infinity')
      returning id into v_tpl;
      insert into public.journal_template_lines
        (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
         side, condition_kind, description)
      select v_c.tenant_id, v_c.company_id, v_tpl, l.line_number, l.account_purpose,
             l.amount_source, l.side, l.condition_kind, l.description
        from public.journal_template_preset_lines l where l.entry_id = v_e.id order by l.line_number;
    end loop;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_c.tenant_id, v_c.company_id, 'company', v_c.company_id,
            'accounting.templates_imported', 'system', now(), 'db-migration',
            jsonb_build_object('origin', 'migration_20261002100000', 'preset_code', 've_basico',
                               'facts', 'igtf.perception_absorbed'));
  end loop;
end $$;

-- ── 6. Quien lee el saldo lee la percepción que paga la ND ──────────────────
-- `platform.document_balance` (§4) es SQL sin security definer y la llama `authenticated`
-- (pgTAP 087, saldo en divisa). Sin SELECT sobre igtf_perceptions fallaba con 42501. Se concede
-- la lectura con la política de pertenencia a la empresa, como `documents`: escribirla sigue siendo
-- solo de `ladino_api` (insert y update sin policy para authenticated).
grant select on public.igtf_perceptions to authenticated;
create policy ip_select on public.igtf_perceptions for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));

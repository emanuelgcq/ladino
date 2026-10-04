-- ════════════════════════════════════════════════════════════════════════════
-- Ladino — EL CIERRE EN SOBREGIRO ES UN ORIGEN PROPIO, CON EL EVENTO DE SIEMPRE (J-02)
--
-- Módulo: tesorería · contabilidad (RIGOR MÁXIMO: dinero)
-- Spec: RESPUESTA_RECORRIDO_2026-09-24 §3 J-02 · ADR-0062 §4 · ADR-0042 (idempotencia por
--       evento) · pgTAP 026 §4 («los eventos del preset son los del OUTBOX») · pgTAP 031 §6
-- HOMOLOGATION_IMPACT: NO (no toca emisión, numeración ni libros de IVA).
--
-- QUÉ CORRIGE. La migración 20261004180000 sembró el cierre en sobregiro como
-- `cash_closing / treasury.cash_register.overdraft_covered`. Ese nombre NO es un evento del
-- outbox: el cierre publica `treasury.cash_register.closed`, ocurra como ocurra. El preset no
-- inventa un vocabulario paralelo de eventos (pgTAP 026), y la plantilla del cierre de caja son
-- sus cuatro patas (pgTAP 031). Ninguna de las dos aserciones pasaba gracias al defecto: no se
-- tocan. El patrón de la casa para «otro hecho contable del MISMO evento» es el origen
-- (`purchase_revaluation / ap.invoice_posted`, `sales_cost / stock.shipped`):
--
--     cash_closing_overdraft / treasury.cash_register.closed
--
-- QUÉ HACE:
--   1. `cash_closing_overdraft` entra en el vocabulario de `source_kind` de las TRES tablas que
--      lo cierran (asientos, plantillas, preset). El CHECK se reconstruye LEYENDO el vigente y
--      añadiendo el valor: no hay lista copiada que pueda borrar vocabulario ajeno;
--   2. las tres funciones que resuelven «la caja de este hecho» por `source_kind` aprenden el
--      origen nuevo, partiendo de su ÚLTIMA definición:
--        · platform.treasury_account_of      (última: 20260916130000)
--        · platform.treasury_original_of     (última: 20261003180000)
--        · platform.treasury_queue_pending   (última: 20261003210000)
--      Sin la primera, el asiento iría a la cola con `treasury_account_unmapped`; sin la
--      segunda, una caja en divisa perdería su importe original (ADR-0075 §6); sin la tercera,
--      `treasury_ledger_gaps` y `treasury_currency_gaps` no contarían un cierre en sobregiro
--      que espera en la cola.
--      `platform.accounting_coverage_gaps` NO se toca: cubre el cierre por su fila
--      (`cash_closings.journal_entry_id` o la cola por `source_id`), sea cual sea el origen del
--      asiento. `platform.recompute_account_balance` tampoco: suma la tabla, no el origen;
--   3. la plantilla del preset y las de las empresas que crearon 20261004180000/180100 se
--      TRASLADAN al origen nuevo con el evento de siempre, con acta. No hay asiento de
--      producción con el nombre viejo: la API que lo usa no se ha desplegado.
--
-- EXPAND. La API desplegada asienta todo cierre con `cash_closing / …closed`, que no cambia: sigue
-- funcionando. Las funciones redefinidas devuelven lo mismo para todo origen que ya existía.
--
-- Reversible: SÍ mientras no haya asientos con el origen nuevo. CON DATOS VIVOS, NO del todo: un
-- asiento posteado con `cash_closing_overdraft` es append-only y el valor ya no se puede quitar
-- del CHECK; se dejaría de usar, no se borraría.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. El origen nuevo, en las tres casas del vocabulario ───────────────────
do $$
declare
  v_t record;
  v_def text;
  v_valores text[];
begin
  for v_t in
    select * from (values
      ('public.journal_entries'::regclass, 'journal_entries_source_kind_chk'),
      ('public.journal_templates'::regclass, 'journal_templates_source_kind_chk'),
      ('public.journal_template_preset_entries'::regclass, 'journal_template_preset_entries_kind_chk')
    ) as t(tabla, restriccion)
  loop
    select pg_get_constraintdef(c.oid) into v_def
      from pg_catalog.pg_constraint c
     where c.conrelid = v_t.tabla and c.conname = v_t.restriccion;
    if v_def is null or v_def not like 'CHECK ((source_kind = ANY (ARRAY[%' then
      raise exception 'LAD82: % en % no tiene la forma esperada: el vocabulario de orígenes cambió de forma',
        v_t.restriccion, v_t.tabla using errcode = 'LAD82';
    end if;
    select array_agg(m[1] order by ord) into v_valores
      from regexp_matches(v_def, '''([a-z_]+)''::text', 'g') with ordinality as r(m, ord);
    if 'cash_closing' <> all (v_valores) then
      raise exception 'LAD82: % no contiene cash_closing: no se leyó bien el vocabulario vigente',
        v_t.restriccion using errcode = 'LAD82';
    end if;
    continue when 'cash_closing_overdraft' = any (v_valores);
    v_valores := v_valores || 'cash_closing_overdraft'::text;
    execute format('alter table %s drop constraint %I', v_t.tabla, v_t.restriccion);
    execute format('alter table %s add constraint %I check (source_kind = any (%L::text[]))',
                   v_t.tabla, v_t.restriccion, v_valores);
  end loop;
end $$;

-- ── 2. La caja del hecho, también para el origen nuevo ──────────────────────
-- Las tres parten de su última definición; lo único que cambia es la rama del cierre.
create or replace function platform.treasury_account_of(
  p_company uuid, p_source_kind text, p_source_id uuid
)
returns uuid
language sql
stable
set search_path = ''
as $$
  select case p_source_kind
    when 'payment_received' then
      (select p.account_id from public.payments p
        where p.id = p_source_id and p.company_id = p_company)
    when 'payment_made' then
      (select sp.account_id from public.supplier_payments sp
        where sp.id = p_source_id and sp.company_id = p_company)
    when 'expense' then
      (select e.account_id from public.expenses e
        where e.id = p_source_id and e.company_id = p_company)
    when 'cash_closing' then
      (select c.account_id from public.cash_closings c
        where c.id = p_source_id and c.company_id = p_company)
    -- J-02: el cierre de una caja en sobregiro es el mismo registro, con otro hecho contable.
    when 'cash_closing_overdraft' then
      (select c.account_id from public.cash_closings c
        where c.id = p_source_id and c.company_id = p_company)
    when 'igtf_perception' then
      (select p.account_id from public.igtf_perceptions ip
         join public.payments p on p.id = ip.payment_id and p.company_id = ip.company_id
        where ip.id = p_source_id and ip.company_id = p_company)
    when 'customer_refund' then
      (select r.account_id from public.customer_refunds r
        where r.id = p_source_id and r.company_id = p_company)
    when 'treasury_transfer' then
      (select t.to_account_id from public.treasury_transfers t
        where t.id = p_source_id and t.company_id = p_company)
    else null
  end
$$;

create or replace function platform.treasury_original_of(
  p_company uuid, p_source_kind text, p_source_id uuid
)
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
  -- J-02: el cierre en sobregiro mueve la caja por la misma diferencia que el de siempre.
  select c.transaction_currency, abs(c.amount_transaction_currency), c.rate_source,
         c.rate_timestamp
    from public.cash_closings c
   where p_source_kind in ('cash_closing', 'cash_closing_overdraft')
     and c.id = p_source_id and c.company_id = p_company
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

create or replace function platform.treasury_queue_pending(p_company uuid, p_account uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(x.amount), 0)
    from (
      select p.amount
        from public.journal_generation_queue q
        join public.payments p on p.id = q.source_id and p.company_id = q.company_id
       where q.company_id = p_company and q.status = 'pending'
         and q.source_kind = 'payment_received' and p.account_id = p_account
      union all
      select ip.amount
        from public.journal_generation_queue q
        join public.igtf_perceptions ip on ip.id = q.source_id and ip.company_id = q.company_id
        join public.payments p on p.id = ip.payment_id and p.company_id = ip.company_id
       where q.company_id = p_company and q.status = 'pending'
         and q.source_kind = 'igtf_perception' and p.account_id = p_account and not ip.absorbed
      union all
      select -sp.net_amount
        from public.journal_generation_queue q
        join public.supplier_payments sp on sp.id = q.source_id and sp.company_id = q.company_id
       where q.company_id = p_company and q.status = 'pending'
         and q.source_kind = 'payment_made' and sp.account_id = p_account
      union all
      select -e.amount_transaction_currency
        from public.journal_generation_queue q
        join public.expenses e on e.id = q.source_id and e.company_id = q.company_id
       where q.company_id = p_company and q.status = 'pending'
         and q.source_kind = 'expense' and e.account_id = p_account
      union all
      -- J-02: un cierre en sobregiro que espera en la cola cuenta igual que el de siempre.
      select c.amount_transaction_currency
        from public.journal_generation_queue q
        join public.cash_closings c on c.id = q.source_id and c.company_id = q.company_id
       where q.company_id = p_company and q.status = 'pending'
         and q.source_kind in ('cash_closing', 'cash_closing_overdraft')
         and c.account_id = p_account
      union all
      select -r.amount_transaction_currency
        from public.journal_generation_queue q
        join public.customer_refunds r on r.id = q.source_id and r.company_id = q.company_id
       where q.company_id = p_company and q.status = 'pending'
         and q.source_kind = 'customer_refund' and r.account_id = p_account
      union all
      select case when t.to_account_id = p_account then t.amount_transaction_currency
                  else -t.amount_transaction_currency end
        from public.journal_generation_queue q
        join public.treasury_transfers t on t.id = q.source_id and t.company_id = q.company_id
       where q.company_id = p_company and q.status = 'pending'
         and q.source_kind = 'treasury_transfer'
         and p_account in (t.from_account_id, t.to_account_id)
    ) x
$$;

-- ── 3. El traslado: preset y plantillas de las empresas, con acta ───────────
update public.journal_template_preset_entries
   set source_kind = 'cash_closing_overdraft',
       source_event = 'treasury.cash_register.closed'
 where preset_code = 've_basico'
   and source_kind = 'cash_closing'
   and source_event = 'treasury.cash_register.overdraft_covered';

do $$
declare
  v_t record;
  v_ahora timestamptz := now();
begin
  for v_t in
    select t.id, t.tenant_id, t.company_id
      from public.journal_templates t
     where t.source_kind = 'cash_closing'
       and t.source_event = 'treasury.cash_register.overdraft_covered'
     order by t.company_id, t.id
  loop
    update public.journal_templates
       set source_kind = 'cash_closing_overdraft',
           source_event = 'treasury.cash_register.closed'
     where id = v_t.id;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_t.tenant_id, v_t.company_id, 'company', v_t.company_id,
            'accounting.template_moved', 'system', v_ahora, 'db-migration',
            jsonb_build_object(
              'origin', 'migration_20261004180200', 'template_id', v_t.id,
              'from', jsonb_build_object('source_kind', 'cash_closing',
                                         'source_event', 'treasury.cash_register.overdraft_covered'),
              'to', jsonb_build_object('source_kind', 'cash_closing_overdraft',
                                       'source_event', 'treasury.cash_register.closed'),
              'motivo', 'El cierre en sobregiro es un origen propio con el evento real del outbox; el preset no inventa eventos.'));
  end loop;
end $$;

-- ── 4. Lo que esta migración garantiza sobre sí misma ───────────────────────
do $$
begin
  if exists (select 1 from public.journal_template_preset_entries
              where source_event = 'treasury.cash_register.overdraft_covered')
     or exists (select 1 from public.journal_templates
                 where source_event = 'treasury.cash_register.overdraft_covered') then
    raise exception 'LAD82: queda una plantilla con el evento que no existe en el outbox'
      using errcode = 'LAD82';
  end if;
  if (select count(*) from public.journal_template_preset_lines l
        join public.journal_template_preset_entries e on e.id = l.entry_id
       where e.preset_code = 've_basico' and e.source_kind = 'cash_closing_overdraft'
         and e.source_event = 'treasury.cash_register.closed') <> 3 then
    raise exception 'LAD82: el preset no tiene las tres líneas del cierre en sobregiro en su origen'
      using errcode = 'LAD82';
  end if;
  if (select count(*) from public.journal_template_preset_lines l
        join public.journal_template_preset_entries e on e.id = l.entry_id
       where e.preset_code = 've_basico' and e.source_kind = 'cash_closing') <> 4 then
    raise exception 'LAD82: la plantilla del cierre de caja ya no son sus cuatro patas'
      using errcode = 'LAD82';
  end if;
end $$;

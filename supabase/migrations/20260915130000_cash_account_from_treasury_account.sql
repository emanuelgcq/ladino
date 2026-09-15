-- =============================================================================
-- Ladino — migración 56 · LA CUENTA DE EFECTIVO SALE DE LA CUENTA DE TESORERÍA
--                          REAL DEL MOVIMIENTO (ADR-0060 §4)
--
-- Módulo: contabilidad · tesorería (RIGOR MÁXIMO: dinero)
-- Spec: ADR-0060 §4 · ADR-0041 (vocabulario cerrado de papeles) · ADR-0055
-- HOMOLOGATION_IMPACT: NO (no toca emisión, numeración ni libros de IVA).
--
-- EL DEFECTO. Cinco plantillas del preset ve_basico nombraban una constante de
-- caja en vez de la caja del movimiento:
--   · cobro           payment_received / ar.payment_applied      → cash_bs
--   · pago a prov.    payment_made / ap.payment_made              → cash_bs
--   · gasto           expense / treasury.expense.registered       → cash_bs
--   · cierre de caja  cash_closing / treasury.cash_register.closed → cash_bs (×2)
--   · IGTF percibido  igtf_perception / igtf.perception_recorded  → cash_usd
-- `company_accounts.ledger_account_id` existía (migración 29) y su comentario
-- prometía la resolución por moneda; el generador nunca lo leyó. Un cobro en
-- dólares a una caja en dólares se asentaba en «Caja y bancos en bolívares»
-- (V2, e2e-ola0-verificaciones). El dueño listó cuatro caminos; el quinto (la
-- percepción de IGTF, fija en cash_usd aunque el dinero entre a un banco) se
-- halló al auditar las plantillas y se corrige con los otros.
--
-- LA DECISIÓN:
--   1. un papel nuevo, `treasury_account`: la línea no nombra una cuenta; el
--      generador la resuelve con la cuenta de tesorería del hecho;
--   2. `platform.treasury_account_of(company, source_kind, source_id)`: UNA sola
--      definición de «cuál es la caja de este hecho», leída del propio registro
--      (pago, pago a proveedor, gasto, cierre, percepción → su pago). El
--      reproceso de la cola la usa igual: no depende del contexto congelado;
--   3. el mapeo caja → cuenta contable es OBLIGATORIO y automático: toda cuenta
--      de tesorería nace mapeada (cash_bs si su moneda es la funcional,
--      cash_usd si no) por trigger, y las que existían se mapean aquí con acta.
--      Si una empresa aún no tiene plan de cuentas, queda sin mapeo y se mapea
--      sola cuando se asigne el papel. Si alguien quita el mapeo, el hecho va a
--      la cola con motivo `treasury_account_unmapped` — nunca a cash_bs;
--   4. el preset y las plantillas VIGENTES de cada empresa cambian esas líneas
--      a `treasury_account` con una VERSIÓN NUEVA desde ahora (ADR-0029/0055):
--      las versiones anteriores no se editan y siguen rigiendo lo anterior.
--
-- EXPAND/CONTRACT (ADR-0057). Con la API vieja, una plantilla nueva pide un papel
-- que el generador viejo no resuelve: el hecho se ENCOLA con «Falta configurar la
-- cuenta de: treasury_account» (nunca un asiento equivocado), y la API nueva lo
-- contabiliza al reprocesar. Por eso esta migración se aplica en la MISMA
-- ventana que el deploy de la API.
--
-- REVERSIBILIDAD:
--   · el papel y la función: se pueden dejar (no hacen nada sin plantillas);
--   · el mapeo de cuentas: `update company_accounts set ledger_account_id = null`
--     sobre las filas del acta `treasury.account.ledger_mapped` con origen esta
--     migración;
--   · las plantillas: crear otra versión con cash_bs/cash_usd desde ese momento
--     (cerrando la de esta migración). Los asientos YA generados con
--     `treasury_account` NO se reescriben: quedan en la cuenta de su caja, que es
--     lo correcto; deshacer solo cambia los siguientes.
-- =============================================================================

-- ── 1. El papel, y CÓMO se resuelve su cuenta, dicho en el esquema ───────────
-- Los invariantes de cobertura preguntan «¿todo papel del preset tiene cuenta?».
-- `treasury_account` no tiene una cuenta fija: la toma de la caja. En vez de
-- excluirlo en cada consulta (la primera excepción convierte el gate en
-- decoración, CLAUDE.md §3), el papel DECLARA de dónde sale su cuenta y los
-- invariantes lo leen de aquí.
alter table public.account_purposes
  add column resolved_by text not null default 'company_setting';
alter table public.account_purposes
  add constraint account_purposes_resolved_by_chk
  check (resolved_by in ('company_setting', 'treasury_account'));
comment on column public.account_purposes.resolved_by is
  'De dónde sale la cuenta del papel: company_setting = company_account_settings '
  '(una cuenta fija por vigencia); treasury_account = la cuenta contable mapeada a la '
  'caja del movimiento (company_accounts.ledger_account_id). ADR-0060 §4.';

insert into public.account_purposes (code, name, description, resolved_by) values
  ('treasury_account', 'Cuenta de tesorería del movimiento',
   'No es una cuenta fija: el generador usa la cuenta contable mapeada a la caja, banco o billetera donde entró o de donde salió el dinero (company_accounts.ledger_account_id). ADR-0060 §4.', 'treasury_account')
on conflict (code) do nothing;

-- ── 2. ¿Cuál es la caja de este hecho? Una sola definición ──────────────────
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
    when 'igtf_perception' then
      (select p.account_id from public.igtf_perceptions ip
         join public.payments p on p.id = ip.payment_id and p.company_id = ip.company_id
        where ip.id = p_source_id and ip.company_id = p_company)
    else null
  end
$$;
comment on function platform.treasury_account_of(uuid, text, uuid) is
  'La cuenta de tesorería (company_accounts.id) de un hecho contable: la del '
  'pago, pago a proveedor, gasto, cierre o —para la percepción de IGTF— la del '
  'pago que la originó. NULL si el hecho no mueve una caja. ADR-0060 §4.';
revoke execute on function platform.treasury_account_of(uuid, text, uuid) from public;
grant execute on function platform.treasury_account_of(uuid, text, uuid) to ladino_api, ladino_worker;

-- ── 3. La cuenta contable por omisión de una caja ───────────────────────────
-- cash_bs si la caja está en la moneda funcional de la empresa; cash_usd si no.
-- El papel VIGENTE hoy (ADR-0055: la primera vigencia rige desde siempre).
create or replace function platform.treasury_default_ledger_account(
  p_company uuid, p_currency text
)
returns uuid
language sql
stable
set search_path = ''
as $$
  select s.account_id
    from public.company_account_settings s
    join public.companies c on c.id = s.company_id
   where s.company_id = p_company
     and s.purpose = case when p_currency = c.functional_currency_code
                          then 'cash_bs' else 'cash_usd' end
     and s.effective_from <= now()
     and (s.effective_to is null or s.effective_to > now())
   order by s.effective_from desc
   limit 1
$$;
revoke execute on function platform.treasury_default_ledger_account(uuid, text) from public;
-- La llaman los triggers de abajo, que corren con el rol de quien inserta.
grant execute on function platform.treasury_default_ledger_account(uuid, text)
  to authenticated, ladino_api, ladino_worker;

-- Toda caja nace mapeada, la cree quien la cree (caso de uso, «Sin asignar»
-- del cobro, semilla SQL). Un mapeo EXPLÍCITO nunca se pisa.
create or replace function platform.treasury_account_default_ledger()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.ledger_account_id is null then
    new.ledger_account_id := platform.treasury_default_ledger_account(new.company_id, new.currency);
  end if;
  return new;
end;
$$;
revoke execute on function platform.treasury_account_default_ledger() from public;

create trigger company_accounts_05_default_ledger
  before insert on public.company_accounts
  for each row execute function platform.treasury_account_default_ledger();

-- Y las cajas que nacieron ANTES del plan de cuentas se mapean cuando se asigna
-- el papel cash_bs / cash_usd (import del plan o asignación manual).
create or replace function platform.treasury_accounts_map_on_purpose()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_c record;
begin
  if new.purpose not in ('cash_bs', 'cash_usd') then
    return new;
  end if;
  for v_c in
    select ca.id, ca.tenant_id, ca.name, ca.currency
      from public.company_accounts ca
      join public.companies co on co.id = ca.company_id
     where ca.company_id = new.company_id
       and ca.ledger_account_id is null
       and (case when ca.currency = co.functional_currency_code
                 then 'cash_bs' else 'cash_usd' end) = new.purpose
  loop
    update public.company_accounts set ledger_account_id = new.account_id where id = v_c.id;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_c.tenant_id, new.company_id, 'company_account', v_c.id,
            'treasury.account.ledger_mapped', 'system', now(),
            coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-trigger'),
            jsonb_build_object('ledger_account_id', new.account_id, 'purpose', new.purpose,
                               'origin', 'purpose_assigned', 'account_name', v_c.name));
  end loop;
  return new;
end;
$$;
revoke execute on function platform.treasury_accounts_map_on_purpose() from public;

create trigger company_account_settings_05_map_treasury
  after insert on public.company_account_settings
  for each row execute function platform.treasury_accounts_map_on_purpose();

-- ── 4. Las cajas que ya existen, mapeadas con acta ──────────────────────────
do $$
declare
  v_c record;
  v_ledger uuid;
begin
  for v_c in
    select ca.id, ca.tenant_id, ca.company_id, ca.name, ca.currency
      from public.company_accounts ca
     where ca.ledger_account_id is null
     order by ca.company_id, ca.created_at
  loop
    v_ledger := platform.treasury_default_ledger_account(v_c.company_id, v_c.currency);
    continue when v_ledger is null;
    update public.company_accounts set ledger_account_id = v_ledger where id = v_c.id;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_c.tenant_id, v_c.company_id, 'company_account', v_c.id,
            'treasury.account.ledger_mapped', 'system', now(), 'db-migration',
            jsonb_build_object('ledger_account_id', v_ledger,
                               'origin', 'migration_20260915130000',
                               'account_name', v_c.name, 'currency', v_c.currency));
  end loop;
end $$;

-- ── 5. El preset: las cinco líneas nombran la caja del movimiento ───────────
update public.journal_template_preset_lines l
   set account_purpose = 'treasury_account',
       description = l.description || ' (la cuenta contable de la caja donde entró o de donde salió)'
  from public.journal_template_preset_entries e
 where e.id = l.entry_id
   and e.preset_code = 've_basico'
   and e.source_kind in ('payment_received', 'payment_made', 'expense', 'cash_closing',
                         'igtf_perception')
   and l.account_purpose in ('cash_bs', 'cash_usd');

-- ── 6. Las plantillas VIGENTES de cada empresa: versión nueva desde ahora ───
-- Solo los hechos que mueven una caja, y solo las líneas que nombraban la
-- constante. La versión anterior se cierra en este instante y sigue rigiendo
-- los hechos anteriores (el generador compara por día de Caracas: hoy ya toma
-- la nueva). Las líneas que el contador cambió a otro papel no se tocan.
do $$
declare
  v_t record;
  v_nueva uuid;
  v_ahora timestamptz := now();
begin
  for v_t in
    select t.id, t.tenant_id, t.company_id, t.source_kind, t.source_event, t.description
      from public.journal_templates t
     where t.is_active
       and t.effective_to is null
       and t.source_kind in ('payment_received', 'payment_made', 'expense', 'cash_closing',
                             'igtf_perception')
       and exists (select 1 from public.journal_template_lines l
                    where l.template_id = t.id and l.account_purpose in ('cash_bs', 'cash_usd'))
     order by t.company_id, t.source_kind, t.source_event
  loop
    update public.journal_templates set effective_to = v_ahora where id = v_t.id;
    insert into public.journal_templates
      (tenant_id, company_id, source_kind, source_event, description, effective_from)
    values (v_t.tenant_id, v_t.company_id, v_t.source_kind, v_t.source_event,
            v_t.description, v_ahora)
    returning id into v_nueva;
    insert into public.journal_template_lines
      (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
       side, condition_kind, description)
    select l.tenant_id, l.company_id, v_nueva, l.line_number,
           case when l.account_purpose in ('cash_bs', 'cash_usd') then 'treasury_account'
                else l.account_purpose end,
           l.amount_source, l.side, l.condition_kind, l.description
      from public.journal_template_lines l
     where l.template_id = v_t.id
     order by l.line_number;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_t.tenant_id, v_t.company_id, 'company', v_t.company_id,
            'accounting.template_versioned', 'system', v_ahora, 'db-migration',
            jsonb_build_object('origin', 'migration_20260915130000',
                               'source_kind', v_t.source_kind, 'source_event', v_t.source_event,
                               'previous_template_id', v_t.id, 'new_template_id', v_nueva,
                               'motivo', 'La caja del asiento sale de la cuenta de tesorería del movimiento (ADR-0060 §4), no de una constante.'));
  end loop;
end $$;

-- ── 7. Lo que esta migración garantiza sobre sí misma (LAD82) ───────────────
do $$
begin
  if exists (
    select 1 from public.journal_template_preset_lines l
      join public.journal_template_preset_entries e on e.id = l.entry_id
     where e.preset_code = 've_basico'
       and e.source_kind in ('payment_received', 'payment_made', 'expense', 'cash_closing',
                             'igtf_perception')
       and l.account_purpose in ('cash_bs', 'cash_usd')) then
    raise exception 'LAD82: el preset ve_basico todavía nombra una caja constante en un hecho de tesorería'
      using errcode = 'LAD82';
  end if;
  if exists (
    select 1 from public.journal_templates t
      join public.journal_template_lines l on l.template_id = t.id
     where t.is_active and t.effective_to is null
       and t.source_kind in ('payment_received', 'payment_made', 'expense', 'cash_closing',
                             'igtf_perception')
       and l.account_purpose in ('cash_bs', 'cash_usd')) then
    raise exception 'LAD82: queda una plantilla vigente con caja constante en un hecho de tesorería'
      using errcode = 'LAD82';
  end if;
end $$;

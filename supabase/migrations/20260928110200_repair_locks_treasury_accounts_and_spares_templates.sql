-- =============================================================================
-- Ladino — LA REPARACIÓN DE ADR-0070 BLOQUEA LAS CAJAS Y NO ROMPE PLANTILLAS (J-01)
--
-- Módulo: contabilidad · tesorería (RIGOR MÁXIMO: dinero y mayor)
-- Spec: ADR-0070 · migraciones 20260928110000 y 20260928110100 (las que esta corrige)
-- HOMOLOGATION_IMPACT: NO.
--
-- Lo que pidió el revisor sobre la 110000, y que esta migración cambia:
--   1. `treasury_subaccounts_repair_prepare` leía los saldos de las cajas SIN bloquearlas: un
--      cobro que confirmara entre la lectura y el asiento de reclasificación quedaba en la
--      tesorería y en la subcuenta, pero su línea en la familia. Ahora bloquea las
--      `company_accounts` de la empresa (FOR UPDATE) antes de leer nada;
--   2. si una plantilla vigente de la empresa (cualquier source_kind) o una línea de cualquier
--      preset nombra cash_bs / cash_usd, la empresa se SALTA con razón propia
--      (`plantilla_nombra_familia`): tras la reparación la familia agrupa y esos hechos
--      morirían en LAD62;
--   3. el enunciado de `treasury_ledger_gaps` dice exactamente lo que mira: `sin_subcuenta` solo
--      sale si la empresa tiene VIGENTE el papel de la familia de esa caja.
-- Definición VIVA de partida: 20260928110000 (prepare, invariante). Nada más cambia: `finish`,
-- los triggers, `apply_ledger_balance` y `treasury_family_is_clean` (110100) quedan igual.
--
-- REVERSIBILIDAD: total (no escribe datos). Volver a la definición de la 110000.
-- =============================================================================

-- ── 1. prepare: bloquea las cajas y salta si una plantilla nombra la familia ──
create or replace function platform.treasury_subaccounts_repair_prepare(p_company uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_co        public.companies;
  v_fecha     date := (now() at time zone 'America/Caracas')::date;
  v_periodo   uuid;
  v_estado    text;
  v_entry     uuid;
  v_linea     integer := 0;
  v_c         record;
  v_s         record;
  v_sub       uuid;
  v_resto     numeric;
  v_divisa    numeric;
  v_repartido numeric;
  v_n_div     integer;
  v_i         integer;
  v_importe   numeric;
  v_familias  uuid[] := '{}';
  v_acta      jsonb;
  v_razon     text;
begin
  select * into v_co from public.companies where id = p_company;
  if v_co.id is null then
    return jsonb_build_object('company_id', p_company, 'repaired', 0, 'skipped', 'no_company');
  end if;

  -- (110200) Las cajas de la empresa, BLOQUEADAS antes de leer un solo saldo. Todo hecho de
  -- dinero (cobro, pago, gasto, cierre, reembolso, transferencia) referencia su caja por FK y
  -- toma FOR KEY SHARE sobre ella, que choca con este FOR UPDATE: el que ya estaba en curso
  -- termina antes de que leamos; el que llega después espera a que la reparación confirme.
  perform 1 from public.company_accounts ca where ca.company_id = p_company
   order by ca.id for update;

  -- Las cajas a reparar: las que apuntan a una cuenta de familia (la de cualquier vigencia del
  -- papel cash_bs o cash_usd) y tienen dónde crear su subcuenta.
  create temporary table if not exists _reparar_cajas (
    id uuid, tenant_id uuid, name text, currency text, funcional boolean,
    origen uuid, familia uuid, saldo numeric, sub uuid, importe numeric
  ) on commit drop;
  truncate _reparar_cajas;
  insert into _reparar_cajas (id, tenant_id, name, currency, funcional, origen, familia, saldo)
  select ca.id, ca.tenant_id, ca.name, ca.currency, ca.currency = v_co.functional_currency_code,
         ca.ledger_account_id,
         platform.treasury_default_ledger_account(p_company, ca.currency),
         coalesce(b.balance, 0)
    from public.company_accounts ca
    left join public.company_account_balances b on b.account_id = ca.id
   where ca.company_id = p_company
     and ca.ledger_account_id in (
           select s.account_id from public.company_account_settings s
            where s.company_id = p_company and s.purpose in ('cash_bs', 'cash_usd'));
  delete from _reparar_cajas where familia is null;

  if not exists (select 1 from _reparar_cajas) then
    return jsonb_build_object('company_id', p_company, 'repaired', 0);
  end if;

  select id, status into v_periodo, v_estado from public.fiscal_periods
   where company_id = p_company
     and year = extract(year from v_fecha)::int and month = extract(month from v_fecha)::int;
  if v_estado = 'closed' then
    v_razon := 'periodo_cerrado';
  elsif exists (select 1 from public.journal_generation_queue q
                 where q.company_id = p_company and q.status = 'pending') then
    v_razon := 'cola_pendiente';
  -- (110200) Si una plantilla vigente de la empresa, o una línea de cualquier preset, nombra
  -- cash_bs / cash_usd, sus hechos irían a la familia, que tras la reparación es agrupadora
  -- (LAD62). Hoy ninguna lo hace (LAD82 de la migración 56 lo garantiza para los hechos de
  -- tesorería); si alguna vuelve, la reparación no la rompe en silencio: salta y lo dice.
  elsif exists (select 1 from public.journal_templates t
                  join public.journal_template_lines l on l.template_id = t.id
                 where t.company_id = p_company and t.is_active and t.effective_to is null
                   and l.account_purpose in ('cash_bs', 'cash_usd'))
     or exists (select 1 from public.journal_template_preset_lines pl
                 where pl.account_purpose in ('cash_bs', 'cash_usd')) then
    v_razon := 'plantilla_nombra_familia';
  end if;
  if v_razon is not null then
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_co.tenant_id, p_company, 'company', p_company,
            'treasury.subaccounts_repair_skipped', 'system', now(),
            coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-repair'),
            jsonb_build_object('adr', 'ADR-0070', 'reason', v_razon,
                               'accounts', (select count(*) from _reparar_cajas)));
    return jsonb_build_object('company_id', p_company, 'repaired', 0, 'skipped', v_razon);
  end if;

  -- Las subcuentas, en orden estable.
  for v_c in select * from _reparar_cajas order by familia, id loop
    v_sub := platform.treasury_create_subaccount(v_c.familia, v_c.name);
    update _reparar_cajas set sub = v_sub where id = v_c.id;
    update public.company_accounts set ledger_account_id = v_sub where id = v_c.id;
  end loop;

  -- El importe de cada caja, por cuenta de ORIGEN (donde vive hoy su historia).
  for v_s in select distinct origen from _reparar_cajas loop
    select r.balance into v_resto from platform.recompute_ledger(p_company, v_s.origen) r;
    update _reparar_cajas set importe = saldo where origen = v_s.origen and funcional;
    v_resto := v_resto - coalesce((select sum(importe) from _reparar_cajas
                                    where origen = v_s.origen and funcional), 0);
    select coalesce(sum(saldo), 0), count(*) into v_divisa, v_n_div
      from _reparar_cajas where origen = v_s.origen and not funcional;
    v_repartido := 0;
    v_i := 0;
    for v_c in select * from _reparar_cajas where origen = v_s.origen and not funcional
               order by id loop
      v_i := v_i + 1;
      if v_divisa = 0 then
        v_importe := 0;
      elsif v_i = v_n_div then
        v_importe := v_resto - v_repartido;
      else
        v_importe := round(v_resto * v_c.saldo / v_divisa, 8);
      end if;
      v_repartido := v_repartido + v_importe;
      update _reparar_cajas set importe = v_importe where id = v_c.id;
    end loop;
    v_resto := v_resto - v_repartido;
    -- Lo que ninguna caja explica no se reparte a ojo: a «Por conciliar», que se ve.
    if v_resto <> 0 then
      v_sub := platform.treasury_create_subaccount(v_s.origen,
                 'Por conciliar (reparación ADR-0070)');
      insert into _reparar_cajas (id, tenant_id, name, currency, funcional, origen, familia,
                                  saldo, sub, importe)
      values (null, v_co.tenant_id, 'Por conciliar (reparación ADR-0070)',
              v_co.functional_currency_code, true, v_s.origen, v_s.origen, 0, v_sub, v_resto);
    end if;
  end loop;

  -- El asiento de reclasificación, en BORRADOR: de cada cuenta de origen a sus subcuentas.
  if exists (select 1 from _reparar_cajas where importe <> 0) then
    v_periodo := platform.period_for_date(p_company, v_fecha);
    insert into public.journal_entries
      (tenant_id, company_id, period_id, posting_date, source_kind, description, memo,
       rules_version)
    values (v_co.tenant_id, p_company, v_periodo, v_fecha, 'manual',
            'Reclasificación: cada cuenta de tesorería a su subcuenta contable (ADR-0070)',
            'Asiento del sistema. El saldo de cada caja pasa de la cuenta de su familia a su '
            || 'subcuenta propia; no mueve dinero.',
            coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-repair'))
    returning id into v_entry;
    for v_c in select * from _reparar_cajas where importe <> 0
               order by origen, id nulls last loop
      v_linea := v_linea + 1;
      insert into public.journal_lines
        (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
         amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
         functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
         description)
      values (v_co.tenant_id, p_company, v_entry, v_linea, v_c.sub,
              greatest(v_c.importe, 0), greatest(-v_c.importe, 0), abs(v_c.importe),
              v_co.functional_currency_code, 1, abs(v_c.importe), v_co.functional_currency_code,
              'identidad', now(), greatest(v_c.importe, 0), greatest(-v_c.importe, 0),
              'Saldo de «' || v_c.name || '»');
    end loop;
    for v_s in select origen, sum(importe) as total from _reparar_cajas
                group by origen having sum(importe) <> 0 order by origen loop
      v_linea := v_linea + 1;
      v_familias := v_familias || v_s.origen;
      insert into public.journal_lines
        (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
         amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
         functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
         description)
      values (v_co.tenant_id, p_company, v_entry, v_linea, v_s.origen,
              greatest(-v_s.total, 0), greatest(v_s.total, 0), abs(v_s.total),
              v_co.functional_currency_code, 1, abs(v_s.total), v_co.functional_currency_code,
              'identidad', now(), greatest(-v_s.total, 0), greatest(v_s.total, 0),
              'Sale de la cuenta de familia hacia sus subcuentas');
    end loop;
    -- La única vez que la familia recibe una línea después de tener hijas: para vaciarse en
    -- ellas. Hoja hasta que `finish` la devuelva a agrupadora, en esta misma transacción.
    update public.accounts set is_leaf = true where id = any (v_familias);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'company_account_id', r.id, 'account_name', r.name, 'currency', r.currency,
           'from_ledger_account_id', r.origen, 'subaccount_id', r.sub,
           'subaccount_code', (select a.code from public.accounts a where a.id = r.sub),
           'treasury_balance', r.saldo::text, 'reclassified_functional', r.importe::text)
           order by r.origen, r.id nulls last), '[]'::jsonb)
    into v_acta from _reparar_cajas r;
  return jsonb_build_object(
    'company_id', p_company,
    'repaired', (select count(*) from _reparar_cajas where id is not null),
    'posting_date', v_fecha,
    'entry_id', v_entry,
    'families', to_jsonb((select array_agg(distinct origen) from _reparar_cajas)),
    'accounts', v_acta);
end;
$$;
revoke execute on function platform.treasury_subaccounts_repair_prepare(uuid) from public;

-- El enunciado, exacto (el código no cambia):
comment on function platform.treasury_ledger_gaps(uuid) is
  'Invariante tesorería ↔ mayor (ADR-0070). Debe dar 0 filas. Por cada caja de la empresa: '
  'sin_subcuenta = no tiene cuenta contable y la empresa tiene VIGENTE el papel de su familia '
  '(cash_bs si la caja está en la moneda funcional, cash_usd si no); no_es_hoja = su cuenta '
  'contable agrupa; compartida = otra caja usa la misma cuenta contable; saldo_distinto = caja en '
  'moneda funcional, con cuenta propia y hoja, cuyo saldo no es el de su cuenta en el mayor. Las '
  'cajas en divisa no se comparan en importe hasta J-04 (E-11). «Sin asignar» es una caja más.';

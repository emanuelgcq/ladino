-- =============================================================================
-- Ladino — CADA CUENTA DE TESORERÍA TIENE SU SUBCUENTA CONTABLE (ADR-0070, J-01)
--
-- Módulo: contabilidad · tesorería (RIGOR MÁXIMO: dinero y mayor)
-- Spec: ADR-0070 · ADR-0060 §4 · ADR-0062 §3 · ADR-0067 · TREASURY_BANKING_SPEC
-- HOMOLOGATION_IMPACT: NO (no toca emisión, numeración, libros ni declaraciones).
--
-- EL DEFECTO (J-01, recorrido 2026-09-24). «Mover plata» entre dos cuentas de la misma moneda
-- daba SIEMPRE 500: «ON CONFLICT DO UPDATE command cannot affect row a second time». Toda cuenta
-- de tesorería en bolívares apuntaba a 1.1.01 (el trigger de la migración 56 la mapeaba a la
-- cuenta del papel cash_bs), el asiento de la transferencia tenía un débito y un crédito sobre
-- 1.1.01, y `apply_ledger_balance` metía las dos líneas en un solo INSERT … ON CONFLICT.
-- Aunque no chocara, el mayor no podía decir cuánto hay en cada cuenta.
--
-- LO QUE HACE:
--   1. `apply_ledger_balance` AGRUPA por cuenta antes del upsert. Un asiento con dos líneas
--      sobre la misma cuenta es legítimo (reclasificación, ajuste) y no debe romper nunca. Esto
--      solo ya cierra el 500 en TODAS las empresas, reparadas o no;
--   2. toda cuenta de tesorería NACE con su subcuenta contable, hija de la cuenta de su familia
--      y moneda (la del papel cash_bs si su moneda es la funcional, cash_usd si no: 1.1.01 /
--      1.1.02 en el plan ve_basico), con el nombre de la cuenta. Lo hace el trigger que ya
--      mapeaba la caja (una sola definición, la cree quien la cree) y el que mapea las cajas
--      nacidas antes del plan de cuentas;
--   3. la REPARACIÓN de las existentes, en dos funciones que envuelven el posteo:
--      `treasury_subaccounts_repair_prepare` (subcuentas + asiento de reclasificación en
--      BORRADOR) y `treasury_subaccounts_repair_finish` (comprobación + acta). El POSTEO lo hace
--      el dominio (`repairTreasurySubaccounts`, packages/domain/src/treasury.ts), como todo
--      posteo de Ladino: ninguna función SQL postea asientos, y esta no va a ser la primera;
--   4. el invariante `platform.treasury_ledger_gaps(company)`. Respuesta correcta: CERO filas.
--
-- MIENTRAS UNA EMPRESA NO ESTÉ REPARADA. Si la cuenta de familia ya tiene historia (líneas) o la
-- usa otra caja, una caja NUEVA de esa empresa se sigue mapeando a la familia, como antes: crear
-- una hija convertiría la familia en agrupadora (`set_account_path`) y LAD62 rechazaría desde ese
-- momento todos los hechos de las cajas viejas. La reparación reparte después también esa caja.
-- El invariante lo dice mientras tanto (`compartida`): nada queda escondido.
--
-- LA CUENTA DE FAMILIA DEJA DE SER HOJA tras la reparación. Ninguna plantilla vigente nombra
-- cash_bs/cash_usd (la migración 56 las pasó a `treasury_account`; LAD82), así que ningún hecho
-- automático va a la familia. Un asiento manual del contador sobre 1.1.01 se rechaza: debe usar
-- la subcuenta de la caja. La reparación es el ÚNICO asiento que vacía la familia hacia sus
-- hijas: `prepare` la marca hoja para ese posteo y `finish` la devuelve a agrupadora, en la
-- misma transacción, con la comprobación de que su saldo propio quedó en CERO (LAD82).
--
-- EL SALDO QUE SE RECLASIFICA. Para cada cuenta en la moneda funcional, el que la tesorería le
-- atribuye (`company_account_balances`). Las cuentas en divisa no tienen hoy importe original en
-- el mayor (E-11: las líneas se escriben en Bs a tasa 1): se reparten el resto de la cuenta de
-- familia en proporción a su saldo en divisa; con una sola cuenta en divisa, todo el resto es
-- suyo. Lo que ninguna cuenta explica NO se reparte a ojo: va a una subcuenta «Por conciliar
-- (reparación ADR-0070)» que el contador ve y cierra.
--
-- CUÁNDO NO REPARA (y lo deja escrito, `treasury.subaccounts_repair_skipped`):
--   · el período del día está cerrado (el asiento no se podría postear);
--   · la empresa tiene hechos en la cola de asientos: el hecho pendiente ya está en el saldo de
--     la tesorería y todavía no en el mayor; al reprocesarlo iría a la subcuenta y contaría dos
--     veces. Se vacía la cola y se vuelve a correr.
--
-- EXPAND/CONTRACT (ADR-0057). Esta migración no repara nada por sí sola: la API vieja sigue
-- funcionando igual (el generador resuelve la caja por `ledger_account_id`). La reparación corre
-- DESPUÉS del git pull (RESPUESTA §7), con `node scripts/reparar/adr-0070-subcuentas.mjs`.
--
-- REVERSIBILIDAD (con datos vivos: PARCIAL, y así se dice):
--   · `apply_ledger_balance`: volver a la versión de la migración de contabilidad es posible,
--     pero reabre el 500. No tiene sentido revertirla;
--   · los triggers: volver a su versión de la migración 56. Las subcuentas creadas quedan;
--   · una empresa YA REPARADA no se deshace borrando: el asiento de reclasificación está
--     posteado y es append-only (regla 2). Se revierte con su asiento de reversión y marcando la
--     familia como hoja otra vez; las subcuentas quedan en el plan, sin uso. El saldo de la
--     familia es la suma de sus hijas: un balance por rama no cambia (ADR-0070).
-- =============================================================================

-- ── 1. El mayor materializado agrupa por cuenta ─────────────────────────────
-- Definición VIVA de partida: 20260827233538_create_accounting.sql (ninguna migración posterior
-- la tocó). Lo único que cambia es el `group by`: Postgres no deja que un INSERT … ON CONFLICT
-- afecte dos veces a la misma fila. `ledger_balances` lleva una sola moneda por empresa (la
-- funcional), así que agrupar por cuenta es agrupar por cuenta y moneda.
create or replace function platform.apply_ledger_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_funcional text;
begin
  -- Solo la TRANSICIÓN a posteado. Un asiento que ya lo estaba y cambia de
  -- estado a 'reversed' no vuelve a sumar: su reversión es otro asiento.
  if new.status not in ('posted', 'reversed') then return new; end if;
  if tg_op = 'UPDATE' and old.status in ('posted', 'reversed') then return new; end if;

  select functional_currency_code into v_funcional from public.companies
   where id = new.company_id;

  insert into public.ledger_balances
    (tenant_id, company_id, account_id, period_id, debit_total, credit_total, functional_currency)
  select new.tenant_id, new.company_id, jl.account_id, new.period_id,
         sum(jl.functional_debit), sum(jl.functional_credit), v_funcional
    from public.journal_lines jl
   where jl.entry_id = new.id
   group by jl.account_id
  on conflict (company_id, account_id, period_id) do update
    set debit_total  = public.ledger_balances.debit_total  + excluded.debit_total,
        credit_total = public.ledger_balances.credit_total + excluded.credit_total;
  return new;
end;
$$;
revoke execute on function platform.apply_ledger_balance() from public;

-- ── 2. La subcuenta de una cuenta de tesorería ──────────────────────────────
-- Hija de `p_parent`, con el siguiente código libre `<padre>.NN` y el nombre de la caja. El
-- candado por empresa serializa dos altas simultáneas: sin él, las dos leerían el mismo máximo y
-- la segunda moriría en `accounts_company_code_key` con un 409 que nadie pidió.
-- Sin GRANT a nadie: la llaman los triggers (security definer) y la reparación.
create function platform.treasury_create_subaccount(p_parent uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_padre public.accounts;
  v_n     integer;
  v_code  text;
  v_id    uuid;
begin
  select * into v_padre from public.accounts where id = p_parent;
  if v_padre.id is null then
    raise exception 'la cuenta de familia % no existe', p_parent using errcode = 'LAD82';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_padre.company_id::text || '|treasury_subaccount', 0));
  select coalesce(max(substr(a.code, length(v_padre.code) + 2)::integer), 0) + 1 into v_n
    from public.accounts a
   where a.company_id = v_padre.company_id
     and a.parent_id = v_padre.id
     and substr(a.code, 1, length(v_padre.code) + 1) = v_padre.code || '.'
     and substr(a.code, length(v_padre.code) + 2) ~ '^[0-9]{1,9}$';
  loop
    v_code := v_padre.code || '.' || lpad(v_n::text, 2, '0');
    exit when not exists (select 1 from public.accounts
                           where company_id = v_padre.company_id and code = v_code);
    v_n := v_n + 1;
  end loop;
  insert into public.accounts
    (tenant_id, company_id, code, name, description, parent_id, kind, nature, currency_code,
     rules_version)
  values (v_padre.tenant_id, v_padre.company_id, v_code, left(btrim(p_name), 200),
          'Subcuenta de una cuenta de tesorería (ADR-0070)', v_padre.id, v_padre.kind,
          v_padre.nature, v_padre.currency_code,
          coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-trigger'))
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function platform.treasury_create_subaccount(uuid, text) from public;

-- ¿La cuenta de familia puede tener hijas sin romper nada? Solo si ninguna caja la usa y no
-- tiene historia propia. Si no, la empresa espera su reparación (ver cabecera).
create function platform.treasury_family_is_clean(p_family uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from public.company_accounts ca where ca.ledger_account_id = p_family)
     and not exists (select 1 from public.journal_lines jl where jl.account_id = p_family)
$$;
revoke execute on function platform.treasury_family_is_clean(uuid) from public;

-- ── 3. Toda caja nace con su subcuenta ──────────────────────────────────────
-- Definición viva de partida: 20260915130000 (migración 56). Un mapeo EXPLÍCITO sigue sin
-- pisarse. Ahora es security definer: quien crea una caja con `treasury.account.manage` no
-- necesita `accounting.account.manage` para que nazca su subcuenta — es parte del mismo hecho.
-- Es una función de trigger: nadie la puede invocar directamente.
create or replace function platform.treasury_account_default_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_familia uuid;
begin
  if new.ledger_account_id is null then
    v_familia := platform.treasury_default_ledger_account(new.company_id, new.currency);
    if v_familia is not null and platform.treasury_family_is_clean(v_familia) then
      new.ledger_account_id := platform.treasury_create_subaccount(v_familia, new.name);
    else
      -- Sin plan (NULL) o empresa aún sin reparar (la familia, como antes de ADR-0070).
      new.ledger_account_id := v_familia;
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function platform.treasury_account_default_ledger() from public;

-- Las cajas que nacieron ANTES del plan de cuentas reciben su subcuenta cuando se asigna el papel
-- cash_bs / cash_usd. Definición viva de partida: migración 56.
create or replace function platform.treasury_accounts_map_on_purpose()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c     record;
  v_cuenta uuid;
  v_limpia boolean;
begin
  if new.purpose not in ('cash_bs', 'cash_usd') then
    return new;
  end if;
  v_limpia := platform.treasury_family_is_clean(new.account_id);
  for v_c in
    select ca.id, ca.tenant_id, ca.name, ca.currency
      from public.company_accounts ca
      join public.companies co on co.id = ca.company_id
     where ca.company_id = new.company_id
       and ca.ledger_account_id is null
       and (case when ca.currency = co.functional_currency_code
                 then 'cash_bs' else 'cash_usd' end) = new.purpose
     order by ca.created_at, ca.id
  loop
    v_cuenta := case when v_limpia
                     then platform.treasury_create_subaccount(new.account_id, v_c.name)
                     else new.account_id end;
    update public.company_accounts set ledger_account_id = v_cuenta where id = v_c.id;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_c.tenant_id, new.company_id, 'company_account', v_c.id,
            'treasury.account.ledger_mapped', 'system', now(),
            coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-trigger'),
            jsonb_build_object('ledger_account_id', v_cuenta, 'parent_account_id', new.account_id,
                               'purpose', new.purpose, 'origin', 'purpose_assigned',
                               'account_name', v_c.name));
  end loop;
  return new;
end;
$$;
revoke execute on function platform.treasury_accounts_map_on_purpose() from public;

-- ── 4. El invariante: tesorería ↔ mayor, por cuenta ─────────────────────────
-- Enunciado (CLAUDE.md §3), para toda cuenta de tesorería de una empresa con plan de cuentas
-- —«Sin asignar» (ADR-0067) incluida: es una cuenta como las demás, con su subcuenta—:
--   · tiene subcuenta (`sin_subcuenta`), que es una hoja (`no_es_hoja`) y no la comparte con
--     otra cuenta de tesorería (`compartida`);
--   · si está en la moneda funcional, su saldo es el de su subcuenta en el mayor
--     (`saldo_distinto`). Un hecho que espera en la cola todavía no está en el mayor, y aparece
--     aquí como diferencia mientras espera: es verdad;
--   · si está en divisa, la igualdad de importes en moneda original la añade J-04, cuando el
--     mayor guarde el importe original de cada línea (E-11); hasta entonces se exige lo
--     estructural. ADR-0070 §4.
-- Una empresa sin plan de cuentas no tiene mayor contra el que comparar: sus cajas no salen.
-- Respuesta correcta: CERO filas.
create function platform.treasury_ledger_gaps(p_company uuid)
returns table (account_id uuid, account_name text, currency text, problem text,
               treasury_balance numeric, ledger_balance numeric)
language sql
stable
set search_path = ''
as $$
  with cajas as (
    select ca.id, ca.name, ca.currency, ca.ledger_account_id,
           coalesce(b.balance, 0) as saldo,
           ca.currency = co.functional_currency_code as funcional,
           platform.treasury_default_ledger_account(ca.company_id, ca.currency) as familia,
           a.is_leaf,
           (select count(*) from public.company_accounts o
             where o.company_id = ca.company_id
               and o.ledger_account_id = ca.ledger_account_id) as usos
      from public.company_accounts ca
      join public.companies co on co.id = ca.company_id
      left join public.company_account_balances b on b.account_id = ca.id
      left join public.accounts a on a.id = ca.ledger_account_id
     where ca.company_id = p_company
  ),
  mayor as (
    select c.*, (select r.balance
                   from platform.recompute_ledger(p_company, c.ledger_account_id) r) as en_mayor
      from cajas c
     where c.ledger_account_id is not null
  )
  select c.id, c.name, c.currency, 'sin_subcuenta', c.saldo, null::numeric
    from cajas c
   where c.ledger_account_id is null and c.familia is not null
  union all
  select m.id, m.name, m.currency, 'no_es_hoja', m.saldo, m.en_mayor
    from mayor m where not m.is_leaf
  union all
  select m.id, m.name, m.currency, 'compartida', m.saldo, m.en_mayor
    from mayor m where m.usos > 1
  union all
  select m.id, m.name, m.currency, 'saldo_distinto', m.saldo, m.en_mayor
    from mayor m
   where m.funcional and m.is_leaf and m.usos = 1 and m.saldo <> m.en_mayor
$$;
comment on function platform.treasury_ledger_gaps(uuid) is
  'Invariante tesorería ↔ mayor (ADR-0070): toda caja de una empresa con plan de cuentas tiene '
  'subcuenta propia y hoja; en moneda funcional, su saldo es el de su subcuenta. Debe dar 0 filas. '
  'La igualdad en moneda original de las cajas en divisa llega con J-04 (E-11).';
revoke execute on function platform.treasury_ledger_gaps(uuid) from public;
grant execute on function platform.treasury_ledger_gaps(uuid) to ladino_api, ladino_worker;

-- ── 5. La reparación: preparar (aquí) → postear (dominio) → cerrar (aquí) ───
-- Idempotente: una caja que ya tiene subcuenta (su cuenta contable no es la de ninguna familia)
-- no se toca, y una empresa sin nada que reparar no escribe nada.
--
-- `prepare` devuelve jsonb: {repaired, entry_id, families[], accounts[]} o {skipped: razón}.
-- Si `entry_id` no es nulo, el asiento queda en BORRADOR con sus líneas y las familias marcadas
-- hoja: quien llama lo postea y llama a `finish` EN LA MISMA TRANSACCIÓN.
create function platform.treasury_subaccounts_repair_prepare(p_company uuid)
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

-- Cierra la reparación: las familias vuelven a agrupadoras, su saldo propio es CERO, y el acta.
-- Si el asiento existe, tiene que estar posteado: una reparación a medias no se cierra.
create function platform.treasury_subaccounts_repair_finish(p_prepared jsonb, p_rules_version text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := (p_prepared ->> 'company_id')::uuid;
  v_entry   uuid := (p_prepared ->> 'entry_id')::uuid;
  v_tenant  uuid;
  v_familia uuid;
  v_c       jsonb;
begin
  if coalesce((p_prepared ->> 'repaired')::int, 0) = 0 then
    return p_prepared;
  end if;
  select tenant_id into v_tenant from public.companies where id = v_company;
  if v_entry is not null and not exists (
       select 1 from public.journal_entries e
        where e.id = v_entry and e.company_id = v_company and e.status = 'posted') then
    raise exception 'LAD82: el asiento de reclasificación % no está posteado', v_entry
      using errcode = 'LAD82';
  end if;
  for v_familia in select jsonb_array_elements_text(p_prepared -> 'families')::uuid loop
    update public.accounts set is_leaf = false
     where id = v_familia
       and exists (select 1 from public.accounts h where h.parent_id = v_familia);
    if (select r.balance from platform.recompute_ledger(v_company, v_familia) r) <> 0 then
      raise exception 'LAD82: la cuenta de familia % no quedó en cero tras la reclasificación',
        v_familia using errcode = 'LAD82';
    end if;
  end loop;

  for v_c in select jsonb_array_elements(p_prepared -> 'accounts') loop
    continue when v_c ->> 'company_account_id' is null;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_tenant, v_company, 'company_account', (v_c ->> 'company_account_id')::uuid,
            'treasury.account.ledger_mapped', 'system', now(), p_rules_version,
            jsonb_build_object('adr', 'ADR-0070', 'origin', 'treasury_subaccounts_repair',
                               'ledger_account_id', v_c -> 'subaccount_id',
                               'previous_ledger_account_id', v_c -> 'from_ledger_account_id',
                               'account_name', v_c -> 'account_name',
                               'reclassification_entry_id', v_entry));
  end loop;
  insert into public.audit_events
    (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
     actor_type, occurred_at, rules_version, payload)
  values (v_tenant, v_company, 'company', v_company,
          'treasury.subaccounts_repaired', 'system', now(), p_rules_version,
          jsonb_build_object('adr', 'ADR-0070', 'posting_date', p_prepared -> 'posting_date',
                             'reclassification_entry_id', v_entry,
                             'accounts', p_prepared -> 'accounts'));
  return p_prepared;
end;
$$;
revoke execute on function platform.treasury_subaccounts_repair_finish(jsonb, text) from public;

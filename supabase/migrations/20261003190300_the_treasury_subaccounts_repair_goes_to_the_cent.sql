-- =============================================================================
-- Ladino — LA REPARACIÓN DE SUBCUENTAS DE TESORERÍA ARMA SU ASIENTO AL CÉNTIMO
-- (ADR-0070 · ADR-0075 §7; el orden de despliegue de R-71, ejecutado entero por primera vez)
--
-- Módulo: tesorería · contabilidad. Rigor MÁXIMO (dinero, con datos vivos).
-- Qué pasaba: la restauración del escenario del recorrido corría la reparación de ADR-0070 ANTES
-- de la regularización del céntimo. Esa reparación reclasifica saldos heredados —con fracción de
-- céntimo— y reparte lo que queda entre las cajas en divisa a 8 decimales: desde la 20261003190000
-- su asiento muere al postear en LAD71, con el mensaje del asiento manual. Dos empresas del
-- escenario fallaban.
-- Qué cambia: `platform.treasury_subaccounts_repair_prepare`, create or replace sobre
-- 20260928110200 (la última que la define; ninguna posterior la toca). Tres diferencias, y nada
-- más: exige que la cuenta de origen llegue sin fracción (y dice qué correr antes); la caja en
-- moneda funcional recibe round(saldo, 2); el reparto entre cajas en divisa va a 2 decimales.
-- EL ORDEN es parte del arreglo: migraciones → adr-0075-centimo.mjs → adr-0070-subcuentas.mjs →
-- p-02-rif-normalizado.mjs → adr-0075-divisa-del-mayor.mjs (scripts/recorrido/correr.mjs y R-71).
-- No se manda residuo a «Diferencias por redondeo»: con la cuenta de origen al céntimo no hay
-- residuo; y una cuenta de origen CON fracción no se puede vaciar con líneas al céntimo (finish
-- exige que quede en cero), así que la salida correcta es regularizar antes, no redondear aquí.
-- Reversible: SÍ, create or replace con 20260928110200. Las reclasificaciones ya posteadas son
--   asientos: se revierten con su reversa. Una reparación ya corrida no se vuelve a correr
--   (idempotente: no encuentra cajas apuntando a la familia).
-- HOMOLOGATION_IMPACT: NO — no toca documentos, libros ni declaraciones.
-- =============================================================================

CREATE OR REPLACE FUNCTION platform.treasury_subaccounts_repair_prepare(p_company uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- 20261003190300 (ADR-0075 §7): TODO AL CÉNTIMO. Desde la 20261003190000 la base rechaza al
  -- postear una línea con más de dos decimales (LAD71), y este asiento se arma desde saldos
  -- heredados. Tres cosas:
  --   · la cuenta de origen tiene que llegar SIN fracción de céntimo: eso lo hace la
  --     regularización del céntimo, que corre ANTES. Si no corrió, se dice aquí con palabras
  --     — antes moría al postear con el mensaje del asiento manual;
  --   · la caja en moneda funcional recibe su saldo de tesorería al céntimo;
  --   · el reparto de lo que queda entre las cajas en divisa se redondea al céntimo (antes a 8),
  --     y la última se lleva el resto, que con lo anterior es un número entero de céntimos.
  -- Lo que ninguna caja explica sigue yendo a «Por conciliar», ahora también al céntimo.
  for v_s in select distinct origen from _reparar_cajas loop
    select r.balance into v_resto from platform.recompute_ledger(p_company, v_s.origen) r;
    if v_resto <> round(v_resto, 2) then
      raise exception
        'LAD82: la cuenta % tiene un saldo con fracción de céntimo (%). Corre ANTES la regularización del céntimo (scripts/reparar/adr-0075-centimo.mjs) y vuelve a correr esta reparación',
        (select a.code from public.accounts a where a.id = v_s.origen), v_resto
        using errcode = 'LAD82';
    end if;
    update _reparar_cajas set importe = round(saldo, 2) where origen = v_s.origen and funcional;
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
        v_importe := round(v_resto * v_c.saldo / v_divisa, 2);
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
$function$;

-- =============================================================================
-- Migración 53 · EL IGTF COBRADO ENTRA A LA CAJA
--
-- Módulos: tesorería · IGTF. Rigor máximo (dinero). ADR-0059. Encargo del
-- dueño, 2026-09-13: «piensa en una caja diaria».
--
-- El saldo de una cuenta se materializa con cuatro fuentes (migraciones 29,
-- 31, 32): cobros, pagos a proveedor, gastos y cierres de caja. La percepción
-- de IGTF (migración 46) es dinero que ENTRA en la misma caja que su pago —
-- el cliente entrega 23,37 USD: 22,69 de la venta y 0,68 del fisco— y su
-- asiento ya lo dice (Dr caja / Cr IGTF por enterar). Pero ninguna fuente la
-- llevaba al saldo: la caja «esperaba» 22,69 y el cierre salía con un
-- sobrante que era dinero del fisco. En producción, 166 percepciones en tres
-- cuentas (Caja USD, Zelle, Sin asignar) y CERO cierres de caja: el saldo se
-- corrige sin reescribir ningún cierre.
--
-- Qué hace:
--   · trigger AFTER INSERT en igtf_perceptions: suma `amount` a la cuenta del
--     pago. La moneda de la percepción es la de su pago y la de su cuenta; si
--     no coincide, FALLA (un saldo en USD no admite un monto en Bs);
--   · la redistribución de un pago entre cuentas (UPDATE de account_id) mueve
--     también su percepción;
--   · el recómputo aprende la quinta fuente;
--   · backfill: suma las percepciones existentes a sus cuentas, con una guarda
--     que FALLA si alguna cuenta tiene un cierre de caja posterior a una
--     percepción (ese cierre ya contó el IGTF como diferencia y sumarlo otra
--     vez sería contarlo dos veces). Hoy no hay ninguno.
--
-- Un cambio de `status` (pendiente_reintegro) NO mueve saldo: el dinero sigue
-- en la caja hasta que el reintegro exista como movimiento propio.
-- Reversible con otra migración: quitar el trigger, restaurar las dos
-- funciones y restar lo sumado. HOMOLOGATION_IMPACT: NO (tesorería).
-- =============================================================================

-- ── 1. La percepción suma a la caja de su pago ──────────────────────────────
create function platform.apply_igtf_perception_to_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account  uuid;
  v_currency text;
begin
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
create trigger igtf_perceptions_zz_balance
  after insert on public.igtf_perceptions
  for each row execute function platform.apply_igtf_perception_to_balance();

-- ── 2. Redistribuir un pago mueve también su IGTF ───────────────────────────
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
    select coalesce(sum(ip.amount), 0) into v_igtf
      from public.igtf_perceptions ip where ip.payment_id = new.id;
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

-- ── 3. El recómputo aprende la quinta fuente ────────────────────────────────
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
                    where p.account_id = p_account), 0)
       - coalesce((select sum(net_amount) from public.supplier_payments
                    where account_id = p_account), 0)
       - coalesce((select sum(amount_transaction_currency) from public.expenses
                    where account_id = p_account), 0)
       + coalesce((select sum(amount_transaction_currency) from public.cash_closings
                    where account_id = p_account), 0)
$$;

-- ── 4. Backfill, con la guarda del doble conteo ─────────────────────────────
do $$
begin
  if exists (
    select 1
      from public.igtf_perceptions ip
      join public.payments p on p.id = ip.payment_id
      join public.cash_closings cc on cc.account_id = p.account_id
     where cc.closed_at > ip.occurred_at
  ) then
    raise exception
      'hay cierres de caja posteriores a percepciones de IGTF: ese cierre ya registró el IGTF como diferencia y el backfill lo contaría dos veces. Resolver a mano antes de aplicar.'
      using errcode = 'P0001';
  end if;
end;
$$;

do $$
declare
  r record;
begin
  for r in
    select p.account_id, sum(ip.amount) as total
      from public.igtf_perceptions ip
      join public.payments p on p.id = ip.payment_id
     where p.account_id is not null
     group by p.account_id
  loop
    perform platform.bump_account_balance(r.account_id, r.total);
  end loop;
end;
$$;

comment on function platform.recompute_account_balance(uuid) is
  'El saldo de una cuenta desde sus hechos: cobros + IGTF percibido en esos cobros '
  '− pagos a proveedor − gastos + ajustes de cierre (migración 53, ADR-0059).';

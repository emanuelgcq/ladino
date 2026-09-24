-- =============================================================================
-- Ladino — migración 73 · DÓNDE CAYÓ EL DINERO QUE NADIE ELIGIÓ (ADR-0067 §4)
--
-- Cuando una pantalla no preguntaba de qué cuenta salía el dinero, el servidor la
-- deducía con la escalera de ADR-0062 §1: forma configurada → cuenta propia de la
-- familia, LA MÁS ANTIGUA → «Sin asignar». Con una cuenta por familia acierta
-- siempre; con dos, «la más antigua» no es una regla de negocio, es un desempate.
--
-- En producción, el 2026-09-18, eso repartió el dinero de la empresa «Ladino» así:
-- `zelle` cayó 64 veces en Zelle, 41 en Caja USD y 3 en «Sin asignar»; `efectivo_usd`
-- cayó 43 veces en la cuenta de Zelle. Banesco existe, está activa, y no ha recibido
-- un solo bolívar.
--
-- Esta función lo ENSEÑA. No arregla nada y no puede: un pago es un hecho con su
-- fecha, su autor y su asiento, y no se reescribe (regla 2, ADR-0006). Lo que se
-- mueve, lo mueve una persona con la transferencia entre cuentas (ADR-0062 §3).
--
-- **Es un INFORME, no un invariante, y su respuesta correcta NO es cero.** «Sin
-- asignar» es legítima mientras el negocio no tenga una cuenta de esa familia — para
-- eso la creó ADR-0062. Va escrito aquí para que nadie la meta en un gate: un control
-- que devuelve filas normales enseña a ignorar los controles (ADR-0066 §8).
--
-- Reversibilidad: total (`drop function`). No toca datos.
-- HOMOLOGATION_IMPACT = NO: es una lectura.
-- =============================================================================

create function platform.money_landing_gaps(p_company uuid)
returns table (
  kind text,            -- cobro · pago a proveedor · gasto
  movement_id uuid,
  occurred_on date,
  instrument text,
  amount numeric,
  currency text,
  account_id uuid,
  account_name text,
  problem text          -- 'sin_asignar' · 'familia_no_corresponde'
)
language sql
stable
set search_path = ''
as $$
  -- La familia que le toca a cada instrumento es la MISMA que aplica el servidor al deducir
  -- (`FAMILIA_DE_INSTRUMENTO` en packages/domain/src/treasury.ts). Si una de las dos cambia sin
  -- la otra, esta función empieza a señalar como error lo que el servidor considera correcto:
  -- por eso está escrita aquí entera y en el mismo orden, y por eso el pgTAP la compara caso a
  -- caso contra la lista de instrumentos que admite el esquema.
  with familia as (
    select * from (values
      ('efectivo_bs',   array['cash']),
      ('efectivo_usd',  array['cash']),
      ('pago_movil',    array['bank','wallet']),
      ('transferencia', array['bank','wallet']),
      ('punto_venta',   array['bank','wallet']),
      ('tarjeta',       array['bank','wallet']),
      ('cashea',        array['bank','wallet']),
      ('zelle',         array['wallet','bank']),
      ('usdt',          array['wallet','bank']),
      ('otro',          array['bank','wallet','cash'])
    ) as f(instrument, kinds)
  ),
  movimientos as (
    select 'cobro'::text as kind, p.id as movement_id,
           (p.paid_at at time zone 'America/Caracas')::date as occurred_on,
           p.instrument, p.amount, p.currency, p.account_id
      from public.payments p
     where p.company_id = p_company and p.account_id is not null
    union all
    select 'pago a proveedor', sp.id,
           (sp.paid_at at time zone 'America/Caracas')::date,
           sp.instrument, sp.amount_transaction_currency, sp.transaction_currency, sp.account_id
      from public.supplier_payments sp
     where sp.company_id = p_company and sp.account_id is not null
    union all
    -- El gasto no guarda instrumento: siempre se eligió la cuenta a mano. Solo puede tener el
    -- problema de haber caído en una cuenta de sistema, nunca el de familia.
    select 'gasto', e.id,
           (e.paid_at at time zone 'America/Caracas')::date,
           null, e.amount_transaction_currency, e.transaction_currency, e.account_id
      from public.expenses e
     where e.company_id = p_company and e.account_id is not null
  )
  select m.kind, m.movement_id, m.occurred_on, m.instrument, m.amount, m.currency,
         m.account_id, a.name,
         case when a.is_system then 'sin_asignar' else 'familia_no_corresponde' end as problem
    from movimientos m
    join public.company_accounts a on a.id = m.account_id
    left join familia f on f.instrument = m.instrument
   where a.is_system
      or (m.instrument is not null and f.kinds is not null and not (a.kind = any(f.kinds)))
   order by m.occurred_on desc, m.kind
$$;
comment on function platform.money_landing_gaps(uuid) is
  'INFORME, no invariante (ADR-0067 §4): cobros, pagos a proveedor y gastos que cayeron en una '
  'cuenta de SISTEMA («Sin asignar») o en una cuenta cuya familia no corresponde al instrumento '
  '(efectivo en un banco, pago móvil en una caja física). Su respuesta correcta NO es cero: «Sin '
  'asignar» es legítima mientras no exista una cuenta de esa familia. Lo que haya que mover, lo '
  'mueve una persona con la transferencia entre cuentas — aquí no se reescribe ningún hecho.';
revoke execute on function platform.money_landing_gaps(uuid) from public;
grant execute on function platform.money_landing_gaps(uuid) to authenticated, ladino_api;

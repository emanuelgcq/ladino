-- Módulo: ventas · cobros y saldos a favor   Spec: docs/00_GOVERNANCE/adr/ADR-0075-* (decisión 5)
-- Ola 4 · tercera ronda — completa a 20261004190200 (una migración creada no se edita)
-- Reversible: SÍ (ver el pie)   Homologación: NO (una función de lectura; no cambia ningún cálculo)
--
-- Qué pasaba: la variante rota del pgTAP 133 quitó el trigger que impide resucitar un saldo a
-- favor retirado, lo resucitó, y platform.customer_credit_ledger_gap siguió diciendo CERO. El
-- invariante solo sumaba los saldos cuyo nacimiento tiene asiento posteado: el de un saldo
-- resucitado está REVERSADO (se reversó su cobro), así que no entraba en ningún lado de la
-- comparación. Era ciego justo al defecto que la ronda cierra — un saldo que el cliente puede
-- cobrar y el mayor no debe. La base local tenía uno, dejado por el test en rojo del punto 1.
--
-- Qué hace: redefine platform.customer_credit_ledger_gap sobre su ÚLTIMA definición
-- (20261004190200 §5, copiada entera) con una tercera clase de fila, `unborn`: un saldo a favor
-- no retirado cuyo nacimiento no tiene asiento vigente ni está en la cola de pendientes. No es un
-- perdón ni una lista: es una frase más del enunciado.
-- «Expand»: solo lectura. No lee nada que cree una migración posterior.

create or replace function platform.customer_credit_ledger_gap(p_company uuid)
returns table (kind text, customer_credit_id uuid, expected numeric, ledger numeric,
               gap numeric, queued numeric)
language sql
stable
set search_path = ''
as $$
  -- ENUNCIADO: en una empresa con cuenta de saldos a favor de clientes (papel
  -- customer_credit_liability),
  --     Σ, sobre los saldos a favor NO retirados cuyo nacimiento tiene asiento, de lo que nacieron
  --   − Σ, sobre sus usos vivos con asiento (aplicaciones y reembolsos), de lo que cada uno bajó
  --   = el saldo acreedor de esas cuentas en el mayor;
  -- todo saldo a favor AGOTADO no carga nada: lo que nació = lo que bajaron sus usos;
  -- y todo saldo a favor no retirado NACIÓ: su nacimiento tiene asiento vigente o está en la cola.
  -- Con estas precisiones, que son parte del enunciado y no perdones:
  --   · un saldo a favor nace de una nota de crédito, de un recibo de devolución o del sobrante de
  --     un cobro; lo que nació es su importe funcional (el total en Bs del documento, o el
  --     sobrante a la tasa del cobro);
  --   · un saldo retirado (`expired`: se reversó el cobro que lo creó) no es un saldo a favor, y
  --     el asiento de su cobro y su contra-asiento se anulan en el mayor;
  --   · una aplicación reversada no es un uso, y su asiento y su contra-asiento se anulan;
  --   · el mayor se toma sin la revaluación al cierre (es por cuenta y moneda: ADR-0075 §6) y sin
  --     el asiento de la regularización del céntimo (ADR-0075 §7);
  --   · lo que está en la cola de pendientes no entra en ninguno de los dos lados: `queued` dice
  --     cuánto es, y de que no se pierda responde accounting_coverage_gaps.
  -- Filas: `ledger` (una, si el total no coincide con el mayor), `exhausted` (una por saldo a
  -- favor agotado que todavía carga algo) y `unborn` (una por saldo a favor vivo cuyo nacimiento
  -- no tiene asiento vigente ni está en la cola: un saldo retirado que resucitó, o uno escrito
  -- sin su documento; el mayor no lo debe y el cliente lo puede cobrar). Sin lista de exclusiones: un asiento manual sobre la
  -- cuenta, o cualquier hecho que la mueva sin ser el nacimiento o el uso de un saldo, da fila.
  with cuentas as (
    select distinct s.account_id from public.company_account_settings s
     where s.company_id = p_company and s.purpose = 'customer_credit_liability'
  ),
  vivos as (
    select cc.id, cc.amount, cc.applied_amount,
           coalesce(cc.functional_amount,
                    platform.round_cents(cc.amount * coalesce(cc.fx_rate, 1))) as nacio,
           exists (select 1 from public.journal_entries e
                    where e.company_id = p_company and e.status = 'posted'
                      and ((cc.source_payment_id is not null
                            and e.source_kind = 'payment_received'
                            and e.source_id = cc.source_payment_id)
                        or (cc.source_payment_id is null
                            and e.source_kind in ('sales_credit_note', 'sales_receipt_return')
                            and e.source_id = cc.source_document_id))) as con_asiento,
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.status = 'pending'
                      and q.source_id = coalesce(cc.source_payment_id, cc.source_document_id))
             as en_cola
      from public.customer_credits cc
     where cc.company_id = p_company and cc.status <> 'expired'
  ),
  usos as (
    select u.customer_credit_id, u.functional,
           exists (select 1 from public.journal_entries e
                    where e.company_id = p_company and e.status = 'posted'
                      and e.source_kind = u.source_kind and e.source_id = u.source_id)
             as con_asiento,
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.status = 'pending'
                      and q.source_id = u.source_id) as en_cola
      from platform.customer_credit_uses(p_company) u
     where u.reversed_on is null
       and u.customer_credit_id in (select v.id from vivos v)
  ),
  esperado as (
    select coalesce((select sum(v.nacio) from vivos v where v.con_asiento), 0)
           - coalesce((select sum(u.functional) from usos u where u.con_asiento), 0) as v,
           coalesce((select sum(v.nacio) from vivos v where v.en_cola and not v.con_asiento), 0)
           - coalesce((select sum(u.functional) from usos u
                        where u.en_cola and not u.con_asiento), 0) as cola
  ),
  mayor as (
    select coalesce(sum(jl.functional_credit - jl.functional_debit), 0) as v
      from public.journal_lines jl
      join public.journal_entries e on e.id = jl.entry_id and e.company_id = p_company
      left join public.journal_entries o on o.id = e.is_reversal_of
     where jl.company_id = p_company
       and jl.account_id in (select c.account_id from cuentas c)
       and e.status in ('posted', 'reversed')
       and not ((e.source_kind = 'exchange_diff' and e.source_event = 'fx.revaluation_at_close')
                or coalesce(o.source_kind = 'exchange_diff'
                            and o.source_event = 'fx.revaluation_at_close', false))
       and e.id not in (select platform.cent_regularization_entry_ids(p_company))
  )
  select 'ledger'::text, null::uuid, esperado.v, mayor.v, esperado.v - mayor.v, esperado.cola
    from esperado, mayor
   where exists (select 1 from cuentas)
     and esperado.v - mayor.v <> 0
  union all
  select 'exhausted'::text, x.id, 0::numeric, x.queda, -x.queda, 0::numeric
    from (select v.id, v.amount, v.applied_amount,
                 v.nacio - coalesce((select sum(u.functional)
                                       from platform.customer_credit_uses(p_company) u
                                      where u.customer_credit_id = v.id
                                        and u.reversed_on is null), 0) as queda
            from vivos v) x
   where x.applied_amount >= x.amount and x.queda <> 0
  union all
  select 'unborn'::text, v.id, v.nacio, 0::numeric, v.nacio, 0::numeric
    from vivos v
   where not v.con_asiento and not v.en_cola
$$;
comment on function platform.customer_credit_ledger_gap(uuid) is
  'INVARIANTE: Σ por saldo a favor no retirado con asiento (lo que nació − lo que bajaron sus '
  'usos vivos con asiento) = saldo acreedor de las cuentas de saldos a favor de clientes del '
  'mayor, sin la revaluación al cierre ni la regularización del céntimo; y un saldo a favor '
  'agotado no carga nada; y todo saldo a favor no retirado nació con asiento o está en la cola. '
  'Lo que está en la cola va en `queued`. Cero filas.';
revoke all on function platform.customer_credit_ledger_gap(uuid) from public;
grant execute on function platform.customer_credit_ledger_gap(uuid) to authenticated, ladino_api;

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos)
--   · Solo lectura: volver a la definición de 20261004190200 con otra migración no toca datos, y
--     devuelve al invariante su punto ciego (un saldo a favor resucitado da cero filas).
-- A la fecha, ninguna migración posterior redefine customer_credit_ledger_gap.
-- =============================================================================

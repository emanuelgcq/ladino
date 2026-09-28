-- Invariantes que cruzan módulos (CLAUDE.md §3), para UNA empresa. Solo lectura.
-- Uso:  docker exec -i supabase_db_ladino psql -U postgres -At -v cid=<uuid> < scripts/recorrido/invariantes.sql
-- Todas deberían dar 0 salvo los dos INFORMES del final (backdated_stock_in, money_landing_gaps),
-- cuya respuesta correcta NO es cero (R-48, R-49).
\pset fieldsep ' | '
select 'stock_reconciliation (filas con diferencia)', count(*)::text
  from platform.stock_reconciliation(:'cid')
 where materialized_quantity <> recomputed_quantity or materialized_value <> recomputed_value;
select 'accounting_coverage_gaps', count(*)::text from platform.accounting_coverage_gaps(:'cid');
select 'inventory_coverage_gaps', count(*)::text from platform.inventory_coverage_gaps(:'cid');
select 'annulled_stock_gaps', count(*)::text from platform.annulled_stock_gaps(:'cid');
select 'inventory_ledger_gap (diferencia)', coalesce((select diferencia::text from platform.inventory_ledger_gap(:'cid')), '(sin fila)');
select 'trial_balance hoy (sum debe - sum haber)',
       coalesce(sum(period_debit) - sum(period_credit), 0)::text
  from platform.trial_balance(:'cid', (now() at time zone 'America/Caracas')::date, null);
select 'treasury_reconciliation (cuentas no ok)', count(*)::text
  from platform.treasury_reconciliation(:'cid') where not ok;
-- Por CUENTA, sumando todos los períodos: ledger_balances tiene una fila por (cuenta, período) y
-- recompute_ledger(…, null, null) da el total histórico. Compararlos fila a fila (como hacía la versión
-- anterior) da rojo en cuanto una cuenta tiene movimientos en dos períodos (bloque K: agosto y septiembre).
select 'ledger_balances vs recompute_ledger (cuentas con diferencia)', count(*)::text
  from (select account_id, sum(debit_total) d, sum(credit_total) c
          from public.ledger_balances where company_id = :'cid' group by account_id) lb
 cross join lateral platform.recompute_ledger(:'cid', lb.account_id, null, null) r
 where r.debit_total is distinct from lb.d or r.credit_total is distinct from lb.c;
select 'cola de asientos pendiente', count(*)::text
  from public.journal_generation_queue where company_id = :'cid' and status = 'pending';
select 'outbox pending/in_flight/dead', coalesce(string_agg(status || '=' || n, ', '), '(vacío)')
  from (select status, count(*) n from public.outbox where company_id = :'cid' and status <> 'published' group by status) s;
select 'INFORME backdated_stock_in (no es invariante)', count(*)::text from platform.backdated_stock_in(:'cid');
select 'INFORME money_landing_gaps (no es invariante)', count(*)::text from platform.money_landing_gaps(:'cid');
-- Desde el bloque L: la conciliación «libro = mayor + cola» de septiembre (platform.book_ledger_reconciliation).
-- Es un INFORME, no un invariante del guion: hoy da rojo en E2 y E3 por el hallazgo L-01 (el libro de ventas suma
-- las notas de crédito). Se mira para saber si cambia, no para cerrar un bloque en rojo.
select 'INFORME conciliación libro-mayor sep (conceptos que NO cuadran)', count(*)::text
  from platform.book_ledger_reconciliation(:'cid', date '2026-09-01', date '2026-09-30') where not cuadra;

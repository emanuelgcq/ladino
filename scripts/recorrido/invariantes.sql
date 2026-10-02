-- Invariantes que cruzan módulos (CLAUDE.md §3), para UNA empresa. Solo lectura.
-- Uso:  docker exec -i supabase_db_ladino psql -U postgres -At -v cid=<uuid> < scripts/recorrido/invariantes.sql
-- Todas deberían dar 0 salvo los dos INFORMES (backdated_stock_in, money_landing_gaps),
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
-- ADR-0070 (J-01): cada caja de tesorería tiene su subcuenta propia y hoja, y en moneda funcional su saldo es
-- el de su subcuenta. «Sin asignar» (ADR-0067) es una caja más, con su subcuenta: no hay perdón que listar. La
-- igualdad en moneda original de las cajas en divisa llega con J-04 (E-11).
select 'treasury_ledger_gaps (cajas ≠ su subcuenta)', count(*)::text from platform.treasury_ledger_gaps(:'cid');
select 'cola de asientos pendiente', count(*)::text
  from public.journal_generation_queue where company_id = :'cid' and status = 'pending';
select 'outbox pending/in_flight/dead', coalesce(string_agg(status || '=' || n, ', '), '(vacío)')
  from (select status, count(*) n from public.outbox where company_id = :'cid' and status <> 'published' group by status) s;
select 'INFORME backdated_stock_in (no es invariante)', count(*)::text from platform.backdated_stock_in(:'cid');
select 'INFORME money_landing_gaps (no es invariante)', count(*)::text from platform.money_landing_gaps(:'cid');
-- L-02: la conciliación «libro fiscal = mayor + cola» (platform.book_ledger_reconciliation) es INVARIANTE desde
-- la migración 20260928120000, que firmó la NC en negativo (L-01). Sobre TODA la historia de la empresa, no un
-- mes: una NC de agosto que el libro sumara se vería igual que una de septiembre.
select 'book_ledger_reconciliation toda la historia (conceptos que NO cuadran)', count(*)::text
  from platform.book_ledger_reconciliation(:'cid', date '1900-01-01', date '2999-12-31') where not cuadra;
-- G-01 (ADR-0071): un número de control no se repite en la empresa e identificador, sea factura, NC o ND
-- (PA 00071 art. 44), y ningún talonario vivo pisa otro. Migración 20260928160100.
select 'control_number_collisions (controles repetidos)', count(*)::text
  from platform.control_number_collisions() where company_id = :'cid';
select 'control_range_overlaps (talonarios que se pisan)', count(*)::text
  from platform.control_range_overlaps() where company_id = :'cid';
-- ADR-0072 §4 (H10 de la revisión de la parte 3): toda retención de IVA practicada desde el corte tiene su
-- renglón en un comprobante VIGENTE por el mismo importe. El corte (platform.invariant_cutoffs) va en el
-- enunciado: lo anterior a la migración 20261002110200 lo vigila PENDIENTES_ASESOR P-63.
select 'retention_voucher_gaps (retenciones sin comprobante vigente)', count(*)::text
  from platform.retention_voucher_gaps(:'cid');

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
-- ADR-0082 (20261005100000 a 100900): retiro gravado desde el corte ⇒ factura de retiro con su IVA en el asiento,
-- sin cartera y a nombre de la propia empresa (antes del corte, su Nota de retiro); corregido con su nota de
-- crédito, netea en cero; toda factura de retiro documenta una salida que existe, es de la empresa y la señala
-- (20261005100970); y si falta la fila del corte, lo dice (falta_el_corte).
select 'withdrawal_note_gaps', count(*)::text from platform.withdrawal_note_gaps(:'cid');
select 'annulled_stock_gaps', count(*)::text from platform.annulled_stock_gaps(:'cid');
-- I-04 (20261005130000): venta de compuesto ⇒ sus ingredientes salieron del kardex, en la proporción de la
-- receta de ese momento; cada fila coincide con su movimiento; de ninguna salida volvió más de lo que salió.
select 'composite_sale_gaps', count(*)::text from platform.composite_sale_gaps(:'cid');
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
-- Y MES A MES (ola 3, migración 20261003190400). «Toda la historia» sola no basta: una diferencia en
-- septiembre compensada por un asiento de octubre (la regularización del céntimo) cuadraba en el total
-- y descuadraba en los dos meses. Los últimos 24 meses, uno por uno.
select 'book_ledger_reconciliation mes a mes (meses y conceptos que NO cuadran)', count(*)::text
  from generate_series(date_trunc('month', platform.caracas_day(now())) - interval '23 months',
                       date_trunc('month', platform.caracas_day(now())), interval '1 month') m,
       lateral platform.book_ledger_reconciliation(
         :'cid', m::date, (m + interval '1 month - 1 day')::date) r
 where not r.cuadra;
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
-- ADR-0075 §7 (P-01, P-03, K-08): el mayor al céntimo, incluido el inventario. Ninguna línea de asiento ni
-- movimiento de kardex posterior a la regularización del céntimo con fracción de céntimo, ningún valor de
-- posición y ningún saldo de cuenta con fracción. El corte (acta accounting.cent_regularized) va en el
-- enunciado; la reversa exacta de un asiento anterior al corte es lo único con fracción que admite.
select 'cent_gaps (importes con fracción de céntimo)', count(*)::text from platform.cent_gaps(:'cid');
-- ADR-0075 §6 (J-04, E-11): el saldo de cada cuenta de tesorería, EN SU MONEDA, es la suma de los importes
-- originales en esa moneda de su subcuenta contable (en bolívares, su saldo funcional; en divisa, sus dólares).
-- Sin corte: lo anterior a la migración 20261003180000 lo lleva al mayor la reparación
-- scripts/reparar/adr-0075-divisa-del-mayor.mjs, que corre en el post-pull.
select 'treasury_currency_gaps (cajas ≠ su subcuenta en la moneda de la caja)', count(*)::text
  from platform.treasury_currency_gaps(:'cid');
-- ADR-0075 §1 (E-05): en todo documento fiscal emitido desde el corte, el IVA en Bs de cada línea es
-- round(base en Bs × alícuota, 2), el pie es la suma de sus líneas y el total en divisa a la tasa del documento
-- no se aparta del total en Bs más que el redondeo por línea. El corte (platform.invariant_cutoffs) va en el
-- enunciado: un documento emitido antes no se edita (regla 1). Migración 20261003170000.
select 'fiscal_amount_gaps (documentos fiscales cuyo IVA en Bs no sale de su base en Bs)', count(*)::text
  from platform.fiscal_amount_gaps(:'cid');
-- ADR-0075 §4 (F-15, H-02): ningún documento saldado desde el corte —venta o factura de compra `paid`— deja
-- residuo en cuentas por cobrar o por pagar del mayor. Lo que tiene una pieza en la cola no se juzga aquí: lo
-- juzga accounting_coverage_gaps.
select 'settled_ledger_gaps (saldados con residuo en CxC o CxP del mayor)', count(*)::text
  from platform.settled_ledger_gaps(:'cid');
-- ADR-0083 §5 (H-03, 20261005110200): el saldo a favor que declaran las notas de crédito de proveedor
-- vigentes = el saldo del mayor en la cuenta de saldos a favor con proveedores, más la cola.
select 'supplier_credit_ledger_gap (saldo a favor con proveedores: declarado vs mayor)', count(*)::text
  from platform.supplier_credit_ledger_gap(:'cid');
-- ADR-0079 (B-06): desde el corte (platform.invariant_cutoffs, contra `created_at`), en TODA tabla que lleva
-- `rules_version` —documentos, asientos, actas, facturas de proveedor, retenciones, comprobantes, notas de
-- retiro, historia del tipo de contribuyente, cuentas— toda versión escrita está REGISTRADA en
-- platform.rules_versions (una versión de reglas o una cadena de sistema declarada); y todo documento fiscal
-- EMITIDO y todo movimiento contable lleva una versión de REGLAS, nunca una cadena de sistema: `documents` en
-- issued/paid/annulled, `supplier_invoices` en posted/paid/annulled, `retention_vouchers`, `supplier_retentions`,
-- `inventory_withdrawal_notes` y `journal_entries` en posted/reversed. Lo anterior al corte conserva la suya y
-- no se edita (reglas 1 y 2). Migraciones 20261004120000, 120200 y 205000.
select 'rules_version_gaps (versión de reglas sin registrar, o documento/asiento sin versión de REGLAS)', count(*)::text
  from platform.rules_version_gaps(:'cid');
-- B-14 (migraciones 20261004120100 y 205000): toda tasa GLOBAL creada desde el corte tiene su acta en
-- system_audit_events (`fx.rate.captured`, la del dominio, o `fx.rate.inserted_without_capture`, la que deja la
-- base al cierre). No depende de la empresa (se repite igual en las tres). Hoy lo sostiene un trigger diferido:
-- esta consulta es quien lo mira desde fuera.
select 'global_rate_record_gaps (tasas globales sin acta)', count(*)::text
  from platform.global_rate_record_gaps();
-- ADR-0079: el hash de las reglas GLOBALES guardado es el que sale de recalcularlo. No depende de la empresa
-- (se repite igual en las tres): una fila aquí es una tabla de reglas que cambió sin pasar por su trigger.
select 'rule_set_drift (hash global de reglas distinto del recalculado)', count(*)::text
  from platform.rule_set_drift();
-- J-02 (ADR-0062 §4): un cierre de caja con el saldo esperado EN NEGATIVO (menor que cero en las unidades
-- mínimas de la moneda de la caja) no tiene vigente el origen `cash_closing` —el sobrante contra resultado—,
-- ni asentado ni pendiente en la cola: su hecho es `cash_closing_overdraft` (el sobregiro se le debe al dueño).
-- Sin corte: lo anterior lo lleva a cero scripts/reparar/j-02-sobregiro-al-cierre.mjs, en el post-pull.
-- Migración 20261004180300.
select 'overdraft_closing_gaps (cierres en sobregiro asentados o encolados como sobrante)', count(*)::text
  from platform.overdraft_closing_gaps(:'cid');
-- F-12 (ola 4; migración 20261004150000): la cartera por documento es la cuenta por cobrar del mayor. Σ por
-- documento de venta con asiento (total − lo que cancelaron sus cobros vivos con asiento) = saldo de las cuentas
-- ar_general, sin la revaluación al cierre ni la regularización del céntimo. Lo que está en la cola no entra en
-- ninguno de los dos lados (lo vigila accounting_coverage_gaps). Sin lista de exclusiones: un asiento manual
-- sobre la cuenta por cobrar da fila.
select 'receivables_ledger_gap (cartera por documento ≠ cuenta por cobrar del mayor)', count(*)::text
  from platform.receivables_ledger_gap(:'cid');
-- G-10 (ola 4; migración 20261004160200; PA 00071 arts. 22 y 36): desde el corte (platform.invariant_cutoffs,
-- contra `annulled_at`), toda FACTURA anulada se anuló el mismo día de Caracas de su emisión, en un período de
-- IVA sin declarar, antes del cierre de su caja, y su acta lleva `originals_in_hand = true`. Es la segunda capa
-- de la regla que obedece annulInvoice: una anulación hecha por otra vía da fila. Sin su corte, la función lanza.
select 'annulment_paper_gaps (facturas anuladas fuera de la regla del papel)', count(*)::text
  from platform.annulment_paper_gaps(:'cid');
-- Ola 4, tercera ronda de cobros (migraciones 20261004190200 y 190400; ADR-0075 decisión 5): Σ por saldo a favor
-- no retirado con asiento (lo que nació − lo que bajaron sus usos vivos con asiento) = saldo acreedor de las
-- cuentas customer_credit_liability, sin la revaluación al cierre ni la regularización del céntimo; un saldo a
-- favor agotado no carga nada (`exhausted`); y todo saldo a favor vivo nació con asiento o está en la cola
-- (`unborn`: uno retirado que resucitó). Sin lista de exclusiones: un asiento manual sobre la cuenta da fila.
select 'customer_credit_ledger_gap (saldos a favor vivos ≠ pasivo de saldos a favor del mayor)', count(*)::text
  from platform.customer_credit_ledger_gap(:'cid');
-- ADR-0083 §5, tercera ronda (H-03, 20261005110600): la pata «auxiliar ↔ declarado». Por factura de proveedor
-- cuyas notas vigentes son todas posteriores al corte (platform.invariant_cutoffs), lo que el auxiliar dice que
-- está a favor (greatest(-supplier_invoice_balance, 0), en la moneda de la factura) = Σ de lo que sus notas
-- declararon (credit_in_favor_transaction). Un pago posterior, una reversa o un saldo a favor mal calculado dan fila.
select 'supplier_credit_subledger_gaps (saldo a favor con proveedores: auxiliar vs declarado por las notas)', count(*)::text
  from platform.supplier_credit_subledger_gaps(:'cid');

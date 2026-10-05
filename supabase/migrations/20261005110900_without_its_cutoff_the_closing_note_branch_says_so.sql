-- Módulo: compras · contabilidad   Spec: ADR-0083 §7 (sección «Revisión», cuarta ronda) · ADR-0075 §4
-- Reversible: SÍ (una función de lectura y dos comentarios; ver abajo)
-- Homologación: NO (no cambia el libro ni el IVA)
--
-- Familia H-03 (ola 5), cuarta ronda. Va con 20261005110000 … 110800, justo después del
-- `git pull` y en ese orden.
--
-- QUÉ PASABA
--   La tercera rama de `platform.settled_ledger_gaps` (110600: la factura de proveedor `posted`
--   que una nota de crédito dejó en cero) compara la fecha de la nota contra el corte
--   `settled_by_supplier_credit_note` de `platform.invariant_cutoffs`. Sin esa fila la
--   comparación da NULL y la rama CALLA: cero filas con el residuo delante. La 110600 comprueba
--   que la fila existe al aplicarse, pero nada impide borrarla después (la tabla no tiene guarda),
--   y un invariante que se apaga solo y da cero es peor que no tenerlo (CLAUDE.md §2: ausencia de
--   mecanismo no es prohibición; ADR-0023: ausencia de fallo leída como éxito).
--
-- QUÉ HACE
--   1. REDEFINE `platform.settled_ledger_gaps(uuid)` partiendo de su ÚLTIMA definición en orden
--      limpio (20261005110600, entera; comprobado el 2026-10-04 con grep: ninguna posterior la
--      redefine). Las TRES ramas no cambian. Gana una cuarta consulta: si falta la fila de corte
--      `settled_by_supplier_credit_note`, devuelve UNA fila con `side = 'falta_el_corte'` y
--      `document_id` y `residual` en NULL. Quien cuenta filas (el recorrido, los E2E) la ve.
--   2. Deja escrito, en el comentario de cada función, qué hace SIN su fila de corte:
--        · settled_ledger_gaps, rama de la nota: una fila `falta_el_corte` (esta migración);
--        · supplier_credit_subledger_gaps: mira TODAS las facturas (el lado ruidoso: las notas
--          anteriores al corte, que no declaraban, dan fila). No se toca su cuerpo.
--
-- LO QUE NO HACE (a propósito, y queda anotado en R-88): las dos ramas ANTERIORES de
--   `settled_ledger_gaps` (ventas y compras `paid`, corte `settled_ledger_gaps`, de la ola 3)
--   también callan sin su fila, igual que los demás invariantes con corte en datos. Es la misma
--   familia de defecto en funciones que no son de esta entrega; aquí solo se cierra la rama que
--   la familia H-03 añadió.
--
-- REVERSIBILIDAD, CON DATOS VIVOS
--   Función STABLE de lectura: se revierte con el `create or replace` de la 110600 y sus
--   `comment on`. Ningún dato depende de ella. Con la fila de corte presente (el estado normal:
--   la 110600 la inserta y lo comprueba) el resultado es idéntico al de la 110600.
--
-- EXPAND/CONTRACT: la API saliente y la entrante solo cuentan filas; ninguna interpreta `side`.
--
-- DESPLIEGUE: JUSTO DESPUÉS del `git pull`, inmediatamente después de 20261005110800.
-- pgTAP: supabase/tests/139 (secciones a y b).

CREATE OR REPLACE FUNCTION platform.settled_ledger_gaps(p_company uuid)
 RETURNS TABLE(side text, document_id uuid, residual numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  -- ENUNCIADO: todo documento SALDADO —venta `paid` o factura de compra `paid` cuyo último
  -- cobro o pago es posterior al corte, o factura de compra dejada en cero (o por debajo) por
  -- una nota de crédito de su proveedor registrada desde SU corte (platform.invariant_cutoffs)—,
  -- y cuyas piezas tienen todas su asiento, no deja NADA en cuentas por cobrar (o por pagar)
  -- del mayor. Y el corte de la nota EXISTE: sin él, una fila `falta_el_corte`.
  select 'ar'::text, d.id, x.abierto
    from public.documents d
    cross join lateral (select platform.settlement_ledger_open(p_company, 'ar', d.id)
                               as abierto) x
   where d.company_id = p_company and d.status = 'paid'
     and (select max(p.created_at) from public.payments p where p.document_id = d.id)
         >= (select c.since from platform.invariant_cutoffs c
              where c.invariant = 'settled_ledger_gaps')
     and x.abierto is not null and x.abierto <> 0
  union all
  select 'ap'::text, i.id, x.abierto
    from public.supplier_invoices i
    cross join lateral (select platform.settlement_ledger_open(p_company, 'ap', i.id)
                               as abierto) x
   where i.company_id = p_company and i.status = 'paid'
     and (select max(p.created_at) from public.supplier_payments p
           where p.supplier_invoice_id = i.id)
         >= (select c.since from platform.invariant_cutoffs c
              where c.invariant = 'settled_ledger_gaps')
     and x.abierto is not null and x.abierto <> 0
  union all
  -- 20261005110600 (ADR-0083 §7): la factura que una NOTA dejó en cero sigue `posted` (solo el
  -- pago la pasa a `paid`). Una factura `posted` con saldo <= 0 en el auxiliar no la cerró un
  -- pago: la cerró una nota. Su cuenta por pagar tiene que estar en cero igual; el exceso, si
  -- lo hubo, vive en la cuenta de saldos a favor (supplier_credit_ledger_gap).
  select 'ap'::text, i.id, x.abierto
    from public.supplier_invoices i
    cross join lateral (select platform.settlement_ledger_open(p_company, 'ap', i.id)
                               as abierto) x
   where i.company_id = p_company and i.status = 'posted'
     and platform.supplier_invoice_balance(p_company, i.id) <= 0
     and (select max(n.created_at) from public.supplier_credit_notes n
           where n.supplier_invoice_id = i.id and n.status = 'posted')
         >= (select c.since from platform.invariant_cutoffs c
              where c.invariant = 'settled_by_supplier_credit_note')
     and x.abierto is not null and x.abierto <> 0
  union all
  -- 20261005110900: sin la fila de corte, la rama de arriba compara contra NULL y no devuelve
  -- nada. Eso no es «cero residuos»: es no haber mirado. Se dice con una fila.
  select 'falta_el_corte'::text, null::uuid, null::numeric
   where not exists (select 1 from platform.invariant_cutoffs c
                      where c.invariant = 'settled_by_supplier_credit_note')
$function$;

comment on function platform.settled_ledger_gaps(uuid) is
  'INVARIANTE (ADR-0075 §4; ADR-0083 §7; F-15, H-02, H-03): documento saldado —pagado, o dejado en cero por la nota de crédito de su proveedor— ⇒ su cuenta por cobrar o por pagar del mayor en cero. Cero filas. Sin excepciones: el saldo a favor con un proveedor vive en su propia cuenta (supplier_credit_receivable) y lo vigilan platform.supplier_credit_ledger_gap y platform.supplier_credit_subledger_gaps. Cortes en platform.invariant_cutoffs: settled_ledger_gaps (cobros y pagos) y settled_by_supplier_credit_note (notas). SIN la fila settled_by_supplier_credit_note devuelve una fila side = falta_el_corte (20261005110900); sin la fila settled_ledger_gaps, las dos ramas de cobros y pagos callan (pendiente, R-88).';

comment on function platform.supplier_credit_subledger_gaps(uuid) is
  'INVARIANTE (ADR-0083 §5, tercera ronda): por factura de proveedor, el saldo a favor que dice el auxiliar (greatest(-supplier_invoice_balance, 0), en la moneda de la factura) = Σ de lo que sus notas de crédito vigentes declararon (credit_in_favor_transaction). Cero filas. Corte en platform.invariant_cutoffs: solo las facturas cuyas notas vigentes son todas posteriores. Un pago posterior, una reversa o un saldo a favor mal calculado dan fila. SIN su fila de corte mira TODAS las facturas (el lado ruidoso: las notas anteriores, que no declaraban, dan fila); fijado en pgTAP 139.';

-- Módulo: compras · contabilidad   Spec: ADR-0083 §5 y §7 (tercera ronda) · ADR-0075 §4
-- Reversible: SÍ, con una salvedad (ver abajo)   Homologación: NO (no cambia el libro ni el IVA)
--
-- Familia H-03 (ola 5), tercera ronda. Va con 20261005110000 … 110500, justo después del
-- `git pull` y en ese orden.
--
-- ANTES DE APLICARLA EN UNA BASE CON DATOS (informativa: no la bloquea, pero dice qué va a
-- enseñar el invariante nuevo el primer día):
--   -- facturas de proveedor con saldo NEGATIVO en el auxiliar sin ninguna nota que lo explique
--   select count(*) from public.supplier_invoices i
--    where i.status in ('posted', 'paid')
--      and platform.supplier_invoice_balance(i.company_id, i.id) < 0
--      and not exists (select 1 from public.supplier_credit_notes n
--                       where n.supplier_invoice_id = i.id and n.status = 'posted');
-- Base local con el escenario del recorrido, 2026-10-04: 0 (18 facturas con saldo negativo, las
-- 18 con nota). Producción: 0 notas; las facturas con saldo negativo sin nota NO se contaron.
--
-- QUÉ PASABA
--   1. La nota de crédito que deja el saldo de una factura en CERO reconoce el diferencial
--      (110300), pero la factura sigue `posted` —solo el pago la pasa a `paid`— y
--      `settled_ledger_gaps` solo mira `paid` con un pago posterior a su corte: nadie miraba la
--      cuenta por pagar de esa factura.
--   2. En `supplier_credit_ledger_gap` los dos lados nacen del MISMO número (el caso de uso
--      escribe `aFavor` en la columna y en el asiento): detecta el asiento ausente, la plantilla
--      sin su línea y los asientos manuales, pero no un saldo a favor MAL CALCULADO ni un
--      auxiliar que se mueva después.
--
-- QUÉ HACE
--   1. REDEFINE `platform.settled_ledger_gaps(uuid)` partiendo de su última definición en orden
--      limpio (20261005110200, cuyo cuerpo es el de 20261003170000). Las dos ramas de siempre no
--      cambian; gana una TERCERA: la factura de proveedor `posted` cuyo saldo del auxiliar quedó
--      en cero o por debajo y cuya última nota de crédito vigente es posterior al corte
--      `settled_by_supplier_credit_note`. Es ampliar lo que se mira, no un perdón.
--      ENUNCIADO: «Documento saldado —pagado, o dejado en cero por la nota de crédito de su
--      proveedor— ⇒ su cuenta por cobrar o por pagar del mayor en cero».
--   2. Columna `supplier_credit_notes.credit_in_favor_transaction`: lo que la nota abonó por
--      encima de lo que se debía, en la moneda de la FACTURA. La escribe el caso de uso junto a
--      `credit_in_favor_functional`; después de asentada la protege la guarda de siempre
--      (`assert_purchase_doc_immutable`, LAD06: no está entre las columnas que deja cambiar).
--   3. Invariante NUEVO `platform.supplier_credit_subledger_gaps(uuid)`, la pata
--      «auxiliar ↔ declarado»: por factura de proveedor, lo que el auxiliar dice que está a favor
--      (`greatest(-supplier_invoice_balance, 0)`, calculado de total, retención, pagos y notas)
--      = Σ de lo que sus notas vigentes declararon en esa moneda. El lado del auxiliar NO lee
--      la columna: un saldo a favor mal calculado, un pago posterior o una reversa que muevan el
--      auxiliar dan fila.
--   4. Los dos cortes, en DATOS (`platform.invariant_cutoffs`), nunca un literal en el cuerpo.
--
-- REVERSIBILIDAD, CON DATOS VIVOS
--   · Las dos funciones se restauran con `create or replace` de la 110200 / `drop function`: son
--     de lectura.
--   · La columna es aditiva y se suelta sin pérdida para el libro o el mayor (nada más la lee);
--     soltarla pierde lo declarado por nota en la moneda de la factura, que no se puede
--     recalcular después (depende del saldo que había al registrar cada nota).
--   · EXPAND/CONTRACT: la API anterior no escribe la columna (queda 0). Una nota con saldo a
--     favor registrada entre esta migración y el arranque de la API nueva da fila en el
--     invariante nuevo, que es lo que debe decir: esa nota no declaró. Ventana: los minutos del
--     despliegue.
--
-- DESPLIEGUE: JUSTO DESPUÉS del `git pull`, inmediatamente después de 20261005110500.

-- ── 1. Lo declarado, en la moneda de la factura ─────────────────────────────────────────────
alter table public.supplier_credit_notes
  add column credit_in_favor_transaction numeric(24,8) not null default 0;
alter table public.supplier_credit_notes
  add constraint supplier_credit_notes_credit_in_favor_transaction_chk
    check (credit_in_favor_transaction >= 0 and credit_in_favor_transaction <= total_amount);
comment on column public.supplier_credit_notes.credit_in_favor_transaction is
  'ADR-0083 §5: lo que la nota abonó por encima de lo que se debía de su factura, en la moneda de la FACTURA (la de la nota). Lo escribe registerSupplierCreditNote al asentar, desde el saldo del auxiliar; inmutable después (LAD06). Lo compara platform.supplier_credit_subledger_gaps contra el auxiliar recalculado.';

-- ── 2. Los cortes, en datos ─────────────────────────────────────────────────────────────────
insert into platform.invariant_cutoffs (invariant, reason)
select v.invariant, v.reason
  from (values
    ('settled_by_supplier_credit_note',
     'Antes de 20261005110300 la nota de crédito de proveedor que cerraba una factura no reconocía el diferencial cambiario; esas facturas conservan su residuo en cuentas por pagar hasta que el contador lo regularice. settled_ledger_gaps mira las cerradas por una nota registrada desde este corte.'),
    ('supplier_credit_subledger_gaps',
     'Antes de 20261005110600 la nota de crédito de proveedor no guardaba su saldo a favor en la moneda de la factura (credit_in_favor_transaction). Una nota asentada no se reescribe: el invariante mira las facturas cuyas notas vigentes son todas posteriores a este corte.')
  ) as v(invariant, reason)
 where not exists (select 1 from platform.invariant_cutoffs c where c.invariant = v.invariant);

-- ── 3. settled_ledger_gaps mira también la factura que cerró una nota ───────────────────────
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
  -- del mayor.
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
$function$;

comment on function platform.settled_ledger_gaps(uuid) is
  'INVARIANTE (ADR-0075 §4; ADR-0083 §7; F-15, H-02, H-03): documento saldado —pagado, o dejado en cero por la nota de crédito de su proveedor— ⇒ su cuenta por cobrar o por pagar del mayor en cero. Cero filas. Sin excepciones: el saldo a favor con un proveedor vive en su propia cuenta (supplier_credit_receivable) y lo vigilan platform.supplier_credit_ledger_gap y platform.supplier_credit_subledger_gaps. Cortes en platform.invariant_cutoffs: settled_ledger_gaps (cobros y pagos) y settled_by_supplier_credit_note (notas).';

-- ── 4. La pata «auxiliar ↔ declarado» del saldo a favor con proveedores ─────────────────────
create or replace function platform.supplier_credit_subledger_gaps(p_company uuid)
returns table(supplier_invoice_id uuid, auxiliar numeric, declarado numeric, diferencia numeric)
language sql
stable
set search_path = ''
as $function$
  -- ENUNCIADO: por cada factura de proveedor asentada cuyas notas de crédito vigentes son todas
  -- posteriores al corte (platform.invariant_cutoffs; una factura sin notas también entra), lo
  -- que el AUXILIAR dice que está a favor con el proveedor —greatest(−saldo, 0), en la moneda de
  -- la factura, recalculado de su total, su retención, sus pagos y sus notas— es igual a la suma
  -- de lo que esas notas DECLARARON al asentarse (credit_in_favor_transaction). Cero filas.
  -- El lado del auxiliar no lee la columna declarada: los dos pueden discrepar.
  select i.id, x.auxiliar, x.declarado, x.auxiliar - x.declarado
    from public.supplier_invoices i
    cross join lateral (
      select greatest(-coalesce(platform.supplier_invoice_balance(p_company, i.id), 0), 0)
               as auxiliar,
             coalesce((select sum(n.credit_in_favor_transaction)
                         from public.supplier_credit_notes n
                        where n.supplier_invoice_id = i.id and n.status = 'posted'), 0)
               as declarado) x
   where i.company_id = p_company and i.status in ('posted', 'paid')
     and not exists (select 1 from public.supplier_credit_notes n
                      where n.supplier_invoice_id = i.id and n.status = 'posted'
                        and n.created_at < (select c.since from platform.invariant_cutoffs c
                                             where c.invariant = 'supplier_credit_subledger_gaps'))
     and x.auxiliar <> x.declarado
$function$;

comment on function platform.supplier_credit_subledger_gaps(uuid) is
  'INVARIANTE (ADR-0083 §5, tercera ronda): por factura de proveedor, el saldo a favor que dice el auxiliar (greatest(-supplier_invoice_balance, 0), en la moneda de la factura) = Σ de lo que sus notas de crédito vigentes declararon (credit_in_favor_transaction). Cero filas. Corte en platform.invariant_cutoffs: solo las facturas cuyas notas vigentes son todas posteriores. Un pago posterior, una reversa o un saldo a favor mal calculado dan fila.';
revoke all on function platform.supplier_credit_subledger_gaps(uuid) from public;
grant execute on function platform.supplier_credit_subledger_gaps(uuid) to authenticated, ladino_api;

-- ── 5. Lo que esta migración garantiza sobre sí misma ───────────────────────────────────────
do $$
begin
  if (select count(*) from platform.invariant_cutoffs c
       where c.invariant in ('settled_by_supplier_credit_note',
                             'supplier_credit_subledger_gaps')) <> 2 then
    raise exception 'LAD82: faltan los cortes de los invariantes de la nota de crédito de proveedor'
      using errcode = 'LAD82';
  end if;
end $$;

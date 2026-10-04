-- =============================================================================
-- Módulo: moneda X «el cobro y el cierre»   ADR: docs/00_GOVERNANCE/adr/ADR-0075 §4
--   (nota de aplicación «el cobro y el cierre», revisiones de moneda A y B de la ola 3)
-- Reversible: SÍ (una función de solo lectura; ver al final)   Homologación: YES
--   (HOMOLOGATION_IMPACT YES por el encargo entero: el cierre de un cobro decide qué va a
--    cuentas por cobrar y qué a diferencial. Esta migración no toca ningún importe fiscal:
--    cambia lo que una función de LECTURA responde.)
--
-- QUÉ HACE — una sola cosa: redefine `platform.settlement_ledger_open`.
--
-- Parte de la definición VIVA en el orden limpio de timestamps: 20261003180000 §8 (líneas
-- 904-967), que a su vez sustituyó a 20261003170100 y esta a 20261003170000 §6. Ninguna migración
-- posterior a 180000 (190000, 190100) la toca. Dos diferencias, y solo dos:
--
--   (1) H3 de la revisión B · el cobro REVERSADO cuyo asiento estaba en la COLA.
--       La reversa de un cobro sin asiento descarta su fila de la cola
--       (packages/domain/src/payment-reversals.ts) y no postea nada. Ese cobro seguía en
--       `piezas`, sin asiento para siempre, y la función respondía NULL para siempre: el
--       invariante `settled_ledger_gaps`, que salta los NULL («el mayor no puede responder»),
--       quedaba INERTE para ese documento aunque todo lo demás tuviera asiento.
--       Ahora un cobro reversado SIN asiento no es una pieza: no canceló nada en el mayor y no
--       tiene nada que cancelar. Un cobro reversado CON asiento sigue siéndolo (su asiento y su
--       contra-asiento se cuentan juntos y netean a cero, como en 180000).
--
--   (2) El importe que se suma es el FUNCIONAL: `functional_debit - functional_credit`.
--       `debit_amount` / `credit_amount` guardan el importe en la moneda de la TRANSACCIÓN de la
--       línea (ADR-0020); hasta hoy las líneas de cuentas por cobrar y por pagar se escribían en
--       moneda funcional e identidad, y las dos columnas coincidían. La familia «moneda B» pone
--       el importe original en divisa también en esas líneas: sumando `debit_amount`, una
--       factura de 11,14 USD «cargaría» 11,14 en vez de 9.515,31. Las dos columnas funcionales
--       son NOT NULL (comprobado en el catálogo; 0 nulos en la base local).
--
-- Lo demás es idéntico a 180000: firma, `stable`, `search_path` vacío, las cinco clases de
-- pieza, el emparejamiento del asiento por columna o por origen, y que cuenta `posted` y
-- `reversed` con sus contra-asientos. `create or replace` conserva los GRANT (authenticated,
-- ladino_api) y el REVOKE de public de 20261003170000.
--
-- LO QUE LAS CABECERAS ANTERIORES DECÍAN Y NO ES CIERTO
--   · 20261003170000, líneas 454-456: «Ninguna migración posterior a esta … redefine
--     `supplier_invoice_balance`, `settlement_ledger_open`, `fiscal_amount_gaps` ni
--     `settled_ledger_gaps`». `settlement_ledger_open` la redefinen 20261003170100,
--     20261003180000 §8 y ESTA. Las otras tres siguen sin redefinir.
--   · 20261003170000 §6 (comentario de la función): «NULL si alguna pieza no tiene asiento
--     todavía». Sigue siendo cierto salvo para el cobro reversado sin asiento, que ya no cuenta.
--
-- AUDITORÍA PROPIA (CLAUDE.md §3: una migración que arregla otra se audita entera)
--   · Quién la llama: `settled_ledger_gaps` (invariante), `registerPayment` y
--     `registerSupplierPayment` (el cierre exacto). Los tres leen el mismo número; ninguno
--     escribe con ella dentro de SQL.
--   · Lado `ap`: no hay reversa de pagos a proveedor; sus piezas no cambian.
--   · Un cobro NO reversado y sin asiento (en cola, pendiente) sigue dando NULL: el mayor no
--     puede responder todavía, y el dominio usa su respaldo calculado.
--   · Coste: un `not exists` más por cobro del documento, sobre `payment_reversals`
--     (único por `payment_id`) y `journal_entries` por `source_id`. No se llama por fila desde
--     ninguna policy.
--   · pgTAP 109: la cifra con asiento, el cobro reversado sin asiento (con su variante rota: la
--     definición de 180000 devuelve NULL en el mismo montaje), y la línea en divisa (la de
--     180000 devuelve el importe en dólares).
-- =============================================================================

create or replace function platform.settlement_ledger_open(
  p_company uuid, p_side text, p_document uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  with piezas as (
    select d.id, 'documento'::text as clase, d.journal_entry_id as entry_id
      from public.documents d
     where p_side = 'ar' and d.company_id = p_company and d.id = p_document
    union all
    select p.id, 'payment_received', p.journal_entry_id
      from public.payments p
     where p_side = 'ar' and p.company_id = p_company and p.document_id = p_document
       -- (1) El cobro reversado que nunca llegó al mayor no es una pieza.
       and not (
         exists (select 1 from public.payment_reversals pr where pr.payment_id = p.id)
         and p.journal_entry_id is null
         and not exists (
           select 1 from public.journal_entries e
            where e.company_id = p_company and e.source_id = p.id
              and e.source_kind = 'payment_received'
              and e.status in ('posted', 'reversed') and e.is_reversal_of is null))
    union all
    select i.id, 'documento', i.journal_entry_id
      from public.supplier_invoices i
     where p_side = 'ap' and i.company_id = p_company and i.id = p_document
    union all
    select p.id, 'payment_made', p.journal_entry_id
      from public.supplier_payments p
     where p_side = 'ap' and p.company_id = p_company and p.supplier_invoice_id = p_document
    union all
    select n.id, 'documento', n.journal_entry_id
      from public.supplier_credit_notes n
     where p_side = 'ap' and n.company_id = p_company and n.supplier_invoice_id = p_document
       and n.status = 'posted'
  ),
  asientos as (
    select z.id as pieza, z.entry_id
      from piezas z
     where z.entry_id is not null
    union
    select z.id, e.id
      from piezas z
      join public.journal_entries e
        on e.company_id = p_company and e.source_id = z.id and e.status in ('posted', 'reversed')
       and e.is_reversal_of is null
       and (z.clase = 'documento' or e.source_kind = z.clase)
  )
  select case
           when p_side not in ('ar', 'ap') then null
           when not exists (select 1 from piezas) then null
           when exists (select 1 from piezas z
                         where not exists (select 1 from asientos a where a.pieza = z.id))
             then null
           else (
             -- (2) En moneda FUNCIONAL: debit_amount/credit_amount van en la de la transacción.
             select coalesce(sum(case when p_side = 'ar'
                                      then l.functional_debit - l.functional_credit
                                      else l.functional_credit - l.functional_debit end), 0)
               from public.journal_lines l
               join public.journal_entries e on e.id = l.entry_id
              where l.company_id = p_company
                and e.status in ('posted', 'reversed')
                and (e.id in (select entry_id from asientos)
                     or e.is_reversal_of in (select entry_id from asientos))
                and l.account_id in (
                      select s.account_id from public.company_account_settings s
                       where s.company_id = p_company
                         and s.purpose = case p_side when 'ar' then 'ar_general'
                                                     else 'ap_general' end))
         end
$$;
comment on function platform.settlement_ledger_open(uuid, text, uuid) is
  'Lo que el MAYOR todavía le carga a un documento en cuentas por cobrar (p_side = ar) o por '
  'pagar (ap), en moneda FUNCIONAL: el asiento del documento más los de sus cobros, pagos y '
  'notas, con los contra-asientos de lo reversado. NULL si alguna pieza viva no tiene asiento '
  'todavía (está en la cola). Un cobro reversado que nunca tuvo asiento no es una pieza. Es la '
  'base del cobro y del pago que cierran (ADR-0075 §4: cero exacto, con tope) y del invariante '
  'settled_ledger_gaps.';

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos)
--   · La función es de solo lectura y no hay columna, tabla ni fila nueva: volver atrás es otra
--     migración con el cuerpo de 20261003180000 §8. No se pierde ningún dato.
--   · Lo que SÍ cambia de comportamiento mientras esté aplicada, y no se «desaplica» solo:
--       - un documento con un cobro reversado-en-cola pasa de NULL a una cifra, y si está
--         `paid` con residuo en el mayor empieza a salir en `settled_ledger_gaps` (es lo que el
--         invariante tenía que decir y callaba). Volver atrás lo vuelve a callar.
--       - los cobros y pagos que CIERREN con esta función aplicada cancelan del mayor lo que
--         ella diga; esos asientos son posteados y no cambian al revertir la función (regla 2).
--   · Con la versión de aplicación saliente (expand/contract): la función conserva firma y
--     tipo; el dominio viejo la lee igual. El punto (2) no cambia ningún resultado mientras las
--     líneas de CxC/CxP sigan en moneda funcional (hoy lo están todas).
-- A la fecha, ninguna migración posterior del árbol redefine `settlement_ledger_open`.
-- =============================================================================

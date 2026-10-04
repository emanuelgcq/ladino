-- =============================================================================
-- Ladino — ANULAR SOLO LO QUE NO SALIÓ, Y EL CAJERO INICIA LA DEVOLUCIÓN
-- Módulo: ventas (anulación, devoluciones) · roles
-- Spec: ADR-0061 (notas de la ola 4) · RESPUESTA_RECORRIDO_2026-09-24 §2.8, G-07 y G-10
-- Reversible: SÍ (ver al pie)   Homologación: YES (cambia cuándo una factura puede anularse)
--
-- G-10 (PA 00071 arts. 22 y 36; regla del dueño del 2026-09-28): una factura se ANULA solo si el
--   documento no salió del establecimiento y la operación no ocurrió: mismo día, antes del cierre
--   de caja, original y copias conservados. Todo lo demás es NOTA DE CRÉDITO. La anulada ya va al
--   libro de ventas con su número, «annulled» e importes en cero (migración 20260928120000, P-34):
--   aquí NO se toca el libro.
--
--   `platform.invoice_annulment_blockers(empresa, documento, instante)` dice POR QUÉ una factura
--   ya no se puede anular. Cero filas = por lo que la base puede saber, el papel no salió. Lo que
--   la base NO puede saber —que la persona tiene el original y las copias en la mano— lo confirma
--   la persona y lo exige el caso de uso (`annulInvoice`), que lo deja en el acta.
--
--   GRANULARIDAD (CLAUDE.md §3, «una fecha contra un punto de reloj»):
--     · «mismo día» compara DOS DÍAS DE CARACAS: caracas_day(issued_at) = caracas_day(p_at);
--     · «antes del cierre de caja» compara DOS INSTANTES: issued_at <= closed_at <= p_at;
--     · «período no declarado» compara el DÍA DE CARACAS de la emisión contra las fechas
--       (date) del período declarado, y el instante de la declaración contra p_at.
--   El instante lo pasa quien llama (el caso de uso pasa now()); la función no lee el reloj.
--
--   «El cierre real de ESA caja» (decidido por criterio, nota del ADR-0061): si el documento tuvo
--   cobros (aunque se reversaran), sus cajas son las cuentas de esos cobros. Si nunca tuvo cobro
--   con cuenta, no hay «su» caja: cuenta cualquier cierre de la empresa posterior a la emisión
--   (de la misma sucursal, cuando el cierre y el documento la llevan). Es el lado ruidoso: un 409
--   que manda a la nota de crédito se ve; una anulación indebida no.
--
--   La regla NO mira si hubo cobros reversados (P-91): la reversa habla del dinero, no del papel.
--   Solo juzga FACTURAS: el recibo no es papel fiscal y conserva la regla de ADR-0061 §1.
--
-- G-07 (RESPUESTA §2.8): el cajero INICIA devoluciones → recibe `sales.return.manage`. El
--   reembolso en efectivo exige `sales.refund`, que sigue siendo solo del Dueño (20261003130000);
--   lo exige `refundCustomerCredit`.
--
-- EXPAND: añade una función y una fila de `role_permissions`. No quita ni renombra nada; la API
--   desplegada no consulta la función nueva.
-- No lee nada creado por una migración posterior a su timestamp.
-- =============================================================================

-- ── 1. Por qué una factura ya no se puede anular ─────────────────────────────
create or replace function platform.invoice_annulment_blockers(
  p_company uuid,
  p_document uuid,
  p_at timestamptz
)
returns table (reason text, priority int)
language sql
stable
set search_path to ''
as $function$
  select b.reason, b.priority
    from public.documents d
   cross join lateral (
     -- Día de Caracas contra día de Caracas: nunca un date contra un instante.
     select 'not_same_day'::text as reason, 1 as priority
      where platform.caracas_day(d.issued_at) <> platform.caracas_day(p_at)
     union all
     -- El día de la emisión cae en un período de IVA ya declarado antes de p_at.
     select 'period_declared', 2
      where exists (
        select 1 from public.iva_period_results r
         where r.company_id = d.company_id
           and platform.caracas_day(d.issued_at) between r.period_from and r.period_to
           and r.created_at <= p_at)
     union all
     -- Instante contra instante: la caja se cerró DESPUÉS de emitir y antes de p_at.
     select 'cash_closed', 3
      where exists (
        select 1 from public.cash_closings cc
         where cc.company_id = d.company_id
           and cc.closed_at >= d.issued_at
           and cc.closed_at <= p_at
           and (
             cc.account_id in (select p.account_id from public.payments p
                                where p.document_id = d.id and p.account_id is not null)
             or (not exists (select 1 from public.payments p
                              where p.document_id = d.id and p.account_id is not null)
                 and (cc.branch_id is null or d.branch_id is null
                      or cc.branch_id = d.branch_id))))
   ) b
   where d.id = p_document
     and d.company_id = p_company
     and d.kind = 'invoice'
     and d.issued_at is not null
   order by b.priority
$function$;

comment on function platform.invoice_annulment_blockers(uuid, uuid, timestamptz) is
  'G-10 (PA 00071 arts. 22 y 36): por qué una FACTURA ya no se puede anular y se corrige con nota '
  'de crédito. not_same_day (día de Caracas de la emisión <> día de Caracas de p_at), '
  'period_declared (el día de la emisión cae en un período de IVA declarado antes de p_at), '
  'cash_closed (un cierre de su caja —o, sin cobros con cuenta, de la empresa— entre la emisión y '
  'p_at). Cero filas = el papel pudo no haber salido; que el original y las copias están en mano '
  'lo confirma la persona en annulInvoice. No mira cobros reversados (P-91). SECURITY INVOKER: '
  'lee bajo la RLS de quien llama.';

revoke execute on function platform.invoice_annulment_blockers(uuid, uuid, timestamptz) from public;
grant execute on function platform.invoice_annulment_blockers(uuid, uuid, timestamptz)
  to ladino_api, authenticated;

-- ── 2. El cajero inicia devoluciones (G-07) ──────────────────────────────────
do $$
begin
  if not exists (select 1 from public.permissions where key = 'sales.return.manage') then
    raise exception 'LAD37: falta el permiso sales.return.manage en el catálogo';
  end if;
  if not exists (select 1 from public.permissions where key = 'sales.refund') then
    raise exception 'LAD37: falta el permiso sales.refund en el catálogo (migración 20261003130000)';
  end if;
end $$;

insert into public.role_permissions (role_id, permission_key, tenant_id)
select r.id, 'sales.return.manage', null
  from public.roles r
 where r.key = 'cashier' and r.tenant_id is null
on conflict (role_id, permission_key) do nothing;

-- REVERSIBILIDAD (honesta, con datos vivos):
--   · La función se revierte con `drop function platform.invoice_annulment_blockers(uuid, uuid,
--     timestamptz)` DESPUÉS de desplegar una API que no la llame (la API de esta ola la llama en
--     cada anulación y en cada detalle de documento: sin ella, ambos fallan). No guarda datos.
--   · El permiso del cajero se revierte borrando su fila de `role_permissions`. Las devoluciones
--     que los cajeros hayan confirmado mientras tanto NO se deshacen: sus notas de crédito son
--     documentos fiscales emitidos (regla 1) y sus saldos a favor siguen vivos. Quitar el permiso
--     solo impide las siguientes.
--   · Las facturas que la regla nueva mandó a nota de crédito no «vuelven» a ser anulables por
--     revertir: la nota ya está en el libro.

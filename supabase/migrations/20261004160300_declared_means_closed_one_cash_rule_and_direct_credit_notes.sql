-- =============================================================================
-- Ladino — «DECLARADO» ES LO QUE DICE LA CASA, «SU CAJA» ES UNA SOLA REGLA, Y LA NOTA DE CRÉDITO
--          DIRECTA TIENE SU PERMISO
-- Módulo: ventas (anulación, devoluciones) · roles
-- Spec: ADR-0061 (nota de la ola 4) · ADR-0068 §8 · RESPUESTA_RECORRIDO_2026-09-24 §2.8, G-07, G-10
-- Reversible: SÍ (ver al pie)
-- Homologación: YES (cambia cuándo una factura puede anularse y quién emite una nota de crédito)
--
-- Corrige 20261004160000 / 160100 / 160200, de esta misma ola, tras su revisión en contexto limpio.
--
-- 1. «PERÍODO DECLARADO» (decidido por criterio; alternativa descartada: que una vista previa
--    bloquee y cambiar el mensaje). La 160100 daba por declarado el período con CUALQUIER fila de
--    `iva_period_results` que cubriera el día de la emisión. Una vista previa del mes en curso,
--    generada por la mañana, dejaba sin anular todas las facturas de ese día con un mensaje falso
--    («el período ya se declaró»). La definición de la casa es la de 20261002120400 (B-1): declara
--    solo una generación hecha DESPUÉS de cerrar su período,
--        r.period_to < platform.caracas_day(r.created_at)
--    (día contra día). Es la que ya usan `recompute_iva_period`, inventario y la reversa de cobros.
--    CONSECUENCIA, dicha: con esa condición `period_declared` no puede darse sin `not_same_day`
--    (día de emisión <= period_to < día de la generación <= día de p_at). Queda como red de
--    seguridad y como segunda razón para el invariante, no como bloqueo propio.
--
-- 2. «SU CAJA», UNA SOLA REGLA (decidido por criterio; alternativa descartada: mirar solo las
--    cuentas de los cobros del documento). La 160100 miraba, con cobros, los cierres de ESAS
--    cuentas —una factura cuyo único cobro fue por banco y se reversó no veía el cierre de la caja
--    física— y, sin cobros, cualquier cierre de la empresa. Ahora bloquea CUALQUIER cierre de una
--    CAJA de la empresa (`company_accounts.kind = 'cash'`; el cierre de un banco o de una billetera
--    no es un cierre de caja), de la misma sucursal cuando documento y cierre la llevan, con
--    `closed_at` entre la emisión y p_at. Es más ancha en un negocio con dos cajas: el lado
--    ruidoso (un 409 que manda a la nota de crédito se ve; una anulación indebida no).
--
-- 3. Las dos funciones dejan de ser de `authenticated`. Para ese rol la cláusula del período calla
--    (`iva_period_results` no tiene policy de SELECT para él): fallaba ABIERTA. PostgREST solo
--    expone `public`; la API entra como `ladino_api`, que conserva el EXECUTE.
--
-- 4. EL CAJERO INICIA DEVOLUCIONES, NO EMITE NOTAS DE CRÉDITO DIRECTAS (decidido por criterio;
--    alternativa descartada: dejarle `sales.return.manage` entero). `sales.return.manage` abría
--    también `createDirectCreditNote`: sin mercancía de vuelta, hasta el 100 % de cualquier
--    factura, con saldo a favor que después se aplica como cobro. Permiso nuevo
--    `sales.credit_note.direct`, que reciben TODOS los roles que hoy tienen `sales.return.manage`
--    —de sistema y propios de un dueño: nadie pierde lo que podía hacer— MENOS el cajero de
--    sistema, que lo recibió en 20261004160000 solo para iniciar devoluciones.
--
-- Parte de la ÚLTIMA definición de `invoice_annulment_blockers` (20261004160100); ninguna migración
-- posterior la toca. `annulment_paper_gaps` (20261004160200) NO se redefine: no repite la regla, se
-- la pregunta a `invoice_annulment_blockers`; aquí solo cambian su privilegio y su comentario.
-- No lee nada creado después de su timestamp.
-- NO es «expand» respecto de la API desplegada en un punto: quien hoy tiene `sales.return.manage`
-- sigue emitiendo notas directas con la API vieja, y el cajero también hasta que se despliegue la
-- nueva. Aplicar JUSTO DESPUÉS del `git pull`, con las otras tres de la familia.
-- =============================================================================

-- ── 1 y 2. La regla, con «declarado» de la casa y la caja uniforme ───────────
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
  select x.reason, x.priority from (
    -- Falla cerrada: lo que no se ve no se puede anular.
    select 'not_found'::text as reason, 0 as priority
     where not exists (select 1 from public.documents d
                        where d.id = p_document and d.company_id = p_company)
    union all
    select b.reason, b.priority
      from public.documents d
     cross join lateral (
       -- Día de Caracas contra día de Caracas: nunca un date contra un instante.
       select 'not_same_day'::text as reason, 1 as priority
        where platform.caracas_day(d.issued_at) <> platform.caracas_day(p_at)
       union all
       -- El día de la emisión cae en un período de IVA DECLARADO antes de p_at. Declara solo una
       -- generación hecha después de cerrar su período (B-1, 20261002120400): una vista previa
       -- del período en curso no. Día contra día (caracas_day de la generación contra period_to).
       select 'period_declared', 2
        where exists (
          select 1 from public.iva_period_results r
           where r.company_id = d.company_id
             and platform.caracas_day(d.issued_at) between r.period_from and r.period_to
             and r.period_to < platform.caracas_day(r.created_at)
             and r.created_at <= p_at)
       union all
       -- Instante contra instante: una CAJA de la empresa se cerró DESPUÉS de emitir y antes de
       -- p_at. Cualquier caja (kind = 'cash'), tenga o no cobros el documento; de la misma
       -- sucursal cuando el cierre y el documento la llevan.
       select 'cash_closed', 3
        where exists (
          select 1 from public.cash_closings cc
            join public.company_accounts ca on ca.id = cc.account_id
           where cc.company_id = d.company_id
             and ca.kind = 'cash'
             and cc.closed_at >= d.issued_at
             and cc.closed_at <= p_at
             and (cc.branch_id is null or d.branch_id is null or cc.branch_id = d.branch_id))
     ) b
     where d.id = p_document
       and d.company_id = p_company
       and d.kind = 'invoice'
       and d.issued_at is not null
  ) x
  order by x.priority
$function$;

comment on function platform.invoice_annulment_blockers(uuid, uuid, timestamptz) is
  'G-10 (PA 00071 arts. 22 y 36): por qué una FACTURA ya no se puede anular y se corrige con nota '
  'de crédito. not_found (quien llama no ve ese documento en esa empresa: falla cerrada), '
  'not_same_day (día de Caracas de la emisión <> día de Caracas de p_at), period_declared (el día '
  'de la emisión cae en un período de IVA declarado antes de p_at; declara solo una generación '
  'hecha después de cerrar su período, B-1: period_to < caracas_day(created_at) — por eso nunca se '
  'da sin not_same_day: es red de seguridad), cash_closed (un cierre de CUALQUIER caja de la '
  'empresa —company_accounts.kind = cash; de la misma sucursal si cierre y documento la llevan— '
  'entre la emisión y p_at; 20261004160300). Cero filas = documento visible sin impedimento de '
  'papel (o que no es factura emitida: la función solo juzga facturas). Que el original y las '
  'copias están en mano lo confirma la persona en annulInvoice. No mira cobros reversados (P-91). '
  'SECURITY INVOKER: lee bajo la RLS de quien llama; solo la ejecuta ladino_api (para '
  'authenticated la cláusula del período callaría: no ve iva_period_results).';

comment on function platform.annulment_paper_gaps(uuid) is
  'INVARIANTE (G-10; PA 00071 arts. 22 y 36; ADR-0061, nota de la ola 4): toda FACTURA anulada '
  'desde el corte (platform.invariant_cutoffs, contra annulled_at) se anuló el mismo día de Caracas '
  'de su emisión (not_same_day), en un período de IVA sin declarar (period_declared: solo aparece '
  'junto a not_same_day, B-1), antes del cierre de cualquier caja de la empresa (cash_closed) —las '
  'tres, preguntadas a platform.invoice_annulment_blockers con annulled_at— y su acta '
  'fiscal.invoice.annulled lleva originals_in_hand = true (originals_not_confirmed). Cero filas. '
  'Sin la fila del corte LANZA (LAD37). Es la segunda capa de la regla que obedece annulInvoice: '
  'no hay trigger; quitar este invariante deja la regla sin quien la mire. SECURITY INVOKER: lee '
  'bajo la RLS de quien llama; solo la ejecuta ladino_api (20261004160300).';

-- ── 3. Ninguna de las dos es de `authenticated` ──────────────────────────────
revoke execute on function platform.invoice_annulment_blockers(uuid, uuid, timestamptz)
  from public, authenticated;
revoke execute on function platform.annulment_paper_gaps(uuid) from public, authenticated;
grant execute on function platform.invoice_annulment_blockers(uuid, uuid, timestamptz) to ladino_api;
grant execute on function platform.annulment_paper_gaps(uuid) to ladino_api;

-- ── 4. La nota de crédito directa tiene su permiso ───────────────────────────
do $$
begin
  if not exists (select 1 from public.permissions where key = 'sales.return.manage') then
    raise exception 'LAD37: falta el permiso sales.return.manage en el catálogo';
  end if;
  if not exists (select 1 from public.roles where key = 'cashier' and tenant_id is null) then
    raise exception 'LAD37: falta el rol de sistema cashier';
  end if;
end $$;

insert into public.permissions (key, description, is_scoped) values
  ('sales.credit_note.direct',
   'Emitir una nota de crédito directa contra una factura, sin devolución de mercancía', false)
on conflict (key) do nothing;

-- Todo rol que tiene `sales.return.manage` —de sistema o propio de un dueño— menos el cajero de
-- sistema. La fila nueva lleva el mismo tenant_id que la del permiso del que se desprende.
insert into public.role_permissions (role_id, permission_key, tenant_id)
select rp.role_id, 'sales.credit_note.direct', rp.tenant_id
  from public.role_permissions rp
  join public.roles r on r.id = rp.role_id
 where rp.permission_key = 'sales.return.manage'
   and not (r.key = 'cashier' and r.tenant_id is null)
on conflict (role_id, permission_key) do nothing;

do $$
begin
  if exists (select 1 from public.role_permissions rp
               join public.roles r on r.id = rp.role_id and r.tenant_id is null
              where r.key = 'cashier' and rp.permission_key = 'sales.credit_note.direct') then
    raise exception 'LAD37: el cajero de sistema no debe tener sales.credit_note.direct';
  end if;
  if (select count(*) from public.role_permissions rp
        join public.roles r on r.id = rp.role_id and r.tenant_id is null
       where r.key in ('owner', 'back_office')
         and rp.permission_key = 'sales.credit_note.direct') <> 2 then
    raise exception 'LAD37: el Dueño y el administrativo deben conservar la nota de crédito directa';
  end if;
end $$;

-- REVERSIBILIDAD (honesta, con datos vivos):
--   · La regla se revierte con `create or replace` al texto de 20261004160100 y devolviendo el
--     EXECUTE a `authenticated`. No guarda datos. Las facturas que la regla nueva dejó anular
--     entre medias (con una vista previa del período en curso; con el cierre de otra caja no, que
--     ahora es más estricta) quedan anuladas: un documento fiscal no se edita (regla 1), y con el
--     texto viejo `annulment_paper_gaps` las señalaría como `period_declared`.
--   · El permiso se revierte borrando sus filas de `role_permissions` y su fila de `permissions`,
--     DESPUÉS de desplegar una API que no lo exija (la de esta ola lo exige en cada nota de
--     crédito directa: sin la fila del catálogo, nadie la emite). Las notas de crédito emitidas
--     no se deshacen: son documentos fiscales con su asiento y su saldo a favor.
--   · Los roles propios que recibieron el permiso por tener `sales.return.manage` no se
--     distinguen después de los que lo recibieron a mano: revertir «solo los de la migración»
--     exige guardar antes la lista (role_id) de los que lo reciben aquí.

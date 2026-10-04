-- =============================================================================
-- Ladino — EL PAPEL DE LA ANULACIÓN TIENE QUIEN LO MIRE, Y EL ADMINISTRATIVO REEMBOLSA
-- Módulo: ventas (anulación, devoluciones) · roles
-- Spec: ADR-0061 (nota de la ola 4) · ADR-0068 §8 · RESPUESTA_RECORRIDO_2026-09-24 §2.8, G-10, G-07
-- Reversible: SÍ (ver al pie)   Homologación: NO (no cambia qué se emite ni qué entra al libro:
--   añade un observador y un permiso a un rol)
--
-- 1. INVARIANTE `platform.annulment_paper_gaps(empresa)` (CLAUDE.md §2, «ausencia de mecanismo no
--    es prohibición», y §3, «¿qué invariante cruza este módulo y quién lo mira?»). La regla del
--    papel (G-10; PA 00071 arts. 22 y 36) hoy solo la obedece `annulInvoice`. Un `UPDATE` que
--    pase una factura a `annulled` por otra vía no encuentra trigger —decenas de fixtures anulan
--    por SQL facturas fechadas en el pasado, y un trigger los rompería—, así que la regla se MIRA:
--
--    ENUNCIADO: toda FACTURA anulada desde el corte (`platform.invariant_cutoffs`, contra
--    `annulled_at`: instante contra instante) se anuló
--      (a) el mismo día de Caracas de su emisión                     → `not_same_day`
--      (b) en un período de IVA sin declarar a esa hora              → `period_declared`
--      (c) antes del cierre de su caja                               → `cash_closed`
--      (d) y su acta `fiscal.invoice.annulled` lleva `originals_in_hand = true`
--                                                                    → `originals_not_confirmed`
--    Cero filas. El corte va en el enunciado, no en una lista de perdones: las anuladas antes de
--    esta migración se anularon con la regla anterior (ADR-0061 §1) y un documento fiscal no se
--    edita (regla 1). Sin la fila del corte la función LANZA: un invariante que calla es peor que
--    no tenerlo.
--
--    (a), (b) y (c) NO se reescriben: se le pregunta a `platform.invoice_annulment_blockers` con
--    el instante de la anulación (`annulled_at`). Una sola definición de la regla; el invariante
--    observa a quien la obedece (`annulInvoice`), no a la regla.
--
-- 2. `back_office` recibe `sales.refund` (decidido por criterio del coordinador, RESPUESTA §2.8:
--    el administrativo «anula y aprueba»). Hasta 20261004160000 reembolsaba con
--    `sales.return.manage`; al pasar el reembolso a `sales.refund` se le quitó sin decirlo.
--    El cajero y el encargado NO lo reciben. Alternativa descartada: solo el Dueño.
--
-- Parte de: `invoice_annulment_blockers` como la deja 20261004160100 (no la redefine).
-- No lee nada creado después de su timestamp. EXPAND: una función, una fila de corte, una fila de
-- `role_permissions`. La API desplegada no consulta la función nueva.
-- =============================================================================

-- ── 1. El corte y el invariante ──────────────────────────────────────────────
insert into platform.invariant_cutoffs (invariant, since, reason) values
  ('annulment_paper_gaps', now(),
   'Antes de esta migración una factura se anulaba con la regla de ADR-0061 §1 (emitida y sin cobros), sin ventana de día, caja ni período y sin confirmar el original y las copias (G-10). Un documento fiscal no se edita (regla 1): las anuladas anteriores quedan como se anularon.')
on conflict (invariant) do nothing;

create or replace function platform.annulment_paper_gaps(p_company uuid)
returns table (document_id uuid, problem text)
language plpgsql
stable
set search_path to ''
as $function$
declare
  v_since timestamptz;
begin
  select c.since into v_since
    from platform.invariant_cutoffs c where c.invariant = 'annulment_paper_gaps';
  if v_since is null then
    raise exception 'annulment_paper_gaps: falta su corte en platform.invariant_cutoffs'
      using errcode = 'LAD37';
  end if;

  -- (a), (b), (c): la misma regla que obedece annulInvoice, preguntada a la hora de la anulación.
  return query
    select d.id, b.reason
      from public.documents d
     cross join lateral platform.invoice_annulment_blockers(d.company_id, d.id, d.annulled_at) b
     where d.company_id = p_company
       and d.kind = 'invoice'
       and d.status = 'annulled'
       and d.annulled_at >= v_since;

  -- (d): el acta de la anulación dice que la persona respondió por el original y las copias.
  return query
    select d.id, 'originals_not_confirmed'::text
      from public.documents d
     where d.company_id = p_company
       and d.kind = 'invoice'
       and d.status = 'annulled'
       and d.annulled_at >= v_since
       and not exists (
         select 1 from public.audit_events a
          where a.company_id = d.company_id
            and a.aggregate_id = d.id
            and a.event_type = 'fiscal.invoice.annulled'
            and a.payload ->> 'originals_in_hand' = 'true');
end;
$function$;

comment on function platform.annulment_paper_gaps(uuid) is
  'INVARIANTE (G-10; PA 00071 arts. 22 y 36; ADR-0061, nota de la ola 4): toda FACTURA anulada '
  'desde el corte (platform.invariant_cutoffs, contra annulled_at) se anuló el mismo día de Caracas '
  'de su emisión (not_same_day), en un período de IVA sin declarar (period_declared), antes del '
  'cierre de su caja (cash_closed) —las tres, preguntadas a platform.invoice_annulment_blockers con '
  'annulled_at— y su acta fiscal.invoice.annulled lleva originals_in_hand = true '
  '(originals_not_confirmed). Cero filas. Sin la fila del corte LANZA (LAD37). Es la segunda capa '
  'de la regla que obedece annulInvoice: no hay trigger; quitar este invariante deja la regla sin '
  'quien la mire. SECURITY INVOKER: lee bajo la RLS de quien llama; quien no ve las actas recibe '
  'originals_not_confirmed (el lado ruidoso).';

revoke all on function platform.annulment_paper_gaps(uuid) from public;
grant execute on function platform.annulment_paper_gaps(uuid) to authenticated, ladino_api;

-- ── 2. El administrativo reembolsa (G-07, ADR-0068 §8) ───────────────────────
do $$
begin
  if not exists (select 1 from public.permissions where key = 'sales.refund') then
    raise exception 'LAD37: falta el permiso sales.refund en el catálogo (migración 20261003130000)';
  end if;
  if not exists (select 1 from public.roles where key = 'back_office' and tenant_id is null) then
    raise exception 'LAD37: falta el rol de sistema back_office';
  end if;
end $$;

insert into public.role_permissions (role_id, permission_key, tenant_id)
select r.id, 'sales.refund', null
  from public.roles r
 where r.key = 'back_office' and r.tenant_id is null
on conflict (role_id, permission_key) do nothing;

-- REVERSIBILIDAD (honesta, con datos vivos):
--   · El invariante se revierte con `drop function platform.annulment_paper_gaps(uuid)` y borrando
--     su fila de `platform.invariant_cutoffs`. No guarda datos. Si se vuelve a crear después, el
--     corte nuevo deja SIN MIRAR las anulaciones hechas entre medias: el corte original se pierde.
--   · El permiso del administrativo se revierte borrando su fila de `role_permissions`. Los
--     reembolsos que haya hecho mientras tanto no se deshacen: son salidas de caja con su asiento
--     (`customer_refunds` es append-only).

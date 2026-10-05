-- =============================================================================
-- Ladino — 20261005100300 · LA GUARDA DE LA FACTURA DE RETIRO LEE SOLO SU TABLA
--
-- Módulo: ventas · cobros · devoluciones (RIGOR MÁXIMO)   Spec: ADR-0082
-- Corrige: 20261005100000 §4 (misma entrega, sin desplegar).
-- HOMOLOGATION_IMPACT: NO — no cambia ningún documento, libro ni número; restituye el cobro y la
--   devolución, que la migración corregida rompía.
--
-- EL DEFECTO (grave, y de los que una suite en verde no ve). 20261005100000 puso UNA función de
--   trigger para dos tablas, `payments` y `returns`, y elegía la columna con un CASE:
--       case tg_table_name when 'payments' then new.document_id else new.source_document_id end
--   PL/pgSQL resuelve TODOS los campos de `new` que aparecen en la expresión, se tome la rama que
--   se tome: en `payments` no existe `source_document_id` y en `returns` no existe `document_id`.
--   Resultado: TODO insert en `payments` y TODO insert en `returns` moría con 42703 —cualquier
--   cobro y cualquier devolución de cualquier documento, no solo los de una factura de retiro—.
--   El E2E del retiro no lo vio porque el caso de uso rechaza el cobro antes de llegar a la base.
--   Lo cazó el pgTAP 134 al asertar el SQLSTATE (esperaba LAD67 y recibió 42703): «falla» no
--   habría bastado, porque fallaba, y por el motivo equivocado.
--
-- LA CORRECCIÓN. Una función por tabla; cada una nombra solo columnas de la suya.
--
-- AUDITORÍA PROPIA: el pgTAP 134 ejerce ahora las DOS direcciones —el cobro y la devolución de una
--   factura de retiro mueren con LAD67, y los de una factura normal PASAN la guarda (ni LAD67 ni
--   42703)—, y el E2E de cobros corre sobre el esquema corregido.
--
-- COMPATIBILIDAD: restituye el comportamiento que la API saliente espera. Va JUSTO DESPUÉS del
--   `git pull`, tras 20261005100200. **20261005100000 NO debe aplicarse sin esta**: entre una y
--   otra, ningún cobro ni devolución entra. Las cuatro migraciones de la entrega van juntas, en
--   una sola ventana.
-- REVERSIBILIDAD: reversible (se sueltan los dos triggers). No toca datos.
-- =============================================================================

create or replace function platform.reject_withdrawal_invoice_settlement()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  -- SOLO para `payments`: nombra `document_id`, que es columna de esa tabla.
  if exists (select 1 from public.documents d
              where d.id = new.document_id and d.kind = 'withdrawal_invoice') then
    raise exception
      'Una factura de retiro no se cobra: el adquirente es la propia empresa y no hay cuenta por cobrar (ADR-0082).'
      using errcode = 'LAD67';
  end if;
  return new;
end;
$$;

create function platform.reject_withdrawal_invoice_return()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  -- SOLO para `returns`: nombra `source_document_id`, que es columna de esa tabla.
  if exists (select 1 from public.documents d
              where d.id = new.source_document_id and d.kind = 'withdrawal_invoice') then
    raise exception
      'Una factura de retiro no se devuelve: si se emitió por error, se anula el mismo día con el original y las copias en la mano (ADR-0082).'
      using errcode = 'LAD67';
  end if;
  return new;
end;
$$;
revoke all on function platform.reject_withdrawal_invoice_return() from public, anon, authenticated;

drop trigger returns_05_no_withdrawal_invoice on public.returns;
create trigger returns_05_no_withdrawal_invoice
  before insert on public.returns
  for each row execute function platform.reject_withdrawal_invoice_return();

comment on function platform.reject_withdrawal_invoice_settlement() is
  'ADR-0082: guarda de payments. Nombra solo columnas de payments: una función de trigger compartida entre tablas con columnas distintas rompe todos los INSERT de la otra (20261005100300).';

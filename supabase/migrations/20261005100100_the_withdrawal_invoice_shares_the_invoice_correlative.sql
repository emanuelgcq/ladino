-- =============================================================================
-- Ladino — 20261005100100 · LA FACTURA DE RETIRO COMPARTE EL CORRELATIVO DE LA FACTURA
--
-- Módulo: ventas · fiscal (RIGOR MÁXIMO)   Spec: ADR-0082 · ADR-0037 · ADR-0071
-- Corrige: 20261005100000 (misma entrega, sin desplegar).
-- HOMOLOGATION_IMPACT: YES — numeración de documentos fiscales.
--
-- EL DEFECTO. `platform.claim_document_number` no lleva un contador: calcula el siguiente número
--   como max(document_number) + 1 sobre los documentos DE ESE KIND. La factura de retiro
--   (kind `withdrawal_invoice`) pide su número con 'invoice' —es una factura más de la serie—,
--   pero al guardarse con otro kind no contaba para la siguiente: la segunda factura de retiro
--   recibía otra vez el 1, y una factura de venta posterior, el número de una factura de retiro.
--   Lo cazó el índice único que cruza los dos kinds (`documents_invoice_number_uidx`, 23505) en el
--   primer E2E con dos retiros: sin ese índice habrían salido dos facturas con el mismo número.
--
-- LA CORRECCIÓN. La familia de numeración se dice en la función: 'withdrawal_invoice' numera
--   como 'invoice'. El candado y el máximo usan la familia, así que una factura y una factura de
--   retiro simultáneas de la misma serie se ponen en la misma fila y ven el mismo máximo.
--   Definición VIVA de la que parte: 20260827192216_create_sales.sql (la única). Solo cambia el
--   kind con el que se bloquea y se busca; el resto es idéntico.
--
-- AUDITORÍA PROPIA (una migración que arregla otra se revisa entera):
--   · quien llama con 'invoice' sigue bloqueando la MISMA clave que antes (company|invoice|serie):
--     la API saliente y la entrante se serializan entre sí durante el despliegue;
--   · los demás kinds (credit_note, debit_note, receipt, receipt_return, quote, order) no cambian:
--     su familia es su propio kind;
--   · el índice único por kind (`documents_number_uidx`) y el que cruza los dos kinds siguen
--     siendo la segunda defensa. El segundo es un DETECTOR ACTIVO de este defecto: no se quita.
--
-- COMPATIBILIDAD: la API saliente llama igual y recibe lo mismo mientras no haya facturas de
--   retiro (no las puede emitir). Va JUSTO DESPUÉS del `git pull`, tras 20261005100000.
-- REVERSIBILIDAD: `create or replace` con la definición anterior. Con facturas de retiro emitidas
--   NO se revierte: volvería el número repetido (el índice lo rechazaría con 23505 y no se podría
--   facturar en esa serie).
-- =============================================================================

create or replace function platform.claim_document_number(p_company uuid, p_kind text, p_series text)
 returns bigint
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_next bigint;
  -- ADR-0082: la factura de retiro es una factura más de la serie de facturas.
  v_familia text := case p_kind when 'withdrawal_invoice' then 'invoice' else p_kind end;
begin
  -- El bloqueo es sobre la company+tipo+serie, no sobre una tabla de contadores:
  -- pg_advisory_xact_lock serializa las emisiones de la misma serie sin crear
  -- una fila que mantener. Se libera solo al terminar la transacción.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company::text || '|' || v_familia || '|' || p_series, 0));
  select coalesce(max(d.document_number), 0) + 1 into v_next
    from public.documents d
   where d.company_id = p_company
     and (case d.kind when 'withdrawal_invoice' then 'invoice' else d.kind end) = v_familia
     and d.series = p_series
     and d.document_number is not null;
  return v_next;
end;
$function$;

comment on index public.documents_invoice_number_uidx is
  'ADR-0082: la factura y la factura de retiro comparten correlativo. DETECTOR ACTIVO: cazó que claim_document_number contaba por kind y repetía el número (20261005100100). Quitarlo deja esa clase de defecto sin red.';

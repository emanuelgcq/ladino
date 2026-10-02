-- =============================================================================
-- Retenciones soportadas: quien NO cobra no carga, las porciones con su fuente, y el AAAAMM en la
-- base (revisión de la familia contribuyente especial, B1, B2 y B5; ADR-0072 §5).
-- Módulo: fiscal / ventas   Spec: docs/02_COMPLIANCE/RETENTIONS_SPEC.md
--
--   1. B1: el dueño dio la carga del comprobante a quien COBRA, «cajero o administrativo» (§2.6), y
--      el encargado (store_manager) no cobra (§2.8). La 20260928190000 se lo había concedido: se le
--      quita `ar.retention.register`. Dueño, administrativo (back_office) y cajero la conservan.
--   2. B2: `iva_retention_portions` sigue el patrón completo de `tax_rule_templates`:
--      `source_status` y `legal_source`. Los arts. 4 y 5 de la PA SNAT/2025/000054 se leyeron en
--      una reproducción no oficial (ivecofi): `fuente_secundaria`, VALIDAR-SENIAT. La vigencia
--      (01-08-2025) sí tiene fuente: ADR-0065 y REGULATORY_STATUS §2-bis.
--   3. B5 (decidido por criterio): el prefijo AAAAMM del comprobante es un año y un mes válidos,
--      también en la base. CHECK NOT VALID, con la misma trampa que el de 14 dígitos.
--
-- Reversible: SÍ, con datos vivos. El permiso se devuelve con un INSERT en role_permissions. Las
-- columnas se retiran con drop column. El CHECK se retira con drop constraint.
-- HOMOLOGATION_IMPACT: NO.
-- =============================================================================

-- ── 1. El encargado no cobra ─────────────────────────────────────────────────
delete from public.role_permissions rp
 using public.roles r
 where r.id = rp.role_id and r.tenant_id is null and r.key = 'store_manager'
   and rp.permission_key = 'ar.retention.register';

do $$
begin
  if exists (select 1 from public.role_permissions rp
               join public.roles r on r.id = rp.role_id and r.tenant_id is null
              where r.key = 'store_manager' and rp.permission_key = 'ar.retention.register')
     or (select count(*) from public.role_permissions rp
           join public.roles r on r.id = rp.role_id and r.tenant_id is null
          where rp.permission_key = 'ar.retention.register'
            and r.key in ('owner', 'back_office', 'cashier')) <> 3 then
    raise exception 'LAD37: ar.retention.register no quedó en dueño, administrativo y cajero';
  end if;
end $$;

-- ── 2. Las porciones, con su fuente ──────────────────────────────────────────
alter table public.iva_retention_portions add column source_status text;
alter table public.iva_retention_portions add column legal_source text;
update public.iva_retention_portions
   set source_status = 'fuente_secundaria',
       legal_source = 'PA SNAT/2025/000054, ' || legal_article ||
                      ' — reproducción no oficial (ivecofi, 2026-09-25/28). Vigencia desde el '
                      '01-08-2025: ADR-0065 y REGULATORY_STATUS §2-bis. VALIDAR-SENIAT: cotejar '
                      'con la Gaceta Oficial 43.171.'
 where legal_norm = 'PA SNAT/2025/000054';
alter table public.iva_retention_portions alter column source_status set not null;
alter table public.iva_retention_portions alter column legal_source set not null;
alter table public.iva_retention_portions
  add constraint iva_retention_portions_source_status_chk
  check (source_status in ('verificada', 'fuente_secundaria'));
alter table public.iva_retention_portions
  add constraint iva_retention_portions_legal_source_chk check (length(btrim(legal_source)) > 0);

-- ── 3. El prefijo AAAAMM, en la base ─────────────────────────────────────────
alter table public.supported_retention_receipts
  add constraint srr_receipt_period_prefix_chk
  check (receipt_number ~ '^(19|20)[0-9]{2}(0[1-9]|1[0-2])[0-9]{8}$') not valid;
comment on constraint srr_receipt_period_prefix_chk on public.supported_retention_receipts is
  'El comprobante empieza por AAAAMM: un año y un mes válidos (PA SNAT/2025/000054). NOT VALID: no '
  'se validó sobre las filas existentes al crearlo, PERO se evalúa en TODO INSERT y en TODO UPDATE '
  'de cualquier fila. TRAMPA para la reversa (R-61, ola 3): anular un comprobante viejo con otro '
  'formato fallará con 23514 salvo que su migración lo resuelva.';

-- =============================================================================
-- Ladino — LA EXENTA CITA LA LEY, NO «ACEPTADA POR EL DUEÑO»
-- (ADR-0073; RESPUESTA_RECORRIDO_2026-09-24 B-04, detalle)
--
-- Módulo: motor tributario. Rigor máximo (fiscal, con datos vivos).
-- Spec:   docs/02_COMPLIANCE/IVA_SPEC.md · ADR-0073 §3 · ADR-0038 (la regla se copia en la línea).
-- Reversible: SÍ, con datos vivos — ver al final.
-- HOMOLOGATION_IMPACT: YES — cambia QUÉ regla (y qué cita) resuelve la exenta desde hoy en las
--   empresas que aceptaron su general antes de la migración 20260928150000. La alícuota no cambia
--   (0 %), ni lo emitido.
--
-- Qué pasaba: la aceptación vieja de la general creaba también la exenta con la fuente «Alícuota
-- declarada y ACEPTADA por el dueño…», aunque nadie declaró nada de exentos (B-04). La migración
-- 20260928150000 dejó de crearla así, pero las empresas que ya la tenían la siguen resolviendo: su
-- regla propia vigente tapa la del catálogo.
--
-- Qué cambia: esas exentas se CIERRAN hoy (día de Caracas) —no se reescribe su texto: lo emitido
-- con ellas conserva su regla, su alícuota y su historia (ADR-0038)— y la del catálogo, con la
-- cita de la LIVA arts. 17-19, las sustituye desde hoy (`platform.seed_catalog_tax_rules`).
-- Solo se tocan filas cuyo `legal_source` empieza por el texto exacto que escribía la aceptación
-- vieja (apps/api/src/routes/fiscal-setup.ts, antes de ADR-0073).
-- =============================================================================

-- La que empezó ANTES de hoy se cierra hoy; la que empieza hoy (o después) se retira: no hay
-- vigencia de cero días (tax_rules_period_chk).
update public.tax_rules r
   set effective_to = (now() at time zone 'America/Caracas')::date
 where r.company_id is not null and r.status = 'active'
   and r.jurisdiction = 'VE' and r.tax_code = 'iva' and r.taxpayer_type is null
   and r.product_tax_category = 'exento'
   and r.legal_source like 'Alícuota declarada y ACEPTADA%'
   and r.effective_from < (now() at time zone 'America/Caracas')::date
   and (r.effective_to is null or r.effective_to > (now() at time zone 'America/Caracas')::date);
update public.tax_rules r
   set status = 'inactive'
 where r.company_id is not null and r.status = 'active'
   and r.jurisdiction = 'VE' and r.tax_code = 'iva' and r.taxpayer_type is null
   and r.product_tax_category = 'exento'
   and r.legal_source like 'Alícuota declarada y ACEPTADA%'
   and r.effective_from >= (now() at time zone 'America/Caracas')::date;

-- La del catálogo, desde hoy, para toda empresa con general propia vigente y en rango. Es la
-- misma llamada idempotente del §6 de la migración 20260928150000: solo crea lo que falta.
select platform.seed_catalog_tax_rules(g.company_id, g.rate,
                                       (now() at time zone 'America/Caracas')::date)
  from (select distinct on (r.company_id) r.company_id, r.rate
          from public.tax_rules r
         where r.company_id is not null and r.status = 'active'
           and r.jurisdiction = 'VE' and r.tax_code = 'iva' and r.taxpayer_type is null
           and r.product_tax_category = 'gravado_general' and r.transaction_type = 'sale'
           and r.effective_from <= (now() at time zone 'America/Caracas')::date
           and (r.effective_to is null
                or r.effective_to > (now() at time zone 'America/Caracas')::date)
           and r.rate between 0.08 and 0.165
         order by r.company_id, r.effective_from desc) g;

-- Que ninguna empresa quede con una exenta «aceptada» vigente mañana: si quedara, esta migración
-- no hizo lo que dice.
do $$
begin
  if exists (
    select 1 from public.tax_rules r
     where r.company_id is not null and r.status = 'active'
       and r.product_tax_category = 'exento'
       and r.legal_source like 'Alícuota declarada y ACEPTADA%'
       and (r.effective_to is null
            or r.effective_to > (now() at time zone 'America/Caracas')::date)) then
    raise exception 'B-04: queda una exenta «ACEPTADA por el dueño» vigente después de hoy';
  end if;
end $$;

-- =============================================================================
-- Reversibilidad (con datos vivos): SÍ. Las exentas cerradas se reabren con
-- `effective_to = null` (y `status = 'active'` las retiradas el mismo día), y las del catálogo
-- creadas hoy se retiran con `status = 'inactive'`. Nada se borra; ninguna línea emitida cambia.
-- =============================================================================

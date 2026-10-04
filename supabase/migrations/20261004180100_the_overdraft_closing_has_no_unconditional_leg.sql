-- ════════════════════════════════════════════════════════════════════════════
-- Ladino — EL CIERRE EN SOBREGIRO NO TIENE PATAS INCONDICIONALES (J-02, corrección)
--
-- Módulo: tesorería · contabilidad (RIGOR MÁXIMO: dinero)
-- Spec: la misma de 20261004180000 · pgTAP 031 §6 («NINGUNA incondicional»)
-- HOMOLOGATION_IMPACT: NO.
--
-- QUÉ CORRIGE. La migración 20261004180000 sembró el hecho
-- `cash_closing / treasury.cash_register.overdraft_covered` con dos líneas `always` (la caja y lo
-- del dueño). El invariante que pgTAP 031 guarda sobre el preset del cierre de caja dice que
-- NINGUNA de sus patas es incondicional: toda pata de un cierre depende del signo de su importe.
-- En la rama del sobregiro el total y lo del dueño son siempre positivos (lo contado nunca es
-- negativo), así que `if_positive` produce exactamente el mismo asiento, y el invariante se
-- cumple para toda la familia en vez de pedir una excepción.
--
-- Una migración que arregla otra lleva su propia auditoría: no cambia cuentas, importes ni
-- lados; solo la condición de dos líneas, en el preset y en las plantillas que la migración
-- anterior acaba de crear (las identifica por su acta, `origin = migration_20261004180000`).
-- Una plantilla de ese hecho que una empresa haya creado o versionado por su cuenta no se toca.
--
-- EXPAND: la API desplegada no usa este hecho. Se puede aplicar antes del git pull.
-- Reversible: SÍ (volver a `always` da el mismo asiento); no mueve datos.
-- ════════════════════════════════════════════════════════════════════════════

update public.journal_template_preset_lines l
   set condition_kind = 'if_positive'
  from public.journal_template_preset_entries e
 where e.id = l.entry_id
   and e.preset_code = 've_basico'
   and e.source_kind = 'cash_closing'
   and e.source_event = 'treasury.cash_register.overdraft_covered'
   and l.condition_kind = 'always';

update public.journal_template_lines l
   set condition_kind = 'if_positive'
  from public.journal_templates t
 where t.id = l.template_id
   and t.source_kind = 'cash_closing'
   and t.source_event = 'treasury.cash_register.overdraft_covered'
   and l.condition_kind = 'always'
   and exists (select 1 from public.audit_events a
                where a.company_id = t.company_id
                  and a.event_type = 'accounting.templates_imported'
                  and a.payload ->> 'origin' = 'migration_20261004180000'
                  and a.payload ->> 'template_id' = t.id::text);

do $$
begin
  if exists (
    select 1 from public.journal_template_preset_lines l
      join public.journal_template_preset_entries e on e.id = l.entry_id
     where e.preset_code = 've_basico' and e.source_kind = 'cash_closing'
       and l.condition_kind = 'always') then
    raise exception 'LAD82: el preset del cierre de caja conserva una pata incondicional'
      using errcode = 'LAD82';
  end if;
  if exists (
    select 1 from public.journal_templates t
      join public.journal_template_lines l on l.template_id = t.id
      join public.audit_events a
        on a.company_id = t.company_id
       and a.event_type = 'accounting.templates_imported'
       and a.payload ->> 'origin' = 'migration_20261004180000'
       and a.payload ->> 'template_id' = t.id::text
     where l.condition_kind = 'always') then
    raise exception 'LAD82: queda una plantilla del cierre en sobregiro con una pata incondicional'
      using errcode = 'LAD82';
  end if;
end $$;

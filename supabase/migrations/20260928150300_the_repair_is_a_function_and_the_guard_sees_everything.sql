-- =============================================================================
-- Ladino — LA REPARACIÓN ES UNA FUNCIÓN, LA GUARDA LO VE TODO Y LAS LÍNEAS SE BUSCAN POR ÍNDICE
-- (ADR-0073; re-revisión de la familia «alícuotas»: B2, B3, B6)
--
-- Módulo: motor tributario. Rigor máximo (fiscal, con datos vivos).
-- Spec:   ADR-0073 (nota de aplicación) · migración 20260928150200 (no se edita: está aplicada).
-- Reversible: SÍ, con datos vivos — ver al final.
-- HOMOLOGATION_IMPACT: NO — no cambia qué alícuota resuelve nadie ni lo emitido; endurece la guarda
--   de H2 y la hace comprobable.
--
-- Qué cambia:
--   1. B3: índices sobre `document_lines.tax_rule_id` y `supplier_invoice_lines.tax_rule_id`. La
--      guarda de H2 pregunta por ellos en cada retiro y en cada aceptación.
--   2. B6 (decidido por criterio): `platform.tax_rule_is_referenced` pasa a SECURITY DEFINER con
--      `search_path` fijo. Solo devuelve un booleano. La guarda del trigger
--      `tax_rules_03_referenced_is_not_retired` ya no depende de lo que la RLS deje ver a quien
--      hace el UPDATE: con INVOKER, un rol que no viera las líneas podía retirar una regla en uso.
--      Alternativa descartada: dejarla INVOKER y confiar en que quien actualiza ve todas las líneas.
--   3. B2: la lógica del bloque §3 de 150200 pasa a `platform.repair_retired_referenced_tax_rules()`,
--      probada por pgTAP (081c), y se aplica otra vez aquí, idempotente.
--   4. Postcondición: la migración FALLA si quedan reglas propias activas solapadas con la misma
--      clave y prioridad en una misma fecha, o reglas propias inactivas que alguna línea emitida usa.
-- =============================================================================

-- ── 1. B3 · índices ──────────────────────────────────────────────────────────
create index if not exists document_lines_tax_rule_idx
  on public.document_lines (tax_rule_id) where tax_rule_id is not null;
create index if not exists supplier_invoice_lines_tax_rule_idx
  on public.supplier_invoice_lines (tax_rule_id) where tax_rule_id is not null;

-- ── 2. B6 · la guarda no depende de la RLS ───────────────────────────────────
create or replace function platform.tax_rule_is_referenced(p_rule uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.document_lines l where l.tax_rule_id = p_rule)
      or exists (select 1 from public.supplier_invoice_lines l where l.tax_rule_id = p_rule);
$$;
comment on function platform.tax_rule_is_referenced(uuid) is
  'Verdadero si alguna línea de venta (document_lines) o de compra (supplier_invoice_lines) copió '
  'la regla. SECURITY DEFINER a propósito (B6): la guarda de H2 (trigger '
  'tax_rules_03_referenced_is_not_retired, accept_general_vat) no puede depender de lo que la RLS '
  'deja ver a quien pregunta. Solo devuelve el booleano: no expone ninguna línea. Como INVOKER, '
  'diría «no se usa» a quien no ve las líneas (pgTAP 081c, variante rota).';
revoke execute on function platform.tax_rule_is_referenced(uuid) from public;
grant execute on function platform.tax_rule_is_referenced(uuid) to ladino_api;

-- ── 3. B2 · la reparación, como función ──────────────────────────────────────
create function platform.repair_retired_referenced_tax_rules()
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_r record;
  v_dia date;
  v_n integer := 0;
begin
  -- Por cada regla PROPIA inactiva que alguna línea emitida usa (la exenta que retiró 150100 el
  -- día en que empezaba, o una general reemplazada el mismo día por la aceptación vieja):
  --   · la sustituta que empieza ese mismo día y NADIE usó se corre al día siguiente (o se retira
  --     si ya no le quedaba vigencia que correr);
  --   · la usada vuelve a `active` con vigencia de un día: [su inicio, el día siguiente).
  -- Si la sustituta también tiene líneas, las dos se usaron el mismo día: no hay forma honesta de
  -- elegir; se deja y se avisa, y la postcondición de la migración lo convierte en error.
  for v_r in
    select r.* from public.tax_rules r
     where r.company_id is not null and r.status = 'inactive'
       and platform.tax_rule_is_referenced(r.id)
  loop
    v_dia := v_r.effective_from + 1;
    if exists (
      select 1 from public.tax_rules q
       where q.id <> v_r.id and q.company_id = v_r.company_id and q.status = 'active'
         and q.jurisdiction = v_r.jurisdiction and q.tax_code = v_r.tax_code
         and q.taxpayer_type is not distinct from v_r.taxpayer_type
         and q.product_tax_category is not distinct from v_r.product_tax_category
         and q.transaction_type = v_r.transaction_type
         and q.effective_from <= v_r.effective_from
         and (q.effective_to is null or q.effective_to > v_r.effective_from)
         and platform.tax_rule_is_referenced(q.id)) then
      raise notice 'H2: la regla % y su sustituta tienen líneas del mismo día; se deja para revisión',
        v_r.id;
      continue;
    end if;
    update public.tax_rules q set status = 'inactive'
     where q.id <> v_r.id and q.company_id = v_r.company_id and q.status = 'active'
       and q.jurisdiction = v_r.jurisdiction and q.tax_code = v_r.tax_code
       and q.taxpayer_type is not distinct from v_r.taxpayer_type
       and q.product_tax_category is not distinct from v_r.product_tax_category
       and q.transaction_type = v_r.transaction_type
       and q.effective_from = v_r.effective_from
       and q.effective_to is not null and q.effective_to <= v_dia;
    update public.tax_rules q set effective_from = v_dia
     where q.id <> v_r.id and q.company_id = v_r.company_id and q.status = 'active'
       and q.jurisdiction = v_r.jurisdiction and q.tax_code = v_r.tax_code
       and q.taxpayer_type is not distinct from v_r.taxpayer_type
       and q.product_tax_category is not distinct from v_r.product_tax_category
       and q.transaction_type = v_r.transaction_type
       and q.effective_from = v_r.effective_from;
    update public.tax_rules set status = 'active', effective_to = v_dia where id = v_r.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
comment on function platform.repair_retired_referenced_tax_rules() is
  'B2 (ADR-0073, H2): reactiva, con vigencia de un día, toda regla propia inactiva que alguna línea '
  'emitida usa, y corre al día siguiente su sustituta sin líneas. Idempotente: devuelve cuántas '
  'reparó (0 la segunda vez). Solo para migraciones y pgTAP (081c): no se concede a ningún rol.';
revoke execute on function platform.repair_retired_referenced_tax_rules() from public;

select platform.repair_retired_referenced_tax_rules();

-- ── 4. Postcondición ─────────────────────────────────────────────────────────
do $$
begin
  if exists (
    select 1
      from public.tax_rules a
      join public.tax_rules b
        on a.id < b.id and a.company_id = b.company_id
       and a.status = 'active' and b.status = 'active'
       and a.jurisdiction = b.jurisdiction and a.tax_code = b.tax_code
       and a.taxpayer_type is not distinct from b.taxpayer_type
       and a.product_tax_category is not distinct from b.product_tax_category
       and a.transaction_type = b.transaction_type and a.priority = b.priority
       and daterange(a.effective_from, a.effective_to) && daterange(b.effective_from, b.effective_to)
     where a.company_id is not null) then
    raise exception 'ADR-0073: quedan reglas propias activas solapadas con la misma clave y prioridad en una misma fecha (catálogo ambiguo)';
  end if;
  if exists (
    select 1 from public.tax_rules r
     where r.company_id is not null and r.status = 'inactive'
       and platform.tax_rule_is_referenced(r.id)) then
    raise exception 'ADR-0073 H2: quedan reglas propias inactivas que alguna línea emitida usa';
  end if;
end $$;

-- =============================================================================
-- Reversibilidad (con datos vivos): SÍ. Los índices se retiran con drop. La guarda vuelve a
-- INVOKER con `alter function … security invoker` (no se recomienda: ver B6). La función de
-- reparación se retira con drop; lo que reparó son reglas reactivadas con un día de vigencia y
-- sustitutas corridas un día, y deshacerlo es volver a retirar reglas en uso, que es lo que H2
-- prohíbe. Nada se borra; ninguna línea emitida cambia.
-- =============================================================================

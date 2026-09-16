-- =============================================================================
-- Ladino — migración 64 · LAS LISTAS «DETAL» Y «MAYOR» VAN EN USD (regla del dueño)
--
-- «Las listas predeterminadas deben aparecer en USD y dual. Pero principalmente
-- siempre USD.» (dueño, 2026-09-16)
--
-- Desde el Bloque 0 (commit a753d7c) toda empresa nueva nace con «detal» y
-- «mayor» en USD y «detal» como predeterminada. Las que nacieron ANTES las
-- tienen en la moneda funcional (VES). La migración 55 solo reparó a las
-- empresas SIN predeterminada; una empresa cuya predeterminada ya era «detal»
-- VES quedó así, y su pantalla de precios pide el importe en bolívares.
--
-- Qué hace `platform.anchor_seed_price_lists_in_usd()`:
--   pasa a USD las listas «detal» y «mayor» que estén en VES y que NO TENGAN
--   HISTORIA: ningún precio cargado, ningún documento que las haya usado (ni en
--   la cabecera ni en un renglón). Con cada cambio deja su acta. Idempotente.
--
-- Qué NO hace: no toca una lista con precios o con ventas. Convertir precios en
-- bolívares a dólares exige elegir una tasa, y esa decisión es del dueño; esas
-- listas se reportan (consulta en el HANDOFF). Tampoco toca empresas cuya
-- moneda funcional ya es USD, ni listas con otro nombre.
--
-- Por qué basta con cambiar la moneda: una lista sin precios ni documentos no
-- tiene nada que reinterpretar. La moneda es de la LISTA (los ítems no la
-- repiten, migración 20260825150000), así que el primer precio que se cargue
-- ya nace en USD, y la pantalla lo enseña dual (ADR-0046/0047).
--
-- Reversibilidad: total mientras la lista siga vacía — el acta
-- `price_list.currency_anchored` con `origin = 'migration_20260916160000'`
-- nombra cada lista y su moneda anterior. Con precios en USD ya cargados, no se
-- revierte (esos precios son USD). Nada se borra (R8).
-- HOMOLOGATION_IMPACT = NO (no toca emisión, numeración ni libros).
-- =============================================================================

create function platform.anchor_seed_price_lists_in_usd()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l record;
  v_n integer := 0;
begin
  for v_l in
    select l.id, l.tenant_id, l.company_id, l.name, l.currency_code
      from public.price_lists l
      join public.companies c on c.id = l.company_id
     where l.name in ('detal', 'mayor')
       and l.currency_code <> 'USD'
       and c.functional_currency_code <> 'USD'
       and not exists (select 1 from public.price_list_items i where i.price_list_id = l.id)
       and not exists (select 1 from public.documents d where d.price_list_id = l.id)
       and not exists (select 1 from public.document_lines dl
                        where dl.price_list_applied_id = l.id)
     order by l.created_at
     for update of l
  loop
    update public.price_lists set currency_code = 'USD' where id = v_l.id;

    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_l.tenant_id, v_l.company_id, 'price_list', v_l.id, 'price_list.currency_anchored',
            'system', now(), 'db-migration',
            jsonb_build_object(
              'from', v_l.currency_code,
              'to', 'USD',
              'name', v_l.name,
              'origin', 'migration_20260916160000',
              'reason',
              'Regla del dueño (2026-09-16): las listas de la empresa van en USD. La lista estaba vacía y sin documentos.'));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
comment on function platform.anchor_seed_price_lists_in_usd() is
  'Pasa a USD las listas «detal»/«mayor» en VES sin precios ni documentos (regla del dueño, '
  '2026-09-16). Idempotente; devuelve cuántas cambió.';
revoke execute on function platform.anchor_seed_price_lists_in_usd() from public;

select platform.anchor_seed_price_lists_in_usd();

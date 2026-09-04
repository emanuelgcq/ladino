-- =============================================================================
-- LA LISTA PREDETERMINADA DE LA CAJA, COMO DATO (no como heurística de nombre)
--
-- Hasta hoy, la lista que /vender aplica a un cliente sin preferida la elegía
-- una heurística: «la que se llame detal, o la más vieja». Funcionaba de
-- casualidad y no se podía CAMBIAR: la demo quedó vendiendo en bolívares por
-- orden de creación, contra la decisión grabada del proyecto («precios de
-- lista en USD; la factura sale en Bs con la tasa del día»).
--
-- `company_settings.default_price_list_id` lo vuelve un dato del dueño, con
-- FK COMPUESTA (company_id, lista) para que nadie pueda apuntar su caja a la
-- lista de otra empresa. NULL = la heurística de siempre (compatibilidad).
-- =============================================================================

alter table public.company_settings
  add column default_price_list_id uuid;

alter table public.company_settings
  add constraint company_settings_default_price_list_fk
  foreign key (company_id, default_price_list_id)
  references public.price_lists (company_id, id);

comment on column public.company_settings.default_price_list_id is
  'La lista que la caja aplica a un cliente sin preferida (y al Consumidor '
  'final). NULL = heurística por nombre «detal» + antigüedad, como antes. La '
  'FK compuesta impide apuntar a la lista de otra empresa.';

-- ── LAD52 ───────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'company_settings_default_price_list_fk'
  ) then
    raise exception 'LAD52: la FK compuesta de la lista predeterminada no quedó puesta';
  end if;
end $$;

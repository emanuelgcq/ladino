-- =============================================================================
-- Ladino — LA COMPROBACIÓN DE CONTINGENCIA, SOLO DONDE APLICA (ADR-0071, H1 · H11)
-- Módulo: ventas · numeración     Reversible: SÍ (sin datos: triggers y un mensaje)
-- Homologación: NO — no cambia qué se emite; afina cuándo se comprueba y un mensaje.
--
-- La auditoría propia de 20260928160200 encontró dos cosas al correr su pgTAP:
--
--   1. El constraint trigger diferido encolaba un evento por CADA rango insertado,
--      aunque su serie no dijera «contingencia». Un evento pendiente impide un
--      ALTER TABLE en la misma transacción («pending trigger events») y cuesta en
--      cada registro. Un INSERT con serie normal no puede violar la regla (no tiene
--      registro de contingencia todavía: su FK apunta al rango): solo se comprueba
--      cuando el nombre dice «contingencia», o cuando un UPDATE cambia la serie
--      desde o hacia ese nombre. La misma regla, sin la carga.
--   2. Con la serie vacía (H11) el mensaje de claim_fiscal_control decía «serie  (»:
--      ahora dice «sin serie». Definición viva: 20260928160000 §4.
-- =============================================================================

drop trigger fiscal_number_ranges_contingency_membership on public.fiscal_number_ranges;

create constraint trigger fiscal_number_ranges_contingency_membership
  after insert on public.fiscal_number_ranges
  deferrable initially deferred
  for each row
  when (lower(new.series) like 'contingencia%')
  execute function platform.assert_contingency_membership();
create constraint trigger fiscal_number_ranges_contingency_membership_upd
  after update of series on public.fiscal_number_ranges
  deferrable initially deferred
  for each row
  when (lower(new.series) like 'contingencia%' or lower(old.series) like 'contingencia%')
  execute function platform.assert_contingency_membership();
comment on trigger fiscal_number_ranges_contingency_membership on public.fiscal_number_ranges is
  'H1 (ADR-0071): una serie «contingencia…» exige su fila en contingency_ranges al commit.';
comment on trigger fiscal_number_ranges_contingency_membership_upd on public.fiscal_number_ranges is
  'H1 (ADR-0071): cambiar la serie desde o hacia «contingencia…» se comprueba al commit.';

create or replace function platform.claim_fiscal_control(p_company uuid, p_kind text, p_series text)
returns table (control_identifier text, control_number bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_range public.fiscal_number_ranges;
  v_num   bigint;
  v_ident text;
  v_clase text := case p_kind
                    when 'invoice' then 'facturas'
                    when 'credit_note' then 'notas de crédito'
                    when 'debit_note' then 'notas de débito'
                    when 'delivery_note' then 'guías de despacho'
                    else 'documentos fiscales'
                  end;
begin
  select * into v_range
    from public.fiscal_number_ranges r
   where r.company_id = p_company and r.series = p_series
     and r.kind is distinct from 'retention_receipt'
     and r.status = 'active' and r.next_available <= r.range_to
   order by r.printer_identifier, r.range_from
   for update
   limit 1;

  if v_range.id is null then
    select r.printer_identifier into v_ident
      from public.fiscal_number_ranges r
     where r.company_id = p_company and r.series = p_series
       and r.kind is distinct from 'retention_receipt'
     order by r.created_at desc
     limit 1;
    raise exception
      'No quedan números de control para % (identificador %). Carga el talonario nuevo.',
      v_clase, coalesce(v_ident, '00')
      using errcode = 'LAD49',
            hint = 'ADR-0071: emitir fuera del rango autorizado sería emitir un documento inválido';
  end if;

  if not v_range.printer_data_complete and lower(v_range.series) not like 'contingencia%' then
    raise exception
      'Al talonario % (identificador %) le faltan los datos de la imprenta: complétalos en la puesta a punto fiscal antes de volver a emitir.',
      case when v_range.series = '' then 'sin serie' else 'serie ' || v_range.series end,
      v_range.printer_identifier
      using errcode = 'LAD49',
            hint = 'ADR-0071 §1: sin los datos de la imprenta no hay rango';
  end if;

  v_num := v_range.next_available;
  update public.fiscal_number_ranges
     set next_available = v_num + 1,
         status = case when v_num + 1 > range_to then 'exhausted' else status end
   where id = v_range.id;
  return query select v_range.printer_identifier, v_num;
end;
$$;
revoke execute on function platform.claim_fiscal_control(uuid, text, text) from public;
grant execute on function platform.claim_fiscal_control(uuid, text, text) to ladino_api;

do $$
begin
  if (select count(*) from pg_trigger
       where tgname like 'fiscal_number_ranges_contingency_membership%'
         and tgdeferrable and tginitdeferred) <> 2 then
    raise exception 'LAD52: faltan las comprobaciones diferidas de contingencia (H1)';
  end if;
end $$;

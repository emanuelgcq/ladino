-- =============================================================================
-- Ladino — UN CORRELATIVO DE CONTROL POR EMISOR (ADR-0071, enmienda ADR-0037)
-- Módulo: ventas · numeración     Hallazgos: G-01, E-01, B-03, E-17, G-16
-- Reversible: SÍ, con datos vivos (ver «Para revertir» al final)
-- Homologación: YES — cambia cómo se asigna el número de control
--
-- PA SNAT/2011/00071, art. 44: la numeración de control es consecutiva y ÚNICA
-- POR EMISOR, con un identificador de 2 dígitos y un secuencial de hasta 8. En
-- forma libre la imprenta no preimprime la clase del documento (art. 31): un
-- mismo talonario sirve para facturas, notas de crédito y notas de débito.
--
-- ADR-0037 modeló un rango por empresa, CLASE y serie, y el índice único del
-- control incluía la clase. El recorrido (G-01) cargó un rango de notas de
-- crédito A 1-500 sobre el de facturas A 1-5000 y dos documentos salieron con
-- el mismo control impreso. Esta migración:
--
--   1. le da al rango su IDENTIFICADOR (2 dígitos, «00» por omisión) y los
--      datos de la imprenta (razón social, RIF, providencia y su fecha, fecha
--      de elaboración). Los rangos que ya existen quedan con los datos de la
--      imprenta INCOMPLETOS (`printer_data_complete = false`): emitir con ellos
--      se detiene hasta completarlos (claim_fiscal_control, LAD49);
--   2. hace IMPOSIBLE el solape: exclusión sobre (empresa, identificador,
--      rango) para todo rango que no esté anulado, sea de la clase que sea;
--   3. cambia el índice único de control de `documents` a (empresa,
--      identificador, control), SIN la clase ni la serie;
--   4. hace que el consumo del control ignore la clase: cada documento fiscal
--      consume el siguiente control del talonario de su serie.
--
-- EL ENUNCIADO DEL INVARIANTE (no una lista de excepciones, CLAUDE.md §3):
--   «el correlativo de control de la forma libre es único por empresa e
--    identificador». Quedan fuera, por su enunciado:
--   · el comprobante de retención (`kind = 'retention_receipt'`): no es papel
--     de imprenta; su número es AAAAMM + secuencial (PA 000054);
--   · el talonario de CONTINGENCIA (serie «contingencia…», migración 35): es el
--     medio de respaldo de la PA 102, con su propia serie y su propio
--     correlativo, y su unicidad se conserva en su propio índice.
--     VALIDAR-SENIAT en PENDIENTES_ASESOR: ¿comparte el talonario de
--     contingencia el correlativo único del art. 44?
--
-- LO EMITIDO NO SE TOCA (regla 1): si al crear el índice hay controles
-- repetidos, o rangos que se solapan, la migración FALLA con la lista. No se
-- renumera nada en silencio. En el escenario local se corrige el escenario
-- (scripts/recorrido/corregir-escenario.sql); en producción se revisa en solo
-- lectura antes de aplicar.
-- =============================================================================

-- ── 0. Lo que ya existe: repetidos y solapes, con la lista ──────────────────
do $$
declare
  v_lista text;
begin
  select string_agg(format('empresa %s, control %s: %s', company_id, control_number, docs), '; ')
    into v_lista
    from (select company_id, control_number,
                 string_agg(format('%s %s-%s', kind, series, document_number), ', '
                            order by kind, series, document_number) as docs
            from public.documents
           where control_number is not null and lower(series) not like 'contingencia%'
           group by company_id, control_number
          having count(*) > 1) d;
  if v_lista is not null then
    raise exception
      'LAD52: hay documentos emitidos con el MISMO número de control (PA 00071 art. 44). Lo emitido no se renumera en silencio: revísalo antes de aplicar ADR-0071. %', v_lista
      using errcode = 'LAD52';
  end if;

  select string_agg(format('empresa %s: %s %s %s-%s y %s %s %s-%s', a.company_id,
                           coalesce(a.kind, 'talonario'), a.series, a.range_from, a.range_to,
                           coalesce(b.kind, 'talonario'), b.series, b.range_from, b.range_to), '; ')
    into v_lista
    from public.fiscal_number_ranges a
    join public.fiscal_number_ranges b
      on b.company_id = a.company_id and a.id < b.id
     and int8range(a.range_from, a.range_to, '[]') && int8range(b.range_from, b.range_to, '[]')
   where a.status <> 'cancelled' and b.status <> 'cancelled'
     and a.kind is distinct from 'retention_receipt' and b.kind is distinct from 'retention_receipt'
     and lower(a.series) not like 'contingencia%' and lower(b.series) not like 'contingencia%';
  if v_lista is not null then
    raise exception
      'LAD52: hay rangos de control que se solapan (PA 00071 art. 44). Anula el que no corresponde al papel antes de aplicar ADR-0071. %', v_lista
      using errcode = 'LAD52';
  end if;
end $$;

-- ── 1. El rango: identificador y datos de la imprenta ───────────────────────
alter table public.fiscal_number_ranges
  add column printer_identifier text not null default '00',
  add column printer_legal_name text,
  add column printer_tax_id text,
  add column printer_authorization text,
  add column printer_authorization_date date,
  add column printed_on date,
  add constraint fiscal_number_ranges_identifier_chk
    check (printer_identifier ~ '^[0-9]{2}$'),
  add constraint fiscal_number_ranges_printer_name_chk
    check (printer_legal_name is null or length(btrim(printer_legal_name)) between 2 and 200),
  -- Guardado normalizado (letra + 9 dígitos, sin guiones), como el resto de los
  -- RIF (RESPUESTA A-08, M-05). La estructura la valida la API; esto es la red.
  add constraint fiscal_number_ranges_printer_tax_id_chk
    check (printer_tax_id is null or printer_tax_id ~ '^[VEJGPC][0-9]{9}$'),
  add constraint fiscal_number_ranges_printer_authorization_chk
    check (printer_authorization is null
           or length(btrim(printer_authorization)) between 3 and 100),
  -- Art. 44: el secuencial tiene hasta 8 dígitos.
  add constraint fiscal_number_ranges_eight_digits_chk check (range_to <= 99999999);

alter table public.fiscal_number_ranges
  add column printer_data_complete boolean generated always as (
    printer_legal_name is not null and printer_tax_id is not null
    and printer_authorization is not null and printer_authorization_date is not null
    and printed_on is not null
  ) stored;

comment on column public.fiscal_number_ranges.printer_identifier is
  'Los 2 dígitos del identificador del número de control (PA 00071 art. 44). «00» por omisión.';
comment on column public.fiscal_number_ranges.printer_data_complete is
  'Sin los datos de la imprenta (razón social, RIF, providencia y fecha, fecha de elaboración) '
  'no se emite con este talonario (ADR-0071 §1). Los rangos anteriores a la migración nacen '
  'incompletos y la puesta a punto pide completarlos.';

-- La clase deja de separar el correlativo. Los rangos que ya existen conservan
-- la suya como dato histórico; los nuevos se registran sin clase (NULL: el
-- talonario sirve para factura, NC y ND).
alter table public.fiscal_number_ranges alter column kind drop not null;
comment on column public.fiscal_number_ranges.kind is
  'HISTÓRICO (ADR-0037). Desde ADR-0071 la clase no separa el correlativo de control: NULL en '
  'los talonarios nuevos. Solo `retention_receipt` conserva un significado propio.';

-- ── 2. Ningún solape es posible ─────────────────────────────────────────────
alter table public.fiscal_number_ranges
  add constraint fiscal_number_ranges_no_overlap
  exclude using gist (
    company_id with =,
    printer_identifier with =,
    int8range(range_from, range_to, '[]') with &&
  ) where (status <> 'cancelled'
           and kind is distinct from 'retention_receipt'
           and lower(series) not like 'contingencia%');
comment on constraint fiscal_number_ranges_no_overlap on public.fiscal_number_ranges is
  'PA 00071 art. 44 (ADR-0071 §2): un número de control no se repite en la empresa, sea de la '
  'clase que sea. Un rango agotado sigue contando: sus controles ya se imprimieron.';

create index fiscal_number_ranges_series_idx
  on public.fiscal_number_ranges (company_id, series, status);

-- Los datos de la imprenta se escriben UNA vez: completarlos es legítimo,
-- reescribirlos después de emitir con ellos no.
create function platform.assert_range_printer_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.printer_data_complete
     and (new.printer_legal_name, new.printer_tax_id, new.printer_authorization,
          new.printer_authorization_date, new.printed_on, new.printer_identifier)
         is distinct from
         (old.printer_legal_name, old.printer_tax_id, old.printer_authorization,
          old.printer_authorization_date, old.printed_on, old.printer_identifier) then
    raise exception
      'LAD06: los datos de la imprenta de un talonario completo no se reescriben (ADR-0071)'
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_range_printer_frozen() from public;
create trigger fiscal_number_ranges_printer_frozen
  before update on public.fiscal_number_ranges
  for each row execute function platform.assert_range_printer_frozen();

-- ── 3. El documento guarda su identificador; el único deja de mirar la clase ─
alter table public.documents add column control_identifier text;
-- Todos los rangos anteriores nacen con «00» (arriba): sus documentos también.
-- Columna NUEVA: el trigger de inmutabilidad no la mira, y no cambia nada de la
-- identidad fiscal del documento — registra lo que ya era cierto.
update public.documents set control_identifier = '00' where control_number is not null;
alter table public.documents
  add constraint documents_control_identifier_chk
  check ((control_number is null) = (control_identifier is null)
         and (control_identifier is null or control_identifier ~ '^[0-9]{2}$'));
comment on column public.documents.control_identifier is
  'Identificador de 2 dígitos del número de control (PA 00071 art. 44; ADR-0071). Se imprime '
  '`00-00001234`. Presente si y solo si hay control_number.';

-- El identificador acompaña al control: por omisión «00» (el del rango por
-- omisión) cuando quien escribe el control no lo dice, y es inmutable en un
-- documento emitido, igual que el control (assert_document_immutable).
create function platform.documents_control_identifier()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.control_number is null then
    new.control_identifier := null;
  elsif new.control_identifier is null then
    new.control_identifier := '00';
  end if;
  if tg_op = 'UPDATE' and old.status in ('issued', 'paid', 'annulled')
     and new.control_identifier is distinct from old.control_identifier then
    raise exception
      'LAD06: el identificador del número de control de un documento emitido es inmutable (ADR-0071)'
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
revoke execute on function platform.documents_control_identifier() from public;
create trigger documents_03_control_identifier
  before insert or update on public.documents
  for each row execute function platform.documents_control_identifier();

drop index public.documents_control_uidx;
create unique index documents_control_uidx
  on public.documents (company_id, control_identifier, control_number)
  where control_number is not null and lower(series) not like 'contingencia%';
comment on index public.documents_control_uidx is
  'PA 00071 art. 44 (ADR-0071 §2): un control por empresa e identificador, SIN la clase. '
  'Quitar este índice o volver a meter `kind` reabre G-01.';
-- El talonario de contingencia conserva su unicidad dentro de su serie.
create unique index documents_contingency_control_uidx
  on public.documents (company_id, series, control_identifier, control_number)
  where control_number is not null and lower(series) like 'contingencia%';

-- ── 4. El consumo del control ignora la clase ───────────────────────────────
-- Devuelve identificador y control. La clase solo sirve para el mensaje: el
-- talonario es el de la SERIE, sea el documento factura, NC o ND.
create function platform.claim_fiscal_control(p_company uuid, p_kind text, p_series text)
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
    -- E-17 / G-16: en palabras de persona, con la clase en español.
    raise exception
      'No quedan números de control para % (identificador %). Carga el talonario nuevo.',
      v_clase, coalesce(v_ident, '00')
      using errcode = 'LAD49',
            hint = 'ADR-0071: emitir fuera del rango autorizado sería emitir un documento inválido';
  end if;

  if not v_range.printer_data_complete and lower(v_range.series) not like 'contingencia%' then
    raise exception
      'Al talonario serie % (identificador %) le faltan los datos de la imprenta: complétalos en la puesta a punto fiscal antes de volver a emitir.',
      v_range.series, v_range.printer_identifier
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
comment on function platform.claim_fiscal_control(uuid, text, text) is
  'Reserva el siguiente control del talonario de la serie, sea el documento de la clase que sea '
  '(ADR-0071). FOR UPDATE: atómico. LAD49 si no queda o si el talonario no tiene los datos de '
  'la imprenta.';
revoke execute on function platform.claim_fiscal_control(uuid, text, text) from public;
grant execute on function platform.claim_fiscal_control(uuid, text, text) to ladino_api;

-- La función de ADR-0037, redefinida sobre su definición VIVA
-- (20260827192216_create_sales.sql:352, la única que la tocó): ahora también
-- ignora la clase. Queda solo para compatibilidad y SIN ejecución para la API —
-- la emisión usa claim_fiscal_control, que además exige los datos de la imprenta.
create or replace function platform.claim_control_number(
  p_company uuid, p_kind text, p_series text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_range public.fiscal_number_ranges;
  v_num   bigint;
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
    raise exception
      'no hay rango de número de control disponible para % serie % en esta empresa: cárgalo o pide otro a la imprenta',
      p_kind, p_series
      using errcode = 'LAD49',
            hint = 'ADR-0037: emitir fuera del rango autorizado sería emitir un documento inválido';
  end if;

  v_num := v_range.next_available;
  update public.fiscal_number_ranges
     set next_available = v_num + 1,
         status = case when v_num + 1 > range_to then 'exhausted' else status end
   where id = v_range.id;
  return v_num;
end;
$$;
comment on function platform.claim_control_number(uuid, text, text) is
  'COMPATIBILIDAD (ADR-0037 → ADR-0071): consume el control de la serie ignorando la clase. La '
  'API NO la ejecuta: emite con platform.claim_fiscal_control.';
revoke execute on function platform.claim_control_number(uuid, text, text) from ladino_api;

-- ── LAD52: lo que esta migración garantiza sobre sí misma ───────────────────
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'fiscal_number_ranges_no_overlap' and contype = 'x') then
    raise exception 'LAD52: sin la exclusión, dos rangos vuelven a solaparse (G-01)';
  end if;
  if exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'documents_control_uidx'
                and indexdef like '%kind%') then
    raise exception 'LAD52: el único de control no puede incluir la clase (ADR-0071)';
  end if;
  if has_function_privilege('ladino_api', 'platform.claim_control_number(uuid, text, text)',
                            'execute') then
    raise exception 'LAD52: la API no debe emitir con la función que no exige la imprenta';
  end if;
end $$;

-- ── Para revertir (con datos vivos) ─────────────────────────────────────────
-- Una migración NUEVA que: quite `fiscal_number_ranges_no_overlap`,
-- `documents_03_control_identifier` y `fiscal_number_ranges_printer_frozen`;
-- recree `documents_control_uidx` como (company_id, kind, series,
-- control_number) — siempre cabe, es más laxo que el de ahora — y borre
-- `documents_contingency_control_uidx`; devuelva el GRANT de
-- claim_control_number a ladino_api y la versión de ADR-0037 de su cuerpo.
-- Lo que NO vuelve sin pérdida: `kind NOT NULL` exige darle una clase a los
-- talonarios nuevos (NULL), y esa clase no existe en el papel; y los
-- identificadores distintos de «00» de `documents.control_identifier` se
-- perderían si se borra la columna — lo honesto es dejarla. Los datos de la
-- imprenta se quedan.

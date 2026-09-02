-- =============================================================================
-- POS: LA VENTA EMPIEZA POR LA CÉDULA (Fase C, cambio al flujo de /vender)
--
-- Tres piezas de un mismo flujo:
--
--   1. La clave natural del cliente pasa a ser el documento NORMALIZADO
--      (prefijo + alfanumérico, sin guiones ni puntos, en mayúsculas):
--      «J-40123456-7» y «J401234567» son EL MISMO cliente, y hasta hoy el
--      único parcial no lo sabía. Sin regex de formato ni dígito verificador
--      (VALIDAR-SENIAT, OPEN_QUESTIONS 9): normalizar no es validar.
--
--   2. `documents` congela razón social, RIF/cédula y domicilio del cliente
--      (ADR-0033: «el documento fiscal COPIA razón social, RIF y domicilio
--      del cliente al emitir; nunca los referencia» — el lado CLIENTE de
--      R-05). Columnas NULLABLE y SIN DEFAULT: los documentos anteriores a
--      esta migración no saben qué cliente eran ese día, y un backfill sería
--      una inferencia sobre el pasado disfrazada de valor por omisión (misma
--      decisión que el snapshot de tratamiento de la migración 27). Una vez
--      escrito, el snapshot está CONGELADO (LAD68).
--
--   3. `company_settings.allow_unidentified_sales`: si el dueño lo apaga, el
--      mostrador exige identificar al cliente. Default TRUE — un negocio de
--      volumen no se bloquea por omisión.
-- =============================================================================

-- ── 1. La clave natural normalizada del documento ───────────────────────────

-- Antes de jurar unicidad sobre la forma normalizada, comprobar que los datos
-- existentes no la violan ya: si dos clientes de una company normalizan igual,
-- la migración SE PLANTA con nombres y apellidos en vez de fallar a mitad del
-- create index con un mensaje críptico.
do $$
declare
  v_choque record;
begin
  select company_id,
         upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')) as normalizado,
         count(*) as n, array_agg(tax_id order by tax_id) as formas
    into v_choque
    from public.customers
   where tax_id is not null
   group by 1, 2
  having count(*) > 1
   limit 1;
  if found then
    raise exception
      'pos_customer_identification: la company % tiene % clientes cuyo documento normaliza a «%» (%). '
      'Fusiónalos antes de aplicar esta migración.',
      v_choque.company_id, v_choque.n, v_choque.normalizado, v_choque.formas;
  end if;
end $$;

drop index public.customers_company_tax_id_uidx;
-- Mismo nombre, semántica más fuerte: dos formas del mismo documento (con o
-- sin guiones, en cualquier caja) chocan. El índice también sirve al lookup
-- exacto del POS, que consulta con esta MISMA expresión.
create unique index customers_company_tax_id_uidx
  on public.customers (company_id, upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')))
  where tax_id is not null;

comment on index public.customers_company_tax_id_uidx is
  'Clave natural (company, documento NORMALIZADO): prefijo + alfanumérico, sin '
  'separadores, en mayúsculas. Normalizar no es validar formato (VALIDAR-SENIAT).';

-- ── 2. El snapshot del cliente en el documento (R-05, lado cliente) ─────────

alter table public.documents
  add column customer_name_snapshot    text,
  add column customer_tax_id_snapshot  text,
  add column customer_address_snapshot text;

comment on column public.documents.customer_name_snapshot is
  'Razón social del cliente EL DÍA DE ESTE DOCUMENTO (ADR-0033, R-05). NULL solo '
  'en documentos anteriores a la migración 33: no se backfillea el pasado.';
comment on column public.documents.customer_tax_id_snapshot is
  'RIF/cédula del cliente al crear el documento, normalizado como en customers. '
  'Los guiones y puntos son presentación y no se guardan.';
comment on column public.documents.customer_address_snapshot is
  'Domicilio fiscal del cliente al crear el documento. NULL si no lo tenía.';

-- Congelado: el snapshot se escribe con el documento y no se toca más. Sin
-- este trigger, un UPDATE de estado podría «corregir» retroactivamente a quién
-- se le facturó — exactamente lo que R-05 prohíbe. Ausencia de mecanismo no es
-- prohibición.
create function platform.documents_customer_snapshot_freeze()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.customer_name_snapshot, new.customer_tax_id_snapshot, new.customer_address_snapshot)
     is distinct from
     (old.customer_name_snapshot, old.customer_tax_id_snapshot, old.customer_address_snapshot)
  then
    raise exception
      'LAD68: el snapshot del cliente de un documento está congelado (R-05): '
      'se corrige con nota de crédito, no editando el documento'
      using errcode = 'LAD68';
  end if;
  return new;
end;
$$;

revoke execute on function platform.documents_customer_snapshot_freeze() from public;

create trigger documents_customer_snapshot_freeze
  before update on public.documents
  for each row execute function platform.documents_customer_snapshot_freeze();

-- ── 3. El interruptor de la venta sin identificar ───────────────────────────

alter table public.company_settings
  add column allow_unidentified_sales boolean not null default true;

comment on column public.company_settings.allow_unidentified_sales is
  'Si es false, el mostrador exige identificar al cliente: quickSale rechaza el '
  '«Consumidor final» de sistema. Interruptor de experiencia CON respaldo de '
  'dominio — la UI lo esconde y el caso de uso lo rechaza.';

-- ── 4. Lo que esta migración GARANTIZA sobre sí misma (LAD52) ───────────────
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'customers_company_tax_id_uidx'
       and indexdef like '%regexp_replace%'
  ) then
    raise exception 'LAD52: el único parcial no quedó sobre la forma normalizada';
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'documents'
       and column_name like 'customer_%_snapshot' and column_default is not null
  ) then
    raise exception 'LAD52: un snapshot con DEFAULT backfillea el pasado (migración 27, misma regla)';
  end if;
end $$;

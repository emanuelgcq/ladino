-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 38 — La venta se denomina en bolívares (ADR-0046)
--
-- La lista de precios es un ancla en USD; el documento de venta nace en la
-- moneda FUNCIONAL, con el precio unitario ya convertido a la tasa vigente a
-- la fecha. Dos piezas:
--
--   1. Procedencia de la conversión de PRECIO, congelada en el documento:
--      pricing_currency / pricing_fx_rate / pricing_rate_source /
--      pricing_rate_timestamp. Es la regla 3 (origen) y la regla 8 (tasas por
--      fecha y fuente) aplicadas al precio — los siete campos de ADR-0020
--      quedan en identidad y NO pueden cargar esta información sin mentir
--      sobre su semántica (transaction→functional).
--
--   2. El gate: un documento de venta emitido con transaction_currency
--      distinta de functional_currency RECHAZA (LAD70). Va en el trigger de
--      emisión y no en un CHECK NOT VALID a propósito: un CHECK se reevalúa
--      en cada UPDATE y rompería el `set status = 'paid'` de los documentos
--      históricos denominados en divisa, que son legítimos y se imprimen
--      como nacieron.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Procedencia de la conversión de precio ───────────────────────────────
alter table public.documents
  add column pricing_currency        text,
  add column pricing_fx_rate         numeric(24,8),
  add column pricing_rate_source     text,
  add column pricing_rate_timestamp  timestamptz;

alter table public.documents
  add constraint documents_pricing_currency_fk
    foreign key (pricing_currency) references public.currencies (code);

-- Los cuatro viajan juntos: o la lista estaba en divisa y se congela TODO
-- (moneda, tasa, fuente, momento), o estaba en funcional y no hay nada que
-- congelar. Un subconjunto es un origen a medias — peor que ninguno.
alter table public.documents
  add constraint documents_pricing_coherence_chk check (
    (pricing_currency is null and pricing_fx_rate is null
      and pricing_rate_source is null and pricing_rate_timestamp is null)
    or
    (pricing_currency is not null and pricing_fx_rate is not null
      and pricing_rate_source is not null and pricing_rate_timestamp is not null
      and pricing_fx_rate > 0
      and pricing_currency <> functional_currency)
  );

comment on column public.documents.pricing_currency is
  'ADR-0046: moneda de la LISTA de precios cuando difería de la funcional. El '
  'documento se denomina en funcional; esta es la procedencia del precio.';
comment on column public.documents.pricing_fx_rate is
  'ADR-0046: tasa aplicada al convertir el precio de lista a la moneda del '
  'documento, vigente a la fecha (regla 8: efectiva por fecha y fuente).';
comment on column public.documents.pricing_rate_source is
  'ADR-0046: fuente de la tasa de precio (BCV, manual…). Sin fuente no hay tasa.';

-- ── 2. El gate de denominación en el trigger de emisión ─────────────────────
-- Cuerpo VIGENTE (migración 37) + el bloque nuevo. Se copia entero: una
-- reconstrucción parcial es cómo se pierde vocabulario en silencio.
create or replace function platform.assert_document_issuance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_regime record;
begin
  if new.status <> 'issued' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'issued' then return new; end if;

  select * into v_regime from platform.regime_at(new.company_id, new.issued_at);
  if v_regime.regime_version_id is null then
    raise exception
      'la empresa no tiene régimen fiscal vigente a la fecha de emisión: asígnalo antes de emitir (ADR-0029)'
      using errcode = 'LAD49';
  end if;
  if new.regime_version_id is distinct from v_regime.regime_version_id then
    raise exception
      'el documento declara un régimen que no es el vigente a su fecha de emisión'
      using errcode = 'LAD49';
  end if;

  -- EL GATE DE KIND (migración 37): cada régimen emite SOLO sus allowed_kinds.
  -- Con datos fiscales no se vende por recibo; sin RIF no se emite factura.
  if not (new.kind = any(v_regime.allowed_kinds)) then
    raise exception
      'el régimen % no emite documentos de tipo %: sus kinds permitidos son %',
      v_regime.regime_code, new.kind, v_regime.allowed_kinds
      using errcode = 'LAD49';
  end if;

  -- EL GATE DE DENOMINACIÓN (migración 38, ADR-0046): la venta se denomina en
  -- la moneda funcional. La lista en divisa es ancla de precios, no
  -- denominación; su tasa viaja en pricing_fx_rate, no en el importe… y no en
  -- fx_rate, que en identidad vale 1. UNA excepción, que es espejo y no
  -- perdón: la NC/ND hereda la denominación del documento que corrige
  -- (regla 1) — un histórico en divisa tiene que seguir siendo corregible,
  -- y corregirlo en otra moneda descuadraría exactamente lo que corrige.
  if new.transaction_currency <> new.functional_currency then
    if not (new.kind in ('credit_note', 'debit_note')
            and new.source_document_id is not null
            and exists (select 1 from public.documents s
                         where s.id = new.source_document_id
                           and s.transaction_currency = new.transaction_currency)) then
      raise exception
        'un documento de venta se denomina en la moneda funcional (%): la lista en % es ancla de precios, no denominación (ADR-0046)',
        new.functional_currency, new.transaction_currency
        using errcode = 'LAD70';
    end if;
  end if;

  if v_regime.numbering_mode = 'none' then
    raise exception 'el régimen fiscal de esta empresa no permite emitir documentos'
      using errcode = 'LAD49';
  end if;

  if v_regime.numbering_mode in ('none', 'internal_only') and new.control_number is not null then
    raise exception
      'el régimen % no usa número de control y el documento trae uno: un número de control sin imprenta autorizada es un dato inventado',
      v_regime.regime_code
      using errcode = 'LAD49';
  end if;
  if v_regime.numbering_mode = 'range' and new.control_number is null then
    raise exception
      'el régimen % exige número de control de un rango autorizado y el documento no lo trae',
      v_regime.regime_code
      using errcode = 'LAD49';
  end if;

  if new.document_number is null then
    raise exception 'un documento emitido necesita su correlativo' using errcode = 'LAD49';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_document_issuance() from public;

-- ── 3. Autochequeo ──────────────────────────────────────────────────────────
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'documents'
         and column_name in ('pricing_currency', 'pricing_fx_rate',
                             'pricing_rate_source', 'pricing_rate_timestamp')) <> 4 then
    raise exception 'LAD52: faltan columnas de procedencia de precio';
  end if;
end $$;

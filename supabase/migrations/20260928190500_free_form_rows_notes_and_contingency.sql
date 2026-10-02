-- =============================================================================
-- Ladino — LA FORMA LIBRE CUENTA FILAS; LA NOTA IDENTIFICA COMO SU FACTURA; LA CONTINGENCIA REFLEJA
-- SU PAPEL (revisión de la auditoría fiscal de la ola 2, 2026-10-02: A-2, A-3, A-4/A-6, F3)
-- Módulo: ventas · emisión     Corrige: 20260928180300 y 20260928190400 (CLAUDE.md §3)
-- Reversible: SÍ, con datos vivos (ver «Para revertir» al final)
-- Homologación: YES — cambia qué factura, NC o ND sobre forma libre se puede emitir
--
-- 1. A-2 (decidido por criterio): el tope de la forma libre (PA 00071 art. 33) cuenta FILAS
--    IMPRESAS, no líneas: `lines_per_free_form` (nunca publicado) pasa a `rows_per_free_form`.
--    Medido sobre el PDF (factura en USD, gravadas y exentas, vista previa): caben 22 filas de una
--    línea y 24 ya no; la NC y la ND suman dos filas fijas (la factura que corrigen y el ajuste) que
--    no cuentan. Por omisión 15, como máximo 18.
-- 2. `platform.assert_document_issuance`, desde la definición VIVA (20260928190400, la que partió
--    de 190100), cambia SOLO el bloque del adquirente:
--    · A-3: el registro de CONTINGENCIA (serie de un talonario de `contingency_ranges`) no lo pasa;
--    · A-4/A-6: la NC y la ND ya no siguen el 13.7, sino «el mismo cliente y la identificación
--      congelada de la factura que corrigen»;
--    · F3: `delivery_note` queda fuera, a la vista (P-60, VALIDAR-SENIAT).
-- =============================================================================

-- ── 1. El tope, en filas ─────────────────────────────────────────────────────
alter table public.company_settings rename column lines_per_free_form to rows_per_free_form;
alter table public.company_settings drop constraint company_settings_lines_per_free_form_chk;
alter table public.company_settings
  add constraint company_settings_rows_per_free_form_chk check (rows_per_free_form between 1 and 18);
comment on column public.company_settings.rows_per_free_form is
  'PA 00071 art. 33: una factura, NC o ND sobre forma libre ocupa UNA forma. Tope de FILAS IMPRESAS '
  '(descripciones partidas con @ladino/schemas forma-libre.ts y, en las notas, el motivo) que el '
  'dominio exige al emitir. Medido: caben 22 filas; por omisión 15, como máximo 18.';
comment on constraint company_settings_rows_per_free_form_chk on public.company_settings is
  'El máximo (18) es lo que cabe con holgura en una página del PDF de papel (medido); subirlo exige '
  'medir de nuevo, porque `?destino=papel` rechaza lo que pase de una página.';

-- ── 2. La puerta de emisión ──────────────────────────────────────────────────
create or replace function platform.assert_document_issuance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_regime record;
  v_tipo text;
  v_cliente record;
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

  -- ADR-0072 §1 (A-03): factura, NC y ND exigen tipo de contribuyente vigente en el DÍA de
  -- Caracas de la emisión, y declarable. Nunca «ordinario por omisión». El recibo no lo pide.
  if new.kind in ('invoice', 'credit_note', 'debit_note') then
    v_tipo := platform.taxpayer_type_at(new.company_id, platform.caracas_day(new.issued_at));
    if v_tipo is null or v_tipo not in ('ordinario', 'especial', 'formal') then
      raise exception
        'la empresa no tiene tipo de contribuyente declarado vigente al %: declárelo antes de emitir (ADR-0072)',
        platform.caracas_day(new.issued_at)
        using errcode = 'LAD98';
    end if;
  end if;

  -- EL ADQUIRENTE SOBRE FORMA LIBRE (numeración por rango).
  --  · delivery_note (orden de entrega o guía de despacho) queda FUERA a propósito: si la PA 00071
  --    le exige nombre y RIF o cédula del adquirente es la pregunta P-60 (VALIDAR-SENIAT).
  --  · el registro a posteriori de CONTINGENCIA (A-3) refleja un papel que ya existe: su serie es
  --    la de un talonario de `contingency_ranges` y el bloque no aplica.
  if v_regime.numbering_mode = 'range'
     and new.kind = any (array['invoice', 'credit_note', 'debit_note'])
     and not exists (select 1
                       from public.contingency_ranges cr
                       join public.fiscal_number_ranges r on r.id = cr.fiscal_number_range_id
                      where r.company_id = new.company_id and r.series = new.series) then
    if new.kind = 'invoice' then
      -- PA 00071 art. 13.7 (VALIDAR-SENIAT P-57, lectura conservadora): la factura lleva al
      -- adquirente identificado — ni el «Consumidor final» de sistema, ni un cliente sin nombre o
      -- sin RIF, cédula o pasaporte, ni el marcador PEND-. Lo congelado manda; lo vivo, si no hay.
      select cu.is_system,
             nullif(btrim(coalesce(new.customer_name_snapshot, cu.legal_name)), '') as nombre,
             nullif(btrim(coalesce(new.customer_tax_id_snapshot, cu.tax_id)), '') as documento
        into v_cliente
        from public.customers cu
       where cu.id = new.customer_id;
      if v_cliente.is_system is distinct from false
         or v_cliente.nombre is null
         or v_cliente.documento is null
         or upper(v_cliente.documento) like 'PEND-%' then
        raise exception
          'sobre forma libre, la factura lleva el nombre del adquirente y su RIF, cédula o pasaporte (PA 00071 art. 13.7): el «Consumidor final» es solo para recibos'
          using errcode = 'LAD99';
      end if;
    else
      -- A-4/A-6 (decidido por criterio; regla 1: toda factura se corrige con nota): la NC y la ND
      -- identifican al adquirente EXACTAMENTE como lo hizo la factura que corrigen — el mismo
      -- cliente y la identificación congelada del origen (lo vivo, si el origen es anterior a la
      -- migración 33). Así una factura vieja al «Consumidor final» tiene su nota.
      select (o.customer_id = new.customer_id
              and coalesce(o.customer_name_snapshot, cu.legal_name)
                  is not distinct from coalesce(new.customer_name_snapshot, cu.legal_name)
              and upper(regexp_replace(coalesce(o.customer_tax_id_snapshot, cu.tax_id, ''),
                                       '[^a-zA-Z0-9]', '', 'g'))
                  is not distinct from
                  upper(regexp_replace(coalesce(new.customer_tax_id_snapshot, cu.tax_id, ''),
                                       '[^a-zA-Z0-9]', '', 'g'))) as igual
        into v_cliente
        from public.documents o
        join public.customers cu on cu.id = o.customer_id
       where o.id = new.source_document_id and o.company_id = new.company_id;
      if v_cliente.igual is distinct from true then
        raise exception
          '% identifica al adquirente exactamente como la factura que corrige: el mismo cliente y su identificación congelada',
          case new.kind when 'credit_note' then 'la nota de crédito' else 'la nota de débito' end
          using errcode = 'LAD99';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_document_issuance() from public;

-- ── Para revertir ────────────────────────────────────────────────────────────
-- 1. `alter table public.company_settings rename column rows_per_free_form to lines_per_free_form;`
--    y el CHECK con su nombre anterior: con datos vivos el valor de cada empresa se conserva, pero
--    pasa a leerse como líneas (más permisivo con descripciones largas).
-- 2. Volver a ejecutar la definición de 20260928190400 (copiarla tal cual). La función no escribe:
--    no hay datos que deshacer; al revertir, la NC de una factura al «Consumidor final» y la
--    contingencia al «Consumidor final» vuelven a ser imposibles en la base.

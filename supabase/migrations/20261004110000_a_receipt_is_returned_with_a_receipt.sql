-- =============================================================================
-- Ladino — UN RECIBO SE DEVUELVE CON RECIBO, Y EL FORMAL NO VENDE GRAVADO
-- Módulo: ventas / fiscal   Spec: docs/02_COMPLIANCE/EMISION_FACTURAS.md, ADR-0061, ADR-0072
-- Recorrido 2026-09-24, M-12 y M-10 (respuesta del dueño del 2026-09-28, §3 M).
--
-- Reversible: SÍ, con otra migración que restituya la definición de 20261003180000 y quite el
--   trigger `document_lines_formal`. CON DATOS VIVOS: los recibos de devolución que se emitan
--   bajo un régimen de facturas mientras esta migración rija QUEDAN (documents es inmutable una
--   vez emitido): la definición anterior no los habría dejado nacer, pero no los juzga de nuevo
--   (el trigger solo mira la emisión). No se toca ninguna fila existente.
-- Expand: SÍ. Solo ABRE un caso (la API desplegada lo rechaza antes, en el dominio) y añade una
--   guarda para un tipo que hoy no se puede declarar. Funciona con la app saliente y la entrante.
-- HOMOLOGATION_IMPACT: YES — cambia qué documentos emite una empresa que ya factura.
--
-- 1. M-12. `receipt_return` solo estaba en los `allowed_kinds` de `sin_facturacion`, y el régimen
--    se juzga a la fecha de emisión: la bodega que obtuvo su RIF no tenía NINGÚN documento para
--    devolverle algo a quien le compró con recibo (la NC corrige una factura: PA 00071 art. 22).
--    Ahora el recibo de devolución cuyo origen es un RECIBO de la misma empresa se emite bajo
--    cualquier régimen que emita, sin número de control (no es documento fiscal, no gasta papel
--    del talonario). El resto del gate no cambia: quien factura no VENDE por recibo, y una factura
--    no se devuelve con recibo de devolución. No se toca `fiscal_regimes.allowed_kinds`: lo que
--    el régimen «emite» sigue siendo lo que vende; la devolución de un recibo es la excepción que
--    el propio trigger enuncia.
--
-- 2. M-10 (LIVA art. 8, fuente secundaria en REGULATORY_STATUS §2-bis: el contribuyente formal
--    solo realiza operaciones exentas o exoneradas). El trigger ya aceptaba `formal` como tipo que
--    emite y nada le impedía una línea gravada. `formal` hoy NO se puede declarar (CHECK
--    `company_taxpayer_types_declarable_chk`, PENDIENTES_ASESOR P-38: falta la fuente de la
--    periodicidad de la PA SNAT/2003/1677), así que esta guarda no cambia nada observable hoy:
--    queda puesta para el día en que se reabra, y falla activamente en vez de depender de que el
--    tipo no exista (CLAUDE.md §2). Aplica a factura y nota de débito; la nota de crédito revierte
--    un débito que ya existió y queda fuera.
--
-- Funciones redefinidas: platform.assert_document_issuance() — parte de la definición VIVA
--   (20261003180000; ninguna migración posterior la toca). Diferencias: `v_devuelve_recibo` (tres
--   líneas) y el bloque del formal. Función nueva: platform.assert_formal_line().
-- =============================================================================

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
  v_devuelve_recibo boolean := false;
begin
  if new.status <> 'issued' then return new; end if;
  -- Ya emitido: `issued` que sigue `issued`, o `paid` que vuelve a `issued` porque se reversó un
  -- cobro (ADR-0075 §8). La emisión se juzgó cuando se emitió.
  if tg_op = 'UPDATE' and old.status in ('issued', 'paid') then return new; end if;

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

  -- M-12: un recibo se devuelve con recibo de devolución, aunque la empresa ya facture. La
  -- excepción es SOLO esa: el origen es un recibo de la misma empresa.
  v_devuelve_recibo := new.kind = 'receipt_return' and exists (
    select 1 from public.documents o
     where o.id = new.source_document_id and o.company_id = new.company_id
       and o.kind = 'receipt');

  -- EL GATE DE KIND (migración 37): cada régimen emite SOLO sus allowed_kinds.
  -- Con datos fiscales no se vende por recibo; sin RIF no se emite factura.
  if not (new.kind = any(v_regime.allowed_kinds)) and not v_devuelve_recibo then
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
  -- M-12: el recibo de devolución no es documento fiscal y no gasta papel del talonario.
  if new.kind = 'receipt_return' and new.control_number is not null then
    raise exception
      'el recibo de devolución no es un documento fiscal: no lleva número de control del talonario'
      using errcode = 'LAD49';
  end if;
  if v_regime.numbering_mode = 'range' and new.control_number is null and not v_devuelve_recibo then
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

  -- M-10 (LIVA art. 8): el contribuyente formal solo realiza operaciones exentas o exoneradas.
  -- Su factura y su nota de débito no llevan una línea gravada. La NC revierte un débito que ya
  -- existió (el de cuando era ordinario) y no se juzga aquí.
  if v_tipo = 'formal' and new.kind in ('invoice', 'debit_note') and exists (
       select 1 from public.document_lines l
        where l.document_id = new.id
          and (l.tax_treatment = 'gravado' or l.tax_amount > 0)) then
    raise exception
      'Con esta condición no puedes vender productos gravados; si tu negocio cambió, actualiza el tipo de contribuyente (contribuyente formal: LIVA art. 8)'
      using errcode = 'LAD99';
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

comment on function platform.assert_document_issuance() is
  'El gate de la emisión: régimen vigente, kind permitido, numeración, tipo de contribuyente y '
  'adquirente sobre forma libre. M-12: un recibo de devolución cuyo origen es un RECIBO se emite '
  'bajo cualquier régimen que emita, sin control. M-10: un `formal` no emite factura ni ND con '
  'una línea gravada (LIVA art. 8).';

-- ── M-10, segunda puerta: la línea que llega DESPUÉS de emitir ───────────────
-- El dominio inserta las líneas con el documento en borrador y la guarda de arriba las lee al
-- emitir. Pero `document_lines` admite INSERT sobre un documento ya emitido, y por ahí la guarda
-- no pasa: sin esta puerta, «el formal no vende gravado» dependería de que nadie use ese camino.
-- El WHEN deja fuera toda línea que no sea gravada; para una gravada, el coste es una lectura
-- por clave primaria del documento.
create function platform.assert_formal_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc record;
begin
  select d.company_id, d.kind, d.status, d.issued_at into v_doc
    from public.documents d where d.id = new.document_id;
  if v_doc.status in ('issued', 'paid')
     and v_doc.kind in ('invoice', 'debit_note')
     and platform.taxpayer_type_at(v_doc.company_id, platform.caracas_day(v_doc.issued_at))
         = 'formal' then
    raise exception
      'Con esta condición no puedes vender productos gravados; si tu negocio cambió, actualiza el tipo de contribuyente (contribuyente formal: LIVA art. 8)'
      using errcode = 'LAD99';
  end if;
  return new;
end;
$$;

comment on function platform.assert_formal_line() is
  'M-10 (LIVA art. 8): a la factura o ND ya emitida de un contribuyente formal no se le agrega '
  'una línea gravada. Pareja de la guarda de platform.assert_document_issuance(), que juzga las '
  'líneas presentes al emitir.';

revoke execute on function platform.assert_formal_line() from public;

create trigger document_lines_formal
  before insert on public.document_lines
  for each row
  when (new.tax_treatment = 'gravado' or new.tax_amount > 0)
  execute function platform.assert_formal_line();

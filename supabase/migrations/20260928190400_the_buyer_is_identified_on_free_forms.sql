-- =============================================================================
-- Ladino — EL ADQUIRENTE, IDENTIFICADO EN LA FORMA LIBRE (PA 00071 art. 13.7; auditoría 2026-10-02)
-- Módulo: ventas · emisión     Hallazgo: auditoría fiscal de la ola 2 · VALIDAR-SENIAT P-57
-- Reversible: SÍ, con datos vivos (ver «Para revertir» al final)
-- Homologación: YES — una factura, NC o ND sobre forma libre deja de poder emitirse al
--               «Consumidor final» de sistema
--
-- PA 00071 art. 13.7: la factura lleva el nombre o razón social del adquirente y su RIF o, si es
-- persona natural sin uso tributario, su cédula o pasaporte. Mientras el asesor no responda P-57
-- («¿puede emitirse factura sobre forma libre sin nombre ni cédula del adquirente persona
-- natural?»), lectura CONSERVADORA: en una empresa con régimen de formas libres (numeración por
-- rango), factura, NC y ND exigen un adquirente que NO sea el «Consumidor final» de sistema, con
-- nombre y documento. El «Consumidor final» y `allow_unidentified_sales` quedan para los RECIBOS.
-- El dominio lo dice antes con un 422 legible; esto es la red (CLAUDE.md §2). LAD99.
--
-- POR QUÉ ESTE TIMESTAMP Y NO 180300: `platform.assert_document_issuance` se redefinió por última
-- vez en 20260928190100 (tipo de contribuyente). Una redefinición con un timestamp ANTERIOR la
-- pisaría esa migración en un `db:reset` y la comprobación desaparecería sin ruido. Parte de la
-- definición VIVA de 190100, copiada tal cual, y añade solo el bloque del adquirente, DESPUÉS del
-- del tipo (el pgTAP 088 localiza ese bloque por su texto).
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

  -- PA 00071 art. 13.7 (VALIDAR-SENIAT P-57, lectura conservadora): sobre forma libre, el
  -- adquirente de factura, NC y ND va identificado — ni el «Consumidor final» de sistema, ni un
  -- cliente sin nombre o sin RIF, cédula o pasaporte. Lo congelado manda; lo vivo, si no hay.
  if v_regime.numbering_mode = 'range'
     and new.kind = any (array['invoice', 'credit_note', 'debit_note']) then
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
        'sobre forma libre, % lleva el nombre del adquirente y su RIF, cédula o pasaporte (PA 00071 art. 13.7): el «Consumidor final» es solo para recibos',
        case new.kind when 'invoice' then 'la factura'
                      when 'credit_note' then 'la nota de crédito'
                      else 'la nota de débito' end
        using errcode = 'LAD99';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_document_issuance() from public;

-- ── Para revertir ────────────────────────────────────────────────────────────
-- Volver a ejecutar la definición de 20260928190100 (copiarla tal cual). Con datos vivos no hay
-- nada que deshacer: la función no escribe; al revertir, la base vuelve a dejar emitir una factura
-- sobre forma libre al «Consumidor final» y queda solo la puerta del dominio.

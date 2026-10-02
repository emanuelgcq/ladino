-- =============================================================================
-- El tipo de contribuyente, defendido en la base (ADR-0072 §1; revisión de A-03, B-07, F-11).
-- Módulo: fiscal / ventas   Spec: docs/02_COMPLIANCE/RETENTIONS_SPEC.md
--
-- Corrige lo que la revisión encontró en 20260928190000 (CLAUDE.md §3: una migración que arregla
-- otra lleva su propia auditoría):
--   1. `platform.document_balance_transaction` (y `document_debt_today`, que la llama) fallaba
--      como `authenticated`: «permission denied for table supported_retention_receipts». La tabla
--      solo tenía GRANT y policies para ladino_api. Se da SELECT a authenticated con la policy
--      de siempre (empresas visibles del usuario).
--   2. `no_contribuyente` NUNCA se declara (decidido por criterio, §2.16): se deriva de no tener
--      RIF. Un CHECK en la historia lo cierra también en la base.
--   3. La puerta de emisión, EN LA BASE (§2: la ausencia de mecanismo no es prohibición):
--      `platform.assert_document_issuance` exige, para invoice, credit_note y debit_note de una
--      empresa con RIF, un tipo vigente a la fecha de emisión en {ordinario, especial, formal}.
--      LAD98. Parte de la ÚLTIMA definición viva (20260904233235_debt_anchored_in_document_currency).
--   4. El comentario del CHECK de 14 dígitos decía «no juzga filas viejas», y es inexacto: un
--      CHECK NOT VALID no se valida sobre lo existente al crearlo, pero SÍ se evalúa en todo
--      UPDATE de cualquier fila. Se deja escrito en el COMMENT: la reversa de la ola 3 (R-61), que
--      marcará `status = 'annulled'` en comprobantes viejos con números de otro formato, chocará
--      con 23514 si no lo tiene en cuenta.
--
-- Reversible: SÍ, con datos vivos. El GRANT y la policy se retiran con revoke/drop policy. El
-- CHECK de la historia se retira con drop constraint. El trigger vuelve a la definición de
-- 20260904233235 (copiarla tal cual): al revertir, la base deja de impedir una factura sin tipo y
-- solo queda la puerta del dominio.
-- HOMOLOGATION_IMPACT: NO — no cambia numeración, control ni formato; impide emitir sin tipo
-- declarado, que ya impedía el dominio.
-- =============================================================================

-- ── 1. La retención soportada, legible para authenticated ────────────────────
grant select on public.supported_retention_receipts to authenticated;
create policy srr_select on public.supported_retention_receipts for select
  to authenticated using (company_id in (select platform.ladino_company_ids()));

-- ── 2. `no_contribuyente` no se declara ──────────────────────────────────────
alter table public.company_taxpayer_types
  add constraint company_taxpayer_types_declarable_chk
  check (taxpayer_type_code in ('ordinario', 'especial', 'formal'));
comment on constraint company_taxpayer_types_declarable_chk on public.company_taxpayer_types is
  'Decidido por criterio (ADR-0072, nota de aplicación): no_contribuyente se DERIVA de no tener RIF '
  '(platform.taxpayer_type_at), nunca se declara. VALIDAR-TRIBUTARIO en PENDIENTES_ASESOR.';

-- ── 3. La puerta de emisión en la base ───────────────────────────────────────
create or replace function platform.assert_document_issuance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_regime record;
  v_tipo text;
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
  return new;
end;
$$;
revoke execute on function platform.assert_document_issuance() from public;

-- ── 4. El CHECK de 14 dígitos, dicho con exactitud ───────────────────────────
comment on constraint srr_receipt_14_digits_chk on public.supported_retention_receipts is
  'Comprobante de 14 dígitos (AAAAMM + 8, PA SNAT/2025/000054). NOT VALID: no se validó sobre las '
  'filas existentes al crearlo, PERO se evalúa en TODO INSERT y en TODO UPDATE de cualquier fila. '
  'TRAMPA para la reversa (R-61, ola 3): anular un comprobante viejo con otro formato de número '
  'fallará con 23514 salvo que la migración de la reversa lo resuelva (p. ej. excluyendo el '
  'status annulled del CHECK).';

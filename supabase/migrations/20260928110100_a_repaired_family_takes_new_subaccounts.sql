-- =============================================================================
-- Ladino — UNA FAMILIA YA REPARADA ACEPTA SUBCUENTAS NUEVAS (ADR-0070, J-01)
--
-- Módulo: contabilidad · tesorería (RIGOR MÁXIMO: dinero y mayor)
-- Spec: ADR-0070 · migración 20260928110000 (la que esta corrige)
-- HOMOLOGATION_IMPACT: NO.
--
-- EL DEFECTO, de la migración 20260928110000 y cazado por su propio pgTAP (076, «en la empresa
-- reparada, la caja nueva nace con su subcuenta»): `treasury_family_is_clean` decía «limpia»
-- solo si la cuenta de familia no tenía NINGUNA línea. Tras la reparación la familia conserva su
-- historia (las líneas de antes y el asiento de reclasificación que la deja en cero), así que en
-- una empresa ya reparada toda caja nueva se habría mapeado a la familia — que ya es agrupadora —
-- y su primer hecho habría muerto en LAD62.
--
-- LA REGLA CORRECTA. La familia puede recibir hijas si ninguna caja la usa y, además:
--   · ya es agrupadora (empresa reparada, o que ya dio subcuentas), o
--   · no tiene historia propia (empresa nueva).
-- Si una caja todavía la usa, o es una hoja con historia, la empresa espera su reparación.
--
-- Definición VIVA de partida: 20260928110000. Solo cambia la segunda condición.
-- Auditoría del conjunto (CLAUDE.md §3): los dos llamantes (`treasury_account_default_ledger`,
-- `treasury_accounts_map_on_purpose`) no cambian; la reparación no usa esta función; el
-- invariante tampoco. Una familia agrupadora con saldo propio distinto de cero (una reparación a
-- medias) no puede existir: `treasury_subaccounts_repair_finish` lo rechaza con LAD82.
--
-- REVERSIBILIDAD: total. Volver a la definición de 20260928110000 (con su defecto).
-- =============================================================================

create or replace function platform.treasury_family_is_clean(p_family uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from public.company_accounts ca where ca.ledger_account_id = p_family)
     and (not (select a.is_leaf from public.accounts a where a.id = p_family)
          or not exists (select 1 from public.journal_lines jl where jl.account_id = p_family))
$$;
revoke execute on function platform.treasury_family_is_clean(uuid) from public;

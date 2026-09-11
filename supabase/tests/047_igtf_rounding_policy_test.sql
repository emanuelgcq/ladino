-- =============================================================================
-- Ladino — pgTAP 47 · Política de redondeo de la percepción de IGTF (ADR-0053)
--
--   1. `igtf_perceptions.rounding_policy_id` existe y es NOT NULL: la spec no
--      admite un functional_amount sin su política;
--   2. el default es el de la regla VIEJA (8, HALF_UP), que es lo que de
--      verdad hace la API anterior mientras siga desplegada — el default
--      describe al código que lo usa, no al nuevo;
--   3. el CHECK de forma rechaza un identificador vacío o mal formado y acepta
--      los dos que el sistema emite.
-- =============================================================================

begin;
select plan(6);

-- ── 1. La columna ───────────────────────────────────────────────────────────
select has_column('public', 'igtf_perceptions', 'rounding_policy_id',
  'igtf_perceptions guarda la política de redondeo aplicada');

select col_not_null('public', 'igtf_perceptions', 'rounding_policy_id',
  'la política es obligatoria: un functional_amount no viaja sin ella');

-- ── 2. El default de transición dice la verdad de la API vieja ──────────────
select col_default_is('public', 'igtf_perceptions', 'rounding_policy_id',
  'igtf:perception:8:HALF_UP'::text,
  'el default etiqueta las filas de la API anterior con la regla que aplicaba');

-- ── 3. La forma del identificador ───────────────────────────────────────────
select ok(
  'igtf:perception:2:HALF_UP' ~ (
    select substring(pg_get_constraintdef(oid) from '''(.*)''')
      from pg_constraint where conname = 'igtf_perceptions_rounding_policy_chk'),
  'la política nueva (2, HALF_UP) cumple la forma');

select ok(
  'igtf:perception:8:HALF_UP' ~ (
    select substring(pg_get_constraintdef(oid) from '''(.*)''')
      from pg_constraint where conname = 'igtf_perceptions_rounding_policy_chk'),
  'la política vieja (8, HALF_UP) cumple la forma');

select ok(
  not ('' ~ (
    select substring(pg_get_constraintdef(oid) from '''(.*)''')
      from pg_constraint where conname = 'igtf_perceptions_rounding_policy_chk')),
  'un identificador vacío NO cumple la forma: aparentaría trazabilidad');

select * from finish();
rollback;

-- =============================================================================
-- Ladino — pgTAP 87 · EL CONTROL SE IMPRIME (ADR-0071 §4)
-- Migración 20260928180000_the_control_is_printed.sql.
--
-- Qué se prueba (con su variante rota):
--   1. `company_settings.print_control_number` existe, es NOT NULL y nace ENCENDIDO: una empresa
--      que nunca tocó el ajuste imprime el control (lo que hacía el PDF antes de la migración);
--   2. el NOT NULL rechaza el nulo (23502) — y SIN él el nulo entra: el throws_ok medía el
--      constraint, no otra cosa. Un nulo sería un tercer estado que el PDF no sabría leer;
--   0. B-08: el régimen del catálogo se llama «Formas libres» (migración 180100);
--      L-11: el adaptador de libros cita el Reglamento de la LIVA (migración 180200);
--   3. ladino_api con actor de A APAGA el ajuste de A (la operación se ejerce, no se pregunta por
--      el privilegio) y no toca el de B: 0 filas, dato intacto. El usuario de los dos tenants
--      cambia los dos (legítimo).
-- =============================================================================

begin;
select plan(12);

insert into auth.users (id) values
  ('aaaa0084-0000-4000-8000-0000000000a1'),
  ('aaaa0084-0000-4000-8000-0000000000c1');
insert into public.tenants (id, name) values
  ('aaaa0084-0000-4000-8000-00000000000a', 'Tenant 84 A'),
  ('aaaa0084-0000-4000-8000-00000000000b', 'Tenant 84 B');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0084-0000-4000-8000-0000000000a2', 'aaaa0084-0000-4000-8000-00000000000a',
   'J-84-A', 'Control impreso A'),
  ('aaaa0084-0000-4000-8000-0000000000b2', 'aaaa0084-0000-4000-8000-00000000000b',
   'J-84-B', 'Control impreso B');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0084-0000-4000-8000-0000000000a3', 'aaaa0084-0000-4000-8000-00000000000a',
   'aaaa0084-0000-4000-8000-0000000000a1'),
  ('aaaa0084-0000-4000-8000-0000000000c3', 'aaaa0084-0000-4000-8000-00000000000a',
   'aaaa0084-0000-4000-8000-0000000000c1'),
  ('aaaa0084-0000-4000-8000-0000000000c4', 'aaaa0084-0000-4000-8000-00000000000b',
   'aaaa0084-0000-4000-8000-0000000000c1');

select set_config('ladino.actor_id', 'aaaa0084-0000-4000-8000-0000000000a1', true);
-- Filas de ajustes SIN mencionar la columna: el default es el que habla.
insert into public.company_settings (company_id, tenant_id) values
  ('aaaa0084-0000-4000-8000-0000000000a2', 'aaaa0084-0000-4000-8000-00000000000a'),
  ('aaaa0084-0000-4000-8000-0000000000b2', 'aaaa0084-0000-4000-8000-00000000000b');

-- ── 0. B-08 (migración 180100): el catálogo dice «Formas libres» (PA 00071 arts. 6 y 31) ──
select is((select name from public.fiscal_regimes where code = 'formatos_libres'),
  'Formas libres', 'el régimen se llama «Formas libres»: «formatos» es otro medio (art. 30)');

-- L-11 (migración 180200): el adaptador de libros cita el Reglamento de la LIVA, no la PA 071.
select ok((select name like '%Reglamento de la LIVA%' and name not like '%PA 071%'
             from public.book_format_adapters where code = 'csv_columnas_legales'),
  'el CSV de libros cita el Reglamento de la LIVA (arts. 70 a 78), no la providencia de la factura');
select is((select is_official from public.book_format_adapters where code = 'csv_columnas_legales'),
  false, 'y sigue siendo NO oficial: ninguna providencia fija un modelo de libro (RLIVA art. 74)');

-- ── 1. Nace encendido ────────────────────────────────────────────────────────
select col_not_null('public', 'company_settings', 'print_control_number',
  'print_control_number es NOT NULL');
select is(
  (select print_control_number from public.company_settings
    where company_id = 'aaaa0084-0000-4000-8000-0000000000a2'),
  true, 'una empresa que no tocó el ajuste imprime el control en el cuerpo (por omisión, sí)');

-- ── 2. El NOT NULL, y su variante rota ───────────────────────────────────────
select throws_ok($$
  update public.company_settings set print_control_number = null
   where company_id = 'aaaa0084-0000-4000-8000-0000000000a2'
$$, '23502', null, 'un nulo no es un estado del ajuste: 23502');

savepoint roto;
alter table public.company_settings alter column print_control_number drop not null;
select lives_ok($$
  update public.company_settings set print_control_number = null
   where company_id = 'aaaa0084-0000-4000-8000-0000000000a2'
$$, 'SIN el NOT NULL el nulo entra: el throws_ok de arriba medía el constraint');
rollback to savepoint roto;

-- ── 3. ladino_api, en las dos direcciones ────────────────────────────────────
set local role ladino_api;
update public.company_settings set print_control_number = false
 where company_id = 'aaaa0084-0000-4000-8000-0000000000a2';
update public.company_settings set print_control_number = false
 where company_id = 'aaaa0084-0000-4000-8000-0000000000b2';
reset role;
select is(
  (select print_control_number from public.company_settings
    where company_id = 'aaaa0084-0000-4000-8000-0000000000a2'),
  false, 'ladino_api con actor de A APAGA el ajuste de A (la operación funciona de verdad)');
select is(
  (select print_control_number from public.company_settings
    where company_id = 'aaaa0084-0000-4000-8000-0000000000b2'),
  true, 'el UPDATE de A sobre los ajustes de B no cambió NADA');

select set_config('ladino.actor_id', 'aaaa0084-0000-4000-8000-0000000000c1', true);
set local role ladino_api;
select is(
  (select count(*) from public.company_settings
    where company_id in ('aaaa0084-0000-4000-8000-0000000000a2',
                         'aaaa0084-0000-4000-8000-0000000000b2')),
  2::bigint, 'el usuario de los dos tenants ve los ajustes de los dos (legítimo)');
update public.company_settings set print_control_number = true
 where company_id = 'aaaa0084-0000-4000-8000-0000000000a2';
update public.company_settings set print_control_number = false
 where company_id = 'aaaa0084-0000-4000-8000-0000000000b2';
reset role;
select is(
  (select print_control_number from public.company_settings
    where company_id = 'aaaa0084-0000-4000-8000-0000000000a2'),
  true, 'el usuario de los dos tenants vuelve a encender el de A');
select is(
  (select print_control_number from public.company_settings
    where company_id = 'aaaa0084-0000-4000-8000-0000000000b2'),
  false, 'y apaga el de B');

select * from finish();
rollback;

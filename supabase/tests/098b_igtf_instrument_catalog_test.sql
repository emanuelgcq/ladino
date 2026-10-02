-- =============================================================================
-- Ladino — pgTAP 98b · TODO INSTRUMENTO DE COBRO TIENE SU CLASE DE IGTF (20261002100100)
--
-- Qué instrumento causa IGTF es data de plataforma (PA SNAT/2022/000013 art. 1). El dominio ya no
-- dice «no causa» cuando falta la fila: da un error legible. Este gate exige que la fila exista
-- para todo valor del CHECK de `payments.instrument` (salvo saldo_a_favor y retencion_iva, que no
-- son dinero), con su fuente; y una variante rota que lo demuestra.
-- =============================================================================

begin;
select plan(5);

create temporary table instrumentos_del_check on commit drop as
select unnest(regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g')) as instrument
  from pg_constraint c
 where c.conrelid = 'public.payments'::regclass and c.contype = 'c'
   and pg_get_constraintdef(c.oid) like '%instrument = ANY%'
   and pg_get_constraintdef(c.oid) like '%efectivo_bs%';

select ok((select count(*) from instrumentos_del_check) >= 10,
  'se leyeron los instrumentos del CHECK de payments.instrument (no una lista escrita a mano)');

select is(
  (select coalesce(string_agg(i.instrument, ', ' order by i.instrument), '')
     from instrumentos_del_check i
    where i.instrument not in ('saldo_a_favor', 'retencion_iva')
      and not exists (select 1 from public.igtf_instrument_classes k
                       where k.instrument = i.instrument)),
  '', 'todo instrumento de dinero del CHECK tiene su fila en igtf_instrument_classes');

select is((select count(*)::int from public.igtf_instrument_classes
            where length(btrim(legal_source)) < 10), 0,
  'cada clasificación cita su fuente');

select ok(not exists (select 1 from public.igtf_instrument_classes
                       where instrument in ('saldo_a_favor', 'retencion_iva')),
  'aplicar un saldo o una retención no es un cobro en divisas: no se clasifica');

-- Variante rota: sin la fila de «zelle», el gate la nombra. Si no la nombrara, el verde de arriba
-- no estaría midiendo la completitud.
delete from public.igtf_instrument_classes where instrument = 'zelle';
select is(
  (select coalesce(string_agg(i.instrument, ', ' order by i.instrument), '')
     from instrumentos_del_check i
    where i.instrument not in ('saldo_a_favor', 'retencion_iva')
      and not exists (select 1 from public.igtf_instrument_classes k
                       where k.instrument = i.instrument)),
  'zelle', 'variante rota: sin la fila de zelle, el gate la nombra');

select * from finish();
rollback;

-- =============================================================================
-- Ladino — pgTAP 75 · UN SOLO CORRELATIVO DE CONTROL POR EMISOR (G-01)
-- (RESPUESTA_RECORRIDO_2026-09-24.md ola 0, punto 6(b); sección 2.1 del dueño)
--
-- PA SNAT/2011/00071, art. 44: el número de control es consecutivo y ÚNICO
-- por emisor. En forma libre la imprenta no preimprime la clase del documento
-- (art. 31), así que factura, nota de crédito y nota de débito comparten el
-- MISMO correlativo — no puede haber un tramo de facturas y otro de notas que
-- se solapen, porque dos documentos de clases distintas terminarían con el
-- mismo control impreso.
--
-- Hoy `fiscal_number_ranges` no tiene ninguna defensa contra eso: el índice
-- único de `documents` incluye `kind` (`documents_control_uidx`,
-- `20260827192216_create_sales.sql:530-532`) y nada en `fiscal_number_ranges`
-- impide cargar un rango de notas de crédito que pisa el de facturas
-- (`sales.ts:777-786`). Este test es la variante rota que G-01 encontró:
-- cargar un segundo rango, de otra CLASE, que se solapa con uno ya activo,
-- tiene que RECHAZARSE — y hoy no se rechaza. Va en un bloque `todo()`: se
-- reporta en rojo pero no rompe el fichero (rojo permitido).
-- =============================================================================

begin;
select plan(2);

insert into auth.users (id) values ('aaaa0075-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0075-0000-4000-8000-00000000000a', 'Tenant 75');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0075-0000-4000-8000-0000000000a2', 'aaaa0075-0000-4000-8000-00000000000a',
   'J-75-A', 'Empresa 75');
select set_config('ladino.actor_id', 'aaaa0075-0000-4000-8000-0000000000a1', true);

-- El rango de FACTURAS, serie A, 1-5000: el talonario normal de la empresa.
insert into public.fiscal_number_ranges
  (id, tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
values ('aaaa0075-0000-4000-8000-00000000e001', 'aaaa0075-0000-4000-8000-00000000000a',
        'aaaa0075-0000-4000-8000-0000000000a2', 'invoice', 'A', 1, 5000, 1,
        'Imprenta de prueba, autorización ficticia pgTAP 075');

-- Sanity: el rango de facturas quedó activo con las 5000 unidades disponibles.
select is(
  (select range_to - range_from + 1 from public.fiscal_number_ranges
    where id = 'aaaa0075-0000-4000-8000-00000000e001'),
  5000::bigint,
  'el rango de facturas se cargó tal cual: 5000 controles disponibles');

-- LA VARIANTE ROTA (G-01): un rango de NOTAS DE CRÉDITO, misma empresa, misma
-- serie, que se SOLAPA con el de facturas (1-500 cae dentro de 1-5000). En
-- forma libre ambos documentos consumirían controles ya usados por facturas:
-- la NC A-1 y la factura A-1 terminarían con el MISMO 00000001 impreso.
-- CONDUCTA FINAL decidida (sección 2.1): esto se RECHAZA — un solo
-- correlativo por emisor e identificador, sin importar la clase.
-- G-01 cerrado por 20260928160000_one_control_sequence_per_issuer.sql (ADR-0071):
-- el todo() se quitó sin tocar la aserción.
select throws_ok($$
  insert into public.fiscal_number_ranges
    (tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
  values ('aaaa0075-0000-4000-8000-00000000000a', 'aaaa0075-0000-4000-8000-0000000000a2',
          'credit_note', 'A', 1, 500, 1, 'Imprenta de prueba, autorización ficticia pgTAP 075')
$$, '23P01', null,
  'un rango de notas de crédito que se solapa con el de facturas se RECHAZA: un solo '
  'correlativo de control por emisor (PA 00071 art. 44), no una constraint por clase');

select * from finish();
rollback;

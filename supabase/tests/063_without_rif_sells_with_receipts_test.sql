-- =============================================================================
-- Ladino — pgTAP 63 · SIN RIF, RECIBOS (migración 63)
--
--   1. una empresa sin RIF (PEND-…) y sin régimen queda en `sin_facturacion`;
--   2. y su modo de venta pasa a ser «recibos»;
--   3. con su acta en la auditoría;
--   4. una empresa CON RIF y sin régimen no se toca (esa elige en Empezar);
--   5. una empresa sin RIF que YA tenía régimen no se toca;
--   6. idempotente: la segunda llamada no hace nada;
--   7. VARIANTE ROTA: sin la función, la empresa sin RIF queda en «ninguno».
-- =============================================================================

begin;
select plan(7);

insert into public.tenants (id, name) values
  ('aaaa0063-0000-4000-8000-00000000000a', 'Tenant 63');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0063-0000-4000-8000-0000000000a1', 'aaaa0063-0000-4000-8000-00000000000a',
   'PEND-0063A00001', 'Bodega sin RIF 63'),
  ('aaaa0063-0000-4000-8000-0000000000a2', 'aaaa0063-0000-4000-8000-00000000000a',
   'J-63-B', 'Empresa con RIF 63'),
  ('aaaa0063-0000-4000-8000-0000000000a3', 'aaaa0063-0000-4000-8000-00000000000a',
   'PEND-0063A00003', 'Sin RIF con régimen 63');

insert into public.company_fiscal_regimes (tenant_id, company_id, regime_code, effective_from)
values ('aaaa0063-0000-4000-8000-00000000000a', 'aaaa0063-0000-4000-8000-0000000000a3',
        'sin_emision', now() - interval '3 days');

-- VARIANTE ROTA primero: antes de aplicar la regla, la empresa sin RIF no sabe vender.
select is(
  platform.sales_mode_at('aaaa0063-0000-4000-8000-0000000000a1', now()),
  'ninguno',
  'VARIANTE ROTA: sin la regla, una empresa sin RIF ni régimen queda en «ninguno»');

select is(
  platform.assign_receipts_to_companies_without_rif() >= 1,
  true,
  'la regla toca al menos a la empresa sin RIF de esta prueba');

select is(
  (select regime_code from public.company_fiscal_regimes
    where company_id = 'aaaa0063-0000-4000-8000-0000000000a1' and effective_to is null),
  'sin_facturacion',
  'sin RIF y sin régimen: queda vendiendo con recibos');

select is(
  platform.sales_mode_at('aaaa0063-0000-4000-8000-0000000000a1', now() + interval '1 second'),
  'recibos',
  'y su modo de venta es «recibos»');

select is(
  (select count(*)::int from public.audit_events
    where company_id = 'aaaa0063-0000-4000-8000-0000000000a1'
      and event_type = 'fiscal.regime.assigned'
      and payload->>'origin' = 'migration_20260916150000'),
  1,
  'con su acta en la auditoría');

select is(
  (select count(*)::int from public.company_fiscal_regimes
    where company_id in ('aaaa0063-0000-4000-8000-0000000000a2',
                         'aaaa0063-0000-4000-8000-0000000000a3')
      and regime_code = 'sin_facturacion'),
  0,
  'no toca a la empresa con RIF ni a la que ya tenía régimen');

select is(
  platform.assign_receipts_to_companies_without_rif(),
  0,
  'idempotente: la segunda llamada no hace nada');

select * from finish();
rollback;

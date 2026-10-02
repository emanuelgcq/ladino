-- =============================================================================
-- Qué instrumento causa IGTF es DATA de plataforma con su fuente; el producto de sistema de la ND
-- por IGTF; la antigüedad de la cartera con el saldo único (revisión y auditoría fiscal de la ola 2
-- C2 sobre 20261002100000).
-- Módulo: ventas · IGTF   Spec: docs/02_COMPLIANCE/IGTF_SPEC.md
--
--   1. `igtf_instrument_classes` (global, sin tenant): la PA SNAT/2022/000013 art. 1 limita la
--      percepción del especial a los pagos en divisas o criptoactivos recibidos «sin mediación de
--      instituciones financieras». El efectivo en divisa y el cripto causan; Zelle causa por
--      criterio (lectura reversible: lo percibido de más se restituye); la transferencia, la
--      tarjeta y el punto de venta a través de un banco NO causan. VALIDAR-TRIBUTARIO P-66. La
--      empresa ya no clasifica (su `igtf_company_instruments` queda como historia, sin lector).
--   2. `products.system_code`: el producto de sistema de la línea de la ND por IGTF
--      (`system_code = 'igtf'`), uno por empresa, sembrado aquí para las existentes. Nunca sale en
--      el catálogo ni en la caja; se busca por la marca, no por el sku.
--   3. `platform.ar_aging`: parte de su definición viva (20260912120000) y usa
--      `platform.document_balance` en vez de su copia en línea «total − Σ cobros»: la ND por IGTF,
--      pagada por su percepción, salía como deuda en la cartera.
--
-- Reversibilidad, con datos vivos: SÍ. La tabla de clases se borra (y el dominio vuelve a la
-- regla anterior con su código); `system_code` se puede dejar (no la lee nadie más) o borrar tras
-- reasignar las líneas de las ND por IGTF; `ar_aging` vuelve a su definición de 20260912120000.
-- HOMOLOGATION_IMPACT: YES — cambia qué cobros perciben IGTF (PA SNAT/2022/000013 art. 1).
-- =============================================================================

-- ── 1. Qué instrumento causa: data con su fuente ─────────────────────────────
create table public.igtf_instrument_classes (
  instrument   text primary key,
  causes       boolean not null,
  legal_source text    not null,
  constraint iic_source_chk check (length(btrim(legal_source)) >= 10)
);
comment on table public.igtf_instrument_classes is
  'Qué forma de pago causa IGTF para un sujeto pasivo especial (PA SNAT/2022/000013 art. 1: pagos '
  'en divisas o criptoactivos «sin mediación de instituciones financieras»). Data de plataforma, '
  'con su fuente; la empresa no la cambia. VALIDAR-TRIBUTARIO P-66.';
alter table public.igtf_instrument_classes enable row level security;
alter table public.igtf_instrument_classes force row level security;
revoke all on public.igtf_instrument_classes from anon, authenticated, service_role;
grant select on public.igtf_instrument_classes to ladino_api, authenticated;
create policy iic_api_select on public.igtf_instrument_classes for select to ladino_api
  using (true);
create policy iic_select on public.igtf_instrument_classes for select to authenticated
  using (true);

insert into public.igtf_instrument_classes (instrument, causes, legal_source) values
  ('efectivo_usd', true,
   'PA SNAT/2022/000013 art. 1 (G.O. 42.339): pago en divisas sin mediación de instituciones financieras.'),
  ('usdt', true,
   'PA SNAT/2022/000013 art. 1 (G.O. 42.339): pago en criptoactivos sin mediación de instituciones financieras.'),
  ('zelle', true,
   'Decidido por criterio (ola 2 C2, 2026-10-02): lectura reversible, lo percibido de más se restituye. VALIDAR-TRIBUTARIO P-66: ¿Zelle es mediación de una institución financiera extranjera?'),
  ('transferencia', false,
   'PA SNAT/2022/000013 art. 1: con mediación de una institución financiera no percibe el SPE. VALIDAR-TRIBUTARIO P-66.'),
  ('tarjeta', false,
   'PA SNAT/2022/000013 art. 1: con mediación de una institución financiera no percibe el SPE. VALIDAR-TRIBUTARIO P-66.'),
  ('punto_venta', false,
   'PA SNAT/2022/000013 art. 1: con mediación de una institución financiera no percibe el SPE. VALIDAR-TRIBUTARIO P-66.'),
  ('efectivo_bs', false,
   'LIGTF art. 4: el pago en bolívares no es pago en divisas; no causa.'),
  ('pago_movil', false,
   'LIGTF art. 4: el pago móvil es en bolívares y por el sistema bancario; no causa.'),
  ('cashea', false,
   'Financiamiento en bolívares por un tercero: no es pago en divisas sin mediación. VALIDAR-TRIBUTARIO P-66.'),
  ('otro', false,
   'Sin clasificar: no se percibe sobre lo que no se sabe qué es; regístralo con su instrumento verdadero. VALIDAR-TRIBUTARIO P-66.');

-- ── 2. El producto de sistema de la ND por IGTF ──────────────────────────────
alter table public.products add column system_code text;
alter table public.products
  add constraint products_system_code_chk check (system_code is null or system_code in ('igtf'));
create unique index products_system_code_key on public.products (company_id, system_code)
  where system_code is not null;
comment on column public.products.system_code is
  'Producto de SISTEMA (no se vende ni sale en el catálogo): ''igtf'' es la línea de la Nota de '
  'Débito por IGTF (E-03). Se busca por esta marca, nunca por el sku.';

-- Para las empresas existentes. El sku lleva un sufijo propio: si la empresa ya usa un sku
-- parecido, no se reutiliza su producto (el sku es tecleable; la marca no).
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code, system_code)
select x.id, x.tenant_id, x.company_id, 'SIS-IGTF-' || substr(x.id::text, 1, 8),
       'IGTF sobre pagos en divisas', 'service', 'inactive', 'unidad', 'no_sujeto', 'igtf'
  from (select gen_random_uuid() as id, c.tenant_id, c.id as company_id
          from public.companies c) x
 where not exists (select 1 from public.products p
                    where p.company_id = x.company_id and p.system_code = 'igtf')
on conflict do nothing;

-- ── 3. La cartera con el saldo único ─────────────────────────────────────────
-- Parte de la definición de 20260912120000 (la última). Solo cambia el saldo.
create or replace function platform.ar_aging(
  p_company uuid, p_customer uuid default null,
  p_reference date default (now() at time zone 'America/Caracas')::date
)
returns table (
  customer_id uuid, bucket text, document_count bigint, amount numeric
)
language sql
stable
set search_path = ''
as $$
  with saldos as (
    select d.customer_id, d.id,
           (p_reference - platform.caracas_day(d.issued_at)) as dias,
           -- El saldo ÚNICO (20261002100000 §4): resta además la percepción que paga una ND por
           -- IGTF. La copia en línea «total − Σ cobros» la contaba como deuda.
           platform.document_balance(p_company, d.id) as saldo
      from public.documents d
     where d.company_id = p_company
       and d.kind in ('invoice', 'receipt', 'debit_note')
       and d.status in ('issued', 'paid')
       and (p_customer is null or d.customer_id = p_customer)
       and platform.caracas_day(d.issued_at) <= p_reference
  )
  select s.customer_id,
         case when s.dias <= 30 then '0-30'
              when s.dias <= 60 then '31-60'
              when s.dias <= 90 then '61-90'
              else '90+' end,
         count(*), sum(s.saldo)
    from saldos s
   where s.saldo > 0
   group by 1, 2
   order by 1, 2
$$;

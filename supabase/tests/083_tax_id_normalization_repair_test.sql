-- =============================================================================
-- 083 — la reparación P-02: el documento de identidad se guarda de una manera
--
-- platform.tax_id_normalization_repair() (migración 20260928170000):
--   · normaliza clientes, proveedores y empresas; PEND- y lo ya normalizado, intactos;
--   · deja un acta por fila cambiada, con el valor anterior y el nuevo;
--   · el ensayo en seco cuenta y no cambia nada;
--   · es idempotente: la segunda vez no cambia nada ni escribe actas;
--   · NO toca los snapshots de los documentos emitidos (regla 1);
--   · ante un duplicado, FALLA con la lista, y ese mensaje es SUYO: sin el chequeo, el único
--     del esquema también fallaría, pero con un 23505 que no dice cuáles (variante rota).
-- =============================================================================
begin;
select plan(18);

insert into public.tenants (id, name) values
  ('aaaa0083-0000-4000-8000-00000000000a', 'Tenant 83');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code) values
  ('aaaa0083-0000-4000-8000-0000000000a1', 'aaaa0083-0000-4000-8000-00000000000a',
   'j-40555123-4', 'Empresa 83 con guiones', 'VES'),
  ('aaaa0083-0000-4000-8000-0000000000a2', 'aaaa0083-0000-4000-8000-00000000000a',
   'PEND-0083AAAA00', 'Empresa 83 sin RIF', 'VES');
insert into public.customers
  (id, tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code)
values
  ('aaaa0083-0000-4000-8000-0000000000c1', 'aaaa0083-0000-4000-8000-00000000000a',
   'aaaa0083-0000-4000-8000-0000000000a1', 'J-40888777-6', 'Bodegón 83', 'juridica', 'ordinario'),
  ('aaaa0083-0000-4000-8000-0000000000c2', 'aaaa0083-0000-4000-8000-00000000000a',
   'aaaa0083-0000-4000-8000-0000000000a1', 'V18222333', 'Cliente limpio 83', 'natural',
   'consumidor_final');
insert into public.suppliers
  (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code, taxpayer_type_code)
values
  ('aaaa0083-0000-4000-8000-0000000000b1', 'aaaa0083-0000-4000-8000-00000000000a',
   'aaaa0083-0000-4000-8000-0000000000a1', 'J-40.555.999-1', 'Proveedor 83', 'nacional',
   'juridica', 'ordinario');

-- Un documento emitido con el snapshot del cliente en su grafía de ese día.
-- Desde 20260928190000 (ADR-0072) emitir exige el tipo de contribuyente declarado vigente.
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason, rules_version)
values ('aaaa0083-0000-4000-8000-00000000000a', 'aaaa0083-0000-4000-8000-0000000000a1', 'ordinario',
        '2026-01-01', null, 'Fixture pgTAP 83', 'test-083');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0083-0000-4000-8000-0000000000f1', 'aaaa0083-0000-4000-8000-00000000000a',
        'aaaa0083-0000-4000-8000-0000000000a1', 'formatos_libres', '2026-01-01');
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
   control_number, regime_version_id, rules_version,
   issuer_name_snapshot, issuer_tax_id_snapshot, issuer_address_snapshot,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0083-0000-4000-8000-0000000000d1', 'aaaa0083-0000-4000-8000-00000000000a',
        'aaaa0083-0000-4000-8000-0000000000a1', 'invoice', 'A',
        'aaaa0083-0000-4000-8000-0000000000c1', 'issued', now(), 1, 1,
        'aaaa0083-0000-4000-8000-0000000000f1', 'pgtap-083',
        'Empresa 83 con guiones', 'j-40555123-4', 'Calle 83, Valencia',
        'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116);
create temp table snap_antes as
  select customer_tax_id_snapshot, issuer_tax_id_snapshot
    from public.documents where id = 'aaaa0083-0000-4000-8000-0000000000d1';

-- ── 1. Ensayo en seco: cuenta, no cambia ────────────────────────────────────
-- Otras filas de la base local (semillas, E2E) pueden tener grafías sueltas: se mira solo lo
-- de este tenant por el dato, y que el ensayo diga ALGO por entidad.
select ok((select changed from platform.tax_id_normalization_repair(true)
            where entity = 'customers') >= 1,
          'el ensayo en seco cuenta al cliente con guiones');
select is((select tax_id from public.customers where id = 'aaaa0083-0000-4000-8000-0000000000c1'),
          'J-40888777-6', 'el ensayo en seco NO cambia el dato');

-- ── 2. La reparación ────────────────────────────────────────────────────────
select lives_ok($$ select * from platform.tax_id_normalization_repair() $$,
                'la reparación corre como dueño de la base');
select is((select tax_id from public.customers where id = 'aaaa0083-0000-4000-8000-0000000000c1'),
          'J408887776', 'el cliente queda normalizado');
select is((select tax_id from public.suppliers where id = 'aaaa0083-0000-4000-8000-0000000000b1'),
          'J405559991', 'el proveedor queda normalizado (puntos y guiones fuera)');
select is((select tax_id from public.companies where id = 'aaaa0083-0000-4000-8000-0000000000a1'),
          'J405551234', 'la empresa queda normalizada (y en mayúsculas)');
select is((select tax_id from public.companies where id = 'aaaa0083-0000-4000-8000-0000000000a2'),
          'PEND-0083AAAA00', 'el marcador PEND- no se toca');
select is((select tax_id from public.customers where id = 'aaaa0083-0000-4000-8000-0000000000c2'),
          'V18222333', 'lo ya normalizado no se toca');

-- ── 3. Un acta por fila cambiada, con el antes y el después ─────────────────
select is((select payload - 'reparacion' from public.audit_events
            where aggregate_id = 'aaaa0083-0000-4000-8000-0000000000c1'
              and event_type = 'customer.tax_id_normalized'),
          '{"from": "J-40888777-6", "to": "J408887776"}'::jsonb,
          'el cliente deja su acta con el valor anterior y el nuevo');
select is((select payload ->> 'from' from public.audit_events
            where aggregate_id = 'aaaa0083-0000-4000-8000-0000000000b1'
              and event_type = 'supplier.tax_id_normalized'),
          'J-40.555.999-1', 'el proveedor deja su acta (no tiene trigger propio: es la única)');
select is((select payload ->> 'to' from public.audit_events
            where aggregate_id = 'aaaa0083-0000-4000-8000-0000000000a1'
              and event_type = 'company.tax_id_normalized'),
          'J405551234', 'la empresa deja su acta');
select is((select count(*)::int from public.audit_events
            where aggregate_id = 'aaaa0083-0000-4000-8000-0000000000c2'
              and event_type = 'customer.tax_id_normalized'),
          0, 'lo que no cambió no deja acta');

-- ── 4. Idempotente ──────────────────────────────────────────────────────────
select is((select sum(changed)::int from platform.tax_id_normalization_repair()),
          0, 'la segunda vez no cambia nada');
select is((select count(*)::int from public.audit_events
            where tenant_id = 'aaaa0083-0000-4000-8000-00000000000a'
              and event_type like '%.tax_id_normalized'),
          3, 'ni escribe actas nuevas');

-- ── 5. Regla 1: el documento emitido conserva su grafía ─────────────────────
select is((select row(customer_tax_id_snapshot, issuer_tax_id_snapshot)::text
             from public.documents where id = 'aaaa0083-0000-4000-8000-0000000000d1'),
          (select row(customer_tax_id_snapshot, issuer_tax_id_snapshot)::text from snap_antes),
          'los snapshots del documento emitido no cambian');

-- ── 6. Duplicado: falla con la lista, y el mensaje es de la reparación ──────
-- Desde 20260928170100 el único normalizado de proveedores ya impide este duplicado: se retira
-- dentro de la transacción (el rollback lo restituye) para ejercer el chequeo de la reparación
-- sobre datos anteriores al índice, que es donde corre en producción.
drop index public.suppliers_company_tax_id_normalized_uidx;
insert into public.suppliers
  (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code, taxpayer_type_code)
values
  ('aaaa0083-0000-4000-8000-0000000000b2', 'aaaa0083-0000-4000-8000-00000000000a',
   'aaaa0083-0000-4000-8000-0000000000a1', 'J-31111111-0', 'Proveedor 83 dos', 'nacional',
   'juridica', 'ordinario'),
  ('aaaa0083-0000-4000-8000-0000000000b3', 'aaaa0083-0000-4000-8000-00000000000a',
   'aaaa0083-0000-4000-8000-0000000000a1', 'J.31111111.0', 'El mismo, con puntos', 'nacional',
   'juridica', 'ordinario');
select throws_like($$ select * from platform.tax_id_normalization_repair() $$,
  '%duplicados%proveedores en empresa aaaa0083-0000-4000-8000-0000000000a1: J-31111111-0 | J.31111111.0 → J311111110%',
  'un duplicado por normalizar FALLA con la lista de las formas y su normalizado');
select is((select count(*)::int from public.suppliers
            where company_id = 'aaaa0083-0000-4000-8000-0000000000a1'
              and tax_id in ('J-31111111-0', 'J.31111111.0')),
          2, 'y no cambió nada: los dos siguen como estaban');

-- VARIANTE ROTA: sin el chequeo (el UPDATE desnudo), el único del esquema también para, pero
-- con 23505 y sin la lista. Si esto no lanzara 23505, el throws_like de arriba podría estar
-- pasando por otro camino.
select throws_ok($$ update public.suppliers
                       set tax_id = upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g'))
                     where company_id = 'aaaa0083-0000-4000-8000-0000000000a1' $$,
  '23505', null, 'sin el chequeo, el mismo choque es un 23505 opaco: la lista es de la reparación');

select * from finish();
rollback;

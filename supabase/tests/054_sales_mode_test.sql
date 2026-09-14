-- =============================================================================
-- Ladino — pgTAP 54 · EL MODO DE VENTA COINCIDE CON EL TRIGGER (migración 54)
--
-- `platform.sales_mode_at` NO decide nada: resume lo que decide el trigger de
-- emisión. Este test lo prueba contra el trigger mismo, no contra una tabla de
-- expectativas escrita a mano: para CADA régimen sembrado (y para la empresa sin
-- régimen) intenta emitir una factura y un recibo, clasifica si el GATE DE KIND
-- los dejó pasar, y exige que la función diga lo mismo. Si un régimen nuevo se
-- siembra mañana, entra solo en la comparación.
--
-- Se clasifica «rechazado por el gate» solo con los tres mensajes LAD49 del gate
-- (sin régimen, kind no permitido, régimen que no emite). Un fallo POSTERIOR al
-- gate —p. ej. el número de control que exige formatos_libres— significa que el
-- kind SÍ pasó el gate: es lo que el modo de venta resume.
-- =============================================================================

begin;
select plan(5);

insert into public.tenants (id, name) values
  ('aaaa0054-0000-4000-8000-00000000000a', 'Tenant 54');

-- Una empresa por régimen sembrado, más una sin régimen.
create temporary table caso_54 (regime_code text, company_id uuid, customer_id uuid,
                                regime_version_id uuid) on commit drop;

do $$
declare
  v_r record;
  v_company uuid;
  v_customer uuid;
  v_version uuid;
  v_i int := 0;
begin
  for v_r in select code from public.fiscal_regimes order by code loop
    v_i := v_i + 1;
    v_company := gen_random_uuid();
    v_customer := gen_random_uuid();
    v_version := gen_random_uuid();
    insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code)
    values (v_company, 'aaaa0054-0000-4000-8000-00000000000a', 'T54-' || v_r.code,
            'Empresa 54 ' || v_r.code, 'ordinario');
    insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
    values (v_version, 'aaaa0054-0000-4000-8000-00000000000a', v_company, v_r.code, '2026-01-01');
    insert into public.customers (id, tenant_id, company_id, legal_name, person_type_code,
                                  taxpayer_type_code)
    values (v_customer, 'aaaa0054-0000-4000-8000-00000000000a', v_company, 'Cliente 54',
            'natural', 'consumidor_final');
    insert into pg_temp.caso_54 values (v_r.code, v_company, v_customer, v_version);
  end loop;

  v_company := gen_random_uuid();
  v_customer := gen_random_uuid();
  insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code)
  values (v_company, 'aaaa0054-0000-4000-8000-00000000000a', 'T54-SIN', 'Empresa 54 sin régimen',
          'ordinario');
  insert into public.customers (id, tenant_id, company_id, legal_name, person_type_code,
                                taxpayer_type_code)
  values (v_customer, 'aaaa0054-0000-4000-8000-00000000000a', v_company, 'Cliente 54',
          'natural', 'consumidor_final');
  insert into pg_temp.caso_54 values (null, v_company, v_customer, null);
end;
$$;

-- Intenta emitir un documento del kind dado y devuelve si el GATE lo dejó pasar.
create function pg_temp.gate_admite(p_company uuid, p_customer uuid, p_version uuid, p_kind text)
returns boolean
language plpgsql
as $$
begin
  insert into public.documents
    (tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
     regime_version_id, rules_version,
     transaction_currency, functional_currency, fx_rate, rate_source,
     amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
  values ('aaaa0054-0000-4000-8000-00000000000a', p_company, p_kind, 'T54', p_customer,
          'issued', now(), 1, p_version, 'test-054',
          'VES', 'VES', 1, 'identidad', 100, 100, 100, 0, 100);
  return true;
exception when others then
  return not (
    sqlstate = 'LAD49'
    and (sqlerrm like '%no tiene régimen fiscal vigente%'
         or sqlerrm like '%no emite documentos de tipo%'
         or sqlerrm like '%no permite emitir documentos%'));
end;
$$;

-- ── 1. La comparación con el trigger, régimen por régimen ────────────────────
select is_empty(
  $$
  select c.regime_code, platform.sales_mode_at(c.company_id, now()) as funcion,
         case
           when pg_temp.gate_admite(c.company_id, c.customer_id, c.regime_version_id, 'invoice')
             then 'facturas'
           when pg_temp.gate_admite(c.company_id, c.customer_id, c.regime_version_id, 'receipt')
             then 'recibos'
           else 'ninguno'
         end as trigger_dice
    from pg_temp.caso_54 c
  except
  select c.regime_code, platform.sales_mode_at(c.company_id, now()),
         platform.sales_mode_at(c.company_id, now())
    from pg_temp.caso_54 c
  $$,
  'sales_mode_at dice lo mismo que el trigger de emisión para CADA régimen sembrado y sin régimen');

-- ── 2-5. Los casos con nombre, para que el fallo se lea sin depurar ──────────
select is(platform.sales_mode_at(
            (select company_id from pg_temp.caso_54 where regime_code = 'sin_facturacion'), now()),
          'recibos', 'sin_facturacion vende con recibos');
select is(platform.sales_mode_at(
            (select company_id from pg_temp.caso_54 where regime_code = 'formatos_libres'), now()),
          'facturas', 'formatos_libres vende con facturas');
select is(platform.sales_mode_at(
            (select company_id from pg_temp.caso_54 where regime_code = 'sin_emision'), now()),
          'ninguno', 'sin_emision no vende documentos');
select is(platform.sales_mode_at(
            (select company_id from pg_temp.caso_54 where regime_code is null), now()),
          'ninguno', 'sin régimen vigente no vende documentos (hasta asignarlo)');

select * from finish();
rollback;

-- =============================================================================
-- Ladino — migración 26 · EL GANCHO: papeles que faltaban y presets de mapeo
--                          contable importables
--
-- Módulo: accounting  Spec: ADR-0041 (mapeo cerrado) · ADR-0042 (cola) ·
--                     ADR-0043 (catálogo global importable) · R-20 del handoff
-- Reversible: SÍ mientras no haya un asiento generado desde un preset.
-- Homologación: NO por sí sola — no cambia el cálculo de ningún documento.
--
-- POR QUÉ EXISTE. La migración 25 dejó la contabilidad montada y DESCONECTADA:
-- el esquema, el trigger de partida doble, la cola y la función que comprueba
-- la cobertura existían, y ningún módulo llamaba al generador. R-20. Esta
-- migración aporta las dos piezas de datos que faltaban para poder enchufarlo:
--
--   1. cuatro papeles contables que la lista de purposes no tenía;
--   2. un CATÁLOGO GLOBAL de presets de mapeo, importable por empresa, con la
--      misma forma y el mismo razonamiento que `chart_templates` (ADR-0043).
--
-- SOBRE LOS PRESETS, y esto es lo que evita que sean un atajo para los tests.
-- `journal_templates` es POR EMPRESA y no se puede sembrar en una migración:
-- las empresas todavía no existen. La alternativa era sembrar las plantillas
-- dentro de los E2E, y entonces «lo que hace que la contabilidad funcione»
-- viviría solo en los tests — el sistema real seguiría sin poder asentar nada.
-- Un catálogo global que se IMPORTA con un acto explícito resuelve las dos
-- cosas: los tests lo importan y una empresa de verdad también.
--
-- LO QUE ESTA MIGRACIÓN NO HACE:
--   · no crea NI UNA plantilla en `journal_templates`: sigue naciendo vacía
--     (ADR-0041). El preset es un catálogo del que copiar, no un default;
--   · no siembra `company_account_settings` de nadie: los papeles se asignan
--     al importar el plan de cuentas o a mano;
--   · no siembra plantilla para `purchase.goods_received`. Es deliberado y
--     tiene consecuencia: en este preset el inventario se capitaliza CONTRA LA
--     FACTURA, no contra la recepción. Una empresa que lleve «mercancía
--     recibida no facturada» necesita su propia plantilla y un papel que
--     todavía no existe. Dicho aquí para que no se descubra cuadrando.
-- =============================================================================

-- ── 1. Los papeles que faltaban ─────────────────────────────────────────────
insert into public.account_purposes (code, name, description) values
  -- Retenciones que NOS practican a nosotros como proveedor. El módulo de
  -- ventas todavía no las calcula; el papel existe para que el día que lo haga
  -- no haya que tocar el catálogo.
  ('retention_iva_receivable', 'Retención de IVA soportada',
   'IVA que un cliente nos retuvo y que se compensa contra el impuesto a pagar. Sin uso todavía: ventas no calcula retenciones recibidas. VALIDAR-TRIBUTARIO.'),
  ('retention_islr_receivable', 'Retención de ISLR soportada',
   'ISLR que un cliente nos retuvo, anticipo del impuesto del ejercicio. Sin uso todavía. VALIDAR-TRIBUTARIO.'),
  -- Retenciones que YA enteramos al fisco. Distintas de las «por pagar»: la
  -- deuda desaparece cuando se entera, y confundirlas deja el pasivo inflado.
  ('retention_iva_paid', 'Retención de IVA enterada',
   'IVA retenido a proveedores y ya enterado al fisco. VALIDAR-TRIBUTARIO.'),
  ('retention_islr_paid', 'Retención de ISLR enterada',
   'ISLR retenido a proveedores y ya enterado al fisco. VALIDAR-TRIBUTARIO.'),
  ('inventory_adjustment', 'Ajuste de inventario',
   'Contrapartida de los ajustes de existencias: faltantes, sobrantes y mermas. VALIDAR-CONTABLE.')
on conflict (code) do nothing;

-- Y sus cuentas en la plantilla `ve_basico`, para que el import las cubra.
insert into public.chart_template_accounts
  (template_code, code, name, parent_code, kind, nature, is_leaf, level, suggested_purpose)
values
  ('ve_basico', '1.1.07', 'Retención de IVA soportada',  '1.1', 'activo', 'deudora', true, 3,
   'retention_iva_receivable'),
  ('ve_basico', '1.1.08', 'Retención de ISLR soportada', '1.1', 'activo', 'deudora', true, 3,
   'retention_islr_receivable'),
  ('ve_basico', '2.1.05', 'Retención de IVA enterada',   '2.1', 'pasivo', 'acreedora', true, 3,
   'retention_iva_paid'),
  ('ve_basico', '2.1.06', 'Retención de ISLR enterada',  '2.1', 'pasivo', 'acreedora', true, 3,
   'retention_islr_paid'),
  ('ve_basico', '5.1.04', 'Ajuste de inventario',        '5.1', 'gasto',  'deudora', true, 3,
   'inventory_adjustment')
on conflict (template_code, code) do nothing;

-- ── 2. Catálogo GLOBAL de presets de mapeo contable ─────────────────────────
create table public.journal_template_presets (
  code         text primary key,
  name         text not null,
  description  text not null,
  legal_source text not null,
  status       text not null default 'active',
  constraint journal_template_presets_code_chk check (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint journal_template_presets_status_chk check (status in ('active', 'inactive'))
);
comment on table public.journal_template_presets is
  'Presets de mapeo contable, GLOBALES y de solo lectura (ADR-0043 aplicado al '
  'mapeo). `journal_templates` sigue naciendo vacía: esto es un catálogo del '
  'que copiar con un acto explícito, no un default.';

create table public.journal_template_preset_entries (
  id           uuid primary key default platform.uuidv7(),
  preset_code  text not null,
  source_kind  text not null,
  -- El evento del OUTBOX, con su nombre real. No se inventa uno nuevo: que la
  -- contabilidad y las notificaciones llamen igual al mismo hecho es lo que
  -- permite cruzarlas cuando algo no cuadra (ADR-0042 §Idempotencia).
  source_event text not null,
  description  text not null,
  constraint journal_template_preset_entries_preset_fk
    foreign key (preset_code) references public.journal_template_presets (code),
  constraint journal_template_preset_entries_kind_chk check (source_kind in (
    'sales_invoice', 'sales_credit_note', 'payment_received', 'purchase_invoice',
    'purchase_credit_note', 'payment_made', 'goods_receipt', 'inventory_move',
    'retention_receipt', 'landed_cost', 'landed_cost_variance', 'exchange_diff')),
  constraint journal_template_preset_entries_key unique (preset_code, source_kind, source_event)
);

create table public.journal_template_preset_lines (
  id              uuid    primary key default platform.uuidv7(),
  entry_id        uuid    not null,
  line_number     integer not null,
  account_purpose text    not null,
  amount_source   text    not null,
  side            text    not null,
  condition_kind  text    not null default 'always',
  description     text,
  constraint journal_template_preset_lines_entry_fk
    foreign key (entry_id) references public.journal_template_preset_entries (id),
  constraint journal_template_preset_lines_purpose_fk
    foreign key (account_purpose) references public.account_purposes (code),
  -- Los MISMOS enums cerrados que `journal_template_lines`. Si divergieran, un
  -- preset podría traer una forma que la tabla real no admite y el import
  -- fallaría a mitad, dejando media plantilla.
  constraint journal_template_preset_lines_amount_chk check (amount_source in (
    'subtotal', 'tax_amount', 'total', 'retained_iva', 'retained_islr',
    'retained_total', 'net_amount', 'cost_amount', 'landed_to_inventory',
    'landed_to_variance', 'exchange_difference', 'functional_amount')),
  constraint journal_template_preset_lines_side_chk check (side in ('debit', 'credit')),
  constraint journal_template_preset_lines_condition_chk check (condition_kind in (
    'always', 'if_amount_nonzero', 'if_tax_recoverable', 'if_tax_not_recoverable',
    'if_supplier_foreign', 'if_supplier_national', 'if_positive', 'if_negative')),
  constraint journal_template_preset_lines_key unique (entry_id, line_number)
);

-- ── 3. RLS y grants: catálogos globales de SOLO LECTURA ─────────────────────
do $$
declare t text;
begin
  foreach t in array array['journal_template_presets', 'journal_template_preset_entries',
                           'journal_template_preset_lines']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format($f$
      create policy %1$s_select on public.%1$I for select to authenticated, ladino_api
        using (true);
      create policy %1$s_insert on public.%1$I for insert to authenticated, ladino_api
        with check (false);
      create policy %1$s_update on public.%1$I for update to authenticated, ladino_api
        using (false);
      create policy %1$s_delete on public.%1$I for delete to authenticated, ladino_api
        using (false);
    $f$, t);
  end loop;
end $$;

revoke all on public.journal_template_presets, public.journal_template_preset_entries,
              public.journal_template_preset_lines
  from anon, authenticated, service_role, ladino_api, ladino_worker;
grant select on public.journal_template_presets, public.journal_template_preset_entries,
                public.journal_template_preset_lines
  to authenticated, ladino_api;

-- ── 4. El preset venezolano básico ──────────────────────────────────────────
-- VALIDAR-CONTABLE en cada línea de la descripción, y por la misma razón que
-- en ADR-0043: esto es un punto de partida reconocible, no una afirmación de
-- que sea el mapeo correcto de ninguna empresa.
insert into public.journal_template_presets (code, name, description, legal_source) values
  ('ve_basico', 'Mapeo básico venezolano',
   'VALIDAR-CONTABLE: mapeo de partida para los documentos que Ladino ya emite. NO es el mapeo correcto de ninguna empresa concreta; lo confirma un contador público antes de producción. El inventario se capitaliza contra la FACTURA de compra, no contra la recepción: una empresa que lleve «mercancía recibida no facturada» necesita su propia plantilla.',
   'VENEZUELA_ACCOUNTING_RULES.md §Principio de diseño y §Reglas que no se deben hard-code. No hay norma que fije un mapeo obligatorio.')
on conflict (code) do nothing;

do $$
declare
  v_entry uuid;
begin
  -- ── VENTA EMITIDA ────────────────────────────────────────────────────────
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'sales_invoice', 'fiscal.invoice.issued',
          'Venta emitida: cuentas por cobrar contra ingresos e IVA débito fiscal')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'ar_general',       'total',      'debit',  'always',
     'El cliente debe el total, impuesto incluido'),
    (v_entry, 2, 'income_general',   'subtotal',   'credit', 'always',
     'El ingreso es la base, SIN el impuesto: el IVA no es ingreso de la empresa'),
    (v_entry, 3, 'iva_debit_fiscal', 'tax_amount', 'credit', 'if_amount_nonzero',
     'El IVA repercutido es una deuda con el fisco, no un ingreso');

  -- ── COBRO DE VENTA ───────────────────────────────────────────────────────
  -- El diferencial cambiario se reconoce EXPLÍCITAMENTE y nunca se absorbe en
  -- el redondeo (invariante 5 de packages/accounting/CLAUDE.md). Por eso hay
  -- dos líneas condicionadas por signo en vez de una con importe con signo:
  -- una línea de asiento no lleva importes negativos.
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'payment_received', 'ar.payment_applied',
          'Cobro: efectivo contra cuentas por cobrar, con el diferencial cambiario aparte')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'cash_bs',       'functional_amount',   'debit',  'always',
     'Lo que entró en caja, convertido a la tasa DEL COBRO'),
    (v_entry, 2, 'ar_general',    'total',               'credit', 'always',
     'Lo que deja de deberse, a la tasa DE LA EMISIÓN'),
    (v_entry, 3, 'exchange_gain', 'exchange_difference', 'credit', 'if_positive',
     'Si la tasa subió, la diferencia es ganancia cambiaria'),
    (v_entry, 4, 'exchange_loss', 'exchange_difference', 'debit',  'if_negative',
     'Si bajó, es pérdida. Se reconoce, no se absorbe en el redondeo');

  -- ── FACTURA DE COMPRA ────────────────────────────────────────────────────
  -- El IVA es crédito fiscal o COSTO según el contribuyente de la empresa
  -- (ADR-0040 §7). Las dos ramas son excluyentes por construcción: sus
  -- condiciones son la una la negación de la otra.
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'purchase_invoice', 'ap.invoice_posted',
          'Compra: inventario e IVA crédito fiscal contra cuentas por pagar')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'inventory_general',  'subtotal',   'debit',  'if_tax_recoverable',
     'Contribuyente ordinario: al inventario va la base, sin el IVA'),
    (v_entry, 2, 'iva_credit_fiscal',  'tax_amount', 'debit',  'if_tax_recoverable',
     'y el IVA es crédito fiscal recuperable'),
    (v_entry, 3, 'inventory_general',  'total',      'debit',  'if_tax_not_recoverable',
     'Contribuyente formal: el IVA NO es recuperable y es parte del costo'),
    (v_entry, 4, 'ap_general',         'total',      'credit', 'always',
     'La deuda con el proveedor es el total en los dos casos');

  -- ── PAGO A PROVEEDOR ─────────────────────────────────────────────────────
  -- El BRUTO cancela la deuda; el NETO sale del banco; la diferencia es una
  -- deuda con el fisco, no con el proveedor.
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'payment_made', 'ap.payment_made',
          'Pago a proveedor: cuentas por pagar contra banco y retenciones por pagar')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'ap_general',              'total',         'debit',  'always',
     'Se cancela la deuda por el BRUTO'),
    (v_entry, 2, 'cash_bs',                 'net_amount',    'credit', 'always',
     'Del banco sale solo el neto'),
    (v_entry, 3, 'retention_iva_payable',   'retained_iva',  'credit', 'if_amount_nonzero',
     'Lo retenido de IVA se le debe al fisco, no al proveedor'),
    (v_entry, 4, 'retention_islr_payable',  'retained_islr', 'credit', 'if_amount_nonzero',
     'Y lo retenido de ISLR, igual');

  -- ── LANDED COST APLICADO ─────────────────────────────────────────────────
  -- ADR-0040 §6: lo que corresponde a lo que sigue en existencia revaloriza el
  -- inventario; lo de las unidades ya vendidas es VARIACIÓN, gasto del período.
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'landed_cost', 'purchase.landed_cost_applied',
          'Landed cost: inventario y variación de costo contra la cuenta transitoria')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'inventory_general',    'landed_to_inventory', 'debit',  'if_amount_nonzero',
     'La parte de lo que queda en existencia sí capitaliza'),
    (v_entry, 2, 'landed_cost_variance', 'landed_to_variance',  'debit',  'if_amount_nonzero',
     'La de lo ya vendido es gasto del período: prorratearla sobre lo que queda sería mentir'),
    (v_entry, 3, 'landed_cost_clearing', 'functional_amount',   'credit', 'always',
     'Contra la transitoria, que se salda cuando llegue la factura del gasto');

  -- ── AJUSTE DE INVENTARIO ─────────────────────────────────────────────────
  -- Un ajuste positivo capitaliza; uno negativo es gasto. Las dos direcciones
  -- con la misma plantilla, separadas por el signo.
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'inventory_move', 'stock.adjusted',
          'Ajuste de existencias: inventario contra la cuenta de ajuste')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'inventory_general',    'functional_amount', 'debit',  'if_positive',
     'Sobrante: entra valor al inventario'),
    (v_entry, 2, 'inventory_adjustment', 'functional_amount', 'credit', 'if_positive',
     'contra la cuenta de ajuste'),
    (v_entry, 3, 'inventory_adjustment', 'functional_amount', 'debit',  'if_negative',
     'Faltante o merma: es gasto del período'),
    (v_entry, 4, 'inventory_general',    'functional_amount', 'credit', 'if_negative',
     'y sale valor del inventario');
end $$;

-- ── 5. Lo que esta migración GARANTIZA sobre sí misma (LAD64) ───────────────
do $$
declare
  v_desc text;
begin
  if (select count(*) from public.journal_templates) <> 0 then
    raise exception 'LAD64: journal_templates sigue naciendo VACÍA (ADR-0041): el preset es un catálogo, no un default';
  end if;
  if (select count(*) from public.journal_template_presets
       where description not like '%VALIDAR-CONTABLE%') <> 0 then
    raise exception 'LAD64: hay un preset de mapeo sin marcar VALIDAR-CONTABLE';
  end if;
  if (select count(*) from public.journal_template_preset_entries where preset_code = 've_basico') < 6 then
    raise exception 'LAD64: el preset ve_basico no cubre los seis hechos contabilizables';
  end if;
  -- TODO papel usado por el preset tiene que EXISTIR en el catálogo, o el
  -- import fallaría a mitad y dejaría media plantilla. La FK ya lo impone;
  -- esto comprueba lo contrario, que no falte cobertura de cuenta en el plan.
  if exists (
    select 1 from public.journal_template_preset_lines l
     where not exists (select 1 from public.chart_template_accounts a
                        where a.template_code = 've_basico'
                          and a.suggested_purpose = l.account_purpose)
  ) then
    select string_agg(distinct l.account_purpose, ', ') into v_desc
      from public.journal_template_preset_lines l
     where not exists (select 1 from public.chart_template_accounts a
                        where a.template_code = 've_basico'
                          and a.suggested_purpose = l.account_purpose);
    raise exception
      'LAD64: el preset usa papeles que el plan ve_basico no cubre (%): importar los dos dejaría el mapeo sin cuenta y todo en la cola',
      v_desc;
  end if;
end $$;

-- ── 6. El enlace de vuelta cabe en un documento de compra confirmado ────────
-- `assert_purchase_doc_immutable()` rechazaba escribir `journal_entry_id`
-- después de asentar la factura, y con razón: no distingue un campo de enlace
-- de un importe. Pero el enlace bidireccional de ADR-0042 se carga POR
-- DEFINICIÓN después —el asiento no existe hasta que el documento existe— y
-- bloquearlo dejaba la factura de compra sin poder apuntar a su asiento.
--
-- Se añade a la lista de campos neutralizados, junto a los que ya estaban por
-- la misma razón (`posted_at`, `retention_total`). Lo que sigue sin poder
-- cambiar es todo lo demás: importes, proveedor, fechas y números.
create or replace function platform.assert_purchase_doc_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old text;
  v_new text;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old) ->> 'status';
    if v_old = 'draft' then return old; end if;
    raise exception 'un documento de compra confirmado no se borra: %.%', tg_table_schema, tg_table_name
      using errcode = 'LAD06';
  end if;

  v_old := to_jsonb(old) ->> 'status';
  v_new := to_jsonb(new) ->> 'status';
  if v_old = 'draft' then return new; end if;

  if to_jsonb(old) - 'status' - 'version' - 'annulled_at' - 'annul_reason'
     - 'applied_at' - 'closed_at' - 'close_reason' - 'posted_at' - 'retention_total'
     - 'journal_entry_id'
   <> to_jsonb(new) - 'status' - 'version' - 'annulled_at' - 'annul_reason'
     - 'applied_at' - 'closed_at' - 'close_reason' - 'posted_at' - 'retention_total'
     - 'journal_entry_id'
  then
    raise exception
      'un documento de compra confirmado no se edita (%.%): corrige con una nota de crédito o un documento nuevo',
      tg_table_schema, tg_table_name
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_purchase_doc_immutable() from public;

do $$
begin
  if (select pg_get_functiondef(p.oid) from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform' and p.proname = 'assert_purchase_doc_immutable')
     not like '%journal_entry_id%' then
    raise exception 'LAD64: el trigger de compras no admite el enlace al asiento y la factura no podría apuntarlo';
  end if;
end $$;

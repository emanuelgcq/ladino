-- =============================================================================
-- Ladino — migración 22 · COMPRAS: proveedores, ciclo de tres documentos,
--                          landed cost, retenciones y CxP
--
-- Módulo: purchases  Spec: ADR-0039 (retenciones) · ADR-0040 (compras y landed
--                    cost) · ADR-0020 (siete campos) · ADR-0006 (append-only) ·
--                    ADR-0034 (costeo) · PURCHASES_AND_AP_SPEC ·
--                    IMPORTS_PURCHASES_SPEC · SUPPLIERS_SPEC · RETENTIONS_SPEC
-- Reversible: SÍ mientras no haya recepciones confirmadas ni comprobantes de
--             retención emitidos. Con cualquiera de los dos dentro, NO: la
--             recepción movió kardex y el comprobante consumió correlativo.
-- Homologación: SÍ — comprobante de retención, libro de compras y crédito
--               fiscal. Nada se habilita sin retention_rules cargadas.
--
-- TABLAS PROPIAS, NO `documents` (ADR-0040 §1). La razón es un trigger, no una
-- preferencia: `assert_document_issuance()` valida NUESTRA numeración fiscal
-- contra el régimen, y una factura de proveedor la emite ÉL. Meterla ahí obliga
-- a exceptuar tres `kind` dentro de la función, y un trigger compartido con
-- casos especiales se aplica mal (la lección de S0.4). El coste es duplicación
-- de forma: visible y auditable, que es más de lo que se puede decir de un
-- trigger fiscal con agujeros.
--
-- LO QUE ESTA MIGRACIÓN NO HACE, y es deliberado:
--   · no siembra NI UN porcentaje de retención (ADR-0039): `retention_rules`
--     nace vacía y sin regla no se retiene. Siembra el VOCABULARIO de conceptos,
--     que no lleva números;
--   · no inventa la máscara de 14 caracteres del comprobante digital que exige
--     PA102: el correlativo se guarda como `bigint` y el formato queda
--     VALIDAR-SENIAT;
--   · no genera asientos contables. La VARIACIÓN de costo por landed cost tardío
--     se calcula y se persiste con su cuenta; postearla es del motor contable;
--   · no implementa requisiciones ni anticipos a proveedor: fuera de alcance,
--     declarado (los anticipos van con tesorería).
--
-- SOBRE EL COSTO, que es lo que puede corromper ventas. El costo funcional se
-- fija en la RECEPCIÓN, con los siete campos de ADR-0020 por línea. El landed
-- cost que llega DESPUÉS no se prorratea sobre lo que queda —eso encarecería
-- unidades que no incurrieron en ese costo y ensuciaría el margen de todas las
-- ventas siguientes—: la parte de lo aún en existencia revaloriza el inventario,
-- y la parte de lo ya vendido es VARIACIÓN DE COSTO, un gasto del período.
-- =============================================================================

-- ── 1. Proveedores ──────────────────────────────────────────────────────────
-- Espejo de `customers` (ADR-0033) con tres diferencias reales: el proveedor
-- puede ser EXTRANJERO y entonces no tiene RIF ni retención local; puede ser
-- sujeto de retención; y tiene cuentas bancarias, que los clientes no.
create table public.suppliers (
  id                 uuid        primary key default platform.uuidv7(),
  tenant_id          uuid        not null,
  company_id         uuid        not null,

  -- Sin formato (VALIDAR-SENIAT, OPEN_QUESTIONS 9): ningún regex de RIF.
  tax_id             text,
  legal_name         text        not null,
  trade_name         text,
  -- 'nacional' | 'extranjero'. No es cosmético: gobierna el CHECK del RIF y
  -- decide si se le practica retención local.
  supplier_kind      text        not null default 'nacional',
  person_type_code   text,
  taxpayer_type_code text,
  fiscal_address     text,
  email              text,
  phone              text,
  status             text        not null default 'active',
  -- Días de crédito acordados. Alimenta el aging; no calcula nada por sí solo.
  payment_terms_days integer     not null default 0,

  created_by         uuid,
  created_at         timestamptz not null,
  version            integer     not null,

  constraint suppliers_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint suppliers_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint suppliers_person_type_fk
    foreign key (person_type_code) references public.person_types (code),
  constraint suppliers_taxpayer_type_fk
    foreign key (taxpayer_type_code) references public.taxpayer_types (code),

  constraint suppliers_kind_chk check (supplier_kind in ('nacional', 'extranjero')),
  constraint suppliers_tax_id_chk
    check (tax_id is null or (tax_id = btrim(tax_id) and length(tax_id) between 1 and 30)),
  -- Un proveedor NACIONAL sin RIF no se puede pagar con retención ni llevar al
  -- libro de compras. Uno EXTRANJERO no tiene RIF y exigírselo sería inventarle
  -- una identidad fiscal venezolana.
  constraint suppliers_tax_id_required_chk
    check (supplier_kind = 'extranjero' or tax_id is not null),
  -- Y su simétrica: la clasificación fiscal venezolana solo aplica al nacional.
  constraint suppliers_foreign_shape_chk
    check (supplier_kind = 'nacional'
           or (taxpayer_type_code is null and person_type_code is null)),
  constraint suppliers_national_shape_chk
    check (supplier_kind = 'extranjero'
           or (taxpayer_type_code is not null and person_type_code is not null)),
  constraint suppliers_legal_name_chk
    check (legal_name = btrim(legal_name) and length(legal_name) between 1 and 200),
  constraint suppliers_trade_name_chk
    check (trade_name is null or (trade_name = btrim(trade_name) and length(trade_name) between 1 and 200)),
  constraint suppliers_fiscal_address_chk
    check (fiscal_address is null
           or (fiscal_address = btrim(fiscal_address) and length(fiscal_address) between 1 and 500)),
  constraint suppliers_email_chk
    check (email is null
           or (email = btrim(email) and length(email) between 3 and 254 and position('@' in email) > 1)),
  constraint suppliers_phone_chk
    check (phone is null or (phone = btrim(phone) and length(phone) between 3 and 40)),
  constraint suppliers_status_chk check (status in ('pending', 'active', 'blocked', 'inactive')),
  constraint suppliers_terms_chk check (payment_terms_days between 0 and 3650),
  constraint suppliers_company_id_key unique (company_id, id)
);
-- RIF único por empresa, case-insensitive, solo donde hay RIF: dos proveedores
-- con el mismo RIF son el mismo proveedor cargado dos veces.
create unique index suppliers_company_tax_id_key
  on public.suppliers (company_id, lower(tax_id)) where tax_id is not null;
create index suppliers_company_name_idx on public.suppliers (company_id, legal_name);
comment on table public.suppliers is
  'Proveedores. `supplier_kind` gobierna la forma fiscal: extranjero sin RIF y '
  'sin clasificación venezolana, nacional con ambos. El formato del RIF sigue '
  'VALIDAR-SENIAT: aquí no hay regex.';

create table public.supplier_bank_accounts (
  id              uuid        primary key default platform.uuidv7(),
  tenant_id       uuid        not null,
  company_id      uuid        not null,
  supplier_id     uuid        not null,
  bank_name       text        not null,
  account_number  text        not null,
  account_currency text       not null,
  account_holder  text,
  -- SUPPLIERS_SPEC: «cuenta bancaria requiere aprobación si se usa para pagos».
  -- Se modela como estado, y pagar exige `approved`. Cambiarla queda auditado
  -- por el evento supplier.bank_account_changed que emite el caso de uso.
  status          text        not null default 'pending',
  approved_by     uuid,
  approved_at     timestamptz,

  created_by      uuid,
  created_at      timestamptz not null,
  version         integer     not null,

  constraint supplier_bank_accounts_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint supplier_bank_accounts_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint supplier_bank_accounts_supplier_fk
    foreign key (company_id, supplier_id) references public.suppliers (company_id, id),
  constraint supplier_bank_accounts_currency_fk
    foreign key (account_currency) references public.currencies (code),
  constraint supplier_bank_accounts_bank_chk
    check (bank_name = btrim(bank_name) and length(bank_name) between 1 and 120),
  constraint supplier_bank_accounts_number_chk
    check (account_number = btrim(account_number) and length(account_number) between 4 and 60),
  constraint supplier_bank_accounts_status_chk
    check (status in ('pending', 'approved', 'rejected', 'inactive')),
  constraint supplier_bank_accounts_approval_chk
    check ((status = 'approved') = (approved_at is not null and approved_by is not null)),
  constraint supplier_bank_accounts_company_id_key unique (company_id, id)
);
create index supplier_bank_accounts_supplier_idx
  on public.supplier_bank_accounts (company_id, supplier_id);

-- ── 2. Vocabulario de retenciones (SIN números) ─────────────────────────────
-- Los conceptos existen; los porcentajes NO. ADR-0039: el vocabulario no es una
-- obligación legal, el porcentaje sí.
create table public.retention_concepts (
  code            text        primary key,
  retention_code  text        not null,
  name            text        not null,
  description     text        not null,
  status          text        not null default 'active',
  constraint retention_concepts_code_chk check (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint retention_concepts_retention_chk check (retention_code in ('iva', 'islr')),
  constraint retention_concepts_status_chk check (status in ('active', 'inactive'))
);
comment on table public.retention_concepts is
  'Conceptos de retención (vocabulario). NO lleva porcentajes: esos viven en '
  'retention_rules con su fuente legal y nacen vacíos (ADR-0039).';

create table public.retention_rules (
  id                   uuid          primary key default platform.uuidv7(),
  -- Global, no por company: una retención es de la jurisdicción. Misma
  -- excepción declarada que `tax_rules` y `permissions` (ADR-0025 §3).
  jurisdiction         text          not null,
  retention_code       text          not null,
  concept_code         text          not null,
  -- Ejes de aplicación. NULL = «cualquiera», y por eso hay `priority`.
  taxpayer_type        text,
  supplier_person_type text,

  -- ADR-0039 §3: vocabulario CERRADO. `formula_kind` no es una expresión que
  -- alguien evalúe en runtime — un evaluador aquí sería ejecución arbitraria
  -- alimentada por una tabla de configuración, dentro del motor tributario.
  formula_kind         text          not null,
  rate                 numeric(24,8) not null,
  subtrahend           numeric(24,8),
  minimum_exempt       numeric(24,8),

  effective_from       date          not null,
  effective_to         date,
  -- §2 aplicado: una regla sin norma citada es una retención inventada, y esta
  -- se le QUITA a un tercero y se entera al fisco en nombre de él.
  legal_source         text          not null,
  priority             integer       not null default 100,
  status               text          not null default 'active',

  created_by           uuid,
  created_at           timestamptz   not null,
  version              integer       not null default 1,

  constraint retention_rules_concept_fk
    foreign key (concept_code) references public.retention_concepts (code),
  constraint retention_rules_taxpayer_fk
    foreign key (taxpayer_type) references public.taxpayer_types (code),
  constraint retention_rules_person_fk
    foreign key (supplier_person_type) references public.person_types (code),
  constraint retention_rules_jurisdiction_chk
    check (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,10})?$'),
  constraint retention_rules_code_chk check (retention_code in ('iva', 'islr')),
  constraint retention_rules_formula_chk
    check (formula_kind in ('rate', 'rate_minus_subtrahend')),
  -- Una regla con parámetros que su fórmula no usa es una regla que alguien
  -- entendió mal. Se rechaza al insertarla, no al calcular.
  constraint retention_rules_rate_shape_chk
    check (formula_kind <> 'rate' or (subtrahend is null and minimum_exempt is null)),
  constraint retention_rules_subtrahend_shape_chk
    check (formula_kind <> 'rate_minus_subtrahend' or subtrahend is not null),
  constraint retention_rules_rate_range_chk check (rate >= 0 and rate <= 1),
  constraint retention_rules_subtrahend_chk check (subtrahend is null or subtrahend >= 0),
  constraint retention_rules_minimum_chk check (minimum_exempt is null or minimum_exempt >= 0),
  constraint retention_rules_period_chk
    check (effective_to is null or effective_to > effective_from),
  constraint retention_rules_legal_source_chk
    check (length(btrim(legal_source)) between 3 and 300),
  constraint retention_rules_status_chk check (status in ('active', 'inactive'))
);
create index retention_rules_lookup_idx
  on public.retention_rules (jurisdiction, retention_code, concept_code, effective_from desc)
  where status = 'active';
comment on table public.retention_rules is
  'Reglas de retención con vigencia y fuente legal. NACE VACÍA (ADR-0039): sin '
  'regla no se retiene, y resolve_retention() FALLA en vez de devolver cero — '
  'un cero silencioso deja pasar el pago completo y la empresa queda debiendo '
  'al fisco una retención que nunca practicó.';

-- ── 3. Configuración de compras por empresa ─────────────────────────────────
create table public.purchase_settings (
  company_id           uuid          primary key,
  tenant_id            uuid          not null,
  -- La ÚNICA política de compras que es configuración (ADR-0040 §8). El resto
  -- son reglas. Se aplica al PRECIO UNITARIO por línea; la cantidad no lleva
  -- tolerancia, porque una diferencia de cantidad no es un redondeo.
  price_tolerance_pct  numeric(24,8) not null default 5,
  created_by           uuid,
  created_at           timestamptz   not null,
  version              integer       not null,
  constraint purchase_settings_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint purchase_settings_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint purchase_settings_tolerance_chk
    check (price_tolerance_pct >= 0 and price_tolerance_pct <= 100)
);

-- ── 4. Órdenes de compra ────────────────────────────────────────────────────
create table public.purchase_orders (
  id             uuid        primary key default platform.uuidv7(),
  tenant_id      uuid        not null,
  company_id     uuid        not null,
  branch_id      uuid,
  supplier_id    uuid        not null,
  -- Correlativo INTERNO: una orden de compra no es documento fiscal y su número
  -- no lo autoriza nadie. Se numera para poder hablar de ella, nada más.
  order_number   bigint,
  -- Almacén al que se espera la mercancía. La recepción puede cambiarlo.
  warehouse_id   uuid        not null,
  status         text        not null default 'draft',
  ordered_at     timestamptz,
  expected_at    date,
  closed_at      timestamptz,
  close_reason   text,

  -- Los siete campos de ADR-0020 al pie. La moneda es la del PROVEEDOR.
  amount_transaction_currency numeric(24,8) not null default 0,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null default 1,
  functional_amount           numeric(24,8) not null default 0,
  functional_currency         text          not null,
  rate_source                 text          not null default 'identidad',
  rate_timestamp              timestamptz   not null default now(),
  rounding_policy_id          text          not null default 'purchases:document:8:HALF_UP',

  notes          text,
  created_by     uuid,
  created_at     timestamptz not null,
  version        integer     not null,

  constraint purchase_orders_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint purchase_orders_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint purchase_orders_branch_fk
    foreign key (company_id, branch_id) references public.branches (company_id, id),
  constraint purchase_orders_supplier_fk
    foreign key (company_id, supplier_id) references public.suppliers (company_id, id),
  constraint purchase_orders_warehouse_fk
    foreign key (company_id, warehouse_id) references public.warehouses (company_id, id),
  constraint purchase_orders_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint purchase_orders_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  -- ADR-0040 §3: `draft` y `closed` son actos; `pending`/`partial`/`complete`
  -- los DERIVA purchase_order_progress() de lo recibido. Se guardan como estado
  -- alcanzado para poder consultarlos sin recorrer recepciones, pero la verdad
  -- está en las recepciones y hay un test que compara las dos.
  constraint purchase_orders_status_chk
    check (status in ('draft', 'pending', 'partial', 'complete', 'closed', 'cancelled')),
  constraint purchase_orders_ordered_shape_chk
    check ((status = 'draft') = (ordered_at is null)),
  constraint purchase_orders_closed_chk
    check ((status = 'closed') = (closed_at is not null)),
  constraint purchase_orders_number_shape_chk
    check ((status = 'draft') = (order_number is null)),
  constraint purchase_orders_fx_chk check (fx_rate > 0),
  constraint purchase_orders_company_id_key unique (company_id, id)
);
create unique index purchase_orders_number_key
  on public.purchase_orders (company_id, order_number) where order_number is not null;
create index purchase_orders_supplier_idx
  on public.purchase_orders (company_id, supplier_id, ordered_at desc);

create table public.purchase_order_lines (
  id                uuid          primary key default platform.uuidv7(),
  tenant_id         uuid          not null,
  company_id        uuid          not null,
  purchase_order_id uuid          not null,
  line_number       integer       not null,
  product_id        uuid          not null,
  description       text          not null,
  quantity          numeric(24,8) not null,
  unit_price_transaction numeric(24,8) not null,
  unit_price_functional  numeric(24,8) not null,
  line_total_transaction numeric(24,8) not null,
  line_total_functional  numeric(24,8) not null,
  -- Peso unitario para el prorrateo `by_weight`. Nullable: no todo producto lo
  -- tiene, y por eso el prorrateo por peso FALLA si falta (LAD55) en vez de
  -- repartir el flete solo entre lo que sí pesa.
  unit_weight       numeric(24,8),

  amount_transaction_currency numeric(24,8) not null,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null,
  functional_amount           numeric(24,8) not null,
  functional_currency         text          not null,
  rate_source                 text          not null,
  rate_timestamp              timestamptz   not null,
  rounding_policy_id          text          not null,

  created_by        uuid,
  created_at        timestamptz   not null,
  version           integer       not null,

  constraint purchase_order_lines_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint purchase_order_lines_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint purchase_order_lines_order_fk
    foreign key (company_id, purchase_order_id) references public.purchase_orders (company_id, id),
  constraint purchase_order_lines_product_fk
    foreign key (company_id, product_id) references public.products (company_id, id),
  constraint purchase_order_lines_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint purchase_order_lines_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint purchase_order_lines_quantity_chk check (quantity > 0),
  constraint purchase_order_lines_price_chk check (unit_price_transaction >= 0),
  constraint purchase_order_lines_weight_chk check (unit_weight is null or unit_weight > 0),
  constraint purchase_order_lines_fx_chk check (fx_rate > 0),
  constraint purchase_order_lines_number_key unique (purchase_order_id, line_number),
  constraint purchase_order_lines_company_id_key unique (company_id, id)
);

-- ── 5. Recepciones de mercancía ─────────────────────────────────────────────
-- El documento que MUEVE STOCK y fija el COSTO. Independiente de la factura:
-- la mercancía entra cuando entra, no cuando llega el papel.
create table public.goods_receipts (
  id                uuid        primary key default platform.uuidv7(),
  tenant_id         uuid        not null,
  company_id        uuid        not null,
  supplier_id       uuid        not null,
  -- Nullable: se admite recepción SIN orden (caso límite de la spec). Cuando la
  -- hay, el matching de tres vías la usa.
  purchase_order_id uuid,
  warehouse_id      uuid        not null,
  receipt_number    bigint,
  status            text        not null default 'draft',
  received_at       timestamptz,
  -- Guía o remisión con la que llegó la mercancía. Texto del proveedor.
  delivery_note_ref text,

  -- ADR-0040 §4: la tasa es la VIGENTE A LA FECHA DE LA RECEPCIÓN, no de la
  -- orden ni de la factura. Es cuando el inventario incorpora costo.
  amount_transaction_currency numeric(24,8) not null default 0,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null default 1,
  functional_amount           numeric(24,8) not null default 0,
  functional_currency         text          not null,
  rate_source                 text          not null default 'identidad',
  rate_timestamp              timestamptz   not null default now(),
  rounding_policy_id          text          not null default 'purchases:document:8:HALF_UP',

  notes             text,
  created_by        uuid,
  created_at        timestamptz not null,
  version           integer     not null,

  constraint goods_receipts_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint goods_receipts_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint goods_receipts_supplier_fk
    foreign key (company_id, supplier_id) references public.suppliers (company_id, id),
  constraint goods_receipts_order_fk
    foreign key (company_id, purchase_order_id) references public.purchase_orders (company_id, id),
  constraint goods_receipts_warehouse_fk
    foreign key (company_id, warehouse_id) references public.warehouses (company_id, id),
  constraint goods_receipts_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint goods_receipts_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint goods_receipts_status_chk check (status in ('draft', 'confirmed', 'cancelled')),
  constraint goods_receipts_confirmed_chk
    check ((status = 'confirmed') = (received_at is not null)),
  constraint goods_receipts_number_shape_chk
    check ((status = 'confirmed') = (receipt_number is not null)),
  constraint goods_receipts_fx_chk check (fx_rate > 0),
  constraint goods_receipts_company_id_key unique (company_id, id)
);
create unique index goods_receipts_number_key
  on public.goods_receipts (company_id, receipt_number) where receipt_number is not null;
create index goods_receipts_order_idx
  on public.goods_receipts (company_id, purchase_order_id) where purchase_order_id is not null;

create table public.goods_receipt_lines (
  id                     uuid          primary key default platform.uuidv7(),
  tenant_id              uuid          not null,
  company_id             uuid          not null,
  goods_receipt_id       uuid          not null,
  line_number            integer       not null,
  -- La línea de la orden que satisface, si la hay. Es lo que hace posible la
  -- recepción PARCIAL: se recibe contra la línea, no contra la orden.
  purchase_order_line_id uuid,
  product_id             uuid          not null,
  lot_id                 uuid,
  quantity               numeric(24,8) not null,
  unit_price_transaction numeric(24,8) not null,
  -- Costo unitario funcional ANTES de landed cost. Es lo que entra al kardex en
  -- el momento de la recepción.
  unit_cost_functional   numeric(24,8) not null,
  -- Landed cost YA aplicado a esta línea, acumulado. Se actualiza al aplicar un
  -- gasto; el histórico está en landed_cost_allocations.
  landed_cost_functional numeric(24,8) not null default 0,
  unit_weight            numeric(24,8),

  amount_transaction_currency numeric(24,8) not null,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null,
  functional_amount           numeric(24,8) not null,
  functional_currency         text          not null,
  rate_source                 text          not null,
  rate_timestamp              timestamptz   not null,
  rounding_policy_id          text          not null,

  created_by             uuid,
  created_at             timestamptz   not null,
  version                integer       not null,

  constraint goods_receipt_lines_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint goods_receipt_lines_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint goods_receipt_lines_receipt_fk
    foreign key (company_id, goods_receipt_id) references public.goods_receipts (company_id, id),
  constraint goods_receipt_lines_order_line_fk
    foreign key (company_id, purchase_order_line_id)
    references public.purchase_order_lines (company_id, id),
  constraint goods_receipt_lines_product_fk
    foreign key (company_id, product_id) references public.products (company_id, id),
  constraint goods_receipt_lines_lot_fk
    foreign key (company_id, lot_id) references public.lots (company_id, id),
  constraint goods_receipt_lines_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint goods_receipt_lines_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint goods_receipt_lines_quantity_chk check (quantity > 0),
  constraint goods_receipt_lines_cost_chk
    check (unit_cost_functional >= 0 and landed_cost_functional >= 0),
  constraint goods_receipt_lines_weight_chk check (unit_weight is null or unit_weight > 0),
  constraint goods_receipt_lines_fx_chk check (fx_rate > 0),
  constraint goods_receipt_lines_number_key unique (goods_receipt_id, line_number),
  constraint goods_receipt_lines_company_id_key unique (company_id, id)
);
create index goods_receipt_lines_order_line_idx
  on public.goods_receipt_lines (company_id, purchase_order_line_id)
  where purchase_order_line_id is not null;

-- ── 6. Facturas del proveedor ───────────────────────────────────────────────
create table public.supplier_invoices (
  id                uuid        primary key default platform.uuidv7(),
  tenant_id         uuid        not null,
  company_id        uuid        not null,
  supplier_id       uuid        not null,
  purchase_order_id uuid,

  -- ADR-0040 §2: el correlativo y el número de control son DEL PROVEEDOR y van
  -- como TEXTO. Normalizarlos a bigint sería reinterpretar el documento de un
  -- tercero; van al libro de compras tal como él los emitió.
  supplier_document_number text not null,
  supplier_control_number  text,
  -- Para el extranjero, que no tiene número de control venezolano: su invoice,
  -- su B/L, lo que traiga.
  supplier_document_ref    text,
  invoice_date      date        not null,
  due_date          date,
  status            text        not null default 'draft',
  posted_at         timestamptz,

  -- Bases y totales, en moneda de transacción y funcional.
  subtotal_amount   numeric(24,8) not null default 0,
  tax_amount        numeric(24,8) not null default 0,
  total_amount      numeric(24,8) not null default 0,
  -- ADR-0040 §7: para contribuyente ORDINARIO el IVA es crédito fiscal y NO es
  -- costo; para FORMAL sí lo es. Se deriva del taxpayer_type de la EMPRESA, no
  -- se configura. VALIDAR-TRIBUTARIO.
  tax_is_recoverable boolean    not null,
  retention_total   numeric(24,8) not null default 0,

  amount_transaction_currency numeric(24,8) not null default 0,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null default 1,
  functional_amount           numeric(24,8) not null default 0,
  functional_currency         text          not null,
  rate_source                 text          not null default 'identidad',
  rate_timestamp              timestamptz   not null default now(),
  rounding_policy_id          text          not null default 'purchases:document:8:HALF_UP',

  rules_version     text,
  notes             text,
  created_by        uuid,
  created_at        timestamptz not null,
  version           integer     not null,

  constraint supplier_invoices_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint supplier_invoices_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint supplier_invoices_supplier_fk
    foreign key (company_id, supplier_id) references public.suppliers (company_id, id),
  constraint supplier_invoices_order_fk
    foreign key (company_id, purchase_order_id) references public.purchase_orders (company_id, id),
  constraint supplier_invoices_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint supplier_invoices_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint supplier_invoices_doc_number_chk
    check (supplier_document_number = btrim(supplier_document_number)
           and length(supplier_document_number) between 1 and 60),
  -- O número de control (nacional) o referencia de documento origen
  -- (extranjero). Nunca ninguno de los dos: una factura de compra sin ninguna
  -- identificación del emisor no es asentable en el libro.
  constraint supplier_invoices_identification_chk
    check (supplier_control_number is not null or supplier_document_ref is not null),
  constraint supplier_invoices_status_chk
    check (status in ('draft', 'posted', 'paid', 'annulled')),
  constraint supplier_invoices_posted_chk
    check ((status in ('posted', 'paid', 'annulled')) = (posted_at is not null)),
  constraint supplier_invoices_amounts_chk
    check (subtotal_amount >= 0 and tax_amount >= 0 and total_amount >= 0
           and total_amount = subtotal_amount + tax_amount
           and retention_total >= 0),
  constraint supplier_invoices_due_chk check (due_date is null or due_date >= invoice_date),
  constraint supplier_invoices_fx_chk check (fx_rate > 0),
  constraint supplier_invoices_company_id_key unique (company_id, id)
);
-- El mismo documento del mismo proveedor no se carga dos veces. Es la defensa
-- real contra el doble pago, y va en la base porque un chequeo en el caso de
-- uso pierde la carrera contra dos operadores cargando a la vez.
create unique index supplier_invoices_supplier_doc_key
  on public.supplier_invoices (company_id, supplier_id, lower(supplier_document_number));
create index supplier_invoices_supplier_idx
  on public.supplier_invoices (company_id, supplier_id, invoice_date desc);

create table public.supplier_invoice_lines (
  id                     uuid          primary key default platform.uuidv7(),
  tenant_id              uuid          not null,
  company_id             uuid          not null,
  supplier_invoice_id    uuid          not null,
  line_number            integer       not null,
  -- La recepción que factura, si la hay. Es el tercer vértice del matching.
  goods_receipt_line_id  uuid,
  product_id             uuid          not null,
  description            text          not null,
  quantity               numeric(24,8) not null,
  unit_price_transaction numeric(24,8) not null,
  unit_price_functional  numeric(24,8) not null,
  tax_rule_id            uuid,
  tax_rate_snapshot      numeric(24,8) not null default 0,
  tax_amount             numeric(24,8) not null default 0,
  line_subtotal_transaction numeric(24,8) not null,
  line_total_transaction    numeric(24,8) not null,

  amount_transaction_currency numeric(24,8) not null,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null,
  functional_amount           numeric(24,8) not null,
  functional_currency         text          not null,
  rate_source                 text          not null,
  rate_timestamp              timestamptz   not null,
  rounding_policy_id          text          not null,

  created_by             uuid,
  created_at             timestamptz   not null,
  version                integer       not null,

  constraint supplier_invoice_lines_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint supplier_invoice_lines_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint supplier_invoice_lines_invoice_fk
    foreign key (company_id, supplier_invoice_id)
    references public.supplier_invoices (company_id, id),
  constraint supplier_invoice_lines_receipt_line_fk
    foreign key (company_id, goods_receipt_line_id)
    references public.goods_receipt_lines (company_id, id),
  constraint supplier_invoice_lines_product_fk
    foreign key (company_id, product_id) references public.products (company_id, id),
  constraint supplier_invoice_lines_tax_rule_fk
    foreign key (tax_rule_id) references public.tax_rules (id),
  constraint supplier_invoice_lines_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint supplier_invoice_lines_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint supplier_invoice_lines_quantity_chk check (quantity > 0),
  constraint supplier_invoice_lines_price_chk check (unit_price_transaction >= 0),
  constraint supplier_invoice_lines_rate_chk
    check (tax_rate_snapshot >= 0 and tax_rate_snapshot <= 1),
  constraint supplier_invoice_lines_totals_chk
    check (line_total_transaction = line_subtotal_transaction + tax_amount
           and line_subtotal_transaction >= 0),
  constraint supplier_invoice_lines_fx_chk check (fx_rate > 0),
  constraint supplier_invoice_lines_number_key unique (supplier_invoice_id, line_number),
  constraint supplier_invoice_lines_company_id_key unique (company_id, id)
);

-- ── 7. Notas de crédito RECIBIDAS ───────────────────────────────────────────
-- El patrón de devoluciones en ventas, invertido: el proveedor nos abona.
create table public.supplier_credit_notes (
  id                  uuid        primary key default platform.uuidv7(),
  tenant_id           uuid        not null,
  company_id          uuid        not null,
  supplier_id         uuid        not null,
  -- Obligatoria: no hay abono sin factura que abonar. Igual que en ventas no
  -- hay devolución sin documento origen.
  supplier_invoice_id uuid        not null,
  supplier_document_number text   not null,
  supplier_control_number  text,
  supplier_document_ref    text,
  note_date           date        not null,
  status              text        not null default 'draft',
  posted_at           timestamptz,
  reason              text        not null,

  subtotal_amount     numeric(24,8) not null default 0,
  tax_amount          numeric(24,8) not null default 0,
  total_amount        numeric(24,8) not null default 0,

  amount_transaction_currency numeric(24,8) not null default 0,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null default 1,
  functional_amount           numeric(24,8) not null default 0,
  functional_currency         text          not null,
  rate_source                 text          not null default 'identidad',
  rate_timestamp              timestamptz   not null default now(),
  rounding_policy_id          text          not null default 'purchases:document:8:HALF_UP',

  created_by          uuid,
  created_at          timestamptz not null,
  version             integer     not null,

  constraint supplier_credit_notes_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint supplier_credit_notes_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint supplier_credit_notes_supplier_fk
    foreign key (company_id, supplier_id) references public.suppliers (company_id, id),
  constraint supplier_credit_notes_invoice_fk
    foreign key (company_id, supplier_invoice_id)
    references public.supplier_invoices (company_id, id),
  constraint supplier_credit_notes_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint supplier_credit_notes_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint supplier_credit_notes_identification_chk
    check (supplier_control_number is not null or supplier_document_ref is not null),
  constraint supplier_credit_notes_status_chk check (status in ('draft', 'posted', 'annulled')),
  constraint supplier_credit_notes_posted_chk
    check ((status in ('posted', 'annulled')) = (posted_at is not null)),
  constraint supplier_credit_notes_amounts_chk
    check (subtotal_amount >= 0 and tax_amount >= 0 and total_amount >= 0
           and total_amount = subtotal_amount + tax_amount),
  constraint supplier_credit_notes_reason_chk check (length(btrim(reason)) >= 3),
  constraint supplier_credit_notes_fx_chk check (fx_rate > 0),
  constraint supplier_credit_notes_company_id_key unique (company_id, id)
);
create unique index supplier_credit_notes_doc_key
  on public.supplier_credit_notes (company_id, supplier_id, lower(supplier_document_number));

create table public.supplier_credit_note_lines (
  id                       uuid          primary key default platform.uuidv7(),
  tenant_id                uuid          not null,
  company_id               uuid          not null,
  supplier_credit_note_id  uuid          not null,
  line_number              integer       not null,
  supplier_invoice_line_id uuid,
  product_id               uuid          not null,
  description              text          not null,
  quantity                 numeric(24,8) not null,
  unit_price_transaction   numeric(24,8) not null,
  tax_amount               numeric(24,8) not null default 0,
  line_subtotal_transaction numeric(24,8) not null,
  line_total_transaction    numeric(24,8) not null,

  amount_transaction_currency numeric(24,8) not null,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null,
  functional_amount           numeric(24,8) not null,
  functional_currency         text          not null,
  rate_source                 text          not null,
  rate_timestamp              timestamptz   not null,
  rounding_policy_id          text          not null,

  created_by               uuid,
  created_at               timestamptz   not null,
  version                  integer       not null,

  constraint supplier_credit_note_lines_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint supplier_credit_note_lines_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint supplier_credit_note_lines_note_fk
    foreign key (company_id, supplier_credit_note_id)
    references public.supplier_credit_notes (company_id, id),
  constraint supplier_credit_note_lines_invoice_line_fk
    foreign key (company_id, supplier_invoice_line_id)
    references public.supplier_invoice_lines (company_id, id),
  constraint supplier_credit_note_lines_product_fk
    foreign key (company_id, product_id) references public.products (company_id, id),
  constraint supplier_credit_note_lines_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint supplier_credit_note_lines_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint supplier_credit_note_lines_quantity_chk check (quantity > 0),
  constraint supplier_credit_note_lines_totals_chk
    check (line_total_transaction = line_subtotal_transaction + tax_amount),
  constraint supplier_credit_note_lines_fx_chk check (fx_rate > 0),
  constraint supplier_credit_note_lines_number_key
    unique (supplier_credit_note_id, line_number),
  constraint supplier_credit_note_lines_company_id_key unique (company_id, id)
);

-- ── 8. Landed cost ──────────────────────────────────────────────────────────
create table public.landed_costs (
  id               uuid          primary key default platform.uuidv7(),
  tenant_id        uuid          not null,
  company_id       uuid          not null,
  goods_receipt_id uuid          not null,
  concept          text          not null,
  -- 'by_value' | 'by_weight' | 'by_units'. Por GASTO, no por recepción: el
  -- flete se reparte por peso y la comisión aduanal por valor, en la misma
  -- recepción.
  allocation_method text         not null,
  supplier_id      uuid,
  reference        text,
  incurred_on      date          not null,
  status           text          not null default 'draft',
  applied_at       timestamptz,

  amount_transaction_currency numeric(24,8) not null,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null,
  functional_amount           numeric(24,8) not null,
  functional_currency         text          not null,
  rate_source                 text          not null,
  rate_timestamp              timestamptz   not null,
  rounding_policy_id          text          not null default 'purchases:document:8:HALF_UP',

  created_by       uuid,
  created_at       timestamptz   not null,
  version          integer       not null,

  constraint landed_costs_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint landed_costs_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint landed_costs_receipt_fk
    foreign key (company_id, goods_receipt_id) references public.goods_receipts (company_id, id),
  constraint landed_costs_supplier_fk
    foreign key (company_id, supplier_id) references public.suppliers (company_id, id),
  constraint landed_costs_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint landed_costs_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint landed_costs_method_chk
    check (allocation_method in ('by_value', 'by_weight', 'by_units')),
  constraint landed_costs_concept_chk
    check (concept = btrim(concept) and length(concept) between 1 and 120),
  constraint landed_costs_amount_chk check (functional_amount > 0),
  constraint landed_costs_status_chk check (status in ('draft', 'applied', 'cancelled')),
  constraint landed_costs_applied_chk check ((status = 'applied') = (applied_at is not null)),
  constraint landed_costs_fx_chk check (fx_rate > 0),
  constraint landed_costs_company_id_key unique (company_id, id)
);
create index landed_costs_receipt_idx on public.landed_costs (company_id, goods_receipt_id);

-- El prorrateo, CONGELADO al aplicar (IMPORTS_PURCHASES_SPEC: «asignación
-- congelada al postear»). Append-only: si el reparto estuvo mal, se cancela el
-- gasto y se aplica otro, no se reescribe el que ya movió el kardex.
create table public.landed_cost_allocations (
  id                    uuid          primary key default platform.uuidv7(),
  tenant_id             uuid          not null,
  company_id            uuid          not null,
  landed_cost_id        uuid          not null,
  goods_receipt_line_id uuid          not null,
  -- El total asignado a esta línea, en moneda funcional.
  allocated_functional  numeric(24,8) not null,
  -- Y su reparto entre lo que sigue en existencia y lo ya vendido (ADR-0040 §6).
  to_inventory_functional numeric(24,8) not null,
  to_variance_functional  numeric(24,8) not null,
  -- Cantidad que quedaba al aplicar. Se guarda porque es lo que explica el
  -- reparto: sin ella, la variación es un número sin justificación.
  quantity_remaining    numeric(24,8) not null,
  quantity_received     numeric(24,8) not null,
  -- La base sobre la que se prorrateó (valor, peso total o unidades), guardada
  -- para poder reproducir el cálculo sin volver a mirar el maestro.
  allocation_base       numeric(24,8) not null,

  created_by            uuid,
  created_at            timestamptz   not null,
  version               integer       not null,

  constraint landed_cost_allocations_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint landed_cost_allocations_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint landed_cost_allocations_cost_fk
    foreign key (company_id, landed_cost_id) references public.landed_costs (company_id, id),
  constraint landed_cost_allocations_line_fk
    foreign key (company_id, goods_receipt_line_id)
    references public.goods_receipt_lines (company_id, id),
  constraint landed_cost_allocations_amounts_chk
    check (allocated_functional >= 0 and to_inventory_functional >= 0
           and to_variance_functional >= 0
           and allocated_functional = to_inventory_functional + to_variance_functional),
  constraint landed_cost_allocations_qty_chk
    check (quantity_received > 0 and quantity_remaining >= 0
           and quantity_remaining <= quantity_received),
  constraint landed_cost_allocations_base_chk check (allocation_base >= 0),
  constraint landed_cost_allocations_line_key unique (landed_cost_id, goods_receipt_line_id),
  constraint landed_cost_allocations_company_id_key unique (company_id, id)
);

-- La VARIACIÓN DE COSTO POR LANDED COST TARDÍO (ADR-0040 §6). Un gasto del
-- período, no un mayor valor del inventario. Se calcula y se persiste con su
-- cuenta; el asiento es del motor contable, que todavía no existe — y por eso
-- se guarda el importe: un número que no se calcula hoy no se reconstruye
-- mañana.
create table public.landed_cost_variances (
  id                    uuid          primary key default platform.uuidv7(),
  tenant_id             uuid          not null,
  company_id            uuid          not null,
  landed_cost_id        uuid          not null,
  goods_receipt_line_id uuid          not null,
  product_id            uuid          not null,
  amount_functional     numeric(24,8) not null,
  functional_currency   text          not null,
  -- Cuenta declarada. No hay plan de cuentas todavía; el código es estable y el
  -- mapeo a la cuenta real lo hará el motor contable.
  account_code          text          not null default 'variacion_costo_landed_tardio',
  occurred_on           date          not null,
  reason                text          not null,

  created_by            uuid,
  created_at            timestamptz   not null,
  version               integer       not null,

  constraint landed_cost_variances_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint landed_cost_variances_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint landed_cost_variances_cost_fk
    foreign key (company_id, landed_cost_id) references public.landed_costs (company_id, id),
  constraint landed_cost_variances_line_fk
    foreign key (company_id, goods_receipt_line_id)
    references public.goods_receipt_lines (company_id, id),
  constraint landed_cost_variances_product_fk
    foreign key (company_id, product_id) references public.products (company_id, id),
  constraint landed_cost_variances_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint landed_cost_variances_amount_chk check (amount_functional > 0),
  constraint landed_cost_variances_company_id_key unique (company_id, id)
);
create index landed_cost_variances_period_idx
  on public.landed_cost_variances (company_id, occurred_on);

-- ── 9. Retenciones y comprobantes ───────────────────────────────────────────
create table public.supplier_retentions (
  id                  uuid          primary key default platform.uuidv7(),
  tenant_id           uuid          not null,
  company_id          uuid          not null,
  supplier_id         uuid          not null,
  supplier_invoice_id uuid          not null,
  retention_code      text          not null,
  concept_code        text          not null,
  -- R-05: la regla se COPIA, no se referencia. Cambiar retention_rules mañana
  -- no altera una retención practicada ayer.
  retention_rule_id   uuid          not null,
  formula_kind        text          not null,
  rate_snapshot       numeric(24,8) not null,
  subtrahend_snapshot numeric(24,8),
  minimum_exempt_snapshot numeric(24,8),
  legal_source_snapshot   text      not null,

  base_amount         numeric(24,8) not null,
  retained_amount     numeric(24,8) not null,
  functional_currency text          not null,
  -- draft → calculated → applied (RETENTIONS_SPEC §Estados, recortado a lo que
  -- este módulo hace: `issued` es del comprobante y `reported` de los libros).
  status              text          not null default 'calculated',
  applied_at          timestamptz,
  rules_version       text          not null,

  created_by          uuid,
  created_at          timestamptz   not null,
  version             integer       not null,

  constraint supplier_retentions_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint supplier_retentions_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint supplier_retentions_supplier_fk
    foreign key (company_id, supplier_id) references public.suppliers (company_id, id),
  constraint supplier_retentions_invoice_fk
    foreign key (company_id, supplier_invoice_id)
    references public.supplier_invoices (company_id, id),
  constraint supplier_retentions_rule_fk
    foreign key (retention_rule_id) references public.retention_rules (id),
  constraint supplier_retentions_concept_fk
    foreign key (concept_code) references public.retention_concepts (code),
  constraint supplier_retentions_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint supplier_retentions_code_chk check (retention_code in ('iva', 'islr')),
  constraint supplier_retentions_formula_chk
    check (formula_kind in ('rate', 'rate_minus_subtrahend')),
  constraint supplier_retentions_amounts_chk
    check (base_amount >= 0 and retained_amount >= 0 and retained_amount <= base_amount),
  constraint supplier_retentions_status_chk
    check (status in ('calculated', 'applied', 'cancelled')),
  constraint supplier_retentions_applied_chk
    check ((status = 'applied') = (applied_at is not null)),
  -- RETENTIONS_SPEC: «evitar doble retención sobre misma base/documento/concepto».
  -- Va en la base, no en el caso de uso: dos operadores registrando a la vez.
  constraint supplier_retentions_once_key unique (supplier_invoice_id, retention_code, concept_code),
  constraint supplier_retentions_company_id_key unique (company_id, id)
);

create table public.retention_receipts (
  id                  uuid        primary key default platform.uuidv7(),
  tenant_id           uuid        not null,
  company_id          uuid        not null,
  supplier_id         uuid        not null,
  supplier_invoice_id uuid        not null,
  series              text        not null default 'A',
  -- ADR-0039 §5: correlativo propio del agente de retención, con la mecánica
  -- atómica de ADR-0037. Se CONSERVA al anular.
  receipt_number      bigint,
  -- Del rango autorizado, kind='retention_receipt'.
  control_number      bigint,
  status              text        not null default 'draft',
  issued_at           timestamptz,
  annulled_at         timestamptz,
  annul_reason        text,
  -- El período fiscal al que corresponde, para los libros.
  fiscal_period       text        not null,
  total_retained      numeric(24,8) not null default 0,
  functional_currency text        not null,

  created_by          uuid,
  created_at          timestamptz not null,
  version             integer     not null,

  constraint retention_receipts_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint retention_receipts_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint retention_receipts_supplier_fk
    foreign key (company_id, supplier_id) references public.suppliers (company_id, id),
  constraint retention_receipts_invoice_fk
    foreign key (company_id, supplier_invoice_id)
    references public.supplier_invoices (company_id, id),
  constraint retention_receipts_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint retention_receipts_series_chk
    check (series = btrim(series) and length(series) between 1 and 10),
  constraint retention_receipts_status_chk check (status in ('draft', 'issued', 'annulled')),
  -- Emitido tiene número y fecha; anulado los CONSERVA. Es literalmente la
  -- regla de ADR-0037 aplicada a otro documento.
  constraint retention_receipts_issued_shape_chk
    check ((status = 'draft' and receipt_number is null and issued_at is null)
           or (status in ('issued', 'annulled')
               and receipt_number is not null and issued_at is not null)),
  constraint retention_receipts_annulled_chk
    check ((status = 'annulled') = (annulled_at is not null)
           and (annulled_at is null or length(btrim(coalesce(annul_reason, ''))) >= 3)),
  constraint retention_receipts_period_chk check (fiscal_period ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint retention_receipts_total_chk check (total_retained >= 0),
  constraint retention_receipts_company_id_key unique (company_id, id)
);
create unique index retention_receipts_number_key
  on public.retention_receipts (company_id, series, receipt_number)
  where receipt_number is not null;
comment on table public.retention_receipts is
  'Comprobante de retención con correlativo propio (ADR-0039 §5). El número se '
  'CONSERVA al anular. La máscara de 14 caracteres que exige PA102 NO se '
  'implementa: el formato literal no está en el repositorio (VALIDAR-SENIAT) y '
  'formatear un bigint no cambia el esquema.';

-- ── 10. Pagos a proveedor ───────────────────────────────────────────────────
create table public.supplier_payments (
  id                  uuid          primary key default platform.uuidv7(),
  tenant_id           uuid          not null,
  company_id          uuid          not null,
  supplier_id         uuid          not null,
  supplier_invoice_id uuid          not null,
  bank_account_id     uuid,
  paid_at             timestamptz   not null,
  instrument          text          not null,
  reference           text,
  -- Bruto, retenido y neto. Los tres se guardan porque los tres se explican:
  -- el proveedor cobra el neto, el fisco espera el retenido, y el bruto es lo
  -- que aplica contra la factura.
  gross_amount        numeric(24,8) not null,
  retained_amount     numeric(24,8) not null default 0,
  net_amount          numeric(24,8) not null,

  amount_transaction_currency numeric(24,8) not null,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null,
  functional_amount           numeric(24,8) not null,
  functional_currency         text          not null,
  rate_source                 text          not null,
  rate_timestamp              timestamptz   not null,
  rounding_policy_id          text          not null default 'purchases:document:8:HALF_UP',

  created_by          uuid,
  created_at          timestamptz   not null,
  version             integer       not null,

  constraint supplier_payments_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint supplier_payments_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint supplier_payments_supplier_fk
    foreign key (company_id, supplier_id) references public.suppliers (company_id, id),
  constraint supplier_payments_invoice_fk
    foreign key (company_id, supplier_invoice_id)
    references public.supplier_invoices (company_id, id),
  constraint supplier_payments_bank_fk
    foreign key (company_id, bank_account_id)
    references public.supplier_bank_accounts (company_id, id),
  constraint supplier_payments_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint supplier_payments_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint supplier_payments_instrument_chk
    check (instrument in ('efectivo_bs', 'efectivo_usd', 'zelle', 'usdt', 'transferencia',
                          'cheque', 'nota_credito', 'otro')),
  constraint supplier_payments_amounts_chk
    check (gross_amount > 0 and retained_amount >= 0 and net_amount >= 0
           and gross_amount = retained_amount + net_amount),
  constraint supplier_payments_fx_chk check (fx_rate > 0),
  constraint supplier_payments_company_id_key unique (company_id, id)
);
create index supplier_payments_invoice_idx
  on public.supplier_payments (company_id, supplier_invoice_id);

-- ── 11. `fiscal_number_ranges` admite el comprobante de retención ───────────
-- Una migración aplicada no se edita: el CHECK de la 21 se sustituye por otro.
alter table public.fiscal_number_ranges drop constraint fiscal_number_ranges_kind_chk;
alter table public.fiscal_number_ranges add constraint fiscal_number_ranges_kind_chk
  check (kind in ('invoice', 'credit_note', 'debit_note', 'delivery_note', 'retention_receipt'));

-- Y los regímenes que emiten con rango admiten también el comprobante. No es
-- cosmético: `allowed_kinds` es lo que consulta quien pregunte «¿puede esta
-- empresa emitir esto?».
update public.fiscal_regimes
   set allowed_kinds = allowed_kinds || array['retention_receipt']
 where numbering_mode = 'range' and not ('retention_receipt' = any (allowed_kinds));

-- ── 11-bis. La EMPRESA tiene clasificación tributaria propia ────────────────
-- Hacía falta y no existía: hasta ahora la clasificación fiscal era de las
-- contrapartes (ADR-0033), no de uno mismo. ADR-0040 §7 la necesita para decidir
-- si el IVA de la compra es crédito o costo.
--
-- NULLABLE Y SIN DEFAULT, deliberadamente. Poner 'ordinario' por omisión sería
-- asignarle a cada empresa existente un régimen tributario que nadie declaró —
-- inventar una obligación legal por la puerta de atrás de un DEFAULT. Sin
-- clasificación, registrar una factura de compra falla y dice qué falta.
alter table public.companies add column taxpayer_type_code text;
alter table public.companies add constraint companies_taxpayer_type_fk
  foreign key (taxpayer_type_code) references public.taxpayer_types (code);
comment on column public.companies.taxpayer_type_code is
  'Clasificación tributaria de la PROPIA empresa (ADR-0040 §7). Decide si el IVA '
  'soportado es crédito fiscal o costo. Sin default a propósito: un régimen '
  'tributario no se asigna por omisión. VALIDAR-TRIBUTARIO.';

-- ── 12. Funciones ───────────────────────────────────────────────────────────

-- El cálculo de la retención, PURO y en el esquema: es el oráculo contra el que
-- se verifica el cálculo de TypeScript, igual que apply_inventory_move verifica
-- el costeo (ADR-0034, LAD41). Dos implementaciones que tienen que coincidir.
create function platform.compute_retention(
  p_base numeric, p_formula text, p_rate numeric,
  p_subtrahend numeric, p_minimum_exempt numeric
)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_result numeric;
begin
  if p_formula = 'rate' then
    return round(p_base * p_rate, 8);
  end if;
  if p_formula = 'rate_minus_subtrahend' then
    -- El mínimo exento se comprueba ANTES de restar: por debajo de él no se
    -- retiene nada, y aplicar la fórmula igualmente daría un negativo que el
    -- max() convertiría en cero por el camino equivocado.
    if p_minimum_exempt is not null and p_base < p_minimum_exempt then
      return 0;
    end if;
    v_result := round(p_base * p_rate, 8) - p_subtrahend;
    return greatest(v_result, 0);
  end if;
  raise exception 'formula_kind desconocida: %', p_formula using errcode = 'LAD53';
end;
$$;
comment on function platform.compute_retention(numeric, text, numeric, numeric, numeric) is
  'Vocabulario CERRADO de fórmulas (ADR-0039 §3). No evalúa expresiones: dos '
  'formas conocidas y una excepción para cualquier otra cosa.';

create function platform.resolve_retention(
  p_fecha        date,
  p_jurisdiction text,
  p_retention    text,
  p_concept      text,
  p_taxpayer     text,
  p_person_type  text
)
returns table (
  retention_rule_id uuid, formula_kind text, rate numeric,
  subtrahend numeric, minimum_exempt numeric, legal_source text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  select count(*) into v_n
    from public.retention_rules r
   where r.status = 'active'
     and r.jurisdiction = p_jurisdiction
     and r.retention_code = p_retention
     and r.concept_code = p_concept
     and r.effective_from <= p_fecha
     and (r.effective_to is null or r.effective_to > p_fecha)
     and (r.taxpayer_type is null or r.taxpayer_type = p_taxpayer)
     and (r.supplier_person_type is null or r.supplier_person_type = p_person_type)
     and r.priority = (
       select max(r2.priority) from public.retention_rules r2
        where r2.status = 'active' and r2.jurisdiction = p_jurisdiction
          and r2.retention_code = p_retention and r2.concept_code = p_concept
          and r2.effective_from <= p_fecha
          and (r2.effective_to is null or r2.effective_to > p_fecha)
          and (r2.taxpayer_type is null or r2.taxpayer_type = p_taxpayer)
          and (r2.supplier_person_type is null or r2.supplier_person_type = p_person_type));

  if v_n = 0 then
    raise exception
      'no hay regla de retención vigente para % / % el % (contraparte %, persona %): cárgala en retention_rules con su fuente legal antes de retener',
      p_retention, p_concept, p_fecha, p_taxpayer, p_person_type
      using errcode = 'LAD53',
            hint = 'ADR-0039: el catálogo nace vacío a propósito; sin regla no se retiene, y retener cero sería deber al fisco en silencio';
  end if;
  if v_n > 1 then
    raise exception
      'hay % reglas de retención con la MISMA prioridad para % / % el %: el catálogo es ambiguo y el sistema no puede elegir',
      v_n, p_retention, p_concept, p_fecha
      using errcode = 'LAD53',
            hint = 'ajusta `priority` para que una regla sea más específica que la otra';
  end if;

  return query
    select r.id, r.formula_kind, r.rate, r.subtrahend, r.minimum_exempt, r.legal_source
      from public.retention_rules r
     where r.status = 'active'
       and r.jurisdiction = p_jurisdiction
       and r.retention_code = p_retention
       and r.concept_code = p_concept
       and r.effective_from <= p_fecha
       and (r.effective_to is null or r.effective_to > p_fecha)
       and (r.taxpayer_type is null or r.taxpayer_type = p_taxpayer)
       and (r.supplier_person_type is null or r.supplier_person_type = p_person_type)
     order by r.priority desc
     limit 1;
end;
$$;
comment on function platform.resolve_retention(date, text, text, text, text, text) is
  'Devuelve LA regla vigente o FALLA (LAD53). Nunca cero: un cero silencioso '
  'deja pasar el pago completo y la empresa queda debiendo al fisco una '
  'retención que nunca practicó (ADR-0039 §2).';
revoke execute on function platform.resolve_retention(date, text, text, text, text, text) from public;

-- Progreso de una orden: lo pedido contra lo recibido, POR LÍNEA. El estado no
-- se lee de una columna (ADR-0040 §3): un estado guardado a mano diverge de las
-- recepciones en la tercera parcial, y hay un test que compara los dos.
create function platform.purchase_order_progress(p_company uuid, p_order uuid)
returns table (
  order_line_id uuid, product_id uuid, quantity_ordered numeric,
  quantity_received numeric, quantity_pending numeric
)
language sql
stable
set search_path = ''
as $$
  select l.id, l.product_id, l.quantity,
         coalesce(sum(rl.quantity) filter (where r.status = 'confirmed'), 0),
         l.quantity - coalesce(sum(rl.quantity) filter (where r.status = 'confirmed'), 0)
    from public.purchase_order_lines l
    left join public.goods_receipt_lines rl on rl.purchase_order_line_id = l.id
    left join public.goods_receipts r on r.id = rl.goods_receipt_id
   where l.company_id = p_company and l.purchase_order_id = p_order
   group by l.id, l.product_id, l.quantity, l.line_number
   order by l.line_number
$$;

create function platform.purchase_order_status(p_company uuid, p_order uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select case
           when count(*) = 0 then 'pending'
           when sum(case when quantity_received > 0 then 1 else 0 end) = 0 then 'pending'
           when sum(case when quantity_pending > 0 then 1 else 0 end) = 0 then 'complete'
           else 'partial'
         end
    from platform.purchase_order_progress(p_company, p_order)
$$;

-- El matching de TRES VÍAS. Devuelve una fila por línea de factura con lo que
-- dice cada vértice y la diferencia. La política —qué se tolera— NO vive aquí:
-- esta función informa, el caso de uso decide. Mezclarlas obligaría a que la
-- función leyera configuración y dejaría de ser reproducible.
create function platform.purchase_matching(p_company uuid, p_invoice uuid)
returns table (
  invoice_line_id uuid, product_id uuid,
  qty_ordered numeric, qty_received numeric, qty_invoiced numeric,
  price_ordered numeric, price_invoiced numeric, price_diff_pct numeric
)
language sql
stable
set search_path = ''
as $$
  select il.id, il.product_id,
         ol.quantity, rl.quantity, il.quantity,
         ol.unit_price_transaction, il.unit_price_transaction,
         case
           when ol.unit_price_transaction is null then null
           when ol.unit_price_transaction = 0 then
             case when il.unit_price_transaction = 0 then 0 else 100 end
           else round(abs(il.unit_price_transaction - ol.unit_price_transaction)
                      * 100 / ol.unit_price_transaction, 8)
         end
    from public.supplier_invoice_lines il
    left join public.goods_receipt_lines rl on rl.id = il.goods_receipt_line_id
    left join public.purchase_order_lines ol on ol.id = rl.purchase_order_line_id
   where il.company_id = p_company and il.supplier_invoice_id = p_invoice
   order by il.line_number
$$;

-- Saldo de una factura de proveedor: total − pagos brutos − notas de crédito.
-- El pago BRUTO es lo que cancela deuda; el neto es lo que salió del banco, y
-- la diferencia se la debe la empresa al fisco, no al proveedor.
create function platform.supplier_invoice_balance(p_company uuid, p_invoice uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select i.total_amount
         - coalesce((select sum(p.gross_amount) from public.supplier_payments p
                      where p.supplier_invoice_id = i.id), 0)
         - coalesce((select sum(n.total_amount) from public.supplier_credit_notes n
                      where n.supplier_invoice_id = i.id and n.status = 'posted'), 0)
    from public.supplier_invoices i
   where i.id = p_invoice and i.company_id = p_company and i.status in ('posted', 'paid')
$$;

-- Antigüedad de CxP, simétrica a `ar_aging`. Los mismos cuatro tramos: dos
-- funciones con tramos distintos serían dos verdades sobre la misma empresa.
create function platform.ap_aging(
  p_company uuid, p_supplier uuid default null, p_reference date default current_date
)
returns table (
  supplier_id uuid, bucket text, document_count bigint, amount numeric
)
language sql
stable
set search_path = ''
as $$
  with saldos as (
    select i.supplier_id, i.id,
           (p_reference - coalesce(i.due_date, i.invoice_date)) as dias,
           platform.supplier_invoice_balance(p_company, i.id) as saldo
      from public.supplier_invoices i
     where i.company_id = p_company
       and i.status in ('posted', 'paid')
       and (p_supplier is null or i.supplier_id = p_supplier)
       and i.invoice_date <= p_reference
  )
  select s.supplier_id,
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

-- ── 13. Append-only y procedencia ───────────────────────────────────────────
-- ⚠ Recordatorio del contrato de `set_row_provenance()`, que la 21 dejó escrito
-- y que esta migración vuelve a necesitar en catorce tablas: escribe
-- created_by, created_at Y version — LAS TRES. Una tabla con el trigger y sin
-- columna `version` muere en el primer INSERT con «record "new" has no field
-- version». Todas las de aquí la llevan.

create trigger suppliers_00_provenance
  before insert or update on public.suppliers
  for each row execute function platform.set_row_provenance();
create trigger suppliers_01_anchors
  before update on public.suppliers
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger supplier_bank_accounts_00_provenance
  before insert or update on public.supplier_bank_accounts
  for each row execute function platform.set_row_provenance();
create trigger supplier_bank_accounts_01_anchors
  before update on public.supplier_bank_accounts
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger retention_rules_provenance
  before insert or update on public.retention_rules
  for each row execute function platform.set_row_provenance();
create trigger purchase_settings_00_provenance
  before insert or update on public.purchase_settings
  for each row execute function platform.set_row_provenance();
create trigger purchase_settings_01_anchors
  before update on public.purchase_settings
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger purchase_orders_00_provenance
  before insert or update on public.purchase_orders
  for each row execute function platform.set_row_provenance();
create trigger purchase_orders_01_anchors
  before update on public.purchase_orders
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger purchase_order_lines_00_provenance
  before insert or update on public.purchase_order_lines
  for each row execute function platform.set_row_provenance();
create trigger purchase_order_lines_01_anchors
  before update on public.purchase_order_lines
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger goods_receipts_00_provenance
  before insert or update on public.goods_receipts
  for each row execute function platform.set_row_provenance();
create trigger goods_receipts_01_anchors
  before update on public.goods_receipts
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger goods_receipt_lines_00_provenance
  before insert or update on public.goods_receipt_lines
  for each row execute function platform.set_row_provenance();
create trigger goods_receipt_lines_01_anchors
  before update on public.goods_receipt_lines
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger supplier_invoices_00_provenance
  before insert or update on public.supplier_invoices
  for each row execute function platform.set_row_provenance();
create trigger supplier_invoices_01_anchors
  before update on public.supplier_invoices
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger supplier_invoice_lines_00_provenance
  before insert or update on public.supplier_invoice_lines
  for each row execute function platform.set_row_provenance();
create trigger supplier_invoice_lines_01_anchors
  before update on public.supplier_invoice_lines
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger supplier_credit_notes_00_provenance
  before insert or update on public.supplier_credit_notes
  for each row execute function platform.set_row_provenance();
create trigger supplier_credit_notes_01_anchors
  before update on public.supplier_credit_notes
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger supplier_credit_note_lines_00_provenance
  before insert or update on public.supplier_credit_note_lines
  for each row execute function platform.set_row_provenance();
create trigger supplier_credit_note_lines_01_anchors
  before update on public.supplier_credit_note_lines
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger landed_costs_00_provenance
  before insert or update on public.landed_costs
  for each row execute function platform.set_row_provenance();
create trigger landed_costs_01_anchors
  before update on public.landed_costs
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger landed_cost_allocations_00_provenance
  before insert or update on public.landed_cost_allocations
  for each row execute function platform.set_row_provenance();
create trigger landed_cost_allocations_01_anchors
  before update on public.landed_cost_allocations
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger landed_cost_variances_00_provenance
  before insert or update on public.landed_cost_variances
  for each row execute function platform.set_row_provenance();
create trigger landed_cost_variances_01_anchors
  before update on public.landed_cost_variances
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger supplier_retentions_00_provenance
  before insert or update on public.supplier_retentions
  for each row execute function platform.set_row_provenance();
create trigger supplier_retentions_01_anchors
  before update on public.supplier_retentions
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger retention_receipts_00_provenance
  before insert or update on public.retention_receipts
  for each row execute function platform.set_row_provenance();
create trigger retention_receipts_01_anchors
  before update on public.retention_receipts
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger supplier_payments_00_provenance
  before insert or update on public.supplier_payments
  for each row execute function platform.set_row_provenance();
create trigger supplier_payments_01_anchors
  before update on public.supplier_payments
  for each row execute function platform.assert_isolation_anchors_immutable();

-- APPEND-ONLY EN DOS CAPAS (ADR-0006). Capa 1: sin GRANT de UPDATE/DELETE, más
-- abajo. Capa 2: el trigger, que también rechaza al superusuario.
create trigger landed_cost_allocations_append_only
  before update or delete on public.landed_cost_allocations
  for each row execute function platform.reject_mutation();
create trigger landed_cost_allocations_no_truncate
  before truncate on public.landed_cost_allocations
  for each statement execute function platform.reject_mutation();
create trigger landed_cost_variances_append_only
  before update or delete on public.landed_cost_variances
  for each row execute function platform.reject_mutation();
create trigger landed_cost_variances_no_truncate
  before truncate on public.landed_cost_variances
  for each statement execute function platform.reject_mutation();
create trigger supplier_payments_append_only
  before update or delete on public.supplier_payments
  for each row execute function platform.reject_mutation();
create trigger supplier_payments_no_truncate
  before truncate on public.supplier_payments
  for each statement execute function platform.reject_mutation();

-- Los documentos de compra: inmutables UNA VEZ CONFIRMADOS. Antes son
-- borradores y editarlos significa algo; después son hechos.
create function platform.assert_purchase_doc_immutable()
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

  -- Ya no es borrador. Solo se admiten las transiciones de estado declaradas y
  -- los campos que ESAS transiciones tocan; cualquier otro cambio se rechaza
  -- comparando la fila entera con los campos permitidos neutralizados.
  if to_jsonb(old) - 'status' - 'version' - 'annulled_at' - 'annul_reason'
     - 'applied_at' - 'closed_at' - 'close_reason' - 'posted_at' - 'retention_total'
   <> to_jsonb(new) - 'status' - 'version' - 'annulled_at' - 'annul_reason'
     - 'applied_at' - 'closed_at' - 'close_reason' - 'posted_at' - 'retention_total'
  then
    raise exception
      'un documento de compra confirmado no se edita (%.%): corrige con una nota de crédito o un documento nuevo',
      tg_table_schema, tg_table_name
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;

create trigger purchase_orders_immutable
  before update or delete on public.purchase_orders
  for each row execute function platform.assert_purchase_doc_immutable();
create trigger goods_receipts_immutable
  before update or delete on public.goods_receipts
  for each row execute function platform.assert_purchase_doc_immutable();
create trigger supplier_invoices_immutable
  before update or delete on public.supplier_invoices
  for each row execute function platform.assert_purchase_doc_immutable();
create trigger supplier_credit_notes_immutable
  before update or delete on public.supplier_credit_notes
  for each row execute function platform.assert_purchase_doc_immutable();
create trigger landed_costs_immutable
  before update or delete on public.landed_costs
  for each row execute function platform.assert_purchase_doc_immutable();

-- Las LÍNEAS de un documento confirmado tampoco: sin esto, la cabecera sería
-- inmutable y los importes editables, que es la peor de las dos opciones
-- porque parece protegida.
create function platform.assert_purchase_lines_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_parent uuid;
  v_col    text;
begin
  v_col := tg_argv[0];
  v_parent := coalesce((to_jsonb(old) ->> v_col)::uuid, (to_jsonb(new) ->> v_col)::uuid);
  execute format('select status from public.%I where id = $1', tg_argv[1])
     into v_status using v_parent;
  if v_status = 'draft' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception
    'las líneas de un documento de compra confirmado no se editan ni se borran (%)', tg_table_name
    using errcode = 'LAD06';
end;
$$;

create trigger purchase_order_lines_immutable
  before update or delete on public.purchase_order_lines
  for each row execute function platform.assert_purchase_lines_immutable(
    'purchase_order_id', 'purchase_orders');
create trigger goods_receipt_lines_immutable
  before update or delete on public.goods_receipt_lines
  for each row execute function platform.assert_purchase_lines_immutable(
    'goods_receipt_id', 'goods_receipts');
create trigger supplier_invoice_lines_immutable
  before update or delete on public.supplier_invoice_lines
  for each row execute function platform.assert_purchase_lines_immutable(
    'supplier_invoice_id', 'supplier_invoices');
create trigger supplier_credit_note_lines_immutable
  before update or delete on public.supplier_credit_note_lines
  for each row execute function platform.assert_purchase_lines_immutable(
    'supplier_credit_note_id', 'supplier_credit_notes');

-- El comprobante de retención: su correlativo NO se toca nunca, ni al anular.
create function platform.assert_retention_receipt_number()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'draft' and new.receipt_number is distinct from old.receipt_number then
    raise exception
      'el correlativo de un comprobante de retención emitido no se cambia ni se libera: anular lo conserva (ADR-0039)'
      using errcode = 'LAD54';
  end if;
  if old.status = 'annulled' and new.status <> 'annulled' then
    raise exception 'un comprobante de retención anulado no vuelve a emitirse'
      using errcode = 'LAD54';
  end if;
  return new;
end;
$$;
create trigger retention_receipts_number_immutable
  before update on public.retention_receipts
  for each row execute function platform.assert_retention_receipt_number();

-- El correlativo del comprobante, con la mecánica de ADR-0037: cuenta los YA
-- ASIGNADOS incluidos los anulados.
create function platform.claim_retention_receipt_number(p_company uuid, p_series text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company::text || '|retention_receipt|' || p_series, 0));
  select coalesce(max(r.receipt_number), 0) + 1 into v_next
    from public.retention_receipts r
   where r.company_id = p_company and r.series = p_series and r.receipt_number is not null;
  return v_next;
end;
$$;
revoke execute on function platform.claim_retention_receipt_number(uuid, text) from public;

-- ── 14. RLS ─────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['suppliers', 'supplier_bank_accounts', 'purchase_settings',
                           'purchase_orders', 'purchase_order_lines', 'goods_receipts',
                           'goods_receipt_lines', 'supplier_invoices', 'supplier_invoice_lines',
                           'supplier_credit_notes', 'supplier_credit_note_lines',
                           'landed_costs', 'landed_cost_allocations', 'landed_cost_variances',
                           'supplier_retentions', 'retention_receipts', 'supplier_payments']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format($f$
      create policy %1$s_select on public.%1$I for select to authenticated
        using (company_id in (select platform.ladino_company_ids()));
      create policy %1$s_insert on public.%1$I for insert to authenticated with check (false);
      create policy %1$s_update on public.%1$I for update to authenticated using (false);
      create policy %1$s_delete on public.%1$I for delete to authenticated using (false);
      create policy %1$s_api_select on public.%1$I for select to ladino_api
        using (tenant_id in (select platform.ladino_service_tenant_ids()));
      create policy %1$s_api_insert on public.%1$I for insert to ladino_api
        with check (tenant_id in (select platform.ladino_service_tenant_ids()));
      create policy %1$s_api_update on public.%1$I for update to ladino_api
        using      (tenant_id in (select platform.ladino_service_tenant_ids()))
        with check (tenant_id in (select platform.ladino_service_tenant_ids()));
    $f$, t);
  end loop;
end $$;

-- Catálogos GLOBALES de retención: lectura para todos, escritura por la API.
alter table public.retention_concepts enable row level security;
alter table public.retention_concepts force  row level security;
alter table public.retention_rules    enable row level security;
alter table public.retention_rules    force  row level security;
create policy retention_concepts_select on public.retention_concepts
  for select to authenticated, ladino_api using (true);
create policy retention_concepts_insert on public.retention_concepts
  for insert to authenticated, ladino_api with check (false);
create policy retention_concepts_update on public.retention_concepts
  for update to authenticated, ladino_api using (false);
create policy retention_concepts_delete on public.retention_concepts
  for delete to authenticated, ladino_api using (false);
create policy retention_rules_select on public.retention_rules
  for select to authenticated, ladino_api using (true);
create policy retention_rules_insert on public.retention_rules
  for insert to authenticated with check (false);
create policy retention_rules_update on public.retention_rules
  for update to authenticated using (false);
create policy retention_rules_delete on public.retention_rules
  for delete to authenticated, ladino_api using (false);
-- La API sí carga reglas: es el endpoint por el que el operador introduce la
-- norma con su Gaceta. Inactivarla es UPDATE de `status`, no DELETE.
create policy retention_rules_api_insert on public.retention_rules
  for insert to ladino_api with check (true);
create policy retention_rules_api_update on public.retention_rules
  for update to ladino_api using (true) with check (true);

-- DELETE para ladino_api: solo en borradores. Lo demás es hecho consumado.
create policy suppliers_api_delete on public.suppliers for delete to ladino_api using (false);
create policy supplier_bank_accounts_api_delete on public.supplier_bank_accounts
  for delete to ladino_api using (false);
create policy purchase_settings_api_delete on public.purchase_settings
  for delete to ladino_api using (false);
create policy purchase_orders_api_delete on public.purchase_orders for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()) and status = 'draft');
create policy purchase_order_lines_api_delete on public.purchase_order_lines
  for delete to ladino_api using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy goods_receipts_api_delete on public.goods_receipts for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()) and status = 'draft');
create policy goods_receipt_lines_api_delete on public.goods_receipt_lines
  for delete to ladino_api using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy supplier_invoices_api_delete on public.supplier_invoices for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()) and status = 'draft');
create policy supplier_invoice_lines_api_delete on public.supplier_invoice_lines
  for delete to ladino_api using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy supplier_credit_notes_api_delete on public.supplier_credit_notes
  for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()) and status = 'draft');
create policy supplier_credit_note_lines_api_delete on public.supplier_credit_note_lines
  for delete to ladino_api using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy landed_costs_api_delete on public.landed_costs for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()) and status = 'draft');
create policy landed_cost_allocations_api_delete on public.landed_cost_allocations
  for delete to ladino_api using (false);
create policy landed_cost_variances_api_delete on public.landed_cost_variances
  for delete to ladino_api using (false);
create policy supplier_retentions_api_delete on public.supplier_retentions
  for delete to ladino_api using (false);
create policy retention_receipts_api_delete on public.retention_receipts
  for delete to ladino_api using (false);
create policy supplier_payments_api_delete on public.supplier_payments
  for delete to ladino_api using (false);

-- ── 15. Grants ──────────────────────────────────────────────────────────────
revoke all on public.suppliers, public.supplier_bank_accounts, public.retention_concepts,
              public.retention_rules, public.purchase_settings, public.purchase_orders,
              public.purchase_order_lines, public.goods_receipts, public.goods_receipt_lines,
              public.supplier_invoices, public.supplier_invoice_lines,
              public.supplier_credit_notes, public.supplier_credit_note_lines,
              public.landed_costs, public.landed_cost_allocations, public.landed_cost_variances,
              public.supplier_retentions, public.retention_receipts, public.supplier_payments
  from anon, authenticated, service_role, ladino_api, ladino_worker;

grant select on public.suppliers, public.supplier_bank_accounts, public.retention_concepts,
                public.retention_rules, public.purchase_settings, public.purchase_orders,
                public.purchase_order_lines, public.goods_receipts, public.goods_receipt_lines,
                public.supplier_invoices, public.supplier_invoice_lines,
                public.supplier_credit_notes, public.supplier_credit_note_lines,
                public.landed_costs, public.landed_cost_allocations,
                public.landed_cost_variances, public.supplier_retentions,
                public.retention_receipts, public.supplier_payments
  to authenticated;

grant select, insert, update on public.suppliers, public.supplier_bank_accounts,
                                public.retention_rules, public.purchase_settings,
                                public.purchase_orders, public.goods_receipts,
                                public.supplier_invoices, public.supplier_credit_notes,
                                public.landed_costs, public.supplier_retentions,
                                public.retention_receipts
  to ladino_api;
grant select, insert, update, delete on public.purchase_order_lines,
                                        public.goods_receipt_lines,
                                        public.supplier_invoice_lines,
                                        public.supplier_credit_note_lines
  to ladino_api;
-- Append-only de verdad: ni UPDATE ni DELETE por GRANT.
grant select, insert on public.landed_cost_allocations, public.landed_cost_variances,
                        public.supplier_payments
  to ladino_api;

-- Las funciones de `platform` no son ejecutables por PUBLIC. No es celo: una
-- función nueva sin revoke queda ejecutable por `anon`, y el test 005 lo
-- comprueba como PROPIEDAD sobre el catálogo —lo cazó con estas seis—.
revoke execute on function platform.compute_retention(numeric, text, numeric, numeric, numeric)
  from public;
revoke execute on function platform.purchase_order_progress(uuid, uuid) from public;
revoke execute on function platform.purchase_order_status(uuid, uuid) from public;
revoke execute on function platform.purchase_matching(uuid, uuid) from public;
revoke execute on function platform.supplier_invoice_balance(uuid, uuid) from public;
revoke execute on function platform.ap_aging(uuid, uuid, date) from public;
revoke execute on function platform.assert_purchase_doc_immutable() from public;
revoke execute on function platform.assert_purchase_lines_immutable() from public;
revoke execute on function platform.assert_retention_receipt_number() from public;

grant execute on function platform.resolve_retention(date, text, text, text, text, text)
  to ladino_api;
grant execute on function platform.compute_retention(numeric, text, numeric, numeric, numeric)
  to authenticated, ladino_api;
grant execute on function platform.claim_retention_receipt_number(uuid, text) to ladino_api;
grant execute on function platform.purchase_order_progress(uuid, uuid) to authenticated, ladino_api;
grant execute on function platform.purchase_order_status(uuid, uuid) to authenticated, ladino_api;
grant execute on function platform.purchase_matching(uuid, uuid) to authenticated, ladino_api;
grant execute on function platform.supplier_invoice_balance(uuid, uuid)
  to authenticated, ladino_api;
grant execute on function platform.ap_aging(uuid, uuid, date) to authenticated, ladino_api;

-- ── 16. Seeds: vocabulario SIN números ──────────────────────────────────────
-- Conceptos de retención. Son NOMBRES, no obligaciones: el porcentaje de cada
-- uno vive en retention_rules y la migración no siembra ninguno (ADR-0039).
insert into public.retention_concepts (code, retention_code, name, description) values
  ('iva_compras', 'iva', 'Retención de IVA en compras',
   'Retención del IVA soportado en la compra a un proveedor. El porcentaje aplicable depende del tipo de contribuyente y NO se siembra aquí. VALIDAR-TRIBUTARIO.'),
  ('islr_honorarios', 'islr', 'Honorarios profesionales',
   'Servicios profesionales no mercantiles. Porcentaje y sustraendo por tabla vigente. VALIDAR-TRIBUTARIO.'),
  ('islr_servicios', 'islr', 'Servicios en general',
   'Prestación de servicios distintos de honorarios profesionales. VALIDAR-TRIBUTARIO.'),
  ('islr_fletes', 'islr', 'Fletes y transporte',
   'Transporte de bienes por cuenta de la empresa. VALIDAR-TRIBUTARIO.'),
  ('islr_arrendamiento', 'islr', 'Arrendamiento de bienes',
   'Arrendamiento de bienes muebles o inmuebles. VALIDAR-TRIBUTARIO.'),
  ('islr_comisiones', 'islr', 'Comisiones',
   'Comisiones mercantiles pagadas a terceros. VALIDAR-TRIBUTARIO.')
on conflict (code) do nothing;

-- Permisos de compras.
insert into public.permissions (key, description, is_scoped) values
  ('supplier.manage',              'Crear y editar proveedores',                            false),
  ('supplier.bank_account.approve','Aprobar cuentas bancarias de proveedor para pagos',     false),
  ('purchase.order.manage',        'Crear y confirmar órdenes de compra',                   false),
  -- ACOTADO por almacén: recibir mercancía mueve stock, y quien recibe lo hace
  -- en los almacenes que tiene asignados (LAD25, la lección de inventario).
  ('purchase.receive',             'Recibir mercancía contra una orden o sin ella',         true),
  ('purchase.invoice.register',    'Registrar facturas de proveedor y calcular retenciones',false),
  ('purchase.price_variance.approve',
   'Aprobar una factura cuyo precio se sale del umbral acordado en la orden',               false),
  ('purchase.landed_cost.apply',   'Aplicar gastos de importación al costo de una recepción',false),
  ('purchase.payment.register',    'Registrar pagos a proveedor y aplicar retenciones',     false),
  ('purchase.credit_note.register','Registrar notas de crédito recibidas del proveedor',    false),
  ('ap.read',                      'Consultar cuentas por pagar, antigüedad y estado de cuenta', false),
  ('retention.rules.manage',       'Cargar reglas de retención con su fuente legal',        false),
  ('retention.receipt.issue',      'Emitir y anular comprobantes de retención',             false)
on conflict (key) do nothing;

-- ── 17. Lo que esta migración GARANTIZA sobre sí misma (LAD56) ──────────────
do $$
begin
  if (select count(*) from public.retention_rules) <> 0 then
    raise exception 'LAD56: retention_rules DEBE nacer vacía (ADR-0039): la migración no siembra porcentajes';
  end if;
  if (select count(*) from public.retention_concepts) <> 6 then
    raise exception 'LAD56: faltan conceptos de retención tras el seed';
  end if;
  if (select count(*) from public.permissions
       where key like 'purchase.%' or key like 'supplier.%' or key like 'retention.%'
          or key = 'ap.read') <> 12 then
    raise exception 'LAD56: faltan permisos de compras tras el seed';
  end if;
  -- Recibir mercancía mueve stock: su permiso TIENE que ser acotado, o un
  -- usuario con acceso a un almacén podría recibir en todos.
  if (select is_scoped from public.permissions where key = 'purchase.receive') is not true then
    raise exception 'LAD56: purchase.receive debe ser acotado por almacén (LAD25)';
  end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('suppliers','supplier_bank_accounts','purchase_settings',
                           'purchase_orders','purchase_order_lines','goods_receipts',
                           'goods_receipt_lines','supplier_invoices','supplier_invoice_lines',
                           'supplier_credit_notes','supplier_credit_note_lines','landed_costs',
                           'landed_cost_allocations','landed_cost_variances',
                           'supplier_retentions','retention_receipts','supplier_payments',
                           'retention_concepts','retention_rules')
         and c.relrowsecurity and c.relforcerowsecurity) <> 19 then
    raise exception 'LAD56: alguna tabla de compras no tiene RLS habilitada y forzada';
  end if;
  if (select count(*) from information_schema.role_table_grants
       where table_schema = 'public'
         and table_name in ('landed_cost_allocations','landed_cost_variances','supplier_payments')
         and grantee in ('anon','authenticated','service_role','ladino_api','ladino_worker')
         and privilege_type in ('UPDATE','DELETE','TRUNCATE')) <> 0 then
    raise exception 'LAD56: una tabla append-only de compras tiene privilegio de mutación';
  end if;
  -- El comprobante de retención tiene que caber en el rango fiscal, o ADR-0039
  -- §5 sería una intención sin mecanismo.
  if not exists (select 1 from pg_constraint
                  where conname = 'fiscal_number_ranges_kind_chk'
                    and pg_get_constraintdef(oid) like '%retention_receipt%') then
    raise exception 'LAD56: fiscal_number_ranges no admite retention_receipt';
  end if;
end $$;

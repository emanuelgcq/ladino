-- =============================================================================
-- Ladino — migración 25 · CONTABILIDAD: plan de cuentas, períodos, asientos de
--                          partida doble, mayor materializado y mapeo automático
--
-- Módulo: accounting  Spec: ADR-0041 (mapeo cerrado) · ADR-0042 (cola) ·
--                     ADR-0043 (plantillas de plan) · ADR-0020 (siete campos) ·
--                     ADR-0006 (append-only) · ADR-0029 (vigencia por fecha) ·
--                     ACCOUNTING_ENGINE_SPEC · JOURNAL_AND_CLOSING_SPEC ·
--                     VENEZUELA_ACCOUNTING_RULES
-- Reversible: SÍ mientras no haya un solo asiento POSTED. Con uno dentro, NO.
-- Homologación: SÍ — el mayor y el balance alimentan los libros fiscales.
--
-- ESTE ES EL MÓDULO DONDE SE COMPRUEBA SI LOS 24 ANTERIORES FUERON EN SERIO.
-- Si la partida doble no cuadra en el primer asiento, todo lo demás era teatro.
-- Por eso el invariante NO vive en la API: vive aquí, en un trigger, en moneda
-- funcional, y rechaza con código propio. Una aplicación se puede saltar; un
-- trigger con `force row level security` y sin GRANT de UPDATE, no.
--
-- LO QUE ESTA MIGRACIÓN NO HACE, y es deliberado:
--   · no siembra el plan de cuentas de NINGUNA empresa (ADR-0043): siembra UNA
--     plantilla global marcada VALIDAR-CONTABLE que hay que importar a mano;
--   · no siembra NI UNA plantilla de mapeo contable (ADR-0041): sin mapeo, el
--     documento entra en la cola de pendientes, no se inventa una cuenta;
--   · no evalúa NINGUNA expresión: `condition_kind` y `amount_source` son enums
--     cerrados, y un `grep` de SQL dinámico en el generador no encuentra nada;
--   · no implementa ajuste por inflación: deja la cuenta de reexpresión en la
--     plantilla y nada más;
--   · no concilia subledger contra cuenta de control: fuera de alcance,
--     declarado, y es el test natural siguiente.
-- =============================================================================

-- ── 1. Plan de cuentas ──────────────────────────────────────────────────────
create table public.accounts (
  id            uuid        primary key default platform.uuidv7(),
  tenant_id     uuid        not null,
  company_id    uuid        not null,
  code          text        not null,
  name          text        not null,
  description   text,
  parent_id     uuid,
  -- activo · pasivo · patrimonio · ingreso · gasto · orden
  kind          text        not null,
  -- deudora | acreedora. Se DERIVA de `kind` y se comprueba: una cuenta de
  -- activo con naturaleza acreedora es un error de carga, no una opción.
  nature        text        not null,
  -- Solo las HOJAS reciben asientos. Una cuenta padre agrupa.
  is_leaf       boolean     not null default true,
  is_active     boolean     not null default true,
  currency_code text,
  -- Si exige dimensiones analíticas (centro de costo, proyecto, tercero).
  requires_analytical boolean not null default false,
  -- Materialized path y profundidad: hacen barata la consulta de mayor por
  -- rama, que es la que más se pide. Los mantiene un trigger, no el llamante.
  level         integer     not null default 1,
  path          text        not null default '',

  created_by    uuid,
  created_at    timestamptz not null,
  version       integer     not null,
  rules_version text,

  constraint accounts_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint accounts_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint accounts_parent_fk
    foreign key (company_id, parent_id) references public.accounts (company_id, id),
  constraint accounts_currency_fk
    foreign key (currency_code) references public.currencies (code),
  constraint accounts_code_chk
    check (code = btrim(code) and length(code) between 1 and 40),
  constraint accounts_name_chk
    check (name = btrim(name) and length(name) between 1 and 200),
  constraint accounts_kind_chk
    check (kind in ('activo', 'pasivo', 'patrimonio', 'ingreso', 'gasto', 'orden')),
  constraint accounts_nature_chk check (nature in ('deudora', 'acreedora')),
  -- La naturaleza NO es libre: la impone el tipo. Activo y gasto son deudoras;
  -- pasivo, patrimonio e ingreso, acreedoras. Las de orden admiten ambas.
  constraint accounts_nature_coherent_chk check (
    kind = 'orden'
    or (kind in ('activo', 'gasto') and nature = 'deudora')
    or (kind in ('pasivo', 'patrimonio', 'ingreso') and nature = 'acreedora')),
  constraint accounts_level_chk check (level between 1 and 10),
  -- Una raíz no tiene padre y está en el nivel 1; lo contrario también.
  constraint accounts_root_chk check ((parent_id is null) = (level = 1)),
  constraint accounts_company_code_key unique (company_id, code),
  constraint accounts_company_id_key unique (company_id, id)
);
create index accounts_company_path_idx on public.accounts (company_id, path);
create index accounts_parent_idx on public.accounts (company_id, parent_id)
  where parent_id is not null;
comment on table public.accounts is
  'Plan de cuentas POR EMPRESA. Nace VACÍO (ADR-0043): el plan de cuentas no se '
  'hard-codea (VENEZUELA_ACCOUNTING_RULES). Solo las hojas activas reciben asientos.';

-- ── 2. Papeles contables por empresa, versionables por fecha ────────────────
-- La plantilla de mapeo no nombra una CUENTA: nombra un PAPEL (ADR-0041). Qué
-- cuenta cumple ese papel lo dice cada empresa, y puede cambiar con el tiempo
-- sin reescribir los asientos que ya lo resolvieron.
create table public.account_purposes (
  code        text primary key,
  name        text not null,
  description text not null,
  constraint account_purposes_code_chk check (code ~ '^[a-z][a-z0-9_]{0,49}$')
);

create table public.company_account_settings (
  id             uuid        primary key default platform.uuidv7(),
  tenant_id      uuid        not null,
  company_id     uuid        not null,
  purpose        text        not null,
  account_id     uuid        not null,
  effective_from timestamptz not null default now(),
  effective_to   timestamptz,

  created_by     uuid,
  created_at     timestamptz not null,
  version        integer     not null,

  constraint company_account_settings_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint company_account_settings_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint company_account_settings_purpose_fk
    foreign key (purpose) references public.account_purposes (code),
  constraint company_account_settings_account_fk
    foreign key (company_id, account_id) references public.accounts (company_id, id),
  constraint company_account_settings_period_chk
    check (effective_to is null or effective_to > effective_from),
  constraint company_account_settings_company_id_key unique (company_id, id),
  -- Un papel, una cuenta, en cada instante. Dos cuentas de IVA débito fiscal
  -- vigentes a la vez es un asiento que no se sabe dónde va.
  constraint company_account_settings_no_overlap exclude using gist (
    company_id with =, purpose with =,
    tstzrange(effective_from, effective_to, '[)') with &&)
);

-- ── 3. Períodos contables ───────────────────────────────────────────────────
create table public.fiscal_periods (
  id              uuid        primary key default platform.uuidv7(),
  tenant_id       uuid        not null,
  company_id      uuid        not null,
  year            integer     not null,
  month           integer     not null,
  status          text        not null default 'open',
  closed_at       timestamptz,
  closed_by       uuid,
  reopened_at     timestamptz,
  reopened_by     uuid,
  -- OBLIGATORIO al reabrir. Una reapertura sin motivo escrito es exactamente
  -- lo que una fiscalización pregunta y nadie sabe contestar.
  reopened_reason text,

  created_by      uuid,
  created_at      timestamptz not null,
  version         integer     not null,

  constraint fiscal_periods_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint fiscal_periods_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint fiscal_periods_year_chk check (year between 2000 and 2200),
  constraint fiscal_periods_month_chk check (month between 1 and 12),
  constraint fiscal_periods_status_chk check (status in ('open', 'closing', 'closed', 'reopened')),
  constraint fiscal_periods_closed_chk
    check ((status = 'closed') = (closed_at is not null and closed_by is not null)),
  constraint fiscal_periods_reopened_chk check (
    (status = 'reopened') = (reopened_at is not null and reopened_by is not null)
    and (reopened_at is null or length(btrim(coalesce(reopened_reason, ''))) >= 10)),
  constraint fiscal_periods_company_key unique (company_id, year, month),
  constraint fiscal_periods_company_id_key unique (company_id, id)
);

-- ── 4. Asientos ─────────────────────────────────────────────────────────────
create table public.journal_entries (
  id             uuid        primary key default platform.uuidv7(),
  tenant_id      uuid        not null,
  company_id     uuid        not null,
  period_id      uuid        not null,
  -- Correlativo por (empresa, año). Sin huecos, y SE CONSERVA al reversar: la
  -- misma regla del correlativo fiscal (ADR-0037), por la misma razón.
  entry_number   bigint,
  posting_date   date        not null,
  -- manual + el vocabulario de los módulos que generan asientos.
  source_kind    text        not null,
  source_id      uuid,
  -- ADR-0042 §Idempotencia: el EVENTO, con el vocabulario del outbox. Sin este
  -- eje, una factura no podría asentarse al emitirse Y al cobrarse.
  source_event   text,
  description    text        not null,
  memo           text,
  status         text        not null default 'draft',
  posted_at      timestamptz,
  posted_by      uuid,
  -- La cadena de reversiones, en las dos direcciones.
  is_reversal_of      uuid,
  reversed_by_entry_id uuid,

  rules_version  text,
  created_by     uuid,
  created_at     timestamptz not null,
  version        integer     not null,

  constraint journal_entries_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint journal_entries_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint journal_entries_period_fk
    foreign key (company_id, period_id) references public.fiscal_periods (company_id, id),
  constraint journal_entries_reversal_fk
    foreign key (company_id, is_reversal_of) references public.journal_entries (company_id, id),
  constraint journal_entries_reversed_by_fk
    foreign key (company_id, reversed_by_entry_id) references public.journal_entries (company_id, id),
  constraint journal_entries_source_kind_chk check (source_kind in (
    'manual', 'sales_invoice', 'sales_credit_note', 'payment_received',
    'purchase_invoice', 'purchase_credit_note', 'payment_made', 'goods_receipt',
    'inventory_move', 'retention_receipt', 'landed_cost', 'landed_cost_variance',
    'exchange_diff', 'period_close', 'year_end_close')),
  constraint journal_entries_status_chk check (status in ('draft', 'posted', 'reversed')),
  -- Un asiento POSTEADO tiene número, fecha de posteo y quién lo posteó. Un
  -- borrador, ninguna de las tres.
  constraint journal_entries_posted_shape_chk check (
    (status = 'draft' and entry_number is null and posted_at is null and posted_by is null)
    or (status in ('posted', 'reversed')
        and entry_number is not null and posted_at is not null and posted_by is not null)),
  constraint journal_entries_description_chk check (length(btrim(description)) between 3 and 500),
  -- Un asiento automático dice de qué documento y de qué hecho viene. Un
  -- manual no tiene origen y por eso no lo declara.
  constraint journal_entries_source_shape_chk check (
    (source_kind = 'manual' and source_id is null and source_event is null)
    or (source_kind <> 'manual' and source_id is not null and source_event is not null)),
  constraint journal_entries_no_self_reversal_chk check (
    is_reversal_of is distinct from id and reversed_by_entry_id is distinct from id),
  constraint journal_entries_company_id_key unique (company_id, id)
);
create unique index journal_entries_number_key
  on public.journal_entries (company_id, (extract(year from posting_date)::int), entry_number)
  where entry_number is not null;
-- ADR-0042: la idempotencia contable, atada al evento del outbox.
create unique index journal_entries_source_event_key
  on public.journal_entries (company_id, source_kind, source_id, source_event)
  where source_id is not null and status <> 'reversed';
create index journal_entries_period_idx on public.journal_entries (company_id, period_id, status);
create index journal_entries_date_idx on public.journal_entries (company_id, posting_date);

create table public.journal_lines (
  id            uuid        primary key default platform.uuidv7(),
  tenant_id     uuid        not null,
  company_id    uuid        not null,
  entry_id      uuid        not null,
  line_number   integer     not null,
  account_id    uuid        not null,
  -- Débito O crédito, nunca los dos. El CHECK lo impone.
  debit_amount  numeric(24,8) not null default 0,
  credit_amount numeric(24,8) not null default 0,

  -- Los SIETE campos de ADR-0020, en cada línea, aunque sea en moneda
  -- funcional con tasa 1: una línea es el nivel al que se reproduce un cálculo.
  amount_transaction_currency numeric(24,8) not null,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null default 1,
  functional_amount           numeric(24,8) not null,
  functional_currency         text          not null,
  rate_source                 text          not null default 'identidad',
  rate_timestamp              timestamptz   not null default now(),
  rounding_policy_id          text          not null default 'accounting:entry:8:HALF_UP',

  -- El importe en moneda FUNCIONAL, que es donde se comprueba la partida
  -- doble. Separado de debit/credit porque esos van en moneda de transacción.
  functional_debit  numeric(24,8) not null default 0,
  functional_credit numeric(24,8) not null default 0,

  -- Centro de costo, proyecto, tercero. jsonb genérico por decisión: si
  -- aparece necesidad de tabla propia, sale a su módulo (divergencia
  -- consciente de COST_CENTERS_SPEC, anotada).
  analytical_dimensions jsonb,
  description   text,

  created_by    uuid,
  created_at    timestamptz not null,
  version       integer     not null,

  constraint journal_lines_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint journal_lines_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint journal_lines_entry_fk
    foreign key (company_id, entry_id) references public.journal_entries (company_id, id),
  constraint journal_lines_account_fk
    foreign key (company_id, account_id) references public.accounts (company_id, id),
  constraint journal_lines_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint journal_lines_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint journal_lines_side_chk check (
    debit_amount >= 0 and credit_amount >= 0
    and (debit_amount = 0) <> (credit_amount = 0)),
  constraint journal_lines_functional_side_chk check (
    functional_debit >= 0 and functional_credit >= 0
    -- El lado funcional es el MISMO lado que el de transacción. Una línea que
    -- debita en dólares y acredita en bolívares no es una conversión: es un
    -- error que cuadraría el asiento por accidente.
    and (debit_amount > 0) = (functional_debit > 0)
    and (credit_amount > 0) = (functional_credit > 0)),
  constraint journal_lines_fx_chk check (fx_rate > 0),
  constraint journal_lines_dimensions_chk
    check (analytical_dimensions is null
           or (jsonb_typeof(analytical_dimensions) = 'object'
               and platform.is_flat_string_object(analytical_dimensions))),
  constraint journal_lines_number_key unique (entry_id, line_number),
  constraint journal_lines_company_id_key unique (company_id, id)
);
create index journal_lines_account_idx on public.journal_lines (company_id, account_id);
create index journal_lines_entry_idx on public.journal_lines (entry_id);
comment on table public.journal_lines is
  'Líneas de asiento. APPEND-ONLY en dos capas cuando el asiento está posteado '
  '(CLAUDE.md §2 la nombra por este nombre). La partida doble se comprueba en '
  'MONEDA FUNCIONAL, con un trigger, no en la API.';

-- ── 5. Mayor materializado ──────────────────────────────────────────────────
-- Mismo patrón que `stock_balances` (ADR-0034): se materializa por trigger en
-- la misma transacción, y existe una función que lo reproduce desde los
-- asientos crudos. Un test compara las dos, y es el que de verdad protege.
create table public.ledger_balances (
  id            uuid        primary key default platform.uuidv7(),
  tenant_id     uuid        not null,
  company_id    uuid        not null,
  account_id    uuid        not null,
  period_id     uuid        not null,
  debit_total   numeric(24,8) not null default 0,
  credit_total  numeric(24,8) not null default 0,
  functional_currency text    not null,

  created_by    uuid,
  created_at    timestamptz not null,
  version       integer     not null,

  constraint ledger_balances_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint ledger_balances_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint ledger_balances_account_fk
    foreign key (company_id, account_id) references public.accounts (company_id, id),
  constraint ledger_balances_period_fk
    foreign key (company_id, period_id) references public.fiscal_periods (company_id, id),
  constraint ledger_balances_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint ledger_balances_amounts_chk check (debit_total >= 0 and credit_total >= 0),
  constraint ledger_balances_key unique (company_id, account_id, period_id),
  constraint ledger_balances_company_id_key unique (company_id, id)
);

-- ── 6. Mapeo contable: vocabulario CERRADO (ADR-0041) ───────────────────────
create table public.journal_templates (
  id            uuid        primary key default platform.uuidv7(),
  tenant_id     uuid        not null,
  company_id    uuid        not null,
  source_kind   text        not null,
  -- El evento del outbox al que responde. Misma clave que la idempotencia.
  source_event  text        not null,
  description   text        not null,
  is_active     boolean     not null default true,
  effective_from timestamptz not null default now(),
  effective_to  timestamptz,

  created_by    uuid,
  created_at    timestamptz not null,
  version       integer     not null,

  constraint journal_templates_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint journal_templates_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint journal_templates_source_kind_chk check (source_kind in (
    'sales_invoice', 'sales_credit_note', 'payment_received', 'purchase_invoice',
    'purchase_credit_note', 'payment_made', 'goods_receipt', 'inventory_move',
    'retention_receipt', 'landed_cost', 'landed_cost_variance', 'exchange_diff')),
  -- Una plantilla sin explicación es un asiento que nadie sabrá justificar.
  constraint journal_templates_description_chk check (length(btrim(description)) between 3 and 500),
  constraint journal_templates_period_chk check (effective_to is null or effective_to > effective_from),
  constraint journal_templates_company_id_key unique (company_id, id),
  constraint journal_templates_no_overlap exclude using gist (
    company_id with =, source_kind with =, source_event with =,
    tstzrange(effective_from, effective_to, '[)') with &&)
    where (is_active)
);

create table public.journal_template_lines (
  id            uuid        primary key default platform.uuidv7(),
  tenant_id     uuid        not null,
  company_id    uuid        not null,
  template_id   uuid        not null,
  line_number   integer     not null,
  -- ADR-0041: la línea nombra un PAPEL, no una cuenta.
  account_purpose text      not null,
  -- Y de dónde sale el importe: un enum, no un campo libre. Un `text` aquí
  -- sería «lee esta clave del JSON del documento», o sea acceso dinámico a
  -- datos del cliente desde una tabla de configuración.
  amount_source text        not null,
  side          text        not null,
  -- El predicado. Ocho preguntas que el motor sabe contestar, y ninguna más.
  condition_kind text       not null default 'always',
  description   text,

  created_by    uuid,
  created_at    timestamptz not null,
  version       integer     not null,

  constraint journal_template_lines_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint journal_template_lines_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint journal_template_lines_template_fk
    foreign key (company_id, template_id) references public.journal_templates (company_id, id),
  constraint journal_template_lines_purpose_fk
    foreign key (account_purpose) references public.account_purposes (code),
  constraint journal_template_lines_amount_chk check (amount_source in (
    'subtotal', 'tax_amount', 'total', 'retained_iva', 'retained_islr',
    'retained_total', 'net_amount', 'cost_amount', 'landed_to_inventory',
    'landed_to_variance', 'exchange_difference', 'functional_amount')),
  constraint journal_template_lines_side_chk check (side in ('debit', 'credit')),
  constraint journal_template_lines_condition_chk check (condition_kind in (
    'always', 'if_amount_nonzero', 'if_tax_recoverable', 'if_tax_not_recoverable',
    'if_supplier_foreign', 'if_supplier_national', 'if_positive', 'if_negative')),
  constraint journal_template_lines_number_key unique (template_id, line_number),
  constraint journal_template_lines_company_id_key unique (company_id, id)
);

-- ── 7. Cola de contabilización pendiente (ADR-0042) ─────────────────────────
create table public.journal_generation_queue (
  id            uuid        primary key default platform.uuidv7(),
  tenant_id     uuid        not null,
  company_id    uuid        not null,
  source_kind   text        not null,
  source_id     uuid        not null,
  source_event  text        not null,
  -- El contexto MONETARIO congelado del documento. Lo que no puede cambiar.
  -- El mapeo sí puede haber cambiado cuando se procese, y eso queda en el
  -- asiento con su rules_version (ADR-0042 §Consecuencias).
  context       jsonb       not null,
  reason        text        not null,
  status        text        not null default 'pending',
  generated_entry_id uuid,
  processed_at  timestamptz,

  created_by    uuid,
  created_at    timestamptz not null,
  version       integer     not null,

  constraint journal_generation_queue_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint journal_generation_queue_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint journal_generation_queue_entry_fk
    foreign key (company_id, generated_entry_id) references public.journal_entries (company_id, id),
  constraint journal_generation_queue_status_chk
    check (status in ('pending', 'generated', 'discarded')),
  constraint journal_generation_queue_generated_chk
    check ((status = 'generated') = (generated_entry_id is not null and processed_at is not null)),
  constraint journal_generation_queue_context_chk check (jsonb_typeof(context) = 'object'),
  constraint journal_generation_queue_reason_chk check (length(btrim(reason)) between 3 and 500),
  -- Un hecho, una fila. Encolar dos veces el mismo evento generaría dos asientos.
  constraint journal_generation_queue_once_key unique (company_id, source_kind, source_id, source_event),
  constraint journal_generation_queue_company_id_key unique (company_id, id)
);
create index journal_generation_queue_pending_idx
  on public.journal_generation_queue (company_id, created_at)
  where status = 'pending';
comment on table public.journal_generation_queue is
  'ADR-0042: documentos emitidos sin plantilla de mapeo. El INVARIANTE es que '
  'todo documento posteado tiene asiento O fila pendiente aquí — nunca ninguno '
  'de los dos, nunca los dos a la vez. Un período no se cierra con pendientes.';

-- ── 8. Plantillas de plan de cuentas: catálogo GLOBAL (ADR-0043) ────────────
create table public.chart_templates (
  code        text primary key,
  name        text not null,
  description text not null,
  framework   text not null,
  legal_source text not null,
  status      text not null default 'active',
  constraint chart_templates_code_chk check (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint chart_templates_status_chk check (status in ('active', 'inactive'))
);

create table public.chart_template_accounts (
  id            uuid    primary key default platform.uuidv7(),
  template_code text    not null,
  code          text    not null,
  name          text    not null,
  parent_code   text,
  kind          text    not null,
  nature        text    not null,
  is_leaf       boolean not null default true,
  level         integer not null,
  -- La plantilla PROPONE qué papel cumpliría; la empresa dispone (ADR-0043).
  suggested_purpose text,
  constraint chart_template_accounts_template_fk
    foreign key (template_code) references public.chart_templates (code),
  constraint chart_template_accounts_purpose_fk
    foreign key (suggested_purpose) references public.account_purposes (code),
  constraint chart_template_accounts_kind_chk
    check (kind in ('activo', 'pasivo', 'patrimonio', 'ingreso', 'gasto', 'orden')),
  constraint chart_template_accounts_nature_chk check (nature in ('deudora', 'acreedora')),
  constraint chart_template_accounts_level_chk check (level between 1 and 10),
  constraint chart_template_accounts_key unique (template_code, code)
);

-- ── 9. El gancho bidireccional en los documentos (ADR-0042) ─────────────────
-- El asiento apunta al documento y el documento al asiento. La redundancia es
-- deliberada: «¿qué asiento generó esta factura?» es la pregunta que más se
-- hace en una auditoría, y recorrer journal_entries para contestarla es caro.
alter table public.documents          add column journal_entry_id uuid;
alter table public.supplier_invoices  add column journal_entry_id uuid;
alter table public.supplier_payments  add column journal_entry_id uuid;
alter table public.payments           add column journal_entry_id uuid;
alter table public.goods_receipts     add column journal_entry_id uuid;
alter table public.landed_costs       add column journal_entry_id uuid;
alter table public.retention_receipts add column journal_entry_id uuid;

-- ── 10. Funciones ───────────────────────────────────────────────────────────

-- El materialized path y el nivel, mantenidos por el esquema y no por el
-- llamante: un path escrito a mano diverge del árbol en el tercer movimiento.
create function platform.set_account_path()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent public.accounts;
begin
  if new.parent_id is null then
    new.level := 1;
    new.path  := new.code;
    return new;
  end if;
  select * into v_parent from public.accounts
   where id = new.parent_id and company_id = new.company_id;
  if v_parent.id is null then
    raise exception 'la cuenta padre no pertenece a esta empresa' using errcode = '23503';
  end if;
  -- Sin ciclos (CHART_OF_ACCOUNTS_SPEC): si el padre desciende de mí, es un
  -- ciclo. El path lo hace comprobable con un LIKE en vez de un recorrido.
  if v_parent.path like new.code || '/%' or v_parent.path = new.code then
    raise exception 'la jerarquía de cuentas no admite ciclos: % ya desciende de %',
      v_parent.code, new.code using errcode = 'LAD60';
  end if;
  new.level := v_parent.level + 1;
  -- El separador es '/' y no '.', porque un CÓDIGO de cuenta puede llevar
  -- puntos ('1.1.01' es lo normal) y entonces el path dejaría de ser
  -- descomponible: '1.1.01' podría ser una cuenta o tres niveles.
  new.path  := v_parent.path || '/' || new.code;
  -- Un padre deja de ser hoja en cuanto tiene un hijo. Que lo haga el esquema
  -- evita el estado imposible «cuenta hoja con descendencia» que aceptaría
  -- asientos y agregaría los de sus hijos.
  update public.accounts set is_leaf = false
   where id = new.parent_id and is_leaf;
  return new;
end;
$$;
revoke execute on function platform.set_account_path() from public;

-- El período al que pertenece una fecha. Si no existe, se crea abierto: un
-- asiento de un mes futuro no debería fallar por no haber pulsado «crear mes».
create function platform.period_for_date(p_company uuid, p_fecha date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_tenant uuid;
begin
  select id into v_id from public.fiscal_periods
   where company_id = p_company
     and year = extract(year from p_fecha)::int
     and month = extract(month from p_fecha)::int;
  if v_id is not null then return v_id; end if;
  select tenant_id into v_tenant from public.companies where id = p_company;
  insert into public.fiscal_periods (tenant_id, company_id, year, month, status)
  values (v_tenant, p_company, extract(year from p_fecha)::int,
          extract(month from p_fecha)::int, 'open')
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function platform.period_for_date(uuid, date) from public;

/**
 * EL INVARIANTE. Partida doble en MONEDA FUNCIONAL, comprobada en Postgres.
 *
 * Vive aquí y no en la API porque es un invariante del DATO. Una aplicación se
 * puede saltar —otro servicio, un script, un `psql`—; un trigger no. Y se
 * comprueba en funcional, no en moneda de transacción: un asiento con líneas en
 * dólares y bolívares cuadraría o no según qué se sume, y lo que tiene que
 * cuadrar es lo que va al mayor.
 */
create function platform.assert_entry_balanced()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_debit  numeric;
  v_credit numeric;
  v_lines  integer;
  v_period public.fiscal_periods;
  l        record;
begin
  if new.status <> 'posted' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'posted' then return new; end if;

  select count(*), coalesce(sum(functional_debit), 0), coalesce(sum(functional_credit), 0)
    into v_lines, v_debit, v_credit
    from public.journal_lines where entry_id = new.id;

  if v_lines < 2 then
    raise exception 'un asiento de partida doble necesita al menos dos líneas; tiene %', v_lines
      using errcode = 'LAD59';
  end if;
  if v_debit <> v_credit then
    raise exception
      'la partida doble no cuadra en moneda funcional: débitos % ≠ créditos % (diferencia %)',
      v_debit, v_credit, v_debit - v_credit
      using errcode = 'LAD59',
            hint = 'la diferencia se comprueba en moneda funcional, que es la que va al mayor';
  end if;
  if v_debit = 0 then
    raise exception 'un asiento de importe cero no es un hecho contable' using errcode = 'LAD59';
  end if;

  -- El período tiene que estar abierto A LA FECHA DEL ASIENTO.
  select * into v_period from public.fiscal_periods
   where id = new.period_id and company_id = new.company_id;
  if v_period.status = 'closed' then
    raise exception
      'el período %-% está CERRADO: no admite asientos. Reabrirlo exige permiso y motivo escrito',
      v_period.year, v_period.month
      using errcode = 'LAD61';
  end if;

  -- Y cada línea tiene que ir a una cuenta que admita movimiento.
  for l in
    select jl.account_id, jl.analytical_dimensions, a.is_leaf, a.is_active,
           a.requires_analytical, a.code
      from public.journal_lines jl
      join public.accounts a on a.id = jl.account_id
     where jl.entry_id = new.id
  loop
    if not l.is_leaf then
      raise exception
        'la cuenta % agrupa y no recibe asientos: usa una de sus hojas', l.code
        using errcode = 'LAD62';
    end if;
    if not l.is_active then
      raise exception 'la cuenta % está desactivada', l.code using errcode = 'LAD62';
    end if;
    if l.requires_analytical
       and (l.analytical_dimensions is null or l.analytical_dimensions = '{}'::jsonb) then
      raise exception
        'la cuenta % exige dimensiones analíticas y la línea no las trae', l.code
        using errcode = 'LAD62';
    end if;
  end loop;
  return new;
end;
$$;
revoke execute on function platform.assert_entry_balanced() from public;

-- El correlativo del asiento: por (empresa, año), sin huecos, conservado al
-- reversar. La misma mecánica de ADR-0037 y por la misma razón.
create function platform.claim_entry_number(p_company uuid, p_year integer)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company::text || '|journal|' || p_year::text, 0));
  select coalesce(max(e.entry_number), 0) + 1 into v_next
    from public.journal_entries e
   where e.company_id = p_company
     and extract(year from e.posting_date)::int = p_year
     and e.entry_number is not null;
  return v_next;
end;
$$;
revoke execute on function platform.claim_entry_number(uuid, integer) from public;

-- El mayor materializado, mantenido en la MISMA transacción del asiento.
/**
 * El mayor se alimenta al POSTEAR el asiento, no al insertar sus líneas.
 *
 * La primera versión colgaba de un AFTER INSERT en `journal_lines`, y el mayor
 * quedaba SIEMPRE vacío: las líneas se insertan mientras el asiento es un
 * borrador —es la única forma de construirlo— y en ese momento el trigger salía
 * en la primera línea porque «un borrador no es un hecho». Lo cazó el test que
 * compara el materializado con el recalculado, que existe exactamente para eso.
 *
 * El hecho contable es POSTEAR, no escribir una línea. Ahí es donde va.
 */
create function platform.apply_ledger_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_funcional text;
begin
  -- Solo la TRANSICIÓN a posteado. Un asiento que ya lo estaba y cambia de
  -- estado a 'reversed' no vuelve a sumar: su reversión es otro asiento.
  if new.status not in ('posted', 'reversed') then return new; end if;
  if tg_op = 'UPDATE' and old.status in ('posted', 'reversed') then return new; end if;

  select functional_currency_code into v_funcional from public.companies
   where id = new.company_id;

  insert into public.ledger_balances
    (tenant_id, company_id, account_id, period_id, debit_total, credit_total, functional_currency)
  select new.tenant_id, new.company_id, jl.account_id, new.period_id,
         jl.functional_debit, jl.functional_credit, v_funcional
    from public.journal_lines jl
   where jl.entry_id = new.id
  on conflict (company_id, account_id, period_id) do update
    set debit_total  = public.ledger_balances.debit_total  + excluded.debit_total,
        credit_total = public.ledger_balances.credit_total + excluded.credit_total;
  return new;
end;
$$;
revoke execute on function platform.apply_ledger_balance() from public;

-- Y la REPRODUCCIÓN desde los asientos crudos. Existe para que el materializado
-- sea comprobable, no para consultarlo: es el mismo par que `stock_balances` y
-- `recompute_stock` (ADR-0034), y el test que los compara es el que protege.
create function platform.recompute_ledger(
  p_company uuid, p_account uuid, p_from date default null, p_to date default null
)
returns table (debit_total numeric, credit_total numeric, balance numeric)
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(jl.functional_debit), 0),
         coalesce(sum(jl.functional_credit), 0),
         coalesce(sum(jl.functional_debit), 0) - coalesce(sum(jl.functional_credit), 0)
    from public.journal_lines jl
    join public.journal_entries e on e.id = jl.entry_id
   where jl.company_id = p_company and jl.account_id = p_account
     and e.status in ('posted', 'reversed')
     and (p_from is null or e.posting_date >= p_from)
     and (p_to   is null or e.posting_date <= p_to)
$$;

-- El balance de comprobación A FECHA. La fecha es PARÁMETRO, nunca `now()` —
-- la misma regla que `price_at` y `stock_at`: un reporte que no se puede
-- reproducir mañana no es un reporte.
create function platform.trial_balance(p_company uuid, p_date date, p_from date default null)
returns table (
  account_id uuid, account_code text, account_name text, nature text,
  opening_balance numeric, period_debit numeric, period_credit numeric, closing_balance numeric
)
language sql
stable
set search_path = ''
as $$
  select a.id, a.code, a.name, a.nature,
         coalesce(sum(jl.functional_debit - jl.functional_credit)
                  filter (where p_from is not null and e.posting_date < p_from), 0),
         coalesce(sum(jl.functional_debit)
                  filter (where p_from is null or e.posting_date >= p_from), 0),
         coalesce(sum(jl.functional_credit)
                  filter (where p_from is null or e.posting_date >= p_from), 0),
         coalesce(sum(jl.functional_debit - jl.functional_credit), 0)
    from public.accounts a
    join public.journal_lines jl on jl.account_id = a.id
    join public.journal_entries e on e.id = jl.entry_id
   where a.company_id = p_company
     and e.status in ('posted', 'reversed')
     and e.posting_date <= p_date
   group by a.id, a.code, a.name, a.nature
  having coalesce(sum(jl.functional_debit - jl.functional_credit), 0) <> 0
      or coalesce(sum(jl.functional_debit), 0) <> 0
   order by a.code
$$;

/**
 * EL INVARIANTE DE ADR-0042, como consulta.
 *
 * Devuelve los documentos posteados que NO tienen asiento NI fila pendiente
 * (`missing`) y los que tienen las DOS (`duplicated`). Vacío es lo correcto.
 * Que sea una función y no un comentario en un ADR es lo que la convierte en
 * algo que un test puede poner en rojo.
 */
create function platform.accounting_coverage_gaps(p_company uuid)
returns table (source_kind text, source_id uuid, problem text)
language sql
stable
set search_path = ''
as $$
  with documentos as (
    select 'sales_invoice'::text as k, d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'invoice' and d.status in ('issued', 'paid')
    union all
    select 'purchase_invoice', i.id, i.journal_entry_id
      from public.supplier_invoices i
     where i.company_id = p_company and i.status in ('posted', 'paid')
  ),
  estado as (
    select d.k, d.id,
           d.journal_entry_id is not null as tiene_asiento,
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.source_id = d.id
                      and q.status = 'pending') as tiene_pendiente
      from documentos d
  )
  select k, id,
         case when not tiene_asiento and not tiene_pendiente then 'missing'
              else 'duplicated' end
    from estado
   where (not tiene_asiento and not tiene_pendiente)
      or (tiene_asiento and tiene_pendiente)
$$;

-- ── 11. Triggers ────────────────────────────────────────────────────────────
create trigger accounts_00_provenance
  before insert or update on public.accounts
  for each row execute function platform.set_row_provenance();
create trigger accounts_01_anchors
  before update on public.accounts
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger accounts_02_path
  before insert on public.accounts
  for each row execute function platform.set_account_path();

create trigger company_account_settings_00_provenance
  before insert or update on public.company_account_settings
  for each row execute function platform.set_row_provenance();
create trigger company_account_settings_01_anchors
  before update on public.company_account_settings
  for each row execute function platform.assert_isolation_anchors_immutable();

create trigger fiscal_periods_00_provenance
  before insert or update on public.fiscal_periods
  for each row execute function platform.set_row_provenance();
create trigger fiscal_periods_01_anchors
  before update on public.fiscal_periods
  for each row execute function platform.assert_isolation_anchors_immutable();

create trigger journal_entries_00_provenance
  before insert or update on public.journal_entries
  for each row execute function platform.set_row_provenance();
create trigger journal_entries_01_anchors
  before update on public.journal_entries
  for each row execute function platform.assert_isolation_anchors_immutable();
-- El invariante, en INSERT **y** en UPDATE. Solo en UPDATE dejaría la puerta
-- grande abierta: un INSERT directo con status='posted' se saltaría la partida
-- doble entera. Es la misma lección del trigger de emisión fiscal (ADR-0037).
create trigger journal_entries_02_balanced
  before insert or update on public.journal_entries
  for each row execute function platform.assert_entry_balanced();

create trigger journal_lines_00_provenance
  before insert or update on public.journal_lines
  for each row execute function platform.set_row_provenance();
create trigger journal_lines_01_anchors
  before update on public.journal_lines
  for each row execute function platform.assert_isolation_anchors_immutable();


create trigger ledger_balances_00_provenance
  before insert or update on public.ledger_balances
  for each row execute function platform.set_row_provenance();
create trigger ledger_balances_01_anchors
  before update on public.ledger_balances
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger journal_templates_00_provenance
  before insert or update on public.journal_templates
  for each row execute function platform.set_row_provenance();
create trigger journal_templates_01_anchors
  before update on public.journal_templates
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger journal_template_lines_00_provenance
  before insert or update on public.journal_template_lines
  for each row execute function platform.set_row_provenance();
create trigger journal_template_lines_01_anchors
  before update on public.journal_template_lines
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger journal_generation_queue_00_provenance
  before insert or update on public.journal_generation_queue
  for each row execute function platform.set_row_provenance();
create trigger journal_generation_queue_01_anchors
  before update on public.journal_generation_queue
  for each row execute function platform.assert_isolation_anchors_immutable();

-- APPEND-ONLY DE VERDAD, en las dos capas de ADR-0006. Capa 1: sin GRANT de
-- UPDATE ni DELETE sobre las líneas (abajo). Capa 2: estos triggers, que
-- rechazan incluso al superusuario.
create function platform.assert_entry_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' then return old; end if;
    raise exception 'un asiento posteado no se borra: se reversa con un contra-asiento'
      using errcode = 'LAD06';
  end if;
  if old.status = 'draft' then return new; end if;
  -- Ya está posteado. Lo único que puede cambiar es el enlace de reversión y
  -- el paso a `reversed`; todo lo demás sería reescribir un hecho.
  if to_jsonb(old) - 'status' - 'version' - 'reversed_by_entry_id'
   <> to_jsonb(new) - 'status' - 'version' - 'reversed_by_entry_id' then
    raise exception
      'un asiento posteado no se edita: corrige con un asiento de reversión (ADR-0006)'
      using errcode = 'LAD06';
  end if;
  if not (old.status = 'posted' and new.status in ('posted', 'reversed')) then
    raise exception 'transición de estado no permitida en un asiento posteado: % → %',
      old.status, new.status using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
create trigger journal_entries_04_ledger
  after insert or update on public.journal_entries
  for each row execute function platform.apply_ledger_balance();

create trigger journal_entries_03_immutable
  before update or delete on public.journal_entries
  for each row execute function platform.assert_entry_immutable();
create trigger journal_entries_no_truncate
  before truncate on public.journal_entries
  for each statement execute function platform.reject_mutation();

create function platform.assert_line_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status from public.journal_entries
   where id = coalesce(old.entry_id, new.entry_id);
  if v_status = 'draft' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception
    'las líneas de un asiento posteado no se editan ni se borran: el asiento entero es el hecho'
    using errcode = 'LAD06';
end;
$$;
create trigger journal_lines_03_immutable
  before update or delete on public.journal_lines
  for each row execute function platform.assert_line_immutable();
create trigger journal_lines_no_truncate
  before truncate on public.journal_lines
  for each statement execute function platform.reject_mutation();
create trigger ledger_balances_no_truncate
  before truncate on public.ledger_balances
  for each statement execute function platform.reject_mutation();

-- ── 12. RLS ─────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['accounts', 'company_account_settings', 'fiscal_periods',
                           'journal_entries', 'journal_lines', 'ledger_balances',
                           'journal_templates', 'journal_template_lines',
                           'journal_generation_queue']
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

alter table public.account_purposes        enable row level security;
alter table public.account_purposes        force  row level security;
alter table public.chart_templates         enable row level security;
alter table public.chart_templates         force  row level security;
alter table public.chart_template_accounts enable row level security;
alter table public.chart_template_accounts force  row level security;
do $$
declare t text;
begin
  foreach t in array array['account_purposes', 'chart_templates', 'chart_template_accounts']
  loop
    -- Catálogos GLOBALES de solo lectura: se cargan con migraciones, no por API
    -- (ADR-0043). La denegación de escritura va POR ESCRITO, no por omisión.
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

-- DELETE para ladino_api: solo borradores. Lo posteado es hecho consumado.
create policy accounts_api_delete on public.accounts for delete to ladino_api
  using (false);
create policy company_account_settings_api_delete on public.company_account_settings
  for delete to ladino_api using (false);
create policy fiscal_periods_api_delete on public.fiscal_periods
  for delete to ladino_api using (false);
create policy journal_entries_api_delete on public.journal_entries for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()) and status = 'draft');
create policy journal_lines_api_delete on public.journal_lines for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy ledger_balances_api_delete on public.ledger_balances
  for delete to ladino_api using (false);
create policy journal_templates_api_delete on public.journal_templates
  for delete to ladino_api using (false);
create policy journal_template_lines_api_delete on public.journal_template_lines
  for delete to ladino_api using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy journal_generation_queue_api_delete on public.journal_generation_queue
  for delete to ladino_api using (false);

-- ── 13. Grants ──────────────────────────────────────────────────────────────
revoke all on public.accounts, public.account_purposes, public.company_account_settings,
              public.fiscal_periods, public.journal_entries, public.journal_lines,
              public.ledger_balances, public.journal_templates, public.journal_template_lines,
              public.journal_generation_queue, public.chart_templates,
              public.chart_template_accounts
  from anon, authenticated, service_role, ladino_api, ladino_worker;

grant select on public.accounts, public.account_purposes, public.company_account_settings,
                public.fiscal_periods, public.journal_entries, public.journal_lines,
                public.ledger_balances, public.journal_templates,
                public.journal_template_lines, public.journal_generation_queue,
                public.chart_templates, public.chart_template_accounts
  to authenticated;
grant select on public.account_purposes, public.chart_templates, public.chart_template_accounts
  to ladino_api;

grant select, insert, update on public.accounts, public.company_account_settings,
                                public.fiscal_periods, public.journal_entries,
                                public.ledger_balances, public.journal_templates,
                                public.journal_generation_queue
  to ladino_api;
-- Las líneas se pueden borrar mientras el asiento es BORRADOR; una vez
-- posteado, el trigger lo impide y el GRANT ya no importa. Se conceden las dos
-- capas porque editar un borrador es legítimo.
grant select, insert, update, delete on public.journal_lines, public.journal_template_lines
  to ladino_api;

grant execute on function platform.period_for_date(uuid, date) to ladino_api;
grant execute on function platform.claim_entry_number(uuid, integer) to ladino_api;
grant execute on function platform.recompute_ledger(uuid, uuid, date, date)
  to authenticated, ladino_api;
grant execute on function platform.trial_balance(uuid, date, date)
  to authenticated, ladino_api;
grant execute on function platform.accounting_coverage_gaps(uuid)
  to authenticated, ladino_api;
revoke execute on function platform.recompute_ledger(uuid, uuid, date, date) from public;
revoke execute on function platform.trial_balance(uuid, date, date) from public;
revoke execute on function platform.accounting_coverage_gaps(uuid) from public;
revoke execute on function platform.assert_entry_immutable() from public;
revoke execute on function platform.assert_line_immutable() from public;

-- ── 14. Seeds: vocabulario y UNA plantilla marcada ──────────────────────────
-- Los PAPELES contables. Son nombres de roles, no cuentas: qué cuenta cumple
-- cada uno lo decide cada empresa (ADR-0041).
insert into public.account_purposes (code, name, description) values
  ('cash_bs', 'Efectivo en bolívares', 'Caja y bancos en moneda funcional.'),
  ('cash_usd', 'Efectivo en divisas', 'Caja y bancos en moneda extranjera.'),
  ('ar_general', 'Cuentas por cobrar', 'Control de clientes.'),
  ('ap_general', 'Cuentas por pagar', 'Control de proveedores.'),
  ('iva_debit_fiscal', 'IVA débito fiscal', 'IVA repercutido en ventas.'),
  ('iva_credit_fiscal', 'IVA crédito fiscal', 'IVA soportado recuperable en compras.'),
  ('income_general', 'Ingresos por ventas', 'Ingresos ordinarios.'),
  ('cogs_general', 'Costo de ventas', 'Costo de la mercancía vendida.'),
  ('inventory_general', 'Inventario', 'Existencias valoradas.'),
  ('exchange_gain', 'Ganancia cambiaria', 'Diferencial cambiario favorable.'),
  ('exchange_loss', 'Pérdida cambiaria', 'Diferencial cambiario desfavorable.'),
  ('retention_iva_payable', 'Retención de IVA por pagar',
   'IVA retenido a proveedores, pendiente de enterar al fisco.'),
  ('retention_islr_payable', 'Retención de ISLR por pagar',
   'ISLR retenido a proveedores, pendiente de enterar al fisco.'),
  ('landed_cost_clearing', 'Cuenta transitoria de landed cost',
   'Gastos de importación pendientes de imputar al costo.'),
  ('landed_cost_variance', 'Variación de costo por landed cost tardío',
   'Gasto del período por la parte del landed cost que corresponde a unidades ya vendidas (ADR-0040 §6).'),
  ('year_result', 'Resultado del ejercicio',
   'Cuenta puente del cierre: recibe ingresos y gastos del período.'),
  ('retained_earnings', 'Utilidades o pérdidas acumuladas',
   'Destino del resultado en el cierre anual.'),
  ('monetary_restatement', 'Reexpresión monetaria',
   'Gancho para el ajuste por inflación, que es su propio módulo y está diferido. Sin uso todavía.')
on conflict (code) do nothing;

-- UNA plantilla de plan de cuentas, GLOBAL y marcada (ADR-0043). El plan de
-- ninguna empresa se toca: hay que importarla con un acto explícito.
insert into public.chart_templates (code, name, description, framework, legal_source) values
  ('ve_basico', 'Plan básico venezolano',
   'VALIDAR-CONTABLE: punto de partida reconocible, NO un plan correcto para ninguna empresa concreta. La clasificación de cada cuenta y el marco VEN-NIF aplicable los confirma un contador público antes de producción.',
   'VEN-NIF',
   'VENEZUELA_ACCOUNTING_RULES.md §Principio de diseño. La estructura sigue la práctica común venezolana; no hay norma que fije un plan obligatorio.')
on conflict (code) do nothing;

insert into public.chart_template_accounts
  (template_code, code, name, parent_code, kind, nature, is_leaf, level, suggested_purpose)
values
  ('ve_basico', '1',      'Activo',                       null, 'activo',     'deudora',   false, 1, null),
  ('ve_basico', '1.1',    'Activo circulante',            '1',  'activo',     'deudora',   false, 2, null),
  ('ve_basico', '1.1.01', 'Caja y bancos en bolívares',   '1.1','activo',     'deudora',   true,  3, 'cash_bs'),
  ('ve_basico', '1.1.02', 'Caja y bancos en divisas',     '1.1','activo',     'deudora',   true,  3, 'cash_usd'),
  ('ve_basico', '1.1.03', 'Cuentas por cobrar clientes',  '1.1','activo',     'deudora',   true,  3, 'ar_general'),
  ('ve_basico', '1.1.04', 'Inventario de mercancías',     '1.1','activo',     'deudora',   true,  3, 'inventory_general'),
  ('ve_basico', '1.1.05', 'IVA crédito fiscal',           '1.1','activo',     'deudora',   true,  3, 'iva_credit_fiscal'),
  ('ve_basico', '1.1.06', 'Gastos de importación por imputar', '1.1','activo','deudora',   true,  3, 'landed_cost_clearing'),
  ('ve_basico', '2',      'Pasivo',                       null, 'pasivo',     'acreedora', false, 1, null),
  ('ve_basico', '2.1',    'Pasivo circulante',            '2',  'pasivo',     'acreedora', false, 2, null),
  ('ve_basico', '2.1.01', 'Cuentas por pagar proveedores','2.1','pasivo',     'acreedora', true,  3, 'ap_general'),
  ('ve_basico', '2.1.02', 'IVA débito fiscal',            '2.1','pasivo',     'acreedora', true,  3, 'iva_debit_fiscal'),
  ('ve_basico', '2.1.03', 'Retención de IVA por pagar',   '2.1','pasivo',     'acreedora', true,  3, 'retention_iva_payable'),
  ('ve_basico', '2.1.04', 'Retención de ISLR por pagar',  '2.1','pasivo',     'acreedora', true,  3, 'retention_islr_payable'),
  ('ve_basico', '3',      'Patrimonio',                   null, 'patrimonio', 'acreedora', false, 1, null),
  ('ve_basico', '3.1',    'Capital y resultados',         '3',  'patrimonio', 'acreedora', false, 2, null),
  ('ve_basico', '3.1.01', 'Resultado del ejercicio',      '3.1','patrimonio', 'acreedora', true,  3, 'year_result'),
  ('ve_basico', '3.1.02', 'Utilidades o pérdidas acumuladas','3.1','patrimonio','acreedora',true, 3, 'retained_earnings'),
  ('ve_basico', '3.1.03', 'Reexpresión monetaria',        '3.1','patrimonio', 'acreedora', true,  3, 'monetary_restatement'),
  ('ve_basico', '4',      'Ingresos',                     null, 'ingreso',    'acreedora', false, 1, null),
  ('ve_basico', '4.1',    'Ingresos operativos',          '4',  'ingreso',    'acreedora', false, 2, null),
  ('ve_basico', '4.1.01', 'Ventas',                       '4.1','ingreso',    'acreedora', true,  3, 'income_general'),
  ('ve_basico', '4.1.02', 'Ganancia cambiaria',           '4.1','ingreso',    'acreedora', true,  3, 'exchange_gain'),
  ('ve_basico', '5',      'Gastos',                       null, 'gasto',      'deudora',   false, 1, null),
  ('ve_basico', '5.1',    'Costos y gastos operativos',   '5',  'gasto',      'deudora',   false, 2, null),
  ('ve_basico', '5.1.01', 'Costo de ventas',              '5.1','gasto',      'deudora',   true,  3, 'cogs_general'),
  ('ve_basico', '5.1.02', 'Pérdida cambiaria',            '5.1','gasto',      'deudora',   true,  3, 'exchange_loss'),
  ('ve_basico', '5.1.03', 'Variación de costo por landed cost tardío', '5.1','gasto','deudora', true, 3, 'landed_cost_variance')
on conflict (template_code, code) do nothing;

-- Permisos de contabilidad.
insert into public.permissions (key, description, is_scoped) values
  ('accounting.account.manage',  'Crear, editar y desactivar cuentas del plan',           false),
  ('accounting.entry.create',    'Crear asientos manuales en borrador',                   false),
  ('accounting.entry.post',      'Postear un asiento: es el acto que lo hace inmutable',  false),
  ('accounting.entry.reverse',   'Reversar un asiento posteado con un contra-asiento',    false),
  ('accounting.period.close',    'Cerrar un período contable',                            false),
  ('accounting.period.reopen',   'Reabrir un período cerrado (exige motivo escrito)',     false),
  ('accounting.template.manage', 'Configurar el mapeo contable y los papeles de cuenta',  false),
  ('accounting.read',            'Consultar mayor, balance de comprobación y estados',    false)
on conflict (key) do nothing;

-- ── 15. Lo que esta migración GARANTIZA sobre sí misma (LAD63) ──────────────
do $$
begin
  if (select count(*) from public.journal_templates) <> 0 then
    raise exception 'LAD63: journal_templates DEBE nacer vacía (ADR-0041): sin mapeo no se inventa una cuenta';
  end if;
  if (select count(*) from public.accounts) <> 0 then
    raise exception 'LAD63: accounts DEBE nacer vacía (ADR-0043): el plan de cuentas no se hard-codea';
  end if;
  if (select count(*) from public.chart_templates where description not like '%VALIDAR-CONTABLE%') <> 0 then
    raise exception 'LAD63: hay una plantilla de plan sin marcar VALIDAR-CONTABLE';
  end if;
  if (select count(*) from public.account_purposes) < 18 then
    raise exception 'LAD63: faltan papeles contables tras el seed';
  end if;
  if (select count(*) from public.permissions where key like 'accounting.%') <> 8 then
    raise exception 'LAD63: faltan permisos de contabilidad tras el seed';
  end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('accounts','account_purposes','company_account_settings',
                           'fiscal_periods','journal_entries','journal_lines','ledger_balances',
                           'journal_templates','journal_template_lines',
                           'journal_generation_queue','chart_templates','chart_template_accounts')
         and c.relrowsecurity and c.relforcerowsecurity) <> 12 then
    raise exception 'LAD63: alguna tabla de contabilidad no tiene RLS habilitada y forzada';
  end if;
  -- CLAUDE.md §2 prohíbe UPDATE/DELETE sobre `journal_lines` POR ESE NOMBRE.
  -- Si la tabla no existiera, la regla sería decoración y el hook no vigilaría
  -- nada. Aquí se comprueba que existe y que su append-only está montado.
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'journal_lines') then
    raise exception 'LAD63: journal_lines no existe y CLAUDE.md §2 la nombra: la regla apuntaría al vacío';
  end if;
  if not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                  where c.relname = 'journal_lines' and t.tgname = 'journal_lines_03_immutable') then
    raise exception 'LAD63: journal_lines sin trigger de inmutabilidad (capa 2 de ADR-0006)';
  end if;
  -- Y que la partida doble se comprueba en el ESQUEMA, no en la aplicación.
  if not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                  where c.relname = 'journal_entries' and t.tgname = 'journal_entries_02_balanced') then
    raise exception 'LAD63: falta el trigger de partida doble: el invariante viviría solo en la API';
  end if;
end $$;

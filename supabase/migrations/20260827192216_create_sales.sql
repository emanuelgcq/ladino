-- =============================================================================
-- Ladino — migración 21 · VENTAS: régimen fiscal, motor tributario, numeración,
--                          documentos, cobros, diferencial cambiario y CxC
--
-- Módulo: sales   Spec: ADR-0029 (régimen versionado) · ADR-0037 (numeración) ·
--                       ADR-0038 (motor tributario) · ADR-0020 (siete campos) ·
--                       ADR-0006 (append-only) · SALES_AND_AR_SPEC
-- Reversible: SÍ mientras no haya documentos EMITIDOS. Con un `issued` dentro,
--             NO: es numeración fiscal y un documento emitido no se borra.
-- Homologación: SÍ — toca emisión de documentos fiscales, numeración y cálculo
--               de impuestos. Nada se habilita sin régimen y sin tax_rules.
--
-- ES LA PLANTILLA QUE VAN A COPIAR compras, tesorería y devoluciones, así que
-- todo lo que aquí se decide mal se replica cuatro veces. De ahí el rigor.
--
-- LO QUE ESTA MIGRACIÓN NO HACE, y es deliberado:
--   · no siembra NI UNA alícuota (ADR-0038): tax_rules nace vacía y sin regla no
--     hay emisión. La primera la carga el operador con su Gaceta;
--   · no siembra ningún régimen con `numbering_mode = 'per_document'`: ese modo
--     existe como forma de datos pero el flujo de dos fases con la imprenta sigue
--     abierto (OPEN_QUESTIONS 10, VALIDAR-SENIAT) y no se habilita en nadie;
--   · no calcula IGTF ni retenciones: `formula` queda reservada y su motor va con
--     su propio ADR y su fuente citada;
--   · no genera asientos contables: el diferencial cambiario se MODELA y se
--     CALCULA aquí; su asiento es del módulo de contabilidad (gancho dejado).
--
-- SOBRE LOS IMPORTES. Los precios de lista van en USD y la factura sale en Bs con
-- la tasa BCV vigente al emitir: por eso CADA LÍNEA persiste los siete campos de
-- ADR-0020 más la política de redondeo (ADR-0024). No es redundancia con la
-- cabecera: una línea es el nivel al que se reproduce un cálculo.
-- =============================================================================

-- ── 1. Régimen fiscal (ADR-0029, que estaba aceptado y sin implementar) ─────
create table public.fiscal_regimes (
  code             text        primary key,
  name             text        not null,
  description      text        not null,
  -- Qué documentos permite emitir. Vacío = ninguno (ERP administrativo puro).
  allowed_kinds    text[]      not null default '{}',
  -- ADR-0037: de dónde sale el número de control.
  numbering_mode   text        not null,
  requires_transmission boolean not null default false,
  -- ADR-0028: qué adaptador. NULL = ninguno.
  transmitter_code text,
  -- §2 aplicado al catálogo: un régimen sin norma citada es una obligación
  -- inventada PARA TODOS los clientes que se le asignen.
  legal_source     text        not null,
  status           text        not null default 'active',
  created_at       timestamptz not null default now(),
  constraint fiscal_regimes_code_chk check (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint fiscal_regimes_numbering_chk
    check (numbering_mode in ('none', 'internal_only', 'range', 'per_document')),
  constraint fiscal_regimes_legal_source_chk check (length(btrim(legal_source)) between 3 and 300),
  constraint fiscal_regimes_status_chk check (status in ('active', 'inactive'))
);
comment on table public.fiscal_regimes is
  'Catálogo de regímenes fiscales (ADR-0029 §1), gobernado por el operador. '
  '`numbering_mode` es lo que ADR-0037 consulta para decidir si un documento '
  'emitido puede o debe llevar número de control. `legal_source` es OBLIGATORIO.';

-- El vigente por empresa, APPEND-ONLY (ADR-0029 §2): se cierra el vigente y se
-- abre otro. Nunca un UPDATE sobre la fila en curso — el histórico ES el dato.
create table public.company_fiscal_regimes (
  id             uuid        primary key default platform.uuidv7(),
  tenant_id      uuid        not null,
  company_id     uuid        not null,
  regime_code    text        not null,
  effective_from timestamptz not null,
  effective_to   timestamptz,
  created_by     uuid,
  created_at     timestamptz not null,
  version        integer     not null,
  constraint company_fiscal_regimes_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint company_fiscal_regimes_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint company_fiscal_regimes_regime_fk
    foreign key (regime_code) references public.fiscal_regimes (code),
  constraint company_fiscal_regimes_period_chk
    check (effective_to is null or effective_to > effective_from),
  constraint company_fiscal_regimes_id_key unique (company_id, id)
);
comment on table public.company_fiscal_regimes is
  'Régimen vigente por empresa, append-only y efectivo por fecha (ADR-0029 §2). '
  'Sobrescribir el régimen borraría la única evidencia de bajo qué reglas operó '
  'la empresa el trimestre pasado. La fila que un documento congela en '
  'regime_version_id es el ID de ESTA tabla.';

-- Dos vigencias no se solapan: la misma defensa estructural que los precios
-- (ADR-0032), por el mismo motivo — «cuál regía» tiene que tener UNA respuesta.
alter table public.company_fiscal_regimes
  add constraint company_fiscal_regimes_no_overlap
  exclude using gist (
    company_id with =,
    tstzrange(effective_from, coalesce(effective_to, 'infinity'), '[)') with &&
  );
create index company_fiscal_regimes_lookup_idx
  on public.company_fiscal_regimes (company_id, effective_from desc);
create index company_fiscal_regimes_tenant_company_idx
  on public.company_fiscal_regimes (tenant_id, company_id);

-- El régimen vigente A LA FECHA. Parámetro, nunca now() (la regla de price_at).
create function platform.regime_at(p_company uuid, p_fecha timestamptz)
returns table (regime_version_id uuid, regime_code text, numbering_mode text)
language sql
stable
set search_path = ''
as $$
  select r.id, r.regime_code, fr.numbering_mode
    from public.company_fiscal_regimes r
    join public.fiscal_regimes fr on fr.code = r.regime_code
   where r.company_id = p_company
     and r.effective_from <= p_fecha
     and (r.effective_to is null or r.effective_to > p_fecha)
$$;
comment on function platform.regime_at(uuid, timestamptz) is
  'El régimen fiscal vigente de una empresa A LA FECHA DADA. El EXCLUDE de '
  'arriba garantiza como mucho UNA fila. Sin fila = la empresa no tiene régimen '
  'asignado y no puede emitir (LAD49).';
revoke execute on function platform.regime_at(uuid, timestamptz) from public;
grant execute on function platform.regime_at(uuid, timestamptz) to authenticated, ladino_api;

-- ── 2. Motor tributario (ADR-0038) — NACE VACÍA ─────────────────────────────
create table public.tax_rules (
  id                   uuid          primary key default platform.uuidv7(),
  -- Global, no por company: una alícuota es de la jurisdicción, no de la
  -- empresa. Misma excepción declarada que `permissions` (ADR-0025 §3).
  jurisdiction         text          not null,
  tax_code             text          not null,
  -- Los ejes ya existen como vocabulario: taxpayer_types (ADR-0033) y
  -- product_tax_categories (ADR-0032). NULL = «cualquiera», y por eso hay
  -- `priority`: lo específico gana a lo general.
  taxpayer_type        text,
  transaction_type     text          not null default 'sale',
  product_tax_category text,
  rate                 numeric(24,8) not null,
  -- Reservada: hoy solo se soporta `rate` sobre la base de la línea. IGTF y
  -- retenciones entran por aquí con su propio ADR (ADR-0038 §Consecuencias).
  formula              text,
  effective_from       date          not null,
  effective_to         date,
  -- §2 aplicado: una regla sin norma citada es una alícuota inventada.
  legal_source         text          not null,
  priority             integer       not null default 100,
  version              integer       not null default 1,
  status               text          not null default 'active',
  -- created_by, created_at Y `version` (declarada arriba, junto a priority) las
  -- gobierna set_row_provenance(): las TRES, no dos. Faltaba en exchange_rates y
  -- el trigger murió con «record new has no field version» — es un trigger
  -- compartido y no admite tablas con forma propia.
  created_by           uuid,
  created_at           timestamptz   not null,
  constraint tax_rules_taxpayer_fk
    foreign key (taxpayer_type) references public.taxpayer_types (code),
  constraint tax_rules_category_fk
    foreign key (product_tax_category) references public.product_tax_categories (code),
  constraint tax_rules_jurisdiction_chk check (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,10})?$'),
  constraint tax_rules_tax_code_chk check (tax_code ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint tax_rules_transaction_chk check (transaction_type in ('sale', 'purchase')),
  -- Una alícuota negativa no existe; una mayor que 1 sería un 100%+ que nadie
  -- ha citado. Si algún día lo hay, se levanta con su fuente.
  constraint tax_rules_rate_chk check (rate >= 0 and rate <= 1),
  constraint tax_rules_period_chk check (effective_to is null or effective_to > effective_from),
  constraint tax_rules_legal_source_chk check (length(btrim(legal_source)) between 3 and 300),
  constraint tax_rules_status_chk check (status in ('active', 'inactive'))
);
comment on table public.tax_rules is
  'Reglas tributarias como DATO, con vigencia y fuente legal (ADR-0038). NACE '
  'VACÍA: la migración no trae ni una alícuota. Sin regla no hay emisión, y eso '
  'es la mitad del valor de la decisión — el sistema falla ruidosamente en vez '
  'de facturar con un supuesto. Los tests siembran las suyas.';
create index tax_rules_lookup_idx
  on public.tax_rules (jurisdiction, tax_code, transaction_type, effective_from desc)
  where status = 'active';

-- resolve_tax: devuelve LA regla, o FALLA. Nunca cero, nunca NULL que alguien
-- pueda coalescer — un NULL convertido en 0 produce una factura con IVA cero
-- que parece correcta y es un delito tributario (ADR-0038).
create function platform.resolve_tax(
  p_fecha        date,
  p_jurisdiction text,
  p_tax_code     text,
  p_taxpayer     text,
  p_category     text,
  p_transaction  text default 'sale'
)
returns table (tax_rule_id uuid, rate numeric, legal_source text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  select count(*) into v_n
    from public.tax_rules t
   where t.status = 'active'
     and t.jurisdiction = p_jurisdiction
     and t.tax_code = p_tax_code
     and t.transaction_type = p_transaction
     and t.effective_from <= p_fecha
     and (t.effective_to is null or t.effective_to > p_fecha)
     and (t.taxpayer_type is null or t.taxpayer_type = p_taxpayer)
     and (t.product_tax_category is null or t.product_tax_category = p_category)
     and t.priority = (
       select max(t2.priority) from public.tax_rules t2
        where t2.status = 'active' and t2.jurisdiction = p_jurisdiction
          and t2.tax_code = p_tax_code and t2.transaction_type = p_transaction
          and t2.effective_from <= p_fecha
          and (t2.effective_to is null or t2.effective_to > p_fecha)
          and (t2.taxpayer_type is null or t2.taxpayer_type = p_taxpayer)
          and (t2.product_tax_category is null or t2.product_tax_category = p_category));

  if v_n = 0 then
    raise exception
      'no hay regla tributaria vigente para % / % el % (contraparte %, categoría %): cárgala en tax_rules con su fuente legal antes de emitir',
      p_jurisdiction, p_tax_code, p_fecha, p_taxpayer, p_category
      using errcode = 'LAD50',
            hint = 'ADR-0038: el catálogo nace vacío a propósito; sin regla no hay emisión';
  end if;
  if v_n > 1 then
    -- Dos reglas igual de específicas es una INCOHERENCIA DEL CATÁLOGO. Elegir
    -- una por orden de inserción sería arbitrario y no reproducible.
    raise exception
      'hay % reglas tributarias con la MISMA prioridad para % / % el %: el catálogo es ambiguo y el sistema no puede elegir',
      v_n, p_jurisdiction, p_tax_code, p_fecha
      using errcode = 'LAD50',
            hint = 'ajusta `priority` para que una regla sea más específica que la otra';
  end if;

  return query
    select t.id, t.rate, t.legal_source
      from public.tax_rules t
     where t.status = 'active'
       and t.jurisdiction = p_jurisdiction
       and t.tax_code = p_tax_code
       and t.transaction_type = p_transaction
       and t.effective_from <= p_fecha
       and (t.effective_to is null or t.effective_to > p_fecha)
       and (t.taxpayer_type is null or t.taxpayer_type = p_taxpayer)
       and (t.product_tax_category is null or t.product_tax_category = p_category)
     order by t.priority desc
     limit 1;
end;
$$;
comment on function platform.resolve_tax(date, text, text, text, text, text) is
  'La regla tributaria vigente, o LAD50. Lo específico gana a lo general por '
  '`priority`; dos reglas igual de específicas son ambigüedad del catálogo y '
  'también fallan. NUNCA devuelve cero (ADR-0038).';
revoke execute on function platform.resolve_tax(date, text, text, text, text, text) from public;
grant execute on function platform.resolve_tax(date, text, text, text, text, text)
  to authenticated, ladino_api;

-- ── 3. Tasas de cambio con fuente (ADR-0020 §Decisión: vigencia y fuente) ────
create table public.exchange_rates (
  id            uuid          primary key default platform.uuidv7(),
  from_currency text          not null,
  to_currency   text          not null,
  rate          numeric(24,8) not null,
  -- BCV, manual, u otro adaptador. Sin fuente no se persiste (ADR-0020).
  source        text          not null,
  rate_date     date          not null,
  rate_timestamp timestamptz  not null,
  created_by    uuid,
  created_at    timestamptz   not null,
  version       integer       not null,
  constraint exchange_rates_from_fk foreign key (from_currency) references public.currencies (code),
  constraint exchange_rates_to_fk   foreign key (to_currency)   references public.currencies (code),
  constraint exchange_rates_rate_chk check (rate > 0),
  constraint exchange_rates_source_chk check (length(btrim(source)) between 1 and 120),
  constraint exchange_rates_distinct_chk check (from_currency <> to_currency),
  -- Una sola tasa por par, fuente y día: dos tasas del BCV el mismo día para el
  -- mismo par son un error de carga, no dos hechos.
  constraint exchange_rates_day_key unique (from_currency, to_currency, source, rate_date)
);
comment on table public.exchange_rates is
  'Tasas con FUENTE y FECHA (ADR-0020, regla 8). El adaptador BCV las carga; el '
  'NullBCVAdapter deja que se carguen a mano, con la fuente que diga la verdad. '
  'La emisión consume la vigente al día; si no hay, RECHAZA (LAD51).';
create index exchange_rates_lookup_idx
  on public.exchange_rates (from_currency, to_currency, rate_date desc);

create function platform.rate_at(p_from text, p_to text, p_fecha date, p_source text default null)
returns numeric
language sql
stable
set search_path = ''
as $$
  select r.rate from public.exchange_rates r
   where r.from_currency = p_from and r.to_currency = p_to
     and r.rate_date <= p_fecha
     and (p_source is null or r.source = p_source)
   order by r.rate_date desc, r.created_at desc
   limit 1
$$;
comment on function platform.rate_at(text, text, date, text) is
  'La tasa vigente A LA FECHA: la más reciente que no sea posterior. Fecha '
  'PARÁMETRO, nunca now() — una factura de ayer se recalcula con la tasa de '
  'ayer, igual que price_at y stock_at.';
revoke execute on function platform.rate_at(text, text, date, text) from public;
grant execute on function platform.rate_at(text, text, date, text) to authenticated, ladino_api;

-- ── 4. Rangos de numeración de imprenta (ADR-0037) ──────────────────────────
create table public.fiscal_number_ranges (
  id              uuid        primary key default platform.uuidv7(),
  tenant_id       uuid        not null,
  company_id      uuid        not null,
  kind            text        not null,
  series          text        not null,
  range_from      bigint      not null,
  range_to        bigint      not null,
  next_available  bigint      not null,
  status          text        not null default 'active',
  printer_source  text        not null,
  -- Umbral de alerta: cuando quede menos de este porcentaje, hay que pedir otro
  -- rango. Configurable por company porque el ritmo de facturación lo es.
  alert_threshold_pct smallint not null default 10,
  created_by      uuid,
  created_at      timestamptz not null,
  version         integer     not null,
  constraint fiscal_number_ranges_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint fiscal_number_ranges_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint fiscal_number_ranges_kind_chk
    check (kind in ('invoice', 'credit_note', 'debit_note', 'delivery_note')),
  constraint fiscal_number_ranges_series_chk
    check (series = btrim(series) and length(series) between 1 and 10),
  constraint fiscal_number_ranges_bounds_chk check (range_from > 0 and range_to >= range_from),
  -- `next_available = range_to + 1` es el rango AGOTADO, y es un estado válido.
  constraint fiscal_number_ranges_next_chk
    check (next_available >= range_from and next_available <= range_to + 1),
  constraint fiscal_number_ranges_status_chk check (status in ('active', 'exhausted', 'cancelled')),
  constraint fiscal_number_ranges_printer_chk check (length(btrim(printer_source)) between 1 and 200),
  constraint fiscal_number_ranges_threshold_chk check (alert_threshold_pct between 0 and 100)
);
comment on table public.fiscal_number_ranges is
  'Rangos de número de control autorizados por la imprenta (ADR-0037). El '
  'consumo es ATÓMICO vía platform.claim_control_number(): dos emisiones '
  'simultáneas obtienen números distintos o una espera, nunca el mismo. Un '
  'rango agotado DETIENE la emisión, que es correcto: emitir fuera del rango '
  'autorizado sería emitir un documento inválido.';
create index fiscal_number_ranges_lookup_idx
  on public.fiscal_number_ranges (company_id, kind, series, status);
create index fiscal_number_ranges_tenant_company_idx
  on public.fiscal_number_ranges (tenant_id, company_id);

-- El consumo atómico. SECURITY DEFINER porque escribe el rango, que nadie más
-- puede tocar; FOR UPDATE porque entre leer `next_available` y escribirlo no
-- puede haber ventana — ahí es donde dos facturas recibirían el mismo control.
create function platform.claim_control_number(
  p_company uuid, p_kind text, p_series text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_range public.fiscal_number_ranges;
  v_num   bigint;
begin
  select * into v_range
    from public.fiscal_number_ranges r
   where r.company_id = p_company and r.kind = p_kind and r.series = p_series
     and r.status = 'active' and r.next_available <= r.range_to
   order by r.range_from
   for update
   limit 1;

  if v_range.id is null then
    raise exception
      'no hay rango de número de control disponible para % serie % en esta empresa: cárgalo o pide otro a la imprenta',
      p_kind, p_series
      using errcode = 'LAD49',
            hint = 'ADR-0037: emitir fuera del rango autorizado sería emitir un documento inválido';
  end if;

  v_num := v_range.next_available;
  update public.fiscal_number_ranges
     set next_available = v_num + 1,
         status = case when v_num + 1 > range_to then 'exhausted' else status end
   where id = v_range.id;
  return v_num;
end;
$$;
comment on function platform.claim_control_number(uuid, text, text) is
  'Reserva el siguiente número de control de forma ATÓMICA (FOR UPDATE). Marca '
  'el rango `exhausted` al consumir el último. LAD49 si no queda ninguno.';
revoke execute on function platform.claim_control_number(uuid, text, text) from public;

-- Qué rangos están por agotarse. La notificación es del worker y se difiere;
-- la CONSULTA existe ya, que es lo que hace posible el aviso.
create function platform.range_exhaustion(p_company uuid)
returns table (
  range_id uuid, kind text, series text, remaining bigint, total bigint, pct_remaining numeric
)
language sql
stable
set search_path = ''
as $$
  select r.id, r.kind, r.series,
         (r.range_to - r.next_available + 1),
         (r.range_to - r.range_from + 1),
         round(100.0 * (r.range_to - r.next_available + 1) / (r.range_to - r.range_from + 1), 2)
    from public.fiscal_number_ranges r
   where r.company_id = p_company and r.status = 'active'
     and (r.range_to - r.next_available + 1) * 100
         <= r.alert_threshold_pct * (r.range_to - r.range_from + 1)
   order by 6
$$;
comment on function platform.range_exhaustion(uuid) is
  'Rangos por debajo de su umbral de alerta. Una empresa puede quedarse sin '
  'poder facturar por un dato administrativo (ADR-0037 §Consecuencias): esta '
  'consulta es lo que permite avisar antes de que pase.';
revoke execute on function platform.range_exhaustion(uuid) from public;
grant execute on function platform.range_exhaustion(uuid) to authenticated, ladino_api;

-- ── 5. LOS DOCUMENTOS ───────────────────────────────────────────────────────
create table public.documents (
  id              uuid        primary key default platform.uuidv7(),
  tenant_id       uuid        not null,
  company_id      uuid        not null,
  branch_id       uuid,
  kind            text        not null,
  series          text        not null default 'A',
  -- ADR-0037: correlativo DEL EMISOR. NULL en draft; se asigna al emitir y no
  -- se libera nunca, ni al anular.
  document_number bigint,
  -- ADR-0037: número de control DE LA IMPRENTA. Nullable por diseño.
  control_number  bigint,
  status          text        not null default 'draft',
  issued_at       timestamptz,
  annulled_at     timestamptz,
  annul_reason    text,

  customer_id     uuid        not null,
  -- Gancho para el módulo de COMISIONES. Aquí no se calcula nada (encargo).
  vendor_id       uuid,
  price_list_id   uuid,
  -- Documento de origen: la NC apunta a su factura, la factura a su pedido.
  source_document_id uuid,

  -- Los SIETE campos de ADR-0020 al pie del documento, más la política.
  amount_transaction_currency numeric(24,8) not null default 0,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null default 1,
  functional_amount           numeric(24,8) not null default 0,
  functional_currency         text          not null,
  rate_source                 text          not null default 'identidad',
  rate_timestamp              timestamptz   not null default now(),
  rounding_policy_id          text          not null default 'inventory:cost:8:HALF_UP',

  subtotal_amount numeric(24,8) not null default 0,
  tax_amount      numeric(24,8) not null default 0,
  total_amount    numeric(24,8) not null default 0,

  -- Las CUATRO ANCLAS de ADR-0029, congeladas con el documento.
  regime_version_id uuid,
  rules_version     text,

  notes           text,
  created_by      uuid,
  created_at      timestamptz not null,
  version         integer     not null,

  constraint documents_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint documents_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint documents_branch_fk
    foreign key (company_id, branch_id) references public.branches (company_id, id),
  constraint documents_customer_fk
    foreign key (company_id, customer_id) references public.customers (company_id, id),
  constraint documents_price_list_fk
    foreign key (company_id, price_list_id) references public.price_lists (company_id, id),
  constraint documents_source_fk
    foreign key (company_id, source_document_id) references public.documents (company_id, id),
  constraint documents_regime_fk
    foreign key (company_id, regime_version_id)
    references public.company_fiscal_regimes (company_id, id),
  constraint documents_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint documents_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),

  constraint documents_kind_chk
    check (kind in ('quote', 'order', 'invoice', 'credit_note', 'debit_note')),
  constraint documents_series_chk check (series = btrim(series) and length(series) between 1 and 10),
  constraint documents_status_chk
    check (status in ('draft', 'confirmed', 'issued', 'paid', 'annulled', 'cancelled')),
  -- Un documento EMITIDO tiene número y fecha. Un borrador, ninguno de los dos.
  constraint documents_issued_shape_chk check (
    (status in ('draft', 'confirmed', 'cancelled')
      and document_number is null and issued_at is null)
    or (status in ('issued', 'paid', 'annulled')
      and document_number is not null and issued_at is not null
      and regime_version_id is not null and rules_version is not null)),
  constraint documents_annulled_chk check (
    (status = 'annulled') = (annulled_at is not null)
    and (annulled_at is null or (annul_reason is not null and length(btrim(annul_reason)) >= 3))),
  constraint documents_amounts_chk check (
    subtotal_amount >= 0 and tax_amount >= 0 and total_amount >= 0
    and total_amount = subtotal_amount + tax_amount),
  constraint documents_fx_chk check (fx_rate > 0),
  constraint documents_identity_chk check (
    transaction_currency <> functional_currency
    or (fx_rate = 1 and amount_transaction_currency = functional_amount)),
  constraint documents_company_id_key unique (company_id, id)
);
comment on table public.documents is
  'Documentos de venta. `issued` es INMUTABLE: no se edita ni se borra (dos '
  'capas, ADR-0006). El correlativo se conserva al anular — un salto en la '
  'numeración es indistinguible de un documento ocultado (ADR-0037). Las cuatro '
  'anclas de ADR-0029 se congelan aquí: reemitir con las mismas anclas y los '
  'mismos insumos debe producir el mismo documento.';
comment on column public.documents.control_number is
  'Número de control de la IMPRENTA (ADR-0037). Nullable: hay un instante '
  'legítimo en que el documento existe y su número de control todavía no. Qué '
  'está permitido lo decide el régimen vigente (LAD49).';
comment on column public.documents.vendor_id is
  'Gancho para el módulo de COMISIONES. Aquí no se calcula ninguna: se registra '
  'quién vendió y nada más.';

-- EL correlativo, sin huecos y sin reutilización. Parcial porque un borrador no
-- tiene número y varios borradores conviven.
create unique index documents_number_uidx
  on public.documents (company_id, kind, series, document_number)
  where document_number is not null;
create unique index documents_control_uidx
  on public.documents (company_id, kind, series, control_number)
  where control_number is not null;
create index documents_tenant_company_idx on public.documents (tenant_id, company_id);
create index documents_company_customer_idx on public.documents (company_id, customer_id, issued_at desc);
create index documents_company_status_idx on public.documents (company_id, status, issued_at desc);
create index documents_source_idx on public.documents (source_document_id) where source_document_id is not null;
create index documents_vendor_idx on public.documents (company_id, vendor_id) where vendor_id is not null;

create table public.document_lines (
  id              uuid          primary key default platform.uuidv7(),
  tenant_id       uuid          not null,
  company_id      uuid          not null,
  document_id     uuid          not null,
  line_number     integer       not null,
  product_id      uuid          not null,
  description     text          not null,
  quantity        numeric(24,8) not null,

  -- El precio en las DOS monedas: la lista va en USD y el documento sale en Bs.
  unit_price_transaction numeric(24,8) not null,
  unit_price_functional  numeric(24,8) not null,
  -- QUÉ LISTA APLICÓ. Sin esto, «por qué este precio» no tiene respuesta.
  price_list_applied_id  uuid,

  -- ADR-0038: la regla y su alícuota, COPIADAS. Cambiar tax_rules mañana no
  -- altera ni un céntimo de lo emitido ayer.
  tax_rule_id       uuid,
  tax_rate_snapshot numeric(24,8) not null default 0,
  tax_amount        numeric(24,8) not null default 0,

  line_subtotal_transaction numeric(24,8) not null,
  line_subtotal_functional  numeric(24,8) not null,
  line_total_transaction    numeric(24,8) not null,
  line_total_functional     numeric(24,8) not null,

  -- Los SIETE campos de ADR-0020 POR LÍNEA: una línea es el nivel al que se
  -- reproduce un cálculo, y la cabecera no basta para reconstruirla.
  amount_transaction_currency numeric(24,8) not null,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null,
  functional_amount           numeric(24,8) not null,
  functional_currency         text          not null,
  rate_source                 text          not null,
  rate_timestamp              timestamptz   not null,
  rounding_policy_id          text          not null,

  -- Costo del kardex AL EMITIR, para margen. Snapshot: el costo de hoy no
  -- reinterpreta el margen de una venta de hace tres meses.
  cost_snapshot   numeric(24,8),

  created_by      uuid,
  created_at      timestamptz   not null,
  version         integer       not null,

  constraint document_lines_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint document_lines_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint document_lines_document_fk
    foreign key (company_id, document_id) references public.documents (company_id, id) on delete cascade,
  constraint document_lines_product_fk
    foreign key (company_id, product_id) references public.products (company_id, id),
  constraint document_lines_price_list_fk
    foreign key (company_id, price_list_applied_id) references public.price_lists (company_id, id),
  constraint document_lines_tax_rule_fk foreign key (tax_rule_id) references public.tax_rules (id),
  constraint document_lines_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint document_lines_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint document_lines_quantity_chk check (quantity > 0),
  constraint document_lines_prices_chk
    check (unit_price_transaction >= 0 and unit_price_functional >= 0),
  constraint document_lines_rate_chk check (tax_rate_snapshot >= 0 and tax_rate_snapshot <= 1),
  constraint document_lines_totals_chk check (
    line_total_transaction = line_subtotal_transaction + tax_amount
    and line_subtotal_transaction >= 0 and line_total_transaction >= 0),
  constraint document_lines_fx_chk check (fx_rate > 0),
  constraint document_lines_number_key unique (document_id, line_number),
  constraint document_lines_company_id_key unique (company_id, id)
);
comment on table public.document_lines is
  'Líneas del documento. Persisten QUÉ LISTA de precios aplicó y QUÉ REGLA '
  'tributaria, con su alícuota copiada (R-05 aplicado al impuesto, ADR-0038). '
  'Los siete campos de ADR-0020 van POR LÍNEA porque la línea es el nivel al '
  'que se reproduce un cálculo. `cost_snapshot` es el costo del kardex al '
  'emitir: el margen de una venta vieja no se reinterpreta con el costo de hoy.';
create index document_lines_document_idx on public.document_lines (document_id, line_number);
create index document_lines_tenant_company_idx on public.document_lines (tenant_id, company_id);
create index document_lines_product_idx on public.document_lines (company_id, product_id);

-- ── 6. Cobros y saldo ───────────────────────────────────────────────────────
create table public.payments (
  id              uuid          primary key default platform.uuidv7(),
  tenant_id       uuid          not null,
  company_id      uuid          not null,
  document_id     uuid          not null,
  paid_at         timestamptz   not null,
  -- Lo que el cliente entregó, en SU moneda.
  currency        text          not null,
  amount          numeric(24,8) not null,
  -- La tasa DEL DÍA DEL COBRO, que puede no ser la de emisión: de ahí sale el
  -- diferencial cambiario.
  fx_rate         numeric(24,8) not null,
  rate_source     text          not null,
  rate_timestamp  timestamptz   not null,
  -- Lo mismo en moneda funcional, que es como se compara contra el documento.
  functional_amount numeric(24,8) not null,
  instrument      text          not null,
  reference       text,
  -- Cuando el instrumento es un saldo a favor, de dónde salió.
  customer_credit_id uuid,
  created_by      uuid,
  created_at      timestamptz   not null,
  version         integer       not null,
  constraint payments_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint payments_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint payments_document_fk
    foreign key (company_id, document_id) references public.documents (company_id, id),
  constraint payments_currency_fk foreign key (currency) references public.currencies (code),
  constraint payments_amount_chk check (amount > 0 and functional_amount > 0),
  constraint payments_fx_chk check (fx_rate > 0),
  constraint payments_instrument_chk check (instrument in
    ('efectivo_bs', 'efectivo_usd', 'zelle', 'usdt', 'transferencia', 'punto_venta',
     'saldo_a_favor', 'otro')),
  constraint payments_credit_shape_chk
    check ((instrument = 'saldo_a_favor') = (customer_credit_id is not null)),
  constraint payments_reference_chk
    check (reference is null or (reference = btrim(reference) and length(reference) between 1 and 100)),
  constraint payments_company_id_key unique (company_id, id)
);
comment on table public.payments is
  'Cobros aplicados a un documento. Un pago NO modifica la factura (regla 2 y '
  'SALES_AND_AR_SPEC): crea una fila aquí. EL SALDO NO SE PERSISTE — se calcula '
  'como total − Σ pagos, porque un saldo guardado es un segundo lugar donde la '
  'verdad puede divergir.';
create index payments_document_idx on public.payments (document_id, paid_at);
create index payments_tenant_company_idx on public.payments (tenant_id, company_id);
create index payments_company_paid_idx on public.payments (company_id, paid_at desc);

-- ── 7. Saldo a favor del cliente (NC aplicable como pago) ───────────────────
create table public.customer_credits (
  id              uuid          primary key default platform.uuidv7(),
  tenant_id       uuid          not null,
  company_id      uuid          not null,
  customer_id     uuid          not null,
  -- De dónde salió: la nota de crédito que lo generó.
  source_document_id uuid       not null,
  amount          numeric(24,8) not null,
  currency        text          not null,
  applied_amount  numeric(24,8) not null default 0,
  status          text          not null default 'available',
  expires_at      date,
  created_by      uuid,
  created_at      timestamptz   not null,
  version         integer       not null,
  constraint customer_credits_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint customer_credits_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint customer_credits_customer_fk
    foreign key (company_id, customer_id) references public.customers (company_id, id),
  constraint customer_credits_source_fk
    foreign key (company_id, source_document_id) references public.documents (company_id, id),
  constraint customer_credits_currency_fk foreign key (currency) references public.currencies (code),
  constraint customer_credits_amount_chk check (amount > 0),
  -- No se puede aplicar más de lo que hay. Es el invariante del saldo a favor.
  constraint customer_credits_applied_chk check (applied_amount >= 0 and applied_amount <= amount),
  constraint customer_credits_status_chk check (status in ('available', 'applied', 'expired')),
  constraint customer_credits_status_coherent_chk check (
    (status = 'applied') = (applied_amount = amount)),
  constraint customer_credits_company_id_key unique (company_id, id),
  constraint customer_credits_source_key unique (source_document_id)
);
comment on table public.customer_credits is
  'Saldo a favor del cliente, generado por una nota de crédito y aplicable como '
  'instrumento de pago. `applied_amount <= amount` es el invariante, en el '
  'esquema: aplicar más de lo disponible es imposible, no improbable.';
create index customer_credits_customer_idx
  on public.customer_credits (company_id, customer_id, status);
create index customer_credits_tenant_company_idx on public.customer_credits (tenant_id, company_id);

alter table public.payments
  add constraint payments_credit_fk
  foreign key (company_id, customer_credit_id) references public.customer_credits (company_id, id);

-- ── 8. Diferencial cambiario ────────────────────────────────────────────────
create table public.exchange_gain_loss (
  id              uuid          primary key default platform.uuidv7(),
  tenant_id       uuid          not null,
  company_id      uuid          not null,
  document_id     uuid          not null,
  payment_id      uuid          not null,
  -- El mismo importe visto con las dos tasas: la de emisión y la del cobro.
  amount_transaction     numeric(24,8) not null,
  transaction_currency   text          not null,
  functional_at_issue    numeric(24,8) not null,
  functional_at_payment  numeric(24,8) not null,
  -- cobro − emisión. Positivo = ganancia, negativo = pérdida.
  difference             numeric(24,8) not null,
  fx_rate_issue          numeric(24,8) not null,
  fx_rate_payment        numeric(24,8) not null,
  -- Gancho contable: la cuenta la resolverá `accounting_mappings` cuando exista.
  account_code    text,
  occurred_on     date          not null,
  created_by      uuid,
  created_at      timestamptz   not null,
  version         integer       not null,
  constraint exchange_gain_loss_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint exchange_gain_loss_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint exchange_gain_loss_document_fk
    foreign key (company_id, document_id) references public.documents (company_id, id),
  constraint exchange_gain_loss_payment_fk
    foreign key (company_id, payment_id) references public.payments (company_id, id),
  constraint exchange_gain_loss_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint exchange_gain_loss_difference_chk
    check (difference = functional_at_payment - functional_at_issue),
  constraint exchange_gain_loss_rates_chk check (fx_rate_issue > 0 and fx_rate_payment > 0),
  -- Un pago produce como mucho UN diferencial: dos serían contarlo dos veces.
  constraint exchange_gain_loss_payment_key unique (payment_id)
);
comment on table public.exchange_gain_loss is
  'Diferencial cambiario: el mismo importe valorado con la tasa de EMISIÓN y '
  'con la del COBRO. `difference` es una columna con CHECK, no un cálculo de '
  'lectura, para que nadie pueda insertar una diferencia que no cuadre. El '
  'ASIENTO es del módulo de contabilidad (gancho: account_code); el MODELO y el '
  'CÁLCULO están aquí, que es lo que pidió el encargo.';
create index exchange_gain_loss_company_date_idx
  on public.exchange_gain_loss (company_id, occurred_on desc);
create index exchange_gain_loss_tenant_company_idx
  on public.exchange_gain_loss (tenant_id, company_id);

-- ── 9. Devoluciones ─────────────────────────────────────────────────────────
create table public.returns (
  id              uuid        primary key default platform.uuidv7(),
  tenant_id       uuid        not null,
  company_id      uuid        not null,
  -- OBLIGATORIO: no hay devolución sin documento origen (decisión del encargo).
  source_document_id uuid     not null,
  credit_note_id  uuid,
  status          text        not null default 'draft',
  reason          text        not null,
  warehouse_id    uuid        not null,
  confirmed_at    timestamptz,
  created_by      uuid,
  created_at      timestamptz not null,
  version         integer     not null,
  constraint returns_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint returns_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint returns_source_fk
    foreign key (company_id, source_document_id) references public.documents (company_id, id),
  constraint returns_credit_note_fk
    foreign key (company_id, credit_note_id) references public.documents (company_id, id),
  constraint returns_warehouse_fk
    foreign key (company_id, warehouse_id) references public.warehouses (company_id, id),
  constraint returns_status_chk check (status in ('draft', 'confirmed', 'cancelled')),
  constraint returns_reason_chk check (length(btrim(reason)) between 3 and 500),
  constraint returns_confirmed_chk check ((status = 'confirmed') = (confirmed_at is not null)),
  constraint returns_company_id_key unique (company_id, id)
);
comment on table public.returns is
  'Devolución, SIEMPRE referida a su documento origen. Al confirmar: reingreso '
  'al inventario al COSTO ORIGINAL (el cost_snapshot de la línea del documento '
  'origen, NO el costo actual) y nota de crédito con saldo a favor.';

create table public.return_lines (
  id                    uuid          primary key default platform.uuidv7(),
  tenant_id             uuid          not null,
  company_id            uuid          not null,
  return_id             uuid          not null,
  source_line_id        uuid          not null,
  product_id            uuid          not null,
  quantity              numeric(24,8) not null,
  -- EL COSTO ORIGINAL, copiado de la línea del documento origen al crear la
  -- devolución. Que sea columna y no un JOIN es el punto: un recompute
  -- reinterpretaría el reingreso con el costo de hoy.
  unit_cost_original    numeric(24,8) not null,
  unit_price_transaction numeric(24,8) not null,
  created_by            uuid,
  created_at            timestamptz   not null,
  version               integer       not null,
  constraint return_lines_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint return_lines_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint return_lines_return_fk
    foreign key (company_id, return_id) references public.returns (company_id, id) on delete cascade,
  constraint return_lines_source_line_fk
    foreign key (company_id, source_line_id) references public.document_lines (company_id, id),
  constraint return_lines_product_fk
    foreign key (company_id, product_id) references public.products (company_id, id),
  constraint return_lines_quantity_chk check (quantity > 0),
  constraint return_lines_cost_chk check (unit_cost_original >= 0),
  constraint return_lines_key unique (return_id, source_line_id)
);
comment on table public.return_lines is
  'Línea devuelta. `unit_cost_original` se COPIA de la línea origen: el '
  'reingreso a inventario va a ese costo, no al vigente (decisión del encargo). '
  'Ejercido en pgTAP 021 cambiando el costo actual y viendo que no altera nada.';
create index return_lines_return_idx on public.return_lines (return_id);
create index returns_source_idx on public.returns (company_id, source_document_id);
create index returns_tenant_company_idx on public.returns (tenant_id, company_id);
create index return_lines_tenant_company_idx on public.return_lines (tenant_id, company_id);

-- ── 10. Reservas de stock (el hueco que ADR-0034 difirió a ventas) ──────────
create table public.stock_reservations (
  id              uuid          primary key default platform.uuidv7(),
  tenant_id       uuid          not null,
  company_id      uuid          not null,
  document_id     uuid          not null,
  warehouse_id    uuid          not null,
  product_id      uuid          not null,
  lot_id          uuid,
  quantity        numeric(24,8) not null,
  status          text          not null default 'active',
  expires_at      timestamptz   not null,
  released_at     timestamptz,
  created_by      uuid,
  created_at      timestamptz   not null,
  version         integer       not null,
  constraint stock_reservations_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint stock_reservations_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint stock_reservations_document_fk
    foreign key (company_id, document_id) references public.documents (company_id, id),
  constraint stock_reservations_warehouse_fk
    foreign key (company_id, warehouse_id) references public.warehouses (company_id, id),
  constraint stock_reservations_product_fk
    foreign key (company_id, product_id) references public.products (company_id, id),
  constraint stock_reservations_lot_fk
    foreign key (company_id, lot_id) references public.lots (company_id, id),
  constraint stock_reservations_quantity_chk check (quantity > 0),
  constraint stock_reservations_status_chk check (status in ('active', 'released', 'expired')),
  constraint stock_reservations_released_chk
    check ((status = 'active') = (released_at is null))
);
comment on table public.stock_reservations is
  'Reserva de existencias por un pedido confirmado. NO ES UN MOVIMIENTO DE '
  'KARDEX: una reserva es un compromiso, no una existencia, y meterla en '
  'inventory_moves haría que el kardex dejara de significar «lo que hay». Se '
  'libera al despachar o cancelar, y CADUCA (configurable por company) para que '
  'un pedido olvidado no bloquee stock para siempre.';
create index stock_reservations_position_idx
  on public.stock_reservations (company_id, warehouse_id, product_id, status);
create index stock_reservations_document_idx on public.stock_reservations (document_id);
create index stock_reservations_expiry_idx
  on public.stock_reservations (company_id, expires_at) where status = 'active';
create index stock_reservations_tenant_company_idx
  on public.stock_reservations (tenant_id, company_id);

-- Caducidad de reservas, configurable por company (encargo).
alter table public.inventory_settings
  add column reservation_ttl_days integer not null default 30;
alter table public.inventory_settings
  add constraint inventory_settings_reservation_ttl_chk
    check (reservation_ttl_days between 1 and 3650);
comment on column public.inventory_settings.reservation_ttl_days is
  'Días que vive una reserva de un pedido confirmado antes de caducar. Default '
  '30. Su expiración deja evento auditable — el worker la ejecuta.';

-- Disponible = existencia − reservado. El kardex NO se toca; la disponibilidad
-- es una LECTURA, no un segundo saldo persistido que pudiera divergir.
create function platform.available_stock(
  p_company uuid, p_warehouse uuid, p_product uuid, p_lot uuid default null
)
returns table (on_hand numeric, reserved numeric, available numeric)
language sql
stable
set search_path = ''
as $$
  select coalesce(b.quantity, 0),
         coalesce((select sum(r.quantity) from public.stock_reservations r
                    where r.company_id = p_company and r.warehouse_id = p_warehouse
                      and r.product_id = p_product
                      and r.lot_id is not distinct from p_lot
                      and r.status = 'active'), 0),
         coalesce(b.quantity, 0)
           - coalesce((select sum(r.quantity) from public.stock_reservations r
                        where r.company_id = p_company and r.warehouse_id = p_warehouse
                          and r.product_id = p_product
                          and r.lot_id is not distinct from p_lot
                          and r.status = 'active'), 0)
    from (select 1) dummy
    left join public.stock_balances b
      on b.company_id = p_company and b.warehouse_id = p_warehouse
     and b.product_id = p_product and b.lot_id is not distinct from p_lot
$$;
comment on function platform.available_stock(uuid, uuid, uuid, uuid) is
  'Existencia, reservado y disponible. El disponible se CALCULA: persistirlo '
  'sería un segundo saldo que puede divergir del kardex, que es justo lo que '
  'ADR-0034 evitó al materializar solo uno.';
revoke execute on function platform.available_stock(uuid, uuid, uuid, uuid) from public;
grant execute on function platform.available_stock(uuid, uuid, uuid, uuid)
  to authenticated, ladino_api;

-- ── 11. Saldo, antigüedad y estado de cuenta ────────────────────────────────
-- El saldo NO se persiste: total − Σ pagos aplicados, siempre calculado.
create function platform.document_balance(p_company uuid, p_document uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select d.total_amount
         - coalesce((select sum(p.functional_amount) from public.payments p
                      where p.document_id = d.id), 0)
    from public.documents d
   where d.id = p_document and d.company_id = p_company and d.status in ('issued', 'paid')
$$;
comment on function platform.document_balance(uuid, uuid) is
  'Saldo pendiente = total − Σ cobros, en moneda funcional. Calculado, nunca '
  'persistido: un saldo guardado es un segundo sitio donde la verdad diverge.';
revoke execute on function platform.document_balance(uuid, uuid) from public;
grant execute on function platform.document_balance(uuid, uuid) to authenticated, ladino_api;

-- Antigüedad de la cartera. Los cuatro rangos del encargo, contra fecha
-- PARÁMETRO — un aging de cierre de mes se pregunta con la fecha del cierre.
create function platform.ar_aging(
  p_company uuid, p_customer uuid default null, p_reference date default current_date
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
           (p_reference - d.issued_at::date) as dias,
           d.total_amount - coalesce((select sum(p.functional_amount) from public.payments p
                                       where p.document_id = d.id), 0) as saldo
      from public.documents d
     where d.company_id = p_company
       and d.kind = 'invoice'
       and d.status in ('issued', 'paid')
       and (p_customer is null or d.customer_id = p_customer)
       and d.issued_at::date <= p_reference
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
comment on function platform.ar_aging(uuid, uuid, date) is
  'Antigüedad de cuentas por cobrar en los cuatro rangos (0-30, 31-60, 61-90, '
  '90+). Solo documentos con SALDO: una factura pagada no envejece. La fecha de '
  'referencia es parámetro para poder preguntar por un cierre pasado.';
revoke execute on function platform.ar_aging(uuid, uuid, date) from public;
grant execute on function platform.ar_aging(uuid, uuid, date) to authenticated, ladino_api;

-- ── 12. Procedencia y anclas ────────────────────────────────────────────────
--
-- ⚠ CONTRATO DE set_row_provenance(), escrito aquí porque esta migración chocó
-- con él: la función escribe created_by, created_at Y **version**. LAS TRES.
-- Una tabla con `set_row_provenance` y sin columna `version` muere en el primer
-- INSERT con «record "new" has no field "version"» — le pasó a exchange_rates al
-- escribir esta migración, y no hay forma de verlo leyendo la tabla.
--
-- NO se deriva una variante `set_row_provenance_no_version()`, y la razón ya
-- estaba decidida en S0.4: `audit_events.version` es una columna MUERTA (esa
-- tabla no admite UPDATE) y se conservó igualmente porque «cuatro bytes cuestan
-- menos que una excepción en un trigger compartido, y un trigger con casos
-- especiales se aplica mal» (comentario de la migración 7, ADR-0026). Dos
-- funciones de procedencia serían dos sitios donde la política puede divergir, y
-- la que se elige mal no falla: escribe una fila con procedencia incompleta y en
-- silencio. La regla, entonces, es al revés de lo que parece:
--
--   TODA tabla con trigger de procedencia LLEVA `version integer not null`,
--   aunque nunca se actualice. Si no la lleva, es que no debe tener el trigger.
--
-- Se deja escrito en el propio catálogo para que se lea desde psql.
comment on function platform.set_row_provenance() is
  'Gobierna created_by, created_at y version: LAS TRES. Una tabla con este '
  'trigger DEBE tener las tres columnas o el primer INSERT muere con «record '
  'new has no field version» (le pasó a exchange_rates en la migración 21). NO '
  'existe una variante sin `version` a propósito: un trigger con casos '
  'especiales se aplica mal, y la política de procedencia dividida en dos '
  'funciones diverge sin fallar (ADR-0026, y el comentario de '
  'audit_events.version que ya lo decidió en S0.4). Si una tabla no puede '
  'llevar `version`, lo que no debe llevar es el trigger.';
create trigger fiscal_regimes_no_truncate
  before truncate on public.fiscal_regimes
  for each statement execute function platform.reject_mutation();
create trigger company_fiscal_regimes_provenance
  before insert or update on public.company_fiscal_regimes
  for each row execute function platform.set_row_provenance();
create trigger company_fiscal_regimes_anchors
  before update on public.company_fiscal_regimes
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger tax_rules_provenance
  before insert or update on public.tax_rules
  for each row execute function platform.set_row_provenance();
create trigger exchange_rates_provenance
  before insert or update on public.exchange_rates
  for each row execute function platform.set_row_provenance();
create trigger fiscal_number_ranges_provenance
  before insert or update on public.fiscal_number_ranges
  for each row execute function platform.set_row_provenance();
create trigger fiscal_number_ranges_anchors
  before update on public.fiscal_number_ranges
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger documents_00_provenance
  before insert or update on public.documents
  for each row execute function platform.set_row_provenance();
create trigger documents_01_anchors
  before update on public.documents
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger document_lines_provenance
  before insert or update on public.document_lines
  for each row execute function platform.set_row_provenance();
create trigger document_lines_anchors
  before update on public.document_lines
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger payments_provenance
  before insert or update on public.payments
  for each row execute function platform.set_row_provenance();
create trigger payments_anchors
  before update on public.payments
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger customer_credits_provenance
  before insert or update on public.customer_credits
  for each row execute function platform.set_row_provenance();
create trigger customer_credits_anchors
  before update on public.customer_credits
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger exchange_gain_loss_provenance
  before insert or update on public.exchange_gain_loss
  for each row execute function platform.set_row_provenance();
create trigger returns_provenance
  before insert or update on public.returns
  for each row execute function platform.set_row_provenance();
create trigger return_lines_provenance
  before insert or update on public.return_lines
  for each row execute function platform.set_row_provenance();
create trigger stock_reservations_provenance
  before insert or update on public.stock_reservations
  for each row execute function platform.set_row_provenance();
-- Y el ancla en LAS CUATRO que faltaban. No es decoración: el test 006 comprueba
-- como PROPIEDAD SOBRE EL CATÁLOGO que toda tabla de public con tenant_id lleva
-- este trigger, y se puso en rojo con estas cuatro. Lo encontró él, no una
-- revisión — que es exactamente para lo que la propiedad existe.
create trigger exchange_gain_loss_anchors
  before update on public.exchange_gain_loss
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger returns_anchors
  before update on public.returns
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger return_lines_anchors
  before update on public.return_lines
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger stock_reservations_anchors
  before update on public.stock_reservations
  for each row execute function platform.assert_isolation_anchors_immutable();

-- ── 13. INMUTABILIDAD del documento emitido (ADR-0006, dos capas) ───────────
-- El documento emitido no se edita ni se borra. Lo único que puede cambiar es
-- la transición sancionada issued → paid | annulled, y el número NUNCA se mueve.
create function platform.assert_document_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('issued', 'paid', 'annulled') then
      raise exception
        'un documento emitido no se borra: se anula, y su número se conserva (ADR-0037)'
        using errcode = 'LAD06';
    end if;
    return old;
  end if;

  if old.status in ('draft', 'confirmed', 'cancelled') then
    return new;  -- un borrador sí se edita: todavía no es un documento fiscal
  end if;

  -- A partir de aquí, old.status es issued | paid | annulled.
  if new.document_number is distinct from old.document_number
     or new.control_number is distinct from old.control_number
     or new.kind is distinct from old.kind
     or new.series is distinct from old.series
     or new.customer_id is distinct from old.customer_id
     or new.issued_at is distinct from old.issued_at
     or new.total_amount is distinct from old.total_amount
     or new.subtotal_amount is distinct from old.subtotal_amount
     or new.tax_amount is distinct from old.tax_amount
     or new.fx_rate is distinct from old.fx_rate
     or new.regime_version_id is distinct from old.regime_version_id
     or new.rules_version is distinct from old.rules_version then
    raise exception
      'la identidad fiscal de un documento emitido es inmutable: número, control, cliente, importes, tasa y anclas de versión no se tocan. Corrige con nota de crédito o débito.'
      using errcode = 'LAD06',
            hint = 'FISCAL_DOCUMENTS_SPEC: issued → adjusted vía NC/ND, nunca editando';
  end if;

  if not (
    (old.status = 'issued'   and new.status in ('issued', 'paid', 'annulled'))
    or (old.status = 'paid'    and new.status in ('paid', 'annulled'))
    or (old.status = 'annulled' and new.status = 'annulled')
  ) then
    raise exception 'transición de estado no permitida: % → %', old.status, new.status
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_document_immutable() from public;
create trigger documents_immutable
  before update or delete on public.documents
  for each row execute function platform.assert_document_immutable();
create trigger documents_no_truncate
  before truncate on public.documents
  for each statement execute function platform.reject_mutation();

-- Las líneas de un documento emitido son intocables sin matices.
create function platform.assert_document_lines_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_id     uuid;
begin
  v_id := case when tg_op = 'DELETE' then old.document_id else new.document_id end;
  select d.status into v_status from public.documents d where d.id = v_id;
  -- Si el documento ya no existe, es el ON DELETE CASCADE de un borrador.
  if v_status is null then return coalesce(new, old); end if;
  if v_status in ('issued', 'paid', 'annulled') then
    raise exception
      'las líneas de un documento emitido no se editan ni se borran: corrige con nota de crédito'
      using errcode = 'LAD06';
  end if;
  return coalesce(new, old);
end;
$$;
revoke execute on function platform.assert_document_lines_immutable() from public;
create trigger document_lines_immutable
  before update or delete on public.document_lines
  for each row execute function platform.assert_document_lines_immutable();
create trigger document_lines_no_truncate
  before truncate on public.document_lines
  for each statement execute function platform.reject_mutation();

-- Los cobros y el diferencial también son hechos: no se editan.
create trigger payments_append_only
  before update or delete on public.payments
  for each row execute function platform.reject_mutation();
create trigger payments_no_truncate
  before truncate on public.payments
  for each statement execute function platform.reject_mutation();
create trigger exchange_gain_loss_append_only
  before update or delete on public.exchange_gain_loss
  for each row execute function platform.reject_mutation();
create trigger exchange_gain_loss_no_truncate
  before truncate on public.exchange_gain_loss
  for each statement execute function platform.reject_mutation();

-- ── 14. LA EMISIÓN: número, control y régimen (ADR-0037, LAD49) ─────────────
-- BEFORE UPDATE, cuando un documento pasa a `issued`. Aquí y no en el caso de
-- uso porque es la red del esquema: la capa de aplicación puede olvidarse.
create function platform.assert_document_issuance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_regime record;
begin
  -- Se comprueba en INSERT **y** en UPDATE. Solo en UPDATE dejaría abierta la
  -- puerta grande: un INSERT directo con status='issued' se saltaría la regla
  -- entera de ADR-0037 y emitiría sin régimen ni número de control. «Ausencia de
  -- mecanismo no es prohibición» (CLAUDE.md §2) aplica también a los triggers:
  -- que el caso de uso siempre inserte en draft no es una defensa.
  if new.status <> 'issued' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'issued' then return new; end if;

  select * into v_regime from platform.regime_at(new.company_id, new.issued_at);
  if v_regime.regime_version_id is null then
    raise exception
      'la empresa no tiene régimen fiscal vigente a la fecha de emisión: asígnalo antes de emitir (ADR-0029)'
      using errcode = 'LAD49';
  end if;
  if new.regime_version_id is distinct from v_regime.regime_version_id then
    raise exception
      'el documento declara un régimen que no es el vigente a su fecha de emisión'
      using errcode = 'LAD49';
  end if;

  if v_regime.numbering_mode = 'none' then
    raise exception 'el régimen fiscal de esta empresa no permite emitir documentos'
      using errcode = 'LAD49';
  end if;

  -- LA REGLA DE ADR-0037, en las dos direcciones.
  if v_regime.numbering_mode in ('none', 'internal_only') and new.control_number is not null then
    raise exception
      'el régimen % no usa número de control y el documento trae uno: un número de control sin imprenta autorizada es un dato inventado',
      v_regime.regime_code
      using errcode = 'LAD49';
  end if;
  if v_regime.numbering_mode = 'range' and new.control_number is null then
    raise exception
      'el régimen % exige número de control de un rango autorizado y el documento no lo trae',
      v_regime.regime_code
      using errcode = 'LAD49';
  end if;

  if new.document_number is null then
    raise exception 'un documento emitido necesita su correlativo' using errcode = 'LAD49';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_document_issuance() from public;
create trigger documents_02_issuance
  before insert or update on public.documents
  for each row execute function platform.assert_document_issuance();

-- El correlativo del emisor, atómico y sin huecos. Cuenta lo YA ASIGNADO
-- —incluidos los anulados— así que anular nunca libera el número.
create function platform.claim_document_number(
  p_company uuid, p_kind text, p_series text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next bigint;
begin
  -- El bloqueo es sobre la company+tipo+serie, no sobre una tabla de contadores:
  -- pg_advisory_xact_lock serializa las emisiones de la misma serie sin crear
  -- una fila que mantener. Se libera solo al terminar la transacción.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company::text || '|' || p_kind || '|' || p_series, 0));
  select coalesce(max(d.document_number), 0) + 1 into v_next
    from public.documents d
   where d.company_id = p_company and d.kind = p_kind and d.series = p_series
     and d.document_number is not null;
  return v_next;
end;
$$;
comment on function platform.claim_document_number(uuid, text, text) is
  'El siguiente correlativo del emisor, serializado por advisory lock sobre '
  '(company, tipo, serie). Cuenta los YA ASIGNADOS incluidos los ANULADOS: '
  'anular no libera el número (ADR-0037). Sin huecos es incompatible con no '
  'bloquear, y se elige sin huecos.';
revoke execute on function platform.claim_document_number(uuid, text, text) from public;

grant execute on function platform.claim_control_number(uuid, text, text) to ladino_api;
grant execute on function platform.claim_document_number(uuid, text, text) to ladino_api;

-- ── 15. RLS y grants ────────────────────────────────────────────────────────
alter table public.fiscal_regimes         enable row level security;
alter table public.fiscal_regimes         force  row level security;
alter table public.company_fiscal_regimes enable row level security;
alter table public.company_fiscal_regimes force  row level security;
alter table public.tax_rules              enable row level security;
alter table public.tax_rules              force  row level security;
alter table public.exchange_rates         enable row level security;
alter table public.exchange_rates         force  row level security;
alter table public.fiscal_number_ranges   enable row level security;
alter table public.fiscal_number_ranges   force  row level security;
alter table public.documents              enable row level security;
alter table public.documents              force  row level security;
alter table public.document_lines         enable row level security;
alter table public.document_lines         force  row level security;
alter table public.payments               enable row level security;
alter table public.payments               force  row level security;
alter table public.customer_credits       enable row level security;
alter table public.customer_credits       force  row level security;
alter table public.exchange_gain_loss     enable row level security;
alter table public.exchange_gain_loss     force  row level security;
alter table public.returns                enable row level security;
alter table public.returns                force  row level security;
alter table public.return_lines           enable row level security;
alter table public.return_lines           force  row level security;
alter table public.stock_reservations     enable row level security;
alter table public.stock_reservations     force  row level security;

-- Catálogos GLOBALES: lectura para todos, escritura denegada POR ESCRITO.
create policy fiscal_regimes_select on public.fiscal_regimes
  for select to authenticated, ladino_api using (true);
create policy fiscal_regimes_insert on public.fiscal_regimes
  for insert to authenticated, ladino_api with check (false);
create policy fiscal_regimes_update on public.fiscal_regimes
  for update to authenticated, ladino_api using (false);
create policy fiscal_regimes_delete on public.fiscal_regimes
  for delete to authenticated, ladino_api using (false);

-- tax_rules y exchange_rates: lectura para todos; la API las carga (el operador
-- sube alícuotas con su fuente y el adaptador BCV sube tasas).
create policy tax_rules_select on public.tax_rules
  for select to authenticated, ladino_api using (true);
create policy tax_rules_insert on public.tax_rules for insert to authenticated with check (false);
create policy tax_rules_update on public.tax_rules for update to authenticated using (false);
create policy tax_rules_delete on public.tax_rules
  for delete to authenticated, ladino_api using (false);
create policy tax_rules_api_insert on public.tax_rules for insert to ladino_api with check (true);
create policy tax_rules_api_update on public.tax_rules for update to ladino_api
  using (true) with check (true);

create policy exchange_rates_select on public.exchange_rates
  for select to authenticated, ladino_api using (true);
create policy exchange_rates_insert on public.exchange_rates
  for insert to authenticated with check (false);
create policy exchange_rates_update on public.exchange_rates
  for update to authenticated, ladino_api using (false);
create policy exchange_rates_delete on public.exchange_rates
  for delete to authenticated, ladino_api using (false);
create policy exchange_rates_api_insert on public.exchange_rates
  for insert to ladino_api with check (true);

revoke all on public.fiscal_regimes, public.tax_rules, public.exchange_rates
  from anon, authenticated, service_role, ladino_api, ladino_worker;
grant select on public.fiscal_regimes to authenticated, ladino_api;
grant select on public.tax_rules, public.exchange_rates to authenticated;
grant select, insert, update on public.tax_rules to ladino_api;
grant select, insert on public.exchange_rates to ladino_api;

-- Por company: authenticated LEE lo suyo; ladino_api escribe acotada a su tenant.
do $$
declare t text;
begin
  foreach t in array array['company_fiscal_regimes', 'fiscal_number_ranges', 'documents',
                           'document_lines', 'payments', 'customer_credits',
                           'exchange_gain_loss', 'returns', 'return_lines',
                           'stock_reservations']
  loop
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

-- DELETE denegado para ladino_api en todo lo que es hecho consumado; permitido
-- solo en las tablas de borrador (líneas de documentos draft, líneas de
-- devolución draft), que es donde editar todavía significa algo.
create policy documents_api_delete on public.documents for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids())
         and status in ('draft', 'confirmed', 'cancelled'));
create policy document_lines_api_delete on public.document_lines for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy return_lines_api_delete on public.return_lines for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy payments_api_delete on public.payments for delete to ladino_api using (false);
create policy exchange_gain_loss_api_delete on public.exchange_gain_loss
  for delete to ladino_api using (false);
create policy customer_credits_api_delete on public.customer_credits
  for delete to ladino_api using (false);
create policy company_fiscal_regimes_api_delete on public.company_fiscal_regimes
  for delete to ladino_api using (false);
create policy fiscal_number_ranges_api_delete on public.fiscal_number_ranges
  for delete to ladino_api using (false);
create policy returns_api_delete on public.returns for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()) and status = 'draft');
create policy stock_reservations_api_delete on public.stock_reservations
  for delete to ladino_api using (false);

revoke all on public.company_fiscal_regimes, public.fiscal_number_ranges, public.documents,
              public.document_lines, public.payments, public.customer_credits,
              public.exchange_gain_loss, public.returns, public.return_lines,
              public.stock_reservations
  from anon, authenticated, service_role, ladino_api, ladino_worker;
grant select on public.company_fiscal_regimes, public.fiscal_number_ranges, public.documents,
                public.document_lines, public.payments, public.customer_credits,
                public.exchange_gain_loss, public.returns, public.return_lines,
                public.stock_reservations
  to authenticated;
grant select, insert, update on public.company_fiscal_regimes, public.fiscal_number_ranges,
                                public.documents, public.customer_credits,
                                public.stock_reservations, public.returns
  to ladino_api;
grant select, insert, update, delete on public.document_lines, public.return_lines to ladino_api;
-- Append-only de verdad: ni UPDATE ni DELETE por GRANT.
grant select, insert on public.payments, public.exchange_gain_loss to ladino_api;

-- ── 16. Seeds ───────────────────────────────────────────────────────────────
-- Regímenes con su norma citada. NINGUNO en `per_document`: ese modo existe
-- como forma de datos pero el flujo de dos fases sigue abierto (OPEN_QUESTIONS
-- 10) y no se habilita en nadie hasta elegir imprenta. VALIDAR-SENIAT.
insert into public.fiscal_regimes
  (code, name, description, allowed_kinds, numbering_mode, requires_transmission, legal_source)
values
  ('sin_emision', 'Sin emisión fiscal',
   'ERP administrativo y contable. No emite documentos fiscales.',
   '{}', 'none', false,
   'No aplica: la empresa no emite documentos fiscales.'),
  ('formatos_libres', 'Formatos libres',
   'Emisión con formatos libres por imprenta autorizada, con rango de números de control.',
   array['invoice', 'credit_note', 'debit_note', 'delivery_note'], 'range', false,
   'Providencia Administrativa SNAT/2011/00071, Gaceta Oficial 39.795 del 08/11/2011.'),
  ('interno_no_fiscal', 'Numeración interna sin valor fiscal',
   'Documentos internos (cotizaciones, pedidos, notas de entrega no fiscales) con correlativo propio y sin número de control.',
   array['quote', 'order'], 'internal_only', false,
   'No aplica: documentos sin efecto fiscal.')
on conflict (code) do nothing;

-- Permisos de ventas.
insert into public.permissions (key, description, is_scoped) values
  ('sales.quote.manage',       'Crear y editar cotizaciones',                              false),
  ('sales.order.manage',       'Crear y confirmar pedidos, reservando existencias',        false),
  ('sales.invoice.issue',      'Emitir facturas de venta',                                 false),
  ('sales.invoice.annul',      'Anular una factura emitida',                               false),
  ('sales.price_list.override','Cambiar la lista de precios de una venta concreta',        false),
  ('sales.payment.register',   'Registrar cobros y aplicar saldos a favor',                false),
  ('sales.return.manage',      'Registrar devoluciones y generar notas de crédito',        false),
  ('ar.read',                  'Consultar cuentas por cobrar, antigüedad y estado de cuenta', false),
  ('fiscal.range.manage',      'Cargar rangos de números de control de la imprenta',       false),
  ('fiscal.regime.manage',     'Asignar el régimen fiscal vigente de una empresa',         false),
  ('tax.rules.manage',         'Cargar reglas tributarias con su fuente legal',            false),
  ('fx.rate.manage',           'Cargar tasas de cambio con su fuente',                     false)
on conflict (key) do nothing;

-- ── 17. Lo que esta migración GARANTIZA sobre sí misma (LAD52) ──────────────
do $$
begin
  if (select count(*) from public.tax_rules) <> 0 then
    raise exception 'LAD52: tax_rules DEBE nacer vacía (ADR-0038): la migración no siembra alícuotas';
  end if;
  if (select count(*) from public.fiscal_regimes where numbering_mode = 'per_document') <> 0 then
    raise exception 'LAD52: ningún régimen se siembra en per_document: el flujo de dos fases sigue abierto (OPEN_QUESTIONS 10)';
  end if;
  if (select count(*) from public.fiscal_regimes where length(btrim(legal_source)) < 3) <> 0 then
    raise exception 'LAD52: hay un régimen sin norma citada, que es una obligación inventada';
  end if;
  if (select count(*) from public.permissions where key like 'sales.%' or key like 'ar.%'
       or key in ('fiscal.range.manage','fiscal.regime.manage','tax.rules.manage','fx.rate.manage')) <> 12 then
    raise exception 'LAD52: faltan permisos de ventas tras el seed';
  end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('fiscal_regimes','company_fiscal_regimes','tax_rules','exchange_rates',
                           'fiscal_number_ranges','documents','document_lines','payments',
                           'customer_credits','exchange_gain_loss','returns','return_lines',
                           'stock_reservations')
         and c.relrowsecurity and c.relforcerowsecurity) <> 13 then
    raise exception 'LAD52: alguna tabla de ventas no tiene RLS habilitada y forzada';
  end if;
  if (select count(*) from information_schema.role_table_grants
       where table_schema = 'public' and table_name in ('payments','exchange_gain_loss')
         and grantee in ('anon','authenticated','service_role','ladino_api','ladino_worker')
         and privilege_type in ('UPDATE','DELETE','TRUNCATE')) <> 0 then
    raise exception 'LAD52: payments o exchange_gain_loss tienen privilegio de mutación: son append-only';
  end if;
end $$;

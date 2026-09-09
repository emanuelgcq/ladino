-- =============================================================================
-- Ladino — migración 46: DECLARACIONES DE IVA e IGTF (encargo 2026-09-08)
--
-- Módulos: fiscal · tesorería · contabilidad. Rigor máximo.
-- Piezas, todas del mismo encargo (huecos H-1…H-13 aprobados por el dueño):
--
--   1. RETENCIONES SOPORTADAS (las que un cliente-agente NOS practica):
--      tabla propia, carga manual, y el instrumento `retencion_iva` en
--      payments para abonar la factura afectada sin mover efectivo — estrena
--      el papel `retention_iva_receivable` sembrado en la migración 28.
--   2. RESULTADO DEL PERÍODO IVA con arrastre: `iva_period_results`
--      (insert-only, patrón fiscal_book_runs: cada generación es una fila con
--      hash — la sustitutiva existe) + `platform.recompute_iva_period()`.
--      El traslado del excedente de crédito fiscal al período siguiente
--      (LIVA, artículo por confirmar en la numeración vigente —
--      PENDIENTES_ASESOR.md).
--   3. IGTF — percepción para sujetos pasivos ESPECIALES:
--      · `igtf_rules` global, SEMBRADA con el 3 % citando la Ley de reforma
--        (G.O. Ext. 6.687, 25-feb-2022) y la PA SNAT/2022/000013
--        (G.O. 42.339): SPE como agentes de percepción, percepción el mismo
--        día del pago, declaración quincenal;
--      · `igtf_company_instruments` por empresa (qué instrumento causa —
--        DATO editable; se siembra al ACTIVAR, desde el dominio);
--      · `igtf_exemptions` global VACÍA (las exenciones concretas del
--        decreto son VALIDAR-TRIBUTARIO; sin regla de exención SE PERCIBE);
--      · `igtf_perceptions` por pago (base = el importe de ESE pago; en un
--        pago mixto solo la porción en divisa causa), con estado
--        `pendiente_reintegro` para la anulación (la percepción nunca se
--        resta sola);
--      · activación por empresa con acta (`companies.igtf_enabled_at`),
--        solo si su clasificación es `especial`.
--   4. CALENDARIO: `company_fiscal_deadlines` CARGABLE por empresa con cita
--      de fuente — las fechas por dígito de RIF de la providencia 2026 NO
--      están en ninguna fuente reproducible y no se inventan (H-4). Los
--      ordinarios (primeros 15 días) se computan sin tabla.
--   5. Adaptador `txt_retenciones_iva` para las retenciones PRACTICADAS
--      (is_official = false hasta validar contra una carga real del portal).
--   6. Contabilidad: papel `igtf_percibido_por_enterar` (+ cuenta 2.1.91 en
--      la plantilla), vocabulario `igtf_perception` en las TRES casas, y dos
--      asientos nuevos del preset (retención soportada aplicada; percepción).
--
-- Reversibilidad: tablas nuevas vacías (se retiran), CHECKs se restauran con
-- la lista previa, la fila de igtf_rules y las de preset se borran con
-- delete. `iva_period_results` es insert-only: se revierte quitando la tabla
-- (no hay historia ajena que preservar el día 1).
-- Impacto de homologación: NO (no toca numeración ni emisión; la percepción
-- IGTF en factura/recibo es contenido del PDF, no formato homologado —
-- VALIDAR-TRIBUTARIO donde se indica).
-- =============================================================================

-- ── 1. RETENCIONES SOPORTADAS ───────────────────────────────────────────────

create table public.supported_retention_receipts (
  id              uuid          primary key default platform.uuidv7(),
  tenant_id       uuid          not null,
  company_id      uuid          not null,
  -- El AGENTE que nos retuvo: un cliente (sujeto pasivo especial).
  customer_id     uuid          not null,
  -- La factura NUESTRA afectada por la retención.
  document_id     uuid          not null,
  -- El comprobante TAL COMO EL AGENTE LO EMITIÓ (se transcribe; la máscara de
  -- 14 caracteres de PA 102 es para los que NOSOTROS emitimos — H-12).
  receipt_number  text          not null,
  retention_code  text          not null default 'iva',
  -- Cuándo nos retuvieron: la fecha que asigna la retención a su período.
  retained_on     date          not null,
  base            numeric(24,8) not null,
  -- La porción retenida como FRACCIÓN (0.75 o 1.00): DATO transcrito, no regla.
  rate            numeric(9,8)  not null,
  amount          numeric(24,8) not null,
  functional_currency text      not null,
  status          text          not null default 'registered',
  annul_reason    text,

  created_by      uuid,
  created_at      timestamptz   not null,
  version         integer       not null,

  constraint srr_tenant_fk  foreign key (tenant_id) references public.tenants (id),
  constraint srr_company_fk foreign key (tenant_id, company_id)
    references public.companies (tenant_id, id),
  constraint srr_customer_fk foreign key (company_id, customer_id)
    references public.customers (company_id, id),
  constraint srr_document_fk foreign key (company_id, document_id)
    references public.documents (company_id, id),
  constraint srr_code_chk    check (retention_code in ('iva')),
  constraint srr_receipt_chk check (receipt_number = btrim(receipt_number)
                                    and length(receipt_number) between 1 and 40),
  constraint srr_amounts_chk check (base > 0 and amount > 0 and rate > 0 and rate <= 1),
  constraint srr_status_chk  check (status in ('registered', 'annulled')),
  constraint srr_annul_chk   check ((status = 'annulled') = (annul_reason is not null)),
  -- El mismo comprobante del mismo agente no se carga dos veces.
  constraint srr_unique_receipt unique (company_id, customer_id, receipt_number),
  constraint srr_company_id_key unique (company_id, id)
);
create index srr_period_idx on public.supported_retention_receipts (company_id, retained_on);
create trigger supported_retention_receipts_00_provenance
  before insert or update on public.supported_retention_receipts
  for each row execute function platform.set_row_provenance();
create trigger supported_retention_receipts_01_anchors
  before update on public.supported_retention_receipts
  for each row execute function platform.assert_isolation_anchors_immutable();
alter table public.supported_retention_receipts enable row level security;
alter table public.supported_retention_receipts force row level security;
revoke all on public.supported_retention_receipts from anon, authenticated, service_role;
grant select, insert, update on public.supported_retention_receipts to ladino_api;
create policy srr_api_select on public.supported_retention_receipts
  for select to ladino_api using (true);
create policy srr_api_insert on public.supported_retention_receipts
  for insert to ladino_api with check (true);
create policy srr_api_update on public.supported_retention_receipts
  for update to ladino_api using (true) with check (true);

-- El instrumento que abona la factura afectada SIN mover efectivo (H-5).
alter table public.payments add column supported_retention_id uuid;
alter table public.payments add constraint payments_supported_retention_fk
  foreign key (company_id, supported_retention_id)
  references public.supported_retention_receipts (company_id, id);
alter table public.payments drop constraint payments_instrument_chk;
alter table public.payments add constraint payments_instrument_chk check (instrument in
  ('efectivo_bs', 'efectivo_usd', 'zelle', 'usdt', 'transferencia', 'punto_venta',
   'pago_movil', 'tarjeta', 'cashea', 'saldo_a_favor', 'retencion_iva', 'otro'));
alter table public.payments add constraint payments_retention_shape_chk
  check ((instrument = 'retencion_iva') = (supported_retention_id is not null));
-- El shape de la cuenta APRENDE el instrumento nuevo (lo cazó el pgTAP 046 al
-- escribirse): los abonos SIN efectivo son ahora DOS — saldo_a_favor y
-- retencion_iva — y ninguno lleva cuenta de dinero.
alter table public.payments drop constraint payments_account_shape_chk;
alter table public.payments add constraint payments_account_shape_chk
  check ((instrument in ('saldo_a_favor', 'retencion_iva')) = (account_id is null));

-- ── 2. RESULTADO DEL PERÍODO IVA (insert-only, patrón runs) ─────────────────

create table public.iva_period_results (
  id                    uuid          primary key default platform.uuidv7(),
  tenant_id             uuid          not null,
  company_id            uuid          not null,
  period_from           date          not null,
  period_to             date          not null,
  -- Los agregados del período, en moneda funcional. La agregación viene de
  -- los SNAPSHOTS de las líneas (H-1): el pasado no se recalcula con reglas
  -- de hoy. NC resta débitos, ND suma (regla provisional H-3,
  -- VALIDAR-TRIBUTARIO); anuladas fuera del resultado.
  debitos               numeric(24,8) not null,
  creditos              numeric(24,8) not null,
  -- Tras la prorrata GLOBAL v1 (H-11) cuando hubo ventas exentas/exoneradas.
  creditos_deducibles   numeric(24,8) not null,
  prorrata_pct          numeric(9,8),
  retenciones_soportadas numeric(24,8) not null,
  excedente_anterior    numeric(24,8) not null,
  cuota_a_pagar         numeric(24,8) not null,
  -- Arrastre combinado v1 (excedente de crédito + retenciones no absorbidas;
  -- el portal los separa — PENDIENTES_ASESOR).
  excedente_siguiente   numeric(24,8) not null,
  -- El desglose por alícuota y tratamiento que pinta la pantalla.
  detalle               jsonb         not null,
  generator_version     text          not null,
  dataset_hash          text          not null,

  created_by            uuid,
  created_at            timestamptz   not null,
  version               integer       not null,

  constraint ipr_tenant_fk  foreign key (tenant_id) references public.tenants (id),
  constraint ipr_company_fk foreign key (tenant_id, company_id)
    references public.companies (tenant_id, id),
  constraint ipr_period_chk check (period_from <= period_to),
  -- `debitos` puede ser NEGATIVO (un período con más notas de crédito que
  -- ventas es legítimo); créditos y el resto, no.
  constraint ipr_amounts_chk check (
    creditos >= 0 and creditos_deducibles >= 0
    and retenciones_soportadas >= 0 and excedente_anterior >= 0
    and cuota_a_pagar >= 0 and excedente_siguiente >= 0
    and (cuota_a_pagar = 0 or excedente_siguiente = 0)),
  constraint ipr_prorrata_chk check (prorrata_pct is null
                                     or (prorrata_pct >= 0 and prorrata_pct <= 1))
);
create index ipr_period_idx on public.iva_period_results
  (company_id, period_from, period_to, created_at desc);
create trigger iva_period_results_00_provenance
  before insert or update on public.iva_period_results
  for each row execute function platform.set_row_provenance();
create trigger iva_period_results_01_anchors
  before update on public.iva_period_results
  for each row execute function platform.assert_isolation_anchors_immutable();
-- Insert-only de VERDAD (regla de la primera excepción): ni update ni delete.
create function platform.assert_iva_period_result_immutable()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'iva_period_results es insert-only: una generación no se edita — genera otra (la sustitutiva existe)';
end $$;
revoke execute on function platform.assert_iva_period_result_immutable() from public;
create trigger iva_period_results_02_append_only
  before update or delete on public.iva_period_results
  for each row execute function platform.assert_iva_period_result_immutable();
alter table public.iva_period_results enable row level security;
alter table public.iva_period_results force row level security;
revoke all on public.iva_period_results from anon, authenticated, service_role;
grant select, insert on public.iva_period_results to ladino_api;
create policy ipr_api_select on public.iva_period_results
  for select to ladino_api using (true);
create policy ipr_api_insert on public.iva_period_results
  for insert to ladino_api with check (true);

/**
 * El CÁLCULO del período, dado el excedente anterior (el encadenado lo hace
 * el dominio caminando desde el primer período). Todo desde snapshots:
 * `tax_rate_snapshot` y `tax_amount` de las líneas de venta; `tax_amount`
 * recuperable de las facturas de proveedor; retenciones soportadas por fecha.
 */
create function platform.recompute_iva_period(
  p_company uuid, p_from date, p_to date, p_excedente_anterior numeric
)
returns table (
  debitos numeric, creditos numeric, creditos_deducibles numeric,
  prorrata_pct numeric, retenciones_soportadas numeric,
  cuota_a_pagar numeric, excedente_siguiente numeric, detalle jsonb
)
language sql
stable
set search_path = ''
as $$
  with ventas as (
    select case d.kind when 'credit_note' then -1 else 1 end as signo,
           l.tax_rate_snapshot as alicuota,
           l.tax_amount, l.functional_amount,
           d.kind
      from public.documents d
      join public.document_lines l on l.document_id = d.id
     where d.company_id = p_company
       and d.kind in ('invoice', 'credit_note', 'debit_note')
       and d.status in ('issued', 'paid')
       and (d.issued_at at time zone 'America/Caracas')::date between p_from and p_to
  ),
  por_alicuota as (
    select alicuota,
           sum(signo * functional_amount) as base,
           sum(signo * tax_amount) as impuesto
      from ventas group by alicuota
  ),
  deb as (select coalesce(sum(impuesto), 0) as total from por_alicuota),
  bases_venta as (
    select coalesce(sum(signo * functional_amount) filter (where tax_amount <> 0), 0) as gravadas,
           coalesce(sum(signo * functional_amount) filter (where tax_amount = 0), 0) as sin_impuesto
      from ventas
  ),
  cred as (
    select coalesce(sum(i.tax_amount), 0) as total
      from public.supplier_invoices i
     where i.company_id = p_company
       and i.status in ('posted', 'paid')
       and i.tax_is_recoverable
       and i.invoice_date between p_from and p_to
  ),
  ret as (
    select coalesce(sum(r.amount), 0) as total
      from public.supported_retention_receipts r
     where r.company_id = p_company and r.status = 'registered'
       and r.retained_on between p_from and p_to
  ),
  prorrata as (
    -- GLOBAL v1 (H-11, VALIDAR-TRIBUTARIO): solo cuando hubo ventas sin
    -- impuesto en el período; pct = gravadas / (gravadas + sin impuesto).
    select case
             when b.sin_impuesto > 0 and (b.gravadas + b.sin_impuesto) > 0
               then round(b.gravadas / (b.gravadas + b.sin_impuesto), 8)
             else null
           end as pct
      from bases_venta b
  ),
  calc as (
    select d.total as debitos,
           c.total as creditos,
           case when p.pct is null then c.total
                else round(c.total * p.pct, 8) end as deducibles,
           p.pct, r.total as retenciones
      from deb d, cred c, ret r, prorrata p
  )
  select
    calc.debitos, calc.creditos, calc.deducibles, calc.pct, calc.retenciones,
    greatest(0, calc.debitos - calc.deducibles - p_excedente_anterior - calc.retenciones)
      as cuota_a_pagar,
    greatest(0, -(calc.debitos - calc.deducibles - p_excedente_anterior - calc.retenciones))
      as excedente_siguiente,
    (select coalesce(jsonb_agg(jsonb_build_object(
              'alicuota', a.alicuota::text,
              'base', a.base::text,
              'impuesto', a.impuesto::text) order by a.alicuota), '[]'::jsonb)
       from por_alicuota a) as detalle
  from calc
$$;
revoke execute on function platform.recompute_iva_period(uuid, date, date, numeric) from public;
grant execute on function platform.recompute_iva_period(uuid, date, date, numeric)
  to ladino_api;

-- ── 3. IGTF ─────────────────────────────────────────────────────────────────

-- Regla NACIONAL con vigencia y fuente. A diferencia de tax_rules, aquí SÍ
-- hay norma única citable — la fila del 3 % se siembra con su gaceta.
create table public.igtf_rules (
  id             uuid          primary key default platform.uuidv7(),
  rate           numeric(9,8)  not null,
  effective_from date          not null,
  effective_to   date,
  legal_source   text          not null,
  created_at     timestamptz   not null default now(),
  constraint igtf_rules_rate_chk check (rate >= 0 and rate <= 1),
  constraint igtf_rules_source_chk check (length(btrim(legal_source)) >= 10)
);
alter table public.igtf_rules enable row level security;
alter table public.igtf_rules force row level security;
revoke all on public.igtf_rules from anon, authenticated, service_role;
grant select on public.igtf_rules to ladino_api;
create policy igtf_rules_api_select on public.igtf_rules
  for select to ladino_api using (true);
insert into public.igtf_rules (rate, effective_from, legal_source) values
  (0.03, '2022-03-28',
   'Ley de Reforma Parcial de la Ley de Impuesto a las Grandes Transacciones '
   'Financieras (G.O. Ext. 6.687 del 25-feb-2022, alícuota 3 % para pagos en '
   'moneda distinta a la de curso legal sin mediación del sistema financiero) '
   'y PA SNAT/2022/000013 (G.O. 42.339: sujetos pasivos especiales como '
   'agentes de percepción; percepción el mismo día del pago; declaración '
   'quincenal). Vigencia operativa desde el 28-mar-2022 conforme a la PA.');

-- Exenciones/no sujeciones: VACÍA a propósito (H-8). El decreto de
-- exoneraciones existe; CUÁLES aplican a cada negocio lo confirma el asesor
-- (VALIDAR-TRIBUTARIO). Sin regla de exención cargada, SE PERCIBE.
create table public.igtf_exemptions (
  id             uuid          primary key default platform.uuidv7(),
  concept        text          not null,
  description    text          not null,
  legal_source   text          not null,
  effective_from date          not null,
  effective_to   date,
  created_at     timestamptz   not null default now(),
  constraint igtf_ex_source_chk check (length(btrim(legal_source)) >= 10)
);
alter table public.igtf_exemptions enable row level security;
alter table public.igtf_exemptions force row level security;
revoke all on public.igtf_exemptions from anon, authenticated, service_role;
grant select on public.igtf_exemptions to ladino_api;
create policy igtf_ex_api_select on public.igtf_exemptions
  for select to ladino_api using (true);

-- La activación POR EMPRESA (acta en el dominio): solo clasificación
-- `especial`, y con confirmación del dueño — la designación SPE es individual.
alter table public.companies add column igtf_enabled_at timestamptz;

-- Qué instrumento CAUSA percepción, por empresa (DATO editable; se siembra al
-- activar). Asimetría H-8: sin fila o causes=false ⇒ NO percibe (la
-- percepción indebida obliga a reintegro); las exenciones van al revés.
create table public.igtf_company_instruments (
  tenant_id   uuid    not null,
  company_id  uuid    not null,
  instrument  text    not null,
  causes      boolean not null,
  created_by  uuid,
  created_at  timestamptz not null,
  version     integer not null,
  primary key (company_id, instrument),
  constraint ici_tenant_fk  foreign key (tenant_id) references public.tenants (id),
  constraint ici_company_fk foreign key (tenant_id, company_id)
    references public.companies (tenant_id, id),
  constraint ici_instrument_chk check (instrument in
    ('efectivo_bs', 'efectivo_usd', 'zelle', 'usdt', 'transferencia', 'punto_venta',
     'pago_movil', 'tarjeta', 'cashea', 'otro'))
);
create trigger igtf_company_instruments_00_provenance
  before insert or update on public.igtf_company_instruments
  for each row execute function platform.set_row_provenance();
create trigger igtf_company_instruments_01_anchors
  before update on public.igtf_company_instruments
  for each row execute function platform.assert_isolation_anchors_immutable();
alter table public.igtf_company_instruments enable row level security;
alter table public.igtf_company_instruments force row level security;
revoke all on public.igtf_company_instruments from anon, authenticated, service_role;
grant select, insert, update on public.igtf_company_instruments to ladino_api;
create policy ici_api_select on public.igtf_company_instruments
  for select to ladino_api using (true);
create policy ici_api_insert on public.igtf_company_instruments
  for insert to ladino_api with check (true);
create policy ici_api_update on public.igtf_company_instruments
  for update to ladino_api using (true) with check (true);

-- La PERCEPCIÓN, una por pago (H-7: base = el importe de ESE pago, en SU
-- moneda; en pago mixto cada pago causa —o no— por separado). El estado
-- `pendiente_reintegro` es el borde de la anulación: nunca se resta sola.
create table public.igtf_perceptions (
  id                  uuid          primary key default platform.uuidv7(),
  tenant_id           uuid          not null,
  company_id          uuid          not null,
  payment_id          uuid          not null,
  document_id         uuid          not null,
  base_amount         numeric(24,8) not null,
  currency            text          not null,
  rate                numeric(9,8)  not null,
  amount              numeric(24,8) not null,
  functional_amount   numeric(24,8) not null,
  fx_rate             numeric(24,8) not null,
  rate_source         text          not null,
  status              text          not null default 'percibido',
  status_reason       text,
  occurred_at         timestamptz   not null,

  created_by          uuid,
  created_at          timestamptz   not null,
  version             integer       not null,

  constraint ip_tenant_fk  foreign key (tenant_id) references public.tenants (id),
  constraint ip_company_fk foreign key (tenant_id, company_id)
    references public.companies (tenant_id, id),
  constraint ip_payment_fk foreign key (company_id, payment_id)
    references public.payments (company_id, id),
  constraint ip_document_fk foreign key (company_id, document_id)
    references public.documents (company_id, id),
  constraint ip_amounts_chk check (base_amount > 0 and amount > 0
                                   and functional_amount > 0 and fx_rate > 0),
  constraint ip_rate_chk    check (rate > 0 and rate <= 1),
  constraint ip_status_chk  check (status in ('percibido', 'pendiente_reintegro')),
  constraint ip_reason_chk  check ((status = 'pendiente_reintegro') = (status_reason is not null)),
  -- UNA percepción por pago: reintentar el cobro no percibe dos veces.
  constraint ip_payment_key unique (company_id, payment_id),
  constraint ip_company_id_key unique (company_id, id)
);
create index ip_period_idx on public.igtf_perceptions (company_id, occurred_at);
create trigger igtf_perceptions_00_provenance
  before insert or update on public.igtf_perceptions
  for each row execute function platform.set_row_provenance();
create trigger igtf_perceptions_01_anchors
  before update on public.igtf_perceptions
  for each row execute function platform.assert_isolation_anchors_immutable();
alter table public.igtf_perceptions enable row level security;
alter table public.igtf_perceptions force row level security;
revoke all on public.igtf_perceptions from anon, authenticated, service_role;
grant select, insert, update on public.igtf_perceptions to ladino_api;
create policy ip_api_select on public.igtf_perceptions
  for select to ladino_api using (true);
create policy ip_api_insert on public.igtf_perceptions
  for insert to ladino_api with check (true);
create policy ip_api_update on public.igtf_perceptions
  for update to ladino_api using (true) with check (true);

-- ── 4. CALENDARIO CARGABLE (H-4: las fechas no se inventan) ─────────────────

create table public.company_fiscal_deadlines (
  id           uuid        primary key default platform.uuidv7(),
  tenant_id    uuid        not null,
  company_id   uuid        not null,
  obligation   text        not null,
  period_from  date        not null,
  period_to    date        not null,
  due_date     date        not null,
  legal_source text        not null,
  created_by   uuid,
  created_at   timestamptz not null,
  version      integer     not null,
  constraint cfd_tenant_fk  foreign key (tenant_id) references public.tenants (id),
  constraint cfd_company_fk foreign key (tenant_id, company_id)
    references public.companies (tenant_id, id),
  constraint cfd_obligation_chk check (obligation in ('iva', 'igtf', 'ret_iva', 'islr')),
  constraint cfd_period_chk check (period_from <= period_to),
  constraint cfd_source_chk check (length(btrim(legal_source)) >= 10),
  constraint cfd_unique unique (company_id, obligation, period_from, period_to)
);
create index cfd_due_idx on public.company_fiscal_deadlines (company_id, due_date);
create trigger company_fiscal_deadlines_00_provenance
  before insert or update on public.company_fiscal_deadlines
  for each row execute function platform.set_row_provenance();
create trigger company_fiscal_deadlines_01_anchors
  before update on public.company_fiscal_deadlines
  for each row execute function platform.assert_isolation_anchors_immutable();
alter table public.company_fiscal_deadlines enable row level security;
alter table public.company_fiscal_deadlines force row level security;
revoke all on public.company_fiscal_deadlines from anon, authenticated, service_role;
grant select, insert, delete on public.company_fiscal_deadlines to ladino_api;
create policy cfd_api_select on public.company_fiscal_deadlines
  for select to ladino_api using (true);
create policy cfd_api_insert on public.company_fiscal_deadlines
  for insert to ladino_api with check (true);
create policy cfd_api_delete on public.company_fiscal_deadlines
  for delete to ladino_api using (true);

-- ── 5. Adaptador TXT de retenciones PRACTICADAS ─────────────────────────────

insert into public.book_format_adapters
  (code, book_kind, name, description, is_official, legal_source)
values
  ('txt_retenciones_iva', 'retenciones_iva',
   'TXT de retenciones de IVA para la carga del agente de retención',
   'VALIDAR-SENIAT: layout según la guía pública del archivo TXT de '
   'retenciones (columnas: RIF agente, período, fecha y nº de factura, tipo '
   'de operación C, tipo de documento, RIF del proveedor, nº de documento, '
   'nº de control, monto total, base imponible, IVA retenido, documento '
   'afectado, nº de comprobante, exento, alícuota, expediente). NO validado '
   'aún contra una carga real del portal: probar con una declaración de '
   'prueba antes de usarlo en serio.',
   false,
   'Guía pública del SENIAT para la elaboración del archivo TXT de '
   'retenciones de IVA (formato de carga del portal). Pendiente de '
   'validación contra el portal — PENDIENTES_ASESOR.md.');

-- ── 6. Contabilidad: papel, cuenta, vocabulario y asientos ──────────────────

insert into public.account_purposes (code, name, description) values
  ('igtf_percibido_por_enterar', 'IGTF percibido por enterar',
   'El 3 % percibido a clientes en pagos en divisas (SPE agente de '
   'percepción): un pasivo con el fisco hasta enterarlo. No es ingreso. '
   'VALIDAR-CONTABLE.')
on conflict (code) do nothing;
insert into public.chart_template_accounts
  (template_code, code, name, parent_code, kind, nature, is_leaf, level, suggested_purpose)
select 've_basico', '2.1.91', 'IGTF percibido por enterar', '2.1', 'pasivo',
       'acreedora', true, 3, 'igtf_percibido_por_enterar'
 where not exists (select 1 from public.chart_template_accounts
                    where template_code = 've_basico' and code = '2.1.91');

-- El vocabulario gana 'igtf_perception' en las TRES casas (lista VIGENTE de
-- la migración 45 + lo nuevo — la trampa de la 37, otra vez respetada).
alter table public.journal_entries
  drop constraint journal_entries_source_kind_chk;
alter table public.journal_entries
  add constraint journal_entries_source_kind_chk
  check (source_kind in (
    'manual', 'sales_invoice', 'sales_credit_note', 'payment_received',
    'purchase_invoice', 'purchase_credit_note', 'payment_made', 'goods_receipt',
    'inventory_move', 'retention_receipt', 'landed_cost', 'landed_cost_variance',
    'exchange_diff', 'period_close', 'year_end_close', 'expense', 'cash_closing',
    'sales_receipt', 'sales_debit_note', 'igtf_perception'));
alter table public.journal_templates
  drop constraint journal_templates_source_kind_chk;
alter table public.journal_templates
  add constraint journal_templates_source_kind_chk
  check (source_kind in (
    'sales_invoice', 'sales_credit_note', 'payment_received', 'purchase_invoice',
    'purchase_credit_note', 'payment_made', 'goods_receipt', 'inventory_move',
    'retention_receipt', 'landed_cost', 'landed_cost_variance', 'exchange_diff',
    'expense', 'cash_closing', 'sales_receipt', 'sales_debit_note', 'igtf_perception'));
alter table public.journal_template_preset_entries
  drop constraint journal_template_preset_entries_kind_chk;
alter table public.journal_template_preset_entries
  add constraint journal_template_preset_entries_kind_chk
  check (source_kind in (
    'sales_invoice', 'sales_credit_note', 'payment_received', 'purchase_invoice',
    'purchase_credit_note', 'payment_made', 'goods_receipt', 'inventory_move',
    'retention_receipt', 'landed_cost', 'landed_cost_variance', 'exchange_diff',
    'expense', 'cash_closing', 'sales_receipt', 'sales_debit_note', 'igtf_perception'));

do $$
declare
  v_entry uuid;
begin
  -- Retención soportada APLICADA a la factura: baja CxC contra el anticipo
  -- de IVA a nuestro favor — estrena retention_iva_receivable (migración 28).
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'payment_received', 'ar.retention_applied',
          'Retención de IVA soportada aplicada: anticipo fiscal a favor contra cuentas por cobrar — no entra efectivo')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'retention_iva_receivable', 'functional_amount', 'debit', 'always',
     'El IVA que el agente retuvo por nosotros: anticipo contra el impuesto a pagar'),
    (v_entry, 2, 'ar_general', 'total', 'credit', 'always',
     'Lo que el cliente deja de deber por la retención practicada');

  -- La PERCEPCIÓN de IGTF: entra efectivo EXTRA (siempre divisas) contra el
  -- pasivo con el fisco. No es ingreso.
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'igtf_perception', 'igtf.perception_recorded',
          'IGTF percibido en un pago en divisas: efectivo extra contra el pasivo por enterar')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'cash_usd', 'functional_amount', 'debit', 'always',
     'El 3 % percibido entra en divisas, convertido a la tasa del cobro'),
    (v_entry, 2, 'igtf_percibido_por_enterar', 'functional_amount', 'credit', 'always',
     'Deuda con el fisco hasta enterarlo (declaración quincenal del agente)');
end $$;

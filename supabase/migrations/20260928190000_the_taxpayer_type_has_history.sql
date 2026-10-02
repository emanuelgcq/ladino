-- =============================================================================
-- El tipo de contribuyente tiene historia, y la retención que nos practican
-- abona a la tasa de la factura (ADR-0072 §1 y §5; A-03, B-07, F-11).
-- Módulo: fiscal / ventas   Spec: docs/02_COMPLIANCE/RETENTIONS_SPEC.md, IGTF_SPEC.md
--
-- Qué pasaba:
--   · `companies.taxpayer_type_code` era una columna que se SOBRESCRIBÍA
--     (`packages/domain/src/igtf.ts`, setCompanyTaxpayerType): «especial» regía
--     desde que se guardaba, sin fecha de notificación ni vigencia, y una operación
--     fechada antes del cambio se leía con el tipo nuevo (B-07);
--   · el alta con RIF no preguntaba el tipo y nada impedía facturar sin él (A-03);
--   · el comprobante de retención soportada, cargado en Bs contra una factura en
--     divisa, abonaba a la tasa DEL DÍA y generaba diferencial (F-01) — el dueño
--     decidió (§2.6) que abona a la tasa DE LA FACTURA: es una fracción fija de su IVA;
--   · lo cargaba cualquiera con `sales.payment.register` (F-11).
--
-- Qué hace:
--   1. `company_taxpayer_types`: historia APPEND-ONLY del tipo por empresa, con la
--      fecha desde la que rige, la de notificación de la providencia (obligatoria
--      para `especial`), el acta, el autor y la versión de reglas. SIN DEFAULT de tipo.
--   2. `platform.taxpayer_type_at(empresa, fecha)`: la ÚNICA lectura del tipo. Una
--      empresa sin RIF (marcador `PEND-`) sin historia es `no_contribuyente`: es un
--      HECHO (no está inscrita), no una omisión. Con RIF y sin historia: NULL, y no se
--      factura (el dominio lo dice con TAXPAYER_TYPE_REQUIRED).
--   3. `no_contribuyente` entra al catálogo `taxpayer_types` como INACTIVO: existe
--      para la empresa y para la FK de la columna espejo, pero no se ofrece en los
--      selectores de clientes y proveedores (que listan los activos).
--   4. La columna `companies.taxpayer_type_code` se QUEDA (migración expand: la API
--      desplegada la lee y la escribe), pero deja de ser la verdad: un trigger desde
--      la historia la sincroniza con el tipo vigente hoy. NO se rellena la historia
--      con lo que la columna tenga hoy: el dueño decidió «sin transición» (2026-09-28;
--      en producción no hay clientes reales).
--   5. Permisos `ar.retention.register` (quien cobra) y `ar.retention.correct`
--      (contador y dueño), concedidos a los roles de sistema.
--   6. Retención soportada: número de 14 dígitos (CHECK NOT VALID: no juzga filas
--      viejas), `ar_valuation` por comprobante (`invoice_rate` | `voucher_rate`) y el
--      parámetro por empresa `retention_received_voucher_rate` (apagado, P-30).
--   7. `platform.document_balance_transaction`: un abono por retención valorado
--      `invoice_rate` salda la divisa a la tasa DE LA FACTURA. Parte de la definición
--      VIVA (20260912120400_rules_and_rates_belong_to_the_company.sql).
--
-- Reversible: SÍ, con datos vivos, así:
--   · la tabla de historia, la función y el trigger espejo se retiran con `drop`; la
--     columna `companies.taxpayer_type_code` conserva el último valor sincronizado,
--     que es lo que la API anterior leía. Lo que se PIERDE al revertir es la historia
--     (las fechas de notificación y las vigencias), que conviene exportar antes;
--   · `ar_valuation` y el parámetro se retiran con `drop column`; OJO: tras revertir,
--     `document_balance_transaction` vuelve a valorar TODOS los abonos por retención a
--     la tasa del día, y los comprobantes cargados con `invoice_rate` cambiarían el
--     saldo en divisa de su factura. Revertir exige antes decidir qué hacer con ellos;
--   · el CHECK de 14 dígitos se retira con `drop constraint`;
--   · los permisos: `delete from role_permissions` / `permissions` de las dos claves;
--   · la fila `no_contribuyente` de `taxpayer_types` no se puede borrar si alguna
--     empresa la usa (FK): se deja inactiva.
-- HOMOLOGATION_IMPACT: NO — no toca numeración, control ni el formato del documento.
-- Sí cambia comportamiento fiscal (bloquea la emisión sin tipo declarado): va con
-- ADR-0072 y sus VALIDAR-* en PENDIENTES_ASESOR.
-- =============================================================================

-- ── 1. El vocabulario: `no_contribuyente`, inactivo ─────────────────────────
insert into public.taxpayer_types (code, name, description, status) values
  ('no_contribuyente', 'No contribuyente',
   'La PROPIA empresa sin inscripción en el IVA (sin RIF, emite recibos; ADR-0072 §1, D-01). '
   'Inactivo: no se ofrece como clasificación de clientes ni proveedores.', 'inactive')
on conflict (code) do nothing;

-- ── 2. La historia ──────────────────────────────────────────────────────────
create table public.company_taxpayer_types (
  id                 uuid        primary key default platform.uuidv7(),
  tenant_id          uuid        not null,
  company_id         uuid        not null,
  -- SIN DEFAULT, a propósito: «ordinario por omisión» es inventar un régimen que
  -- nadie declaró (la misma regla que la columna de la migración de compras).
  taxpayer_type_code text        not null,
  -- Desde qué día rige (fecha, no instante: la vigencia es por día de Caracas).
  effective_from     date        not null,
  -- Solo para `especial`: el día en que el SENIAT notificó la providencia de
  -- calificación. Por omisión rige desde ese día; si la providencia dice otra
  -- fecha, `effective_from` la recoge y el acta lo explica.
  notified_on        date,
  -- El acta: por qué se declara o se cambia. Obligatoria.
  reason             text        not null,
  rules_version      text        not null,
  actor_id           uuid,

  created_by         uuid,
  created_at         timestamptz not null,
  version            integer     not null,

  constraint company_taxpayer_types_tenant_fk foreign key (tenant_id)
    references public.tenants (id),
  constraint company_taxpayer_types_company_fk foreign key (tenant_id, company_id)
    references public.companies (tenant_id, id),
  constraint company_taxpayer_types_type_fk foreign key (taxpayer_type_code)
    references public.taxpayer_types (code),
  -- Los cuatro tipos de LA EMPRESA (ADR-0072 §1). `no_sujeto` y `no_domiciliado`
  -- son clasificaciones de contrapartes, no de quien factura.
  constraint company_taxpayer_types_type_chk check (
    taxpayer_type_code in ('ordinario', 'especial', 'formal', 'no_contribuyente')),
  constraint company_taxpayer_types_notified_chk check (
    (taxpayer_type_code = 'especial') = (notified_on is not null)),
  constraint company_taxpayer_types_reason_chk check (
    reason = btrim(reason) and length(reason) between 3 and 500),
  constraint company_taxpayer_types_rules_chk check (length(btrim(rules_version)) > 0),
  constraint company_taxpayer_types_company_id_key unique (company_id, id)
);
create index company_taxpayer_types_lookup_idx
  on public.company_taxpayer_types (company_id, effective_from desc, created_at desc);
comment on table public.company_taxpayer_types is
  'Historia APPEND-ONLY del tipo de contribuyente de cada empresa (ADR-0072 §1). La única '
  'lectura es platform.taxpayer_type_at(empresa, fecha). companies.taxpayer_type_code es '
  'un espejo por trigger para la API desplegada, no la verdad.';

create trigger company_taxpayer_types_00_provenance
  before insert or update on public.company_taxpayer_types
  for each row execute function platform.set_row_provenance();
-- El ancla aunque la tabla sea append-only: lo pide el test 006, sin excepciones.
create trigger company_taxpayer_types_01_anchors
  before update on public.company_taxpayer_types
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger company_taxpayer_types_append_only
  before update or delete on public.company_taxpayer_types
  for each row execute function platform.reject_mutation();
create trigger company_taxpayer_types_no_truncate
  before truncate on public.company_taxpayer_types
  for each statement execute function platform.reject_mutation();

alter table public.company_taxpayer_types enable row level security;
alter table public.company_taxpayer_types force  row level security;
create policy company_taxpayer_types_select on public.company_taxpayer_types for select
  to authenticated using (company_id in (select platform.ladino_company_ids()));
create policy company_taxpayer_types_insert on public.company_taxpayer_types for insert
  to authenticated with check (false);
create policy company_taxpayer_types_update on public.company_taxpayer_types for update
  to authenticated using (false);
create policy company_taxpayer_types_delete on public.company_taxpayer_types for delete
  to authenticated using (false);
create policy company_taxpayer_types_api_select on public.company_taxpayer_types for select
  to ladino_api using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy company_taxpayer_types_api_insert on public.company_taxpayer_types for insert
  to ladino_api with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy company_taxpayer_types_api_update on public.company_taxpayer_types for update
  to ladino_api using (false);
create policy company_taxpayer_types_api_delete on public.company_taxpayer_types for delete
  to ladino_api using (false);
revoke all on public.company_taxpayer_types from anon, authenticated, service_role, ladino_api,
  ladino_worker;
grant select on public.company_taxpayer_types to authenticated;
grant select, insert on public.company_taxpayer_types to ladino_api;

-- ── 3. La única lectura ─────────────────────────────────────────────────────
-- Granularidad declarada (CLAUDE.md §3): compara dos `date`. Quien llama pasa el
-- DÍA de la operación (día de Caracas del documento), nunca un instante.
create function platform.taxpayer_type_at(p_company uuid, p_on date)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select h.taxpayer_type_code
       from public.company_taxpayer_types h
      where h.company_id = p_company and h.effective_from <= p_on
      order by h.effective_from desc, h.created_at desc, h.id desc
      limit 1),
    -- Sin RIF no hay inscripción: es un hecho, no una omisión (ADR-0072 §1, D-01).
    (select 'no_contribuyente'::text from public.companies c
      where c.id = p_company and upper(btrim(c.tax_id)) like 'PEND-%'));
$$;
comment on function platform.taxpayer_type_at(uuid, date) is
  'Tipo de contribuyente de la empresa vigente en ese día (ADR-0072 §1). NULL = con RIF y sin '
  'declarar: no se factura. Nunca «ordinario por omisión».';
revoke execute on function platform.taxpayer_type_at(uuid, date) from public;
grant execute on function platform.taxpayer_type_at(uuid, date) to authenticated, ladino_api;

-- ── 4. La columna espejo, desde la historia ─────────────────────────────────
create function platform.sync_company_taxpayer_type_mirror()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.companies
     set taxpayer_type_code = platform.taxpayer_type_at(new.company_id,
                                                         platform.caracas_day(now()))
   where id = new.company_id;
  return null;
end;
$$;
comment on function platform.sync_company_taxpayer_type_mirror() is
  'Espejo de compatibilidad (migración expand): companies.taxpayer_type_code = el tipo vigente '
  'HOY según la historia. Una vigencia futura no cambia el espejo hasta otra declaración; nada '
  'del código nuevo lee la columna.';
revoke execute on function platform.sync_company_taxpayer_type_mirror() from public;
create trigger company_taxpayer_types_10_mirror
  after insert on public.company_taxpayer_types
  for each row execute function platform.sync_company_taxpayer_type_mirror();

-- ── 5. Permisos de la retención que nos practican (F-11) ────────────────────
insert into public.permissions (key, description, is_scoped) values
  ('ar.retention.register',
   'Cargar el comprobante de retención de IVA que un cliente nos entregó (quien cobra)', false),
  ('ar.retention.correct',
   'Corregir o reversar un comprobante de retención soportada (contador)', false)
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key, tenant_id)
select r.id, v.permiso, null
  from (values ('owner', 'ar.retention.register'), ('back_office', 'ar.retention.register'),
               ('store_manager', 'ar.retention.register'), ('cashier', 'ar.retention.register'),
               ('owner', 'ar.retention.correct'), ('accountant', 'ar.retention.correct'))
         as v(rol, permiso)
  join public.roles r on r.key = v.rol and r.tenant_id is null
on conflict (role_id, permission_key) do nothing;

do $$
begin
  if (select count(*) from public.role_permissions rp
        join public.roles r on r.id = rp.role_id and r.tenant_id is null
       where rp.permission_key in ('ar.retention.register', 'ar.retention.correct')
         and r.key in ('owner', 'back_office', 'store_manager', 'cashier', 'accountant')) <> 6 then
    raise exception 'LAD37: los permisos de retención soportada no quedaron en los seis pares';
  end if;
end $$;

-- ── 6. La retención soportada: 14 dígitos y la tasa con la que abona ────────
-- NOT VALID: juzga toda fila NUEVA sin reinterpretar las ya cargadas.
alter table public.supported_retention_receipts
  add constraint srr_receipt_14_digits_chk check (receipt_number ~ '^[0-9]{14}$') not valid;

-- Con qué tasa abona la CxC de una factura en divisa. Las filas ya cargadas se
-- valoraron a la tasa del día (lo que el código hacía): por eso la omisión de la
-- COLUMNA es `voucher_rate` — describe el pasado. El código nuevo la escribe
-- SIEMPRE explícita desde el parámetro de la empresa.
alter table public.supported_retention_receipts
  add column ar_valuation text not null default 'voucher_rate';
alter table public.supported_retention_receipts
  add constraint srr_ar_valuation_chk check (ar_valuation in ('invoice_rate', 'voucher_rate'));
comment on column public.supported_retention_receipts.ar_valuation is
  'invoice_rate: abona la divisa de la factura a SU tasa, sin diferencial (ADR-0072 §5, criterio '
  'del dueño). voucher_rate: a la tasa del día del comprobante (la alternativa, P-30).';

-- El parámetro por empresa (P-30, VALIDAR-TRIBUTARIO): apagado por omisión.
alter table public.company_settings
  add column retention_received_voucher_rate boolean not null default false;
comment on column public.company_settings.retention_received_voucher_rate is
  'P-30: si el asesor prefiere que la retención soportada abone a la tasa del día del '
  'comprobante. Apagado: abona a la tasa de la factura (ADR-0072 §5).';

-- ── 7. El saldo en divisa, con la retención a la tasa de la factura ─────────
-- Definición VIVA: 20260912120400_rules_and_rates_belong_to_the_company.sql. Único
-- cambio: la rama del abono por retención `invoice_rate`.
create or replace function platform.document_balance_transaction(p_company uuid, p_document uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_doc record;
  v_paid numeric := 0;
  v_p record;
  v_rate numeric;
begin
  select d.id, d.transaction_currency, d.functional_currency,
         d.amount_transaction_currency, d.fx_rate
    into v_doc
    from public.documents d
   where d.id = p_document and d.company_id = p_company
     and d.status in ('issued', 'paid');
  if not found then return null; end if;

  for v_p in
    select p.currency, p.amount, p.functional_amount,
           platform.caracas_day(p.paid_at) as paid_on,
           r.ar_valuation
      from public.payments p
      left join public.supported_retention_receipts r
        on r.company_id = p.company_id and r.id = p.supported_retention_id
     where p.document_id = v_doc.id
  loop
    if v_p.currency = v_doc.transaction_currency then
      v_paid := v_paid + v_p.amount;
    elsif v_p.ar_valuation = 'invoice_rate' then
      -- ADR-0072 §5: la retención es una fracción fija del IVA DE LA FACTURA; salda
      -- la divisa a la tasa con que se emitió, sin diferencial.
      v_paid := v_paid + round(v_p.functional_amount / v_doc.fx_rate, 8);
    else
      v_rate := platform.rate_at(p_company, v_doc.transaction_currency,
                                 v_doc.functional_currency, v_p.paid_on);
      if v_rate is null then
        raise exception
          'no hay tasa % → % vigente al % para valorar un cobro: cárgala con su fuente',
          v_doc.transaction_currency, v_doc.functional_currency, v_p.paid_on
          using errcode = 'LAD51';
      end if;
      v_paid := v_paid + round(v_p.functional_amount / v_rate, 8);
    end if;
  end loop;

  return v_doc.amount_transaction_currency - v_paid;
end;
$$;

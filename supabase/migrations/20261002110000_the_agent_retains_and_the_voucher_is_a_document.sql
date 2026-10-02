-- =============================================================================
-- Ladino — EL AGENTE RETIENE SOLO Y EL COMPROBANTE ES UN DOCUMENTO
-- (ADR-0072 §3, §4 y §6; enmienda ADR-0039 y ADR-0065 §3)
-- Hallazgos del recorrido 2026-09-24: H-01, H-04, H-12 y L-03.
--
-- Módulo: compras · retenciones · libros fiscales. Rigor máximo (fiscal, con datos vivos).
-- Spec:   docs/02_COMPLIANCE/RETENTIONS_SPEC.md · PENDIENTES_ASESOR P-7 y P-26.
-- Norma:  PA SNAT/2025/000054 (G.O. 43.171, 16-07-2025; rige desde el 01-08-2025), arts. 3, 4, 5,
--         13 y 16 (REGULATORY_STATUS.md, fila de la 000054, reproducción verificada 2026-09-25/28).
-- Reversible: SÍ, con datos vivos — ver al final.
-- HOMOLOGATION_IMPACT: YES — cambia cuándo se practica la retención de IVA (sola, al registrar),
--   el documento que la soporta, el libro de compras (columnas del comprobante) y el TXT.
--
-- Qué cambia:
--   1. `retention_concepts` gana `iva_compras_total` (el 100 % del art. 5). Vocabulario, SIN
--      porcentaje: el 75 % y el 100 % siguen siendo filas de `retention_rules` con su fuente
--      (ADR-0039 §2). Sin regla vigente, la factura se detiene con LAD53.
--   2. `retention_exclusions`: catálogo de PLATAFORMA con las exclusiones del art. 3 que
--      REGULATORY_STATUS.md cita con fuente. Solo los numerales 2 y 8 están verificados; el resto
--      se siembra con «numeral pendiente de fuente» y la 13.ª no se siembra (no tiene fuente).
--   3. `supplier_invoices` gana la exclusión marcada (código + motivo) y el motivo del 100 %
--      (art. 5). Columnas nulas, sin relleno: las facturas existentes no cambian.
--   4. `purchase_settings.retention_voucher_mode`: uno por operación (omisión) o uno por quincena
--      y proveedor (art. 16).
--   5. `retention_vouchers` + `retention_voucher_lines`: el comprobante como documento. Número
--      `AAAAMM` + secuencial de 8 por empresa (art. 16), identidad del agente y del proveedor
--      CONGELADA al emitir, fecha de emisión, vencimiento de entrega y entrega. Append-only: la
--      entrega se anota UNA vez; corregir emite una versión nueva que reemplaza a la anterior
--      (la anulada es la reemplazada: no hay UPDATE de estado).
--   6. `platform.iva_retention_book` se REDEFINE (drop + create, cambia el tipo de retorno): lee
--      del comprobante (identidad congelada, importes del documento, número de 14 dígitos) y
--      conserva, aparte, las retenciones anteriores sin comprobante. Definición viva anterior:
--      20260912120000 (ninguna migración posterior la tocó).
--   7. `platform.purchases_book_with_vouchers`: el renglón de `purchases_book_by_rate` (viva:
--      20260928170400 §2, NO se toca) más el número, la fecha y el IVA retenido del comprobante
--      emitido en el período (H-12). Un comprobante emitido en un período distinto del de su
--      factura sale en el de su emisión, como renglón propio con importes en cero.
--   Ni `purchases_book`, ni `purchases_book_by_rate`, ni `purchases_book_summary`, ni
--   `recompute_iva_period` se redefinen.
-- =============================================================================

-- ── 1. El 100 % del art. 5, como concepto (sin porcentaje) ───────────────────
insert into public.retention_concepts (code, retention_code, name, description) values
  ('iva_compras_total', 'iva', 'Retención de IVA del 100 % (art. 5)',
   'Retención del IVA entero: IVA no discriminado, factura sin requisitos, indicación del portal o proveedor no inscrito en el RIF (PA SNAT/2025/000054 art. 5). El porcentaje vive en retention_rules con su fuente, no aquí.')
on conflict (code) do nothing;

-- ── 2. Las exclusiones del art. 3, como data de plataforma ───────────────────
create table public.retention_exclusions (
  code              text        primary key,
  legal_norm        text        not null,
  legal_article     text        not null,
  gazette           text        not null,
  -- Si el NUMERAL está verificado en la fuente. Solo el 2 y el 8 (REGULATORY_STATUS.md).
  numeral_verified  boolean     not null,
  -- `automatic`: el servidor la aplica sin que nadie la marque (proveedor formal, factura sin
  -- IVA). `marked`: la marca la persona con su motivo, que queda auditado.
  applies           text        not null,
  description       text        not null,
  effective_from    date        not null,
  effective_to      date,
  created_at        timestamptz not null default now(),
  constraint retention_exclusions_code_chk check (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint retention_exclusions_applies_chk check (applies in ('automatic', 'marked')),
  constraint retention_exclusions_period_chk
    check (effective_to is null or effective_to > effective_from),
  constraint retention_exclusions_source_chk
    check (length(btrim(legal_norm)) >= 3 and length(btrim(legal_article)) >= 3)
);
comment on table public.retention_exclusions is
  'Catálogo de PLATAFORMA (sin tenant): exclusiones de la retención de IVA (PA SNAT/2025/000054 '
  'art. 3) con norma, artículo y vigencia. Lo que no tiene fuente no se siembra (la 13.ª). '
  'numeral_verified = false dice que el numeral exacto está pendiente de fuente.';

alter table public.retention_exclusions enable row level security;
alter table public.retention_exclusions force  row level security;
create policy retention_exclusions_select on public.retention_exclusions for select
  to authenticated, ladino_api using (true);
create policy retention_exclusions_insert on public.retention_exclusions for insert
  to authenticated, ladino_api with check (false);
create policy retention_exclusions_update on public.retention_exclusions for update
  to authenticated, ladino_api using (false);
create policy retention_exclusions_delete on public.retention_exclusions for delete
  to authenticated, ladino_api using (false);
revoke all on public.retention_exclusions from anon, authenticated, service_role, ladino_api,
  ladino_worker;
grant select on public.retention_exclusions to authenticated, ladino_api;

-- Fuente: REGULATORY_STATUS.md, fila «PA SNAT/2025/000054» (ivecofi, 2026-09-25/28, verificado
-- por reproducción). «Numeral exacto de cada una salvo 2 y 8, y la 13.ª exclusión: pendiente de
-- fuente.»
insert into public.retention_exclusions
  (code, legal_norm, legal_article, gazette, numeral_verified, applies, description,
   effective_from)
values
  ('exentas_exoneradas_no_sujetas', 'PA SNAT/2025/000054', 'art. 3 (numeral pendiente de fuente)',
   'G.O. 43.171, 16-07-2025', false, 'automatic',
   'Operaciones exentas, exoneradas o no sujetas: sin IVA no hay qué retener.', '2025-08-01'),
  ('proveedor_formal', 'PA SNAT/2025/000054', 'art. 3 num. 2', 'G.O. 43.171, 16-07-2025', true,
   'automatic', 'El proveedor es contribuyente formal.', '2025-08-01'),
  ('percepcion_previa', 'PA SNAT/2025/000054', 'art. 3 (numeral pendiente de fuente)',
   'G.O. 43.171, 16-07-2025', false, 'marked',
   'El IVA ya fue objeto de percepción (licores y similares).', '2025-08-01'),
  ('retencion_previa_importacion', 'PA SNAT/2025/000054', 'art. 3 (numeral pendiente de fuente)',
   'G.O. 43.171, 16-07-2025', false, 'marked',
   'Retención ya practicada en la importación.', '2025-08-01'),
  ('viaticos', 'PA SNAT/2025/000054', 'art. 3 (numeral pendiente de fuente)',
   'G.O. 43.171, 16-07-2025', false, 'marked', 'Viáticos.', '2025-08-01'),
  ('gastos_reembolsables_20ut', 'PA SNAT/2025/000054', 'art. 3 (numeral pendiente de fuente)',
   'G.O. 43.171, 16-07-2025', false, 'marked', 'Gastos reembolsables de hasta 20 UT.',
   '2025-08-01'),
  ('caja_chica_20ut', 'PA SNAT/2025/000054', 'art. 3 (numeral pendiente de fuente)',
   'G.O. 43.171, 16-07-2025', false, 'marked', 'Compras con caja chica de hasta 20 UT.',
   '2025-08-01'),
  ('servicio_publico_domiciliado', 'PA SNAT/2025/000054', 'art. 3 num. 8',
   'G.O. 43.171, 16-07-2025', true, 'marked', 'Servicios públicos domiciliados.', '2025-08-01'),
  ('exportador_recuperacion', 'PA SNAT/2025/000054', 'art. 3 (numeral pendiente de fuente)',
   'G.O. 43.171, 16-07-2025', false, 'marked',
   'Proveedor exportador con solicitud de recuperación.', '2025-08-01'),
  ('proveedor_mayoria_exenta', 'PA SNAT/2025/000054', 'art. 3 (numeral pendiente de fuente)',
   'G.O. 43.171, 16-07-2025', false, 'marked',
   'Proveedor con más del 50 % de operaciones exentas.', '2025-08-01'),
  ('ente_publico', 'PA SNAT/2025/000054', 'art. 3 (numeral pendiente de fuente)',
   'G.O. 43.171, 16-07-2025', false, 'marked', 'Entes públicos.', '2025-08-01'),
  ('art_146_cot', 'PA SNAT/2025/000054', 'art. 3 (numeral pendiente de fuente)',
   'G.O. 43.171, 16-07-2025', false, 'marked', 'Supuesto del art. 146 del COT.', '2025-08-01');

-- ── 3. La factura: exclusión marcada y motivo del 100 % ──────────────────────
alter table public.supplier_invoices
  add column retention_exclusion_code   text,
  add column retention_exclusion_reason text,
  add column iva_retention_full_reason  text;
alter table public.supplier_invoices
  add constraint supplier_invoices_retention_exclusion_fk
    foreign key (retention_exclusion_code) references public.retention_exclusions (code),
  -- Código y motivo van juntos: una exclusión sin por qué no es auditable.
  add constraint supplier_invoices_retention_exclusion_chk
    check ((retention_exclusion_code is null) = (retention_exclusion_reason is null)
           and (retention_exclusion_reason is null
                or (retention_exclusion_reason = btrim(retention_exclusion_reason)
                    and length(retention_exclusion_reason) between 10 and 500))),
  -- Los cuatro supuestos del art. 5 (REGULATORY_STATUS.md).
  add constraint supplier_invoices_iva_full_reason_chk
    check (iva_retention_full_reason is null
           or iva_retention_full_reason in ('iva_no_discriminado', 'factura_sin_requisitos',
                                            'indicado_por_portal', 'proveedor_sin_rif')),
  -- Excluida y retenida al 100 % a la vez es una contradicción.
  add constraint supplier_invoices_exclusion_or_full_chk
    check (retention_exclusion_code is null or iva_retention_full_reason is null);
comment on column public.supplier_invoices.retention_exclusion_code is
  'Exclusión del art. 3 de la PA SNAT/2025/000054 marcada por la persona (ADR-0072 §3). Con ella '
  'la factura de un agente no retiene IVA; el motivo va en retention_exclusion_reason y en el '
  'evento de auditoría ap.retention_excluded.';

-- ── 4. Uno por operación o uno por quincena y proveedor ─────────────────────
alter table public.purchase_settings
  add column retention_voucher_mode text not null default 'per_operation';
alter table public.purchase_settings
  add constraint purchase_settings_voucher_mode_chk
    check (retention_voucher_mode in ('per_operation', 'per_fortnight'));
comment on column public.purchase_settings.retention_voucher_mode is
  'PA SNAT/2025/000054 art. 16: un comprobante por operación (omisión) o uno por quincena y '
  'proveedor (ADR-0072 §4).';

-- ── 5. La quincena y el vencimiento de la entrega ───────────────────────────
-- Granularidad declarada (CLAUDE.md §3): todo es `date`; quien llama pasa el DÍA de Caracas.
create function platform.retention_fortnight(p_day date,
                                             out fortnight_start date, out fortnight_end date)
language sql
immutable
set search_path = ''
as $$
  select make_date(extract(year from p_day)::int, extract(month from p_day)::int,
                   case when extract(day from p_day) <= 15 then 1 else 16 end),
         case when extract(day from p_day) <= 15
              then make_date(extract(year from p_day)::int, extract(month from p_day)::int, 15)
              else (make_date(extract(year from p_day)::int, extract(month from p_day)::int, 1)
                    + interval '1 month')::date - 1
         end
$$;
comment on function platform.retention_fortnight(date) is
  'La quincena (1-15 o 16-último) de un día de Caracas. Comprobantes de retención (ADR-0072 §4).';

-- El comprobante se entrega dentro de los 2 días hábiles siguientes a la quincena (art. 16).
-- VALIDAR-TRIBUTARIO (P-26): los feriados nacionales no están en el repositorio; aquí cuenta
-- solo de lunes a viernes. Un feriado dentro de la ventana adelanta el vencimiento un día: el
-- error, si lo hay, avisa ANTES, nunca después.
create function platform.retention_voucher_due_on(p_fortnight_end date)
returns date
language sql
immutable
set search_path = ''
as $$
  select p_fortnight_end + i
    from generate_series(1, 10) as i
   where extract(isodow from p_fortnight_end + i) < 6
   order by i
  offset 1 limit 1
$$;
comment on function platform.retention_voucher_due_on(date) is
  'Vence la entrega del comprobante: el 2.º día hábil (lunes a viernes, sin feriados — '
  'VALIDAR-TRIBUTARIO P-26) después del fin de la quincena. PA SNAT/2025/000054 art. 16.';

revoke execute on function platform.retention_fortnight(date) from public;
revoke execute on function platform.retention_voucher_due_on(date) from public;
grant execute on function platform.retention_fortnight(date) to authenticated, ladino_api;
grant execute on function platform.retention_voucher_due_on(date) to authenticated, ladino_api;

-- ── 6. El comprobante ───────────────────────────────────────────────────────
create table public.retention_vouchers (
  id                  uuid        primary key default platform.uuidv7(),
  tenant_id           uuid        not null,
  company_id          uuid        not null,
  supplier_id         uuid        not null,
  -- Art. 16: AAAAMM de la EMISIÓN + secuencial de 8 dígitos por empresa. El secuencial no se
  -- reinicia por mes: es uno por empresa (respuesta del dueño §2.6).
  voucher_period      text        not null,
  sequence            bigint      not null,
  voucher_number      text        generated always as
                        (voucher_period || lpad(sequence::text, 8, '0')) stored,
  mode                text        not null,
  issued_on           date        not null,
  fortnight_start     date        not null,
  fortnight_end       date        not null,
  delivery_due_on     date        not null,
  -- Lo ÚNICO que se escribe después de emitir, y una sola vez (trigger `_02_guard`).
  delivered_on        date,
  delivered_by        uuid,
  -- Identidad CONGELADA al emitir (4-bis): el libro y el TXT leen de aquí, no del maestro.
  agent_tax_id        text        not null,
  agent_name          text        not null,
  agent_address       text,
  supplier_tax_id     text        not null,
  supplier_name       text        not null,
  supplier_address    text,
  -- Versiones: corregir emite otra que REEMPLAZA a esta. La reemplazada es la anulada.
  version_no          integer     not null default 1,
  replaces_voucher_id uuid,
  correction_reason   text,
  functional_currency text        not null,
  rules_version       text        not null,

  created_by          uuid,
  created_at          timestamptz not null,
  version             integer     not null,

  constraint retention_vouchers_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint retention_vouchers_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint retention_vouchers_supplier_fk
    foreign key (company_id, supplier_id) references public.suppliers (company_id, id),
  constraint retention_vouchers_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint retention_vouchers_replaces_fk
    foreign key (company_id, replaces_voucher_id)
    references public.retention_vouchers (company_id, id),
  constraint retention_vouchers_period_chk check (voucher_period ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
  -- El período del número ES el mes de la emisión.
  constraint retention_vouchers_period_issued_chk
    check (voucher_period = to_char(issued_on, 'YYYYMM')),
  constraint retention_vouchers_sequence_chk check (sequence between 1 and 99999999),
  constraint retention_vouchers_mode_chk check (mode in ('per_operation', 'per_fortnight')),
  constraint retention_vouchers_fortnight_chk
    check (issued_on between fortnight_start and fortnight_end
           and delivery_due_on > fortnight_end),
  constraint retention_vouchers_delivered_chk
    check ((delivered_on is null) = (delivered_by is null)
           and (delivered_on is null or delivered_on >= issued_on)),
  constraint retention_vouchers_identity_chk
    check (length(btrim(agent_tax_id)) > 0 and length(btrim(agent_name)) > 0
           and length(btrim(supplier_tax_id)) > 0 and length(btrim(supplier_name)) > 0),
  constraint retention_vouchers_version_chk
    check (version_no >= 1
           and (version_no = 1) = (replaces_voucher_id is null)
           and (replaces_voucher_id is null) = (correction_reason is null)
           and (correction_reason is null
                or (correction_reason = btrim(correction_reason)
                    and length(correction_reason) between 10 and 500))),
  -- La clave NATURAL del número: dos operadores a la vez no comparten secuencial.
  constraint retention_vouchers_sequence_key unique (company_id, sequence),
  -- Una versión se reemplaza UNA vez: dos correcciones de la misma dejarían dos vigentes.
  constraint retention_vouchers_replaces_key unique (replaces_voucher_id),
  constraint retention_vouchers_company_id_key unique (company_id, id)
);
create index retention_vouchers_issued_idx on public.retention_vouchers (company_id, issued_on);
create index retention_vouchers_open_fortnight_idx
  on public.retention_vouchers (company_id, supplier_id, fortnight_start)
  where mode = 'per_fortnight' and delivered_on is null;
comment on table public.retention_vouchers is
  'Comprobante de retención de IVA como DOCUMENTO (ADR-0072 §4; PA SNAT/2025/000054 art. 16). '
  'Número AAAAMM + 8 por empresa; identidad del agente y del proveedor congelada al emitir. '
  'Append-only salvo la entrega, que se anota una vez. Corregir = versión nueva que reemplaza; '
  'una versión está ANULADA si otra la reemplaza.';

create table public.retention_voucher_lines (
  id                    uuid          primary key default platform.uuidv7(),
  tenant_id             uuid          not null,
  company_id            uuid          not null,
  retention_voucher_id  uuid          not null,
  supplier_invoice_id   uuid          not null,
  supplier_retention_id uuid          not null,
  -- Tipo del instructivo del TXT (P-7): 01 factura, 02 ND, 03 NC.
  document_type         text          not null,
  document_number       text,
  control_number        text,
  document_date         date          not null,
  -- Documento afectado (ND/NC); nulo en la factura.
  affected_document     text,
  -- Importes del documento, en moneda funcional, CONGELADOS al emitir.
  total_amount          numeric(24,8) not null,
  taxable_base          numeric(24,8) not null,
  exempt_amount         numeric(24,8) not null,
  iva_amount            numeric(24,8) not null,
  -- Alícuota en porcentaje (16, 8, 31). Nula si el documento mezcla alícuotas (VALIDAR-SENIAT P-7).
  tax_rate              numeric(24,8),
  portion               numeric(24,8) not null,
  retained_amount       numeric(24,8) not null,

  created_by            uuid,
  created_at            timestamptz   not null,
  version               integer       not null,

  constraint retention_voucher_lines_tenant_fk foreign key (tenant_id)
    references public.tenants (id),
  constraint retention_voucher_lines_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint retention_voucher_lines_voucher_fk
    foreign key (company_id, retention_voucher_id)
    references public.retention_vouchers (company_id, id),
  constraint retention_voucher_lines_invoice_fk
    foreign key (company_id, supplier_invoice_id)
    references public.supplier_invoices (company_id, id),
  constraint retention_voucher_lines_retention_fk
    foreign key (company_id, supplier_retention_id)
    references public.supplier_retentions (company_id, id),
  constraint retention_voucher_lines_type_chk check (document_type in ('01', '02', '03')),
  constraint retention_voucher_lines_amounts_chk
    check (total_amount >= 0 and taxable_base >= 0 and exempt_amount >= 0 and iva_amount >= 0
           and retained_amount >= 0 and retained_amount <= iva_amount),
  constraint retention_voucher_lines_portion_chk check (portion > 0 and portion <= 1),
  constraint retention_voucher_lines_rate_chk check (tax_rate is null or tax_rate >= 0),
  -- Una retención, una vez por versión del comprobante.
  constraint retention_voucher_lines_once_key unique (retention_voucher_id, supplier_retention_id)
);
create index retention_voucher_lines_invoice_idx
  on public.retention_voucher_lines (supplier_invoice_id);
create index retention_voucher_lines_retention_idx
  on public.retention_voucher_lines (supplier_retention_id);
comment on table public.retention_voucher_lines is
  'Renglones del comprobante de retención: documento con número y control, total, base, exento, '
  'IVA causado e IVA retenido, congelados al emitir (art. 16). APPEND-ONLY.';

-- La entrega se anota una vez; cualquier otro cambio se rechaza. Borrar, nunca.
create function platform.retention_vouchers_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'un comprobante de retención no se borra: se corrige con una versión nueva (ADR-0072 §4)'
      using errcode = 'LAD06';
  end if;
  if old.delivered_on is null and new.delivered_on is not null
     and (to_jsonb(old) - 'delivered_on' - 'delivered_by' - 'version')
       = (to_jsonb(new) - 'delivered_on' - 'delivered_by' - 'version') then
    return new;
  end if;
  raise exception 'un comprobante de retención emitido no se edita: solo se anota su entrega, una vez; corregirlo emite una versión nueva (ADR-0072 §4)'
    using errcode = 'LAD06';
end;
$$;
revoke execute on function platform.retention_vouchers_guard() from public;

create trigger retention_vouchers_00_provenance
  before insert or update on public.retention_vouchers
  for each row execute function platform.set_row_provenance();
create trigger retention_vouchers_01_anchors
  before update on public.retention_vouchers
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger retention_vouchers_02_guard
  before update or delete on public.retention_vouchers
  for each row execute function platform.retention_vouchers_guard();
create trigger retention_vouchers_no_truncate
  before truncate on public.retention_vouchers
  for each statement execute function platform.reject_mutation();

create trigger retention_voucher_lines_00_provenance
  before insert or update on public.retention_voucher_lines
  for each row execute function platform.set_row_provenance();
create trigger retention_voucher_lines_01_anchors
  before update on public.retention_voucher_lines
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger retention_voucher_lines_append_only
  before update or delete on public.retention_voucher_lines
  for each row execute function platform.reject_mutation();
create trigger retention_voucher_lines_no_truncate
  before truncate on public.retention_voucher_lines
  for each statement execute function platform.reject_mutation();

alter table public.retention_vouchers enable row level security;
alter table public.retention_vouchers force  row level security;
create policy retention_vouchers_select on public.retention_vouchers for select
  to authenticated using (company_id in (select platform.ladino_company_ids()));
create policy retention_vouchers_insert on public.retention_vouchers for insert
  to authenticated with check (false);
create policy retention_vouchers_update on public.retention_vouchers for update
  to authenticated using (false);
create policy retention_vouchers_delete on public.retention_vouchers for delete
  to authenticated using (false);
create policy retention_vouchers_api_select on public.retention_vouchers for select
  to ladino_api using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy retention_vouchers_api_insert on public.retention_vouchers for insert
  to ladino_api with check (tenant_id in (select platform.ladino_service_tenant_ids()));
-- La entrega: el trigger decide QUÉ puede cambiar; la policy, de QUIÉN es la fila.
create policy retention_vouchers_api_update on public.retention_vouchers for update
  to ladino_api using (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy retention_vouchers_api_delete on public.retention_vouchers for delete
  to ladino_api using (false);
revoke all on public.retention_vouchers from anon, authenticated, service_role, ladino_api,
  ladino_worker;
grant select on public.retention_vouchers to authenticated;
grant select, insert on public.retention_vouchers to ladino_api;
-- Segunda capa: ladino_api solo puede nombrar en un UPDATE las columnas de la entrega.
grant update (delivered_on, delivered_by) on public.retention_vouchers to ladino_api;

alter table public.retention_voucher_lines enable row level security;
alter table public.retention_voucher_lines force  row level security;
create policy retention_voucher_lines_select on public.retention_voucher_lines for select
  to authenticated using (company_id in (select platform.ladino_company_ids()));
create policy retention_voucher_lines_insert on public.retention_voucher_lines for insert
  to authenticated with check (false);
create policy retention_voucher_lines_update on public.retention_voucher_lines for update
  to authenticated using (false);
create policy retention_voucher_lines_delete on public.retention_voucher_lines for delete
  to authenticated using (false);
create policy retention_voucher_lines_api_select on public.retention_voucher_lines for select
  to ladino_api using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy retention_voucher_lines_api_insert on public.retention_voucher_lines for insert
  to ladino_api with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy retention_voucher_lines_api_update on public.retention_voucher_lines for update
  to ladino_api using (false);
create policy retention_voucher_lines_api_delete on public.retention_voucher_lines for delete
  to ladino_api using (false);
revoke all on public.retention_voucher_lines from anon, authenticated, service_role, ladino_api,
  ladino_worker;
grant select on public.retention_voucher_lines to authenticated;
grant select, insert on public.retention_voucher_lines to ladino_api;

-- ── 7. El secuencial, bajo candado ──────────────────────────────────────────
-- plpgsql y SECURITY INVOKER: cuenta con la RLS de quien emite (ve su tenant). El candado
-- serializa a los emisores de la MISMA empresa; el único (company_id, sequence) es la clave
-- natural que cierra la ventana si alguien escribe sin pasar por aquí.
create function platform.claim_retention_voucher_sequence(p_company uuid)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_next bigint;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('ladino.retention_voucher:' || p_company::text, 0));
  select coalesce(max(v.sequence), 0) + 1 into v_next
    from public.retention_vouchers v where v.company_id = p_company;
  if v_next > 99999999 then
    raise exception 'el secuencial de comprobantes de retención de la empresa % agotó sus 8 dígitos', p_company
      using errcode = '22003';
  end if;
  return v_next;
end;
$$;
revoke execute on function platform.claim_retention_voucher_sequence(uuid) from public;
grant execute on function platform.claim_retention_voucher_sequence(uuid) to ladino_api;

-- ── 8. Los importes de una factura para el comprobante (una sola definición) ─
-- En moneda funcional, a la tasa con la que se asentó, con los MISMOS redondeos que el libro de
-- compras (sub_lleno + iva_lleno, migración 65): total, base gravada, exento (el resto) e IVA.
create function platform.retention_invoice_amounts(p_invoice uuid)
returns table (total_amount numeric, taxable_base numeric, exempt_amount numeric,
               iva_amount numeric, tax_rate numeric)
language sql
stable
set search_path = ''
as $$
  select t.total, t.base, greatest(t.total - t.base - t.iva, 0), t.iva, t.rate
    from (
      select round(i.subtotal_amount * i.fx_rate, 8) + round(i.tax_amount * i.fx_rate, 8) as total,
             round(coalesce(sum(l.line_subtotal_transaction)
                            filter (where l.tax_treatment = 'gravado'), 0) * i.fx_rate, 8) as base,
             round(i.tax_amount * i.fx_rate, 8) as iva,
             -- La alícuota, si el documento tiene UNA sola entre sus líneas gravadas.
             case when count(distinct l.tax_rate_snapshot)
                         filter (where l.tax_treatment = 'gravado') = 1
                  then max(l.tax_rate_snapshot) filter (where l.tax_treatment = 'gravado') * 100
             end as rate
        from public.supplier_invoices i
        left join public.supplier_invoice_lines l on l.supplier_invoice_id = i.id
       where i.id = p_invoice
       group by i.id, i.subtotal_amount, i.tax_amount, i.fx_rate
    ) t
$$;
revoke execute on function platform.retention_invoice_amounts(uuid) from public;
grant execute on function platform.retention_invoice_amounts(uuid) to authenticated, ladino_api;

-- ── 9. El libro de retenciones de IVA lee del comprobante ───────────────────
drop function platform.iva_retention_book(uuid, date, date);
create function platform.iva_retention_book(p_company uuid, p_from date, p_to date)
returns table (
  retention_id uuid, voucher_id uuid, voucher_number text, version_no integer,
  receipt_number bigint, receipt_series text, fiscal_period text,
  issued_on date, delivered_on date, delivery_due_on date,
  supplier_tax_id text, supplier_name text, supplier_address text,
  document_type text, supplier_document_number text, supplier_control_number text,
  affected_document text, invoice_date date,
  total_amount numeric, base_amount numeric, exempt_amount numeric, iva_amount numeric,
  tax_rate numeric, rate numeric, retained_amount numeric,
  legal_source text, receipt_status text
)
language sql
stable
set search_path = ''
as $$
  -- Desde ADR-0072 §4: el COMPROBANTE, en el período de su EMISIÓN, con la identidad y los
  -- importes congelados en él. Una versión reemplazada por otra emitida hasta el cierre del
  -- período sale como «annulled»: el rastro se ve, y el TXT la excluye. Así el libro de un
  -- período no cambia por una corrección posterior a su cierre.
  select vl.supplier_retention_id, v.id, v.voucher_number, v.version_no,
         v.sequence, null::text, to_char(v.issued_on, 'YYYY-MM'),
         v.issued_on, v.delivered_on, v.delivery_due_on,
         v.supplier_tax_id, v.supplier_name, v.supplier_address,
         vl.document_type, vl.document_number, vl.control_number, vl.affected_document,
         vl.document_date,
         vl.total_amount, vl.taxable_base, vl.exempt_amount, vl.iva_amount, vl.tax_rate,
         vl.portion, vl.retained_amount,
         r.legal_source_snapshot,
         case when exists (select 1 from public.retention_vouchers n
                            where n.replaces_voucher_id = v.id and n.issued_on <= p_to)
              then 'annulled' else 'issued' end
    from public.retention_vouchers v
    join public.retention_voucher_lines vl on vl.retention_voucher_id = v.id
    join public.supplier_retentions r on r.id = vl.supplier_retention_id
   where v.company_id = p_company and v.issued_on between p_from and p_to
  union all
  -- Lo ANTERIOR a esta migración: retenciones sin comprobante-documento. Como antes (definición
  -- 20260912120000), con el comprobante viejo si lo hay; la identidad, la de la factura
  -- (snapshot o maestro, igual que el libro de compras) y los importes del documento.
  select r.id, null::uuid, null::text, null::integer,
         rc.receipt_number, rc.series, rc.fiscal_period,
         platform.caracas_day(rc.issued_at), null::date, null::date,
         case when i.supplier_name_snapshot is not null then i.supplier_tax_id_snapshot
              else s.tax_id end,
         coalesce(i.supplier_name_snapshot, s.legal_name), s.fiscal_address,
         '01'::text, i.supplier_document_number, i.supplier_control_number, null::text,
         i.invoice_date,
         m.total_amount, m.taxable_base, m.exempt_amount, m.iva_amount, m.tax_rate,
         r.rate_snapshot, r.retained_amount,
         r.legal_source_snapshot, rc.status
    from public.supplier_retentions r
    join public.supplier_invoices i on i.id = r.supplier_invoice_id
    join public.suppliers s on s.id = r.supplier_id
    left join public.retention_receipts rc
      on rc.supplier_invoice_id = r.supplier_invoice_id and rc.status <> 'annulled'
    cross join lateral platform.retention_invoice_amounts(i.id) m
   where r.company_id = p_company and r.retention_code = 'iva' and r.status <> 'cancelled'
     and not exists (select 1 from public.retention_voucher_lines x
                      where x.supplier_retention_id = r.id)
     and coalesce(platform.caracas_day(rc.issued_at), i.invoice_date) between p_from and p_to
   order by 8 nulls last, 3 nulls last, 18
$$;
comment on function platform.iva_retention_book(uuid, date, date) is
  'Libro de retenciones de IVA PRACTICADAS (ADR-0072 §4 y §6): una fila por renglón de '
  'comprobante emitido en el período, con la identidad y los importes congelados al emitir; '
  'aparte, las retenciones anteriores a la migración 20261002110000 sin comprobante-documento.';
revoke execute on function platform.iva_retention_book(uuid, date, date) from public, anon;
grant execute on function platform.iva_retention_book(uuid, date, date) to authenticated, ladino_api;

-- ── 10. El libro de compras identifica el comprobante (H-12) ─────────────────
create function platform.purchases_book_with_vouchers(p_company uuid, p_from date, p_to date)
returns table (
  invoice_id uuid, invoice_date date, supplier_tax_id text, supplier_name text,
  supplier_kind text, supplier_document_number text, supplier_control_number text,
  supplier_document_ref text, status text, transaction_currency text, fx_rate numeric,
  base_gravada numeric, iva_credito numeric, iva_al_costo numeric, base_exenta numeric,
  base_exonerada numeric, base_no_sujeta numeric, base_sin_clasificar numeric,
  retenido_iva numeric, retenido_islr numeric, total_amount numeric, tax_is_recoverable boolean,
  journal_entry_id uuid, booked_on date, received_late boolean,
  base_alicuota_general numeric, iva_alicuota_general numeric, alicuota_general numeric,
  base_alicuota_adicional numeric, iva_alicuota_adicional numeric, alicuota_adicional numeric,
  base_alicuota_reducida numeric, iva_alicuota_reducida numeric, alicuota_reducida numeric,
  base_gravada_sin_alicuota numeric, iva_sin_clasificar numeric,
  retention_voucher_number text, retention_voucher_date date, retention_voucher_iva numeric
)
language sql
stable
set search_path = ''
as $$
  -- PA SNAT/2025/000054 art. 16 in fine (respuesta del dueño H-12): agente y proveedor registran
  -- el comprobante en el período de su EMISIÓN. El renglón de la factura lo identifica si se
  -- emitió en el período del libro; si se emitió en otro, sale en el suyo como renglón propio
  -- «comprobante_retencion», con los importes en cero (el crédito ya está en el de la factura).
  -- Vigente = no reemplazado por otra versión emitida hasta el cierre del período.
  with libro as (
    select p.*
      from platform.purchases_book_by_rate(p_company, p_from, p_to) with ordinality as p
  ),
  comprobantes as (
    select vl.supplier_invoice_id, v.id as voucher_id, v.voucher_number, v.issued_on,
           v.supplier_tax_id, v.supplier_name, min(vl.document_number) as document_number,
           min(vl.control_number) as control_number, sum(vl.retained_amount) as retenido
      from public.retention_vouchers v
      join public.retention_voucher_lines vl on vl.retention_voucher_id = v.id
     where v.company_id = p_company and v.issued_on between p_from and p_to
       and not exists (select 1 from public.retention_vouchers n
                        where n.replaces_voucher_id = v.id and n.issued_on <= p_to)
     group by vl.supplier_invoice_id, v.id, v.voucher_number, v.issued_on, v.supplier_tax_id,
              v.supplier_name
  ),
  renglones_factura as (
    select l.invoice_id from libro l
     where l.status <> 'ajuste_periodo_anterior'
       and not exists (select 1 from public.supplier_credit_notes n where n.id = l.invoice_id)
  )
  select x.invoice_id, x.invoice_date, x.supplier_tax_id, x.supplier_name, x.supplier_kind,
         x.supplier_document_number, x.supplier_control_number, x.supplier_document_ref,
         x.status, x.transaction_currency, x.fx_rate, x.base_gravada, x.iva_credito,
         x.iva_al_costo, x.base_exenta, x.base_exonerada, x.base_no_sujeta,
         x.base_sin_clasificar, x.retenido_iva, x.retenido_islr, x.total_amount,
         x.tax_is_recoverable, x.journal_entry_id, x.booked_on, x.received_late,
         x.base_alicuota_general, x.iva_alicuota_general, x.alicuota_general,
         x.base_alicuota_adicional, x.iva_alicuota_adicional, x.alicuota_adicional,
         x.base_alicuota_reducida, x.iva_alicuota_reducida, x.alicuota_reducida,
         x.base_gravada_sin_alicuota, x.iva_sin_clasificar,
         x.voucher_number, x.voucher_date, x.voucher_iva
    from (
      select l.*, 0 as grupo, c.voucher_number, c.issued_on as voucher_date,
             c.retenido as voucher_iva
        from libro l
        left join lateral (
          select string_agg(c.voucher_number, ' ' order by c.voucher_number) as voucher_number,
                 max(c.issued_on) as issued_on, sum(c.retenido) as retenido
            from comprobantes c
           where c.supplier_invoice_id = l.invoice_id
             and l.invoice_id in (select r.invoice_id from renglones_factura r)
          having count(*) > 0
        ) c on true
      union all
      select c.supplier_invoice_id, i.invoice_date, c.supplier_tax_id, c.supplier_name,
             s.supplier_kind, c.document_number, c.control_number, null::text,
             'comprobante_retencion'::text, i.transaction_currency, i.fx_rate,
             0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
             0::numeric, 0::numeric, 0::numeric, i.tax_is_recoverable, null::uuid, c.issued_on,
             false, 0::numeric, 0::numeric, null::numeric, 0::numeric, 0::numeric, null::numeric,
             0::numeric, 0::numeric, null::numeric, 0::numeric, 0::numeric,
             null::bigint, 1, c.voucher_number, c.issued_on, c.retenido
        from comprobantes c
        join public.supplier_invoices i on i.id = c.supplier_invoice_id
        join public.suppliers s on s.id = i.supplier_id
       where c.supplier_invoice_id not in (select r.invoice_id from renglones_factura r)
    ) x
   order by x.grupo, x.ordinality nulls last, x.voucher_date, x.voucher_number
$$;
comment on function platform.purchases_book_with_vouchers(uuid, date, date) is
  'Libro de compras por alícuota (purchases_book_by_rate, sin tocarla) más el comprobante de '
  'retención emitido en el período: número, fecha e IVA retenido (H-12, PA SNAT/2025/000054 '
  'art. 16 in fine). Un comprobante de otro período que el de su factura sale como renglón propio '
  'en el de su emisión, con importes en cero.';
revoke execute on function platform.purchases_book_with_vouchers(uuid, date, date) from public, anon;
grant execute on function platform.purchases_book_with_vouchers(uuid, date, date)
  to authenticated, ladino_api;

-- =============================================================================
-- Reversibilidad (con datos vivos): SÍ, con una migración nueva.
--   · `purchases_book_with_vouchers`, `retention_invoice_amounts`, `claim_retention_voucher_sequence`,
--     `retention_fortnight` y `retention_voucher_due_on` se retiran con drop (nada del esquema las
--     usa salvo el código de esta entrega).
--   · `iva_retention_book` vuelve a la definición de 20260912120000 con drop + create (cambia el
--     tipo de retorno). Un libro ya exportado con el formato nuevo daría otro hash.
--   · Las TABLAS de comprobantes NO se retiran si tienen filas: son documentos fiscales emitidos y
--     entregados a terceros (regla 1). Revertir es dejar de emitir, no borrar lo emitido.
--   · Las columnas de `supplier_invoices` y `purchase_settings` se pueden retirar solo si están
--     vacías / en su omisión; con datos, se conservan (son la auditoría de una exclusión).
--   · `retention_exclusions` y el concepto `iva_compras_total` se retiran si nada los referencia.
-- =============================================================================

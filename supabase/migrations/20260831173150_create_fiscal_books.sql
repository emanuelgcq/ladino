-- =============================================================================
-- Ladino — migración 27 · LIBROS FISCALES: snapshot ampliado, libros como
--                          consulta, y adaptadores de formato
--
-- Módulo: fiscal-books  Spec: ADR-0044 · REPORTING_AND_FISCAL_BOOKS ·
--                       PA SNAT/2011/00071 · PA 102 · IVA_SPEC · RETENTIONS_SPEC
-- Reversible: SÍ mientras no se haya exportado un libro (fiscal_book_runs vacía).
-- Homologación: SÍ — el libro es un documento que el contribuyente entrega al
--               SENIAT y que en fiscalización se compara contra sus facturas.
--
-- POR QUÉ AHORA Y POR QUÉ TAN GRANDE. El libro de ventas y el de compras son
-- obligación legal HOY bajo PA 071 y PA 102, no dependen de homologación y no
-- dependen de la PA 121 derogada. Y al ir a construirlos apareció un defecto de
-- datos que ya existía: `document_lines` congelaba la ALÍCUOTA pero no el
-- TRATAMIENTO. Un libro separa exento, exonerado y no sujeto en columnas
-- distintas, y una alícuota de cero no los distingue.
--
-- Leer hoy `products.tax_category_code` sería reinterpretar el pasado con datos
-- actuales, que es justo lo que REPORTING_AND_FISCAL_BOOKS prohíbe. Y derivarlo
-- de `tax_rules` no funciona: su `product_tax_category` es NULLABLE —NULL
-- significa «cualquiera»— así que la regla no siempre identifica el tratamiento.
--
-- LO QUE ESTA MIGRACIÓN NO HACE:
--   · no rellena por inferencia NADA de lo ya emitido: las columnas nuevas
--     quedan NULL y el libro lo muestra como «sin clasificar». Por eso ninguna
--     nace `not null default`: un default backfillea, y un backfill es una
--     inferencia sobre el pasado disfrazada de valor por omisión;
--   · no siembra NINGÚN adaptador de formato OFICIAL: el layout TXT/XML del
--     SENIAT no está en el repositorio y no se inventa (ADR-0044 §5). Se siembra
--     uno NO oficial con las columnas que PA 071 y PA 102 nombran;
--   · no añade columna de IGTF: Ladino no lo calcula en ninguna parte, y
--     `IGTF_SPEC` avisa de que no toda operación en divisa lo causa. Una columna
--     de IGTF hoy sería inventada;
--   · no materializa los libros. Se calculan desde los documentos, que es lo que
--     garantiza que cuadren con ellos. Si el volumen lo exige, se materializa
--     entonces y no antes.
-- =============================================================================

-- ── 1. El snapshot de emisión, AMPLIADO ─────────────────────────────────────
-- `tax_treatment` es redundante con `tax_category_snapshot` A PROPÓSITO: la
-- categoría es vocabulario de producto y puede crecer (una alícuota nueva añade
-- otro `gravado_*`), mientras que las columnas del libro son CUATRO y las fija
-- la norma. Guardar las dos permite que el catálogo evolucione sin que cambie la
-- forma del libro.
alter table public.document_lines
  add column tax_category_snapshot text,
  add column tax_treatment         text,
  add column operation_type        text;
alter table public.supplier_invoice_lines
  add column tax_category_snapshot text,
  add column tax_treatment         text,
  add column operation_type        text;

alter table public.document_lines add constraint document_lines_treatment_chk
  check (tax_treatment is null
         or tax_treatment in ('gravado', 'exento', 'exonerado', 'no_sujeto'));
alter table public.document_lines add constraint document_lines_operation_chk
  check (operation_type is null
         or operation_type in ('interna', 'exportacion', 'importacion'));
alter table public.supplier_invoice_lines add constraint supplier_invoice_lines_treatment_chk
  check (tax_treatment is null
         or tax_treatment in ('gravado', 'exento', 'exonerado', 'no_sujeto'));
alter table public.supplier_invoice_lines add constraint supplier_invoice_lines_operation_chk
  check (operation_type is null
         or operation_type in ('interna', 'exportacion', 'importacion'));

comment on column public.document_lines.tax_treatment is
  'Tratamiento al EMITIR, congelado (ADR-0044 §1). NULL en lo emitido antes de '
  'la migración 27: el libro lo muestra en su propia columna «sin clasificar» en '
  'vez de adivinarlo. Nullable por eso, no por descuido.';
comment on column public.supplier_invoice_lines.tax_treatment is
  'Igual que su gemela de ventas: congelado al registrar, NULL en lo anterior.';

-- La derivación categoría → tratamiento, en un solo sitio. Que sea una función
-- y no un `case` repetido en cada consulta es lo que evita que dos libros
-- clasifiquen distinto la misma línea.
create function platform.tax_treatment_of(p_category text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
           when p_category is null then null
           when p_category like 'gravado%' then 'gravado'
           when p_category = 'exento' then 'exento'
           when p_category = 'exonerado' then 'exonerado'
           when p_category = 'no_sujeto' then 'no_sujeto'
           -- Una categoría nueva que no encaje NO se clasifica en silencio como
           -- gravada: se devuelve NULL y el libro dice que no la conoce. Meterla
           -- en la columna equivocada es lo que produce una declaración falsa.
           else null
         end
$$;
revoke execute on function platform.tax_treatment_of(text) from public;
grant execute on function platform.tax_treatment_of(text) to authenticated, ladino_api;

-- ── 2. Un comprobante de retención vivo por factura ─────────────────────────
-- El libro de retenciones une retención → comprobante por `supplier_invoice_id`,
-- y sin unicidad ese `join` MULTIPLICA filas: dos comprobantes convertirían una
-- retención en dos renglones del libro, o sea el doble de impuesto retenido en
-- un documento legal. El modelo de la migración 22 ya emite uno solo —el
-- comprobante cubre `total_retained` de la factura entera—, pero eso vivía en el
-- caso de uso. Ausencia de mecanismo no es prohibición (CLAUDE.md §2).
create unique index retention_receipts_one_live_per_invoice_key
  on public.retention_receipts (company_id, supplier_invoice_id)
  where status <> 'annulled';

-- ── 3. Rastro de cada generación OFICIAL (ADR-0044 §2) ──────────────────────
create table public.book_format_adapters (
  code         text primary key,
  book_kind    text not null,
  name         text not null,
  description  text not null,
  -- `true` solo cuando el layout venga de una norma citada. Hoy no hay ninguno.
  is_official  boolean not null default false,
  legal_source text not null,
  status       text not null default 'active',
  constraint book_format_adapters_code_chk check (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint book_format_adapters_kind_chk
    check (book_kind in ('ventas', 'compras', 'retenciones_iva', 'retenciones_islr', 'todos')),
  constraint book_format_adapters_status_chk check (status in ('active', 'inactive'))
);
comment on table public.book_format_adapters is
  'Catálogo GLOBAL de formatos de exportación (ADR-0044 §5). Nace sin ningún '
  'adaptador OFICIAL: el layout del SENIAT no está en el repositorio y no se '
  'inventa. Cuando aparezca es una fila más, no una reescritura.';

create table public.fiscal_book_runs (
  id             uuid        primary key default platform.uuidv7(),
  tenant_id      uuid        not null,
  company_id     uuid        not null,
  book_kind      text        not null,
  -- Los SIETE campos que exige REPORTING_AND_FISCAL_BOOKS §Reproducibilidad:
  -- período (2), parámetros, timezone, versión del generador, quién y cuándo.
  period_from    date        not null,
  period_to      date        not null,
  parameters     jsonb       not null default '{}'::jsonb,
  timezone       text        not null,
  generator_version text     not null,
  -- Hash del dataset. Dos exportaciones del mismo período con los mismos datos
  -- dan el mismo hash; una tercera distinta dice que algo cambió entre medias,
  -- que es justo lo que hay que poder demostrar en una fiscalización.
  dataset_hash   text        not null,
  row_count      integer     not null,
  format_code    text        not null,

  created_by     uuid,
  created_at     timestamptz not null,
  version        integer     not null,

  constraint fiscal_book_runs_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint fiscal_book_runs_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint fiscal_book_runs_format_fk
    foreign key (format_code) references public.book_format_adapters (code),
  constraint fiscal_book_runs_kind_chk
    check (book_kind in ('ventas', 'compras', 'retenciones_iva', 'retenciones_islr')),
  constraint fiscal_book_runs_period_chk check (period_to >= period_from),
  constraint fiscal_book_runs_hash_chk check (dataset_hash ~ '^[0-9a-f]{64}$'),
  constraint fiscal_book_runs_rows_chk check (row_count >= 0),
  constraint fiscal_book_runs_tz_chk check (length(btrim(timezone)) between 1 and 60),
  -- El «quién» de los siete campos. `set_row_provenance()` deja `created_by` en
  -- NULL EN SILENCIO si falta el GUC de actor; en una tabla cuya razón de ser es
  -- probar quién presentó qué, ese silencio es el peor modo de fallo posible.
  -- El CHECK se evalúa DESPUÉS del trigger BEFORE, así que lo convierte en ruido.
  constraint fiscal_book_runs_author_chk check (created_by is not null),
  constraint fiscal_book_runs_company_id_key unique (company_id, id)
);
create index fiscal_book_runs_lookup_idx
  on public.fiscal_book_runs (company_id, book_kind, period_from desc);
comment on table public.fiscal_book_runs is
  'Una fila por EXPORTACIÓN oficial de un libro. Consultar en pantalla no deja '
  'rastro —es una lectura—; exportar para presentar, sí (ADR-0044 §2).';

-- Append-only: una generación es un hecho. Reescribir el hash de una
-- exportación ya presentada sería borrar la prueba de qué se presentó.
create trigger fiscal_book_runs_provenance
  before insert or update on public.fiscal_book_runs
  for each row execute function platform.set_row_provenance();
-- El ancla, aunque la tabla sea append-only y por tanto el UPDATE ya esté
-- prohibido. Lo pide la propiedad del test 006 —TODA tabla con `tenant_id`
-- lleva su ancla— y la propiedad vale más que la excepción razonada: en cuanto
-- una tabla se salta la regla «porque en su caso no hace falta», la consulta que
-- vigila el catálogo entero deja de poder afirmar nada.
create trigger fiscal_book_runs_anchors
  before update on public.fiscal_book_runs
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger fiscal_book_runs_append_only
  before update or delete on public.fiscal_book_runs
  for each row execute function platform.reject_mutation();
create trigger fiscal_book_runs_no_truncate
  before truncate on public.fiscal_book_runs
  for each statement execute function platform.reject_mutation();

alter table public.fiscal_book_runs      enable row level security;
alter table public.fiscal_book_runs      force  row level security;
alter table public.book_format_adapters  enable row level security;
alter table public.book_format_adapters  force  row level security;

create policy fiscal_book_runs_select on public.fiscal_book_runs for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy fiscal_book_runs_insert on public.fiscal_book_runs for insert to authenticated
  with check (false);
create policy fiscal_book_runs_update on public.fiscal_book_runs for update to authenticated
  using (false);
create policy fiscal_book_runs_delete on public.fiscal_book_runs for delete to authenticated
  using (false);
create policy fiscal_book_runs_api_select on public.fiscal_book_runs for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy fiscal_book_runs_api_insert on public.fiscal_book_runs for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy fiscal_book_runs_api_update on public.fiscal_book_runs for update to ladino_api
  using (false);
create policy fiscal_book_runs_api_delete on public.fiscal_book_runs for delete to ladino_api
  using (false);

create policy book_format_adapters_select on public.book_format_adapters
  for select to authenticated using (true);
create policy book_format_adapters_insert on public.book_format_adapters
  for insert to authenticated with check (false);
create policy book_format_adapters_update on public.book_format_adapters
  for update to authenticated using (false);
create policy book_format_adapters_delete on public.book_format_adapters
  for delete to authenticated using (false);
create policy book_format_adapters_api_select on public.book_format_adapters
  for select to ladino_api using (true);
create policy book_format_adapters_api_insert on public.book_format_adapters
  for insert to ladino_api with check (false);
create policy book_format_adapters_api_update on public.book_format_adapters
  for update to ladino_api using (false);
create policy book_format_adapters_api_delete on public.book_format_adapters
  for delete to ladino_api using (false);

revoke all on public.fiscal_book_runs, public.book_format_adapters
  from anon, authenticated, service_role, ladino_api, ladino_worker;
grant select on public.fiscal_book_runs, public.book_format_adapters to authenticated;
grant select on public.book_format_adapters to ladino_api;
-- INSERT y nada más: append-only en las dos capas.
grant select, insert on public.fiscal_book_runs to ladino_api;

-- ── 4. LIBRO DE VENTAS ──────────────────────────────────────────────────────
-- Una fila por documento. Las bases van separadas por TRATAMIENTO, que es como
-- las pide la norma.
--
-- El IVA sale de la CABECERA (`d.tax_amount`), no de sumar las líneas gravadas:
-- la cabecera es el importe que se emitió y el que tiene que cuadrar con el
-- mayor, y así el libro sigue cuadrando con contabilidad incluso para los
-- documentos anteriores a esta migración, que no tienen tratamiento por línea.
--
-- La fecha que manda es `issued_at`, no `created_at`: el período de un documento
-- lo fija su emisión, no cuándo se tecleó. Consecuencia asumida — una factura
-- registrada tarde aparece en el libro de SU mes y puede reabrir uno ya
-- presentado. Por eso existe `fiscal_book_runs`.
create function platform.sales_book(p_company uuid, p_from date, p_to date)
returns table (
  document_id uuid, issued_on date, kind text, series text, document_number bigint,
  control_number bigint, status text,
  customer_tax_id text, customer_name text, customer_taxpayer_type text,
  transaction_currency text, fx_rate numeric,
  base_gravada numeric, iva_debito numeric, base_exenta numeric, base_exonerada numeric,
  base_no_sujeta numeric, base_sin_clasificar numeric,
  total_amount numeric, journal_entry_id uuid
)
language sql
stable
set search_path = ''
as $$
  select d.id, d.issued_at::date, d.kind, d.series, d.document_number, d.control_number, d.status,
         c.tax_id, c.legal_name, c.taxpayer_type_code,
         d.transaction_currency, d.fx_rate,
         coalesce(sum(dl.line_subtotal_transaction)
                  filter (where dl.tax_treatment = 'gravado'), 0),
         d.tax_amount,
         coalesce(sum(dl.line_subtotal_transaction) filter (where dl.tax_treatment = 'exento'), 0),
         coalesce(sum(dl.line_subtotal_transaction)
                  filter (where dl.tax_treatment = 'exonerado'), 0),
         coalesce(sum(dl.line_subtotal_transaction)
                  filter (where dl.tax_treatment = 'no_sujeto'), 0),
         -- Lo emitido ANTES de la migración 27 no tiene tratamiento. Va a su
         -- propia columna, VISIBLE, en vez de sumarse a una que no le toca.
         coalesce(sum(dl.line_subtotal_transaction) filter (where dl.tax_treatment is null), 0),
         d.total_amount, d.journal_entry_id
    from public.documents d
    join public.customers c on c.id = d.customer_id
    left join public.document_lines dl on dl.document_id = d.id
   where d.company_id = p_company
     and d.kind in ('invoice', 'credit_note', 'debit_note')
     -- ANULADA SÍ APARECE, con su estado: el libro registra el correlativo
     -- consumido. Omitirla dejaría un hueco de numeración inexplicable.
     and d.status in ('issued', 'paid', 'annulled')
     and d.issued_at::date between p_from and p_to
   group by d.id, c.tax_id, c.legal_name, c.taxpayer_type_code
   order by d.issued_at, d.series, d.document_number
$$;

-- ── 5. LIBRO DE COMPRAS ─────────────────────────────────────────────────────
-- El número de control es DEL PROVEEDOR y va como texto, tal como él lo emitió
-- (ADR-0040 §2). `iva_credito` solo tiene sentido si el IVA es recuperable; para
-- un contribuyente formal es costo, y entonces el mismo importe aparece en
-- `iva_al_costo` con la bandera al lado para que se vea por qué.
create function platform.purchases_book(p_company uuid, p_from date, p_to date)
returns table (
  invoice_id uuid, invoice_date date, supplier_tax_id text, supplier_name text,
  supplier_kind text, supplier_document_number text, supplier_control_number text,
  supplier_document_ref text, status text,
  base_gravada numeric, iva_credito numeric, iva_al_costo numeric,
  base_exenta numeric, base_exonerada numeric, base_no_sujeta numeric,
  base_sin_clasificar numeric,
  retenido_iva numeric, retenido_islr numeric,
  total_amount numeric, tax_is_recoverable boolean, journal_entry_id uuid
)
language sql
stable
set search_path = ''
as $$
  select i.id, i.invoice_date, s.tax_id, s.legal_name, s.supplier_kind,
         i.supplier_document_number, i.supplier_control_number, i.supplier_document_ref, i.status,
         coalesce(sum(l.line_subtotal_transaction) filter (where l.tax_treatment = 'gravado'), 0),
         case when i.tax_is_recoverable then i.tax_amount else 0 end,
         case when i.tax_is_recoverable then 0 else i.tax_amount end,
         coalesce(sum(l.line_subtotal_transaction) filter (where l.tax_treatment = 'exento'), 0),
         coalesce(sum(l.line_subtotal_transaction) filter (where l.tax_treatment = 'exonerado'), 0),
         coalesce(sum(l.line_subtotal_transaction) filter (where l.tax_treatment = 'no_sujeto'), 0),
         coalesce(sum(l.line_subtotal_transaction) filter (where l.tax_treatment is null), 0),
         coalesce((select sum(r.retained_amount) from public.supplier_retentions r
                    where r.supplier_invoice_id = i.id and r.retention_code = 'iva'
                      and r.status <> 'cancelled'), 0),
         coalesce((select sum(r.retained_amount) from public.supplier_retentions r
                    where r.supplier_invoice_id = i.id and r.retention_code = 'islr'
                      and r.status <> 'cancelled'), 0),
         i.total_amount, i.tax_is_recoverable, i.journal_entry_id
    from public.supplier_invoices i
    join public.suppliers s on s.id = i.supplier_id
    left join public.supplier_invoice_lines l on l.supplier_invoice_id = i.id
   where i.company_id = p_company
     and i.status in ('posted', 'paid', 'annulled')
     and i.invoice_date between p_from and p_to
   group by i.id, s.tax_id, s.legal_name, s.supplier_kind
   order by i.invoice_date, i.supplier_document_number
$$;

-- ── 6. LIBROS DE RETENCIONES ────────────────────────────────────────────────
-- Uno por tributo: se enteran por separado y con formularios distintos, así que
-- mezclarlos en una consulta con filtro sería invitar a presentarlos mezclados.
--
-- El comprobante puede no existir todavía —la retención se calcula al registrar
-- la factura y el comprobante se emite al pagar—, y por eso el `left join` y el
-- `coalesce` de fecha: una retención practicada y sin comprobante SÍ pertenece
-- al libro, y esconderla sería declarar de menos.
create function platform.iva_retention_book(p_company uuid, p_from date, p_to date)
returns table (
  retention_id uuid, receipt_number bigint, receipt_series text, fiscal_period text,
  issued_on date, supplier_tax_id text, supplier_name text,
  supplier_document_number text, supplier_control_number text, invoice_date date,
  base_amount numeric, rate numeric, retained_amount numeric,
  legal_source text, receipt_status text
)
language sql
stable
set search_path = ''
as $$
  select r.id, rc.receipt_number, rc.series, rc.fiscal_period, rc.issued_at::date,
         s.tax_id, s.legal_name, i.supplier_document_number, i.supplier_control_number,
         i.invoice_date, r.base_amount, r.rate_snapshot, r.retained_amount,
         -- La norma con la que se retuvo, COPIADA en la retención (ADR-0039).
         -- Sin ella el libro no es auditable: dice cuánto, no con qué derecho.
         r.legal_source_snapshot, rc.status
    from public.supplier_retentions r
    join public.supplier_invoices i on i.id = r.supplier_invoice_id
    join public.suppliers s on s.id = r.supplier_id
    left join public.retention_receipts rc
      on rc.supplier_invoice_id = r.supplier_invoice_id and rc.status <> 'annulled'
   where r.company_id = p_company and r.retention_code = 'iva' and r.status <> 'cancelled'
     and coalesce(rc.issued_at::date, i.invoice_date) between p_from and p_to
   order by rc.receipt_number nulls last, i.invoice_date
$$;

create function platform.islr_retention_book(p_company uuid, p_from date, p_to date)
returns table (
  retention_id uuid, receipt_number bigint, receipt_series text, fiscal_period text,
  issued_on date, supplier_tax_id text, supplier_name text, concept_code text,
  concept_name text, formula_kind text,
  supplier_document_number text, invoice_date date,
  base_amount numeric, rate numeric, subtrahend numeric, retained_amount numeric,
  legal_source text, receipt_status text
)
language sql
stable
set search_path = ''
as $$
  select r.id, rc.receipt_number, rc.series, rc.fiscal_period, rc.issued_at::date,
         s.tax_id, s.legal_name, r.concept_code, cn.name, r.formula_kind,
         i.supplier_document_number, i.invoice_date,
         r.base_amount, r.rate_snapshot, r.subtrahend_snapshot, r.retained_amount,
         r.legal_source_snapshot, rc.status
    from public.supplier_retentions r
    join public.supplier_invoices i on i.id = r.supplier_invoice_id
    join public.suppliers s on s.id = r.supplier_id
    join public.retention_concepts cn on cn.code = r.concept_code
    left join public.retention_receipts rc
      on rc.supplier_invoice_id = r.supplier_invoice_id and rc.status <> 'annulled'
   where r.company_id = p_company and r.retention_code = 'islr' and r.status <> 'cancelled'
     and coalesce(rc.issued_at::date, i.invoice_date) between p_from and p_to
   order by rc.receipt_number nulls last, i.invoice_date
$$;

-- ── 7. RECONCILIACIÓN libro ↔ contabilidad (ADR-0044 §3) ────────────────────
/**
 * El IVA del libro NO puede ser igual al saldo de su cuenta mientras exista la
 * cola de ADR-0042: un documento correcto puede estar pendiente de contabilizar.
 * El invariante real es `libro = mayor + pendientes`, y se devuelven las TRES
 * cifras para que la diferencia sea explicable en vez de sospechosa.
 *
 * Es la misma familia que `accounting_coverage_gaps()`: una consulta que cruza
 * módulos y que ningún test de un módulo solo puede sustituir.
 *
 * Los asientos `reversed` se INCLUYEN junto a los `posted`: una factura anulada
 * tiene su asiento revertido y su contra-asiento, que netean a cero — y el libro
 * la excluye del total por el mismo motivo. Contar solo `posted` dejaría el
 * contra-asiento sin su original y el mayor saldría torcido.
 */
create function platform.book_ledger_reconciliation(p_company uuid, p_from date, p_to date)
returns table (
  concepto text, libro numeric, mayor numeric, en_cola numeric, diferencia numeric, cuadra boolean
)
language sql
stable
set search_path = ''
as $$
  with vigente as (
    select purpose, account_id from public.company_account_settings
     where company_id = p_company and effective_to is null
  ),
  -- El `exists` va en el ON del left join, no en el WHERE: en el WHERE
  -- descartaría el papel entero cuando no tiene ni una línea en el período, y
  -- lo que se quiere es que ese papel salga con saldo cero.
  mayor as (
    select v.purpose,
           coalesce(sum(jl.functional_credit - jl.functional_debit), 0) as acreedor,
           coalesce(sum(jl.functional_debit - jl.functional_credit), 0) as deudor
      from vigente v
      left join public.journal_lines jl
        on jl.account_id = v.account_id
       and jl.company_id = p_company
       and exists (select 1 from public.journal_entries e
                    where e.id = jl.entry_id
                      and e.status in ('posted', 'reversed')
                      and e.posting_date between p_from and p_to)
     group by v.purpose
  ),
  libro_ventas as (
    select coalesce(sum(iva_debito), 0) as iva,
           coalesce(sum(iva_debito) filter (where journal_entry_id is null), 0) as sin_asiento
      from platform.sales_book(p_company, p_from, p_to)
     where status <> 'annulled'
  ),
  libro_compras as (
    select coalesce(sum(iva_credito), 0) as iva,
           coalesce(sum(iva_credito) filter (where journal_entry_id is null), 0) as sin_asiento
      from platform.purchases_book(p_company, p_from, p_to)
     where status <> 'annulled'
  ),
  cifras as (
    select 'iva_debito_fiscal'::text as concepto, v.iva as libro,
           coalesce((select acreedor from mayor where purpose = 'iva_debit_fiscal'), 0) as mayor,
           v.sin_asiento as en_cola
      from libro_ventas v
    union all
    select 'iva_credito_fiscal', c.iva,
           coalesce((select deudor from mayor where purpose = 'iva_credit_fiscal'), 0),
           c.sin_asiento
      from libro_compras c
  )
  select concepto, libro, mayor, en_cola,
         libro - mayor - en_cola,
         libro - mayor - en_cola = 0
    from cifras
$$;

grant execute on function platform.sales_book(uuid, date, date) to authenticated, ladino_api;
grant execute on function platform.purchases_book(uuid, date, date) to authenticated, ladino_api;
grant execute on function platform.iva_retention_book(uuid, date, date)
  to authenticated, ladino_api;
grant execute on function platform.islr_retention_book(uuid, date, date)
  to authenticated, ladino_api;
grant execute on function platform.book_ledger_reconciliation(uuid, date, date)
  to authenticated, ladino_api;
revoke execute on function platform.sales_book(uuid, date, date) from public;
revoke execute on function platform.purchases_book(uuid, date, date) from public;
revoke execute on function platform.iva_retention_book(uuid, date, date) from public;
revoke execute on function platform.islr_retention_book(uuid, date, date) from public;
revoke execute on function platform.book_ledger_reconciliation(uuid, date, date) from public;

-- ── 8. Seeds: UN adaptador, y no es el oficial ─────────────────────────────
insert into public.book_format_adapters
  (code, book_kind, name, description, is_official, legal_source)
values
  ('csv_columnas_legales', 'todos', 'CSV con las columnas de PA 071 y PA 102',
   'VALIDAR-SENIAT: NO es el formato oficial de presentación. Es un CSV con las columnas que PA SNAT/2011/00071 y PA 102 NOMBRAN, entregable a un contador para revisión y archivo. El layout exacto del fichero que exige la administración tributaria no está en el repositorio y no se inventa: cuando aparezca, entra como otro adaptador de esta misma interfaz.',
   false,
   'PA SNAT/2011/00071 y PA SNAT/2024/000102 en cuanto a los DATOS que debe contener el libro. El FORMATO del fichero de presentación queda VALIDAR-SENIAT.')
on conflict (code) do nothing;

-- Permisos del módulo. Consultar y exportar se separan a propósito: exportar
-- deja rastro con nombre y apellido y es el acto que precede a una presentación.
insert into public.permissions (key, description, is_scoped) values
  ('fiscal_book.read',   'Consultar los libros fiscales en pantalla',                false),
  ('fiscal_book.export', 'Exportar un libro fiscal, dejando su rastro reproducible', false)
on conflict (key) do nothing;

-- ── 9. Lo que esta migración GARANTIZA sobre sí misma (LAD66) ──────────────
do $$
begin
  if (select count(*) from public.book_format_adapters where is_official) <> 0 then
    raise exception 'LAD66: hay un adaptador marcado OFICIAL y el layout del SENIAT no está en el repositorio (ADR-0044 §5)';
  end if;
  if (select count(*) from public.book_format_adapters
       where description not like '%VALIDAR-SENIAT%') <> 0 then
    raise exception 'LAD66: hay un adaptador de formato sin marcar VALIDAR-SENIAT';
  end if;
  if (select count(*) from public.fiscal_book_runs) <> 0 then
    raise exception 'LAD66: fiscal_book_runs debe nacer vacía: una generación es un hecho, no un seed';
  end if;
  -- El tratamiento NO se rellena por inferencia en lo ya emitido. Si alguien
  -- añadiera un UPDATE de relleno a esta migración, o un `default`, esto lo caza.
  if (select count(*) from public.document_lines where tax_treatment is not null) <> 0
     or (select count(*) from public.supplier_invoice_lines where tax_treatment is not null) <> 0
  then
    raise exception 'LAD66: se ha rellenado el tratamiento de líneas ya emitidas: el pasado no se reinterpreta (ADR-0044 §1)';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public'
         and table_name in ('document_lines', 'supplier_invoice_lines')
         and column_name in ('tax_category_snapshot', 'tax_treatment', 'operation_type')
         and (is_nullable = 'NO' or column_default is not null)) <> 0 then
    raise exception 'LAD66: una columna de snapshot nueva tiene NOT NULL o default: eso backfillea el pasado';
  end if;
  if (select count(*) from public.permissions where key like 'fiscal_book.%') <> 2 then
    raise exception 'LAD66: faltan permisos de libros fiscales';
  end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in ('fiscal_book_runs', 'book_format_adapters')
         and c.relrowsecurity and c.relforcerowsecurity) <> 2 then
    raise exception 'LAD66: alguna tabla de libros sin RLS habilitada y forzada';
  end if;
  if (select count(*) from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'fiscal_book_runs'
         and grantee in ('anon','authenticated','service_role','ladino_api','ladino_worker')
         and privilege_type in ('UPDATE','DELETE','TRUNCATE')) <> 0 then
    raise exception 'LAD66: fiscal_book_runs tiene privilegio de mutación y es append-only';
  end if;
end $$;

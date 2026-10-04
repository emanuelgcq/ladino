-- =============================================================================
-- Ladino — 20261003110000 · SALIDAS Y RETIROS DE INVENTARIO (ADR-0078)
--
-- Módulo: inventario · contabilidad · fiscal (RIGOR MÁXIMO)
-- Spec: ADR-0078 · ADR-0034 · ADR-0060 · ADR-0066 · RESPUESTA §2.12, §2.13
-- Hallazgos: I-01, I-02, I-08, I-11, I-12, P-10 (los de pantalla, I-05/I-06/I-07/I-09/I-10, en web).
-- HOMOLOGATION_IMPACT: YES — el retiro (LIVA art. 4.3) causa débito fiscal y entra al libro de
--   ventas y a la declaración. No toca la numeración de control de la imprenta: la Nota de retiro
--   es un documento INTERNO con correlativo propio.
--
-- EL DEFECTO.
--   · I-01: `inventory_moves_reason_chk` exige `reason IS NULL` en las salidas, y la web manda el
--     motivo: toda salida moría con 23514. I-02: los tests no mandaban el motivo y pasaban.
--   · I-11: la salida iba a 5.1.04 «Ajuste de inventario» sin motivo; la merma no tenía cuenta
--     propia, y el consumo propio, el regalo, la donación y la muestra no causaban débito fiscal.
--   · I-12 / P-10: `low_stock_products` unía `stock_balances` en `lot_id is null` (un producto por
--     lotes contaba cero) y no miraba el estado del producto (contaba los inactivos).
--
-- LA DECISIÓN, en el esquema:
--   1. `inventory_moves.exit_reason`: columna NUEVA, nullable, con CHECK de lista cerrada y solo en
--      salidas. Los movimientos viejos no se tocan (append-only, R4): nacen todos con NULL, que el
--      CHECK admite. `reason` (texto libre del ajuste y la revaluación) queda como estaba;
--   2. dos papeles y dos cuentas nuevas en ve_basico y en los planes ya importados:
--      5.1.08 «Pérdidas por mermas y faltantes de inventario» (inventory_shrinkage) y
--      5.1.09 «Retiros de inventario (uso propio, obsequios, donaciones y muestras)»
--      (inventory_withdrawal). VALIDAR-CONTABLE: el contador confirma los códigos;
--   3. dos hechos nuevos del preset, SIN tocar el vocabulario de source_kind (siguen siendo
--      `inventory_move`): `stock.shrinkage` (merma, rotura, vencido, faltante) y `stock.withdrawn`
--      (retiro: costo al gasto de retiros y el débito fiscal contra el mismo gasto). Las empresas
--      que ya importaron el preset los reciben con vigencia desde siempre (ADR-0055);
--   4. `public.inventory_withdrawal_notes`: la Nota de retiro, append-only, con correlativo por
--      empresa asignado por trigger bajo bloqueo, fechada con el instante del movimiento (el mismo
--      día que su asiento), valor de mercado y alícuota congelados;
--   5. el libro de ventas (`sales_book`, `sales_book_by_rate`, `sales_book_summary`) y la
--      declaración (`recompute_iva_period`) leen las notas como venta a la propia empresa. Cada una
--      parte de su definición VIVA (citada en su bloque) y solo AÑADE la rama de las notas;
--   6. `low_stock_products` suma todos los lotes y excluye lo que no está activo.
--
-- REVERSIBILIDAD (con datos vivos):
--   · la columna `exit_reason` y su CHECK: aditivos; con salidas ya registradas NO se borra la
--     columna (es historia del kardex, append-only): se deja de escribir;
--   · cuentas, papeles y plantillas: se desactivan con versión nueva; con asientos encima no se
--     borran — se reclasifica con contra-asiento;
--   · las Notas de retiro emitidas NO se borran (documento interno numerado que ya está en un
--     libro): si una sobra, se compensa con asiento y nota del contador;
--   · las funciones del libro, la declaración y `low_stock_products`: `create or replace` con la
--     definición anterior (citada en cada bloque). Con notas emitidas, volver a la anterior las
--     saca del libro sin borrarlas: el mayor seguiría con su débito y `book_ledger_reconciliation`
--     lo señalaría. Por eso revertir las funciones exige antes decidir qué pasa con las notas.
-- =============================================================================

-- ── 1. El motivo de la salida: columna con CHECK (I-01) ─────────────────────
alter table public.inventory_moves add column exit_reason text;
alter table public.inventory_moves add constraint inventory_moves_exit_reason_chk
  check (exit_reason is null
         or (kind = 'salida'
             and exit_reason in ('merma', 'rotura', 'vencido', 'faltante',
                                 'consumo_propio', 'regalo', 'donacion', 'muestra')));
comment on column public.inventory_moves.exit_reason is
  'Motivo de una salida con motivo (ADR-0078 §2): merma, rotura, vencido y faltante son pérdida '
  '(5.1.08); consumo_propio, regalo, donacion y muestra son retiro (LIVA art. 4.3, Nota de retiro '
  'en una empresa que factura). NULL en toda salida anterior a 20261003110000 y en las salidas '
  'de un documento (venta, receta).';

-- ── 2. Papeles y cuentas ─────────────────────────────────────────────────────
insert into public.account_purposes (code, name, description) values
  ('inventory_shrinkage', 'Pérdidas por mermas y faltantes de inventario',
   'Gasto operativo de las salidas por merma, rotura, vencimiento o faltante justificado (RLIVA art. 14: con motivo y evidencia). No es costo de ventas. VALIDAR-CONTABLE.'),
  ('inventory_withdrawal', 'Retiros de inventario',
   'Gasto de los retiros (LIVA art. 4.3): consumo propio, obsequios, donaciones y muestras, a su costo, más el débito fiscal que el retiro causa. VALIDAR-CONTABLE.')
on conflict (code) do nothing;

insert into public.chart_template_accounts
  (template_code, code, name, parent_code, kind, nature, is_leaf, level, suggested_purpose)
values
  ('ve_basico', '5.1.08', 'Pérdidas por mermas y faltantes de inventario', '5.1', 'gasto',
   'deudora', true, 3, 'inventory_shrinkage'),
  ('ve_basico', '5.1.09', 'Retiros de inventario (uso propio, obsequios, donaciones y muestras)',
   '5.1', 'gasto', 'deudora', true, 3, 'inventory_withdrawal')
on conflict (template_code, code) do nothing;

-- ── 3. Los hechos nuevos del preset ─────────────────────────────────────────
do $$
declare
  v_entry uuid;
begin
  insert into public.journal_template_preset_entries (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'inventory_move', 'stock.shrinkage',
          'Salida por merma, rotura, vencimiento o faltante: pérdida del período contra inventario')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'inventory_shrinkage', 'functional_amount', 'debit', 'if_negative',
     'Lo que se perdió, al costo con que salió del kardex'),
    (v_entry, 2, 'inventory_general', 'functional_amount', 'credit', 'if_negative',
     'y sale del inventario');

  insert into public.journal_template_preset_entries (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'inventory_move', 'stock.withdrawn',
          'Retiro (consumo propio, regalo, donación, muestra): costo a retiros y débito fiscal del retiro')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'inventory_withdrawal', 'cost_amount', 'debit', 'always',
     'El costo de lo retirado'),
    (v_entry, 2, 'inventory_general', 'cost_amount', 'credit', 'always',
     'sale del inventario'),
    (v_entry, 3, 'inventory_withdrawal', 'tax_amount', 'debit', 'always',
     'El IVA del retiro, que la empresa se cobra a sí misma, es gasto del retiro'),
    (v_entry, 4, 'iva_debit_fiscal', 'tax_amount', 'credit', 'always',
     'Débito fiscal sobre el valor de mercado (LIVA art. 4.3). Cero en una empresa sin RIF');
end $$;

-- ── 4. Las empresas que YA tienen plan y preset ─────────────────────────────
do $$
declare
  v_c record;
  v_n record;
  v_e record;
  v_padre uuid;
  v_cuenta uuid;
  v_tpl uuid;
  v_ahora timestamptz := now();
begin
  for v_c in
    select distinct s.company_id, s.tenant_id
      from public.company_account_settings s
     where s.purpose = 'inventory_general'
  loop
    for v_n in
      select a.code, a.name, a.parent_code, a.kind, a.nature, a.suggested_purpose
        from public.chart_template_accounts a
       where a.template_code = 've_basico'
         and a.suggested_purpose in ('inventory_shrinkage', 'inventory_withdrawal')
    loop
      continue when exists (select 1 from public.company_account_settings s
                             where s.company_id = v_c.company_id
                               and s.purpose = v_n.suggested_purpose);
      select id into v_padre from public.accounts
       where company_id = v_c.company_id and code = v_n.parent_code;
      continue when v_padre is null
                 or exists (select 1 from public.accounts
                             where company_id = v_c.company_id and code = v_n.code);
      insert into public.accounts
        (tenant_id, company_id, code, name, parent_id, kind, nature, rules_version)
      values (v_c.tenant_id, v_c.company_id, v_n.code, v_n.name, v_padre, v_n.kind, v_n.nature,
              'db-migration')
      returning id into v_cuenta;
      insert into public.company_account_settings
        (tenant_id, company_id, purpose, account_id, effective_from)
      values (v_c.tenant_id, v_c.company_id, v_n.suggested_purpose, v_cuenta, '-infinity');
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      values (v_c.tenant_id, v_c.company_id, 'company', v_c.company_id,
              'accounting.account_added', 'system', v_ahora, 'db-migration',
              jsonb_build_object('origin', 'migration_20261003110000', 'code', v_n.code,
                                 'purpose', v_n.suggested_purpose, 'account_id', v_cuenta));
    end loop;
  end loop;

  for v_c in select distinct t.company_id, t.tenant_id from public.journal_templates t loop
    for v_e in
      select e.id, e.source_kind, e.source_event, e.description
        from public.journal_template_preset_entries e
       where e.preset_code = 've_basico' and e.source_kind = 'inventory_move'
         and e.source_event in ('stock.shrinkage', 'stock.withdrawn')
    loop
      continue when exists (select 1 from public.journal_templates t
                             where t.company_id = v_c.company_id
                               and t.source_kind = v_e.source_kind
                               and t.source_event = v_e.source_event);
      insert into public.journal_templates
        (tenant_id, company_id, source_kind, source_event, description, effective_from)
      values (v_c.tenant_id, v_c.company_id, v_e.source_kind, v_e.source_event, v_e.description,
              '-infinity')
      returning id into v_tpl;
      insert into public.journal_template_lines
        (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
         side, condition_kind, description)
      select v_c.tenant_id, v_c.company_id, v_tpl, l.line_number, l.account_purpose,
             l.amount_source, l.side, l.condition_kind, l.description
        from public.journal_template_preset_lines l where l.entry_id = v_e.id order by l.line_number;
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      values (v_c.tenant_id, v_c.company_id, 'company', v_c.company_id,
              'accounting.templates_imported', 'system', v_ahora, 'db-migration',
              jsonb_build_object('origin', 'migration_20261003110000', 'preset_code', 've_basico',
                                 'source_kind', v_e.source_kind, 'source_event', v_e.source_event,
                                 'template_id', v_tpl));
    end loop;
  end loop;
end $$;

-- ── 5. La Nota de retiro ────────────────────────────────────────────────────
create table public.inventory_withdrawal_notes (
  id                    uuid primary key default platform.uuidv7(),
  tenant_id             uuid not null references public.tenants(id) on delete restrict,
  company_id            uuid not null,
  note_number           bigint not null,
  issued_at             timestamptz not null default now(),
  move_id               uuid not null references public.inventory_moves(id) on delete restrict,
  warehouse_id          uuid not null,
  product_id            uuid not null,
  quantity              numeric(24,8) not null,
  exit_reason           text not null,
  price_list_id         uuid not null,
  list_unit_price       numeric(24,8) not null,
  list_currency         text not null,
  fx_rate               numeric(24,8) not null,
  rate_source           text not null,
  base_functional       numeric(24,8) not null,
  tax_category_snapshot text not null,
  tax_treatment         text,
  tax_rule_id           uuid,
  tax_rate_snapshot     numeric(24,8) not null,
  tax_functional        numeric(24,8) not null,
  functional_currency   text not null,
  rules_version         text not null,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  version               bigint not null default 1,
  constraint inventory_withdrawal_notes_company_fk
    foreign key (tenant_id, company_id) references public.companies(tenant_id, id),
  constraint inventory_withdrawal_notes_number_key unique (company_id, note_number),
  constraint inventory_withdrawal_notes_move_key unique (move_id),
  constraint inventory_withdrawal_notes_reason_chk
    check (exit_reason in ('consumo_propio', 'regalo', 'donacion', 'muestra')),
  constraint inventory_withdrawal_notes_amounts_chk
    check (quantity > 0 and list_unit_price >= 0 and fx_rate > 0 and base_functional >= 0
           and tax_functional >= 0 and tax_rate_snapshot >= 0),
  constraint inventory_withdrawal_notes_rules_version_chk
    check (length(rules_version) between 1 and 64)
);
comment on table public.inventory_withdrawal_notes is
  'Nota de retiro (ADR-0078 §3, LIVA art. 4.3): documento INTERNO numerado por empresa que lleva '
  'al libro de ventas el retiro de mercancía (consumo propio, regalo, donación, muestra) como '
  'venta a la propia empresa, con débito fiscal sobre el valor de mercado. No consume número de '
  'control de la imprenta. Append-only. Valor de mercado = precio de la lista detal vigente '
  '(decidido por criterio; alternativa: el costo, VALIDAR-TRIBUTARIO).';
create index on public.inventory_withdrawal_notes (company_id, issued_at);
create index on public.inventory_withdrawal_notes (tenant_id, company_id);

-- El correlativo y la fecha los pone la base, nunca el cliente: bajo un bloqueo por empresa, el
-- siguiente número; la fecha es la del movimiento, para que la nota y su asiento caigan el mismo
-- día (el libro y el mayor se comparan por período). Y la nota solo nace de una salida de ESTA
-- empresa con ESE motivo de retiro.
create function platform.assign_withdrawal_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mov record;
begin
  select m.company_id, m.occurred_at, m.kind, m.exit_reason into v_mov
    from public.inventory_moves m where m.id = new.move_id;
  if v_mov.company_id is distinct from new.company_id
     or v_mov.kind is distinct from 'salida'
     or v_mov.exit_reason is distinct from new.exit_reason then
    raise exception 'la nota de retiro no corresponde a una salida con ese motivo de esta empresa'
      using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtext('ladino.withdrawal_note'), hashtext(new.company_id::text));
  select coalesce(max(n.note_number), 0) + 1 into new.note_number
    from public.inventory_withdrawal_notes n where n.company_id = new.company_id;
  new.issued_at := v_mov.occurred_at;
  return new;
end;
$$;
revoke execute on function platform.assign_withdrawal_note() from public, anon, authenticated;

create trigger inventory_withdrawal_notes_00_provenance
  before insert or update on public.inventory_withdrawal_notes
  for each row execute function platform.set_row_provenance();
create trigger inventory_withdrawal_notes_10_number
  before insert on public.inventory_withdrawal_notes
  for each row execute function platform.assign_withdrawal_note();
create trigger inventory_withdrawal_notes_anchors
  before update on public.inventory_withdrawal_notes
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger inventory_withdrawal_notes_append_only
  before update or delete on public.inventory_withdrawal_notes
  for each row execute function platform.reject_mutation();
create trigger inventory_withdrawal_notes_no_truncate
  before truncate on public.inventory_withdrawal_notes
  for each statement execute function platform.reject_mutation();

alter table public.inventory_withdrawal_notes enable row level security;
alter table public.inventory_withdrawal_notes force row level security;
grant select on public.inventory_withdrawal_notes to authenticated;
grant select, insert on public.inventory_withdrawal_notes to ladino_api;
create policy inventory_withdrawal_notes_select on public.inventory_withdrawal_notes
  for select to authenticated using (company_id in (select platform.ladino_company_ids()));
create policy inventory_withdrawal_notes_insert on public.inventory_withdrawal_notes
  for insert to authenticated with check (false);
create policy inventory_withdrawal_notes_update on public.inventory_withdrawal_notes
  for update to authenticated using (false);
create policy inventory_withdrawal_notes_delete on public.inventory_withdrawal_notes
  for delete to authenticated using (false);
create policy inventory_withdrawal_notes_api_select on public.inventory_withdrawal_notes
  for select to ladino_api using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy inventory_withdrawal_notes_api_insert on public.inventory_withdrawal_notes
  for insert to ladino_api with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy inventory_withdrawal_notes_api_update on public.inventory_withdrawal_notes
  for update to ladino_api using (false);
create policy inventory_withdrawal_notes_api_delete on public.inventory_withdrawal_notes
  for delete to ladino_api using (false);

-- ── 6. «Por agotarse»: todos los lotes, solo lo activo (I-12, P-10) ─────────
-- Definición viva: 20260826222915 (la única). Cambia la unión con `stock_balances` (suma de todas
-- las posiciones del producto en el depósito, con lote o sin él) y excluye lo que no está activo.
create or replace function platform.low_stock_products(p_company uuid, p_warehouse uuid default null)
returns table (warehouse_id uuid, product_id uuid, quantity numeric, stock_min numeric,
               stock_max numeric, missing numeric)
language sql
stable
set search_path = ''
as $$
  select t.warehouse_id, t.product_id, coalesce(b.q, 0),
         t.stock_min, t.stock_max,
         t.stock_min - coalesce(b.q, 0)
    from public.product_stock_thresholds t
    join public.products p
      on p.id = t.product_id and p.company_id = t.company_id and p.status = 'active'
    left join lateral (
      select sum(sb.quantity) as q from public.stock_balances sb
       where sb.warehouse_id = t.warehouse_id and sb.product_id = t.product_id
    ) b on true
   where t.company_id = p_company
     and (p_warehouse is null or t.warehouse_id = p_warehouse)
     and coalesce(b.q, 0) < t.stock_min
   order by (t.stock_min - coalesce(b.q, 0)) desc;
$$;
comment on function platform.low_stock_products(uuid, uuid) is
  'Productos ACTIVOS por debajo de su mínimo en un depósito, con la existencia TOTAL (todas las '
  'posiciones, con lote o sin él). Desde 20261003110000 (I-12, P-10).';

-- ── 7. El libro de ventas lee la Nota de retiro ──
-- Definición VIVA: 20261002120300_the_igtf_note_is_known_by_its_system_mark.sql §3 (sales_book). Solo se AÑADE la rama de las Notas de retiro.
CREATE OR REPLACE FUNCTION platform.sales_book(p_company uuid, p_from date, p_to date)
 RETURNS TABLE(document_id uuid, issued_on date, kind text, series text, document_number bigint, control_number bigint, status text, customer_tax_id text, customer_name text, customer_taxpayer_type text, transaction_currency text, fx_rate numeric, base_gravada numeric, iva_debito numeric, base_exenta numeric, base_exonerada numeric, base_no_sujeta numeric, base_sin_clasificar numeric, total_amount numeric, journal_entry_id uuid, igtf_percibido numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select x.* from (
  -- Definición viva de 20260928170200 §3 (signo R-1, anulada en cero G-10, adquirente por el
  -- snapshot del nombre B1/B3), más H1 (20261002120200): la línea de la ND por IGTF (producto de
  -- sistema LADINO-IGTF) no suma en ninguna base ni en el total de venta; su monto va a
  -- `igtf_percibido`. El renglón se conserva con su número, control y estado: el correlativo se
  -- consumió y el libro lo registra. VALIDAR-TRIBUTARIO P-70.
  select d.id, platform.caracas_day(d.issued_at), d.kind, d.series, d.document_number,
         d.control_number, d.status,
         case when d.customer_name_snapshot is not null then d.customer_tax_id_snapshot
              else c.tax_id end,
         coalesce(d.customer_name_snapshot, c.legal_name),
         case when d.customer_name_snapshot is not null then d.customer_taxpayer_type_snapshot
              else c.taxpayer_type_code end,
         d.transaction_currency, d.fx_rate,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'gravado'
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         d.tax_amount * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'exento'
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'exonerado'
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'no_sujeto'
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment is null
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         -- La ND por IGTF tiene una sola línea, la del IGTF: su total de VENTA es cero.
         case when coalesce(bool_and(pr.system_code = 'igtf'), false) then 0
              else d.total_amount end * f.factor,
         d.journal_entry_id,
         coalesce(sum(dl.line_total_functional) filter (where pr.system_code = 'igtf'), 0)
           * f.factor
    from public.documents d
    cross join lateral (
      select case when d.status = 'annulled' then 0
                  when d.kind = 'credit_note' then -1
                  else 1 end as factor
    ) f
    join public.customers c on c.id = d.customer_id
    left join public.document_lines dl on dl.document_id = d.id
    left join public.products pr on pr.id = dl.product_id
   where d.company_id = p_company
     and d.kind in ('invoice', 'credit_note', 'debit_note')
     and d.status in ('issued', 'paid', 'annulled')
     and platform.caracas_day(d.issued_at) between p_from and p_to
   group by d.id, f.factor, c.tax_id, c.legal_name, c.taxpayer_type_code
  union all
  -- 20261003110000 (ADR-0078 §3): la Nota de retiro, venta a la propia empresa (LIVA art. 4.3).
  -- Documento interno: sin número de control; el adquirente es la empresa misma.
  select n.id, platform.caracas_day(n.issued_at), 'withdrawal_note'::text, 'NR'::text,
         n.note_number, null::bigint, 'issued'::text,
         co.tax_id, co.legal_name, co.taxpayer_type_code,
         n.functional_currency, 1::numeric,
         case when n.tax_treatment = 'gravado' then n.base_functional else 0 end,
         n.tax_functional,
         case when n.tax_treatment = 'exento' then n.base_functional else 0 end,
         case when n.tax_treatment = 'exonerado' then n.base_functional else 0 end,
         case when n.tax_treatment = 'no_sujeto' then n.base_functional else 0 end,
         case when n.tax_treatment is null then n.base_functional else 0 end,
         n.base_functional + n.tax_functional,
         (select e.id from public.journal_entries e
           where e.company_id = n.company_id and e.source_kind = 'inventory_move'
             and e.source_id = n.move_id and e.source_event = 'stock.withdrawn'
             and e.status = 'posted'
           limit 1),
         0::numeric
    from public.inventory_withdrawal_notes n
    join public.companies co on co.id = n.company_id
   where n.company_id = p_company
     and platform.caracas_day(n.issued_at) between p_from and p_to
  ) x (document_id, issued_on, kind, series, document_number, control_number, status,
       customer_tax_id, customer_name, customer_taxpayer_type, transaction_currency, fx_rate,
       base_gravada, iva_debito, base_exenta, base_exonerada, base_no_sujeta, base_sin_clasificar,
       total_amount, journal_entry_id, igtf_percibido)
   order by coalesce((select d.issued_at from public.documents d where d.id = x.document_id),
                     (select n.issued_at from public.inventory_withdrawal_notes n
                       where n.id = x.document_id)),
            x.series, x.document_number
$function$;

-- ── 8. El libro por alícuota ──
-- Definición VIVA: 20261002120300_the_igtf_note_is_known_by_its_system_mark.sql (sales_book_by_rate). Solo se AÑADE la rama de las Notas de retiro.
CREATE OR REPLACE FUNCTION platform.sales_book_by_rate(p_company uuid, p_from date, p_to date)
 RETURNS TABLE(document_id uuid, issued_on date, kind text, series text, document_number bigint, control_number bigint, status text, customer_tax_id text, customer_name text, customer_taxpayer_type text, transaction_currency text, fx_rate numeric, base_gravada numeric, iva_debito numeric, base_exenta numeric, base_exonerada numeric, base_no_sujeta numeric, base_sin_clasificar numeric, total_amount numeric, journal_entry_id uuid, base_alicuota_general numeric, iva_alicuota_general numeric, alicuota_general numeric, base_alicuota_adicional numeric, iva_alicuota_adicional numeric, alicuota_adicional numeric, base_alicuota_reducida numeric, iva_alicuota_reducida numeric, alicuota_reducida numeric, base_gravada_sin_alicuota numeric, iva_sin_clasificar numeric, control_identifier text, igtf_percibido numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  -- Definición viva de 20260928170300 §3, más `igtf_percibido` (H1, 20261002120200). La línea de
  -- la ND por IGTF es no sujeta: no cae en ninguna alícuota, y su impuesto es cero.
  select s.document_id, s.issued_on, s.kind, s.series, s.document_number, s.control_number,
         s.status, s.customer_tax_id, s.customer_name, s.customer_taxpayer_type,
         s.transaction_currency, s.fx_rate, s.base_gravada, s.iva_debito, s.base_exenta,
         s.base_exonerada, s.base_no_sujeta, s.base_sin_clasificar, s.total_amount,
         s.journal_entry_id,
         r.base_g, r.iva_g, r.rate_g, r.base_a, r.iva_a, r.rate_a, r.base_r, r.iva_r, r.rate_r,
         r.base_x, r.iva_x,
         (select d.control_identifier from public.documents d where d.id = s.document_id),
         s.igtf_percibido
    from platform.sales_book(p_company, p_from, p_to) with ordinality as s
    cross join lateral (
      select case when s.status = 'annulled' then 0
                  when s.kind = 'credit_note' then -1 else 1 end as factor
    ) f
    cross join lateral (
      select
        coalesce(sum(dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_general'), 0) * f.factor as base_g,
        coalesce(sum(dl.line_total_functional - dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_general'), 0) * f.factor as iva_g,
        max(dl.tax_rate_snapshot) filter (where dl.tax_category_snapshot = 'gravado_general') as rate_g,
        coalesce(sum(dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_adicional'), 0) * f.factor as base_a,
        coalesce(sum(dl.line_total_functional - dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_adicional'), 0) * f.factor as iva_a,
        max(dl.tax_rate_snapshot) filter (where dl.tax_category_snapshot = 'gravado_adicional') as rate_a,
        coalesce(sum(dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_reducida'), 0) * f.factor as base_r,
        coalesce(sum(dl.line_total_functional - dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_reducida'), 0) * f.factor as iva_r,
        max(dl.tax_rate_snapshot) filter (where dl.tax_category_snapshot = 'gravado_reducida') as rate_r,
        coalesce(sum(dl.line_subtotal_functional)
                 filter (where dl.tax_treatment = 'gravado'
                           and dl.tax_category_snapshot is distinct from 'gravado_general'
                           and dl.tax_category_snapshot is distinct from 'gravado_adicional'
                           and dl.tax_category_snapshot is distinct from 'gravado_reducida'), 0)
          * f.factor as base_x,
        coalesce(sum(dl.line_total_functional - dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot is null
                           or dl.tax_category_snapshot not in
                              ('gravado_general', 'gravado_adicional', 'gravado_reducida')), 0)
          * f.factor as iva_x
        -- 20261003110000: la Nota de retiro es un renglón con la misma forma que una línea.
        from (select l.tax_category_snapshot, l.tax_treatment, l.tax_rate_snapshot,
                     l.line_subtotal_functional, l.line_total_functional
                from public.document_lines l
               where l.document_id = s.document_id
              union all
              select n.tax_category_snapshot, n.tax_treatment, n.tax_rate_snapshot,
                     n.base_functional, n.base_functional + n.tax_functional
                from public.inventory_withdrawal_notes n
               where n.id = s.document_id) dl
    ) r
   order by s.ordinality
$function$;

-- ── 9. El resumen del libro (art. 72) ──
-- Definición VIVA: 20261002120300_the_igtf_note_is_known_by_its_system_mark.sql (sales_book_summary). Solo se AÑADE la rama de las Notas de retiro.
CREATE OR REPLACE FUNCTION platform.sales_book_summary(p_company uuid, p_from date, p_to date)
 RETURNS TABLE(concept text, rate numeric, base numeric, tax numeric, adjustments_base numeric, adjustments_tax numeric, documents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  -- Definición viva de 20260928150000 §7. H1 (20261002120200): la línea de la ND por IGTF no es
  -- una venta no sujeta y no entra en el resumen (VALIDAR-TRIBUTARIO P-70).
  select x.concept, x.rate, sum(x.base), sum(x.tax),
         coalesce(sum(x.base) filter (where x.kind not in ('invoice', 'withdrawal_note')), 0),
         coalesce(sum(x.tax) filter (where x.kind not in ('invoice', 'withdrawal_note')), 0),
         count(distinct x.doc)
    from (
      select case when dl.tax_treatment = 'gravado'
                    then coalesce(dl.tax_category_snapshot, 'gravado')
                  when dl.tax_treatment is null then 'sin_clasificar'
                  else dl.tax_treatment end as concept,
             case when dl.tax_treatment = 'gravado' then dl.tax_rate_snapshot end as rate,
             dl.line_subtotal_functional * f.factor as base,
             (dl.line_total_functional - dl.line_subtotal_functional) * f.factor as tax,
             d.kind, d.id as doc
        from public.documents d
        join public.document_lines dl on dl.document_id = d.id
        cross join lateral (
          select case when d.kind = 'credit_note' then -1 else 1 end as factor) f
       where d.company_id = p_company
         and d.kind in ('invoice', 'credit_note', 'debit_note')
         and d.status in ('issued', 'paid')
         and platform.caracas_day(d.issued_at) between p_from and p_to
         and not exists (select 1 from public.products pr
                          where pr.id = dl.product_id and pr.system_code = 'igtf')
      union all
      -- 20261003110000: la Nota de retiro es venta (no ajuste) a la propia empresa.
      select case when n.tax_treatment = 'gravado'
                    then coalesce(n.tax_category_snapshot, 'gravado')
                  when n.tax_treatment is null then 'sin_clasificar'
                  else n.tax_treatment end,
             case when n.tax_treatment = 'gravado' then n.tax_rate_snapshot end,
             n.base_functional, n.tax_functional, 'withdrawal_note'::text, n.id
        from public.inventory_withdrawal_notes n
       where n.company_id = p_company
         and platform.caracas_day(n.issued_at) between p_from and p_to
    ) x
   group by x.concept, x.rate
   order by case x.concept when 'gravado_general' then 1 when 'gravado_adicional' then 2
                           when 'gravado_reducida' then 3 when 'exento' then 4
                           when 'exonerado' then 5 when 'no_sujeto' then 6 else 7 end,
            x.rate
$function$;

-- ── 10. La declaración de IVA ──
-- Definición VIVA: 20261002120400_a_preview_does_not_declare_the_period.sql (recompute_iva_period). Solo se AÑADE la rama de las Notas de retiro.
CREATE OR REPLACE FUNCTION platform.recompute_iva_period(p_company uuid, p_from date, p_to date, p_excedente_anterior numeric, p_retenciones_anteriores numeric DEFAULT 0)
 RETURNS TABLE(debitos numeric, creditos numeric, creditos_deducibles numeric, prorrata_pct numeric, retenciones_soportadas numeric, cuota_a_pagar numeric, excedente_siguiente numeric, detalle jsonb, ajuste_creditos_anteriores numeric, retenciones_acumuladas_por_descontar numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with ventas as (
    -- TODO en moneda funcional: la base es el subtotal funcional del renglón y el
    -- impuesto es total − subtotal funcionales, la misma derivación con la que el
    -- documento congela su IVA y el mayor lo asienta (sales.ts, insertarDocumento).
    -- `tax_amount` del renglón está en la moneda de la TRANSACCIÓN: sumarlo
    -- declaraba dólares como bolívares (QA 2026-09-15, h. 63).
    select case d.kind when 'credit_note' then -1 else 1 end as signo,
           l.tax_rate_snapshot as alicuota,
           l.line_subtotal_functional as base,
           (l.line_total_functional - l.line_subtotal_functional) as impuesto,
           l.tax_amount as impuesto_transaccion,
           d.kind
      from public.documents d
      join public.document_lines l on l.document_id = d.id
     where d.company_id = p_company
       and d.kind in ('invoice', 'credit_note', 'debit_note')
       and d.status in ('issued', 'paid')
       and (d.issued_at at time zone 'America/Caracas')::date between p_from and p_to
       -- H1 (20261002120200; PA SNAT/2022/000013 arts. 5-6, LIVA art. 34): la línea de la ND por
       -- IGTF (producto de sistema LADINO-IGTF) NO es una venta: ni débito, ni base, ni «sin
       -- impuesto» que active la prorrata. VALIDAR-TRIBUTARIO P-70.
       and not exists (select 1 from public.products pr
                        where pr.id = l.product_id and pr.system_code = 'igtf')
    union all
    -- 20261003110000 (ADR-0078 §3, LIVA art. 4.3): el débito fiscal del retiro, por su alícuota.
    select 1, n.tax_rate_snapshot, n.base_functional, n.tax_functional, n.tax_functional,
           'withdrawal_note'::text
      from public.inventory_withdrawal_notes n
     where n.company_id = p_company
       and (n.issued_at at time zone 'America/Caracas')::date between p_from and p_to
  ),
  por_alicuota as (
    select alicuota,
           sum(signo * base) as base,
           sum(signo * impuesto) as impuesto
      from ventas group by alicuota
  ),
  deb as (select coalesce(sum(impuesto), 0) as total from por_alicuota),
  bases_venta as (
    select coalesce(sum(signo * base) filter (where impuesto_transaccion <> 0), 0) as gravadas,
           coalesce(sum(signo * base) filter (where impuesto_transaccion = 0), 0) as sin_impuesto
      from ventas
  ),
  cred as (
    -- El IVA de la factura de proveedor, a la tasa con la que se asentó, MENOS el de las NOTAS
    -- DE CRÉDITO recibidas en el período. LIVA art. 37: el impuesto de la operación
    -- posteriormente anulada se deduce del crédito fiscal; art. 56: se registran las notas que
    -- se emitan o RECIBAN. El período es el de la NOTA, no el de la factura que corrige.
    -- La anulada DESPUÉS de cerrar y presentar su período sigue contando en él: esa planilla
    -- no cambia (R-2 ampliada); su reversa va en `ajuste` del período de la anulación.
    select coalesce((select sum(round(i.tax_amount * i.fx_rate, 8))
                       from public.supplier_invoices i
                      where i.company_id = p_company
                        and (i.status in ('posted', 'paid')
                             or (i.status = 'annulled'
                                 and platform.supplier_invoice_late_annulment_day(
                                       i.company_id, coalesce(i.accounting_date, i.invoice_date),
                                       i.annulled_at) is not null))
                        and i.tax_is_recoverable
                        -- ADR-0069 §4: la recibida con retraso, en su período de REGISTRO.
                        -- Sin ventana de LIVA art. 33 (P-35, pendiente de fuente).
                        and coalesce(i.accounting_date, i.invoice_date)
                              between p_from and p_to), 0)
         - coalesce((select sum(round(n.tax_amount * n.fx_rate, 8))
                       from public.supplier_credit_notes n
                       join public.supplier_invoices i on i.id = n.supplier_invoice_id
                      where n.company_id = p_company
                        and n.status = 'posted'
                        and i.tax_is_recoverable
                        and coalesce(n.accounting_date, n.note_date)
                              between p_from and p_to), 0) as total
  ),
  ajuste as (
    -- Casilla de AJUSTES A LOS CRÉDITOS FISCALES DE PERÍODOS ANTERIORES: la reversa del crédito
    -- de las facturas anuladas tarde, en el período (día de Caracas) de la anulación.
    select -coalesce(sum(round(i.tax_amount * i.fx_rate, 8)), 0) as total
      from public.supplier_invoices i
     where i.company_id = p_company
       and i.status = 'annulled'
       and i.tax_is_recoverable
       and platform.supplier_invoice_late_annulment_day(
             i.company_id, coalesce(i.accounting_date, i.invoice_date), i.annulled_at)
           between p_from and p_to
  ),
  ret as (
    -- L-04: la retención soportada, en el período (quincena o mes) de la FECHA DEL COMPROBANTE.
    -- H4 (20261002120200; PA SNAT/2025/000054 art. 7): si ese período ya estaba DECLARADO cuando
    -- se entregó el comprobante (una generación que lo cubre, creada el día de la entrega o antes),
    -- la retención va al período de la ENTREGA. Sin fecha de entrega, la de la retención: nada
    -- cambia para lo cargado antes. Granularidad: día contra día (caracas_day de la generación
    -- contra la fecha de entrega). VALIDAR-TRIBUTARIO P-68.
    select coalesce(sum(r.amount), 0) as total
      from public.supported_retention_receipts r
     where r.company_id = p_company and r.status = 'registered'
       and case when exists (
                  select 1 from public.iva_period_results p
                   where p.company_id = r.company_id
                     and r.retained_on between p.period_from and p.period_to
                     -- B-1 (20261002120400): solo una generación hecha DESPUÉS de cerrar su
                     -- período declara; una vista previa a mitad de quincena, o la de un período
                     -- futuro, no. Día contra día (caracas_day de la generación).
                     and p.period_to < platform.caracas_day(p.created_at)
                     and platform.caracas_day(p.created_at)
                           <= coalesce(r.received_on, r.retained_on))
                then coalesce(r.received_on, r.retained_on)
                else r.retained_on end
           between p_from and p_to
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
    -- El ajuste NO pasa por la prorrata del período en curso: corrige un crédito que ya se
    -- dedujo con la prorrata de SU período (VALIDAR-TRIBUTARIO P-46). Y NO se suma en
    -- `deducibles`: esa columna es el crédito del PERÍODO tras la prorrata, que nunca es
    -- negativo (CHECK ipr_amounts_chk). El ajuste va en su casilla y entra en la cuota.
    select d.total as debitos,
           c.total as creditos,
           case when p.pct is null then c.total
                else round(c.total * p.pct, 8) end as deducibles,
           p.pct, r.total as retenciones, a.total as ajuste
      from deb d, cred c, ret r, prorrata p, ajuste a
  ),
  neto as (
    -- L-05 · LOS DOS ARRASTRES DE LA FORMA 00030. Primero el impuesto: débitos − créditos
    -- (con su ajuste) − excedente de CRÉDITO anterior. Si es negativo, ESE es el excedente de
    -- crédito fiscal que pasa. Después las retenciones (las acumuladas que llegan + las del
    -- período) se descuentan SOLO de la cuota positiva; lo que no absorbe pasa aparte, como
    -- retenciones acumuladas por descontar. Una retención nunca se convierte en crédito fiscal
    -- (PA SNAT/2025/000054 arts. 7 y 8; VALIDAR-TRIBUTARIO P-37).
    select calc.*,
           calc.debitos - (calc.deducibles + calc.ajuste) - p_excedente_anterior as impuesto,
           p_retenciones_anteriores + calc.retenciones as retenciones_disponibles
      from calc
  )
  select
    n.debitos, n.creditos, n.deducibles, n.pct, n.retenciones,
    greatest(0, greatest(0, n.impuesto) - n.retenciones_disponibles) as cuota_a_pagar,
    greatest(0, -n.impuesto) as excedente_siguiente,
    (select coalesce(jsonb_agg(jsonb_build_object(
              'alicuota', a.alicuota::text,
              'base', a.base::text,
              'impuesto', a.impuesto::text) order by a.alicuota), '[]'::jsonb)
       from por_alicuota a) as detalle,
    n.ajuste,
    greatest(0, n.retenciones_disponibles - greatest(0, n.impuesto))
      as retenciones_acumuladas_por_descontar
  from neto n
$function$;

comment on function platform.sales_book(uuid, date, date) is
  'Libro de ventas en MONEDA FUNCIONAL: NC en negativo, ND en positivo (R-1), anulada con su '
  'número e importes en cero (G-10, P-34), adquirente por los snapshots del documento '
  '(20260928170100/170200). Desde 20261002120200 (H1): la ND por IGTF sale con su número y '
  'control, sin importes de venta, y su monto en igtf_percibido (VALIDAR-TRIBUTARIO P-70). Desde '
  '20261003110000: la Nota de retiro (kind withdrawal_note, serie NR, sin control) como venta a la '
  'propia empresa (LIVA art. 4.3, ADR-0078).';


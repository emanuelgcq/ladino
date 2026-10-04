-- =============================================================================
-- Ladino — 20261003110100 · SALIDAS Y RETIROS: arreglos de la revisión (ADR-0078)
--
-- Módulo: inventario · contabilidad · fiscal (RIGOR MÁXIMO)
-- Spec: ADR-0078 (nota de aplicación, revisión) · corrige 20261003110000
-- HOMOLOGATION_IMPACT: YES — el renglón de la Nota de retiro en el libro de ventas pasa a leer el
--   adquirente CONGELADO en la nota; no cambia importes ni numeración.
--
-- QUÉ CORRIGE (revisión de 20261003110000):
--   1. El renglón de la nota en `sales_book` leía el RIF, el nombre y el tipo de contribuyente de
--      `companies` EN VIVO: cambiar el RIF de la empresa reescribía un libro ya generado. La nota
--      congela ahora los tres (`company_*_snapshot`), los rellena el trigger desde `companies`, y
--      el libro lee de ahí. Backfill de las filas existentes (solo hay en bases locales: 110000 no
--      se ha desplegado) con el append-only desactivado DENTRO de esta transacción, y NOT NULL.
--   2. `inventory_moves.exit_evidence` (RLIVA art. 14, §2.13: «faltantes justificados solo si
--      llevan motivo y evidencia»): la salida por merma, rotura, vencido o faltante lleva la
--      referencia de su soporte. CHECK NOT VALID: las salidas anteriores (locales, de prueba) no
--      se tocan; vale para las nuevas.
--   3. El faltante de un CONTEO va a «Pérdidas por mermas y faltantes» (5.1.08), no a 5.1.04: hecho
--      nuevo `inventory_move/stock.counted` (faltante → 5.1.08; sobrante → contra 5.1.04, como el
--      ajuste). Las empresas que ya importaron el preset lo reciben con vigencia desde siempre.
--   4. `platform.withdrawal_note_gaps(company)`: invariante nuevo, respuesta correcta CERO —
--      un retiro sin nota cuando la empresa facturaba en ese instante, y una nota con IVA cuyo
--      asiento no lleva ese IVA al débito fiscal (ni está en cola).
--
-- REVERSIBILIDAD (con datos vivos):
--   · columnas de snapshot y de evidencia: se dejan de escribir; con filas encima no se borran;
--   · `sales_book`: `create or replace` con la definición de 20261003110000 (que lee companies en
--     vivo, el defecto que esto corrige);
--   · `stock.counted`: versión nueva de la plantilla con el mapeo de `stock.adjusted`; los asientos
--     ya generados no se reescriben;
--   · `withdrawal_note_gaps` y el trigger: drop / la definición de 110000.
-- =============================================================================

-- ── 1. El adquirente congelado en la nota ───────────────────────────────────
alter table public.inventory_withdrawal_notes
  add column company_tax_id_snapshot text,
  add column company_name_snapshot text,
  add column company_taxpayer_type_snapshot text;

create or replace function platform.assign_withdrawal_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mov record;
  v_co  record;
begin
  -- Definición de 20261003110000 más el adquirente congelado (revisión, hallazgo 1).
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
  select c.tax_id, c.legal_name, c.taxpayer_type_code into v_co
    from public.companies c where c.id = new.company_id;
  new.company_tax_id_snapshot := v_co.tax_id;
  new.company_name_snapshot := v_co.legal_name;
  new.company_taxpayer_type_snapshot := coalesce(v_co.taxpayer_type_code, 'ordinario');
  return new;
end;
$$;
revoke execute on function platform.assign_withdrawal_note() from public, anon, authenticated;

-- Backfill: solo filas de bases locales (110000 sin desplegar). El append-only se desactiva DENTRO
-- de esta transacción y se reactiva antes de terminarla; nada más puede escribir mientras tanto.
alter table public.inventory_withdrawal_notes disable trigger inventory_withdrawal_notes_append_only;
update public.inventory_withdrawal_notes n
   set company_tax_id_snapshot = c.tax_id,
       company_name_snapshot = c.legal_name,
       company_taxpayer_type_snapshot = coalesce(c.taxpayer_type_code, 'ordinario')
  from public.companies c
 where c.id = n.company_id and n.company_tax_id_snapshot is null;
alter table public.inventory_withdrawal_notes enable trigger inventory_withdrawal_notes_append_only;

alter table public.inventory_withdrawal_notes
  alter column company_tax_id_snapshot set not null,
  alter column company_name_snapshot set not null,
  alter column company_taxpayer_type_snapshot set not null;
comment on column public.inventory_withdrawal_notes.company_tax_id_snapshot is
  'RIF de la empresa (adquirente del retiro) al emitir la nota: el libro de ventas lo lee de aquí, '
  'no de companies, para que un cambio de RIF no reescriba un libro ya generado (20261003110100).';

-- ── 2. La evidencia de la pérdida (RLIVA art. 14) ───────────────────────────
alter table public.inventory_moves add column exit_evidence text;
alter table public.inventory_moves add constraint inventory_moves_exit_evidence_chk
  check ((exit_evidence is null
          or (exit_evidence = btrim(exit_evidence) and length(exit_evidence) between 3 and 500
              and exit_reason in ('merma', 'rotura', 'vencido', 'faltante')))
         and (exit_reason is null
              or exit_reason not in ('merma', 'rotura', 'vencido', 'faltante')
              or exit_evidence is not null))
  not valid;
comment on column public.inventory_moves.exit_evidence is
  'Referencia del soporte de una pérdida (acta, foto, informe): sin ella la merma, la rotura, el '
  'vencido o el faltante no es «faltante justificado» (RLIVA art. 14, ADR-0078). NOT VALID: las '
  'salidas anteriores a 20261003110100 no la tienen.';

-- ── 3. El faltante del conteo va a pérdidas ─────────────────────────────────
do $$
declare
  v_entry uuid;
  v_c record;
  v_tpl uuid;
  v_ahora timestamptz := now();
begin
  insert into public.journal_template_preset_entries (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'inventory_move', 'stock.counted',
          'Conteo: el faltante es pérdida (5.1.08); el sobrante, ajuste de inventario')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'inventory_general', 'functional_amount', 'debit', 'if_positive',
     'Sobró: entra valor al inventario al promedio vigente'),
    (v_entry, 2, 'inventory_adjustment', 'functional_amount', 'credit', 'if_positive',
     'contra ajuste de inventario'),
    (v_entry, 3, 'inventory_shrinkage', 'functional_amount', 'debit', 'if_negative',
     'Faltó: pérdida por faltante, con el motivo del conteo'),
    (v_entry, 4, 'inventory_general', 'functional_amount', 'credit', 'if_negative',
     'y sale del inventario');

  for v_c in select distinct t.company_id, t.tenant_id from public.journal_templates t loop
    continue when exists (select 1 from public.journal_templates t
                           where t.company_id = v_c.company_id
                             and t.source_kind = 'inventory_move'
                             and t.source_event = 'stock.counted');
    insert into public.journal_templates
      (tenant_id, company_id, source_kind, source_event, description, effective_from)
    values (v_c.tenant_id, v_c.company_id, 'inventory_move', 'stock.counted',
            'Conteo: el faltante es pérdida (5.1.08); el sobrante, ajuste de inventario', '-infinity')
    returning id into v_tpl;
    insert into public.journal_template_lines
      (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
       side, condition_kind, description)
    select v_c.tenant_id, v_c.company_id, v_tpl, l.line_number, l.account_purpose,
           l.amount_source, l.side, l.condition_kind, l.description
      from public.journal_template_preset_lines l where l.entry_id = v_entry order by l.line_number;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_c.tenant_id, v_c.company_id, 'company', v_c.company_id,
            'accounting.templates_imported', 'system', v_ahora, 'db-migration',
            jsonb_build_object('origin', 'migration_20261003110100', 'preset_code', 've_basico',
                               'source_kind', 'inventory_move', 'source_event', 'stock.counted',
                               'template_id', v_tpl));
  end loop;
end $$;

-- ── 4. Invariante: retiro ⇒ nota (si facturaba) y nota ⇒ su IVA en el asiento ─
create function platform.withdrawal_note_gaps(p_company uuid)
returns table (move_id uuid, problem text)
language sql
stable
set search_path = ''
as $$
  -- Un retiro (consumo propio, regalo, donación, muestra) de una empresa que FACTURABA en el instante
  -- de la salida tiene su Nota de retiro.
  select m.id, 'retiro_sin_nota'::text
    from public.inventory_moves m
   where m.company_id = p_company and m.kind = 'salida'
     and m.exit_reason in ('consumo_propio', 'regalo', 'donacion', 'muestra')
     and platform.sales_mode_at(p_company, m.occurred_at) = 'facturas'
     and not exists (select 1 from public.inventory_withdrawal_notes n where n.move_id = m.id)
  union all
  -- Y la nota con IVA tiene ese IVA acreditado al débito fiscal en el asiento de su salida, o el
  -- hecho espera en la cola (el libro lo cuenta como «en cola»).
  select n.move_id, 'nota_sin_iva_en_el_asiento'
    from public.inventory_withdrawal_notes n
   where n.company_id = p_company and n.tax_functional <> 0
     and not exists (
       select 1 from public.journal_generation_queue q
        where q.company_id = p_company and q.status = 'pending'
          and q.source_kind = 'inventory_move' and q.source_id = n.move_id
          and q.source_event = 'stock.withdrawn')
     and coalesce((
       select sum(jl.functional_credit - jl.functional_debit)
         from public.journal_entries e
         join public.journal_lines jl on jl.entry_id = e.id
        where e.company_id = p_company and e.status = 'posted'
          and jl.account_id in (select s.account_id from public.company_account_settings s
                                 where s.company_id = p_company
                                   and s.purpose = 'iva_debit_fiscal')
          and e.source_kind = 'inventory_move' and e.source_id = n.move_id
          and e.source_event = 'stock.withdrawn'), 0) <> n.tax_functional
$$;
comment on function platform.withdrawal_note_gaps(uuid) is
  'Invariante (ADR-0078, 20261003110100): retiro ⇒ Nota de retiro si la empresa facturaba en ese '
  'instante, y nota con IVA ⇒ ese IVA en el débito fiscal de su asiento (o en cola). Cero.';
revoke execute on function platform.withdrawal_note_gaps(uuid) from public, anon;
grant execute on function platform.withdrawal_note_gaps(uuid) to authenticated, ladino_api;

-- ── 5. El libro de ventas lee el adquirente congelado ───────────────────────
-- Definición VIVA: 20261003110000 §7 (sales_book). Solo cambia el adquirente de la rama de notas.
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
         -- 20261003110100: el adquirente CONGELADO en la nota, no companies en vivo.
         n.company_tax_id_snapshot, n.company_name_snapshot, n.company_taxpayer_type_snapshot,
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

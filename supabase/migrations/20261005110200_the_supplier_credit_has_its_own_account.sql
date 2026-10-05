-- Módulo: compras · contabilidad   Spec: ADR-0083 (reescrito en §5) · ADR-0065 · ADR-0075 §4
-- Reversible: NO con datos vivos (ver abajo)   Homologación: NO (no cambia el libro ni el IVA)
--
-- Revisión de la familia H-03 (ola 5). Va SIEMPRE con 20261005110000 y 20261005110100, justo
-- después del `git pull` y en ese orden. Corrige una DECISIÓN de la 110000 y dos defectos.
--
-- QUÉ PASABA
--   1. El saldo a favor con un proveedor vivía como cuenta por pagar en NEGATIVO, y
--      `settled_ledger_gaps` lo perdonaba con un «salvo» que leía la cifra que la propia nota
--      declaraba, calculada además desde `settlement_ledger_open` —lo mismo que el invariante
--      lee después—. Nacía verde por construcción, y una factura `paid` con un residuo previo en
--      cuentas por pagar dejaba de dar fila al registrarle una nota mayor. La primera excepción
--      convierte el gate en decoración (CLAUDE.md §3).
--   2. Con el asiento de la nota posteado y su ajuste de kardex en la COLA, los movimientos de
--      la nota salían «duplicated» en `inventory_coverage_gaps` (los dos comparten source_id).
--   3. Una nota podía abonar dos veces la misma línea de factura.
--   4. `is_fiscal` nacía true para toda nota y nada impedía que contradijera a su factura.
--
-- QUÉ HACE
--   1. Papel `supplier_credit_receivable` («Saldos a favor con proveedores», ACTIVO) y su cuenta
--      provisional 1.1.09 en el plan `ve_basico`; las empresas que ya llevan cuentas por pagar la
--      reciben con su acta. VALIDAR-CONTABLE: el código y la presentación (P-104).
--   2. Las dos plantillas de la nota (`ap.credit_note_received` y
--      `ap.expense_credit_note_received`) ganan DOS líneas: débito al saldo a favor y crédito a
--      cuentas por pagar, las dos por `credit_surplus` y solo si no es cero. La cuenta por pagar
--      del documento baja por lo que se debía y queda en 0; el exceso va al activo. Una nota de
--      la API anterior no trae `credit_surplus`: vale 0 y su asiento sale como antes. Empresa
--      sin el papel: la nota con saldo a favor va a la cola diciendo cuál falta.
--   3. REDEFINE `platform.settled_ledger_gaps(uuid)` con su cuerpo ANTERIOR a 20261005110000
--      (el de 20261003170000, recuperado deshaciendo los dos cambios de la 110000 sobre la
--      definición viva): el enunciado de siempre, sin «salvo».
--   4. Invariante NUEVO `platform.supplier_credit_ledger_gap(uuid)`: lo que las notas vigentes
--      declaran a favor = el saldo del mayor en la cuenta de saldos a favor, más la cola.
--   5. REDEFINE `platform.inventory_coverage_gaps(uuid)` y `platform.inventory_ledger_gap(uuid)`
--      (últimas: 20261005110000): el ajuste de kardex de una nota no cuenta como lo que cubre sus
--      movimientos, y su importe pendiente se suma a `en_cola`.
--   6. Único (nota, línea de factura) en `supplier_credit_note_lines`.
--   7. `is_fiscal` se ata a la factura con un trigger que la DERIVA de la factura al insertar: una sola fuente.
--
-- REVERSIBILIDAD, CON DATOS VIVOS
--   · El papel, la cuenta y las líneas de plantilla son aditivos, pero un asiento posteado contra
--     1.1.09 es append-only: la cuenta ya no se quita y devolver el saldo a cuentas por pagar
--     exige un asiento de reclasificación por nota.
--   · Las cuatro funciones se restauran con su definición anterior; con notas registradas, la
--     anterior de `settled_ledger_gaps` no cambia nada (ya no hay saldo en cuentas por pagar).
--   · El único y el trigger se sueltan sin pérdida.
--   NOTAS REGISTRADAS ENTRE 110000 Y ESTA (solo bases de desarrollo: la 110000 no se desplegó):
--   su saldo a favor quedó en cuentas por pagar y `supplier_credit_ledger_gap` las da por fila.
--   En producción no puede haber ninguna si las tres se aplican en la misma ventana.
--
-- DESPLIEGUE: JUSTO DESPUÉS del `git pull`, inmediatamente después de 20261005110100.

-- ── 0. Lo que tiene que ser cierto para aplicarla ───────────────────────────────────────────
do $$
begin
  if exists (select 1 from public.supplier_credit_notes n
               join public.supplier_invoices i on i.id = n.supplier_invoice_id
              where n.is_fiscal is distinct from i.fiscal_support) then
    raise exception
      'LAD82: hay notas de crédito de proveedor cuyo is_fiscal contradice a su factura: revisar a mano (no se reescribe un documento asentado)'
      using errcode = 'LAD82';
  end if;
end $$;

-- ── 1. El papel y su cuenta en el plan ──────────────────────────────────────────────────────
insert into public.account_purposes (code, name, description) values
  ('supplier_credit_receivable', 'Saldos a favor con proveedores',
   'Activo: lo que un proveedor nos debe porque su nota de crédito abonó más de lo que se le debía de la factura (factura ya pagada). No es deuda negativa: no se resta de lo que se debe. VALIDAR-CONTABLE: el código de la cuenta y su presentación (P-104).')
on conflict (code) do nothing;

insert into public.chart_template_accounts
  (template_code, code, name, parent_code, kind, nature, is_leaf, level, suggested_purpose)
values
  ('ve_basico', '1.1.09', 'Saldos a favor con proveedores', '1.1', 'activo', 'deudora', true, 3,
   'supplier_credit_receivable')
on conflict (template_code, code) do nothing;

-- ── 2. Las dos líneas nuevas de las plantillas de la nota (preset) ──────────────────────────
do $$
declare
  v_e record;
  v_n int;
begin
  for v_e in
    select e.id from public.journal_template_preset_entries e
     where e.preset_code = 've_basico' and e.source_kind = 'purchase_credit_note'
       and e.source_event in ('ap.credit_note_received', 'ap.expense_credit_note_received')
  loop
    continue when exists (select 1 from public.journal_template_preset_lines l
                           where l.entry_id = v_e.id
                             and l.account_purpose = 'supplier_credit_receivable');
    select max(l.line_number) into v_n
      from public.journal_template_preset_lines l where l.entry_id = v_e.id;
    insert into public.journal_template_preset_lines
      (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
    values
      (v_e.id, v_n + 1, 'supplier_credit_receivable', 'credit_surplus', 'debit',
       'if_amount_nonzero', 'Lo que la nota abona por encima de lo que se debía: saldo a favor con el proveedor'),
      (v_e.id, v_n + 2, 'ap_general', 'credit_surplus', 'credit', 'if_amount_nonzero',
       'La cuenta por pagar baja solo por lo que se debía: el exceso no vive aquí');
  end loop;
end $$;

-- ── 3. Las empresas que YA tienen plan y plantillas ─────────────────────────────────────────
do $$
declare
  v_c record;
  v_n record;
  v_t record;
  v_padre uuid;
  v_cuenta uuid;
  v_max int;
  v_ahora timestamptz := now();
begin
  select a.code, a.name, a.parent_code, a.kind, a.nature, a.suggested_purpose into v_n
    from public.chart_template_accounts a
   where a.template_code = 've_basico' and a.suggested_purpose = 'supplier_credit_receivable';

  -- Quien tiene «Cuentas por pagar» lleva las compras en su contabilidad.
  for v_c in
    select distinct s.company_id, s.tenant_id
      from public.company_account_settings s
     where s.purpose = 'ap_general'
  loop
    continue when exists (select 1 from public.company_account_settings s
                           where s.company_id = v_c.company_id
                             and s.purpose = 'supplier_credit_receivable');
    select id into v_padre from public.accounts
     where company_id = v_c.company_id and code = v_n.parent_code;
    -- Un plan propio sin 1.1, o con el código ocupado: no se adivina la cuenta. El papel queda
    -- sin asignar y la nota con saldo a favor va a la cola diciendo cuál falta.
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
            jsonb_build_object('origin', 'migration_20261005110200', 'code', v_n.code,
                               'purpose', v_n.suggested_purpose, 'account_id', v_cuenta));
  end loop;

  for v_t in
    select t.id, t.tenant_id, t.company_id, t.source_kind, t.source_event
      from public.journal_templates t
     where t.source_kind = 'purchase_credit_note'
       and t.source_event in ('ap.credit_note_received', 'ap.expense_credit_note_received')
  loop
    continue when exists (select 1 from public.journal_template_lines l
                           where l.template_id = v_t.id
                             and l.account_purpose = 'supplier_credit_receivable');
    select max(l.line_number) into v_max
      from public.journal_template_lines l where l.template_id = v_t.id;
    insert into public.journal_template_lines
      (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
       side, condition_kind, description)
    values
      (v_t.tenant_id, v_t.company_id, v_t.id, coalesce(v_max, 0) + 1,
       'supplier_credit_receivable', 'credit_surplus', 'debit', 'if_amount_nonzero',
       'Lo que la nota abona por encima de lo que se debía: saldo a favor con el proveedor'),
      (v_t.tenant_id, v_t.company_id, v_t.id, coalesce(v_max, 0) + 2,
       'ap_general', 'credit_surplus', 'credit', 'if_amount_nonzero',
       'La cuenta por pagar baja solo por lo que se debía: el exceso no vive aquí');
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_t.tenant_id, v_t.company_id, 'company', v_t.company_id,
            'accounting.templates_imported', 'system', v_ahora, 'db-migration',
            jsonb_build_object('origin', 'migration_20261005110200',
                               'source_kind', v_t.source_kind, 'source_event', v_t.source_event,
                               'template_id', v_t.id, 'lines_added', 2));
  end loop;
end $$;

-- ── 4. settled_ledger_gaps vuelve a su enunciado de siempre ─────────────────────────────────
CREATE OR REPLACE FUNCTION platform.settled_ledger_gaps(p_company uuid)
 RETURNS TABLE(side text, document_id uuid, residual numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  -- ENUNCIADO: todo documento SALDADO (venta `paid`, factura de compra `paid`) cuyo último
  -- cobro o pago es posterior al corte (platform.invariant_cutoffs), y cuyas piezas tienen todas
  -- su asiento, no deja NADA en cuentas por cobrar (o por pagar) del mayor.
  select 'ar'::text, d.id, x.abierto
    from public.documents d
    cross join lateral (select platform.settlement_ledger_open(p_company, 'ar', d.id)
                               as abierto) x
   where d.company_id = p_company and d.status = 'paid'
     and (select max(p.created_at) from public.payments p where p.document_id = d.id)
         >= (select c.since from platform.invariant_cutoffs c
              where c.invariant = 'settled_ledger_gaps')
     and x.abierto is not null and x.abierto <> 0
  union all
  select 'ap'::text, i.id, x.abierto
    from public.supplier_invoices i
    cross join lateral (select platform.settlement_ledger_open(p_company, 'ap', i.id)
                               as abierto) x
   where i.company_id = p_company and i.status = 'paid'
     and (select max(p.created_at) from public.supplier_payments p
           where p.supplier_invoice_id = i.id)
         >= (select c.since from platform.invariant_cutoffs c
              where c.invariant = 'settled_ledger_gaps')
     and x.abierto is not null and x.abierto <> 0
$function$;

comment on function platform.settled_ledger_gaps(uuid) is
  'INVARIANTE (ADR-0075 §4; F-15, H-02): ningún documento saldado desde el corte tiene residuo en cuentas por cobrar o por pagar del mayor. Cero filas. Sin excepciones: el saldo a favor con un proveedor vive en su propia cuenta (supplier_credit_receivable) y lo vigila platform.supplier_credit_ledger_gap.';

-- ── 5. El invariante del saldo a favor con proveedores ──────────────────────────────────────
create or replace function platform.supplier_credit_ledger_gap(p_company uuid)
returns table(declarado numeric, mayor numeric, en_cola numeric, diferencia numeric)
language sql
stable
set search_path = ''
as $function$
  -- ENUNCIADO: Σ del saldo a favor que declaran las notas de crédito de proveedor VIGENTES
  -- (supplier_credit_notes.credit_in_favor_functional, calculado al registrar desde el saldo del
  -- AUXILIAR de la factura) = saldo deudor del mayor en la cuenta de saldos a favor con
  -- proveedores, más lo declarado por notas cuyo asiento espera en la cola. Cero filas.
  with declarado as (
    select coalesce(sum(n.credit_in_favor_functional), 0) as v
      from public.supplier_credit_notes n
     where n.company_id = p_company and n.status = 'posted'
  ),
  cola as (
    select coalesce(sum(n.credit_in_favor_functional), 0) as v
      from public.supplier_credit_notes n
     where n.company_id = p_company and n.status = 'posted'
       and n.credit_in_favor_functional <> 0
       and not exists (select 1 from public.journal_entries e
                        where e.company_id = p_company and e.source_id = n.id
                          and e.source_kind = 'purchase_credit_note'
                          and e.status in ('posted', 'reversed') and e.is_reversal_of is null)
       and exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.source_id = n.id
                      and q.source_kind = 'purchase_credit_note'
                      and (q.status = 'pending'
                           or (q.status = 'discarded'
                               and exists (select 1 from public.audit_events a
                                            where a.company_id = p_company
                                              and a.event_type = 'accounting.pending_discarded'
                                              and a.payload ->> 'queue_id' = q.id::text))))
  ),
  mayor as (
    select coalesce(sum(jl.functional_debit - jl.functional_credit), 0) as v
      from public.journal_lines jl
      join public.journal_entries e on e.id = jl.entry_id and e.company_id = p_company
     where jl.company_id = p_company
       and e.status in ('posted', 'reversed')
       and jl.account_id in (select distinct s.account_id
                               from public.company_account_settings s
                              where s.company_id = p_company
                                and s.purpose = 'supplier_credit_receivable')
  )
  select d.v, m.v, c.v, d.v - c.v - m.v
    from declarado d, mayor m, cola c
   where d.v - c.v - m.v <> 0
$function$;

comment on function platform.supplier_credit_ledger_gap(uuid) is
  'INVARIANTE (ADR-0083 §5): el saldo a favor declarado por las notas de crédito de proveedor vigentes = el saldo del mayor en la cuenta de saldos a favor con proveedores, más la cola. Cero filas. La cifra de la nota sale del auxiliar de la factura, no del mayor: los dos lados pueden discrepar.';
revoke all on function platform.supplier_credit_ledger_gap(uuid) from public;
grant execute on function platform.supplier_credit_ledger_gap(uuid) to authenticated, ladino_api;

-- ── 6. Los dos invariantes de inventario, con el estado mixto ───────────────────────────────
CREATE OR REPLACE FUNCTION platform.inventory_coverage_gaps(p_company uuid)
 RETURNS TABLE(move_id uuid, kind text, problem text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with corte as (
    select max(c.cutover_at) as t from public.inventory_ledger_cutovers c
     where c.company_id = p_company
  ),
  anulados_netos as (
    -- Documentos anulados cuyos movimientos netean a cero en cantidad Y en valor: la venta se
    -- deshizo entera, no hay hecho económico que contabilizar.
    select m.source_document_id as id
      from public.inventory_moves m
      join public.documents d on d.id = m.source_document_id and d.company_id = p_company
     where m.company_id = p_company and d.status = 'annulled'
     group by m.source_document_id
    -- Mismo neteo que annulled_stock_gaps: la cantidad ya viene con signo.
    having coalesce(sum(m.quantity), 0) = 0 and coalesce(sum(m.functional_amount), 0) = 0
  ),
  movs as (
    select m.id, m.kind, m.source_document_id
      from public.inventory_moves m, corte
     where m.company_id = p_company
       and m.kind in ('entrada', 'salida', 'ajuste', 'revaluacion')
       and m.functional_amount <> 0
       and (corte.t is null or m.created_at > corte.t)
       and (m.source_document_id is null
            or m.source_document_id not in (select id from anulados_netos))
  ),
  estado as (
    select mv.id, mv.kind,
           exists (select 1 from public.journal_entries e
                    where e.company_id = p_company and e.status = 'posted'
                      and e.source_kind in ('inventory_move', 'landed_cost', 'sales_cost',
                                            'stock_opening', 'goods_receipt', 'sales_return',
                                            'purchase_revaluation', 'purchase_credit_note')
                      and e.source_id in (mv.id, mv.source_document_id)
                      -- 20261005110200: el ajuste de la nota (purchase_revaluation /
                      -- ap.credit_note_received) comparte source_id con ella, pero lo que cubre
                      -- sus movimientos es el asiento de la NOTA. Contarlo daba «duplicated».
                      and not (e.source_kind = 'purchase_revaluation'
                               and e.source_event = 'ap.credit_note_received')) as asiento,
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.status = 'pending'
                      and q.source_kind in ('inventory_move', 'landed_cost', 'sales_cost',
                                            'stock_opening', 'goods_receipt', 'sales_return',
                                            'purchase_revaluation', 'purchase_credit_note')
                      and q.source_id in (mv.id, mv.source_document_id)
                      -- 20261005110200: el ajuste de la nota (purchase_revaluation /
                      -- ap.credit_note_received) comparte source_id con ella, pero lo que cubre
                      -- sus movimientos es el asiento de la NOTA. Contarlo daba «duplicated».
                      and not (q.source_kind = 'purchase_revaluation'
                               and q.source_event = 'ap.credit_note_received')) as cola,
           -- 20261003190200 (ADR-0075 §7): DESCARTADA CON ACTA. La fila de cola que alguien
           -- descartó dejando el acta accounting.pending_discarded (con su motivo) es un hecho
           -- cerrado, no un hueco. Sin acta, una fila descartada NO cubre nada.
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.status = 'discarded'
                      and q.source_kind in ('inventory_move', 'landed_cost', 'sales_cost',
                                            'stock_opening', 'goods_receipt', 'sales_return',
                                            'purchase_revaluation', 'purchase_credit_note')
                      and q.source_id in (mv.id, mv.source_document_id)
                      -- 20261005110200: el ajuste de la nota (purchase_revaluation /
                      -- ap.credit_note_received) comparte source_id con ella, pero lo que cubre
                      -- sus movimientos es el asiento de la NOTA. Contarlo daba «duplicated».
                      and not (q.source_kind = 'purchase_revaluation'
                               and q.source_event = 'ap.credit_note_received')
                      and exists (select 1 from public.audit_events a
                                   where a.company_id = p_company
                                     and a.event_type = 'accounting.pending_discarded'
                                     and a.payload ->> 'queue_id' = q.id::text)) as descartada
      from movs mv
  )
  select id, kind,
         case when not asiento and not cola and not descartada then 'missing'
              else 'duplicated' end
    from estado
   where (not asiento and not cola and not descartada) or (asiento and cola)
$function$;

CREATE OR REPLACE FUNCTION platform.inventory_ledger_gap(p_company uuid)
 RETURNS TABLE(kardex numeric, mayor numeric, diferencia numeric, en_cola numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with corte as (
    select max(c.cutover_at) as t from public.inventory_ledger_cutovers c
     where c.company_id = p_company
  ),
  cuentas as (
    select distinct s.account_id from public.company_account_settings s
     where s.company_id = p_company and s.purpose = 'inventory_general'
  ),
  k as (
    select coalesce(sum(m.functional_amount), 0) as v
      from public.inventory_moves m, corte
     where m.company_id = p_company
       and (corte.t is null or m.created_at > corte.t)
  ),
  l as (
    select coalesce(sum(jl.functional_debit - jl.functional_credit), 0) as v
      from public.journal_lines jl
      join public.journal_entries e on e.id = jl.entry_id and e.company_id = p_company, corte
     where jl.company_id = p_company
       and jl.account_id in (select account_id from cuentas)
       and e.status in ('posted', 'reversed')
       and (corte.t is null or e.created_at > corte.t)
  ),
  q as (
    select coalesce(sum(m.functional_amount), 0) as v
      from public.inventory_moves m, corte
     where m.company_id = p_company
       and (corte.t is null or m.created_at > corte.t)
       and exists (select 1 from public.journal_generation_queue jq
                    where jq.company_id = p_company
                      -- 20261003190200: pendiente, o descartada CON ACTA (ver
                      -- inventory_coverage_gaps): las dos explican un valor sin asiento.
                      and (jq.status = 'pending'
                           or (jq.status = 'discarded'
                               and exists (select 1 from public.audit_events a
                                            where a.company_id = p_company
                                              and a.event_type = 'accounting.pending_discarded'
                                              and a.payload ->> 'queue_id' = jq.id::text)))
                      and jq.source_kind in ('inventory_move', 'landed_cost', 'sales_cost',
                                             'stock_opening', 'goods_receipt', 'sales_return',
                                             'purchase_revaluation', 'purchase_credit_note')
                      and jq.source_id in (m.id, m.source_document_id)
                      -- 20261005110200: el ajuste de la nota (purchase_revaluation /
                      -- ap.credit_note_received) comparte source_id con ella, pero lo que cubre
                      -- sus movimientos es el asiento de la NOTA. Contarlo daba «duplicated».
                      and not (jq.source_kind = 'purchase_revaluation'
                               and jq.source_event = 'ap.credit_note_received'))
  ),
  -- 20261005110200: el ajuste del kardex de una nota de crédito que espera en la cola. No es el
  -- valor de un movimiento: es lo que el mayor de inventario todavía tiene que moverse para
  -- alcanzar al kardex (la diferencia entre lo que la nota acreditó y lo que el kardex bajó).
  a as (
    select coalesce(sum((jq.context ->> 'revaluation_to_inventory')::numeric), 0) as v
      from public.journal_generation_queue jq, corte
     where jq.company_id = p_company and jq.status = 'pending'
       and jq.source_kind = 'purchase_revaluation'
       and jq.source_event = 'ap.credit_note_received'
       and (corte.t is null or jq.created_at > corte.t)
  )
  select k.v, l.v, k.v - l.v, q.v + a.v from k, l, q, a
$function$;

-- ── 7. Una línea de factura, una vez por nota ───────────────────────────────────────────────
create unique index supplier_credit_note_lines_one_per_invoice_line
  on public.supplier_credit_note_lines (supplier_credit_note_id, supplier_invoice_line_id)
  where supplier_invoice_line_id is not null;
comment on index public.supplier_credit_note_lines_one_per_invoice_line is
  'H-03: una nota abona cada línea de su factura UNA vez. Sin él, dos líneas de la nota sobre la misma línea de factura pasan cada una el tope de lo facturado.';

-- ── 8. is_fiscal: una sola fuente de verdad, la factura ─────────────────────────────────────
create or replace function platform.assert_credit_note_follows_invoice()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Se DERIVA, no se compara: lo que venga en la fila se pisa con lo que dice la factura. Así
  -- la API anterior (que no escribe la columna y la dejaba en su valor por omisión, true) deja
  -- de marcar como fiscal la nota de una compra sin soporte fiscal.
  new.is_fiscal := coalesce((select i.fiscal_support from public.supplier_invoices i
                              where i.id = new.supplier_invoice_id), new.is_fiscal);
  return new;
end;
$$;
revoke all on function platform.assert_credit_note_follows_invoice() from public;

create trigger supplier_credit_notes_02_follows_invoice
  before insert on public.supplier_credit_notes
  for each row execute function platform.assert_credit_note_follows_invoice();

-- ── 9. Lo que esta migración garantiza sobre sí misma ───────────────────────────────────────
do $$
begin
  if exists (select 1 from public.journal_template_preset_entries e
              where e.preset_code = 've_basico' and e.source_kind = 'purchase_credit_note'
                and (select count(*) from public.journal_template_preset_lines l
                      where l.entry_id = e.id and l.amount_source = 'credit_surplus') <> 2) then
    raise exception 'LAD82: una plantilla de la nota de crédito no tiene sus dos líneas del saldo a favor'
      using errcode = 'LAD82';
  end if;
  if not exists (select 1 from public.chart_template_accounts a
                  where a.template_code = 've_basico'
                    and a.suggested_purpose = 'supplier_credit_receivable'
                    and a.kind = 'activo' and a.nature = 'deudora') then
    raise exception 'LAD82: el plan ve_basico no tiene los saldos a favor con proveedores como activo'
      using errcode = 'LAD82';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Ladino — EL SOBREGIRO QUE SE CUBRE AL CERRAR LA CAJA SE LE DEBE AL DUEÑO (J-02)
--
-- Módulo: tesorería · contabilidad (RIGOR MÁXIMO: dinero)
-- Spec: RESPUESTA_RECORRIDO_2026-09-24 §3 J-02 · ADR-0062 §4 (el sobregiro confirmado) ·
--       ADR-0070 (la caja y su subcuenta) · ADR-0041/0055 (papeles y plantillas) · ADR-0075 §7
-- HOMOLOGATION_IMPACT: NO (no toca emisión, numeración ni libros de IVA).
--
-- EL DEFECTO. Una caja en −120.000 que se cuenta en cero se cerraba con «Sobraron 120.000» y el
-- asiento D caja / H 5.1.06 «Faltantes y sobrantes de caja»: una cuenta de RESULTADO. La ganancia
-- subía 120.000 Bs con dinero que la dueña puso de su bolsillo.
--
-- LA DECISIÓN (dueño, 2026-09-28; VALIDAR-CONTABLE respondido, el código lo confirma el contador,
-- P-36): el sobregiro al cerrar es DINERO DEL DUEÑO. Contrapartida en «Cuentas por pagar a socios
-- (aportes del dueño)», PASIVO, nunca ingreso. El contador puede reclasificarlo a capital con un
-- asiento propio.
--
-- QUÉ HACE:
--   1. el papel `owner_payable` y la cuenta 2.1.92 en el plan `ve_basico`;
--   2. una fuente de importe nueva, `owner_contribution`, en el vocabulario cerrado de las DOS
--      tablas de líneas (la lista vigente se COMPRUEBA antes de reconstruir el CHECK: si otra
--      migración añadió vocabulario que esta no conoce, falla en vez de borrarlo en silencio);
--   3. un hecho nuevo del preset, `cash_closing / treasury.cash_register.overdraft_covered`. La
--      plantilla de siempre (`treasury.cash_register.closed`) NO se toca: sobrantes y faltantes
--      sin sobregiro se asientan igual. Solo la rama del sobregiro usa el hecho nuevo:
--        D  caja del cierre           total               (lo que sube la caja)
--        H  owner_payable             owner_contribution  (de negativo a cero: lo puso el dueño)
--        H  cash_over_short           functional_amount   (lo contado POR ENCIMA de cero: sobrante)
--   4. las empresas que YA importaron plan y preset reciben la cuenta, el papel y la plantilla
--      con vigencia desde siempre (ADR-0055), con acta en `audit_events`.
--
-- EXPAND. La API hoy desplegada no conoce el hecho nuevo: sigue asentando con la plantilla de
-- siempre, que no cambia. Nada se quita ni se renombra. Se puede aplicar antes del git pull.
--
-- LOS ASIENTOS YA POSTEADOS NO SE TOCAN (regla 2). Los cierres en sobregiro que ya se asentaron
-- como ingreso los corrige, DESPUÉS del git pull, `scripts/reparar/j-02-sobregiro-al-cierre.mjs`
-- (reversa + asiento nuevo, con acta; idempotente).
--
-- Reversible: SÍ sobre una base sin cierres en sobregiro nuevos (se cierra la plantilla y se
-- deja de usar la cuenta). CON DATOS VIVOS, NO del todo: un asiento posteado contra 2.1.92 es
-- append-only, la cuenta ya no se puede quitar y devolverlo a resultado exige un asiento de
-- reclasificación por cada cierre. El vocabulario añadido es inofensivo si queda.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. El papel y su cuenta en el plan ──────────────────────────────────────
insert into public.account_purposes (code, name, description) values
  ('owner_payable', 'Cuentas por pagar a socios (aportes del dueño)',
   'Pasivo: lo que el dueño puso de su bolsillo y la empresa le debe. Recibe el sobregiro de una caja que se cubre al cerrarla (J-02). El contador puede reclasificarlo a capital con un asiento propio. VALIDAR-CONTABLE: el código de la cuenta (P-36).')
on conflict (code) do nothing;

insert into public.chart_template_accounts
  (template_code, code, name, parent_code, kind, nature, is_leaf, level, suggested_purpose)
values
  ('ve_basico', '2.1.92', 'Cuentas por pagar a socios (aportes del dueño)', '2.1', 'pasivo',
   'acreedora', true, 3, 'owner_payable')
on conflict (template_code, code) do nothing;

-- ── 2. La fuente de importe nueva (vocabulario cerrado, las DOS tablas) ─────
-- Reconstruir un CHECK desde una copia incompleta borra vocabulario en silencio (migración 37).
-- Antes de soltarlo se lee el VIGENTE: todo lo que admite tiene que estar en la lista nueva.
do $$
declare
  v_nueva constant text[] := array[
    'subtotal', 'tax_amount', 'total', 'retained_iva', 'retained_islr', 'retained_total',
    'net_amount', 'cost_amount', 'landed_to_inventory', 'landed_to_variance',
    'exchange_difference', 'functional_amount', 'revaluation_to_inventory',
    'revaluation_to_variance', 'owner_contribution'];
  v_t record;
  v_def text;
  v_falta text;
begin
  for v_t in
    select * from (values
      ('public.journal_template_lines'::regclass, 'journal_template_lines_amount_chk'),
      ('public.journal_template_preset_lines'::regclass, 'journal_template_preset_lines_amount_chk')
    ) as t(tabla, restriccion)
  loop
    select pg_get_constraintdef(c.oid) into v_def
      from pg_catalog.pg_constraint c
     where c.conrelid = v_t.tabla and c.conname = v_t.restriccion;
    if v_def is null then
      raise exception 'LAD82: no existe % en %: el vocabulario de importes cambió de forma',
        v_t.restriccion, v_t.tabla using errcode = 'LAD82';
    end if;
    select string_agg(m[1], ', ') into v_falta
      from regexp_matches(v_def, '''([a-z_]+)''', 'g') m
     where m[1] <> all (v_nueva);
    if v_falta is not null then
      raise exception
        'LAD82: % admite hoy importes que esta migración no conoce (%): añádelos a su lista antes de aplicarla',
        v_t.restriccion, v_falta using errcode = 'LAD82';
    end if;
    execute format('alter table %s drop constraint %I', v_t.tabla, v_t.restriccion);
    execute format('alter table %s add constraint %I check (amount_source = any (%L::text[]))',
                   v_t.tabla, v_t.restriccion, v_nueva);
  end loop;
end $$;

-- ── 3. El hecho nuevo del preset ────────────────────────────────────────────
do $$
declare
  v_entry uuid;
begin
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'cash_closing', 'treasury.cash_register.overdraft_covered',
          'Cierre de una caja en sobregiro: lo que la lleva a cero se le debe al dueño; lo contado por encima de cero es sobrante')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'treasury_account', 'total', 'debit', 'always',
     'La caja sube de su saldo negativo a lo que se contó (la cuenta contable de la caja del cierre)'),
    (v_entry, 2, 'owner_payable', 'owner_contribution', 'credit', 'always',
     'El sobregiro lo cubrió el dueño de su bolsillo: se le debe, no es un ingreso'),
    (v_entry, 3, 'cash_over_short', 'functional_amount', 'credit', 'if_positive',
     'Lo contado por encima de cero sí es sobrante');
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
  select a.code, a.name, a.parent_code, a.kind, a.nature, a.suggested_purpose into v_n
    from public.chart_template_accounts a
   where a.template_code = 've_basico' and a.suggested_purpose = 'owner_payable';

  -- Quien tiene «Faltantes y sobrantes de caja» lleva el cierre de caja en su contabilidad.
  for v_c in
    select distinct s.company_id, s.tenant_id
      from public.company_account_settings s
     where s.purpose = 'cash_over_short'
  loop
    continue when exists (select 1 from public.company_account_settings s
                           where s.company_id = v_c.company_id and s.purpose = 'owner_payable');
    select id into v_padre from public.accounts
     where company_id = v_c.company_id and code = v_n.parent_code;
    -- Un plan propio sin 2.1, o con el código ocupado: no se adivina la cuenta. El papel queda
    -- sin asignar y el cierre en sobregiro va a la cola diciendo «Falta configurar la cuenta de:
    -- owner_payable» (ruidoso), nunca a una cuenta de resultado.
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
            jsonb_build_object('origin', 'migration_20261004180000', 'code', v_n.code,
                               'purpose', v_n.suggested_purpose, 'account_id', v_cuenta));
  end loop;

  select e.id, e.source_kind, e.source_event, e.description into v_e
    from public.journal_template_preset_entries e
   where e.preset_code = 've_basico' and e.source_kind = 'cash_closing'
     and e.source_event = 'treasury.cash_register.overdraft_covered';

  for v_c in select distinct t.company_id, t.tenant_id from public.journal_templates t loop
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
            jsonb_build_object('origin', 'migration_20261004180000', 'preset_code', 've_basico',
                               'source_kind', v_e.source_kind, 'source_event', v_e.source_event,
                               'template_id', v_tpl));
  end loop;
end $$;

-- ── 5. Lo que esta migración garantiza sobre sí misma ───────────────────────
do $$
begin
  if (select count(*) from public.journal_template_preset_lines l
        join public.journal_template_preset_entries e on e.id = l.entry_id
       where e.preset_code = 've_basico' and e.source_kind = 'cash_closing'
         and e.source_event = 'treasury.cash_register.overdraft_covered') <> 3 then
    raise exception 'LAD82: el preset ve_basico no tiene las tres líneas del cierre en sobregiro'
      using errcode = 'LAD82';
  end if;
  if exists (
    select 1 from public.journal_template_preset_lines l
      join public.journal_template_preset_entries e on e.id = l.entry_id
     where e.preset_code = 've_basico' and e.source_kind = 'cash_closing'
       and e.source_event = 'treasury.cash_register.overdraft_covered'
       and l.side = 'credit'
       and l.account_purpose not in ('owner_payable', 'cash_over_short')) then
    raise exception 'LAD82: el cierre en sobregiro abona una cuenta que no es la del dueño ni la de sobrantes'
      using errcode = 'LAD82';
  end if;
  if not exists (select 1 from public.chart_template_accounts a
                  where a.template_code = 've_basico' and a.suggested_purpose = 'owner_payable'
                    and a.kind = 'pasivo' and a.nature = 'acreedora') then
    raise exception 'LAD82: el plan ve_basico no tiene la cuenta por pagar a socios como pasivo'
      using errcode = 'LAD82';
  end if;
end $$;

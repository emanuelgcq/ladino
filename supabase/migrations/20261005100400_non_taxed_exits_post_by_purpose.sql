-- =============================================================================
-- Ladino — 20261005100400 · LAS SALIDAS NO GRAVADAS ASIENTAN POR SU PAPEL (AF3-03)
--
-- Módulo: inventario · contabilidad (RIGOR MÁXIMO)   Spec: ADR-0082 (segunda ronda) · ADR-0060
-- HOMOLOGATION_IMPACT: NO — no toca documentos, libros ni la declaración: estos tres motivos no
--   causan débito fiscal ni emiten factura (eso lo decidió 20261005100000). Cambia a qué cuenta
--   va su costo.
--
-- EL DEFECTO. 20261005100000 dejó los tres motivos no gravados (LIVA art. 4.3 in fine) asentando
--   en la cuenta de retiros 5.1.09, con el motivo en la descripción. Un bien que pasa al activo
--   fijo llevado a gasto es un error contable: baja el resultado y esconde el activo.
--
-- LA DECISIÓN (del dueño, por §2.16; el contador confirma los códigos: P-82 «aplicada con código
--   provisional», como 2.1.92 en J-02):
--   · `uso_en_negocio` → el papel de gasto de operación que ya existe (`operating_expense`);
--   · `activo_fijo` e `incorporado_inmueble` → un papel NUEVO, `fixed_assets` («Propiedad, planta
--     y equipo»), con UNA cuenta provisional: 1.2.01, bajo una rama nueva 1.2 «Activo no
--     circulante» que `ve_basico` no tenía;
--   · dos hechos contables nuevos del preset, con el nombre del evento que `issueStock` publica:
--     `inventory_move / stock.used_in_business` y `inventory_move / stock.capitalized`.
--   Una empresa con plan propio sin ese papel NO recibe una cuenta adivinada: el movimiento va a
--   la cola de pendientes diciendo qué papel falta (ruidoso), como el resto.
--
-- EMPRESAS QUE YA IMPORTARON EL PLAN: reciben las dos cuentas y el papel, con acta
--   (`accounting.account_added`), salvo que su plan no tenga la cuenta 1 o ya use el código 1.2 o
--   1.2.01 para otra cosa. Y las que ya importaron el preset reciben las dos plantillas, con acta
--   (`accounting.templates_imported`), vigentes desde siempre (ADR-0055). Mismo patrón que
--   20261003110000 §4 y 20261004180000.
--
-- COMPATIBILIDAD: aditiva. La API saliente no publica estos eventos ni usa el papel. Va JUSTO
--   DESPUÉS del `git pull`, tras 20261005100300.
-- REVERSIBILIDAD (con datos vivos): cuentas, papel y plantillas son aditivos. Sin asientos
--   encima se desactivan con versión nueva; con asientos NO se borran: se reclasifica con
--   contra-asiento. Si el contador cambia el código, se crea la cuenta definitiva, se reasigna el
--   papel con vigencia nueva y la provisional se reclasifica.
-- =============================================================================

-- ── 1. El papel y la cuenta provisional ─────────────────────────────────────
insert into public.account_purposes (code, name, description) values
  ('fixed_assets', 'Propiedad, planta y equipo',
   'Activo no circulante: los bienes que salen del inventario para quedarse trabajando en el negocio (pasan a activo fijo o se incorporan a un inmueble del negocio; LIVA art. 4.3 in fine). Código provisional: VALIDAR-CONTABLE P-82.')
on conflict (code) do nothing;

insert into public.chart_template_accounts
  (template_code, code, name, parent_code, kind, nature, is_leaf, level, suggested_purpose)
values
  ('ve_basico', '1.2', 'Activo no circulante', '1', 'activo', 'deudora', false, 2, null),
  ('ve_basico', '1.2.01', 'Propiedad, planta y equipo', '1.2', 'activo', 'deudora', true, 3,
   'fixed_assets')
on conflict (template_code, code) do nothing;

-- ── 2. Los dos hechos del preset ────────────────────────────────────────────
do $$
declare
  v_entry uuid;
begin
  insert into public.journal_template_preset_entries (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'inventory_move', 'stock.used_in_business',
          'Salida no gravada: el bien se usa o se consume en el giro del negocio (gasto de operación contra inventario)')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'operating_expense', 'cost_amount', 'debit', 'always',
     'Lo usado en el negocio, al costo con que salió del kardex'),
    (v_entry, 2, 'inventory_general', 'cost_amount', 'credit', 'always', 'sale del inventario');

  insert into public.journal_template_preset_entries (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'inventory_move', 'stock.capitalized',
          'Salida no gravada: el bien pasa al activo fijo o se incorpora a un inmueble del negocio (activo contra inventario)')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'fixed_assets', 'cost_amount', 'debit', 'always',
     'El bien que se queda en el negocio, al costo con que salió del kardex'),
    (v_entry, 2, 'inventory_general', 'cost_amount', 'credit', 'always', 'sale del inventario');
end $$;

-- ── 3. Las empresas que YA tienen plan y preset ─────────────────────────────
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
    -- Con el papel ya asignado, o con el código 1.2 o 1.2.01 ya usado en su plan, no se adivina:
    -- esa empresa asigna el papel a mano y, mientras, el movimiento espera en la cola.
    continue when exists (select 1 from public.company_account_settings s
                           where s.company_id = v_c.company_id and s.purpose = 'fixed_assets')
               or exists (select 1 from public.accounts a
                           where a.company_id = v_c.company_id and a.code in ('1.2', '1.2.01'));
    for v_n in
      select a.code, a.name, a.parent_code, a.kind, a.nature, a.suggested_purpose
        from public.chart_template_accounts a
       where a.template_code = 've_basico' and a.code in ('1.2', '1.2.01')
       order by a.code
    loop
      select id into v_padre from public.accounts
       where company_id = v_c.company_id and code = v_n.parent_code;
      exit when v_padre is null;
      insert into public.accounts
        (tenant_id, company_id, code, name, parent_id, kind, nature, rules_version)
      values (v_c.tenant_id, v_c.company_id, v_n.code, v_n.name, v_padre, v_n.kind, v_n.nature,
              'db-migration')
      returning id into v_cuenta;
      if v_n.suggested_purpose is not null then
        insert into public.company_account_settings
          (tenant_id, company_id, purpose, account_id, effective_from)
        values (v_c.tenant_id, v_c.company_id, v_n.suggested_purpose, v_cuenta, '-infinity');
      end if;
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      values (v_c.tenant_id, v_c.company_id, 'company', v_c.company_id,
              'accounting.account_added', 'system', v_ahora, 'db-migration',
              jsonb_build_object('origin', 'migration_20261005100400', 'code', v_n.code,
                                 'purpose', v_n.suggested_purpose, 'account_id', v_cuenta,
                                 'provisional', true));
    end loop;
  end loop;

  for v_c in select distinct t.company_id, t.tenant_id from public.journal_templates t loop
    for v_e in
      select e.id, e.source_kind, e.source_event, e.description
        from public.journal_template_preset_entries e
       where e.preset_code = 've_basico' and e.source_kind = 'inventory_move'
         and e.source_event in ('stock.used_in_business', 'stock.capitalized')
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
              jsonb_build_object('origin', 'migration_20261005100400', 'preset_code', 've_basico',
                                 'source_kind', v_e.source_kind, 'source_event', v_e.source_event,
                                 'template_id', v_tpl));
    end loop;
  end loop;
end $$;

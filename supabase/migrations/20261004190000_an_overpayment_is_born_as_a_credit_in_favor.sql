-- Módulo: ventas · cobros   Spec: docs/00_GOVERNANCE/adr/ADR-0075-* (nota de la ola 4)
-- Ola 4 · F-10 (RESPUESTA_RECORRIDO_2026-09-24 §3): un pago de más se acepta y el sobrante nace
-- como saldo a favor. Segunda parte de 20261004150000.
-- Reversible: ver el pie (con datos vivos)   Homologación: YES (cambia el asiento de un cobro con
-- sobrante; no cambia ningún documento fiscal)
--
-- Por qué va aparte y con este número: el importe nuevo de plantilla, «credit_surplus», amplía el
-- CHECK de amount_source, y 20261004180000 lo reconstruye con su propia lista y rechaza (LAD82)
-- cualquier importe que no conozca. Tiene que correr DESPUÉS de ella. No lee nada que cree una
-- migración posterior, y no redefine ninguna función.
--
-- NO es «expand» para el cobro: desde que esta migración se aplica, la plantilla del cobro pide
-- «credit_surplus». El generador nuevo lo toma como 0 cuando el hecho no lo aporta (un cobro sin
-- sobrante, una fila vieja de la cola); la API ANTERIOR no, y sus cobros responderían 422 con
-- «la plantilla pide el importe credit_surplus». APLICAR JUSTO DESPUÉS DEL GIT PULL, en la misma
-- ventana, sin operar entre medias (es el mismo caso de R-74 con «exchange_difference»).

-- ── 1. El vocabulario de importes admite «credit_surplus» ────────────────────
-- Se LEE el CHECK vigente y se le añade el importe: no se escribe la lista otra vez (la escribió
-- 20261004180000, y quien añada otro importe después no tiene que conocer esta migración).
do $$
declare
  v_t record;
  v_def text;
  v_vals text[];
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
    -- Los importes son las palabras en minúscula de la definición, menos el nombre de la columna
    -- y el del tipo. Vale para las dos formas en que Postgres la escribe (lista de literales o
    -- un array entre llaves).
    select array_agg(distinct m[1]) into v_vals
      from regexp_matches(v_def, '([a-z]+(?:_[a-z]+)*)', 'g') m
     where m[1] not in ('amount_source', 'text');
    -- La lectura se comprueba contra lo que se sabe que está: si no aparecen, no se entendió la
    -- definición, y reconstruirla dejaría fuera importes vivos.
    if v_vals is null
       or not (array['subtotal', 'total', 'functional_amount', 'exchange_difference',
                     'owner_contribution'] <@ v_vals) then
      raise exception 'LAD82: no se pudo leer el vocabulario de % (%)', v_t.restriccion, v_def
        using errcode = 'LAD82';
    end if;
    if not ('credit_surplus' = any (v_vals)) then
      v_vals := v_vals || 'credit_surplus'::text;
      execute format('alter table %s drop constraint %I', v_t.tabla, v_t.restriccion);
      -- Al añadirlo, Postgres valida las filas que ya existen: un importe en uso que la lectura
      -- hubiera perdido hace fallar la migración aquí, no después.
      execute format('alter table %s add constraint %I check (amount_source = any (%L::text[]))',
                     v_t.tabla, v_t.restriccion, v_vals);
    end if;
  end loop;
end $$;

-- ── 2. La línea del sobrante en la plantilla del cobro ───────────────────────
do $$
declare
  v_cobro uuid;
begin
  select id into v_cobro from public.journal_template_preset_entries
   where preset_code = 've_basico' and source_kind = 'payment_received'
     and source_event = 'ar.payment_applied';
  if v_cobro is null then
    raise exception 'LAD83: falta en el preset ve_basico el cobro (ar.payment_applied)'
      using errcode = 'LAD83';
  end if;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  select v_cobro, (select max(line_number) from public.journal_template_preset_lines
                    where entry_id = v_cobro) + 1,
         'customer_credit_liability', 'credit_surplus', 'credit', 'if_amount_nonzero',
         'Lo que el cliente pagó de más queda como saldo a favor suyo'
   where not exists (select 1 from public.journal_template_preset_lines l
                      where l.entry_id = v_cobro and l.amount_source = 'credit_surplus');
end $$;

-- Las empresas que ya importaron la plantilla: se añade la línea si no la tienen, con acta. No se
-- reescribe la plantilla de nadie.
do $$
declare
  v_t record;
  v_n integer;
begin
  for v_t in
    select t.id, t.tenant_id, t.company_id
      from public.journal_templates t
     where t.effective_to is null
       and t.source_kind = 'payment_received' and t.source_event = 'ar.payment_applied'
       and not exists (select 1 from public.journal_template_lines l
                        where l.template_id = t.id and l.amount_source = 'credit_surplus')
  loop
    select coalesce(max(line_number), 0) into v_n
      from public.journal_template_lines where template_id = v_t.id;
    insert into public.journal_template_lines
      (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
       side, condition_kind, description)
    values
      (v_t.tenant_id, v_t.company_id, v_t.id, v_n + 1, 'customer_credit_liability',
       'credit_surplus', 'credit', 'if_amount_nonzero',
       'Lo que el cliente pagó de más queda como saldo a favor suyo');
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_t.tenant_id, v_t.company_id, 'company', v_t.company_id,
            'accounting.templates_imported', 'system', now(), 'db-migration',
            jsonb_build_object('origin', 'migration_20261004190000', 'preset_code', 've_basico',
                               'facts', 'ar.payment_applied',
                               'motivo', 'un pago de más nace como saldo a favor (F-10)'));
  end loop;
end $$;

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos)
--   · La línea «credit_surplus» se quita de las plantillas con otra migración SOLO mientras ningún
--     cobro con sobrante esté en la cola de pendientes: sin la línea, su asiento no cuadraría.
--     Los asientos ya posteados con ella no cambian (regla 2): se revierten con su reversa.
--   · El importe se retira del CHECK con otra migración una vez que ninguna línea lo use.
-- A la fecha, ninguna migración posterior reconstruye el CHECK de amount_source.
-- =============================================================================

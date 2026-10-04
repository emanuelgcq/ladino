-- =============================================================================
-- Ladino — LA EXCEPCIÓN DEL CÉNTIMO ES UN MECANISMO, Y SU COLA NO QUEDA PENDIENTE
-- (ADR-0075 §7; revisión en contexto limpio de 20261003190000)
--
-- Módulo: contabilidad · inventario. Rigor MÁXIMO (dinero, con datos vivos). Corrige la
--   20261003190000, con su propia auditoría (CLAUDE.md §3).
-- Reversible: SÍ para el esquema, con datos vivos — ver al final.
-- HOMOLOGATION_IMPACT: NO — no toca libros, declaraciones ni documentos fiscales.
--
-- LO QUE LA 20261003190000 DECÍA Y NO ERA CIERTO (una migración aplicada no se edita):
--   · Su comentario de LAD71 decía que el asiento exceptuado «solo lo escribe
--     platform.cent_regularization_prepare (sin GRANT a nadie)». FALSO como defensa: la excepción
--     se reconocía por una ETIQUETA (source_kind = 'inventory_move', source_event =
--     'stock.cent_regularized'), `ladino_api` tiene INSERT y UPDATE sobre journal_entries y ningún
--     CHECK limita source_event. Cualquier sesión de la API que escribiera esa etiqueta posteaba
--     fracciones. Ausencia de mecanismo no es prohibición (CLAUDE.md §2).
--   · Decía que la empresa sin contabilidad deja su asiento en la cola «como cualquier movimiento
--     de valor sin contabilidad». NO es como cualquiera: ninguna plantilla puede resolver esa fila
--     (su importe es una suma de fracciones de céntimo, que al céntimo es cero y el generador la
--     descarta), nadie puede descartarla por la API, y una fila `pending` hace que
--     closeFiscalPeriod y closeFiscalYear rechacen para siempre.
--   · El caso «las fracciones del kardex netean a cero y el mayor no trae ninguna» fallaba con
--     «revísala a mano». Tiene la misma salida que el anterior y aquí se resuelve.
--
-- Qué cambia:
--   1. `platform.cent_regularization_entries`: tabla PRIVADA (esquema platform, RLS forzada sin
--      policies, sin GRANT a nadie) donde solo `cent_regularization_prepare` registra el id del
--      asiento que crea. `platform.is_cent_regularization_entry(uuid)` (security definer) es la
--      única lectura. No lleva tenant_id: no es un dato de negocio, es la marca de un asiento, y
--      el asiento ya lleva su ancla. Sin FK a journal_entries a propósito: un FK más sobre el
--      diario cambia el error de un TRUNCATE (0A000 en vez de LAD06) y los asientos no se borran.
--   2. `platform.assert_entry_balanced` — create or replace sobre 20261003190000. Única
--      diferencia: la excepción de LAD71 es «el asiento está registrado», no «lleva la etiqueta».
--   3. `platform.cent_regularization_prepare` / `_finish` — sobre 20261003190000: registran el
--      asiento; la fila de cola nace `discarded` con motivo y acta `accounting.pending_discarded`;
--      el neteo a cero deja de fallar; el ensayo dice si el período de hoy está cerrado.
--   4. `platform.inventory_coverage_gaps` e `inventory_ledger_gap` — create or replace sobre
--      20260917120000 (la última que las define; ni 200000 ni 210000 las tocan). El ENUNCIADO
--      pasa a decir: todo movimiento de valor tiene asiento, fila de cola pendiente, o fila
--      descartada CON ACTA. Una descartada sin acta sigue sin cubrir nada. Cero, sin perdones.
--   5. Datos: las filas `pending` de `stock.cent_regularized` que existan pasan a `discarded` con
--      el mismo motivo y su acta (idempotente).
-- Decidido por criterio (§2.16). Alternativa: no encolar, y exceptuar en el enunciado de
--   inventory_coverage_gaps los movimientos de la regularización de una empresa sin contabilidad.
-- =============================================================================

-- ── 1. El registro privado de los asientos de la regularización ─────────────
create table platform.cent_regularization_entries (
  entry_id   uuid primary key,
  company_id uuid not null,
  created_at timestamptz not null default now()
);
comment on table platform.cent_regularization_entries is
  'ADR-0075 §7: los asientos que platform.cent_regularization_prepare creó. Es EL MECANISMO de la '
  'excepción de LAD71 (assert_entry_balanced): un asiento puede postear líneas con fracción de '
  'céntimo solo si está aquí. Sin GRANT a nadie y con RLS forzada sin policies: la API no puede '
  'fabricar la excepción. Quitar esta tabla o darle GRANT reabre el mayor a los ocho decimales.';
alter table platform.cent_regularization_entries enable row level security;
alter table platform.cent_regularization_entries force row level security;
revoke all on platform.cent_regularization_entries from public;
do $$
declare r text;
begin
  -- Ningún rol de aplicación, tampoco por privilegios por omisión del esquema.
  foreach r in array array['anon', 'authenticated', 'service_role', 'ladino_api', 'ladino_worker'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on platform.cent_regularization_entries from %I', r);
    end if;
  end loop;
end $$;

create function platform.is_cent_regularization_entry(p_entry uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from platform.cent_regularization_entries e where e.entry_id = p_entry)
$$;
comment on function platform.is_cent_regularization_entry(uuid) is
  'ADR-0075 §7: ¿este asiento lo creó la regularización del céntimo? Única lectura de '
  'platform.cent_regularization_entries; la usa assert_entry_balanced (plpgsql) al postear. '
  'Security definer porque quien postea no puede leer la tabla; devuelve solo un booleano.';
revoke execute on function platform.is_cent_regularization_entry(uuid) from public;
grant execute on function platform.is_cent_regularization_entry(uuid)
  to authenticated, ladino_api, service_role;

-- El registro nace VACÍO, a propósito. No se rellena con los borradores que lleven la etiqueta:
-- eso sería volver a fiarse de la etiqueta. La regularización prepara y postea en una sola
-- transacción, así que no hay borradores legítimos a medias; los asientos de regularización ya
-- posteados no pasan otra vez por el trigger y no lo necesitan.

-- ── 2. LAD71: la excepción es el registro, no la etiqueta ───────────────────
CREATE OR REPLACE FUNCTION platform.assert_entry_balanced()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_debit  numeric;
  v_credit numeric;
  v_lines  integer;
  v_period public.fiscal_periods;
  l        record;
  v_fuera  record;
begin
  if new.status <> 'posted' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'posted' then return new; end if;

  select count(*), coalesce(sum(functional_debit), 0), coalesce(sum(functional_credit), 0)
    into v_lines, v_debit, v_credit
    from public.journal_lines where entry_id = new.id;

  if v_lines < 2 then
    raise exception 'un asiento de partida doble necesita al menos dos líneas; tiene %', v_lines
      using errcode = 'LAD59';
  end if;
  if v_debit <> v_credit then
    raise exception
      'la partida doble no cuadra en moneda funcional: débitos % ≠ créditos % (diferencia %)',
      v_debit, v_credit, v_debit - v_credit
      using errcode = 'LAD59',
            hint = 'la diferencia se comprueba en moneda funcional, que es la que va al mayor';
  end if;
  if v_debit = 0 then
    raise exception 'un asiento de importe cero no es un hecho contable' using errcode = 'LAD59';
  end if;

  -- ADR-0075 §7 (C5c, 20261003190000; excepción corregida en 20261003190200): NINGÚN IMPORTE DEL
  -- MAYOR CON MÁS DE DOS DECIMALES. Se comprueba aquí, donde se comprueba la partida doble, y por
  -- la misma razón: es un invariante del dato, y una aplicación se puede saltar. El enunciado
  -- completo: al POSTEAR, toda línea va al céntimo en moneda funcional, salvo el asiento de la
  -- REGULARIZACIÓN DEL CÉNTIMO, cuyo oficio es precisamente llevarse la fracción.
  -- Ese asiento NO se reconoce por una etiqueta (source_kind / source_event las escribe
  -- cualquiera que tenga INSERT sobre journal_entries, y la API lo tiene): se reconoce porque su
  -- id está en platform.cent_regularization_entries, una tabla sin GRANT a nadie donde solo
  -- escribe platform.cent_regularization_prepare, que tampoco tiene GRANT. Los asientos ya
  -- posteados no pasan por aquí (ver arriba) y no se tocan. La reversa de un asiento viejo con
  -- fracción se genera al céntimo (accounting.ts, reversar), así que tampoco es excepción.
  if not platform.is_cent_regularization_entry(new.id) then
    select jl.line_number, greatest(jl.functional_debit, jl.functional_credit) as importe
      into v_fuera
      from public.journal_lines jl
     where jl.entry_id = new.id
       and (jl.functional_debit <> round(jl.functional_debit, 2)
            or jl.functional_credit <> round(jl.functional_credit, 2))
     order by jl.line_number
     limit 1;
    if found then
      raise exception 'Los importes del asiento llevan como máximo dos decimales'
        using errcode = 'LAD71',
              detail = format('línea %s: %s', v_fuera.line_number, v_fuera.importe),
              hint = 'el mayor va al céntimo (ADR-0075 §7): redondea el importe antes de postear';
    end if;
  end if;

  -- El período tiene que estar abierto A LA FECHA DEL ASIENTO.
  select * into v_period from public.fiscal_periods
   where id = new.period_id and company_id = new.company_id;
  if v_period.status = 'closed' then
    raise exception
      'el período %-% está CERRADO: no admite asientos. Reabrirlo exige permiso y motivo escrito',
      v_period.year, v_period.month
      using errcode = 'LAD61';
  end if;

  -- Y cada línea tiene que ir a una cuenta que admita movimiento.
  for l in
    select jl.account_id, jl.analytical_dimensions, a.is_leaf, a.is_active,
           a.requires_analytical, a.code
      from public.journal_lines jl
      join public.accounts a on a.id = jl.account_id
     where jl.entry_id = new.id
  loop
    if not l.is_leaf then
      raise exception
        'la cuenta % agrupa y no recibe asientos: usa una de sus hojas', l.code
        using errcode = 'LAD62';
    end if;
    if not l.is_active then
      raise exception 'la cuenta % está desactivada', l.code using errcode = 'LAD62';
    end if;
    if l.requires_analytical
       and (l.analytical_dimensions is null or l.analytical_dimensions = '{}'::jsonb) then
      raise exception
        'la cuenta % exige dimensiones analíticas y la línea no las trae', l.code
        using errcode = 'LAD62';
    end if;
  end loop;
  return new;
end;
$function$;

-- ── 3. La regularización: registra su asiento y no deja cola pendiente ──────
create or replace function platform.cent_regularization_prepare(
  p_company uuid, p_ensayo boolean default false)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_moneda text;
  v_reg uuid := gen_random_uuid();
  v_fecha date := (now() at time zone 'America/Caracas')::date;
  v_inv uuid;
  v_red uuid;
  v_k record;
  v_l record;
  v_k_total numeric := 0;
  v_gap numeric;
  v_adj_inv numeric := 0;
  v_entry uuid;
  v_cola uuid;
  v_linea int := 0;
  v_suma numeric := 0;
  v_kardex jsonb;
  v_mayor jsonb;
  v_visibles jsonb;
  v_hay_k boolean;
  v_asienta boolean;
  v_encola boolean;
  v_motivo text;
  v_cerrado boolean := false;
  v_vacio constant jsonb := jsonb_build_array();
begin
  select c.tenant_id, c.functional_currency_code into v_tenant, v_moneda
    from public.companies c where c.id = p_company;
  if v_tenant is null then
    raise exception 'la empresa % no existe', p_company using errcode = '23503';
  end if;
  select s.account_id into v_inv from public.company_account_settings s
   where s.company_id = p_company and s.purpose = 'inventory_general' and s.effective_to is null
   order by s.effective_from desc limit 1;
  select s.account_id into v_red from public.company_account_settings s
   where s.company_id = p_company and s.purpose = 'rounding_difference' and s.effective_to is null
   order by s.effective_from desc limit 1;

  drop table if exists _cent_k;
  drop table if exists _cent_l;
  create temp table _cent_k on commit drop as
    select b.id, b.warehouse_id, b.product_id, b.lot_id, b.quantity, b.value, b.moves_count,
           case when b.quantity = 0 and abs(b.value) <= 0.005 * b.moves_count
                  then -b.value                          -- polvo de redondeo: entero a redondeo
                else round(b.value, 2) - b.value         -- solo la fracción de céntimo
           end as adj
      from public.stock_balances b
     where b.company_id = p_company and b.value <> round(b.value, 2);
  select coalesce(sum(adj), 0) into v_k_total from _cent_k;
  select g.diferencia into v_gap from platform.inventory_ledger_gap(p_company) g;
  v_gap := coalesce(v_gap, 0);
  -- Sin cuenta de inventario no hay línea de inventario que escribir: va a la cola.
  if v_inv is not null then
    v_adj_inv := v_k_total + (v_gap - round(v_gap, 2));
  end if;

  create temp table _cent_l on commit drop as
    select jl.account_id, sum(jl.functional_debit - jl.functional_credit) as saldo,
           round(sum(jl.functional_debit - jl.functional_credit), 2)
             - sum(jl.functional_debit - jl.functional_credit) as adj
      from public.journal_lines jl
      join public.journal_entries e on e.id = jl.entry_id
     where jl.company_id = p_company and e.status in ('posted', 'reversed')
       and jl.account_id is distinct from v_inv and jl.account_id is distinct from v_red
     group by jl.account_id
    having sum(jl.functional_debit - jl.functional_credit)
           <> round(sum(jl.functional_debit - jl.functional_credit), 2);

  -- Las posiciones VACÍAS que quedan con valor después de regularizar: no son redondeo, son
  -- diferencia de costo (ADR-0034 §Negativo). Se listan, no se tocan.
  select coalesce(jsonb_agg(jsonb_build_object(
           'stock_balance_id', b.id, 'warehouse_id', b.warehouse_id, 'warehouse', w.code,
           'product_id', b.product_id, 'product', pr.sku, 'product_name', pr.name,
           'lot_id', b.lot_id, 'value', (b.value + coalesce(k.adj, 0))::text)
           order by b.id), v_vacio)
    into v_visibles
    from public.stock_balances b
    join public.products pr on pr.id = b.product_id
    join public.warehouses w on w.id = b.warehouse_id
    left join _cent_k k on k.id = b.id
   where b.company_id = p_company and b.quantity = 0 and b.value + coalesce(k.adj, 0) <> 0;

  v_hay_k := exists (select 1 from _cent_k);
  v_asienta := exists (select 1 from _cent_l) or v_adj_inv <> 0;
  -- La fila de cola (descartada con acta) cubre los movimientos del kardex que no van a tener
  -- asiento: la empresa sin cuenta de inventario, y el caso en que las fracciones netean a cero
  -- exacto y el mayor no trae ninguna (un asiento de importe cero no es un hecho, LAD59).
  v_encola := v_hay_k and (v_inv is null or not v_asienta);

  if not v_hay_k and not v_asienta then
    return jsonb_build_object('company_id', p_company, 'regularized', false,
                              'visible_empty_positions', v_visibles);
  end if;
  if v_asienta and v_red is null then
    raise exception 'la empresa % no tiene «Diferencias por redondeo» (rounding_difference): asígnala y vuelve a correr',
      p_company using errcode = 'LAD41';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('stock_balance_id', k.id, 'warehouse_id',
           k.warehouse_id, 'product_id', k.product_id, 'lot_id', k.lot_id,
           'quantity', k.quantity::text, 'value', k.value::text, 'adjustment', k.adj::text)
           order by k.id), v_vacio) into v_kardex from _cent_k k;
  select coalesce(jsonb_agg(jsonb_build_object('account_id', l.account_id,
           'balance', l.saldo::text, 'adjustment', l.adj::text) order by l.account_id), v_vacio)
    into v_mayor from _cent_l l;
  -- El ensayo también dice si el asiento NO se podría postear hoy: período cerrado (LAD61).
  v_cerrado := v_asienta and exists (
    select 1 from public.fiscal_periods p
     where p.company_id = p_company and p.kind = 'regular' and p.status = 'closed'
       and p.year = extract(year from v_fecha)::int
       and p.month = extract(month from v_fecha)::int);
  if p_ensayo then
    return jsonb_build_object('company_id', p_company, 'regularized', false, 'dry_run', true,
                              'kardex', v_kardex, 'ledger', v_mayor,
                              'inventory_adjustment', v_adj_inv::text,
                              'inventory_ledger_gap', v_gap::text,
                              'would_queue', v_encola,
                              'period_closed', v_cerrado,
                              'visible_empty_positions', v_visibles);
  end if;

  -- El kardex: una revalorización por posición, con la regularización como documento de origen.
  for v_k in select * from _cent_k where adj <> 0 order by id loop
    insert into public.inventory_moves
      (tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, rounding_policy_id,
       occurred_at, reason, source_document_id)
    values (v_tenant, p_company, v_k.warehouse_id, v_k.product_id, v_k.lot_id, 'revaluacion', 0,
            v_k.adj, v_moneda, 1, v_k.adj, v_moneda, 'identidad', now(),
            'ledger:cents:2:HALF_UP', now(),
            'Regularización del céntimo al corte (ADR-0075 §7)', v_reg);
  end loop;

  -- La fila de cola nace DESCARTADA, con su motivo y su acta, en esta misma transacción. No queda
  -- `pending`: ninguna plantilla podría resolverla (su importe es una fracción de céntimo, que al
  -- céntimo es cero) y una fila pendiente bloquea para siempre el cierre de períodos y de
  -- ejercicio de la empresa cuando adopte la contabilidad.
  if v_encola then
    v_motivo := case when v_inv is null
      then 'Regularización del céntimo sin contabilidad: no produce asiento; el corte de '
           || 'ADR-0060 valora el kardex al adoptar la contabilidad.'
      else 'Regularización del céntimo: las fracciones del kardex netean a cero exacto y el '
           || 'mayor no trae ninguna; no hay asiento que postear (importe cero).' end;
    insert into public.journal_generation_queue
      (tenant_id, company_id, source_kind, source_id, source_event, context, reason, status,
       processed_at)
    values (v_tenant, p_company, 'inventory_move', v_reg, 'stock.cent_regularized',
            jsonb_build_object('functional_currency', v_moneda, 'posting_date', v_fecha,
                               'description', 'Regularización del céntimo al corte (ADR-0075 §7)',
                               'value', v_k_total::text),
            v_motivo, 'discarded', now())
    returning id into v_cola;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_tenant, p_company, 'company', p_company, 'accounting.pending_discarded', 'system',
            now(), coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-repair'),
            jsonb_build_object('queue_id', v_cola, 'source_kind', 'inventory_move',
                               'source_id', v_reg, 'source_event', 'stock.cent_regularized',
                               'reason', v_motivo, 'adr', 'ADR-0075 §7'));
  end if;

  -- El asiento, en BORRADOR: del kardex y del mayor contra «Diferencias por redondeo».
  if v_asienta then
    insert into public.journal_entries
      (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
       description, memo, rules_version)
    values (v_tenant, p_company, platform.period_for_date(p_company, v_fecha), v_fecha,
            'inventory_move', v_reg, 'stock.cent_regularized',
            'Regularización del céntimo al corte (ADR-0075 §7)',
            'Asiento del sistema. Lleva a «Diferencias por redondeo» la fracción de céntimo que el '
            || 'kardex y el mayor arrastraban de antes de llevar todo al céntimo. No mueve dinero.',
            coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-repair'))
    returning id into v_entry;
    -- LA EXCEPCIÓN DE LAD71 ES ESTE REGISTRO, no una etiqueta: solo esta función escribe aquí.
    insert into platform.cent_regularization_entries (entry_id, company_id)
    values (v_entry, p_company);

    for v_l in
      select x.account_id, x.adj, x.d from (
        select l.account_id, l.adj, 'Fracción de céntimo del saldo'::text as d from _cent_l l
        union all
        select v_inv, v_adj_inv, 'Fracción de céntimo del inventario (kardex)' where v_adj_inv <> 0
      ) x order by x.account_id
    loop
      v_linea := v_linea + 1;
      v_suma := v_suma + v_l.adj;
      insert into public.journal_lines
        (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
         amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
         functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
         description)
      values (v_tenant, p_company, v_entry, v_linea, v_l.account_id,
              greatest(v_l.adj, 0), greatest(-v_l.adj, 0), abs(v_l.adj), v_moneda, 1, abs(v_l.adj),
              v_moneda, 'identidad', now(), greatest(v_l.adj, 0), greatest(-v_l.adj, 0), v_l.d);
    end loop;
    if v_suma <> 0 then
      v_linea := v_linea + 1;
      insert into public.journal_lines
        (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
         amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
         functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
         description)
      values (v_tenant, p_company, v_entry, v_linea, v_red,
              greatest(-v_suma, 0), greatest(v_suma, 0), abs(v_suma), v_moneda, 1, abs(v_suma),
              v_moneda, 'identidad', now(), greatest(-v_suma, 0), greatest(v_suma, 0),
              'Diferencias por redondeo (ADR-0075 §7)');
    end if;
    if v_linea < 2 then
      raise exception 'regularización de %: el asiento no tiene dos líneas (ajuste %)', p_company, v_suma
        using errcode = 'LAD41';
    end if;
  end if;

  return jsonb_build_object('company_id', p_company, 'regularized', true,
                            'regularization_id', v_reg, 'entry_id', v_entry,
                            'queue_id', v_cola,
                            'ledger_checked', v_inv is not null,
                            'posting_date', v_fecha, 'kardex', v_kardex, 'ledger', v_mayor,
                            'inventory_adjustment', v_adj_inv::text,
                            'rounding_line', (-v_suma)::text,
                            'inventory_ledger_gap_before', v_gap::text,
                            'visible_empty_positions', v_visibles);
end;
$$;
comment on function platform.cent_regularization_prepare(uuid, boolean) is
  'ADR-0075 §7: prepara la regularización del céntimo de una empresa (kardex + asiento en '
  'borrador; sin cuenta de inventario, una fila de cola DESCARTADA con acta). Una posición vacía solo va entera a redondeo '
  'si es polvo (|valor| ≤ 0,005 × movimientos); lo demás queda visible y se lista. Idempotente; '
  'con ensayo solo cuenta. La postea repairCents (dominio) y la cierra cent_regularization_finish. '
  'Sin GRANT: la corre el dueño de la base, después del pull.';

create or replace function platform.cent_regularization_finish(p_prep jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_company uuid := (p_prep ->> 'company_id')::uuid;
  v_entry uuid := (p_prep ->> 'entry_id')::uuid;
  v_cola uuid := (p_prep ->> 'queue_id')::uuid;
  v_antes numeric := (p_prep ->> 'inventory_ledger_gap_before')::numeric;
  v_despues numeric;
  v_tenant uuid;
begin
  if not coalesce((p_prep ->> 'regularized')::boolean, false) then
    return p_prep;
  end if;
  if v_entry is null and v_cola is null then
    raise exception 'regularización de %: ni asiento ni cola; no hay nada que cerrar', v_company
      using errcode = 'LAD41';
  end if;
  if v_entry is not null
     and not exists (select 1 from public.journal_entries e
                      where e.id = v_entry and e.company_id = v_company and e.status = 'posted') then
    raise exception 'regularización de %: el asiento % no está posteado', v_company, v_entry
      using errcode = 'LAD41';
  end if;
  if v_cola is not null
     and (not exists (select 1 from public.journal_generation_queue q
                      where q.id = v_cola and q.company_id = v_company and q.status = 'discarded')
          or not exists (select 1 from public.audit_events a
                          where a.company_id = v_company
                            and a.event_type = 'accounting.pending_discarded'
                            and a.payload ->> 'queue_id' = v_cola::text)) then
    raise exception 'regularización de %: la fila de la cola % no está descartada con su acta', v_company, v_cola
      using errcode = 'LAD41';
  end if;
  -- La comprobación que no se delega. Con cuenta de inventario: kardex = mayor no se movió más
  -- que su fracción de céntimo (inventory_ledger_gap ya cuenta como explicado lo descartado con
  -- acta). Sin ella no hay mayor contra el que comparar: se comprueba lo que la regularización
  -- prometía, que ninguna posición conserva fracción.
  select g.diferencia into v_despues from platform.inventory_ledger_gap(v_company) g;
  if coalesce((p_prep ->> 'ledger_checked')::boolean, v_cola is null)
     and coalesce(v_despues, 0) <> round(v_antes, 2) then
    raise exception 'regularización de %: inventory_ledger_gap pasó de % a %', v_company,
      v_antes, v_despues using errcode = 'LAD41';
  end if;
  if exists (select 1 from public.stock_balances b
              where b.company_id = v_company and b.value <> round(b.value, 2)) then
    raise exception 'regularización de %: queda una posición del kardex con fracción de céntimo',
      v_company using errcode = 'LAD41';
  end if;
  select c.tenant_id into v_tenant from public.companies c where c.id = v_company;
  -- El acta es también el CORTE de cent_gaps: nace en el mismo now() que lo regularizado.
  insert into public.audit_events
    (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
     actor_type, occurred_at, rules_version, payload)
  values (v_tenant, v_company, 'company', v_company, 'accounting.cent_regularized', 'system',
          now(), coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-repair'),
          p_prep || jsonb_build_object('adr', 'ADR-0075 §7',
                                       'inventory_ledger_gap_after', coalesce(v_despues, 0)::text));
  return p_prep || jsonb_build_object('inventory_ledger_gap_after', coalesce(v_despues, 0)::text);
end;
$$;
comment on function platform.cent_regularization_finish(jsonb) is
  'ADR-0075 §7: cierra la regularización del céntimo — exige el asiento posteado o la fila de la '
  'cola descartada con su acta, comprueba inventory_ledger_gap y que ninguna posición conserve fracción, y '
  'deja el acta accounting.cent_regularized (el corte de cent_gaps).';

-- ── 4. Los invariantes: asiento, cola pendiente, o descartada con acta ──────
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
                                            'purchase_revaluation')
                      and e.source_id in (mv.id, mv.source_document_id)) as asiento,
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.status = 'pending'
                      and q.source_kind in ('inventory_move', 'landed_cost', 'sales_cost',
                                            'stock_opening', 'goods_receipt', 'sales_return',
                                            'purchase_revaluation')
                      and q.source_id in (mv.id, mv.source_document_id)) as cola,
           -- 20261003190200 (ADR-0075 §7): DESCARTADA CON ACTA. La fila de cola que alguien
           -- descartó dejando el acta accounting.pending_discarded (con su motivo) es un hecho
           -- cerrado, no un hueco. Sin acta, una fila descartada NO cubre nada.
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.status = 'discarded'
                      and q.source_kind in ('inventory_move', 'landed_cost', 'sales_cost',
                                            'stock_opening', 'goods_receipt', 'sales_return',
                                            'purchase_revaluation')
                      and q.source_id in (mv.id, mv.source_document_id)
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
comment on function platform.inventory_coverage_gaps(uuid) is
  'INVARIANTE (ADR-0060, enunciado ampliado en 20261003190200): todo movimiento que cambia el '
  'valor del inventario tiene asiento posteado, fila de cola PENDIENTE, o fila de cola DESCARTADA '
  'CON ACTA (accounting.pending_discarded con su motivo). Una fila descartada sin acta no cubre '
  'nada. La respuesta correcta es CERO filas.';

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
                                             'purchase_revaluation')
                      and jq.source_id in (m.id, m.source_document_id))
  )
  select k.v, l.v, k.v - l.v, q.v from k, l, q
$function$;

-- ── 5. Las filas pendientes que ya existan ──────────────────────────────────
do $$
declare
  v_q record;
  v_motivo constant text :=
    'Regularización del céntimo sin contabilidad: no produce asiento; el corte de '
    || 'ADR-0060 valora el kardex al adoptar la contabilidad.';
begin
  for v_q in
    select q.id, q.tenant_id, q.company_id, q.source_id
      from public.journal_generation_queue q
     where q.source_kind = 'inventory_move' and q.source_event = 'stock.cent_regularized'
       and q.status = 'pending'
  loop
    update public.journal_generation_queue
       set status = 'discarded', processed_at = now(), reason = v_motivo
     where id = v_q.id;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_q.tenant_id, v_q.company_id, 'company', v_q.company_id,
            'accounting.pending_discarded', 'system', now(), 'db-migration',
            jsonb_build_object('queue_id', v_q.id, 'source_kind', 'inventory_move',
                               'source_id', v_q.source_id,
                               'source_event', 'stock.cent_regularized', 'reason', v_motivo,
                               'origin', 'migration_20261003190200', 'adr', 'ADR-0075 §7'));
  end loop;
end $$;

-- Los privilegios de las funciones redefinidas no cambian (create or replace conserva el ACL).

-- ── Reversibilidad (con datos vivos) ────────────────────────────────────────
-- · assert_entry_balanced: create or replace con 20261003190000 §3 (vuelve la excepción por
--   etiqueta, que es el defecto). Los asientos posteados no se ven afectados en ningún sentido.
-- · cent_regularization_prepare / _finish: create or replace con 20261003190000 §5. Las filas de
--   cola ya descartadas quedan descartadas (con la 190000 de vuelta, _finish las rechazaría: se
--   revierte junto con inventory_coverage_gaps, o no se revierte).
-- · inventory_coverage_gaps / inventory_ledger_gap: create or replace con 20260917120000. Al
--   revertir, los movimientos cubiertos por una fila descartada con acta vuelven a salir como
--   `missing`: el dato no cambia, cambia lo que el invariante acepta.
-- · platform.cent_regularization_entries e is_cent_regularization_entry: drop DESPUÉS de revertir
--   assert_entry_balanced. Sus filas son marcas, no hechos: borrarlas no cambia ningún asiento.
-- · Las actas accounting.pending_discarded son audit_events (append-only): quedan.

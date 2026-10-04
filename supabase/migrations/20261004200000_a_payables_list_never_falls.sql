-- =============================================================================
-- Ladino — UNA LISTA DE CUENTAS POR PAGAR NUNCA SE CAE, Y EL MARGEN DE LA TASA DEJA ACTA
-- (arreglos de la revisión de 20261004195900; regla 8 de CLAUDE.md; ADR-0075 §5 y §6)
--
-- Módulo: dinero (compras: cuentas por pagar) y auditoría de plataforma. Rigor máximo.
-- Spec:   docs/04_PLATFORM/MONEY_AND_ROUNDING_SPEC.md · ADR-0075 (nota «ola 4 · una sola regla
--         de la tasa del día») · RISK_REGISTER R-85.
-- Reversible: SÍ en esquema (ver al final); las actas escritas quedan (append-only).
-- HOMOLOGATION_IMPACT: NO — no cambia ningún documento, libro, asiento ni cifra guardada. Cambia
--   cómo RESPONDE una lectura cuando falta la tasa (NULL en vez de excepción) y deja acta de un
--   cambio de parámetro. No sube el semver de las reglas (ADR-0079): ninguna regla cambia.
--
-- Qué pasaba.
--   1. Desde 20261004195900 «no hay tasa» incluye «la última tiene más días que el margen».
--      `platform.supplier_debt_today` LANZABA LAD51 en ese caso, también sobre una factura en
--      divisa ya PAGADA y con saldo cero: el estado de cuenta de un proveedor que no debe nada
--      respondía 500, y `platform.ap_aging` con él. La deuda de clientes ya devolvía NULL
--      (20261003210200, «una lista nunca se cae»). Dos tratos para la misma situación.
--   2. Cambiar el margen (`platform.parameters`) no dejaba rastro: es el dato del que depende
--      toda conversión de todos los inquilinos.
--
-- Qué cambia.
--   1. `platform.supplier_debt_today`: sin tasa dentro del margen NO lanza. Si a la factura no
--      se le debe nada (está `paid`, o su saldo es cero) devuelve 0 sin necesitar tasa; si se le
--      debe, NULL: «no se puede valorar hoy». Con tasa, EXACTAMENTE la cifra de antes.
--   2. `platform.ap_aging`: un tramo con una factura sin valorar lleva el importe en NULL (y la
--      factura CUENTA), como `ar_aging`. Con tasa, exactamente lo de antes.
--   3. Acta `platform.parameter_changed` en `public.system_audit_events` por cada insert, update
--      o delete de `platform.parameters`.
--
-- NULL NO ES CERO. Quien suma estas cifras tiene que mirar el NULL: `sum()` y `greatest(x, 0)`
-- lo descartan en silencio. La API de esta entrega lo mira; LA DESPLEGADA NO (ver al final).
--
-- Funciones que redefine: platform.supplier_debt_today (parte de 20260916170000 §1, su única
-- definición) y platform.ap_aging (parte de 20260916170000 §2, la última). Ninguna migración
-- posterior a esta las toca (comprobado contra 20261004205000). Lee `platform.rate_at`,
-- `platform.supplier_invoice_balance` (20261003170000), `platform.parameters` (20261003210000) y
-- `public.system_audit_events` (20261004120000): todas anteriores.
-- =============================================================================

-- ── 1. La deuda de hoy con el proveedor: sin tasa no lanza ───────────────────
-- Parte de la definición VIVA (20260916170000 §1). Única diferencia: la rama `v_rate is null`.
create or replace function platform.supplier_debt_today(p_company uuid, p_invoice uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_inv record;
  v_rate numeric;
  v_saldo numeric;
  v_escala int;
begin
  select i.status, i.transaction_currency, i.functional_currency
    into v_inv
    from public.supplier_invoices i
   where i.id = p_invoice and i.company_id = p_company and i.status in ('posted', 'paid');
  if not found then return null; end if;

  v_escala := platform.currency_minor_units(v_inv.functional_currency);
  v_saldo := platform.supplier_invoice_balance(p_company, p_invoice);

  if v_inv.transaction_currency = v_inv.functional_currency then
    return round(v_saldo, v_escala);
  end if;

  -- La fecha, declarada: el DÍA de Caracas de ahora (date contra date dentro de rate_at).
  v_rate := platform.rate_at(p_company, v_inv.transaction_currency, v_inv.functional_currency,
                             platform.caracas_day(now()));
  if v_rate is null then
    -- UNA LISTA NUNCA SE CAE. Lo que no se debe no necesita tasa para decirse: una factura
    -- pagada está cerrada (ADR-0075 §4) y un saldo cero es cero a cualquier tasa. Lo que SÍ se
    -- debe no se puede valorar hoy: NULL, que no es cero — quien lo lee dice «falta la tasa».
    if v_inv.status = 'paid' or v_saldo = 0 then
      return round(0::numeric, v_escala);
    end if;
    return null;
  end if;
  return round(v_saldo * v_rate, v_escala);
end;
$$;
comment on function platform.supplier_debt_today(uuid, uuid) is
  'Lo que se le debe HOY a un proveedor por esta factura, en moneda funcional y en céntimos: el '
  'saldo en la moneda de la factura, a la tasa del día (ADR-0047, migración 65). NUNCA lanza por '
  'una tasa: sin tasa dentro del margen (platform.rate_for), una factura pagada o sin saldo '
  'devuelve 0 y una con saldo devuelve NULL — «no se puede valorar hoy», que NO es cero. Quien '
  'sume estas cifras tiene que mirar el NULL: sum() y greatest(x, 0) lo descartan en silencio.';

-- ── 2. La antigüedad de lo que se debe: el tramo sin valorar va en NULL ──────
-- Parte de la definición VIVA (20260916170000 §2). Diferencias: lee el nominal para saber si una
-- factura sin valorar DEBE (y entonces cuenta), y el importe del tramo es NULL si alguna de las
-- suyas no se pudo valorar. Con tasa, las mismas filas y las mismas cifras.
create or replace function platform.ap_aging(
  p_company uuid, p_supplier uuid default null, p_reference date default current_date
)
returns table (supplier_id uuid, bucket text, document_count bigint, amount numeric)
language sql
stable
set search_path = ''
as $$
  with saldos as (
    select i.supplier_id, i.id,
           (p_reference - coalesce(i.due_date, i.invoice_date)) as dias,
           platform.supplier_invoice_balance(p_company, i.id) as nominal,
           platform.supplier_debt_today(p_company, i.id) as saldo
      from public.supplier_invoices i
     where i.company_id = p_company
       and i.status in ('posted', 'paid')
       and (p_supplier is null or i.supplier_id = p_supplier)
       and i.invoice_date <= p_reference
  )
  select s.supplier_id,
         case when s.dias <= 30 then '0-30'
              when s.dias <= 60 then '31-60'
              when s.dias <= 90 then '61-90'
              else '90+' end,
         count(*),
         case when bool_or(s.saldo is null) then null else sum(s.saldo) end
    from saldos s
   where s.saldo > 0 or (s.saldo is null and s.nominal > 0)
   group by 1, 2
   order by 1, 2
$$;
comment on function platform.ap_aging(uuid, uuid, date) is
  'Antigüedad de lo que se debe a proveedores, en moneda funcional a la tasa de hoy '
  '(platform.supplier_debt_today), en los cuatro tramos de ar_aging. Un tramo con alguna factura '
  'en divisa que no se puede valorar hoy (sin tasa dentro del margen) lleva amount en NULL y la '
  'factura CUENTA en document_count: NULL no es cero. Nunca lanza por una tasa.';

-- ── 3. Cambiar un parámetro de plataforma deja acta ──────────────────────────
-- `platform.parameters` no tiene inquilino: su acta va a `system_audit_events`, como la de la
-- tasa oficial (20261004120100, mismo patrón: SECURITY DEFINER porque quien escribe el parámetro
-- no tiene —ni debe tener— INSERT sobre el acta).
--
-- El alias del margen (20261004195900) produce una SEGUNDA escritura: cambiar
-- `official_rate_max_age_days` actualiza `closing_rate_max_age_days` desde su trigger espejo, y
-- al revés. Son dos filas que cambian, así que son dos actas; la de la escritura espejo lo dice
-- (`mirrored_from`), para que quien las lea no vea dos decisiones donde hubo una. Este trigger
-- solo INSERTA en otra tabla: no escribe en `platform.parameters`, luego no puede hacer bucle; el
-- del espejo se detiene solo (`is distinct from`).
create function platform.record_parameter_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_old numeric;
  v_new numeric;
  v_nota boolean := false;
  v_espejo text;
begin
  if tg_op = 'INSERT' then
    v_key := new.key; v_new := new.value;
  elsif tg_op = 'DELETE' then
    v_key := old.key; v_old := old.value;
  else
    if new.key is not distinct from old.key and new.value is not distinct from old.value
       and new.note is not distinct from old.note then
      return null;  -- no cambió nada que decir (solo `updated_at`)
    end if;
    v_key := new.key; v_old := old.value; v_new := new.value;
    v_nota := new.note is distinct from old.note;
  end if;

  -- La escritura espejo del alias llega desde el trigger de la otra fila: un nivel más adentro.
  if pg_catalog.pg_trigger_depth() > 1
     and v_key in ('official_rate_max_age_days', 'closing_rate_max_age_days') then
    v_espejo := case v_key when 'official_rate_max_age_days' then 'closing_rate_max_age_days'
                           else 'official_rate_max_age_days' end;
  end if;

  insert into public.system_audit_events
    (aggregate_type, aggregate_id, event_type, occurred_at, payload)
  values ('platform_parameter',
          -- El acta pide un uuid y el parámetro se identifica por su clave: uno estable por clave.
          pg_catalog.md5('platform.parameters:' || v_key)::uuid,
          'platform.parameter_changed', pg_catalog.now(),
          pg_catalog.jsonb_build_object(
            'key', v_key,
            'operation', pg_catalog.lower(tg_op),
            'old_value', v_old::text,
            'new_value', v_new::text,
            'previous_key', case when tg_op = 'UPDATE' and new.key is distinct from old.key
                                 then old.key end,
            'note_changed', v_nota,
            'mirrored_from', v_espejo,
            'written_by_role', session_user::text));
  return null;
end;
$$;
revoke all on function platform.record_parameter_change() from public;
comment on function platform.record_parameter_change() is
  'Acta de plataforma (system_audit_events, platform.parameter_changed) de cada alta, cambio o '
  'baja de platform.parameters: clave, valor anterior y nuevo, y el rol que lo escribió. El '
  'margen de la tasa oficial vive ahí y de él depende toda conversión: quitar este trigger deja '
  'cambiarlo sin rastro. La escritura espejo del alias deja su propia acta con mirrored_from.';

-- El nombre lo ordena ANTES que `parameters_official_rate_age_alias`: el acta de la escritura
-- original se inserta antes que la de su espejo, y se leen en el orden en que pasaron.
create trigger parameters_a_record
  after insert or update or delete on platform.parameters
  for each row execute function platform.record_parameter_change();

comment on table public.system_audit_events is
  'Acta de las operaciones de la PLATAFORMA, que no tienen inquilino: la captura de la tasa oficial del BCV (B-14) y los cambios de platform.parameters (platform.parameter_changed). Append-only. La escribe el actor de sistema o un trigger de la base; no se lee por la API.';

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos)
--   · Esquema: otra migración con `supplier_debt_today` y `ap_aging` de 20260916170000 devuelve
--     la excepción; `drop trigger parameters_a_record` y `drop function
--     platform.record_parameter_change()` quitan el acta. Ninguna función guarda estado.
--   · Lo que NO se deshace: las actas `platform.parameter_changed` ya escritas (append-only).
--   · Ningún dato existente cambia: no hay backfill ni reescritura.
--
-- CON LA API HOY DESPLEGADA: NO ES COMPATIBLE PARA LECTURAS. APLICAR JUSTO DESPUÉS DEL GIT PULL,
-- en la misma ventana que 20261004195900.
--   · La API desplegada suma sin mirar el NULL: `/v1/negocio/resumen` hace
--     `sum(greatest(supplier_debt_today(...), 0))` y el estado de cuenta `sum(supplier_debt_today)`
--     y `coalesce(sum(amount), 0)` sobre `ap_aging`. Con esta migración y SIN tasa dentro del
--     margen, esa API deja de responder 500 y pasa a enseñar un total SIN la deuda en divisa
--     —«Lo que debo: Bs 0,00» debiendo dólares—. Es el modo de fallo silencioso: peor que el 500
--     que deja 20261004195900 sola. La API de esta entrega mira el NULL y dice «Falta la tasa de
--     hoy» con el nominal por moneda.
--   · Con tasa dentro del margen, las dos API responden las mismas cifras que antes.
--
-- Comprobación ANTES de la ventana, en la base con datos (sustituye a la del pie de
-- 20261004195900, que llevaba el 7 escrito a mano). Lee el margen del PARÁMETRO, con el nombre
-- que tenga antes o después de aplicar. Las dos consultas deben dar 0 filas; si no, cargar la
-- oficial de esos días o decidir el margen con el asesor antes de aplicar:
--
--   -- (a) cobros en otra moneda que el documento, sin lo saldado congelado, cuyo día no tiene
--   --     tasa oficial dentro del margen: su documento pasa a «saldo sin valorar».
--   with m as (
--     select coalesce(
--              (select value::int from platform.parameters where key = 'official_rate_max_age_days'),
--              (select value::int from platform.parameters where key = 'closing_rate_max_age_days')) as dias)
--   select p.id, platform.caracas_day(p.paid_at) as dia
--     from public.payments p
--     join public.documents d on d.id = p.document_id
--    cross join m
--    where p.currency <> d.transaction_currency
--      and p.settled_transaction_amount is null
--      and not exists (select 1 from public.exchange_gain_loss g
--                       where g.payment_id = p.id and g.fx_rate_payment > 0)
--      and not exists (select 1 from public.exchange_rates r
--                       where r.company_id is null
--                         and r.from_currency = d.transaction_currency
--                         and r.to_currency = d.functional_currency
--                         and r.rate_date between platform.caracas_day(p.paid_at) - m.dias
--                                             and platform.caracas_day(p.paid_at));
--
--   -- (b) huecos de más días que el margen en la serie GLOBAL de tasas, hasta hoy: los días
--   --     posteriores a `ultima + margen` y anteriores a `siguiente` no tienen «tasa del día».
--   with m as (
--     select coalesce(
--              (select value::int from platform.parameters where key = 'official_rate_max_age_days'),
--              (select value::int from platform.parameters where key = 'closing_rate_max_age_days')) as dias),
--   serie as (
--     select from_currency, to_currency, rate_date as ultima,
--            lead(rate_date) over (partition by from_currency, to_currency order by rate_date) as siguiente
--       from (select distinct from_currency, to_currency, rate_date
--               from public.exchange_rates where company_id is null) d)
--   select s.from_currency, s.to_currency, s.ultima,
--          coalesce(s.siguiente, platform.caracas_day(now()) + 1) as siguiente,
--          coalesce(s.siguiente, platform.caracas_day(now()) + 1) - s.ultima - 1 as dias_sin_publicar,
--          s.siguiente is null as hasta_hoy
--     from serie s cross join m
--    where coalesce(s.siguiente, platform.caracas_day(now()) + 1) - s.ultima - 1 > m.dias
--    order by s.from_currency, s.to_currency, s.ultima;
-- =============================================================================

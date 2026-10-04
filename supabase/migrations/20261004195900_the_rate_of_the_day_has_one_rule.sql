-- =============================================================================
-- Ladino — UNA SOLA REGLA DE LA TASA DEL DÍA
-- (regla 8 de CLAUDE.md; resto de D-09 de la ola 3; ADR-0075 §6, ADR-0064 §1, ADR-0066)
--
-- Módulo: dinero (ventas, cobros, compras, pagos, tesorería, inventario, contabilidad).
--         Rigor máximo: es la tasa con la que se convierte todo documento.
-- Spec:   docs/04_PLATFORM/MONEY_AND_ROUNDING_SPEC.md · ADR-0020 · ADR-0064 · ADR-0075 §6.
-- Reversible: SÍ en esquema (ver al final); lo que se rechazó mientras rigió no se «recupera».
-- HOMOLOGATION_IMPACT: YES en contenido — cambia CUÁNDO hay tasa para convertir un documento
--   fiscal (una factura en divisa ya no sale con una tasa de hace un mes); no cambia ninguna
--   forma, libro ni cifra de un documento ya emitido. El valor del margen sigue «decidido por
--   criterio»: VALIDAR-CONTABLE P-88 y VALIDAR-TRIBUTARIO P-22 (PENDIENTES_ASESOR).
--
-- SUSTITUYE A 20261004200000_one_rule_for_the_rate_of_the_day.sql, que NUNCA se aplicó en
-- ninguna base: su `insert` en `platform.rules_releases` pedía la 1.1.0, que
-- 20261004120200 (escrita en paralelo) ya había tomado, y falló entero (23505, deshecho). Una
-- migración existente no se edita, así que la corrección es esta, con el mismo contenido y la
-- versión 1.2.0. ESE FICHERO TIENE QUE BORRARSE antes de commitear: con este aplicado vuelve a
-- fallar (el parámetro ya existe) y detiene `migration up` y `db reset` para todo lo posterior.
--
-- Qué pasaba. `platform.rate_for` (última definición: 20260916180000) devolvía «la oficial más
-- reciente no posterior a la fecha», SIN límite de antigüedad. Con la fuente caída un mes, una
-- venta, un cobro, una factura de proveedor, un pago, un gasto o una transferencia en divisa se
-- registraban a la tasa de hace un mes, sin avisar. La ola 3 puso el margen
-- (`platform.closing_rate`, 20261003210000) solo en el cierre de período y en la llegada: dos
-- reglas vivas para «la tasa del día», y la mayoría de las operaciones en la que no acota.
--
-- Qué cambia.
--   1. El margen pasa a llamarse por lo que es: `official_rate_max_age_days`. El nombre viejo
--      (`closing_rate_max_age_days`) se CONSERVA como alias hasta la ola Z (expand): un trigger
--      mantiene los dos valores iguales, se escriba el que se escriba. No hay dos datos.
--   2. `platform.rate_for` aplica el margen. Es el ÚNICO sitio: `rate_at` es `rate_for` reducido
--      al número (20260912120400, sin cambios) y `closing_rate` pasa a ser lo mismo. Todo
--      llamador —SQL o dominio— hereda la regla sin tocarlo; quien ya trataba «sin fila» o NULL
--      como falta de tasa (EXCHANGE_RATE_MISSING / LAD51 / «Falta la tasa de hoy») sigue igual.
--   3. `platform.closing_rate` deja de filtrar por su cuenta: delega en `rate_for`.
--   4. Sube la versión semántica de las reglas (ADR-0079): cambió una función de resolución.
--
-- Por qué en `rate_for` y no «que todos pasen por closing_rate»: `rate_for` es por donde ya pasa
-- todo (el dominio, la API, y `rate_at` debajo de las funciones de deuda y saldo). Mover cada
-- llamador a otra función deja la vieja viva y sin margen para el siguiente que la use; acotar
-- la función de abajo no deja ninguna vía sin la regla.
--
-- Lo que NO cambia: qué tasa se elige dentro del margen (la más reciente no posterior; a igual
-- día, la guardada más tarde), que solo existe la oficial (ADR-0064 §1), ni LIVA art. 25 (día no
-- hábil → ¿día hábil siguiente?): sigue abierto en P-22 y esta migración no lo decide.
--
-- Granularidad (CLAUDE.md §3): `date` contra `date`. `rate_date` es el día de la tasa y
-- `p_fecha` el día que decide quien llama; el margen se resta en días enteros.
--
-- Funciones que redefine: platform.rate_for (parte de 20260916180000, la última) y
-- platform.closing_rate (parte de 20261003210000, la única). Ninguna migración posterior a esta
-- las toca. Lee `platform.parameters` (20261003210000) y `platform.rules_releases`
-- (20261004120000, con la 1.1.0 de 20261004120200): todas anteriores.
-- =============================================================================

-- ── 1. El margen, con el nombre de su uso; el viejo, de alias ────────────────
insert into platform.parameters (key, value, note)
select 'official_rate_max_age_days', p.value,
       'Antigüedad máxima, en días, de la tasa oficial del BCV que se admite como «tasa del día» '
       || 'de una fecha: para convertir cualquier operación y para el cierre de un período (fines '
       || 'de semana y feriados largos sin publicación). La lee platform.rate_for. Decidido por '
       || 'criterio (ADR-0075 §6, H7; ola 4): VALIDAR-CONTABLE P-88, VALIDAR-TRIBUTARIO P-22.'
  from platform.parameters p
 where p.key = 'closing_rate_max_age_days';

update platform.parameters
   set note = 'ALIAS de official_rate_max_age_days, que es el dato que la regla lee '
              || '(platform.rate_for). Un trigger mantiene los dos valores iguales. Se retira en '
              || 'la ola Z. Decidido por criterio (ADR-0075 §6, H7): VALIDAR-CONTABLE P-88.'
 where key = 'closing_rate_max_age_days';

do $comprobar$
begin
  if (select count(*) from platform.parameters
       where key in ('official_rate_max_age_days', 'closing_rate_max_age_days')) <> 2
     or (select count(distinct value) from platform.parameters
          where key in ('official_rate_max_age_days', 'closing_rate_max_age_days')) <> 1 then
    raise exception
      'el margen de la tasa oficial no quedó sembrado con sus dos nombres: sin él, rate_for no devuelve ninguna tasa';
  end if;
end
$comprobar$;

create function platform.mirror_official_rate_age()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- `is distinct from` es lo que detiene la recursión: el espejo solo escribe si hay diferencia.
  update platform.parameters p
     set value = new.value, updated_at = new.updated_at
   where p.key = case new.key when 'official_rate_max_age_days' then 'closing_rate_max_age_days'
                              else 'official_rate_max_age_days' end
     and p.value is distinct from new.value;
  return null;
end;
$$;
comment on function platform.mirror_official_rate_age() is
  'El alias del margen de la tasa oficial: official_rate_max_age_days (el dato que lee '
  'platform.rate_for) y closing_rate_max_age_days (su nombre hasta la ola 3) valen siempre lo '
  'mismo. Quitar este trigger antes de retirar el nombre viejo deja a quien todavía lo escribe '
  'cambiando un dato que ninguna regla lee.';
revoke execute on function platform.mirror_official_rate_age() from public;

create trigger parameters_official_rate_age_alias
  after insert or update of value on platform.parameters
  for each row
  when (new.key in ('official_rate_max_age_days', 'closing_rate_max_age_days'))
  execute function platform.mirror_official_rate_age();

-- ── 2. LA regla: la oficial vigente a la fecha, dentro del margen ────────────
-- Parte de la definición VIVA (20260916180000 §1). Única diferencia: la línea del margen. Sin la
-- fila del parámetro la resta da NULL y no hay tasa: la regla falla cerrada.
create or replace function platform.rate_for(
  p_company uuid, p_from text, p_to text, p_fecha date, p_source text default null)
returns table (rate numeric, source text, rate_date date, rate_timestamp timestamptz)
language sql
stable
set search_path = ''
as $$
  select r.rate, r.source, r.rate_date, r.rate_timestamp
    from public.exchange_rates r
   where r.from_currency = p_from and r.to_currency = p_to
     and r.rate_date <= p_fecha
     -- El margen (regla 8): una tasa más vieja que esto no es «la del día» de p_fecha.
     and r.rate_date >= p_fecha - (select p.value::int from platform.parameters p
                                    where p.key = 'official_rate_max_age_days')
     -- Solo existe la tasa del BCV (ADR-0064 §1). Las tecleadas antes de la migración 66
     -- son historia: ninguna conversión las lee.
     and r.company_id is null
     and (p_source is null or r.source = p_source)
   order by r.rate_date desc, r.created_at desc
   limit 1
$$;
comment on function platform.rate_for(uuid, text, text, date, text) is
  'LA tasa del día de una fecha, y la única regla que la decide: la OFICIAL del BCV (company_id '
  'nulo) del día más reciente que no sea posterior a la fecha NI más antiguo que '
  'platform.parameters.official_rate_max_age_days; a igual día, la más recientemente guardada. '
  'Fuera del margen, o sin el parámetro, no devuelve fila: quien convierte se detiene '
  '(EXCHANGE_RATE_MISSING / LAD51) y quien solo muestra dice que falta la tasa. rate_at y '
  'closing_rate son esta misma consulta reducida al número. p_company se conserva por contrato.';

-- ── 3. La tasa de cierre es la tasa del día de la fecha de cierre ────────────
-- Parte de la definición VIVA (20261003210000 §2). Deja de filtrar por su cuenta: el margen ya
-- lo aplica `rate_for`. Se conserva la función (y su firma) porque el cierre, la revaluación y
-- la llegada la llaman, también desde la API hoy desplegada.
create or replace function platform.closing_rate(p_company uuid, p_from text, p_to text, p_as_of date)
returns numeric
language sql
stable
set search_path = ''
as $$
  select f.rate from platform.rate_for(p_company, p_from, p_to, p_as_of, null) f
$$;
comment on function platform.closing_rate(uuid, text, text, date) is
  'La tasa de CIERRE (ADR-0075 §6, H7): la tasa del día de la fecha de cierre según '
  'platform.rate_for —la oficial más reciente no posterior y dentro del margen '
  'official_rate_max_age_days—. No tiene regla propia. Fuera del margen devuelve NULL: el '
  'cierre se detiene y pide la tasa.';

-- ── 4. La versión de las reglas (ADR-0079) ───────────────────────────────────
insert into platform.rules_releases (semver, note) values
  ('1.2.0', 'Ola 4: la tasa del día tiene una sola regla. platform.rate_for aplica el margen de '
            || 'antigüedad (official_rate_max_age_days) a toda conversión, no solo al cierre.');

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos)
--   · Esquema: otra migración con `rate_for` de 20260916180000 y `closing_rate` de
--     20261003210000 devuelve el comportamiento anterior. El parámetro nuevo, su trigger y la
--     fila 1.2.0 de `rules_releases` (append-only) pueden quedarse: revertir sube otra versión.
--     Ninguna de las dos funciones guarda estado.
--   · Lo que NO se deshace: mientras rija, una operación en divisa sin tasa dentro del margen se
--     RECHAZA (no escribe nada); no hay dato que corregir después, pero tampoco operación que
--     «aparezca» al revertir. Los documentos ya emitidos conservan su tasa congelada: no se tocan.
--   · Lo que CAMBIA sobre datos que ya existen — lecturas que recalculan a una fecha pasada:
--       (a) `document_balance_transaction_at` valora un cobro en OTRA moneda que el documento,
--           anterior a 20261003170000 (sin lo saldado congelado ni fila en exchange_gain_loss),
--           con `rate_at` del día del cobro. Si la última oficial de ese día era más vieja que el
--           margen, antes daba un saldo y ahora NULL (o LAD51 en modo estricto: el cierre se
--           detiene y dice de qué día falta la tasa).
--       (b) el historial de precios (C-11) deja sin cifra un precio cuyo día no tiene tasa dentro
--           del margen (`missing`), donde antes enseñaba la última anterior.
--       (c) las deudas «a la tasa de hoy» (clientes: NULL y «Falta la tasa de hoy»; proveedores:
--           `supplier_debt_today` lanza LAD51, como ya hacía sin ninguna tasa) dejan de valorarse
--           cuando la última oficial tiene más días que el margen.
--     Comprobación ANTES de aplicar en una base con datos (debe dar 0 filas; si no, cargar la
--     oficial de esos días o decidir el margen con el asesor antes de la ventana):
--       select p.id, platform.caracas_day(p.paid_at) as dia
--         from public.payments p
--         join public.documents d on d.id = p.document_id
--        where p.currency <> d.transaction_currency
--          and p.settled_transaction_amount is null
--          and not exists (select 1 from public.exchange_gain_loss g
--                           where g.payment_id = p.id and g.fx_rate_payment > 0)
--          and not exists (select 1 from public.exchange_rates r
--                           where r.company_id is null
--                             and r.from_currency = d.transaction_currency
--                             and r.to_currency = d.functional_currency
--                             and r.rate_date between platform.caracas_day(p.paid_at) - 7
--                                                 and platform.caracas_day(p.paid_at));
--   · Con la API hoy desplegada y esta migración: funciona (misma firma y mismas columnas). Es
--     más estricta desde el momento de aplicar: una operación en divisa sin tasa reciente
--     responde EXCHANGE_RATE_MISSING con el mensaje que esa versión ya tenía. Expand: no quita
--     ni renombra nada que esa API consulte.
-- =============================================================================

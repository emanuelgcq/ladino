-- =============================================================================
-- Ladino — «SU QUINCENA» ES LA DE LA PERCEPCIÓN, NO EL RANGO DE LA CONSULTA
-- (ADR-0075 §8, AF-M11; revisión de la última ronda de «moneda», punto 3)
--
-- Módulo: IGTF. Rigor máximo (fiscal).
-- Spec:   docs/02_COMPLIANCE/IGTF_SPEC.md (§ «El total de un período») · ADR-0075, nota «última
--         ronda» · PA SNAT/2022/000013 art. 4 · el corte de quincena es el de
--         `platform.fiscal_fortnight` (20261002120000; calendario de sujetos pasivos especiales).
-- Reversible: SÍ — es una función de LECTURA, sin estado. Otra migración la devuelve a su texto
--   de 20261003220000 §3. No toca tablas ni datos.
-- HOMOLOGATION_IMPACT: YES — cambia el total de IGTF que Ladino ENSEÑA para un rango que no sea
--   exactamente una quincena (un mes, un día, un rango libre). Para una quincena exacta el
--   resultado es el mismo que con 20261003220000. No cambia ningún documento ni libro de IVA.
--   Sigue sujeto a VALIDAR-TRIBUTARIO P-89.
--
-- QUÉ PASABA (20261003220000:118-145). «Reversada después» se decidía contra `p_to`, el fin del
-- RANGO que pide quien consulta:
--   · con un rango de un MES, una percepción del día 5 reversada el 20 no contaba, aunque la
--     primera quincena ya se había declarado con ella: Σ de las dos quincenas ≠ el mes;
--   · con un rango de UN día, una percepción reversada al día siguiente, dentro de su misma
--     quincena (nunca llegó a declararse), contaba.
--
-- QUÉ CAMBIA. Solo `platform.igtf_period_totals` (parte de su definición VIVA, la de
-- 20261003220000, la única): la reversa se compara con el FIN DE LA QUINCENA DE LA PERCEPCIÓN
-- (`platform.fiscal_fortnight(día de Caracas de occurred_at)`), no con `p_to`. Así cada percepción
-- cuenta o no cuenta por sí misma, el total de cualquier rango es la suma de sus percepciones, y
-- Σ quincenas = mes. Misma firma, mismas columnas, mismos GRANT (create or replace los conserva).
--
-- LO QUE NO CAMBIA, y se dice:
--   · Sin rango (NULL, NULL) el total sigue siendo SOLO lo percibido vigente (pgTAP 110 §21 lo
--     asevera y esa aserción no se toca). Decidido por criterio; la alternativa —aplicar la regla
--     también sin rango— queda anotada en ADR-0075.
--   · La OTRA vía a `pendiente_reintegro` —la anulación de la factura (packages/domain/src/
--     sales.ts, «el borde de la anulación»)— no deja fila en `payment_reversals`, y
--     `igtf_perceptions` NO guarda el instante en que pasó a ese estado. Esa rama hoy no se
--     alcanza con IGTF percibido (una factura con cobros no se anula, ADR-0061), así que una
--     percepción `pendiente_reintegro` sin reversa de cobro sigue sin contar, como en la 220000.
--     Si esa rama llega a alcanzarse, la percepción necesita su propio instante (columna nueva)
--     para que las dos vías usen UNA regla: pregunta añadida a P-89.
-- =============================================================================

-- ENUNCIADO. Para las percepciones de la empresa cuyo día de Caracas cae en [p_from, p_to]
-- (cada extremo NULL = sin límite por ese lado):
--   · una percepción `percibido` cuenta siempre;
--   · una percepción `pendiente_reintegro` cuenta —y se dice aparte, en pending_refund_*— si y
--     solo si se pidió un rango (algún extremo no es NULL) y la reversa de su cobro
--     (`payment_reversals.reversed_at`, día de Caracas) es POSTERIOR al último día de la quincena
--     de la percepción;
--   · una `pendiente_reintegro` sin reversa de cobro (la anulación de la factura, rama que hoy no
--     se alcanza) no cuenta: no hay instante con que decidir.
-- GRANULARIDAD: `date` contra `date`, día de Caracas en los dos lados (CLAUDE.md §3).
-- COSTE: `fiscal_fortnight` no es inlinable (lleva SET search_path) y se evalúa una vez por
-- percepción del rango. No lee tablas; esta función no se llama desde ninguna policy ni por fila.
create or replace function platform.igtf_period_totals(p_company uuid, p_from date, p_to date)
returns table (total_functional numeric, pending_refund_functional numeric,
               pending_refund_count bigint)
language sql
stable
set search_path = ''
as $$
  with percepciones as (
    select ip.functional_amount, ip.status,
           (select f.period_to
              from platform.fiscal_fortnight(platform.caracas_day(ip.occurred_at)) f)
             as fin_de_su_quincena,
           (select platform.caracas_day(r.reversed_at)
              from public.payment_reversals r
             where r.company_id = ip.company_id and r.payment_id = ip.payment_id) as reversada_el
      from public.igtf_perceptions ip
     where ip.company_id = p_company
       and (p_from is null or platform.caracas_day(ip.occurred_at) >= p_from)
       and (p_to is null or platform.caracas_day(ip.occurred_at) <= p_to)
  ), contadas as (
    select functional_amount, status,
           -- NULL (sin reversa de cobro) se lee como falso en los FILTER de abajo.
           (status = 'pendiente_reintegro'
            and (p_from is not null or p_to is not null)
            and reversada_el > fin_de_su_quincena) as reversada_tarde
      from percepciones
  )
  select coalesce(sum(functional_amount) filter (
                    where status = 'percibido' or reversada_tarde), 0),
         coalesce(sum(functional_amount) filter (where reversada_tarde), 0),
         count(*) filter (where reversada_tarde)
    from contadas
$$;
comment on function platform.igtf_period_totals(uuid, date, date) is
  'El IGTF de un rango de días (PA SNAT/2022/000013 art. 4; ADR-0075 §8, AF-M11): '
  'total_functional = lo percibido vigente MÁS lo percibido cuyo cobro se reversó DESPUÉS del fin '
  'de la quincena DE LA PERCEPCIÓN (platform.fiscal_fortnight): esa quincena ya se declaró con '
  'ella, no se rebaja y se recupera por reintegro; pending_refund_* dice cuánto de ese total está '
  'pendiente de reintegro. La reversada dentro de su quincena no cuenta. Por eso el total de un '
  'rango es la suma de sus percepciones y Σ quincenas = mes. Sin rango (NULL, NULL), solo lo '
  'percibido vigente. Una percepción pendiente de reintegro SIN reversa de cobro (anulación de la '
  'factura: rama que hoy no se alcanza y que no guarda su instante) no cuenta (P-89). Día de '
  'Caracas. Toda lectura del total de IGTF de un período sale de aquí.';

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos): la función no guarda nada; con percepciones ya reversadas en
-- producción, volver al texto de 20261003220000 §3 solo cambia la cifra que se enseña para rangos
-- que no son una quincena exacta. Con la API saliente: la ruta `/v1/igtf/perceptions` de la
-- versión anterior a la 220000 no llama a esta función; la de la 220000 la llama con la misma
-- firma y recibe las mismas columnas.
-- Redefine: platform.igtf_period_totals (parte de 20261003220000, la última que la toca).
-- No crea ni suelta nada. Lee `platform.fiscal_fortnight` (20261002120000, anterior).
-- =============================================================================

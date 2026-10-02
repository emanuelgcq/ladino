-- =============================================================================
-- Ladino — la importación es un trabajo: los arreglos de la revisión (ADR-0074)
--
-- Módulo: catálogo · importación. Hallazgos C-01, C-04 y C-05 del recorrido 2026-09-24; revisión
-- H1, H3 y H11 de la familia «importación».
-- Spec: docs/03_MODULES/PRODUCTS_CATALOG_SPEC.md §Importación (ADR-0074). La migración anterior,
-- 20260928140000, cita por errata `PRODUCT_CATALOG_SPEC.md`: el fichero es
-- `PRODUCTS_CATALOG_SPEC.md`. No se corrige allí porque las migraciones aplicadas no se editan.
--
-- Qué cambia:
--
--   1. (H1-d, decidido por criterio) El ÚNICO de la llave pasa a PARCIAL, `where status <>
--      'failed'`: un archivo cuyo trabajo quedó `failed` se puede volver a subir y crea un trabajo
--      nuevo. Reimportar no duplica, porque dentro del trabajo el código del producto es la
--      llave. Alternativa descartada: reanudar el trabajo fallado (ver la spec).
--   2. (H1-c) `attempts` se reinicia cuando el trabajo AVANZA: cinco caídas pasajeras repartidas
--      a lo largo de un archivo no lo matan; cinco seguidas en la misma fila, sí.
--   3. (H3) La guarda exige que el avance sea de UNA fila (`old + 1`) y que la entrada nueva del
--      informe sea la de la fila que tocaba (`rows[old.processed_rows].row`). Informar dos veces
--      la misma fila, o saltarse una, se rechaza aunque los contadores cuadren.
--   4. (H3) El comentario de `product_import_jobs_report_chk` decía que era un «detector de doble
--      proceso». No lo es por sí solo: dos procesos que avanzan +1 cada uno con su entrada dejan
--      el contador y el informe alineados. La defensa de verdad es el `FOR UPDATE` del dominio más
--      la guarda del punto 3. Se corrige con COMMENT ON.
--   5. (H11, decidido por criterio — §2.12: «el costo sin existencia se acepta como costo de
--      referencia») `products.reference_cost` y `products.reference_cost_currency`, nullables y
--      juntas: el costo de referencia se GUARDA en el producto. Expand puro: la app saliente no
--      las lee ni las escribe. La moneda va aparte porque un importe sin moneda no dice nada.
--      Alternativa descartada: guardarlo solo en el informe del trabajo.
--
-- Reversibilidad: SÍ, con datos vivos y con pérdida acotada.
--   · el único parcial se revierte recreando el total SOLO si no hay dos trabajos del mismo
--     archivo (uno `failed` y su resubida): con datos vivos, antes hay que decidir cuál se queda;
--   · la guarda se revierte volviendo a la definición de 20260928140000;
--   · `reference_cost*` se revierten con `drop column`, y se PIERDEN los costos de referencia
--     guardados (siguen en el `report` de cada trabajo, de donde se pueden recuperar).
-- Impacto de homologación: NO (no toca documentos fiscales, numeración ni impuestos).
-- =============================================================================

-- ── 1. La llave, parcial ────────────────────────────────────────────────────
alter table public.product_import_jobs drop constraint product_import_jobs_key;
create unique index product_import_jobs_key
  on public.product_import_jobs (company_id, file_hash, number_format)
  where status <> 'failed';
comment on index public.product_import_jobs_key is
  'Llave natural del trabajo (ADR-0074, C-04): el mismo archivo con el mismo formato devuelve el '
  'trabajo existente. Parcial: un trabajo failed no bloquea volver a subir el archivo.';

-- ── 2 y 3. La guarda ────────────────────────────────────────────────────────
create or replace function platform.product_import_job_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_prev integer;
  v_debida jsonb;
begin
  if old.status in ('done', 'failed') then
    raise exception 'el trabajo de importación % ya terminó (%): no se modifica', old.id, old.status
      using errcode = '55000';
  end if;
  if new.rows is distinct from old.rows
     or new.file_hash is distinct from old.file_hash
     or new.file_name is distinct from old.file_name
     or new.number_format is distinct from old.number_format
     or new.row_count is distinct from old.row_count then
    raise exception 'lo que define el trabajo de importación (filas, archivo, formato) no cambia'
      using errcode = '55000';
  end if;
  if new.created_count < old.created_count
     or new.updated_count < old.updated_count
     or new.rejected_count < old.rejected_count then
    raise exception 'el progreso del trabajo de importación solo avanza' using errcode = '55000';
  end if;
  -- El avance es de UNA fila, y la entrada nueva del informe es la de la fila que tocaba.
  if new.processed_rows is distinct from old.processed_rows then
    if new.processed_rows <> old.processed_rows + 1 then
      raise exception 'el trabajo de importación avanza de una fila en una fila (% → %)',
        old.processed_rows, new.processed_rows using errcode = '55000';
    end if;
    v_debida := old.rows -> old.processed_rows;
    if (new.report -> old.processed_rows -> 'row') is distinct from (v_debida -> 'row') then
      raise exception 'la entrada nueva del informe no es la de la fila que tocaba (fila %)',
        v_debida -> 'row' using errcode = '55000';
    end if;
  end if;
  -- attempts solo baja a cero, y solo cuando el trabajo avanza (H1-c).
  if new.attempts < old.attempts
     and not (new.attempts = 0 and new.processed_rows = old.processed_rows + 1) then
    raise exception 'los intentos solo se reinician cuando el trabajo avanza'
      using errcode = '55000';
  end if;
  -- El informe crece por la cola: sus primeras entradas son EXACTAMENTE las de antes.
  v_prev := jsonb_array_length(old.report);
  if v_prev > 0 and jsonb_path_query_array(
       new.report, ('$[0 to ' || (v_prev - 1) || ']')::jsonpath) is distinct from old.report then
    raise exception 'el informe del trabajo de importación no se reescribe, solo crece'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

comment on function platform.product_import_job_guard() is
  'Guarda de product_import_jobs (ADR-0074): congela filas/archivo/formato; estados terminales '
  'inmutables; avance de una fila, con la entrada de informe de la fila que tocaba; intentos que '
  'solo se reinician al avanzar; informe que solo crece por la cola.';

-- ── 4. El comentario que decía de más ───────────────────────────────────────
comment on constraint product_import_jobs_report_chk on public.product_import_jobs is
  'Coherencia: una entrada de informe por fila procesada. NO detecta por sí solo el doble '
  'proceso (dos avances de +1 con su entrada quedan alineados): eso lo impiden el FOR UPDATE de '
  'procesarFilaDeTrabajo y la guarda product_import_job_guard, que exige que la entrada nueva sea '
  'la de la fila que tocaba.';

-- ── 5. El costo de referencia, en el producto ───────────────────────────────
alter table public.products
  add column reference_cost          numeric(24,8),
  add column reference_cost_currency text;

alter table public.products
  add constraint products_reference_cost_chk check (
    (reference_cost is null and reference_cost_currency is null)
    or (reference_cost is not null and reference_cost >= 0
        and reference_cost_currency ~ '^[A-Z]{3}$'));

comment on column public.products.reference_cost is
  'Costo de referencia (ADR-0074, C-05): el costo que trajo una importación sin existencia. '
  'Informativo: no mueve inventario ni contabilidad, y no es el costo del kardex.';
comment on column public.products.reference_cost_currency is
  'Moneda de reference_cost. Las dos columnas van juntas (products_reference_cost_chk).';

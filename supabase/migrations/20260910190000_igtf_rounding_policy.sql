-- =============================================================================
-- Ladino — migración 47: LA POLÍTICA DE REDONDEO DE LA PERCEPCIÓN DE IGTF
--
-- Módulos: fiscal · ventas. Rigor máximo (dinero).
-- ADR-0053. Encargo del dueño, 2026-09-10.
--
-- `igtf_perceptions` nació guardando `amount` y `functional_amount` sin decir
-- con qué regla se redondearon. MONEY_AND_ROUNDING_SPEC lo prohíbe en una
-- línea que no admite lectura: «`fx_rate` no se acepta sin `rate_source`;
-- `functional_amount` no se acepta sin `rounding_policy_id`». La tabla llevaba
-- `fx_rate` Y `rate_source`, y el `rounding_policy_id` se quedó fuera.
--
-- La columna se añade con la política que de VERDAD se aplicó a lo ya
-- registrado —ocho decimales, half-up, que es lo que hacía
-- `toDecimalPlaces(8, 4)`— y no con la nueva. Reescribir el pasado con la regla
-- de hoy convertiría 166 filas en una afirmación falsa: dirían que se
-- calcularon a dos decimales cuando no fue así. La historia se anota, no se
-- reinterpreta (regla 3 y ADR-0053, «lo que NO se toca»).
--
-- EL DEFAULT ES DE TRANSICIÓN, Y ES VERDAD. La API desplegada en el VPS va por
-- detrás del repositorio y su `registerPayment` inserta percepciones SIN esta
-- columna. Con `not null` a secas, aplicar esta migración antes de desplegar
-- la API nueva haría fallar CADA cobro en divisa con IGTF. Con el default, esa
-- API vieja sigue cobrando y sus filas quedan etiquetadas con lo que de verdad
-- hace —ocho decimales, half-up—; la API de ADR-0053 pasa siempre la política
-- explícita y el default no la toca. Así la migración se puede aplicar en
-- cualquier momento ANTES del despliegue, no en la misma ventana.
-- PENDIENTE: una migración posterior quita el default cuando la API nueva esté
-- en producción, para que ningún camino futuro herede la etiqueta por omisión.
--
-- Reversibilidad: `alter table ... drop column rounding_policy_id`. No se
-- pierde ningún importe: la columna es metadato del cálculo, no dinero.
-- =============================================================================

-- Las filas existentes reciben el default al añadir la columna: la política
-- con la que se calcularon (escala 8, HALF_UP).
alter table public.igtf_perceptions
  add column if not exists rounding_policy_id text not null
    default 'igtf:perception:8:HALF_UP';

-- Un identificador de política vacío es peor que no tenerlo: aparenta
-- trazabilidad. El formato es `dominio:concepto:escala:MODO`, el mismo que
-- emite `packages/money` y el que ya usan documentos e inventario.
alter table public.igtf_perceptions
  add constraint igtf_perceptions_rounding_policy_chk
  check (rounding_policy_id ~ '^[a-z_]+:[a-z_]+:[0-8]:[A-Z_]+$');

comment on column public.igtf_perceptions.rounding_policy_id is
  'Política de redondeo aplicada al calcular amount y functional_amount '
  '(ADR-0053). Formato dominio:concepto:escala:MODO. Las filas anteriores al '
  '2026-09-10 llevan igtf:perception:8:HALF_UP, que es la regla con la que se '
  'calcularon; desde ADR-0053 se redondea a las minor units de la moneda.';

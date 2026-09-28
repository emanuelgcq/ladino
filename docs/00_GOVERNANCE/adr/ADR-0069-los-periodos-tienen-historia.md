# ADR-0069 — Los períodos tienen historia

- **Estado:** ADR aplicado según la respuesta del dueño del 2026-09-28 (listado en el mensaje de apertura de la ola 1; §2.10 y K-01..K-06)
- **Fecha:** 2026-09-28
- **Impacto fiscal:** SÍ, por K-04: dónde entra al libro de compras una factura recibida con
  retraso.
- **Hallazgos:** K-01, K-02, K-03, K-04, K-05, K-06.

## Contexto

- **K-01:** ningún período cerrado se puede reabrir. `reopenFiscalPeriod` deja `closed_at` puesto,
  y `fiscal_periods_closed_chk` lo rechaza. El único test de reapertura (pgTAP 025) pasa porque
  inserta la fila ya en el estado final, sin recorrer el camino.
- **K-02:** aun arreglado, volver a cerrar violaría `fiscal_periods_reopened_chk`. El modelo guarda
  la historia en columnas de la fila, que solo admiten un ciclo.
- **K-03:** el cierre del ejercicio postea el 31-12 en diciembre. Si diciembre está cerrado (el
  orden normal), LAD61 lo rechaza.
- **K-04:** una factura de proveedor de un mes cerrado no entra.
- **K-05:** cualquier fecha entre 2000 y 2200 crea su período, incluso antes de que exista la
  empresa.
- **K-06:** un borrador no se puede descartar, y el de un mes cerrado queda zombi.

## Opciones consideradas

1. **Columnas en la fila** (hoy). En contra: un ciclo, y cada reapertura borra la anterior.
2. **La historia en `audit_events`.** En contra: la auditoría es un rastro, no un modelo de estado.
   Consultar «¿cuántas veces se reabrió?» contra un JSON es frágil.
3. **Tabla propia append-only `fiscal_period_events`** (cierre, reapertura, motivo, quién,
   cuándo), y la fila del período solo con el estado actual. Es la opción elegida por el dueño.

## Decisión

1. **`fiscal_period_events`** es append-only: `closed` · `reopened`, con motivo (obligatorio al
   reabrir), autor e instante. La fila de `fiscal_periods` guarda el estado actual y los últimos
   datos. Sus CHECK exigen coherencia con el estado, no la historia. Se permiten n ciclos.
2. **El período de cierre («13»).** Cada ejercicio tiene un período de cierre fechado el 31-12. Solo
   admite asientos de cierre y de ajuste del contador. Diciembre puede estar cerrado cuando se
   cierra el ejercicio. Reabrir el ejercicio reabre el 13.
3. **Fechas.**
   - El límite inferior es la **fecha de inicio de actividades** de la empresa. Se pide al alta; por
     omisión, la del alta.
   - No se crean períodos futuros más allá del período en curso.
   - Un borrador **no se crea** en un período cerrado: 409 con la salida (reabrir con motivo, o
     fechar en el período abierto).
   - Un borrador se **descarta**, con rastro.
4. **La factura de proveedor que llega tarde (K-04)** se registra en el **período abierto**, con la
   **fecha original del documento**. Entra al libro de compras del período en que se registra,
   marcada «recibida con retraso» y con su fecha original, y el crédito se deduce en ese período.
   Pasada la ventana legal para deducir, entra como costo sin crédito, y la pantalla lo dice. La
   ventana (LIVA art. 33) es data con fuente, y la pregunta sigue abierta en PENDIENTES_ASESOR.
   Reabrir el período con motivo sigue disponible para el contador.
5. **Cambiar la aserción de pgTAP 025 está autorizado** (dueño, 2026-09-28): pasa por la razón
   equivocada. El test nuevo recorre cerrar → reabrir → cerrar → reabrir.

## Consecuencias

- **Positivas.** El contador opera el ciclo real, el cierre anual funciona en el orden normal, y
  ningún documento de un mes cerrado queda fuera.
- **Negativas.**
  - Una tabla más, y una migración de los datos existentes: cada período cerrado recibe su evento
    `closed`, y cada reabierto su `reopened`.
  - «Recibida con retraso» añade una columna al libro de compras.
- **Para revertir:** la fila conserva el estado actual. Quitar la tabla de eventos devuelve el modelo
  de un ciclo sin perder el estado.

## Verificación

- pgTAP: cerrar → reabrir → cerrar → reabrir sobre el mismo período.
- pgTAP: cierre anual con diciembre cerrado.
- E2E: una factura tardía de un mes cerrado entra al período abierto con su fecha original.
- `pnpm recorrido K`: K-01..K-06 dejan de reproducir.

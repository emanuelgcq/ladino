# Reportes y libros fiscales

## Mínimos
- Libro de Ventas.
- Libro de Compras.
- Retenciones IVA.
- Retenciones ISLR.
- Resumen por alícuota.
- Documentos anulados/ajustados.
- NC/ND.
- Auditoría de facturas.
- Auditoría de cajas.
- Operaciones por canal/medio de facturación.
- Exportaciones requeridas por administración tributaria.

## Regla
El reporte fiscal no recalcula el pasado con reglas actuales. Lee snapshots del documento emitido.

## Reproducibilidad
Cada reporte debe persistir:
- parámetros;
- periodo;
- timezone;
- versión del generador;
- hash de dataset;
- generado por;
- generado en.

## Export
PDF, XLSX/CSV y TXT/XML solo donde el formato regulatorio lo exija/configure.

## Signo, anuladas y ajustes (migración 20260928120000 · RESPUESTA_RECORRIDO L-01, L-07, R-2)

Cada renglón del libro lleva su importe **con el signo con el que cuenta**, y la columna se suma tal
cual: el libro, la pantalla, el CSV exportado, la planilla y el mayor dicen la misma cifra.

| Documento | Libro de ventas (`platform.sales_book`) | Libro de compras (`platform.purchases_book`) |
|---|---|---|
| Factura | positivo | positivo |
| Nota de débito | positivo | — |
| Nota de crédito | **negativo** (criterio R-1) | **negativo**, en el período de su recepción (R-1) |
| Anulada | con su número, fecha y estado `annulled`, **importes en cero** (G-10, P-34) | en cero en su período (R-2) |
| Anulada después de cerrar y presentar su período | — | su período **no cambia** (sale como se generó, `posted`); en el período de la anulación, línea en **negativo** con estado `ajuste_periodo_anterior` (R-2 ampliada, P-46) |

- «Presentar» = el período contable estaba **cerrado** (`fiscal_periods.closed_at`) **y** su libro de
  compras ya se había generado (`fiscal_book_runs`) o su IVA declarado (`iva_period_results`) antes
  del momento de la anulación (`supplier_invoices.annulled_at`). La regla vive en
  `platform.supplier_invoice_late_annulment_day`; libro y planilla la leen de ahí.
- La planilla (`recompute_iva_period`) lleva la reversa en `ajuste_creditos_anteriores`, la casilla
  de ajustes a los créditos fiscales de períodos anteriores: aparte de `creditos_deducibles` (que
  sigue siendo el crédito del período tras la prorrata, nunca negativo), fuera de la prorrata, y
  dentro de la cuota y el excedente (migración 20260928120300; VALIDAR-TRIBUTARIO P-46).
- **Invariante:** `book_ledger_reconciliation()` — libro = mayor + cola — tiene que dar «cuadra».
  En el gate (`pnpm verify`, paso 11) lo prueban los pgTAP 074 (con una NC) y 078 (NC, ND,
  anulada y ajuste de período anterior). Sobre toda la historia de cada empresa del escenario lo
  mide `pnpm recorrido` (`scripts/recorrido/invariantes.sql`), que no forma parte del gate.
  Tabla de invariantes: CLAUDE.md §3. Su detalle,
  documento a documento y asiento a asiento, es `platform.book_ledger_discrepancies()`, y la pantalla
  solo dice que falta un asiento cuando `accounting_coverage_gaps()` lo confirma (L-06).

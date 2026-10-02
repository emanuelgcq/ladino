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
- Desde la migración 20261002120000 (L-05) la planilla tiene **dos arrastres**: el ajuste entra en el
  excedente de **crédito fiscal** (`excedente_siguiente`), nunca en el de retenciones
  (`retenciones_acumuladas_por_descontar`). Periodicidad, imputación y fórmula: `IVA_SPEC.md`,
  «La declaración del período» (quincena del especial, mes del ordinario, L-04).
- **Invariante:** `book_ledger_reconciliation()` — libro = mayor + cola — tiene que dar «cuadra».
  En el gate (`pnpm verify`, paso 11) lo prueban los pgTAP 074 (con una NC) y 078 (NC, ND,
  anulada y ajuste de período anterior). Sobre toda la historia de cada empresa del escenario lo
  mide `pnpm recorrido` (`scripts/recorrido/invariantes.sql`), que no forma parte del gate.
  Tabla de invariantes: CLAUDE.md §3. Su detalle,
  documento a documento y asiento a asiento, es `platform.book_ledger_discrepancies()`, y la pantalla
  solo dice que falta un asiento cuando `accounting_coverage_gaps()` lo confirma (L-06).

## Por alícuota y resumen del art. 72 (migración 20260928150000 · RESPUESTA_RECORRIDO L-08 · ADR-0073)

- El libro de ventas se lee de `platform.sales_book_by_rate`: el renglón de `sales_book` (mismo
  signo, anuladas en cero) más `base_alicuota_general`, `iva_alicuota_general`,
  `alicuota_general`, y lo mismo para `adicional` (general + adicional) y `reducida`. Se lee de
  la categoría **congelada** en la línea (ADR-0044 §1); el IVA de cada alícuota es total − subtotal
  funcionales, así que las tres suman `iva_debito`.
- El **resumen** (RLIVA art. 72) viaja en `summary` de la respuesta del libro de ventas, desde
  `platform.sales_book_summary`: por concepto (`gravado_general`, `gravado_adicional`,
  `gravado_reducida`, `exento`, `exonerado`, `no_sujeto`, `sin_clasificar`) y alícuota, base,
  IVA, la parte que viene de notas (`adjustments_*`) y el número de documentos. Exportaciones: no
  implementadas (VALIDAR-SENIAT), no aparecen.
- `BOOK_GENERATOR_VERSION` = `fiscal-books/1.3.0`: el CSV de ventas tiene once columnas más (nueve por alícuota más `base_gravada_sin_alicuota` e
  `iva_sin_clasificar`, migración 20260928150200) y
  un período ya exportado da otro hash al regenerarse (RISK_REGISTER R-57).

### Revisión del 2026-09-29 (migración 20260928150200, H5 y H6)

- `sales_book_by_rate` trae además `base_gravada_sin_alicuota` (base gravada sin categoría
  reconocida; debería ser cero) e `iva_sin_clasificar` (IVA de las líneas fuera de las tres
  alícuotas: las anteriores a la migración 27, sin categoría congelada). Con ellas, en **cada
  renglón**: Σ `base_alicuota_*` + `base_gravada_sin_alicuota` = `base_gravada`, y Σ
  `iva_alicuota_*` + `iva_sin_clasificar` = `iva_debito`. La base de esas líneas sin categoría
  sigue en `base_sin_clasificar` (fuera de `base_gravada`). Lo prueba el pgTAP 081b con factura, NC
  y anulada, junto con Σ del resumen = totales del libro.
- **El resumen del art. 72 entra en el hash** del libro de ventas exportado (`hashDelDataset`): se
  firman los renglones y, tras el rótulo «RESUMEN (RLIVA art. 72)», las filas del resumen.
  El CSV «columnas legales» sigue siendo solo cabecera + renglones. El resumen se descarga como
  fichero propio de la misma generación, `resumen-art72.csv`
  (`POST /v1/fiscal-books/runs/{id}/summary-art72`, permiso `fiscal_book.export`, idempotente): no
  crea otra generación ni cambia el hash, y si el libro cambió desde entonces responde 422. También
  se sirve en la respuesta del libro (`summary`) y en la pantalla.

### Re-revisión del 2026-10-02 (B1)

- **El hash firma el libro legal.** En ventas, `hashDelDataset` deja fuera `journal_entry_id`
  (contabilidad) y sustituye el `status` operativo por el estado legal (`estado_legal`: «anulada» o
  «vigente»). Cobrar una factura del período (issued → paid) o asentarla no cambia el hash.
  `BOOK_GENERATOR_VERSION` sigue en 1.3.0 (no publicada).
- **La exportación de ventas trae el resumen** del art. 72 de esa generación en la misma transacción y
  respuesta (`summary_content`, `summary_filename` = `resumen-art72.csv`), y la pantalla descarga
  los dos ficheros. La ruta hermana `POST /v1/fiscal-books/runs/{id}/summary-art72` queda para volver
  a descargarlo: si la generación es de otra versión del generador lo dice («exporta de nuevo»), y si
  el libro cambió de verdad, 422 «El libro de ventas cambió desde esa generación…».

### Auditoría fiscal de la ronda (migración 20260928170300: hallazgos 6 y 11)

- **Compras por alícuota** (P-59, lectura conservadora): el libro de compras se lee de
  `platform.purchases_book_by_rate`, con las mismas once columnas que ventas. La categoría sale de
  cada línea congelada; la NC recibida toma la de la línea de factura que devuelve.
  `base_gravada_sin_alicuota` e `iva_sin_clasificar` son lo que el renglón trae y las líneas no
  explican (cero en un documento limpio). Su resumen (`purchases_book_summary`) va en la misma
  exportación (`resumen-art72-compras.csv`), en la respuesta del libro y en el hash.
- **El control completo en ventas**: el libro y su CSV llevan `control_identifier` junto a
  `control_number` (ADR-0071).
- `BOOK_GENERATOR_VERSION` sigue en 1.3.0 (no publicada).

### El comprobante de retención en los libros (migraciones 20261002110000 y 20261002110200; ADR-0072 §4 y §6)

- `BOOK_GENERATOR_VERSION` = `fiscal-books/1.4.0`. **Cambian los hashes del libro de compras y del
  libro de retenciones de IVA:** un período ya exportado, regenerado, da otro hash, y la versión dice
  por qué.
- **Compras** (`purchases_book_with_vouchers`, sobre `purchases_book_by_rate` sin tocarla): número,
  fecha e IVA retenido del comprobante emitido en el período (H-12); el de otro período que su factura
  sale en el de su emisión como renglón `comprobante_retencion` con importes en cero, firmado con ese
  estado legal.
- **Retenciones de IVA** (`iva_retention_book`): del comprobante-documento, con la identidad
  congelada al emitir, tipo de documento, total, base, exento, IVA causado, alícuota, vencimiento y
  entrega; una versión reemplazada hasta el cierre del período sale `annulled`; `original_issued_on`
  dice cuándo se emitió la versión 1.
- **TXT**: los 16 campos de P-7; sin versiones anuladas ni correcciones de comprobantes declarados en
  un período anterior (P-65, con aviso en la exportación).

### Revisión de los cambios fiscales (migración 20260928170400: A1, A2, F6)

- **A2:** la NC recibida se reparte por el tratamiento de la línea de factura que devuelve: la que
  devuelve lo exento resta de `base_exenta` (y de exonerada o no sujeta, igual), no de gravadas.
  La NC sin línea de origen sigue en gravadas, como antes.
- **A1:** el residuo de redondeo entre el renglón y sus alícuotas (menor que un céntimo) va a la
  alícuota mayor del renglón; ya no sale como «sin alícuota» ni como fila «sin_clasificar» falsa en
  el resumen.
- **F6:** `unclassified_rows` cuenta también los renglones con `base_gravada_sin_alicuota` o
  `iva_sin_clasificar` distintos de cero.

## Libro de ventas: IGTF aparte y comprobante soportado (auditoría fiscal 2.ª ronda, migración 20261002120200)

- **La ND por IGTF (H1, P-70)** sale en el libro con su número, control y estado, con **todos los
  importes de venta en cero** (no suma en «no sujeta» ni en el total) y su monto en la columna
  `igtf_percibido` («IGTF percibido (no es venta)»). El resumen del art. 72 no la incluye.
- **El comprobante de retención soportado (H5; PA SNAT/2025/000054 art. 16 in fine)**: el libro que
  se exporta es `platform.sales_book_with_receipts`. El renglón de la factura identifica el
  comprobante ENTREGADO en el período (`retention_receipt_number`, `retention_received_on`,
  `retention_iva`); si la factura es de otro período, sale en el de la entrega como renglón propio
  «comprobante_retencion», con importes en cero. Espejo del libro de compras (H-12).
- Generador `fiscal-books/1.5.0`: cambia el hash del libro de ventas.

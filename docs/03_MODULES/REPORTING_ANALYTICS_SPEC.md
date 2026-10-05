# Reportes y analítica


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Proveer reporting operativo, financiero y gerencial reproducible.

## Entidades
- `report_definitions`
- `report_runs`
- `dashboard_widgets`

## Reglas de negocio
- Reportes financieros salen del ledger.
- Fiscal usa snapshots fiscales.
- Permisos aplican a filas y columnas sensibles.
- Exportación grande asíncrona.

## Estados / transiciones
run queued→running→completed/failed.

## Permisos
- según rol.
- export financiero requiere permiso.

## API / eventos
- `POST /v1/reports/:id/run`
- `GET /v1/report-runs/:id`

## Criterios de aceptación
- [ ] Mismo corte produce mismo resultado.
- [ ] Excel/PDF coincide con pantalla.

## Casos límite
- millones de líneas.
- timezone.
- periodo cerrado.

## Dependencias
- All modules
- Storage

---

## Lo construido (ola 5, 2026-10-04): los primeros reportes y las carteras (P-07, F-13, H-11)

Lo de arriba es el plan de 2026-08: `report_definitions`, `report_runs`, `dashboard_widgets` y
`POST /v1/reports/:id/run` **no existen**. Lo que existe es esto.

### Forma

- Cada reporte es **una lectura del dominio** (`packages/domain/src/reports.ts`) servida por una
  ruta `GET /v1/reports/…` (`apps/api/src/routes/reports.ts`). Sin migración: leen tablas y las
  funciones de `platform` que ya eran la fuente de cada cifra.
- **Una sola forma de respuesta** para todos (`ReportTable`, `packages/schemas/src/reports.ts`):
  columnas tipadas (`text`, `date`, `integer`, `quantity`, `money`, `percent`), filas, totales por
  columna, un resumen de cifras con nombre y notas en voz de persona. La pantalla la pinta sin
  calcular (`apps/web/src/components/TablaDeReporte.tsx`); la descarga sale de la misma tabla.
- **Dinero:** texto decimal, redondeado al servir (`round(x, 2)` en SQL). Ninguna suma en
  TypeScript ni en la web. `null` no es cero: trae motivo (`sin_tasa`, `sin_permiso`, `sin_dato`).
- **Fechas:** todo rango son dos días de Caracas (`from`, `to`, incluidos); cada instante se lleva
  a su día con `platform.caracas_day`. «Hoy» es `platform.caracas_day(now())`.
- **Descarga:** `format=csv` o `format=xlsx` en la misma ruta; la genera el servidor
  (`apps/api/src/report-export.ts`) con todas las filas. CSV con `;`, BOM y `\r\n`; coma decimal
  sin separador de miles; fechas día/mes/año. En el `.xlsx` las cifras son **texto** (ver
  decisiones).
- **Paginación:** `page` y `per_page` (200 por omisión, 500 como máximo); `row_count` dice
  cuántas filas hay.

### Los reportes, en el orden del dueño

| # | Ruta | Qué responde | Fuente | Con qué cuadra (test) |
|---|---|---|---|---|
| 1 | `/v1/reports/sales` | Ventas del rango por `group` = `day`, `month`, `product`, `customer`, `payment_method`, `seller` | `documents`, `document_lines`, `payments` | «ventas con factura» + los retiros del libro = total de `platform.sales_book` del rango, con retiros y una nota de débito por IGTF dentro (E2E fiscal y recorrido P); los días suman el total |
| 2 | `/v1/reports/margin` | Venta sin impuesto − costo, por `product`, `month` o `day`; el diferencial cambiario realizado como línea del resumen | `document_lines.cost_snapshot`, `sale_line_components` (el costo de un producto compuesto: Σ de sus salidas `out`, y Σ de sus reingresos `back` al devolver), `returns`, `exchange_gain_loss` | venta + venta sin costo = base del reporte de ventas; diferencial = `/v1/reports/exchange-difference`; un día con devolución con costo, devolución de línea sin costo, servicio y nota de débito da las cifras escritas a mano en el E2E, y la nota cuenta UNA línea vendida sin costo (su devolución no es otra); un compuesto de dos ingredientes vendido (3) y devuelto (1) por HTTP: costo = Σ de `sale_line_components`, y no va a «venta sin costo» |
| 3 | `/v1/reports/iva` | Débitos, créditos, retenciones soportadas y practicadas, a pagar o excedente, por período | `iva_period_results` (lo que calculó `recompute_iva_period`), `supplier_retentions` | con un período calculado DOS veces y una factura emitida ENTRE las dos corridas sale UNA fila, la de la corrida más reciente: lleva los débitos de la segunda (160,00 más) y no los de la primera (E2E fiscal; visto en rojo con el orden invertido); dos notas fijas dicen que es un resumen de gestión y no la declaración, y que las retenciones practicadas no restan de «A pagar»; las retenciones practicadas, solo en 0,00 |
| 4 | `/v1/reports/inventory` | Existencia y valor a hoy; vendido en el rango y días de existencia | `stock_balances`, `inventory_moves`, `returns` | total = kardex de `platform.inventory_ledger_gap`; «vendido» = salidas por factura o recibo − lo repuesto al anularlos − lo que volvió por una devolución confirmada, todo por el día del movimiento (E2E: 3 vendidas, 1 devuelta, vendido 2; un retiro no cuenta) |
| 5 | `/v1/reports/receivables` · `/v1/reports/payables` | Las carteras: por tercero, nominal por moneda, deuda a la tasa de hoy, vencido, vencimiento y tramos | `platform.ar_aging`, `customer_overdue_today`, `document_debt`; `platform.ap_aging`, `supplier_debt_today`, `supplier_invoice_balance` | cada fila y el total = `ar_aging` / `ap_aging` |
| 6 | `/v1/reports/cash-closings` | Esperado, contado y diferencia, por `closing` o por `cashier` | `cash_closings` | un faltante y un sobrante de dos personas: cada uno con su signo, sin compensarse en el resumen, y una fila por persona (E2E); en el recorrido, cuenta y diferencia = las filas del rango |
| 7 | `/v1/reports/igtf` | Lo percibido y lo que queda por reintegrar, por quincena | `platform.igtf_period_totals` | con un cobro en divisa que percibe: la quincena = lo percibido en el cobro = la función, distinto de cero (E2E fiscal) |

Qué es una **venta** en (1) y (2): factura, recibo y nota de débito emitidos, menos notas de
crédito y recibos de devolución; las anuladas no cuentan. La nota de débito por IGTF no es venta
y la factura de retiro de inventario (ADR-0082) tampoco: las dos están en el libro de ventas y no
aquí. Por eso «Ventas con factura» **no es el total del libro de ventas**: el libro lleva además
los retiros (facturas de retiro y sus notas) y las notas de débito por IGTF. La conciliación es
`ventas con factura + retiros del libro = total del libro` (la nota de débito por IGTF va en el
libro con total de venta cero y lo percibido en su columna), y es la que comprueban el E2E fiscal
y el caso P-07 del recorrido, contra el libro entero. El resumen separa además «con recibo».

### Quién ve cada reporte (RESPUESTA §2.8)

Ningún permiso nuevo. Basta uno de la lista; los roles son los de sistema a 2026-10-04.

| Reporte | Permiso (uno) | Dueño | Administrativo | Contador | Encargado | Cajero | Almacenista |
|---|---|---|---|---|---|---|---|
| Ventas · Margen | `treasury.read` · `accounting.read` | sí | sí | sí | no | no | no |
| IVA del período · IGTF | `fiscal_book.read` | sí | no | sí | no | no | no |
| Inventario: existencias | `warehouse.read` · `inventory.move` · `inventory.adjust` · `accounting.read` · `treasury.read` | sí | sí | sí | sí | no | sí |
| Inventario: **valor** y costo | `accounting.read` · `treasury.read` | sí | sí | sí | no (`sin_permiso`) | — | no (`sin_permiso`) |
| Quién me debe | `ar.read` | sí | sí | sí | sí | sí | no |
| Qué debo | `ap.read` | sí | sí | sí | no | no | no |
| Cierres de caja | `treasury.read` (el de su lista, `GET /v1/cash-closings`; `cash_register.read` no lo abre) | sí | sí | no | no | no | no |
| **Descargar** cualquiera | además `report.export` | sí | sí | sí | no | no | no |

El menú «Reportes» sigue pidiendo `report.export` (`apps/web/src/app/nav.ts`): el encargado, el
cajero y el almacenista llegan a su cartera o a su inventario por la pantalla de su oficio, no por
el menú. El servidor responde igual a quien pida la ruta con el permiso.

### Las carteras (F-13, H-11)

- **«Quién me debe»** vive en `/admin/cuentas` cuando no hay cliente elegido (antes: «Elige un
  cliente»). El nombre de cada fila abre su estado de cuenta. `?orden=vencido` llega ordenada por
  lo vencido.
- La lista de clientes ordenada por deuda (`/admin/clientes?orden=vencido`, adonde llevan «Te
  deben…» y «Ver quién me debe») **es** la lista de quién debe: lleva arriba el resumen de la
  cartera (total, vencido, nominal por moneda) y un enlace a la cartera por antigüedad. No se
  duplicó la lista.
- **«Qué debo»** vive en la pestaña «Cuentas por pagar» de `/admin/compras` cuando no hay
  proveedor elegido (elegir una fila abre su cuenta) y arriba de «Compras» en `/compras`, adonde
  lleva «Ver qué debo».

### Decidido por criterio (§2.16), con su alternativa

| Qué | Decidido | Alternativa descartada |
|---|---|---|
| Permisos | los de lectura que ya gobernaban cada cifra; descargar exige además `report.export` | un permiso por reporte (mueve el conteo de los roles de sistema); que ver baste para descargar |
| El cajero | ve la cartera de clientes (tiene `ar.read`: cobra) y no la descarga | cerrarle la cartera (ya ve la deuda de cada cliente en la lista) |
| Dónde vive la cartera | en la pantalla donde el hallazgo la echó en falta; la lista de clientes lleva el resumen | una pantalla nueva en el menú; duplicar la lista con otro orden |
| Excel | las cifras van como texto con coma decimal | celdas numéricas: exigen pasar el importe por `number` (CLAUDE.md §1.7) |
| Por forma de pago | lo COBRADO en el rango (incluye cobros de ventas anteriores) | repartir cada venta entre sus cobros |
| Vendedor | quien emitió el documento (`created_by`) | `vendor_id`, que solo llevan 34 de los 218 documentos de la base local |
| Rotación | unidades vendidas en el rango (netas de devoluciones y anulaciones, restadas el día en que la mercancía vuelve) y días que dura la existencia de hoy a ese ritmo | costo de ventas entre inventario promedio: pide saldos históricos que no se guardan; restar la devolución en el período de la venta original |
| Línea de mercancía sin costo | no entra en el margen y se dice aparte («Venta sin costo») | darle costo cero (infla el margen) |
| Revaluación de saldos en divisa | `null` con `sin_dato`: Ladino no registra ese hecho | servir 0 |
| IVA | los períodos guardados que tocan el rango; sin período calculado, la nota lo dice | recalcular al vuelo (dos cifras para un mismo período) |
| Retenciones practicadas | las de IVA no canceladas, por el día en que se practicaron | por la quincena del comprobante (VALIDAR-TRIBUTARIO, P-104) |
| IGTF | cada quincena que toca el rango, entera | cortar la quincena por el rango (no es lo que se declara) |
| Tramos de la cartera | los de `ar_aging` (días desde la emisión) y `ap_aging` (días desde el vencimiento), sin tocar | unificarlos: cambia dos funciones con datos y sus tests |

### Lo que no está

- Reporte diario para el cajero (su cierre) y comparativos entre períodos.
- Exportación asíncrona: todo se arma en la petición.
- La cartera recorre los documentos tres veces por petición (una por cada función de deuda;
  eran siete antes de la segunda ronda). Bajar de tres pide una función de `platform` que dé
  deuda, vencimiento y tramo en una pasada. Detalle y lo que queda sin test: R-89.

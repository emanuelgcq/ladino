# Checklist de la factura, la nota de crédito y la nota de débito

> Fuente: PA SNAT/2011/00071 (G.O. 39.795, 08-11-2011), texto leído en
> https://tributos.ivecofi.net/informacion/legislacion/providencias/pa-2011-71, verificado el
> 2026-09-28 (reproducción no oficial). Los ID son **estables**: un test los recorrerá sobre el
> PDF real de cada clase de documento (decisión 2.4 del dueño, 2026-09-28). Ese test se escribe
> en la ola 2, con el modelo del PDF nuevo; hoy solo existe el del control único (pgTAP 075). La columna «Origen» distingue lo que exige la
> **norma** de lo que añade una **decisión del dueño**: un fallo de «norma» es incumplimiento; un
> fallo de «decisión» es un defecto de producto.
> Ladino emite sobre **formas libres** (art. 6 num. 2 y art. 31). Lo que la imprenta preimprime
> (art. 31) **no se imprime encima** (FC-18).

## A. Factura — PA 00071 art. 13

| ID | Numeral | Qué exige (paráfrasis) | Origen | Lo imprime | Cómo lo mira el test |
|---|---|---|---|---|---|
| FC-01 | 13.1 | La denominación «Factura» | norma | Ladino | el texto «Factura» presente |
| FC-02 | 13.2 | Numeración consecutiva y única | norma | Ladino | número presente; correlativo sin huecos por serie |
| FC-03 | 13.3 | Número de control preimpreso | norma | imprenta (forma libre) | Ladino registra el control; la vista previa lo sombrea; el PDF de cortesía lo muestra con identificador (FC-29) |
| FC-04 | 13.4 | Rango de control asignado: «desde el N° … hasta el N° …» | norma | imprenta | registrado en el talonario; no se sobreimprime |
| FC-05 | 13.5 | Nombre o razón social, domicilio fiscal y RIF del emisor | norma | Ladino (en forma libre la imprenta preimprime solo el RIF, art. 31) | los tres presentes, del snapshot; RIF con la grafía de FC-26 |
| FC-06 | 13.6 | Fecha de emisión en 8 dígitos | norma | Ladino | `dd/mm/aaaa` |
| FC-07 | 13.7 | Adquirente: nombre o razón social y RIF; persona natural sin uso tributario: cédula o pasaporte | norma | Ladino | RIF (o cédula o pasaporte) presente |
| FC-08 | 13.8 | Descripción de la venta o servicio con cantidad y monto; **«(E)»** junto a lo exento, exonerado o no sujeto | norma | Ladino | cada línea con cantidad y monto; toda línea de tratamiento 0 lleva «(E)» |
| FC-09 | 13.9 | Descripción y valor de recargos, fletes, descuentos, bonificaciones y anulaciones | norma | Ladino | cada ajuste con descripción y valor |
| FC-10 | 13.10 | Base imponible **discriminada por alícuota, con su porcentaje**, y total exento o exonerado | norma | Ladino | una línea de base por alícuota con «16 %», «8 %»…; una línea de exento |
| FC-11 | 13.11 | Impuesto **discriminado por alícuota, con su porcentaje** | norma | Ladino | una línea de IVA por alícuota con porcentaje |
| FC-12 | 13.12 | Valor total de la venta o suma de bienes y servicios | norma | Ladino | total = Σ bases + Σ IVA + exento (+ IGTF si FC-27) |
| FC-13 | 13.13 | En las copias, «sin derecho a crédito fiscal» | norma | Ladino | presente en toda copia; ausente en el original |
| FC-14 | 13.14 | En moneda extranjera: ambas cantidades, el total y el tipo de cambio | norma | Ladino | si hay precio en USD: montos en Bs y en USD, total en ambas y tasa |
| FC-15 | 13.15 | Razón social y RIF de la imprenta, y nomenclatura y fecha de su providencia | norma | imprenta | registrados en el talonario (2.1); sin ellos no hay rango |
| FC-16 | 13.16 | Fecha de elaboración de la forma, en 8 dígitos | norma | imprenta | registrada en el talonario |

## B. Soporte y conservación

| ID | Artículo | Qué exige | Origen |
|---|---|---|---|
| FC-17 | art. 29 | Original y copias con el mismo número de control | norma |
| FC-18 | art. 31 | En forma libre la imprenta preimprime solo: control, RIF del emisor, datos de la imprenta y su providencia, rango y fecha de elaboración; **nunca** la denominación ni el número del documento. Ladino imprime todo lo demás y deja en blanco lo preimpreso | norma (art. 31) + decisión 2.3 |
| FC-19 | art. 36 | Los originales y copias de lo anulado se conservan hasta la prescripción | norma |
| FC-20 | art. 44 | Numeración de control consecutiva y **única por emisor**: identificador de 2 dígitos + secuencial de hasta 8 | norma |

## C. Notas de crédito y débito — PA 00071 arts. 22-24

| ID | Artículo | Qué exige | Origen |
|---|---|---|---|
| FC-21 | art. 22 | Se emite NC o ND cuando la venta queda sin efecto total o parcial o hay que ajustarla, habiendo factura; la denominación «Nota de crédito» / «Nota de débito» en original y copias | norma |
| FC-22 | art. 23 | Todos los requisitos del art. 13 **salvo el numeral 1** (FC-02 a FC-20 aplican a la nota) | norma |
| FC-23 | art. 23 | Referencia a **fecha, número y monto** de la factura que corrige | norma |
| FC-24 | art. 24 (máquina fiscal, aplicado por analogía) | Número de **control** de la factura afectada | decisión 2.4 |
| FC-25 | art. 22 («por cualquier causa») | La **causa o motivo** impreso; la descripción y el valor del ajuste (13.9); el porcentaje de IVA (13.10-11) | norma (13.9-11) + decisión 2.4 (motivo) |
| FC-26 | — | NC y ND que corrigen una factura van **a la tasa de la factura** e imprimen «Tasa BCV de la factura N° … del dd/mm/aaaa: Bs …»; una ND por concepto nuevo va a la tasa de su día | decisión 2.7 |

## D. Reglas de la decisión 2.4 que el test también recorre

| ID | Qué | Origen |
|---|---|---|
| FC-27 | Si un SPE percibió IGTF: **alícuota y monto** del IGTF en el documento (PA SNAT/2022/000013 art. 6), en divisa y en Bs a la tasa del cobro | norma (PA 000013 art. 6) + decisión 2.6 |
| FC-28 | Ninguna leyenda de homologación ni cita de la PA 121 (derogada por la PA SNAT/2026/00084, G.O. 43.435 del 12-08-2026); la única leyenda legal del pie es FC-13 | norma (derogación) + decisión 2.3 |
| FC-29 | El control se muestra con su identificador: `00-00001234` | norma (art. 44, dos campos) + decisión 2.1 |
| FC-30 | RIF con la grafía `V-12345678-9` / `J-12345678-9`; nunca nueve cifras corridas. La norma exige el número (13.5, 13.7); la grafía es la del certificado del SENIAT | decisión 2.4 / M-05 |
| FC-31 | Columnas coherentes: precio unitario sin IVA, total de línea sin IVA, subtotal = suma de la columna, IVA por alícuota, total | decisión 2.4 / E-10 (desarrolla 13.8-13.12) |
| FC-32 | El PDF descargado o enviado lleva «Copia de cortesía · La factura válida es la impresa en forma libre con control N° …» | decisión 2.3 (el PDF no es factura: la factura digital solo existe por la PA 102) |
| FC-33 | «Anulación» como ajuste del 13.9 solo si el documento no salió del establecimiento (G-10); todo lo demás es NC | decisión G-10 (sobre arts. 13.9, 22 y 36) |

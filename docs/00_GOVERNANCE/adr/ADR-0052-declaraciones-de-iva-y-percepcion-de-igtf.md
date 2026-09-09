# ADR-0052 — Declaraciones de IVA y percepción de IGTF

- **Estado**: aceptada (orden del dueño, 2026-09-08; ejecutada 2026-09-09)
- **Fecha**: 2026-09-09
- **Módulos**: fiscal · ventas · tesorería · contabilidad
- **HOMOLOGATION_IMPACT**: NO. No toca numeración, formato de documento ni
  emisión. La percepción de IGTF en el papel de la factura es **contenido**,
  no formato homologado — y está marcado VALIDAR-TRIBUTARIO donde toca.

## Contexto

Ladino sabía qué había facturado y qué había comprado, pero no sabía **cuánto
tenía que declarar**. El contribuyente exportaba sus libros y hacía la
declaración a mano, sin arrastre de excedentes, sin las retenciones que le
practicaban y sin manera de reproducir el número que puso en el portal.

La investigación previa (dos rondas, más de diez fuentes) dejó tres cosas
claras y una incómoda:

1. **no hay API del SENIAT** para declarar IVA: la Forma 30 (99030) se llena a
   mano en el portal;
2. **el TXT de retenciones sí es carga por archivo**, con un layout publicado
   en una guía;
3. los sujetos pasivos especiales declaran **quincenalmente por dígito de
   RIF**, y son agentes de percepción del IGTF;
4. y lo incómodo: **las fechas concretas del calendario y el número de gaceta
   de la providencia vigente NO son reproducibles** desde las fuentes
   consultadas — las que se encontraron se contradicen entre sí.

De ahí sale la decisión que gobierna todo el módulo.

## La decisión que gobierna las demás

> **Ladino calcula lo que puede justificar, y declara lo que no puede.**

Todo lo que el sistema produce aquí es una **planilla demostrativa — NO
OFICIAL**: el cálculo de Ladino, reproducible por su huella, que el
contribuyente transcribe al portal. Donde faltaba una fuente citable, no se
eligió lo más parecido: se tomó la opción conservadora, se marcó, y se anotó
en `docs/02_COMPLIANCE/PENDIENTES_ASESOR.md` con qué se rompe si la respuesta
es otra.

Por eso la pantalla **no muestra números de casilla**. El mapeo con la Forma 30
no está confirmado, y un rótulo con aspecto oficial haría pasar por declaración
lo que es una ayuda de cálculo.

## Decisiones

### 1. La retención soportada es un INSTRUMENTO DE PAGO

Cuando un cliente-agente nos retiene el IVA, no estamos ante un descuento ni
ante un menor ingreso: estamos ante un **anticipo fiscal a nuestro favor** y
ante un cliente que **debe menos**. Modelarlo como cualquier otra cosa
obligaría a dos escrituras que podrían divergir.

- `supported_retention_receipts` guarda el comprobante **transcrito** (número
  tal como lo emitió el agente, fecha, base, porción y monto). La porción
  (0,75 o 1,00) es **dato del papel, no regla que Ladino resuelva**.
- El abono va por `payments` con el instrumento nuevo **`retencion_iva`**, sin
  cuenta de efectivo — igual que `saldo_a_favor`, y por la misma razón: no
  entró dinero. El `CHECK` de forma de cuenta se reescribió para que los
  abonos sin efectivo sean dos y ninguno lleve cuenta.
- Se aplica **entero y una sola vez**: un comprobante no es un monedero.
- Evento propio `ar.retention_applied` con su asiento (Dr IVA retenido por
  cobrar / Cr cuentas por cobrar), no la plantilla genérica del cobro — que
  debitaría caja.

### 2. El resultado del período es INSERT-ONLY con arrastre encadenado

`iva_period_results` sigue el patrón de `fiscal_book_runs`: cada generación es
una fila con su SHA-256 sobre las cifras exactas que se persistieron. **No se
edita ni se borra** (trigger, no convención). Si algo cambió, se genera otra y
manda la última.

El arrastre es una **cadena**: el excedente anterior sale de la última
generación del período que termina el día antes, nunca de un número tecleado.
Dos consecuencias deliberadas:

- **saltarse un eslabón falla** (422) en vez de asumir cero. Un cero puesto en
  silencio produce una cuota falsa que nadie detecta;
- **los períodos sin actividad se generan igual**, en cero. Son los eslabones
  que mantienen viva la cadena.

El cálculo (`platform.recompute_iva_period`) sale **de los snapshots** —
`tax_rate_snapshot` y `tax_amount` de las líneas— y nunca de las reglas de hoy:
el pasado no se recalcula.

### 3. La percepción de IGTF es POR PAGO, no por venta

Un cobro mixto —parte en bolívares, parte en divisas— causa IGTF **solo sobre
la porción en divisa**. Modelarlo por venta obligaría a repartir, y el reparto
es exactamente donde nacen los errores.

- La percepción se calcula **en el servidor**, dentro de `registerPayment`, y
  viaja en la respuesta del cobro. La caja la ve antes de confirmar mediante
  `GET /v1/pos/igtf`, que aplica **las mismas condiciones** que aplicará el
  cobro — un aviso calculado en el navegador acabaría difiriendo del cargo.
- **Una por pago** (índice único): reintentar el cobro no percibe dos veces.
- Su asiento es propio: Dr caja en divisas / Cr **IGTF percibido por enterar**.
  Es un pasivo con el fisco, **no un ingreso**.

### 4. El conservadurismo es ASIMÉTRICO, y a propósito

Las dos decisiones por defecto tiran en direcciones opuestas porque **el error
grave es distinto en cada caso**:

| Ausencia | Decisión | Por qué |
|---|---|---|
| No hay exenciones cargadas | **SE PERCIBE** | Percibir de más se corrige devolviendo; percibir de menos deja al agente respondiendo con su patrimonio. |
| El instrumento es `otro` | **NO se percibe** | Bajo ese nombre suele esconderse un pago en bolívares, y percibirle el 3 % sería cobrarle al cliente un impuesto que no causó. |

La asimetría está **avisada en pantalla**, no escondida: el catálogo de
instrumentos dice ambas cosas, y editarlo exige `company.settings.manage`.

### 5. La anulación no deshace una percepción

Anular una factura **después** de percibir no resta el IGTF: lo mueve a
`pendiente_reintegro` con su motivo, y el total a enterar deja de contarlo. El
dinero del cliente ya entró; devolvérselo es **otro acto**, y cuál de los tres
caminos posibles es el correcto lo decide el asesor (P-9).

### 6. El calendario es DATO, sin ninguna fecha de fábrica

`company_fiscal_deadlines` se carga por API con **cita de fuente obligatoria**.
Ladino no siembra ni una fecha: las del calendario por dígito de RIF no son
reproducibles desde las fuentes consultadas, y una fecha inventada aquí es una
multa allá. Los vencimientos ordinarios (primeros 15 días) se computan sin
tabla porque esos sí están en la ley.

Los recordatorios avisan con **5 días** de anticipación (orden del dueño).

### 7. La prorrata del artículo 34 es GLOBAL, v1

Cuando hubo ventas sin impuesto en el período,
`deducible = crédito × gravadas / (gravadas + sin impuesto)`, con el porcentaje
guardado en la fila. Cuando no las hubo, no hay prorrata. Está marcado
VALIDAR-TRIBUTARIO (P-4): confirmar si es global o por tipo de crédito, y qué
pasa con los créditos directamente imputables.

### 8. El TXT existe, y dice que no está validado

El adaptador `txt_retenciones_iva` **está implementado** sobre el riel de
`exportFiscalBook` (run + hash + auditoría), pero sigue `is_official = false`
en el catálogo: tres de sus campos son derivados y uno supone monto exento
cero. Estar en el catálogo no es estar validado, y el sistema lo dice en vez de
producir un fichero con aspecto oficial (la regla LAD65 de ADR-0044, otra vez).

## Qué invariante cruza este módulo con los anteriores

La pregunta que CLAUDE.md exige al cerrar un módulo. La respuesta:

> **el débito fiscal de la declaración tiene que ser el MISMO IVA que el libro
> de ventas del mismo período.**

Son dos caminos independientes —`recompute_iva_period` agrega líneas por
alícuota, `sales_book` agrega por documento desde su propia proyección— y
ninguno observa al otro. Si divergen, la declaración presentada contradice al
libro que la respalda, que es justo lo que se compara en una fiscalización.
Vive en el pgTAP 46, y se comprobó en los dos sentidos antes de confiar en él:
los dos lados dan 12 (no dos ceros que pasarían por casualidad), y al invertir
el signo de la nota de crédito divergen.

## Consecuencias

**Buenas**: el contribuyente ve su cuota antes de entrar al portal, con el
arrastre hecho y las retenciones aplicadas; cada generación es reproducible por
su huella; el IGTF deja de ser una hoja de cálculo aparte.

**Costes aceptados**:

- la planilla **no es oficial** y lo dice en todas partes. Dejará de serlo
  cuando el asesor confirme el mapeo de casillas (P-1);
- el arrastre se guarda **combinado** (excedente de crédito + retenciones no
  absorbidas). Si el portal los pide separados —y la impresión es que sí—,
  partir esa columna con historia ya escrita es una migración fea. **Es el
  pendiente más caro de resolver tarde (P-3)**;
- el crédito fiscal sale solo de facturas de proveedor: los gastos con IVA no
  suman (P-5). La vía correcta hoy es registrarlos como factura.

## Alternativas descartadas

- **Escribir los números de casilla adivinando el mapeo.** Habría hecho la
  pantalla más útil de inmediato y una declaración mal presentada después.
- **Sembrar el calendario con las fechas encontradas.** Las fuentes se
  contradicen; sembrar la de una de ellas es elegir al azar y llamarlo dato.
- **Percibir el IGTF por venta y repartir.** Más simple de mostrar, imposible
  de justificar en un cobro mixto.
- **Restar la percepción al anular.** Habría dejado el pasivo cuadrado y el
  dinero del cliente en la caja, sin rastro de que hay algo que devolver.

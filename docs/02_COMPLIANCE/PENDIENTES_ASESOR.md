# Pendientes para el asesor tributario

**Creado:** 2026-09-09 · **Módulo:** Declaraciones de IVA + IGTF (migración 46)

Este documento existe porque el módulo de declaraciones se construyó **sin inventar
ninguna obligación legal**. Donde no había fuente citable en `docs/02_COMPLIANCE/`,
el sistema tomó la decisión más conservadora que pudo, la marcó, y la anotó aquí.

Cada punto dice: **qué hace Ladino hoy**, **qué falta decidir**, **qué se rompe si la
respuesta es otra**, y **dónde se toca**. Ninguno impide operar; todos impiden
presentar una declaración a ciegas.

> **Regla que gobierna este documento:** una cifra que Ladino no puede justificar con
> una fuente se muestra al usuario como calculada por Ladino, nunca como oficial. La
> pantalla «Declarar IVA» exporta una **planilla demostrativa — NO OFICIAL**, y el
> contribuyente (o su contador) transcribe al portal del SENIAT.

---

## P-1 · Mapeo de casillas de la Forma 30

**Hoy:** la pantalla «Declarar IVA» muestra las secciones **en el orden y con los
conceptos** de la declaración (débitos por alícuota, créditos, retenciones
soportadas, excedente anterior, cuota o excedente siguiente), pero **sin números de
casilla**. La exportación se rotula «planilla demostrativa — NO OFICIAL».

**Falta:** el número de casilla de la Forma 30 (99030) vigente para cada concepto.
No está en el repositorio y **no se dedujo del parecido**: una casilla equivocada en
un formulario oficial es una declaración mal presentada.

**Si la respuesta es otra:** cambia solo el rótulo de cada cifra, no el cálculo.

**Dónde se toca:** `apps/web` (pantalla de declaración) y el rótulo de la exportación.
No toca dominio ni esquema.

---

## P-2 · El artículo de la LIVA que ampara el arrastre del excedente

**Hoy:** el excedente de crédito fiscal no absorbido se traslada al período siguiente,
y así lo dice el texto en pantalla y en la migración: *«traslado del excedente de
crédito fiscal al período siguiente (LIVA, artículo por confirmar en la numeración
vigente)»*.

**Falta:** el número de artículo **en la numeración de la ley vigente**. Las fuentes
consultadas discrepan entre reformas y no se escribió ninguno.

**Si la respuesta es otra:** solo cambia el texto. La mecánica del arrastre no depende
del número.

**Dónde se toca:** el comentario de cabecera de la migración 46 y el copy de la
pantalla.

---

## P-3 · Arrastre COMBINADO vs. separado (excedente de crédito y retenciones)

**Hoy:** `iva_period_results.excedente_siguiente` arrastra **una sola cifra
combinada**: el excedente de crédito fiscal y las retenciones soportadas no
absorbidas van juntos.

**Falta:** confirmar que el portal los separa. La impresión de la investigación es
que **sí los pide por separado** (el excedente de crédito y las retenciones
acumuladas tienen renglones distintos).

**Si la respuesta es «separados»:** hay que **partir la columna en dos**. Es una
migración nueva sobre una tabla insert-only con historia: las filas viejas quedan con
la cifra combinada y las nuevas con el desglose, o se regeneran todos los períodos.
**Este es el pendiente de mayor coste si se resuelve tarde** — conviene resolverlo
antes de que haya muchos períodos generados.

**Dónde se toca:** migración nueva (columnas), `platform.recompute_iva_period`,
`packages/domain/src/declarations.ts`, la pantalla.

---

## P-4 · Prorrata del artículo 34: global v1

**Hoy:** cuando en el período hubo ventas sin impuesto (exentas, exoneradas o no
sujetas), Ladino aplica una prorrata **GLOBAL**: `deducible = crédito × (gravadas ÷
(gravadas + sin impuesto))`, con el porcentaje guardado en `prorrata_pct`. Cuando no
hubo ventas sin impuesto, no hay prorrata y el crédito es deducible entero.

**Falta:** confirmar (a) que el prorrateo es global y no por tipo de crédito;
(b) si el período de cómputo es el mes o el ejercicio; (c) el tratamiento de los
créditos **directamente imputables** a operaciones gravadas, que no deberían
prorratearse.

**Si la respuesta es otra:** cambia el cálculo del período, y los períodos ya
generados quedan con una cifra que el asesor tendría que rehacer. La fila es
insert-only: se **regenera** el período, no se edita.

**Dónde se toca:** `platform.recompute_iva_period` (migración nueva).

---

## P-5 · Créditos fiscales de gastos sin factura de proveedor

**Hoy:** el crédito fiscal del período sale **solo** de `supplier_invoices` en estado
`posted` o `paid` con `tax_is_recoverable`. Los **gastos** registrados por tesorería
(`expenses`) NO suman crédito fiscal, aunque lleven IVA.

**Falta:** decidir si un gasto con factura debe generar crédito. Hoy la vía correcta
es registrarlo como factura de proveedor; el registro de gasto es para lo que no la
tiene.

**Si la respuesta es «sí suman»:** hay que ampliar la CTE `cred` y, sobre todo,
**evitar el doble conteo** con las facturas de proveedor.

**Dónde se toca:** `platform.recompute_iva_period`; posiblemente una columna de IVA
recuperable en `expenses`.

---

## P-6 · Notas de débito: ¿suman al débito del período de emisión?

**Hoy (regla provisional):** en el cálculo del período, la **nota de crédito resta**
y la **nota de débito suma** al débito fiscal, ambas por su fecha de emisión.

**Falta:** confirmar que el ajuste va al período de la NOTA y no al período de la
factura corregida.

**Si la respuesta es «al período de la factura»:** el cálculo tendría que reasignar
las notas a otro período, y los períodos ya cerrados cambiarían.

**Dónde se toca:** la CTE `ventas` de `platform.recompute_iva_period`.

---

## P-7 · Layout del TXT de retenciones de IVA practicadas

**Hoy:** el adaptador `txt_retenciones_iva` está **implementado** y produce un fichero
de campos separados por TABULADOR siguiendo la guía pública del archivo de carga.
Está marcado `is_official = false` en el catálogo.

Tres campos son **derivados**, no leídos del libro, y uno descansa en un supuesto:

| Campo | Cómo se obtiene | Riesgo |
|---|---|---|
| IVA de la factura | `retenido ÷ porción` (el libro guarda la porción, 0,75 o 1,00) | si la porción no fuera exacta, el IVA sale desviado |
| Alícuota | `IVA ÷ base × 100` | idem |
| Monto total | `base + IVA` | **supone monto exento = 0**: el libro no separa la porción exenta de la factura del proveedor |
| Exento | se emite `0.00` | consecuencia del supuesto anterior |

**Falta:** validar el fichero contra **una carga real del portal** (una declaración de
prueba) y confirmar el orden y el ancho de los campos, y qué hacer con proveedores con
operaciones exentas dentro de la misma factura.

**Si la respuesta es otra:** cambia el serializador, no el esquema.

**Dónde se toca:** `aTxtRetencionesIva` en `packages/domain/src/fiscal-books.ts`, y la
fila del catálogo (`is_official` pasaría a `true` cuando esté validado).

---

## P-8 · Exenciones del IGTF

**Hoy:** la tabla `igtf_exemptions` está **VACÍA a propósito**, y sin regla de exención
**SE PERCIBE** (decisión conservadora aprobada: percibir de más se corrige
devolviendo; percibir de menos deja al agente respondiendo con su patrimonio).

**Falta:** las exenciones concretas del decreto vigente (y su vigencia): operaciones
del sistema financiero, títulos valores, ciertas transferencias entre cuentas propias,
etc.

**Si la respuesta es «hay exenciones que aplican a este negocio»:** se cargan como
DATO en `igtf_exemptions` y el cálculo las consultará. **Ojo con la asimetría
deliberada:** para las exenciones el criterio conservador es *percibir*, mientras que
para el instrumento `otro` el criterio conservador es *NO percibir* (puede ser un pago
en bolívares con otro nombre). Las dos decisiones tiran en direcciones distintas
porque el error grave es distinto en cada caso.

**Dónde se toca:** siembra de `igtf_exemptions` y la rama de percepción en
`registerPayment` (`packages/domain/src/sales.ts`).

---

## P-9 · Flujo de reintegro del IGTF percibido sobre una factura anulada

**Hoy:** anular una factura después de percibir deja la percepción en estado
`pendiente_reintegro` con el motivo. **La percepción nunca se resta sola**, y el total
a enterar de la quincena deja de contarla.

**Falta:** qué hacer después. Tres caminos posibles, y **no se eligió ninguno**:
1. devolver el 3 % al cliente y registrar la devolución;
2. compensarlo contra la percepción de otra operación del mismo cliente;
3. enterarlo igualmente y que el cliente lo reclame al fisco.

**Si la respuesta es (1) o (2):** hace falta un caso de uso nuevo con su asiento
(hoy la reversión del asiento de la percepción **no** se genera al anular: el asiento
de la factura sí se reversa, el de la percepción no, porque el dinero sigue en caja).

**Dónde se toca:** un caso de uso nuevo en `packages/domain/src/igtf.ts` y su pantalla.

---

## P-10 · Calendario de vencimientos por dígito de RIF

**Hoy:** `company_fiscal_deadlines` es una tabla **cargable como dato**, con fuente
citada obligatoria (mínimo 10 caracteres). Ladino **no trae ninguna fecha sembrada**.
Los vencimientos ordinarios (primeros 15 días del mes siguiente) se computan sin
tabla; los de sujeto pasivo especial, **no se computan**.

**Falta:** el calendario del año vigente por **dígito terminal del RIF** para
declaración quincenal de retenciones e IGTF y para el IVA de los SPE. Las fuentes
consultadas **discrepan en el número de gaceta** de la providencia, así que no se
cargó ninguna.

**Si la respuesta llega:** se carga por `PUT /v1/fiscal-declarations/deadlines` con la
cita. No hay cambio de código.

**Dónde se toca:** nada. Es dato.

---

## P-11 · Recordatorios: cuántos días antes

**Hoy:** el aviso se muestra con **5 días** de anticipación por defecto,
configurable.

**Falta:** confirmar que 5 días es útil para el flujo real del contador (puede que
convenga uno al cierre del período y otro a 2 días).

**Dónde se toca:** ajuste de empresa; sin cambio de esquema.

---

## P-12 · Retenciones soportadas: ¿qué fecha asigna el período?

**Hoy:** la retención soportada entra en el período por **`retained_on`**, la fecha en
que el agente practicó la retención según su comprobante.

**Falta:** confirmar que no es la fecha de **entrega** del comprobante ni la de la
factura afectada. Es habitual recibir el comprobante en el período siguiente al de la
retención.

**Si la respuesta es otra:** cambia la CTE `ret` del cálculo y la asignación de
períodos ya generados.

**Dónde se toca:** `platform.recompute_iva_period`.

---

## P-13 · El residuo del último centavo (R-02, heredado)

**Hoy:** una factura se cierra como `paid` cuando su saldo baja de **medio centavo**
(0,005) de la moneda que decide, porque la deuda se muestra redondeada a 2 decimales
y quien paga lo que la pantalla pide pagó todo lo que se le pidió. **El residuo NO se
borra de los libros**: sigue vivo en el saldo de 8 decimales.

**Falta:** decidir a dónde va ese residuo contablemente (ingreso por redondeo, gasto,
o cuenta puente).

**Dónde se toca:** `ResidualAllocation` (R-02), pendiente desde antes de este módulo.

---

## P-14 · Capa fiscal bloqueada sin régimen que factura (Ola 1 «Ladino sin RIF», A7)

**Hoy:** si la empresa no emite facturas, estas tres acciones responden 409
`REGIME_KIND_NOT_ALLOWED` y llevan a /empezar:

- activar la percepción de IGTF;
- marcarse contribuyente especial;
- cargar talonarios.

**Falta:** confirmar que ningún contribuyente necesita dejar esa capa preparada ANTES de
activar la facturación. También falta confirmar que un recibo no fiscal nunca percibe IGTF.

**Si la respuesta es otra:** se permite configurar y se sigue bloqueando la percepción en
recibos. No hace falta migración.

**Dónde se toca:** `packages/domain/src/modo-venta.ts` (`exigeEmpresaQueFactura`), `igtf.ts`,
la ruta de rangos. Riesgo R-28.

---

## P-15 · El IVA pagado por quien vende con recibos (antes de la Ola 3)

**Hoy:** no cambió nada. Las compras de una empresa en modo recibos no están habilitadas
(B4). El asiento de compra lleva el IVA al costo del inventario, pero el kardex costea sin
IVA: mayor y kardex divergen y ningún invariante lo mira.

**Falta:**

- El artículo que diga que el IVA soportado por un no contribuyente no es crédito fiscal y
  va al costo. Es pariente de P-2.
- Confirmar que esas compras no cuentan como «documento fiscal» el día que el negocio
  saca su RIF.

**Si la respuesta es otra:** cambia el costo del inventario de los meses en recibos.
**Bloquea ADR-3** y el lote L3.

**Dónde se toca:** ADR-3 (por escribir), `purchases.ts`, el generador contable de compras.

---

## P-16 · Textos del modo recibos (VALIDAR-LEGAL)

**Hoy:**

- el recibo dice que no es factura;
- la cita «(art. 13.14, PA 00071)» sale solo en facturas;
- la API ya no sirve «copia fiscal» de un recibo (422).

**Falta:**

- validar la leyenda del recibo no fiscal;
- validar el aviso a quien vende sin estar inscrito (R-27);
- confirmar si la tasa BCV es obligatoria para quien no factura.

**Dónde se toca:** `apps/api/src/routes/documents-pdf.ts`, textos de Empezar.

---

## P-17 · ¿El sujeto pasivo especial recupera el IVA de sus compras?

**Hoy:** `registerSupplierInvoice` trata como recuperable SOLO al contribuyente `ordinario`; el
`especial` lleva el IVA de compra al costo (R-34).

**Falta:** confirmar que el especial es también contribuyente ordinario de IVA y recupera el
crédito fiscal (la lectura habitual), y con qué artículo.

**Si la respuesta es la habitual:** una línea de código y el costo de las compras de las empresas
especiales cambia hacia adelante; lo ya registrado se corrige con nota del contador.

**Dónde se toca:** `packages/domain/src/purchases.ts` (`ivaRecuperable`).

---

## P-18 · Regularización del histórico: la contrapartida (VALIDAR-CONTADOR)

**Hoy:** el script de la Ola 2 lleva la diferencia kardex − mayor a «Ajuste de inventario»
(5.1.04) y reclasifica caja Bs → caja USD. Para una empresa cuya diferencia es solo existencia
inicial («Pollos y víveres paola») la contrapartida natural sería «Aportes en inventario» (3.1.04).

**Falta:** que un contador confirme la cuenta por empresa, y el tratamiento del costo de ventas de
meses pasados que nunca se asentó.

**Dónde se toca:** `scripts/ola2/regularizacion-inventario-y-caja.sql` (paso 3).

---

## P-19 · La tasa de una factura de proveedor en divisa (VALIDAR-TRIBUTARIO)

**Hoy:**
- La factura del proveedor en divisa se lleva a bolívares con la tasa del BCV de la **fecha de
  la factura** (migración 65, `purchases_book`, `recompute_iva_period`).
- Esa misma tasa se usa en el asiento y en el crédito fiscal.
- Desde la migración 66 no hay forma de usar otra tasa (ADR-0064 §1).

**Falta:** ¿el crédito fiscal se toma con los bolívares que imprimió el proveedor, o con la tasa
BCV de la fecha de la factura? Si el proveedor usó la tasa de otro día (o la «fecha valor» del
BCV), las dos cifras difieren.

**Si la respuesta es «los bolívares impresos»:** Ladino tiene que capturar esos bolívares por
factura. Sería un dato del documento, no una tasa de la empresa, así que no choca con ADR-0064.
Migración nueva y campo en la compra.

**Dónde se toca:** `packages/domain/src/purchases.ts` (`registerSupplierInvoice`), migración 65.

---

## P-20 · El fiado cobrado a otra tasa: ¿nota de débito o crédito? (VALIDAR-TRIBUTARIO)

**Hoy:**
- Una deuda anclada en divisa que se cobra a otra tasa asienta un **diferencial cambiario**,
  sin documento (ADR-0047).

**Falta:**
- **La norma.** El art. 51 del Reglamento de la LIVA (Decreto 206) diría que esa diferencia
  «constituye una corrección del precio» y se documenta con nota de débito o de crédito. Se leyó
  en una **reproducción no oficial**: confirmar su vigencia y su alcance.
- **El período.** ¿En qué período entra la nota (P-6)?
- **La retención.** ¿El agente de retención retiene sobre la nota de débito?

**Si se confirma:** el cobro emite la nota en la misma transacción y deja de asentar el
diferencial (ADR-0064 §3, diseñado y sin implementar). Exige rango de notas en la puesta a
punto.

**Dónde se toca:** `packages/domain/src/sales.ts` (`registerPayment`), ADR-0064 §3.

---

## P-21 · La fecha de la tasa en la factura (VALIDAR-SENIAT)

**Hoy:**
- El PDF imprime **«Tasa BCV: 842,2067»**, sin la fecha de publicación ni el servicio por el
  que llegó (decisión del dueño, 2026-09-16).
- El documento guarda la fuente completa, con la marca de tiempo de la publicación, pero no una
  columna con la fecha de la tasa.

**Falta:** ¿el «tipo de cambio aplicable» de la PA 00071 art. 13.14 exige la fecha de la
publicación del BCV? Un fin de semana, o con la fuente caída, la tasa puede ser de otro día que
la factura.

**Si la respuesta es sí:** migración con `rate_date` en `documents` y la línea
«Tasa BCV del 15/09/2026: 842,2067».

**Dónde se toca:** `apps/api/src/routes/documents-pdf.ts`, `documents`.

---

## P-22 · Vender con la última tasa publicada (VALIDAR-TRIBUTARIO)

**Hoy:**
- Si el BCV no publica (fin de semana) o la fuente no responde, rige la **última tasa
  publicada**, sin límite de días.
- Mi dinero e Inicio avisan de qué fecha es. Ya no hay carga a mano (ADR-0064 §1).

**Falta:**
- **La antigüedad.** ¿Hasta cuántos días puede facturarse con la última tasa?
- **El fin de semana.** ¿Qué tasa rige una operación de sábado o domingo: la del viernes o la
  de «fecha valor» del lunes?

**Si hay un tope:** la emisión se bloquea pasado el tope, con su mensaje, y el operador de la
plataforma carga la oficial del día.

**Dónde se toca:** `platform.rate_for` (migración 66), `apps/api/src/tasa-oficial.ts`.

---

## P-23 · Las fuentes primarias de la tasa y de la factura en divisa (VALIDAR-TRIBUTARIO)

**Hoy:**
- **Fuentes.** ADR-0064 se apoya en tres textos: el Convenio Cambiario N° 1, art. 9 (G.O. Ext.
  6.405), y la LIVA, arts. 25 y 69 (G.O. Ext. 6.507).
- **Qué ordenan.** Solo la tasa del BCV, y en la factura base, impuesto y total también en la
  moneda extranjera.
- **Estado de la verificación.** Se verificaron en la investigación del 2026-09-16.

**Falta:** archivar el texto primario de la Gaceta en `EXPEDIENTE_TECNICO.md` y confirmar que el
art. 69 exige base, impuesto y total en divisa, no solo el total.

**Dónde se toca:** `docs/02_COMPLIANCE/REGULATORY_STATUS.md` §2.

---

## P-24 · Documentos emitidos con una tasa tecleada (VALIDAR-TRIBUTARIO)

**Hoy:**
- **El caso.** Antes de la migración 66, una empresa podía emitir con una tasa tecleada
  distinta de la del BCV (h. 70: 900 contra 842,2067).
- **Qué queda en el documento.** Esos documentos conservan su tasa congelada.
- **Cómo se imprimen.** El PDF los rotula «Tipo de cambio», no «Tasa BCV».

**Falta:** ¿hay que emitir nota de crédito o de débito por la diferencia, o basta con que
conserven su tasa? En producción, el alcance se mide con los documentos cuyo `rate_source` no
es del BCV.

**Dónde se toca:** consulta de producción; notas de crédito y de débito existentes.

---

## P-25 · Prorrata: ¿las operaciones NO SUJETAS entran en el denominador? (VALIDAR-TRIBUTARIO)

**Hoy:** el prorrateo del crédito fiscal de la empresa con ventas gravadas y exentas es
**global** (v1): el denominador son **todas** las ventas del período —gravadas, exentas y no
sujetas—, que es la lectura **conservadora**, porque un denominador mayor deduce **menos**
crédito fiscal. La cifra sale marcada `VALIDAR-TRIBUTARIO` en la declaración.

**Falta:** confirmar si las operaciones **no sujetas** van dentro o fuera del denominador. Y
recordar, para no prorratear de más: la **LIVA art. 35** permite **contabilidad separada** de las
compras destinadas a operaciones gravadas; con ella, esas compras **no se prorratean** y su
crédito se deduce entero.

**Qué se rompe si la respuesta es otra:** cambia el crédito fiscal deducible de cada período con
ventas mixtas — cifras ya generadas. Va junto con **P-4**.

**Dónde se toca:** `packages/domain/src/declarations.ts` (prorrata), pantalla «Declarar IVA».

---

## P-26 · Entrega del comprobante de retención, ahora que se retiene antes (VALIDAR-SENIAT)

**Hoy:** desde la migración 68, la retención de IVA se **practica al registrar** la factura del
proveedor (el abono en cuenta, PA SNAT/2025/000054) y su pasivo con el fisco nace ahí. El
**comprobante** se sigue emitiendo y numerando **al pagar**, con su permiso propio.

**Falta:** confirmar el plazo de **entrega** del comprobante al proveedor bajo la 000054 (fuentes
secundarias: los dos primeros días hábiles del período siguiente) y si el momento correcto de
emitirlo es el del abono en cuenta, no el del pago. Texto primario de la Gaceta pendiente de
archivar en `EXPEDIENTE_TECNICO.md`.

**Qué se rompe si la respuesta es otra:** el comprobante se emitiría en el registro de la
factura, no en el pago — cambia el momento de numerar, no el cálculo ni el asiento.

**Dónde se toca:** `packages/domain/src/purchases.ts` (`registerSupplierPayment`),
`docs/02_COMPLIANCE/RETENTIONS_SPEC.md`.

---

## Resueltas por el dueño con su asesoría (2026-09-17)

Quedan escritas aquí porque el código las cita como fuente de una regla.

- **R-1 · Nota de crédito recibida del proveedor.** Lleva asiento, entra al libro de compras en
  negativo y **resta el crédito fiscal** de la declaración, en el **período de recepción de la
  nota** (LIVA arts. 56 y 37; Reglamento arts. 70, 75 lit. a y 11). Implementado en la
  migración 67.
- **R-2 · Factura de proveedor anulada.** Va en el libro **con importes en cero**: se conserva la
  traza cronológica (Reglamento art. 70) sin crédito fiscal (LIVA art. 37). Mismo criterio para
  una nota anulada. Migración 67.
- **R-3 · Oportunidad de la retención de IVA.** Nace **al pago o al abono en cuenta, lo que
  ocurra primero**, y registrar la factura como cuenta por pagar **es** el abono en cuenta: el
  pasivo con el fisco nace al registrar (PA SNAT/2025/000054). Migración 68. Lo que queda abierto
  de este punto es **P-26**.

---

## Resumen para la conversación con el asesor

Si el tiempo con el asesor es corto, este es el orden por **coste de resolverlo
tarde**:

1. **P-3** (arrastre combinado vs. separado) — migración sobre tabla con historia.
2. **P-4** y **P-25** (prorrata: método y denominador) — cambian cifras ya generadas.
3. **P-7** (layout del TXT) — bloquea la primera carga real al portal.
4. **P-1** (casillas) — bloquea que la planilla deje de ser «demostrativa».
5. **P-8** y **P-9** (IGTF: exenciones y reintegro) — solo si la empresa es SPE.
6. **P-19** y **P-22** (tasa de la compra en divisa y antigüedad de la tasa): cambian cifras
   de libros y de cada venta mientras sigan abiertos.
7. El resto puede esperar sin acumular deuda.

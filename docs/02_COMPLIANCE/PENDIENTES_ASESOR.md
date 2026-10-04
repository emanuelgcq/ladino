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

## P-3 · Arrastre COMBINADO vs. separado — CERRADA (2026-10-02, L-05)

**Decisión del dueño:** dos arrastres separados, como en la Forma 00030:
`excedente_credito_fiscal` y `retenciones_acumuladas_por_descontar`. Nunca una sola cifra.
Se implementa con migración nueva; las filas viejas conservan la cifra combinada (insert-only).
**Implementada (migración 20261002120000, generador `iva-declarations/1.1.0`):** `excedente_siguiente`
es solo crédito fiscal; `retenciones_acumuladas_por_descontar` lleva aparte lo que la cuota no
absorbió, y el período siguiente arrastra cada uno por su lado. **Cerrada con esta lectura: el asesor
la confirma en P-37.**

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

## P-5 · Créditos fiscales de gastos — CERRADA (2026-09-28, H-09)

Un gasto con factura fiscal (luz, teléfono, alquiler, servicios) **es una compra de servicio**:
entra al libro de compras y da crédito (LIVA art. 33), capturando RIF, razón social, número,
control, fecha, base por alícuota, IVA y exento. Si la empresa es SPE, retiene salvo la exclusión
de servicios públicos domiciliados del art. 3 de la PA SNAT/2025/000054. La pantalla ofrece «con
factura fiscal» / «sin factura». El doble conteo con `supplier_invoices` se evita porque es un
solo registro.

## P-6 · Notas de débito: ¿suman al débito del período de emisión?

**Hoy (regla provisional):** en el cálculo del período, la **nota de crédito resta**
y la **nota de débito suma** al débito fiscal, ambas por su fecha de emisión.

**Falta:** confirmar que el ajuste va al período de la NOTA y no al período de la
factura corregida.

**Si la respuesta es «al período de la factura»:** el cálculo tendría que reasignar
las notas a otro período, y los períodos ya cerrados cambiarían.

**Dónde se toca:** la CTE `ventas` de `platform.recompute_iva_period`.

---

## P-7 · Layout del TXT de retenciones — LAYOUT LEÍDO en reproducción no oficial del instructivo (2026-09-28, L-03)

**Fuente:** Instructivo SENIAT «Declaración retenciones de IVA», versión 3_0_0 (septiembre 2020),
leído en https://es.readkong.com/page/instructivo-declaracion-retenciones-de-iva-seniat-4300855
(2026-09-28). 16 campos por tabulador: 1 RIF del agente (10 caracteres, sin guiones) · 2 período
`AAAAMM` · 3 fecha del documento `AAAA-MM-DD` · 4 C/V · 5 tipo (01 factura, 02 ND, 03 NC, 04
certificación, 05 importación, 06 exportación) · 6 RIF de la contraparte · 7 número del documento
· 8 número de control · 9 monto del documento · 10 base imponible · **11 IVA retenido** · 12
documento afectado («0» si no aplica) · 13 comprobante (14 dígitos) · 14 monto exento · 15
alícuota · 16 expediente («0»). Decimales con punto.
**Brecha detectada en el código (2026-09-28):** `aTxtRetencionesIva` produce 17 campos (un
número de documento de más en la 4.ª posición), fecha `DD/MM/AAAA` y tipo «01» fijo
(`packages/domain/src/fiscal-books.ts:260-302`). Se arregla en L-03 con un fixture aprobado.
**Sigue abierto:** validar con una carga real en el portal antes de `is_official = true`, y el
monto exento de facturas mixtas.
**Aplicado (2026-10-02, L-03, migración 20261002110000):** `aTxtRetencionesIva` produce exactamente
estos 16 campos en este orden, leídos del comprobante-documento (nada se deriva); fixture aprobado en
`packages/domain/test/fixtures/txt-retenciones-iva-p7.txt`. Lo que P-7 **no fija** y queda
VALIDAR-SENIAT: (a) los importes y la alícuota salen con **2 decimales** («16.00»); (b) un documento
con **varias alícuotas** sale con la alícuota VACÍA (no se parte en líneas); (c) el exento es el
total menos la base gravada menos el IVA (incluye exonerado y no sujeto).

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

## P-9 · IGTF de una factura anulada o devuelta — DECIDIDO (2026-09-28, G-06)

- **Anulación** (la venta nunca existió): la percepción es indebida → se restituye al cliente y
  se pide el reintegro (PA SNAT/2022/000013 art. 4; COT arts. 205-210). Es el camino (1).
- **Devolución** (NC): el pago ocurrió y la percepción fue debida → **queda percibida y se
  entera**. La NC no lleva IGTF; el reembolso lo excluye y la pantalla lo dice.
**Queda para el asesor:** P-31.

## P-10 · Calendario de vencimientos por dígito de RIF — REABIERTA (2026-10-02, revisión de L-09)

**Reabierta (H1, H7; migración 20261002120100).** La tabla de la 2.ª quincena está sembrada pero
**no se ofrece** hasta responder. Preguntas exactas:
1. «¿La columna "Ene" de la tabla de la 2.ª quincena de la PA SNAT/2025/000091 es la quincena
   16–31 de diciembre de 2025 (presentada en enero) o la de enero de 2026 (presentada en febrero)?»
2. «¿El "terminal del RIF" de la PA 000091 es el dígito verificador (el último del RIF)?»
   **Discrepancia (auditoría fiscal 2.ª ronda, H11):** Nayma, la fuente de la siembra, dice «el
   último número antes del dígito verificador»; lstributos, «el último dígito del RIF»; ¿qué dice la
   G.O. 43.283? Mientras no se responda, **ningún** vencimiento se ofrece: las 970 fechas sembradas
   están `pending_review` (migración 20261002120200).

Si la respuesta a 1 es «diciembre de 2025», basta una migración que pase esas filas a ofrecidas; si
es «enero de 2026», hay que re-sembrar sus fechas. Si la respuesta a 2 es otra, cambia
`platform.rif_terminal`.

**Cierre parcial anterior (2026-10-02, L-09):**

**Cierre:** la «discrepancia de gaceta» era una **reimpresión por error material**: la PA
SNAT/2025/000091 salió en la G.O. 43.273 y se reimprimió en la G.O. 43.283 (23-12-2025). Sembrada
en `public.tax_calendar_entries` (migración 20261002120000) con norma, gaceta y fuente por fila; las
celdas ⚠ quedan pendientes de cotejo y no se ofrecen (`CALENDARIO_SPE_2026.md` §6; desde la
revisión, también la tabla 1.2 entera: 496 filas). Lo que queda
es un VALIDAR-SENIAT de **cotejo** con la G.O. 43.283 (las celdas pendientes y la muestra), y las
retenciones de ISLR, que no tienen fuente textual y no se sembraron. El texto de abajo es la
historia de la pregunta.

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

## P-16 · Textos del modo recibos — LEYENDA APLICADA (2026-09-28, A-06)

Se aplica ya: «Recibo de devolución · Documento no fiscal: no es factura ni nota de crédito y no
otorga derecho a crédito fiscal». Sin RIF, sin IVA, sin providencia.
**Queda para el asesor:** la redacción definitiva → P-42.

## P-17 · ¿El sujeto pasivo especial recupera el IVA de sus compras? (reescrita 2026-09-28, M-13)

**Hoy:** `registerSupplierInvoice` trata como recuperable el IVA de la compra con soporte fiscal
**tanto del `ordinario` como del `especial`** (`packages/domain/src/purchases.ts:862-871`): el
especial es un contribuyente ordinario de IVA designado agente de retención. Sin documento no hay
crédito para nadie (ADR-0066 §2). El `formal` y el no contribuyente llevan el IVA al costo. La
redacción anterior («el especial lleva el IVA al costo») describía un comportamiento que ya no
existe.
**Falta:** que el asesor confirme la lectura con su artículo (LIVA art. 33 exige contribuyente
ordinario; PA SNAT/2025/000054 art. 6 dice que el impuesto retenido no pierde su carácter de
crédito fiscal para el agente).
**Si la respuesta es otra:** una línea en `ivaRecuperable` y nota del contador sobre lo registrado.

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

## P-20 · El fiado cobrado a otra tasa — DECIDIDO (2026-09-28, D-07/G-11) · NORMA LEÍDA EN CONTRA (2026-10-03): espera al asesor

El diferencial entre la tasa del documento y la del pago se reconoce **al pagar**, en «Ganancia /
Pérdida en diferencial cambiario», **sin nota de débito ni de crédito**. Las NC y ND que corrigen
una factura van a la tasa de la factura.
**Aviso de norma:** el art. 51 del Reglamento de la LIVA, leído solo en reproducción no oficial,
diría que esa diferencia es corrección de precio documentable con ND o NC. Si el asesor confirma
su vigencia y alcance, **manda la norma** sobre esta decisión (VALIDAR-TRIBUTARIO).

**Ampliada (auditoría fiscal de moneda, AF-M07 y AF-M08, 2026-10-03; VALIDAR-TRIBUTARIO, RLIVA
art. 51).** El art. 51 del Reglamento de la LIVA se leyó el 2026-10-03 en tres reproducciones no
oficiales coincidentes (pandectasdigital; gerenciaytributos 2020, 2021 y 2025): si el precio está,
según el contrato, sujeto a modificación del tipo de cambio, la diferencia al pagar es corrección
de precio, ajusta la base imponible y se documenta con nota de débito o de crédito. No se halló
derogación ni doctrina numerada del SENIAT; la fuente menciona una sentencia del TSJ de 2009
(Zaramella & Pavan Construction Company) en sentido contrario, sin número. **Aplicada (ola 3,
ADR-0075 §4):** diferencial contable sin documento, ahora también en compras, en el cobro que
cierra y en la revaluación. **Preguntas exactas:** (1) «Con el precio pactado en USD y la factura
emitida en Bs a la tasa BCV del día, ¿el cobro en Bs a la tasa de otro día obliga a emitir nota de
débito o de crédito con IVA por la diferencia (RLIVA art. 51), o es un resultado financiero ajeno
al IVA?» (2) «¿Cambia la respuesta si el cliente paga en la misma divisa del precio?» (3) «Si hay
nota: ¿en qué período entra, lleva retención de IVA cuando el cliente es agente, y se emite una
por cobro o una al cierre de la deuda?» (4) «En compras: si el proveedor emite la nota de débito
por diferencia de tasa, ¿el comprador reconoce además pérdida cambiaria, o la nota la sustituye?»
**Mientras no haya respuesta:** no se libera emisión fiscal productiva con cobros a otra tasa; si
el asesor confirma el art. 51, manda la norma y el diferencial se rehace con nota. **Dónde se
toca:** `registerPayment` (sales.ts), `registerSupplierPayment` (purchases.ts), ADR-0064 §3.

## P-21 · La fecha de la tasa en la factura — CERRADA (2026-09-28, G-11/2.7)

La factura va a la tasa BCV del día de emisión, congelada: la fecha de la tasa es la de emisión.
Las NC y ND que corrigen imprimen «Tasa BCV de la factura N° … del dd/mm/aaaa: Bs …».

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

**Ampliada (AF-M02, 2026-10-03).** LIVA art. 25 (leído en la versión G.O. 38.263; numeración 2020
sin cotejar): el día no hábil para el sector financiero se convierte a la tasa del día hábil
inmediatamente SIGUIENTE. `platform.rate_for` toma la última con fecha no posterior. **Pregunta
adicional:** «Una factura de sábado, domingo o feriado, ¿va a la tasa que el BCV publicó el último
día hábil con fecha valor del día hábil siguiente?» **Hecho por verificar en código:** qué fecha
guarda `exchange_rates.rate_date` (publicación o fecha valor; `apps/api/src/tasa-oficial.ts`).

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

## P-26 · Comprobante de retención — CERRADA (2026-09-28, H-04)

PA SNAT/2025/000054 art. 16 (verificado el 2026-09-25 en una reproducción no oficial,
https://tributos.ivecofi.net/informacion/legislacion/providencias/pa-2025-54): número `AAAAMM` +
8 dígitos; entrega dentro de los **2 primeros días hábiles del período siguiente**; uno por
operación o uno por período y proveedor; agente y proveedor lo registran en el período de emisión.
El comprobante se emite **al practicar la retención** (pago o abono en cuenta, lo primero, art. 13).
Con R-3, eso es **al registrar la factura**, no al pagar: el código actual (emisión al pagar) cambia
en H-04.
**Implementado (2026-10-02, migración 20261002110000, ADR-0072 §4):** `retention_vouchers` se emite al
registrar, con número AAAAMM + 8 por empresa, vencimiento de entrega calculado y mostrado, y versión
nueva al corregir. **VALIDAR-TRIBUTARIO:** el vencimiento cuenta 2 días de **lunes a viernes**; los
feriados nacionales no están en el repositorio (un feriado adelanta el aviso un día, nunca lo atrasa).

## P-27 · La compra pagada SIN factura: qué la respalda y qué se puede deducir (VALIDAR-TRIBUTARIO)

**Hoy:** no se puede registrar. La pantalla exige el número y el número de control de la factura
del proveedor, así que una compra real pagada a quien no factura termina como «aporte del dueño»
—y el dinero que salió de la caja no sale en ningún sitio— o con un número inventado dentro del
libro de compras. Desde ADR-0066 se registra como **compra sin soporte fiscal**: entra al depósito
al costo pagado, el dinero sale o queda deuda, **no** entra al libro y **no** genera crédito
fiscal, y queda marcada y filtrable.

**Falta:** ¿qué documento respalda en Venezuela una compra a quien no está obligado a facturar (o
no factura), y qué efecto tiene en el **costo deducible para ISLR** y en el **crédito fiscal**?
Como precedente regional: en Colombia existe el «documento soporte en adquisiciones a no obligados
a facturar», que **genera el comprador** con numeración autorizada, y sin él la administración
rechaza el costo. No se afirma que exista un equivalente venezolano.

**Qué se rompe si la respuesta es otra:** si existe un documento que deba emitirse, hay que
construirlo (numeración, formato, entrega) y la compra dejaría de estar «fuera del libro».

**Dónde se toca:** ADR-0066 §2 · migración 69 (`fiscal_support`) · `purchases_book`.

**Ampliada (auditoría fiscal de la ola 3, 2026-10-03). Pregunta adicional:** «Dado que el art. 2 de
la PA 00071 obliga a facturar a toda persona jurídica y a la natural cuando la factura prueba el
desembolso, ¿qué soporte debe conservar el comprador de una compra sin factura para deducir el costo
en ISLR?»

---

## P-28 · ¿Se retiene sobre una compra sin soporte fiscal? (VALIDAR-TRIBUTARIO)

**Hoy:** no se practica retención sobre una compra sin soporte.

**Falta:** la retención nace **al pago o al abono en cuenta, lo que ocurra primero**
(PA SNAT/2025/000054, ADR-0065 §3). Si el hecho generador es el abono en cuenta, ¿nace también
cuando la operación no tiene factura? Y si nace, ¿sobre qué base, si no hay IVA discriminado?

**Qué se rompe si la respuesta es otra:** aparecería un pasivo con el fisco que hoy no se registra,
y el comprobante de retención tendría que emitirse sobre un documento sin identificación del
emisor.

**Dónde se toca:** `packages/domain/src/purchases.ts` (retenciones) · ADR-0066 §2.

---

## P-29 · IGTF al pagar a un proveedor en divisa (VALIDAR-TRIBUTARIO)

**Hoy:** pagar a un proveedor desde una cuenta en divisa (efectivo USD, Zelle, USDT) **no** genera
ninguna percepción ni gasto de IGTF en Ladino. El pago hace exactamente lo que hacía antes de
ADR-0066: no se afirma nada nuevo.

**Falta:** ¿el pago en divisa a un proveedor genera IGTF a cargo de quien paga (Decreto 4.972,
3 % en divisas), y con qué tratamiento contable — gasto del período o mayor costo de la compra?
Ladino ya percibe IGTF en **ventas**; la punta de compras nunca se decidió.

**Qué se rompe si la respuesta es otra:** cada pago en divisa a proveedor llevaría una línea más en
su asiento y una obligación declarable que hoy no se está registrando.

**Dónde se toca:** `registerSupplierPayment` · `docs/02_COMPLIANCE/IGTF_SPEC.md` · ADR-0066.

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
  **Regla añadida por el dueño (2026-09-28):** si la compra se anula cuando su período ya está
  cerrado y el libro ya se generó o declaró, ese libro no cambia; la anulación entra en el libro
  del período en curso como reversa del crédito fiscal (línea en negativo, marcada «ajuste de
  período anterior»), y la declaración la lleva en su casilla de ajustes de créditos de períodos
  anteriores.
- **R-3 · Oportunidad de la retención de IVA.** Nace **al pago o al abono en cuenta, lo que
  ocurra primero**, y registrar la factura como cuenta por pagar **es** el abono en cuenta: el
  pasivo con el fisco nace al registrar (PA SNAT/2025/000054). Migración 68. P-26 se cerró el 2026-09-28 (H-04: el comprobante se emite al practicar la retención).

---

## Preguntas de la respuesta del dueño al recorrido 2026-09-24 (2026-09-28)

Ninguna bloquea: la lectura aplicada es la conservadora y el comportamiento es dato.

- **P-30 · F-01** — Retención soportada sobre factura en USD. **Aplicada:** abona la CxC a la
  tasa de la factura. **Alternativa:** tasa del día del comprobante (parámetro).
  Implementado (migración 20260928190000): `company_settings.retention_received_voucher_rate`,
  apagado; cada comprobante guarda con qué tasa abonó (`ar_valuation`). Pregunta exacta: «¿la
  retención de IVA soportada sobre una factura en divisa abona la cuenta por cobrar a la tasa de
  la factura o a la del día del comprobante, y el diferencial se reconoce?»
- **P-31 · G-06** — IGTF de una venta devuelta. **Aplicada:** queda percibido; solo la anulación
  lo hace indebido. **Alternativa:** tratar la devolución total del mismo día como anulación.
  **Ampliación (2026-10-02, ola 2 C2; amplía también P-9):** construido así — la NC no lleva IGTF,
  el saldo a favor (lo que se reembolsa) es el total de la NC, y la confirmación de la devolución
  devuelve el aviso «El IGTF de X ya fue enterado al SENIAT y no se devuelve». **Pregunta exacta
  (VALIDAR-TRIBUTARIO):** «¿La devolución TOTAL el mismo día del cobro debe tratarse como anulación
  —percepción indebida, restitución al cliente y reintegro (PA SNAT/2022/000013 art. 4; COT arts.
  205-210)— o se entera igual porque el pago ocurrió?». Hoy: se entera igual (VALIDAR-TRIBUTARIO). Amplía P-9. **Corrección (revisión):**
  la anulación tampoco restituye hoy: una factura con cobros no se anula. **Ola 3 (2026-10-03):** la
  restitución con la venta viva ya existe, por la reversa del cobro (ADR-0075 §8); ver P-67. Una
  devolución sigue sin restituir (G-06).
- **P-32 · E-02 / H-01** — Procedimiento para regularizar IGTF no percibido y retenciones no
  practicadas en períodos vencidos. **Aplicada:** enterar en la quincena en que se debió, con los
  recargos del COT; comprobante con la fecha real. **Alternativa:** la que indique el asesor.
  - **P-63 · H-01 · regularizar F-88771 y F-89002 de E3 (VALIDAR-TRIBUTARIO, 2026-10-02).** Las dos
    facturas de la empresa de pruebas «Ferretería El Tornillo» (especial desde el 2026-09-24) se
    registraron el 2026-09-24 y el 2026-09-25 sin retener (`retention_total = 0`, sin comprobante).
    Con R-3, registrarlas como cuenta por pagar **fue** el abono en cuenta: la retención se debió
    ese día (PA SNAT/2025/000054 art. 13), y F-88771 además tiene un abono de 50 USD. No están
    «sin pagar»: por eso **no se regularizan solas** (la comprobación `pnpm recorrido H` lo vigila).
    Procedimiento de la respuesta del dueño (H-01), pendiente de confirmar: emitir el comprobante
    con la fecha real del abono, enterar en la quincena que tocaba con los recargos del COT. Hoy el
    sistema no emite un comprobante con fecha pasada: si el asesor lo confirma, se construye como
    acto propio con acta. Pregunta exacta: «¿una retención de IVA no practicada al registrar la
    factura se regulariza con un comprobante fechado el día del abono en cuenta original y se entera
    en esa quincena con recargos, o con un comprobante de hoy?»
  - **P-65 · H-04 / L-03 · la corrección de un comprobante ya declarado (VALIDAR-SENIAT, 2026-10-02).**
    Pregunta exacta (auditoría fiscal): «Si se corrige la identidad del proveedor (RIF o razón social)
    en un comprobante ya declarado, ¿se declara la línea corregida en la quincena siguiente? ¿Con qué
    tratamiento de la línea errónea para no enterar dos veces?». **Aplicada (decidido por criterio,
    evitar el doble enteramiento):** el TXT de un período excluye las versiones >= 2 de un comprobante
    cuya versión 1 se emitió antes del período, y la exportación lo avisa (`warnings`).
    **Alternativa:** declarar la corregida en la quincena siguiente. Dónde se toca: `yaDeclarada` en
    `packages/domain/src/fiscal-books.ts` y `original_issued_on` de `platform.iva_retention_book`.
    (La migración 20261002110200 la citaba como «P-64», que es la del IGTF asumido; lo corrige el
    COMMENT de la 20261002110300.)
  - **P-69 · L-03 · un documento con varias alícuotas en el TXT (VALIDAR-SENIAT, amplía P-7(b)).**
    Pregunta exacta: «En el TXT, un documento con 16 % y 8 %: ¿una línea por alícuota o una sola, y con
    qué valor en el campo 15?». **Aplicada (decidido por criterio, no emitir lo que el portal
    probablemente rechaza):** el TXT que incluiría uno de esos documentos da 422 con su lista, en vez
    de dejar el campo 15 vacío. **Alternativa:** una línea por alícuota.
  - **P-71 · H-01 · el tope de 20 UT de las exclusiones del art. 3 num. 6 y 7 (VALIDAR-TRIBUTARIO).**
    Pregunta exacta: «¿Las 20 UT se miden contra el total de la factura o contra la base imponible, y
    con la UT vigente en qué fecha?». **Aplicada (lo más estricto):** contra el TOTAL de la factura en
    Bs, con la UT vigente en la fecha de la factura (`tax_units`: Bs 43, PA SNAT/2025/000048,
    REGULATORY_STATUS.md, vigente desde la fecha de la Gaceta 02-06-2025 — también a confirmar). Sin
    UT cargada para la fecha, esas dos exclusiones no se pueden marcar (422).
  - **P-74 · H-01 · el art. 3 de la PA SNAT/2025/000054 contra la Gaceta, y el art. 146 del COT (VALIDAR-TRIBUTARIO, 2026-10-02).** Los 13 numerales están leídos en una reproducción no oficial (ivecofi, auditor fiscal, 2026-10-02) y cargados en `retention_exclusions` (migración 20261002110400). Falta: (a) cotejarlos con la G.O. 43.171 del 16-07-2025; (b) el texto del art. 146 del COT, al que remite el num. 13. Pregunta exacta: «¿El texto del art. 3 de la PA SNAT/2025/000054 en la G.O. 43.171 coincide con estos 13 numerales, y qué excepción establece el art. 146 del COT vigente?»
  - **P-72 · H-01 · el día en que se evalúa la condición de agente (VALIDAR-TRIBUTARIO).** Pregunta
    exacta: «¿La condición de agente se evalúa el día del abono en cuenta o el de la factura?».
    **Aplicada (PA 000054 arts. 1 y 13 con R-3: retener es al abono en cuenta, que es el registro):**
    el tipo de la empresa el día del REGISTRO (día de Caracas). **Alternativa:** el día de la factura.
- **P-33 · G-01** — Un correlativo de control por emisor (PA 00071 art. 44). **Aplicada:** uno
  por empresa e identificador, compartido por factura, NC y ND. **Alternativa:** tramos por clase,
  si el SENIAT lo admite por escrito.
- **P-34 · G-10 / L-07** — Anuladas en el libro de ventas. **Aplicada** (migración
  20260928120000): número, estado «annulled» (en pantalla «Anulada») e importes en cero. **Alternativa:** omitirlas del libro con relación aparte.
- **P-35 · K-04** — Ventana para deducir crédito de facturas recibidas con retraso. **Aplicada:**
  ninguna todavía: el número (12 períodos desde la emisión) está en fuentes secundarias, pero el
  **artículo no se confirmó** → pendiente de fuente; no se ofrece en pantalla. Estado 2026-09-28
  (migraciones 20260928130000 y 20260928130100): la factura tardía entra al período de registro,
  marcada «recibida con retraso», y su crédito se deduce en ese período SIN ventana. Si la ventana
  existe, hoy se deduce crédito que habría que llevar a costo.
  **Pregunta:** ¿qué artículo de la LIVA (o del Reglamento) la fija, y se cuenta desde la emisión?
- **P-36 · K-08 / P-03** — Redondeo half-up al céntimo y cuenta «Diferencias por redondeo»;
  códigos de diferencial cambiario, mermas y faltantes, retiros y aportes del dueño.
  **Aplicada:** half-up; cuentas de resultado propias. **Alternativa:** half-even; códigos del
  contador. *La parte del redondeo y de «Diferencias por redondeo» es la misma pregunta que P-79,
  que trae el texto exacto y dónde se toca: se responde allí. Aquí quedan los códigos de
  diferencial cambiario, mermas y faltantes, retiros y aportes.*
- **P-37 · L-05** — Dos arrastres separados en la declaración del especial. **Aplicada:**
  separados (migración 20261002120000, 2026-10-02): las retenciones soportadas se descuentan solo
  de la cuota tributaria positiva y lo que sobra pasa como «retenciones acumuladas por descontar»;
  nunca se convierte en excedente de crédito fiscal. **Alternativa:** una sola cifra (lo de antes).
  **Pregunta exacta:** «En la Forma 00030 del especial, ¿las retenciones soportadas no descontadas
  en la quincena pasan a la siguiente como "retenciones acumuladas por descontar", separadas del
  excedente de crédito fiscal, y se descuentan primero el excedente de crédito y después las
  retenciones (PA SNAT/2025/000054 arts. 7 y 8)?»
- **P-38 · M-10** — Contribuyente formal: artículos vigentes de la PA SNAT/2003/1677 (G.O.
  37.677, 25-04-2003). Verificados los arts. 3 (documento con leyenda «contribuyente formal») y 4.
  **Pendiente de fuente:** periodicidad de la declaración informativa (¿trimestral, o semestral
  con ingresos ≤ 1.500 UT?) y contenido y periodicidad de las relaciones. **Aplicada:** la opción
  «Formal» **se oculta** hasta tenerlo.
- **P-39 · M-11** — Regularización de lo vendido con recibo antes del RIF. **Aplicada:** los
  recibos quedan como historia, fuera de libros. **Alternativa:** la que indique el asesor (es del
  negocio, no del sistema).
- **P-40 · E-03** — Cobro en divisas posterior a la factura de un SPE. **Aplicada:** Nota de
  Débito por IGTF que referencia la factura (PA 00071 art. 22), sin IVA, base 0 en el libro.
  **Alternativa:** comprobante de percepción no fiscal.
  **Ampliación (2026-10-02, ola 2 C2):** construida. La ND por IGTF sale sola en el cobro
  POSTERIOR (fiado o abono en la ficha): una línea «IGTF 3 % sobre pago en divisas» (el porcentaje
  sale de `igtf_rules`), no sujeta, en Bs a la tasa del día del cobro, consume control, va al libro
  con base 0 e IVA 0 y nace pagada por su percepción. El cobro de la propia venta (caja) imprime el
  IGTF en la factura. **Preguntas exactas (VALIDAR-TRIBUTARIO):** (1) «¿Basta la ND por IGTF del
  art. 22 de la PA 00071 para cumplir el art. 6 de la PA SNAT/2022/000013 en el cobro posterior, o
  es preferible el "comprobante de percepción" no fiscal?»; (2) «Si la empresa ASUME el IGTF (el
  cliente paga el documento justo): ¿la factura o una ND deben mostrar igual alícuota y monto?» —
  hoy no se imprime ni se emite ND, porque al cliente no se le cobró; (3) «Un abono en divisas a una
  ND (no a la factura): ¿su ND por IGTF referencia la factura original?» — hoy sí.
- **P-64 · F-05** — IGTF asumido por la empresa (`absorb_igtf`). **Aplicada:** se asienta Dr
  5.1.05 Gastos operativos / Cr 2.1.91 IGTF percibido por enterar, y se entera igual. **Pregunta
  exacta (VALIDAR-CONTABLE / VALIDAR-TRIBUTARIO):** «¿El IGTF asumido es gasto deducible del ISLR
  y en qué cuenta va? ¿Hace falta una cuenta propia "IGTF asumido" en lugar de gastos operativos?».
- **P-66 · E-02 (auditoría fiscal, VALIDAR-TRIBUTARIO; PA SNAT/2022/000013 art. 1)** — Qué
  instrumento causa. **Aplicada** (migración 20261002100100, data con fuente): efectivo en divisa y
  USDT causan; Zelle causa por criterio (lectura reversible); transferencia, tarjeta y punto de venta
  bancarios no. **Pregunta exacta:** «¿Percibe IGTF el SPE en cobros en divisas por transferencia a
  una cuenta en divisas de un banco nacional, con tarjeta o en punto de venta, dado que el art. 1 de
  la PA 000013 limita la percepción a pagos "sin mediación de instituciones financieras"? ¿Un pago
  por Zelle cuenta como pago con mediación de una institución financiera (extranjera)?»
- **P-67 · G-06 / H3 (VALIDAR-TRIBUTARIO; PA SNAT/2022/000013 art. 4)** — Restitución de un IGTF
  indebido con la venta viva. **Aplicada (ola 3, 2026-10-03; ADR-0075 §8):** la reversa del cobro que
  lo percibió marca la percepción `pendiente_reintegro`, revierte su asiento y saca de la caja lo
  percibido (se restituye al cliente), con acta. Deja de estar pendiente de construir; sigue
  pendiente de validar. **Pregunta exacta:** «¿Con qué soporte se documenta la restitución al cliente
  de un IGTF percibido indebidamente cuando la venta sigue viva, y cómo se presenta el reintegro si
  esa percepción ya se enteró?» **Ampliada (AF-M11, 2026-10-03).** Ver P-89, preguntas (a) a (c):
  la respuesta decide si `pendiente_reintegro` se aplica a todo cobro reversado o solo al ya
  enterado.
- **P-41 · B-19** — Ejercicio y UT de referencia para las 1.500 UT del art. 8 de la PA 00071.
  **Aplicada:** ingresos brutos del ejercicio anterior a la UT vigente en ese ejercicio (hoy Bs 43
  → Bs 64.500). **Alternativa:** UT vigente al evaluar.
- **P-42 · A-06 / P-16** — Redacción definitiva de la leyenda del recibo no fiscal. **Aplicada:**
  la de P-16.
- **P-43 · I-11** — Retiros (LIVA art. 4.3): base imponible (valor de mercado) y documento. **Desglosada en P-75 y P-76** (ADR-0078).
  **Aplicada:** débito sobre el valor de mercado y «Nota de retiro» numerada al libro de ventas.
  **Alternativa:** base al costo; documento que indique el asesor.
- **P-44 · B-11** — La alícuota general: **manda la norma sobre el documento del dueño**. Se fija
  por decreto del Ejecutivo (LIVA art. 27; Decreto 4.079, G.O. 41.788), no por la Ley de
  Presupuesto. **Pregunta:** ¿sigue vigente el Decreto 4.079 en 2026? Y confirmar que la reducida
  es el **art. 64** (no el 63).
- **P-46 · R-2 ampliada (regla del dueño del 2026-09-28)** — Factura de proveedor anulada después
  de cerrar su período y de generar o declarar su libro. **Aplicada** (migración 20260928120000,
  `platform.supplier_invoice_late_annulment_day`): la regla al pie de la letra — período contable
  **cerrado y** libro de compras generado (`fiscal_book_runs`) **o** IVA declarado
  (`iva_period_results`) antes de la anulación. Entonces ese libro no cambia y el período de la
  anulación lleva la reversa en negativo, «ajuste de período anterior», y en la planilla la
  casilla «ajustes a los créditos fiscales de períodos anteriores», **fuera de la prorrata** del
  período en curso. **Preguntas:** (1) ¿cerrado sin nada presentado, o presentado sin cerrar,
  también es ajuste? (hoy: R-2 tal cual, en cero en su período); (2) ¿el ajuste se prorratea con la
  prorrata del período en curso o con la del período de la factura? (hoy: ninguna, se revierte
  entero lo deducido); (3) si el período se reabre después de anularla, sigue siendo ajuste; pero si
  además se vuelve a cerrar, el cierre nuevo es posterior y la factura vuelve a R-2 tal cual (la
  fila del período solo guarda el último cierre): ¿qué debe pasar con el libro ya presentado de un
  período que se reabre?

- **P-47 · K-03 (decidido por criterio, VALIDAR-CONTABLE)** — Cierre del ejercicio. **Aplicado:** el
  cierre anual postea en el período de cierre «13», pasa por «Resultado del ejercicio» y de ahí a
  utilidades acumuladas en el mismo asiento. Reabrir el 13 **revierte** el asiento de cierre, con
  acta, y el ejercicio se puede volver a cerrar. El cierre exige que la cola de asientos pendientes
  de la empresa esté vacía, sea cual sea la fecha del pendiente (lectura conservadora: la cola no
  guarda la fecha del documento en una columna). Alternativa: solo los pendientes del ejercicio. **Preguntas:** ¿reabrir el ejercicio revierte el cierre, o se conserva y
  se complementa? ¿El cierre debe pasar por «Resultado del ejercicio» en el mismo asiento o en dos?
- **P-48 · K-05 (decidido por criterio, VALIDAR-CONTABLE)** — Inicio de actividades. **Aplicado:** se
  pide al alta (por omisión, el día del alta), es el límite inferior de las fechas contables, y el
  dueño lo puede cambiar con acta, pero nunca después del primer hecho contable. Una compra o un
  pago con fecha anterior se asienta en el período abierto con su fecha original. **Pregunta:** ¿es
  correcto asentar en el período abierto lo que ocurrió antes del inicio de actividades, o esos
  hechos tienen que entrar como saldos iniciales?
- **P-49 · A-08 (regla del dueño del 2026-09-28, VALIDAR-SENIAT)** — La letra **C** del RIF.
  **Aplicado:** el RIF es letra (V, E, J, G, P, C) + 8 dígitos + 1 verificador; la estructura bloquea
  y el dígito verificador se calcula con el módulo 11 del portal del SENIAT (V=1, E=2, J=3, P=4, G=5;
  pesos 4 para la letra y 3,2,7,6,5,4,3,2 para los dígitos; dv = 11 − (suma mod 11), 0 si da 10 u
  11) y solo **avisa**: si no cuadra, se acepta y queda el acta `*.tax_id_check_digit_mismatch`. Para
  la **C** no hay valor confirmado de la letra: con C Ladino **no avisa** del dígito (ni correcto ni
  incorrecto). **Pregunta:** ¿qué valor tiene la letra C en el cálculo del dígito verificador (y qué
  contribuyentes la reciben)? **Qué se rompe si la respuesta es otra:** nada guardado; solo empieza
  a avisar. **Dónde se toca:** `packages/schemas/src/rif.ts` (`VALOR_LETRA`).
- **P-50 · B-02 (ADR-0073, VALIDAR-TRIBUTARIO)** — Una general **distinta** de la del catálogo.
  **Aplicado:** la empresa acepta cualquier valor dentro de 8–16,5 % (LIVA art. 27); si difiere del
  16 % del Decreto 4.079, la regla lo dice en su `legal_source` («distinta de la del catálogo…
  VALIDAR-TRIBUTARIO») y el acta guarda la tasa anterior. **Pregunta:** ¿una general distinta de la
  del decreto vigente debe exigir a la persona la cita de la Gaceta que la fija, o basta el acta?
- **P-51 · B-04 (ADR-0073, VALIDAR-TRIBUTARIO)** — Vigencia de la reforma de la LIVA y alcance
  de la reducida. **Aplicado:** las plantillas de la reducida (art. 64), la adicional (art. 61) y la
  exenta (arts. 17-19) rigen desde el **29-01-2020**, fecha de la G.O. 6.507 Ext. **No verificado**
  que la reforma rija desde su publicación. Tampoco qué bienes alcanza la reducida (pendiente de
  fuente en IVA_SPEC.md): la reducida **no se ofrece** al clasificar hasta tener la lista (abajo);
  lo clasificado así antes de la migración 20260928170300 se sigue vendiendo al 8 %. Y la plantilla de
  `exonerado` (Decreto 5.196, solo importación) rige desde el **01-01-2026**: IVA_SPEC.md cita la
  G.O. 6.952 Ext. del 31-12-2025 y la vigencia «hasta el 31-12-2026», pero **no** el día de entrada
  en vigor; el 01-01-2026 es una lectura (pendiente de fuente). **Preguntas:** ¿fecha de entrada en
  vigencia de la G.O. 6.507? ¿Qué bienes y servicios lleva hoy la alícuota reducida? ¿Desde qué día
  rige el Decreto 5.196? **Pista (hallazgo 10 de la auditoría fiscal):** el art. 64 es una LISTA
  CERRADA de bienes. Desde la migración 20260928170300 clasificar un producto como reducida exige
  su literal (`tax_reduced_rate_literals`), y esa lista **nace vacía**: ninguna fuente de
  docs/02_COMPLIANCE la trae. Hasta que el asesor la dé con su texto (literal por literal, con
  Gaceta), ningún producto nuevo se clasifica como reducida y la pantalla no la ofrece.
- **P-52 · E-18 (ADR-0073 §4, VALIDAR-TRIBUTARIO)** — La cesta básica. **Aplicado:** los 21
  literales del art. 18.1 (a–u) como «fuente secundaria» (no cotejados con la G.O. 6.507, que es un
  escaneo); el literal pendiente (maíz, sorgo, soya…) no se siembra. En el escenario local se
  reclasificaron como exentos los alimentos del recorrido, **no** el atún ni las sardinas, cuyo
  literal depende de la presentación. **Preguntas:** cotejar los literales con la G.O. 6.507; ¿el
  atún en lata «170 g» y las sardinas «en lata» sin más datos son exentos?
- **P-53 · B-04 / E-04 (ADR-0073, VALIDAR-SENIAT)** — La adicional suntuaria en la factura.
  **Aplicado:** la línea de un bien suntuario lleva UNA alícuota, general + adicional (hoy 31 %), y
  el pie de la factura la discrimina como «Base imponible 31 %» e «IVA 31 %». Lo respalda que el
  resumen del libro (RLIVA art. 72) nombra la categoría «alícuota general más adicional». Se queda así
  hasta que el auditor fiscal o el asesor digan otra cosa. **Pregunta:** ¿la PA 00071 art. 13.10-11
  exige discriminar el 16 % y el 15 % por separado en la factura, o basta el 31 % en una línea?
- **P-54 · G-01 / H11 (ADR-0071, VALIDAR-SENIAT)** — El talonario de contingencia y el papel sin
  serie. **Aplicado:** el correlativo único del art. 44 de la PA 00071 cubre facturas, notas de
  crédito y notas de débito de la forma libre; el talonario de **contingencia** (PA 102, serie
  «contingencia…», solo por su camino) y el **comprobante de retención** llevan su propio correlativo.
  Un papel **sin serie** se registra con serie vacía (migración 20260928160200) y el número se
  imprime sin guion. Desde la auditoría fiscal del 2026-10-02 (PA 00071 arts. 26-27), el PAPEL
  escribe la palabra «Serie» delante del número —«Serie A N° 00000001»— y, sin serie, solo el número
  («N° 00000001»); la pantalla sigue con «A-00000001». **Preguntas:** (1) ¿el talonario físico de
  contingencia de la PA 102 comparte el correlativo de control único del emisor, o lleva uno propio,
  y qué artículo lo dice? (2) Con un sistema centralizado (art. 27), ¿hacen falta series? Si se usan,
  ¿se imprime «Serie A» delante del número?
  **Qué se rompe si la respuesta es otra:** (1) una migración que quite
  `lower(series) not like 'contingencia%'` de la exclusión y del índice, previa revisión de
  solapes; (2) solo cambia lo impreso: el formateador del papel `serieYNumeroImpreso`.
- **P-55 · ADR-0071 §4 / H13 — CERRADA por la PA 00071 art. 33** (auditoría fiscal, fuente ivecofi
  verificada el 2026-10-02). La factura que no cabe en una forma libre: **cada factura, NC o ND
  sobre forma libre ocupa UNA forma**; si la operación no cabe, se emiten varios documentos, cada uno
  con su número. Lo que se había aplicado («las líneas siguen en la hoja siguiente») queda
  corregido. **Aplicado (decidido por criterio, opción (a)):** tope de filas impresas por documento, ajuste
  por empresa (`company_settings.rows_per_free_form`, por omisión 15, máximo 18, medido sobre el
  PDF), exigido por el dominio al emitir (422) y defendido por `?destino=papel`, que rechaza lo que
  pase de una página. **Alternativa (b), no aplicada:** partir la operación sola en varios
  documentos. FC-34 en FACTURA_CHECKLIST.

- **P-57 · auditoría fiscal 2026-10-02, PA 00071 art. 13.7 (VALIDAR-SENIAT)** — El adquirente sin
  identificar. **Pregunta:** ¿puede emitirse factura sobre forma libre sin nombre ni cédula del
  adquirente persona natural? **Aplicado mientras tanto (lectura conservadora):** en una empresa con
  régimen de formas libres, factura, NC y ND exigen el nombre del adquirente y su RIF, cédula o
  pasaporte — en el dominio (422) y en la base (`platform.assert_document_issuance`, LAD99,
  migración 20260928190400). El «Consumidor final» y el ajuste «Permitir ventas sin identificar»
  quedan solo para RECIBOS; la caja pide nombre y cédula al facturar. **Qué se rompe si la
  respuesta es «sí puede»:** se quita el bloque del trigger con una migración y la comprobación del
  dominio, y la caja vuelve a ofrecer «Venta sin identificar» con facturas. Nada de lo emitido cambia.
  La NC y la ND no siguen el 13.7: identifican al adquirente EXACTAMENTE como la factura que corrigen
  (decidido por criterio, regla 1), así que una factura vieja al «Consumidor final» tiene su nota
  (R-63, resuelto). El registro a posteriori de una factura de contingencia refleja un papel que ya
  existe y no pasa por esta exigencia.

- **P-56 · A-03 (decidido por criterio, VALIDAR-TRIBUTARIO)** — El «no contribuyente» con RIF.
  **Aplicado:** `no_contribuyente` no se declara. Lo es por hecho la empresa sin RIF, que emite
  recibos, y una empresa con RIF declara ordinario o especial antes de su primera factura, NC o
  ND (CHECK `company_taxpayer_types_declarable_chk`, LAD98, migraciones 20260928190100 y 190300;
  `formal` queda fuera hasta M-10, P-38). **Pregunta exacta** (reformulada por el auditor-fiscal,
  hallazgo 9): «Una persona jurídica inscrita en el RIF que solo realiza actividades no sujetas
  emite factura con la leyenda "no sujeto al IVA" (PA 00071 arts. 2 y 15). ¿Cuándo califica como
  tal y con qué deberes formales?» **Qué se rompe si la respuesta es otra:** se
  quita el CHECK, `no_contribuyente` vuelve a ser declarable y la puerta de emisión decide qué
  kinds admite para él. Nada de lo emitido cambia.

- **P-58 · hallazgo 3 de la auditoría fiscal (ADR-0071, VALIDAR-TRIBUTARIO)** — La alícuota de la
  nota de crédito. **Aplicado:** la NC que acredita líneas de una factura toma de CADA línea de la
  factura su alícuota, categoría, regla y descripción congeladas, no la condición del día de la nota:
  revierte el débito que la factura generó, y en el libro cae en la fila de la alícuota de la
  factura. **Pregunta:** si entre la factura y su NC cambia la alícuota o la condición del bien,
  ¿la nota revierte el IVA a la alícuota y condición de la factura? **Qué se rompe si la respuesta es
  otra:** `createInvoiceLike` volvería a resolver la regla a la fecha de la nota para la NC.
  **Ampliada a la ND (B-5, decidido por criterio):** la ND que corrige una LÍNEA de la factura
  (`source_line_id`) también va a la alícuota y condición de esa línea; la ND sin línea (ajuste
  global) o por un concepto nuevo va a la condición de hoy. La asimetría es deliberada: sin línea
  no hay débito que revertir. **Pregunta ampliada:** ¿la ND de ajuste global sobre una factura
  sigue la alícuota de la factura o la del día de la nota?
- **P-59 · Hallazgo 6 (auditoría fiscal, VALIDAR-SENIAT)** — ¿El resumen del art. 72 y la
  agrupación por alícuota son obligatorios también en el libro de compras (RLIVA arts. 72 y 75,
  fuente secundaria)? **Aplicado, lectura conservadora:** el libro de compras trae base e IVA por
  alícuota (`purchases_book_by_rate`) y su resumen (`purchases_book_summary`), en la misma
  exportación (`resumen-art72-compras.csv`) y firmados en el hash. Si la respuesta es no, sobran
  columnas, no faltan.
- **P-60 · Hallazgo 10 (auditoría fiscal, VALIDAR-TRIBUTARIO)** — ¿Qué bienes son suntuarios a efectos
  del art. 61 de la LIVA? **Aplicado:** no hay lista con fuente, así que clasificar un producto como
  adicional exige una justificación escrita, que queda en el acta (`product.created` o
  `product.tax_category_set`, campo `justification`). **Pregunta:** ¿hay una lista o un criterio
  normativo (anexo, decreto, providencia) de bienes suntuarios? Si lo hay, se carga como lista
  cerrada, como la del art. 64.
- **P-61 · hallazgo 14 de la auditoría fiscal (ADR-0071, VALIDAR-SENIAT)** — Formas libres perdidas o
  deterioradas. **Aplicado:** nada en el código. Un talonario que no emitió se anula con motivo y
  acta (`POST /v1/fiscal-number-ranges/{id}/cancel`); uno que ya emitió no se anula, y sus controles
  restantes no tienen camino. **Pregunta:** ¿qué se hace con las formas libres restantes de un rango
  perdidas o deterioradas (denuncia, acta, notificación a la imprenta o al SENIAT, y si sus números de
  control se dan por anulados)? **Qué se rompe si la respuesta es otra:** haría falta un acto de
  «controles inutilizados» por tramo, con su acta, que hoy no existe.

- **P-62 · revisión de la auditoría fiscal, F3 (VALIDAR-SENIAT)** — La orden de entrega sobre forma
  libre. **Pregunta:** ¿la orden de entrega o guía de despacho sobre forma libre exige nombre y RIF
  o cédula del adquirente según la PA 00071? **Aplicado mientras tanto:** `delivery_note` queda FUERA
  de la exigencia del adquirente en la base (`platform.assert_document_issuance`, migración
  20260928190500), a la vista y con su comentario. **Qué se rompe si la respuesta es «sí»:** una
  migración añade `delivery_note` al bloque y el dominio la valida como a la factura.

## Resumen para la conversación con el asesor

Si el tiempo con el asesor es corto, este es el orden por **coste de resolverlo
tarde**:

Antes de ese orden, las dos normas leídas que contradicen lo construido (auditoría fiscal de
moneda, 2026-10-03):

- **P-20** (RLIVA art. 51): ¿el diferencial cambiario al cobrar exige nota de débito o de crédito
  con IVA?
- **P-76** (RLIVA art. 31): el retiro de inventario exige factura; se rehace en la ola 5.

1. **P-3** (arrastre combinado vs. separado) — migración sobre tabla con historia.
2. **P-4** y **P-25** (prorrata: método y denominador) — cambian cifras ya generadas.
3. **P-7** (layout del TXT) — bloquea la primera carga real al portal.
4. **P-1** (casillas) — bloquea que la planilla deje de ser «demostrativa».
5. **P-8** y **P-9** (IGTF: exenciones y reintegro) — solo si la empresa es SPE.
6. **P-19** y **P-22** (tasa de la compra en divisa y antigüedad de la tasa): cambian cifras
   de libros y de cada venta mientras sigan abiertos.
7. El resto puede esperar sin acumular deuda.

## P-45 · La reclasificación de ADR-0070: cajas en divisa y «Por conciliar» — VALIDAR-CONTABLE

**Hallazgo:** J-01 · **ADR:** ADR-0070 · **Dónde:** `platform.treasury_subaccounts_repair_prepare`
(migración 20260928110000).

**Qué hace Ladino hoy.** Al reparar una empresa, cada caja recibe su subcuenta y el saldo pasa de la
cuenta de familia a la subcuenta con UN asiento de reclasificación (fecha: el día de la reparación):
- cajas en la moneda funcional: por el saldo que la tesorería les atribuye;
- cajas en divisa: el mayor no guarda hoy el importe original (E-11), así que los Bs de 1.1.02 se
  reparten **en proporción al saldo en divisa** de cada caja (con una sola caja, todos son suyos);
- lo que ninguna caja explica va a una subcuenta **«Por conciliar (reparación ADR-0070)»**.

**Qué falta decidir.** (1) ¿Es aceptable el reparto proporcional de los Bs históricos entre varias
cajas en divisa, o el contador prefiere un asiento propio por caja con su costo histórico? (2) ¿Qué
hace el contador con un saldo en «Por conciliar»: lo investiga y reclasifica, o lo lleva a una cuenta
de resultado? En el escenario local no hay ni una cosa ni la otra (diferencia cero, una caja en divisa
por empresa).

**Qué se rompe si la respuesta es otra.** Nada del dinero: el total de la familia no cambia. Cambia
cómo se reparte entre sus hijas; se corrige con un asiento manual entre subcuentas.

---

## Auditoría fiscal, 2.ª ronda: declaración, libros y calendario (2026-10-02)

- **P-68 · H4 (VALIDAR-TRIBUTARIO, PA SNAT/2025/000054 art. 7).** **Aplicada** (migraciones
  20261002120200, 20261002120300 y 20261002120400): la retención soportada cuenta en el período de
  su fecha; si ese período ya estaba declarado cuando se entregó el comprobante, en el período de
  la entrega (`received_on`). «Declarado» = una generación que lo cubre, hecha DESPUÉS de cerrar el
  período y el día de la entrega o antes (B-1, decidido por criterio): una vista previa a mitad de
  quincena no cuenta. **Alternativa:** alinearlo con «período cerrado y generado», como
  `platform.supplier_invoice_late_annulment_day` (exigir además el cierre contable del período).
  **Pregunta exacta:** «Si el comprobante llega después de declarar la quincena de la retención, ¿se
  descuenta obligatoriamente en el período de entrega (art. 7) o cabe una sustitutiva?»
- **P-70 · H1 (VALIDAR-TRIBUTARIO, amplía P-40; PA SNAT/2022/000013 arts. 5-6, LIVA art. 34).**
  **Aplicada** (migraciones 20261002120200 y 20261002120300, que la reconoce por
  `products.system_code = 'igtf'`): la ND por IGTF no es venta no sujeta; no entra en la
  planilla ni en la prorrata, ni en las bases del libro de ventas ni en el resumen del art. 72; el
  libro la muestra aparte («IGTF percibido», con su número y control). **Pregunta exacta:** «¿La ND
  por IGTF debe registrarse en el libro de ventas y en la Forma 00030, y en qué casilla, si no es
  venta no sujeta ni entra en la prorrata?»
- **P-73 · H13 (VALIDAR-TRIBUTARIO).** **Aplicada:** el ordinario declara el IVA por mes calendario
  completo. La fuente citada era la PA SNAT/2025/000091, que es de los especiales. **Pregunta
  exacta:** «¿Qué artículo de la LIVA (o de su Reglamento) fija el período de imposición mensual del
  contribuyente ordinario?» (P-68 y P-70 son los números asignados por la coordinación; P-71 y P-72
  ya estaban ocupados, por eso este es P-73.) **Ampliada (auditoría fiscal de la ola 3,
  2026-10-03):** LIVA art. 32 (versión 2005): período de un mes calendario; RLIVA art. 59. Falta
  cotejar la numeración 2020.

## Salidas y retiros de inventario (ADR-0078, migración 20261003110000, 2026-10-03)

- **P-75 · El valor de mercado del retiro (VALIDAR-TRIBUTARIO; LIVA art. 4.3).** **Aplicada,
  decidida por criterio:** el consumo propio, el regalo, la donación y la muestra causan débito
  fiscal sobre el **precio de la lista de precios principal (detal) vigente**, convertido a bolívares
  con la tasa del día y redondeado al céntimo, por la alícuota de la categoría del producto. Sin
  precio en esa lista, la salida se rechaza con un mensaje que lo dice. **Alternativa:** el costo
  del kardex (lo que hacen algunos ERP cuando no hay precio). **Pregunta exacta:** «En el retiro de
  bienes del art. 4.3 de la LIVA, ¿la base imponible es el precio corriente de venta al detal del día
  del retiro, el costo de adquisición o el que fije el art. 23 de la LIVA (valor de mercado)? ¿Cambia
  si el bien se regala a un tercero o se consume en la empresa?» **Dónde se toca:**
  `valorDeRetiro` en `packages/domain/src/inventory.ts`. **Ampliada (auditoría fiscal de la ola 3,
  AF3-05, 2026-10-03):** RLIVA art. 43 (reproducción): la base del retiro es el precio de venta
  asignado según documentos y registros, nunca inferior al de mercado. Respalda la lista detal;
  falta confirmar el piso de mercado.
- **P-76 · La Nota de retiro como documento interno (VALIDAR-SENIAT; PA 00071, PA 102).**
  **Aplicada:** la Nota de retiro lleva correlativo propio por empresa (serie «NR»), **no consume
  número de control de la imprenta** y va al libro de ventas como venta a la propia empresa (RIF
  de la empresa como adquirente). En una empresa sin RIF no se emite: solo la salida de kardex y el
  gasto. **Pregunta exacta:** «El RLIVA art. 31 manda emitir factura por el retiro y registrarla en
  la columna especial del Libro de Ventas. ¿Se emite sobre forma libre con número de control a
  nombre del propio contribuyente? ¿Qué es hoy la "columna especial"?» **Dónde se toca:**
  `public.inventory_withdrawal_notes` y `platform.sales_book`. **Ampliada (auditoría fiscal de la
  ola 3, AF3-01, 2026-10-03):** RLIVA art. 31 (reproducción): factura obligatoria. Manda la norma
  sobre la decisión 2 de ADR-0078: se rehace en la ola 5. **Decisión (2026-10-03):** manda la norma
  (RESPUESTA §0: si un texto normativo vigente contradice una decisión, manda la norma). La Nota de
  retiro interna se rehace como FACTURA con número de control y columna especial del Libro de
  Ventas en la ola 5; hasta entonces los retiros no se liberan en producción.
- **P-77 · Las cuentas de las salidas (VALIDAR-CONTABLE; RLIVA art. 14).** **Aplicada:** merma,
  rotura, vencido y faltante justificado → 5.1.08 «Pérdidas por mermas y faltantes de
  inventario»; retiros → 5.1.09 «Retiros de inventario (uso propio, obsequios, donaciones y
  muestras)», con el IVA del retiro como gasto del mismo retiro. **Pregunta exacta:** «¿Confirma los
  códigos 5.1.08 y 5.1.09? ¿El IVA autoliquidado del retiro es gasto del retiro (no deducible) o va a
  otra cuenta? ¿Qué evidencia exige el RLIVA art. 14 para que la merma sea faltante justificado?»
  **Ampliada (revisión, 20261003110100):** la salida por merma, rotura, vencido o faltante exige ahora
  una referencia de evidencia (sin ella, 422), y el faltante de un CONTEO con motivo va a 5.1.08, no
  a 5.1.04. **Pregunta adicional:** «Un faltante de inventario SIN justificar (sin motivo ni
  evidencia), ¿se presume venta omitida (débito fiscal a cargo de la empresa) según el RLIVA o el
  COT? Si es así, ¿con qué base: costo o precio de venta?» **Ampliada (auditoría fiscal de la ola 3,
  AF3-04, 2026-10-03). Pregunta adicional:** «¿Toda merma, rotura o vencimiento justificado se
  registra en el Libro de Ventas como no gravada al precio de compra, o solo el caso fortuito? ¿El
  aviso de 3 días aplica a mermas ordinarias? ¿Entra ese renglón en la prorrata?» La pregunta del
  faltante sin justificar pasa a P-81.
- **P-78 · El retiro exento en la prorrata (VALIDAR-TRIBUTARIO; LIVA arts. 4.3 y 34).** **Aplicada,
  decidida por criterio (lectura literal: el retiro está asimilado a venta):** el retiro de un bien
  exento o exonerado entra en el libro y en la declaración como venta sin impuesto, y por tanto
  cuenta en el denominador de la prorrata. **Pregunta exacta:** «¿El retiro de bienes exentos o
  exonerados (LIVA art. 4.3) entra en el denominador de la prorrata del art. 34, o solo los
  retiros gravados?» **Dónde se toca:** la rama de las notas en `platform.recompute_iva_period`
  (20261003110000).


## El mayor al céntimo (ADR-0075 §7, migración 20261003140000, 2026-10-03)

- **P-79 · Half-up y la cuenta «Diferencias por redondeo» (VALIDAR-CONTABLE).** **Aplicada según la
  respuesta del dueño del 2026-09-28:** todo importe funcional del mayor y del kardex al céntimo con
  redondeo comercial (half-up) y el residuo de conversión de cada asiento a 5.1.10 «Diferencias por
  redondeo». **Pregunta exacta:** «¿El redondeo comercial (half-up) al céntimo es el que corresponde
  al importe en bolívares de cada asiento, o debe ser half-even? ¿La diferencia de redondeo va a una
  cuenta de resultado propia (5.1.10) o a otra, y con qué código?» **Dónde se toca:** `toCents`,
  `platform.round_cents`, el papel `rounding_difference`. *Es la misma pregunta que la primera
  mitad de P-36 (K-08 / P-03): una sola respuesta cierra las dos.* **Ampliada (auditoría fiscal de
  la ola 3, AF3-10, 2026-10-03):** Precedente no vinculante: Resolución BCV 21-08-01 (G.O. 42.191),
  half-up, por una sola vez para la reexpresión. Sin norma permanente hallada.
- **P-80 · El libro de compras y la declaración al céntimo (VALIDAR-TRIBUTARIO).** **Aplicada:** el
  libro de compras convierte con round(importe × tasa, 2) (antes a 8 decimales). Las declaraciones ya
  generadas no se reescriben (append-only). **Pregunta exacta:** «¿El crédito fiscal y el excedente se
  declaran redondeando cada factura al céntimo o el total del período? Si una declaración presentada
  llevó decimales de más, ¿hace falta sustitutiva o basta con arrastrar el excedente al céntimo?»
  **Ampliada (auditoría fiscal de la ola 3, AF3-09 y AF3-11, 2026-10-03). Pregunta adicional:**
  «Según LIVA art. 50, ¿la diferencia de céntimos de una declaración presentada se ajusta en el
  período en que se detecta, sin sustitutiva, salvo que cambie el impuesto a pagar?» **Hecho
  (AF3-09, según la auditoría):** el libro de compras va al céntimo y `recompute_iva_period` sigue a
  8 decimales (20261003110000:611, :624, :636); su destino es el arreglo del céntimo
  (20261003190000).

## Auditoría fiscal de la ola 3: faltantes y uso en el giro (2026-10-03)

- **P-81 · AF3-02 · El faltante de conteo (VALIDAR-TRIBUTARIO; LIVA art. 4.3, RLIVA arts. 13, 14 y
  31).** **Aplicada:** va a 5.1.08 con motivo y evidencia (exigida desde la migración
  20261003110200), sin débito. Norma leída (reproducción): el faltante no justificado es retiro
  gravable; el art. 13 lo da por vendido en el período anterior a la comprobación, al costo más el
  porcentaje de utilidad bruta del último balance; el art. 31 manda facturarlo. **Pregunta exacta:**
  «El faltante detectado en un conteo sin la documentación del art. 14 RLIVA: ¿se grava como retiro
  al costo más el porcentaje de utilidad bruta, imputado al período anterior, y con qué documento?»
  **Dónde se toca:** `countStock` (inventory.ts), `CountStockRequest`, plantilla `stock.counted`.
- **P-82 · AF3-03 · Uso en el giro y traslado al activo fijo (VALIDAR-TRIBUTARIO; LIVA art. 4.3 in
  fine).** **Aplicada:** no existen como motivo; «consumo propio» siempre causa débito. **Pregunta
  exacta:** «¿Qué soporte exige el uso de mercancía en el giro del negocio y el traslado al activo
  fijo para que no sean retiro gravado? ¿Se revierte el crédito fiscal?» **Dónde se toca:**
  `ExitReason`, CHECK `inventory_moves_exit_reason_chk`.

## Moneda y diferencial (ADR-0075 §1-4, migración 20261003170000, 2026-10-03)

- **P-83 · Las cuentas del diferencial cambiario (VALIDAR-CONTABLE).** **Aplicada según la respuesta del dueño (§2.7):** el diferencial entre la tasa del documento y la del pago se reconoce AL PAGAR, en ventas y en compras, contra los papeles `exchange_gain` (4.1.02) y `exchange_loss` (5.1.02) del plan. **Pregunta al contador:** ¿son esos los códigos y los nombres («Ganancia / Pérdida en diferencial cambiario») que quiere en el plan de la empresa, y el diferencial de las COMPRAS va a las mismas cuentas que el de las ventas o a unas propias? ¿El céntimo del abono por retención que cierra una factura va bien en «Diferencias por redondeo» (5.1.10)? **Ampliada (AF-M15, 2026-10-03).** El diferencial REALIZADO (cobros y pagos) y el NO REALIZADO (revaluación al cierre) caen en las mismas cuentas 4.1.02 / 5.1.02. **Pregunta adicional al contador:** «¿Quiere cuentas separadas para la diferencia en cambio realizada y la no realizada, para poder conciliar la renta fiscal?» Ver P-92.
- **P-84 · Los residuos anteriores al corte (VALIDAR-CONTABLE).** Antes de la migración 20261003170000 el pago a proveedor en divisa a otra tasa dejaba la diferencia en cuentas por pagar (H-02: 000123 y F-88771 del recorrido), y el cobro que cerraba una factura en divisa podía dejar ±0,01 en cuentas por cobrar (F-15). El sistema NO los regulariza solo: `platform.settled_ledger_gaps` vigila lo saldado desde el corte. **Pregunta al contador:** ¿se regularizan con un asiento manual por documento contra diferencial cambiario, con uno global al corte, o se dejan para la revaluación del cierre (ADR-0075 §6)?
- **P-85 · El IVA en Bs de una venta en divisa y su tolerancia (VALIDAR-TRIBUTARIO; PA 00071 art. 13.14, LIVA art. 25).** **Aplicada según la respuesta del dueño (§2.7, E-05):** por línea, base en Bs = round(base en divisa × tasa BCV del día, 2) e IVA en Bs = round(base en Bs × alícuota, 2); el total en divisa (lo que el cliente debe) conserva su IVA redondeado al céntimo de la divisa. Las dos cifras se separan hasta media unidad de la divisa × tasa por línea (unos 4 Bs por línea a la tasa actual), y esa separación se reconoce como diferencial al cobrar. **Pregunta al asesor:** (1) ¿el débito fiscal de la factura, el libro y la declaración es ese IVA en Bs, y no la conversión del IVA en divisa? (2) ¿Es aceptable que la contraprestación en divisa impresa en la factura, convertida a la tasa, no coincida al céntimo con el total en Bs, o la factura debe imprimir un total en divisa derivado del total en Bs? (3) Las facturas emitidas ANTES del cambio (IVA en Bs = IVA en divisa × tasa; diferencias de hasta 3,43 Bs en el recorrido) ¿se dejan como están o exigen nota de crédito/débito? **Añadido por la revisión de moneda (ola 3, «el cobro y el cierre»; aplicado, decidido por criterio):** a la tasa de la factura —el mismo día—, lo que se le cobra en Bs al cliente ES el total en Bs impreso en la factura (o la parte proporcional de lo que quede), y pagarlo la cierra sin diferencial; solo a otra tasa (otro día) la deuda en Bs es saldo en divisa × tasa de ese día. **(4)** ¿Es correcto que el mismo día se cobre el total en Bs de la factura aunque difiera en céntimos o bolívares de «total en divisa × tasa»? La **alternativa** descartada: cobrar siempre saldo en divisa × tasa del día, con lo que el mismo día se le cobraría al cliente una cifra distinta de la que su factura dice, y la diferencia iría a diferencial cambiario. **Ampliada (AF-M03, 2026-10-03).** Norma leída (LIVA arts. 20 y 36 en versión 2005; art. 23 en fuente secundaria): la base es el precio facturado, y todo lo cobrado en adición al precio se suma a la base. Eso respalda cobrar el total en Bs impreso y no una cifra mayor. **(5)** «Cuando el cliente paga el mismo día en la divisa de la factura, lo que entra (total en divisa × tasa) difiere del total en Bs en céntimos o bolívares. ¿Esa diferencia va a redondeo, o el total en divisa debe derivarse del total en Bs para que no exista?» **(6)** «¿Es admisible que "Total en dólares × tasa impresa" no dé el "TOTAL Bs" de la misma factura (PA 00071 art. 13.14)?»

- **P-86 · E-11 / J-04 / R-61 (VALIDAR-CONTABLE y VALIDAR-TRIBUTARIO; ADR-0075 §6 y §8, ola 3)** —
  1. **Revaluación al cierre (VEN-NIF PYME secc. 30).** **Aplicada:** al cerrar un mes, las cajas y
     las cuentas por cobrar y por pagar en divisa se llevan a la oficial vigente a la fecha de cierre,
     no más antigua que `closing_rate_max_age_days` (7 días, dato); la fecha es el menor entre el fin
     del período y hoy; ver P-88,
     contra ganancia o pérdida en diferencial cambiario; el ajuste es acumulado y no se reversa al
     abrir el período siguiente. **Pregunta exacta:** «¿La revaluación mensual de partidas monetarias
     en divisa se deja acumulada o se reversa el primer día del período siguiente, y va a las mismas
     cuentas del diferencial realizado o a cuentas propias de diferencial no realizado?»
  2. **IGTF documentado con nota de débito.** **Aplicada:** el cobro no se reversa (409). **Pregunta
     exacta:** «¿Un IGTF percibido indebidamente que se documentó con nota de débito se corrige con una
     nota de crédito de esa nota de débito?»
  3. **Retención soportada corregida.** **Aplicada:** se anula el comprobante y se vuelve a cargar con
     el mismo número. **Pregunta exacta:** «¿El agente de retención que corrige un comprobante emite
     uno nuevo con otro número, o el mismo número con el importe corregido?»
  4. **La cartera entre cierres (H10; VALIDAR-CONTABLE).** **Aplicada:** el cobro de una factura en
     divisa reconoce el diferencial COMPLETO contra la tasa de la factura (histórico), aunque un
     cierre anterior ya la hubiera revaluado; la revaluación previa de esa factura se deshace sola en
     el cierre siguiente («lo que debe llevar − lo que lleva», neto por cuenta). A granularidad de
     período equivale a «revaluar y reversar al abrir», pero ENTRE cierres las cuentas por cobrar del
     mayor quedan sobrevaluadas (o subvaluadas) por lo revaluado de documentos ya cobrados, y el
     resultado del mes del cobro muestra el diferencial entero mientras el del mes siguiente muestra
     el reverso. **Pregunta exacta:** «¿Se acepta que la revaluación de un documento cobrado se
     deshaga en el cierre siguiente, o el cobro debe medir su diferencial contra el valor revaluado
     (la tasa del último cierre) y no contra la tasa de la factura?» **Alternativa:** que el cobro
     cancele el valor revaluado (el diferencial del cobro sería solo el del tramo desde el último
     cierre).

  **Ampliada (AF-M12, AF-M13, AF-M15, 2026-10-03).** Al punto 1: ver P-92 (efecto en ISLR) y P-83
  (cuentas separadas). Al punto 2: los arts. 22-23 de la PA 00071 hablan de notas que modifican
  FACTURAS; no se halló regla sobre una nota de crédito que corrija una nota de débito. **Pregunta
  adicional:** «¿La nota de crédito que deshace una nota de débito por IGTF referencia la nota de
  débito o la factura original?» Al punto 3: el comprobante es un documento del AGENTE (PA 000054
  art. 16); el proveedor solo lo transcribe. **Pregunta adicional:** «Si el agente anula y reemite
  un comprobante, ¿el proveedor registra el nuevo en el período de su entrega (art. 7) y qué hace
  con el anterior si ya lo descontó?»

- **P-88 · La tasa de cierre (VALIDAR-CONTABLE; ADR-0075 §6, H7, ola 3).** **Aplicada, decidida por
  criterio:** la tasa de cierre de un período es la oficial del BCV más reciente con fecha no
  posterior a la fecha de cierre y con no más de **7 días** de antigüedad (parámetro de plataforma
  `closing_rate_max_age_days`, dato y no código); fuera de ese margen el cierre se detiene y pide la
  tasa. Si el período todavía no terminó, la revaluación se fecha el día del cierre (hoy, día de
  Caracas) y usa la tasa de ese día. **Pregunta exacta:** «¿La tasa de cierre es la del último día
  hábil del período? ¿Qué antigüedad máxima se admite?» **Alternativa:** exigir la tasa publicada
  exactamente para el último día hábil del mes (margen 0 con calendario de feriados). **Ampliada
  (AF-M02, 2026-10-03).** Para la conversión FISCAL, LIVA art. 25 manda al día hábil siguiente
  cuando el día no es hábil. **Pregunta adicional:** «¿La tasa de cierre contable de un fin de mes
  no hábil es la del último día hábil del mes o la publicada con fecha valor del primer día hábil
  siguiente?»

- **P-89 · La retención soportada que se anula después de declarada (VALIDAR-TRIBUTARIO; LIVA art.
  11, PA SNAT/2025/000054; ADR-0075 §8, H9, ola 3).** **Aplicada, decidida por criterio (lo más
  estrecho):** si el comprobante ya entró en una declaración de IVA generada después de cerrar su
  período, su reversa se RECHAZA (409 `RETENTION_PERIOD_DECLARED`); nada cambia en el libro ni en
  la declaración presentada. **Pregunta exacta:** «¿La retención soportada que se anula después de
  declarada se ajusta en el período en que se detecta (como la anulación tardía de una venta) o
  exige declaración sustitutiva?» **Alternativa anotada:** admitir la reversa y llevar un ajuste
  negativo de retenciones soportadas al período corriente. **IGTF:** no existe todavía una
  declaración de IGTF persistida (no hay período de IGTF «declarado» que proteger); la percepción
  de un cobro reversado queda `pendiente_reintegro` (P-67). Cuando exista esa declaración, la misma
  regla y la misma pregunta. **Ampliada (AF-M11, AF-M13, 2026-10-03).** Normas leídas: PA 000054
  arts. 7 y 16 no regulan corrección ni anulación de comprobantes; LIVA art. 50 (versión 2005): el
  ajuste que no cambia el impuesto va al período en que se detecta, y hay sustitutiva solo si
  cambia el impuesto a pagar; instructivo del TXT (lado del agente): la declaración registrada no
  se anula, el ajuste va en la próxima. **IGTF:** PA 000013 art. 4: lo indebido YA ENTERADO se
  restituye y se pide en reintegro; no se compensa. **Preguntas adicionales:** (a) «Un IGTF
  percibido y todavía no enterado cuyo cobro se reversa, ¿simplemente no se declara?» (b) «Si ya se
  enteró, ¿el total de esa quincena se conserva como se declaró y el reintegro se tramita aparte?»
  (c) «Si el dinero en divisa sí entró y después se devolvió, ¿la percepción fue debida, como en la
  devolución de G-06, o indebida?» **Ampliada (revisión de la última ronda, 2026-10-03; migración
  20261003230000).** Aplicado: «después de su quincena» se mide contra el fin de la quincena DE LA
  PERCEPCIÓN (`platform.fiscal_fortnight`), no contra el rango consultado. (d) «Si una factura con
  IGTF percibido se ANULA (no se reversa su cobro) después de cerrada la quincena de la percepción,
  ¿esa percepción se trata igual que la del cobro reversado —se conserva en el total declarado y
  se tramita el reintegro— o de otra forma?» Hoy Ladino no alcanza ese caso (una factura con
  cobros no se anula, ADR-0061) y la percepción no guarda el instante en que pasó a
  `pendiente_reintegro`: si el caso llega a existir, esa percepción no cuenta en ningún total
  hasta que se guarde ese instante.
  **Aplicada (AF-M11, 20261003220000):** el IGTF de un cobro reversado DESPUÉS del fin de su
  quincena sigue contando en el total de esa quincena y se lista aparte como pendiente de
  reintegro; el reversado dentro de ella no cuenta (`platform.igtf_period_totals`; PA
  SNAT/2022/000013 art. 4). Decidido por criterio; alternativa: rebajar la quincena.

## Auditoría fiscal de la familia de moneda (ola 3, 2026-10-03)

- **P-90 · AF-M04 · El IVA por línea y lo que la factura imprime por alícuota (VALIDAR-TRIBUTARIO; PA 00071 art. 13 num. 10-11).** **Aplicada, decidida por criterio:** el IVA en Bs se redondea por línea (la fórmula literal de la respuesta del dueño, §2.7) y el PDF imprime, por alícuota, la suma de bases y la suma de IVA; en una factura de n líneas el IVA impreso puede apartarse de «base impresa × alícuota» hasta 0,005 × n Bs. La misma respuesta enunció el invariante «exacto por alícuota»; lo implementado y lo que vigila `fiscal_amount_gaps` es exacto por línea. No se halló norma que fije la unidad de cálculo ni el redondeo. **Pregunta exacta:** «¿El IVA de la factura se calcula sobre la base total de cada alícuota (un solo redondeo por alícuota) o puede ser la suma del IVA redondeado de cada línea? Si el agente de retención recalcula base × alícuota y su 75 % difiere en céntimos del nuestro, ¿qué cifra manda?» **Alternativa:** IVA por alícuota sobre la base sumada, repartiendo el residuo entre líneas. **Dónde se toca:** `fiscalDeLinea` (sales.ts), `fiscal_amount_gaps`, la tolerancia de `registerSupportedRetention` (declarations.ts; ver P-30).
- **P-91 · AF-M14 · Anular una factura cuyo cobro se reversó (VALIDAR-TRIBUTARIO; PA 00071 art. 36, LIVA art. 58; ola 4, G-10).** **Aplicada, decidida por criterio (ADR-0075):** un cobro reversado no cuenta y la factura vuelve a poder anularse. Norma leída (reproducción): el art. 36 solo manda conservar original y copias de lo anulado; el art. 58 de la LIVA manda corregir con nota la operación que queda sin efecto después de facturada. **Pregunta exacta:** «¿Qué condiciones permiten ANULAR una factura en lugar de emitir nota de crédito: tener el original y todas las copias, que el período no esté declarado, que el cliente no haya tomado el crédito? ¿Haber tenido un cobro, aunque se reversara, lo impide?» **Alternativa:** que la reversa de un cobro no habilite la anulación. La regla de anulación se rehace en la ola 4 (G-10) y pregunta por el original en mano y por el período, haya habido cobro o no. **Dónde se toca:** `annulInvoice` (sales.ts).
- **P-92 · AF-M15 · La diferencia en cambio y el ISLR (VALIDAR-TRIBUTARIO).** **Aplicada:** la revaluación mensual y el diferencial al cobrar o pagar van a resultados; Ladino no calcula ISLR. En la reproducción de la LISLR 2015 (G.O. 6.210 Ext.) no se localizó el artículo sobre ganancias y pérdidas cambiarias (una fuente académica lo sitúa en el art. 186, sin texto leído); los SPE están excluidos del ajuste por inflación (art. 171). **Pregunta exacta:** «¿La ganancia o la pérdida cambiaria no realizada de la revaluación al cierre es gravable o deducible en el ejercicio, o solo cuando se cobra, se paga o es exigible? ¿Qué artículo lo dice hoy y aplica igual a un sujeto pasivo especial?» **Dónde se toca:** `revaluarAlCierre` (accounting.ts), papeles `exchange_gain` / `exchange_loss`.

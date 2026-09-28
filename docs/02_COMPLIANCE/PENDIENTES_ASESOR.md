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

## P-3 · Arrastre COMBINADO vs. separado — DECIDIDO (2026-09-28, L-05)

**Decisión del dueño:** dos arrastres separados, como en la Forma 00030:
`excedente_credito_fiscal` y `retenciones_acumuladas_por_descontar`. Nunca una sola cifra.
Se implementa con migración nueva; las filas viejas conservan la cifra combinada (insert-only).
**Queda para el asesor:** confirmar la lectura → P-37.

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

## P-20 · El fiado cobrado a otra tasa — DECIDIDO (2026-09-28, D-07/G-11)

El diferencial entre la tasa del documento y la del pago se reconoce **al pagar**, en «Ganancia /
Pérdida en diferencial cambiario», **sin nota de débito ni de crédito**. Las NC y ND que corrigen
una factura van a la tasa de la factura.
**Aviso de norma:** el art. 51 del Reglamento de la LIVA, leído solo en reproducción no oficial,
diría que esa diferencia es corrección de precio documentable con ND o NC. Si el asesor confirma
su vigencia y alcance, **manda la norma** sobre esta decisión (VALIDAR-TRIBUTARIO).

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
- **P-31 · G-06** — IGTF de una venta devuelta. **Aplicada:** queda percibido; solo la anulación
  lo hace indebido. **Alternativa:** tratar la devolución total del mismo día como anulación.
- **P-32 · E-02 / H-01** — Procedimiento para regularizar IGTF no percibido y retenciones no
  practicadas en períodos vencidos. **Aplicada:** enterar en la quincena en que se debió, con los
  recargos del COT; comprobante con la fecha real. **Alternativa:** la que indique el asesor.
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
  contador.
- **P-37 · L-05** — Dos arrastres separados en la declaración del especial. **Aplicada:**
  separados. **Alternativa:** una sola cifra (lo de antes).
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
- **P-41 · B-19** — Ejercicio y UT de referencia para las 1.500 UT del art. 8 de la PA 00071.
  **Aplicada:** ingresos brutos del ejercicio anterior a la UT vigente en ese ejercicio (hoy Bs 43
  → Bs 64.500). **Alternativa:** UT vigente al evaluar.
- **P-42 · A-06 / P-16** — Redacción definitiva de la leyenda del recibo no fiscal. **Aplicada:**
  la de P-16.
- **P-43 · I-11** — Retiros (LIVA art. 4.3): base imponible (valor de mercado) y documento.
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

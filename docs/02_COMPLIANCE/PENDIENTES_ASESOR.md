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

## Resumen para la conversación con el asesor

Si el tiempo con el asesor es corto, este es el orden por **coste de resolverlo
tarde**:

1. **P-3** (arrastre combinado vs. separado) — migración sobre tabla con historia.
2. **P-4** (prorrata) — cambia cifras ya generadas.
3. **P-7** (layout del TXT) — bloquea la primera carga real al portal.
4. **P-1** (casillas) — bloquea que la planilla deje de ser «demostrativa».
5. **P-8** y **P-9** (IGTF: exenciones y reintegro) — solo si la empresa es SPE.
6. El resto puede esperar sin acumular deuda.

# ADR-0065 — La nota de crédito del proveedor, la factura anulada y lo que nadie vigilaba

- **Estado**: aceptada (dueño, 2026-09-17, con las respuestas fiscales verificadas que cita este
  ADR: «dale a la 67»).
- **Fecha**: 2026-09-17 (migraciones 67 y 68)
- **Módulos**: compras · libros fiscales · declaración de IVA · contabilidad · inventario
- **Rigor**: máximo. Enmienda ADR-0039 §retenciones (momento del devengo) y completa ADR-0042
  (todo hecho produce asiento o cola).
- **HOMOLOGATION_IMPACT**: **YES** en contenido: cambia el crédito fiscal declarado, lo que
  imprime el libro de compras y el momento en que nace el pasivo por retención.

## Contexto

El QA fiscal del 2026-09-17 (agentes `fiscal-reviewer` y `accounting-invariants`, más pruebas
contra la base) encontró seis defectos. Los cuatro primeros producen o pueden producir una cifra
equivocada en un libro, en la declaración o en el mayor; los dos últimos son controles que no
vigilan lo que dicen vigilar.

Medido en la base local, con una factura de proveedor de 1.600 de IVA, otra ANULADA de 800 y una
nota de crédito de 800:

| Cifra | Antes | Debe decir |
|---|---|---|
| Libro de compras · IVA crédito | 2.400 | 800 |
| Declaración · créditos del período | 1.600 | 800 |
| Asientos generados por la nota de crédito | 0 | 1 |
| Hechos sin asiento que el control ve | la nota NO aparece | aparece |

En producción no hay todavía ninguna nota de crédito de proveedor ni ninguna factura de proveedor
anulada: **no hay libros dañados**, y por eso esto se arregla antes de que los haya.

## Decisión

### 1. La nota de crédito recibida del proveedor es un hecho contable y fiscal completo

Va al asiento, al libro y a la declaración, y el control de cobertura la vigila.

**Norma** (respuestas verificadas por el dueño, 2026-09-17):
- **LIVA art. 56**: los contribuyentes registran las notas de débito y de crédito que **emitan o
  reciban**.
- **LIVA art. 37**: se deduce del crédito fiscal el impuesto de las operaciones **posteriormente
  anuladas**, en el período en que ocurre la anulación.
- **Reglamento de la LIVA art. 70**: los libros registran las notas modificatorias.
- **Reglamento art. 75 literal a**: el libro de compras registra fecha y número de la factura,
  **nota de débito o de crédito**.
- **Reglamento art. 11**: la devolución de mercancía no es una venta nueva: genera nota de
  crédito.

**Período**: el de **recepción de la nota**, no el de la factura que corrige (LIVA art. 37).

### 2. Una factura de proveedor anulada se registra en el libro CON IMPORTES EN CERO

Conserva la traza documental que exige el registro cronológico y sin atrasos (Reglamento
art. 70) sin inflar el crédito fiscal (LIVA art. 37), y hace que el libro y la planilla digan la
misma cifra. Mismo criterio para una nota de crédito anulada.

Antes, el libro sumaba el IVA de las anuladas y la planilla no: dos documentos oficiales que se
contradecían.

### 3. El pasivo por retención de IVA nace al REGISTRAR la factura

**Norma**: PA SNAT/2025/000054 (G.O. 43.171, 16/07/2025; vigente 01/08/2025; deroga la PA
SNAT/2015/0049): la retención se practica **al pago o al abono en cuenta, lo que ocurra
primero**. Registrar la factura del proveedor como cuenta por pagar **es** el abono en cuenta.

En consecuencia:
- el asiento de la factura acredita `retention_iva_payable` y `retention_islr_payable`, y
  acredita cuentas por pagar por el **neto** (total − retenciones);
- el asiento del pago debita cuentas por pagar por el **neto** que sale del banco, y ya no crea
  el pasivo con el fisco;
- el saldo del auxiliar de proveedores descuenta la retención, para que el auxiliar y el mayor
  digan lo mismo.

Antes, una factura registrada y no pagada al cierre tenía comprobante de retención emitido y
numerado, presente en el libro de compras, y **cero pasivo en el balance**.

**Plazo del comprobante**: los dos primeros días hábiles del período siguiente (la 000054 lo
mantiene; verificado con fuentes secundarias — texto primario pendiente de archivar,
VALIDAR-SENIAT en `REGULATORY_STATUS.md`). El comprobante se sigue emitiendo y numerando **al
pagar**; cuándo debe entregarse, ahora que la retención se practica antes, es consulta abierta
(PENDIENTES_ASESOR, P-26).

**Por qué estas dos plantillas se corrigen en sitio y no se versionan.** Versionar (ADR-0055) es
lo correcto cuando cambia la regla en una fecha: cada hecho se asienta con la plantilla vigente
el día del hecho. Aquí no cambió la regla —la providencia rige desde 2025-08-01—, cambió nuestra
lectura: estábamos asentando mal. Versionar por fecha del hecho haría que una factura o un pago
con fecha anterior a hoy se siguieran asentando con el error, a propósito. Los asientos ya
generados no se tocan, que son inmutables; lo que se corrige es cómo se asienta de aquí en
adelante, incluidos los documentos con fecha pasada.

**Consecuencia asumida.** Una factura registrada ANTES de la migración 68, con retención
calculada y sin pagar, tiene su asiento viejo acreditando el bruto. Su saldo en el auxiliar baja
ahora por la retención y el pago debitará ese neto: quedan en cuentas por pagar los bolívares de
la retención, que se sacan con un asiento manual (débito cuentas por pagar / crédito retención
de IVA por pagar). En producción son 2 facturas, las dos de la empresa de pruebas «ferretería»;
la consulta que las lista está en la cabecera de la migración.

### 4. Lo que no debe poder hacerse, falla solo

- **Una línea nueva en un asiento ya posteado se rechaza.** La protección de `journal_lines`
  cubría UPDATE y DELETE, no INSERT: se podía romper Σdébitos = Σcréditos sin que ningún trigger
  mirara, porque el que cuadra el asiento cuelga de `journal_entries`. Ningún camino del código
  lo hacía; la regla de la casa es que falle activamente (CLAUDE.md §2).

### 5. Un control rojo tiene que distinguir la causa

- **Anulación con el costo en cola**: al anular una venta cuyo costo de lo vendido seguía
  pendiente, sus movimientos quedaban sin asiento y sin cola, y el control los contaba como
  huecos. Ahora los movimientos de un documento anulado cuyo kardex netea a cero no son un hueco:
  no hay nada que asentar. Un rojo que no distingue causas enseña a ignorarlo.
- **Kardex contra mayor**: `inventory_ledger_gap` sumaba el kardex entero, ignorando el corte
  (`inventory_ledger_cutovers`) que su hermana sí respeta. En cuanto se regularice una empresa
  con histórico, quedaría en rojo para siempre. Ahora respeta el corte.

### 6. Los controles miran también el dinero

`accounting_coverage_gaps` cubría diez fuentes, pero no el cobro, el pago a proveedor, la
percepción de IGTF ni la nota de crédito de proveedor. Hoy ninguno queda huérfano —los cuatro
casos de uso propagan el error y la transacción se revierte—, pero el invariante que no existe no
caza nada (R-20): un camino nuevo que escriba un cobro sin generar asiento no lo vería nadie.
Ahora las cuatro fuentes están en el control.

## Consecuencias

- **Cifras que cambian**: el crédito fiscal declarado baja por las notas de crédito recibidas; el
  libro de compras deja de sumar anuladas; el balance muestra el pasivo por retención desde el
  registro de la factura.
- **Aserciones de prueba que cambian**: se listan en el mensaje del commit, una por una, con su
  motivo. Ninguna se toca sin que el cambio esté escrito.
- **Producción**: sin notas de crédito de proveedor ni facturas anuladas, ninguna cifra ya
  guardada cambia. Las declaraciones y libros regenerados a partir de ahora usan las reglas
  nuevas.
- **Reversibilidad**: las dos migraciones son funciones, plantillas versionadas y una columna
  nueva; se deshacen restaurando las versiones anteriores. Los asientos ya generados no se
  reescriben.

## Lo que sigue siendo del asesor

- **Prorrata (LIVA art. 34)**: si las operaciones **no sujetas** entran en el denominador. Se
  mantiene la prorrata global v1 con su `VALIDAR-TRIBUTARIO` visible; incluirlas es lo
  conservador, porque deduce menos crédito. Con contabilidad separada no hay prorrata
  (art. 35). Pregunta concreta en `PENDIENTES_ASESOR.md`.
- Los puntos abiertos de ADR-0064 §3 (nota por fiado cobrado a otra tasa), P-19, P-21 y P-22.

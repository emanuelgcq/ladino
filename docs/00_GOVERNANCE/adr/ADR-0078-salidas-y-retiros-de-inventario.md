# ADR-0078 — Salidas y retiros de inventario: tres verbos, un motivo con CHECK, y el retiro es una venta a la propia empresa

- **Estado:** ADR aplicado según la respuesta del dueño del 2026-09-28 (§2.13). Hallazgos: I-01, I-02, I-05, I-06, I-07, I-08, I-09, I-10, I-11, I-12 y P-10.
- **Fecha:** 2026-10-02.
- **Impacto fiscal:** SÍ: el retiro causa débito fiscal (LIVA art. 4.3) y va al libro de ventas.
- **Enmienda:** ADR-0034 (inventario) y ADR-0060 (inventario en el mayor), en los tipos de movimiento y sus cuentas.

## Contexto
El recorrido encontró:
- un solo verbo para trasladar, ajustar y sacar (I-08);
- el motivo como nota libre (I-01);
- las mermas contra el costo de ventas (I-11);
- el consumo propio y los regalos sin débito fiscal (I-11);
- un conteo que no calcula la diferencia (I-07);
- un kardex sin tipos legibles (I-06);
- «por agotarse» que ignora lotes e inactivos (I-12, P-10).

## Decisión
1. **Tres verbos distintos:**
   - `traslado`, entre depósitos y sin cambio de valor;
   - `ajuste por conteo`: la diferencia entre lo contado y el sistema, con motivo;
   - `salida con motivo`: merma, rotura, vencido, consumo propio, regalo, donación o muestra.
2. **El motivo es una columna con CHECK**, no una nota, y viaja al asiento.
3. **Contabilidad y fiscal de las salidas:**
   - las mermas, roturas, vencidos y faltantes justificados van a «Pérdidas por mermas y faltantes de inventario», un gasto operativo con cuenta propia que no es costo de ventas. Son faltantes justificados solo con motivo y evidencia (RLIVA art. 14);
   - **el consumo propio, el regalo, la donación y la muestra son retiros (LIVA art. 4.3):** generan débito fiscal sobre el valor de mercado y un documento interno «Nota de retiro» numerado, que va al libro de ventas como venta a la propia empresa;
   - en una empresa sin RIF, el retiro deja solo la salida de kardex y el gasto.
4. **Conteo:** un verbo «Conteo». La persona escribe lo que contó, el sistema calcula la diferencia y propone el ajuste con motivo.
5. **Kardex por depósito con tipos legibles.**
6. **No se vende sin existencia (E-13):** el ajuste muerto se elimina. Cuando la caja no encuentra existencia, ofrece «Registrar llegada rápida» (ADR-0066).
7. **Pausado (I-05, C-03):** inactivo significa «no se vende», no «no existe». Sale de la cuadrícula y de la búsqueda de la caja, pero sigue en el inventario con la marca «inactivo» y su existencia. Al inactivar con existencia, la pantalla avisa.
8. **«Por agotarse» (I-12, P-10):** cuenta la existencia total, incluida la que está en lotes, y excluye los inactivos.

## Consecuencias
- **Positivas:**
  - cada salida dice qué es y adónde va en el mayor;
  - el retiro tributa como manda la LIVA;
  - el conteo es un flujo, no una cuenta mental.
- **Negativas:**
  - un documento interno nuevo (Nota de retiro) con su numeración;
  - un CHECK nuevo sobre el motivo: los movimientos viejos no se tocan (append-only), y el CHECK aplica a los nuevos (NOT VALID o columna nueva);
  - la cuenta de mermas se agrega al plan de las empresas existentes.
- **Para revertir:** los tipos y la cuenta son aditivos. Las notas de retiro emitidas no se borran.

## Verificación
- Invariantes: `inventory_ledger_gap()` e `inventory_coverage_gaps()` en cero con las salidas nuevas; el retiro en el libro de ventas cuadra con `book_ledger_reconciliation()`.
- E2E: traslado sin cambio de valor; conteo con diferencia; merma a su cuenta; consumo propio con débito fiscal y Nota de retiro; «por agotarse» con lotes.
- `pnpm recorrido I` y `P`.

## Nota de aplicación (ola 3, migración 20261003110000, 2026-10-03)

**Qué quedó en el código:**
- `inventory_moves.exit_reason`: columna nueva con CHECK de lista cerrada, solo en salidas; los
  movimientos viejos quedan con NULL (append-only intacto). `reason` sigue siendo el texto libre del
  ajuste y la revaluación. La API exige el motivo (`IssueStockRequest.reason`, enum).
- Cuentas 5.1.08 «Pérdidas por mermas y faltantes de inventario» (`inventory_shrinkage`) y 5.1.09
  «Retiros de inventario (uso propio, obsequios, donaciones y muestras)» (`inventory_withdrawal`),
  en ve_basico y en los planes ya importados; hechos del preset `inventory_move/stock.shrinkage` y
  `inventory_move/stock.withdrawn`, sin tocar el vocabulario de `source_kind`. La descripción del
  asiento lleva el motivo (I-11).
- `public.inventory_withdrawal_notes`: Nota de retiro append-only, correlativo por empresa puesto
  por la base, fechada con el instante del movimiento. `sales_book`, `sales_book_by_rate`,
  `sales_book_summary` y `recompute_iva_period` la leen como venta a la propia empresa.
- `POST /v1/inventory/counts` (conteo, `inventory.adjust`): lo contado entra; la diferencia la
  calcula el servidor bajo el bloqueo; `preview` la enseña sin escribir.
- `low_stock_products`: suma todas las posiciones (con lote o sin él) y excluye lo no activo.
- Web: motivo de lista en «Salida», verbo «Conteo», kardex por depósito con tipos legibles (I-06),
  campos marcados y un solo aviso (I-09), «Ajuste registrado» (I-10), el inactivo con existencia
  sigue en /inventario con su marca y el formulario de producto avisa al inactivarlo (I-05).

**Decidido por criterio (§2.16), con su alternativa:**
1. **Valor de mercado del retiro** = precio de la lista principal (detal) vigente a la tasa del día,
   al céntimo. Alternativa: el costo del kardex. VALIDAR-TRIBUTARIO P-75.
2. **La Nota de retiro no consume número de control** (documento interno, serie «NR»).
   Alternativa: factura a sí mismo con control de la imprenta. VALIDAR-SENIAT P-76.
3. **El retiro tiene cuenta propia (5.1.09)** y su IVA es gasto del mismo retiro. Alternativa:
   «Gastos operativos» (5.1.05) para los dos. VALIDAR-CONTABLE P-77.
4. **«Faltante» es un motivo de salida** (faltante justificado fuera de un conteo), además de los
   siete del ADR. Alternativa: dejarlo solo al conteo. ~~El ajuste por conteo sigue en 5.1.04.~~ (Sustituido en la re-revisión: el faltante de un conteo va a 5.1.08 y exige evidencia; ver más abajo.)
5. **El adquirente del retiro, para la alícuota**, es el tipo de contribuyente de la propia empresa.
6. **I-05: el inactivo no se mueve.** El trigger del kardex (LAD38) sigue rechazando mover un
   producto inactivo; la pantalla lo avisa al inactivar («no podrás venderlo ni moverlo hasta
   reactivarlo; si ya no lo tienes, regístralo antes como salida»). Alternativa: liberar LAD38 para
   todo menos la venta, que toca el oráculo del kardex (`apply_inventory_move`): queda abierta.
   El pausado sin existencia no se lista en /inventario ni infla «Sin existencia».
7. **I-08: los tres verbos tienen permiso propio** (`inventory.transfer`, `inventory.adjust` para
   ajuste y conteo, `inventory.move` para la salida). Que el almacenista tenga los tres por su rol
   es separación de funciones (ADR-0068, `cuatro_ojos`): se deja a esa familia.
8. **La familia del céntimo (ADR-0075 §7)** no se adelanta: el kardex sigue a 8 decimales; solo la
   base y el IVA de la nota (importes del libro en bolívares) van al céntimo.

### Revisión (migración 20261003110100)

- **La nota congela su adquirente:** `company_tax_id_snapshot`, `company_name_snapshot` y
  `company_taxpayer_type_snapshot`, rellenados por el trigger; el libro lee de ahí. Un cambio de RIF
  no reescribe un libro ya generado (pgTAP 103).
- **Invariante `withdrawal_note_gaps()`** (respuesta correcta: cero): retiro sin nota cuando la empresa
  facturaba, y nota con IVA sin ese IVA en su asiento ni en cola. En `scripts/recorrido/invariantes.sql`.
- **El conteo** acepta `expected_system_quantity` (aditivo): si el sistema cambió bajo el bloqueo,
  409 CONFLICT y la web recalcula. Un producto por lotes exige el lote ANTES de bloquear.

**Decidido por criterio (revisión), con su alternativa:**
9. **I-05 (§2.12):** inactivo = no se vende; la mercancía sí se mueve (salida, traslado, conteo).
   Lo implementa la familia del céntimo en su redefinición de `apply_inventory_move` (20261003140000);
   aquí, el aviso de Productos y el E2E (la venta del inactivo se rechaza; la salida por vencido de un
   inactivo entra en cuanto esa migración esté aplicada). Sustituye la decisión 6.
   *Alternativa:* el inactivo congelado (la decisión 6 original).
10. **El retiro exento cuenta en la prorrata** (lectura literal: el retiro está asimilado a venta,
    LIVA art. 4.3). *Alternativa:* solo los retiros gravados. VALIDAR-TRIBUTARIO P-78.
11. **Un retiro fechado en un período ya declarado se rechaza** (criterio B-1: declarado = una
    generación hecha después de cerrar el período, día contra día). *Alternativa:* aceptarlo en el
    período de hoy, lo que separaría la fecha del kardex de la del libro.
12. **§2.13 «faltantes justificados solo con motivo y evidencia»:** el faltante de un conteo con motivo
    va a 5.1.08 (hecho `stock.counted`; el sobrante sigue contra 5.1.04), y la salida por merma,
    rotura, vencido o faltante exige `evidence` (aditivo; sin ella, 422; CHECK NOT VALID en la
    base). Sustituye la parte de la decisión 4 sobre el conteo. *Alternativa:* el faltante del conteo
    en 5.1.04 y la evidencia opcional. La pregunta del faltante SIN justificar va a P-77.

### Re-revisión (migración 20261003110200)

- **B1 · El faltante de un conteo lleva su evidencia.** El conteo escribe un `ajuste` sin
  `exit_reason`, y la revisión (110100) lo mandó a 5.1.08 sin que el CHECK de la evidencia lo
  alcanzara: era una puerta lateral a «Pérdidas por mermas y faltantes» sin soporte. Ahora
  `POST /v1/inventory/counts` acepta `evidence` (aditivo, la misma forma que en la salida) y la
  exige al REGISTRAR una diferencia negativa (422 en palabras de persona); la vista previa y el
  sobrante no la piden. La pantalla la pide cuando la vista previa da faltante, con el mismo campo
  de la salida. En la base, la regla es de familia: ningún hecho `inventory_move/stock.counted`
  —asiento o fila de la cola— nace para un movimiento que baja existencia sin `exit_evidence`
  (trigger `count_shortage_needs_evidence` en `journal_entries` y `journal_generation_queue`).
  El corte está en el enunciado (`platform.invariant_cutoffs`, `count_shortage_evidence`): los
  faltantes de conteo anteriores no se reescriben. De paso el CHECK de la evidencia deja de aceptar
  una evidencia en un movimiento sin motivo de pérdida (el `NULL` de `exit_reason in (…)` lo
  dejaba pasar). pgTAP 103b con su variante rota; E2E `e2e-salidas-inventario`.
- **B2 · `withdrawal_note_gaps` se queda como está (invoker).** La re-revisión pidió hacerla
  `security definer` «como las demás `*_gaps`». Comprobado en el catálogo: ninguna `*_gaps` es
  definer, y todas las tablas que lee (`inventory_withdrawal_notes`, `journal_entries`,
  `journal_lines`, `journal_generation_queue`, `company_account_settings`) comparten la misma
  policy de lectura por empresa, sin permiso: quien ve la nota ve su asiento, y el falso
  «nota_sin_iva_en_el_asiento» no puede darse. Hacerla definer la apartaría de su familia y
  obligaría a una guarda propia. pgTAP 103b la ejerce como `authenticated` (cajero) y da cero.
- **B3 · Cada hecho publica el nombre de su hecho contable** (corregido tras el gate: el pgTAP 026
  prohíbe un vocabulario paralelo entre el preset y el outbox): el conteo publica y audita
  `stock.counted`; la merma, la rotura, el vencido y el faltante, `stock.shrinkage`; el retiro,
  `stock.withdrawn`; el ajuste suelto sigue en `stock.adjusted` y el costo de venta en
  `stock.shipped`. Los tres están en `EVENT_CATALOG.md` y en el registro del test 026.
- **B4 ·** la pantalla del conteo solo trata como «la existencia cambió» el 409 con `code`
  `CONFLICT`; cualquier otro 409 enseña su mensaje.

**Decidido por criterio (re-revisión), con su alternativa:**
13. **El faltante de un conteo exige evidencia** (§2.13: «faltantes justificados solo si llevan
    motivo y evidencia», RLIVA art. 14): la salida «faltante» ya la exigía y el conteo llega a la
    misma cuenta. *Alternativa:* no exigirla y preguntar al asesor si el faltante de conteo sin
    soporte puede ir a 5.1.08.

## Nota de la auditoría fiscal (2026-10-03)

**Hallazgo AF3-01 (severidad alta).** El RLIVA (Decreto 206, G.O. 5.363 Ext., 12-07-1999), art. 31,
según reproducción no oficial (pandectasdigital, leído el 2026-10-03; cotejo con la Gaceta
pendiente), dice:

> «Para el caso de retiro, desincorporación, autoconsumo y faltante en los inventarios de bienes
> muebles, que forman parte del objeto, giro o actividad de la empresa, se entenderán ocurridos o
> perfeccionados los hechos imponibles y nacida la obligación tributaria, en el momento en que
> sucedan dichos hechos, oportunidad en que deberá emitirse obligatoriamente la correspondiente
> factura por parte del contribuyente y efectuarse su registro en la columna especial del Libro de
> Ventas.»

Ladino emite hoy una Nota de retiro interna, serie «NR», sin número de control (decisión 2 de la
nota de aplicación: «documento interno»). **Manda la norma sobre esa decisión** (RESPUESTA §0: si un
texto normativo vigente contradice una decisión, manda la norma).

**Qué se rehace en la ola 5, en una sola familia («el retiro se factura»):** la Nota de retiro pasa a
ser FACTURA, con número de control y columna especial del Libro de Ventas, junto con:

- **AF3-02b** — el faltante sin justificar: su débito (LIVA art. 4.3; RLIVA arts. 13-14).
  VALIDAR-TRIBUTARIO P-81.
- **AF3-03** — los motivos no gravados: uso en el giro, traslado al activo fijo e incorporación a un
  inmueble del negocio (LIVA art. 4.3 in fine). Hoy «consumo propio» siempre causa débito.
  VALIDAR-TRIBUTARIO P-82.
- **AF3-04** — la merma justificada en el Libro de Ventas como no gravada (RLIVA art. 14); hoy no
  aparece. VALIDAR-CONTABLE P-77.
- **AF3-05** — la base del retiro es el precio de venta asignado, no menor al de mercado (RLIVA
  art. 43): respalda la lista detal, pero un precio de lista 0 pasa. VALIDAR-TRIBUTARIO P-75.
- **AF3-06** — la corrección de un retiro emitido por error: hoy no tiene corrección fiscal; siendo
  factura, se corrige con nota de crédito.
- **AF3-07** — `coalesce(taxpayer_type_code,'ordinario')` en el snapshot de la nota y la lectura de
  `companies` en vivo.

**Hasta entonces queda como está construida**, y los retiros no se liberan en producción
(RISK_REGISTER R-70, PENDIENTES_ASESOR P-76).

## Enmienda (ola 5, 2026-10-04): ADR-0082

**La decisión 2 de la nota de aplicación («la Nota de retiro no consume número de control») queda
sustituida por [ADR-0082](ADR-0082-el-retiro-de-inventario-se-factura.md):** el retiro gravado
emite una FACTURA DE RETIRO con control del talonario (migraciones 20261005100000 a 100600). Las
Notas de retiro ya emitidas no se tocan y siguen en el libro; `withdrawal_note_gaps()` lleva el
corte en su enunciado. AF3-01, AF3-03 (con su cuenta por papel), AF3-04, AF3-05, AF3-06 (anulación
del mismo día y, pasado el día, la nota de crédito total del retiro) y AF3-07 quedan aplicados;
AF3-02b sigue rechazando el faltante sin evidencia (P-81). Los retiros **siguen sin liberarse en
producción** hasta que el asesor responda P-76.

# ADR-0037 — Numeración fiscal: el correlativo del emisor y el número de control son dos campos, no uno

- **Estado:** Aceptado
- **Fecha:** 2026-08-27
- **Impacto fiscal:** SÍ
- **Consume:** ADR-0029 (el régimen fiscal es dato versionado) · **Aplica:** PA 102 Art. 7
- **Cierra parcialmente:** `OPEN_QUESTIONS` 10 — el modelo de datos. El flujo de dos fases con la
  imprenta sigue abierto y se dice dónde.

## Contexto

Es la decisión que se difirió dos veces —al construir clientes y al construir inventario— y que
ventas ya no puede esquivar: sin ella no se puede crear la tabla `documents`.

Ninguna spec la resuelve, y eso se comprobó documento a documento:

- `SENIAT_PA102_DIGITAL_INVOICING.md:20-24` (Art. 7) los enumera como **campos distintos exigidos
  por la norma**: «numeración consecutiva y única» *y* «número de control asignado por imprenta
  digital» *y* «rango/control cuando aplique».
- `FISCAL_DOCUMENTS_SPEC.md:39-41` los pone como dos ítems de la misma lista de identidad congelada,
  sin relacionarlos; `:55` dice que la respuesta de la imprenta trae el `control number`.
- `ADR-0029:123` **declara el hueco a propósito**: la numeración «interna o de imprenta, con sus
  reglas de serie y número de control» es de las cosas que varían por régimen y que la cuarta ancla
  de versión gobierna. No es un olvido, es un diferimiento con dueño.

Lo único cierto por norma citada es que **son dos conceptos legalmente distintos**. Todo lo demás
—cuántas columnas, quién asigna cada uno, en qué transición— no existía en ninguna parte.

## Decisión

### Dos columnas, nunca una

```
documents.document_number   -- correlativo DEL EMISOR. Lo asigna Ladino.
documents.control_number    -- número de control. Lo asigna la IMPRENTA. Nullable.
```

Fundirlos en un campo sería inventar que la norma pide un solo número cuando enumera dos. Es
exactamente la clase de invención que `CLAUDE.md` §2 prohíbe, y la más cara de deshacer: si se
descubre en producción, hay que renumerar documentos ya emitidos, que es imposible por definición.

### `document_number`: sin huecos, y el hueco se conserva al anular

- Único por `(company_id, kind, series)`. Lo asigna Ladino al pasar a `issued`.
- **Se conserva al anular.** Un documento anulado mantiene su número y nadie más lo recibe: el
  correlativo del emisor no puede saltarse un número, porque un salto en una fiscalización es
  indistinguible de un documento ocultado. Anular no libera; anular deja un documento anulado.
- Nunca se reutiliza. No hay `UPDATE` que lo mueva.

### `control_number`: nullable, y su origen lo decide el régimen

`fiscal_number_ranges (company, kind, series, from, to, next_available, status, printer_source)`
modela el mundo en el que la imprenta **preasigna un rango autorizado**, que es como funciona la
forma libre venezolana: la imprenta autoriza del N al M y el emisor los consume en orden.

`platform.claim_control_number()` reserva el siguiente de forma **atómica** (`FOR UPDATE` sobre la
fila del rango). Dos emisiones simultáneas obtienen números distintos o una espera; ninguna recibe
el mismo, y no hay ventana entre leer y escribir.

Cuando la imprenta asigna **documento a documento**, el rango no existe y `control_number` se
rellena con lo que devuelva su respuesta, después de `issued`. Por eso la columna es nullable: hay
un instante legítimo en que el documento existe y su número de control todavía no.

### El régimen decide, y el esquema lo obliga

`fiscal_regimes.numbering_mode` toma tres valores: `none`, `internal_only`, `range`, `per_document`.

- `none` / `internal_only` → `control_number` **debe ser NULL** en `issued`.
- `range` → `control_number` **debe existir** en `issued`, y sale de un rango.
- `per_document` → puede ser NULL en `issued` y llenarse después.

Un trigger lo comprueba contra el régimen vigente de la empresa **en la fecha de emisión**
(LAD49). No es un CHECK porque necesita mirar otra tabla, que es la misma razón por la que las
reglas del movimiento de inventario viven en `apply_inventory_move()`.

Y `documents.regime_version_id` **se congela con el documento** (ADR-0029 §3): cambiar de régimen
mañana no reinterpreta lo emitido ayer.

## Consecuencias

**Positivas.** El modelo admite los cinco regímenes de ADR-0029 sin ramas de código. Un cliente sin
emisión fiscal usa `internal_only` y nunca ve un número de control. El día que se elija imprenta,
lo que cambia es una fila de catálogo, no el esquema.

**Negativas, y son reales:**

- **`control_number` nullable es una puerta.** Un régimen mal configurado como `per_document`
  dejaría emitir sin número de control indefinidamente. La defensa es el trigger y el catálogo de
  regímenes, que es dato del operador — o sea, la misma clase de punto único de fallo que
  `permissions.is_scoped` (ADR-0025). Se acepta con la misma mitigación: es una lista corta, se
  toca por migración y hay un test que la mira.
- **El rango se agota.** Si `next_available > to`, la emisión se detiene. Es correcto —emitir fuera
  del rango autorizado sería emitir un documento inválido— pero significa que **una empresa puede
  quedarse sin poder facturar** por un dato administrativo. Por eso hay alerta por umbral
  configurable y la consulta `platform.range_exhaustion()`; la notificación es del worker y se
  difiere.
- **El flujo de dos fases sigue abierto** (`OPEN_QUESTIONS` 10): qué cuenta como emitido si la
  imprenta responde tras un timeout y el cliente ya reintentó. Este ADR **no lo resuelve** y no
  finge hacerlo: `per_document` existe como forma de datos, y el protocolo concreto se decidirá con
  el proveedor elegido, detrás de la interfaz de ADR-0028. Hasta entonces ese modo no se habilita en
  ninguna empresa. **VALIDAR-SENIAT.**
- La numeración es un punto de serialización por `(company, kind, series)`. Con volumen alto de
  facturación concurrente, las emisiones de una misma serie se ordenan. Es inherente a «sin huecos»:
  cualquier diseño que evite el bloqueo admite huecos.

**Revertir:** mientras no haya documentos emitidos, `drop`. Con documentos, no — es numeración
fiscal.

## Nota de implementación: `set_row_provenance()` exige `version`

Escrito aquí porque esta migración chocó con ello y la próxima tabla con forma propia volvería a
chocar. `platform.set_row_provenance()` escribe **`created_by`, `created_at` y `version` — las
tres**. Una tabla con el trigger y sin la columna `version` muere en el primer `INSERT` con
`record "new" has no field "version"`, y eso no se ve leyendo la definición de la tabla.

**No se deriva una variante `set_row_provenance_no_version()`**, y la razón ya estaba decidida en
S0.4: `audit_events.version` es una columna muerta —esa tabla no admite `UPDATE`— y se conservó
igualmente porque *«cuatro bytes cuestan menos que una excepción en un trigger compartido, y un
trigger con casos especiales se aplica mal»* (ADR-0026). Dos funciones de procedencia serían dos
sitios donde la política puede divergir, y elegir la equivocada **no falla**: escribe una fila con
procedencia incompleta, en silencio. Ese es peor modo de fallo que el error ruidoso de hoy.

La regla queda al revés de lo que parece: **toda tabla con trigger de procedencia lleva
`version integer not null`, aunque nunca se actualice. Si no puede llevarla, lo que no debe llevar
es el trigger** — como `fiscal_regimes`, que es catálogo del operador y solo tiene `created_at`.

Está también en `comment on function platform.set_row_provenance()`, para que se lea desde `psql`
sin abrir este ADR.

## Verificación

pgTAP 021: dos peticiones concurrentes del siguiente número obtienen números **distintos** y ambas
se registran; `issued` sin control cuando el régimen lo exige muere con LAD49; `issued` **con**
control cuando el régimen no lo permite también; anular conserva el `document_number` y el siguiente
documento **no** lo reutiliza (se consulta y se ve el hueco cerrado); un rango agotado detiene la
emisión.

# ADR-0042 — Contabilización síncrona con COLA de pendientes, y su invariante

- **Estado:** Aceptado
- **Fecha:** 2026-08-27
- **Impacto fiscal:** NO (no cambia el documento fiscal; cambia cuándo se asienta)
- **Aplica:** ADR-0041 (mapeo como dato) y el ciclo de vida de todo documento del sistema

## Contexto

El asiento contable de una venta tiene que existir. La pregunta es **cuándo**, y hay dos respuestas
razonables con consecuencias muy distintas:

- **Síncrono**, en la misma transacción del documento. Garantiza que un documento emitido y su
  asiento son un solo hecho: no hay ventana en la que uno exista sin el otro.
- **Asíncrono por outbox**, como un efecto más. Desacopla, y abre la ventana.

Síncrono es lo correcto: **el outbox es para efectos externos, no para invariantes internos.** Un
asiento no es una notificación; es parte de lo que significa que la venta ocurrió.

Pero síncrono tiene un corolario que hay que mirar de frente. Las plantillas de mapeo nacen vacías
(ADR-0041). Si el asiento es una precondición de la emisión, entonces **una empresa recién creada
no puede facturar, ni comprar, ni pagar, hasta que un contador configure el mapeo completo**. El
radio de daño es mayor que el de R-16 y R-18 juntos: allí faltaba un dato para una operación
concreta; aquí faltaría para todas.

## Decisión

### Síncrono cuando hay plantilla; cola cuando no

`platform.generate_journal_entry_from_source()` se llama en la misma transacción del documento.

- **Con plantilla activa**: genera el asiento y lo postea. Documento y asiento commitean juntos o
  no commitea ninguno.
- **Sin plantilla**: el documento se emite igual y se inserta una fila en
  `journal_generation_queue`, pendiente, con su motivo. Un endpoint y una pantalla la muestran, y
  otro endpoint la procesa cuando el mapeo exista.

El razonamiento es el que separa una ilegalidad de una tarea atrasada. **Un documento fiscal sin
regla tributaria es ilegal** —por eso ADR-0038 detiene la emisión—. **Un documento sin asentar
todavía es «pendiente de contabilizar»**, que es un estado normal en cualquier contabilidad real y
que ningún contador consideraría una avería.

### El invariante, y es un test

> **Todo documento en estado `posted` / `issued` tiene EXACTAMENTE UNA de estas dos cosas: un
> asiento contable, o una fila pendiente en la cola. Nunca ninguna. Nunca las dos.**

No es una aspiración: es una consulta que se ejecuta en pgTAP sobre el catálogo entero, del mismo
tipo que «el kardex reproduce el saldo» (ADR-0034) y que la propiedad de S0.4 sobre las tablas con
`tenant_id`. Si un documento se queda sin las dos, la contabilidad tiene un agujero silencioso; si
tiene las dos, se contabilizará dos veces.

La cola se cierra —`status = 'generated'`— **en la misma transacción** que crea el asiento, para
que las dos mitades del invariante no puedan estar verdaderas a la vez ni un instante.

### La idempotencia es del EVENTO, no del documento

`UNIQUE (company_id, source_kind, source_id, source_event)` sobre `journal_entries`, con
`source_event` tomado del **vocabulario de outbox que ya existe** (`fiscal.invoice.issued`,
`ar.payment_applied`, `ap.payment_made`, `purchase.landed_cost_applied`…).

Sin el eje del evento, una factura podría asentarse al emitirse y no al cobrarse, porque
`(source_kind, source_id)` ya estaría ocupado. Con él, cada hecho de la vida del documento tiene su
asiento y solo uno. Reutilizar el vocabulario del outbox en vez de inventar otro no es economía:
es que **la contabilidad y las notificaciones hablen del mismo hecho con el mismo nombre**, que es
lo que permite cruzarlas cuando algo no cuadra.

### Trazabilidad bidireccional

El asiento apunta al documento (`source_kind`, `source_id`) y el documento apunta al asiento
(`journal_entry_id`, nullable, cargado al postear). La redundancia es deliberada: sin ella, «¿qué
asiento generó esta factura?» exige recorrer `journal_entries`, y esa es la pregunta que más se
hace en una auditoría.

## Consecuencias

**Positivas.** El sistema es usable desde el minuto uno sin contador. La contabilidad se puede
poner al día después sin perder nada, porque la cola guarda qué falta y por qué. Documento y
asiento son atómicos cuando pueden serlo.

**Negativas, y hay que decirlas:**

- **Una cola que nadie mira es una contabilidad que no existe.** Es el riesgo real de esta
  decisión, y no lo resuelve el esquema: lo resuelve que el contador vea el contador de pendientes.
  Va a la pantalla de cierre, donde no se puede ignorar: **un período no se cierra con pendientes
  en la cola**.
- **El asiento generado tarde usa la plantilla de HOY**, no la del día del documento. Se mitiga
  congelando en la cola el contexto monetario del documento (importes y tasa), que es lo que no
  puede cambiar; el mapeo sí puede haber cambiado, y eso queda registrado en el asiento con su
  `rules_version`.
- **Síncrono acopla**: si el generador falla por un defecto, la venta no se emite. Es el precio de
  la atomicidad y se acepta; lo que NO se acepta es que falle por configuración ausente, y para eso
  está la cola.

## Alternativas descartadas

- **Síncrono estricto.** Convierte una consecuencia en precondición y deja el sistema inservible
  hasta que alguien configure catorce papeles contables.
- **Todo por outbox.** Abre una ventana en la que un documento emitido no tiene asiento y nada lo
  registra. El invariante de arriba dejaría de poder comprobarse.
- **Generar el asiento en borrador siempre.** Parece prudente y es peor: acumula borradores que
  bloquean el cierre y nadie distingue el que espera revisión del que espera mapeo.

# ADR-0028 — La transmisión al SENIAT es un consumidor de outbox tras interfaz

- **Estado:** Propuesto · **Fecha:** 2026-08-15 · **Impacto fiscal:** SÍ
- **Se apoya en:** ADR-0005 (outbox transaccional), ADR-0026 (esquema del outbox), ADR-0027
- **Motivado por:** la expectativa pública de normativa nueva con estándares técnicos y
  **protocolos de comunicación**, tras la derogación de PA SNAT/2024/000121

## Contexto

PA121 exigía «capacidad de remisión electrónica al SENIAT de registros de facturación en la forma
exigida» (Art. 3 numeral 2). Esa obligación concreta **cayó** con la derogación. Pero la norma que
se espera apunta a **protocolos de comunicación**, y ahí hay un patrón que conviene leer bien:

**La remisión es el requisito que sobrevive a la reforma.** La 121 lo exigía; la norma esperada
apunta a lo mismo. Cambia el protocolo, el formato y la cadencia — no cambia que, si el Estado
quiere los datos, va a querer recibirlos por algún canal.

La pregunta de diseño no es *«¿qué protocolo implementamos?»* —no se puede responder, no hay
norma— sino *«¿dónde tiene que encajar el protocolo cuando exista, para que enchufarlo cueste un
adaptador y no una reescritura?»*. Esa sí se puede responder hoy, y es más barata hoy que después,
porque el outbox acaba de construirse en S0.4 y todavía no tiene consumidores que condicionen su
forma.

## Decisión

**La transmisión al SENIAT se diseña como un consumidor del outbox, con el protocolo detrás de una
interfaz. No forma parte del dominio.**

### La forma, concretamente

```
caso de uso  →  [misma transacción]  →  outbox (event_type fiscal.*, schema_version)
                                            ↓
                                     apps/worker
                                            ↓
                            SeniatTransmitter (interfaz, en packages/fiscal)
                                            ↓
                        ┌───────────────────┴───────────────────┐
                    NullTransmitter                    <adaptador real>
                (hoy: no hay norma)              (cuando exista protocolo)
```

Cuatro propiedades, y cada una responde a algo que ya sabemos que va a cambiar:

1. **El dominio no sabe que el SENIAT existe.** Un caso de uso emite `fiscal.invoice.issued` al
   outbox y termina. Que ese evento se transmita, a quién, cuándo y en qué formato, no es asunto
   suyo. Si mañana hay que transmitir también a otro organismo, es otro consumidor, no un cambio
   en el dominio.

2. **La transmisión hereda las garantías del outbox, que ya están construidas y probadas.**
   Entrega *at-least-once* con reintentos, backoff y cola de fallos; el consumidor es idempotente.
   Es exactamente lo que hace falta frente a un servicio externo del Estado, que va a estar caído
   con más frecuencia que cualquier otra dependencia. Y ya tiene prueba de concurrencia real
   (`scripts/outbox-concurrency.mjs`).

3. **El protocolo vive tras la interfaz**, en `packages/fiscal`, junto al adaptador de imprenta
   digital y por el mismo motivo (ADR-0003). Cambiar de protocolo es escribir otra implementación,
   no tocar el dominio.

4. **La implementación por defecto es `NullTransmitter`**, que no transmite nada y lo dice. **No
   es un stub que se olvidó de implementar: es la implementación correcta del estado regulatorio
   actual**, en el que no existe destino al que transmitir. La distinción importa: un stub silencioso
   se descubre en producción; una implementación nula declarada es una decisión legible.

### Qué se construye ahora y qué no

**Ahora, porque es barato y porque condiciona la forma del outbox:**

- Los `event_type` fiscales del catálogo entran y salen del outbox sin que el esquema los rechace.
  Esto **no era cierto** cuando se escribió este ADR: el `CHECK` de S0.4 admitía dos segmentos y
  los siete eventos fiscales de `EVENT_CATALOG.md` tienen tres. Lo corrige la migración 11.
- `schema_version` por evento, ya en el esquema, para que un transmisor futuro distinga payloads
  viejos sin adivinar por su forma.
- La interfaz `SeniatTransmitter` y el `NullTransmitter`, cuando exista `packages/fiscal`.

**No ahora, y no por falta de tiempo sino porque sería inventar:**

- El protocolo, el formato del payload, la cadencia, la autenticación, el endpoint.
- La cola de reintentos específica del SENIAT, sus tiempos y su política de dead-letter: dependen
  de las garantías que exija la norma.
- Cualquier campo del payload de transmisión. **`VALIDAR-SENIAT`**: no hay fuente.

## Consecuencias

**Buenas.**

- Cuando se publique el protocolo, el trabajo es un adaptador con sus tests. El dominio no se toca
  y la contabilidad no se vuelve a probar.
- Un SENIAT caído no bloquea la emisión: el evento queda en `pending` y se reintenta. Sin este
  diseño, la caída de un servicio del Estado tumbaría la facturación del cliente.
- La transmisión es auditable con lo ya construido: cada intento deja rastro en el outbox
  (`attempts`, `last_error`, `published_at`).

**Malas, y asumidas.**

- **Se construye estructura para un requisito que hoy no existe.** Si la norma nueva no exige
  transmisión, sobra una interfaz y una implementación nula. Es un coste pequeño y acotado, y la
  alternativa —descubrir que hace falta cuando ya hay documentos emitidos— es cara.
- **At-least-once significa que el SENIAT puede recibir un evento dos veces.** Si la norma futura
  exige exactly-once, hará falta deduplicación **del lado del transmisor**, con la clave que esa
  norma defina. El outbox no puede darla solo.
- **`NullTransmitter` en producción es una decisión que hay que poder ver.** Debe aparecer en
  observabilidad, no quedarse callada.

## Alternativas descartadas

**Llamar al SENIAT desde el caso de uso, dentro de la transacción.** Descartada por lo mismo que
ADR-0005: una llamada de red dentro de una transacción de base de datos mantiene abiertos
conexión y bloqueos durante todo el viaje. Con un servicio del Estado de disponibilidad
desconocida, es la vía directa a que un timeout externo tumbe la facturación. Es además el mismo
problema que el revisor fiscal señaló para la imprenta digital.

**Esperar a que se publique la norma para diseñar nada.** Descartada: la decisión barata —*dónde*
encaja— se puede tomar hoy, y tomarla hoy es lo que impide que se resuelva con prisa cuando haya
plazo. Además condiciona el `CHECK` de `event_type`, que ya está aplicado y hubo que corregir.

**Un módulo `seniat` en el dominio.** Descartada por ADR-0027: la regulación entra por el borde,
no por el centro. Un organismo receptor en el dominio es acoplar el modelo de negocio a un
destinatario administrativo que puede cambiar de nombre, de protocolo o desaparecer — como acaba
de ocurrir.

## Verificación

| Qué | Dónde |
|---|---|
| Los siete `event_type` fiscales del catálogo entran en `outbox` y `audit_events` | pgTAP, contra los nombres reales de `EVENT_CATALOG.md` (migración 11) |
| Ningún paquete de dominio importa el transmisor | `dependency-cruiser` (ADR-0021) |
| `NullTransmitter` es visible en observabilidad, no silencioso | cuando exista `apps/worker` (S0.6) |
| Un transmisor caído no bloquea la emisión | test de integración con el worker (S0.6) |

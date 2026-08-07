# ADR-0005 — Transactional outbox para efectos secundarios

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** SÍ

## Contexto
Emitir una factura implica: persistir, contabilizar, mover inventario, notificar y enviar a la
imprenta. Si el envío externo va dentro de la transacción, un timeout de la imprenta deshace
una venta ya cobrada. Si va fuera, se pierde cuando el proceso muere.

## Decisión
El evento se inserta en `outbox` **dentro de la misma transacción** que el cambio de estado.
`apps/worker` lo consume con al-menos-una-vez, backoff exponencial con jitter y DLQ con alerta.
Todo consumidor es idempotente.

## Consecuencias
- (+) Cero eventos perdidos, cero transacciones colgadas de un tercero.
- (−) Consistencia eventual en los efectos externos: la UI debe reflejar "en proceso" y no
  mentir diciendo "enviado a SENIAT" cuando aún está en cola.
- (−) Todo consumidor necesita test de doble entrega.

## Verificación
Test que mata el worker a mitad de proceso y verifica que al reiniciar no duplica el efecto.

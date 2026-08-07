# apps/worker

Procesador de outbox y jobs de Ladino.

## Reglas

- Todo consumidor es **idempotente**. Se asume entrega al-menos-una-vez.
- Reintentos con backoff exponencial y jitter. Tope de intentos, luego DLQ.
- Un mensaje en DLQ genera alerta. No se descarta en silencio.
- El worker **no** inventa efectos contables: reejecuta casos de uso del dominio.
- Nada de trabajo fiscal crítico sin registrar `fiscal_event` con el intento y la respuesta.
- Métricas obligatorias: lag de cola, tasa de reintento, profundidad de DLQ, latencia de imprenta.

## Jobs previstos

Emisión fiscal diferida y reintentos · notificaciones · recordatorios de cobranza ·
generación de reportes y libros · cierres programados · sincronización de tasas de cambio
(con `source` y `rate_timestamp`, nunca una tasa sin origen).

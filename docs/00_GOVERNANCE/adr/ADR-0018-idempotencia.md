# ADR-0018 — Idempotencia obligatoria por clave de cliente

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** SÍ

## Contexto
Conectividad irregular, usuarios que tocan dos veces, reintentos automáticos de la app móvil.
Sin idempotencia, todo eso produce facturas duplicadas y pagos dobles.

## Decisión
Header `Idempotency-Key` obligatorio en: emisión de factura, pagos, cobros, posting de asientos,
reintentos fiscales y posting de nómina.

Tabla `idempotency_keys(key, company_id, endpoint, request_hash, response, status, created_at)`
con índice único. Se escribe **dentro** de la transacción del caso de uso. Una segunda llamada
con la misma clave devuelve la respuesta original; con la misma clave y distinto cuerpo devuelve
`409 IDEMPOTENCY_KEY_REUSED`.

En offline, `client_command_id` cumple ese papel.

## Consecuencias
- (+) Reintentar es seguro siempre. La app móvil puede reintentar sin preguntar.
- (−) Se retiene la respuesta un tiempo (política de retención a definir, mínimo 24 h).

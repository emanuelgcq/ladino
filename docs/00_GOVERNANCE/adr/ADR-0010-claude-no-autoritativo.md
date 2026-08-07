# ADR-0010 — La IA nunca es autoridad contable ni fiscal

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** SÍ

## Contexto
Claude aporta valor real en OCR de facturas de compra, categorización, explicación de reportes,
detección de anomalías y redacción de cobranza. Ninguna de esas cosas requiere que decida.

## Decisión
La IA **propone**; una regla determinista o una persona **dispone**.

Prohibido para la IA: asignar número fiscal, decidir una tasa legal, postear un asiento sin
reglas y aprobación, cerrar un periodo, aprobar un pago, modificar un documento emitido.

Toda sugerencia aceptada guarda: modelo, versión de prompt, tool calls, usuario que aprobó,
timestamp y resultado. Esa evidencia es auditable y se conserva con el documento.

## Consecuencias
- (+) El sistema sigue siendo defendible ante una auditoría: toda cifra tiene una regla detrás.
- (+) Un cambio de modelo no cambia resultados contables históricos.
- (−) Menos automatización de la técnicamente posible. Es el precio correcto.

## Verificación
Ninguna escritura en tablas contables o fiscales tiene como único origen una salida de modelo.

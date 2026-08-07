# ADR-0013 — Dinero con Decimal en TypeScript y numeric(24,8) en Postgres

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** SÍ

## Contexto
Venezuela combina bolívares con alta variación, dólares, tasas de cambio con muchos decimales,
IVA, retenciones e IGTF. Un error de un céntimo por redondeo, multiplicado por un libro de
ventas, es un hallazgo de auditoría.

## Decisión
- Postgres: `numeric(24,8)` para todo monto y toda tasa.
- TypeScript: `decimal.js` encapsulado en `packages/money`. El tipo `number` no aparece en
  ninguna firma monetaria.
- JSON: los montos viajan como **string**. `format: decimal` en OpenAPI.
- El redondeo es explícito y nombrado por contexto (moneda, impuesto, documento, pago).
  Se conservan los valores pre-redondeo cuando la auditoría los necesita.

## Consecuencias
- (+) Reproducibilidad exacta de cualquier cálculo histórico.
- (−) Más verboso que operar con números. Un hook de Claude Code bloquea `number` y `parseFloat`
  en los paquetes financieros para que la disciplina no dependa de la memoria.
- (−) Serializar como string obliga a formatear en la UI. Es lo correcto: obliga a pensar el redondeo.

## Verificación
Property-based tests en `packages/money` y `packages/accounting`.

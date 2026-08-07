# ADR-0020 — Modelo multimoneda con moneda funcional y trazabilidad de la tasa

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** SÍ

## Contexto
La operación real venezolana mezcla bolívares y dólares en el mismo día, a veces en el mismo
documento. La tasa aplicable, su fuente y su momento son datos con consecuencias fiscales.

## Decisión
Todo importe persiste **siete** campos: `amount_transaction_currency`, `transaction_currency`,
`fx_rate`, `functional_amount`, `functional_currency`, `rate_source`, `rate_timestamp`.

La moneda funcional se configura por empresa. La contabilidad cuadra en moneda funcional.
El diferencial cambiario se reconoce como tal, con su propio asiento; nunca se absorbe en
un redondeo. Las tasas viven en una tabla con vigencia por fecha y fuente citada: sin `source`
no se persiste una conversión.

## Consecuencias
- (+) Cualquier cifra histórica se puede explicar años después: qué tasa, de dónde, de cuándo.
- (−) Esquema más ancho y más lógica en cada cálculo. No hay alternativa correcta más barata.
- (−) **`VALIDAR-TRIBUTARIO`**: qué fuente de tasa es la exigible para cada tipo de documento
  es una pregunta abierta para el asesor.

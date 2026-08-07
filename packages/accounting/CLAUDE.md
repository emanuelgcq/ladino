# packages/accounting

Motor de partida doble. **Puro. Sin I/O.** Recibe datos y reglas, devuelve asientos.

## Invariantes que este paquete garantiza

1. `sum(debit) === sum(credit)` en moneda funcional, en todo asiento producido.
2. Un asiento `posted` es inmutable. La corrección es una **reversión** más un asiento nuevo.
3. No se postea en un periodo cerrado. La validación vive aquí, no en la UI.
4. Toda línea lleva cuenta, centro de costo si aplica, montos en moneda de transacción **y**
   funcional, con `fx_rate`, `rate_source`, `rate_timestamp`.
5. El diferencial cambiario se reconoce explícitamente, nunca se absorbe en el redondeo.
6. Cada asiento guarda la `rules_version` con la que se generó, para poder reproducirlo años después.

## Estilo

Funciones puras, `Result<T, DomainError>` en vez de excepciones de control de flujo,
reloj y reglas inyectados como parámetros. Si una función necesita `Date.now()`, está mal diseñada.

## Tests primero

Aquí no se escribe implementación antes que el test. Property-based sobre el invariante 1
con generación aleatoria de documentos. Ver `docs/06_QA/ACCOUNTING_INVARIANTS_TESTS.md`.

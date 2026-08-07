# Performance

## Cargas
- 100 concurrent POS por tenant grande.
- 1k emisiones/min en benchmark técnico, ajustar a objetivo real.
- 10M inventory moves.
- 10M journal lines.
- reportes anuales.

## Métricas
p50/p95/p99, error rate, locks, DB CPU, worker lag.

## Regla
Optimizar sin relajar integridad transaccional.

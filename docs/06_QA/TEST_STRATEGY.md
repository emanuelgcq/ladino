# Estrategia de pruebas

## Pirámide
- unit: dominio/money/tax/accounting.
- integration: DB/RLS/services.
- contract: imprenta/API.
- E2E: flujos.
- property-based: invariantes contables/inventario.
- security.
- performance.
- DR.

## Datos
Factories sintéticas; no usar datos reales de clientes en CI.

## Gates
No merge si falla:
- accounting invariant;
- RLS isolation;
- fiscal immutability;
- migrations.

# Offline y sincronización

## Filosofía
Online-first. Offline solo para tareas que puedan reconciliarse de forma segura.

## Seguro offline
- catálogo cache;
- conteos;
- borradores;
- fotos/soportes;
- cotizaciones no fiscales.

## Restringido
- pagos;
- movimientos de stock definitivos;
- facturas fiscales;
- cierres.
Requieren protocolo específico.

## Queue
Cada comando:
- `client_command_id`;
- created_at local;
- payload;
- version;
- attempts;
- status.

Servidor aplica idempotencia.

## Conflictos
Nunca “last write wins” en:
- stock;
- dinero;
- documentos;
- contabilidad.
Resolver por comando de dominio y devolver conflicto explícito.

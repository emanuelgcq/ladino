# ADR-0006 — Ledger append-only con defensa en dos capas

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** SÍ

## Contexto
La inmutabilidad de asientos y documentos fiscales es un requisito legal, no una preferencia.
Confiar solo en que el código de aplicación "no haga UPDATE" es insuficiente: un script de
mantenimiento, una migración apurada o una consulta manual bastan para romperlo.

## Decisión
Para `journal_entries`, `journal_lines`, `fiscal_events`, `fiscal_documents`, `inventory_moves`,
`audit_events` y `payment_ledger`:
1. **Sin policies RLS de `update`/`delete`.**
2. **Trigger `BEFORE UPDATE OR DELETE` que lanza excepción**, efectivo incluso para `service_role`.

Las correcciones son reversiones y documentos nuevos. Sin soft-delete: estados y reversiones.

## Consecuencias
- (+) La inmutabilidad es estructural, no depende de disciplina.
- (−) Los errores de datos requieren un procedimiento formal de corrección, más lento.
- (−) Crecimiento monótono de tablas: se prevé particionado por `company_id`/fecha cuando las
  métricas lo justifiquen.

## Verificación
Test pgTAP que intenta `update` como `service_role` y espera excepción.

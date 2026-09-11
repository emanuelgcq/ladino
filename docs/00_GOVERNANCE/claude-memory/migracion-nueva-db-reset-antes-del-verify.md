---
name: migracion-nueva-db-reset-antes-del-verify
description: "Con una migración NUEVA, correr `pnpm db:reset` ANTES del verify: los E2E (paso 5) usan la base local vieja y la migración solo se aplica en el paso 10"
metadata: 
  node_type: memory
  type: project
  originSessionId: e5ddae20-4236-42c7-a011-6eca2cb4c4e5
  modified: 2026-09-11T16:24:06.974Z
---

El orden de `pnpm verify` pone los tests (paso 5, que incluyen la integración de
la API contra Postgres local) ANTES de `db:reset` (paso 10). Con una migración
recién escrita, el primer verify corre los E2E contra el esquema ANTERIOR.

Visto el 2026-09-10 con la migración 47 (`rounding_policy_id` en
`igtf_perceptions`): cuatro E2E de IGTF dieron **500** —la columna no existía—,
el verify murió en el paso 5 y el pgTAP ni llegó a correr. Parecía un bug del
código y era el orden del gate.

**Why:** el paso 10 existe para probar que TODAS las migraciones aplican desde
cero; no está pensado para preparar la base de los tests del paso 5.

**How to apply:** al añadir una migración, `pnpm db:reset` primero y después
`TURBO_CONCURRENCY=1 pnpm run verify`. Diagnóstico rápido si un E2E da 500 tras
una migración: `docker exec supabase_db_ladino psql -U postgres -tAc "select
... from information_schema.columns ..."`. Relacionado: [[verify-memory-limits]],
[[db-reset-borra-cuentas-locales]].

---
name: nuevo-modulo
description: Playbook para construir un módulo funcional completo de Ladino de punta a punta (spec → migración → dominio → API → UI → tests). Úsalo cuando la tarea sea "implementa el módulo X" o "arranca inventario/ventas/compras/tesorería".
---

# Construir un módulo de Ladino

## Fase 0 — Investigar (obligatoria)

Lanza el subagente `spec-explorer` con el nombre del módulo. Espera su síntesis.
No leas tú las 15 specs: contamina el contexto y luego no queda espacio para implementar.

Si el reporte trae `HUECOS`, **preséntalos al usuario y pregunta antes de decidir**.

## Fase 1 — Plan

Presenta y espera aprobación explícita:

- entidades y relaciones nuevas;
- migraciones (una por preocupación, no una gigante);
- casos de uso de dominio con su transacción;
- endpoints con permisos `resource.action`;
- eventos de outbox emitidos;
- pantallas web y, si aplica, mobile;
- tests: unitarios de dominio, pgTAP de RLS, integración, E2E si es flujo crítico;
- `HOMOLOGATION_IMPACT`.

## Fase 2 — Construir, en este orden

1. `packages/schemas` — Zod del módulo. Es el contrato, va primero.
2. Migración vía subagente `migration-author` (incluye RLS + pgTAP).
3. `packages/domain` (o `accounting`/`fiscal`/`inventory`) — lógica pura, **con tests primero**.
4. `apps/api` — endpoint delgado: autentica, autoriza, valida, delega, responde.
5. `apps/worker` — consumidores de outbox si el módulo emite eventos.
6. `apps/web` — pantallas. Sin lógica de negocio.
7. `apps/mobile` — solo si está en el P0 mobile de la spec.

## Fase 3 — Revisar

- Si toca dinero, datos o permisos → subagente `auditor-codigo` (hereda los checklists de
  invariantes contables y de RLS/aislamiento).
- Si toca facturación/impuestos → subagente `auditor-fiscal` (emite `HOMOLOGATION_IMPACT`).
- Antes de commitear → subagente `revisor` sobre el diff (recorre la Definition of Done).
- Gate → subagente `validador`, o `pnpm gate` (`scripts/gate-verdict.sh`) — nunca a ojo.

## Fase 4 — Entregar

Formato de la sección 6 del `CLAUDE.md` raíz. Nada de commits sin aprobación.

---
name: handoff
description: Cerrar una sesión de trabajo de Ladino dejando un handoff que permita retomar sin releer todo. Úsalo cuando el contexto se esté llenando o al terminar una jornada.
---

# Handoff de sesión — Ladino

Escribe `docs/00_GOVERNANCE/HANDOFF.md` (sobrescribe el anterior; el histórico está en git).

```md
# Handoff — YYYY-MM-DD

## Estado
Fase actual y en qué punto del `IMPLEMENTATION_PLAN.md` estamos.

## Hecho en esta sesión
- ...

## En vuelo (incompleto)
- Archivo, qué falta, por qué se detuvo.

## Decisiones tomadas
- ... (si alguna es estructural, ¿se creó el ADR?)

## Decisiones pendientes del usuario
- Preguntas concretas, con opciones.

## Bloqueantes
- VALIDAR-SENIAT / VALIDAR-TRIBUTARIO abiertos que afectan lo siguiente.

## Siguiente paso concreto
Una sola frase: qué debe hacer la próxima sesión primero.

## Estado del repo
- Rama, último commit, migraciones aplicadas, `pnpm verify` verde SÍ/NO.
```

Sé específico. "Continuar con ventas" no sirve. "Implementar el caso de uso
`confirmSalesOrder` en packages/domain, ya existe la migración 0012 y el schema Zod" sí.

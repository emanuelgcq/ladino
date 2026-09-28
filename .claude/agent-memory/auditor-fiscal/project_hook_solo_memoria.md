---
name: hook-solo-memoria
description: guard-agentes.sh impide a auditor-fiscal escribir fuera de su memoria, incluido docs/02_COMPLIANCE; los encargos de "cargar en docs" se entregan como contenido listo en el informe
metadata:
  type: project
---

El hook `guard-agentes.sh` bloquea cualquier Edit/Write de auditor-fiscal fuera de
`.claude/agent-memory/auditor-fiscal/`, aunque el encargo pida editar `docs/02_COMPLIANCE/` (comprobado 2026-09-28).

**Why:** confinamiento por agente (R6/R7); el que escribe en docs es otro agente (reparador) o el principal.

**How to apply:** si un encargo pide editar docs, no intentes rodear el hook: entrega el texto completo listo para pegar
(fichero por fichero) en el informe, y dilo al principio para que el llamante lo aplique. Ver [[normas-verificadas]].

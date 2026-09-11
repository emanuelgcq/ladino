---
name: verify-memory-limits
description: pnpm verify en esta máquina se cae por memoria si turbo corre en paralelo; usar TURBO_CONCURRENCY=1
metadata: 
  node_type: memory
  type: project
  originSessionId: e5ddae20-4236-42c7-a011-6eca2cb4c4e5
  modified: 2026-08-24T21:05:50.414Z
---

En la máquina de trabajo (Windows, 16 GB, ~2 GB libres con Docker Desktop y un stack Supabase
de OTRO proyecto —`padrino-academy`— levantado junto al de Ladino), `pnpm verify` a
concurrencia por defecto muere con `VirtualAlloc failed` / `AlignedAlloc out of memory` /
exit `-1073740791` (0xC0000409) en tsc/eslint/vitest. No es un fallo de código.

**Why:** turbo lanza lint+typecheck+test+build de ~16 paquetes a la vez; cada tsc/vitest es
cientos de MB. Visto el 2026-08-24 (S0.6a); la misma sesión de Claude Code se cayó una vez
por lo mismo con un subagente corriendo encima.

**How to apply:** ejecutar `TURBO_CONCURRENCY=1 pnpm verify` (o `--concurrency=1` en turbo
directo) y no lanzar `docker build` ni subagentes pesados a la vez. Los contenedores de
`padrino-academy` no son de Ladino: no pararlos sin que el usuario lo pida. Ver también
[[ladino-workflow]].

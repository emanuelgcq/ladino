# Estructura del monorepo — Ladino

pnpm workspaces + Turborepo (ADR-0001). El repositorio es también el espacio de trabajo de
Claude Code: la capa `.claude/` es parte del producto de ingeniería, no un accesorio.

```text
ladino/
  CLAUDE.md                    # instrucciones raíz (se carga siempre)
  AGENTS.md                    # puntero para otras herramientas de agente
  .claudeignore
  .mcp.json                    # servidores MCP: supabase (read-only), github
  .claude/
    settings.json              # permisos allow/ask/deny + hooks
    hooks/                     # guard-immutability, guard-infra, post-edit-verify, session-start
    agents/                    # spec-explorer, migration-author, accounting-invariants,
                               # fiscal-reviewer, rls-security-auditor, mobile-expo
    skills/                    # nuevo-modulo, migracion-supabase, caso-de-uso, adr,
                               # deploy-vps, revision-completa, handoff
  apps/
    web/        CLAUDE.md      # Vite + React + React Router + TanStack Query
    mobile/     CLAUDE.md      # Expo + React Native
    api/        CLAUDE.md      # Hono sobre Node 22
    worker/     CLAUDE.md      # outbox, jobs, reintentos
  packages/
    money/         CLAUDE.md   # Decimal, redondeo, FX. Puro.
    accounting/    CLAUDE.md   # partida doble. Puro.
    fiscal/        CLAUDE.md   # documentos, numeración, imprenta. Release train propio.
    inventory/                 # costeo, kardex. Puro.
    domain/                    # casos de uso administrativos transaccionales
    authz/                     # permisos resource.action, SoD
    schemas/                   # Zod: fuente única de contratos
    api-client/                # cliente tipado generado
    ui/                        # componentes compartidos web
    observability/             # OTel, logger estructurado
  supabase/     CLAUDE.md
    migrations/                # YYYYMMDDHHMM_verbo_objeto.sql — nunca se editan
    seed/
    functions/                 # Edge Functions (integraciones ligeras, nunca fiscal core)
    tests/                     # pgTAP
  infra/        CLAUDE.md
    docker/                    # Dockerfiles multi-stage
    traefik/                   # SOLO labels y red. Nunca config estática del proxy.
    compose/                   # docker-compose.ladino.yml (project name: ladino)
  scripts/
  docs/                        # toda la documentación funcional y de cumplimiento
  .github/workflows/
```

## Fronteras — verificadas en CI, no confiadas a la buena voluntad

| Paquete | Puede importar | Nunca importa |
|---|---|---|
| `money` | nada del repo | todo lo demás |
| `accounting` | `money`, `schemas` | I/O, red, base de datos |
| `fiscal` | `money`, `accounting`, `schemas` | UI, apps |
| `inventory` | `money`, `schemas` | I/O directo |
| `domain` | todos los packages puros | apps |
| `api` | packages | otras apps |
| `worker` | packages | otras apps |
| `web` / `mobile` | `schemas`, `api-client`, `ui`, `money` (solo formateo) | `fiscal`, `accounting`, `domain` |

Una regla de `eslint-plugin-boundaries` (o `dependency-cruiser`) hace fallar el build si se
viola esta tabla. La disciplina de fronteras no puede depender de que alguien recuerde.

## Nota sobre `apps/mobile`

Si el hoisting de pnpm entra en conflicto con Metro, `apps/mobile` se excluye del workspace y
consume los paquetes compartidos por versión o `file:`. Es una salida conocida y aceptada;
no se fuerza el workspace a costa de romper el bundler.

**Advertencia operativa:** nunca sincronizar `node_modules` de pnpm con herramientas que sigan
enlaces simbólicos o junctions (por ejemplo `robocopy /MIR`). Destruye los directorios origen.

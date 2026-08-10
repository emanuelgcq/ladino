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
    core/          CLAUDE.md   # Result, DomainError, Brand, Instant. Cero dependencias.
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
    migrations/                # YYYYMMDDHHMMSS_verbo_objeto.sql — nunca se editan
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
| `core` | **nada del repo, ninguna dependencia externa** | todo lo demás |
| `money` | `core` | todo lo demás |
| `schemas` | `core` | todo lo demás |
| `accounting` | `core`, `money`, `schemas` | I/O, red, base de datos |
| `fiscal` | `core`, `money`, `accounting`, `schemas` | UI, apps |
| `inventory` | `core`, `money`, `schemas` | I/O directo |
| `authz` | `core`, `schemas` | `money`, `fiscal`, apps |
| `api-client` | `core`, `schemas` | `fiscal`, `accounting`, `domain` |
| `observability` | `core` | todo paquete de dominio |
| `ui` | `core`, `schemas`, `money/format` | `fiscal`, `accounting`, `domain`, `money` (raíz) |
| `domain` | todos los packages puros | apps |
| `api` | packages | otras apps |
| `worker` | packages | otras apps |
| `web` / `mobile` | `core`, `schemas`, `api-client`, `ui`, `money/format` | `fiscal`, `accounting`, `domain`, `money` (raíz) |

`core` es el kernel: `Result`, `DomainError`, `Brand`, `Instant`. Sin dependencias, ni siquiera
`decimal.js`. Existe para que `money` no acabe siendo el kernel por accidente — el día que
`fiscal` importara su tipo de error desde el paquete de dinero, la frontera ya estaría rota
sin que ningún gate lo notara (ADR-0021).

### "Solo formateo" es un subpath, no un comentario

Ningún verificador de imports puede distinguir "formateo" de "cálculo" dentro de un mismo
módulo. Por eso `packages/money` expone **dos entradas**:

| Entrada | Contenido | Quién puede importarla |
|---|---|---|
| `@ladino/money` | `Money`, aritmética, los cuatro redondeos, FX, `allocate` | `accounting`, `fiscal`, `inventory`, `domain`, `api`, `worker` |
| `@ladino/money/format` | `formatMoney`, `parseUserInput`. Cero aritmética, cero FX, cero redondeo fiscal | además: `web`, `mobile`, `ui` |

La regla de CI prohíbe a `web`, `mobile` y `ui` alcanzar la raíz `@ladino/money`. Así la
restricción deja de ser una anotación en una tabla y pasa a ser mecánica.

### Herramienta del gate

**`dependency-cruiser`** (`pnpm boundaries`, paso 2 de `pnpm verify`), decidido en ADR-0021.
Trabaja sobre el grafo resuelto, así que evalúa **alcanzabilidad transitiva**: detecta que
`web → domain → fiscal` viola la tabla aunque ninguna arista suelta lo haga. ESLint queda como
feedback en el editor (`no-restricted-imports` sobre las dos aristas más frecuentes), nunca
como el gate. La disciplina de fronteras no puede depender de que alguien recuerde.

## Nota sobre `apps/mobile`

`apps/mobile` **está dentro del workspace de pnpm** (ADR-0022), con el `node-linker` aislado
por defecto. Excluirlo desactivaría la garantía central de ADR-0001 —que un cambio de contrato
rompa el typecheck de todos los consumidores en el mismo PR— precisamente en el cliente que la
regla 10 de `CLAUDE.md` identifica como vector de riesgo.

La salida sigue existiendo y su criterio de disparo está escrito en ADR-0022. Lo que la
mantiene barata es que los paquetes compartidos se consumen **compilados** (`dist/` + campo
`exports`), nunca por `tsconfig.paths`: Metro no lee `tsconfig.paths`, así que ejectar se
reduce a un lockfile propio y cambiar `workspace:*` por `file:../../packages/x`.

`node-linker=hoisted` está **descartado** como medida preventiva: es global al workspace y
anularía la detección de dependencias no declaradas de pnpm en todos los paquetes, para cubrir
un fallo que hoy no tenemos.

**Advertencia operativa:** nunca sincronizar `node_modules` de pnpm con herramientas que sigan
enlaces simbólicos o junctions (por ejemplo `robocopy /MIR`). Destruye los directorios origen.

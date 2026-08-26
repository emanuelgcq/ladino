# Ladino — instrucciones de trabajo

Ladino es una plataforma administrativa, contable y fiscal **cloud-first** para Venezuela.
Webapp + app Expo + servicios en contenedores. **No existe cliente desktop.**

Idioma: **código, identificadores y commits en inglés; comentarios, docs y UI en español.**

---

## 1. Las 10 reglas que no se negocian

1. Una factura fiscal emitida **no se edita ni se borra**. Se corrige con nota de crédito/débito.
2. Un asiento `posted` **no se actualiza**. Se revierte y se genera uno nuevo.
3. Todo documento fiscal y movimiento contable guarda autor, timestamp, origen y **versión de reglas**.
4. Toda operación crítica es **idempotente** (`Idempotency-Key` obligatorio).
5. Todo registro pertenece explícitamente a un `tenant_id`. Sin excepción.
6. La contabilidad siempre cumple `sum(debit) = sum(credit)` por asiento.
7. **Nunca `float`/`number` para dinero.** Postgres `numeric(24,8)`, TypeScript `Decimal`, JSON `string`.
8. Tasas tributarias y cambiarias son **efectivas por fecha y fuente**. Nunca hard-coded.
9. Cambios de comportamiento fiscal pasan por el gate de homologación antes de producción.
10. La app móvil **no** es una vía para saltarse los controles del backend.

## 2. Prohibiciones duras (hay hooks que las bloquean)

- `service_role` key en `apps/web`, `apps/mobile` o cualquier bundle de cliente.
- Editar una migración ya aplicada en `supabase/migrations/`.
- `UPDATE`/`DELETE` sobre `journal_lines`, `fiscal_events`, `inventory_moves`, `audit_events`.
- Lógica tributaria dentro de componentes React o pantallas Expo.
- Inventar una tasa, alícuota, formato de archivo SENIAT u obligación legal. Si no está en
  `docs/02_COMPLIANCE/` con fuente citada, **se marca `VALIDAR-SENIAT` y se para**.
- Tocar, reiniciar o reconfigurar el contenedor **n8n** del VPS. Es infraestructura ajena a Ladino.
- `docker compose down` global, `docker system prune`, `docker network rm` en el VPS.
- `git push --force`, o deploy sin aprobación explícita del usuario en el mensaje.
- `git commit` **estructural** sin aprobación explícita: ADR nuevo, migración, cambio de
  contrato de la API. El trabajo rutinario dentro de un plan ya aprobado se commitea directo
  (ver §3, «Flujo de commits»).

**Ausencia de mecanismo no es prohibición.** Si algo no debe poder hacerse, tiene que fallar
activamente, no depender de que el método no exista.

## 3. Cómo trabajar en este repo

**Siempre en este orden. No saltes pasos.**

1. **Investigar primero.** Lee las specs relevantes antes de escribir código.
   Usa el subagente `spec-explorer` para no llenar el contexto principal.
2. **Plan mode.** Presenta plan: archivos, migraciones, tests, riesgos, `HOMOLOGATION_IMPACT`.
3. **Esperar aprobación explícita.** No implementes hasta que el usuario diga que sí.
4. **Test primero** en todo lo que toque dinero, stock o documentos fiscales.
5. **Implementar** en incrementos verificables.
6. **Verificar**: `pnpm verify` debe pasar en verde.
7. **Reportar** con el formato de entrega (sección 6).

### Flujo de commits: directo a main, sin PRs (desde S0.6a)

El único revisor es el usuario y el gate real es `pnpm verify` con sus 11 pasos, no una página
de GitHub. Reglas:

- **`pnpm verify` en verde ANTES de cada commit, sin excepción.**
- Un commit por unidad de trabajo coherente, mensajes cuidados (en inglés, como siempre).
- **Push después de cada commit.** No se acumulan commits locales.
- Lo que queda a medias o con un bloqueante **se dice** en el mensaje del commit y en
  `HANDOFF.md` — no se esconde.
- Lo que antes iba al cuerpo de un PR (tabla de auditoría, hallazgos, decisiones abiertas)
  ahora vive en `HANDOFF.md`.
- La aprobación explícita sigue siendo obligatoria para lo **estructural**: ADR nuevo,
  migración, cambio de contrato. Lo rutinario dentro de un plan aprobado no la necesita (§2).

### Calibración del rigor

Los siete pasos son el orden, no la intensidad. **El criterio para calibrar es reversibilidad y
coste del error, no importancia percibida.** Un catálogo de productos se siente importante; un
error en él se arregla con un `UPDATE`. Un asiento mal cuadrado, no.

| Rigor | Dónde | Qué implica |
|---|---|---|
| **Máximo** | dinero · contabilidad · fiscal · aislamiento multi-tenant · auditoría | ADR **antes** del código, pgTAP/property tests exhaustivos, `rls-security-auditor` **y** `fiscal-reviewer` al cerrar |
| **Normal** | maestros · catálogos · CRM · reportes · notificaciones · UI | una pasada de revisión; ADR **solo si la decisión es irreversible** |

Y sobre datos: **auditoría completa sobre tablas con datos, ligera sobre tablas vacías.** Una
migración sobre una tabla vacía se revierte escribiendo otra; sobre una tabla con dos años de
movimientos, no se revierte.

Aplicar rigor máximo a todo no es prudencia: diluye la señal. Si toda revisión es exhaustiva,
ninguna lo es de verdad, y la que importaba se aprueba con la misma atención que la que no.

### Una migración que arregla otra necesita su propia auditoría completa

Pasó en S0.3 y volvió a pasar en S0.4, las dos veces igual: la migración escrita
para cerrar unos hallazgos **introdujo otros nuevos**, y la revisión siguiente los
encontró porque miró de nuevo el conjunto, no solo el arreglo.

**El foco puesto en el defecto conocido es exactamente lo que deja pasar el nuevo.**
Un arreglo se escribe mirando el fallo que se quiere cerrar, y esa atención estrecha
es la que no ve que el `CHECK` nuevo rechaza un caso legítimo, que la columna que
sustituye a otra perdió la defensa que aquella tenía, o que la función extraída para
no duplicar lógica replanifica por fila.

Una corrección no es media tarea: **es una migración, con el mismo rigor, los mismos
tests y la misma pasada de auditoría que la que corrige.**

### Si un mismo control detecta los fallos una y otra vez, sospecha

**No es que ese control sea bueno: es que está haciendo el trabajo de reglas que no se
comprueban.** Pasó dos veces con `no-unresolvable` dentro del gate de fronteras: en S0.1 fue
lo único que delató que `dependency-cruiser` no resolvía nada, y en S0.5 fue lo que hizo
parecer cubierta una violación que la regla concreta no veía. Un control que salva la
situación repetidamente es la señal de que las reglas que debería respaldar están inertes o
tapadas — y la respuesta correcta no es celebrarlo, es auditar el resto
(`pnpm boundaries:selftest` existe por esto).

### Asevera el mensaje, no solo el código: dos caminos pueden producir el mismo `code`

En S0.5, el `catch` de `23505` del caso de uso estaba **muerto** —postgres.js rechaza `begin()`
con el error original aunque el callback lo capture— y el test E2E llevaba en verde desde que
existía: el error crudo caía en la tabla de SQLSTATE de `onError` y producía **el mismo
`DUPLICATE/409`** que el catch habría producido. El test probaba el mapeo genérico creyendo
probar el caso de uso. Lo destapó comparar el **mensaje**, que era lo único distinto.

Regla: cuando dos caminos distintos pueden converger en la misma respuesta, el test tiene que
asertar lo que **solo** produce el camino que dice probar. Y su pariente: un error de Postgres
**condena la transacción**; capturarlo sin `savepoint` es código que parece funcionar. Con
Hono pasó lo equivalente (`next()` no propaga excepciones). Dos frameworks, dos semánticas de
error contraintuitivas, y **ninguna la vio un test unitario: las vio el E2E real.**

### Qué leer según la tarea

| Si tocas… | Lee obligatoriamente |
|---|---|
| Cualquier cosa | Este archivo + `docs/00_GOVERNANCE/CONTEXT_MAP.md` |
| Dinero / montos | `docs/04_PLATFORM/MONEY_AND_ROUNDING_SPEC.md`, `docs/06_QA/ACCOUNTING_INVARIANTS_TESTS.md` |
| Asientos / cierres | `docs/03_MODULES/ACCOUNTING_ENGINE_SPEC.md`, `docs/03_MODULES/JOURNAL_AND_CLOSING_SPEC.md` |
| Facturación / impuestos | `docs/02_COMPLIANCE/` completo + `docs/02_COMPLIANCE/SENIAT_COMPLIANCE_AND_HOMOLOGATION.md` |
| Migraciones / RLS | `docs/04_PLATFORM/SUPABASE_DESIGN.md`, `docs/04_PLATFORM/MULTITENANCY_AND_RBAC.md` |
| Inventario | `docs/00_GOVERNANCE/adr/ADR-0034-*` (la fuente real), `docs/03_MODULES/INVENTORY_SPEC.md`, `docs/03_MODULES/WAREHOUSE_OPERATIONS_SPEC.md` |
| Mobile | `docs/04_PLATFORM/MOBILE_EXPO_SPEC.md`, `docs/08_UX/MOBILE_UX_RULES.md` |
| Deploy | `docs/05_INFRA/DOCKER_AND_HOSTINGER_DEPLOYMENT.md` |
| Decisiones estructurales | `docs/00_GOVERNANCE/adr/` — y **crea un ADR nuevo** |

## 4. Stack (ver `docs/00_GOVERNANCE/adr/` para el porqué)

| Capa | Elección |
|---|---|
| Monorepo | pnpm workspaces + Turborepo, TypeScript `strict` |
| Web | Vite + React + React Router (data mode) + TanStack Query |
| Mobile | Expo (SDK actual) + React Native, New Architecture ON |
| API | Hono sobre Node 22, contrato OpenAPI generado desde Zod |
| Datos | Supabase gestionado (Postgres, Auth, Storage, Realtime) |
| Servicios | Docker en VPS Hostinger detrás del **Traefik ya existente** |
| Dinero | `decimal.js` en TS, `numeric(24,8)` en Postgres |
| Validación | Zod, esquemas compartidos en `packages/schemas` |
| Tests | Vitest, pgTAP (RLS), Playwright (E2E), Maestro (mobile) |
| Observabilidad | OpenTelemetry + Sentry + logs estructurados |

## 5. Comandos

```bash
pnpm install              # instalar (lockfile obligatorio, solo pnpm)
pnpm dev                  # entorno local completo
pnpm verify               # el gate real. 11 pasos, en este orden:
                          #   1. format:check   prettier --check
                          #   2. boundaries     dependency-cruiser (ADR-0021)
                          #   3. lint           eslint
                          #   4. typecheck      tsc -b --noEmit
                          #   5. test           vitest — incluye la INTEGRACIÓN de la API
                          #                     contra Postgres local (ADR-0016): necesita
                          #                     el stack levantado, igual que 10 y 11
                          #   6. build          tsc -b
                          #   7. api-surface    ningún `number` en la API pública de money
                          #   8. openapi:check  el openapi.json commiteado == el generado
                          #                     desde los Zod de packages/schemas (ADR-0004)
                          #   9. release:manifest:check  releases/manifest.json cubre las
                          #                     migraciones y ninguna cubierta cambió (ADR-0019)
                          #  10. db:reset       aplica TODAS las migraciones desde cero
                          #  11. test:rls       pgTAP: aislamiento y append-only

pnpm db:start             # levanta Postgres local en contenedores (necesita Docker)
pnpm db:stop              # lo baja
pnpm db:new <nombre>      # nueva migración (nunca editar una aplicada)
pnpm db:reset             # reset local + todas las migraciones + seed
pnpm test:rls             # pgTAP contra la base local
pnpm test:concurrency     # outbox bajo N sesiones reales (pgbench en el contenedor)
pnpm test:concurrency:selftest   # rompe el pickup a propósito: comprueba que la prueba detecta
pnpm openapi              # regenerar openapi.json desde los schemas
```

**Los pasos 5, 10 y 11 necesitan Docker y el stack local levantado** (`pnpm db:start`): desde
S0.5, el paso de test incluye la integración de la API contra Postgres real (ADR-0016).

**El resultado del `verify` se lee por `VERIFY EXIT` y por `Failed:`, nunca a ojo.** En esta
máquina se corre con `TURBO_CONCURRENCY=1` (memoria) y la salida se manda a un log; el veredicto
es `echo "VERIFY EXIT=$?"` al final más `grep -E "VERIFY EXIT|Failed:"` sobre ese log. Un
`Result: PASS` de turbo no es el veredicto: turbo cubre cuatro de los once pasos. La regla existe
porque el módulo de clientes salió con lint en rojo leyendo la cola del log (2026-08-26).

**Y un `VERIFY EXIT=0` tampoco basta por sí solo: hay que ver que el log tiene los pasos.**
Invocado como `pnpm verify` dentro de una cadena, Windows puede resolverlo al builtin `verify`
de cmd, que imprime `VERIFY is off.` y devuelve 0 — un log de dos líneas y un verde que no
verificó nada (visto el 2026-08-26 en el módulo de inventario). Se usa **`pnpm run verify`** y se
cuenta: `grep -cE "^@ladino/[a-z-]+:(lint|typecheck|test|build)"` sobre el log tiene que dar
decenas de líneas, y `All tests successful` tiene que aparecer (el pgTAP). Un gate que puede
apagarse solo y dar verde es peor que no tenerlo.

**`test:concurrency` NO está dentro de `verify`, y es deliberado.** Es una prueba de *muestreo*:
abre N sesiones, compite durante T segundos y comprueba que nadie se lleva la misma fila dos
veces. Un verde dice «no encontré doble entrega», nunca «no puede haberla». Poner un gate
muestral en cada `verify` enseña a reejecutarlo hasta que pase, y ahí deja de ser un gate.
Corre cuando toques el outbox o su consumo, y en CI sobre esa ruta.

`verify` reproduce el **núcleo** del pipeline de `DEVOPS_CI_CD.md`, no el pipeline entero.
Desde S0.5, `openapi:check` es el paso 8 y la integración vive dentro del paso de test; desde
S0.6a, `release:manifest:check` es el paso 9 (`releases/manifest.json`, ADR-0027 §5). Todos
existen y bloquean. Lo que sigue fuera del gate es `test:concurrency`, por muestral.

## 6. Formato de entrega (todas las tareas)

```
RESUMEN        — qué se hizo, en 3 líneas
ARCHIVOS       — creados / modificados / eliminados
MIGRACIONES    — nombre + reversibilidad
TESTS          — qué se agregó y qué cubre
RIESGOS        — qué puede romperse
HOMOLOGATION_IMPACT = YES | NO
VALIDAR-*      — puntos que requieren confirmación humana antes de producción
```

## 7. Fronteras del código

- `packages/core` — `Result`, `DomainError`, `Brand`, `Instant`. **Cero dependencias.** Todos pueden importarlo.
- `packages/accounting` — invariantes de partida doble. Puro. Sin I/O.
- `packages/fiscal` — documentos, numeración, eventos, adapters de imprenta. **Release train propio.**
- `packages/money` — Decimal, redondeo, FX. Puro. Solo importa `core`.
- `packages/domain` — casos de uso administrativos transaccionales.
- `apps/api` — orquestación, permisos, idempotencia. No contiene reglas de negocio.
- `apps/worker` — outbox, jobs, reintentos.
- `apps/web` / `apps/mobile` — **cero reglas tributarias**. Solo presentación y llamadas a la API.
  De dinero solo pueden importar `@ladino/money/format`, nunca la raíz `@ladino/money`.

La tabla completa y su gate (`dependency-cruiser`) están en
`docs/00_GOVERNANCE/MONOREPO_STRUCTURE.md` y ADR-0021.

Ninguna UI persiste "estado final" de dinero, stock o documentos fiscales. Siempre invoca un caso
de uso de dominio transaccional que valide permisos → bloquee → calcule → persista → audite →
emita evento outbox → confirme commit.

## 8. Subagentes disponibles

`spec-explorer` · `migration-author` · `accounting-invariants` · `fiscal-reviewer` ·
`rls-security-auditor` · `mobile-expo`

Delega a ellos las tareas de lectura amplia y revisión. El contexto principal es para decidir.

## 9. Estado del proyecto

Fase actual: **Sprint 0 — bootstrap.** Nada está construido todavía.
Antes de escribir la primera línea de código de negocio, revisa
`docs/00_GOVERNANCE/SPRINT_0_BOOTSTRAP.md` y `docs/00_GOVERNANCE/OPEN_QUESTIONS.md`.

Los bloqueantes SENIAT de `OPEN_QUESTIONS.md` **no impiden** construir Fases 1–3.
Sí impiden liberar emisión fiscal productiva.

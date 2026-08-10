# Handoff — 2026-08-09

## Estado

**S0.1, S0.2 y S0.3 cerrados y en verde.** El siguiente es **S0.4 — audit log y outbox**.

S0.1 ✅ · S0.2 ✅ · S0.3 ✅ · S0.4 ⬜ · S0.5 ⬜ · S0.6 ⬜

`pnpm verify` corre **9 pasos** y el 8 y el 9 necesitan Docker: desde S0.3 el gate incluye la
base de datos.

## Hecho en esta sesión

**S0.3 — identidad y aislamiento.** Seis migraciones, seis suites pgTAP, **170 aserciones**.

Se partió en seis porque el primer intento era una migración de 1.520 líneas que fallaba entera
ante cualquier error. Seis que se aplican y prueban por separado convirtieron el ciclo de minutos
en segundos, y cuando 3/6 falló, 1/6 y 2/6 siguieron verdes sin tocarlas.

| | |
|---|---|
| 1/6 | esquema `platform`, `uuidv7()`, `reject_mutation()` |
| 2/6 | jerarquía: `tenants`, `companies`, `branches`, `warehouses`, `cash_registers` |
| 3/6 | RBAC: seis tablas, cuatro `platform.ladino_*`, tres constraint triggers, 23 permisos |
| 4/6 | 43 policies, ninguna `FOR ALL`, RLS enable+force en las once |
| 5/6 | anclas inmutables, TRUNCATE cerrado, procedencia no forjable |
| 6/6 | cierre de la segunda auditoría |

**Tres pasadas del `rls-security-auditor`.** La primera encontró un CRÍTICO; la segunda, tres
ALTO **que eran defectos de la migración que arreglaba el primero**; la tercera salió limpia.

- **CRÍTICO** — un usuario con membership en dos tenants trasladaba filas de uno a otro con un
  `UPDATE`. Una policy tiene `USING` (fila vieja) y `WITH CHECK` (fila nueva), y **Postgres no
  ofrece `OLD` dentro de una policy**: ninguna puede exigir que una columna no cambie. Cerrado
  con `GRANT` por columna + trigger.
- **ALTO** — el trigger de ancla se saltó `roles` y `role_permissions`; un `alter default
  privileges` que revocaba de `anon` en vez de `PUBLIC` y por tanto no revocaba nada; y
  `created_by := auth.uid()` que dejaba sin autor el 100 % de las altas por `service_role`.

## En vuelo

**Nada de S0.3.** Migraciones aplicadas de cero, 170 aserciones verdes, `pnpm verify` en verde.

## Decisiones tomadas

ADR-0021 (fronteras) · ADR-0022 (mobile en workspace) · ADR-0023 (`Money`/`ExactMoney`) ·
ADR-0024 (`MonetaryFact` a ocho campos) · **ADR-0025 (modelo RBAC y aislamiento)**.

## Bloqueantes para S0.4

**Los tres son de esquema. Cuestan poco ahora y mucho después.**

1. **Toda tabla nace con `platform.set_row_provenance()`.** `created_by`, `created_at` y
   `version` gobernados por trigger. Sin él, el cliente atribuye la fila a otro usuario y la
   antedata — la auditoría lo hizo, con fecha 1999. En `audit_events` eso es falsificación de la
   pista de auditoría (regla 3 de `CLAUDE.md`).
2. **`reject_mutation()` se engancha DOS veces:** `before update or delete for each row` **y**
   `before truncate for each statement`. `TRUNCATE` ignora la RLS y no dispara el primero.
3. **Toda tabla con `tenant_id` lleva `assert_isolation_anchors_immutable()`.** El test de 006 lo
   comprueba como propiedad sobre el catálogo, así que S0.4 lo hereda automáticamente: si falta,
   falla.

Y uno de producto: **M4 — el RIF es mutable.** `companies.tax_id` es texto libre que cualquiera
con `company.manage` reescribe, sin rastro, y es quien identifica al contribuyente en los
documentos emitidos. **Debería bloquear la parte fiscal de S0.4.** `VALIDAR-SENIAT` para el
formato.

## Qué clases de ataque seguimos sin probar

La fuga crítica apareció por no tener un usuario multi-tenant. Estas son las clases que **siguen
sin cubrir**, listadas antes de S0.4 y no después:

| Clase | Por qué importa | Cuándo |
|---|---|---|
| **Concurrencia** | Dos transacciones simultáneas sobre el mismo alcance. Todo el pgTAP corre en una conexión. `uuidv7` multi-sesión ya está marcado `VALIDAR-QA`; el resto ni eso | S0.4 (outbox tiene carreras por diseño) |
| **Escalada por composición** | Cada permiso se prueba aislado. Nadie prueba *combinaciones*: dos permisos inocuos que juntos rinden uno que no se concedió. Es el terreno de la SoD | con la migración de pagos |
| **Agotamiento y DoS** | Un tenant que inserta 10⁷ filas degrada las policies de los demás. No hay cuota, ni test de vecino ruidoso | antes de producción |
| **Canal lateral por errores y tiempos** | Un mensaje o una latencia distinta revela si un id existe en otro tenant. Hoy los errores llevan ids y nombres de tabla | S0.5, con el formato de error |
| **Ciclo de vida** | Nadie prueba qué pasa al suspender una company, borrar un usuario de `auth.users` o revocar un membership **con sesión abierta**. La revocación inmediata es la promesa central de ADR-0014 y no está probada | S0.4 |
| **Orden de migración** | Las seis se prueban aplicadas todas. Nadie prueba el estado intermedio en un despliegue real, donde app vieja y esquema nuevo conviven (ADR-0019) | S0.5 |
| **`service_role` comprometido** | Es el modelo de amenaza de la capa 2, y solo se prueba contra los triggers. Qué puede leer o exfiltrar no se ha mirado | S0.4, con `audit_events` |
| **Datos, no mecanismo** | Las pruebas usan dos tenants limpios. Nadie prueba con datos heredados incoherentes — que es como llegan las migraciones reales | cuando haya seed realista |

## Decisiones pendientes

- **M1** — el `SELECT` del RBAC es tenant-wide: cualquier miembro ve el organigrama completo y el
  mapa de privilegios. No es fuga entre tenants. Resolver antes de exponer la UI de administración.
- **M3 — SoD.** No existe nada: ni `payment.create`/`payment.approve`, ni cajero/supervisor. Las
  tres reglas de `MULTITENANCY_AND_RBAC.md` §Segregación no son verificables. **Entra como
  requisito de esquema en la migración que cree pagos y cierres**, no después: comparar identidades
  de actores sobre un documento es una restricción de tabla, y añadirla sobre datos existentes es
  mucho más cara.
- **Contrato de cliente para S0.5** — el `upsert` por defecto de `supabase-js` reenvía la fila
  completa, incluidas `tenant_id` y `company_id`, y chocará con los `GRANT` por columna aunque no
  cambien de valor. Hay que documentarlo o el primer que lo use pensará que hay un bug.
- **R-01/R-02/R-03** de `RISK_REGISTER.md` (pesos negativos en `allocate`, `ResidualAllocation`,
  `decimal.js` más allá de 50 dígitos) siguen abiertos.

## Siguiente paso concreto

**Migración `create_audit_and_outbox`: `audit_events` append-only, `outbox` con estado, intentos
y `available_at`, e `idempotency_keys` con único por `(company_id, key)`.**

Las tres nacen con: `platform.uuidv7()` en la PK, `set_row_provenance()`, RLS enable+force,
policies por operación, `assert_isolation_anchors_immutable()`, y en `audit_events` los **dos**
enganches de `reject_mutation()`.

Lectura antes de escribir SQL (usa `spec-explorer`):

- `docs/04_PLATFORM/AUDIT_TRAIL_AND_IMMUTABILITY.md`
- `docs/04_PLATFORM/EVENT_CATALOG.md` — qué eventos existen y su forma
- `docs/00_GOVERNANCE/adr/ADR-0005-transactional-outbox.md` y `ADR-0006-ledger-append-only.md`
- `docs/00_GOVERNANCE/adr/ADR-0018-idempotencia.md`
- `docs/00_GOVERNANCE/adr/ADR-0025-modelo-rbac-y-aislamiento.md` §6 y §9 — las dos capas
- La skill `migracion-supabase`, que ahora lleva las cuatro lecciones de S0.3

Test pgTAP mínimo: un `update` sobre `audit_events` como `service_role` lanza `LAD06`; un
`TRUNCATE` también; y el aislamiento A/B con **usuario multi-tenant**, que ya es obligatorio.

## Estado del PR #1 — mi recomendación: mergear ya

**https://github.com/emanuelgcq/ladino/pull/1** — abierto, sin mergear, y ahora lleva S0.3 encima.
Su descripción cubre S0.1+S0.2 y se ha quedado corta.

**Mergearlo ya**, por tres razones:

1. **Ya no es un PR, son tres sprints.** Nadie lo va a revisar entero; un PR que no se puede
   revisar es un PR que se aprueba sin leer.
2. **`main` tiene documentación que el código contradice.** ADR-0023, 0024 y 0025 viven solo en la
   rama, y ADR-0014 sigue diciendo `auth.ladino_*` en `main`. Cuanto más dure, más divergen.
3. **S0.4 tiene una dependencia dura de S0.3**: `set_row_provenance`, `reject_mutation` y el
   trigger de anclas. Construir sobre una rama sin mergear multiplica el coste de un conflicto.

Actualiza la descripción del PR con S0.3 antes de mergear, y **abre S0.4 en rama propia desde
`main`**. La disciplina de una rama por sprint se recupera ahí.

Si prefieres esperar: la única razón buena sería querer revisar S0.3 y S0.4 juntos porque la
inmutabilidad se entiende mejor con las append-only reales delante. Es defendible, pero paga
con un PR que crece.

## Estado del repo

- **Rama:** `s0/skeleton-and-money` · **último commit:** `466443e`
- **`main`:** `411e252` — solo S0.1/S0.2 docs y ADR-0021/0022
- **Migraciones:** 6, aplicadas de cero sin error
- **`pnpm verify`:** ✅ 9 pasos · **pgTAP:** 170 · **Vitest:** 165 en `money`, 8 en `core`
- **CI:** verde en los 8 jobs (sin la parte de base de datos: falta añadirla al workflow)

### Trampas del entorno

- `supabase start` completo falla: `analytics`, `storage` y `studio` quedan *unhealthy*.
  `db:start` ya excluye `studio,storage,imgproxy,logflare,vector`.
- Docker Desktop se cae solo; `docker desktop start` lo levanta sin perder los contenedores.
- **`alter default privileges ... revoke execute on functions from public` NO funciona.** Postgres
  ignora el default para funciones: nacen con `EXECUTE` para `PUBLIC`. Con tablas y secuencias sí
  funciona. La defensa es la regla (RPC en `platform`) más el detector de 006.
- **`create or replace function` es un reemplazo completo**: resetea `proconfig`. Repite siempre
  `security definer`, `set search_path` y la volatilidad.
- Los heredoc de Git Bash en Windows se comen un nivel de escape. Para backticks y `\u`, usa la
  herramienta de edición.
- `dependency-cruiser` necesita `exportsFields: ["exports"]` explícito o no resuelve nada y el
  gate da verde con las reglas inertes.
- Node local 26, CI 22. Si algo diverge, gana CI.

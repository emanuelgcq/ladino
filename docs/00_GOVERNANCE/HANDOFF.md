# Handoff — 2026-08-18

## Estado

**S0.1 a S0.4 cerrados. S0.5 construido y en verde, con UNA cosa pendiente** (abajo).

S0.1 ✅ · S0.2 ✅ · S0.3 ✅ · S0.4 ✅ · S0.5 🟡 · S0.6 ⏸️ (reevaluado abajo — ya no del todo)

`pnpm verify` corre **10 pasos** — S0.5 añadió `openapi:check` (paso 8) y metió la integración de
la API dentro del paso de test. **Los pasos 5, 9 y 10 necesitan el stack local** (`pnpm db:start`).
368 aserciones pgTAP + 31 tests de vitest (API + db), todo verde.

## ⚠ LO PENDIENTE: la pasada del `rls-security-auditor` sobre S0.5

**No corrió.** Cuatro intentos consecutivos murieron con `529 Overloaded` del servicio — fallo del
lado del proveedor, no del encargo. **Es la PRIMERA tarea de la próxima sesión**, con el prompt que
está en este mismo repositorio como referencia: ámbito = el código nuevo de S0.5 (no re-auditar
las 13 migraciones), con atención al JOIN de autorización, el protocolo T1/T2, auth.ts y fugas de
información.

Lo que SÍ se verificó inline mientras tanto, para que el auditor no parta de cero:

- **El JOIN de autorización se comparó filtro a filtro contra `ladino_user_has_permission`** del
  catálogo vivo, y la divergencia encontrada (`not r.requires_scope` ausente) está corregida CON
  caso E2E: un rol acotado con `company.manage` tenant-wide ya no autoriza. Se comprobó contra la
  base que esa asignación entra sin error, así que era alcanzable.
- **El borde del protocolo T1/T2 está razonado y escrito** en `idempotency.ts`: si el caso de uso
  commiteó y T2 murió, dentro del TTL no hay doble efecto (409 IN_PROGRESS); pasado el TTL, la
  reejecución muere en la clave natural única (RIF → DUPLICATE) — **y por eso toda operación
  crítica necesita clave natural única además de idempotencia**. Sin ella, tras el TTL hay doble
  efecto.
- **Confusión de algoritmo**: `algorithms: ["HS256"]` fijado en `jwtVerify` + secreto como
  `Uint8Array` (jose no acepta RS256 contra clave simétrica). Test de `alg: none` incluido.

## Hecho en esta sesión (S0.5, bloques 0–3)

### La infraestructura de la API

| Pieza | Dónde | Lo no obvio |
|---|---|---|
| **`@ladino/db`** — único punto de entrada a Postgres | `packages/db` | `withTransaction` fija `ladino.actor_id` como PRIMERA sentencia. `set_config(…,true)` y no `SET LOCAL` porque `SET LOCAL` **no admite bind**. El `import` de `postgres` vive en UN fichero y la regla 13 del gate lo impone |
| **JWT** | `apps/api/src/middleware/auth.ts` | La API verifica la firma ELLA MISMA (escribe con `service_role`: la RLS no la protege). Seis validaciones explícitas; token de otro proyecto muere en firma Y en emisor, probados por separado |
| **Idempotencia T1/T2** | `middleware/idempotency.ts` | Lookup FILTRADO POR ACTOR. Cuatro decisiones pendientes tomadas: hash de bytes crudos, replay = status+cuerpo originales, in_progress → 409+Retry-After, TTL 24 h |
| **Errores** | `middleware/errors.ts` | **En Hono, `next()` NO propaga excepciones** — el mapeo vive en `app.onError`. La primera versión era un middleware con try/catch y nunca vio un error: lo destapó el E2E |
| **Plantilla** | `packages/domain/src/create-company.ts` | Los diez pasos numerados, no-ops declarados en su sitio. Autorización tenant-wide con el JOIN espejo de la función canónica |
| **OpenAPI** | `pnpm openapi` / `openapi:check` | Generado desde los Zod de `packages/schemas`; el check es paso 8 de verify, probado en las dos direcciones |
| **Gate de fronteras VIVO** | `pnpm boundaries:selftest` | Las 22 reglas demuestran que disparan. Encontró DOS muertas (una desde su creación) y la distinción **inerte/tapada** quedó en la skill |

### Los hallazgos que valen más que el código

1. **`pure-packages-no-io-libs` llevaba inerte desde que se escribió** — `node_modules` en
   `exclude` borraba las aristas npm del grafo. El arreglo dejó el mismo fallo un nivel más abajo
   (el `dist/` interno de las dependencias). Casos 9 y 10 de ADR-0023.
2. **Hono entrega errores a `onError`, no a los try/catch de middlewares.** Sin el E2E con JWT
   real, todos los caminos de error habrían salido 500 en producción.
3. **El E2E cazó una fuga de la regla 404/403**: dos caminos de «no visible» con el mismo status y
   distinto `code` — el cuerpo revelaba lo que el status ocultaba. Unificados; la aserción compara
   cuerpos completos.
4. **F-9 disparó por tercera vez** (fixture del E2E): las companies con auditoría no se borran; se
   reutilizan con RIFs únicos por corrida.

### Decisiones nuevas escritas donde se leen

- Regla 404/403 con su porqué: `ERROR_CATALOG.md` (decisión, no convención).
- «Cuando hay que elegir un modo de fallo, se elige el ruidoso» — skill, regla general.
- La asimetría del centinela (`companies.created_by` exige usuario real; `idempotency_keys.actor_id`
  acepta centinela): `API_SPEC.md` + test que la fija.
- `X-Company-Id` **se rechaza activamente** hasta que exista su validación (ver siguiente sección).

## Primer paso del bloque 4 (maestros)

**No es un endpoint: es la función de visibilidad por company parametrizada por usuario.**

Los maestros (clientes, productos, impuestos) son de **alcance company**, y hoy `X-Company-Id` se
rechaza con `COMPANY_SCOPE_NOT_IMPLEMENTED` a propósito: validarlo exige una función tipo
`ladino_user_company_ids(p_user)` que no existe — las `ladino_*` resuelven sobre `auth.uid()` y la
API entra con `service_role`. Escribir el join a mano en el middleware sería la segunda copia de
la resolución RBAC (ADR-0027 §3-bis), y la primera copia parcial (el JOIN de create-company) ya
tuvo una escalada por un filtro omitido.

Orden concreto:

1. **Migración**: `platform.ladino_user_company_ids(uuid)` espejo de `ladino_company_ids()`, con
   gate de coste (la usará el middleware en CADA petición con company) y variante rota.
2. **Middleware de scope real**: valida `X-Company-Id` contra esa función, puebla
   `ctx.companyId/tenantId`, y retira el rechazo activo.
3. **Primer maestro** copiando la plantilla de `create-company.ts` — con su clave natural única,
   que el borde T1/T2 exige.
4. **Refactor pendiente**: cuando exista la función parametrizada de permisos por company usable
   aquí, el JOIN de `create-company.ts` debe evaluarse contra ella otra vez.

Rigor **normal** en los maestros (CLAUDE.md §3) — la plantilla ya pagó el rigor máximo.

## S0.6 — reevaluado: ya no tiene sentido diferirlo entero

Lo que se difirió en la derogación fue *el release train fiscal con manifest de homologación*.
Pero S0.6 contenía más cosas, y **tres razones han cambiado el cuadro**:

1. **Ahora hay una API real que desplegar.** `buildApp()` funciona con `app.request()`; falta el
   arranque del servidor, el contenedor y el Traefik. Sin eso, S0.5 solo existe en tests.
2. **Dos reapers sin dueño, los dos de DISPONIBILIDAD del camino crítico**: el del outbox
   (`in_flight` huérfano) y el de idempotencia (`in_progress` clavado bloquea el reintento hasta
   el TTL). Los dos necesitan el worker, y el worker es S0.6.
3. **El registro de versiones debe arrancar en la primera release** (ADR-0027 §5, entregable 2).
   Cada release sin manifest es historial que luego será inferencia.

**Recomendación: partir S0.6 en dos.**
- **S0.6a — ahora**: contenedor de la API + worker mínimo (consumo de outbox con `NullTransmitter`
  + los dos reapers) + proyecto Supabase remoto + manifest de versiones desde la release 1.
- **S0.6b — sigue diferido**: el gate de CI del release train fiscal. Sin régimen al que reportar,
  un gate que bloquea contra nada solo entrena a ignorarlo.

## Riesgos y límites que esta sesión añade o toca

- **Logging estructurado (ADR-0017) NO implementado** — el middleware de contexto genera
  `request_id` pero nadie emite el log JSON. Entra con S0.6a u observabilidad temprana.
- **Rate limiting**: decidida la clave (`user_id`), nada implementado.
- **La clave de idempotencia clavada hasta el TTL** sigue sin reaper (ADR-0018 enmendado lo exige).
- R-01..R-07 sin cambios. La tensión R-05/ADR-0029 quedó resuelta con el catálogo versionado.

## Estado en git

S0.5 commiteado en `s0.5/api-and-use-cases` y con PR abierto hacia `main`, **con la
auditoría pendiente anotada como bloqueante de merge en el propio PR**. No se mergea hasta que
corra (o hasta hacerla manual, como en S0.3, si el servicio sigue caído).

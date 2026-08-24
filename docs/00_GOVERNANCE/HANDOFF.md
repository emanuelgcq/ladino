# Handoff — 2026-08-18

## Estado

**S0.1 a S0.5 cerrados y en verde.** S0.5 auditado (ocho hallazgos, ocho corregidos) y con PR #3 abierto a la espera de tu aprobación para el merge.

S0.1 ✅ · S0.2 ✅ · S0.3 ✅ · S0.4 ✅ · S0.5 ✅ (merge pendiente) · S0.6a ⬜ · S0.6b ⏸️

`pnpm verify` corre **10 pasos** — S0.5 añadió `openapi:check` (paso 8) y metió la integración de
la API dentro del paso de test. **Los pasos 5, 9 y 10 necesitan el stack local** (`pnpm db:start`).
368 aserciones pgTAP + 37 tests de vitest (API + db), todo verde. `pnpm boundaries:selftest`: 22/22.

## La auditoría de S0.5: corrió (al quinto intento) y encontró OCHO cosas — todas cerradas

Cuatro intentos murieron con `529 Overloaded`; el quinto entregó el informe más completo de la
sesión. **Ocho hallazgos, siete reproducidos, los ocho corregidos con test que los distingue.**

| # | Sev. | Qué era | Arreglo |
|---|---|---|---|
| H-1 | **crítico** (corrección) | **`try/catch` de SQLSTATE dentro de `withTransaction` era CÓDIGO MUERTO**: postgres.js rechaza `begin()` con el error original aunque el callback lo capture. El test pasaba porque la tabla de SQLSTATE de `onError` producía el MISMO `DUPLICATE/409` — «tapada» en tiempo de ejecución | **savepoint** en todo conflicto esperable dentro de una transacción (caso de uso y T1). Test compara el **mensaje**, que es lo único que distingue el catch vivo del muerto |
| H-2 | alto | T1 reservaba la clave con el tenant del cuerpo **sin autorizar**: escritura cross-tenant + oráculo de existencia (409 REUSED vs 404) | visibilidad ANTES de T1 con el helper **compartido** `tenantVisible()` — una sola copia del predicado |
| H-3 | alto | dos reintentos concurrentes de una clave `failed` se rehabilitaban los dos → **doble ejecución** | `select … for update` en el lookup + guarda de estado en el update. Test con el intercalado exacto de dos conexiones |
| H-4 | medio | pasado el TTL la clave quedaba **inutilizable para siempre** con un `DUPLICATE` que mentía sobre la causa | el 23505 de T1 distingue fila caducada (se **reclama** y se reejecuta) de fila vigente (409 IN_PROGRESS). Ahora el comentario de cabecera es verdad |
| H-5 | medio | `tenant_id` malformado → 500 | forma UUID antes de tocar la base; `22P02 → 422` como red |
| H-6 | bajo | `DELETE /v1/companies` sin handler reservaba clave | idempotencia montada **por método**, no por path |
| H-7 | bajo | `for update` sobre el tenant **antes** de autorizar: lock cross-tenant gratis | orden que enseña la plantilla: visibilidad → permiso → bloquear |
| H-8 | bajo | un fallo de T2 pisaba un 201 real con un 500 | T2 en su try/catch; el efecto ya está hecho, la clave la reclama H-4 |

Más `Bearer` case-insensitive (RFC 7235). Lo que el auditor revisó y salió limpio: el JOIN de
autorización filtro a filtro contra la función canónica, `auth.ts` sin bypass, `Buffer.compare`
sin necesidad de constant-time (no hay secreto que filtrar: el lookup ya filtra por actor), cero
`service_role` en clientes.

**La lección que va a `CLAUDE.md` con nombre propio: H-1 lo destapó mirar el `message`, no el
`code`.** Un test que asserta código y status prueba el mapeo genérico creyendo que prueba el caso
de uso. Y el fallo de fondo de postgres.js —un error condena la transacción, y capturarlo sin
savepoint es código que parece funcionar— es de la familia de Hono/`onError`: dos frameworks, dos
semánticas de error contraintuitivas, ambas destapadas por el E2E real y no por unitarios.

Lo que el auditor no miró: `openapi.ts` (¿alguna ruta fuera de `/v1/*`? — no la hay, comprobado),
rate limiting (no existe: el cuerpo se lee entero a memoria sin `bodyLimit`, anotado abajo).

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

**Recomendación (aprobada): partir S0.6 en dos.**
- **S0.6a — ahora**: contenedor de la API + worker mínimo (consumo de outbox con `NullTransmitter`
  + los dos reapers) + proyecto Supabase remoto + manifest de versiones desde la release 1.
- **S0.6b — sigue diferido**: el gate de CI del release train fiscal. Sin régimen al que reportar,
  un gate que bloquea contra nada solo entrena a ignorarlo.

### El proyecto remoto ya existe — estado y hallazgos

`igpfrwdgmicgyirwdbgs` (ref en `.env`, que está en `.gitignore`; plantilla en `.env.example`).
Las API keys (publishable/secret) están en el `.env` local. **La `sb_secret` se pegó en un chat:
rotarla al cerrar el sprint** (dashboard → API Keys → rotate; es un clic y no rompe nada si se
actualiza el `.env`).

**⚠ HALLAZGO QUE CAMBIA `auth.ts` EN S0.6a: el proyecto remoto firma los JWT con ES256
(asimétrico)** — comprobado contra su JWKS público (`/auth/v1/.well-known/jwks.json`). Nuestro
`auth.ts` fija `algorithms: ["HS256"]` con secreto compartido, que es lo que usa el stack LOCAL:
contra el remoto rechazaría **todos** los tokens legítimos. El trabajo: configuración por entorno —
HS256+secreto en local, `createRemoteJWKSet` (jose) + ES256 contra el remoto. Y es mejor noticia
que problema: con firma asimétrica la API solo necesita la clave pública, no hay secreto de
verificación que proteger, y la clase entera de confusión de algoritmo desaparece en producción.

**Las 13 migraciones YA ESTÁN APLICADAS al remoto** (2026-08-18, vía Management API, cada una
registrada en `supabase_migrations.schema_migrations` con la forma estándar del CLI, así que un
`supabase db push` futuro las reconoce y no re-aplica). Verificado contra el remoto por
propiedades, no por lista: 14 tablas, **cero** sin RLS forzada, **cero** sin policy, **cero** con
`tenant_id` sin trigger de ancla, 24 permisos, envoltorio de permisos en plpgsql, `NULLS NOT
DISTINCT` en idempotencia, `server_encoding = UTF8` (la premisa del `IMMUTABLE` del hash), y la
prueba negativa **ejercida**: `UPDATE` sobre `audit_events` como `service_role` muere en 42501.

**Higiene de credenciales pendiente al cerrar el sprint** — dos, no una: la `sb_secret` **y el
token personal `sbp_…`** se pegaron en el chat. Rotar ambos (API Keys → rotate; Account → Access
Tokens → revocar y crear otro) y actualizar `.env`. Además, para que el **MCP** de Supabase
funcione en la próxima sesión, `SUPABASE_ACCESS_TOKEN` y `SUPABASE_PROJECT_REF` tienen que estar
en el **entorno del proceso** (variables de usuario de Windows o al lanzar Claude Code): el
`.mcp.json` los expande de ahí, no lee `.env`.

## Riesgos y límites que esta sesión añade o toca

- **Logging estructurado (ADR-0017) NO implementado** — el middleware de contexto genera
  `request_id` pero nadie emite el log JSON. Entra con S0.6a u observabilidad temprana.
- **Rate limiting**: decidida la clave (`user_id`), nada implementado. Sí hay `bodyLimit` (1 MB) desde el cierre de la auditoría: sin él, cualquier autenticado forzaba reserva de memoria arbitraria con un cuerpo enorme.
- **La clave de idempotencia clavada hasta el TTL** sigue sin reaper (ADR-0018 enmendado lo exige).
- R-01..R-07 sin cambios. La tensión R-05/ADR-0029 quedó resuelta con el catálogo versionado.

## Estado en git

S0.5 commiteado en `s0.5/api-and-use-cases` (cuatro commits: docs, feat, chore, y las correcciones de la auditoría) y con PR #3 abierto hacia `main`. **La auditoría ya no bloquea**; el merge espera tu aprobación explícita, como siempre.


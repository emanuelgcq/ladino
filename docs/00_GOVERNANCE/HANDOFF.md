# Handoff — 2026-08-24

## Estado

**Sprint 0 cerrado (S0.1–S0.6a, PR #4 mergeado) y el PRIMER MÓDULO DE NEGOCIO construido de
extremo a extremo: productos y precios, hasta pantalla.** Flujo trunk-based desde S0.6a: todo
en `main`, `verify` en verde antes de cada commit.

S0.1 ✅ · S0.2 ✅ · S0.3 ✅ · S0.4 ✅ · S0.5 ✅ · S0.6a ✅ · F-15 ✅ · **Productos ✅ · Clientes ✅** · S0.6b ⏸️

Remoto: proyecto `udacvwnhwpsdzbouhqhl` con **17 migraciones** aplicadas y verificadas por huella
(2026-08-26). **La 18 (clientes) está solo en local**: entra al remoto con el mismo procedimiento
(o `supabase db push`, que la reconocerá como pendiente).

## Módulo de clientes — construido entero (2026-08-26)

| Capa | Qué hay | Dónde |
|---|---|---|
| Esquema | migración 18: `taxpayer_types` (5, VALIDAR-TRIBUTARIO) y `person_types` (4) globales; `customers` por company con RIF nullable solo para persona natural, único PARCIAL case-insensitive, dirección/email/teléfono inline, lista de precios preferida (FK compuesto), estados lead/active/blocked/inactive; **trigger M4** `audit_customer_tax_id()` (LAD36) con valor anterior; permisos `customer.manage` / `customer.tax_id.manage` / `customer.block` | `supabase/migrations/20260826120000_*` · ADR-0033 |
| pgTAP | 018 (30): único parcial en las dos direcciones (dos sin RIF conviven, dos iguales no; roto sin el índice), jurídica sin RIF rechazada, valor anterior asertado por el DATO (`tax_id_anterior`/`tax_id_nuevo`, `rules_version` respetada; roto sin el trigger), LAD36 con JWT sin permiso / vive con permiso, aislamiento | `supabase/tests/018_*` |
| Dominio | `createCustomer`, `updateCustomer`, `setCustomerTaxId` (permiso propio; el trigger escribe el hecho, el caso de uso NO lo duplica), `setCustomerBlocked` (cobranzas) | `packages/domain/src/customers.ts` + 7 tests |
| API | `GET/POST /v1/customers`, `GET/PATCH /v1/customers/:id`, `PUT /v1/customers/:id/tax-id`, `PUT /v1/customers/:id/blocked`, `GET /v1/{taxpayer-types,person-types}` — OpenAPI generado | `apps/api/src/routes/customers.ts` + 5 E2E |
| Web | listado con búsqueda por RIF/razón social y paginación, alta/edición, detalle con cambio de RIF (permiso propio, error del dominio visible) y bloqueo/desbloqueo | `apps/web/src/CustomersView.tsx` |

**Decisiones por el camino:** estado por defecto `active` al crear (`lead` se elige explícitamente);
`updateCustomer` no puede tocar el RIF, las clasificaciones fiscales ni `blocked`, y rechaza cambiar
el estado de un bloqueado (desbloquear es de cobranzas); `setCustomerBlocked` distingue «ya está
así» (422 con palabras) de «no existe» (404). **No construido, dicho:** cambio de clasificación
fiscal tras el alta (sin caso de uso ni permiso todavía), contactos/direcciones múltiples,
crédito, etiquetas, y el `party` cliente/proveedor → **R-12** con disparador (proveedores).

**Siguiente módulo (propuesta): inventario.** Con productos y clientes en pie, ventas de bienes
necesita existencias; los almacenes ya existen desde S0.3. Es donde se decide la frontera
lotes/seriales/BOM que productos difirió a propósito (cabecera de la migración 16) y donde
`inventory_moves` (append-only, ya en la lista de tablas intocables de CLAUDE.md §2) toca dinero
por primera vez vía costeo — rigor máximo en valoración. Leer `INVENTORY_SPEC` y
`WAREHOUSE_OPERATIONS_SPEC` primero, como siempre, y traer los huecos antes del SQL.

## Módulo de productos — construido entero (2026-08-25)

| Capa | Qué hay | Dónde |
|---|---|---|
| Esquema | migración 16 (`products`, `product_categories`, `units`, `currencies`, `product_tax_categories`) y **17** (`price_lists`, `price_list_items` con EXCLUDE por rango, autocierre, guardián LAD35, `close_price()`, `price_at(list, product, FECHA)`) | `supabase/migrations/20260825*` · ADR-0032 |
| pgTAP | 016 (30) y 017 (33): SKU hostil con roto, anti-confusión fiscal/comercial en tres direcciones, solape 23P01 con roto, LAD35 en dos capas, autocierre por el dato, `now()` como negativo, importe al límite 24,8 | `supabase/tests/016_*`, `017_*` |
| Dinero | viaje `numeric(24,8) → postgres.js (string) → Money → {amount, currency}` dígito a dígito | `packages/db/test/money-roundtrip.test.ts` |
| Dominio | `createProduct`, `updateProduct`, `setProductTaxCategory` (permiso segregado), `createPriceList`, `setPrice` — plantilla de 10 pasos company-scoped con `companyScope()` (copia única) | `packages/domain/src/{products,pricing,company-scope}.ts` + 13 tests |
| API | `GET/POST /v1/products`, `GET/PATCH /v1/products/:id`, `PUT /v1/products/:id/tax-category`, `GET/POST /v1/price-lists`, `GET/POST /v1/price-lists/:id/prices` (`?product_id&at=`), `GET /v1/{units,tax-categories,product-categories}` — todo con `X-Company-Id`, mutaciones con `Idempotency-Key`, OpenAPI generado | `apps/api/src/routes/{products,pricing}.ts` + 8 E2E con JWT real |
| Web | listado con búsqueda y paginación en servidor, alta/edición, detalle con precio vigente por lista, gestión de listas y carga de precios; importes solo formateados con `@ladino/money/format` | `apps/web/src/{ProductsView,PricingView,money}.tsx` |

**Decisiones tomadas por el camino (todas dentro del plan aprobado):**
- El detector de coste de 015 quedó **sin roto** con los números medidos (aprobado); el de 017 no
  tiene detector: el gate por fila con roto sigue siendo 013.
- `companyScope()` NO toma `FOR UPDATE` sobre la company (desviación de la plantilla, declarada en
  `products.ts`): serializaría todo el catálogo por un maestro reversible; el SKU lo decide el índice.
- `GET /v1/products` pagina con `count(*) over ()`; `per_page ≤ 100`; búsqueda `ilike` con comodines
  escapados.
- `PriceItemResponse` lleva la moneda de la **lista**: el ítem no la repite (una sola fuente).
- La web muestra los precios de lista con hasta 8 decimales **exactos** cuando `formatMoney` se
  niega (formatear no redondea): el dato, no un redondeo inventado en el cliente.
- **Regla de eslint tapada**: `no-restricted-imports` bloqueaba también `@ladino/money/format` —
  nunca se notó porque ningún cliente había importado money. Ahora es un regex probado en las dos
  direcciones (raíz y `/fx` bloqueados, `/format` permitido).

**Lo que NO se hizo, dicho:** no hay CRUD de categorías comerciales (la API solo las lista; el
producto las acepta) ni endpoint para `close_price()` (retiro sin sustituto: existe en la base con
su permiso, sin caso de uso todavía); el seed de clasificaciones tributarias sigue **VALIDAR-TRIBUTARIO**;
`main.ts` del worker sigue sin test (R-10).

**Siguiente módulo (propuesta): clientes (CRM mínimo)** — es el segundo maestro que ventas
necesita, tiene clave natural clara (RIF por company) y arrastra la primera decisión fiscal de
contraparte (tipo de contribuyente para retenciones, `TAX_ENGINE_SPEC` `taxpayer_type`) que hay
que leer en las specs ANTES de escribir SQL, igual que se hizo con productos.

`pnpm verify` corre **11 pasos** — S0.6a añadió `release:manifest:check` (paso 9). **Los pasos 5,
10 y 11 necesitan el stack local** (`pnpm db:start`). **506 pgTAP** (18 ficheros) + **124 tests
de vitest** (API 82 · worker 13 · dominio 20 · db 9) — **los E2E y los tests de dominio conectan
como `ladino_api`/`ladino_worker`**, no como postgres. `pnpm boundaries:selftest`: 22/22. Las dos
imágenes se construyen (247/233 MB). Riesgos R-08..R-11 en `RISK_REGISTER.md`, cada uno con
disparador. **En esta máquina: `TURBO_CONCURRENCY=1 pnpm verify`** (R-11).

**⚠ En esta máquina, `TURBO_CONCURRENCY=1 pnpm verify`.** Con la concurrencia por defecto se cae
por memoria (`VirtualAlloc failed`, exit `-1073740791`): hay ~2 GB libres con Docker y un stack
Supabase de OTRO proyecto (`padrino-academy`) levantado junto al de Ladino. No es un fallo de
código y no se paran contenedores ajenos.

## S0.6a — qué hay, en el orden que pediste

1. **`auth.ts` en dos modos** — `jwks` (ES256, clave pública del proyecto, el de producción) y
   `hs256` (solo el stack local). El modo es configuración, no detección. `config.ts` es puro y
   probado: `hs256` no arranca con `NODE_ENV=production` **ni** contra un emisor que no sea local —
   dos capas, cada una probada sola. Un JWKS caído ya no es un 401 masivo: es `503
   AUTH_BACKEND_UNAVAILABLE` con log.
2. **Contenedores** — `infra/docker/Dockerfile.{api,worker}` (multi-stage, base por digest, no
   root, `--ignore-scripts`, heap por debajo del límite) y `infra/compose/docker-compose.ladino.yml`
   con **límites de CPU/memoria** (api 1.0/512M, worker 0.5/256M), `cap_drop`, `read_only`,
   `no-new-privileges`, `pids_limit`, `stop_grace_period`. **Worker** con consumo del outbox en dos
   fases + testigo de reserva, **los dos reapers** (outbox e idempotencia) y la purga de claves
   caducadas; se mata solo tras 5 ciclos fallidos porque Docker no reinicia por `unhealthy`.
3. **`releases/manifest.json`** con la release `0.1.0` retroactiva (13 hashes de migración, base
   image, `homologation_status: not_applicable`); `scripts/release-manifest.mjs check|new|digest`;
   el check es paso de `verify` y **probado con cuatro variantes rotas** (migración editada,
   borrada, nueva sin registrar con y sin tag). La variante «editada» destapó que el hash era
   sensible a CRLF: normalizado.
4. **Traefik: solo labels** — router propio con `Host && !Path(/healthz) && !Path(/readyz)`,
   cabeceras, rate limit laxo por IP. Red del proxy `external: true`. Nada de n8n, nada de la
   configuración estática.

Controles nuevos en la API que salieron de la auditoría: **rate limit por usuario** (`429
RATE_LIMITED`, 300/min, nunca por IP en la API), **plazo por petición** (`504 GATEWAY_TIMEOUT`,
30 s ≪ 15 min del reaper: es lo que hace seguro liberar claves), `/readyz` con plazo y sin
detalle, apagado con respaldo de 8 s, `X-Request-Id` acotado. Catálogo en `ERROR_CATALOG.md`.

### La auditoría de S0.6a: 24 hallazgos

| # | Sev. | Qué era | Estado |
|---|---|---|---|
| F-1 | alto | fallo del JWKS servido como 401 sin log | ✅ 503 + log, tests con `fetch failed` y `ERR_JWKS_TIMEOUT` |
| F-2 | medio | hs256-en-producción dependía de una sola señal, sin test | ✅ segunda capa (emisor local) + 8 tests de `config.ts` |
| F-3 | bajo | caché JWKS 10 min tras revocar | 📝 runbook en `infra/README.md` |
| F-4 | bajo | `X-Request-Id` sin acotar | ✅ `/^[\w.-]{1,64}$/` o se genera |
| F-5 | medio | `/readyz` público, con `select 1` gratis y campo `db` | ✅ excluido del router, sin detalle |
| F-6 | alto | sin rate limit en ninguna capa | ✅ por usuario en la API + laxo por IP en Traefik, tests |
| F-7 | medio | readiness que se cuelga | ✅ plazo 2 s, test con base que no responde |
| F-8 | medio | apagado sin plazo ni idempotencia de señal, promesa sin manejar | ✅ flag, respaldo 8 s, `unhandledRejection` |
| **F-9** | **alto** | **T2 tardío del worker pisaba la reserva viva de otro worker** | ✅ testigo `attempts` + plazo de entrega < reaper, **test con la carrera exacta** |
| F-10 | alto | T2 de idempotencia sin guarda; reaper podía liberar una operación viva | ✅ `and status='in_progress'` + timeout de petición 30 s |
| F-11 | alto | healthcheck del worker sin actuador (Docker no reinicia `unhealthy`) | ✅ el worker sale con 1 tras 5 fallos o ciclo colgado |
| F-12 | medio | claves caducadas `in_progress` para siempre; sin purga | ✅ reaper las libera; `purgarIdempotencia` a 7 días, test |
| F-13 | medio | reaper devolvía sin backoff | ✅ backoff por intentos, test |
| F-14 | medio | bucle sin red: sin handlers, reapers después del lote | ✅ |
| **F-15** | **alto** | **los dos servicios se conectan como el superusuario `postgres.<ref>`** | ✅ **CERRADO por decisión tuya, antes del primer deploy**: ADR-0031 + migración 14 + pgTAP 014. Ver sección siguiente |
| F-16 | bajo | `NullTransmitter` con `console.log` por defecto en paquete puro | ✅ sumidero obligatorio |
| F-17 | riesgo | `published` ≠ «recibido por SENIAT» con el transmisor nulo | 📝 `REGULATORY_STATUS.md` + README |
| F-18 | medio | red del proxy compartida: `ladino-api:3000` alcanzable desde n8n | ✅ controles en la app; escrito en compose y README |
| F-19 | medio | sin `cap_drop`/`read_only`/`no-new-privileges`/`pids_limit` | ✅ |
| F-20 | medio | base image sin digest | ✅ `node:22-alpine@sha256:c610fc…` + `base_image` en manifest |
| F-21 | bajo | postinstall como root en el build | ✅ `--ignore-scripts` |
| F-22 | bajo | `.dockerignore` no cubría `apps/*/.env` | ✅ `**/.env*` |
| F-23 | bajo | `.npmrc` copiado al build | 📝 nota: jamás tokens ahí; secret de BuildKit si hace falta |
| F-24 | bajo | `reservations.cpus` no actúa en Compose | 📝 dicho en compose y README |

**Lo que la auditoría cerró sola y no aparece arriba:** el test del worker asertaba `publicados: 3`
y pasaba solo pero fallaba dentro de `verify` (8: cinco filas de otros tenants dejadas por los
tests de la API). El worker es global por diseño; el test ahora drena, aserta por tenant y acota
los contadores por abajo. Un test que depende del orden de los suites no es un test.

### F-15 cerrado: ADR-0031, migración 14, pgTAP 014 — la RLS ya contiene a la API

Tu razón, que ahora está en el ADR: con el superusuario, las seis migraciones de aislamiento de
S0.3 eran decorativas para el camino real, y la única defensa era que el código filtrara — el
modelo descartado. Lo construido:

- **`ladino_api`** y **`ladino_worker`**, `NOBYPASSRLS NOSUPERUSER`, creados por la migración 14
  **sin contraseña** (LOGIN y contraseña: seed local / operador en remoto, `infra/README.md`).
- **Funciones de actor SEPARADAS**: `platform.ladino_service_actor_id()` (solo el GUC) y
  `ladino_service_tenant_ids()`. Las del camino `authenticated` **no se tocaron** — el primer
  diseño (un `coalesce(auth.uid(), GUC)` compartido) lo tumbaron SEIS suites de pgTAP: con el
  GUC puesto, una sesión authenticated SIN JWT ganaba visibilidad. La separación es estructural
  y su variante rota (mezclar los caminos) quedó en 014 como negativo.
- Policies `TO ladino_api` por **tenant** del actor en las 14 tablas (idempotencia además por
  actor); `ladino_worker` solo GRANT sobre `outbox` e `idempotency_keys`.
- **pgTAP 014, 35 aserciones**: catálogo consultado (no supuesto), ejercicio con actor A contra
  datos de B (0 filas, dato intacto, 42501), multi-tenant, sin actor, y TRES variantes rotas
  (policy permisiva → mide la RLS; GRANT al worker → mide el privilegio; policy de authenticated
  con función de servicio → mide la separación). Total pgTAP: **403**.
- **Los vitest de la API y del worker conectan como los roles dedicados** — y eso encontró dos
  agujeros reales al primer intento: `tenantVisible()` corría FUERA de `withTransaction` (sin
  GUC → 404 para todo el mundo; con postgres pasaba en silencio) y a los roles les faltaba
  USAGE sobre `extensions` (pgcrypto, que usa `uuidv7()`). Los dos, arreglados y en verde.
- Aprendizajes de aplicación de la migración: `ALTER ROLE … NOSUPERUSER` exige superusuario con
  solo nombrarlo (las migraciones corren como `postgres`, que no lo es) → el cinturón es el
  bloque `LAD32` que aborta si los atributos no cumplen. Y cuatro aserciones de catálogo de
  suites viejos (recuentos de policies, «cero escrituras con predicado») se acotaron al camino
  de cliente: habían caducado con ADR-0031, la propiedad que protegen sigue intacta.

**VALIDAR-SUPABASE:** que el pooler (6543) acepte los roles dedicados; si no, 5432 directo.
**Pendiente del operador en remoto:** aplicar migración 14 y fijar contraseñas de los roles.

### Lo que queda ANTES del primer deploy real (en orden)

1. **Rotar credenciales** — la `sb_secret` y el token `sbp_…` se pegaron en un chat. (Dijiste
   que rotas tú y avisas.) Los VALIDAR-DEPLOY de Traefik también los consultas tú en el VPS.
2. ~~Migraciones en el remoto~~ **HECHO (2026-08-26): proyecto NUEVO `udacvwnhwpsdzbouhqhl`
   («ladino2», us-west-2, Postgres 17.6, firma ES256). Las 17 migraciones aplicadas en orden por la
   Management API y registradas en `supabase_migrations.schema_migrations` con la forma de la CLI
   (un `db push` futuro las reconoce). Paridad verificada por huella: 553 objetos idénticos local
   ↔ remoto (columnas, constraints, índices, policies, funciones con proconfig, triggers, RLS,
   grants, atributos de roles, seeds).** El proyecto anterior (`igpfrwdgmicgyirwdbgs`) quedó
   pausado y abandonado. Pendientes: contraseñas de `ladino_api`/`ladino_worker` (las pone el
   operador; `infra/README.md` §Roles de servicio) y el VALIDAR-SUPABASE del pooler.
   **Rotación al cerrar**: los tokens `sbp_` (dos) y la `sb_secret` del proyecto nuevo se pegaron
   en el chat.
3. Construir y publicar las imágenes por la secuencia de `infra/README.md`; anotar digests con
   `pnpm release:manifest digest`; etiquetar `v0.1.0`.
4. En el VPS: consultar la red y el resolver del Traefik existente (no inventarlos), secretos en
   `/etc/ladino/*.env` con `chmod 600`, `docker compose -p ladino … up -d`.

Después: **maestros por `platform.ladino_user_company_ids(uuid)`** (sección «Primer paso del
bloque 4», más abajo): migración con gate de coste y variante rota → middleware de alcance →
primer maestro. Rigor normal.

---

# Handoff anterior — 2026-08-18 (S0.5)

`pnpm verify` corría entonces **10 pasos**; 368 pgTAP + 37 tests de vitest. Lo que sigue se
conserva porque el bloque 4 (maestros) se apoya en ello.

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

`udacvwnhwpsdzbouhqhl` (ref en `.env`, que está en `.gitignore`; plantilla en `.env.example`).
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


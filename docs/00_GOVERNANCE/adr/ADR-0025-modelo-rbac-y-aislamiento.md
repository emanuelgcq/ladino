# ADR-0025 — Modelo RBAC, alcance por recurso y las dos capas del aislamiento

- **Estado:** Propuesto · **Fecha:** 2026-08-08 · **Impacto fiscal:** NO
  (pero sostiene la segregación de funciones, que sí lo tiene)
- **Concreta:** ADR-0014 (permisos desde memberships) y ADR-0006 (append-only)

## Contexto

S0.3 crea la primera migración del proyecto: identidad organizacional y aislamiento multi-tenant.
Al preparar el DDL, `spec-explorer` encontró que **la pieza central del modelo de permisos no
está especificada en ninguna parte**.

`SPRINT_0_BOOTSTRAP.md` nombra la tabla `scope_bindings`. `ADR-0014` dice que las funciones de
alcance la leen. `COMPANIES_BRANCHES_WAREHOUSES_SPEC.md` enuncia la regla que existe para
resolver —*"el cajero solo opera las cajas asignadas"*— y ahí se acaba. Ni columnas, ni a qué
nivel de la jerarquía apunta, ni cómo se relaciona con `user_role_assignments`.

Escribir ese DDL es tomar una decisión estructural. Este ADR la toma por escrito antes de que
exista una línea de SQL, porque una migración aplicada no se edita (ADR-0019) y el modelo de
permisos es la base sobre la que se apoyan la segregación de funciones y todo el aislamiento.

Además, dos hallazgos de esta fase de investigación merecen quedar registrados: por qué la
segunda capa de ADR-0006 es un trigger y no una policy, y qué implica de verdad la decisión de
ADR-0014 en coste por consulta.

## Decisión

### 1. Jerarquía organizacional

```
tenants ──┬─▶ companies ──┬─▶ branches ──┬─▶ warehouses      (branch_id nullable)
          │               │              └─▶ cash_registers
          └─▶ memberships └─▶ ...
```

- **`tenants`** — agrupa una o varias companies. Es el caso de la firma contable que lleva veinte
  clientes (ADR-0014). **No es una entidad legal.**
- **`companies`** — *"una empresa representa una entidad/RIF"*. Es el nivel al que pertenece toda
  transacción. Estados `onboarding → active → suspended`.
- **`branches`**, **`warehouses`**, **`cash_registers`** — cuelgan de la company.

Dos resoluciones de nomenclatura y forma:

- La tabla de cajas se llama **`cash_registers`**. `SPRINT_0_BOOTSTRAP.md` decía `registers`;
  `COMPANIES_BRANCHES_WAREHOUSES_SPEC.md` ya publica `POST /v1/cash-registers`. Gana el contrato
  publicado, y el bootstrap queda corregido.
- **`warehouses.branch_id` es nullable.** El texto de la spec dice que un almacén *puede*
  pertenecer a una sucursal; el ERD lo dibuja obligatorio. Gana el texto, que es más específico.
  Un almacén central que sirve a varias sucursales es una operación normal.

### 2. Anclas de aislamiento

`tenant_id uuid NOT NULL` en **toda** tabla tenant-owned, sin excepción. `company_id` según el
nivel real del registro, decidido tabla por tabla en vez de por convención genérica:

| Tabla | `tenant_id` | `company_id` |
|---|---|---|
| `tenants` | — (es la raíz) | — |
| `companies` | `NOT NULL` | — (ella *es* la company) |
| `branches`, `warehouses`, `cash_registers` | `NOT NULL` | **`NOT NULL`** |
| `memberships` | `NOT NULL` | — (el vínculo es usuario↔tenant) |
| `roles` | **nullable** | — |
| `user_role_assignments` | `NOT NULL` | **nullable** (null = alcance tenant-wide) |
| `scope_bindings` | `NOT NULL` | `NOT NULL` |
| `role_permissions` | sigue a `roles` | — |
| `permissions` | **ausente** | — |

### 3. `permissions` es un catálogo global — excepción declarada

`permissions` es el catálogo de acciones que el **sistema** sabe hacer (`invoice.issue`,
`journal.post`, `period.close`, `supplier.bank_account.approve`, `fiscal.audit.read`). No es dato
de nadie: es vocabulario. Ponerle `tenant_id` obligaría a replicar el mismo catálogo en cada
tenant y abriría la puerta a que dos tenants tengan vocabularios divergentes, que es justo lo que
haría imposible razonar sobre segregación de funciones a nivel de producto.

**Rompe la regla genérica de que toda tabla lleve `tenant_id`, y por eso queda declarada como
excepción explícita — en este ADR y en un comentario de la propia migración.** Una excepción sin
declarar es indistinguible de un olvido, y el `rls-security-auditor` no debe tener que adivinar
cuál de las dos cosas es.

RLS igualmente `ENABLE` + `FORCE`, con una única policy de **`SELECT` para `authenticated`**. Sin
`INSERT`, `UPDATE` ni `DELETE`: el catálogo se puebla por migración.

`roles` lleva **`tenant_id` nullable**: `null` = rol de sistema (`tenant_owner`, `company_admin`,
`cajero`), con valor = rol propio de ese tenant. Permite el catálogo fijo de hoy sin cerrar la
puerta a roles personalizados, y sin decidir hoy cuál de los dos modelos gana.

### 4. `scope_bindings` y `requires_scope` — el default deniega

Un rol asignado a un usuario no siempre aplica a toda la company. Un cajero tiene el rol de
cajero, pero solo para las cajas que le asignaron.

```
user_role_assignments ──1:N──▶ scope_bindings
  (usuario, rol, company)        (scope_type, scope_id)

scope_type ∈ { branch, warehouse, cash_register }
```

La pregunta que decide la seguridad del modelo es **qué significa la ausencia de bindings**.

La respuesta cómoda es "sin binding, el rol aplica a toda la company". **Es la respuesta
peligrosa**, y se rechaza: con ese default, *olvidar* asignar el alcance concede acceso a todas
las cajas de la empresa en vez de a ninguna. El fallo por omisión debe restar permisos, nunca
sumarlos.

Pero tampoco vale invertirlo para todo: un `company_admin` es company-wide por naturaleza y
exigirle bindings a cada sucursal sería ruido que acabaría en un binding comodín.

**Lo decide una columna, no una convención:**

```
roles.requires_scope boolean NOT NULL
```

| `requires_scope` | Sin bindings | Con bindings |
|---|---|---|
| `true` (cajero, almacenista) | **no opera nada** | opera solo lo enlazado |
| `false` (company_admin, contador) | opera toda la company | — |

Que sea una columna y no una convención importa por tres razones: es auditable con una consulta,
el `rls-security-auditor` puede comprobarla mecánicamente, y un rol nuevo obliga a **decidir**
`requires_scope` en vez de heredar un default invisible.

#### Y la coherencia se comprueba sola

Una columna que alguien puede poner mal sigue siendo un riesgo, solo que más visible. Un rol de
cajero creado con `requires_scope = false` vuelve al default peligroso, y detectarlo no puede
depender del juicio de quien audite.

Se formaliza en dos piezas:

**1. `permissions.is_scoped boolean NOT NULL`** — marca qué permisos operan sobre recursos
acotados. `cash_register.operate` y `warehouse.move` sí; `company.read` y `report.export` no. Es
una propiedad del permiso, no del rol: la decide quien añade el permiso al catálogo, que es quien
sabe sobre qué recurso actúa.

**2. Invariante forzado en la base:**

> Un rol que tenga **algún** permiso con `is_scoped = true` debe tener `requires_scope = true`.

No es expresable con un `CHECK` (necesita subconsulta), así que va como **constraint trigger
diferido** sobre **las tres** tablas que pueden romperlo:

| Tabla | Evento | Cómo lo rompería |
|---|---|---|
| `role_permissions` | `INSERT`, `UPDATE` | conceder un permiso acotado a un rol company-wide |
| `roles` | `UPDATE OF requires_scope` | pasar a `false` un rol que ya tiene permisos acotados |
| **`permissions`** | **`UPDATE OF is_scoped`** | **marcar `true` un permiso que varios roles ya tienen** |

El tercero es el que se escapa si no se piensa: reclasificar un permiso existente rompe el
invariante **en todos los roles que ya lo tenían**, y esa transacción no toca ni `roles` ni
`role_permissions`. Sin trigger ahí, el sistema quedaría incoherente sin que nada lo notara — que
es exactamente el modo de fallo que este ADR documenta en otras cuatro capas.

Diferido a `COMMIT` para que poblar el catálogo por migración no dependa del orden de los
`INSERT`.

```
platform.assert_role_scope_coherence()
  → si existe role_permissions rp join permissions p on p.is_scoped
    donde roles[rp.role_id].requires_scope = false  ⇒  excepción
```

Conceder un permiso acotado a un rol company-wide deja de ser un descuido posible: la
transacción no cierra. El auditor ya no tiene que juzgar la correspondencia; **la base la
rechaza**.

### 5. Las cuatro funciones de alcance

```sql
platform.ladino_tenant_ids()                          -- returns setof uuid
platform.ladino_company_ids()                         -- returns setof uuid
platform.ladino_has_permission(perm text, company_id uuid)  -- returns boolean
```

`ladino_tenant_ids()` no estaba en la lista de S0.3 (sí en `SUPABASE_DESIGN.md`). Se incluye: es
la base sobre la que se construyen las otras dos y separarla evita repetir la misma subconsulta en
cada policy.

#### Van en `platform`, no en `auth` — y esto lo descubrió la base de datos

La primera versión de este ADR, ADR-0014 y `SUPABASE_DESIGN.md` las nombraban `auth.ladino_*`.
Al aplicar la migración, Postgres cortó en la sentencia 63:

```
ERROR: permission denied for schema auth (SQLSTATE 42501)
```

**El esquema `auth` no es nuestro.** Lo posee `supabase_auth_admin` (GoTrue); las migraciones
corren como `postgres`, que no tiene `CREATE` sobre él. Y aunque se forzara el permiso, sería
peor: Supabase gestiona ese esquema y lo reescribe en sus actualizaciones, así que las funciones
podrían desaparecer sin aviso en un upgrade de la plataforma.

Van en **`platform`**, por el mismo razonamiento que ya llevó ahí a `uuidv7()` y
`reject_mutation()` (§8): es el esquema que **sí** es nuestro y que PostgREST no expone.

Vale la pena registrar cómo se llegó al error, porque el modo de fallo es nuevo: **tres
documentos coincidían entre sí y ninguno se había contrastado contra la plataforma.** La
coherencia interna se confundió con la corrección. No fue ausencia de fallo leída como éxito —
fue acuerdo entre fuentes que compartían el mismo supuesto sin verificar.

Las cuatro son **`STABLE`**, no `IMMUTABLE`: dependen de datos de tabla que cambian. Y
**`SECURITY DEFINER`** con `search_path` fijado, porque tienen que leer `memberships` y
`user_role_assignments` por debajo de la RLS que ellas mismas alimentan — si no, la recursión es
inevitable.

**`search_path` fijado no basta.** Una función `SECURITY DEFINER` se ejecuta con los privilegios
de quien la creó, y en Postgres `EXECUTE` sobre funciones se concede a `PUBLIC` por defecto. Fijar
el `search_path` cierra la vía de secuestro por resolución de nombres; no cierra que **cualquier
rol pueda invocarla**, incluido `anon`. Una función que lee `memberships` por debajo de la RLS y
puede llamarse sin autenticar es una fuga de la estructura organizativa completa.

Las cuatro llevan, sin excepción:

```sql
REVOKE EXECUTE ON FUNCTION platform.ladino_...  FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION platform.ladino_...  TO authenticated;
```

Concesión explícita y solo a `authenticated`. `anon` no las invoca.

Para el alcance por recurso, una cuarta:

```sql
platform.ladino_has_scope(perm text, scope_type text, scope_id uuid)  -- returns boolean
```

Es la que consultarán las policies de las tablas operativas que lleguen en fases posteriores
(movimientos de caja, de almacén). Se crea ahora porque la regla que implementa —§4— se decide
ahora, y dejarla para después invitaría a que cada tabla se invente la suya.

### 6. Las dos capas del aislamiento, y por qué la segunda es un trigger

**`FORCE ROW LEVEL SECURITY` no contiene a un rol con `BYPASSRLS`.**

`FORCE` resuelve un problema distinto del que la gente supone: hace que la RLS se aplique también
al **propietario** de la tabla, que por defecto queda exento. Lo que **no** hace es contener a un
rol con el atributo `BYPASSRLS` — Postgres lo exceptúa de la comprobación por diseño, y en
Supabase `service_role` lo tiene.

Consecuencia: **la RLS protege de `anon` y `authenticated`. No protege de `service_role`.** Y
`service_role` es exactamente lo que usan el worker, los jobs y cualquier proceso de servidor.

De ahí que la inmutabilidad de ADR-0006 sea un **trigger `BEFORE UPDATE OR DELETE`** y no una
policy restrictiva. No es una elección de estilo ni redundancia defensiva:

| Capa | Contiene a | No contiene a |
|---|---|---|
| Policies RLS | `anon`, `authenticated`, propietario (con `FORCE`) | **`service_role`** (`BYPASSRLS`), y **`TRUNCATE` de cualquiera** |
| Trigger `reject_mutation()` | `UPDATE`, `DELETE` **y `TRUNCATE`**, para todos incluido `service_role` | superusuario que lo deshabilite |

> **Corrección (auditoría de S0.3).** La primera versión de esta tabla decía que
> el trigger contenía "a **todos**". Era falso para `TRUNCATE`, y `TRUNCATE` es
> justo la operación que vacía una tabla append-only entera:
>
> - **ignora la RLS por diseño** — ninguna policy lo ve;
> - **no dispara un trigger `BEFORE UPDATE OR DELETE`**;
> - y Supabase concede `TRUNCATE` a `anon` y `authenticated` en **toda tabla
>   nueva** vía `ALTER DEFAULT PRIVILEGES`. `auto_expose_new_tables = false`
>   suprime `arwd`, no `Dxtm`.
>
> Un trigger de `TRUNCATE` es obligatoriamente `FOR EACH STATEMENT`: no hay filas
> que recorrer. La migración 5/5 lo añade y revoca los privilegios por defecto,
> para que la defensa no dependa de enumerar cada tabla a mano — que es la forma
> lenta de olvidarse.

**Esta razón queda escrita aquí porque sin ella alguien simplificará.** Un trigger que parece
duplicar lo que ya hace una policy es el candidato natural a "limpieza" en una revisión futura, y
quitarlo abriría `UPDATE` sobre `journal_lines` a todo proceso de servidor sin que ninguna prueba
de RLS lo notara.

Corolario para S0.3: `platform.reject_mutation()` se diseña **como función de trigger**, con
`RETURNS trigger`, no como predicado de policy.

### 7. Consecuencia de rendimiento de ADR-0014

ADR-0014 decidió que los permisos se resuelven **contra la base en cada consulta**, no desde el
JWT, para que revocar un acceso no dependa de esperar la expiración de un token. Esa decisión
tiene una factura y conviene verla antes de pagarla.

Cada policy RLS invoca `platform.ladino_*`, y cada invocación consulta `memberships`,
`user_role_assignments` y `scope_bindings`. En una consulta que devuelve mil filas, el planificador
puede evaluar la función una vez (si la reconoce como `STABLE` y el predicado no depende de la
fila) o por fila (si depende). **La diferencia entre las dos es de tres órdenes de magnitud**, y
determina si se cumple el objetivo p95 < 500 ms de ADR-0014.

Por eso:

- **`STABLE`, nunca `VOLATILE`.** Una función `VOLATILE` se evalúa por fila siempre y el
  planificador no puede hacer nada al respecto.
- **Sin caché de sesión.** Ni `SET LOCAL`, ni tabla temporal, ni memoización en el pooler. Cachear
  el resultado por conexión **anula el diseño entero de ADR-0014**: el punto es que quitar un
  membership corte el acceso en la consulta siguiente. Si hay que cachear algo, se mide primero y
  se decide con datos, como el propio ADR-0014 dice ("se mide contra el objetivo p95 < 500 ms
  antes de considerar cachés").
- **Índices desde la migración `0001`, no cuando duela.** Añadirlos después de que haya datos y
  tráfico es una migración con `CREATE INDEX CONCURRENTLY` y una ventana de riesgo:

| Índice | Sirve a |
|---|---|
| `memberships (user_id, tenant_id)` | `ladino_tenant_ids()` |
| `user_role_assignments (membership_id, company_id)` | `ladino_company_ids()` |
| `role_permissions (role_id, permission_key)` | `ladino_has_permission()` |
| `scope_bindings (assignment_id, scope_type, scope_id)` | `ladino_has_scope()` |
| `(tenant_id, company_id)` en toda tabla operativa | el predicado de toda policy |

- **Medir es parte de S0.3, no de "después".** El test pgTAP incluye un caso con volumen que deje
  registrado el plan de ejecución de una policy. Sin una medida inicial no hay forma de saber, dos
  fases más tarde, si algo se degradó o si siempre estuvo así.

### 8. Generación de la PK: `platform.uuidv7()` propia

`ENGINEERING_STANDARDS.md` exige **UUID v7**, ordenable por tiempo. Lo investigado:

- **`uuidv7()` nativo llega en PostgreSQL 18.** Supabase está en **17**.
- **`pg_uuidv7` no está en las extensiones de Supabase.** Hay una discusión abierta pidiendo que
  lo añadan, y no existe página de documentación para ella.

Así que las dos vías previstas están cerradas. Lo que queda:

| Opción | A favor | En contra |
|---|---|---|
| **`uuidv7()` propia en SQL**, sobre `gen_random_bytes()` de `pgcrypto` | Cumple el estándar hoy, sin extensiones. `pgcrypto` sí está disponible. Son ~10 líneas y el algoritmo está en el RFC 9562. El día que Supabase pase a PG18, cambiar el `DEFAULT` es una línea | Código propio en un camino crítico. Necesita sus propios tests (nibble de versión = 7, bits de variante, monotonía) |
| **`gen_random_uuid()` (v4)** | Cero código, disponible siempre | **Incumple `ENGINEERING_STANDARDS.md`.** Fragmenta el índice de PK justo en las append-only que más crecen —`journal_lines`, `inventory_moves`, `fiscal_events`— donde la localidad de escritura no es cosmética |
| **Generar en la aplicación** | Independiente de la versión | El `DEFAULT` desaparece: un `INSERT` desde SQL directo, un seed o un pgTAP produciría filas sin id |
| **Esperar a PG18** | Ninguna deuda | Bloquea S0.3 por tiempo indefinido |

**Se elige la función propia: `platform.uuidv7()`.** Es la única opción que cumple el estándar
hoy y sigue siendo correcta mañana: cuando Supabase pase a PG18 **cambia el `DEFAULT`, los datos
no**. Un `uuidv7` generado por nosotros y uno generado por Postgres son el mismo valor de 128
bits con la misma estructura; no hay migración de datos, solo de dónde sale el siguiente.

Descartada v4 por la razón que la hace cara justo donde más duele: fragmenta el índice de PK en
las append-only que más crecen —`journal_lines`, `inventory_moves`, `fiscal_events`— y ahí la
localidad de escritura no es cosmética.

#### En `platform`, no en `public`

Se crea un esquema **`platform`** para la infraestructura del proyecto: `uuidv7()`,
`reject_mutation()` y lo que venga de esa naturaleza.

`public` es el espacio que Supabase expone por PostgREST. Cualquier función ahí es superficie de
API accesible por HTTP salvo que se revoque a mano, y una utilidad interna no tiene por qué serlo.
Separarla evita tener que acordarse de revocar, que es otra forma de "ausencia de mecanismo"
(`CLAUDE.md` §2).

```sql
-- platform.uuidv7()
--
-- UUID v7 según RFC 9562: 48 bits de timestamp Unix en milisegundos, nibble de
-- versión = 7, 2 bits de variante = 0b10, el resto aleatorio de pgcrypto.
--
-- Existe porque Supabase corre PostgreSQL 17 y uuidv7() nativo llega en 18;
-- pg_uuidv7 no está en sus extensiones (discusión abierta, sin fecha).
--
-- CAMINO DE SALIDA cuando Supabase pase a PG 18:
--   ALTER TABLE ... ALTER COLUMN id SET DEFAULT uuidv7();
-- y esta función se deja de usar. NO hay migración de datos: los ids ya
-- emitidos son UUID v7 válidos y siguen ordenando igual. Cambia el DEFAULT,
-- los datos no.
```

Tests pgTAP obligatorios de la función, en la propia migración:

| Test | Qué falsaría |
|---|---|
| Nibble de versión = `7` | una implementación que emita v4 disfrazado |
| Bits de variante = `0b10` (RFC 9562) | un UUID malformado que otras librerías rechazarían |
| **Monotonía**: ids generados en secuencia ordenan por tiempo | que el timestamp no esté en los bits altos, que es todo el motivo de usar v7 |
| **Unicidad bajo concurrencia**: N sesiones generando a la vez, cero colisiones | entropía insuficiente dentro del mismo milisegundo |

### 9. Superficie de escritura: qué pasa por PostgREST y qué por la API

Consecuencia directa de §5, descubierta al escribir el DDL. Las cuatro funciones de alcance
resuelven permisos **por company**, y hay operaciones que no tienen una contra la que preguntar:

- **Crear una company** no tiene `company_id` todavía.
- **Gestionar `memberships`, `roles` o `user_role_assignments`** es alcance de tenant, no de company.

Escribir el predicado en línea dentro de una policy de `memberships` tampoco vale: **recurriría
sobre la propia tabla**, porque decidir si puedes escribir en `memberships` exige leer
`memberships`.

**Decisión: `authenticated` no escribe nada de nivel tenant ni del bloque RBAC.**

| Tabla | `authenticated` escribe | Pasa por la API con `service_role` |
|---|---|---|
| `branches`, `warehouses`, `cash_registers` | **sí** (insert/update/delete) | — |
| `companies` | solo `update` | insert, delete |
| `tenants` | no | **sí** |
| `memberships`, `roles`, `permissions`, `role_permissions`, `user_role_assignments`, `scope_bindings` | **no** | **sí** |

Todas conservan su policy de `select`: leer el propio alcance es legítimo y necesario para
pintar una UI. Lo que no se puede es escribirlo.

**Que nadie pueda concederse permisos por PostgREST es una propiedad deseada, no un efecto
lateral.** El bloque RBAC es exactamente la superficie que un atacante con un token válido
querría tocar; que no exista policy de escritura la cierra por construcción, sin depender de que
un predicado esté bien escrito.

**Habilitar escritura RBAC por PostgREST exigiría una quinta función `SECURITY DEFINER`** —algo
como `platform.ladino_has_tenant_permission(perm, tenant_id)`— con su propio `search_path`, su
`REVOKE`/`GRANT`, y el análisis de por qué no recurre. Eso es superficie de privilegio nueva sobre
la tabla que concede privilegios: **requiere ADR propio**, no un parche en una migración posterior.

### 9.1 Las FK compuestas, y por qué no son un detalle de implementación

`tenant_id` está denormalizado en toda tabla que también lleva `company_id`. Es lo que permite que
el predicado de cada policy empiece por `tenant_id` sin un join.

El precio: **un `tenant_id` mal copiado convierte el ancla de aislamiento en mentira, y ninguna
policy lo nota.** Una fila de `branches` con el `company_id` de la empresa A y el `tenant_id` del
tenant B satisface la policy del tenant B y expone datos de A. Es un fallo de integridad que se
presenta como un fallo de seguridad, y las pruebas de aislamiento no lo encuentran porque prueban
el mecanismo, no los datos.

**FK compuestas** `(tenant_id, company_id) → companies (tenant_id, id)`, que obligan a un
`UNIQUE (tenant_id, id)` en las tablas referenciadas. Con ellas la incoherencia es imposible de
insertar, no improbable.

#### Corrección: coherencia no es inmutabilidad

**Esta sección se leyó, y se aprobó, como si las FK compuestas impidieran que una fila cambiara
de tenant. No lo hacen, y la diferencia resultó ser una fuga entre tenants.**

Lo que garantizan es que `tenant_id` y `company_id` **concuerdan entre sí**. Nada impide
cambiarlos **los dos a la vez** a un par igualmente coherente de otro tenant.

Y una policy de `UPDATE` tampoco puede impedirlo: tiene `USING` (evalúa la fila vieja) y
`WITH CHECK` (evalúa la nueva), pero **Postgres no ofrece `OLD` dentro de una policy**. Para un
usuario con membership en dos tenants las dos comprobaciones pasan —ve la fila en A, y B está
entre sus tenants— y un solo `UPDATE` traslada la fila. Después, cualquier miembro de B la lee.

No es un caso exótico: es **el caso central del producto**, la firma contable que lleva veinte
clientes con la que este mismo ADR justifica la existencia de `tenants`.

La inmutabilidad se consigue donde la RLS no llega, y en dos capas por el argumento de §6:

| Capa | Qué hace | A quién no alcanza |
|---|---|---|
| `GRANT UPDATE (col, …)` por columna | `authenticated` no puede ni nombrar `tenant_id` | `service_role` |
| Trigger `assert_isolation_anchors_immutable()` | rechaza `new.tenant_id is distinct from old.tenant_id` | superusuario |

Migración 5/5. SQLSTATE `LAD28`.

Excepción: **`roles.tenant_id` es nullable** (§3), y una FK compuesta con `MATCH SIMPLE` —el
default— **se salta la comprobación entera si alguna columna es NULL**. Justo en la tabla donde
más importa. Ahí la FK se sustituye por `platform.assert_rbac_tenant_coherence()`, un trigger que
comprueba lo mismo sin depender de la semántica de NULL.

Esto no estaba en la versión original de este ADR. Es una mejora sobre él.

### 9.2 `permissions` tiene dos excepciones, no una

§3 declara que `permissions` no lleva `tenant_id`. Al escribir el DDL apareció la segunda:

- **Sin `tenant_id`** — es vocabulario del sistema, no dato de nadie (§3).
- **PK textual**, la propia `key` (`invoice.issue`, `journal.post`), no un `uuid`. Un catálogo
  cerrado que se puebla por migración y se referencia por nombre en el código no gana nada con un
  identificador opaco, y sí pierde legibilidad en cada `role_permissions` y en cada mensaje de
  error.

Las dos van declaradas en el mismo comentario SQL de la tabla. Una excepción sin declarar es
indistinguible de un olvido.

### 9.3 `VALIDAR-RBAC` — la clasificación de `invoice.issue`

De los 23 permisos del catálogo inicial, **`invoice.issue` es el único cuya clasificación
`is_scoped` no está clara**. Queda en `false` (company-wide) con la marca en la migración.

La duda es real: si emitir una factura debe estar acotado a la caja o a la sucursal desde la que
se emite —cosa que `packages/fiscal` decidirá con las series fiscales delante— entonces debería
ser `true`.

Lo que hace segura la espera es el invariante de §4: el día que se reclasifique, el
`update permissions set is_scoped = true` **hará fallar el `COMMIT`** si algún rol company-wide ya
lo tenía concedido. El error será ruidoso y en el momento correcto, que es exactamente lo que se
quiere de una clasificación provisional.


## Consecuencias

**Positivas**

- El modelo de permisos existe por escrito antes que el SQL, y la migración `0001` —que no se
  podrá editar— se escribe contra una decisión revisada.
- El fallo por omisión en roles acotados **deniega**. Olvidar un binding no concede nada.
- `requires_scope` hace la política auditable con una consulta, no leyendo código.
- La razón de que la inmutabilidad sea un trigger queda registrada donde se busca.

**Negativas y deuda que aceptamos**

- **`is_scoped` en `permissions` es ahora el punto único de fallo.** El invariante ya no depende
  del juicio del auditor, pero sí de que quien añade un permiso al catálogo lo clasifique bien.
  Un `cash_register.operate` registrado con `is_scoped = false` desactiva la comprobación entera
  para ese permiso, y nada lo detecta. El riesgo no desaparece: **se traslada de muchos sitios
  (cada rol) a uno solo (el catálogo)**, que se toca por migración, se revisa en PR y es una lista
  corta. Es una mejora, no una garantía.
- **Cuatro funciones en `auth` con `SECURITY DEFINER`** son cuatro superficies que revisar con
  cuidado. Cada una necesita DOS defensas y las dos son fáciles de olvidar: `search_path` fijado
  (contra el secuestro por resolución de nombres) y `REVOKE EXECUTE FROM PUBLIC` + `GRANT` a
  `authenticated` (contra que `anon` las invoque). Una función nueva que copie el patrón a medias
  es una fuga, y nada en el lenguaje lo impide.
- **`scope_bindings` es polimórfica** (`scope_type` + `scope_id`), así que **no puede llevar FK
  real** a `branches`/`warehouses`/`cash_registers`. Contradice la regla de `ENGINEERING_STANDARDS.md`
  §SQL de "FK reales", y es una excepción consciente a un estándar propio.

  La alternativa —tres columnas nullables con tres FK y un `CHECK` de exclusividad— sí permite FK
  reales, pero **se rompe al cuarto tipo de recurso**, y en un ERP lo habrá: vehículos de
  reparto, puntos de venta, centros de coste. Cada tipo nuevo sería una migración de esquema
  sobre una tabla de permisos con datos de todos los tenants, más una columna nullable más en cada
  policy que la consulte.

  Se compensa con un **trigger de validación de existencia** que comprueba que `scope_id` existe
  en la tabla que `scope_type` indica, y que pertenece a la misma company que el
  `user_role_assignment`. Es integridad referencial a mano: hace lo que haría la FK salvo el
  `ON DELETE RESTRICT`, que hay que replicar con un trigger `BEFORE DELETE` en cada tabla de
  recurso.
- **El constraint trigger de coherencia es diferido**, así que un error de clasificación no
  aparece en el `INSERT` sino al cerrar la transacción. El mensaje tiene que identificar el rol y
  el permiso concretos o el diagnóstico será penoso.
- **`roles` con `tenant_id` nullable** aplaza la decisión de si los roles son personalizables. Un
  aplazamiento cuesta: las policies de `roles` tienen que contemplar los dos casos desde el día uno.
- El coste por consulta de ADR-0014 es real y no desaparece con índices. Si el p95 no se cumple,
  la conversación sobre cachés volverá — y volverá con la revocación inmediata sobre la mesa.

**Para revertirlo:** el modelo entero vive en la migración `0001`, que no se edita. Cualquier
cambio es expand/contract (ADR-0019) sobre tablas que para entonces tendrán datos de identidad de
todos los tenants. **Es de las decisiones más caras de revertir del proyecto**, y esa es la razón
de que este ADR exista antes que el SQL.

## Verificación

- pgTAP: un usuario de la empresa A no ve ni escribe nada de la empresa B, tabla por tabla, en las
  cuatro operaciones.
- pgTAP: un rol con `requires_scope = true` **sin bindings** no accede a ningún recurso acotado.
  Es el test que falsaría el default peligroso si alguien lo reintroduce.
- pgTAP: conceder un permiso con `is_scoped = true` a un rol con `requires_scope = false` **hace
  fallar el `COMMIT`**. Es la prueba de que el invariante es mecánico y no documental.
- pgTAP: un `scope_binding` cuyo `scope_id` no existe, o pertenece a otra company, se rechaza.
  Es lo que sustituye a la FK que la forma polimórfica no permite.
- pgTAP: `platform.reject_mutation()` lanza excepción **ejecutada como `service_role`**. Es la prueba de que
  la segunda capa hace lo que la primera no puede.
- pgTAP: `permissions` no admite `INSERT` desde `authenticated`.
- pgTAP: marcar `is_scoped = true` en un permiso que ya tienen roles company-wide **hace fallar el
  `COMMIT`**. Es el tercer flanco del invariante, el que no toca ni `roles` ni `role_permissions`.
- pgTAP: ninguna de las cuatro funciones `platform.ladino_*` es ejecutable por `anon`.
- `rls-security-auditor`: cero tablas de `public` sin RLS habilitada y forzada.
- Plan de ejecución registrado para al menos una policy con volumen, como línea base de
  rendimiento.

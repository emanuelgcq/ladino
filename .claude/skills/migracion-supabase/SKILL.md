---
name: migracion-supabase
description: Crear una migración SQL de Supabase para Ladino con RLS, constraints, índices y su test pgTAP. Úsalo siempre que haya que cambiar el esquema.
---

# Migración Supabase — Ladino

## 1. Crear el archivo

```bash
pnpm db:new <verbo_objeto>     # p.ej. create_inventory_moves
```

Nunca edites un `.sql` existente en `supabase/migrations/`. Un hook lo bloquea.
Si te equivocaste, corriges con una migración nueva.

## 2. Plantilla

```sql
-- Módulo: <nombre>   Spec: docs/03_MODULES/<X>_SPEC.md
-- Reversible: SÍ|NO  Homologación: YES|NO

create table if not exists public.<tabla> (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete restrict,
  company_id    uuid not null references public.companies(id) on delete restrict,
  -- columnas de negocio; dinero SIEMPRE numeric(24,8)
  status        text not null default 'draft',
  version       bigint not null default 1,
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  constraint <tabla>_status_chk check (status in ('draft','confirmed','cancelled'))
);

create index on public.<tabla> (tenant_id, company_id);
create index on public.<tabla> (company_id, created_at desc);
create index on public.<tabla> (company_id, status);

alter table public.<tabla> enable row level security;
alter table public.<tabla> force row level security;

create policy "<tabla>_select" on public.<tabla> for select
  using (company_id = any (platform.ladino_company_ids()));

create policy "<tabla>_insert" on public.<tabla> for insert
  with check (company_id = any (platform.ladino_company_ids())
              and platform.ladino_has_permission('<recurso>.create', company_id));

create policy "<tabla>_update" on public.<tabla> for update
  using (company_id = any (platform.ladino_company_ids())
         and platform.ladino_has_permission('<recurso>.update', company_id)
         and status = 'draft');
```

## 3. Si la tabla es append-only

Además de no crear policies de update/delete, añade el trigger defensivo:

```sql
create trigger <tabla>_immutable
  before update or delete on public.<tabla>
  for each row execute function platform.reject_mutation();
```

## 4. Test pgTAP obligatorio

`supabase/tests/<NN>_<tabla>_test.sql` debe probar como mínimo:
- un usuario de la empresa A **no ve** filas de la empresa B;
- un insert con `company_id` ajeno falla;
- si es append-only, un update lanza excepción;
- cada CHECK constraint rechaza el valor inválido.

### El usuario multi-tenant es obligatorio en todo test de aislamiento

**Todo test de aislamiento tiene que incluir un usuario con membership en VARIOS
tenants.** No es un caso extremo: es el caso central del producto —la firma
contable que lleva veinte clientes— y es **el atacante realista**. El extraño no
tiene sesión; el peligroso es el usuario legítimo de los dos lados.

Un test que solo prueba A↔A y B↔B no está probando aislamiento: está probando
que dos desconocidos no se ven, que es lo fácil.

Esto no es teórico. En S0.3 dejó pasar una fuga: un `UPDATE` que cambiaba
`tenant_id` y `company_id` a la vez trasladaba la fila de un tenant a otro, y
las dos comprobaciones de la policy pasaban —`USING` veía la fila en A,
`WITH CHECK` aceptaba B porque el usuario también era de B—. Ciento veinte
aserciones en verde y ninguna lo tocaba.

Recuerda además que **`USING` evalúa la fila vieja y `WITH CHECK` la nueva, y
Postgres NO ofrece `OLD` dentro de una policy**: ninguna policy puede exigir que
una columna no cambie. Eso se hace con `GRANT` por columna más un trigger.

### Aisla el aislamiento en las CUATRO operaciones, no solo en SELECT

Un `UPDATE` o un `DELETE` cuyo `WHERE` no encuentra filas **no lanza error**:
afecta a cero filas y devuelve éxito. Un test que solo comprueba `SELECT`, o que
espera excepciones, deja abierta la vía más silenciosa que hay.

**Comprueba el dato, no la excepción:**

```sql
-- Mal: no falla, y el test pasa sin probar nada
select throws_ok($$ update public.branches set name='X' where id='<de B>' $$, ...);

-- Bien: se ejecuta, y después se mira si la fila de B cambió
update public.branches set name = 'SECUESTRADA' where id = '<de B>';
reset role;
select is((select name from public.branches where id = '<de B>'), 'Original',
  'UPDATE de A sobre una fila de B no cambia NADA');
```

### Prueba con datos hostiles, no bonitos

Tercera de la misma familia. Los datos de prueba los elige quien escribe el
test, y **quien escribe el test tiende a elegir los que funcionan**.

El caso que lo enseñó: `aggregate_type` entra en un índice btree, que rechaza
entradas de más de ~2704 bytes. Con `repeat('z', 3000)` **el fallo no se
reproduce** — TOAST comprime la cadena repetitiva y la entrada del índice cabe
de sobra. Hace falta texto **incompresible**:

```sql
-- Mal: pasa en verde sobre un esquema roto
select repeat('z', 3000);

-- Bien: 3000 caracteres que no se comprimen
select string_agg(substr('abcdefghijklmnopqrstuvwxyz',
                         1 + floor(random() * 26)::int, 1), '')
  from generate_series(1, 3000);
```

Vale más allá del texto. Datos hostiles son: cadenas incompresibles, unicode de
más de un byte, `NULL` en toda columna nullable, cero y negativos, el valor
máximo del tipo, fechas en el futuro y en el pasado remoto, y **los nombres
reales del catálogo en vez de una muestra inventada** — el `CHECK` de
`event_type` rechazaba los siete eventos fiscales y los tests pasaban porque
usaban nombres de dos segmentos escritos a mano.

### Ejerce la operación, no preguntes por el privilegio

Misma familia que la anterior, y conviene leerlas juntas. **Un bit de
`has_table_privilege` / `has_function_privilege` dice que puedes *intentarlo*, no
que *funcione*.** Entre el privilegio y el efecto hay policies, triggers,
constraints, y las funciones que evalúan las columnas generadas.

En S0.4, `has_table_privilege('service_role', 'audit_events', 'INSERT')` devolvía
cierto y el `INSERT` fallaba igual con `permission denied for function
audit_payload_hash`: una columna generada evalúa su expresión con los privilegios
de quien inserta, y a esa función le faltaba el `GRANT EXECUTE`. La tabla de
auditoría nacía **escribible por nadie**, con la migración aplicada limpia y la
suite en verde.

```sql
-- Mal: consulta el catálogo. Verde con el camino roto.
select ok(has_table_privilege('service_role', 'public.audit_events', 'INSERT'), '…');

-- Bien: ejecuta el camino autorizado y comprueba que vive.
set local role service_role;
select lives_ok($$ insert into public.audit_events (…) values (…) $$,
  'el INSERT como service_role funciona de verdad, no solo en el catálogo');
reset role;
```

Vale para las dos direcciones. Cierra lo prohibido **y** ejerce lo permitido: una
defensa que cierra el único camino autorizado no es una defensa, es una avería
silenciosa, y todos los checks de negación la acompañan en verde.

### No asevere estados intermedios: caducan

**Los pgTAP corren contra el esquema FINAL, con todas las migraciones aplicadas
— no contra el estado que había cuando se escribió su migración.**

Una aserción como *"esta tabla todavía no tiene policies"* es cierta el día que
se escribe y falsa en cuanto llega la migración siguiente. Entonces el test
falla por caducidad, no por un defecto, y quien lo herede aprenderá a editar
tests en vez de a confiar en ellos.

Asevera solo **propiedades duraderas**: que la RLS esté habilitada y forzada,
que un CHECK rechace, que A no vea a B. Si necesitas comprobar algo del estado
intermedio, hazlo mientras la desarrollas y bórralo antes de commitear.

### Dos capas: privilegios de tabla y RLS. La de abajo actúa primero

`GRANT` y policies son defensas independientes, y Postgres evalúa los
privilegios **antes** que la RLS. Consecuencias al escribir tests:

- Un rol sin `GRANT SELECT` recibe **`42501`**, no una lista vacía. "No ve nada"
  puede ser cualquiera de las dos capas, y el diagnóstico es distinto.
- Para probar que un **trigger** rechaza algo, el rol necesita el privilegio: si
  no lo tiene, Postgres corta antes y el trigger nunca se ejecuta. El test
  "pasaría" por la razón equivocada.

**Asevera siempre por SQLSTATE, nunca por "falla".** Es lo que distingue las dos
capas y lo que destapa un test que pasa por el motivo que no es.

### Una prohibición escrita vale más que una implícita

Denegar con `using (false)` / `with check (false)` **no es lo mismo** que no
crear la policy, aunque el efecto inmediato coincida. La RLS deniega por defecto,
sí — pero esa denegación no la ve un `grep`, ni el `rls-security-auditor`, ni
quien lea el esquema dentro de un año.

`false` es la prohibición **escrita**: greppable, comentable, auditable. Y no
depende de los privilegios de tabla — comprobado: con `grant all on all tables
in schema public to authenticated`, un `using (false)` sigue devolviendo `42501`.

Es `CLAUDE.md` §2 aplicado al SQL: ausencia de mecanismo no es prohibición.

### Un envoltorio SQL sobre una función SQL no inlinable replanifica por fila

Hallazgo caro y nada evidente. **Una función SQL cuyo cuerpo es una sola llamada
a otra función SQL no inlinable —típicamente `security definer`— replanifica el
cuerpo de la interna EN CADA INVOCACIÓN.** En `plpgsql` no: el plan de una
expresión simple vive en el `simple_eval_estate` de la función y sobrevive.

Medido en Ladino sobre la ruta real de RLS, con la función que usan más de
cuarenta policies, 5.000 filas:

| | |
|---|---|
| implementación monolítica | 394 ms |
| **envoltorio SQL delegando** | **10.380 ms** |
| envoltorio plpgsql | 372 ms |

La causa no es pérdida de inlining —una `security definer` nunca fue inlinable—
sino **dónde vive el caché de plan**: invocada directamente por la policy, su
plan está en el plan cacheado de la sentencia; invocada desde el cuerpo de otra
función SQL, su `FmgrInfo` se construye por invocación.

**Si extraes una función común para no duplicar lógica —que es lo correcto—, el
envoltorio va en `plpgsql`.** Y va con comentario, porque reescribirlo en SQL
parece más limpio y equivalente.

### Un gate COMPUESTO no está vivo porque el conjunto pase

Generalización de la anterior, y la más cara de aprender hasta ahora.

Un gate con N reglas —`dependency-cruiser`, un `eslint` con su config, una suite
de policies— **no demuestra nada por pasar entero**. Veintidós reglas en verde
pueden ser veintiuna vivas y una muerta, y desde fuera se ven exactamente igual.

**Cada regla tiene que demostrar que dispara, con su propia violación.**

En Ladino eso es `pnpm boundaries:selftest`, y al escribirlo encontró:

- **`pure-packages-no-io-libs` INERTE desde el día que se escribió** — el
  invariante de que `money`, `accounting` y `fiscal` no tocan I/O nunca estuvo
  protegido. `node_modules` estaba en `exclude`, así que no había aristas npm
  en el grafo y la regla no tenía qué mirar.
- **Y después, el arreglo dejó vivo el mismo fallo un nivel más abajo**: el
  patrón sin anclar excluía también el `dist/` interno de las dependencias npm,
  donde casi todas publican su entry point.

**Los dos estados de una regla que no funciona — y son conceptos, no detalles
del script:**

- **INERTE**: la violación no la detecta nada. El gate da verde con el agujero
  abierto. Es grave y es la variante *visible*: tarde o temprano alguien
  explota el hueco y se nota.
- **TAPADA**: la violación la caza OTRA regla, no la que dice cubrirla. **Es
  peor que una muerta.** El conjunto pasa, alguien lee la regla y cree que
  protege, y el día que la regla que la cubre cambie de alcance —se relaje
  `no-unresolvable`, se mueva un `exclude`— el agujero se abre **sin que nadie
  haya tocado la regla tapada**. No hay commit al que culpar: el fallo lo
  introdujo un cambio en otra parte, años antes, que nadie conectará.

Por eso el arnés exige que dispare la regla **por su nombre**: que salte otra
no cuenta.

**Y el arnés necesita su propio arnés.** La primera pasada del selftest reportó
QUINCE reglas tapadas y era falso: los fixtures importaban paquetes no
declarados, el import no resolvía, y el arnés medía la *resolución*, no la
regla. Un verificador de verificadores también puede estar midiendo lo que no
cree. La advertencia operativa: **si `boundaries:selftest` reporta muchas
muertas de golpe, el primer sospechoso es el arnés** — una regla muere por un
cambio concreto; quince a la vez mueren por un defecto del que las mide.

### Un gate de corrección no detecta una regresión de coste

Corolario del anterior, y es el que dolió: los 348 asserts de S0.4 pasaron en
verde con una regresión de 28× dentro. **Ninguno medía tiempo.**

Toda función que se invoque **por fila** desde una policy necesita gate de coste:
N filas bajo la policy real, presupuesto con margen amplio, y su variante rota.

```sql
-- Medir bajo el rol, ESCRIBIR fuera de él: la tabla temporal es del owner.
do $medir$
declare t0 timestamptz; t1 timestamptz; n bigint;
begin
  set local role authenticated;
  t0 := clock_timestamp();
  select count(*) into n from public.audit_events;
  t1 := clock_timestamp();
  reset role;
  insert into medicion values ('actual', extract(epoch from (t1-t0))*1000);
end $medir$;
```

El presupuesto es un **detector de regresión, no un objetivo**: con ~11× de
margen sobre el coste medido no es flaky en otra máquina, y aun así caza un 25×.
Un gate ajustado al milisegundo se aprende a reejecutar hasta que pase.

### El informe de un subagente es documentación, no catálogo

Antes de escribir un `INSERT` de catálogo (permisos, roles, tipos) o una policy
que **dependa** de una fila existente, **consulta la base**, no el informe que
lo dice. En S0.4 escribí un `insert into permissions ('fiscal.audit.read', …)`
porque `spec-explorer` reportó que faltaba. Estaba desde S0.3, y la migración
falló por clave duplicada.

Un subagente lee `docs/`. `docs/` describe la intención; el catálogo describe lo
que hay. Cuando divergen —y divergen— gana el catálogo. Cuesta un `psql -c`:

```bash
docker exec supabase_db_ladino psql -U postgres -d postgres -tA \
  -c "select key from public.permissions order by key;"
```

El corolario útil sí sobrevivió al error: **una policy que exige un permiso sin
fila en `permissions` cierra la lectura a todo el mundo sin un solo error**. Si
una policy depende de una fila, la migración comprueba que existe y falla si no
—tres líneas de `do $$ … raise exception`— en vez de suponerlo.

### Cuando hay que elegir un modo de fallo, se elige el ruidoso

Regla de diseño, no de test, y aplica cada vez que una decisión reparte los
errores posibles entre dos lados:

- **Un 409 espurio se ve y se corrige.** El cliente recibe el error, lee el
  mensaje, ajusta y reintenta. Coste: una fricción visible.
- **Un replay indebido no se ve nunca.** Devuelve `200` con la respuesta de
  otra operación, nadie recibe señal alguna, y el efecto que faltó (o el que
  sobró) aparece meses después en un cuadre.

Casos ya decididos con este criterio: `endpoint` fuera del índice único de
idempotencia (reusar la clave da 409, no dos facturas); `request_hash` sobre
bytes crudos sin canonicalizar (formato distinto da 409, no un replay de otro
cuerpo); `NULLS NOT DISTINCT` probado sobre el caso NULL. La pregunta que lo
resume: *si esta decisión falla, ¿alguien se entera?* Si la respuesta es no,
elegiste el lado equivocado.

### Toda prueba de un invariante crítico necesita una variante que la rompa

**Una prueba que nunca ha fallado no se sabe si detecta algo.** Es el mismo
principio que la regla `no-unresolvable` en el gate de fronteras (ADR-0021): un
control que existe **para desconfiar del control principal**. Allí fue lo único
que delató que `dependency-cruiser` daba verde sin resolver un solo import.

Así que junto a la prueba va su negativo: una forma de correrla contra un
esquema o una consulta **rota a propósito**, que debe fallar. Si no falla, el
verde de la prueba buena no vale nada.

```bash
pnpm test:concurrency            # el pickup real: debe pasar
pnpm test:concurrency:selftest   # el pickup SIN skip locked: debe fallar
```

En pgTAP el equivalente es barato: quita el constraint dentro de la transacción
de prueba, comprueba que el caso malo pasa, y restitúyelo.

```sql
-- El invariante protege
select throws_ok($$ insert … duplicado … $$, '23505', null, 'el único rechaza');

-- Y sin él, no. Si esto NO deja pasar el duplicado, el test de arriba estaba
-- pasando por otro motivo y no comprueba lo que dice.
alter table public.x drop constraint x_unico;
select lives_ok($$ insert … duplicado … $$,
  'sin el constraint el duplicado entra: el test de arriba mide el constraint');
```

**El corolario, que es donde está el valor de verdad:** cuando la variante rota
falla, **mira QUÉ la detectó**. Puede no ser lo que creías.

En S0.4, `--roto` quitó el `FOR UPDATE SKIP LOCKED` del outbox y la carrera
apareció — pero no la cazaron las cinco invariantes de la prueba, sino un `CHECK`
del esquema escrito como simple higiene de coherencia. Es decir: **la defensa
real estaba en otro sitio del que yo creía, y nadie la estaba protegiendo**.
Quitar ese `CHECK` en una migración futura habría parecido una limpieza inocua.

Cuando eso pasa, se anota en el esquema. El comentario del constraint dice ahora
que es un detector de carrera activo y qué se desarma al quitarlo.

```bash
supabase test db
```

## 5. Aplicar

Local: `pnpm db:reset`.
Remoto: **nunca desde la sesión.** Se propone el comando y lo ejecuta el usuario.

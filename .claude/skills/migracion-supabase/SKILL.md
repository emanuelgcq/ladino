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

```bash
supabase test db
```

## 5. Aplicar

Local: `pnpm db:reset`.
Remoto: **nunca desde la sesión.** Se propone el comando y lo ejecuta el usuario.

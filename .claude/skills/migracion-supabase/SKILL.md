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
  using (company_id = any (auth.ladino_company_ids()));

create policy "<tabla>_insert" on public.<tabla> for insert
  with check (company_id = any (auth.ladino_company_ids())
              and auth.ladino_has_permission('<recurso>.create', company_id));

create policy "<tabla>_update" on public.<tabla> for update
  using (company_id = any (auth.ladino_company_ids())
         and auth.ladino_has_permission('<recurso>.update', company_id)
         and status = 'draft');
```

## 3. Si la tabla es append-only

Además de no crear policies de update/delete, añade el trigger defensivo:

```sql
create trigger <tabla>_immutable
  before update or delete on public.<tabla>
  for each row execute function public.reject_mutation();
```

## 4. Test pgTAP obligatorio

`supabase/tests/<NN>_<tabla>_test.sql` debe probar como mínimo:
- un usuario de la empresa A **no ve** filas de la empresa B;
- un insert con `company_id` ajeno falla;
- si es append-only, un update lanza excepción;
- cada CHECK constraint rechaza el valor inválido.

```bash
supabase test db
```

## 5. Aplicar

Local: `pnpm db:reset`.
Remoto: **nunca desde la sesión.** Se propone el comando y lo ejecuta el usuario.

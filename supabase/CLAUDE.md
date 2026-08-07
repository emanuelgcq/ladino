# supabase

Postgres gestionado (Supabase cloud) como system of record de Ladino.

## Migraciones

- `supabase/migrations/YYYYMMDDHHMM_verbo_objeto.sql`. Crear con `pnpm db:new`.
- **Una migración aplicada nunca se edita.** Un hook lo bloquea. Se corrige con otra migración.
- Compatibilidad expand/contract: la migración debe funcionar con la versión de app saliente
  y la entrante, porque migración y deploy no son atómicos.
- Cada migración declara en comentario: módulo, spec, reversibilidad, impacto de homologación.

## RLS

Toda tabla del esquema `public`: `enable row level security` **y** `force row level security`.
Policies separadas por operación. Nunca `for all`.
El alcance se resuelve con funciones (`auth.ladino_company_ids()`,
`auth.ladino_has_permission()`) apoyadas en `memberships`, no en claims estáticos de larga vida.

Una tabla sin RLS es una fuga de datos entre clientes. No hay excepciones "temporales".

## Funciones y Edge Functions

- SQL functions/RPC **solo** cuando aporten atomicidad real y sean testeables y versionadas.
- Edge Functions para integraciones ligeras. La lógica fiscal principal **no** vive aquí:
  vive en el servicio versionado y controlable de `packages/fiscal`.

## Realtime

Solo para UX no crítica: dashboards, notificaciones, estados de jobs.
**Nunca** como garantía de consistencia.

## Tests

`supabase/tests/*.sql` con pgTAP. Toda migración trae su test de aislamiento entre tenants.
`supabase test db` corre en CI y es bloqueante.

## Backups

No se depende solo del backup del proveedor. Dump lógico cifrado externo + restore probado.

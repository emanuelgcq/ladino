# Diseño Supabase — Ladino

Supabase **gestionado** (cloud) como system of record (ADR-0002). No self-hosted en el VPS:
la base de un ERP fiscal no comparte host con automatizaciones.

## Qué se usa y qué no

| Servicio | Uso en Ladino |
|---|---|
| Postgres | System of record. Todo. |
| Auth | Autenticación e MFA. El **alcance de permisos no** sale del JWT (ADR-0014). |
| Storage | Soportes, adjuntos, exportaciones. Con RLS por company. |
| Realtime | Solo UX no crítica: dashboards, notificaciones, estado de jobs. **Nunca** como garantía de consistencia. |
| Edge Functions | Integraciones ligeras y webhooks. **Nunca** el core fiscal, que vive en `packages/fiscal`. |

## RLS — el aislamiento es la característica de seguridad principal

Toda tabla de `public`:

```sql
alter table public.X enable row level security;
alter table public.X force row level security;   -- ni el owner escapa
```

Policies **separadas por operación**. Nunca `for all`. El alcance se resuelve con funciones
`stable` sobre `memberships`:

```sql
auth.ladino_tenant_ids()                          -- uuid[]
auth.ladino_company_ids()                         -- uuid[]
auth.ladino_has_permission(perm text, company uuid) -- boolean
```

Se leen de la base, no de claims estáticos de larga vida: quitar un membership revoca el acceso
en la siguiente consulta, sin esperar a que expire un token.

Una tabla sin RLS es una fuga de datos entre clientes. No existen excepciones temporales.
El subagente `rls-security-auditor` cruza `pg_tables` con `pg_policies` y reporta cualquier hueco.

## Append-only — defensa en dos capas (ADR-0006)

Para `journal_entries`, `journal_lines`, `fiscal_events`, `fiscal_documents`, `inventory_moves`,
`audit_events`, `payment_ledger`:

1. Sin policies de `update`/`delete`.
2. Trigger `BEFORE UPDATE OR DELETE` que lanza excepción, efectivo también para `service_role`.

## Funciones y RPC

SQL functions o RPC **solo** cuando aporten atomicidad real y sean testeables y versionadas.
La lógica de negocio vive en TypeScript, donde se prueba con property-based testing.
Un RPC que "es más rápido" pero no se puede probar no compensa.

## Migraciones

- `supabase/migrations/YYYYMMDDHHMM_verbo_objeto.sql`. Crear con `pnpm db:new`.
- **Una migración aplicada nunca se edita.** Un hook de Claude Code lo bloquea.
- Expand/contract obligatorio (ADR-0019): migración y deploy no son atómicos, y la app móvil
  convive con el esquema durante semanas.
- Cabecera obligatoria en cada archivo: módulo, spec de referencia, reversibilidad,
  `HOMOLOGATION_IMPACT`.
- Toda migración trae su test pgTAP en `supabase/tests/`.

## service_role

Solo en `apps/api`, `apps/worker` y `ladino-fiscal`, desde variables de entorno del host.
Jamás en un bundle web o Expo. Un hook bloquea cualquier aparición en código de cliente.
Recuerda que todo `EXPO_PUBLIC_*` es público por definición.

## Storage

Buckets privados por defecto. Rutas con prefijo `company_id/`. Acceso por URL firmada de
vigencia corta. Límite de tamaño por subida. Nunca un bucket público para soportes fiscales.

## MCP

El servidor MCP de Supabase se configura **read-only** en `.mcp.json` (ADR-0002).
Claude Code puede inspeccionar el esquema y consultar, no mutar la base remota.
Las escrituras se hacen por migración revisada, no por conversación.

## Backups

No se depende solo del proveedor: dump lógico cifrado externo, export de fiscal y audit,
copia offsite, restore probado trimestralmente y simulación completa antes de homologación.
Ver `05_INFRA/BACKUP_AND_DISASTER_RECOVERY.md`.

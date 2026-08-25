# Multitenancy y RBAC

## Jerarquía
tenant → company → branch → warehouse/register.

## Claims
JWT mínimo:
- user_id
- tenant memberships
No confiar en claims estáticos para permisos críticos de larga vida; consultar policy cache/DB.

## Tablas
`memberships`, `roles`, `permissions`, `role_permissions`, `user_role_assignments`, `scope_bindings`.

## RLS
Toda tabla tenant-owned:
```sql
tenant_id uuid not null
company_id uuid null
```

RLS valida membership y scope. **La API y el worker NO usan `service_role` ni `postgres`**
(ADR-0031, desde la migración 14): se conectan como `ladino_api` y `ladino_worker`, roles sin
`BYPASSRLS`. `ladino_api` tiene policies propias por **tenant del actor** (el GUC
`ladino.actor_id`, leído solo por las funciones de servicio (`platform.ladino_service_actor_id()`)): un `where` olvidado en un caso de uso
no cruza tenants. `ladino_worker` solo tiene GRANT sobre `outbox` e `idempotency_keys`.
`service_role` queda para operaciones de plataforma que aún no existen (ADR-0030) — y cada una
será una decisión.

## Permisos
Formato: `resource.action`, ej:
- `invoice.issue`
- `journal.post`
- `period.close`
- `supplier.bank_account.approve`
- `fiscal.audit.read`

## Segregación
Configurable SoD:
- creador de pago != aprobador;
- creador proveedor != aprobador cuenta bancaria;
- cajero != cierre supervisor.

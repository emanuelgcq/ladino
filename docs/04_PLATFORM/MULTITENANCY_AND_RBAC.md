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

RLS valida membership y scope. `service_role` solo backend/worker seguro.

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

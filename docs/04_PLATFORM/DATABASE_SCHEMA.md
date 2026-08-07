# Esquema de base de datos

## Dominios principales

```mermaid
erDiagram
  TENANT ||--o{ COMPANY : owns
  COMPANY ||--o{ BRANCH : has
  BRANCH ||--o{ WAREHOUSE : has
  COMPANY ||--o{ CUSTOMER : has
  COMPANY ||--o{ SUPPLIER : has
  COMPANY ||--o{ PRODUCT : has
  CUSTOMER ||--o{ INVOICE : receives
  INVOICE ||--|{ INVOICE_LINE : contains
  INVOICE ||--o| JOURNAL_ENTRY : posts
  JOURNAL_ENTRY ||--|{ JOURNAL_LINE : contains
  ACCOUNT ||--o{ JOURNAL_LINE : receives
  PRODUCT ||--o{ INVENTORY_MOVE : moves
  WAREHOUSE ||--o{ INVENTORY_MOVE : contains
  SUPPLIER ||--o{ SUPPLIER_INVOICE : issues
  SUPPLIER_INVOICE ||--o| JOURNAL_ENTRY : posts
  INVOICE ||--o{ FISCAL_EVENT : emits
```

## Convenciones
- `id uuid`.
- `tenant_id`.
- `company_id`.
- `created_at timestamptz`.
- `created_by`.
- `version bigint` para optimistic concurrency donde corresponda.
- `numeric(24,8)`.

## Tablas append-only
- journal_lines una vez posted;
- inventory_moves;
- fiscal_events;
- audit_events;
- payment_ledger.

## Particionado futuro
Por `company_id`/fecha en eventos de alto volumen si métricas lo justifican.

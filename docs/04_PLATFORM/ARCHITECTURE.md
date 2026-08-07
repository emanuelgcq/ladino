# Arquitectura

```mermaid
flowchart TB
  WEB[React Webapp]
  MOB[Expo App]
  API[API / Domain Services]
  FISC[Fiscal Service]
  ACC[Accounting Service/Module]
  WORK[Worker / Outbox]
  DB[(Supabase Postgres)]
  AUTH[Supabase Auth]
  STORE[Supabase Storage]
  PRINT[Imprenta Digital]
  SEN[SENIAT Interface]
  CLAUDE[Claude]
  OBS[Observability]

  WEB --> API
  MOB --> API
  API --> AUTH
  API --> DB
  API --> ACC
  API --> FISC
  API --> STORE
  API --> WORK
  FISC --> PRINT
  FISC --> SEN
  WORK --> CLAUDE
  API --> OBS
  FISC --> OBS
```

## Estilo
Modular monolith inicial con fronteras estrictas; extraer `fiscal`/`worker` como servicios cuando convenga.

## Por qué no microservicios completos desde día 1
La consistencia contable/inventario requiere transacciones coordinadas. Un modular monolith reduce complejidad y deja bounded contexts claros.

## Fiscal service
Debe tener:
- contrato versionado;
- release id;
- migrations compatibles;
- adapters;
- audit;
- feature flag de versión homologada.

# Estándares de ingeniería — Ladino

Las decisiones y su justificación están en `adr/`. Aquí solo está la regla operativa.

## Lenguaje y tooling

- TypeScript `strict` en todo el monorepo. `noUncheckedIndexedAccess` y
  `exactOptionalPropertyTypes` activados.
- Node 22 LTS. **Solo pnpm**: un lockfile, `packageManager` fijado, `engine-strict=true`.
  Mezclar gestores de paquetes está prohibido.
- ESLint + Prettier. Reglas de frontera de import verificadas en CI: `apps/web` y `apps/mobile`
  no pueden importar de `packages/fiscal` ni de `packages/accounting`.
- Sin `any` sin comentario que justifique por qué. Sin `@ts-ignore`; si hace falta, `@ts-expect-error`
  con explicación.

## Dinero (ADR-0013)

- Postgres `numeric(24,8)` para todo monto y toda tasa. Nunca `float`, `real`,
  `double precision` ni `money`.
- TypeScript: `Decimal` de `packages/money`. El tipo `number` **no aparece** en ninguna firma
  monetaria. `parseFloat` y `toFixed` están prohibidos en cálculo financiero.
- JSON: los montos viajan como **string**. `"1234.56000000"`, no `1234.56`.
- Redondeo explícito y nombrado por contexto. No existe redondeo implícito por defecto.
- Se conservan valores pre-redondeo donde la auditoría los necesite.

Un hook de Claude Code bloquea las violaciones de esta sección.

## Multimoneda (ADR-0020)

Siete campos por importe: `amount_transaction_currency`, `transaction_currency`, `fx_rate`,
`functional_amount`, `functional_currency`, `rate_source`, `rate_timestamp`.
Una conversión sin `source` y `timestamp` no se persiste.

## Fechas

- `timestamptz` en UTC para eventos.
- Fecha fiscal/contable como `date` separado y explícito. No se derivan una de otra.
- Zona horaria de la empresa versionada, porque el día fiscal no es el día UTC.
- Nada de `Date.now()` dentro de lógica de dominio: el reloj se inyecta.

## Identificadores

- UUID v7 (ordenable por tiempo) para entidades.
- Los números de documento fiscal usan secuencias propias, asignadas transaccionalmente
  en el momento de la emisión, sin huecos ni reutilización. Nunca un UUID como número fiscal.

## Transacciones

Todo posting contable, emisión fiscal, movimiento de inventario y pago es ACID y sigue el
patrón de 10 pasos de la skill `caso-de-uso`. Si dos escrituras pueden divergir, es un bug.

## Idempotencia (ADR-0018)

`Idempotency-Key` obligatorio en emisión, pagos, cobros, posting, reintentos fiscales y nómina.
Se persiste dentro de la misma transacción del caso de uso.

## Eventos (ADR-0005)

Transactional outbox. Consumidores idempotentes, backoff con jitter, DLQ con alerta.

## SQL

- FK reales, `on delete restrict` por defecto.
- `CHECK` para todo estado enumerado. Los estados viven en el esquema, no solo en TypeScript.
- Índices mínimos: `(tenant_id, company_id)`, `(company_id, fecha desc)`, `(company_id, status)`.
- RLS habilitada **y forzada** en toda tabla de `public`. Policies separadas por operación.
- Sin soft-delete en fiscal ni contable: estados y reversiones.
- Migraciones expand/contract (ADR-0019). Una migración aplicada nunca se edita.

## Estructura del código

- Dominio puro separado de UI y de I/O. Los paquetes `money`, `accounting` y `fiscal` no
  importan nada de red ni de base de datos.
- Errores de dominio como valores (`Result<T, DomainError>`), no como excepciones de control
  de flujo. Los códigos de error son estables y forman parte del contrato.
- Adaptadores externos (imprenta, bancos, mensajería) detrás de interfaces.
- Cero lógica tributaria en componentes React o pantallas Expo.
- La UI nunca persiste estado final de dinero, stock o documentos.

## Pruebas (ADR-0016)

- En `money`, `accounting` y `fiscal`: **el test se escribe antes que la implementación**.
- Property-based con fast-check para invariantes contables.
- pgTAP obligatorio por migración: aislamiento entre tenants y rechazo de mutación en append-only.
- La métrica no es cobertura: es que cada invariante documentado tenga un test que lo falsaría.

## Pull requests

- `pnpm verify` en verde. Sin excepciones "lo arreglo después".
- Migración con nota de reversibilidad.
- Checklist de seguridad y `DEFINITION_OF_DONE.md` recorrido.
- `HOMOLOGATION_IMPACT` declarado siempre.
- Revisión de dominio para posting; revisión fiscal si altera documento o impuesto.

## Logging

JSON estructurado con `request_id`, `tenant_id`, `company_id`, `user_id`, `use_case`,
`entity_id`, `duration`, `result`. Nunca secretos, nunca el payload fiscal completo,
nunca datos personales innecesarios.

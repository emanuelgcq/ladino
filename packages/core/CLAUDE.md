# packages/core

El kernel del monorepo. **Cero dependencias: ni `decimal.js`, ni `zod`, ni nada.**

Existe para que `money` no acabe siendo el kernel por accidente. Si `Result` viviera en el
paquete de dinero, el día que `fiscal` importara su tipo de error desde `@ladino/money` la
frontera estaría rota sin que ningún gate lo notara (ADR-0021).

## Contenido — y nada más

| Export | Qué es |
|---|---|
| `Result<T, E>`, `ok`, `err`, `isOk`, `isErr`, … | errores como valores (`ENGINEERING_STANDARDS.md` §Estructura) |
| `DomainError` | `{ code: string; message: string; details?: ... }`. Los códigos son estables y forman parte del contrato |
| `Brand<T, B>` | tipos nominales sobre primitivos |
| `Instant` | timestamp ISO-8601 UTC como string marcado. **No `Date`**: `Date` es mutable y depende de zona horaria |

## Regla de admisión

Algo entra en `core` solo si lo necesitan **al menos dos paquetes que no pueden importarse
entre sí**. En cuanto se le añada una dependencia externa o una regla de negocio, deja de ser
el kernel y el propósito se pierde.

Nada de: dinero, fechas de calendario, validación, I/O, logging, configuración.

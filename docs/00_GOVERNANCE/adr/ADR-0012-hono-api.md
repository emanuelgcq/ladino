# ADR-0012 — API con Hono sobre Node 22

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** NO

## Contexto
Se necesita un framework HTTP delgado, tipado, con buena integración Zod/OpenAPI y sin opinión
sobre la capa de datos, porque la lógica vive en los paquetes de dominio.

## Decisión
Hono. Rutas tipadas, middleware explícito para auth, autorización, idempotencia, request-id
y logging estructurado. OpenAPI generado desde los mismos Zod.

## Consecuencias
- (+) Superficie mínima y arranque rápido, importante en un VPS compartido.
- (+) Portable a otros runtimes si algún día conviene.
- (−) Ecosistema de middleware menor que Express: algunas piezas se escriben en casa.
  Aceptable, porque las piezas críticas (idempotencia, autorización) se querían propias igualmente.

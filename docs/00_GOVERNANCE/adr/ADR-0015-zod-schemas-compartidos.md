# ADR-0015 — Zod como única definición de esquemas compartidos

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** NO

## Decisión
`packages/schemas` define entidades, DTOs y errores en Zod. De ahí salen: tipos TypeScript,
validación en runtime en la API, OpenAPI, cliente tipado y validación de formularios en web y mobile.

Los montos se declaran con un tipo de marca (`DecimalString`) que valida el formato y **no**
es asignable a `number`.

## Consecuencias
- (+) Una sola definición, imposible de desincronizar entre las cuatro capas.
- (−) Los esquemas se vuelven un punto caliente del monorepo: cambiarlos rompe muchos paquetes
  a la vez. Eso es exactamente lo que se busca; el fallo aparece en compilación, no en producción.

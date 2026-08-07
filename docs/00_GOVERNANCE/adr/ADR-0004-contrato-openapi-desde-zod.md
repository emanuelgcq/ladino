# ADR-0004 — Contrato REST/OpenAPI generado desde Zod

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** NO

## Contexto
Tres consumidores (web, mobile, integraciones de terceros) y un backend. El contrato se
desincroniza en cuanto se escribe a mano.

## Opciones
1. OpenAPI escrito a mano — se desincroniza en la segunda semana.
2. tRPC — excelente en TypeScript, malo para integradores externos y para clientes móviles antiguos.
3. **Zod como fuente única → OpenAPI generado.**

## Decisión
Los esquemas Zod de `packages/schemas` son la fuente de verdad. `openapi.json` se genera en CI
y **el build falla si el archivo generado difiere del commiteado**. El cliente tipado de
`packages/api-client` se genera del mismo esquema.

## Consecuencias
- (+) Imposible que el contrato mienta.
- (+) Validación en runtime y tipos en compile-time del mismo objeto.
- (−) Los tipos de dinero requieren cuidado: se declaran `string` con `format: decimal`.

## Verificación
Job `openapi:check` bloqueante en CI.

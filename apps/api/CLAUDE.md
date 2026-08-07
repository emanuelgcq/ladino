# apps/api

API REST de Ladino. Hono sobre Node 22. Contrato OpenAPI generado desde los Zod de
`packages/schemas`.

## Esta capa es delgada

Un handler hace exactamente esto y nada más:

```
autenticar → autorizar (resource.action) → validar input (Zod)
→ delegar a un caso de uso de packages/domain → mapear a respuesta HTTP
```

**Cero reglas de negocio aquí.** Si estás calculando un impuesto o armando un asiento en
un handler, está en el paquete equivocado.

## Obligatorio en cada endpoint mutante

- `Idempotency-Key` requerido y honrado.
- Headers: `Authorization`, `X-Company-Id`, `X-Request-Id`.
- Errores en el formato de `docs/04_PLATFORM/API_SPEC.md`, con `code` estable en SCREAMING_SNAKE.
- Permiso verificado en **servidor**. Que la UI oculte el botón no es control de acceso.
- Log estructurado con `request_id`, `tenant_id`, `company_id`, `user_id`, `use_case`, `duration`.

## Versionado

Path `/v1`. La versión del protocolo fiscal va en el payload, no en el path.
No se rompe un cliente móvil antiguo sin ventana de compatibilidad (N y N-1).

## Serialización de dinero

Los montos viajan como **string decimal**, nunca como número JSON. `"1234.56000000"`.
Documéntalo en el OpenAPI con `format: decimal`.

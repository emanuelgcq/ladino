# API — Ladino

REST JSON bajo `/v1`. Hono sobre Node 22 (ADR-0012). Contrato OpenAPI generado desde los
esquemas Zod de `packages/schemas` (ADR-0004): el build falla si `openapi.json` difiere del
generado.

## La capa es delgada

```
autenticar → autorizar (resource.action) → validar (Zod) → delegar a un caso de uso → mapear a HTTP
```

Cero reglas de negocio en los handlers. Si estás calculando un impuesto en un endpoint,
está en el paquete equivocado.

## Headers

| Header | Uso |
|---|---|
| `Authorization: Bearer` | token del usuario |
| `Idempotency-Key` | obligatorio en todo endpoint mutante crítico |
| `X-Company-Id` | empresa en contexto; validada contra el alcance del usuario |
| `X-Request-Id` | correlación de trazas y logs |

## Dinero en el contrato

Los montos viajan como **string decimal**: `"1234.56000000"`. Nunca como número JSON.
En OpenAPI se declaran `type: string, format: decimal`. Un cliente que haga
`JSON.parse` y opere con el resultado como número está introduciendo un error de redondeo.

## Errores

```json
{
  "error": {
    "code": "FISCAL_DOCUMENT_IMMUTABLE",
    "message": "El documento emitido no puede modificarse.",
    "details": {},
    "request_id": "..."
  }
}
```

`code` es estable y forma parte del contrato: los clientes ramifican sobre él, no sobre `message`.
`message` está en español y es apto para mostrar al usuario final.

## Idempotencia (ADR-0018)

Obligatoria en: emisión de factura, pagos, cobros, posting de asientos, reintentos fiscales
y posting de nómina.

- Misma clave, mismo cuerpo → devuelve la respuesta original, sin repetir el efecto.
- Misma clave, cuerpo distinto → `409 IDEMPOTENCY_KEY_REUSED`.
- La clave se persiste **dentro** de la transacción del caso de uso.

## Versionado

- Versión de API en el path (`/v1`).
- `fiscal_protocol_version` dentro del payload, no en el path: el tren fiscal es independiente.
- No se rompe un cliente móvil antiguo sin ventana de compatibilidad. Soporte N y N-1.
- Si un build deja de ser compatible con el protocolo fiscal, se fuerza actualización.

## Endpoints principales

`/companies` `/customers` `/suppliers` `/products` `/inventory` `/sales-orders` `/invoices`
`/purchase-orders` `/supplier-invoices` `/payments` `/banks` `/accounting` `/tax` `/fiscal`
`/reports` `/audit`

## Observabilidad

Cada request emite log estructurado con `request_id`, `tenant_id`, `company_id`, `user_id`,
`use_case`, `duration`, `result`. Trazas OTel. Nunca el payload fiscal completo en el log.

## Rate limiting

En rutas caras y autenticadas la clave de rate limit es el `user_id`, **no la IP**:
la IP se falsifica y además penaliza a oficinas completas tras un NAT.

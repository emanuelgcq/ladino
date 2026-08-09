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

**Todo valor monetario viaja como objeto `{ amount, currency }`. Nunca como string escalar,
nunca como número JSON.**

```json
{ "amount": "1234.56000000", "currency": "VES" }
```

- `amount`: string decimal canónico, **siempre 8 decimales**, notación plana, sin separador de
  miles, sin exponente. En OpenAPI: `type: string, format: decimal`, `pattern` de 8 decimales.
- `currency`: código ISO-4217. **Obligatorio en cada importe**, aunque el documento ya declare
  una moneda en la cabecera.

La redundancia es deliberada. Una moneda implícita, heredada de un campo hermano o del
encabezado del documento, es exactamente la suposición que produce una factura emitida en la
moneda equivocada. Es más verboso y es el precio correcto.

Un cliente que haga `JSON.parse` y opere con `amount` como número está introduciendo un error
de redondeo. Los clientes deben pasar el objeto a `@ladino/money/format` para presentarlo y
enviarlo de vuelta sin tocarlo.

El string escalar de 8 decimales (`toAmountString()`) existe **solo** para persistencia y para
los tests de paridad con `numeric(24,8)`. No es una forma válida del contrato de la API.

**La única serialización de un importe es su `toJSON()`.** Nunca `{ ...money }` ni
`Object.entries`: el spread se salta la forma canónica y produce `"1.005"` en lugar de
`"1.00500000"` — un valor válido mal formado, indistinguible de uno correcto para el receptor.
En `packages/money` está cerrado por construcción (ADR-0023), pero la regla aplica a cualquier
DTO que envuelva un importe.

Un `ExactMoney` **no se serializa en absoluto**: es un intermedio de cálculo y hay que redondearlo
con una política nombrada antes de que pueda salir en una respuesta.

En un documento multimoneda, un importe convertido añade los campos de trazabilidad de
ADR-0020 junto al par: `fx_rate`, `rate_source`, `rate_timestamp`, más el par funcional.

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

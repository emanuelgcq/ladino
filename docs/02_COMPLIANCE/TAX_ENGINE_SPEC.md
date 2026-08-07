# Motor tributario

## Objetivo
Resolver impuestos de forma determinista, versionada y auditable.

## Modelo
`tax_rules`
- jurisdiction
- tax_code
- taxpayer_type
- transaction_type
- product_tax_category
- rate
- formula
- effective_from/to
- legal_source
- priority
- version
- status

## Evaluación
Input:
- empresa;
- contraparte;
- fecha;
- documento;
- líneas;
- moneda;
- categorías tributarias.

Output:
- base;
- tasa;
- monto;
- exento/exonerado/no sujeto;
- reglas aplicadas;
- versión;
- explicación machine-readable.

## Reglas
- No usar Claude para determinar impuesto.
- No hard-codear tasas en UI.
- Toda regla debe tener vigencia.
- Una factura emitida conserva regla/tasa original aunque luego cambie normativa.
- Simulación y emisión usan el mismo motor.

## API conceptual
`POST /v1/tax/calculate`
`POST /v1/tax/explain`
`GET /v1/tax/rules?effective_on=...`

## Criterio
Golden tests por norma y fechas frontera.

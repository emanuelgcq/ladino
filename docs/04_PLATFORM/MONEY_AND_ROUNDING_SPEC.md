# Dinero y redondeo

## Representación
Decimal exacto.

## Campos
- amount_transaction_currency
- transaction_currency
- fx_rate
- functional_amount
- functional_currency
- rate_source
- rate_timestamp

## Redondeo
Regla explícita por:
- moneda;
- impuesto;
- documento;
- pago.

Guardar valores pre-round donde sea útil para auditoría.

## Tests
0.1+0.2 nunca depende de IEEE float.

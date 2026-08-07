# Precios y multimoneda


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Administrar listas de precios, tasas y conversiones sin perder moneda original.

## Entidades
- `price_lists`
- `price_list_items`
- `exchange_rates`
- `discount_policies`

## Reglas de negocio
- Guardar moneda transaccional y funcional.
- Tasa tiene fuente/fecha/hora.
- Factura congela tasa.
- Descuento fuera de política requiere autorización.
- No recalcular histórico al cambiar tasa.

## Estados / transiciones
price list: draft → active → archived. rate: imported/approved.

## Permisos
- admin precios.
- vendedor aplica solo descuento permitido.
- tesorería aprueba tasa manual.

## API / eventos
- `GET /v1/prices/resolve`
- `POST /v1/exchange-rates`
- `pricing.discount_overridden`

## Criterios de aceptación
- [ ] Misma transacción reproduce total original.
- [ ] Redondeo explícito.
- [ ] Tasa faltante bloquea operación que la requiera.

## Casos límite
- tasa cambia durante checkout.
- pago en varias monedas.
- vuelto en moneda distinta.

## Dependencias
- Money package
- Accounting
- POS

# Retenciones

## Alcance
- IVA.
- ISLR.
- otros conceptos configurables.

## Modelo
- agente/sujeto;
- documento base;
- periodo;
- base;
- porcentaje/regla;
- monto;
- comprobante;
- fecha;
- estado.

## Comprobante digital
PA SNAT/2025/000054 art. 16: el comprobante lleva número `AAAAMM` + 8 dígitos (14 en total), con los datos del agente, del proveedor, de la factura (número y control) y los montos (total, base, IVA causado, IVA retenido). Se entrega dentro de los 2 primeros días hábiles del período siguiente. Puede ser uno por operación o uno por período y proveedor. Agente y proveedor lo registran en el período de emisión. La máscara se genera y valida con un generador versionado.

## Estados
draft → calculated → issued → applied → reported.

## Oportunidad: cuándo se practica (PA SNAT/2025/000054)

La retención se practica **al pago o al abono en cuenta, lo que ocurra primero**. En Ladino,
**registrar la factura del proveedor como cuenta por pagar ES el abono en cuenta**, de modo que:

- la retención se **calcula** al registrar la factura, con la regla vigente ese día (ADR-0039), y
  queda congelada con su norma copiada;
- su **pasivo con el fisco** nace en ese mismo acto: el asiento de la factura acredita
  `retention_iva_payable` / `retention_islr_payable` y acredita al proveedor el **neto**
  (ADR-0065 §3, migración 68);
- el **saldo del auxiliar** de proveedores descuenta lo retenido: al proveedor se le debe el
  neto, y lo retenido se le debe al fisco;
- el **pago** cancela ese neto y **no retiene nada**: la retención ya está practicada.

El **comprobante** se emite y numera **al practicar la retención**, es decir, en el abono en cuenta
(al registrar la factura, criterio R-3), y se entrega dentro de los 2 días hábiles del período
siguiente (P-26, cerrada el 2026-09-28; H-04). Hoy se emite al pagar, con el permiso
`retention.receipt.issue`; eso cambia en H-04.

## Reglas
- evitar doble retención sobre misma base/documento/concepto;
- conservar versión de regla;
- reversión mediante documento/proceso permitido, no delete.

## Fuentes normativas (verificadas 2026-09-12)

- **PA SNAT/2025/000054** — agentes de retención de IVA. Vigente desde el 01/08/2025; deroga la
  PA SNAT/2015/0049. Mantiene el 75 % general y el 100 % para los supuestos listados. Es la
  `legal_source` que debe citar toda regla `iva` cargada en `retention_rules`.
- **ISLR**: Decreto 1.808 (reglamento parcial de retenciones) y sus tablas; **VALIDAR-TRIBUTARIO**
  cada concepto y sustraendo antes de cargarlo.
- El catálogo **nace vacío** (ADR-0039) y cada regla es **de la empresa que la carga**
  (ADR-0057): una empresa no retiene con la regla de otra.
- Fuente secundaria consultada: Forvis Mazars, «Providencia agentes de retención del IVA»
  (08/2025). Texto primario en Gaceta pendiente de archivar en `EXPEDIENTE_TECNICO.md`.

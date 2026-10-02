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

## Retenciones que nos practicaron (clientes) — ADR-0072 §5 (F-01, F-09, F-11)

Nombres (L-12): «Retenciones que practicamos (a proveedores)» son las nuestras como agente;
«Retenciones que nos practicaron (clientes)» son los comprobantes que un cliente-agente nos entrega.

- Se cargan en Bs contra la factura (o ND), con número de **14 dígitos** (AAAAMM + 8, PA
  SNAT/2025/000054) **único por cliente y factura** (`srr_unique_receipt_per_document`: un
  comprobante quincenal cubre varias facturas, art. 16; la porción se valida factura por
  factura); el prefijo AAAAMM es un año y un mes válidos. Las porciones admisibles (75 %, 100 %)
  salen del catálogo `iva_retention_portions` (PA 000054 arts. 4-5, vigencia desde 01-08-2025),
  vigente a `retained_on`. **VALIDAR-SENIAT:** los arts. 4 y 5 vienen de una reproducción no oficial
  (`source_status = fuente_secundaria`); la vigencia sí tiene fuente (ADR-0065, REGULATORY_STATUS).
  Con un IVA de Bs 0,02 o menos, manda la porción que dice el comprobante si cabe en la tolerancia.
  El prefijo AAAAMM se valida también en la base (`srr_receipt_period_prefix_chk`, NOT VALID: se
  evalúa en todo UPDATE). (CHECK `srr_receipt_14_digits_chk`,
  NOT VALID: no se validó sobre las filas existentes al crearlo, **pero se evalúa en TODO INSERT y en
  TODO UPDATE de cualquier fila**. Trampa para la reversa de la ola 3: anular un comprobante viejo con
  otro formato de número dará 23514 si su migración no lo resuelve).
- El monto es el **75 % o el 100 % del IVA en Bs de la factura** (± Bs 0,01); si no, 422 legible
  con las dos cifras esperadas. La porción indicada debe coincidir.
- Abona la CxC **a la tasa de la factura**, sin diferencial (`ar_valuation = invoice_rate`;
  `platform.document_balance_transaction` la salda a `documents.fx_rate`). La alternativa —la tasa
  del día del comprobante— es el parámetro `company_settings.retention_received_voucher_rate`,
  apagado (P-30, VALIDAR-TRIBUTARIO). Los comprobantes cargados antes quedan `voucher_rate`.
- Permisos: `ar.retention.register` (dueño, administrativo, cajero: quien cobra, §2.6; el encargado
  no cobra, §2.8 — migración 20260928190600) para cargar;
  `ar.retention.correct` (contador, dueño) para corregir. **La reversa NO está construida**: ver
  RISK_REGISTER R-61 (decisión pendiente del dueño).

## Fuentes normativas (verificadas 2026-09-12)

- **PA SNAT/2022/000013** (G.O. 42.339, 17-03-2022) — los sujetos pasivos especiales como agentes
  de percepción del IGTF (ver IGTF_SPEC.md). Se cita aquí porque el tipo `especial`, con su fecha
  de notificación y su vigencia (ADR-0072 §1), decide a la vez la retención y la percepción.

- **PA SNAT/2025/000054** — agentes de retención de IVA. Vigente desde el 01/08/2025; deroga la
  PA SNAT/2015/0049. Mantiene el 75 % general y el 100 % para los supuestos listados. Es la
  `legal_source` que debe citar toda regla `iva` cargada en `retention_rules`.
- **ISLR**: Decreto 1.808 (reglamento parcial de retenciones) y sus tablas; **VALIDAR-TRIBUTARIO**
  cada concepto y sustraendo antes de cargarlo.
- El catálogo **nace vacío** (ADR-0039) y cada regla es **de la empresa que la carga**
  (ADR-0057): una empresa no retiene con la regla de otra.
- Fuente secundaria consultada: Forvis Mazars, «Providencia agentes de retención del IVA»
  (08/2025). Texto primario en Gaceta pendiente de archivar en `EXPEDIENTE_TECNICO.md`.

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
siguiente (P-26, cerrada el 2026-09-28; H-04).

## Retención de IVA que practicamos — ADR-0072 §3, §4 y §6 (H-01, H-04, H-12, L-03; 2026-10-02)

Migraciones 20261002110000 y 20261002110100. Contrato de la API 0.2.0.

- **Se practica sola.** La empresa es agente si es `especial` en la fecha de la factura
  (`tipoVigente` / `platform.taxpayer_type_at`). Al registrar la factura de un proveedor nacional
  con factura, por cualquier camino (`POST /v1/supplier-invoices`, «Ya llegó la factura», la
  llegada de mercancía), el servidor practica `iva_compras` (75 %) o, con
  `iva_retention_full_reason` (art. 5: IVA no discriminado, factura sin requisitos, indicado por el
  portal, proveedor no inscrito), `iva_compras_total` (100 %). Los porcentajes son filas de
  `retention_rules`: sin regla vigente, `RETENTION_RULE_MISSING` (409) y la factura no existe.
  `retention_concepts` sigue valiendo para los demás conceptos (N-1); si ya pide uno de IVA, no se
  añade otro.
- **Quién se retiene.** Proveedor `ordinario`, `especial` o **sin tipo declarado** (se presume
  contribuyente: el error caro es no retener, COT arts. 27 y 115). Al `formal` no (art. 3 num. 2,
  automática). Una factura sin IVA no retiene (exentas, exoneradas o no sujetas, automática). Otros
  tipos (`no_contribuyente`, `no_sujeto`…) exigen decir el 100 % o una exclusión: 422.
- **Auditoría fiscal de la segunda ronda (migración 20261002110300).** La empresa es agente según su
  tipo el día del REGISTRO (P-72). Al proveedor no contribuyente o no sujeto solo se le pide decidir
  si la factura lleva IVA (art. 3 num. 1). Las exclusiones de gastos reembolsables y caja chica (num. 6
  y 7) valen hasta 20 UT por operación, contra el total en Bs y la UT vigente (`tax_units`, P-71). Las
  de entes públicos (num. 11 y 12) no se marcan. El 100 % admite las operaciones del art. 2. Un TXT con
  un documento de varias alícuotas da 422 con su lista (P-69). **`document_type`** va en 01 porque hoy
  solo la FACTURA de proveedor practica retención: `registerSupplierCreditNote` no toca
  `supplier_retentions` y no hay ND de proveedor; si una NC o ND llegara a retener, su renglón tiene
  que llevar 03 o 02 (el CHECK ya los admite). **Desde la ola 5 (H-03, ADR-0083) la nota de crédito
  del proveedor se registra desde la pantalla, también sobre una factura retenida, y sigue SIN tocar
  la retención ni el comprobante**: lo dice en su respuesta (`retention_untouched`) y en su acta. Qué
  debe pasar con lo retenido es VALIDAR-SENIAT (P-103). **Norma leída el 2026-10-04 (PA
  SNAT/2025/000054 art. 11, «Ajustes de precios», reproducción no oficial):** si el ajuste disminuye
  el impuesto causado, el agente devuelve al proveedor lo retenido en exceso aún no enterado; si ya
  se enteró, lo descuenta el proveedor (art. 7). Ladino hoy **no distingue los dos casos**: coincide
  con la norma cuando la retención ya se enteró y no cuando sigue sin enterar. No se construye la
  devolución hasta la respuesta del asesor; la pantalla lo avisa (AF5-01).
- **Exclusiones del art. 3 como data** (`retention_exclusions`, catálogo de plataforma): solo las
  que REGULATORY_STATUS.md cita con fuente; numerales verificados solo el 2 y el 8, la 13.ª no se
  siembra. La persona marca una `marked` con motivo (10-500 caracteres) en `retention_exclusion`;
  queda en la factura y en el evento `ap.retention_excluded`. Las `automatic` no se marcan.
- **El comprobante** (`retention_vouchers` + `retention_voucher_lines`) se emite en el mismo acto:
  número `AAAAMM` (mes de emisión) + secuencial de 8 por empresa bajo candado, con la clave natural
  `(company_id, sequence)`; agente y proveedor con RIF, nombre y domicilio **congelados al emitir**;
  por renglón, el documento (tipo 01/02/03, número, control, fecha, afectado) y total, base, exento,
  IVA causado, alícuota, porción e IVA retenido, en moneda funcional. Uno por operación (omisión) o
  uno por quincena y proveedor (`PUT /v1/retention-vouchers/settings`). Vence la entrega el 2.º día
  de lunes a viernes tras la quincena (feriados: VALIDAR-TRIBUTARIO, P-26). PDF en
  `GET /v1/retention-vouchers/{id}/pdf`. **El correo no se construye**: no hay proveedor de correo
  configurado en Ladino; el PDF se descarga y se entrega por el canal de la empresa. Pantalla:
  Compras → «Comprobantes de retención» (lista, PDF, anotar la entrega, corregir y el modo).
- **Append-only.** La entrega se anota una vez (`POST …/delivery`). Corregir
  (`POST …/corrections`, `retention.receipt.issue`, con motivo) emite una versión nueva con número
  nuevo que reemplaza a la anterior; la reemplazada es la anulada. Sin UPDATE de estado.
- **Libros.** El libro de compras (`purchases_book_with_vouchers`) trae número, fecha e IVA retenido
  del comprobante emitido en el período; si se emitió en otro período que su factura, sale en el de
  su emisión como renglón `comprobante_retencion` con importes en cero. El libro de retenciones de
  IVA (`iva_retention_book`) lee del comprobante, en el período de su emisión; una versión
  reemplazada hasta el cierre del período sale `annulled` y el TXT la excluye. Las retenciones
  anteriores a la migración siguen saliendo como antes, sin comprobante-documento.
- **TXT** (`txt_retenciones_iva`): los 16 campos de P-7 en su orden, por tabulador; RIF sin
  guiones, período `AAAAMM` (el mes del período pedido), fecha `AAAA-MM-DD`, comprobante de 14.
  El archivo de una quincena contiene solo los comprobantes emitidos en ella. Lo que P-7 no fija
  (2 decimales, documento con varias alícuotas) es VALIDAR-SENIAT: la alícuota VACÍA de un documento
  con varias alícuotas queda en P-7(b) para el auditor fiscal. La corrección de un comprobante
  declarado en un período anterior no vuelve a salir (P-65), y la exportación lo avisa.
- **Concurrencia.** Emitir y corregir toman el mismo candado de asesoramiento por empresa
  (`ladino.retention_voucher:<empresa>`) antes de leer o crear nada; es reentrante con el del
  secuencial. Dos registros a la vez de la misma quincena no abren dos comprobantes, y dos
  correcciones de la misma versión se serializan (el único de `replaces_voucher_id` es la red).
- **Invariante** `platform.retention_voucher_gaps(empresa)`: toda retención de IVA practicada desde
  el corte tiene su renglón en un comprobante vigente por el mismo importe. Respuesta correcta: cero.
- **El pago** cancela el neto y no toca el comprobante: una factura a crédito pagada en partes ya
  lo tiene desde el registro. `issue_retention_receipt` al pagar sigue emitiendo el comprobante
  viejo (`retention_receipts`), que hoy documenta el ISLR.
- **Regularización** de retenciones no practicadas antes de esta entrega: no es automática
  (PENDIENTES_ASESOR P-63, F-88771 y F-89002 del escenario).

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

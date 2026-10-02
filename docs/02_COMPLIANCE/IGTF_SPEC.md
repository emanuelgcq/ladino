# IGTF

## Alcance
Motor configurable para supuestos de IGTF que correspondan a la empresa y medio de pago.

## Regla
El sistema no debe asumir universalmente que toda operación en divisa causa IGTF.

Inputs mínimos:
- clasificación del contribuyente;
- fecha;
- moneda/medio;
- naturaleza de operación;
- establecimiento;
- regla vigente.

## Posting
La cuenta contable del impuesto se obtiene de `accounting_mappings`.

`VALIDAR-TRIBUTARIO` antes de habilitar en producción.

## Construido el 2026-10-02 (ola 2 C2: E-02, E-03, F-05, G-06, L-15)

- **Quién percibe (E-02; auditoría fiscal, PA SNAT/2022/000013 art. 1):** la empresa cuyo tipo
  vigente el DÍA DEL PAGO es «especial» (`platform.taxpayer_type_at`), en los pagos en divisas o
  criptoactivos recibidos **sin mediación de instituciones financieras**. Qué instrumento causa es
  data de plataforma con su fuente (`igtf_instrument_classes`, migración 20261002100100): el
  efectivo en divisa y USDT causan; Zelle causa por criterio (lectura reversible); la transferencia,
  la tarjeta y el punto de venta bancarios NO. Ni el acta `igtf_enabled_at` ni la empresa lo
  cambian: `PUT /v1/igtf/instruments` responde 422 en los dos sentidos. VALIDAR-TRIBUTARIO P-66.
  Un especial que cobra en divisa con `otro` recibe 422 («regístralo con su instrumento
  verdadero»), y un instrumento sin clasificar es un error legible (pgTAP 098b exige la fila).
- **Base (F-05):** lo pagado contra el documento. La caja pide documento + 3 % de la parte en
  divisas. En `POST /v1/payments`, **por omisión `amount` es lo ENTREGADO** (revisión 11,
  decidido por criterio «nunca se registra dinero que no entró»): se reparte base + IGTF(base) =
  entregado contra lo pendiente valorado el DÍA DEL COBRO (`paid_at`), y lo que falte queda
  pendiente.
  `igtf_included: false` lo trata como lo que abona: solo para quien ya repartió (la caja). La
  ficha enseña antes el total a pagar con IGTF que calcula el servidor (`/v1/pos/tender`).
- **`absorb_igtf` (F-05):** ajuste por empresa en `company_settings`, apagado por omisión.
  Encendido, el cliente paga el documento justo; la percepción se guarda con `absorbed = true`, no
  suma a la caja y su asiento es Dr gastos operativos / Cr 2.1.91 (evento
  `igtf.perception_absorbed`). Se entera igual. VALIDAR-CONTABLE P-64.
- **Impreso (E-03, PA SNAT/2022/000013 art. 6):** «IGTF 3 % sobre USD X pagados en divisas: USD Y ·
  Bs. Z a la tasa del DD/MM/AAAA (Bs T)», en los tres destinos del PDF. La factura imprime lo
  percibido en su propia venta; el cobro posterior va en su **ND por IGTF**
  (EMISION_FACTURAS.md §3-bis), que imprime el suyo. Lo absorbido no se imprime (P-40).
- **Devolución (G-06):** la percepción queda «percibido» y se entera; la NC no la lleva; el
  reembolso es el total de la NC; la confirmación devuelve el aviso para la pantalla. Solo la
  anulación lo haría indebido, pero una factura con cobros no se anula: la rama
  `pendiente_reintegro` no se alcanza con IGTF percibido. **La restitución de un IGTF indebido
  con la venta viva no existe todavía**: decidido por criterio, va a la ola 3 con la reversa de
  cobros (R-61). VALIDAR-TRIBUTARIO P-31 y P-67.
- **Quincena y vencimiento (L-15):** `GET /v1/igtf/status` trae `fortnight` (1–15 y 16–último del
  mes de Caracas), de `platform.fiscal_fortnight` en el servidor, y `fortnight.due` desde `platform.tax_due_date`
  (calendario de la PA SNAT/2025/000091, migración 20261002120000): con fecha si la celda es de
  fuente secundaria; `pending_review` con la fecha en null si está pendiente de cotejo;
  `not_available` si no hay calendario para esa quincena. Nunca se inventa una fecha.

## Marco verificado el 2026-09-28 (respuesta del dueño al recorrido)

| Norma | Qué fija | Fuente · verificada | Estado |
|---|---|---|---|
| LIGTF (G.O. 6.687 Ext., 25-02-2022; rige desde el 27-03-2022) + Decreto 4.972 + PA SNAT/2022/000013 (G.O. 42.339, 17-03-2022) | 3 % transitorio sobre pagos en divisas o cripto (art. 4 num. 5 y 6); 0 % en Bs para SPE (Decreto 4.972); percepción el mismo día (PA art. 2); entero quincenal según el calendario SPE (art. 3); percepción indebida → restituir al cliente y pedir reintegro (art. 4); la factura muestra alícuota y monto del IGTF percibido (art. 6) | gerenciaytributos, ivecofi · 2026-09-25/28 | verificado; **Decreto 4.924 pendiente de fuente** |

Decisiones del dueño que aplican esta norma (respuesta §2.6):
- el SPE percibe el 3 % sobre lo pagado en divisas contra **cualquier** documento;
- la caja lo suma al total;
- el cobro posterior se documenta con una Nota de Débito por IGTF;
- la devolución deja el IGTF percibido; lo indebido se restituye (PA art. 4) — la restitución con
  la venta viva se construye en la ola 3 (R-61, P-67);
- la quincena la calcula el servidor con el calendario.

## Fuentes normativas (verificadas 2026-09-12)

- **Ley de IGTF** (reforma 2022): 3 % sobre pagos en divisas o criptoactivos distintos de los
  emitidos por la República, percibido por el sujeto pasivo especial.
- **Decreto 4.972** (G.O. Ext. 6.821, publicada el 12/07/2024, vigente desde el 15/07/2024): alícuota **0 %** para las operaciones en
  bolívares de los sujetos pasivos especiales. Ladino solo percibe sobre el PAGO en divisa
  (ADR-0052) y redondea la percepción a la moneda (ADR-0053).
- La percepción es de la empresa clasificada como sujeto pasivo especial (`IGTF` en la puesta a
  punto); una empresa ordinaria no percibe.
- Texto primario en Gaceta pendiente de archivar en `EXPEDIENTE_TECNICO.md`
  (**VALIDAR-TRIBUTARIO**: alícuota, supuestos y modo de redondeo).

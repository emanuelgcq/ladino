# Estado regulatorio — Venezuela

> **Corte: 2026-10-04** (auditoría fiscal de la ola 4; cada fila con su fecha de verificación). Este documento es el **punto de entrada** de `docs/02_COMPLIANCE/`.
> Antes de leer cualquier otro fichero de esta carpeta, mira aquí si la norma que lo sostiene
> sigue vigente. Varios documentos describen obligaciones **derogadas** y se conservan a
> propósito; sin este índice, se leen como si estuvieran en vigor.
>
> **Procedencia del dato:** investigación normativa aportada y verificada por el responsable del
> proyecto contra fuentes primarias al **2026-09-02** (que amplía la del 2026-08-15 con los
> artículos concretos de la PA 00071 y la PA 102 — ver §2). **No verificada de forma
> independiente contra el texto de la Gaceta desde este repositorio.** Antes de usarla en un
> expediente o en una comunicación con un tercero, contrástala con el texto oficial.
>
> La vista operativa de todo esto —las tres vías de emisión, quién debe usar cuál y qué cumple
> Ladino de cada una— vive en **`EMISION_FACTURAS.md`**.

---

## 1. DEROGADO

### PA SNAT/2024/000121 — derogada

- **Deroga:** Providencia Administrativa **SNAT/2026/00084**, Gaceta Oficial N.º **43.435** del
  **12/08/2026**.
- **Norma sustituta: NINGUNA.** Es una derogación sin reemplazo. No hay régimen nuevo que cumplir
  hoy en el ámbito que la 121 regulaba.

**Qué cae con ella, y esto es lo que cambia el proyecto:**

| Obligación derogada | Dónde vivía |
|---|---|
| Homologación previa del **sistema** ante el SENIAT | PA121 Art. 3 y el procedimiento de evaluación |
| Autorización previa del **proveedor** de software | PA121, requisitos del proveedor |
| **Obligación del contribuyente de usar software homologado** | **Disposición Final Cuarta de la propia 121** |
| Remisión electrónica continua de registros en la forma exigida por la 121 | PA121 Art. 3 numeral 2 |
| Clave de consulta y acceso del SENIAT al sistema | PA121 Art. 3 numeral 8 |
| Prohibiciones del Art. 8 (dispositivos no homologados, contabilidad alterna) | PA121 Art. 8 |

La tercera fila es la de mayor efecto comercial y conviene no pasarla por alto: **la obligación
del contribuyente vivía dentro de la norma derogada**, así que cae con ella. No queda un deber
residual de usar software homologado, porque no hay homologación que obtener.

**Por qué se conserva la documentación de la 121.** Puede volver reformada, y entonces la
pregunta útil no será «¿qué dice la nueva?» sino «¿qué cambió respecto de la 121?». Los dos
documentos siguen en el repositorio, con su encabezado de estado:

- `SENIAT_COMPLIANCE_AND_HOMOLOGATION.md` — qué exigía y qué procedimiento imponía.
- `SENIAT_ART121_CONTROL_MATRIX.md` — la matriz requisito → control → evidencia.

**No se borran y no se "actualizan" a la nueva realidad.** Son el registro de qué se exigía entre
2024 y 2026. Un histórico reescrito no es un histórico.

---

## 2. VIGENTE

Estas normas **no** fueron derogadas y siguen siendo la base de cumplimiento de Ladino. Son las
que gobiernan la emisión fiscal hoy.

| Norma | Alcance | Documento en el repo |
|---|---|---|
| **PA SNAT/2011/00071** | Normas generales de emisión de facturas y otros documentos | `FISCAL_DOCUMENTS_SPEC.md` · `EMISION_FACTURAS.md` |
| **PA SNAT/2018/0141** | Máquinas fiscales | fuera de alcance actual de Ladino |
| **PA 102** | Emisión por medios digitales · imprentas digitales | `SENIAT_PA102_DIGITAL_INVOICING.md` · `EMISION_FACTURAS.md` |
| **PA SNAT/2026/00080** | Reforma del RIF | ver §4 |
| **PA SNAT/2025/000054** (vigente 01/08/2025; deroga PA SNAT/2015/0049) | Agentes de retención de IVA: designación, porcentajes 75 % / 100 %, oportunidad y comprobante | `RETENTIONS_SPEC.md` — las reglas se cargan por empresa con esta fuente (ADR-0057) |
| **PA SNAT/2025/000048** (G.O. 43.140, 02/06/2025) | Unidad Tributaria = Bs. 43 | `IVA_SPEC.md` (umbral de máquina fiscal del art. 8 de la 00071, R-25) |
| **PA SNAT/2025/000091** (G.O. 43.273 / 43.283) | Calendario de sujetos pasivos especiales 2026 | `CALENDARIO_SPE_2026.md` — pendiente de cotejo con la Gaceta antes de sembrarlo |
| **Decreto 4.972** (G.O. Ext. 6.821, publicada el 12/07/2024, vigente desde el 15/07/2024) | IGTF 3 % en divisas · 0 % en bolívares para sujetos pasivos especiales | `IGTF_SPEC.md` · ADR-0052/0053 |
| **Convenio Cambiario N° 1** (G.O. Ext. 6.405, 07/09/2018), art. 9, Parágrafo Primero | El tipo de cambio que publica el BCV es «el de referencia de mercado a todos los efectos» | ADR-0064 §1: solo existe la tasa del BCV (migración 66) |
| **Ley del IVA** (G.O. Ext. 6.507, 29/01/2020), arts. 25 y 69 | Art. 25: operaciones en divisa al tipo de cambio corriente del día del hecho imponible. Art. 69: la factura en divisa lleva base imponible, impuesto y total también en bolívares | ADR-0064 §1-§2 · `documents-pdf.ts` · P-21, P-23. Art. 25: en día no hábil manda la tasa del día hábil siguiente (P-22); art. 69 sigue sin fuente (P-23) |
| **Ley del IVA**, arts. 56 y 37 | Art. 56: los libros de compras y ventas registran cronológicamente **todas** las operaciones. Art. 37: el impuesto de una operación anulada o de una devolución **se deduce del crédito fiscal** del período en que ocurre | ADR-0065 §1-§2 · migración 67: la nota de crédito recibida entra al libro en negativo y resta en la planilla; la factura anulada va al libro en cero |
| **Reglamento de la LIVA** (Decreto 206), arts. 70, 75 lit. a y 11 — **leído en reproducción no oficial** | Art. 70: registro cronológico y sin atrasos. Art. 75 lit. a: la nota de crédito recibida se asienta en el libro de compras. Art. 11: **pendiente de fuente** para el período; lo leído el 2026-10-04 es que trata de la nota de crédito o factura sustitutiva y su signo en el Libro de Ventas; el período lo da la LIVA art. 37 | ADR-0065 §1 · migración 67. **VALIDAR-SENIAT**: texto primario pendiente de archivar en `EXPEDIENTE_TECNICO.md` |
| **PA SNAT/2025/000054**, oportunidad de la retención | «Al pago o al **abono en cuenta**, lo que ocurra primero». Registrar la factura del proveedor como cuenta por pagar es el abono en cuenta | ADR-0065 §3 · migración 68 · `RETENTIONS_SPEC.md` §Oportunidad. **VALIDAR-SENIAT**: el plazo de entrega del comprobante (dos primeros días hábiles del período siguiente, por fuente secundaria) está abierto — P-26 |
| **Reglamento de la LIVA** (Decreto 206), art. 51 — **leído en reproducción no oficial** | La diferencia de tasa al pagar un precio en divisa es corrección de precio y se documenta con nota de débito o crédito | ADR-0064 §3 · ADR-0075 §4: **contradice lo implementado** (diferencial sin nota); decisión del dueño del 2026-09-28 a la espera del asesor (P-20); leído en 3 reproducciones no oficiales el 2026-10-03 |

Verificadas el 2026-09-12 con fuentes secundarias (Forvis Mazars, Baker McKenzie, IUSDATA,
Efecto Cocuyo); el texto primario en Gaceta queda por archivar en `EXPEDIENTE_TECNICO.md`
(**VALIDAR-TRIBUTARIO**).

### 2-bis. Marco cargado el 2026-09-28 (respuesta del dueño al recorrido)

Verificado por auditor-fiscal. Lo marcado **pendiente de fuente** no se ofrece en pantalla hasta tener su fuente. Cuando la norma verificada contradice la respuesta del dueño, manda la norma: la alícuota general la fija el Decreto 4.079 (no la Ley de Presupuesto), la reducida es el art. 64 (no el 63) y el campo 11 del TXT de retenciones es el IVA retenido (P-44).

| Norma | Qué fija | Fuente · verificada | Estado |
|---|---|---|---|
| PA 00071 arts. 22-24, 29-31, 36 y 44 | NC y ND: requisitos del art. 13 salvo el num. 1, más fecha, número y monto de la factura; control de la factura en NC y ND por máquina fiscal (art. 24); mismo control en original y copias (29); qué preimprime la imprenta en formatos (30) y en formas libres (31); conservar lo anulado hasta la prescripción (36); control único por emisor, 2 + hasta 8 dígitos (44) | ivecofi · 2026-09-28 | verificado |
| PA 00071 arts. 2 y 15 | Quien está inscrito en el RIF y solo realiza actividades no sujetas al IVA emite factura con la leyenda «no sujeto al IVA» (resumen del auditor-fiscal, hallazgo 9). Se reflejan en ADR-0072: `no_contribuyente` no se declara (P-56) y `formal` queda fuera hasta M-10 (P-38) | ivecofi · 2026-10-02 | verificado |
| PA 00071 art. 33 | Cada factura, nota de crédito o nota de débito emitida sobre forma libre ocupa UNA forma: si la operación no cabe, se emiten varios documentos, cada uno con su número. Ladino: tope de filas impresas por documento (`company_settings.rows_per_free_form`, por omisión 15), el dominio lo exige al emitir y `?destino=papel` rechaza lo que pase de una página (FC-34; cierra P-55) | ivecofi · 2026-10-02 (auditor-fiscal) | verificado |
| PA 00071 arts. 26-27 | Con serie, el número del documento va precedido de la palabra «serie»; el art. 27 regula la emisión por un sistema centralizado. Ladino imprime «Serie A N° 00000001» (sin serie, solo el número: «N° 00000001»); la pantalla sigue escribiendo «A-00000001». Pregunta abierta: P-54 (2) | ivecofi · 2026-10-02 (auditor-fiscal) | verificado |
| PA 00071 art. 8 | Máquina fiscal si concurren: ingresos brutos > 1.500 UT, mayor número de operaciones con quien no usa la factura como soporte, y actividad listada | tugacetaoficial · 2026-09-24 | verificado |
| Decreto 4.079 (G.O. 41.788, 26-12-2019) | Alícuota general 16 % (LIVA art. 27: la fija el Ejecutivo, 8–16,5 %) | Acceso a la Justicia · 2026-09-28 | fuente secundaria hasta archivar la Gaceta (P-44) |
| LIVA (G.O. 6.507 Ext., 29-01-2020; rige desde el 28-05-2020 según la AN) | art. 4.3 retiros; art. 8 formales (solo exentas o exoneradas); arts. 17-19 exenciones; art. 61 suntuario +15 %; art. 62 divisas 5–25 % (**no activado**); art. 64 reducida 8 %; art. 33 requisitos del crédito | secundarias · 2026-09-28 | texto primario pendiente |
| Decreto 5.196 (G.O. 6.952 Ext., 31-12-2025) | Suspende la exención de importación del art. 17.1 y exonera la importación de 1.445 subpartidas, hasta el 31-12-2026 | Acceso a la Justicia · 2026-09-28 | verificado |
| PA SNAT/2025/000054, **art. 3 (lectura del auditor fiscal, 2026-10-02)** | **13 numerales verificados (reproducción):** 1 operación no sujeta, exenta o exonerada; 2 proveedor formal; 3 proveedor agente de percepción que vende bebidas alcohólicas, fósforos, cigarrillos, tabaco u otros derivados; 4 proveedor que ya pasó por percepción anticipada al importar; 5 compras pagadas por empleados con viáticos; 6 gastos reembolsables de directores, gerentes, administradores u otros empleados por cuenta del agente, hasta 20 UT por operación; 7 compras de bienes muebles o servicios con caja chica, hasta 20 UT por operación; 8 electricidad, agua, aseo y telefonía domiciliados en las cuentas del agente; 9 proveedor inscrito en el Registro Nacional de Exportadores que además pidió recuperar créditos por exportación en los últimos 6 meses (las dos condiciones); 10 más del 50 % de ventas o servicios exentos o exonerados en el ejercicio fiscal anterior; 11 compra hecha por un órgano de la República, estado o municipio calificado SPE (el comprador); 12 compra hecha por un ente público sin fines empresariales creado por la República, calificado SPE (el comprador); 13 operación e IVA pagados bajo la excepción del art. 146 del COT. Art. 5, supuesto 4.º: operaciones del art. 2 (metales y piedras preciosas). En el catálogo `retention_exclusions` desde la migración 20261002110400. **Pendiente:** cotejo con la G.O. 43.171 y el texto del art. 146 del COT (VALIDAR-TRIBUTARIO, PENDIENTES_ASESOR P-74) | ivecofi (https://tributos.ivecofi.net/informacion/legislacion/providencias/pa-2025-54) · 2026-10-02 (auditor fiscal) | 13 numerales verificados (reproducción) |
| PA SNAT/2025/000054 (G.O. 43.171, 16-07-2025; rige desde el 01-08-2025; deroga la 2015/0049) | Agentes: SPE, incluidas firmas personales (arts. 1-2). Art. 3, exclusiones: exentas, exoneradas o no sujetas; proveedor formal (num. 2); percepción previa (licores); retención previa en importación; viáticos; gastos reembolsables ≤ 20 UT; caja chica ≤ 20 UT; servicios públicos domiciliados (num. 8); exportadores con solicitud de recuperación; proveedor con > 50 % exentas; entes públicos; art. 146 COT. **Los 13 numerales, leídos y verificados (reproducción), están en la fila anterior («art. 3, lectura del auditor fiscal»); el cotejo con la G.O. 43.171 y el art. 146 del COT siguen en PENDIENTES_ASESOR P-74.** 75 % general (art. 4); 100 % si el IVA no está discriminado, la factura no cumple requisitos, el portal lo indica o el proveedor no está en el RIF (art. 5); oportunidad: pago o abono en cuenta, lo primero (art. 13); entero quincenal (arts. 14-15); comprobante (art. 16) | ivecofi · 2026-09-25/28 | verificado (reproducción) |
| Instructivo TXT retenciones IVA v3_0_0 | 16 campos (ver P-7) | readkong · 2026-09-28 | verificado (reproducción) |
| LIGTF (G.O. 6.687 Ext., 25-02-2022; rige desde el 27-03-2022) + Decreto 4.972 + PA 000013 (G.O. 42.339, 17-03-2022) | 3 % transitorio sobre pagos en divisas o cripto (art. 4 num. 5 y 6); 0 % en Bs para SPE (Decreto 4.972); percepción el mismo día (PA art. 2); entero quincenal según calendario SPE (art. 3); indebida → restituir y pedir reintegro (art. 4); alícuota y monto en la factura (art. 6). **Decreto 4.924: pendiente de fuente** | gerenciaytributos, ivecofi · 2026-09-25/28 | verificado salvo 4.924 |
| PA SNAT/2003/1677 (G.O. 37.677, 25-04-2003) | Formales: documento con leyenda (art. 3), excepción para adquirente persona natural (art. 4). **Periodicidad de la informativa y de las relaciones: pendiente de fuente** | gerenciaytributos · 2026-09-28 | parcial |
| PA SNAT/2026/00080 (G.O. 43.435, 12-08-2026) | RIF sin vencimiento; actualizar ante cambios en el plazo del COT | Acceso a la Justicia · 2026-09-28 | verificado |
| COT art. 35 (1 mes para informar cambios) · arts. 99-108 (ilícitos formales) | — | — | **pendiente de fuente** |
| RLIVA (Decreto 206) arts. 13-14 (retiros, faltantes) y 70-78 (libros; 72 resumen por alícuota) | arts. 12, 13, 14, 31, 43 | pandectasdigital, gerenciaytributos · 2026-10-03 | leídos en reproducción no oficial; cotejo con la G.O. 5.363 Ext. pendiente |
| RLIVA (Decreto 206, G.O. 5.363 Ext., 12-07-1999) art. 31 | «Para el caso de retiro, desincorporación, autoconsumo y faltante en los inventarios de bienes muebles, que forman parte del objeto, giro o actividad de la empresa, se entenderán ocurridos o perfeccionados los hechos imponibles y nacida la obligación tributaria, en el momento en que sucedan dichos hechos, oportunidad en que deberá emitirse obligatoriamente la correspondiente factura por parte del contribuyente y efectuarse su registro en la columna especial del Libro de Ventas.» | pandectasdigital (https://pandectasdigital.blogspot.com/2016/09/reglamento-general-de-la-ley-que.html) · 2026-10-03 (auditor fiscal) | reproducción no oficial; cotejo con la G.O. 5.363 Ext. pendiente |
| PA 00071 arts. 34 y 35 | Fecha en DDMMAAAA con separadores (34); las facturas y otros documentos sobre formatos o formas libres se diseñan según las necesidades del emisor cumpliendo los requisitos de la providencia (35): admite texto adicional como la condición de pago; el art. 13 no exige condición de pago ni vencimiento (P-101) | ivecofi · 2026-10-04 (auditor fiscal, ola 4) | verificado (reproducción no oficial; cotejo con la Gaceta pendiente) |
| PA 00071 art. 36, releído | Solo manda conservar los originales anulados con su copia hasta la prescripción; no fija plazo, día, cierre de caja ni registro en el libro: la ventana de anulación de Ladino (G-10) es criterio del dueño, más estricta que el texto (P-91, P-34) | ivecofi · 2026-10-04 (auditor fiscal, ola 4) | verificado (reproducción no oficial; cotejo con la Gaceta pendiente) |
| PA SNAT/2025/000054 arts. 3 num. 8 y 13, literales | Num. 8: electricidad, agua, aseo y telefonía «pagados mediante domiciliación a cuentas bancarias de los agentes de retención» (el medio de pago es condición; Ladino: el gasto con factura rechaza la exclusión si la cuenta no es bancaria, AF4-01). Art. 13: pago o abono en cuenta, lo primero, cualquiera sea el medio de pago; abono en cuenta = lo acreditado en la contabilidad o registros del comprador | ivecofi (https://tributos.ivecofi.net/informacion/legislacion/providencias/pa-2025-54) · 2026-10-04 (auditor fiscal, ola 4) | verificado (reproducción no oficial; cotejo con la Gaceta pendiente); P-95, P-72 |
| RLIVA (Decreto 206) arts. 11, 28, 29, 30 | 11: la devolución da NC o factura sustitutiva; la NC va con signo negativo al Libro de Ventas; 28: la mora en el pago no impide el hecho imponible; 29: en bienes muebles vendidos a plazo, el anticipo del precio no es hecho imponible hasta la factura o la entrega; 30: en ventas por muestras o catálogos, el anticipo sobre proforma sí hace nacer la obligación | pandectasdigital · 2026-10-04 (auditor fiscal, ola 4) | reproducción no oficial; cotejo con la G.O. 5.363 Ext. pendiente (P-98) |
| RLIVA (Decreto 206) arts. 55, 57, 62, 76 y 77 | 55: crédito = impuesto soportado en costos, gastos o egresos propios de la actividad habitual; prorrateo; 57: factura no fidedigna si su numeración y fecha no guardan continuidad; 62: duplicado; solo el original da crédito; 76-77: datos del Libro de Ventas; no mencionan documentos anulados | pandectasdigital · 2026-10-04 (auditor fiscal, ola 4) | reproducción no oficial; cotejo con la G.O. 5.363 Ext. pendiente (P-94, P-34) |
| LIVA arts. 13, 33, 34, 35 y 37 (versión G.O. 38.263) | 13: momentos del hecho imponible (servicios: factura, ejecución, pago o exigibilidad, lo primero); 33: crédito solo por gastos propios de la actividad habitual; 34: prorrata; 35: no se deduce lo que exceda lo procedente; 37: se resta del crédito lo anulado y lo soportado de más | Justia · 2026-10-04 (leído en resumen; auditor fiscal, ola 4) | reproducción no oficial; numeración 2020 sin cotejar (P-102) |
| PA SNAT/2025/000054 art. 11 «Ajustes de precios» | Aumento del importe: se retiene también sobre el aumento. Disminución del impuesto causado: el agente devuelve al proveedor lo retenido en exceso aún no enterado; si ya se enteró, el proveedor lo descuenta de su cuota (art. 7) o pide recuperación. No nombra la nota de crédito ni el comprobante. **Contradice en parte lo construido** (ADR-0083: la nota sobre factura retenida no toca la retención): P-103 | ivecofi (https://tributos.ivecofi.net/informacion/legislacion/providencias/pa-2025-54) · 2026-10-04 (auditor fiscal, ola 5) | reproducción no oficial, leída en resumen; cotejo con la G.O. 43.171 pendiente |
| LIVA arts. 4 num. 3 in fine, 36, 37 y 58 (versión G.O. 38.263) | 4.3 in fine: no es retiro gravado lo destinado al giro, al activo fijo o a la construcción o reparación de un inmueble del negocio (P-82). 36: lo devuelto, anulado o rescindido se deduce de los débitos del período en que ocurre (respalda la nota de crédito del retiro en su período, P-76). 37: del crédito se deduce el impuesto de lo anulado y lo soportado en exceso (P-106, P-107). 58: la devolución o anulación se documenta con nueva factura o nota con los mismos requisitos. La Ley no fija una base propia del retiro: la da el RLIVA art. 43 (P-75) | Justia · 2026-10-04 (auditor fiscal, ola 5) | reproducción no oficial; numeración 2020 sin cotejar |
| RLIVA art. 57, aplicado al retiro | La factura de retiro toma el correlativo y el control siguientes; si se emitiera con fecha anterior a facturas ya emitidas, rompería la continuidad de número y fecha: Ladino la emite siempre con la fecha del día (AF5-08; P-76, pregunta 5) | pandectasdigital · 2026-10-04 (auditor fiscal, ola 5) | reproducción no oficial |
| Ley de IGTF (G.O. 6.687 Ext.) art. 4 num. 6, literal | Grava «los pagos realizados» a un sujeto pasivo especial en moneda distinta de la de curso legal o en cripto, sin mediación de instituciones financieras; no distingue el concepto del pago (anticipo: P-98) | Acceso a la Justicia · 2026-10-04 (auditor fiscal, ola 4) | verificado (fuente secundaria con cita literal; cotejo con la Gaceta pendiente) |
| COT: deber de conservar libros, registros y documentos hasta la prescripción | Art. 145 num. 3 en el COT 2001; número en el COT 2020 sin verificar | sin fuente leída | **PENDIENTE DE FUENTE** (P-97) |
| Resolución BCV 21-08-01 (G.O. 42.191, 16-08-2021) | redondeo half-up solo para la reexpresión | Acceso a la Justicia · 2026-10-03 | precedente no vinculante; sin norma permanente hallada (P-79) |
| LIVA: plazo de 12 períodos para deducir crédito | Número en fuentes secundarias | gerenciaytributos · 2026-09-28 | **pendiente de fuente (artículo)** |
| VEN-NIF PYME sección 30 | Diferencia en cambio y tasa de cierre | — | **pendiente de fuente** (VALIDAR-CONTABLE) |
| UT = Bs 43 (PA SNAT/2025/000048, G.O. 43.140) | 1.500 UT = Bs 64.500; 20 UT = Bs 860 | Acceso a la Justicia · 2026-09-24 | verificado |

**Los artículos que gobiernan el trabajo de Ladino, verificados al 2026-09-02 con fuentes
primarias** (cada punto con su providencia y artículo):

- **PA 00071 art. 6** — tres medios de emisión a **libre elección** del contribuyente: (1)
  formatos, (2) **formas libres**, (3) máquina fiscal, **salvo** los obligados del art. 8. En forma
  libre nunca se emite a mano. Ladino emite sobre formas libres (arts. 6.2 y 31).
- **PA 00071 art. 13** — los requisitos de la factura en forma libre. Los que Ladino imprime y
  dónde: numeral 5 (nombre/razón social, **domicilio fiscal** y RIF del emisor — snapshot
  congelado, migración 34), 6 (fecha en ocho dígitos), 8 (marcador «(E)» en operaciones
  exentas/exoneradas/no sujetas; es el numeral **8**, no el 9: E-24), 13 (leyenda «SIN DERECHO A CRÉDITO FISCAL» en toda copia),
  14 (ambas monedas y tipo de cambio cuando la operación se expresó en moneda extranjera).
  Mapeo completo en `EMISION_FACTURAS.md` y checklist en `FACTURA_CHECKLIST.md` (FC-01…FC-33).
- **PA 00071 art. 8** — obligados a **máquina fiscal** cuando concurren las TRES condiciones:
  ingresos del año anterior superiores a **1.500 UT**, operaciones **mayoritarias** con
  consumidor final, y actividad **listada** en el artículo. El **literal j** obliga sin
  importar el ingreso. `/empezar` lo advierte; Ladino no imprime por máquina fiscal (R-25).
- **PA 00071 art. 49** — prohibición de documentos previos (presupuestos/proformas que
  sustituyan factura) para los obligados a máquina fiscal.
- **PA 102** — vigente, **obligatoria para sus sujetos desde el 01/03/2025**: autorización del
  emisor (arts. 3/17); la **imprenta digital asigna el número de control DOCUMENTO A
  DOCUMENTO** (el modo `per_document` de ADR-0037; contrato del adaptador en ADR-0045);
  formato del control en el **art. 30** («N° de Control» + identificador de DOS dígitos +
  secuencial de HASTA OCHO dígitos, arrancando 00-1 — `CONTROL_NUMBER_RE` en
  `packages/fiscal`); **talonarios de contingencia con la palabra «contingencia»**
  (migración 35, `contingency_ranges`); conservación **10 años**; entrega por medio digital.

Y todo lo tributario sustantivo, que la 121 nunca reguló y que sigue exactamente igual: IVA
(`IVA_SPEC.md`), ISLR (`ISLR_SPEC.md`), retenciones (`RETENTIONS_SPEC.md`), IGTF (`IGTF_SPEC.md`),
ajuste por inflación (`INFLATION_ADJUSTMENT_SPEC.md`), libros fiscales
(`REPORTING_AND_FISCAL_BOOKS.md`).

**Consecuencia práctica:** lo que hace falta para emitir una factura válida no cambió. Cambió el
régimen de **autorización del software**, no el de **emisión del documento**.

---

## 3. ESPERADO

Se espera normativa nueva con **estándares técnicos y protocolos de comunicación**. **No está
publicada.** No hay borrador, no hay fecha, no hay alcance confirmado.

**Regla mientras tanto, y es la de `CLAUDE.md` §2 aplicada al vacío regulatorio:** no se
implementa nada contra una norma que no existe, y tampoco se da por hecho que la nueva se parecerá
a la 121. Lo único que se hace es **dejar la estructura preparada para que absorberla sea barato**,
que es de lo que tratan ADR-0027 y ADR-0028.

Lo que apunta la expectativa —protocolos de comunicación— es exactamente el requisito que la 121
ya traía (remisión electrónica) y el que sobrevive a cualquier reforma: si el Estado quiere los
datos, va a querer recibirlos por algún canal. Por eso ADR-0028 deja lista la forma de la
transmisión sin comprometerse con ningún protocolo.

**Consecuencia operativa que hay que leer bien (S0.6a):** el worker monta `NullTransmitter`, y con
él **todo evento fiscal queda `published` en el outbox sin haberse transmitido a nadie**.
`published` significa «el consumidor lo procesó», y hoy el consumidor es el nulo. No significará
«recibido por el SENIAT» hasta que exista un adaptador real contra un régimen vigente. Un panel
que cuente «eventos publicados» induce exactamente la lectura contraria; está dicho también en
`infra/README.md`.

---

## 4. PA SNAT/2026/00080 — reforma del RIF

Norma **aparte** de la derogación, y con efecto directo sobre lo construido en S0.4:

- El RIF **deja de caducar**.
- Pero **debe actualizarse ante cambios de datos** del contribuyente.

**Efecto sobre Ladino:** refuerza la decisión de M4
(`supabase/migrations/20260811190652_guard_company_tax_id.sql`). Si el RIF debe actualizarse
cuando cambian los datos del contribuyente, entonces **el cambio de RIF es una operación esperada
y recurrente**, no una corrección excepcional de un error de tecleo. Eso hace que el rastro con
valor anterior valga más, no menos, y confirma que no debía bloquearse el cambio sino auditarlo.

Lo que **no** resuelve: sigue sin haber en el repositorio una fuente citada para el **formato** del
RIF (estructura, prefijos, dígito verificador). `VALIDAR-SENIAT` sigue abierto — ver §5.

---

## 5. VALIDAR-SENIAT — qué se resuelve y qué sigue abierto

Resueltos por derogación, con fecha y fuente. **Resueltos no significa contestados: significa que
la pregunta dejó de existir porque la norma que la generaba ya no está en vigor.**

| # de `OPEN_QUESTIONS.md` | Estado | Motivo |
|---|---|---|
| 1 · alcance Art. 8.3 para navegadores y móviles | **RESUELTO 2026-08-15** — cae con PA SNAT/2026/00084 | El Art. 8 era de la 121 |
| 3 · clave de consulta y acceso a API | **RESUELTO 2026-08-15** | Art. 3 numeral 8 de la 121 |
| 4 · si los bounded contexts evitan rehomologar | **RESUELTO 2026-08-15** | No hay homologación que evitar. La decisión de ADR-0003 se mantiene por otra razón: ver la enmienda del propio ADR |
| 5 · procedimiento para SaaS multitenant | **RESUELTO 2026-08-15** | Era el procedimiento de autorización de proveedores de la 121 |
| 6 · homologar por identificador de build/commit | **RESUELTO 2026-08-15** | Ídem |
| 7 · requisitos de infraestructura cloud | **RESUELTO 2026-08-15** | Venía de los requisitos de proveedor de la 121 |

Siguen **abiertos**, porque no dependían de la 121:

| Pregunta | Norma que la sostiene |
|---|---|
| **Formato del RIF** — estructura, prefijos, dígito verificador | PA 102 Art. 7 (datos fiscales del emisor) y PA SNAT/2026/00080 |
| **Retención/conservación** por tipo de documento | PA 102 (acceso digital a documentos emitidos) |
| **Contingencia** en SaaS y móvil/offline | PA 102 y PA 071 · `FISCAL_CONTINGENCY_SPEC.md` |
| **Emisión en dos fases con imprenta digital** — qué cuenta como documento emitido si la imprenta responde tras un timeout | PA 102 |

Reabierta con otra forma, y ahora **en la categoría "esperado"** en vez de "vigente":

| Pregunta | Estado |
|---|---|
| 2 · formato y protocolo de remisión continua | La obligación concreta de la 121 cae. La expectativa de protocolos de comunicación en la norma futura la mantiene viva como **requisito anticipado**, no como obligación actual. Ver ADR-0028 |

---

## 6. Qué NO cambia

Conviene decirlo explícitamente, porque una derogación invita a relajar cosas que no dependían de
la norma derogada:

- **Las diez reglas de `CLAUDE.md` siguen enteras.** Una factura emitida no se edita, un asiento
  `posted` no se actualiza, la contabilidad cuadra, el dinero no es `float`. Nada de eso venía de
  la 121: viene del Código de Comercio, de las normas contables y de la aritmética.
- **La pista de auditoría append-only se queda.** Dejó de ser un requisito de homologación y sigue
  siendo un requisito de producto: un ERP contable sin trazabilidad no es vendible, homologado o
  no.
- **PA 071 y PA 102 gobiernan la factura.** Lo que hace válido un documento no se tocó.
- **`HOMOLOGATION_IMPACT` en el formato de entrega se mantiene**, con otro significado: ya no
  marca «esto entra a un gate de homologación» sino «esto toca comportamiento fiscal y hay que
  poder decir qué cambió y cuándo». Ver ADR-0027.

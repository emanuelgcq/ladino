# IVA

## Alcance
- débito fiscal;
- crédito fiscal;
- exento/exonerado/no gravado;
- múltiples alícuotas configurables;
- prorrata si aplica;
- retención de IVA;
- libros.

## Diseño
No fijar 16% en código. Cualquier tasa vigente se carga desde configuración versionada con fuente jurídica.

## Posting ejemplo conceptual
Venta gravada:
- Dr CxC/Caja
- Cr Ingreso
- Cr IVA Débito Fiscal

Compra:
- Dr Inventario/Gasto
- Dr IVA Crédito Fiscal
- Cr CxP/Caja

La cuenta exacta depende de chart mapping de empresa.

## Validaciones
- suma de bases por tratamiento;
- impuesto por línea/documento según política autorizada;
- redondeo consistente (ADR-0058: base e impuesto de cada línea a las minor units de la moneda);
- notas ajustan documento origen.

## Fuentes normativas (verificadas 2026-09-28)

| Condición (2.5) | Valor | Cita | Estado de la fuente |
|---|---|---|---|
| `gravado_general` | 16 % | LIVA art. 27 (rango 8–16,5 %, lo fija el **Ejecutivo**) + **Decreto N.º 4.079, G.O. 41.788 del 26-12-2019**, rige desde el 01-01-2020. **No** la Ley de Presupuesto. | fuente secundaria (Acceso a la Justicia; sin decreto posterior hallado) hasta archivar la Gaceta (P-44, migración 20260928170300) |
| `reducida` | 8 % | LIVA **art. 64** (art. 63 antes de la reforma 2020) | numeración en 3 fuentes secundarias; bienes alcanzados **pendiente de fuente** |
| `adicional_suntuario` | 16 % + 15 % | LIVA art. 61 | fuente secundaria |
| recargo por divisas (art. 62) | 5–25 % | LIVA arts. 27 y 62; art. 71 (30 días) | **NO se siembra**: sin decreto que lo active (no hallado a 2026-09-28) |
| `exento` | 0 %, «(E)» | LIVA arts. 17 (importaciones), 18 (ventas), 19 (servicios) | ver lista abajo |
| `exonerado` | 0 %, «(E)» | solo con decreto vigente, con número y vigencia | vigente: Decreto 5.196 (importación), abajo |
| `no_sujeto` | 0 %, «(E)» | LIVA art. 16 | **pendiente de fuente** (no se verificó en esta pasada) |

Nota: «Decreto 4.653 de 2025», citado antes aquí, **no se pudo verificar**: se retira como fuente
hasta localizarlo (VALIDAR-TRIBUTARIO).

### LIVA art. 18, numeral 1 — alimentos exentos en la venta

Fuente de los literales: reproducción del art. 18 en su versión de la G.O. 6.396 Ext.
(21-08-2018) (https://www.laiguana.tv/articulos/320891-gaceta-oficial-productos-exentos-iva/),
cotejada con la nota de El Nacional del 05-02-2020, posterior a la G.O. 6.507, que repite los
mismos productos (https://www.elnacional.com/2020/02/la-lista-de-productos-y-servicios-exonerados-del-pago-del-iva/).
**No cotejado con el texto de la G.O. 6.507** (el PDF de la Asamblea Nacional es un escaneo).
Estado de cada literal: *fuente secundaria* (VALIDAR-TRIBUTARIO).

| Literal | Producto (paráfrasis) |
|---|---|
| 18.1.a | Productos del reino vegetal en estado natural para consumo humano; semillas certificadas, material de reproducción animal e insumos biológicos agrícolas y pecuarios |
| 18.1.b | Especies avícolas reproductoras, huevos fértiles de gallina y pollitos, pollitas y pollonas para reproducción |
| 18.1.c | Arroz |
| 18.1.d | Harina de origen vegetal, incluidas las sémolas |
| 18.1.e | Pan y pastas alimenticias |
| 18.1.f | Huevos de gallina |
| 18.1.g | Sal |
| 18.1.h | Azúcar y papelón, salvo los de uso industrial |
| 18.1.i | Café tostado, molido o en grano |
| 18.1.j | Mortadela |
| 18.1.k | Atún enlatado en presentación natural |
| 18.1.l | Sardinas enlatadas en presentación cilíndrica de hasta 170 g |
| 18.1.m | Leche cruda, pasteurizada, en polvo, modificada, maternizada o humanizada, y fórmulas lácteas, incluidas las de soya |
| 18.1.n | Queso blanco |
| 18.1.o | Margarina y mantequilla |
| 18.1.p | Carnes de pollo, bovino y porcino en estado natural, refrigeradas, congeladas, saladas o en salmuera |
| 18.1.q | Mayonesa |
| 18.1.r | Avena |
| 18.1.s | Animales vivos destinados al matadero (bovino y porcino) |
| 18.1.t | Ganado bovino y porcino para la cría |
| 18.1.u | Aceites comestibles, salvo el de oliva |
| **literal pendiente de fuente** | Maíz para consumo humano; maíz amarillo para alimento animal; aceites vegetales refinados como materia prima de aceites comestibles; materia prima de alimentos concentrados para animales y esos alimentos; sorgo; soya |

Otros numerales del art. 18 (número exacto **pendiente de fuente**): medicamentos y
agroquímicos y sus principios activos, vacunas, sueros y plasmas; fertilizantes; vehículos
adaptados para personas con discapacidad, sillas de ruedas, marcapasos, catéteres, válvulas,
órganos artificiales y prótesis; diarios, periódicos y su papel; libros, revistas y folletos y sus
insumos.

### Exoneraciones vigentes

- **Decreto N.º 5.196**, G.O. 6.952 Ext. del 31-12-2025, vigente hasta el **31-12-2026**: suspende
  la exención de **importación** del art. 17 num. 1 y exonera la importación de las 1.445
  subpartidas de su Apéndice I. Sustituye al Decreto 5.145 (G.O. 6.918 Ext. del 30-06-2025). **No
  afecta a las ventas internas del art. 18.** Fuente:
  https://accesoalajusticia.org/suspension-de-la-aplicacion-de-las-exenciones-a-la-importacion/
  (verificada el 2026-09-28).

- **PA SNAT/2025/000048** (G.O. 43.140, 02-06-2025): UT = Bs 43; 1.500 UT = Bs 64.500 (PA 00071
  art. 8). Sin reajuste para 2026 hallado a 2026-09-24.

- **Cómo llegan a una empresa:** el catálogo de condiciones fiscales se siembra como data de
  plataforma con su cita (respuesta del dueño, §1 y §2.5), y cada empresa acepta su alícuota general
  con acta en la puesta a punto (B-02, ADR-0038 y ADR-0057: la regla aceptada es suya). La adicional
  del art. 62 (pagos en divisas) **no se siembra** hasta que exista el decreto que la active.
- **PA SNAT/2025/000091**: calendario 2026 de sujetos pasivos especiales → `CALENDARIO_SPE_2026.md`
  (sembrado el 2026-10-02 con la reimpresión de la G.O. 43.283; las celdas ⚠ quedan pendientes de cotejo y no se ofrecen).
- **Retención de IVA**: PA SNAT/2025/000054 — ver `RETENTIONS_SPEC.md`.
- Texto primario en Gaceta pendiente de archivar en `EXPEDIENTE_TECNICO.md`
  (**VALIDAR-TRIBUTARIO**).

## Implementación (ADR-0073, migraciones 20260928150000 y 20260928150100)

- **Catálogo de plataforma** `public.tax_rule_templates`: una fila por condición con norma,
  artículo, Gaceta, vigencia y estado de la fuente, copiada de la tabla de arriba. No son reglas:
  `resolve_tax` no las lee y `tax_rules` sigue naciendo vacía (ADR-0038).
  - `gravado_general`: 16 % de referencia, rango 8–16,5 %, se **acepta** por empresa;
  - `gravado_reducida` (la «reducida» de la respuesta del dueño): 8 %, art. 64;
  - `gravado_adicional` (la «adicional_suntuario»): 15 % **sumado** a la general de la empresa;
  - `exento`: 0 %, arts. 17-19;
  - `exonerado`: solo importación (Decreto 5.196, hasta el 31-12-2026), **no** se ofrece en ventas;
  - `no_sujeto` y la adicional del art. 62: **no se siembran** (pendiente de fuente / sin decreto).
  Se reutilizan los códigos de `product_tax_categories` (migración 16): `gravado_reducida` y
  `gravado_adicional` son la «reducida» y la «adicional_suntuario» de la respuesta del dueño.
- **Cesta básica** `public.tax_exemption_literals`: los 21 literales del art. 18.1, «fuente
  secundaria» (PENDIENTES_ASESOR P-52).
- **Aceptación** `platform.accept_general_vat(empresa, tasa, fecha)`: 0 % y fuera de rango → LAD97;
  otra tasa cierra la vigencia de la general y la adicional en la fecha efectiva y abre otra; la
  misma tasa no crea nada. Completa, como reglas propias con la cita del catálogo, la reducida, la
  exenta y la adicional (`platform.seed_catalog_tax_rules`). El trigger
  `tax_rules_02_general_in_range` impide una general propia fuera de rango por cualquier camino.
- **La interfaz** lee la referencia del catálogo de `GET /v1/fiscal/setup` (`iva_catalog`) y
  ofrece al clasificar solo lo que el catálogo ofrece en ventas (`offered_in_sales` de
  `GET /v1/tax-categories`). Ninguna cifra en la web (B-11).
- **La factura** discrimina base e IVA por alícuota con su porcentaje, «Exento (E)», «Exonerado (E)» y
  «No sujeto (E)», y sus columnas van sin IVA con subtotal = suma de la columna (FC-08, FC-10, FC-11,
  FC-31). **El libro de ventas** trae base e IVA por alícuota y el resumen del art. 72 del RLIVA
  (`REPORTING_AND_FISCAL_BOOKS.md`). **La declaración** ya sumaba por alícuota
  (`recompute_iva_period`, `detalle`).

### Auditoría fiscal de la ronda (migración 20260928170300)

- **La reducida es una lista cerrada** (LIVA art. 64): clasificar como `gravado_reducida` exige el
  literal del bien (`products.reduced_rate_literal_code` → `tax_reduced_rate_literals`). La lista
  **nace vacía** (bienes alcanzados: pendiente de fuente, P-51); mientras lo esté, la reducida no se
  ofrece al clasificar.
- **La adicional** (art. 61) exige una justificación escrita con acta (P-60).
- **La general** pasa a «fuente secundaria» hasta que P-44 se cierre con la Gaceta archivada; se
  sigue ofreciendo (nada filtra por «verificada»).
- **El libro de compras** trae base e IVA por alícuota y su resumen (P-59, lectura conservadora).

## La declaración del período (L-04, L-05; ADR-0072 §7, migración 20261002120000)

La planilla demostrativa (`platform.recompute_iva_period`, generada por `generateIvaPeriod`) sigue
siendo **no oficial** (P-1). Lo que cambia:

- **Periodicidad por tipo**: el **especial** declara por **quincena** — del 1 al 15 y del 16 al
  último día — (PA SNAT/2025/000091); el **ordinario** por **mes**, por la LIVA (artículo del
  período mensual, VALIDAR-TRIBUTARIO P-73): la PA 000091 es de los especiales y no fija el mes del
  ordinario (auditoría fiscal 2.ª ronda, H13). El tipo es el vigente en las dos
  puntas del rango (`platform.taxpayer_type_at`). Un especial que pide otro rango recibe 422 con sus
  dos quincenas del mes; un ordinario que pide cualquier rango que no sea el mes calendario
  completo (del 1 al último día), 422 con su mes (H5, revisión). Si el tipo
  cambia dentro del rango, 422 y consulta al asesor (VALIDAR-TRIBUTARIO).
- **Imputación** (respuesta del dueño, L-04): débitos por la **fecha de emisión** de la factura (día
  de Caracas); créditos por la **fecha de la factura de compra**, o la de registro si llegó tarde
  (`coalesce(accounting_date, invoice_date)`, K-04); retenciones soportadas por la **fecha del
  comprobante** (`retained_on`, P-12). Las tres son comparaciones `date` contra `date`.
- **La quincena la calcula el servidor**: `platform.fiscal_fortnight(día)` → `(period_from,
  period_to)`; recibe el día de Caracas. La usa también el IGTF (L-15).
- **La propuesta**: `GET /v1/fiscal-declarations/iva-periods/proposal` (`platform.iva_period_proposal`)
  devuelve la última quincena cerrada (especial) o el último mes cerrado (ordinario), evaluando
  el tipo en el CIERRE del período candidato (en la transición especial→ordinaria, la última
  quincena que tocaba), y su vencimiento por terminal del RIF si la celda está ofrecida (la tabla
  de la 2.ª quincena no lo está hasta el cotejo, P-10). La pantalla arranca en ese período.
- **Dos arrastres, como en la Forma 00030** (L-05, P-3/P-37):

  ```
  impuesto        = débitos − (créditos deducibles + ajuste) − excedente de crédito anterior
  cuota tributaria = max(0, impuesto)
  excedente_siguiente (crédito fiscal)        = max(0, −impuesto)
  retenciones disponibles                    = retenciones acumuladas anteriores + del período
  cuota_a_pagar                               = max(0, cuota tributaria − retenciones disponibles)
  retenciones_acumuladas_por_descontar        = max(0, retenciones disponibles − cuota tributaria)
  ```

  Una retención nunca se convierte en crédito fiscal (PA SNAT/2025/000054 arts. 7 y 8, según el
  hallazgo L-05; VALIDAR-TRIBUTARIO P-37). Persistido en `iva_period_results` con
  `retenciones_acumuladas_anteriores` y `retenciones_acumuladas_por_descontar`; firmado en el hash
  (generador `iva-declarations/1.1.0`, las dos claves solo cuando no son cero).
- **Filas viejas**: las del generador 1.0.0 conservan su cifra combinada y su hash. Una con excedente
  o con retenciones del período no se encadena: el dominio pide regenerarla.

### Auditoría fiscal, 2.ª ronda (migración 20261002120200)

- **La ND por IGTF no es venta (H1; PA SNAT/2022/000013 arts. 5-6, LIVA art. 34).** Su línea
  (producto de sistema `LADINO-IGTF`) sale de `ventas`, `bases_venta` y `por_alicuota`: no aporta
  débito ni base y **no activa la prorrata**. VALIDAR-TRIBUTARIO P-70.
- **La retención entregada tarde (H4; PA SNAT/2025/000054 art. 7).** El comprobante soportado
  guarda su fecha de entrega (`received_on`; sin ella, la de la retención). Cuenta en el período de
  su retención, salvo que ese período ya estuviera **declarado** al entregarse (una generación que lo
  cubre, hecha después de cerrar el período —una vista previa no cuenta, B-1, migración
  20261002120400— y del día de la entrega o anterior): entonces en el de la entrega. La fecha de
  entrega no puede ser posterior a hoy (B-2). VALIDAR-TRIBUTARIO P-68.

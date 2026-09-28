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
| `gravado_general` | 16 % | LIVA art. 27 (rango 8–16,5 %, lo fija el **Ejecutivo**) + **Decreto N.º 4.079, G.O. 41.788 del 26-12-2019**, rige desde el 01-01-2020. **No** la Ley de Presupuesto. | verificado (Acceso a la Justicia); sin decreto posterior hallado |
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
  (pendiente de cotejo con la G.O. 43.283 antes de sembrarlo).
- **Retención de IVA**: PA SNAT/2025/000054 — ver `RETENTIONS_SPEC.md`.
- Texto primario en Gaceta pendiente de archivar en `EXPEDIENTE_TECNICO.md`
  (**VALIDAR-TRIBUTARIO**).

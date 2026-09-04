# Estado regulatorio — Venezuela

> **Corte: 2026-09-02.** Este documento es el **punto de entrada** de `docs/02_COMPLIANCE/`.
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

**Los artículos que gobiernan el trabajo de Ladino, verificados al 2026-09-02 con fuentes
primarias** (cada punto con su providencia y artículo):

- **PA 00071 art. 6** — tres medios de emisión a **libre elección** del contribuyente (formatos
  libres elaborados por imprenta autorizada, formas libres, máquina fiscal), **salvo** los
  obligados del art. 8.
- **PA 00071 art. 13** — los requisitos de la factura en forma libre. Los que Ladino imprime y
  dónde: numeral 5 (nombre/razón social, **domicilio fiscal** y RIF del emisor — snapshot
  congelado, migración 34), 6 (fecha en ocho dígitos), 9 (marcador «(E)» en operaciones
  exentas/exoneradas/no sujetas), 13 (leyenda «SIN DERECHO A CRÉDITO FISCAL» en toda copia),
  14 (ambas monedas y tipo de cambio cuando la operación se expresó en moneda extranjera).
  Mapeo completo en `EMISION_FACTURAS.md`.
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

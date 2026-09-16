# ADR-0064 — Solo existe la tasa del BCV, y las dos monedas del documento fiscal

- **Estado**: aceptada. El dueño, 2026-09-16: «continúa con todo», sobre la propuesta de hacer
  los tres puntos de la investigación normativa. El mismo día precisó el §1: «no existen tasas
  propias, solo la del BCV» y «ya no permitas escribir ninguna tasa a mano. solo la del BCV».
  El §3 queda **en espera del asesor** (P-20).
- **Fecha**: 2026-09-16 (migración 66)
- **Módulos**: tasas · ventas (documentos fiscales, cobros) · inventario (valoración de
  entradas) · PDF · pantallas de tasa
- **Rigor**: máximo. Enmienda ADR-0057 en lo que toca a tasas (lo tecleado por la empresa) y
  ADR-0028 (la carga manual como fallback del adaptador BCV). El §3 enmendará ADR-0047 §4 cuando
  se implemente.
- **HOMOLOGATION_IMPACT**: YES en contenido: cambia qué tasa convierte un documento fiscal y qué
  importes imprime. La homologación de software está derogada (PA SNAT/2026/00084), pero el
  release fiscal sigue el proceso de `docs/05_INFRA/RELEASE_AND_VERSION_HOMOLOGATION.md`.
  Revisado por fiscal-reviewer el 2026-09-16.

## Contexto

El dueño pidió verificar contra la norma su modelo de monedas: el USD como referencia, todo lo
fiscal en bolívares y los fiados anclados en USD. La investigación del 2026-09-16 confirmó el
modelo. Sus fuentes están registradas en `docs/02_COMPLIANCE/REGULATORY_STATUS.md` §2:
G.O. Ext. 6.405 (Convenio Cambiario N° 1), G.O. Ext. 6.507 (COT y LIVA), G.O. Ext. 6.687
(Ley IGTF) y la compilación IVECOFI de la PA 00071. Encontró tres puntos en los que la ley pide
más de lo que Ladino hacía:

1. **La tasa.**
   - Convenio Cambiario N° 1, art. 9, Parágrafo Primero: el tipo de cambio que publica el BCV
     «será el de referencia de mercado a todos los efectos».
   - LIVA art. 25: remite al tipo de cambio corriente del día del hecho imponible.
   - Ladino (ADR-0057) dejaba que cada empresa tecleara su tasa, y a igual día la suya le ganaba
     a la oficial. Así salió una factura a 900 el mismo día en que el BCV publicaba 842,2067
     (QA de pantalla 2026-09-15, h. 70).
2. **Las dos monedas en el papel.**
   - PA 00071 art. 13.14: la factura de una operación en divisa lleva la moneda extranjera, su
     equivalente en bolívares y el tipo de cambio.
   - LIVA art. 69: pide expresamente **base imponible, impuesto y total**.
   - El PDF de Ladino solo agregaba el total en dólares.
3. **El fiado cobrado a otra tasa.**
   - Reglamento de la LIVA (Decreto 206), art. 51: si el precio en divisa está sujeto a la tasa,
     la diferencia al pagar «constituye una corrección del precio» y se documenta con nota de
     débito o de crédito. El texto se leyó en una reproducción no oficial.
   - Ladino la asienta como diferencial cambiario, sin documento.

## Decisión

### 1. Solo existe la tasa del BCV

**La conversión.** `platform.rate_for` lee **solo la tasa oficial**, para toda empresa, tenga o
no RIF:
- la oficial es la de la plataforma (`company_id` nulo), que escribe el refresco automático o el
  botón «Traer del BCV»;
- se usa la del día más reciente que no sea posterior a la fecha;
- un día sin publicación usa la última publicada, como hace el BCV en fin de semana;
- el documento sigue guardando su tasa y su fuente completa.

**Nadie escribe una tasa de empresa:**
- la política de inserción de la API solo admite la fila oficial, y solo del actor de sistema;
- `POST /v1/exchange-rates` y `POST /v1/exchange-rates/keep` («sigue igual») responden
  `409 RATE_ONLY_FROM_BCV` con su motivo;
- la entrada de inventario ya no acepta «otra tasa»: `fx` desde la API recibe el mismo 409, y
  el dominio lo conserva solo para llamantes internos que pasan la tasa congelada de un
  documento;
- las pantallas quitan la carga manual, «sigue igual» y «usar otra tasa».

**Lo que ya existía.** Las tasas tecleadas antes de la migración 66 **no se borran** (R8):
quedan como historia, que ninguna conversión lee y que el listado de tasas no muestra.

**Cómo se lee:**
- En pantalla y en el PDF la tasa se lee limpia: **«Tasa BCV: 842,2067»**, sin el servicio por
  el que llegó ni su marca de tiempo (dueño, 2026-09-16).
- Un documento emitido antes de la migración con una tasa tecleada no se rotula «BCV». Se lee
  **«Tipo de cambio: 900»**, según la fuente congelada en el documento.

**Si la fuente cae:**
- rige la última tasa publicada, y Mi dinero e Inicio dicen de qué fecha es;
- el botón «Traer del BCV» no pasa por la cota de plausibilidad del refresco automático, así
  que una devaluación real de más del 50 % se guarda pidiéndola desde ahí;
- una tasa oficial equivocada solo la corrige el operador de la plataforma, con una fila
  oficial nueva del día. Cuánto tiempo puede venderse con una tasa vieja queda como V-2 en
  `PENDIENTES_ASESOR.md`.

### 2. Las dos monedas en el PDF de un documento en divisa

El PDF imprime, además de los totales en bolívares:
- la **base imponible**, el **IVA** y el **total** en la moneda del documento;
- la **tasa**, limpia, con la cita del art. 13.14 en las facturas.

La base y el IVA en divisa son la suma de las líneas congeladas (`line_subtotal_transaction`,
`tax_amount`), las mismas que formaron el total. El recibo no fiscal conserva solo su total y
la tasa.

### 3. Fiado cobrado a otra tasa (en espera: P-20)

**Qué haría.** En una empresa que factura, el cobro de una deuda anclada en divisa a una tasa
distinta de la de emisión emitiría, en la MISMA transacción, una nota sobre la factura:
- de débito si la tasa subió, de crédito si bajó;
- por la diferencia en bolívares de la porción saldada;
- con su IVA a la alícuota de la factura.

Ese cobro dejaría de registrar diferencial cambiario, que sería contarlo dos veces. Sin rango
de numeración para la nota, el cobro se detendría con el mensaje de la puesta a punto. En modo
recibos no aplica.

**Por qué no se implementa todavía.** La fuente del art. 51 no es oficial, y un documento fiscal
automático tiene coste alto si la lectura es errónea. **VALIDAR-TRIBUTARIO P-20** (vigencia y
alcance del art. 51, período en que entra la nota, retención sobre la nota de débito).

## Consecuencias

**Documentos de empresas que tecleaban su tasa:**
- los nuevos salen a la tasa del BCV;
- los ya emitidos conservan la suya congelada;
- el saldo en bolívares de un fiado emitido con tasa tecleada se recalcula a la tasa oficial
  del día, porque la deuda está anclada en divisa (ADR-0047).

**Compras en divisa.** La factura del proveedor se convierte con la tasa del BCV de su fecha. Si
el proveedor imprimió otros bolívares, ya no hay forma de igualarlos (V-3, amplía P-19).

**ADR-0057.** Sigue vigente para reglas tributarias y de retención. En tasas lo sustituye este
ADR. pgTAP 052 cambia en esas aserciones y conserva la de aislamiento.

**Tests que cargaban tasas por la API.** Ahora siembran la oficial con `sembrarTasaOficial`
(`apps/api/test/_tasa-oficial.ts`) y la borran al terminar, porque la tabla es global.

**Despliegue.** La migración 66 y la API nueva van en la misma ventana. Con la API vieja, cargar
una tasa a mano o «sigue igual» fallaría por RLS con un error genérico.

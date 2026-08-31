# ADR-0044 — Libros fiscales: vista sobre un snapshot ampliado, con adaptadores de formato vacíos

- **Estado:** Aceptado
- **Fecha:** 2026-08-28
- **Impacto fiscal:** SÍ (el libro es un documento que el contribuyente entrega al SENIAT)
- **Aplica:** `REPORTING_AND_FISCAL_BOOKS.md`, PA SNAT/2011/00071, PA 102; extiende ADR-0038 y ADR-0042

## Contexto

El libro de ventas y el libro de compras son **obligación legal hoy** para contribuyentes
ordinarios y especiales bajo PA 071 y PA 102. No dependen de homologación, no dependen de la PA 121
derogada, y no dependen de ningún trámite externo: son un reporte que el contribuyente produce y
conserva, y que en una fiscalización se compara **contra las facturas individuales**.

De ahí el rigor: si un libro no cuadra con la suma de sus documentos origen, es una infracción
formal aunque sea por error.

Y al ir a construirlos apareció un defecto de datos que ya existía.

## El problema: el tratamiento tributario no estaba congelado

`document_lines` copiaba `tax_rule_id` y `tax_rate_snapshot` (ADR-0038), y con eso basta para
reproducir el **importe**. No basta para el **libro**, que separa en columnas legalmente distintas:

| Columna del libro | Qué agrupa |
|---|---|
| Base imponible por alícuota | `gravado_general`, `gravado_reducida`, `gravado_adicional` |
| Ventas exentas | `exento` |
| Ventas exoneradas | `exonerado` |
| No sujetas | `no_sujeto` |

Una alícuota de `0` no distingue entre las tres últimas, y son tres tratamientos con consecuencias
distintas. Leer hoy `products.tax_category_code` sería **reinterpretar el pasado con datos
actuales**, que es exactamente lo que `REPORTING_AND_FISCAL_BOOKS.md` prohíbe: *«el reporte fiscal
no recalcula el pasado con reglas actuales; lee snapshots del documento emitido»*.

Tampoco sirve derivarlo de `tax_rules`: `product_tax_category` es **nullable** ahí —`NULL` significa
«cualquiera»— así que la regla no siempre identifica el tratamiento.

## Decisión

### 1. El snapshot de emisión se AMPLÍA, de una vez

Cada línea de documento —de venta y de compra— congela además:

```
tax_category_snapshot   la categoría del producto AL EMITIR
tax_treatment           gravado | exento | exonerado | no_sujeto  (derivado y guardado)
operation_type          interna | exportacion | importacion
```

`tax_treatment` es redundante con `tax_category_snapshot` **a propósito**: la categoría es
vocabulario de producto y puede crecer (una alícuota nueva añade `gravado_*`), mientras que las
columnas del libro son cuatro y las fija la norma. Guardar las dos permite que el catálogo de
productos evolucione sin que cambie la forma del libro.

**Una migración grande ahora es más barata que cinco fragmentadas después**, y por eso las tres
columnas entran juntas aunque el libro de hoy no explote todavía `operation_type`.

Lo ya emitido queda en `NULL` y el libro lo muestra como **«tratamiento no registrado»**. No se
rellena por inferencia: un libro que adivina el pasado es peor que uno que dice qué no sabe.

### 2. El libro es una CONSULTA; cada generación oficial deja rastro

El libro no es una tabla: es `platform.sales_book(company, desde, hasta)` y sus tres hermanas. Se
recalcula siempre desde los documentos, que es lo que garantiza que cuadre con ellos.

Pero `REPORTING_AND_FISCAL_BOOKS.md` §Reproducibilidad exige persistir *parámetros, período,
timezone, versión del generador, hash del dataset, quién y cuándo*. Se concilian así:

- **consultar en pantalla no persiste nada** — es una lectura;
- **exportar para presentar deja una fila en `fiscal_book_runs`** con los siete campos y el hash
  del resultado.

Así, dos exportaciones del mismo período con el mismo dataset tienen el mismo hash, y una tercera
con hash distinto dice que algo cambió entre medias — que es justo lo que hay que poder demostrar.

### 3. La reconciliación con contabilidad incluye la cola

El IVA débito fiscal del libro **no** puede ser igual al saldo de su cuenta mientras exista la cola
de ADR-0042: un documento correcto puede estar pendiente de contabilizar. El invariante real es:

```
libro  =  mayor  +  pendientes en cola
```

y el reporte muestra **las tres cifras**. Si no cuadra ni así, hay un asiento roto, y la consulta
nombra el documento y el importe en vez de dar un total que no cuadra.

Es la cola convertida en información del reporte en vez de en un falso positivo.

### 4. Un documento con fecha en período contable CERRADO ya no se emite

Consecuencia de conectar el generador (ADR-0042) más el rollback de `err`: al emitir, el asiento se
crea en la misma transacción, el trigger de período rechaza con LAD61 y **la factura entera no
ocurre**.

Es correcto —legalmente no se emite un documento fechado en un período cerrado— y **endurece** la
regla que este ADR sustituye. La decisión anterior decía que el libro no depende del asiento; sigue
valiendo **para los documentos que ya existen**, que aparecen en el libro tengan asiento o no. Lo
que cambia es la emisión de documentos nuevos.

### 5. Los formatos de exportación son un catálogo, y el oficial nace VACÍO

```
book_format_adapters(code, book_kind, name, description, is_official, legal_source, status)
```

No hay en el repositorio ni una línea sobre el layout TXT/XML que el SENIAT exija. **No se
inventa** — misma regla que `tax_rules` (ADR-0038) y `retention_rules` (ADR-0039).

Se siembra **una** implementación, `csv_columnas_legales`, marcada `is_official = false`: CSV/XLSX
con las columnas que PA 071 y PA 102 **nombran**, que es entregable hoy a cualquier cliente. La
exportación en formato oficial falla con código propio (LAD65) diciendo que el adaptador no está
cargado.

El día que aparezca el layout, es otra fila y otra implementación de la misma interfaz: **un
enchufe, no una reescritura.**

## Consecuencias

**Positivas.** El libro cuadra con sus documentos por construcción, porque se calcula desde ellos.
Nada del pasado se reinterpreta. El mercado de contribuyentes especiales deja de estar cerrado.

**Negativas, y hay que decirlas:**

- **Lo emitido antes de la migración 27 no tiene tratamiento registrado** y el libro lo dice. No
  hay forma honesta de arreglarlo: la información no se guardó.
- **IGTF no aparece en ningún libro.** Ladino no lo calcula en ninguna parte, y `IGTF_SPEC` avisa
  además de que no toda operación en divisa lo causa. Una columna de IGTF hoy sería inventada.
- **Una factura registrada tarde reabre un mes ya presentado**: su libro es el de su fecha de
  emisión, no el del mes en curso. Es correcto y es la razón de que `fiscal_book_runs` guarde el
  hash — para poder demostrar qué se presentó y con qué datos.
- **El libro es una consulta y no está materializado.** Si el volumen lo exige, se materializa
  entonces y no antes; medir primero es más barato que mantener una vista materializada que quizá
  no hacía falta.

## Alternativas descartadas

- **Derivar el tratamiento de `tax_rules`.** Parece gratis y no funciona: la regla puede no declarar
  categoría.
- **Leer `products.tax_category_code` al generar el libro.** Reinterpreta el pasado; lo prohíbe la
  spec y sería incorrecto en cuanto un producto cambie de categoría.
- **Libros como tablas propias, escritas al emitir.** Un libro que se escribe en vez de calcularse
  puede divergir de los documentos, y la única forma de saberlo sería… calcularlo.
- **Inventar el formato TXT del SENIAT** a partir de ejemplos de internet. Es inventar una
  obligación legal (§2), y un archivo con el layout equivocado se rechaza entero.

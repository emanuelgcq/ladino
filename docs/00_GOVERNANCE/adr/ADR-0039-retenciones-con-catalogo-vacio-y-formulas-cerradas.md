# ADR-0039 — Retenciones: catálogo vacío, fórmulas de vocabulario CERRADO, y el comprobante como documento

- **Estado:** Aceptado
- **Fecha:** 2026-08-27
- **Impacto fiscal:** SÍ
- **Aplica:** extiende ADR-0038 al agente de retención; cumple `RETENTIONS_SPEC.md` e `ISLR_SPEC.md`

## Contexto

Cuando la empresa es agente de retención, al pagarle a un proveedor no le paga todo: retiene una
parte del IVA y del ISLR y la entera al fisco. Es dinero de un tercero que pasa por la empresa, y
retener de menos es una deuda tributaria propia.

**Y no hay un solo porcentaje con fuente citada en todo `docs/02_COMPLIANCE/`.** Ni el de IVA, ni
la tabla de ISLR, ni la lista de conceptos. `ISLR_SPEC.md` lo dice él mismo, en su sección «Regla
crítica»: *«No hard-codear tablas ni porcentajes. Modelar parámetros efectivos por fecha y tipo de
sujeto/concepto.»* Y `OPEN_QUESTIONS.md` §Tributario tiene «tasas y supuestos vigentes de
IVA/IGTF/retenciones» abierto.

Es exactamente la situación de ADR-0038 con la alícuota, un módulo más tarde. La respuesta es la
misma, y que sea la misma es parte del argumento: si cada hueco fiscal se resolviera a su manera,
el sistema tendría cinco formas de no saber un número.

## Decisión

### 1. `retention_rules` es dato, con vigencia y fuente, y nace VACÍA

```
retention_rules(jurisdiction, retention_code, concept_code, taxpayer_type,
                supplier_person_type, formula_kind, rate, subtrahend,
                minimum_exempt, effective_from, effective_to,
                legal_source, priority, status)
```

`legal_source` es obligatorio y con longitud mínima, igual que en `tax_rules`. Una regla de
retención sin norma citada es peor que una alícuota inventada: la alícuota inventada se la cobras
de más a tu cliente, la retención inventada **se la quitas a tu proveedor** y la enteras al fisco
en nombre de él.

La migración 22 **no siembra ni una regla**. Siembra el vocabulario —los códigos de concepto sin
porcentaje— y nada más.

### 2. `platform.resolve_retention(...)` devuelve la regla o FALLA (LAD53)

No devuelve cero ni `NULL`. La distinción es la misma de ADR-0038 y por la razón inversa: un cero
silencioso aquí **no** detiene el pago, lo deja pasar completo, y la empresa queda debiendo al
fisco una retención que nunca practicó. Un error detiene el pago y se ve.

Empate de `priority` = catálogo ambiguo = falla. Igual que `resolve_tax`.

### 3. Las fórmulas son un ENUM CERRADO, nunca una expresión evaluada

ISLR no es una tasa sobre una base: es `(base × rate) − subtrahend`, con un mínimo por debajo del
cual no se retiene. Eso obliga a que el motor sepa **más de una forma** de calcular.

`formula_kind` es un `CHECK` con dos valores, y los parámetros son **columnas nombradas**:

| `formula_kind` | Cálculo | Columnas que usa |
|---|---|---|
| `rate` | `base × rate` | `rate` |
| `rate_minus_subtrahend` | `max(0, base × rate − subtrahend)`, y 0 si `base < minimum_exempt` | `rate`, `subtrahend`, `minimum_exempt` |

**Lo que NO se hace, y es la mitad de esta decisión: `formula` no es un `text` que alguien evalúe
en runtime.** Un evaluador de expresiones dentro del motor tributario es una superficie de
ejecución arbitraria alimentada por una tabla de configuración, y el día que alguien pueda escribir
en `retention_rules` puede ejecutar. El precio de cerrarlo es que una tercera forma exige una
migración y un ADR. Ese precio se paga con gusto: una forma nueva de calcular una retención **debe**
pasar por revisión, no colarse en un `INSERT`.

`CHECK` acompañantes: `rate_minus_subtrahend` exige `subtrahend NOT NULL`; `rate` exige
`subtrahend IS NULL` y `minimum_exempt IS NULL`. Una regla con parámetros que su fórmula no usa es
una regla que alguien entendió mal, y se rechaza al insertarla.

### 4. Se calcula al registrar la factura; se aplica al pagar

La retención se **calcula y se congela** cuando se registra la factura del proveedor —con la regla
vigente a esa fecha, copiada en la fila, R-05— y se **aplica** cuando se paga: el pago al proveedor
es el neto, y la retención queda como obligación con el fisco.

> `VALIDAR-TRIBUTARIO`: la norma venezolana practica la retención de IVA **al pago o al abono en
> cuenta, lo que ocurra primero**. «Abono en cuenta» puede incluir el registro mismo de la factura.
> Ladino calcula al registrar y aplica al pagar, que cubre el caso normal; si el asesor confirma
> que el abono en cuenta dispara la obligación por sí solo, cambia **cuándo se entera**, no el
> cálculo. Está anotado donde se aplica, en el código.

### 5. El comprobante de retención es un documento con correlativo propio

Usa `fiscal_number_ranges` con `kind='retention_receipt'`, la misma mecánica atómica de ADR-0037, y
**conserva el correlativo al anular** por la misma razón: un número emitido no vuelve a estar
disponible.

> `VALIDAR-SENIAT`: PA102 exige una **máscara de 14 caracteres** para el comprobante digital y el
> formato literal no está en el repositorio. Ladino guarda el correlativo como `bigint` y **no
> inventa la máscara**. Cuando llegue, es una función de formateo sobre un número que ya existe, no
> un cambio de esquema.

### 6. Proveedor extranjero: no se retiene, y se dice por qué

Un proveedor no domiciliado no tiene RIF y las retenciones locales no le aplican del mismo modo. El
sistema **no** le calcula retención y la factura registra el documento origen del proveedor
(`supplier_document_ref`) en vez de un número de control venezolano.

> `VALIDAR-TRIBUTARIO`: hay supuestos de retención a no domiciliados en ISLR. Ladino no los aplica
> hoy porque no tiene la norma; el eje `supplier_person_type` ya está en `retention_rules` para
> cuando la haya, sin cambiar el esquema.

## Consecuencias

**Positivas.** Cero porcentajes tributarios en el código, comprobable con `grep`. Habilitar
retenciones el día que llegue la respuesta del asesor es un `INSERT` con su Gaceta, no un
despliegue. El eje de conceptos y el de tipo de sujeto ya existen, así que ISLR e IVA entran por la
misma puerta.

**Negativas, y hay que decirlas:**

- **El módulo se entrega SIN PODER RETENER.** Una empresa que sea agente de retención no podrá
  pagarle a un proveedor con retención hasta que alguien cargue las reglas. Es deliberado y es la
  mitad del valor del ADR, pero en una demo parece una avería: LAD53 dice exactamente qué concepto,
  qué jurisdicción y qué fecha no tienen regla.
- **El vocabulario cerrado de fórmulas envejece.** Dos formas cubren IVA e ISLR ordinario; no
  cubren, por ejemplo, escalas por tramos. Cuando aparezca, hay migración y ADR — que es el
  comportamiento que se quiere, no un defecto.
- **`priority` vuelve a ser un punto de fallo del catálogo**, con la misma mitigación que en
  ADR-0038: falla ruidosamente en vez de elegir arbitrariamente.
- **La retención congelada puede quedar obsoleta** si la factura se registra hoy y se paga en tres
  meses con otra norma vigente. Ladino aplica **la copiada**, que es lo correcto por R-05 y por
  ADR-0029: el hecho se rige por la regla de su fecha.

## Alternativas descartadas

- **Sembrar los porcentajes «conocidos» (75 %, 100 %, tabla de ISLR).** Es inventar una obligación
  legal (§2), y quedaría copiada en cada comprobante emitido a cada proveedor.
- **`formula` como expresión SQL evaluada.** Flexible y peligroso: ejecución arbitraria desde una
  tabla de configuración, dentro del motor tributario.
- **Retener siempre cero mientras no haya catálogo.** Es el modo de fallo silencioso: la empresa
  cree estar cumpliendo y acumula una deuda que nadie ve hasta la fiscalización.

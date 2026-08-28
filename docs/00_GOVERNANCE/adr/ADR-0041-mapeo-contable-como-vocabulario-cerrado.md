# ADR-0041 — El mapeo contable es dato, y su vocabulario es CERRADO

- **Estado:** Aceptado
- **Fecha:** 2026-08-27
- **Impacto fiscal:** SÍ (decide a qué cuenta va cada bolívar de cada operación)
- **Aplica:** ADR-0027 (la regulación es dato) al asiento contable; extiende el criterio de ADR-0039 §3

## Contexto

Cada operación del sistema —una venta, una compra, un pago, un gasto de importación— tiene que
convertirse en un asiento de partida doble. **Qué cuenta se debita y cuál se acredita no es una
decisión de Ladino: es del contador de cada empresa**, y cambia entre empresas y entre marcos
contables.

`VENEZUELA_ACCOUNTING_RULES.md` lo dice en su lista de reglas que no se deben hard-codear: el plan
de cuentas y el tratamiento de diferencias cambiarias son configuración, no código. Así que el
mapeo es dato. La pregunta no es esa. La pregunta es **cuánta expresividad tiene ese dato**.

El diseño obvio —y el que trae medio mercado— es una columna `condition_expression` con una
expresión que alguien evalúa en tiempo de ejecución, y un `account_selector` que también lo es.
Es exactamente lo que ADR-0039 §3 rechazó para las retenciones, un módulo antes, y aquí es peor:
quien escriba en esa tabla **decide dónde va el dinero de todas las operaciones futuras**.

## Decisión

### El mapeo vive en tablas; su vocabulario es un ENUM CERRADO

```
journal_templates(company_id, source_kind, source_event, condition_kind,
                  description, is_active, legal_source, effective_from…)
journal_template_lines(template_id, line_number, account_purpose, amount_source,
                       side, condition_kind, description)
```

Tres ejes, y los tres son cerrados:

| Eje | Qué es | Por qué cerrado |
|---|---|---|
| `account_purpose` | Clave de `company_account_settings` (`ar_general`, `iva_debit_fiscal`, `cogs_general`…) | La plantilla no nombra una cuenta: nombra un PAPEL. Qué cuenta cumple ese papel lo dice cada empresa, con vigencia por fecha |
| `amount_source` | Campo del documento origen (`subtotal`, `tax_amount`, `total`, `retained_iva`, `landed_to_inventory`…) | Un `text` libre sería «lee este campo del JSON», o sea SQL dinámico sobre datos del cliente |
| `condition_kind` | Predicado (`always`, `if_tax_recoverable`, `if_tax_not_recoverable`, `if_amount_nonzero`, `if_supplier_foreign`, `if_supplier_national`, `if_positive`, `if_negative`) | Es lo que sustituye a la expresión: ocho preguntas que el motor sabe contestar, y ninguna más |

**Ninguna cadena se evalúa en tiempo de ejecución.** El motor recibe un contexto tipado —los
importes del documento, banderas del proveedor y del régimen— y resuelve con un `case`. Un `grep`
de `execute`, `eval` o SQL dinámico en el generador de asientos no encuentra nada, y eso es
comprobable.

### El precio, dicho

Una forma nueva de condicionar o un campo nuevo del que tomar un importe **exigen migración y
ADR**. El asesor de una empresa no puede expresar algo raro por su cuenta.

Se paga con gusto. Este es el sitio donde se decide a qué cuenta va cada bolívar: una forma nueva
de decidirlo **debe** pasar por revisión. La flexibilidad que se pierde es exactamente la que no se
quiere tener.

### Las plantillas nacen VACÍAS

Igual que `tax_rules` (ADR-0038) y `retention_rules` (ADR-0039). La migración no siembra ni un
mapeo: sin plantilla no hay asiento automático, y lo que ocurre entonces está en ADR-0042.

`legal_source` no es obligatorio aquí —un mapeo contable no es una norma tributaria, es una
política de la empresa— pero sí lo es `description`: una plantilla sin explicación es un asiento
que nadie sabrá justificar en una auditoría.

### `company_account_settings` es versionable por fecha

Mismo patrón que `company_fiscal_regimes` (ADR-0029): `effective_from` / `effective_to` con
exclusión de solapes. Cambiar la cuenta de IVA débito fiscal en marzo no reescribe los asientos de
febrero, que ya copiaron el `account_id` resuelto.

### Sin cuenta configurada para un `purpose`, FALLA

Con código propio (LAD59) y diciendo qué papel falta. No adivina, no usa «la primera cuenta de
ingresos que encuentre», no crea una cuenta sobre la marcha. Un asiento en la cuenta equivocada es
peor que no tener asiento: el segundo se ve, el primero cuadra.

## Consecuencias

**Positivas.** Cero cuentas contables escritas en el código, comprobable con `grep`. El mapeo de
una empresa se puede auditar leyendo dos tablas. Compras, ventas, tesorería y nómina entran por la
misma puerta sin tocar el generador.

**Negativas:**

- **Ocho predicados no cubren todo**, y el noveno cuesta una migración. Es deliberado; si el ritmo
  de nuevos predicados se dispara, la señal es que el modelo de contexto está mal, no que el enum
  sea corto.
- **`account_purpose` es un catálogo que crece.** Cada operación nueva del sistema añade papeles.
  Un catálogo largo es difícil de configurar y es donde una empresa se equivoca; se mitiga con la
  pantalla, que lista los papeles sin cuenta asignada.
- **La plantilla se resuelve por `(source_kind, source_event)`**, así que un evento nuevo del
  outbox sin plantilla cae en la cola de ADR-0042 y nadie lo nota hasta que alguien la mira.

## Alternativas descartadas

- **Expresiones evaluadas.** Ejecución arbitraria desde configuración, dentro del motor que decide
  dónde va el dinero.
- **Mapeo en código.** Contradice `VENEZUELA_ACCOUNTING_RULES.md` y obliga a desplegar para que una
  empresa cambie su cuenta de ingresos.
- **Una plantilla global por defecto.** Sería sembrar un plan de cuentas por la puerta de atrás, y
  la primera empresa que no la revisara acabaría con asientos en cuentas que no son las suyas.

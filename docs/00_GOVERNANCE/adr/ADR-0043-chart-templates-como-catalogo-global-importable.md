# ADR-0043 — El plan de cuentas nace vacío; las plantillas son un catálogo global que se IMPORTA

- **Estado:** Aceptado
- **Fecha:** 2026-08-27
- **Impacto fiscal:** NO (impacto CONTABLE: `VALIDAR-CONTABLE`)
- **Aplica:** `VENEZUELA_ACCOUNTING_RULES.md` §Reglas que no se deben hard-code

## Contexto

`VENEZUELA_ACCOUNTING_RULES.md` abre su lista de cosas que no se deben hard-codear con **el plan de
cuentas**. Y tiene razón: el plan de cuentas de una empresa lo decide su contador según el marco
contable que le aplique, y dos empresas del mismo sector pueden tener planes distintos y ambos
correctos.

Pero un ERP contable cuyo plan de cuentas nace vacío y sin ayuda no es utilizable: nadie teclea
doscientas cuentas a mano para probar el sistema, y quien lo intente las teclea mal.

Las dos posturas puras fallan por lados opuestos. Sembrar un plan por empresa contradice la regla
escrita; no ofrecer nada convierte el arranque en un trabajo de dos días antes de ver una pantalla.

## Decisión

### Catálogo GLOBAL de plantillas, e importación como acto explícito

```
chart_templates(code, name, description, framework, legal_source, status)
chart_template_accounts(template_code, code, name, parent_code, kind, nature,
                        is_leaf, level, suggested_purpose)
```

El catálogo es **global**, no por empresa —misma excepción declarada que `permissions`,
`tax_rules` y `retention_concepts` (ADR-0025 §3)—, y es de **solo lectura** para todo el mundo: se
carga con migraciones, no por API.

**El plan de la empresa sigue naciendo vacío.** `accounts` no tiene una sola fila hasta que alguien
crea una cuenta o importa una plantilla. Importar es un `POST` explícito, con su permiso
(`accounting.account.manage`), que copia las cuentas de la plantilla al plan de la empresa **y las
desliga**: a partir de ahí son suyas, se editan, se desactivan y se amplían sin que la plantilla
las gobierne.

Eso es lo que hace que no sea hard-code. Un default es algo que ocurre sin que nadie lo decida;
esto no ocurre hasta que alguien pulsa un botón, y lo que copia queda bajo su responsabilidad.

### La plantilla que se siembra va marcada, y dice qué es

La migración siembra **una** plantilla, `ve_basico`, con `legal_source` que la sitúa y con el
marcado `VALIDAR-CONTABLE` en su descripción y en la respuesta de la API. No pretende ser el plan
correcto de nadie: es un punto de partida reconocible que un contador revisa en media hora en vez
de escribir en dos días.

> `VALIDAR-CONTABLE`: la clasificación exacta de cada cuenta y el marco VEN-NIF aplicable deben ser
> confirmados por contador público antes de producción, como exige
> `VENEZUELA_ACCOUNTING_RULES.md` §Principio de diseño. Ladino no afirma que este plan sea correcto
> para ninguna empresa concreta.

### `suggested_purpose`: la plantilla propone, la empresa dispone

Cada cuenta de la plantilla puede sugerir qué papel de `company_account_settings` cumpliría
(`ar_general`, `iva_debit_fiscal`…). Al importar, esas sugerencias se convierten en la
configuración inicial de papeles **de esa empresa**, que puede cambiarla entera.

Sin esto, importar doscientas cuentas dejaría el trabajo difícil sin hacer: la parte que se
equivoca no es crear las cuentas, es decir cuál es la de IVA débito fiscal.

### El gancho de la reexpresión, sembrado

La plantilla incluye una cuenta **«Reexpresión monetaria»**, sin uso todavía. El ajuste por
inflación es su propio módulo y está diferido; dejar la cuenta ahora cuesta una línea y evita que
el día que llegue haya que tocar el plan de todas las empresas ya creadas.

## Consecuencias

**Positivas.** No se contradice la regla escrita: el plan de la empresa nace vacío. Arrancar es
posible en un minuto. Añadir una plantilla nueva —por sector, por marco contable— es una migración
de datos, sin tocar código.

**Negativas:**

- **Una plantilla marcada `VALIDAR-CONTABLE` que nadie valida acaba siendo el plan real de la
  empresa.** Es el riesgo verdadero, y el esquema no puede impedirlo. Se mitiga con el marcado
  visible en la pantalla de importación y con que las cuentas importadas sean editables desde el
  primer momento; no se mitiga del todo, y por eso está escrito aquí.
- **Las cuentas importadas se desligan de la plantilla**, así que corregir la plantilla no corrige
  a quien ya importó. Es deliberado —lo contrario sería que Ladino reescribiera el plan de una
  empresa— pero significa que un error en la plantilla se propaga y no se recoge.
- **`suggested_purpose` es una opinión** y se convierte en configuración al importar. Un papel mal
  sugerido es un asiento en la cuenta equivocada, que cuadra y es falso. Por eso la pantalla de
  papeles muestra siempre qué cuenta cumple cada uno, en vez de esconderlo tras el import.

## Alternativas descartadas

- **Sembrar el plan por empresa al crearla.** Contradice `VENEZUELA_ACCOUNTING_RULES.md` y le
  asigna a cada empresa un plan que nadie decidió.
- **No ofrecer nada.** Coherente y hostil: obliga a teclear el plan entero antes de poder ver un
  asiento, y garantiza que la primera versión esté mal.
- **Plantilla viva, con las cuentas sincronizadas.** Convierte a Ladino en dueño del plan de
  cuentas de sus clientes, que es justo lo que la regla pretende evitar.

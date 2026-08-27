# ADR-0038 — Motor tributario: reglas como dato, catálogo sembrado VACÍO, sin emisión sin regla

- **Estado:** Aceptado
- **Fecha:** 2026-08-27
- **Impacto fiscal:** SÍ
- **Aplica:** regla 8 de `CLAUDE.md` y ADR-0027 (la regulación es dato) al cálculo del impuesto

## Contexto

Una factura de venta venezolana sin IVA no es una factura. Y **la alícuota no está en ningún
documento del repositorio**: `OPEN_QUESTIONS` 46-51 la tiene abierta como `VALIDAR-TRIBUTARIO`, y
`docs/02_COMPLIANCE/` no la fija con fuente citada en ninguna parte.

Eso deja tres caminos, y dos son inaceptables:

1. **Escribir `0.16` en el código.** Prohibido por la regla 8 y por §2: inventar una alícuota es
   inventar una obligación legal, y quedaría replicada en cada factura emitida.
2. **No construir ventas hasta que el asesor responda.** Bloquea el módulo entero —y con él
   compras, tesorería y devoluciones, que lo copian— por un dato que puede tardar semanas.
3. **Hacer de la alícuota un dato con vigencia y fuente, y sembrar el catálogo vacío.** Es este ADR.

## Decisión

### `tax_rules` es dato, con vigencia y fuente legal, y nace VACÍA

```
tax_rules(jurisdiction, tax_code, taxpayer_type, transaction_type,
          product_tax_category, rate, formula, effective_from, effective_to,
          legal_source, priority, version, status)
```

Cada eje ya existe como vocabulario del sistema: `taxpayer_type` viene de ADR-0033 (clientes),
`product_tax_category` de ADR-0032 (productos). `tax_rules` es donde se cruzan y donde por fin
aparece **un número** — con `effective_from`, `effective_to` y `legal_source` obligatorios.

`legal_source` no es documentación: es la aplicación de §2 al catálogo. Una regla sin norma citada
es una alícuota inventada, y aquí sería una inventada *para todas las facturas de todos los
clientes*.

**Se siembra vacía.** La migración no trae ni una alícuota. La primera la carga el operador con su
Gaceta y su fecha, cuando el asesor confirme.

### `platform.resolve_tax(fecha, jurisdicción, contraparte, producto)`

Devuelve **la** regla vigente, o **falla** (LAD50). No devuelve cero, no devuelve NULL que alguien
pueda coalescer a cero. La distinción importa: un `NULL` que se convierte en `0` produce una factura
con IVA cero que parece correcta y es un delito tributario. Un error detiene la emisión.

Cuando dos reglas cubren el mismo caso, gana la de mayor `priority`; si empatan, es una
**incoherencia del catálogo** y también falla, porque «cuál de las dos» no lo puede decidir el
sistema.

### La emisión llama a `resolve_tax` por LÍNEA, y persiste lo que resolvió

Cada `document_line` guarda `tax_rule_id` y `tax_rate_snapshot`. Es R-05 aplicado al impuesto: el
documento **copia** la alícuota, no la referencia. Cambiar `tax_rules` mañana no altera ni un
céntimo de lo emitido ayer, y una fiscalización puede ver con qué regla exacta se calculó cada
línea y qué norma la respaldaba.

### Consecuencia operativa: sin catálogo, no hay facturación

Una empresa recién creada **no puede emitir** hasta que alguien cargue las reglas de su
jurisdicción. Es deliberado y es la mitad del valor de este ADR: el sistema falla ruidosamente en
el sitio correcto en vez de emitir con un supuesto.

Los tests siembran las suyas —con `legal_source` de prueba, explícitamente marcado— así que el
módulo es completamente ejercitable sin esperar a nadie.

## Consecuencias

**Positivas.** Cero números tributarios en el código de dominio, comprobable con un `grep`. El día
que llegue la respuesta del asesor, habilitar la facturación es un `INSERT` con su fuente, no un
despliegue. Retenciones e IGTF entran por la misma puerta sin rediseño: son `tax_code` distintos.

**Negativas:**

- **Una empresa mal configurada no factura**, y el mensaje tiene que ser bueno o parecerá un fallo
  del sistema. Por eso LAD50 dice qué falta: jurisdicción, categoría y fecha concretas.
- **`priority` es un punto de fallo del catálogo**: dos reglas solapadas con la misma prioridad
  detienen la emisión. Preferible al silencio —elegir una por orden de inserción sería arbitrario y
  no reproducible— pero significa que cargar mal el catálogo rompe la facturación. Mitigación: la
  función falla con las dos reglas nombradas.
- **`formula` queda como texto reservado**, sin motor que lo interprete. Hoy solo se soporta
  `rate` sobre la base de la línea. Los impuestos que no son un porcentaje sobre la base (IGTF sobre
  el pago, retenciones sobre el total con mínimos) **no entran todavía** y su cálculo se difiere con
  su propio ADR. La columna existe para que añadirlos no sea una migración de esquema.
- No cubre la base imponible compuesta (descuentos, fletes, exenciones parciales). La base es hoy el
  total de la línea; refinarla es una decisión tributaria más, con su fuente.

**Revertir:** trivial mientras la tabla esté vacía, que es como nace.

## Verificación

pgTAP 021: emitir sin regla vigente para la fecha muere con LAD50; con regla vigente, el
`tax_rate_snapshot` persistido es **igual** al del catálogo en ese momento; **cambiar
`tax_rules` después no altera la factura emitida** (se compara la línea antes y después); dos reglas
con la misma prioridad para el mismo caso detienen la emisión en vez de elegir una.

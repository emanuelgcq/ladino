# ADR-0073 — Las alícuotas son un catálogo con fuente

- **Estado:** ADR aplicado según la respuesta del dueño del 2026-09-28 (§2.5; B-02, B-04, B-11,
  E-04, E-18)
- **Fecha:** 2026-09-28
- **Impacto fiscal:** SÍ.
- **Enmienda:** ADR-0038 (motor tributario) y ADR-0057 (la regla aceptada es de la empresa): se
  concilian.

## Contexto

- **B-04:** Ladino deja elegir la alícuota reducida, la adicional, lo exonerado y lo no sujeto,
  pero no deja venderlos.
- **E-18:** los alimentos de la cesta básica, exentos por la LIVA art. 18.1, se facturaron con IVA.
- **E-04:** la factura no discrimina la base ni el IVA por alícuota.
- **B-02:** aceptar el IVA otra vez con otro porcentaje deja un acta que no se aplica.
- **B-11:** la interfaz dice «hoy 16 %» fijo.

ADR-0057 decidió que las reglas no se siembran: la empresa las acepta y son suyas. La respuesta del
dueño manda sembrar la norma como data, con su cita.

## Decisión

1. **Condición fiscal por producto:**
   - `gravado_general`: 16 %;
   - `reducida`: 8 %, LIVA art. 64;
   - `adicional_suntuario`: 16 % + 15 %, art. 61;
   - `exento`: arts. 17-19;
   - `exonerado`: con decreto vigente, número y vigencia;
   - `no_sujeto`.
   Por omisión, `gravado_general`. La importación la acepta.
2. **Catálogo de plataforma con fuente.** Cada alícuota es una fila de plantilla con norma, artículo,
   Gaceta y vigencia (`docs/02_COMPLIANCE/IVA_SPEC.md`).
   - La general la fija el **Decreto 4.079** (G.O. 41.788) sobre el art. 27. Manda la norma sobre el
     documento del dueño, que decía «Ley de Presupuesto».
   - Lo que esté «pendiente de fuente» no se ofrece: `no_sujeto` (art. 16) y los literales del art.
     18 sin confirmar.
   - La adicional del art. 62 (pagos en divisas) **no se siembra** hasta que exista el decreto que
     la active.
3. **Conciliación con ADR-0057.** La empresa **acepta** su alícuota general desde el catálogo, con
   acta, y la regla aceptada es suya.
   - Solo valores dentro del 8-16,5 % (art. 27), con fuente. El 0 % no es una alícuota general.
   - Aceptar otra vez cierra la vigencia actual y abre otra desde la fecha efectiva (B-02).
   - Las exentas y la reducida vienen del catálogo con su cita. No hay nada que aceptar: es ley.
4. **La cesta básica** (art. 18.1) se siembra como lista de categorías exentas, con cita por
   literal. Los literales de fuente secundaria llevan esa marca, y los no confirmados no se
   ofrecen.
5. **De punta a punta:**
   - la caja vende cualquier condición;
   - la factura discrimina base e IVA por alícuota con su porcentaje, con «(E)» en lo exento,
     exonerado o no sujeto (arts. 13.8, 13.10 y 13.11);
   - el libro separa por alícuota y trae el resumen del art. 72 del RLIVA;
   - la declaración suma por alícuota;
   - la interfaz lee el porcentaje de `tax_rules`, nunca fijo (B-11).

## Consecuencias

- **Positivas.** Se venden todas las condiciones, y el papel y el libro dicen lo que la norma exige.
- **Negativas.**
  - Hay una plantilla de reglas de plataforma además de las de empresa.
  - Los productos existentes quedan como `gravado_general` hasta que alguien los reclasifique. En el
    escenario se corrige el producto de la cesta básica; en producción no se toca nada.
- **Para revertir:** las plantillas son data. Las reglas aceptadas por cada empresa siguen siendo
  suyas.

## Verificación

- E2E: una venta con líneas al 16 %, al 8 % y exentas. La factura, el libro y la declaración
  discriminan por alícuota.
- pgTAP: una general del 0 % o fuera de rango se rechaza.
- `pnpm recorrido B` y `pnpm recorrido E`.

## Nota de aplicación (2026-09-29, revisión de la familia)

Decidido por criterio (RESPUESTA §2.16), cada uno con su alternativa:

- **Una regla con líneas emitidas se cierra, nunca se retira** (migración 20260928150200). Reaceptar
  la general el mismo día en que ya se facturó con la anterior se rechaza con LAD97 («Hoy ya se
  facturó al 16 %: la nueva tasa puede regir desde mañana») y la persona elige la fecha efectiva
  (`effective_from` opcional en `POST /v1/fiscal/iva-general`, nunca antes de hoy; en la puesta a
  punto fiscal, «Cambiar la alícuota general» para quien tiene `tax.rules.manage`). Sin líneas, la
  regla del día se reemplaza. Un trigger lo impide por cualquier otro camino, y la migración reactiva
  con su vigencia cerrada lo que ya se hubiera retirado. *Alternativa:* correr la tasa nueva sola a
  mañana, sin preguntar.
- **El servidor aplica `offered_in_sales`**: crear un producto o cambiarle la clasificación a una
  categoría que el catálogo no ofrece en ventas (`no_sujeto`, `exonerado`) da 422. La importación
  lo hereda porque crea con `createProduct`. *Alternativa:* solo esconderla en la pantalla.
- **El resumen del art. 72 va firmado en el hash del libro de ventas exportado** (norma primero: el
  RLIVA art. 72 lo pide en el libro) **y se descarga como fichero propio de la misma generación**:
  `POST /v1/fiscal-books/runs/{id}/summary-art72` devuelve `resumen-art72.csv`, con el rótulo
  «RESUMEN (RLIVA art. 72)», el mismo permiso (`fiscal_book.export`) y la misma idempotencia que la
  exportación. No crea otra generación ni cambia el hash; si el libro cambió desde esa generación, 422
  y hay que volver a exportar. En Libros, «Descargar el resumen (art. 72)» junto al botón del libro.
  El CSV «columnas legales» sigue siendo solo cabecera + renglones, legible por máquina.
  *Alternativa:* el bloque al final del mismo CSV, que exigiría cambiar la aserción existente
  `apps/api/test/e2e-fiscal-books.test.ts:404` (`toHaveLength(row_count + 1)`).
- **La adicional se factura como una alícuota, general + adicional (31 %)**, en una línea del pie,
  como la categoría «general más adicional» del art. 72. Pregunta VALIDAR-SENIAT en
  PENDIENTES_ASESOR P-53. *Alternativa:* discriminar 16 % y 15 % por separado.
- **Se reutilizan los códigos `gravado_reducida` y `gravado_adicional`** de `product_tax_categories`
  como la «reducida» y la «adicional_suntuario» de la respuesta del dueño. *Alternativa:* renombrarlos
  con una migración de datos (toca el FK de `products` y el contrato).
- `tax_exemption_literals` es un catálogo de referencia: todavía no se vincula al producto.

### Re-revisión (2026-10-02), decidido por criterio

- **B1 · el hash firma el libro legal**: fuera `journal_entry_id` y el estado operativo; entra el
  estado legal (anulada / vigente). La exportación de ventas devuelve el resumen del art. 72 en la
  misma respuesta, y la ruta hermana compara primero la versión del generador. *Alternativa:* guardar
  el hash del resumen en la generación.
- **B2 · la reparación es una función** (`platform.repair_retired_referenced_tax_rules`, migración
  20260928150300) con pgTAP y una postcondición que hace fallar la migración si quedan reglas propias
  activas solapadas o reglas inactivas con líneas emitidas.
- **B6 · la guarda no depende de la RLS**: `platform.tax_rule_is_referenced` es SECURITY DEFINER con
  `search_path` fijo y solo devuelve el booleano. *Alternativa:* INVOKER, confiando en que quien
  retira una regla ve todas las líneas.
- **B4**: la categoría por omisión de la empresa también tiene que estar ofrecida en ventas (422).

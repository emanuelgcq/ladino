# ADR-0071 — Un correlativo de control por emisor

- **Estado:** ADR aplicado según la respuesta del dueño del 2026-09-28 (§2.1-2.4; G-01, E-01, B-03)
- **Fecha:** 2026-09-28
- **Impacto fiscal:** SÍ. Cambia cómo se asigna e imprime el número de control y qué se imprime en
  la forma libre.
- **Hallazgos:** G-01, E-01, B-03, E-04, E-10, G-02, G-09, E-17, G-16, A-11, B-08.
- **Enmienda:** ADR-0037 (numeración: un rango por empresa, clase y serie).

## Contexto

ADR-0037 modeló un rango de control por empresa, **clase** de documento y serie, y el índice único
del control incluye la clase. El recorrido encontró tres cosas:

- **G-01:** una factura y una nota de crédito con el mismo número de control. Ladino aceptó un rango
  de notas que pisaba el de facturas.
- **E-01:** la serie la decide el servidor («A»). Con un talonario en serie B, la caja no vende, y la
  única salida era declarar un rango que no existe en el papel.
- **B-03:** el talonario no nombra el número de control ni guarda los datos de la imprenta.

La norma lo resuelve:

- **PA 00071 art. 44:** la numeración de control es consecutiva y **única por emisor**, con dos
  campos: un identificador de 2 dígitos y un secuencial de hasta 8.
- **Art. 31:** en forma libre, la imprenta preimprime el control, el RIF del emisor, sus propios
  datos y providencia, el rango y la fecha de elaboración, **nunca** la clase ni el número del
  documento. Un mismo talonario sirve para facturas, notas de crédito y notas de débito.

## Opciones consideradas

1. **Rangos por clase sin solape.** En contra: la norma no los prevé, y una empresa con un solo
   talonario no puede partirlo.
2. **Un correlativo por empresa e identificador, compartido por las tres clases.** Es la opción
   elegida por el dueño. Si el asesor demuestra que se admiten tramos por clase, se modela como
   opción de datos por empresa, no como código.

## Decisión

1. **El rango de control se registra una vez**, por empresa e **identificador** (2 dígitos). Lleva:
   - desde y hasta (hasta 8 dígitos);
   - razón social y RIF de la imprenta (validado), nomenclatura y fecha de su providencia;
   - fecha de elaboración (8 dígitos);
   - la serie, si el papel la trae.
   **Sin los datos de la imprenta no hay rango.**
2. **Ningún solape es posible.** Una restricción de exclusión en la base sobre `(empresa,
   identificador, rango)`, y el índice único de control pasa a `(empresa, identificador,
   control)`, **sin la clase**. Cada documento fiscal (factura, NC o ND) consume el siguiente
   control del talonario activo, sea de la clase que sea. El número del documento sigue siendo
   correlativo por clase y serie.
3. **La serie la dicta el talonario**, nunca el servidor. Con varios talonarios activos, la caja
   elige y recuerda el último. La puesta a punto comprueba que haya un rango activo con papel
   disponible para el identificador en uso, no «un rango por tipo de documento».
4. **Impresión.**
   - El control se registra siempre y se imprime con su identificador: `00-00001234`.
   - Imprimirlo en el cuerpo es un ajuste por empresa, activo por omisión, que nunca imprime sobre
     la casilla preimpresa.
   - Lo que la imprenta preimprime (art. 31) queda en blanco en el papel y sombreado en la vista
     previa.
   - El diálogo de impresión enseña «Próximo control: 00-00001234».
   - El PDF descargado o enviado lleva «Copia de cortesía · La factura válida es la impresa en forma
     libre con control N° …».
   - Las copias llevan «SIN DERECHO A CRÉDITO FISCAL», y ninguna otra leyenda legal: nada de
     homologación ni de la PA 121.
5. **Contenido.** La factura, la NC y la ND cumplen `docs/02_COMPLIANCE/FACTURA_CHECKLIST.md`, y un
   test la recorre sobre el documento real de cada clase.
6. **Lo emitido no se toca** (regla 1). Si un emisor ya tiene controles repetidos, la migración del
   índice nuevo **falla con la lista**: no se renumera nada en silencio. En el escenario local se
   corrige el escenario. En producción no hay clientes reales (dueño, 2026-09-28): se revisa en solo
   lectura antes de aplicar.

## Consecuencias

- **Positivas.** Un control único por emisor, como exige la norma. La serie y el rango son los del
  papel. El documento dice de dónde salió.
- **Negativas.**
  - La numeración de control deja de poder partirse por clase.
  - Una migración de datos le pone el identificador «00» a los rangos existentes.
  - La puesta a punto y la caja cambian de pantalla.
- **Para revertir:** volver a incluir la clase en el índice. La restricción de exclusión se puede
  quitar. Los datos de la imprenta quedan.

## Verificación

- pgTAP 075: un rango que pisa otro se rechaza con 23P01.
- pgTAP 080 (migraciones 20260928160000 y 160100): exclusión, índice sin clase, claim compartido,
  mensajes, inmutabilidades y las variantes rotas (sin exclusión el solape entra; sin índice los
  repetidos entran y `control_number_collisions()` los lista).
- pgTAP 086 (20260928160200 y 160300): «Contingencia-B» sin registro de contingencia se rechaza al
  commit, corrección de imprenta solo con acta, anulación solo sin emitir, emisión sin identificador,
  serie vacía; con sus variantes rotas.
- `control_number_collisions()` y `control_range_overlaps()` en los invariantes del recorrido.
- pgTAP 087 (20260928180000, 180100 y 180200): `company_settings.print_control_number` nace encendido,
  NOT NULL con su variante rota, `ladino_api` lo cambia en su tenant y no en el ajeno; el régimen se
  llama «Formas libres» y el CSV de libros cita el RLIVA.
- El test de la checklist del art. 13 sobre el PDF de cada clase: `apps/api/test/e2e-checklist-factura.test.ts`
  (factura, NC, ND, recibo y recibo de devolución; cortesía, papel y vista previa).
- `pnpm recorrido E` y `pnpm recorrido G`: G-01 y E-01 dejan de reproducir.

## Nota de aplicación (revisión de la parte 1, 2026-09-29)

Decidido por criterio (RESPUESTA §2.15 acta y §2.16 lo reversible), no por el dueño:

- **Corrección y anulación del talonario (H3).** `POST /v1/fiscal-number-ranges/{id}/printer-correction`
  con motivo (≥ 10) y acta `fiscal.range.printer_corrected` que guarda lo anterior y lo nuevo,
  permitida siempre porque lo emitido lleva impreso lo que la imprenta preimprimió; el trigger solo
  la admite con el id de esa acta en el GUC `ladino.range_printer_correction`. `POST …/{id}/cancel`
  con motivo y acta `fiscal.range.cancelled`, solo si el talonario no emitió nada. El identificador
  cambia solo mientras no haya emitido. **Alternativa:** solo anular y registrar de nuevo.
- **La serie es opcional (H11).** Serie vacía = el papel no trae serie; un formateador único
  (`serieYNumero`) omite el guion. **Alternativa:** exigir siempre una serie. Qué se imprime en 13.2:
  P-54 (VALIDAR-SENIAT).
- **«Contingencia…» es solo de la contingencia (H1).** Una serie con ese nombre exige su registro de
  contingencia al commit; el registro normal la rechaza. **Alternativa:** una columna explícita
  `is_contingency` en el rango.
- **El motivo del 409 de numeración (H10).** El code sigue siendo `FISCAL_NUMBERING_INVALID` (lo
  asevera `apps/api/test/e2e-sales.test.ts:343`) y se añade `details.reason` (contrato aditivo):
  `regime_missing`, `no_range` o `printer_data_incomplete`; `range_exhausted` no se distingue de
  `no_range` (el claim no los separa). La web elige la salida por el motivo y el permiso
  (`apps/web/src/pages/ventas/salida-numeracion.ts`). **Alternativa:** un code propio, que exigiría
  cambiar esa aserción.
- **El orden de bloqueo de la emisión (H2 y A1).** Todo camino que emite con control toma el advisory
  de clase y serie de `claim_document_number` → la fila del talonario → las existencias. La
  devolución, que reingresa antes de emitir su NC, pide los dos primeros por adelantado
  (`bloquearTalonario`, con el comentario único del orden global en `packages/domain/src/talonario.ts`).
  Sin prueba determinista de dos sesiones: ver el informe. **Alternativa:** emitir la NC antes del
  reingreso.
- **Emitir sin identificador (H9).** La transición a `issued` con control y sin identificador es
  LAD49 (20260928160200). **No extendido al INSERT directo emitido (A6):** diecisiete pgTAP y tres
  E2E insertan documentos emitidos con control y sin identificador como fixture; extenderlo exige
  tocarlos todos (varios son de otros agentes en esta ola). El «00» por omisión se queda para ese
  INSERT hasta que se decida.
- **La alícuota de la NC (hallazgo 3 de la auditoría fiscal).** La NC que acredita líneas toma
  de cada línea de la factura su tasa, categoría, regla y descripción congeladas: revierte el débito
  de la factura. VALIDAR-TRIBUTARIO P-58. **Alternativa:** la regla vigente a la fecha de la nota.
- **La tasa de la ND (hallazgo 13, §2.7).** `CreateDebitNoteRequest.basis` (aditivo):
  `corrects_invoice` (por omisión) va a la tasa de la factura; `new_concept` va a la tasa BCV de
  su día. `documents.rate_basis` (migración 20260928160500) lo registra, inmutable al emitir, y el
  PDF imprime la tasa de su día con su fecha. **Alternativa:** que la ND siempre vaya a la tasa
  de la factura.
- **La ND que corrige una línea (B-5).** Con `source_line_id` (aditivo en `CreateDebitNoteRequest`)
  la ND va a la alícuota de esa línea, como la NC; sin línea, a la de hoy (P-58 ampliada). La base
  de la tasa es solo de las notas y `own_day` solo de la ND (CHECK, migración 20260928160600).
  **Alternativa:** la ND siempre a la condición de hoy.
- **El acta de corrección (A3).** Es de ESTA transacción (`payload.txid = pg_current_xact_id()`) y
  su `despues` es exactamente lo que se escribe (20260928160400). **Contratos:** los endpoints
  nuevos (`/printer-correction`, `/cancel`) y `details.reason` los cubre la autorización del dueño
  a los cambios de contrato de este plan (RESPUESTA §2.16).

## Nota de aplicación (revisión de la parte 2, el papel, 2026-09-29)

Decidido por criterio (RESPUESTA §2.16), no por el dueño:

- **§4 · `print_control_number` es presentación (H12).** Vive en `company_settings` y se lee AL
  IMPRIMIR, no al emitir: apagarlo o encenderlo cambia el papel de los documentos ya emitidos, porque
  el control está registrado en el documento siempre y lo único que decide el ajuste es si se repite
  en el cuerpo. **Alternativa:** congelar el ajuste en el documento al emitirlo.
- **`?destino=cortesia` explícito se acepta (H7, menor sorpresa).** Es lo mismo que sin destino;
  cualquier otro valor da 422 con un mensaje que nombra los tres. **Alternativa:** aceptar solo
  `papel` y `vista` y tratar `cortesia` como error.
- **La «Venta lista» de la caja ofrece «Imprimir en la forma libre» para una factura (H14, §2.1).**
  Mismo diálogo que el detalle (`apps/web/src/components/ImprimirFormaLibre.tsx`), con «Próximo
  control»; además del PDF de cortesía. El recibo no lo ofrece; WhatsApp no se repone (E-06).
  **Alternativa:** imprimir sobre la forma libre solo desde el detalle del documento.
- **La marca de cortesía nombra la clase (concordancia).** «La factura válida…», «La nota de crédito
  válida…», «La nota de débito válida…», y solo en las clases fiscales: la cotización y el pedido no
  la llevan (H2). La marca y el pie van en CADA página (H1). **Alternativa:** el texto literal «La
  factura válida…» en toda clase.
- **La franja preimpresa tiene el mismo alto en la vista y en el papel (H9)**; su posición es genérica
  (R-60). Una factura que no cabe en una hoja: ver la nota de la auditoría fiscal (art. 33), abajo;
  P-55 está cerrada.

## Nota de aplicación (auditoría fiscal de la ola 2, 2026-10-02)

RESPUESTA §0: si la norma vigente contradice una decisión, manda la norma. Fuente de los tres
artículos: PA SNAT/2011/00071 en https://tributos.ivecofi.net (reproducción no oficial), verificada
el 2026-10-02 por el auditor-fiscal; cargada en REGULATORY_STATUS.md.

- **Art. 33 · un documento, una forma libre (corrige P-55 y la nota anterior).** Cada factura, NC o ND
  sobre forma libre ocupa UNA página; si la operación no cabe, se emiten varios documentos, cada uno
  con su número. Lo que esta ADR daba por bueno —«las líneas siguen en la hoja siguiente»— queda
  corregido. **Decidido por criterio, opción (a):** un tope de líneas por documento, ajuste por
  empresa (`company_settings.rows_per_free_form`, migración 20260928180300; por omisión 15, máximo
  18: medido, caben 22 líneas de una fila en una página). El dominio lo exige al emitir (422 «No cabe
  en una forma libre: divide la venta en varias facturas (máximo N líneas)»), la caja y la factura de
  administración avisan antes, y `?destino=papel` rechaza un documento que pase de una página
  (defensa: una descripción larga ocupa varias filas). La marca de cortesía en cada página se queda
  para el PDF de cortesía, que sí puede tener varias. **Alternativa (b):** partir la operación sola en
  varios documentos. FC-34.
- **Arts. 26-27 · la palabra «serie».** En el papel, el número va precedido de «Serie» —«Serie A N°
  00000001»— y, sin serie, solo el número («N° 00000001»): `serieYNumeroImpreso`. La pantalla sigue
  con `serieYNumero` («A-00000001»). P-54 (2) reformulada: ¿hacen falta series con un sistema
  centralizado (art. 27)?
- **Art. 13.7 · el adquirente identificado (VALIDAR-SENIAT P-57, lectura conservadora).** Sobre forma
  libre, factura, NC y ND exigen nombre y RIF, cédula o pasaporte; el «Consumidor final» y
  `allow_unidentified_sales` quedan para los recibos. Dominio (422) y base (LAD99, migración
  20260928190400, que parte de la definición viva de 190100 y por eso lleva un timestamp posterior).
  El PDF rotula «Pasaporte» cuando lo es. Riesgo: R-63.

## Nota de aplicación (revisión de la auditoría fiscal, 2026-10-02)

Decidido por criterio (RESPUESTA §2.16), con su alternativa:

- **A-2 · el tope cuenta FILAS IMPRESAS, no líneas.** Una sola función, `partirEnFilas` /
  `filasDeDescripcion` / `filasDelMotivo` en `packages/schemas/src/forma-libre.ts`, parte la
  descripción (45 caracteres por fila) y el motivo de la nota (75) por palabras. El PDF imprime con
  ESA partición, no con el ajuste automático de pdfkit; `exigeFormaLibre` suma las filas de las
  líneas y, en NC y ND, las del motivo. El ajuste pasa a `rows_per_free_form` (migración
  20260928190500): por omisión 15, máximo 18, medido (una factura en USD de 18 filas y una ND de 17
  líneas más su motivo caben en una página de la vista y del papel). El papel conserva su 422 como
  red, y además rechaza si el cuerpo invade la franja del pie (A-7); una línea no se parte entre dos
  páginas (A-8). **Alternativa rechazada:** truncar la descripción impresa a una fila — el art. 13
  exige la descripción.
- **A-3 · la contingencia refleja un papel que ya existe.** Su registro a posteriori
  (`registerContingencyInvoice` → `createInvoice(…, true)`) no aplica el tope ni la exigencia del
  adquirente, y la base tampoco (serie de un talonario de `contingency_ranges`). **Alternativa:**
  exigir lo mismo que a la factura nueva, con el riesgo de no poder registrar un papel ya entregado.
- **A-4/A-6 · la nota identifica como su factura (regla 1).** La NC y la ND no siguen el 13.7: van al
  MISMO cliente con la identificación CONGELADA de la factura que corrigen (el dominio copia lo
  congelado del origen al emitir la nota; la base lo exige, LAD99). Una factura vieja al
  «Consumidor final» tiene su NC: R-63 queda resuelto. **Alternativa:** exigir el 13.7 también a la
  nota, dejando sin corrección posible las facturas viejas al Consumidor final.
- **F3 · `delivery_note` fuera del bloque del adquirente**, a la vista, con P-62 (VALIDAR-SENIAT).


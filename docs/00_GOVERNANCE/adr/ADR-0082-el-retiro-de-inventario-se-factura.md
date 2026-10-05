# ADR-0082 — El retiro de inventario se factura

- **Estado:** Manda la norma (RESPUESTA §0): RLIVA art. 31, leído en reproducción no oficial el 2026-10-03; VALIDAR-SENIAT P-76. Hallazgos de la auditoría fiscal de la ola 3: AF3-01, AF3-03, AF3-04, AF3-05, AF3-06 y AF3-07 (AF3-06 y la contabilidad de AF3-03, en la segunda ronda).
- **Fecha:** 2026-10-04.
- **Impacto fiscal:** SÍ: documento fiscal, numeración de control, libro de ventas y declaración. `HOMOLOGATION_IMPACT = YES`.
- **Enmienda:** ADR-0078 (decisión 2 de su nota de aplicación: «la Nota de retiro no consume número de control»). **Toca:** ADR-0071 (el talonario: la factura de retiro gasta papel de la serie de facturas) y ADR-0061 (la anulación).

## Contexto

ADR-0078 decidió que el retiro de inventario (consumo propio, regalo, donación, muestra) emitía un
documento **interno**, la «Nota de retiro», serie NR, sin número de control. La auditoría fiscal
(AF3-01) trajo la norma, que dice otra cosa. RLIVA (Decreto 206, G.O. 5.363 Ext., 12-07-1999),
art. 31, según reproducción no oficial (cotejo con la Gaceta pendiente):

> «Para el caso de retiro, desincorporación, autoconsumo y faltante en los inventarios de bienes
> muebles […] se entenderán ocurridos o perfeccionados los hechos imponibles […] en el momento en
> que sucedan dichos hechos, oportunidad en que deberá emitirse obligatoriamente la correspondiente
> factura por parte del contribuyente y efectuarse su registro en la columna especial del Libro de
> Ventas.»

Restricciones: una factura emitida no se edita (regla 1); el control sale del talonario de la
imprenta (ADR-0071); la deuda de clientes se lee en una docena de sitios y ninguno debe contar un
documento cuyo adquirente es la propia empresa; inventario no puede importar ventas (ADR-0021:
ventas ya importa inventario).

## Opciones consideradas

1. **Factura normal (`kind = 'invoice'`) con una marca.** A favor: todo lo fiscal la lee sin
   tocar nada. En contra: cada lectura de DEUDA tendría que excluirla (deuda de hoy, vencido,
   antigüedad, cartera contra el mayor, revaluación). Es una lista de perdones, y el olvido es
   **silencioso**: una deuda que nadie tiene aparece en una cartera.
2. **Un kind nuevo, `withdrawal_invoice`.** A favor: las lecturas de deuda enumeran en positivo
   los kinds que cargan cartera (`invoice`, `receipt`, `debit_note`), así que el nuevo queda fuera
   de todas **por construcción**, sin tocar ninguna. En contra: las lecturas FISCALES hay que
   ampliarlas una a una (libro, declaración, importes, regla del papel). Pero ese olvido hace
   **ruido**: un invariante que cruza módulos se pone rojo.
3. **`customer_id` nulo en el documento.** Descartada: cambia el contrato público de la respuesta
   y hace desaparecer el documento, en silencio, de toda lectura que una con `customers`.

## Decisión

**Opción 2.** Entre dos modos de fallo se elige el ruidoso.

1. **El retiro gravado emite una FACTURA DE RETIRO** (`documents.kind = 'withdrawal_invoice'`) por
   el camino de la venta: `insertarDocumento`, correlativo de la **serie de facturas** (el mismo
   contador), número de **control del talonario** y `assert_document_issuance`. La Nota de retiro
   deja de emitirse.
2. **El adquirente es la propia empresa**, congelado en el documento: su razón social y su RIF
   (los del emisor) y su tipo de contribuyente **leído de la historia a la fecha del hecho**
   (AF3-07), nunca `coalesce(…, 'ordinario')` ni `companies` en vivo. El esquema lo exige al emitir.
3. **La base es el precio de venta de la lista principal** vigente (RLIVA art. 43); sin precio, o
   con precio cero, el retiro **se rechaza** (AF3-05). El piso de mercado queda en P-75.
4. **No nace cuenta por cobrar.** Su asiento es el de su salida del kardex (hecho
   `inventory_move/stock.withdrawn`: gasto por retiro al costo + débito fiscal contra inventario).
   Por construcción: (a) su kind no está en ninguna lectura de deuda, límite, vencido ni cartera;
   (b) no pasa por la puerta del fiado (`exigirFiado`): la emite `issueStock`, no `emitirVenta`;
   (c) la base rechaza activamente cobrarla, devolverla, dejarla «pagada» o darle vencimiento.
5. **La salida guarda el documento y el documento guarda la salida** (`withdrawal_move_id`, único:
   una salida, una factura). La factura se emite ANTES de mover el kardex —el mismo orden de
   candados que la venta: talonario → existencia— con el id de la salida ya decidido; todo ocurre
   en una transacción, y si la existencia no alcanza no queda ni la factura ni su número.
6. **Se anula como una factura** (ADR-0061, regla del papel): el mismo día, antes del cierre de
   caja, con el original y las copias en la mano. Anularla repone la mercancía a su valor y reversa
   su asiento.
7. **Motivos no gravados (AF3-03; LIVA art. 4.3 in fine, P-82):** «uso en el negocio», «pasa a
   activo fijo» e «incorporado a un inmueble del negocio» salen del kardex **sin débito fiscal y
   sin factura**.
8. **Empresa sin RIF:** como antes; solo la salida de kardex y el gasto.
9. **`withdrawal_note_gaps()` cambia de enunciado:** desde el corte
   (`platform.invariant_cutoffs`, `withdrawal_invoice`), retiro gravado ⇒ factura de retiro con su
   IVA en el asiento, sin cartera y a nombre de la propia empresa. Las Notas NR ya emitidas no se
   tocan (append-only) y siguen en el libro; antes del corte, la nota sigue valiendo. Está en el
   enunciado, no en una lista de exclusiones.

**Decidido por criterio (§2.16), con su alternativa:**

- **La ficha del adquirente.** El documento referencia una ficha de cliente: se usa la que ya
  tenga el RIF de la empresa, o se crea una con sus datos. Lo que el papel dice sale del congelado.
  *Alternativa:* `customer_id` nulo (opción 3).
- **AF3-03, la contrapartida contable.** ~~Los tres motivos no gravados asientan en la misma
  cuenta de retiros (5.1.09).~~ Sustituido en la segunda ronda: cada uno a su papel (ver abajo).
- **AF3-02b, el faltante sin justificar.** Sigue **rechazado** (exige evidencia). La base del
  art. 13 —costo más el porcentaje de utilidad bruta del último balance— necesita un dato que la
  empresa no tiene cargado y que no se inventa. *Alternativa:* facturarlo al precio de lista. P-81.
- **AF3-04, la evidencia.** Mínimo diez caracteres y dos palabras, en el caso de uso (el CHECK de
  la base sigue en tres caracteres: la API saliente escribe contra ella). La merma justificada en
  el libro de ventas y el aviso de tres días NO se construyen sin respuesta (P-77).
- **El contribuyente formal** no retira un producto gravado: la misma regla que le impide
  venderlo (LIVA art. 8, M-10). *Alternativa:* dejarlo retirar sin débito.
- **La pantalla** dice qué va a emitir con las cifras del SERVIDOR antes de confirmar
  (`POST /v1/inventory/issues/preview`: la serie, la base y el IVA, o que no se emite nada y por
  qué). El servidor ENSAYA la salida entera dentro de un savepoint y la deshace —no hay una
  segunda regla que pueda divergir— y no gasta correlativo ni control. El número no se promete:
  lo asigna el talonario al emitir. Tras confirmar, dice el número, el control y el IVA.
  *Alternativa (la de la primera ronda):* decir solo la regla, sin cifras.

## Consecuencias

- **Positivas:** el retiro tributa con el documento que la norma pide; ninguna lectura de deuda
  cambió; un retiro sin factura es imposible por construcción y lo vigila un invariante.
- **Negativas y deuda que se acepta:**
  - cada retiro **gasta papel del talonario**: un negocio que regala muestras a diario lo nota;
  - se crea una ficha de cliente con el nombre del propio negocio. NO es visible en Clientes
    (marca `own_company`, migración 20261005100600; la primera ronda decía «visible» y la
    segunda lo cambió sin corregir esta línea);
  - toda lectura fiscal nueva por `kind = 'invoice'` tiene que acordarse del kind nuevo (el olvido
    lo cazan `withdrawal_note_gaps`, `book_ledger_reconciliation` y `accounting_coverage_gaps`);
  - quedan dos caminos en el libro para el mismo hecho: las Notas NR viejas y las facturas nuevas;
  - la tabla de notas sigue aceptando INSERT hasta que se despliegue la API (expand/contract).
- **Para revertirla:** sin facturas de retiro emitidas, reversible entera. **Con una sola emitida,
  no:** es un documento fiscal con control consumido.

## Segunda ronda (2026-10-04): las dos decisiones que la primera dejó paradas

La primera entrega paró en dos decisiones que no eran del reparador. Las tomó el dueño por §2.16.

### AF3-06 · La nota de crédito de un retiro (migración 20261005100500)

Un retiro facturado por error y descubierto al día siguiente no puede quedarse sin corrección
fiscal. **Decidido por criterio, con su alternativa:**

- **Es TOTAL:** deja sin efecto el retiro entero (PA 00071 art. 22: operación que queda sin
  efecto). Una por factura. *Alternativa descartada:* parcial por línea — más superficie; queda
  en el backlog, y la pantalla lo dice: «para corregir solo una parte, deja sin efecto el retiro
  entero con la nota y regístralo de nuevo».
- **Un kind propio, `withdrawal_credit_note`,** y no `credit_note` con su origen. *Por qué:*
  `credit_note` lo leen lecturas que NO son fiscales —las ventas del día lo restan, el estado de
  cuenta del cliente lo lista como abono—; con `credit_note`, olvidar excluirla habría restado en
  silencio una venta que nunca se contó. Con kind propio, lo que hay que ampliar son las lecturas
  fiscales (libro, declaración, importes, cobertura contable), y ese olvido lo delata un
  invariante. *Alternativa:* `credit_note` con una exclusión en cada lectura de venta y de cartera.
- **Numera como una nota de crédito:** el correlativo de la serie de notas de crédito (el mismo
  contador: `claim_document_number` conoce la familia, y un índice único cruza los dos kinds) y el
  control de su talonario. Mismo camino de emisión que toda nota (`createInvoiceLike` →
  `insertarDocumento` → `assert_document_issuance`), a la tasa de su factura, con las líneas, las
  alícuotas y el adquirente CONGELADOS de la factura que corrige.
- **No toca cartera ni crea saldo a favor,** por construcción (el kind) y por prohibición escrita
  (triggers sobre cobros, devoluciones y saldos a favor; CHECK contra `paid`).
- **Su asiento es el contra-asiento del retiro** y la mercancía vuelve al kardex al costo con que
  salió. Es un hecho nuevo del preset, `inventory_move / stock.received` —el nombre del evento
  que la entrada publica, como `sales_cost / stock.received` en la anulación— (**renombrado en
  la tercera ronda a `inventory_move / stock.withdrawal_returned`: ver su punto 4, más abajo**):
  inventario y
  débito fiscal contra el gasto por retiro. El asiento del retiro NO se reversa: sigue vigente en
  su día, y el contra-asiento cae en el día de la nota (el libro y la declaración restan en el
  período en que la nota se emite). *Alternativa:* reversar el asiento original, que deja a los
  dos movimientos del kardex sin asiento vigente y obliga a perdonarlos en
  `inventory_coverage_gaps`.
- **Permisos:** `sales.invoice.annul` (el mismo de la anulación del mismo día: corregir un
  documento emitido) **y** `inventory.move` sobre el depósito del retiro. Motivo obligatorio; acta
  `fiscal.credit_note.issued` con la factura y el movimiento de reingreso.
- **La factura ya corregida no se anula;** la nota no se anula (si el retiro sí ocurrió, se
  registra de nuevo).
- **`withdrawal_note_gaps()` lo enuncia:** (6) un retiro corregido netea en cero —el kardex de la
  factura y de su nota suma cero en cantidad y en valor—; (7) la nota es total; (8) su IVA está
  debitado en el asiento de su reingreso, o espera en cola. `accounting_coverage_gaps()` la cubre
  por el asiento de su reingreso.

### AF3-03 · Las cuentas de las salidas no gravadas (migración 20261005100400)

Un bien que pasa al activo fijo llevado a gasto es un error contable. **Decidido por criterio:**

- `uso_en_negocio` → el papel de gasto de operación que ya existía (hecho `stock.used_in_business`);
- `activo_fijo` e `incorporado_inmueble` → un papel nuevo, `fixed_assets`, con UNA cuenta
  **provisional** en `ve_basico`: 1.2.01 «Propiedad, planta y equipo», bajo una rama nueva 1.2
  «Activo no circulante» (hecho `stock.capitalized`). El contador confirma los códigos: P-82 queda
  «aplicada con código provisional», como 2.1.92 en J-02;
- las empresas que ya importaron el plan reciben las cuentas y el papel, con acta; una empresa con
  plan propio que no tenga la cuenta 1, o que ya use 1.2 o 1.2.01, **no recibe una cuenta
  adivinada**: su movimiento va a la cola de pendientes diciendo qué papel falta.
- *Alternativa:* dejarlos en la cuenta de retiros con el motivo en la descripción (la primera
  ronda) y que el contador reclasifique a mano.

### Lo que la primera ronda dijo de más

- **«Ninguna lectura de deuda cambió» y «por construcción» tenían un hueco.**
  `platform.document_debt` —la función de la deuda de UN documento— no enumeraba kinds: el estado
  de cuenta de la ficha del adquirente la llama documento a documento, y una factura de retiro
  habría salido con «debe» su total. Ahora enumera en positivo (`invoice`, `receipt`,
  `debit_note`), como todas las lecturas que la llaman.
- **«Un olvido fiscal hace ruido» no es cierto para toda lectura.** Tres lecturas fiscales por
  kind vivían en TypeScript y la primera ronda no las amplió; ningún invariante las delató:
  «¿hay documentos fiscales anteriores al período?» (`declarations.ts`), «¿cuántos documentos
  fiscales hay desde esta fecha?» (`tipo-contribuyente.ts`, que protege el cambio retroactivo del
  tipo de contribuyente) y el aviso de «todavía no has facturado» (`modo-venta.ts`). Las tres
  quedan ampliadas. La regla que sale de aquí: al añadir un kind, se busca el kind hermano en el
  código, no solo en el catálogo de funciones.

## Lo que queda abierto

- **La nota de crédito de un retiro es total.** Corregir una parte es anular el retiro entero y
  registrarlo de nuevo: dos documentos y dos controles por un error de cantidad.
- **La ficha del adquirente** (migración 20261005100600). El documento exige una ficha de
  cliente; la del retiro lleva la marca `customers.own_company` (a lo sumo una por empresa), nace
  inactiva y su creación es idempotente (candado por empresa: dos primeros retiros a la vez dejan
  UNA). No es un cliente más: no sale en la lista ni en el buscador de clientes y
  `resolverLista` —la puerta de toda venta— no le vende. Antes de esta ronda aparecía en todos los
  buscadores y se le podía vender y fiar. *Decidido por criterio:* si el negocio YA tenía un
  cliente con su propio RIF, se usa esa ficha como ancla y NO se marca (no se le esconde al dueño
  un cliente que él creó); *alternativa:* marcarla también. Cerrado en la tercera ronda: el
  estado de cuenta lista cartera y lo que la mueve, y una factura de retiro o su nota NO salen
  en él (lista positiva de tipos en `customer-statement.ts`; antes salían con saldo NULL, que en
  ese contrato significa «debe y no se puede calcular»).
- **La cuenta 1.2.01 es provisional** (P-82), y la base del retiro sigue sin piso de mercado (P-75).
- **El faltante sin evidencia sigue rechazado** (P-81) y la merma justificada no va al libro (P-77).
- **Cerrar la tabla de Notas de retiro** a nuevas filas: migración posterior al despliegue.
- **Ninguna pantalla se abrió en un navegador.** La vista previa, «Corregir este retiro» y el
  aviso tras confirmar compilan y pasan sus tests; nadie las ha visto pintadas.
- **P-76 sigue abierta** (la norma está leída en una reproducción no oficial). Esa frase NO es
  un mecanismo: nada en el sistema «retiene» los retiros. Lo que hay es un permiso (tercera
  ronda, AF5-02): el retiro gravado de una empresa que factura lo registra quien puede emitir
  facturas. Liberar la emisión fiscal productiva es decisión del dueño con el asesor, como para
  toda factura.

## Verificación

- Invariantes en cero cubriendo el documento nuevo: `withdrawal_note_gaps`,
  `accounting_coverage_gaps`, `fiscal_amount_gaps`, `book_ledger_reconciliation`,
  `book_ledger_discrepancies`, `control_number_collisions`, `annulled_stock_gaps`,
  `annulment_paper_gaps`, `receivables_ledger_gap`, `customer_credit_ledger_gap`,
  `settled_ledger_gaps`, `rules_version_gaps`.
- E2E `e2e-salidas-inventario`: control consumido, libro, declaración, sin cartera, todo o nada,
  anulación, motivos no gravados, sin RIF, precio cero, evidencia.
- pgTAP 134 y 134b, cada defensa con su variante rota y por SQLSTATE (`LAD72`). De las nueve
  ramas de `withdrawal_note_gaps`, vistas en rojo: `retiro_sin_factura`, `falta_el_corte`,
  `factura_de_retiro_a_un_tercero` (134); `retiro_corregido_sin_reingreso`,
  `factura_de_retiro_sin_iva_en_el_asiento`, `nota_de_credito_de_retiro_sin_iva_en_el_asiento`,
  `nota_de_credito_de_retiro_no_es_total`, `factura_de_retiro_con_cartera` (134b). Tres de ellas
  solo se rompen apagando la guarda que las impide (el trigger de forma o el CHECK de «nunca
  pagada»): el test lo dice y apaga esa guarda. `retiro_sin_nota` y `nota_sin_iva_en_el_asiento`
  son las del régimen anterior al corte y las prueba el pgTAP 103. Si faltara la fila del corte,
  el invariante no calla: `falta_el_corte`, y todo retiro se juzga como posterior.
- `pnpm recorrido I` y `L`.

## Nota de aplicación (migraciones 20261005100000 a 20261005100600)

La entrega son **siete migraciones que van juntas, en una sola ventana** (100400, 100500 y 100600
son la segunda ronda: las cuentas por papel, la nota de crédito y la ficha del adquirente). Las 100100 a 100300 corrigen a la primera, y cada una la encontró un test distinto
mirando lo que el anterior no veía:

- **100100** — `claim_document_number` calculaba el siguiente número con `max()` sobre los
  documentos de UN kind: la segunda factura de retiro recibía otra vez el 1. Lo cazó el índice
  único que cruza los dos kinds, puesto «por si acaso»: es un detector activo y está anotado.
- **100200** — el renglón del libro buscaba el asiento de la factura de retiro solo en `posted`;
  anulada, quedaba sin enlace y `book_ledger_discrepancies` daba dos filas.
- **100300** — **grave:** la guarda de cobros y devoluciones era una sola función de trigger para
  dos tablas, y nombraba una columna de cada una. PL/pgSQL resuelve todas: **todo cobro y toda
  devolución, de cualquier documento, moría con 42703**. El E2E del retiro no lo vio (el caso de
  uso rechaza antes); lo vio el pgTAP al asertar el SQLSTATE. **La 100000 no debe aplicarse sin
  la 100300.**

## Tercera ronda (2026-10-04): lo que encontró la revisión en contexto limpio y la auditoría fiscal de la ola

Migraciones 20261005100700 a 20261005100960, y la 20261005160000 (versión de reglas).

1. **La numeración volvió a saltar por índice** (20261005100700). `claim_document_number`
   filtraba con un CASE sobre `kind` y recorría todos los documentos de la empresa en la serie,
   con el candado tomado. Ahora son tres consultas estáticas, una por familia, cada una servida
   por su índice. El pgTAP 134 lee el cuerpo vivo de la función y pide el plan de cada una.
   *Consecuencia negativa:* una familia de numeración nueva exige su rama y su índice.
2. **`document_debt` responde por los tipos de antes** (misma migración): la 100500 la había
   dejado sin fila para la nota de crédito general y el recibo de devolución (regresión: el
   detalle mostraba «0»). Lista positiva de siete tipos; los dos del retiro, sin fila.
3. **`LAD72`** (20261005100800): las guardas del retiro dejan de compartir `LAD67` con la moneda
   de la cuenta de tesorería.
4. **El hecho contable del reingreso se llama `stock.withdrawal_returned`** (20261005100900), no
   `stock.received`: su plantilla acredita gasto por retiro y no puede compartir el nombre de una
   entrada cualquiera. Las lecturas aceptan los dos nombres porque un asiento posteado no se
   reescribe.
5. **AF5-02 · el permiso.** El retiro gravado de una empresa que factura exige, además de
   `inventory.move`, `sales.invoice.issue`: emitir un documento fiscal y gastar un control no es
   mover mercancía. Se comprueba en el servidor, en la salida y en la vista previa. Los motivos
   que no emiten documento y la empresa sin RIF siguen pidiendo solo `inventory.move`. Ningún
   rol de sistema cambia de permisos. *Alternativa descartada:* un interruptor por empresa,
   apagado por omisión (lo decide el dueño).
6. **AF5-08 · la fecha.** Una factura de retiro lleva la fecha de hoy (día de Caracas, `date`
   contra `date`): toma el siguiente correlativo y control, y una fecha pasada rompería la
   continuidad de número y fecha. Los motivos que no emiten documento conservan su fecha.
   *Consecuencia negativa:* un retiro que se olvidó registrar ayer se factura hoy.
7. **AF5-07 · el destino.** Los tres motivos no gravados exigen una nota de destino, con la regla
   de la evidencia de las pérdidas y en su misma columna (`exit_evidence`; CHECK en la
   20261005100900, `NOT VALID`). El rótulo de `incorporado_inmueble` pasa a «Construcción o
   reparación de un inmueble del negocio»; el identificador no cambia.
8. **AF5-04 · el papel** no cita un artículo: «Factura por retiro de inventario.», el motivo y
   «El adquirente es el propio emisor. No genera cuenta por cobrar.».
9. **AF5-06 · el producto exento.** El retiro de un producto exento con motivo gravado SE FACTURA,
   con IVA 0, y va a la columna de exentas del libro. *Decidido por criterio* (lectura literal
   del art. 31: el retiro se documenta con factura; la exención afecta al impuesto, no al
   documento); *alternativa:* no emitir nada y dejar solo la salida. **VALIDAR-TRIBUTARIO en
   P-78.** Fijado en el E2E («punto 9a»).
10. **AF5-05 · el período de la nota de crédito.** La nota resta en el período en que se emite,
    no en el de su factura: lo respalda la LIVA art. 36.
11. **La versión de reglas sube a 1.4.0** (20261005160000, una subida para toda la ola 5,
    ADR-0079 §8). No es `fiscal-books/1.4.0`, que versiona el formato de los libros.
12. **`documents.withdrawal_move_id` ya no tiene clave foránea** (20261005100950 y 100960). La FK
    diferible de la primera ronda dejaba un evento en cola por cada documento insertado bajo
    `set constraints all deferred`, y el pgTAP 122 (de HEAD) se caía en su línea 332 sin correr
    60 de sus 104 aserciones. La integridad la da el constraint trigger
    `documents_95_withdrawal_move` y que `inventory_moves` es append-only. *Alternativa
    descartada:* FK no diferible escribiendo la salida antes que la factura (invierte el orden de
    candados talonario → existencia). La decisión la tomó el reparador para poner en verde un
    test de HEAD; la segunda revisión en contexto limpio la confirmó y la sesión principal la
    aceptó, con la condición que cumple la cuarta ronda (abajo).

## Cuarta ronda (2026-10-05): el invariante también parte de la factura

- **Migración 20261005100970.** El comentario de la 20261005100960 dice que
  «`withdrawal_note_gaps` cruza las dos tablas desde fuera»: cuando se escribió era cierto solo
  en UN sentido (del movimiento a su factura). Una factura de retiro con la salida colgando era
  invisible al invariante, y sin clave foránea el único guardián era el trigger. Desde la 100970
  el invariante cruza en los DOS sentidos: la rama `factura_de_retiro_sin_su_salida` da fila por
  toda factura de retiro cuya salida no exista, no sea de la empresa, no sea un retiro gravado o
  no la señale. (La migración 100960 no se edita: la corrección de su comentario es este
  párrafo.) Variante rota en el pgTAP 134, con las dos formas; y el trigger, ejercido con una
  salida inexistente y con una de otra empresa (`LAD72`).
- **Los dos nombres del hecho en las lecturas se quedan** (`stock.received` y
  `stock.withdrawal_returned`): están acotados por el movimiento de la nota
  (`m.source_document_id` = la nota). *Alternativa:* solo el nombre nuevo.
- **Retiro y nota en meses distintos: cubierto** por el pgTAP 134c, que fabrica por SQL la
  factura de retiro, su salida y su asiento en el mes anterior, y la nota, el reingreso y su
  contra-asiento hoy, sin apagar ninguna guarda. El libro lleva cada documento en su mes;
  `book_ledger_reconciliation` cuadra en cada mes y en los dos juntos; `inventory_ledger_gap`,
  `inventory_coverage_gaps` y `withdrawal_note_gaps` en cero; la regla de la anulación rechaza la
  factura del mes anterior.

**Verificación: lo no cubierto.** La PUERTA de la anulación con una factura de retiro de otro
día (el 409 de `POST /v1/invoices/:id/annul`) no se ejerce: por la API no se fabrica otro día;
se ejerce la regla que esa puerta llama (`invoice_annulment_blockers`), en el E2E con el reloj de
mañana y en el pgTAP 134c con una factura del mes pasado. El pgTAP 026 no se corrió (falla sobre
una base con escenario por «nace VACÍA»). Ninguna pantalla se abrió en un navegador.

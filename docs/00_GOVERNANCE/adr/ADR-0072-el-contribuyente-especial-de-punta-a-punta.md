# ADR-0072 — El contribuyente especial, de punta a punta

- **Estado:** ADR aplicado según la respuesta del dueño del 2026-09-28 (§2.6; A-03, E-02, E-03,
  F-05, G-06, H-01, H-04, H-12, L-03, L-04, L-05, L-09, L-12, L-15)
- **Fecha:** 2026-09-28
- **Impacto fiscal:** SÍ.
- **Enmienda:** ADR-0052 (calendario sin fechas de fábrica), ADR-0053 (IGTF), ADR-0039 (retenciones)
  y ADR-0065 §3 (la retención nace al registrar, criterio R-3 ratificado el 2026-09-28).

## Contexto

El recorrido encontró que el camino del sujeto pasivo especial (SPE) está roto de punta a punta:

- **A-03:** el tipo no se pregunta.
- **E-02:** sin declararlo, el IGTF se omite en silencio.
- **E-03:** cuando se percibe, la factura no lo imprime.
- **F-05:** el IGTF «además» registra dinero que no entró.
- **H-01:** la retención de IVA nunca se practica desde la web.
- **H-04:** el comprobante de retención no existe como documento.
- **L-03:** el TXT de retenciones no sigue el instructivo.
- **L-04:** la declaración se propone por mes.
- **L-05:** el excedente mezcla crédito y retenciones.

La norma que aplica está en `docs/02_COMPLIANCE/REGULATORY_STATUS.md` §2-bis y en la respuesta del
dueño, §1: LIGTF y PA SNAT/2022/000013; PA SNAT/2025/000054; PA SNAT/2025/000091; e instructivo del
TXT.

## Decisión

1. **El tipo de contribuyente se declara y tiene vigencia.** Los tipos son `ordinario`, `especial`,
   `formal` y `no_contribuyente`.
   - Para el especial se piden la fecha de notificación de la providencia y la fecha desde la que
     rige (por omisión, la de notificación, corregible con acta).
   - La historia es append-only.
   - Sin tipo declarado no se factura: nunca «ordinario por omisión».
   - Una empresa sin RIF es `no_contribuyente` (D-01).
   - «Formal» se oculta mientras la periodicidad de la PA 1677 esté pendiente de fuente (M-10, P-38).
2. **IGTF.** Todo pago en divisas o cripto a un SPE percibe el 3 % sobre lo pagado en divisas,
   contra **cualquier** documento.
   - La caja lo suma al total. Nunca se registra dinero que no entró.
   - La factura imprime la alícuota y el monto (PA 000013 art. 6), en divisa y en Bs.
   - Hay un ajuste `absorber_igtf`, apagado por omisión.
   - El cobro posterior a la factura se documenta con una **Nota de Débito por IGTF**: sin IVA, no
     sujeta, consume control, y va al libro con base 0 (P-40).
   - La devolución deja el IGTF percibido y enterado, y el reembolso lo excluye. Solo la anulación
     lo hace indebido, con restitución y reintegro (P-31).
3. **Retención de IVA que practicamos.**
   - Se practica sola cuando la empresa es agente (SPE) y el proveedor es ordinario o especial.
   - Nace al **registrar** la factura (abono en cuenta, criterio R-3).
   - Es del 75 %, o del 100 % en los casos del art. 5.
   - Las exclusiones del art. 3 son data (`retention_exclusions`). La persona puede marcar una, con
     motivo auditado.
   - Es un cambio de contrato de la API, versionado.
4. **Comprobante de retención.** Es un documento propio (`retention_vouchers`).
   - Numeración `AAAAMM` + secuencial de 8 por empresa.
   - Contenido del art. 16.
   - Uno por operación, u opcionalmente uno por quincena y proveedor.
   - Se emite al practicar la retención y se entrega dentro de los 2 días hábiles del período
     siguiente.
   - Tiene PDF.
   - Va al libro de compras en el período de emisión, con su número, fecha e IVA retenido (H-12).
   - Corregirlo emite una versión nueva y anula la anterior, con rastro.
5. **Retenciones que nos practican.**
   - Se cargan en Bs contra la factura, con un número de 14 dígitos único por cliente.
   - El monto es el 75 % o el 100 % del IVA en Bs de la factura (± Bs 0,01).
   - Abonan la CxC **a la tasa de la factura**, sin diferencial; la alternativa, como parámetro, es
     P-30.
   - Las carga quien cobra (`ar.retention.register`) y las corrige el contador
     (`ar.retention.correct`).
6. **TXT de retenciones.** Tiene exactamente los 16 campos del instructivo, en su orden, con el
   campo 11 = IVA retenido. Un fixture aprobado lo prueba.
7. **Declaración.**
   - El SPE declara por quincena (PA 000091), y el ordinario por mes.
   - Los débitos van por la fecha de la factura, los créditos por la fecha de la factura de compra
     (o de recepción si llegó tarde) y las retenciones soportadas por la fecha del comprobante.
   - Hay dos arrastres separados: `excedente_credito_fiscal` y
     `retenciones_acumuladas_por_descontar` (P-37).
8. **Calendario** (enmienda ADR-0052).
   - La PA 000091 se siembra como data de plataforma con su fuente.
   - Las celdas pendientes de cotejo con la Gaceta (`CALENDARIO_SPE_2026.md` ⚠) quedan marcadas y
     no se ofrecen en pantalla hasta cotejarlas.
   - La quincena la calcula el servidor (L-15).
9. **Nombres** (L-12): «Retenciones que practicamos (a proveedores)» y «Retenciones que nos
   practicaron (clientes)».

## Consecuencias

- **Positivas.** El SPE factura, percibe, retiene, documenta y declara como exige la norma, y cada
  regla es data con su cita.
- **Negativas.**
  - Hay tablas nuevas: vigencias de tipo, exclusiones, comprobantes y calendario.
  - Hay contratos nuevos en la API: la retención automática y la ND por IGTF.
  - Un SPE ya existente sin fechas de calificación tiene que completarlas antes de su próxima
    factura (en producción no hay clientes reales).
- **Para revertir:** las reglas son data. Apagar la retención automática devuelve la carga manual,
  y los comprobantes emitidos quedan.

## Verificación

- E2E: un SPE cobra en divisas y la factura imprime el IGTF; el cobro posterior emite la ND por
  IGTF; una compra a un ordinario retiene al registrar y emite el comprobante.
- El TXT contra el fixture.
- `pnpm recorrido E`, `F`, `H` y `L`: los hallazgos de la familia dejan de reproducir.

## Nota de aplicación — parte 1 (tipo y retenciones soportadas, 2026-10-02)

Migraciones 20260928190000, 190100 y 190200. Decidido por criterio (respuesta del dueño §2.16),
cada punto con su alternativa:

0. **`formal` no se declara ni emite hasta construir M-10** (auditoría fiscal, hallazgo 8; PA 00071
   art. 15, P-38). El dominio lo rechaza con 422 y el CHECK de la historia admite solo
   {ordinario, especial} (migración 20260928190300). **Se reabre con M-10.** *Alternativa:*
   aceptarlo y tratar su IVA de compras al costo sin su periodicidad.
1. **`no_contribuyente` nunca se declara**: se deriva de no tener RIF (`platform.taxpayer_type_at`).
   El caso de uso lo rechaza con 422, la historia lo prohíbe con un CHECK, y la emisión exige un
   tipo en {ordinario, especial, formal}. Una empresa que pasa de sin RIF a con RIF declara su
   tipo antes de su primera factura. *Alternativa:* permitir declararlo con RIF.
   VALIDAR-TRIBUTARIO P-56.
2. **El IGTF sigue la vigencia**: la percepción exige que la empresa sea `especial` el día del
   cobro, además del acta de activación. *Alternativa:* apagar el acta al registrar una vigencia
   futura.
3. **La lectura del tipo no exige permiso**: la hace cualquier miembro de la empresa, porque la
   web decide flujos con ella. *Alternativa:* exigir `company.settings.manage`.
4. **Declaración retroactiva** (norma primero: la calificación rige desde la notificación): se
   admite con acta. Si hay documentos fiscales emitidos desde esa fecha, la respuesta, el acta y
   la pantalla dicen cuántos; no se reemiten y hay que consultar al asesor. *Alternativa:*
   prohibir fechas anteriores al último documento emitido.
5. **La puerta, también en la base**: `assert_document_issuance` rechaza con LAD98 una factura,
   NC o ND sin tipo vigente, sea cual sea el actor. *Alternativa:* solo el dominio.
6. **La retención soportada abona a la tasa de la factura** (`ar_valuation`); la tasa del
   comprobante queda como parámetro apagado (P-30). Su **reversa no está construida**: es
   semántica del dinero (R-61). La carga es de quien cobra: dueño, administrativo y cajero
   (§2.6). El encargado no cobra (§2.8) y no la tiene (migración 20260928190600). El comprobante
   es único por cliente y factura, porque uno quincenal cubre varias (PA 000054 art. 16), y sus
   porciones salen de `iva_retention_portions`, de fuente secundaria (VALIDAR-SENIAT).

## Nota de aplicación — parte 2 (IGTF, 2026-10-02)

Migraciones 20261002100000 y 20261002100100. Decisiones por criterio, cada una con su alternativa:

1. **Qué instrumento causa (auditoría fiscal, PA SNAT/2022/000013 art. 1)** — data de plataforma
   con su fuente (`igtf_instrument_classes`): efectivo en divisa y USDT causan; **Zelle causa**
   (lectura reversible: lo percibido de más se restituye); transferencia, tarjeta y punto de venta
   bancarios no. La empresa no lo cambia (422 en los dos sentidos). *Alternativa:* el interruptor
   por empresa de la migración 46 (dejaba un camino silencioso) o «todo pago en divisas» (cobra
   donde la norma no manda). VALIDAR-TRIBUTARIO P-66.
2. **La ND por IGTF y su asiento** — el asiento de la ND es el de su percepción (backlink) y la ND
   la paga su percepción (`document_balance`); sin excepción en el invariante. Si se encola, el
   backfill escribe el enlace a la ND (R-66). *Alternativa:* una ND con CxC propia y un cobro aparte
   (dobla la caja o exige excepciones en `accounting_coverage_gaps`).
3. **El producto de la línea** — producto de sistema por empresa (`system_code = 'igtf'`),
   sembrado en la migración y al crear la empresa, fuera del catálogo y de la caja. *Alternativa:*
   `document_lines.product_id` nullable (cambio de esquema más amplio).
4. **`amount` por omisión es lo entregado** («nunca se registra dinero que no entró») contra la
   deuda de hoy (`document_debt_today`); `igtf_included: false` para quien ya repartió. *Alternativa:*
   el comportamiento anterior (el IGTF ADEMÁS de `amount`), que registraba dinero que no entró.
5. **Lo absorbido** — gasto 5.1.05, no suma a la caja, se entera igual, no se imprime ni lleva ND.
   *Alternativa:* imprimirlo igual (P-40). VALIDAR-CONTABLE P-64.
6. **La restitución de un IGTF indebido con la venta viva** — no existe todavía: va a la ola 3 con
   la reversa de cobros (R-61). *Alternativa:* construirla ahora sin la reversa de cobros (dejaría
   el cobro vivo y el IGTF restituido). VALIDAR-TRIBUTARIO P-67.

**Re-revisión (2026-10-02, migración 20261002100200):**

7. **Cobertura de la ND por IGTF** — `accounting_coverage_gaps()` cambia su ENUNCIADO: la ND queda
   cubierta si su percepción tiene asiento O está en cola. *Alternativa:* dejarla como hueco hasta
   importar el pendiente (R-66), o perdonarla en una lista (prohibido por CLAUDE.md §3).
8. **«otro» en divisa de un especial = 422** («regístralo con su instrumento verdadero»), y un
   instrumento sin clasificar es un error legible, nunca «no causa». *Alternativa:* `otro` no causa
   (una vía silenciosa para no percibir).
9. **Lo pendiente se valora el día del cobro** (`paid_at`): saldo en la moneda del documento × la
   tasa del pago, o el saldo funcional si el documento es en Bs. *Alternativa:* la deuda de hoy
   (`document_debt_today`), que con un `paid_at` pasado mezclaba dos tasas.
10. **El producto de sistema** se rechaza con mensaje propio en toda factura o nota tecleada; solo
    `emitirNdIgtf` lo usa. *Alternativa:* depender de que esté inactivo (el mensaje engañaba).
11. **La percepción no se «activa»**: la pantalla explica que percibe quien es especial desde su
    notificación, según el tipo declarado, y lleva a declararlo. El acta `igtf_enabled_at` queda
    como historia. *Alternativa:* conservar el botón (sugiere un interruptor que ya no decide).

## Nota de aplicación — parte 4 (declaración y calendario, 2026-10-02)

Migración 20261002120000 (L-04, L-05, L-09). Decidido por criterio (§2.16), cada punto con su
alternativa:

1. **La tabla 1.2 se SIEMBRA con la lectura «mes de presentación»** (la columna «Ene» = 2.ª
   quincena de diciembre de 2025) **pero NO se ofrece**: sus 480 filas quedan `pending_review` hasta
   el cotejo con la G.O. 43.283 (H1, migración 20261002120100; respuesta del dueño §2.6: lo pendiente
   de cotejo no se ofrece). *Alternativa:* ofrecerla con la lectura (a).
   **Fe de erratas** del razonamiento de la primera versión: decía que era «la única lectura posible»
   y que el CHECK `tax_calendar_entries_due_chk` la hacía cumplir. Es falso: la otra lectura (la
   columna es el mes del período y se presenta en el mes siguiente) también vence después del cierre
   y pasa el mismo CHECK. El CHECK solo prohíbe vencer antes del cierre. P-10 se reabre con la pregunta.
2. **Las cuatro obligaciones quincenales comparten días** (IVA, retenciones de IVA, IGTF, anticipos
   de ISLR), como dice la respuesta del dueño §1. *Alternativa:* sembrar solo el IVA.
3. **No se siembra lo que no tiene fuente textual**: retenciones de ISLR (tabla 4) y la tabla mensual
   por pares de terminales (tabla 2, rotulada «estimada» por una fuente y «anticipos» por otra). R2.
4. ~~Al ordinario se le rechaza exactamente una quincena~~ — **sustituida en la revisión (H5,
   migración 20261002120100):** el ordinario declara el **mes calendario completo**, del 1 al último
   día, y todo otro rango da 422 (texto del dueño §2.6: «el ordinario declara por mes»). Los E2E que
   generaban períodos de un día cambian su ENTRADA al mes, con las mismas cifras. *Alternativa:*
   rechazar solo la quincena y admitir rangos libres.
5. **Un tipo que cambia dentro del rango** (de ordinario a especial a mitad de mes) se rechaza con un
   mensaje que manda a consultar al asesor: la norma de la transición no está en `docs/`
   (VALIDAR-TRIBUTARIO). *Alternativa:* declarar con el tipo del primer día.
6. **El calendario y la propuesta solo aplican al especial vigente al cierre del período**: la
   providencia es de los SPE. *Alternativa:* mostrar las fechas a cualquiera con terminal.
7. **El hash firma los arrastres de retenciones solo cuando no son cero**, como la casilla de
   ajustes: el generador sube a 1.1.0, y una planilla sin retenciones conserva la forma de su
   canónico. *Alternativa:* incluirlos siempre.
8. **La quincena del IGTF** es `platform.fiscal_fortnight(día)` y su vencimiento
   `platform.tax_due_date(empresa, 'igtf', desde, hasta)` (L-15). La migración 20261002110000
   (retenciones que practicamos, en paralelo) creó `platform.retention_fortnight` con el mismo
   corte; desde 20261002120100 es un envoltorio de `fiscal_fortnight` (H8), con pgTAP de igualdad.
   **No se redefine con lógica propia.**
9. **La muestra del calendario se compara con una sola fuente secundaria legible** (Nayma), y el
   test lo dice en cada aserción: el documento no tiene una segunda fuente textual (§5.4). Decidido
   por criterio (H10). *Alternativa:* no escribir el test hasta tener dos fuentes, o comparar con las
   imágenes de LEGA/Moore transcritas a mano.
10. **La propuesta evalúa el tipo en el CIERRE del período candidato** (H3): en la transición
   especial→ordinaria propone la última quincena que tocaba como especial. *Alternativa:* el tipo
   del día anterior a la quincena en curso (la primera versión).
11. **Auditoría fiscal 2.ª ronda (migraciones 20261002120200, 120300 y 120400).** La ND por IGTF sale
   de la planilla, la prorrata, las bases del libro de ventas y el resumen del art. 72, y va aparte
   como IGTF percibido (H1, P-70); la 120300 la reconoce por `products.system_code = 'igtf'`, no por
   el sku. La retención entregada después de declarar su período va al de la entrega;
   «declarado» = una generación que lo cubre, hecha después de cerrar el período (B-1, 120400) y
   del día de la entrega o anterior (H4, P-68); una fecha de entrega posterior a hoy se rechaza (B-2).
   *Alternativa:* comparar instantes (creación de la generación contra creación del comprobante),
   que en una misma transacción no distingue nada. El libro de ventas registra el comprobante
   soportado en el período de su entrega (H5).
12. **Ningún vencimiento mientras el terminal esté en duda** (H11, P-10.2): pasan a pendientes
   también la tabla 1.1 y la definitiva de ISLR, que reparte por terminal igual. *Alternativa:*
   dejar la definitiva ofrecida, que tiene la misma duda.

## Nota de aplicación — parte 3 (retención de IVA que practicamos, comprobante y TXT, 2026-10-02)

Migraciones 20261002110000 y 20261002110100; contrato de la API 0.2.0 (OpenAPI regenerado). H-01,
H-04, H-12 y L-03. Decidido por criterio (respuesta del dueño §2.16), cada punto con su alternativa:

1. **Proveedor sin tipo declarado se retiene** (se presume contribuyente; el error caro es no
   retener, COT arts. 27 y 115). *Alternativa:* exigir el tipo antes de registrar (422).
2. **Proveedor `no_contribuyente`, `no_sujeto` u otros**: 422 hasta que la persona diga el 100 %
   (art. 5) o una exclusión. *Alternativa:* no retener, que sería el cero silencioso de ADR-0039 §2.
3. **`retention_concepts` sigue valiendo** (N-1): lo pedido se practica como antes, también en una
   empresa no agente, y si pide un concepto de IVA no se añade otro. *Alternativa:* rechazar el
   concepto de IVA de una empresa no agente (rompería clientes desplegados y un E2E existente).
4. **El 100 % es un concepto propio** (`iva_compras_total`) con su regla en `retention_rules`.
   *Alternativa:* un eje nuevo en `retention_rules`.
5. **El catálogo de `retention_rules` sigue naciendo vacío** (ADR-0039 §2): no se siembra el 75 % de
   plataforma. *Alternativa:* sembrarlo con la cita de la 000054 art. 4; impediría probar la ausencia.
6. **Secuencial único por empresa** (no se reinicia por mes), bajo candado de asesoramiento con la
   clave natural `(company_id, sequence)`. *Alternativa:* contador en tabla aparte.
7. **Corregir re-lee la identidad del maestro** (lo que una corrección viene a arreglar) y copia los
   importes (salen de la factura inmutable). *Alternativa:* corregir campo a campo.
8. **Período de emisión en el libro de compras**: el comprobante emitido en otro período que su
   factura sale en el de su emisión como renglón `comprobante_retencion` con importes en cero.
   *Alternativa:* identificarlo siempre en el renglón de la factura.
9. **Modo por quincena**: los renglones se añaden al comprobante abierto (no entregado) de la
   quincena y el proveedor; su fecha de emisión es la del primero. *Alternativa:* emitirlo al
   cierre de la quincena, que contradiría «se emite al practicar la retención».
10. **Vencimiento de entrega**: 2.º día de lunes a viernes tras la quincena, sin feriados
    (VALIDAR-TRIBUTARIO, P-26). *Alternativa:* cargar el calendario de feriados como data.
11. **H4 · una corrección de un comprobante ya declarado no se declara otra vez** (migración
    20261002110200): el TXT excluye las versiones >= 2 cuya versión 1 se emitió antes del período, y
    la exportación lo avisa. VALIDAR-SENIAT P-65. *Alternativa:* declararla en el período de la
    corrección (riesgo de doble enteramiento).
12. **H5/H6 · un candado por empresa** antes de buscar el comprobante abierto de la quincena y al
    empezar a corregir, el mismo del secuencial (reentrante). *Alternativa:* un único parcial sobre
    (empresa, proveedor, quincena) abierta, que no admite el cierre por entrega sin UPDATE.
    Razonamiento de concurrencia (no hay prueba de dos sesiones determinista en el arnés): la
    segunda transacción espera en `pg_advisory_xact_lock` hasta que la primera commitea; su SELECT
    posterior (READ COMMITTED, sentencia nueva) ve el comprobante ya creado y le añade el renglón.
13. **H10 · invariante con corte en el enunciado** (`platform.invariant_cutoffs`): lo practicado antes
    de la migración no es de este invariante, lo vigila P-63. *Alternativa:* lista de perdones (rechazada,
    CLAUDE.md §3).
14. **H11 · la entrega** no admite fechas posteriores al día de Caracas ni versiones reemplazadas.
15. **H7 · la pantalla**: Compras y «Ya llegó la factura» ofrecen, a una empresa agente, la exclusión
    (catálogo del servidor, `GET /v1/retention-exclusions`) o el 100 % con su supuesto; Compras tiene
    «Comprobantes de retención». El correo no se construye: no hay proveedor de correo configurado.
16. **Auditoría fiscal, segunda ronda** (migración 20261002110300; RESPUESTA §0: manda la norma):
    agente por el tipo del día del REGISTRO (P-72; *alternativa:* el de la factura); el 422 del
    proveedor no contribuyente solo con IVA > 0 (art. 3 num. 1); tope de 20 UT de los num. 6 y 7
    contra el TOTAL en Bs con `tax_units` (P-71; *alternativa:* contra la base); num. 11 y 12 no
    marcables; el supuesto 4.º del art. 5; TXT con varias alícuotas → 422 (P-69; *alternativa:* una
    línea por alícuota). La migración 20261002110300 se reescribió una vez ANTES de aplicarse: su
    primer intento falló en su propia comprobación (contaba 8 filas en vez de 7) y no llegó a
    `schema_migrations`.

## Nota de aplicación — M-10 (el contribuyente formal, ola 4, 2026-10-03)

ADR aplicado según la respuesta del dueño del 2026-09-28 (§3 M-10) y su cláusula: «si
`docs/02_COMPLIANCE` no tiene la fuente al llegar a este hallazgo, la opción "Formal" se oculta
hasta tenerla». La fuente de la periodicidad de la PA SNAT/2003/1677 no llegó (REGULATORY_STATUS
§2-bis: «parcial»; PENDIENTES_ASESOR P-38), así que **el punto 0 de la nota anterior sigue en
pie: `formal` no se declara ni emite.**

Lo único que cambia (migración 20261004110000, pgTAP 121):

1. **La base rechaza la línea gravada de un formal** (LIVA art. 8) en la factura y en la nota de
   débito, al emitir (`platform.assert_document_issuance`) y si se agrega después
   (`platform.assert_formal_line`, trigger `document_lines_formal`), con el texto de la respuesta
   y `LAD99` (422). Hasta ahora el trigger aceptaba `formal` como tipo que emite y nada le impedía
   vender gravado: la prohibición dependía de que el tipo no existiera. *Alternativa:* no escribir
   nada hasta tener la fuente, y que la guarda nazca con el resto de M-10.
2. **La nota de crédito queda fuera de la guarda**: revierte un débito que existió cuando la
   empresa era ordinaria. *Alternativa:* rechazarla también (P-38, pregunta 5).
3. **No se abre a medias.** Sin relaciones ni informativa, un formal que facturara quedaría con
   libros de IVA y declaración mensual, que es justo lo que la PA 1677 no dice. Reabrir `formal`
   es: ampliar el CHECK `company_taxpayer_types_declarable_chk`, quitar el 422 de
   `setCompanyTaxpayerType`, sumarlo a `TIPOS_QUE_FACTURAN`, la leyenda «Contribuyente formal» en
   el PDF, las relaciones, la informativa con su calendario como data, y quitarlo de `OCULTOS` en
   la pantalla (el texto que lo explica ya está en `capa-fiscal/textos.ts`).

**`book_ledger_reconciliation()` no cambia y no gana ninguna excepción.** Hoy no existe ninguna
empresa formal. El día que exista, su «relación» no puede ser una lista de perdones del invariante:
o la relación sale de las mismas filas que el libro (y entonces el invariante vale cero tal como
está, porque un formal no tiene débito ni crédito fiscal que conciliar), o el enunciado del
invariante se cambia para decir «libro **o relación** = mayor + cola». Esa decisión es de quien
construya las relaciones, con la respuesta de P-38 delante.

**Borde anotado en la revisión (2026-10-03), sin migración:** `platform.assert_formal_line()` mira
los documentos en estado `issued` o `paid`, mientras que `platform.assert_document_lines_immutable()`
trata también `annulled`. Hoy es inocuo: un formal no existe, y a una factura anulada no le agrega
líneas ningún camino del dominio. Quien reabra `formal` decide si la segunda puerta debe cubrir
también `annulled`, y lo prueba en el pgTAP 121 junto a su variante rota.

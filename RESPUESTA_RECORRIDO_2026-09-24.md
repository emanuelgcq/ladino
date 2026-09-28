# Respuesta del dueño al recorrido 2026-09-24

**Decisiones, criterio normativo y plan de cierre de los 235 hallazgos**
Fecha: 2026-09-28 · Responde a `recorrido-2026-09-24.md` (el informe que empieza en «Informe final» y termina en «Cierre Z»).

Este documento es la fuente de verdad para `/arreglar` desde hoy. Donde el informe pregunta «¿NECESITA DECISIÓN DEL DUEÑO?», aquí está la decisión. Donde marca VALIDAR-TRIBUTARIO, VALIDAR-SENIAT o VALIDAR-CONTABLE, aquí está la lectura que se aplica y, si hace falta, la pregunta que queda para el asesor. Donde propone un orden, aquí está el orden.

Una regla por encima de todas: **si encuentras texto normativo vigente que contradiga una decisión de este documento, manda la norma**. Aplícala, cárgala en `docs/02_COMPLIANCE/` con su fuente y dilo en el informe de la ola. Lo mismo si el asesor responde distinto: por eso todo lo fiscal queda como data.

---

## 0. Alcance y reglas de esta sesión

1. **Se cierran los 235.** Al final, ningún ID queda `abierto`. Cada uno termina en uno de estos estados: `cerrado (<commit>)`, `no reproducido (<razón>)`, `construido (<commit>)`, `dejado de prometer (<commit>, ADR-xxxx)` o `decidido por criterio (<decisión>, alternativa: <cuál>)`.
2. **Entorno:** local completo (web 5174, API 3000, Supabase local), como en el recorrido. **El VPS no es tuyo:** no tienes acceso, no lo vas a tener y no intentes conectarte. El despliegue lo hace el dueño con `git pull` y rebuild cuando tú avises «Listo para git pull» (sección 7). **El Supabase remoto sí lo tocas tú**, al final, como dice la sección 7.
3. **Reglas del proyecto que siguen intactas:** regulación es data con fuente citada; tablas append-only (lo asentado se corrige con reversas, nunca con UPDATE); nada de dinero se calcula en la web; verify se lee por `VERIFY EXIT` y «Failed:», nunca a ojo; `pnpm run verify`; gate verde antes de cada commit; commit y push después de cada commit (CLAUDE.md §3), sin `--no-verify`, sin reescribir historia; ninguna lista de perdones en invariantes ni en tests; «asevera el mensaje»: dos caminos nunca terminan en el mismo 201.
4. **Un hallazgo se cierra cuando sus pasos de REPRODUCIR ya no reproducen.** No antes. Y si «terminaba en verde», su cierre incluye el test o invariante que se pondría en rojo si volviera.
5. **Sin refactors ni renombres** que no sean necesarios para cerrar un hallazgo.
6. **Precedencia:** este documento manda sobre las propuestas del informe. CLAUDE.md manda sobre este documento, salvo la sección 7 (entrega), que actualiza a propósito la regla de las migraciones de producción para esta entrega.
7. **Decisiones no cubiertas aquí** (aparecerán): se toman con el criterio de la sección 2.16 y se anotan en el informe de ola como «decidido por criterio», con la alternativa. No se pregunta a mitad de ola.

---

## 1. Marco normativo que gobierna las decisiones (verificado en la web a septiembre de 2026)

Cárgalo en `docs/02_COMPLIANCE/REGULATORY_STATUS.md` si falta algo, con fuente. Nada de esta tabla se codifica: se siembra como data (`tax_rules`, `retention_rules`, `fiscal_calendars`, parámetros) con su cita.

| Norma | Qué fija | Qué hace Ladino con eso |
|---|---|---|
| **PA SNAT/2011/00071** (G.O. 39.795, 08-11-2011), vigente | Art. 6: tres medios de emisión: formatos, **formas libres** y máquinas fiscales; «en ningún caso» se emite a mano sobre formas libres. Art. 8: máquina fiscal obligatoria cuando **concurran** las tres condiciones (ingresos brutos anuales > 1.500 UT; mayor número de operaciones con quienes no usan la factura como prueba; actividad listada). Art. 13: los 16 requisitos de la factura sobre formatos y formas libres (denominación «Factura»; numeración consecutiva y única; **número de control preimpreso**; «desde el N°… hasta el N°…»; emisor; fecha de 8 dígitos; adquirente con RIF o, si es persona natural sin uso tributario, cédula o pasaporte; descripción con cantidad y monto y **(E)** al lado de lo exento, exonerado o no gravado; descripción y valor de recargos, descuentos, bonificaciones y **anulaciones**; **base imponible discriminada por alícuota con su porcentaje** y total exento o exonerado; **impuesto discriminado por alícuota con su porcentaje**; total; «sin derecho a crédito fiscal» en las copias; **en moneda extranjera, ambas cantidades, el total y el tipo de cambio**; razón social, RIF, nomenclatura y fecha de la providencia de la imprenta; fecha de elaboración de 8 dígitos). Art. 22-23: NC y ND «por cualquier causa», con los requisitos del art. 13 y **referencia a fecha, número y monto de la factura**. Art. 30-31: qué preimprime la imprenta en formatos y en formas libres (en formas libres: control, RIF del emisor, datos de la imprenta y providencia, rango, fecha de elaboración; **nunca la denominación ni el número del documento**). Art. 36: originales y copias de lo anulado se conservan mientras no prescriba. **Art. 44: la numeración de control es consecutiva y única para cada emisor, con dos campos: identificador de 2 dígitos y secuencial de hasta 8.** | Toda la familia «numeración y documento fiscal» (sección 2.1 a 2.4). La checklist del PDF se prueba contra el art. 13. |
| **PA SNAT/2026/00084** (12-08-2026) | Deroga la PA 121 (homologación de software). Sin reemplazo. | Ninguna leyenda de homologación en ningún papel (A-11, E-24). |
| **PA SNAT/2024/000102** (facturación digital) | Factura digital solo a través de imprenta digital autorizada; art. 30 fija el formato del control. | El PDF de Ladino **no** es factura digital: es el archivo de impresión sobre la forma libre y una copia de cortesía marcada como tal. El adaptador de imprenta digital sigue pendiente (fuera de esta entrega). |
| **LIVA** (Decreto Constituyente, G.O. 6.507 Ext., 29-01-2020) | Art. 4.3: el **retiro o desincorporación** de bienes del giro es hecho imponible. Art. 8: **contribuyentes formales** = solo operaciones exentas o exoneradas. Art. 17-19: exenciones (art. 18: alimentos de la cesta básica, medicinas, etc.). Art. 27: alícuota general entre 8 % y 16,5 %, fijada por la Ley de Presupuesto: **hoy 16 %**. Art. 61: adicional 15 % a bienes suntuarios. Art. 62: adicional 5–25 % a pagos en divisas/cripto, **no activada** (sin decreto; verifícalo en la web antes de sembrar). Art. 63: reducida 8 %. Art. 33: el crédito exige contribuyente ordinario, vinculación con la actividad, factura que cumpla requisitos e impuesto acreditado. Período mensual salvo calendario especial. El excedente se arrastra. | Alícuotas como data (sección 2.5). Retiros con débito fiscal (I-01). Crédito solo para ordinarios y especiales (D-01, H-09). |
| **RLIVA** (Decreto 206, G.O. 5.363 Ext., 12-07-1999) | Art. 13-14: retiros; los faltantes por caso fortuito o fuerza mayor debidamente comprobados no son retiro. Art. 70-78: libros de compras y ventas: **cronológicos y sin atraso**; art. 72: **resumen mensual** con base e impuesto **por alícuota**, ajustes, débitos, créditos, exentas, exoneradas, no sujetas, exportaciones; art. 75 (compras), 76 (ventas a contribuyentes), 77 (ventas a no contribuyentes: primer y último número del día, totales); art. 73: conservación. | Libro de ventas por alícuota y con resumen (L-08); anuladas en el libro (L-07); faltantes con motivo (I-01). |
| **PA SNAT/2025/000054** (G.O. 43.171, 16-07-2025; deroga la 0049) | Agentes de retención: sujetos pasivos especiales, incluidas firmas personales SPE. Art. 3: **13 exclusiones** (exentas/exoneradas/no sujetas; proveedor formal; percepción previa; viáticos; gastos de directivos ≤ 20 UT; caja chica ≤ 20 UT; **servicios públicos domiciliados**; exportadores con recuperación; proveedor con >50 % exentas; entes públicos; art. 146 COT; agentes de percepción de licores/tabaco). 75 % general; **100 %** si el IVA no está discriminado, si la factura no cumple requisitos, si el portal lo indica o el proveedor no está en el RIF. La retención se practica **al pago o abono en cuenta, lo que ocurra primero**. Enteramiento **quincenal** (1–15 y 16–último) por calendario. **Comprobante:** numeración de 14 dígitos AAAAMM+8; contenido (agente, proveedor, fecha, factura con número y control, total, base, IVA causado, IVA retenido); entrega dentro de los **2 días hábiles** del período siguiente; **uno por operación o uno por período y proveedor**; agente y proveedor lo registran en sus libros **en el período de emisión del comprobante**. Declaración informativa por el portal (planilla 99035), incluso sin operaciones. | Toda la familia «contribuyente especial» (sección 2.6): H-01, H-04, H-12, L-03, F-01, F-11. |
| **PA SNAT/2025/000091** (G.O. 43.273, 02-12-2025; reimpresa en G.O. 43.283, 23-12-2025) | Calendario 2026 de SPE y agentes de retención: **IVA, retenciones de IVA, IGTF y anticipos de ISLR por quincena** (1–15 y 16–último) y por terminal del RIF; retenciones de ISLR mensuales. | Se siembra completo como data (L-09); la declaración del especial es quincenal (L-04). |
| **LIGTF** (G.O. 6.687 Ext., 25-02-2022) + **Decreto 4.972** (12-07-2024) + **Decreto 4.924** + **PA SNAT/2022/000013** (G.O. 42.339, 17-03-2022) | Hecho imponible art. 4.6: pagos en moneda distinta a la de curso legal **hechos a un sujeto pasivo especial** sin mediación bancaria (y 4.5 por el sistema bancario). Alícuota **3 %** para 4.5 y 4.6; **0 %** para los débitos en Bs (4.1–4.4). Base: importe total de cada pago. Exento: pagos en divisas a quien **no** es SPE. PA 000013 art. 3: se declara por el **calendario de retenciones de IVA** (quincenal); art. 6: la factura muestra **alícuota y monto** del IGTF percibido; art. 4: percepción indebida → el agente restituye al cliente y pide reintegro al SENIAT. | Sección 2.6: E-02, E-03, F-05, G-06, A-03, L-15. |
| **PA SNAT/2026/0080** (12-08-2026) | El RIF no vence. Se eliminó el plazo propio de actualización: rige el COT (art. 35: un mes para informar cambios de domicilio, actividad, directores, cese). | A-10: aviso de actualización. |
| **COT** (G.O. 6.507 Ext., 2020) | Art. 35 (informar cambios en 1 mes); arts. 99-108 ilícitos formales: no llevar libros, llevarlos sin formalidades, facturas sin requisitos: multas y clausura. | L-01 (qué pasa si el libro estaba mal), G-10. |
| **UT = Bs 43** (PA SNAT/2025/000048) | 1.500 UT = Bs 64.500. | Art. 8 PA 00071 (B-19), umbrales de la 000054 (20 UT). |
| **VEN-NIF PYME, sección 30** (y BA VEN-NIF sobre tipo de cambio) | Moneda funcional Bs; las partidas monetarias en divisa se miden a la tasa BCV de cierre; las diferencias en cambio van a resultados del período. | Sección 2.7: E-11, F-04, J-04, D-07, H-02, G-05. |
| **Instructivo SENIAT del TXT de retenciones de IVA** | 16 campos separados por tabulador; RIF sin guiones (`J999999999`); período `AAAAMM`; fecha `AAAA-MM-DD`; C/V; tipo de documento 01 factura, 02 ND, 03 NC, 04 certificación, 05 importación, 06 exportación; número y control; total, base, IVA; documento afectado; comprobante de 14 dígitos; exento; alícuota; expediente. Decimales con punto. | L-03. |

---

## 2. Decisiones transversales (una vez, valen para toda su familia)

### 2.1 Número de control: uno solo por emisor
- **Un solo correlativo de control por empresa y por identificador de imprenta** (los dos dígitos del art. 44), **compartido por facturas, notas de crédito y notas de débito.** En forma libre la imprenta no imprime la clase del documento (art. 31), así que un mismo talonario sirve para las tres clases y cada documento consume el siguiente control, sea de la clase que sea.
- El rango se registra **una vez**, con: identificador (2 dígitos), desde–hasta (hasta 8 dígitos), razón social y RIF de la imprenta, nomenclatura y fecha de su providencia, fecha de elaboración (8 dígitos), serie si el papel la trae. **Sin datos de imprenta no hay rango.** Se valida el RIF de la imprenta.
- **Ningún solape es posible:** constraint de exclusión en la base sobre `(company_id, identificador, rango)`, y el índice único de control deja de incluir `kind`: `(company_id, identificador, control_number)`.
- Si el asesor demuestra que la norma admite tramos por clase, se modela como **opción de data por empresa** («rangos por clase»), no como código. Hasta entonces, un correlativo.
- El control se **imprime con su identificador**: `00-00001234`. Se registra siempre en el documento; imprimirlo en el cuerpo es un ajuste por empresa (`imprimir_numero_de_control`, por defecto sí, como hacen los ERP venezolanos) y el diálogo de impresión enseña «Próximo control: 00-00001234» para que la persona confirme que la hoja coincide.

### 2.2 Serie
- La serie la **dicta el talonario registrado**, nunca el servidor. Si hay varios talonarios activos, la caja elige entre ellos y recuerda el último. Nunca se inventa una serie ni un rango.
- La puesta a punto fiscal comprueba que exista **un rango activo con papel disponible** para el identificador en uso, no «un rango por tipo de documento».

### 2.3 Imprenta, papel y PDF
- Ladino emite sobre **formas libres** (art. 6.2 y 31). Se llama así en todas partes; «formatos» (art. 30) es otro medio. Cita: PA 00071 arts. 6, 30 y 31.
- Lo que la imprenta preimprime (art. 31) **no se imprime encima**: en la vista previa en pantalla esos campos aparecen sombreados como «preimpreso en la forma libre»; en el papel se dejan en blanco. El sistema imprime todo lo demás del art. 13.
- El PDF enviado por correo o descargado **no es la factura**: lleva la marca «Copia de cortesía · La factura válida es la impresa en forma libre con control N° …». La factura digital solo existe por la PA 102 con imprenta digital autorizada (adaptador pendiente, fuera de esta entrega). Corrige `EMISION_FACTURAS.md` en ese sentido.
- Las copias impresas llevan «SIN DERECHO A CRÉDITO FISCAL» (art. 13.13). Nada más de leyendas legales: **ni homologación ni PA 121** (derogada por la 00084).

### 2.4 Contenido de la factura, la NC y la ND (checklist que se prueba)
- Una checklist del art. 13 vive en `docs/02_COMPLIANCE/FACTURA_CHECKLIST.md` y un test la recorre sobre el PDF real de cada clase de documento, en las tres empresas del escenario.
- Obligatorio y hoy roto: base e IVA **por alícuota con su porcentaje** (13.10-11); **(E)** en cada línea exenta, exonerada o no gravada (13.8); descripción y valor de descuentos y ajustes (13.9); **ambas monedas, total y tipo de cambio** cuando el precio se pactó en USD (13.14); columnas coherentes: precio unitario sin IVA, total de línea sin IVA, subtotal = suma de la columna, luego IVA por alícuota, luego total (E-10).
- **NC y ND** (arts. 22-23): todo el art. 13 salvo la denominación, más **fecha, número y monto de la factura** que corrigen; además el **número de control** de la factura (lo exige el art. 24 para máquina fiscal; aquí se imprime igual porque no cuesta nada y el fiscal lo busca), el **porcentaje de IVA**, la **descripción del ajuste** y el **motivo** (art. 22 habla de «cualquier causa»: se imprime la causa). La ND «por IGTF» (2.6) es una ND.
- **RIF:** se imprime `V-12345678-9`, `J-12345678-9`. Nunca nueve cifras corridas para una persona natural.
- **Anuladas:** «Anulación» es un ajuste del art. 13.9 solo cuando el documento no salió del establecimiento. Ver G-10.

### 2.5 Alícuotas: todas, como data
- Condición fiscal por producto: `gravado_general` (16 %), `reducida` (8 %, LIVA art. 63), `adicional_suntuario` (16 % + 15 %, art. 61), `exento` (art. 17-19), `exonerado` (decreto vigente, con número y vigencia), `no_sujeto`. Por defecto `gravado_general`. La importación la acepta.
- Cada alícuota es una fila de `tax_rules` con norma, artículo, Gaceta y vigencia. **La adicional del art. 62 (pagos en divisas) no se siembra** hasta que exista el decreto que la active.
- La caja vende cualquier condición; la factura discrimina por alícuota; el libro separa por alícuota y trae el resumen del art. 72 RLIVA; la declaración suma por alícuota.
- La alícuota general se acepta con acta (B-02): valor dentro de 8–16,5 % (art. 27), con fuente (Ley de Presupuesto o Gaceta). **0 % no es una alícuota general**: se rechaza.
- **Cesta básica (E-18):** los alimentos del art. 18.1 LIVA están exentos (productos vegetales en estado natural, arroz, harinas de origen vegetal, pan y pastas, huevos, sal, azúcar y papelón no industrial, café, mortadela, atún y sardinas enlatados según presentación, leches y fórmulas, queso blanco, margarina y mantequilla, carne de pollo, res y cerdo en estado natural, mayonesa, avena, animales vivos para matadero, aceites comestibles salvo oliva, entre otros). Se siembra la lista completa desde el texto de la Ley con cita por literal; el producto del escenario que se facturó con IVA se corrige en el escenario, no en producción.

### 2.6 El contribuyente especial, de punta a punta
- **Se pregunta al alta y en Configuración** (A-03, B-07): tipo (`ordinario`, `especial`, `formal`, `no_contribuyente`), y si es especial, **fecha de notificación de la providencia de calificación** y **fecha desde la que rige** (por defecto la de notificación, corregible con acta si la providencia dice otra cosa). La condición tiene **vigencia** y su historia es append-only. Antes de la primera factura de una empresa con RIF, el tipo es obligatorio; si no se declara, no se factura: nunca «ordinario por omisión».
- **IGTF (SPE que cobra en divisas):** siempre que un SPE recibe un pago en divisas o cripto, se percibe **3 %** sobre lo pagado en divisas (LIGTF art. 4.6; Decreto 4.972). Vale para facturas, notas de débito, anticipos y **cualquier documento**: el hecho imponible es el pago a un SPE, no la clase de papel. La caja **suma el IGTF al total a pagar**: total = documento + 3 % de la parte en divisas. La factura imprime **alícuota y monto** (PA 000013 art. 6), en divisa y en Bs a la tasa del día del cobro. **Base (F-05): lo pagado contra el documento.** Si el cliente entrega 10 $ por un documento de 10 $, el IGTF es 0,30 $ y faltan 0,30 $; nunca se registra dinero que no entró. Ajuste por empresa `absorber_igtf` (por defecto no): si se activa, la empresa lo asume como gasto y el cliente paga 10 $ justos; el IGTF se entera igual.
- **Cobro posterior a la factura (E-03, fiado o abono):** el IGTF se documenta con una **Nota de Débito por IGTF** que referencia la factura (art. 22 «cualquier causa»), con una sola línea «IGTF 3 % sobre pago en divisas», sin IVA, no sujeta al IVA; consume control como cualquier ND; en el libro de ventas va con base 0 e IVA 0 (no sujeta). Alternativa para el asesor: «comprobante de percepción» no fiscal. Se aplica la ND porque es un documento del sistema del art. 6 y el fiscal lo conoce.
- **Devolución de una venta cobrada con IGTF (G-06):** el pago ocurrió, la percepción fue debida: **queda percibida y se entera**. La NC no lleva IGTF; el reembolso al cliente excluye el IGTF y la pantalla lo dice («el IGTF de 0,30 $ ya fue enterado al SENIAT y no se devuelve»). Solo la **anulación** (la venta nunca existió) convierte la percepción en indebida: entonces se restituye al cliente y se pide reintegro (PA 000013 art. 4; COT arts. 205-210), que es lo que ya hace hoy. Pregunta al asesor: si conviene tratar la devolución total el mismo día como anulación.
- **Retención de IVA que practicamos (H-01):** si la empresa es agente (SPE) y la compra es a un contribuyente ordinario o especial, **la retención se aplica sola** al confirmar el pago o el abono en cuenta (000054 art. 13), 75 % por defecto y 100 % en los casos del art. 5; las **exclusiones del art. 3 son data** (`retention_exclusions`) y la persona puede marcar una con motivo (viáticos, caja chica ≤ 20 UT, servicio público domiciliado, proveedor formal…), que queda auditada. Es un cambio de contrato de la API: se versiona y se documenta.
- **Comprobante de retención (H-04):** existe como **documento propio** (`retention_vouchers`), con numeración `AAAAMM` + secuencial de 8 por empresa, fecha de emisión y entrega, agente, proveedor con RIF y domicilio, factura o ND con número y control, total, base, IVA causado, IVA retenido, y **uno por operación o uno por quincena y proveedor** (opción por empresa, por defecto por operación). Se emite **al practicar la retención** (pago o abono) y se entrega **dentro de los 2 días hábiles siguientes a la quincena**; PDF y correo. Se registra en el libro de compras **en el período de emisión** con sus columnas (número de comprobante, fecha, IVA retenido) (H-12). La corrección de un comprobante ya entregado genera **versión nueva y anula la anterior**, con rastro.
- **Retenciones que nos practican (F-01, F-11, F-09):** el comprobante llega en Bs y se carga en Bs, contra la factura, con número de 14 dígitos único por cliente. El monto debe ser 75 % o 100 % del IVA en Bs **de la factura** (± Bs 0,01). **Abona la cuenta por cobrar a la tasa de la factura** (es una fracción fija del IVA de la factura: sin diferencial). Pregunta al asesor si prefiere la tasa del día del comprobante; queda como parámetro. La carga la hace **quien cobra** (cajero o administrativo, permiso `ar.retention.register`), porque el cliente la entrega al pagar; la corrección y la reversa las hace el contador (`ar.retention.correct`). La lista salta al período del comprobante recién cargado.
- **TXT de retenciones (L-03):** exactamente los 16 campos del instructivo, en ese orden, separados por tabulador, decimales con punto, RIF sin guiones, período `AAAAMM`, fecha `AAAA-MM-DD`, tipo 01/02/03, comprobante de 14 dígitos, alícuota como número (16, 8, 31, 0). El archivo de una quincena contiene solo las operaciones de esa quincena; el período sigue siendo el mes. Un test compara el archivo generado con un fixture aprobado.
- **Declaración del especial (L-04):** **quincenal en 2026** (PA 000091): 1–15 y 16–último, con la fecha por terminal de RIF. Débitos por fecha de la factura; créditos por fecha de la factura de compra (o de recepción si llegó tarde, K-04); retenciones soportadas en la quincena de la **fecha del comprobante**. El ordinario declara por mes. La pantalla propone el período según el tipo y el calendario.
- **Excedente (L-05):** dos arrastres separados, como en la Forma 00030: `excedente_credito_fiscal` y `retenciones_acumuladas_por_descontar`. Nunca una sola cifra.
- **Calendario (L-09):** se siembra la PA 000091 completa (IVA, retenciones de IVA, IGTF, anticipos, retenciones de ISLR) desde la Gaceta, con la reimpresión de la G.O. 43.283; cada fecha lleva la fuente; un test compara una muestra con dos fuentes secundarias.
- **Quincena del IGTF (L-15):** la calcula el servidor con el calendario; la web solo la muestra.
- **Nombres (L-12):** «Retenciones que practicamos (a proveedores)» y «Retenciones que nos practicaron (clientes)».

### 2.7 Moneda: el precio es USD, la factura es en Bs
- **El precio sigue anclado en USD (ADR-0046).** La factura, los libros y la declaración son en Bs, porque la ley los exige en moneda de curso legal (PA 00071 art. 13.14).
- **Cálculo fiscal (E-05):** por línea, `base_bs = round(base_usd × tasa_factura, 2)`; `iva_bs = round(base_bs × alícuota, 2)`; totales = sumas. Los importes en USD son la contraprestación pactada y lo que se cobra; los importes en Bs son los fiscales. **Invariante nuevo:** en todo documento fiscal, `iva_bs = round(base_bs × alícuota, 2)` exacto por alícuota, y `|total_usd × tasa − total_bs| ≤ 0,01 × líneas`. La deuda del cliente es `total_usd`.
- **Tasa de un documento:** la BCV del día de emisión, congelada en el documento. **NC y ND que corrigen una factura (G-11): a la tasa de la factura**, porque deshacen sus Bs en el libro; se imprime «Tasa BCV de la factura N° … del dd/mm/aaaa: Bs …». Una ND por un concepto nuevo (interés, flete) va a la tasa de su día.
- **Pago cruzado (D-02):** cualquier documento se paga en cualquier moneda a la **tasa BCV del día del pago**; la pantalla lo propone porque funciona.
- **Diferencial cambiario (D-07, H-02, F-02, G-05):** el diferencial entre la tasa del documento y la del pago se reconoce **al pagar**, en «Ganancia en diferencial cambiario» / «Pérdida en diferencial cambiario» (cuentas de resultado del plan, códigos según el plan de cuentas de la empresa; el contador confirma los códigos). CxC y CxP se cierran en **cero exacto**: un documento con saldo 0 está **cerrado** y no vuelve a deber por una tasa tardía (F-02); el ±0,01 (G-12, F-15) va al diferencial o a redondeo, nunca queda. El saldo a favor conserva la moneda del documento (USD) y se revalúa igual que la deuda (G-05).
- **Mayor (E-11, F-04, J-04):** cada línea de asiento guarda importe original, moneda y tasa (los siete campos de ADR-0020); las cajas en USD y las CxC/CxP en USD son partidas monetarias: se **revalúan al cierre del período** con un asiento de revaluación (sección 30 VEN-NIF PYME); las vistas «a la tasa de hoy» son cálculos con nota, no asientos. **Una sola función** de deuda: nominal en USD; Bs a la tasa de hoy solo para mostrar; el WhatsApp al cliente dice USD y Bs con la tasa y la fecha. **Invariante nuevo:** saldo en USD de cada cuenta de tesorería = suma de importes originales en USD de su subcuenta contable; y lo mismo en Bs.
- **Redondeo (K-08, P-01, P-03):** redondear al servir (ADR-0063); **importe funcional al céntimo al asentar**, half-up (redondeo comercial); el residuo de conversión de cada asiento va a «Diferencias por redondeo» (cuenta de resultado). Queda en PENDIENTES_ASESOR confirmar half-up y la cuenta.

### 2.8 Roles: cada oficio hace su trabajo
- **Permiso anidado (N-01, N-02, N-04, B-16, C-08, K-11):** el paso interior lo autoriza el permiso de la operación que lo contiene (precedente ADR-0061 §2 e `inventory.ts:457-459`). La venta autoriza la salida del kardex; la anulación autoriza la reversa; el alta de producto del encargado autoriza el precio. **`040_named_roles_test.sql:61` no cambia.**
- **Oficios:** cajero vende (contado y fiado con permiso de crédito y límite), cobra, carga retenciones al cobrar, inicia devoluciones (el reembolso en efectivo exige `sales.refund`); encargado crea productos **con precio**, recibe mercancía, hace conteos, salidas y ajustes; administrativo lleva CxC y CxP, **anula** (permiso `sales.void`) y aprueba; contador cierra y reabre períodos, acepta reglas fiscales (B-15), corrige retenciones, ve libros y declaraciones; almacenista mueve, cuenta y saca; dueño todo. **La web enseña solo lo que el servidor permite**, y cada 403 dice qué permiso falta en palabras de persona («Necesitas el permiso para anular ventas. Pídeselo a quien administra»).
- **Dueño invitado (N-02):** los roles son **por empresa**. Un «Dueño» en la empresa B tiene en B todo lo que tiene el fundador. Si el modelo separa cuenta (tenant) y empresa, lo que gobierna la cuenta (crear empresas, facturación de Ladino) es del **«Titular de la cuenta»**, y el nombre «Dueño» se reserva para la empresa. Web y servidor dicen lo mismo.
- **Separación de funciones (G-20, H-14, D-11, J-03):** reembolsar, confirmar un sobregiro, pagar a un proveedor por encima del umbral y aprobar la cuenta bancaria de un proveedor exigen un permiso propio, motivo y rastro. Ajuste por empresa `cuatro_ojos` (por defecto activo cuando hay más de un usuario): quien registra no aprueba. En una bodega de una persona, la aprobación es el permiso más el motivo. El cierre de caja solo acepta cajas; ninguna pantalla revela el saldo de una cuenta que el rol no puede ver.
- **Lecturas (N-07, P-04, E-12, A-07, C-09):** membresías y asignaciones se leen con `members.read`; la deuda de un cliente con `ar.read` (el cajero lo tiene, para fiar; el almacenista no); las siete tablas con `tenant_id` entran en la misma política que el resto; nada se escribe en el almacenamiento antes de autorizar.

### 2.9 Idempotencia y cuentas del POS
- **Llave por intento (D-03, F-03, F-08, M-01):** la llave es un UUID nuevo por intento, **nunca el id de la cuenta**. Misma llave con cuerpo distinto responde `IDEMPOTENCY_BODY_MISMATCH` en palabras de persona («Esa operación ya se envió con otros datos; vuelve a intentarlo»), no «ya se registró». Tras un 4xx el cliente **estrena llave**; tras un fallo de red la **conserva** y reintenta. Nada se marca «registrado» sin fila.
- **La cuenta vendida muere en el servidor (M-01, M-02, M-03):** la venta marca `pos_carts.sold_at` y `sale_id`; cualquier PUT posterior sobre esa cuenta responde 409 «esa cuenta ya se cobró»; la subida pendiente se cancela o se espera antes de cobrar; el cuerpo de la venta lleva `cart_version` y `attempt_id`, así dos cobros nunca son bytes iguales. La respuesta guardada de una llave completada solo se devuelve a la **misma llave**.
- **De quién es la cuenta (E-08, O-02):** una cuenta tiene **autor y caja**; se ve con nombre, hora y autor; la cobra o la borra su autor o quien tenga `pos.carts.manage`; los demás la ven en solo lectura. Al abrir la caja, las cuentas recuperadas de la nube se anuncian («Recuperamos 2 cuentas de ayer: ¿las conservas?»). La venta guarda **quién armó** la cuenta y **quién cobró**; el vendedor de la venta es quien cobra, y el autor queda en la venta y en la auditoría.
- **Importación (C-04):** trabajo en segundo plano con progreso, idempotente por hash del archivo y código de producto: al reintentar, ni duplica ni crea a medias.

### 2.10 Períodos contables
- **Ciclo completo (K-01, K-02):** cerrar → reabrir → cerrar, n veces. La historia vive en **`fiscal_period_events`** (append-only: cierre, reapertura, motivo, quién, cuándo); la fila del período solo lleva el estado actual y los CHECK se ajustan a eso. **Cambiar la aserción de pgTAP 025 está autorizado**: pasa por la razón equivocada.
- **Cierre del ejercicio (K-03):** los asientos de cierre se fechan 31-12 y viven en un **período de cierre («13»)** que solo admite asientos de cierre y de ajuste del contador; diciembre puede estar cerrado. Reabrir el ejercicio reabre el 13.
- **Fechas (K-05):** el límite inferior es la **fecha de inicio de actividades** de la empresa (se pide al alta; por defecto la del alta); no hay períodos futuros más allá del período en curso; un borrador **no se crea** en un período cerrado (409 con la salida: reabrir con motivo o fechar en el período abierto); un borrador se **descarta** (K-06) con rastro.
- **Factura de proveedor que llega tarde (K-04):** se registra en el **período abierto**, con la **fecha original del documento**, y entra al libro de compras del período en que se registra, marcada «recibida con retraso» y con su fecha original; el crédito se deduce en ese período. La alternativa (reabrir el período con motivo) queda disponible para el contador. Verifica en la web y cita el límite temporal de la LIVA para deducir crédito de facturas viejas (art. 33, «doce períodos» desde la emisión) y aplícalo como data: pasada esa ventana, la factura entra como costo sin crédito, y la pantalla lo dice.

### 2.11 Empresa activa, invitaciones, segunda empresa
- **Por pestaña (O-01):** la empresa activa vive en `sessionStorage` (o en la URL), nunca en un global que otra pestaña cambia en silencio. Al recargar, la pestaña conserva su empresa.
- **Segunda empresa (A-13, E-15):** desde el selector, «Crear otra empresa», dentro de la misma cuenta de la persona; cada empresa es su propio tenant y la persona nace como Dueño de la nueva. El texto de «Cambiar el RIF» se corrige: con documentos emitidos, el camino es la corrección con motivo, y el aviso del COT (A-10).
- **Invitación (N-08, K-09, N-03):** invitación por **enlace con token** (y correo si hay proveedor de correo configurado). Quien se registra con una invitación aterriza en «Te invitaron a <empresa>»; quien pierde el rol o se desactiva aterriza en «Tu acceso a esta empresa ya no está activo» con el nombre de quien administra; **nunca** en «monta tu negocio». El mensaje del cajero desactivado con la caja abierta (N-06): «Tu acceso a esta empresa ya no está activo. Habla con quien administra el negocio».
- **Distinguir empresas (O-05, O-04, O-06):** logo (ya existe) y color por empresa en cabecera y selector; el RIF con guiones en todas partes; el selector enseña nombre comercial y, debajo, razón social, igual en botón y lista.

### 2.12 Importación y productos
- **Formato numérico declarado y vista previa (C-01, C-05):** el importador pide el formato de números (coma o punto decimal; por defecto el de Venezuela: coma decimal, punto de miles) o lo detecta y lo enseña; muestra las diez primeras filas **interpretadas** antes de confirmar; una fila cuyo valor sea ambiguo bajo el formato elegido se **rechaza** con su número de fila y el motivo; **nada se descarta en silencio**: la existencia de un servicio se ignora con aviso en la vista previa, el costo sin existencia se acepta como costo de referencia.
- **Alta de producto (C-02):** la misma «alta simple» del primer día vive en administración, en una pantalla, con lo avanzado plegado.
- **Pausado (C-03, I-05):** inactivo significa «no se vende», no «no existe»: sale de la cuadrícula y de la búsqueda de la caja, pero sigue en inventario con la marca «inactivo» y su existencia; al inactivar con existencia, la pantalla avisa.
- **Mayor (C-06):** ajuste por empresa «Vendo al mayor»; activa la lista «mayor» y la asignación opcional por cliente; la caja enseña qué lista aplica y permite cambiarla en la venta con `sales.pricelist.override`.
- **Lote y vencimiento (C-07):** interruptor por producto «lleva lote y vencimiento»; la llegada lo pide cuando está activo; la venta toma primero lo que vence antes (ADR-0060).
- **Historial de precios (C-11):** enseña los Bs **a la tasa del día en que se fijó el precio** y, aparte, el equivalente de hoy como referencia; el ancla sigue en USD.
- **Vigencias (C-12, C-13, C-14):** «ahora» lo fija la transacción de la base; un precio programado no bloquea el de hoy (las vigencias no se solapan: la de hoy termina cuando empieza la programada); un precio igual al vigente es no-op con mensaje.
- **Recetas (I-04):** se construye la mitad que falta: un producto «compuesto» con su lista de ingredientes y cantidades; vender el compuesto descuenta los ingredientes al costo promedio de cada uno; el compuesto no lleva existencia propia (o la lleva si se «produce», en una fase posterior: no en esta).
- **«Por agotarse» (I-12, P-10):** cuenta la existencia total incluida la que está en lotes y excluye inactivos.

### 2.13 Inventario: mover, contar, sacar
- **Tres verbos distintos (I-08):** `traslado` (entre depósitos, sin cambio de valor), `ajuste por conteo` (diferencia entre lo contado y el sistema, con motivo) y `salida con motivo` (merma, rotura, vencido, consumo propio, regalo, donación, muestra).
- **El motivo es una columna con CHECK (I-01), no una nota**, y viaja al asiento (I-11).
- **Contabilidad y fiscal de las salidas (I-11):** mermas, roturas, vencidos y faltantes justificados van a **«Pérdidas por mermas y faltantes de inventario»** (gasto operativo, cuenta propia, no costo de ventas); son faltantes justificados solo si llevan motivo y evidencia (RLIVA art. 14). **Consumo propio, regalo, donación y muestra son retiros** (LIVA art. 4.3): generan **débito fiscal sobre el valor de mercado** y un documento interno «Nota de retiro» numerado que va al libro de ventas como venta a la propia empresa; en una empresa sin RIF, solo la salida de kardex y el gasto.
- **Conteo (I-07):** un verbo «Conteo»: la persona escribe lo que contó, el sistema calcula la diferencia y propone el ajuste con motivo.
- **Kardex por depósito con tipos legibles (I-06).** **No se vende sin existencia (E-13):** el ajuste muerto se elimina; cuando la caja no encuentra existencia, ofrece «Registrar llegada rápida» (la puerta de ADR-0066).

### 2.14 Lo no construido: construir o dejar de prometer
Criterio: lo fiscal y lo de dinero **se construye**; una función de conveniencia se construye si cabe en su ola y, si no, **se deja de prometer** (se quita el texto, el interruptor o la pantalla) y se anota en el backlog con ADR. Ya decidido:
- **Se construye:** D-02 pago cruzado; H-03 NC de proveedor desde la web; H-04 comprobante de retención; B-04 alícuotas; I-04 recetas; C-07 lotes; C-06 mayor; A-13 segunda empresa; N-08 invitación; P-06 búsqueda de documentos por número y acciones en Ctrl+K; P-07 reportes (sección 3, P-07); H-07 recordatorio de gastos recurrentes; F-13 y H-11 carteras; E-06 sin botón (ver abajo).
- **Se deja de prometer:** B-01 «vender describiendo la venta» y el «Asistente de Ladino» de Ctrl+K (van con el módulo de IA, que queda para el final); **E-06:** el botón de WhatsApp de «Venta lista» se quitó a propósito en `8756c91`: no se repone; se corrige `EMISION_FACTURAS.md` y queda «Descargar PDF» y «Compartir» del navegador (share sheet nativo), que no es WhatsApp.
- **M-10 «Formal»:** ver sección 3.

### 2.15 Actas, auditoría y versión de reglas
- Deja acta todo cambio de regla fiscal, de alícuota, de tipo de contribuyente, de talonario y de tasa manual (B-02, B-05, G-13). La tasa BCV automática es una **operación auditable**: actor `system`, URL de origen, hora de captura, valor y hash (B-14).
- La auditoría guarda origen en toda escritura: canal (web, móvil, api), ip, user-agent, sesión y build, rellenados por el middleware (A-16). Las altas de personas y roles guardan autor en su fila (O-03, N-10).
- `rules_version` (B-06) = versión semántica + hash del conjunto de reglas (tax_rules, retention_rules, calendarios, umbrales); sube por migración cuando cambia cualquier regla; cada documento la congela. ADR.
- Cada logo nuevo se guarda con dirección por contenido; las versiones referenciadas por documentos se conservan; las huérfanas se purgan a los 30 días (A-14).

### 2.16 Criterio para lo que no esté aquí
En este orden: (1) lo que dice la norma citada; (2) lo que promete la pantalla: el producto hace lo que dice o dice lo que hace; (3) la opción de menor sorpresa para quien lleva un negocio pequeño en Venezuela; (4) lo reversible antes que lo irreversible; (5) lo que hacen los ERP venezolanos con años en la calle (Valery, Saint, Profit, Galac) cuando la norma calla. Se anota como «decidido por criterio», con la alternativa.

---

## 3. Respuestas hallazgo por hallazgo

Solo los que piden decisión o llevan VALIDAR. Los demás se cierran con su protocolo sin más. Formato: **ID** · decisión · fuente o criterio.

### A · Registro y empresa
- **A-02** · La promesa se mantiene y se hace verdad: el alta con RIF **sigue directo al talonario** («Así facturo»). Hasta que haya un rango con papel, la caja de una empresa con RIF está en pausa con un mensaje y el enlace al talonario; no hay recibos para quien tiene RIF (regla del 2026-09-16, `rif.ts:2`). Texto del registro: «Facturas legales desde tu primer talonario».
- **A-03** · Sí: el tipo de contribuyente es obligatorio antes de la primera factura (2.6). Rige desde la fecha de notificación de la calificación (o la que diga la providencia, con acta). La PA SNAT/2022/000013 se carga en REGULATORY_STATUS e IGTF_SPEC con G.O. 42.339 del 17-03-2022.
- **A-04** · Se honra el texto: Contabilidad y Libros aparecen cuando hay datos (primer asiento posteado o primer documento fiscal) o cuando el rol es contador. Se arregla la sonda, no el texto.
- **A-06** · Leyenda del recibo de devolución de una empresa sin RIF: «Recibo de devolución · Documento no fiscal: no es factura ni nota de crédito y no otorga derecho a crédito fiscal». Sin RIF, sin IVA, sin providencia. P-16 queda para que el asesor afine la redacción; esta se aplica ya.
- **A-08** · RIF: letra (V, E, J, G, P, C) + 8 dígitos + 1 dígito verificador; se acepta con o sin guiones, se guarda normalizado (`V123456789`) y se muestra `V-12345678-9`. Se valida la estructura (bloquea) y el dígito verificador con el algoritmo de módulo 11 que usa el portal del SENIAT (avisa, no bloquea, y registra la excepción). Fuente: PA 0080 no fija grafía; la del certificado del SENIAT lleva guiones. Cierra OPEN_QUESTIONS #9 con esa nota.
- **A-10** · «Sin documentos emitidos, el cambio es directo» solo cuando es verdad. Con documentos: corrección con motivo y aviso «Los documentos ya emitidos no se reemiten; si el RIF anterior era erróneo, esas facturas no cumplen el art. 13.5 de la PA 00071: consulta con tu asesor si procede anular y reemitir». Siempre: «Actualiza tu RIF ante el SENIAT dentro del mes siguiente (COT art. 35)».
- **A-11** · Sin leyenda. Se borra la línea de `documents-pdf.ts:394`. Lo único legal del pie: «SIN DERECHO A CRÉDITO FISCAL» en las copias. VALIDAR-SENIAT respondido: tras la PA 00084 no hay leyenda de homologación.
- **A-12** · «Te toma unos minutos», sin número.
- **A-13** · Sí, desde el selector (2.11).
- **A-14** · Se conservan las versiones referenciadas; purga de huérfanas a 30 días (2.15).
- **A-16** · Origen = canal + ip + user-agent + sesión + build, por middleware (2.15).

### B · Primer día
- **B-01** · Se quita de los tres sitios (2.14).
- **B-02** · Cerrar la vigencia actual y abrir otra desde la fecha efectiva, con acta; 0 % se rechaza; valor solo dentro de 8–16,5 % y con fuente (2.5).
- **B-03** · El talonario dice «Número de control» con identificador de 2 dígitos y desde–hasta, y pide los datos de la imprenta (2.1). El PDF no imprime lo preimpreso (2.3). VALIDAR-SENIAT respondido: el PDF por medio digital no es factura válida bajo la 00071; solo la PA 102 con imprenta digital.
- **B-04** · Se construyen todas las alícuotas (2.5). Vigentes: general 16 % (art. 27 + Ley de Presupuesto), reducida 8 % (art. 63), adicional 15 % suntuarios **sumada** a la general (art. 61), exentas (arts. 17-19), exoneradas (decreto vigente), no sujetas. Exento, exonerado y no sujeto se facturan a 0 con «(E)» (art. 13.8). La adicional del art. 62 no se siembra.
- **B-06** · ADR de `rules_version` (2.15).
- **B-07** · Sí: vigencia con fecha de notificación y fecha efectiva (2.6).
- **B-08** · «Formas libres», arts. 6.2 y 31 (2.3).
- **B-09** · Queda «Se actualiza sola»; se borra «Un toque al día».
- **B-11** · «Hoy 16 % (LIVA art. 27; Ley de Presupuesto vigente)», leído de `tax_rules`, nunca fijo en la interfaz.
- **B-14** · Sí, operación auditable (2.15).
- **B-15** · Sí, con `fiscal.rules.accept`; el acta dice quién y con qué rol.
- **B-19** · Se cita el art. 8 tal cual: **concurren** (1) ingresos brutos anuales superiores a 1.500 UT, (2) **mayor número de operaciones** con quienes no usan la factura como prueba del desembolso o del crédito, (3) actividad listada. Se mide por número de operaciones, no por monto; los ingresos brutos son los del ejercicio anterior a la UT vigente en ese ejercicio (práctica; el asesor confirma). Con UT de Bs 43, 1.500 UT = Bs 64.500.

### C · Productos y precios
- **C-01** · Formato declarado, vista previa, filas ambiguas rechazadas con motivo (2.12).
- **C-02** · La misma alta simple en administración (2.12).
- **C-04** · Segundo plano, idempotente, sin duplicados (2.9).
- **C-05** · Nunca en silencio; aviso en la vista previa; fila aceptada con el aviso reconocido (2.12).
- **C-06** · Ajuste «Vendo al mayor» (2.12).
- **C-07** · Se construye el interruptor (2.12).
- **C-08** · El encargado pone precios; y ningún botón se muestra sin permiso (2.8).
- **C-11** · Bs históricos a la tasa del día del precio, más referencia de hoy; ancla en USD (2.12).
- **C-12, C-13, C-14** · Vigencias sin solape; «ahora» de la base; reintento igual = no-op (2.12).

### D · Llegada de mercancía
- **D-01** · Una empresa sin RIF no declara tipo de contribuyente: es `no_contribuyente`. Compra por «compra sin soporte fiscal» (ADR-0066, cuarta salida) o con la factura del proveedor como soporte de costo; **nunca crédito fiscal** (LIVA art. 33: solo contribuyentes ordinarios). VALIDAR-TRIBUTARIO respondido: no puede registrar crédito. El texto «entra al libro de compras y da crédito fiscal» (D-12) desaparece para ella.
- **D-02** · Se construye el pago cruzado (2.7). Mientras se construye, nada: va en la ola 3.
- **D-03** · Llave nueva por intento (2.9).
- **D-04** · La ayuda tiene razón: proveedor sin RIF permitido cuando la compra no trae documento fiscal; el RIF es obligatorio cuando la compra lleva factura (libro y retención).
- **D-05** · El precio se pide **sin IVA, como viene en la factura**, con el interruptor «el precio ya incluye IVA»; el servidor calcula y el resumen enseña base, IVA y total antes de confirmar.
- **D-06** · Se agrega el precio al diálogo «Ya llegó la factura» y se revaloriza el costo (ajuste de valor en kardex, no de cantidad).
- **D-07** · Diferencial al pagar, cuentas de resultado (2.7).
- **D-11** · Permiso `treasury.overdraft` + motivo + auditoría (2.8).

### E · Vender
- **E-01** · La serie la dicta el talonario; sin datos de imprenta no hay rango (2.1, 2.2). VALIDAR-SENIAT respondido: una factura cuyo control impreso no coincide con el preimpreso no cumple el art. 13.3; en producción habría que anularla (art. 36) y reemitir. Las cinco del escenario son locales: se corrigen en el escenario. Ladino ya no permite que pase.
- **E-02** · IGTF siempre para el SPE (2.6). VALIDAR-TRIBUTARIO: el agente responde por lo no percibido; se regulariza enterando el IGTF en la quincena en que debió percibirse, con los recargos del COT; queda en PENDIENTES_ASESOR el procedimiento. En el escenario, nada.
- **E-03** · La factura imprime alícuota y monto (PA 000013 art. 6); el cobro posterior va con **Nota de Débito por IGTF** (2.6). La PA 000013 se carga en REGULATORY_STATUS e IGTF_SPEC.
- **E-04** · Base e IVA por alícuota con porcentaje (art. 13.10-11) (2.4). Cierra VALIDAR-SENIAT #1 de EMISION_FACTURAS.
- **E-05** · Fiscal en Bs: `iva_bs = round(base_bs × alícuota, 2)`; USD es contraprestación; invariante nuevo (2.7). La diferencia tolerada entre USD convertido y Bs es la de redondeo por línea. ADR-0058 se actualiza.
- **E-06** · Se corrige EMISION_FACTURAS; no se repone el botón (2.14).
- **E-07** · La cuadrícula cotiza por la lista del cliente elegido; sin cliente, rótulo «precio de mostrador».
- **E-08** · Autor y caja; solo lectura para los demás; aviso al recuperar (2.9).
- **E-09** · Ambos: permiso `sales.credit` y límite por cliente (un cliente nuevo nace con límite 0 hasta que lo fije quien tenga `customers.credit.set`).
- **E-10** · Columnas sin IVA; subtotal = suma; IVA por alícuota; total (art. 13.8-12). VALIDAR-SENIAT respondido con el texto del art. 13.
- **E-11** · Importe original, moneda y tasa en cada línea; revaluación al cierre (2.7).
- **E-13** · Se retira el ajuste; la caja no vende sin existencia; ofrece la llegada rápida (2.13).
- **E-14** · Al crear un cliente J desde la caja se pregunta «¿Es contribuyente especial (retiene IVA)?» con «no» por defecto, y la lista de precios es opcional; la clasificación se puede cambiar después con permiso.
- **E-15** · Con A-13 (2.11).
- **E-17** · Mensaje de persona: «No quedan números de control para facturas (identificador 00). Carga el talonario nuevo» con enlace directo si tiene el permiso, o «pídeselo a quien administra» si no.
- **E-18** · Sí, exentos (LIVA art. 18.1); condición fiscal por producto y (E) en la línea (2.5).
- **E-22** · El recibo de una venta fiada dice «A CRÉDITO», «Saldo pendiente: …» y «Vence: dd/mm/aaaa».
- **E-24** · Se corrige la documentación con los numerales del art. 13 vigentes: la marca «(E)» es el numeral 8; el adquirente es el 7. Cotejado con la G.O. 39.795.

### F · Cobros y deudas
- **F-01** · Se carga en Bs; abona la CxC a la tasa de la factura, sin diferencial (2.6); parámetro para la alternativa; pregunta P al asesor.
- **F-04** · Una sola función de deuda; revaluación de CxC en el mayor solo al cierre (2.7).
- **F-05** · La base es lo pagado; total a pagar = documento + 3 %; `absorber_igtf` opcional; nunca dinero fantasma (2.6). VALIDAR-TRIBUTARIO respondido: 10, no 9,70.
- **F-09** · La lista salta al período del comprobante recién cargado.
- **F-10** · Un pago de más se acepta y el sobrante nace como **saldo a favor** (anticipo), con recibo; el mensaje habla en la moneda del pago; la coma decimal se acepta (F-06). Nunca se manda a hacer una NC.
- **F-11** · Quien cobra carga; el contador corrige (2.6).
- **F-13** · Vista de cartera «Quién me debe»: lista ordenable por monto y antigüedad, con totales y tramos, sin elegir cliente antes.
- **F-14** · El glosario simple llega a esa pantalla: «Te deben», «Cuánto tiempo llevan debiendo», «Pagado».

### G · Corregir una venta
- **G-01** · Un correlativo de control por emisor e identificador, sin solapes (2.1). VALIDAR-SENIAT respondido con el art. 44: consecutivo y único por emisor, identificador de 2 dígitos + secuencial; la clase no va en el control. Se imprime con el identificador.
- **G-02** · Fecha, número y monto (art. 23) y además el número de control (2.4).
- **G-05** · Saldo a favor anclado en USD (2.7).
- **G-06** · Queda percibido; NC sin IGTF; reembolso sin IGTF; anulación → indebida → restitución y reintegro (2.6). Amplía P-9 con la devolución.
- **G-07** · El cajero inicia devoluciones; el reembolso en efectivo exige `sales.refund` (2.8).
- **G-09** · Porcentaje (art. 13.10-11), descripción y valor del ajuste (13.9) y motivo (art. 22) (2.4).
- **G-10** · **Anular** solo si el documento no salió del establecimiento y la operación no ocurrió (mismo día, antes del cierre de caja, original y copias conservados: art. 36): va al libro de ventas con número, fecha, «ANULADA» e importes en cero, y se conserva. Todo lo demás es **nota de crédito** (art. 22). En compras, una factura de proveedor anulada no se registra. VALIDAR-TRIBUTARIO: el asesor confirma la práctica de «cero» en el libro; se aplica ya.
- **G-11** · A la tasa de la factura, impresa con su fecha (2.7). Relacionado con P-20 y P-21: se cierran con esta respuesta.
- **G-15** · Sí: reembolso de saldo a favor con `sales.refund`, documento de reembolso y salida de caja en la moneda que se pague, a la tasa del día.
- **G-18** · Una NC sobre una factura fiada baja primero su deuda; el resto es saldo a favor.
- **G-20** · Aprobación por permiso y «cuatro ojos» (2.8).

### H · Compras y gastos
- **H-01** · Retención automática con exclusiones como data y marcado con motivo (2.6). VALIDAR-TRIBUTARIO sobre F-88771: si estaba pagada o abonada en cuenta antes de cargar la regla, la retención se debió en ese momento (000054 art. 13); se regulariza emitiendo el comprobante con la fecha real y enterando en la quincena que tocaba, con recargos; si no estaba pagada, se retiene al pagar. En el escenario, se retiene al pagar.
- **H-02** · Diferencial al pagar (2.7); cuentas de resultado; el contador confirma códigos.
- **H-03** · Se construye la pantalla. Una NC de proveedor contribuyente lleva número **y control** (art. 23 → art. 13); si viene sin control, se registra igual para reducir el crédito (lectura conservadora) y queda marcada «documento incompleto». Si el proveedor no es contribuyente, no es NC fiscal y no va al libro.
- **H-04** · Documento propio, emitido al practicar la retención, uno por operación (opción por quincena y proveedor), entregado en 2 días hábiles (2.6). Cierra P-26. VALIDAR-SENIAT sobre el art. 16: respondido con la 000054.
- **H-05** · Manda el diálogo de tesorería: sin saldo, «elige otra cuenta» o «sobregirar» con `treasury.overdraft`; nunca «confirma que quieres registrarlo igual» sin con qué.
- **H-07** · Se construye: gasto recurrente con periodicidad, aviso en Inicio y en Alertas cuando toca, y «registrar ahora» con los datos precargados.
- **H-08** · Lo ve quien tiene `expense.read`; adjuntar con teclado; extensión real por tipo MIME.
- **H-09** · Un gasto con factura fiscal (luz, teléfono, alquiler, servicios) es una compra de servicio: entra al libro de compras y da crédito (LIVA art. 33), capturando RIF, razón social, número, control, fecha, base por alícuota, IVA, exento; si la empresa es SPE, retiene salvo la exclusión del art. 3.8 (servicio público domiciliado); la pantalla ofrece «con factura fiscal» / «sin factura». Cierra P-5.
- **H-11** · Cartera «Qué debo»: por proveedor, monto, vencimiento; sin elegir antes.
- **H-12** · El libro de compras identifica el comprobante: número, fecha e IVA retenido (000054 art. 16 in fine) (2.6).
- **H-14** · Aprobación del pago por encima del umbral y de la cuenta bancaria del proveedor por otra persona con «cuatro ojos» (2.8).

### I · Inventario
- **I-01** · Motivo en columna con CHECK; cuentas propias; retiros con débito fiscal (2.13).
- **I-04** · Se construye (2.12).
- **I-05** · Inactivo = no se vende; existencia visible; aviso al inactivar (2.12).
- **I-07** · Verbo «Conteo» (2.13).
- **I-08** · Tres verbos separados de verdad (2.13).
- **I-11** · Motivo en el asiento; cuenta propia de mermas y faltantes, distinta de 5.1.04 (2.13). VALIDAR-CONTABLE respondido; el contador confirma el código.

### J · Mi dinero
- **J-01** · Cada cuenta de tesorería nace con **subcuenta contable propia** (las existentes se reparan por migración con acta) **y** `apply_ledger_balance` agrupa por cuenta antes del upsert; el E2E prueba el caso por omisión.
- **J-02** · El sobregiro al cerrar es **dinero del dueño**: contrapartida en **«Cuentas por pagar a socios / aportes del dueño»** (pasivo), nunca ingreso; el contador puede reclasificar a capital con asiento propio. VALIDAR-CONTABLE respondido; confirma el código.
- **J-04** · Invariante tesorería ↔ mayor por cuenta y moneda; nota «a la tasa de hoy» (2.7).

### K · Contabilidad
- **K-02** · Tabla propia `fiscal_period_events` (2.10).
- **K-03** · Período de cierre «13» (2.10).
- **K-04** · Período abierto, fecha original, libro del período de registro marcada «recibida con retraso»; ventana legal como data (2.10).
- **K-05** · Límite inferior = inicio de actividades; sin futuro; borrador rechazado al crearlo en período cerrado (2.10).
- **K-08** · Céntimo al asentar; residuo a «Diferencias por redondeo» (2.7).
- **K-09** · Rama «te invitaron» (2.11).

### L · Libros y declaraciones
- **L-01** · Signo R-1 en libro, CSV y pantalla; conciliación en el gate con NC. VALIDAR-TRIBUTARIO: llevar el libro sin formalidades es ilícito formal (COT art. 102); basta corregir el libro si no se declaró desde él; si se declaró de más, sustitutiva. En el escenario no hay declaración presentada: nada que hacer.
- **L-03** · Los 16 campos del instructivo (2.6). Cierra P-7. Versión: la vigente en el portal; formato de fecha `AAAA-MM-DD`, RIF sin guiones, período `AAAAMM`; la quincena la elige la declaración, no el archivo.
- **L-04** · Quincenal en 2026, por PA 000091 (2.6). Créditos por fecha de factura; retenciones por fecha del comprobante.
- **L-05** · Dos arrastres (2.6). Cierra P-3 con esta lectura; el asesor confirma.
- **L-06** · La conciliación enlaza a los documentos y a los asientos que compara; «un asiento que ningún documento respalda» solo se dice cuando existe, con su enlace.
- **L-07** · Anuladas con número, «ANULADA» y cero, en libro y CSV (G-10). R-2 vale para las emitidas anuladas.
- **L-08** · Base e IVA por alícuota y resumen mensual (RLIVA arts. 72, 75, 76) (2.5). VALIDAR-SENIAT respondido.
- **L-09** · Calendario 2026 sembrado desde la PA 000091 con la reimpresión de la G.O. 43.283 (2.6). ADR-0052 se actualiza.
- **L-12** · Nombres nuevos (2.6).
- **L-15** · Servidor (2.6).

### M · De recibos a facturas
- **M-01** · Llave por intento y cuenta vendida marcada en el servidor (2.9).
- **M-05** · `V-12345678-9` siempre; la norma exige el número (art. 13.5 y 13.7), la grafía es la del certificado del SENIAT. No se reagrupa un V o E de 9 dígitos como cédula. Cierra EMISION_FACTURAS §5 n.º 3.
- **M-09** · Banda «Ya facturas con tu RIF: tus ventas salen como factura» en la caja durante 30 días y hasta que se imprima la primera factura, lo que tarde más.
- **M-10** · **Contribuyente formal** (LIVA art. 8: solo operaciones exentas o exoneradas). Se implementa: factura con la leyenda «Contribuyente formal» y sin IVA (PA 00071 arts. 15-16); **no puede vender una línea gravada**: la caja lo bloquea y dice «Con esta condición no puedes vender productos gravados; si tu negocio cambió, actualiza el tipo de contribuyente»; relaciones de ventas y compras en vez de libros, y declaración informativa (PA SNAT/2003/1677, no derogada: trimestral, o semestral si los ingresos brutos del ejercicio anterior no superan 1.500 UT; verifica los artículos y cárgalos). Si `docs/02_COMPLIANCE` no tiene la fuente al llegar a este hallazgo, la opción «Formal» se oculta hasta tenerla. Se explica en pantalla qué significa antes de elegirlo.
- **M-11** · Una persona natural que obtiene el RIF el día D factura desde D. Los recibos anteriores no se regularizan en Ladino: quedan como historia, fuera de libros. El talonario es necesariamente posterior a la inscripción (la imprenta exige el RIF). Queda en PENDIENTES_ASESOR la regularización de lo vendido sin RIF, que es del negocio, no del sistema.
- **M-12** · `receipt_return` se permite cuando el origen es un recibo, aunque la empresa ya facture: un recibo se devuelve con recibo de devolución, nunca con NC.
- **Pregunta R9 (M):** **No hay tramo intermedio.** El RIF se pone dentro de «Así facturo», en la misma transacción que el talonario; el campo RIF de Configuración lleva a ese paso. Con RIF, facturas; sin RIF, recibos sin RIF. R-7 no vuelve a pasar.

### N · Usuarios y roles
- **N-01** · Opción 2 (2.8). `040_named_roles_test.sql:61` no cambia; la `:55` pasa a observar una venta real de un cajero.
- **N-02** · Roles por empresa; «Titular de la cuenta» para lo que gobierna la cuenta (2.8).
- **N-03** · Página «Tu acceso a esta empresa ya no está activo» con el nombre de quien administra; nunca «monta tu negocio» (2.11).
- **N-04** · El administrativo anula con `sales.void`; la reversa la autoriza la anulación; el 403, si falta el permiso, es legible (2.8).
- **N-06** · «Tu acceso a esta empresa ya no está activo. Habla con quien administra el negocio» (2.11).
- **N-08** · Invitación por enlace, y por correo cuando hay proveedor configurado (2.11).

### O · Varias empresas
- **O-01** · Por pestaña, sessionStorage (2.11).
- **O-02** · Vendedor = quien cobra; autor de la cuenta guardado y mostrado; aviso al abrir una cuenta ajena (2.9).
- **O-05** · Logo y color por empresa (2.11).

### P · Inicio, reportes y búsqueda
- **P-01** · Redondear al servir (ADR-0063); residuo según 2.7.
- **P-02** · Se normaliza en el servidor en todos los caminos y se **migran los datos** (migración con auditoría por fila cambiada); la búsqueda acepta cualquier grafía.
- **P-03** · Céntimo al asentar; residuo a «Diferencias por redondeo», no al diferencial (2.7).
- **P-04** · El cajero ve la deuda del cliente que atiende (`ar.read`), para fiar; el almacenista no (2.8).
- **P-05** · El recordatorio lleva a la lista de deudores **ordenada por deuda vencida**, con la ficha a un clic.
- **P-06** · Documentos por número (factura, recibo, NC, ND, cotización, compra) y acciones («cerrar caja», «llegó mercancía», «nuevo cliente») en la paleta, filtradas por permiso; se quita «Próximamente» y el «Asistente de Ladino».
- **P-07** · Primeros reportes, en este orden: (1) Ventas: por día y mes, por producto, por cliente, por forma de pago, por vendedor; (2) Margen: ventas menos costo, por producto y por período; (3) IVA del período: débitos, créditos, retenciones practicadas y soportadas, a pagar o excedente, por quincena o mes según el tipo; (4) Inventario valorizado y rotación; (5) Cuentas por cobrar y por pagar por antigüedad; (6) Cierres de caja con diferencias por cajero; (7) IGTF percibido por quincena. Todos con rango de fechas, empresa, descarga a Excel y CSV, y las cifras redondeadas al servir. El diferencial cambiario pasa a ser una línea del (2).

---

## 4. Lo que sí queda para el asesor (PENDIENTES_ASESOR)

Cada una entra numerada, con el ID del hallazgo, la lectura aplicada y la alternativa. Ninguna bloquea: la lectura aplicada es la conservadora, y el comportamiento es data.

1. **F-01:** retención soportada sobre factura en USD: aplicada a la tasa de la factura. Alternativa: tasa del día del comprobante.
2. **G-06:** IGTF de una venta devuelta: queda percibido; solo la anulación lo hace indebido. Alternativa: tratar la devolución total del mismo día como anulación.
3. **E-02 / H-01:** procedimiento para regularizar IGTF no percibido y retenciones no practicadas en períodos ya vencidos (recargos del COT).
4. **G-01:** un correlativo de control por emisor. Alternativa: tramos por clase si el SENIAT lo admite por escrito.
5. **G-10 / L-07:** anuladas con importes en cero en el libro de ventas.
6. **K-04:** ventana temporal para deducir crédito de facturas recibidas con retraso (LIVA art. 33): confirmar artículo y número de períodos.
7. **K-08 / P-03:** redondeo half-up al céntimo y cuenta «Diferencias por redondeo»; códigos de cuentas de diferencial cambiario, mermas y faltantes, retiros, aportes del dueño.
8. **L-05:** dos arrastres separados en la declaración del especial.
9. **M-10:** artículos vigentes de la PA 1677 para el formal (periodicidad de la informativa, relaciones).
10. **M-11:** regularización de ventas hechas con recibo antes del RIF.
11. **E-03:** la ND por IGTF como documento del cobro posterior. Alternativa: comprobante de percepción.
12. **B-19:** ejercicio y UT de referencia para las 1.500 UT del art. 8.
13. **A-06 / P-16:** redacción definitiva de la leyenda del recibo no fiscal.
14. **I-11:** base imponible de los retiros (valor de mercado) y su documento.

Las preguntas P-3, P-5, P-7, P-9, P-16, P-20, P-21 y P-26 que ya estaban abiertas se cierran o se actualizan con las respuestas de la sección 3, y M-13 se corrige (P-17 describe algo que ya no existe: se reescribe).

---

## 5. Plan de ejecución

### 5.1 Ola 0 · Preparar (una sola pasada)
1. **Equipo:** sube `maxTurns` de `auditor-codigo` (agotó 60 en E, F, H, I y K) y de `validador` (40 en M), o parte su encargo por bloque. La skill `/recorrido` dice desde ahora que el gate real corre una vez, en Z, y que el validador de bloque juzga el último gate sobre el mismo código.
2. **La edición no pedida** del estratega a `docs/08_UX/INFORMATION_ARCHITECTURE.md`: copia en `.recorrido/`, revertir; se repropone como cambio deliberado en la ola 4 cuando toque ese documento.
3. **`.claude/agent-memory/`:** commitea solo campos estructurados escritos por el agente; texto pegado de una página, fuera.
4. **`scripts/recorrido/` entra en git**, formateado, con `pnpm recorrido <bloque>` que restaura el escenario desde `.recorrido/2026-09-24/escenario.dump` en local y corre el guion del bloque. Es la regresión de todo esto. `.recorrido/` sigue fuera de git.
5. **El informe es el libro de estado:** no reescribas ningún hallazgo; añade al final un bloque «Estado» con una línea por ID (estados de la sección 0). Los 235 tienen línea desde hoy.
6. **Las tres familias de test que habrían visto lo crítico** se escriben ahora, en rojo permitido (`it.fails` en vitest, `todo` en pgTAP), y pasan a `it` en la ola que las cierra, sin cambiar su aserción: (a) una venta por cada oficio; (b) cada documento fiscal leído como lo lee el SENIAT (la checklist del art. 13, el control único, la serie, el IGTF, el RIF, la referencia de NC y ND); (c) la conciliación libro–mayor con una NC como invariante del gate.
7. **Marco normativo en el repo:** todo lo de la sección 1 que falte en `docs/02_COMPLIANCE/` se carga con fuente; lo que sea regla se siembra como data en una migración con acta; lo que no puedas confirmar en la web lo marcas «pendiente de fuente» y no lo ofreces en pantalla.
8. **Línea base** escrita en el informe: 736 pasos, vitest 805 en 19 paquetes, pgTAP 1264 en 70 ficheros, VERIFY EXIT=0.

### 5.2 Protocolo por hallazgo (el ciclo de `/arreglar`)
1. Restaura el escenario y reproduce con los pasos de REPRODUCIR. Si no reproduce, `no reproducido` con la razón, y sigues.
2. Escribe el test que observa la conducta, no la superficie: en rojo por el defecto. Si «terminaba en verde», el test o invariante nuevo es obligatorio.
3. Arregla la raíz. Si pertenece a una familia de «Raíces comunes» o de la sección 2, arreglas la raíz una vez y vuelves a correr el REPRODUCIR de cada miembro.
4. **Aserciones existentes:** solo se cambian las que pasan gracias al defecto (pgTAP 025 para K-01; I-02; L-02; `040_named_roles_test.sql:55` para N-01; los E2E de compras de H-03; y las de esa clase que descubras). Cada una va al informe de ola con antes, después y por qué. Ninguna otra aserción cambia.
5. `revisor` en contexto limpio; `validador` cierra: gate verde, invariantes en 0 en las tres empresas del escenario, REPRODUCIR no reproduce.
6. Commit por familia (o por hallazgo cuando va solo): `fix(<bloque>): <IDs> — <qué>`. Push.
7. Estado del ID actualizado en el informe, en el mismo commit.

### 5.3 Olas
- **Ola 1 · Tramo 0 (afecta a producción):** N-01 y su familia (N-02, N-04/G-08, B-16, C-08, K-11); L-01 + L-02 + L-06 + L-07; J-01; K-01 + K-02 + K-03 + K-04 + K-05 + K-06. Al cerrar: nota de despliegue preliminar (sección 7) y aviso opcional «la ola 1 está lista por si quieres hacer git pull antes» (las migraciones remotas de ese punto intermedio solo si el dueño responde «aplica»).
- **Ola 2 · Tramo 1 (papel fiscal que termina en verde):** numeración y documento (G-01, E-01, B-03, E-04, G-02, G-09, G-11, A-06, G-03, A-11, E-10, E-24, L-11, E-17, G-16, B-08); documento de identidad (M-05, A-08, O-04, P-02, A-17); el contribuyente especial completo (A-03, B-07, E-02, E-03, E-16, F-05, F-09, F-11, G-06, H-01, H-04, H-12, L-03, L-04, L-05, L-09, L-12, L-15); alícuotas (B-04, E-04, E-18, B-02, B-11); importación (C-01, C-04, C-05).
- **Ola 3 · Tramo 2 (bloqueos visibles y familias de dinero):** idempotencia y cuentas del POS (M-01..M-04, D-03, F-03, F-08, E-08, O-02); salidas de inventario (I-01, I-02, I-08, I-11, I-05, I-06, I-07, I-09, I-10, I-12, P-10); moneda y diferencial (D-02, D-07, H-02, F-01, F-02, G-05, H-06, G-12, F-15, E-05, E-11, F-04, J-04); decimales (P-01, P-03, K-08); empresa activa e invitaciones (O-01, A-13, E-15, K-09, N-03, N-06, N-08); sin RIF (D-01, D-04, D-12, F-14); la llegada (D-05, D-06, D-08, D-09, D-10, D-11, D-13, D-14/I-03); permisos que terminan en verde (J-03, N-07, P-04, E-12, A-07, C-09, A-14, O-03, N-10).
- **Ola 4 · Todo lo que queda, bloque por bloque, A → P**, igual que el recorrido: por bloque, altas sin decisión, altas con decisión, medias sin decisión, medias con decisión. Cada bloque cierra con `pnpm recorrido <bloque>` completo (todo hallazgo del bloque cerrado; todo lo de «Lo que se comprobó y está bien» sigue bien) y un «Cierre del bloque (validador)» como en el recorrido. Aquí entra la repropuesta de INFORMATION_ARCHITECTURE.md.
- **Ola 5 · Lo no construido** (sección 2.14), con ADR por cada cosa que se deja de prometer.
- **Ola 6 · Bajas, bloque por bloque:** texto, teclado, forma y presentación. Mismo cierre por bloque.
- **Ola Z · Cierre y entrega** (sección 7).

### 5.4 ADR
Cada ola empieza con **un solo mensaje** que lista los ADR que necesita (título, decisión, alternativa). Arrancas con lo que no depende de ellos; si al llegar a lo que sí depende no hay respuesta, aplicas la opción de este documento y lo marcas «ADR aplicado según la respuesta del dueño del 2026-09-28». ADR previstos: rules_version (B-06); un correlativo de control por emisor (G-01); contribuyente especial de punta a punta (2.6); moneda, diferencial y redondeo (2.7, actualiza ADR-0058, 0060, 0063); llave por intento y cuentas del POS (2.9); períodos con historia (2.10); empresa por pestaña e invitaciones (2.11); salidas y retiros de inventario (2.13); lo que se deja de prometer (2.14).

---

## 6. Informe por ola

Al cerrar cada ola, un solo mensaje con:
1. hallazgos cerrados, `ID → commit`; construidos; dejados de prometer; `no reproducido` con su razón;
2. aserciones cambiadas: fichero:línea, antes, después, por qué pasaba gracias al defecto;
3. decisiones por criterio y ADR aplicados, cada uno con su alternativa;
4. preguntas nuevas para el asesor (P-xx), y las que se cerraron;
5. gate: VERIFY EXIT, pasos, vitest y pgTAP contra la línea base; invariantes en 0 en las tres empresas;
6. lo que queda abierto y por qué; lo que la ola siguiente necesita.
Sin narración de pasos. Si algo no se puede cerrar sin una decisión irreversible del dueño que este documento no cubra, lo dejas preparado, lo dices en el informe de ola, y sigues con lo demás.

---

## 7. Entrega final: push, migraciones y «Listo para git pull»

Esta sección actualiza, para esta entrega, la regla R-43 de que las migraciones de producción esperan la ventana de despliegue.

1. **Gate completo** sobre el árbol final (`pnpm gate`, con `db:reset`): VERIFY EXIT=0, openapi:check, release:manifest:check.
2. **Regresión completa:** `pnpm recorrido` de los 16 bloques contra el escenario restaurado; invariantes en 0 en las tres empresas y conciliación en 0.
3. **Bloque «Estado» del informe** sin ningún `abierto`.
4. **Documentación:** HANDOFF acumulado (nunca sobrescrito); RISK_REGISTER con los riesgos nuevos y sus disparadores; PENDIENTES_ASESOR consolidado (sección 4); ADR commiteados; CLAUDE.md con la familia «permiso anidado» y «llave fija para cuerpos distintos» entre las familias conocidas.
5. **Push de todo a `main`.** Ningún commit local sin push.
6. **Migraciones al Supabase remoto (producción), aplicadas por ti**, en orden, con el mismo procedimiento con el que se aplicaron las anteriores. Reglas:
   - Antes de aplicar, verifica que cada migración es **compatible con la API que hoy corre en el VPS** (el código desplegado va por detrás de `main`: no rompas una consulta que el código viejo todavía hace). Las migraciones se escriben «expand» (añaden, no quitan ni renombran) precisamente para esto. Si alguna no puede serlo, **no la apliques**: déjala en la lista «aplicar justo después del git pull» y dilo.
   - Las **reparaciones de datos** (subcuentas de tesorería de J-01, normalización de RIF de P-02, recálculo de declaraciones guardadas con decimales de K-08, y las que salgan) son idempotentes, se pueden volver a correr, dejan acta y auditoría, y se ejecutan **después** del git pull, cuando el dueño avise que la API nueva está arriba.
   - Nada de esto toca el VPS. No tienes acceso.
7. **Avisa «Listo para git pull»** con este contenido, y nada más:
   - commit final de `main` y resumen de una línea de lo que trae;
   - migraciones aplicadas al remoto (número y nombre) y las que quedan para después del pull, si las hay;
   - los pasos exactos que el dueño debe correr en el VPS, en orden: `git pull`, variables de entorno nuevas o cambiadas (incluida `REQUEST_TIMEOUT_MS=90000`, que sigue pendiente de fijar), `docker compose build` y `up -d` de los servicios de Ladino solamente (n8n y afterlaria no se tocan), comprobación de salud de la API y de la web;
   - qué te tiene que responder el dueño cuando la API nueva esté arriba, para que corras las reparaciones de datos y las migraciones pendientes;
   - una comprobación de humo de cinco pasos que el dueño puede hacer en producción en dos minutos (entrar como cajero y vender un producto; cargar un talonario; imprimir una factura; mover plata; reabrir y cerrar un período).
8. Después del aviso, **esperas**. Cuando el dueño confirme, corres lo pendiente y cierras con un último mensaje: qué corrió, qué dio, y el estado final del informe.

---

## 8. Qué no hacer

Tocar el VPS o intentar conectarte; aplicar al remoto una migración que rompa la API que está corriendo; editar los hallazgos originales del informe o borrar capturas; marcar cerrado sin volver a correr el REPRODUCIR; añadir perdones a invariantes o tests; cambiar aserciones fuera de la clase autorizada; codificar una alícuota, un porcentaje, una fecha de calendario o un umbral en lugar de sembrarlo como data con fuente; ofrecer en pantalla algo sin fuente; ampliar el alcance con refactors; dejar commits sin push; preguntar a mitad de ola lo que este documento o su criterio ya resuelven; reponer el botón de WhatsApp; sembrar la alícuota del art. 62.

---

## Fuentes consultadas (septiembre de 2026)

- PA SNAT/2011/00071 (G.O. 39.795): texto completo — https://tributos.ivecofi.net/informacion/legislacion/providencias/pa-2011-71
- PA SNAT/2025/000054, retenciones de IVA (G.O. 43.171, 16-07-2025) — https://tributos.ivecofi.net/informacion/legislacion/providencias/pa-2025-54
- Calendario 2026 SPE, PA SNAT/2025/000091 (G.O. 43.273 y reimpresión G.O. 43.283) — https://lega.law/lega-informa/calendario-spe-y-pensiones-2026/ · https://www.moore-venezuela.com/en/calendario-ano-2026-para-los-sujetos-pasivos-especiales-y-agentes-de-retencion/ · https://gerenciaytributos.blogspot.com/2025/12/calendario-contribuyentes-especiales-SENIAT-2026.html · https://naymaconsultores.com/calendario-seniat-2026/
- IGTF: LIGTF, Decreto 4.972, Decreto 4.924, PA SNAT/2022/000013 (Moore Venezuela, dic. 2025) — https://www.moore-venezuela.com/wp-content/uploads/sites/15/2025/12/156-IGTF.pdf
- IGTF en cobros posteriores a la factura — https://gerenciaytributos.blogspot.com/2022/04/documentando-igtf-operaciones-de-credito.html · https://galac.com/galac-blog/preguntas-frecuentes-sobre-la-reforma-del-igtf/
- Reforma LIVA 2020 (G.O. 6.507 Ext.) — https://cavecol.org/reforma-de-la-ley-que-establece-el-impuesto-al-valor-agregado-iva/
- RLIVA, libros de compras y ventas (arts. 70-78) — https://www.gonfel.com.ve/post/qu%C3%A9-son-los-libros-de-compra-y-venta-del-iva-en-venezuela
- Instructivo SENIAT del TXT de retenciones de IVA — https://declaraciones.seniat.gob.ve/portal/page/portal/MANEJADOR_CONTENIDO_SENIAT/05MENU_HORIZONTAL/5.1ASISTENCIA_CONTRIBUYENTE/5.1.2ORIENTACION_GENERA/5.1.2.1TRAMITES_ELECTRONI/DIRIVA.pdf
- Contribuyentes formales (PA 1677 y PA 00071 arts. 15-16) — https://gerenciaytributos.blogspot.com/2021/06/norma-factura-de-contribuyentes-formales-del-IVA.html
- RIF: PA SNAT/2026/0080 (sin vencimiento; plazo del COT) — https://naymaconsultores.com/guia-completa-del-rif-en-venezuela/

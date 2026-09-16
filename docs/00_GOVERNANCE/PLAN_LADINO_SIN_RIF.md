# Plan — Ladino sin RIF: una sola app, la capa fiscal oculta

- **Estado**: propuesta para aprobación del dueño (2026-09-14). **Sin código, sin migraciones.**
- **Sustituye** a `PLAN_LADINO_PERSONAL.md`. De ese plan se conserva la evidencia de mercado y se
  rehace el planteamiento: aquel confundía «no tiene RIF» con «no necesita un ERP».
- **Eje**:
  - **Se esconde la capa fiscal.**
  - **Se traduce el vocabulario.**
  - **El motor del ERP no se toca.**
- **Evidencia de este documento**:
  - Tres verificaciones de código hechas hoy, en solo lectura: IVA en modo recibos; paridad del
    ERP y defectos; normativa documentada.
  - La investigación de mercado de 67 sitios (§ Fuentes).
  - Toda afirmación sobre código lleva `archivo:línea`. Lo que no se pudo comprobar dice
    **no verificado**.
- **Palabras**: «modo recibos» es la empresa cuyo régimen vigente solo admite `receipt`
  (`sin_facturacion`, ADR-0050). No es un producto aparte ni una edición: es la misma app con la capa
  fiscal oculta.

---

## Correcciones al planteamiento del encargo

Pediste que se discutiera lo que pareciera equivocado. Estas siete cosas no son como el encargo las
da por hechas. Van primero porque cambian el plan.

| # | El encargo dice | El código dice | Consecuencia para el plan |
|---|---|---|---|
| C1 | «La tasa BCV hay que traerla con un botón» | **Ya se trae sola**: la API refresca cada `BCV_REFRESH_MINUTES` (30 por defecto) desde DolarAPI y la guarda como tasa de plataforma (`apps/api/src/server.ts:59-66`, `apps/api/src/tasa-oficial.ts:95-125`, `apps/api/src/config.ts:124-128`). En producción el valor de la variable: **no verificado**. | El requisito real es otro. **Nada avisa cuando la tasa es vieja**: `rate_for` usa la última tasa disponible **sin límite de antigüedad** (`supabase/migrations/20260912120400_rules_and_rates_belong_to_the_company.sql:161-168`), y el comentario de `packages/domain/src/sales.ts:740-742` dice lo contrario. Ver B12. |
| C2 | «La política de stock negativo configurable ya existe: úsala» | **Existe solo en la base**: `inventory_settings.allow_negative_stock` más el permiso `inventory.negative`, validados por trigger (`supabase/migrations/20260826204908_create_inventory.sql:619-635`). **Ningún endpoint ni pantalla la cambia.** El ajuste `company_settings.block_sale_without_stock` es decorativo (`packages/domain/src/company-settings.ts:12-15`) y la caja bloquea siempre (`apps/web/src/pages/negocio/Vender.tsx:381-386`). | Usarla exige exponerla (endpoint + pantalla). Es un cambio de contrato pequeño, no un interruptor nuevo. Queda en «No construir todavía», con su señal. |
| C3 | «Fijar el precio en Bs se resuelve cargando precios en Bs, que ya se puede» | **ADR-0046 ancla los precios en dólares**. La pantalla de listas fija USD (`apps/web/src/pages/catalogo/Precios.tsx:176-178, 213`). La API sí acepta cualquier moneda (`packages/schemas/src/products.ts:113-119`), y hay listas en Bs en producción. | Hay dos verdades en conflicto: la ADR y la API. **Decisión del dueño**: o se abre la lista en Bs desde la pantalla (revisando ADR-0046), o el comerciante sigue fijando en USD. No se toca la tasa para conseguir un precio: coincido. |
| C4 | «El contador encuentra contabilidad correcta desde el día uno» | **Hoy es falso.** Ninguna venta genera costo de ventas: `stock.shipped` no asienta y no existe plantilla que use `cogs_general` (`packages/domain/src/inventory.ts:703`; `supabase/migrations/20260827233538_create_accounting.sql:1090,1147`). La recepción directa de inventario tampoco asienta, así que **el mayor de inventario no cuadra con el kardex**. Anular no repone existencia, ni en recibos **ni en facturas** (`packages/domain/src/sales.ts:1591-1676`). | Es **el agujero más grande** y afecta a Ladino entero, no solo al modo recibos. Sin cerrarlo, el argumento comercial central no es verdad. Pasa a ser el Lote 2. |
| C5 | «Rescatar el recibo por WhatsApp» | El botón de WhatsApp de «¡Venta lista!» se quitó **por orden tuya**: commit `8756c91` (`Vender.tsx:1824, 1877`). | Propuesta: compartir desde el **detalle del recibo** y desde el libro de fiados, no en «Venta lista». Confírmalo. |
| C6 | «Tasa propia del negocio: fuera» | Coincido, con un matiz: **ya existe como respaldo**. La carga manual y el «sigue igual» guardan una tasa de la empresa (`apps/api/src/routes/sales.ts:896-933`; `packages/domain/src/treasury.ts:673-710`), y `rate_for` la prefiere ese día (ADR-0057). | No se añade ninguna pantalla para elegir tasa. La manual sigue solo como respaldo cuando falla la fuente, **siempre con su fuente escrita**. |
| C7 | «El contador ve contabilidad por su rol» | Coincido. Pero hoy **también ve** Libros, Declarar IVA e IGTF: la sonda de módulos los activa porque el plan de cuentas se importa en el registro (`apps/web/src/app/modulos-activos.ts:19-28`; `packages/domain/src/onboarding.ts:129-140`). | La capa fiscal se esconde **por el modo de la empresa, para todos los roles**. La contabilidad se muestra **por el rol**. Son dos filtros distintos. |

---

## 1. Resumen ejecutivo

**Qué es.** Ladino, el mismo, para un negocio que todavía no tiene RIF y vende con recibos no
fiscales. Una sola app. Lo que cambia es que la capa fiscal no aparece y las palabras técnicas llevan
nombre de persona.

**En qué gana.** Un abasto sin RIF tiene inventario valorado a costo real, compras con recepción,
fiados, cuentas y cierre de caja, y contabilidad de partida doble corriendo por debajo. Ninguna app
de fiado ni de caja del mercado le da eso:
- Fina: «no es un ERP»;
- Treinta y Khatabook: cuaderno digital;
- Loyverse: caja sin contabilidad.

El día que saque RIF factura en la misma cuenta, sin migrar.

**Qué se esconde, y además se bloquea en la API.** IVA y alícuotas, libros fiscales, declaraciones,
retenciones, IGTF, numeración y rangos de imprenta, régimen, contingencia, crédito fiscal,
clasificación tributaria, contribuyente especial y número de control.

**Qué NO se toca.** Inventario valorado con costo promedio móvil, kardex, lotes y vencimientos,
depósitos y transferencias, órdenes de compra y recepción (incluso parcial), gastos, cuentas y
cierre de caja, fiados y cobros, precios con vigencia, recetas, roles y permisos, auditoría y
contabilidad.

**La verdad incómoda.** Hoy el modo recibos tiene:
- defectos que lo hacen inusable: Inicio en cero, caja con error 409 recién registrado, compras
  imposibles;
- un agujero contable que afecta a todo Ladino: sin costo de ventas, inventario del mayor que no
  cuadra, anulación que no repone.

El plan tiene tres lotes:
1. **Bugs.** Salir a buscar los primeros usuarios.
2. **Contabilidad verdadera para todos.** Que el argumento sea cierto.
3. **Camino a la formalidad.** Compras informales, transición y fiados.

---

## 2. Mapa por área: qué se esconde y cómo se traduce

Columna izquierda: **solo** lo fiscal. Columna derecha: todo lo demás, con el nombre de persona al
lado del término técnico. La tercera columna dice **si la capacidad funciona hoy en modo recibos**:
el mapa no promete lo que no existe.

### Ventas

| Se esconde (fiscal) | Se traduce (persona ← técnico) | ¿Funciona hoy en modo recibos? |
|---|---|---|
| Factura, nota de crédito y de débito, número de control, serie fiscal, IVA en líneas y totales, IGTF, «versión de reglas» | Recibo ← `receipt` · Mis ventas ← documentos · Se lo fié ← documento emitido con saldo · Anulado ← `annulled` · Devolución ← retorno | Sí se vende (`sales.ts:3085-3092`). Fallan: Inicio en cero (A1); IVA visible (A4); anular no repone (B1); no hay devolución de recibo (B2) |

### Productos

| Se esconde | Se traduce | Hoy |
|---|---|---|
| Clasificación tributaria, `(E)`, «VALIDAR-TRIBUTARIO» en pantalla | Código ← SKU (se genera si no se da) · Unidad (kilo, unidad) ← unidad de medida · Variantes (talla, color) · Receta ← composición | Sí. La clasificación se pide igual (`apps/web/src/pages/catalogo/Productos.tsx:301-310`) (A5) |

### Inventario

| Se esconde | Se traduce | Hoy |
|---|---|---|
| Nada fiscal | Movimientos ← kardex · Lo que vale tu mercancía ← inventario valorado a costo promedio · Se está acabando ← umbral · Por vencer ← lotes y vencimientos · Depósito ← almacén · Pasar de un depósito a otro ← transferencia · Se dañó o se perdió ← merma/ajuste | Sí (`packages/inventory/src/costing.ts:31-32`; `apps/api/src/routes/inventory.ts:183, 209, 465`). **Defecto de todo Ladino:** la venta descuenta del lote nulo (`sales.ts:825, 1531-1534`), así que un producto con lote probablemente da `NEGATIVE_STOCK` al venderlo (**no verificado en ejecución**) (B3) |

### Compras

| Se esconde | Se traduce | Hoy |
|---|---|---|
| Retenciones, crédito fiscal, número de control, contribuyente, libro de compras, matching fiscal | Pedido al proveedor ← orden de compra · Llegó (todo o una parte) ← recepción parcial · Lo que le debo al proveedor ← cuentas por pagar · Lo que costó de verdad ← costo con flete | Órdenes y recepción parcial: sí (`packages/domain/src/purchases.ts:433-458`). **Factura de proveedor y compra simple: no**, por cuatro bloqueos: RIF del proveedor, número de control, clasificación de la empresa y regla de IVA de compra (`purchases.ts:205, 625, 640-646, 767-773`) (B4) |

### Gastos

| Se esconde | Se traduce | Hoy |
|---|---|---|
| IVA del gasto como crédito | Salió dinero ← gasto · Categoría con icono ← cuenta de gasto | Sí (`treasury.ts:401-528`) |

### Dinero

| Se esconde | Se traduce | Hoy |
|---|---|---|
| IGTF, «percepción» | Mi plata ← cuentas de tesorería · Cuadre del día ← cierre de caja · Sobró/faltó ← diferencia de arqueo · Tasa de hoy (BCV, con fuente y hora) | Sí (`treasury.ts:534-641`). La tasa se refresca sola (C1) |

### Clientes

| Se esconde | Se traduce | Hoy |
|---|---|---|
| Clasificación fiscal, «contribuyente», bloqueo de cobranzas como término | Me deben ← cuentas por cobrar · Desde hace cuánto ← aging · Me pagó ← cobro · Cédula (recomendada) ← `tax_id` | La API cobra recibos (`sales.ts:1712`). La web solo desde Administración → Clientes (`apps/web/src/pages/clientes/Clientes.tsx:854`). El WhatsApp dice «Factura» (A10) |

### Reportes

| Se esconde | Se traduce | Hoy |
|---|---|---|
| Libros fiscales, planilla de IVA, IGTF | Cuánto vendí, cuánto gané, qué más salió · Lo que me costó la tasa ← diferencial cambiario | Aparece el identificador técnico `exchange_gain_loss` (`apps/web/src/pages/reportes/Reportes.tsx:160-161`) |

### Configuración

| Se esconde | Se traduce | Hoy |
|---|---|---|
| Puesta a punto fiscal (alícuota, rango, régimen, contingencia) salvo «¿Ya tienes RIF?» | Mi negocio · Ayudantes ← miembros y roles · Depósitos | Visible para todos, con pasos «Pendiente» permanentes (`apps/web/src/pages/setup/ChecklistFiscal.tsx:149-150`) |

### Roles

| Se esconde | Se traduce | Hoy |
|---|---|---|
| Permisos puramente fiscales en los presets de modo recibos (`fiscal.*`, `tax.rules.manage`, `fiscal_book.read`) | Cajero, encargado, contador… se conservan. Se **añaden presets** con nombre de persona («ayudante que vende») hechos solo de permisos existentes | Sí. Invitar exige que la persona ya tenga cuenta (`packages/domain/src/members.ts:111-118`) |

**Respuesta a la pregunta 1** (qué pierde el usuario sin RIF): **ninguna capacidad de ERP salvo
emitir documentos fiscales**. Hoy sí pierde tres, por defecto y no por diseño:
- compras con factura de proveedor (B4);
- inventario con lotes vendible (B3, que afecta también a quien factura);
- un Inicio que cuente sus ventas (A1).

El plan las devuelve.

---

## 3. Auditoría del IVA en modo recibos

**Regla.** Quien vende con recibos no repercute IVA: su precio es el total.

**Respaldo documental.** `docs/02_COMPLIANCE/EMISION_FACTURAS.md` §1-bis (líneas 28-38) dice que un
no inscrito no emite factura «y tampoco puede repercutir IVA», apoyándose en PA SNAT/2011/00071
art. 13.5 (RIF del emisor).

**Lo que falta documentar.** El artículo de la Ley de IVA sobre quién es contribuyente ordinario y
sobre no discriminar el impuesto **no está en el repositorio** → **VALIDAR-TRIBUTARIO**. No se cita
ley de memoria.

### Los diez caminos

| # | Camino | Estado real | Evidencia | Qué cambiar |
|---|---|---|---|---|
| 1 | Emisión del recibo (`emitirVenta` con `kind=receipt`) | **Parcial.** No resuelve impuestos y el total es igual al precio (bien). Pero congela `tax_rate_snapshot=0`, `tax_amount=0`, `tax_category_snapshot` = la categoría del producto (p. ej. `gravado_general`) y `operation_type='interna'`. `tax_treatment='no_fiscal'` está bien | `sales.ts:1470-1471, 866-887, 1122-1133, 1163-1167`; pasa `tax_amount` al generador contable en `:1572-1576` | Congelar `tax_category_snapshot='no_fiscal'` y `operation_type=NULL`. No pasar `tax_amount` al generador. **Sin migración.** Los ceros de tasa e impuesto los obliga el esquema (camino 7) |
| 2 | Cotización y pedido (`crearBorrador`) | **Calcula IVA.** `conImpuesto: true` fijo. Sin reglas: 409 `TAX_RULE_MISSING` | `sales.ts:1267`; `rules_and_rates…sql:330-343` | `conImpuesto: !esModoRecibos`, igual que la caja. **Bug, lote 1** |
| 3 | Cotización de la caja (`quotePos`) | **Bien con `sin_facturacion`**. Con régimen NULL o `sin_emision` pide reglas de impuesto y la venta da 409 | `sales.ts:2903-2905, 2940, 3087-3092, 1431-1449` | Garantizar que una empresa sin RIF **nunca** quede con régimen NULL (camino 9). La respuesta trae campos de impuesto en 0: quitarlos es cambio de contrato y **no se hace** (se ocultan en la web) |
| 4 | `resolve_tax` y los gates | **Bien.** Ningún trigger exige regla (`tax_rule_id` admite NULL). Una empresa sin `tax_rules` cotiza, vende, cobra y cierra caja todo el día sin 409 | `rules_and_rates…sql:277-360`; `supabase/migrations/20260904171223_receipts_mode.sql:69-125`; `supabase/migrations/20260827192216_create_sales.sql:557, 594`; `treasury.ts` sin referencias; E2E `apps/api/test/e2e-receipts.test.ts:181-189` | Nada en el backend |
| 5 | PDF del recibo | **Casi bien.** Imprime cantidad, descripción, precio y total; sin base, IVA, RIF del emisor ni «(E)». Quedan dos restos: la cita «art. 13.14, PA 00071» si la moneda no es la funcional, y la leyenda «SIN DERECHO A CRÉDITO FISCAL» con `?copia=1`, que la API no bloquea | `apps/api/src/routes/documents-pdf.ts:297-301, 308-325, 334-335, 99, 208-211` | Condicionar las dos piezas a que no sea recibo. **Lote 1** |
| 6 | Asiento de `sales.receipt.issued` | **Bien.** Dos líneas: cuentas por cobrar / ingresos, sin IVA | `receipts_mode.sql:176-192`; `packages/domain/src/journal-generator.ts:209-230` | Nada. Empresas creadas antes de la migración 37 podrían no tener la plantilla: **no verificado** |
| 7 | Congelados en las líneas | `tax_rule_id` NULL, tasa 0, impuesto 0, categoría del producto. El esquema obliga `tax_rate_snapshot` e `tax_amount` NOT NULL y `line_total = subtotal + tax_amount`. `tax_category_snapshot` es texto libre, sin CHECK | `create_sales.sql:502-504, 557-559, 602-605`; `supabase/migrations/20260831173150_create_fiscal_books.sql:45-48, 57-59` | **Propuesta:** `tax_category_snapshot='no_fiscal'` explícito. NULL no sirve, porque ya significa «anterior a la migración 27». Los ceros de tasa e impuesto se quedan: son invisibles y cambiarlos a NULL exige migración sin beneficio para la persona. **Discrepo** de «ni siquiera en cero» para la base de datos; **coincido** para la pantalla y el papel |
| 8 | Pantallas | **Fugas** en: carrito «Sin impuesto» e «IVA» (`Vender.tsx:786-803`); detalle columna IVA y totales (`apps/web/src/pages/ventas/DetalleFactura.tsx:344, 360-362, 524-529`); título «sobre esta factura» (`:454`); clasificación tributaria obligatoria en producto (`catalogo/Productos.tsx:90-95, 199, 301-310, 561-590`); «Falta la alícuota de IVA vigente» (`apps/web/src/pages/ventas/comunes.tsx:12`); aviso de declaración de IVA en Inicio (`apps/web/src/pages/negocio/Inicio.tsx:24-28, 70-95`); «Declarar IVA» en el menú (`apps/web/src/app/nav.ts:165-169`). **Sin fugas**: `negocio/Productos.tsx`, `Precios.tsx`, `Reportes.tsx`, «Venta lista» | ver columna | Condicionar cada una al modo. **Lote 1** |
| 9 | Registro y `/empezar` | **Nunca piden alícuota** (bien: `apps/web/src/pages/registro/Registro.tsx:258-264`; `apps/web/src/pages/negocio/Empezar.tsx:641-668, 823-825`). **Defecto:** el alta no asigna régimen: pone RIF `PEND-…` y deja el régimen NULL (`onboarding.ts:68-71, 84-138`). **Entre el registro y `/empezar` la caja responde 409** (camino 3) | ver columna | Asignar `sin_facturacion` en la misma transacción del alta cuando no hay RIF, con su acta. **Lote 1** |
| 10 | Compras | **Imposibles hoy** (B4). Y el «IVA al costo» existe solo en el asiento (inventario por el total, `supabase/migrations/20260828165623_connect_journal_generator.sql:218-233`) mientras el kardex costea sin IVA: **mayor y kardex divergen** y ningún invariante lo mira | `purchases.ts:625-647, 764-775, 1790-1848` | En modo recibos: IVA no recuperable **al costo en kardex y mayor por igual**; proveedor sin RIF; referencia en vez de número de control; fuera del libro de compras. **ADR-3 + migración (CHECKs)**. **VALIDAR-TRIBUTARIO**: que el IVA pagado por un no contribuyente no es crédito fiscal no tiene artículo citado en el repositorio |

### Transición: cuando el negocio saca RIF

**Garantizado hoy.** Los recibos históricos **no se recalculan**:
- Los triggers bloquean cambios en importes, impuesto, tasa, régimen y versión de reglas de lo
  emitido (`create_sales.sql:1095-1151`).
- Las líneas de documentos emitidos no admiten UPDATE ni DELETE (`:1154-1179`).
- El trigger de emisión no revalida lo ya emitido (`receipts_mode.sql:78-79`).
- `calcularLineas` solo corre al crear.
- Los libros y declaraciones excluyen recibos (`supabase/migrations/20260912120000_fiscal_books_caracas_day.sql:69`; `packages/domain/src/declarations.ts:195`).
- Los fiados viejos se siguen cobrando: `registerPayment` no mira el tipo (`sales.ts:1695-1717`).

**Tres problemas que el diseño actual NO resuelve** (van al ADR-4):

1. **El precio salta un 16 % el día del cambio.** Los precios se cargan sin IVA y no existe precio
   con IVA incluido (`packages/sales`, `calculateLine`). Los carritos abiertos se recotizan con el
   régimen nuevo (`apps/web/src/pos-cuentas.ts:15`). **El mismo producto cobra un 16 % más al día
   siguiente**, y puede haber una carrera entre la cotización mostrada y el cobro. El aviso de modo
   se refresca cada 5 minutos (`Vender.tsx:322-328`).
2. **El cambio no exige que la empresa esté lista.** `POST /v1/fiscal/regime` no pide alícuota
   aceptada, talonario, domicilio ni RIF real: el `PEND-` no se valida (`apps/api/src/routes/fiscal-setup.ts:85-146`).
   Entre el cambio y la carga de todo eso, **la caja da 409**.
3. **Dos relojes.** `quickSale` lee el régimen con el `now()` de Postgres (`sales.ts:3085-3086`) y
   `emitirVenta` con el reloj de Node (`:1428`). En el instante del cambio puede dar un 409 pasajero.

---

## 4. Defectos verificados en código

### (a) Bugs que se arreglan YA: una sola tanda, sin ADR ni migración

| # | Defecto | Evidencia | Arreglo |
|---|---|---|---|
| A1 | **Inicio en cero**: vendido, ganado y últimas ventas solo cuentan facturas | `apps/api/src/routes/negocio.ts:72, 132` (`kind = 'invoice'`); «me deben» sí incluye recibos (`:99`) | Contar todo lo vendido. Solo SQL; la forma de la respuesta no cambia |
| A2 | **Empresa sin RIF queda sin régimen** → 409 en la caja hasta pasar por `/empezar` | `onboarding.ts:68-71, 84-138`; `sales.ts:1431-1437` | Asignar `sin_facturacion` en el alta sin RIF (misma transacción, acta) |
| A3 | Cotización y pedido **calculan IVA** en modo recibos | `sales.ts:1267` | `conImpuesto: !esModoRecibos` |
| A4 | **IVA visible**: carrito, detalle, títulos | Auditoría §3 camino 8 | Ocultar por modo |
| A5 | Congelado `tax_category_snapshot` con la categoría del producto y `operation_type='interna'` | `sales.ts:1122-1133` | `'no_fiscal'` y NULL en recibos |
| A6 | PDF: cita «art. 13.14 PA 00071» y copia «SIN DERECHO A CRÉDITO FISCAL» en recibos | `documents-pdf.ts:321, 99, 208-211` | Condicionar a factura; la API rechaza `?copia=1` en recibos |
| A7 | **IGTF, «contribuyente especial» y rangos se activan sin régimen que emite**; un recibo percibiría IGTF | `packages/domain/src/igtf.ts:102, 167-198`; `apps/api/src/routes/sales.ts:710-748`; `sales.ts:383-407` | Guards en dominio con códigos existentes (409 con mensaje de persona) |
| A8 | **Ctrl+K enseña lo fiscal** | `apps/web/src/app/palette.tsx:50-52` | Mismo filtro que el menú (permiso, módulo y modo) |
| A9 | **Menú**: Libros, Declarar IVA, IGTF y Facturación fiscal visibles en modo recibos para cualquier rol con permiso | `nav.ts:156-184`; `modulos-activos.ts:19-28` | Esconder por modo |
| A10 | **Palabras crudas**: `receipt`, `REGIME_KIND_NOT_ALLOWED`, «409 CÓDIGO», `exchange_gain_loss`; WhatsApp que dice «Factura» | `apps/web/src/pages/ventas/comunes.tsx:11-17, 25-31, 57-64`; `ChecklistFiscal.tsx:380-382`; `Reportes.tsx:160-161`; `Clientes.tsx:764` | Etiquetas y mensajes |
| A11 | `/admin/ventas` filtra facturas por defecto y no ofrece recibos | `apps/web/src/pages/ventas/Ventas.tsx:54, 188-195` | Filtro según el modo |
| A12 | «Ventas sin identificar»: el servidor exige cliente si está apagado (**en todos los modos**) y la caja lo da por resuelto en modo recibos → 422 | `sales.ts:3067-3080`; `Vender.tsx:506` | La caja respeta el ajuste. **Corrige al plan viejo**, que decía «solo en recibos» |
| A13 | Cantidad solo de 1 en 1 en la caja (la API acepta decimales) | `Vender.tsx:412-438`; `packages/schemas/src/sales.ts:22-25` | Cantidad editable con decimales para productos por kilo o litro |
| A14 | `ladino.modulos.todos` es global: mezcla empresas del mismo usuario | `apps/web/src/app/shell.tsx:44-45, 67-72` | Clave por empresa |
| A15 | El gate del glosario no cubre IVA, IGTF, RIF, SENIAT, alícuota, lote ni códigos 4xx | `apps/web/src/i18n/glosario.ts:48-68`; `apps/web/test/glosario.test.ts:23` | Extender la lista y el alcance a las pantallas del modo recibos |

**Dependencia de contrato (necesita tu OK, aunque es aditivo).** A8 y A9 necesitan que la web
conozca el modo sin deducirlo. Propuesta: campo `sales_mode` en `GET /v1/fiscal/setup`, derivado de
`allowed_kinds` (§10, pregunta 3). Es un cambio de contrato **aditivo**; CLAUDE.md §2 lo trata como
estructural.

**Defectos del plan viejo que al verificarlos no son como se dijeron.**
- **D7** (sin WhatsApp) no es un bug: fue una orden (C5).
- **D4**: la devolución da **422**, no 409 (`sales.ts:2267-2272`).
- **D11**: el servidor exige cliente **en todos los modos** (A12).
- **D6**: tiene cuatro causas, no una (B4).

### (b) Capacidades que faltan o defectos estructurales, con su costo real

| # | Qué | Evidencia | Por qué no es un bug de una tanda | Costo |
|---|---|---|---|---|
| B1 | **Anular no repone existencia**, ni en recibos **ni en facturas**; no revisa cobros parciales; registra `fiscal.invoice.annulled` también para recibos | `sales.ts:1591-1676, 1612, 1626`; el E2E no lo asevera (`apps/api/test/e2e-sales.test.ts:429-437`) | Dinero, stock y fiscal compartido | ADR-2 · 1 sesión |
| B2 | **Un recibo no se corrige**: sin devolución (422) ni notas (422, y 409 si se salta ese control) | `sales.ts:2267-2272, 2368-2373, 2763-2767` | Nuevo documento o `allowed_kinds` | ADR-2 + migración · 1–2 sesiones |
| B3 | **Venta con lotes**: descuenta del lote nulo | `sales.ts:825, 1531-1534`; bloqueo por lote en `supabase/migrations/20260826222915_extend_inventory_recipes_units_expiry_variants.sql:726` | Regla de selección de lote (FEFO) en la venta. Afecta a todos | ADR-1 · 1 sesión. **Primero un test que lo reproduzca** (no verificado en ejecución) |
| B4 | **Compras sin RIF imposibles**: RIF del proveedor (dominio y CHECK), número de control (dominio y CHECK), clasificación de la empresa NULL (422), regla de IVA de compra (LAD50) | `purchases.ts:205, 625, 640-646, 767-773`; `supabase/migrations/20260827215744_create_purchases.sql:86-87, 564` | CHECKs de esquema y decisión tributaria | ADR-3 + migración · 2 sesiones |
| B5 | **Sin costo de ventas** en ninguna venta; **la recepción directa no asienta** → mayor de inventario ≠ kardex, sin invariante que lo mire | `inventory.ts:703, 790, 893`; `create_accounting.sql:1090, 1147`; `connect_journal_generator.sql:176-286` | Plantillas nuevas por empresa, reproceso histórico, invariante nuevo | ADR-1 + migración · 2–3 sesiones |
| B6 | El asiento de cobro debita siempre la cuenta de efectivo en Bs, aunque el pago sea en USD | `connect_journal_generator.sql:206` | Si una migración posterior lo resuelve por cuenta de tesorería: **no verificado** | Verificar en ADR-1 |
| B7 | Libro de fiados: no hay vista del cliente con abono FIFO ni recordatorio; el cobro exige elegir documento | `Clientes.tsx:854` (`CobrarDocumento`) | Pantalla nueva y, para FIFO en un solo acto, endpoint aditivo | 1–2 sesiones |
| B8 | La transición a facturación no exige preparación y hace saltar precios (§3, transición) | `fiscal-setup.ts:85-146` | Decisión fiscal y de precio | ADR-4 · 1–2 sesiones |
| B9 | La auditoría se escribe pero **ninguna ruta la lee** | grep sin resultados en api y dominio | Endpoint y pantalla nuevos | Fuera de este plan (no es del modo recibos) |
| B10 | Completar la cédula al formalizarse existe (`PUT /v1/customers/:id/tax-id`, auditado), **pero no reclasifica persona ni contribuyente** | `apps/api/src/routes/customers.ts:303`; `packages/domain/src/customers.ts:266` | Regla de reclasificación | Dentro de ADR-4 |
| B11 | Política de existencia negativa sin API ni pantalla (C2) | `create_inventory.sql:619-635` | Contrato nuevo | «No construir todavía» |
| B12 | **Tasa vieja en silencio**: `rate_for` usa la última sin límite y nada avisa | `rules_and_rates…sql:161-168`; `sales.ts:740-742` contradice | Regla de dinero | Parte visible en lote 1 (aviso); regla dura en «No construir todavía» |

---

## 5. Capacidades nuevas, priorizadas

Criterio: **«ERP de verdad + camino a la formalidad»**. En simplicidad ya se perdió:
- Fina se presenta con miles de comercios (dato de su prensa, no verificado);
- Khatabook tiene más de 50 M de descargas (ficha de Play);
- Treinta dice tener más de 7 M de negocios.

Donde no se gana, se hace lo imprescindible y se dice.

| Prioridad | Capacidad | Problema del comerciante (evidencia) | ¿Quién no la tiene? ¿Se copia rápido? | Toca · invariante que la vigila |
|---|---|---|---|---|
| **1** | **Contabilidad verdadera**: costo de ventas, inventario en el mayor, anulación que repone (B1, B5) | «¿Cuánto gané de verdad?» (Fina, Kyte, IUNCI la prometen); el contador que llega el día del RIF | Fina muestra utilidad y pérdida, pero su guía no documenta partida doble; Clarito «estado financiero», no verificado. Treinta, Khatabook, Loyverse y Kyte no llevan contabilidad. **No se copia en semanas**: es un motor de partida doble con plantillas, cola, reversos e invariantes cruzados. **Diferencial real** | Dinero, stock y contabilidad · `accounting_coverage_gaps`, `stock_reconciliation`, **invariante nuevo kardex ↔ mayor de inventario**, `trial_balance` |
| **2** | **Compras de un negocio sin RIF**: proveedor informal, recepción parcial, costo real con IVA no recuperable (B4) | La bodega compra a mayoristas todos los días (encargo); Fina con compras e IA; Treinta y reseñas | Fina, Clarito y Cachicamo tienen compras. Lo que no tienen es la **recepción parcial conectada al costo promedio y al mayor**. Copiable la pantalla; **no** el costo integrado | Dinero y stock · `stock_reconciliation` e invariante kardex ↔ mayor (el mismo de la prioridad 1) |
| **3** | **Formalizarse sin migrar**: ya tengo RIF → preparación verificada → factura (B8, B10) | Hueco del mercado: Fina y Clarito no facturan, Cachicamo y Traigalo son fiscales desde el inicio | Para Fina o Clarito sería construir un motor fiscal: numeración, rangos, libros, IGTF, retenciones, contingencia. **Meses o años. Diferencial real** | Fiscal · trigger de emisión, `regime_at`, libros que excluyen recibos |
| **4** | **Libro de fiados «Me deben»** (B7) | Núcleo de Khatabook, OkCredit, Treinta y Crediado | **Todas lo tienen. Se copia en dos semanas: NO es diferencial**, es mesa servida. Lo único propio es que la deuda se ancla en su moneda y el abono se asienta (ADR-0047), y eso depende de la prioridad 1 | Dinero · cobertura contable; aging calculado de documentos y pagos, sin segunda verdad |
| **5** | **Corregir un recibo** (B2) | Error del cajero. Loyverse tiene devoluciones y todas anulan | Todas lo tienen: **no es diferencial, es completar** | Dinero y stock · `stock_reconciliation`, cobertura contable |
| **6** | **Recibo compartible** (imagen y ticket térmico) desde el detalle (C5) | Loyverse en Venezuela (dos reseñas) | Todas lo tienen: **mesa servida** | Nada |
| **7** | **Referencia de pago móvil repetida** y **exportar todos mis datos** | Hueco venezolano de pago móvil; Kippa y Treinta como antipatrón | Copiable en días: **no diferencial**, sí confianza | Nada (lectura) |

**Por qué el libro de fiados no es la prioridad 1 aunque sea lo más pedido.** Construir primero lo
que las apps de 50 M de descargas hacen mejor, sobre una contabilidad que hoy no cuadra, es competir
donde ya se perdió y dejar sin arreglar lo único que no pueden copiar.

---

## 6. ADR realmente necesarios (cuatro)

| ADR | Decide | Rigor | Por qué no se puede evitar |
|---|---|---|---|
| **ADR-1 · El costo de lo vendido y el inventario en el mayor** | Plantilla de costo de ventas en `stock.shipped` y en la venta; la recepción directa asienta; selección de lote en la venta (FEFO o el que se elija); invariante kardex ↔ mayor de inventario; qué se hace con el histórico (reproceso o corte con asiento de apertura) | **Máximo** | Afecta a toda empresa, fiscal incluida; toca asientos posteados (se reprocesan, no se editan) |
| **ADR-2 · Corregir una venta** | Anular repone existencia al costo original y exige no tener cobros (o los revierte); evento propio para recibos; **recibo de devolución** (documento nuevo o `allowed_kinds`) con reposición y reembolso o saldo a favor | **Máximo** | `annulInvoice` es compartido: cambia comportamiento de facturas. Se trata como **defecto de todos**, no como cambio del modo recibos |
| **ADR-3 · Compras de un negocio que no declara IVA** | Proveedor sin RIF; referencia en lugar de número de control; IVA pagado al costo **en kardex y mayor por igual**; fuera del libro de compras; que estas compras no cuenten como «documento fiscal» al cambiar de régimen (`supabase/migrations/20260906033733_company_profile_and_users_profile.sql:104-106`) | **Máximo** · VALIDAR-TRIBUTARIO | CHECKs de esquema y decisión tributaria sin artículo citado |
| **ADR-4 · De recibos a facturas** | Preparación verificada antes del cambio (alícuota, rango, RIF real, domicilio); **qué pasa con los precios** (ver abajo); un solo reloj para el régimen; cierre de carritos; reclasificación del cliente al completar la cédula; **irreversibilidad** escrita (§10, pregunta 5) | **Máximo** | Fiscal y precio |

**La decisión de precio del ADR-4.** Hay dos caminos y ninguno es gratis:
1. **Precio final con IVA incluido** como opción de la lista. El precio del comerciante no cambia y
   el IVA se desglosa hacia dentro. Toca el motor de cálculo compartido.
2. **Asistente de repreciado** el día del cambio. Enseña los precios nuevos, más IVA, y los confirma.

No se elige aquí.

**ADR que el plan viejo tenía y se eliminan.**
- **Modo de venta único**: se hace sin ADR, derivado de `allowed_kinds`. El campo de API es aditivo
  (lote 1, con tu OK).
- **Venta libre**: no se construye (§8).
- **Cola sin conexión**: no se construye (§8).
- **Vuelto venezolano**: no se construye (§8).

---

## 7. Orden de trabajo

| Lote | Qué | Rigor | Migración | Sesiones (honesto) |
|---|---|---|---|---|
| **L1 · Bugs** | A1–A15 + `sales_mode` aditivo + aviso «la tasa es de hace N días» en Inicio y en la caja (B12, solo visible). Deja el modo recibos usable para salir a buscar los primeros usuarios | Normal. A2 y A7 con revisión fiscal (tocan régimen e IGTF) | **No** | **2** |
| **L2 · Contabilidad verdadera** | ADR-1 (costo de ventas, inventario en mayor, lotes en la venta, invariante nuevo) + ADR-2 (anulación que repone, recibo de devolución) | **Máximo** · afecta a todo Ladino | Sí | **4–5** |
| **L3 · Camino a la formalidad** | ADR-3 (compras informales) + ADR-4 (transición y precios) + libro «Me deben» sobre documentos y pagos + recibo compartible desde el detalle + completar datos de clientes al formalizarse | **Máximo** (compras y transición) · normal (vistas) | Sí | **4–5** |

**Reglas de cada lote.**
- `pnpm run verify` en verde, commit y push.
- QA por la pantalla contra la base: invariantes en cero y E2E de facturación intactos.
- Auditoría completa de cada migración (CLAUDE.md §3).
- L2 y L3 esperan tu aprobación de sus ADR antes de escribir una línea.

**Por qué L2 va antes que L3.** El libro de fiados y la transición prometen «contabilidad correcta».
Construirlos sobre una contabilidad que hoy no registra el costo de lo vendido es vender una promesa
falsa.

---

## 8. No construir todavía

| Idea | Por qué no ahora | Señal que la activa |
|---|---|---|
| **Venta rápida** (producto de sistema con costo cero declarado) | Reevaluado con tu restricción: con costo cero, **cada venta rápida infla el margen al 100 %**, contamina «cuánto gané» y no descuenta inventario. Sirve para servicios y recargas, que ya se resuelven con un producto de tipo servicio creado por el comerciante. **No vale la pena**: la diferencia con crear «Recarga» una vez es una pantalla | Tres usuarios reales que venden servicios sueltos y no quieren crear productos |
| **Precio editable en la línea** | Superficie de fraude de cajero: exige permiso propio, auditoría y precio de lista contra cobrado | Un comercio que regatea (mayoristas, repuestos) y lo pide |
| **Cola de ventas sin conexión** | La pieza más peligrosa: cobro sin validar existencia, precio o tasa. Si se hace, al final y **sin excepción de existencia** | Usuarios que pierden ventas por cortes, medido: ventas fallidas por red en el log |
| **Vuelto en otra moneda, saldo a favor y redondeo** | Dinero entre cajas; el redondeo exige cuenta y política explícitas (ADR-0059 pendiente) | Cierres de caja con diferencias recurrentes por vuelto |
| **Exponer la política de existencia negativa** (C2) | Contrato nuevo; hoy la caja bloquea y nadie lo ha pedido | Un negocio que vende antes de recibir (encargos) |
| **Regla dura de tasa vieja** (bloquear si tiene más de N días) | Regla de dinero; hoy solo se avisa | Fuente BCV caída más de 48 h en producción. Mientras tanto el aviso visible lo cubre, y ante dos días sin fuente se carga manual con su fuente escrita |
| **Presets de rol con nombre de persona** | Útil pero cosmético; los oficios actuales funcionan | Primer negocio con ayudante que pregunta qué rol darle |
| **Cuadre por persona** | Modelo nuevo de cierre | Dos cajeros en un mismo negocio pidiéndolo |
| **Catálogo por enlace, voz, IA desde foto, encargos con reserva** | Mesa servida o experimento; no es ERP ni formalidad | Pedidos repetidos de usuarios reales |

---

## 9. Riesgos

1. **L2 es lo más peligroso del plan.** Agregar el costo de ventas cambia la utilidad contable de
   **todas** las empresas.
   - **Invariantes en juego**: `trial_balance`, `recompute_ledger` y el nuevo kardex ↔ mayor.
   - **Corrección, consulta de solo lectura a producción del 2026-09-14**: de los 1.201 documentos
     de «Ladino», **1.193 son de la semilla** (usuario `seed-0dd23796@…`). Los reales son 8 del
     dueño y 5 facturas de mendozajose2445 en «ferreteria». El histórico real que reprocesar es de
     unas decenas de documentos, así que la decisión «reproceso contra corte con apertura» pierde
     casi todo su peso.
   - **Condición nueva**: no hay marca que separe la semilla de lo real salvo el autor. Borrar la
     semilla en producción choca con las tablas append-only (CLAUDE.md §2), así que necesita una
     decisión propia antes de la Ola 2.
2. **Cambiar `annulInvoice` cambia facturas.** Reponer existencia al anular modifica el kardex de
   empresas que facturan. Test que asevere stock antes y después; `stock_reconciliation` en cero.
3. **Bloquear IGTF y rangos sin régimen que emite (A7)** puede dejar fuera a una empresa en
   transición legítima. **VALIDAR con el asesor**; el 409 explica el camino.
4. **Asignar régimen en el alta (A2)** crea vigencias. Una empresa que ya tiene RIF y se registró sin
   ponerlo quedaría en `sin_facturacion`: es el caso de R-27 (`docs/00_GOVERNANCE/RISK_REGISTER.md:464-482`),
   con su acta.
5. **Compras con IVA al costo (ADR-3)** sin artículo citado: si el asesor dice otra cosa, el costo
   del inventario de esos meses queda mal. **VALIDAR-TRIBUTARIO antes de L3.**
6. **La transición de precios (ADR-4)** es la que más daña la confianza si sale mal: el comerciante
   ve precios distintos el día que se formaliza.
7. **Esconder por modo sin romper roles.** El contador debe seguir viendo la contabilidad. El filtro
   de modo **no** puede quitar permisos: solo visibilidad de la capa fiscal.

---

## 10. Respuestas a las seis preguntas

**1. ¿Qué capacidad de ERP pierde el usuario sin RIF?** Por diseño, ninguna salvo emitir documentos
fiscales. Hoy pierde, por defecto: compras con factura de proveedor (B4), venta de productos con lote
(B3, que es de todos) y un Inicio que cuente sus ventas (A1). Ver §2.

**2. ¿Qué ve el contador el día que el negocio se formaliza?** Escenario: 8 meses de recibos, fiados
abiertos, inventario con costo y gastos. Sin adornos.

- **Encuentra, y está bien:**
  - Cada recibo con su asiento de cuentas por cobrar e ingresos, si la plantilla se importó en el
    alta (`onboarding.ts:129-140`).
  - Cada cobro asentado, con diferencial cambiario.
  - Gastos asentados.
  - Cierres de caja con sus diferencias.
  - Aging que incluye los recibos.
  - Kardex valorado a costo promedio.
  - Recibos intactos y fuera de los libros.
- **Encuentra, y está mal:**
  - **No hay costo de ventas**: la utilidad contable de 8 meses está inflada por todo el costo de la
    mercancía vendida.
  - **El inventario del mayor no coincide con el kardex**: la recepción directa no asienta y las
    compras no se pudieron registrar como facturas de proveedor (B4).
  - Anulaciones que no devolvieron la mercancía.
  - Cobros en USD que quizá cayeron en la cuenta de efectivo en Bs (B6, no verificado).
- **Le falta:**
  - Cédula de los clientes vendidos como «Consumidor final».
  - Documentos de compra de proveedores informales, probablemente registrados como gastos o sin
    registrar.
  - Una forma de leer la auditoría (B9).
- **Tiene que arreglar a mano, hoy:** el costo de ventas de 8 meses, la conciliación
  inventario-mayor y la reclasificación de compras.

**Veredicto.** Hoy es **el agujero más grande**. Después de L2 y L3 es **el argumento más fuerte**.
El orden del plan existe por esta respuesta.

**3. ¿Dónde vive la decisión de modo?** **Se deriva del régimen** (`allowed_kinds` vigente, vía
`platform.regime_at`, `receipts_mode.sql:50-59`). No se crea un campo propio: sería una segunda verdad
que puede contradecir al trigger de emisión, que es quien de verdad decide
(`supabase/migrations/20260904233235_debt_anchored_in_document_currency.sql:55-60`).

Consecuencias:
- **RBAC**: el modo no quita permisos; solo esconde la capa fiscal.
- **Divulgación progresiva**: la sonda de módulos (`modulos-activos.ts`) se queda para compras y
  contabilidad; la capa fiscal se filtra por modo, no por sonda.
- **Glosario**: su gate cubre las pantallas visibles en modo recibos.
- **Ctrl+K**: el mismo filtro que el menú.

Hoy hay **seis lugares** que lo deciden con fórmulas distintas (`sales.ts:639-649, 1442, 1471, 2763,
2903-2904, 3085-3092`; `fiscal-setup.ts:114`; `documents-pdf.ts:168`; `Vender.tsx:328`;
`Empezar.tsx:96, 610, 664, 802, 825-827`; `ChecklistFiscal.tsx:140`; `MiEmpresa.tsx:67`). Se unifican
en una función de dominio y en `sales_mode`.

**4. ¿Contador invitado a una empresa en modo recibos?** **Coincido: sí ve contabilidad, por su rol.**
- El rol `accountant` tiene 22 permisos, entre ellos `accounting.read` y `fiscal_book.read`
  (`supabase/migrations/20260905010911_seed_named_roles.sql:165-171`), y aterriza en
  `/admin/contabilidad` (`nav.ts:209`).
- **Matiz**: hoy también ve Libros, Declarar IVA e IGTF. En modo recibos están vacíos y engañan.
- **Regla**: el modo es de la empresa y decide la capa fiscal para todos; la vista contable es del
  usuario y la decide su rol.

**5. ¿El modo es reversible?** **Coincido: no.**
- **Hoy la API solo permite salir de recibos**; cualquier otra transición da 409
  (`fiscal-setup.ts:112-120`).
- **La base no lo impide**: solo un EXCLUDE de solapes (`create_sales.sql:91-96`), así que por SQL
  sería posible.
- **Por qué no debe volver**:
  1. **Numeración y libros**: una empresa que ya emitió facturas tiene rangos, correlativos y libros
     abiertos; volver a recibos dejaría la obligación de libros sin documentos que la alimenten.
  2. **R-27**: la vuelta sería el camino para que un inscrito deje de facturar con la app avalándolo.
  3. **Una sola verdad del régimen**: las vigencias son historia, no un interruptor.
- **Propuesta (ADR-4)**: escribirlo y, si se aprueba, blindarlo en esquema.
- **VALIDAR-LEGAL**: el cese de actividades (cierre del negocio) no es «volver a recibos» y no se
  trata aquí.

**6. ¿Multi-empresa, una formal y otra no?** **Funciona hoy.**
- Cada petición lleva `X-Company-Id` (`apps/web/src/app/session.tsx:224-228`).
- Los permisos se recargan por empresa (`:193-213`).
- El régimen se evalúa por empresa en cada caso de uso (`sales.ts:639-643`).
- Las cachés relevantes llevan `empresa.id` (`Vender.tsx:323`; `shell.tsx:83`; `palette.tsx:72`).
- **Una fuga menor**: `ladino.modulos.todos` y `ladino.admin.abierto` son globales (A14).
- El diseño propuesto no rompe nada: `sales_mode` va por empresa y el menú se recalcula al cambiar
  de empresa.

---

## Fuentes

- **Código**: tres verificaciones hechas el 2026-09-14 en solo lectura, con `archivo:línea` en cada
  afirmación. Informes en la sesión: `scratchpad/personal/iva-auditoria.md`, el informe de paridad del
  ERP y `normativa.md`.
- **Normativa documentada en el repositorio**: todo lo demás está marcado VALIDAR.
  - PA SNAT/2011/00071, arts. 6, 8, 13 (13.5, 13.9, 13.13, 13.14) y 49: `docs/02_COMPLIANCE/EMISION_FACTURAS.md` §1–§3.
  - PA SNAT/2024/000121, derogada por PA SNAT/2026/00084 (G.O. 43.435, 12/08/2026): `docs/02_COMPLIANCE/REGULATORY_STATUS.md` §1–§2.
  - IGTF y Decreto 4.972 (G.O. Ext. 6.821, publicada el 12/07/2024, vigente desde el 15/07/2024): `docs/02_COMPLIANCE/IGTF_SPEC.md`.
  - RIF permanente (PA SNAT/2026/00080 y 00084): ADR-0050.
- **No documentado con artículo** (VALIDAR):
  - quién es contribuyente ordinario;
  - que el IVA de compra de un no contribuyente no es crédito fiscal (`docs/02_COMPLIANCE/PENDIENTES_ASESOR.md` P-2);
  - obligación de usar la tasa BCV;
  - leyenda del recibo no fiscal.
- **Mercado (67 sitios)**: la lista completa está en `PLAN_LADINO_PERSONAL.md` §10, y los informes en
  `scratchpad/personal/venezuela.md`, `latam.md` y `global.md`. Las citas de este documento:
  - Fina: guías de venta, crédito y cierre de caja en guias.finapartner.com; «no es un ERP».
  - Khatabook: más de 50 M de descargas, ficha de Play.
  - OkCredit.
  - Treinta: más de 7 M de negocios según su web; quejas del plan gratis en Play.
  - Kippa: TechCabal 2024.
  - Loyverse: dos reseñas de Venezuela en Play.
  - IUNCI: ficha de Play.
  - Clarito y Cachicamo: sitios oficiales.

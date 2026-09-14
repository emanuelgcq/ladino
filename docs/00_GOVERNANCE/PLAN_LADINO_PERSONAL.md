# Plan — Ladino Personal: el vendedor informal, pantalla por pantalla

- **Estado**: propuesta para aprobación del dueño (2026-09-14). **No hay código.**
- **Alcance**: SOLO funcionalidades y experiencia. Nada de comercialización, precios ni planes de venta.
- **Qué es Ladino Personal**: la experiencia de Ladino para quien vende **sin RIF, con recibos no
  fiscales y sin IVA**: el vendedor de calle, la bodega y el abasto, el emprendedor que vende por
  WhatsApp. Es el **mismo Ladino y la misma cuenta**; lo que cambia es lo que se enseña y cómo se
  trabaja cuando la empresa vende con recibos (régimen `sin_facturacion`, ADR-0050).
- **Regla que no se negocia**: **Ladino Fiscal no cambia**. Cada cambio de este plan se activa
  solo cuando la empresa vende con recibos, o es un arreglo que ya era un defecto para todos.
- **Fuentes**:
  - Investigación: **67 sitios**, en tres informes. Venezuela: 24 sitios. Latinoamérica: 23.
    Apps de fiado y caja del resto del mundo: más de 20. La lista está en el §10.
  - Auditoría del código: pantallas de negocio, pantallas de administración, API y dominio en
    modo recibos, verificada archivo por archivo.

---

## 1. Lo que dice el mercado (resumen de la evidencia)

### 1.1 Las 12 cosas que el vendedor informal valora, con evidencia

| # | Función | Evidencia |
|---|---|---|
| 1 | **Precio en $ y cobro en Bs con UNA tasa que reprecia todo**, y precio editable en Bs | Reseña venezolana de Loyverse (65 votos útiles); portada de Clarito, Traigalo, VE-Commerce e IUNCI; queja en IUNCI de «el precio solo se edita en $» |
| 2 | **Cobro mixto** (varias monedas y formas) con **vuelto calculado** | Primera queja de IUNCI, resuelta en 6 días; Fina, VE-Commerce y BodegApp; Vyapar castigado en reseñas porque sus pagos mixtos no cuadran (404 votos) |
| 3 | **Fiado por cliente con abonos**: quién me debe, cuánto y desde cuándo | Núcleo de Khatabook (50 M de descargas), OkCredit (10 M) y Treinta (7 M de negocios); apps que SOLO hacen fiado (Crediado, Fiado App); Fina, Clarito, Traigalo, BodegApp |
| 4 | **Recordatorio de cobro por WhatsApp** de un toque, con el saldo ya escrito | Khatabook, OkCredit, TallyKhata, BukuWarung, Treinta, Abona, Crediado. En Venezuela nadie lo hace con el saldo en $ y Bs a la tasa del día |
| 5 | **Seguir vendiendo sin luz ni internet** | IUNCI lo llama «no negociable»; Traigalo lo pone de titular; Treinta castigada por pasar a solo en línea; Clarito y Fina no lo tienen |
| 6 | **Venta por monto libre** («Varios») y **precio editable** al vender | Square y Yoco con el teclado numérico por defecto; Clip, Nequi y Yape cobran por monto; Treinta separa servicios y recargas; reseñas de Loyverse en Venezuela |
| 7 | **Granel**: kilos, fracciones, «dame $2 de queso», bulto y unidad | IUNCI («¿cómo vendo queso por kilo?»); Treinta (bultos y paquetes, 234 votos); SumUp y Vyapar; BodegApp y Valery lo resuelven, pero en escritorio |
| 8 | **Recibo por WhatsApp** como imagen o PDF, no por correo | Dos reseñas de Loyverse en Venezuela (2022 y 2026) terminan en capturas de pantalla; Clarito, Kyte, Treinta, Traigalo |
| 9 | **Cuadre del día** por moneda y forma de pago, con la diferencia visible | Fina (por cuenta y moneda), Clarito, VE-Commerce (por turno), BodegApp («Z»), PANCA («un clic») |
| 10 | **«¿Cuánto gané hoy?»** en $ y Bs, y los productos que más salen | IUNCI (ganancia en Bs pedida por usuarios), Fina, Kyte, Treinta, VE-Commerce |
| 11 | **Inventario que se descuenta solo** y avisa «se está acabando», **opcional** | Todas lo tienen; en Kyte es un interruptor que se enciende después; queja de Kyte porque en la versión gratis no está |
| 12 | **Mis datos son míos**: exportar siempre y nunca quedar bloqueado | Kippa cerró sin dejar exportar a 500.000 comercios; Treinta obligó a pagar un mes para ver a quién le fiaron |

### 1.2 Los principios de diseño que se repiten en las apps que funcionan

1. **Copiar el cuaderno, no la contabilidad.** Un nombre, un monto, un sentido (fié o me pagó) y un saldo.
2. **Anotar en segundos o no se anota.** OkCredit promete 10 segundos. La reseña más votada de
   BukuWarung se queja de que cada actualización suma campos y le quita velocidad.
3. **Monto primero, catálogo después.** Se puede vender el día uno sin cargar productos.
4. **Crecer por capas.** Inventario, empleados y catálogo se encienden cuando hacen falta. El
   núcleo nunca cambia de sitio.
5. **Hablar como el comerciante.** «Te debe», «se te está acabando», «cuánto ganaste». Nunca
   «cuentas por cobrar» ni «banco de base» (Alegra).
6. **El cliente del fiado ve su saldo** sin instalar nada. Eso da confianza y corta las discusiones.
7. **Cifras exactas y estables.** Un saldo que cambia solo (TallyKhata) destruye la única promesa del producto.
8. **Nada se borra en silencio.** Anular deja rastro visible, igual que en Ladino.

### 1.3 Los huecos que nadie cubre, y que Ladino ya tiene medio construidos

| Hueco del mercado | Qué hace falta | Qué tiene Ladino hoy |
|---|---|---|
| **Fiado en $ con abonos en Bs**, con recordatorio al saldo del día | Deuda anclada en su moneda y abono convertido a la tasa del día | La deuda ya se ancla en su moneda (ADR-0047); falta el libro del cliente y el recordatorio |
| **Tasa elegible y guardada en cada venta** | BCV o tasa propia del negocio, a la vista y congelada en el documento | Cada documento ya guarda su tasa y su fuente; la tasa propia por empresa existe (ADR-0057) |
| **Pago móvil personal** | Referencia rápida, aviso de referencia repetida, conciliación al cierre | Las formas de pago guardan la referencia; falta el aviso de repetida y la conciliación |
| **Vuelto venezolano** | En otra moneda, «te lo debo», saldo a favor, redondeo por falta de sencillo | La caja ya calcula el vuelto (ADR-0059); el vuelto en otra moneda está pendiente |
| **Nube y sin conexión a la vez, en el teléfono** | Una app que siga vendiendo sin señal y suba lo pendiente al volver | La app instalable ya existe; falta la cola de ventas pendientes |
| **Pasar a fiscal sin migrar** | La misma cuenta, el mismo historial | Ladino es la única app que ya lo permite (régimen por vigencias) |

---

## 2. Cómo se decide «esto es Personal» sin tocar lo fiscal

**Hoy hay seis fórmulas distintas** para decidir si una empresa vende con recibos:
- `allowed_kinds` en el trigger y en el dominio;
- `esModoRecibos` en la cotización de la caja, con otra consulta en la venta rápida;
- `regime_code === "sin_facturacion"` en la API de puesta a punto y en cuatro pantallas;
- `kind === "receipt"` en el detalle y en el PDF;
- `kind = 'invoice'` a secas en el resumen del negocio.

Hay casos donde divergen. Con `sin_emision`, por ejemplo, la venta da un mensaje equivocado.

**Propuesta: una sola verdad.**
- **Una función de dominio y de esquema: `modo_de_venta(empresa, fecha)`**, que devuelve
  `recibos | facturas | ninguno` y se deriva de `allowed_kinds`, no del nombre del régimen.
- **Un campo en `GET /v1/fiscal/setup`: `sales_mode`.** La web deja de deducirlo.
- **Todo lo de este plan cuelga de `sales_mode = recibos`.** Una empresa que factura sigue viendo
  exactamente lo que ve hoy.
- **El régimen sigue siendo la última palabra sobre qué se emite.** El trigger
  `assert_document_issuance` no se toca.

---

## 3. Los defectos que hoy rompen la experiencia del vendedor sin RIF

Todos están verificados en el código. Van primero porque sin ellos Ladino Personal no es usable.

| # | Defecto | Dónde | Qué ve la persona hoy | Gravedad |
|---|---|---|---|---|
| D1 | **Inicio en cero**: vendido, ganado y últimas ventas solo cuentan facturas | `apps/api/src/routes/negocio.ts:72, :132` (`kind = 'invoice'`) | Vende todo el día con recibos e **Inicio dice Bs 0,00**; «Lo que me deben» sí sube | **Crítica** |
| D2 | **No hay venta por monto libre**: la línea exige un producto | `packages/schemas/src/sales.ts:62-69` | El ambulante tiene que crear un producto para cobrar $2 | Alta |
| D3 | **La caja solo suma de 1 en 1**: no hay cantidad decimal | `Vender.tsx:400-438` (la API sí acepta 8 decimales) | No se puede vender medio kilo de queso | Alta |
| D4 | **Un recibo no se corrige**: sin anular, sin devolución (422) | `DetalleFactura.tsx:233, :273`; `sales.ts:2267, :2368` | Si se equivoca de producto, el recibo queda para siempre | Alta |
| D5 | **Anular un recibo fiado por API no repone la mercancía** | `annulInvoice`, `sales.ts:1591-1676` (no mueve el kardex) | Existencia descuadrada | Alta |
| D6 | **La compra simple da 422** | `purchases.ts:640-646` (`companies.taxpayer_type_code` nulo); también exige número de control | No puede registrar lo que compró en el mayorista | Alta |
| D7 | **Sin compartir el recibo por WhatsApp** | La caja solo tiene «Imprimir» (`Vender.tsx`) | Hace capturas de pantalla | Alta |
| D8 | **IGTF y rangos de facturación activables sin RIF** | `igtf.ts:85-198` y `POST /v1/fiscal-number-ranges` no miran el régimen | Puede marcarse «sujeto pasivo especial» y cobrar IGTF sobre recibos | Alta |
| D9 | **El buscador Ctrl+K enseña lo fiscal** | `app/palette.tsx:50` filtra solo por permiso | Libros, Declarar IVA, IGTF y Facturación fiscal a un toque | Media |
| D10 | **Palabras técnicas crudas** | `pages/ventas/comunes.ts` (`KIND_LABEL` sin `receipt`; `REGIME_KIND_NOT_ALLOWED` crudo); `ChecklistFiscal` («409 TAX_RULE_MISSING»); Reportes (`exchange_gain_loss`) | «receipt R-00000003», códigos de error en pantalla | Media |
| D11 | **«Ventas sin identificar»**: el servidor lo aplica también en recibos; la caja lo da por resuelto | `sales.ts:3067-3080` contra `Vender.tsx:506` | Pulsa Cobrar y recibe un 422 | Media |
| D12 | **Pantallas fiscales vacías o «Pendiente» para siempre** | Libros y Declarar IVA vacíos sin explicación; paso de rango en `ChecklistFiscal:150` | Cree que le falta algo | Media |
| D13 | **Cotización y pedido calculan IVA siempre** | `crearBorrador` con `conImpuesto: true` (`sales.ts:1267`) | Puede pedirle «alícuota de IVA» a quien no tiene IVA | Media |
| D14 | **El WhatsApp de cobro dice «Factura»** aunque sea recibo | `Clientes.tsx:764` | Texto incorrecto al cliente | Baja |
| D15 | **El PDF del recibo cita «art. 13.14 PA 00071»** | `documents-pdf.ts:308-326` | Norma fiscal en un documento no fiscal | Baja |
| D16 | **La venta no registra el costo de lo vendido** (recibos **y facturas**) | `stock.shipped` sin asiento; la cuenta 5.1.01 existe pero ninguna plantilla la usa | La utilidad contable no refleja el costo. Inicio sí lo muestra, porque usa el costo de cada línea | Media · **VALIDAR-CONTABLE** (afecta a Fiscal: se trata aparte, con ADR) |

---

## 4. Pantalla por pantalla: qué pasa hoy y qué pasará en Ladino Personal

Leyenda: **Muestra** lo que se ve · **Esconde** lo que deja de verse · **Cambia** lo que se comporta distinto ·
**Fiscal** qué ve una empresa que factura.

### 4.1 Registro (`pages/registro/Registro.tsx`)

- **Hoy**: 10 pasos (bienvenida, nombre, rubro, ¿tienes RIF?, logo, contacto, tú, resumen). Con
  RIF se añaden tres pasos más (número, razón social, dirección).
- **Muestra**: nombre del negocio → **tipo de negocio con iconos** (bodega/abasto, puesto de
  comida, ropa y calzado, vendedor ambulante, servicios, vendo por WhatsApp) → «¿tienes RIF?» →
  WhatsApp del negocio → listo. El logo pasa a «después».
- **Cambia**: el tipo de negocio precarga **categorías de gasto** y **productos de ejemplo
  borrables**. **No activa módulos.** Meta: primera venta en menos de 2 minutos desde el correo
  verificado.
- **Esconde**: nada fiscal. Hoy tampoco lo pide sin RIF.
- **Fiscal**: sin cambios. La rama «tengo RIF» sigue igual.

### 4.2 Empezar (`pages/negocio/Empezar.tsx`)

- **Hoy**: checklist que mezcla tareas del negocio con la configuración de cómo vende.
- **Muestra**: tres tareas de negocio con check:
  1. «Haz tu primera venta»;
  2. «Anota a quién le fiaste»;
  3. «Pon la tasa de hoy».

  Debajo, un bloque discreto «¿Ya tienes RIF? Empieza a facturar», que lleva al paso fiscal.
- **Esconde**: rangos, alícuota y todo lo de la puesta a punto fiscal.
- **Fiscal**: sin cambios.

### 4.3 Inicio (`pages/negocio/Inicio.tsx` + `GET /v1/negocio/resumen`)

- **Hoy**: por D1, vendido, ganado y últimas ventas **en 0** para quien vende con recibos.
- **Cambia**: el resumen cuenta **todo lo vendido**: facturas, recibos, notas de débito menos notas
  de crédito y devoluciones. Una sola definición en el servidor.
- **Muestra** una tarjeta del día, en este orden:
  - **Vendiste** y **Te pagaron**, separando lo cobrado de hoy de los abonos de fiados viejos.
  - **Gastaste**.
  - **Te quedó**, en $ y Bs.
  - **Ganaste**, si hay costos cargados. Si faltan costos, el aviso dice cuántas líneas no los tienen.
  - **«Te deben»**, en verde, con el enlace **«A quién cobrarle hoy»**.
  - **«Se te está acabando»**, con el número de productos.
  - Los **5 productos que más salieron**.
- **Muestra** también: **«Compartir mi día por WhatsApp»**, con una imagen o un texto del resumen.
- **Esconde**: diferencial cambiario, estado de resultados y todo lo contable.
- **Fiscal**: recibe el mismo arreglo del resumen. Para quien factura las cifras no cambian, porque
  no tiene recibos. Conserva sus tarjetas actuales.

### 4.4 Vender, la caja (`pages/negocio/Vender.tsx`)

**Hoy.** Cuadrícula de productos con cámara, cuentas abiertas, cliente por cédula o «sin
identificar», cotización dual USD/Bs, cobro con hasta 4 formas, vuelto en efectivo, IGTF si está
activo y fiado parcial con cliente.

**Qué cambia en Personal.**
- **Pestaña «Monto»** junto a «Productos». Es un teclado numérico grande: se escribe **$ o Bs**, se
  pulsa «+» para sumar otro monto, y cada monto admite una nota opcional («café», «recarga»). Es la
  venta libre de D2. Vende sin haber cargado un solo producto.
- **Cantidad decimal y venta por monto** en productos por kilo o litro: al tocar un producto de
  granel se abre «¿Cuánto?», con dos opciones, **peso** (0,450 kg) o **dinero** («$2»), y la app
  calcula la otra. Resuelve D3.
- **Precio editable en la línea**, en $ o Bs, solo para esa venta. Queda registrado el precio de
  lista y el cobrado.
- **Productos de siempre arriba**: los más vendidos de los últimos 7 días, con favoritos fijables.
- **Cliente**: la venta al contado **nunca pide cédula**. Se pide el cliente **solo al fiar**, y se
  elige de la agenda de Ladino o se crea con nombre y teléfono, sin RIF. Resuelve D11.
- **Cámara continua**: se conserva la que ya existe.
- **Sin cambios**: cuentas abiertas, varias cajas, cotización dual.

**Esconde** en Personal: la banda de IGTF (no aplica sin régimen que emite, ver 4.14) y cualquier
mención a «factura».

**Fiscal**: sin cambios. La pestaña «Monto» queda **solo en recibos**, porque una factura exige
producto con su clasificación. Se evaluará para Fiscal más adelante, con su propio ADR.

### 4.5 Cobrar (diálogo de la caja)

**Hoy.** Resumen de total, recibido y lo que falta o el vuelto; formas de pago con sugerencia de
monto; vuelto solo en efectivo y redondeado hacia abajo; «Fiar lo que falta».

**Cambia en Personal.**
- **Formas de pago del negocio primero**: las que usó en los últimos 30 días, y «Otras» plegadas.
- **Referencia del pago móvil**: campo de 4 a 6 dígitos con el teclado numérico. Si esa referencia
  ya se usó hoy o ayer, avisa **«Esta referencia ya se registró a las 10:32»**.
- **Vuelto venezolano**:
  1. **en otra moneda** («te doy el vuelto en Bs», pendiente del HANDOFF 20, exige movimiento entre cajas);
  2. **«se lo quedo debiendo»**, que crea un saldo a favor del cliente;
  3. **redondeo por falta de sencillo**, a favor del cliente, visible en el cierre como «redondeos».

  Exige ADR, porque toca dinero (ver §7).
- **Fiar** es un interruptor visible, «¿Fiado?», no un botón escondido abajo.

**Fiscal**: recibe el aviso de referencia repetida. El vuelto en otra moneda sirve a los dos. El
resto, sin cambios.

### 4.6 Venta lista y el recibo

**Hoy.** Pantalla «¡Venta lista!» con «Imprimir» y «Nueva venta». El PDF del recibo lleva título,
logo, nombre, cliente, líneas, total y el pie «Documento no fiscal».

**Cambia en Personal.**
- **«Mandar por WhatsApp»** como botón principal:
  - comparte el **recibo como imagen**, legible en el chat, más un PDF opcional, con
    `navigator.share` y archivo;
  - si el dispositivo no puede compartir archivos, **abre WhatsApp con un texto** («Recibo R-12 ·
    Bs 320,03 · Gracias por tu compra»);
  - si la venta fue fiada, el mensaje incluye **el saldo del cliente**. Resuelve D7.
- **Recibo en ticket de 58/80 mm** para impresora térmica, además de la hoja carta.
- **Contenido del recibo**:
  - **Agrega**: formas de pago, vuelto, saldo pendiente si fue fiado, WhatsApp del negocio y datos
    de pago móvil opcionales.
  - **Quita**: la cita «art. 13.14 PA 00071» (D15).
  - **Conserva**: el pie «Documento no fiscal — no es una factura».
- **«Anular este recibo»** con motivo, que **repone la mercancía**. Ver 4.7.

**Fiscal**: la factura no cambia. Se evaluará si la imagen para WhatsApp sirve también para la
factura, sin tocar su PDF fiscal.

### 4.7 Corregir un recibo (nuevo, resuelve D4 y D5)

- **Hoy**: imposible desde la pantalla. Por API solo se anula el fiado, y sin reponer la mercancía.
- **Muestra** en el detalle del recibo:
  - **«Anular»**, con motivo obligatorio. **Repone el inventario**, revierte el asiento, deja el
    recibo visible como «ANULADO» y **no reutiliza el número**.
  - **«Devolver productos»**, parcial: se eligen líneas y cantidades. Crea un **recibo de
    devolución** (serie propia, en negativo, ligado al original), repone el inventario y devuelve
    el dinero por una forma de pago o como saldo a favor del cliente.
- **Regla**: nada se borra. Las dos acciones quedan en el historial del recibo y en la auditoría.
- **Fiscal**: la factura sigue corrigiéndose con nota de crédito o débito (regla 1 de CLAUDE.md).
  Este flujo es **solo para recibos**. Es un ADR nuevo, de rigor máximo (§7).

### 4.8 Productos (`pages/negocio/Productos.tsx` y `pages/catalogo/Productos.tsx`)

**Hoy.**
- Negocio: cuadrícula con foto, precio dual y existencia; búsqueda y cámara.
- Administración: pide **SKU obligatorio** y **clasificación tributaria obligatoria**, con
  «VALIDAR-TRIBUTARIO» en pantalla.

**Muestra en Personal** un alta de producto de una sola pantalla con cinco campos:
- nombre;
- precio en **$ o Bs**, a elección;
- «¿Se vende por kilo o por unidad?»;
- foto opcional;
- código de barras opcional, con la cámara.

**Cambia.**
- El código interno se **genera solo**.
- La clasificación tributaria queda **fija en «no fiscal» y oculta**.
- **«Cuánto me cuesta»** es opcional, con el aviso «para saber cuánto ganas».
- **Aviso de reposición**: «Con la tasa de hoy, este precio ya no cubre lo que te cuesta
  reponerlo». Se calcula en el servidor con el costo y la tasa.
- **Carga sin teclear**: desde Excel, que ya existe como importación, y en P2 desde una foto de la
  lista de precios.

**Esconde**: SKU, unidad técnica, clasificación tributaria, listas de precios y vigencias.

**Fiscal**: sin cambios. Con factura, la clasificación sigue siendo obligatoria.

### 4.9 Inventario (`pages/negocio/Inventario.tsx` y `/admin/inventario`)

**Hoy.**
- Negocio: vista simple.
- Administración: almacén, kardex, lote, costo promedio, «delta con signo», recetas y
  transferencias.

**Muestra en Personal.** **«Llevar la cuenta de lo que tengo»** es un **interruptor por producto**
(patrón Kyte), apagado por defecto en el tipo «vendedor ambulante». Encendido enseña:
- existencia actual;
- «Llegó mercancía», que es la entrada, con su costo;
- «Se dañó o se perdió», que es la merma con motivo;
- «Se está acabando», con un mínimo opcional.

**Cambia.** Con el interruptor apagado, la venta no descuenta ni bloquea por existencia. Encendido,
funciona como hoy: el kardex manda y no deja vender lo que no hay.

**Esconde**: lotes, recetas, transferencias entre depósitos, costo promedio, «kardex» y «delta».
Todo sigue existiendo por debajo.

**Fiscal**: sin cambios.

> **VALIDAR-CONTABLE**: un producto sin inventario llevado es, contablemente, un servicio. El
> interruptor no puede apagarse con existencia registrada sin un ajuste explícito.

### 4.10 Clientes y el libro de fiados (`pages/negocio/Clientes.tsx`, rediseñado)

**Hoy.**
- Lista de clientes con RIF.
- La deuda solo se ve en Administración → Clientes, como «Facturas pendientes».
- Cobro con `CobrarDocumento`.
- Botón manual «Mandar estado de cuenta por WhatsApp», que dice «Factura» aunque sea recibo (D14).
- No hay recordatorios, fecha de pago ni tope.

**Muestra en Personal** una pantalla **«Me deben»** con el diseño del cuaderno:

- **Arriba**, dos totales: **«Te deben»** en verde y **«Debes»** en rojo, que son las compras fiadas.
- **Lista de clientes** ordenada por lo que deben, con el saldo grande y el color, y el tiempo
  («hace 12 días»).
- **Ficha del cliente**:
  - **Saldo grande**: «Te debe $12,50 · Bs 1.568», a la tasa de hoy.
  - **Historial tipo chat**: cada venta fiada, cada abono y cada anulación, con fecha.
  - **Dos botones fijos abajo**:
    - **«Le fié»**, en rojo: una venta fiada por monto libre o con productos;
    - **«Me pagó»**, en verde: un abono, con la forma de pago y en cualquier moneda.
  - **«Recordarle»**, que abre WhatsApp con un mensaje cortés y editable: saldo en $ y Bs a la tasa
    del día, fecha de la última compra y datos de pago móvil del negocio.
  - **«Para cuándo»**: fecha prometida opcional. Ese día aparece en Inicio como «A quién cobrarle hoy».
  - **Tope de fiado** opcional: al pasarlo avisa, no bloquea.
  - **«Estado de cuenta»** como imagen o PDF para mandar.

**Cambia.**
- **El abono se aplica solo a lo más viejo.** Quien usa la app nunca elige «qué documento cobra».
- **La deuda queda en la moneda de la venta** (ADR-0047) y el abono se convierte a la tasa del día,
  con la tasa guardada. Es el hueco que nadie cubre en Venezuela.
- **Crear cliente pide nombre y teléfono.** La cédula es opcional y el RIF no aparece.

**Esconde**: RIF, tipo de persona, clasificación fiscal, «aging», «cuentas por cobrar», bloqueo de
cobranzas y lista de precios preferida.

**Fiscal**: conserva su pantalla actual de Administración → Clientes. La corrección del texto del
WhatsApp (D14) la recibe también.

> **Decisión técnica**: el libro NO es una tabla nueva de «movimientos del cliente». Se calcula de
> documentos y pagos, como hoy, para no crear una segunda verdad del saldo.
> - **«Le fié» por monto** es un recibo con la línea libre de D2 y sin pago.
> - **«Me pagó»** es un cobro aplicado FIFO.
>
> Así el invariante de cobertura contable y el aging siguen valiendo.

### 4.11 Compras y gastos (`pages/negocio/Compras.tsx`)

**Hoy.**
- La compra simple da **422** por la clasificación tributaria de la empresa (D6), y además exige el
  número de control del proveedor.
- Los gastos funcionan.

**Muestra en Personal.**
- **«Salió dinero»**: monto, **categoría con icono** (mercancía, transporte, comida, servicios,
  alquiler, personal, otro), forma de pago y nota. Es el gasto de hoy con otra cara.
- **«Compré mercancía»**: proveedor opcional (solo nombre), productos y cantidades, total pagado, y
  «¿Lo pagué o lo debo?». Si hay productos con inventario, suma existencia y actualiza el costo.
- **«Debo»**: lo comprado fiado, con el mismo diseño del libro de fiados en rojo y el botón «Le pagué».

**Cambia.**
- Con recibos, la compra simple **no exige clasificación ni número de control**: el IVA pagado va
  **al costo**.
- **«Gasto personal»**: un interruptor que marca el gasto como retiro del dueño. Separa el dinero del
  negocio del personal, otro hueco del mercado.

**Esconde**: órdenes de compra, recepciones, «matching de tres vías», retenciones, número de
control, contribuyente, IVA y costos de importación.

**Fiscal**: sin cambios. La factura de proveedor con crédito fiscal sigue exigiendo todo.

> **VALIDAR-TRIBUTARIO**: el IVA de compra como costo en quien no declara.

### 4.12 Mi dinero (`pages/negocio/Dinero.tsx`)

**Hoy.**
- Tasa del día con «Traer del BCV» o «Cambió».
- Lo que me deben y lo que debo.
- Cuentas, con alta.
- Cierre de caja (arqueo).

**Muestra en Personal.**

**La tasa**, arriba y grande:
- «Tasa de hoy: Bs 125,50 · BCV».
- Opción **«Uso mi propia tasa»**. Es la tasa por empresa de ADR-0057, **siempre con su fuente
  escrita** («tasa del negocio»).
- Cada venta sigue guardando la tasa con que se cobró.

**Dónde está mi plata**:
- efectivo en $, efectivo en Bs, «mi pago móvil / mi banco», Zelle;
- creados solos en el registro y editables;
- los nombres son de persona: «Mi pago móvil del Venezuela», no «Cuenta 1102».

**Cuadre del día**:
- **Esperado por cuenta y moneda** (lo vendido y cobrado, menos gastos y vueltos);
- **Contado**, lo que la persona escribe;
- **Diferencia**, visible y con nota, que **no bloquea**;
- las referencias de pago móvil del día con su total, para compararlas con el banco;
- **«Mandar cuadre por WhatsApp»**.

**Esconde**: nombres contables de cuentas y el sobrante o faltante como asiento. El asiento sigue
existiendo por debajo.

**Fiscal**: sin cambios. El cuadre por moneda con la lista de referencias sirve a ambos.

### 4.13 Reportes (`/admin/reportes`)

**Hoy**: diferencial cambiario con el identificador `exchange_gain_loss` a la vista, más enlaces a
libros fiscales y aging sin filtrar.

**Muestra en Personal.** Una pantalla **«Mis números»** con períodos Hoy, Semana, Mes o elegir:
- vendido, cobrado, gastado y ganado;
- más vendidos;
- ventas por forma de pago;
- quién me debe más;
- cuánto perdí por la tasa. El diferencial ya se calcula; aquí se explica en una frase.

Todo exportable a Excel y PDF.

**Esconde**: libros, aging, estado de resultados formal y diferencial con nombre técnico.

**Fiscal**: sin cambios; conserva sus reportes. La corrección de `exchange_gain_loss` (D10) sirve a ambos.

### 4.14 Lo fiscal y contable: se esconde y además se bloquea (resuelve D8, D9, D12 y D13)

| Pantalla o acción | Hoy, sin RIF | En Personal |
|---|---|---|
| **Administración → Ventas** | Filtro en «factura»: la lista sale vacía; «receipt» crudo | Se sustituye por **«Mis ventas»**: lista de recibos con su estado (pagado, fiado, anulado), buscar y compartir. `KIND_LABEL` incluye «Recibo» |
| **Nueva factura** | Deja emitir y responde el código crudo `REGIME_KIND_NOT_ALLOWED` | **No aparece.** Por API sigue el 409 del régimen, ahora con mensaje humano y botón «Ya tengo RIF» |
| **Cotización y pedido** | Calculan IVA siempre (D13) | En recibos, **sin IVA**, igual que la caja. P2: «apartado o encargo» con fecha |
| **Cuentas por cobrar** | Visible, con jerga | **No aparece**: lo reemplaza «Me deben» (4.10) |
| **Listas de precios** | Visible, con SKU y vigencias | **No aparece**: el precio vive en el producto. Por debajo, la lista predeterminada sigue existiendo |
| **Contabilidad** | Visible si hay módulo; cola con `sales.receipt.issued` crudo | **No aparece.** La contabilidad se lleva sola por debajo (ya lo hace). Un contador invitado sí la ve, por su rol |
| **Libros fiscales / Declarar IVA** | Vacíos sin explicación | **No aparecen** ni en menú ni en Ctrl+K. La API responde 409 con mensaje humano |
| **IGTF** | Se puede marcar «especial» y activar (D8) | **No aparece.** La API **exige régimen que emite** para activar IGTF y marcar «especial» |
| **Facturación fiscal (rangos, contingencia)** | Pasos «Pendiente» para siempre; se pueden cargar rangos | **No aparece.** La API exige régimen que emite para cargar rangos |
| **Buscador Ctrl+K** | Filtra solo por permiso (D9) | Filtra por permiso, módulo **y modo de venta**, igual que el menú |
| **Configuración → Puesta a punto fiscal** | Siempre visible | Solo el bloque «¿Ya tienes RIF?» |

**Fiscal**: ninguna de estas pantallas cambia para quien factura. Los bloqueos nuevos en la API
(IGTF y rangos exigen régimen que emite) **no afectan** a una empresa que factura, porque ya tiene
régimen. **VALIDAR con el asesor** que ningún caso legítimo quede fuera, por ejemplo una empresa
en transición.

### 4.15 Configuración y Mi empresa

- **Muestra en Personal**:
  - datos del negocio: nombre, tipo, WhatsApp, logo y datos de pago móvil para el recibo;
  - «Ayudantes» (4.16);
  - apariencia;
  - **«Descargar todos mis datos»**: ventas, fiados, productos y gastos en Excel. Visible y siempre disponible;
  - **«¿Ya tienes RIF?»**.
- **Esconde**: depósitos (hay uno solo), régimen, puesta a punto fiscal y el interruptor
  «Permitir ventas sin identificar» (en recibos no aplica, ver D11).
- **Fiscal**: sin cambios. Recibe también la exportación de datos.

### 4.16 Ayudantes (roles, ADR-0048)

- **Hoy**: oficios completos (cajero, encargado, administrativo, contador…) con 70+ permisos.
- **Muestra en Personal** dos perfiles, con nombres de persona:
  - **«Ayudante que vende»**: vende, fía hasta el tope, cobra fiados y **no ve la ganancia** ni
    anula ni borra (patrón Kyte y Yape).
  - **«Socio»**: todo, menos invitar gente.
- **Cambia**: cada ayudante tiene **su propio cuadre** (el pendiente «una caja por persona» que
  nadie resuelve en móvil). La caja ya soporta varias cuentas abiertas; falta el cierre por persona.
- **Fiscal**: sin cambios. Los oficios actuales siguen. Los perfiles de Personal son combinaciones
  de permisos existentes, no permisos nuevos.

### 4.17 La app instalable y el trabajo sin conexión

- **Hoy**: app instalable (PWA y APK) y cámara continua. **Sin conexión no se vende**: el service
  worker no guarda datos a propósito.
- **Cambia en Personal (P1)**: **cola de ventas pendientes**.
  - Sin señal, la caja deja cobrar **al contado** con los precios y existencias de la última
    sincronización.
  - Cada venta se guarda en el teléfono con su clave de idempotencia y se envía sola al volver la señal.
  - **Indicador honesto**: «3 ventas sin subir».
  - No deja cerrar sesión con ventas pendientes (patrón Loyverse).
- **Reglas duras** (regla 4 de CLAUDE.md y ADR nuevo):
  - **Sin conexión no se fía, no se anula y no se devuelve.** Solo ventas al contado.
  - El número de recibo lo asigna el servidor al subir. Mientras tanto se muestra «Recibo pendiente».
  - Si al subir falta existencia, la venta **queda registrada igual** con aviso de «vendiste sin
    existencia», porque el dinero ya se cobró. **VALIDAR-OPERACIÓN**: decidirlo con el dueño.
- **Fiscal**: **no se habilita**. Una factura sin conexión pasa por la contingencia fiscal ya
  existente (PA 102), que no se mezcla con esto.

---

## 5. Features nuevas, priorizadas

**P0: sin esto no es Ladino Personal**

| # | Feature | Resuelve | Toca dinero, stock o fiscal | ¿ADR o migración? |
|---|---|---|---|---|
| P0-1 | `modo_de_venta` único + `sales_mode` en la API | §2 | No | Migración (función) + ADR corto |
| P0-2 | Inicio que cuenta recibos + tarjeta del día + más vendidos | D1 | Lectura | No |
| P0-3 | Venta por monto libre («Varios») | D2 | Dinero | **ADR** (línea sin producto o producto de sistema «Venta libre») |
| P0-4 | Cantidad decimal y venta por monto en granel; precio editable en la línea | D3 | Dinero y stock | No (la API ya acepta decimales; el precio editable exige permiso y auditoría) |
| P0-5 | Recibo por WhatsApp (imagen/PDF/texto) + ticket térmico | D7, D15 | No | No |
| P0-6 | Libro de fiados «Me deben» con «Le fié», «Me pagó», «Recordarle», «Para cuándo» y tope | Hueco #1 | Dinero | Migración menor (fecha prometida y tope por cliente) |
| P0-7 | Anular y devolver un recibo, reponiendo inventario | D4, D5 | Dinero y stock | **ADR** + migración |
| P0-8 | «Salió dinero» con categorías + compra simple sin clasificación en recibos | D6 | Dinero y stock | **ADR** (IVA al costo) · VALIDAR-TRIBUTARIO |
| P0-9 | Esconder y bloquear lo fiscal (menú, Ctrl+K, API de IGTF y rangos) + jerga | D8–D14 | Fiscal (bloqueo) | No (reglas en API) |
| P0-10 | Cliente solo al fiar; alta con nombre y teléfono | D11 | No | No |

**P1: lo que lo hace mejor que la competencia**

| # | Feature | Evidencia |
|---|---|---|
| P1-1 | Cola de ventas sin conexión (4.17) | IUNCI, Traigalo, Loyverse; Clarito y Fina no la tienen · **ADR** |
| P1-2 | Referencia de pago móvil con aviso de repetida + lista en el cuadre | Hueco venezolano #3 |
| P1-3 | Vuelto en otra moneda, «se lo quedo debiendo», redondeo | Hueco #4; pendiente del HANDOFF 20 · **ADR** |
| P1-4 | Cuadre del día por persona y moneda, compartible | Fina (una sola caja), VE-Commerce (web) |
| P1-5 | Tasa propia del negocio en la pantalla, siempre con fuente | Hueco #1 de Venezuela (Loyverse, 65 votos) |
| P1-6 | Aviso «este precio ya no cubre reponer» | Hueco #7 de Venezuela; tesis de Fina sin documentar |
| P1-7 | Ayudantes «que vende» y «socio» | Kyte, Yape, Treinta |
| P1-8 | «Mis números» + exportar todos mis datos | Kippa, Treinta (antipatrón) |
| P1-9 | Inventario como interruptor por producto | Kyte |
| P1-10 | Tipo de negocio en el registro con categorías y ejemplos | Kyte, BukuWarung, Clarito |

**P2: después, si el uso lo pide**

- Catálogo público por enlace con pedido por WhatsApp (Clarito, Kyte, Treinta).
- Apartados o encargos con fecha y reserva de existencia (pedido de reseña de Treinta).
- Bulto y unidad del mismo producto (Treinta, BodegApp).
- Carga de productos desde una foto de la lista con IA (Fina, Kyte).
- Voz: «dos harinas y un refresco» (IUNCI), siempre con confirmación.
- PIN o huella para abrir la app en un teléfono compartido (Khatabook 2026).
- Página donde el cliente ve su deuda sin instalar nada (Crediado, DonFiado).

**Lo que NO se hace** (antipatrones documentados):
- funciones nuevas en la pantalla de venta que la hagan más lenta;
- pedir datos fiscales a quien no tiene RIF;
- secuestrar datos;
- prometer que funciona sin conexión más allá de lo que el ADR permita;
- vocabulario contable;
- borrar en silencio.

---

## 6. Qué NO cambia en Ladino Fiscal (garantías verificables)

1. **El trigger `assert_document_issuance`, la numeración, los rangos, los libros, las
   declaraciones, el IGTF y las retenciones no se tocan** en su lógica.
2. **Cada pantalla nueva o escondida depende de `sales_mode = recibos`.** Con `facturas`, el menú,
   el Ctrl+K y las pantallas son los de hoy.
3. **Los arreglos compartidos corrigen defectos que también existían para Fiscal y no cambian sus
   cifras**:
   - resumen que cuenta todos los documentos (Fiscal no tiene recibos);
   - `KIND_LABEL`;
   - texto del WhatsApp de cobro;
   - identificador técnico en Reportes;
   - aviso de referencia de pago móvil repetida;
   - exportar datos.
4. **Los bloqueos nuevos en la API** (IGTF y rangos exigen régimen que emite) no alcanzan a una
   empresa que factura.
5. **Pasar de Personal a Fiscal** («Ya tengo RIF») es el flujo actual de régimen. El historial de
   recibos queda en lectura y los fiados siguen vivos.
6. **Tests que lo prueban**:
   - E2E de Fiscal sin cambios en verde;
   - un E2E nuevo por cada pantalla de Personal;
   - pgTAP de `modo_de_venta` contra el trigger (misma respuesta para cada régimen);
   - `accounting_coverage_gaps`, `stock_reconciliation` y `treasury_reconciliation` en **cero**
     tras anular y devolver recibos;
   - el gate del glosario extendido a las pantallas de Personal, con IVA, IGTF, RIF, SENIAT,
     alícuota, lote y códigos 4xx.

---

## 7. Decisiones estructurales que necesitan aprobación explícita

| ADR | Decisión | Rigor | Por qué |
|---|---|---|---|
| ADR-0060 | **Modo de venta único** (`modo_de_venta`, `sales_mode`) | Normal | Elimina seis fórmulas; base del resto |
| ADR-0061 | **Venta libre en recibos**: línea sin producto o producto de sistema «Venta libre» | Máximo | Toca el contrato de líneas y la valoración (sin costo) |
| ADR-0062 | **Corregir un recibo**: anulación con reposición y recibo de devolución | Máximo | Dinero, stock y asientos; ADR-0051 §4 lo dejó fuera |
| ADR-0063 | **Compra simple sin clasificación en recibos**: IVA al costo | Máximo | VALIDAR-TRIBUTARIO |
| ADR-0064 | **Cola de ventas sin conexión** | Máximo | Idempotencia, precios y existencias viejos, conflicto al subir |
| ADR-0065 | **Vuelto venezolano**: en otra moneda, saldo a favor, redondeo | Máximo | Movimiento entre cajas y asiento de redondeo (VALIDAR-CONTABLE) |
| — | **Costo de ventas** (D16) | Máximo | Afecta a Fiscal. **Se trata aparte**, fuera de este plan, con el contador |

Nota: los números de ADR del `PLAN_DOS_PLANES.md` (0059) y su migración 53 ya los usó la caja; este plan corre la numeración.

---

## 8. Orden de trabajo

| Lote | Qué | Rigor | Migración | Sesiones |
|---|---|---|---|---|
| **L1** | P0-1 modo único + P0-2 Inicio + P0-9 esconder/bloquear + P0-10 cliente al fiar + jerga (D9–D14) | Normal (bloqueo de API: revisión fiscal) | Sí (función) | 1–2 |
| **L2** | P0-5 recibo por WhatsApp + P0-4 granel y precio editable | Normal / dinero | No | 1 |
| **L3** | P0-3 venta libre (ADR-0061) + P0-6 libro de fiados | Máximo | Sí | 2 |
| **L4** | P0-7 anular y devolver recibo (ADR-0062) + P0-8 gastos y compra simple (ADR-0063) | Máximo | Sí | 2 |
| **L5** | P1-2 referencia repetida + P1-4 cuadre por persona + P1-5 tasa propia + P1-6 aviso de reposición + P1-7 ayudantes | Normal / dinero | Menor | 2 |
| **L6** | P1-1 cola sin conexión (ADR-0064) | Máximo | Sí | 2–3 |
| **L7** | P1-3 vuelto venezolano (ADR-0065) | Máximo | Sí | 1–2 |
| **L8** | P1-8 mis números y exportar + P1-9 inventario interruptor + P1-10 tipo de negocio | Normal | Menor | 1–2 |

**Reglas para cada lote.**
- `pnpm run verify` en verde, commit y push.
- QA por la pantalla contra la base: invariantes en cero y E2E de Fiscal intactos.
- Revisión de código independiente al cerrar.
- L3, L4, L6 y L7 necesitan tu aprobación antes de empezar, por ADR y migración.

---

## 9. VALIDAR antes de producción

- **VALIDAR-LEGAL**: el texto del recibo no fiscal y el aviso a quien vende sin estar inscrito (R-27).
- **VALIDAR-TRIBUTARIO**: el IVA de compra como costo en recibos (ADR-0063).
- **VALIDAR-CONTABLE**:
  - costo de ventas (D16);
  - redondeo y vuelto en otra moneda (ADR-0065);
  - producto sin inventario llevado (4.9).
- **VALIDAR-OPERACIÓN**:
  - venta sin conexión que al subir no tiene existencia (4.17);
  - tope de fiado que avisa y no bloquea.
- **VALIDAR con el asesor**: que exigir régimen que emite para IGTF y rangos no deje fuera un caso
  legítimo de transición.

---

## 10. Fuentes (67 sitios)

**Venezuela (24).**
- **Fina**: finapartner.com, sus páginas de funcionalidades, tiendas y tutoriales, y
  guias.finapartner.com (empezar, venta, crédito, cierre de caja, canales, estatus, preguntas
  frecuentes, inventario con IA, cuentas).
- **Cachicamo**: cachicamo.app y docs.cachicamo.app (formas de pago, pagos asíncronos, Venezuela, facturas).
- **Clarito**: clarito.app (precios, bodegas, dólares y bolívares, emprendedores).
- **IUNCI**: iunci.app (tres artículos de academia) y su ficha de Google Play.
- **Otros sitios de apps**: kontave.com; alegra.com/venezuela y la ayuda del POS en monedas;
  valery.com y su página de POS; valerysoftware.com.ve; pos.traigalo.com; ve-commerce.com;
  bodegapp.com.ve.
- **Fichas de Google Play**: Treinta, Loyverse, Kyte, Bodegas App y VendeYa para Venezuela.
- **Otras**: App Store de Treinta en Venezuela; comparasoftware.com.ve; YouTube de Fina Partner;
  blog.grupoapok.com, ecosistemastartup.com y blog.emprelatam.com.

**Latinoamérica (23).**
- **Treinta**: treinta.co (/comercios y blog), fichas de Play en Colombia y México, App Store de El Salvador.
- **Kyte**: appkyte.com (crédito, análisis) y docs.kyteapp.com, App Store de EE. UU., fichas de Play en Colombia y México.
- **Loyverse**: loyverse.com/es y help.loyverse.com (pagos, peso, ventas), fichas de Play en Colombia y Venezuela, Capterra.
- **Otras apps de gestión**: vendty.com; alegra.com/costarica/pos/abarrotes.
- **Pagos**: mercadopago.com.mx (dos artículos de 2026); blog.clip.mx (dos artículos); nequi.com.co; ualabis.com.ar; yape.com.pe.
- **Apps de fiado**: abona.mx; Google Play de Crediado, DonFiado y Fiado App.
- **Referencia**: panca.pe.

**Resto del mundo (más de 20).**
- **Fiado en India**:
  - Khatabook: khatabook.com, blog de funciones, caja registradora, Google Play y App Store.
  - OkCredit: okcredit.in, preguntas frecuentes, Google Play y App Store.
- **Fiado en otros países**: tallykhata.com y su Google Play; bukuwarung.com, su Google Play y TechCrunch (2020); BukuKas/Lummo (prensa sobre su cierre); Kippa en TechCabal (2024).
- **Facturación**: vyaparapp.in y mybillbook.in, con sus fichas de Google Play.
- **Caja y cobro**: loyverse.com y su soporte sin conexión; Square, ayuda 5429 y 7777; Google Play de SumUp; yoco.com y su soporte.
- **Otras apps**: Zoho Invoice (móvil); getbumpa.com; Moniebook de Moniepoint; dukasale.ke.
- **Voz**: VoiceKhata y BolKhata.

Los tres informes completos, con URLs, tablas y reseñas, están en la sesión
(`scratchpad/personal/*.md`).

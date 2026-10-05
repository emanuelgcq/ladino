# ADR-0081 — Lo que Ladino deja de prometer

- **Estado:** ADR aplicado según la respuesta del dueño del 2026-09-28 (§2.14). Hallazgos: B-01, E-06, P-06.
- **Fecha:** 2026-10-04.
- **Impacto fiscal:** NO. Ninguna regla tributaria, documento fiscal ni asiento cambia. La única fila de cumplimiento que se toca es descriptiva (`EMISION_FACTURAS.md` §4, «Entrega por medio digital»), y deja dicho que compartir la copia de cortesía no es la entrega fiscal de la factura.

## Contexto

El recorrido del 2026-09-24 encontró tres sitios donde el producto anunciaba algo que no hace:

- **B-01.** El asistente de `/empezar` decía dos veces «también se puede vender describiendo la venta», y un comentario del código lo daba por diseño. No se puede: toda línea de venta exige un producto en el esquema (`product_id` obligatorio y `.strict()`), en el dominio y en la base (`document_lines.product_id NOT NULL`). La persona saltaba el paso de productos, llegaba al mostrador con «¡Listo! Tu negocio ya puede vender» y no podía vender nada.
- **E-06.** `EMISION_FACTURAS.md` daba por construido «PDF por descarga y WhatsApp desde el POS». El botón de WhatsApp de «Venta lista» se había quitado a propósito en `8756c91`; la documentación de cumplimiento quedó en verde falso.
- **P-06.** La paleta (Ctrl+K) llevaba un pie fijo: «Asistente de Ladino — este espacio lo espera. Próximamente.» Una función que no existe, anunciada en la herramienta de todos los días. Y no encontraba lo que la gente le pide: un documento por su número («R-5», «A-2») ni una acción como «cierre».

La respuesta del dueño (§2.14) reparte lo no construido en dos listas: lo que **se construye** (entre otros, P-06: documentos por número y acciones en la paleta) y lo que **se deja de prometer** (B-01 y el asistente, que «van con el módulo de IA, que queda para el final»; E-06: «no se repone; se corrige `EMISION_FACTURAS.md` y queda "Descargar PDF" y "Compartir" del navegador, que no es WhatsApp»).

Restricciones: equipo de una persona; la venta «descrita» exigiría una línea sin producto en ventas, con su IVA, su kardex y su asiento (no es un texto, es un módulo); CLAUDE.md §2 («ausencia de mecanismo no es prohibición») vale también al revés: **un texto no es un mecanismo**. Lo que la pantalla dice tiene que poder hacerse hoy.

## Opciones consideradas

1. **Retirar la promesa y dejar constancia de a dónde va** (la elegida) — a favor: la pantalla vuelve a decir la verdad hoy, con un cambio pequeño y reversible; el backlog conserva la idea. En contra: el asistente de `/empezar` pierde su «salida rápida» y hay que decirle a la persona que sin un producto no vende.
2. **Construir la venta descrita ahora** — en contra: una línea sin producto en ventas toca el esquema, el IVA por línea, el kardex, la plantilla contable y los invariantes de cobertura; el dueño la dejó para el módulo de IA.
3. **Dejar los textos con un «próximamente»** — en contra: es exactamente el defecto de P-06; un anuncio permanente de algo sin fecha enseña a no creer lo que la pantalla dice.
4. **Reponer el botón de WhatsApp** — descartada por el dueño de forma expresa.

## Decisión

Una entrada por cada cosa que se retira: qué se quita, por qué, y dónde queda.

### 1. «Vender describiendo la venta» (B-01)

- **Qué se quita (texto):** las dos frases de `apps/web/src/pages/negocio/Empezar.tsx` (el paso «Tus productos» y la tarjeta final) y el comentario que lo daba por diseño; y la misma frase de `docs/08_UX/capturas-fase-c/RECORRIDO_PRIMER_DIA.md`.
- **Qué queda en su lugar:** el paso de productos se puede dejar para después y seguir con los otros tres. Con lo obligatorio listo y sin productos, la tarjeta final ya no dice «¡Listo! Tu negocio ya puede vender» ni manda al mostrador: dice «Ya casi: te falta un producto» y su botón lleva a cargarlos. Con productos, es la de siempre.
- **Decidido por criterio (§2.16, lo que promete la pantalla):** quitar solo la frase habría dejado el «¡Listo! … ya puede vender» delante de un mostrador vacío, que es la misma promesa con otras palabras. Alternativa descartada: volver obligatorio el paso de productos (cambia el flujo del asistente y bloquea configurar el resto mientras tanto).
- **Por qué:** no existe en ninguna de las tres capas.
- **Dónde queda:** backlog, con el **módulo de IA** (al final): dictar o describir una venta y que el sistema proponga las líneas. Exige decidir antes la línea de venta sin producto.

### 2. El «Asistente de Ladino» de Ctrl+K (P-06)

- **Qué se quita (texto y espacio):** el pie de la paleta con «Asistente de Ladino — este espacio lo espera. Próximamente.» y el comentario que reservaba el «slot». En su lugar, el pie dice las teclas: flechas, Enter y Esc.
- **Por qué:** una función que no existe no se anuncia. El espacio no hace falta reservarlo: cuando exista, se pone.
- **Dónde queda:** backlog, con el **módulo de IA** (al final).

### 3. El botón de WhatsApp de «Venta lista» (E-06)

- **Qué se quita:** nada del código (el botón ya no estaba desde `8756c91`). Se corrige la fila «Entrega por medio digital» de `docs/02_COMPLIANCE/EMISION_FACTURAS.md`, que lo daba por construido. **No se repone.**
- **Qué queda:** el PDF, que se abre y se descarga («PDF de cortesía» en la factura, «Imprimir» en el recibo; esos nombres son de entregas anteriores y no se tocan), y **«Compartir»**: la hoja de compartir NATIVA del navegador (`navigator.share`) con ese mismo PDF como archivo. La persona elige el destino; Ladino no nombra ni enlaza ninguna aplicación de mensajería. El botón solo se pinta donde el navegador comparte archivos (`navigator.canShare({ files })`); donde no, no hay botón muerto.
- **Dónde queda:** en ningún backlog. Es una decisión, no una deuda. (El estado de cuenta del cliente por WhatsApp, en la ficha del cliente, es otra función y no cambia.)

### 4. Lo que la paleta SÍ hace desde ahora (P-06, la parte que se construye)

La otra mitad de la misma respuesta, anotada aquí porque sustituye a lo que se retira:

- **Documentos por su número**: factura, recibo, nota de crédito, nota de débito, cotización y compra; y, desde ADR-0082, la factura de retiro y su nota de crédito, que comparten correlativo con la factura y la nota de crédito y abren en el mismo detalle de ventas. La búsqueda la hace el servidor: `GET /v1/search/documents?q=` (esquema `SearchDocumentsQuery` / `SearchDocumentsResponse`), acotada a la empresa de `X-Company-Id`.
- **Con permiso desde que nace.** Las ventas exigen UNO de `ar.read`, `accounting.read`, `sales.invoice.issue`, `sales.invoice.annul`, `sales.quote.manage`, `sales.order.manage`, `sales.return.manage` o `sales.payment.register` (la lista incluye los permisos con que el menú abre «Ventas»: quien entra a la pantalla encuentra en la paleta lo que la pantalla lista); las compras, la convención que ya usa `GET /v1/supplier-invoices`: `ap.read`, `purchase.invoice.register` o `purchase.payment.register`. El grupo que el rol no abre **ni se consulta**: no aparece ni se cuenta (la respuesta no lleva total), y quien no abre ninguno recibe la misma lista vacía que quien busca algo que no existe. El cajero no encuentra una compra; el almacenista, ni una venta ni una compra.
- **Qué casa:** en una venta, la serie y el número como se leen («A-12») o con ceros («A-00000012»), enteros o una parte, sin distinguir mayúsculas; en una compra, el número, el control o la referencia del proveedor. Lo exacto va primero; después, lo más reciente. Dos caracteres como mínimo. Un `%` de la persona es una letra, no un comodín. Sin importes.
- **Acciones**: «Nuevo cliente» y «Cerrar caja», que viven dentro de una pantalla y el menú no nombra. Cada una existe si el rol tiene el permiso del acto (`customer.manage`, `cash.close`: los mismos con que su pantalla enseña el botón) **y** abre la pantalla donde se hace, según el filtro del menú (`visible` de `shell.tsx`). No se escribe ninguna regla nueva de permisos en la web. «Llegó mercancía» ya es una entrada del menú (ADR-0066) y se encuentra como pantalla, también escrita sin tilde.
- **Teclado:** flechas, Enter y Escape; la fila elegida lleva fondo y borde y se mantiene a la vista.

Decidido por criterio (§2.16), con su alternativa:

- **Una cotización hoy no se encuentra por número**: nace como borrador sin número (`crearBorrador` en `packages/domain/src/sales.ts`; la del escenario no lo tiene). Si algún camino llega a numerarla, no verificado. El tipo está en la búsqueda para el día que lo tenga. Alternativa descartada: encontrarla por cliente o por fecha (ya no es «por su número», y es otra búsqueda).
- **Una compra lleva a la lista de facturas de proveedores**, no a un detalle: la factura de un proveedor no tiene pantalla propia. Alternativa: un parámetro que la resalte en la lista (queda en backlog; toca la pantalla de compras).
- **«Cerrar caja» abre el cierre si hay una sola caja**; con varias, deja a la persona en Mi dinero, donde cada caja tiene su botón. Alternativa descartada: elegir una por ella.
- **Un resultado que el rol no puede abrir no se enseña.** El servidor puede devolver una venta a un rol que no abre `/admin/ventas` (por ejemplo, uno a medida con solo `sales.invoice.issue`); la paleta no la pinta, porque rebotaría en la guardia de rutas. Alternativa: abrir el detalle a todo el que vende (es la lectura de documentos de ventas, que se cierra en la ola 6).
- **`purchase.receive` no abre las facturas de compra**, igual que en `GET /v1/supplier-invoices`. Alternativa descartada: cualquier permiso de compras (el almacenista las encontraría).

## Consecuencias

- **Positivas.** Las tres pantallas dicen lo que hacen. La documentación de cumplimiento deja de dar por construido un canal de entrega. La paleta encuentra lo que la gente le pedía, y lo hace por el servidor y con permiso.
- **Negativas y deuda que se acepta.**
  - Quien empieza sin productos ya no tiene una salida para «vender igual»: tiene que cargar al menos uno. Es más fricción el primer día, y es la verdad.
  - El asistente de IA y la venta descrita quedan sin fecha.
  - «Compartir» **no existe en todos los navegadores**: donde `navigator.canShare({ files })` no está o dice que no (varios navegadores de escritorio; cuáles, no verificado), no hay botón. Dos cajas del mismo negocio pueden ver pantallas distintas. Además el navegador exige que la hoja se abra a raíz de un toque: el PDF se baja primero y, con una red lenta, el navegador puede negarse; se avisa y queda el PDF. **No se probó en un navegador real** (R-87).
  - La búsqueda de documentos usa `ilike '%…%'` sobre la serie y el número compuestos: no usa índice. Va acotada por empresa, y con el volumen de hoy es una lectura corta; con cientos de miles de documentos por empresa hará falta un índice (trigramas o una columna generada), que es una migración.
  - La ruta nueva exige permiso y `GET /v1/documents` todavía no: hasta la ola 6, quien no encuentra un documento en la paleta puede seguir listándolo por la otra ruta. La paleta no abre nada que antes estuviera cerrado, pero tampoco cierra lo que ya estaba abierto.
  - La cotización no se encuentra (no tiene número) y la compra no abre su detalle (no lo hay).
- **Para revertirla.** Los textos se reponen con un `git revert`; no hay migración ni dato que deshacer. Reponer el botón de WhatsApp o construir la venta descrita son decisiones nuevas del dueño, con su propio ADR.

## Verificación

- `apps/api/test/e2e-buscar-documentos.test.ts` (7): número exacto, parcial y con ceros; la compra por número y por control; el cajero no encuentra la compra; el almacén, nada; otra empresa y el miembro de dos empresas; comodines; 422.
- `apps/web/test/paleta-acciones.test.ts` (13): acciones por permiso y por pantalla, destinos de los documentos, y que la paleta no diga «Próximamente» ni «Asistente».
- `apps/web/test/compartir.test.ts` (7): sin `canShare` de archivos no hay botón; cancelar la hoja no es un error.
- `pnpm recorrido P`, `B` y `E`: los casos P-06, B-01 y E-06.
- Revisión: cuando se abra el módulo de IA, este ADR es la lista de lo que se le debe (entradas 1 y 2).

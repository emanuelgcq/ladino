# ADR-0066 — La mercancía entra por una puerta

- **Estado**: aceptada (dueño, 2026-09-18: «PLAN APROBADO con las tres recomendaciones»).
- **Fecha**: 2026-09-18 · entregas (i), (ii) y (iii); migraciones 69, 70 y 71.
- **Módulos**: inventario · compras · contabilidad · libros fiscales · catálogo · navegación
- **Rigor**: máximo. Toca inventario valorado, dinero y contabilidad. Completa ADR-0034
  (inventario), ADR-0040 (compras), ADR-0060 (inventario en el mayor) y ADR-0042 (todo hecho
  produce asiento o cola). No deroga ninguno.
- **HOMOLOGATION_IMPACT**: **YES**. Aparece un documento de compra que **no entra al libro de
  compras** (la compra sin soporte fiscal) y el correlativo del proveedor deja de ser obligatorio.
  Las dos cosas cambian qué imprime un libro fiscal.

## Contexto

Hoy la mercancía entra a Ladino por **tres** puertas que hacen lo mismo con tres lenguajes y dos
monedas:

| Puerta | Cómo lo llama | Qué pide | Moneda por omisión | Contrapartida contable |
|---|---|---|---|---|
| Alta de producto | «stock inicial» | cuántos tienes y cuánto costó cada uno | USD | aportes en inventario |
| Registrar compra | «¿qué llegó?» | proveedor, **dos números de factura obligatorios**, precio sin IVA | Bolívares | cuentas por pagar |
| Entrada de existencias | «entrada de existencias» | producto, cantidad, costo | USD | aportes en inventario |

Ninguna sabe que las otras existen, y **nadie compara una entrada de inventario contra una
recepción de compra**. El resultado es que la persona elige la contrapartida contable eligiendo un
ítem de menú, en el momento en que menos preparada está para hacerlo, y **el error no se siente
como error**: la mercancía aparece en el depósito y la pantalla dice que todo salió bien.

Tres consecuencias medidas, no supuestas:

1. **La compra sin factura no cabe en la puerta que le corresponde.** Los dos números son
   obligatorios en la pantalla, así que el camino que queda es escribir `S/N` —y a la segunda
   compra del mismo proveedor el índice único responde «ya existe una factura con ese número»,
   un 409 que ahí no protege de nada— o registrarla como aporte, y entonces el dinero que salió de
   la caja no sale en ningún sitio.
2. **La moneda por omisión es distinta según la puerta.** Escribir «10.106,40» pensando en
   bolívares en la pantalla que abre en dólares registra un costo 842 veces mayor, y el movimiento
   no se edita.
3. **Ningún control lo ve.** `stock_reconciliation`, `inventory_ledger_gap` y
   `accounting_coverage_gaps` quedan en cero por cualquiera de los tres caminos, porque los tres
   asientan correctamente **en sus propios términos**. Es el patrón de ADR-0023 —ausencia de fallo
   leída como éxito— a escala de pantalla.

La investigación de ERP modernos (Odoo, ERPNext, Business Central, QuickBooks y Loyverse) confirmó
el patrón: **una puerta por hecho físico y un campo que elige la contabilidad**; el documento del
proveedor como referencia y no como llave; recibir y facturar como dos hechos con una cuenta
puente entre ellos. Ladino ya tiene las tres piezas construidas en el dominio. Lo que falta es la
puerta.

## Decisión

### Los principios

- **P1 · La mercancía entra por una sola pantalla: «Llegó mercancía».** No hay camino alternativo
  en el mundo de la persona. El alta de producto conserva su «inventario inicial» porque es el
  mismo caso de uso del dominio con la misma contrapartida, no un segundo camino, y un test lo
  aseveró: la puerta con «Ya era mía» y el alta producen movimientos idénticos.
- **P2 · La persona describe el hecho; el sistema deriva el asiento.** Nunca se le pide elegir una
  contrapartida contable, ni directamente ni eligiendo pantalla.
- **P3 · La primera pregunta es de quién vino**, no qué efecto tiene. «Me la trajo un proveedor» o
  «Ya era mía». El dinero se pregunta después, donde corresponde.
- **P4 · Inventario es destino, nunca origen.** Muestra qué hay, qué está por llegar, y permite
  corregir —conteo, merma, traslado—. No mete mercancía.
- **P5 · El dinero se captura una vez.** La conversión la hace el servidor, con la tasa del BCV de
  la fecha del hecho. Cero aritmética monetaria en el cliente (ADR-0064, `apps/web/CLAUDE.md`).
- **P6 · Lo que no se afloja.** El movimiento no se edita; toda entrada tiene asiento y
  contrapartida explícita; el costo lo fija la llegada a la tasa del día del hecho; los
  invariantes existentes siguen en cero por cualquier camino.

### 1 · La puerta y sus preguntas

`/admin/llego-mercancia`, en ADMINISTRACIÓN → OPERACIÓN, junto a «Compras y gastos» — que es donde
ya viven los verbos del negocio (`/compras` y `/dinero` cuelgan de ahí). Una pregunta por
pantalla:

| Paso | Pregunta | Cuándo aparece |
|---|---|---|
| 0 | «¿Viene de uno de estos pedidos?» | Solo si hay pedidos sin recibir del todo *(entrega iii)* |
| 1 | «¿De quién vino?» → *Me la trajo un proveedor* / *Ya era mía* | Siempre |
| 2 | «¿Qué llegó?» — producto, cantidad, importe, fecha, lote y vencimiento si el producto los lleva | Siempre |
| 3 | «¿Tienes la factura?» → *Sí, aquí está* / *Todavía no me la dan* / *No va a haber factura* | Solo camino compra |
| 4 | «¿Ya la pagaste?» → con qué cuenta, o quedo debiendo | Solo camino compra, y solo con permiso de tesorería |
| 5 | «¿A qué depósito?» | Solo si hay más de uno |

La confirmación dice la consecuencia completa en lenguaje de persona, distinta por camino, antes
de escribir nada.

**La llegada es un solo caso de uso transaccional.** La pantalla no encadena tres llamadas: si lo
hiciera, una caída a mitad dejaría mercancía dentro y factura fuera. El endpoint nuevo es hermano
de `simplePurchase` y compone las piezas que ya existen dentro de una transacción, con su clave de
idempotencia **generada al entrar a la puerta**, no al confirmar: un doble clic o un reintento
devuelve la misma llegada, no dos.

### 2 · Las cuatro salidas contables

| Salida | Qué la ejecuta | Plantilla | Contrapartida |
|---|---|---|---|
| **Compra con factura** | recepción + factura (+ pago) | `goods_receipt` · `purchase_invoice` · `purchase_revaluation` si difiere | Mercancía recibida por facturar → cuentas por pagar (neto) + IVA + retenciones |
| **Recepción por facturar** | solo la recepción | `goods_receipt` | Mercancía recibida por facturar, hasta que llegue la factura |
| **Compra sin soporte fiscal** | recepción + factura **marcada** | `purchase_invoice`, rama `if_tax_not_recoverable` | Cuentas por pagar o caja, todo al costo |
| **Aporte / inventario inicial** | `receiveStock` origen `stock_opening` | `stock_opening` | Aportes en inventario |

**La compra sin soporte no necesita plantilla nueva, y eso es deliberado.** Un documento sin IVA
discriminado nace con `tax_amount = 0` y `tax_is_recoverable = false`, y la rama que ya existe
—todo al costo contra cuentas por pagar— lo asienta correctamente. Lo que hace falta es **marcarlo
y sacarlo del libro**:

- una marca en la factura (`fiscal_support`), que nace en `true` para todo lo ya cargado;
- el correlativo del proveedor pasa a opcional, con **índice único solo cuando existe**;
- el `CHECK` que hoy exige número de control o referencia de documento origen **no se borra: se
  condiciona a `fiscal_support = true`**, que es exactamente el motivo con el que se escribió
  («una factura de compra sin ninguna identificación del emisor no es asentable en el libro»);
- `purchases_book` la filtra explícitamente — hoy selecciona por estado, así que sin filtro
  aparecería en el libro con base gravada y cero IVA;
- la declaración la ignora por construcción: suma el IVA de las recuperables.

### 3 · Todo movimiento de entrada declara su origen

| Llamador | Origen | Qué representa |
|---|---|---|
| `packages/domain/src/products.ts:572` | `stock_opening` | Inventario inicial del alta de producto |
| `packages/domain/src/purchases.ts:584` | `document` | Recepción de compra (el documento asienta una vez) |
| `packages/domain/src/sales.ts:3149` | `document` | Devolución de cliente y reposición de venta anulada |
| `apps/api/src/routes/inventory.ts:184` | **`origin` obligatorio** | La entrada suelta, ahora solo `aporte` |

La ruta suelta **no se cierra**: exige `origin` explícito y el permiso `inventory.move`, y sin él
responde 422 remitiendo a la puerta. Cerrarla con un 4xx habría obligado a reescribir la siembra
de diez ficheros E2E y habría roto la web desplegada durante la ventana de deploy, sin ganar nada:
lo que la regla de la casa exige es que **nada entre sin declarar su origen y su contrapartida**, y
eso lo cumple igual. La puerta única es única **para la persona**; la API es la API.

`origin` tiene **un solo valor** para ese camino (`aporte`, que el dominio mapea a
`stock_opening`). Dos valores sinónimos serían una invitación a colgarles contabilidades distintas
dentro de seis meses.

### 4 · Qué ve cada rol

El ítem se muestra a quien tenga **cualquiera** de `inventory.move`, `purchase.receive` o
`purchase.invoice.register`, sin marca `fiscal` (una empresa sin RIF también recibe mercancía) y
sin `advanced` (no depende de que el módulo de compras esté activo). Y **cada camino pide el
suyo**:

| Camino | Permiso |
|---|---|
| Aporte / inventario inicial | `inventory.move` |
| Recepción | `purchase.receive` **y** `inventory.move` — recibir es mover existencia, y el kardex lo exige igual que a cualquier otro movimiento |
| Registrar la factura | `purchase.invoice.register` |
| Pagar en el acto | el de tesorería |

Quien solo puede recibir, **no ve dinero**: el flujo salta del paso 2 al 5 y la factura y el pago
quedan pendientes en «Falta la factura». La recepción a ciegas —contar sin ver precios— es un
control clásico contra el fraude de compras, y aquí sale gratis porque los permisos ya están
separados.

### 5 · La fecha de la llegada está acotada, y el costo intermedio no se corrige

La fecha por omisión es hoy. Se puede retroceder **hasta 2 días**, nunca antes del inicio del
período contable abierto, y —cuando la llegada se paga en el acto— nunca antes del último cierre de
la **cuenta** con la que se paga (`cash_closings` es por cuenta de tesorería; no existe un cierre
«del depósito»). Más viejo que eso no es una llegada: es un ajuste con motivo, que tiene su
pantalla, su cuenta y su rastro.

**Por qué acotarla y no permitirla libremente.** El costo promedio se calcula **en el orden en que
se insertan los movimientos**, contra el saldo vigente de la posición. Una llegada fechada hacia
atrás entra con el saldo de hoy y **no recalcula el costo de lo que se vendió entre medias**. Ese
costo de ventas queda mal para siempre: los movimientos son append-only y no hay corrección
posible. Y —esto es lo que obliga a decidirlo aquí— **ningún invariante lo ve**: `recompute_stock`
es una suma (`sum(quantity)`, `sum(functional_amount)`), `stock_reconciliation` compara sumas,
`inventory_ledger_gap` compara valor contra mayor. Todos miden **totales**; este defecto es de
**orden**. Se acota, se hace visible —el servidor devuelve las ventas intermedias y la pantalla las
muestra antes de confirmar— y **no se corrige**.

Recalcular el kardex hacia atrás queda descartado explícitamente: reescribiría costos de
movimientos ya asentados, contra el append-only y contra asientos posteados.

### 6 · Lo que NO entra por la puerta

- **La devolución de un cliente entra por su venta.** Ya lo hace (`sales.ts:3149`, origen
  `document`, `source_kind` `sales_return`): la mercancía vuelve al costo con el que salió y el
  costo de ventas se revierte. Queda escrito para que nadie lo «consolide» dentro de seis meses.
- **La consignación** —el distribuidor que deja mercancía y cobra cuando se vende— no está
  modelada y no se construye ahora. Si algún día existe, es **una tercera respuesta del paso 1**,
  no una puerta nueva.
- **La devolución al proveedor es la puerta al revés.** La nota de crédito recibida ya se asienta,
  entra al libro en negativo y resta el crédito fiscal (migración 67, ADR-0065 §1); lo que falta es
  su pantalla en el mundo de la persona, y es trabajo posterior.
- **El flete y demás gastos de la llegada** van en la entrega (ii): pregunta opcional tras el pago
  que aplica `landed_cost`, que ya existe con su plantilla. Fuera de (i) a propósito.

### 7 · Lo que se elimina

- **«Entrada de existencias»** desaparece de Administración → Inventario. No se renombra: se
  elimina, y solo cuando la puerta esté viva.
- **El diálogo «Registrar compra» de un paso** deja de existir: el botón de «Compras y gastos»
  lleva a la misma ruta que el ítem de menú. La pantalla de Compras y gastos **conserva todo lo
  demás**: gastos, historial de compras, lo que debo y el pago de facturas.
- **`unit_cost` sale del contrato del ajuste.** Un ajuste positivo se valora al promedio vigente y
  no lleva campo de dinero: si lo llevara, «conteo» sería la misma puerta que se acaba de cerrar,
  con otro nombre.
- Administración → Inventario pasa a llamarse en pantalla **«Conteo, ajustes y traslados»**.

### 8 · Los controles nuevos

Familia de `accounting_coverage_gaps`, con la misma regla: la respuesta correcta es **cero, sin
lista de perdones**.

1. **Doble registro** — dos entradas del mismo producto, depósito, cantidad y día por caminos
   distintos, incluidos los ajustes positivos. Aviso, no bloqueo *(entrega iii)*.
2. **Recepciones sin factura de más de 30 días** — la cuenta puente no puede crecer sin que nadie
   la mire *(entrega i)*.
3. **Llegadas fechadas hacia atrás con ventas intermedias** — **reporte, no invariante**, y el
   ADR lo dice para que nadie lo «ascienda» luego: las sumas no ven el orden *(entrega iii)*.

## Consecuencias

**A favor.** Una sola puerta para la persona; la contabilidad deja de elegirse desde el menú; la
compra sin factura deja de empujar a inventar un documento fiscal; el correlativo del proveedor
deja de bloquear; la mercancía recibida sin factura pasa a tener dónde verse y quién la vigile; y
el lote y el vencimiento sobreviven a la llegada, que era lo que estaba a punto de romperse.

**Lo que cuesta.** Un endpoint nuevo y tres migraciones; una pantalla de seis pasos; la siembra de
diez ficheros E2E gana un campo (sin cambiar ninguna aserción — si alguna tuviera que cambiar, se
para y se avisa); y se retira una pantalla cuyo selector «por unidad / por total» se construyó el
2026-09-18 (`a73ba3f`): **ese trabajo se reutiliza en la puerta**, no se tira.

**Lo que no cambia.** Ningún gasto, ninguna compra histórica y ningún pago se mueven de sitio.
`POST /v1/purchases/simple` sigue vivo: es contrato público aunque la web deje de usarlo.

## Lo que espera al asesor

Tres puntos, con su pregunta exacta en `PENDIENTES_ASESOR.md`. Ninguno impide construir; los tres
impiden afirmar.

1. **Compra sin soporte fiscal** — *¿qué documento respalda una compra a quien no factura, y qué
   efecto tiene en el costo deducible para ISLR y en el crédito fiscal?* (En Colombia existe el
   «documento soporte en adquisiciones a no obligados a facturar», que genera el comprador; se cita
   como precedente regional, no como norma venezolana.) `VALIDAR-TRIBUTARIO`.
2. **Retención sobre una compra sin soporte** — *si la retención nace al abono en cuenta
   (PA SNAT/2025/000054, ADR-0065 §3), ¿se practica también sobre una compra sin factura?* Hoy no
   se practica. `VALIDAR-TRIBUTARIO`.
3. **IGTF al pagar a un proveedor en divisa** — *¿el pago en divisa a un proveedor genera IGTF a
   cargo de quien paga?* El pago **sigue haciendo exactamente lo que hace hoy**; no se afirma nada.
   `VALIDAR-TRIBUTARIO`.

## Entregas

- **(i)** El endpoint de la llegada con las cuatro salidas · migración 69 · permisos por camino ·
  `origin` obligatorio en la ruta suelta · fecha acotada con ventas intermedias · lote y
  vencimiento · compuestos deshabilitados con explicación · la pantalla con el `MoneyInput` actual
  y el selector unidad/total ya construido · menú, migas, guardia, Ctrl+K y aterrizaje con smoke
  por rol · pestaña «Falta la factura» · el control de recepciones sin factura · el E2E del ciclo
  completo de la cuenta puente, que hoy no existe.
- **(ii)** `MoneyDualInput` · migración **71** (`capture_currency` / `capture_mode`, nulos para el
  histórico porque `inventory_moves` es append-only y no admite backfill) · unidad/total en líneas
  de compra y recepción · `date` en la vista previa de conversión · flete.
- **(iii)** Pedidos: hacer un pedido, «Por recibir», el paso 0, la recepción a ciegas, «llegó solo
  una parte», cerrar un pedido con motivo · migración **72** (los otros dos controles).

Los números se corrigieron al escribirlas: la migración **70** (`receipts_pending_invoice`) nació
dentro de la entrega (i) para dar de comer a la pestaña «Falta la factura» y al control de los
treinta días, y corrió el resto una posición. Se anota aquí porque un número de migración
equivocado en un ADR es una pista falsa dentro de seis meses.

**La ceguera se cierra en el contrato, no en la pantalla.** Una línea de llegada que trae
`purchase_order_line_id` **no admite** `unit_amount` ni `amount`: el Zod la rechaza con 422 y el
servidor lee el precio acordado de la línea del pedido. Esconder los campos habría bastado para
que la pantalla se viera bien y para que cualquier cliente —el móvil, un script, el navegador de
alguien con la consola abierta— siguiera poniendo el precio que quisiera. Si el proveedor cobró
otra cosa, eso lo dice su factura, que es donde vive el cruce a tres vías (CLAUDE.md §2: ausencia
de mecanismo no es prohibición).

**El «demo» de `/dev/components` no se hizo.** Estaba previsto para enseñar el `MoneyDualInput`
aislado; se cambió por usarlo en la puerta y comprobarlo en un navegador de verdad, con la tasa
del día y la propagación al kardex y al mayor detrás. Un componente que se ve bien en una página
de muestra no dice nada de lo que guarda.

## Reversibilidad

- **Migración 69** — el DDL se revierte, pero **los documentos ya marcados sin soporte no se pueden
  representar sin la columna**: revertir con datos vivos los convertiría en facturas normales que
  entrarían al libro. Es de ida.
- **Migración 70** — totalmente reversible (`drop function`): es una lectura.
- **Migración 71** — reversible por DDL; sin backfill posible, y lo capturado se perdería.
- **Migración 72** — totalmente reversible (`drop function`).
- **Contrato** — `origin` obligatorio y la salida de `unit_cost` del ajuste van en la **ventana de
  deploy del dueño**, junto al rebuild de la web (R-43: una migración aplicada antes que su cliente
  deja trabajo a medias en producción).

## Alternativas descartadas

- **Explicar mejor las tres puertas.** Es lo que ya se hizo: la pantalla de entrada dice con todas
  sus letras «si la compraste, regístrala en Compras y gastos». Un consejo no es un mecanismo, y el
  error sigue terminando en verde.
- **Cerrar `POST /v1/inventory/receipts` con un 4xx.** Mismo efecto de control que exigir `origin`,
  pero rompe diez ficheros de prueba y la web desplegada durante la ventana. Se descarta por coste,
  no por principio.
- **Permitir fechar la llegada libremente hacia atrás y recalcular el kardex.** Reescribe costos ya
  asentados y choca con el append-only. Se descarta por diseño, y el ADR deja escrito el porqué
  para que la petición, cuando llegue, tenga respuesta.

## Nota de aplicación — ola 3: sin RIF y la llegada (2026-10-03)

RESPUESTA_RECORRIDO_2026-09-24 §3 (D-01, D-04, D-05, D-06, D-11, F-14) y los hallazgos D-08, D-09, D-10, D-12, D-13, D-14/I-03. Migración `20261003160000_a_supplier_without_rif_sells_without_invoice`.

1. **La empresa sin RIF compra (D-01).** Es `no_contribuyente` por hecho (`platform.taxpayer_type_at`, ola 2a) y no declara tipo. Compra por la cuarta salida («No va a haber factura») o con la factura del proveedor como **soporte de costo**: `tax_is_recoverable = false`, el IVA entra al costo, **nunca crédito fiscal** (LIVA art. 33; VALIDAR-TRIBUTARIO respondido por el dueño). Además, el tipo de contribuyente ya solo se exige CON factura: una empresa con RIF que aún no lo declaró compra sin factura (era el REPRODUCIR en el escenario final, donde E1 ya tiene RIF).
2. **El proveedor sin RIF (D-04).** `suppliers_tax_id_required_chk` se cae: la regla era de la compra con factura, no del proveedor. Vuelve como trigger sobre `supplier_invoices` (`fiscal_support` + nacional sin RIF → `LAD96`), y el caso de uso lo dice antes en palabras: pide el RIF, que viene impreso en la factura, y NO propone registrarla como «no va a haber factura» (AF3-14: eso sacaría del libro una compra que sí trae factura). *Decidido por criterio* (§2.16 (3)): el proveedor nacional sin RIF nace `natural` y `no_contribuyente` (sin RIF no hay inscripción); la alternativa era pedir ambos en el alta rápida, que solo pide nombre y documento.
3. **El precio sin IVA (D-05).** Se escribe sin IVA, como viene en la factura; `prices_include_tax: true` («el precio ya incluye IVA») hace que el SERVIDOR quite el IVA con la alícuota de compra del día (`platform.resolve_tax`, la misma de la factura), con 8 decimales. `POST /v1/arrivals/preview` corre `registerArrival` dentro de un savepoint que siempre se deshace: el resumen enseña base, IVA y total sin que la web calcule nada. *Decidido por criterio*: la vista previa es el mismo caso de uso deshecho, no un cálculo paralelo (la alternativa divergiría con el tiempo); su coste es una transacción de escritura que se revierte.
4. **«Ya llegó la factura» con precio (D-06).** El diálogo pide el precio de la factura por línea (por omisión el de la recepción); la revalorización por valor ya existía en `revalorizarContraRecepcion` (ADR-0060 §2) y no se alcanzaba desde la pantalla.
5. **El instante del hecho (D-08, D-10; familia F1).** `${fecha}T12:00:00.000Z` (las 08:00 de Caracas) se sustituye por `instanteDelHecho`: hoy → `now()` (el mismo reloj que `created_at`); un día anterior → el último milisegundo de ese día en Caracas. Vale para «ya era mía», la recepción y el pago de la llegada. Granularidad declarada: dos `date` de Caracas.
6. **La tasa de una llegada en divisa (D-09).** La regla exacta: una llegada que cruza monedas (el documento o algún costo en una moneda que no es la funcional) usa la tasa oficial **vigente a su fecha** —la más reciente con `rate_date <=` la fecha de la llegada, porque el BCV no publica sábados, domingos ni feriados y esos días rige la última publicada— **y no más antigua que el margen de plataforma** (`platform.parameters.closing_rate_max_age_days`, hoy 7 días; el mismo dato y la misma función, `platform.closing_rate`, que acotan la tasa de cierre de ADR-0075 §6). Fuera del margen, o sin ninguna tasa, el registro y la vista previa responden `EXCHANGE_RATE_MISSING` antes de escribir nada (`tasaVigenteDeLaLlegada`); la tasa no se inventa. La vista previa devuelve `fx_rate` y `fx_rate_date`, y «¿Todo bien?» dice qué tasa usa y de qué fecha es. Antes, `platform.rate_for` a secas admitía una tasa de cualquier antigüedad: mientras existiera una vieja, la llegada en dólares nunca fallaba. *Decidido por criterio* (coherente con la tasa de cierre); la alternativa, anotada: exigir la tasa del día exacto, que rechazaría fines de semana y feriados. Alcance: SOLO la llegada (registro y vista previa). Siguen con «cualquier tasa anterior vale» (`rate_for` sin margen) la factura de proveedor suelta, la recepción y el pago por sus propios endpoints, las ventas y cobros, tesorería y la vista `/v1/exchange-rates/preview` que alimenta el aviso de «¿Qué llegó?»: extender el margen a todos es decisión del dueño.
7. **D-12, D-13, D-14/I-03, F-14.** Sin RIF, la tarjeta «Sí, aquí está» y el resumen no prometen libro ni crédito fiscal. El aviso de sobregiro formatea sus importes. En «¿A qué depósito?» Enter elige y avanza, hay «Seguir», y «Principal Principal» desaparece. «Te deben», «Cuánto tiempo llevan debiendo» y «Pagado» llegan a `Cuentas.tsx` en modo recibos; *decidido por criterio*: el estado «Abonada» se lee «Pagado en parte» (la alternativa, «Pagado» a secas, diría que está saldado).
8. **Confirmar un sobregiro (D-11, H-05).** Dejar una cuenta en negativo exige TRES cosas: `allow_negative_balance`, el permiso `treasury.overdraft` en la empresa y un motivo (`overdraft_reason`, mínimo 5 caracteres). `exigeSaldo` lo comprueba para los cuatro egresos (gasto, transferencia, pago a proveedor —también desde la llegada y la compra simple— y reembolso) y deja el acta `treasury.overdraft.confirmed` en la misma transacción: quién, cuenta, importe, saldo antes y después, motivo y operación. Sin permiso: 403 «Esta cuenta no tiene saldo suficiente. Elige otra cuenta o pídele a quien administra que lo registre.»; sin motivo: 422. Si el saldo alcanza no se pide nada. La pantalla ofrece siempre elegir otra cuenta, y «Registrarlo igual» solo a quien tiene el permiso, con el motivo. *Decidido por criterio* (§2.16; RESPUESTA §3 D-11: «permiso + motivo + auditoría»): **los cuatro ojos no aplican al sobregiro que se confirma en el acto** —quien registra es quien confirma—; es lo más estrecho y reversible. La alternativa, anotada: construir la aprobación pendiente (quien registra pide, otra persona aprueba) y aplicar `platform.approval_allowed`. **Alcance:** la regla es de los EGRESOS que alguien registra. La reversa de un cobro (ADR-0075 §8) baja la caja sin pasar por `exigeSaldo`: deshace un ingreso que no debió contarse y lleva su propio permiso, motivo y acta; si deja la caja en negativo, se ve (decidido por criterio en ADR-0075, con su alternativa: exigir saldo o `treasury.overdraft`).
9. **Los libros son de quien tiene RIF (AF3-13, auditoría fiscal de la ola).** La empresa sin RIF guarda la factura del proveedor como soporte de costo (`fiscal_support = true`, `tax_is_recoverable = false`) y `platform.purchases_book` no mira el modo: el libro de compras se le podía leer y generar con ese renglón. `GET /v1/fiscal-books/:kind` y `POST /v1/fiscal-books/export` responden ahora 409 `REGIME_KIND_NOT_ALLOWED` con su motivo (`exigeEmpresaConRif`). *Decidido por criterio*: mira el RIF y no el modo de venta, porque una empresa con RIF que aún no activó la facturación sí lleva libro de compras; la alternativa era `exigeEmpresaQueFactura`. La función SQL sigue devolviendo el renglón a quien la llame directo: filtrarla dentro queda para la migración que la redefine (20261003190000).
10. **Los textos no prometen un efecto fiscal incondicional (AF3-15).** «da crédito fiscal» y «su IVA cuenta como crédito fiscal» pasan a «puede contar como crédito fiscal»: con ventas exentas hay prorrata.

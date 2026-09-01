# Handoff — 2026-09-01

## Estado

**Sprint 0 cerrado, OCHO módulos de negocio de extremo a extremo, y la FASE A de UI/UX
entregada: sistema de diseño, shell, componentes fundamentales y la vertical pulida
(dashboard, ventas, cuentas por cobrar, puesta a punto fiscal).** Flujo trunk-based: todo en
`main`, `verify` en verde antes de cada commit.

S0.1 ✅ · S0.2 ✅ · S0.3 ✅ · S0.4 ✅ · S0.5 ✅ · S0.6a ✅ · F-15 ✅ · **Productos ✅ · Clientes ✅ ·
Inventario ✅ · Ventas ✅ · Compras ✅ · Contabilidad ✅ · Libros fiscales ✅ · UI Fase A ✅** ·
UI Fase B ⏭️ · S0.6b ⏸️

> ✅ **La migración 27 está aplicada en el remoto** (2026-08-31, con aprobación explícita, vía
> Management API y registrada en `supabase_migrations.schema_migrations` con la forma de la CLI).
> **27/27. Local y remoto no divergen.**

## UI/UX Fase A — sistema de diseño y vertical pulida (2026-09-01)

Capturas reales en `docs/08_UX/capturas-fase-a/` (dashboard claro y oscuro, listado, detalle,
alta, cuentas con aging, checklist fiscal, paleta Ctrl+K, demo de componentes).

**Stack instalado** (apps/web): Tailwind v4 (`@tailwindcss/vite`), Base UI 1.0.0-rc.0 (el
default actual de shadcn; NO Radix), TanStack Table **v8** (v9 recién salida reescribió su API:
`useTable`/`createTableHelper` — pineado a la estable a propósito), @tanstack/react-virtual,
Recharts 3, Motion, Lucide, Inter y JetBrains Mono autoalojadas (@fontsource-variable),
react-router 8 (data mode), TanStack Query. Tema ÚNICO en `src/styles/theme.css`: todos los
tokens como CSS variables mapeadas con `@theme inline`; dark por CLASE (light default,
`prefers-color-scheme` de arranque, elección persistida — `theme.ts`).

**Componentes de firma**: `DualMoney` (formatea con @ladino/money/format y JAMÁS convierte: el
secundario solo existe si el servidor lo mandó; tasa+fuente en tooltip), `FiscalStatusBadge`
(estados del backend, color+icono fijos), `ExchangeDiffIndicator` (ganancia esmeralda, pérdida
ÁMBAR, narrativa tasa-emisión→tasa-cobro). **Fundamentales**: DataTable (v8, paginación de
SERVIDOR, virtualización opcional, CSV, estados integrados), FormField/MoneyInput (valida el
patrón del contrato, no redondea), Date(Range)Picker, EntityPicker asíncrono genérico, KpiCard,
EmptyState, ConfirmDialog, PageHeader, Toast. Todos en `/dev/components` (solo DEV).

**Shell**: sidebar 256px colapsable, top bar (CompanySwitcher con búsqueda >5, toggle de tema,
usuario), migas, Ctrl+K que navega y busca clientes/productos contra el SERVIDOR con el slot
del asistente IA reservado y rotulado como no implementado. **Divulgación progresiva con
datos**: Compras/Contabilidad/Libros aparecen si la empresa tiene filas (3 sondas per_page=1,
cacheadas), con «mostrar todos» en Configuración. Las 10 pantallas heredadas viven DENTRO del
shell bajo `.legacy` (theme.css) hasta que Fase B las alcance — `app/legacy.tsx` es la lista de
lo que falta.

**Vertical**: dashboard (5 respuestas del dueño, cada cifra del servidor), listado con los
filtros del endpoint, detalle con diferencial POR PAGO y trazabilidad al asiento o a la cola de
ADR-0042, alta donde el precio por línea es `price_at` con fecha explícita y los totales vienen
de una COTIZACIÓN guardada (botones con peso distinto; emitir pasa por consecuencias), registro
de cobro con el diferencial como narrativa de tasas (el importe exacto solo tras el servidor),
cuentas por cobrar con `ar_aging` en barras. **Checklist fiscal** (`/configuracion/fiscal`,
R-16 como diseño): tasa y rango con estado VIVO y carga inline; alícuota y régimen honestamente
«por operación» (sin endpoint de lectura hoy) con sello VALIDAR-SENIAT; verificación real vía
cotización de prueba; y los 409 de emisión enlazan a esta pantalla desde `MensajeError`.

**Decisiones/hallazgos que Fase B hereda:**

- **El contrato del documento no expone `amount_transaction_currency`** (solo totales
  funcionales + `transaction_currency` + `fx_rate`). La UI enseña el Bs con la tasa en tooltip;
  exponer el otro lado del pie es cambio de contrato → decide el usuario.
- **`balance` llega NULL en una anulada** — no es deuda cero. La UI lo enseña como «—»; el tipo
  dice `string | null`.
- **Una factura pagada en divisa queda con saldo funcional NEGATIVO** (= el diferencial): se
  pinta esmeralda (nada por cobrar), no ámbar, y no ofrece «Registrar cobro».
- **`/v1/branches` no existe**: BranchSwitcher montado y deshabilitado con el motivo en hover.
  «Rendimiento por sede» del dashboard, diferido por lo mismo.
- **`journal-entries` no filtra por `source_id`**: la trazabilidad al asiento barre
  `source_kind` (100 filas) y cruza en cliente — a escala Fase A vale; para Fase B conviene el
  filtro en servidor (cambio de contrato menor).
- **Sin GET de `tax_rules` ni endpoints de régimen fiscal**: por eso dos pasos del checklist son
  «por operación». Si se quiere estado vivo, son endpoints nuevos (aprobación aparte).
- El fallback de `mostrarImporte` VISTE el importe exacto (miles, coma, prefijo) quitando SOLO
  ceros finales — nunca redondea. `mostrarCantidad` recorta ceros de cantidades y tasas.
- KPI deltas: dirección por comparación de strings decimales (`decimal-compare.ts`), la
  etiqueta enseña el valor del período anterior tal cual — sin porcentajes calculados en
  cliente. Gráficas: `Number()` SOLO como geometría; toda cifra visible es el string del
  servidor.

**Para levantar el entorno de demo local**: stack supabase + API
(`DATABASE_URL=postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres LADINO_AUTH_MODE=jwks
SUPABASE_AUTH_ISSUER=http://127.0.0.1:54321/auth/v1
SUPABASE_JWKS_URL=http://127.0.0.1:54321/auth/v1/.well-known/jwks.json
CORS_ORIGIN=http://localhost:5174 node apps/api/dist/server.js`) + web
(`VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_PUBLISHABLE_KEY=<anon del stack local>
VITE_API_URL=http://127.0.0.1:3000 pnpm --filter @ladino/web dev`). OJO: vite dev escucha en
`localhost` (no en 127.0.0.1), así que el navegador va a `http://localhost:5174` y la API
necesita ese CORS_ORIGIN. Usuario demo local: `demo@ladino.dev` / `LadinoDemo2026!` (empresa
«Distribuidora El Ávila, C.A.» sembrada con datos de mentira evidente; el token local es ES256,
por eso la API va en modo jwks).

**Fase B** = replicar el patrón a los 10 módulos restantes vaciando `app/legacy.tsx`:
productos, precios, clientes, inventario, compras, contabilidad, libros, reportes. El patrón
está entero en `pages/ventas/` y los componentes en `components/`.

## Libros fiscales — el módulo entero (2026-08-31)

Migración 27 · ADR-0044 · pgTAP 027 (35 aserciones) · `packages/domain/src/fiscal-books.ts` ·
cinco endpoints · E2E de 13 casos · pantalla de tres paneles.

**Por qué ahora:** el libro de ventas y el de compras son obligación legal HOY bajo PA 071 y
PA 102. No dependen de homologación, no dependen de la PA 121 derogada, y no dependen de ningún
trámite externo. Sin ellos Ladino no puede vender a contribuyentes especiales.

**El defecto de datos que destapó construirlos.** `document_lines` congelaba la ALÍCUOTA pero no
el TRATAMIENTO, y una alícuota de cero no distingue exento de exonerado de no sujeto — que son
tres columnas legalmente distintas del libro. Leer hoy `products.tax_category_code` sería
reinterpretar el pasado con el catálogo de ahora; derivarlo de `tax_rules` tampoco vale, porque su
`product_tax_category` es nullable y entonces la regla no identifica el tratamiento.

| Decisión | Dónde | Por qué |
|---|---|---|
| Snapshot ampliado, **nullable y sin default** | `document_lines`, `supplier_invoice_lines` | Un default backfillea, y un backfill es una inferencia sobre el pasado disfrazada de valor por omisión |
| Una sola derivación categoría → tratamiento | `platform.tax_treatment_of()` | Dos `case` repetidos son dos libros que clasifican distinto la misma línea |
| Lo desconocido devuelve **NULL, no «gravado»** | misma función | Meterlo en la columna equivocada produce una declaración falsa |
| El libro es una CONSULTA, no una tabla | las cuatro funciones de la 27 | Un libro que se escribe puede divergir de sus documentos, y la única forma de saberlo sería calcularlo |
| El IVA sale de la **cabecera**, las bases de las líneas | `sales_book` / `purchases_book` | Así el libro cuadra con el mayor incluso para documentos anteriores a la 27, que no tienen tratamiento |
| `libro = mayor + pendientes`, las TRES cifras | `book_ledger_reconciliation()` | Con la cola de ADR-0042 viva, un «no cuadra» pelado sería un falso positivo diario |
| Ningún adaptador OFICIAL sembrado | `book_format_adapters` | El layout del SENIAT no está en el repositorio. Misma regla que ADR-0038 y ADR-0039 |
| Consultar no deja rastro; exportar sí | `fiscal_book_runs` | Una presentación hay que poder demostrarla; una mirada en pantalla no |

**`base_sin_clasificar` es una columna del contrato, visible en pantalla y en rojo.** Recoge lo
emitido antes de la migración 27. No se reparte y no se adivina: un libro que reparte en silencio
lo que no sabe clasificar produce una declaración falsa sin avisar a nadie.

**`operation_type` queda sin clasificar** en el cliente `no_domiciliado` y en el proveedor
`extranjero`. Ladino no implementa el régimen de exportación ni el de importación, y escribir
«interna» sobre una operación que quizá no lo es —en un libro que se entrega al fisco— es declarar
mal. VALIDAR-SENIAT.

### Lo que encontró el ejercicio, no una revisión

1. **El test 006 —la propiedad del catálogo— cazó un hueco de la migración 27 mientras se
   escribía:** `fiscal_book_runs` llevaba `tenant_id` y no llevaba trigger de ancla. Es append-only,
   así que el ancla es redundante… y se puso igual. En cuanto una tabla se salta la regla «porque
   en su caso no hace falta», la consulta que vigila el catálogo entero deja de poder afirmar nada.
   Es el cuarto módulo en que un invariante estructural encuentra algo que su propio módulo no veía.
2. **El `join` del libro de retenciones podía DUPLICAR filas.** `retention_receipts` no tenía
   unicidad por factura; el caso de uso emitía uno solo, pero eso vivía en el código. Dos
   comprobantes habrían convertido una retención en dos renglones — el doble de impuesto retenido en
   un documento legal. Ahora hay índice único parcial: ausencia de mecanismo no es prohibición.
3. **El `left join` de la conciliación no filtraba.** Las condiciones de período y estado del
   asiento estaban en un segundo `left join`, así que las líneas cuyo asiento no cumplía no se
   descartaban: se sumaban con `e` en NULL. Habría comparado el libro del mes contra el mayor
   ENTERO. Se pasó a un `exists` dentro del `ON`.

### Las dos variantes rotas

- **pgTAP:** 40 Bs de IVA en el mayor que ningún documento respalda → la conciliación se pone en
  rojo y dice **cuánto sobra, con signo**. Un «no cuadra» pelado obliga a volver a sumar, y quien
  vuelve a sumar suma distinto.
- **E2E:** se carga a propósito un adaptador de formato SIN implementación → 409 LAD65 y **no
  escribe** la generación. Sin cargarlo, ese camino sería código muerto que parece funcionar; y es
  exactamente el camino que el día que llegue el layout del SENIAT tiene que impedir exportar un
  CSV con nombre de fichero oficial. Se asevera el **mensaje**, no solo el código: el adaptador
  ausente del catálogo y el presente sin implementación producen el mismo 409.

### VALIDAR-SENIAT abiertos de este módulo

- **El formato del fichero de presentación.** El único adaptador sembrado es
  `csv_columnas_legales`, marcado `is_official = false`. Trae las columnas que PA 071 y PA 102
  **nombran** — entregable hoy a un contador — pero no es el layout que exige la administración.
  Cuando aparezca es otra fila y otra implementación de la misma interfaz: un enchufe, no una
  reescritura.
- **IGTF no aparece en ningún libro.** Ladino no lo calcula en ninguna parte, y `IGTF_SPEC` avisa
  además de que no toda operación en divisa lo causa. Una columna de IGTF hoy sería inventada.
- **La máscara de 14 caracteres del comprobante de retención** (PA 102) sigue sin implementarse,
  como ya decía el módulo de compras.

Remoto: proyecto `udacvwnhwpsdzbouhqhl` con **las 27 migraciones aplicadas** (las 26 primeras el 2026-08-27 y la 27 el 2026-08-31, vía
Management API, registradas en `supabase_migrations.schema_migrations` con la forma de la CLI para
que un `db push` futuro las reconozca). Paridad verificada por huella, **idéntica en las seis
clases**: 1106 columnas · 765 constraints · 287 índices · 562 policies · 86 funciones · 187
triggers. Local y remoto no divergen.

Y se comprueba en el remoto lo que la migración 27 garantiza sobre sí misma: **0 adaptadores
oficiales, 0 generaciones sembradas, 0 líneas con tratamiento backfilleado, 0 columnas nuevas con
`NOT NULL` o default, RLS forzada en las dos tablas.** Un seed que se cuela en producción es
indistinguible de un dato real seis meses después.

## El gancho contable — R-20 cerrado (2026-08-28)

Migración 26 · pgTAP 026 (26 aserciones) · `packages/domain/src/journal-generator.ts` · E2E de 12
casos · seis hechos enganchados.

| Hecho | Evento del outbox | Asiento |
|---|---|---|
| Factura de venta | `fiscal.invoice.issued` | CxC / ingresos + IVA débito fiscal |
| Cobro | `ar.payment_applied` | Banco / CxC + diferencial cambiario, por signo |
| Anulación de venta | — | **Reversa** el asiento de la emisión, no genera uno nuevo |
| Factura de compra | `ap.invoice_posted` | Inventario + IVA crédito fiscal / CxP, con las dos ramas |
| Pago a proveedor | `ap.payment_made` | CxP / banco + retenciones por pagar, desglosadas |
| Landed cost | `purchase.landed_cost_applied` | Inventario y variación / transitoria |
| Ajuste de existencias | `stock.adjusted` | Inventario / ajuste, por signo |

**Los presets de mapeo son un catálogo GLOBAL importable**, con la forma de `chart_templates`
(ADR-0043). `journal_templates` sigue naciendo vacía. La alternativa era sembrar las plantillas
dentro de los E2E, y entonces «lo que hace que la contabilidad funcione» viviría solo en los tests
mientras el sistema real seguiría sin poder asentar nada.

**Tres defectos que encontraron los tests, no una revisión:**

1. **La vigencia de la plantilla se comparaba contra medianoche.** `effective_from` iba contra
   `postingDate::timestamptz`, que son las 00:00 de ese día; una plantilla configurada esta tarde no
   aplicaba a un documento fechado hoy, y el sistema encolaba con «no hay plantilla» teniéndola
   delante. Es la misma trampa que `occurred_at` contra `now()` en inventario. Ahora se compara por
   DÍA.
2. **`auth.uid()` desde `ladino_api`**: no tiene USAGE sobre el esquema `auth`. El actor se pasa
   explícito desde cada caso de uso, que es como lo hacen todos los demás.
3. **Una factura de compra con retención rechazada se escribía igual.** `withTransaction` COMMITEA
   cuando el caso de uso devuelve `err` —solo revierte si algo LANZA—, y la retención se calculaba
   fuera del savepoint de la factura. Se respondía 409 y el documento quedaba escrito: sin asiento y
   sin fila en la cola. **El defecto llevaba ahí desde que se construyó compras y ningún test de
   compras lo veía, porque todos miraban la respuesta y ninguno la tabla.** Lo destapó
   `accounting_coverage_gaps()` contándolo como `missing`.

Y un detalle que dice algo del valor de esa consulta: al arreglarlo, **un test del E2E de compras se
puso rojo porque estaba pasando gracias al defecto** — buscaba entre las facturas posteadas la
primera con orden de compra, y la que encontraba era el documento fantasma.

**`payments`, `supplier_payments` y `retention_receipts` no llevan enlace de vuelta escrito.** Son
append-only sin GRANT de UPDATE para nadie, y debilitar eso para guardar una comodidad de lectura
era el peor de los dos tratos: `journal_entries.source_id` ya contesta esa pregunta, con índice.

## Módulo de contabilidad — construido entero (2026-08-27)

Migración 25 · ADR-0041 (mapeo cerrado) · ADR-0042 (cola de pendientes) · ADR-0043 (plantillas de
plan) · pgTAP 025 (53 aserciones) · `packages/accounting` (puro, 15 tests con 5 propiedades) ·
once casos de uso · veintidós endpoints · siete paneles de pantalla.

| Pieza | Dónde | Qué gobierna |
|---|---|---|
| **La partida doble** | `platform.assert_entry_balanced()` (LAD59) | En Postgres, en moneda funcional, en INSERT **y** UPDATE. No vive en la API |
| Plan de cuentas | `accounts` + `set_account_path()` | Jerarquía con path materializado; solo las hojas activas reciben asientos |
| Papeles contables | `company_account_settings` | La plantilla nombra un PAPEL; qué cuenta lo cumple lo dice la empresa, con vigencia |
| Mapeo | `journal_templates` + `journal_template_lines` | Vocabulario CERRADO: nada se evalúa en runtime |
| Cola de pendientes | `journal_generation_queue` | Sin plantilla, el documento se emite y encola. Bloquea el cierre |
| El invariante | `platform.accounting_coverage_gaps()` | Asiento **o** pendiente, nunca ninguno, nunca los dos |
| Mayor | `ledger_balances` + `recompute_ledger()` | Materializado por trigger, reproducible desde los asientos |
| Balance | `platform.trial_balance(company, fecha)` | La fecha es PARÁMETRO, nunca `now()` |
| Idempotencia | `UNIQUE (company, source_kind, source_id, source_event)` | El eje es el EVENTO del outbox, no el documento |
| Inmutabilidad | `assert_entry_immutable()` · `assert_line_immutable()` | Cabecera y líneas, en las dos capas de ADR-0006 |

**Decisiones que conviene no volver a discutir** (ADR-0041/0042/0043): el mapeo contable es dato
con vocabulario cerrado —ocho predicados, doce orígenes de importe, y ninguna cadena evaluada—; la
contabilización es síncrona **con cola** porque estricta dejaría el sistema inservible hasta que un
contador configure catorce papeles; el plan de cuentas nace vacío y la plantilla `ve_basico` es
global, marcada `VALIDAR-CONTABLE`, y se importa con un acto explícito; la tabla se llama
`journal_lines` porque así la nombra la prohibición de CLAUDE.md §2 — el modelo se acomoda a la
regla escrita, no al revés.

**El hallazgo, y lo encontró un test, no una revisión:**

**El mayor materializado estaba SIEMPRE vacío.** El trigger colgaba de un `AFTER INSERT` en
`journal_lines` y salía en la primera línea porque el asiento todavía era un borrador — que es la
única forma de construirlo. Ningún asiento habría llegado nunca al mayor, y nada habría fallado:
`recompute_ledger()` seguía dando el número correcto, así que las consultas «lentas» funcionaban y
solo la tabla rápida mentía. Lo destapó la aserción que compara el materializado con el
recalculado, que existe exactamente para esto y que es el mismo par que `stock_balances` ↔
`recompute_stock` de ADR-0034. El hecho contable es POSTEAR, no escribir una línea; ahí es donde
va ahora.

Y dos que no llegan a hallazgo pero se pagan: el estado de resultados y el balance general sumaban
con `Number()` —float sobre dinero, en el servidor, en los dos reportes donde menos se admite— y
pasaron a SQL sobre `numeric`; y `apps/web/CLAUDE.md` prohíbe la aritmética monetaria en el cliente
«incluso para previsualizar un total», lo que choca con el formulario de asiento manual. La
excepción está ahora **escrita donde vive la regla**, acotada por las tres condiciones que la hacen
inofensiva (no persiste, no decide, compara céntimos enteros); si alguna deja de ser cierta, la
excepción deja de valer.

**No construido, y dicho:** la conciliación subledger ↔ cuenta de control (puntos 6-8 de
`ACCOUNTING_INVARIANTS_TESTS`) queda fuera de alcance y es el test natural siguiente; el ajuste por
inflación es su propio módulo y solo se deja la cuenta de reexpresión en la plantilla; los asientos
automáticos desde ventas y compras tienen el esquema, la cola y el invariante montados, pero
**ningún módulo los invoca todavía** — es lo primero que hay que enganchar y por eso está en R-20.

## Módulo de compras — construido entero (2026-08-27)

Migraciones 22, 23 y 24 · ADR-0039 (retenciones) · ADR-0040 (compras y landed cost) ·
pgTAP 022 (71 aserciones) · `packages/purchases` (puro, 20 tests) · siete casos de uso ·
veinte endpoints · cuatro paneles de pantalla · E2E de 21 casos.

| Pieza | Dónde | Qué gobierna |
|---|---|---|
| Tablas propias | `purchase_orders` · `goods_receipts` · `supplier_invoices` · `supplier_credit_notes` | No `documents`: el trigger de emisión fiscal es nuestro, la factura la emite el proveedor |
| Estado de la orden | `platform.purchase_order_status` | DERIVADO de las recepciones, no una columna que se desincroniza |
| Costo | `goods_receipts` | Se fija en la RECEPCIÓN, con la tasa de ese día (ADR-0040 §4) |
| Prorrateo | `packages/purchases` | Tres métodos, residuo determinista, property tests |
| Landed cost tardío | `landed_cost_variances` | Variación declarada; **nunca** prorrateo sobre lo que queda |
| Revalorización | `inventory_moves` kind `revaluacion` | Valor sin cantidad, POR EL KARDEX (migración 23) |
| Retención | `platform.resolve_retention` (LAD53) | Del catálogo o **falla**; fórmulas de vocabulario cerrado |
| Comprobante | `retention_receipts` | Correlativo propio, conservado al anular |
| Matching | `platform.purchase_matching` | Informa; la política —el umbral— la aplica el caso de uso |
| IVA soportado | `supplier_invoices.tax_is_recoverable` | Derivado del contribuyente de la EMPRESA |

**Decisiones que conviene no volver a discutir** (ADR-0039 y ADR-0040): compras tiene tablas
propias porque meterla en `documents` obligaba a exceptuar el trigger de emisión fiscal; el
correlativo y el número de control del proveedor son TEXTO, no `bigint`, porque son datos de otro
emisor; `retention_rules` nace vacía y `resolve_retention` falla en vez de devolver cero; las
fórmulas de retención son un enum cerrado con parámetros en columnas, nunca una expresión
evaluada; el landed cost tardío genera variación y no encarece lo que queda.

**Los hallazgos, que valen más que el código. Los encontró el E2E, no una revisión:**

1. **La revalorización que rompía el kardex.** Para subir el valor sin añadir unidades, la primera
   versión metía la cantidad y luego la restaba de `stock_balances` a mano. Eso rompe el invariante
   sobre el que descansa el módulo de inventario entero: el saldo es una materialización del
   kardex y `stock_reconciliation()` comprueba que uno reproduce el otro. El descuadre habría
   aparecido meses después, en una reconciliación, sin forma de saber qué ajuste lo causó.
   Migración 23: el hecho EXISTE en el kardex, con cantidad cero. `apply_inventory_move()` ya lo
   calculaba bien; estorbaban dos `CHECK` escritos cuando el caso no se contemplaba.
2. **El landed cost chocaba con su propia defensa.** `goods_receipt_lines.landed_cost_functional`
   era un acumulado que había que ACTUALIZAR, y una línea de recepción confirmada es inmutable. Se
   podía haber exceptuado la columna en el trigger; no se hizo, porque «un trigger compartido con
   casos especiales se aplica mal» es el argumento que sostiene ADR-0040 §1 entero. La columna era
   además redundante: las asignaciones, que son append-only, ya la contienen. Migración 24 la
   quita y la sustituye por `platform.line_landed_cost()`.
3. **La migración 23 se contradijo con la 19** y nadie lo vio hasta ejecutar el flujo completo: la
   19 permite `reason` solo en un ajuste, la 23 lo exigía en una revalorización. Juntas prohibían
   el motivo en el único tipo que más lo necesita. Ahora el motivo es OBLIGATORIO ahí.
4. **`retention_concepts` se concedió a `authenticated` y no a `ladino_api`**, que es quien lo lee.
   El síntoma fue un 42501 que la regla 404/403 convierte en «Recurso no encontrado» — correcto
   por diseño y desconcertante de depurar. Es el precio de esa regla, y conviene tenerlo escrito.
5. **Todos los documentos de compra nacían ya confirmados** y el caso de uso los actualizaba
   después con los totales, cosa que el trigger de inmutabilidad rechazaba con razón. Ahora nacen
   en borrador y se confirman en el UPDATE final, igual que ventas emite.
6. **`companies` no tenía clasificación tributaria propia.** Hasta ahora la clasificación fiscal
   era de las contrapartes (ADR-0033), no de uno mismo, y ADR-0040 §7 la necesita para decidir si
   el IVA soportado es crédito o costo. Se añade NULLABLE y sin default: poner `ordinario` por
   omisión sería asignarle a cada empresa existente un régimen que nadie declaró.

**Sobre los E2E y el estado global, tercera vez que muerde.** El fichero de compras crea tenant
nuevo por corrida, pero `exchange_rates`, `tax_rules` y `retention_rules` son GLOBALES y las
comparte con el de ventas. Consecuencias que quedaron escritas en el propio test: la ausencia de
tasa **no** se puede demostrar borrando —ventas carga las suyas—, así que se demuestra donde la
fecha es un parámetro (el gasto de importación, con fecha de 2000); los importes se asertan contra
la tasa que el documento DECLARA, no contra un 40 escrito a mano, y los números exactos viven en
el pgTAP, donde la fixture sí está aislada.

**No construido, y dicho:** requisiciones y anticipos a proveedor (fuera de alcance, declarado; los
anticipos van con tesorería); órdenes automáticas por punto de reorden, aprobaciones multinivel,
contratos marco y portal de proveedor (diferidos por encargo); el asiento contable de la variación
de costo (se calcula y se persiste con su cuenta; postearlo es del motor contable).

## Módulo de ventas — construido entero (2026-08-27)

Migración 21 · ADR-0037 (numeración) · ADR-0038 (motor tributario) · pgTAP 021 (65 aserciones) ·
`packages/pricing` + `packages/sales` (puros) · ocho casos de uso · dieciséis endpoints · cuatro
paneles de pantalla + KPI · E2E de 14 casos.

| Pieza | Dónde | Qué gobierna |
|---|---|---|
| Correlativo y número de control | `claim_document_number` / `claim_control_number` | Dos columnas distintas (ADR-0037); el correlativo se conserva al anular |
| Régimen que decide | `platform.regime_at` + `assert_document_issuance` | Qué numeración aplica, comprobado en INSERT **y** UPDATE |
| Alícuota | `platform.resolve_tax` (LAD50) | Del catálogo o **falla**; nunca devuelve cero (ADR-0038) |
| Tasa | `exchange_rates` + `rate_at` (LAD51) | Efectiva por fecha y con fuente; sin tasa no se emite |
| Cálculo | `packages/sales` | Puro, property-based; el impuesto sobre la base YA redondeada |
| Saldo | `platform.document_balance` | Calculado, nunca una columna |
| Antigüedad | `platform.ar_aging` | Cuatro tramos, en el esquema |
| Diferencial | `exchange_gain_loss` | Solo si la tasa cambió; sin fila de cero |
| Reserva | `stock_reservations` + `available_stock` | Compromiso con caducidad, **no** kardex |
| Devolución | `return_lines.unit_cost_original` | Reingreso al costo original, no al de hoy |

**Decisiones que conviene no volver a discutir** (ADR-0037 y ADR-0038): `document_number` y
`control_number` son DOS columnas y el régimen decide cuál aplica; el correlativo es gapless y
**sobrevive a la anulación**; `tax_rules` nace VACÍA a propósito y dos reglas de la misma prioridad
son un catálogo ambiguo que detiene la emisión; un rango agotado **para la caja** y por eso hay
alerta antes; una nota de crédito exige SU PROPIO rango autorizado.

**Los tres hallazgos de la construcción, que valen más que el código:**

1. **El documento nacía en moneda funcional con `fx_rate = 1`, y eso dejaba el diferencial
   cambiario como CÓDIGO MUERTO.** Con la tasa ya cocida dentro del total, un cobro posterior no
   tenía contra qué compararse: la tabla `exchange_gain_loss` habría estado siempre vacía y nadie
   lo habría notado, porque no falla nada. Ahora el documento vive en la moneda de su lista de
   precios y la conversión va en los siete campos de ADR-0020. Los totales del pie siguen siendo
   funcionales —es contra ellos que `document_balance` resta los cobros—, y el impuesto funcional
   se DERIVA como total − subtotal: convertir los tres por separado produce redondeos que no
   cuadran y `documents_amounts_chk` exige que cuadren.
2. **Otra vez la lección de S0.5, y otra vez costó encontrarla.** `resolve_tax` levanta una
   excepción, un error de Postgres CONDENA la transacción, y el `catch` que la envolvía era código
   muerto que parecía funcionar: el 409 lo producía en realidad la tabla de SQLSTATE, con mensaje
   genérico. Lo destapó **comparar el mensaje**, no el código — igual que en S0.5. Ahora va en
   `savepoint`, y el E2E asevera el mensaje que solo produce ese camino.
3. **Tres códigos de negocio no estaban en la tabla de dominio y salían como 500.**
   `EXCHANGE_RATE_MISSING`, `TAX_RULE_MISSING` y `FISCAL_NUMBERING_INVALID`: rechazos legítimos
   presentándose como fallo del servidor. Añadidos, junto con las filas SQLSTATE LAD49/50/51.
   `LAD51` estaba **reservado y sin usar**; ahora se usa, y `ERROR_CATALOG.md` lo dice.

Y dos que no llegan a hallazgo pero se pagan en tiempo: `exchange_rates.rate_timestamp` no tenía
default y nadie lo ponía (23502 → 422 en cada carga de tasa), y `createCompany` no sembraba
ninguna lista de precios, así que una empresa recién creada no podía vender y el hueco solo
aparecía en la primera factura. Ahora siembra `detal` y `mayor` en moneda funcional.

**Sobre el E2E y el estado compartido, que ya nos mordió tres veces:** el fichero crea un tenant
NUEVO en cada corrida. No es manía — ventas asigna correlativos gapless, consume rangos y fija un
régimen con vigencia sin solape; con un tenant fijo, la segunda corrida arranca con el rango medio
gastado y el test falla por su propia historia. De lo global limpia solo lo suyo (`exchange_rates`
por su fuente). **`tax_rules` no se puede limpiar**: una regla citada por una línea de documento
tiene FK y la base se niega —correctamente, porque borrarla dejaría una factura sin decir con qué
alícuota se emitió—, así que el caso de «sin regla no se vende» usa un producto cuya categoría
nunca tiene una.

**No construido, y dicho:** el flujo de dos fases con imprenta digital sigue abierto
(OPEN_QUESTIONS 10, ningún régimen se siembra en `per_document`); el adaptador BCV es
`NullBCVAdapter` y la única vía real es la carga manual con fuente; `applyCredit` existe como
instrumento de cobro (`saldo_a_favor`), no como endpoint propio; no hay asiento contable —ventas
emite el evento de outbox y el motor contable lo consumirá cuando exista.

## Módulo de inventario — construido entero (2026-08-26)

Migración 19 · ADR-0034 · pgTAP 019 (60 aserciones) · `packages/inventory` (puro) · cuatro casos
de uso · seis endpoints + almacenes · pantalla con kardex.

| Pieza | Dónde | Qué gobierna |
|---|---|---|
| Costeo | `packages/inventory/src/costing.ts` | Promedio ponderado móvil, puro, property-based |
| Verificación del costeo | `platform.apply_inventory_move()` (LAD41) | Oráculo EXACTO en SQL, sin dividir |
| Kardex | `inventory_moves` | Append-only en dos capas (ADR-0006) |
| Existencias | `stock_balances` | Materializado por trigger, misma transacción |
| Reconciliación | `platform.stock_reconciliation()` | «Kardex reproduce balance» como consulta |
| Negativo | `inventory_settings` + `inventory.negative` | Bandera de empresa **y** permiso acotado |
| Transferencia | `transfer_id` + LAD40 diferido | Instantánea, sin «en tránsito» |
| Fecha | `platform.stock_at(…, fecha)` | Parámetro, nunca `now()` (como `price_at`) |

**Decisiones que conviene no volver a discutir** (todas en ADR-0034): el promedio es por posición
`(company, almacén, producto, lote)`; el costo de vaciar una posición es TODO el valor, sin
residuo; sin promedio significativo (cantidad ≤ 0 **o** valor < 0) se arrastra el último costo
unitario y **nunca** se persiste uno negativo; `roundForCost` es el quinto contexto de redondeo
(§6.6, `HALF_UP` para no discrepar con el `round()` de Postgres); la moneda funcional es
`companies.functional_currency_code` (default `VES`, VALIDAR-TRIBUTARIO).

**Hallazgos de la construcción, que valen más que el código:**

1. **LAD25 rechaza un «jefe de inventario» company-wide.** Los cuatro permisos de inventario son
   acotados, y ADR-0025 §4 exige `requires_scope = true` en cualquier rol que los tenga. No existe
   operar «toda la empresa» por omisión: se opera lo que se tiene enlazado, almacén por almacén.
   Lo destapó el pgTAP al forzar las constraints diferidas, no una revisión.
2. **`occurred_at` por omisión lo pone el SERVIDOR.** `created_at` sale de `now()`, que es la hora
   de inicio de transacción; cualquier instante calculado en Node después es posterior y el CHECK
   `occurred_at <= created_at` lo rechaza **siempre**. Lo destapó el primer test de integración.
3. **Un constraint trigger sin `WHEN` encola un evento por cada fila**, aunque la función salga en
   la primera línea: diez mil movimientos, diez mil eventos vivos hasta el commit, y cualquier
   `TRUNCATE`/`ALTER TABLE` posterior muere con 55006 en vez del error que se esperaba.
4. **El property test encontró un promedio negativo** (posición en negativo + entrada barata) y un
   desbordamiento de `numeric(24,8)` que 300 corridas locales no vieron y el `verify` sí, con otra
   semilla. Los dos están ahora como ejemplos explícitos.
5. **`pnpm verify` puede resolverse al builtin `verify` de cmd** y dar `VERIFY EXIT=0` con un log
   de dos líneas. Se usa `pnpm run verify` y se cuenta los pasos (CLAUDE.md §5).

**No construido, y dicho:** reservas (van con ventas), conteos cíclicos (módulo propio con
aprobación), seriales y BOM (banderas sí, estructura no — un producto con `tracks_serials` **no
puede moverse**), ajustes de solo valor (R-13), endpoint de `inventory_settings` (hoy la fila la
escribe el operador), y el asiento contable del COGS (es de contabilidad).

## Inventario, segunda vuelta — cinco capacidades de mercado (2026-08-26)

Migración 20 · ADR-0035 (recetas y unidades) · ADR-0036 (variantes) · pgTAP 020 (45 aserciones) ·
`packages/inventory/recipes.ts` · `consumeRecipe` · once endpoints · dos paneles y el de recetas.

| Capacidad | Decisión que se tomó | Dónde vive |
|---|---|---|
| Recetas | El compuesto **no tiene stock propio** (LAD43); anidamiento **no**, forzado (LAD44) | `product_recipes`, ADR-0035 |
| Unidades | Conversión **dirigida**, sin derivar inversas; sin fila, se rechaza | `unit_conversions`, LAD45 |
| Vencimientos | FEFO es **sugerencia**; que un vencido no salga es **obligación** (LAD46) | `suggest_lot_fefo`, `expiring_lots` |
| Variantes | Cada variante es un **producto**; el template solo agrupa | `product_templates`, ADR-0036 |
| Umbrales | Solo la consulta; la notificación se difiere al worker | `low_stock_products` |

**Lo que los tests encontraron y no una revisión:**

1. **`sum()` ignora los NULL**, así que `recipe_cost` devolvía un costo **a medias** justo en el
   caso que su propio comentario decía impedir. Corregido con un `CASE` que exige que ninguna línea
   sea NULL. Lo destapó el pgTAP 020.
2. **La clave natural `(company, kind, reference)` de la 19 no sobrevive a las recetas**: vender doce
   arepas es UNA referencia con N salidas. Se ensancha a incluir producto y lote — la garantía de
   idempotencia se conserva y un documento pasa a poder tener varias líneas, que es lo que un
   documento es.
3. **La linealidad exacta de la explosión es imposible** a escala finita. La propiedad la exigía y
   falló (5001 contra 5000). No se cambió la implementación para satisfacer una propiedad falsa: se
   corrigió la propiedad para que diga la verdad con su cota, `(n+1)/2` unidades de 10⁻⁸.
4. **Un recuento fijo se rompe cuando se añade algo correcto**: el test 016 decía `count(units) = 5`
   y la migración 20 lo puso en rojo al sembrar gramo, mililitro y minuto. Pasa a comprobar la
   propiedad (que las cinco de D-4 sigan ahí), que es lo que S0.4 ya había corregido en el test 004.
5. **Un `CHECK` no admite subconsulta** (0A000): recorrer un `jsonb` lo es. La forma de `attributes`
   se comprueba con una función `IMMUTABLE`, con su `GRANT` — un CHECK se evalúa con los privilegios
   de quien inserta, y sin él la tabla quedaría escribible por nadie (la lección de S0.4).

**Deuda que esto deja escrita:** recetas anidadas (una salsa base se repite hoy en cada plato),
alta masiva de variantes (5 tallas × 8 colores son 40 productos a mano), normalización de los
valores de `attributes` («azul» vs «Azul»), y la notificación de las alertas.

**Siguiente módulo (propuesta): compras (recepción con documento) o ventas.** Inventario ya tiene
las entradas y salidas; lo que falta es el documento que las origina y las paga. Ventas es lo que
cierra el ciclo con clientes y precios ya construidos, pero arrastra `reservations` y toca
facturación fiscal — que sigue bloqueada por `OPEN_QUESTIONS`. **Compras es el camino con menos
bloqueantes**: proveedores (dispara R-12, la decisión `party`), órdenes, recepción contra la
entrada de inventario que ya existe, y el costo real de adquisición alimentando el promedio.

## Módulo de clientes — construido entero (2026-08-26)

| Capa | Qué hay | Dónde |
|---|---|---|
| Esquema | migración 18: `taxpayer_types` (5, VALIDAR-TRIBUTARIO) y `person_types` (4) globales; `customers` por company con RIF nullable solo para persona natural, único PARCIAL case-insensitive, dirección/email/teléfono inline, lista de precios preferida (FK compuesto), estados lead/active/blocked/inactive; **trigger M4** `audit_customer_tax_id()` (LAD36) con valor anterior; permisos `customer.manage` / `customer.tax_id.manage` / `customer.block` | `supabase/migrations/20260826120000_*` · ADR-0033 |
| pgTAP | 018 (30): único parcial en las dos direcciones (dos sin RIF conviven, dos iguales no; roto sin el índice), jurídica sin RIF rechazada, valor anterior asertado por el DATO (`tax_id_anterior`/`tax_id_nuevo`, `rules_version` respetada; roto sin el trigger), LAD36 con JWT sin permiso / vive con permiso, aislamiento | `supabase/tests/018_*` |
| Dominio | `createCustomer`, `updateCustomer`, `setCustomerTaxId` (permiso propio; el trigger escribe el hecho, el caso de uso NO lo duplica), `setCustomerBlocked` (cobranzas) | `packages/domain/src/customers.ts` + 7 tests |
| API | `GET/POST /v1/customers`, `GET/PATCH /v1/customers/:id`, `PUT /v1/customers/:id/tax-id`, `PUT /v1/customers/:id/blocked`, `GET /v1/{taxpayer-types,person-types}` — OpenAPI generado | `apps/api/src/routes/customers.ts` + 5 E2E |
| Web | listado con búsqueda por RIF/razón social y paginación, alta/edición, detalle con cambio de RIF (permiso propio, error del dominio visible) y bloqueo/desbloqueo | `apps/web/src/CustomersView.tsx` |

**Decisiones por el camino:** estado por defecto `active` al crear (`lead` se elige explícitamente);
`updateCustomer` no puede tocar el RIF, las clasificaciones fiscales ni `blocked`, y rechaza cambiar
el estado de un bloqueado (desbloquear es de cobranzas); `setCustomerBlocked` distingue «ya está
así» (422 con palabras) de «no existe» (404). **No construido, dicho:** cambio de clasificación
fiscal tras el alta (sin caso de uso ni permiso todavía), contactos/direcciones múltiples,
crédito, etiquetas, y el `party` cliente/proveedor → **R-12** con disparador (proveedores).

**⚠ Incidente de proceso (2026-08-26), dicho aquí porque la regla lo exige:** los tres commits
del módulo de clientes se pusheron con `@ladino/domain#lint` en ROJO (un `as never` innecesario).
Leí mal la salida del `verify` y commiteé igual. Sin `force`: el arreglo llegó encima
(`fix(domain): type the audit payload as JSONValue`) con el `verify` leído entero. Lección
operativa: el resumen del log se lee por `VERIFY EXIT` y por `Failed:`, no por la última línea
que aparezca; queda en el mensaje del commit y aquí.

**Siguiente módulo (propuesta): inventario.** Con productos y clientes en pie, ventas de bienes
necesita existencias; los almacenes ya existen desde S0.3. Es donde se decide la frontera
lotes/seriales/BOM que productos difirió a propósito (cabecera de la migración 16) y donde
`inventory_moves` (append-only, ya en la lista de tablas intocables de CLAUDE.md §2) toca dinero
por primera vez vía costeo — rigor máximo en valoración. Leer `INVENTORY_SPEC` y
`WAREHOUSE_OPERATIONS_SPEC` primero, como siempre, y traer los huecos antes del SQL.

## Módulo de productos — construido entero (2026-08-25)

| Capa | Qué hay | Dónde |
|---|---|---|
| Esquema | migración 16 (`products`, `product_categories`, `units`, `currencies`, `product_tax_categories`) y **17** (`price_lists`, `price_list_items` con EXCLUDE por rango, autocierre, guardián LAD35, `close_price()`, `price_at(list, product, FECHA)`) | `supabase/migrations/20260825*` · ADR-0032 |
| pgTAP | 016 (30) y 017 (33): SKU hostil con roto, anti-confusión fiscal/comercial en tres direcciones, solape 23P01 con roto, LAD35 en dos capas, autocierre por el dato, `now()` como negativo, importe al límite 24,8 | `supabase/tests/016_*`, `017_*` |
| Dinero | viaje `numeric(24,8) → postgres.js (string) → Money → {amount, currency}` dígito a dígito | `packages/db/test/money-roundtrip.test.ts` |
| Dominio | `createProduct`, `updateProduct`, `setProductTaxCategory` (permiso segregado), `createPriceList`, `setPrice` — plantilla de 10 pasos company-scoped con `companyScope()` (copia única) | `packages/domain/src/{products,pricing,company-scope}.ts` + 13 tests |
| API | `GET/POST /v1/products`, `GET/PATCH /v1/products/:id`, `PUT /v1/products/:id/tax-category`, `GET/POST /v1/price-lists`, `GET/POST /v1/price-lists/:id/prices` (`?product_id&at=`), `GET /v1/{units,tax-categories,product-categories}` — todo con `X-Company-Id`, mutaciones con `Idempotency-Key`, OpenAPI generado | `apps/api/src/routes/{products,pricing}.ts` + 8 E2E con JWT real |
| Web | listado con búsqueda y paginación en servidor, alta/edición, detalle con precio vigente por lista, gestión de listas y carga de precios; importes solo formateados con `@ladino/money/format` | `apps/web/src/{ProductsView,PricingView,money}.tsx` |

**Decisiones tomadas por el camino (todas dentro del plan aprobado):**
- El detector de coste de 015 quedó **sin roto** con los números medidos (aprobado); el de 017 no
  tiene detector: el gate por fila con roto sigue siendo 013.
- `companyScope()` NO toma `FOR UPDATE` sobre la company (desviación de la plantilla, declarada en
  `products.ts`): serializaría todo el catálogo por un maestro reversible; el SKU lo decide el índice.
- `GET /v1/products` pagina con `count(*) over ()`; `per_page ≤ 100`; búsqueda `ilike` con comodines
  escapados.
- `PriceItemResponse` lleva la moneda de la **lista**: el ítem no la repite (una sola fuente).
- La web muestra los precios de lista con hasta 8 decimales **exactos** cuando `formatMoney` se
  niega (formatear no redondea): el dato, no un redondeo inventado en el cliente.
- **Regla de eslint tapada**: `no-restricted-imports` bloqueaba también `@ladino/money/format` —
  nunca se notó porque ningún cliente había importado money. Ahora es un regex probado en las dos
  direcciones (raíz y `/fx` bloqueados, `/format` permitido).

**Lo que NO se hizo, dicho:** no hay CRUD de categorías comerciales (la API solo las lista; el
producto las acepta) ni endpoint para `close_price()` (retiro sin sustituto: existe en la base con
su permiso, sin caso de uso todavía); el seed de clasificaciones tributarias sigue **VALIDAR-TRIBUTARIO**;
`main.ts` del worker sigue sin test (R-10).

**Siguiente módulo (propuesta): clientes (CRM mínimo)** — es el segundo maestro que ventas
necesita, tiene clave natural clara (RIF por company) y arrastra la primera decisión fiscal de
contraparte (tipo de contribuyente para retenciones, `TAX_ENGINE_SPEC` `taxpayer_type`) que hay
que leer en las specs ANTES de escribir SQL, igual que se hizo con productos.

`pnpm verify` corre **11 pasos** — S0.6a añadió `release:manifest:check` (paso 9). **Los pasos 5,
10 y 11 necesitan el stack local** (`pnpm db:start`). **506 pgTAP** (18 ficheros) + **124 tests
de vitest** (API 82 · worker 13 · dominio 20 · db 9) — **los E2E y los tests de dominio conectan
como `ladino_api`/`ladino_worker`**, no como postgres. `pnpm boundaries:selftest`: 22/22. Las dos
imágenes se construyen (247/233 MB). Riesgos R-08..R-11 en `RISK_REGISTER.md`, cada uno con
disparador. **En esta máquina: `TURBO_CONCURRENCY=1 pnpm verify`** (R-11).

**⚠ En esta máquina, `TURBO_CONCURRENCY=1 pnpm verify`.** Con la concurrencia por defecto se cae
por memoria (`VirtualAlloc failed`, exit `-1073740791`): hay ~2 GB libres con Docker y un stack
Supabase de OTRO proyecto (`padrino-academy`) levantado junto al de Ladino. No es un fallo de
código y no se paran contenedores ajenos.

## S0.6a — qué hay, en el orden que pediste

1. **`auth.ts` en dos modos** — `jwks` (ES256, clave pública del proyecto, el de producción) y
   `hs256` (solo el stack local). El modo es configuración, no detección. `config.ts` es puro y
   probado: `hs256` no arranca con `NODE_ENV=production` **ni** contra un emisor que no sea local —
   dos capas, cada una probada sola. Un JWKS caído ya no es un 401 masivo: es `503
   AUTH_BACKEND_UNAVAILABLE` con log.
2. **Contenedores** — `infra/docker/Dockerfile.{api,worker}` (multi-stage, base por digest, no
   root, `--ignore-scripts`, heap por debajo del límite) y `infra/compose/docker-compose.ladino.yml`
   con **límites de CPU/memoria** (api 1.0/512M, worker 0.5/256M), `cap_drop`, `read_only`,
   `no-new-privileges`, `pids_limit`, `stop_grace_period`. **Worker** con consumo del outbox en dos
   fases + testigo de reserva, **los dos reapers** (outbox e idempotencia) y la purga de claves
   caducadas; se mata solo tras 5 ciclos fallidos porque Docker no reinicia por `unhealthy`.
3. **`releases/manifest.json`** con la release `0.1.0` retroactiva (13 hashes de migración, base
   image, `homologation_status: not_applicable`); `scripts/release-manifest.mjs check|new|digest`;
   el check es paso de `verify` y **probado con cuatro variantes rotas** (migración editada,
   borrada, nueva sin registrar con y sin tag). La variante «editada» destapó que el hash era
   sensible a CRLF: normalizado.
4. **Traefik: solo labels** — router propio con `Host && !Path(/healthz) && !Path(/readyz)`,
   cabeceras, rate limit laxo por IP. Red del proxy `external: true`. Nada de n8n, nada de la
   configuración estática.

Controles nuevos en la API que salieron de la auditoría: **rate limit por usuario** (`429
RATE_LIMITED`, 300/min, nunca por IP en la API), **plazo por petición** (`504 GATEWAY_TIMEOUT`,
30 s ≪ 15 min del reaper: es lo que hace seguro liberar claves), `/readyz` con plazo y sin
detalle, apagado con respaldo de 8 s, `X-Request-Id` acotado. Catálogo en `ERROR_CATALOG.md`.

### La auditoría de S0.6a: 24 hallazgos

| # | Sev. | Qué era | Estado |
|---|---|---|---|
| F-1 | alto | fallo del JWKS servido como 401 sin log | ✅ 503 + log, tests con `fetch failed` y `ERR_JWKS_TIMEOUT` |
| F-2 | medio | hs256-en-producción dependía de una sola señal, sin test | ✅ segunda capa (emisor local) + 8 tests de `config.ts` |
| F-3 | bajo | caché JWKS 10 min tras revocar | 📝 runbook en `infra/README.md` |
| F-4 | bajo | `X-Request-Id` sin acotar | ✅ `/^[\w.-]{1,64}$/` o se genera |
| F-5 | medio | `/readyz` público, con `select 1` gratis y campo `db` | ✅ excluido del router, sin detalle |
| F-6 | alto | sin rate limit en ninguna capa | ✅ por usuario en la API + laxo por IP en Traefik, tests |
| F-7 | medio | readiness que se cuelga | ✅ plazo 2 s, test con base que no responde |
| F-8 | medio | apagado sin plazo ni idempotencia de señal, promesa sin manejar | ✅ flag, respaldo 8 s, `unhandledRejection` |
| **F-9** | **alto** | **T2 tardío del worker pisaba la reserva viva de otro worker** | ✅ testigo `attempts` + plazo de entrega < reaper, **test con la carrera exacta** |
| F-10 | alto | T2 de idempotencia sin guarda; reaper podía liberar una operación viva | ✅ `and status='in_progress'` + timeout de petición 30 s |
| F-11 | alto | healthcheck del worker sin actuador (Docker no reinicia `unhealthy`) | ✅ el worker sale con 1 tras 5 fallos o ciclo colgado |
| F-12 | medio | claves caducadas `in_progress` para siempre; sin purga | ✅ reaper las libera; `purgarIdempotencia` a 7 días, test |
| F-13 | medio | reaper devolvía sin backoff | ✅ backoff por intentos, test |
| F-14 | medio | bucle sin red: sin handlers, reapers después del lote | ✅ |
| **F-15** | **alto** | **los dos servicios se conectan como el superusuario `postgres.<ref>`** | ✅ **CERRADO por decisión tuya, antes del primer deploy**: ADR-0031 + migración 14 + pgTAP 014. Ver sección siguiente |
| F-16 | bajo | `NullTransmitter` con `console.log` por defecto en paquete puro | ✅ sumidero obligatorio |
| F-17 | riesgo | `published` ≠ «recibido por SENIAT» con el transmisor nulo | 📝 `REGULATORY_STATUS.md` + README |
| F-18 | medio | red del proxy compartida: `ladino-api:3000` alcanzable desde n8n | ✅ controles en la app; escrito en compose y README |
| F-19 | medio | sin `cap_drop`/`read_only`/`no-new-privileges`/`pids_limit` | ✅ |
| F-20 | medio | base image sin digest | ✅ `node:22-alpine@sha256:c610fc…` + `base_image` en manifest |
| F-21 | bajo | postinstall como root en el build | ✅ `--ignore-scripts` |
| F-22 | bajo | `.dockerignore` no cubría `apps/*/.env` | ✅ `**/.env*` |
| F-23 | bajo | `.npmrc` copiado al build | 📝 nota: jamás tokens ahí; secret de BuildKit si hace falta |
| F-24 | bajo | `reservations.cpus` no actúa en Compose | 📝 dicho en compose y README |

**Lo que la auditoría cerró sola y no aparece arriba:** el test del worker asertaba `publicados: 3`
y pasaba solo pero fallaba dentro de `verify` (8: cinco filas de otros tenants dejadas por los
tests de la API). El worker es global por diseño; el test ahora drena, aserta por tenant y acota
los contadores por abajo. Un test que depende del orden de los suites no es un test.

### F-15 cerrado: ADR-0031, migración 14, pgTAP 014 — la RLS ya contiene a la API

Tu razón, que ahora está en el ADR: con el superusuario, las seis migraciones de aislamiento de
S0.3 eran decorativas para el camino real, y la única defensa era que el código filtrara — el
modelo descartado. Lo construido:

- **`ladino_api`** y **`ladino_worker`**, `NOBYPASSRLS NOSUPERUSER`, creados por la migración 14
  **sin contraseña** (LOGIN y contraseña: seed local / operador en remoto, `infra/README.md`).
- **Funciones de actor SEPARADAS**: `platform.ladino_service_actor_id()` (solo el GUC) y
  `ladino_service_tenant_ids()`. Las del camino `authenticated` **no se tocaron** — el primer
  diseño (un `coalesce(auth.uid(), GUC)` compartido) lo tumbaron SEIS suites de pgTAP: con el
  GUC puesto, una sesión authenticated SIN JWT ganaba visibilidad. La separación es estructural
  y su variante rota (mezclar los caminos) quedó en 014 como negativo.
- Policies `TO ladino_api` por **tenant** del actor en las 14 tablas (idempotencia además por
  actor); `ladino_worker` solo GRANT sobre `outbox` e `idempotency_keys`.
- **pgTAP 014, 35 aserciones**: catálogo consultado (no supuesto), ejercicio con actor A contra
  datos de B (0 filas, dato intacto, 42501), multi-tenant, sin actor, y TRES variantes rotas
  (policy permisiva → mide la RLS; GRANT al worker → mide el privilegio; policy de authenticated
  con función de servicio → mide la separación). Total pgTAP: **403**.
- **Los vitest de la API y del worker conectan como los roles dedicados** — y eso encontró dos
  agujeros reales al primer intento: `tenantVisible()` corría FUERA de `withTransaction` (sin
  GUC → 404 para todo el mundo; con postgres pasaba en silencio) y a los roles les faltaba
  USAGE sobre `extensions` (pgcrypto, que usa `uuidv7()`). Los dos, arreglados y en verde.
- Aprendizajes de aplicación de la migración: `ALTER ROLE … NOSUPERUSER` exige superusuario con
  solo nombrarlo (las migraciones corren como `postgres`, que no lo es) → el cinturón es el
  bloque `LAD32` que aborta si los atributos no cumplen. Y cuatro aserciones de catálogo de
  suites viejos (recuentos de policies, «cero escrituras con predicado») se acotaron al camino
  de cliente: habían caducado con ADR-0031, la propiedad que protegen sigue intacta.

**VALIDAR-SUPABASE:** que el pooler (6543) acepte los roles dedicados; si no, 5432 directo.
**Pendiente del operador en remoto:** aplicar migración 14 y fijar contraseñas de los roles.

### Lo que queda ANTES del primer deploy real (en orden)

1. **Rotar credenciales** — la `sb_secret` y el token `sbp_…` se pegaron en un chat. (Dijiste
   que rotas tú y avisas.) Los VALIDAR-DEPLOY de Traefik también los consultas tú en el VPS.
2. ~~Migraciones en el remoto~~ **HECHO (2026-08-26): proyecto NUEVO `udacvwnhwpsdzbouhqhl`
   («ladino2», us-west-2, Postgres 17.6, firma ES256). Las 17 migraciones aplicadas en orden por la
   Management API y registradas en `supabase_migrations.schema_migrations` con la forma de la CLI
   (un `db push` futuro las reconoce). Paridad verificada por huella: 553 objetos idénticos local
   ↔ remoto (columnas, constraints, índices, policies, funciones con proconfig, triggers, RLS,
   grants, atributos de roles, seeds).** El proyecto anterior (`igpfrwdgmicgyirwdbgs`) quedó
   pausado y abandonado. Pendientes: contraseñas de `ladino_api`/`ladino_worker` (las pone el
   operador; `infra/README.md` §Roles de servicio) y el VALIDAR-SUPABASE del pooler.
   **Rotación al cerrar**: los tokens `sbp_` (dos) y la `sb_secret` del proyecto nuevo se pegaron
   en el chat.
3. Construir y publicar las imágenes por la secuencia de `infra/README.md`; anotar digests con
   `pnpm release:manifest digest`; etiquetar `v0.1.0`.
4. En el VPS: consultar la red y el resolver del Traefik existente (no inventarlos), secretos en
   `/etc/ladino/*.env` con `chmod 600`, `docker compose -p ladino … up -d`.

Después: **maestros por `platform.ladino_user_company_ids(uuid)`** (sección «Primer paso del
bloque 4», más abajo): migración con gate de coste y variante rota → middleware de alcance →
primer maestro. Rigor normal.

---

# Handoff anterior — 2026-08-18 (S0.5)

`pnpm verify` corría entonces **10 pasos**; 368 pgTAP + 37 tests de vitest. Lo que sigue se
conserva porque el bloque 4 (maestros) se apoya en ello.

## La auditoría de S0.5: corrió (al quinto intento) y encontró OCHO cosas — todas cerradas

Cuatro intentos murieron con `529 Overloaded`; el quinto entregó el informe más completo de la
sesión. **Ocho hallazgos, siete reproducidos, los ocho corregidos con test que los distingue.**

| # | Sev. | Qué era | Arreglo |
|---|---|---|---|
| H-1 | **crítico** (corrección) | **`try/catch` de SQLSTATE dentro de `withTransaction` era CÓDIGO MUERTO**: postgres.js rechaza `begin()` con el error original aunque el callback lo capture. El test pasaba porque la tabla de SQLSTATE de `onError` producía el MISMO `DUPLICATE/409` — «tapada» en tiempo de ejecución | **savepoint** en todo conflicto esperable dentro de una transacción (caso de uso y T1). Test compara el **mensaje**, que es lo único que distingue el catch vivo del muerto |
| H-2 | alto | T1 reservaba la clave con el tenant del cuerpo **sin autorizar**: escritura cross-tenant + oráculo de existencia (409 REUSED vs 404) | visibilidad ANTES de T1 con el helper **compartido** `tenantVisible()` — una sola copia del predicado |
| H-3 | alto | dos reintentos concurrentes de una clave `failed` se rehabilitaban los dos → **doble ejecución** | `select … for update` en el lookup + guarda de estado en el update. Test con el intercalado exacto de dos conexiones |
| H-4 | medio | pasado el TTL la clave quedaba **inutilizable para siempre** con un `DUPLICATE` que mentía sobre la causa | el 23505 de T1 distingue fila caducada (se **reclama** y se reejecuta) de fila vigente (409 IN_PROGRESS). Ahora el comentario de cabecera es verdad |
| H-5 | medio | `tenant_id` malformado → 500 | forma UUID antes de tocar la base; `22P02 → 422` como red |
| H-6 | bajo | `DELETE /v1/companies` sin handler reservaba clave | idempotencia montada **por método**, no por path |
| H-7 | bajo | `for update` sobre el tenant **antes** de autorizar: lock cross-tenant gratis | orden que enseña la plantilla: visibilidad → permiso → bloquear |
| H-8 | bajo | un fallo de T2 pisaba un 201 real con un 500 | T2 en su try/catch; el efecto ya está hecho, la clave la reclama H-4 |

Más `Bearer` case-insensitive (RFC 7235). Lo que el auditor revisó y salió limpio: el JOIN de
autorización filtro a filtro contra la función canónica, `auth.ts` sin bypass, `Buffer.compare`
sin necesidad de constant-time (no hay secreto que filtrar: el lookup ya filtra por actor), cero
`service_role` en clientes.

**La lección que va a `CLAUDE.md` con nombre propio: H-1 lo destapó mirar el `message`, no el
`code`.** Un test que asserta código y status prueba el mapeo genérico creyendo que prueba el caso
de uso. Y el fallo de fondo de postgres.js —un error condena la transacción, y capturarlo sin
savepoint es código que parece funcionar— es de la familia de Hono/`onError`: dos frameworks, dos
semánticas de error contraintuitivas, ambas destapadas por el E2E real y no por unitarios.

Lo que el auditor no miró: `openapi.ts` (¿alguna ruta fuera de `/v1/*`? — no la hay, comprobado),
rate limiting (no existe: el cuerpo se lee entero a memoria sin `bodyLimit`, anotado abajo).

## Hecho en esta sesión (S0.5, bloques 0–3)

### La infraestructura de la API

| Pieza | Dónde | Lo no obvio |
|---|---|---|
| **`@ladino/db`** — único punto de entrada a Postgres | `packages/db` | `withTransaction` fija `ladino.actor_id` como PRIMERA sentencia. `set_config(…,true)` y no `SET LOCAL` porque `SET LOCAL` **no admite bind**. El `import` de `postgres` vive en UN fichero y la regla 13 del gate lo impone |
| **JWT** | `apps/api/src/middleware/auth.ts` | La API verifica la firma ELLA MISMA (escribe con `service_role`: la RLS no la protege). Seis validaciones explícitas; token de otro proyecto muere en firma Y en emisor, probados por separado |
| **Idempotencia T1/T2** | `middleware/idempotency.ts` | Lookup FILTRADO POR ACTOR. Cuatro decisiones pendientes tomadas: hash de bytes crudos, replay = status+cuerpo originales, in_progress → 409+Retry-After, TTL 24 h |
| **Errores** | `middleware/errors.ts` | **En Hono, `next()` NO propaga excepciones** — el mapeo vive en `app.onError`. La primera versión era un middleware con try/catch y nunca vio un error: lo destapó el E2E |
| **Plantilla** | `packages/domain/src/create-company.ts` | Los diez pasos numerados, no-ops declarados en su sitio. Autorización tenant-wide con el JOIN espejo de la función canónica |
| **OpenAPI** | `pnpm openapi` / `openapi:check` | Generado desde los Zod de `packages/schemas`; el check es paso 8 de verify, probado en las dos direcciones |
| **Gate de fronteras VIVO** | `pnpm boundaries:selftest` | Las 22 reglas demuestran que disparan. Encontró DOS muertas (una desde su creación) y la distinción **inerte/tapada** quedó en la skill |

### Los hallazgos que valen más que el código

1. **`pure-packages-no-io-libs` llevaba inerte desde que se escribió** — `node_modules` en
   `exclude` borraba las aristas npm del grafo. El arreglo dejó el mismo fallo un nivel más abajo
   (el `dist/` interno de las dependencias). Casos 9 y 10 de ADR-0023.
2. **Hono entrega errores a `onError`, no a los try/catch de middlewares.** Sin el E2E con JWT
   real, todos los caminos de error habrían salido 500 en producción.
3. **El E2E cazó una fuga de la regla 404/403**: dos caminos de «no visible» con el mismo status y
   distinto `code` — el cuerpo revelaba lo que el status ocultaba. Unificados; la aserción compara
   cuerpos completos.
4. **F-9 disparó por tercera vez** (fixture del E2E): las companies con auditoría no se borran; se
   reutilizan con RIFs únicos por corrida.

### Decisiones nuevas escritas donde se leen

- Regla 404/403 con su porqué: `ERROR_CATALOG.md` (decisión, no convención).
- «Cuando hay que elegir un modo de fallo, se elige el ruidoso» — skill, regla general.
- La asimetría del centinela (`companies.created_by` exige usuario real; `idempotency_keys.actor_id`
  acepta centinela): `API_SPEC.md` + test que la fija.
- `X-Company-Id` **se rechaza activamente** hasta que exista su validación (ver siguiente sección).

## Primer paso del bloque 4 (maestros)

**No es un endpoint: es la función de visibilidad por company parametrizada por usuario.**

Los maestros (clientes, productos, impuestos) son de **alcance company**, y hoy `X-Company-Id` se
rechaza con `COMPANY_SCOPE_NOT_IMPLEMENTED` a propósito: validarlo exige una función tipo
`ladino_user_company_ids(p_user)` que no existe — las `ladino_*` resuelven sobre `auth.uid()` y la
API entra con `service_role`. Escribir el join a mano en el middleware sería la segunda copia de
la resolución RBAC (ADR-0027 §3-bis), y la primera copia parcial (el JOIN de create-company) ya
tuvo una escalada por un filtro omitido.

Orden concreto:

1. **Migración**: `platform.ladino_user_company_ids(uuid)` espejo de `ladino_company_ids()`, con
   gate de coste (la usará el middleware en CADA petición con company) y variante rota.
2. **Middleware de scope real**: valida `X-Company-Id` contra esa función, puebla
   `ctx.companyId/tenantId`, y retira el rechazo activo.
3. **Primer maestro** copiando la plantilla de `create-company.ts` — con su clave natural única,
   que el borde T1/T2 exige.
4. **Refactor pendiente**: cuando exista la función parametrizada de permisos por company usable
   aquí, el JOIN de `create-company.ts` debe evaluarse contra ella otra vez.

Rigor **normal** en los maestros (CLAUDE.md §3) — la plantilla ya pagó el rigor máximo.

## S0.6 — reevaluado: ya no tiene sentido diferirlo entero

Lo que se difirió en la derogación fue *el release train fiscal con manifest de homologación*.
Pero S0.6 contenía más cosas, y **tres razones han cambiado el cuadro**:

1. **Ahora hay una API real que desplegar.** `buildApp()` funciona con `app.request()`; falta el
   arranque del servidor, el contenedor y el Traefik. Sin eso, S0.5 solo existe en tests.
2. **Dos reapers sin dueño, los dos de DISPONIBILIDAD del camino crítico**: el del outbox
   (`in_flight` huérfano) y el de idempotencia (`in_progress` clavado bloquea el reintento hasta
   el TTL). Los dos necesitan el worker, y el worker es S0.6.
3. **El registro de versiones debe arrancar en la primera release** (ADR-0027 §5, entregable 2).
   Cada release sin manifest es historial que luego será inferencia.

**Recomendación (aprobada): partir S0.6 en dos.**
- **S0.6a — ahora**: contenedor de la API + worker mínimo (consumo de outbox con `NullTransmitter`
  + los dos reapers) + proyecto Supabase remoto + manifest de versiones desde la release 1.
- **S0.6b — sigue diferido**: el gate de CI del release train fiscal. Sin régimen al que reportar,
  un gate que bloquea contra nada solo entrena a ignorarlo.

### El proyecto remoto ya existe — estado y hallazgos

`udacvwnhwpsdzbouhqhl` (ref en `.env`, que está en `.gitignore`; plantilla en `.env.example`).
Las API keys (publishable/secret) están en el `.env` local. **La `sb_secret` se pegó en un chat:
rotarla al cerrar el sprint** (dashboard → API Keys → rotate; es un clic y no rompe nada si se
actualiza el `.env`).

**⚠ HALLAZGO QUE CAMBIA `auth.ts` EN S0.6a: el proyecto remoto firma los JWT con ES256
(asimétrico)** — comprobado contra su JWKS público (`/auth/v1/.well-known/jwks.json`). Nuestro
`auth.ts` fija `algorithms: ["HS256"]` con secreto compartido, que es lo que usa el stack LOCAL:
contra el remoto rechazaría **todos** los tokens legítimos. El trabajo: configuración por entorno —
HS256+secreto en local, `createRemoteJWKSet` (jose) + ES256 contra el remoto. Y es mejor noticia
que problema: con firma asimétrica la API solo necesita la clave pública, no hay secreto de
verificación que proteger, y la clase entera de confusión de algoritmo desaparece en producción.

**Las 13 migraciones YA ESTÁN APLICADAS al remoto** (2026-08-18, vía Management API, cada una
registrada en `supabase_migrations.schema_migrations` con la forma estándar del CLI, así que un
`supabase db push` futuro las reconoce y no re-aplica). Verificado contra el remoto por
propiedades, no por lista: 14 tablas, **cero** sin RLS forzada, **cero** sin policy, **cero** con
`tenant_id` sin trigger de ancla, 24 permisos, envoltorio de permisos en plpgsql, `NULLS NOT
DISTINCT` en idempotencia, `server_encoding = UTF8` (la premisa del `IMMUTABLE` del hash), y la
prueba negativa **ejercida**: `UPDATE` sobre `audit_events` como `service_role` muere en 42501.

**Higiene de credenciales pendiente al cerrar el sprint** — dos, no una: la `sb_secret` **y el
token personal `sbp_…`** se pegaron en el chat. Rotar ambos (API Keys → rotate; Account → Access
Tokens → revocar y crear otro) y actualizar `.env`. Además, para que el **MCP** de Supabase
funcione en la próxima sesión, `SUPABASE_ACCESS_TOKEN` y `SUPABASE_PROJECT_REF` tienen que estar
en el **entorno del proceso** (variables de usuario de Windows o al lanzar Claude Code): el
`.mcp.json` los expande de ahí, no lee `.env`.

## Riesgos y límites que esta sesión añade o toca

- **Logging estructurado (ADR-0017) NO implementado** — el middleware de contexto genera
  `request_id` pero nadie emite el log JSON. Entra con S0.6a u observabilidad temprana.
- **Rate limiting**: decidida la clave (`user_id`), nada implementado. Sí hay `bodyLimit` (1 MB) desde el cierre de la auditoría: sin él, cualquier autenticado forzaba reserva de memoria arbitraria con un cuerpo enorme.
- **La clave de idempotencia clavada hasta el TTL** sigue sin reaper (ADR-0018 enmendado lo exige).
- R-01..R-07 sin cambios. La tensión R-05/ADR-0029 quedó resuelta con el catálogo versionado.

### R-16 · El sistema no puede emitir una sola factura hasta que alguien cargue tres cosas

Y es deliberado, pero conviene que esté escrito antes de la primera demo, porque parece una avería:
una empresa recién creada **no puede facturar**. Le faltan (1) una regla en `tax_rules` con su
fuente legal, (2) una tasa en `exchange_rates` con su fuente si vende en otra moneda, y (3) un
régimen fiscal vigente más, si el régimen lo exige, un rango de números de control de la imprenta.
Cada una de las cuatro ausencias devuelve un 409 con un mensaje que dice exactamente qué falta.

El riesgo no es técnico: es que alguien, viendo cuatro errores seguidos en una demo, «arregle» el
sistema sembrando una alícuota del 16 % en una migración. **Esa alícuota sería una obligación legal
inventada** (CLAUDE.md §2) y quedaría copiada en cada factura emitida a partir de ahí. La carga es
un acto administrativo con fuente citada, no un seed.

### R-18 · Una empresa agente de retención no puede pagarle a un proveedor hasta que carguen la norma

Simétrico a R-16 y con la misma raíz: `retention_rules` nace vacía y `resolve_retention()` falla en
vez de devolver cero. El riesgo tampoco es técnico — es que alguien, viendo un 409 en una demo,
«arregle» el sistema sembrando un 75 % en una migración. **Esa sería una obligación legal inventada
que se le quita a un tercero y se entera al fisco en nombre de él**, que es peor que inventar una
alícuota. La pantalla de Retenciones existe para que cargar la regla sea un acto visible con su
Gaceta, no un ajuste escondido.

### R-19 · Cuánto queda de una recepción concreta es una APROXIMACIÓN, y el landed cost la usa

El kardex no rastrea qué unidad vino de qué recepción —eso exigiría costeo por capas, que ADR-0034
descartó a propósito—, así que `applyLandedCost` aproxima «lo que queda de esta recepción» con la
existencia ACTUAL de la posición, acotada por lo recibido en la línea.

Consecuencia real: si entre la recepción y el gasto entró mercancía de OTRA compra, el disponible
puede cubrir lo recibido aunque estas unidades concretas ya se hayan ido, y el reparto se inclinará
hacia el inventario. Está elegido así: **revalorizar de más es visible en el costo unitario;
una variación inflada desaparece en resultados sin que nadie la mire.** Si algún día hace falta
exactitud, la respuesta es costeo por capas y su ADR, no un parche aquí.

### R-17 · La emisión y el kardex son atómicos, y eso hace la factura tan frágil como el stock

`createInvoice` descarga el inventario en la misma transacción: si no alcanza la existencia, la
factura entera no ocurrió. Es lo correcto —una factura sin salida de mercancía es un descuadre
permanente— pero significa que **un problema de inventario impide facturar**, y en un mostrador eso
se vive como «el sistema no deja vender». La alternativa (facturar y descuadrar) es peor y no se
va a tomar; lo que falta es que la pantalla lo explique cuando llegue el `NEGATIVE_STOCK`, y que
la empresa que de verdad venda sin stock use la bandera `allow_negative_stock` con su permiso, que
para eso existe.

### R-20 · ~~La contabilidad está montada y NADIE la invoca~~ **CERRADO (2026-08-28)**

El generador está enganchado en los seis hechos que los módulos ya emiten, síncrono y en la misma
transacción del documento. Sobre los datos de TODOS los E2E: **11 documentos emitidos · 0 huecos de
cobertura · 6 asientos · 14 en cola · 0 asientos descuadrados.** El invariante de ADR-0042 pasó de
*comprobable* a *cumplido*.

Lo que queda de este riesgo, y no es lo mismo: **la cola es real y hay que mirarla.** Los 14
pendientes salen de los E2E porque no todas sus empresas importan el preset de mapeo. En una
empresa de verdad significa lo mismo: documentos correctos, contabilidad por hacer, y el cierre de
período bloqueado hasta que se haga.

Cuatro hechos siguen sin plantilla, y cada uno por su razón:

- `purchase.goods_received` — **deliberado**: en el preset `ve_basico` el inventario se capitaliza
  contra la FACTURA de compra, no contra la recepción. Una empresa que lleve «mercancía recibida no
  facturada» necesita su propia plantilla y un papel contable que todavía no existe. Está en la
  cabecera de la migración 26 para que no se descubra cuadrando.
- `sales_credit_note` y `purchase_credit_note` — las notas de crédito de ventas se emiten
  (devoluciones) y las de compra se reciben, y las dos entran en la cola. Es el siguiente hueco a
  cerrar, y **se ve solo**: está en la cola con su motivo.
- `retention_receipt` — el comprobante se emite, pero el movimiento de «retenciones por pagar» a
  «retenciones enteradas» no tiene evento propio todavía. Los papeles `retention_iva_paid` y
  `retention_islr_paid` existen esperándolo.

Y dos papeles están en el catálogo **sin uso**: `retention_iva_receivable` y
`retention_islr_receivable`. Ventas no calcula todavía las retenciones que nos practican a nosotros.

### R-21 · Una plantilla marcada `VALIDAR-CONTABLE` que nadie valida acaba siendo el plan real

`chart_templates.ve_basico` existe para que arrancar sea posible en un minuto en vez de dos días.
El marcado se muestra entero en la pantalla de importación y las cuentas quedan editables desde el
primer momento, pero **el esquema no puede impedir** que alguien importe, no revise, y opere un año
con un plan que Ladino nunca afirmó que fuera correcto.

No hay mitigación técnica que sirva: obligar a una confirmación más solo entrena a pulsar dos
veces. Lo que hay es que esté escrito aquí y en ADR-0043, y que el `suggested_purpose` no se
esconda — la pantalla de papeles muestra siempre qué cuenta cumple cada uno, que es donde un error
de la plantilla se ve antes de que produzca un asiento.

## Estado en git

`main`, al día y empujado. Últimos commits del módulo de ventas:

- `83ce51b` migración 21 (13 tablas, pgTAP 021, la nota de `set_row_provenance`)
- `6a5bc7e` `packages/pricing` y `packages/sales` — cálculo puro con property tests
- `c36f838` casos de uso, API, OpenAPI y E2E (los tres hallazgos de arriba)
- `5ccce55` pantallas de ventas y el KPI de diferencial
- `5026282` compras: ADR-0039/0040, migración 22 y el paquete puro
- `dbefc0d` compras: casos de uso, API, pantallas, migraciones 23 y 24
- `7755dba` contabilidad: ADR-0041/0042/0043, migración 25 y `packages/accounting`
- `5900245` contabilidad: casos de uso, API, OpenAPI y pantallas
- `897b67e` **el gancho**: migración 26, generador y seis módulos enganchados
- `0014dc6` el defecto de compras que destapó la consulta de cobertura

`verify` en verde antes de cada uno; el último: `VERIFY EXIT=0`, **561 pasos**,
`All tests successful` (825 aserciones pgTAP en 24 ficheros, 145 tests de API).

**Siguiente módulo: LIBROS FISCALES** (libro de ventas, libro de compras, formato SENIAT). Con la
contabilidad conectada es lectura estructurada de datos que ya existen.

## Histórico

S0.5 commiteado en `s0.5/api-and-use-cases` (cuatro commits: docs, feat, chore, y las correcciones de la auditoría) y con PR #3 abierto hacia `main`. **La auditoría ya no bloquea**; el merge espera tu aprobación explícita, como siempre.


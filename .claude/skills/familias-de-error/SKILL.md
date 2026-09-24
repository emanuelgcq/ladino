---
name: familias-de-error
description: La lista viva de las familias de error que Ladino ya sufrió, con dónde aparecieron y cómo detectarlas. La precargan auditor-codigo y revisor. Úsala al auditar código, al revisar un diff, o cuando un test pase «demasiado fácil».
---

# Familias de error de Ladino

Cada familia se repitió. La primera vez fue un bug; la segunda, un patrón; la tercera, una
vergüenza. **Buscar por familia encuentra lo que buscar por síntoma no ve.** Si encuentras una
aparición nueva, dilo en el informe con la palabra «FAMILIA» y su número: es lo que hace crecer
esta lista.

**Las nueve comparten un rasgo: casi todas terminan en verde.** El test pasa, la pantalla no se
queja, y el dato queda mal. Por eso la pregunta útil nunca es «¿falla?», sino «¿qué tendría que
fallar si esto estuviera mal, y lo hace?».

---

## F1 · Fecha contra reloj — 4 apariciones documentadas

**Qué es.** Un `date` y un `timestamptz` en el mismo operador, o una fecha sembrada con un reloj
distinto del que se usa para leerla. Uno de los dos se convierte en un instante que nadie eligió.

**Dónde apareció.**
1. `occurred_at` tomaba el reloj de Node y `created_at` es `now()` = inicio de TRANSACCIÓN: el
   `CHECK occurred_at <= created_at` rechazaba siempre (inventario, migración 19).
2. La vigencia de una plantilla contable se comparaba con `fecha::timestamptz` = medianoche: una
   plantilla configurada a las 17:00 no aplicaba a un documento de hoy (migración 26).
3. Lo mismo, dos veces más, en las vigencias de `company_account_settings`. (CLAUDE.md §3 las
   cuenta como la tercera.)
4. `supabase/tests/022_purchases_test.sql` sembraba la tasa con `current_date` (UTC) mientras
   `supplier_debt_today` la busca por `platform.caracas_day(now())`: desde las 20:00 de Caracas
   sembraba la tasa de MAÑANA (commit `5a4df5d`, 2026-09-20).

**Cómo detectarla.** Busca `current_date`, `now()::date`, `::timestamptz` sobre una fecha,
`new Date().toISOString().slice(0,10)` y `toISOString()` en fixtures. **La señal: el test pasa a
las 15:00 y falla a las 21:00.** La regla: toda comparación declara su granularidad — dos `date`,
dos instantes, o la fecha como parámetro. En tests, siempre `diaCaracas()` o
`platform.caracas_day(now())`.

---

## F2 · `err` devuelto con commit silencioso

**Qué es.** Un caso de uso devuelve `err(...)` DESPUÉS de haber escrito, y `withTransaction`
commitea igual, porque solo hace rollback ante una EXCEPCIÓN, no ante un `Result` de error.

**Dónde apareció.** `registerSupplierInvoice` devolvía `err` tras escribir la factura: un 409 con la
factura dentro. Lo encontró `accounting_coverage_gaps()`, no un test de compras (CLAUDE.md §3,
«Los tests que cruzan módulos…»).

**Cómo detectarla.** En cada caso de uso de `packages/domain`: ¿hay algún `return err(` después
de un `insert`/`update`/llamada que escribe? Todo `err` va ANTES de la primera escritura, o la
escritura va dentro de un `savepoint` que se deshace. Y un error de Postgres **condena la
transacción**: capturarlo sin `savepoint` es código que parece funcionar (S0.5).

---

## F3 · Trigger compartido con excepciones

**Qué es.** Un trigger que sirve a varias tablas o varios `kind` y va acumulando `if` para los casos
especiales. El caso especial que falta es la puerta abierta.

**Dónde apareció.** ADR-0026 (bloqueantes heredados de S0.3): «un trigger con casos especiales es
un trigger que alguien aplicará mal» — por eso `set_row_provenance()` se aplica a las tres tablas
aunque en una la columna quede muerta. ADR-0037: «cuatro bytes cuestan menos que una excepción en
un trigger compartido». ADR-0040: compras tiene tablas propias precisamente para no exceptuar tres
`kind` dentro de `assert_document_issuance()`.

**Cómo detectarla.** En una función de trigger: `if new.kind in (...)`, `if TG_TABLE_NAME = ...`,
`case` sobre el tipo de fila. Cada rama es una tabla que el trigger protege distinto.

---

## F4 · Ausencia de fallo leída como éxito

**Qué es.** Algo no falla, y se concluye que funciona — cuando en realidad no se ejecutó, no
comprobó nada o miró el sitio equivocado.

**Dónde apareció.** **Ocho veces en un solo sprint**, en ocho capas (ADR-0023, «La lección»). Entre
ellas: `dependency-cruiser` que no resolvía nada y aprobaba todo (S0.1, por eso existe
`pnpm boundaries:selftest`); el `pnpm verify` que en Windows cae en el builtin de cmd y devuelve 0
sin verificar (CLAUDE.md §5, por eso existe `scripts/gate-verdict.sh`).

**Cómo detectarla.** Todo control tiene que haberse VISTO fallar al menos una vez: su variante rota.
Un gate sin variante rota es una afirmación sin prueba. Pregunta: «¿qué log, qué conteo, qué
línea demuestra que esto de verdad corrió?».

---

## F5 · Contradicción entre migraciones no consecutivas

**Qué es.** Una migración redefine una función (`create or replace`) partiendo de una versión
VIEJA —la que se recordaba, o la de la migración original— y deshace sin decirlo lo que añadió una
migración intermedia.

**Dónde apareció.** `platform.purchases_book` tiene cuatro versiones (migraciones 31, 65, 67, 69).
Reescribirla de memoria «ya costó tres columnas de resultado una vez» (comentario de la migración
69, `20260918120000_…sql:89`). Desde entonces, la 69 copia **la definición viva** de la 67 y añade
dos filtros, nada más.

**Cómo detectarla.** Ante todo `create or replace function`: `grep -l "function platform.<nombre>"
supabase/migrations/*.sql` y compara el cuerpo nuevo con **la última** versión, no con la primera.
Si falta una columna, un filtro o una rama que la anterior tenía, es esto.

---

## F6 · Invariante que nace verde

**Qué es.** Un control que devuelve cero desde el primer día — no porque todo esté bien, sino porque
no mira lo que debería mirar. Una tabla nueva no se añade a su consulta y el control sigue en cero.

**Dónde apareció.** La nota de crédito recibida del proveedor bajaba la deuda sin asiento, fuera del
libro y sin restar crédito fiscal, «y ningún control lo veía, porque `accounting_coverage_gaps` ni
miraba esa tabla» (26ª entrega, ADR-0065, migración 67). `inventory_ledger_gap` ignoraba el corte de
la regularización que su hermana sí respetaba (misma migración).

**Cómo detectarla.** Por cada tabla nueva que mueve dinero, stock o documentos: ¿qué invariante la
cubre? Busca su nombre en las funciones de control (`*_gaps`, `*_reconciliation`, `trial_balance`).
Si no aparece en ninguna, el invariante «nace verde» para ella.

---

## F7 · La tabla que se salta la regla «porque no hace falta»

**Qué es.** Una excepción razonada a una regla de familia. El razonamiento es correcto de puertas
adentro, y es la primera grieta del gate: a partir de ella, el control deja de poder devolver cero.

**Dónde apareció.** `fiscal_book_runs` nació con `tenant_id` y sin trigger de ancla porque «la tabla
es append-only, luego el ancla es redundante». El test 006 lo cazó y se puso el trigger igual
(CLAUDE.md §3, «La primera excepción documentada convierte el gate compuesto en decoración»).

**Cómo detectarla.** En una migración o un gate: una lista de exclusiones, un `where table_name not in
(...)`, un comentario «aquí no hace falta porque…». La respuesta correcta de un gate es **cero, sin
lista de perdones**; si un caso no puede cumplirlo, se cambia el invariante, no se exceptúa la tabla.

---

## F8 · Test cross-módulo que caza un bug intra-módulo

**Qué es.** Un defecto dentro de un módulo que ningún test de ese módulo ve, porque todos observan la
superficie que el propio bug controla. Solo lo ve un observador que no depende de la pieza.

**Dónde apareció.** El `err` con commit de compras (F2) lo encontró `accounting_coverage_gaps()`. Y
un test del propio E2E de compras pasaba **gracias** al defecto: buscaba la primera factura posteada
y encontraba el documento fantasma — «un test que pasa gracias a un bug es un antitest» (CLAUDE.md
§3). En ADR-0066, el filtro `?pending=1` que dejaba en la bandeja un pedido recién cerrado lo cazó
el E2E del ciclo completo, no un test de compras (28ª entrega).

**Cómo detectarla.** Es una familia de DETECCIÓN, no de error: cuando un invariante cruzado se pone
rojo, busca el bug en el módulo, no en el invariante. Y ante un módulo nuevo, pregunta «¿qué
invariante cruza este módulo con los anteriores, y quién lo mira?».

---

## F9 · Promesa de pantalla que no se cumple

**Qué es.** El texto de un botón, una confirmación o una ayuda describe una consecuencia que no
ocurre. La persona actúa creyendo el texto.

**Dónde apareció.** «Anular» decía «el inventario que descargó se repone» y no creaba ningún
`inventory_move` (ADR-0061 §Contexto, que lo situaba en `DetalleFactura.tsx:636` cuando se escribió;
el texto y la conducta se corrigieron después, así que esa línea ya no existe). El Inicio mostraba
cero a quien vendía con recibos. Tres puertas para meter mercancía, cada una con su promesa
(ADR-0066). El botón «Registrarlo igual» de la llegada, que no podía funcionar por reusar la clave
de idempotencia con otro cuerpo (commit `fbdfd36`). El aviso «va a quedar en Sin asignar» que se
pintaba mientras la consulta cargaba (ADR-0067).

**Cómo detectarla.** Lee el texto de la pantalla y pregunta qué tendría que haber en la base
después; luego mira la base. Los textos a revisar primero: confirmaciones de acciones irreversibles
(anular, cerrar, emitir), ayudas bajo los campos, mensajes de éxito («quedó guardado», «se repone»,
«entra al libro»).

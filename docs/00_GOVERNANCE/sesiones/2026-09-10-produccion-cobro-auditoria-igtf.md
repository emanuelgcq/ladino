# Sesión 2026-09-10 → 11 — Datos de volumen, cobro más rápido, auditoría del frontend e IGTF

> **Para el Claude que retome esto en otra máquina.** Este documento es la
> conversación de esta sesión, curada: qué pidió el dueño, en qué orden, qué se
> hizo, qué se midió, qué salió mal y qué quedó pendiente. El resumen operativo
> corto está en `docs/00_GOVERNANCE/HANDOFF.md` (18ª entrega). La memoria de
> Claude de la máquina anterior está copiada en `docs/00_GOVERNANCE/claude-memory/`
> — léela primero; su `README.md` dice cómo restaurarla.
>
> **La transcripción cruda NO está en el repositorio a propósito**: contiene el
> token de gestión de Supabase y la contraseña de una cuenta con rol Dueño en
> producción. Todo lo útil de ella está aquí.

## Contexto de partida

Ladino está **en producción** desde 2026-09-07: web `app.ladinosystem.com`,
API `api.ladinosystem.com`, VPS Hostinger en Boston (`/opt/apps/ladino`),
base Supabase Cloud `udacvwnhwpsdzbouhqhl` (us-west-2). El dueño es
Emanuel Chirinos (`emanuelchirinos1@gmail.com`).

**Reglas del dueño que siguen vigentes, textuales:**

- «El VPS no se actualiza sin mi go» — nunca desplegar sin aprobación explícita.
- El token de gestión `sbp_…` **solo como variable de entorno de una orden**,
  jamás escrito en un fichero. **Rotación pendiente** (circuló en el chat).
- «Las claves y contraseñas las pego yo directo en nano» — los secretos del VPS
  los edita él.
- Nunca `git push --force`. Nunca tocar el contenedor n8n. Nada de
  `docker compose down` global, `system prune` ni `network rm`.
- Ninguna migración aplicada se edita.
- Sobre la optimización: «SI DUDAS, NO LO HAGAS», «El test es la verdad, tu
  cambio es el sospechoso», «Preferible quedarse en 6 s con todo intacto que
  bajar a 2 s rompiendo un invariante».

## Lo que pidió el dueño, en orden, y lo que se hizo

### 1. Terminar Declaraciones de IVA + IGTF (unidades U2–U5)

Migración 46 ya estaba aplicada. Commits `3e49142` → `c6d3727` (ADR-0052).
Detalle en la 17ª entrega de HANDOFF.

### 2. Datos de volumen para su usuario

Pedido: primero «10.000 registros por módulo», aclarado a **«300 productos y
2.000 ventas y todo lo que eso conlleva»**, sobre la empresa **«Ladino»**, y
después: «ponlo full con facturación, si es necesario cambiar algo cámbialo…
que verifiques que todo funciona correctamente».

Se sembró por la API real (no por SQL de documentos), como un usuario semilla
`seed-0dd23796@ladinosystem.com` con **exactamente los mismos 79 permisos** que
el dueño (roles Dueño + Operación de almacén). Sus credenciales viven solo en el
scratchpad de la máquina vieja. **Decisión pendiente**: ver HANDOFF.

Lo que el sembrado destapó, y cómo se resolvió:

- **Régimen fiscal**: la empresa estaba en `sin_facturacion`; pasar a
  `formatos_libres` chocó con `no_overlap` y luego con `period_chk`. Se le dio al
  viejo el rango mayo→junio y al nuevo junio→∞.
- **ROMPÍ LA FACTURACIÓN DE PRODUCCIÓN, brevemente.** Clonar `tax_rules` con
  fecha anterior pero la MISMA prioridad (5) dejó dos reglas válidas para hoy, y
  `resolve_tax` —correctamente— se negó a elegir. Afectó a las dos empresas. No
  se podían borrar (FK desde `document_lines`); se bajaron los clones a
  prioridad 1 y se verificó emitiendo (factura A-1190).
- **La trampa de la vigencia fechada, cuatro veces más**: régimen, precios,
  plantillas contables y `company_account_settings` nacían con
  `effective_from = now()`, y todo documento con fecha anterior no encontraba
  configuración y se iba a la cola. Se retrofecharon (precios por INSERT: son
  append-only). CLAUDE.md ya documenta este patrón tres veces.
- **`fetch` sin timeout en Node**: una renovación de token colgada bloqueó 8
  hilos del sembrado **13 horas**. `AbortSignal.timeout(60000)`.
- **Reintentar un 504 con una Idempotency-Key NUEVA puede cobrar dos veces**, y
  costaba 2 minutos por operación. Clave estable entre reintentos, y los 504 no
  se reintentan.
- **240 facturas quedaron emitidas sin su cobro** (el cliente vio timeout, el
  servidor había terminado). Se repararon leyendo el saldo REAL de cada una;
  verificado cero sobre-cobros.
- Un proceso zombi de la sesión anterior seguía facturando: se mató.

### 3. «Nada tiene paginación, para volúmenes altos se rompe»

Commit `7800281`: Productos e Inventario de consulta con `useInfiniteQuery`,
«Mostrando N de M» y «Mostrar más».

### 4. «El producto se guarda como borrador y deja poner precio: ¿y la lista de precios?»

Mismo commit: el producto **nace activo**; `createProductSimple` ya no hace el
`updateProduct` redundante. Dos tests que afirmaban `draft` se actualizaron y
se añadió uno que prueba la rama `draft` (más fuerte que antes).
`PRODUCTS_CATALOG_SPEC.md` actualizado.

### 5. «Quita que la caja guarde en cada consulta; solo manda con el carrito lleno»

Mismo commit: sincronización a la nube con espera de 4 s por carrito
(`pos-cuentas.ts`), vaciado al cambiar de pestaña y al desmontar.

### 6. «Revisa» → el mayor estaba vacío

2 asientos para 707 documentos: todo en la cola de ADR-0042 por la trampa de
fechas. **No existía camino para reprocesar la cola** pese a que su mensaje
decía «importa este pendiente». Se construyó: `reprocessPendingJournals`
(`fc808cc`) y la tarjeta con el botón **«Contabilizar los pendientes»** en
Administración → Contabilidad (`11af83e`).

### 7–8. El 504 y el análisis de viajes (sin código)

Explicación: el cobro hace cientos de viajes secuenciales VPS (Boston) ↔ base
(us-west-2, ~75 ms cada uno). Se contaron viajes reales citando fichero y línea
y se evaluaron palancas.

### 9. Optimización de viajes, dos fases, con reglas duras

Línea base registrada: `VERIFY EXIT=0`, 607 pasos turbo, 641 tests vitest,
pgTAP 43 ficheros / 1.051 tests.

- **Palanca 1 (pipelining con `Promise.all`) — MUERTA, medida y revertida**:
  postgres.js serializa dentro de una transacción (217 ms vs 226 ms). El dueño:
  «La medición manda sobre mi premisa… bien hecho».
- Palanca 3: líneas de documento en UNA sentencia (`jsonb_to_recordset`) —
  `688be35`.
- Palanca 5: acta de auditoría + evento outbox en una CTE — `88dc06f`.
- Palanca 4: papeles contables resueltos una vez, líneas de asiento en una
  sentencia — `3a3f501`.
- Fase 2: salida de kardex del carrito entero en un lote (`issueStockBatch`,
  un bloqueo multi-posición con orden determinista, costeo encadenado en
  memoria, oráculo LAD41 intacto) — `a32811c`, con `kardex-lote.test.ts`.
- Medidor de desglose de sentencias — `00ede7e`.

**Resultado: 140 → 94 viajes por venta (−33 %).** Latencia remota medida 3
veces contra producción (con el código VIEJO del VPS): emisión ~16 s + cobro
~9,5 s. Lo que sigue: **5 pares begin/commit por venta** (15 sentencias, 16 %).

### 10. Comandos del VPS y `REQUEST_TIMEOUT_MS`

Se le dieron al dueño. **El VPS sigue sin actualizarse** (ver HANDOFF).

### 11. «Verifica todo el frontend… cada botón… screenshots… diálogos… arréglalo»

Pedido textual: «necesito que cada botón que se deba utilizar en el backend
para alguna acción que permita el sistema exista en el frontend como tiene que
ser. Necesito que tomes screenshot de todo, pantallas, interactuar con
diálogos, botones, etc. y verifiques todos los errores de visualización», y
«lo ideal sería que lo hagas de mi usuario».

- **Cobertura estática**: 172 endpoints de `openapi.json` contra todo
  `apps/web/src` → 164 cubiertos. El único hueco propio se cerró: marcar la
  empresa como sujeto pasivo especial desde IGTF (`abac189`). Quedan 7 sin UI
  (lista en HANDOFF).
- **Auditoría visual** de 22 pantallas y los diálogos de 12, con Playwright,
  contra la API viva y como el usuario semilla. **Once defectos**, todos
  re-medidos en el DOM después del arreglo — `0088828`:
  interruptor sin `display` (se pintaba como punto o como dos rayitas); tabla
  virtualizada del libro fiscal escribiendo columnas encima de sí mismas; cifras
  del panel cortadas a media cifra; un `null` rojo en Declarar IVA e IGTF; la
  caja estirada a 3.870 px con «Cobrar» al fondo; la columna Cliente en «—»
  (mapa truncado a 100 **y** caché de TanStack por fila); contadores de
  inventario sobre 100 de 300; existencias de admin sin paginación; pasos de la
  puesta a punto en orden 2-4-5-1-3; un pie que explicaba un gráfico ausente.
- Los diálogos: sin defectos reales. Falsos positivos descartados uno a uno
  (inputs ocultos de 1×1 de Base UI; «Nueva orden» y «Asiento manual» son
  pestañas).

### 12. «Cambio de pestaña y me refresca la página… cargando empresas, cargando permisos»

Causa: supabase-js corre `_recoverAndRefresh()` al volver a la pestaña y emite
`TOKEN_REFRESHED` con un objeto de sesión nuevo; el provider colgaba sus
efectos de la identidad de ese objeto y ponía los permisos a `null` = pantalla
completa «Cargando permisos…». **Control medido**: con el código viejo, una
renovación = `/v1/companies` + 2× `/v1/me/permissions` + la pantalla; con el
arreglo, nada. También `refetchOnWindowFocus: false`. Commit `f56d239`.

### 13. IGTF a 8 decimales → ADR-0053 + migración 47

Hallazgo: de 166 percepciones en producción, **160** tenían más de 2 decimales
(se cobraba USD 1,0635). El dueño eligió «redondear a 2, con ADR y migración».
Ver ADR-0053. Puntos clave:

- Escala = minor units ISO-4217 de la moneda (decidido por la spec, no fiscal);
  modo `HALF_UP` con nombre propio `MODO_IGTF` — **VALIDAR-SENIAT**.
- Una sola regla en el dominio (`percibirIgtf` / `avisoIgtf`): el aviso de la
  caja y el cobro no pueden discrepar.
- Migración 47 añade `rounding_policy_id` con un **default de transición**
  (`igtf:perception:8:HALF_UP`) para que se pueda aplicar ANTES de desplegar la
  API nueva sin romper los cobros de la API vieja. Las 166 filas históricas
  quedan con la regla que de verdad se les aplicó.
- Sistémico: **13 de 1.210 documentos** también tienen totales con más de 2
  decimales (`sales:document:8:HALF_UP`). Mismo tipo de pregunta para el asesor.

### 14. «Utilidad estimada» = «Ventas del mes»

Diagnóstico: **1.527 asientos en cola** (754 facturas, 673 cobros, 99
percepciones) por cuentas no configuradas en su momento; hoy vigentes desde el
1-may. El dueño eligió **«todavía no»** reprocesar. El botón existe.

### 15. «Pushea todo y hazme un .md para cambiar de PC»

Este documento, la 18ª entrega de HANDOFF y la copia de la memoria.

## Errores míos en esta sesión (para no repetirlos)

- Concluí que el VPS «no estaba actualizado» sondeando sin token (todo daba
  401). Con token real, `/v1/igtf/status` respondía 200. Sondear con token.
- Rompí la emisión de facturas con reglas fiscales clonadas de igual prioridad.
- Di por arreglada la columna Cliente cuando solo había arreglado el mapa: la
  medición lo desmintió. Medir antes de afirmar.
- Mi primer detector de endpoints tenía 135 falsos positivos (el glob de bash
  no era recursivo). Lo reescribí en Node.
- Una prueba de `visibilitychange` sin `bubbles` «pasó» sin probar nada. Se
  comprobó con un control (volver al código viejo y ver fallar la prueba).
- Con la migración 47, el primer `verify` falló en los E2E porque el paso 5
  corre antes de que el paso 10 aplique la migración. `pnpm db:reset` primero.

## Herramientas que se usaron (no están en el repo)

Scripts de la carpeta scratchpad de la sesión: sembrado por fases
(`fase1…fase7`), reparación de cobros, auditoría visual, auditoría de
diálogos, diagnósticos del DOM, prueba de renovación de token, medidor remoto.
**No se commitean porque llevan la contraseña de la cuenta semilla.** La receta
para rehacerlos está en `claude-memory/auditoria-visual-contra-produccion.md`.

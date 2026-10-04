# Registro de riesgos

| Riesgo | Severidad | Mitigación |
|---|---:|---|
| Interpretación Art. 8.3 PA121 respecto a dispositivos no homologados | Crítica | VALIDAR-SENIAT antes de POS/mobile fiscal |
| Cambio fiscal requiere nueva homologación | Crítica | release train fiscal aislado |
| Dependencia de imprenta digital | Alta | adapter + proveedor secundario si es viable |
| Caída de internet | Alta | plan de contingencia conforme PA102 |
| Errores de redondeo | Alta | decimal + tests golden |
| RLS incorrecta filtra tenant | Crítica | pruebas automáticas de aislamiento |
| Claude sugiere asiento/impuesto incorrecto | Alta | aprobación humana + motor determinista |
| Actualización móvil no coordinada | Alta | feature flags y compatibilidad de protocolo |
| Secuencias duplicadas | Crítica | asignación transaccional/locking |
| Pérdida de audit logs | Crítica | append-only + backup + hash |
| Hostinger sin SLA suficiente para fiscal | Alta | evaluar plan/arquitectura y failover |
| Norma tributaria cambia | Alta | tax rules versionadas |

## Deuda técnica abierta

Riesgos concretos con dueño, disparador y momento en que dejan de ser aceptables. No viven en el
handoff de una sesión: aquí, hasta que se cierren.

### R-01 · `allocate` rechaza pesos negativos

- **Severidad:** Alta · **Disparador:** primera nota de crédito con línea de descuento
- **Dónde:** `packages/money/src/rounding.ts` → `allocate`, error `MONEY_INVALID_WEIGHTS`

Una nota de crédito que revierte una factura con descuento produce un vector de pesos de **signo
mixto**, y hoy `allocate` lo rechaza de plano. Quien se lo encuentre tendrá la tentación de
repartir a mano, que es exactamente el camino por el que se pierde un céntimo y se descuadra un
asiento (invariante 10 de `06_QA/ACCOUNTING_INVARIANTS_TESTS.md`).

**Decisión pendiente:** ¿se admiten pesos de signo mixto en `allocate`, o el descuento se modela
como una línea aparte con su propio reparto? Lo segundo es más limpio contablemente pero obliga a
`packages/fiscal` a orquestar dos repartos y a cuadrarlos entre sí.

**Deja de ser aceptable:** antes de la primera emisión de nota de crédito en `packages/fiscal`.
No bloquea S0.3 ni S0.4.

### R-02 · `ResidualAllocation` sin implementar

- **Severidad:** Media · **Disparador:** respuesta del asesor a `MONEY_AND_ROUNDING_SPEC.md` §6.3
- **Dónde:** `packages/money/src/rounding.ts` → `allocate`

`allocate` reparte por **mayor resto**, que no es ninguno de los cuatro modos que la spec enumera
(`FIRST_LINE`, `LAST_LINE`, `LARGEST_LINE`, `PROPORTIONAL`). Con pesos iguales degenera en
`FIRST_LINE` y por eso no se notaba; con pesos `[1, 2]` sobre 0.10 el céntimo cae en la **segunda**
línea.

El comentario del código afirmaba `FIRST_LINE` y era falso — lo detectó la auditoría de
invariantes, no la suite. Ya está corregido en el código; lo que falta es el parámetro.

**Bloqueado por:** `VALIDAR-TRIBUTARIO` de §6.3, donde el asesor decide qué línea absorbe el
residuo. No tiene sentido implementar cuatro modos antes de saber cuál se exige.

**Deja de ser aceptable:** cuando §6.3 se responda, o antes si `packages/fiscal` necesita un modo
distinto del actual.

### R-07 · Quien tenga las credenciales de infraestructura no pasa por ninguna defensa

- **Severidad:** Crítica · **Dueño:** responsable del proyecto (es control operativo, no de código)
- **Disparador:** existe desde que hay un proyecto Supabase remoto — es decir, desde S0.6
- **Dónde:** fuera del código. Relacionado con ADR-0030 y `EXPEDIENTE_TECNICO.md` §Advertencia

Todo lo construido en S0.3 y S0.4 —RLS con `FORCE`, privilegios por columna, `reject_mutation()`,
las anclas inmutables, el acceso acotado del operador de ADR-0030— **gobierna el acceso por la
aplicación**. Nada de eso aplica a quien se conecta directamente a la base con las credenciales del
proyecto.

Concretamente, con acceso directo se puede: leer cualquier tabla de cualquier tenant (`BYPASSRLS`),
**desactivar los triggers** (`ALTER TABLE ... DISABLE TRIGGER`) y con ellos toda la inmutabilidad,
y reescribir `audit_events` sin dejar rastro — porque `payload_hash` es una columna generada que se
recalcula con la fila (ADR-0026 D1).

**No es un defecto de diseño ni se arregla con más SQL.** Es la frontera de lo que la aplicación
puede garantizar, y va escrita porque el riesgo real es el contrario: que la solidez de los
controles de aplicación haga *creer* que este flanco está cubierto. ADR-0030 acota al operador
dentro de la aplicación; no le quita las llaves del servidor.

**Mitigación, y es toda operativa:** separación de credenciales de infraestructura de las de
operación diaria; acceso al proyecto con MFA y sin credenciales compartidas; registro de acceso del
proveedor; y —lo único que da detección real— **copia de la pista de auditoría fuera de la misma
base**, que es también lo que hace verificable la cadena diferida de ADR-0026 D1.

**Deja de ser aceptable:** cuando exista el proyecto remoto con datos de un cliente real. Hasta
entonces solo hay una base local.

### R-15 · Cambiar una receta no revalúa lo ya vendido, y eso es correcto pero confunde

- **Severidad:** Baja · **Dueño:** quien construya el reporte de márgenes
- **Disparador:** el primer reporte de rentabilidad por plato
- **Dónde:** `product_recipes`, `inventory_moves` (migración 20); ADR-0035

Una receta es una **definición vigente**, no un hecho histórico: se edita, y `product_recipes` no
guarda vigencia por fecha (a diferencia de `price_list_items`, que sí). Los consumos ya registrados
conservan su costo real —salieron las cantidades de entonces— así que el kardex es correcto; pero
si alguien cambia la receta y luego compara «costo teórico × unidades vendidas» contra el costo
real del mes, los números no cuadrarán y **el sistema no podrá explicar por qué**: no queda rastro
de qué receta estaba vigente en cada venta.

**Mitigación cuando duela:** o versionar `product_recipes` por vigencia como se hizo con los
precios (ADR-0032), o guardar en el consumo una copia de la receta aplicada. La segunda es más
barata y sigue el patrón R-05 (el documento copia, no referencia).

**Deja de ser aceptable:** cuando exista un reporte de rentabilidad por producto que alguien use
para tomar decisiones de precio.

### R-13 · Una posición en negativo puede quedar con valor residual que nadie regulariza

- **Severidad:** Media · **Dueño:** quien construya el cierre contable de inventario
- **Disparador:** la primera empresa que active `allow_negative_stock`, o el módulo de conteos
- **Dónde:** `stock_balances`, `platform.apply_inventory_move()` (migración 19); ADR-0034

Con existencia negativa permitida, una salida saca todo el valor y valora el exceso al promedio
vigente. Cuando entra la mercancía que faltaba, el valor de la posición puede quedar **negativo o
descuadrado respecto de la cantidad**: el kardex sigue cuadrando (valor = Σ movimientos, exacto, y
`stock_reconciliation` da cero), pero el costo unitario deja de tener sentido y se arrastra el
último conocido en vez de recalcularse — decisión deliberada de ADR-0034 para no persistir jamás
un costo unitario negativo. El residuo queda **visible** en el valor, no escondido.

**Lo que falta:** un ajuste de SOLO VALOR (sin cantidad) que lo regularice contra una cuenta de
diferencias, con su asiento. Hoy no existe: `adjustStock` mueve cantidad, y todo ajuste con delta
cero se rechaza. Mientras tanto la única mitigación es la que ya está: el negativo exige política
de empresa **y** permiso acotado, así que no ocurre por accidente.

**Deja de ser aceptable:** cuando exista el cierre contable que lleve el inventario valorado al
libro mayor (invariante 8 de `ACCOUNTING_INVARIANTS_TESTS.md`), porque ahí el residuo tendría que
tener contrapartida.

### R-14 · `inventory.negative` puede concederse a un rol sin que nadie lo revise

- **Severidad:** Media · **Dueño:** quien construya la administración de roles
- **Disparador:** la pantalla de gestión de roles y permisos
- **Dónde:** `permissions` (migración 19), `role_permissions`; ADR-0025 §4

`inventory.negative` es el permiso que convierte «imposible» en «posible» para el descuadre de
existencias. Es acotado y exige además la bandera de empresa, pero **nada obliga a que su
concesión pase por una revisión distinta de la de cualquier otro permiso**: quien pueda editar
roles puede dárselo a sí mismo si también tiene `role.manage`.

**Mitigación posible cuando exista la pantalla:** marcarlo como permiso sensible (junto con
`period.reopen`, `journal.reverse` y `customer.tax_id.manage`), exigir un segundo aprobador para
concederlo, y auditar la concesión como hecho propio. Hoy la concesión ya deja fila en
`audit_events` por la vía general, pero no se distingue de conceder `warehouse.read`.

**Deja de ser aceptable:** en cuanto haya más de un usuario por tenant en producción.

### R-12 · Cliente y proveedor son dos maestros: el mismo RIF puede divergir entre ambos

- **Severidad:** Media · **Dueño:** quien construya el módulo de proveedores
- **Disparador:** **el módulo de proveedores** (H-2 y H-13 del plan de clientes, 2026-08-26)
- **Dónde:** `customers` (migración 18); `suppliers` (no existe); `DATABASE_SCHEMA` ER

Las specs modelan `customers` y `suppliers` como entidades hermanas sin un «tercero»/`party`
común (`DATABASE_SCHEMA` ER, endpoints separados, campos asimétricos). Cuando la misma
contraparte compre y venda a la empresa, tendrá dos filas con razón social, RIF y domicilio
duplicados que pueden **divergir** — y los documentos fiscales copian esos datos (R-05), así que
una factura de venta y una de compra a la misma contraparte podrían llevar nombres distintos.

**Decisión pendiente, no tomada en clientes a propósito:** (a) `parties` con roles cliente/
proveedor y una sola identidad fiscal, o (b) dos maestros con una comprobación cruzada por RIF al
alta (aviso, no bloqueo). Decidir ANTES de escribir `suppliers`: después, unificar es migración
de datos con historial.

**Deja de ser aceptable:** con la primera fila de `suppliers`.

### R-08 · `published` en el outbox NO significa «recibido por el SENIAT»

- **Severidad:** Alta (de interpretación, no de dato) · **Dueño:** quien construya Fase 11
- **Disparador:** el primer panel, informe o conversación que cuente «eventos publicados»; y
  el día que exista un régimen al que transmitir
- **Dónde:** `apps/worker/src/main.ts` (monta `NullTransmitter`), `packages/fiscal/src/transmitter.ts`,
  `REGULATORY_STATUS.md` §3, `infra/README.md`

Con `NullTransmitter` —la implementación correcta mientras la PA 121 esté derogada sin sustituta
(ADR-0028)— **todo evento fiscal queda `published` sin haberse transmitido a nadie**. `published`
significa «el consumidor lo procesó», y el consumidor es el nulo. Es el riesgo que **alguien va a
malinterpretar en Fase 11**: verá una cola en verde y creerá que hay remisión.

**Mitigación:** escrito en tres sitios; el log `seniat.null_transmitter` por cada evento; y la
regla de que el adaptador real, cuando exista, **no reutilice `published`** para «aceptado por el
SENIAT» sin un `fiscal_event` con la respuesta (apps/worker/CLAUDE.md).

**Deja de ser aceptable:** el día que exista un régimen vigente. Ese día el estado «publicado»
tiene que distinguir «entregado al adaptador» de «acuse recibido», y eso es una migración.

### R-09 · El rate limit de la API vive en memoria de UNA réplica

- **Severidad:** Media · **Dueño:** quien despliegue la segunda réplica
- **Disparador:** **la segunda réplica de `ladino-api`** (o cualquier balanceo entre procesos)
- **Dónde:** `apps/api/src/middleware/rate-limit.ts`

El límite por usuario (300/min, `429 RATE_LIMITED`) es una ventana fija en un `Map` del proceso.
Con dos réplicas, cada una cuenta la mitad: el límite efectivo se duplica sin que nadie cambie
nada, y el `Retry-After` de una réplica no sabe lo que vio la otra. Hoy hay UNA réplica, y un
contador compartido (Redis) sería infraestructura nueva para un problema que no existe.

**Mitigación:** el contrato (429 + `Retry-After`) no cambia; cambia ese fichero. El límite laxo
por IP de Traefik sí es común a las réplicas.

**Deja de ser aceptable:** antes de `deploy.replicas: 2` o de un segundo host.

### R-10 · ~~`apps/worker/src/main.ts` no tiene test~~ **CERRADO (2026-09-01)**

Cerrado exactamente con la mitigación que este riesgo dictaba: la máquina del bucle vive en
`apps/worker/src/loop.ts` con `ciclo`, `latir`, `salir`, `dormir` y el reloj inyectados, y
`loop.test.ts` prueba las cinco frases — latido SOLO tras vuelta sana, vuelta rota no late,
`salir(1)` al 5.º fallo seguido, un éxito reinicia el contador, un ciclo colgado cae por el
plazo, y `parar()` termina sin salida forzada. `main.ts` quedó como cableado puro (sql real,
fichero de latido real, `process.exit` real). 19 tests en el worker.

### R-11 · `pnpm verify` en la máquina de desarrollo solo pasa con `TURBO_CONCURRENCY=1`

- **Severidad:** Baja (operativa) · **Dueño:** responsable del proyecto
- **Disparador:** cualquier sesión que corra `verify` sin la variable; y CI, que NO tiene este
  problema pero tampoco lo detecta
- **Dónde:** la máquina, no el repo. `HANDOFF.md` §Estado

Con ~2 GB libres (Docker Desktop y un stack Supabase de OTRO proyecto levantado junto al de
Ladino), turbo a concurrencia por defecto muere con `VirtualAlloc failed` / exit `-1073740791`.
No es un fallo de código; parece uno, y en S0.6a costó tres intentos distinguirlo.

**Mitigación:** `TURBO_CONCURRENCY=1 pnpm verify`; no lanzar `docker build` ni subagentes
pesados a la vez. Los contenedores ajenos no se paran desde una sesión.

**Deja de ser aceptable:** si aparece en CI. Ahí sería un fallo real de memoria del pipeline.

### R-06 · Norma sustituta desconocida

- **Severidad:** Alta · **Dueño:** responsable del proyecto (decisión de negocio y seguimiento
  regulatorio; la ingeniería no puede resolverlo)
- **Disparador:** publicación de una nueva providencia administrativa del SENIAT en el ámbito que
  ocupaba PA SNAT/2024/000121
- **Dónde:** `docs/02_COMPLIANCE/REGULATORY_STATUS.md` §3 · ADR-0027 · ADR-0028

PA SNAT/2024/000121 fue derogada el 12/08/2026 por PA SNAT/2026/00084 (Gaceta 43.435) **sin norma
sustituta**. Se espera normativa nueva con estándares técnicos y protocolos de comunicación. **No
está publicada**: no hay borrador, ni fecha, ni alcance confirmado.

El riesgo no es que llegue una norma nueva —eso es lo esperable— sino **el vacío mientras tanto**,
que empuja en dos direcciones opuestas y las dos malas:

1. **Anticipar.** Implementar contra lo que "seguramente pedirá", normalmente por parecido con la
   121. Es inventar una obligación legal sin fuente, que `CLAUDE.md` §2 prohíbe, y sale caro dos
   veces: se construye lo que no se necesita y luego hay que deshacerlo.
2. **Desmontar.** Retirar controles ahora que nadie los exige — append-only, versionado de reglas,
   pista de auditoría. Reconstruirlos después, con datos productivos dentro, cuesta un orden de
   magnitud más. *Ausencia de obligación no es autorización* (ADR-0027 §4).

**Mitigación, ya aplicada:** ADR-0027 (la regulación entra como dato versionado, nunca como
estructura de código: una norma nueva es un adaptador más una migración) y ADR-0028 (la
transmisión se diseña como consumidor de outbox tras interfaz, con `NullTransmitter` por defecto,
de modo que enchufar un protocolo no toca el dominio).

**Qué vigilar concretamente:** publicación en Gaceta Oficial en el ámbito de sistemas de
facturación; si reintroduce homologación previa, se reabren **tal cual** los seis `VALIDAR-SENIAT`
marcados resueltos por derogación en `REGULATORY_STATUS.md` §5 y el `VALIDAR-SENIAT` tachado de
ADR-0003 — están tachados y no borrados exactamente por esto.

**Deja de ser aceptable:** nunca, mientras no haya norma. Es un riesgo de entorno, no de deuda: no
se cierra trabajando, se cierra cuando el Estado publica. Lo que sí se puede exigir es que la
respuesta cueste un adaptador, y de eso responden ADR-0027 y ADR-0028.

### R-05 · Los documentos fiscales deben COPIAR el RIF del emisor, no referenciarlo

- **Severidad:** Crítica · **Dueño:** quien cree la primera tabla de documentos fiscales en `packages/fiscal`
- **Disparador:** la primera migración de la Fase 11 que cree una tabla de documentos emitidos
- **Dónde:** Fase 11 · relacionado con `supabase/migrations/20260811190652_guard_company_tax_id.sql`

**La decisión ya está tomada, lo que falta es aplicarla:** el RIF de un documento fiscal es el
**vigente al emitir**, no el actual de la company. La migración de M4 lo deja escrito y S0.4 no
puede hacer más, porque no existe todavía ninguna tabla de documentos.

El fallo que esto evita es silencioso y grave. Si el RIF del emisor se resuelve con un `JOIN`
contra `companies` al imprimir o al declarar, entonces **un solo `UPDATE` sobre `companies.tax_id`
reescribe retroactivamente el contribuyente de todos los documentos ya emitidos**. Un documento
inmutable que cambia de emisor sin que se toque una sola fila del pasado: es editar el pasado por
la puerta de atrás, y contradice la regla 1 de `CLAUDE.md` sin violar ni una línea de su letra.

**Requisito concreto: el SNAPSHOT COMPLETO, no solo el RIF.** `FISCAL_DOCUMENTS_SPEC.md`
§«Identidad fiscal congelada» ya enumera **diez** elementos a copiar al emitir, y una versión
anterior de este riesgo nombraba uno solo. Quien lo cerrase añadiendo `issuer_tax_id` marcaría el
riesgo resuelto con nueve agujeros abiertos:

razón social · RIF · domicilio · datos del cliente · líneas · tasas · moneda y tasa de cambio ·
serie y secuencia · imprenta digital · versión fiscal del software.

A esa lista hay que sumar la **versión de reglas** con la que se calcularon las tasas, que es por
lo que `rules_version` ya es columna en `audit_events` desde S0.4.

**Dos huecos concretos, detectados en la auditoría de cierre de S0.4:**

- **`legal_name` está hoy en estado pre-M4.** `authenticated` conserva `UPDATE` sobre esa columna
  y ningún trigger lo audita: la razón social se puede reescribir sin rastro. **Decisión tomada:
  se trata en Fase 11 con el snapshot completo**, no con un trigger suelto ahora. Es menos grave
  que el RIF —no identifica al contribuyente— pero no es inocuo, y va aquí para que no se pierda.
- **`companies` no tiene columna de domicilio fiscal**, que PA 102 Art. 7 exige en la factura. No
  es todavía un problema de congelación: es un campo obligatorio que aún no existe en el modelo.

Con `audit_events` ya se puede reconstruir la cadena de cambios de RIF (M4 registra el valor
anterior, y desde la migración 5/5 también el alta), pero reconstruir a posteriori qué RIF tenía
la company el día de cada emisión es trabajo forense — y ante una fiscalización, trabajo forense
es lo mismo que no tenerlo.

**Deja de ser aceptable:** en el momento en que exista la primera tabla de documentos fiscales.
Añadir la columna después obliga a rellenarla por inferencia sobre documentos ya emitidos, que es
exactamente lo que no se puede hacer.

### R-04 · No existe la lista de qué se audita

- **Severidad:** Alta · **Dueño:** quien escriba el primer caso de uso de dominio (`packages/domain`)
- **Disparador:** el primer `EVENT_CATALOG.md` con eventos reales, o el primer caso de uso que
  llame a `writeAuditEvent` — lo que ocurra antes
- **Dónde:** `docs/04_PLATFORM/EVENT_CATALOG.md` y `audit_events.event_type`

S0.4 entrega el **mecanismo** de auditoría; no entrega la **política**. Cuatro documentos exigen
auditar las "acciones críticas" (`AUDIT_TRAIL_AND_IMMUTABILITY.md`, `DEFINITION_OF_DONE.md:13`,
`PRODUCT_REQUIREMENTS.md:86`, `NOTIFICATIONS_WORKFLOWS_SPEC.md:18`) y **ninguno define
"crítica"**. Tampoco está decidido si se auditan **lecturas**, que `PRIVACY_AND_DATA_GOVERNANCE.md:15`
exige para RRHH y fiscal y ningún otro documento contempla.

El diferimiento es deliberado y está en ADR-0026 (D10): una lista de eventos escrita antes de que
exista un solo caso de uso sería adivinación. Pero **un diferimiento sin dueño es un olvido con
buena redacción**. Sin este registro, "se decide con `EVENT_CATALOG`" se descubre sin decidir en
la Fase 11, con la emisión fiscal encima y sin margen para discutirlo.

Mientras tanto la tabla no se queda indefensa: `event_type` lleva un `CHECK` de forma
(`^[a-z_]+\.[a-z_]+$`) que impide que el campo degenere en texto libre antes de que exista el
catálogo. Restringir a un conjunto cerrado de valores es fácil después; recuperar seis meses de
`event_type` inventados sobre la marcha, no.

**Deja de ser aceptable:** cuando `packages/domain` tenga su segundo caso de uso. Con uno se puede
argumentar que el catálogo se deduce; con dos ya hay divergencia.

### R-03 · `decimal.js` redondea en silencio más allá de 50 dígitos significativos

- **Severidad:** Media · **Disparador:** una cadena larga de operaciones sobre `ExactMoney`
- **Dónde:** `packages/money/src/decimal.ts` → `LadinoDecimal`, y `ExactMoney` en general

El clon trabaja a 50 dígitos significativos. Una secuencia de operaciones que los supere **pierde
precisión sin avisar**: la auditoría comprobó que `(max × 10^30) + 0.00000001` menos el original
da exactamente `0`. El céntimo desaparece.

`ExactMoney` no tiene cota de magnitud (deliberado, ADR-0023), así que nada hace improbable llegar
ahí. No hay test ni guardia.

**Mitigación posible:** una comprobación de dígitos significativos en las operaciones de
`ExactMoney`, o una cota de magnitud que lo haga inalcanzable. Las dos tienen coste y ninguna es
obviamente correcta.

**Deja de ser aceptable:** cuando `packages/accounting` o `packages/inventory` encadenen
operaciones sobre intermedios (valoración de inventario, prorrateos anidados). Hoy no hay
consumidores.

### R-22 · El layout oficial del libro no está cargado: se exporta un CSV que NO es el fichero de presentación

- **Severidad:** Alta · **Disparador:** aparece la norma con el layout, o el asesor lo aporta
- **Dónde:** `public.book_format_adapters`, `packages/domain/src/fiscal-books.ts` →
  `ADAPTADORES_IMPLEMENTADOS`, ADR-0044 §5

El único adaptador sembrado es `csv_columnas_legales`, marcado `is_official = false`. Trae las
columnas que el Reglamento de la LIVA (Decreto 206, arts. 70 a 78) exige en los libros —la PA 00071
regula la factura, no el libro (L-11, migración 20260928180200)— **nombran** —entregable hoy a un contador para revisión y
archivo— pero **no es el fichero que la administración tributaria exige**, y ese layout no está en
el repositorio. Inventarlo a partir de ejemplos de internet sería inventar una obligación legal
(CLAUDE.md §2), y un archivo con el layout equivocado se rechaza entero.

**Lo que ya está defendido:** la exportación de un adaptador presente en el catálogo pero sin
implementación falla con **LAD65** y no escribe la generación; la pantalla lo deshabilita. El E2E
carga un adaptador falso a propósito para que ese camino no sea código muerto. O sea que el riesgo
no es que se exporte un fichero equivocado creyendo que es el bueno: es que **hoy no hay forma de
presentar por el canal oficial desde Ladino**.

**Cuando llegue:** es una fila más y otra implementación de la misma interfaz — un enchufe, no una
reescritura. Se añade a `book_format_adapters` con `is_official = true` **y** a
`ADAPTADORES_IMPLEMENTADOS`, en ese orden, y nunca solo lo primero.

**Deja de ser aceptable:** ante el primer cliente contribuyente especial que tenga que presentar
por el canal oficial. **No bloquea operar**: el libro se consulta, se concilia y se exporta para el
contador desde hoy.

### R-23 · IGTF no aparece en ningún libro porque Ladino no lo calcula en ninguna parte

- **Severidad:** Alta · **Disparador:** se construye el módulo de IGTF
- **Dónde:** ausencia deliberada en `platform.sales_book` / `purchases_book`, ADR-0044
  §Consecuencias

No hay columna de IGTF en los libros, y no la hay porque **no hay motor**: ningún caso de uso lo
calcula, no existe su tabla de reglas y `IGTF_SPEC.md` advierte además de que **no toda operación
en divisa lo causa**. Una columna hoy tendría que rellenarse con algo, y ese algo sería inventado.

El orden correcto es el de ADR-0038 y ADR-0039: primero la regla como dato con su fuente citada,
después el cálculo, después la columna del libro. Al revés se obtiene un libro que declara una
cifra que nadie puede justificar.

**Ojo al construirlo:** el IGTF de una venta afecta al libro de ventas del período en que se
percibió, no al de la emisión de la factura. Añadirlo como columna de la fila del documento sin
mirar eso repetiría el error que ADR-0044 §1 vino a arreglar.

**Deja de ser aceptable:** cuando el primer cliente opere cobrando en divisas y tenga que
declararlo. **No bloquea operar** ni la emisión: hoy Ladino simplemente no participa en ese
impuesto y no aparenta hacerlo.

### R-24 · `operation_type` queda sin clasificar para el cliente no domiciliado y el proveedor extranjero

- **Severidad:** Media · **Disparador:** el asesor confirma la regla de clasificación
- **Dónde:** `packages/domain/src/sales.ts` y `purchases.ts` (marcados `VALIDAR-SENIAT` en el
  punto donde se aplica), columna `operation_type` de las dos tablas de líneas

El gancho de emisión escribe `interna` cuando el cliente **no** es `no_domiciliado` y cuando el
proveedor **es** `nacional`. En los dos casos contrarios deja **NULL**, porque Ladino no implementa
el régimen de exportación ni el de importación y **escribir «interna» sobre una operación que quizá
no lo es, en un libro que se entrega al fisco, es declarar mal**.

Que el cliente sea no domiciliado no basta para concluir exportación, ni que el proveedor sea
extranjero para concluir importación: son indicios, no la regla. Derivarla sin fuente citada
entraría de lleno en la prohibición de inventar obligaciones legales.

**Lo que ya está defendido:** la columna existe, es nullable, y ningún libro reparte el NULL en una
categoría que no le toca. El resto del snapshot —categoría y tratamiento— sí se congela en esas
operaciones, así que la base sale bien clasificada por naturaleza aunque el tipo de operación falte.

**Deja de ser aceptable:** ante el primer cliente que exporte o importe y tenga que presentarlo.
**No bloquea operar** ni distorsiona ninguna cifra: hoy `operation_type` no alimenta ninguna columna
del libro; está capturado para cuando la regla exista.

### R-25 · El segmento retail-consumidor-final con volumen requiere máquina fiscal y Ladino no la tiene

- **Severidad:** Alta · **Disparador:** el primer prospecto de ese perfil
- **Dónde:** PA 00071 art. 8 (las tres condiciones concurrentes: >1.500 UT del año anterior +
  operaciones mayoritarias con consumidor final + actividad listada; el literal j obliga sin
  importar el ingreso) · `EMISION_FACTURAS.md` §2

Un negocio obligado por el art. 8 **no puede** facturar por formas libres, y el art. 49 le
prohíbe además los documentos previos. Ladino no imprime por máquina fiscal: para ese perfil,
hoy no hay emisión legal desde Ladino.

**Lo que ya está defendido:** `/empezar` pregunta a quién le vende y si tiene máquina; al perfil
de mostrador le muestra la advertencia del art. 8 remitiendo al contador, y al que tiene máquina
lo deja en modo **administrativo sin emisión** — todo Ladino menos emitir factura, sin bloquear
el resto (la tercera modalidad del producto, documentada en `EMISION_FACTURAS.md` §1).

**Deja de ser aceptable:** cuando el primer prospecto de ese perfil aparezca. Mitigación en ese
momento: venderle el modo administrativo y **adelantar la Fase 12** (integración de máquina
fiscal) en el roadmap.

### R-26 · La vía de emisión digital depende de una imprenta digital autorizada, que es externa

- **Severidad:** Media · **Disparador:** el primer cliente que pida la vía digital (PA 102)
- **Dónde:** ADR-0045 (`DigitalPrintShopAdapter`, `NullDigitalPrintShop`) · ADR-0037
  (`per_document`, deshabilitado) · `EMISION_FACTURAS.md` §4

El número de control de la vía digital lo asigna un tercero documento a documento. Ladino tiene
el **contrato** y el modo de numeración modelados, pero la implementación exige elegir un
proveedor de la **lista de imprentas digitales autorizadas vigente** — lista que no está en el
repo y no se inventa (VALIDAR-SENIAT).

**Lo que ya está defendido:** el puerto rechaza con mensaje claro en vez de fingir; ningún
régimen `per_document` puede habilitarse mientras el adaptador sea el null; la contingencia
(migración 35) ya modela la rama «la imprenta no responde».

**Deja de ser aceptable:** con el primer cliente que la pida. Mitigación: conseguir la lista
vigente, elegir proveedor (decisión del operador) y escribir el adaptador real contra ADR-0045.

### R-27 · Un contribuyente inscrito podría declararse «sin RIF» para vender por recibo y evadir

- **Severidad:** Media · **Disparador:** auditoría o fiscalización de un cliente en modo recibos
- **Dónde:** migración 37 (`sin_facturacion`, gate de kind por régimen en
  `assert_document_issuance`) · `EMISION_FACTURAS.md` §1-bis

El modo recibos existe para el negocio que AÚN no tiene RIF. Un inscrito que se declare «sin
RIF» en /empezar vendería sin repercutir IVA y sin libros — evasión con la herramienta puesta.

**Lo que ya está defendido:** la regla dura de kind por régimen vive en el ESQUEMA (LAD49):
con régimen fiscal no se emite ni un recibo, y cambiar a `sin_facturacion` desde un régimen
fiscal NO existe como transición (solo la dirección contraria). La declaración del dueño en
/empezar queda como acta en la auditoría (`fiscal.regime.*`), con su usuario y fecha: si
mintió, mintió firmando. Los recibos son visibles y etiquetados en reportes — no hay ventas
invisibles.

**Deja de ser aceptable:** si aparece un mecanismo para volver a `sin_facturacion` desde un
régimen fiscal, o si el gate de kind gana una excepción. Ladino no puede impedir que un
inscrito MIENTA al declararse; sí garantiza que la mentira quede firmada y el rastro completo.

**Actualización 2026-09-14 (Ola 1 «Ladino sin RIF», A2).** Ahora el alta SIN RIF asigna
`sin_facturacion` en la misma transacción que crea la empresa. Antes la empresa nacía sin régimen
y su caja respondía 409. El acta `fiscal.regime.assigned` guarda `origin: onboarding`, el usuario y
la declaración. La primera asignación desde /empezar también deja acta (`origin: empezar`).
Con esto, un inscrito que se registre sin poner su RIF queda en recibos **con firma desde el
primer minuto**. La transición contraria sigue sin existir: `e2e-modo-venta` asevera el 409 de
facturas → recibos. `platform.sales_mode_at` (migración 54) es la única definición del modo, y
el pgTAP 054 la compara contra el trigger de emisión en cada régimen sembrado.

### R-28 · Los guards de A7 pueden dejar fuera a una empresa en transición legítima

- **Severidad:** Baja · **Disparador:** un dueño que ya tiene RIF pide activar IGTF, marcarse
  contribuyente especial o cargar talonarios ANTES de activar la facturación en /empezar
- **Dónde:** `packages/domain/src/modo-venta.ts` (`exigeEmpresaQueFactura`) · `igtf.ts`
  (`enableIgtf`, `setCompanyTaxpayerType` solo para `especial`) · ruta de rangos en
  `apps/api/src/routes/sales.ts`

Desde la Ola 1, estas tres acciones responden 409 `REGIME_KIND_NOT_ALLOWED` si la empresa no emite
facturas. El motivo: un recibo percibiría IGTF, y un talonario sin régimen que factura es papel sin
uso. El orden natural es activar la facturación primero; el 409 trae escrita esa salida («Ir a
Empezar»). La hipótesis que falta validar es que nadie necesita preparar la capa fiscal
antes de tener el régimen (P-14 en `PENDIENTES_ASESOR.md`).

**Deja de ser aceptable:** si el asesor confirma que la carga previa es un caso real. Mitigación
en ese momento: permitir la configuración y seguir bloqueando la **percepción** en recibos. Eso
se decide en el caso de uso, no en la pantalla.

### R-29 · Una empresa nueva no puede vender el producto que acaba de cargar con precio en USD

- **Severidad:** Alta · **Disparador:** ya ocurre. Confirmado en producción («Pollos y víveres
  paola») y por `e2e-recibos-punta-a-punta` (`it.fails`, BUG VIVO)
- **Dónde:** `create-company.ts` siembra «detal» y «mayor» en la moneda funcional (VES) · el alta
  simple guarda el precio USD en «detal USD» · la caja prefiere «detal»

El producto queda con precio en una lista que la caja no mira. La salida de hoy es fijar la lista
predeterminada en Ajustes, y el dueño no sabe que existe. Arreglarlo choca con R1 (precios
anclados en USD) y con ADR-0046: decidir cuál es la lista de la caja es una decisión del dueño.
**No se tocó**, y las listas en Bs de producción tampoco.

**Deja de ser aceptable:** ya lo es para el primer usuario sin RIF. Mitigación: la decisión sobre
la lista predeterminada de una empresa nueva, antes de salir a buscar usuarios. Cuando se tome,
el `it.fails` pasa a `it` sin cambiar su aserción.

### R-30 · Los datos de semilla viven mezclados con los reales en producción

- **Severidad:** Media · **Disparador:** cualquier cifra agregada de «Ladino» o «ferreteria» que
  se lea como real · la reprocesión de documentos de la Ola 2 (ADR-1)
- **Dónde:** producción, empresas «Ladino» (1.193 documentos de semilla + 8 reales del dueño) y
  «ferreteria» (semilla + 5 facturas de José) · usuario `seed-0dd23796` aún activo con membresía

La marca de semilla a nivel de empresa (plan, 1.3) **no se ejecutó**: no separa lo sembrado de lo
real dentro de la misma empresa, y suspender «Ladino» suspendería la empresa del dueño. Por R8 no
se borra nada. La única marca disponible es el autor del documento.

**Deja de ser aceptable:** antes de reprocesar documentos en la Ola 2. Mitigación: una decisión
explícita del dueño sobre la marca por documento o sobre la desactivación del usuario semilla.

### R-31 · Empresas existentes sin régimen siguen con la caja bloqueada

- **Severidad:** Media · **Disparador:** el dueño de «Corazon de Jesus» (régimen NULL, modo
  `ninguno`) intenta vender
- **Dónde:** A2 solo corrige el alta nueva. `platform.sales_mode_at` devuelve `ninguno` para esa
  empresa en producción

Una empresa en modo `ninguno` ve la capa fiscal (a propósito: todavía no eligió) y su caja responde
409 hasta que el dueño elige en /empezar. No se asignó régimen por SQL en producción: sería
declarar por él una situación legal.

**Deja de ser aceptable:** si ese dueño no encuentra /empezar. Mitigación: avisarle, o que Inicio
lleve a Empezar cuando el modo sea `ninguno`.

### R-32 · Falla intermitente de `e2e-sales` («NC directa», 409)

- **Severidad:** Baja · **Disparador:** un `verify` en rojo en ese caso sin cambios que lo toquen
- **Dónde:** `apps/api/test/e2e-sales.test.ts`, caso de nota de crédito directa

Falló una vez durante la Ola 1. No se reprodujo en tres corridas completas de la API ni en un
`verify` completo. Se descartó el desfase de reloj, porque el régimen del fixture empieza AYER.
La causa **no está cerrada**. No se reintentó hasta el verde: queda anotado para reconocerlo.

**Deja de ser aceptable:** a la segunda aparición. Mitigación: correr el caso con
`LADINO_E2E_DEBUG=1` y guardar el cuerpo del 409. Asertar el mensaje, no solo el código
(CLAUDE.md §3).

> **Sobre la numeración.** R-16 a R-21 nacieron en `HANDOFF.md` durante los módulos de ventas,
> compras y contabilidad y siguen ahí. Este registro salta de R-15 a R-22 por eso, no porque se
> hayan perdido entradas. Consolidarlos aquí está pendiente y es trabajo de una sesión, no de esta.

### R-33 · El vencimiento de un lote se juzga con el día de la sesión (UTC), no el de Caracas

- **Severidad:** Baja · **Disparador:** una venta de un producto con lotes entre las 20:00 y la
  medianoche de Caracas, el día en que vence un lote
- **Dónde:** trigger LAD46 (`occurred_at::date`, migración 20) · `allocate_lots_fefo` (migración
  57) usa a propósito la MISMA expresión para no elegir un lote que el trigger rechace

Es la familia de CLAUDE.md §3. Entre las 20:00 y las 24:00 de Caracas, un lote que vence «hoy»
en Caracas ya es «ayer» en UTC: el reparto lo excluye y el trigger lo rechazaría. El efecto es
conservador (vende primero el siguiente lote; nunca vende vencido).

**Deja de ser aceptable:** si una empresa vende perecederos de noche y lo nota. Mitigación: una
migración que lleve el trigger y el reparto al día de Caracas a la vez, con su test de horario.

### R-34 · Una empresa «especial» trata el IVA de compra como NO recuperable

- **Severidad:** Media · **Disparador:** la primera factura de proveedor de una empresa sujeto
  pasivo especial (Ladino lo es en producción)
- **Dónde:** `registerSupplierInvoice`: `ivaRecuperable = companyTaxpayerType === "ordinario"`

Un sujeto pasivo especial también es contribuyente ordinario de IVA; con la regla actual su IVA
de compra va al COSTO, no a crédito fiscal. Hallado al revisar la revalorización de la Ola 2; no
se cambió porque es una decisión tributaria (P-17).

**Deja de ser aceptable:** antes de que una empresa especial real registre compras.

### R-35 · Las migraciones 56–59 exigen la ventana del deploy

- **Severidad:** Media · **Disparador:** aplicar 56–59 en Supabase sin desplegar la API nueva (o al
  revés)
- **Dónde:** migración 56 (plantillas con `treasury_account`), 58 (compra contra el puente)

Con la API vieja, la plantilla nueva pide un papel que el generador viejo no resuelve: los cobros,
pagos, gastos y cierres se ENCOLAN (nunca un asiento equivocado) y la recepción de compra no
asienta mientras la factura sí debita el puente. Todo se recupera con «Contabilizar pendientes»
tras el deploy, pero la cola crece mientras tanto.

**Deja de ser aceptable:** si pasa más de un día entre las dos cosas. Mitigación: aplicarlas en el
mismo acto que `docker compose up -d --build`.

### R-36 · Los E2E comparten la tasa global del día y compiten por la máquina

- **Severidad:** Baja · **Disparador:** un proceso que escriba la tasa oficial del día en la base
  local (la API de desarrollo trae la del BCV) o servidores de desarrollo abiertos durante el verify
- **Dónde:** E2E que siembran `exchange_rates` con `where not exists` (tasa 40); timeouts de 5 s
  en los E2E de PDF e importación

Visto el 2026-09-15: con la API de desarrollo abierta, la tasa real (842) entró a la base de
pruebas y V2 falló; con los servidores abiertos, tres E2E agotaron el tiempo. No son defectos de
código, pero un verify en rojo por el entorno enseña a reintentar hasta el verde.

**Deja de ser aceptable:** a la próxima vez. Mitigación: cerrar la API y la web de desarrollo antes
del verify (anotado en la memoria de trabajo).

### R-37 · Los hechos históricos pendientes se contabilizan con las plantillas de su fecha

- **Severidad:** Media · **Disparador:** «Contabilizar pendientes» sobre la cola histórica de
  «Ladino» (1.526 hechos) después de la regularización
- **Dónde:** ADR-0055 (la vigencia se elige por la fecha del hecho) · migraciones 56 y 58

Un cobro de hace una semana que salga de la cola usa la plantilla vigente en SU fecha —la vieja,
con `cash_bs`—, y la reclasificación de la regularización ya se habrá calculado. Esa porción
quedaría en caja Bs otra vez.

**Deja de ser aceptable:** si se procesa la cola después de regularizar. Mitigación: procesar la
cola ANTES de la regularización, o volver a correr la reclasificación (el script es idempotente en
su comprobación de rojo).

### R-38 · Una empresa que pasó de recibos a facturas no puede devolver un recibo viejo

- **Severidad:** Baja · **Disparador:** devolución de un recibo emitido antes de activar la
  facturación
- **Dónde:** `allowed_kinds` de los regímenes fiscales (solo `sin_facturacion` admite
  `receipt_return`); trigger de emisión LAD49

El recibo de devolución se emite con el régimen de HOY. En un régimen fiscal responde 409
`REGIME_KIND_NOT_ALLOWED`. Se dejó así a propósito: abrir el `receipt_return` en regímenes fiscales
es abrir una vía para bajar ventas fuera del libro (R-27).

**Deja de ser aceptable:** con el primer caso real. Mitigación: permitirlo solo contra recibos
emitidos bajo `sin_facturacion` (la regla vive en LAD84).

### R-39 · Producción en la migración 66 con la API vieja

- **Severidad:** Alta · **Disparador:** las migraciones 60–66 ya están aplicadas en Supabase
  (2026-09-16) y el VPS sigue con la API, el worker y la web anteriores
- **Dónde:** migración 61 (plantilla de transferencias), 65 (forma de `purchases_book`) y 66
  (política de inserción de tasas)

Con la API vieja:
- cargar una tasa a mano o «sigue igual» falla por RLS con un error genérico;
- la conversión ya usa solo la tasa oficial;
- las pantallas nuevas (mover dinero, recibos sin RIF, costo en USD) no existen;
- las que dependen de contratos nuevos responden el 422 genérico, como el 2026-09-16 con
  «Nuevo producto».

Nada escribe un asiento equivocado, pero el negocio ve errores.

**Deja de ser aceptable:** ya. Mitigación: `git pull && docker compose up -d --build api worker
web` en el VPS.

### R-40 · Solo la tasa del BCV: con la fuente caída se vende con la última publicada

- **Severidad:** Media · **Disparador:** DolarAPI no responde durante días, o publica un valor
  que la cota de plausibilidad rechaza
- **Dónde:** `platform.rate_for` (migración 66), `apps/api/src/tasa-oficial.ts`

Sin carga a mano (ADR-0064 §1), rige la última tasa publicada, sin tope de días. Mi dinero e
Inicio dicen su fecha. «Traer del BCV» no pasa por la cota, así que una devaluación real se
guarda desde ahí.

**Deja de ser aceptable:** si la fuente cae más de un día hábil. Mitigación: el operador de la
plataforma carga la oficial del día como fila de sistema; el tope legal queda como P-22.

### R-41 · Libros, declaración y retenciones de producción con cifras anteriores a la migración 65

- **Severidad:** Media · **Disparador:** presentar o usar los documentos guardados antes del
  2026-09-16
- **Dónde:** «Inversiones Ferretería QA» (3 libros exportados, 2 retenciones en USD) y «Ladino»
  (1 declaración)

Son hechos con huella y no se reescriben. Regenerar el período da la cifra corregida con otra
huella.

**Deja de ser aceptable:** si alguno se presentó al SENIAT. Mitigación: el contador decide si se
sustituyen.

### R-42 · El fiado cobrado a otra tasa se asienta sin nota de débito o crédito

- **Severidad:** Media · **Disparador:** una empresa que factura cobra una deuda en divisa a una
  tasa distinta de la de emisión
- **Dónde:** `registerPayment` (diferencial cambiario, ADR-0047); ADR-0064 §3 sin implementar

El Reglamento de la LIVA, art. 51, leído en una fuente no oficial, pediría documentar esa
diferencia con nota de débito o de crédito. Hoy solo se asienta el diferencial.

**Deja de ser aceptable:** cuando el asesor confirme el art. 51 (P-20). Mitigación: el diseño
está en ADR-0064 §3.

### R-43 · Las facturas con retención anteriores a la migración 68 dejan un residuo en cuentas por pagar

- **Severidad:** Media · **Disparador:** pagar una factura de proveedor registrada ANTES de la
  migración 68 que tenga retención calculada
- **Dónde:** migración 68 (plantillas de compra y pago corregidas en sitio); ADR-0065 §3

El asiento de esa factura, hecho con la plantilla vieja, acredita al proveedor el BRUTO y no
reconoce el pasivo con el fisco. Desde la migración 68 su saldo en el auxiliar viene neto y el
pago debita ese neto: en cuentas por pagar quedan los bolívares de la retención, y el pasivo con
el SENIAT nunca se asentó. El auxiliar dice la verdad; el mayor arrastra el error anterior.

**Deja de ser aceptable:** al cerrar el período de una empresa con facturas así. Mitigación: un
asiento manual por factura (débito cuentas por pagar / crédito retención de IVA por pagar); la
consulta que las lista está en la cabecera de la migración. En producción son 2, las dos de la
empresa de pruebas «ferretería».

**Variante de la misma causa:** una factura de compra que quede **en la cola** antes del deploy
(por un papel sin cuenta, por ejemplo) guarda sus importes SIN `net_amount`, y al reprocesarla
con la plantilla nueva volverá a la cola diciendo «la plantilla pide el importe net_amount». Hoy
en producción la cola no tiene ninguna (`sales_invoice`, `payment_received`, `igtf_perception` y
una nota de venta). Comprobarlo después del deploy: `select count(*) from
public.journal_generation_queue where source_kind = 'purchase_invoice' and status = 'pending'`.
Si aparece alguna, su asiento se hace a mano.

### R-44 · Producción arrastra dos reglas de retención de plataforma citando una providencia derogada

- **Severidad:** Media · **Disparador:** cualquier empresa sin reglas propias que retenga IVA
- **Dónde:** `retention_rules` con `company_id is null` en producción (cargadas en el QA)

Una de ellas cita la **PA SNAT/2015/0049**, derogada por la PA SNAT/2025/000054 desde el
01/08/2025. La norma copiada viaja al comprobante y al informe: una retención practicada hoy
saldría citando una providencia que no existe. El porcentaje (75 %) coincide, así que el importe
no cambia; lo que está mal es la fuente.

**Deja de ser aceptable:** con la primera retención real. Mitigación: son datos de producción y
la decisión es del dueño — desactivar las dos reglas de plataforma y que cada empresa cargue la
suya (ADR-0057), o cargar una nueva con la fuente correcta y desactivar la vieja. Una regla citada
por una retención tiene FK: **no se borra, se desactiva.**

### R-45 · La entrada suelta exige origen: la web desplegada deja de poder usarla hasta el rebuild

- **Severidad:** Media · **Disparador:** aplicar las migraciones 69/70 y el API nuevo sin
  reconstruir la web, o al revés
- **Dónde:** `POST /v1/inventory/receipts` (ADR-0066 §3); `apps/web` «Entrada de existencias»

Desde ADR-0066 esa ruta exige `origin` explícito y responde 422 sin él. La web desplegada sigue
llamándola sin origen desde «Entrada de existencias» —pantalla que esta entrega elimina—, así que
entre el despliegue del API y el de la web esa pantalla vieja responde 422 con un mensaje que
remite a una pantalla que todavía no existe. Ninguna otra superficie la usa.

**Deja de ser aceptable:** si el API y la web se despliegan por separado. Mitigación: van en la
MISMA ventana, como siempre (R-43), y la pantalla nueva y la vieja no coexisten en ninguna
versión.

### R-46 · El rol de almacén cambia de aterrizaje

- **Severidad:** Baja · **Disparador:** un usuario con `inventory.move` o `purchase.receive` que
  entra a la aplicación
- **Dónde:** `rutaInicial` en `apps/web/src/app/nav.ts`

Antes caía en Administración → Inventario, que era donde estaba la «entrada de existencias»; ahora
cae en «Llegó mercancía», que es su trabajo. Está aseverado en `nav-llegada.test.ts`, y esa zona
ya produjo un bucle de redirección con pantalla en blanco (auditoría 2026-09-11), así que el
cambio se hizo con su prueba delante.

**Deja de ser aceptable:** si alguien añade una entrada nueva ANTES de esta en el grupo Operación
sin mirar el test: el aterrizaje se movería sin que nadie lo decidiera.

### R-47 · `capture_currency` y `capture_mode` son nulos para todo lo anterior a la migración 71

- **Severidad:** Baja · **Disparador:** leer lo capturado de un documento anterior al 2026-09-18 y
  tratar el nulo como «lo escribió en la moneda del documento»
- **Dónde:** `inventory_moves`, `goods_receipt_lines`, `supplier_invoice_lines` (migración 71)

Las columnas nacen nulas y **no admiten backfill**: `inventory_moves` es append-only, y adivinar
en qué moneda escribió alguien un importe en marzo sería inventar un dato con pinta de dato. El
nulo significa exactamente «no se sabe», y quien lo lea tiene que decirlo así — no rellenarlo con
la moneda del documento, que es la suposición cómoda y probablemente falsa para media base.

**Deja de ser aceptable:** si alguna pantalla o informe empieza a mostrar «escrito en Bs.» para
filas con nulo. La defensa es que no hay valor por omisión en el esquema y el `CHECK` solo admite
el vocabulario cerrado cuando la columna trae valor.

### R-48 · `backdated_stock_in` es un reporte, y un reporte no se lee como un gate

- **Severidad:** Media · **Disparador:** alguien mete `platform.backdated_stock_in()` en `verify`,
  en CI o en un panel con un semáforo
- **Dónde:** migración 72; `docs/00_GOVERNANCE/adr/ADR-0066` §5 y §8

Su respuesta correcta **no es cero**: una llegada fechada hacia atrás con ventas entre medias es
un hecho legítimo y frecuente, y el promedio móvil —que se calcula en orden de inserción— no
recalcula el costo de lo ya vendido. La función dice qué movimientos salieron con un costo que la
llegada posterior habría cambiado, para que una persona lo mire. Convertirla en gate enseñaría a
reejecutar hasta el verde, que es como muere un gate (CLAUDE.md §3).

**Deja de ser aceptable:** en el momento en que aparezca en un paso de `verify` o en una alerta
automática. La defensa hoy es el comentario de la migración y el de la función, que lo dicen con
todas sus letras; no hay mecanismo que lo impida.

### R-49 · `money_landing_gaps` es un informe, y sale con filas desde el primer día

- **Severidad:** Media · **Disparador:** alguien lo mete en `verify`, en CI o en un semáforo, o
  lee sus filas como «algo está roto»
- **Dónde:** migración 73; `docs/00_GOVERNANCE/adr/ADR-0067` §4

Su respuesta correcta **no es cero**: «Sin asignar» es legítima mientras el negocio no tenga una
cuenta de esa familia — ADR-0062 §3 la creó justo para eso y para repartirla. En las ocho empresas
de producción va a salir con filas el día que se aplique, porque `payment_methods` está vacía y
todo cayó por el desempate de antigüedad. Es lo que se pidió: enseñar, no tapar.

**Deja de ser aceptable:** en cuanto aparezca en un paso de `verify` o en una alerta automática.
Es el mismo riesgo que R-48 sobre `backdated_stock_in`, y la defensa es la misma —el comentario de
la migración, el de la función y este apunte—: no hay mecanismo que lo impida.

### R-50 · Mientras `payment_methods` siga vacía, se pregunta la cuenta en cada cobro y cada pago

- **Severidad:** Baja · **Disparador:** un negocio con dos o más cuentas de la misma familia y
  ninguna forma de pago configurada
- **Dónde:** ADR-0067 §1; «Mi dinero» → formas de pago

La pregunta «¿de qué cuenta salió?» aparece porque el sistema no lo sabe, y no lo sabe porque nadie
ató «pago móvil» a «Mercantil». Configurar la forma la hace desaparecer: es la diferencia entre un
sistema que pregunta cada vez y uno que lo sabe. No se obliga a configurarlas antes de cobrar
—un negocio tiene que poder vender su primer día—, así que el coste se paga en toques hasta que
alguien las configure.

**Deja de ser aceptable:** si la fricción hace que alguien elija «la primera que salga» sin mirar.
Entonces habría que empujar la configuración en el onboarding, no en un aviso de «Mi dinero».

### R-51 · `guard-agentes.sh` es una barandilla que lee texto, no una jaula

- **Severidad:** Media · **Disparador:** un agente que quiere escribir, o empujar, y no por descuido
- **Dónde:** `.claude/hooks/guard-agentes.sh`; CLAUDE.md §8; 30ª entrega del HANDOFF

El guardián decide leyendo el TEXTO del comando. Lo que no está en el texto no lo ve: un script propio
(`node -e`, un `.mjs` que escribe), una tabla cuyo nombre se arma en una variable, un intérprete
que no conoce. Tres revisiones lo apretaron —y la tercera enseñó que cada forma de «entender» mejor
el comando (neutralizar comillas, acotar el `-h` al tramo de psql) abre salidas nuevas—, así que
ahora es estricto a propósito: todo `>` cuenta, salvo el SQL entre comillas simples de `psql -c`, y
`-h` es un host en todo el comando. Eso deja **falsos positivos declarados** (`grep -h`, `du -h`,
`awk 'NR>1'`, `grep "=> {"`), anclados en `scripts/hooks-selftest.sh` y escritos en las definiciones
de los tres agentes de lectura con terminal. La primera capa sigue siendo `tools`/`disallowedTools`.

Evasiones conocidas y **declaradas, no parcheadas** (una revisión adversarial las señaló por lectura
del código; parchearlas una a una es la carrera que la tercera revisión enseñó a no correr):
- `gh`: el valor pegado a la opción (`-fclave=valor` en `gh api`), un verbo de lectura como valor de
  una opción desconocida, `gh.exe`, una ruta absoluta o el nombre entre comillas, y los alias y
  extensiones;
- programas que escriben por sus propias opciones, sin ningún `>`: `psql -o`, `-L`/`--log-file`,
  `PSQLRC`, `sort -o`, `curl -o`, `git diff --output`.

**Deja de ser aceptable:** si un agente llega a escribir en el repo o al remoto saltándose el hook.
Entonces el confinamiento tiene que pasar al sistema de ficheros (un worktree de solo lectura, un
usuario sin permisos), no a una regex más.

### R-52 · Los hooks cuestan unos 3 s por cada Bash, y sin Node bloquean la sesión entera

- **Severidad:** Baja · **Disparador:** sesiones largas con muchos comandos; una máquina sin `node`
  en el PATH de Claude Code
- **Dónde:** `.claude/hooks/lib-json.sh`, `.claude/settings.json`

Cada guardián llama a Node varias veces por invocación (unas diez en total por comando, medido por
el revisor: infra ~1 s, immutability ~1,8 s, agentes ~0,5 s). Un solo proceso que extraiga todos los
campos lo bajaría. Y si falta Node, los guardianes FALLAN CERRADOS —es lo buscado, tras el apagón de
`jq`—: la sesión principal queda bloqueada en todo Edit, Write, Bash y MCP, y solo se sale arreglando
el PATH por fuera de Claude Code.

**Deja de ser aceptable:** si la latencia empuja a desactivar los hooks. Antes de eso, un único
lector de campos por hook.

### R-53 · Una empresa sin reparar (ADR-0070) sigue con sus cajas en la cuenta de familia

- **Severidad:** Media · **Disparador:** la reparación `scripts/reparar/adr-0070-subcuentas.mjs`
  no corre tras el git pull, o salta una empresa (período del día cerrado, hechos en la cola)
- **Dónde:** `supabase/migrations/20260928110000_each_treasury_account_has_its_own_ledger_subaccount.sql`,
  `packages/domain/src/treasury.ts` (`repairTreasurySubaccounts`)

La migración cierra el 500 de J-01 en todas las empresas (agrupa por cuenta), pero NO reparte por sí
sola: el asiento de reclasificación lo postea el dominio, como todo posteo. Hasta que la reparación
corra, las cajas de una empresa existente comparten 1.1.01 / 1.1.02, una transferencia entre ellas
deja dos líneas que se anulan en la misma cuenta, y `treasury_ledger_gaps` da `compartida`. Las
cajas nuevas de esa empresa se siguen mapeando a la familia a propósito: crear una hija la volvería
agrupadora y LAD62 rechazaría los hechos de las cajas viejas. Aparte, dos huecos conocidos:
- un mapeo EXPLÍCITO de una caja a una cuenta agrupadora (la familia ya reparada, por ejemplo) se
  acepta y su primer hecho muere en LAD62; el invariante lo marca `no_es_hoja`, la API no lo impide;
- las cajas en divisa se comparan solo en estructura: el importe en moneda original espera E-11 /
  J-04. Con más de una caja en divisa, la reparación reparte los Bs de 1.1.02 en proporción al saldo
  en divisa (estimación, no historia).

**Deja de ser aceptable:** en cuanto el dueño confirme que la API nueva está arriba — ahí se corre la
reparación y `treasury_ledger_gaps` tiene que dar 0 en todas las empresas.

### R-54 · El libro de ventas cambia de cifras al desplegar, y la R-2 ampliada lee solo el último cierre del período

- **Severidad:** Media · **Disparador:** desplegar la migración 20260928120000 en una empresa que ya
  exportó (`fiscal_book_runs`) o declaró un período con notas de crédito o anuladas; o anular una
  factura de proveedor en un período que se reabre y se vuelve a cerrar después
- **Dónde:** `supabase/migrations/20260928120000_the_book_signs_what_the_ledger_signs.sql`
  (`platform.sales_book`, `platform.supplier_invoice_late_annulment_day`)

L-01: el libro de ventas firmaba la NC en positivo y la anulada con sus importes. Tras el despliegue,
reexportar un período ya exportado da **otro hash** (las cifras correctas), y esa diferencia es la
corrección, no un documento nuevo. Lo dice el propio rastro: `BOOK_GENERATOR_VERSION` sube de
`fiscal-books/1.0.0` a `fiscal-books/1.1.0` (`packages/domain/src/fiscal-books.ts:33`), así que dos
generaciones con distinto hash y distinta versión se explican por el generador, no por los datos. Si se declaró desde
el libro viejo (débito de más), corresponde sustitutiva (COT art. 102, VALIDAR-TRIBUTARIO de L-01);
en el escenario del recorrido no hay declaración presentada. Aparte, dos límites de la R-2 ampliada:
- el «cerrado cuando se anuló» sale de la fila de `fiscal_periods` (último cierre, última
  reapertura). Si tras la anulación el período se reabre **y** se vuelve a cerrar, la factura vuelve
  a R-2 tal cual y el libro ya presentado cambia. La historia completa está en
  `fiscal_period_events` (K-01); leerla es el arreglo, y va con la respuesta a P-46;
- lo anulado antes de la migración no tiene `annulled_at` y se lee como R-2 tal cual. Hoy ninguna
  vía del producto anula una factura de proveedor, así que en producción no debería haber casos;
- el sello no se elige ni se mueve en un UPDATE (migración 20260928120200: `now()` al anular, LAD06
  al cambiarlo), pero un INSERT que ya nazca anulado (solo por SQL) trae su propio sello.

### R-55 · Con la migración 20260928130000 sin el paso de compras de K-04, un documento de compra fechado antes del inicio de actividades da 422

> **Estado 2026-09-28: RESUELTO para factura, NC y landed cost** (migración 20260928130100 y enrutado
> en `purchases.ts`): `accounting_date_for` los lleva al período en curso con su fecha original.
> **Recepción, pago a proveedor y gasto de tesorería** también se enrutan desde la ronda del
> revisor (2026-09-28); el pago está probado en E2E, la recepción y el gasto no. **Solo da 422
> (LAD91), a propósito:** el asiento manual antes del inicio. El inicio se corrige desde Mi empresa.
> **Despliegue:** 130000, 130100 y 130200 van juntas.

- **Severidad:** Media · **Disparador:** registrar una factura, NC o landed cost de proveedor fechado
  antes de `companies.activity_start_date`. Aplica a toda empresa existente: el backfill toma el día
  de alta, y cualquier compra anterior a esa fecha queda fuera
- **Dónde:** `platform.period_for_date` (LAD91) en `supabase/migrations/20260928130000_periods_have_history.sql`;
  el enrutado vive en `platform.accounting_date_for` (misma migración) y lo llaman la factura, la
  NC y el landed cost (`packages/domain/src/purchases.ts`, K-04), y la recepción, el pago a
  proveedor y el gasto de tesorería (`packages/domain/src/fecha-contable.ts`). Sigue dando LAD91
  a propósito el asiento manual anterior al inicio

ADR-0069 §4 enruta esos documentos al período abierto y conserva su fecha original. El suelo ya
existe (`accounting_date`, `platform.accounting_date_for`, pgTAP 079). El enrutado está sin hacer: tiene
que salir junto con `purchases_book` y `recompute_iva_period`, que redefine la migración
20260928120000. Si sale sin ellas, el asiento cae en un período y el libro en otro. Mientras
tanto, el 422 se lee bien («anterior al inicio de actividades»), pero **bloquea algo que antes
entraba**. **Mitigación:** no desplegar 130000 sin el paso de compras de K-04, o avisar al dueño.

### R-56 · El worker puede adoptar `ladino_api`: su aislamiento por privilegio (ADR-0031) deja de ser total

> **Estado 2026-09-29: ACEPTADO, decidido por criterio** (§2.16 de la respuesta del dueño; ADR-0074
> §«Quién procesa el trabajo»; migración `20260928140000_product_import_jobs.sql`). El revisor verificó
> el aislamiento y el coordinador que el GRANT es aplicable en producción (ADMIN OPTION de `postgres`
> sobre `ladino_api`, PG 17.6).

- **Severidad:** Media · **Disparador:** credenciales del worker comprometidas, o un bug del worker que
  nombre un actor que no es el del trabajo.
- **Dónde:** `grant ladino_api to ladino_worker with inherit false, set true` en la migración
  20260928140000; lo usa `procesarTrabajoImportacion` (`packages/domain/src/product-import.ts`) con
  `set local role ladino_api` dentro de cada transacción de fila.

ADR-0031 aislaba al worker por PRIVILEGIO: con GRANT solo sobre outbox, idempotencia y carritos, no
podía ni nombrar una tabla de negocio. ADR-0074 decide que la importación la procesa el worker, y
crear un producto toca una docena de tablas (productos, precios, kardex, asientos, auditoría,
outbox). Se eligió que el worker **adopte** `ladino_api` con el actor del trabajo en el GUC, en vez
de repartirle GRANT tabla por tabla: la RLS y la autorización son las de la API para esa persona, y
sin el `SET ROLE` explícito el worker sigue sin ver nada (pgTAP 014 y 082). Lo que se pierde: quien
controle el proceso del worker puede hacer lo que la API puede, igual que quien controle la API.
**Mitigación:** el actor sale de `product_import_jobs.created_by` (lo fija el trigger de procedencia,
no el cliente); el SET ROLE vive en un solo sitio. **Alternativa, descartada por criterio:** procesar
el trabajo en el proceso de la API (en segundo plano tras responder) y revocar el GRANT.



### R-57 · Al desplegar ADR-0073, las empresas con IVA aceptado venden reducida y adicional, su exenta cambia de cita y el libro de ventas cambia de columnas

- **Severidad:** Media · **Disparador:** aplicar las migraciones 20260928150000, 20260928150100 y
  20260928150200 y 20260928150300 en producción. **Van en la lista «aplicar justo después del git pull»**, en la
  misma ventana que el despliegue: la API nueva lee `tax_rule_templates`, llama a
  `accept_general_vat` y proyecta las columnas nuevas de `sales_book_by_rate`, y con la API vieja
  arriba los productos de reducida y adicional empezarían a venderse sin la pantalla que los explica
- **Dónde:** `platform.seed_catalog_tax_rules` (§6 de 20260928150000), 20260928150100,
  `platform.sales_book_by_rate`, `BOOK_GENERATOR_VERSION` 1.3.0

Toda empresa con general propia vigente y en rango recibe, desde el día de la migración, reglas
propias de reducida (8 %), adicional (su general + 15 %) y exenta con la cita del catálogo; su exenta
«ACEPTADA por el dueño» se cierra ese día. Un producto que alguien hubiera clasificado como reducida
o adicional, y que hoy da 409, **empieza a venderse** sin que nadie lo revise. Y el libro de ventas
trae once columnas nuevas y su hash firma también el resumen del art. 72 (H6): reexportar un período
ya exportado da otro hash, y la versión del generador (1.3.0) lo explica. Desde 150200, una regla
con líneas emitidas no se retira nunca (se cierra con `effective_to`), y la aceptación del mismo día
en que ya se facturó con la tasa anterior se rechaza (LAD97): la persona elige otra fecha. Lo emitido no cambia: cada línea conserva su regla copiada (ADR-0038).
**Mitigación:** antes de desplegar, `select company_id, tax_category_code, count(*) from
public.products where tax_category_code in ('gravado_reducida', 'gravado_adicional') group by 1, 2`
en producción, y avisar a esas empresas. Y las empresas cuya categoría por omisión el catálogo no
ofrece en ventas (desde B4, el alta simple y la importación les darían 422): `select company_id,
default_tax_category_code from public.company_settings where default_tax_category_code not in
(select product_tax_category from public.tax_rule_templates where offered_in_sales)`.
**Deja de ser aceptable:** si alguna de las dos consultas devuelve filas y nadie las revisó.

### R-58 · Un RIF «P» sigue clasificándose como «extranjera / no domiciliado» (pendiente del asesor)

- **Severidad:** Media · **Disparador:** alta de un cliente o proveedor con RIF P sin tipo explícito
- **Dónde:** `packages/domain/src/customers.ts` (`clasificacionPorPrefijo`),
  `apps/api/src/routes/customers.ts` (importación) y `apps/web/src/pages/negocio/Vender.tsx` (la
  inferencia del mostrador)

La regla del dueño del 2026-09-28 dice que **P es el RIF de una persona con pasaporte**, y el
dominio sigue infiriendo de la P «extranjera / no_domiciliado» en tres sitios. Es clasificación
fiscal, no texto: se queda como está (revisión del coordinador, 2026-09-28) hasta que el asesor diga
qué clasificación por omisión corresponde a un RIF P. Quien lo sepa la corrige en la ficha.
**Pendiente del asesor:** ¿qué tipo de persona y de contribuyente corresponde por omisión a un RIF
P (persona natural con pasaporte, domiciliada o no)?

*Resuelto en la misma revisión (antes era la primera mitad de este riesgo):* el cliente que solo
tiene pasaporte. La PA 00071 art. 13.7 admite «cédula o pasaporte» del adquirente persona natural:
manda la norma, y el cliente acepta pasaporte. Decidido por criterio: P + 9 dígitos es RIF P;
cualquier otro «P» + alfanumérico de 5 a 20 es pasaporte, guardado «P» + mayúsculas sin separadores
y mostrado como hasta hoy (`P-AB1234567`). Alternativa: un selector explícito de tipo de documento.

### R-61 · La retención soportada no tiene reversa: un comprobante mal cargado no se deshace (ADR-0072 §5, F-11)

- **Qué:** el dueño decidió que el contador corrige y reversa (`ar.retention.correct`, sembrado en la
  migración 20260928190000), pero el comprobante abona la factura en el mismo acto y **un cobro no
  tiene reversa en el sistema** (`payments` append-only, `amount > 0`; ADR-0061). Reversar exige o
  una fila de cobro negativa (cambia la semántica de `payments` y de todo Σ cobros) o excluir los
  cobros de comprobantes anulados en `document_balance`, `document_balance_transaction`,
  `ar_aging`, los saldos de ventas y `accounting_coverage_gaps`, más volver la factura de `paid` a
  `issued` y reversar el asiento con un permiso nuevo en `reversar()`.
- **Por qué no se hizo:** es semántica del dinero; el reparador paró (R9).
- **Mientras tanto:** un comprobante erróneo se neutraliza con una nota de débito o se corrige por
  SQL con acta. `ar.retention.correct` existe sin endpoint.
- **Trampa para quien la construya:** el CHECK `srr_receipt_14_digits_chk` es NOT VALID, que NO
  significa «no juzga filas viejas»: no se validó al crearlo, pero se evalúa en todo UPDATE. Marcar
  `status = 'annulled'` en un comprobante viejo con un número de otro formato fallará con 23514 si
  la migración de la reversa no lo prevé (p. ej. excluyendo `annulled` del CHECK).
- **Estado:** construido en la ola 3 (2026-10-03, pendiente de commit) — migración 20261003180000, ADR-0075 §8: `payment_reversals`, `POST /v1/payments/{id}/reversal` y `POST /v1/supported-retentions/{id}/reversal`. Lo que queda está en R-75.

**Ampliación (2026-10-02, ola 2 C2):** la ola 3 construye juntas la reversa de cobros y la
restitución de un IGTF percibido indebidamente con la venta viva (PA SNAT/2022/000013 art. 4;
P-67): hoy `annulInvoice` rechaza todo documento con cobros, así que la rama `pendiente_reintegro`
no se alcanza con IGTF percibido.

### R-59 · Al desplegar ADR-0071, la migración se para si producción tiene controles repetidos, y los talonarios viejos dejan de emitir hasta completar la imprenta

- **Severidad:** Alta · **Disparador:** aplicar 20260928160000 y 20260928160100 en producción
- **Dónde:** bloque 0 de 20260928160000; `platform.claim_fiscal_control`; `revoke … claim_control_number … from ladino_api`

Tres efectos, todos ruidosos: (1) si algún emisor ya tiene dos documentos con el mismo control, o
rangos no anulados que se solapan, la migración FALLA con la lista (lo emitido no se renumera);
(2) todo talonario registrado antes nace con «datos de imprenta incompletos» y emitir con él da
409 hasta completarlos en la puesta a punto; (3) la migración revoca a `ladino_api` la función de
consumo de ADR-0037: la API saliente no puede emitir entre la migración y el deploy (42501), así
que van en la misma ventana. **Mitigación:** antes de aplicar, en solo lectura:
`select company_id, control_number, count(*) from public.documents where control_number is not
null group by 1, 2 having count(*) > 1` y el cruce de rangos del bloque 0; avisar a las empresas
con talonario para que completen los datos de la imprenta. **Deja de ser aceptable:** aplicar la
migración sin la consulta previa, o desplegar la API días después de la migración.

### R-60 · En el papel, Ladino no sabe DÓNDE preimprime cada imprenta: la zona en blanco es genérica

- **Severidad:** Media · **Disparador:** la primera empresa que imprima sobre su forma libre real
- **Dónde:** `apps/api/src/routes/documents-pdf.ts` (`zonaPreimpresa`, `?destino=papel`); ADR-0071 §4

Con `?destino=papel` el PDF deja en blanco lo que la imprenta preimprime (PA 00071 art. 31) en
DOS franjas de posición fija: arriba (RIF del emisor y control) y tras los totales (imprenta,
providencia, rango, fecha de elaboración). Cada imprenta compone su forma libre a su manera: si la
casilla preimpresa de una hoja real cae fuera de esas franjas, Ladino imprimiría texto encima
(nunca los datos preimpresos —esos no salen en el papel—, pero sí el cuerpo del documento). El
test de la checklist mira el TEXTO del PDF, no su geometría: no lo ve. **Mitigación:** la vista
previa sombrea las franjas para compararlas con la hoja antes de imprimir; el diálogo pide
confirmar el control. **Deja de ser aceptable:** cuando una empresa real imprima: entonces la
posición de la zona preimpresa pasa a ser un dato del talonario (márgenes por talonario), no un
valor del código.

### R-62 · Si la API nueva se levanta antes de 140100/140200/140300, todo listado de productos da 500

> **Estado 2026-09-29: ABIERTO hasta el despliegue** (ADR-0074; migraciones
> `20260928140100_product_import_jobs_review.sql`, `20260928140200_reference_cost_needs_its_currency.sql`
> y `20260928140300_import_jobs_backoff_and_currency_fk.sql`).

- **Severidad:** Alta durante la ventana · **Disparador:** `git pull && docker compose up -d --build`
  con la API nueva antes de aplicar esas tres migraciones en Supabase Cloud.
- **Dónde:** `PRODUCT_SELECT` y `PRODUCT_SELECT_P` (`apps/api/src/routes/products.ts`) leen
  `products.reference_cost` y `reference_cost_currency`. El worker lee `product_import_jobs.next_attempt_at`.

Sin las columnas, `GET /v1/products` y la ficha responden `42703 → 500`, y con ellos la caja y el
catálogo. **Mitigación:** las tres migraciones son expand puro (columnas nullables, un índice parcial,
una guarda y un FK sobre columnas nuevas que la app saliente no lee ni escribe). Se aplican ANTES del
`git pull`, y la API vieja sigue funcionando con ellas puestas.

### R-63 · Con el adquirente obligatorio (P-57), una factura VIEJA al «Consumidor final» no admitía NC ni ND — RESUELTO

- **Severidad:** Media · **Disparador:** corregir una factura emitida antes del 2026-10-02 a un cliente de mostrador
- **Dónde:** `packages/domain/src/forma-libre.ts`; `platform.assert_document_issuance` (LAD99, migración 20260928190400)

La NC y la ND heredan el adquirente de la factura que corrigen. Si esa factura se emitió al
«Consumidor final» de sistema (antes de la lectura conservadora del art. 13.7), la nota no se puede
emitir: el dominio responde 422 y la base LAD99. En producción no hay clientes reales (2026-09-28)
y en el escenario local hay que comprobarlo antes de corregir. **Mitigación:** la respuesta del
asesor a P-57; si confirma la lectura, una vía explícita para identificar al adquirente de una
factura vieja (acta, nunca editar la factura: regla 1). **Deja de ser aceptable:** en cuanto una
empresa real necesite corregir una de esas facturas.

**Resuelto (2026-10-02, revisión de la auditoría fiscal, A-4/A-6, decidido por criterio):** la NC y
la ND ya no siguen el 13.7, sino «el mismo cliente y la identificación congelada de la factura que
corrigen» (dominio y base, migración 20260928190500). La NC de una factura al «Consumidor final» se
emite (e2e-checklist-factura, A-4; pgTAP 089).


### R-64 · La planilla de IVA en la ventana de despliegue de 20261002120000: API vieja con función nueva, o al revés

> **Estado 2026-10-02: ABIERTO hasta el despliegue** (L-04, L-05, L-09; ADR-0072 §7 y §8).

- **Severidad:** Media durante la ventana · **Disparador:** aplicar la migración sin desplegar la API,
  o desplegar la API sin la migración.
- **API nueva sin la migración:** `generateIvaPeriod` lee `retenciones_acumuladas_por_descontar` y
  llama a `recompute_iva_period` con cinco argumentos → `42703`/`42883` → 500 al generar o listar
  períodos de IVA. La propuesta y el calendario, también 500. Nada se escribe mal: falla ruidoso.
- **Migración sin la API nueva:** la API vieja llama con cuatro argumentos (resuelve por el
  `default 0`), recibe `excedente_siguiente` ya SIN retenciones y no lee la columna nueva: guarda una
  fila `iva-declarations/1.0.0` que **pierde el arrastre de retenciones**. **Mitigación activa:** la
  API nueva se niega a encadenar sobre una fila 1.0.0 con excedente **o con retenciones del período**
  y pide regenerarla (mensaje en ERROR_CATALOG), así que la pérdida no se propaga en silencio.
- **Mitigación:** migración y API en la misma ventana del despliegue del dueño, con la migración
  aplicada antes. En producción no hay clientes reales (2026-09-28).

### R-65 · La retención automática del agente en la ventana de despliegue de 20261002110000, y las compras de un especial sin regla cargada

> **Estado 2026-10-02: ABIERTO hasta el despliegue** (H-01, H-04, H-12, L-03; ADR-0072 §3-§6).

- **Severidad:** Alta (fiscal) · **Disparador:** desplegar la API nueva sin la migración, o una
  empresa especial sin regla vigente de `iva_compras` en `retention_rules`.
- **API nueva sin la migración:** el registro de facturas lee `retention_exclusions`,
  `retention_vouchers` y `claim_retention_voucher_sequence` → `42P01`/`42883` → 500 en TODO registro
  de factura de proveedor y llegada con factura. Falla ruidoso, no escribe nada. **Migración sin la
  API nueva:** la API vieja sigue sin retener (H-01 tal cual) y el libro de retenciones de IVA cambia
  de forma (columnas nuevas): la pantalla de Libros vieja las muestra con su nombre técnico.
- **Especial sin regla:** desde esta entrega, toda compra con IVA de un especial a un proveedor
  ordinario **se detiene** con `RETENTION_RULE_MISSING` hasta que se cargue la regla del 75 % (y la
  del 100 % si se marca el art. 5). Es el modo de fallo elegido (ADR-0039 §2: nunca cero en
  silencio), pero en producción una empresa especial que hoy registra compras sin regla dejaría de
  poder hacerlo. En producción no hay clientes reales (2026-09-28); E3 del escenario tiene su regla.
- **Mitigación:** migración y API en la misma ventana, migración antes; antes de habilitar a un
  especial real, cargar sus reglas `iva_compras` (0,75, PA SNAT/2025/000054 art. 4) e
  `iva_compras_total` (1,00, art. 5) con su fuente.

### R-66 · La ND por IGTF hereda la cola de su percepción

**Qué:** el asiento de la ND por IGTF es el de su percepción (backlink). Si ese asiento va a la cola
(la caja del cobro sin cuenta contable mapeada), la ND queda sin `journal_entry_id` y la cola
tiene la fila por la percepción, no por la ND: `accounting_coverage_gaps()` la reporta como hueco
hasta que se importe el pendiente. Es ruidoso a propósito (sin lista de perdones), pero conviene
saberlo antes de leerlo como un defecto nuevo. **Mitigación:** mapear la cuenta contable de las
cajas en divisa antes de cobrar; si aparece, importar el pendiente de la percepción. **Origen:**
migración 20261002100000 (ola 2 C2, E-03). **Corrección (revisión 3, 2026-10-02):** el backfill de la cola (`journal-backfill.ts`) ya
escribe el enlace de una percepción con `debit_note_id` en `documents` de la ND: al importar el
pendiente, la ND recupera su asiento y la cobertura vuelve a cero (E2E `e2e-igtf-especial`,
«revisión 3»). Queda el hueco VISIBLE mientras el pendiente no se importe, que es lo buscado.
**Re-revisión (20261002100200):** `accounting_coverage_gaps()` cambia su enunciado: la ND por
IGTF queda cubierta por el asiento O la fila en cola de su percepción, así que ya no aparece
como hueco mientras el pendiente espera. **Estado:** cerrado.

### R-67 · La llave por intento y la cuenta vendida exigen desplegar web, API y migración juntas (ADR-0076)

> **Estado 2026-10-02: ABIERTO hasta el despliegue** (M-01, M-02, M-03, E-08, O-02).

- **Severidad:** Media (dinero en caja) · **Disparador:** desplegar la API sin la web nueva, o la API sin
  las migraciones `20261003100000` y `20261003100100` (en ese orden, en la misma ventana).
- **API sin la migración:** `quickSale` y el PUT leen `sold_at` → `42703` → 500 en toda venta del POS con
  cuenta y en toda subida de cuenta. Ruidoso, no escribe nada.
- **API nueva con la web vieja:** la web vieja usa el id de la cuenta como llave. El servidor ya impide la
  segunda venta (POS_CART_SOLD), pero si la cuenta resucitada se cobra con EXACTAMENTE el mismo cuerpo,
  el middleware devuelve el replay de la venta vieja antes de llegar al dominio (M-02) hasta que la web
  nueva (que manda `attempt_id`) esté servida. El compose despliega web y API juntas: el riesgo es la
  pestaña abierta con el bundle viejo — se va al recargar.
- **Crecimiento:** las cuentas vendidas no se purgan (son la constancia de quién armó cada venta): una
  fila pequeña por venta del POS. Revisar si pasa del millón de filas por empresa.
- **Dueño:** el dueño del despliegue. **Deja de ser aceptable:** si la ventana entre API y web dura más que
  un día de caja.

### R-71 · El mayor al céntimo depende de una regularización post-pull, de una cuenta que el contador no ha confirmado, y no recalcula lo ya declarado (ADR-0075 §7)

**Qué:** las migraciones 20261003140000/140100/140200 llevan al céntimo todo lo NUEVO (kardex,
asientos, libro de compras). Lo VIEJO no se toca (append-only): la fracción heredada la limpia
`scripts/reparar/adr-0075-centimo.mjs` (`repairCents`), que hay que correr **después del pull**, con la
API nueva ya escribiendo al céntimo. Hasta que corra, `cent_gaps` sale en rojo en toda empresa con
historia, y una salida que vacía una posición vieja todavía escribe su fracción (el oráculo solo exige
céntimo sobre posiciones que ya lo están). **Mitigación:** la reparación es idempotente, tiene
`--ensayo`, deja acta `accounting.cent_regularized` (que es el corte del invariante) y comprueba que
`inventory_ledger_gap` no se mueve más que su fracción de céntimo; está en los post-pull de
`pnpm recorrido`. **La cuenta:** 5.1.10 «Diferencias por redondeo» (`rounding_difference`) y el
half-up son la respuesta del dueño; los confirma el contador (PENDIENTES_ASESOR P-79). Una empresa
cuyo plan ya tenía otra cuenta en 5.1.10 queda sin el papel: el generador encola diciendo «Falta
configurar la cuenta de: rounding_difference» cuando hay residuo. **K-08:** las declaraciones y los
libros ya generados (`fiscal_book_runs`, append-only) NO se recalculan; regenerar produce una corrida
nueva con hash nuevo, y una declaración ya presentada se corrige como diga la norma (LIVA art. 50:
ajuste en el período en que se detecta si no cambia el impuesto a pagar; sustitutiva si lo cambia): P-80.
**Despliegue — las migraciones del céntimo NO son compatibles con la API hoy desplegada.** Se
aplican **justo después del `git pull`, no antes**, en este orden y en la misma ventana:
1. `git pull && docker compose up -d --build` (la API nueva escribe al céntimo);
2. TODAS las migraciones pendientes, en orden (de la 20261003140000 a la última; las del céntimo
   son 140000, 140100, 140200, 190000, 190100, 190200 y 190300);
3. `select platform.grant_invited_owner_warehouse_ops();` (permisos; no postea nada);
4. `node scripts/reparar/adr-0075-centimo.mjs --ensayo`, y después sin `--ensayo`. Imprime una
   línea por empresa (regularizada, sin nada, o FALLÓ con su motivo) y sale ≠ 0 si alguna falla.
   **Va la primera de las que postean**: desde la 190000 la base rechaza al postear una línea con
   más de dos decimales (LAD71), y las demás arman su asiento desde saldos heredados;
5. `node scripts/reparar/adr-0070-subcuentas.mjs` (subcuentas de tesorería). Si se corre antes
   del paso 4 se niega con LAD82 «Corre ANTES la regularización del céntimo» y no deja nada a
   medias (migración 20261003190300); después del 4 reparte al céntimo y postea;
6. `node scripts/reparar/p-02-rif-normalizado.mjs` (no postea asientos; su sitio es indiferente);
7. `node scripts/reparar/adr-0075-divisa-del-mayor.mjs` (ADR-0075 §6): necesita las subcuentas
   del paso 5 y arma sus importes con `round_cents`.
Es el orden de `scripts/recorrido/correr.mjs` (la restauración del escenario lo ejecuta entero:
«✓ escenario restaurado», invariantes en 0 en E1, E2 y E3) y lo fija pgTAP 112 (`112_the_repairs_run_in_the_order_of_r71_test.sql`).
`scripts/ola2/regularizacion-inventario-y-caja.sql` (ADR-0060) es un guion manual de la ola 2 que
ya se corrió: si se volviera a usar, va DESPUÉS del paso 4, porque arma su asiento con el valor
del kardex tal cual.
**Entre el paso 1 y el 4 no se opera** (ventana de mantenimiento): un documento de compra en divisa
registrado ahí se asienta al céntimo y el libro lo convierte a 8 decimales (su `created_at` es
anterior al corte, migración 20261003190400); si su conversión deja fracción, la conciliación libro
↔ mayor de ese mes lo enseña.
Por qué no vale otro orden: con la 140000 aplicada y la API vieja, una salida parcial sobre una
posición al céntimo cuyo costo no es entero en céntimos da LAD41; con la API nueva y la base vieja,
el oráculo viejo exige 8 decimales y rechaza la salida al céntimo. Y desde la 190000 la base rechaza
al postear toda línea con más de dos decimales (LAD71): la API vieja, que asienta a 8, no postearía
nada en divisa, y un cierre de ejercicio o una reparación que mueva saldos todavía con fracción
falla hasta que corra el paso 3. Si el período de hoy está cerrado, el paso 3 falla para esa empresa
diciéndolo (LAD61) y no deja nada a medias: se reabre o se corre al abrir el siguiente.
**Revisión de la ola 3 (20261003190000/190100):** el libro de compras por alícuota de la 140100
perdía el signo de la nota de crédito, del ajuste de período anterior y de la anulada (HOMOLOGATION
YES); un libro de compras generado entre la 140100 y la 190000 lleva esos signos mal y se regenera.
En local las dos se aplicaron seguidas; **en producción la 140100 nunca debe quedar aplicada sin la
190000**. **La empresa SIN contabilidad** regulariza su kardex y no deja nada pendiente: la fila de cola nace descartada con su motivo y su acta (20261003190200), así que no bloquea el cierre cuando adopte la contabilidad; el kardex lo valora entonces el corte de ADR-0060. Si la adopta sin corte, procesando la cola histórica, `inventory_ledger_gap` puede quedar con céntimos (Σ round por movimiento ≠ kardex regularizado): se cierra con el corte. **Fracciones del kardex que netean a cero** con el mayor sin fracción: ya no falla ni hay que revisarla a mano; se regulariza el kardex y queda la misma fila descartada con acta. **Cierre de ejercicio:** se arma al céntimo y no muere en LAD71 aunque las fracciones viejas y la regularización caigan en ejercicios distintos; condición: correr el paso 3 ANTES de cerrar cualquier ejercicio, porque sin regularizar el saldo de toda la vida de las cuentas de resultado conserva la fracción que el cierre al céntimo deja fuera (`cent_gaps` la enseña). **La excepción de LAD71** es el registro privado `platform.cent_regularization_entries`, no una etiqueta: no darle GRANT nunca. **`--ensayo`** avisa además si el período de hoy está cerrado.
**Origen:** ola 3, P-01/P-03/K-08. **Estado:** abierto hasta que corra la reparación en producción y
el contador responda P-79/P-80.

### R-70 · El retiro sin precio en la lista principal no sale, y la Nota de retiro no se borra

**Qué:** una salida por consumo propio, regalo, donación o muestra en una empresa que factura se
valora al precio de la lista principal (ADR-0078 §3, P-75). Si el producto no tiene precio vigente
en esa lista, o falta la tasa de su moneda, la salida se rechaza (422 / EXCHANGE_RATE_MISSING) en
vez de registrarse sin débito: es el modo de fallo ruidoso elegido a propósito. Y las Notas de
retiro emitidas son append-only: una nota de más no se borra, se compensa con asiento del contador.
**Mitigación:** el mensaje dice qué falta (precio o tasa). **Despliegue:** la migración
20261003110000 añade cuentas y plantillas a las empresas existentes y redefine `sales_book`,
`sales_book_by_rate`, `sales_book_summary`, `recompute_iva_period` y `low_stock_products`;
va en la misma ventana que la API (la API vieja escribiría salidas sin `exit_reason`, que el CHECK
admite; la nueva no funciona sin la migración). **Origen:** ola 3, I-01/I-11. **Estado:** abierto.
**Disparador (auditoría fiscal de la ola 3, AF3-01, 2026-10-03):** RLIVA art. 31: el retiro exige
factura; la Nota interna no la sustituye. No liberar retiros en producción hasta la ola 5. (P-76;
nota de la auditoría fiscal en ADR-0078.)

### R-68 · La separación de funciones existe en la base y todavía no la exige ningún caso de uso

**Qué:** la migración 20261003130000 (ADR-0068 §8) crea `sales.refund`, `treasury.overdraft` y
`purchase.payment.approve` (solo del Dueño), el ajuste `company_settings.four_eyes`, el umbral de
pago a proveedor (USD 1.000 por omisión, regla interna decidida por criterio) y las funciones
`platform.four_eyes_active(empresa, permiso)` / `platform.approval_allowed` (por permiso desde 20261003130200). Hasta que G-20, D-11 y H-14 los hagan
cumplir, reembolsar y pagar por encima del umbral siguen como antes (sobregirar YA exige `treasury.overdraft` + motivo + acta desde D-11, ola 3: ADR-0066 nota §8; va solo al rol Dueño, así que tras desplegar cualquier otro rol que confirmaba sobregiros recibe 403), y no hay endpoint
para cambiar el ajuste ni el umbral (sería un cambio de contrato). **Mitigación:** el ADR y este
registro lo dicen; el pgTAP 101 fija la regla para cuando llegue su primer usuario. **Además:** la
purga de logos huérfanos (A-14) corre solo cuando la empresa sube un logo nuevo; una empresa que
no vuelve a cambiarlo conserva sus huérfanas (el worker no tiene credencial de Storage).
**Despliegue:** 20261003130000, 130100 y 130200 van con la API de la misma ola: la API vieja sigue
funcionando con la migración (solo cambia qué puede leer `authenticated` por PostgREST, que la web
no usa, y las policies de servicio, que la API ya cumplía por WHERE); la API nueva llama a
`company_logo_purgeable` tras cada logo; sin la migración esa purga falla con un aviso en el log y
el logo se guarda igual. **Origen:** ola 3, J-03/G-20/H-14/D-11/A-14.
**Estado:** abierto.


### R-69 · El enlace de invitación sin correo es un portador: quien lo tenga, entra (ADR-0077)

**Qué:** la migración 20261003120000 crea `member_invitations` y `platform.accept_member_invitation`.
Una invitación sin correo la acepta la PRIMERA cuenta que abra el enlace: si el dueño lo pega en un
grupo equivocado, entra otra persona con el rol elegido. Hoy no hay proveedor de correo, así que el
enlace se copia a mano. **Mitigación:** un solo uso (la segunda cuenta recibe 409), vence a los 7
días (la tabla no admite más de 30), el token lo genera la API y no se guarda en ninguna parte: la
base guarda su sha256 y la respuesta guardada para la idempotencia va sin él (revisión H2; antes de
la revisión sí quedaba en `idempotency_keys`); la invitación de Dueño exige correo (H7); quien invitó tiene que conservar `membership.manage` el día que se acepta, la entrada
queda en `audit_events` (`member.invited` y `member.invitation_accepted`, con quién invitó) y el
correo opcional liga la invitación a una cuenta. **Lo que falta:** listar y anular invitaciones
pendientes desde la web (no hay endpoint todavía: hoy se espera a que venza), y el envío por correo
cuando haya proveedor. **Además:** «Crear otra empresa» abre un tenant por cada negocio; la clave
natural es el nombre (o el RIF) entre los negocios de la persona, así que dos negocios con nombres
distintos y sin RIF los puede abrir el Titular sin límite (no hay plan de cobro que lo acote).
**Despliegue:** 20261003120000, 20261003120100, 20261003120200, 20261003120300, 20261003120400 y 20261003120500 van con la API y la web de la misma ola. La API vieja
no llama a las funciones nuevas; la API nueva sin la migración responde 500 en las rutas nuevas
(invitar, aceptar, otra empresa, acceso perdido); el middleware de alcance, que consulta
`lost_access_to_company` solo cuando la empresa no es visible, cae al 404 genérico si la función no
existe. **La migración se aplica antes que la API**, en la misma ventana.
**Origen:** ola 3, N-08/K-09/A-13/N-06. **Estado:** abierto.

### R-74 · El cálculo fiscal en Bs y el diferencial al pagar dependen de migración y API en la misma ventana (ADR-0075 §1-4)

**Qué puede pasar.** (1) La migración 20261003170000 fija el corte de `fiscal_amount_gaps` en el instante en que corre: una factura en divisa emitida con la API VIEJA después de ese instante sale en rojo en el invariante (su IVA en Bs es el de la regla anterior) y no se puede editar. (2) La API nueva escribe `settled_transaction_amount`, `settled_amount` y `exchange_difference`: sin la migración, todo cobro y todo pago a proveedor falla. (3) La plantilla `payment_made` pasa a leer `total` como lo cancelado: con la API vieja `total` = lo que salió y el asiento sigue cuadrando, sin diferencial (compatible). (4) El invariante `settled_ledger_gaps` suma las cuentas que la empresa tiene o tuvo con el papel `ar_general` / `ap_general`: una empresa que lleve la cartera en subcuentas por cliente fuera de ese papel no queda vigilada. (5) El cierre exacto del último cobro absorbe en el diferencial la separación entre total en Bs y total en divisa × tasa (P-85): en una factura de muchas líneas puede ser de varios bolívares aun a la misma tasa.
**Mitigación.** Migración y API en la misma ventana, la migración primero y sin emitir entre una y otra; `pnpm recorrido D E F G H` después; P-83, P-84 y P-85 con el contador y el asesor.
**Origen:** ola 3, familia «moneda A» (E-05, D-02, D-07, H-02, F-02, F-15, G-12). **Estado:** abierto.
**Añadido por «el cobro y el cierre» (ola 3, migración 20261003200000).** El punto (5) cambia: a la tasa del documento, pagar el total en Bs ya no deja diferencial (regla 2), y el diferencial del cierre tiene TOPE (regla 4, `SETTLEMENT_MISMATCH`). Lo que eso abre: (6) un documento cuyo mayor quedó descuadrado ANTES del corte (los residuos de P-84) ya no cierra absorbiendo el descuadre: su último cobro o pago se rechaza hasta que el contador lo regularice; (7) `SETTLEMENT_MISMATCH` responde 500 mientras `errors.ts` no lo mapee a 409 (el código y el mensaje viajan bien); (8) tras un abono en divisa el mismo día, `document_debt` enseña la parte proporcional del total y la caja pide lo que el mayor carga: en una factura de muchas líneas pagar la primera cifra puede responder «supera lo pendiente» (ADR-0075, nota «el cobro y el cierre», punto 3) — **CERRADO por la migración 20261003210100: lo mostrado es lo que cierra (`platform.document_settlement_base`)**; (9) `settlement_ledger_open` devuelve ahora una cifra donde devolvía NULL (cobro reversado en cola): un documento pagado con residuo que el invariante callaba empieza a salir en `settled_ledger_gaps`. **Mitigación.** Migración 20261003200000 y API en la misma ventana; `pnpm recorrido E` después; mirar `settled_ledger_gaps` por empresa tras aplicar.

**Corregido por «el mayor en divisa, la revaluación, las reversas y las lecturas» (ola 3, migración 20261003210000).** El punto (3) estaba mal: la plantilla `payment_made` EXIGE `exchange_difference` desde 20261003170000 y la API vieja no lo aporta, así que con la migración aplicada y la API vieja todo pago a proveedor iba a la COLA (no «sigue cuadrando»), y las filas `ap.payment_made` ya pendientes no podían generarse. Ahora el generador toma `exchange_difference` ausente como 0 (solo ese importe): el pago se asienta sin diferencial y la cola se vacía (E2E «un pago a proveedor con el contexto VIEJO se asienta»). El pago de la API vieja CON retención practicada (`total` = bruto, `net_amount` = neto) descuadraba contra la plantilla nueva por lo retenido (reproducido en E2E: «débitos 100 contra créditos 80»): el generador toma `net_amount` para la línea de cuentas por pagar de un pago sin `exchange_difference`, como lo asentaba la plantilla de entonces. El punto (7) queda cerrado: `SETTLEMENT_MISMATCH` está mapeado a 409 en `errors.ts`.

**Última ronda (20261003220000).** El residuo del cierre de un cobro o pago A LA TASA DEL DOCUMENTO ya no se asienta en las cuentas de diferencial sino en «Diferencias por redondeo» (AF-M03): los informes que lean `exchange_gain_loss` dejan de ver esos céntimos, y el mayor los muestra en 5.1.10. El borde del tope (`SETTLEMENT_MISMATCH`) tiene ahora prueba en ventas y en compras: un céntimo dentro de la cota pasa, uno fuera se rechaza.

### R-75 · La reversa de cobros y la divisa en el mayor dependen de una reparación post-pull, y dejan cuatro bordes sin construir (ADR-0075 §5, §6 y §8)

- **Severidad:** Alta · **Disparador:** aplicar 20261003180000 en producción; el primer cierre de período; la primera reversa de un cobro con IGTF
- **Dónde:** `platform.treasury_currency_gaps`, `scripts/reparar/adr-0075-divisa-del-mayor.mjs`, `closeFiscalPeriod`, `packages/domain/src/payment-reversals.ts`

1. **Orden del despliegue:** migración y API van en la misma ventana (la API vieja no escribe la divisa en la línea de caja; la nueva la escribe). Después del pull hay que correr `node scripts/reparar/adr-0075-divisa-del-mayor.mjs`: hasta entonces `treasury_currency_gaps` enseña cada caja en divisa. La reparación se salta una empresa con la cola de asientos pendiente o con el período de hoy cerrado, y lo dice.
2. **El primer cierre de cada empresa con cajas o cartera en divisa genera un asiento de revaluación** contra las cuentas de diferencial (4.1.02 / 5.1.02 en ve_basico). Sin la oficial vigente a la fecha de cierre, no más antigua que `closing_rate_max_age_days` (7 días, dato) —la fecha es el menor entre el fin del período y hoy; ver P-88—, o sin esas cuentas, el cierre falla con el mensaje que lo dice. El método (acumulado, sin reverso al abrir) es VALIDAR-CONTABLE (P-86).
3. **Anular un comprobante de retención soportada cambia el libro de ventas y la declaración del período** en que se cargó (los lectores filtran `registered`). Una declaración ya presentada no se reescribe: se corrige con sustitutiva (P-80).
4. **Bordes sin construir:** el cobro con IGTF documentado en nota de débito no se reversa (409); no hay pantalla de reversa; `exchange_gain_loss` no descuenta el diferencial de un cobro reversado; la reversa no exige saldo en la caja.
5. **Revisión de la ola 3 (migración 20261003210000).** Cerrado de los puntos de arriba: la reparación ya no se salta una empresa por la cola pendiente (el invariante la cuenta) y sale con exit ≠ 0 si alguna queda saltada, sin tasa o con fallo; la revaluación netea por cuenta (reabrir y cerrar a la misma tasa no asienta nada); `exchange_gain_loss` se lee sin el diferencial de los cobros reversados; anular un comprobante ya declarado se RECHAZA (409 `RETENTION_PERIOD_DECLARED`, P-89). **Lo que abre:** (a) la tasa de cierre exige una tasa oficial de no más de 7 días (`platform.parameters`, P-88): un cierre de un mes viejo sin tasas cargadas en su última semana se detiene hasta cargarla; (b) cerrar un período que no terminó fecha la revaluación HOY y usa la tasa de hoy; (c) entre cierres, la cartera del mayor queda sobrevaluada por lo revaluado de documentos ya cobrados hasta el cierre siguiente (P-86.4); (d) los asientos de regularización de la divisa posteados ANTES de esta migración son `manual` y siguen siendo reversibles a mano; (e) sin tasa de hoy, la deuda en divisa se sirve con el equivalente en `null`: la web tiene que decir «falta la tasa de hoy» (no verificado en pantalla; «Lo que me deben» del Inicio no distingue ese `null` del de «sin permiso»); (f) ~~las líneas de cuentas por cobrar y por pagar siguen sin la divisa del documento (H6)~~ cerrado en 20261003210200: llevan moneda, original y tasa del documento; lo que abre: `debit_amount` / `credit_amount` de esas líneas ya no son bolívares (todo lector tiene que usar `functional_*`), las líneas anteriores no se regularizan y ningún invariante suma aún los originales de la cartera; (g) un cobro viejo en otra moneda sin tasa con que valorarlo enseña su documento con la deuda en `null` (la lista no se cae), y sigue sin poder cobrarse hasta cargar la tasa.
6. **Última ronda (migración 20261003220000).** El original de la cartera deja de decidirse por parecido (determinista por hecho); a la tasa del documento el residuo del cierre va a «Diferencias por redondeo» y no a diferencial; el IGTF de un cobro reversado después de su quincena sigue contando en ella. **Lo que abre:** (a) una plantilla propia con dos líneas de cartera en un asiento las deja en moneda funcional; (b) el total de IGTF de un período depende del `to` con que se consulta — una consulta con un rango que no es una quincena da otra respuesta (no hay declaración de IGTF guardada); (c) el invariante cartera ↔ mayor en las dos monedas queda para la ola 4 (F-12); (d) migración y API en la misma ventana: el generador anterior (210200) sigue con su umbral hasta desplegar la API.
- **Estado:** abierto.

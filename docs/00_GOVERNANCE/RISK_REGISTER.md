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
columnas que PA SNAT/2011/00071 y PA 102 **nombran** —entregable hoy a un contador para revisión y
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

Un negocio obligado por el art. 8 **no puede** facturar por formatos libres, y el art. 49 le
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

> **Sobre la numeración.** R-16 a R-21 nacieron en `HANDOFF.md` durante los módulos de ventas,
> compras y contabilidad y siguen ahí. Este registro salta de R-15 a R-22 por eso, no porque se
> hayan perdido entradas. Consolidarlos aquí está pendiente y es trabajo de una sesión, no de esta.

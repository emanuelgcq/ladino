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

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
- **Estado:** construido en la ola 3 (2026-10-03, f16e8c6) — migración 20261003180000, ADR-0075 §8: `payment_reversals`, `POST /v1/payments/{id}/reversal` y `POST /v1/supported-retentions/{id}/reversal`. Lo que queda está en R-75.

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
   del paso 5 y arma sus importes con `round_cents`;
8. `node scripts/reparar/j-02-sobregiro-al-cierre.mjs` (J-02, R-79): **la última**. Reclasifica los
   cierres de caja en sobregiro asentados como ingreso (reversa + asiento nuevo contra «Cuentas por
   pagar a socios»). Trata también los que esperan en la cola con el origen de siempre, y al terminar cada empresa
   comprueba `platform.overdraft_closing_gaps` = 0. **Antes de «contabilizar pendientes»** (R-79 §6).
   Necesita las migraciones 20261004180000 a 180300, las subcuentas del paso 5
   (la reversa de un cierre anterior a ADR-0070 va a la subcuenta de su caja) y la API nueva ya
   desplegada (si no, la vieja seguiría produciendo cierres que reclasificar).
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
factura; la Nota interna no la sustituye. ~~No liberar retiros en producción hasta la ola 5.~~
(Corregido en la ola 5: esa frase no era un mecanismo y no debe leerse como tal. La ola 5 construyó
la factura de retiro —ADR-0082— y lo que la gobierna es un permiso: el retiro gravado de una empresa
que factura exige `sales.invoice.issue`. Liberar la emisión fiscal productiva es decisión del dueño
con el asesor, como para toda factura; ver R-90.) (P-76;
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

### R-76 · Las empresas que pusieron su RIF antes de la ola 4 conservan el nombre del negocio como razón social, y el primer RIF pide un campo nuevo a la API (A-05)

- **Severidad:** Media · **Disparador:** una empresa que nació sin RIF y lo puso antes de desplegar la ola 4 emite su primera factura; un cliente de la API que ponga el primer RIF sin `legal_name`
- **Dónde:** `packages/domain/src/company-profile.ts` (`cambiarRif`), `apps/web/src/pages/configuracion/MiEmpresa.tsx` (`DialogoRif`), `packages/schemas/src/companies.ts` (`SetCompanyTaxIdRequest`, `MePermissionsResponse`)

1. **Lo ya guardado no se repara solo.** El arreglo exige la razón social al poner el PRIMER RIF; no toca a quien ya lo puso. Esa empresa sigue con `legal_name` igual al nombre del negocio (en el escenario del recorrido, E1: «Bodega La Esquina» con RIF V) y su factura lo imprime como razón social del emisor (PA 00071 art. 13.5). Ningún dato distingue «no se la pidieron» de «su razón social es de verdad ese nombre» (una persona natural puede facturar con su nombre), así que no hay invariante ni reparación automática: se corrige en Mi empresa → «Editar», con motivo si ya emitió. En producción no hay clientes reales todavía; si los hubiera, es una revisión a mano de las empresas con `company.tax_id_changed` desde `PEND-…`.
2. **Contrato de la API ampliado, en la misma ventana que la web.** `PUT /v1/companies/tax-id` acepta `legal_name` y lo EXIGE para el primer RIF (422 si falta); `GET /v1/me/permissions` devuelve además `roles`. La web vieja contra la API nueva no puede poner el primer RIF (422 con el mensaje que lo dice); la web nueva contra la API vieja recibe 422 por el campo desconocido (el esquema es `strict`) y no ve `roles` (lo trata como vacío: el contador vería Contabilidad y Libros solo con datos). Se despliegan juntas, como siempre.
3. ~~El menú tarda hasta cinco minutos en enseñar Contabilidad o Libros~~ cerrado en la revisión de la ola 4: tras una venta de la caja, una factura a mano o postear un asiento, la sonda se repite si el hecho puede encender un módulo apagado (`debeResondear`). **Lo que queda:** un asiento que nace por otro camino (la cola contable que el worker postea, una nota, una compra) no dispara el refresco, y el menú lo ve al caducar la caché (5 min).
4. **Los roles se resuelven con una segunda copia de los joins de `platform.ladino_user_permissions`**, escrita en TS en `apps/api/src/routes/companies.ts`. Dos copias pueden divergir; hoy lo vigila el E2E `e2e-el-primer-rif-y-el-rol` (los roles devueltos explican exactamente los permisos; otro tenant recibe 404). **Mejora anotada:** una función `platform.ladino_user_roles(p_user, p_company_id)` junto a la de permisos, con su pgTAP, y que la ruta la llame.
5. **La corrección del RIF ya no pone un primer RIF.** `POST /v1/companies/tax-id/correct` sobre una empresa `PEND-…` responde 422 y remite a «Poner mi RIF»; antes lo ponía, con motivo y sin razón social.
- **Estado:** abierto.

### R-77 · El recibo de devolución de quien ya factura es un documento no fiscal emitido por un contribuyente, y la defensa del «formal» está puesta para un tipo que todavía no existe (M-12, M-10)

- **Severidad:** Media · **Disparador:** una empresa con RIF devuelve un recibo viejo; o alguien reabre el tipo `formal` sin terminar M-10.
- **Dónde:** `supabase/migrations/20261004110000_a_receipt_is_returned_with_a_receipt.sql` (`platform.assert_document_issuance`, `platform.assert_formal_line`), `packages/domain/src/sales.ts` (`createInvoiceLike`), `supabase/tests/121_receipt_return_after_rif_and_formal_guard_test.sql`.

1. **Un contribuyente emite un documento no fiscal.** Desde esta migración, una empresa en formas libres puede emitir `receipt_return` si el origen es un RECIBO suyo. Está acotado: no puede vender por recibo, no puede devolver una factura con él, no consume control y no entra al libro. Lo que no está acotado es el tiempo: un recibo de hace un año se puede devolver hoy. Si el asesor dice que esa devolución pide otro documento, es la pregunta P-93.
2. **La guarda del formal no la ejerce ningún camino de producto.** `formal` no se puede declarar (CHECK `company_taxpayer_types_declarable_chk` y 422 del dominio, P-38). La guarda «un formal no emite una línea gravada» solo la ejerce el pgTAP 121, que quita ese CHECK dentro de su transacción. Quien reabra `formal` tiene que construir el resto de M-10 (leyenda del PDF, relaciones, informativa, mensaje del dominio antes del de la base) y probarlo por la API: la guarda es el suelo, no la funcionalidad.
3. **La guarda mira la factura y la nota de débito, no la nota de crédito** (revierte un débito que ya existió). Si el asesor responde otra cosa a P-38 (5), cambia.
4. **Un trigger nuevo en `document_lines`** (`document_lines_formal`, solo para líneas gravadas): una lectura por clave primaria del documento por línea. No se midió su coste bajo carga; el WHEN deja fuera las líneas no gravadas y el camino del dominio inserta con el documento en borrador, donde sale en la primera comparación.
- **Estado:** abierto.

### R-78 · La tasa del día se lee sin permiso propio, el resumen cambia de forma y el orden por deuda calcula la deuda de todos los clientes (N-05, P-05)

- **Severidad:** Baja · **Disparador:** un rol al que no se le quería enseñar la tasa; una web o un cliente de la API que no conozca los campos nuevos; una empresa con miles de clientes que abre la lista ordenada por deuda.
- **Dónde:** `apps/api/src/routes/negocio.ts` (`GET /v1/negocio/tasa`, los `…_motivo` y `…_por_moneda` del resumen), `apps/api/src/routes/customers.ts` (`sort`), `apps/web/src/pages/negocio/Dinero.tsx`, `Inicio.tsx`, `apps/web/src/pages/clientes/Clientes.tsx`.

1. **`GET /v1/negocio/tasa` no exige permiso**, solo ser miembro de la empresa (el alcance lo valida el middleware). Es lo mismo que ya daban `/v1/exchange-rates` y `/v1/exchange-rates/preview`, y la tasa del BCV es pública; pero es una puerta más que enseña la tasa a quien no ve el dinero. Decidido por criterio; la alternativa era exigir `cash.close` o `fx.rate.manage`.
2. **El resumen ya no se cae sin tasa para lo que se debe a proveedores.** `platform.supplier_debt_today` lanza LAD51 sin tasa y tumbaba `GET /v1/negocio/resumen` entero; ahora el resumen pregunta antes si falta y manda `lo_que_debo: null` con `sin_tasa`. La función no cambió: `ap_aging` y los demás lectores siguen lanzando.
3. **El nominal por moneda de `sin_tasa` no incluye lo que no se puede calcular.** Un documento con un cobro viejo en otra moneda sin la tasa de su día tiene el nominal en `null` y no entra en la suma: la tarjeta dice «Lo que se conoce, sin convertir». El resumen no dice cuántos documentos quedaron fuera (el estado de cuenta sí: `unvalued_documents`).
4. **Contrato ampliado, web y API en la misma ventana.** La web nueva contra la API vieja recibe 404 en `/v1/negocio/tasa` y «Mi dinero» dice «No se pudo leer la tasa» (no «no hay»); el `sort` lo ignora la API vieja y la lista sale por nombre con la cabecera marcando el orden por deuda. La web vieja contra la API nueva no cambia.
5. **El orden por deuda calcula `platform.customer_debt_today` para TODOS los clientes de la empresa antes de paginar** (el orden por nombre solo para la página). No se midió bajo carga; no hay gate de coste. Con miles de clientes y documentos abiertos, es el primer sitio donde mirar.
6. **El color de la empresa se deriva de su id** (O-05): dos empresas pueden caer en tonos vecinos y nadie puede elegir el suyo; lo que las distingue de verdad es el logo.
- **Estado:** abierto.

### R-79 · El sobregiro al cerrar la caja pasa a un pasivo del dueño: depende de una reparación post-pull, y su hecho contable es un origen propio (J-02)

- **Severidad:** Media · **Disparador:** aplicar las migraciones 20261004180000, 180100, 180200 y 180300 y no correr la reparación; pulsar «contabilizar pendientes» antes de correrla, con un cierre en sobregiro esperando en la cola; cerrar una caja en negativo en una empresa con plan de cuentas propio; escribir una función que resuelva la caja de un hecho por `source_kind` y olvidar `cash_closing_overdraft`.
- **Dónde:** `supabase/migrations/20261004180000_the_overdraft_closed_is_owed_to_the_owner.sql`, `supabase/migrations/20261004180100_the_overdraft_closing_has_no_unconditional_leg.sql`, `supabase/migrations/20261004180200_the_overdraft_closing_is_its_own_source_kind.sql`, `supabase/migrations/20261004180300_no_overdraft_closing_is_booked_as_a_surplus.sql` (el invariante `platform.overdraft_closing_gaps`), `packages/domain/src/accounting.ts` (`contraAsiento`), `packages/domain/src/treasury.ts` (`hechoContableDelCierre`, `closeCashRegister`), `packages/domain/src/overdraft-closings.ts`, `scripts/reparar/j-02-sobregiro-al-cierre.mjs`.

1. **Entre la migración y el `git pull`, la API vieja sigue asentando el sobregiro como ingreso** (la plantilla de siempre no cambia; por eso la migración es «expand»). Esos cierres, y los anteriores, los corrige `node scripts/reparar/j-02-sobregiro-al-cierre.mjs` DESPUÉS del pull, la ÚLTIMA de las reparaciones (paso 8 de R-71; la reversa usa la subcuenta de la caja). Es idempotente. Si no se corre, el resultado de esos períodos queda inflado por cada sobregiro cubierto.
2. **La reparación fecha la reversa y el asiento nuevo el día del cierre si su período está abierto; si está cerrado, hoy.** Con el período cerrado, el resultado del mes del cierre NO se corrige en ese mes: la corrección cae en el mes en curso. Reabrir el período antes de correrla es la alternativa.
3. **Una empresa con plan propio (sin 2.1, o con 2.1.92 ocupado) no recibe la cuenta, y eso se ve en ROJO.** Su cierre en sobregiro va a la cola con «Falta configurar la cuenta de: owner_payable» (nunca a resultado), y mientras espera ahí **`treasury_ledger_gaps` da rojo para esa caja**: ese invariante compara el saldo de la caja con su subcuenta y NO cuenta la cola (el que sí la cuenta es `treasury_currency_gaps`, por `treasury_queue_pending`). El comentario de la migración 20261004180200 (líneas 28-31) dice que sin `treasury_queue_pending` los dos invariantes no contarían la cola: es inexacto para `treasury_ledger_gaps`, que no la cuenta nunca; la migración no se edita y la corrección vive aquí. Es el comportamiento de cualquier hecho de tesorería encolado, no uno nuevo. La reparación falla para esa empresa (exit 1, sin dejar nada a medias: E2E) hasta que el contador asigne el papel; asignado, la misma reparación termina.
4. **Decidido (2026-10-04, opción sin tocar aserciones): el hecho va en el ORIGEN.** El cierre en sobregiro se asienta como `cash_closing_overdraft / treasury.cash_register.closed` (migración 20261004180200): el evento es el real del outbox y el hecho contable distinto lo dice el `source_kind`, como `purchase_revaluation / ap.invoice_posted`. pgTAP 026 y 031 no se tocaron. Lo que queda de riesgo: quien enumere orígenes de tesorería tiene que nombrar los DOS (`cash_closing` y `cash_closing_overdraft`). Hoy lo hacen `platform.treasury_account_of`, `treasury_original_of` y `treasury_queue_pending` (redefinidas en la 180200), `TABLA_DE` en `journal-backfill.ts`, la lista de orígenes de `Contabilidad.tsx` y la comprobación de `scripts/recorrido/verificar/E.mjs`; `accounting_coverage_gaps` y `recompute_account_balance` no dependen del origen (miran la fila del cierre). Una función nueva que resuelva la caja por `source_kind` y olvide el segundo manda el cierre en sobregiro a la cola con `treasury_account_unmapped` (ruidoso). La base local conoció por unas horas el nombre anterior (`cash_closing / …overdraft_covered`): tras restaurar el escenario no queda ninguno.
5. **El código 2.1.92 es provisional** hasta que el contador lo confirme (P-36).
6. **CERRADO POR CONSTRUCCIÓN el 2026-10-04 (revisión en contexto limpio): el cierre en sobregiro que la API anterior dejó EN LA COLA.** Al importarse se asentaba con el origen `cash_closing` y el importe entero como ingreso, y entre el pull y la reparación quien pulsara «contabilizar pendientes» lo asentaba mal. Ahora `reprocessPendingJournals` (`packages/domain/src/journal-backfill.ts`), ante una fila de origen `cash_closing`, lee el CIERRE y decide el hecho con `hechoContableDelCierre`: si lo esperado fue negativo, descarta la fila con su acta (`accounting.pending_discarded`) y genera el hecho con el origen del sobregiro, por el mismo código que la rama B de la reparación (`requeueOverdraftClosingFromQueue`, `packages/domain/src/overdraft-closings.ts`). El orden «reparar antes de importar pendientes» deja de importar (E2E `e2e-sobregiro-encolado-y-contabilizar-pendientes`). Diferencias con la reparación, a propósito: el asiento lo firma la persona que importó (no el sistema) y las dos actas llevan `actor_type = 'user'`; la fecha es la de la reparación (el día del cierre si su período está abierto; si no, hoy), no la `posting_date` que guardó la fila. Riesgo que queda: solo cubre el camino de la cola; el cierre que la API vieja YA asentó como ingreso sigue necesitando la reparación.
7. **La reversa de la reparación es la canónica** (`contraAsiento`, la misma de `reversar`): al céntimo, con su línea de redondeo. No se pudo fabricar en un test un cierre viejo con fracción de céntimo en lo funcional (la base rechaza postearlo, LAD71), así que ese borde lo cubre la implementación compartida y no un caso propio. Lo que sí tiene caso propio desde la revisión: el cierre cuya cifra funcional GUARDADA (`cash_closings.functional_amount`) trae más de dos decimales; `hechoDe` la lleva al céntimo (`toCents`) antes de armar el hecho, y el asiento nuevo nace al céntimo. No se reprodujo ningún fallo con la cifra cruda (el generador redondea cada línea y lo del dueño ya es un número de céntimos): es endurecimiento, y evita que un contexto con fracción vuelva a la cola.
8. **La reversa solo traslada a la subcuenta de la caja la línea asentada en su cuenta PADRE** (`contraAsiento`, `cuentaSiAgrupa`). Antes trasladaba CUALQUIER línea cuya cuenta hoy agrupe: si la contrapartida del asiento viejo («Faltantes y sobrantes») había pasado a agrupar, la reparación la reversaba en la caja, posteaba y daba la empresa por reparada (reproducido en E2E). Ahora esa línea va a su cuenta de siempre y la base la rechaza (LAD62, `ACCOUNT_NOT_POSTABLE`), como en cualquier reversa: la reparación de esa empresa falla entera y sin escribir nada, hasta que el contador devuelva a esa cuenta su condición de hoja o se decida a qué subcuenta va. No hay camino automático para ese caso.
9. **La reparación se niega si no es la última** (`exigirElOrdenDeR71`): con algo que reclasificar, exige `cent_gaps` en cero y que ninguna caja esté sin subcuenta propia y hoja (`treasury_ledger_gaps`: `sin_subcuenta`, `no_es_hoja`, `compartida`), y dice qué guion correr antes. Sin esto NO fallaba (comprobado: posteaba en los dos desórdenes). Límites: no comprueba la reparación de la divisa (ADR-0075 §6); una sola caja mapeada a la cuenta de familia no es un hueco de `treasury_ledger_gaps` y no la detiene; y una empresa con `cent_gaps` en rojo por otra causa no puede reclasificar hasta arreglarla. El orden del guion del recorrido lo asevera el mismo E2E leyendo `scripts/recorrido/correr.mjs`; el pgTAP 112 no puede (ejerce funciones SQL, y la reparación J-02 es TypeScript).
10. **«En negativo» se mide en dos sitios con dos tablas de escalas**: la base usa `currencies.display_decimals` (`platform.currency_minor_units`) y el dominio el registro de monedas de `@ladino/money` (`minorUnitsOf`). Hoy coinciden (VES y USD, a 2). Una moneda nueva dada de alta en la base y no en el registro haría que el invariante y `hechoContableDelCierre` discreparan en el borde. pgTAP 128 §k ejerce la escala 0 en la base; el lado del dominio no tiene caso.
- **Estado:** abierto.

### R-80 · El gasto con factura es una factura de proveedor sin producto, pagada en el acto; el contrato de gastos se amplía y el comprobante deja de leerse por pertenencia (H-09, H-08, D-02)

- **Severidad:** Media · **Disparador:** un gasto con factura registrado; un informe que lea `expenses` o `supplier_invoice_lines.product_id` suponiendo lo de antes; un miembro sin `expense.read` que leía comprobantes por Storage.
- **Dónde:** `packages/domain/src/purchases.ts` (`registerInvoicedExpense`, `registerSupplierInvoice` con `FacturaDeGasto`, `previewSupplierPayment`), `apps/api/src/routes/treasury.ts`, migraciones 20261004170000 y 20261004170100, `apps/web/src/pages/negocio/Compras.tsx`, `apps/web/src/pages/compras/Compras.tsx`.

1. **`supplier_invoice_lines.product_id` ya puede ser nulo** (solo en la factura de un gasto: CHECK + trigger `LADH9`). Todo lo que lea esa columna suponiendo un producto —un informe de compras por producto, una exportación— recibe nulos. Se revisaron las funciones del esquema que la leen (`purchases_book`, `purchases_book_by_rate`, `retention_invoice_amounts`, `purchase_matching`, `receipts_pending_invoice`): ninguna une con `products`. No se revisaron los informes de la web que listan líneas de factura.
2. **El gasto con factura NO está en `expenses`.** El historial (`GET /v1/expenses`) y el resumen del negocio (`apps/api/src/routes/negocio.ts`, «lo que gané» sin contabilidad) unen las dos fuentes; con contabilidad, «lo que gané» sale del mayor y ya lo contaba. Cuenta como gasto la base si el IVA es crédito y el total si va al costo, en el día de la factura (o el contable). Cualquier lectura NUEVA de `expenses` (un reporte de gastos, una exportación) tiene que unir también `supplier_invoices` con `expense_category`: hoy no hay gate que lo exija.
3. **Contrato ampliado, web y API en la misma ventana.** `amount` pasa a opcional en `POST /v1/expenses` (el caso de uso lo sigue exigiendo sin factura), y la respuesta trae `supplier_invoice_id` e `invoice`. La web nueva contra la API vieja recibe 422 al mandar `invoice`. `POST /v1/supplier-payments/preview` es nuevo: contra la API vieja da 404 y el resumen del pago cruzado no aparece (el pago funciona igual).
4. **La vista previa del gasto (`POST /v1/expenses/preview`) registra y deshace una factura y un pago.** Enseña base, IVA, total, retenido y lo que sale de la cuenta en su moneda (con la tasa si cruza), y si la cuenta no alcanza lo dice junto a las cifras; el sobregiro se confirma al registrar. No deja huecos en el correlativo del comprobante de retención (`platform.claim_retention_voucher_sequence` es `max(sequence) + 1` bajo un candado de transacción), pero ese candado y el de la cuenta se toman mientras dura cada vista previa. La pantalla espera 400 ms de reposo y cancela la petición anterior; no hay límite de frecuencia propio en el servidor.
5. **El instrumento del pago del gasto es `otro`** (decidido por criterio: el gasto pregunta la cuenta, no la forma de pago). Los informes por instrumento verán esos pagos en «Otro».
6. **La policy del bucket `receipts` cambia para todos al aplicar la migración**: quien leía comprobantes por pertenencia y no tiene `expense.read` deja de leerlos. Es el arreglo, pero es un cambio de acceso con datos vivos. **Los comprobantes ya guardados como `.img` no se renombran**: conservan su ruta y su extensión. **Ninguna pantalla enseña el comprobante adjunto**: H-08 se cierra en la policy de Storage y en la subida, no hay todavía una vista que lo abra.
7. **Sin migración aplicada, la API nueva falla al registrar cualquier factura de proveedor** (`registerSupplierInvoice` escribe `expense_category`, `expense_attachment_path` y `expense_is_recurring`): las migraciones 20261004170000 y 20261004170100 van ANTES del `git pull`, y son «expand» (la API vieja sigue funcionando con ellas).
8. **El proveedor del gasto con factura se busca en el servidor (EntityPicker)**: no hay alta en línea desde el formulario del gasto; quien no lo tenga lo crea antes en Compras → Proveedores (con su RIF).
9. **El evento del outbox de una factura de gasto es `ap.expense_invoice_posted`, no `ap.invoice_posted`** (ADR-0080 §4). Se buscó quién dependía de `ap.invoice_posted` para todas las facturas: nadie en `apps/worker/src`, `apps/api/src`, `apps/web/src`, `scripts` ni en las funciones del esquema (solo un comentario en `platform.settlement_original_of`, que lee por `source_kind`). Un consumidor futuro que quiera todas las facturas de proveedor tiene que escuchar los dos.
10. **Un gasto con factura mal registrado no se puede corregir ni anular.** La NC de proveedor exige `product_id` por línea y no hay anulación de facturas de proveedor. Deuda con destino: ola 5, familia «NC de proveedor» (H-03).
11. **CERRADO el 2026-10-04 (ADR-0075, nota «el pago cruzado a tasa real»).** El pago cruzado tolera el redondeo de caja —media unidad mínima de la moneda del DINERO a la tasa del pago, 4,27 Bs a 854,4637—, lo funcional del pago es lo que se salda y la regla 4 sigue rechazando un descuadre con el mayor (E2E a 854,4637: `e2e-moneda-diferencial` «compras: el pago cruzado a TASA REAL», `e2e-gasto-con-factura` «a TASA REAL»). Riesgo que queda: el valor funcional de la línea de caja se aparta de «original × tasa» hasta esa tolerancia por pago, hasta la revaluación del cierre. Lo que decía: ~~Factura en Bs pagada desde una cuenta en divisa: 409 `SETTLEMENT_MISMATCH` casi siempre.~~ La moneda de la factura es la impresa (ADR-0080 §10) y el pago cruza por `registerSupplierPayment`; pero la cota de su tope (ADR-0075 regla 4) solo cuenta la unidad mínima de la moneda de la factura, y lo que sale se redondea al céntimo de la divisa (hasta medio céntimo × tasa, ≈ 4 Bs a 854). Solo cierra si la conversión cae exacta (el E2E usa 40 Bs/USD: 1 240 / 40 = 31,00). Observado con la tasa de otro E2E: 409, nada escrito, y la vista previa lo dice antes de confirmar. Es el mismo límite para cualquier factura de proveedor en Bs pagada desde una cuenta en USD (D-02). Decisión pendiente de la familia de moneda: ampliar la cota con la unidad mínima de la moneda del DINERO cuando el pago cruza.
12. **El formulario del gasto toma las cuentas de `/v1/treasury/accounts/candidates` cuando la persona no tiene `treasury.read`** (quien solo registra gastos recibía 403 de `/v1/treasury/accounts`). Las candidatas se arman por instrumento: una cuenta activa que no encaje en ninguna familia de instrumento no aparecería. No verificado contra todas las combinaciones de tipo y moneda de cuenta.
13. **El cuerpo de `POST /v1/expenses/attachment` admite 7 MB** (el archivo, 6 MB): con la cota de 6 MB para el cuerpo entero, el mensaje «pesa más de 6 MB» era inalcanzable y la persona recibía un 413. Sin `Content-Length` y por encima de 7 MB, el corte de `bodyLimit` sale como 500 (igual que en las otras subidas: logo e imagen de producto); no se tocó.
14. **`attachment_path` tiene que empezar por `<empresa>/receipts/`** (422 si no). Un cliente que guardara rutas con otra forma deja de poder registrar el gasto; la web solo manda la ruta que le devuelve la subida.
15. **La exclusión del servicio público domiciliado exige cuenta bancaria SOLO en el gasto con factura (AF4-01, auditoría fiscal del 2026-10-04).** PA SNAT/2025/000054 art. 3 num. 8 (reproducción ivecofi, no oficial; cotejo con la Gaceta pendiente): «pagados mediante domiciliación a cuentas bancarias de los agentes de retención». Desde la ola 4, `POST /v1/expenses` y su vista previa rechazan con 422 esa exclusión cuando la cuenta no es de clase banco (`company_accounts.kind`), y `GET /v1/retention-exclusions?account_id=` no la ofrece. Lo que queda abierto: (a) la factura de proveedor registrada SIN pago (`POST /v1/supplier-invoices`, la llegada) sigue aceptándola con su motivo, porque el medio de pago no se conoce todavía; (b) la clase de servicio no se valida; (c) «bancaria» es la clase de la cuenta, no una domiciliación comprobada: un pago por transferencia desde el banco pasa (P-95); (d) el código de la exclusión condicionada vive en el dominio (`EXCLUSIONES_CON_CUENTA_BANCARIA`), no en el catálogo: no entra en el hash de reglas de ADR-0079 (ver R-81); (e) un cliente que hoy marque esa exclusión pagando desde una caja pasa a recibir 422 (el rechazo es el lado ruidoso); (f) las facturas de gasto ya registradas con esa exclusión desde una caja no se tocan ni se listan: no verificado si existe alguna en producción.
- **Estado:** abierto.

### R-81 · La versión de reglas distingue datos, no lógica; el origen del acta es en parte declaración; y la tasa oficial solo deja acta si entra por el dominio (A-16, B-06, B-14 · ADR-0079)

- **Severidad:** Media · **Disparador:** una migración que cambia cómo se calcula un impuesto sin subir `platform.rules_releases`; una tabla de reglas nueva; una tasa global insertada por SQL; un proxy nuevo delante de Traefik.
- **Dónde:** las seis migraciones de la familia, en este orden: `20261004120000_the_audit_says_where_and_the_rules_have_a_version.sql`, `20261004120100_a_global_rate_never_goes_without_its_record.sql`, `20261004120200_the_rules_hash_is_deterministic_and_the_gaps_watch_everything.sql`, `20261004120300_no_settings_row_and_default_settings_are_the_same_rule.sql`, `20261004205000_documents_and_entries_carry_only_a_rules_version.sql` y `20261004205200_a_frozen_rules_version_stays_frozen_whatever_its_kind.sql` (quinta pasada: redefine `platform.stamp_rules_version` y `platform.rules_version_gaps`, que son las definiciones vivas); `packages/domain/src/accounting.ts` (`postJournalEntry` declara de nuevo al postear); `packages/db/src/origin.ts` y `transaction.ts`, `apps/api/src/middleware/origin.ts`, `packages/domain/src/tasa-oficial.ts`, pgTAP 122.

1. **El hash ve el contenido de las reglas, no su lógica.** Si una migración cambia una función de resolución (`resolve_tax`, `resolve_retention`) con las mismas filas, `rules_version` no cambia salvo que la migración inserte en `platform.rules_releases`. Es disciplina MANUAL, sin control automático: ninguna skill ni ningún gate lo comprueba (se escribió que «iba al checklist de la skill de migraciones» y no era verdad). Pasó en esta misma ola: nueve migraciones cambiaron lógica de reglas sin subir versión, y las recoge la nota de la 1.3.0. Regla vigente (ADR-0079 §8): basta UNA subida por ventana de despliegue. Decisión abierta del dueño: añadirlo al checklist de la skill o construir un control.
2. **Una tabla de reglas nueva no entra sola en el hash, y cambiar la definición del hash exige subir `platform.rules_releases`** (así se hizo tres veces en esta entrega: 1.1.0, 1.1.1 y 1.3.0). Hay que añadirla a `platform.rules_global_hash()` (con su trigger `zz_rule_set_state`) o a `platform.current_rules_version()` (con `zz_rules_version_cache`). `rule_set_drift()` detecta la tabla cubierta que cambia sin trigger; no detecta la que nadie cubrió.
3. **Una tabla nueva con `rules_version` necesita su trigger `*_90_rules_version`.** La migración lo pone a las nueve que existían. El pgTAP 122 lo pregunta al catálogo (cero excepciones): una tabla nueva sin él pone el gate en rojo, que es lo que se quiere.
4. **El registro no reproduce.** `platform.rules_versions` guarda versión y hash, no las reglas. Y el hash incluye los `id` de las filas: no es comparable entre local y producción.
5. **El canal `web`/`mobile` y el user-agent los declara el cliente**; la ip es el último salto de `X-Forwarded-For`. Con Traefik como único proxy es la del cliente; con otro proxy delante (un CDN) sería la de ese proxy. No verificado en producción. `device_id` sigue vacío.
6. **`LADINO_BUILD` depende de quien despliega.** `docker-compose.yml` la pasa a la API y al worker (`${LADINO_BUILD:-sin-declarar}`); si el dueño no la exporta antes de `docker compose up`, `app_build` dice `api@sin-declarar` / `worker@sin-declarar`: no queda vacío, pero no distingue despliegues.
7. **Una tasa global insertada fuera de `guardarTasaOficial` deja un acta MÍNIMA, no la de captura.** La migración 20261004120100 pone un trigger diferido en `exchange_rates`: al cierre de la transacción, la tasa global sin acta recibe `fx.rate.inserted_without_capture` (valor, fuente de la fila, rol), sin URL, hora de captura ni hash. Se eligió escribirla y no rechazar el insert porque rechazar rompería a la API desplegada y a las ~50 semillas de pgTAP, E2E y recorrido. Consecuencia: `system_audit_events` crece con cada tasa de prueba de los E2E en local (append-only, no se limpia), y una tasa que alguien borre después conserva su acta.
8. **ip y user-agent son datos personales** guardados en una tabla append-only: no se pueden borrar. Los lee quien tiene `fiscal.audit.read`. VALIDAR con el asesor si hace falta un plazo de conservación (no hay norma citada en `docs/02_COMPLIANCE/`).
9. **Contención, medida en local:** ~3 ms la primera fila con versión de cada transacción y ~70 ms por sentencia sobre una tabla de reglas global (migraciones y semillas). Un cambio de regla global toma un candado de fila en `platform.rule_set_state` hasta su commit.
10. **Las funciones del hash dependen de que su dueño (`postgres`) tenga `BYPASSRLS`** (migración 20261004120200). En local lo tiene. Sin él no devuelven un hash de cero reglas: fallan con `LADINO_RULES_HASH_BLIND` (`LAD00`) — y como todo insert con versión pasa por ellas, **fallaría toda escritura de la API**. Paso obligado del ensayo en seco del remoto, ANTES de aplicar: `select rolbypassrls from pg_roles where rolname = 'postgres';` tiene que dar `t`. Si da `f`, no se aplica y se decide otro dueño para esas funciones. La propia 20261004120200 llama a `platform.rules_global_hash()`: con el rol equivocado falla ella, no la primera venta.
11. **Cada fila lleva la versión vigente en el instante en que se escribe, no la del commit.** Los tres casos de uso que cambian una regla escriben su acta después del cambio. Pero un acta que escribe un TRIGGER al insertar la empresa (el del RIF) nace antes que las reglas que el alta añade después en la misma transacción (el régimen del registro sin RIF, el tipo de contribuyente): esa acta lleva, y registra, una versión que ningún estado comprometido tuvo. No se puede corregir sin reescribir una fila append-only. Las versiones intermedias ya registradas en local (por la API anterior al arreglo y por las corridas de prueba) se quedan: el registro es append-only y registrar no afirma «alguien la usó al commit».
12. **El mapeo contable y el método de costeo NO entran en el hash** (ADR-0079 §2): un cambio de plantilla de asiento o de `inventory_settings` no cambia `rules_version`. Es deuda aceptada por alcance y coste.
13. **Una cadena de sistema nueva hay que registrarla** en `platform.rules_versions` (`kind = 'system'`, con nota) en la misma migración o guion que la introduce; si no, `rules_version_gaps` se pone en rojo en la empresa donde escriba. El guion del recorrido registra la suya (`recorrido-2026-09-24`).
14. **Cerrado (migración 20261004205000): la factura de proveedor posteada entra en el invariante.** Las 3 de 103 sin versión que había en local no las producía el dominio (`packages/domain/src/purchases.ts:1251` la escribe): venían de cuatro fixtures de E2E que insertan por SQL, y el trigger ahora las sella.
15. **En documentos y asientos, `rules_version` ya no dice quién escribió.** Desde la 20261004205000 el trigger sustituye toda cadena que no sea una versión de reglas en `documents`, `supplier_invoices`, `retention_vouchers`, `supplier_retentions`, `inventory_withdrawal_notes` y `journal_entries`: un asiento de una reparación ya no se distingue por ese campo (`db-repair`), sino por su `source_kind`, su descripción y su acta. Y una tabla nueva que sea documento o asiento hay que añadirla a mano a la lista del trigger y al enunciado de `rules_version_gaps`.
16. **El corte de `rules_version_gaps` se movió a la 20261004205000.** Lo escrito entre la 120000 y la 205000 no se juzga: en producción es la misma ventana de despliegue y no se emite nada; en una base donde hayan pasado días entre una y otra (la local), esas filas quedan fuera del invariante.
17. **`global_rate_record_gaps` es global, no por empresa**, y las actas de las tasas de prueba de los E2E se acumulan en `system_audit_events`.
18. **Quinta pasada (migración 20261004205200, ADR-0079 nota).** Una fila ya emitida o posteada conserva su `rules_version` ante cualquier UPDATE, sea de reglas, heredada (`domain-s0.5`), de sistema o nula: lo heredado no recibe versión de reglas por ninguna vía. La lista de estados finales está escrita en el trigger Y en el invariante: un estado o una tabla nueva se añade en los dos. El asiento manual declara de nuevo al postear (`postJournalEntry`); un camino NUEVO que postee un borrador de otro día sin nombrar `rules_version` conservaría la versión del borrador, y el invariante no lo ve (es una versión de reglas válida). `rules_version_gaps` juzga lo emitido por el más tardío entre `created_at` y el instante de su estado final; no ve el borrador anterior al corte emitido después con fecha de emisión también anterior. Los fixtures de E2E que escribían `e2e` en `company_taxpayer_types` declaran ahora `domain-s0.5`; las 115 filas `e2e` ya escritas en la base local (114 empresas) se quedan hasta el próximo `db:reset`, y `rules_version_gaps` sigue en rojo para ellas.
- **Estado:** abierto.

### R-82 · Fiar exige permiso y límite por una sola puerta (la caja y la factura de administración): lo que queda fuera de ella, y los clientes existentes en límite 0 (E-09)

- **Severidad:** Media · **Disparador:** el primer deploy con clientes que ya debían; quien facturaba por administración (`POST /v1/invoices`) sin `sales.credit` o a un cliente en límite 0; un día sin tasa oficial; una deuda que sube por un camino que no pasa por la puerta (nota de débito, reversa de un cobro, contingencia); un cliente con saldo a favor sin aplicar.
- **Dónde:** migración `20261004140000_credit_needs_permission_and_a_limit.sql`, `packages/domain/src/sales.ts` (`quickSale`, `quotePos`), `packages/domain/src/customers.ts` (`setCustomerCreditLimit`), pgTAP 124, `apps/api/test/e2e-fiar-con-permiso-y-limite.test.ts`.

1. **CERRADO (2026-10-04, 71c73ab) · una sola puerta.** La regla del fiado es UNA función del dominio (`exigirFiado`, `packages/domain/src/sales.ts`) y la llaman la caja (`quickSale`, tras sus cobros) y la factura de administración (`emitirVenta` con bloqueo «rechazar»: `POST /v1/invoices`, también la que nace de un pedido, que entra por ese endpoint). Mismo código y mismo mensaje; el candado por cliente se toma antes de emitir en los dos caminos. Decidido por criterio (RESPUESTA §2.16; alternativa descartada: dejar la regla solo en la caja y vivir con este punto). **Lo que cambia para quien ya facturaba por administración:** con el cliente en límite 0 la factura se RECHAZA (409 `CREDIT_LIMIT_EXCEEDED`) hasta que alguien con `customers.credit.set` le fije el límite; quien emite necesita `sales.credit` (un rol propio que solo tenía `sales.invoice.issue` deja de poder facturar por administración); y **sin la tasa oficial de hoy no se factura por administración** (409 `EXCHANGE_RATE_MISSING`, punto 3: la deuda no se puede medir contra el límite), también en una empresa que vende en bolívares — antes esa factura no necesitaba tasa. El «Consumidor final» no recibe factura de administración con saldo (422, el mismo mensaje de la caja). **Lo que NO pasa por la puerta, decidido por criterio y dicho:** (a) el registro de una factura de CONTINGENCIA (`POST /v1/fiscal/contingency-invoices`, exige `fiscal.contingency.manage`): refleja un papel que ya se entregó, y rechazarlo dejaría un documento fiscal fuera del libro — alternativa: exigirle la regla y obligar a subir el límite antes de registrar; (b) la nota de débito (`createDebitNote`): sube la deuda por su propio motivo (corrige un documento que ya existe) — alternativa: medirla contra el límite; (c) la reversa de un cobro: reversar un cobro no es vender a crédito, es deshacer un cobro que no fue. La hace quien tiene `ar.payment.reverse` (dueño y contador), no quien vende. La venta reabierta vuelve a deber SIN pasar por el límite —el cliente puede quedar por encima de él, y no se le fía más hasta que baje— y, si era de contado, no tiene fecha de vencimiento: figura vencida desde el día siguiente a su emisión (R-86). Decidido por criterio; alternativa descartada: exigir `sales.credit` y límite a quien reversa (dejaría sin deshacer un cobro que no existió —un cheque devuelto, una transferencia que no llegó— por una regla que es de la venta). E2E `e2e-fiar-con-permiso-y-limite` («R-82.1 · UNA SOLA PUERTA»): límite 0 → 409; sin `sales.credit` → 403; con ambos → 201; pasado el límite → 409 con las dos cifras; ningún rechazo deja documento. No hay E2E del «Consumidor final» por administración: sobre forma libre lo corta antes `exigeFormaLibre` con otro mensaje (el camino no se distingue por la respuesta). Texto original del punto: **La regla vive en `quickSale`, no en `createInvoice`.** Una factura emitida por administración (`POST /v1/invoices`) nace sin cobro —es crédito por definición— y no pasa por `sales.credit` ni por el límite. El cajero tiene `sales.invoice.issue`: por la API puede fiar sin límite. La web del cajero no le ofrece esa pantalla, pero eso es ausencia de mecanismo, no prohibición (CLAUDE.md §2). Cerrarlo es decidir qué es «a crédito» en la factura de administración (¿toda factura sin cobro?, ¿plazo?), y eso cambia la semántica de un endpoint que usan cuarenta E2E: **es decisión del dueño**. Tampoco pasan por la regla la nota de débito ni la reversa de un cobro, que suben la deuda por su propio motivo.
2. **Los clientes existentes quedan en límite 0** (decidido por criterio, lo más estrecho). Conservan su deuda y la pueden pagar; no se les fía más hasta que alguien con `customers.credit.set` les fije el límite. En el primer deploy, un negocio que fía a diario verá «a este cliente todavía no se le fía» en todos: hay que fijar límites en la misma ventana. Alternativa descartada: sembrar como límite la deuda de hoy.
3. **Sin tasa oficial de hoy no se fía a NADIE, deba o no** (empresa con moneda funcional distinta del USD). `exigirFiado` corre con la venta YA emitida dentro de la transacción (`packages/domain/src/sales.ts`, llamadas en `emitirVenta` y `quickSale`), así que la deuda que lee nunca es cero: incluye esta venta, y `platform.customer_credit` necesita la tasa del día para decirla en USD (migración `20261004140000`, rama `v_tasa is null` → `debt_usd` NULL). Sin tasa devuelve NULL y la venta fiada se rechaza con 409 `EXCHANGE_RATE_MISSING` (modo de fallo ruidoso), también al cliente que no debía nada. De contado se le sigue vendiendo. Alternativa descartada: usar la última tasa conocida. ~~Un cliente sin deuda sí puede fiar ese día dentro de su límite solo si la venta misma se puede valorar.~~ (era falso: corregido en la revisión de la ola 4, por lectura del código; no hay E2E del día sin tasa.)
4. **La deuda en bolívares se mide en dólares de HOY.** Un documento en Bs pesa menos contra el límite a medida que el bolívar se devalúa; uno en USD pesa su nominal. Es coherente con «el fiado se ancla en USD», pero un negocio con listas en Bs verá el disponible crecer solo.
5. **El candado es por cliente, en los dos caminos de la puerta** (la caja, `quickSale`, y la factura de administración, `emitirVenta`): dos fiados simultáneos al mismo cliente se serializan (`pg_advisory_xact_lock` sobre `customer_credit:<cliente>`, tomado antes de emitir). El E2E original («dos fiados simultáneos: entra UNO») va por la MISMA serie y no lo distingue del candado del correlativo, que ya serializaba. **Aislado en la revisión de la ola 4** (`e2e-fiar-con-permiso-y-limite`, tests «R-82.5»): caja por la serie A con un producto y administración por la serie B con otro —no comparten correlativo, talonario ni posición de kardex—; (i) diez rondas de carrera, entra exactamente una y la otra recibe `CREDIT_LIMIT_EXCEEDED`; (ii) sin azar, en los dos sentidos: con el primer fiado parado en su kardex (documento emitido, sin commitear), el segundo queda en la cola de ESE candado (`pg_locks`, por su clave) y, soltado, recibe el 409. **La variante rota, y su límite:** en ese mismo instante la deuda leída desde otra sesión no incluye la venta del primero (deuda 0, disponible entero): es lo que leería un segundo fiado sin candado, y cabrían los dos. No es el código corriendo sin el candado —no hay interruptor para quitarlo, ni debe haberlo—; la ejecución real sin candado (mutando el artefacto compilado) se intentó una vez y quedó **inconclusa** (otra suite borró la tasa global a mitad: los fallos fueron `EXCHANGE_RATE_MISSING`, no la carrera). `test:concurrency` sigue sin cubrirlo (es del outbox). **Verificación:** el fichero entero pasó en el gate de la ola 4 sobre base limpia y en serie (`e2e-fiar-con-permiso-y-limite`: 18 de 18, 2026-10-04), incluidos los dos tests sin azar tras corregir el formato de su literal («0.00» contra «0»). Lo que sigue sin hacerse: correrlo varias veces seguidas para medir la estabilidad de las diez rondas de carrera, y una variante rota de verdad (el código sin el candado).
6. **`sales.credit` lo traen cajero, encargado, administrativo y dueño** (decidido por criterio). Lo que acota al cajero es el límite, que no puede fijar. Un rol propio creado antes de esta migración no lo trae: sus personas dejan de poder fiar hasta que se lo concedan.
7. **CERRADO por lectura (2026-10-04, 71c73ab; no ejecutado).** Los guiones de pantalla del recorrido que fían (`scripts/recorrido/e-vender.mjs`, `e2-extra.mjs`, `f2-retencion.mjs`, `n-usuarios.mjs`) fijan el límite antes de fiar (`fijarLimiteDeFiado` de `lib.mjs`: por la base, como soporte, con su acta `system`) y rellenan «¿Cuándo paga?» (`rellenarCuandoPaga`, P-05). No se corrieron: la próxima reconstrucción del escenario desde cero es su primera ejecución (R-86.9). ~~no fijan el límite antes: la próxima vez que se reconstruya el escenario desde cero se pararán en «Fiar».~~
8. **Un saldo a favor sin aplicar NO resta de la deuda que se mide contra el límite.** `platform.customer_debt_today` suma facturas, recibos y notas de débito (`kind in ('invoice','receipt','debit_note')`); los saldos a favor del cliente no entran. Un cliente con saldo a favor puede ser rechazado «por límite» (409 `CREDIT_LIMIT_EXCEEDED`) aunque en neto no deba: hasta que se le aplique el saldo a una de sus ventas, o pague con él la nueva. Decidido por criterio: el saldo a favor se usa pagando con él, no es un descuento automático de la deuda. Alternativa: restarlo en la función de deuda (cambia LA función de deuda, ADR-0075 §5, y lo que enseña la ficha del cliente). Sin test propio.
9. **La descripción del permiso decía «Fiar en la caja».** Corregida por la migración `20261004210100_the_credit_permission_says_what_it_governs.sql` («Vender a crédito (fiar en la caja y facturar a crédito)…»): solo el texto de `public.permissions.description`; el reparto no cambia. Ninguna pantalla ni endpoint sirve hoy esa descripción. El nombre que SÍ lee la persona en el 403 genérico es `"sales.credit": "fiar"` (`apps/api/src/middleware/errors.ts`), que no se tocó.
- **Estado:** abierto.

### R-83 · La ventana de anulación vive en el caso de uso, «su caja» es una aproximación, y el reembolso cambió de permiso (G-10, G-07 · ADR-0061, nota de la ola 4)

- **Severidad:** Media · **Disparador:** un `UPDATE … set status = 'annulled'` por SQL o por un caso de uso nuevo; una empresa con varias cajas y turnos; un rol propio o un administrativo que reembolsaba; la respuesta del asesor a P-91.
- **Dónde:** migraciones `20261004160000_annul_only_what_never_left_and_the_cashier_returns.sql` `20261004160100_the_annulment_rule_fails_closed.sql`, `20261004160200_the_annulment_paper_is_watched_and_back_office_refunds.sql` y `20261004160300_declared_means_closed_one_cash_rule_and_direct_credit_notes.sql`, `createDirectCreditNote`, `annulInvoice` / `annulmentStatus` / `refundCustomerCredit` (`packages/domain/src/sales.ts`), pgTAP 126 y 126b, `apps/api/test/e2e-anular-o-nota.test.ts`.

1. **La regla no se IMPIDE en la base: se mira.** `platform.invoice_annulment_blockers` responde y quien la obedece es `annulInvoice`. No hay trigger (decenas de fixtures pgTAP anulan por SQL facturas fechadas en el pasado). La segunda capa es el invariante `platform.annulment_paper_gaps(empresa)` (migración 20261004160200, pgTAP 126b, línea en `scripts/recorrido/invariantes.sql`): una factura anulada por otra vía desde el corte da fila con su cláusula. Lo que queda: (a) delata DESPUÉS, no impide; (b) el corte vive en `platform.invariant_cutoffs`: borrar y recrear la fila deja sin mirar lo anulado entre medias; (c) las tres cláusulas de papel se preguntan a la misma función que usa el caso de uso: si la función se equivoca, el invariante no lo ve; (d) solo corre donde corre el recorrido: en producción nadie lo consulta de oficio todavía.
2. **«Su caja» es una aproximación, ahora uniforme (migración 20261004160300).** El documento no guarda el puesto que lo emitió. Cualquier cierre de una CAJA de la empresa (`company_accounts.kind = 'cash'`; de la misma sucursal si documento y cierre la llevan) posterior a la emisión impide anular, tenga o no cobros el documento: en un negocio con dos cajas y cambio de turno a mediodía, una factura de las 11:00 —fiada o cobrada en la otra caja— deja de poder anularse cuando cierra cualquiera de las dos. Es más ancha que la primera versión (que, con cobros, miraba solo las cuentas de esos cobros y no veía el cierre de la caja física si el único cobro fue por banco y se reversó). Falla del lado ruidoso (409 que manda a la nota de crédito), a propósito. Decidido por criterio; alternativa descartada: mirar solo las cuentas de los cobros.
3. **El «período declarado» es el de la casa (B-1) y ya no bloquea por sí solo.** Declara solo una fila de `iva_period_results` generada DESPUÉS de cerrar su período (`period_to < caracas_day(created_at)`, la definición de la migración 20261002120400); una vista previa del período en curso no (antes sí: dejaba sin anular todas las facturas del día con el mensaje falso «ya se declaró»). Consecuencia: `period_declared` no puede dispararse junto a «mismo día» —el período de una factura de hoy no ha cerrado—, así que **queda como red de seguridad** y como segunda razón del invariante, siempre detrás de `not_same_day`. Un período declarado fuera del sistema (planilla hecha a mano) sigue sin dejar fila; como la regla que de verdad corta es «mismo día», eso ya no abre nada. Las dos funciones dejaron de ser de `authenticated` (ese rol no ve `iva_period_results` y la cláusula callaba).
4. **El reembolso cambió de permiso.** `refundCustomerCredit` exigía `sales.return.manage` y ahora exige `sales.refund`. Lo tienen el Dueño y el administrativo (`back_office`, migración 20261004160200, decidido por criterio; alternativa: solo el Dueño); el cajero y el encargado no. Un ROL PROPIO que reembolsaba con `sales.return.manage` deja de poder hasta que se le conceda `sales.refund`: la migración no toca roles de tenant.
5. **La nota de crédito directa tiene su permiso, y el cajero no lo tiene (migración 20261004160300).** `createDirectCreditNote` exige `sales.credit_note.direct` en lugar de `sales.return.manage`. Lo reciben en la migración TODOS los roles que tenían `sales.return.manage` —el Dueño, el administrativo y los roles propios creados por cada dueño: nadie pierde lo que podía hacer— menos el cajero de sistema. Lo que queda: (a) un rol propio que sea un «cajero» hecho a mano con `sales.return.manage` también lo recibe (la migración no distingue intenciones): el dueño se lo quita si no lo quiere; (b) un rol propio creado DESPUÉS con `sales.return.manage` no recibe el nuevo solo, y su 403 dice qué permiso falta; (c) revertir «solo los de la migración» exige haber guardado la lista de roles que lo recibieron; (d) con la migración aplicada y la API saliente todavía sirviendo, el cajero sigue emitiendo notas directas (esa API exige `sales.return.manage`): va JUSTO DESPUÉS del `git pull`. Decidido por criterio; alternativa descartada: dejarle al cajero `sales.return.manage` entero.
6. **`040_named_roles_test.sql:117` afirma que el cajero tiene EXACTAMENTE 6 permisos** y este cambio no la tocó: con `sales.return.manage` (20261004160000) y `sales.credit` (R-82) tiene 8. La ajusta la consolidación de la ola, con su antes y su después; hasta entonces esa aserción está en rojo.
7. **Compras: «una factura de proveedor anulada no se registra» es un aviso, no un control.** Decidido por criterio: habla de la factura que el proveedor anuló antes de que saliera de su negocio; la pantalla lo dice al registrarla y nada lo impide (Ladino no puede saber que el proveedor la anuló). Lo ya registrado y luego anulado sigue R-2 ampliada. Alternativa descartada: sacar del libro de compras las anuladas ya registradas.
8. **Las clientes de la API que anulan facturas sin `originals_in_hand: true` reciben 409.** La web se despliega junto con la API; en `apps/mobile` no hay ninguna llamada a `/annul` (búsqueda del 2026-10-04).
9. **La ventana de despliegue tiene dos filos.** (a) Con la 20261004160000 aplicada y la API SALIENTE todavía sirviendo, el cajero reembolsa: esa API exige `sales.return.manage` para sacar el dinero, y la migración se lo acaba de dar. (b) El corte de `annulment_paper_gaps` es el `now()` de la 20261004160200: una factura que la API saliente anule después de ese instante no lleva `originals_in_hand` en su acta y deja una fila `originals_not_confirmed` que no se puede corregir (el documento y el acta no se editan). Las tres migraciones van por eso JUSTO DESPUÉS del `git pull`, mientras se construye la imagen, y no horas antes; y la API entrante no arranca sin la 160000 (el detalle del documento y `annulInvoice` llaman a `platform.invoice_annulment_blockers`). Si (b) ocurre, se decide entonces: no se añade una lista de perdones al invariante.
10. **La carrera con un cierre de caja en vuelo (S1 de la revisión).** `annulInvoice` bloquea el DOCUMENTO (`for update`, `packages/domain/src/sales.ts`), no la caja. Un cierre cuya transacción empezó antes y todavía no commiteó es invisible para `invoice_annulment_blockers`: la anulación pasa. Cuando el cierre commitea, su `closed_at` es el `now()` de SU transacción (`packages/domain/src/treasury.ts:993`), anterior a `annulled_at`: la factura queda anulada «después del cierre» y `annulment_paper_gaps` la señala (`cash_closed`) sin que nadie haya hecho nada mal y sin poder corregirla. Ventana: lo que dure la transacción del cierre. No se cerró: exigiría que anular y cerrar compitan por un mismo candado (de empresa o de caja), que es otra decisión.
11. **Dos relojes en la misma comparación (S2 de la revisión).** `issued_at` sale del reloj de NODE (`new Date().toISOString()`, `sales.ts:1953` y `:4977`) y `closed_at` del `now()` de POSTGRES. La cláusula `closed_at >= issued_at` compara instantes de dos máquinas: con el reloj del contenedor de la API adelantado N segundos respecto de la base, una factura emitida hasta N segundos ANTES de un cierre se lee como emitida después y ese cierre no la bloquea (y al revés, atrasado, bloquea de más). Hoy API y base están en hosts distintos (VPS y Supabase Cloud). Es la familia «una fecha contra un punto de reloj» (CLAUDE.md §3) en su variante de dos relojes. No se cerró: el arreglo es fechar la emisión con el reloj de la base, que toca la emisión entera.
- **Estado:** abierto.

### R-84 · El cobro con sobrante y el reembolso en otra moneda: una ventana de despliegue, dos migraciones en orden, y lo que la pantalla todavía no hace (F-10, G-05, G-15, F-12 · ADR-0075, nota «ola 4 · cobros»)

- **Severidad:** Alta durante el despliegue; media después · **Disparador:** aplicar las migraciones sin desplegar la API en la misma ventana; una migración posterior que reconstruya el CHECK de `amount_source` con una lista escrita a mano; un asiento manual sobre la cuenta por cobrar.
- **Dónde:** migraciones `20261004150000_a_credit_in_favor_keeps_its_currency.sql` y `20261004190000_an_overpayment_is_born_as_a_credit_in_favor.sql`; `registerPayment` y `refundCustomerCredit` (`packages/domain/src/sales.ts`); `packages/domain/src/journal-generator.ts`; `packages/domain/src/payment-reversals.ts`.

1. **No es «expand» para el cobro (como R-74).** Desde que se aplica la 20261004190000, la plantilla del cobro pide `credit_surplus`; desde la 20261004150000, la del reembolso pide `total`. La API NUEVA los aporta (o los toma como 0 / como `functional_amount` en una fila vieja de la cola). La API ANTERIOR no: **todos sus cobros** quedarían en la cola de pendientes con «la plantilla pide el importe credit_surplus» si la empresa tiene contabilidad. Las dos migraciones se aplican JUSTO DESPUÉS del `git pull`, sin operar entre medias.
2. **El orden limpio importa.** La 20261004180000 reconstruye el CHECK de `amount_source` con su lista y rechaza (LAD82) lo que no conoce: por eso `credit_surplus` va en la 190000 y no en la 150000. La 190000 LEE el CHECK vigente y le añade el importe; una migración posterior que vuelva a escribir la lista a mano lo perdería (fallaría al validar las líneas que ya existen: ruidoso).
3. **El sobrante con IGTF se rechaza** (P del asesor sobre el anticipo): con un pago en divisa que causa IGTF, pagar de más sigue respondiendo 422 «entrega el vuelto».
4. **Reversar un cobro con sobrante** retira su saldo a favor (queda `expired`, que la pantalla lee «Retirado (se reversó su cobro)»; antes, «Vencido»). Si ese saldo a favor ya se usó, el cobro NO se reversa hasta deshacer ese uso; un reembolso no tiene reversa hoy, así que un cobro cuyo sobrante se reembolsó no se puede reversar (cada caso dice lo suyo). **Tercera ronda:** ese saldo retirado se podía APLICAR por la API, la reversa de esa aplicación lo devolvía a `available` y entonces se reembolsaba en efectivo — dinero que salía dos veces. Cerrado en el dominio (solo se usa un saldo `available`) y en el esquema (trigger `customer_credits_retired`, 20261004190200). La base local conserva un saldo resucitado por el test en rojo; lo acusa `customer_credit_ledger_gap` (`unborn`).
5. **No era un céntimo en el pasivo: eran 3,41 Bs por saldo, para siempre.** Una NC con IVA nace por su total en Bs (E-05): 2,78 USD a 854,4637 cargaron 2.378,82 y cada uso bajaba importe × tasa (2.375,41 en total). **Decisión nueva (ADR-0075 decisión 5, invertida):** cada uso baja la parte proporcional de lo que el saldo cargó y el que lo agota se lleva el resto exacto; el pasivo de cada saldo a favor termina en 0,00 y la revaluación parte de lo que el mayor carga. Los saldos en divisa usados ANTES de la 20261004190200 conservan su residuo (en producción no hay ninguno: la 150000 se despliega en la misma ventana).
6. **`receivables_ledger_gap` acusa cualquier asiento manual sobre la cuenta por cobrar** (y una apertura de saldos hecha con asiento manual). Es su oficio, pero una empresa que lleve su cartera inicial por asiento manual lo tendrá en rojo hasta que esa cartera entre como documentos. No cubre cuentas por pagar.
7. **Lo que canceló un cobro se guarda al cobrar** (`payments.cancelled_functional_amount`) y se comprueba contra lo que se asienta: si las dos cifras se apartan, el cobro responde `SETTLEMENT_MISMATCH` y no se registra. En los cobros anteriores a la migración el invariante lee lo que su asiento acreditó (para ellos no comprueba nada nuevo).
8. **La devolución con reembolso usa `whole: true`**: el diálogo manda el total de la nota en bolívares en `amount` y el servidor no lo usa. Un cliente de la API que reembolse una nota en divisa mandando el total en bolívares SIN `whole` recibe 422 («el saldo a favor disponible es …»).
9. **Pantalla** (corregido en la tercera ronda: lo que este punto decía ya no era cierto). El reembolso desde el estado de cuenta SÍ ofrece confirmar un sobregiro (D-11: `treasury.overdraft` y motivo) y SÍ hay comprobante imprimible, no fiscal, del cobro y del reembolso (`GET /v1/payments/:id/pdf`, `GET /v1/customer-refunds/:id/pdf`); el de un cobro reversado dice que su saldo a favor se retiró. Sigue abierto: el importe de un campo de dinero se enseña con punto decimal después de leerlo.
10. **Las cabeceras de las migraciones 20261004150000 y 20261004190000 dicen «la API anterior respondería 422» y no es así: ENCOLA.** Con la plantilla pidiendo un importe que la API anterior no aporta, el generador deja el hecho en la cola de pendientes; el cobro o el reembolso se registran y su asiento queda pendiente. Una migración creada no se edita: se corrige aquí y en ADR-0075.
11. **Siete migraciones, en orden, en la misma ventana, JUSTO DESPUÉS del `git pull`:** 150000, 190000, 190100, 190200, 190300, 190400, 190500 (la 190400 añade al invariante la fila `unborn`; la 190500 quita a PUBLIC el EXECUTE de la función del trigger). La 190300 existe porque la 190200 dejó sus funciones (`security invoker`) llamando a `platform.round_cents` sin EXECUTE para `ladino_api`: aplicada sola, aplicar o reembolsar un saldo a favor responde 404. **No aplicar la 190200 sin la 190300.**
12. **Aplicar un saldo a favor ahora tiene tope** (antes consumía de más y dejaba la cuenta por cobrar negativa): un cliente de la API que mandaba el saldo entero contra un documento menor recibe 422 con el importe que sí puede aplicar.
13. **El lector de importes rechaza «1,234» y «26,003»** (un separador y tres cifras, sea punto o coma). El único campo de la web que lee con él algo que no es un total es el COSTO de un producto (`apps/web/src/pages/negocio/Productos.tsx`, `MoneyInput`): un costo unitario con exactamente tres decimales tecleado «1,250» se rechaza con su mensaje y hay que escribirlo «1,2500» o «1.25». Ninguna cantidad ni tasa pasa por `readAmountText`. **Ampliado al cerrar la familia F-06 (2026-10-04):** ya no es «el único campo». Todo precio y costo unitario tecleado en la web pasa por el lector de importes —el pedido al proveedor (`HacerPedido.tsx`), la llegada de mercancía, el precio de «Ya llegó la factura», la factura y la nota de crédito de proveedor (`pages/compras/Compras.tsx`) y la nota de débito (`DetalleFactura.tsx`)—: antes «1,250» se leía ahí 1,25 y «1.500» 1,5; ahora los dos se rechazan con su motivo y un unitario de exactamente tres decimales se escribe con cuatro. Las cantidades, tasas y porcentajes tienen lector propio (`leerCantidad`, `forms.tsx`), que sí pasa por `readAmountText` salvo el caso «una sola coma»: «1,250» es 1,25 y «1.250» se rechaza. Dos consecuencias a vigilar: (a) una cantidad PROPUESTA por el sistema se pinta ahora con coma decimal (lo que falta por recibir de un pedido, lo que falta por facturar de una orden): con punto, «1.125» lo rechazaría el lector sin que nadie lo tecleara; (b) en devolución, nota de crédito y nota de débito una fila ilegible ya no se descarta en silencio: bloquea el botón y dice por qué. No se abrió en navegador.
14. **CERRADO (cuarta ronda): la regla de valoración del estado de cuenta ya no vive en el handler.** `GET /v1/customers/:id/statement` valoraba en SQL dentro de `apps/api/src/routes/sales.ts` lo que resta una nota de crédito (G-04) y el saldo a favor en divisa «a la tasa de hoy; sin ella, a la de nacimiento» (G-05); `vencidoDe()` (P-05) estaba en el mismo sitio. Son ahora `customerStatement` y `customerOverdue` en `packages/domain/src/customer-statement.ts`, con el mismo SQL: ninguna cifra cambia y no hay migración. **Lo que queda en la ruta:** `GET /v1/customers/:id/aging` todavía arma en el handler los tramos de `platform.ar_aging` (redondeo a 2 y «null si un tramo es null»); no era parte del encargo y no se movió.
15. **`platform.customer_credit_carried` no sabe que un saldo fue RETIRADO.** Para un saldo `expired` (la reversa del cobro que lo creó) responde su importe de nacimiento —medido en el recorrido: 100,00 Bs— mientras el mayor carga 0,00 por ese saldo, y su comentario dice «lo que el mayor todavía carga». Hoy no hace daño: `fx_revaluation_items` excluye `status = 'expired'`, el dominio rechaza usar o reembolsar un retirado antes de leerla, y `customer_credit_ledger_gap` da cero filas. Pero es una función de dinero cuya respuesta contradice su enunciado, y un llamador nuevo que no filtre revaluaría o bajaría un pasivo que no existe. Corregirla es una migración que redefine una función de dinero: decisión del dueño. De paso: `fx_revaluation_items` filtra por el estado de HOY, no a la fecha — una revaluación a una fecha anterior a la reversa deja fuera un saldo que ese día sí estaba vivo (no verificado con un caso).
16. **El punto 3 decía «responde 422 "entrega el vuelto"» y solo es cierto en efectivo.** Un pago de más en divisa que causa IGTF lo rechazan tres caminos con el mismo código y tres mensajes: por omisión (`amount` = lo entregado, IGTF dentro) lo corta `pasoDeCobro` —con Zelle o USDT, «…esta forma de pago no da vuelto. Ajusta el monto.»; con efectivo en divisas, «…sobran X USD. Registra lo que queda en caja y entrega el vuelto.»—, y la regla del anticipo (F-10 + IGTF) solo llega a hablar con `igtf_included: false`. Los tres están aseverados por su mensaje en `apps/api/test/e2e-cobros-cuarta-pasada.test.ts`.
- **Estado:** abierto.

### R-85 · La tasa del día tiene un margen para TODO: lo que se detiene, lo que se recalcula distinto y lo que el margen no decide (regla 8 · resto de D-09 · ADR-0075, nota «ola 4 · una sola regla de la tasa»)

- **Severidad:** Alta si la fuente de la tasa se cae más días que el margen; media en lo demás · **Disparador:** `asegurarTasaOficial` sin fuente más de 7 días; aplicar la migración sobre una base con cobros viejos en otra moneda; un test o un operador que escriba el margen.
- **Dónde:** migración `20261004195900_the_rate_of_the_day_has_one_rule.sql` (`platform.rate_for`, `platform.closing_rate`, `platform.parameters.official_rate_max_age_days` y su alias); `mensajeFaltaTasa` (`packages/domain/src/tasa-oficial.ts`).

1. **Con la fuente caída más de 7 días, la empresa deja de operar en divisa.** Antes vendía, cobraba y pagaba con la última tasa, de la antigüedad que fuera; ahora toda operación que convierte responde `EXCHANGE_RATE_MISSING`. No hay carga a mano (ADR-0064 §1): el único remedio es «Traer del BCV» o subir el margen (un `update` del dato). Es el modo de fallo ruidoso, elegido a propósito; el silencioso era facturar a una tasa de hace un mes.
2. **Lecturas que recalculan a una fecha pasada cambian sobre datos que ya existen.** `document_balance_transaction_at` valora con la tasa del día del cobro un cobro en otra moneda anterior a 20261003170000 (sin lo saldado congelado): si ese día no tenía tasa dentro del margen, el saldo pasa a NULL y el cierre se detiene (LAD51, dice el día). El historial de precios (C-11) deja ese día sin cifra. La consulta de comprobación previa al despliegue está al pie de la migración: debe dar 0 filas.
3. **CERRADO por la migración `20261004200000_a_payables_list_never_falls.sql` (revisión de la ola 4) — y sustituido por otro riesgo.** La deuda con proveedores «a la tasa de hoy» LANZABA (LAD51) sin tasa dentro del margen, también sobre una factura en divisa ya pagada: el estado de cuenta de un proveedor al que no se debía nada respondía 500. Ahora `platform.supplier_debt_today` devuelve 0 para lo pagado o sin saldo y **NULL** para lo que se debe y no se puede valorar; `platform.ap_aging` lleva el tramo en NULL; `GET /v1/suppliers/:id/statement` y `/aging` sirven `null` con `sin_tasa` y el nominal por moneda, y la pantalla dice «Falta la tasa de hoy». **Lo que queda:** NULL no es cero y `sum()` / `greatest(x, 0)` lo descartan en silencio — todo llamador nuevo de esas dos funciones tiene que mirar el NULL (`case when bool_or(x is null) then null …`), o enseñará un total sin la deuda en divisa. **La API anterior a esta entrega NO lo mira:** con esta migración aplicada y la API vieja en marcha, «Lo que debo» y el estado de cuenta enseñan un total SIN la deuda en divisa cuando falta la tasa (silencioso). Por eso la migración va **justo después del `git pull`**, nunca antes.
4. **El margen es un dato GLOBAL que mueve todas las conversiones.** `e2e-moneda-deuda-reversa` lo pone en −1 un instante para probar el cierre: antes solo afectaba a la tasa de cierre; ahora, durante ese instante, ninguna empresa de esa base tiene tasa. Los E2E corren en serie (`fileParallelism: false`), así que dentro del gate no se nota; con dos procesos sobre la misma base, sí.
5. **Las lecturas de «la tasa del día» preguntan por mañana** (`apps/api/src/routes/negocio.ts:65` y `:406`, `hoy + 1`): el margen se mide desde mañana, así que avisan «falta» un día antes de que una operación de hoy se detenga, y pueden enseñar una tasa fechada mañana que la operación de hoy no usa. Es anterior a esta ola; no se tocó.
6. **El valor 7 no sale de ninguna norma** (P-22, P-88), y LIVA art. 25 (día no hábil → día hábil siguiente) sigue sin aplicarse.
7. **No todos los mensajes dicen el día.** `mensajeFaltaTasa` («Falta la tasa BCV del dd/mm/aaaa. Tráela en Mi dinero.») lo usan `tasaA` (compras), `tasaHoy` (tesorería) y `condicionDePago` (cobros). La llegada conserva el suyo (tiene aserción) y las demás consultas de tasa de `sales.ts`, `inventory.ts`, `products.ts` y las rutas conservan los que tenían: el código es el mismo en todas. *Revisión de la ola 4:* la vista previa de conversión (`previsualizarConversion`), `GET /v1/negocio/convertir` y las dos tasas del vuelto (`apps/api/src/routes/sales.ts`) decían «No hay tasa» habiéndola vieja; ahora usan `explicarFaltaDeTasa` y dicen «la última guardada es del dd/mm/aaaa».
8. **Cargar la tasa oficial de un día PASADO es hoy una operación de plataforma sin pantalla** (decisión abierta del dueño; P-22). Mi dinero solo trae la publicada hoy (ADR-0064 §1: no hay carga a mano), así que una operación fechada en un día sin tasa dentro del margen no tiene remedio desde la aplicación. `mensajeFaltaTasa(dia, hoy)` ya no promete «Tráela en Mi dinero» para un día pasado: dice «No hay tasa BCV guardada para el dd/mm/aaaa. Fecha la operación en un día con tasa, o escribe a soporte para cargar la oficial de ese día.» El remedio real —un `insert` en `public.exchange_rates` por el dueño de la base, que deja el acta `fx.rate.inserted_without_capture`— no tiene procedimiento escrito ni fuente exigida. Mientras no se decida (pantalla de plataforma con fuente citada, o carga automática de la serie histórica), «escribe a soporte» es una promesa que cumple una persona.
9. **Cambiar el margen deja acta, pero no pide permiso ni motivo.** Desde `20261004200000`, todo insert, update o delete de `platform.parameters` escribe `platform.parameter_changed` en `system_audit_events` (clave, valor anterior y nuevo, rol; la escritura espejo del alias deja la suya con `mirrored_from`). El acta dice QUÉ cambió y con qué rol de base, no QUIÉN ni por qué: el parámetro solo lo escribe el dueño de la base, por SQL. `TRUNCATE` sobre `platform.parameters` no está vigilado (dejaría a `rate_for` sin margen: falla cerrada, ninguna tasa, y sin acta). Los E2E que mueven el margen (`e2e-moneda-deuda-reversa`) dejan actas en la base local.
10. **Nadie vacía los parámetros, y el espejo se reconoce por su marca (migración `20261004200100`, re-revisión de la ola 4).** `TRUNCATE platform.parameters` no dejaba acta (el trigger del .9 es de fila) y dejaba a `rate_for` sin margen: ahora un trigger de sentencia lo rechaza (`0A000`, con mensaje). Y el acta reconocía la escritura espejo por `pg_trigger_depth() > 1`, que etiquetaba `mirrored_from` cualquier cambio hecho desde el trigger de otra tabla: ahora la reconoce por la marca `ladino.parameter_mirror_of` que pone el trigger espejo. **Lo que queda:** la marca es un GUC que cualquier sesión puede escribir (solo etiqueta un acta, no autoriza nada, y solo quien ya puede escribir el parámetro llega a ella); las actas escritas entre `20261004200000` y `20261004200100` pueden llevar un `mirrored_from` puesto por la profundidad y no se corrigen; una herramienta de restore que trunque la tabla con los triggers activos recibirá el error (no verificado contra el procedimiento de restore del proveedor).
11. **Sin tasa, un saldo A FAVOR en divisa con un proveedor no resta del total de su estado de cuenta; con tasa, sí** (`apps/api/src/routes/purchases.ts`, `GET /v1/suppliers/:id/statement`; decidido por criterio en la re-revisión). Una factura en divisa de saldo negativo y sin tasa hacía el total NULL con `sin_tasa` y el nominal vacío, mientras la antigüedad de la misma respuesta no la contaba. Ahora `sin_tasa` es solo «deuda sin valorar», como en `ap_aging` y en el resumen del negocio; el saldo a favor queda en su fila, en su moneda, con `balance_today` en null. **Alternativa descartada:** total NULL con el nominal negativo («Se debe −4,00 USD»): cambia lo que el contrato dice de `sin_tasa` y el texto de la pantalla. Es raro (hace falta un pago o una retención de más y la fuente caída más que el margen) y no es silencioso del todo —la fila lo enseña—, pero el total de ese día no es el del día siguiente.
12. **Una operación fechada en el FUTURO se admite** (gasto, pago y factura de proveedor: no hay validación que la rechace; no se añadió). Si ese día queda dentro del margen de la última tasa guardada, se convierte con ella; más allá, `EXCHANGE_RATE_MISSING` dice ahora la verdad («todavía no se ha publicado»), en vez de mandar a Mi dinero por una tasa que no existe. Si una fecha futura debe rechazarse es una decisión del dueño.
- **Estado:** abierto (el .3 cerrado; .8 y .9 nuevos; .10 a .12 de la re-revisión).

### R-86 · El fiado tiene vencimiento: lo viejo cuenta como vencido desde su emisión, la API anterior no manda la fecha y el papel de la forma libre no la imprime (P-05, E-22 · ADR-0075, nota «el vencimiento»)

- **Severidad:** Media · **Disparador:** el primer día tras el despliegue (la lista «Vencido» de un negocio que ya fiaba); una caja con la web vieja en caché; una factura a crédito impresa sobre forma libre.
- **Dónde:** migración `20261004210000_a_credit_sale_has_a_due_date.sql`, `packages/domain/src/sales.ts` (`vencimientoValido`, `emitirVenta`, `quickSale`, `quotePos`), `apps/api/src/routes/customers.ts` y `sales.ts` (lo vencido), `apps/api/src/routes/documents-pdf.ts`, pgTAP 132, `apps/api/test/e2e-el-fiado-vence.test.ts`.

1. **Toda venta fiada anterior al despliegue no tiene fecha y cuenta como VENCIDA desde el día siguiente a su emisión** (decidido por criterio: una deuda sin plazo acordado es exigible desde que nace). El primer día, la columna «Vencido» de quien ya fiaba es igual a su columna «Deuda», menos lo emitido hoy. No se puede poner fecha después: el vencimiento de un documento emitido es inmutable (LAD06). Alternativa descartada: una ventana para fechar lo viejo (abre una escritura sobre documentos emitidos).
2. **La migración es expand y va ANTES del `git pull`; la API anterior no manda `due_date`.** Entre la migración y el despliegue, las ventas fiadas siguen entrando sin fecha (y vencen el día de su emisión). Desde el despliegue, la caja la exige. **API y web van juntas** (un solo `docker compose up`): una pestaña con la web vieja en caché contra la API nueva no puede fiar (422 «Di cuándo paga el cliente» sin campo donde decirlo) hasta recargar; de contado vende igual.
3. **La factura de administración sin «Vence» vence el día en que se emite** y al día siguiente ya figura como vencida. Es lo decidido (el campo es opcional), y sorprende a quien factura a 30 días sin llenarlo.
4. **Sobre la forma libre no se imprime nada del crédito.** «A CRÉDITO», «Saldo pendiente» y «Vence» van en el recibo y en la copia de cortesía de la factura, no en `destino=papel` ni `vista`: el tope de filas (PA 00071 art. 33) está medido contra el cuerpo actual. La factura que el cliente se lleva en papel no dice cuándo vence. Si la forma libre puede o debe llevar las condiciones de pago: P-101.
5. **El saldo impreso es el de la fecha en que se imprime**, no el de la emisión: dos impresiones del mismo recibo con un abono en medio dicen saldos distintos (y una vez pagado, no dicen nada). Sin tasa de hoy, un documento en divisa imprime solo su nominal.
6. **No hay invariante que vigile que una venta de caja con saldo lleve fecha.** El documento no dice de forma fiable si nació en la caja (`cart_id` es opcional). La regla vive en `quickSale` con su E2E; un camino nuevo que emita fiado sin pasar por ahí no lo vería ningún gate.
7. **Lo vencido «a otra fecha» se valora a la tasa de HOY.** `platform.customer_overdue_today(…, p_today)` decide con `p_today` qué está vencido, pero el valor en bolívares sale de `platform.document_debt`, que usa la tasa de hoy. `GET /v1/customers/{id}/aging?reference_date=` hereda eso (como ya lo hacían sus tramos).
8. **Coste de la lista.** Con `with_debt=1` cada cliente llama dos veces a la función de deuda por documento (deuda y vencido), y el orden por vencido la calcula para todos los clientes antes de paginar, como ya hacía el orden por deuda. Sin medición ni presupuesto: no verificado con una cartera grande.
9. **Los guiones de pantalla del recorrido** (`e-vender.mjs`, `e2-extra.mjs`, `f2-retencion.mjs`, `n-usuarios.mjs`) fijan el límite por la base (`fijarLimiteDeFiado`, la única escritura de un guion) y rellenan «¿Cuándo paga?». Arreglados por lectura: **no ejecutados**.
- **Estado:** abierto.

### R-87 · La paleta y lo que se dejó de prometer: «Compartir» sin probar en un navegador, la búsqueda sin índice y una lectura de ventas que sigue abierta por otra ruta (P-06, E-06, B-01 · ADR-0081)

- **Severidad:** Baja · **Disparador:** una caja en un navegador que no comparte archivos, o con la red lenta; una empresa con cientos de miles de documentos; un rol a medida sin permisos de ventas.
- **Dónde:** `apps/web/src/compartir.ts`, `apps/web/src/pages/negocio/Vender.tsx` (`VentaLista`), `apps/api/src/routes/search.ts`, `apps/web/src/app/palette.tsx` y `paleta-acciones.ts`, `apps/web/src/app/accion-pedida.ts`.

1. **«Compartir» no se abrió en ningún navegador.** Lo cubren pruebas unitarias con un navegador simulado (`apps/web/test/compartir.test.ts`), no una hoja de compartir real. El botón solo se pinta si `navigator.canShare({ files })` dice que sí. El PDF se baja ANTES de llamar a `navigator.share`, y el navegador exige que la hoja se abra a raíz de un toque reciente: con una red lenta puede negarse; entonces se avisa («No se pudo compartir… Abre el PDF y envíalo desde ahí») y queda el PDF. Falta probarlo en un teléfono real (Android e iOS). Mitigación si falla: bajar el PDF al abrir «Venta lista» y tenerlo listo.
2. **La paleta, sus acciones y los diálogos que abren (`?accion=nuevo`, `?accion=cerrar-caja`) tampoco se abrieron en un navegador.** La lógica de qué se ofrece está probada sin React (`paleta-acciones.test.ts`) y la búsqueda con E2E; el teclado (flechas, Enter, Escape), el foco visible y la apertura de los diálogos se revisaron por lectura.
3. **La búsqueda no usa índice.** `ilike '%…%'` sobre la serie y el número compuestos, acotada por `company_id`. Con el volumen de hoy es una lectura corta; no hay gate de coste. Si una empresa llega a cientos de miles de documentos, hace falta un índice (migración).
4. **La ruta nueva exige permiso y `GET /v1/documents` todavía no** (se cierra en la ola 6). Hasta entonces, un rol que la paleta deja sin resultados puede seguir listando ventas por la otra ruta.
5. **Una cotización no se encuentra por número** (nace sin él) **y una compra no abre su detalle** (no hay pantalla de detalle de una factura de proveedor): lleva a la lista.
6. **Quien empieza sin productos ya no tiene «¡Listo!»**: la tarjeta final de `/empezar` pide cargar un producto. Decidido por criterio (ADR-0081 §1).
- **Estado:** abierto.

### R-88 · La nota de crédito del proveedor: el saldo a favor no es una entidad, sobre una factura retenida incluye lo retenido, y dos invariantes sin variante rota (H-03, AF4-02 · ADR-0083)

- **Severidad:** Media · **Disparador:** una nota de crédito de proveedor sobre una factura ya pagada (toda factura de gasto lo está) o sobre una factura con retención practicada; una nota escrita fuera del caso de uso.
- **Dónde:** `packages/domain/src/purchases.ts` (`registerSupplierCreditNote`), migraciones `20261005110000` y `20261005110100`, `apps/web/src/pages/compras/Compras.tsx` (`NotaCreditoProveedor`).

1. **El saldo a favor con un proveedor es una cuenta del mayor (1.1.09, provisional: P-105), no una entidad.** Desde la revisión (migración `20261005110200`) ya no vive en cuentas por pagar. Sigue sin aplicarse a otra factura y sin reembolso: si el proveedor devuelve el dinero, no hay dónde anotarlo. En el AUXILIAR la factura abonada de más sigue con saldo negativo (`supplier_invoice_balance`), y las listas de cuentas por pagar y el estado de cuenta del proveedor lo siguen enseñando como saldo negativo de esa fila, no como un activo aparte: `supplier_debt_today` y `ap_aging` no se tocaron. Construirlo es una funcionalidad propia (decisión del dueño).
2. **Sobre una factura con retención, el saldo a favor incluye lo retenido.** La nota abona el total y el proveedor solo recibió el neto: lo retenido no se ajusta ni se emite nada sobre el comprobante (`retention_untouched`). Es la conducta que ya había, ahora visible. VALIDAR-SENIAT: P-103. Hasta la respuesta, esa cifra no se le reclama al proveedor sin el contador.
3. **CERRADO en la revisión.** ~~`settled_ledger_gaps` cambió su enunciado.~~ Volvió a su enunciado de siempre (`20261005110200`); el saldo a favor lo vigila `platform.supplier_credit_ledger_gap`, con su variante rota (`e2e-nc-proveedor`, último caso; pgTAP 135 h). Las notas registradas ENTRE la 110000 y la 110200 (solo bases de desarrollo) dejaron su saldo a favor en cuentas por pagar y ese invariante las da por fila en sus empresas de prueba.
4. **La cobertura del kardex por el asiento de la nota (`purchase_credit_note` en `inventory_coverage_gaps` e `inventory_ledger_gap`) sigue sin variante rota** (el estado mixto —nota posteada, ajuste en cola— sí tiene su test). La ejerce por su nombre el caso «REBAJA» del E2E (su revalorización solo la cubre ese asiento); no se probó que sin ese origen el movimiento salga como hueco.
5. **Que la mercancía diga `kind` es una regla del caso de uso, no del esquema.** Una nota insertada por SQL sin `correction_kind` acredita inventario y no mueve el kardex. Un trigger lo impediría, y rompería los fixtures de pgTAP 022 y 067, que insertan notas a mano: no se puso.
6. **Las notas anteriores a esta entrega no se regularizan.** En local no había ninguna; en producción no se consultó. Si existe alguna, su importe sigue en `inventory_ledger_gap` y se corrige con un ajuste de inventario.
7. **Una factura abonada entera por una nota sigue en `posted` con saldo cero**, no pasa a `paid`: sigue apareciendo entre las facturas por pagar con 0.
8. **La pantalla no se abrió en un navegador.** Typecheck, lint y pruebas de la web en verde; el diálogo (selector de qué pasó con la mercancía, depósito, líneas) se revisó por lectura.
9. **La primera versión de la migración nació rota y lo vio el E2E, no la migración**: `document_incomplete` como columna generada hacía que la guarda de documentos de compra rechazara toda nota. La 110100 la corrige; las dos van siempre juntas.
10. *(R-88, añadido en la revisión)* **Lo que la pantalla todavía no hace:** no pregunta el lote al devolver un producto por lotes sin recepción (lo dice y el servidor lo rechaza con su mensaje); «documento incompleto» no se ve en ninguna lista ni en el libro de compras, solo al registrar; el saldo a favor no aparece como tal en el estado de cuenta del proveedor.
11. *(R-88)* **Devolver mercancía VENCIDA exige `inventory.expired`** sobre el depósito (LAD46): quien registra la nota sin ese permiso recibe el rechazo del kardex. No se probó ese camino.
12. *(R-88)* **Una nota que cierra la factura reconoce el diferencial pero no cambia su estado**: la factura queda `posted` con saldo cero.
13. *(R-88)* **Las plantillas de la nota se ampliaron EN SITIO** (seis líneas) en cada empresa. Una empresa cuyo plan propio no tiene 1.1 no recibe la cuenta: sus notas con saldo a favor esperan en la cola hasta que asigne el papel.
14. *(R-88, tercera ronda)* **Puntos que esta ronda cierra o cambia.** El 4 (variante rota de la cobertura del kardex): cerrado, `e2e-nc-proveedor` «6b». El 10 (el lote y «documento incompleto» a la vista): construidos, sin abrir en un navegador. El 11 (lote vencido sin `inventory.expired`): probado, 403 que nombra el permiso. El 12 y el 7 (**la factura `posted` con saldo cero**): sigue `posted` —no se toca el significado de `paid`— y ahora la mira `settled_ledger_gaps` (rama nueva, corte `settled_by_supplier_credit_note`; migración `20261005110600`); un pago sobre ella se rechaza con su mensaje. Alternativa descartada: pasarla a `paid`.
15. *(R-88)* **`inventory_ledger_gap` tuvo una regresión entre la 110200 y la 110500**: con la nota en la cola, `en_cola` contaba dos veces su ajuste. Corregida; queda sin tocar el ajuste DESCARTADO con acta con la nota posteada (no cuenta en `en_cola`).
16. *(R-88)* **La nota encolada se reprocesaba mal** (`journal-backfill.ts`): perdía `credit_surplus` y su enlace. Corregido y probado («C6b»). Las notas que ya se hubieran reprocesado desde la cola antes de esta entrega quedarían con el exceso en cuentas por pagar y sin enlace: en producción no hay notas; en la base local no se buscó.
17. *(R-88)* **El saldo a favor tiene dos testigos y ninguno lo MUEVE.** `supplier_credit_subledger_gaps` da fila si el auxiliar se aparta de lo declarado; el pago sobre una factura sin deuda está impedido, pero no se buscó si existe una reversa de pago a proveedor que pueda hacerlo. Corte en datos: una factura con alguna nota anterior al corte no se mira.
18. *(R-88)* **La nota en divisa que cierra con su asiento EN COLA no calcula diferencial** (no hay mayor que leer al registrar): al procesarse puede dejar residuo en cuentas por pagar, y `settled_ledger_gaps` lo enseñaría. Sospecha por lectura; sin test.
19. *(R-88, AF5-01)* **La retención y la nota: hay norma y lo construido cubre un solo caso.** PA SNAT/2025/000054 art. 11 «Ajustes de precios» (leída en reproducción no oficial): lo retenido de más AÚN NO ENTERADO se le devuelve al proveedor; si ya se enteró, lo descuenta él. La nota no toca la retención: coincide con «ya enterado». La devolución del otro caso no se construye (interpretación abierta, VALIDAR-SENIAT P-103); la pantalla cita el artículo y manda al contador.
20. *(R-88, AF5-11)* **Fechas de la nota:** futura o anterior a su factura, 422. No se tocó `platform.accounting_date_for` (la comparten facturas y gastos): **un período DECLARADO pero no cerrado no cuenta como cerrado**, y una nota fechada en él entra en él. Ola 6.
21. *(R-88, AF5-14)* **«Documento incompleto» es ahora «fiscal sin número de control», aunque traiga referencia** (`20261005110700`). No hay excepción por tipo de documento porque ni la nota ni la factura de proveedor tienen un tipo (máquina fiscal u otro) con fuente en `docs/02_COMPLIANCE/`: no se inventó. **La 110700 NO está aplicada en la base local compartida**: una nota de prueba registrada con la API anterior a este cambio (con referencia, sin control, completa) viola el CHECK nuevo y la migración se niega, como debe. En una base limpia y en producción (0 notas) entra.
22. *(R-88, AF5-10 y AF5-12)* **La nota en divisa entra al libro a la tasa oficial del día de la nota** (P-107, VALIDAR-TRIBUTARIO: no se decide la tasa); **una nota real cuyo IVA no es base × alícuota de su factura no se puede registrar** (422; P-106).
23. *(R-88)* **Sin prueba:** el orden de los candados de la rebaja (no hay test de concurrencia); el selector de lote y la lista de notas en un navegador; `supabase/tests/135` completo con la 110700 (en local se detiene en las dos aserciones nuevas por el punto 21).
24. *(R-88, cuarta ronda)* **Puntos que esta ronda cierra.** El 18 (**la nota en divisa que cierra con el mayor sin leer**): era un defecto real y está corregido en `registerSupplierCreditNote`: sin mayor, el diferencial se calcula con las tasas de registro de las piezas, con el mismo cálculo que el pago que cierra (`cuentaPorPagarCalculada`); cuatro E2E en `e2e-moneda-diferencial` («H-03 · cuarta ronda (a)–(d)»), rojos antes y verdes después. Alternativa descartada: recalcular el diferencial al reprocesar la cola (ADR-0083, cuarta ronda). El 15 (**el ajuste DESCARTADO con acta**): cuenta en `en_cola` como en `q` (`20261005110800`; pgTAP 139 d). Del 23: el orden de los candados de la rebaja lo pone ahora el código (claves ordenadas en TypeScript, todas las posiciones del producto, una sentencia por ordinal); **sigue sin test de concurrencia**. Las 110500 y 110600 tienen pgTAP propio (`supabase/tests/139`).
25. *(R-88, cuarta ronda)* **Lo que queda del punto 24.** El respaldo calculado resta las notas anteriores por su `functional_amount` a 8 decimales y el asiento va al céntimo: una o más notas parciales antes de la que cierra, con alguna pieza en cola, pueden dejar un céntimo en cuentas por pagar (lo enseñaría `settled_ledger_gaps`; el pago que cierra tiene el mismo borde; sin caso que lo provoque). Una posición de existencias que NAZCA entre la lectura de claves y el reparto de la rebaja se bloquea fuera de orden.
26. *(R-88, cuarta ronda)* **Un invariante con corte en datos calla si le borran la fila.** La rama de la nota de `settled_ledger_gaps` ya no: devuelve `falta_el_corte` (`20261005110900`); `supplier_credit_subledger_gaps` sin su fila lo mira todo (fijado en pgTAP 139). **Siguen callando sin su fila** las dos ramas de cobros y pagos de `settled_ledger_gaps` (corte `settled_ledger_gaps`, ola 3) y, no verificado uno por uno, los demás invariantes que leen `platform.invariant_cutoffs`; la tabla no tiene guarda contra DELETE. Ola 6.
27. *(R-88, aceptado por criterio)* **`lots[]` de `GET /v1/supplier-invoices/:id/lines` enseña existencias por lote y depósito** a quien registra notas o facturas de compra, sin pedir permiso de lectura de inventario: lo necesita para elegir el lote que devuelve. Alternativa: exigir además `inventory.read`.
28. *(R-88, para la ola 6; no se tocó)* **El reprocesador de la cola no conoce todos los orígenes.** `packages/domain/src/journal-backfill.ts`: `TABLA_DE` no tiene `payment_made`, `payment_received`, `sales_return` ni `sales_cost` (encolados, se asientan sin recuperar su enlace `journal_entry_id`), y `claves` es una lista copiada a mano que nada ata al tipo `AmountContext`: un importe de contexto nuevo que no se añada ahí se pierde al reprocesar (ya pasó con `credit_surplus`, punto 16). El E2E «la cola · una fila encolada con la marca…» de `e2e-moneda-diferencial` no pasa corrido solo (depende del fondeo de tests anteriores) y, con carga, agota los 5000 ms.
29. *(R-88, AF5-14)* **Si la nota de crédito emitida por máquina fiscal lleva número de control** está preguntado al asesor: P-108 (VALIDAR-SENIAT). Hasta la respuesta, toda nota fiscal sin control queda «documento incompleto» (punto 21).
- **Estado:** abierto.

### R-89 · Los reportes y las carteras: pantallas sin abrir en un navegador, la cartera recorre tres veces los documentos, el Excel lleva las cifras como texto y lo que quedó sin test (P-07, F-13, H-11)

- **Severidad:** Media · **Disparador:** una empresa con miles de documentos abiertos pide «Quién me debe»; alguien suma una columna del `.xlsx`; un rango de un año en el reporte de ventas.
- **Dónde:** `packages/domain/src/reports.ts`, `apps/api/src/routes/reports.ts`, `apps/api/src/report-export.ts`, `apps/web/src/components/TablaDeReporte.tsx`, `apps/web/src/components/Cartera.tsx`, `apps/web/src/pages/reportes/Reportes.tsx`.

1. **Ninguna pantalla se abrió en un navegador.** `/admin/reportes`, la cartera en `/admin/cuentas`, en «Cuentas por pagar» y en `/compras`, y el resumen sobre la lista de clientes pasaron typecheck, lint y las pruebas de la web; la forma (anchos a 390 px, la tabla de trece columnas de la cartera, el foco) se revisó por lectura. No se levantó la API local porque otros agentes corrían E2E sobre la misma base y un servidor de desarrollo trae la tasa real del BCV a la tabla global.
2. **La cartera recorre los documentos tres veces por petición** (contado por lectura del SQL, no medido con `explain analyze`): una pasada de `platform.document_debt` dentro de `ar_aging`, otra dentro de `customer_overdue_today` y otra para el nominal con su vencimiento. La primera entrega hacía SIETE (cuatro sentencias que reevaluaban los mismos CTE); la segunda ronda las dejó en una sentencia con los tres CTE materializados. La de proveedores pasó de seis a dos (`ap_aging` y la lectura factura a factura; cada una llama a `supplier_debt_today` y a `supplier_invoice_balance`). Bajar de tres exige una función de `platform` que devuelva deuda, vencimiento y tramo en una pasada (migración). Lo que sigue pagando de más: el resumen sobre la lista de clientes (`Cartera soloResumen`) hace las tres pasadas completas para pintar cuatro cifras, y la paginación corta en Node después de calcular todas las filas. Sin medir con volumen: en el escenario son decenas de documentos.
3. **Los reportes por rango filtran con `platform.caracas_day(issued_at) between …`**, que no usa el índice por `issued_at`. Correcto por granularidad (CLAUDE.md §3) y lento con años de documentos. Sin gate de coste.
4. **En el `.xlsx` las cifras son texto** con coma decimal: Excel no las suma sin convertirlas. Decisión confirmada en la segunda ronda (CLAUDE.md §1.7 no se negocia desde un reporte); va al informe de ola como decisión del dueño. El CSV sí se abre como números en un Excel en español.
5. **El menú «Reportes» exige `report.export`** (confirmado en la segunda ronda): el encargado y el cajero ven su cartera por la pantalla de su oficio, pero no tienen entrada de menú a `/admin/reportes` aunque el servidor les sirva su reporte.
6. **«Margen» no es «lo que gané» del Inicio.** El Inicio, con contabilidad, enseña el resultado del mayor (resta gastos, mermas y faltantes); el reporte es el margen bruto de lo vendido. Y el cálculo del Inicio sin contabilidad (`apps/api/src/routes/negocio.ts`, rama `debit_note`) no excluye la línea de la nota de débito por IGTF ni separa la devolución de una línea sin costo: visto por lectura, no reproducido, no se tocó.
7. **Los tramos significan cosas distintas en las dos carteras**: días desde la emisión en la de clientes (`ar_aging`) y desde el vencimiento en la de proveedores (`ap_aging`). La nota de cada reporte lo dice; unificarlos cambia dos funciones con datos.
8. **`platform.ap_aging` tiene `current_date` (UTC) como valor por omisión de su fecha.** El reporte le pasa siempre el día de Caracas; quien la llame sin fecha después de las 20:00 obtiene el día siguiente (abierto para la ola 6, entrega 36).
9. **El «vencido» de proveedores copia una expresión de `ap_aging`** (`coalesce(due_date, invoice_date) < hoy`, y la misma condición de «se debe»): no existe una función de día de vencimiento para proveedores, como sí la hay para ventas (`platform.document_due_day`). El comentario del código nombra la fuente y un E2E compara el resultado contra `ap_aging` con una factura con fecha acordada y otra sin ella. Si `ap_aging` cambia su regla y nadie toca el reporte, ese test es lo único que lo delata.
10. **La nota de crédito SIN devolución sobre una línea vendida sin costo sigue restando de la venta con costo.** La segunda ronda arregló el caso con devolución (se reconoce por la línea de origen de `return_lines`); una nota de crédito directa no guarda de qué línea viene, así que no se puede saber si la original tenía costo. Margen negativo posible por una venta que nunca entró en él. Sin test (no se fabricó el caso).
11. **«Vendido en el período» del inventario resta la devolución en el período en que la mercancía VUELVE**, no en el de la venta original: un mes puede salir con vendido negativo si solo hubo devoluciones de ventas anteriores (entonces «días de existencia» va vacío). Decidido por criterio: es lo coherente con medir por movimientos del kardex.
12. **La lectura de la tasa no es atómica con la de la fuente en las pruebas**: los E2E comparan la respuesta con `ar_aging` / `ap_aging` consultadas un instante después; si otro proceso cambia la tasa global entre las dos, fallan por una carrera y no por un defecto. Pasó una vez con dos agentes en paralelo.
13. **Tercera ronda (2026-10-04): lo que cerró y lo que deja.**
    - CERRADO · la nota de «venta sin costo» contaba también la DEVOLUCIÓN de una línea sin costo («2 línea(s)» por una vendida y devuelta): ahora cuenta solo líneas de factura o recibo (aserción sobre la nota en el E2E);
    - CERRADO · los fixtures por SQL del E2E de reportes (dos recibos con el instante elegido, tres facturas de proveedor de fecha pasada, los seis documentos del día de margen) se escriben dentro de una transacción que se REVIERTE y la lectura del dominio se llama ahí (`salesReport`, `marginReport`, `payablesReport` con el `tx`): tras la corrida, `platform.accounting_coverage_gaps` da 0 filas en las dos empresas de prueba (antes, 11). Lo que eso cuesta: esos tres casos ya no pasan por el handler HTTP, solo por la lectura;
    - CERRADO · la conciliación con el libro es contra `kind like 'withdrawal%'` (facturas de retiro Y sus notas): el E2E fiscal emite una nota de crédito de retiro y asevera que con solo las facturas de retiro ya no cuadra;
    - CERRADO · el margen de un producto COMPUESTO (I-04): su línea no lleva `cost_snapshot` y antes iba entera a «venta sin costo»; ahora el costo es Σ de sus filas `out` de `sale_line_components` y lo que vuelve con una devolución, Σ de las `back` de esa devolución. ABIERTO: una línea de compuesto SIN filas de salida (lo que `composite_sale_gaps` llama `sin_salidas`) sigue en «venta sin costo»; el reporte lee una subconsulta por línea vendida, sin gate de coste; y «lo que gané» del Inicio es de la familia de recetas, no se miró aquí;
    - el reporte de IVA lleva dos notas fijas de la auditoría fiscal (AF5-16) y la del IGTF ya no afirma cómo se recupera lo reversado (P-9). Los textos son los literales de la auditoría: la norma detrás de «se enteran aparte, por quincena» no se verificó en esta ronda;
    - FRAGILIDAD DE HORARIO del E2E fiscal: `HOY` se calcula al cargar el fichero; una corrida que cruza la medianoche de Caracas falla en «(1) Ventas con factura» con `rows = []` (pasó una vez, a las 00:00 de Caracas; repetida, verde). Es del fixture, no del reporte; sin arreglar.
    **Y lo que queda sin test desde la segunda ronda:**
    - el «sin tasa» por HTTP: se ejercita la lectura del dominio (`receivablesReport`, `payablesReport`) y el generador del CSV dentro de una transacción que borra las tasas y se revierte; el `c.json` del handler en ese estado, no (la tabla de tasas es global y la base solo conoce VES y USD: no hay una moneda que use un solo fichero);
    - el margen con una línea sin costo, un servicio y una nota de débito se prueba con documentos escritos por SQL (una línea de mercancía sin costo no se puede vender por la API de la empresa de prueba): prueba la lectura, no que la API produzca esos documentos así;
    - las tres facturas de proveedor vencidas del test de «vencido» también son de SQL (la regla de impuesto de la empresa de prueba rige desde hoy); desde la tercera ronda, estas y las del margen viven en una transacción que se revierte;
    - el cierre de caja «por cajero» se prueba con dos dueños (la caja de una empresa recién fundada es la de sistema y solo la cierra quien tiene `treasury.read`), no con un rol de cajero;
    - ~~el reporte de IVA con dos corridas las hace idénticas~~ CERRADO en la tercera ronda: entre las dos corridas se emite otra factura, la segunda corrida lleva 160,00 más de débitos y la fila del reporte es la de la segunda y no la de la primera (visto en rojo invirtiendo el orden del `distinct on` en una copia local);
    - retenciones practicadas del reporte de IVA: ninguna empresa de prueba practica una (columna probada solo en 0,00);
    - «por reintegrar» del IGTF: sin cobro reversado tras su quincena en ningún fixture;
    - encargado y administrativo: su fila de la tabla de permisos sale del catálogo de roles, no de un test;
    - paginación (`page`, `per_page`) y los grupos de margen `month` más allá de contar filas;
    - ningún gate de coste.
14. **El recorrido P y H no se pudo dejar en verde al cerrar la segunda ronda** por una causa ajena: la tabla global `exchange_rates` de la base local quedó VACÍA mientras corrían otras familias (varios E2E la borran entera: entrega 36, «higiene de tests»). Fallan cinco casos que no son de esta familia y necesitan la tasa de hoy (P-04 ×2, P-05, H-02 ×2); los tres de esta familia (P-07, F-13, H-11) pasan. Se comprobó con una fila marcador que los E2E de reportes no borran tasas ajenas.
- **Estado:** abierto.

### R-90 · El retiro facturado y su nota de crédito: trece migraciones que van juntas (más la de la versión de reglas), pantallas sin abrir en un navegador, la nota solo total y una cuenta de activo provisional (AF3-01 a AF3-07 · ADR-0082)

- **Qué es:** el retiro de inventario emite factura (`withdrawal_invoice`) y se corrige con su nota de crédito (`withdrawal_credit_note`); las salidas no gravadas asientan por su papel. Migraciones 20261005100000 a 20261005100970 (trece: las siete de las dos primeras rondas, 100000 a 100600, y las seis de la tercera y la cuarta, 100700, 100800, 100900, 100950, 100960 y 100970), más la 20261005160000 (versión de reglas 1.4.0, la última de la ventana).
- **Lo que queda de verdad:**
  1. **Las migraciones 100000 a 100600 van JUNTAS, en una ventana.** La 100000 sola rompe TODO cobro y TODA devolución (42703; la arregla la 100300) y repite el número de la segunda factura de retiro (la arregla la 100100). Aplicar una parte no es un estado válido.
  2. **Ninguna pantalla se abrió en un navegador:** la vista previa de la salida, el aviso tras confirmar y «Corregir este retiro» (detalle de la factura) compilan y pasan sus tests de fuente; nadie las ha visto pintadas.
  3. **La nota de crédito de un retiro es TOTAL.** Corregir una cantidad es dejar sin efecto el retiro y registrarlo de nuevo: dos documentos y dos números de control por un error de tecleo. La parcial está en el backlog.
  4. **Cada retiro gasta papel del talonario**, y su nota también. Un negocio que regala muestras a diario lo nota; no hay retiro agrupado.
  5. **La cuenta 1.2.01 «Propiedad, planta y equipo» y la rama 1.2 son provisionales** (P-82). Una empresa con plan propio sin la cuenta 1, o con 1.2 ocupada, no la recibe: su salida a activo fijo espera en la cola de pendientes hasta que asigne el papel `fixed_assets`.
  6. **Tres lecturas fiscales por kind vivían en TypeScript y la primera ronda no las vio** (`declarations.ts`, `tipo-contribuyente.ts`, `modo-venta.ts`); ningún invariante las delató. Están ampliadas, pero la clase de defecto sigue sin red: una lectura nueva por `kind = 'invoice'` puede olvidar la factura de retiro sin que nada se ponga rojo.
  7. **La ficha del adquirente:** si el negocio ya tenía un cliente con su propio RIF, se usa esa ficha sin marcar y sigue siendo un cliente al que se le puede vender. El estado de cuenta de la ficha marcada sigue respondiendo por id.
  8. **El retiro fechado antes de la vigencia del plan de cuentas va a la cola**, no al mayor (lo destapó el E2E con un plan importado hoy): es la regla de vigencias de siempre, pero quien importe el plan y corrija retiros de días anteriores verá pendientes.
  9. **La tabla de Notas de retiro (serie NR) sigue aceptando INSERT** hasta que se despliegue la API nueva; cerrarla es una migración posterior.
  10. **`e2e-cobros-cuarta-pasada` dio dos timeouts de 5 s** (6,4 y 7,2 s, sin ninguna aserción fallida) con tres agentes sobre la misma máquina. No se midió si es carga o el coste de los triggers nuevos sobre `payments`, `customer_credits` y `documents`: hay que correrlo solo.
  11. **`test:concurrency` no se corrió**, y esta entrega toca la numeración (`claim_document_number`) y el talonario.
  12. **La norma sigue en reproducción no oficial** (RLIVA art. 31): P-76 sigue abierta (R-70 sigue vigente). Eso NO es un mecanismo: nada retiene los retiros en el sistema. Lo que hay es un permiso —el retiro gravado de una empresa que factura exige `sales.invoice.issue` además de `inventory.move` (AF5-02)—, y liberar la emisión fiscal productiva es decisión del dueño con el asesor, como para toda factura. Alternativa descartada: un interruptor por empresa apagado por omisión.
  14. **Cuarta ronda (migración 20261005100970).** Soltar la clave foránea de `documents.withdrawal_move_id` quedó ACEPTADO por la sesión principal, y con ello (a) del punto 13 se cierra así: `withdrawal_note_gaps` gana la rama `factura_de_retiro_sin_su_salida` y cruza las dos tablas en los DOS sentidos (antes solo del movimiento a la factura), y el trigger queda ejercido con una salida inexistente y con una de otra empresa (pgTAP 134). (b) también se cierra: el pgTAP 134c fabrica la factura de retiro en el mes anterior y su nota hoy. Aceptar los dos nombres del hecho (`stock.received` y `stock.withdrawal_returned`) en las lecturas SE QUEDA: está acotado por el movimiento de la nota (alternativa: solo el nombre nuevo, que dejaría huecos sobre asientos ya posteados). **Sigue abierto:** el pgTAP 026 sin correr; la 150000 sin aplicar en local; ninguna pantalla abierta en un navegador. **Operativo:** la variante rota del pgTAP 134 hace `drop index` sobre `documents` (ACCESS EXCLUSIVE dentro de su transacción): no correr 134 con otras sesiones escribiendo; una de cinco ejecuciones bajo carga murió ahí sin aserción fallida («planned … but ran 26»). En el gate corre solo. Y un dato medido en 134c, que no es de esta familia: `book_ledger_reconciliation` cuenta como «en cola» todo renglón del libro sin asiento enlazado, haya o no fila en la cola de pendientes, así que su `cuadra` no delata un asiento que falta; lo delatan `accounting_coverage_gaps` y `withdrawal_note_gaps`.
  13. **Tercera ronda (migraciones 20261005100700 a 100960 y 150000; van con las siete anteriores, en orden).** Cerrado: la numeración salta por índice otra vez; `document_debt` responde por nota de crédito y recibo de devolución como antes; `LAD72` propio; el hecho `stock.withdrawal_returned`; fecha de hoy obligatoria en el retiro que factura; nota de destino en las salidas sin IVA; reglas 1.4.0. **Abierto:** (a) `documents.withdrawal_move_id` quedó SIN clave foránea (la diferible rompía el pgTAP 122): la integridad depende del constraint trigger `documents_95_withdrawal_move`; decisión del reparador, pendiente de confirmar por el dueño; (b) retiro y nota en meses distintos, sin test; (c) el pgTAP 026 no se corrió; (d) en la base local la 20261005160000 no está aplicada porque la 20261005110700 (otra familia) falla antes sobre los datos locales; (e) un retiro olvidado ayer solo puede facturarse con fecha de hoy.
- **Estado:** abierto.

### R-91 · El gasto que se repite y vender al mayor: pantallas sin abrir en un navegador, un recordatorio que no se edita y una lista elegida que no sobrevive a recargar (H-07, C-06)

- **Qué es:** la ola 5 construyó el recordatorio de gastos (migración 20261005140000, `packages/domain/src/recurring-expenses.ts`, `apps/web/src/components/GastosQueTocan.tsx`) y encendió «Vendo al mayor» en la caja (`apps/web/src/pages/negocio/Vender.tsx`, `apps/web/src/pages/Configuracion.tsx`). Lo que queda abierto:
  1. **Ninguna pantalla se abrió en un navegador:** el bloque «Gastos que se repiten», el formulario precargado de «Registrar ahora», el aviso de Inicio, el interruptor «Vendo al mayor» y el selector de lista de la caja compilan y pasan typecheck y los tests de la web; nadie los ha visto pintados. El guion `scripts/recorrido/h-compras.mjs` busca ahora «Este gasto se repite» (antes «Se paga todos los meses») y no se corrió.
  2. **El recordatorio no se edita.** Categoría, periodicidad y ancla son inmutables (trigger `platform.recurring_expense_guard`): cambiar «cada mes» por «cada quincena» es «Ya no se paga» y registrar el gasto otra vez con la marca. No hay pantalla para ver los recordatorios detenidos ni los períodos omitidos.
  3. **Se avisa el día que toca, no antes.** Un alquiler que vence el 1 aparece el 1. Si el dueño quiere anticipación, es un parámetro nuevo.
  4. **Un recordatorio viejo se pone al día período a período:** si nadie lo atiende en tres meses, «Registrar ahora» u «Omitir esta vez» avanzan UN período cada vez. Es deliberado (cada período deja constancia), pero son varios clics.
  5. **«Registrar ahora» se puede adelantar.** El servidor exige que el período sea EL SIGUIENTE, no que ya haya llegado: por la API se puede atender el del mes que viene. La pantalla solo lo ofrece cuando toca.
  6. **Un gasto registrado a mano de una categoría con recordatorio no atiende su período:** el aviso sigue hasta que se registre desde él o se omita. Quien pague la luz por el botón de siempre verá el aviso igual.
  7. **Los gastos marcados «se paga todos los meses» antes de esta migración no tienen recordatorio.** No se inventó su periodicidad. En producción no hay clientes reales; si los hubiera, habría que decidir un relleno.
  8. **La marca del gasto de Luz del recorrido** (la SOSPECHA de H-07: el interruptor dentro de un `<label>` quedó apagado tras el clic del guion) **no se reprodujo ni se descartó**: el interruptor sigue dentro de su `<label>`.
  9. **La lista elegida en la caja vive en la pantalla:** al recargar o cambiar de equipo, la cuenta vuelve a la lista del cliente o a la de mostrador. Guardarla en el carrito del servidor cambia el contrato de `/v1/pos/carts`.
  10. **`GET /v1/products?price_list_id=…` no exige el permiso** (ya era así): enseña precios de otra lista a quien puede ver productos. Cotizar y cobrar sí lo exigen, que es donde se decide el precio.
  11. **`e2e-gasto-con-factura` dio rojo en dos corridas** con tres agentes sobre la misma base: la primera, dos timeouts de 5 s en los dos casos de cuenta en USD; la segunda, una aserción (`expected '1.38000000' to be '31.00000000'`, lo que sale de la cuenta en USD a la tasa 40 del fixture: salió a ~898). La tasa global del día la pisó otra corrida; no se consiguió una corrida limpia que lo confirme. Hay que correrlo solo antes del gate.
- **Segunda ronda (revisión en contexto limpio, 2026-10-04):**
  - **Cerrado:** «registrar ahora» exige que la categoría del gasto sea la del recordatorio (422, antes de escribir; el formulario precargado ya no deja cambiarla). «Omitir esta vez» y «Ya no se paga» pasan por `ConfirmDialog` con sus consecuencias (el período siguiente lo da el servidor en `following_due_on`). Registrar, omitir y detener usan la llave POR INTENTO (`conLlaveDeIntento`). Marcar «se repite» en una categoría que ya tiene recordatorio registra el gasto y la respuesta lo dice (`recurrence_kept`), y la pantalla lo enseña. Los `catch` sin `savepoint` de 55000/23505/23503 se quitaron: eran código muerto.
  - **Aceptado por la sesión principal:** el punto 5 de arriba (adelantar por la API el período siguiente) se queda: pagar por adelantado existe y cada uno es un gasto real registrado con su permiso. «Alertas» = Inicio y Compras → Gastos (alternativa: una pantalla general de alertas, que no existe).
  - **La reversión de la migración 20261005140000 son CUATRO `drop function`**, no tres como dice su cabecera (que no se edita): `platform.recurring_occurrence`, `platform.recurring_due_after`, `platform.recurring_expense_guard`, `platform.recurring_expense_period_attend`. La cabecera cita además `docs/03_MODULES/TREASURY_SPEC.md`, que no existe: la spec es `TREASURY_BANKING_SPEC.md`.
  - **DECIDIDO (sesión principal, opción b) — el ajuste «Vendo al mayor» se exige en el servidor SOLO EN LA CAJA.** `resolverLista` (`packages/domain/src/sales.ts`), cuando entra por la caja (`quotePos` y `quickSale`, las dos puertas que pasan `de_contado`): con el ajuste apagado, una lista pedida en la venta distinta de la que toca → 422 «Tu negocio no tiene activado vender al mayor. Actívalo en Configuración para cobrar con otra lista.», también con el permiso. El PERMISO VA PRIMERO: quien no tiene `sales.price_list.override` recibe su 403 de siempre. La factura de administración y la lista asignada al cliente quedan como en HEAD, y Configuración lo dice bajo el interruptor. Descartadas: (a) aplicarlo a toda venta —cerraba la factura de administración con otra lista a quien no vende al mayor: cambiaba lo desplegado y tres aserciones de HEAD—; (c) no exigirlo en el servidor. Lo que sigue abierto: por la API, quien tiene el permiso sigue pudiendo FACTURAR desde administración con otra lista con el ajuste apagado (es la conducta de HEAD, aceptada); y la marca de «caja» es el parámetro `de_contado`, que nació para el bloqueo de cobranzas: una puerta nueva de la caja que no lo pase quedaría fuera de la regla sin que nada se ponga rojo. Lo que sigue es la historia de la primera tentativa, que se aplicó a toda venta y se RETIRÓ, porque ponía rojas aserciones de HEAD que no son de este defecto: `e2e-cobros-cuarta-pasada` (1 caso) y `e2e-moneda-diferencial` (2 casos) FACTURAN con otra lista con el permiso y el ajuste apagado, y `e2e-sales.test.ts:652` espera 403 donde llegaba 422 (esto último se arregla comprobando primero el permiso). No es «sin cambiar lo desplegado»: elegir otra lista en la factura de administración (`NuevaFactura`) quedaría cerrado para todo negocio con el ajuste apagado, que es el valor por omisión. Hoy el ajuste gobierna SOLO la pantalla; quien tiene `sales.price_list.override` puede mandar otra lista por la API. Opciones: (a) aplicarlo a toda venta y encender el ajuste en los fixtures de esos dos E2E; (b) aplicarlo solo a la caja (`quotePos`, `quickSale`) y dejar la factura de administración como en HEAD; (c) dejarlo como está y decir en la pantalla que el ajuste es de la caja.
  - **Un cambio de «Vendo al mayor» a apagado con la caja abierta** no borra la lista ya elegida en esa cuenta hasta recargar (`listaElegida` no mira el ajuste). El servidor sigue exigiendo el permiso.
  - **Ninguna pantalla se abrió en un navegador** tampoco en esta ronda (las confirmaciones, el aviso de «ya te avisábamos», la categoría bloqueada).
  - **Rojos vistos por la tabla global de tasas** (la vacían otros E2E; no se sembró ninguna para taparlo): `pnpm recorrido H` dio ROJO (2) dos veces, las dos por H-02 con `EXCHANGE_RATE_MISSING … tasa BCV del 04/10/2026`; `e2e-gasto-con-factura` dio 21 de 23, con los dos casos de cuenta en USD (un timeout de 5000 ms y `expected false to be true` en «a TASA REAL»). `e2e-fiar-con-permiso-y-limite` dio dos veces rojo en R-82.5 (`ronda N: expected [409, 409] to deeply equal [201, 409]`, test de HEAD de concurrencia) con la máquina cargada y verde en las siguientes.
- **Mitigación:** la conducta del servidor está cubierta por pgTAP 136, E2E `e2e-gasto-recurrente` (13), los tres casos C-06 de `e2e-fiar-con-permiso-y-limite`, y los CASOS H-07 y C-06 de `scripts/recorrido/verificar/H.mjs` y `C.mjs` (`pnpm recorrido H` y `C`: las comprobaciones por API, que SÍ se corrieron y pasan). Lo que NO se corrió es el guion de PANTALLA `scripts/recorrido/h-compras.mjs`, que es otra cosa.
- **Estado:** abierto.

### R-92 · El producto compuesto y el lote con vencimiento: pantallas sin abrir en un navegador, el margen del compuesto sin costo en la línea y lo que la llegada no exige en el esquema (I-04, C-07)

- **Qué es:** la ola 5 construyó la venta del compuesto (migración 20261005130000, `packages/domain/src/compuestos.ts`) y el interruptor de lote y vencimiento (migración 20261005130100). Lo que queda abierto:
  1. **Ninguna pantalla se abrió en un navegador.** Los interruptores del alta (`apps/web/src/pages/negocio/Productos.tsx`) y de la edición (`apps/web/src/pages/catalogo/Productos.tsx`) y el editor de ingredientes (`apps/web/src/components/IngredientesDeCompuesto.tsx`) pasan typecheck, lint y los tests de la web; nadie los usó con el ratón ni con el teclado.
  2. **La línea vendida de un compuesto no lleva `cost_snapshot`** (sigue en nulo, como antes): su costo real es la suma de `sale_line_components.functional_amount`. El asiento de costo de ventas es correcto; un reporte de margen POR LÍNEA que lea `cost_snapshot` verá el compuesto sin costo. No se escribió un costo unitario promedio en la línea a propósito (sería cantidad × un promedio redondeado).
  3. **«La llegada pide lote y fecha» vive en el dominio** (`resolverLote`, `packages/domain/src/inventory.ts`), no en el esquema: el trigger exige el lote (LAD38), pero un lote SIN fecha de un producto con vencimiento se puede insertar por SQL. No se puso un trigger sobre `lots` porque fixtures de pgTAP existentes crean lotes sin fecha.
  4. **Lo vencido no se devuelve al proveedor ni se vende; se da de baja con una salida con motivo.** La caja dice «Lo vencido no se vende»; no hay una pantalla que liste lo vencido con el botón de darlo de baja.
  5. **La cotización de la caja (`/v1/pos/quote`) no avisa de que falta un ingrediente:** lo dice la venta, con un 409 que nombra el ingrediente y el compuesto. La cuadrícula no enseña «existencia» de un compuesto.
  6. **Devolver un compuesto reingresa los ingredientes** (no hay «plato devuelto» que guardar): si lo devuelto no vuelve al depósito, hay que sacarlo con una salida con motivo.
  7. **`platform.expiring_lots` y `platform.suggest_lot_fefo` cambiaron su fecha por omisión** al día de Caracas. Quien las llame pasando la fecha no nota nada.
  8. **El consumo suelto de receta** (`POST /v1/inventory/recipe-consumptions`, pestaña Recetas de Administración → Inventario) sigue existiendo y no escribe `sale_line_components`: no es una venta. Si la venta ya descuenta los ingredientes, consumir además a mano los descuenta dos veces; la pestaña no lo advierte.
- **Mitigación:** la conducta del servidor está cubierta (pgTAP 137, E2E `e2e-compuestos-y-lotes` con 17 casos, `pnpm recorrido I` y `C`, y el invariante `composite_sale_gaps` en `scripts/recorrido/invariantes.sql`).
- **Segunda ronda (2026-10-04, tras la revisión en contexto limpio; ADR-0084).** Lo que cambia de la lista de arriba:
  - **(2) cerrado para «lo que gané» del Inicio:** `apps/api/src/routes/negocio.ts` suma las filas `out` de `sale_line_components` para la venta de un compuesto y las `back` para su devolución (E2E: vender 3, devolver 1 → 97,00 y 64,67; antes 0,00 y −50,00). **Sigue abierto** para el reporte de margen (`marginReport`), que lo hace la familia de reportes con la misma regla: no verificado aquí. **Y sigue abierto, para la ola 6, el mismo defecto en la línea SUELTA sin costo**: su devolución resta `line_subtotal_functional` de una venta cuyo margen era nulo (no sumó) y devuelve costo cero; no se tocó.
  - **(3) cerrado:** migración `20261005130200` — un lote sin fecha de un producto con `tracks_expiry` no entra ni se queda sin ella, y encender el vencimiento no deja lotes sin fecha (LAD73; pgTAP 138 con variantes rotas). La frase «fixtures de pgTAP existentes crean lotes sin fecha» era inexacta: 020, 057 y 137 pasan con la guarda puesta. **La migración FALLA si en la base hay lotes sin fecha de productos que vencen** (local: 0; producción: sin mirar): correr antes la consulta de su cabecera.
  - **(8) con aviso:** la confirmación de «Consumir receta…» dice que la venta ya descuenta los ingredientes. No lo impide. Alternativa no tomada: rechazar el consumo suelto de un compuesto que se vende.
  - **C2:** el `NEGATIVE_STOCK` de «lotes vigentes» lleva el producto, y la caja nombra también el compuesto cuando el ingrediente que falta lleva lote.
  - **C3 · el callejón de permisos:** `product.recipe.manage` lo tienen `owner` y `back_office`; `product.manage`, además, `store_manager`. Marcar o quitar «compuesto» exige ahora los dos EN EL SERVIDOR (403), y la web solo ofrece el interruptor a quien puede. **Alternativa descartada: dar `product.recipe.manage` al encargado** (mueve los permisos de un rol de sistema: lo decide el dueño). Consecuencia: el encargado no crea compuestos.
  - **C4:** las cinco ramas de `composite_sale_gaps` tienen variante rota. De paso quedó escrito un hecho: **la guarda de la fila no impide `devuelto_de_mas`** (no suma lo ya devuelto); lo calcula el dominio y lo vigila solo el invariante.
  - **NUEVO · anular después de devolver (toda venta, no solo compuestos):** la anulación reponía TODAS las salidas del documento, también las que una devolución confirmada ya había reingresado: la mercancía entraba dos veces (reproducido: harina 29,5 donde había 29) y `annulled_stock_gaps` daba cero, porque los reingresos de la devolución cuelgan de la devolución. Ahora `annulInvoice` rechaza (422) una venta con una devolución confirmada. **Decidido por criterio y pendiente de que el dueño lo confirme**; alternativa: que la anulación reponga solo lo que falta por volver (toca también la nota de crédito emitida y el asiento). **Sin mirar:** si en producción hay ventas anuladas que tenían devoluciones confirmadas (`select d.id from documents d join returns r on r.source_document_id = d.id and r.status = 'confirmed' where d.status = 'annulled'`): su existencia estaría inflada y ningún invariante lo señala. Tampoco se miró una devolución en BORRADOR que se confirme después de anular.
  - **NUEVO · confirmar un pedido con un compuesto falla** (`POST /v1/orders/:id/confirm` → 409 «quedan 0 y el pedido exige N»): la reserva mira la existencia del compuesto, que no la lleva. Crear la cotización y el pedido sí funciona y no mueve kardex (con test). Reservar los ingredientes es una decisión que no se tomó.
  - **Sin cerrar:** (1) ninguna pantalla se abrió en un navegador, tampoco las de esta ronda (el aviso de «Listo» sin ingredientes, los ingredientes en la ficha del producto, el interruptor oculto a quien no puede); (4), (5), (6) y (7) siguen como estaban. La migración 130200 **no quedó aplicada en la base local compartida** (la bloquea `20261005110700`, de otra familia): se verificó en una transacción revertida.
- **Tercera ronda (2026-10-05, tras la segunda revisión en contexto limpio).**
  - **(2) cerrado también para el reporte de margen:** `marginReport` (`packages/domain/src/reports.ts`) ya suma `sale_line_components` con la misma regla y su E2E; `negocio.ts` lee ahora el costo en su mismo orden (primero `cost_snapshot`, si no la suma del compuesto). Sigue para la ola 6 la línea SUELTA sin costo.
  - **Cerrado · devolución en borrador → anular → confirmar:** era el defecto de «anular después de devolver» por la otra puerta (reproducido: la confirmación daba 200 sobre una venta anulada, y las dos a la vez daban 200 y 200). `confirmReturn` lee el origen con `for update` y exige que siga emitido (422 «Esa venta se anuló…»); es el mismo candado que toma `annulInvoice`, así que a la vez gana uno solo (con test). La nota «tampoco se miró una devolución en BORRADOR» de la segunda ronda queda resuelta.
  - **Cerrado · confirmar un pedido con un compuesto:** decidido por el dueño (opción a): la línea del compuesto no reserva; sus ingredientes se comprueban al facturar. **Alternativa descartada:** reservar ingredientes × receta (productos que no están en el pedido, y se desalinea si la receta cambia). Consecuencia aceptada: un pedido confirmado no compromete los ingredientes.
  - **Abierto, heredado:** dos devoluciones SIMULTÁNEAS de la misma línea. El tope acumulado de `confirmReturn` («no más de lo vendido») se lee sin bloquear las devoluciones hermanas; el `for update` nuevo sobre la venta las serializa de hecho (las dos lo toman antes de leer el tope), pero no hay test de dos confirmaciones a la vez: no verificado.
  - **Abierto, ola 6:** `annulled_stock_gaps` no mira los reingresos de devoluciones (cuelgan de la devolución, no de la venta). Hoy las dos puertas están cerradas en el dominio; el invariante seguiría dando cero si una se reabriera. La consulta para producción de la segunda ronda (ventas anuladas con devoluciones confirmadas) sigue sin correrse.
  - **Abierto, sin construir:** no existe «facturar el pedido» ni «cancelar el pedido» en la API (`apps/api/src/routes/sales.ts` solo tiene `POST /v1/orders` y `/v1/orders/:id/confirm`), y nada en el dominio pasa una reserva a `released` (la única escritura de `stock_reservations` es el insert de `confirmOrder`): una reserva solo deja de contar al caducar. No se pudo probar «facturar el pedido descuenta los ingredientes» ni «cancelar libera solo lo reservado» porque esos caminos no existen.
  - La migración 130200 sigue **sin aplicar en la base local** (la bloquea `20261005110700`); verificada otra vez en transacción revertida (138: 15/15).
- **Estado:** abierto.

# Handoff — 2026-08-17

## Estado

**S0.1 a S0.4 cerrados y en verde.** El siguiente es **S0.5 — API y caso de uso**.

S0.1 ✅ · S0.2 ✅ · S0.3 ✅ · S0.4 ✅ · S0.5 ⬜ · S0.6 ⏸️ (diferido, ver abajo)

`pnpm verify` corre **9 pasos**; el 8 y el 9 necesitan Docker. Fuera del gate, por muestrales:
`pnpm test:concurrency` y `pnpm test:concurrency:selftest`.

**368 aserciones pgTAP en verde**, 13 suites, 13 migraciones aplicadas desde cero.

---

## Lo que cambió el suelo: la 121 está derogada

**PA SNAT/2024/000121 fue derogada por PA SNAT/2026/00084** (Gaceta 43.435, 12/08/2026), **sin
norma sustituta**. Cae la homologación del sistema, la autorización del proveedor y —la de mayor
efecto— **la obligación del contribuyente de usar software homologado**, que vivía en la
Disposición Final Cuarta de la propia 121.

Siguen vigentes PA 071, PA 102 y PA 0141, y todo lo tributario sustantivo. Aparte,
**PA SNAT/2026/00080** reforma el RIF: deja de caducar, pero debe actualizarse ante cambios de
datos.

**Punto de entrada: `docs/02_COMPLIANCE/REGULATORY_STATUS.md`** — tres categorías (derogado /
vigente / esperado). Los documentos de la 121 se conservan con encabezado de derogación y **sin
actualizar**: si vuelve reformada, la pregunta útil será «¿qué cambió respecto de esta?».

**Consecuencia de producto, y es la grande:** Ladino sin emisión fiscal es un ERP administrativo,
de inventario y contable **completo y vendible hoy**. La emisión fiscal deja de ser gate de salida
y pasa a ser un módulo más.

---

## Hecho en esta sesión

### S0.4 — auditoría, outbox, idempotencia e identidad fiscal

| | |
|---|---|
| 1/7 | `audit_events` append-only en dos capas, `payload_hash` generado |
| 2/7 | `outbox` con máquina de estados en el esquema e índice de toma parcial |
| 3/7 | `idempotency_keys` con `UNIQUE NULLS NOT DISTINCT` |
| 4/7 | **M4**: el RIF exige permiso propio y deja rastro con el valor anterior |
| 5/7 | seis defectos de la auditoría de cierre |
| 6/7 | regresión de rendimiento 28× + `actor_id` propio + `occurred_at` al trigger |
| 7/7 | `actor_id` clavado y `aggregate_type` acotado |

**Deuda de S0.3 cerrada antes de empezar:** revocación inmediata con sesión abierta (11
aserciones — la promesa central de ADR-0014, que es lo que justifica el coste por consulta de las
policies) y concurrencia real del outbox con `pgbench`.

**Cinco ADR:** 0026 (esquema de las tres tablas, diez decisiones), **0027 (la regulación es dato)**,
**0028 (transmisión SENIAT como consumidor de outbox)**, enmiendas a 0003 y 0018.

### Lo que encontraron las auditorías, y que ningún test veía

Cuatro pasadas. **Las tres primeras encontraron defectos en la migración que arreglaba la
anterior.** Es el patrón de S0.3 repetido, y merece quedar escrito: **una migración escrita para
arreglar otra necesita su propia auditoría**, porque el foco puesto en el defecto conocido es
exactamente lo que deja pasar el nuevo.

- **El `CHECK` de `event_type` rechazaba los siete eventos fiscales** del catálogo. Escrito como
  guardia barata, nunca contrastado contra `EVENT_CATALOG.md`. La primera emisión de la Fase 11
  habría fallado — y no el log, la **emisión**, porque auditoría y outbox van dentro de la
  transacción del caso de uso.
- **`occurred_at <= created_at` comparaba contra la hora de inicio de transacción.** Cualquier
  timestamp real tomado tras el `BEGIN` fallaba. Corregido a un trigger contra `clock_timestamp()`.
- **Regresión de rendimiento de 28×** en la función que usan más de cuarenta policies: una función
  SQL cuyo cuerpo es una sola llamada a otra función SQL no inlinable **replanifica por fila**. En
  `plpgsql` el plan sobrevive en el `simple_eval_estate`. Medido: 394 ms → 10.380 ms → 372 ms.
- **`service_role` no podía escribir auditoría en absoluto** — a la función del hash generado le
  faltaba `GRANT EXECUTE`, y `has_table_privilege(…, 'INSERT')` decía que sí.
- **La unicidad de idempotencia colgaba de una columna best-effort.** `created_by` queda NULL en
  silencio si la API olvida el GUC; el reintento sin GUC creaba una segunda reserva.

### Gates que no existían y ahora sí

1. **`pnpm test:concurrency`** — outbox bajo N sesiones reales de `pgbench`. Fuera de `verify` a
   propósito: es muestral, y un gate muestral en cada commit enseña a reejecutarlo.
2. **Gate de coste (test 013)** — presupuesto de tiempo sobre la ruta real de RLS. **Faltaba
   entero**: los 348 asserts anteriores dejaron pasar la regresión de 28× porque ninguno medía
   tiempo.
3. **Variantes rotas** en los dos, y en el `NULLS NOT DISTINCT` de idempotencia. Regla escrita en
   la skill: *una prueba que nunca ha fallado no se sabe si detecta algo*. Y su corolario, que salió
   caro aprender: **cuando la variante rota falla, mira QUÉ la detectó** — en el outbox no fueron
   las invariantes de la prueba, fue un `CHECK` del esquema escrito como higiene.

---

## En vuelo

**Nada.** Trece migraciones aplicadas desde cero, 368 aserciones verdes, `pnpm verify` en verde,
concurrencia y autotest verdes.

**Sin commitear.** Todo el trabajo está en el árbol de `s0.4/audit-log-and-outbox`. Los commits
requieren aprobación explícita (`CLAUDE.md` §2).

---

## Primer paso de S0.5

**S0.5 es la API y el caso de uso.** El orden importa y el primero no es escribir un endpoint:

> **Escribir el middleware de procedencia e idempotencia ANTES que el primer endpoint.**

Porque S0.4 dejó **tres contratos que la base no puede imponer sola**, y los tres fallan en
silencio si el middleware llega después:

1. **`set local ladino.actor_id`** en toda transacción de servidor. Sin él, `created_by` queda NULL
   sin error (`API_SPEC.md` §Procedencia).
2. **`actor_id` explícito** al reservar una clave de idempotencia — este sí falla activamente
   (`NOT NULL`), que es como debe ser.
3. **El lookup de replay filtra por `actor_id`.** Es el que más fácil se olvida: el índice único
   nunca fue la fuga, la fuga es la lectura. Sin este filtro, un usuario recibe la respuesta de
   otro con un `200`.

### Decisiones que S0.5 tiene que tomar, no heredar

- **¿Se valida `actor_id` contra el actor real?** Hoy la columna acepta cualquier UUID: un
  `actor_id` tomado de una cabecera del cliente permitiría pre-reservar el espacio de claves de
  otro usuario. Un trigger que exija `actor_id = coalesce(auth.uid(), GUC, centinela)` lo cierra.
  Es `CLAUDE.md` §2 —*ausencia de mecanismo no es prohibición*— y está sin decidir.
- **Qué responde la API ante una clave `in_progress`**: esperar, `409` o `425`. El esquema hace la
  distinción posible; el contrato no existe.
- **Canonicalización de `request_hash`.** Sin forma canónica, dos cuerpos semánticamente iguales
  producen 409 espurios sobre peticiones correctas.
- **TTL de las claves.** `expires_at` no tiene default a propósito: ponerlo habría decidido la
  retención por la puerta de atrás.
- **`fiscal_protocol_version` y el manifest de release** existen solo en documentación. El gate de
  CI que ADR-0009 describe no tiene destinatario. Se difiere el **gate**, no el versionado.

### Y una prohibición para S0.5, que es fácil de incumplir por defecto

**No poner un regex de RIF en los esquemas Zod.** La migración se negó a escribir el `CHECK`
porque el formato no está en `docs/02_COMPLIANCE/` con fuente citada. La misma obligación
inventada volvería a entrar por el contrato de la API, donde es **peor**: se convierte en
validación aplicada en el cliente, y eso es un cliente decidiendo una regla fiscal.

---

## S0.6 — diferido

Contenedores y proyecto Supabase remoto siguen en pie. Lo que se difiere es el **release train
fiscal con manifest de homologación**: no hay régimen al que reportar.

Dos procesos que S0.6 debe traer y que hoy no tienen dueño, los dos de **disponibilidad**:

- **El reaper del outbox.** `outbox_in_flight_idx` existe *«para encontrar lo que un worker muerto
  dejó colgado»* y ese proceso no existe.
- **El reaper de idempotencia.** Con el protocolo de dos transacciones, un proceso que muere entre
  T1 y T2 deja la clave clavada en `in_progress` y **bloquea el reintento legítimo hasta
  `expires_at`** — es decir, impide emitir el documento.

---

## Riesgos abiertos

`RISK_REGISTER.md` tiene **R-01 a R-06**. Los tres que importan para lo que viene:

- **R-06 · norma sustituta desconocida.** Riesgo de entorno: no se cierra trabajando. Mitigado por
  ADR-0027 y ADR-0028.
- **R-05 · el snapshot fiscal completo.** Los documentos deben **copiar** diez elementos al emitir
  —razón social, RIF, domicilio, datos del cliente, líneas, tasas, moneda y tasa, serie, imprenta,
  versión fiscal— no resolverlos por `JOIN`. Con `JOIN`, un `UPDATE` sobre `companies` reescribe
  retroactivamente el emisor de todos los documentos ya emitidos. **`legal_name` sigue hoy en
  estado pre-M4** y se trata en Fase 11 con el snapshot completo. `companies` **no tiene columna de
  domicilio fiscal**, que PA 102 Art. 7 exige en la factura.
- **R-04 · no existe la lista de qué se audita.** El mecanismo está; la política se difiere hasta
  el segundo caso de uso de `packages/domain`.

## Clases de ataque que siguen sin probar

Cerradas en S0.4: **ciclo de vida** (revocación) y **concurrencia de mecanismo**. Siguen abiertas
en `HANDOFF` histórico y aquí en resumen: escalada por composición (SoD), agotamiento y vecino
ruidoso, canal lateral por errores y tiempos, orden de migración en despliegue real,
`service_role` comprometido en lectura, y datos heredados incoherentes.

Sin entrada en el registro y debería tenerla: **SoD** — `MULTITENANCY_AND_RBAC.md` exige
segregación configurable y no existe ni el permiso `payment.approve` ni mecanismo que compare
creador con aprobador.

## Límites conocidos que quedan anotados

- **`payload_hash` no da evidencia de manipulación.** Es columna generada: se recalcula si la fila
  se reescribe. La integridad la dan las dos capas de prevención, no la detección. Corregido en la
  redacción de ADR-0026 D1 y `AUDIT_TRAIL_AND_IMMUTABILITY.md`; **no citarlo como «hash de
  integridad» ante un tercero.**
- **`platform.audit_payload_hash()` colisiona** sobre `jsonb` arbitrario. El `CHECK` de objeto hace
  la colisión inalcanzable **por la tabla**, no imposible en la función. No se corrige la función
  porque cambiar su cuerpo **no recalcula** los hashes ya almacenados.
- **Sin política de retención** de `audit_events` ni del outbox: crecen de forma monótona.
  `VALIDAR-SENIAT` para el plazo legal; la política **operativa** sí se puede escribir sin esperar
  a nadie.
- **`ladino.rules_version` de más de 64 caracteres aborta el alta de una company.** BAJO sin
  arreglar: validar o truncar el GUC en el middleware.
- **El trigger de `occurred_at` ordena antes que el de procedencia** por nombre. Hoy da igual;
  un futuro BEFORE INSERT que ordenase después podría esquivarlo.

## Lecciones incorporadas

`CLAUDE.md` §3 lleva la **calibración del rigor** — reversibilidad y coste del error, no
importancia percibida. La skill `migracion-supabase` lleva ocho lecciones, tres de esta sesión:

- **Ejerce la operación, no preguntes por el privilegio.** Un bit de `has_*_privilege` dice que
  puedes intentarlo, no que funcione.
- **Toda prueba de un invariante crítico necesita su variante rota**, y hay que mirar qué la
  detecta.
- **Un envoltorio SQL sobre una función SQL no inlinable replanifica por fila**, y un gate de
  corrección no detecta una regresión de coste.

ADR-0023 conserva los **ocho** casos del patrón «ausencia de fallo leída como éxito». Se retiró un
noveno que resultó ser falso —el permiso que creí ausente estaba en la base desde S0.3— porque
retirar un caso falso protege la autoridad del resto.

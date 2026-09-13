# Plan — Por qué Ladino se siente lento y qué lo hace rápido

- **Estado**: diagnóstico medido en producción el 2026-09-13; propuesta para el dueño.
- **Regla**: primero medir, luego decidir. Nada de esto está implementado todavía salvo lo
  que se indica.

## 1. Lo medido (producción, desde la máquina del dueño, red «4G» de 250 ms de RTT)

| Petición | 1ª vez | 2ª vez | Qué hace el servidor |
|---|---|---|---|
| Ping sin sesión (`401`) | 109–111 ms | — | Solo red usuario ↔ VPS |
| `GET /v1/companies` | 1.694 ms | 1.065 ms | Una lectura trivial |
| `GET /v1/me/permissions` | 1.262 ms | 1.061 ms | Una lectura trivial |
| `GET /v1/products` (60 con precio y stock) | 1.737 ms | 1.568 ms | Una consulta con joins |
| `GET /v1/negocio/resumen` | 3.195 ms | 2.446 ms | 8 agregados |
| `POST /v1/pos/quote` (3 líneas) | 3.089 ms | 2.904 ms | Cotizar el carrito, sin escribir |

Y en la base (`pg_stat_statements`, rol `ladino_api`): las sentencias individuales tardan
**1–6 ms** de media. La CPU de la base no es el problema.

**Conclusión 1 — el tiempo está en las idas y vueltas, no en las consultas.** Una lectura
trivial tarda ~1 s porque cada petición hace **~10 viajes** a la base antes de responder,
y cada viaje VPS (Hostinger, Boston) ↔ Supabase (`us-west-2`, Oregón) cuesta **~75–90 ms**.
Una mutación (cobro, venta) hace **~20 viajes fijos** de protocolo más los suyos:

| Tramo de una mutación | Viajes | De dónde salen |
|---|---|---|
| `contextMiddleware` (empresa visible) | 4 | `begin` · `set_config` · `select` · `commit` |
| Idempotencia, lectura de tenant visible | 4 | otra transacción entera para un `select` |
| Idempotencia T1 (reserva) | 5 | `begin` · `set_config` · `select` · `insert` · `commit` |
| Caso de uso, antes de trabajar | 5 | `begin` · `set_config actor` · empresa · permiso · `set_config rules` |
| Idempotencia T2 (respuesta) | 4 | `begin` · `set_config` · `update` · `commit` |
| **Fijo por mutación** | **~22** | **≈ 1,8 s a 80 ms el viaje** |

Una venta del POS son **94 viajes** (medición de la sesión 17) ≈ **7 s** solo de latencia,
con la contabilidad generada en línea dentro de la misma transacción.

**Conclusión 2 — la numeración serializa las ventas.** `platform.claim_document_number`:
1.210 llamadas, **20 s de media, 77 s de máximo**. El candado consultivo del correlativo se
toma al emitir y se retiene hasta el `commit`, es decir, durante los cobros, el IGTF, el
kardex y los asientos que vienen después. Con dos cajas vendiendo a la vez, la segunda
espera a que la primera termine su venta entera. (Los 20 s de media vienen de la semilla de
volumen, que emitió en paralelo; con una caja no se nota; con tres, sí.)

**Conclusión 3 — el navegador no es el cuello.** El HTML llega en 103 ms; el bundle son
2 MB descomprimidos en un solo archivo (sin partir por ruta) y se cachea; la caché de
consultas ya tiene `staleTime` de 30 s. Mejorable, pero no es lo que se siente.

## 2. Qué lo hace rápido, ordenado por impacto ÷ esfuerzo

| # | Palanca | Efecto esperado | Esfuerzo | Riesgo |
|---|---|---|---|---|
| **A** | **Base y API en la misma región.** O migrar el proyecto Supabase a `us-east-1` (Virginia; Boston ↔ Virginia ≈ 10 ms) o poner la API donde está la base. | Cada viaje pasa de ~80 ms a ~2–10 ms: **lectura trivial de 1 s → ~0,15 s; venta de 7 s → <1 s** | Medio: proyecto nuevo, `pg_dump`/restore (1.210 documentos, es pequeño), copiar el bucket de logos, cambiar `SUPABASE_URL`/claves en VPS y web, los usuarios vuelven a iniciar sesión; ventana de 1–2 h | El plan de migración se ensaya antes en local; nada se borra del proyecto viejo hasta validar |
| **B** | **Colapsar el protocolo fijo en funciones SQL de un viaje.** `platform.company_scope(actor, company, permiso)` fija los GUC y devuelve empresa+permiso en UNA sentencia; `platform.idempotency_claim(...)` y `platform.idempotency_close(...)` hacen T1 y T2 en una sentencia cada una (sin `begin`/`commit` explícitos); el caso de uso entra con una sola sentencia. | De ~22 viajes fijos a **~6** por mutación y de ~10 a **~4** por lectura: **−1,2 s por acción** aunque no se haga A | 1 sesión; ADR (el protocolo de idempotencia no cambia de semántica, cambia de forma); los tests de idempotencia y de scope ya existen | Máximo rigor: las funciones son `security invoker` y la RLS sigue mandando |
| **C** | **Contabilidad de la venta en segundo plano.** La venta deja la fila en `journal_generation_queue` (ADR-0042 ya lo permite: «asiento o cola») y el worker la procesa en segundos. Y el correlativo se reclama lo más tarde posible. | Venta de 94 → ~55 viajes; el candado del correlativo se suelta antes; dos cajas dejan de esperarse | 1 sesión; ADR; el worker ya tiene el patrón `FOR UPDATE SKIP LOCKED` | El invariante `accounting_coverage_gaps()` sigue en cero por construcción; la pantalla de contabilidad enseña «en cola» hasta que el worker pasa |
| **D** | **Web: sentir la velocidad.** Rutas partidas (`React.lazy`), cotización del carrito con retardo de 250 ms para no disparar una por clic, el botón «Cobrar» con la última cuenta válida mientras recalcula, esqueletos en vez de «…», `resumen` en una sola consulta de conjunto (hoy `document_debt_today` por documento: 153 ms de media y crece con la cartera) | Primera carga más rápida en 4G; el POS deja de «pensar» 3 s por clic | ½ sesión | Ninguno fiscal |
| **E** | **Caché corta de alcance en la API** (30 s por usuario+empresa, invalidada al tocar miembros/roles) | Quita 2 viajes más por petición | ½ sesión | Un permiso revocado tarda ≤30 s en dejar de valer; la RLS sigue protegiendo el aislamiento |

**Recomendación**: **B + D ya** (código, sin tocar infraestructura, −1,2 s por acción y el POS
sin esperas por clic), **A como decisión tuya de infraestructura** (es la única que
multiplica por 10), y **C** después de A o junto a B si quieres dos cajas a la vez.

## 3. Lo que NO es

- No es la base: consultas de milisegundos, sin bloqueos salvo el correlativo.
- No es el bundle ni React: el HTML y los assets llegan en 100–180 ms.
- No es la red del usuario sola: sus 110 ms de ida y vuelta explican 0,2 s de cada segundo.
- No es «poner un índice»: ninguna consulta de las 18 más caras es un scan lento.

## 4. Decisión que se te pide

1. ¿Sí a B + D en el siguiente lote (código, `verify`, commit, despliegue tuyo)?
2. ¿Migrar la base a `us-east-1` (Virginia) o llevar la API a Oregón? Recomiendo migrar la
   base: el VPS y Traefik se quedan como están, y Supabase Cloud tiene la región.
3. ¿C (contabilidad en segundo plano) ahora o después de A?

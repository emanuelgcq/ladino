# Matriz de controles — PA121

> **PA SNAT/2024/000121 fue derogada** por PA SNAT/2026/00084 (Gaceta 43.435, 12/08/2026), sin
> norma sustituta. **Ninguna fila es hoy exigible por esa providencia.**
>
> Y sin embargo esta matriz **no es un documento histórico**: es la **línea base voluntaria** de
> Ladino (ADR-0027 §5). El estándar técnico de la 121 es la mejor aproximación disponible a lo que
> pedirá cualquier norma futura, y casi todo lo que enumera ya está construido **por ser buen ERP,
> no porque una providencia lo mandara**.
>
> Lo que cambia respecto de la versión anterior de este documento: **cada fila declara ahora su
> categoría y su cobertura real.** Antes se afirmaba en bloque que «los controles siguen siendo
> buenos controles de ERP», y eso era falso para tres filas —Remisión, Acceso SENIAT y Nueva
> versión— que **no tienen valor de producto** y solo existían por la norma. Reclamarlo era
> sobrepasar.
>
> Estado regulatorio vigente: `REGULATORY_STATUS.md`.

## Las tres categorías

| | Qué significa | Se puede diferir |
|---|---|---|
| **P · Producto** | Existe por la naturaleza del producto. Sin esto el ERP está roto de origen, y **un cliente que ve datos de otro demanda al proveedor, no al fisco**. Independiente del SENIAT. | **Nunca.** No se relaja, no se negocia, y una norma nueva no lo revisa. |
| **R · Regulación vigente** | Lo exigen PA 071, PA 102 o PA 0141, que siguen en vigor. | **Sí.** Ladino sin módulo fiscal es vendible. Es lo único que se revisa si sale una providencia nueva. |
| **D · Derogado** | Existía solo por la 121. Se conserva como histórico y como línea base voluntaria. | Ya diferido de hecho. |

**La prueba de que la primera categoría no depende de la norma: la 121 murió el 12 de agosto y
nada de S0.3 perdió sentido.** El aislamiento multi-tenant, la partida doble, `Decimal` en vez de
`float`, la idempotencia, la auditoría con autor y timestamp, y la inmutabilidad de los asientos
posteados valían exactamente lo mismo el día 11 y el día 13.

## Cobertura

`✅` cubierto y probado · `🟡` parcial · `⬜` no cubierto

| Requisito 121 | Cat. | Control Ladino | Cobertura hoy |
|---|:--:|---|---|
| Integridad | **P** | FK, `CHECK`, coherencia estado/dato, `payload_hash` | ✅ FK y checks probados. 🟡 el hash **no da evidencia de manipulación** (columna generada, ADR-0026 D1) |
| Continuidad | **P** | HA, backups, contingencia | ⬜ sin infraestructura todavía (S0.6) |
| Confiabilidad | **P** | transacciones ACID, caso de uso transaccional | 🟡 la base sí; el patrón de caso de uso es S0.5 |
| Conservación | **P** | retención + backups | ⬜ **sin política de retención**. El plazo legal es `VALIDAR-SENIAT`; la política **operativa** se puede escribir ya |
| Accesibilidad | R | audit UI/API de consulta | ⬜ no hay API; `fiscal.audit.read` existe como permiso |
| Legibilidad | R | formatos humanos, export | ⬜ Fase 11 |
| Trazabilidad | **P** | `audit_events` append-only con autor, timestamp y `rules_version` | ✅ 368 aserciones, incluida revocación inmediata |
| Inalterabilidad | **P** | dos capas: privilegios + `reject_mutation()` | ✅ probado también contra `service_role` y contra `TRUNCATE` |
| Inviolabilidad | **P** | RBAC, RLS enable+force, gestión de secretos | ✅ 14/14 tablas; probado con usuario multi-tenant. **⚠ no cubre acceso directo a infraestructura (R-07)** |
| **Remisión** | **D→R** | adaptador SENIAT tras interfaz | ⬜ ADR-0028 deja la estructura; **no hay protocolo publicado**. Sin valor de producto: existe solo si la norma lo exige |
| Registro de eventos | **P** | `outbox` + `EVENT_CATALOG` | 🟡 mecanismo ✅; **la política de qué se audita está diferida** (R-04) |
| Corrección con NC/ND | **P** | máquina de estados, nunca editar el original | ⬜ Fase 11. La regla 1 de `CLAUDE.md` ya la fija |
| Fecha/hora | **P** | timestamp de servidor, `occurred_at` validado contra reloj de pared | ✅ tolerancia de 30 s, en trigger |
| IVA | R | motor tributario versionado | ⬜ Fase 10 |
| **Acceso SENIAT** | **D** | rol + API de consulta | ⬜ **sin objeto**: era el Art. 3 numeral 8 de la 121. Sin valor de producto |
| **Nueva versión / release gate** | **D** | manifest y gate de CI | ⬜ existe solo en documentación (ADR-0009). **Se repuebla desde ya** como registro de versiones (ADR-0027 §5), no como gate |

## Lectura rápida: qué falta si mañana sale la norma

**De la categoría P no falta casi nada** —y eso es lo que hace que el producto sea vendible hoy—.
Los tres huecos reales son **conservación** (no hay política escrita), **continuidad** (no hay
infraestructura) y la **política** de qué se audita.

**De la categoría R falta todo**, y es lo esperado: es la Fase 10-11 completa.

Esta tabla es la que hay que mirar el día que se publique una providencia nueva. **Solo se revisan
las filas R y D.** Las P ya están, y no dependen de lo que diga.

## Prueba negativa esencial

Intentar `UPDATE`/`DELETE` sobre un documento fiscal emitido debe fallar a nivel de servicio y, para
tablas críticas, también por controles de base de datos. **Cubierto para `audit_events`** en dos
capas y probado contra `service_role`; pendiente para documentos fiscales, que no existen todavía.

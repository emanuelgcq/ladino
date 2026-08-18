# Expediente técnico — índice vivo

> **Qué es.** El documento entregable ante una eventual homologación. **No es un documento nuevo:
> es un índice que apunta a los ADR y specs donde cada cosa ya está decidida y verificada.**
> Duplicar el contenido garantizaría que las dos copias divergen — que es el fallo que este
> proyecto lleva toda su historia documentando.
>
> **Por qué existe ahora, sin haber homologación.** ADR-0027 §5: si el SENIAT vuelve a exigirla,
> Ladino debe poder homologarse **sin reescribir nada**. Un expediente reconstruido a posteriori es
> inferencia sobre el propio historial, y eso no lo acepta un evaluador.
>
> **Está incompleto a propósito.** Las filas `⬜` son trabajo futuro, no olvidos. Se completan solas
> a medida que avanzan las fases: cada ADR nuevo con impacto fiscal añade su fila aquí.
>
> **Corte: 2026-08-18** · S0.4 cerrado, S0.5 en curso.

---

## 1. Identificación

| | |
|---|---|
| Producto | Ladino — plataforma administrativa, contable y fiscal para Venezuela |
| Arquitectura | Cloud-first: webapp + app Expo + servicios en contenedores. **Sin cliente desktop.** |
| Estado regulatorio | `REGULATORY_STATUS.md` — PA121 derogada 12/08/2026, sin sustituta |
| Persona jurídica proveedora | ⬜ **decisión de negocio pendiente**, no bloquea la ingeniería |

## 2. Arquitectura

| Aspecto | Dónde está decidido | Estado |
|---|---|---|
| Arquitectura general y fronteras | `04_PLATFORM/ARCHITECTURE.md`, `00_GOVERNANCE/MONOREPO_STRUCTURE.md`, **ADR-0021** | ✅ con gate automático (`dependency-cruiser`) |
| Aislamiento del componente fiscal | **ADR-0003** (enmendado 2026-08-15) | ✅ decidido, `packages/fiscal` no construido |
| Modelo de datos | `04_PLATFORM/DATABASE_SCHEMA.md`, 13 migraciones aplicadas | 🟡 identidad, RBAC y auditoría ✅; negocio y fiscal ⬜ |
| Régimen fiscal por empresa | **ADR-0029** | 🟡 decidido, implementación Fase 10-11 |
| Transmisión al SENIAT | **ADR-0028** | 🟡 estructura decidida; **no hay protocolo publicado** |

## 3. Controles de inmutabilidad

**El control central, y cómo se verifica.** `audit_events` es append-only **en dos capas
independientes**:

1. **Privilegios de tabla** — ni `service_role` tiene `UPDATE`, `DELETE` ni `TRUNCATE`.
2. **Trigger `platform.reject_mutation()` (SQLSTATE `LAD06`)** — alcanza a `service_role`, que tiene
   `BYPASSRLS` y escapa a las policies. Enganchado **dos veces**: `FOR EACH ROW` para
   `UPDATE`/`DELETE`, y `FOR EACH STATEMENT` para `TRUNCATE`, que ignora la RLS y no dispara
   triggers de fila.

**Verificación:** `supabase/tests/008_audit_events_test.sql`. Las dos capas se prueban **por
separado**, concediendo a propósito el privilegio que la migración revoca — sin apartar la de
arriba, la de abajo nunca se ejerce y se creería tener dos defensas teniendo una.

| Control | Decidido en | Verificado en |
|---|---|---|
| Append-only en dos capas | **ADR-0006**, ADR-0025 §6 | pgTAP 008 · ✅ |
| Anclas de aislamiento inmutables (`LAD28`) | ADR-0025 | pgTAP 006, como **propiedad del catálogo** · ✅ |
| Procedencia no forjable (`created_by`, `created_at`) | `API_SPEC.md` §Procedencia | pgTAP 008 · ✅ |
| `payload_hash` por registro | **ADR-0026 D1** | pgTAP 008 · 🟡 **ver límite abajo** |
| Cadena hash | **ADR-0026 D1 — deliberadamente NO implementada** | — |
| Inmutabilidad de documentos fiscales | regla 1 de `CLAUDE.md`, `FISCAL_DOCUMENTS_SPEC.md` | ⬜ Fase 11 |

> **Límite declarado, y va aquí porque un evaluador lo preguntará.** `payload_hash` es una columna
> **generada**: se recalcula si la fila se reescribe. Frente a quien pueda saltarse el trigger
> —superusuario, `DISABLE TRIGGER`, un restore adulterado— el hash acompaña al payload manipulado.
> **La integridad la dan las dos capas de prevención, no la detección.** `FISCAL_DOCUMENTS_SPEC.md`
> admite la disyunción «bloqueada **o** detectada»: Ladino cumple por la rama «bloqueada».
> No debe presentarse como «hash de integridad».
>
> La cadena está **decidida en contra** por una razón estructural, no de rendimiento: exige orden
> total sobre las inserciones, y eso es un punto de serialización en la tabla que más crece. El
> diseño diferido —particionada por company, verificador asíncrono, nunca en el camino de
> escritura— está escrito en ADR-0026 §D1.

## 4. Trazabilidad

| Qué | Dónde | Estado |
|---|---|---|
| Pista de auditoría con autor, timestamp, origen y **versión de reglas** | `audit_events` (regla 3 de `CLAUDE.md`) | ✅ `rules_version` es columna propia, `NOT NULL` |
| Quién escribe la auditoría | **ADR-0026 D2** — el caso de uso, en su misma transacción | ✅ decidido |
| Aislamiento entre clientes | ADR-0025, 43 policies, RLS enable+force | ✅ probado **con usuario multi-tenant** |
| Revocación inmediata de acceso | **ADR-0014** | ✅ pgTAP 007, 11 aserciones, **sin reemitir token** |
| Cambio de RIF con valor anterior | M4, migración `20260811190652` | ✅ pgTAP 011 |
| Catálogo de eventos auditables | `EVENT_CATALOG.md` | 🟡 **R-04**: mecanismo ✅, política diferida con dueño |
| Acceso de soporte del operador | **ADR-0030** | 🟡 decidido, Fase 10 |
| Retención | — | ⬜ **sin política.** Plazo legal `VALIDAR-SENIAT`; la operativa se puede escribir ya |

## 5. Versionado y control de cambios

| Qué | Dónde | Estado |
|---|---|---|
| Migraciones expand/contract, nunca editar una aplicada | **ADR-0019** | ✅ con hook |
| Release train fiscal aislado | **ADR-0003**, ADR-0009 | 🟡 decidido, sin implementar |
| `fiscal_protocol_version` y manifest | `05_INFRA/RELEASE_AND_VERSION_HOMOLOGATION.md` | ⬜ **solo en documentación** — ver §7 |
| Reglas tributarias efectivas por fecha y fuente | regla 8 de `CLAUDE.md` | ⬜ Fase 10 |
| Versión de régimen fiscal | **ADR-0029 §5** | 🟡 decidido |

## 6. Cómo se verifica cada control

**El principio, y es lo que distingue este expediente de una declaración de intenciones: cada
control tiene una prueba automatizada que falla si el control desaparece.**

| Gate | Qué comprueba | Bloqueante |
|---|---|---|
| `pnpm verify` (9 pasos) | formato, fronteras, lint, tipos, tests, build, superficie de API, **reset de BD desde cero**, **pgTAP** | ✅ |
| pgTAP — 13 suites, **368 aserciones** | aislamiento, append-only, RBAC, procedencia, constraints | ✅ |
| `pnpm test:concurrency` | outbox bajo N sesiones reales de `pgbench` | fuera de `verify` **a propósito**: es muestral |
| Gate de coste (pgTAP 013) | que la resolución de permisos no se degrade en la ruta de RLS | ✅ |
| `rls-security-auditor` · `fiscal-reviewer` | revisión al cerrar todo lo de rigor máximo | proceso |

**Dos propiedades del enfoque de prueba que conviene declarar, porque no son habituales:**

- **Las pruebas de invariantes críticos traen su variante rota.** Se rompe el control a propósito y
  se comprueba que la prueba **falla**. Una prueba que nunca ha fallado no se sabe si detecta algo.
  Ejemplos ejecutables: `pnpm test:concurrency:selftest`, y el gate de coste que reintroduce la
  regresión que detectó.
- **Se ejerce el camino, no se consulta el privilegio.** Un bit de `has_table_privilege` dice que
  *puedes intentarlo*, no que funcione. En S0.4 esa distinción destapó que la tabla de auditoría
  nacía escribible por nadie con todos los checks en verde.

## 7. Lo que falta, y en qué fase

| Falta | Fase | Nota |
|---|---|---|
| Política de retención | antes de producción | plazo legal `VALIDAR-SENIAT`; la operativa no depende de nadie |
| Continuidad: HA, backups, DR probado | S0.6 | |
| **Manifest de versiones poblado desde la primera release** | **empieza en S0.6** | ver requisitos abajo |
| Numeración fiscal transaccional sin huecos | Fase 11 | la idempotencia **no** lo sustituye |
| Adaptador de imprenta digital | Fase 11 | PA 102 vigente |
| Contingencia definida y probada | Fase 11 | |
| Snapshot fiscal completo en documentos (**R-05**, diez elementos) | Fase 11 | |
| Formato del RIF | bloqueado | `VALIDAR-SENIAT`. **Ningún regex hasta la respuesta, ni en Postgres ni en Zod** |

### Requisitos para que el manifest empiece a generarse en S0.6

Anotado aquí porque el entregable 2 de ADR-0027 §5 solo sirve si arranca en la primera release:

1. **Qué campos lleva cada entrada**: versión, fecha, commit, digest del artefacto,
   `fiscal_protocol_version`, regímenes soportados (ADR-0029), migraciones incluidas, y
   `fiscal_behavior_changed` sí/no con su justificación.
2. **Dónde vive**: fichero versionado en el repositorio, **no** un registro externo — tiene que
   poder auditarse con el mismo historial que el código.
3. **Quién lo genera**: paso de CI en el pipeline de release, no a mano.
4. **Qué lo hace fallar**: una release cuyo `fiscal_behavior_changed = true` sin entrada de
   justificación.
5. **Retroactivo**: las versiones de Sprint 0 se anotan como línea base con lo que ya se sabe
   —commits, migraciones, ADR— **antes** de que el historial deje de ser reconstruible.

---

## Advertencia de alcance

Este expediente cubre los controles **de la aplicación**. **No cubre el acceso directo a la
infraestructura**: quien tenga las credenciales del proyecto Supabase no pasa por ninguna de estas
defensas. Es cierto, no lo cubre ADR-0030, y está registrado como **R-07** en `RISK_REGISTER.md`.

# Plan de implementación — Ladino

> **Actualizado 2026-08-15 por cambio regulatorio.** PA SNAT/2024/000121 derogada sin sustituta
> (PA SNAT/2026/00084, Gaceta 43.435, 12/08/2026). Ver `docs/02_COMPLIANCE/REGULATORY_STATUS.md`,
> ADR-0027 y ADR-0028.
>
> **Efecto sobre el orden:** el paso 11 (ledger fiscal y documentos) **deja de ser gate
> bloqueante** y pasa a ser un paso más, desacoplado. Los pasos 0–10 y 13–15 se pueden completar,
> desplegar y **vender** sin él.

## Regla de dependencia

Ningún módulo que genere dinero, stock o documentos fiscales persiste "estado final" desde la UI.
Siempre invoca un caso de uso de dominio transaccional que, en una sola transacción:

autoriza → resuelve idempotencia → bloquea agregados → valida → calcula con reglas versionadas →
persiste → impacta contabilidad e inventario → audita → encola outbox → commit.

El patrón completo, con esqueleto de código, está en la skill `caso-de-uso`.

## Orden obligatorio

Cada paso asume el anterior terminado y verificado. Saltarse el orden produce reescrituras.

| # | Bloque | Sesiones Claude Code sugeridas |
|---|---|---|
| 0 | Bootstrap (ver `SPRINT_0_BOOTSTRAP.md`) | 6 sesiones: esqueleto · money · identidad+RLS · audit+outbox · API+caso de uso · contenedores |
| 1 | Identidad organizacional y aislamiento | incluido en Sprint 0 |
| 2 | Modelo monetario/decimal | incluido en Sprint 0 |
| 3 | Audit log | incluido en Sprint 0 |
| 4 | Maestros (clientes, proveedores, productos, impuestos) | 3–4 sesiones |
| 5 | Inventario y kardex | 4–5 sesiones |
| 6 | Ventas y CxC | 5–6 sesiones |
| 7 | Compras y CxP | 4–5 sesiones |
| 8 | Tesorería, caja y bancos | 3–4 sesiones |
| 9 | Ledger contable y plan de cuentas | 5–6 sesiones |
| 10 | Motor tributario versionado | 4–5 sesiones |
| 11 | Ledger fiscal y documentos | 5–6 sesiones · **ya no es gate: desacoplado (ADR-0027)** |
| 12 | Adaptador de imprenta digital | 2–3 sesiones · PA 102 sigue vigente |
| 13 | Webapp completa | transversal |
| 14 | App Expo | 4–6 sesiones |
| 15 | Reportes y libros fiscales | 4–5 sesiones |
| 16 | ~~Homologación~~ → **transmisión al SENIAT** | **diferido sin fecha**: no hay protocolo publicado. La estructura queda lista (ADR-0028); el adaptador se escribe cuando exista norma |
| 17 | IA asistida | 2–3 sesiones |

Una "sesión" es una unidad de trabajo con un objetivo único, que termina con `pnpm verify`
en verde y un handoff escrito. No es una medida de tiempo.

## Sprints

- **S1–S2** — Sprint 0 completo. Nada de negocio.
- **S3–S5** — maestros e inventario.
- **S6–S8** — ventas, compras, CxC, CxP.
- **S9–S11** — contabilidad.
- **S12–S14** — motor tributario y fiscal.
- **S15–S16** — mobile.
- **S17+** — hardening de homologación y módulos avanzados.

## Gate de salida

~~No se libera emisión fiscal productiva hasta completar la autorización/homologación aplicable~~
— **sin objeto desde 2026-08-15**.

Se libera emisión fiscal productiva cuando se cumplan **PA 071 y PA 102** y se cierren los
`VALIDAR-SENIAT` que siguen abiertos en `REGULATORY_STATUS.md` §5. Seis de los ocho originales
quedaron resueltos por derogación.

Y el matiz que ahora vale más que el gate: esos bloqueantes **nunca detuvieron** los pasos 0 a 9,
y desde la derogación tampoco detienen el **lanzamiento**. Construir en paralelo mientras se
gestionan las respuestas sigue siendo lo correcto; lo incorrecto sería asumir una respuesta y
construir sobre ella — incluida la de suponer cómo será la norma esperada.

## S0.6 — diferido

`SPRINT_0_BOOTSTRAP.md` sitúa en S0.6 los contenedores y el proyecto Supabase remoto, con el
release train fiscal y el manifest de homologación como parte del encargo. **Esa parte se
difiere**: `fiscal_protocol_version` y `homologation_status` existen hoy solo en documentación, y
el gate de CI que ADR-0009 describe no tiene destinatario mientras no haya régimen al que
reportar.

Se difiere **el gate**, no el versionado. Que un despliegue sepa qué versión de reglas aplicó
sigue siendo necesario por ADR-0027 §3, y `rules_version` ya es columna en `audit_events`. Lo que
espera es el manifest y su paso de CI.

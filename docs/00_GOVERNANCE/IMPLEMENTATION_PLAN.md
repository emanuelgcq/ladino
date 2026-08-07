# Plan de implementación — Ladino

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
| 11 | Ledger fiscal y documentos | 5–6 sesiones |
| 12 | Adaptador de imprenta digital | 2–3 sesiones |
| 13 | Webapp completa | transversal |
| 14 | App Expo | 4–6 sesiones |
| 15 | Reportes y libros fiscales | 4–5 sesiones |
| 16 | Homologación | proceso, no sesiones |
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

No se libera emisión fiscal productiva hasta completar la autorización/homologación aplicable
y resolver los `VALIDAR-SENIAT` de `OPEN_QUESTIONS.md`.

Esos bloqueantes **no detienen** los pasos 0 a 9. Construir en paralelo mientras se gestionan
las respuestas es lo correcto; lo incorrecto sería asumir una respuesta y construir sobre ella.

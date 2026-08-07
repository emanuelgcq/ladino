---
name: adr
description: Escribir un Architecture Decision Record de Ladino. Úsalo obligatoriamente ante cualquier decisión que afecte persistencia, fiscalidad, sincronización offline, seguridad o el contrato de la API.
---

# ADR — Ladino

Archivo: `docs/00_GOVERNANCE/adr/ADR-XXXX-titulo-en-kebab.md` (siguiente número libre).
Actualiza también la tabla de `docs/00_GOVERNANCE/ADR_INDEX.md`.

```md
# ADR-XXXX — <Título>

- **Estado:** Propuesto | Aceptado | Sustituido por ADR-YYYY | Rechazado
- **Fecha:** YYYY-MM-DD
- **Impacto fiscal:** SÍ | NO

## Contexto
Qué problema real fuerza esta decisión. Restricciones: SENIAT, VPS compartido,
multimoneda, offline, equipo de una persona.

## Opciones consideradas
1. **<Opción>** — a favor / en contra.
2. ...

## Decisión
Qué se elige y por qué gana a las demás.

## Consecuencias
- Positivas.
- Negativas y deuda técnica que aceptamos.
- Qué habría que cambiar para revertirla.

## Verificación
Cómo sabremos si la decisión fue correcta (métrica, prueba, plazo de revisión).
```

Un ADR sin sección de consecuencias negativas está incompleto. Toda decisión cuesta algo.

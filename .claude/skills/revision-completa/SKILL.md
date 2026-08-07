---
name: revision-completa
description: Revisión previa a considerar terminada cualquier historia de Ladino. Ejecuta el Definition of Done completo y los subagentes de revisión que correspondan.
---

# Revisión de cierre — Ladino

## 1. Automático

```bash
pnpm verify        # lint + typecheck + test + build
pnpm test:rls      # pgTAP
```

Si algo falla, no continúes. No reportes "listo con un test rojo pendiente".

## 2. Subagentes según lo tocado

| Tocaste… | Invoca |
|---|---|
| dinero, asientos, pagos, inventario valorado | `accounting-invariants` |
| facturas, impuestos, libros, numeración, imprenta | `fiscal-reviewer` |
| migraciones, policies, permisos, endpoints | `rls-security-auditor` |
| pantallas Expo | `mobile-expo` |

## 3. Definition of Done — recórrelo y marca

Lee `docs/00_GOVERNANCE/DEFINITION_OF_DONE.md` y presenta la lista con ✅/❌ real.
Un ❌ significa que la historia **no está terminada**. Dilo así.

## 4. Informe

```
RESUMEN
ARCHIVOS
MIGRACIONES
TESTS
RIESGOS
DEFINITION OF DONE  — checklist marcado
HOMOLOGATION_IMPACT = YES | NO
VALIDAR-*
SIGUIENTE PASO SUGERIDO
```

No hagas commit ni push. Espera instrucción explícita.

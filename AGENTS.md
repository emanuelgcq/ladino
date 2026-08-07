# AGENTS.md

Este repositorio usa `CLAUDE.md` en la raíz como fuente única de instrucciones para agentes
de codificación, más `CLAUDE.md` anidados por paquete.

**Lee `./CLAUDE.md` antes de hacer nada.**

Resumen mínimo si tu herramienta no soporta carga anidada:

- Nunca `float`/`number` para dinero. Postgres `numeric(24,8)`, TypeScript `Decimal`, JSON `string`.
- Documentos fiscales emitidos y asientos `posted` son inmutables. Se revierten, no se editan.
- Toda tabla lleva `tenant_id` y RLS forzado.
- Ninguna regla tributaria se inventa: si no está en `docs/02_COMPLIANCE/` con fuente, se para.
- No se toca el contenedor n8n del VPS.
- Investigar → planificar → esperar aprobación explícita → implementar → verificar.

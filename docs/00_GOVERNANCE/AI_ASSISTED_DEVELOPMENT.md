# Desarrollo asistido por IA — cómo se trabaja Ladino con Claude Code

## Capas de extensión y para qué sirve cada una

| Capa | Archivo | Para qué |
|---|---|---|
| Memoria | `CLAUDE.md` raíz y anidados | Lo que Claude debe saber siempre en ese ámbito |
| Skills | `.claude/skills/<n>/SKILL.md` | Playbooks repetibles: cómo se hace X aquí |
| Subagentes | `.claude/agents/*.md` | Trabajo que merece contexto propio: investigar, revisar |
| Hooks | `.claude/hooks/*.sh` | Reglas que **no** se pueden negociar con el modelo |
| MCP | `.mcp.json` | Acceso a Supabase y GitHub |
| Permisos | `.claude/settings.json` | Qué se ejecuta solo, qué pregunta, qué está prohibido |

La distinción que importa: `CLAUDE.md` **persuade**, un hook **impide**. Todo lo que sea
catastrófico si falla —dinero en float, `service_role` en el cliente, editar una migración
aplicada, tocar n8n— está en un hook, no en prosa.

## Hooks activos

| Hook | Qué bloquea |
|---|---|
| `guard-immutability.sh` | Editar migraciones aplicadas · `service_role` en cliente · `number`/`parseFloat` en paquetes financieros · `UPDATE`/`DELETE` en append-only · tipos float en DDL · tasas hard-coded en la UI |
| `guard-infra.sh` | Cualquier comando que mencione n8n · reinicio de Traefik · `docker system prune` · `compose down` sin acotar · operaciones contra el Supabase remoto |
| `post-edit-verify.sh` | (no bloquea) formatea y recuerda tests de RLS tras tocar SQL |
| `session-start.sh` | (no bloquea) inyecta estado y recordatorios al abrir sesión |

Si un hook bloquea algo legítimo, **no se desactiva el hook en esa sesión**: se discute con
el usuario y se ajusta el hook en un commit aparte.

## Ritmo de trabajo

1. **Investigar** — `spec-explorer` lee las specs y devuelve síntesis.
2. **Planificar** — plan mode. Archivos, migraciones, tests, riesgos, `HOMOLOGATION_IMPACT`.
3. **Aprobar** — el usuario dice que sí, explícitamente. Sin eso no se implementa.
4. **Test primero** — en todo lo que toque dinero, stock o fiscal.
5. **Implementar** — incrementos verificables, no un volcado de 2.000 líneas.
6. **Verificar** — `pnpm verify` + subagentes de revisión.
7. **Entregar** — formato de la sección 6 del `CLAUDE.md` raíz.
8. **Handoff** — skill `handoff` al cerrar la sesión o cuando el contexto se llene.

## Higiene de contexto

- Una sesión, un objetivo. No se mezcla "implementa inventario" con "arregla el CI".
- Investigación amplia siempre en subagente.
- `/clear` entre tareas no relacionadas. `/compact` no sustituye a un handoff escrito.
- Si el contexto pasa del 70%, se escribe el handoff y se empieza sesión nueva.

## Qué no se le delega a la IA en este proyecto

Decidir una tasa, un formato SENIAT o una interpretación legal. Aprobar un deploy fiscal.
Ejecutar comandos contra producción. Hacer commit sin aprobación.

Ver ADR-0010: la IA propone, una regla determinista o una persona dispone.

# Memoria de Claude — copia portátil

La memoria de Claude Code vive FUERA del repositorio, en la máquina
(`~/.claude/projects/<ruta-del-proyecto>/memory/`), así que no viaja con un
`git clone`. Esta carpeta es una copia tomada el **2026-09-11**, al cambiar de
PC, para que la sesión siguiente no empiece de cero.

## Para el Claude que lea esto en la máquina nueva

1. Lee `MEMORY.md` (el índice) y los ficheros que enlaza. Son hechos y
   correcciones del dueño que NO están en el código ni en `CLAUDE.md`: la regla
   de posición del sidebar, que Ladino está en producción y cómo se despliega,
   el orden obligatorio `db:reset` → `verify` con migraciones nuevas, por qué no
   hay pipelining que optimizar, y la receta para auditar pantallas contra la
   API de producción.
2. Copia estos ficheros (todos menos este `README.md`) al directorio de memoria
   que tu propio prompt de sistema te indica. El nombre de esa carpeta depende
   de la ruta donde se clonó el repo, por eso no se puede fijar aquí.
3. Verifica antes de fiarte: la memoria describe cómo eran las cosas el día que
   se escribió. Si un fichero nombra una función, una ruta o un flag,
   compruébalo en el código.

Lo que pasó en la sesión que cerró esta copia está en
`docs/00_GOVERNANCE/sesiones/2026-09-10-produccion-cobro-auditoria-igtf.md` y el
estado operativo en `docs/00_GOVERNANCE/HANDOFF.md` (18ª entrega).

**Sin secretos**: se revisó que ningún fichero contenga tokens, claves ni
contraseñas. Si alguna vez hace falta uno, lo pega el dueño; no se guarda aquí.

**Aviso**: `CLAUDE.md` §9 dice «Sprint 0 — Nada está construido todavía». Está
desactualizado: Ladino está en producción desde 2026-09-07. Actualizarlo es
decisión del dueño.

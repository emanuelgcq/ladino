-- Correcciones del ESCENARIO del recorrido 2026-09-24 (solo base local, nunca producción).
--
-- `pnpm recorrido restaurar` corre esto entre la carga de los datos del volcado (migración 73) y
-- las migraciones nuevas. Aquí va lo que el escenario trae mal POR los defectos que el recorrido
-- encontró y que una migración nueva rechazaría con razón (RESPUESTA del dueño: «se corrige en el
-- escenario, no en producción»). Cada corrección cita su hallazgo. Vacío hasta que haga falta.

select 1;

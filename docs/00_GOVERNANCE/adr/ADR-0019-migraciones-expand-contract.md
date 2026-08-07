# ADR-0019 — Migraciones expand/contract, nunca destructivas en un paso

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** SÍ

## Contexto
Migración y despliegue no son atómicos. Durante unos minutos conviven el esquema nuevo y la
versión anterior de la aplicación. Y la app móvil convive por semanas.

## Decisión
Tres pasos separados en releases distintas:
1. **Expand** — agregar columna/tabla nullable, sin romper nada.
2. **Migrate** — backfill y doble escritura mientras ambas versiones conviven.
3. **Contract** — eliminar lo viejo, solo cuando ninguna versión soportada lo use.

Prohibido en una sola migración: renombrar una columna en uso, borrar una columna con datos,
cambiar un tipo de forma incompatible, agregar `not null` sin default a una tabla con filas.

Cada migración declara en su cabecera si es reversible y cómo.

## Consecuencias
- (+) Cero downtime y compatibilidad N/N-1 real con la app móvil.
- (−) Tres veces más migraciones para el mismo cambio, y la disciplina de volver a hacer el
  paso de contract semanas después. Se rastrea con un issue por cada expand pendiente de contraer.

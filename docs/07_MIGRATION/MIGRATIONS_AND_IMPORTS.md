# Migraciones e importaciones

## Fuentes posibles
Excel/CSV y exportaciones de sistemas existentes.

## Pipeline
upload → profile → map → validate → dry-run → approve → import → reconcile → seal report.

## Nunca
Importar directamente a tablas fiscales `issued` sin un modo de migración controlado que preserve evidencia y diferencie histórico de documentos emitidos por Ladino.

## Saldos iniciales
- AR/AP open items;
- stock;
- GL opening;
- bancos.
Deben cuadrarse con reporte de migración.

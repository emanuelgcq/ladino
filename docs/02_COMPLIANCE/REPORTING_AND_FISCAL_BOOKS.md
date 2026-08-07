# Reportes y libros fiscales

## Mínimos
- Libro de Ventas.
- Libro de Compras.
- Retenciones IVA.
- Retenciones ISLR.
- Resumen por alícuota.
- Documentos anulados/ajustados.
- NC/ND.
- Auditoría de facturas.
- Auditoría de cajas.
- Operaciones por canal/medio de facturación.
- Exportaciones requeridas por administración tributaria.

## Regla
El reporte fiscal no recalcula el pasado con reglas actuales. Lee snapshots del documento emitido.

## Reproducibilidad
Cada reporte debe persistir:
- parámetros;
- periodo;
- timezone;
- versión del generador;
- hash de dataset;
- generado por;
- generado en.

## Export
PDF, XLSX/CSV y TXT/XML solo donde el formato regulatorio lo exija/configure.

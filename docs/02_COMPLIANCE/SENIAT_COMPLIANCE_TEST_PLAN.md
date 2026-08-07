# Plan de pruebas SENIAT

## Suites

### Integridad
- update/delete de factura emitida.
- manipulación de secuencia.
- cambio de hora.
- cambio de tasa post-emisión.

### Trazabilidad
- cada acción produce evento.
- evento incluye actor/time/IP/device/build.
- export auditoría completa.

### NC/ND
- corregir precio;
- devolución parcial;
- devolución total;
- débito posterior.

### Secuencias
- concurrencia de 1000 emisiones.
- retry.
- timeout de imprenta.
- recuperación worker.

### Consulta SENIAT
- rol no puede escribir;
- acceso a documentos/eventos;
- filtros;
- audit de su propia consulta.

### Contingencia
- internet down;
- mobile down;
- electricidad/talonario;
- sincronización posterior.

### Versionado
- build no homologado bloqueado en producción fiscal.
- rollback de UI sin alterar fiscal ledger.

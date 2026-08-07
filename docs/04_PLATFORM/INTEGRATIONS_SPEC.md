# Integraciones

## Patrón adapter
Cada proveedor implementa:
- health;
- authenticate;
- send;
- query;
- normalize error;
- webhook verify.

## Integraciones previstas
- imprenta digital;
- SENIAT según especificación publicada/entregada;
- bancos/import;
- email;
- SMS/WhatsApp opcional;
- Cashea/pasarelas si comercialmente aplica;
- impresoras fiscales solo si homologación lo contempla.

## Fiabilidad
- circuit breaker;
- retry con backoff;
- idempotencia;
- DLQ;
- observabilidad.

# Retenciones

## Alcance
- IVA.
- ISLR.
- otros conceptos configurables.

## Modelo
- agente/sujeto;
- documento base;
- periodo;
- base;
- porcentaje/regla;
- monto;
- comprobante;
- fecha;
- estado.

## Comprobante digital
PA102 define requisitos específicos y una numeración de 14 caracteres para comprobantes de retención digitales. Implementar la máscara mediante generador versionado y validación.

## Estados
draft → calculated → issued → applied → reported.

## Reglas
- evitar doble retención sobre misma base/documento/concepto;
- conservar versión de regla;
- reversión mediante documento/proceso permitido, no delete.

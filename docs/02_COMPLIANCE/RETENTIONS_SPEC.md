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

## Fuentes normativas (verificadas 2026-09-12)

- **PA SNAT/2025/000054** — agentes de retención de IVA. Vigente desde el 01/08/2025; deroga la
  PA SNAT/2015/0049. Mantiene el 75 % general y el 100 % para los supuestos listados. Es la
  `legal_source` que debe citar toda regla `iva` cargada en `retention_rules`.
- **ISLR**: Decreto 1.808 (reglamento parcial de retenciones) y sus tablas; **VALIDAR-TRIBUTARIO**
  cada concepto y sustraendo antes de cargarlo.
- El catálogo **nace vacío** (ADR-0039) y cada regla es **de la empresa que la carga**
  (ADR-0057): una empresa no retiene con la regla de otra.
- Fuente secundaria consultada: Forvis Mazars, «Providencia agentes de retención del IVA»
  (08/2025). Texto primario en Gaceta pendiente de archivar en `EXPEDIENTE_TECNICO.md`.

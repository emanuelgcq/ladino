# ADR-0003 — El componente fiscal es un bounded context aislado con release train propio

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** SÍ

## Contexto
Si cada despliegue de una pantalla de CRM implicara rehomologar el sistema fiscal, el producto
sería inmantenible. La separación es una decisión de supervivencia comercial, no de elegancia.

## Decisión
`packages/fiscal` + contenedor `ladino-fiscal` con contrato versionado, `fiscal_protocol_version`
en el payload, migraciones compatibles, adaptadores tras interfaz, y ciclo de release propio.
El resto del ERP se despliega libremente sin tocar el artefacto fiscal.

## Consecuencias
- (+) UI, CRM, inventario y analítica evolucionan sin gate de homologación.
- (−) Sobrecoste de mantener dos trenes de release y una ventana de compatibilidad.
- (−) **`VALIDAR-SENIAT`**: que la frontera sea aceptada como tal por SENIAT no está confirmado.
  Si no lo fuera, la consecuencia es que todo despliegue entra al gate; el diseño sigue siendo
  correcto, solo más caro.

## Verificación
Un despliegue de `apps/web` no cambia el digest de `ladino-fiscal` ni el manifest fiscal.

# ADR-0007 — Expo + React Native para la app móvil

- **Estado:** Aceptado (por producto) · **Fecha:** 2026-08-07 · **Impacto fiscal:** SÍ

## Contexto
Se necesita operación móvil real (recepción, conteo, cobranza, POS) en iOS y Android con un
equipo muy pequeño y sin capacidad de mantener dos bases nativas.

## Decisión
Expo con New Architecture activada, Expo Router, EAS Build con canales `staging` y `production`.
TypeScript compartido con el resto del monorepo vía `packages/schemas` y `packages/api-client`.

## Consecuencias
- (+) Una base de código, OTA para correcciones no fiscales, ciclo de iteración corto.
- (−) Dependencia del ciclo de SDK de Expo; las migraciones de versión mayor se planifican.
- (−) **`VALIDAR-SENIAT`**: un build que emita documentos fiscales entra en el alcance de
  homologación. Hasta confirmarlo, el POS móvil vive tras feature flag y no se libera.
- (−) OTA **no** puede usarse para cambiar comportamiento fiscal. Esa regla es absoluta.

## Verificación
El pipeline de EAS rechaza publicar OTA si el diff toca `packages/fiscal`.

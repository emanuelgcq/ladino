# apps/mobile

App Expo de Ladino. Operación móvil, **no** un ERP de escritorio metido en un teléfono.

Ver `docs/04_PLATFORM/MOBILE_EXPO_SPEC.md` y `docs/08_UX/MOBILE_UX_RULES.md`.

## Límites duros

- Sin reglas tributarias ni contables. Consume la API.
- Tokens en SecureStore. Nunca `service_role`, nunca claves de servidor en el bundle
  ni en `app.config.ts` (recuerda: todo `EXPO_PUBLIC_*` es público).
- Offline solo para lo reconciliable: catálogo cacheado, conteos, borradores, fotos,
  cotizaciones no fiscales. **Nunca** pagos, stock definitivo, facturas fiscales ni cierres.
- Cada comando offline lleva `client_command_id`; el servidor aplica idempotencia.
- Jamás "last write wins" en stock, dinero, documentos o contabilidad: el conflicto se
  devuelve explícito y la pantalla lo muestra con opciones.

## Compatibilidad

El backend soporta la versión N y N-1 de la app. Si un build deja de ser compatible con el
protocolo fiscal, se fuerza actualización. Esa comprobación va en el arranque.

## Homologación

`VALIDAR-SENIAT`: si un build Expo emite documentos fiscales, ese build entra en el alcance
técnico de homologación. Hasta confirmarlo, el POS móvil se construye detrás de feature flag
y **no se libera**.

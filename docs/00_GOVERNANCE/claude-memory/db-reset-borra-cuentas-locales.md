---
name: db-reset-borra-cuentas-locales
description: "Tras cada db:reset del verify, las cuentas locales no-demo desaparecen pero la sesión del navegador sobrevive — fundar/operar da NOT_FOUND (23503→404), no un error de sesión"
metadata: 
  node_type: memory
  type: project
  originSessionId: e5ddae20-4236-42c7-a011-6eca2cb4c4e5
  modified: 2026-09-05T03:45:11.900Z
---

El paso 10 del verify (`db:reset`) reconstruye la base local y borra `auth.users`;
`pnpm demo:seed` solo recrea `demo@ladino.dev`. Un JWT emitido antes del reset sigue
validando por firma (JWKS), así que el navegador conserva una sesión de un usuario que
ya no existe: cualquier escritura que lo referencie rompe con SQLSTATE 23503, que
`apps/api/src/middleware/errors.ts` mapea a `NOT_FOUND: Recurso no encontrado` (404).
Visto dos veces con «Fundar mi negocio» (2026-09-04/05); el mensaje despista — parece
ruta faltante o build viejo, y no lo es.

Remedio para el usuario: Salir → «Crea tu cuenta con este correo» de nuevo (el mismo
correo vale) → fundar. Diagnóstico rápido: `POST /v1/onboarding` sin token — si da 401,
la ruta existe y es este caso; si da NOT_FOUND, es el build viejo en :3000 (ver
[[sidebar-arriba-consulta-abajo-administra]] no aplica; el caso build viejo es matar el
PID en :3000 y relanzar `node apps/api/dist/server.js`). Solo pasa en local: producción
nunca reconstruye la base. Mejora posible (no hecha, pediría aprobación): que el
middleware distinga «usuario inexistente» y devuelva 401 para que la web bote la sesión.

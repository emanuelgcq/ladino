---
name: auditoria-visual-contra-produccion
description: "Cómo levantar la web local contra la API de PRODUCCIÓN para auditar pantallas con Playwright — proxy con Origin, envDir, y de dónde sale la clave anon (no está en el .env)"
metadata: 
  node_type: memory
  type: reference
  originSessionId: e5ddae20-4236-42c7-a011-6eca2cb4c4e5
  modified: 2026-09-11T16:19:32.812Z
---

Receta usada el 2026-09-10 para la auditoría visual de las 22 pantallas.

1. **Config temporal** `apps/web/vite.audit.config.ts` (NO se commitea — tiene que
   vivir dentro de `apps/web` para resolver `vite`): `server.port 5199`,
   `strictPort`, y proxy `"/v1" → https://api.ladinosystem.com` con
   `changeOrigin: true` y `headers: { Origin: "https://app.ladinosystem.com" }`.
   La API solo acepta ese origen (CORS correcto); el proxy lo hace el servidor
   de vite.
2. **Las `VITE_*` NO están en el `.env` de la raíz** (y leer `.env` está
   bloqueado por permisos). Se pasan al proceso: `VITE_SUPABASE_URL` =
   `https://udacvwnhwpsdzbouhqhl.supabase.co`, `VITE_API_URL=""` (vacío → las
   llamadas van a `/v1` del propio vite), y `VITE_SUPABASE_PUBLISHABLE_KEY` = la
   clave **anon** (208 car., `eyJ…`) pedida a la Management API
   (`/v1/projects/<ref>/api-keys`) con el token como variable de entorno de ESA
   orden. El `anon.key` viejo del scratchpad (153 car.) está mal: da «Invalid API
   key».
3. **Trampa del puerto**: con `strictPort`, un vite viejo en :5199 hace fallar al
   nuevo en silencio y el `curl` da 200 contra el viejo. Matar lo que escucha en
   5199 (`Get-NetTCPConnection -LocalPort 5199`) antes de relanzar.
4. Playwright: `import` absoluto desde el caché de npx; Chromium 1243. Login con
   el usuario semilla (credenciales en el scratchpad, NUNCA en el repo). La base
   es PRODUCCIÓN: solo abrir diálogos con lista blanca de botones y cerrar con
   Escape; nada se envía.

Lecciones de la medición: un `visibilitychange` sintético tiene que llevar
`bubbles: true` (supabase-js escucha en `window`); los `input` de 1×1 dentro de
un diálogo son los ocultos de los Select de Base UI, no campos sin etiqueta;
«Nueva orden» y «Asiento manual» son pestañas (`role="tab"`), no botones.
Relacionado: [[ladino-en-produccion]].

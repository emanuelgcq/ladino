---
name: ladino-en-produccion
description: "Ladino está EN PRODUCCIÓN desde 2026-09-07 — dominios, VPS, flujo de actualización y configuración operativa"
metadata: 
  node_type: memory
  type: project
  originSessionId: e5ddae20-4236-42c7-a011-6eca2cb4c4e5
  modified: 2026-09-11T16:19:17.916Z
---

Ladino salió a producción el 2026-09-07, desplegado por el dueño vía terminal:
web `https://app.ladinosystem.com`, API `https://api.ladinosystem.com`, VPS
Hostinger 72.60.113.85 en `/opt/apps/ladino` (compose de raíz, patrón
Afterlaria: red `n8n_default` external, certresolver `mytlschallenge`, build
en el VPS). Base = Supabase Cloud `udacvwnhwpsdzbouhqhl` por pooler :6543 con
roles `ladino_api`/`ladino_worker` (la API rechaza superusuario). Correos por
Resend (dominio verificado `noreply.ladinosystem.com`, SMTP en Supabase,
plantillas de `supabase/templates/`), verificación de correo y recuperación
activas. Tasa BCV automática (refresco en la API).

**Why:** todo cambio ahora impacta usuarios reales; la actualización es
`git pull && docker compose up -d --build [servicio]` que ejecuta EL DUEÑO en
el VPS tras cada push avisado.

**How to apply:** tras pushear cambios de api/web, avisar al dueño qué
servicio reconstruir. Migraciones nuevas se aplican al remoto ANTES del pull
(patrón applyNN.mjs con token como env var). Nunca tocar n8n ni afterlaria.
Pendientes operativos conocidos: rotar token `sbp_` y considerar rotar la key
de Resend (circularon en el chat), observabilidad (Sentry/access log), dump
lógico propio, redondeo servidor de la deuda mostrada.

**Estado al 2026-09-11:** el VPS va POR DETRÁS del repo (no tiene ni los commits
de optimización del cobro ni los de la auditoría visual; el dueño despliega solo
con su «go»). Al desplegar: (1) aplicar la migración 47
(`20260910190000_igtf_rounding_policy.sql`) al remoto ANTES de reconstruir la
API — su default de transición la hace segura aunque la API vieja siga
corriendo; (2) `REQUEST_TIMEOUT_MS=90000` en el env de la API; (3) reconstruir
api y web. Después de que la API con ADR-0053 esté viva, una migración nueva
quita ese default. Ver [[auditoria-visual-contra-produccion]].

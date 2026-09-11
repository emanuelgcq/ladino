# Memoria — Ladino

- [verify-memory-limits](verify-memory-limits.md) — `pnpm verify` se cae por memoria en paralelo; usar `TURBO_CONCURRENCY=1`, hay otro stack Supabase ajeno levantado
- [sidebar-arriba-consulta-abajo-administra](sidebar-arriba-consulta-abajo-administra.md) — arriba se vende/consulta, lo administrativo va en POSICIÓN al grupo ADMINISTRACIÓN, no solo con gate de permiso
- [db-reset-borra-cuentas-locales](db-reset-borra-cuentas-locales.md) — tras db:reset la sesión local de un usuario borrado da NOT_FOUND (23503→404) al fundar; remedio: Salir y recrear la cuenta
- [ladino-en-produccion](ladino-en-produccion.md) — EN PRODUCCIÓN desde 2026-09-07 (app/api.ladinosystem.com, VPS 72.60.113.85, Supabase Cloud, Resend); actualizar = push + avisar al dueño qué servicio reconstruir; VPS atrasado, migración 47 antes de la API
- [auditoria-visual-contra-produccion](auditoria-visual-contra-produccion.md) — receta para correr la web local contra la API de producción (proxy+Origin, clave anon por Management API, trampa del puerto 5199)
- [migracion-nueva-db-reset-antes-del-verify](migracion-nueva-db-reset-antes-del-verify.md) — con migración nueva, `pnpm db:reset` ANTES del verify: los E2E del paso 5 usan la base vieja (dan 500)
- [postgres-js-sin-pipelining](postgres-js-sin-pipelining.md) — medido: dentro de una transacción no hay pipelining; solo quitar sentencias baja la latencia (140→94 viajes por venta)

# ADR-0049 — El primer día real: onboarding autoservicio y miembros

- **Estado:** aceptado (orden del dueño, 2026-09-05: «haz todo con las mejores prácticas»)
- **Se apoya en:** ADR-0025 (RBAC), ADR-0048 (roles con nombre). Ajusta la forma del rol
  `owner` de la migración 40.

## Contexto

La auditoría de superficie backend↔frontend encontró el hueco más grande posible: **el
arranque de una cuenta nueva no estaba cableado**. Registrarse no creaba tenant ni
membresía (no había endpoint, ni trigger); `createCompany` no creaba almacén ni plan
contable; los roles sembrados no eran asignables salvo por SQL; y la demo solo funcionaba
porque un script SQL lo sembraba todo a mano. Un usuario real quedaba autenticado y sin
poder hacer nada.

Y un descubrimiento del propio esquema: las operaciones de **nivel tenant** (crear
empresa, gestionar miembros) exigen un rol **plano** (`not requires_scope`) — el `owner`
acotado de la migración 40 no podía ni crear su segunda empresa.

## Decisión

1. **El dueño es plano y el almacén es un rol aparte** (migración 41): `owner` pierde los
   8 permisos acotados y vuelve a `requires_scope=false` (puede operar el nivel tenant);
   nace el sexto rol de sistema `warehouse_ops` («Operación de almacén»), acotado, con
   exactamente esos 8. El fundador recibe LOS DOS; el pgTAP exige que el par cubra el
   catálogo entero (cero fuera).
2. **`platform.bootstrap_tenant()`** (security definer — `ladino_api` no tiene INSERT
   sobre tenants a propósito): tenant + membresía + las dos asignaciones del fundador, con
   el guard **un-negocio-por-usuario** (LAD81). Ese guard ES la idempotencia del
   onboarding: la única ruta mutante sin `Idempotency-Key`, porque el middleware exige un
   tenant que esta ruta está creando — un reintento responde DUPLICATE y recargar la
   sesión enseña la empresa igual.
3. **`POST /v1/onboarding`** funda el negocio en UNA transacción: tenant, empresa (RIF
   opcional — placeholder `PEND-` derivado del tenant; el modo recibos de ADR-0037/mig.37
   deja vender desde hoy), primer depósito con el binding de `warehouse_ops`, y el plan
   contable ve_basico CON sus plantillas de asiento — el plan sin el preset dejaba toda
   venta en la cola contable para siempre.
4. **Miembros por correo** (`/v1/members`): la persona se registra sola y el dueño la
   agrega por su correo (`platform.user_id_by_email`, security definer, devuelve solo el
   id; `user_email` devuelve solo el correo para la lista). Autorización de nivel tenant
   con `membership.read`/`membership.manage` y rol plano — un rol acotado gobierna
   almacenes, no personas. Roles acotados asignados a un invitado reciben bindings a
   TODOS los almacenes de la empresa; el recorte fino queda para cuando haga falta.
5. **Guards de timón**: nadie se quita a sí mismo el rol de dueño ni se desactiva a sí
   mismo. Desactivar la membresía corta el acceso entero en la consulta siguiente
   (ADR-0014); sin ninguna asignación, la empresa se vuelve INVISIBLE (la regla
   404-antes-que-403, verificada en E2E).
6. **Web**: la pantalla de «no tienes empresas» deja de pedir un tenant_id crudo y pasa a
   «Fundar mi negocio» (nombre + RIF opcional); Configuración gana «Usuarios y roles»
   (con los oficios explicados en una línea) y «Depósitos»; importar el plan en
   Contabilidad importa también el preset.

## Consecuencias

- La demo sigue sembrando por SQL (es un entorno, no un usuario); el camino real ya no
  depende de ella. Invitación por correo CON email saliente (para quien aún no tiene
  cuenta) queda para cuando haya proveedor de correo — hoy el mensaje del 404 dice
  exactamente qué hacer.
- Un fundador que quiera limitar a un encargado a UN almacén de varios tendrá que esperar
  el recorte fino de bindings en la pantalla (pendiente declarado).

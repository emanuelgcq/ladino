# ADR-0048 — Roles con nombre y navegación por permiso

- **Estado:** aceptado (orden del dueño, 2026-09-04/05)
- **Se apoya en:** ADR-0025 (modelo RBAC) — no lo cambia: lo PUEBLA y lo enseña.

## Contexto

El sistema tenía el mecanismo completo (roles → permisos → membresías, ~70 permisos, RLS,
segregación en la spec) y **ningún rol definido**: cada tenant inventaba el suyo, y la
webapp enseñaba los dos mundos enteros a todo el que entrara, con un toggle manual de
«módulos avanzados» como única cortina. El dueño lo señaló con dos ejemplos: *un cajero no
puede ver cuánto ganó el negocio en el día*, y *puede ver inventario pero no registrar si
llegó algo*. La investigación de comparables (Alegra, Siigo, ERPNext, Xero, QuickBooks)
converge en lo mismo: **4–6 roles con nombre de oficio, no matrices de checkboxes**, con el
POS-only y el contador externo como roles de fábrica.

## Decisión

1. **Cinco roles de sistema** (`tenant_id null`, migración 40): `owner` (Dueño, el catálogo
   entero leído de la tabla `permissions`), `cashier` (Cajero: vende, cobra, fía, anota al
   vecino — 5 permisos), `store_manager` (Encargado: + mercancía, alta de producto, compra
   directa, tasa del día y cierre de caja — 15), `back_office` (Administrador: la operación
   completa de los dos mundos, lee KPIs contables, NO asienta — 47), `accountant` (Contador:
   contabilidad, cierres, libros, clasificación tributaria, reglas de retención, lectura de
   CxC/CxP — 22).
2. **`requires_scope` decidido rol por rol**: cajero y contador planos; encargado,
   administrador y dueño ACOTADOS (llevan verbos de almacén; su asignación exige
   `scope_bindings` que digan en qué almacenes operan, y sin binding no conceden nada —
   fallo cerrado de ADR-0025 §4).
3. **`platform.ladino_user_permissions()`**: la misma resolución de
   `ladino_user_has_permission`, devuelta entera. `GET /v1/me/permissions` la expone y la
   webapp forma el menú UNA vez por sesión.
4. **Navegación por permiso**: cada entrada del sidebar declara qué permiso la abre (con
   listas any-of para las entradas que comparten administrador y contador). La paleta
   Cmd+K ofrece las mismas puertas. La URL directa a una entrada cerrada aterriza en la
   ruta inicial del rol (`rutaInicial`): dueño/administrador → Inicio; quien vende →
   Vender; contador → Contabilidad.
5. **Ver ≠ operar**: las lecturas de catálogo son de miembro (el cajero VE productos,
   existencias y movimientos); los botones de acción se esconden pantalla a pantalla tras
   su permiso (verbos de inventario, alta/Excel/foto de producto, pestaña de gastos,
   secciones de Mi dinero). **El dinero agregado nunca viene gratis con la membresía**:
   resumen (`treasury.read`), estado de cuenta (`ar.read`) y el diferencial cambiario
   (`treasury.read` o `accounting.read` — antes estaba sin candado y se cerró aquí).
6. **Quien cierra ve LA CAJA**: `listCompanyAccounts` con solo `cash.close` devuelve
   únicamente las cuentas de efectivo no de sistema — el encargado cuenta ese efectivo de
   todas formas; el banco y el Zelle no son suyos de ver.
7. **Esconder es cortesía**: la autorización real sigue siendo por operación en el
   servidor. La UI y el servidor no pueden divergir porque leen la MISMA resolución.

## Decisiones del dueño registradas

- El encargado registra la compra directa (mundo de arriba); las órdenes de compra del
  mundo técnico quedan del administrador.
- El cajero SÍ crea clientes (el alta rápida para fiar).
- El administrador NO ve el módulo de Contabilidad (ni en lectura): quien opera no asienta.
  Sí lee los KPIs (`accounting.read`) — el módulo se abre con `accounting.entry.create`.

## Consecuencias

- Asignar encargado/administrador/dueño exige crear sus `scope_bindings` (típicamente
  todos los almacenes de la empresa). La UI de usuarios y roles no existe todavía: la
  asignación es por API/SQL hasta que se construya (pendiente declarado).
- El pgTAP 040 exige que `owner` cubra el catálogo ENTERO: una migración futura que cree
  un permiso y no se lo conceda se pone en rojo — el gate compuesto responde cero.
- El toggle «mostrar módulos avanzados» sobrevive, pero filtra DESPUÉS del rol: activa
  módulos de la empresa, no abre puertas que el rol cierra.

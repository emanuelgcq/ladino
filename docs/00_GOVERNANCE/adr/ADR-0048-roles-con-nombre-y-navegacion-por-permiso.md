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

## Nota de la re-revisión (ola 3, 2026-10-03): el resumen y los totales de deuda

`treasury.read` sigue dando el resumen del negocio (`GET /v1/negocio/resumen`): eso no cambia. Pero
«puede ver el dinero» no es «puede ver lo que deben los clientes» (RESPUESTA §2.8; N-07, P-04:
ninguna pantalla revela lo que el rol no puede ver). Los dos totales de deuda exigen además el
permiso de su libro:

- `lo_que_me_deben` se calcula solo con `ar.read`;
- `lo_que_debo` se calcula solo con `ap.read`.

Sin el permiso la cifra **no se consulta** y viaja en `null`. `null` significa «no tienes acceso»,
nunca «0.00»; la web no pinta esa tarjeta. **Contrato:** los dos campos de
`NegocioResumenResponse` se amplían a nulo (antes siempre string). Los roles de fábrica con
`treasury.read` (Dueño, Administrativo) tienen los tres permisos y no notan cambio; el efecto es
sobre los roles a medida.

*Decidido por criterio* (§2.16). Alternativas descartadas: (a) 403 en todo el resumen sin
`ar.read` —el patrón de `with_debt=1`—, que dejaría sin Inicio ni «Mi dinero» a quien solo lleva
la caja; (c) declarar los totales de deuda incluidos en `treasury.read`, que contradice §2.8.

## Nota de la ola 4 (2026-10-03, A-04): la sonda del menú pregunta por datos, y por un rol

*ADR aplicado según la respuesta del dueño del 2026-09-28* («Contabilidad y Libros aparecen cuando
hay datos —primer asiento posteado o primer documento fiscal— o cuando el rol es contador. Se
arregla la sonda, no el texto»).

- La sonda de la divulgación progresiva (`apps/web/src/app/modulos-activos.ts`) ya no da
  Contabilidad por activa con el plan de cuentas, que toda empresa tiene desde el alta:
  Contabilidad aparece con el primer asiento **posteado** y Libros con la primera **factura**, o
  los dos si la persona es contadora. *Decidido por criterio*: cada módulo con su dato;
  alternativa descartada, que cualquiera de los dos datos encienda los dos.
- Es la única excepción a «el menú se forma con permisos»: el dueño tiene todos los permisos del
  contador, así que ningún permiso los distingue. `GET /v1/me/permissions` devuelve por eso
  `roles`, y la web lo usa SOLO para esta sonda. Autorizar sigue siendo cosa de `puede()` y del
  servidor; un rol a medida con permisos de contabilidad no es «contador» y ve los módulos cuando
  hay datos.
- La sonda es del MENÚ. Las pantallas que preguntan «¿hay contabilidad configurada que yo pueda
  leer?» (detalle del documento, tablero) usan `useContabilidadConfigurada`, no la sonda.
- La sonda se cachea cinco minutos; tras emitir una factura o un recibo, o postear un asiento, se
  vuelve a sondear si el hecho puede encender un módulo apagado (`debeResondear`).
- Deuda aceptada: los joins de `roles` en `apps/api/src/routes/companies.ts` son una segunda copia
  de los de `platform.ladino_user_permissions`; los vigila un E2E. La salida limpia, una
  `platform.ladino_user_roles`, queda anotada en R-76.

## Nota de la ola 4 (2026-10-04): el reparto de los cuatro permisos nuevos de ventas

La ola 4 creó cuatro permisos y los repartió entre los roles de sistema. Los cuatro repartos se
*decidieron por criterio* (RESPUESTA §2.16) leyendo §2.8, no por orden expresa del dueño: quedan
aquí juntos para que se puedan revisar de una vez. Lo que dice la base (`role_permissions`, roles
con `tenant_id is null`) es lo que vale; esta tabla la describe.

| Permiso | Qué gobierna | Roles de sistema | Criterio | Alternativa descartada |
|---|---|---|---|---|
| `sales.credit` | vender a crédito: fiar en la caja **y** facturar por administración (`POST /v1/invoices`), por una sola puerta (`exigirFiado`; R-82.1) | cajero, encargado, administrativo, dueño | «quien vende puede fiar; lo acota el límite» del cliente, que el cajero no puede fijar | solo cajero y dueño |
| `customers.credit.set` | fijar el límite de fiado de un cliente (`PUT /v1/customers/{id}/credit-limit`; deja acta) | administrativo, dueño | quien fía no se fija su propio tope | dárselo también al encargado |
| `sales.credit_note.direct` | la nota de crédito sin devolución de mercancía (`POST /v1/credit-notes`) | dueño, administrativo (y todo rol propio que tuviera `sales.return.manage`) | acreditar una factura sin que vuelva nada no es una devolución; el cajero inicia devoluciones con mercancía | dejarla bajo `sales.return.manage` |
| `sales.refund` | devolver dinero a un cliente (`refundCustomerCredit`) | dueño, administrativo | el cajero no saca dinero de la caja; §2.8 dice del administrativo que «anula y aprueba» | solo el dueño (ADR-0068 §8, su estado anterior) |

- Migraciones: `20261004140000` (`sales.credit`, `customers.credit.set`), `20261004160200`
  (`sales.refund` al administrativo), `20261004160300` (`sales.credit_note.direct`) y
  `20261004210100` (la descripción de `sales.credit`, que decía «Fiar en la caja» cuando ya
  gobernaba también la factura de administración). El detalle de cada uno está en ADR-0061 (nota
  de la ola 4), ADR-0068 §8 y R-82.
- **Consecuencia negativa aceptada:** un rol propio creado antes de la ola 4 no trae `sales.credit`
  ni `customers.credit.set`: sus personas dejan de poder fiar —y de facturar por administración,
  que nace a crédito— hasta que se les conceda (R-82.6). Y el cajero, con `sales.credit`, puede
  fiar hasta el límite de cada cliente sin que nadie apruebe la venta concreta.
- **Para revertir:** quitar o añadir filas de `role_permissions` con una migración nueva; ningún
  dato de negocio depende del reparto.
- **Verificación:** pgTAP 124 (reparto del fiado y del límite) y `e2e-fiar-con-permiso-y-limite`.

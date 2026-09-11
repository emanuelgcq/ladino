---
name: sidebar-arriba-consulta-abajo-administra
description: "Regla de producto del dueño — el grupo de arriba del sidebar solo vende/consulta; todo lo administrativo va en posición al grupo ADMINISTRACIÓN, no solo acotado por permiso"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e5ddae20-4236-42c7-a011-6eca2cb4c4e5
  modified: 2026-09-08T23:11:40.319Z
---

El dueño pidió tres veces (2026-09-04/05) que «Compras y gastos», «Mi dinero» y los
verbos de inventario («llegó mercancía», ajustes…) vivieran ABAJO, en ADMINISTRACIÓN.
Yo lo había resuelto solo con gates de permiso dejando las entradas arriba, y como el
dueño lo ve todo, para él no cambió nada.

**Why:** Su modelo mental es de POSICIÓN, no solo de visibilidad: arriba se vende y se
consulta (Inicio, Vender, Productos, Inventario-consulta, Clientes); abajo se
administra y se registra. Acotar por rol sin mover no cumple el acuerdo.

**How to apply:** Al añadir una superficie nueva, preguntarse «¿esto es del mostrador o
de la administración?» y colocarla en el grupo correspondiente de
apps/web/src/app/nav.ts, además de ponerle su `permiso`. Si un rol operativo (p. ej.
warehouse_ops) necesita una pantalla del grupo admin, se añade su permiso al gate de
esa entrada — el grupo ADMINISTRACIÓN se abre por cualquier ítem visible. Aplicado en
commit ef4e7fd.

Ampliación (2026-09-08, dicho con enojo — «¿no me estás entendiendo?»): la forma
FINAL de la regla es el modelo cajero/administrador. **ARRIBA ES SOLO LECTURA
para productos e inventario** («¿el operador de caja va a agregar inventario?
¡no!»); abajo se gestiona TODO. Excepciones explícitas del dueño: (1) la
OPERATIVIDAD de la venta — /vender entero, incluido crear cliente inline;
(2) /clientes arriba SÍ crea y edita datos de contacto («claro que un operador
de caja puede crear un cliente, es necesario para vender»); (3) Empezar conserva
alta/importación (asistente del primer día). Aplicado en d3aa36a (importar solo
abajo) y 447133a (/productos arriba sin agregar/editar/foto/barras; el catálogo
de Administración ganó la foto para paridad total).

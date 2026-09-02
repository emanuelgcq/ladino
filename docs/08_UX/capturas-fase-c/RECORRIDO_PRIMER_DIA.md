# El primer día con Ladino — recorrido de aceptación de la Fase C

Este documento es la prueba de aceptación de la fase, escrita como lo que es: el primer día
de una persona con su negocio. Cada flujo cuenta los clics de verdad, medidos sobre las
pantallas reales (las capturas de esta carpeta salen de un navegador de verdad contra la API
local, con la empresa de demostración).

**La vara de la fase: una venta de un producto pagada en efectivo, en 5 clics o menos.**
Resultado: **4 clics.** Detalle abajo.

---

## 1. La puesta a punto (`/empezar`, capturas 20–24)

María abre Ladino por primera vez. La app la recibe con cuatro pasos que se marcan solos
cuando el servidor confirma cada uno:

1. **Tus productos** — «¿Qué vendes?». Puede dar de alta un producto con foto y precio
   (1 clic al botón + el formulario de una pantalla), traerlos todos desde Excel, o
   **saltarse el paso**: también se puede vender describiendo la venta.
2. **Tu dinero** — «¿Dónde guardas tu dinero?». La caja del local, el banco, el Zelle.
   **Este paso no se puede saltar**: cada cobro cae en una cuenta. Crear la primera:
   «Agregar cuenta» → nombre → «Crear cuenta» (2 clics + un nombre).
3. **La tasa del día** — si hay una tasa de ayer, «Sigue igual» la confirma con **1 clic**.
   Si no hay ninguna, se escribe y se guarda.
4. **Tus facturas** — el paso delicado, y el único con letra seria:
   - **¿Vas a dar facturas?** Las opciones llegan del servidor **con su norma citada**
     (formatos libres: Providencia Administrativa SNAT/2011/00071, G.O. 39.795). Se elige
     una vez; cambiarla después es un acto del mundo de administración.
   - **El IVA que cobras.** Ladino **no fija el porcentaje**: lo escribe la persona y lo
     acepta con un botón que dice lo que hace («Acepto este porcentaje»). Queda registrado
     en la auditoría con su usuario y la fecha, y la regla creada lleva como fuente el acta
     de esa aceptación, marcada VALIDAR-TRIBUTARIO hasta que un humano la confirme contra
     la ley vigente. Ni la pantalla ni la base de datos inventan una gaceta.
   - **El talonario de la imprenta** (solo formatos libres): del número, al número, serie
     e imprenta — los datos que ya vienen impresos en el papel.

Con los cuatro en verde: «¡Listo! Tu negocio ya puede vender» → **Ir a vender**.

## 2. La primera venta (`/vender`, capturas 3–5) — **4 clics**

| # | Clic | Qué pasa |
| --- | ------------------------------ | ----------------------------------------------------------------- |
| 1 | La foto del producto | Entra al carrito. El total lo cotiza el **servidor** en cada cambio |
| 2 | **COBRAR** | Se abre el cobro con el total en Bs y su equivalente |
| 3 | **Efectivo (Bs)** | La forma de pago; el monto ya viene puesto con el total |
| 4 | **Confirmar** | Factura emitida + cobro registrado. Pantalla de éxito con PDF y WhatsApp |

Con vuelto: se teclea cuánto entregó el cliente y **el vuelto lo calcula el servidor** —
la pantalla no suma ni un céntimo. Cliente por omisión: Consumidor final; buscar con la
lupa o el lector de código de barras (Enter agrega directo).

## 3. Entró mercancía (`/inventario`, capturas 9–11) — 4 clics + cantidad

«Entró mercancía» → producto → cantidad (y costo si se conoce) → «Registrar». Si además fue
una compra, el mismo formulario ofrece «Registrar también como compra». Los movimientos se
leen en la lengua del mostrador: «Entraron 10 · Harina PAN · hoy».

## 4. Un cliente pagó lo que debía (`/clientes`, capturas 12–14) — 4 clics + monto

La lista dice quién debe y cuánto («me debe Bs. 12.841,20»). Ficha → «Registrar cobro» →
forma de pago → monto (parcial vale) → confirmar. El estado de cuenta sale por WhatsApp con
un clic.

## 5. Pagó el alquiler (`/compras`, capturas 15–17) — 4 clics + monto

«Registrar gasto» → chip **Alquiler** → de qué cuenta salió → cuánto → «Registrar gasto».
Detrás, sin que María lo vea: asiento de partida doble, saldo de la cuenta al día y el
gasto en su categoría para «Lo que gané».

## 6. El cierre del día (`/dinero`, capturas 18–19)

«Cerrar la caja»: Ladino dice cuánto **debería** haber según lo registrado; María cuenta y
escribe cuánto **hay**. Si no cuadra, la diferencia queda escrita con su motivo — no se
esconde ni se ajusta sola. La tasa de mañana: un clic en «Sigue igual».

## 7. El día en una mirada (`/inicio`, capturas 1–2)

Lo vendido hoy o este mes (el número grande), lo que ganó (con la advertencia honesta si
hay ventas sin costo cargado), lo que le deben, su dinero por moneda, lo que está por
agotarse, y recordatorios que se calculan al entrar. **Cada cifra viene del servidor**: la
pantalla viste, no suma.

---

## Las tres promesas de la fase, verificadas

- **≤ 5 clics la venta simple**: 4. ✔
- **Cero jerga**: el glosario es un **gate dentro de `pnpm verify`** que recorre el fuente
  de `pages/negocio/**` y se pone rojo con SKU, kardex, asiento, CxC, régimen, Bs.S…
  Durante la fase cazó cuatro violaciones reales; ninguna se indultó. ✔
- **Cero códigos de error en pantalla**: todo error de la API viaja con `person_message` y
  las pantallas de negocio enseñan solo esa voz. ✔

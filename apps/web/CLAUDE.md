# apps/web

Webapp de Ladino. Vite + React + React Router (data mode) + TanStack Query.
Es la experiencia principal para administración, contabilidad y configuración.

## Reglas

- **Cero lógica tributaria o contable.** Ni una alícuota, ni un redondeo fiscal, ni un asiento.
  Todo cálculo con valor legal viene del servidor.
- Montos: llegan como `string`, se formatean con el helper de `packages/money`.
  Prohibida la aritmética monetaria en el cliente, incluso para "previsualizar un total".

  **Una excepción, y solo una: el formulario de asiento manual** (`AccountingView.tsx`) compara
  débitos contra créditos mientras se teclea, para deshabilitar el botón hasta que cuadre.
  Se admite porque cumple las tres condiciones que la hacen inofensiva: **no persiste nada**,
  **no decide nada** —el servidor lo repite con un trigger de Postgres y rechaza igual— y
  **compara enteros de céntimos**, no importes. Si alguna de las tres deja de ser cierta, la
  excepción deja de valer. Ninguna otra pantalla suma dinero: los totales del balance, del mayor
  y de los estados financieros los calcula el esquema en `numeric`.
- Nunca `service_role`. Solo la anon key y el token del usuario.
- Estado de servidor con TanStack Query. Nada de duplicar la caché en un store global.
- Accesibilidad objetivo WCAG 2.2 AA: foco visible, labels reales, navegación por teclado en
  tablas y en el POS.

## UX no negociable

- `Guardar borrador` y `Emitir` son botones **distintos**, con peso visual distinto.
- Toda acción irreversible (emitir, cobrar, anular, cerrar periodo) pasa por una pantalla de
  confirmación que resume las consecuencias en lenguaje llano.
- Las pantallas de documento muestran timeline 360°: quién, cuándo, qué cambió, versión de reglas.
- Errores del servidor se muestran con el mensaje de dominio, no con un "algo salió mal".

## Rendimiento

Tablas de ERP son grandes. Paginación en servidor, virtualización en cliente, filtros
en el query string para que una vista sea compartible.

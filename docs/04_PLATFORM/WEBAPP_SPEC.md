# Webapp — Ladino

Experiencia principal para administración, contabilidad y configuración.

## Stack (ADR-0011)

Vite + React + TypeScript `strict` + React Router (data mode) + TanStack Query.
Build estático servido por el Traefik existente. **Sin SSR**: Ladino es una aplicación 100%
autenticada, sin SEO ni páginas públicas. La landing comercial es un proyecto aparte.

El dominio no se acopla al framework. Si algún día hiciera falta SSR, migra la capa de rutas
y nada más.

## Reglas

- **Cero lógica tributaria o contable.** Ni una alícuota, ni un redondeo fiscal, ni un asiento.
  Todo cálculo con valor legal viene del servidor, incluso para "previsualizar un total".
- Montos: llegan como `string`, se formatean con el helper de `packages/money`.
  Prohibida la aritmética monetaria en el cliente.
- Nunca `service_role`. Solo anon key y token del usuario.
- La UI no es control de acceso: oculta lo que el usuario no puede hacer, y el servidor
  vuelve a verificar siempre.

## Layout

Selector tenant/empresa/sucursal siempre visible · command palette · navegación por dominios ·
breadcrumbs · bandeja de tareas pendientes · búsqueda global.

## Pantallas críticas

POS · documento 360° con timeline · kardex · estado de cuenta · conciliación · asiento ·
cierre · libro fiscal · auditoría · configurador fiscal.

## UX fiscal — no negociable

- `Guardar borrador` y `Emitir` son botones **distintos**, con peso visual distinto.
- Toda acción irreversible (emitir, cobrar, anular, cerrar periodo) pasa por confirmación que
  resume las consecuencias en lenguaje llano, no un "¿está seguro?".
- El documento muestra timeline: quién, cuándo, qué cambió, con qué versión de reglas.
- Los errores muestran el mensaje de dominio, no "algo salió mal".

## Rendimiento

Las tablas de un ERP son grandes. Paginación en servidor, virtualización en cliente, filtros
en el query string para que cualquier vista sea compartible y enlazable.
Code splitting por dominio; prefetch de rutas al hover del menú.

## Accesibilidad

Objetivo WCAG 2.2 AA: foco visible, labels reales, navegación completa por teclado en tablas
y en el POS. Un cajero con el teclado es más rápido que con el ratón; la accesibilidad aquí
también es velocidad de operación.

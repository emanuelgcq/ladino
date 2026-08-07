# ADR-0011 — Webapp con Vite + React + React Router (data mode)

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** NO

## Contexto
`WEBAPP_SPEC.md` dejaba abierta la elección entre Next.js y Vite. Ladino es una aplicación
100% autenticada: sin SEO, sin páginas públicas, sin necesidad de SSR. La landing comercial
es un proyecto separado.

## Opciones
1. **Next.js** — SSR y RSC que aquí no se usan; añade un runtime de servidor que hay que
   desplegar, observar y versionar sin obtener nada a cambio.
2. **Vite SPA** — build estático servido por Traefik, arranque de desarrollo instantáneo,
   despliegue trivial.

## Decisión
Vite + React + React Router en data mode + TanStack Query. Build estático tras Traefik.
El dominio no se acopla al framework: si algún día hace falta SSR, migra la capa de rutas y nada más.

## Consecuencias
- (+) Una pieza menos que desplegar y homologar en el VPS.
- (+) Alineado con el stack que el equipo ya opera en otros productos.
- (−) Sin SSR: el primer render depende del bundle. Se mitiga con code splitting por dominio
  y prefetch de rutas en el hover del menú.

## Verificación
`pnpm build` produce estáticos servibles sin proceso Node en runtime.

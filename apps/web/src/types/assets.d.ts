/**
 * Con moduleResolution NodeNext, TypeScript no sabe qué es importar un .css:
 * lo resuelve Vite. Esta declaración lo dice una sola vez para todo el bundle
 * (theme.css propio y los CSS de @fontsource-variable).
 */
declare module "*.css";

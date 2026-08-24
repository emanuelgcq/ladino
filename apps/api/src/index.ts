/**
 * @ladino/api — API REST de Ladino (Hono sobre Node 22).
 *
 * La composición y el ORDEN de los middlewares están en app.ts, y el orden es
 * contrato. El arranque del servidor llega con S0.6 (contenedores); hasta
 * entonces la app se construye y se prueba con `app.request()`.
 */
export { buildApp, type AppConfig } from "./app.js";
export const PACKAGE_NAME = "@ladino/api" as const;

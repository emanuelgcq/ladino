/**
 * @ladino/domain — Casos de uso administrativos transaccionales.
 *
 * Cada caso de uso recibe la transacción YA ABIERTA (UnitOfWork de @ladino/db,
 * que fijó el GUC de procedencia) y devuelve Result. No abre transacciones, no
 * commitea, no conoce HTTP. El patrón de diez pasos, con su plantilla de
 * referencia, está en create-company.ts.
 */
export { createCompany, RULES_VERSION, type CreateCompanyError } from "./create-company.js";

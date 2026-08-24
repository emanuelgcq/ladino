/**
 * @ladino/fiscal — Documentos, numeracion, imprenta. Release train propio.
 *
 * Placeholder de Sprint 0 (S0.1). Sin framework y sin lógica: el esqueleto debe compilar
 * antes de que exista una sola regla de negocio. Ver docs/00_GOVERNANCE/SPRINT_0_BOOTSTRAP.md.
 */
export const PACKAGE_NAME = "@ladino/fiscal" as const;

export { NullTransmitter, type SeniatTransmitter, type EventoOutbox } from "./transmitter.js";

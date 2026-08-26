import { err, ok, type Result } from "@ladino/core";
import type { TransactionSql } from "@ladino/db";

/**
 * Autorización COMPANY-SCOPED, una sola copia para todos los maestros
 * (ADR-0027 §3-bis): visibilidad por `ladino_user_company_ids()` y permiso por
 * la función canónica `ladino_user_has_permission()` — aquí SÍ se puede usar,
 * a diferencia del JOIN de create-company (aquel era tenant-level y no tenía
 * company contra la que preguntar).
 *
 * El orden es la regla 404/403 de ERROR_CATALOG.md: PRIMERO invisible (404,
 * idéntico exista o no la company), DESPUÉS sin permiso (403: la existencia
 * ya la conocía por la visibilidad).
 */
export type CompanyScopeError =
  | { code: "NOT_FOUND"; message: string }
  | { code: "PERMISSION_REQUIRED"; message: string }
  | { code: "COMPANY_SUSPENDED"; message: string };

export interface CompanyScope {
  readonly tenantId: string;
  readonly companyStatus: "onboarding" | "active" | "suspended";
}

export async function companyScope(
  sql: TransactionSql,
  userId: string,
  companyId: string,
  permission: string,
): Promise<Result<CompanyScope, CompanyScopeError>> {
  const [co] = await sql<{ tenant_id: string; status: CompanyScope["companyStatus"] }[]>`
    select c.tenant_id, c.status
      from public.companies c
     where c.id = ${companyId}
       and c.id in (select platform.ladino_user_company_ids(${userId}))`;
  if (!co) {
    // El mismo cuerpo que el middleware de scope y que el 23503: los 404
    // indistinguibles, también aquí.
    return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  }

  const [permiso] = await sql<{ autorizado: boolean }[]>`
    select platform.ladino_user_has_permission(${userId}, ${permission}, ${companyId}) as autorizado`;
  if (!permiso?.autorizado) {
    return err({
      code: "PERMISSION_REQUIRED",
      message: `La operación exige el permiso ${permission} sobre esta empresa.`,
    });
  }

  // Empresa suspendida: se LEE, no se escribe. La decisión de bloquear la toma
  // cada caso de uso mutante — un GET no tiene por qué morir aquí.
  return ok({ tenantId: co.tenant_id, companyStatus: co.status });
}

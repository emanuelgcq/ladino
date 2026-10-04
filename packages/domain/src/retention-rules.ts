import type { TransactionSql } from "@ladino/db";
import type { CreateRetentionRuleRequest } from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";

/**
 * CARGAR UNA REGLA DE RETENCIÓN, CON SU ACTA (RESPUESTA §2.15: «deja acta todo cambio de regla
 * fiscal»; misma familia que B-05 y G-13).
 *
 * Es el acto por el que una empresa PUEDE retener: el catálogo nace vacío a propósito (ADR-0039)
 * y esto es lo que lo llena, con la norma citada. Hasta la ola 4 el `insert` vivía en el handler
 * de la API y no dejaba `audit_event`: quedaba la fila, con su `created_by`, y ningún rastro de
 * qué se cargó ni con qué fuente. El permiso lo comprueba quien llama, como en el talonario.
 *
 * Una regla cargada es DE ESTA EMPRESA (ADR-0057): retiene aquí, no en toda la instancia. Y como
 * es una regla, cambia la versión de reglas de la empresa (ADR-0079): el acta ya lleva la nueva.
 */
export type ReglaDeRetencion = Record<string, unknown> & { readonly id: string };

export async function cargarReglaDeRetencion(
  sql: TransactionSql,
  companyId: string,
  d: CreateRetentionRuleRequest,
): Promise<ReglaDeRetencion> {
  const [r] = await sql<(ReglaDeRetencion & { tenant_id: string })[]>`
    insert into public.retention_rules
      (tenant_id, company_id, jurisdiction, retention_code, concept_code, taxpayer_type,
       supplier_person_type, formula_kind, rate, subtrahend, minimum_exempt, effective_from,
       effective_to, legal_source, priority)
    values ((select tenant_id from public.companies where id = ${companyId}), ${companyId},
            ${d.jurisdiction}, ${d.retention_code}, ${d.concept_code},
            ${d.taxpayer_type ?? null}, ${d.supplier_person_type ?? null}, ${d.formula_kind},
            ${d.rate}, ${d.subtrahend ?? null}, ${d.minimum_exempt ?? null},
            ${d.effective_from}::date, ${d.effective_to ?? null}, ${d.legal_source},
            ${d.priority ?? 100})
    returning tenant_id, id, jurisdiction, retention_code, concept_code, formula_kind,
              rate::text as rate, subtrahend::text as subtrahend,
              minimum_exempt::text as minimum_exempt, effective_from::text as effective_from,
              legal_source, priority, status`;
  const { tenant_id: tenantId, ...regla } = r!;
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${companyId}, 'retention_rule', ${regla.id}, 'retention.rule.created',
            'user', now(), ${RULES_VERSION},
            ${sql.json({
              jurisdiction: d.jurisdiction,
              retention_code: d.retention_code,
              concept_code: d.concept_code,
              taxpayer_type: d.taxpayer_type ?? null,
              supplier_person_type: d.supplier_person_type ?? null,
              formula_kind: d.formula_kind,
              rate: d.rate,
              subtrahend: d.subtrahend ?? null,
              minimum_exempt: d.minimum_exempt ?? null,
              effective_from: d.effective_from,
              effective_to: d.effective_to ?? null,
              legal_source: d.legal_source,
              priority: d.priority ?? 100,
            })})`;
  return regla;
}

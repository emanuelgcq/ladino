import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork } from "@ladino/db";
import type { OnboardBusinessRequest, OnboardBusinessResponse } from "@ladino/schemas";
import { createCompany, RULES_VERSION } from "./create-company.js";
import { importChartTemplate, importJournalTemplates } from "./accounting.js";

/**
 * EL PRIMER DÍA REAL (ADR-0049): un usuario recién registrado funda su
 * negocio en UN acto — tenant, membresía, sus dos roles (dueño plano +
 * operación de almacén), la empresa, el primer depósito con su binding, y el
 * plan contable con sus plantillas de asiento. Antes de esto, el arranque
 * solo existía en el SQL de la demo: la auditoría de superficie lo destapó.
 *
 * Todo en UNA transacción: si la importación del plan falla, no queda un
 * tenant fantasma a medio fundar. La idempotencia viene del middleware.
 */
export interface OnboardingError {
  readonly code: string;
  readonly message: string;
}

export async function onboardBusiness(
  uow: UnitOfWork,
  input: OnboardBusinessRequest,
): Promise<Result<OnboardBusinessResponse, OnboardingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Fundar un negocio exige un usuario real.",
    });
  }

  // ── 1. El tenant, la membresía y el par de roles del fundador ─────────────
  // SAVEPOINT porque LAD80/LAD81 son errores ESPERABLES de Postgres y un error
  // crudo condena la transacción (la lección de S0.5, otra vez).
  let tenantId: string;
  try {
    tenantId = await sql.savepoint(async (sp) => {
      const [r] = await sp<{ id: string }[]>`
        select platform.bootstrap_tenant(${actor.userId}, ${input.business_name}) as id`;
      return r!.id;
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "LAD81") {
      return err({
        code: "DUPLICATE",
        message:
          "Ya perteneces a un negocio. La segunda empresa se crea dentro del mismo, y unirse a otro es por invitación de su dueño.",
      });
    }
    if (code === "LAD80") {
      return err({ code: "VALIDATION_FAILED", message: "El negocio necesita un nombre." });
    }
    throw e;
  }

  // El GUC de actor ya lo fijó withTransaction; la membresía recién creada es
  // la que autoriza todo lo que sigue — el mismo mecanismo que autorizará
  // mañana, no un bypass.
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  // ── 2. La empresa ─────────────────────────────────────────────────────────
  // Sin RIF todavía (el modo recibos existe para eso): placeholder DERIVADO
  // del tenant — determinista, único, y honesto en su prefijo. /empezar
  // recoge el RIF real cuando exista (PA SNAT/2026/00080: hoy es digital).
  const taxId =
    input.tax_id !== undefined && input.tax_id !== null && input.tax_id.trim() !== ""
      ? input.tax_id.trim()
      : `PEND-${tenantId.replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  const empresa = await createCompany(uow, {
    tenant_id: tenantId,
    legal_name: input.business_name,
    tax_id: taxId,
  });
  if (!empresa.ok) return empresa;
  const companyId = empresa.value.id;

  // ── 3. El primer depósito, y el binding que enciende los verbos ───────────
  const [almacen] = await sql<{ id: string }[]>`
    insert into public.warehouses (tenant_id, company_id, code, name)
    values (${tenantId}, ${companyId}, 'W1', 'Principal')
    returning id`;
  await sql`
    insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id)
    select ura.tenant_id, ${companyId}, ura.id, 'warehouse', ${almacen!.id}
      from public.user_role_assignments ura
      join public.memberships m on m.id = ura.membership_id
      join public.roles r on r.id = ura.role_id
     where m.user_id = ${actor.userId} and m.tenant_id = ${tenantId}
       and r.tenant_id is null and r.key = 'warehouse_ops'`;

  // ── 4. Plan contable y plantillas de asiento ──────────────────────────────
  // Las DOS importaciones, no una: el plan sin el preset deja toda venta en
  // la cola contable para siempre — exactamente el hueco que la auditoría
  // encontró en Contabilidad.
  const plan = await importChartTemplate(uow, {
    company_id: companyId,
    template_code: "ve_basico",
  });
  if (!plan.ok) return plan;
  const preset = await importJournalTemplates(uow, {
    company_id: companyId,
    preset_code: "ve_basico",
  });
  if (!preset.ok) return preset;

  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${companyId}, 'company', ${companyId}, 'onboarding.completed',
            'user', now(), ${RULES_VERSION},
            ${sql.json({ warehouse_id: almacen!.id, chart: "ve_basico", preset: "ve_basico" })})`;

  return ok({ tenant_id: tenantId, company_id: companyId, warehouse_id: almacen!.id });
}

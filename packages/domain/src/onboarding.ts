import { err, ok, type Result } from "@ladino/core";
import { diaNegocio } from "./dia-negocio.js";
import type { UnitOfWork } from "@ladino/db";
import type { OnboardBusinessRequest, OnboardBusinessResponse } from "@ladino/schemas";
import { createCompany, RULES_VERSION } from "./create-company.js";
import { validarRif } from "./documento-identidad.js";
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

  // ADR-0069 §3 (K-05): el inicio de actividades no puede ser futuro. Se valida ANTES de
  // escribir nada, para no escribir de balde (withTransaction revierte igual ante un err). Comparación de fechas ISO
  // (date contra date, el día de hoy EN CARACAS).
  if (
    input.activity_start_date !== undefined &&
    input.activity_start_date > diaNegocio(new Date())
  ) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La fecha de inicio de actividades no puede ser futura.",
    });
  }

  // ── 2. La empresa ─────────────────────────────────────────────────────────
  // Sin RIF todavía (el modo recibos existe para eso): placeholder DERIVADO
  // del tenant — determinista, único, y honesto en su prefijo. /empezar
  // recoge el RIF real cuando exista (PA SNAT/2026/00080: hoy es digital).
  const conRif = input.tax_id !== undefined && input.tax_id !== null && input.tax_id.trim() !== "";
  // Con RIF, un RIF de verdad: el marcador PEND- lo pone el sistema, nunca quien se registra
  // (A-17). La estructura y la normalización las hace createCompany (A-08, P-02).
  if (conRif) {
    const leido = validarRif(input.tax_id!);
    if (!leido.ok) return leido;
  }
  const taxId = conRif
    ? input.tax_id!.trim()
    : `PEND-${tenantId.replace(/-/g, "").slice(0, 10).toUpperCase()}`;

  // LA REGLA DURA (migración 43, impuesta aquí a propósito): con RIF real, la
  // razón social y el domicilio fiscal son obligatorios — son lo que la
  // factura imprime (PA 00071 art. 13.5). Sin RIF, nada de esto aplica.
  if (conRif && (input.legal_name === undefined || input.fiscal_address === undefined)) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Con RIF, la razón social y la dirección fiscal son obligatorias: son las que salen en tus facturas.",
    });
  }
  // ADR-0072 §1. Antes de escribir nada: un err tras escribir se commitearía igual.
  if (!conRif && input.taxpayer !== undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Un negocio sin RIF no es contribuyente del IVA: no declara tipo de contribuyente.",
    });
  }

  const empresa = await createCompany(
    uow,
    {
      tenant_id: tenantId,
      // Con RIF: la razón social LEGAL es legal_name y el nombre comercial va a
      // trade_name. Sin RIF: el nombre del negocio ocupa ambos papeles.
      legal_name: conRif ? input.legal_name! : input.business_name,
      trade_name: input.business_name,
      tax_id: taxId,
      ...(input.fiscal_address === undefined ? {} : { fiscal_address: input.fiscal_address }),
      ...(input.business_type === undefined ? {} : { business_type: input.business_type }),
      ...(input.phone === undefined ? {} : { phone: input.phone }),
      ...(input.whatsapp === undefined ? {} : { whatsapp: input.whatsapp }),
      ...(input.city === undefined ? {} : { city: input.city }),
      ...(input.state === undefined ? {} : { state: input.state }),
    },
    conRif ? {} : { sinRif: true },
  );
  if (!empresa.ok) return empresa;
  const companyId = empresa.value.id;
  // Sin fecha, la columna toma su omisión: el día del alta en Caracas (migración 20260928130000).
  if (input.activity_start_date !== undefined) {
    await sql`
      update public.companies set activity_start_date = ${input.activity_start_date}::date
       where id = ${companyId}`;
  }

  // ── 2-quater. EL TIPO DE CONTRIBUYENTE, SI EL REGISTRO LO DECLARÓ (ADR-0072 §1, A-03) ──
  // Primera vigencia de la historia append-only, con acta del registro. El especial rige desde la
  // notificación; los demás, desde el inicio de actividades. Sin RIF no se declara: la empresa es
  // no_contribuyente por hecho (platform.taxpayer_type_at).
  if (input.taxpayer !== undefined) {
    const t = input.taxpayer;
    await sql`
      insert into public.company_taxpayer_types
        (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason,
         rules_version, actor_id)
      select ${tenantId}, ${companyId}, ${t.taxpayer_type_code},
             coalesce(${t.effective_from ?? t.notified_on ?? null}::date, c.activity_start_date,
                      platform.caracas_day(now())),
             ${t.notified_on ?? null}::date, 'Declarado por el dueño en el registro',
             ${RULES_VERSION}, ${actor.userId}
        from public.companies c where c.id = ${companyId}`;
  }

  // ── 2-ter. SIN RIF, LA EMPRESA NACE VENDIENDO CON RECIBOS ─────────────────
  // (plan «Ladino sin RIF», A2). Antes nacía SIN régimen y la caja respondía 409
  // hasta que alguien pasara por /empezar a declarar lo que el registro ya había
  // preguntado. La declaración del registro es la misma que la de /empezar, y
  // deja su ACTA (R-27): si el negocio SÍ tenía RIF y dijo que no, lo firmó el
  // dueño con su usuario y su fecha, y el camino a facturar sigue abierto en
  // /empezar (la única transición de régimen que existe es salir de recibos).
  if (!conRif) {
    await sql`
      insert into public.company_fiscal_regimes (tenant_id, company_id, regime_code, effective_from)
      values (${tenantId}, ${companyId}, 'sin_facturacion', now())`;
    await sql`
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      values (${tenantId}, ${companyId}, 'company', ${companyId}, 'fiscal.regime.assigned',
              'user', now(), ${RULES_VERSION},
              ${sql.json({
                to: "sin_facturacion",
                origin: "onboarding",
                declaration: "El dueño declaró en el registro que el negocio no tiene RIF.",
              })})`;
  }

  // ── 2-bis. «Ahora tú»: la ficha del responsable (users_profile) ───────────
  if (input.owner_full_name !== undefined) {
    await sql`
      insert into public.users_profile (user_id, full_name, national_id)
      values (${actor.userId}, ${input.owner_full_name}, ${input.owner_national_id ?? null})
      on conflict (user_id) do update
        set full_name = excluded.full_name,
            national_id = excluded.national_id`;
  }

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

  // El registro terminó: la empresa ya opera. Antes quedaba en «onboarding» para siempre,
  // vendiera o no (QA de pantalla 2026-09-15, h. 82). Crear una empresa por la API
  // administrativa sigue naciendo en «onboarding»: ahí nadie completó el registro.
  await sql`update public.companies set status = 'active' where id = ${companyId} and status = 'onboarding'`;

  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${companyId}, 'company', ${companyId}, 'onboarding.completed',
            'user', now(), ${RULES_VERSION},
            ${sql.json({ warehouse_id: almacen!.id, chart: "ve_basico", preset: "ve_basico" })})`;

  return ok({ tenant_id: tenantId, company_id: companyId, warehouse_id: almacen!.id });
}

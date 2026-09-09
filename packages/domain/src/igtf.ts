import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql } from "@ladino/db";
import type {
  EnableIgtfRequest,
  SetIgtfInstrumentRequest,
  SetCompanyTaxpayerTypeRequest,
  IgtfStatusResponse,
  IgtfInstrumentResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";

/**
 * IGTF — activación y configuración por empresa (migración 46).
 *
 * La PERCEPCIÓN vive en registerPayment (por pago, calculada en el servidor);
 * aquí vive lo que la gobierna: el acta de activación (solo SPE), qué
 * instrumento causa (DATO editable), y la clasificación fiscal de la empresa
 * (H-6). Todo con permiso de settings: es configuración, no un hecho fiscal.
 */
export type IgtfError = CompanyScopeError | { code: "VALIDATION_FAILED"; message: string };

/** El default conservador que se siembra al ACTIVAR (H-8): las divisas
 *  obvias causan; el resto no, y `otro` tampoco — puede ser un pago en
 *  bolívares con otro nombre, y percibir de más ahí sería cobrarle al
 *  cliente un impuesto que no causó. */
const DEFAULT_CAUSA: ReadonlyArray<readonly [string, boolean]> = [
  ["efectivo_bs", false],
  ["efectivo_usd", true],
  ["zelle", true],
  ["usdt", true],
  ["transferencia", false],
  ["punto_venta", false],
  ["pago_movil", false],
  ["tarjeta", false],
  ["cashea", false],
  ["otro", false],
];

async function auditarConfig(
  sql: TransactionSql,
  tenantId: string,
  companyId: string,
  evento: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${companyId}, 'company', ${companyId}, ${evento},
            'user', now(), ${RULES_VERSION}, ${sql.json(payload as never)})`;
}

/** El estado, para la pantalla y para los casos de uso de este fichero. */
export async function readIgtfStatus(
  sql: TransactionSql,
  companyId: string,
): Promise<IgtfStatusResponse> {
  const [empresa] = await sql<{ enabled_at: string | null }[]>`
    select to_char(igtf_enabled_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             as enabled_at
      from public.companies where id = ${companyId}`;
  const [regla] = await sql<{ rate: string; legal_source: string }[]>`
    select rate::text as rate, legal_source from public.igtf_rules
     where effective_from <= current_date
     order by effective_from desc limit 1`;
  const instrumentos = await sql<IgtfInstrumentResponse[]>`
    select instrument, causes from public.igtf_company_instruments
     where company_id = ${companyId} order by instrument`;
  return {
    enabled: empresa?.enabled_at != null,
    enabled_at: empresa?.enabled_at ?? null,
    rate: regla?.rate ?? null,
    legal_source: regla?.legal_source ?? null,
    instruments: instrumentos,
  };
}

/**
 * Activa la percepción. Solo una empresa clasificada `especial` puede ser
 * agente de percepción (PA SNAT/2022/000013), y la activación exige el acta:
 * quién y por qué queda en la auditoría con la designación citada.
 */
export async function enableIgtf(
  uow: UnitOfWork,
  input: EnableIgtfRequest,
): Promise<Result<IgtfStatusResponse, IgtfError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Activar el IGTF exige un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "company.settings.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }

  const [empresa] = await sql<{ taxpayer_type_code: string | null; enabled: boolean }[]>`
    select taxpayer_type_code, igtf_enabled_at is not null as enabled
      from public.companies where id = ${input.company_id}`;
  if (empresa?.taxpayer_type_code !== "especial") {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Solo un sujeto pasivo ESPECIAL percibe IGTF. Corrige primero la clasificación de la " +
        "empresa si el SENIAT la designó.",
    });
  }
  if (empresa.enabled) {
    return err({ code: "VALIDATION_FAILED", message: "La percepción de IGTF ya está activa." });
  }

  await sql`update public.companies set igtf_enabled_at = now()
             where id = ${input.company_id}`;
  // La siembra NO pisa una configuración previa: si el dueño ya editó qué
  // causa (activó, desactivó, volvió a activar), sus decisiones quedan.
  for (const [instrumento, causa] of DEFAULT_CAUSA) {
    await sql`
      insert into public.igtf_company_instruments (tenant_id, company_id, instrument, causes)
      values (${scope.value.tenantId}, ${input.company_id}, ${instrumento}, ${causa})
      on conflict (company_id, instrument) do nothing`;
  }
  await auditarConfig(sql, scope.value.tenantId, input.company_id, "igtf.enabled", {
    reason: input.reason,
    legal_source: "PA SNAT/2022/000013 (G.O. 42.339): SPE como agentes de percepción del IGTF.",
  });
  return ok(await readIgtfStatus(sql, input.company_id));
}

/** Edita qué instrumento causa. Es DATO, con permiso de settings (H-8). */
export async function setIgtfInstrument(
  uow: UnitOfWork,
  input: SetIgtfInstrumentRequest,
): Promise<Result<IgtfInstrumentResponse, IgtfError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Configurar el IGTF exige un usuario real.",
    });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "company.settings.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const [fila] = await sql<IgtfInstrumentResponse[]>`
    insert into public.igtf_company_instruments (tenant_id, company_id, instrument, causes)
    values (${scope.value.tenantId}, ${input.company_id}, ${input.instrument}, ${input.causes})
    on conflict (company_id, instrument) do update set causes = ${input.causes}
    returning instrument, causes`;
  await auditarConfig(sql, scope.value.tenantId, input.company_id, "igtf.instrument_set", {
    instrument: input.instrument,
    causes: input.causes,
  });
  return ok(fila!);
}

/**
 * La clasificación fiscal de LA EMPRESA (cierra H-6: la semilla de producción
 * la puso por SQL porque este endpoint no existía). Con auditoría del valor
 * anterior, como el RIF. Si deja de ser `especial` con el IGTF activo, la
 * percepción SE APAGA en el mismo acto: un no-SPE no es agente de percepción,
 * y seguir percibiendo sería cobrar un impuesto sin designación.
 */
export async function setCompanyTaxpayerType(
  uow: UnitOfWork,
  input: SetCompanyTaxpayerTypeRequest,
): Promise<Result<{ taxpayer_type_code: string; igtf_disabled: boolean }, IgtfError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Cambiar la clasificación fiscal exige un usuario real.",
    });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "company.settings.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const [antes] = await sql<{ taxpayer_type_code: string | null; enabled: boolean }[]>`
    select taxpayer_type_code, igtf_enabled_at is not null as enabled
      from public.companies where id = ${input.company_id}`;
  const apagaIgtf = antes?.enabled === true && input.taxpayer_type_code !== "especial";
  await sql`
    update public.companies
       set taxpayer_type_code = ${input.taxpayer_type_code}
           ${apagaIgtf ? sql`, igtf_enabled_at = null` : sql``}
     where id = ${input.company_id}`;
  await auditarConfig(sql, scope.value.tenantId, input.company_id, "company.taxpayer_type.set", {
    previous: antes?.taxpayer_type_code ?? null,
    new: input.taxpayer_type_code,
    igtf_disabled: apagaIgtf,
  });
  return ok({ taxpayer_type_code: input.taxpayer_type_code, igtf_disabled: apagaIgtf });
}

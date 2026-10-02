import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql } from "@ladino/db";
import type {
  EnableIgtfRequest,
  SetIgtfInstrumentRequest,
  SetCompanyTaxpayerTypeRequest,
  SetCompanyTaxpayerTypeResponse,
  IgtfStatusResponse,
  IgtfInstrumentResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import { exigeEmpresaQueFactura } from "./modo-venta.js";
import { emitidosDesde, tipoVigente } from "./tipo-contribuyente.js";

/**
 * IGTF — activación y configuración por empresa (migración 46).
 *
 * La PERCEPCIÓN vive en registerPayment (por pago, calculada en el servidor);
 * aquí vive lo que la gobierna: el acta de activación (solo SPE), qué
 * instrumento causa (DATO editable), y la clasificación fiscal de la empresa
 * (H-6). Todo con permiso de settings: es configuración, no un hecho fiscal.
 */
export type IgtfError =
  | CompanyScopeError
  | { code: "VALIDATION_FAILED"; message: string }
  | { code: "REGIME_KIND_NOT_ALLOWED"; message: string };

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
  // E-02: percibe quien ES especial hoy (ADR-0072 §1-2), sin interruptor. L-15: la quincena en
  // curso la calcula el servidor con el día de Caracas — 1–15 y 16–último del mes calendario.
  const [empresa] = await sql<
    {
      enabled_at: string | null;
      perceiving: boolean;
      absorbs: boolean;
      fortnight_from: string;
      fortnight_to: string;
    }[]
  >`
    with hoy as (select platform.caracas_day(now()) as d)
    select to_char(c.igtf_enabled_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             as enabled_at,
           platform.taxpayer_type_at(c.id, hoy.d) is not distinct from 'especial' as perceiving,
           coalesce((select cs.absorb_igtf from public.company_settings cs
                      where cs.company_id = c.id), false) as absorbs,
           -- La quincena es la ÚNICA definición del servidor (revisión 6): la de la declaración
           -- (platform.fiscal_fortnight, migración 20261002120000, que va en el mismo commit).
           q.period_from::text as fortnight_from, q.period_to::text as fortnight_to
      from public.companies c, hoy, lateral platform.fiscal_fortnight(hoy.d) q
     where c.id = ${companyId}`;
  // L-15: el VENCIMIENTO de la quincena es del calendario de la PA SNAT/2025/000091 (familia de la
  // declaración, `platform.tax_due_date`). Sin fila: no hay calendario para esa quincena; con la
  // celda pendiente de cotejo, la fecha va en null — nunca se inventa (ADR-0072 §8).
  let vence: IgtfStatusResponse["fortnight"]["due"] = {
    date: null,
    status: "not_available",
    legal_source: null,
  };
  if (empresa !== undefined) {
    const [v] = await sql<
      { due_date: string | null; review_status: string; legal_source: string | null }[]
    >`
      select due_date::text as due_date, review_status, legal_source
        from platform.tax_due_date(${companyId}, 'igtf', ${empresa.fortnight_from}::date,
                                   ${empresa.fortnight_to}::date)`;
    if (v) {
      vence = {
        date: v.due_date,
        status: v.review_status === "secondary_source" ? "secondary_source" : "pending_review",
        legal_source: v.legal_source,
      };
    }
  }
  const [regla] = await sql<{ rate: string; legal_source: string }[]>`
    select rate::text as rate, legal_source from public.igtf_rules
     where effective_from <= platform.caracas_day(now())
     order by effective_from desc limit 1`;
  const instrumentos = await sql<IgtfInstrumentResponse[]>`
    select instrument, causes, legal_source from public.igtf_instrument_classes
     order by instrument`;
  return {
    enabled: empresa?.enabled_at != null,
    enabled_at: empresa?.enabled_at ?? null,
    perceiving: empresa?.perceiving ?? false,
    absorbs: empresa?.absorbs ?? false,
    fortnight: {
      from: empresa?.fortnight_from ?? "",
      to: empresa?.fortnight_to ?? "",
      due: vence,
    },
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

  const factura = await exigeEmpresaQueFactura(sql, input.company_id, "Percibir IGTF");
  if (!factura.ok) return factura;

  // El tipo VIGENTE HOY por la única lectura (ADR-0072 §1): la columna ya no es la verdad.
  const [empresa] = await sql<{ taxpayer_type_code: string | null; enabled: boolean }[]>`
    select platform.taxpayer_type_at(id, platform.caracas_day(now())) as taxpayer_type_code,
           igtf_enabled_at is not null as enabled
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
  await auditarConfig(sql, scope.value.tenantId, input.company_id, "igtf.enabled", {
    reason: input.reason,
    legal_source: "PA SNAT/2022/000013 (G.O. 42.339): SPE como agentes de percepción del IGTF.",
  });
  return ok(await readIgtfStatus(sql, input.company_id));
}

/**
 * Auditoría fiscal (PA SNAT/2022/000013 art. 1; ola 2 C2): qué instrumento causa IGTF es DATA de
 * plataforma con su fuente (`igtf_instrument_classes`, migración 20261002100100), no un
 * interruptor de la empresa. El endpoint se conserva para que un cliente viejo reciba un 422 que
 * explica el porqué —en LOS DOS sentidos: encender una transferencia bancaria cobraría un impuesto
 * que no causa; apagar el efectivo en divisas dejaría de percibir— en vez de un 404 mudo.
 */
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
  return err({
    code: "VALIDATION_FAILED",
    message:
      "Qué forma de pago causa IGTF no la decide la empresa: la fija la PA SNAT/2022/000013 art. 1 " +
      "(pagos en divisas o criptoactivos sin mediación de instituciones financieras). El efectivo " +
      "en divisas, USDT y Zelle causan; la transferencia, la tarjeta y el punto de venta bancarios " +
      "no. Si un caso no encaja, consúltalo con tu asesor.",
  });
}

/**
 * Declara el tipo de contribuyente de LA EMPRESA (ADR-0072 §1; A-03, B-07). Cada declaración
 * abre una VIGENCIA nueva en la historia append-only, con acta, autor y versión de reglas: nunca
 * sobrescribe (antes era un UPDATE de la columna, y «especial» regía desde que se guardaba).
 *
 * Desde cuándo rige, si no se dice: el especial, desde la notificación de la providencia; los
 * demás, desde el inicio de actividades si es la primera declaración (lo que la empresa ya era),
 * y desde hoy si cambia una anterior. Una fecha distinta se declara explícita y el acta la explica.
 *
 * Ya no exige el «modo facturas» (A-03): el tipo se declara ANTES de la primera factura, y es
 * justo lo que la facturación pide. Si hoy deja de ser `especial` con el IGTF activo, la
 * percepción SE APAGA en el mismo acto: un no-SPE no es agente de percepción.
 */
export async function setCompanyTaxpayerType(
  uow: UnitOfWork,
  input: SetCompanyTaxpayerTypeRequest,
): Promise<Result<SetCompanyTaxpayerTypeResponse, IgtfError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Declarar el tipo de contribuyente exige un usuario real.",
    });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "company.settings.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({
      code: "COMPANY_SUSPENDED",
      message: "La empresa está suspendida.",
    });
  }
  const tipo = input.taxpayer_type_code;
  // Decidido por criterio (ADR-0072, nota de aplicación): no_contribuyente se DERIVA de no tener
  // RIF y nunca se declara. VALIDAR-TRIBUTARIO en PENDIENTES_ASESOR.
  if (tipo === "no_contribuyente") {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "«No contribuyente» no se declara: es lo que es un negocio sin RIF. Con RIF, declara si eres ordinario o especial.",
    });
  }
  // Hallazgo 8 (PA 00071 art. 15; M-10, P-38): el contribuyente formal no se declara ni emite
  // hasta construir su periodicidad y sus documentos.
  if (tipo === "formal") {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "«Formal» todavía no se puede declarar: Ladino no lleva aún su periodicidad ni sus documentos (M-10). Si tu negocio es formal, consúltalo con tu asesor antes de facturar.",
    });
  }
  if (tipo === "especial" && input.notified_on === undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "El contribuyente especial rige desde la notificación de la providencia: indica su fecha.",
    });
  }
  if (tipo !== "especial" && input.notified_on !== undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La fecha de notificación es solo de la calificación como contribuyente especial.",
    });
  }
  const [emp] = await sql<
    {
      hoy: string;
      inicio: string;
      tiene: boolean;
      enabled: boolean;
      sin_rif: boolean;
    }[]
  >`
    select platform.caracas_day(now())::text as hoy,
           coalesce(c.activity_start_date, platform.caracas_day(now()))::text as inicio,
           exists (select 1 from public.company_taxpayer_types h where h.company_id = c.id)
             as tiene,
           c.igtf_enabled_at is not null as enabled,
           upper(btrim(c.tax_id)) like 'PEND-%' as sin_rif
      from public.companies c where c.id = ${input.company_id}`;
  if (!emp) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  // Sin RIF no hay inscripción en el IVA: la empresa es no contribuyente por hecho (D-01).
  // Mismo código y salida que el gate de modo que había antes (409): lo que falta es el RIF y la
  // facturación, no un dato del cuerpo.
  if (emp.sin_rif) {
    return err({
      code: "REGIME_KIND_NOT_ALLOWED",
      message:
        "Un negocio sin RIF no es contribuyente del IVA: registra tu RIF en Mi empresa y activa la facturación en Empezar; después declara el tipo.",
    });
  }
  const antes = await tipoVigente(sql, input.company_id, emp.hoy);
  const desde =
    input.effective_from ??
    (tipo === "especial" ? input.notified_on! : emp.tiene ? emp.hoy : emp.inicio);

  /**
   * RETROACTIVO (decidido por criterio, ADR-0072 nota de aplicación; norma primero: la
   * calificación rige desde la notificación, diga lo que diga el sistema). Se admite con acta, y
   * si ya hay documentos fiscales emitidos desde esa fecha, la respuesta y el acta dicen cuántos:
   * NO se reemiten, y hay que consultar al asesor. Alternativa descartada: prohibir fechas
   * anteriores al último documento emitido.
   */
  const emitidos = await emitidosDesde(sql, input.company_id, desde);
  const aviso =
    emitidos > 0
      ? `Desde el ${desde} ya hay ${emitidos} documento(s) fiscal(es) emitido(s) con el tipo anterior. ` +
        "No se reemiten: consulta a tu asesor si hace falta corregirlos."
      : null;

  await sql`
    insert into public.company_taxpayer_types
      (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason,
       rules_version, actor_id)
    values (${scope.value.tenantId}, ${input.company_id}, ${tipo}, ${desde}::date,
            ${input.notified_on ?? null}::date, ${input.reason}, ${RULES_VERSION},
            ${actor.userId})`;
  const ahora = await tipoVigente(sql, input.company_id, emp.hoy);
  const apagaIgtf = emp.enabled && ahora !== "especial";
  if (apagaIgtf) {
    await sql`update public.companies set igtf_enabled_at = null where id = ${input.company_id}`;
  }
  await auditarConfig(sql, scope.value.tenantId, input.company_id, "company.taxpayer_type.set", {
    previous: antes,
    new: tipo,
    effective_from: desde,
    notified_on: input.notified_on ?? null,
    reason: input.reason,
    igtf_disabled: apagaIgtf,
    documents_issued_since: emitidos,
    retroactive_warning: aviso,
  });
  return ok({
    taxpayer_type_code: tipo,
    effective_from: desde,
    notified_on: input.notified_on ?? null,
    igtf_disabled: apagaIgtf,
    documents_issued_since: emitidos,
    retroactive_warning: aviso,
  });
}

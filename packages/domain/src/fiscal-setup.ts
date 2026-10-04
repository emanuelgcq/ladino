import { err, ok, type Result } from "@ladino/core";
import type { TransactionSql, JSONValue } from "@ladino/db";
import type { AcceptIvaGeneralRequest, AssignFiscalRegimeRequest } from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { modoDeVenta } from "./modo-venta.js";

/**
 * LA PUESTA A PUNTO FISCAL: asignar el régimen y aceptar la alícuota general, CADA UNO CON SU
 * ACTA (RESPUESTA §2.15; el mismo defecto de G-13: «la regla vive en la API, no en el dominio»).
 *
 * Hasta la ola 4 las dos reglas y sus actas vivían en `apps/api/src/routes/fiscal-setup.ts`. Son
 * cambios de regla fiscal: cambian la versión de reglas de la empresa (ADR-0079) y su acta se
 * escribe en la MISMA transacción que el hecho. El permiso lo comprueba quien llama, como en el
 * talonario.
 */
export type FiscalSetupError =
  { code: "VALIDATION_FAILED"; message: string } | { code: "DUPLICATE"; message: string };

async function acta(
  sql: TransactionSql,
  companyId: string,
  eventType: string,
  payload: Record<string, JSONValue>,
): Promise<void> {
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values ((select tenant_id from public.companies where id = ${companyId}), ${companyId},
            'company', ${companyId}, ${eventType}, 'user', now(), ${RULES_VERSION},
            ${sql.json(payload)})`;
}

/** Asignar el régimen — solo si la empresa no tiene uno vigente, o para salir de recibos. */
export async function asignarRegimenFiscal(
  sql: TransactionSql,
  companyId: string,
  d: AssignFiscalRegimeRequest,
): Promise<Result<{ regime_code: string }, FiscalSetupError>> {
  // El hueco que la migración 43 cerró: aquí se ASUMÍA que no había documentos anteriores.
  // Ahora se pregunta de verdad — y con documentos fiscales emitidos (los recibos NO cuentan:
  // su transición es el caso feliz), el cambio exige motivo y deja acta.
  const [docs] = await sql<{ tiene: boolean }[]>`
    select platform.company_has_fiscal_documents(${companyId}) as tiene`;
  if (docs?.tiene === true && d.reason === undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "La empresa ya emitió documentos fiscales: cambiar cómo factura exige un motivo, que queda en la auditoría.",
    });
  }
  const [ya] = await sql<{ regime_code: string; regime_version_id: string }[]>`
    select regime_code, regime_version_id from platform.regime_at(${companyId}, now())`;
  // LA ÚNICA transición permitida desde aquí: salir del modo recibos (sin_facturacion) hacia un
  // régimen fiscal — el negocio obtuvo su RIF (migración 37). La vigencia vieja se CIERRA (no se
  // borra: append-only por fecha, ADR-0029) y los recibos históricos quedan intactos bajo ella.
  // Cualquier otro cambio sigue siendo un acto del mundo técnico. «Vende con recibos» lo dice la
  // definición única (migración 54), no el nombre del régimen.
  const vendeConRecibos =
    (await modoDeVenta(sql, companyId, new Date().toISOString())) === "recibos";
  if (ya && !(vendeConRecibos && d.regime_code !== ya.regime_code)) {
    return err({
      code: "DUPLICATE",
      message: `La empresa ya factura bajo «${ya.regime_code}». Cambiar de régimen es un acto del mundo técnico: /admin/facturacion-fiscal.`,
    });
  }
  const motivo = d.reason === undefined ? {} : { reason: d.reason };
  if (ya) {
    await sql`
      update public.company_fiscal_regimes set effective_to = now()
       where id = ${ya.regime_version_id} and effective_to is null`;
  }
  // `effective_from` es timestamptz: rige desde ESTE instante. La empresa recién asistida no
  // tiene documentos anteriores que quedarse sin régimen.
  const [fila] = await sql<{ regime_code: string }[]>`
    insert into public.company_fiscal_regimes (tenant_id, company_id, regime_code, effective_from)
    values ((select tenant_id from public.companies where id = ${companyId}), ${companyId},
            ${d.regime_code}, now())
    returning regime_code`;
  // EL ACTA VA DESPUÉS DEL CAMBIO, en los tres casos de uso que cambian una regla (régimen,
  // alícuota, regla de retención): así congela la versión de reglas NUEVA —la que queda al
  // commit— y no una anterior ni una intermedia que ningún estado comprometido tuvo (ADR-0079).
  if (ya) {
    await acta(sql, companyId, "fiscal.regime.upgraded", {
      from: ya.regime_code,
      to: d.regime_code,
      ...motivo,
    });
  } else {
    // La PRIMERA asignación también deja acta (R-27 lo daba por hecho y no ocurría: solo se
    // auditaba la subida desde recibos). Quien declara que vende con recibos, o cómo factura,
    // lo firma.
    await acta(sql, companyId, "fiscal.regime.assigned", {
      to: d.regime_code,
      origin: "empezar",
      ...motivo,
    });
  }
  return ok({ regime_code: fila!.regime_code });
}

/**
 * La ACEPTACIÓN de la alícuota general (B-02, ADR-0073). La base valida el rango, cierra la
 * vigencia de una general distinta y completa el catálogo; aquí va el acta, que se escribe
 * siempre. Un rango inválido sale de la base como LAD97: lo traduce quien llama.
 */
export async function aceptarIvaGeneral(
  sql: TransactionSql,
  companyId: string,
  userId: string,
  d: AcceptIvaGeneralRequest,
): Promise<
  Result<
    { rate: string; rules_created: number; accepted_on: string; changed: boolean },
    FiscalSetupError
  >
> {
  // El día de la aceptación es el día de Caracas, no el de UTC (la familia de bugs
  // fecha-contra-reloj de CLAUDE.md §3: quinta aparición y contando).
  const [dia] = await sql<{ hoy: string }[]>`
    select (now() at time zone 'America/Caracas')::date::text as hoy`;
  const hoy = dia!.hoy;
  // Desde qué día rige: el que elige la persona, nunca antes de hoy (reinterpretaría lo ya
  // emitido con la regla anterior). Las fechas YYYY-MM-DD se comparan como texto.
  const desde = d.effective_from ?? hoy;
  if (desde < hoy) {
    return err({
      code: "VALIDATION_FAILED",
      message: `La alícuota no puede regir antes de hoy (${hoy}): lo ya facturado conserva la suya.`,
    });
  }
  // La aceptación la hace la BASE (ADR-0073, B-02): valida el rango del catálogo (art. 27; el
  // 0 % se rechaza con LAD97), cierra la vigencia de una general distinta y abre otra desde hoy,
  // y completa desde el catálogo la reducida, la exenta y la adicional con su cita.
  const [acepta] = await sql<
    {
      rules_created: number;
      rules_closed: number;
      previous_rate: string | null;
      legal_source: string;
      changed: boolean;
    }[]
  >`
    -- B5: «cambió» lo decide la base, comparando numeric con numeric (la tasa que regía en la
    -- fecha efectiva contra la aceptada), no un string en TypeScript.
    select rules_created, rules_closed, previous_rate::text as previous_rate, legal_source,
           (previous_rate is distinct from ${d.rate}::numeric) as changed
      from platform.accept_general_vat(${companyId}, ${d.rate}::numeric, ${desde}::date)`;

  // El ACTA: quién aceptó qué, cuándo, para esta empresa, y qué había antes. Queda aunque la
  // tasa sea la misma que ya regía (esta misma empresa la aceptó antes).
  await acta(sql, companyId, "fiscal.iva.accepted", {
    rate: d.rate,
    previous_rate: acepta!.previous_rate,
    effective_from: desde,
    rules_created: acepta!.rules_created,
    rules_closed: acepta!.rules_closed,
    legal_source: acepta!.legal_source,
    accepted_by: userId,
    accepted_on: hoy,
  });
  return ok({
    rate: d.rate,
    rules_created: acepta!.rules_created,
    accepted_on: hoy,
    changed: acepta!.changed,
  });
}

import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql, type TransactionSql } from "@ladino/db";
import { AssignFiscalRegimeRequest, AcceptIvaGeneralRequest } from "@ladino/schemas";
import { RULES_VERSION, modoDeVenta } from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

/**
 * LA PUESTA A PUNTO FISCAL DEL ASISTENTE (Fase C, PARTE 4) — tres actos que
 * hasta hoy solo podía hacer un operador por SQL:
 *
 *   · leer el catálogo de regímenes (cada uno con SU norma citada, sembrada
 *     en la migración 21) y el vigente de la empresa;
 *   · asignar el régimen — una vez: cambiarlo después es un acto de /admin;
 *   · ACEPTAR la alícuota general del IVA desde el CATÁLOGO con fuente
 *     (ADR-0073, que concilia ADR-0038 y ADR-0057): la persona la acepta dentro
 *     del rango del art. 27 que trae el catálogo, con su acta; la regla es de
 *     la empresa. Lo demás (reducida, exenta, adicional) es ley y viene del
 *     catálogo con su cita. Aceptar otra tasa cierra la vigencia de la anterior
 *     (B-02). La lógica vive en `platform.accept_general_vat`.
 */

async function exigePermiso(
  tx: TransactionSql,
  actor: { kind: string; userId?: string },
  companyId: string,
  permiso: string,
  quehacer: string,
): Promise<string> {
  if (actor.kind !== "user" || actor.userId === undefined) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: `${quehacer} exige un usuario real.`,
    });
  }
  const [p] = await tx<{ ok: boolean }[]>`
    select platform.ladino_user_has_permission(${actor.userId}, ${permiso}, ${companyId}) as ok`;
  if (!p?.ok) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: `${quehacer} exige el permiso ${permiso}.`,
    });
  }
  return actor.userId;
}

export function fiscalSetupRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  /** El catálogo de regímenes + el vigente + si la alícuota general ya existe. */
  app.get("/v1/fiscal/setup", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const regimenes = await tx<Record<string, unknown>[]>`
        select code, name, description, numbering_mode, legal_source
          from public.fiscal_regimes
         where code <> 'interno_no_fiscal'
         order by case code when 'formatos_libres' then 0 else 1 end, code`;
      const [vigente] = await tx<{ regime_code: string }[]>`
        select regime_code from platform.regime_at(${companyId}, now())`;
      const modo = await modoDeVenta(tx, companyId, new Date().toISOString());
      const [iva] = await tx<{ rate: string; legal_source: string }[]>`
        select rate::text as rate, legal_source from public.tax_rules
         where jurisdiction = 'VE' and tax_code = 'iva' and transaction_type = 'sale'
           and taxpayer_type is null and product_tax_category = 'gravado_general'
           and status = 'active'
           and (company_id is null or company_id = ${companyId})
           and effective_from <= (now() at time zone 'America/Caracas')::date
           and (effective_to is null or effective_to > (now() at time zone 'America/Caracas')::date)
         -- La propia antes que la de la plataforma (ADR-0057).
         order by (company_id is not null) desc, priority desc limit 1`;
      // La REFERENCIA del catálogo con su cita (B-11): la web la enseña, nunca la escribe.
      const [catalogo] = await tx<
        { rate: string; rate_min: string; rate_max: string; legal_source: string }[]
      >`
        select rate::text as rate, rate_min::text as rate_min, rate_max::text as rate_max,
               legal_source
          from public.tax_rule_templates
         where jurisdiction = 'VE' and tax_code = 'iva' and product_tax_category = 'gravado_general'
           and requires_acceptance
           and effective_from <= (now() at time zone 'America/Caracas')::date
           and (effective_to is null or effective_to > (now() at time zone 'America/Caracas')::date)`;
      return {
        regimes: regimenes,
        current_regime: vigente?.regime_code ?? null,
        sales_mode: modo,
        iva_general: iva ?? null,
        iva_catalog: catalogo ?? null,
      };
    });
    return c.json(cuerpo, 200);
  });

  /** Asignar el régimen — solo si la empresa no tiene uno vigente. */
  app.post("/v1/fiscal/regime", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = AssignFiscalRegimeRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    const { actor } = c.get("ladino.auth");
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigePermiso(tx, actor, companyId, "fiscal.regime.manage", "Asignar el régimen");
      // El hueco que la migración 43 cerró: aquí se ASUMÍA que no había
      // documentos anteriores. Ahora se pregunta de verdad — y con documentos
      // fiscales emitidos (los recibos NO cuentan: su transición es el caso
      // feliz), el cambio exige motivo y deja acta.
      const [docs] = await tx<{ tiene: boolean }[]>`
        select platform.company_has_fiscal_documents(${companyId}) as tiene`;
      if (docs?.tiene === true && parsed.data.reason === undefined) {
        throw new DominioError({
          code: "VALIDATION_FAILED",
          message:
            "La empresa ya emitió documentos fiscales: cambiar cómo factura exige un motivo, que queda en la auditoría.",
        });
      }
      const [ya] = await tx<{ regime_code: string; regime_version_id: string }[]>`
        select regime_code, regime_version_id from platform.regime_at(${companyId}, now())`;
      // LA ÚNICA transición permitida desde aquí: salir del modo recibos
      // (sin_facturacion) hacia un régimen fiscal — el negocio obtuvo su RIF
      // (migración 37). La vigencia vieja se CIERRA (no se borra: append-only
      // por fecha, ADR-0029) y los recibos históricos quedan intactos bajo
      // ella. Cualquier otro cambio sigue siendo un acto del mundo técnico.
      // «Vende con recibos» lo dice la definición única (migración 54), no el
      // nombre del régimen.
      const vendeConRecibos =
        (await modoDeVenta(tx, companyId, new Date().toISOString())) === "recibos";
      if (ya && !(vendeConRecibos && parsed.data.regime_code !== ya.regime_code)) {
        throw new DominioError({
          code: "DUPLICATE",
          message: `La empresa ya factura bajo «${ya.regime_code}». Cambiar de régimen es un acto del mundo técnico: /admin/facturacion-fiscal.`,
        });
      }
      const [empresa] = await tx<{ tenant_id: string }[]>`
        select tenant_id from public.companies where id = ${companyId}`;
      if (ya) {
        await tx`
          update public.company_fiscal_regimes set effective_to = now()
           where id = ${ya.regime_version_id} and effective_to is null`;
        await tx`
          insert into public.audit_events
            (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
             actor_type, occurred_at, rules_version, payload)
          values (${empresa!.tenant_id}, ${companyId}, 'company', ${companyId},
                  'fiscal.regime.upgraded', 'user', now(), ${RULES_VERSION},
                  ${tx.json({
                    from: ya.regime_code,
                    to: parsed.data.regime_code,
                    ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
                  })})`;
      }
      // La PRIMERA asignación también deja acta (R-27 lo daba por hecho y no
      // ocurría: solo se auditaba la subida desde recibos). Quien declara que
      // vende con recibos, o cómo factura, lo firma.
      if (!ya) {
        await tx`
          insert into public.audit_events
            (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
             actor_type, occurred_at, rules_version, payload)
          values (${empresa!.tenant_id}, ${companyId}, 'company', ${companyId},
                  'fiscal.regime.assigned', 'user', now(), ${RULES_VERSION},
                  ${tx.json({
                    to: parsed.data.regime_code,
                    origin: "empezar",
                    ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
                  })})`;
      }
      // `effective_from` es timestamptz: rige desde ESTE instante. La empresa
      // recién asistida no tiene documentos anteriores que quedarse sin régimen.
      const [fila] = await tx<{ regime_code: string }[]>`
        insert into public.company_fiscal_regimes (tenant_id, company_id, regime_code, effective_from)
        values (${empresa!.tenant_id}, ${companyId}, ${parsed.data.regime_code}, now())
        returning regime_code`;
      return { regime_code: fila!.regime_code };
    });
    return c.json(cuerpo, 201);
  });

  /**
   * La ACEPTACIÓN de la alícuota general (B-02, ADR-0073). La base valida el
   * rango, cierra la vigencia de una general distinta y completa el catálogo;
   * aquí van el permiso y el acta, que se escribe siempre.
   */
  app.post("/v1/fiscal/iva-general", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = AcceptIvaGeneralRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    const { actor } = c.get("ladino.auth");
    // LAD97 (ADR-0073): la base rechaza una general fuera del catálogo con un mensaje que dice
    // POR QUÉ (0 %, o fuera de 8–16,5 %). La tabla de SQLSTATE daría el genérico; aquí se lleva el
    // de la base. Fuera de la transacción: postgres.js rechaza begin() con el error original.
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const userId = await exigePermiso(
        tx,
        actor,
        companyId,
        "tax.rules.manage",
        "Aceptar la alícuota",
      );
      const [empresa] = await tx<{ tenant_id: string }[]>`
        select tenant_id from public.companies where id = ${companyId}`;
      // El día de la aceptación es el día de Caracas, no el de UTC (la familia
      // de bugs fecha-contra-reloj de CLAUDE.md §3: quinta aparición y contando).
      const [dia] = await tx<{ hoy: string }[]>`
        select (now() at time zone 'America/Caracas')::date::text as hoy`;
      const hoy = dia!.hoy;
      // Desde qué día rige: el que elige la persona, nunca antes de hoy (reinterpretaría lo ya
      // emitido con la regla anterior). Las fechas YYYY-MM-DD se comparan como texto.
      const desde = parsed.data.effective_from ?? hoy;
      if (desde < hoy) {
        throw new DominioError({
          code: "VALIDATION_FAILED",
          message: `La alícuota no puede regir antes de hoy (${hoy}): lo ya facturado conserva la suya.`,
        });
      }
      // La aceptación la hace la BASE (ADR-0073, B-02): valida el rango del catálogo (art. 27;
      // el 0 % se rechaza con LAD97), cierra la vigencia de una general distinta y abre otra desde
      // hoy, y completa desde el catálogo la reducida, la exenta y la adicional con su cita.
      const [acepta] = await tx<
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
               (previous_rate is distinct from ${parsed.data.rate}::numeric) as changed
          from platform.accept_general_vat(${companyId}, ${parsed.data.rate}::numeric, ${desde}::date)`;
      const creadas = acepta!.rules_created;

      // El ACTA: quién aceptó qué, cuándo, para esta empresa, y qué había antes. Queda aunque
      // la tasa sea la misma que ya regía (esta misma empresa la aceptó antes).
      await tx`
        insert into public.audit_events
          (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
           actor_type, occurred_at, rules_version, payload)
        values (${empresa!.tenant_id}, ${companyId}, 'company', ${companyId},
                'fiscal.iva.accepted', 'user', now(), ${RULES_VERSION},
                ${tx.json({
                  rate: parsed.data.rate,
                  previous_rate: acepta!.previous_rate,
                  effective_from: desde,
                  rules_created: creadas,
                  rules_closed: acepta!.rules_closed,
                  legal_source: acepta!.legal_source,
                  accepted_by: userId,
                  accepted_on: hoy,
                })})`;

      return {
        rate: parsed.data.rate,
        rules_created: creadas,
        accepted_on: hoy,
        changed: acepta!.changed,
      };
    }).catch((e: unknown) => {
      if ((e as { code?: string }).code === "LAD97") {
        throw new DominioError({
          code: "VALIDATION_FAILED",
          message: (e as { message?: string }).message ?? "Alícuota general no válida.",
        });
      }
      throw e;
    });
    return c.json(cuerpo, 201);
  });
}

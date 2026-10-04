import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql, type TransactionSql } from "@ladino/db";
import { AssignFiscalRegimeRequest, AcceptIvaGeneralRequest } from "@ladino/schemas";
import {
  aceptarIvaGeneral,
  asignarRegimenFiscal,
  avisoYaFactura,
  modoDeVenta,
} from "@ladino/domain";
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
        // M-09: la caja lo pinta tal cual; cuándo aplica lo decide el dominio.
        invoicing_notice: modo === "facturas" && (await avisoYaFactura(tx, companyId)),
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
      // La regla y sus actas viven en el dominio (§2.15, G-13): aquí, solo el permiso.
      return asignarRegimenFiscal(tx, companyId, parsed.data);
    });
    if (!cuerpo.ok) throw new DominioError(cuerpo.error);
    return c.json(cuerpo.value, 201);
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
      // La regla y su acta viven en el dominio (§2.15, G-13): aquí, solo el permiso.
      return aceptarIvaGeneral(tx, companyId, userId, parsed.data);
    }).catch((e: unknown) => {
      if ((e as { code?: string }).code === "LAD97") {
        throw new DominioError({
          code: "VALIDATION_FAILED",
          message: (e as { message?: string }).message ?? "Alícuota general no válida.",
        });
      }
      throw e;
    });
    if (!cuerpo.ok) throw new DominioError(cuerpo.error);
    return c.json(cuerpo.value, 201);
  });
}

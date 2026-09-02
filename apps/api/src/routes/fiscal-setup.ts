import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql, type TransactionSql } from "@ladino/db";
import { AssignFiscalRegimeRequest, AcceptIvaGeneralRequest } from "@ladino/schemas";
import { RULES_VERSION } from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

/**
 * LA PUESTA A PUNTO FISCAL DEL ASISTENTE (Fase C, PARTE 4) — tres actos que
 * hasta hoy solo podía hacer un operador por SQL:
 *
 *   · leer el catálogo de regímenes (cada uno con SU norma citada, sembrada
 *     en la migración 21) y el vigente de la empresa;
 *   · asignar el régimen — una vez: cambiarlo después es un acto de /admin;
 *   · ACEPTAR la alícuota general del IVA. Ladino NO la afirma: la declara y
 *     la acepta LA PERSONA, con su nombre y su fecha en la auditoría y en el
 *     `legal_source` de la regla. VALIDAR-TRIBUTARIO: la cifra aceptada debe
 *     confirmarse contra la Ley de IVA vigente antes de producción — por eso
 *     el texto de la regla lo dice, en vez de citar una gaceta que este
 *     repositorio no tiene verificada (docs/02_COMPLIANCE/IVA_SPEC.md: «no
 *     fijar 16% en código»).
 *
 * `tax_rules` es GLOBAL (por jurisdicción, no por empresa — ADR-0038): la
 * aceptación crea las reglas UNA vez por instancia; las empresas siguientes
 * solo dejan su acta de aceptación en la auditoría.
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
      const [iva] = await tx<{ rate: string; legal_source: string }[]>`
        select rate::text as rate, legal_source from public.tax_rules
         where jurisdiction = 'VE' and tax_code = 'iva' and transaction_type = 'sale'
           and taxpayer_type is null and product_tax_category = 'gravado_general'
           and status = 'active'
           and effective_from <= (now() at time zone 'America/Caracas')::date
           and (effective_to is null or effective_to > (now() at time zone 'America/Caracas')::date)
         order by priority desc limit 1`;
      return {
        regimes: regimenes,
        current_regime: vigente?.regime_code ?? null,
        iva_general: iva ?? null,
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
      const [ya] = await tx<{ regime_code: string }[]>`
        select regime_code from platform.regime_at(${companyId}, now())`;
      if (ya) {
        throw new DominioError({
          code: "DUPLICATE",
          message: `La empresa ya factura bajo «${ya.regime_code}». Cambiar de régimen es un acto del mundo técnico: /admin/facturacion-fiscal.`,
        });
      }
      const [empresa] = await tx<{ tenant_id: string }[]>`
        select tenant_id from public.companies where id = ${companyId}`;
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
   * La ACEPTACIÓN de la alícuota general. Crea —si no existen— las reglas
   * GENERALES (taxpayer NULL): gravado a la alícuota aceptada y exento a
   * cero, para venta y para compra. Siempre deja el acta en la auditoría.
   */
  app.post("/v1/fiscal/iva-general", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = AcceptIvaGeneralRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    const { actor } = c.get("ladino.auth");
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
      const fuente =
        `Alícuota declarada y ACEPTADA por el usuario ${userId} el ${hoy} desde el asistente ` +
        `de puesta a punto. VALIDAR-TRIBUTARIO: confirmar contra la Ley de IVA vigente antes ` +
        `de producción (docs/02_COMPLIANCE/IVA_SPEC.md).`;

      // Concurrencia: el mismo advisory lock que usan las semillas de reglas.
      await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
      let creadas = 0;
      for (const [categoria, tasa] of [
        ["gravado_general", parsed.data.rate],
        ["exento", "0"],
      ] as const) {
        for (const tipo of ["sale", "purchase"] as const) {
          const r = await tx`
            insert into public.tax_rules
              (jurisdiction, tax_code, taxpayer_type, product_tax_category, rate,
               effective_from, legal_source, priority, transaction_type)
            select 'VE', 'iva', null, ${categoria}, ${tasa}::numeric,
                   (now() at time zone 'America/Caracas')::date, ${fuente}, 5, ${tipo}
             where not exists (
               select 1 from public.tax_rules
                where jurisdiction = 'VE' and tax_code = 'iva' and taxpayer_type is null
                  and product_tax_category = ${categoria} and transaction_type = ${tipo}
                  and status = 'active')`;
          creadas += r.count;
        }
      }

      // El ACTA: quién aceptó qué, cuándo, para esta empresa. Queda aunque las
      // reglas ya existieran (otra empresa de la instancia las creó antes).
      await tx`
        insert into public.audit_events
          (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
           actor_type, occurred_at, rules_version, payload)
        values (${empresa!.tenant_id}, ${companyId}, 'company', ${companyId},
                'fiscal.iva.accepted', 'user', now(), ${RULES_VERSION},
                ${tx.json({ rate: parsed.data.rate, accepted_by: userId, accepted_on: hoy })})`;

      return { rate: parsed.data.rate, rules_created: creadas, accepted_on: hoy };
    });
    return c.json(cuerpo, 201);
  });
}

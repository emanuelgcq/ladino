import type { Hono } from "hono";
import { withTransaction, type Sql, type TransactionSql } from "@ladino/db";
import { UpdateCompanySettingsRequest } from "@ladino/schemas";
import { getCompanySettings, setCompanySettings } from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

/**
 * EL RESUMEN DEL NEGOCIO (Fase C): los números de Inicio y de Mi dinero, en
 * UNA respuesta y calculados TODOS en SQL `numeric` — la pantalla no suma ni
 * un céntimo. «Hoy» y «este mes» se cortan con el día de VENEZUELA: a las
 * 8 pm de Caracas la venta sigue siendo de hoy aunque el UTC diga mañana
 * (la familia de bugs de CLAUDE.md §3).
 *
 * Permiso: `treasury.read` — es la vista del dinero del negocio entero.
 */
async function exigeTreasuryRead(
  tx: TransactionSql,
  actor: { kind: string; userId?: string },
  companyId: string,
): Promise<void> {
  if (actor.kind !== "user" || actor.userId === undefined) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Ver el resumen del negocio exige un usuario real.",
    });
  }
  const [p] = await tx<{ ok: boolean }[]>`
    select platform.ladino_user_has_permission(${actor.userId}, 'treasury.read', ${companyId}) as ok`;
  if (!p?.ok) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Ver el resumen del negocio exige el permiso treasury.read.",
    });
  }
}

export function negocioRoutes(app: Hono, sql: Sql): void {
  app.get("/v1/negocio/resumen", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeTreasuryRead(tx, actor, companyId);

      const [empresa] = await tx<{ moneda: string }[]>`
        select functional_currency_code as moneda from public.companies where id = ${companyId}`;
      const funcional = empresa?.moneda ?? "VES";

      // Vendido y ganado, HOY y MES, con el margen desde el costo CONGELADO de
      // cada línea (cost_snapshot: el costo del kardex al emitir, nunca el de
      // hoy). Las líneas sin costo se CUENTAN y la pantalla lo dice.
      const [ventas] = await tx<
        {
          vendido_hoy: string;
          vendido_mes: string;
          ganado_hoy: string;
          ganado_mes: string;
          lineas_sin_costo_mes: number;
        }[]
      >`
        with ventana as (
          select (now() at time zone 'America/Caracas')::date as hoy,
                 date_trunc('month', (now() at time zone 'America/Caracas')::date)::date as mes
        ),
        lineas as (
          select (d.issued_at at time zone 'America/Caracas')::date as dia,
                 l.line_total_functional as total,
                 case when l.cost_snapshot is null then null
                      else l.line_subtotal_functional - l.cost_snapshot * l.quantity end as margen
            from public.documents d
            join public.document_lines l on l.document_id = d.id
           where d.company_id = ${companyId} and d.kind = 'invoice'
             and d.status in ('issued', 'paid')
             and d.issued_at >= (select mes from ventana)::timestamptz - interval '1 day'
        )
        select
          coalesce(sum(total) filter (where dia = (select hoy from ventana)), 0)::text as vendido_hoy,
          coalesce(sum(total) filter (where dia >= (select mes from ventana)), 0)::text as vendido_mes,
          coalesce(sum(margen) filter (where dia = (select hoy from ventana)), 0)::text as ganado_hoy,
          coalesce(sum(margen) filter (where dia >= (select mes from ventana)), 0)::text as ganado_mes,
          count(*) filter (where margen is null and dia >= (select mes from ventana))::int
            as lineas_sin_costo_mes
        from lineas`;

      // Lo que me deben / lo que debo: saldos que calcula el ESQUEMA, sumados
      // en SQL. Solo los positivos: un sobrepago no «resta deuda de otros».
      const [deben] = await tx<{ total: string }[]>`
        select coalesce(sum(saldo), 0)::text as total
          from (select greatest(platform.document_balance(${companyId}, d.id), 0) as saldo
                  from public.documents d
                 where d.company_id = ${companyId} and d.kind = 'invoice'
                   and d.status = 'issued') s`;
      const [debo] = await tx<{ total: string }[]>`
        select coalesce(sum(saldo), 0)::text as total
          from (select greatest(platform.supplier_invoice_balance(${companyId}, i.id), 0) as saldo
                  from public.supplier_invoices i
                 where i.company_id = ${companyId} and i.status = 'posted') s`;

      const dinero = await tx<{ currency: string; balance: string }[]>`
        select ca.currency, coalesce(sum(b.balance), 0)::text as balance
          from public.company_accounts ca
          left join public.company_account_balances b on b.account_id = ca.id
         where ca.company_id = ${companyId} and ca.is_active
         group by ca.currency
         order by ca.currency`;

      const [agotarse] = await tx<{ n: number }[]>`
        select count(*)::int as n from platform.low_stock_products(${companyId})`;

      const [tasa] = await tx<
        { rate: string; rate_date: string; source: string; es_de_hoy: boolean }[]
      >`
        select rate::text as rate, rate_date::text as rate_date, source,
               rate_date = (now() at time zone 'America/Caracas')::date as es_de_hoy
          from public.exchange_rates
         where from_currency = 'USD' and to_currency = ${funcional}
           and rate_date <= (now() at time zone 'America/Caracas')::date + 1
         order by rate_date desc, created_at desc limit 1`;

      const ultimas = await tx<Record<string, unknown>[]>`
        select d.id,
               to_char(d.issued_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as issued_at,
               case when cu.is_system then 'Consumidor final' else cu.legal_name end as customer_name,
               d.functional_amount::text as total_functional, d.status
          from public.documents d
          join public.customers cu on cu.id = d.customer_id
         where d.company_id = ${companyId} and d.kind = 'invoice'
           and d.status in ('issued', 'paid', 'annulled')
         order by d.issued_at desc nulls last
         limit 8`;

      return {
        functional_currency: funcional,
        vendido_hoy: ventas!.vendido_hoy,
        vendido_mes: ventas!.vendido_mes,
        ganado_hoy: ventas!.ganado_hoy,
        ganado_mes: ventas!.ganado_mes,
        lineas_sin_costo_mes: ventas!.lineas_sin_costo_mes,
        lo_que_me_deben: deben!.total,
        lo_que_debo: debo!.total,
        mi_dinero: dinero,
        por_agotarse: agotarse?.n ?? 0,
        tasa_del_dia: tasa ?? null,
        ultimas_ventas: ultimas,
      };
    });
    return c.json(cuerpo, 200);
  });

  /**
   * Conversión del SERVIDOR con la tasa vigente: la pantalla que enseña «≈ Bs.»
   * junto a un precio en dólares pregunta aquí — multiplicar en el navegador
   * sería aritmética de dinero en el cliente.
   */
  app.get("/v1/negocio/convertir", async (c) => {
    requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const amount = c.req.query("amount") ?? "";
    const from = c.req.query("from") ?? "USD";
    const to = c.req.query("to") ?? "VES";
    if (
      !/^\d{1,16}(\.\d{1,8})?$/.test(amount) ||
      !/^[A-Z]{3}$/.test(from) ||
      !/^[A-Z]{3}$/.test(to)
    ) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "La conversión exige amount decimal y monedas de tres letras.",
      });
    }
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      if (from === to) {
        return {
          amount,
          from_currency: from,
          to_currency: to,
          rate: "1",
          rate_source: "identidad",
          converted: amount,
        };
      }
      const [t] = await tx<{ rate: string | null; source: string | null }[]>`
        select r.rate::text as rate, r.source from public.exchange_rates r
         where r.from_currency = ${from} and r.to_currency = ${to}
           and r.rate_date <= (now() at time zone 'America/Caracas')::date + 1
         order by r.rate_date desc, r.created_at desc limit 1`;
      if (!t?.rate) {
        throw new DominioError({
          code: "EXCHANGE_RATE_MISSING",
          message: `No hay tasa de ${from} a ${to}. Carga la tasa del día primero.`,
        });
      }
      const [calc] = await tx<{ converted: string }[]>`
        select round(${amount}::numeric * ${t.rate}::numeric, 8)::text as converted`;
      return {
        amount,
        from_currency: from,
        to_currency: to,
        rate: t.rate,
        rate_source: t.source ?? "manual",
        converted: calc!.converted,
      };
    });
    return c.json(cuerpo, 200);
  });

  // ── Los ajustes del negocio (migración 28) ────────────────────────────────
  app.get("/v1/company-settings", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => getCompanySettings(uow, companyId));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  app.put("/v1/company-settings", async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = UpdateCompanySettingsRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      setCompanySettings(uow, companyId, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });
}

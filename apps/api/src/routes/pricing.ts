import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import { CreatePriceListRequest, SetPriceRequest } from "@ladino/schemas";
import { createPriceList, setPrice } from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rutas de listas de precios. Los importes son STRINGS de punta a punta. */
export function pricingRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  app.get("/v1/price-lists", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      // `is_caja_default`: la lista que /vender aplica a un cliente sin
      // preferida — el dato del dueño (migración 36) o, sin él, la MISMA
      // heurística de resolverLista. Calculado aquí para que el panel no
      // adivine con otra copia de la regla.
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        with caja as (
          select l.id from public.price_lists l
           where l.company_id = ${companyId} and l.status = 'active'
           order by (l.id = (select cs.default_price_list_id from public.company_settings cs
                              where cs.company_id = ${companyId})) desc,
                    (l.name = 'detal') desc, (l.name like 'detal%') desc, l.created_at
           limit 1
        )
        select p.id, p.tenant_id, p.company_id, p.name, p.currency_code, p.status,
               to_char(p.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
               (p.id = (select id from caja)) as is_caja_default
          from public.price_lists p
         where p.company_id = ${companyId}
         order by p.name`,
    );
    return c.json(filas, 200);
  });

  app.post("/v1/price-lists", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreatePriceListRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    if (parsed.data.company_id !== companyId) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El company_id del cuerpo no coincide con X-Company-Id.",
      });
    }
    const { actor } = c.get("ladino.auth");
    const resultado = await withTransaction(sql, actor, (uow) => createPriceList(uow, parsed.data));
    if (!resultado.ok) throw new DominioError(resultado.error);
    return c.json(resultado.value, 201);
  });

  // El historial COMPLETO por producto (o de la lista entera): la vigencia es
  // dato, no un cálculo del cliente. `at=` devuelve además el vigente a esa
  // fecha vía price_at — LA FECHA ES PARÁMETRO (ADR-0032), nunca el reloj.
  app.get("/v1/price-lists/:id/prices", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const listaId = c.req.param("id");
    if (!UUID_RE.test(listaId)) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    const productId = c.req.query("product_id");
    if (productId !== undefined && !UUID_RE.test(productId)) {
      throw new DominioError({ code: "VALIDATION_FAILED", message: "product_id malformado." });
    }
    const at = c.req.query("at");
    if (at !== undefined && Number.isNaN(Date.parse(at))) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "`at` debe ser una fecha ISO 8601.",
      });
    }

    const respuesta = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [lista] = await tx<{ id: string; currency_code: string }[]>`
        select id, currency_code from public.price_lists
         where id = ${listaId} and company_id = ${companyId}`;
      if (!lista) return null;

      // La EQUIVALENCIA en la otra moneda, con la tasa BCV vigente HOY y en
      // SQL numeric — cero aritmética en el cliente. Es la REFERENCIA de hoy,
      // igual para todas las filas; los Bs del día del precio van aparte
      // (`historical_*`, C-11). Sin tasa: null, y la UI enseña «sin tasa del
      // día», no un cero.
      const [tasa] = await tx<{ rate: string; rate_date: string; source: string }[]>`
        select f.rate::text as rate, f.rate_date::text as rate_date, f.source
          from platform.rate_for(${companyId}, 'USD', 'VES', (now() at time zone 'America/Caracas')::date) f`;
      const equivalencia =
        tasa === undefined
          ? { expr: tx`null`, moneda: null }
          : lista.currency_code === "VES"
            ? {
                // La equivalencia es PRESENTACIÓN: a las unidades mínimas de SU moneda
                // (ADR-0063 §5). /productos ya lo hacía y aquí salía «Bs. 1.263,31005»:
                // la misma cifra con dos caras (QA 2026-09-15, h. 13).
                expr: tx`round(amount / ${tasa.rate}::numeric,
                               platform.currency_minor_units('USD'))::text`,
                moneda: "USD",
              }
            : lista.currency_code === "USD"
              ? {
                  expr: tx`round(amount * ${tasa.rate}::numeric,
                                 platform.currency_minor_units('VES'))::text`,
                  moneda: "VES",
                }
              : { expr: tx`null`, moneda: null };

      // C-11: ADEMÁS de la referencia de hoy, los Bs a la tasa del DÍA EN QUE EMPEZÓ A REGIR el
      // precio. La granularidad es el DÍA DE CARACAS de `effective_from` contra `rate_date`
      // (date contra date, nunca un instante contra medianoche), y la tasa es la oficial vigente
      // ese día según `platform.rate_for` (regla 8: por fecha y fuente), consultada una vez por
      // día distinto. Un precio programado (su día aún no llegó) NO toma la tasa de hoy: va sin
      // cifra y con `scheduled`; un día sin tasa, sin cifra y con `missing`. Una lista que no
      // es USD ni VES no tiene par que convertir: sin cifra, sin tasa y con `not_applicable`.
      const historica =
        lista.currency_code === "VES"
          ? {
              expr: tx`round(i.amount / t.rate, platform.currency_minor_units('USD'))::text`,
              moneda: "USD",
            }
          : lista.currency_code === "USD"
            ? {
                expr: tx`round(i.amount * t.rate, platform.currency_minor_units('VES'))::text`,
                moneda: "VES",
              }
            : { expr: tx`null`, moneda: null };

      const filtro = productId === undefined ? tx`` : tx`and product_id = ${productId}`;
      const items = await tx<Record<string, unknown>[]>`
        with hoy as (
          select (now() at time zone 'America/Caracas')::date as dia
        ), i as (
          select id, price_list_id, product_id, amount, effective_from, effective_to,
                 platform.caracas_day(effective_from) as dia
            from public.price_list_items
           where price_list_id = ${listaId} ${filtro}
        ), t as (
          select d.dia, f.rate, f.rate_date, f.source
            from (select distinct i.dia from i, hoy where i.dia <= hoy.dia) d
            left join lateral platform.rate_for(${companyId}, 'USD', 'VES', d.dia) f on true
        )
        select i.id, i.price_list_id, i.product_id, i.amount::text as amount,
               ${lista.currency_code} as currency,
               ${equivalencia.expr} as equivalent_amount,
               ${equivalencia.moneda} as equivalent_currency,
               ${historica.expr} as historical_equivalent_amount,
               ${historica.moneda} as historical_equivalent_currency,
               case when ${historica.moneda !== null} then t.rate::text end as historical_rate,
               case when ${historica.moneda !== null} then t.rate_date::text end
                 as historical_rate_date,
               case when ${historica.moneda !== null} then t.source end as historical_rate_source,
               case when not ${historica.moneda !== null} then 'not_applicable'
                    when i.dia > hoy.dia then 'scheduled'
                    when t.rate is null then 'missing'
                    else 'available' end as historical_rate_status,
               to_char(i.effective_from at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as effective_from,
               case when i.effective_to is null then null
                    else to_char(i.effective_to at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end as effective_to
          from i
          cross join hoy
          left join t on t.dia = i.dia
         order by i.product_id, i.effective_from desc`;
      let vigente: { amount: string; currency: string } | null = null;
      if (at !== undefined && productId !== undefined) {
        const [v] = await tx<{ amount: string | null }[]>`
          select platform.price_at(${listaId}, ${productId}, ${at})::text as amount`;
        vigente = v?.amount != null ? { amount: v.amount, currency: lista.currency_code } : null;
      }
      return { items, vigente, rate: tasa ?? null };
    });
    if (respuesta === null) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    return c.json(respuesta, 200);
  });

  app.post("/v1/price-lists/:id/prices", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const listaId = c.req.param("id");
    if (!UUID_RE.test(listaId)) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    const parsed = SetPriceRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    if (parsed.data.company_id !== companyId) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El company_id del cuerpo no coincide con X-Company-Id.",
      });
    }
    const { actor } = c.get("ladino.auth");
    const resultado = await withTransaction(sql, actor, (uow) =>
      setPrice(uow, listaId, parsed.data),
    );
    if (!resultado.ok) throw new DominioError(resultado.error);
    return c.json(resultado.value, 201);
  });
}

/** Catálogos de referencia: unidades y clasificaciones tributarias (globales),
 *  categorías comerciales (por company). Solo lectura: se pueblan por
 *  migración o por casos de uso futuros. */
export function catalogRoutes(app: Hono, sql: Sql): void {
  app.get("/v1/units", async (c) => {
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx`select code, name, symbol from public.units order by code`,
    );
    return c.json(filas, 200);
  });

  app.get("/v1/tax-categories", async (c) => {
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx`
        -- offered_in_sales: si el catálogo con fuente la OFRECE en ventas (ADR-0073). Lo
        -- pendiente de fuente (no_sujeto) y lo exonerado de importación salen en false, y la
        -- pantalla no los ofrece al clasificar un producto.
        select c.code, c.name, c.description, c.status,
               exists (
             select 1 from public.tax_rule_templates t
              where t.product_tax_category = c.code and t.offered_in_sales
                and t.effective_from <= (now() at time zone 'America/Caracas')::date
                and (t.effective_to is null
                     or t.effective_to > (now() at time zone 'America/Caracas')::date))
               -- Hallazgo 10: la reducida es una lista cerrada (LIVA art. 64); sin literales
               -- cargados con fuente no hay nada que elegir.
               and (c.code <> 'gravado_reducida'
                    or exists (select 1 from public.tax_reduced_rate_literals))
                 as offered_in_sales
          from public.product_tax_categories c
         where c.status = 'active'
         order by c.code`,
    );
    return c.json(filas, 200);
  });

  app.get("/v1/product-categories", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx`
        select id, name, status from public.product_categories
         where company_id = ${companyId} order by name`,
    );
    return c.json(filas, 200);
  });
}

import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql, type TransactionSql } from "@ladino/db";
import { UpdateCompanySettingsRequest } from "@ladino/schemas";
import { explicarFaltaDeTasa, getCompanySettings, setCompanySettings } from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";
import { puedeLeerDeuda } from "./ar-read.js";

/**
 * EL RESUMEN DEL NEGOCIO (Fase C): los números de Inicio y de Mi dinero, en
 * UNA respuesta y calculados TODOS en SQL `numeric` — la pantalla no suma ni
 * un céntimo. «Hoy» y «este mes» se cortan con el día de VENEZUELA: a las
 * 8 pm de Caracas la venta sigue siendo de hoy aunque el UTC diga mañana
 * (la familia de bugs de CLAUDE.md §3).
 *
 * Permiso: `treasury.read` — es la vista del dinero del negocio entero. Los dos totales de DEUDA
 * exigen además el permiso de su libro: `lo_que_me_deben` con `ar.read` y `lo_que_debo` con
 * `ap.read`; sin él van en `null` y ni se consultan (N-07/P-04, ADR-0048 nota de re-revisión).
 * Un `null` lleva SIEMPRE su motivo en `…_motivo`: `sin_permiso` o `sin_tasa` (ola 4).
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

interface TasaDelDiaFila {
  rate: string;
  rate_date: string;
  source: string;
  es_de_hoy: boolean;
  dias_de_antiguedad: number;
}

/**
 * LA TASA DEL DÍA, UNA SOLA CONSULTA para las dos lecturas que la sirven: el resumen
 * (treasury.read) y `GET /v1/negocio/tasa` (cualquier miembro de la empresa, N-05). Si cada una
 * tuviera la suya, el encargado y el dueño acabarían viendo tasas distintas.
 */
async function tasaDelDia(
  tx: TransactionSql,
  companyId: string,
  funcional: string,
): Promise<TasaDelDiaFila | null> {
  const [tasa] = await tx<TasaDelDiaFila[]>`
    select f.rate::text as rate, f.rate_date::text as rate_date, f.source,
           f.rate_date = (now() at time zone 'America/Caracas')::date as es_de_hoy,
           ((now() at time zone 'America/Caracas')::date - f.rate_date)::int
             as dias_de_antiguedad
      from platform.rate_for(${companyId}, 'USD', ${funcional}, (now() at time zone 'America/Caracas')::date + 1) f`;
  return tasa ?? null;
}

export function negocioRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
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
      // hoy). Las líneas sin costo se CUENTAN y la pantalla lo dice. La línea de un
      // COMPUESTO es la excepción: su costo es la suma de sus salidas de ingredientes.
      //
      // «LO VENDIDO», UNA SOLA DEFINICIÓN (plan «Ladino sin RIF», A1): facturas
      // + recibos + notas de débito − notas de crédito (la devolución emite su
      // nota de crédito, así que ya resta por ahí). Nunca las anuladas. Antes
      // solo contaba facturas y un negocio que vende con recibos veía Bs 0,00
      // todo el día mientras «me deben» sí subía.
      //   · margen de factura y recibo: base − costo congelado × cantidad;
      //   · nota de débito: corrige precio, no mueve mercancía → toda su base
      //     es margen;
      //   · nota de crédito: resta su base; si viene de una DEVOLUCIÓN confirmada,
      //     devuelve también el costo de lo que reingresó (al costo original de
      //     la línea vendida), porque esa mercancía ya no se vendió.
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
        docs as (
          select d.id, d.kind, (d.issued_at at time zone 'America/Caracas')::date as dia
            from public.documents d
           where d.company_id = ${companyId}
             -- El recibo de devolución (ADR-0061) resta como la nota de crédito: antes
             -- «Vendido hoy» no bajaba al devolver (QA de pantalla 2026-09-15, h. 34).
             and d.kind in ('invoice', 'receipt', 'debit_note', 'credit_note', 'receipt_return')
             and d.status in ('issued', 'paid')
             and d.issued_at >= (select mes from ventana)::timestamptz - interval '1 day'
        ),
        lineas as (
          select d.dia,
                 case when d.kind in ('credit_note', 'receipt_return') then -l.line_total_functional
                      else l.line_total_functional end as total,
                 case
                   when d.kind = 'debit_note' then l.line_subtotal_functional
                   when d.kind in ('credit_note', 'receipt_return') then -l.line_subtotal_functional
                   -- EL MISMO ORDEN que el reporte de margen (packages/domain/src/reports.ts):
                   -- primero el costo congelado de la línea; si no lo hay, lo de un compuesto.
                   when l.cost_snapshot is not null
                     then l.line_subtotal_functional - l.cost_snapshot * l.quantity
                   -- I-04 (ADR-0084): la línea de un COMPUESTO no lleva cost_snapshot; su costo
                   -- es la SUMA de lo que sacó de sus ingredientes (filas out de
                   -- sale_line_components, cada una al céntimo). Nunca un unitario por la
                   -- cantidad: 53 / 3 × 3 = 53,00000001.
                   when comp.costo is not null then l.line_subtotal_functional - comp.costo
                   -- Un SERVICIO no tiene costo de mercancía: todo lo cobrado es margen, y no
                   -- es una «venta sin costo cargado» (QA 2026-09-15, h. 20).
                   when p.kind = 'service' then l.line_subtotal_functional
                   else null
                 end as margen
            from docs d
            join public.document_lines l on l.document_id = d.id
            left join public.products p on p.id = l.product_id
            left join lateral (
              select sum(c.functional_amount) as costo
                from public.sale_line_components c
               where c.document_line_id = l.id and c.direction = 'out'
                 and d.kind in ('invoice', 'receipt')) comp on true
          union all
          -- La devolución devuelve el costo de lo que reingresó. De una línea de compuesto, la
          -- SUMA de sus reingresos (filas back de ESA devolución); de una línea suelta, como antes.
          select d.dia, 0 as total,
                 sum(case when exists (select 1 from public.sale_line_components o
                                        where o.document_line_id = ol.id and o.direction = 'out')
                          then coalesce((select sum(b.functional_amount)
                                           from public.sale_line_components b
                                          where b.return_id = r.id
                                            and b.document_line_id = ol.id
                                            and b.direction = 'back'), 0)
                          else rl.quantity * coalesce(ol.cost_snapshot, 0) end) as margen
            from docs d
            join public.returns r on r.credit_note_id = d.id and r.status = 'confirmed'
            join public.return_lines rl on rl.return_id = r.id
            join public.document_lines ol on ol.id = rl.source_line_id
           where d.kind in ('credit_note', 'receipt_return')
           group by d.id, d.dia
        )
        select
          coalesce(sum(total) filter (where dia = (select hoy from ventana)), 0)::text as vendido_hoy,
          coalesce(sum(total) filter (where dia >= (select mes from ventana)), 0)::text as vendido_mes,
          coalesce(sum(margen) filter (where dia = (select hoy from ventana)), 0)::text as ganado_hoy,
          coalesce(sum(margen) filter (where dia >= (select mes from ventana)), 0)::text as ganado_mes,
          count(*) filter (where margen is null and dia >= (select mes from ventana))::int
            as lineas_sin_costo_mes
        from lineas`;

      /**
       * LO QUE GANÉ, UN SOLO NEGOCIO (QA de pantalla 2026-09-15, h. 51 y 68). Inicio decía
       * «gané Bs 13.931» y el estado de resultados «Bs 1.924»: Inicio no restaba gastos,
       * mermas, faltantes de caja ni devoluciones. Ahora, si la empresa lleva contabilidad
       * (tiene plantillas), «lo que gané» ES el resultado del mayor en la ventana —la misma
       * suma que /v1/accounting/reports/income-statement—, y la pantalla avisa si hay hechos
       * del período todavía en cola. Sin contabilidad: el margen de lo vendido menos los
       * gastos registrados.
       */
      const [contable] = await tx<
        {
          lleva: boolean;
          res_hoy: string;
          res_mes: string;
          gastos_hoy: string;
          gastos_mes: string;
          pendientes: number;
        }[]
      >`
        with ventana as (
          select (now() at time zone 'America/Caracas')::date as hoy,
                 date_trunc('month', (now() at time zone 'America/Caracas')::date)::date as mes
        ),
        movs as (
          select e.posting_date as dia,
                 -- Ingresos suman por su haber y gastos restan por su debe: haber − debe
                 -- sobre las dos clases ES el resultado.
                 coalesce(jl.functional_credit, 0) - coalesce(jl.functional_debit, 0) as resultado
            from public.journal_entries e
            join public.journal_lines jl on jl.entry_id = e.id
            join public.accounts a on a.id = jl.account_id
           where e.company_id = ${companyId}
             and e.status in ('posted', 'reversed')
             and a.kind in ('ingreso', 'gasto')
             and e.posting_date >= (select mes from ventana)
        ),
        gastos as (
          select ((x.paid_at at time zone 'America/Caracas')::date) as dia, x.functional_amount
            from public.expenses x
           where x.company_id = ${companyId}
             and x.paid_at >= (select mes from ventana)::timestamptz - interval '1 day'
          union all
          -- H-09 (ADR-0080): el gasto CON factura fiscal es una factura de proveedor con
          -- expense_category, no una fila de expenses. Cuenta como gasto lo MISMO que su
          -- asiento debita a gasto: la base si el impuesto es crédito, el total si va al costo;
          -- y en el día en que se asienta (el de la factura, o el contable si llegó tarde).
          select coalesce(i.accounting_date, i.invoice_date) as dia,
                 round((case when i.tax_is_recoverable then i.subtotal_amount
                             else i.total_amount end) * i.fx_rate, 2)
            from public.supplier_invoices i
           where i.company_id = ${companyId}
             and i.expense_category is not null
             and i.status in ('posted', 'paid')
             and coalesce(i.accounting_date, i.invoice_date) >= (select mes from ventana)
        )
        select exists (select 1 from public.journal_templates t where t.company_id = ${companyId})
                 as lleva,
               -- P-01 (ADR-0063, ADR-0075 §7): se sirve AL CÉNTIMO. Con el mayor al céntimo la suma
               -- ya lo es; el round() cubre la historia anterior a la regularización.
               round(coalesce((select sum(resultado) from movs where dia = (select hoy from ventana)), 0), 2)::text
                 as res_hoy,
               round(coalesce((select sum(resultado) from movs), 0), 2)::text as res_mes,
               round(coalesce((select sum(functional_amount) from gastos
                          where dia = (select hoy from ventana)), 0), 2)::text as gastos_hoy,
               round(coalesce((select sum(functional_amount) from gastos
                          where dia >= (select mes from ventana)), 0), 2)::text as gastos_mes,
               (select count(*)::int from public.journal_generation_queue q
                 where q.company_id = ${companyId} and q.status = 'pending') as pendientes`;
      const llevaContabilidad = contable?.lleva === true;
      const [sinContabilidad] = await tx<{ hoy: string; mes: string }[]>`
        select round(${ventas!.ganado_hoy}::numeric - ${contable!.gastos_hoy}::numeric, 2)::text as hoy,
               round(${ventas!.ganado_mes}::numeric - ${contable!.gastos_mes}::numeric, 2)::text as mes`;

      // Lo que me deben / lo que debo: saldos que calcula el ESQUEMA, sumados
      // en SQL. Solo los positivos: un sobrepago no «resta deuda de otros».
      // REDONDEO DE PRESENTACIÓN (2026-09-08): la deuda viaja a 2 decimales —
      // es lo que una persona puede pagar. La precisión de 8 sigue viva en la
      // base y en todos los cálculos; SOLO se redondea al servir (half-up de
      // `round()` de Postgres). La regla del último centavo en registerPayment
      // garantiza que pagar lo mostrado no deja residuo fantasma.
      // La familia completa de la deuda (ADR-0051): factura, recibo fiado y
      // nota de débito — el trío, nunca un filtro a medias.
      // CADA TOTAL, SU PERMISO: «puede ver el dinero» no es «puede ver lo que deben los
      // clientes». Sin ar.read / ap.read la cifra no se calcula y viaja en null.
      const veCxc = await puedeLeerDeuda(tx, actor, companyId, "ar.read");
      const veCxp = await puedeLeerDeuda(tx, actor, companyId, "ap.read");
      const [deben] = !veCxc
        ? [null]
        : await tx<{ total: string | null }[]>`
        -- F-04 (ADR-0075 §5): la única función de deuda, sobre todos los clientes.
        select round(platform.customer_debt_today(${companyId}), 2)::text as total`;
      // EL NULL DICE SU MOTIVO (ola 4, la familia de N-05). Con permiso y sin cifra, la función
      // de deuda no pudo valorar hoy lo que está en divisa: `sin_tasa`, y lo que SÍ se conoce
      // —el nominal por moneda, de la misma `document_debt`— va aparte. La consulta del nominal
      // solo corre en ese caso.
      const debenSinTasa = veCxc && (deben?.total ?? null) === null;
      const debenPorMoneda = !debenSinTasa
        ? []
        : await tx<{ currency: string; nominal: string }[]>`
        select dd.currency,
               round(sum(dd.nominal), platform.currency_minor_units(dd.currency))::text as nominal
          from public.documents d
          cross join lateral platform.document_debt(${companyId}, d.id) dd
         where d.company_id = ${companyId}
           and d.kind in ('invoice', 'receipt', 'debit_note')
           and d.status in ('issued', 'paid')
           and dd.nominal > 0
         group by dd.currency
         order by dd.currency`;
      // LA FUNCIÓN DECIDE SI FALTA LA TASA (20261004200000). `supplier_debt_today` ya no lanza:
      // sin tasa dentro del margen devuelve NULL para lo que se debe y no se puede valorar hoy,
      // y 0 para lo que no se debe (una factura en divisa de saldo cero no necesita tasa). NULL
      // no es cero, y `sum()` y `greatest(x, 0)` lo descartarían en silencio: si alguna factura
      // quedó sin valorar, el total entero es NULL — el mismo patrón que el estado de cuenta
      // del proveedor. Aquí no hay pre-comprobación de la tasa: sería una segunda regla, y decía
      // `sin_tasa` con una factura en divisa que ya no debe nada.
      const [debo] = !veCxp
        ? [null]
        : await tx<{ total: string | null }[]>`
        select (case when bool_or(s.deuda is null) then null
                     else round(coalesce(sum(greatest(s.deuda, 0)), 0), 2) end)::text as total
          -- En bolívares: una factura de proveedor en USD se valora a la tasa del día (la
          -- misma regla que lo que me deben). Antes se sumaban saldos de monedas distintas
          -- y USD 50,112 aparecía como «Bs 50,11» (QA 2026-09-15, h. 76).
          from (select platform.supplier_debt_today(${companyId}, i.id) as deuda
                  from public.supplier_invoices i
                 where i.company_id = ${companyId} and i.status = 'posted') s`;
      const deboSinTasa = veCxp && (debo?.total ?? null) === null;
      const deboPorMoneda = !deboSinTasa
        ? []
        : await tx<{ currency: string; nominal: string }[]>`
        select s.currency,
               round(sum(s.saldo), platform.currency_minor_units(s.currency))::text as nominal
          from (select i.transaction_currency as currency,
                       platform.supplier_invoice_balance(${companyId}, i.id) as saldo
                  from public.supplier_invoices i
                 where i.company_id = ${companyId} and i.status = 'posted') s
         where s.saldo > 0
         group by s.currency
         order by s.currency`;

      const dinero = await tx<{ currency: string; balance: string }[]>`
        select ca.currency,
               -- En céntimos de cada moneda: es dinero contable a mano (ADR-0063 §4).
               round(coalesce(sum(b.balance), 0),
                     platform.currency_minor_units(ca.currency))::text as balance
          from public.company_accounts ca
          left join public.company_account_balances b on b.account_id = ca.id
         where ca.company_id = ${companyId} and ca.is_active
         group by ca.currency
         order by ca.currency`;

      const [agotarse] = await tx<{ n: number }[]>`
        select count(*)::int as n from platform.low_stock_products(${companyId})`;

      const tasa = await tasaDelDia(tx, companyId, funcional);

      const ultimas = await tx<Record<string, unknown>[]>`
        select d.id,
               to_char(d.issued_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as issued_at,
               case when cu.is_system then 'Consumidor final' else cu.legal_name end as customer_name,
               d.functional_amount::text as total_functional, d.status, d.kind
          from public.documents d
          join public.customers cu on cu.id = d.customer_id
         where d.company_id = ${companyId}
           -- Las devoluciones también se ven (h. 34): «Últimas ventas» sin ellas mentía.
           and d.kind in ('invoice', 'receipt', 'credit_note', 'receipt_return')
           and d.status in ('issued', 'paid', 'annulled')
         order by d.issued_at desc nulls last
         limit 8`;

      return {
        functional_currency: funcional,
        vendido_hoy: ventas!.vendido_hoy,
        vendido_mes: ventas!.vendido_mes,
        ganado_hoy: llevaContabilidad ? contable.res_hoy : sinContabilidad!.hoy,
        ganado_mes: llevaContabilidad ? contable.res_mes : sinContabilidad!.mes,
        ganado_desde_contabilidad: llevaContabilidad,
        pendientes_de_contabilizar: llevaContabilidad ? contable.pendientes : 0,
        lineas_sin_costo_mes: ventas!.lineas_sin_costo_mes,
        lo_que_me_deben: deben?.total ?? null,
        lo_que_me_deben_motivo: !veCxc ? "sin_permiso" : debenSinTasa ? "sin_tasa" : null,
        lo_que_me_deben_por_moneda: debenPorMoneda,
        lo_que_debo: debo?.total ?? null,
        lo_que_debo_motivo: !veCxp ? "sin_permiso" : deboSinTasa ? "sin_tasa" : null,
        lo_que_debo_por_moneda: deboPorMoneda,
        mi_dinero: dinero,
        por_agotarse: agotarse?.n ?? 0,
        tasa_del_dia: tasa,
        ultimas_ventas: ultimas,
      };
    });
    return c.json(cuerpo, 200);
  });

  /**
   * LA TASA DEL DÍA, PARA QUIEN TRABAJA EN LA EMPRESA (N-05). «Mi dinero» la leía del resumen, que
   * exige `treasury.read`: al encargado —que cierra su caja y trae la tasa, sin ver el dinero del
   * negocio— la pantalla le decía «Todavía no hay tasa BCV» habiéndola. Un 403 leído como «no hay».
   *
   * Sin permiso propio, igual que `/v1/exchange-rates` y `/v1/exchange-rates/preview`: la tasa
   * del BCV es un dato público y la caja ya la enseña a quien vende. La empresa la valida el
   * middleware de alcance (quien no es miembro recibe su 404).
   */
  app.get("/v1/negocio/tasa", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [empresa] = await tx<{ moneda: string }[]>`
        select functional_currency_code as moneda from public.companies where id = ${companyId}`;
      return { tasa_del_dia: await tasaDelDia(tx, companyId, empresa?.moneda ?? "VES") };
    });
    return c.json(cuerpo, 200);
  });

  /**
   * Conversión del SERVIDOR con la tasa vigente: la pantalla que enseña «≈ Bs.»
   * junto a un precio en dólares pregunta aquí — multiplicar en el navegador
   * sería aritmética de dinero en el cliente.
   */
  app.get("/v1/negocio/convertir", async (c) => {
    const { companyId } = requireCompany(c);
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
        select f.rate::text as rate, f.source
          from platform.rate_for(${companyId}, ${from}, ${to}, (now() at time zone 'America/Caracas')::date + 1) f`;
      if (!t?.rate) {
        throw new DominioError({
          code: "EXCHANGE_RATE_MISSING",
          // El día que se dice es HOY (la consulta mira un día más allá para alcanzar la tasa
          // publicada con fecha valor de mañana): la persona trae la de hoy.
          message: await explicarFaltaDeTasa(tx, from, to),
        });
      }
      // La equivalencia es PRESENTACIÓN: se sirve a las unidades mínimas de su moneda
      // (ADR-0063 §5). Antes salía «≈ Bs. 2.737,171775» (QA 2026-09-15, h. 12).
      const [calc] = await tx<{ converted: string }[]>`
        select round(${amount}::numeric * ${t.rate}::numeric,
                     platform.currency_minor_units(${to}))::text as converted`;
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

  // Con `Idempotency-Key` como TODAS sus hermanas mutantes (cierre del
  // 2026-09-08): era la única mutación persistente sin la llave.
  app.put("/v1/company-settings", idempotencia, async (c) => {
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

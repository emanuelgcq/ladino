import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql, type TransactionSql } from "@ladino/db";
import {
  CreateCompanyAccountRequest,
  UpdateCompanyAccountRequest,
  CreatePaymentMethodRequest,
  UpdatePaymentMethodRequest,
  RegisterExpenseRequest,
  CreateTreasuryTransferRequest,
  CloseCashRegisterRequest,
} from "@ladino/schemas";
import {
  listCompanyAccounts,
  listCandidateAccounts,
  listMoneyLandingGaps,
  createCompanyAccount,
  updateCompanyAccount,
  listPaymentMethods,
  createPaymentMethod,
  updatePaymentMethod,
  registerExpense,
  registerInvoicedExpense,
  previewInvoicedExpense,
  transferBetweenAccounts,
  closeCashRegister,
} from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";
import { subirObjeto } from "../storage.js";
import type { StorageConfig } from "../config.js";

/**
 * Rutas de TESORERÍA (Fase C, migraciones 29–31): cuentas, formas de pago,
 * gastos, cierre de caja y la confirmación diaria de la tasa. Capa delgada:
 * validar → delegar al caso de uso → mapear. Cero reglas de negocio.
 */

function coherente(header: string, body: string): void {
  if (header !== body) {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message: "El company_id del cuerpo no coincide con el del header X-Company-Id.",
    });
  }
}

async function exigePermiso(
  tx: TransactionSql,
  actor: { kind: string; userId?: string },
  companyId: string,
  permiso: string,
  quehacer: string,
): Promise<void> {
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
}

/** H-08: el comprobante de un gasto, hasta 6 MB (lo mismo que `storage.buckets.file_size_limit`). */
const COMPROBANTE_MAX_BYTES = 6 * 1024 * 1024;
/** H-08: la extensión con la que se guarda cada tipo admitido. */
const EXTENSION_DE_COMPROBANTE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/** El tipo de un comprobante leído de sus primeros bytes (la «firma» del formato), o null. */
function tipoPorContenido(b: Uint8Array): string | null {
  const empieza = (firma: readonly number[], desde = 0): boolean =>
    firma.every((x, i) => b[desde + i] === x);
  if (empieza([0x25, 0x50, 0x44, 0x46])) return "application/pdf"; // %PDF
  if (empieza([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (empieza([0xff, 0xd8, 0xff])) return "image/jpeg";
  // RIFF....WEBP
  if (empieza([0x52, 0x49, 0x46, 0x46]) && empieza([0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

export function treasuryRoutes(
  app: Hono,
  sql: Sql,
  idempotencia: MiddlewareHandler,
  storage?: StorageConfig,
): void {
  /**
   * El COMPROBANTE de un gasto: multipart al bucket privado `receipts`
   * (migración 30) con la credencial de servicio; devuelve la RUTA que luego
   * viaja en `attachment_path` de POST /v1/expenses. Foto o PDF, hasta 6 MB.
   */
  app.post("/v1/expenses/attachment", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    if (storage === undefined) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Este servidor no tiene almacenamiento de comprobantes configurado.",
      });
    }
    await withTransaction(sql, actor, ({ sql: tx }) =>
      exigePermiso(tx, actor, companyId, "expense.register", "Adjuntar un comprobante"),
    );
    // El CUERPO de esta ruta admite hasta 7 MB (`limiteComprobante`, app.ts) para que un archivo
    // de algo más de 6 MB llegue hasta aquí y reciba su mensaje (abajo), en vez del 413 sin
    // palabras de la cota general.
    const cuerpo = await c.req.parseBody();
    const archivo = cuerpo["file"];
    if (!(archivo instanceof File)) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Manda el comprobante en el campo `file` (multipart/form-data).",
      });
    }
    if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(archivo.type)) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El comprobante tiene que ser una foto (JPG, PNG, WebP) o un PDF.",
      });
    }
    // H-08: el límite que el comentario prometía y nadie comprobaba (el bucket lo repite,
    // migración 20261004170000: dos capas).
    if (archivo.size > COMPROBANTE_MAX_BYTES) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El comprobante pesa más de 6 MB. Sube una foto más liviana o un PDF más corto.",
      });
    }
    // H-08: la extensión REAL del tipo. Antes toda imagen se guardaba como «.img», que ningún
    // visor abre. La expresión de arriba ya dejó pasar solo estos cuatro tipos.
    const extension = EXTENSION_DE_COMPROBANTE[archivo.type] ?? "bin";
    // EL TIPO, POR CONTENIDO: `archivo.type` lo declara el cliente y se le creía. Los primeros
    // bytes tienen que ser los del tipo declarado; si no, no se sube nada.
    const bytes = new Uint8Array(await archivo.arrayBuffer());
    if (tipoPorContenido(bytes) !== archivo.type) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message:
          "El archivo no es lo que dice ser: su contenido no es el de una foto (JPG, PNG, WebP) ni el de un PDF.",
      });
    }
    const ruta = `${companyId}/receipts/${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
    await subirObjeto(storage, "receipts", ruta, bytes, archivo.type);
    return c.json({ attachment_path: ruta }, 201);
  });

  // ── Cuentas ───────────────────────────────────────────────────────────────
  app.get("/v1/treasury/accounts", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => listCompanyAccounts(uow, companyId));
    if (!r.ok) throw new DominioError(r.error);
    return c.json({ accounts: r.value }, 200);
  });

  /**
   * LAS CANDIDATAS (ADR-0067 §1): de qué cuentas puede salir el dinero de este instrumento, para
   * que la pantalla PREGUNTE en vez de dejar que el servidor adivine. Sin saldos: elegir la
   * cuenta no es ver el dinero.
   */
  app.get("/v1/treasury/accounts/candidates", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, async (uow) => {
      const [empresa] = await uow.sql<{ functional_currency_code: string }[]>`
        select functional_currency_code from public.companies where id = ${companyId}`;
      return listCandidateAccounts(uow, companyId, empresa?.functional_currency_code ?? "VES");
    });
    if (!r.ok) throw new DominioError(r.error);
    return c.json({ instruments: r.value }, 200);
  });

  /** El informe de dónde cayó el dinero que nadie eligió (ADR-0067 §4). Solo lectura. */
  app.get("/v1/treasury/landing-gaps", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => listMoneyLandingGaps(uow, companyId));
    if (!r.ok) throw new DominioError(r.error);
    return c.json({ items: r.value }, 200);
  });
  app.post("/v1/treasury/accounts", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateCompanyAccountRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => createCompanyAccount(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.patch("/v1/treasury/accounts/:id", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = UpdateCompanyAccountRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const id = c.req.param("id");
    const r = await withTransaction(sql, actor, (uow) =>
      updateCompanyAccount(uow, id, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  // ── Formas de pago ────────────────────────────────────────────────────────
  app.get("/v1/payment-methods", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => listPaymentMethods(uow, companyId));
    if (!r.ok) throw new DominioError(r.error);
    return c.json({ methods: r.value }, 200);
  });

  app.post("/v1/payment-methods", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreatePaymentMethodRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => createPaymentMethod(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.patch("/v1/payment-methods/:id", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = UpdatePaymentMethodRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const id = c.req.param("id");
    const r = await withTransaction(sql, actor, (uow) => updatePaymentMethod(uow, id, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  // ── Gastos ────────────────────────────────────────────────────────────────
  app.post("/v1/expenses", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = RegisterExpenseRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    // H-09: con factura fiscal el gasto es una compra de servicio y va por compras (libro,
    // crédito fiscal, retención); sin ella, el gasto llano de siempre.
    const r = await withTransaction(sql, actor, (uow) =>
      parsed.data.invoice === undefined
        ? registerExpense(uow, parsed.data)
        : registerInvoicedExpense(uow, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  /**
   * La vista previa del gasto con factura (H-09): el MISMO caso de uso, deshecho al terminar.
   * Sin idempotencia: no crea nada (como `/v1/arrivals/preview`).
   */
  app.post("/v1/expenses/preview", async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = RegisterExpenseRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => previewInvoicedExpense(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  app.get("/v1/expenses", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const desde = c.req.query("from") ?? null;
    const hasta = c.req.query("to") ?? null;
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 50) || 50, 1), 200);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigePermiso(tx, actor, companyId, "expense.read", "Ver los gastos");
      // H-09: el gasto CON factura fiscal es una factura de proveedor (`expense_category`), no
      // una fila de `expenses`. El historial es uno solo: quien registró «Luz» la busca aquí.
      // De la factura se enseña lo que salió de la cuenta (su pago), no su total.
      const gastos = tx`
        select e.id, e.category, e.description, e.paid_at as pagado, e.account_id,
               e.amount_transaction_currency as importe, e.transaction_currency as moneda,
               e.functional_amount as funcional, e.functional_currency, e.fx_rate,
               e.is_recurring, e.supplier_id, e.branch_id, e.attachment_path,
               e.journal_entry_id, null::uuid as supplier_invoice_id
          from public.expenses e
         where e.company_id = ${companyId}
        union all
        select i.id, i.expense_category, i.notes, coalesce(p.paid_at, i.posted_at), p.account_id,
               coalesce(p.net_amount, 0), coalesce(p.transaction_currency, i.transaction_currency),
               coalesce(p.functional_amount, 0), i.functional_currency,
               coalesce(p.fx_rate, i.fx_rate), i.expense_is_recurring, i.supplier_id,
               null::uuid, i.expense_attachment_path, i.journal_entry_id, i.id
          from public.supplier_invoices i
          left join lateral (
            select sp.paid_at, sp.account_id, sp.net_amount, sp.transaction_currency,
                   sp.functional_amount, sp.fx_rate
              from public.supplier_payments sp
             where sp.supplier_invoice_id = i.id
             -- El más reciente: la MISMA regla que la respuesta del registro.
             order by sp.created_at desc, sp.id desc limit 1) p on true
         where i.company_id = ${companyId} and i.expense_category is not null
           and i.status in ('posted', 'paid')`;
      const filas = await tx<Record<string, unknown>[]>`
        select g.id, g.category, g.description,
               to_char(g.pagado at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as paid_at,
               g.account_id, g.importe::numeric(24,8)::text as amount, g.moneda as currency,
               g.funcional::numeric(24,8)::text as functional_amount, g.functional_currency,
               g.fx_rate::text as fx_rate, g.is_recurring, g.supplier_id, g.branch_id,
               g.attachment_path, g.journal_entry_id, g.supplier_invoice_id,
               count(*) over ()::int as total
          from (${gastos}) g
         where (${desde}::date is null or (g.pagado at time zone ${"America/Caracas"})::date >= ${desde}::date)
           and (${hasta}::date is null or (g.pagado at time zone ${"America/Caracas"})::date <= ${hasta}::date)
         order by g.pagado desc
         limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
      let total = (filas[0]?.["total"] as number | undefined) ?? null;
      if (total === null) {
        // Página vacía (o más allá del final): el total se cuenta aparte.
        const [n] = await tx<{ n: number }[]>`
          select count(*)::int as n from (${gastos}) g
           where (${desde}::date is null or (g.pagado at time zone ${"America/Caracas"})::date >= ${desde}::date)
             and (${hasta}::date is null or (g.pagado at time zone ${"America/Caracas"})::date <= ${hasta}::date)`;
        total = n?.n ?? 0;
      }
      return { items: filas.map(({ total: _t, ...f }) => f), total };
    });
    return c.json(cuerpo, 200);
  });

  // ── Cierre de caja ────────────────────────────────────────────────────────
  app.post("/v1/cash-closings", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CloseCashRegisterRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => closeCashRegister(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.get("/v1/cash-closings", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 50) || 50, 1), 200);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigePermiso(tx, actor, companyId, "treasury.read", "Ver los cierres");
      const filas = await tx<Record<string, unknown>[]>`
        select cc.id, cc.account_id, cc.closing_date::text as closing_date,
               to_char(cc.closed_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as closed_at,
               round(cc.expected_amount,
                     platform.currency_minor_units(cc.transaction_currency))::text
                 as expected_amount,
               round(cc.counted_amount,
                     platform.currency_minor_units(cc.transaction_currency))::text
                 as counted_amount,
               round(cc.amount_transaction_currency,
                     platform.currency_minor_units(cc.transaction_currency))::text as difference,
               -- J-02: lo que llevó la caja de negativo a cero (dinero del dueño). Solo si el
               -- cierre TIENE su asiento vigente, o su fila de cola, del origen del sobregiro: un
               -- cierre viejo sin reclasificar sigue en resultado y la pantalla no dice otra cosa.
               case when exists (select 1 from public.journal_entries je
                                  where je.company_id = cc.company_id and je.source_id = cc.id
                                    and je.source_kind = 'cash_closing_overdraft'
                                    and je.status = 'posted')
                      or exists (select 1 from public.journal_generation_queue q
                                  where q.company_id = cc.company_id and q.source_id = cc.id
                                    and q.source_kind = 'cash_closing_overdraft'
                                    and q.status = 'pending')
                    then round(-cc.expected_amount,
                               platform.currency_minor_units(cc.transaction_currency))::text
               end as owner_contribution,
               cc.reason,
               cc.transaction_currency as currency, cc.journal_entry_id
          from public.cash_closings cc
         where cc.company_id = ${companyId}
         order by cc.closed_at desc
         limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
      const [total] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.cash_closings where company_id = ${companyId}`;
      return { items: filas, total: total?.n ?? 0 };
    });
    return c.json(cuerpo, 200);
  });

  // ── «La tasa sigue igual» ─────────────────────────────────────────────────
  // Ya no se confirma a mano (ADR-0064 §1): un día sin publicación rige la última tasa del
  // BCV, sin copiarla. La ruta se conserva para responder un motivo a un cliente viejo.
  app.post("/v1/exchange-rates/keep", idempotencia, (c) => {
    requireCompany(c);
    throw new DominioError({
      code: "RATE_ONLY_FROM_BCV",
      message:
        "La tasa ya no se confirma a mano: si el BCV no publicó hoy, rige su última tasa. Para actualizarla usa «Traer del BCV».",
    });
  });

  /**
   * Mover dinero entre dos cuentas de la empresa (ADR-0062 §3): repartir lo que entró en
   * «Sin asignar», llevar el efectivo al banco. Exige `treasury.reassign`.
   */
  app.post("/v1/treasury/transfers", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateTreasuryTransferRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => transferBetweenAccounts(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });
}

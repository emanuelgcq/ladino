import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql } from "@ladino/db";
import type {
  CorrectRetentionVoucherRequest,
  DeliverRetentionVoucherRequest,
  RetentionVoucherResponse,
  SetRetentionVoucherModeRequest,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";

/**
 * EL COMPROBANTE DE RETENCIÓN DE IVA COMO DOCUMENTO (ADR-0072 §4, H-04) — RIGOR MÁXIMO.
 *
 * PA SNAT/2025/000054 art. 16 (REGULATORY_STATUS.md, reproducción verificada): número `AAAAMM` +
 * secuencial de 8 dígitos por empresa; agente, proveedor, factura con número y control, total,
 * base, IVA causado e IVA retenido; uno por operación o uno por período y proveedor; se entrega
 * dentro de los 2 días hábiles siguientes a la quincena.
 *
 * Se EMITE al practicar la retención, que con el criterio R-3 (ADR-0065 §3, ratificado el
 * 2026-09-28) es al REGISTRAR la factura. Por eso `emitirComprobanteDeRetencion` corre dentro del
 * savepoint de `registerSupplierInvoice`: una factura sin su comprobante no existe.
 *
 * El documento es append-only: la entrega se anota una vez, y corregirlo emite una versión nueva
 * que reemplaza a la anterior. La versión reemplazada es la anulada; no hay UPDATE de estado.
 */
export type RetentionVoucherError =
  | CompanyScopeError
  | { code: "VALIDATION_FAILED"; message: string }
  | { code: "NOT_FOUND"; message: string }
  | { code: "PERMISSION_REQUIRED"; message: string };

/**
 * Emite (o amplía, en el modo por quincena) el comprobante de las retenciones de IVA de una
 * factura que aún no tienen uno. Devuelve el id del comprobante, o null si no hay nada que
 * documentar (sin retención de IVA, o retenido cero por regla explícita).
 *
 * La identidad del agente y del proveedor se CONGELA aquí (4-bis): el proveedor como lo registró
 * la factura (snapshot, o maestro si es anterior al snapshot) y su domicilio de hoy.
 */
export async function emitirComprobanteDeRetencion(
  sql: TransactionSql,
  d: {
    tenantId: string;
    companyId: string;
    supplierId: string;
    invoiceId: string;
    functionalCurrency: string;
  },
): Promise<string | null> {
  const [pendiente] = await sql<{ n: number }[]>`
    select count(*)::int as n
      from public.supplier_retentions r
     where r.supplier_invoice_id = ${d.invoiceId} and r.retention_code = 'iva'
       and r.status <> 'cancelled' and r.retained_amount > 0
       and not exists (select 1 from public.retention_voucher_lines x
                        where x.supplier_retention_id = r.id)`;
  if ((pendiente?.n ?? 0) === 0) return null;

  // H5/H6: el MISMO candado de asesoramiento que toma el secuencial, ANTES de buscar o crear
  // nada. Un `FOR UPDATE` sobre un comprobante que todavía no existe no bloquea a nadie: dos
  // registros a la vez de la misma quincena abrirían dos comprobantes. El candado es por empresa y
  // reentrante dentro de la transacción (`claim_retention_voucher_sequence` lo vuelve a pedir).
  await sql`select pg_advisory_xact_lock(
              hashtextextended('ladino.retention_voucher:' || ${d.companyId}::text, 0))`;

  // El día de la EMISIÓN es hoy en Caracas (la granularidad es el día: CLAUDE.md §3).
  const [dia] = await sql<
    { hoy: string; desde: string; hasta: string; vence: string; periodo: string; modo: string }[]
  >`
    select h.d::text as hoy, q.fortnight_start::text as desde, q.fortnight_end::text as hasta,
           platform.retention_voucher_due_on(q.fortnight_end)::text as vence,
           to_char(h.d, 'YYYYMM') as periodo,
           coalesce((select s.retention_voucher_mode from public.purchase_settings s
                      where s.company_id = ${d.companyId}), 'per_operation') as modo
      from (select (now() at time zone 'America/Caracas')::date as d) h
     cross join lateral platform.retention_fortnight(h.d) q`;
  const hoy = dia!;

  let comprobanteId: string | null = null;
  if (hoy.modo === "per_fortnight") {
    // El de la quincena y el proveedor, si sigue sin entregar y vigente. Lo que serializa a dos
    // registros a la vez es el candado de arriba; el FOR UPDATE bloquea además una entrega
    // concurrente del mismo comprobante (la entrega toma la fila con FOR UPDATE).
    const [abierto] = await sql<{ id: string }[]>`
      select v.id from public.retention_vouchers v
       where v.company_id = ${d.companyId} and v.supplier_id = ${d.supplierId}
         and v.mode = 'per_fortnight' and v.fortnight_start = ${hoy.desde}::date
         and v.delivered_on is null
         -- A-1: el abierto nunca es una CORRECCIÓN. Una retención nueva añadida a la versión 2 de
         -- un comprobante de un período anterior heredaría su «ya declarada» (P-65).
         and v.replaces_voucher_id is null
         and not exists (select 1 from public.retention_vouchers n
                          where n.replaces_voucher_id = v.id)
       order by v.sequence desc
       limit 1
       for update`;
    comprobanteId = abierto?.id ?? null;
  }

  if (comprobanteId === null) {
    const [sec] = await sql<{ n: string }[]>`
      select platform.claim_retention_voucher_sequence(${d.companyId})::text as n`;
    const [v] = await sql<{ id: string }[]>`
      insert into public.retention_vouchers
        (tenant_id, company_id, supplier_id, voucher_period, sequence, mode, issued_on,
         fortnight_start, fortnight_end, delivery_due_on, agent_tax_id, agent_name, agent_address,
         supplier_tax_id, supplier_name, supplier_address, functional_currency, rules_version)
      select ${d.tenantId}, ${d.companyId}, ${d.supplierId}, ${hoy.periodo}, ${sec!.n}::bigint,
             ${hoy.modo}, ${hoy.hoy}::date, ${hoy.desde}::date, ${hoy.hasta}::date,
             ${hoy.vence}::date, c.tax_id, c.legal_name, c.fiscal_address,
             case when i.supplier_name_snapshot is not null then i.supplier_tax_id_snapshot
                  else s.tax_id end,
             coalesce(i.supplier_name_snapshot, s.legal_name), s.fiscal_address,
             ${d.functionalCurrency}, ${RULES_VERSION}
        from public.supplier_invoices i
        join public.companies c on c.id = i.company_id
        join public.suppliers s on s.id = i.supplier_id
       where i.id = ${d.invoiceId} and i.company_id = ${d.companyId}
      returning id`;
    comprobanteId = v!.id;
  }

  await sql`
    insert into public.retention_voucher_lines
      (tenant_id, company_id, retention_voucher_id, supplier_invoice_id, supplier_retention_id,
       document_type, document_number, control_number, document_date, affected_document,
       total_amount, taxable_base, exempt_amount, iva_amount, tax_rate, portion, retained_amount)
    select i.tenant_id, i.company_id, ${comprobanteId}, i.id, r.id, '01',
           i.supplier_document_number, i.supplier_control_number, i.invoice_date, null,
           m.total_amount, m.taxable_base, m.exempt_amount, m.iva_amount, m.tax_rate,
           r.rate_snapshot, r.retained_amount
      from public.supplier_invoices i
      join public.supplier_retentions r on r.supplier_invoice_id = i.id
     cross join lateral platform.retention_invoice_amounts(i.id) m
     where i.id = ${d.invoiceId} and r.retention_code = 'iva' and r.status <> 'cancelled'
       and r.retained_amount > 0
       and not exists (select 1 from public.retention_voucher_lines x
                        where x.supplier_retention_id = r.id)`;
  return comprobanteId;
}

/** Lee un comprobante con sus renglones y su estado derivado. */
export async function leerComprobante(
  sql: TransactionSql,
  companyId: string,
  voucherId: string,
): Promise<RetentionVoucherResponse | null> {
  const [v] = await sql<Record<string, unknown>[]>`
    select v.id, v.company_id, v.supplier_id, v.voucher_number, v.version_no,
           v.replaces_voucher_id, v.correction_reason, v.mode, v.issued_on::text as issued_on,
           v.fortnight_start::text as fortnight_start, v.fortnight_end::text as fortnight_end,
           v.delivery_due_on::text as delivery_due_on, v.delivered_on::text as delivered_on,
           (select n.id from public.retention_vouchers n where n.replaces_voucher_id = v.id)
             as replaced_by_voucher_id,
           case when exists (select 1 from public.retention_vouchers n
                              where n.replaces_voucher_id = v.id)
                then 'annulled' else 'issued' end as status,
           v.agent_tax_id, v.agent_name, v.agent_address, v.supplier_tax_id, v.supplier_name,
           v.supplier_address, v.functional_currency,
           (select coalesce(sum(l.retained_amount), 0) from public.retention_voucher_lines l
             where l.retention_voucher_id = v.id)::text as total_retained
      from public.retention_vouchers v
     where v.id = ${voucherId} and v.company_id = ${companyId}`;
  if (!v) return null;
  const lineas = await sql<Record<string, unknown>[]>`
    select supplier_invoice_id, supplier_retention_id, document_type, document_number,
           control_number, document_date::text as document_date, affected_document,
           total_amount::text as total_amount, taxable_base::text as taxable_base,
           exempt_amount::text as exempt_amount, iva_amount::text as iva_amount,
           tax_rate::text as tax_rate, portion::text as portion,
           retained_amount::text as retained_amount
      from public.retention_voucher_lines
     where retention_voucher_id = ${voucherId}
     order by document_date, document_number, id`;
  return { ...v, lines: lineas } as unknown as RetentionVoucherResponse;
}

async function exigir(
  sql: TransactionSql,
  userId: string,
  companyId: string,
  permiso: string,
): Promise<Result<{ tenantId: string }, RetentionVoucherError>> {
  const scope = await companyScope(sql, userId, companyId, permiso);
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  return ok({ tenantId: scope.value.tenantId });
}

async function auditar(
  sql: TransactionSql,
  tenantId: string,
  companyId: string,
  aggregateId: string,
  evento: string,
  payload: Record<string, string | number | null>,
): Promise<void> {
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${companyId}, 'retention_voucher', ${aggregateId}, ${evento},
            'user', now(), ${RULES_VERSION}, ${sql.json(payload)})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${tenantId}, ${companyId}, 'retention_voucher', ${aggregateId}, ${evento}, 1,
            ${sql.json({ id: aggregateId, ...payload })})`;
}

/**
 * CORREGIR un comprobante (ADR-0072 §4): emite una VERSIÓN NUEVA, con número nuevo, que
 * reemplaza a la anterior; la anterior queda anulada por el reemplazo, sin UPDATE. Los importes
 * se copian (salen de la factura, que es inmutable); la identidad del agente y del proveedor se
 * vuelve a leer del maestro, que es lo que una corrección viene a arreglar.
 */
export async function correctRetentionVoucher(
  uow: UnitOfWork,
  voucherId: string,
  input: CorrectRetentionVoucherRequest,
): Promise<Result<RetentionVoucherResponse, RetentionVoucherError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Corregir exige un usuario real." });
  }
  const ctx = await exigir(sql, actor.userId, input.company_id, "retention.receipt.issue");
  if (!ctx.ok) return ctx;
  // H6: el candado de la empresa ANTES de mirar si ya hay reemplazo: dos correcciones a la vez de
  // la misma versión se serializan aquí, y la segunda ve la primera (el único de
  // `replaces_voucher_id` es la red debajo).
  await sql`select pg_advisory_xact_lock(
              hashtextextended('ladino.retention_voucher:' || ${input.company_id}::text, 0))`;

  const [viejo] = await sql<{ id: string; version_no: number; supplier_id: string }[]>`
    select id, version_no, supplier_id from public.retention_vouchers
     where id = ${voucherId} and company_id = ${input.company_id}
     for update`;
  if (!viejo) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  const [reemplazo] = await sql<{ voucher_number: string }[]>`
    select voucher_number from public.retention_vouchers where replaces_voucher_id = ${voucherId}`;
  if (reemplazo) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Ese comprobante ya fue corregido por el ${reemplazo.voucher_number}: corrige el vigente.`,
    });
  }

  const [sec] = await sql<{ n: string }[]>`
    select platform.claim_retention_voucher_sequence(${input.company_id})::text as n`;
  const [nuevo] = await sql<{ id: string }[]>`
    insert into public.retention_vouchers
      (tenant_id, company_id, supplier_id, voucher_period, sequence, mode, issued_on,
       fortnight_start, fortnight_end, delivery_due_on, agent_tax_id, agent_name, agent_address,
       supplier_tax_id, supplier_name, supplier_address, version_no, replaces_voucher_id,
       correction_reason, functional_currency, rules_version)
    select v.tenant_id, v.company_id, v.supplier_id, to_char(h.d, 'YYYYMM'), ${sec!.n}::bigint,
           v.mode, h.d, q.fortnight_start, q.fortnight_end,
           platform.retention_voucher_due_on(q.fortnight_end),
           c.tax_id, c.legal_name, c.fiscal_address,
           coalesce(s.tax_id, v.supplier_tax_id), s.legal_name, s.fiscal_address,
           v.version_no + 1, v.id, ${input.reason}, v.functional_currency, ${RULES_VERSION}
      from public.retention_vouchers v
      join public.companies c on c.id = v.company_id
      join public.suppliers s on s.id = v.supplier_id
     cross join (select (now() at time zone 'America/Caracas')::date as d) h
     cross join lateral platform.retention_fortnight(h.d) q
     where v.id = ${voucherId}
    returning id`;
  await sql`
    insert into public.retention_voucher_lines
      (tenant_id, company_id, retention_voucher_id, supplier_invoice_id, supplier_retention_id,
       document_type, document_number, control_number, document_date, affected_document,
       total_amount, taxable_base, exempt_amount, iva_amount, tax_rate, portion, retained_amount)
    select l.tenant_id, l.company_id, ${nuevo!.id}, l.supplier_invoice_id,
           l.supplier_retention_id, l.document_type, l.document_number, l.control_number,
           l.document_date, l.affected_document, l.total_amount, l.taxable_base,
           l.exempt_amount, l.iva_amount, l.tax_rate, l.portion, l.retained_amount
      from public.retention_voucher_lines l
     where l.retention_voucher_id = ${voucherId}`;

  const leido = await leerComprobante(sql, input.company_id, nuevo!.id);
  await auditar(
    sql,
    ctx.value.tenantId,
    input.company_id,
    nuevo!.id,
    "ap.retention_voucher_corrected",
    {
      replaces_voucher_id: voucherId,
      voucher_number: leido?.voucher_number ?? null,
      version_no: viejo.version_no + 1,
      reason: input.reason,
    },
  );
  return ok(leido!);
}

/** Anota la ENTREGA del comprobante al proveedor, una sola vez. */
export async function deliverRetentionVoucher(
  uow: UnitOfWork,
  voucherId: string,
  input: DeliverRetentionVoucherRequest,
): Promise<Result<RetentionVoucherResponse, RetentionVoucherError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Entregar exige un usuario real." });
  }
  const ctx = await exigir(sql, actor.userId, input.company_id, "retention.receipt.issue");
  if (!ctx.ok) return ctx;
  const [v] = await sql<
    { issued_on: string; delivered_on: string | null; hoy: string; reemplazo: string | null }[]
  >`
    select issued_on::text as issued_on, delivered_on::text as delivered_on,
           (now() at time zone 'America/Caracas')::date::text as hoy,
           (select n.voucher_number from public.retention_vouchers n
             where n.replaces_voucher_id = retention_vouchers.id) as reemplazo
      from public.retention_vouchers
     where id = ${voucherId} and company_id = ${input.company_id}
     for update`;
  if (!v) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (v.reemplazo !== null) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Esta versión está anulada: la reemplazó el comprobante ${v.reemplazo}. Anota la entrega en el vigente.`,
    });
  }
  if (input.delivered_on > v.hoy) {
    return err({
      code: "VALIDATION_FAILED",
      message: `La entrega no puede ser en el futuro: hoy es ${v.hoy} en Venezuela. Anótala el día que la entregues.`,
    });
  }
  if (v.delivered_on !== null) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Ese comprobante ya se entregó el ${v.delivered_on}: la entrega se anota una vez.`,
    });
  }
  if (input.delivered_on < v.issued_on) {
    return err({
      code: "VALIDATION_FAILED",
      message: `No se entrega antes de emitirse: el comprobante es del ${v.issued_on}.`,
    });
  }
  await sql`
    update public.retention_vouchers
       set delivered_on = ${input.delivered_on}::date, delivered_by = ${actor.userId}
     where id = ${voucherId} and company_id = ${input.company_id}`;
  await auditar(
    sql,
    ctx.value.tenantId,
    input.company_id,
    voucherId,
    "ap.retention_voucher_delivered",
    {
      delivered_on: input.delivered_on,
    },
  );
  return ok((await leerComprobante(sql, input.company_id, voucherId))!);
}

/** Uno por operación (omisión) o uno por quincena y proveedor (art. 16). */
export async function setRetentionVoucherMode(
  uow: UnitOfWork,
  input: SetRetentionVoucherModeRequest,
): Promise<Result<{ company_id: string; mode: string }, RetentionVoucherError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Configurar exige un usuario real." });
  }
  const ctx = await exigir(sql, actor.userId, input.company_id, "company.settings.manage");
  if (!ctx.ok) return ctx;
  await sql`
    insert into public.purchase_settings (company_id, tenant_id, retention_voucher_mode)
    values (${input.company_id}, ${ctx.value.tenantId}, ${input.mode})
    on conflict (company_id) do update set retention_voucher_mode = excluded.retention_voucher_mode`;
  await auditar(
    sql,
    ctx.value.tenantId,
    input.company_id,
    input.company_id,
    "ap.retention_voucher_mode_set",
    {
      mode: input.mode,
    },
  );
  return ok({ company_id: input.company_id, mode: input.mode });
}

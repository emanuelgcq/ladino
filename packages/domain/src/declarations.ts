import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, JSONValue } from "@ladino/db";
import type {
  GenerateIvaPeriodRequest,
  IvaPeriodResultResponse,
  LoadFiscalDeadlinesRequest,
  FiscalDeadlineResponse,
  RegisterSupportedRetentionRequest,
  RegisterSupportedRetentionResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import { registerPayment, type SalesError } from "./sales.js";

/**
 * DECLARACIONES DE IVA (migración 46) — RIGOR MÁXIMO.
 *
 * Tres casos de uso:
 *   · registrar una retención SOPORTADA (el comprobante que un cliente-agente
 *     nos entregó) y abonar la factura afectada en el MISMO acto;
 *   · generar el RESULTADO de un período con su arrastre ENCADENADO — el
 *     excedente anterior sale de la última generación del período contiguo,
 *     nunca de un número tecleado (por eso los períodos en cero también se
 *     generan: mantienen viva la cadena);
 *   · cargar el CALENDARIO de vencimientos como dato con fuente citada (H-4:
 *     las fechas por dígito de RIF no se inventan).
 *
 * Nada de lo que este módulo produce es una declaración oficial: la fila del
 * período es la planilla DEMOSTRATIVA, reproducible por su hash, con la que
 * el contribuyente (o su contador) llena el portal del SENIAT a mano.
 */
export type DeclarationsError =
  | CompanyScopeError
  | SalesError
  | { code: "VALIDATION_FAILED"; message: string }
  | { code: "DUPLICATE"; message: string };

/** La versión del generador, persistida en cada fila del período. */
export const IVA_PERIOD_GENERATOR_VERSION = "iva-declarations/1.0.0";

/**
 * Registra el comprobante de retención soportada Y abona la factura afectada
 * con el instrumento `retencion_iva` — un solo acto, una sola transacción.
 * Todo se TRANSCRIBE del papel del agente: base, porción y monto. La única
 * aritmética que se exige es la del propio comprobante (monto ≈ base × 0.16 ×
 * porción NO se comprueba aquí: la alícuota de la factura vive en sus líneas
 * y el comprobante puede agrupar varias; lo que sí es innegociable es que el
 * abono sea EXACTAMENTE el monto retenido, y eso lo exige registerPayment).
 */
export async function registerSupportedRetention(
  uow: UnitOfWork,
  input: RegisterSupportedRetentionRequest,
): Promise<Result<RegisterSupportedRetentionResponse, DeclarationsError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Registrar una retención soportada exige un usuario real.",
    });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "sales.payment.register");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }

  // La factura afectada: nuestra, del agente que retiene, y viva. El estado
  // `issued` lo re-exige registerPayment; aquí se valida lo que él no mira —
  // que el CLIENTE del comprobante sea el de la factura.
  const [doc] = await sql<{ customer_id: string; kind: string; functional_currency: string }[]>`
    select customer_id, kind, functional_currency from public.documents
     where id = ${input.document_id} and company_id = ${input.company_id}`;
  if (!doc) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (doc.customer_id !== input.customer_id) {
    return err({
      code: "VALIDATION_FAILED",
      message: "El agente del comprobante no es el cliente de esa factura.",
    });
  }
  if (doc.kind !== "invoice" && doc.kind !== "debit_note") {
    return err({
      code: "VALIDATION_FAILED",
      message: "Una retención de IVA afecta a una factura o nota de débito, no a otro documento.",
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  let comprobante;
  try {
    comprobante = await sql.savepoint(async (sp) => {
      const [fila] = await sp<Record<string, unknown>[]>`
        insert into public.supported_retention_receipts
          (tenant_id, company_id, customer_id, document_id, receipt_number, retained_on,
           base, rate, amount, functional_currency)
        values (${scope.value.tenantId}, ${input.company_id}, ${input.customer_id},
                ${input.document_id}, ${input.receipt_number}, ${input.retained_on}::date,
                ${input.base}, ${input.rate}, ${input.amount}, ${doc.functional_currency})
        returning id, customer_id, document_id, receipt_number, retained_on::text as retained_on,
                  base::text as base, rate::text as rate, amount::text as amount,
                  functional_currency, status, annul_reason,
                  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                    as created_at`;
      return fila!;
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") {
      return err({
        code: "DUPLICATE",
        message: `El comprobante ${input.receipt_number} de ese agente ya está registrado.`,
      });
    }
    if (code === "23514") {
      return err({
        code: "VALIDATION_FAILED",
        message: "El comprobante no pasa las reglas de forma (base, porción y monto positivos).",
      });
    }
    throw e;
  }

  // El abono, por el MISMO camino que cualquier cobro: registerPayment valida
  // el estado de la factura, exige el monto exacto del comprobante, registra
  // el diferencial cambiario si la factura vive en divisa, audita con
  // 'ar.retention_applied' y genera su asiento (Dr IVA retenido por cobrar /
  // Cr cuentas por cobrar). Un segundo camino que escribiera payments a mano
  // acabaría divergiendo de este.
  const pago = await registerPayment(uow, {
    company_id: input.company_id,
    document_id: input.document_id,
    currency: doc.functional_currency,
    amount: input.amount,
    instrument: "retencion_iva",
    reference: input.receipt_number,
    supported_retention_id: comprobante["id"] as string,
  });
  if (!pago.ok) return pago;

  return ok({
    retention: comprobante as never,
    payment: pago.value,
  });
}

/**
 * Genera el resultado de UN período de IVA y lo deja como fila insert-only
 * con su hash (patrón fiscal_book_runs: la sustitutiva es OTRA generación).
 *
 * EL ARRASTRE ES UNA CADENA: el excedente anterior sale de la última
 * generación del período que termina EXACTAMENTE el día antes. Si hay
 * historia previa sin generar, se exige generarla primero — un excedente
 * anterior puesto a cero en silencio produce una cuota falsa sin avisar,
 * que es exactamente la clase de error que este módulo existe para impedir.
 */
export async function generateIvaPeriod(
  uow: UnitOfWork,
  input: GenerateIvaPeriodRequest,
): Promise<Result<IvaPeriodResultResponse, DeclarationsError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Generar el período exige un usuario real: la generación se firma con nombre.",
    });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "fiscal_book.export");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  if (input.period_to < input.period_from) {
    return err({ code: "VALIDATION_FAILED", message: "El período termina antes de empezar." });
  }

  // El eslabón anterior de la cadena.
  const [anterior] = await sql<{ excedente: string }[]>`
    select excedente_siguiente::text as excedente
      from public.iva_period_results
     where company_id = ${input.company_id}
       and period_to = (${input.period_from}::date - 1)
     order by created_at desc, id desc limit 1`;
  let excedenteAnterior = "0";
  if (anterior) {
    excedenteAnterior = anterior.excedente;
  } else {
    // ¿Hay historia ANTES de este período? Ventas, compras, retenciones o un
    // resultado ya generado que no empalma: cualquiera de las cuatro obliga a
    // generar primero el período anterior. La zona horaria de la emisión es
    // la misma que usa el cálculo (America/Caracas, migración 46).
    const [historia] = await sql<{ hay: boolean }[]>`
      select exists (
        select 1 from public.documents d
         where d.company_id = ${input.company_id}
           and d.kind in ('invoice', 'credit_note', 'debit_note')
           and d.status in ('issued', 'paid')
           and (d.issued_at at time zone 'America/Caracas')::date < ${input.period_from}::date
      ) or exists (
        select 1 from public.supplier_invoices i
         where i.company_id = ${input.company_id}
           and i.status in ('posted', 'paid')
           and i.invoice_date < ${input.period_from}::date
      ) or exists (
        select 1 from public.supported_retention_receipts r
         where r.company_id = ${input.company_id}
           and r.retained_on < ${input.period_from}::date
      ) or exists (
        select 1 from public.iva_period_results p
         where p.company_id = ${input.company_id}
           and p.period_to < ${input.period_from}::date
      ) as hay`;
    if (historia?.hay) {
      return err({
        code: "VALIDATION_FAILED",
        message:
          `El arrastre viene encadenado: genera primero el período que termina el día antes ` +
          `de ${input.period_from} (los períodos sin actividad también se generan — en cero).`,
      });
    }
  }

  const [r] = await sql<
    {
      debitos: string;
      creditos: string;
      creditos_deducibles: string;
      prorrata_pct: string | null;
      retenciones_soportadas: string;
      cuota_a_pagar: string;
      excedente_siguiente: string;
      detalle: unknown;
    }[]
  >`select debitos::text as debitos, creditos::text as creditos,
           creditos_deducibles::text as creditos_deducibles,
           prorrata_pct::text as prorrata_pct,
           retenciones_soportadas::text as retenciones_soportadas,
           cuota_a_pagar::text as cuota_a_pagar,
           excedente_siguiente::text as excedente_siguiente, detalle
      from platform.recompute_iva_period(
             ${input.company_id}, ${input.period_from}::date, ${input.period_to}::date,
             ${excedenteAnterior})`;
  if (!r) {
    return err({ code: "VALIDATION_FAILED", message: "El cálculo del período no devolvió filas." });
  }

  // El hash firma EXACTAMENTE lo que se persiste, con las claves en orden
  // fijo: dos generaciones del mismo período con los mismos datos dan el
  // mismo hash, y una distinta dice que algo cambió entre medias.
  const canonico = JSON.stringify({
    period_from: input.period_from,
    period_to: input.period_to,
    excedente_anterior: excedenteAnterior,
    debitos: r.debitos,
    creditos: r.creditos,
    creditos_deducibles: r.creditos_deducibles,
    prorrata_pct: r.prorrata_pct,
    retenciones_soportadas: r.retenciones_soportadas,
    cuota_a_pagar: r.cuota_a_pagar,
    excedente_siguiente: r.excedente_siguiente,
    detalle: r.detalle,
    generator_version: IVA_PERIOD_GENERATOR_VERSION,
  });
  const [h] = await sql<{ hash: string }[]>`
    select encode(sha256(convert_to(${canonico}, 'utf8')), 'hex') as hash`;

  const [fila] = await sql<Record<string, unknown>[]>`
    insert into public.iva_period_results
      (tenant_id, company_id, period_from, period_to, debitos, creditos, creditos_deducibles,
       prorrata_pct, retenciones_soportadas, excedente_anterior, cuota_a_pagar,
       excedente_siguiente, detalle, generator_version, dataset_hash)
    values (${scope.value.tenantId}, ${input.company_id}, ${input.period_from}::date,
            ${input.period_to}::date, ${r.debitos}, ${r.creditos}, ${r.creditos_deducibles},
            ${r.prorrata_pct}, ${r.retenciones_soportadas}, ${excedenteAnterior},
            ${r.cuota_a_pagar}, ${r.excedente_siguiente},
            ${sql.json(r.detalle as JSONValue)}, ${IVA_PERIOD_GENERATOR_VERSION},
            ${h!.hash})
    returning id, period_from::text as period_from, period_to::text as period_to,
              debitos::text as debitos, creditos::text as creditos,
              creditos_deducibles::text as creditos_deducibles,
              prorrata_pct::text as prorrata_pct,
              retenciones_soportadas::text as retenciones_soportadas,
              excedente_anterior::text as excedente_anterior,
              cuota_a_pagar::text as cuota_a_pagar,
              excedente_siguiente::text as excedente_siguiente,
              detalle,
              (select c.functional_currency_code from public.companies c
                where c.id = ${input.company_id}) as functional_currency,
              generator_version, dataset_hash, created_by,
              to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                as created_at`;

  const parametros: Record<string, JSONValue> = {
    period_from: input.period_from,
    period_to: input.period_to,
    excedente_anterior: excedenteAnterior,
    cuota_a_pagar: r.cuota_a_pagar,
    excedente_siguiente: r.excedente_siguiente,
    dataset_hash: h!.hash,
  };
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${scope.value.tenantId}, ${input.company_id}, 'iva_period_result',
            ${fila!["id"] as string}, 'fiscal.iva_period.generated', 'user', now(),
            ${RULES_VERSION}, ${sql.json(parametros)})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${scope.value.tenantId}, ${input.company_id}, 'iva_period_result',
            ${fila!["id"] as string}, 'fiscal.iva_period.generated', 1,
            ${sql.json({ id: fila!["id"] as string, ...parametros })})`;

  return ok(fila as never);
}

/**
 * Carga (o corrige) el calendario de vencimientos. REEMPLAZO por
 * (obligación, período): la tabla no admite UPDATE — se borra la fila vieja
 * y se inserta la nueva, con su fuente. Es configuración de la empresa, no
 * un hecho fiscal: permiso de settings, sin outbox.
 */
export async function loadFiscalDeadlines(
  uow: UnitOfWork,
  input: LoadFiscalDeadlinesRequest,
): Promise<Result<{ items: FiscalDeadlineResponse[] }, DeclarationsError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Cargar el calendario fiscal exige un usuario real.",
    });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "company.settings.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  for (const d of input.deadlines) {
    if (d.period_to < d.period_from) {
      return err({
        code: "VALIDATION_FAILED",
        message: `El período de ${d.obligation} termina antes de empezar (${d.period_from} → ${d.period_to}).`,
      });
    }
  }

  const items: FiscalDeadlineResponse[] = [];
  for (const d of input.deadlines) {
    await sql`
      delete from public.company_fiscal_deadlines
       where company_id = ${input.company_id} and obligation = ${d.obligation}
         and period_from = ${d.period_from}::date and period_to = ${d.period_to}::date`;
    const [fila] = await sql<FiscalDeadlineResponse[]>`
      insert into public.company_fiscal_deadlines
        (tenant_id, company_id, obligation, period_from, period_to, due_date, legal_source)
      values (${scope.value.tenantId}, ${input.company_id}, ${d.obligation},
              ${d.period_from}::date, ${d.period_to}::date, ${d.due_date}::date,
              ${d.legal_source})
      returning id, obligation, period_from::text as period_from, period_to::text as period_to,
                due_date::text as due_date, legal_source`;
    items.push(fila!);
  }
  return ok({ items });
}

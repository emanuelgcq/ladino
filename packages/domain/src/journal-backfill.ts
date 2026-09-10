import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork } from "@ladino/db";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import {
  generateJournalFromDocument,
  type AmountContext,
  type ConditionContext,
} from "./journal-generator.js";

/**
 * REPROCESAR LA COLA CONTABLE (ADR-0042).
 *
 * La cola existía desde el principio y su mensaje decía «configúrala e importa
 * este pendiente» — pero **no había forma de importarlo**: ni endpoint ni caso
 * de uso. Se descubrió el 2026-09-10 al cargar un negocio de verdad: 1418
 * hechos encolados, la contabilidad vacía, y ningún botón que la recuperara.
 *
 * Es el caso NORMAL de un negocio real, no un borde: se factura desde el día
 * uno y la contabilidad se configura después (o la plantilla se importa hoy
 * con vigencia de hoy, y las ventas del mes pasado quedan fuera). Sin este
 * caso de uso, esa historia no se recupera nunca.
 *
 * Lo que NO hace, a propósito:
 *   · no inventa importes: todo sale del `context` que la cola guardó cuando
 *     el hecho ocurrió — los de ENTONCES, no los de hoy;
 *   · no fuerza nada: si sigue sin haber plantilla vigente a la fecha del
 *     hecho, el pendiente se queda pendiente y se informa;
 *   · no toca los que ya se resolvieron (`status <> 'pending'`).
 */
export type BackfillError = CompanyScopeError | { code: "VALIDATION_FAILED"; message: string };

export interface BackfillResultado {
  /** Cuántos pendientes se miraron en esta pasada. */
  readonly revisados: number;
  /** Cuántos produjeron por fin su asiento. */
  readonly contabilizados: number;
  /** Cuántos siguen sin plantilla (con el motivo del primero). */
  readonly pendientes: number;
  readonly primer_motivo: string | null;
}

/** Dónde vive cada hecho, para poder escribirle el enlace de vuelta. */
const TABLA_DE: Record<string, string> = {
  sales_invoice: "documents",
  sales_credit_note: "documents",
  sales_debit_note: "documents",
  sales_receipt: "documents",
  purchase_invoice: "supplier_invoices",
  goods_receipt: "goods_receipts",
  landed_cost: "landed_costs",
  landed_cost_variance: "landed_costs",
  expense: "expenses",
  cash_closing: "cash_closings",
};

interface FilaCola {
  id: string;
  source_kind: string;
  source_id: string;
  source_event: string;
  context: Record<string, unknown>;
}

/** Los importes que la plantilla puede pedir, tomados del contexto guardado. */
function importesDe(ctx: Record<string, unknown>): AmountContext {
  const claves = [
    "subtotal",
    "tax_amount",
    "total",
    "retained_iva",
    "retained_islr",
    "retained_total",
    "net_amount",
    "cost_amount",
    "landed_to_inventory",
    "landed_to_variance",
    "exchange_difference",
    "functional_amount",
  ] as const;
  const salida: AmountContext = {};
  for (const k of claves) {
    const v = ctx[k];
    // Solo strings: el importe viaja como string decimal (regla 7) y un número
    // aquí sería un `double` colándose en la contabilidad por la puerta de atrás.
    if (typeof v === "string") (salida as Record<string, string>)[k] = v;
  }
  return salida;
}

function condicionesDe(ctx: Record<string, unknown>): ConditionContext | undefined {
  const rec = ctx["tax_recoverable"];
  const ext = ctx["supplier_foreign"];
  if (typeof rec !== "boolean" && typeof ext !== "boolean") return undefined;
  return {
    ...(typeof rec === "boolean" ? { taxRecoverable: rec } : {}),
    ...(typeof ext === "boolean" ? { supplierForeign: ext } : {}),
  };
}

export async function reprocessPendingJournals(
  uow: UnitOfWork,
  input: { company_id: string; limit?: number },
): Promise<Result<BackfillResultado, BackfillError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Reprocesar la contabilidad pendiente exige un usuario real: el asiento se firma.",
    });
  }
  // Mismo permiso que postear un asiento: esto GENERA asientos posteados.
  const scope = await companyScope(sql, actor.userId, input.company_id, "accounting.entry.post");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }

  const tope = Math.min(Math.max(input.limit ?? 200, 1), 500);
  // En ORDEN DE OCURRENCIA: los asientos se generan como pasaron las cosas,
  // no como se leyeron. Un mayor construido en desorden es un mayor distinto.
  const filas = await sql<FilaCola[]>`
    select id, source_kind, source_id, source_event, context
      from public.journal_generation_queue
     where company_id = ${input.company_id} and status = 'pending'
     order by created_at
     limit ${tope}`;

  let contabilizados = 0;
  let pendientes = 0;
  let primerMotivo: string | null = null;

  for (const f of filas) {
    const ctx = f.context;
    const fecha = typeof ctx["posting_date"] === "string" ? ctx["posting_date"] : null;
    const moneda =
      typeof ctx["functional_currency"] === "string" ? ctx["functional_currency"] : null;
    if (fecha === null || moneda === null) {
      pendientes++;
      primerMotivo ??= "El pendiente no guardó fecha o moneda: no se puede reconstruir.";
      continue;
    }
    const tabla = TABLA_DE[f.source_kind];
    const r = await generateJournalFromDocument(sql, {
      tenantId: scope.value.tenantId,
      companyId: input.company_id,
      sourceKind: f.source_kind,
      sourceEvent: f.source_event,
      sourceId: f.source_id,
      postingDate: fecha,
      postedBy: actor.userId,
      description:
        typeof ctx["description"] === "string" ? ctx["description"] : "Contabilización diferida",
      functionalCurrency: moneda,
      amounts: importesDe(ctx),
      ...(condicionesDe(ctx) === undefined ? {} : { conditions: condicionesDe(ctx)! }),
      ...(tabla === undefined ? {} : { backlink: { table: tabla, id: f.source_id } }),
    });
    if (!r.ok) {
      return err({ code: "VALIDATION_FAILED", message: r.error.message });
    }
    // `already` = el hecho YA tenía asiento y la cola estaba de más. Cuenta
    // como resuelto: lo que importa es que no quede sin contabilizar.
    if (r.value.kind === "posted" || r.value.kind === "already") {
      contabilizados++;
    } else {
      pendientes++;
      primerMotivo ??= r.value.reason;
    }
  }

  return ok({
    revisados: filas.length,
    contabilizados,
    pendientes,
    primer_motivo: primerMotivo,
  });
}

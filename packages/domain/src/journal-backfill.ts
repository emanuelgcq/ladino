import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork } from "@ladino/db";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import {
  generateJournalFromDocument,
  type AmountContext,
  type ConditionContext,
} from "./journal-generator.js";
import { requeueOverdraftClosingFromQueue } from "./overdraft-closings.js";
import { CASH_CLOSING_KIND } from "./treasury.js";

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
  // H-03: la nota de crédito del proveedor encolada también recupera su enlace. Sin él quedaba
  // con su asiento posteado y `journal_entry_id` nulo: `accounting_coverage_gaps` la daba
  // «missing» para siempre.
  purchase_credit_note: "supplier_credit_notes",
  goods_receipt: "goods_receipts",
  landed_cost: "landed_costs",
  landed_cost_variance: "landed_costs",
  expense: "expenses",
  cash_closing: "cash_closings",
  // J-02: el cierre en sobregiro es la misma fila con otro origen; encolado, recupera su enlace.
  cash_closing_overdraft: "cash_closings",
  sales_receipt_return: "documents",
  customer_refund: "customer_refunds",
  // ADR-0062 §3 (migración 61): una transferencia encolada también recupera su enlace.
  treasury_transfer: "treasury_transfers",
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
    // ADR-0060 §2: la revalorización de la factura de proveedor. Sin estas dos
    // claves, un hecho encolado perdería sus importes al reprocesarse.
    "revaluation_to_inventory",
    "revaluation_to_variance",
    // J-02: el cierre de una caja en sobregiro. Sin esta clave, encolado perdería lo del dueño.
    "owner_contribution",
    // H-03 (ADR-0083 §5): el saldo a favor de la nota de crédito de un proveedor. Sin esta
    // clave, la nota encolada (empresa sin la cuenta de saldos a favor) se asentaba al
    // reprocesarse SIN sus dos líneas: el exceso quedaba en cuentas por pagar en negativo.
    "credit_surplus",
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
    /**
     * J-02, LA VENTANA CERRADA POR CONSTRUCCIÓN. Una fila de origen `cash_closing` no se reprocesa
     * con el origen que trae: se lee el CIERRE y el hecho lo decide `hechoContableDelCierre`, la
     * misma definición del cierre y de la reparación. Si lo esperado fue negativo (la encoló la API
     * anterior a la 20261004180000), la fila se descarta con su acta y el hecho nace con el origen
     * del sobregiro —la rama B de la reparación, el mismo código—: nunca como ingreso, se corra
     * esto antes o después de `scripts/reparar/j-02-sobregiro-al-cierre.mjs`.
     */
    if (f.source_kind === CASH_CLOSING_KIND) {
      let sobregiro: Awaited<ReturnType<typeof requeueOverdraftClosingFromQueue>>;
      try {
        sobregiro = await requeueOverdraftClosingFromQueue(sql, input.company_id, f.id, {
          postedBy: actor.userId,
          actorType: "user",
        });
      } catch (e) {
        return err({
          code: "VALIDATION_FAILED",
          message: e instanceof Error ? e.message : String(e),
        });
      }
      if (sobregiro !== null) {
        if (sobregiro.accounting === "posted") contabilizados++;
        else {
          pendientes++;
          primerMotivo ??= sobregiro.reason;
        }
        continue;
      }
    }
    const tabla = TABLA_DE[f.source_kind];
    /**
     * Revisión 3, decidido por criterio (opción a, sin excepción en el invariante): el asiento de
     * una percepción documentada con ND por IGTF ES el asiento de esa ND (20261002100000). Si se
     * encoló, al importarlo el enlace va a `documents` de la ND; sin él la ND quedaría sin
     * `journal_entry_id` y `accounting_coverage_gaps()` la contaría como hueco para siempre.
     */
    let enlace: { table: string; id: string } | undefined =
      tabla === undefined ? undefined : { table: tabla, id: f.source_id };
    if (f.source_kind === "igtf_perception") {
      const [nd] = await sql<{ debit_note_id: string | null }[]>`
        select debit_note_id from public.igtf_perceptions
         where company_id = ${input.company_id} and id = ${f.source_id}`;
      if (nd?.debit_note_id) enlace = { table: "documents", id: nd.debit_note_id };
    }
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
      ...(ctx["difference_is_rounding"] === true ? { differenceIsRounding: true } : {}),
      ...(enlace === undefined ? {} : { backlink: enlace }),
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

import { err, ok, type Result } from "@ladino/core";
import type { TransactionSql, JSONValue } from "@ladino/db";
import { Money, parseDecimal, type Decimal } from "@ladino/money";
import { validateEntryBalance, type EntryLine } from "@ladino/accounting";
import { RULES_VERSION } from "./create-company.js";

/**
 * EL GENERADOR DE ASIENTOS — el gancho que cerró R-20.
 *
 * La migración 25 dejó la contabilidad montada y desconectada: el esquema, el
 * trigger de partida doble y la cola existían, y ningún módulo llamaba a nada.
 * Esto es la llamada.
 *
 * Se invoca SÍNCRONO, en la misma transacción del documento (ADR-0042). Dos
 * caminos, y los dos son correctos:
 *
 *   · con plantilla y con todas sus cuentas configuradas → genera el asiento y
 *     lo postea. Documento y asiento commitean juntos o no commitea ninguno;
 *   · sin plantilla, o con un papel sin cuenta → **encola**. El documento se
 *     emite igual. Un documento fiscal sin regla tributaria es ilegal; uno sin
 *     asentar todavía es «pendiente de contabilizar», que es un estado normal.
 *
 * Lo que NUNCA hace: inventarse una cuenta, elegir «la primera de ingresos que
 * encuentre», o dejar el documento sin asiento Y sin fila en la cola. Ese
 * último caso es el que rompería el invariante de ADR-0042, y por eso el
 * `catch` de este fichero encola en vez de propagar.
 */

export type JournalGenerationError =
  { code: "VALIDATION_FAILED"; message: string } | { code: "ENTRY_UNBALANCED"; message: string };

/** El resultado, y las dos mitades del invariante son visibles en el tipo. */
export type GenerationOutcome =
  | { readonly kind: "posted"; readonly entryId: string; readonly entryNumber: number }
  | { readonly kind: "queued"; readonly queueId: string; readonly reason: string }
  | { readonly kind: "already"; readonly entryId: string };

/**
 * Los importes del documento, por su nombre de `amount_source`. Es el contexto
 * TIPADO de ADR-0041: la plantilla dice de cuál tomar, y no hay forma de que
 * pida uno que no esté en esta lista porque el `CHECK` de la tabla es el mismo
 * enum. Nada se lee dinámicamente de un JSON.
 */
export interface AmountContext {
  readonly subtotal?: string;
  readonly tax_amount?: string;
  readonly total?: string;
  readonly retained_iva?: string;
  readonly retained_islr?: string;
  readonly retained_total?: string;
  readonly net_amount?: string;
  readonly cost_amount?: string;
  readonly landed_to_inventory?: string;
  readonly landed_to_variance?: string;
  readonly exchange_difference?: string;
  readonly functional_amount?: string;
}

/** Las banderas que responden los predicados. Ocho preguntas, ni una más. */
export interface ConditionContext {
  readonly taxRecoverable?: boolean;
  readonly supplierForeign?: boolean;
}

export interface GenerationInput {
  readonly tenantId: string;
  readonly companyId: string;
  readonly sourceKind: string;
  /** El evento del OUTBOX, con su nombre real. No se inventa uno paralelo. */
  readonly sourceEvent: string;
  readonly sourceId: string;
  readonly postingDate: string;
  /** Quién postea. EXPLÍCITO: `auth.uid()` no es accesible desde `ladino_api`
   *  —no tiene USAGE sobre el esquema `auth`— y depender de un GUC aquí sería
   *  que el asiento se quedara sin autor según por dónde entrara la llamada. */
  readonly postedBy: string;
  readonly description: string;
  readonly functionalCurrency: string;
  readonly amounts: AmountContext;
  readonly conditions?: ConditionContext;
  /** Tabla y columna donde escribir el `journal_entry_id` (bidireccional). */
  readonly backlink?: { readonly table: string; readonly id: string };
}

interface LineaPlantilla {
  account_purpose: string;
  amount_source: string;
  side: string;
  condition_kind: string;
  description: string | null;
  line_number: number;
}

/**
 * Dónde SÍ se puede escribir el enlace de vuelta.
 *
 * `payments`, `supplier_payments` y `retention_receipts` NO están, y no es un
 * olvido: son append-only de verdad —sin GRANT de `UPDATE` para nadie— y
 * escribirles una columna después del insert exigiría debilitar esa garantía
 * para guardar una comodidad. El enlace en esa dirección ya existe:
 * `journal_entries.source_id`, con índice. La bidireccionalidad de ADR-0042 es
 * una conveniencia de lectura, no el invariante, y no vale una capa de
 * append-only.
 */
const TABLAS_BACKLINK = new Set([
  "documents",
  "supplier_invoices",
  "goods_receipts",
  "landed_costs",
  // Fase C (migraciones 30 y 31): las dos llevan guard de «solo backlink» —
  // el UPDATE que este generador hace es exactamente el único que admiten.
  "expenses",
  "cash_closings",
]);

/**
 * Decide si la línea aplica. Ocho predicados, resueltos con un `switch`: **no
 * se evalúa ninguna cadena** (ADR-0041 §3). Un evaluador de expresiones aquí
 * sería ejecución arbitraria alimentada por una tabla de configuración, dentro
 * del motor que decide dónde va cada bolívar.
 */
function aplica(condicion: string, importe: Decimal, cond: ConditionContext): boolean {
  switch (condicion) {
    case "always":
      return true;
    case "if_amount_nonzero":
      return !importe.isZero();
    case "if_positive":
      return importe.greaterThan(0);
    case "if_negative":
      return importe.isNegative();
    case "if_tax_recoverable":
      return cond.taxRecoverable === true;
    case "if_tax_not_recoverable":
      return cond.taxRecoverable === false;
    case "if_supplier_foreign":
      return cond.supplierForeign === true;
    case "if_supplier_national":
      return cond.supplierForeign === false;
    default:
      // Imposible por el CHECK de la tabla. Se responde `false` en vez de
      // lanzar: una condición desconocida omite su línea, y el desbalance que
      // eso produce lo caza la partida doble con un mensaje que dice cuánto
      // falta — mucho más útil que «predicado desconocido».
      return false;
  }
}

async function encolar(
  sql: TransactionSql,
  input: GenerationInput,
  motivo: string,
): Promise<Result<GenerationOutcome, JournalGenerationError>> {
  const contexto: Record<string, JSONValue> = {
    ...(input.amounts as Record<string, JSONValue>),
    functional_currency: input.functionalCurrency,
    posting_date: input.postingDate,
    description: input.description,
    ...(input.conditions?.taxRecoverable === undefined
      ? {}
      : { tax_recoverable: input.conditions.taxRecoverable }),
    ...(input.conditions?.supplierForeign === undefined
      ? {}
      : { supplier_foreign: input.conditions.supplierForeign }),
  };
  try {
    const fila = await sql.savepoint(async (sp) => {
      const [q] = await sp<{ id: string }[]>`
        insert into public.journal_generation_queue
          (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
        values (${input.tenantId}, ${input.companyId}, ${input.sourceKind}, ${input.sourceId},
                ${input.sourceEvent}, ${sp.json(contexto)}, ${motivo})
        returning id`;
      return q!;
    });
    return ok({ kind: "queued", queueId: fila.id, reason: motivo });
  } catch (e) {
    // Ya encolado: el mismo hecho, una sola fila. Es idempotencia, no un error.
    if ((e as { code?: string }).code === "23505") {
      const [existente] = await sql<{ id: string }[]>`
        select id from public.journal_generation_queue
         where company_id = ${input.companyId} and source_kind = ${input.sourceKind}
           and source_id = ${input.sourceId} and source_event = ${input.sourceEvent}`;
      return ok({ kind: "queued", queueId: existente?.id ?? "", reason: motivo });
    }
    throw e;
  }
}

/**
 * Genera el asiento de un documento, o lo encola. **Nunca deja al documento sin
 * las dos cosas**: ese es el invariante de ADR-0042 y `accounting_coverage_gaps`
 * lo comprueba sobre el catálogo entero.
 */
export async function generateJournalFromDocument(
  sql: TransactionSql,
  input: GenerationInput,
): Promise<Result<GenerationOutcome, JournalGenerationError>> {
  // Idempotencia por EVENTO (ADR-0042). Si ya hay asiento para este hecho, no
  // se genera otro — y se devuelve el que hay, para que el llamante pueda
  // enlazar el documento aunque sea un reintento.
  const [yaExiste] = await sql<{ id: string }[]>`
    select id from public.journal_entries
     where company_id = ${input.companyId} and source_kind = ${input.sourceKind}
       and source_id = ${input.sourceId} and source_event = ${input.sourceEvent}
       and status <> 'reversed'`;
  if (yaExiste) return ok({ kind: "already", entryId: yaExiste.id });

  const [plantilla] = await sql<{ id: string; description: string }[]>`
    select id, description from public.journal_templates
     where company_id = ${input.companyId} and source_kind = ${input.sourceKind}
       and source_event = ${input.sourceEvent} and is_active
       -- La vigencia se compara POR DÍA, no por instante — y el día se decide
       -- EN CARACAS, no en el huso de la sesión. La versión anterior casteaba
       -- \`effective_from::date\` (UTC): entre las 8 pm y la medianoche de
       -- Venezuela, una plantilla importada «hoy» quedaba fechada MAÑANA
       -- respecto del posting_date del día venezolano, y el gasto se encolaba
       -- con «no hay plantilla» teniéndola delante. Quinta aparición de la
       -- familia de CLAUDE.md §3, cazada por el verify nocturno.
       and (effective_from at time zone 'America/Caracas')::date <= ${input.postingDate}::date
       and (effective_to is null
            or (effective_to at time zone 'America/Caracas')::date > ${input.postingDate}::date)
     order by effective_from desc limit 1`;
  if (!plantilla) {
    return encolar(
      sql,
      input,
      `No hay plantilla de mapeo contable para ${input.sourceKind} / ${input.sourceEvent}. Configúrala e importa este pendiente.`,
    );
  }

  const lineasPlantilla = await sql<LineaPlantilla[]>`
    select account_purpose, amount_source, side, condition_kind, description, line_number
      from public.journal_template_lines
     where template_id = ${plantilla.id} order by line_number`;
  if (lineasPlantilla.length === 0) {
    return encolar(sql, input, "La plantilla de mapeo existe pero no tiene líneas.");
  }

  const cond = input.conditions ?? {};
  const lineas: (EntryLine & { description: string | null })[] = [];
  const papelesSinCuenta = new Set<string>();

  for (const l of lineasPlantilla) {
    const bruto = (input.amounts as Record<string, string | undefined>)[l.amount_source];
    if (bruto === undefined) {
      // La plantilla pide un importe que este documento no tiene. No es un
      // fallo del documento: es una plantilla mal configurada para él.
      return encolar(
        sql,
        input,
        `La plantilla pide el importe «${l.amount_source}» y este documento no lo aporta.`,
      );
    }
    const importe = parseDecimal(bruto);
    if (!importe.ok) {
      return err({ code: "VALIDATION_FAILED", message: importe.error.message });
    }
    if (!aplica(l.condition_kind, importe.value, cond)) continue;

    // El VALOR ABSOLUTO, siempre. Una línea de asiento no lleva importes
    // negativos: el signo elige el LADO —eso es lo que hacen `if_positive` e
    // `if_negative`— y un débito negativo es un crédito escrito al revés.
    const absoluto = importe.value.isNegative() ? importe.value.negated() : importe.value;
    if (absoluto.isZero()) continue;

    const [cuenta] = await sql<{ id: string }[]>`
      select account_id as id from public.company_account_settings
       where company_id = ${input.companyId} and purpose = ${l.account_purpose}
         -- El mismo día DE CARACAS que la vigencia de la plantilla (arriba).
         and (effective_from at time zone 'America/Caracas')::date <= ${input.postingDate}::date
         and (effective_to is null
              or (effective_to at time zone 'America/Caracas')::date > ${input.postingDate}::date)
       order by effective_from desc limit 1`;
    if (!cuenta) {
      papelesSinCuenta.add(l.account_purpose);
      continue;
    }

    const money = Money.of(absoluto.toFixed(8), input.functionalCurrency);
    if (!money.ok) return err({ code: "VALIDATION_FAILED", message: money.error.message });
    const cero = Money.of("0", input.functionalCurrency);
    if (!cero.ok) return err({ code: "VALIDATION_FAILED", message: cero.error.message });
    lineas.push({
      accountId: cuenta.id,
      debit: l.side === "debit" ? money.value : cero.value,
      credit: l.side === "credit" ? money.value : cero.value,
      description: l.description,
    });
  }

  if (papelesSinCuenta.size > 0) {
    // Un papel sin cuenta NO se adivina y NO revienta el documento: se encola
    // diciendo exactamente qué falta configurar. Adivinar la cuenta produce un
    // asiento que cuadra y es falso, que es peor que no tenerlo.
    return encolar(
      sql,
      input,
      `Falta configurar la cuenta de: ${[...papelesSinCuenta].join(", ")}. El documento está emitido; el asiento se genera en cuanto la asignes.`,
    );
  }
  if (lineas.length < 2) {
    return encolar(
      sql,
      input,
      "La plantilla no produjo al menos dos líneas con importe para este documento.",
    );
  }

  const balance = validateEntryBalance(lineas, input.functionalCurrency);
  if (!balance.ok) {
    return err({ code: "VALIDATION_FAILED", message: balance.error.message });
  }
  if (!balance.value.balanced) {
    // Esto NO se encola: una plantilla que produce asientos descuadrados es un
    // defecto de configuración que hay que ver ahora, no una tarea pendiente.
    // Y el trigger lo rechazaría igual; fallar aquí da la diferencia exacta.
    return err({
      code: "ENTRY_UNBALANCED",
      message: `La plantilla de ${input.sourceKind}/${input.sourceEvent} produce un asiento descuadrado: débitos ${balance.value.totalDebit.toAmountString()} contra créditos ${balance.value.totalCredit.toAmountString()}, diferencia ${balance.value.difference.toFixed(8)}. Revisa el mapeo.`,
    });
  }

  const [periodo] = await sql<{ id: string }[]>`
    select platform.period_for_date(${input.companyId}, ${input.postingDate}::date) as id`;
  const [asiento] = await sql<{ id: string }[]>`
    insert into public.journal_entries
      (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
       description, rules_version)
    values (${input.tenantId}, ${input.companyId}, ${periodo!.id}, ${input.postingDate}::date,
            ${input.sourceKind}, ${input.sourceId}, ${input.sourceEvent}, ${input.description},
            ${RULES_VERSION})
    returning id`;

  let n = 0;
  for (const l of lineas) {
    n += 1;
    const importe = l.debit.amount.isZero() ? l.credit : l.debit;
    await sql`
      insert into public.journal_lines
        (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
         amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
         functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
         description)
      values (${input.tenantId}, ${input.companyId}, ${asiento!.id}, ${n}, ${l.accountId},
              ${l.debit.toAmountString()}, ${l.credit.toAmountString()},
              ${importe.toAmountString()}, ${input.functionalCurrency}, 1,
              ${importe.toAmountString()}, ${input.functionalCurrency}, 'identidad', now(),
              ${l.debit.toAmountString()}, ${l.credit.toAmountString()}, ${l.description})`;
  }

  const [num] = await sql<{ n: string }[]>`
    select platform.claim_entry_number(${input.companyId},
           extract(year from ${input.postingDate}::date)::int)::text as n`;
  const [posteado] = await sql<{ id: string; entry_number: number }[]>`
    update public.journal_entries
       set status = 'posted', posted_at = now(),
           posted_by = ${input.postedBy},
           entry_number = ${num!.n}::bigint
     where id = ${asiento!.id}
    returning id, entry_number::int as entry_number`;

  // El enlace de vuelta (ADR-0042 §Trazabilidad). El nombre de la tabla se
  // valida contra una lista cerrada antes de interpolarlo: `sql.unsafe` con un
  // identificador que viniera del llamante sería inyección, aunque el llamante
  // sea código nuestro.
  if (input.backlink !== undefined && TABLAS_BACKLINK.has(input.backlink.table)) {
    await sql`
      update ${sql.unsafe(`public.${input.backlink.table}`)}
         set journal_entry_id = ${posteado!.id}
       where id = ${input.backlink.id} and company_id = ${input.companyId}`;
  }

  // Y si el hecho estaba encolado —porque se emitió antes de configurar el
  // mapeo—, la cola se cierra EN LA MISMA TRANSACCIÓN. Las dos mitades del
  // invariante no pueden estar verdaderas a la vez ni un instante.
  await sql`
    update public.journal_generation_queue
       set status = 'generated', generated_entry_id = ${posteado!.id}, processed_at = now()
     where company_id = ${input.companyId} and source_kind = ${input.sourceKind}
       and source_id = ${input.sourceId} and source_event = ${input.sourceEvent}
       and status = 'pending'`;

  return ok({ kind: "posted", entryId: posteado!.id, entryNumber: posteado!.entry_number });
}

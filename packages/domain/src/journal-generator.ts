import { err, ok, type Result } from "@ladino/core";
import type { TransactionSql, JSONValue } from "@ladino/db";
import { Money, parseDecimal, toCents, type Decimal } from "@ladino/money";
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

/** El papel que se resuelve con la caja real del hecho (ADR-0060 §4). */
const PAPEL_CAJA = "treasury_account";
/** Y la caja de ORIGEN, para un hecho que mueve dinero entre dos (ADR-0062 §3). */
const PAPEL_CAJA_ORIGEN = "treasury_account_from";
/**
 * Los papeles de la CARTERA (H6, ADR-0075 §6): la línea de cuentas por cobrar o por pagar de un
 * documento en divisa guarda la moneda del documento, su importe original y la tasa del
 * documento. El diferencial va en su propia línea, en moneda funcional.
 */
const PAPELES_CARTERA: ReadonlySet<string> = new Set(["ar_general", "ap_general"]);
/** Fila interna de la consulta de papeles: el original de la cartera. No es un papel de plantilla. */
const FILA_CARTERA = "__settlement_original";
/**
 * El papel del residuo de conversión (ADR-0075 §7): cada línea va al céntimo, half-up, y lo que
 * el redondeo descuadra va a «Diferencias por redondeo». No es un papel de plantilla: lo añade
 * este generador, y solo cuando hay residuo.
 */
export const PAPEL_REDONDEO = "rounding_difference";
/** Motivo de cola cuando esa caja no tiene cuenta contable. Estable: lo buscan tests y pantalla. */
export const MOTIVO_CAJA_SIN_MAPEO = "treasury_account_unmapped";

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
  /** La factura de proveedor distinta de lo recibido (ADR-0060 §2): lo que revaloriza y lo que va a variación. */
  readonly revaluation_to_inventory?: string;
  readonly revaluation_to_variance?: string;
  /** J-02: lo que lleva de negativo a cero una caja en sobregiro al cerrarla. Se le debe al dueño. */
  readonly owner_contribution?: string;
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
  /**
   * AF-M03 (ADR-0075 §4): la diferencia de este hecho NO es cambiaria — el cobro o el pago
   * ocurrió a la MISMA tasa del documento, y lo que sobra o falta es el redondeo del IVA al
   * céntimo de la divisa (E-05). Las líneas que la plantilla lleva a `exchange_gain` /
   * `exchange_loss` por `exchange_difference` van entonces a «Diferencias por redondeo».
   */
  readonly differenceIsRounding?: boolean;
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
  // ADR-0061: el reembolso lleva el mismo guard de «solo backlink».
  "customer_refunds",
  // ADR-0062 §3 (migración 61): la transferencia entre cuentas, con el mismo guard.
  "treasury_transfers",
  // ADR-0065 §1 (migración 67): la nota de crédito RECIBIDA del proveedor. Antes la tabla ni
  // siquiera tenía columna para el enlace, y la nota no producía asiento ninguno.
  "supplier_credit_notes",
]);

/**
 * Las tablas que pasan `backlink` a sabiendas de que NO se escribirá: append-only sin GRANT
 * de UPDATE (ver arriba). Existe para que la lista de arriba pueda EXIGIR que toda tabla esté
 * declarada en una de las dos: una tabla en ninguna es un olvido, y el olvido no puede
 * seguir siendo silencioso — así quedó `treasury_transfers` con su asiento posteado y sin
 * enlace, y lo destapó `accounting_coverage_gaps`, no esta función.
 */
const TABLAS_SIN_BACKLINK = new Set(["payments", "supplier_payments", "retention_receipts"]);

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
    ...(input.differenceIsRounding === true ? { difference_is_rounding: true } : {}),
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
  const originales: ({ moneda: string; importe: string; fuente: string; hora: string } | null)[] =
    [];
  /** El papel de cada línea, en paralelo a `lineas` (la de redondeo no tiene). */
  const papelDeLinea: (string | null)[] = [];
  // Lo que la plantilla pide SIN redondear: es lo que tiene que cuadrar (un descuadre aquí es
  // un defecto de la plantilla). El residuo del céntimo se mide después, sobre las líneas.
  const ceroExacto = parseDecimal("0");
  if (!ceroExacto.ok) return err({ code: "VALIDATION_FAILED", message: ceroExacto.error.message });
  let debeExacto: Decimal = ceroExacto.value;
  let haberExacto: Decimal = ceroExacto.value;
  const papelesSinCuenta = new Set<string>();

  /**
   * LAS CUENTAS DE TODOS LOS PAPELES, DE UNA VEZ (2026-09-10).
   *
   * Antes se consultaba la cuenta DENTRO del bucle: una espera de red por
   * línea de plantilla, y una venta cobrada genera tres asientos. El
   * `distinct on (purpose) … order by purpose, effective_from desc` da
   * exactamente la misma fila que daba el `order by effective_from desc
   * limit 1` de cada consulta suelta, con el mismo criterio de vigencia
   * —mismo día de Caracas— y sobre los mismos papeles.
   *
   * Precargar de más es inofensivo: `papelesSinCuenta` se sigue llenando
   * SOLO dentro del bucle y SOLO para las líneas que de verdad aplican, así
   * que el motivo del encolado no cambia ni gana papeles que no tocaban.
   */
  const papeles = [...new Set([...lineasPlantilla.map((l) => l.account_purpose), PAPEL_REDONDEO])];
  const pideCaja = papeles.includes(PAPEL_CAJA);
  const pideCajaOrigen = papeles.includes(PAPEL_CAJA_ORIGEN);
  /**
   * EL PAPEL `treasury_account` (ADR-0060 §4) no es una cuenta configurada: es
   * la cuenta contable mapeada a la caja REAL del hecho —la del cobro, el pago
   * a proveedor, el gasto, el cierre o el pago que originó la percepción—,
   * resuelta por `platform.treasury_account_of`, la única definición. Viaja en
   * la MISMA consulta que los demás papeles: ni una espera de red más.
   */
  const cuentasFilas = await sql<
    {
      purpose: string;
      id: string | null;
      caja: string | null;
      moneda: string | null;
      original: string | null;
      moneda_original: string | null;
      fuente_tasa: string | null;
      hora_tasa: string | null;
      tasa_doc: string | null;
      escala: number | null;
    }[]
  >`
    (select distinct on (purpose) purpose, account_id as id, null::text as caja,
            null::text as moneda, null::text as original, null::text as moneda_original,
            null::text as fuente_tasa, null::text as hora_tasa,
            null::text as tasa_doc, null::int as escala
       from public.company_account_settings
      where company_id = ${input.companyId} and purpose = any(${papeles}::text[])
        -- El mismo día DE CARACAS que la vigencia de la plantilla (arriba).
        and (effective_from at time zone 'America/Caracas')::date <= ${input.postingDate}::date
        and (effective_to is null
             or (effective_to at time zone 'America/Caracas')::date > ${input.postingDate}::date)
      order by purpose, effective_from desc)
    union all
    select ${PAPEL_CAJA}, ca.ledger_account_id, ca.name, ca.currency,
           o.amount::text, o.currency, o.rate_source, o.rate_timestamp::text, null, null
      from public.company_accounts ca
      left join lateral platform.treasury_original_of(${input.companyId}, ${input.sourceKind},
                                                      ${input.sourceId}::uuid) o on true
     where ${pideCaja}
       and ca.company_id = ${input.companyId}
       and ca.id = platform.treasury_account_of(${input.companyId}, ${input.sourceKind},
                                                ${input.sourceId}::uuid)
    union all
    select ${PAPEL_CAJA_ORIGEN}, ca.ledger_account_id, ca.name, ca.currency,
           o.amount::text, o.currency, o.rate_source, o.rate_timestamp::text, null, null
      from public.company_accounts ca
      left join lateral platform.treasury_original_of(${input.companyId}, ${input.sourceKind},
                                                      ${input.sourceId}::uuid) o on true
     where ${pideCajaOrigen}
       and ca.company_id = ${input.companyId}
       and ca.id = platform.treasury_from_account_of(${input.companyId}, ${input.sourceKind},
                                                     ${input.sourceId}::uuid)
    union all
    -- H6: el original de la CARTERA, en la misma consulta (ni una espera de red más).
    select ${FILA_CARTERA}, null::uuid, null, s.currency, s.amount::text, s.currency,
           s.rate_source, s.rate_timestamp::text, s.fx_rate::text, s.minor_units
      from platform.settlement_original_of(${input.companyId}, ${input.sourceKind},
                                           ${input.sourceId}::uuid) s
     where ${papeles.some((p) => PAPELES_CARTERA.has(p))}`;
  const cartera = cuentasFilas.find((c) => c.purpose === FILA_CARTERA) ?? null;
  const cuentaDe = new Map<string, string>();
  /**
   * E-11 (ADR-0075 §6; los siete campos de ADR-0020). La línea de una caja EN DIVISA guarda lo
   * que de verdad se movió: su moneda, el importe original y la tasa que lo llevó a la moneda
   * funcional. Sale del hecho (`platform.treasury_original_of`), nunca de dividir aquí: 5 USD
   * son 5 USD, no 4.272,32 / 854,464. Solo aplica si la caja está en otra moneda que la
   * funcional y el hecho se movió en la moneda de la caja.
   */
  const originalDe = new Map<
    string,
    { moneda: string; importe: string; fuente: string; hora: string }
  >();
  let problemaCaja: string | null = null;
  for (const c of cuentasFilas) {
    if (c.id !== null) cuentaDe.set(c.purpose, c.id);
    if (
      c.id !== null &&
      c.moneda !== null &&
      c.moneda !== input.functionalCurrency &&
      c.original !== null &&
      c.moneda_original === c.moneda &&
      c.fuente_tasa !== null &&
      c.hora_tasa !== null
    ) {
      originalDe.set(c.purpose, {
        moneda: c.moneda,
        importe: c.original,
        fuente: c.fuente_tasa,
        hora: c.hora_tasa,
      });
    }
  }
  const revisarCaja = (papel: string): void => {
    const caja = cuentasFilas.find((c) => c.purpose === papel);
    if (caja === undefined) {
      problemaCaja = `${MOTIVO_CAJA_SIN_MAPEO}: este hecho no tiene una cuenta de tesorería (caja, banco o billetera) de donde tomar la cuenta contable.`;
    } else if (caja.id === null) {
      problemaCaja = `${MOTIVO_CAJA_SIN_MAPEO}: la cuenta «${caja.caja ?? ""}» no tiene cuenta contable asignada. Asígnala en Tesorería y contabiliza este pendiente; no se asienta en otra caja.`;
    }
  };
  if (pideCaja) revisarCaja(PAPEL_CAJA);
  if (pideCajaOrigen && problemaCaja === null) revisarCaja(PAPEL_CAJA_ORIGEN);

  for (const l of lineasPlantilla) {
    /**
     * `exchange_difference` AUSENTE vale 0 — y SOLO ese importe. No es una regla general de «lo
     * que falte vale 0»: cualquier otro importe que la plantilla pida y el hecho no aporte sigue
     * encolando. La plantilla `payment_made` exige el diferencial desde 20261003170000; un pago a
     * proveedor registrado por la API anterior (o una fila `ap.payment_made` que ya esperaba en
     * la cola con el contexto viejo) no lo trae, y sin esto no podría asentarse nunca. Un pago
     * sin diferencial informado es un pago sin diferencial: sus líneas `if_positive` /
     * `if_negative` no aplican y el asiento queda como antes de esa migración (R-74 §3).
     */
    /**
     * Y su gemelo, el mismo formato viejo CON retención: aquel contexto traía `total` = el
     * BRUTO y `net_amount` = lo que salió de la caja, y su plantilla cancelaba la cuenta por
     * pagar por el NETO (la retención la descarga su comprobante). La plantilla de hoy lee
     * `total` como «lo cancelado»: con el contexto viejo descuadraba por lo retenido. Un pago a
     * proveedor SIN `exchange_difference` es de ese formato, y su línea de cuentas por pagar
     * toma `net_amount`. Solo ese hecho, solo ese papel.
     */
    const amounts = input.amounts as Record<string, string | undefined>;
    const fuente =
      input.sourceKind === "payment_made" &&
      amounts["exchange_difference"] === undefined &&
      l.amount_source === "total" &&
      l.account_purpose === "ap_general" &&
      amounts["net_amount"] !== undefined
        ? "net_amount"
        : // G-15 (20261004150000): la plantilla del reembolso pasó a bajar el pasivo por «total».
          // Un reembolso encolado por la API anterior solo trae «functional_amount» (saldo y caja
          // en la misma moneda, mismo importe): ese es su total. Solo ese hecho.
          input.sourceKind === "customer_refund" &&
            l.amount_source === "total" &&
            amounts["total"] === undefined
          ? "functional_amount"
          : l.amount_source;
    // «exchange_difference» y «credit_surplus» (F-10, el sobrante de un cobro) valen 0 cuando el
    // hecho no los aporta: un cobro sin sobrante, o una fila de la cola anterior a la plantilla.
    const bruto =
      amounts[fuente] ??
      (fuente === "exchange_difference" || fuente === "credit_surplus" ? "0" : undefined);
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

    // La caja sin mapeo NO cae en otra cuenta: se encola diciendo cuál caja es
    // (ADR-0060 §4). Solo si una línea que APLICA la necesita.
    if (l.account_purpose === PAPEL_CAJA && problemaCaja !== null) {
      return encolar(sql, input, problemaCaja);
    }
    // AF-M03: a la tasa del documento, la «diferencia» es redondeo y va a su cuenta.
    const esRedondeoDeCierre =
      input.differenceIsRounding === true &&
      l.amount_source === "exchange_difference" &&
      (l.account_purpose === "exchange_gain" || l.account_purpose === "exchange_loss");
    const papelEfectivo = esRedondeoDeCierre ? PAPEL_REDONDEO : l.account_purpose;
    const cuentaId = cuentaDe.get(papelEfectivo);
    if (cuentaId === undefined) {
      papelesSinCuenta.add(papelEfectivo);
      continue;
    }

    if (l.side === "debit") debeExacto = debeExacto.plus(absoluto);
    else haberExacto = haberExacto.plus(absoluto);
    // ADR-0075 §7: el importe funcional de toda línea va al céntimo, half-up. UN solo sitio.
    const alCentimo = toCents(absoluto);
    if (alCentimo.isZero()) continue;
    const money = Money.of(alCentimo.toFixed(2), input.functionalCurrency);
    if (!money.ok) return err({ code: "VALIDATION_FAILED", message: money.error.message });
    const cero = Money.of("0", input.functionalCurrency);
    if (!cero.ok) return err({ code: "VALIDATION_FAILED", message: cero.error.message });
    lineas.push({
      accountId: cuentaId,
      debit: l.side === "debit" ? money.value : cero.value,
      credit: l.side === "credit" ? money.value : cero.value,
      description: esRedondeoDeCierre
        ? "Diferencias por redondeo: a la tasa del documento no hay diferencial (ADR-0075 §4)"
        : l.description,
    });
    originales.push(originalDe.get(l.account_purpose) ?? null);
    papelDeLinea.push(l.account_purpose);
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
  // EL RESIDUO DEL CÉNTIMO. Si lo exacto cuadra, lo redondeado difiere a lo sumo medio céntimo
  // por línea, y esa diferencia va a «Diferencias por redondeo» en el MISMO asiento. Si lo
  // exacto no cuadra, no se tapa nada: sigue el ENTRY_UNBALANCED de abajo con la cifra real.
  if (debeExacto.equals(haberExacto) && lineas.length > 0) {
    let debe = debeExacto.minus(debeExacto);
    let haber = debe;
    for (const l of lineas) {
      debe = debe.plus(l.debit.amount);
      haber = haber.plus(l.credit.amount);
    }
    const residuo = debe.minus(haber);
    if (!residuo.isZero()) {
      const cuentaRedondeo = cuentaDe.get(PAPEL_REDONDEO);
      if (cuentaRedondeo === undefined) {
        return encolar(
          sql,
          input,
          `Falta configurar la cuenta de: ${PAPEL_REDONDEO}. El asiento tiene un residuo de redondeo de ${residuo.abs().toFixed(2)} que va a «Diferencias por redondeo».`,
        );
      }
      const importe = Money.of(residuo.abs().toFixed(2), input.functionalCurrency);
      const cero = Money.of("0", input.functionalCurrency);
      if (!importe.ok || !cero.ok) {
        return err({ code: "VALIDATION_FAILED", message: "Residuo de redondeo no representable." });
      }
      lineas.push({
        accountId: cuentaRedondeo,
        debit: residuo.isNegative() ? importe.value : cero.value,
        credit: residuo.isNegative() ? cero.value : importe.value,
        description: "Diferencias por redondeo (ADR-0075 §7)",
      });
    }
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

  /**
   * LAS LÍNEAS DEL ASIENTO, EN UNA SOLA SENTENCIA (2026-09-10). Antes una por
   * línea, y el driver serializa dentro de la transacción: tres líneas eran
   * tres esperas de red. Los importes viajan como TEXTO y `jsonb_to_recordset`
   * los pasa a `numeric` en el servidor — no tocan un `double` (regla 7), y
   * cada valor es el mismo string que producía el bucle.
   *
   * El `order by line_number` preserva el orden exacto, que es el que la
   * partida doble y los tests leen.
   */
  const lineasDeCartera = papelDeLinea.filter((p) => p !== null && PAPELES_CARTERA.has(p)).length;
  const filasAsiento = lineas.map((l, i) => {
    const importe = l.debit.amount.isZero() ? l.credit : l.debit;
    const base = {
      line_number: i + 1,
      account_id: l.accountId,
      functional_debit: l.debit.toAmountString(),
      functional_credit: l.credit.toAmountString(),
      importe: importe.toAmountString(),
      description: l.description,
    };
    // La línea de una caja en divisa (E-11): débito y crédito van en la moneda de la
    // transacción (ADR-0020), y la tasa es la que une el original con lo funcional.
    const o = originales[i] ?? null;
    const original = o === null ? null : parseDecimal(o.importe);
    if (o !== null && original !== null && original.ok && original.value.greaterThan(0)) {
      const tasa = importe.amount.dividedBy(original.value).toDecimalPlaces(8, 4);
      if (tasa.greaterThan(0)) {
        const orig = original.value.toFixed(8);
        return {
          ...base,
          debit_amount: l.debit.amount.isZero() ? "0" : orig,
          credit_amount: l.credit.amount.isZero() ? "0" : orig,
          original: orig,
          moneda: o.moneda,
          tasa: tasa.toFixed(8),
          fuente: o.fuente,
          hora: o.hora,
        };
      }
    }
    /**
     * H6 (ADR-0075 §6): la línea de CARTERA de un documento en divisa. Moneda y tasa, las del
     * DOCUMENTO. El original es el que `platform.settlement_original_of` dice para ESTE hecho,
     * DETERMINISTA: el total del documento, lo que el cobro o el pago saldó, el neto de retención
     * de la factura de compra. Sin umbral ni «si se parece»: así la suma de los originales de la
     * cartera de un documento saldado es cero exacto. Si el hecho no tiene original conocido (la
     * función no devuelve importe), la línea va en moneda funcional. Nunca se mueve el importe
     * funcional: es el que cuadra el asiento. Si la plantilla de una empresa pone DOS líneas de
     * cartera en el mismo asiento, ninguna toma el original (no hay cómo repartirlo).
     */
    const papel = papelDeLinea[i] ?? null;
    if (
      papel !== null &&
      PAPELES_CARTERA.has(papel) &&
      lineasDeCartera === 1 &&
      cartera !== null &&
      cartera.moneda !== null &&
      cartera.moneda !== input.functionalCurrency &&
      cartera.tasa_doc !== null &&
      cartera.original !== null
    ) {
      const tasaDoc = parseDecimal(cartera.tasa_doc);
      const exacto = parseDecimal(cartera.original);
      if (tasaDoc.ok && tasaDoc.value.greaterThan(0) && exacto.ok && exacto.value.greaterThan(0)) {
        const orig = exacto.value.toFixed(8);
        return {
          ...base,
          debit_amount: l.debit.amount.isZero() ? "0" : orig,
          credit_amount: l.credit.amount.isZero() ? "0" : orig,
          original: orig,
          moneda: cartera.moneda,
          tasa: tasaDoc.value.toFixed(8),
          fuente: cartera.fuente_tasa ?? "documento",
          hora: cartera.hora_tasa,
        };
      }
    }
    return {
      ...base,
      debit_amount: base.functional_debit,
      credit_amount: base.functional_credit,
      original: base.importe,
      moneda: input.functionalCurrency,
      tasa: "1",
      fuente: "identidad",
      hora: null,
    };
  });
  await sql`
    insert into public.journal_lines
      (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
       description)
    select ${input.tenantId}, ${input.companyId}, ${asiento!.id}, x.line_number, x.account_id,
           x.debit_amount, x.credit_amount,
           x.original, x.moneda, x.tasa,
           x.importe, ${input.functionalCurrency}, x.fuente, coalesce(x.hora, now()),
           x.functional_debit, x.functional_credit, x.description
      from jsonb_to_recordset(${sql.json(filasAsiento)}::jsonb) as x(
        line_number integer, account_id uuid, debit_amount numeric, credit_amount numeric,
        functional_debit numeric, functional_credit numeric, original numeric, moneda text,
        tasa numeric, fuente text, hora timestamptz, importe numeric, description text)
     order by x.line_number`;

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
  if (input.backlink !== undefined) {
    /**
     * Una tabla que no está en NINGUNA de las dos listas es un olvido, y se rompe aquí. El
     * silencio es lo que dejó `treasury_transfers` sin enlace al añadirla (migración 61): el
     * hecho quedaba con su asiento posteado y, para `accounting_coverage_gaps`, sin asiento.
     * Lo cazó el invariante cruzado, no esta función — y un hueco que solo ve el invariante
     * es un hueco que puede llegar a producción entre dos corridas.
     */
    if (
      !TABLAS_BACKLINK.has(input.backlink.table) &&
      !TABLAS_SIN_BACKLINK.has(input.backlink.table)
    ) {
      throw new Error(
        `backlink a una tabla no declarada: ${input.backlink.table}. Declárala en ` +
          `TABLAS_BACKLINK (si admite el UPDATE de solo-enlace) o en TABLAS_SIN_BACKLINK.`,
      );
    }
    if (TABLAS_BACKLINK.has(input.backlink.table)) {
      await sql`
        update ${sql.unsafe(`public.${input.backlink.table}`)}
           set journal_entry_id = ${posteado!.id}
         where id = ${input.backlink.id} and company_id = ${input.companyId}`;
    }
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

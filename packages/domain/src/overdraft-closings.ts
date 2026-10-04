import type { TransactionSql } from "@ladino/db";
import { minorUnitsOf, parseDecimal, toCents } from "@ladino/money";
import { contraAsiento } from "./accounting.js";
import { RULES_VERSION } from "./create-company.js";
import { diaNegocio } from "./dia-negocio.js";
import { generateJournalFromDocument } from "./journal-generator.js";
import {
  CASH_CLOSING_EVENT,
  CASH_CLOSING_KIND,
  CASH_CLOSING_OVERDRAFT_KIND,
  SYSTEM_POSTER_ID,
  hechoContableDelCierre,
} from "./treasury.js";

export type OverdraftClosingsRepair = {
  readonly company_id: string;
  /** Los cierres reclasificados: el asiento viejo (reversado), su reversa y el asiento nuevo. */
  readonly reclassified: {
    readonly cash_closing_id: string;
    readonly posting_date: string;
    readonly reversed_entry_id: string;
    readonly reversal_entry_id: string;
    readonly new_entry_id: string;
    readonly owner_contribution: string;
  }[];
  /**
   * Los cierres que ESPERABAN EN LA COLA con el origen de siempre: la fila vieja se descarta con
   * acta y el hecho se genera con el origen del sobregiro (asentado, o encolado otra vez si a la
   * empresa le sigue faltando una cuenta).
   */
  readonly requeued: {
    readonly cash_closing_id: string;
    readonly discarded_queue_id: string;
    readonly accounting: "posted" | "queued";
    readonly new_entry_id: string | null;
    readonly owner_contribution: string;
  }[];
};

const MOTIVO =
  "J-02: el sobregiro que se cubre al cerrar la caja es dinero del dueño (pasivo), no un ingreso.";

interface CierreViejo {
  id: string;
  tenant_id: string;
  cuenta: string;
  subcuenta: string | null;
  esperado: string;
  funcional: string;
  tasa: string;
  moneda_caja: string;
  moneda_funcional: string;
  fecha: string;
}

/**
 * El hecho contable de un cierre viejo en sobregiro, con la MISMA definición que usa el cierre
 * (`hechoContableDelCierre`). La diferencia funcional entra AL CÉNTIMO (`toCents`, ADR-0075 §7),
 * como la calcula hoy `closeCashRegister`: un cierre anterior a ADR-0063 §6 puede guardar su
 * `functional_amount` con más de dos decimales, y ni el asiento nuevo ni el contexto que vuelve a
 * la cola llevan esa fracción.
 */
function hechoDe(c: CierreViejo) {
  const esperado = parseDecimal(c.esperado);
  const funcional = parseDecimal(c.funcional);
  const tasa = parseDecimal(c.tasa);
  if (!esperado.ok || !funcional.ok || !tasa.ok) {
    throw new Error(`cierre ${c.id}: importes no interpretables`);
  }
  const hecho = hechoContableDelCierre(
    esperado.value,
    toCents(funcional.value),
    tasa.value,
    minorUnitsOf(c.moneda_funcional),
    minorUnitsOf(c.moneda_caja),
  );
  if (hecho.sourceKind !== CASH_CLOSING_OVERDRAFT_KIND) {
    throw new Error(`cierre ${c.id}: lo esperado no es negativo; no es un cierre en sobregiro`);
  }
  return hecho;
}

function generar(
  sql: TransactionSql,
  companyId: string,
  c: CierreViejo,
  hecho: ReturnType<typeof hechoDe>,
  postedBy: string,
) {
  return generateJournalFromDocument(sql, {
    tenantId: c.tenant_id,
    companyId,
    sourceKind: hecho.sourceKind,
    sourceEvent: CASH_CLOSING_EVENT,
    sourceId: c.id,
    postingDate: c.fecha,
    postedBy,
    description: `Cierre de caja ${c.cuenta}: ${hecho.palabra}`,
    functionalCurrency: c.moneda_funcional,
    amounts: hecho.amounts,
    backlink: { table: "cash_closings", id: c.id },
  });
}

export type RequeuedOverdraftClosing = OverdraftClosingsRepair["requeued"][number] & {
  /** Por qué volvió a la cola, si volvió. */
  readonly reason: string | null;
};

/**
 * LA RAMA B, PARA UNA FILA DE LA COLA: el cierre en sobregiro que espera con el origen de siempre.
 * Una sola implementación, con dos llamadores:
 *   · la reparación (`repairOverdraftClosings`), que la corre el dueño de la base y firma el sistema;
 *   · «contabilizar pendientes» (`reprocessPendingJournals`), que la corre una persona. Sin esto,
 *     entre el git pull y la reparación ese botón asentaba el cierre como INGRESO con el origen que
 *     traía la fila: la ventana quedaba al orden manual de R-71. Ahora no existe.
 *
 * Decide con `hechoContableDelCierre` leyendo el CIERRE, no la fila: si lo esperado no es negativo
 * (o la fila no es de un cierre, o ya no está pendiente) devuelve `null` y no escribe nada. Si lo
 * es, descarta la fila con su acta (`accounting.pending_discarded`), genera el hecho con el origen
 * del sobregiro —asentado, o encolado otra vez con el origen y los importes correctos— y deja el
 * acta `treasury.overdraft_closing_reclassified`. Lanza si el generador falla: quien llama deshace.
 */
export async function requeueOverdraftClosingFromQueue(
  sql: TransactionSql,
  companyId: string,
  queueId: string,
  quien: { readonly postedBy: string; readonly actorType: "user" | "system" },
): Promise<RequeuedOverdraftClosing | null> {
  const hoy = diaNegocio(new Date());
  const [c] = await sql<(CierreViejo & { queue_id: string })[]>`
    select c.id, c.tenant_id, q.id as queue_id, ca.name as cuenta,
           ca.ledger_account_id as subcuenta,
           round(c.expected_amount, platform.currency_minor_units(c.transaction_currency))::text
             as esperado,
           c.functional_amount::text as funcional, c.fx_rate::text as tasa,
           c.transaction_currency as moneda_caja, c.functional_currency as moneda_funcional,
           -- El día del cierre si su período sigue abierto; si no, hoy. Fecha contra fecha (date).
           (case when platform.accounting_date_for(${companyId}, c.closing_date) = c.closing_date
                 then c.closing_date else ${hoy}::date end)::text as fecha
      from public.journal_generation_queue q
      join public.cash_closings c on c.company_id = q.company_id and c.id = q.source_id
      join public.company_accounts ca on ca.id = c.account_id
     where q.id = ${queueId} and q.company_id = ${companyId}
       and q.source_kind = ${CASH_CLOSING_KIND} and q.status = 'pending'
       and round(c.expected_amount, platform.currency_minor_units(c.transaction_currency)) < 0
       for update of c, q`;
  if (!c) return null;

  const hecho = hechoDe(c);
  await sql`
    update public.journal_generation_queue
       set status = 'discarded', processed_at = now()
     where id = ${c.queue_id} and company_id = ${companyId} and status = 'pending'`;
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${c.tenant_id}, ${companyId}, 'company', ${companyId},
            'accounting.pending_discarded', ${quien.actorType}, now(), ${RULES_VERSION},
            ${sql.json({
              queue_id: c.queue_id,
              source_kind: CASH_CLOSING_KIND,
              source_id: c.id,
              source_event: CASH_CLOSING_EVENT,
              reason: MOTIVO,
              hallazgo: "J-02",
            })})`;
  const generado = await generar(sql, companyId, c, hecho, quien.postedBy);
  if (!generado.ok) throw new Error(`cierre ${c.id}: ${generado.error.message}`);
  const fila = {
    cash_closing_id: c.id,
    discarded_queue_id: c.queue_id,
    accounting: generado.value.kind === "queued" ? ("queued" as const) : ("posted" as const),
    new_entry_id: generado.value.kind === "queued" ? null : generado.value.entryId,
    owner_contribution: hecho.amounts.owner_contribution ?? "0",
  };
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${c.tenant_id}, ${companyId}, 'cash_closing', ${c.id},
            'treasury.overdraft_closing_reclassified', ${quien.actorType}, now(), ${RULES_VERSION},
            ${sql.json({ hallazgo: "J-02", motivo: MOTIVO, desde_la_cola: true, ...fila })})`;
  return { ...fila, reason: generado.value.kind === "queued" ? generado.value.reason : null };
}

/**
 * LA REPARACIÓN J-02 ES LA ÚLTIMA (R-71, paso 8), Y SE NIEGA CON PALABRAS SI NO LO ES. Sin esto,
 * corrida antes que las otras NO fallaba: reversaba y asentaba sobre un mayor que todavía tiene
 * fracciones heredadas o cajas sin su subcuenta, y el orden quedaba a la disciplina de quien la
 * corre. Solo se comprueba cuando la empresa tiene algo que reclasificar: una empresa sin cierres
 * en sobregiro no se detiene por esto.
 *
 * Lo miden los invariantes de las reparaciones anteriores, no una marca: `cent_gaps` en cero es
 * que la regularización del céntimo corrió (ADR-0075 §7); que ninguna caja esté sin subcuenta
 * propia y hoja es que corrió la de ADR-0070 (`treasury_ledger_gaps`, sus tres problemas de forma).
 */
async function exigirElOrdenDeR71(sql: TransactionSql, companyId: string): Promise<void> {
  const [n] = await sql<{ centimo: number; subcuentas: number }[]>`
    select (select count(*)::int from platform.cent_gaps(${companyId})) as centimo,
           (select count(*)::int from platform.treasury_ledger_gaps(${companyId})
             where problem in ('sin_subcuenta', 'no_es_hoja', 'compartida')) as subcuentas`;
  if ((n?.centimo ?? 0) > 0) {
    throw new Error(
      `reparación J-02 de ${companyId}: el mayor tiene ${n!.centimo} importe(s) con fracción de céntimo. Corre ANTES la regularización del céntimo (scripts/reparar/adr-0075-centimo.mjs) y vuelve a correr esta reparación, que es la última.`,
    );
  }
  if ((n?.subcuentas ?? 0) > 0) {
    throw new Error(
      `reparación J-02 de ${companyId}: ${n!.subcuentas} caja(s) no tienen todavía su subcuenta contable propia. Corre ANTES la reparación de subcuentas de tesorería (scripts/reparar/adr-0070-subcuentas.mjs) y vuelve a correr esta reparación, que es la última.`,
    );
  }
}

/**
 * REPARACIÓN J-02: LOS CIERRES EN SOBREGIRO QUE YA SE ASENTARON —O SE ENCOLARON— COMO INGRESO.
 *
 * Hasta la migración 20261004180000, cerrar una caja en negativo asentaba D caja / H «Faltantes
 * y sobrantes de caja» (resultado). Un cierre con lo esperado EN NEGATIVO (menor que cero en las
 * unidades mínimas de la moneda de la caja) no puede tener vigente el origen `cash_closing`, ni
 * posteado ni en la cola: es el enunciado de `platform.overdraft_closing_gaps`, y esta reparación
 * es lo que lo lleva a cero.
 *
 * A. EL QUE TIENE ASIENTO POSTEADO (regla 2: no se edita):
 *   1. su REVERSA, por `contraAsiento` —la única implementación del contra-asiento: al céntimo,
 *      con su línea de redondeo si el original trae fracción (LAD71), en la moneda de cada línea—.
 *      Una línea asentada en una cuenta que hoy AGRUPA (la caja de familia anterior a ADR-0070) se
 *      reversa en la subcuenta actual de esa caja, que es donde está hoy su saldo;
 *   2. el asiento NUEVO con el origen `cash_closing_overdraft` y el evento de siempre —la misma
 *      definición que usa el cierre (`hechoContableDelCierre`) y la plantilla de la empresa—, con
 *      el enlace de vuelta al cierre. Encolado no vale aquí: sería media reparación;
 *   3. un acta `treasury.overdraft_closing_reclassified`.
 *
 * B. EL QUE ESPERA EN LA COLA con el origen de siempre (lo encoló la API anterior): al importar
 *    pendientes se asentaría como ingreso —el defecto otra vez—. La fila se DESCARTA con su acta
 *    (`accounting.pending_discarded`) y el hecho se genera con el origen del sobregiro: se asienta
 *    si la empresa ya puede, y si no vuelve a la cola con el origen y los importes correctos.
 *
 * La caja queda igual: cambia la contrapartida, de resultado a «Cuentas por pagar a socios».
 *
 * LA FECHA, día contra día (Caracas): el día del cierre si su período está abierto, para que el
 * resultado de ese mes quede corregido en ese mes; si está cerrado, hoy. Si tampoco hoy se puede
 * postear, la base lo rechaza y la transacción entera se deshace.
 *
 * NADA A MEDIAS: si algo de A no se puede postear (falta la cuenta del papel `owner_payable`,
 * falta la plantilla), se LANZA y quien llama deshace la transacción; no queda una reversa sin su
 * asiento. Idempotente: la segunda vez no encuentra nada y no escribe nada.
 *
 * No es un caso de uso de la API: lo corre el dueño de la base con
 * `node scripts/reparar/j-02-sobregiro-al-cierre.mjs`, después del git pull (R-71, paso 8).
 */
export async function repairOverdraftClosings(
  sql: TransactionSql,
  companyId: string,
): Promise<OverdraftClosingsRepair> {
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const hoy = diaNegocio(new Date());

  // ── A. Los que tienen un asiento posteado del origen de siempre ────────────
  const posteados = await sql<(CierreViejo & { entry_id: string; descripcion: string })[]>`
    select c.id, c.tenant_id, e.id as entry_id, e.description as descripcion, ca.name as cuenta,
           ca.ledger_account_id as subcuenta,
           round(c.expected_amount, platform.currency_minor_units(c.transaction_currency))::text
             as esperado,
           c.functional_amount::text as funcional, c.fx_rate::text as tasa,
           c.transaction_currency as moneda_caja, c.functional_currency as moneda_funcional,
           -- El día del cierre si su período sigue abierto; si no, hoy. Fecha contra fecha (date).
           (case when platform.accounting_date_for(${companyId}, c.closing_date) = c.closing_date
                 then c.closing_date else ${hoy}::date end)::text as fecha
      from public.cash_closings c
      join public.company_accounts ca on ca.id = c.account_id
      join public.journal_entries e
        on e.company_id = c.company_id and e.source_id = c.id
       and e.source_kind = ${CASH_CLOSING_KIND} and e.status = 'posted'
     where c.company_id = ${companyId}
       and round(c.expected_amount, platform.currency_minor_units(c.transaction_currency)) < 0
     order by c.closed_at, c.id
       for update of c, e`;

  if (posteados.length > 0) await exigirElOrdenDeR71(sql, companyId);

  const reclasificados: OverdraftClosingsRepair["reclassified"][number][] = [];
  for (const c of posteados) {
    const hecho = hechoDe(c);

    // 1. La reversa: la canónica, al céntimo, posteada por el sistema.
    const reversa = await contraAsiento(sql, {
      tenantId: c.tenant_id,
      companyId,
      functionalCurrency: c.moneda_funcional,
      entryId: c.entry_id,
      description: c.descripcion,
      reason: MOTIVO,
      fecha: c.fecha,
      postedBy: SYSTEM_POSTER_ID,
      actorType: "system",
      cuentaSiAgrupa: c.subcuenta,
    });
    if (!reversa.ok) throw new Error(`cierre ${c.id}: ${reversa.error.message}`);

    // 2. El asiento nuevo, por la plantilla de la empresa. Encolado no vale: sería media reparación.
    const generado = await generar(sql, companyId, c, hecho, SYSTEM_POSTER_ID);
    if (!generado.ok) throw new Error(`cierre ${c.id}: ${generado.error.message}`);
    if (generado.value.kind === "queued") {
      throw new Error(
        `cierre ${c.id}: el asiento nuevo no se pudo postear. ${generado.value.reason}`,
      );
    }
    // La comprobación que no se delega: el cierre apunta al asiento nuevo, y este está posteado.
    const [enlace] = await sql<{ ok: boolean }[]>`
      select exists (select 1 from public.cash_closings k
                       join public.journal_entries n on n.id = k.journal_entry_id
                      where k.id = ${c.id} and n.id = ${generado.value.entryId}
                        and n.status = 'posted'
                        and n.source_kind = ${CASH_CLOSING_OVERDRAFT_KIND}) as ok`;
    if (!enlace?.ok) {
      throw new Error(`cierre ${c.id}: el enlace de vuelta no quedó en el asiento nuevo`);
    }

    const fila = {
      cash_closing_id: c.id,
      posting_date: c.fecha,
      reversed_entry_id: c.entry_id,
      reversal_entry_id: reversa.value.id,
      new_entry_id: generado.value.entryId,
      owner_contribution: hecho.amounts.owner_contribution ?? "0",
    };
    reclasificados.push(fila);
    // 3. El acta.
    await sql`
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      values (${c.tenant_id}, ${companyId}, 'cash_closing', ${c.id},
              'treasury.overdraft_closing_reclassified', 'system', now(), ${RULES_VERSION},
              ${sql.json({ hallazgo: "J-02", motivo: MOTIVO, ...fila })})`;
  }

  // ── B. Los que esperan en la cola con el origen de siempre ─────────────────
  // Fila a fila, por la MISMA función que usa «contabilizar pendientes».
  const encolados = await sql<{ queue_id: string }[]>`
    select q.id as queue_id
      from public.cash_closings c
      join public.journal_generation_queue q
        on q.company_id = c.company_id and q.source_id = c.id
       and q.source_kind = ${CASH_CLOSING_KIND} and q.status = 'pending'
     where c.company_id = ${companyId}
       and round(c.expected_amount, platform.currency_minor_units(c.transaction_currency)) < 0
     order by c.closed_at, c.id`;

  if (encolados.length > 0 && posteados.length === 0) await exigirElOrdenDeR71(sql, companyId);

  const reencolados: OverdraftClosingsRepair["requeued"][number][] = [];
  for (const { queue_id } of encolados) {
    const r = await requeueOverdraftClosingFromQueue(sql, companyId, queue_id, {
      postedBy: SYSTEM_POSTER_ID,
      actorType: "system",
    });
    if (r === null) continue;
    reencolados.push({
      cash_closing_id: r.cash_closing_id,
      discarded_queue_id: r.discarded_queue_id,
      accounting: r.accounting,
      new_entry_id: r.new_entry_id,
      owner_contribution: r.owner_contribution,
    });
  }

  // La comprobación final que no se delega: el invariante de esta empresa queda en cero.
  const [quedan] = await sql<{ n: number }[]>`
    select count(*)::int as n from platform.overdraft_closing_gaps(${companyId})`;
  if ((quedan?.n ?? 0) > 0) {
    throw new Error(
      `reparación J-02 de ${companyId}: quedan ${quedan!.n} cierre(s) en sobregiro con el origen de siempre`,
    );
  }
  return { company_id: companyId, reclassified: reclasificados, requeued: reencolados };
}

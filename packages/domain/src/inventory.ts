import { err, ok, type Result } from "@ladino/core";
import { diaNegocio } from "./dia-negocio.js";
import type { UnitOfWork, TransactionSql, JSONValue } from "@ladino/db";
import {
  CENTS_POLICY,
  Money,
  convert,
  makeFxRate,
  parseDecimal,
  roundForCost,
  toCents,
  toMonetaryFact,
  type Decimal,
  type MonetaryFact,
} from "@ladino/money";
import {
  adjust as costAdjust,
  issue as costIssue,
  positionOf,
  receive as costReceive,
  type Costed,
  type StockPosition,
} from "@ladino/inventory";
import { PERDIDA_REASONS, RETIRO_REASONS, USO_NO_GRAVADO_REASONS } from "@ladino/schemas";
import type {
  ReceiveStockRequest,
  IssueStockRequest,
  AdjustStockRequest,
  CountStockRequest,
  CountStockResponse,
  ExitReason,
  TransferStockRequest,
  InventoryMoveResponse,
  TransferResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import { generateJournalFromDocument } from "./journal-generator.js";
import { modoDeVenta } from "./modo-venta.js";

/**
 * Casos de uso de inventario (ADR-0034) — RIGOR MÁXIMO: dinero en una tabla
 * append-only.
 *
 * El costeo lo calcula `@ladino/inventory` (puro) y el esquema lo VERIFICA con su
 * propio oráculo (LAD41). Este módulo es el pegamento: autoriza, bloquea la
 * posición, convierte a moneda funcional con los siete campos de ADR-0020,
 * inserta el movimiento y audita. Ni una regla de costeo aquí.
 *
 * Los permisos de inventario son ACOTADOS (is_scoped): `companyScope` responde
 * «¿puede en ALGÚN almacén de esta company?» y hace falta además preguntar por
 * ESTE almacén — `ladino_user_has_scope`. Sin la segunda, un almacenista con
 * binding a un almacén movería todos.
 */
export type InventoryError =
  | CompanyScopeError
  | { code: "DUPLICATE"; message: string }
  | { code: "VALIDATION_FAILED"; message: string }
  // `productId`: el producto que no alcanza, cuando se sabe (I-04: la venta de un compuesto lo
  // usa para decir de qué compuesto es ingrediente).
  | { code: "NEGATIVE_STOCK"; message: string; productId?: string }
  | { code: "CONFLICT"; message: string }
  | { code: "EXCHANGE_RATE_MISSING"; message: string }
  | { code: "UNIT_CONVERSION_MISSING"; message: string };

const MOVE_COLUMNS = `id, company_id, warehouse_id, product_id, lot_id, kind,
  quantity::text as quantity,
  functional_amount::text as functional_amount, functional_currency,
  amount_transaction_currency::text as amount_transaction_currency, transaction_currency,
  fx_rate::text as fx_rate, rate_source,
  to_char(rate_timestamp at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as rate_timestamp,
  rounding_policy_id, unit_cost::text as unit_cost,
  quantity_after::text as quantity_after, value_after::text as value_after,
  to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at,
  reference, reason, exit_reason, transfer_id, source_document_id`;

interface Contexto {
  readonly tenantId: string;
  readonly functionalCurrency: string;
  readonly allowNegative: boolean;
}

/** Autorización company + ALCANCE por almacén, en ese orden (404 antes que 403). */
async function autorizar(
  sql: TransactionSql,
  userId: string,
  companyId: string,
  permiso: string,
  almacenes: readonly string[],
): Promise<Result<Contexto, InventoryError>> {
  const scope = await companyScope(sql, userId, companyId, permiso);
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  for (const almacen of almacenes) {
    const [alcance] = await sql<{ autorizado: boolean }[]>`
      select platform.ladino_user_has_scope(${userId}, ${permiso}, 'warehouse', ${almacen}) as autorizado`;
    if (!alcance?.autorizado) {
      return err({
        code: "PERMISSION_REQUIRED",
        message: `La operación exige el permiso ${permiso} sobre ese almacén concreto.`,
      });
    }
  }
  const [cfg] = await sql<{ moneda: string; negativo: boolean }[]>`
    select c.functional_currency_code as moneda,
           coalesce(s.allow_negative_stock, false) as negativo
      from public.companies c
      left join public.inventory_settings s on s.company_id = c.id
     where c.id = ${companyId}`;
  if (!cfg) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  return ok({
    tenantId: scope.value.tenantId,
    functionalCurrency: cfg.moneda,
    allowNegative: cfg.negativo,
  });
}

/**
 * El importe en moneda funcional CON los siete campos de ADR-0020 y la política
 * (ADR-0024). Un solo camino para moneda propia y ajena: la identidad es una
 * conversión con tasa 1 y fuente `identidad`, no un caso especial — un caso
 * especial es donde se cuela la incoherencia entre los siete campos.
 */
function hechoMonetario(
  importe: string,
  moneda: string,
  funcional: string,
  fx: { rate: string; source: string; at: string } | undefined,
  momento: string,
): Result<{ fact: MonetaryFact; funcionalMoney: Money }, InventoryError> {
  if (moneda !== funcional && fx === undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Una entrada en ${moneda} exige la tasa a ${funcional} con su fuente: sin fuente de tasa no se persiste (ADR-0020).`,
    });
  }
  const original = Money.of(importe, moneda);
  if (!original.ok) {
    return err({ code: "VALIDATION_FAILED", message: original.error.message });
  }
  const tasa = makeFxRate({
    from: moneda,
    to: funcional,
    rate: fx?.rate ?? "1",
    source: fx?.source ?? "identidad",
    // Sin conversión, el «momento de la tasa» es el del propio movimiento: no se
    // lee el reloj para inventar un instante distinto del hecho que se registra.
    timestamp: fx?.at ?? momento,
  });
  if (!tasa.ok) return err({ code: "VALIDATION_FAILED", message: tasa.error.message });
  const conversion = convert(original.value, tasa.value);
  if (!conversion.ok) return err({ code: "VALIDATION_FAILED", message: conversion.error.message });
  // C3 (ADR-0075 §7, ADR-0024): el importe funcional se redondea UNA vez, de lo exacto al céntimo
  // — round(round(x, 8), 2) ≠ round(x, 2) en el borde (0,004999996 → 0,00500000 → 0,01), y el
  // libro en SQL hace round(x, 2). La política que se persiste es la que produjo el número:
  // `ledger:cents:2:HALF_UP`. El costo unitario conserva la suya (inventory:cost:8:HALF_UP), que
  // no necesita columna: lo deriva el oráculo `apply_inventory_move` como valor / cantidad a 8.
  const redondeado = roundForCost(conversion.value.converted, CENTS_POLICY);
  if (!redondeado.ok) return err({ code: "VALIDATION_FAILED", message: redondeado.error.message });
  const fact = toMonetaryFact(conversion.value, redondeado.value);
  if (!fact.ok) return err({ code: "VALIDATION_FAILED", message: fact.error.message });
  return ok({ fact: fact.value, funcionalMoney: redondeado.value.value });
}

/**
 * Bloquea la posición y la devuelve como `StockPosition`. El bloqueo dura hasta el
 * commit: dos movimientos sobre la misma posición se serializan aquí, no en el
 * trigger, y el segundo calcula sobre lo que dejó el primero.
 */
async function bloquear(
  sql: TransactionSql,
  companyId: string,
  warehouseId: string,
  productId: string,
  lotId: string | null,
): Promise<Result<StockPosition, InventoryError>> {
  const [fila] = await sql<
    { quantity: string; value: string; currency_code: string; last_unit_cost: string }[]
  >`select * from platform.lock_stock_position(${companyId}, ${warehouseId}, ${productId}, ${lotId})`;
  if (!fila) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  const pos = positionOf({
    quantity: fila.quantity,
    value: fila.value,
    lastUnitCost: fila.last_unit_cost,
    currency: fila.currency_code,
  });
  if (!pos.ok) return err({ code: "VALIDATION_FAILED", message: pos.error.message });
  return ok(pos.value);
}

function cantidad(valor: string): Result<Decimal, InventoryError> {
  const d = parseDecimal(valor);
  if (!d.ok) return err({ code: "VALIDATION_FAILED", message: d.error.message });
  return ok(d.value);
}

interface Insercion {
  readonly tenantId: string;
  readonly companyId: string;
  readonly warehouseId: string;
  readonly productId: string;
  readonly lotId: string | null;
  readonly kind: string;
  readonly costed: Costed;
  readonly fact: MonetaryFact;
  /** null = «ahora» según el SERVIDOR. Ver `insertar`. */
  readonly occurredAt: string | null;
  readonly reference: string | null;
  readonly reason: string | null;
  /** El motivo de una salida con motivo (ADR-0078 §2): columna con CHECK. */
  readonly exitReason?: ExitReason | null;
  /** La referencia del soporte de una pérdida (RLIVA art. 14). */
  readonly exitEvidence?: string | null;
  readonly note: string | null;
  readonly transferId: string | null;
  readonly counterpartId: string | null;
  readonly id: string | null;
  /** Liga los movimientos de UN hecho (las N salidas de una receta). */
  readonly sourceDocumentId: string | null;
  /** Lo que la persona ESCRIBIÓ, si se sabe (migración 71). */
  readonly captureCurrency?: string | null;
  readonly captureMode?: string | null;
}

/**
 * El INSERT. Los importes de transacción llevan el SIGNO del movimiento: el hecho
 * monetario se calcula sobre el valor absoluto y aquí se orienta, para que
 * `sum(functional_amount)` reconstruya el valor de la posición.
 */
async function insertar(sql: TransactionSql, m: Insercion): Promise<InventoryMoveResponse> {
  const negativo = m.costed.move.quantity.isNegative();
  const signo = (v: string): string => (negativo ? `-${v}` : v);
  // ADR-0075 §7: en moneda PROPIA no hay conversión, y el importe de la transacción ES el
  // funcional (CHECK inventory_moves_identity_chk). Como el valor del movimiento va al céntimo,
  // el de la transacción también: antes llevaba el importe sin redondear (3 × 33,3333 = 99,9999
  // contra 100,00) y la base rechazaba la entrada con un 23514 que salía como 422 genérico.
  const identidad = m.fact.transactionCurrency === m.fact.functionalCurrency;
  const importeTransaccion = identidad
    ? m.costed.move.value.toAmountString()
    : signo(m.fact.amountTransactionCurrency);
  const [fila] = await sql<InventoryMoveResponse[]>`
    insert into public.inventory_moves
      (id, tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
       amount_transaction_currency, transaction_currency, fx_rate,
       functional_amount, functional_currency, rate_source, rate_timestamp,
       rounding_policy_id, unit_cost, quantity_after, value_after,
       occurred_at, reference, reason, note, transfer_id, counterpart_move_id,
       source_document_id, capture_currency, capture_mode, exit_reason, exit_evidence)
    values (coalesce(${m.id}::uuid, platform.uuidv7()), ${m.tenantId}, ${m.companyId},
            ${m.warehouseId}, ${m.productId}, ${m.lotId}, ${m.kind},
            ${m.costed.move.quantity.toFixed()},
            ${importeTransaccion}, ${m.fact.transactionCurrency}, ${m.fact.fxRate},
            ${m.costed.move.value.toAmountString()}, ${m.fact.functionalCurrency},
            ${m.fact.rateSource}, ${m.fact.rateTimestamp}, ${m.fact.roundingPolicyId},
            ${m.costed.move.unitCostAfter.toAmountString()},
            ${m.costed.move.quantityAfter.toFixed()},
            ${m.costed.move.valueAfter.toAmountString()},
            coalesce(${m.occurredAt}::timestamptz, now()), ${m.reference}, ${m.reason}, ${m.note},
            ${m.transferId}, ${m.counterpartId}, ${m.sourceDocumentId},
            ${m.captureCurrency ?? null}, ${m.captureMode ?? null}, ${m.exitReason ?? null},
            ${m.exitEvidence ?? null})
    returning ${sql.unsafe(MOVE_COLUMNS)}`;
  return fila!;
}

/** El payload del acta de un movimiento. Uno solo, para que la fila suelta y
 *  el lote no puedan divergir en lo que cuentan. */
function payloadDe(
  fila: InventoryMoveResponse,
  extra: Record<string, JSONValue> = {},
): Record<string, JSONValue> {
  return {
    warehouse_id: fila.warehouse_id,
    product_id: fila.product_id,
    lot_id: fila.lot_id,
    quantity: fila.quantity,
    functional_amount: fila.functional_amount,
    functional_currency: fila.functional_currency,
    unit_cost: fila.unit_cost,
    quantity_after: fila.quantity_after,
    rounding_policy_id: fila.rounding_policy_id,
    ...extra,
  };
}

/**
 * Las actas y los eventos de VARIOS movimientos, en una sentencia (2026-09-10).
 * Mismas filas y mismos payloads que uno a uno —los construye `payloadDe`, que
 * es el mismo de la versión suelta—, en el mismo orden, y con el acta antes
 * del evento como siempre.
 */
async function auditarYPublicarLote(
  sql: TransactionSql,
  filas: InventoryMoveResponse[],
  tenantId: string,
  evento: string,
): Promise<void> {
  if (filas.length === 0) return;
  const actas = filas.map((f, i) => ({
    orden: i + 1,
    move_id: f.id,
    company_id: f.company_id,
    payload: payloadDe(f, { reference: f.reference }),
  }));
  await sql`
    with datos as (
      select x.orden, x.move_id, x.company_id, x.payload
        from jsonb_to_recordset(${sql.json(actas)}::jsonb) as x(
          orden integer, move_id uuid, company_id uuid, payload jsonb)
    ), acta as (
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      select ${tenantId}, d.company_id, 'inventory_move', d.move_id, ${evento},
             'user', now(), ${RULES_VERSION}, d.payload
        from datos d order by d.orden
      returning 1
    )
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    select ${tenantId}, d.company_id, 'inventory_move', d.move_id, ${evento}, 1,
           jsonb_build_object('move_id', d.move_id) || d.payload
      from datos d
     where exists (select 1 from acta)
     order by d.orden`;
}

async function auditarYPublicar(
  sql: TransactionSql,
  fila: InventoryMoveResponse,
  tenantId: string,
  evento: string,
  extra: Record<string, JSONValue> = {},
): Promise<void> {
  const payload: Record<string, JSONValue> = {
    warehouse_id: fila.warehouse_id,
    product_id: fila.product_id,
    lot_id: fila.lot_id,
    quantity: fila.quantity,
    functional_amount: fila.functional_amount,
    functional_currency: fila.functional_currency,
    unit_cost: fila.unit_cost,
    quantity_after: fila.quantity_after,
    rounding_policy_id: fila.rounding_policy_id,
    ...extra,
  };
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${fila.company_id}, 'inventory_move', ${fila.id}, ${evento},
            'user', now(), ${RULES_VERSION}, ${sql.json(payload)})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${tenantId}, ${fila.company_id}, 'inventory_move', ${fila.id}, ${evento}, 1,
            ${sql.json({ move_id: fila.id, ...payload })})`;
}

/** Traduce lo que el esquema rechaza. LAD39 y LAD41 tienen mensaje propio. */
function traducir(e: unknown): InventoryError | null {
  const code = (e as { code?: string }).code;
  const message = (e as { message?: string }).message ?? "";
  if (code === "LAD39") {
    return {
      code: "NEGATIVE_STOCK",
      message: message.includes("inventory.negative")
        ? "La empresa permite existencia negativa, pero no tienes el permiso inventory.negative sobre ese almacén."
        : "La operación dejaría la existencia en negativo y la empresa no lo permite.",
    };
  }
  if (code === "LAD41" && message.includes("va al céntimo")) {
    // ADR-0075 §7: no es una carrera, es un importe con fracción de céntimo — reintentar no sirve.
    return {
      code: "VALIDATION_FAILED",
      message:
        "El valor de un movimiento de inventario va al céntimo (ADR-0075 §7): llegó un importe con más de dos decimales.",
    };
  }
  if (code === "LAD41") {
    return {
      code: "VALIDATION_FAILED",
      message:
        "El costeo calculado no coincide con el que verifica la base: la posición cambió durante la operación. Reintenta.",
    };
  }
  if (code === "LAD38") return { code: "VALIDATION_FAILED", message };
  // C-07 (20261005130200): la red del esquema bajo `resolverLote`. Un lote de un producto que
  // vence nace con su fecha; el mensaje de la guarda nombra el lote y el producto.
  if (code === "LAD73") {
    return {
      code: "VALIDATION_FAILED",
      message: "Este producto lleva lote y vencimiento: falta la fecha en que vence el lote.",
    };
  }
  // Las guardas de la factura de retiro y de su nota (20261005100800): su mensaje es de persona.
  if (code === "LAD72") return { code: "VALIDATION_FAILED", message };
  if (code === "23505") {
    return { code: "DUPLICATE", message: "Ya existe un movimiento con esa referencia." };
  }
  if (code === "23503") return { code: "NOT_FOUND", message: "Recurso no encontrado." };
  return null;
}

/**
 * El momento de la TASA cuando no hay conversión. No es el de la fila: `occurred_at`
 * lo pone el servidor si el cliente no lo declara (ver abajo), y no se puede
 * anticipar aquí sin volver a consultar la base.
 */
function ahora(occurredAt: string | undefined): string {
  return occurredAt ?? new Date().toISOString();
}

/** Crea el lote si hace falta (un lote aparece al recibir) y devuelve su id. */
async function resolverLote(
  sql: TransactionSql,
  ctx: Contexto,
  input: ReceiveStockRequest,
): Promise<Result<string | null, InventoryError>> {
  if (input.lot_id != null) return ok(input.lot_id);
  // C-07: la llegada PIDE el lote y su fecha cuando el producto los lleva. La red del esquema
  // (LAD38, «el movimiento exige lote») sigue debajo; aquí se dice con el nombre del producto y
  // antes de crear nada. La fecha solo se exige al lote NUEVO: uno que ya existe trae la suya.
  const [producto] = await sql<{ name: string; tracks_lots: boolean; tracks_expiry: boolean }[]>`
    select name, tracks_lots, tracks_expiry from public.products
     where id = ${input.product_id} and company_id = ${input.company_id}`;
  if (producto?.tracks_lots === true && input.lot_code === undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message: `«${producto.name}» lleva lote y vencimiento: escribe el código del lote y la fecha en que vence.`,
    });
  }
  if (input.lot_code === undefined) return ok(null);
  const [existente] = await sql<{ id: string }[]>`
    select id from public.lots
     where company_id = ${input.company_id} and product_id = ${input.product_id}
       and code = ${input.lot_code}`;
  if (existente) return ok(existente.id);
  if (producto?.tracks_expiry === true && input.lot_expires_at === undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message: `«${producto.name}» lleva lote y vencimiento: falta la fecha en que vence el lote «${input.lot_code}».`,
    });
  }
  try {
    const [creado] = await sql<{ id: string }[]>`
      insert into public.lots (tenant_id, company_id, product_id, code, expires_at)
      values (${ctx.tenantId}, ${input.company_id}, ${input.product_id}, ${input.lot_code},
              ${input.lot_expires_at ?? null})
      returning id`;
    return ok(creado!.id);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

/**
 * El costo TOTAL de una entrada dada POR UNIDAD: cantidad × costo unitario, a los 8 decimales
 * de `numeric(24,8)` (HALF_UP), igual que el inventario inicial del alta simple. Es la única
 * aritmética que la pantalla ya no hace (QA de pantalla 2026-09-15, h. 44).
 */
export function totalDeEntrada(
  unitAmount: string,
  quantity: string,
): Result<string, { code: "VALIDATION_FAILED"; message: string }> {
  const unitario = parseDecimal(unitAmount);
  const q = parseDecimal(quantity);
  if (!unitario.ok || !q.ok) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Cantidad o costo por unidad no interpretables.",
    });
  }
  // ADR-0075 §7: el valor de un movimiento va al céntimo; el costo unitario conserva sus 8.
  return ok(toCents(unitario.value.times(q.value)).toFixed(2));
}

/**
 * Y el camino inverso: el costo POR UNIDAD cuando la persona escribió el TOTAL de la línea
 * (ADR-0066). Se deriva en el SERVIDOR, a ocho decimales, porque dividir dinero en el cliente
 * es exactamente lo que la regla 7 prohíbe.
 */
export function unitarioDeEntrada(
  amount: string,
  quantity: string,
): Result<string, { code: "VALIDATION_FAILED"; message: string }> {
  const total = parseDecimal(amount);
  const q = parseDecimal(quantity);
  if (!total.ok || !q.ok || q.value.isZero()) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Cantidad o costo total no interpretables.",
    });
  }
  return ok(total.value.dividedBy(q.value).toDecimalPlaces(8, 4).toFixed(8));
}

export async function receiveStock(
  uow: UnitOfWork,
  input: ReceiveStockInput,
): Promise<Result<InventoryMoveResponse, InventoryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Mover existencias exige un usuario real.",
    });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "inventory.move", [
    input.warehouse_id,
  ]);
  if (!ctx.ok) return ctx;
  return ingresar(uow, actor.userId, ctx.value, input);
}

/**
 * La entrada al kardex, YA autorizada. `receiveStock` la usa tras pedir
 * `inventory.move`; la reposición de una venta anulada la usa con el permiso de
 * ANULAR, que es el que autoriza ese hecho (ADR-0061 §2).
 */
async function ingresar(
  uow: UnitOfWork,
  userId: string,
  ctxValue: Contexto,
  input: ReceiveStockInput,
): Promise<Result<InventoryMoveResponse, InventoryError>> {
  const { sql } = uow;
  const ctx = { ok: true as const, value: ctxValue };
  const actor = { userId };

  // OJO: el default NO es el reloj del cliente. `created_at` lo fija el trigger con
  // now(), que es la hora de INICIO DE TRANSACCIÓN, así que cualquier instante
  // calculado en Node después de abrirla es POSTERIOR y el CHECK
  // `occurred_at <= created_at` lo rechaza — siempre. Se manda null y decide el
  // servidor. (Lo destapó el primer test de integración, no un unitario.)
  const occurredAt = input.occurred_at ?? null;
  const momentoTasa = ahora(input.occurred_at);

  // Sin `fx` explícito, la tasa se RESUELVE de exchange_rates — la última
  // vigente a la fecha del movimiento (día Caracas), con su fuente citada:
  // la MISMA semántica y la misma consulta que usan las ventas. La tasa
  // oficial llega sola cada día (refresco BCV), así que el camino feliz ya
  // no pide tasa a nadie. `fx` explícito solo llega de llamantes internos que
  // pasan la tasa congelada de su documento (la API lo rechaza: ADR-0064 §1). El movimiento congela tasa, fuente
  // y monto original: el histórico del diferencial queda entero.
  let fx = input.fx;
  if (fx === undefined && input.currency !== ctx.value.functionalCurrency) {
    const [t] = await sql<{ rate: string; source: string | null; at: string }[]>`
      select f.rate::text as rate, f.source,
             to_char(f.rate_timestamp at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
        from platform.rate_for(${input.company_id}, ${input.currency},
               ${ctx.value.functionalCurrency},
               ((${momentoTasa}::timestamptz) at time zone 'America/Caracas')::date) f`;
    if (!t) {
      return err({
        code: "EXCHANGE_RATE_MISSING",
        message: `No hay tasa BCV de ${input.currency} a ${ctx.value.functionalCurrency} para esa fecha. Tráela en Mi dinero.`,
      });
    }
    fx = { rate: t.rate, source: t.source ?? "manual", at: t.at };
  }

  const hecho = hechoMonetario(
    input.amount,
    input.currency,
    ctx.value.functionalCurrency,
    fx,
    momentoTasa,
  );
  if (!hecho.ok) return hecho;
  const q = cantidad(input.quantity);
  if (!q.ok) return q;

  const lote = await resolverLote(sql, ctx.value, input);
  if (!lote.ok) return lote;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const posicion = await bloquear(
    sql,
    input.company_id,
    input.warehouse_id,
    input.product_id,
    lote.value,
  );
  if (!posicion.ok) return posicion;

  const costed = costReceive(posicion.value, q.value, hecho.value.funcionalMoney);
  if (!costed.ok) return err({ code: "VALIDATION_FAILED", message: costed.error.message });

  let fila: InventoryMoveResponse;
  try {
    fila = await sql.savepoint((sp) =>
      insertar(sp, {
        tenantId: ctx.value.tenantId,
        companyId: input.company_id,
        warehouseId: input.warehouse_id,
        productId: input.product_id,
        lotId: lote.value,
        kind: "entrada",
        costed: costed.value,
        fact: hecho.value.fact,
        occurredAt,
        reference: input.reference ?? null,
        reason: null,
        note: input.note ?? null,
        transferId: null,
        counterpartId: null,
        id: null,
        sourceDocumentId: input.sourceDocumentId ?? null,
        // Lo que la persona escribió (migración 71): la moneda y si dio el costo de cada uno o el
        // total. Lo derivado ya está en el importe; esto dice cuál era el original.
        captureCurrency: input.capture_currency ?? null,
        captureMode: input.capture_mode ?? null,
      }),
    );
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
  await auditarYPublicar(sql, fila, ctx.value.tenantId, input.evento ?? "stock.received", {
    reference: fila.reference,
  });
  if (input.accounting !== "document") {
    const contable = await asentarMovimiento(sql, actor.userId, ctx.value, fila, {
      sourceKind: "stock_opening",
      evento: "stock.received",
      descripcion: `Entrada de existencias${fila.reference ? `: ${fila.reference}` : ""}`,
      amounts: { functional_amount: fila.functional_amount },
    });
    if (!contable.ok) return contable;
  }
  return ok(fila);
}

/**
 * `sourceDocumentId` NO está en el contrato Zod a propósito: no lo manda un
 * cliente, lo pone el caso de uso que agrupa varios movimientos en un hecho
 * (consumeRecipe hoy; la factura de venta mañana).
 */
export type IssueStockInput = Omit<IssueStockRequest, "reason"> & {
  /** Obligatorio en la salida suelta (ADR-0078 §2); la receta no lo lleva: es costo de ventas. */
  readonly reason?: ExitReason;
  readonly sourceDocumentId?: string;
  /** Por omisión, salida directa (consumo interno); la receta la declara costo de ventas. */
  readonly accountingSource?: OrigenSalida;
  /**
   * ADR-0082: quien emite la FACTURA DE RETIRO. Inventario no importa ventas (ventas ya importa
   * inventario): la emisión se inyecta. Un retiro gravado de una empresa que factura SIN este
   * emisor se rechaza: no existe el retiro sin su factura (RLIVA art. 31).
   */
  readonly facturarRetiro?: FacturarRetiro;
};

/** La factura de retiro ya emitida, tal como la devuelve la salida. */
export interface FacturaDeRetiroEmitida {
  readonly id: string;
  readonly series: string;
  readonly number: string;
  readonly control_number: string | null;
  readonly subtotal_amount: string;
  readonly tax_amount: string;
  readonly total_amount: string;
  readonly currency: string;
}
export type FacturarRetiro = (a: {
  readonly companyId: string;
  readonly warehouseId: string;
  readonly productId: string;
  readonly quantity: string;
  readonly moveId: string;
  readonly motivo: string;
  readonly fecha: string;
}) => Promise<Result<FacturaDeRetiroEmitida, InventoryError>>;

/**
 * AF3-04 (RLIVA art. 14): la evidencia de una pérdida dice algo. «abc» no es un soporte: se piden
 * al menos diez caracteres y dos palabras (un acta con su número, una foto con su fecha).
 */
export function evidenciaSuficiente(evidencia: string | null): boolean {
  if (evidencia === null) return false;
  const limpia = evidencia.trim();
  return (
    limpia.length >= 10 && limpia.split(/\s+/).filter((p) => /[\p{L}\p{N}]/u.test(p)).length >= 2
  );
}
/**
 * AF5-07: una salida NO gravada (uso en el negocio, activo fijo, inmueble del negocio) sale sin
 * débito y sin documento; lo único que la separa de un consumo propio sin IVA es que diga adónde
 * fue. Misma regla que la evidencia de una pérdida, y se guarda en el mismo sitio.
 */
export const MENSAJE_DESTINO =
  "Esta salida no lleva IVA porque la mercancía se queda en el negocio: di adónde fue, con al menos dos palabras y diez caracteres —por ejemplo «Cloro para la limpieza del local» o «Estante para el depósito de la sede»—.";
/**
 * AF5-02: el retiro gravado emite una factura fiscal y gasta un número de control. Lo registra
 * quien puede facturar. El corchete es la marca que `personaDePermiso` (apps/api) reconoce para
 * dar este mismo texto a la persona en vez del genérico del permiso.
 */
export const MENSAJE_RETIRO_EXIGE_FACTURAR =
  "Este retiro emite una factura a nombre de tu negocio: lo registra quien puede facturar. [inventory.withdrawal_invoice: exige sales.invoice.issue]";
/** AF5-08 (RLIVA art. 57): correlativo y fecha van juntos; la factura de retiro es de hoy. */
export const MENSAJE_RETIRO_ES_DE_HOY =
  "Una factura de retiro lleva la fecha de hoy: registra el retiro sin fecha, o con la de hoy.";
export const MENSAJE_EVIDENCIA =
  "Una merma, rotura, vencimiento o faltante necesita su evidencia: describe el soporte con al menos dos palabras y diez caracteres —por ejemplo «Acta 0012 del 03/10/2026» o «Foto del lote vencido, 03/10»— (RLIVA art. 14).";

/**
 * EL ASIENTO DE UN MOVIMIENTO SUELTO (ADR-0060 §2), en la misma transacción. Un
 * movimiento que cambia el valor del inventario sin asiento ni cola es un hueco
 * de `inventory_coverage_gaps`; con plantilla, el mayor lo refleja al instante.
 * El hecho se identifica por el MOVIMIENTO (source_id), así que cada uno es
 * idempotente por sí mismo.
 */
async function asentarMovimiento(
  sql: TransactionSql,
  userId: string,
  ctx: Contexto,
  fila: InventoryMoveResponse,
  hecho: {
    readonly sourceKind: "stock_opening" | OrigenSalida;
    readonly evento:
      | "stock.received"
      | "stock.shipped"
      | "stock.shrinkage"
      | "stock.withdrawn"
      // AF3-03 (20261005100400): las salidas no gravadas, cada una a su papel.
      | "stock.used_in_business"
      | "stock.capitalized"
      // 20261005100900: el reingreso de un retiro corregido, con nombre propio (su plantilla
      // acredita «gasto por retiro»: no puede compartir el nombre de una entrada cualquiera).
      | "stock.withdrawal_returned";
    readonly descripcion: string;
    readonly amounts: {
      readonly functional_amount?: string;
      readonly cost_amount?: string;
      readonly tax_amount?: string;
    };
  },
): Promise<Result<true, InventoryError>> {
  // Un movimiento sin valor (costo cero) no mueve el mayor: no hay nada que asentar.
  // El débito fiscal de un retiro de costo cero sí se asienta: el libro lo lleva.
  const valor = parseDecimal(fila.functional_amount);
  const impuesto = parseDecimal(hecho.amounts.tax_amount ?? "0");
  if (valor.ok && valor.value.isZero() && impuesto.ok && impuesto.value.isZero()) return ok(true);
  const generado = await generateJournalFromDocument(sql, {
    tenantId: ctx.tenantId,
    companyId: fila.company_id,
    sourceKind: hecho.sourceKind,
    sourceEvent: hecho.evento,
    sourceId: fila.id,
    postingDate: diaNegocio(fila.occurred_at),
    postedBy: userId,
    description: hecho.descripcion,
    functionalCurrency: ctx.functionalCurrency,
    amounts: hecho.amounts,
  });
  if (!generado.ok) return err({ code: "VALIDATION_FAILED", message: generado.error.message });
  return ok(true);
}

/**
 * SALIDA DE VARIAS LÍNEAS EN UN SOLO VIAJE (2026-09-10).
 *
 * `issueStock` repetía por línea la autorización, el `set_config`, el bloqueo,
 * el insert y su acta+evento: siete esperas de red por renglón, y el driver
 * las serializa dentro de la transacción. Una venta de cuatro líneas gastaba
 * ahí ~28 de sus ~140 sentencias.
 *
 * LO QUE NO CAMBIA, y es lo único que importa:
 *
 *   · **el costeo es idéntico al del bucle**. `issue()` devuelve la posición
 *     RESULTANTE y aquí se encadena en memoria, así que la segunda línea del
 *     mismo producto ve la posición que dejó la primera — exactamente como
 *     cuando cada línea releía el saldo de la base;
 *   · **el oráculo sigue vigilando**. `apply_inventory_move` es un trigger
 *     `before insert … for each row` que verifica cada fila contra el saldo
 *     del momento y actualiza la posición en el mismo disparo. En un insert
 *     múltiple cada fila ve lo que dejó la anterior, y si este cálculo se
 *     desviara un céntimo, LAD41 lo rechaza en vez de escribirlo;
 *   · **el bloqueo se toma en orden determinista** (por producto y lote), que
 *     es MÁS seguro que el bucle actual: hoy se bloquea en el orden del
 *     carrito, y dos cajas con los mismos productos en distinto orden pueden
 *     abrazarse. Aquí no.
 *
 * Devuelve los movimientos en el MISMO orden de las líneas recibidas.
 */
export interface IssueStockLine {
  readonly product_id: string;
  readonly quantity: string;
  readonly lot_id?: string | null;
}
export interface IssueStockBatchInput {
  readonly company_id: string;
  readonly warehouse_id: string;
  readonly lines: readonly IssueStockLine[];
  /**
   * NO hay `reference` en el lote, y no es un olvido: `inventory_moves` la
   * lleva UNICA por empresa, asi que N movimientos no pueden compartirla — lo
   * destapo el primer test que lo intento. El vinculo del lote con su origen
   * es `sourceDocumentId`, que si admite varios movimientos.
   */
  readonly note?: string | null;
  readonly occurred_at?: string | undefined;
  readonly sourceDocumentId?: string | undefined;
}

/**
 * FEFO OBLIGATORIO EN LA SALIDA SIN LOTE (ADR-0060 §3, migración 57).
 *
 * Una línea sin lote de un producto que se lleva por lotes descontaba del lote
 * NULO —vacío por construcción— y la venta moría en NEGATIVE_STOCK con la
 * mercancía en el depósito (V1). Aquí esa línea se reparte entre los lotes
 * vigentes con `platform.allocate_lots_fefo`: primero el que vence antes, cada
 * lote a su costo. Una línea que ya trae lote no se toca, y un producto sin
 * lotes tampoco.
 *
 * Varias líneas del mismo producto se reparten JUNTAS: repartir cada una por
 * separado asignaría dos veces la misma existencia.
 *
 * La fecha contra la que se juzga «vencido» es la misma expresión que usa el
 * trigger LAD46 (`occurred_at::date`): si difirieran, el reparto podría elegir
 * un lote que el trigger rechaza.
 */
async function repartirPorLotes(
  sql: TransactionSql,
  input: IssueStockBatchInput,
  occurredAt: string | null,
): Promise<Result<IssueStockLine[], InventoryError>> {
  const sinLote = [...new Set(input.lines.filter((l) => !l.lot_id).map((l) => l.product_id))];
  if (sinLote.length === 0) return ok([...input.lines]);

  const conLotes = await sql<{ id: string; name: string }[]>`
    select id, name from public.products
     where company_id = ${input.company_id} and id = any(${sinLote}::uuid[]) and tracks_lots`;
  if (conLotes.length === 0) return ok([...input.lines]);
  const nombre = new Map(conLotes.map((p) => [p.id, p.name]));

  // Lo pedido por producto, sumado.
  const pedido = new Map<string, Decimal>();
  for (const l of input.lines) {
    if (l.lot_id || !nombre.has(l.product_id)) continue;
    const q = cantidad(l.quantity);
    if (!q.ok) return q;
    const previo = pedido.get(l.product_id);
    pedido.set(l.product_id, previo === undefined ? q.value : previo.plus(q.value));
  }

  const solicitud = [...pedido.entries()].map(([product_id, q]) => ({
    product_id,
    quantity: q.toFixed(),
  }));
  const asignado = await sql<{ product_id: string; lot_id: string; quantity: string }[]>`
    select x.product_id, a.lot_id, a.quantity::text as quantity
      from jsonb_to_recordset(${sql.json(solicitud)}::jsonb) as x(product_id uuid, quantity numeric),
           lateral platform.allocate_lots_fefo(${input.company_id}, ${input.warehouse_id},
                                               x.product_id, x.quantity,
                                               -- C-07: «vencido» es día contra día, y el día es el
                                               -- de Caracas, igual que LAD46 (migración
                                               -- 20261005130100). El día en que vence aún se vende.
                                               (coalesce(${occurredAt}::timestamptz, now())
                                                  at time zone 'America/Caracas')::date) a`;

  const porProducto = new Map<string, { lot_id: string; restante: Decimal }[]>();
  for (const a of asignado) {
    const q = cantidad(a.quantity);
    if (!q.ok) return q;
    const lista = porProducto.get(a.product_id) ?? [];
    lista.push({ lot_id: a.lot_id, restante: q.value });
    porProducto.set(a.product_id, lista);
  }
  for (const [productId, q] of pedido) {
    const disponible = (porProducto.get(productId) ?? []).reduce(
      (s, a) => s.plus(a.restante),
      q.minus(q),
    );
    if (disponible.lessThan(q)) {
      return err({
        code: "NEGATIVE_STOCK",
        message: `No hay suficiente «${nombre.get(productId) ?? "producto"}» en lotes vigentes: se piden ${q.toFixed()} y hay ${disponible.toFixed()} sin vencer en este depósito. Lo vencido no se vende; se da de baja con un ajuste.`,
        // Quién falta: la venta de un compuesto dice con él de qué compuesto es ingrediente.
        productId,
      });
    }
  }

  // Cada línea original consume los lotes en orden de vencimiento.
  const resultado: IssueStockLine[] = [];
  for (const l of input.lines) {
    if (l.lot_id || !nombre.has(l.product_id)) {
      resultado.push(l);
      continue;
    }
    const q = cantidad(l.quantity);
    if (!q.ok) return q;
    let falta = q.value;
    for (const a of porProducto.get(l.product_id)!) {
      if (falta.isZero()) break;
      if (a.restante.isZero()) continue;
      const toma = a.restante.lessThan(falta) ? a.restante : falta;
      resultado.push({ product_id: l.product_id, lot_id: a.lot_id, quantity: toma.toFixed() });
      a.restante = a.restante.minus(toma);
      falta = falta.minus(toma);
    }
  }
  return ok(resultado);
}

/**
 * REPONE EXACTAMENTE LO QUE UN DOCUMENTO SACÓ (ADR-0061 §2). Por cada salida con
 * `source_document_id` = el documento, una entrada en el MISMO depósito y lote,
 * por la misma cantidad y el MISMO valor funcional —no el promedio de hoy ni el
 * `cost_snapshot` de la línea—. Así el kardex del documento netea a cero en
 * cantidad y en valor (`annulled_stock_gaps`).
 *
 * No asienta: quien anula decide el hecho contable, porque depende de si el
 * costo de ventas llegó a asentarse. Devuelve el valor total repuesto.
 */
export async function reponerSalidasDeDocumento(
  uow: UnitOfWork,
  companyId: string,
  documentId: string,
): Promise<Result<{ repuesto: string; movimientos: number }, InventoryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Reponer existencias exige un usuario real.",
    });
  }
  const [cfg] = await sql<{ tenant_id: string; moneda: string; negativo: boolean }[]>`
    select c.tenant_id, c.functional_currency_code as moneda,
           coalesce(s.allow_negative_stock, false) as negativo
      from public.companies c
      left join public.inventory_settings s on s.company_id = c.id
     where c.id = ${companyId}`;
  if (!cfg) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  const ctx: Contexto = {
    tenantId: cfg.tenant_id,
    functionalCurrency: cfg.moneda,
    allowNegative: cfg.negativo,
  };

  const salidas = await sql<
    {
      warehouse_id: string;
      product_id: string;
      lot_id: string | null;
      quantity: string;
      valor: string;
    }[]
  >`select warehouse_id, product_id, lot_id, (-quantity)::text as quantity,
           (-functional_amount)::text as valor
      from public.inventory_moves
     where company_id = ${companyId} and source_document_id = ${documentId} and kind = 'salida'
     order by created_at, id`;

  let total = parseDecimal("0");
  if (!total.ok) return err({ code: "VALIDATION_FAILED", message: total.error.message });
  for (const m of salidas) {
    const r = await ingresar(uow, actor.userId, ctx, {
      company_id: companyId,
      warehouse_id: m.warehouse_id,
      product_id: m.product_id,
      ...(m.lot_id === null ? {} : { lot_id: m.lot_id }),
      quantity: m.quantity,
      amount: m.valor,
      currency: ctx.functionalCurrency,
      note: "Reposición por anulación de la venta",
      sourceDocumentId: documentId,
      accounting: "document",
    });
    if (!r.ok) return r;
    const v = parseDecimal(m.valor);
    if (!v.ok) return err({ code: "VALIDATION_FAILED", message: v.error.message });
    total = { ok: true, value: total.value.plus(v.value) };
  }
  return ok({ repuesto: total.value.toFixed(8), movimientos: salidas.length });
}

/**
 * EL REINGRESO DE UN RETIRO CORREGIDO (ADR-0082, AF3-06). La nota de crédito de una factura de
 * retiro deja sin efecto el retiro entero: la mercancía vuelve al MISMO depósito y lote, por la
 * misma cantidad y el MISMO valor con que salió —no el promedio de hoy—, señalando a la nota como
 * su documento, y su asiento es el contra-asiento del retiro (hecho `inventory_move /
 * stock.withdrawal_returned`: inventario y débito fiscal contra el gasto por retiro). Así el kardex de la
 * factura y de su nota netea en cero (`withdrawal_note_gaps`, enunciado 6).
 * La autoriza el permiso de mover mercancía (`inventory.move`) sobre ESE depósito; el de corregir
 * el documento lo exige quien llama.
 */
export async function reingresarRetiro(
  uow: UnitOfWork,
  input: {
    readonly companyId: string;
    readonly facturaId: string;
    readonly notaId: string;
    /** El IVA de la nota en moneda funcional: el débito fiscal que se revierte. */
    readonly impuesto: string;
    readonly descripcion: string;
  },
): Promise<Result<InventoryMoveResponse, InventoryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Reponer existencias exige un usuario real.",
    });
  }
  const [salida] = await sql<
    {
      warehouse_id: string;
      product_id: string;
      lot_id: string | null;
      quantity: string;
      valor: string;
    }[]
  >`select warehouse_id, product_id, lot_id, (-quantity)::text as quantity,
           (-functional_amount)::text as valor
      from public.inventory_moves
     where company_id = ${input.companyId} and source_document_id = ${input.facturaId}
       and kind = 'salida'
     order by created_at, id
     limit 1`;
  if (!salida) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  const ctx = await autorizar(sql, actor.userId, input.companyId, "inventory.move", [
    salida.warehouse_id,
  ]);
  if (!ctx.ok) return ctx;
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const entrada = await ingresar(uow, actor.userId, ctx.value, {
    company_id: input.companyId,
    warehouse_id: salida.warehouse_id,
    product_id: salida.product_id,
    ...(salida.lot_id === null ? {} : { lot_id: salida.lot_id }),
    quantity: salida.quantity,
    amount: salida.valor,
    currency: ctx.value.functionalCurrency,
    note: "Reingreso por la nota de crédito del retiro",
    sourceDocumentId: input.notaId,
    accounting: "document",
    // Un evento por hecho, con el nombre de su hecho contable (pgTAP 026).
    evento: "stock.withdrawal_returned",
  });
  if (!entrada.ok) return entrada;
  const contable = await asentarMovimiento(sql, actor.userId, ctx.value, entrada.value, {
    sourceKind: "inventory_move",
    evento: "stock.withdrawal_returned",
    descripcion: input.descripcion,
    amounts: { cost_amount: salida.valor, tax_amount: input.impuesto },
  });
  if (!contable.ok) return contable;
  return ok(entrada.value);
}

export async function issueStockBatch(
  uow: UnitOfWork,
  input: IssueStockBatchInput,
): Promise<Result<InventoryMoveResponse[], InventoryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Mover existencias exige un usuario real.",
    });
  }
  if (input.lines.length === 0) return ok([]);

  // UNA autorización para todas las líneas: mismo actor, misma empresa, mismo
  // almacén y el mismo permiso que pedía cada una por separado.
  const ctx = await autorizar(sql, actor.userId, input.company_id, "inventory.move", [
    input.warehouse_id,
  ]);
  if (!ctx.ok) return ctx;
  return sacarLote(uow, ctx.value, input);
}

/**
 * LA SALIDA DE KARDEX DE UNA VENTA (ADR-0068 §1). El paso interior lo autoriza
 * la operación que lo contiene: quien vende saca la mercancía que vende, tenga
 * o no `inventory.move` —el cajero no lo tiene y no debe tenerlo, porque ese
 * permiso abre la salida SUELTA—. Se exige `sales.invoice.issue` sobre la
 * empresa Y sobre ESTE almacén (`ladino_user_has_scope`), igual que la ruta
 * suelta exige el suyo: un rol de venta acotado a un depósito no vende desde
 * otro. Mismo patrón que la reposición al anular (ADR-0061 §2) y `revalorizar`.
 */
export async function issueStockBatchForSale(
  uow: UnitOfWork,
  input: IssueStockBatchInput,
): Promise<Result<InventoryMoveResponse[], InventoryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Mover existencias exige un usuario real.",
    });
  }
  if (input.lines.length === 0) return ok([]);
  const ctx = await autorizar(sql, actor.userId, input.company_id, "sales.invoice.issue", [
    input.warehouse_id,
  ]);
  if (!ctx.ok) return ctx;
  return sacarLote(uow, ctx.value, input);
}

/**
 * LA SALIDA DE KARDEX DE UNA DEVOLUCIÓN AL PROVEEDOR (H-03, ADR-0083). Mismo patrón que la
 * salida de una venta: la autoriza el permiso de la operación que la contiene
 * (`purchase.credit_note.register`), sobre la empresa y sobre ESTE almacén. No asienta: el
 * hecho contable es la nota de crédito, que cubre sus movimientos por `source_document_id`.
 */
export async function issueStockBatchForSupplierReturn(
  uow: UnitOfWork,
  input: IssueStockBatchInput,
): Promise<Result<InventoryMoveResponse[], InventoryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Mover existencias exige un usuario real.",
    });
  }
  if (input.lines.length === 0) return ok([]);
  const ctx = await autorizar(
    sql,
    actor.userId,
    input.company_id,
    "purchase.credit_note.register",
    [input.warehouse_id],
  );
  if (!ctx.ok) return ctx;
  // No se devuelve lo que no está, NUNCA: aunque la empresa permita vender en negativo, una
  // devolución al proveedor de mercancía que ya no existe no es una devolución.
  return sacarLote(uow, { ...ctx.value, allowNegative: false }, input);
}

/**
 * LA ENTRADA AL KARDEX DENTRO DE OTRA OPERACIÓN (ADR-0068 §1): la autoriza el permiso
 * de la operación que la contiene, sobre la empresa y sobre el almacén de destino. La
 * ruta suelta sigue siendo `receiveStock` (`inventory.move`).
 *   · `sales.return.manage`: el reingreso de una devolución;
 *   · `purchase.receive`: la recepción de una compra;
 *   · `product.manage`: la existencia inicial del alta simple de un producto.
 */
export type PermisoDeEntrada = "sales.return.manage" | "purchase.receive" | "product.manage";

export async function receiveStockFor(
  uow: UnitOfWork,
  input: ReceiveStockInput,
  permiso: PermisoDeEntrada,
): Promise<Result<InventoryMoveResponse, InventoryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Mover existencias exige un usuario real.",
    });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, permiso, [input.warehouse_id]);
  if (!ctx.ok) return ctx;
  return ingresar(uow, actor.userId, ctx.value, input);
}

/** La salida en lote, YA autorizada por quien llama (la ruta suelta o la venta). */
async function sacarLote(
  uow: UnitOfWork,
  ctxValue: Contexto,
  input: IssueStockBatchInput,
): Promise<Result<InventoryMoveResponse[], InventoryError>> {
  const { sql } = uow;
  const ctx = { ok: true as const, value: ctxValue };
  const occurredAt = input.occurred_at ?? null;
  const momentoTasa = ahora(input.occurred_at);

  const repartidas = await repartirPorLotes(sql, input, occurredAt);
  if (!repartidas.ok) return repartidas;
  const lineas = repartidas.value;

  const cantidades: Decimal[] = [];
  for (const l of lineas) {
    const q = cantidad(l.quantity);
    if (!q.ok) return q;
    cantidades.push(q.value);
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  // TODAS las posiciones, bloqueadas de una vez y EN ORDEN DETERMINISTA.
  const claves = [...new Set(lineas.map((l) => `${l.product_id}|${l.lot_id ?? ""}`))].sort();
  const productos = claves.map((c) => c.split("|")[0]!);
  const lotes = claves.map((c) => (c.split("|")[1] === "" ? null : c.split("|")[1]!));
  const filasPos = await sql<
    {
      product_id: string;
      lot_id: string | null;
      quantity: string;
      value: string;
      currency_code: string;
      last_unit_cost: string;
    }[]
  >`select u.product_id, u.lot_id, p.quantity::text as quantity, p.value::text as value,
           p.currency_code, p.last_unit_cost::text as last_unit_cost
      from unnest(${productos}::uuid[], ${lotes}::uuid[])
             with ordinality as u(product_id, lot_id, orden),
           lateral platform.lock_stock_position(${input.company_id}, ${input.warehouse_id},
                                                u.product_id, u.lot_id) p
     order by u.orden`;
  if (filasPos.length !== claves.length) {
    return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  }

  const posiciones = new Map<string, StockPosition>();
  for (const f of filasPos) {
    const pos = positionOf({
      quantity: f.quantity,
      value: f.value,
      lastUnitCost: f.last_unit_cost,
      currency: f.currency_code,
    });
    if (!pos.ok) return err({ code: "VALIDATION_FAILED", message: pos.error.message });
    posiciones.set(`${f.product_id}|${f.lot_id ?? ""}`, pos.value);
  }

  // EL COSTEO, encadenado en memoria línea a línea: la posición que deja una
  // salida es la que ve la siguiente. Es lo que hacía el bucle releyendo la
  // base, sin releerla.
  const preparadas: {
    linea: IssueStockLine;
    costed: ReturnType<typeof costIssue> extends Result<infer C, infer _E> ? C : never;
    fact: MonetaryFact;
  }[] = [];
  for (let i = 0; i < lineas.length; i += 1) {
    const l = lineas[i]!;
    const clave = `${l.product_id}|${l.lot_id ?? ""}`;
    const posicion = posiciones.get(clave)!;
    const costed = costIssue(posicion, cantidades[i]!, {
      allowNegative: ctx.value.allowNegative,
    });
    if (!costed.ok) {
      if (costed.error.code === "NEGATIVE_STOCK") {
        // I-04: se dice CUÁL producto falta (la venta de un compuesto saca varios, y «no hay
        // existencia» sin nombre no le sirve a quien está en la caja). Solo en el camino de error.
        const [falta] = await sql<{ name: string }[]>`
          select name from public.products
           where id = ${l.product_id} and company_id = ${input.company_id}`;
        return err({
          code: "NEGATIVE_STOCK",
          message: `No hay suficiente «${falta?.name ?? "producto"}» en este depósito: se piden ${cantidades[i]!.toFixed()} y quedan ${posicion.quantity.toFixed()}.`,
          productId: l.product_id,
        });
      }
      return err({ code: "VALIDATION_FAILED", message: costed.error.message });
    }
    posiciones.set(clave, costed.value.position);
    const hecho = hechoMonetario(
      costed.value.move.value.negate().toAmountString(),
      ctx.value.functionalCurrency,
      ctx.value.functionalCurrency,
      undefined,
      momentoTasa,
    );
    if (!hecho.ok) return hecho;
    preparadas.push({ linea: l, costed: costed.value, fact: hecho.value.fact });
  }

  // Un INSERT para todos los movimientos, en el orden de las líneas: el
  // trigger se dispara por fila y en ese orden, igual que el bucle.
  const filas = preparadas.map((p, i) => ({
    orden: i + 1,
    product_id: p.linea.product_id,
    lot_id: p.linea.lot_id ?? null,
    quantity: p.costed.move.quantity.toFixed(),
    amount_transaction_currency: `-${p.fact.amountTransactionCurrency}`,
    fx_rate: p.fact.fxRate,
    functional_amount: p.costed.move.value.toAmountString(),
    unit_cost: p.costed.move.unitCostAfter.toAmountString(),
    quantity_after: p.costed.move.quantityAfter.toFixed(),
    value_after: p.costed.move.valueAfter.toAmountString(),
  }));
  const primera = preparadas[0]!;
  let movimientos: InventoryMoveResponse[];
  try {
    movimientos = await sql.savepoint(
      (sp) => sp<InventoryMoveResponse[]>`
        insert into public.inventory_moves
          (id, tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
           amount_transaction_currency, transaction_currency, fx_rate,
           functional_amount, functional_currency, rate_source, rate_timestamp,
           rounding_policy_id, unit_cost, quantity_after, value_after,
           occurred_at, reference, reason, note, transfer_id, counterpart_move_id,
           source_document_id)
        select platform.uuidv7(), ${ctx.value.tenantId}, ${input.company_id},
               ${input.warehouse_id}, x.product_id, x.lot_id, 'salida', x.quantity,
               x.amount_transaction_currency, ${primera.fact.transactionCurrency}, x.fx_rate,
               x.functional_amount, ${primera.fact.functionalCurrency},
               ${primera.fact.rateSource}, ${primera.fact.rateTimestamp},
               ${primera.fact.roundingPolicyId}, x.unit_cost, x.quantity_after, x.value_after,
               coalesce(${occurredAt}::timestamptz, now()), null,
               null, ${input.note ?? null}, null, null, ${input.sourceDocumentId ?? null}
          from jsonb_to_recordset(${sql.json(filas)}::jsonb) as x(
            orden integer, product_id uuid, lot_id uuid, quantity numeric,
            amount_transaction_currency numeric, fx_rate numeric, functional_amount numeric,
            unit_cost numeric, quantity_after numeric, value_after numeric)
         order by x.orden
        returning ${sp.unsafe(MOVE_COLUMNS)}`,
    );
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }

  await auditarYPublicarLote(sql, movimientos, ctx.value.tenantId, "stock.shipped");
  return ok(movimientos);
}
/**
 * EL ASIENTO DE UNA ENTRADA (ADR-0060 §2). Toda entrada al kardex asienta su
 * contrapartida en el mayor, con el evento REAL del outbox (`stock.received`) y
 * el ORIGEN en `source_kind`:
 *   · `stock_opening` (por omisión): existencia inicial y entrada directa, contra
 *     «aportes en inventario». Se asienta aquí, por movimiento;
 *   · `document`: la entrada es parte de un documento (recepción de compra,
 *     devolución) y QUIEN LLAMA asienta una vez por documento, con la suma de
 *     sus movimientos. Si no lo hiciera, `inventory_coverage_gaps` lo señala.
 */
export type AsientoEntrada = "stock_opening" | "document";
/** El origen de una salida suelta: salida directa o consumo que es costo de ventas (receta). */
export type OrigenSalida = "inventory_move" | "sales_cost";

export type ReceiveStockInput = ReceiveStockRequest & {
  readonly sourceDocumentId?: string;
  readonly accounting?: AsientoEntrada;
  /** El nombre con que la entrada se publica y audita, si no es una entrada cualquiera. */
  readonly evento?: "stock.withdrawal_returned";
};
export type AdjustStockInput = AdjustStockRequest & {
  readonly sourceDocumentId?: string;
  /** El conteo asienta su faltante a pérdidas (`stock.counted`); el ajuste suelto, `stock.adjusted`. */
  readonly evento?: "stock.adjusted" | "stock.counted";
  /** El soporte del faltante de un conteo (RLIVA art. 14): se guarda en `exit_evidence`. */
  readonly evidencia?: string;
};

export async function issueStock(
  uow: UnitOfWork,
  input: IssueStockInput,
): Promise<Result<InventoryMoveResponse, InventoryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Mover existencias exige un usuario real.",
    });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "inventory.move", [
    input.warehouse_id,
  ]);
  if (!ctx.ok) return ctx;
  const q = cantidad(input.quantity);
  if (!q.ok) return q;
  // OJO: el default NO es el reloj del cliente. `created_at` lo fija el trigger con
  // now(), que es la hora de INICIO DE TRANSACCIÓN, así que cualquier instante
  // calculado en Node después de abrirla es POSTERIOR y el CHECK
  // `occurred_at <= created_at` lo rechaza — siempre. Se manda null y decide el
  // servidor. (Lo destapó el primer test de integración, no un unitario.)
  const occurredAt = input.occurred_at ?? null;
  const momentoTasa = ahora(input.occurred_at);
  const origen = input.accountingSource ?? "inventory_move";
  const motivo = input.reason ?? null;
  // La salida SUELTA dice por qué sale (ADR-0078 §2): sin motivo no se sabe adónde va en el mayor.
  if (origen === "inventory_move" && motivo === null) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Elige el motivo de la salida: merma, rotura, vencido, faltante, consumo propio, regalo, donación, muestra, uso en el negocio, pasa a activo fijo o incorporado a un inmueble del negocio.",
    });
  }
  const esRetiro = motivo !== null && RETIRO_REASONS.includes(motivo);
  // AF3-03 (LIVA art. 4.3 in fine; VALIDAR-TRIBUTARIO P-82): usado en el giro, llevado al activo
  // fijo o incorporado a un inmueble del negocio. Sale del kardex sin débito y sin factura.
  const esUsoNoGravado = motivo !== null && USO_NO_GRAVADO_REASONS.includes(motivo);
  const esPerdida = motivo !== null && PERDIDA_REASONS.includes(motivo);
  // LA PÉRDIDA JUSTIFICADA lleva su soporte (RLIVA art. 14, §2.13): sin evidencia no es faltante
  // justificado, y Ladino no la registra como tal. AF3-04: y el soporte dice algo.
  // AF3-02b (decidido por criterio, lo más estrecho): el faltante SIN evidencia sería retiro
  // gravable (RLIVA art. 31) con la base del art. 13 —costo más el porcentaje de utilidad bruta
  // del último balance—. Ese porcentaje no existe como dato de la empresa y no se inventa: se
  // sigue RECHAZANDO, y el camino queda descrito en PENDIENTES_ASESOR P-81.
  const evidencia = input.evidence?.trim() ?? null;
  if (esPerdida && !evidenciaSuficiente(evidencia)) {
    return err({ code: "VALIDATION_FAILED", message: MENSAJE_EVIDENCIA });
  }
  // AF5-07: la salida no gravada dice su DESTINO (la misma regla, guardada en `exit_evidence`).
  if (esUsoNoGravado && !evidenciaSuficiente(evidencia)) {
    return err({ code: "VALIDATION_FAILED", message: MENSAJE_DESTINO });
  }
  // EL RETIRO NO REESCRIBE UN PERÍODO YA DECLARADO (criterio B-1, decidido por criterio): si su
  // fecha cae en un período cuya declaración de IVA se generó DESPUÉS de cerrarse, el débito ya no
  // cabe en esa declaración. Día contra día (caracas_day), como B-1.
  if (esRetiro && input.occurred_at !== undefined) {
    const [declarado] = await sql<{ desde: string; hasta: string }[]>`
      select p.period_from::text as desde, p.period_to::text as hasta
        from public.iva_period_results p
       where p.company_id = ${input.company_id}
         and platform.caracas_day(${input.occurred_at}::timestamptz)
               between p.period_from and p.period_to
         and p.period_to < platform.caracas_day(p.created_at)
       limit 1`;
    if (declarado) {
      return err({
        code: "VALIDATION_FAILED",
        message: `El período del ${declarado.desde} al ${declarado.hasta} ya se declaró: un retiro con esa fecha cambiaría una declaración presentada. Regístralo con la fecha de hoy.`,
      });
    }
  }
  // LA FACTURA DE RETIRO (ADR-0082; RLIVA art. 31) se emite ANTES de mover el kardex —el mismo
  // orden de candados que la venta: talonario → existencia—, con el id que llevará la salida ya
  // decidido. Si falta el precio, la tasa, el papel del talonario o el tipo de contribuyente, la
  // salida no ocurre: no existe el retiro sin su factura. Una empresa SIN RIF no factura: solo
  // deja la salida de kardex y el gasto.
  // El instante es UNO y lo pone la base (inicio de la transacción, o el que se pidió): fecha de
  // emisión de la factura, del movimiento y de su asiento. Con dos relojes, a medianoche el libro
  // y el mayor caerían en días distintos.
  let factura: FacturaDeRetiroEmitida | null = null;
  let idDeLaSalida: string | null = null;
  if (esRetiro && (await modoDeVenta(sql, input.company_id, momentoTasa)) === "facturas") {
    // AF5-02: emitir un documento fiscal no es mover mercancía. Además de `inventory.move` (arriba),
    // quien registra un retiro que se factura necesita el permiso de emitir facturas. Los motivos
    // que no emiten documento y la empresa sin RIF no pasan por aquí.
    const puedeFacturar = await companyScope(
      sql,
      actor.userId,
      input.company_id,
      "sales.invoice.issue",
    );
    if (!puedeFacturar.ok) {
      return puedeFacturar.error.code === "PERMISSION_REQUIRED"
        ? err({ code: "PERMISSION_REQUIRED", message: MENSAJE_RETIRO_EXIGE_FACTURAR })
        : puedeFacturar;
    }
    // AF5-08 (RLIVA art. 57): la factura toma el SIGUIENTE correlativo y control; con una fecha de
    // otro día rompería la continuidad de número y fecha. Dos `date`, día de Caracas.
    if (input.occurred_at !== undefined) {
      const [dia] = await sql<{ hoy: boolean }[]>`
        select platform.caracas_day(${input.occurred_at}::timestamptz)
                 = platform.caracas_day(now()) as hoy`;
      if (dia?.hoy !== true) {
        return err({ code: "VALIDATION_FAILED", message: MENSAJE_RETIRO_ES_DE_HOY });
      }
    }
    if (input.facturarRetiro === undefined) {
      return err({
        code: "VALIDATION_FAILED",
        message:
          "Este retiro se factura (RLIVA art. 31) y esta vía no emite la factura: regístralo desde Inventario › Salida.",
      });
    }
    const [inst] = await sql<{ id: string; t: string }[]>`
      select platform.uuidv7() as id,
             to_char(coalesce(${occurredAt}::timestamptz, now()) at time zone 'utc',
                     'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`;
    const f = await input.facturarRetiro({
      companyId: input.company_id,
      warehouseId: input.warehouse_id,
      productId: input.product_id,
      quantity: q.value.toFixed(),
      moveId: inst!.id,
      motivo: ETIQUETA_MOTIVO[motivo],
      fecha: inst!.t,
    });
    if (!f.ok) return f;
    factura = f.value;
    idDeLaSalida = inst!.id;
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const posicion = await bloquear(
    sql,
    input.company_id,
    input.warehouse_id,
    input.product_id,
    input.lot_id ?? null,
  );
  if (!posicion.ok) return posicion;

  const costed = costIssue(posicion.value, q.value, { allowNegative: ctx.value.allowNegative });
  if (!costed.ok) {
    return err(
      costed.error.code === "NEGATIVE_STOCK"
        ? { code: "NEGATIVE_STOCK", message: costed.error.message }
        : { code: "VALIDATION_FAILED", message: costed.error.message },
    );
  }
  // El hecho monetario de una salida es en moneda funcional por definición: el
  // costo sale del promedio, no de un documento en otra moneda.
  const hecho = hechoMonetario(
    costed.value.move.value.negate().toAmountString(),
    ctx.value.functionalCurrency,
    ctx.value.functionalCurrency,
    undefined,
    momentoTasa,
  );
  if (!hecho.ok) return hecho;

  let fila: InventoryMoveResponse;
  try {
    fila = await sql.savepoint((sp) =>
      insertar(sp, {
        tenantId: ctx.value.tenantId,
        companyId: input.company_id,
        warehouseId: input.warehouse_id,
        productId: input.product_id,
        lotId: input.lot_id ?? null,
        kind: "salida",
        costed: costed.value,
        fact: hecho.value.fact,
        occurredAt,
        reference: input.reference ?? null,
        // El texto libre `reason` es del ajuste y la revaluación; la salida usa su columna.
        reason: null,
        exitReason: motivo,
        exitEvidence: esPerdida || esUsoNoGravado ? evidencia : null,
        note: input.note ?? null,
        transferId: null,
        counterpartId: null,
        // La salida de un retiro facturado lleva el id que su factura ya guardó, y la señala
        // como su documento: anularla repone exactamente esta salida (ADR-0061 §2).
        id: idDeLaSalida,
        sourceDocumentId: factura?.id ?? input.sourceDocumentId ?? null,
      }),
    );
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
  // UN evento por hecho, con el MISMO nombre que su hecho contable (pgTAP 026: el preset no usa un
  // vocabulario paralelo al del outbox): el costo de una venta es `stock.shipped`; el retiro
  // —gravado o no—, `stock.withdrawn`; la merma, rotura, vencido o faltante, `stock.shrinkage`.
  // AF3-03 (20261005100400): la salida no gravada tiene su hecho propio, por el papel de su
  // contrapartida: lo usado en el giro es gasto de operación (`stock.used_in_business`); lo que
  // pasa al activo fijo o se incorpora a un inmueble es activo (`stock.capitalized`).
  const eventoSalida =
    origen === "sales_cost"
      ? "stock.shipped"
      : esRetiro
        ? "stock.withdrawn"
        : motivo === "uso_en_negocio"
          ? "stock.used_in_business"
          : esUsoNoGravado
            ? "stock.capitalized"
            : "stock.shrinkage";
  await auditarYPublicar(sql, fila, ctx.value.tenantId, eventoSalida, {
    reference: fila.reference,
    exit_reason: motivo,
    ...(factura !== null ? { withdrawal_invoice_id: factura.id } : {}),
  });
  const costo = fila.functional_amount.replace("-", "");
  const ref = fila.reference ? `: ${fila.reference}` : "";

  const contable =
    origen === "sales_cost"
      ? await asentarMovimiento(sql, actor.userId, ctx.value, fila, {
          sourceKind: origen,
          evento: "stock.shipped",
          descripcion: `Costo de lo consumido${ref}`,
          amounts: { cost_amount: costo },
        })
      : esRetiro || esUsoNoGravado
        ? await asentarMovimiento(sql, actor.userId, ctx.value, fila, {
            sourceKind: "inventory_move",
            evento: eventoSalida,
            // ADR-0082: el asiento de la factura de retiro ES este —gasto por retiro al costo y
            // débito fiscal contra inventario—; no nace cuenta por cobrar. AF3-03: el motivo no
            // gravado va sin débito, a su papel (gasto de operación o activo fijo, por el evento);
            // el código de la cuenta de activo es provisional (P-82).
            descripcion:
              (esRetiro
                ? `Retiro por ${ETIQUETA_MOTIVO[motivo]}`
                : `Salida no gravada: ${ETIQUETA_MOTIVO[motivo]}`) +
              (factura !== null ? ` (Factura de retiro ${factura.number})` : "") +
              ref,
            // Sin RIF, o en un motivo no gravado, no hay débito: las dos líneas del IVA salen en
            // cero y no se escriben.
            amounts: { cost_amount: costo, tax_amount: factura?.tax_amount ?? "0" },
          })
        : await asentarMovimiento(sql, actor.userId, ctx.value, fila, {
            sourceKind: "inventory_move",
            evento: eventoSalida,
            descripcion: `Salida por ${ETIQUETA_MOTIVO[motivo!]}${ref} · soporte: ${evidencia ?? "—"}`,
            amounts: { functional_amount: fila.functional_amount },
          });
  if (!contable.ok) return contable;
  return ok({ ...fila, withdrawal_note_number: null, withdrawal_invoice: factura });
}

/** El motivo en palabras: va en la descripción del asiento (I-11). */
const ETIQUETA_MOTIVO: Record<ExitReason, string> = {
  merma: "merma",
  rotura: "rotura",
  vencido: "vencimiento",
  faltante: "faltante",
  consumo_propio: "consumo propio",
  regalo: "regalo",
  donacion: "donación",
  muestra: "muestra",
  uso_en_negocio: "uso en el negocio",
  activo_fijo: "pasa a activo fijo",
  incorporado_inmueble: "incorporado a un inmueble del negocio",
};

/**
 * EL CONTEO (ADR-0078 §4, I-07). La persona escribe lo que contó; la diferencia contra el sistema
 * se calcula AQUÍ, bajo el bloqueo de la posición —no en la pantalla, que leyó el saldo antes y
 * puede estar vieja—. Con `preview` se devuelve sin escribir; sin él, la diferencia se registra
 * como ajuste (permiso `inventory.adjust`, motivo obligatorio) al promedio vigente.
 */
export async function countStock(
  uow: UnitOfWork,
  input: CountStockRequest,
): Promise<Result<CountStockResponse, InventoryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Contar existencias exige un usuario real.",
    });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "inventory.adjust", [
    input.warehouse_id,
  ]);
  if (!ctx.ok) return ctx;
  const contado = parseDecimal(input.counted);
  if (!contado.ok) return err({ code: "VALIDATION_FAILED", message: contado.error.message });
  // El lote ANTES de bloquear: `lock_stock_position` crea la posición si no existe, y la de un
  // producto por lotes sin lote es una posición que no debe nacer.
  const [prod] = await sql<{ tracks_lots: boolean }[]>`
    select tracks_lots from public.products
     where id = ${input.product_id} and company_id = ${input.company_id}`;
  if (!prod) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (prod.tracks_lots && (input.lot_id ?? null) === null) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Elige el lote que contaste: este producto se lleva por lotes y cada lote se cuenta aparte.",
    });
  }
  const posicion = await bloquear(
    sql,
    input.company_id,
    input.warehouse_id,
    input.product_id,
    input.lot_id ?? null,
  );
  if (!posicion.ok) return posicion;
  const sistema = posicion.value.quantity;
  if (input.expected_system_quantity !== undefined) {
    const esperado = parseDecimal(input.expected_system_quantity);
    if (!esperado.ok || !esperado.value.equals(sistema)) {
      return err({
        code: "CONFLICT",
        message: `La existencia cambió desde que calculaste la diferencia: el sistema tiene ahora ${sistema.toFixed()} y viste ${input.expected_system_quantity}. Vuelve a calcular la diferencia.`,
      });
    }
  }
  const delta = contado.value.minus(sistema);
  const vista = {
    system_quantity: sistema.toFixed(8),
    counted: contado.value.toFixed(8),
    delta: delta.toFixed(8),
  };
  if (input.preview === true || delta.isZero()) return ok({ ...vista, move: null });
  // EL FALTANTE DE UN CONTEO VA A PÉRDIDAS (5.1.08) y lleva su soporte, igual que la salida
  // «faltante» (RLIVA art. 14, §2.13): sin evidencia no es faltante justificado. El sobrante no
  // la pide, y si vino no se guarda. La base lo repite (20261003110200).
  const evidencia = input.evidence?.trim() ?? null;
  if (delta.isNegative() && (evidencia === null || evidencia.length < 3)) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "El conteo dio un faltante: va a pérdidas y necesita su evidencia. Escribe la referencia del acta, la foto o el informe que lo respalda (RLIVA art. 14).",
    });
  }
  const ajuste = await adjustStock(uow, {
    company_id: input.company_id,
    warehouse_id: input.warehouse_id,
    product_id: input.product_id,
    ...(input.lot_id !== undefined ? { lot_id: input.lot_id } : {}),
    delta: delta.toFixed(),
    reason: `Conteo: contado ${contado.value.toFixed()}, sistema ${sistema.toFixed()} · ${input.reason}`,
    evento: "stock.counted",
    ...(delta.isNegative() && evidencia !== null ? { evidencia } : {}),
    ...(input.reference !== undefined ? { reference: input.reference } : {}),
  });
  if (!ajuste.ok) return ajuste;
  return ok({ ...vista, move: ajuste.value });
}

/** Ajuste: permiso PROPIO (`inventory.adjust`, segregación) y motivo obligatorio. */
export async function adjustStock(
  uow: UnitOfWork,
  input: AdjustStockInput,
): Promise<Result<InventoryMoveResponse, InventoryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Ajustar existencias exige un usuario real.",
    });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "inventory.adjust", [
    input.warehouse_id,
  ]);
  if (!ctx.ok) return ctx;
  const delta = cantidad(input.delta);
  if (!delta.ok) return delta;
  // OJO: el default NO es el reloj del cliente. `created_at` lo fija el trigger con
  // now(), que es la hora de INICIO DE TRANSACCIÓN, así que cualquier instante
  // calculado en Node después de abrirla es POSTERIOR y el CHECK
  // `occurred_at <= created_at` lo rechaza — siempre. Se manda null y decide el
  // servidor. (Lo destapó el primer test de integración, no un unitario.)
  const occurredAt = input.occurred_at ?? null;
  const momentoTasa = ahora(input.occurred_at);

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const posicion = await bloquear(
    sql,
    input.company_id,
    input.warehouse_id,
    input.product_id,
    input.lot_id ?? null,
  );
  if (!posicion.ok) return posicion;

  // Al PROMEDIO VIGENTE, siempre: el ajuste corrige una cantidad, no pone precio (ADR-0066 §7).
  const costed = costAdjust(posicion.value, delta.value, {
    allowNegative: ctx.value.allowNegative,
  });
  if (!costed.ok) {
    return err(
      costed.error.code === "NEGATIVE_STOCK"
        ? { code: "NEGATIVE_STOCK", message: costed.error.message }
        : { code: "VALIDATION_FAILED", message: costed.error.message },
    );
  }
  const absoluto = costed.value.move.value.isNegative()
    ? costed.value.move.value.negate()
    : costed.value.move.value;
  const hecho = hechoMonetario(
    absoluto.toAmountString(),
    ctx.value.functionalCurrency,
    ctx.value.functionalCurrency,
    undefined,
    momentoTasa,
  );
  if (!hecho.ok) return hecho;

  let fila: InventoryMoveResponse;
  try {
    fila = await sql.savepoint((sp) =>
      insertar(sp, {
        tenantId: ctx.value.tenantId,
        companyId: input.company_id,
        warehouseId: input.warehouse_id,
        productId: input.product_id,
        lotId: input.lot_id ?? null,
        kind: "ajuste",
        costed: costed.value,
        fact: hecho.value.fact,
        occurredAt,
        reference: input.reference ?? null,
        reason: input.reason,
        exitEvidence: input.evidencia ?? null,
        note: null,
        transferId: null,
        counterpartId: null,
        id: null,
        sourceDocumentId: input.sourceDocumentId ?? null,
      }),
    );
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
  // El asiento del ajuste. `functional_amount` llega CON SIGNO —positivo si
  // entra valor, negativo si sale— y la plantilla elige el lado con
  // `if_positive`/`if_negative`. Una línea de asiento no lleva negativos: el
  // signo es información sobre la dirección, no sobre el importe.
  const contable = await generateJournalFromDocument(sql, {
    tenantId: ctx.value.tenantId,
    companyId: input.company_id,
    sourceKind: "inventory_move",
    sourceEvent: input.evento ?? "stock.adjusted",
    sourceId: fila.id,
    postingDate: diaNegocio(input.occurred_at ?? new Date().toISOString()),
    postedBy: actor.userId,
    description: `Ajuste de existencias: ${input.reason}`,
    functionalCurrency: ctx.value.functionalCurrency,
    amounts: { functional_amount: fila.functional_amount },
  });
  if (!contable.ok) {
    return err({ code: "VALIDATION_FAILED", message: contable.error.message });
  }
  // El conteo publica y audita `stock.counted`, el nombre de su hecho contable; el ajuste suelto,
  // `stock.adjusted`. Mismo payload.
  await auditarYPublicar(sql, fila, ctx.value.tenantId, input.evento ?? "stock.adjusted", {
    reason: input.reason,
  });
  return ok(fila);
}

/**
 * Transferencia: las DOS patas en la misma transacción, con referencia mutua. El
 * constraint trigger diferido (LAD40) exige el cuadre al commit; aquí solo se
 * construyen las dos y se dejan enlazadas.
 *
 * LOS BLOQUEOS SE TOMAN EN ORDEN CANÓNICO (por id de almacén), no en orden
 * origen→destino: dos transferencias simultáneas A→B y B→A se bloquearían
 * mutuamente. Con un orden total sobre el recurso, una espera y la otra sigue.
 */
export async function transferStock(
  uow: UnitOfWork,
  input: TransferStockRequest,
): Promise<Result<TransferResponse, InventoryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Transferir exige un usuario real." });
  }
  if (input.from_warehouse_id === input.to_warehouse_id) {
    return err({
      code: "VALIDATION_FAILED",
      message: "El almacén de origen y el de destino no pueden ser el mismo.",
    });
  }
  // El alcance se exige en LOS DOS almacenes: mover de uno a otro es operar ambos.
  const ctx = await autorizar(sql, actor.userId, input.company_id, "inventory.transfer", [
    input.from_warehouse_id,
    input.to_warehouse_id,
  ]);
  if (!ctx.ok) return ctx;
  const q = cantidad(input.quantity);
  if (!q.ok) return q;
  // Igual que en las demás: la fecha por omisión la pone el SERVIDOR (ver receiveStock).
  const occurredAt = input.occurred_at ?? null;
  const momentoTasa = ahora(input.occurred_at);

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  const enOrden = [input.from_warehouse_id, input.to_warehouse_id].sort();
  for (const almacen of enOrden) {
    const previo = await bloquear(
      sql,
      input.company_id,
      almacen,
      input.product_id,
      input.lot_id ?? null,
    );
    if (!previo.ok) return previo;
  }

  const origen = await bloquear(
    sql,
    input.company_id,
    input.from_warehouse_id,
    input.product_id,
    input.lot_id ?? null,
  );
  if (!origen.ok) return origen;
  const salida = costIssue(origen.value, q.value, { allowNegative: ctx.value.allowNegative });
  if (!salida.ok) {
    return err(
      salida.error.code === "NEGATIVE_STOCK"
        ? {
            code: "NEGATIVE_STOCK",
            message:
              "La transferencia dejaría el almacén de origen en negativo y la empresa no lo permite.",
          }
        : { code: "VALIDATION_FAILED", message: salida.error.message },
    );
  }
  // El destino recibe AL COSTO DE ORIGEN: el valor se conserva, no se revaloriza.
  const costoSalida = salida.value.move.value.negate();
  const destino = await bloquear(
    sql,
    input.company_id,
    input.to_warehouse_id,
    input.product_id,
    input.lot_id ?? null,
  );
  if (!destino.ok) return destino;
  const entrada = costReceive(destino.value, q.value, costoSalida);
  if (!entrada.ok) return err({ code: "VALIDATION_FAILED", message: entrada.error.message });

  const hecho = hechoMonetario(
    costoSalida.toAmountString(),
    ctx.value.functionalCurrency,
    ctx.value.functionalCurrency,
    undefined,
    momentoTasa,
  );
  if (!hecho.ok) return hecho;

  const [ids] = await sql<{ salida: string; entrada: string; transferencia: string }[]>`
    select platform.uuidv7() as salida, platform.uuidv7() as entrada,
           platform.uuidv7() as transferencia`;
  const comun = {
    tenantId: ctx.value.tenantId,
    companyId: input.company_id,
    productId: input.product_id,
    lotId: input.lot_id ?? null,
    fact: hecho.value.fact,
    occurredAt,
    reference: input.reference ?? null,
    reason: null,
    note: input.note ?? null,
    transferId: ids!.transferencia,
    sourceDocumentId: null,
  };

  let out: InventoryMoveResponse;
  let into: InventoryMoveResponse;
  try {
    [out, into] = await sql.savepoint(async (sp) => {
      const o = await insertar(sp, {
        ...comun,
        warehouseId: input.from_warehouse_id,
        kind: "transferencia_out",
        costed: salida.value,
        counterpartId: ids!.entrada,
        id: ids!.salida,
      });
      const i = await insertar(sp, {
        ...comun,
        warehouseId: input.to_warehouse_id,
        kind: "transferencia_in",
        costed: entrada.value,
        counterpartId: ids!.salida,
        id: ids!.entrada,
      });
      return [o, i] as const;
    });
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }

  await auditarYPublicar(sql, out, ctx.value.tenantId, "stock.transferred", {
    transfer_id: ids!.transferencia,
    from_warehouse_id: input.from_warehouse_id,
    to_warehouse_id: input.to_warehouse_id,
  });
  return ok({ transfer_id: ids!.transferencia, out, in: into });
}

/**
 * REVALORIZACIÓN: sube el valor de una posición sin añadir unidades (ADR-0040
 * §6, migración 23). Es lo que hace posible que un landed cost tardío ajuste el
 * costo sin inventar existencias.
 *
 * Va por el kardex y no por un UPDATE a `stock_balances` **a propósito**: el
 * saldo es una materialización del kardex y `platform.stock_reconciliation()`
 * comprueba que uno reproduce el otro. Tocar el saldo directamente lo
 * desincroniza en silencio, y el descuadre solo aparecería meses después sin
 * forma de saber qué ajuste lo causó.
 *
 * El trigger `apply_inventory_move()` hace el resto: suma el importe al valor,
 * deja la cantidad igual y recalcula el costo unitario. No hubo que tocarlo —
 * ya calculaba `valor + importe` y `cantidad + 0` correctamente; lo que faltaba
 * era que el CHECK admitiera el caso.
 */
export interface RevalueStockInput {
  readonly company_id: string;
  readonly warehouse_id: string;
  readonly product_id: string;
  readonly lot_id?: string | null;
  /** Importe funcional a incorporar. Positivo sube el costo. */
  readonly amount: string;
  readonly currency: string;
  readonly reason: string;
  readonly sourceDocumentId?: string;
}

export async function revalueStock(
  uow: UnitOfWork,
  input: RevalueStockInput,
): Promise<Result<InventoryMoveResponse, InventoryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Revalorizar exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "inventory.move", [
    input.warehouse_id,
  ]);
  if (!ctx.ok) return ctx;
  return revalorizar(sql, ctx.value.tenantId, input);
}

/**
 * La revalorización SIN autorización propia: la usa un caso de uso que ya
 * autorizó el hecho que la origina (la factura del proveedor, ADR-0060 §2). Pedir
 * además `inventory.move` a quien registra facturas le impediría registrar una
 * factura contra mercancía recibida — el permiso de la compra es el que manda.
 */
export async function revalorizar(
  sql: TransactionSql,
  tenantId: string,
  input: RevalueStockInput,
): Promise<Result<InventoryMoveResponse, InventoryError>> {
  // ADR-0075 §7: el valor de un movimiento del kardex va al céntimo, half-up.
  const bruto = parseDecimal(input.amount);
  if (!bruto.ok) return err({ code: "VALIDATION_FAILED", message: bruto.error.message });
  const importe = Money.of(toCents(bruto.value).toFixed(2), input.currency);
  if (!importe.ok) return err({ code: "VALIDATION_FAILED", message: importe.error.message });
  if (importe.value.amount.isZero()) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Una revalorización de cero no es un hecho: no se registra.",
    });
  }

  try {
    const fila = await sql.savepoint(async (sp) => {
      const [m] = await sp<InventoryMoveResponse[]>`
        insert into public.inventory_moves
          (tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
           amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
           functional_currency, rate_source, rate_timestamp, rounding_policy_id,
           occurred_at, reason, source_document_id)
        values (${tenantId}, ${input.company_id}, ${input.warehouse_id},
                ${input.product_id}, ${input.lot_id ?? null}, 'revaluacion', 0,
                ${importe.value.toAmountString()}, ${input.currency}, 1,
                ${importe.value.toAmountString()}, ${input.currency}, 'identidad', now(),
                ${CENTS_POLICY.id}, now(), ${input.reason},
                ${input.sourceDocumentId ?? null})
        returning ${sp.unsafe(MOVE_COLUMNS)}`;
      return m!;
    });
    await auditarYPublicar(sql, fila, tenantId, "inventory.revalued", {
      reason: input.reason,
      amount: importe.value.toAmountString(),
    });
    return ok(fila);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

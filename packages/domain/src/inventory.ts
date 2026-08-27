import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql, JSONValue } from "@ladino/db";
import {
  Money,
  convert,
  makeFxRate,
  parseDecimal,
  roundForCost,
  toMonetaryFact,
  type Decimal,
  type MonetaryFact,
} from "@ladino/money";
import {
  COST_ROUNDING_POLICY,
  adjust as costAdjust,
  issue as costIssue,
  positionOf,
  receive as costReceive,
  type Costed,
  type StockPosition,
} from "@ladino/inventory";
import type {
  ReceiveStockRequest,
  IssueStockRequest,
  AdjustStockRequest,
  TransferStockRequest,
  InventoryMoveResponse,
  TransferResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";

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
  | { code: "NEGATIVE_STOCK"; message: string }
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
  reference, reason, transfer_id, source_document_id`;

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
  const redondeado = roundForCost(conversion.value.converted, COST_ROUNDING_POLICY);
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
  readonly note: string | null;
  readonly transferId: string | null;
  readonly counterpartId: string | null;
  readonly id: string | null;
  /** Liga los movimientos de UN hecho (las N salidas de una receta). */
  readonly sourceDocumentId: string | null;
}

/**
 * El INSERT. Los importes de transacción llevan el SIGNO del movimiento: el hecho
 * monetario se calcula sobre el valor absoluto y aquí se orienta, para que
 * `sum(functional_amount)` reconstruya el valor de la posición.
 */
async function insertar(sql: TransactionSql, m: Insercion): Promise<InventoryMoveResponse> {
  const negativo = m.costed.move.quantity.isNegative();
  const signo = (v: string): string => (negativo ? `-${v}` : v);
  const [fila] = await sql<InventoryMoveResponse[]>`
    insert into public.inventory_moves
      (id, tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
       amount_transaction_currency, transaction_currency, fx_rate,
       functional_amount, functional_currency, rate_source, rate_timestamp,
       rounding_policy_id, unit_cost, quantity_after, value_after,
       occurred_at, reference, reason, note, transfer_id, counterpart_move_id,
       source_document_id)
    values (coalesce(${m.id}::uuid, platform.uuidv7()), ${m.tenantId}, ${m.companyId},
            ${m.warehouseId}, ${m.productId}, ${m.lotId}, ${m.kind},
            ${m.costed.move.quantity.toFixed()},
            ${signo(m.fact.amountTransactionCurrency)}, ${m.fact.transactionCurrency}, ${m.fact.fxRate},
            ${m.costed.move.value.toAmountString()}, ${m.fact.functionalCurrency},
            ${m.fact.rateSource}, ${m.fact.rateTimestamp}, ${m.fact.roundingPolicyId},
            ${m.costed.move.unitCostAfter.toAmountString()},
            ${m.costed.move.quantityAfter.toFixed()},
            ${m.costed.move.valueAfter.toAmountString()},
            coalesce(${m.occurredAt}::timestamptz, now()), ${m.reference}, ${m.reason}, ${m.note},
            ${m.transferId}, ${m.counterpartId}, ${m.sourceDocumentId})
    returning ${sql.unsafe(MOVE_COLUMNS)}`;
  return fila!;
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
  if (code === "LAD41") {
    return {
      code: "VALIDATION_FAILED",
      message:
        "El costeo calculado no coincide con el que verifica la base: la posición cambió durante la operación. Reintenta.",
    };
  }
  if (code === "LAD38") return { code: "VALIDATION_FAILED", message };
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
  if (input.lot_code === undefined) return ok(null);
  const [existente] = await sql<{ id: string }[]>`
    select id from public.lots
     where company_id = ${input.company_id} and product_id = ${input.product_id}
       and code = ${input.lot_code}`;
  if (existente) return ok(existente.id);
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

  // OJO: el default NO es el reloj del cliente. `created_at` lo fija el trigger con
  // now(), que es la hora de INICIO DE TRANSACCIÓN, así que cualquier instante
  // calculado en Node después de abrirla es POSTERIOR y el CHECK
  // `occurred_at <= created_at` lo rechaza — siempre. Se manda null y decide el
  // servidor. (Lo destapó el primer test de integración, no un unitario.)
  const occurredAt = input.occurred_at ?? null;
  const momentoTasa = ahora(input.occurred_at);

  const hecho = hechoMonetario(
    input.amount,
    input.currency,
    ctx.value.functionalCurrency,
    input.fx,
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
      }),
    );
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
  await auditarYPublicar(sql, fila, ctx.value.tenantId, "stock.received", {
    reference: fila.reference,
  });
  return ok(fila);
}

/**
 * `sourceDocumentId` NO está en el contrato Zod a propósito: no lo manda un
 * cliente, lo pone el caso de uso que agrupa varios movimientos en un hecho
 * (consumeRecipe hoy; la factura de venta mañana).
 */
export type IssueStockInput = IssueStockRequest & { readonly sourceDocumentId?: string };
export type ReceiveStockInput = ReceiveStockRequest & { readonly sourceDocumentId?: string };
export type AdjustStockInput = AdjustStockRequest & { readonly sourceDocumentId?: string };

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
        reason: null,
        note: input.note ?? null,
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
  await auditarYPublicar(sql, fila, ctx.value.tenantId, "stock.shipped", {
    reference: fila.reference,
  });
  return ok(fila);
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

  let unitCost: Money | undefined;
  if (input.unit_cost !== undefined) {
    const m = Money.of(input.unit_cost, ctx.value.functionalCurrency);
    if (!m.ok) return err({ code: "VALIDATION_FAILED", message: m.error.message });
    unitCost = m.value;
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

  const costed = costAdjust(posicion.value, delta.value, {
    allowNegative: ctx.value.allowNegative,
    ...(unitCost ? { unitCost } : {}),
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
  await auditarYPublicar(sql, fila, ctx.value.tenantId, "stock.adjusted", {
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
export async function revalueStock(
  uow: UnitOfWork,
  input: {
    readonly company_id: string;
    readonly warehouse_id: string;
    readonly product_id: string;
    readonly lot_id?: string | null;
    /** Importe funcional a incorporar. Positivo sube el costo. */
    readonly amount: string;
    readonly currency: string;
    readonly reason: string;
    readonly sourceDocumentId?: string;
  },
): Promise<Result<InventoryMoveResponse, InventoryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Revalorizar exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "inventory.move", [
    input.warehouse_id,
  ]);
  if (!ctx.ok) return ctx;

  const importe = Money.of(input.amount, input.currency);
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
        values (${ctx.value.tenantId}, ${input.company_id}, ${input.warehouse_id},
                ${input.product_id}, ${input.lot_id ?? null}, 'revaluacion', 0,
                ${importe.value.toAmountString()}, ${input.currency}, 1,
                ${importe.value.toAmountString()}, ${input.currency}, 'identidad', now(),
                'inventory:cost:8:HALF_UP', now(), ${input.reason},
                ${input.sourceDocumentId ?? null})
        returning ${sp.unsafe(MOVE_COLUMNS)}`;
      return m!;
    });
    await auditarYPublicar(sql, fila, ctx.value.tenantId, "inventory.revalued", {
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

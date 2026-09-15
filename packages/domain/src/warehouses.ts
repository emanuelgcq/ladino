import { err, ok, type Result } from "@ladino/core";
import type { TransactionSql, UnitOfWork, JSONValue } from "@ladino/db";
import type {
  CreateWarehouseRequest,
  UpdateWarehouseRequest,
  WarehouseResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";

/**
 * DEPÓSITOS (migración 60, QA de pantalla 2026-09-15 h. 40/46/47/49).
 *
 * Antes el alta era un INSERT crudo en la ruta: no ataba el depósito al dueño
 * (403 al vender, recibir o mover ahí) y no había forma de renombrarlo,
 * apagarlo ni elegir el principal. La caja tomaba «el primero por código», así
 * que un depósito nuevo podía quitarle el puesto al que nació con la empresa.
 *
 * Las reglas:
 *   · el principal lo define `platform.default_warehouse()` — el elegido en
 *     ajustes si está activo; si no, el activo más antiguo;
 *   · todo depósito nuevo queda atado a los DUEÑOS (`bind_owner_warehouse_scope`);
 *   · el código es corto y en mayúsculas («W2», «FONDO»), como dice la ayuda;
 *   · no se apaga el principal, ni un depósito con existencias.
 */
export type WarehouseError =
  | CompanyScopeError
  | { code: "VALIDATION_FAILED"; message: string }
  | { code: "DUPLICATE"; message: string }
  | { code: "WAREHOUSE_IN_USE"; message: string };

const CODIGO = /^[A-Z0-9][A-Z0-9_-]{0,11}$/;

const COLUMNAS = `w.id, w.tenant_id, w.company_id, w.branch_id, w.code, w.name, w.status,
  (w.id = platform.default_warehouse(w.company_id)) as is_default`;

async function auditar(
  sql: TransactionSql,
  tenantId: string,
  companyId: string,
  warehouseId: string,
  evento: string,
  payload: Record<string, JSONValue>,
): Promise<void> {
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${companyId}, 'warehouse', ${warehouseId}, ${evento},
            'user', now(), ${RULES_VERSION}, ${sql.json(payload)})`;
}

export async function listWarehouses(
  uow: UnitOfWork,
  companyId: string,
): Promise<Result<WarehouseResponse[], WarehouseError>> {
  const { sql } = uow;
  // El principal primero, luego los activos por código, los apagados al final:
  // quien toma «el primero» toma el principal.
  const filas = await sql<WarehouseResponse[]>`
    select ${sql.unsafe(COLUMNAS)}
      from public.warehouses w
     where w.company_id = ${companyId}
     order by (w.id = platform.default_warehouse(w.company_id)) desc,
              (w.status = 'active') desc, w.code`;
  return ok(filas);
}

export async function createWarehouse(
  uow: UnitOfWork,
  input: CreateWarehouseRequest,
): Promise<Result<WarehouseResponse, WarehouseError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Crear un almacén exige un usuario real." });
  }
  const ctx = await companyScope(sql, actor.userId, input.company_id, "warehouse.manage");
  if (!ctx.ok) return ctx;
  if (ctx.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const code = input.code.trim().toUpperCase();
  if (!CODIGO.test(code)) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "El código es corto: letras sin tilde, números, guion o guion bajo, hasta 12 caracteres (W2, FONDO).",
    });
  }
  const name = input.name.trim();
  const [repetido] = await sql<{ id: string }[]>`
    select id from public.warehouses where company_id = ${input.company_id} and upper(code) = ${code}`;
  if (repetido) {
    return err({ code: "DUPLICATE", message: `Ya hay un depósito con el código ${code}.` });
  }
  const [creado] = await sql<{ id: string }[]>`
    insert into public.warehouses (tenant_id, company_id, branch_id, code, name)
    values (${ctx.value.tenantId}, ${input.company_id}, ${input.branch_id ?? null}, ${code}, ${name})
    returning id`;
  // El dueño tiene los verbos de almacén por su warehouse_ops acotado: sin este
  // binding, vender o recibir en el depósito nuevo le respondía 403 a él mismo.
  await sql`select platform.bind_owner_warehouse_scope(${input.company_id})`;
  await auditar(sql, ctx.value.tenantId, input.company_id, creado!.id, "warehouse.created", {
    code,
    name,
  });
  const [fila] = await sql<WarehouseResponse[]>`
    select ${sql.unsafe(COLUMNAS)} from public.warehouses w where w.id = ${creado!.id}`;
  return ok(fila!);
}

export async function updateWarehouse(
  uow: UnitOfWork,
  warehouseId: string,
  input: UpdateWarehouseRequest,
): Promise<Result<WarehouseResponse, WarehouseError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Cambiar un almacén exige un usuario real.",
    });
  }
  const ctx = await companyScope(sql, actor.userId, input.company_id, "warehouse.manage");
  if (!ctx.ok) return ctx;
  if (ctx.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const [actual] = await sql<{ id: string; name: string; status: string; es_principal: boolean }[]>`
    select w.id, w.name, w.status, (w.id = platform.default_warehouse(w.company_id)) as es_principal
      from public.warehouses w
     where w.id = ${warehouseId} and w.company_id = ${input.company_id}
     for update`;
  if (!actual) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });

  if (input.status === "inactive" && actual.status === "active") {
    if (actual.es_principal || input.make_default === true) {
      return err({
        code: "WAREHOUSE_IN_USE",
        message: "El depósito principal no se puede apagar: elige otro como principal primero.",
      });
    }
    const [conExistencia] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.stock_balances
       where company_id = ${input.company_id} and warehouse_id = ${warehouseId} and quantity <> 0`;
    if (Number(conExistencia!.n) > 0) {
      return err({
        code: "WAREHOUSE_IN_USE",
        message: "Ese depósito todavía tiene mercancía: transfiérela a otro antes de apagarlo.",
      });
    }
  }
  if (input.make_default === true && (input.status ?? actual.status) !== "active") {
    return err({
      code: "VALIDATION_FAILED",
      message: "Un depósito apagado no puede ser el principal.",
    });
  }

  if (input.make_default === true) {
    // El principal vive en los ajustes de la empresa. Cambiarlo exige además el
    // permiso de ajustes: es lo que decide de dónde descuenta la caja.
    const ajustes = await companyScope(
      sql,
      actor.userId,
      input.company_id,
      "company.settings.manage",
    );
    if (!ajustes.ok) return ajustes;
  }

  // TODAS las validaciones van antes de escribir: withTransaction confirma lo
  // escrito aunque el caso de uso devuelva err (la lección de compras, CLAUDE.md §3).
  const name = input.name?.trim();
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  await sql`
    update public.warehouses
       set name = coalesce(${name ?? null}, name),
           status = coalesce(${input.status ?? null}, status)
     where id = ${warehouseId} and company_id = ${input.company_id}`;
  if (input.make_default === true) {
    await sql`
      insert into public.company_settings (company_id, tenant_id, default_warehouse_id)
      values (${input.company_id}, ${ctx.value.tenantId}, ${warehouseId})
      on conflict (company_id) do update set default_warehouse_id = excluded.default_warehouse_id`;
  }
  await auditar(sql, ctx.value.tenantId, input.company_id, warehouseId, "warehouse.updated", {
    ...(name === undefined ? {} : { name }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.make_default === true ? { make_default: true } : {}),
  });
  const [fila] = await sql<WarehouseResponse[]>`
    select ${sql.unsafe(COLUMNAS)} from public.warehouses w where w.id = ${warehouseId}`;
  return ok(fila!);
}

import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork } from "@ladino/db";
import type { ListPosCartsResponse, PosCartResponse, UpsertPosCartRequest } from "@ladino/schemas";
import { companyScope, type CompanyScopeError } from "./company-scope.js";

/**
 * CUENTAS ABIERTAS del POS (migración 44) — RIGOR NORMAL a propósito.
 *
 * Esta tabla guarda la INTENCIÓN de una venta en armado: productos y
 * cantidades, cliente y nota. Nunca precios — al retomar, el POS recotiza
 * contra `posQuote` a la tasa de HOY (ADR-0047). No reserva mercancía (eso
 * es el PEDIDO), no numera nada y no genera asientos: por eso muta y se
 * borra sin ceremonia, y el borrado de verdad lo hace `quickSale` en la
 * MISMA transacción del cobro.
 *
 * Decisiones de peso:
 *   · el `id` lo pone la CAJA. El upsert es idempotente por naturaleza
 *     (misma clave ⇒ mismo carrito), así que la ruta NO lleva
 *     `Idempotency-Key` — el mismo principio que la subida de imágenes;
 *   · aquí NO se validan los productos línea a línea: esto se guarda en
 *     cada tecleo de la cajera y tiene que ser barato. Un producto borrado
 *     o inactivo lo rechaza la cotización al retomar, que es donde importa;
 *   · «last write wins»: la caja que escribió de último manda. Dos cajas
 *     editando el mismo carrito es un conflicto humano, no técnico.
 */
export type PosCartError = CompanyScopeError | { code: "VALIDATION_FAILED"; message: string };

const CART_COLUMNS = `id, label, customer_id, lines, note,
  to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at`;

const PERMISO = "sales.invoice.issue";

export async function listPosCarts(
  uow: UnitOfWork,
  companyId: string,
): Promise<Result<ListPosCartsResponse, PosCartError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Vender exige un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, companyId, PERMISO);
  if (!scope.ok) return scope;

  const items = await sql<PosCartResponse[]>`
    select ${sql.unsafe(CART_COLUMNS)} from public.pos_carts
     where company_id = ${companyId}
     order by updated_at desc, id`;
  return ok({ items: items.map((c) => ({ ...c })) });
}

export async function upsertPosCart(
  uow: UnitOfWork,
  cartId: string,
  input: UpsertPosCartRequest,
): Promise<Result<PosCartResponse, PosCartError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Vender exige un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, PERMISO);
  if (!scope.ok) return scope;

  // Cantidad cero: inofensiva en un borrador, pero es ruido que la cotización
  // rechazaría después con peor mensaje. Se corta aquí, que es barato.
  if (input.lines.some((l) => Number(l.qty) === 0)) {
    return err({ code: "VALIDATION_FAILED", message: "Una línea tiene cantidad cero." });
  }

  // El cliente sí se comprueba (una sola consulta): dejar que el FK explote
  // condenaría la transacción, y el error de Postgres no es mensaje de nadie.
  const customerId = input.customer_id ?? null;
  if (customerId !== null) {
    const [cli] = await sql<{ id: string }[]>`
      select id from public.customers
       where company_id = ${input.company_id} and id = ${customerId}`;
    if (!cli) {
      return err({ code: "VALIDATION_FAILED", message: "Ese cliente no existe en la empresa." });
    }
  }

  const [cart] = await sql<PosCartResponse[]>`
    insert into public.pos_carts
      (id, tenant_id, company_id, label, customer_id, lines, note, updated_at, updated_by)
    values
      (${cartId}, ${scope.value.tenantId}, ${input.company_id}, ${input.label},
       ${customerId}, ${sql.json(input.lines)}, ${input.note ?? null},
       clock_timestamp(), ${actor.userId})
    on conflict (id) do update
      set label = excluded.label,
          customer_id = excluded.customer_id,
          lines = excluded.lines,
          note = excluded.note,
          updated_at = clock_timestamp(),
          updated_by = excluded.updated_by
      where pos_carts.company_id = excluded.company_id
    returning ${sql.unsafe(CART_COLUMNS)}`;
  if (!cart) {
    // Colisión de uuid con un carrito de OTRA empresa: prácticamente
    // imposible por accidente; si pasa, es adrede y no se pisa nada.
    return err({ code: "VALIDATION_FAILED", message: "Ese identificador ya está en uso." });
  }
  return ok({ ...cart });
}

export async function deletePosCart(
  uow: UnitOfWork,
  companyId: string,
  cartId: string,
): Promise<Result<{ deleted: boolean }, PosCartError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Vender exige un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, companyId, PERMISO);
  if (!scope.ok) return scope;

  // Borrar lo ya borrado no es un error: la caja pudo cobrarlo desde otra
  // pestaña, o el worker purgarlo. Se responde qué pasó y ya.
  const borrados = await sql`
    delete from public.pos_carts where company_id = ${companyId} and id = ${cartId}`;
  return ok({ deleted: borrados.count > 0 });
}

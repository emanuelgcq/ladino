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
 * descarta sin ceremonia mientras está abierta. Al cobrarse, `quickSale` la MARCA
 * vendida en la MISMA transacción (ADR-0076) y queda como lápida.
 *
 * Decisiones de peso:
 *   · el `id` lo pone la CAJA. El upsert es idempotente por naturaleza
 *     (misma clave ⇒ mismo carrito), así que la ruta NO lleva
 *     `Idempotency-Key` — el mismo principio que la subida de imágenes;
 *   · aquí NO se validan los productos línea a línea: esto se guarda en
 *     cada tecleo de la cajera y tiene que ser barato. Un producto borrado
 *     o inactivo lo rechaza la cotización al retomar, que es donde importa;
 *   · «last write wins» ENTRE QUIENES PUEDEN escribirla: su autor y quien tenga
 *     `pos.carts.manage` (ADR-0076, E-08). Los demás la ven en solo lectura;
 *   · una cuenta VENDIDA es una lápida (ADR-0076, M-01): el upsert no la
 *     resucita — responde 409 POS_CART_SOLD — y la lista no la enseña.
 */
/** El 409 de la cuenta cobrada, con la venta que la cerró (ADR-0076). */
export interface PosCartSoldError {
  code: "POS_CART_SOLD";
  message: string;
  details: { sale_id: string | null; series: string | null; document_number: string | null };
}

export type PosCartError =
  CompanyScopeError | { code: "VALIDATION_FAILED"; message: string } | PosCartSoldError;

/** Las columnas de la respuesta, sobre `pos_carts pc` (`editable` va aparte). */
const CART_COLUMNS = `pc.id, pc.label, pc.customer_id, pc.lines, pc.note,
  to_char(pc.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
  to_char(pc.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
  pc.created_by, pc.station_id,
  (select nullif(btrim(up.full_name), '') from public.users_profile up
    where up.user_id = pc.created_by) as author_name`;

const PERMISO = "sales.invoice.issue";
/** Cobrar, cambiar o borrar la cuenta que armó OTRA persona (ADR-0076). */
export const PERMISO_CUENTAS_AJENAS = "pos.carts.manage";

/** ¿Tiene el actor `pos.carts.manage` en esta empresa? Una consulta, sin fallar. */
export async function puedeCuentasAjenas(
  sql: UnitOfWork["sql"],
  userId: string,
  companyId: string,
): Promise<boolean> {
  const [r] = await sql<{ ok: boolean }[]>`
    select platform.ladino_user_has_permission(${userId}, ${PERMISO_CUENTAS_AJENAS},
                                               ${companyId}) as ok`;
  return r?.ok === true;
}

/** El 409 de la cuenta ya cobrada, con la venta que la cerró para que la caja la nombre. */
export async function cuentaVendida(
  sql: UnitOfWork["sql"],
  companyId: string,
  saleId: string | null,
): Promise<PosCartSoldError> {
  const [d] =
    saleId === null
      ? [undefined]
      : await sql<{ series: string | null; document_number: string | null }[]>`
          select series, document_number::text as document_number from public.documents
           where company_id = ${companyId} and id = ${saleId}`;
  const cual = d?.document_number != null ? ` (venta ${d.series ?? ""}-${d.document_number})` : "";
  return {
    code: "POS_CART_SOLD",
    message:
      `Esa cuenta ya se cobró${cual}. No se puede cobrar ni cambiar otra vez: ` +
      "si el cliente quiere algo más, ábrele una cuenta nueva.",
    details: {
      sale_id: saleId,
      series: d?.series ?? null,
      document_number: d?.document_number ?? null,
    },
  };
}

/** El 403 de la cuenta ajena: con el permiso que hace falta (la API lo dice en palabras). */
export function cuentaAjena(): { code: "PERMISSION_REQUIRED"; message: string } {
  return {
    code: "PERMISSION_REQUIRED",
    message:
      "Esta cuenta la armó otra persona: la cobra, la cambia o la borra su autor o quien " +
      `tenga el permiso ${PERMISO_CUENTAS_AJENAS}.`,
  };
}

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

  const gestiona = await puedeCuentasAjenas(sql, actor.userId, companyId);
  // Las vendidas no vuelven a la caja: son lápidas (ADR-0076).
  const items = await sql<PosCartResponse[]>`
    select ${sql.unsafe(CART_COLUMNS)},
           (${gestiona} or pc.created_by is not distinct from ${actor.userId}) as editable
      from public.pos_carts pc
     where pc.company_id = ${companyId} and pc.sold_at is null
     order by pc.updated_at desc, pc.id`;
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

  // DE QUIÉN ES y SI VIVE, con la fila bloqueada (ADR-0076): la venta la bloquea igual antes
  // de marcarla, así que un PUT que llega durante el cobro espera y ve la lápida (M-01).
  const [previa] = await sql<
    {
      company_id: string;
      created_by: string | null;
      sold_at: string | null;
      sale_id: string | null;
    }[]
  >`
    select company_id, created_by, sold_at, sale_id from public.pos_carts
     where id = ${cartId} for update`;
  if (previa && previa.company_id !== input.company_id) {
    // Colisión de uuid con un carrito de OTRA empresa: prácticamente
    // imposible por accidente; si pasa, es adrede y no se pisa nada.
    return err({ code: "VALIDATION_FAILED", message: "Ese identificador ya está en uso." });
  }
  if (previa && previa.sold_at !== null) {
    return err(await cuentaVendida(sql, input.company_id, previa.sale_id));
  }
  const gestiona = await puedeCuentasAjenas(sql, actor.userId, input.company_id);
  if (previa && previa.created_by !== actor.userId && !gestiona) return err(cuentaAjena());

  const [cart] = await sql<PosCartResponse[]>`
    with escrita as (
      insert into public.pos_carts as pc
        (id, tenant_id, company_id, label, customer_id, lines, note, station_id,
         updated_at, updated_by)
      values
        (${cartId}, ${scope.value.tenantId}, ${input.company_id}, ${input.label},
         ${customerId}, ${sql.json(input.lines)}, ${input.note ?? null},
         ${input.station_id ?? null}, clock_timestamp(), ${actor.userId})
      on conflict (id) do update
        set label = excluded.label,
            customer_id = excluded.customer_id,
            lines = excluded.lines,
            note = excluded.note,
            station_id = coalesce(excluded.station_id, pc.station_id),
            updated_at = clock_timestamp(),
            updated_by = excluded.updated_by
        where pc.company_id = excluded.company_id and pc.sold_at is null
      returning pc.*
    )
    select ${sql.unsafe(CART_COLUMNS)},
           (${gestiona} or pc.created_by is not distinct from ${actor.userId}) as editable
      from escrita pc`;
  if (!cart) {
    // Con la fila bloqueada arriba no debería pasar; si pasa (la insertó otra transacción
    // entre la lectura y la escritura), se relee y se responde lo que es.
    const [ahora] = await sql<{ sale_id: string | null; sold_at: string | null }[]>`
      select sale_id, sold_at from public.pos_carts where id = ${cartId}`;
    if (ahora && ahora.sold_at !== null) {
      return err(await cuentaVendida(sql, input.company_id, ahora.sale_id));
    }
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
  // Una cuenta VENDIDA no se borra (es la lápida que impide resucitarla, ADR-0076): se
  // responde que no se borró. Una ajena la borra su autor o quien tenga pos.carts.manage.
  const [fila] = await sql<{ created_by: string | null; sold_at: string | null }[]>`
    select created_by, sold_at from public.pos_carts
     where company_id = ${companyId} and id = ${cartId} for update`;
  if (!fila || fila.sold_at !== null) return ok({ deleted: false });
  if (
    fila.created_by !== actor.userId &&
    !(await puedeCuentasAjenas(sql, actor.userId, companyId))
  ) {
    return err(cuentaAjena());
  }
  const borrados = await sql`
    delete from public.pos_carts
     where company_id = ${companyId} and id = ${cartId} and sold_at is null`;
  return ok({ deleted: borrados.count > 0 });
}

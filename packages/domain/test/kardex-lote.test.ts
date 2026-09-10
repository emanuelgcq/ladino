import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createClient, withTransaction, type UnitOfWork } from "@ladino/db";
import { issueStockBatch, receiveStock } from "../src/index.js";

/**
 * EQUIVALENCIA BATCH = BUCLE, sobre la base REAL y como `ladino_api`.
 *
 * La salida multi-línea (2026-09-10) dejó de repetir por renglón la
 * autorización, el bloqueo, el insert y el acta. Lo único que no puede
 * cambiar es el DINERO: el promedio ponderado móvil tiene que dar el mismo
 * costo que daba el bucle, y el saldo materializado tiene que seguir siendo
 * el que reproduce el kardex.
 *
 * El caso que más fácil rompe un lote es el que va primero: **el mismo
 * producto dos veces en el mismo carrito**. Si el lote calculara ambas
 * líneas contra la posición inicial en vez de encadenarlas, la segunda
 * saldría a un costo que no existe — y este fichero lo vería.
 *
 * Se comprueba contra el ORÁCULO de la base (`apply_inventory_move`, LAD41),
 * que verifica cada fila contra el saldo del momento: si el cálculo de este
 * paquete se desviara, el insert se rechaza en vez de escribir el error.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";

const RUN = Date.now().toString(36);
const TENANT = crypto.randomUUID();
const COMPANY = crypto.randomUUID();
const W1 = crypto.randomUUID();
const JEFE = crypto.randomUUID();
const ROL = crypto.randomUUID();
const MEM = crypto.randomUUID();
const ASIG = crypto.randomUUID();

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
const PROD: string[] = [];

const como = <T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> =>
  withTransaction(sqlApi, { kind: "user", userId: JEFE }, fn);

/** El saldo materializado y el que reproduce el kardex, para compararlos. */
async function saldos(productId: string): Promise<{ mat: string; kardex: string; valor: string }> {
  const [b] = await sql<{ q: string; v: string }[]>`
    select quantity::text as q, value::text as v from public.stock_balances
     where company_id = ${COMPANY} and warehouse_id = ${W1} and product_id = ${productId}
       and lot_id is null`;
  const [k] = await sql<{ q: string }[]>`
    select coalesce(sum(quantity), 0)::text as q from public.inventory_moves
     where company_id = ${COMPANY} and warehouse_id = ${W1} and product_id = ${productId}`;
  return { mat: b?.q ?? "0", kardex: k?.q ?? "0", valor: b?.v ?? "0" };
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  await sql`insert into auth.users (id) values (${JEFE}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${JEFE}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant kardex lote')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code)
             values (${COMPANY}, ${TENANT}, ${`J-KL-${RUN}`}, 'Kardex lote', 'VES')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'KL-W1', 'Principal')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, ${`kardexlote_${RUN}`}, 'Jefe kardex lote', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key)
             values (${ROL}, 'inventory.move') on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${MEM}, ${TENANT}, ${JEFE})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id)
             values (${ASIG}, ${TENANT}, ${MEM}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, ${ASIG}, 'warehouse', ${W1})`;
    for (let i = 1; i <= 3; i++) {
      const [p] = await tx<{ id: string }[]>`
        insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                     tax_category_code)
        values (${TENANT}, ${COMPANY}, ${`KL-${RUN}-${i}`}, ${`Producto ${i}`}, 'good', 'active',
                'unidad', 'gravado_general')
        returning id`;
      PROD.push(p!.id);
    }
  });

  // Entradas a costos DISTINTOS para que el promedio no sea trivial: si el
  // lote se equivocara de posición, un promedio plano lo escondería.
  for (let i = 0; i < PROD.length; i++) {
    // 100 a 7 y 50 a 11 → 150 unidades por 1 250, promedio 8,333…
    for (const [q, total] of [
      ["100", "700"],
      ["50", "550"],
    ] as const) {
      const r = await como((uow) =>
        receiveStock(uow, {
          company_id: COMPANY,
          warehouse_id: W1,
          product_id: PROD[i]!,
          quantity: q,
          amount: total,
          currency: "VES",
          reference: `entrada-${RUN}-${i}-${q}`,
        }),
      );
      expect(r.ok).toBe(true);
    }
  }
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("salida multi-línea", () => {
  it("EL MISMO PRODUCTO DOS VECES en el carrito: la segunda ve lo que dejó la primera", async () => {
    const p = PROD[0]!;
    const antes = await saldos(p);
    // 150 unidades por 1 250 (100×7 + 50×11) → promedio 8,333…
    expect(antes.mat).toBe("150.00000000");

    const r = await como((uow) =>
      issueStockBatch(uow, {
        company_id: COMPANY,
        warehouse_id: W1,
        lines: [
          { product_id: p, quantity: "10" },
          { product_id: p, quantity: "10" },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);

    // El costo de cada salida sale del promedio VIGENTE en su momento. Como
    // el promedio no cambia al sacar al promedio, ambas valen lo mismo — pero
    // los saldos ACUMULADOS sí encadenan, y eso es lo que se comprueba.
    expect(r.value[0]!.quantity_after).toBe("140.00000000");
    expect(r.value[1]!.quantity_after).toBe("130.00000000");

    const despues = await saldos(p);
    expect(despues.mat).toBe("130.00000000");
    // EL INVARIANTE: el saldo materializado es el que reproduce el kardex.
    expect(despues.mat).toBe(despues.kardex);
  });

  it("varios productos en un carrito: cada uno descuenta lo suyo y el saldo cuadra", async () => {
    const [, p2, p3] = PROD;
    const r = await como((uow) =>
      issueStockBatch(uow, {
        company_id: COMPANY,
        warehouse_id: W1,
        lines: [
          { product_id: p2!, quantity: "20" },
          { product_id: p3!, quantity: "5" },
          { product_id: p2!, quantity: "30" },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(3);
    // Devuelve en el ORDEN de las líneas recibidas, no en el del bloqueo.
    expect(r.value[0]!.product_id).toBe(p2);
    expect(r.value[1]!.product_id).toBe(p3);
    expect(r.value[2]!.product_id).toBe(p2);
    // Y el encadenado del repetido: 150 → 130 → 100.
    expect(r.value[0]!.quantity_after).toBe("130.00000000");
    expect(r.value[2]!.quantity_after).toBe("100.00000000");

    for (const p of [p2!, p3!]) {
      const s = await saldos(p);
      expect(s.mat).toBe(s.kardex);
    }
  });

  it("si una línea deja la existencia en negativo, NO se escribe ninguna", async () => {
    const p = PROD[2]!;
    const antes = await saldos(p);
    const r = await como((uow) =>
      issueStockBatch(uow, {
        company_id: COMPANY,
        warehouse_id: W1,
        lines: [
          { product_id: p, quantity: "1" },
          { product_id: p, quantity: "99999" },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NEGATIVE_STOCK");
    // La primera línea tampoco entró: el lote vive o muere entero.
    const despues = await saldos(p);
    expect(despues.mat).toBe(antes.mat);
    expect(despues.mat).toBe(despues.kardex);
  });

  it("sin permiso, el lote entero se rechaza", async () => {
    const otro = crypto.randomUUID();
    await sql`insert into auth.users (id) values (${otro}) on conflict (id) do nothing`;
    const r = await withTransaction(sqlApi, { kind: "user", userId: otro }, (uow) =>
      issueStockBatch(uow, {
        company_id: COMPANY,
        warehouse_id: W1,
        lines: [{ product_id: PROD[0]!, quantity: "1" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(["PERMISSION_REQUIRED", "NOT_FOUND"]).toContain(r.error.code);
  });
});

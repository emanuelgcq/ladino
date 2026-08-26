import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createClient, withTransaction, type UnitOfWork } from "@ladino/db";
import { receiveStock, issueStock, adjustStock, transferStock } from "../src/index.js";

/**
 * Inventario contra la base REAL como `ladino_api`. Lo que gobierna aquí y no en
 * el pgTAP: que el costeo del PAQUETE PURO y el oráculo del ESQUEMA coincidan de
 * punta a punta —si discreparan, el INSERT moriría con LAD41 y estos tests se
 * pondrían rojos—, el alcance POR ALMACÉN, y la transferencia como un solo hecho.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";

const TENANT = "d1d1d1d1-0000-4000-8000-000000000001";
const COMPANY = "d1d1d1d1-0000-4000-8000-000000000002";
const W1 = "d1d1d1d1-0000-4000-8000-0000000000f1";
const W2 = "d1d1d1d1-0000-4000-8000-0000000000f2";
const JEFE = "d1d1d1d1-0000-4000-8000-00000000000a"; // move+adjust+transfer en W1 y W2
const ALMACENISTA = "d1d1d1d1-0000-4000-8000-00000000000b"; // move SOLO en W1
const RUN = Date.now().toString(36);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let PROD = "";
const como = <T>(userId: string, fn: (uow: UnitOfWork) => Promise<T>) =>
  withTransaction(sqlApi, { kind: "user", userId }, fn);

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  await sql`insert into auth.users (id) values (${JEFE}), (${ALMACENISTA}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${JEFE}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant inv') on conflict (id) do nothing`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name)
             values (${COMPANY}, ${TENANT}, 'J-INV', 'Empresa inventario') on conflict (id) do nothing`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name) values
             (${W1}, ${TENANT}, ${COMPANY}, 'INV-W1', 'Principal'),
             (${W2}, ${TENANT}, ${COMPANY}, 'INV-W2', 'Sucursal')
             on conflict (id) do nothing`;
    // Los roles que mueven existencias DECLARAN requires_scope: los permisos de
    // inventario son acotados y LAD25 rechaza lo contrario (ADR-0025 §4).
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             ('d1d1d1d1-0000-4000-8000-0000000000e1', null, 'inv_jefe', 'Jefe', true),
             ('d1d1d1d1-0000-4000-8000-0000000000e2', null, 'inv_almacenista', 'Almacenista', true)
             on conflict (id) do nothing`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             ('d1d1d1d1-0000-4000-8000-0000000000e1', 'inventory.move'),
             ('d1d1d1d1-0000-4000-8000-0000000000e1', 'inventory.adjust'),
             ('d1d1d1d1-0000-4000-8000-0000000000e1', 'inventory.transfer'),
             ('d1d1d1d1-0000-4000-8000-0000000000e2', 'inventory.move')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             ('d1d1d1d1-0000-4000-8000-0000000000a1', ${TENANT}, ${JEFE}),
             ('d1d1d1d1-0000-4000-8000-0000000000b1', ${TENANT}, ${ALMACENISTA})
             on conflict (id) do nothing`;
    await tx`insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
             ('d1d1d1d1-0000-4000-8000-0000000000a2', ${TENANT}, 'd1d1d1d1-0000-4000-8000-0000000000a1', 'd1d1d1d1-0000-4000-8000-0000000000e1', null),
             ('d1d1d1d1-0000-4000-8000-0000000000b2', ${TENANT}, 'd1d1d1d1-0000-4000-8000-0000000000b1', 'd1d1d1d1-0000-4000-8000-0000000000e2', null)
             on conflict (id) do nothing`;
    await tx`insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id) values
             (${TENANT}, ${COMPANY}, 'd1d1d1d1-0000-4000-8000-0000000000a2', 'warehouse', ${W1}),
             (${TENANT}, ${COMPANY}, 'd1d1d1d1-0000-4000-8000-0000000000a2', 'warehouse', ${W2}),
             (${TENANT}, ${COMPANY}, 'd1d1d1d1-0000-4000-8000-0000000000b2', 'warehouse', ${W1})
             on conflict do nothing`;
    const [p] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`INV-${RUN}`}, 'Producto de inventario', 'good', 'active',
              'unidad', 'gravado_general')
      returning id`;
    PROD = p!.id;
  });
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

const posicion = () => ({ company_id: COMPANY, warehouse_id: W1, product_id: PROD });

describe("costeo promedio ponderado móvil, de punta a punta", () => {
  it("10 @ 1000 + 5 @ 650 → promedio 110; salida de 3 → 330; el kardex cuadra con las existencias", async () => {
    const e1 = await como(JEFE, (uow) =>
      receiveStock(uow, { ...posicion(), quantity: "10", amount: "1000", currency: "VES" }),
    );
    expect(e1.ok && e1.value.unit_cost).toBe("100.00000000");

    const e2 = await como(JEFE, (uow) =>
      receiveStock(uow, { ...posicion(), quantity: "5", amount: "650", currency: "VES" }),
    );
    expect(e2.ok && e2.value.unit_cost).toBe("110.00000000");
    expect(e2.ok && e2.value.value_after).toBe("1650.00000000");

    const s1 = await como(JEFE, (uow) => issueStock(uow, { ...posicion(), quantity: "3" }));
    expect(s1.ok && s1.value.functional_amount).toBe("-330.00000000");
    expect(s1.ok && s1.value.quantity_after).toBe("12.00000000");
    // El costo unitario NO cambia al salir: es el punto del promedio móvil.
    expect(s1.ok && s1.value.unit_cost).toBe("110.00000000");

    // Y el criterio de aceptación: materializado == recalculado, sin divergencias.
    const [div] = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.stock_reconciliation(${COMPANY})`;
    expect(div?.n).toBe(0);
  });

  it("entrada en USD: los siete campos de ADR-0020 quedan en el movimiento y el costo va en funcional", async () => {
    const r = await como(JEFE, (uow) =>
      receiveStock(uow, {
        ...posicion(),
        quantity: "7",
        amount: "21.00000000",
        currency: "USD",
        fx: { rate: "41.15226301", source: "BCV:tasa-oficial", at: "2026-08-26T10:00:00.000Z" },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.transaction_currency).toBe("USD");
    expect(r.value.amount_transaction_currency).toBe("21.00000000");
    expect(r.value.fx_rate).toBe("41.15226301");
    expect(r.value.rate_source).toBe("BCV:tasa-oficial");
    expect(r.value.functional_currency).toBe("VES");
    // 21 × 41.15226301 = 864.19752321 exacto (cabe en 8 decimales).
    expect(r.value.functional_amount).toBe("864.19752321");
    expect(r.value.rounding_policy_id).toBe("inventory:cost:8:HALF_UP");
  });

  it("una entrada en moneda ajena SIN fuente de tasa no se persiste (ADR-0020)", async () => {
    const r = await como(JEFE, (uow) =>
      receiveStock(uow, { ...posicion(), quantity: "1", amount: "1", currency: "USD" }),
    );
    expect(!r.ok && r.error.code).toBe("VALIDATION_FAILED");
    expect(!r.ok && r.error.message).toContain("fuente");
  });
});

describe("negativo: nunca silencioso", () => {
  it("sin allow_negative_stock la salida que deja negativo se rechaza con palabras", async () => {
    const r = await como(JEFE, (uow) => issueStock(uow, { ...posicion(), quantity: "99999" }));
    expect(!r.ok && r.error.code).toBe("NEGATIVE_STOCK");
  });
});

describe("alcance POR ALMACÉN, no por empresa", () => {
  it("el almacenista con binding a W1 mueve W1 y NO mueve W2", async () => {
    const enW1 = await como(ALMACENISTA, (uow) =>
      receiveStock(uow, { ...posicion(), quantity: "1", amount: "110", currency: "VES" }),
    );
    expect(enW1.ok).toBe(true);

    const enW2 = await como(ALMACENISTA, (uow) =>
      receiveStock(uow, {
        company_id: COMPANY,
        warehouse_id: W2,
        product_id: PROD,
        quantity: "1",
        amount: "110",
        currency: "VES",
      }),
    );
    expect(!enW2.ok && enW2.error.code).toBe("PERMISSION_REQUIRED");
    expect(!enW2.ok && enW2.error.message).toContain("almacén");
  });

  it("el almacenista no ajusta: inventory.adjust es un permiso distinto (segregación)", async () => {
    const r = await como(ALMACENISTA, (uow) =>
      adjustStock(uow, { ...posicion(), delta: "1", reason: "conteo" }),
    );
    expect(!r.ok && r.error.code).toBe("PERMISSION_REQUIRED");
  });
});

describe("ajuste", () => {
  it("positivo sin costo entra al promedio vigente y negativo sale como una salida", async () => {
    const [antes] = await sql<{ q: string; c: string }[]>`
      select quantity::text as q, last_unit_cost::text as c from public.stock_balances
       where warehouse_id = ${W1} and product_id = ${PROD}`;
    const up = await como(JEFE, (uow) =>
      adjustStock(uow, { ...posicion(), delta: "2", reason: "sobrante de conteo" }),
    );
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    expect(up.value.reason).toBe("sobrante de conteo");
    // 2 × el promedio vigente antes del ajuste.
    const esperado = (BigInt(antes!.c.replace(".", "")) * 2n).toString();
    expect(up.value.functional_amount.replace(".", "")).toBe(esperado);

    const down = await como(JEFE, (uow) =>
      adjustStock(uow, { ...posicion(), delta: "-2", reason: "faltante de conteo" }),
    );
    expect(down.ok && down.value.quantity).toBe("-2.00000000");
    expect(down.ok && down.value.quantity_after).toBe(antes!.q);
  });
});

describe("transferencia: un solo hecho, dos patas", () => {
  it("mueve al costo de origen, cuadra a cero y deja las dos existencias coherentes", async () => {
    const [origenAntes] = await sql<{ q: string; v: string; c: string }[]>`
      select quantity::text as q, value::text as v, last_unit_cost::text as c
        from public.stock_balances where warehouse_id = ${W1} and product_id = ${PROD}`;

    const r = await como(JEFE, (uow) =>
      transferStock(uow, {
        company_id: COMPANY,
        from_warehouse_id: W1,
        to_warehouse_id: W2,
        product_id: PROD,
        quantity: "4",
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.out.kind).toBe("transferencia_out");
    expect(r.value.in.kind).toBe("transferencia_in");
    expect(r.value.out.transfer_id).toBe(r.value.transfer_id);
    expect(r.value.in.transfer_id).toBe(r.value.transfer_id);
    // Suman cero: el stock no se crea ni se destruye.
    expect(
      BigInt(r.value.out.quantity.replace(/[.-]/g, "")) -
        BigInt(r.value.in.quantity.replace(".", "")),
    ).toBe(0n);
    expect(
      BigInt(r.value.out.functional_amount.replace(/[.-]/g, "")) -
        BigInt(r.value.in.functional_amount.replace(".", "")),
    ).toBe(0n);
    // El destino recibe AL COSTO DE ORIGEN: el promedio de origen no cambia.
    expect(r.value.out.unit_cost).toBe(origenAntes!.c);
    expect(r.value.in.unit_cost).toBe(origenAntes!.c);

    const [div] = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.stock_reconciliation(${COMPANY})`;
    expect(div?.n).toBe(0);
  });

  it("al mismo almacén no es una transferencia", async () => {
    const r = await como(JEFE, (uow) =>
      transferStock(uow, {
        company_id: COMPANY,
        from_warehouse_id: W1,
        to_warehouse_id: W1,
        product_id: PROD,
        quantity: "1",
      }),
    );
    expect(!r.ok && r.error.code).toBe("VALIDATION_FAILED");
  });

  it("el almacenista no transfiere: no tiene inventory.transfer ni en su almacén", async () => {
    const r = await como(ALMACENISTA, (uow) =>
      transferStock(uow, {
        company_id: COMPANY,
        from_warehouse_id: W1,
        to_warehouse_id: W2,
        product_id: PROD,
        quantity: "1",
      }),
    );
    expect(!r.ok && r.error.code).toBe("PERMISSION_REQUIRED");
  });
});

describe("el kardex es append-only también desde el caso de uso", () => {
  it("cada movimiento deja su fila de auditoría y su evento de outbox, y ninguno se puede editar", async () => {
    const r = await como(JEFE, (uow) =>
      receiveStock(uow, {
        ...posicion(),
        quantity: "1",
        amount: "115",
        currency: "VES",
        reference: `AUD-${RUN}`,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [audit] = await sql<{ event_type: string; rules_version: string }[]>`
      select event_type, rules_version from public.audit_events where aggregate_id = ${r.value.id}`;
    expect(audit?.event_type).toBe("stock.received");
    const [outbox] = await sql<{ event_type: string }[]>`
      select event_type from public.outbox where aggregate_id = ${r.value.id}`;
    expect(outbox?.event_type).toBe("stock.received");

    await expect(
      sqlApi`update public.inventory_moves set quantity = 999 where id = ${r.value.id}`,
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("la misma referencia dos veces es DUPLICATE: la clave natural cierra el borde de idempotencia", async () => {
    const input = {
      ...posicion(),
      quantity: "1",
      amount: "115",
      currency: "VES",
      reference: `DUP-${RUN}`,
    };
    expect((await como(JEFE, (uow) => receiveStock(uow, input))).ok).toBe(true);
    const segunda = await como(JEFE, (uow) => receiveStock(uow, input));
    expect(!segunda.ok && segunda.error.code).toBe("DUPLICATE");
  });
});

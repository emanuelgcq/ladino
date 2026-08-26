import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/** Inventario de extremo a extremo con JWT real, como ladino_api: el kardex y las
 *  existencias por HTTP, el alcance por almacén, la transferencia como un hecho y
 *  el negativo rechazado con su código propio. */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const TENANT = "e2110000-0000-4000-8000-000000000001";
const COMPANY = "e2110000-0000-4000-8000-000000000002";
const W1 = "e2110000-0000-4000-8000-0000000000f1";
const W2 = "e2110000-0000-4000-8000-0000000000f2";
const JEFE = "e2110000-0000-4000-8000-00000000000a";
const ALMACENISTA = "e2110000-0000-4000-8000-00000000000b";
const RUN = Date.now().toString(36);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PROD = "";

const tokenDe = (sub: string) =>
  new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);

async function pedir(metodo: string, path: string, sub: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(sub)}`,
    "X-Company-Id": COMPANY,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = crypto.randomUUID();
  }
  return app.request(path, {
    method: metodo,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${JEFE}), (${ALMACENISTA}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${JEFE}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e inv') on conflict (id) do nothing`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name)
             values (${COMPANY}, ${TENANT}, 'J-E2EINV', 'Empresa e2e inventario') on conflict (id) do nothing`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name) values
             (${W1}, ${TENANT}, ${COMPANY}, 'E2E-W1', 'Principal'),
             (${W2}, ${TENANT}, ${COMPANY}, 'E2E-W2', 'Sucursal') on conflict (id) do nothing`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             ('e2110000-0000-4000-8000-0000000000e1', null, 'e2einv_jefe', 'Jefe', true),
             ('e2110000-0000-4000-8000-0000000000e2', null, 'e2einv_alm', 'Almacenista', true)
             on conflict (id) do nothing`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             ('e2110000-0000-4000-8000-0000000000e1', 'inventory.move'),
             ('e2110000-0000-4000-8000-0000000000e1', 'inventory.adjust'),
             ('e2110000-0000-4000-8000-0000000000e1', 'inventory.transfer'),
             ('e2110000-0000-4000-8000-0000000000e1', 'warehouse.manage'),
             ('e2110000-0000-4000-8000-0000000000e2', 'inventory.move')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             ('e2110000-0000-4000-8000-0000000000a1', ${TENANT}, ${JEFE}),
             ('e2110000-0000-4000-8000-0000000000b1', ${TENANT}, ${ALMACENISTA})
             on conflict (id) do nothing`;
    await tx`insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
             ('e2110000-0000-4000-8000-0000000000a2', ${TENANT}, 'e2110000-0000-4000-8000-0000000000a1', 'e2110000-0000-4000-8000-0000000000e1', null),
             ('e2110000-0000-4000-8000-0000000000b2', ${TENANT}, 'e2110000-0000-4000-8000-0000000000b1', 'e2110000-0000-4000-8000-0000000000e2', null)
             on conflict (id) do nothing`;
    await tx`insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id) values
             (${TENANT}, ${COMPANY}, 'e2110000-0000-4000-8000-0000000000a2', 'warehouse', ${W1}),
             (${TENANT}, ${COMPANY}, 'e2110000-0000-4000-8000-0000000000a2', 'warehouse', ${W2}),
             (${TENANT}, ${COMPANY}, 'e2110000-0000-4000-8000-0000000000b2', 'warehouse', ${W1})
             on conflict do nothing`;
    const [p] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2EINV-${RUN}`}, 'Producto e2e', 'good', 'active', 'unidad',
              'gravado_general')
      returning id`;
    PROD = p!.id;
  });
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("inventario de extremo a extremo", () => {
  it("POST /receipts costea el promedio; GET /stock lo devuelve y GET /moves es el kardex", async () => {
    const e1 = await pedir("POST", "/v1/inventory/receipts", JEFE, {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: PROD,
      quantity: "10",
      amount: "1000",
      currency: "VES",
    });
    expect(e1.status).toBe(201);
    expect(((await e1.json()) as { unit_cost: string }).unit_cost).toBe("100.00000000");

    const e2 = await pedir("POST", "/v1/inventory/receipts", JEFE, {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: PROD,
      quantity: "5",
      amount: "650",
      currency: "VES",
    });
    expect(e2.status).toBe(201);
    expect(((await e2.json()) as { unit_cost: string }).unit_cost).toBe("110.00000000");

    const stock = await pedir("GET", `/v1/inventory/stock?product_id=${PROD}`, JEFE);
    expect(stock.status).toBe(200);
    const pagina = (await stock.json()) as {
      items: { quantity: string; value: string; last_unit_cost: string; currency: string }[];
      total: number;
    };
    expect(pagina.total).toBe(1);
    expect(pagina.items[0]).toMatchObject({
      quantity: "15.00000000",
      value: "1650.00000000",
      last_unit_cost: "110.00000000",
      currency: "VES",
    });

    const kardex = await pedir("GET", `/v1/inventory/moves?product_id=${PROD}`, JEFE);
    const movimientos = (await kardex.json()) as { items: { kind: string }[]; total: number };
    expect(movimientos.total).toBe(2);
    // Importes como STRING, nunca number JSON (regla 7).
    expect(typeof (movimientos.items[0] as unknown as { unit_cost: unknown }).unit_cost).toBe(
      "string",
    );
  });

  it("POST /issues sale al promedio; una salida mayor que la existencia es 409 NEGATIVE_STOCK", async () => {
    const s = await pedir("POST", "/v1/inventory/issues", JEFE, {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: PROD,
      quantity: "3",
    });
    expect(s.status).toBe(201);
    expect(((await s.json()) as { functional_amount: string }).functional_amount).toBe(
      "-330.00000000",
    );

    const demasiado = await pedir("POST", "/v1/inventory/issues", JEFE, {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: PROD,
      quantity: "10000",
    });
    expect(demasiado.status).toBe(409);
    expect(((await demasiado.json()) as { code: string }).code).toBe("NEGATIVE_STOCK");
  });

  it("el almacenista mueve SU almacén y recibe 403 en el otro (permiso acotado)", async () => {
    const suyo = await pedir("POST", "/v1/inventory/receipts", ALMACENISTA, {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: PROD,
      quantity: "1",
      amount: "110",
      currency: "VES",
    });
    expect(suyo.status).toBe(201);

    const ajeno = await pedir("POST", "/v1/inventory/receipts", ALMACENISTA, {
      company_id: COMPANY,
      warehouse_id: W2,
      product_id: PROD,
      quantity: "1",
      amount: "110",
      currency: "VES",
    });
    expect(ajeno.status).toBe(403);
    expect(((await ajeno.json()) as { code: string }).code).toBe("PERMISSION_REQUIRED");

    // Y tampoco ajusta: inventory.adjust es otro permiso.
    const ajuste = await pedir("POST", "/v1/inventory/adjustments", ALMACENISTA, {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: PROD,
      delta: "1",
      reason: "conteo",
    });
    expect(ajuste.status).toBe(403);
  });

  it("POST /adjustments exige motivo: sin él es 422 antes de tocar la base", async () => {
    const sinMotivo = await pedir("POST", "/v1/inventory/adjustments", JEFE, {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: PROD,
      delta: "1",
    });
    expect(sinMotivo.status).toBe(422);
    const conMotivo = await pedir("POST", "/v1/inventory/adjustments", JEFE, {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: PROD,
      delta: "1",
      reason: "sobrante de conteo cíclico",
    });
    expect(conMotivo.status).toBe(201);
    expect(((await conMotivo.json()) as { reason: string }).reason).toBe(
      "sobrante de conteo cíclico",
    );
  });

  it("POST /transfers devuelve las DOS patas del mismo hecho y el stock no se crea ni se destruye", async () => {
    const antes = (await (
      await pedir("GET", `/v1/inventory/stock?product_id=${PROD}`, JEFE)
    ).json()) as { items: { quantity: string }[] };
    const totalAntes = antes.items.reduce(
      (acc, i) => acc + BigInt(i.quantity.replace(".", "")),
      0n,
    );

    const t = await pedir("POST", "/v1/inventory/transfers", JEFE, {
      company_id: COMPANY,
      from_warehouse_id: W1,
      to_warehouse_id: W2,
      product_id: PROD,
      quantity: "4",
    });
    expect(t.status).toBe(201);
    const cuerpo = (await t.json()) as {
      transfer_id: string;
      out: { kind: string; warehouse_id: string; transfer_id: string };
      in: { kind: string; warehouse_id: string; transfer_id: string };
    };
    expect(cuerpo.out.kind).toBe("transferencia_out");
    expect(cuerpo.in.kind).toBe("transferencia_in");
    expect(cuerpo.out.warehouse_id).toBe(W1);
    expect(cuerpo.in.warehouse_id).toBe(W2);
    expect(cuerpo.out.transfer_id).toBe(cuerpo.transfer_id);

    const despues = (await (
      await pedir("GET", `/v1/inventory/stock?product_id=${PROD}`, JEFE)
    ).json()) as { items: { quantity: string }[] };
    const totalDespues = despues.items.reduce(
      (acc, i) => acc + BigInt(i.quantity.replace(".", "")),
      0n,
    );
    expect(totalDespues).toBe(totalAntes);
    expect(despues.items.length).toBe(2); // ahora hay existencias en los dos almacenes
  });

  it("GET/POST /v1/warehouses: alta con warehouse.manage y código único por empresa", async () => {
    const lista = await pedir("GET", "/v1/warehouses", JEFE);
    expect(lista.status).toBe(200);
    expect(((await lista.json()) as unknown[]).length).toBeGreaterThanOrEqual(2);

    const alta = await pedir("POST", "/v1/warehouses", JEFE, {
      company_id: COMPANY,
      code: `E2E-${RUN}`,
      name: "Almacén nuevo",
    });
    expect(alta.status).toBe(201);
    expect(((await alta.json()) as { status: string }).status).toBe("active");

    const repetido = await pedir("POST", "/v1/warehouses", JEFE, {
      company_id: COMPANY,
      code: `E2E-${RUN}`,
      name: "Otro con el mismo código",
    });
    expect(repetido.status).toBe(409);

    const sinPermiso = await pedir("POST", "/v1/warehouses", ALMACENISTA, {
      company_id: COMPANY,
      code: `E2E-X-${RUN}`,
      name: "Sin permiso",
    });
    expect(sinPermiso.status).toBe(403);
  });

  it("un movimiento no se edita por la API: no existe endpoint que lo permita", async () => {
    const kardex = (await (
      await pedir("GET", `/v1/inventory/moves?product_id=${PROD}&per_page=1`, JEFE)
    ).json()) as { items: { id: string }[] };
    const id = kardex.items[0]!.id;
    for (const metodo of ["PATCH", "PUT", "DELETE"]) {
      const r = await pedir(metodo, `/v1/inventory/moves/${id}`, JEFE, { company_id: COMPANY });
      expect(r.status).toBe(404);
    }
  });
});

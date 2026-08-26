import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * La segunda vuelta de inventario por HTTP: recetas de compuestos con unidades
 * fraccionadas, vencimientos y FEFO, variantes y umbrales.
 *
 * Lo que solo se ve aquí: que vender un compuesto por la API descuente
 * ingredientes con el costo correcto, y que el compuesto no admita stock ni
 * por el endpoint de entrada.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const TENANT = "e2200000-0000-4000-8000-000000000001";
const COMPANY = "e2200000-0000-4000-8000-000000000002";
const W1 = "e2200000-0000-4000-8000-0000000000f1";
const JEFE = "e2200000-0000-4000-8000-00000000000a";
const RUN = Date.now().toString(36);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let HARINA = "";
let LECHE = "";
let AREPA = "";
let QUESO = "";

const tokenDe = (sub: string) =>
  new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);

async function pedir(metodo: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(JEFE)}`,
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
  await sql`insert into auth.users (id) values (${JEFE}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${JEFE}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e ext') on conflict (id) do nothing`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name)
             values (${COMPANY}, ${TENANT}, 'J-E2EEXT', 'Restaurante e2e') on conflict (id) do nothing`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'EXT-W1', 'Cocina') on conflict (id) do nothing`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             ('e2200000-0000-4000-8000-0000000000e1', null, 'e2eext_jefe', 'Jefe', true)
             on conflict (id) do nothing`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             ('e2200000-0000-4000-8000-0000000000e1', 'inventory.move'),
             ('e2200000-0000-4000-8000-0000000000e1', 'inventory.expired'),
             ('e2200000-0000-4000-8000-0000000000e1', 'product.recipe.manage'),
             ('e2200000-0000-4000-8000-0000000000e1', 'product.variant.manage'),
             ('e2200000-0000-4000-8000-0000000000e1', 'inventory.threshold.manage')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             ('e2200000-0000-4000-8000-0000000000a1', ${TENANT}, ${JEFE}) on conflict (id) do nothing`;
    await tx`insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
             ('e2200000-0000-4000-8000-0000000000a2', ${TENANT}, 'e2200000-0000-4000-8000-0000000000a1',
              'e2200000-0000-4000-8000-0000000000e1', null) on conflict (id) do nothing`;
    await tx`insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, 'e2200000-0000-4000-8000-0000000000a2', 'warehouse', ${W1})
             on conflict do nothing`;
    const filas = await tx<{ id: string; sku: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`HAR-${RUN}`}, 'Harina', 'good', 'active', 'kg', 'gravado_general'),
             (${TENANT}, ${COMPANY}, ${`LEC-${RUN}`}, 'Leche', 'good', 'active', 'litro', 'gravado_general'),
             (${TENANT}, ${COMPANY}, ${`ARE-${RUN}`}, 'Arepa', 'good', 'active', 'unidad', 'gravado_general'),
             (${TENANT}, ${COMPANY}, ${`QUE-${RUN}`}, 'Queso', 'good', 'active', 'kg', 'gravado_general')
      returning id, sku`;
    HARINA = filas.find((f) => f.sku.startsWith("HAR"))!.id;
    LECHE = filas.find((f) => f.sku.startsWith("LEC"))!.id;
    AREPA = filas.find((f) => f.sku.startsWith("ARE"))!.id;
    QUESO = filas.find((f) => f.sku.startsWith("QUE"))!.id;
    await tx`update public.products set is_composed = true where id = ${AREPA}`;
    await tx`update public.products set tracks_lots = true, tracks_expiry = true where id = ${QUESO}`;
  });
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("recetas de productos compuestos", () => {
  it("PUT /recipe define la receta en gramos y mililitros; GET la devuelve convertida", async () => {
    const r = await pedir("PUT", `/v1/products/${AREPA}/recipe`, {
      company_id: COMPANY,
      lines: [
        { child_product_id: HARINA, quantity: "200", unit_code: "gramo" },
        { child_product_id: LECHE, quantity: "300", unit_code: "mililitro" },
      ],
    });
    expect(r.status).toBe(200);

    const get = await pedir("GET", `/v1/products/${AREPA}/recipe?warehouse_id=${W1}`);
    expect(get.status).toBe(200);
    const receta = (await get.json()) as {
      lines: { child_product_id: string; quantity_in_product_unit: string | null }[];
      estimated_unit_cost: string | null;
    };
    expect(receta.lines).toHaveLength(2);
    const harina = receta.lines.find((l) => l.child_product_id === HARINA)!;
    // 200 g convertidos a la unidad del producto (kg) = 0,2
    expect(harina.quantity_in_product_unit).toBe("0.20000000");
  });

  it("el compuesto NO admite entrada de stock: 409 COMPOSED_HAS_NO_STOCK", async () => {
    const r = await pedir("POST", "/v1/inventory/receipts", {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: AREPA,
      quantity: "5",
      amount: "100",
      currency: "VES",
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("COMPOSED_HAS_NO_STOCK");
  });

  it("vender 12 arepas descuenta 2,4 kg y 3,6 L, con el costo real sumado", async () => {
    // 10 kg a 300,00 (30,00/kg) y 8 L a 100,00 (12,50/L)
    for (const [producto, cantidad, importe] of [
      [HARINA, "10", "300"],
      [LECHE, "8", "100"],
    ] as const) {
      const e = await pedir("POST", "/v1/inventory/receipts", {
        company_id: COMPANY,
        warehouse_id: W1,
        product_id: producto,
        quantity: cantidad,
        amount: importe,
        currency: "VES",
      });
      expect(e.status).toBe(201);
    }

    const venta = await pedir("POST", "/v1/inventory/recipe-consumptions", {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: AREPA,
      quantity: "12",
      reference: `VTA-${RUN}`,
    });
    expect(venta.status).toBe(201);
    const cuerpo = (await venta.json()) as {
      source_document_id: string;
      total_cost: string;
      moves: { product_id: string; quantity: string; source_document_id: string }[];
    };
    expect(cuerpo.moves).toHaveLength(2);
    // Las dos salidas comparten el documento: es UN hecho.
    expect(new Set(cuerpo.moves.map((m) => m.source_document_id)).size).toBe(1);
    expect(cuerpo.moves[0]!.source_document_id).toBe(cuerpo.source_document_id);
    // 2,4 kg × 30,00 = 72,00 · 3,6 L × 12,50 = 45,00 → 117,00 A MANO
    expect(cuerpo.total_cost).toBe("117.00000000");

    const stock = (await (
      await pedir("GET", `/v1/inventory/stock?product_id=${HARINA}`)
    ).json()) as { items: { quantity: string }[] };
    expect(stock.items[0]!.quantity).toBe("7.60000000");
  });

  it("sin existencia suficiente, NINGUNA salida ocurre: media receta es peor que ninguna", async () => {
    const antes = (await (
      await pedir("GET", `/v1/inventory/stock?product_id=${HARINA}`)
    ).json()) as { items: { quantity: string }[] };

    const r = await pedir("POST", "/v1/inventory/recipe-consumptions", {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: AREPA,
      quantity: "10000",
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("NEGATIVE_STOCK");

    const despues = (await (
      await pedir("GET", `/v1/inventory/stock?product_id=${HARINA}`)
    ).json()) as { items: { quantity: string }[] };
    expect(despues.items[0]!.quantity).toBe(antes.items[0]!.quantity);
  });

  it("un producto que no es compuesto no se consume por receta", async () => {
    const r = await pedir("POST", "/v1/inventory/recipe-consumptions", {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: HARINA,
      quantity: "1",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain("no es compuesto");
  });
});

describe("vencimientos y FEFO", () => {
  it("expiring-lots ordena por urgencia y suggest-lot evita el vencido", async () => {
    const [viejo, pronto] = await sql<{ id: string }[]>`
      insert into public.lots (tenant_id, company_id, product_id, code, expires_at)
      values (${TENANT}, ${COMPANY}, ${QUESO}, ${`Q-VIEJO-${RUN}`}, current_date - 3),
             (${TENANT}, ${COMPANY}, ${QUESO}, ${`Q-PRONTO-${RUN}`}, current_date + 4)
      returning id`;

    for (const lote of [viejo!.id, pronto!.id]) {
      const e = await pedir("POST", "/v1/inventory/receipts", {
        company_id: COMPANY,
        warehouse_id: W1,
        product_id: QUESO,
        lot_id: lote,
        quantity: "2",
        amount: "40",
        currency: "VES",
      });
      expect(e.status).toBe(201);
    }

    const porVencer = (await (await pedir("GET", "/v1/inventory/expiring-lots?days=7")).json()) as {
      items: { lot_id: string; days_left: number }[];
    };
    // Se filtra a LOS LOTES DE ESTA CORRIDA en vez de contar el total: la base no
    // se resetea entre ejecuciones de la suite, así que un recuento global pasa
    // la primera vez y falla la segunda. Es el mismo defecto que el
    // `count(units) = 5` del test 016 — aquí lo cometí yo, y lo destapó el verify
    // al correr la suite por segunda vez sobre la misma base.
    const mios = porVencer.items.filter((i) => [viejo!.id, pronto!.id].includes(i.lot_id));
    expect(mios).toHaveLength(2);
    expect(mios.find((i) => i.lot_id === viejo!.id)!.days_left).toBeLessThan(0);
    // El orden por urgencia se comprueba como POSICIÓN RELATIVA, que es lo que
    // la función promete, y no como «el primero de todos».
    const posVencido = porVencer.items.findIndex((i) => i.lot_id === viejo!.id);
    const posPronto = porVencer.items.findIndex((i) => i.lot_id === pronto!.id);
    expect(posVencido).toBeLessThan(posPronto);

    const sugerido = (await (
      await pedir("GET", `/v1/inventory/suggest-lot?warehouse_id=${W1}&product_id=${QUESO}`)
    ).json()) as { lot_id: string | null };
    expect(sugerido.lot_id).toBe(pronto!.id);
  });
});

describe("variantes", () => {
  it("una plantilla agrupa, cada variante es un producto y el stock desglosa con su total", async () => {
    const t = await pedir("POST", "/v1/product-templates", {
      company_id: COMPANY,
      name: `Camisa ${RUN}`,
      attribute_keys: ["talla", "color"],
    });
    expect(t.status).toBe(201);
    const plantilla = (await t.json()) as { id: string };

    const variantes: string[] = [];
    for (const talla of ["M", "L"]) {
      const [p] = await sql<{ id: string }[]>`
        insert into public.products
          (tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code,
           template_id, attributes)
        values (${TENANT}, ${COMPANY}, ${`CAM-${talla}-${RUN}`}, ${`Camisa ${talla}`}, 'good',
                'active', 'unidad', 'gravado_general', ${plantilla.id},
                ${sql.json({ talla, color: "azul" })})
        returning id`;
      variantes.push(p!.id);
    }

    for (const [i, variante] of variantes.entries()) {
      const e = await pedir("POST", "/v1/inventory/receipts", {
        company_id: COMPANY,
        warehouse_id: W1,
        product_id: variante,
        quantity: i === 0 ? "5" : "7",
        amount: i === 0 ? "250" : "420",
        currency: "VES",
      });
      expect(e.status).toBe(201);
    }

    const porPlantilla = (await (await pedir("GET", "/v1/inventory/stock-by-template")).json()) as {
      items: { product_id: string; quantity: string; template_quantity: string }[];
    };
    const mias = porPlantilla.items.filter((i) => variantes.includes(i.product_id));
    expect(mias).toHaveLength(2);
    // Desglosa por variante…
    expect(mias.map((m) => m.quantity).sort()).toEqual(["5.00000000", "7.00000000"]);
    // …y agrupa por plantilla: 5 + 7 = 12, el mismo total en las dos filas.
    expect(new Set(mias.map((m) => m.template_quantity))).toEqual(new Set(["12.00000000"]));
  });

  it("una variante con un eje que la plantilla no declara: 422", async () => {
    const t = await pedir("POST", "/v1/product-templates", {
      company_id: COMPANY,
      name: `Pantalón ${RUN}`,
      attribute_keys: ["talla"],
    });
    const plantilla = (await t.json()) as { id: string };
    await expect(
      sqlApi`insert into public.products
              (tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code,
               template_id, attributes)
             values (${TENANT}, ${COMPANY}, ${`PAN-${RUN}`}, 'Pantalón', 'good', 'active',
                     'unidad', 'gravado_general', ${plantilla.id},
                     ${sqlApi.json({ talla: "M", color: "azul" })})`,
    ).rejects.toMatchObject({ code: "LAD47" });
  });
});

describe("umbrales de reposición", () => {
  it("low-stock encuentra lo que falta, incluido lo que está en cero", async () => {
    const umbral = await pedir("PUT", "/v1/inventory/thresholds", {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: HARINA,
      stock_min: "10",
    });
    expect(umbral.status).toBe(200);

    const bajo = (await (await pedir("GET", "/v1/inventory/low-stock")).json()) as {
      items: { product_id: string; missing: string; quantity: string }[];
    };
    const harina = bajo.items.find((i) => i.product_id === HARINA);
    expect(harina).toBeDefined();
    // 10 − 7,6 = 2,4
    expect(harina!.missing).toBe("2.40000000");
  });
});

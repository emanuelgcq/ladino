import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * El módulo de productos de EXTREMO A EXTREMO por el camino de producción:
 * JWT firmado de verdad → auth → scope (X-Company-Id contra la migración 15)
 * → idempotencia → handler → caso de uso → Postgres como `ladino_api`.
 *
 * Lo que gobierna el fichero: los importes como STRING de punta a punta, la
 * segregación del mapeo tributario, y que el replay idempotente devuelve LA
 * MISMA respuesta sin reejecutar.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";

const TENANT = "e2ee2e00-0000-4000-8000-000000000001";
const COMPANY = "e2ee2e00-0000-4000-8000-000000000002";
const GESTOR = "e2ee2e00-0000-4000-8000-00000000000a";
const CONTADOR = "e2ee2e00-0000-4000-8000-00000000000b";
const RUN = Date.now().toString(36);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;

async function tokenDe(sub: string): Promise<string> {
  return new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);
}

async function pedir(
  metodo: string,
  path: string,
  opts: { token?: string; company?: string | null; key?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.company !== null) headers["X-Company-Id"] = opts.company ?? COMPANY;
  if (opts.key) headers["Idempotency-Key"] = opts.key;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(path, {
    method: metodo,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  // La credencial de SERVICIO del stack local, acuñada aquí mismo con el
  // secreto de demo de la CLI: es la que la API usaría en producción (desde el
  // entorno del servidor) y NUNCA sale de este proceso.
  const serviceKey = await new SignJWT({ role: "service_role" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("supabase-demo")
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(JWT_SECRET);
  app = buildApp({
    sql: sqlApi,
    auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER },
    storage: { url: "http://127.0.0.1:54321/storage/v1", serviceKey },
  });

  await sql`insert into auth.users (id) values (${GESTOR}), (${CONTADOR}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${GESTOR}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e prod')
             on conflict (id) do nothing`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name)
             values (${COMPANY}, ${TENANT}, 'J-E2EPROD', 'Empresa e2e productos')
             on conflict (id) do nothing`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             ('e2ee2e00-0000-4000-8000-0000000000e1', null, 'e2e_gestor', 'Gestor', false),
             ('e2ee2e00-0000-4000-8000-0000000000e2', null, 'e2e_contador', 'Contador', false),
             ('e2ee2e00-0000-4000-8000-0000000000e3', null, 'e2e_almacen', 'Almacenista', true)
             on conflict (id) do nothing`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             ('e2ee2e00-0000-4000-8000-0000000000e1', 'product.manage'),
             ('e2ee2e00-0000-4000-8000-0000000000e1', 'price_list.manage'),
             ('e2ee2e00-0000-4000-8000-0000000000e3', 'inventory.move'),
             ('e2ee2e00-0000-4000-8000-0000000000e2', 'product.tax_category.set')
             on conflict do nothing`;
    // El almacén del ALTA SIMPLE: uno solo, para que el default «el único que
    // hay» funcione sin preguntar.
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values ('e2ee2e00-0000-4000-8000-0000000000f1', ${TENANT}, ${COMPANY},
                     'E2E-PW1', 'Principal')
             on conflict (id) do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             ('e2ee2e00-0000-4000-8000-0000000000a1', ${TENANT}, ${GESTOR}),
             ('e2ee2e00-0000-4000-8000-0000000000b1', ${TENANT}, ${CONTADOR})
             on conflict (id) do nothing`;
    await tx`insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
             ('e2ee2e00-0000-4000-8000-0000000000a2', ${TENANT},
              'e2ee2e00-0000-4000-8000-0000000000a1', 'e2ee2e00-0000-4000-8000-0000000000e1', null),
             ('e2ee2e00-0000-4000-8000-0000000000a3', ${TENANT},
              'e2ee2e00-0000-4000-8000-0000000000a1', 'e2ee2e00-0000-4000-8000-0000000000e3', null),
             ('e2ee2e00-0000-4000-8000-0000000000b2', ${TENANT},
              'e2ee2e00-0000-4000-8000-0000000000b1', 'e2ee2e00-0000-4000-8000-0000000000e2', null)
             on conflict (id) do nothing`;
    await tx`insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id)
             select ${TENANT}, ${COMPANY}, 'e2ee2e00-0000-4000-8000-0000000000a3', 'warehouse',
                    'e2ee2e00-0000-4000-8000-0000000000f1'
              where not exists (select 1 from public.scope_bindings
                                 where assignment_id = 'e2ee2e00-0000-4000-8000-0000000000a3')`;
  });
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("productos de extremo a extremo", () => {
  let productoId: string;
  let listaId: string;

  it("los catálogos de referencia responden (units global; tax-categories con VALIDAR-TRIBUTARIO)", async () => {
    const token = await tokenDe(GESTOR);
    const units = await pedir("GET", "/v1/units", { token, company: null });
    expect(units.status).toBe(200);
    expect(((await units.json()) as unknown[]).length).toBeGreaterThanOrEqual(5);
    const cats = await pedir("GET", "/v1/tax-categories", { token, company: null });
    expect(cats.status).toBe(200);
    expect(((await cats.json()) as unknown[]).length).toBe(6);
  });

  it("POST /v1/products: crea con Idempotency-Key, y el REPLAY devuelve la misma respuesta sin reejecutar", async () => {
    const token = await tokenDe(GESTOR);
    const body = {
      company_id: COMPANY,
      sku: `E2E-${RUN}`,
      name: "Producto e2e",
      kind: "good",
      unit_code: "unidad",
      tax_category_code: "gravado_general",
    };
    const key = `PROD-${RUN}`;
    const primera = await pedir("POST", "/v1/products", { token, key, body });
    expect(primera.status).toBe(201);
    const creado = (await primera.json()) as { id: string; status: string };
    productoId = creado.id;
    expect(creado.status).toBe("draft");

    const replay = await pedir("POST", "/v1/products", { token, key, body });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(creado);
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.products where company_id = ${COMPANY} and sku = ${body.sku}`;
    expect(n?.n).toBe(1); // UNA fila: el replay no reejecutó
  });

  it("sin X-Company-Id → 422; con company_id incoherente en el cuerpo → 422", async () => {
    const token = await tokenDe(GESTOR);
    const sinHeader = await pedir("POST", "/v1/products", {
      token,
      company: null,
      key: `NH-${RUN}`,
      body: {
        company_id: COMPANY,
        sku: `NH-${RUN}`,
        name: "x",
        kind: "good",
        unit_code: "unidad",
        tax_category_code: "exento",
      },
    });
    expect(sinHeader.status).toBe(422);
    const incoherente = await pedir("POST", "/v1/products", {
      token,
      key: `INC-${RUN}`,
      body: {
        company_id: "e2ee2e00-0000-4000-8000-00000000ffff",
        sku: `INC-${RUN}`,
        name: "x",
        kind: "good",
        unit_code: "unidad",
        tax_category_code: "exento",
      },
    });
    expect(incoherente.status).toBe(422);
  });

  it("GET /v1/products: búsqueda y paginación en servidor, con total", async () => {
    const token = await tokenDe(GESTOR);
    const res = await pedir("GET", `/v1/products?search=E2E-${RUN}&per_page=10&page=1`, { token });
    expect(res.status).toBe(200);
    const pagina = (await res.json()) as { items: { sku: string }[]; total: number };
    expect(pagina.total).toBe(1);
    expect(pagina.items[0]?.sku).toBe(`E2E-${RUN}`);
  });

  it("PATCH actualiza; PUT tax-category exige el permiso SEGREGADO (gestor 403, contador 200)", async () => {
    const gestor = await tokenDe(GESTOR);
    const patch = await pedir("PATCH", `/v1/products/${productoId}`, {
      token: gestor,
      key: `PATCH-${RUN}`,
      body: { company_id: COMPANY, name: "Renombrado e2e", status: "active" },
    });
    expect(patch.status).toBe(200);

    const comoGestor = await pedir("PUT", `/v1/products/${productoId}/tax-category`, {
      token: gestor,
      key: `TAXG-${RUN}`,
      body: { company_id: COMPANY, tax_category_code: "exento" },
    });
    expect(comoGestor.status).toBe(403);
    expect(((await comoGestor.json()) as { code: string }).code).toBe("PERMISSION_REQUIRED");

    const contador = await tokenDe(CONTADOR);
    const comoContador = await pedir("PUT", `/v1/products/${productoId}/tax-category`, {
      token: contador,
      key: `TAXC-${RUN}`,
      body: { company_id: COMPANY, tax_category_code: "exento" },
    });
    expect(comoContador.status).toBe(200);
    expect(((await comoContador.json()) as { tax_category_code: string }).tax_category_code).toBe(
      "exento",
    );
  });

  it("precios: {amount, currency} como STRINGS de punta a punta, y el vigente contra fecha", async () => {
    const token = await tokenDe(GESTOR);
    const lista = await pedir("POST", "/v1/price-lists", {
      token,
      key: `LISTA-${RUN}`,
      body: { company_id: COMPANY, name: `PVP e2e ${RUN}`, currency_code: "VES" },
    });
    expect(lista.status).toBe(201);
    listaId = ((await lista.json()) as { id: string }).id;

    const precio = await pedir("POST", `/v1/price-lists/${listaId}/prices`, {
      token,
      key: `PRECIO-${RUN}`,
      body: {
        company_id: COMPANY,
        product_id: productoId,
        amount: "1234567890123456.12345678",
        effective_from: "2026-01-01T00:00:00Z",
      },
    });
    expect(precio.status).toBe(201);
    const item = (await precio.json()) as { amount: unknown; currency: string };
    expect(item.amount).toBe("1234567890123456.12345678"); // string, dígito a dígito
    expect(item.currency).toBe("VES");

    const historial = await pedir(
      "GET",
      `/v1/price-lists/${listaId}/prices?product_id=${productoId}&at=2026-02-01T00:00:00Z`,
      { token },
    );
    expect(historial.status).toBe(200);
    const cuerpo = (await historial.json()) as {
      items: unknown[];
      vigente: { amount: string; currency: string } | null;
    };
    expect(cuerpo.items.length).toBe(1);
    expect(cuerpo.vigente).toEqual({ amount: "1234567890123456.12345678", currency: "VES" });
  });

  it("el solape con un período cerrado responde 409 PRICE_OVERLAP con el mensaje del dominio", async () => {
    const token = await tokenDe(GESTOR);
    // Cierra el período abierto creando uno nuevo, y luego intenta pisar el cerrado.
    const nuevo = await pedir("POST", `/v1/price-lists/${listaId}/prices`, {
      token,
      key: `PRECIO2-${RUN}`,
      body: {
        company_id: COMPANY,
        product_id: productoId,
        amount: "200",
        effective_from: "2026-06-01T00:00:00Z",
      },
    });
    expect(nuevo.status).toBe(201);
    const solape = await pedir("POST", `/v1/price-lists/${listaId}/prices`, {
      token,
      key: `PRECIO3-${RUN}`,
      body: {
        company_id: COMPANY,
        product_id: productoId,
        amount: "10",
        effective_from: "2026-02-01T00:00:00Z",
        effective_to: "2026-03-01T00:00:00Z",
      },
    });
    expect(solape.status).toBe(409);
    const err = (await solape.json()) as { code: string; message: string };
    expect(err.code).toBe("PRICE_OVERLAP");
    expect(err.message).toContain("período ya cerrado"); // el mensaje del CASO DE USO, no el genérico
  });

  it("una company ajena en X-Company-Id: 404 del middleware, sin llegar al handler", async () => {
    const token = await tokenDe(GESTOR);
    const res = await pedir("GET", "/v1/products", {
      token,
      company: "e2ee2e00-0000-4000-8000-00000000dead",
    });
    expect(res.status).toBe(404);
  });

  // ── El ALTA SIMPLE y la cuadrícula (Fase C) ───────────────────────────────

  it("el alta simple: nombre + precio (+ stock) → producto ACTIVO con SKU generado y kardex", async () => {
    const token = await tokenDe(GESTOR);
    const r = await pedir("POST", "/v1/products/simple", {
      token,
      key: crypto.randomUUID(),
      body: {
        company_id: COMPANY,
        name: `Harina simple ${RUN}`,
        price: { amount: "2.50000000", currency: "USD" },
        category_name: "Alimentos",
        initial_stock: {
          quantity: "10.00000000",
          unit_cost: { amount: "100.00000000", currency: "VES" },
        },
      },
    });
    expect(r.status).toBe(201);
    const s = (await r.json()) as {
      product: Record<string, unknown>;
      price: Record<string, string>;
      initial_stock: Record<string, string>;
    };
    expect(s.product["status"]).toBe("active");
    expect(String(s.product["sku"]).startsWith("P-")).toBe(true);
    expect(s.product["category_id"]).not.toBeNull();
    expect(s.price["amount"]).toBe("2.50000000");
    expect(s.price["currency"]).toBe("USD");
    expect(s.initial_stock["warehouse_id"]).toBe("e2ee2e00-0000-4000-8000-0000000000f1");

    // El stock inicial es KARDEX, no una columna: el saldo materializado lo dice.
    const [saldo] = await sql<{ q: string }[]>`
      select quantity::text as q from public.stock_balances
       where company_id = ${COMPANY} and product_id = ${s.product["id"] as string}`;
    expect(saldo?.q).toBe("10.00000000");
  });

  it("un servicio con stock inicial se rechaza: un servicio no tiene existencias", async () => {
    const token = await tokenDe(GESTOR);
    const r = await pedir("POST", "/v1/products/simple", {
      token,
      key: crypto.randomUUID(),
      body: {
        company_id: COMPANY,
        name: `Delivery ${RUN}`,
        is_service: true,
        price: { amount: "1.00000000", currency: "USD" },
        initial_stock: {
          quantity: "1.00000000",
          unit_cost: { amount: "1.00000000", currency: "VES" },
        },
      },
    });
    expect(r.status).toBe(422);
  });

  it("la cuadrícula: búsqueda por código de barras con precio y stock del servidor", async () => {
    const token = await tokenDe(GESTOR);
    const alta = await pedir("POST", "/v1/products/simple", {
      token,
      key: crypto.randomUUID(),
      body: {
        company_id: COMPANY,
        name: `Café simple ${RUN}`,
        barcode: `759${RUN}`,
        price: { amount: "4.00000000", currency: "USD" },
      },
    });
    expect(alta.status).toBe(201);

    const res = await pedir(
      "GET",
      `/v1/products?search=759${RUN}&only_active=1&with_price=1&with_stock=1`,
      { token },
    );
    expect(res.status).toBe(200);
    const lista = (await res.json()) as { items: Record<string, unknown>[]; total: number };
    expect(lista.total).toBe(1);
    const item = lista.items[0]!;
    expect(item["name"]).toBe(`Café simple ${RUN}`);
    // El precio viene de la lista «detal USD» resuelta por el SERVIDOR, y el
    // stock del saldo materializado: la cuadrícula no calcula nada.
    expect(item["price_amount"]).toBe("4.00000000");
    expect(item["price_currency"]).toBe("USD");
    expect(item["stock_quantity"]).toBe("0");
  });

  it(
    "el import de Excel: las filas buenas entran, las malas se explican con su número",
    { timeout: 30_000 },
    async () => {
      const { Workbook } = await import("exceljs");
      const libro = new Workbook();
      const hoja = libro.addWorksheet("Productos");
      hoja.addRow(["Nombre", "Precio", "Moneda", "Categoría", "Existencia", "Costo"]);
      hoja.addRow([`Arroz import ${RUN}`, "1,80", "USD", "Alimentos", "12", "50,00"]);
      hoja.addRow(["", "2.00"]); // sin nombre → error con fila
      hoja.addRow([`Aceite import ${RUN}`, "tres dólares"]); // precio ilegible
      hoja.addRow([`Jabón import ${RUN}`, "0.90"]); // sin existencia: solo catálogo
      const xlsx = Buffer.from(await libro.xlsx.writeBuffer());

      const token = await tokenDe(GESTOR);
      const form = new FormData();
      form.append(
        "file",
        new File([new Uint8Array(xlsx)], "productos.xlsx", {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      );
      const r = await app.request("/v1/products/import", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "X-Company-Id": COMPANY },
        body: form,
      });
      expect(r.status).toBe(201);
      const res = (await r.json()) as {
        total: number;
        created: number;
        failed: number;
        rows: { row: number; status: string; message?: string; product_id?: string }[];
      };
      expect(res.total).toBe(4);
      expect(res.created).toBe(2);
      expect(res.failed).toBe(2);
      const porFila = new Map(res.rows.map((f) => [f.row, f]));
      expect(porFila.get(2)!.status).toBe("creado");
      expect(porFila.get(3)!.message).toContain("nombre");
      expect(porFila.get(4)!.message).toContain("precio");
      expect(porFila.get(5)!.status).toBe("creado");

      // La fila 2 entró CON su kardex: 12 unidades a 50 Bs.
      const [saldo] = await sql<{ q: string }[]>`
      select coalesce(sum(quantity), 0)::text as q from public.stock_balances
       where company_id = ${COMPANY} and product_id = ${porFila.get(2)!.product_id}`;
      expect(saldo!.q).toBe("12.00000000");
    },
  );

  it("la foto: subir genera original + miniaturas y la cuadrícula recibe la URL FIRMADA", async () => {
    const token = await tokenDe(GESTOR);
    const alta = await pedir("POST", "/v1/products/simple", {
      token,
      key: crypto.randomUUID(),
      body: {
        company_id: COMPANY,
        name: `Con foto ${RUN}`,
        price: { amount: "1.00000000", currency: "USD" },
      },
    });
    expect(alta.status).toBe(201);
    const producto = ((await alta.json()) as { product: { id: string } }).product;

    // Un PNG de 1×1: suficiente para ejercer sharp y el bucket de verdad.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const form = new FormData();
    form.append("file", new File([new Uint8Array(png)], "foto.png", { type: "image/png" }));
    const subida = await app.request(`/v1/products/${producto.id}/image`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Company-Id": COMPANY },
      body: form,
    });
    expect(subida.status).toBe(201);
    const s = (await subida.json()) as { image_path: string; image_url: string | null };
    expect(s.image_path.endsWith("/original.webp")).toBe(true);
    expect(s.image_path.startsWith(`${COMPANY}/products/${producto.id}/`)).toBe(true);
    expect(s.image_url).not.toBeNull();
    expect(s.image_url).toContain("token=");

    // Y el listado firma la MINIATURA de 400, no el original: la cuadrícula
    // no descarga fotos de cámara.
    const res = await pedir("GET", `/v1/products?search=Con foto ${RUN}&with_price=1`, { token });
    const lista = (await res.json()) as { items: Record<string, unknown>[] };
    const item = lista.items.find((i) => i["id"] === producto.id)!;
    expect(item["image_path"]).toBe(s.image_path);
    expect(String(item["image_url"])).toContain("thumb-400.webp");
    expect(String(item["image_url"])).toContain("token=");
  });
});

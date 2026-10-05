import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { fiadoDeFixture, venceDeFixture } from "./_fiado-de-fixture.js";
import { borrarTasasOficiales, sembrarTasaOficial } from "./_tasa-oficial.js";

/**
 * I-04 Y C-07 (ola 5 del recorrido 2026-09-24), en un negocio que vende con recibos y lleva
 * contabilidad (plan y preset importados).
 *
 * I-04 — EL PRODUCTO COMPUESTO:
 *   · se marca compuesto DESDE LA API del producto (alta y edición), no con un UPDATE a mano;
 *   · venderlo saca N × la receta de cada ingrediente, cada salida a SU costo promedio y al
 *     céntimo; el costo de lo vendido es la SUMA de esas salidas; el compuesto no lleva existencia;
 *   · sin existencia de un ingrediente, la caja dice CUÁL falta;
 *   · la receta que cambia después no cambia lo vendido;
 *   · la devolución PARCIAL devuelve los ingredientes en proporción, al costo con que salieron, y
 *     la devolución del resto deja el kardex de la venta en cero exacto;
 *   · la anulación repone los ingredientes (`annulled_stock_gaps` = 0);
 *   · un ingrediente con lote sale por vencimiento (primero el que vence antes);
 *   · `composite_sale_gaps` en cero, y su VARIANTE ROTA: sin el rastro de lo que la venta sacó,
 *     el invariante lo señala.
 *
 * C-07 — LOTE Y VENCIMIENTO:
 *   · el interruptor se enciende desde la API del producto;
 *   · la llegada pide lote y fecha de vencimiento cuando el producto los lleva;
 *   · la venta toma primero lo que vence antes; lo que vence HOY (día de Caracas) todavía se vende
 *     y lo que venció AYER no;
 *   · el interruptor no se cambia con movimientos registrados.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const TENANT = crypto.randomUUID();
const COMPANY = crypto.randomUUID();
const W1 = crypto.randomUUID();
const DUENO = crypto.randomUUID();
const CLIENTE = crypto.randomUUID();
const ROL = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const AYER = diaCaracas(-1);
const FUENTE_TASA = `e2e-compuestos-${RUN}`;

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let LISTA = "";
let CAJA = "";
let HARINA = "";
let PAN = "";
let QUESO = "";
let AREPA = "";
let TABLA = "";

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
    Authorization: `Bearer ${await tokenDe(DUENO)}`,
    "X-Company-Id": COMPANY,
  };
  if (metodo !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await app.request(path, {
    method: metodo,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (process.env["LADINO_E2E_DEBUG"] === "1" && r.status >= 400) {
    // eslint-disable-next-line no-console
    console.log(metodo, path, r.status, await r.clone().text());
  }
  return r;
}

interface Producto {
  id: string;
  is_composed: boolean;
  tracks_lots: boolean;
  tracks_expiry: boolean;
}

async function crearProducto(
  nombre: string,
  precio: number,
  extra: Record<string, unknown> = {},
): Promise<Producto> {
  const r = await pedir("POST", "/v1/products", {
    company_id: COMPANY,
    sku: `CL-${nombre.replace(/\s+/g, "-").toUpperCase()}-${RUN}`,
    name: nombre,
    kind: "good",
    unit_code: "unidad",
    ...extra,
  });
  expect(r.status).toBe(201);
  const p = (await r.json()) as Producto;
  await sql`
    insert into public.price_list_items
      (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
    values (${TENANT}, ${COMPANY}, ${LISTA}, ${p.id}, ${precio}, now() - interval '1 day')`;
  return p;
}

async function llegar(
  producto: string,
  cantidad: string,
  total: string,
  lote?: { code: string; vence?: string },
): Promise<Response> {
  return pedir("POST", "/v1/inventory/receipts", {
    origin: "aporte",
    company_id: COMPANY,
    warehouse_id: W1,
    product_id: producto,
    quantity: cantidad,
    amount: total,
    currency: "VES",
    ...(lote === undefined ? {} : { lot_code: lote.code }),
    ...(lote?.vence === undefined ? {} : { lot_expires_at: lote.vence }),
  });
}

async function posicion(producto: string): Promise<{ q: string; v: string }> {
  const [b] = await sql<{ q: string; v: string }[]>`
    select coalesce(sum(quantity), 0)::text as q, coalesce(sum(value), 0)::text as v
      from public.stock_balances
     where company_id = ${COMPANY} and warehouse_id = ${W1} and product_id = ${producto}`;
  return b!;
}

async function salidasDe(
  doc: string,
): Promise<{ product_id: string; lote: string | null; q: string; v: string }[]> {
  return sql<{ product_id: string; lote: string | null; q: string; v: string }[]>`
    select m.product_id, l.code as lote, m.quantity::text as q, m.functional_amount::text as v
      from public.inventory_moves m
      left join public.lots l on l.id = m.lot_id
     where m.company_id = ${COMPANY} and m.source_document_id = ${doc} and m.kind = 'salida'
     order by m.product_id, l.expires_at nulls last`;
}

async function vender(
  lineas: { product_id: string; quantity: string }[],
  pago?: string,
): Promise<Response> {
  return pedir("POST", "/v1/pos/sales", {
    company_id: COMPANY,
    warehouse_id: W1,
    customer_id: CLIENTE,
    lines: lineas,
    ...(pago === undefined
      ? { due_date: venceDeFixture() }
      : {
          payments: [
            { instrument: "efectivo_bs", amount: pago, currency: "VES", account_id: CAJA },
          ],
        }),
  });
}

async function invariantesEnCero(): Promise<void> {
  const [r] = await sql<
    {
      gap: string;
      inv: number;
      docs: number;
      anuladas: number;
      centimo: number;
      kardex: number;
      compuestos: number;
    }[]
  >`
    select (select diferencia::text from platform.inventory_ledger_gap(${COMPANY})) as gap,
           (select count(*)::int from platform.inventory_coverage_gaps(${COMPANY})) as inv,
           (select count(*)::int from platform.accounting_coverage_gaps(${COMPANY})) as docs,
           (select count(*)::int from platform.annulled_stock_gaps(${COMPANY})) as anuladas,
           (select count(*)::int from platform.cent_gaps(${COMPANY})) as centimo,
           (select count(*)::int from platform.stock_reconciliation(${COMPANY})) as kardex,
           (select count(*)::int from platform.composite_sale_gaps(${COMPANY})) as compuestos`;
  expect(r).toEqual({
    gap: "0.00000000",
    inv: 0,
    docs: 0,
    anuladas: 0,
    centimo: 0,
    kardex: 0,
    compuestos: 0,
  });
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e compuestos')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code)
             values (${COMPANY}, ${TENANT}, ${`PEND-CL-${RUN}`}, 'Arepera compuestos', 'VES')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-CLW1', 'Local')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2ecl_${RUN}`}, 'Dueño', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.invoice.annul'),
             (${ROL}, 'sales.payment.register'), (${ROL}, 'sales.return.manage'),
             (${ROL}, 'product.manage'), (${ROL}, 'product.recipe.manage'),
             (${ROL}, 'ar.read'), (${ROL}, 'inventory.move'), (${ROL}, 'treasury.read'),
             (${ROL}, 'treasury.account.manage'), (${ROL}, 'accounting.account.manage'),
             (${ROL}, 'accounting.template.manage'), (${ROL}, 'accounting.entry.reverse'),
             (${ROL}, 'accounting.read')
             on conflict do nothing`;
    const mem = crypto.randomUUID();
    const asig = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${mem}, ${TENANT}, ${DUENO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${asig}, ${TENANT}, ${mem}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, ${asig}, 'warehouse', ${W1})`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${TENANT}, ${COMPANY}, 'sin_facturacion', now() - interval '10 days')`;
    await tx`insert into public.customers (id, tenant_id, company_id, legal_name,
                                           person_type_code, taxpayer_type_code)
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, 'Señor Tulio', 'natural',
                     'consumidor_final')`;
    await fiadoDeFixture(tx, COMPANY, [ROL]);
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, 'detal', 'VES') returning id`;
    LISTA = l!.id;
    await tx`insert into public.company_settings (company_id, tenant_id, default_price_list_id)
             values (${COMPANY}, ${TENANT}, ${LISTA})`;
    // La tasa oficial de hoy, con fuente PROPIA de este fichero: se borra en `afterAll` (la tabla
    // es global; antes quedaba sembrada para quien corriera después).
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await sembrarTasaOficial(tx as unknown as ReturnType<typeof createClient>, {
      rate: "40",
      rate_date: HOY,
      source: FUENTE_TASA,
    });
  });
  for (const [ruta, cuerpo] of [
    ["/v1/accounts/import-template", { company_id: COMPANY, template_code: "ve_basico" }],
    ["/v1/journal-templates/import-preset", { company_id: COMPANY, preset_code: "ve_basico" }],
  ] as const) {
    expect((await pedir("POST", ruta, cuerpo)).status).toBe(201);
  }
  const caja = await pedir("POST", "/v1/treasury/accounts", {
    company_id: COMPANY,
    name: `Caja Bs ${RUN}`,
    currency: "VES",
    kind: "cash",
  });
  expect(caja.status).toBe(201);
  CAJA = ((await caja.json()) as { id: string }).id;

  HARINA = (await crearProducto("Harina", 10)).id;
  PAN = (await crearProducto("Pan", 20)).id;
  // 30 por 99,99: promedio 3,333. Media unidad cuesta 1,6665: el céntimo se pone a prueba.
  expect((await llegar(HARINA, "30", "99.99")).status).toBe(201);
  expect((await llegar(PAN, "100", "800")).status).toBe(201);
});

afterAll(async () => {
  if (sql) {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
      await borrarTasasOficiales(tx as unknown as ReturnType<typeof createClient>, FUENTE_TASA);
    });
  }
  await sql?.end();
  await sqlApi?.end();
});

describe("C-07 · lote y vencimiento", () => {
  it("el interruptor se enciende al crear el producto, y enciende lote Y vencimiento", async () => {
    const queso = await crearProducto("Queso de mano", 100, { tracks_lots: true });
    expect(queso.tracks_lots).toBe(true);
    expect(queso.tracks_expiry).toBe(true);
    QUESO = queso.id;
  });

  it("la llegada PIDE el lote y la fecha de vencimiento, con el nombre del producto", async () => {
    const sinLote = await llegar(QUESO, "3", "120");
    expect(sinLote.status).toBe(422);
    const m1 = ((await sinLote.json()) as { message: string }).message;
    expect(m1).toContain("Queso de mano");
    expect(m1).toContain("lleva lote y vencimiento");

    const sinFecha = await llegar(QUESO, "3", "120", { code: `SINFECHA-${RUN}` });
    expect(sinFecha.status).toBe(422);
    expect(((await sinFecha.json()) as { message: string }).message).toContain(
      "la fecha en que vence",
    );
    // Y el lote rechazado no quedó creado a medias.
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.lots where company_id = ${COMPANY}`;
    expect(n!.n).toBe(0);

    expect(
      (await llegar(QUESO, "3", "120", { code: `PRONTO-${RUN}`, vence: diaCaracas(5) })).status,
    ).toBe(201);
    expect(
      (await llegar(QUESO, "5", "250", { code: `LEJOS-${RUN}`, vence: diaCaracas(60) })).status,
    ).toBe(201);
  });

  it("la venta toma primero lo que vence antes", async () => {
    const venta = await vender([{ product_id: QUESO, quantity: "4" }]);
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;
    expect(await salidasDe(doc)).toEqual([
      { product_id: QUESO, lote: `PRONTO-${RUN}`, q: "-3.00000000", v: "-120.00000000" },
      { product_id: QUESO, lote: `LEJOS-${RUN}`, q: "-1.00000000", v: "-50.00000000" },
    ]);
  });

  it("lo que vence HOY (día de Caracas) todavía se vende; lo que venció AYER no, y la caja lo dice", async () => {
    const yogur = await crearProducto("Yogur", 30, { tracks_lots: true });
    expect((await llegar(yogur.id, "2", "20", { code: `AYER-${RUN}`, vence: AYER })).status).toBe(
      201,
    );
    expect((await llegar(yogur.id, "2", "20", { code: `HOY-${RUN}`, vence: HOY })).status).toBe(
      201,
    );
    const hoy = await vender([{ product_id: yogur.id, quantity: "2" }]);
    expect(hoy.status).toBe(201);
    const doc = ((await hoy.json()) as { document: { id: string } }).document.id;
    expect((await salidasDe(doc)).map((s) => s.lote)).toEqual([`HOY-${RUN}`]);

    const vencido = await vender([{ product_id: yogur.id, quantity: "1" }]);
    expect(vencido.status).toBe(409);
    const cuerpo = (await vencido.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("NEGATIVE_STOCK");
    expect(cuerpo.message).toContain("Yogur");
    expect(cuerpo.message).toContain("Lo vencido no se vende");
  });

  it("el interruptor no se cambia con movimientos registrados, ni para apagarlo ni para encenderlo", async () => {
    const apagar = await pedir("PATCH", `/v1/products/${QUESO}`, {
      company_id: COMPANY,
      tracks_lots: false,
    });
    expect(apagar.status).toBe(422);
    expect(((await apagar.json()) as { message: string }).message).toContain(
      "ya tiene movimientos de mercancía",
    );
    const encender = await pedir("PATCH", `/v1/products/${PAN}`, {
      company_id: COMPANY,
      tracks_lots: true,
    });
    expect(encender.status).toBe(422);
    expect(((await encender.json()) as { message: string }).message).toContain(
      "ya tiene movimientos de mercancía",
    );
    const [p] = await sql<{ a: boolean; b: boolean }[]>`
      select (select tracks_lots from public.products where id = ${QUESO}) as a,
             (select tracks_lots from public.products where id = ${PAN}) as b`;
    expect(p).toEqual({ a: true, b: false });
  });

  it("sin movimientos, el interruptor se enciende y se apaga desde la edición", async () => {
    const nuevo = await crearProducto("Jamón", 80);
    const on = await pedir("PATCH", `/v1/products/${nuevo.id}`, {
      company_id: COMPANY,
      tracks_lots: true,
    });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ tracks_lots: true, tracks_expiry: true });
    const off = await pedir("PATCH", `/v1/products/${nuevo.id}`, {
      company_id: COMPANY,
      tracks_lots: false,
    });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ tracks_lots: false, tracks_expiry: false });
  });
});

describe("I-04 · el producto compuesto", () => {
  it("se marca compuesto al crear el producto, y su receta se guarda", async () => {
    const arepa = await crearProducto("Arepa rellena", 50, { is_composed: true });
    expect(arepa.is_composed).toBe(true);
    AREPA = arepa.id;
    const receta = await pedir("PUT", `/v1/products/${AREPA}/recipe`, {
      company_id: COMPANY,
      lines: [
        { child_product_id: HARINA, quantity: "0.5", unit_code: "unidad" },
        { child_product_id: PAN, quantity: "2", unit_code: "unidad" },
      ],
    });
    expect(receta.status).toBe(200);
  });

  it("un compuesto no lleva lote, y no es ingrediente de sí mismo ni de otro compuesto", async () => {
    const conLote = await pedir("POST", "/v1/products", {
      company_id: COMPANY,
      sku: `CL-MAL-${RUN}`,
      name: "Compuesto con lote",
      kind: "good",
      unit_code: "unidad",
      is_composed: true,
      tracks_lots: true,
    });
    expect(conLote.status).toBe(422);
    expect(((await conLote.json()) as { message: string }).message).toContain(
      "no lleva existencia propia",
    );

    const combo = await crearProducto("Combo", 90, { is_composed: true });
    const anidada = await pedir("PUT", `/v1/products/${combo.id}/recipe`, {
      company_id: COMPANY,
      lines: [{ child_product_id: AREPA, quantity: "1", unit_code: "unidad" }],
    });
    expect(anidada.status).toBe(409);
    expect(((await anidada.json()) as { code: string }).code).toBe("RECIPE_INVALID");
    const propia = await pedir("PUT", `/v1/products/${combo.id}/recipe`, {
      company_id: COMPANY,
      lines: [{ child_product_id: combo.id, quantity: "1", unit_code: "unidad" }],
    });
    expect(propia.status).toBeGreaterThanOrEqual(400);
    expect(propia.status).toBeLessThan(500);
  });

  it("un producto con movimientos no se vuelve compuesto, y un ingrediente tampoco", async () => {
    const refresco = await crearProducto("Refresco", 15);
    expect((await llegar(refresco.id, "6", "30")).status).toBe(201);
    const r = await pedir("PATCH", `/v1/products/${refresco.id}`, {
      company_id: COMPANY,
      is_composed: true,
    });
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("RECIPE_INVALID");
    expect(cuerpo.message).toContain("ya tiene movimientos de mercancía");

    // El pan ya es ingrediente de la arepa: no puede ser compuesto a la vez (sin anidamiento).
    const ingrediente = await pedir("PATCH", `/v1/products/${PAN}`, {
      company_id: COMPANY,
      is_composed: true,
    });
    expect(ingrediente.status).toBe(409);
    expect(((await ingrediente.json()) as { message: string }).message).toContain(
      "es ingrediente de un compuesto",
    );
    const [p] = await sql<{ a: boolean; b: boolean }[]>`
      select (select is_composed from public.products where id = ${refresco.id}) as a,
             (select is_composed from public.products where id = ${PAN}) as b`;
    expect(p).toEqual({ a: false, b: false });
  });

  it("un compuesto sin receta no se vende: no descontaría nada", async () => {
    const vacio = await crearProducto("Plato sin receta", 40, { is_composed: true });
    const r = await vender([{ product_id: vacio.id, quantity: "1" }]);
    expect(r.status).toBe(422);
    const m = ((await r.json()) as { message: string }).message;
    expect(m).toContain("Plato sin receta");
    expect(m).toContain("no tiene ingredientes");
  });

  it("VENDER 3 saca 3 × la receta de cada ingrediente, a su costo y al céntimo; el costo de lo vendido es la suma", async () => {
    const antesH = await posicion(HARINA);
    const antesP = await posicion(PAN);
    const venta = await vender([{ product_id: AREPA, quantity: "3" }]);
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;

    const salidas = await salidasDe(doc);
    const porProducto = new Map(salidas.map((s) => [s.product_id, s]));
    expect(salidas).toHaveLength(2);
    // 1,5 × 3,333 = 4,9995 → 5,00 (al céntimo); 6 × 8 = 48,00.
    expect(porProducto.get(HARINA)).toMatchObject({ q: "-1.50000000", v: "-5.00000000" });
    expect(porProducto.get(PAN)).toMatchObject({ q: "-6.00000000", v: "-48.00000000" });

    const [h] = await sql<{ q: string; v: string }[]>`
      select (${antesH.q}::numeric - 1.5)::text as q, (${antesH.v}::numeric - 5)::text as v`;
    expect(await posicion(HARINA)).toEqual({ q: h!.q, v: h!.v });
    const [p] = await sql<{ q: string; v: string }[]>`
      select (${antesP.q}::numeric - 6)::text as q, (${antesP.v}::numeric - 48)::text as v`;
    expect(await posicion(PAN)).toEqual({ q: p!.q, v: p!.v });

    // El compuesto no lleva existencia: ni saldo ni movimiento propio.
    const [propio] = await sql<{ saldos: number; movs: number }[]>`
      select (select count(*)::int from public.stock_balances where product_id = ${AREPA}) as saldos,
             (select count(*)::int from public.inventory_moves where product_id = ${AREPA}) as movs`;
    expect(propio).toEqual({ saldos: 0, movs: 0 });

    // El costo de lo vendido es la SUMA de las salidas: 53,00.
    const [costo] = await sql<{ debe: string }[]>`
      select coalesce(sum(jl.functional_debit), 0)::text as debe
        from public.journal_entries je
        join public.journal_lines jl on jl.entry_id = je.id
       where je.company_id = ${COMPANY} and je.source_kind = 'sales_cost'
         and je.source_id = ${doc}`;
    expect(costo!.debe).toBe("53.00000000");

    // Lo que la venta sacó queda escrito, con la receta de ese momento.
    const rastro = await sql<{ hijo: string; q: string; v: string; por_unidad: string }[]>`
      select child_product_id as hijo, quantity::text as q, functional_amount::text as v,
             (recipe_quantity * unit_factor)::numeric(24,8)::text as por_unidad
        from public.sale_line_components
       where company_id = ${COMPANY} and document_id = ${doc} and direction = 'out'
       order by quantity`;
    expect(rastro).toEqual([
      { hijo: HARINA, q: "1.50000000", v: "5.00000000", por_unidad: "0.50000000" },
      { hijo: PAN, q: "6.00000000", v: "48.00000000", por_unidad: "2.00000000" },
    ]);
    await invariantesEnCero();
  });

  it("sin existencia de un ingrediente, la caja dice CUÁL falta y no vende nada", async () => {
    const antes = await posicion(PAN);
    const r = await vender([{ product_id: AREPA, quantity: "50" }]);
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("NEGATIVE_STOCK");
    // 50 arepas piden 25 de harina (hay 28,5) y 100 de pan (hay 94): falta el pan.
    expect(cuerpo.message).toContain("Pan");
    expect(cuerpo.message).toContain("Arepa rellena");
    expect(cuerpo.message).not.toContain("Harina");
    expect(await posicion(PAN)).toEqual(antes);
  });

  it("la receta que cambia después NO cambia lo vendido, y la venta siguiente usa la nueva", async () => {
    const [antes] = await sql<{ doc: string; n: number; q: string }[]>`
      select document_id as doc, count(*)::int as n, sum(quantity)::text as q
        from public.sale_line_components
       where company_id = ${COMPANY} and parent_product_id = ${AREPA}
       group by document_id`;
    const receta = await pedir("PUT", `/v1/products/${AREPA}/recipe`, {
      company_id: COMPANY,
      lines: [
        { child_product_id: HARINA, quantity: "1", unit_code: "unidad" },
        { child_product_id: PAN, quantity: "2", unit_code: "unidad" },
      ],
    });
    expect(receta.status).toBe(200);
    const [despues] = await sql<{ n: number; q: string }[]>`
      select count(*)::int as n, sum(quantity)::text as q
        from public.sale_line_components
       where company_id = ${COMPANY} and document_id = ${antes!.doc}`;
    expect(despues).toEqual({ n: antes!.n, q: antes!.q });

    const venta = await vender([{ product_id: AREPA, quantity: "1" }]);
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;
    const salidas = new Map((await salidasDe(doc)).map((s) => [s.product_id, s.q]));
    expect(salidas.get(HARINA)).toBe("-1.00000000");
    expect(salidas.get(PAN)).toBe("-2.00000000");
    await invariantesEnCero();
  });

  it("la devolución PARCIAL devuelve los ingredientes en proporción y al costo con que salieron; el resto deja la venta en cero", async () => {
    // La misma venta lleva además pan SUELTO: lo del compuesto y lo suelto no se mezclan.
    const venta = await vender(
      [
        { product_id: AREPA, quantity: "4" },
        { product_id: PAN, quantity: "5" },
      ],
      "300.00000000",
    );
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;
    const lineas = await sql<{ id: string; product_id: string }[]>`
      select id, product_id from public.document_lines where document_id = ${doc}`;
    const lineaArepa = lineas.find((l) => l.product_id === AREPA)!.id;
    const lineaPan = lineas.find((l) => l.product_id === PAN)!.id;
    const despuesDeVender = { h: await posicion(HARINA), p: await posicion(PAN) };

    const devolver = async (linea: string, cantidad: string): Promise<string> => {
      const b = await pedir("POST", "/v1/returns", {
        company_id: COMPANY,
        source_document_id: doc,
        warehouse_id: W1,
        reason: "El cliente devolvió parte del pedido",
        lines: [{ source_line_id: linea, quantity: cantidad }],
      });
      expect(b.status).toBe(201);
      const id = ((await b.json()) as { id: string }).id;
      expect((await pedir("POST", `/v1/returns/${id}/confirm`, {})).status).toBe(200);
      return id;
    };

    // 1 de 4 arepas: vuelve 1/4 de lo que salió por ella (harina 4 → 1; pan 8 → 2), no el pan suelto.
    const dev1 = await devolver(lineaArepa, "1");
    const entradas1 = await sql<{ product_id: string; q: string; v: string }[]>`
      select product_id, quantity::text as q, functional_amount::text as v
        from public.inventory_moves
       where company_id = ${COMPANY} and source_document_id = ${dev1} and kind = 'entrada'`;
    const e1 = new Map(entradas1.map((e) => [e.product_id, e]));
    expect(entradas1).toHaveLength(2);
    expect(e1.get(HARINA)).toMatchObject({ q: "1.00000000", v: "3.33000000" });
    expect(e1.get(PAN)).toMatchObject({ q: "2.00000000", v: "16.00000000" });
    await invariantesEnCero();

    // El pan suelto se devuelve por SU línea: 5, a lo que costó.
    const dev2 = await devolver(lineaPan, "5");
    const [suelto] = await sql<{ q: string; v: string }[]>`
      select sum(quantity)::text as q, sum(functional_amount)::text as v
        from public.inventory_moves
       where company_id = ${COMPANY} and source_document_id = ${dev2} and kind = 'entrada'`;
    expect(suelto).toEqual({ q: "5.00000000", v: "40.00000000" });

    // Las 3 arepas que quedaban: la venta entera netea a cero, en cantidad y en valor.
    const dev3 = await devolver(lineaArepa, "3");
    const [neto] = await sql<{ q: string; v: string }[]>`
      select sum(m.quantity)::text as q, sum(m.functional_amount)::text as v
        from public.inventory_moves m
       where m.company_id = ${COMPANY}
         and m.source_document_id in (${doc}, ${dev1}, ${dev2}, ${dev3})`;
    expect(neto).toEqual({ q: "0.00000000", v: "0.00000000" });
    const [vuelta] = await sql<{ h: string; p: string }[]>`
      select (${despuesDeVender.h.q}::numeric + 4)::text as h,
             (${despuesDeVender.p.q}::numeric + 13)::text as p`;
    expect((await posicion(HARINA)).q).toBe(vuelta!.h);
    expect((await posicion(PAN)).q).toBe(vuelta!.p);

    // Y no se devuelve una quinta.
    const demas = await pedir("POST", "/v1/returns", {
      company_id: COMPANY,
      source_document_id: doc,
      warehouse_id: W1,
      reason: "De más",
      lines: [{ source_line_id: lineaArepa, quantity: "1" }],
    });
    expect(demas.status).toBe(422);
    await invariantesEnCero();
    // Una venta, tres devoluciones confirmadas y tres lecturas de siete invariantes: con la base
    // compartida pasa de los 5 s por omisión (medido: 2,7 s sola, más de 5 s con otras corridas).
  }, 30_000);

  it("ANULAR la venta de un compuesto repone sus ingredientes", async () => {
    const antes = { h: await posicion(HARINA), p: await posicion(PAN) };
    const venta = await vender([{ product_id: AREPA, quantity: "2" }]);
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;
    expect((await posicion(PAN)).q).not.toBe(antes.p.q);
    const anulada = await pedir("POST", `/v1/invoices/${doc}/annul`, {
      company_id: COMPANY,
      reason: "Se cobró el plato equivocado",
      originals_in_hand: true,
    });
    expect(anulada.status).toBe(200);
    expect(await posicion(HARINA)).toEqual(antes.h);
    expect(await posicion(PAN)).toEqual(antes.p);
    await invariantesEnCero();
  });

  it("un ingrediente con lote sale por vencimiento, y el compuesto que ya se vendió no deja de serlo", async () => {
    const tabla = await crearProducto("Tabla de queso", 150, { is_composed: true });
    TABLA = tabla.id;
    expect(
      (
        await pedir("PUT", `/v1/products/${TABLA}/recipe`, {
          company_id: COMPANY,
          lines: [{ child_product_id: QUESO, quantity: "2", unit_code: "unidad" }],
        })
      ).status,
    ).toBe(200);
    expect(
      (await llegar(QUESO, "1", "40", { code: `ANTES-${RUN}`, vence: diaCaracas(2) })).status,
    ).toBe(201);
    const venta = await vender([{ product_id: TABLA, quantity: "1" }]);
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;
    // Quedaban 4 de LEJOS (+60 días) y llegó 1 de ANTES (+2 días): sale primero ANTES.
    expect(await salidasDe(doc)).toEqual([
      { product_id: QUESO, lote: `ANTES-${RUN}`, q: "-1.00000000", v: "-40.00000000" },
      { product_id: QUESO, lote: `LEJOS-${RUN}`, q: "-1.00000000", v: "-50.00000000" },
    ]);
    await invariantesEnCero();

    const dejar = await pedir("PATCH", `/v1/products/${TABLA}`, {
      company_id: COMPANY,
      is_composed: false,
    });
    expect(dejar.status).toBe(409);
    const cuerpo = (await dejar.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("RECIPE_INVALID");
    expect(cuerpo.message).toContain("ya se vendió");
  });

  it("VARIANTE ROTA: sin el rastro de lo que la venta sacó, `composite_sale_gaps` lo señala", async () => {
    const roto = await sql
      .begin(async (tx) => {
        await tx`alter table public.sale_line_components disable trigger user`;
        await tx`delete from public.sale_line_components
                  where company_id = ${COMPANY} and parent_product_id = ${TABLA}`;
        const [g] = await tx<{ n: number; motivos: string[] }[]>`
          select count(*)::int as n, array_agg(distinct gap) as motivos
            from platform.composite_sale_gaps(${COMPANY})`;
        throw Object.assign(new Error("deshacer"), { hallado: g });
      })
      .catch((e: { hallado?: { n: number; motivos: string[] } }) => e.hallado);
    expect(roto!.n).toBe(1);
    expect(roto!.motivos).toEqual(["sin_salidas"]);
    // Deshecho: el invariante vuelve a cero.
    await invariantesEnCero();
  });
});

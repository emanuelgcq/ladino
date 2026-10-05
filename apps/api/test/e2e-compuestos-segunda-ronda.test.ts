import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { fiadoDeFixture, venceDeFixture } from "./_fiado-de-fixture.js";
import { borrarTasasOficiales, sembrarTasaOficial } from "./_tasa-oficial.js";

/**
 * I-04 Y C-07, SEGUNDA RONDA (ola 5 del recorrido 2026-09-24): lo que la revisión en contexto
 * limpio pidió y los casos que no tenían test.
 *
 *   · C1 — «lo que gané» del Inicio ve el costo de un compuesto: es la SUMA de las salidas de sus
 *     ingredientes (`sale_line_components`, dirección `out`), y la devolución devuelve la suma de
 *     sus reingresos (`back`). Empresa SIN contabilidad: con plantillas, la cifra sale del mayor.
 *   · C2 — el ingrediente que falta LLEVA LOTE: la caja nombra también el compuesto.
 *   · C3 — marcar «compuesto» exige `product.recipe.manage` en el servidor: el encargado (rol de
 *     sistema `store_manager`) no deja un producto que no se puede vender.
 *   · C10 — quitar la marca deja en el acta las líneas de receta que se borraron.
 *   · sin test hasta hoy: dos ventas simultáneas, el reintento por idempotencia, cotización y
 *     pedido, receta fraccionaria con conversión de unidad, la recepción de COMPRA de un producto
 *     con lote, y la anulación después de una devolución parcial.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const RUN = Date.now().toString(36);
const FUENTE = `e2e-compuestos-2-${RUN}`;
const HOY = diaCaracas();
const DUENO = crypto.randomUUID();
const ENCARGADO = crypto.randomUUID();
const ROL = crypto.randomUUID();

interface Empresa {
  tenant: string;
  company: string;
  w1: string;
  cliente: string;
  lista: string;
  caja: string;
}
const nueva = (): Empresa => ({
  tenant: crypto.randomUUID(),
  company: crypto.randomUUID(),
  w1: crypto.randomUUID(),
  cliente: crypto.randomUUID(),
  lista: "",
  caja: "",
});
/** Con plan de cuentas y plantillas: «lo que gané» sale del mayor y los invariantes contables miran. */
const CON = nueva();
/** Sin contabilidad: «lo que gané» sale del margen de las líneas (el lector que C1 corrige). */
const SIN = nueva();

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;

const tokenDe = (sub: string) =>
  new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);

async function pedir(
  e: Empresa,
  metodo: string,
  path: string,
  body?: unknown,
  opciones: { quien?: string; llave?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(opciones.quien ?? DUENO)}`,
    "X-Company-Id": e.company,
  };
  if (metodo !== "GET") headers["Idempotency-Key"] = opciones.llave ?? crypto.randomUUID();
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

async function crearProducto(
  e: Empresa,
  nombre: string,
  precio: number,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const r = await pedir(e, "POST", "/v1/products", {
    company_id: e.company,
    sku: `C2-${nombre.replace(/\s+/g, "-").toUpperCase()}-${RUN}`,
    name: nombre,
    kind: "good",
    unit_code: "unidad",
    ...extra,
  });
  expect(r.status).toBe(201);
  const p = (await r.json()) as { id: string };
  await sql`
    insert into public.price_list_items
      (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
    values (${e.tenant}, ${e.company}, ${e.lista}, ${p.id}, ${precio}, now() - interval '1 day')`;
  return p.id;
}

async function compuesto(
  e: Empresa,
  nombre: string,
  precio: number,
  lineas: { child_product_id: string; quantity: string; unit_code?: string }[],
): Promise<string> {
  const id = await crearProducto(e, nombre, precio, { is_composed: true });
  const receta = await pedir(e, "PUT", `/v1/products/${id}/recipe`, {
    company_id: e.company,
    lines: lineas.map((l) => ({ unit_code: "unidad", ...l })),
  });
  expect(receta.status).toBe(200);
  return id;
}

async function llegar(
  e: Empresa,
  producto: string,
  cantidad: string,
  total: string,
  lote?: { code: string; vence: string },
): Promise<void> {
  const r = await pedir(e, "POST", "/v1/inventory/receipts", {
    origin: "aporte",
    company_id: e.company,
    warehouse_id: e.w1,
    product_id: producto,
    quantity: cantidad,
    amount: total,
    currency: "VES",
    ...(lote === undefined ? {} : { lot_code: lote.code, lot_expires_at: lote.vence }),
  });
  expect(r.status).toBe(201);
}

async function posicion(e: Empresa, producto: string): Promise<{ q: string; v: string }> {
  const [b] = await sql<{ q: string; v: string }[]>`
    select coalesce(sum(quantity), 0)::text as q, coalesce(sum(value), 0)::text as v
      from public.stock_balances
     where company_id = ${e.company} and warehouse_id = ${e.w1} and product_id = ${producto}`;
  return b!;
}

function cuerpoDeVenta(
  e: Empresa,
  lineas: { product_id: string; quantity: string }[],
  pago?: string,
): Record<string, unknown> {
  return {
    company_id: e.company,
    warehouse_id: e.w1,
    customer_id: e.cliente,
    lines: lineas,
    ...(pago === undefined
      ? { due_date: venceDeFixture() }
      : {
          payments: [
            { instrument: "efectivo_bs", amount: pago, currency: "VES", account_id: e.caja },
          ],
        }),
  };
}

async function vender(
  e: Empresa,
  lineas: { product_id: string; quantity: string }[],
  pago?: string,
  llave?: string,
): Promise<Response> {
  return pedir(
    e,
    "POST",
    "/v1/pos/sales",
    cuerpoDeVenta(e, lineas, pago),
    llave === undefined ? {} : { llave },
  );
}

async function devolver(e: Empresa, doc: string, linea: string, cantidad: string): Promise<string> {
  const b = await pedir(e, "POST", "/v1/returns", {
    company_id: e.company,
    source_document_id: doc,
    warehouse_id: e.w1,
    reason: "El cliente devolvió parte del pedido",
    lines: [{ source_line_id: linea, quantity: cantidad }],
  });
  expect(b.status).toBe(201);
  const id = ((await b.json()) as { id: string }).id;
  expect((await pedir(e, "POST", `/v1/returns/${id}/confirm`, {})).status).toBe(200);
  return id;
}

async function invariantesEnCero(e: Empresa): Promise<void> {
  const [r] = await sql<Record<string, string | number>[]>`
    select (select diferencia::text from platform.inventory_ledger_gap(${e.company})) as gap,
           (select count(*)::int from platform.inventory_coverage_gaps(${e.company})) as inv,
           (select count(*)::int from platform.accounting_coverage_gaps(${e.company})) as docs,
           (select count(*)::int from platform.annulled_stock_gaps(${e.company})) as anuladas,
           (select count(*)::int from platform.cent_gaps(${e.company})) as centimo,
           (select count(*)::int from platform.stock_reconciliation(${e.company})) as kardex,
           (select count(*)::int from platform.composite_sale_gaps(${e.company})) as compuestos`;
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

async function resumen(e: Empresa): Promise<{
  vendido_hoy: string;
  ganado_hoy: string;
  ganado_desde_contabilidad: boolean;
  lineas_sin_costo_mes: number;
}> {
  const r = await pedir(e, "GET", "/v1/negocio/resumen");
  expect(r.status).toBe(200);
  return (await r.json()) as {
    vendido_hoy: string;
    ganado_hoy: string;
    ganado_desde_contabilidad: boolean;
    lineas_sin_costo_mes: number;
  };
}

async function fundar(e: Empresa, nombre: string, conContabilidad: boolean): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${e.tenant}, ${`Tenant ${nombre}`})`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code)
             values (${e.company}, ${e.tenant}, ${`PEND-${nombre}-${RUN}`}, ${nombre}, 'VES')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${e.w1}, ${e.tenant}, ${e.company}, 'E2E-C2W1', 'Local')`;
    const mem = crypto.randomUUID();
    const asig = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${mem}, ${e.tenant}, ${DUENO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${asig}, ${e.tenant}, ${mem}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${e.tenant}, ${e.company}, ${asig}, 'warehouse', ${e.w1})`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${e.tenant}, ${e.company}, 'sin_facturacion', now() - interval '10 days')`;
    await tx`insert into public.customers (id, tenant_id, company_id, legal_name,
                                           person_type_code, taxpayer_type_code)
             values (${e.cliente}, ${e.tenant}, ${e.company}, 'Señor Tulio', 'natural',
                     'consumidor_final')`;
    await fiadoDeFixture(tx, e.company, [ROL]);
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${e.tenant}, ${e.company}, 'detal', 'VES') returning id`;
    e.lista = l!.id;
    await tx`insert into public.company_settings (company_id, tenant_id, default_price_list_id)
             values (${e.company}, ${e.tenant}, ${e.lista})`;
  });
  if (conContabilidad) {
    for (const [ruta, cuerpo] of [
      ["/v1/accounts/import-template", { company_id: e.company, template_code: "ve_basico" }],
      ["/v1/journal-templates/import-preset", { company_id: e.company, preset_code: "ve_basico" }],
    ] as const) {
      expect((await pedir(e, "POST", ruta, cuerpo)).status).toBe(201);
    }
  }
  const caja = await pedir(e, "POST", "/v1/treasury/accounts", {
    company_id: e.company,
    name: `Caja Bs ${RUN}`,
    currency: "VES",
    kind: "cash",
  });
  expect(caja.status).toBe(201);
  e.caja = ((await caja.json()) as { id: string }).id;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}), (${ENCARGADO})
            on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2ec2_${RUN}`}, 'Dueño', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.invoice.annul'),
             (${ROL}, 'sales.payment.register'), (${ROL}, 'sales.return.manage'),
             (${ROL}, 'sales.quote.manage'), (${ROL}, 'sales.order.manage'),
             (${ROL}, 'purchase.receive'),
             (${ROL}, 'product.manage'), (${ROL}, 'product.recipe.manage'),
             (${ROL}, 'ar.read'), (${ROL}, 'inventory.move'), (${ROL}, 'treasury.read'),
             (${ROL}, 'treasury.account.manage'), (${ROL}, 'accounting.account.manage'),
             (${ROL}, 'accounting.template.manage'), (${ROL}, 'accounting.entry.reverse'),
             (${ROL}, 'accounting.read')
             on conflict do nothing`;
  });
  // La tasa oficial de hoy, con fuente PROPIA de este fichero, y se borra al terminar (C8).
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await sembrarTasaOficial(tx as unknown as ReturnType<typeof createClient>, {
      rate: "40",
      rate_date: HOY,
      source: FUENTE,
    });
  });
  await fundar(CON, "Arepera-ronda-2", true);
  await fundar(SIN, "Bodega-sin-libros", false);
}, 60_000);

afterAll(async () => {
  if (sql) {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
      await borrarTasasOficiales(tx as unknown as ReturnType<typeof createClient>, FUENTE);
    });
  }
  await sql?.end();
  await sqlApi?.end();
});

describe("C1 · «lo que gané» ve el costo de un compuesto", { timeout: 30_000 }, () => {
  it("vender 3 y devolver 1: la cifra es venta − costo EXACTO en cada paso, y no hay «venta sin costo»", async () => {
    const harina = await crearProducto(SIN, "Harina", 10);
    const pan = await crearProducto(SIN, "Pan", 20);
    // 30 por 99,99: promedio 3,333. La salida de 1,5 vale 4,9995 → 5,00 al céntimo.
    await llegar(SIN, harina, "30", "99.99");
    await llegar(SIN, pan, "100", "800");
    const arepa = await compuesto(SIN, "Arepa rellena", 50, [
      { child_product_id: harina, quantity: "0.5" },
      { child_product_id: pan, quantity: "2" },
    ]);

    const antes = await resumen(SIN);
    expect(antes.ganado_desde_contabilidad).toBe(false);
    expect(antes).toMatchObject({ vendido_hoy: "0", ganado_hoy: "0.00", lineas_sin_costo_mes: 0 });

    const venta = await vender(SIN, [{ product_id: arepa, quantity: "3" }], "150.00000000");
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;

    // Lo que la venta sacó: 5,00 de harina y 48,00 de pan. El costo de la línea es la SUMA: 53,00
    // (53 / 3 × 3 = 53,00000001: por eso no se guarda un costo unitario en la línea).
    const [sacado] = await sql<{ costo: string }[]>`
      select sum(functional_amount)::text as costo from public.sale_line_components
       where company_id = ${SIN.company} and document_id = ${doc} and direction = 'out'`;
    expect(sacado!.costo).toBe("53.00000000");
    const vendida = await resumen(SIN);
    // 150 − 53 = 97. En HEAD de la ronda anterior: 0,00 y una «venta sin costo».
    expect(vendida.vendido_hoy).toBe("150.00000000");
    expect(vendida.ganado_hoy).toBe("97.00");
    expect(vendida.lineas_sin_costo_mes).toBe(0);

    const [linea] = await sql<{ id: string }[]>`
      select id from public.document_lines where document_id = ${doc}`;
    const dev = await devolver(SIN, doc, linea!.id, "1");
    // Vuelve 1/3 de cada salida: harina 0,5 a céntimo(5 / 3) = 1,67 y pan 2 a 16,00.
    const [vuelto] = await sql<{ costo: string }[]>`
      select sum(functional_amount)::text as costo from public.sale_line_components
       where company_id = ${SIN.company} and return_id = ${dev} and direction = 'back'`;
    expect(vuelto!.costo).toBe("17.67000000");
    const devuelta = await resumen(SIN);
    // (150 − 50) − (53 − 17,67) = 64,67. En HEAD de la ronda anterior: −50,00 (restaba la venta
    // devuelta de una venta que nunca había sumado, y devolvía costo cero).
    expect(devuelta.vendido_hoy).toBe("100.00000000");
    expect(devuelta.ganado_hoy).toBe("64.67");
    expect(devuelta.lineas_sin_costo_mes).toBe(0);
  });
});

describe("C3 · marcar «compuesto» exige poder escribir su receta", { timeout: 30_000 }, () => {
  it("el ENCARGADO (rol de sistema) no marca un compuesto por ninguna de las tres puertas, y sí crea un producto normal", async () => {
    // El encargado real: el rol de sistema `store_manager`, con alcance sobre el depósito.
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      const [rol] = await tx<{ id: string }[]>`
        select id from public.roles where tenant_id is null and key = 'store_manager'`;
      const mem = crypto.randomUUID();
      const asig = crypto.randomUUID();
      await tx`insert into public.memberships (id, tenant_id, user_id) values
               (${mem}, ${CON.tenant}, ${ENCARGADO})`;
      await tx`insert into public.user_role_assignments
                 (id, tenant_id, membership_id, role_id, company_id) values
               (${asig}, ${CON.tenant}, ${mem}, ${rol!.id}, null)`;
      await tx`insert into public.scope_bindings
                 (tenant_id, company_id, assignment_id, scope_type, scope_id)
               values (${CON.tenant}, ${CON.company}, ${asig}, 'warehouse', ${CON.w1})`;
    });
    const [permisos] = await sql<{ productos: boolean; recetas: boolean }[]>`
      select platform.ladino_user_has_permission(${ENCARGADO}, 'product.manage', ${CON.company})
               as productos,
             platform.ladino_user_has_permission(${ENCARGADO}, 'product.recipe.manage',
                                                 ${CON.company}) as recetas`;
    expect(permisos).toEqual({ productos: true, recetas: false });
    const quien = { quien: ENCARGADO };

    const alta = await pedir(
      CON,
      "POST",
      "/v1/products",
      {
        company_id: CON.company,
        sku: `C2-ENC-COMP-${RUN}`,
        name: "Combo del encargado",
        kind: "good",
        unit_code: "unidad",
        is_composed: true,
      },
      quien,
    );
    expect(alta.status).toBe(403);
    const cuerpo = (await alta.json()) as { code: string; message: string; person_message: string };
    expect(cuerpo.code).toBe("PERMISSION_REQUIRED");
    // El mensaje nombra el permiso de RECETAS, no el de productos (que sí tiene), y la persona
    // lee qué le falta.
    expect(cuerpo.message).toContain("product.recipe.manage");
    expect(cuerpo.person_message).toContain("definir recetas de productos");

    const simple = await pedir(
      CON,
      "POST",
      "/v1/products/simple",
      {
        company_id: CON.company,
        name: "Combo simple del encargado",
        price: { amount: "5", currency: "USD" },
        is_composed: true,
      },
      quien,
    );
    expect(simple.status).toBe(403);
    expect(((await simple.json()) as { person_message: string }).person_message).toContain(
      "definir recetas de productos",
    );

    const normal = await pedir(
      CON,
      "POST",
      "/v1/products",
      {
        company_id: CON.company,
        sku: `C2-ENC-NORMAL-${RUN}`,
        name: "Refresco del encargado",
        kind: "good",
        unit_code: "unidad",
      },
      quien,
    );
    expect(normal.status).toBe(201);
    const id = ((await normal.json()) as { id: string }).id;
    const marcar = await pedir(
      CON,
      "PATCH",
      `/v1/products/${id}`,
      { company_id: CON.company, is_composed: true },
      quien,
    );
    expect(marcar.status).toBe(403);
    expect(((await marcar.json()) as { person_message: string }).person_message).toContain(
      "definir recetas de productos",
    );
    // Editar lo demás sigue siendo suyo, aunque repita la marca que el producto ya tiene.
    const renombrar = await pedir(
      CON,
      "PATCH",
      `/v1/products/${id}`,
      { company_id: CON.company, name: "Refresco grande", is_composed: false },
      quien,
    );
    expect(renombrar.status).toBe(200);

    // Ningún compuesto sin receta quedó en el catálogo por su mano.
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.products
       where company_id = ${CON.company} and is_composed`;
    expect(n!.n).toBe(0);
  });

  it("C10 · quitar la marca de compuesto deja en el acta las líneas de receta que se borraron", async () => {
    const queso = await crearProducto(CON, "Queso llanero", 30);
    const jamon = await crearProducto(CON, "Jamón", 40);
    const combo = await compuesto(CON, "Combo que se arrepiente", 90, [
      { child_product_id: queso, quantity: "0.25" },
      { child_product_id: jamon, quantity: "2" },
    ]);
    const quitar = await pedir(CON, "PATCH", `/v1/products/${combo}`, {
      company_id: CON.company,
      is_composed: false,
    });
    expect(quitar.status).toBe(200);
    const [receta] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.product_recipes where parent_product_id = ${combo}`;
    expect(receta!.n).toBe(0);
    const [acta] = await sql<{ payload: { is_composed: boolean; recipe_removed: unknown[] } }[]>`
      select payload from public.audit_events
       where company_id = ${CON.company} and aggregate_id = ${combo}
         and event_type = 'product.updated'
       order by occurred_at desc limit 1`;
    expect(acta!.payload.is_composed).toBe(false);
    expect(
      [...(acta!.payload.recipe_removed as { child_product_id: string }[])].sort((a, b) =>
        a.child_product_id.localeCompare(b.child_product_id),
      ),
    ).toEqual(
      [
        { child_product_id: queso, quantity: "0.25000000", unit_code: "unidad" },
        { child_product_id: jamon, quantity: "2.00000000", unit_code: "unidad" },
      ].sort((a, b) => a.child_product_id.localeCompare(b.child_product_id)),
    );
  });
});

describe("I-04 · los casos que no tenían test", { timeout: 60_000 }, () => {
  let HARINA = "";
  let PAN = "";
  let AREPA = "";

  it("prepara: harina, pan y la arepa", async () => {
    HARINA = await crearProducto(CON, "Harina", 10);
    PAN = await crearProducto(CON, "Pan", 20);
    await llegar(CON, HARINA, "30", "99.99");
    await llegar(CON, PAN, "100", "800");
    AREPA = await compuesto(CON, "Arepa rellena", 50, [
      { child_product_id: HARINA, quantity: "0.5" },
      { child_product_id: PAN, quantity: "2" },
    ]);
  });

  it("C2 · el ingrediente que falta LLEVA LOTE: la caja nombra el ingrediente Y el compuesto", async () => {
    const queso = await crearProducto(CON, "Queso de mano", 100, { tracks_lots: true });
    await llegar(CON, queso, "1", "40", { code: `UNO-${RUN}`, vence: diaCaracas(5) });
    const tabla = await compuesto(CON, "Tabla de queso", 150, [
      { child_product_id: queso, quantity: "2" },
    ]);
    const r = await vender(CON, [{ product_id: tabla, quantity: "1" }]);
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("NEGATIVE_STOCK");
    // El camino es el del reparto por lotes (y no el del saldo de la posición)…
    expect(cuerpo.message).toContain("en lotes vigentes");
    expect(cuerpo.message).toContain("Queso de mano");
    // …y dice de qué compuesto es ingrediente.
    expect(cuerpo.message).toContain("Es ingrediente de «Tabla de queso»");
    expect(await posicion(CON, queso)).toEqual({ q: "1.00000000", v: "40.00000000" });
  });

  it("dos ventas SIMULTÁNEAS del mismo compuesto con existencia para una: una vende y la otra dice qué falta", async () => {
    const raro = await crearProducto(CON, "Trufa", 500);
    await llegar(CON, raro, "1", "300");
    const unico = await compuesto(CON, "Pasta con trufa", 900, [
      { child_product_id: raro, quantity: "1" },
    ]);
    const [a, b] = await Promise.all([
      vender(CON, [{ product_id: unico, quantity: "1" }]),
      vender(CON, [{ product_id: unico, quantity: "1" }]),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const perdedora = (await (a.status === 409 ? a : b).json()) as {
      code: string;
      message: string;
    };
    expect(perdedora.code).toBe("NEGATIVE_STOCK");
    expect(perdedora.message).toContain("Trufa");
    expect(perdedora.message).toContain("Es ingrediente de «Pasta con trufa»");
    expect(await posicion(CON, raro)).toEqual({ q: "0.00000000", v: "0.00000000" });
    const [rastro] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.sale_line_components
       where company_id = ${CON.company} and parent_product_id = ${unico}`;
    expect(rastro!.n).toBe(1);
    await invariantesEnCero(CON);
  });

  it("el REINTENTO con la misma llave devuelve la misma venta y saca los ingredientes UNA sola vez", async () => {
    const antes = { h: await posicion(CON, HARINA), p: await posicion(CON, PAN) };
    const llave = crypto.randomUUID();
    const primera = await vender(CON, [{ product_id: AREPA, quantity: "2" }], undefined, llave);
    expect(primera.status).toBe(201);
    const doc = ((await primera.json()) as { document: { id: string } }).document.id;
    const segunda = await vender(CON, [{ product_id: AREPA, quantity: "2" }], undefined, llave);
    expect(segunda.status).toBe(201);
    expect(((await segunda.json()) as { document: { id: string } }).document.id).toBe(doc);

    const [n] = await sql<{ movs: number; rastro: number; ventas: number }[]>`
      select (select count(*)::int from public.inventory_moves
               where company_id = ${CON.company} and source_document_id = ${doc}) as movs,
             (select count(*)::int from public.sale_line_components
               where company_id = ${CON.company} and document_id = ${doc}) as rastro,
             (select count(*)::int from public.document_lines dl
                join public.documents d on d.id = dl.document_id
               where d.company_id = ${CON.company} and dl.product_id = ${AREPA}
                 and d.kind in ('invoice', 'receipt')) as ventas`;
    expect(n).toEqual({ movs: 2, rastro: 2, ventas: 1 });
    const [h] = await sql<{ q: string }[]>`select (${antes.h.q}::numeric - 1)::text as q`;
    const [p] = await sql<{ q: string }[]>`select (${antes.p.q}::numeric - 4)::text as q`;
    expect((await posicion(CON, HARINA)).q).toBe(h!.q);
    expect((await posicion(CON, PAN)).q).toBe(p!.q);
    await invariantesEnCero(CON);
  });

  it("la cotización y el pedido de un compuesto NO mueven el kardex ni dejan rastro de ingredientes", async () => {
    const antes = { h: await posicion(CON, HARINA), p: await posicion(CON, PAN) };
    const ids: string[] = [];
    for (const ruta of ["/v1/quotes", "/v1/orders"]) {
      const r = await pedir(CON, "POST", ruta, {
        company_id: CON.company,
        customer_id: CON.cliente,
        lines: [{ product_id: AREPA, quantity: "5" }],
      });
      expect(r.status).toBe(201);
      ids.push(((await r.json()) as { id: string }).id);
    }
    // (CONFIRMAR el pedido de un compuesto no se asevera aquí: hoy responde 409 «quedan 0», porque
    // la reserva mira la existencia del compuesto, que no la lleva. Es un hallazgo abierto en R-92:
    // decidir si reserva sus ingredientes es del dueño. Un test que fijara ese 409 sería un antitest.)
    const [n] = await sql<{ movs: number; rastro: number }[]>`
      select (select count(*)::int from public.inventory_moves
               where company_id = ${CON.company}
                 and source_document_id = any(${ids}::uuid[])) as movs,
             (select count(*)::int from public.sale_line_components
               where company_id = ${CON.company} and document_id = any(${ids}::uuid[])) as rastro`;
    expect(n).toEqual({ movs: 0, rastro: 0 });
    expect(await posicion(CON, HARINA)).toEqual(antes.h);
    expect(await posicion(CON, PAN)).toEqual(antes.p);
    // Un borrador no es una venta: el invariante no lo señala por no haber sacado nada.
    await invariantesEnCero(CON);
  });

  it("receta FRACCIONARIA con conversión de unidad: 0,125 kg de un producto que se lleva en gramos", async () => {
    const rallado = await crearProducto(CON, "Queso rallado", 1, { unit_code: "gramo" });
    // 1.000 g por 33,33: promedio 0,03333 por gramo.
    await llegar(CON, rallado, "1000", "33.33");
    const cachapa = await compuesto(CON, "Cachapa con queso", 60, [
      { child_product_id: rallado, quantity: "0.125", unit_code: "kg" },
    ]);
    const venta = await vender(CON, [{ product_id: cachapa, quantity: "3" }]);
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;
    const rastro = await sql<Record<string, string>[]>`
      select c.quantity::text as q, c.functional_amount::text as v,
             c.recipe_quantity::text as receta, c.unit_factor::text as factor,
             m.quantity::text as mov_q, m.functional_amount::text as mov_v
        from public.sale_line_components c
        join public.inventory_moves m on m.id = c.move_id
       where c.company_id = ${CON.company} and c.document_id = ${doc}`;
    // 0,125 kg × 1.000 g/kg × 3 = 375 g; 375 × 0,03333 = 12,49875 → 12,50 al céntimo.
    expect(rastro).toEqual([
      {
        q: "375.00000000",
        v: "12.50000000",
        receta: "0.12500000",
        factor: "1000.00000000",
        mov_q: "-375.00000000",
        mov_v: "-12.50000000",
      },
    ]);
    expect(await posicion(CON, rallado)).toEqual({ q: "625.00000000", v: "20.83000000" });
    await invariantesEnCero(CON);
  });

  it("la RECEPCIÓN DE COMPRA de un producto con lote pide el lote y la fecha, con el nombre del producto", async () => {
    const yogur = await crearProducto(CON, "Yogur griego", 30, { tracks_lots: true });
    const [prov] = await sql<{ id: string }[]>`
      insert into public.suppliers (tenant_id, company_id, legal_name, supplier_kind)
      values (${CON.tenant}, ${CON.company}, ${`Lácteos ${RUN}`}, 'extranjero') returning id`;
    const recibir = (linea: Record<string, unknown>) =>
      pedir(CON, "POST", "/v1/goods-receipts", {
        company_id: CON.company,
        supplier_id: prov!.id,
        warehouse_id: CON.w1,
        currency: "VES",
        lines: [{ product_id: yogur, quantity: "6", unit_price: "10", ...linea }],
      });

    const sinLote = await recibir({});
    expect(sinLote.status).toBe(422);
    const m1 = ((await sinLote.json()) as { message: string }).message;
    expect(m1).toContain("Yogur griego");
    expect(m1).toContain("lleva lote y vencimiento");

    const sinFecha = await recibir({ lot_code: `COMPRA-${RUN}` });
    expect(sinFecha.status).toBe(422);
    const m2 = ((await sinFecha.json()) as { message: string }).message;
    expect(m2).toContain("Yogur griego");
    expect(m2).toContain("falta la fecha en que vence");

    // Nada quedó a medias: ni lote, ni recepción, ni existencia.
    const [n] = await sql<{ lotes: number; recepciones: number }[]>`
      select (select count(*)::int from public.lots where product_id = ${yogur}) as lotes,
             (select count(*)::int from public.goods_receipts
               where company_id = ${CON.company}) as recepciones`;
    expect(n).toEqual({ lotes: 0, recepciones: 0 });
    expect(await posicion(CON, yogur)).toEqual({ q: "0", v: "0" });

    const bien = await recibir({ lot_code: `COMPRA-${RUN}`, lot_expires_at: diaCaracas(20) });
    expect(bien.status).toBe(201);
    const [lote] = await sql<{ code: string; vence: string }[]>`
      select code, expires_at::text as vence from public.lots where product_id = ${yogur}`;
    expect(lote).toEqual({ code: `COMPRA-${RUN}`, vence: diaCaracas(20) });
    expect((await posicion(CON, yogur)).q).toBe("6.00000000");
  });

  it("ANULAR una venta DESPUÉS de una devolución parcial se rechaza (repondría dos veces lo devuelto); el resto se devuelve y el kardex queda en cero", async () => {
    const antes = { h: await posicion(CON, HARINA), p: await posicion(CON, PAN) };
    // La venta lleva el compuesto y pan SUELTO: el defecto era de toda venta, no solo del compuesto.
    const venta = await vender(CON, [
      { product_id: AREPA, quantity: "4" },
      { product_id: PAN, quantity: "2" },
    ]);
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;
    const lineas = await sql<{ id: string; product_id: string }[]>`
      select id, product_id from public.document_lines where document_id = ${doc}`;
    const lineaArepa = lineas.find((l) => l.product_id === AREPA)!.id;
    const lineaPan = lineas.find((l) => l.product_id === PAN)!.id;
    const dev1 = await devolver(CON, doc, lineaArepa, "1");
    const dev2 = await devolver(CON, doc, lineaPan, "1");
    const trasDevolver = { h: await posicion(CON, HARINA), p: await posicion(CON, PAN) };
    await invariantesEnCero(CON);

    const anulada = await pedir(CON, "POST", `/v1/invoices/${doc}/annul`, {
      company_id: CON.company,
      reason: "Se cobró el plato equivocado",
      originals_in_hand: true,
    });
    // En HEAD: 200, y la harina y el pan devueltos entraban OTRA vez (29,5 donde había 29).
    expect(anulada.status).toBe(422);
    expect(((await anulada.json()) as { message: string }).message).toContain(
      "ya tiene una devolución registrada y no se anula",
    );
    expect(await posicion(CON, HARINA)).toEqual(trasDevolver.h);
    expect(await posicion(CON, PAN)).toEqual(trasDevolver.p);
    const [estado] = await sql<{ status: string }[]>`
      select status from public.documents where id = ${doc}`;
    expect(estado!.status).toBe("issued");

    // El camino que queda: devolver el resto. Lo que salió volvió entero, ni de más ni de menos.
    const dev3 = await devolver(CON, doc, lineaArepa, "3");
    const dev4 = await devolver(CON, doc, lineaPan, "1");
    const [neto] = await sql<{ q: string; v: string }[]>`
      select sum(m.quantity)::text as q, sum(m.functional_amount)::text as v
        from public.inventory_moves m
       where m.company_id = ${CON.company}
         and m.source_document_id in (${doc}, ${dev1}, ${dev2}, ${dev3}, ${dev4})`;
    expect(neto).toEqual({ q: "0.00000000", v: "0.00000000" });
    expect((await posicion(CON, HARINA)).q).toBe(antes.h.q);
    expect((await posicion(CON, PAN)).q).toBe(antes.p.q);
    await invariantesEnCero(CON);
  });

  // ── Tercera ronda ─────────────────────────────────────────────────────────
  /** Una devolución que se queda en BORRADOR (sin confirmar). */
  async function borradorDeDevolucion(doc: string, linea: string, cantidad: string) {
    const b = await pedir(CON, "POST", "/v1/returns", {
      company_id: CON.company,
      source_document_id: doc,
      warehouse_id: CON.w1,
      reason: "El cliente iba a devolver",
      lines: [{ source_line_id: linea, quantity: cantidad }],
    });
    expect(b.status).toBe(201);
    return ((await b.json()) as { id: string }).id;
  }
  const anular = (doc: string) =>
    pedir(CON, "POST", `/v1/invoices/${doc}/annul`, {
      company_id: CON.company,
      reason: "Se cobró el plato equivocado",
      originals_in_hand: true,
    });

  it("devolución en BORRADOR → anular la venta → confirmar la devolución: la confirmación se rechaza y nada entra dos veces (línea suelta y compuesto)", async () => {
    const antes = { h: await posicion(CON, HARINA), p: await posicion(CON, PAN) };
    const venta = await vender(CON, [
      { product_id: AREPA, quantity: "2" },
      { product_id: PAN, quantity: "3" },
    ]);
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;
    const lineas = await sql<{ id: string; product_id: string }[]>`
      select id, product_id from public.document_lines where document_id = ${doc}`;
    const devArepa = await borradorDeDevolucion(
      doc,
      lineas.find((l) => l.product_id === AREPA)!.id,
      "1",
    );
    const devPan = await borradorDeDevolucion(
      doc,
      lineas.find((l) => l.product_id === PAN)!.id,
      "2",
    );

    // Con las devoluciones en borrador la venta se anula, y repone TODO lo que salió.
    expect((await anular(doc)).status).toBe(200);
    expect(await posicion(CON, HARINA)).toEqual(antes.h);
    expect(await posicion(CON, PAN)).toEqual(antes.p);

    // Confirmar ahora reingresaría otra vez lo que la anulación ya repuso.
    for (const dev of [devArepa, devPan]) {
      const r = await pedir(CON, "POST", `/v1/returns/${dev}/confirm`, {});
      expect(r.status).toBe(422);
      expect(((await r.json()) as { message: string }).message).toContain(
        "Esa venta se anuló: la devolución ya no se puede confirmar",
      );
    }
    expect(await posicion(CON, HARINA)).toEqual(antes.h);
    expect(await posicion(CON, PAN)).toEqual(antes.p);
    const [n] = await sql<{ entradas: number; confirmadas: number; rastro: number }[]>`
      select (select count(*)::int from public.inventory_moves
               where company_id = ${CON.company}
                 and source_document_id in (${devArepa}, ${devPan})) as entradas,
             (select count(*)::int from public.returns
               where id in (${devArepa}, ${devPan}) and status = 'confirmed') as confirmadas,
             (select count(*)::int from public.sale_line_components
               where company_id = ${CON.company} and return_id in (${devArepa}, ${devPan}))
               as rastro`;
    expect(n).toEqual({ entradas: 0, confirmadas: 0, rastro: 0 });
    await invariantesEnCero(CON);
  });

  it("anular y confirmar la devolución A LA VEZ: gana uno solo, y el kardex es el del que ganó", async () => {
    const antes = await posicion(CON, PAN);
    const venta = await vender(CON, [{ product_id: PAN, quantity: "4" }]);
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;
    const [linea] = await sql<{ id: string }[]>`
      select id from public.document_lines where document_id = ${doc}`;
    const dev = await borradorDeDevolucion(doc, linea!.id, "1");

    const [a, c] = await Promise.all([
      anular(doc),
      pedir(CON, "POST", `/v1/returns/${dev}/confirm`, {}),
    ]);
    expect([a.status, c.status].sort()).toEqual([200, 422]);
    const [esperado] = await sql<{ q: string }[]>`
      select (${antes.q}::numeric - ${a.status === 200 ? 0 : 3})::text as q`;
    // Ganó la anulación: volvió todo (4). Ganó la devolución: volvió 1 y la venta sigue viva.
    expect((await posicion(CON, PAN)).q).toBe(esperado!.q);
    const [estado] = await sql<{ venta: string; devolucion: string }[]>`
      select (select status from public.documents where id = ${doc}) as venta,
             (select status from public.returns where id = ${dev}) as devolucion`;
    expect(estado).toEqual(
      a.status === 200
        ? { venta: "annulled", devolucion: "draft" }
        : { venta: "issued", devolucion: "confirmed" },
    );
    await invariantesEnCero(CON);
  });

  it("CONFIRMAR un pedido con un compuesto y una línea suelta: la suelta reserva, el compuesto no (su existencia se comprueba al facturar)", async () => {
    const disponible = async (producto: string) => {
      const [d] = await sql<{ on_hand: string; available: string }[]>`
        select on_hand::text as on_hand, available::text as available
          from platform.available_stock(${CON.company}, ${CON.w1}, ${producto}, null)`;
      return d!;
    };
    const antes = { h: await disponible(HARINA), p: await disponible(PAN) };
    const pedido = await pedir(CON, "POST", "/v1/orders", {
      company_id: CON.company,
      customer_id: CON.cliente,
      lines: [
        { product_id: AREPA, quantity: "2" },
        { product_id: PAN, quantity: "3" },
      ],
    });
    expect(pedido.status).toBe(201);
    const id = ((await pedido.json()) as { id: string }).id;
    const confirmado = await pedir(CON, "POST", `/v1/orders/${id}/confirm`, {
      company_id: CON.company,
      warehouse_id: CON.w1,
    });
    // Antes: 409 «quedan 0 y el pedido exige 2» (la reserva miraba la existencia del compuesto).
    expect(confirmado.status).toBe(200);
    expect(((await confirmado.json()) as { status: string }).status).toBe("confirmed");

    const reservas = await sql<{ product_id: string; q: string; status: string }[]>`
      select product_id, quantity::text as q, status from public.stock_reservations
       where company_id = ${CON.company} and document_id = ${id}`;
    expect(reservas).toEqual([{ product_id: PAN, q: "3.00000000", status: "active" }]);
    // El pan suelto quedó comprometido; los ingredientes del compuesto, no (ni harina ni más pan).
    const despues = { h: await disponible(HARINA), p: await disponible(PAN) };
    expect(despues.h).toEqual(antes.h);
    expect(despues.p.on_hand).toBe(antes.p.on_hand);
    const [baja] = await sql<{ q: string }[]>`
      select (${antes.p.available}::numeric - ${despues.p.available}::numeric)::text as q`;
    expect(baja!.q).toBe("3.00000000");
    // Reservar no es despachar: el kardex no se movió y el pedido no deja rastro de ingredientes.
    const [n] = await sql<{ movs: number; rastro: number }[]>`
      select (select count(*)::int from public.inventory_moves
               where company_id = ${CON.company} and source_document_id = ${id}) as movs,
             (select count(*)::int from public.sale_line_components
               where company_id = ${CON.company} and document_id = ${id}) as rastro`;
    expect(n).toEqual({ movs: 0, rastro: 0 });
    await invariantesEnCero(CON);
  });
});

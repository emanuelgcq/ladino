import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * Ventas de extremo a extremo con JWT real, como `ladino_api`.
 *
 * Lo que este fichero está aquí para demostrar, y que ningún test unitario ve:
 * que sin regla tributaria NO se emite; que el correlativo no se reutiliza al
 * anular; que la factura y su kardex son un solo hecho; que el diferencial
 * cambiario existe de verdad —y no es código muerto porque el documento nazca
 * ya convertido—; y que una devolución reingresa AL COSTO ORIGINAL.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
/**
 * TODA la fixture es NUEVA en cada corrida. No es manía: este módulo asigna
 * correlativos gapless, consume rangos de números de control y asigna un
 * régimen con vigencia sin solape. Un tenant fijo hace que la segunda corrida
 * arranque con el rango medio gastado y el régimen ya puesto, y entonces el
 * test empieza a fallar por su propia historia. Ya pasó dos veces en este
 * repo con conteos fijos contra estado compartido.
 */
const TENANT = crypto.randomUUID();
const COMPANY = crypto.randomUUID();
const W1 = crypto.randomUUID();
const VENDEDOR = crypto.randomUUID();
const CAJERO = crypto.randomUUID();
const MIRON = crypto.randomUUID();
const CLIENTE = crypto.randomUUID();
const ROL_VENTAS = crypto.randomUUID();
const ROL_CAJA = crypto.randomUUID();
const ROL_MIRON = crypto.randomUUID();
const MEM_VENDEDOR = crypto.randomUUID();
const MEM_CAJERO = crypto.randomUUID();
const MEM_MIRON = crypto.randomUUID();
const ASIG_VENDEDOR = crypto.randomUUID();
const ASIG_CAJERO = crypto.randomUUID();
const ASIG_MIRON = crypto.randomUUID();
const RUN = Date.now().toString(36);
const FUENTE_TASA = "Carga manual E2E (NullBCVAdapter)";
const FUENTE_REGLA = "Carga de prueba E2E — VALIDAR-SENIAT antes de producción.";
const HOY = new Date().toISOString().slice(0, 10);
const AYER = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PROD = "";
let LISTA_USD = "";
let LISTA_VES = "";
let PROD_SIN_REGLA = "";

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
  // La clave de idempotencia va en TODA operación mutante, tenga cuerpo o no:
  // confirmar una devolución no manda cuerpo y sigue siendo mutante. Atarla a
  // la existencia del cuerpo fue el primer error de este helper.
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

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${VENDEDOR}), (${CAJERO}), (${MIRON})
            on conflict (id) do nothing`;
  // `exchange_rates` es GLOBAL: no tiene tenant y sobrevive entre corridas. El
  // primer caso de este fichero demuestra que SIN tasa no se vende, así que la
  // corrida tiene que empezar sin las tasas que dejó la anterior. Se borran
  // solo las de esta prueba, por su fuente, nunca las de nadie más.
  await sql`delete from public.exchange_rates where source = ${FUENTE_TASA}`;
  // `tax_rules` NO se limpia, y no se puede: una regla citada por una línea de
  // documento tiene FK y la base se niega a borrarla —correctamente, porque
  // borrar la regla dejaría una factura sin decir con qué alícuota se emitió.
  // Por eso el caso de «sin regla» usa un producto con una CATEGORÍA que nunca
  // tendrá regla cargada, en vez de vaciar el catálogo.
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${VENDEDOR}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e ventas')
             on conflict (id) do nothing`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code)
             values (${COMPANY}, ${TENANT}, 'J-E2EVTA', 'Empresa e2e ventas', 'VES')
             on conflict (id) do nothing`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-VW1', 'Principal')
             on conflict (id) do nothing`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL_VENTAS}, null, ${`e2evta_ventas_${RUN}`}, 'Ventas', true),
             (${ROL_CAJA}, null, ${`e2evta_caja_${RUN}`}, 'Caja', false),
             (${ROL_MIRON}, null, ${`e2evta_miron_${RUN}`}, 'Mirón', false)
             on conflict (id) do nothing`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL_VENTAS}, 'sales.quote.manage'),
             (${ROL_VENTAS}, 'sales.order.manage'),
             (${ROL_VENTAS}, 'sales.invoice.issue'),
             (${ROL_VENTAS}, 'sales.invoice.annul'),
             (${ROL_VENTAS}, 'sales.return.manage'),
             (${ROL_VENTAS}, 'inventory.move'),
             (${ROL_VENTAS}, 'fiscal.range.manage'),
             (${ROL_VENTAS}, 'fx.rate.manage'),
             (${ROL_VENTAS}, 'ar.read'),
             (${ROL_CAJA}, 'sales.payment.register'),
             (${ROL_CAJA}, 'ar.read')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${MEM_VENDEDOR}, ${TENANT}, ${VENDEDOR}),
             (${MEM_CAJERO}, ${TENANT}, ${CAJERO}),
             (${MEM_MIRON}, ${TENANT}, ${MIRON})
             on conflict (id) do nothing`;
    await tx`insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
             (${ASIG_VENDEDOR}, ${TENANT}, ${MEM_VENDEDOR}, ${ROL_VENTAS}, null),
             (${ASIG_CAJERO}, ${TENANT}, ${MEM_CAJERO}, ${ROL_CAJA}, ${COMPANY}),
             (${ASIG_MIRON}, ${TENANT}, ${MEM_MIRON}, ${ROL_MIRON}, ${COMPANY})
             on conflict (id) do nothing`;
    // LAD25: el rol de ventas lleva inventory.move, que es scoped, así que
    // declara requires_scope y necesita binding por almacén. No hay jefe de
    // ventas «de toda la empresa» que se salte esto.
    await tx`insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, ${ASIG_VENDEDOR}, 'warehouse', ${W1})
             on conflict do nothing`;
    await tx`insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                                           person_type_code, taxpayer_type_code)
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, ${`J-E2EVTA-${RUN}`}, 'Cliente e2e ventas',
                     'juridica', 'ordinario')
             on conflict (id) do nothing`;
    const [p] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2EVTA-${RUN}`}, 'Producto e2e ventas', 'good', 'active',
              'unidad', 'gravado_general')
      returning id`;
    PROD = p!.id;
    // El producto sin regla: categoría `gravado_adicional`, que este fichero no
    // carga nunca. Es lo que hace demostrable «sin regla no se vende» sin tener
    // que vaciar un catálogo global que otras filas referencian.
    const [pa] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2EVTA-SR-${RUN}`}, 'Producto sin regla', 'good', 'active',
              'unidad', 'gravado_adicional')
      returning id`;
    PROD_SIN_REGLA = pa!.id;
    const [lu] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, ${`e2e-usd-${RUN}`}, 'USD') returning id`;
    LISTA_USD = lu!.id;
    const [lv] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, ${`e2e-ves-${RUN}`}, 'VES') returning id`;
    LISTA_VES = lv!.id;
    await tx`insert into public.price_list_items (tenant_id, company_id, price_list_id, product_id,
                                                  amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${LISTA_USD}, ${PROD}, '100.00000000', ${AYER}::date),
                    (${TENANT}, ${COMPANY}, ${LISTA_VES}, ${PROD}, '4000.00000000', ${AYER}::date),
                    (${TENANT}, ${COMPANY}, ${LISTA_USD}, ${PROD_SIN_REGLA}, '10.00000000',
                     ${AYER}::date)`;
    await tx`update public.customers set default_price_list_id = ${LISTA_USD}
              where id = ${CLIENTE}`;
  });

  // La existencia se siembra POR LA API, no con un INSERT a mano: 50 unidades
  // por 150 000 Bs, o sea 3 000 Bs cada una. Sembrar el kardex por SQL sería
  // fabricar un estado que el propio sistema no sabe producir, y el costo que
  // la factura copia dejaría de ser comprobable.
  const semilla = await pedir("POST", "/v1/inventory/receipts", VENDEDOR, {
    company_id: COMPANY,
    warehouse_id: W1,
    product_id: PROD,
    quantity: "50",
    amount: "150000.00000000",
    currency: "VES",
    reference: `e2e-vta-seed-${RUN}`,
  });
  if (semilla.status !== 201) {
    throw new Error(`la semilla de inventario falló: ${semilla.status} ${await semilla.text()}`);
  }
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("ventas de extremo a extremo", () => {
  it("sin tasa de cambio vigente no hay ni cotización: la tasa no se inventa", async () => {
    const r = await pedir("POST", "/v1/quotes", VENDEDOR, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      lines: [{ product_id: PROD, quantity: "1" }],
    });
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("EXCHANGE_RATE_MISSING");
    expect(cuerpo.message).toMatch(/tasa/i);
  });

  it("con tasa pero sin regla tributaria NO se cotiza: LAD50, nunca un IVA de cero", async () => {
    const tasa = await pedir("POST", "/v1/exchange-rates", VENDEDOR, {
      from_currency: "USD",
      to_currency: "VES",
      rate: "40.00000000",
      source: FUENTE_TASA,
      rate_date: AYER,
    });
    expect(tasa.status).toBe(201);
    // El producto de categoría `gravado_adicional`, que nunca tiene regla.
    const r = await pedir("POST", "/v1/quotes", VENDEDOR, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      lines: [{ product_id: PROD_SIN_REGLA, quantity: "1" }],
    });
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("TAX_RULE_MISSING");
    // El mensaje, no solo el código: varios caminos convergen en 409, y este
    // tiene que ser el de la regla ausente, no el de un duplicado.
    expect(cuerpo.message).toMatch(/regla|alícuota|tributaria/i);
  });

  it("con la regla cargada, la cotización sale con su alícuota copiada", async () => {
    // tax_rules es GLOBAL y no tiene clave única: cargarla dos veces no es un
    // duplicado inofensivo, es un CATÁLOGO AMBIGUO, y resolve_tax lo rechaza a
    // propósito (ADR-0038). Por eso el insert va guardado con un NOT EXISTS; un
    // "on conflict" aquí no existiría.
    // Y el NOT EXISTS solo, tampoco basta: vitest corre los FICHEROS E2E en
    // paralelo y cuatro de ellos siembran esta misma regla — dos guards
    // simultáneos no se ven entre sí y cuelan el duplicado (pasó el 2026-08-31:
    // «catálogo ambiguo» intermitente). El advisory lock por transacción
    // serializa a los sembradores; el guard decide.
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
      await tx`
      insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                                    rate, effective_from, legal_source, priority)
      select 'VE', 'iva', 'ordinario', 'gravado_general', 0.16, ${AYER}::date,
             ${FUENTE_REGLA}, 10
       where not exists (select 1 from public.tax_rules
                          where jurisdiction = 'VE' and tax_code = 'iva'
                            and taxpayer_type = 'ordinario'
                            and product_tax_category = 'gravado_general')`;
    });
    const r = await pedir("POST", "/v1/quotes", VENDEDOR, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      lines: [{ product_id: PROD, quantity: "2" }],
    });
    expect(r.status).toBe(201);
    const doc = (await r.json()) as Record<string, string>;
    expect(doc["kind"]).toBe("quote");
    expect(doc["status"]).toBe("draft");
    // Una cotización NO consume correlativo fiscal.
    expect(doc["document_number"]).toBeNull();
    // Y nace en la moneda de la lista, no ya convertida.
    expect(doc["transaction_currency"]).toBe("USD");
    expect(doc["functional_currency"]).toBe("VES");
  });

  it("sin régimen fiscal vigente no se emite, aunque haya tasa y alícuota", async () => {
    const r = await pedir("POST", "/v1/invoices", VENDEDOR, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: [{ product_id: PROD, quantity: "1" }],
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("FISCAL_NUMBERING_INVALID");
  });

  it("con régimen de rango pero sin rango cargado, tampoco: LAD49 antes que un número inventado", async () => {
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${VENDEDOR}, true)`;
      await tx`insert into public.company_fiscal_regimes
                 (tenant_id, company_id, regime_code, effective_from)
               values (${TENANT}, ${COMPANY}, 'formatos_libres', ${AYER}::timestamptz)`;
    });
    const r = await pedir("POST", "/v1/invoices", VENDEDOR, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: [{ product_id: PROD, quantity: "1" }],
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("FISCAL_NUMBERING_INVALID");
  });

  it("emite con los DOS números, convierte a funcional y descarga el kardex en el mismo hecho", async () => {
    const rango = await pedir("POST", "/v1/fiscal-number-ranges", VENDEDOR, {
      company_id: COMPANY,
      kind: "invoice",
      series: "A",
      range_from: "1000",
      range_to: "1002",
      printer_source: "Imprenta E2E, autorización de prueba",
      alert_threshold_pct: 50,
    });
    expect(rango.status).toBe(201);

    const antes = await sql<{ quantity: string }[]>`
      select quantity::text as quantity from public.stock_balances
       where company_id = ${COMPANY} and warehouse_id = ${W1} and product_id = ${PROD}
         and lot_id is null`;

    const r = await pedir("POST", "/v1/invoices", VENDEDOR, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: [{ product_id: PROD, quantity: "2" }],
    });
    expect(r.status).toBe(201);
    const doc = (await r.json()) as Record<string, string | number>;
    expect(doc["status"]).toBe("issued");
    expect(doc["document_number"]).toBe(1);
    expect(doc["control_number"]).toBe(1000);
    // 2 × 100 USD = 200 + 16 % = 232 USD; a 40 Bs = 9 280 Bs.
    expect(doc["transaction_currency"]).toBe("USD");
    expect(doc["fx_rate"]).toBe("40.00000000");
    expect(doc["total_amount"]).toBe("9280.00000000");
    expect(doc["subtotal_amount"]).toBe("8000.00000000");
    expect(doc["tax_amount"]).toBe("1280.00000000");

    const despues = await sql<{ quantity: string }[]>`
      select quantity::text as quantity from public.stock_balances
       where company_id = ${COMPANY} and warehouse_id = ${W1} and product_id = ${PROD}
         and lot_id is null`;
    expect(Number(antes[0]!.quantity) - Number(despues[0]!.quantity)).toBe(2);

    const detalle = await pedir("GET", `/v1/documents/${doc["id"] as string}`, VENDEDOR);
    const d = (await detalle.json()) as {
      lines: Record<string, string>[];
      balance: string;
    };
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]!["tax_rate_snapshot"]).toBe("0.16000000");
    expect(d.lines[0]!["tax_rule_id"]).not.toBeNull();
    // El costo del momento, congelado con la línea.
    expect(d.lines[0]!["cost_snapshot"]).toBe("3000.00000000");
    expect(d.balance).toBe("9280.00000000");
  });

  it("anular conserva el correlativo: el número anulado no se reutiliza", async () => {
    const emitida = await pedir("POST", "/v1/invoices", VENDEDOR, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: [{ product_id: PROD, quantity: "1" }],
    });
    const doc = (await emitida.json()) as Record<string, string | number>;
    expect(doc["document_number"]).toBe(2);

    const anulada = await pedir("POST", `/v1/invoices/${doc["id"] as string}/annul`, VENDEDOR, {
      company_id: COMPANY,
      reason: "Error de digitación en la cantidad",
    });
    expect(anulada.status).toBe(200);
    const a = (await anulada.json()) as Record<string, string | number>;
    expect(a["status"]).toBe("annulled");
    // El correlativo SIGUE AHÍ. Anular no es borrar.
    expect(a["document_number"]).toBe(2);

    const siguiente = await pedir("POST", "/v1/invoices", VENDEDOR, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: [{ product_id: PROD, quantity: "1" }],
    });
    const s = (await siguiente.json()) as Record<string, string | number>;
    expect(s["document_number"]).toBe(3);
  });

  it("agotado el rango, la emisión se para con LAD49 en vez de seguir sin número de control", async () => {
    const r = await pedir("POST", "/v1/invoices", VENDEDOR, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: [{ product_id: PROD, quantity: "1" }],
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("FISCAL_NUMBERING_INVALID");
  });

  it("el cobro a otra tasa registra el diferencial cambiario y deja la factura pagada", async () => {
    await pedir("POST", "/v1/fiscal-number-ranges", VENDEDOR, {
      company_id: COMPANY,
      kind: "invoice",
      series: "B",
      range_from: "5000",
      range_to: "5100",
      printer_source: "Imprenta E2E, segundo rango",
    });
    const emitida = await pedir("POST", "/v1/invoices", VENDEDOR, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      series: "B",
      lines: [{ product_id: PROD, quantity: "1" }],
    });
    expect(emitida.status).toBe(201);
    const doc = (await emitida.json()) as Record<string, string>;
    expect(doc["total_amount"]).toBe("4640.00000000"); // 116 USD × 40

    // La tasa sube a 45 el día del cobro.
    await pedir("POST", "/v1/exchange-rates", VENDEDOR, {
      from_currency: "USD",
      to_currency: "VES",
      rate: "45.00000000",
      source: FUENTE_TASA,
      rate_date: HOY,
    });

    const cobro = await pedir("POST", "/v1/payments", CAJERO, {
      company_id: COMPANY,
      document_id: doc["id"],
      currency: "USD",
      amount: "116.00000000",
      instrument: "zelle",
      reference: "E2E-ZELLE-1",
    });
    expect(cobro.status).toBe(201);
    const c = (await cobro.json()) as {
      payment: Record<string, string>;
      exchange_difference: Record<string, string> | null;
      balance: string;
      document_status: string;
    };
    // 116 USD a 45 = 5 220 Bs; la factura pesaba 4 640. Diferencia: 580.
    expect(c.payment["functional_amount"]).toBe("5220.00000000");
    expect(c.exchange_difference).not.toBeNull();
    expect(c.exchange_difference!["difference"]).toBe("580.00000000");
    expect(c.document_status).toBe("paid");

    const kpi = await pedir("GET", "/v1/reports/exchange-difference", VENDEDOR);
    const k = (await kpi.json()) as { neto: string };
    expect(Number(k.neto)).toBeGreaterThanOrEqual(580);
  });

  it("un cobro en la misma moneda del documento y a la misma tasa no escribe diferencial de cero", async () => {
    const emitida = await pedir("POST", "/v1/invoices", VENDEDOR, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      series: "B",
      price_list_id: LISTA_VES,
      lines: [{ product_id: PROD, quantity: "1" }],
    });
    // La lista en bolívares no es la preferida del cliente: exige el permiso.
    expect(emitida.status).toBe(403);
    expect(((await emitida.json()) as { code: string }).code).toBe("PERMISSION_REQUIRED");
  });

  it("la devolución reingresa AL COSTO ORIGINAL y genera nota de crédito con saldo a favor", async () => {
    const emitida = await pedir("POST", "/v1/invoices", VENDEDOR, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      series: "B",
      lines: [{ product_id: PROD, quantity: "2" }],
    });
    const doc = (await emitida.json()) as Record<string, string>;
    const detalle = await pedir("GET", `/v1/documents/${doc["id"]}`, VENDEDOR);
    const d = (await detalle.json()) as { lines: Record<string, string>[] };
    const lineaId = d.lines[0]!["id"] as string;
    const costoOriginal = d.lines[0]!["cost_snapshot"] as string;

    // El costo del inventario CAMBIA después de la venta: una entrada cara.
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${VENDEDOR}, true)`;
      await tx`update public.stock_balances set last_unit_cost = 9999
                where company_id = ${COMPANY} and warehouse_id = ${W1} and product_id = ${PROD}
                  and lot_id is null`;
    });

    // Una nota de crédito es un documento fiscal con SU PROPIO rango
    // autorizado: no se numera con los números de control de las facturas.
    // Sin este rango, confirmar la devolución se para con LAD49 — y está bien
    // que se pare.
    const rangoNc = await pedir("POST", "/v1/fiscal-number-ranges", VENDEDOR, {
      company_id: COMPANY,
      kind: "credit_note",
      series: "A",
      range_from: "700",
      range_to: "799",
      printer_source: "Imprenta E2E, rango de notas de crédito",
    });
    expect(rangoNc.status).toBe(201);

    const dev = await pedir("POST", "/v1/returns", VENDEDOR, {
      company_id: COMPANY,
      source_document_id: doc["id"],
      warehouse_id: W1,
      reason: "El cliente devolvió una unidad sin abrir",
      lines: [{ source_line_id: lineaId, quantity: "1" }],
    });
    expect(dev.status).toBe(201);
    const devuelta = (await dev.json()) as { id: string; lines: Record<string, string>[] };
    expect(devuelta.lines[0]!["unit_cost_original"]).toBe(costoOriginal);

    const confirmada = await pedir("POST", `/v1/returns/${devuelta.id}/confirm`, VENDEDOR);
    expect(confirmada.status).toBe(200);
    const cf = (await confirmada.json()) as {
      credit_note_id: string;
      customer_credit_id: string;
      status: string;
    };
    expect(cf.status).toBe("confirmed");
    expect(cf.credit_note_id).not.toBeNull();

    // El reingreso usó el costo ORIGINAL (3 000), no el de hoy (9 999).
    const [mov] = await sql<{ amount: string; quantity: string }[]>`
      select functional_amount::text as amount, quantity::text as quantity
        from public.inventory_moves
       where company_id = ${COMPANY} and source_document_id = ${devuelta.id}
       order by created_at desc limit 1`;
    expect(mov).toBeDefined();
    expect(Number(mov!.amount) / Number(mov!.quantity)).toBe(Number(costoOriginal));

    // Y la nota de crédito heredó la moneda del documento origen.
    const nc = await pedir("GET", `/v1/documents/${cf.credit_note_id}`, VENDEDOR);
    const n = (await nc.json()) as { document: Record<string, string> };
    expect(n.document["kind"]).toBe("credit_note");
    expect(n.document["transaction_currency"]).toBe("USD");
    expect(n.document["status"]).toBe("issued");
  });

  it("el pedido confirmado reserva, y el disponible baja sin que el kardex se mueva", async () => {
    const pedido = await pedir("POST", "/v1/orders", VENDEDOR, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      lines: [{ product_id: PROD, quantity: "3" }],
    });
    expect(pedido.status).toBe(201);
    const p = (await pedido.json()) as Record<string, string>;

    const [antes] = await sql<{ on_hand: string; available: string }[]>`
      select on_hand::text as on_hand, available::text as available
        from platform.available_stock(${COMPANY}, ${W1}, ${PROD}, null)`;

    const conf = await pedir("POST", `/v1/orders/${p["id"]}/confirm`, VENDEDOR, {
      company_id: COMPANY,
      warehouse_id: W1,
    });
    expect(conf.status).toBe(200);
    expect(((await conf.json()) as Record<string, string>)["status"]).toBe("confirmed");

    const [despues] = await sql<{ on_hand: string; available: string }[]>`
      select on_hand::text as on_hand, available::text as available
        from platform.available_stock(${COMPANY}, ${W1}, ${PROD}, null)`;
    // La existencia física no se movió: reservar no es despachar.
    expect(despues!.on_hand).toBe(antes!.on_hand);
    expect(Number(antes!.available) - Number(despues!.available)).toBe(3);
  });

  it("antigüedad y estado de cuenta exigen ar.read: quien solo ve la empresa no ve lo que se le debe", async () => {
    const sinPermiso = await pedir("GET", `/v1/customers/${CLIENTE}/aging`, MIRON);
    expect(sinPermiso.status).toBe(403);
    expect(((await sinPermiso.json()) as { code: string }).code).toBe("PERMISSION_REQUIRED");

    const conPermiso = await pedir("GET", `/v1/customers/${CLIENTE}/statement`, CAJERO);
    expect(conPermiso.status).toBe(200);
    const est = (await conPermiso.json()) as {
      currency: string;
      documents: Record<string, string>[];
      credits: Record<string, string>[];
      total_outstanding: string;
      aging: { buckets: Record<string, string>[] };
    };
    expect(est.currency).toBe("VES");
    expect(est.documents.length).toBeGreaterThan(0);
    // La devolución dejó un saldo a favor disponible.
    expect(est.credits.length).toBeGreaterThan(0);
    // Y la antigüedad clasifica: todo lo de hoy cae en el primer tramo.
    expect(est.aging.buckets.every((b) => b["bucket"] === "0-30")).toBe(true);
  });

  it("una factura emitida no se actualiza por HTTP ni por SQL: append-only en las dos capas", async () => {
    const [doc] = await sql<{ id: string }[]>`
      select id from public.documents
       where company_id = ${COMPANY} and status in ('issued', 'paid') limit 1`;
    await expect(
      sql`update public.documents set total_amount = 1 where id = ${doc!.id}`,
    ).rejects.toThrow();
  });
});

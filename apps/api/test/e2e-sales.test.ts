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
const CONSUMIDOR = crypto.randomUUID();
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
let LISTA_DETAL = "";
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
  // El primer caso del fichero exige empezar SIN tasas USD→VES, vengan de
  // donde vengan: otras suites, la demo local, confirmaciones «sigue igual».
  // Enumerar fuentes ajenas era una lista de perdones que fallaba con cada
  // fuente nueva (pasó dos veces el 2026-09-01); se barre el PAR entero. Con
  // `fileParallelism: false` nadie está insertando mientras esto borra, y la
  // demo se repone con `pnpm demo:seed`, igual que tras el db:reset del verify.
  await sql`delete from public.exchange_rates
             where from_currency = 'USD' and to_currency = 'VES'`;
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
             (${ROL_VENTAS}, 'customer.manage'),
             (${ROL_VENTAS}, 'company.settings.manage'),
             (${ROL_VENTAS}, 'sales.payment.register'),
             (${ROL_VENTAS}, 'treasury.read'),
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
    // El cliente de mostrador (migración 32): lo que createCompany haría. Las
    // ventas del POS sin cliente van contra él, con las reglas GENERALES.
    await tx`insert into public.customers (id, tenant_id, company_id, legal_name,
                                           person_type_code, taxpayer_type_code, is_system)
             values (${CONSUMIDOR}, ${TENANT}, ${COMPANY}, 'Consumidor final', 'natural',
                     'consumidor_final', true)
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
    // La lista «detal» que el POS resuelve SOLO para el Consumidor final.
    const [ld] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, 'detal', 'USD') returning id`;
    LISTA_DETAL = ld!.id;
    await tx`insert into public.price_list_items (tenant_id, company_id, price_list_id, product_id,
                                                  amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${LISTA_USD}, ${PROD}, '100.00000000', ${AYER}::date),
                    (${TENANT}, ${COMPANY}, ${LISTA_VES}, ${PROD}, '4000.00000000', ${AYER}::date),
                    (${TENANT}, ${COMPANY}, ${LISTA_DETAL}, ${PROD}, '100.00000000', ${AYER}::date),
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

    // Y el historial de precios, SIN tasa, dice «sin tasa»: rate null y
    // equivalentes null — nunca un cero que parezca precio.
    const precios = await pedir("GET", `/v1/price-lists/${LISTA_USD}/prices`, VENDEDOR);
    expect(precios.status).toBe(200);
    const historial = (await precios.json()) as {
      rate: unknown;
      items: { equivalent_amount: string | null }[];
    };
    expect(historial.rate).toBeNull();
    for (const item of historial.items) expect(item.equivalent_amount).toBeNull();
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
      // La regla GENERAL (taxpayer NULL, prioridad menor): la del Consumidor
      // final. La específica de arriba gana para los ordinarios por prioridad.
      await tx`
      insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                                    rate, effective_from, legal_source, priority, transaction_type)
      select 'VE', 'iva', null, 'gravado_general', 0.16, ${AYER}::date, ${FUENTE_REGLA}, 5, 'sale'
       where not exists (select 1 from public.tax_rules
                          where jurisdiction = 'VE' and tax_code = 'iva'
                            and taxpayer_type is null
                            and product_tax_category = 'gravado_general'
                            and transaction_type = 'sale')`;
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

    // ADR-0048: el dinero agregado nunca viene gratis con la membresía — el
    // mirón es miembro y aun así el KPI le responde 403.
    const sinPermiso = await pedir("GET", "/v1/reports/exchange-difference", MIRON);
    expect(sinPermiso.status).toBe(403);
    expect(((await sinPermiso.json()) as { code: string }).code).toBe("PERMISSION_REQUIRED");
  });

  it("GET /v1/me/permissions devuelve el conjunto EXACTO que autoriza cada operación (ADR-0048)", async () => {
    const r = await pedir("GET", "/v1/me/permissions", VENDEDOR);
    expect(r.status).toBe(200);
    const { permissions } = (await r.json()) as { permissions: string[] };
    // La lista viene de la MISMA resolución que ladino_user_has_permission:
    // contiene lo que el rol concede y nada de lo que no.
    expect(permissions).toContain("sales.invoice.issue");
    expect(permissions).toContain("treasury.read");
    expect(permissions).not.toContain("accounting.entry.create");

    const mironR = await pedir("GET", "/v1/me/permissions", MIRON);
    const miron = (await mironR.json()) as { permissions: string[] };
    expect(miron.permissions).not.toContain("treasury.read");
    expect(miron.permissions).not.toContain("sales.invoice.issue");
  });

  it("EL CASO DEL DUEÑO (ADR-0047): se fía en USD, se cobra en Bs a la tasa del día — nadie pierde margen", async () => {
    // AYER (tasa 40) se fía: 100 USD + 16% = 116 USD, que ayer eran 4 640 Bs.
    const emitida = await pedir("POST", "/v1/invoices", VENDEDOR, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      series: "B",
      issued_at: `${AYER}T12:00:00.000Z`,
      lines: [{ product_id: PROD, quantity: "1" }],
    });
    expect(emitida.status).toBe(201);
    const doc = (await emitida.json()) as Record<string, string>;
    expect(doc["transaction_currency"]).toBe("USD");
    expect(doc["fx_rate"]).toBe("40.00000000");

    // HOY la tasa es 45: la deuda del lunes, preguntada el viernes, vale
    // viernes — 116 USD × 45, no los 4 640 Bs congelados de ayer.
    const detalle = await pedir("GET", `/v1/documents/${doc["id"]}`, VENDEDOR);
    const d = (await detalle.json()) as { balance: string };
    expect(d.balance).toBe("5220.00000000");

    // Se cobra EN BOLÍVARES lo que la deuda vale hoy. El servidor valora los
    // 5 220 Bs a la tasa del día (116 USD), salda la deuda anclada, y los
    // 580 Bs de más que trajo la devaluación son GANANCIA cambiaria — no un
    // margen perdido ni un sobrepago.
    const cobro = await pedir("POST", "/v1/payments", CAJERO, {
      company_id: COMPANY,
      document_id: doc["id"],
      currency: "VES",
      amount: "5220.00000000",
      instrument: "efectivo_bs",
    });
    expect(cobro.status).toBe(201);
    const c = (await cobro.json()) as {
      payment: Record<string, string>;
      exchange_difference: Record<string, string> | null;
      balance: string;
      document_status: string;
    };
    expect(c.payment["functional_amount"]).toBe("5220.00000000");
    expect(c.exchange_difference).not.toBeNull();
    expect(c.exchange_difference!["amount_transaction"]).toBe("116.00000000");
    expect(c.exchange_difference!["difference"]).toBe("580.00000000");
    // Pagados los 116 USD completos, el documento queda PAGADO: quien decide
    // es el saldo en la moneda del documento, no el funcional congelado.
    expect(c.document_status).toBe("paid");
    expect(c.balance).toBe("-580.00000000");

    // Y la deuda de hoy dice cero.
    const despues = await pedir("GET", `/v1/documents/${doc["id"]}`, VENDEDOR);
    expect(((await despues.json()) as { balance: string }).balance).toBe("0.00000000");
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

  // ── EL PUNTO DE VENTA (Fase C) ────────────────────────────────────────────

  it("el POS cotiza el carrito sin escribir NADA: mostrador, lista «detal» y regla general", async () => {
    // La tasa de HOY quedó en 45 desde el test del diferencial (una por día).
    const [antes] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.documents where company_id = ${COMPANY}`;

    const r = await pedir("POST", "/v1/pos/quote", VENDEDOR, {
      company_id: COMPANY,
      lines: [{ product_id: PROD, quantity: "2" }],
    });
    expect(r.status).toBe(200);
    const q = (await r.json()) as Record<string, unknown>;
    // Sin cliente: el servidor resolvió al Consumidor final y la lista «detal».
    expect(q["customer_id"]).toBe(CONSUMIDOR);
    expect(q["price_list_id"]).toBe(LISTA_DETAL);
    // 2 × 100 USD + 16% (regla GENERAL: el consumidor final no es «ordinario»).
    expect(q["subtotal"]).toBe("200.00000000");
    expect(q["total"]).toBe("232.00000000");
    expect(q["currency"]).toBe("USD");
    expect(q["functional_total"]).toBe("10440.00000000"); // 232 × 45
    // ADR-0047: los DOS lados por línea y el pie completo en Bs, del servidor.
    expect(q["functional_subtotal"]).toBe("9000.00000000");
    expect(q["functional_tax_amount"]).toBe("1440.00000000");
    const lineasQ = q["lines"] as Record<string, string>[];
    expect(lineasQ[0]!["functional_unit_price"]).toBe("4500.00000000");
    expect(lineasQ[0]!["functional_total"]).toBe("10440.00000000");

    const [despues] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.documents where company_id = ${COMPANY}`;
    expect(despues!.n).toBe(antes!.n);
  });

  it("el historial de precios trae el equivalente EN LA OTRA MONEDA, del servidor y con la tasa citada", async () => {
    // La tasa de HOY es 45 (la dejó el test del diferencial). USD → ×45; VES → ÷45.
    const usd = (await (
      await pedir("GET", `/v1/price-lists/${LISTA_USD}/prices?product_id=${PROD}`, VENDEDOR)
    ).json()) as {
      rate: { rate: string; source: string; rate_date: string } | null;
      items: {
        amount: string;
        equivalent_amount: string | null;
        equivalent_currency: string | null;
      }[];
    };
    expect(usd.rate).not.toBeNull();
    expect(usd.rate!.rate).toBe("45.00000000");
    expect(usd.items[0]!.amount).toBe("100.00000000");
    expect(usd.items[0]!.equivalent_amount).toBe("4500.00000000");
    expect(usd.items[0]!.equivalent_currency).toBe("VES");

    const ves = (await (
      await pedir("GET", `/v1/price-lists/${LISTA_VES}/prices?product_id=${PROD}`, VENDEDOR)
    ).json()) as {
      items: {
        amount: string;
        equivalent_amount: string | null;
        equivalent_currency: string | null;
      }[];
    };
    expect(ves.items[0]!.amount).toBe("4000.00000000");
    // 4000 / 45 en numeric(…,8): división del SERVIDOR, jamás del cliente.
    expect(ves.items[0]!.equivalent_amount).toBe("88.88888889");
    expect(ves.items[0]!.equivalent_currency).toBe("USD");
  });

  it("«Hacer predeterminada» cambia lo que la caja aplica a un cliente sin preferida", async () => {
    // El listado marca la default EFECTIVA (hoy, la heurística: LISTA_DETAL
    // se llama «detal…»).
    const antes = (await (await pedir("GET", "/v1/price-lists", VENDEDOR)).json()) as {
      id: string;
      is_caja_default: boolean;
    }[];
    expect(antes.find((l) => l.is_caja_default)?.id).toBe(LISTA_DETAL);

    // El dueño apunta la caja a la lista VES (permiso company.settings.manage).
    const cambio = await pedir("PUT", "/v1/company-settings", VENDEDOR, {
      default_price_list_id: LISTA_VES,
    });
    expect(cambio.status).toBe(200);

    const marcada = (await (await pedir("GET", "/v1/price-lists", VENDEDOR)).json()) as {
      id: string;
      is_caja_default: boolean;
    }[];
    expect(marcada.find((l) => l.is_caja_default)?.id).toBe(LISTA_VES);

    // Y la COTIZACIÓN de mostrador (sin cliente) ahora usa esa lista: 4000 VES + 16%.
    const q = (await (
      await pedir("POST", "/v1/pos/quote", VENDEDOR, {
        company_id: COMPANY,
        lines: [{ product_id: PROD, quantity: "1" }],
      })
    ).json()) as { price_list_id: string; currency: string; total: string };
    expect(q.price_list_id).toBe(LISTA_VES);
    expect(q.currency).toBe("VES");
    expect(q.total).toBe("4640.00000000");

    // Se restaura: los tests siguientes cuentan con la «detal» de siempre.
    const restaurar = await pedir("PUT", "/v1/company-settings", VENDEDOR, {
      default_price_list_id: null,
    });
    expect(restaurar.status).toBe(200);
    const restaurada = (await (await pedir("GET", "/v1/price-lists", VENDEDOR)).json()) as {
      id: string;
      is_caja_default: boolean;
    }[];
    expect(restaurada.find((l) => l.is_caja_default)?.id).toBe(LISTA_DETAL);
  });

  it("la venta rápida: factura + efectivo con VUELTO del servidor, y el reintento es la MISMA venta", async () => {
    await pedir("POST", "/v1/fiscal-number-ranges", VENDEDOR, {
      company_id: COMPANY,
      kind: "invoice",
      series: "C",
      range_from: "9000",
      range_to: "9100",
      printer_source: "Imprenta E2E, rango del POS",
    });

    const clave = crypto.randomUUID(); // el sale_id del CLIENTE
    const venta = {
      company_id: COMPANY,
      warehouse_id: W1,
      series: "C",
      lines: [{ product_id: PROD, quantity: "1" }],
      payments: [{ instrument: "efectivo_usd", amount: "120.00000000", currency: "USD" }],
    };
    const r = await app.request("/v1/pos/sales", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await tokenDe(VENDEDOR)}`,
        "X-Company-Id": COMPANY,
        "Idempotency-Key": clave,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(venta),
    });
    expect(r.status).toBe(201);
    const v = (await r.json()) as {
      document: Record<string, unknown>;
      payments: { payment: Record<string, string> }[];
      change: { amount: string; currency: string } | null;
      document_status: string;
      balance: string;
    };
    expect(v.document["status"]).toBe("paid");
    expect(v.document["customer_id"]).toBe(CONSUMIDOR);
    // Total 116 USD; entregó 120 → se aplican 116 y el VUELTO son 4, del servidor.
    expect(v.payments[0]!.payment["amount"]).toBe("116.00000000");
    expect(v.change).toEqual({ amount: "4.00000000", currency: "USD" });
    expect(v.document_status).toBe("paid");
    expect(v.balance).toBe("0.00000000");

    // El REINTENTO con la misma clave: la MISMA venta, sin segunda factura.
    const replay = await app.request("/v1/pos/sales", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await tokenDe(VENDEDOR)}`,
        "X-Company-Id": COMPANY,
        "Idempotency-Key": clave,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(venta),
    });
    expect(replay.status).toBe(201);
    const v2 = (await replay.json()) as { document: Record<string, unknown> };
    expect(v2.document["id"]).toBe(v.document["id"]);
  });

  it("una tarjeta no da vuelto: pasarse con punto_venta es un error, no un redondeo", async () => {
    const r = await pedir("POST", "/v1/pos/sales", VENDEDOR, {
      company_id: COMPANY,
      warehouse_id: W1,
      series: "C",
      lines: [{ product_id: PROD, quantity: "1" }],
      payments: [{ instrument: "punto_venta", amount: "10000.00000000", currency: "VES" }],
    });
    expect(r.status).toBe(422);
  });

  it("el PDF del documento sale con sus datos legales y la marca de formato libre", async () => {
    const [doc] = await sql<{ id: string }[]>`
      select id from public.documents
       where company_id = ${COMPANY} and status in ('issued', 'paid')
       order by created_at desc limit 1`;
    const r = await pedir("GET", `/v1/documents/${doc!.id}/pdf`, VENDEDOR);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/pdf");
    const cuerpo = Buffer.from(await r.arrayBuffer());
    expect(cuerpo.subarray(0, 5).toString()).toBe("%PDF-");
    expect(cuerpo.length).toBeGreaterThan(1000);

    const sucursales = await pedir("GET", "/v1/branches", VENDEDOR);
    expect(sucursales.status).toBe(200);
    expect(Array.isArray(((await sucursales.json()) as { items: unknown[] }).items)).toBe(true);
  });

  // ── LA VENTA EMPIEZA POR LA CÉDULA (migración 33) ─────────────────────────

  it("la venta a cliente IDENTIFICADO congela sus datos y el PDF los imprime con prefijo", async () => {
    // El flujo real del mostrador: lookup falla → alta inline → vender.
    const noEsta = await pedir("GET", "/v1/customers/lookup?document=V-12.345.678", VENDEDOR);
    expect(noEsta.status).toBe(404);

    const alta = await pedir("POST", "/v1/customers", VENDEDOR, {
      company_id: COMPANY,
      tax_id: "V12345678",
      legal_name: "Juan Pérez",
      person_type_code: "natural",
      taxpayer_type_code: "consumidor_final",
      phone: "0414-1234567",
      fiscal_address: "Calle 5, casa 12, Maracay",
      // SIN lista preferida a propósito: el POS crea así, y la venta tiene que
      // resolver a la «detal» de la empresa como con el Consumidor final.
    });
    expect(alta.status).toBe(201);
    const juan = (await alta.json()) as { id: string };

    // Ahora el lookup SÍ encuentra, con separadores y todo.
    const esta = await pedir("GET", "/v1/customers/lookup?document=v-12345678", VENDEDOR);
    expect(esta.status).toBe(200);
    expect(((await esta.json()) as { id: string }).id).toBe(juan.id);

    const r = await pedir("POST", "/v1/pos/sales", VENDEDOR, {
      company_id: COMPANY,
      customer_id: juan.id,
      warehouse_id: W1,
      series: "C",
      lines: [{ product_id: PROD, quantity: "1" }],
      payments: [{ instrument: "efectivo_usd", amount: "116.00000000", currency: "USD" }],
    });
    expect(r.status).toBe(201);
    const v = (await r.json()) as { document: { id: string } };

    // El documento CONGELÓ al cliente (R-05, lado cliente): nombre, documento
    // NORMALIZADO y domicilio, aunque mañana le cambien el nombre al maestro.
    const [congelado] = await sql<
      {
        customer_name_snapshot: string;
        customer_tax_id_snapshot: string;
        customer_address_snapshot: string;
      }[]
    >`
      select customer_name_snapshot, customer_tax_id_snapshot, customer_address_snapshot
        from public.documents where id = ${v.document.id}`;
    expect(congelado).toMatchObject({
      customer_name_snapshot: "Juan Pérez",
      customer_tax_id_snapshot: "V12345678",
      customer_address_snapshot: "Calle 5, casa 12, Maracay",
    });

    // Y el PDF imprime el documento VESTIDO con su prefijo. El contenido va
    // comprimido y pdfkit escribe el texto como arrays TJ en HEX con cortes de
    // kerning: se inflan los streams, se decodifican los <hex> y se concatena —
    // el kerning solo separa glifos, no quita letras.
    const pdf = await pedir("GET", `/v1/documents/${v.document.id}/pdf`, VENDEDOR);
    expect(pdf.status).toBe(200);
    const bruto = Buffer.from(await pdf.arrayBuffer());
    const { inflateSync } = await import("node:zlib");
    let texto = "";
    let i = 0;
    for (;;) {
      const s = bruto.indexOf("stream", i);
      if (s === -1) break;
      let inicio = s + 6;
      if (bruto[inicio] === 0x0d) inicio++;
      if (bruto[inicio] === 0x0a) inicio++;
      const fin = bruto.indexOf("endstream", inicio);
      if (fin === -1) break;
      const trozo = bruto.subarray(inicio, fin);
      try {
        texto += inflateSync(trozo).toString("latin1");
      } catch {
        texto += trozo.toString("latin1");
      }
      i = fin + 9;
    }
    const legible = [...texto.matchAll(/<([0-9a-fA-F]+)>/g)]
      .map((m) => Buffer.from(m[1]!, "hex").toString("latin1"))
      .join("");
    expect(legible).toContain("V-12.345.678");
    expect(legible).toContain("Juan P");
    expect(legible).toContain("Calle 5, casa 12, Maracay");
  });

  it("con las ventas sin identificar APAGADAS, el mostrador exige la cédula", async () => {
    const apagar = await pedir("PUT", "/v1/company-settings", VENDEDOR, {
      allow_unidentified_sales: false,
    });
    expect(apagar.status).toBe(200);

    // Sin cliente = Consumidor final de sistema → el dominio lo rechaza.
    const r = await pedir("POST", "/v1/pos/sales", VENDEDOR, {
      company_id: COMPANY,
      warehouse_id: W1,
      series: "C",
      lines: [{ product_id: PROD, quantity: "1" }],
      payments: [{ instrument: "efectivo_usd", amount: "116.00000000", currency: "USD" }],
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain("identificar al cliente");

    // Se vuelve a encender: los demás tests de este fichero venden de mostrador.
    const encender = await pedir("PUT", "/v1/company-settings", VENDEDOR, {
      allow_unidentified_sales: true,
    });
    expect(encender.status).toBe(200);
  });

  it("el vuelto en vivo: GET /v1/pos/change convierte con la tasa del día", async () => {
    const r = await pedir(
      "GET",
      "/v1/pos/change?total=5220.00000000&currency=VES&tendered=120.00000000&tendered_currency=USD",
      CAJERO,
    );
    expect(r.status).toBe(200);
    const c = (await r.json()) as Record<string, string>;
    // 120 − 5220/45 = 120 − 116 = 4, en la moneda con la que pagaron.
    expect(c["change"]).toBe("4.00000000");
    expect(c["change_currency"]).toBe("USD");
    expect(c["rate"]).toBe("45.00000000");
  });
});

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { borrarTasasOficiales } from "./_tasa-oficial.js";
import { diaCaracas } from "./_dia-caracas.js";
import { fiadoDeFixture } from "./_fiado-de-fixture.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";

/**
 * LOS REPORTES DE UNA EMPRESA QUE FACTURA (P-07, segunda ronda): con datos DISTINTOS DE CERO.
 *
 * La primera versión probaba IVA, IGTF y «lo facturado» sobre conjuntos vacíos (0 = 0). Aquí una
 * contribuyente especial factura, cobra en divisa (percibe IGTF y emite su nota de débito),
 * retira mercancía para consumo propio (factura de retiro) y calcula su IVA DOS veces. Lo que se
 * asevera es lo que distingue cada regla:
 *   · «Ventas con factura» NO cuenta la factura de retiro ni la nota de débito por IGTF, y la
 *     conciliación con el libro de ventas es: ventas con factura + retiros = libro;
 *   · el IGTF de la quincena es lo percibido de verdad (≠ 0);
 *   · el IVA sirve UNA fila por período —la última corrida—, aunque haya dos guardadas;
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
const CLIENTE_USD = crypto.randomUUID();
const ROL = crypto.randomUUID();
const MEM = crypto.randomUUID();
const ASIG = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const AYER = diaCaracas(-1);
const FUENTE_USD = `BCV e2e-repfis-${RUN}`;

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PRODUCTO = "";
let FACTURA = "";
let TOTAL_FACTURA = "";
let IGTF_FUNCIONAL = "";

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

interface Tabla {
  columns: { key: string; label: string; kind: string; currency?: string }[];
  rows: Record<string, string | null>[];
  totals: Record<string, string | null>;
  summary: { key: string; label: string; value: string | null; reason?: string | null }[];
  notes: string[];
}

async function reporte(path: string): Promise<Tabla> {
  const r = await pedir("GET", `/v1/reports/${path}`);
  expect(r.status, `${path}: ${await r.clone().text()}`).toBe(200);
  return (await r.json()) as Tabla;
}
const linea = (t: Tabla, key: string) => t.summary.find((s) => s.key === key);

async function rango(kind: string, series: string, desde: string, hasta: string): Promise<void> {
  const r = await pedir("POST", "/v1/fiscal-number-ranges", {
    company_id: COMPANY,
    kind,
    series,
    range_from: desde,
    range_to: hasta,
    printer_source: "Imprenta E2E reportes",
    printer_legal_name: "Imprenta E2E, C.A.",
    printer_tax_id: "J-12345678-9",
    printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
    printer_authorization_date: "2020-01-15",
    printed_on: "2026-09-01",
  });
  if (r.status !== 201) throw new Error(`rango ${kind}: ${r.status} ${await r.text()}`);
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;

  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e reportes')`;
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-REP-${RUN}`}, 'Empresa e2e reportes',
                     'VES', 'especial')`;
    await declararTipoDeFixture(tx, COMPANY);
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-RW1', 'Principal')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, ${`e2erepfis_${RUN}`}, 'Dueño reportes e2e', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key)
             select ${ROL}, p from unnest(${[
               "sales.invoice.issue",
               "sales.invoice.annul",
               "sales.payment.register",
               "inventory.move",
               "inventory.adjust",
               "ar.read",
               "ap.read",
               "fiscal.range.manage",
               "accounting.account.manage",
               "accounting.template.manage",
               "accounting.read",
               "fiscal_book.read",
               "fiscal_book.export",
               "treasury.read",
               "report.export",
               "company.settings.manage",
               "supplier.manage",
               "purchase.invoice.register",
               "purchase.receive",
               "purchase.order.manage",
               "purchase.payment.register",
             ]}::text[]) as p
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${MEM}, ${TENANT}, ${DUENO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id)
             values (${ASIG}, ${TENANT}, ${MEM}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, ${ASIG}, 'warehouse', ${W1})`;
    await tx`insert into public.customers
               (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                taxpayer_type_code)
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, ${`J-CLI-${RUN}`}, 'Cliente en bolívares',
                     'juridica', 'ordinario'),
                    (${CLIENTE_USD}, ${TENANT}, ${COMPANY}, ${`J-CLE-${RUN}`}, 'Cliente en dólares',
                     'juridica', 'ordinario')`;
    await fiadoDeFixture(tx, COMPANY, [ROL]);

    const [p] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2EREP-${RUN}`}, 'Producto gravado', 'good', 'active',
              'unidad', 'gravado_general')
      returning id`;
    PRODUCTO = p!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, 'detal', 'VES') returning id`;
    const [le] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, 'dolares', 'USD') returning id`;
    await tx`insert into public.company_settings (company_id, tenant_id, default_price_list_id)
             values (${COMPANY}, ${TENANT}, ${l!.id})
             on conflict (company_id) do update set default_price_list_id = excluded.default_price_list_id`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${l!.id}, ${PRODUCTO}, '1000.00000000', ${AYER}::date),
                    (${TENANT}, ${COMPANY}, ${le!.id}, ${PRODUCTO}, '20.00000000', ${AYER}::date)`;
    await tx`update public.customers set default_price_list_id = ${l!.id} where id = ${CLIENTE}`;
    await tx`update public.customers set default_price_list_id = ${le!.id}
              where id = ${CLIENTE_USD}`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${TENANT}, ${COMPANY}, 'formatos_libres', ${AYER}::timestamptz)`;

    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
    for (const tipo of ["sale", "purchase"] as const) {
      await tx`
        insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type,
                                      product_tax_category, rate, effective_from, legal_source,
                                      priority, transaction_type)
        select 'VE', 'iva', 'ordinario', 'gravado_general', 0.16, ${AYER}::date,
               'Carga de prueba E2E — VALIDAR-SENIAT antes de producción.', 10, ${tipo}
         where not exists (select 1 from public.tax_rules
                            where company_id is null and jurisdiction = 'VE' and tax_code = 'iva'
                              and taxpayer_type = 'ordinario'
                              and product_tax_category = 'gravado_general'
                              and transaction_type = ${tipo})`;
    }
    // Las tasas del día: el dólar solo si nadie lo sembró (tabla GLOBAL compartida).
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), ${FUENTE_USD}
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = ${HOY}::date)`;

    await tx`insert into public.inventory_moves
               (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
                amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
                functional_currency, rate_source, rate_timestamp, rounding_policy_id,
                occurred_at, reference)
             values (${TENANT}, ${COMPANY}, ${W1}, ${PRODUCTO}, 'entrada', 500, 250000, 'VES',
                     1, 250000, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', now(),
                     ${`e2e-repfis-seed-${RUN}`})`;
  });

  // Un número de control no se repite en la empresa: cada talonario, su tramo.
  await rango("invoice", "A", "1", "500");
  await rango("debit_note", "A", "501", "1000");
  await rango("credit_note", "A", "1001", "1500");
  for (const [ruta, cuerpo] of [
    ["/v1/accounts/import-template", { company_id: COMPANY, template_code: "ve_basico" }],
    ["/v1/journal-templates/import-preset", { company_id: COMPANY, preset_code: "ve_basico" }],
  ] as const) {
    const r = await pedir("POST", ruta, cuerpo);
    if (r.status !== 201) throw new Error(`${ruta}: ${r.status} ${await r.text()}`);
  }
});

afterAll(async () => {
  if (sql) {
    await borrarTasasOficiales(sql, FUENTE_USD);
  }
  await sql?.end();
  await sqlApi?.end();
});

describe("los reportes de una empresa que factura", { timeout: 120_000 }, () => {
  it("la especial factura, cobra en divisa (IGTF y su nota de débito) y retira mercancía", async () => {
    const igtf = await pedir("POST", "/v1/igtf/enable", {
      company_id: COMPANY,
      reason: "Designada sujeto pasivo especial según notificación del SENIAT.",
    });
    expect(igtf.status, await igtf.clone().text()).toBe(201);

    // La venta: 2 unidades a crédito.
    const f = await pedir("POST", "/v1/invoices", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: [{ product_id: PRODUCTO, quantity: "2" }],
    });
    expect(f.status, await f.clone().text()).toBe(201);
    FACTURA = ((await f.json()) as { id: string }).id;
    const [doc] = await sql<{ total: string }[]>`
      select round(total_amount, 2)::text as total from public.documents where id = ${FACTURA}`;
    TOTAL_FACTURA = doc!.total;
    expect(TOTAL_FACTURA).toBe("2320.00");

    // Un abono POSTERIOR en divisa: percibe IGTF y lo documenta con una nota de débito.
    const cobro = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: FACTURA,
      currency: "USD",
      // Un dólar: cabe en lo que falta con cualquier tasa del día (la tabla de tasas es global).
      amount: "1.00",
      instrument: "zelle",
      igtf_included: false,
    });
    expect(cobro.status, await cobro.clone().text()).toBe(201);
    const percibido = ((await cobro.json()) as { igtf: { functional_amount: string } | null }).igtf;
    expect(percibido).not.toBeNull();
    const [fun] = await sql<{ f: string; positivo: boolean }[]>`
      select round(${percibido!.functional_amount}::numeric, 2)::text as f,
             ${percibido!.functional_amount}::numeric > 0 as positivo`;
    expect(fun!.positivo).toBe(true);
    IGTF_FUNCIONAL = fun!.f;
    const [nd] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.documents
       where company_id = ${COMPANY} and kind = 'debit_note' and status in ('issued', 'paid')`;
    expect(nd!.n).toBe(1);

    // El retiro para consumo propio: se FACTURA (ADR-0082).
    const retiro = await pedir("POST", "/v1/inventory/issues", {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: PRODUCTO,
      quantity: "1",
      reason: "consumo_propio",
    });
    expect(retiro.status, await retiro.clone().text()).toBe(201);
    const [fr] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.documents
       where company_id = ${COMPANY} and kind = 'withdrawal_invoice'`;
    expect(fr!.n).toBe(1);
  });

  it("(1) «Ventas con factura» no cuenta el retiro ni la nota de débito por IGTF; con ellos, cuadra con el libro", async () => {
    const t = await reporte(`sales?from=${HOY}&to=${HOY}`);
    // Tres documentos emitidos hoy y UNA venta.
    expect(t.rows).toEqual([expect.objectContaining({ label: HOY, documents: "1" })]);
    expect(t.totals["total"]).toBe(TOTAL_FACTURA);
    const conFactura = linea(t, "fiscal_total")!;
    expect(conFactura.value).toBe(TOTAL_FACTURA);
    expect(conFactura.label).toBe("Ventas con factura");
    expect(t.notes.join(" ")).toContain(
      "No cuenta las facturas de retiro de inventario ni las notas de débito por IGTF",
    );

    // El libro de ventas lleva MÁS: la factura de retiro (con su total) y la nota de débito por
    // IGTF (total de venta cero; lo percibido, en su columna).
    const [libro] = await sql<
      { total: string; retiros: string; igtf: string; nd: number; cuadra: boolean }[]
    >`
      select round(sum(total_amount), 2)::text as total,
             round(sum(total_amount) filter (where kind like 'withdrawal%'), 2)::text as retiros,
             round(sum(igtf_percibido), 2)::text as igtf,
             (count(*) filter (where kind = 'debit_note'))::int as nd,
             ${conFactura.value}::numeric
               + sum(total_amount) filter (where kind like 'withdrawal%')
               = sum(total_amount) as cuadra
        from platform.sales_book(${COMPANY}, ${HOY}::date, ${HOY}::date)`;
    expect(libro!.retiros).toBe("1160.00");
    expect(libro!.nd).toBe(1);
    expect(libro!.igtf).toBe(IGTF_FUNCIONAL);
    // Ventas con factura + retiros = libro; y el libro NO es lo que dice el reporte.
    expect(libro!.cuadra).toBe(true);
    expect(libro!.total).not.toBe(conFactura.value);

    // El retiro tampoco es margen ni «vendido» del inventario: salieron 3, se vendieron 2.
    const margen = await reporte(`margin?from=${HOY}&to=${HOY}`);
    expect(margen.totals["sales"]).toBe("2000.00");
    const inv = await reporte(`inventory?from=${HOY}&to=${HOY}`);
    expect(inv.rows[0]).toMatchObject({ quantity: "497", sold: "2" });
  });

  it("(1) la nota de crédito de un retiro tampoco es venta ni margen; los retiros del libro son las facturas de retiro Y sus notas", async () => {
    const [fr] = await sql<{ id: string }[]>`
      select id from public.documents
       where company_id = ${COMPANY} and kind = 'withdrawal_invoice'`;
    const corregir = await pedir("POST", `/v1/invoices/${fr!.id}/withdrawal-credit-note`, {
      company_id: COMPANY,
      reason: "La mercancía no llegó a salir del negocio",
    });
    expect(corregir.status, await corregir.clone().text()).toBe(201);
    expect(((await corregir.json()) as { kind: string }).kind).toBe("withdrawal_credit_note");

    // Cuatro documentos emitidos hoy y, todavía, UNA venta.
    const t = await reporte(`sales?from=${HOY}&to=${HOY}`);
    expect(t.rows).toEqual([expect.objectContaining({ label: HOY, documents: "1" })]);
    expect(t.totals["total"]).toBe(TOTAL_FACTURA);
    const conFactura = linea(t, "fiscal_total")!;
    expect(conFactura.value).toBe(TOTAL_FACTURA);

    // La conciliación es contra `kind like 'withdrawal%'` (la factura de retiro y su nota, que va
    // en negativo): con solo las facturas de retiro ya NO cuadra.
    const [libro] = await sql<
      { n: number; retiros: string; facturas: string; cuadra: boolean; sin_notas: boolean }[]
    >`
      select (count(*) filter (where kind like 'withdrawal%'))::int as n,
             round(sum(total_amount) filter (where kind like 'withdrawal%'), 2)::text as retiros,
             round(sum(total_amount) filter (where kind = 'withdrawal_invoice'), 2)::text
               as facturas,
             ${conFactura.value}::numeric
               + sum(total_amount) filter (where kind like 'withdrawal%')
               = sum(total_amount) as cuadra,
             ${conFactura.value}::numeric
               + sum(total_amount) filter (where kind = 'withdrawal_invoice')
               = sum(total_amount) as sin_notas
        from platform.sales_book(${COMPANY}, ${HOY}::date, ${HOY}::date)`;
    expect(libro).toEqual({
      n: 2,
      retiros: "0.00",
      facturas: "1160.00",
      cuadra: true,
      sin_notas: false,
    });

    // Ni margen ni «vendido»: la mercancía del retiro volvió, y se siguen vendiendo 2.
    const margen = await reporte(`margin?from=${HOY}&to=${HOY}`);
    expect(margen.totals["sales"]).toBe("2000.00");
    const inv = await reporte(`inventory?from=${HOY}&to=${HOY}`);
    expect(inv.rows[0]).toMatchObject({ quantity: "498", sold: "2" });
  });

  it("(7) el IGTF de la quincena es lo percibido, y es la cifra de la función", async () => {
    const t = await reporte(`igtf?from=${HOY}&to=${HOY}`);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!["perceived"]).toBe(IGTF_FUNCIONAL);
    expect(t.totals["perceived"]).toBe(IGTF_FUNCIONAL);
    const [f] = await sql<{ t: string }[]>`
      select round(total_functional, 2)::text as t
        from platform.igtf_period_totals(${COMPANY}, ${t.rows[0]!["period_from"]}::date,
                                         ${t.rows[0]!["period_to"]}::date)`;
    expect(t.rows[0]!["perceived"]).toBe(f!.t);
    // Cómo se recupera lo reversado es una pregunta abierta al asesor (P-9): la nota no lo afirma.
    const notas = t.notes.join(" ");
    expect(notas).toContain("queda por reintegrar; cómo se recupera lo confirma tu contador");
    expect(notas).not.toContain("se recupera por reintegro");
  });

  it("(3) el IVA sirve una fila por período: la ÚLTIMA corrida, aunque haya dos guardadas", async () => {
    // La quincena de HOY (la especial declara por quincenas): es la que tiene las ventas.
    const [p] = await sql<{ period_from: string; period_to: string }[]>`
      select (case when extract(day from ${HOY}::date) <= 15
                   then date_trunc('month', ${HOY}::date::timestamp)::date
                   else date_trunc('month', ${HOY}::date::timestamp)::date + 15 end)::text
               as period_from,
             (case when extract(day from ${HOY}::date) <= 15
                   then date_trunc('month', ${HOY}::date::timestamp)::date + 14
                   else (date_trunc('month', ${HOY}::date::timestamp)
                         + interval '1 month' - interval '1 day')::date end)::text as period_to`;
    if (!p) throw new Error("sin quincena");
    const calcular = async (): Promise<void> => {
      const r = await pedir("POST", "/v1/fiscal-declarations/iva-periods", {
        company_id: COMPANY,
        period_from: p.period_from,
        period_to: p.period_to,
      });
      expect(r.status, await r.clone().text()).toBe(201);
    };
    await calcular();
    // ENTRE las dos corridas se factura otra unidad (base 1.000, IVA 160): la segunda corrida
    // dice otra cosa que la primera, y «la última» deja de ser indistinguible de «la primera».
    const otra = await pedir("POST", "/v1/invoices", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
    });
    expect(otra.status, await otra.clone().text()).toBe(201);
    await calcular();
    const guardadas = await sql<{ id: string; debitos: string; pagar: string }[]>`
      select id, round(debitos, 2)::text as debitos, round(cuota_a_pagar, 2)::text as pagar
        from public.iva_period_results
       where company_id = ${COMPANY} and period_from = ${p.period_from}::date
       order by created_at desc, id desc`;
    expect(guardadas).toHaveLength(2);
    const [ultima, primera] = guardadas;
    const [entre] = await sql<{ d: string }[]>`
      select round(${ultima!.debitos}::numeric - ${primera!.debitos}::numeric, 2)::text as d`;
    expect(entre!.d).toBe("160.00");

    const t = await reporte(`iva?from=${p.period_from}&to=${p.period_to}`);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({
      period_from: p.period_from,
      period_to: p.period_to,
      debits: ultima!.debitos,
      payable: ultima!.pagar,
    });
    // La fila es la de la SEGUNDA corrida, no la de la primera.
    expect(t.rows[0]!["debits"]).not.toBe(primera!.debitos);
    // Lo que el reporte es y lo que no (AF5-16): dos notas fijas.
    expect(t.notes).toContain(
      'Es un resumen de gestión: no es la declaración ni la Forma 30. Las cifras son las de "Declarar IVA", que tu contador confirma antes de presentar.',
    );
    expect(t.notes).toContain(
      'Las retenciones practicadas no restan de "A pagar": se enteran aparte, por quincena.',
    );
    // Con datos: los débitos del período no son cero.
    const [d] = await sql<{ positivo: boolean }[]>`
      select ${t.rows[0]!["debits"]!}::numeric > 0 as positivo`;
    expect(d!.positivo).toBe(true);
    // Un rango que solo toca el período también lo trae; uno anterior, no.
    expect((await reporte(`iva?from=${HOY}&to=${HOY}`)).rows).toHaveLength(1);
    expect((await reporte("iva?from=2020-01-01&to=2020-01-31")).rows).toEqual([]);
  });
});

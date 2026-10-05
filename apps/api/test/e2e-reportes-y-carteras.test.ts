import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import type { TransactionSql } from "@ladino/db";
import { marginReport, payablesReport, receivablesReport, salesReport } from "@ladino/domain";
import { buildApp } from "../src/app.js";
import { csvDeReporte } from "../src/report-export.js";
import { diaCaracas } from "./_dia-caracas.js";
import { borrarTasasOficiales } from "./_tasa-oficial.js";
import { venceDeFixture } from "./_fiado-de-fixture.js";

/**
 * LOS REPORTES Y LAS CARTERAS (recorrido 2026-09-24: P-07, F-13 y H-11).
 *
 * Cada reporte es una consulta del servidor bajo `/v1/reports/…`. Lo que se asevera es lo que
 * SOLO produce cada uno, y siempre contra su FUENTE, consultada aparte como dueño de la base:
 *   · «Quién me debe» = `platform.ar_aging`; «Qué debo» = `platform.ap_aging`;
 *   · ventas = los documentos del rango, y lo facturado = `platform.sales_book`;
 *   · margen: venta + venta sin costo = la base del reporte de ventas;
 *   · inventario valorizado = el kardex de `platform.inventory_ledger_gap`;
 *   · IGTF = `platform.igtf_period_totals`, quincena a quincena;
 *   · un día es un día de CARACAS: una venta de las 20:30 y otra de las 23:30 (en UTC, ya mañana)
 *     caen en su día, no en el siguiente.
 * Y quién ve qué: el cajero ve la cartera (cobra) pero no el dinero del negocio ni se lleva el
 * archivo; el almacén ve existencias sin su valor; otra empresa no ve nada.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";

const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const FUENTE_TASA = `BCV e2e-reportes-${RUN}`;

const DUENO = crypto.randomUUID();
const CAJERO = crypto.randomUUID();
const ALMACEN = crypto.randomUUID();
const OTRO_DUENO = crypto.randomUUID();
const ENCARGADO = crypto.randomUUID();

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let COMPANY = "";
let OTRA = "";
let DEPOSITO = "";
let PRODUCTO = "";
let CLIENTE = "";
let RECIBO = "";
let PROVEEDOR = "";
const NOMBRE_CLIENTE = `Luisa Fiada ${RUN}`;

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
  metodo: string,
  path: string,
  sub: string,
  body?: unknown,
  company: string = COMPANY,
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await tokenDe(sub)}` };
  if (company !== "") headers["X-Company-Id"] = company;
  if (metodo !== "GET" && path !== "/v1/onboarding") {
    headers["Idempotency-Key"] = crypto.randomUUID();
  }
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
  report: string;
  from: string | null;
  to: string | null;
  as_of: string;
  currency: string;
  group: string | null;
  columns: { key: string; label: string; kind: string; currency?: string }[];
  rows: Record<string, string | null>[];
  totals: Record<string, string | null>;
  summary: { key: string; value: string | null; reason?: string | null }[];
  notes: string[];
  row_count: number;
}

async function reporte(path: string, sub: string, company: string = COMPANY): Promise<Tabla> {
  const r = await pedir("GET", `/v1/reports/${path}`, sub, undefined, company);
  expect(r.status, path).toBe(200);
  return (await r.json()) as Tabla;
}

const linea = (t: Tabla, key: string) => t.summary.find((s) => s.key === key);

/**
 * Los fixtures por SQL que la API NO produce (un documento con el instante elegido, una línea de
 * mercancía sin costo, una factura de proveedor de fecha pasada) se escriben dentro de una
 * transacción que se REVIERTE, y dentro de ella se llama a la MISMA lectura del dominio que sirve
 * la ruta. Fuera de ella dejarían en la empresa de prueba documentos sin asiento ni fila de cola,
 * un estado que la API no produce (`platform.accounting_coverage_gaps` daba 11 filas). Lo único
 * que no pasa por aquí es el `c.json(tabla)` del handler, que ya ejercitan los demás casos.
 */
async function revertido(cuerpo: (tx: TransactionSql) => Promise<void>): Promise<void> {
  let visto = false;
  await sql
    .begin(async (tx) => {
      await cuerpo(tx);
      visto = true;
      throw new Error("revertir");
    })
    .catch((e: unknown) => {
      if (!(e instanceof Error) || e.message !== "revertir") throw e;
    });
  expect(visto).toBe(true);
}

async function fundar(dueno: string, nombre: string) {
  const f = await pedir("POST", "/v1/onboarding", dueno, { business_name: nombre }, "");
  expect(f.status).toBe(201);
  const { company_id: company, warehouse_id: deposito } = (await f.json()) as {
    company_id: string;
    warehouse_id: string;
  };
  const p = await pedir(
    "POST",
    "/v1/products/simple",
    dueno,
    {
      company_id: company,
      name: `Harina ${nombre}`,
      price: { amount: "2", currency: "USD" },
      initial_stock: { quantity: "10", unit_cost: { amount: "40", currency: "VES" } },
    },
    company,
  );
  expect(p.status).toBe(201);
  const producto = ((await p.json()) as { product: { id: string } }).product.id;
  const iva = await pedir("POST", "/v1/fiscal/iva-general", dueno, { rate: "0.16" }, company);
  expect(iva.status).toBeLessThan(300);
  const s = await pedir(
    "POST",
    "/v1/suppliers",
    dueno,
    {
      company_id: company,
      tax_id: `J-5${String(Date.now()).slice(-7)}-0`,
      legal_name: `Proveedor de ${nombre}`,
      supplier_kind: "nacional",
      person_type_code: "juridica",
      taxpayer_type_code: "ordinario",
    },
    company,
  );
  expect(s.status).toBe(201);
  const proveedor = ((await s.json()) as { id: string }).id;
  const c = await pedir(
    "POST",
    "/v1/purchases/simple",
    dueno,
    {
      company_id: company,
      supplier_id: proveedor,
      warehouse_id: deposito,
      currency: "VES",
      supplier_document_number: `FC-${RUN}-${nombre.length}`,
      supplier_control_number: `CTRL-${RUN}-${nombre.length}`,
      lines: [{ product_id: producto, quantity: "2", unit_price: "40" }],
    },
    company,
  );
  expect(c.status).toBe(201);
  return { company, deposito, producto, proveedor };
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id, email) values
            (${DUENO}, ${`dueno-rep-${RUN}@e2e.ladino`}),
            (${CAJERO}, ${`cajero-rep-${RUN}@e2e.ladino`}),
            (${ALMACEN}, ${`almacen-rep-${RUN}@e2e.ladino`}),
            (${OTRO_DUENO}, ${`otro-rep-${RUN}@e2e.ladino`}),
            (${ENCARGADO}, ${`encargado-rep-${RUN}@e2e.ladino`})
            on conflict (id) do nothing`;
  // La tasa oficial del día, con fuente propia y solo si nadie la sembró (tabla GLOBAL compartida).
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), ${FUENTE_TASA}
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD'
                            and to_currency = 'VES' and rate_date = ${HOY}::date)`;
  });
});

afterAll(async () => {
  if (sql) await borrarTasasOficiales(sql, FUENTE_TASA);
  await sql?.end();
  await sqlApi?.end();
});

describe("los reportes y las carteras", { timeout: 120_000 }, () => {
  it("un negocio vende al contado y fiado, y debe una compra; otro negocio aparte", async () => {
    const a = await fundar(DUENO, `Abasto Reportes ${RUN}`);
    COMPANY = a.company;
    DEPOSITO = a.deposito;
    PRODUCTO = a.producto;
    PROVEEDOR = a.proveedor;
    OTRA = (await fundar(OTRO_DUENO, `Bodega Ajena R ${RUN}`)).company;

    for (const [correo, rol] of [
      [`cajero-rep-${RUN}@e2e.ladino`, "cashier"],
      [`almacen-rep-${RUN}@e2e.ladino`, "warehouse_ops"],
    ] as const) {
      const m = await pedir("POST", "/v1/members", DUENO, {
        company_id: COMPANY,
        email: correo,
        role_key: rol,
      });
      expect(m.status).toBe(201);
    }

    // Al contado, por el cajero.
    const cot = await pedir("POST", "/v1/pos/quote", CAJERO, {
      company_id: COMPANY,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
    });
    expect(cot.status).toBe(200);
    const total = ((await cot.json()) as { functional_total: string }).functional_total;
    const v = await pedir("POST", "/v1/pos/sales", CAJERO, {
      company_id: COMPANY,
      warehouse_id: DEPOSITO,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
      payments: [{ instrument: "efectivo_bs", amount: total, currency: "VES" }],
    });
    expect(v.status).toBe(201);
    RECIBO = ((await v.json()) as { document: { id: string } }).document.id;

    // Fiado, a una clienta con límite, por el dueño.
    const alta = await pedir("POST", "/v1/customers", DUENO, {
      company_id: COMPANY,
      tax_id: `V${String(Date.now()).slice(-8)}`,
      legal_name: NOMBRE_CLIENTE,
      person_type_code: "natural",
      fiscal_address: "Av. Lara con calle 8, Barquisimeto",
    });
    expect(alta.status).toBe(201);
    CLIENTE = ((await alta.json()) as { id: string }).id;
    const l = await pedir("PUT", `/v1/customers/${CLIENTE}/credit-limit`, DUENO, {
      company_id: COMPANY,
      credit_limit_usd: "1000",
    });
    expect(l.status).toBe(200);
    const fiado = await pedir("POST", "/v1/pos/sales", DUENO, {
      company_id: COMPANY,
      warehouse_id: DEPOSITO,
      customer_id: CLIENTE,
      lines: [{ product_id: PRODUCTO, quantity: "2" }],
      due_date: venceDeFixture(),
    });
    expect(fiado.status).toBe(201);
  });

  it("F-13 · «Quién me debe»: la cartera sale sin elegir cliente y cuadra con ar_aging", async () => {
    const t = await reporte("receivables", DUENO);
    expect(t.report).toBe("receivables");
    expect(t.as_of).toBe(HOY);
    expect(t.rows).toHaveLength(1);
    const fila = t.rows[0]!;
    expect(fila["label"]).toBe(NOMBRE_CLIENTE);
    expect(fila["id"]).toBe(CLIENTE);
    expect(fila["documents"]).toBe("1");

    const [fuente] = await sql<{ deuda: string; tramo: string; hoy: string }[]>`
      select round(sum(amount), 2)::text as deuda, min(bucket) as tramo,
             round(platform.customer_debt_today(${COMPANY}), 2)::text as hoy
        from platform.ar_aging(${COMPANY}, null, ${HOY}::date)`;
    expect(Number(fuente!.deuda)).toBeGreaterThan(0);
    expect(fila["debt"]).toBe(fuente!.deuda);
    expect(t.totals["debt"]).toBe(fuente!.deuda);
    expect(linea(t, "debt")?.value).toBe(fuente!.deuda);
    // La cartera y «lo que me deben» del Inicio son la misma cifra.
    expect(t.totals["debt"]).toBe(fuente!.hoy);
    // Recién fiada y con fecha por delante: está en el primer tramo y nada vencido.
    expect(fuente!.tramo).toBe("0-30");
    expect(fila["b_0-30"]).toBe(fuente!.deuda);
    expect(fila["b_31-60"]).toBe("0.00");
    expect(fila["overdue"]).toBe("0.00");
    expect(t.totals["overdue"]).toBe("0.00");
    expect(fila["oldest_due"]).toBe(venceDeFixture());
    expect(fila["days_overdue"]).toBe("0");

    // El nominal por moneda: una columna por moneda que se debe, con la moneda en la columna.
    const [doc] = await sql<{ moneda: string; nominal: string }[]>`
      select dd.currency as moneda, round(dd.nominal, 2)::text as nominal
        from public.documents d
       cross join lateral platform.document_debt(${COMPANY}, d.id) dd
       where d.company_id = ${COMPANY} and d.customer_id = ${CLIENTE}`;
    const col = t.columns.find((c) => c.key === `nominal_${doc!.moneda}`);
    expect(col).toMatchObject({ kind: "money", currency: doc!.moneda });
    expect(fila[`nominal_${doc!.moneda}`]).toBe(doc!.nominal);
    expect(t.totals[`nominal_${doc!.moneda}`]).toBe(doc!.nominal);

    for (const orden of ["debt_desc", "overdue_desc", "oldest", "name"]) {
      expect((await reporte(`receivables?sort=${orden}`, DUENO)).rows).toHaveLength(1);
    }
    expect((await pedir("GET", "/v1/reports/receivables?sort=azar", DUENO)).status).toBe(422);
  });

  it("H-11 · «Qué debo»: la cartera de proveedores cuadra con ap_aging", async () => {
    const t = await reporte("payables", DUENO);
    expect(t.rows).toHaveLength(1);
    const fila = t.rows[0]!;
    expect(fila["label"]).toBe(`Proveedor de Abasto Reportes ${RUN}`);
    const [fuente] = await sql<{ deuda: string; n: string; vence: string }[]>`
      select round(sum(a.amount), 2)::text as deuda, sum(a.document_count)::text as n,
             (select min(coalesce(i.due_date, i.invoice_date))::text
                from public.supplier_invoices i where i.company_id = ${COMPANY}) as vence
        from platform.ap_aging(${COMPANY}, null, ${HOY}::date) a`;
    expect(Number(fuente!.deuda)).toBeGreaterThan(0);
    expect(fila["debt"]).toBe(fuente!.deuda);
    expect(fila["documents"]).toBe(fuente!.n);
    expect(fila["next_due"]).toBe(fuente!.vence);
    expect(t.totals["debt"]).toBe(fuente!.deuda);
    expect(linea(t, "debt")?.value).toBe(fuente!.deuda);
    // La compra es en bolívares: su nominal es la deuda, en su columna.
    expect(fila["nominal_VES"]).toBe(fuente!.deuda);
    expect((await reporte("payables?sort=due", DUENO)).rows).toHaveLength(1);
  });

  it("(1) ventas: por día, producto, cliente, forma de pago y vendedor, contra los documentos", async () => {
    const [fuente] = await sql<{ total: string; base: string; n: string }[]>`
      select round(sum(total_amount), 2)::text as total,
             round(sum(subtotal_amount), 2)::text as base, count(*)::text as n
        from public.documents
       where company_id = ${COMPANY} and kind = 'receipt' and status in ('issued', 'paid')`;
    expect(fuente!.n).toBe("2");
    const rango = `from=${HOY}&to=${HOY}`;

    const dia = await reporte(`sales?${rango}`, DUENO);
    expect(dia.group).toBe("day");
    expect(dia.rows).toEqual([
      expect.objectContaining({ label: HOY, documents: "2", total: fuente!.total }),
    ]);
    expect(dia.totals["total"]).toBe(fuente!.total);
    expect(linea(dia, "total")?.value).toBe(fuente!.total);
    // Sin RIF todo va con recibo: nada entra al libro de ventas.
    expect(linea(dia, "receipts_total")?.value).toBe(fuente!.total);
    const [libro] = await sql<{ t: string }[]>`
      select round(coalesce(sum(total_amount), 0), 2)::text as t
        from platform.sales_book(${COMPANY}, ${HOY}::date, ${HOY}::date)
       where kind in ('invoice', 'credit_note', 'debit_note')`;
    expect(linea(dia, "fiscal_total")?.value).toBe(libro!.t);

    const mes = await reporte(`sales?${rango}&group=month`, DUENO);
    expect(mes.rows).toEqual([
      expect.objectContaining({ label: HOY.slice(0, 7), total: fuente!.total }),
    ]);

    const producto = await reporte(`sales?${rango}&group=product`, DUENO);
    expect(producto.rows).toHaveLength(1);
    expect(producto.rows[0]).toMatchObject({ quantity: "3", total: fuente!.total });
    expect(producto.totals["total"]).toBe(fuente!.total);

    const cliente = await reporte(`sales?${rango}&group=customer`, DUENO);
    expect(cliente.rows).toHaveLength(2);
    expect(cliente.rows.map((r) => r["label"])).toContain(NOMBRE_CLIENTE);
    expect(cliente.totals["total"]).toBe(fuente!.total);

    const vendedor = await reporte(`sales?${rango}&group=seller`, DUENO);
    // Dos vendedores: el cajero (contado) y el dueño (fiado), un documento cada uno.
    expect(vendedor.rows.map((r) => r["documents"])).toEqual(["1", "1"]);

    const pago = await reporte(`sales?${rango}&group=payment_method`, DUENO);
    const [cobrado] = await sql<{ t: string }[]>`
      select round(sum(functional_amount), 2)::text as t from public.payments
       where company_id = ${COMPANY} and document_id = ${RECIBO}`;
    expect(pago.rows).toEqual([
      expect.objectContaining({
        instrument: "efectivo_bs",
        label: "Efectivo en bolívares",
        moneda: "VES",
        payments: "1",
        collected: cobrado!.t,
      }),
    ]);
    // Lo cobrado NO es lo vendido: la venta fiada no entró a la caja.
    expect(pago.totals["collected"]).toBe(cobrado!.t);
    expect(pago.totals["collected"]).not.toBe(fuente!.total);

    // Un rango sin ventas: cero filas y totales en cero, no un error.
    const vacio = await reporte("sales?from=2020-01-01&to=2020-01-31", DUENO);
    expect(vacio.rows).toEqual([]);
    expect(vacio.totals["total"]).toBe("0.00");
  });

  it("un día es un día de Caracas: las ventas de las 20:30 y las 23:30 caen en su día", async () => {
    // Dos recibos con el instante ELEGIDO (en UTC los dos son ya el 11 de junio), copiados del
    // recibo real para llevar las columnas que exige el esquema. Como dueño de la base, y dentro
    // de una transacción que se revierte (ver `revertido`): son recibos sin cobro ni asiento.
    await revertido(async (tx) => {
      for (const [numero, instante, importe] of [
        [900001, "2026-06-10 20:30:00-04", "100"],
        [900002, "2026-06-10 23:30:00-04", "200"],
      ] as const) {
        await tx`
          insert into public.documents
            (tenant_id, company_id, branch_id, kind, series, customer_id, document_number, status,
             issued_at, regime_version_id, transaction_currency, functional_currency, fx_rate,
             rate_source, rate_timestamp, rounding_policy_id, amount_transaction_currency,
             functional_amount, subtotal_amount, tax_amount, total_amount, created_by)
          select tenant_id, company_id, branch_id, kind, series, customer_id, ${numero}, 'paid',
                 ${instante}::timestamptz, regime_version_id, 'VES', 'VES', 1, 'identidad',
                 ${instante}::timestamptz, rounding_policy_id, ${importe}::numeric,
                 ${importe}::numeric, ${importe}::numeric, 0, ${importe}::numeric, created_by
            from public.documents where id = ${RECIBO}`;
      }
      const diez = (await salesReport(tx, COMPANY, { from: "2026-06-10", to: "2026-06-10" }))!;
      expect(diez.rows).toEqual([
        expect.objectContaining({ label: "2026-06-10", documents: "2", total: "300.00" }),
      ]);
      // El día siguiente —el que diría UTC— no tiene nada.
      const once = (await salesReport(tx, COMPANY, { from: "2026-06-11", to: "2026-06-11" }))!;
      expect(once.rows).toEqual([]);
      expect(once.totals["total"]).toBe("0.00");
      // Y por mes, junio: los dos.
      const junio = (await salesReport(tx, COMPANY, {
        from: "2026-06-01",
        to: "2026-06-30",
        group: "month",
      }))!;
      expect(junio.rows).toEqual([
        expect.objectContaining({ label: "2026-06", documents: "2", total: "300.00" }),
      ]);
      const margen = (await marginReport(tx, COMPANY, {
        from: "2026-06-10",
        to: "2026-06-10",
        group: "day",
      }))!;
      expect(margen.rows.map((r) => r["label"])).toEqual([]);
    });
  });

  it("(2) margen: venta menos costo, y cuadra con la base de ventas; el diferencial es una línea", async () => {
    const rango = `from=${HOY}&to=${HOY}`;
    const m = await reporte(`margin?${rango}`, DUENO);
    const ventas = await reporte(`sales?${rango}`, DUENO);
    const [fuente] = await sql<{ venta: string; costo: string; margen: string }[]>`
      select round(sum(l.line_subtotal_functional), 2)::text as venta,
             round(sum(l.cost_snapshot * l.quantity), 2)::text as costo,
             round(sum(l.line_subtotal_functional - l.cost_snapshot * l.quantity), 2)::text
               as margen
        from public.document_lines l
        join public.documents d on d.id = l.document_id
       where d.company_id = ${COMPANY} and d.kind = 'receipt'
         and platform.caracas_day(d.issued_at) = ${HOY}::date`;
    expect(Number(fuente!.costo)).toBeGreaterThan(0);
    expect(m.totals).toMatchObject({
      sales: fuente!.venta,
      cost: fuente!.costo,
      margin: fuente!.margen,
      sales_without_cost: "0.00",
    });
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]).toMatchObject({ margin: fuente!.margen });
    // Coherencia entre reportes: la venta del margen ES la base del reporte de ventas.
    expect(m.totals["sales"]).toBe(ventas.totals["base"]);
    expect(linea(m, "margin")?.value).toBe(fuente!.margen);
    // El diferencial cambiario: la MISMA cifra que su reporte de siempre.
    const dif = await pedir("GET", `/v1/reports/exchange-difference?${rango}`, DUENO);
    expect(dif.status).toBe(200);
    const neto = ((await dif.json()) as { neto: string }).neto;
    const [redondo] = await sql<{ n: string }[]>`select round(${neto}::numeric, 2)::text as n`;
    expect(linea(m, "exchange_realized")?.value).toBe(redondo!.n);
    // La revaluación no se inventa: null con su motivo.
    expect(linea(m, "exchange_revaluation")).toMatchObject({ value: null, reason: "sin_dato" });
    expect((await reporte(`margin?${rango}&group=month`, DUENO)).rows).toHaveLength(1);
  });

  it("(4) inventario valorizado: cuadra con el kardex; el almacén ve existencias sin valor", async () => {
    const rango = `from=${HOY}&to=${HOY}`;
    const t = await reporte(`inventory?${rango}`, DUENO);
    const [fuente] = await sql<{ kardex: string; saldo: string; cantidad: string }[]>`
      select (select round(kardex, 2)::text from platform.inventory_ledger_gap(${COMPANY})) as kardex,
             round(sum(value), 2)::text as saldo, trim_scale(sum(quantity))::text as cantidad
        from public.stock_balances where company_id = ${COMPANY}`;
    expect(Number(fuente!.saldo)).toBeGreaterThan(0);
    expect(t.totals["value"]).toBe(fuente!.saldo);
    // El invariante que cruza: lo valorizado ES el kardex que se compara con el mayor.
    expect(t.totals["value"]).toBe(fuente!.kardex);
    expect(linea(t, "ledger_gap")?.value).toBe("0.00");
    expect(t.rows).toHaveLength(1);
    // 10 iniciales + 2 comprados − 3 vendidos.
    expect(t.rows[0]).toMatchObject({
      quantity: fuente!.cantidad,
      sold: "3",
      value: fuente!.saldo,
    });
    expect(fuente!.cantidad).toBe("9");
    // 9 en existencia, 3 vendidos en 1 día: dura 3 días.
    expect(t.rows[0]!["days_of_stock"]).toBe("3");

    const almacen = await pedir("GET", `/v1/reports/inventory?${rango}`, ALMACEN);
    expect(almacen.status).toBe(200);
    const crudo = await almacen.text();
    const sinValor = JSON.parse(crudo) as Tabla;
    expect(sinValor.rows[0]).toMatchObject({ quantity: "9", value: null, unit_cost: null });
    expect(sinValor.columns.map((c) => c.key)).not.toContain("value");
    expect(sinValor.totals).toEqual({});
    expect(linea(sinValor, "value")).toMatchObject({ value: null, reason: "sin_permiso" });
    // Ni el valor ni lo que dice el mayor viajan en ninguna parte de la respuesta.
    expect(crudo).not.toContain(fuente!.saldo);
    expect(sinValor.summary.map((s) => s.key)).toEqual(["value"]);
  });

  it("(3) IVA y (7) IGTF: leen lo ya calculado; (6) cierres de caja", async () => {
    const iva = await reporte(`iva?from=${HOY}&to=${HOY}`, DUENO);
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.iva_period_results where company_id = ${COMPANY}`;
    expect(iva.rows).toHaveLength(n!.n);
    expect(iva.totals).toEqual({});

    // Un mes entero son dos quincenas, y cada una es la cifra de la función única.
    const igtf = await reporte("igtf?from=2026-06-10&to=2026-06-20", DUENO);
    expect(igtf.rows.map((r) => [r["period_from"], r["period_to"]])).toEqual([
      ["2026-06-01", "2026-06-15"],
      ["2026-06-16", "2026-06-30"],
    ]);
    for (const r of igtf.rows) {
      const [f] = await sql<{ t: string }[]>`
        select round(total_functional, 2)::text as t
          from platform.igtf_period_totals(${COMPANY}, ${r["period_from"]}::date,
                                           ${r["period_to"]}::date)`;
      expect(r["perceived"]).toBe(f!.t);
    }
    // Febrero termina el 28: la segunda quincena no se inventa un día 30.
    const febrero = await reporte("igtf?from=2026-02-16&to=2026-02-16", DUENO);
    expect(febrero.rows.map((r) => [r["period_from"], r["period_to"]])).toEqual([
      ["2026-02-16", "2026-02-28"],
    ]);

    const cierres = await reporte(`cash-closings?from=${HOY}&to=${HOY}`, DUENO);
    const [c] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.cash_closings where company_id = ${COMPANY}`;
    expect(linea(cierres, "closings")?.value).toBe(c!.n);
    expect(cierres.rows).toHaveLength(Number(c!.n));
    expect((await reporte(`cash-closings?from=${HOY}&to=${HOY}&group=cashier`, DUENO)).group).toBe(
      "cashier",
    );
  });

  it("quién ve qué: el cajero cobra pero no ve el dinero del negocio; el almacén, solo existencias", async () => {
    const rango = `from=${HOY}&to=${HOY}`;
    const estado = async (path: string, sub: string) =>
      (await pedir("GET", `/v1/reports/${path}`, sub)).status;
    // El cajero tiene ar.read: ve quién debe. Nada más.
    expect(await estado("receivables", CAJERO)).toBe(200);
    for (const p of [
      "payables",
      `sales?${rango}`,
      `margin?${rango}`,
      `iva?${rango}`,
      `igtf?${rango}`,
      `cash-closings?${rango}`,
      `inventory?${rango}`,
    ]) {
      const r = await pedir("GET", `/v1/reports/${p}`, CAJERO);
      expect(r.status, `cajero · ${p}`).toBe(403);
      expect(((await r.json()) as { code: string }).code).toBe("PERMISSION_REQUIRED");
    }
    // El almacén: solo inventario.
    expect(await estado(`inventory?${rango}`, ALMACEN)).toBe(200);
    for (const p of ["receivables", "payables", `sales?${rango}`, `margin?${rango}`]) {
      expect(await estado(p, ALMACEN), `almacén · ${p}`).toBe(403);
    }
    // Ver no es llevarse el archivo: el cajero no tiene report.export.
    const descarga = await pedir("GET", "/v1/reports/receivables?format=csv", CAJERO);
    expect(descarga.status).toBe(403);
    expect(((await descarga.json()) as { message: string }).message).toContain("report.export");
  });

  it("otra empresa no ve nada de esta; quien es de las dos, solo la que pide", async () => {
    const ajena = await reporte("receivables", OTRO_DUENO, OTRA);
    expect(ajena.rows).toEqual([]);
    expect(ajena.totals["debt"]).toBe("0.00");
    const r = await pedir("GET", "/v1/reports/receivables", OTRO_DUENO, undefined, COMPANY);
    expect(r.status).toBe(404);
    // El atacante realista: dueño aquí y también miembro allá.
    const m = await pedir(
      "POST",
      "/v1/members",
      OTRO_DUENO,
      { company_id: OTRA, email: `dueno-rep-${RUN}@e2e.ladino`, role_key: "owner" },
      OTRA,
    );
    expect(m.status).toBe(201);
    const allá = await reporte(`sales?from=${HOY}&to=${HOY}&group=customer`, DUENO, OTRA);
    expect(allá.rows.map((f) => f["label"])).not.toContain(NOMBRE_CLIENTE);
    expect(allá.rows).toEqual([]);
    expect((await reporte("receivables", DUENO, OTRA)).rows).toEqual([]);
    expect((await reporte("payables", DUENO, OTRA)).rows).toHaveLength(1);
    expect((await reporte("payables", DUENO, COMPANY)).rows[0]!["label"]).toBe(
      `Proveedor de Abasto Reportes ${RUN}`,
    );
  });

  it("la descarga: CSV de Venezuela y Excel, hechos por el servidor", async () => {
    const rango = `from=${HOY}&to=${HOY}`;
    const json = await reporte(`sales?${rango}`, DUENO);
    const r = await pedir("GET", `/v1/reports/sales?${rango}&format=csv`, DUENO);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/csv");
    expect(r.headers.get("content-disposition")).toBe(
      `attachment; filename="ventas-day-${HOY}_${HOY}.csv"`,
    );
    const bytes = new Uint8Array(await r.arrayBuffer());
    // BOM de UTF-8: Excel lee los acentos.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lineas = new TextDecoder().decode(bytes.slice(3)).split("\r\n");
    expect(lineas[0]).toBe("Día;Documentos;Sin impuesto;Impuesto;Total");
    const [a, m, d] = HOY.split("-");
    const coma = (v: string) => v.replace(".", ",");
    // La misma cifra que la pantalla, con coma decimal y la fecha día/mes/año.
    expect(lineas[1]).toBe(
      [
        `${d}/${m}/${a}`,
        "2",
        coma(json.rows[0]!["base"]!),
        coma(json.rows[0]!["tax"]!),
        coma(json.rows[0]!["total"]!),
      ].join(";"),
    );
    expect(lineas[2]).toBe(
      [
        "Total",
        "2",
        coma(json.totals["base"]!),
        coma(json.totals["tax"]!),
        coma(json.totals["total"]!),
      ].join(";"),
    );
    expect(lineas[1]).not.toContain(".");

    const x = await pedir("GET", "/v1/reports/receivables?format=xlsx", DUENO);
    expect(x.status).toBe(200);
    expect(x.headers.get("content-disposition")).toBe(
      `attachment; filename="quien-me-debe-${HOY}.xlsx"`,
    );
    const zip = new Uint8Array(await x.arrayBuffer());
    expect(String.fromCharCode(zip[0]!, zip[1]!)).toBe("PK");
    const { Workbook } = await import("exceljs");
    const libro = new Workbook();
    await libro.xlsx.load(zip.buffer);
    const hoja = libro.worksheets[0]!;
    expect(hoja.getRow(1).getCell(1).value).toBe("Cliente");
    expect(hoja.getRow(2).getCell(1).value).toBe(NOMBRE_CLIENTE);
    const cartera = await reporte("receivables", DUENO);
    // El nominal (no depende de la tasa, que es global y la mueven otros E2E): texto, no número,
    // la cifra exacta del servidor con coma decimal.
    const nominal = cartera.columns.find((c) => c.key.startsWith("nominal_"))!;
    const iNominal = cartera.columns.indexOf(nominal) + 1;
    expect(hoja.getRow(2).getCell(iNominal).value).toBe(coma(cartera.rows[0]![nominal.key]!));
    expect(libro.worksheets[1]!.name).toBe("Resumen");
  });

  it("(4) sin ver el valor, el inventario va por nombre: el orden no delata qué vale más", async () => {
    const p = await pedir("POST", "/v1/products/simple", DUENO, {
      company_id: COMPANY,
      name: `Aceite ${RUN}`,
      price: { amount: "1", currency: "USD" },
      initial_stock: { quantity: "1", unit_cost: { amount: "5", currency: "VES" } },
    });
    expect(p.status).toBe(201);
    const rango = `from=${HOY}&to=${HOY}`;
    const harina = `Harina Abasto Reportes ${RUN}`;
    // Quien ve el valor: lo que más vale, primero.
    const dueno = await reporte(`inventory?${rango}`, DUENO);
    expect(dueno.rows.map((r) => r["label"])).toEqual([harina, `Aceite ${RUN}`]);
    // Quien no lo ve: por nombre. El mismo dato, y el orden ya no dice cuál vale más.
    const almacen = await reporte(`inventory?${rango}`, ALMACEN);
    expect(almacen.rows.map((r) => r["label"])).toEqual([`Aceite ${RUN}`, harina]);
    expect(almacen.rows.every((r) => r["value"] === null)).toBe(true);
  });

  it("(6) cierres de caja exige treasury.read, como su lista: cash_register.read no lo abre", async () => {
    // Un rol a medida con «Consultar cajas» y sin «Ver el dinero», sumado al almacenista.
    const rol = crypto.randomUUID();
    await sql.begin(async (tx) => {
      const [m] = await tx<{ id: string; tenant_id: string }[]>`
        select m.id, m.tenant_id from public.memberships m
          join public.companies c on c.tenant_id = m.tenant_id
         where m.user_id = ${ALMACEN} and c.id = ${COMPANY}`;
      await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
               values (${rol}, null, ${`e2erep_cajas_${RUN}`}, 'Mira cajas e2e', false)`;
      await tx`insert into public.role_permissions (role_id, permission_key)
               values (${rol}, 'cash_register.read')`;
      await tx`insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
               values (${m!.tenant_id}, ${m!.id}, ${rol}, ${COMPANY})`;
    });
    const [puede] = await sql<{ cajas: boolean; dinero: boolean }[]>`
      select platform.ladino_user_has_permission(${ALMACEN}, 'cash_register.read', ${COMPANY}) as cajas,
             platform.ladino_user_has_permission(${ALMACEN}, 'treasury.read', ${COMPANY}) as dinero`;
    expect(puede).toEqual({ cajas: true, dinero: false });
    const r = await pedir("GET", `/v1/reports/cash-closings?from=${HOY}&to=${HOY}`, ALMACEN);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { message: string }).message).toContain("treasury.read");
    // La lista del módulo dice lo mismo a la misma persona.
    expect((await pedir("GET", "/v1/cash-closings", ALMACEN)).status).toBe(403);
  });

  it("(4)(1) una devolución resta de «vendido en el período», de la cantidad vendida y de la venta", async () => {
    const rango = `from=${HOY}&to=${HOY}`;
    const harina = `Harina Abasto Reportes ${RUN}`;
    const antes = await reporte(`sales?${rango}`, DUENO);
    const [fiado] = await sql<{ doc: string; linea: string; base: string }[]>`
      select d.id as doc, l.id as linea,
             round(l.line_subtotal_functional / l.quantity, 2)::text as base
        from public.documents d join public.document_lines l on l.document_id = d.id
       where d.company_id = ${COMPANY} and d.customer_id = ${CLIENTE} and d.kind = 'receipt'`;
    // De las 2 unidades fiadas vuelve 1 (devolución PARCIAL), con su mercancía.
    const dev = await pedir("POST", "/v1/returns", DUENO, {
      company_id: COMPANY,
      source_document_id: fiado!.doc,
      warehouse_id: DEPOSITO,
      reason: "Devolvió un paquete sin abrir",
      lines: [{ source_line_id: fiado!.linea, quantity: "1" }],
    });
    expect(dev.status, await dev.clone().text()).toBe(201);
    const confirmada = await pedir(
      "POST",
      `/v1/returns/${((await dev.json()) as { id: string }).id}/confirm`,
      DUENO,
    );
    expect(confirmada.status, await confirmada.clone().text()).toBe(200);

    const inv = await reporte(`inventory?${rango}`, DUENO);
    const fila = inv.rows.find((r) => r["label"] === harina)!;
    // Salieron 3 por ventas y volvió 1: vendido 2; en existencia, 9 + 1.
    expect(fila).toMatchObject({ quantity: "10", sold: "2" });
    // 10 en existencia a 2 por día: 5 días.
    expect(fila["days_of_stock"]).toBe("5");

    const porProducto = await reporte(`sales?${rango}&group=product`, DUENO);
    expect(porProducto.rows.find((r) => r["label"] === harina)).toMatchObject({ quantity: "2" });
    const despues = await reporte(`sales?${rango}`, DUENO);
    const [resta] = await sql<{ ok: boolean }[]>`
      select ${antes.totals["base"]!}::numeric - ${fiado!.base}::numeric
               = ${despues.totals["base"]!}::numeric as ok`;
    expect(resta!.ok).toBe(true);
  });

  it("sin tasa de hoy, las carteras dicen null con «sin_tasa» y conservan el nominal (también en el CSV)", async () => {
    // La venta fiada está en dólares; y se suma una compra en dólares al mismo proveedor.
    const [doc] = await sql<{ moneda: string }[]>`
      select transaction_currency as moneda from public.documents
       where company_id = ${COMPANY} and customer_id = ${CLIENTE} and kind = 'receipt'`;
    expect(doc!.moneda).toBe("USD");
    const compra = await pedir("POST", "/v1/purchases/simple", DUENO, {
      company_id: COMPANY,
      supplier_id: PROVEEDOR,
      warehouse_id: DEPOSITO,
      currency: "USD",
      supplier_document_number: `FD-${RUN}`,
      supplier_control_number: `CD-${RUN}`,
      lines: [{ product_id: PRODUCTO, quantity: "1", unit_price: "1" }],
    });
    expect(compra.status, await compra.clone().text()).toBe(201);
    const proveedor = `Proveedor de Abasto Reportes ${RUN}`;

    // Con tasa, por HTTP, las dos carteras tienen cifra.
    expect(linea(await reporte("receivables", DUENO), "debt")!.value).not.toBeNull();
    expect(linea(await reporte("payables", DUENO), "debt")!.value).not.toBeNull();

    // SIN tasa. La tabla de tasas es GLOBAL y otros E2E corren a la vez: no se borra de verdad.
    // Se borra dentro de una transacción que se REVIERTE, y dentro de ella se llama a la MISMA
    // lectura del dominio que sirve la ruta y al MISMO generador del CSV. Lo único que no pasa
    // por aquí es el `c.json(tabla)` del handler, que ya ejercitan los demás casos.
    let visto = false;
    await sql
      .begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
        await tx`delete from public.exchange_rates`;
        const [fuente] = await tx<{ cxc: string; cxp_usd: string; cxp_ves: string }[]>`
          select (select round(sum(dd.nominal), 2)::text
                    from public.documents d
                   cross join lateral platform.document_debt(${COMPANY}, d.id) dd
                   where d.company_id = ${COMPANY} and d.customer_id = ${CLIENTE}
                     and d.kind = 'receipt') as cxc,
                 (select round(sum(platform.supplier_invoice_balance(${COMPANY}, i.id)), 2)::text
                    from public.supplier_invoices i
                   where i.company_id = ${COMPANY} and i.transaction_currency = 'USD') as cxp_usd,
                 (select round(sum(platform.supplier_invoice_balance(${COMPANY}, i.id)), 2)::text
                    from public.supplier_invoices i
                   where i.company_id = ${COMPANY} and i.transaction_currency = 'VES') as cxp_ves`;
        expect(Number(fuente!.cxc)).toBeGreaterThan(0);
        expect(Number(fuente!.cxp_usd)).toBeGreaterThan(0);

        const cxc = (await receivablesReport(tx, COMPANY, { all: true }))!;
        const fila = cxc.rows.find((r) => r["label"] === NOMBRE_CLIENTE)!;
        expect(fila["debt"]).toBeNull();
        expect(fila["b_0-30"]).toBeNull();
        // El nominal SÍ se conoce, en su columna y con su moneda.
        expect(fila["nominal_USD"]).toBe(fuente!.cxc);
        expect(cxc.columns.find((c) => c.key === "nominal_USD")).toMatchObject({
          kind: "money",
          currency: "USD",
        });
        expect(cxc.totals["debt"]).toBeNull();
        expect(cxc.totals["nominal_USD"]).toBe(fuente!.cxc);
        expect(cxc.summary.find((x) => x.key === "debt")).toMatchObject({
          value: null,
          reason: "sin_tasa",
        });
        // Nada vencido (vence en 15 días): eso sí se sabe sin tasa, y es cero, no null.
        expect(fila["overdue"]).toBe("0.00");

        const cxp = (await payablesReport(tx, COMPANY, { all: true }))!;
        const debo = cxp.rows.find((r) => r["label"] === proveedor)!;
        expect(debo["debt"]).toBeNull();
        expect(debo["nominal_USD"]).toBe(fuente!.cxp_usd);
        // Lo que se le debe en bolívares no necesita tasa: su nominal sigue ahí.
        expect(debo["nominal_VES"]).toBe(fuente!.cxp_ves);
        expect(cxp.totals["debt"]).toBeNull();
        expect(cxp.summary.find((x) => x.key === "debt")).toMatchObject({
          value: null,
          reason: "sin_tasa",
        });

        // La descarga lo dice con palabras, nunca con un cero ni con una celda vacía.
        const coma = (v: string) => v.replace(".", ",");
        for (const [tabla, nombre, nominal] of [
          [cxc, NOMBRE_CLIENTE, coma(fuente!.cxc)],
          [cxp, proveedor, coma(fuente!.cxp_usd)],
        ] as const) {
          const lineas = new TextDecoder().decode(csvDeReporte(tabla).slice(3)).split("\r\n");
          const renglon = lineas.find((l) => l.startsWith(`${nombre};`))!;
          expect(renglon).toContain(";Falta la tasa de hoy;");
          expect(renglon.split(";")).toContain(nominal);
          expect(lineas.find((l) => l.startsWith("Total;"))).toContain(";Falta la tasa de hoy;");
        }
        visto = true;
        throw new Error("revertir");
      })
      .catch((e: unknown) => {
        if (!(e instanceof Error) || e.message !== "revertir") throw e;
      });
    expect(visto).toBe(true);
    // La tasa de los demás sigue donde estaba.
    expect(linea(await reporte("receivables", DUENO), "debt")!.value).not.toBeNull();
  });

  it("(6) cierres de caja con diferencia: el faltante de uno y el sobrante de otro, cada cual con su signo", async () => {
    const m = await pedir("POST", "/v1/members", DUENO, {
      company_id: COMPANY,
      email: `encargado-rep-${RUN}@e2e.ladino`,
      // La caja de una empresa recién fundada es la de sistema: solo la cierra quien ve el dinero.
      role_key: "owner",
    });
    expect(m.status).toBe(201);
    const [caja] = await sql<{ id: string }[]>`
      select account_id as id from public.payments where document_id = ${RECIBO}`;
    // El dueño cuenta 1 bolívar donde había lo de la venta al contado: FALTA.
    const c1 = await pedir("POST", "/v1/cash-closings", DUENO, {
      company_id: COMPANY,
      account_id: caja!.id,
      counted_amount: "1.00",
      reason: "Faltan billetes de la gaveta",
    });
    expect(c1.status, await c1.clone().text()).toBe(201);
    const faltante = ((await c1.json()) as { difference: string }).difference;
    expect(faltante.startsWith("-")).toBe(true);
    // La socia cuenta después 6 donde quedó 1: SOBRAN 5.
    const c2 = await pedir("POST", "/v1/cash-closings", ENCARGADO, {
      company_id: COMPANY,
      account_id: caja!.id,
      counted_amount: "6.00",
      reason: "Apareció un billete de cinco",
    });
    expect(c2.status, await c2.clone().text()).toBe(201);
    expect(((await c2.json()) as { difference: string }).difference).toBe("5.00");

    const rango = `from=${HOY}&to=${HOY}`;
    const t = await reporte(`cash-closings?${rango}`, DUENO);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]).toMatchObject({
      closing_date: HOY,
      moneda: "VES",
      counted: "1.00",
      difference: faltante,
      difference_functional: faltante,
      reason: "Faltan billetes de la gaveta",
    });
    expect(t.rows[1]).toMatchObject({
      expected: "1.00",
      counted: "6.00",
      difference: "5.00",
      reason: "Apareció un billete de cinco",
    });
    // Faltante y sobrante NO se compensan en el resumen: cada uno con su signo.
    expect(linea(t, "closings")!.value).toBe("2");
    expect(linea(t, "with_difference")!.value).toBe("2");
    expect(linea(t, "shortage")!.value).toBe(faltante);
    expect(linea(t, "surplus")!.value).toBe("5.00");
    const [neto] = await sql<{ n: string }[]>`
      select round(${faltante}::numeric + 5, 2)::text as n`;
    expect(t.totals["difference_functional"]).toBe(neto!.n);

    // Por cajero: dos personas, y a cada una lo suyo (el peor resultado, primero).
    const porCajero = await reporte(`cash-closings?${rango}&group=cashier`, DUENO);
    expect(porCajero.rows).toHaveLength(2);
    expect(porCajero.rows[0]).toMatchObject({
      closings: "1",
      with_difference: "1",
      shortage: faltante,
      surplus: "0.00",
      difference_functional: faltante,
    });
    expect(porCajero.rows[1]).toMatchObject({
      closings: "1",
      shortage: "0.00",
      surplus: "5.00",
      difference_functional: "5.00",
    });
    expect(porCajero.totals["difference_functional"]).toBe(neto!.n);
    // Otro día no trae nada.
    expect((await reporte("cash-closings?from=2026-06-10&to=2026-06-10", DUENO)).rows).toEqual([]);
  });

  it("(5b) lo vencido con proveedores es lo que ap_aging pone más allá de su vencimiento: con fecha acordada y sin ella", async () => {
    // Tres facturas de fechas pasadas, copiadas de la compra real para llevar las columnas que
    // exige el esquema. Por SQL, como dueño de la base: la regla de impuesto de esta empresa rige
    // desde hoy y la API no deja fechar una compra antes.
    //   A · de hace 40 días, vencía hace 10  → VENCIDA, con fecha acordada   · Bs 100
    //   B · de hace 10 días, sin fecha       → VENCIDA desde su emisión      · Bs 200
    //   C · de hace 20 días, vence en 5 días → por vencer, con fecha acordada · Bs 400
    const s2 = await pedir("POST", "/v1/suppliers", DUENO, {
      company_id: COMPANY,
      tax_id: `J-3${String(Date.now()).slice(-7)}-0`,
      legal_name: `Otro proveedor ${RUN}`,
      supplier_kind: "nacional",
      person_type_code: "juridica",
      taxpayer_type_code: "ordinario",
    });
    expect(s2.status, await s2.clone().text()).toBe(201);
    const otro = ((await s2.json()) as { id: string }).id;
    // Facturas `posted` sin asiento ni fila de cola: dentro de una transacción que se revierte.
    await revertido(async (tx) => {
      for (const [letra, proveedor, emitida, vence, importe] of [
        ["A", PROVEEDOR, diaCaracas(-40), diaCaracas(-10), "100"],
        ["B", otro, diaCaracas(-10), null, "200"],
        ["C", otro, diaCaracas(-20), diaCaracas(5), "400"],
      ] as const) {
        await tx`
        insert into public.supplier_invoices
          (tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
           invoice_date, due_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
           tax_is_recoverable, retention_total, amount_transaction_currency, transaction_currency,
           fx_rate, functional_amount, functional_currency, rate_source, rate_timestamp,
           rounding_policy_id, created_by, fiscal_support)
        select tenant_id, company_id, ${proveedor}, ${`FV${letra}-${RUN}`}, ${`CV${letra}-${RUN}`},
               ${emitida}::date, ${vence}::date, 'posted', now(), ${importe}::numeric, 0,
               ${importe}::numeric, tax_is_recoverable, 0, ${importe}::numeric, 'VES', 1,
               ${importe}::numeric, 'VES', 'identidad', now(), rounding_policy_id, created_by,
               fiscal_support
          from public.supplier_invoices
         where company_id = ${COMPANY} and transaction_currency = 'VES'
         order by created_at limit 1`;
      }
      // El fixture tiene las dos clases: facturas con fecha de vencimiento y sin ella.
      const [clases] = await tx<{ con: number; sin: number }[]>`
      select (count(*) filter (where due_date is not null))::int as con,
             (count(*) filter (where due_date is null))::int as sin
        from public.supplier_invoices where company_id = ${COMPANY}`;
      expect(clases!.con).toBeGreaterThan(0);
      expect(clases!.sin).toBeGreaterThan(0);

      const t = (await payablesReport(tx, COMPANY, {}))!;
      // LA FUENTE: ap_aging mide los días desde el vencimiento (el acordado o, sin él, el de la
      // factura). Vista 30 días después de hoy, todo lo que YA venció hoy cae fuera del primer
      // tramo: eso, por proveedor, es «lo vencido».
      const fuente = await tx<{ id: string; vencido: string }[]>`
      select a.supplier_id::text as id,
             round(coalesce(sum(a.amount) filter (where a.bucket <> '0-30'), 0), 2)::text as vencido
        from platform.ap_aging(${COMPANY}, null, ${HOY}::date + 30) a
       group by a.supplier_id`;
      expect(fuente.length).toBe(t.rows.length);
      for (const f of fuente) {
        const fila = t.rows.find((r) => r["id"] === f.id)!;
        expect(fila["overdue"], fila["label"] ?? "").toBe(f.vencido);
      }
      const [total] = await tx<{ v: string }[]>`
      select round(coalesce(sum(a.amount) filter (where a.bucket <> '0-30'), 0), 2)::text as v
        from platform.ap_aging(${COMPANY}, null, ${HOY}::date + 30) a`;
      expect(t.totals["overdue"]).toBe(total!.v);
      // Y no es cero ni es todo: hay vencido y hay por vencer.
      const [forma] = await tx<{ hay: boolean; menos: boolean }[]>`
      select ${total!.v}::numeric > 0 as hay,
             ${total!.v}::numeric < ${t.totals["debt"]!}::numeric as menos`;
      expect(forma).toEqual({ hay: true, menos: true });
      // Ordenada por lo vencido, el que más tiene vencido va primero.
      const porVencido = (await payablesReport(tx, COMPANY, { sort: "overdue_desc" }))!;
      const [orden] = await tx<{ ok: boolean }[]>`
      select coalesce(bool_and(a >= b), true) as ok
        from (select x::numeric as a, lead(x::numeric) over (order by n) as b
                from unnest(${porVencido.rows.map((r) => r["overdue"]!)}::text[])
                     with ordinality as u(x, n)) p
       where b is not null`;
      expect(orden!.ok).toBe(true);
    });
  });

  it("(2) margen: una devolución devuelve su costo; la de una línea SIN costo no resta de la venta con costo; servicio y nota de débito son todo margen", async () => {
    // Un día aparte (12 de junio), con documentos escritos por SQL —copiados del recibo real para
    // llevar las columnas que exige el esquema— porque una línea de mercancía SIN costo no se
    // puede vender por la API de esta empresa. En bolívares, sin impuesto:
    //   R1 recibo        · 2 harinas a 100, costo 30 c/u      → venta 200, costo 60
    //   R2 recibo        · 1 harina a 100, SIN costo cargado  → venta sin costo 100
    //   R3 recibo        · 1 flete (servicio) a 50            → venta 50, costo 0
    //   D1 nota de débito· recargo de 40                      → venta 40, costo 0
    //   V1 devolución de 1 harina de R1 (con mercancía)       → venta −100, costo −30
    //   V2 devolución de la harina de R2 (la que no tenía costo) → venta sin costo −100
    // Todo dentro de una transacción que se revierte (ver `revertido`): recibos `paid` sin cobro,
    // asiento ni kardex y una nota de débito en la serie del recibo no son un estado de la API.
    const DIA = "2026-06-12 10:00:00-04";
    await revertido(async (tx) => {
      const [srv] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      select tenant_id, company_id, ${`SRV-${RUN}`}, ${`Flete ${RUN}`}, 'service', status,
             unit_code, tax_category_code
        from public.products where id = ${PRODUCTO}
      returning id`;
      const documento = async (
        numero: number,
        kind: string,
        importe: string,
        origen: string | null = null,
      ): Promise<string> => {
        const [d] = await tx<{ id: string }[]>`
        insert into public.documents
          (tenant_id, company_id, branch_id, kind, series, customer_id, document_number, status,
           issued_at, regime_version_id, transaction_currency, functional_currency, fx_rate,
           rate_source, rate_timestamp, rounding_policy_id, amount_transaction_currency,
           functional_amount, subtotal_amount, tax_amount, total_amount, created_by,
           source_document_id)
        select tenant_id, company_id, branch_id, ${kind}, series, customer_id, ${numero}, 'paid',
               ${DIA}::timestamptz, regime_version_id, 'VES', 'VES', 1, 'identidad',
               ${DIA}::timestamptz, rounding_policy_id, ${importe}::numeric, ${importe}::numeric,
               ${importe}::numeric, 0, ${importe}::numeric, created_by, ${origen}::uuid
          from public.documents where id = ${RECIBO}
        returning id`;
        return d!.id;
      };
      const linea1 = async (
        doc: string,
        producto: string,
        cantidad: string,
        importe: string,
        costo: string | null,
      ): Promise<string> => {
        const [l] = await tx<{ id: string }[]>`
        insert into public.document_lines
          (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
           unit_price_transaction, unit_price_functional, price_list_applied_id, tax_rule_id,
           tax_rate_snapshot, tax_amount, line_subtotal_transaction, line_subtotal_functional,
           line_total_transaction, line_total_functional, amount_transaction_currency,
           transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
           rate_timestamp, rounding_policy_id, cost_snapshot, created_by, tax_category_snapshot,
           tax_treatment, operation_type)
        select tenant_id, company_id, ${doc}, 1, ${producto}, 'Línea de prueba', ${cantidad}::numeric,
               ${importe}::numeric / ${cantidad}::numeric, ${importe}::numeric / ${cantidad}::numeric,
               price_list_applied_id, tax_rule_id, 0, 0, ${importe}::numeric, ${importe}::numeric,
               ${importe}::numeric, ${importe}::numeric, ${importe}::numeric, 'VES', 1,
               ${importe}::numeric, 'VES', 'identidad', ${DIA}::timestamptz, rounding_policy_id,
               ${costo}::numeric, created_by, tax_category_snapshot, tax_treatment, operation_type
          from public.document_lines where document_id = ${RECIBO}
         order by line_number limit 1
        returning id`;
        return l!.id;
      };
      const devolucion = async (
        origen: string,
        nota: string,
        lineaOrigen: string,
        costo: string | null,
      ): Promise<void> => {
        const [r] = await tx<{ id: string }[]>`
        insert into public.returns
          (tenant_id, company_id, source_document_id, credit_note_id, status, reason,
           warehouse_id, confirmed_at, created_by)
        select tenant_id, company_id, ${origen}, ${nota}, 'confirmed', 'Devolución de prueba',
               ${DEPOSITO}, ${DIA}::timestamptz, created_by
          from public.documents where id = ${RECIBO}
        returning id`;
        await tx`
        insert into public.return_lines
          (tenant_id, company_id, return_id, source_line_id, product_id, quantity,
           unit_cost_original, unit_price_transaction)
        select tenant_id, company_id, ${r!.id}, ${lineaOrigen}, ${PRODUCTO}, 1,
               coalesce(${costo}::numeric, 0), 100
          from public.documents where id = ${RECIBO}`;
      };

      const r1 = await documento(910001, "receipt", "200");
      const l1 = await linea1(r1, PRODUCTO, "2", "200", "30");
      const r2 = await documento(910002, "receipt", "100");
      const l2 = await linea1(r2, PRODUCTO, "1", "100", null);
      const r3 = await documento(910003, "receipt", "50");
      await linea1(r3, srv!.id, "1", "50", null);
      const d1 = await documento(910004, "debit_note", "40", r1);
      await linea1(d1, PRODUCTO, "1", "40", null);
      const v1 = await documento(910005, "receipt_return", "100", r1);
      await linea1(v1, PRODUCTO, "1", "100", null);
      await devolucion(r1, v1, l1, "30");
      const v2 = await documento(910006, "receipt_return", "100", r2);
      await linea1(v2, PRODUCTO, "1", "100", null);
      await devolucion(r2, v2, l2, null);

      const rango = { from: "2026-06-12", to: "2026-06-12" };
      const t = (await marginReport(tx, COMPANY, { ...rango, group: "day" }))!;
      // Venta con costo: 200 + 50 + 40 − 100 = 190. Costo: 60 − 30 = 30. Margen: 160.
      // La harina sin costo se vendió (100) y se devolvió (−100): «venta sin costo» queda en cero y
      // NO le resta nada a la venta con costo.
      expect(t.totals).toMatchObject({
        sales: "190.00",
        cost: "30.00",
        margin: "160.00",
        margin_pct: "84.21",
        sales_without_cost: "0.00",
      });
      expect(t.rows).toEqual([
        expect.objectContaining({
          label: "2026-06-12",
          sales: "190.00",
          cost: "30.00",
          margin: "160.00",
          sales_without_cost: "0.00",
        }),
      ]);
      // La nota cuenta las líneas VENDIDAS sin costo: una (la harina de R2). Su devolución (V2)
      // también tiene el costo en null —resta de «venta sin costo»—, pero no es otra línea vendida.
      const sinCosto = t.notes.filter((n) => n.includes("sin costo cargado"));
      expect(sinCosto).toHaveLength(1);
      expect(sinCosto[0]).toContain("1 línea(s) de mercancía se vendieron sin costo cargado");
      // Por producto: el servicio es todo margen; la mercancía lleva lo demás.
      const porProducto = (await marginReport(tx, COMPANY, rango))!;
      expect(porProducto.rows.find((r) => r["label"] === `Flete ${RUN}`)).toMatchObject({
        sales: "50.00",
        cost: "0.00",
        margin: "50.00",
        margin_pct: "100.00",
      });
      expect(
        porProducto.rows.find((r) => r["label"] === `Harina Abasto Reportes ${RUN}`),
      ).toMatchObject({
        sales: "140.00",
        cost: "30.00",
        margin: "110.00",
        sales_without_cost: "0.00",
      });
      // Y el margen sigue cuadrando con la venta: con costo + sin costo = base de ventas.
      const ventas = (await salesReport(tx, COMPANY, rango))!;
      expect(ventas.totals["base"]).toBe("190.00");
    });
  });

  it("(2) margen de un producto COMPUESTO: su costo es lo que sacaron sus ingredientes, y lo que vuelve con una devolución (I-04)", async () => {
    // La línea vendida de un compuesto NO lleva `cost_snapshot`: su costo son las salidas de sus
    // ingredientes, escritas en `sale_line_components`. Por HTTP, de punta a punta:
    //   masa  · 10 a Bs 40    · media por arepa → 3 arepas sacan 1,5 = 60,00
    //   queso ·  9 a Bs 17,67 · uno por arepa   → 3 arepas sacan 3   = 53,01
    const ingrediente = async (nombre: string, cantidad: string, costo: string) => {
      const p = await pedir("POST", "/v1/products/simple", DUENO, {
        company_id: COMPANY,
        name: nombre,
        price: { amount: "1", currency: "USD" },
        initial_stock: { quantity: cantidad, unit_cost: { amount: costo, currency: "VES" } },
      });
      expect(p.status, await p.clone().text()).toBe(201);
      return ((await p.json()) as { product: { id: string } }).product.id;
    };
    const masa = await ingrediente(`Masa ${RUN}`, "10", "40");
    const queso = await ingrediente(`Queso ${RUN}`, "9", "17.67");
    const nombre = `Arepa rellena ${RUN}`;
    const alta = await pedir("POST", "/v1/products", DUENO, {
      company_id: COMPANY,
      sku: `AREPA-${RUN}`,
      name: nombre,
      kind: "good",
      unit_code: "unidad",
      is_composed: true,
    });
    expect(alta.status, await alta.clone().text()).toBe(201);
    const arepa = ((await alta.json()) as { id: string }).id;
    const receta = await pedir("PUT", `/v1/products/${arepa}/recipe`, DUENO, {
      company_id: COMPANY,
      lines: [
        { child_product_id: masa, quantity: "0.5", unit_code: "unidad" },
        { child_product_id: queso, quantity: "1", unit_code: "unidad" },
      ],
    });
    expect(receta.status, await receta.clone().text()).toBe(200);
    // Su precio, en la lista con que vende la empresa (como dueño de la base).
    const precio = await sql`
      insert into public.price_list_items
        (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
      select s.tenant_id, s.company_id, s.default_price_list_id, ${arepa}, 5,
             now() - interval '1 day'
        from public.company_settings s
       where s.company_id = ${COMPANY} and s.default_price_list_id is not null
      returning id`;
    expect(precio).toHaveLength(1);

    const venta = await pedir("POST", "/v1/pos/sales", DUENO, {
      company_id: COMPANY,
      warehouse_id: DEPOSITO,
      customer_id: CLIENTE,
      lines: [{ product_id: arepa, quantity: "3" }],
      due_date: venceDeFixture(),
    });
    expect(venta.status, await venta.clone().text()).toBe(201);
    const recibo = ((await venta.json()) as { document: { id: string } }).document.id;
    const [vendida] = await sql<{ id: string; sin_costo: boolean }[]>`
      select id, cost_snapshot is null as sin_costo from public.document_lines
       where document_id = ${recibo} and product_id = ${arepa}`;
    // La premisa: la línea no lleva costo propio. Sin leer sus componentes, era «venta sin costo».
    expect(vendida!.sin_costo).toBe(true);

    // LA FUENTE, como dueño de la base: lo vendido menos lo devuelto, y lo que salió menos lo que
    // volvió de los ingredientes de ESTE compuesto.
    const fuente = async () => {
      const [f] = await sql<
        { venta: string; costo: string; margen: string; salidas: number; reingresos: number }[]
      >`
        with v as (
          select sum(case when d.kind in ('credit_note', 'receipt_return') then -1 else 1 end
                     * l.line_subtotal_functional) as venta
            from public.documents d join public.document_lines l on l.document_id = d.id
           where d.company_id = ${COMPANY} and l.product_id = ${arepa}
        ), c as (
          select coalesce(sum(functional_amount) filter (where direction = 'out'), 0)
                   - coalesce(sum(functional_amount) filter (where direction = 'back'), 0) as costo,
                 (count(*) filter (where direction = 'out'))::int as salidas,
                 (count(*) filter (where direction = 'back'))::int as reingresos
            from public.sale_line_components
           where company_id = ${COMPANY} and parent_product_id = ${arepa}
        )
        select round(v.venta, 2)::text as venta, round(c.costo, 2)::text as costo,
               round(v.venta - c.costo, 2)::text as margen, c.salidas, c.reingresos
          from v, c`;
      return f!;
    };
    const margenDeLaArepa = async () => {
      const t = await reporte(`margin?from=${HOY}&to=${HOY}`, DUENO);
      return { fila: t.rows.find((r) => r["label"] === nombre), notas: t.notes.join(" ") };
    };

    // (a) Vendidas 3: costo = 60,00 + 53,01, exacto; margen = venta − costo.
    const f1 = await fuente();
    expect(f1).toMatchObject({ costo: "113.01", salidas: 2, reingresos: 0 });
    const m1 = await margenDeLaArepa();
    expect(m1.fila).toMatchObject({
      sales: f1.venta,
      cost: "113.01",
      margin: f1.margen,
      sales_without_cost: "0.00",
    });
    // Y no cuenta como línea vendida sin costo.
    expect(m1.notas).not.toContain("sin costo cargado");

    // (b) Vuelve 1, con su mercancía: reingresan media masa (20,00) y un queso (17,67).
    const dev = await pedir("POST", "/v1/returns", DUENO, {
      company_id: COMPANY,
      source_document_id: recibo,
      warehouse_id: DEPOSITO,
      reason: "Devolvió una arepa",
      lines: [{ source_line_id: vendida!.id, quantity: "1" }],
    });
    expect(dev.status, await dev.clone().text()).toBe(201);
    const confirmada = await pedir(
      "POST",
      `/v1/returns/${((await dev.json()) as { id: string }).id}/confirm`,
      DUENO,
    );
    expect(confirmada.status, await confirmada.clone().text()).toBe(200);
    const f2 = await fuente();
    expect(f2).toMatchObject({ costo: "75.34", salidas: 2, reingresos: 2 });
    const m2 = await margenDeLaArepa();
    expect(m2.fila).toMatchObject({
      sales: f2.venta,
      cost: "75.34",
      margin: f2.margen,
      sales_without_cost: "0.00",
    });
    expect(m2.notas).not.toContain("sin costo cargado");
    // La venta bajó con la devolución: no es la misma cifra dos veces.
    expect(f2.venta).not.toBe(f1.venta);
  });

  it("la consulta se valida: fechas con forma, en orden, y un formato conocido", async () => {
    for (const q of [
      "sales",
      "sales?from=2026-09-01",
      "sales?from=2026-09-10&to=2026-09-01",
      "sales?from=01/09/2026&to=2026-09-10",
      `sales?from=${HOY}&to=${HOY}&group=color`,
      `sales?from=${HOY}&to=${HOY}&format=pdf`,
      `margin?from=${HOY}&to=${HOY}&group=customer`,
      "igtf?to=2026-09-10",
      // Con forma de fecha y sin serlo: 422 con su mensaje, no un 500 de Postgres (22008).
      "sales?from=2026-02-30&to=2026-03-01",
      "igtf?from=2026-01-01&to=2026-13-01",
      "cash-closings?from=2026-04-31&to=2026-05-01",
    ]) {
      expect((await pedir("GET", `/v1/reports/${q}`, DUENO)).status, q).toBe(422);
    }
  });
});

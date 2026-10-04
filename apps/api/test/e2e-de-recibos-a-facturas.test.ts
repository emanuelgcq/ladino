import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { avisoYaFactura } from "@ladino/domain";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * DE RECIBOS A FACTURAS (recorrido 2026-09-24, bloque M; respuesta del dueño del 2026-09-28).
 *
 * Un negocio nace sin RIF, vende con recibo, obtiene su RIF y activa la facturación. Todo por
 * HTTP; por SQL solo la tasa del día. Cada caso asevera lo que SOLO produce su arreglo:
 *
 *   M-12 · el recibo viejo se devuelve con RECIBO DE DEVOLUCIÓN aunque la empresa ya facture
 *          (antes: 409 REGIME_KIND_NOT_ALLOWED en el dominio y LAD49 en la base): el documento
 *          es `receipt_return`, serie D, sin número de control y sin IVA;
 *   M-09 · `GET /v1/fiscal/setup` dice `invoicing_notice` = true tras el cambio (la caja enseña
 *          «Ya facturas con tu RIF»), y false mientras vendía con recibos;
 *   M-11 · los recibos de antes del RIF quedan como estaban: mismo régimen congelado, mismo
 *          emisor congelado, y la devolución tampoco es documento fiscal.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const DUENO = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let COMPANY = "";
let DEPOSITO = "";
let PRODUCTO = "";
let RECIBO = "";
let RECIBO_DEVOLUCION = "";
let RECIBO_ANTES: Record<string, unknown> = {};

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
  const headers: Record<string, string> = { Authorization: `Bearer ${await tokenDe(DUENO)}` };
  if (COMPANY !== "") headers["X-Company-Id"] = COMPANY;
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

const congelado = async (id: string) =>
  (
    await sql<Record<string, unknown>[]>`
      select kind, status, series, document_number::text as n, regime_version_id,
             issuer_tax_id_snapshot, total_amount::text as total, tax_amount::text as iva
        from public.documents where id = ${id}`
  )[0]!;

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id, email) values (${DUENO}, ${`m12-${RUN}@e2e.ladino`})
            on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), 'e2e-m12'
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = ${HOY}::date)`;
  });
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

// Cada caso encadena varias operaciones reales (fundar, vender, devolver): más de 5 s.
describe("de recibos a facturas", { timeout: 60_000 }, () => {
  it("nace sin RIF, vende con recibo, y la caja todavía no dice «ya facturas»", async () => {
    const r = await pedir("POST", "/v1/onboarding", { business_name: `Bodega M-12 ${RUN}` });
    expect(r.status).toBe(201);
    const fundado = (await r.json()) as { company_id: string; warehouse_id: string };
    COMPANY = fundado.company_id;
    DEPOSITO = fundado.warehouse_id;

    const p = await pedir("POST", "/v1/products/simple", {
      company_id: COMPANY,
      name: "Harina precocida",
      price: { amount: "2", currency: "USD" },
      initial_stock: { quantity: "10", unit_cost: { amount: "40", currency: "VES" } },
    });
    expect(p.status).toBe(201);
    PRODUCTO = ((await p.json()) as { product: { id: string } }).product.id;

    const cot = await pedir("POST", "/v1/pos/quote", {
      company_id: COMPANY,
      lines: [{ product_id: PRODUCTO, quantity: "2" }],
    });
    expect(cot.status).toBe(200);
    const total = ((await cot.json()) as { functional_total: string }).functional_total;
    const v = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: DEPOSITO,
      lines: [{ product_id: PRODUCTO, quantity: "2" }],
      payments: [{ instrument: "efectivo_bs", amount: total, currency: "VES" }],
    });
    expect(v.status).toBe(201);
    const venta = (await v.json()) as { document: { id: string; kind: string } };
    expect(venta.document.kind).toBe("receipt");
    RECIBO = venta.document.id;
    RECIBO_ANTES = await congelado(RECIBO);

    const setup = (await (await pedir("GET", "/v1/fiscal/setup")).json()) as {
      sales_mode: string;
      invoicing_notice: boolean;
    };
    expect(setup.sales_mode).toBe("recibos");
    expect(setup.invoicing_notice).toBe(false);
  });

  it("M-09 · pone su RIF, activa las facturas, y la caja dice «ya facturas»", async () => {
    const digitos = String(Date.now() % 100_000_000).padStart(8, "0");
    const direccion = await pedir("PUT", "/v1/companies/fiscal-address", {
      fiscal_address: "Av. Lara con calle 8, local 3, Barquisimeto",
    });
    expect(direccion.status).toBe(200);
    const rif = await pedir("PUT", "/v1/companies/tax-id", {
      tax_id: `V${digitos}0`,
      legal_name: `Bodega M-12 ${RUN}, F.P.`,
    });
    expect(rif.status).toBe(200);
    const regimen = await pedir("POST", "/v1/fiscal/regime", { regime_code: "formatos_libres" });
    expect(regimen.status).toBe(201);

    const setup = (await (await pedir("GET", "/v1/fiscal/setup")).json()) as {
      sales_mode: string;
      invoicing_notice: boolean;
    };
    expect(setup.sales_mode).toBe("facturas");
    expect(setup.invoicing_notice).toBe(true);
  });

  it("M-12 · el recibo de antes del RIF se devuelve con recibo de devolución, no con NC", async () => {
    const [linea] = await sql<{ id: string }[]>`
      select id from public.document_lines where document_id = ${RECIBO}`;
    const creada = await pedir("POST", "/v1/returns", {
      company_id: COMPANY,
      source_document_id: RECIBO,
      warehouse_id: DEPOSITO,
      reason: "El cliente devolvió una harina",
      lines: [{ source_line_id: linea!.id, quantity: "1" }],
    });
    expect(creada.status).toBe(201);
    const devolucion = ((await creada.json()) as { id: string }).id;
    const confirmada = await pedir("POST", `/v1/returns/${devolucion}/confirm`);
    expect(confirmada.status).toBe(200);
    const nota = ((await confirmada.json()) as { credit_note_id: string }).credit_note_id;
    RECIBO_DEVOLUCION = nota;

    const [doc] = await sql<
      {
        kind: string;
        series: string;
        control: string | null;
        iva: string;
        origen: string;
        regimen: string;
      }[]
    >`
      select d.kind, d.series, d.control_number::text as control, d.tax_amount::text as iva,
             d.source_document_id as origen, r.regime_code as regimen
        from public.documents d
        join public.company_fiscal_regimes r on r.id = d.regime_version_id
       where d.id = ${nota}`;
    // Lo que solo produce el arreglo: un recibo de devolución emitido BAJO el régimen de facturas.
    expect(doc).toEqual({
      kind: "receipt_return",
      series: "D",
      control: null,
      iva: "0.00000000",
      origen: RECIBO,
      regimen: "formatos_libres",
    });
    const [lineaDev] = await sql<{ categoria: string }[]>`
      select tax_category_snapshot as categoria from public.document_lines
       where document_id = ${nota}`;
    expect(lineaDev!.categoria).toBe("no_fiscal");
  });

  it("M-11 · el recibo de antes del RIF queda como historia: nada de él cambió", async () => {
    const ahora = await congelado(RECIBO);
    // El estado puede pasar a lo que la devolución deje; lo congelado no se mueve.
    expect({ ...ahora, status: "" }).toEqual({ ...RECIBO_ANTES, status: "" });
    expect(String(ahora["issuer_tax_id_snapshot"] ?? "")).toMatch(/^PEND/);
    // Fuera de libros: ni el recibo ni su devolución son documentos fiscales.
    const [fiscales] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.documents
       where company_id = ${COMPANY} and kind in ('invoice', 'credit_note', 'debit_note')`;
    expect(fiscales!.n).toBe(0);
  });

  it("los invariantes que cruzan módulos siguen en cero para esta empresa", async () => {
    const [inv] = await sql<{ cobertura: number; anuladas: number; inventario: number }[]>`
      select (select count(*)::int from platform.accounting_coverage_gaps(${COMPANY})) as cobertura,
             (select count(*)::int from platform.annulled_stock_gaps(${COMPANY})) as anuladas,
             (select count(*)::int from platform.inventory_coverage_gaps(${COMPANY})) as inventario`;
    expect(inv).toEqual({ cobertura: 0, anuladas: 0, inventario: 0 });
  });

  it("M-11 · el libro de ventas no trae ni el recibo de antes del RIF ni su devolución", async () => {
    expect(RECIBO_DEVOLUCION).not.toBe("");
    const [libro] = await sql<{ filas: number; de_recibos: number }[]>`
      select count(*)::int as filas,
             count(*) filter (where b.document_id in (${RECIBO}, ${RECIBO_DEVOLUCION})
                                 or b.kind in ('receipt', 'receipt_return'))::int as de_recibos
        from platform.sales_book(${COMPANY}, ${HOY}::date - 1, ${HOY}::date + 1) b`;
    // La empresa ya factura y todavía no emitió ninguna factura: su libro está vacío, y lo que
    // importa es que los dos documentos no fiscales no están en él.
    expect(libro).toEqual({ filas: 0, de_recibos: 0 });
  });
});

/**
 * M-09 · CUÁNDO SE APAGA EL AVISO. El caso de arriba solo ve el aviso ENCENDIDO: un
 * `avisoYaFactura` que devolviera siempre true para quien transicionó lo pasaría. Aquí se
 * siembra, como dato heredado, una empresa que pasó a facturar hace N días de Caracas, con o
 * sin su primera factura, y se lee la función del dominio sobre esa transacción (que se deshace:
 * no queda nada en la base). Regla: 30 días Y hasta la primera factura, lo que tarde más.
 */
class Deshacer extends Error {}

async function avisoTras(dias: number, conFactura: boolean): Promise<boolean> {
  let aviso: boolean | null = null;
  try {
    await sql.begin(async (tx) => {
      const tenant = crypto.randomUUID();
      const company = crypto.randomUUID();
      const customer = crypto.randomUUID();
      const viejo = crypto.randomUUID();
      const nuevo = crypto.randomUUID();
      const nueve = () => String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`insert into public.tenants (id, name) values (${tenant}, 'M-09 heredado')`;
      await tx`
        insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code)
        values (${company}, ${tenant}, ${`J${nueve()}`}, 'M-09 heredado, C.A.', 'VES')`;
      await tx`
        insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                                      person_type_code, taxpayer_type_code)
        values (${customer}, ${tenant}, ${company}, ${`J${nueve()}`}, 'Cliente M-09',
                'juridica', 'ordinario')`;
      // El régimen de facturas rige desde las 08:00 de Caracas de hace `dias` días; antes, recibos.
      await tx`
        insert into public.company_fiscal_regimes
          (id, tenant_id, company_id, regime_code, effective_from, effective_to)
        select v.id, ${tenant}, ${company}, v.codigo, v.desde, v.hasta
          from (select ((platform.caracas_day(now()) - ${dias}::int)::timestamp + interval '8 hours')
                         at time zone 'America/Caracas' as cambio) c,
               lateral (values
                 (${viejo}::uuid, 'sin_facturacion', c.cambio - interval '60 days', c.cambio),
                 (${nuevo}::uuid, 'formatos_libres', c.cambio, null::timestamptz)
               ) as v(id, codigo, desde, hasta)`;
      await tx`
        insert into public.company_taxpayer_types
          (tenant_id, company_id, taxpayer_type_code, effective_from, reason, rules_version)
        values (${tenant}, ${company}, 'ordinario', platform.caracas_day(now()) - ${dias}::int,
                'Dato heredado del test', 'domain-s0.5')`;
      if (conFactura) {
        await tx`
          insert into public.documents
            (tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
             control_number, regime_version_id, rules_version,
             transaction_currency, functional_currency, fx_rate, rate_source,
             amount_transaction_currency, functional_amount, subtotal_amount, tax_amount,
             total_amount)
          select ${tenant}, ${company}, 'invoice', 'A', ${customer}, 'issued',
                 r.effective_from + interval '1 hour', 1, 1, r.id, 'e2e-m09',
                 'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116
            from public.company_fiscal_regimes r where r.id = ${nuevo}`;
      }
      aviso = await avisoYaFactura(tx, company);
      throw new Deshacer();
    });
  } catch (e) {
    if (!(e instanceof Deshacer)) throw e;
  }
  if (aviso === null) throw new Error("la siembra no llegó a leer el aviso");
  return aviso;
}

describe("M-09 · cuándo se apaga «ya facturas»", { timeout: 60_000 }, () => {
  it("31 días y con su primera factura emitida: el aviso se APAGA", async () => {
    expect(await avisoTras(31, true)).toBe(false);
  });

  it("31 días y todavía sin factura: sigue encendido (lo que tarde más)", async () => {
    expect(await avisoTras(31, false)).toBe(true);
  });

  it("menos de 30 días, aunque ya facturó: sigue encendido", async () => {
    expect(await avisoTras(5, true)).toBe(true);
  });

  it("el borde, en días de Caracas: 29 días con factura enciende; 30, apaga", async () => {
    expect(await avisoTras(29, true)).toBe(true);
    expect(await avisoTras(30, true)).toBe(false);
  });

  it("la siembra no deja nada en la base", async () => {
    const [queda] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.companies where legal_name = 'M-09 heredado, C.A.'`;
    expect(queda!.n).toBe(0);
  });
});

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * MODO RECIBOS de extremo a extremo (migración 37): el negocio SIN RIF vende
 * con recibos NO fiscales por el MISMO POS. La narrativa es la vida real:
 *
 *   1. la empresa nace en sin_facturacion y cotiza SIN IVA y SIN reglas
 *      cargadas — un no-inscrito no repercute;
 *   2. vende dos veces: correlativo de recibos 1 y 2, sin huecos, SIN número
 *      de control, tratamiento no_fiscal en las líneas; el asiento cuadra con
 *      DOS líneas (CxC contra ingresos) y CERO líneas de IVA;
 *   3. el PDF dice RECIBO y «Documento no fiscal», sin RIF del emisor;
 *   4. una factura en este régimen rechaza con la voz de persona;
 *   5. LA TRANSICIÓN EN CALIENTE: llega el RIF, /v1/fiscal/regime cambia a
 *      formatos_libres, y el MISMO POS pasa a emitir facturas con IVA y
 *      control; los recibos históricos quedan intactos y el libro de ventas
 *      ve SOLO la factura.
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
const CONSUMIDOR = crypto.randomUUID();
const ROL = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = new Date().toISOString().slice(0, 10);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PROD = "";
let RECIBO_1 = "";

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

async function textoDelPdf(r: Response): Promise<string> {
  const bruto = Buffer.from(await r.arrayBuffer());
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
  return [...texto.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map((m) => Buffer.from(m[1]!, "hex").toString("latin1"))
    .join("");
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e recibos')`;
    // Sin RIF de verdad no hay: companies.tax_id es not null. El negocio nace
    // con su identificador provisional — lo que NO tiene es régimen fiscal.
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code)
             values (${COMPANY}, ${TENANT}, ${`PEND-${RUN}`}, 'Bodega Sin RIF', 'VES')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-RW1', 'Local')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2erec_dueno_${RUN}`}, 'Dueño', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'),
             (${ROL}, 'sales.payment.register'),
             (${ROL}, 'inventory.move'),
             (${ROL}, 'ar.read'),
             (${ROL}, 'fiscal.regime.manage'),
             (${ROL}, 'fiscal.range.manage'),
             (${ROL}, 'accounting.account.manage'),
             (${ROL}, 'accounting.template.manage')`;
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
                                           person_type_code, taxpayer_type_code, is_system)
             values (${CONSUMIDOR}, ${TENANT}, ${COMPANY}, 'Consumidor final', 'natural',
                     'consumidor_final', true)`;
    const [p] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2EREC-${RUN}`}, 'Empanada', 'service', 'active',
              'unidad', 'gravado_general') returning id`;
    PROD = p!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, 'detal', 'VES') returning id`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${l!.id}, ${PROD}, 50, now() - interval '1 day')`;
  });
  // La contabilidad configurada ANTES de vender: así el recibo genera asiento
  // de verdad y se puede mirar línea a línea (sin plantilla solo encolaría).
  expect(
    (
      await pedir("POST", "/v1/accounts/import-template", {
        company_id: COMPANY,
        template_code: "ve_basico",
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await pedir("POST", "/v1/journal-templates/import-preset", {
        company_id: COMPANY,
        preset_code: "ve_basico",
      })
    ).status,
  ).toBe(201);
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("modo recibos", () => {
  it("la cotización del POS sale SIN IVA y sin reglas cargadas: total = subtotal", async () => {
    const r = await pedir("POST", "/v1/pos/quote", {
      company_id: COMPANY,
      lines: [{ product_id: PROD, quantity: "2" }],
    });
    expect(r.status).toBe(200);
    const q = (await r.json()) as { subtotal: string; tax_amount: string; total: string };
    expect(q.subtotal).toBe("100.00000000");
    expect(q.tax_amount).toBe("0.00000000");
    expect(q.total).toBe("100.00000000");
  });

  it("la venta emite RECIBO: correlativo 1 y 2 sin huecos, sin control, no_fiscal, y su asiento cuadra SIN línea de IVA", async () => {
    const v1 = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      lines: [{ product_id: PROD, quantity: "2" }],
      payments: [{ instrument: "efectivo_bs", amount: "100.00000000", currency: "VES" }],
    });
    expect(v1.status).toBe(201);
    const venta1 = (await v1.json()) as {
      document: {
        id: string;
        kind: string;
        series: string;
        document_number: number;
        control_number: number | null;
      };
      document_status: string;
    };
    expect(venta1.document.kind).toBe("receipt");
    expect(venta1.document.series).toBe("R");
    expect(venta1.document.document_number).toBe(1);
    expect(venta1.document.control_number).toBeNull();
    expect(venta1.document_status).toBe("paid");
    RECIBO_1 = venta1.document.id;

    const v2 = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      lines: [{ product_id: PROD, quantity: "1" }],
    });
    expect(
      ((await v2.json()) as { document: { document_number: number } }).document.document_number,
    ).toBe(2);

    const [linea] = await sql<
      { tax_treatment: string; tax_rule_id: string | null; tax_amount: string }[]
    >`
      select tax_treatment, tax_rule_id, tax_amount::text as tax_amount
        from public.document_lines where document_id = ${RECIBO_1}`;
    expect(linea).toMatchObject({ tax_treatment: "no_fiscal", tax_rule_id: null });
    expect(linea!.tax_amount).toBe("0.00000000");

    // El asiento: exactamente DOS líneas — CxC 100 contra ingresos 100. Que
    // sean DOS es la prueba de que no hay línea de IVA: la plantilla de
    // factura habría puesto tres.
    const lineas = await sql<{ debit: string; credit: string }[]>`
      select l.debit_amount::text as debit, l.credit_amount::text as credit
        from public.journal_entries e
        join public.journal_lines l on l.entry_id = e.id
       where e.company_id = ${COMPANY} and e.source_id = ${RECIBO_1}
         and e.source_kind = 'sales_receipt'
       order by l.line_number`;
    expect(lineas).toHaveLength(2);
    const debitos = lineas.filter((l) => l.debit !== "0.00000000");
    const creditos = lineas.filter((l) => l.credit !== "0.00000000");
    expect(debitos).toHaveLength(1);
    expect(creditos).toHaveLength(1);
    expect(debitos[0]!.debit).toBe("100.00000000");
    expect(creditos[0]!.credit).toBe("100.00000000");

    // Y el coverage no lo lista: recibo emitido ⇒ asiento o cola, cumplido.
    const huecos = await sql<{ n: string }[]>`
      select count(*)::text as n from platform.accounting_coverage_gaps(${COMPANY})`;
    expect(huecos[0]!.n).toBe("0");
  });

  it("el PDF dice RECIBO y «Documento no fiscal», sin RIF del emisor", async () => {
    const r = await pedir("GET", `/v1/documents/${RECIBO_1}/pdf`);
    expect(r.status).toBe(200);
    const texto = await textoDelPdf(r);
    expect(texto).toContain("RECIBO");
    expect(texto).toContain("Documento no fiscal");
    expect(texto).toContain("no es una factura");
    expect(texto).not.toContain("RIF:");
    expect(texto).not.toContain("VALIDAR-SENIAT");
  });

  it("una factura en este régimen rechaza con la voz de persona", async () => {
    const r = await pedir("POST", "/v1/invoices", {
      company_id: COMPANY,
      customer_id: CONSUMIDOR,
      warehouse_id: W1,
      lines: [{ product_id: PROD, quantity: "1" }],
    });
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string; message: string; person_message: string };
    expect(cuerpo.code).toBe("REGIME_KIND_NOT_ALLOWED");
    expect(cuerpo.message).toContain("Para emitir facturas necesitas completar tus datos fiscales");
    expect(cuerpo.person_message).toContain("Empezar");
  });

  it("LA TRANSICIÓN EN CALIENTE: llega el RIF, y el mismo POS pasa a facturar; los libros ven SOLO la factura", async () => {
    // 1. El régimen sube a formatos_libres: la vigencia vieja se cierra.
    const cambio = await pedir("POST", "/v1/fiscal/regime", {
      regime_code: "formatos_libres",
    });
    expect(cambio.status).toBe(201);

    // 2. Lo fiscal que ahora sí hace falta: regla general (con el lock de
    //    siempre) y el rango de la imprenta, arrancando donde el dueño dijo.
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
      await tx`
        insert into public.tax_rules
          (jurisdiction, tax_code, taxpayer_type, product_tax_category, rate,
           effective_from, legal_source, priority, transaction_type)
        select 'VE', 'iva', null, 'gravado_general', 0.16, '2026-01-01',
               'REGLA DE PRUEBA E2E recibos — no es la norma vigente', 5, 'sale'
         where not exists (
           select 1 from public.tax_rules
            where jurisdiction = 'VE' and tax_code = 'iva' and taxpayer_type is null
              and product_tax_category = 'gravado_general' and transaction_type = 'sale'
              and status = 'active')`;
    });
    expect(
      (
        await pedir("POST", "/v1/fiscal-number-ranges", {
          company_id: COMPANY,
          kind: "invoice",
          series: "A",
          range_from: "500",
          range_to: "600",
          printer_source: "Imprenta E2E recibos",
        })
      ).status,
    ).toBe(201);

    // 3. La MISMA venta del POS ahora es FACTURA: con IVA y con control.
    const v = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      series: "A",
      lines: [{ product_id: PROD, quantity: "2" }],
    });
    expect(v.status).toBe(201);
    const factura = (await v.json()) as {
      document: { id: string; kind: string; control_number: number; total_amount: string };
    };
    expect(factura.document.kind).toBe("invoice");
    expect(factura.document.control_number).toBe(500);
    expect(factura.document.total_amount).toBe("116.00000000"); // 100 + 16%

    // 4. Los recibos históricos: intactos, visibles por kind, JAMÁS en libros.
    const recibos = await pedir("GET", "/v1/documents?kind=receipt");
    expect(((await recibos.json()) as { total: number }).total).toBe(2);
    const libro = await sql<{ document_id: string }[]>`
      select document_id from platform.sales_book(${COMPANY}, ${HOY}::date - 1, ${HOY}::date + 1)`;
    expect(libro).toHaveLength(1);
    expect(libro[0]!.document_id).toBe(factura.document.id);

    // 5. Y el correlativo de recibos quedó CONGELADO: intentar otro rechaza.
    const otro = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      series: "R",
      lines: [{ product_id: PROD, quantity: "1" }],
    });
    // El POS ya decide invoice; con serie R emite FACTURA serie R (control del
    // rango A no aplica a serie R → LAD49). Lo que importa: ningún camino
    // produce un recibo nuevo bajo régimen fiscal.
    expect(otro.status).toBe(409);
    const [conteo] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.documents
       where company_id = ${COMPANY} and kind = 'receipt'`;
    expect(conteo!.n).toBe("2");
  });
});

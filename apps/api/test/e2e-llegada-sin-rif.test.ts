import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { sembrarTasaOficial, borrarTasasOficiales } from "./_tasa-oficial.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";

/**
 * SIN RIF Y LA LLEGADA (ola 3 del recorrido 2026-09-24; ADR-0066, nota de aplicación de la ola 3).
 *
 *   · D-01: una empresa SIN RIF compra — «no va a haber factura», o con la factura del proveedor
 *     como soporte de costo — y nunca registra crédito fiscal (LIVA art. 33);
 *   · D-04: un proveedor sin RIF se guarda; con él no se registra una compra CON factura (libro y
 *     retención), y sí una sin ella;
 *   · D-05: el precio se escribe sin IVA por omisión, o con «ya incluye IVA», y la vista previa
 *     del servidor enseña base, IVA y total sin registrar nada;
 *   · D-06: la factura que llega después a otro precio revaloriza el kardex por valor, no por
 *     cantidad;
 *   · D-08 y D-10: «ya era mía» de hoy no falla de madrugada y no queda antes de lo anterior del
 *     mismo día; la de ayer queda en el día de ayer (de Caracas);
 *   · D-13: el aviso de sobregiro lleva los importes con formato de dinero.
 *
 * Pasa a cualquier hora: los días son los de Caracas (`diaCaracas`) y las aserciones de tiempo
 * comparan contra los otros movimientos y contra `created_at`, nunca contra una hora fija.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";

const TENANT = crypto.randomUUID();
const CON = crypto.randomUUID();
const SIN = crypto.randomUUID();
const W_CON = crypto.randomUUID();
const W_SIN = crypto.randomUUID();
// Con RIF y SIN tipo declarado todavía: el REPRODUCIR de D-01 en el escenario final (E1 ya con RIF).
const SIN_TIPO = crypto.randomUUID();
const W_SIN_TIPO = crypto.randomUUID();
const JEFE = crypto.randomUUID();
const ROL = crypto.randomUUID();
const MEM = crypto.randomUUID();
const ASIG = crypto.randomUUID();
const PROV_CON = crypto.randomUUID();
const PROV_SIN = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const AYER = diaCaracas(-1);
const FUENTE_TASA = `Llegada sin RIF E2E ${RUN}`;

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PROD_CON = "";
let PROD_SIN = "";
let PROD_SIN_TIPO = "";

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
  empresa: string,
  metodo: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(JEFE)}`,
    "X-Company-Id": empresa,
  };
  if (metodo !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(path, {
    method: metodo,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function contarFacturas(empresa: string): Promise<string> {
  const [n] = await sql<{ n: string }[]>`
    select count(*)::text as n from public.supplier_invoices where company_id = ${empresa}`;
  return n!.n;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${JEFE}) on conflict (id) do nothing`;

  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${JEFE}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant sin RIF')`;
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
             values (${CON}, ${TENANT}, ${`J-SRCON-${RUN}`}, 'Bodega con RIF', 'VES', 'ordinario'),
                    (${SIN}, ${TENANT}, ${`PEND-SR-${RUN}`}, 'Bodega sin RIF', 'VES', null),
                    (${SIN_TIPO}, ${TENANT}, ${`J-SRST-${RUN}`}, 'Bodega sin tipo', 'VES', null)`;
    await declararTipoDeFixture(tx, CON);
    await declararTipoDeFixture(tx, SIN);
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name) values
             (${W_CON}, ${TENANT}, ${CON}, 'SR-W1', 'Depósito'),
             (${W_SIN}, ${TENANT}, ${SIN}, 'SR-W2', 'Depósito'),
             (${W_SIN_TIPO}, ${TENANT}, ${SIN_TIPO}, 'SR-W3', 'Depósito')`;
    await tx`insert into public.suppliers
               (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code,
                taxpayer_type_code) values
             (${PROV_CON}, ${TENANT}, ${CON}, ${`J-SRP1-${RUN}`}, 'Distribuidora formal',
              'nacional', 'juridica', 'ordinario'),
             (${PROV_SIN}, ${TENANT}, ${SIN}, ${`J-SRP2-${RUN}`}, 'Mayorista con RIF',
              'nacional', 'juridica', 'ordinario')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, ${`sinrif_${RUN}`}, 'Jefe sin RIF', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'inventory.move'), (${ROL}, 'inventory.adjust'),
             (${ROL}, 'purchase.receive'), (${ROL}, 'purchase.invoice.register'),
             (${ROL}, 'purchase.payment.register'), (${ROL}, 'supplier.manage'),
             (${ROL}, 'ap.read'), (${ROL}, 'product.manage'),
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.read'), (${ROL}, 'treasury.read'),
             (${ROL}, 'fiscal_book.read'), (${ROL}, 'fiscal_book.export')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${MEM}, ${TENANT}, ${JEFE})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id)
             values (${ASIG}, ${TENANT}, ${MEM}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id) values
             (${TENANT}, ${CON}, ${ASIG}, 'warehouse', ${W_CON}),
             (${TENANT}, ${SIN}, ${ASIG}, 'warehouse', ${W_SIN}),
             (${TENANT}, ${SIN_TIPO}, ${ASIG}, 'warehouse', ${W_SIN_TIPO})`;
    const [p1] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${CON}, ${`SR-${RUN}`}, 'Galletas surtidas', 'good', 'active', 'unidad',
              'gravado_general')
      returning id`;
    PROD_CON = p1!.id;
    const [p2] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${SIN}, ${`SR2-${RUN}`}, 'Harina 40', 'good', 'active', 'unidad',
              'gravado_general')
      returning id`;
    PROD_SIN = p2!.id;
    const [p3] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${SIN_TIPO}, ${`SR3-${RUN}`}, 'Arroz', 'good', 'active', 'unidad',
              'gravado_general')
      returning id`;
    PROD_SIN_TIPO = p3!.id;

    // La regla de IVA de compra, global, desde AYER y sin pisar la que ya exista.
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
    await tx`
      insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                                    rate, effective_from, legal_source, priority, transaction_type)
      select 'VE', 'iva', 'ordinario', 'gravado_general', 0.16, ${AYER}::date,
             'Carga de prueba E2E — VALIDAR-SENIAT antes de producción.', 10, 'purchase'
       where not exists (select 1 from public.tax_rules
                          where company_id is null and jurisdiction = 'VE' and tax_code = 'iva'
                            and taxpayer_type = 'ordinario'
                            and product_tax_category = 'gravado_general'
                            and transaction_type = 'purchase')`;
  });
  await sembrarTasaOficial(sql, { rate: "40", rate_date: HOY, source: FUENTE_TASA });
  await sembrarTasaOficial(sql, { rate: "40", rate_date: AYER, source: FUENTE_TASA });

  for (const empresa of [CON, SIN]) {
    const plan = await pedir(empresa, "POST", "/v1/accounts/import-template", {
      company_id: empresa,
      template_code: "ve_basico",
    });
    if (plan.status !== 201) throw new Error(`plan: ${plan.status} ${await plan.text()}`);
    const preset = await pedir(empresa, "POST", "/v1/journal-templates/import-preset", {
      company_id: empresa,
      preset_code: "ve_basico",
    });
    if (preset.status !== 201) throw new Error(`preset: ${preset.status} ${await preset.text()}`);
  }
});

afterAll(async () => {
  await borrarTasasOficiales(sql, FUENTE_TASA);
  await sql.end();
  await sqlApi.end();
});

describe("D-04 · el proveedor sin RIF", () => {
  let informal = "";

  it("se guarda: «Cédula o RIF — puede quedar vacío» dice la verdad", async () => {
    const r = await pedir(CON, "POST", "/v1/suppliers", {
      company_id: CON,
      legal_name: `Señor de las verduras ${RUN}`,
      tax_id: null,
      supplier_kind: "nacional",
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const s = (await r.json()) as { id: string; tax_id: string | null };
    expect(s.tax_id).toBeNull();
    informal = s.id;
  });

  it("con él, una compra CON factura se rechaza y dice por qué y qué hacer", async () => {
    const antes = await contarFacturas(CON);
    const r = await pedir(CON, "POST", "/v1/arrivals", {
      company_id: CON,
      warehouse_id: W_CON,
      currency: "VES",
      supplier_id: informal,
      invoice: "present",
      supplier_document_number: `SR-${RUN}-X`,
      supplier_control_number: `00-SRX${RUN}`,
      lines: [{ product_id: PROD_CON, quantity: "1", unit_amount: "10" }],
    });
    expect(r.status).toBe(422);
    const e = (await r.json()) as { message: string };
    expect(e.message).toMatch(/necesita el RIF del proveedor, que viene impreso en ella/);
    // AF3-14: no se propone sacar del libro una compra que sí trae factura.
    expect(e.message).not.toMatch(/No va a haber factura/);
    expect(await contarFacturas(CON)).toBe(antes);
  });

  it("con él, una compra SIN factura entra: no va al libro ni a la retención", async () => {
    const r = await pedir(CON, "POST", "/v1/arrivals", {
      company_id: CON,
      warehouse_id: W_CON,
      currency: "VES",
      supplier_id: informal,
      invoice: "none",
      lines: [{ product_id: PROD_CON, quantity: "3", amount: "90" }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const a = (await r.json()) as { kind: string; invoice: { fiscal_support: boolean } };
    expect(a.kind).toBe("unsupported");
    expect(a.invoice.fiscal_support).toBe(false);
  });
});

describe("D-01 · la empresa sin RIF compra", () => {
  it("«no va a haber factura» a un proveedor sin RIF: entra al costo y queda la deuda", async () => {
    const prov = await pedir(SIN, "POST", "/v1/suppliers", {
      company_id: SIN,
      legal_name: `Proveedor informal ${RUN}`,
      tax_id: null,
      supplier_kind: "nacional",
    });
    expect(prov.status, await prov.clone().text()).toBe(201);
    const { id } = (await prov.json()) as { id: string };
    const r = await pedir(SIN, "POST", "/v1/arrivals", {
      company_id: SIN,
      warehouse_id: W_SIN,
      currency: "VES",
      supplier_id: id,
      invoice: "none",
      lines: [{ product_id: PROD_SIN, quantity: "40", amount: "36000" }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const a = (await r.json()) as {
      kind: string;
      invoice: { id: string; tax_amount: string; total_amount: string };
    };
    expect(a.kind).toBe("unsupported");
    expect(Number(a.invoice.tax_amount)).toBe(0);
    expect(Number(a.invoice.total_amount)).toBe(36000);
  });

  it("con la factura del proveedor: es soporte de COSTO, nunca crédito fiscal (LIVA art. 33)", async () => {
    const valorDelKardex = async (): Promise<number> => {
      const [v] = await sql<{ valor: string }[]>`
        select coalesce(sum(functional_amount), 0)::text as valor from public.inventory_moves
         where company_id = ${SIN} and product_id = ${PROD_SIN}`;
      return Number(v!.valor);
    };
    const antes = await valorDelKardex();
    const r = await pedir(SIN, "POST", "/v1/arrivals", {
      company_id: SIN,
      warehouse_id: W_SIN,
      currency: "VES",
      supplier_id: PROV_SIN,
      invoice: "present",
      supplier_document_number: `SR-${RUN}-1`,
      supplier_control_number: `00-SR1${RUN}`,
      lines: [{ product_id: PROD_SIN, quantity: "10", unit_amount: "100" }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const a = (await r.json()) as {
      kind: string;
      invoice: { id: string; tax_amount: string; total_amount: string };
    };
    expect(a.kind).toBe("invoiced");
    const [f] = await sql<{ recuperable: boolean }[]>`
      select tax_is_recoverable as recuperable from public.supplier_invoices
       where id = ${a.invoice.id}`;
    expect(f!.recuperable).toBe(false);
    // El IVA entra al costo del inventario: 1.000 de base + 160 de IVA.
    expect((await valorDelKardex()) - antes).toBeCloseTo(1160, 6);
    // Y ni un céntimo de crédito fiscal.
    const [iva] = await sql<{ c: string }[]>`
      select creditos::text as c
        from platform.recompute_iva_period(${SIN}, ${HOY}::date, ${HOY}::date, 0)`;
    expect(Number(iva!.c)).toBe(0);
  });
});

describe("AF3-13 · la empresa sin RIF no deja rastro en libros", () => {
  const MENSAJE = /no tiene RIF: sus compras y ventas no van a libros/;

  it("el libro de compras no se le enseña: 409 con su motivo, aunque tenga compras con factura", async () => {
    const r = await pedir(SIN, "GET", `/v1/fiscal-books/compras?from=${HOY}&to=${HOY}`);
    // Antes: 200 con el renglón de la factura del proveedor (IVA al costo).
    expect(r.status).toBe(409);
    const e = (await r.json()) as { code: string; message: string };
    expect(e.code).toBe("REGIME_KIND_NOT_ALLOWED");
    expect(e.message).toMatch(MENSAJE);
  });

  it("ni se genera: la exportación se rechaza igual y no queda ninguna generación", async () => {
    const r = await pedir(SIN, "POST", "/v1/fiscal-books/export", {
      company_id: SIN,
      book_kind: "compras",
      period_from: HOY,
      period_to: HOY,
      format_code: "csv",
      timezone: "America/Caracas",
    });
    expect(r.status).toBe(409);
    const e = (await r.json()) as { code: string; message: string };
    expect(e.code).toBe("REGIME_KIND_NOT_ALLOWED");
    expect(e.message).toMatch(MENSAJE);
    const [n] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.fiscal_book_runs where company_id = ${SIN}`;
    expect(n!.n).toBe("0");
  });

  it("la empresa CON RIF sigue leyendo su libro de compras", async () => {
    const r = await pedir(CON, "GET", `/v1/fiscal-books/compras?from=${HOY}&to=${HOY}`);
    expect(r.status, await r.clone().text()).toBe(200);
  });
});

describe("D-01 · con RIF y sin tipo declarado todavía", () => {
  it("sin factura compra igual: el tipo solo decide el IVA, y aquí no hay IVA", async () => {
    const prov = await pedir(SIN_TIPO, "POST", "/v1/suppliers", {
      company_id: SIN_TIPO,
      legal_name: `Proveedor informal 2 ${RUN}`,
      tax_id: null,
      supplier_kind: "nacional",
    });
    expect(prov.status, await prov.clone().text()).toBe(201);
    const { id } = (await prov.json()) as { id: string };
    const r = await pedir(SIN_TIPO, "POST", "/v1/arrivals", {
      company_id: SIN_TIPO,
      warehouse_id: W_SIN_TIPO,
      currency: "VES",
      supplier_id: id,
      invoice: "none",
      lines: [{ product_id: PROD_SIN_TIPO, quantity: "40", amount: "36000" }],
    });
    // Antes: 422 «Falta el tipo de contribuyente de la empresa», también sin factura.
    expect(r.status, await r.clone().text()).toBe(201);
    expect(((await r.json()) as { kind: string }).kind).toBe("unsupported");
  });
});

describe("D-05 · el precio sin IVA, y la vista previa del servidor", () => {
  const cuerpo = (extra: Record<string, unknown>) => ({
    company_id: CON,
    warehouse_id: W_CON,
    currency: "VES",
    supplier_id: PROV_CON,
    invoice: "present",
    supplier_document_number: `SR-${RUN}-${String(extra["n"])}`,
    supplier_control_number: `00-SR${String(extra["n"])}${RUN}`,
    lines: [{ product_id: PROD_CON, quantity: "2", unit_amount: "116" }],
    ...(extra["incluye"] === true ? { prices_include_tax: true } : {}),
  });

  it("la vista previa enseña base, IVA y total, y no registra nada", async () => {
    const antes = await contarFacturas(CON);
    const r = await pedir(CON, "POST", "/v1/arrivals/preview", cuerpo({ n: 5 }));
    expect(r.status, await r.clone().text()).toBe(200);
    const v = (await r.json()) as {
      currency: string;
      subtotal: string;
      tax_amount: string;
      total_amount: string;
    };
    expect(v.currency).toBe("VES");
    expect(Number(v.subtotal)).toBe(232);
    expect(Number(v.tax_amount)).toBeCloseTo(37.12, 8);
    expect(Number(v.total_amount)).toBeCloseTo(269.12, 8);
    expect(await contarFacturas(CON)).toBe(antes);
  });

  it("«el precio ya incluye IVA»: 116 con IVA son 100 de base y 16 de IVA por unidad", async () => {
    const p = await pedir(CON, "POST", "/v1/arrivals/preview", cuerpo({ n: 6, incluye: true }));
    expect(p.status, await p.clone().text()).toBe(200);
    const v = (await p.json()) as { subtotal: string; tax_amount: string; total_amount: string };
    expect(Number(v.subtotal)).toBe(200);
    expect(Number(v.tax_amount)).toBe(32);
    expect(Number(v.total_amount)).toBe(232);

    const r = await pedir(CON, "POST", "/v1/arrivals", cuerpo({ n: 7, incluye: true }));
    expect(r.status, await r.clone().text()).toBe(201);
    const a = (await r.json()) as { invoice: { tax_amount: string; total_amount: string } };
    expect(Number(a.invoice.tax_amount)).toBe(32);
    expect(Number(a.invoice.total_amount)).toBe(232);
  });

  it("D-09 · la vista previa usa la tasa VIGENTE a la fecha y dice cuál; sin una vigente, lo dice antes de confirmar", async () => {
    // Las tasas oficiales son globales y otros ficheros siembran las suyas: lo que la base diga
    // que es la tasa vigente a ese día (la regla, `platform.closing_rate`) es lo que la vista
    // previa tiene que hacer — en las dos direcciones. El 409 determinista lo fuerza
    // `pnpm recorrido D`, que controla el margen.
    const dia = diaCaracas(-2);
    const [regla] = await sql<{ rate: string | null; rate_date: string | null }[]>`
      select platform.closing_rate(${CON}, 'USD', 'VES', ${dia}::date)::text as rate,
             (select f.rate_date::text from platform.rate_for(${CON}, 'USD', 'VES', ${dia}::date) f)
               as rate_date`;
    // Sin factura: la regla de IVA del fixture rige desde ayer, y aquí se prueba la TASA.
    const r = await pedir(CON, "POST", "/v1/arrivals/preview", {
      company_id: CON,
      warehouse_id: W_CON,
      currency: "USD",
      arrived_on: dia,
      supplier_id: PROV_CON,
      invoice: "none",
      lines: [{ product_id: PROD_CON, quantity: "1", unit_amount: "10" }],
    });
    if (regla!.rate === null) {
      expect(r.status).toBe(409);
      const e = (await r.json()) as { code: string; message: string };
      expect(e.code).toBe("EXCHANGE_RATE_MISSING");
      expect(e.message).toMatch(/No hay tasa del BCV vigente para ese día/);
    } else {
      expect(r.status, await r.clone().text()).toBe(200);
      const v = (await r.json()) as { fx_rate: string; fx_rate_date: string };
      expect(Number(v.fx_rate)).toBe(Number(regla!.rate));
      expect(v.fx_rate_date).toBe(regla!.rate_date);
      expect(v.fx_rate_date <= dia).toBe(true);
    }
  });

  it("D-09 · una llegada toda en bolívares no pide tasa ni la enseña", async () => {
    const r = await pedir(CON, "POST", "/v1/arrivals/preview", cuerpo({ n: 9 }));
    expect(r.status, await r.clone().text()).toBe(200);
    const v = (await r.json()) as { fx_rate: string | null; fx_rate_date: string | null };
    expect(v.fx_rate).toBeNull();
    expect(v.fx_rate_date).toBeNull();
  });
});

describe("D-06 · la factura que llega después a otro precio", () => {
  it("revaloriza el kardex por VALOR: ni una unidad de más", async () => {
    const r = await pedir(CON, "POST", "/v1/arrivals", {
      company_id: CON,
      warehouse_id: W_CON,
      currency: "VES",
      supplier_id: PROV_CON,
      invoice: "pending",
      lines: [{ product_id: PROD_CON, quantity: "5", unit_amount: "100" }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const a = (await r.json()) as { receipt: { id: string } };
    const [linea] = await sql<{ id: string }[]>`
      select id from public.goods_receipt_lines where goods_receipt_id = ${a.receipt.id}`;
    const [antes] = await sql<{ q: string; v: string }[]>`
      select coalesce(sum(quantity), 0)::text as q, coalesce(sum(functional_amount), 0)::text as v
        from public.inventory_moves where company_id = ${CON} and product_id = ${PROD_CON}`;

    const f = await pedir(CON, "POST", "/v1/supplier-invoices", {
      company_id: CON,
      supplier_id: PROV_CON,
      supplier_document_number: `SR-${RUN}-D6`,
      supplier_control_number: `00-SRD6${RUN}`,
      invoice_date: HOY,
      currency: "VES",
      lines: [
        {
          goods_receipt_line_id: linea!.id,
          product_id: PROD_CON,
          quantity: "5",
          unit_price: "120",
        },
      ],
    });
    expect(f.status, await f.clone().text()).toBe(201);
    const [despues] = await sql<{ q: string; v: string }[]>`
      select coalesce(sum(quantity), 0)::text as q, coalesce(sum(functional_amount), 0)::text as v
        from public.inventory_moves where company_id = ${CON} and product_id = ${PROD_CON}`;
    expect(Number(despues!.q)).toBe(Number(antes!.q));
    expect(Number(despues!.v) - Number(antes!.v)).toBeCloseTo(100, 6);
  });
});

describe("D-08 y D-10 · el instante de «ya era mía»", () => {
  it("la de hoy no queda antes de lo anterior del mismo día, ni después de su created_at", async () => {
    // Lo anterior del día: una recepción de proveedor (sus movimientos llevan el reloj de la base).
    const previa = await pedir(CON, "POST", "/v1/arrivals", {
      company_id: CON,
      warehouse_id: W_CON,
      currency: "VES",
      supplier_id: PROV_CON,
      invoice: "pending",
      lines: [{ product_id: PROD_CON, quantity: "1", unit_amount: "100" }],
    });
    expect(previa.status, await previa.clone().text()).toBe(201);

    const r = await pedir(CON, "POST", "/v1/arrivals", {
      company_id: CON,
      warehouse_id: W_CON,
      currency: "VES",
      lines: [{ product_id: PROD_CON, quantity: "2", unit_amount: "100" }],
    });
    // Antes de las 08:00 de Caracas, `12:00Z` quedaba después de `created_at` y el CHECK lo
    // rechazaba: este 201 es D-08.
    expect(r.status, await r.clone().text()).toBe(201);
    const a = (await r.json()) as { moves: { id: string }[] };
    const [m] = await sql<{ despues_de_todo: boolean; no_futuro: boolean; dia: string }[]>`
      select m.occurred_at >= (select max(o.occurred_at) from public.inventory_moves o
                                where o.company_id = ${CON} and o.product_id = ${PROD_CON}
                                  and o.id <> m.id and o.created_at <= m.created_at)
               as despues_de_todo,
             m.occurred_at <= m.created_at as no_futuro,
             (m.occurred_at at time zone 'America/Caracas')::date::text as dia
        from public.inventory_moves m where m.id = ${a.moves[0]!.id}`;
    expect(m!.no_futuro).toBe(true);
    expect(m!.despues_de_todo).toBe(true);
    expect(m!.dia).toBe(HOY);
  });

  it("la de ayer queda en el día de ayer de Caracas", async () => {
    const r = await pedir(CON, "POST", "/v1/arrivals", {
      company_id: CON,
      warehouse_id: W_CON,
      currency: "VES",
      arrived_on: AYER,
      lines: [{ product_id: PROD_CON, quantity: "1", unit_amount: "100" }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const a = (await r.json()) as { moves: { id: string }[] };
    const [m] = await sql<{ dia: string }[]>`
      select (occurred_at at time zone 'America/Caracas')::date::text as dia
        from public.inventory_moves where id = ${a.moves[0]!.id}`;
    expect(m!.dia).toBe(AYER);
  });
});

describe("D-13 · el aviso de sobregiro", () => {
  it("dice los importes con formato de dinero, no «120000.00000000»", async () => {
    const r = await pedir(CON, "POST", "/v1/arrivals", {
      company_id: CON,
      warehouse_id: W_CON,
      currency: "VES",
      supplier_id: PROV_CON,
      invoice: "none",
      lines: [{ product_id: PROD_CON, quantity: "1", amount: "120000" }],
      payment: { instrument: "efectivo_bs" },
    });
    expect(r.status).toBe(409);
    const e = (await r.json()) as { code: string; message: string };
    expect(e.code).toBe("INSUFFICIENT_FUNDS");
    expect(e.message).not.toMatch(/\d\.\d{8}/);
    expect(e.message).toMatch(/120\.000,00/);
  });
});

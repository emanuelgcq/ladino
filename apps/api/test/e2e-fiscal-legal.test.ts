import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * LO LEGAL DE LA FACTURA, de extremo a extremo (PA 00071 y PA 102):
 *
 *   · el domicilio fiscal del emisor se carga por su endpoint y el documento
 *     lo CONGELA al nacer (art. 13.5, migración 34) — y el PDF imprime el
 *     snapshot, no al emisor vivo;
 *   · la línea exenta sale con «(E)» (art. 13.9) y la COPIA con «SIN DERECHO
 *     A CRÉDITO FISCAL» (art. 13.13) — el original sin ella;
 *   · la contingencia (PA 102, migración 35): el talonario físico se registra,
 *     la factura de papel entra por la emisión COMPLETA (kardex, impuestos,
 *     asiento, libros), los números que no cuadran con el papel REVIERTEN la
 *     factura entera, y el período se cierra una sola vez.
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
const GERENTE = crypto.randomUUID();
const MIRON = crypto.randomUUID();
const ROL_GERENTE = crypto.randomUUID();
const ROL_MIRON = crypto.randomUUID();
const CLIENTE = crypto.randomUUID();
const RUN = Date.now().toString(36);
const DIRECCION = "Av. Legal 13.5, galpón 7, Maracay";
const HOY = new Date().toISOString().slice(0, 10);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PROD_GRAVADO = "";
let PROD_EXENTO = "";
let LISTA = "";
let RANGO_CONTINGENCIA = "";

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

/** Infla los streams del PDF y decodifica los <hex> de los TJ (como en e2e-sales). */
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
  await sql`insert into auth.users (id) values (${GERENTE}), (${MIRON})
            on conflict (id) do nothing`;
  await sql`delete from public.exchange_rates
             where from_currency = 'USD' and to_currency = 'VES'`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${GERENTE}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e legal')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-E2ELEG-${RUN}`}, 'Legal Trece Cinco, C.A.',
                     'VES', 'ordinario')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-LW1', 'Principal')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL_GERENTE}, null, ${`e2eleg_gerente_${RUN}`}, 'Gerente', true),
             (${ROL_MIRON}, null, ${`e2eleg_miron_${RUN}`}, 'Mirón', false)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL_GERENTE}, 'company.settings.manage'),
             (${ROL_GERENTE}, 'fiscal.contingency.manage'),
             (${ROL_GERENTE}, 'fiscal.range.manage'),
             (${ROL_GERENTE}, 'fiscal.regime.manage'),
             (${ROL_GERENTE}, 'sales.invoice.issue'),
             (${ROL_GERENTE}, 'sales.payment.register'),
             (${ROL_GERENTE}, 'inventory.move'),
             (${ROL_GERENTE}, 'fx.rate.manage'),
             (${ROL_GERENTE}, 'ar.read')`;
    const memG = crypto.randomUUID();
    const memM = crypto.randomUUID();
    const asigG = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${memG}, ${TENANT}, ${GERENTE}), (${memM}, ${TENANT}, ${MIRON})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${asigG}, ${TENANT}, ${memG}, ${ROL_GERENTE}, null),
             (${crypto.randomUUID()}, ${TENANT}, ${memM}, ${ROL_MIRON}, ${COMPANY})`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, ${asigG}, 'warehouse', ${W1})`;
    await tx`insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                                           person_type_code, taxpayer_type_code, fiscal_address)
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, ${`V-LEG-${RUN}`}, 'Cliente Legal',
                     'natural', 'consumidor_final', 'Calle 9, Maracay')`;
    const [pg] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2ELEG-G-${RUN}`}, 'Producto gravado', 'service', 'active',
              'unidad', 'gravado_general') returning id`;
    PROD_GRAVADO = pg!.id;
    const [pe] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2ELEG-E-${RUN}`}, 'Producto exento', 'service', 'active',
              'unidad', 'exento') returning id`;
    PROD_EXENTO = pe!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, ${`e2eleg-${RUN}`}, 'VES') returning id`;
    LISTA = l!.id;
    for (const prod of [PROD_GRAVADO, PROD_EXENTO]) {
      await tx`insert into public.price_list_items
                 (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
               values (${TENANT}, ${COMPANY}, ${LISTA}, ${prod}, 100, now() - interval '1 day')`;
    }
    await tx`update public.customers set default_price_list_id = ${LISTA} where id = ${CLIENTE}`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${TENANT}, ${COMPANY}, 'formatos_libres', now() - interval '30 days')`;
  });
  // Reglas globales (con el lock de siempre) y la tasa del día.
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
    for (const [categoria, tasa] of [
      ["gravado_general", "0.16"],
      ["exento", "0"],
    ] as const) {
      await tx`
        insert into public.tax_rules
          (jurisdiction, tax_code, taxpayer_type, product_tax_category, rate,
           effective_from, legal_source, priority, transaction_type)
        select 'VE', 'iva', null, ${categoria}, ${tasa}::numeric, '2026-01-01',
               'REGLA DE PRUEBA E2E legal — no es la norma vigente', 5, 'sale'
         where not exists (
           select 1 from public.tax_rules
            where jurisdiction = 'VE' and tax_code = 'iva' and taxpayer_type is null
              and product_tax_category = ${categoria} and transaction_type = 'sale'
              and status = 'active')`;
    }
  });
  // El talonario NORMAL de formatos libres, para la factura no-contingente.
  await pedir("POST", "/v1/fiscal-number-ranges", GERENTE, {
    company_id: COMPANY,
    kind: "invoice",
    series: "L",
    range_from: "1",
    range_to: "500",
    printer_source: "Imprenta E2E legal",
  });
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("el domicilio fiscal del emisor (art. 13.5)", () => {
  it("sin permiso, 403; con permiso queda guardado, visible y auditado", async () => {
    expect(
      (await pedir("PUT", "/v1/companies/fiscal-address", MIRON, { fiscal_address: DIRECCION }))
        .status,
    ).toBe(403);

    const r = await pedir("PUT", "/v1/companies/fiscal-address", GERENTE, {
      fiscal_address: DIRECCION,
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { fiscal_address: string }).fiscal_address).toBe(DIRECCION);

    const lista = await pedir("GET", "/v1/companies", GERENTE);
    const empresas = (await lista.json()) as { id: string; fiscal_address: string | null }[];
    expect(empresas.find((e) => e.id === COMPANY)?.fiscal_address).toBe(DIRECCION);

    const [acta] = await sql<{ payload: { to: string } }[]>`
      select payload from public.audit_events
       where company_id = ${COMPANY} and event_type = 'company.fiscal_address_set'`;
    expect(acta?.payload.to).toBe(DIRECCION);
  });
});

describe("la factura congela al emisor y el PDF cumple el art. 13", () => {
  let DOC = "";

  it("el documento nace con el snapshot del emisor (nombre, RIF normalizado, domicilio)", async () => {
    const r = await pedir("POST", "/v1/invoices", GERENTE, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      series: "L",
      lines: [
        { product_id: PROD_GRAVADO, quantity: "1" },
        { product_id: PROD_EXENTO, quantity: "1" },
      ],
    });
    expect(r.status).toBe(201);
    DOC = ((await r.json()) as { id: string }).id;

    const [fila] = await sql<
      {
        issuer_name_snapshot: string;
        issuer_tax_id_snapshot: string;
        issuer_address_snapshot: string;
      }[]
    >`
      select issuer_name_snapshot, issuer_tax_id_snapshot, issuer_address_snapshot
        from public.documents where id = ${DOC}`;
    expect(fila).toMatchObject({
      issuer_name_snapshot: "Legal Trece Cinco, C.A.",
      issuer_tax_id_snapshot: `JE2ELEG${RUN}`.toUpperCase(),
      issuer_address_snapshot: DIRECCION,
    });
  });

  it("el PDF imprime el domicilio del snapshot y marca «(E)» la línea exenta; el original NO lleva la leyenda de copia", async () => {
    const r = await pedir("GET", `/v1/documents/${DOC}/pdf`, GERENTE);
    expect(r.status).toBe(200);
    const texto = await textoDelPdf(r);
    expect(texto).toContain("Domicilio fiscal:");
    expect(texto).toContain(DIRECCION);
    expect(texto).toContain("Producto exento (E)");
    expect(texto).not.toContain("Producto gravado (E)");
    expect(texto).not.toContain("SIN DERECHO");
  });

  it("la COPIA lleva «SIN DERECHO A CRÉDITO FISCAL» (art. 13.13)", async () => {
    const r = await pedir("GET", `/v1/documents/${DOC}/pdf?copia=1`, GERENTE);
    expect(r.status).toBe(200);
    const texto = await textoDelPdf(r);
    expect(texto).toContain("SIN DERECHO A CR");
  });

  it("y aunque el emisor VIVO cambie de domicilio, el PDF sigue diciendo el del día de emisión", async () => {
    const r = await pedir("PUT", "/v1/companies/fiscal-address", GERENTE, {
      fiscal_address: "Otra dirección posterior, Valencia",
    });
    expect(r.status).toBe(200);
    const pdf = await pedir("GET", `/v1/documents/${DOC}/pdf`, GERENTE);
    const texto = await textoDelPdf(pdf);
    expect(texto).toContain(DIRECCION);
    expect(texto).not.toContain("Otra dirección posterior");
  });
});

describe("contingencia (PA 102, migración 35)", () => {
  it("el talonario se registra con su serie «contingencia…» y su motivo", async () => {
    const r = await pedir("POST", "/v1/fiscal/contingency-ranges", GERENTE, {
      company_id: COMPANY,
      series: "contingencia-1",
      range_from: "1",
      range_to: "50",
      printer_source: "Imprenta E2E legal — talonario físico",
      reason: "Falla del proveedor de internet en el local",
      failure_started_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    });
    expect(r.status).toBe(201);
    const rango = (await r.json()) as { id: string; series: string; remaining: number };
    expect(rango.series).toBe("contingencia-1");
    expect(rango.remaining).toBe(50);
    RANGO_CONTINGENCIA = rango.id;
  });

  it("la factura de papel entra por la emisión COMPLETA y queda en el libro y con su asiento", async () => {
    const emitidaEn = new Date(Date.now() - 2 * 3600_000).toISOString();
    const r = await pedir("POST", "/v1/fiscal/contingency-invoices", GERENTE, {
      company_id: COMPANY,
      contingency_range_id: RANGO_CONTINGENCIA,
      customer_id: CLIENTE,
      warehouse_id: W1,
      issued_at: emitidaEn,
      lines: [{ product_id: PROD_GRAVADO, quantity: "2" }],
      paper_document_number: "1",
      paper_control_number: "1",
    });
    expect(r.status).toBe(201);
    const { document } = (await r.json()) as {
      document: { id: string; series: string; document_number: number; status: string };
    };
    expect(document.series).toBe("contingencia-1");
    expect(document.document_number).toBe(1);
    expect(document.status).toBe("issued");

    // AL LIBRO: el libro de ventas del mes la trae, con su serie de papel.
    const libro = await sql<{ series: string; base_gravada: string }[]>`
      select series, base_gravada::text as base_gravada
        from platform.sales_book(${COMPANY}, ${HOY}::date - 2, ${HOY}::date + 1)
       where document_id = ${document.id}`;
    expect(libro).toHaveLength(1);
    expect(libro[0]!.series).toBe("contingencia-1");

    // A LA CONTABILIDAD: asiento o cola — el gap coverage no la lista.
    const huecos = await sql<{ n: string }[]>`
      select count(*)::text as n from platform.accounting_coverage_gaps(${COMPANY})
       where source_id = ${document.id}`;
    expect(huecos[0]!.n).toBe("0");
  });

  it("números que no cuadran con el papel: 422 y la factura entera REVERTIDA", async () => {
    const r = await pedir("POST", "/v1/fiscal/contingency-invoices", GERENTE, {
      company_id: COMPANY,
      contingency_range_id: RANGO_CONTINGENCIA,
      customer_id: CLIENTE,
      warehouse_id: W1,
      issued_at: new Date(Date.now() - 3600_000).toISOString(),
      lines: [{ product_id: PROD_GRAVADO, quantity: "1" }],
      paper_document_number: "7",
      paper_control_number: "7",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain("no cuadran");
    const [docs] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.documents
       where company_id = ${COMPANY} and series = 'contingencia-1'`;
    expect(docs!.n).toBe("1");
  });

  it("una factura fuera del período de la falla no es contingencia: 422", async () => {
    const r = await pedir("POST", "/v1/fiscal/contingency-invoices", GERENTE, {
      company_id: COMPANY,
      contingency_range_id: RANGO_CONTINGENCIA,
      customer_id: CLIENTE,
      warehouse_id: W1,
      issued_at: new Date(Date.now() - 48 * 3600_000).toISOString(),
      lines: [{ product_id: PROD_GRAVADO, quantity: "1" }],
      paper_document_number: "2",
      paper_control_number: "2",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain("fuera del período");
  });

  it("el período se cierra una vez; la segunda es 422", async () => {
    const cierre = { company_id: COMPANY, failure_ended_at: new Date().toISOString() };
    const r = await pedir(
      "PUT",
      `/v1/fiscal/contingency-ranges/${RANGO_CONTINGENCIA}/close`,
      GERENTE,
      cierre,
    );
    expect(r.status).toBe(200);
    expect(
      (
        await pedir(
          "PUT",
          `/v1/fiscal/contingency-ranges/${RANGO_CONTINGENCIA}/close`,
          GERENTE,
          cierre,
        )
      ).status,
    ).toBe(422);
  });
});

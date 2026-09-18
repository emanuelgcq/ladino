import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * EL INVENTARIO EN EL MAYOR (ADR-0060 §1, §2, §5 · migración 58).
 *
 * Una empresa con plan y preset importados recorre TODO lo que mueve el valor
 * del inventario, y después de cada paso se pregunta lo mismo:
 *
 *   · `inventory_ledger_gap`: valor del kardex − saldo del mayor de inventario
 *     = 0 (el invariante nuevo);
 *   · `inventory_coverage_gaps`: todo movimiento de valor tiene asiento o cola.
 *
 * Existe porque `accounting_coverage_gaps` vigila DOCUMENTOS, no MOVIMIENTOS, y
 * ese punto ciego dejó pasar el costo de ventas durante meses.
 *
 * Variantes rotas: sin la plantilla de costo de ventas, la venta deja el
 * invariante en ROJO (el importe exacto, con la cola que lo explica); una
 * entrada escrita en el kardex sin asiento lo pone en rojo y la cobertura la
 * señala como `missing`.
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
const PROVEEDOR = crypto.randomUUID();
const ROL = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const AYER = diaCaracas(-1);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let HARINA = "";
let ACEITE = "";
let RECEPCION = "";

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

async function brecha(): Promise<{
  kardex: string;
  mayor: string;
  diferencia: string;
  en_cola: string;
}> {
  const [g] = await sql<{ kardex: string; mayor: string; diferencia: string; en_cola: string }[]>`
    select kardex::text, mayor::text, diferencia::text, en_cola::text
      from platform.inventory_ledger_gap(${COMPANY})`;
  return g!;
}

async function huecos(): Promise<{ kind: string; problem: string }[]> {
  return sql<{ kind: string; problem: string }[]>`
    select kind, problem from platform.inventory_coverage_gaps(${COMPANY})`;
}

/** El invariante en verde: diferencia cero y ningún movimiento sin asiento. */
async function enVerde(): Promise<void> {
  const g = await brecha();
  const [cero] = await sql<{ ok: boolean }[]>`select ${g.diferencia}::numeric = 0 as ok`;
  expect(cero!.ok, JSON.stringify(g)).toBe(true);
  expect(await huecos()).toEqual([]);
}

async function saldoPapel(purpose: string): Promise<string> {
  const [s] = await sql<{ s: string }[]>`
    select coalesce(sum(jl.functional_debit - jl.functional_credit), 0)::text as s
      from public.journal_lines jl
      join public.journal_entries e on e.id = jl.entry_id
     where jl.company_id = ${COMPANY} and e.status in ('posted', 'reversed')
       and jl.account_id in (select account_id from public.company_account_settings
                              where company_id = ${COMPANY} and purpose = ${purpose})`;
  return s!.s;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e inventario mayor')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-INVM-${RUN}`}, 'Bodega inventario mayor', 'VES',
                     'ordinario')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-IMW1', 'Local')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2einvm_${RUN}`}, 'Dueño', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.payment.register'),
             (${ROL}, 'ar.read'), (${ROL}, 'supplier.manage'), (${ROL}, 'purchase.receive'),
             (${ROL}, 'purchase.invoice.register'), (${ROL}, 'ap.read'),
             (${ROL}, 'inventory.move'), (${ROL}, 'inventory.adjust'),
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.entry.post'), (${ROL}, 'accounting.read')
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
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, 'Vecino Luis', 'natural',
                     'consumidor_final')`;
    await tx`insert into public.suppliers
               (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code,
                taxpayer_type_code)
             values (${PROVEEDOR}, ${TENANT}, ${COMPANY}, ${`J-PRV-IM-${RUN}`},
                     'Mayorista inventario mayor', 'nacional', 'juridica', 'ordinario')`;
    const prods = await tx<{ id: string; sku: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`IM-HAR-${RUN}`}, 'Harina', 'good', 'active', 'unidad',
              'gravado_general'),
             (${TENANT}, ${COMPANY}, ${`IM-ACE-${RUN}`}, 'Aceite', 'good', 'active', 'unidad',
              'gravado_general')
      returning id, sku`;
    HARINA = prods.find((p) => p.sku.startsWith("IM-HAR"))!.id;
    ACEITE = prods.find((p) => p.sku.startsWith("IM-ACE"))!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, 'detal', 'VES') returning id`;
    await tx`insert into public.company_settings (company_id, tenant_id, default_price_list_id)
             values (${COMPANY}, ${TENANT}, ${l!.id})`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${l!.id}, ${HARINA}, 100, now() - interval '1 day'),
                    (${TENANT}, ${COMPANY}, ${l!.id}, ${ACEITE}, 200, now() - interval '1 day')`;
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
  for (const [ruta, cuerpo] of [
    ["/v1/accounts/import-template", { company_id: COMPANY, template_code: "ve_basico" }],
    ["/v1/journal-templates/import-preset", { company_id: COMPANY, preset_code: "ve_basico" }],
  ] as const) {
    expect((await pedir("POST", ruta, cuerpo)).status).toBe(201);
  }
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("el inventario en el mayor: kardex ↔ mayor en cero después de cada hecho", () => {
  it("empresa vacía: cero y cero", async () => {
    await enVerde();
  });

  it("ENTRADA DIRECTA · inventario contra aportes en inventario", async () => {
    const r = await pedir("POST", "/v1/inventory/receipts", {
      origin: "aporte",
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: ACEITE,
      quantity: "10",
      amount: "600",
      currency: "VES",
    });
    expect(r.status).toBe(201);
    expect(await saldoPapel("opening_equity")).toBe("-600.00000000");
    await enVerde();
  });

  it("RECEPCIÓN DE COMPRA · inventario contra mercancía recibida por facturar", async () => {
    const r = await pedir("POST", "/v1/goods-receipts", {
      company_id: COMPANY,
      supplier_id: PROVEEDOR,
      warehouse_id: W1,
      currency: "VES",
      lines: [{ product_id: HARINA, quantity: "10", unit_price: "50" }],
    });
    expect(r.status).toBe(201);
    RECEPCION = ((await r.json()) as { id: string }).id;
    expect(await saldoPapel("goods_received_not_invoiced")).toBe("-500.00000000");
    await enVerde();
  });

  it("VENTA · el costo de lo vendido es exactamente lo que salió del kardex", async () => {
    const v = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: HARINA, quantity: "4" }],
      payments: [{ instrument: "efectivo_bs", amount: "400.00000000", currency: "VES" }],
    });
    expect(v.status).toBe(201);
    const doc = ((await v.json()) as { document: { id: string } }).document.id;
    const [salio] = await sql<{ c: string }[]>`
      select (-sum(functional_amount))::text as c from public.inventory_moves
       where company_id = ${COMPANY} and source_document_id = ${doc}`;
    const [asiento] = await sql<{ c: string }[]>`
      select sum(jl.functional_debit)::text as c
        from public.journal_entries e join public.journal_lines jl on jl.entry_id = e.id
       where e.company_id = ${COMPANY} and e.source_kind = 'sales_cost'
         and e.source_event = 'stock.shipped' and e.source_id = ${doc}
         and e.status = 'posted'`;
    expect(salio!.c).toBe("200.00000000");
    expect(asiento!.c).toBe(salio!.c);
    await enVerde();
  });

  it("FACTURA DE PROVEEDOR MÁS CARA QUE LO RECIBIDO · revaloriza lo que queda y lleva a variación lo vendido; el puente queda en cero", async () => {
    const [linea] = await sql<{ id: string }[]>`
      select id from public.goods_receipt_lines where goods_receipt_id = ${RECEPCION}`;
    const r = await pedir("POST", "/v1/supplier-invoices", {
      company_id: COMPANY,
      supplier_id: PROVEEDOR,
      supplier_document_number: `FAC-IM-${RUN}`,
      supplier_control_number: "00-0000901",
      invoice_date: HOY,
      currency: "VES",
      lines: [
        { goods_receipt_line_id: linea!.id, product_id: HARINA, quantity: "10", unit_price: "52" },
      ],
    });
    expect(r.status).toBe(201);
    const inv = ((await r.json()) as { id: string }).id;

    // Recibido a 50, facturado a 52: 20 de diferencia. Quedan 6 de 10 en el
    // depósito → 12 revalorizan el kardex y 8 son variación del período.
    const [reval] = await sql<{ v: string }[]>`
      select sum(functional_amount)::text as v from public.inventory_moves
       where company_id = ${COMPANY} and source_document_id = ${inv} and kind = 'revaluacion'`;
    expect(reval!.v).toBe("12.00000000");
    expect(await saldoPapel("purchase_cost_variance")).toBe("8.00000000");
    expect(await saldoPapel("goods_received_not_invoiced")).toBe("0.00000000");
    await enVerde();
  });

  it("SALIDA DIRECTA y AJUSTE · los dos asientan", async () => {
    const salida = await pedir("POST", "/v1/inventory/issues", {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: ACEITE,
      quantity: "1",
      reference: `consumo-${RUN}`,
    });
    expect(salida.status).toBe(201);
    const ajuste = await pedir("POST", "/v1/inventory/adjustments", {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: ACEITE,
      delta: "-1",
      reason: "merma por rotura",
    });
    expect(ajuste.status).toBe(201);
    await enVerde();
  });

  it("VARIANTE ROTA · sin la plantilla de costo de ventas, la venta deja el invariante en ROJO por el costo exacto", async () => {
    await sql`update public.journal_templates set is_active = false
               where company_id = ${COMPANY} and source_kind = 'sales_cost'
                 and source_event = 'stock.shipped'`;
    const v = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: ACEITE, quantity: "1" }],
      payments: [{ instrument: "efectivo_bs", amount: "200.00000000", currency: "VES" }],
    });
    expect(v.status).toBe(201);
    const g = await brecha();
    // El kardex bajó 60 (un aceite a su costo) y el mayor no: rojo por −60, y la
    // cola dice que esos −60 son un costo de ventas pendiente.
    const [rojo] = await sql<{ ok: boolean }[]>`
      select ${g.diferencia}::numeric = -60 and ${g.en_cola}::numeric = -60 as ok`;
    expect(rojo!.ok, JSON.stringify(g)).toBe(true);

    // Se repone la plantilla y «contabilizar pendientes» lo cierra.
    await sql`update public.journal_templates set is_active = true
               where company_id = ${COMPANY} and source_kind = 'sales_cost'
                 and source_event = 'stock.shipped'`;
    expect((await pedir("POST", "/v1/accounting/pending/process", {})).status).toBe(200);
    await enVerde();
  });

  it("VARIANTE ROTA · una entrada escrita en el kardex sin asiento pone el invariante en rojo y la cobertura la señala", async () => {
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`insert into public.inventory_moves
                 (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
                  amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
                  functional_currency, rate_source, rate_timestamp, rounding_policy_id,
                  unit_cost, occurred_at, reference)
               values (${TENANT}, ${COMPANY}, ${W1}, ${ACEITE}, 'entrada', 2, 120, 'VES', 1, 120,
                       'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', 60, now(),
                       ${`sin-asiento-${RUN}`})`;
    });
    const g = await brecha();
    const [rojo] = await sql<{ ok: boolean }[]>`
      select ${g.diferencia}::numeric = 120 and ${g.en_cola}::numeric = 0 as ok`;
    expect(rojo!.ok, JSON.stringify(g)).toBe(true);
    expect(await huecos()).toEqual([{ kind: "entrada", problem: "missing" }]);
  });
});

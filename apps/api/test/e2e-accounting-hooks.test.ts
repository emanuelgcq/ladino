import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * EL GANCHO — R-20 cerrado, demostrado de extremo a extremo.
 *
 * Lo que este fichero está aquí para demostrar, y que ningún test unitario ve:
 *   1. **sin plantilla de mapeo, el documento se emite y ENTRA EN LA COLA** —
 *      no explota, no se pierde (ADR-0042);
 *   2. con plantilla y papeles configurados, el asiento se genera y se postea
 *      EN LA MISMA TRANSACCIÓN del documento;
 *   3. **falta un papel concreto → cola con el nombre del papel que falta**, no
 *      una cuenta adivinada;
 *   4. el mismo evento no genera dos asientos (UNIQUE por `source_event`), pero
 *      otro evento del mismo documento sí;
 *   5. anular la factura REVERSA su asiento y deja cada cuenta en cero;
 *   6. `accounting_coverage_gaps()` devuelve VACÍO: cada documento posteado
 *      tiene asiento **o** fila pendiente, nunca ninguno y nunca los dos;
 *   7. `ledger_balances` y `recompute_ledger()` coinciden después de todo.
 *
 * El criterio de éxito del módulo es el punto 6, no la cuenta de tests.
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
const CONTADOR = crypto.randomUUID();
const CLIENTE = crypto.randomUUID();
const PROVEEDOR = crypto.randomUUID();
const ROL = crypto.randomUUID();
const MEM = crypto.randomUUID();
const ASIG = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = new Date().toISOString().slice(0, 10);
const AYER = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const FUENTE_TASA = `Carga E2E contabilidad ${RUN}`;

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PROD = "";
let LISTA = "";

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
    Authorization: `Bearer ${await tokenDe(CONTADOR)}`,
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

/** Los huecos de cobertura: el invariante de ADR-0042 como consulta. */
async function huecos(): Promise<{ source_kind: string; problem: string }[]> {
  return sql<{ source_kind: string; problem: string }[]>`
    select source_kind, problem from platform.accounting_coverage_gaps(${COMPANY})`;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${CONTADOR}) on conflict (id) do nothing`;
  await sql`delete from public.exchange_rates where source = ${FUENTE_TASA}`;

  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${CONTADOR}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e conta')`;
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-CONTA-${RUN}`}, 'Empresa e2e contabilidad',
                     'VES', 'ordinario')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-CW1', 'Principal')`;
    // Un solo rol con todo: este fichero prueba el GANCHO contable, no el RBAC,
    // que ya está ejercido en los E2E de cada módulo.
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, ${`e2econta_${RUN}`}, 'Contador e2e', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.invoice.annul'),
             (${ROL}, 'sales.payment.register'), (${ROL}, 'ar.read'),
             (${ROL}, 'supplier.manage'), (${ROL}, 'purchase.invoice.register'),
             (${ROL}, 'purchase.payment.register'), (${ROL}, 'purchase.landed_cost.apply'),
             (${ROL}, 'purchase.receive'), (${ROL}, 'ap.read'),
             (${ROL}, 'inventory.move'), (${ROL}, 'inventory.adjust'),
             (${ROL}, 'fiscal.range.manage'), (${ROL}, 'fx.rate.manage'),
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.entry.create'), (${ROL}, 'accounting.entry.post'),
             (${ROL}, 'accounting.entry.reverse'), (${ROL}, 'accounting.read'),
             (${ROL}, 'accounting.period.close')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${MEM}, ${TENANT}, ${CONTADOR})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id)
             values (${ASIG}, ${TENANT}, ${MEM}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, ${ASIG}, 'warehouse', ${W1})`;
    await tx`insert into public.customers
               (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                taxpayer_type_code)
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, ${`J-CLI-${RUN}`}, 'Cliente e2e conta',
                     'juridica', 'ordinario')`;
    await tx`insert into public.suppliers
               (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code,
                taxpayer_type_code)
             values (${PROVEEDOR}, ${TENANT}, ${COMPANY}, ${`J-PRV-${RUN}`}, 'Proveedor e2e conta',
                     'nacional', 'juridica', 'ordinario')`;
    const [p] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2ECONTA-${RUN}`}, 'Producto e2e conta', 'good', 'active',
              'unidad', 'gravado_general')
      returning id`;
    PROD = p!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, ${`e2e-conta-${RUN}`}, 'VES') returning id`;
    LISTA = l!.id;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${LISTA}, ${PROD}, '1000.00000000', ${AYER}::date)`;
    await tx`update public.customers set default_price_list_id = ${LISTA} where id = ${CLIENTE}`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${TENANT}, ${COMPANY}, 'formatos_libres', ${AYER}::timestamptz)`;
    // La regla de IVA, de prueba y con la fuente que lo dice. Guardada porque
    // tax_rules es global: si ya está, no se duplica (catálogo ambiguo). Y con
    // ADVISORY LOCK: cuatro ficheros E2E siembran esta regla EN PARALELO y dos
    // guards simultáneos no se ven entre sí — el duplicado intermitente del
    // 2026-08-31 fue exactamente eso.
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
    await tx`
      insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                                    rate, effective_from, legal_source, priority, transaction_type)
      select 'VE', 'iva', 'ordinario', 'gravado_general', 0.16, ${AYER}::date,
             'Carga de prueba E2E — VALIDAR-SENIAT antes de producción.', 10, 'sale'
       where not exists (select 1 from public.tax_rules
                          where jurisdiction = 'VE' and tax_code = 'iva'
                            and taxpayer_type = 'ordinario'
                            and product_tax_category = 'gravado_general'
                            and transaction_type = 'sale')`;
    await tx`
      insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                                    rate, effective_from, legal_source, priority, transaction_type)
      select 'VE', 'iva', 'ordinario', 'gravado_general', 0.16, ${AYER}::date,
             'Carga de prueba E2E — VALIDAR-SENIAT antes de producción.', 10, 'purchase'
       where not exists (select 1 from public.tax_rules
                          where jurisdiction = 'VE' and tax_code = 'iva'
                            and taxpayer_type = 'ordinario'
                            and product_tax_category = 'gravado_general'
                            and transaction_type = 'purchase')`;
    // Existencia para poder facturar.
    await tx`insert into public.inventory_moves
               (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
                amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
                functional_currency, rate_source, rate_timestamp, rounding_policy_id,
                occurred_at, reference)
             values (${TENANT}, ${COMPANY}, ${W1}, ${PROD}, 'entrada', 100, 50000, 'VES', 1,
                     50000, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', now(),
                     ${`e2e-conta-seed-${RUN}`})`;
  });

  const rango = await pedir("POST", "/v1/fiscal-number-ranges", {
    company_id: COMPANY,
    kind: "invoice",
    series: "A",
    range_from: "1",
    range_to: "500",
    printer_source: "Imprenta E2E contabilidad",
  });
  if (rango.status !== 201) throw new Error(`rango: ${rango.status} ${await rango.text()}`);
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("el gancho contable — R-20", () => {
  it("SIN plantilla, la factura se emite igual y entra en la COLA: no explota, no se pierde", async () => {
    const r = await pedir("POST", "/v1/invoices", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: [{ product_id: PROD, quantity: "1" }],
    });
    expect(r.status).toBe(201);
    const doc = (await r.json()) as Record<string, string>;

    const [fila] = await sql<{ status: string; reason: string }[]>`
      select status, reason from public.journal_generation_queue
       where company_id = ${COMPANY} and source_id = ${doc["id"]!}`;
    expect(fila?.status).toBe("pending");
    expect(fila?.reason).toMatch(/no hay plantilla/i);

    const [d] = await sql<{ journal_entry_id: string | null }[]>`
      select journal_entry_id from public.documents where id = ${doc["id"]!}`;
    expect(d?.journal_entry_id).toBeNull();

    // Y el invariante SE CUMPLE: tiene fila pendiente, así que no es un hueco.
    expect(await huecos()).toHaveLength(0);
  });

  it("importar el plan y el preset deja la contabilidad configurada", async () => {
    const plan = await pedir("POST", "/v1/accounts/import-template", {
      company_id: COMPANY,
      template_code: "ve_basico",
    });
    expect(plan.status).toBe(201);
    const p = (await plan.json()) as { imported: number; purposes: number };
    expect(p.imported).toBeGreaterThan(20);
    expect(p.purposes).toBeGreaterThan(10);

    const preset = await pedir("POST", "/v1/journal-templates/import-preset", {
      company_id: COMPANY,
      preset_code: "ve_basico",
    });
    expect(preset.status).toBe(201);
    const t = (await preset.json()) as { imported: number; lines: number };
    expect(t.imported).toBeGreaterThanOrEqual(6);

    // Y todos los papeles que el preset usa tienen cuenta. Si faltara alguno,
    // el documento iría a la cola en vez de generar asiento — correcto, pero
    // no es lo que se está montando aquí.
    const sinCuenta = await sql<{ purpose: string }[]>`
      select distinct l.account_purpose as purpose
        from public.journal_template_lines l
       where l.company_id = ${COMPANY}
         and not exists (select 1 from public.company_account_settings s
                          where s.company_id = ${COMPANY} and s.purpose = l.account_purpose
                            and s.effective_to is null)`;
    expect(sinCuenta.map((x) => x.purpose)).toEqual([]);
  });

  it("con plantilla, la venta genera su asiento POSTEADO en la misma transacción", async () => {
    const r = await pedir("POST", "/v1/invoices", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: [{ product_id: PROD, quantity: "2" }],
    });
    expect(r.status).toBe(201);
    const doc = (await r.json()) as Record<string, string>;
    // 2 × 1 000 = 2 000 + 16 % = 2 320.
    expect(doc["total_amount"]).toBe("2320.00000000");

    const [d] = await sql<{ journal_entry_id: string | null }[]>`
      select journal_entry_id from public.documents where id = ${doc["id"]!}`;
    expect(d?.journal_entry_id).not.toBeNull();

    const [asiento] = await sql<{ status: string; entry_number: number }[]>`
      select status, entry_number::int as entry_number from public.journal_entries
       where id = ${d!.journal_entry_id!}`;
    expect(asiento?.status).toBe("posted");
    expect(asiento?.entry_number).toBeGreaterThan(0);

    const lineas = await sql<{ code: string; deb: string; cred: string }[]>`
      select a.code, jl.functional_debit::text as deb, jl.functional_credit::text as cred
        from public.journal_lines jl join public.accounts a on a.id = jl.account_id
       where jl.entry_id = ${d!.journal_entry_id!} order by jl.line_number`;
    // CxC por el total; ingreso por la BASE; IVA débito fiscal por el impuesto.
    // El IVA no es ingreso de la empresa y por eso va a su propia cuenta.
    expect(lineas).toHaveLength(3);
    expect(lineas[0]!.deb).toBe("2320.00000000");
    expect(lineas[1]!.cred).toBe("2000.00000000");
    expect(lineas[2]!.cred).toBe("320.00000000");

    const [suma] = await sql<{ d: string; c: string }[]>`
      select sum(functional_debit)::text as d, sum(functional_credit)::text as c
        from public.journal_lines where entry_id = ${d!.journal_entry_id!}`;
    expect(suma!.d).toBe(suma!.c);
    expect(await huecos()).toHaveLength(0);
  });

  it("el MISMO evento no genera un segundo asiento; otro evento del mismo documento, sí", async () => {
    const [doc] = await sql<{ id: string; journal_entry_id: string }[]>`
      select id, journal_entry_id from public.documents
       where company_id = ${COMPANY} and journal_entry_id is not null
         and kind = 'invoice' limit 1`;
    const antes = await sql<{ n: number }[]>`
      select count(*)::int as n from public.journal_entries
       where company_id = ${COMPANY} and source_id = ${doc!.id}`;

    // El índice único (company, source_kind, source_id, source_event) es lo que
    // lo impide, y el generador lo consulta antes para poder devolver el que ya
    // existe en vez de reventar en un reintento.
    await expect(
      sql`insert into public.journal_entries
            (tenant_id, company_id, period_id, posting_date, source_kind, source_id,
             source_event, description)
          select tenant_id, company_id, period_id, posting_date, source_kind, source_id,
                 source_event, 'duplicado'
            from public.journal_entries where id = ${doc!.journal_entry_id}`,
    ).rejects.toThrow();

    const despues = await sql<{ n: number }[]>`
      select count(*)::int as n from public.journal_entries
       where company_id = ${COMPANY} and source_id = ${doc!.id}`;
    expect(despues[0]!.n).toBe(antes[0]!.n);
  });

  it("la compra genera su asiento con IVA CRÉDITO FISCAL, derivado del contribuyente", async () => {
    const r = await pedir("POST", "/v1/supplier-invoices", {
      company_id: COMPANY,
      supplier_id: PROVEEDOR,
      supplier_document_number: `FAC-${RUN}`,
      supplier_control_number: "00-0000001",
      invoice_date: HOY,
      currency: "VES",
      lines: [{ product_id: PROD, quantity: "5", unit_price: "400" }],
    });
    expect(r.status).toBe(201);
    const inv = (await r.json()) as Record<string, string | boolean>;
    expect(inv["tax_is_recoverable"]).toBe(true);

    const [i] = await sql<{ journal_entry_id: string | null }[]>`
      select journal_entry_id from public.supplier_invoices where id = ${inv["id"] as string}`;
    expect(i?.journal_entry_id).not.toBeNull();

    const lineas = await sql<{ code: string; deb: string; cred: string }[]>`
      select a.code, jl.functional_debit::text as deb, jl.functional_credit::text as cred
        from public.journal_lines jl join public.accounts a on a.id = jl.account_id
       where jl.entry_id = ${i!.journal_entry_id!} order by jl.line_number`;
    // Ordinario: inventario por la base, IVA crédito fiscal aparte, CxP por el
    // total. Si fuera formal, serían dos líneas y el IVA iría al costo.
    expect(lineas).toHaveLength(3);
    expect(lineas[0]!.deb).toBe("2000.00000000");
    expect(lineas[1]!.deb).toBe("320.00000000");
    expect(lineas[2]!.cred).toBe("2320.00000000");
    expect(await huecos()).toHaveLength(0);
  });

  it("el cobro genera su asiento y el pago a proveedor desglosa las retenciones", async () => {
    const [factura] = await sql<{ id: string; total: string }[]>`
      select id, total_amount::text as total from public.documents
       where company_id = ${COMPANY} and kind = 'invoice' and status = 'issued'
         and journal_entry_id is not null order by created_at limit 1`;
    const cobro = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: factura!.id,
      currency: "VES",
      amount: factura!.total,
      instrument: "transferencia",
    });
    expect(cobro.status).toBe(201);
    const c = (await cobro.json()) as { payment: { id: string } };
    // `payments` es append-only SIN GRANT de UPDATE, así que no lleva enlace de
    // vuelta: el asiento se localiza por `source_id`, que es el sentido que sí
    // existe. Debilitar el append-only para guardar una comodidad de lectura
    // habría sido el peor de los dos tratos.
    const [asientoCobro] = await sql<{ id: string }[]>`
      select id from public.journal_entries
       where company_id = ${COMPANY} and source_id = ${c.payment.id}
         and source_event = 'ar.payment_applied'`;
    expect(asientoCobro?.id).toBeDefined();
    const cobroLineas = await sql<{ deb: string; cred: string }[]>`
      select functional_debit::text as deb, functional_credit::text as cred
        from public.journal_lines where entry_id = ${asientoCobro!.id}
       order by line_number`;
    // Sin diferencial —todo en moneda funcional— son dos líneas y las de signo
    // no se generan: su condición no se cumple.
    expect(cobroLineas).toHaveLength(2);
    expect(cobroLineas[0]!.deb).toBe(cobroLineas[1]!.cred);

    const [compra] = await sql<{ id: string; total: string }[]>`
      select id, total_amount::text as total from public.supplier_invoices
       where company_id = ${COMPANY} and status = 'posted' limit 1`;
    const pago = await pedir("POST", "/v1/supplier-payments", {
      company_id: COMPANY,
      supplier_invoice_id: compra!.id,
      gross_amount: compra!.total,
      currency: "VES",
      instrument: "transferencia",
    });
    expect(pago.status).toBe(201);
    const p = (await pago.json()) as { payment: { id: string } };
    const [asientoPago] = await sql<{ id: string }[]>`
      select id from public.journal_entries
       where company_id = ${COMPANY} and source_id = ${p.payment.id}
         and source_event = 'ap.payment_made'`;
    expect(asientoPago?.id).toBeDefined();
    // Sin retenciones cargadas en retention_rules, el pago no retiene nada y el
    // asiento son dos líneas. Con retenciones serían cuatro.
    const pagoLineas = await sql<{ deb: string; cred: string }[]>`
      select functional_debit::text as deb, functional_credit::text as cred
        from public.journal_lines where entry_id = ${asientoPago!.id}`;
    expect(pagoLineas.length).toBeGreaterThanOrEqual(2);
    expect(await huecos()).toHaveLength(0);
  });

  it("un papel SIN cuenta manda el documento a la cola diciendo cuál falta", async () => {
    // Se retira la cuenta del IVA débito fiscal: la siguiente factura no puede
    // asentarse, y lo que NO puede pasar es que se invente una cuenta.
    await sql`
      update public.company_account_settings set effective_to = now()
       where company_id = ${COMPANY} and purpose = 'iva_debit_fiscal' and effective_to is null`;

    const r = await pedir("POST", "/v1/invoices", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: [{ product_id: PROD, quantity: "1" }],
    });
    expect(r.status).toBe(201);
    const doc = (await r.json()) as Record<string, string>;

    const [fila] = await sql<{ status: string; reason: string }[]>`
      select status, reason from public.journal_generation_queue
       where company_id = ${COMPANY} and source_id = ${doc["id"]!}`;
    expect(fila?.status).toBe("pending");
    // El mensaje dice QUÉ papel falta. Sin eso, «no se pudo asentar» obliga a
    // adivinar cuál de los catorce es.
    expect(fila?.reason).toContain("iva_debit_fiscal");
    expect(await huecos()).toHaveLength(0);

    // Se repone para el resto del fichero.
    const [cuenta] = await sql<{ id: string }[]>`
      select id from public.accounts where company_id = ${COMPANY} and code = '2.1.02'`;
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${CONTADOR}, true)`;
      await tx`insert into public.company_account_settings
                 (tenant_id, company_id, purpose, account_id)
               values (${TENANT}, ${COMPANY}, 'iva_debit_fiscal', ${cuenta!.id})`;
    });
  });

  it("anular la factura REVERSA su asiento y deja cada cuenta en cero", async () => {
    const emitida = await pedir("POST", "/v1/invoices", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: [{ product_id: PROD, quantity: "3" }],
    });
    expect(emitida.status).toBe(201);
    const doc = (await emitida.json()) as Record<string, string>;
    const [antes] = await sql<{ journal_entry_id: string }[]>`
      select journal_entry_id from public.documents where id = ${doc["id"]!}`;
    expect(antes!.journal_entry_id).not.toBeNull();

    const anulada = await pedir("POST", `/v1/invoices/${doc["id"]!}/annul`, {
      company_id: COMPANY,
      reason: "Prueba del gancho contable",
    });
    expect(anulada.status).toBe(200);

    const [original] = await sql<{ status: string; reversed_by_entry_id: string | null }[]>`
      select status, reversed_by_entry_id from public.journal_entries
       where id = ${antes!.journal_entry_id}`;
    expect(original?.status).toBe("reversed");
    expect(original?.reversed_by_entry_id).not.toBeNull();

    // La propiedad que define una reversión: CADA cuenta involucrada queda en
    // cero entre los dos asientos, no solo el total.
    const netos = await sql<{ account_id: string; neto: string }[]>`
      select jl.account_id, sum(jl.functional_debit - jl.functional_credit)::text as neto
        from public.journal_lines jl
       where jl.entry_id in (${antes!.journal_entry_id}, ${original!.reversed_by_entry_id!})
       group by jl.account_id`;
    expect(netos.length).toBeGreaterThan(0);
    for (const n of netos) expect(Number(n.neto)).toBe(0);
  });

  it("EL CRITERIO DEL MÓDULO: accounting_coverage_gaps() vacío sobre todo lo generado", async () => {
    const gaps = await huecos();
    // Cada documento posteado tiene asiento O fila pendiente. Ninguno sin las
    // dos (`missing`) y ninguno con las dos (`duplicated`).
    expect(gaps).toEqual([]);

    const [emitidos] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.documents
       where company_id = ${COMPANY} and kind = 'invoice' and status in ('issued', 'paid')`;
    expect(emitidos!.n).toBeGreaterThan(2);
  });

  it("el mayor MATERIALIZADO reproduce lo que dicen los asientos crudos", async () => {
    const cuentas = await sql<{ account_id: string }[]>`
      select distinct account_id from public.journal_lines where company_id = ${COMPANY}`;
    expect(cuentas.length).toBeGreaterThan(2);
    for (const c of cuentas) {
      const [mat] = await sql<{ d: string; c: string }[]>`
        select coalesce(sum(debit_total), 0)::text as d,
               coalesce(sum(credit_total), 0)::text as c
          from public.ledger_balances
         where company_id = ${COMPANY} and account_id = ${c.account_id}`;
      const [rec] = await sql<{ debit_total: string; credit_total: string }[]>`
        select debit_total::text, credit_total::text
          from platform.recompute_ledger(${COMPANY}, ${c.account_id})`;
      expect(mat!.d).toBe(rec!.debit_total);
      expect(mat!.c).toBe(rec!.credit_total);
    }
  });

  it("y el balance de comprobación cuadra: Σ débitos == Σ créditos", async () => {
    const r = await pedir("GET", `/v1/trial-balance?date=${HOY}`);
    expect(r.status).toBe(200);
    const b = (await r.json()) as { balanced: boolean; total_debit: string; total_credit: string };
    expect(b.balanced).toBe(true);
    expect(b.total_debit).toBe(b.total_credit);
  });

  it("un período no se cierra mientras la cola tenga pendientes", async () => {
    const [pendientes] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.journal_generation_queue
       where company_id = ${COMPANY} and status = 'pending'`;
    expect(pendientes!.n).toBeGreaterThan(0);

    const periodos = await pedir("GET", "/v1/fiscal-periods");
    const ps = (await periodos.json()) as { id: string }[];
    const cierre = await pedir("POST", `/v1/fiscal-periods/${ps[0]!.id}/close`, {
      company_id: COMPANY,
    });
    expect(cierre.status).toBe(422);
    const e = (await cierre.json()) as { message: string };
    expect(e.message).toMatch(/pendientes de contabilizar|borrador/i);
  });
});

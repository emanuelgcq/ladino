import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";
import { repairCents } from "@ladino/domain";

/**
 * EL CÉNTIMO DE LA CAJA (ADR-0063). Cinco cosas que el QA de pantalla del 2026-09-15 encontró
 * y que se prueban aquí contra la API real:
 *
 *   §1 — lo que la caja anuncia es lo que el recibo dice (h. 19, 57);
 *   §2 — el cobro que cierra se guarda en céntimos de su moneda y deja el documento en CERO,
 *        no en «Saldo Bs. 0,0000758» (h. 17, 28, 56);
 *   §2 — el vuelto de 5 dólares sobre 2,80 es 2,20, no 2,19 (h. 16);
 *   §3 — cobrar a la MISMA tasa no escribe un diferencial de 0,00000302 (h. 18, 29);
 *   §4 — la deuda de una factura sin cobros es su total, no seis decimales más abajo (h. 56).
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
const ROL = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
/** La tasa del QA: la que destapaba los decimales sueltos. */
const TASA = "842.20670000";

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let REFRESCO = "";
let DELIVERY = "";
let LISTA_USD = "";

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

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e céntimo')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-CEN-${RUN}`}, 'Bodega del céntimo', 'VES',
                     'ordinario')`;
    await declararTipoDeFixture(tx, COMPANY);
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-CENW1', 'Local')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2ecentimo_${RUN}`}, 'Dueño', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'treasury.overdraft'),
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.payment.register'),
             (${ROL}, 'ar.read'), (${ROL}, 'treasury.read'),
             (${ROL}, 'treasury.account.manage'), (${ROL}, 'inventory.move'),
             (${ROL}, 'accounting.read'),
             -- ADR-0075 §7 (el mayor al céntimo, segunda empresa del tenant):
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.entry.create'), (${ROL}, 'accounting.entry.post'),
             (${ROL}, 'expense.register'), (${ROL}, 'expense.read')
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
    // Los dos productos del QA: 2 refrescos a 2,80 y un delivery de 1,00.
    const [r] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`CEN-REF-${RUN}`}, 'Refresco', 'service', 'active',
              'unidad', 'gravado_general') returning id`;
    REFRESCO = r!.id;
    const [d] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`CEN-DEL-${RUN}`}, 'Delivery', 'service', 'active',
              'unidad', 'gravado_general') returning id`;
    DELIVERY = d!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, 'detal', 'USD') returning id`;
    LISTA_USD = l!.id;
    await tx`insert into public.company_settings (company_id, tenant_id, default_price_list_id)
             values (${COMPANY}, ${TENANT}, ${LISTA_USD})`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${LISTA_USD}, ${REFRESCO}, 2.80,
                     now() - interval '1 day'),
                    (${TENANT}, ${COMPANY}, ${LISTA_USD}, ${DELIVERY}, 1.00,
                     now() - interval '1 day')`;
    // La tasa del día es GLOBAL (solo existe la del BCV, ADR-0064 §1: la «propia» de una empresa
    // no la lee nadie) y hay una por día. Este fichero necesita la del QA, 842,2067: si otro E2E
    // dejó la suya para hoy, «insertar si no existe» se quedaba con esa y P-03 no producía la
    // fracción que dice probar. Se pone la propia, y `afterAll` la retira.
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      delete from public.exchange_rates
       where company_id is null and from_currency = 'USD' and to_currency = 'VES'
         and rate_date = ${HOY}::date`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      values ('USD', 'VES', ${TASA}::numeric, ${HOY}::date, now(), 'e2e-centimo')`;
  });
});

afterAll(async () => {
  // `exchange_rates` es GLOBAL: la tasa del QA (842,2067) que este fichero siembra para hoy se
  // retira al salir. Si se queda, el E2E de compras que corra después factura a esa tasa en vez
  // de la suya (40) y falla por un motivo que no es suyo.
  await sql`delete from public.exchange_rates where company_id is null and source = 'e2e-centimo'`;
  await sql?.end();
  await sqlApi?.end();
});

describe("el céntimo de la caja: lo que se anuncia, lo que se guarda y lo que queda debiéndose", () => {
  it("§1 · el total que anuncia la caja es EXACTAMENTE el del recibo emitido", async () => {
    const lineas = [
      { product_id: REFRESCO, quantity: "2" },
      { product_id: DELIVERY, quantity: "1" },
    ];
    const cotiza = await pedir("POST", "/v1/pos/quote", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      lines: lineas,
    });
    expect(cotiza.status).toBe(200);
    const q = (await cotiza.json()) as { functional_total: string; total: string };

    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: lineas,
    });
    expect(venta.status).toBe(201);
    const v = (await venta.json()) as { document: { total_amount: string } };
    // Antes: la caja decía Bs 5.558,56 y el recibo guardaba 5.558,57.
    expect(v.document.total_amount).toBe(q.functional_total);
  });

  it("§2 · el vuelto de 5 dólares sobre una cuenta de 2,80 es 2,20", async () => {
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: REFRESCO, quantity: "1" }],
      payments: [{ instrument: "efectivo_usd", currency: "USD", amount: "5.00" }],
    });
    expect(venta.status).toBe(201);
    const v = (await venta.json()) as {
      change: { amount: string; currency: string } | null;
      payments: { payment: { amount: string; currency: string } }[];
      document: { status: string };
    };
    expect(v.change?.currency).toBe("USD");
    expect(v.change?.amount.slice(0, 4)).toBe("2.20");
    // Y lo que entró en la caja son céntimos de verdad, no 2,80000147.
    expect(v.payments[0]!.payment.amount.slice(0, 4)).toBe("2.80");
    expect(v.document.status).toBe("paid");
  });

  it("§2 · un recibo cobrado completo queda en CERO, sin polvo en el saldo", async () => {
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: REFRESCO, quantity: "2" }],
      payments: [{ instrument: "efectivo_usd", currency: "USD", amount: "5.60" }],
    });
    expect(venta.status).toBe(201);
    const v = (await venta.json()) as { document: { id: string; status: string } };
    expect(v.document.status).toBe("paid");

    const detalle = await pedir("GET", `/v1/documents/${v.document.id}`);
    const d = (await detalle.json()) as { balance: string };
    expect(d.balance).toBe("0.00");

    // Y en la base tampoco queda polvo: el saldo funcional es cero exacto.
    const [saldo] = await sql<{ s: string }[]>`
      select platform.document_balance(${COMPANY}, ${v.document.id})::text as s`;
    expect(Number(saldo!.s)).toBe(0);
  });

  it("§3 · cobrar en bolívares el total exacto a la MISMA tasa no escribe diferencial", async () => {
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: DELIVERY, quantity: "1" }],
    });
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string; total_amount: string } })
      .document;

    const cobro = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: doc.id,
      currency: "VES",
      amount: doc.total_amount,
      instrument: "efectivo_bs",
    });
    expect(cobro.status).toBe(201);
    const c = (await cobro.json()) as { exchange_difference: unknown | null };
    // Antes: «Ganancia cambiaria 0,00000302» en cada venta cobrada a la tasa del día.
    expect(c.exchange_difference).toBeNull();

    const [filas] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.exchange_gain_loss
       where company_id = ${COMPANY} and document_id = ${doc.id}`;
    expect(filas!.n).toBe(0);
  });

  it("§4 · la deuda de un recibo sin cobros es su total, al céntimo", async () => {
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [
        { product_id: REFRESCO, quantity: "3" },
        { product_id: DELIVERY, quantity: "1" },
      ],
    });
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string; total_amount: string } })
      .document;

    const detalle = await pedir("GET", `/v1/documents/${doc.id}`);
    const d = (await detalle.json()) as { balance: string; document: { total_amount: string } };
    // Antes: Total Bs 21.493,12 y Saldo Bs 21.493,114984, dos cifras para lo mismo.
    expect(Number(d.balance)).toBe(Number(doc.total_amount));
  });
});

/**
 * EL MAYOR AL CÉNTIMO (ADR-0075 §7; P-01, P-03, K-08). Una segunda empresa del mismo tenant,
 * con plan y plantillas, y su PROPIA tasa (842,2067): con ella un gasto de USD 5 valía
 * 4.211,0335 en la caja y en el mayor, que es exactamente el polvo de P-03.
 *
 * La historia con fracción de céntimo es DATO HEREDADO: se siembra con la conexión de
 * administración (lo que dejó el sistema antes del corte), no por la API — desde la migración
 * 20261003190000 ni el dominio (422) ni la base (LAD71) dejan entrar un importe del mayor con más
 * de dos decimales, y esa puerta cerrada es parte de lo que aquí se prueba.
 */
describe("el mayor al céntimo (ADR-0075 §7)", () => {
  const C2 = crypto.randomUUID();
  const W2 = crypto.randomUUID();
  let CAJA_USD = "";
  let PROD2 = "";
  let PROV2 = "";
  /** El asiento manual heredado, con fracción: el que después se reversa. */
  const HEREDADO = crypto.randomUUID();
  const cuenta: Record<string, string> = {};

  async function pedir2(metodo: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await tokenDe(DUENO)}`,
      "X-Company-Id": C2,
    };
    if (metodo !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return app.request(path, {
      method: metodo,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const saldoDe = async (codigo: string): Promise<string> => {
    const [s] = await sql<{ s: string }[]>`
      select coalesce(sum(jl.functional_debit - jl.functional_credit), 0)::text as s
        from public.journal_lines jl
        join public.journal_entries e on e.id = jl.entry_id
       where jl.company_id = ${C2} and jl.account_id = ${cuenta[codigo]!}
         and e.status in ('posted', 'reversed')`;
    return s!.s;
  };

  beforeAll(async () => {
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                             functional_currency_code, taxpayer_type_code)
               values (${C2}, ${TENANT}, ${`J-CEN2-${RUN}`}, 'Bodega del mayor al céntimo', 'VES',
                       'ordinario')`;
      await declararTipoDeFixture(tx, C2);
      // El rol pide alcance: la segunda empresa también, con su almacén.
      await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
               values (${W2}, ${TENANT}, ${C2}, 'E2E-CENW2', 'Local 2')`;
      await tx`insert into public.scope_bindings
                 (tenant_id, company_id, assignment_id, scope_type, scope_id)
               select ${TENANT}, ${C2}, a.id, 'warehouse', ${W2}
                 from public.user_role_assignments a
                where a.tenant_id = ${TENANT} and a.role_id = ${ROL}`;
      await tx`insert into public.role_permissions (role_id, permission_key) values
               (${ROL}, 'accounting.entry.reverse'), (${ROL}, 'supplier.manage'),
               (${ROL}, 'purchase.invoice.register'), (${ROL}, 'treasury.reassign')
               on conflict do nothing`;
      await tx`insert into public.company_fiscal_regimes
                 (tenant_id, company_id, regime_code, effective_from)
               values (${TENANT}, ${C2}, 'sin_facturacion', now() - interval '10 days')`;
      // La tasa PROPIA de la empresa: la global del día la comparten todos los E2E.
      await tx`insert into public.exchange_rates
                 (tenant_id, company_id, from_currency, to_currency, rate, rate_date,
                  rate_timestamp, source)
               values (${TENANT}, ${C2}, 'USD', 'VES', ${TASA}::numeric, ${HOY}::date, now(),
                       'e2e-centimo')`;
      const [p] = await tx<{ id: string }[]>`
        insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                     tax_category_code)
        values (${TENANT}, ${C2}, ${`CEN2-HAR-${RUN}`}, 'Harina del céntimo', 'good', 'active',
                'unidad', 'gravado_general') returning id`;
      PROD2 = p!.id;
      // Regla global de IVA en compras: desde AYER y solo si nadie la sembró.
      await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
      await tx`
        insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, transaction_type,
                                      product_tax_category, rate, effective_from, legal_source,
                                      priority)
        select 'VE', 'iva', null, 'purchase', 'gravado_general', 0.16, ${HOY}::date - 1,
               ${`REGLA DE PRUEBA E2E céntimo ${RUN}`}, 50
         where not exists (select 1 from public.tax_rules
                            where company_id is null and transaction_type = 'purchase'
                              and jurisdiction = 'VE' and tax_code = 'iva' and taxpayer_type is null
                              and product_tax_category = 'gravado_general')`;
    });
    for (const [ruta, cuerpo] of [
      ["/v1/accounts/import-template", { company_id: C2, template_code: "ve_basico" }],
      ["/v1/journal-templates/import-preset", { company_id: C2, preset_code: "ve_basico" }],
    ] as const) {
      expect((await pedir2("POST", ruta, cuerpo)).status).toBe(201);
    }
    for (const c of await sql<{ code: string; id: string }[]>`
      select code, id from public.accounts where company_id = ${C2}`) {
      cuenta[c.code] = c.id;
    }
    const ids: string[] = [];
    for (const [name, kind] of [
      [`Caja USD ${RUN}`, "cash"],
      [`Banco USD ${RUN}`, "bank"],
    ] as const) {
      const r = await pedir2("POST", "/v1/treasury/accounts", {
        company_id: C2,
        name,
        currency: "USD",
        kind,
      });
      expect(r.status).toBe(201);
      ids.push(((await r.json()) as { id: string }).id);
    }
    CAJA_USD = ids[0]!;
    // B2: la caja tiene SALDO antes del gasto de P-03 (un ingreso previo: el banco la fondea).
    // El sobregiro confirmado, con su permiso y su motivo (D-11), es del banco y de este fixture;
    // el gasto que se prueba no sobregira nada.
    const fondeo = await pedir2("POST", "/v1/treasury/transfers", {
      company_id: C2,
      from_account_id: ids[1]!,
      to_account_id: CAJA_USD,
      amount: "100.00",
      reason: "Fondear la caja en dólares",
      allow_negative_balance: true,
      overdraft_reason: "Fixture E2E: el banco fondea la caja antes de que entre el depósito",
    });
    expect(fondeo.status, await fondeo.clone().text()).toBe(201);
    const prov = await pedir2("POST", "/v1/suppliers", {
      company_id: C2,
      tax_id: `J-4${String(Date.now()).slice(-7)}-0`,
      legal_name: "Proveedor del céntimo",
      supplier_kind: "nacional",
      person_type_code: "juridica",
      taxpayer_type_code: "ordinario",
    });
    expect(prov.status, await prov.clone().text()).toBe(201);
    PROV2 = ((await prov.json()) as { id: string }).id;
  });

  it("P-03 · un gasto de USD 5 a 842,2067 se asienta al céntimo: 4.211,03, en la caja y en el mayor", async () => {
    // Sin `allow_negative_balance`: la caja tiene 100 USD, el gasto no sobregira.
    const r = await pedir2("POST", "/v1/expenses", {
      company_id: C2,
      category: "Publicidad",
      account_id: CAJA_USD,
      amount: "5.00000000",
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const g = (await r.json()) as { id: string; accounting: string };
    expect(g.accounting).toBe("posted");
    // La tasa que usó tiene que producir fracción de céntimo: si no, el test no prueba nada.
    const [gasto] = await sql<{ exacto: string; funcional: string }[]>`
      select (amount_transaction_currency * fx_rate)::text as exacto,
             functional_amount::text as funcional
        from public.expenses where id = ${g.id}`;
    const [conFraccion] = await sql<{ si: boolean }[]>`
      select ${gasto!.exacto}::numeric <> round(${gasto!.exacto}::numeric, 2) as si`;
    expect(conFraccion!.si).toBe(true);
    expect(gasto!.funcional).toBe("4211.03000000");
    const lineas = await sql<{ d: string; c: string }[]>`
      select jl.functional_debit::text as d, jl.functional_credit::text as c
        from public.journal_entries e join public.journal_lines jl on jl.entry_id = e.id
       where e.company_id = ${C2} and e.source_kind = 'expense' and e.source_id = ${g.id}`;
    expect(lineas.length).toBeGreaterThanOrEqual(2);
    for (const l of lineas) expect([l.d, l.c]).toContain("4211.03000000");
  });

  it("C5c · el asiento manual con más de dos decimales se rechaza: 422 con mensaje de persona, y no queda borrador", async () => {
    const a = await pedir2("POST", "/v1/journal-entries", {
      company_id: C2,
      posting_date: HOY,
      description: "Un asiento a 8 decimales (e2e)",
      lines: [
        { account_id: cuenta["1.1.03"]!, debit: "10.12345678" },
        { account_id: cuenta["4.1.01"]!, credit: "10.12345678" },
      ],
    });
    expect(a.status).toBe(422);
    const cuerpo = (await a.json()) as { error: { code: string; message: string } };
    expect(JSON.stringify(cuerpo)).toContain(
      "Los importes del asiento llevan como máximo dos decimales",
    );
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.journal_entries
       where company_id = ${C2} and description = 'Un asiento a 8 decimales (e2e)'`;
    expect(n!.n).toBe(0);
    // Y al céntimo, el mismo asiento entra (queda en borrador: no mueve «Lo que gané»).
    const b = await pedir2("POST", "/v1/journal-entries", {
      company_id: C2,
      posting_date: HOY,
      description: "El mismo asiento al céntimo (e2e)",
      lines: [
        { account_id: cuenta["1.1.03"]!, debit: "10.12" },
        { account_id: cuenta["4.1.01"]!, credit: "10.12" },
      ],
    });
    expect(b.status).toBe(201);
  });

  it("P-01 · «Lo que gané» se sirve con dos decimales aunque el mayor arrastre fracciones viejas", async () => {
    // LA HISTORIA ANTERIOR AL CÉNTIMO, como dato heredado. Dos cosas:
    //   · un asiento manual con fracción: CxC 10,12345678 contra ventas 10,11845678 e ingreso
    //     cambiario 0,005 (tres saldos con fracción, y un residuo al redondear cada línea);
    //   · una posición del KARDEX con fracción: 3 unidades por 30,00 (al céntimo, con su asiento)
    //     más una revalorización heredada de 0,00345678 con el suyo.
    // Los guardas que hoy lo impiden (LAD71 al postear, LAD41 en el kardex) se apagan SOLO dentro
    // de esta transacción de administración.
    const DOC_APERTURA = crypto.randomUUID();
    const DOC_FRACCION = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`select set_config('ladino.rules_version', 'e2e-centimo-heredado', true)`;
      // Los triggers diferidos del kardex disparan en el acto: sin eventos pendientes, el
      // ALTER TABLE de más abajo se puede hacer dentro de la transacción.
      await tx`set constraints all immediate`;
      // El ALTER TABLE de abajo pide un candado sobre la tabla: si otra sesión la tiene ocupada,
      // falla en 4 s en vez de quedarse en la cola bloqueando a todo el que venga detrás.
      await tx`set local lock_timeout = '4s'`;
      const asiento = async (
        id: string,
        kind: string,
        source: string | null,
        evento: string | null,
        lineas: [string, string, string][],
      ) => {
        await tx`
          insert into public.journal_entries
            (id, tenant_id, company_id, period_id, posting_date, source_kind, source_id,
             source_event, description, rules_version)
          values (${id}, ${TENANT}, ${C2}, platform.period_for_date(${C2}, ${HOY}::date),
                  ${HOY}::date, ${kind}, ${source}, ${evento},
                  'Historia anterior al céntimo (e2e)', 'e2e-centimo-heredado')`;
        let n = 0;
        for (const [codigo, debe, haber] of lineas) {
          n += 1;
          await tx`
            insert into public.journal_lines
              (tenant_id, company_id, entry_id, line_number, account_id, debit_amount,
               credit_amount, amount_transaction_currency, transaction_currency, fx_rate,
               functional_amount, functional_currency, rate_source, rate_timestamp,
               functional_debit, functional_credit)
            values (${TENANT}, ${C2}, ${id}, ${n}, ${cuenta[codigo]!}, ${debe}::numeric,
                    ${haber}::numeric, greatest(${debe}::numeric, ${haber}::numeric), 'VES', 1,
                    greatest(${debe}::numeric, ${haber}::numeric), 'VES', 'identidad', now(),
                    ${debe}::numeric, ${haber}::numeric)`;
        }
        await tx`
          update public.journal_entries
             set status = 'posted', posted_at = now(), posted_by = ${DUENO},
                 entry_number = platform.claim_entry_number(${C2},
                                  extract(year from ${HOY}::date)::int)
           where id = ${id}`;
      };
      // La entrada al céntimo, con el oráculo y la partida doble ENCENDIDOS.
      await tx`
        insert into public.inventory_moves
          (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
           amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
           functional_currency, rate_source, rate_timestamp, rounding_policy_id, occurred_at,
           source_document_id)
        values (${TENANT}, ${C2}, ${W2}, ${PROD2}, 'entrada', 3, 30, 'VES', 1, 30, 'VES',
                'identidad', now(), 'ledger:cents:2:HALF_UP', now(), ${DOC_APERTURA})`;
      await asiento(crypto.randomUUID(), "stock_opening", DOC_APERTURA, "stock.received", [
        ["1.1.04", "30", "0"],
        ["3.1.04", "0", "30"],
      ]);
      // Lo heredado, con los dos guardas apagados dentro de la transacción.
      await tx`alter table public.journal_entries disable trigger journal_entries_02_balanced`;
      await tx`alter table public.inventory_moves disable trigger inventory_moves_10_apply`;
      const [m] = await tx<{ id: string }[]>`
        insert into public.inventory_moves
          (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
           amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
           functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost,
           quantity_after, value_after, occurred_at, reason, source_document_id)
        values (${TENANT}, ${C2}, ${W2}, ${PROD2}, 'revaluacion', 0, 0.00345678, 'VES', 1,
                0.00345678, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', 10.00115226,
                3, 30.00345678, now(), 'Revalorización heredada a 8 decimales (e2e)',
                ${DOC_FRACCION})
        returning id`;
      await tx`
        update public.stock_balances
           set value = 30.00345678, last_unit_cost = 10.00115226, last_move_id = ${m!.id},
               moves_count = moves_count + 1
         where company_id = ${C2} and product_id = ${PROD2}`;
      await asiento(crypto.randomUUID(), "inventory_move", DOC_FRACCION, "stock.revalued", [
        ["1.1.04", "0.00345678", "0"],
        ["3.1.04", "0", "0.00345678"],
      ]);
      await asiento(HEREDADO, "manual", null, null, [
        ["1.1.03", "10.12345678", "0"],
        ["4.1.01", "0", "10.11845678"],
        ["4.1.02", "0", "0.005"],
      ]);
      await tx`alter table public.inventory_moves enable trigger inventory_moves_10_apply`;
      await tx`alter table public.journal_entries enable trigger journal_entries_02_balanced`;
    });

    const r = await pedir2("GET", "/v1/negocio/resumen");
    expect(r.status).toBe(200);
    const b = (await r.json()) as { ganado_hoy: string; ganado_mes: string };
    expect(b.ganado_hoy).toMatch(/^-?\d+\.\d{2}$/);
    expect(b.ganado_mes).toMatch(/^-?\d+\.\d{2}$/);
    // Y es el mayor, redondeado: ventas 10,12345678 − el gasto 4.211,03.
    expect(b.ganado_hoy).toBe("-4200.91");
  });

  it("K-08 · la regularización al corte deja el mayor Y EL KARDEX sin fracciones, y la segunda vez no hace nada", async () => {
    const antes = await sql<{ kind: string }[]>`
      select distinct kind from platform.cent_gaps(${C2})`;
    const ramas = antes.map((a) => a.kind);
    expect(ramas).toContain("account_balance");
    // El kardex también se ejercita: una posición y un movimiento con fracción heredada.
    expect(ramas).toContain("stock_balance");
    expect(ramas).toContain("inventory_move");
    const primera = await sql.begin((tx) => repairCents(tx, C2));
    expect(primera.regularized).toBe(true);
    expect(primera.entry_id).toBeTruthy();
    const [despues] = await sql<{ n: number; gap: string; valor: string; cobertura: number }[]>`
      select (select count(*)::int from platform.cent_gaps(${C2})) as n,
             (select diferencia::text from platform.inventory_ledger_gap(${C2})) as gap,
             (select value::text from public.stock_balances
               where company_id = ${C2} and product_id = ${PROD2}) as valor,
             (select count(*)::int from platform.inventory_coverage_gaps(${C2})) as cobertura`;
    expect(despues!.n).toBe(0);
    expect(Number(despues!.gap)).toBe(0);
    expect(despues!.valor).toBe("30.00000000");
    expect(despues!.cobertura).toBe(0);
    const segunda = await sql.begin((tx) => repairCents(tx, C2));
    expect(segunda.regularized).toBe(false);
    const [actas] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where company_id = ${C2} and event_type = 'accounting.cent_regularized'`;
    expect(actas!.n).toBe(1);
  });

  it("C2 · revertir un asiento viejo con fracción DESPUÉS de regularizar: la reversa va al céntimo y los saldos quedan en 0,00", async () => {
    // Tras el corte: CxC 10,12 · ventas −10,12 · ingreso cambiario −0,01 (la regularización se
    // llevó las fracciones). El espejo EXACTO (10,12345678…) los dejaría en −fracción.
    const [vAntes] = await sql<{ s: string }[]>`
      select coalesce(sum(jl.functional_debit - jl.functional_credit), 0)::text as s
        from public.journal_lines jl join public.journal_entries e on e.id = jl.entry_id
       where jl.company_id = ${C2} and jl.account_id = ${cuenta["4.1.01"]!}
         and e.id in (${HEREDADO})`;
    expect(vAntes!.s).toBe("-10.11845678");
    // 4.1.01 lleva además el borrador de C5c (no posteado): su saldo posteado es el heredado.
    const r = await pedir2("POST", `/v1/journal-entries/${HEREDADO}/reverse`, {
      company_id: C2,
      reason: "Reversa de un asiento anterior al céntimo (e2e)",
    });
    expect(r.status, await r.clone().text()).toBeLessThan(300);
    const contra = (await r.json()) as { id: string };
    const lineas = await sql<{ code: string; d: string; c: string }[]>`
      select a.code, jl.functional_debit::text as d, jl.functional_credit::text as c
        from public.journal_lines jl join public.accounts a on a.id = jl.account_id
       where jl.entry_id = ${contra.id} order by jl.line_number`;
    // Cada línea espejo al céntimo, y el residuo (0,01) a «Diferencias por redondeo».
    expect(lineas).toEqual([
      { code: "1.1.03", d: "0.00000000", c: "10.12000000" },
      { code: "4.1.01", d: "10.12000000", c: "0.00000000" },
      { code: "4.1.02", d: "0.01000000", c: "0.00000000" },
      { code: "5.1.10", d: "0.00000000", c: "0.01000000" },
    ]);
    expect(Number(await saldoDe("1.1.03"))).toBe(0);
    expect(Number(await saldoDe("4.1.01"))).toBe(0);
    expect(Number(await saldoDe("4.1.02"))).toBe(0);
    const [inv] = await sql<{ n: number; cuadra: boolean }[]>`
      select (select count(*)::int from platform.cent_gaps(${C2})) as n,
             (select sum(period_debit) = sum(period_credit)
                from platform.trial_balance(${C2}, ${HOY}::date, ${HOY}::date)) as cuadra`;
    expect(inv!.n).toBe(0);
    expect(inv!.cuadra).toBe(true);
  });

  it("AF3-09 · una factura de compra en DIVISA con fracción: el crédito del libro es el de la declaración, al céntimo, y el libro cuadra con el mayor", async () => {
    const r = await pedir2("POST", "/v1/supplier-invoices", {
      company_id: C2,
      supplier_id: PROV2,
      supplier_document_number: `FAC-CEN-${RUN}`,
      supplier_control_number: "00-7654321",
      invoice_date: HOY,
      currency: "USD",
      lines: [{ product_id: PROD2, quantity: "1", unit_price: "33.33" }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const f = (await r.json()) as { id: string };
    const [fila] = await sql<
      { exacto: string; al_centimo: string; con_fraccion: boolean; libro: string; base: string }[]
    >`
      select (i.tax_amount * i.fx_rate)::text as exacto,
             round(i.tax_amount * i.fx_rate, 2)::text as al_centimo,
             i.tax_amount * i.fx_rate <> round(i.tax_amount * i.fx_rate, 2) as con_fraccion,
             b.iva_credito::text as libro, b.base_gravada::text as base
        from public.supplier_invoices i
        join platform.purchases_book(${C2}, ${HOY}::date, ${HOY}::date) b on b.invoice_id = i.id
       where i.id = ${f.id}`;
    // Si la conversión no dejara fracción, el test no probaría nada.
    expect(fila!.con_fraccion).toBe(true);
    expect(Number(fila!.libro)).toBe(Number(fila!.al_centimo));
    expect(fila!.libro).toMatch(/^\d+\.\d{2}000000$/);
    expect(fila!.base).toMatch(/^\d+\.\d{2}000000$/);
    // La declaración: el mismo crédito, al céntimo (antes lo convertía a 8 decimales).
    const [dec] = await sql<{ creditos: string; libro: string }[]>`
      select (select creditos::text from platform.recompute_iva_period(
                ${C2}, ${HOY}::date, ${HOY}::date, 0, 0)) as creditos,
             (select sum(iva_credito)::text
                from platform.purchases_book(${C2}, ${HOY}::date, ${HOY}::date)) as libro`;
    expect(dec!.creditos).toBe(dec!.libro);
    expect(Number(dec!.creditos)).toBe(Number(fila!.al_centimo));
    // Y el libro reproduce el mayor con ella dentro: el asiento existe (no está en cola).
    const [conc] = await sql<{ libro: string; mayor: string; en_cola: string; cuadra: boolean }[]>`
      select libro::text, mayor::text, en_cola::text, cuadra
        from platform.book_ledger_reconciliation(${C2}, ${HOY}::date, ${HOY}::date)
       where concepto = 'iva_credito_fiscal'`;
    expect(conc!.cuadra).toBe(true);
    expect(Number(conc!.en_cola)).toBe(0);
    expect(Number(conc!.mayor)).toBe(Number(fila!.al_centimo));
    const [gaps] = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.cent_gaps(${C2})`;
    expect(gaps!.n).toBe(0);
  });
});

/**
 * LA EMPRESA SIN CONTABILIDAD (C2 de la revisión; migración 20261003190200). Su kardex se
 * regulariza y NO queda nada pendiente en la cola: la fila nace descartada, con su motivo y su
 * acta. Una fila pendiente no la resolvería ninguna plantilla (su importe es una fracción de
 * céntimo) y bloquearía para siempre el cierre de períodos cuando la empresa adopte la
 * contabilidad.
 */
describe("la empresa sin contabilidad regulariza, adopta la contabilidad y CIERRA (ADR-0075 §7)", () => {
  const C3 = crypto.randomUUID();
  const W3 = crypto.randomUUID();

  async function pedir3(metodo: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await tokenDe(DUENO)}`,
      "X-Company-Id": C3,
    };
    if (metodo !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return app.request(path, {
      method: metodo,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("regularización → cola descartada con acta → importa plan y plantillas → cierra el período", async () => {
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`set constraints all immediate`;
      // El ALTER TABLE de abajo pide un candado sobre la tabla: si otra sesión la tiene ocupada,
      // falla en 4 s en vez de quedarse en la cola bloqueando a todo el que venga detrás.
      await tx`set local lock_timeout = '4s'`;
      await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                             functional_currency_code, taxpayer_type_code)
               values (${C3}, ${TENANT}, ${`J-CEN3-${RUN}`}, 'Bodega sin contabilidad', 'VES',
                       'ordinario')`;
      await declararTipoDeFixture(tx, C3);
      await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
               values (${W3}, ${TENANT}, ${C3}, 'E2E-CENW3', 'Local 3')`;
      await tx`insert into public.scope_bindings
                 (tenant_id, company_id, assignment_id, scope_type, scope_id)
               select ${TENANT}, ${C3}, a.id, 'warehouse', ${W3}
                 from public.user_role_assignments a
                where a.tenant_id = ${TENANT} and a.role_id = ${ROL}`;
      await tx`insert into public.role_permissions (role_id, permission_key) values
               (${ROL}, 'accounting.period.close') on conflict do nothing`;
      const [p] = await tx<{ id: string }[]>`
        insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                     tax_category_code)
        values (${TENANT}, ${C3}, ${`CEN3-ARR-${RUN}`}, 'Arroz sin contabilidad', 'good', 'active',
                'unidad', 'gravado_general') returning id`;
      // Una posición HEREDADA con fracción (4 unidades por 7,77123), escrita con el oráculo
      // apagado dentro de esta transacción: hoy no entraría (LAD41).
      await tx`alter table public.inventory_moves disable trigger inventory_moves_10_apply`;
      const [m] = await tx<{ id: string }[]>`
        insert into public.inventory_moves
          (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
           amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
           functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost,
           quantity_after, value_after, occurred_at)
        values (${TENANT}, ${C3}, ${W3}, ${p!.id}, 'entrada', 4, 7.77123, 'VES', 1, 7.77123, 'VES',
                'identidad', now(), 'inventory:cost:8:HALF_UP', 1.9428075, 4, 7.77123, now())
        returning id`;
      await tx`
        insert into public.stock_balances
          (tenant_id, company_id, warehouse_id, product_id, quantity, value, currency_code,
           last_unit_cost, last_move_id, moves_count)
        values (${TENANT}, ${C3}, ${W3}, ${p!.id}, 4, 7.77123, 'VES', 1.9428075, ${m!.id}, 1)`;
      await tx`alter table public.inventory_moves enable trigger inventory_moves_10_apply`;
    });

    const r = await sql.begin((tx) => repairCents(tx, C3));
    expect(r.regularized).toBe(true);
    expect(r.entry_id ?? null).toBeNull();
    expect(r.queue_id).toBeTruthy();
    const [cola] = await sql<{ estado: string; pendientes: number; actas: number; gaps: number }[]>`
      select (select status from public.journal_generation_queue where id = ${r.queue_id!}) as estado,
             (select count(*)::int from public.journal_generation_queue
               where company_id = ${C3} and status = 'pending') as pendientes,
             (select count(*)::int from public.audit_events
               where company_id = ${C3} and event_type = 'accounting.pending_discarded'
                 and payload ->> 'queue_id' = ${r.queue_id!}) as actas,
             (select count(*)::int from platform.cent_gaps(${C3})) as gaps`;
    expect(cola).toEqual({ estado: "discarded", pendientes: 0, actas: 1, gaps: 0 });

    // ADOPTA LA CONTABILIDAD…
    for (const [ruta, cuerpo] of [
      ["/v1/accounts/import-template", { company_id: C3, template_code: "ve_basico" }],
      ["/v1/journal-templates/import-preset", { company_id: C3, preset_code: "ve_basico" }],
    ] as const) {
      const imp = await pedir3("POST", ruta, cuerpo);
      expect(imp.status, await imp.clone().text()).toBe(201);
    }
    // …y CIERRA un período. Con la fila pendiente respondía 422 «Hay 1 documento(s) pendientes
    // de contabilizar», sin forma de resolverla ni de descartarla.
    const [periodo] = await sql<{ id: string }[]>`
      select platform.period_for_date(${C3}, ${HOY}::date) as id`;
    const cierre = await pedir3("POST", `/v1/fiscal-periods/${periodo!.id}/close`, {
      company_id: C3,
    });
    expect(cierre.status, await cierre.clone().text()).toBe(200);
  });
});

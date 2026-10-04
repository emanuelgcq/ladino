import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";
import { claveSecretaLocal } from "./_clave-storage-local.js";

/**
 * H-09 (recorrido 2026-09-24, ola 4): UN GASTO CON FACTURA FISCAL ES UNA COMPRA DE SERVICIO.
 * De extremo a extremo, como `ladino_api` con JWT real. Lo que demuestra:
 *
 *   · `POST /v1/expenses` con `invoice` registra una FACTURA DE PROVEEDOR (no una fila de
 *     `expenses`): entra al libro de compras con su base por alícuota y su exento, da crédito
 *     fiscal, y —la empresa es contribuyente especial— retiene el 75 % y emite su comprobante;
 *   · de la cuenta sale el NETO (total − retenido), y el asiento debita GASTO —la misma cuenta
 *     que un gasto llano—, no «mercancía recibida por facturar»;
 *   · la exclusión del art. 3 num. 8 (servicio público domiciliado) es DATA marcada con motivo;
 *   · todo lo autoriza `expense.register`: quien registra NO tiene ningún permiso `purchase.*`;
 *   · si el saldo no alcanza, no queda la factura a medias;
 *   · la empresa SIN RIF no lleva libro: el IVA va al costo;
 *   · los invariantes cruzados quedan en cero.
 *
 * Todo en VES: no depende de `exchange_rates`. La regla del 75 % es PROPIA de la empresa.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const TENANT = crypto.randomUUID();
const COMPANY = crypto.randomUUID();
const SIN_RIF = crypto.randomUUID();
/** Con RIF pero SIN plan ni plantillas: «lo que gané» sale del margen menos los gastos. */
const SIN_PLAN = crypto.randomUUID();
const USUARIO = crypto.randomUUID();
const CAJERO = crypto.randomUUID();
/** Quien SOLO lleva gastos: expense.register, expense.read y treasury.overdraft. Nada más. */
const GASTOS = crypto.randomUUID();
const ROL_GASTOS = crypto.randomUUID();
const MEM_GASTOS = crypto.randomUUID();
const FUENTE_TASA = `e2e-gasto-con-factura ${Date.now().toString(36)}`;
let BANCO_USD = "";
let appConStorage: ReturnType<typeof buildApp>;
const ROL = crypto.randomUUID();
const ROL_CAJERO = crypto.randomUUID();
const MEM = crypto.randomUUID();
const MEM_CAJERO = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const AYER = diaCaracas(-1);
const PERIODO = HOY.slice(0, 7).replace("-", "");
const SOBREGIRO = {
  allow_negative_balance: true,
  overdraft_reason: "Fixture E2E: se confirma el sobregiro con su motivo",
};

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PROV = "";
let BANCO = "";
let BANCO_SIN_RIF = "";
let PROV_SIN_RIF = "";
let BANCO_SIN_PLAN = "";
let PROV_SIN_PLAN = "";
let FACTURA_LUZ = "";

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
  body?: unknown,
  quien: string = USUARIO,
  empresa: string = COMPANY,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(quien)}`,
    "X-Company-Id": empresa,
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

const facturasCon = async (numero: string): Promise<number> => {
  const [f] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.supplier_invoices
     where company_id in (${COMPANY}, ${SIN_RIF}) and supplier_document_number = ${numero}`;
  return f!.n;
};

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${USUARIO}), (${CAJERO}), (${GASTOS})
            on conflict (id) do nothing`;
  appConStorage = buildApp({
    sql: sqlApi,
    auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER },
    storage: { url: "http://127.0.0.1:54321/storage/v1", serviceKey: claveSecretaLocal() },
  });
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${USUARIO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e gasto con factura')`;
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code,
                fiscal_address)
             values (${COMPANY}, ${TENANT}, ${`J-E2EGAS-${RUN}`}, 'Agente de gastos e2e, C.A.',
                     'VES', 'especial', 'Av. Principal, Caracas')`;
    await declararTipoDeFixture(tx, COMPANY);
    // La empresa SIN RIF: no_contribuyente por hecho, sin libros.
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code)
             values (${SIN_RIF}, ${TENANT}, ${`PEND-${RUN}`}, 'Bodega sin RIF e2e', 'VES')`;
    // QUIEN REGISTRA GASTOS NO TIENE NINGÚN PERMISO DE COMPRAS: el paso interior (la factura y
    // su pago) lo autoriza `expense.register`.
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, ${`e2egas_${RUN}`}, 'Lleva los gastos', false),
                    (${ROL_CAJERO}, null, ${`e2egasc_${RUN}`}, 'Cajero', false)`;
    await tx`insert into public.role_permissions (role_id, permission_key)
             select ${ROL}, key from public.permissions
              where key not like 'purchase.%' and not is_scoped`;
    await tx`insert into public.role_permissions (role_id, permission_key)
             values (${ROL_CAJERO}, 'sales.invoice.issue')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL_GASTOS}, null, ${`e2egasg_${RUN}`}, 'Solo gastos', false)`;
    await tx`insert into public.role_permissions (role_id, permission_key)
             values (${ROL_GASTOS}, 'expense.register'), (${ROL_GASTOS}, 'expense.read'),
                    (${ROL_GASTOS}, 'treasury.overdraft')`;
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${MEM}, ${TENANT}, ${USUARIO}), (${MEM_CAJERO}, ${TENANT}, ${CAJERO}),
                    (${MEM_GASTOS}, ${TENANT}, ${GASTOS})`;
    await tx`insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
             values (${TENANT}, ${MEM_GASTOS}, ${ROL_GASTOS}, null)`;
    // La tasa del día es GLOBAL: la propia, bajo el candado de los E2E; a igual día manda la
    // guardada más tarde. `afterAll` la retira.
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    // Una por día (`exchange_rates_day_key`): se retira la que haya y se pone la propia, como
    // hace e2e-el-centimo. A 40 Bs por USD el neto de 1 240 Bs son 31,00 USD exactos.
    await tx`
      delete from public.exchange_rates
       where company_id is null and from_currency = 'USD' and to_currency = 'VES'
         and rate_date = ${HOY}::date`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      values ('USD', 'VES', 40, ${HOY}::date, now(), ${FUENTE_TASA})`;
    await tx`insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
             values (${TENANT}, ${MEM}, ${ROL}, null), (${TENANT}, ${MEM_CAJERO}, ${ROL_CAJERO}, null)`;
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
    for (const [categoria, alicuota] of [
      ["gravado_general", 0.16],
      ["exento", 0],
    ] as const) {
      await tx`
        insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, transaction_type,
                                      product_tax_category, rate, effective_from, legal_source,
                                      priority)
        select 'VE', 'iva', null, 'purchase', ${categoria}, ${alicuota}, ${AYER}::date,
               ${`REGLA DE PRUEBA E2E gasto con factura ${categoria} ${RUN}`}, 50
         where not exists (select 1 from public.tax_rules
                            where company_id is null and transaction_type = 'purchase'
                              and jurisdiction = 'VE' and tax_code = 'iva'
                              and taxpayer_type is null
                              and product_tax_category = ${categoria})`;
    }
    await tx`insert into public.retention_rules
               (tenant_id, company_id, jurisdiction, retention_code, concept_code,
                taxpayer_type, formula_kind, rate, effective_from, legal_source, priority)
             values (${TENANT}, ${COMPANY}, 'VE', 'iva', 'iva_compras', null, 'rate', 0.75,
                     ${AYER}::date,
                     'Carga de prueba E2E — PA SNAT/2025/000054 art. 4. VALIDAR-SENIAT.', 50)`;
    const [p] = await tx<{ id: string }[]>`
      insert into public.suppliers (tenant_id, company_id, tax_id, legal_name, supplier_kind,
                                    person_type_code, taxpayer_type_code)
      values (${TENANT}, ${SIN_RIF}, ${`J-4${String(Date.now()).slice(-7)}-0`},
              'Electricidad para la bodega', 'nacional', 'juridica', 'ordinario')
      returning id`;
    PROV_SIN_RIF = p!.id;
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
             values (${SIN_PLAN}, ${TENANT}, ${`J-E2EGSP-${RUN}`}, 'Sin plan e2e, C.A.', 'VES',
                     'ordinario')`;
    await declararTipoDeFixture(tx, SIN_PLAN);
    const [q] = await tx<{ id: string }[]>`
      insert into public.suppliers (tenant_id, company_id, tax_id, legal_name, supplier_kind,
                                    person_type_code, taxpayer_type_code)
      values (${TENANT}, ${SIN_PLAN}, ${`J-2${String(Date.now()).slice(-7)}-0`},
              'Electricidad sin plan', 'nacional', 'juridica', 'ordinario')
      returning id`;
    PROV_SIN_PLAN = q!.id;
  });
  {
    const banco = await pedir(
      "POST",
      "/v1/treasury/accounts",
      { company_id: SIN_PLAN, name: "Banco Bs", currency: "VES", kind: "bank" },
      USUARIO,
      SIN_PLAN,
    );
    expect(banco.status).toBe(201);
    BANCO_SIN_PLAN = ((await banco.json()) as { id: string }).id;
  }

  for (const empresa of [COMPANY, SIN_RIF]) {
    const plan = await pedir(
      "POST",
      "/v1/accounts/import-template",
      { company_id: empresa, template_code: "ve_basico" },
      USUARIO,
      empresa,
    );
    expect(plan.status).toBe(201);
    const preset = await pedir(
      "POST",
      "/v1/journal-templates/import-preset",
      { company_id: empresa, preset_code: "ve_basico" },
      USUARIO,
      empresa,
    );
    expect(preset.status).toBe(201);
    const banco = await pedir(
      "POST",
      "/v1/treasury/accounts",
      { company_id: empresa, name: "Banco Bs", currency: "VES", kind: "bank" },
      USUARIO,
      empresa,
    );
    expect(banco.status).toBe(201);
    const id = ((await banco.json()) as { id: string }).id;
    if (empresa === COMPANY) BANCO = id;
    else BANCO_SIN_RIF = id;
  }
  const prov = await pedir("POST", "/v1/suppliers", {
    company_id: COMPANY,
    tax_id: `J-3${String(Date.now()).slice(-7)}-0`,
    legal_name: "Electricidad de Caracas e2e",
    supplier_kind: "nacional",
    person_type_code: "juridica",
    taxpayer_type_code: "ordinario",
    fiscal_address: "Av. Vollmer, Caracas",
  });
  expect(prov.status).toBe(201);
  PROV = ((await prov.json()) as { id: string }).id;
  const usd = await pedir("POST", "/v1/treasury/accounts", {
    company_id: COMPANY,
    name: "Banco USD",
    currency: "USD",
    kind: "bank",
  });
  expect(usd.status).toBe(201);
  BANCO_USD = ((await usd.json()) as { id: string }).id;
}, 120_000);

afterAll(async () => {
  await sql`delete from public.exchange_rates where company_id is null and source = ${FUENTE_TASA}`;
  await sql.end();
  await sqlApi.end();
});

const gastoConFactura = (numero: string, extra: Record<string, unknown> = {}) => ({
  company_id: COMPANY,
  category: "Luz",
  account_id: BANCO,
  ...SOBREGIRO,
  invoice: {
    supplier_id: PROV,
    document_number: numero,
    control_number: `00-${numero}`,
    invoice_date: HOY,
    lines: [
      { tax_category_code: "gravado_general", base: "1000" },
      { tax_category_code: "exento", base: "200" },
    ],
    ...extra,
  },
});

describe("H-09 · un gasto con factura fiscal es una compra de servicio", () => {
  it("el especial registra la luz con factura: libro, crédito fiscal, retención del 75 % con su comprobante, y de la cuenta sale el neto", async () => {
    // El gasto llano de referencia: dice a qué cuenta contable va «un gasto».
    const llano = await pedir("POST", "/v1/expenses", {
      company_id: COMPANY,
      category: "Café",
      account_id: BANCO,
      amount: "50",
      ...SOBREGIRO,
    });
    expect(llano.status).toBe(201);
    const [cuentaDeGasto] = await sql<{ account_id: string }[]>`
      select l.account_id from public.journal_lines l
       where l.entry_id = ${((await llano.json()) as { journal_entry_id: string }).journal_entry_id}
         and l.debit_amount > 0`;

    const r = await pedir("POST", "/v1/expenses", gastoConFactura(`LUZ-${RUN}-1`));
    expect(r.status).toBe(201);
    const g = (await r.json()) as Record<string, unknown> & { invoice: Record<string, unknown> };
    FACTURA_LUZ = g["supplier_invoice_id"] as string;
    expect(g["id"]).toBe(FACTURA_LUZ);
    expect(g["category"]).toBe("Luz");
    // 1 000 al 16 % + 200 exentos: IVA 160, total 1 360; retención 75 % de 160 = 120.
    expect(g.invoice["subtotal_amount"]).toBe("1200.00000000");
    expect(g.invoice["tax_amount"]).toBe("160.00000000");
    expect(g.invoice["total_amount"]).toBe("1360.00000000");
    expect(g.invoice["retention_total"]).toBe("120.00000000");
    expect(g.invoice["tax_is_recoverable"]).toBe(true);
    expect(g.invoice["retention_voucher_number"]).toMatch(new RegExp(`^${PERIODO}\\d{8}$`));
    // De la cuenta sale el NETO: lo retenido se le debe al fisco, no al proveedor.
    expect(g["amount"]).toBe("1240.00000000");
    expect(g["accounting"]).toBe("posted");

    // NO hay fila en `expenses`: el gasto ES la factura (el dinero no sale dos veces).
    const [llanos] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.expenses where company_id = ${COMPANY}`;
    expect(llanos!.n).toBe(1);
    const [f] = await sql<Record<string, unknown>[]>`
      select expense_category, status, fiscal_support, tax_is_recoverable,
             (select count(*)::int from public.supplier_invoice_lines l
               where l.supplier_invoice_id = i.id and l.product_id is null) as lineas_de_servicio
        from public.supplier_invoices i where id = ${FACTURA_LUZ}`;
    expect(f).toEqual({
      expense_category: "Luz",
      status: "paid",
      fiscal_support: true,
      tax_is_recoverable: true,
      lineas_de_servicio: 2,
    });
    const [saldo] = await sql<{ b: string }[]>`
      select balance::text as b from public.company_account_balances where account_id = ${BANCO}`;
    expect(saldo!.b).toBe("-1290.00000000");

    // EL ASIENTO de la factura: gasto 1 200 a la MISMA cuenta que el gasto llano, más el
    // crédito fiscal; contra el proveedor (neto) y el IVA retenido por enterar.
    const lineas = await sql<{ account_id: string; d: string; h: string }[]>`
      select l.account_id, l.debit_amount::text as d, l.credit_amount::text as h
        from public.journal_entries e
        join public.journal_lines l on l.entry_id = e.id
       where e.company_id = ${COMPANY} and e.source_kind = 'purchase_invoice'
         and e.source_id = ${FACTURA_LUZ}
       order by l.debit_amount desc, l.credit_amount desc`;
    expect(lineas.map((l) => [l.d, l.h])).toEqual([
      ["1200.00000000", "0.00000000"],
      ["160.00000000", "0.00000000"],
      ["0.00000000", "1240.00000000"],
      ["0.00000000", "120.00000000"],
    ]);
    expect(lineas[0]!.account_id).toBe(cuentaDeGasto!.account_id);
  });

  it("entra al LIBRO DE COMPRAS con su comprobante de retención, y lo ve el historial de gastos", async () => {
    const libro = await sql<Record<string, string | null>[]>`
      select invoice_id, status, retention_voucher_iva::text as retention_voucher_iva
        from platform.purchases_book_with_vouchers(${COMPANY}, ${HOY}::date, ${HOY}::date)
       where invoice_id = ${FACTURA_LUZ}`;
    expect(libro).toHaveLength(1);
    expect(libro[0]!["retention_voucher_iva"]).toBe("120.00000000");

    const lista = await pedir("GET", `/v1/expenses?from=${HOY}&to=${HOY}`);
    expect(lista.status).toBe(200);
    const cuerpo = (await lista.json()) as { items: Record<string, unknown>[]; total: number };
    expect(cuerpo.total).toBe(2);
    const luz = cuerpo.items.find((x) => x["id"] === FACTURA_LUZ);
    expect(luz).toMatchObject({
      category: "Luz",
      amount: "1240.00000000",
      currency: "VES",
      account_id: BANCO,
      supplier_invoice_id: FACTURA_LUZ,
    });
    expect(cuerpo.items.find((x) => x["category"] === "Café")!["supplier_invoice_id"]).toBeNull();
  });

  it("la exclusión del art. 3 num. 8 (servicio público domiciliado) se marca con motivo, sale del catálogo y no retiene", async () => {
    const r = await pedir(
      "POST",
      "/v1/expenses",
      gastoConFactura(`LUZ-${RUN}-2`, {
        retention_exclusion: {
          code: "servicio_publico_domiciliado",
          reason: "La luz se paga por domiciliación en la cuenta del banco",
        },
      }),
    );
    expect(r.status).toBe(201);
    const g = (await r.json()) as Record<string, unknown> & { invoice: Record<string, unknown> };
    expect(g.invoice["retention_total"]).toBe("0.00000000");
    expect(g.invoice["retention_voucher_number"]).toBeNull();
    expect(g["amount"]).toBe("1360.00000000");
    const [a] = await sql<{ p: Record<string, string> }[]>`
      select payload as p from public.audit_events
       where aggregate_id = ${g["supplier_invoice_id"] as string}
         and event_type = 'ap.retention_excluded'`;
    expect(a!.p["exclusion_code"]).toBe("servicio_publico_domiciliado");

    // Una exclusión que no está en el catálogo no se inventa.
    const inventada = await pedir(
      "POST",
      "/v1/expenses",
      gastoConFactura(`LUZ-${RUN}-3`, {
        retention_exclusion: { code: "porque_si", reason: "No quiero retener esta factura" },
      }),
    );
    expect(inventada.status).toBe(422);
    expect(await facturasCon(`LUZ-${RUN}-3`)).toBe(0);
  });

  it("si el saldo no alcanza y nadie lo confirma, 409 INSUFFICIENT_FUNDS y la factura NO queda registrada", async () => {
    const cuerpo = gastoConFactura(`LUZ-${RUN}-4`) as Record<string, unknown>;
    delete cuerpo["allow_negative_balance"];
    delete cuerpo["overdraft_reason"];
    const r = await pedir("POST", "/v1/expenses", cuerpo);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("INSUFFICIENT_FUNDS");
    expect(await facturasCon(`LUZ-${RUN}-4`)).toBe(0);
  });

  it("con factura no se manda el importe (lo calcula el servidor), y la categoría tributaria sale del catálogo", async () => {
    const conImporte = await pedir("POST", "/v1/expenses", {
      ...gastoConFactura(`LUZ-${RUN}-5`),
      amount: "1360",
    });
    expect(conImporte.status).toBe(422);
    expect(((await conImporte.json()) as { message: string }).message).toContain(
      "Con factura fiscal no se escribe el importe",
    );
    const categoria = await pedir(
      "POST",
      "/v1/expenses",
      gastoConFactura(`LUZ-${RUN}-6`, {
        lines: [{ tax_category_code: "inventada", base: "100" }],
      }),
    );
    expect(categoria.status).toBe(422);
    expect(((await categoria.json()) as { message: string }).message).toContain("«inventada»");
    // Y sin factura el importe sigue siendo obligatorio.
    const sinNada = await pedir("POST", "/v1/expenses", {
      company_id: COMPANY,
      category: "Luz",
      account_id: BANCO,
    });
    expect(sinNada.status).toBe(422);
    expect(await facturasCon(`LUZ-${RUN}-5`)).toBe(0);
    expect(await facturasCon(`LUZ-${RUN}-6`)).toBe(0);
  });

  it("sin `expense.register` es 403 y no se escribe nada", async () => {
    const r = await pedir("POST", "/v1/expenses", gastoConFactura(`LUZ-${RUN}-7`), CAJERO);
    expect(r.status).toBe(403);
    expect(await facturasCon(`LUZ-${RUN}-7`)).toBe(0);
  });

  it("por el contrato público de la factura de proveedor no entra una línea sin producto", async () => {
    // El trigger LADH9 es la segunda capa: aquí se prueba que el esquema público sigue
    // exigiendo el producto (el camino del gasto no abre el de la mercancía).
    await sql`insert into public.role_permissions (role_id, permission_key)
              values (${ROL}, 'purchase.invoice.register') on conflict do nothing`;
    const r = await pedir("POST", "/v1/supplier-invoices", {
      company_id: COMPANY,
      supplier_id: PROV,
      supplier_document_number: `LUZ-${RUN}-8`,
      supplier_control_number: "00-8",
      invoice_date: HOY,
      currency: "VES",
      lines: [{ description: "Luz", quantity: "1", unit_price: "100" }],
    });
    expect(r.status).toBe(422);
    await sql`delete from public.role_permissions
               where role_id = ${ROL} and permission_key = 'purchase.invoice.register'`;
    expect(await facturasCon(`LUZ-${RUN}-8`)).toBe(0);
  });

  it("la empresa SIN RIF no lleva libro: el gasto con factura va entero al costo y no retiene", async () => {
    const r = await pedir(
      "POST",
      "/v1/expenses",
      {
        ...gastoConFactura(`LUZ-${RUN}-9`),
        company_id: SIN_RIF,
        account_id: BANCO_SIN_RIF,
        invoice: {
          supplier_id: PROV_SIN_RIF,
          document_number: `LUZ-${RUN}-9`,
          control_number: "00-9",
          invoice_date: HOY,
          lines: [{ tax_category_code: "gravado_general", base: "1000" }],
        },
      },
      USUARIO,
      SIN_RIF,
    );
    expect(r.status).toBe(201);
    const g = (await r.json()) as Record<string, unknown> & { invoice: Record<string, unknown> };
    expect(g.invoice["tax_is_recoverable"]).toBe(false);
    expect(g.invoice["retention_total"]).toBe("0.00000000");
    expect(g["amount"]).toBe("1160.00000000");
    const [libro] = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.purchases_book(${SIN_RIF}, ${HOY}::date, ${HOY}::date)`;
    expect(libro!.n).toBe(0);
    // Todo el importe, IVA incluido, es gasto: una sola línea al debe.
    const debe = await sql<{ d: string }[]>`
      select l.debit_amount::text as d
        from public.journal_entries e
        join public.journal_lines l on l.entry_id = e.id
       where e.company_id = ${SIN_RIF} and e.source_kind = 'purchase_invoice'
         and e.source_id = ${g["supplier_invoice_id"] as string} and l.debit_amount > 0`;
    expect(debe.map((x) => x.d)).toEqual(["1160.00000000"]);
  });

  it("H-15 · registrar un gasto llano no pasa de su presupuesto de viajes a la base", async () => {
    // postgres.js no hace pipelining dentro de una transacción: cada sentencia es un viaje, y
    // con la base en otra región cada viaje son decenas de milisegundos. Se cuenta en el cliente
    // de ESTA petición (no en pg_stat_statements, que comparten todos los E2E).
    const sentencias: string[] = [];
    const sqlContado = createClient(URL_API, (q) => sentencias.push(q));
    const appContada = buildApp({
      sql: sqlContado,
      auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER },
    });
    const gasto = async (): Promise<number> => {
      sentencias.length = 0;
      const r = await appContada.request("/v1/expenses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await tokenDe(USUARIO)}`,
          "X-Company-Id": COMPANY,
          "Idempotency-Key": crypto.randomUUID(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          company_id: COMPANY,
          category: "Flete",
          account_id: BANCO,
          amount: "5",
          ...SOBREGIRO,
        }),
      });
      expect(r.status).toBe(201);
      return sentencias.length;
    };
    await gasto(); // calienta la conexión
    const viajes = await gasto();
    if (process.env["LADINO_E2E_DEBUG"] === "1") {
      // eslint-disable-next-line no-console
      console.log(
        `H-15 viajes: ${viajes}\n` +
          sentencias.map((s) => s.trim().slice(0, 90).replace(/\s+/g, " ")).join("\n"),
      );
    }
    await sqlContado.end();
    // Medido el 2026-10-03, con el sobregiro confirmado: 46 antes, 40 después (18 de ellas son
    // del middleware: alcance, membresía e idempotencia, fuera del caso de uso). El presupuesto
    // deja margen para dos sentencias nuevas con motivo, y caza que vuelvan las seis quitadas.
    expect(viajes).toBeLessThanOrEqual(42);
  });

  it("el evento del gasto con factura es `ap.expense_invoice_posted` en la auditoría y en el outbox: el mismo nombre que su plantilla, y NO además `ap.invoice_posted`", async () => {
    const actas = await sql<{ t: string }[]>`
      select event_type as t from public.audit_events
       where aggregate_id = ${FACTURA_LUZ} and event_type like 'ap.%invoice_posted'`;
    expect(actas.map((a) => a.t)).toEqual(["ap.expense_invoice_posted"]);
    const eventos = await sql<{ t: string; categoria: string | null }[]>`
      select event_type as t, payload ->> 'expense_category' as categoria from public.outbox
       where aggregate_id = ${FACTURA_LUZ} and event_type like 'ap.%invoice_posted'`;
    expect(eventos).toEqual([{ t: "ap.expense_invoice_posted", categoria: "Luz" }]);
    const [asiento] = await sql<{ e: string }[]>`
      select source_event as e from public.journal_entries
       where company_id = ${COMPANY} and source_kind = 'purchase_invoice'
         and source_id = ${FACTURA_LUZ}`;
    expect(asiento!.e).toBe("ap.expense_invoice_posted");
  });

  it("la vista previa dice ANTES de confirmar base por categoría, IVA, retención, total y lo que sale — y no escribe nada; registrar da las mismas cifras", async () => {
    const cuerpo = gastoConFactura(`LUZ-${RUN}-P`) as Record<string, unknown>;
    delete cuerpo["allow_negative_balance"];
    delete cuerpo["overdraft_reason"];
    const [antes] = await sql<Record<string, number>[]>`
      select (select count(*)::int from public.supplier_invoices where company_id = ${COMPANY}) as f,
             (select count(*)::int from public.retention_vouchers where company_id = ${COMPANY}) as v,
             (select count(*)::int from public.audit_events where company_id = ${COMPANY}) as a,
             -- La vista previa corre el PAGO y lo deshace: tampoco deja pago, ni evento, ni gasta
             -- un número del comprobante de retención (su contador es el mayor sequence).
             (select count(*)::int from public.supplier_payments where company_id = ${COMPANY}) as p,
             (select count(*)::int from public.outbox where company_id = ${COMPANY}) as o,
             (select coalesce(max(sequence), 0)::int from public.retention_vouchers
               where company_id = ${COMPANY}) as n,
             (select count(*)::int from public.expenses where company_id = ${COMPANY}) as g`;
    const r = await pedir("POST", "/v1/expenses/preview", cuerpo);
    expect(r.status).toBe(200);
    const v = (await r.json()) as Record<string, unknown>;
    expect(v).toEqual({
      currency: "VES",
      lines: [
        {
          tax_category_code: "gravado_general",
          base: "1000.00000000",
          tax_rate: "0.16000000",
          tax_amount: "160.00000000",
        },
        {
          tax_category_code: "exento",
          base: "200.00000000",
          tax_rate: "0.00000000",
          tax_amount: "0.00000000",
        },
      ],
      subtotal_amount: "1200.00000000",
      tax_amount: "160.00000000",
      total_amount: "1360.00000000",
      retention_total: "120.00000000",
      retention_currency: "VES",
      tax_is_recoverable: true,
      amount: "1240.00000000",
      account_currency: "VES",
      fx_rate: null,
      fx_rate_currency: null,
      fx_rate_date: null,
      // La cuenta está en negativo: la vista previa enseña TODAS las cifras y además lo dice.
      insufficient_funds: expect.stringContaining("Banco Bs") as unknown as string,
    });
    const [despues] = await sql<Record<string, number>[]>`
      select (select count(*)::int from public.supplier_invoices where company_id = ${COMPANY}) as f,
             (select count(*)::int from public.retention_vouchers where company_id = ${COMPANY}) as v,
             (select count(*)::int from public.audit_events where company_id = ${COMPANY}) as a,
             -- La vista previa corre el PAGO y lo deshace: tampoco deja pago, ni evento, ni gasta
             -- un número del comprobante de retención (su contador es el mayor sequence).
             (select count(*)::int from public.supplier_payments where company_id = ${COMPANY}) as p,
             (select count(*)::int from public.outbox where company_id = ${COMPANY}) as o,
             (select coalesce(max(sequence), 0)::int from public.retention_vouchers
               where company_id = ${COMPANY}) as n,
             (select count(*)::int from public.expenses where company_id = ${COMPANY}) as g`;
    expect(despues).toEqual(antes);

    // Lo que falla al registrar falla en la vista previa, con su mensaje.
    const mala = await pedir(
      "POST",
      "/v1/expenses/preview",
      gastoConFactura(`LUZ-${RUN}-P`, { lines: [{ tax_category_code: "inventada", base: "1" }] }),
    );
    expect(mala.status).toBe(422);
    expect(((await mala.json()) as { message: string }).message).toContain("«inventada»");
    // Un gasto llano no tiene nada que previsualizar.
    const llano = await pedir("POST", "/v1/expenses/preview", {
      company_id: COMPANY,
      category: "Café",
      account_id: BANCO,
      amount: "50",
    });
    expect(llano.status).toBe(422);
    // Sin el permiso, 403.
    expect((await pedir("POST", "/v1/expenses/preview", cuerpo, CAJERO)).status).toBe(403);

    // Y registrar el MISMO cuerpo da las cifras que la vista previa enseñó.
    const reg = await pedir("POST", "/v1/expenses", gastoConFactura(`LUZ-${RUN}-P`));
    expect(reg.status).toBe(201);
    const g = (await reg.json()) as Record<string, unknown> & { invoice: Record<string, unknown> };
    expect(g["amount"]).toBe(v["amount"]);
    expect(g.invoice["total_amount"]).toBe(v["total_amount"]);
    expect(g.invoice["retention_total"]).toBe(v["retention_total"]);
  });

  it("«lo que gané»: el mismo gasto CON y SIN factura baja la ganancia lo mismo (la base, sin el IVA recuperable), con contabilidad y sin ella, y no se cuenta dos veces", async () => {
    const ganado = async (empresa: string): Promise<number> => {
      const r = await pedir("GET", "/v1/negocio/resumen", undefined, USUARIO, empresa);
      expect(r.status).toBe(200);
      return Number(((await r.json()) as { ganado_mes: string }).ganado_mes);
    };
    for (const [empresa, banco, proveedor, desdeElMayor] of [
      [COMPANY, BANCO, PROV, true],
      [SIN_PLAN, BANCO_SIN_PLAN, PROV_SIN_PLAN, false],
    ] as const) {
      const resumen = await pedir("GET", "/v1/negocio/resumen", undefined, USUARIO, empresa);
      expect(
        ((await resumen.json()) as { ganado_desde_contabilidad: boolean })
          .ganado_desde_contabilidad,
      ).toBe(desdeElMayor);
      const g0 = await ganado(empresa);
      const llano = await pedir(
        "POST",
        "/v1/expenses",
        {
          company_id: empresa,
          category: "Teléfono",
          account_id: banco,
          amount: "1200",
          ...SOBREGIRO,
        },
        USUARIO,
        empresa,
      );
      expect(llano.status).toBe(201);
      const g1 = await ganado(empresa);
      const conFactura = await pedir(
        "POST",
        "/v1/expenses",
        {
          company_id: empresa,
          category: "Teléfono",
          account_id: banco,
          ...SOBREGIRO,
          invoice: {
            supplier_id: proveedor,
            document_number: `TEL-${RUN}-${desdeElMayor ? "A" : "B"}`,
            control_number: "00-TEL",
            invoice_date: HOY,
            // Base 1 200 (1 000 gravados + 200 exentos): el IVA de 160 es crédito, no gasto.
            lines: [
              { tax_category_code: "gravado_general", base: "1000" },
              { tax_category_code: "exento", base: "200" },
            ],
          },
        },
        USUARIO,
        empresa,
      );
      expect(conFactura.status, await conFactura.clone().text()).toBe(201);
      const g2 = await ganado(empresa);
      // El gasto llano de 1 200 y el gasto con factura de base 1 200 bajan lo mismo.
      expect(Math.round((g0 - g1) * 100)).toBe(120000);
      expect(Math.round((g1 - g2) * 100)).toBe(120000);
    }
  });

  it("quien SOLO lleva gastos (expense.register, expense.read, treasury.overdraft) registra el gasto con factura de punta a punta, LEYENDO el catálogo de exclusiones: ninguna lectura del formulario le da 403", async () => {
    const lee = (ruta: string) => pedir("GET", ruta, undefined, GASTOS);
    // Proveedores, categorías tributarias, tasa del día y las cuentas de las que puede salir.
    const proveedores = await lee("/v1/suppliers?per_page=50&search=Electricidad");
    expect(proveedores.status).toBe(200);
    const proveedor = ((await proveedores.json()) as { items: { id: string }[] }).items.find(
      (x) => x.id === PROV,
    );
    expect(proveedor).toBeDefined();
    const categorias = await lee("/v1/tax-categories");
    expect(categorias.status).toBe(200);
    expect(((await categorias.json()) as { code: string }[]).map((c) => c.code)).toContain(
      "gravado_general",
    );
    expect((await lee("/v1/negocio/tasa")).status).toBe(200);
    // Ver el dinero NO es suyo (ADR-0048): por eso el formulario le ofrece las candidatas.
    expect((await lee("/v1/treasury/accounts")).status).toBe(403);
    const candidatas = await lee("/v1/treasury/accounts/candidates");
    expect(candidatas.status).toBe(200);
    const cuentas = (
      (await candidatas.json()) as { instruments: { accounts: { id: string }[] }[] }
    ).instruments.flatMap((i) => i.accounts.map((a) => a.id));
    expect(cuentas).toContain(BANCO);
    expect(cuentas).toContain(BANCO_USD);

    // EL CATÁLOGO DE EXCLUSIONES, leído (no un código escrito a mano): antes, 403.
    const catalogo = await lee("/v1/retention-exclusions");
    expect(catalogo.status).toBe(200);
    const domiciliado = (
      (await catalogo.json()) as { items: { code: string; legal_article: string }[] }
    ).items.find((x) => x.legal_article === "art. 3 num. 8");
    expect(domiciliado).toBeDefined();

    const cuerpo = {
      company_id: COMPANY,
      category: "Agua",
      account_id: BANCO,
      invoice: {
        supplier_id: PROV,
        document_number: `AGUA-${RUN}`,
        control_number: "00-AGUA",
        invoice_date: HOY,
        lines: [{ tax_category_code: "gravado_general", base: "300" }],
        retention_exclusion: {
          code: domiciliado!.code,
          reason: "El agua se paga por domiciliación en la cuenta del banco",
        },
      },
    };
    const previa = await pedir("POST", "/v1/expenses/preview", cuerpo, GASTOS);
    expect(previa.status).toBe(200);
    const v = (await previa.json()) as Record<string, unknown>;
    expect(v["retention_total"]).toBe("0.00000000");
    expect(v["amount"]).toBe("348.00000000");
    const r = await pedir("POST", "/v1/expenses", { ...cuerpo, ...SOBREGIRO }, GASTOS);
    expect(r.status, await r.clone().text()).toBe(201);
    const g = (await r.json()) as Record<string, unknown> & { invoice: Record<string, unknown> };
    expect(g.invoice["retention_total"]).toBe("0.00000000");
    expect(g["amount"]).toBe("348.00000000");
    // Y lo ve en su historial.
    const lista = await lee(`/v1/expenses?from=${HOY}`);
    expect(lista.status).toBe(200);
    expect(
      ((await lista.json()) as { items: { id: string }[] }).items.some((x) => x.id === g["id"]),
    ).toBe(true);
    // El catálogo de comprobantes de retención sigue cerrado para él: solo se abrió el de exclusiones.
    expect((await lee("/v1/retention-vouchers")).status).toBe(403);
  });

  it("la moneda de la factura es la IMPRESA, no la de la cuenta: en Bs pagada desde una cuenta en USD entra al libro con sus bases impresas y la cuenta baja en USD a la tasa del día; en USD desde USD, sin cruzar", async () => {
    // La tasa del día es GLOBAL y otros E2E borran la de hoy al sembrar la suya: se vuelve a
    // poner aquí, justo antes de usarla, bajo el mismo candado.
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
      // Una por día (`exchange_rates_day_key`): se retira la que haya y se pone la propia, como
      // hace e2e-el-centimo. A 40 Bs por USD el neto de 1 240 Bs son 31,00 USD exactos.
      await tx`
        delete from public.exchange_rates
         where company_id is null and from_currency = 'USD' and to_currency = 'VES'
           and rate_date = ${HOY}::date`;
      await tx`
        insert into public.exchange_rates
          (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
        values ('USD', 'VES', 40, ${HOY}::date, now(), ${FUENTE_TASA})`;
    });
    // A 40 la conversión cae exacta (1 240 / 40 = 31,00): este caso prueba el camino. Que
    // funcione a una tasa REAL, donde lo que sale se redondea al céntimo de dólar, lo prueba el
    // caso siguiente (a 854,4637).
    // (a) Factura en Bs, cuenta en USD. Sin `currency`: por omisión, la funcional.
    const cuerpoA = gastoConFactura(`LUZ-${RUN}-MA`) as Record<string, unknown>;
    cuerpoA["account_id"] = BANCO_USD;
    const sinConfirmar = { ...cuerpoA };
    delete sinConfirmar["allow_negative_balance"];
    delete sinConfirmar["overdraft_reason"];
    const previa = await pedir("POST", "/v1/expenses/preview", sinConfirmar);
    expect(previa.status, await previa.clone().text()).toBe(200);
    const v = (await previa.json()) as Record<string, string | null>;
    expect(v["currency"]).toBe("VES");
    expect(v["total_amount"]).toBe("1360.00000000");
    expect(v["account_currency"]).toBe("USD");
    expect(v["fx_rate_currency"]).toBe("USD");
    expect(v["fx_rate_date"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // La cuenta en USD está en cero: el resumen sale igual, con su «no alcanza».
    expect(v["insufficient_funds"]).toContain("Banco USD");

    const a = await pedir("POST", "/v1/expenses", cuerpoA);
    expect(a.status, await a.clone().text()).toBe(201);
    const ga = (await a.json()) as Record<string, unknown> & { invoice: Record<string, unknown> };
    expect(ga.invoice["currency"]).toBe("VES");
    expect(ga.invoice["subtotal_amount"]).toBe("1200.00000000");
    expect(ga.invoice["tax_amount"]).toBe("160.00000000");
    expect(ga.invoice["retention_total"]).toBe("120.00000000");
    expect(ga["currency"]).toBe("USD");
    // Lo que la vista previa dijo que salía es lo que salió.
    expect(ga["amount"]).toBe(v["amount"]);
    const [fa] = await sql<Record<string, unknown>[]>`
      select i.transaction_currency as moneda, i.fx_rate::text as tasa_factura, i.status,
             p.transaction_currency as moneda_pago, p.settled_amount::text as saldado,
             p.settled_currency as moneda_saldada,
             -- Lo que sale en USD es el neto en Bs a la tasa del día del pago, al céntimo.
             p.net_amount = round(1240 / (select f.rate from platform.rate_for(
               i.company_id, 'USD', 'VES', ${HOY}::date) f), 2) as a_la_tasa_del_dia
        from public.supplier_invoices i
        join public.supplier_payments p on p.supplier_invoice_id = i.id
       where i.id = ${ga["supplier_invoice_id"] as string}`;
    expect(fa).toEqual({
      moneda: "VES",
      tasa_factura: "1.00000000",
      status: "paid",
      moneda_pago: "USD",
      saldado: "1240.00000000",
      moneda_saldada: "VES",
      a_la_tasa_del_dia: true,
    });
    // EL LIBRO lleva lo impreso: la factura está, en Bs, con sus bases tal cual.
    const [lineas] = await sql<{ gravada: string; exenta: string }[]>`
      select sum(line_subtotal_transaction) filter (where tax_treatment = 'gravado')::text as gravada,
             sum(line_subtotal_transaction) filter (where tax_treatment = 'exento')::text as exenta
        from public.supplier_invoice_lines
       where supplier_invoice_id = ${ga["supplier_invoice_id"] as string}`;
    expect(lineas).toEqual({ gravada: "1000.00000000", exenta: "200.00000000" });
    const libro = await sql<{ invoice_id: string }[]>`
      select invoice_id from platform.purchases_book_with_vouchers(${COMPANY}, ${HOY}::date, ${HOY}::date)
       where invoice_id = ${ga["supplier_invoice_id"] as string}`;
    expect(libro).toHaveLength(1);
    const [saldo] = await sql<{ igual: boolean }[]>`
      select b.balance = -(${ga["amount"] as string})::numeric as igual
        from public.company_account_balances b where b.account_id = ${BANCO_USD}`;
    expect(saldo!.igual).toBe(true);

    // (b) Factura en USD, cuenta en USD: no cruza; las bases son dólares.
    const cuerpoB = gastoConFactura(`LUZ-${RUN}-MB`, { currency: "USD" }) as Record<
      string,
      unknown
    >;
    cuerpoB["account_id"] = BANCO_USD;
    const b = await pedir("POST", "/v1/expenses", cuerpoB);
    expect(b.status, await b.clone().text()).toBe(201);
    const gb = (await b.json()) as Record<string, unknown> & { invoice: Record<string, unknown> };
    expect(gb.invoice["currency"]).toBe("USD");
    expect(gb.invoice["total_amount"]).toBe("1360.00000000");
    expect(gb["currency"]).toBe("USD");
    const [fb] = await sql<Record<string, unknown>[]>`
      select i.transaction_currency as moneda, i.status,
             p.transaction_currency as moneda_pago, p.net_amount = coalesce(p.settled_amount, p.net_amount) as sin_cruzar
        from public.supplier_invoices i
        join public.supplier_payments p on p.supplier_invoice_id = i.id
       where i.id = ${gb["supplier_invoice_id"] as string}`;
    expect(fb).toEqual({ moneda: "USD", status: "paid", moneda_pago: "USD", sin_cruzar: true });
    // (c) Factura en Bs desde cuenta en Bs es el primer caso de este fichero.
  });

  it("a TASA REAL (854,4637): el gasto con factura en Bs pagado desde una cuenta en USD se registra — antes 409 SETTLEMENT_MISMATCH—; lo que dice la vista previa es lo que sale, la factura queda pagada y no nace un diferencial por el céntimo de dólar", async () => {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
      await tx`
        delete from public.exchange_rates
         where company_id is null and from_currency = 'USD' and to_currency = 'VES'
           and rate_date = ${HOY}::date`;
      await tx`
        insert into public.exchange_rates
          (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
        values ('USD', 'VES', 854.4637, ${HOY}::date, now(), ${FUENTE_TASA})`;
    });
    const saldoUsd = async (): Promise<string> =>
      (
        await sql<{ b: string }[]>`
          select balance::text as b from public.company_account_balances
           where account_id = ${BANCO_USD}`
      )[0]!.b;
    const antes = await saldoUsd();

    // Neto 1 240 Bs (1 360 − 120 retenidos). 1 240 / 854,4637 = 1,4512… → salen 1,45 USD, que a
    // la tasa son 1 238,97 Bs: 1,03 Bs de redondeo de caja, dentro de medio céntimo de dólar.
    const cuerpo = gastoConFactura(`LUZ-${RUN}-TR`) as Record<string, unknown>;
    cuerpo["account_id"] = BANCO_USD;
    const sinConfirmar = { ...cuerpo };
    delete sinConfirmar["allow_negative_balance"];
    delete sinConfirmar["overdraft_reason"];
    const previa = await pedir("POST", "/v1/expenses/preview", sinConfirmar);
    expect(previa.status, await previa.clone().text()).toBe(200);
    const v = (await previa.json()) as Record<string, string | null>;
    expect(v).toMatchObject({
      currency: "VES",
      total_amount: "1360.00000000",
      retention_total: "120.00000000",
      amount: "1.45000000",
      account_currency: "USD",
      fx_rate: "854.46370000",
      fx_rate_currency: "USD",
    });

    const r = await pedir("POST", "/v1/expenses", cuerpo);
    expect(r.status, await r.clone().text()).toBe(201);
    const g = (await r.json()) as Record<string, unknown>;
    // Lo que la vista previa dijo que salía es lo que salió, en la moneda de la cuenta.
    expect(g["amount"]).toBe(v["amount"]);
    expect(g["currency"]).toBe("USD");
    // Lo funcional del pago es lo que se debía, no «1,45 × 854,4637 = 1 238,97».
    expect(g["functional_amount"]).toBe("1240.00000000");
    const factura = g["supplier_invoice_id"] as string;
    const [fila] = await sql<Record<string, unknown>[]>`
      select i.status, p.transaction_currency as moneda_pago, p.net_amount::text as salio,
             p.settled_amount::text as saldado, p.settled_currency as moneda_saldada,
             p.functional_amount::text as funcional, p.exchange_difference::text as dif,
             platform.supplier_invoice_balance(i.company_id, i.id)::text as saldo,
             (select count(*)::int from public.journal_entries e
                join public.journal_lines l on l.entry_id = e.id
               where e.company_id = i.company_id and e.source_kind = 'payment_made'
                 and e.source_id = p.id and e.status = 'posted') as lineas_del_asiento
        from public.supplier_invoices i
        join public.supplier_payments p on p.supplier_invoice_id = i.id
       where i.id = ${factura}`;
    expect(fila).toEqual({
      status: "paid",
      moneda_pago: "USD",
      salio: "1.45000000",
      saldado: "1240.00000000",
      moneda_saldada: "VES",
      funcional: "1240.00000000",
      dif: "0.00000000",
      saldo: "0.00000000",
      // Cuenta por pagar contra la caja: sin tercera línea de diferencial ni de redondeo.
      lineas_del_asiento: 2,
    });
    // La cuenta en USD baja por lo que salió EN SU MONEDA.
    const [bajo] = await sql<{ igual: boolean }[]>`
      select ${await saldoUsd()}::numeric = ${antes}::numeric - 1.45 as igual`;
    expect(bajo!.igual).toBe(true);

    const [n] = await sql<Record<string, number>[]>`
      select (select count(*)::int from platform.settled_ledger_gaps(${COMPANY})) as saldados,
             (select count(*)::int from platform.treasury_currency_gaps(${COMPANY})) as divisa,
             (select count(*)::int from platform.treasury_ledger_gaps(${COMPANY})) as tesoreria,
             (select count(*)::int from platform.cent_gaps(${COMPANY})) as centimo`;
    expect({ ...n }).toEqual({ saldados: 0, divisa: 0, tesoreria: 0, centimo: 0 });
    const [b] = await sql<{ d: string }[]>`
      select coalesce(sum(period_debit) - sum(period_credit), 0)::text as d
        from platform.trial_balance(${COMPANY}, ${HOY}::date, null)`;
    expect(Number(b!.d)).toBe(0);
  });

  it("H-08 · el comprobante: más de 6 MB es 422, un PNG se guarda como .png, el contenido tiene que ser el que se declara, sin `expense.register` es 403 — y en los tres rechazos NO se sube nada", async () => {
    const subir = async (archivo: File, quien: string): Promise<Response> => {
      const cuerpo = new FormData();
      cuerpo.append("file", archivo);
      return appConStorage.request("/v1/expenses/attachment", {
        method: "POST",
        headers: { Authorization: `Bearer ${await tokenDe(quien)}`, "X-Company-Id": COMPANY },
        body: cuerpo,
      });
    };
    const objetos = async (): Promise<number> => {
      const [o] = await sql<{ n: number }[]>`
        select count(*)::int as n from storage.objects
         where bucket_id = 'receipts' and name like ${`${COMPANY}/%`}`;
      return o!.n;
    };
    const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const png = (bytes: number): File => {
      const b = new Uint8Array(bytes);
      b.set(PNG);
      return new File([b], "recibo.png", { type: "image/png" });
    };
    expect(await objetos()).toBe(0);

    // Más de 6 MB: 422, y nada subido.
    const grande = await subir(png(6 * 1024 * 1024 + 1), GASTOS);
    expect(grande.status).toBe(422);
    expect(((await grande.json()) as { message: string }).message).toContain("6 MB");
    expect(await objetos()).toBe(0);

    // Dice ser PNG y es un PDF: 422, y nada subido.
    const disfrazado = await subir(
      new File([new TextEncoder().encode("%PDF-1.4 no soy una foto")], "recibo.png", {
        type: "image/png",
      }),
      GASTOS,
    );
    expect(disfrazado.status).toBe(422);
    expect(((await disfrazado.json()) as { message: string }).message).toContain(
      "no es lo que dice ser",
    );
    expect(await objetos()).toBe(0);

    // Sin `expense.register`: 403 ANTES de subir nada.
    const ajeno = await subir(png(64), CAJERO);
    expect(ajeno.status).toBe(403);
    expect(await objetos()).toBe(0);

    // Un PNG de verdad: se guarda con SU extensión, bajo la carpeta de la empresa.
    const bueno = await subir(png(64), GASTOS);
    expect(bueno.status, await bueno.clone().text()).toBe(201);
    const ruta = ((await bueno.json()) as { attachment_path: string }).attachment_path;
    expect(ruta).toMatch(new RegExp(`^${COMPANY}/receipts/[a-z0-9-]+\\.png$`));
    expect(await objetos()).toBe(1);

    // La ruta del comprobante tiene que ser de ESTA empresa: la de otra, 422 (llano y con factura).
    const deOtra = `${SIN_RIF}/receipts/ajeno.png`;
    const llano = await pedir(
      "POST",
      "/v1/expenses",
      {
        company_id: COMPANY,
        category: "Café",
        account_id: BANCO,
        amount: "1",
        ...SOBREGIRO,
        attachment_path: deOtra,
      },
      GASTOS,
    );
    expect(llano.status).toBe(422);
    expect(((await llano.json()) as { message: string }).message).toContain(
      "no es de esta empresa",
    );
    const conFactura = await pedir(
      "POST",
      "/v1/expenses",
      { ...gastoConFactura(`LUZ-${RUN}-ADJ`), attachment_path: deOtra },
      GASTOS,
    );
    expect(conFactura.status).toBe(422);
    expect(await facturasCon(`LUZ-${RUN}-ADJ`)).toBe(0);
    // Ni con `..` (empieza por la carpeta propia y sale de ella) ni con un prefijo que escape
    // (la carpeta propia no es el PRINCIPIO de la ruta, o solo se le parece): 422, el mismo
    // mensaje, y ningún gasto escrito.
    const gastosAntes = (
      await sql<{ n: number }[]>`
        select count(*)::int as n from public.expenses where company_id = ${COMPANY}`
    )[0]!.n;
    for (const escapa of [
      `${COMPANY}/receipts/../../${SIN_RIF}/receipts/ajeno.png`,
      `${COMPANY}/receipts/..`,
      `${COMPANY}/receipts/a/../../../${SIN_RIF}/receipts/ajeno.png`,
      `../${COMPANY}/receipts/ajeno.png`,
      `/${COMPANY}/receipts/ajeno.png`,
      `${SIN_RIF}/../${COMPANY}/receipts/ajeno.png`,
      `${COMPANY}x/receipts/ajeno.png`,
      `${COMPANY}/receipts-de-otro/ajeno.png`,
    ]) {
      const r = await pedir(
        "POST",
        "/v1/expenses",
        {
          company_id: COMPANY,
          category: "Café",
          account_id: BANCO,
          amount: "1",
          ...SOBREGIRO,
          attachment_path: escapa,
        },
        GASTOS,
      );
      const cuerpo = (await r.json()) as { code: string; message: string };
      expect([escapa, r.status, cuerpo.code, cuerpo.message]).toEqual([
        escapa,
        422,
        "VALIDATION_FAILED",
        "Ese comprobante no es de esta empresa. Vuelve a adjuntarlo desde el formulario del gasto.",
      ]);
    }
    expect(
      (
        await sql<{ n: number }[]>`
          select count(*)::int as n from public.expenses where company_id = ${COMPANY}`
      )[0]!.n,
    ).toBe(gastosAntes);
    // Con la suya, entra y queda enlazada.
    const propio = await pedir(
      "POST",
      "/v1/expenses",
      { ...gastoConFactura(`LUZ-${RUN}-ADJ`), attachment_path: ruta },
      GASTOS,
    );
    expect(propio.status, await propio.clone().text()).toBe(201);
    expect(((await propio.json()) as { attachment_path: string }).attachment_path).toBe(ruta);
  });

  it("AF4-01 · la exclusión del servicio público domiciliado exige una cuenta BANCARIA: pagado desde una caja es 422 con su mensaje —también en la vista previa— y no se escribe nada; desde el banco no retiene y deja su acta; y el catálogo no la ofrece para una caja", async () => {
    // PA SNAT/2025/000054 art. 3 num. 8: «pagados mediante domiciliación a cuentas bancarias de
    // los agentes de retención». El medio de pago es condición del texto, y en el gasto con
    // factura la cuenta de la que sale el dinero se conoce en el mismo acto.
    const caja = await pedir("POST", "/v1/treasury/accounts", {
      company_id: COMPANY,
      name: `Caja AF4 ${RUN}`,
      currency: "VES",
      kind: "cash",
    });
    expect(caja.status, await caja.clone().text()).toBe(201);
    const CAJA = ((await caja.json()) as { id: string }).id;
    const exclusion = {
      retention_exclusion: {
        code: "servicio_publico_domiciliado",
        reason: "La luz de la tienda, pagada en efectivo en la taquilla",
      },
    };
    const numero = `LUZ-${RUN}-AF4`;
    const desdeCaja = { ...gastoConFactura(numero, exclusion), account_id: CAJA };
    const actasAntes = async (): Promise<number> => {
      const [a] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.audit_events
         where company_id = ${COMPANY} and event_type = 'ap.retention_excluded'`;
      return a!.n;
    };
    const actas = await actasAntes();
    const saldoDe = async (cuenta: string): Promise<string | undefined> => {
      const [s] = await sql<{ b: string }[]>`
        select balance::text as b from public.company_account_balances
         where account_id = ${cuenta}`;
      return s?.b;
    };
    const saldoCaja = await saldoDe(CAJA);

    // LA VISTA PREVIA lo dice antes de confirmar: no enseña cifras de una exclusión que no vale.
    const previa = await pedir("POST", "/v1/expenses/preview", desdeCaja);
    expect(previa.status, await previa.clone().text()).toBe(422);
    const pv = (await previa.json()) as { code: string; message: string };
    expect(pv.code).toBe("VALIDATION_FAILED");
    // El mensaje, no solo el código: otros 422 de la exclusión dan el mismo `code`.
    expect(pv.message).toContain("domiciliación desde una cuenta bancaria");
    expect(pv.message).toContain(`Caja AF4 ${RUN}`);

    const r = await pedir("POST", "/v1/expenses", desdeCaja);
    expect(r.status, await r.clone().text()).toBe(422);
    const e = (await r.json()) as { code: string; message: string };
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(e.message).toContain("domiciliación desde una cuenta bancaria");
    expect(e.message).toContain("se le retiene");
    // NADA escrito: ni factura, ni acta de exclusión, ni un céntimo fuera de la caja.
    expect(await facturasCon(numero)).toBe(0);
    expect(await actasAntes()).toBe(actas);
    expect(await saldoDe(CAJA)).toBe(saldoCaja);

    // Desde la caja, SIN la exclusión, el gasto entra y RETIENE: la caja no está vetada, lo
    // vetado es dejar de retener.
    const retenido = await pedir("POST", "/v1/expenses", {
      ...gastoConFactura(`${numero}-R`),
      account_id: CAJA,
    });
    expect(retenido.status, await retenido.clone().text()).toBe(201);
    expect(
      ((await retenido.json()) as { invoice: Record<string, unknown> }).invoice["retention_total"],
    ).toBe("120.00000000");

    // El MISMO cuerpo desde la cuenta bancaria: 201, sin retención, con su acta.
    const desdeBanco = await pedir("POST", "/v1/expenses", gastoConFactura(numero, exclusion));
    expect(desdeBanco.status, await desdeBanco.clone().text()).toBe(201);
    const g = (await desdeBanco.json()) as Record<string, unknown> & {
      invoice: Record<string, unknown>;
    };
    expect(g.invoice["retention_total"]).toBe("0.00000000");
    expect(g.invoice["retention_voucher_number"]).toBeNull();
    const [acta] = await sql<{ p: Record<string, string> }[]>`
      select payload as p from public.audit_events
       where aggregate_id = ${g["supplier_invoice_id"] as string}
         and event_type = 'ap.retention_excluded'`;
    expect(acta!.p["exclusion_code"]).toBe("servicio_publico_domiciliado");

    // EL CATÁLOGO OFRECIBLE lo decide el servidor con la cuenta como parámetro: para una caja no
    // trae esa exclusión (y sí las demás); para el banco y sin cuenta, la trae.
    const codigos = async (consulta: string): Promise<string[]> => {
      const c = await pedir("GET", `/v1/retention-exclusions${consulta}`);
      expect(c.status, await c.clone().text()).toBe(200);
      return ((await c.json()) as { items: { code: string }[] }).items.map((x) => x.code);
    };
    const paraCaja = await codigos(`?account_id=${CAJA}`);
    expect(paraCaja).not.toContain("servicio_publico_domiciliado");
    expect(paraCaja).toContain("viaticos");
    expect(await codigos(`?account_id=${BANCO}`)).toContain("servicio_publico_domiciliado");
    expect(await codigos("")).toContain("servicio_publico_domiciliado");
    // Una cuenta de otra empresa (o que no existe) no revela nada: 404.
    const ajena = await pedir("GET", `/v1/retention-exclusions?account_id=${BANCO_SIN_RIF}`);
    expect(ajena.status).toBe(404);
  });

  it("los invariantes cruzados quedan en cero en las dos empresas", async () => {
    for (const empresa of [COMPANY, SIN_RIF]) {
      const [n] = await sql<Record<string, number>[]>`
        select (select count(*)::int from platform.accounting_coverage_gaps(${empresa})) as cobertura,
               (select count(*)::int from platform.retention_voucher_gaps(${empresa})) as comprobantes,
               (select count(*)::int from platform.treasury_ledger_gaps(${empresa})) as tesoreria,
               (select count(*)::int
                  from platform.book_ledger_reconciliation(${empresa}, ${HOY}::date, ${HOY}::date) b
                 where not b.cuadra) as libro`;
      expect(n).toEqual({ cobertura: 0, comprobantes: 0, tesoreria: 0, libro: 0 });
      const [moneda] = await sql<Record<string, number>[]>`
        select (select count(*)::int from platform.settled_ledger_gaps(${empresa})) as saldados,
               (select count(*)::int from platform.treasury_currency_gaps(${empresa})) as cajas`;
      expect(moneda).toEqual({ saldados: 0, cajas: 0 });
    }
  });
});

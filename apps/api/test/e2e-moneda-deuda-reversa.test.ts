import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";
import { fiadoDeFixture } from "./_fiado-de-fixture.js";
import { borrarTasasOficiales, sembrarTasaOficial } from "./_tasa-oficial.js";

/**
 * MONEDA B (ADR-0075 §5, §6 y §8): una sola deuda, la divisa en el mayor y la reversa de cobros.
 *
 *   E-11 — la línea de caja de un cobro en divisa guarda su moneda, su importe original y su tasa;
 *   F-04 — la lista de clientes, el estado de cuenta, la antigüedad y «Lo que me deben» dan LA
 *          MISMA cifra, y el estado de cuenta trae el nominal en USD con la tasa y la fecha;
 *   J-04 — el saldo en USD de la caja es la suma de los originales en USD de su subcuenta;
 *   R-61 — un cobro se reversa: el documento vuelve a deber, su asiento queda revertido;
 *   P-67 — el IGTF del cobro reversado queda pendiente de reintegro y se restituye;
 *   F-11 — el contador reversa una retención soportada y la vuelve a cargar corregida;
 *   E-11/J-04 — al cierre, la caja y las cuentas por cobrar en USD se revalúan.
 *
 * Tasas elegidas para que las cuentas se hagan de cabeza: 40 → 42 → 45 Bs por USD.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const DUENO = crypto.randomUUID();
const CAJERO = crypto.randomUUID();
const ROL = crypto.randomUUID();
const ROL_CAJERO = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const AYER = diaCaracas(-1);
const FUENTE = `e2e-moneda-b-${RUN}`;

interface Empresa {
  tipo: "ordinario" | "especial";
  tenant: string;
  company: string;
  w: string;
  cliente: string;
  producto: string;
  bancoUsd: string;
  bancoBs: string;
}
const nueva = (tipo: Empresa["tipo"]): Empresa => ({
  tipo,
  tenant: crypto.randomUUID(),
  company: crypto.randomUUID(),
  w: crypto.randomUUID(),
  cliente: crypto.randomUUID(),
  producto: "",
  bancoUsd: "",
  bancoBs: "",
});
const ORD = nueva("ordinario");
const SPE = nueva("especial");

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;

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
  e: Empresa,
  metodo: string,
  path: string,
  body?: unknown,
  quien: string = DUENO,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(quien)}`,
    "X-Company-Id": e.company,
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

// Una fuente por siembra: la tabla admite una tasa por (fuente, día), y a igual día manda la
// guardada más tarde. Solo existe la tasa oficial (ADR-0064): es global, así que este fichero no
// puede correr a la vez que otro E2E que siembre tasas de hoy.
let siembras = 0;
const tasa = (rate: string) =>
  // Bajo el candado `ladino-e2e-rates` (como e2e-el-centimo): la tabla de tasas es global y otro
  // E2E puede estar sembrando la suya a la vez.
  sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await sembrarTasaOficial(tx as unknown as typeof sql, {
      rate,
      source: `${FUENTE}-${++siembras}`,
      rate_date: HOY,
    });
  });

/** Factura de un servicio de 100 USD + IVA 16 % = 116 USD. */
async function facturar(e: Empresa): Promise<string> {
  const r = await pedir(e, "POST", "/v1/invoices", {
    company_id: e.company,
    customer_id: e.cliente,
    warehouse_id: e.w,
    series: "A",
    lines: [{ product_id: e.producto, quantity: "1" }],
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

interface Cobro {
  payment: { id: string };
  document_status: string;
  igtf: { id: string; amount: string } | null;
  igtf_debit_note?: { id: string } | null;
}
async function cobrar(e: Empresa, doc: string, cuerpo: Record<string, unknown>): Promise<Cobro> {
  const r = await pedir(e, "POST", "/v1/payments", {
    company_id: e.company,
    document_id: doc,
    ...cuerpo,
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return (await r.json()) as Cobro;
}

interface Reversa {
  id: string;
  kind: string;
  document: { id: string; status: string };
  debt: { currency: string; nominal: string; rate: string | null; functional_today: string } | null;
  igtf: { status: string; restituted_amount: string; currency: string } | null;
  supported_retention: { id: string; status: string } | null;
  reversal_entry_id: string | null;
}
const reversar = (e: Empresa, pago: string, reason: string, quien: string = DUENO) =>
  pedir(e, "POST", `/v1/payments/${pago}/reversal`, { company_id: e.company, reason }, quien);

const saldoCuenta = async (cuenta: string): Promise<string> => {
  const [r] = await sql<{ b: string }[]>`
    select coalesce((select balance from public.company_account_balances
                      where account_id = ${cuenta}), 0)::text as b`;
  return r!.b;
};

/** Los invariantes que la reversa no puede romper: todos en cero filas. */
async function invariantes(e: Empresa): Promise<Record<string, unknown[]>> {
  return {
    cobertura: await sql`select * from platform.accounting_coverage_gaps(${e.company})`,
    tesoreria: await sql`select * from platform.treasury_ledger_gaps(${e.company})`,
    divisa: await sql`select * from platform.treasury_currency_gaps(${e.company})`,
    materializado: await sql`
      select * from platform.treasury_reconciliation(${e.company}) where not ok`,
    saldados: await sql`select * from platform.settled_ledger_gaps(${e.company})`,
  };
}
const CEROS = { cobertura: [], tesoreria: [], divisa: [], materializado: [], saldados: [] };

/** La línea de caja del asiento de un hecho (la de su subcuenta de tesorería). */
async function lineaDeCaja(e: Empresa, kind: string, id: string, cuenta: string) {
  const [l] = await sql<Record<string, string>[]>`
    select l.transaction_currency as moneda, l.amount_transaction_currency::text as original,
           l.fx_rate::text as tasa, l.functional_amount::text as funcional,
           l.debit_amount::text as debe, l.functional_debit::text as debe_funcional,
           l.rate_source as fuente
      from public.journal_entries en
      join public.journal_lines l on l.entry_id = en.id
      join public.company_accounts ca on ca.ledger_account_id = l.account_id
     where en.company_id = ${e.company} and en.source_kind = ${kind} and en.source_id = ${id}
       and ca.id = ${cuenta}`;
  return l;
}

async function sembrar(e: Empresa): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${e.tenant}, ${`Moneda B ${e.tipo}`})`;
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, fiscal_address, functional_currency_code,
                taxpayer_type_code)
             values (${e.company}, ${e.tenant},
                     ${`J${String(Date.now() + (e.tipo === "especial" ? 3 : 0)).slice(-9)}`},
                     ${`Ferretería de la reversa (${e.tipo})`}, 'Av. Bolívar, Valencia', 'VES',
                     ${e.tipo})`;
    await declararTipoDeFixture(tx, e.company);
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${e.w}, ${e.tenant}, ${e.company}, 'E2E-MONB', 'Local')`;
    for (const [usuario, rol] of [
      [DUENO, ROL],
      [CAJERO, ROL_CAJERO],
    ] as const) {
      const mem = crypto.randomUUID();
      const asig = crypto.randomUUID();
      await tx`insert into public.memberships (id, tenant_id, user_id)
               values (${mem}, ${e.tenant}, ${usuario})`;
      await tx`insert into public.user_role_assignments
                 (id, tenant_id, membership_id, role_id, company_id)
               values (${asig}, ${e.tenant}, ${mem}, ${rol}, null)`;
      await tx`insert into public.scope_bindings
                 (tenant_id, company_id, assignment_id, scope_type, scope_id)
               values (${e.tenant}, ${e.company}, ${asig}, 'warehouse', ${e.w})`;
    }
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${e.tenant}, ${e.company}, 'formatos_libres', '2026-01-01'::timestamptz)`;
    // El cliente es un contribuyente especial: es quien nos retiene el IVA.
    await tx`insert into public.customers
               (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                taxpayer_type_code, fiscal_address)
             values (${e.cliente}, ${e.tenant}, ${e.company},
                     ${`J${String(Date.now() + 7).slice(-9)}`}, 'Constructora e2e moneda B',
                     'juridica', 'especial', 'Calle 8, Maracay')`;
    // R-82.1: la factura de administración nace fiada — la empresa de prueba declara que fía.
    await fiadoDeFixture(tx, e.company, [ROL]);
    const [p] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${e.tenant}, ${e.company}, ${`MONB-${e.tipo}-${RUN}`}, 'Servicio de instalación',
              'service', 'active', 'unidad', 'gravado_general') returning id`;
    e.producto = p!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${e.tenant}, ${e.company}, 'detal', 'USD') returning id`;
    await tx`insert into public.company_settings (company_id, tenant_id, default_price_list_id)
             values (${e.company}, ${e.tenant}, ${l!.id})`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${e.tenant}, ${e.company}, ${l!.id}, ${e.producto}, 100,
                     now() - interval '1 day')`;
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
    for (const tipo of ["ordinario", "especial"]) {
      await tx`
        insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                                      rate, effective_from, legal_source, priority,
                                      transaction_type)
        select 'VE', 'iva', ${tipo}, 'gravado_general', 0.16, ${AYER}::date,
               'Carga de prueba E2E — VALIDAR-SENIAT antes de producción.', 10, 'sale'
         where not exists (select 1 from public.tax_rules
                            where company_id is null and jurisdiction = 'VE' and tax_code = 'iva'
                              and taxpayer_type = ${tipo}
                              and product_tax_category = 'gravado_general'
                              and transaction_type = 'sale')`;
    }
  });
  for (const [ruta, cuerpo] of [
    ["/v1/accounts/import-template", { company_id: e.company, template_code: "ve_basico" }],
    ["/v1/journal-templates/import-preset", { company_id: e.company, preset_code: "ve_basico" }],
  ] as const) {
    const r = await pedir(e, "POST", ruta, cuerpo);
    if (r.status !== 201) throw new Error(`${ruta}: ${r.status} ${await r.text()}`);
  }
  const rango = await pedir(e, "POST", "/v1/fiscal-number-ranges", {
    company_id: e.company,
    kind: "invoice",
    series: "A",
    range_from: "1",
    range_to: "500",
    printer_source: "Imprenta E2E moneda B",
    printer_legal_name: "Imprenta E2E, C.A.",
    printer_tax_id: "J-12345678-9",
    printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
    printer_authorization_date: "2020-01-15",
    printed_on: "2026-01-01",
  });
  if (rango.status !== 201) throw new Error(`rango: ${rango.status} ${await rango.text()}`);
  for (const [nombre, moneda] of [
    ["Banco USD", "USD"],
    ["Banco Bs", "VES"],
  ] as const) {
    const r = await pedir(e, "POST", "/v1/treasury/accounts", {
      company_id: e.company,
      name: `${nombre} ${RUN}`,
      currency: moneda,
      kind: "bank",
    });
    if (r.status !== 201) throw new Error(`cuenta: ${r.status} ${await r.text()}`);
    const id = ((await r.json()) as { id: string }).id;
    if (moneda === "USD") e.bancoUsd = id;
    else e.bancoBs = id;
  }
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  for (const u of [DUENO, CAJERO]) {
    await sql`insert into auth.users (id) values (${u}) on conflict (id) do nothing`;
  }
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2emonb_${RUN}`}, 'Dueño moneda B', true),
             (${ROL_CAJERO}, null, ${`e2emonbc_${RUN}`}, 'Cajero moneda B', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.payment.register'),
             (${ROL}, 'ar.read'), (${ROL}, 'treasury.read'),
             (${ROL}, 'treasury.account.manage'), (${ROL}, 'inventory.move'),
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.entry.post'), (${ROL}, 'accounting.read'),
             (${ROL}, 'accounting.period.close'), (${ROL}, 'fiscal.range.manage'),
             (${ROL}, 'ar.payment.reverse'), (${ROL}, 'ar.retention.register'),
             (${ROL}, 'ar.retention.correct'), (${ROL}, 'accounting.period.reopen'),
             (${ROL}, 'sales.invoice.annul'), (${ROL}, 'cash.close'),
             (${ROL}, 'fiscal_book.read'),
             -- El cajero cobra y carga retenciones, pero NO reversa ni corrige.
             (${ROL_CAJERO}, 'sales.payment.register'), (${ROL_CAJERO}, 'ar.read'),
             (${ROL_CAJERO}, 'ar.retention.register')
             on conflict do nothing`;
  });
  await tasa("40.00000000");
  await sembrar(ORD);
  await sembrar(SPE);
}, 60_000);

afterAll(async () => {
  await borrarTasasOficiales(sql, FUENTE);
  await sql?.end();
  await sqlApi?.end();
});

describe("moneda B · la divisa en el mayor y una sola deuda (E-11, J-04, F-04)", () => {
  let A = "";
  let ABONO = "";

  it("E-11 · el cobro de 16 USD asienta su caja EN DÓLARES, con su tasa, y la caja cuadra en su moneda", async () => {
    A = await facturar(ORD); // 116 USD a 40 = 4.640,00 Bs
    const c = await cobrar(ORD, A, {
      currency: "USD",
      amount: "16.00000000",
      instrument: "zelle",
      account_id: ORD.bancoUsd,
    });
    ABONO = c.payment.id;
    expect(c.igtf).toBeNull(); // un ordinario no percibe
    expect(await lineaDeCaja(ORD, "payment_received", ABONO, ORD.bancoUsd)).toEqual({
      moneda: "USD",
      original: "16.00000000",
      tasa: "40.00000000",
      funcional: "640.00000000",
      debe: "16.00000000",
      debe_funcional: "640.00000000",
      fuente: expect.stringContaining(FUENTE),
    });
    // J-04: 16 USD en tesorería = 16 USD originales en su subcuenta.
    expect(await saldoCuenta(ORD.bancoUsd)).toBe("16.00000000");
    expect(await invariantes(ORD)).toEqual(CEROS);
  });

  it("H1 · el cobro en USD cuadra EN BOLÍVARES: la comprobación, el asiento y su detalle (el original va aparte)", async () => {
    // La línea de caja guarda 16 USD en debit_amount (ADR-0020). Quien lea esa columna como
    // bolívares ve 16 al Debe contra 640 al Haber: el mayor y la API leen lo funcional.
    const [asiento] = await sql<{ id: string }[]>`
      select id from public.journal_entries
       where company_id = ${ORD.company} and source_kind = 'payment_received'
         and source_id = ${ABONO}`;
    const [suma] = await sql<{ debe: string; haber: string; crudo: string }[]>`
      select sum(functional_debit)::text as debe, sum(functional_credit)::text as haber,
             sum(debit_amount)::text as crudo
        from public.journal_lines where entry_id = ${asiento!.id}`;
    expect(suma).toEqual({ debe: "640.00000000", haber: "640.00000000", crudo: "16.00000000" });
    // La comprobación de la empresa entera cuadra en Bs.
    const [tb] = await sql<{ debe: string; haber: string }[]>`
      select sum(period_debit)::text as debe, sum(period_credit)::text as haber
        from platform.trial_balance(${ORD.company}, ${HOY}::date)`;
    expect(tb!.debe).toBe(tb!.haber);
    // El detalle que sirve la API: Bs en los dos lados, y el original con su moneda y su tasa.
    const r = await pedir(ORD, "GET", `/v1/journal-entries/${asiento!.id}`);
    expect(r.status, await r.clone().text()).toBe(200);
    const detalle = (await r.json()) as {
      entry: { total_debit: string; total_credit: string };
      lines: Record<string, string>[];
    };
    expect(detalle.entry.total_debit).toBe(detalle.entry.total_credit);
    const caja = detalle.lines.find((l) => l["transaction_currency"] === "USD");
    expect(caja).toMatchObject({
      debit_amount: "640.00000000",
      credit_amount: "0.00000000",
      functional_debit: "640.00000000",
      original_amount: "16.00000000",
      transaction_currency: "USD",
      fx_rate: "40.00000000",
    });
    const debe = detalle.lines.reduce((n, l) => n + Number(l["debit_amount"]), 0);
    const haber = detalle.lines.reduce((n, l) => n + Number(l["credit_amount"]), 0);
    expect(debe).toBe(640);
    expect(haber).toBe(640);
  });

  it("J-04 · la variante rota: una línea en la subcuenta SIN su divisa hace saltar el invariante", async () => {
    // Si el invariante no viera una caja cuyo mayor no tiene sus dólares, el cero de arriba no
    // valdría nada. Se le quita la subcuenta a la caja y se le pone otra vacía: 16 USD contra 0.
    await sql.begin(async (tx) => {
      const [otra] = await tx<{ ledger_account_id: string }[]>`
        select ledger_account_id from public.company_accounts where id = ${ORD.bancoBs}`;
      const [propia] = await tx<{ ledger_account_id: string }[]>`
        select ledger_account_id from public.company_accounts where id = ${ORD.bancoUsd}`;
      await tx`update public.company_accounts set ledger_account_id = ${otra!.ledger_account_id}
                where id = ${ORD.bancoUsd}`;
      const rotas = await tx<{ account_id: string; ledger_original: string }[]>`
        select account_id, ledger_original::text as ledger_original
          from platform.treasury_currency_gaps(${ORD.company})`;
      expect(rotas.find((r) => r.account_id === ORD.bancoUsd)?.ledger_original).toBe("0");
      await tx`update public.company_accounts set ledger_account_id = ${propia!.ledger_account_id}
                where id = ${ORD.bancoUsd}`;
    });
    expect((await invariantes(ORD)).divisa).toEqual([]);
  });

  it("F-04 · con la tasa en 42, las cuatro pantallas dicen 4.200,00 y el estado de cuenta dice 100 USD", async () => {
    await tasa("42.00000000");
    // Se deben 100 USD (116 − 16). A la tasa de hoy: 4.200,00 Bs. Ni 4.000 (tasa de emisión) ni
    // 4.640 − 640 = 4.000 (saldo contable): UNA cifra, la de la única función.
    const lista = (await (
      await pedir(ORD, "GET", "/v1/customers?with_debt=1&per_page=50")
    ).json()) as { items: { id: string; debt: string }[] };
    const estado = (await (
      await pedir(ORD, "GET", `/v1/customers/${ORD.cliente}/statement`)
    ).json()) as {
      total_outstanding: string;
      documents: { id: string; balance: string; debt_currency: string; debt_nominal: string }[];
      aging: { total: string };
      debt: {
        functional_currency: string;
        as_of: string;
        by_currency: {
          currency: string;
          nominal: string;
          rate: string | null;
          functional_today: string;
        }[];
      };
    };
    const antiguedad = (await (
      await pedir(ORD, "GET", `/v1/customers/${ORD.cliente}/aging`)
    ).json()) as { total: string };
    const resumen = (await (await pedir(ORD, "GET", "/v1/negocio/resumen")).json()) as {
      lo_que_me_deben: { amount: string } | string;
    };
    const meDeben =
      typeof resumen.lo_que_me_deben === "string"
        ? resumen.lo_que_me_deben
        : resumen.lo_que_me_deben.amount;

    expect({
      lista: lista.items.find((c) => c.id === ORD.cliente)?.debt,
      ficha: estado.total_outstanding,
      documento: estado.documents.find((d) => d.id === A)?.balance,
      antiguedadDelEstado: estado.aging.total,
      antiguedad: antiguedad.total,
      dinero: meDeben,
    }).toEqual({
      lista: "4200.00",
      ficha: "4200.00",
      documento: "4200.00",
      antiguedadDelEstado: "4200.00",
      antiguedad: "4200.00",
      dinero: "4200.00",
    });
    // El aviso al cliente sale de aquí: USD nominal, Bs a la tasa de hoy, la tasa y la fecha.
    expect(estado.debt).toEqual({
      functional_currency: "VES",
      as_of: HOY,
      by_currency: [
        { currency: "USD", nominal: "100.00", rate: "42.00000000", functional_today: "4200.00" },
      ],
      // Aditivo (última ronda): ningún documento se queda sin valorar.
      unvalued_documents: 0,
    });
    expect(estado.documents.find((d) => d.id === A)).toMatchObject({
      debt_currency: "USD",
      debt_nominal: "100.00",
    });
  });

  it("P-05 · la lista de clientes se ORDENA por deuda en el servidor: quien debe 4.200,00 va antes que «AAA», que no debe nada — y al revés", async () => {
    // Un segundo cliente SIN deuda cuyo nombre va el primero por orden alfabético: si el orden
    // por deuda cayera en silencio al orden por nombre, encabezaría la lista.
    // Sembrado a mano, como el cliente del montaje: el dueño de este fichero no da altas.
    const sinDeuda = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`insert into public.customers
                 (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                  taxpayer_type_code, fiscal_address)
               values (${sinDeuda}, ${ORD.tenant}, ${ORD.company},
                       ${`J${String(Date.now() + 13).slice(-9)}`}, 'AAA sin deuda e2e',
                       'juridica', 'ordinario', 'Av. E2E, edificio Orden, Caracas')`;
    });
    type Fila = { id: string; debt: string | null };
    const lista = async (q: string): Promise<Fila[]> => {
      const r = await pedir(ORD, "GET", `/v1/customers?per_page=50&exclude_system=1&${q}`);
      expect(r.status, await r.clone().text()).toBe(200);
      return ((await r.json()) as { items: Fila[] }).items;
    };
    // Por nombre (lo de siempre), «AAA» encabeza.
    expect((await lista("with_debt=1"))[0]!.id).toBe(sinDeuda);
    const desc = await lista("with_debt=1&sort=debt_desc");
    expect(desc[0]).toMatchObject({ id: ORD.cliente, debt: "4200.00" });
    expect(desc[desc.length - 1]).toMatchObject({ id: sinDeuda, debt: "0.00" });
    const asc = await lista("with_debt=1&sort=debt_asc");
    expect(asc[0]).toMatchObject({ id: sinDeuda, debt: "0.00" });
    expect(asc[asc.length - 1]).toMatchObject({ id: ORD.cliente, debt: "4200.00" });
  });

  it("F-04 · un documento pagado debe CERO, aunque la tasa cambie después", async () => {
    const b = await facturar(ORD); // 116 USD a 42 = 4.872,00 Bs
    const c = await cobrar(ORD, b, {
      currency: "USD",
      amount: "116.00000000",
      instrument: "zelle",
      account_id: ORD.bancoUsd,
    });
    expect(c.document_status).toBe("paid");
    await tasa("43.00000000");
    const [d] = await sql<Record<string, string | null>[]>`
      select nominal::text as nominal, functional_today::text as hoy
        from platform.document_debt(${ORD.company}, ${b})`;
    expect(d).toEqual({ nominal: "0.00", hoy: "0.00" });
    await tasa("42.00000000");
    // Se reversa para que no estorbe a los cálculos de abajo (y es la prueba de paid → issued).
    const r = await reversar(ORD, c.payment.id, "Cobro cargado a la factura equivocada");
    expect(r.status, await r.clone().text()).toBe(201);
    const rev = (await r.json()) as Reversa;
    expect(rev.document).toEqual({ id: b, status: "issued" });
    expect(rev.debt).toMatchObject({
      currency: "USD",
      nominal: "116.00",
      functional_today: "4872.00",
    });
    expect(await invariantes(ORD)).toEqual(CEROS);
  });

  it("R-61 · reversar el abono de 16 USD: la factura vuelve a deber 116, la caja baja y el asiento se revierte EN DÓLARES", async () => {
    const sinPermiso = await reversar(ORD, ABONO, "El cajero no puede reversar un cobro", CAJERO);
    expect(sinPermiso.status).toBe(403);
    const cuerpo403 = (await sinPermiso.json()) as { message: string; person_message: string };
    expect(cuerpo403.message).toContain("ar.payment.reverse");
    expect(cuerpo403.person_message).toBe(
      "Necesitas el permiso para reversar un cobro. Pídeselo a quien administra el negocio.",
    );
    const sinMotivo = await reversar(ORD, ABONO, "corto");
    expect(sinMotivo.status).toBe(422);

    const antes = await saldoCuenta(ORD.bancoUsd);
    const r = await reversar(ORD, ABONO, "El Zelle nunca llegó al banco");
    expect(r.status, await r.clone().text()).toBe(201);
    const rev = (await r.json()) as Reversa;
    expect(rev.kind).toBe("payment");
    expect(rev.document.status).toBe("issued");
    expect(rev.debt).toMatchObject({
      currency: "USD",
      nominal: "116.00",
      rate: "42.00000000",
      functional_today: "4872.00",
    });
    expect(rev.igtf).toBeNull();
    // La caja: salen los 16 USD.
    expect(Number(antes) - Number(await saldoCuenta(ORD.bancoUsd))).toBe(16);

    // El asiento del cobro quedó `reversed` y su contra-asiento saca 16 USD a la tasa del cobro.
    const [orig] = await sql<{ status: string }[]>`
      select status from public.journal_entries
       where company_id = ${ORD.company} and source_kind = 'payment_received'
         and source_id = ${ABONO}`;
    expect(orig!.status).toBe("reversed");
    const [contra] = await sql<Record<string, string>[]>`
      select l.transaction_currency as moneda, l.credit_amount::text as haber,
             l.fx_rate::text as tasa, l.functional_credit::text as haber_funcional
        from public.journal_lines l
        join public.company_accounts ca on ca.ledger_account_id = l.account_id
       where l.entry_id = ${rev.reversal_entry_id} and ca.id = ${ORD.bancoUsd}`;
    expect(contra).toEqual({
      moneda: "USD",
      haber: "16.00000000",
      tasa: "40.00000000",
      haber_funcional: "640.00000000",
    });
    // El acta, con el motivo.
    const [acta] = await sql<{ motivo: string; antes: string; despues: string }[]>`
      select payload->>'reason' as motivo, payload->>'document_status_before' as antes,
             payload->>'document_status_after' as despues
        from public.audit_events
       where company_id = ${ORD.company} and event_type = 'ar.payment_reversed'
         and aggregate_id = ${ABONO}`;
    expect(acta).toEqual({
      motivo: "El Zelle nunca llegó al banco",
      antes: "issued",
      despues: "issued",
    });
    expect(await invariantes(ORD)).toEqual(CEROS);

    // Una sola vez: el mensaje es el del caso de uso, no el del único del esquema.
    const otra = await reversar(ORD, ABONO, "Se intenta reversar por segunda vez");
    expect(otra.status).toBe(409);
    expect((await otra.json()) as { code: string; message: string }).toMatchObject({
      code: "PAYMENT_ALREADY_REVERSED",
      message: "Este cobro ya fue reversado. Un cobro se reversa una sola vez.",
    });
  });

  it("H4 · el cobro reversado no cuenta en las lecturas: detalle, lista y estado de cuenta", async () => {
    const det = (await (await pedir(ORD, "GET", `/v1/documents/${A}`)).json()) as {
      payments: {
        id: string;
        reversal: { reason: string; reversed_by: string; reversed_at: string } | null;
      }[];
    };
    const abono = det.payments.find((p) => p.id === ABONO);
    // El cobro sigue en la lista (es un hecho), y dice que está reversado, por quién y por qué.
    expect(abono?.reversal).toMatchObject({
      reason: "El Zelle nunca llegó al banco",
      reversed_by: DUENO,
    });
    expect(abono?.reversal?.reversed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const lista = (await (
      await pedir(ORD, "GET", `/v1/documents?customer_id=${ORD.cliente}&per_page=50`)
    ).json()) as { items: { id: string; has_payments: boolean }[] };
    expect(lista.items.find((d) => d.id === A)?.has_payments).toBe(false);
    const estado = (await (
      await pedir(ORD, "GET", `/v1/customers/${ORD.cliente}/statement`)
    ).json()) as { documents: { id: string; paid_amount: string }[] };
    expect(estado.documents.find((d) => d.id === A)?.paid_amount).toBe("0.00");
  });

  it("R-61 · la clave natural: una segunda fila de reversa del mismo cobro muere en el esquema", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
        await tx`insert into public.payment_reversals
                   (tenant_id, company_id, payment_id, document_id, reason, currency, amount,
                    functional_amount)
                 values (${ORD.tenant}, ${ORD.company}, ${ABONO}, ${A},
                         'reejecución directa del cuerpo', 'USD', 1, 1)`;
      }),
    ).rejects.toMatchObject({ code: "23505", constraint_name: "payment_reversals_payment_key" });
  });
});

describe("moneda B · la retención soportada se reversa y se corrige (ar.retention.correct)", () => {
  // 14 dígitos con el prefijo del período (AAAAMM), como exige la carga.
  const NUMERO = `${HOY.replace(/-/g, "").slice(0, 6)}${String(Date.now()).slice(-8)}`;
  let C = "";
  let COMPROBANTE = "";

  const cargar = (base: string, rate: string, amount: string, quien: string = DUENO) =>
    pedir(
      ORD,
      "POST",
      "/v1/fiscal-declarations/supported-retentions",
      {
        company_id: ORD.company,
        customer_id: ORD.cliente,
        document_id: C,
        receipt_number: NUMERO,
        retained_on: HOY,
        base,
        rate,
        amount,
      },
      quien,
    );

  it("el comprobante abona la factura; reversarlo la devuelve a su deuda y lo deja anulado con su motivo", async () => {
    C = await facturar(ORD); // a 42: base 4.200,00 · IVA 672,00 · total 4.872,00
    const r = await cargar("672.00", "0.75", "504.00", CAJERO);
    expect(r.status, await r.clone().text()).toBe(201);
    COMPROBANTE = ((await r.json()) as { retention: { id: string } }).retention.id;
    const [abonada] = await sql<{ nominal: string }[]>`
      select nominal::text as nominal from platform.document_debt(${ORD.company}, ${C})`;
    // 504 Bs a la tasa de la factura (42) son 12 USD: quedan 104.
    expect(abonada!.nominal).toBe("104.00");

    // El cajero la cargó, pero no la corrige.
    const cajero = await pedir(
      ORD,
      "POST",
      `/v1/supported-retentions/${COMPROBANTE}/reversal`,
      { company_id: ORD.company, reason: "El cajero intenta corregir el comprobante" },
      CAJERO,
    );
    expect(cajero.status).toBe(403);
    const cuerpo403 = (await cajero.json()) as { message: string; person_message: string };
    expect(cuerpo403.message).toContain("ar.retention.correct");
    expect(cuerpo403.person_message).toBe(
      "Necesitas el permiso para corregir una retención que le practicaron al negocio. Pídeselo a quien administra el negocio.",
    );

    const rev = await pedir(ORD, "POST", `/v1/supported-retentions/${COMPROBANTE}/reversal`, {
      company_id: ORD.company,
      reason: "El agente retuvo el 100 % y se cargó el 75 %",
    });
    expect(rev.status, await rev.clone().text()).toBe(201);
    const cuerpo = (await rev.json()) as Reversa;
    expect(cuerpo.kind).toBe("supported_retention");
    expect(cuerpo.supported_retention).toEqual({ id: COMPROBANTE, status: "annulled" });
    expect(cuerpo.debt).toMatchObject({ currency: "USD", nominal: "116.00" });
    const [srr] = await sql<{ status: string; annul_reason: string }[]>`
      select status, annul_reason from public.supported_retention_receipts
       where id = ${COMPROBANTE}`;
    expect(srr).toEqual({
      status: "annulled",
      annul_reason: "El agente retuvo el 100 % y se cargó el 75 %",
    });
    expect(await invariantes(ORD)).toEqual(CEROS);
  });

  it("el abono de un comprobante no se reversa como un cobro cualquiera", async () => {
    const otra = await facturar(ORD);
    const numero = `${NUMERO.slice(0, 6)}${String(Date.now() + 1).slice(-8)}`;
    const r = await pedir(ORD, "POST", "/v1/fiscal-declarations/supported-retentions", {
      company_id: ORD.company,
      customer_id: ORD.cliente,
      document_id: otra,
      receipt_number: numero,
      retained_on: HOY,
      base: "672.00",
      rate: "0.75",
      amount: "504.00",
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const [pago] = await sql<{ id: string }[]>`
      select id from public.payments where document_id = ${otra}`;
    const mal = await reversar(ORD, pago!.id, "Se intenta por la vía de los cobros");
    expect(mal.status).toBe(422);
    expect(((await mal.json()) as { message: string }).message).toContain(
      "comprobante de retención de IVA",
    );
    // Se deja reversado por su vía, para que no cuente en la revaluación de abajo.
    const [srr] = await sql<{ id: string }[]>`
      select id from public.supported_retention_receipts where document_id = ${otra}`;
    const bien = await pedir(ORD, "POST", `/v1/supported-retentions/${srr!.id}/reversal`, {
      company_id: ORD.company,
      reason: "Comprobante cargado a la factura equivocada",
    });
    expect(bien.status, await bien.clone().text()).toBe(201);
  });

  it("corregir es reversar y volver a cargar: el mismo número entra con el importe correcto", async () => {
    const r = await cargar("672.00", "1.00", "672.00");
    expect(r.status, await r.clone().text()).toBe(201);
    const [d] = await sql<{ nominal: string }[]>`
      select nominal::text as nominal from platform.document_debt(${ORD.company}, ${C})`;
    // 672 Bs a 42 son 16 USD: quedan 100.
    expect(d!.nominal).toBe("100.00");
    const filas = await sql<{ status: string }[]>`
      select status from public.supported_retention_receipts
       where company_id = ${ORD.company} and receipt_number = ${NUMERO} order by created_at`;
    expect(filas.map((f) => f.status)).toEqual(["annulled", "registered"]);
  });

  it("H9 · un comprobante que ya entró en una declaración presentada NO se anula: 409 con su código y su mensaje", async () => {
    // Un comprobante con fecha de AYER, y la declaración de IVA de ayer generada HOY (después de
    // cerrar su período: B-1). Anularlo cambiaría un período presentado. Va en la empresa especial
    // para no mover la cartera de la ordinaria, que la revaluación de abajo asevera.
    const otra = await facturar(SPE);
    const numero = `${AYER.replace(/-/g, "").slice(0, 6)}${String(Date.now() + 5).slice(-8)}`;
    const r = await pedir(SPE, "POST", "/v1/fiscal-declarations/supported-retentions", {
      company_id: SPE.company,
      customer_id: SPE.cliente,
      document_id: otra,
      receipt_number: numero,
      retained_on: AYER,
      base: "672.00",
      rate: "0.75",
      amount: "504.00",
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const id = ((await r.json()) as { retention: { id: string } }).retention.id;
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`insert into public.iva_period_results
                 (tenant_id, company_id, period_from, period_to, debitos, creditos,
                  creditos_deducibles, retenciones_soportadas, excedente_anterior, cuota_a_pagar,
                  excedente_siguiente, detalle, generator_version, dataset_hash)
               values (${SPE.tenant}, ${SPE.company}, ${AYER}::date, ${AYER}::date, 0, 0, 0, 504, 0,
                       0, 504, '{}'::jsonb, 'e2e-moneda-b', ${"0".repeat(64)})`;
    });
    const rev = await pedir(SPE, "POST", `/v1/supported-retentions/${id}/reversal`, {
      company_id: SPE.company,
      reason: "Se intenta anular un comprobante ya declarado",
    });
    expect(rev.status, await rev.clone().text()).toBe(409);
    expect((await rev.json()) as { code: string; message: string }).toMatchObject({
      code: "RETENTION_PERIOD_DECLARED",
      message:
        "Este comprobante ya entró en una declaración presentada. Corregirlo exige una declaración sustitutiva o un ajuste: habla con tu contador.",
    });
    // Nada cambió: el comprobante sigue vigente y su abono, vivo.
    const [srr] = await sql<{ status: string; reversas: number }[]>`
      select r.status,
             (select count(*)::int from public.payment_reversals pr
               where pr.supported_retention_id = r.id) as reversas
        from public.supported_retention_receipts r where r.id = ${id}`;
    expect(srr).toEqual({ status: "registered", reversas: 0 });
  });

  it("R-61 · un comprobante viejo con otro formato de número también se anula (el CHECK NOT VALID no lo impide)", async () => {
    // Un comprobante anterior a la regla de los 14 dígitos: se siembra con el CHECK suelto, como
    // quedaron los de producción (NOT VALID), y se anula. Antes: 23514.
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      const [viejo] = await tx<{ id: string }[]>`
        select id from public.supported_retention_receipts
         where company_id = ${ORD.company} and status = 'annulled'
           and receipt_number <> ${NUMERO} limit 1`;
      await tx`alter table public.supported_retention_receipts
                 disable trigger user`;
      await tx`update public.supported_retention_receipts
                  set status = 'registered', annul_reason = null where id = ${viejo!.id}`;
      await tx`alter table public.supported_retention_receipts
                 drop constraint srr_receipt_14_digits_chk,
                 drop constraint srr_receipt_period_prefix_chk`;
      await tx`update public.supported_retention_receipts
                  set receipt_number = 'AG-0001' where id = ${viejo!.id}`;
      await tx`alter table public.supported_retention_receipts
                 add constraint srr_receipt_14_digits_chk
                   check (status = 'annulled' or receipt_number ~ '^[0-9]{14}$') not valid,
                 add constraint srr_receipt_period_prefix_chk
                   check (status = 'annulled'
                          or receipt_number ~ '^(19|20)[0-9]{2}(0[1-9]|1[0-2])[0-9]{8}$') not valid`;
      await tx`alter table public.supported_retention_receipts enable trigger user`;
      // Anularlo vive.
      await tx`update public.supported_retention_receipts
                  set status = 'annulled', annul_reason = 'comprobante viejo mal cargado'
                where id = ${viejo!.id}`;
      // Y sigue sin poder VOLVER a vigente con ese número: el CHECK juzga lo vigente.
      await expect(
        tx.savepoint(
          (sp) => sp`update public.supported_retention_receipts
                        set status = 'registered', annul_reason = null where id = ${viejo!.id}`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });
});

describe("moneda B · el IGTF de un cobro reversado se restituye (P-67)", () => {
  it("la venta de caja por Zelle percibe 3,48 USD; reversar su cobro los restituye y deja la percepción pendiente de reintegro", async () => {
    // 116 USD + 3 % de IGTF = 119,48 USD por Zelle.
    const v = await pedir(SPE, "POST", "/v1/pos/sales", {
      company_id: SPE.company,
      customer_id: SPE.cliente,
      warehouse_id: SPE.w,
      lines: [{ product_id: SPE.producto, quantity: "1" }],
      payments: [
        { instrument: "zelle", currency: "USD", amount: "119.48", account_id: SPE.bancoUsd },
      ],
    });
    expect(v.status, await v.clone().text()).toBe(201);
    const venta = (await v.json()) as {
      document: { id: string; status: string };
      payments: { payment: { id: string }; igtf: { id: string; amount: string } | null }[];
    };
    expect(venta.document.status).toBe("paid");
    expect(venta.payments[0]!.igtf!.amount).toBe("3.48000000");
    expect(await saldoCuenta(SPE.bancoUsd)).toBe("119.48000000");
    expect(await invariantes(SPE)).toEqual(CEROS);

    const r = await reversar(
      SPE,
      venta.payments[0]!.payment.id,
      "El cliente pagó dos veces y se le devuelve este Zelle",
    );
    expect(r.status, await r.clone().text()).toBe(201);
    const rev = (await r.json()) as Reversa;
    expect(rev.document).toEqual({ id: venta.document.id, status: "issued" });
    expect(rev.igtf).toMatchObject({
      status: "pendiente_reintegro",
      currency: "USD",
      restituted_amount: "3.48000000",
    });
    // Salen de la caja el cobro Y el IGTF: se le restituye al cliente.
    expect(await saldoCuenta(SPE.bancoUsd)).toBe("0.00000000");
    const [ip] = await sql<{ status: string; status_reason: string }[]>`
      select status, status_reason from public.igtf_perceptions
       where id = ${venta.payments[0]!.igtf!.id}`;
    expect(ip).toEqual({
      status: "pendiente_reintegro",
      status_reason: "Reversa del cobro: El cliente pagó dos veces y se le devuelve este Zelle",
    });
    // El asiento de la percepción quedó revertido, y hay acta del reintegro pendiente.
    const [e] = await sql<{ status: string }[]>`
      select status from public.journal_entries
       where company_id = ${SPE.company} and source_kind = 'igtf_perception'
         and source_id = ${venta.payments[0]!.igtf!.id}`;
    expect(e!.status).toBe("reversed");
    const actas = await sql<{ event_type: string }[]>`
      select event_type from public.audit_events
       where company_id = ${SPE.company} and aggregate_id = ${venta.payments[0]!.payment.id}
         and event_type in ('ar.payment_reversed', 'igtf.perception_pending_refund')
       order by event_type`;
    expect(actas.map((a) => a.event_type)).toEqual([
      "ar.payment_reversed",
      "igtf.perception_pending_refund",
    ]);
    // AF-M11: reversada DENTRO de su período (hoy), la percepción no cuenta en el total de ese
    // período ni como pendiente de reintegro de un período ya declarado; se sigue listando. El
    // otro caso —reversada DESPUÉS del fin del período: sigue contando— está en pgTAP 110 §21.
    const lista = (await (
      await pedir(SPE, "GET", `/v1/igtf/perceptions?from=${HOY}&to=${HOY}`)
    ).json()) as {
      items: { id: string; status: string }[];
      total_functional: string;
      pending_refund_functional: string;
      pending_refund_count: number;
    };
    expect(lista.items.find((i) => i.id === venta.payments[0]!.igtf!.id)?.status).toBe(
      "pendiente_reintegro",
    );
    expect(Number(lista.total_functional)).toBe(0);
    expect(Number(lista.pending_refund_functional)).toBe(0);
    expect(lista.pending_refund_count).toBe(0);
    expect(await invariantes(SPE)).toEqual(CEROS);
  });

  it("si el IGTF se documentó con una nota de débito, la reversa PARA y dice por qué", async () => {
    const f = await facturar(SPE);
    const c = await cobrar(SPE, f, {
      currency: "USD",
      amount: "10.30000000",
      instrument: "zelle",
      account_id: SPE.bancoUsd,
      igtf_included: true,
    });
    expect(c.igtf_debit_note ?? null).not.toBeNull();
    const antes = await saldoCuenta(SPE.bancoUsd);
    const r = await reversar(SPE, c.payment.id, "Se intenta reversar un cobro con nota de débito");
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("IGTF_NOTE_ISSUED");
    expect(cuerpo.message).toContain("nota de débito");
    // Nada cambió: ni la caja, ni la percepción.
    expect(await saldoCuenta(SPE.bancoUsd)).toBe(antes);
    const [ip] = await sql<{ status: string }[]>`
      select status from public.igtf_perceptions where payment_id = ${c.payment.id}`;
    expect(ip!.status).toBe("percibido");
  });
});

describe("moneda B · la revaluación al cierre (VEN-NIF PYME secc. 30)", () => {
  it("al cerrar el mes a 45, la caja y las cuentas por cobrar en USD se llevan a la tasa de cierre", async () => {
    // La empresa ordinaria tiene, hasta aquí, tres facturas en USD sin cobros vivos salvo la
    // retención corregida: A (a 40) debe 116; B (a 42) debe 116; C (a 42) debe 100; y una
    // cuarta (a 42) que debe 116. La caja en USD quedó en 0: se le abonan 10 USD a A, a 42.
    const [a] = await sql<{ id: string }[]>`
      select id from public.documents
       where company_id = ${ORD.company} and kind = 'invoice' order by issued_at, id limit 1`;
    await cobrar(ORD, a!.id, {
      currency: "USD",
      amount: "10.00000000",
      instrument: "zelle",
      account_id: ORD.bancoUsd,
    });
    await tasa("45.00000000");

    const [periodo] = await sql<{ id: string; fin: string }[]>`
      select id, (make_date(year, month, 1) + interval '1 month - 1 day')::date::text as fin
        from public.fiscal_periods
       where company_id = ${ORD.company} and kind = 'regular'
         and year = ${Number(HOY.slice(0, 4))} and month = ${Number(HOY.slice(5, 7))}`;
    // H7: el período todavía no terminó. La revaluación se fecha HOY (el menor entre el fin del
    // período y hoy, día de Caracas) y usa la tasa de hoy; al día 31 no hay tasa que valga.
    expect(periodo!.fin >= HOY).toBe(true);
    const partidas = await sql<Record<string, string>[]>`
      select item_kind, currency, original_balance::text as original, rate::text as tasa,
             carried::text as lleva, target::text as debe_llevar, adjustment::text as ajuste
        from platform.fx_revaluation_items(${ORD.company}, ${HOY}::date)
       order by item_kind`;
    // Caja: 10 USD que el mayor lleva a 420,00 → 450,00.
    // CxC: A 106 USD a 40 (4.240) + B 116 a 42 (4.872) + C 100 a 42 (4.200) + D 116 a 42 (4.872)
    //      = 438 USD que el mayor lleva a 18.184,00 → 438 × 45 = 19.710,00.
    expect(partidas).toEqual([
      {
        item_kind: "receivable",
        currency: "USD",
        original: "438.00000000",
        tasa: "45.00000000",
        lleva: "18184.00",
        debe_llevar: "19710.00",
        ajuste: "1526.00",
      },
      {
        item_kind: "treasury",
        currency: "USD",
        original: "10.00000000",
        tasa: "45.00000000",
        lleva: "420.00000000",
        debe_llevar: "450.00",
        ajuste: "30.00000000",
      },
    ]);

    const r = await pedir(ORD, "POST", `/v1/fiscal-periods/${periodo!.id}/close`, {
      company_id: ORD.company,
    });
    expect(r.status, await r.clone().text()).toBe(200);

    const lineas = await sql<Record<string, string | null>[]>`
      select (select min(s.purpose) from public.company_account_settings s
               where s.company_id = l.company_id and s.account_id = l.account_id
                 and s.purpose in ('ar_general', 'exchange_gain', 'exchange_loss')) as papel,
             l.transaction_currency as moneda, l.functional_debit::text as debe,
             l.functional_credit::text as haber
        from public.journal_entries e
        join public.journal_lines l on l.entry_id = e.id
       where e.company_id = ${ORD.company} and e.source_kind = 'exchange_diff'
         and e.source_event = 'fx.revaluation_at_close' and e.status = 'posted'
         and e.posting_date = ${HOY}::date
       order by l.line_number`;
    expect(lineas).toEqual([
      // La subcuenta de la caja en USD no tiene papel: sube 30,00 EN BOLÍVARES (sus dólares no cambian).
      { papel: null, moneda: "VES", debe: "30.00000000", haber: "0.00000000" },
      { papel: "exchange_gain", moneda: "VES", debe: "0.00000000", haber: "30.00000000" },
      { papel: "ar_general", moneda: "VES", debe: "1526.00000000", haber: "0.00000000" },
      { papel: "exchange_gain", moneda: "VES", debe: "0.00000000", haber: "1526.00000000" },
    ]);
    // La revaluación no toca los dólares de la caja: el invariante sigue en cero.
    expect((await invariantes(ORD)).divisa).toEqual([]);
    expect((await invariantes(ORD)).tesoreria).toEqual([]);
    // Y no guarda estado: preguntada otra vez, ya no hay NADA que ajustar — cero filas, no una
    // ganancia y una pérdida que se anulan (H2).
    const resto = await sql`
      select * from platform.fx_revaluation_items(${ORD.company}, ${HOY}::date)`;
    expect(resto).toEqual([]);
  });

  const revaluaciones = () =>
    sql<{ id: string; lineas: number }[]>`
      select e.id, (select count(*)::int from public.journal_lines l where l.entry_id = e.id) as lineas
        from public.journal_entries e
       where e.company_id = ${ORD.company} and e.source_kind = 'exchange_diff'
         and e.source_event = 'fx.revaluation_at_close'
       order by e.entry_number`;
  const periodoDeHoy = async () => {
    const [p] = await sql<{ id: string }[]>`
      select id from public.fiscal_periods
       where company_id = ${ORD.company} and kind = 'regular'
         and year = ${Number(HOY.slice(0, 4))} and month = ${Number(HOY.slice(5, 7))}`;
    return p!.id;
  };
  const reabrir = async () => {
    const r = await pedir(ORD, "POST", `/v1/fiscal-periods/${await periodoDeHoy()}/reopen`, {
      company_id: ORD.company,
      reason: "Se reabre para probar la revaluación neta",
    });
    expect(r.status, await r.clone().text()).toBe(200);
  };
  const cerrar = async () =>
    pedir(ORD, "POST", `/v1/fiscal-periods/${await periodoDeHoy()}/close`, {
      company_id: ORD.company,
    });

  it("H13 · con el período de hoy CERRADO la reversa se rechaza con PERIOD_CLOSED (409), no con un 422 genérico", async () => {
    // El contra-asiento va con fecha de hoy, en el período en curso (ADR-0069: un período cerrado
    // no recibe asientos). Con ese período cerrado, la reversa PARA y nada cambia.
    const [vivo] = await sql<{ id: string }[]>`
      select p.id from public.payments p
       where p.company_id = ${ORD.company} and p.account_id = ${ORD.bancoUsd}
         and not exists (select 1 from public.payment_reversals r where r.payment_id = p.id)`;
    const antes = await saldoCuenta(ORD.bancoUsd);
    const r = await reversar(ORD, vivo!.id, "Se intenta reversar con el mes cerrado");
    expect(r.status, await r.clone().text()).toBe(409);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("PERIOD_CLOSED");
    expect(cuerpo.message).toContain("El período contable de hoy está cerrado");
    expect(await saldoCuenta(ORD.bancoUsd)).toBe(antes);
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.payment_reversals where payment_id = ${vivo!.id}`;
    expect(n!.n).toBe(0);
  });

  it("H2 · reabrir y volver a cerrar a la MISMA tasa no crea asiento", async () => {
    expect(await revaluaciones()).toHaveLength(1);
    await reabrir();
    const r = await cerrar();
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await revaluaciones()).toHaveLength(1);
  });

  it("H2 · un segundo cierre con la cartera abierta y OTRA tasa asienta solo la diferencia neta, una línea por cuenta", async () => {
    await reabrir();
    await tasa("46.00000000");
    const r = await cerrar();
    expect(r.status, await r.clone().text()).toBe(200);
    const todas = await revaluaciones();
    expect(todas.map((e) => e.lineas)).toEqual([4, 4]);
    const lineas = await sql<Record<string, string | null>[]>`
      select (select min(s.purpose) from public.company_account_settings s
               where s.company_id = l.company_id and s.account_id = l.account_id
                 and s.purpose in ('ar_general', 'exchange_gain', 'exchange_loss')) as papel,
             l.functional_debit::text as debe, l.functional_credit::text as haber
        from public.journal_lines l where l.entry_id = ${todas[1]!.id} order by l.line_number`;
    // Caja: 10 USD de 450,00 a 460,00. Cartera: 438 USD de 19.710,00 a 20.148,00. Solo ganancia:
    // ninguna línea de pérdida que deshaga «lo ya revaluado».
    expect(lineas).toEqual([
      { papel: null, debe: "10.00000000", haber: "0.00000000" },
      { papel: "exchange_gain", debe: "0.00000000", haber: "10.00000000" },
      { papel: "ar_general", debe: "438.00000000", haber: "0.00000000" },
      { papel: "exchange_gain", debe: "0.00000000", haber: "438.00000000" },
    ]);
    expect(
      await sql`select * from platform.fx_revaluation_items(${ORD.company}, ${HOY}::date)`,
    ).toEqual([]);
  });

  it("H7 · sin una tasa oficial dentro del margen, el cierre se DETIENE y pide la tasa del día", async () => {
    await reabrir();
    // El margen es un parámetro de plataforma (dato). Con −1 ninguna tasa de hoy ni anterior
    // «está dentro»: es la forma de dejar la tasa rancia sin tocar la tabla global de tasas.
    // La cartera en divisa exige tasa de cierre aunque no haya diferencia que asentar.
    await sql`update platform.parameters set value = -1 where key = 'closing_rate_max_age_days'`;
    let r: Response;
    try {
      r = await cerrar();
    } finally {
      await sql`update platform.parameters set value = 7 where key = 'closing_rate_max_age_days'`;
    }
    expect(r.status).toBe(422);
    const [d, m, a] = [HOY.slice(8, 10), HOY.slice(5, 7), HOY.slice(0, 4)];
    expect(((await r.json()) as { message: string }).message).toBe(
      `Falta la tasa BCV del cierre (${d}/${m}/${a}). Cárgala y vuelve a cerrar.`,
    );
    const [p] = await sql<{ status: string }[]>`
      select status from public.fiscal_periods where id = ${await periodoDeHoy()}`;
    // Sigue reabierto: el cierre no ocurrió.
    expect(p!.status).toBe("reopened");
    // Con el margen de vuelta, cierra (y a la misma tasa no asienta nada).
    const bien = await cerrar();
    expect(bien.status, await bien.clone().text()).toBe(200);
    expect(await revaluaciones()).toHaveLength(2);
  });

  it("H7 · el OTRO motivo de LAD51: un cobro viejo en otra moneda sin la tasa de SU día — el mensaje dice de qué día, no «la del cierre»", async () => {
    // Dos caminos dan el mismo 422 (CLAUDE.md §3: asevera el mensaje): falta la tasa de CIERRE
    // (arriba) o falta la tasa del día de un cobro viejo. Aquí, el segundo: un cobro en Bs a una
    // factura en USD, anterior a 20261003170000 (sin lo saldado congelado ni diferencial), de un
    // día para el que no hay tasa.
    await reabrir();
    const [doc] = await sql<{ id: string }[]>`
      select d.id from public.documents d
       where d.company_id = ${ORD.company} and d.transaction_currency = 'USD'
         and d.status = 'issued' and d.kind = 'invoice'
       order by d.created_at limit 1`;
    expect(doc).toBeDefined();
    const [viejo] = await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      return tx<{ id: string }[]>`
        insert into public.payments
          (tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
           rate_timestamp, functional_amount, instrument, account_id, settled_transaction_amount)
        values (${ORD.tenant}, ${ORD.company}, ${doc!.id}, '2001-01-05T16:00:00Z', 'VES', 0.01, 1,
                'identidad', now(), 0.01, 'transferencia', ${ORD.bancoBs}, null)
        returning id`;
    });
    let r: Response;
    try {
      r = await cerrar();
    } finally {
      // El cobro de prueba se retira como se retira un cobro: con su reversa.
      await sql.begin(async (tx) => {
        await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
        await tx`
          insert into public.payment_reversals
            (tenant_id, company_id, payment_id, document_id, reason, currency, amount,
             functional_amount)
          values (${ORD.tenant}, ${ORD.company}, ${viejo!.id}, ${doc!.id},
                  'E2E: cobro viejo sin tasa, retirado', 'VES', 0.01, 0.01)`;
      });
    }
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toBe(
      "Falta la tasa BCV del 05/01/2001: hay un cobro de ese día en otra moneda que no se puede valorar sin ella. Cárgala y vuelve a cerrar.",
    );
    const [p] = await sql<{ status: string }[]>`
      select status from public.fiscal_periods where id = ${await periodoDeHoy()}`;
    expect(p!.status).toBe("reopened");
    // Sin el cobro viejo, cierra como antes y no asienta nada nuevo.
    const bien = await cerrar();
    expect(bien.status, await bien.clone().text()).toBe(200);
    expect(await revaluaciones()).toHaveLength(2);
  });

  it("ola 4 · el resumen dice POR QUÉ no hay cifra: con deuda que no se puede valorar, `sin_tasa` y el nominal por moneda — no un null mudo", async () => {
    // El mismo cobro viejo sin tasa de su día: `customer_debt_today` no puede valorar la cartera
    // y el resumen manda `lo_que_me_deben: null`. Antes era indistinguible del null de «sin
    // ar.read» y la pantalla escondía la tarjeta: «no hay» por «no se puede calcular».
    type Resumen = {
      lo_que_me_deben: string | null;
      lo_que_me_deben_motivo: string | null;
      lo_que_me_deben_por_moneda: { currency: string; nominal: string }[];
    };
    const resumen = async (): Promise<Resumen> => {
      const r = await pedir(ORD, "GET", "/v1/negocio/resumen");
      expect(r.status, await r.clone().text()).toBe(200);
      return (await r.json()) as Resumen;
    };
    await reabrir();
    const antes = await resumen();
    expect(antes.lo_que_me_deben).toMatch(/^\d+\.\d{2}$/);
    expect(antes.lo_que_me_deben_motivo).toBeNull();
    expect(antes.lo_que_me_deben_por_moneda).toEqual([]);
    const [doc] = await sql<{ id: string }[]>`
      select d.id from public.documents d
       where d.company_id = ${ORD.company} and d.transaction_currency = 'USD'
         and d.status = 'issued' and d.kind = 'invoice'
       order by d.created_at limit 1`;
    expect(doc).toBeDefined();
    const [viejo] = await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      return tx<{ id: string }[]>`
        insert into public.payments
          (tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
           rate_timestamp, functional_amount, instrument, account_id, settled_transaction_amount)
        values (${ORD.tenant}, ${ORD.company}, ${doc!.id}, '2001-01-06T16:00:00Z', 'VES', 0.01, 1,
                'identidad', now(), 0.01, 'transferencia', ${ORD.bancoBs}, null)
        returning id`;
    });
    let sinValorar: Resumen;
    try {
      sinValorar = await resumen();
    } finally {
      await sql.begin(async (tx) => {
        await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
        await tx`
          insert into public.payment_reversals
            (tenant_id, company_id, payment_id, document_id, reason, currency, amount,
             functional_amount)
          values (${ORD.tenant}, ${ORD.company}, ${viejo!.id}, ${doc!.id},
                  'E2E ola 4: cobro viejo sin tasa, retirado', 'VES', 0.01, 0.01)`;
      });
    }
    expect(sinValorar.lo_que_me_deben).toBeNull();
    expect(sinValorar.lo_que_me_deben_motivo).toBe("sin_tasa");
    // Lo que sí se conoce: el nominal por moneda, en string decimal, nunca null.
    // Lo que SÍ se conoce, y no una lista vacía: la cartera en dólares al cierre era A 106 + B 116
    // + C 100 + D 116 = 438 USD (el test «al cerrar el mes a 45»). El cobro viejo dejó sin valorar
    // el documento A, que por eso no entra: 438 − 106 = 332,00 USD.
    expect(sinValorar.lo_que_me_deben_por_moneda).toEqual([{ currency: "USD", nominal: "332.00" }]);
    // Retirado el cobro, vuelve la cifra de antes y el motivo desaparece.
    const despues = await resumen();
    expect(despues.lo_que_me_deben).toBe(antes.lo_que_me_deben);
    expect(despues.lo_que_me_deben_motivo).toBeNull();
    const bien = await cerrar();
    expect(bien.status, await bien.clone().text()).toBe(200);
    expect(await revaluaciones()).toHaveLength(2);
  });
});

describe("moneda B · los bordes de la reversa (H4, Y13)", () => {
  let G = "";

  it("con diferencial: el cobro en Bs a otra tasa deja su fila; reversado, el diferencial se descuenta y la venta se puede anular", async () => {
    G = await facturar(SPE); // 116 USD a 46 = 5.336,00 Bs
    await tasa("47.00000000");
    // Se pagan los 116 USD en bolívares a la tasa de hoy (47): 5.452,00 Bs. Diferencial: 116,00.
    const c = await cobrar(SPE, G, {
      currency: "VES",
      amount: "5452.00000000",
      instrument: "transferencia",
      account_id: SPE.bancoBs,
    });
    expect(c.document_status).toBe("paid");
    const antes = (await (await pedir(SPE, "GET", `/v1/documents/${G}`)).json()) as {
      exchange_differences: { payment_id: string; difference: string }[];
    };
    expect(antes.exchange_differences.map((d) => d.payment_id)).toEqual([c.payment.id]);
    const informe = async () =>
      (await (
        await pedir(SPE, "GET", `/v1/reports/exchange-difference?from=${HOY}&to=${HOY}`)
      ).json()) as { neto: string };
    const netoAntes = Number((await informe()).neto);
    const dif = Number(antes.exchange_differences[0]!.difference);
    expect(dif).not.toBe(0);

    // No se anula: tiene un cobro vivo.
    const noSeAnula = await pedir(SPE, "POST", `/v1/invoices/${G}/annul`, {
      company_id: SPE.company,
      reason: "Se intenta anular con el cobro vivo",
    });
    expect(noSeAnula.status).toBe(409);
    expect(((await noSeAnula.json()) as { code: string }).code).toBe("DOCUMENT_HAS_PAYMENTS");

    const r = await reversar(SPE, c.payment.id, "La transferencia fue devuelta por el banco");
    expect(r.status, await r.clone().text()).toBe(201);
    expect(((await r.json()) as Reversa).document.status).toBe("issued");
    const despues = (await (await pedir(SPE, "GET", `/v1/documents/${G}`)).json()) as {
      exchange_differences: unknown[];
    };
    expect(despues.exchange_differences).toEqual([]);
    expect(Number((await informe()).neto)).toBeCloseTo(netoAntes - dif, 2);
    expect(await invariantes(SPE)).toEqual(CEROS);

    // Un cobro reversado no es un cobro: la venta sin dinero dentro SÍ se anula.
    const anula = await pedir(SPE, "POST", `/v1/invoices/${G}/annul`, {
      company_id: SPE.company,
      reason: "La venta no se concretó: el pago fue devuelto",
      // G-10 (PA 00071 art. 36): la persona confirma el original y las copias.
      originals_in_hand: true,
    });
    expect(anula.status, await anula.clone().text()).toBe(200);
    const [doc] = await sql<{ status: string }[]>`
      select status from public.documents where id = ${G}`;
    expect(doc!.status).toBe("annulled");
  });

  it("dos reversas simultáneas del mismo cobro: una gana y la otra recibe el 409 DEL CASO DE USO", async () => {
    const f = await facturar(SPE);
    const c = await cobrar(SPE, f, {
      currency: "VES",
      amount: "1000.00000000",
      instrument: "transferencia",
      account_id: SPE.bancoBs,
    });
    const antes = Number(await saldoCuenta(SPE.bancoBs));
    const [x, y] = await Promise.all([
      reversar(SPE, c.payment.id, "Primera de dos reversas simultáneas"),
      reversar(SPE, c.payment.id, "Segunda de dos reversas simultáneas"),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    const perdedora = x.status === 409 ? x : y;
    // El mensaje es el del caso de uso; el del único del esquema diría DUPLICATE.
    expect((await perdedora.json()) as { code: string; message: string }).toMatchObject({
      code: "PAYMENT_ALREADY_REVERSED",
      message: "Este cobro ya fue reversado. Un cobro se reversa una sola vez.",
    });
    // Y la caja bajó UNA vez.
    expect(antes - Number(await saldoCuenta(SPE.bancoBs))).toBe(1000);
    expect(await invariantes(SPE)).toEqual(CEROS);
  });

  it("con el cierre de caja de ese día ya hecho: la reversa pasa, el arqueo no se toca y la caja baja", async () => {
    // Decidido por criterio (ADR-0075 §8, nota 6): la reversa no exige saldo ni reabre el arqueo.
    // El arqueo ya hecho es un hecho append-only: dice lo que se contó entonces. La caja baja
    // después, y el arqueo SIGUIENTE verá la diferencia contra lo contado.
    // Solo se arquea una CAJA: se crea una de efectivo en bolívares y se cobra en ella.
    const nueva = await pedir(SPE, "POST", "/v1/treasury/accounts", {
      company_id: SPE.company,
      name: `Caja Bs ${RUN}`,
      currency: "VES",
      kind: "cash",
    });
    expect(nueva.status, await nueva.clone().text()).toBe(201);
    const caja = ((await nueva.json()) as { id: string }).id;
    const f = await facturar(SPE);
    const c = await cobrar(SPE, f, {
      currency: "VES",
      amount: "500.00000000",
      instrument: "efectivo_bs",
      account_id: caja,
    });
    const saldo = await saldoCuenta(caja);
    const arqueo = await pedir(SPE, "POST", "/v1/cash-closings", {
      company_id: SPE.company,
      account_id: caja,
      counted_amount: saldo,
    });
    expect(arqueo.status, await arqueo.clone().text()).toBe(201);
    const cierre = (await arqueo.json()) as { id: string; expected_amount: string };
    const r = await reversar(SPE, c.payment.id, "Cobro reversado después del arqueo del día");
    expect(r.status, await r.clone().text()).toBe(201);
    expect(Number(saldo) - Number(await saldoCuenta(caja))).toBe(500);
    const [igual] = await sql<{ expected: string }[]>`
      select round(expected_amount, 2)::text as expected from public.cash_closings
       where id = ${cierre.id}`;
    expect(Number(igual!.expected)).toBe(Number(cierre.expected_amount));
    expect(await invariantes(SPE)).toEqual(CEROS);
  });

  it("la reversa de un IGTF ABSORBIDO: la percepción queda pendiente de reintegro y de la caja sale SOLO el cobro", async () => {
    // La empresa asume el IGTF (F-05): el cliente no lo pagó y nunca entró a la caja.
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`update public.company_settings set absorb_igtf = true
                where company_id = ${SPE.company}`;
    });
    const f = await facturar(SPE);
    const antes = Number(await saldoCuenta(SPE.bancoUsd));
    const c = await cobrar(SPE, f, {
      currency: "USD",
      amount: "50.00000000",
      instrument: "zelle",
      account_id: SPE.bancoUsd,
    });
    const [ip] = await sql<{ id: string; absorbed: boolean; amount: string }[]>`
      select id, absorbed, amount::text as amount from public.igtf_perceptions
       where payment_id = ${c.payment.id}`;
    expect(ip).toMatchObject({ absorbed: true });
    expect(Number(await saldoCuenta(SPE.bancoUsd)) - antes).toBe(50);

    const r = await reversar(SPE, c.payment.id, "Cobro con IGTF absorbido cargado por error");
    expect(r.status, await r.clone().text()).toBe(201);
    const rev = (await r.json()) as Reversa & { igtf: { absorbed: boolean } };
    expect(rev.igtf).toMatchObject({
      status: "pendiente_reintegro",
      restituted_amount: "0.00000000",
      absorbed: true,
    });
    // De la caja salen los 50 USD del cobro y nada más: lo absorbido nunca entró.
    expect(Number(await saldoCuenta(SPE.bancoUsd))).toBe(antes);
    const [despues] = await sql<{ status: string }[]>`
      select status from public.igtf_perceptions where id = ${ip!.id}`;
    expect(despues!.status).toBe("pendiente_reintegro");
    const [e] = await sql<{ status: string }[]>`
      select status from public.journal_entries
       where company_id = ${SPE.company} and source_kind = 'igtf_perception'
         and source_id = ${ip!.id}`;
    expect(e?.status ?? "reversed").toBe("reversed");
    expect(await invariantes(SPE)).toEqual(CEROS);
  });
});

describe("moneda A/B · un pago a proveedor con el contexto VIEJO se asienta (R-74 §3)", () => {
  it("una fila ap.payment_made que esperaba en la cola SIN exchange_difference genera su asiento", async () => {
    // La plantilla payment_made exige `exchange_difference` desde 20261003170000. Un pago que la
    // API anterior registró (o encoló) no lo trae en su contexto: antes de este arreglo la fila no
    // podía generarse nunca («la plantilla pide el importe exchange_difference…»).
    const proveedor = crypto.randomUUID();
    const factura = crypto.randomUUID();
    const pago = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`insert into public.suppliers
                 (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code,
                  taxpayer_type_code)
               values (${proveedor}, ${SPE.tenant}, ${SPE.company},
                       ${`J${String(Date.now() + 11).slice(-9)}`}, 'Proveedor del contexto viejo',
                       'nacional', 'juridica', 'ordinario')`;
      await tx`insert into public.supplier_invoices
                 (id, tenant_id, company_id, supplier_id, supplier_document_number,
                  supplier_control_number, invoice_date, status, posted_at, subtotal_amount,
                  tax_amount, total_amount, tax_is_recoverable, transaction_currency,
                  functional_currency, fx_rate, amount_transaction_currency, functional_amount)
               values (${factura}, ${SPE.tenant}, ${SPE.company}, ${proveedor}, ${`FP-${RUN}`},
                       ${`CT-${RUN}`}, ${HOY}::date, 'posted', now(), 500, 80, 580, true, 'VES',
                       'VES', 1, 580, 580)`;
      await tx`insert into public.supplier_payments
                 (id, tenant_id, company_id, supplier_id, supplier_invoice_id, paid_at, instrument,
                  gross_amount, retained_amount, net_amount, amount_transaction_currency,
                  transaction_currency, fx_rate, functional_amount, functional_currency,
                  rate_source, rate_timestamp, account_id)
               values (${pago}, ${SPE.tenant}, ${SPE.company}, ${proveedor}, ${factura}, now(),
                       'transferencia', 580, 0, 580, 580, 'VES', 1, 580, 'VES', 'identidad', now(),
                       ${SPE.bancoBs})`;
      // La factura del montaje se siembra a mano, sin asiento: queda EN COLA, como cualquier
      // hecho pendiente de contabilizar (asiento o cola: la cobertura sigue en cero).
      await tx`insert into public.journal_generation_queue
                 (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
               values (${SPE.tenant}, ${SPE.company}, 'purchase_invoice', ${factura},
                       'ap.invoice_posted', '{}'::jsonb, 'Montaje del E2E: factura sin asiento')`;
      // El contexto tal como lo guardaba la API anterior: sin `exchange_difference`.
      await tx`insert into public.journal_generation_queue
                 (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
               values (${SPE.tenant}, ${SPE.company}, 'payment_made', ${pago}, 'ap.payment_made',
                       ${tx.json({
                         total: "580.00000000",
                         net_amount: "580.00000000",
                         retained_iva: "0",
                         retained_islr: "0",
                         retained_total: "0.00000000",
                         functional_currency: "VES",
                         posting_date: HOY,
                         description: "Pago a proveedor",
                       })},
                       'La plantilla pide el importe «exchange_difference» y este documento no lo aporta.')`;
    });
    const r = await pedir(SPE, "POST", "/v1/accounting/pending/process", {});
    expect(r.status, await r.clone().text()).toBe(200);
    const [fila] = await sql<{ status: string; asiento: string | null }[]>`
      select q.status, e.status as asiento
        from public.journal_generation_queue q
        left join public.journal_entries e on e.id = q.generated_entry_id
       where q.company_id = ${SPE.company} and q.source_id = ${pago}`;
    expect(fila).toEqual({ status: "generated", asiento: "posted" });
    const lineas = await sql<{ papel: string | null; debe: string; haber: string }[]>`
      select (select min(s.purpose) from public.company_account_settings s
               where s.company_id = l.company_id and s.account_id = l.account_id
                 and s.purpose in ('ap_general', 'exchange_gain', 'exchange_loss')) as papel,
             l.functional_debit::text as debe, l.functional_credit::text as haber
        from public.journal_entries e
        join public.journal_lines l on l.entry_id = e.id
       where e.company_id = ${SPE.company} and e.source_kind = 'payment_made'
         and e.source_id = ${pago}
       order by l.line_number`;
    // Dos líneas: se cancela la cuenta por pagar y sale de la caja. Sin diferencial informado no
    // hay línea de ganancia ni de pérdida (el importe ausente vale 0 — y solo ese).
    expect(lineas).toEqual([
      { papel: "ap_general", debe: "580.00000000", haber: "0.00000000" },
      { papel: null, debe: "0.00000000", haber: "580.00000000" },
    ]);
    // El PAGO queda cubierto (la factura del montaje se sembró a mano, sin asiento: no se mira).
    const huecos = await sql`
      select * from platform.accounting_coverage_gaps(${SPE.company}) where source_id = ${pago}`;
    expect(huecos).toEqual([]);
    expect((await invariantes(SPE)).divisa).toEqual([]);
  });

  it("y NO es una regla general: otro importe ausente sigue encolando, con su motivo", async () => {
    // El mismo hecho con el contexto sin `net_amount`: la plantilla lo pide y no se inventa.
    const [previa] = await sql<{ id: string; source_id: string }[]>`
      select id, source_id from public.journal_generation_queue
       where company_id = ${SPE.company} and source_kind = 'payment_made' limit 1`;
    const pago = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`insert into public.supplier_payments
                 (id, tenant_id, company_id, supplier_id, supplier_invoice_id, paid_at, instrument,
                  gross_amount, retained_amount, net_amount, amount_transaction_currency,
                  transaction_currency, fx_rate, functional_amount, functional_currency,
                  rate_source, rate_timestamp, account_id)
               select ${pago}, sp.tenant_id, sp.company_id, sp.supplier_id, sp.supplier_invoice_id,
                      now(), 'transferencia', 10, 0, 10, 10, 'VES', 1, 10, 'VES', 'identidad',
                      now(), sp.account_id
                 from public.supplier_payments sp where sp.id = ${previa!.source_id}`;
      await tx`insert into public.journal_generation_queue
                 (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
               values (${SPE.tenant}, ${SPE.company}, 'payment_made', ${pago}, 'ap.payment_made',
                       ${tx.json({
                         total: "10.00000000",
                         functional_currency: "VES",
                         posting_date: HOY,
                         description: "Pago a proveedor",
                       })},
                       'Sin plantilla configurada')`;
    });
    const r = await pedir(SPE, "POST", "/v1/accounting/pending/process", {});
    expect(r.status, await r.clone().text()).toBe(200);
    const [fila] = await sql<{ status: string }[]>`
      select status from public.journal_generation_queue
       where company_id = ${SPE.company} and source_id = ${pago}`;
    expect(fila!.status).toBe("pending");
    // En cola no es un hueco de tesorería (H5): la caja = su subcuenta + lo que espera en la cola.
    expect((await invariantes(SPE)).divisa).toEqual([]);
    // Con el importe que faltaba, el pendiente se asienta (y el montaje no deja nada en cola).
    await sql`
      update public.journal_generation_queue
         set context = context || '{"net_amount": "10.00000000"}'::jsonb
       where company_id = ${SPE.company} and source_id = ${pago}`;
    const otra = await pedir(SPE, "POST", "/v1/accounting/pending/process", {});
    expect(otra.status, await otra.clone().text()).toBe(200);
    const [ya] = await sql<{ status: string }[]>`
      select status from public.journal_generation_queue
       where company_id = ${SPE.company} and source_id = ${pago}`;
    expect(ya!.status).toBe("generated");
  });
});

describe("moneda B · lo mostrado es lo que cierra (ADR-0075 §4-5)", () => {
  it("factura USD de varias líneas, abono en USD el mismo día, y se paga en Bs EXACTAMENTE lo que enseña la deuda → pagada, CxC en 0,00", async () => {
    // Una tasa con decimales y tres líneas de cantidades fraccionarias: el IVA redondeado al
    // céntimo de dólar y el de bolívares se apartan (E-05), que es donde la parte proporcional
    // del total y lo que el mayor carga dejan de coincidir tras un abono en divisa.
    await tasa("36.47330000");
    const f = await pedir(SPE, "POST", "/v1/invoices", {
      company_id: SPE.company,
      customer_id: SPE.cliente,
      warehouse_id: SPE.w,
      series: "A",
      lines: [
        { product_id: SPE.producto, quantity: "0.333" },
        { product_id: SPE.producto, quantity: "0.777" },
        { product_id: SPE.producto, quantity: "1.111" },
      ],
    });
    expect(f.status, await f.clone().text()).toBe(201);
    const doc = ((await f.json()) as { id: string }).id;
    await cobrar(SPE, doc, {
      currency: "USD",
      amount: "200.00000000",
      instrument: "zelle",
      account_id: SPE.bancoUsd,
    });

    const [deuda] = await sql<{ hoy: string; base: string; proporcional: string }[]>`
      select dd.functional_today::text as hoy,
             round(platform.document_settlement_base(${SPE.company}, ${doc}), 2)::text as base,
             round(d.total_amount * platform.document_balance_transaction(${SPE.company}, ${doc})
                   / d.amount_transaction_currency, 2)::text as proporcional
        from public.documents d
        cross join lateral platform.document_debt(${SPE.company}, ${doc}) dd
       where d.id = ${doc}`;
    // Lo mostrado ES la base con la que cierra el cobro…
    expect(deuda!.hoy).toBe(deuda!.base);
    // …y este escenario discrimina: no es la parte proporcional del total (lo que se enseñaba).
    expect(deuda!.hoy).not.toBe(deuda!.proporcional);
    // La misma cifra en el estado de cuenta.
    const estado = (await (
      await pedir(SPE, "GET", `/v1/customers/${SPE.cliente}/statement`)
    ).json()) as { documents: { id: string; balance: string }[] };
    expect(estado.documents.find((d) => d.id === doc)?.balance).toBe(deuda!.hoy);

    // Se paga en bolívares EXACTAMENTE esa cifra.
    const c = await cobrar(SPE, doc, {
      currency: "VES",
      amount: `${deuda!.hoy}000000`,
      instrument: "transferencia",
      account_id: SPE.bancoBs,
    });
    expect(c.document_status).toBe("paid");
    const [fin] = await sql<{ mayor: string; saldo: string }[]>`
      select platform.settlement_ledger_open(${SPE.company}, 'ar', ${doc})::text as mayor,
             round(platform.document_balance_transaction(${SPE.company}, ${doc}), 2)::text as saldo`;
    expect(Number(fin!.mayor)).toBe(0);
    expect(Number(fin!.saldo)).toBe(0);
    const inv = await invariantes(SPE);
    expect(inv.saldados).toEqual([]);
    expect(inv.divisa).toEqual([]);
  });

  it("SETTLEMENT_MISMATCH responde 409 con su mensaje, no 500", async () => {
    // El código lo devuelve registerPayment cuando el cobro que cierra no cuadra con el mayor
    // (un descuadre real, que no se fabrica desde la API). Se asevera el mapeo de `errors.ts`.
    const { Hono } = await import("hono");
    const { DominioError, onErrorResponder } = await import("../src/middleware/errors.js");
    const mini = new Hono();
    mini.onError(onErrorResponder);
    mini.get("/x", () => {
      throw new DominioError({
        code: "SETTLEMENT_MISMATCH",
        message:
          "Este cobro no cuadra con lo que el documento todavía debe. No se registró: revisa el documento.",
      });
    });
    const r = await mini.request("/x");
    expect(r.status).toBe(409);
    expect((await r.json()) as { code: string; person_message: string }).toMatchObject({
      code: "SETTLEMENT_MISMATCH",
      person_message:
        "Este cobro no cuadra con lo que el documento todavía debe. No se registró: revisa el documento.",
    });
  });
});

describe("moneda B · la cartera guarda su divisa en el mayor (H6, ADR-0075 §6)", () => {
  /** Las líneas de cuentas por cobrar de un documento y de sus cobros, en las dos monedas. */
  const cartera = (doc: string) =>
    sql<{ moneda: string; original: string; tasa: string; debe: string; haber: string }[]>`
      select l.transaction_currency as moneda,
             (case when l.functional_debit > 0 then l.amount_transaction_currency
                   else -l.amount_transaction_currency end)::text as original,
             l.fx_rate::text as tasa, l.functional_debit::text as debe,
             l.functional_credit::text as haber
        from public.journal_lines l
        join public.journal_entries e on e.id = l.entry_id
       where e.company_id = ${SPE.company}
         and (e.source_id = ${doc}
              or e.source_id in (select p.id from public.payments p where p.document_id = ${doc}))
         and l.account_id in (select s.account_id from public.company_account_settings s
                               where s.company_id = ${SPE.company} and s.purpose = 'ar_general')
       order by e.entry_number, l.line_number`;

  it("la factura en USD asienta su cuenta por cobrar EN DÓLARES a la tasa de la factura; el cobro que cierra la deja en 0,00 Bs y 0,00 USD", async () => {
    await tasa("36.47330000");
    const doc = await facturar(SPE); // 116 USD: base 3.647,33 + IVA 583,57 = 4.230,90 Bs
    const [linea] = await cartera(doc);
    expect(linea).toEqual({
      moneda: "USD",
      original: "116.00000000",
      tasa: "36.47330000",
      debe: "4230.90000000",
      haber: "0.00000000",
    });
    // Y debit_amount lleva los dólares: quien quiera bolívares lee functional_debit.
    const [crudo] = await sql<{ debe: string }[]>`
      select l.debit_amount::text as debe
        from public.journal_lines l
        join public.journal_entries e on e.id = l.entry_id
       where e.company_id = ${SPE.company} and e.source_id = ${doc} and l.debit_amount > 0
         and l.transaction_currency = 'USD'`;
    expect(crudo!.debe).toBe("116.00000000");

    // Un abono en dólares y el resto en bolívares, a lo que enseña la deuda.
    await cobrar(SPE, doc, {
      currency: "USD",
      amount: "16.00000000",
      instrument: "zelle",
      account_id: SPE.bancoUsd,
    });
    const [deuda] = await sql<{ hoy: string }[]>`
      select functional_today::text as hoy from platform.document_debt(${SPE.company}, ${doc})`;
    const c = await cobrar(SPE, doc, {
      currency: "VES",
      amount: `${deuda!.hoy}000000`,
      instrument: "transferencia",
      account_id: SPE.bancoBs,
    });
    expect(c.document_status).toBe("paid");

    const lineas = await cartera(doc);
    expect(lineas).toHaveLength(3);
    // Todas en la moneda y a la tasa DEL DOCUMENTO (el diferencial, si lo hay, va en su línea).
    expect(new Set(lineas.map((l) => `${l.moneda} ${l.tasa}`))).toEqual(
      new Set(["USD 36.47330000"]),
    );
    const bs = lineas.reduce((n, l) => n + Math.round(Number(l.debe) * 100), 0);
    const bsHaber = lineas.reduce((n, l) => n + Math.round(Number(l.haber) * 100), 0);
    const usd = lineas.reduce((n, l) => n + Math.round(Number(l.original) * 100), 0);
    expect(bs - bsHaber).toBe(0); // 0,00 Bs
    expect(usd).toBe(0); // 0,00 USD: la suma de los originales
    // La comprobación de la empresa cuadra, y los invariantes siguen en cero.
    const [tb] = await sql<{ debe: string; haber: string }[]>`
      select sum(period_debit)::text as debe, sum(period_credit)::text as haber
        from platform.trial_balance(${SPE.company}, ${HOY}::date)`;
    expect(tb!.debe).toBe(tb!.haber);
    expect(await invariantes(SPE)).toEqual(CEROS);
  });

  it("la reversa de un cobro deshace la cuenta por cobrar EN DÓLARES (el contra-asiento copia moneda y tasa)", async () => {
    const doc = await facturar(SPE);
    const c = await cobrar(SPE, doc, {
      currency: "USD",
      amount: "20.00000000",
      instrument: "zelle",
      account_id: SPE.bancoUsd,
    });
    const r = await reversar(SPE, c.payment.id, "Abono cargado al documento equivocado");
    expect(r.status, await r.clone().text()).toBe(201);
    const rev = (await r.json()) as Reversa;
    const [contra] = await sql<{ moneda: string; debe: string; tasa: string }[]>`
      select l.transaction_currency as moneda, l.debit_amount::text as debe, l.fx_rate::text as tasa
        from public.journal_lines l
       where l.entry_id = ${rev.reversal_entry_id}
         and l.account_id in (select s.account_id from public.company_account_settings s
                               where s.company_id = ${SPE.company} and s.purpose = 'ar_general')`;
    expect(contra).toEqual({ moneda: "USD", debe: "20.00000000", tasa: "36.47330000" });
    expect(await invariantes(SPE)).toEqual(CEROS);
  });
});

describe("moneda B · la reversa de un cobro que aplicó SALDO A FAVOR (Y13)", () => {
  it("el saldo a favor vuelve a estar disponible, el documento vuelve a deber y los invariantes siguen en cero", async () => {
    const doc = await facturar(SPE); // 116 USD
    const [origen] = await sql<{ id: string }[]>`
      select id from public.documents
       where company_id = ${SPE.company} and customer_id = ${SPE.cliente} and id <> ${doc}
       order by issued_at limit 1`;
    const credito = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`insert into public.customer_credits
                 (id, tenant_id, company_id, customer_id, source_document_id, amount, currency,
                  applied_amount, status)
               values (${credito}, ${SPE.tenant}, ${SPE.company}, ${SPE.cliente}, ${origen!.id},
                       1000, 'VES', 0, 'available')`;
    });
    const antes = (
      await sql<{ nominal: string }[]>`
      select nominal::text as nominal from platform.document_debt(${SPE.company}, ${doc})`
    )[0]!;
    const c = await cobrar(SPE, doc, {
      currency: "VES",
      amount: "1000.00000000",
      instrument: "saldo_a_favor",
      customer_credit_id: credito,
    });
    const [aplicado] = await sql<{ applied: string; status: string }[]>`
      select applied_amount::text as applied, status from public.customer_credits
       where id = ${credito}`;
    expect(aplicado).toEqual({ applied: "1000.00000000", status: "applied" });
    const cajaAntes = await saldoCuenta(SPE.bancoBs);

    const r = await reversar(SPE, c.payment.id, "El saldo a favor se aplicó a otra factura");
    expect(r.status, await r.clone().text()).toBe(201);
    const rev = (await r.json()) as Reversa;
    expect(rev.document).toEqual({ id: doc, status: "issued" });
    // El documento vuelve a deber lo de antes de aplicar el saldo.
    expect(rev.debt?.nominal).toBe(antes.nominal);
    // El saldo a favor vuelve entero y disponible.
    const [devuelto] = await sql<{ applied: string; status: string }[]>`
      select applied_amount::text as applied, status from public.customer_credits
       where id = ${credito}`;
    expect(devuelto).toEqual({ applied: "0.00000000", status: "available" });
    // No movió efectivo: ninguna caja cambia.
    expect(await saldoCuenta(SPE.bancoBs)).toBe(cajaAntes);
    const [asiento] = await sql<{ status: string }[]>`
      select status from public.journal_entries
       where company_id = ${SPE.company} and source_kind = 'payment_received'
         and source_id = ${c.payment.id}`;
    expect(asiento?.status ?? "reversed").toBe("reversed");
    expect(await invariantes(SPE)).toEqual(CEROS);
  });
});

describe("moneda A/B · el pago a proveedor de la API vieja CON retención (R-74 §3)", () => {
  it("la fila en cola con `total` = bruto y `net_amount` = neto genera un asiento que cuadra", async () => {
    const [previo] = await sql<{ supplier_id: string; supplier_invoice_id: string }[]>`
      select supplier_id, supplier_invoice_id from public.supplier_payments
       where company_id = ${SPE.company} order by created_at limit 1`;
    const pago = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      // 100 brutos, 20 retenidos, 80 salen de la caja.
      await tx`insert into public.supplier_payments
                 (id, tenant_id, company_id, supplier_id, supplier_invoice_id, paid_at, instrument,
                  gross_amount, retained_amount, net_amount, amount_transaction_currency,
                  transaction_currency, fx_rate, functional_amount, functional_currency,
                  rate_source, rate_timestamp, account_id)
               values (${pago}, ${SPE.tenant}, ${SPE.company}, ${previo!.supplier_id},
                       ${previo!.supplier_invoice_id}, now(), 'transferencia', 100, 20, 80, 100,
                       'VES', 1, 100, 'VES', 'identidad', now(), ${SPE.bancoBs})`;
      // El contexto de la API anterior: `total` = el bruto, `net_amount` = lo que salió, y sin
      // `exchange_difference`. La plantilla de entonces cancelaba la cuenta por pagar por el neto.
      await tx`insert into public.journal_generation_queue
                 (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
               values (${SPE.tenant}, ${SPE.company}, 'payment_made', ${pago}, 'ap.payment_made',
                       ${tx.json({
                         total: "100.00000000",
                         net_amount: "80.00000000",
                         retained_iva: "15.00000000",
                         retained_islr: "5.00000000",
                         retained_total: "20.00000000",
                         functional_currency: "VES",
                         posting_date: HOY,
                         description: "Pago a proveedor",
                       })},
                       'Sin plantilla configurada')`;
    });
    const r = await pedir(SPE, "POST", "/v1/accounting/pending/process", {});
    expect(r.status, await r.clone().text()).toBe(200);
    const lineas = await sql<{ papel: string | null; debe: string; haber: string }[]>`
      select (select min(s.purpose) from public.company_account_settings s
               where s.company_id = l.company_id and s.account_id = l.account_id
                 and s.purpose = 'ap_general') as papel,
             l.functional_debit::text as debe, l.functional_credit::text as haber
        from public.journal_entries e
        join public.journal_lines l on l.entry_id = e.id
       where e.company_id = ${SPE.company} and e.source_kind = 'payment_made'
         and e.source_id = ${pago} and e.status = 'posted'
       order by l.line_number`;
    // Como lo asentaba la plantilla de entonces: la cuenta por pagar baja por lo que SALIÓ (la
    // retención la descarga su comprobante), contra la caja.
    expect(lineas).toEqual([
      { papel: "ap_general", debe: "80.00000000", haber: "0.00000000" },
      { papel: null, debe: "0.00000000", haber: "80.00000000" },
    ]);
  });
});

describe("moneda · el original de la cartera es determinista y el cobro a la tasa del documento no es cambiario (Z2, AF-M03)", () => {
  const lineasDe = (doc: string, papel: string) =>
    sql<{ original: string; debe: string; haber: string }[]>`
      select (case when l.functional_debit > 0 then l.amount_transaction_currency
                   else -l.amount_transaction_currency end)::text as original,
             l.functional_debit::text as debe, l.functional_credit::text as haber
        from public.journal_lines l
        join public.journal_entries e on e.id = l.entry_id
       where e.company_id = ${SPE.company}
         and (e.source_id = ${doc}
              or e.source_id in (select p.id from public.payments p where p.document_id = ${doc}))
         and l.account_id in (select s.account_id from public.company_account_settings s
                               where s.company_id = ${SPE.company} and s.purpose = ${papel})
       order by e.entry_number, l.line_number`;
  beforeAll(async () => {
    // La empresa asume el IGTF: el cobro en dólares abona entero a la factura.
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`update public.company_settings set absorb_igtf = true
                where company_id = ${SPE.company}`;
    });
  });
  const facturarLineas = async (cantidades: string[]): Promise<string> => {
    const f = await pedir(SPE, "POST", "/v1/invoices", {
      company_id: SPE.company,
      customer_id: SPE.cliente,
      warehouse_id: SPE.w,
      series: "A",
      lines: cantidades.map((quantity) => ({ product_id: SPE.producto, quantity })),
    });
    expect(f.status, await f.clone().text()).toBe(201);
    return ((await f.json()) as { id: string }).id;
  };

  it("Z2 · cinco líneas de ~0,30 USD cobradas enteras: Σ originales de su CxC = 0,00 USD y Σ funcional = 0,00 Bs", async () => {
    await tasa("36.47330000");
    // Cinco líneas baratas: el redondeo por línea pesa MÁS del 0,5 % del total, que era el
    // umbral con el que el generador decidía «si se parece». Con él, la línea de la factura caía
    // a funcional ÷ tasa y la suma de originales del documento saldado no daba cero.
    const doc = await facturarLineas(["0.003", "0.003", "0.003", "0.003", "0.003"]);
    const [d] = await sql<{ usd: string; bs: string }[]>`
      select amount_transaction_currency::text as usd, total_amount::text as bs
        from public.documents where id = ${doc}`;
    const c = await cobrar(SPE, doc, {
      currency: "USD",
      amount: d!.usd,
      instrument: "zelle",
      account_id: SPE.bancoUsd,
    });
    expect(c.document_status).toBe("paid");
    const lineas = await lineasDe(doc, "ar_general");
    expect(lineas).toHaveLength(2);
    // La factura lleva SU total en dólares, exacto; el cobro, lo que saldó.
    expect(Number(lineas[0]!.original)).toBe(Number(d!.usd));
    expect(Number(lineas[1]!.original)).toBe(-Number(d!.usd));
    expect(lineas[0]!.debe).toBe(d!.bs);
    const centimos = (x: string) => Math.round(Number(x) * 100);
    expect(lineas.reduce((n, l) => n + centimos(l.original), 0)).toBe(0);
    expect(lineas.reduce((n, l) => n + centimos(l.debe) - centimos(l.haber), 0)).toBe(0);
    expect(await invariantes(SPE)).toEqual(CEROS);
  });

  it("AF-M03 · mismo día, misma divisa: cero filas de diferencial, el residuo en «Diferencias por redondeo» y la CxC en 0,00", async () => {
    // Tres líneas con cantidades fraccionarias a una tasa con decimales: lo que entra
    // (total en USD × tasa) NO es el total en Bs de la factura (E-05). Esa diferencia no es
    // cambiaria —la tasa es la misma—: es redondeo.
    const doc = await facturarLineas(["0.333", "0.777", "1.111"]);
    const [d] = await sql<{ usd: string; bs: string }[]>`
      select amount_transaction_currency::text as usd, total_amount::text as bs
        from public.documents where id = ${doc}`;
    // Un abono de 100 USD y, el mismo día, el resto EN BOLÍVARES a la tasa de la factura, diez
    // céntimos por debajo de lo que la deuda enseña: menos de medio céntimo de dólar, así que el
    // cobro CIERRA (regla del último centavo) y deja un residuo de 0,10 Bs. La tasa es la misma:
    // no es diferencial cambiario. (En la divisa del documento y a su tasa el cobro ya cancela
    // exactamente lo que el mayor carga y no deja residuo: «el cobro y el cierre», regla 2.)
    await cobrar(SPE, doc, {
      currency: "USD",
      amount: "100.00000000",
      instrument: "zelle",
      account_id: SPE.bancoUsd,
    });
    const [deuda] = await sql<{ hoy: string }[]>`
      select functional_today::text as hoy from platform.document_debt(${SPE.company}, ${doc})`;
    const c = await cobrar(SPE, doc, {
      currency: "VES",
      amount: (Number(deuda!.hoy) - 0.1).toFixed(2) + "000000",
      instrument: "transferencia",
      account_id: SPE.bancoBs,
    });
    expect(c.document_status).toBe("paid");
    // Lo que ENTRÓ (en Bs, a la misma tasa) menos lo que la factura pesaba: el residuo.
    const [r] = await sql<{ residuo: string }[]>`
      select (sum(p.functional_amount) - ${d!.bs}::numeric)::text as residuo
        from public.payments p where p.document_id = ${doc}`;
    // El escenario discrimina: hay residuo (−0,10 Bs), y no es cambiario.
    expect(Number(r!.residuo)).toBeCloseTo(-0.1, 2);

    const [dif] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.exchange_gain_loss where document_id = ${doc}`;
    expect(dif!.n).toBe(0);
    const redondeo = await lineasDe(doc, "rounding_difference");
    expect(redondeo).toHaveLength(1);
    // Entró más de lo que la factura pesaba → abono a redondeo; menos → cargo.
    const neto = Number(redondeo[0]!.haber) - Number(redondeo[0]!.debe);
    expect(neto).toBeCloseTo(Number(r!.residuo), 2);
    // Ni ganancia ni pérdida cambiaria en ese cobro.
    expect(await lineasDe(doc, "exchange_gain")).toEqual([]);
    expect(await lineasDe(doc, "exchange_loss")).toEqual([]);
    const cxc = await lineasDe(doc, "ar_general");
    const centimos = (x: string) => Math.round(Number(x) * 100);
    expect(cxc.reduce((n, l) => n + centimos(l.debe) - centimos(l.haber), 0)).toBe(0);
    expect(cxc.reduce((n, l) => n + centimos(l.original), 0)).toBe(0);
    expect(await invariantes(SPE)).toEqual(CEROS);
  });

  it("y a OTRA tasa el diferencial sigue siendo cambiario: su fila y su línea de ganancia", async () => {
    const doc = await facturarLineas(["1"]); // 116 USD a 36,4733
    await tasa("37.00000000");
    const c = await cobrar(SPE, doc, {
      currency: "USD",
      amount: "116.00000000",
      instrument: "zelle",
      account_id: SPE.bancoUsd,
    });
    expect(c.document_status).toBe("paid");
    const [dif] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.exchange_gain_loss where document_id = ${doc}`;
    expect(dif!.n).toBe(1);
    expect(await lineasDe(doc, "exchange_gain")).toHaveLength(1);
    expect(await lineasDe(doc, "rounding_difference")).toEqual([]);
  });
});

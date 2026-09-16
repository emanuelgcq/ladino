import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * EL DINERO DEL NEGOCIO (ADR-0062, migración 61). Cuatro cosas que el QA de pantalla del
 * 2026-09-15 encontró rotas, y que se prueban aquí desde la API real:
 *
 *   §1 — un cobro con una forma SIN configurar entra en la caja propia de su familia, no en
 *        «Sin asignar» (h. 15: Empezar prometía «cada cobro cae en una de estas cuentas»);
 *   §2 — una forma en dólares no puede apuntar a una cuenta en bolívares (h. 32);
 *   §3 — mover dinero entre dos cuentas existe, mueve los dos saldos y deja su asiento con
 *        las dos cajas REALES (h. 24: «Por repartir» sin nada con qué repartir);
 *   §4 — un egreso que deja la cuenta en negativo se rechaza con el saldo delante, y solo se
 *        registra si quien lo hace lo confirma (h. 33, 50, 71, 77).
 *
 * VARIANTE ROTA en §3: transferir entre monedas distintas se rechaza — cambiar de moneda tiene
 * tasa y diferencial, y no es una transferencia.
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

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let SERVICIO = "";
let CAJA_BS = "";
let BANCO_BS = "";
let CAJA_USD = "";
let MAYOR_CAJA = "";
let MAYOR_BANCO = "";

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

/** El saldo materializado de una cuenta, como string. */
async function saldoDe(cuenta: string): Promise<string> {
  const [fila] = await sql<{ saldo: string }[]>`
    select coalesce(b.balance, 0)::text as saldo
      from public.company_accounts ca
      left join public.company_account_balances b on b.account_id = ca.id
     where ca.id = ${cuenta}`;
  return fila!.saldo;
}

/** Las líneas del asiento posteado de un hecho: cuenta contable y lado. */
async function lineasDe(
  sourceKind: string,
  sourceId: string,
): Promise<{ account_id: string; lado: "debe" | "haber" }[]> {
  return sql<{ account_id: string; lado: "debe" | "haber" }[]>`
    select l.account_id,
           case when l.debit_amount > 0 then 'debe' else 'haber' end as lado
      from public.journal_entries e
      join public.journal_lines l on l.entry_id = e.id
     where e.company_id = ${COMPANY} and e.source_kind = ${sourceKind}
       and e.source_id = ${sourceId} and e.status = 'posted'
     order by l.line_number`;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e mover dinero')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-MOV-${RUN}`}, 'Bodega del dinero', 'VES',
                     'ordinario')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-MDW1', 'Local')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2emover_${RUN}`}, 'Dueño', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.payment.register'),
             (${ROL}, 'ar.read'), (${ROL}, 'expense.register'), (${ROL}, 'expense.read'),
             (${ROL}, 'treasury.read'), (${ROL}, 'treasury.account.manage'),
             (${ROL}, 'treasury.reassign'), (${ROL}, 'inventory.move'),
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
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, 'Vecina Rosa', 'natural',
                     'consumidor_final')`;
    const [s] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`MD-SERV-${RUN}`}, 'Corte de cabello', 'service', 'active',
              'unidad', 'gravado_general') returning id`;
    SERVICIO = s!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, 'detal', 'VES') returning id`;
    await tx`insert into public.company_settings (company_id, tenant_id, default_price_list_id)
             values (${COMPANY}, ${TENANT}, ${l!.id})`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${l!.id}, ${SERVICIO}, 100, now() - interval '1 day')`;
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), 'e2e-mover-dinero'
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = ${HOY}::date)`;
  });
  for (const [ruta, cuerpo] of [
    ["/v1/accounts/import-template", { company_id: COMPANY, template_code: "ve_basico" }],
    ["/v1/journal-templates/import-preset", { company_id: COMPANY, preset_code: "ve_basico" }],
  ] as const) {
    expect((await pedir("POST", ruta, cuerpo)).status).toBe(201);
  }

  // Dos cuentas contables PROPIAS: si el asiento de la transferencia cayera en la cuenta
  // genérica de caja, las dos líneas serían la misma y la prueba no diría nada.
  const [padre] = await sql<{ id: string }[]>`
    select id from public.accounts where company_id = ${COMPANY} and code = '1.1'`;
  for (const [code, name] of [
    ["1.1.91", "Caja del local"],
    ["1.1.92", "Banco Venezuela Bs."],
  ] as const) {
    const r = await pedir("POST", "/v1/accounts", {
      company_id: COMPANY,
      code,
      name,
      parent_id: padre!.id,
      kind: "activo",
    });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as { id: string }).id;
    if (code === "1.1.91") MAYOR_CAJA = id;
    else MAYOR_BANCO = id;
  }

  // Las cajas del negocio, como las crea Empezar: una caja y un banco en bolívares, y una
  // billetera en dólares.
  for (const [name, currency, kind, mayor] of [
    [`Caja del local ${RUN}`, "VES", "cash", () => MAYOR_CAJA],
    [`Banco Venezuela ${RUN}`, "VES", "bank", () => MAYOR_BANCO],
    [`Zelle ${RUN}`, "USD", "wallet", () => null],
  ] as const) {
    const r = await pedir("POST", "/v1/treasury/accounts", {
      company_id: COMPANY,
      name,
      currency,
      kind,
      ...(mayor() === null ? {} : { ledger_account_id: mayor() }),
    });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as { id: string }).id;
    if (kind === "cash") CAJA_BS = id;
    else if (kind === "bank") BANCO_BS = id;
    else CAJA_USD = id;
  }
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("el dinero del negocio: dónde cae, cómo se mueve y qué pasa si no alcanza", () => {
  it("§1 · un cobro en efectivo SIN forma configurada entra en la caja del negocio, no en «Sin asignar»", async () => {
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: SERVICIO, quantity: "1" }],
    });
    expect(venta.status).toBe(201);
    const recibo = ((await venta.json()) as { document: { id: string } }).document.id;

    // Sin `account_id` y sin formas configuradas: lo resuelve el servidor.
    const cobro = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: recibo,
      currency: "VES",
      amount: "100.00000000",
      instrument: "efectivo_bs",
    });
    expect(cobro.status).toBe(201);
    const pago = (await cobro.json()) as { payment: { id: string } };
    // La cuenta a la que entró el dinero no viaja en la respuesta: se comprueba donde queda
    // escrita, que es lo que luego lee el saldo.
    const [fila] = await sql<{ account_id: string | null }[]>`
      select account_id from public.payments where id = ${pago.payment.id}`;
    expect(fila!.account_id).toBe(CAJA_BS);

    const sistema = await sql<{ n: number }[]>`
      select count(*)::int as n from public.company_accounts
       where company_id = ${COMPANY} and is_system`;
    expect(sistema[0]!.n).toBe(0);
    expect(await saldoDe(CAJA_BS)).toBe("100.00000000");
  });

  it("§2 · una forma en dólares no puede apuntar a una cuenta en bolívares", async () => {
    const mala = await pedir("POST", "/v1/payment-methods", {
      company_id: COMPANY,
      name: `Zelle a la caja ${RUN}`,
      kind: "zelle",
      account_id: CAJA_BS,
    });
    expect(mala.status).toBe(422);
    const cuerpo = (await mala.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("VALIDATION_FAILED");
    // El mensaje, no solo el código: el 422 genérico del esquema diría lo mismo.
    expect(cuerpo.message).toContain("cobra en USD");

    const buena = await pedir("POST", "/v1/payment-methods", {
      company_id: COMPANY,
      name: `Zelle ${RUN}`,
      kind: "zelle",
      account_id: CAJA_USD,
    });
    expect(buena.status).toBe(201);
  });

  it("§3 · mover dinero entre cuentas mueve los DOS saldos y asienta contra las dos cajas reales", async () => {
    const r = await pedir("POST", "/v1/treasury/transfers", {
      company_id: COMPANY,
      from_account_id: CAJA_BS,
      to_account_id: BANCO_BS,
      amount: "60.00",
      reason: "Depósito del efectivo del día",
    });
    expect(r.status).toBe(201);
    const t = (await r.json()) as { id: string; accounting: string; journal_entry_id: string };
    expect(t.accounting).toBe("posted");

    expect(await saldoDe(CAJA_BS)).toBe("40.00000000");
    expect(await saldoDe(BANCO_BS)).toBe("60.00000000");

    const lineas = await lineasDe("treasury_transfer", t.id);
    expect(lineas.find((l) => l.lado === "debe")?.account_id).toBe(MAYOR_BANCO);
    expect(lineas.find((l) => l.lado === "haber")?.account_id).toBe(MAYOR_CAJA);

    // Y la cobertura contable no ve huecos: el hecho tiene su asiento.
    const huecos = await sql<{ source_kind: string; problem: string }[]>`
      select source_kind, problem from platform.accounting_coverage_gaps(${COMPANY})`;
    expect(huecos).toEqual([]);
  });

  it("§3 · VARIANTE ROTA: transferir entre monedas distintas se rechaza", async () => {
    const r = await pedir("POST", "/v1/treasury/transfers", {
      company_id: COMPANY,
      from_account_id: BANCO_BS,
      to_account_id: CAJA_USD,
      amount: "10.00",
      reason: "Pasar bolívares a Zelle",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain("la misma moneda");
  });

  it("§4 · transferir más de lo que hay se rechaza con el saldo delante, y solo pasa confirmado", async () => {
    const cuerpo = {
      company_id: COMPANY,
      from_account_id: CAJA_BS,
      to_account_id: BANCO_BS,
      amount: "50.00",
      reason: "Llevar más de lo que hay",
    };
    const sin = await pedir("POST", "/v1/treasury/transfers", cuerpo);
    expect(sin.status).toBe(409);
    const error = (await sin.json()) as { code: string; message: string };
    expect(error.code).toBe("INSUFFICIENT_FUNDS");
    expect(error.message).toContain("40.00000000");
    // Nada se escribió: el saldo sigue donde estaba.
    expect(await saldoDe(CAJA_BS)).toBe("40.00000000");

    const con = await pedir("POST", "/v1/treasury/transfers", {
      ...cuerpo,
      allow_negative_balance: true,
    });
    expect(con.status).toBe(201);
    expect(await saldoDe(CAJA_BS)).toBe("-10.00000000");

    // Y se devuelve el dinero para no dejar la caja negativa al resto de las pruebas.
    const vuelta = await pedir("POST", "/v1/treasury/transfers", {
      company_id: COMPANY,
      from_account_id: BANCO_BS,
      to_account_id: CAJA_BS,
      amount: "50.00",
      reason: "Devolver lo que no había",
    });
    expect(vuelta.status).toBe(201);
    expect(await saldoDe(CAJA_BS)).toBe("40.00000000");
  });

  it("§4 · un gasto mayor que el saldo se rechaza, y con la confirmación se registra", async () => {
    const cuerpo = {
      company_id: COMPANY,
      category: "Alquiler",
      account_id: CAJA_BS,
      amount: "500.00",
    };
    const sin = await pedir("POST", "/v1/expenses", cuerpo);
    expect(sin.status).toBe(409);
    expect(((await sin.json()) as { code: string }).code).toBe("INSUFFICIENT_FUNDS");
    expect(await saldoDe(CAJA_BS)).toBe("40.00000000");

    const con = await pedir("POST", "/v1/expenses", { ...cuerpo, allow_negative_balance: true });
    expect(con.status).toBe(201);
    expect(await saldoDe(CAJA_BS)).toBe("-460.00000000");
  });
});

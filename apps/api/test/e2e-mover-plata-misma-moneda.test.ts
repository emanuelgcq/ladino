import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * J-01 · «MOVER PLATA» ENTRE DOS CUENTAS DE LA MISMA MONEDA (ADR-0070).
 *
 * El caso POR OMISIÓN, el que la persona hace el primer día: dos cuentas en bolívares creadas
 * como las crea la web, SIN cuenta contable explícita. Antes de ADR-0070 las dos caían en
 * 1.1.01, el asiento de la transferencia tenía dos líneas sobre la misma cuenta y
 * `apply_ledger_balance` las metía en un solo `INSERT … ON CONFLICT`: 500 «ON CONFLICT DO UPDATE
 * command cannot affect row a second time». `e2e-mover-dinero.test.ts` no lo veía porque crea a
 * propósito dos cuentas contables distintas (1.1.91 y 1.1.92).
 *
 * Lo que se asevera es lo que SOLO produce el arreglo, no el 201 a secas (CLAUDE.md §3,
 * «asevera el mensaje»): cada cuenta de tesorería nace con SU subcuenta, hija de 1.1.01 y con su
 * nombre; el asiento mueve las dos subcuentas; el mayor materializado coincide con el recalculado;
 * y el invariante tesorería ↔ mayor da cero.
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
const ROL = crypto.randomUUID();
const RUN = Date.now().toString(36);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let CAJA_BS = "";
let BANCO_BS = "";
let CAJA_USD = "";

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

/** La subcuenta contable de una cuenta de tesorería, con su padre. */
async function subcuentaDe(cuenta: string) {
  const [fila] = await sql<
    {
      id: string | null;
      code: string | null;
      name: string | null;
      is_leaf: boolean | null;
      padre: string | null;
    }[]
  >`
    select a.id, a.code, a.name, a.is_leaf, p.code as padre
      from public.company_accounts ca
      left join public.accounts a on a.id = ca.ledger_account_id
      left join public.accounts p on p.id = a.parent_id
     where ca.id = ${cuenta}`;
  return fila!;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e J-01')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-J01-${RUN}`}, 'Bodega J-01', 'VES',
                     'ordinario')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-J01W1', 'Local')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2ej01_${RUN}`}, 'Dueño', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'treasury.overdraft'),
             (${ROL}, 'treasury.read'), (${ROL}, 'treasury.account.manage'),
             (${ROL}, 'treasury.reassign'), (${ROL}, 'accounting.account.manage'),
             (${ROL}, 'accounting.template.manage'), (${ROL}, 'accounting.entry.post'),
             (${ROL}, 'accounting.read')
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
  });
  for (const [ruta, cuerpo] of [
    ["/v1/accounts/import-template", { company_id: COMPANY, template_code: "ve_basico" }],
    ["/v1/journal-templates/import-preset", { company_id: COMPANY, preset_code: "ve_basico" }],
  ] as const) {
    expect((await pedir("POST", ruta, cuerpo)).status).toBe(201);
  }

  // Como las crea Empezar o «Mi dinero»: SIN `ledger_account_id`. Es el caso por omisión.
  for (const [name, currency, kind] of [
    [`Caja Bs ${RUN}`, "VES", "cash"],
    [`Banco Mercantil ${RUN}`, "VES", "bank"],
    [`Caja USD ${RUN}`, "USD", "cash"],
  ] as const) {
    const r = await pedir("POST", "/v1/treasury/accounts", {
      company_id: COMPANY,
      name,
      currency,
      kind,
    });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as { id: string }).id;
    if (kind === "bank") BANCO_BS = id;
    else if (currency === "VES") CAJA_BS = id;
    else CAJA_USD = id;
  }
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("J-01 · mover plata entre dos cuentas en bolívares, como vienen de fábrica", () => {
  it("cada cuenta de tesorería nace con su subcuenta propia, hija de la familia de su moneda", async () => {
    const caja = await subcuentaDe(CAJA_BS);
    const banco = await subcuentaDe(BANCO_BS);
    const usd = await subcuentaDe(CAJA_USD);
    expect(caja.padre).toBe("1.1.01");
    expect(banco.padre).toBe("1.1.01");
    expect(usd.padre).toBe("1.1.02");
    expect(caja.name).toBe(`Caja Bs ${RUN}`);
    expect(banco.name).toBe(`Banco Mercantil ${RUN}`);
    expect(usd.name).toBe(`Caja USD ${RUN}`);
    expect(caja.is_leaf).toBe(true);
    expect(new Set([caja.id, banco.id, usd.id]).size).toBe(3);
  });

  it("la transferencia da 201, asienta contra las DOS subcuentas y el mayor cuadra", async () => {
    const r = await pedir("POST", "/v1/treasury/transfers", {
      company_id: COMPANY,
      from_account_id: BANCO_BS,
      to_account_id: CAJA_BS,
      amount: "10.00",
      reason: "Sacar efectivo del banco",
      allow_negative_balance: true,
      overdraft_reason: "Fixture E2E: se confirma el sobregiro con su motivo",
    });
    expect(r.status).toBe(201);
    const t = (await r.json()) as { id: string; accounting: string; journal_entry_id: string };
    expect(t.accounting).toBe("posted");

    const caja = await subcuentaDe(CAJA_BS);
    const banco = await subcuentaDe(BANCO_BS);
    const lineas = await sql<
      { account_id: string; functional_debit: string; functional_credit: string }[]
    >`
      select l.account_id, l.functional_debit::text, l.functional_credit::text
        from public.journal_lines l
       where l.entry_id = ${t.journal_entry_id}
       order by l.line_number`;
    expect(lineas).toEqual([
      { account_id: caja.id, functional_debit: "10.00000000", functional_credit: "0.00000000" },
      { account_id: banco.id, functional_debit: "0.00000000", functional_credit: "10.00000000" },
    ]);

    // El mayor materializado es el recalculado, cuenta por cuenta.
    for (const cuenta of [caja.id!, banco.id!]) {
      const [m] = await sql<{ d: string; c: string }[]>`
        select coalesce(sum(debit_total), 0)::text as d, coalesce(sum(credit_total), 0)::text as c
          from public.ledger_balances where company_id = ${COMPANY} and account_id = ${cuenta}`;
      const [rc] = await sql<{ d: string; c: string }[]>`
        select debit_total::text as d, credit_total::text as c
          from platform.recompute_ledger(${COMPANY}, ${cuenta}, null, null)`;
      expect(m).toEqual(rc);
    }

    // Y el invariante nuevo: el saldo de cada cuenta de tesorería es el de su subcuenta.
    const huecos = await sql<{ account_name: string; problem: string }[]>`
      select account_name, problem from platform.treasury_ledger_gaps(${COMPANY})`;
    expect(huecos).toEqual([]);
  });
});

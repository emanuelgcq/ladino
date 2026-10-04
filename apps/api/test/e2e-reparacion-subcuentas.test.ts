import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { repairTreasurySubaccounts, SYSTEM_POSTER_ID } from "@ladino/domain";
import { buildApp } from "../src/app.js";

/**
 * LA REPARACIÓN DE ADR-0070 (J-01), DE PUNTA A PUNTA: `repairTreasurySubaccounts` del dominio sobre
 * una empresa que todavía comparte la cuenta de familia (1.1.01) entre dos cajas — el estado de
 * toda empresa que existía antes de la migración 20260928110000.
 *
 * Se asevera lo que solo produce la reparación: el asiento de reclasificación queda POSTEADO, con
 * número y con `posted_by = SYSTEM_POSTER_ID`; deja `journal.posted` como el posteo manual; el
 * invariante tesorería ↔ mayor pasa de `compartida` a cero; y una segunda llamada no repara nada.
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
let FAMILIA = "";

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
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e reparación ADR-0070')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-RSC-${RUN}`}, 'Bodega sin reparar', 'VES',
                     'ordinario')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-RSCW1', 'Local')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2ersc_${RUN}`}, 'Dueño', true)`;
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

  // Las dos cajas, mapeadas A MANO a la cuenta de familia: como quedaron las de antes de ADR-0070.
  const [f] = await sql<{ id: string }[]>`
    select id from public.accounts where company_id = ${COMPANY} and code = '1.1.01'`;
  FAMILIA = f!.id;
  for (const [name, kind] of [
    [`Caja Bs ${RUN}`, "cash"],
    [`Banco Mercantil ${RUN}`, "bank"],
  ] as const) {
    const r = await pedir("POST", "/v1/treasury/accounts", {
      company_id: COMPANY,
      name,
      currency: "VES",
      kind,
      ledger_account_id: FAMILIA,
    });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as { id: string }).id;
    if (kind === "bank") BANCO_BS = id;
    else CAJA_BS = id;
  }
  // Con la agrupación de la migración, esto ya no da 500: dos líneas sobre 1.1.01 que se anulan.
  const t = await pedir("POST", "/v1/treasury/transfers", {
    company_id: COMPANY,
    from_account_id: BANCO_BS,
    to_account_id: CAJA_BS,
    amount: "10.00",
    reason: "Antes de la reparación",
    allow_negative_balance: true,
    overdraft_reason: "Fixture E2E: se confirma el sobregiro con su motivo",
  });
  expect(t.status).toBe(201);
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("ADR-0070 · repairTreasurySubaccounts sobre una empresa sin reparar", () => {
  it("reparte las cajas en subcuentas, postea la reclasificación como el sistema y deja el invariante en cero", async () => {
    const antes = await sql<{ problem: string }[]>`
      select problem from platform.treasury_ledger_gaps(${COMPANY}) order by problem`;
    expect(antes.map((g) => g.problem)).toEqual(["compartida", "compartida"]);

    const r = await sql.begin((tx) => repairTreasurySubaccounts(tx, COMPANY));
    expect(r.repaired).toBe(2);
    expect(r.skipped).toBeUndefined();

    const [e] = await sql<
      { status: string; entry_number: number | null; posted_by: string; description: string }[]
    >`
      select status, entry_number::int as entry_number, posted_by::text as posted_by, description
        from public.journal_entries where id = ${r.entry_id!}`;
    expect(e).toEqual({
      status: "posted",
      entry_number: expect.any(Number) as unknown as number,
      posted_by: SYSTEM_POSTER_ID,
      description: "Reclasificación: cada cuenta de tesorería a su subcuenta contable (ADR-0070)",
    });

    // El mismo rastro que el posteo manual: journal.posted en auditoría y en el outbox.
    const [a] = await sql<{ actor_type: string; entry_number: number }[]>`
      select actor_type, (payload ->> 'entry_number')::int as entry_number
        from public.audit_events
       where aggregate_id = ${r.entry_id!} and event_type = 'journal.posted'`;
    expect(a).toEqual({ actor_type: "system", entry_number: e!.entry_number });
    const [o] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.outbox
       where aggregate_id = ${r.entry_id!} and event_type = 'journal.posted'`;
    expect(o!.n).toBe(1);

    const despues = await sql`select problem from platform.treasury_ledger_gaps(${COMPANY})`;
    expect(despues).toEqual([]);
    const [fam] = await sql<{ is_leaf: boolean; saldo: string }[]>`
      select a.is_leaf, r.balance::text as saldo from public.accounts a
       cross join lateral platform.recompute_ledger(a.company_id, a.id) r
       where a.id = ${FAMILIA}`;
    expect(fam).toEqual({ is_leaf: false, saldo: "0.00000000" });
  });

  it("es idempotente: la segunda llamada no repara nada ni escribe otro asiento", async () => {
    const r = await sql.begin((tx) => repairTreasurySubaccounts(tx, COMPANY));
    expect(r.repaired).toBe(0);
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.journal_entries
       where company_id = ${COMPANY} and description like 'Reclasificación:%'`;
    expect(n!.n).toBe(1);
  });
});

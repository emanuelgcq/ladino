import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";

/**
 * CONFIRMAR UN SOBREGIRO (D-11, H-05; RESPUESTA §2.8 y §3; ADR-0066 nota de la ola 3 §8).
 *
 * Dejar una cuenta en negativo exige las TRES cosas: `allow_negative_balance`, el permiso
 * `treasury.overdraft` en esa empresa y un motivo (`overdraft_reason`). Y deja un acta
 * `treasury.overdraft.confirmed` en la misma transacción: quién, cuenta, importe, saldo
 * resultante y motivo. Antes bastaba con que el cuerpo lo pidiera.
 *
 * Se prueba con el GASTO, que es el egreso más corto; los cuatro egresos (gasto, transferencia,
 * pago a proveedor y reembolso) pasan por el mismo `exigeSaldo`. La transferencia se ejerce
 * también para que no sea solo una afirmación.
 *
 * Los cuatro ojos NO aplican al sobregiro confirmado en el acto (decidido por criterio): la
 * empresa de este fichero tiene dos personas y el dueño sobregira igual.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const TENANT = crypto.randomUUID();
const COMPANY = crypto.randomUUID();
const DUENO = crypto.randomUUID();
const CAJERO = crypto.randomUUID();
const ROL_DUENO = crypto.randomUUID();
const ROL_CAJERO = crypto.randomUUID();
const RUN = Date.now().toString(36);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let CAJA = "";
let BANCO = "";

const tokenDe = (sub: string) =>
  new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);

async function pedir(quien: string, metodo: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(quien)}`,
    "X-Company-Id": COMPANY,
  };
  if (metodo !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(path, {
    method: metodo,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function saldoDe(cuenta: string): Promise<number> {
  const [fila] = await sql<{ saldo: string }[]>`
    select coalesce(b.balance, 0)::text as saldo
      from public.company_accounts ca
      left join public.company_account_balances b on b.account_id = ca.id
     where ca.id = ${cuenta}`;
  return Number(fila!.saldo);
}

async function actasDeSobregiro(): Promise<{ payload: Record<string, unknown> }[]> {
  return sql<{ payload: Record<string, unknown> }[]>`
    select payload from public.audit_events
     where company_id = ${COMPANY} and event_type = 'treasury.overdraft.confirmed'
     order by occurred_at, id`;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}), (${CAJERO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e sobregiro')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-SOB-${RUN}`}, 'Bodega del sobregiro', 'VES',
                     'ordinario')`;
    await declararTipoDeFixture(tx, COMPANY);
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL_DUENO}, null, ${`sob_dueno_${RUN}`}, 'Dueño', false),
             (${ROL_CAJERO}, null, ${`sob_cajero_${RUN}`}, 'Cajero', false)`;
    // El dueño lleva `treasury.overdraft`; el cajero registra gastos y mueve dinero, y nada más.
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL_DUENO}, 'expense.register'), (${ROL_DUENO}, 'expense.read'),
             (${ROL_DUENO}, 'treasury.read'), (${ROL_DUENO}, 'treasury.account.manage'),
             (${ROL_DUENO}, 'treasury.reassign'), (${ROL_DUENO}, 'treasury.overdraft'),
             (${ROL_DUENO}, 'accounting.account.manage'),
             (${ROL_DUENO}, 'accounting.template.manage'), (${ROL_DUENO}, 'accounting.read'),
             (${ROL_CAJERO}, 'expense.register'), (${ROL_CAJERO}, 'treasury.reassign')
             on conflict do nothing`;
    for (const [persona, rol] of [
      [DUENO, ROL_DUENO],
      [CAJERO, ROL_CAJERO],
    ] as const) {
      const mem = crypto.randomUUID();
      await tx`insert into public.memberships (id, tenant_id, user_id)
               values (${mem}, ${TENANT}, ${persona})`;
      await tx`insert into public.user_role_assignments
                 (tenant_id, membership_id, role_id, company_id)
               values (${TENANT}, ${mem}, ${rol}, null)`;
    }
  });
  for (const [ruta, cuerpo] of [
    ["/v1/accounts/import-template", { company_id: COMPANY, template_code: "ve_basico" }],
    ["/v1/journal-templates/import-preset", { company_id: COMPANY, preset_code: "ve_basico" }],
  ] as const) {
    const r = await pedir(DUENO, "POST", ruta, cuerpo);
    if (r.status !== 201) throw new Error(`${ruta}: ${r.status} ${await r.text()}`);
  }
  for (const [name, kind] of [
    [`Caja del local ${RUN}`, "cash"],
    [`Banco ${RUN}`, "bank"],
  ] as const) {
    const r = await pedir(DUENO, "POST", "/v1/treasury/accounts", {
      company_id: COMPANY,
      name,
      currency: "VES",
      kind,
    });
    if (r.status !== 201) throw new Error(`cuenta: ${r.status} ${await r.text()}`);
    const id = ((await r.json()) as { id: string }).id;
    if (kind === "cash") CAJA = id;
    else BANCO = id;
  }
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("D-11 · confirmar un sobregiro exige permiso, motivo y acta", () => {
  const gasto = (extra: Record<string, unknown> = {}) => ({
    company_id: COMPANY,
    category: "Alquiler",
    account_id: CAJA,
    amount: "500.00",
    ...extra,
  });

  it("sin confirmar: 409, y a quien no puede sobregirar no se le propone «regístralo igual» (H-05)", async () => {
    const cajero = await pedir(CAJERO, "POST", "/v1/expenses", gasto());
    expect(cajero.status).toBe(409);
    const e = (await cajero.json()) as { code: string; message: string };
    expect(e.code).toBe("INSUFFICIENT_FUNDS");
    expect(e.message).toMatch(/Elige otra cuenta o pídele a quien administra que lo registre/);
    expect(e.message).not.toMatch(/registrarlo igual|regístralo igual/);

    const dueno = await pedir(DUENO, "POST", "/v1/expenses", gasto());
    expect(dueno.status).toBe(409);
    const d = (await dueno.json()) as { code: string; message: string };
    expect(d.code).toBe("INSUFFICIENT_FUNDS");
    expect(d.message).toMatch(/con su motivo/);
    expect(await saldoDe(CAJA)).toBe(0);
  });

  it("el cajero, sin `treasury.overdraft`, no sobregira aunque lo confirme y dé motivo: 403", async () => {
    const r = await pedir(
      CAJERO,
      "POST",
      "/v1/expenses",
      gasto({ allow_negative_balance: true, overdraft_reason: "El dueño me dijo que sí" }),
    );
    // Antes: 201, y la caja quedaba en −500 sin rastro de quién lo permitió.
    expect(r.status).toBe(403);
    const e = (await r.json()) as { code: string; person_message: string };
    expect(e.code).toBe("PERMISSION_REQUIRED");
    expect(e.person_message).toBe(
      "Esta cuenta no tiene saldo suficiente. Elige otra cuenta o pídele a quien administra que lo registre.",
    );
    expect(await saldoDe(CAJA)).toBe(0);
    expect(await actasDeSobregiro()).toHaveLength(0);
  });

  it("el dueño sin motivo: 422, y con un motivo de relleno también", async () => {
    const sin = await pedir(DUENO, "POST", "/v1/expenses", gasto({ allow_negative_balance: true }));
    expect(sin.status).toBe(422);
    expect(((await sin.json()) as { message: string }).message).toMatch(/motivo/);
    const corto = await pedir(
      DUENO,
      "POST",
      "/v1/expenses",
      gasto({ allow_negative_balance: true, overdraft_reason: "ok" }),
    );
    expect(corto.status).toBe(422);
    expect(await saldoDe(CAJA)).toBe(0);
    expect(await actasDeSobregiro()).toHaveLength(0);
  });

  it("el dueño con motivo: se registra, la caja queda en negativo y el acta dice quién, cuánto y por qué", async () => {
    const r = await pedir(
      DUENO,
      "POST",
      "/v1/expenses",
      gasto({
        allow_negative_balance: true,
        overdraft_reason: "El alquiler vence hoy; el depósito entra mañana",
      }),
    );
    expect(r.status, await r.clone().text()).toBe(201);
    expect(await saldoDe(CAJA)).toBe(-500);
    const actas = await actasDeSobregiro();
    expect(actas).toHaveLength(1);
    const p = actas[0]!.payload;
    expect(p["actor_id"]).toBe(DUENO);
    expect(p["account_id"]).toBe(CAJA);
    expect(Number(p["amount"])).toBe(500);
    expect(Number(p["balance_after"])).toBe(-500);
    expect(p["reason"]).toBe("El alquiler vence hoy; el depósito entra mañana");
    expect(p["operation"]).toBe("expense");
  });

  it("la transferencia pasa por la misma puerta: el cajero 403, el dueño con motivo 201", async () => {
    const cuerpo = {
      company_id: COMPANY,
      from_account_id: BANCO,
      to_account_id: CAJA,
      amount: "100.00",
      reason: "Reponer la caja",
      allow_negative_balance: true,
      overdraft_reason: "El banco acredita el lunes",
    };
    const cajero = await pedir(CAJERO, "POST", "/v1/treasury/transfers", cuerpo);
    expect(cajero.status).toBe(403);
    expect(await saldoDe(BANCO)).toBe(0);
    const dueno = await pedir(DUENO, "POST", "/v1/treasury/transfers", cuerpo);
    expect(dueno.status, await dueno.clone().text()).toBe(201);
    expect(await saldoDe(BANCO)).toBe(-100);
    const actas = await actasDeSobregiro();
    expect(actas).toHaveLength(2);
    expect(actas[1]!.payload["operation"]).toBe("transfer");
  });

  it("con saldo de sobra, `allow_negative_balance` no pide nada: no hay sobregiro que confirmar", async () => {
    // La caja tiene −400 tras la transferencia; se le pone saldo y el cajero gasta sin permiso.
    const fondeo = await pedir(DUENO, "POST", "/v1/treasury/transfers", {
      company_id: COMPANY,
      from_account_id: BANCO,
      to_account_id: CAJA,
      amount: "1000.00",
      reason: "Fondear la caja",
      allow_negative_balance: true,
      overdraft_reason: "Fondeo de prueba contra el banco",
    });
    expect(fondeo.status, await fondeo.clone().text()).toBe(201);
    const antes = (await actasDeSobregiro()).length;
    const r = await pedir(
      CAJERO,
      "POST",
      "/v1/expenses",
      gasto({ amount: "50.00", allow_negative_balance: true }),
    );
    expect(r.status, await r.clone().text()).toBe(201);
    expect(await actasDeSobregiro()).toHaveLength(antes);
  });

  it("EL CRITERIO: tesorería = mayor y cobertura contable, en cero", async () => {
    const [caja] = await sql<{ n: string }[]>`
      select count(*)::text as n from platform.treasury_ledger_gaps(${COMPANY})`;
    expect(caja!.n).toBe("0");
    const [cobertura] = await sql<{ n: string }[]>`
      select count(*)::text as n from platform.accounting_coverage_gaps(${COMPANY})`;
    expect(cobertura!.n).toBe("0");
  });
});

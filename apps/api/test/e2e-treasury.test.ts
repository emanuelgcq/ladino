import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * Tesorería de extremo a extremo (Fase C, migraciones 29–31), como `ladino_api`
 * con JWT real. Lo que este fichero demuestra y ningún test unitario ve:
 *
 *   · el gasto SIN mapeo contable queda EN COLA y el documento existe igual
 *     (ADR-0042) — y con el plan y el preset importados, el siguiente se
 *     asienta SOLO, sin tocar código;
 *   · el saldo materializado baja con el gasto y queda EXACTAMENTE en lo
 *     contado tras un cierre;
 *   · una diferencia sin motivo no se cierra; un cierre exacto no asienta;
 *   · «la tasa sigue igual» crea una fila NUEVA con fuente de confirmación;
 *   · quien solo puede mirar no configura cuentas (403 en servidor).
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";

const TENANT = crypto.randomUUID();
const COMPANY = crypto.randomUUID();
const GESTOR = crypto.randomUUID();
const MIRON = crypto.randomUUID();
const ROL = crypto.randomUUID();
const ROL_MIRON = crypto.randomUUID();
const MEM = crypto.randomUUID();
const MEM_MIRON = crypto.randomUUID();
const ASIG = crypto.randomUUID();
const ASIG_MIRON = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = new Date().toISOString().slice(0, 10);
const FUENTE_TASA = `Carga E2E tesorería ${RUN}`;

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let CAJA = "";
let ZELLE = "";

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

async function saldoDe(cuenta: string): Promise<string> {
  const r = await pedir("GET", "/v1/treasury/accounts", GESTOR);
  const { accounts } = (await r.json()) as { accounts: { id: string; balance: string }[] };
  return accounts.find((a) => a.id === cuenta)?.balance ?? "?";
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${GESTOR}), (${MIRON})
            on conflict (id) do nothing`;
  // El caso «sin tasa no hay gasto en divisa» exige empezar SIN tasas USD→VES,
  // vengan de donde vengan: otras suites, la demo local ('BCV'), confirmaciones.
  // Los ficheros corren en serie (vitest.config.ts), así que barrer aquí no
  // pisa a nadie en pleno vuelo — y la demo se repone con `pnpm demo:seed`,
  // que de todas formas hace falta tras el db:reset del verify.
  await sql`delete from public.exchange_rates
             where from_currency = 'USD' and to_currency = 'VES'`;

  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${GESTOR}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e tesorería')`;
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-TESO-${RUN}`}, 'Empresa e2e tesorería',
                     'VES', 'ordinario')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2eteso_${RUN}`}, 'Gestor tesorería', false),
             (${ROL_MIRON}, null, ${`e2eteso_miron_${RUN}`}, 'Mirón tesorería', false)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'treasury.read'), (${ROL}, 'treasury.account.manage'),
             (${ROL}, 'expense.register'), (${ROL}, 'expense.read'),
             (${ROL}, 'cash.close'), (${ROL}, 'fx.rate.manage'),
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.read'),
             (${ROL_MIRON}, 'treasury.read')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${MEM}, ${TENANT}, ${GESTOR}), (${MEM_MIRON}, ${TENANT}, ${MIRON})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${ASIG}, ${TENANT}, ${MEM}, ${ROL}, null),
             (${ASIG_MIRON}, ${TENANT}, ${MEM_MIRON}, ${ROL_MIRON}, null)`;
  });
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("tesorería de extremo a extremo", () => {
  it("las cuentas se crean y el saldo nace en cero", async () => {
    const caja = await pedir("POST", "/v1/treasury/accounts", GESTOR, {
      company_id: COMPANY,
      name: "Caja Bs",
      currency: "VES",
      kind: "cash",
    });
    expect(caja.status).toBe(201);
    CAJA = ((await caja.json()) as { id: string }).id;

    const zelle = await pedir("POST", "/v1/treasury/accounts", GESTOR, {
      company_id: COMPANY,
      name: "Zelle",
      currency: "USD",
      kind: "wallet",
    });
    expect(zelle.status).toBe(201);
    ZELLE = ((await zelle.json()) as { id: string }).id;

    expect(await saldoDe(CAJA)).toBe("0");
    expect(await saldoDe(ZELLE)).toBe("0");
  });

  it("un nombre repetido es 409, no una segunda caja fantasma", async () => {
    const r = await pedir("POST", "/v1/treasury/accounts", GESTOR, {
      company_id: COMPANY,
      name: "Caja Bs",
      currency: "VES",
      kind: "cash",
    });
    expect(r.status).toBe(409);
  });

  it("quien solo puede mirar, mira — pero no configura", async () => {
    const lee = await pedir("GET", "/v1/treasury/accounts", MIRON);
    expect(lee.status).toBe(200);
    const crea = await pedir("POST", "/v1/treasury/accounts", MIRON, {
      company_id: COMPANY,
      name: "Cuenta del mirón",
      currency: "VES",
      kind: "cash",
    });
    expect(crea.status).toBe(403);
  });

  it("la forma de pago apunta a su cuenta y se edita", async () => {
    const r = await pedir("POST", "/v1/payment-methods", GESTOR, {
      company_id: COMPANY,
      name: "Pago móvil",
      kind: "pago_movil",
      account_id: CAJA,
    });
    expect(r.status).toBe(201);
    const metodo = (await r.json()) as { id: string };
    const patch = await pedir("PATCH", `/v1/payment-methods/${metodo.id}`, GESTOR, {
      company_id: COMPANY,
      name: "Pago móvil Banesco",
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { name: string }).name).toBe("Pago móvil Banesco");
  });

  it("el gasto sin mapeo contable queda EN COLA, y el saldo baja igual", async () => {
    const r = await pedir("POST", "/v1/expenses", GESTOR, {
      company_id: COMPANY,
      category: "Alquiler",
      description: "Alquiler del local",
      account_id: CAJA,
      amount: "250.00000000",
    });
    expect(r.status).toBe(201);
    const g = (await r.json()) as Record<string, unknown>;
    expect(g["accounting"]).toBe("queued");
    expect(g["journal_entry_id"]).toBeNull();
    expect(g["amount"]).toBe("250.00000000");
    expect(g["currency"]).toBe("VES");
    expect(await saldoDe(CAJA)).toBe("-250.00000000");

    // El invariante de ADR-0042: gasto ⇒ asiento O cola. Encolado cuenta.
    const gaps = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.accounting_coverage_gaps(${COMPANY})`;
    expect(gaps[0]!.n).toBe(0);
  });

  it("un gasto en divisa sin tasa cargada se para con EXCHANGE_RATE_MISSING", async () => {
    const r = await pedir("POST", "/v1/expenses", GESTOR, {
      company_id: COMPANY,
      category: "Publicidad",
      account_id: ZELLE,
      amount: "10.00000000",
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("EXCHANGE_RATE_MISSING");
  });

  it("«la tasa sigue igual» crea una fila NUEVA con fuente de confirmación", async () => {
    const sinNada = await pedir("POST", "/v1/exchange-rates/keep", GESTOR, {
      from_currency: "USD",
      to_currency: "VES",
    });
    expect(sinNada.status).toBe(409);

    const carga = await pedir("POST", "/v1/exchange-rates", GESTOR, {
      from_currency: "USD",
      to_currency: "VES",
      rate: "40.00000000",
      source: FUENTE_TASA,
      rate_date: HOY,
    });
    expect(carga.status).toBe(201);

    const keep = await pedir("POST", "/v1/exchange-rates/keep", GESTOR, {
      from_currency: "USD",
      to_currency: "VES",
    });
    expect(keep.status).toBe(201);
    const t = (await keep.json()) as { rate: string; source: string };
    expect(t.rate).toBe("40.00000000");
    expect(t.source.startsWith("sin cambio, confirmada")).toBe(true);

    // Y con tasa, el gasto en divisa sale — convertido a la tasa del día.
    const gasto = await pedir("POST", "/v1/expenses", GESTOR, {
      company_id: COMPANY,
      category: "Publicidad",
      account_id: ZELLE,
      amount: "10.00000000",
    });
    expect(gasto.status).toBe(201);
    const g = (await gasto.json()) as Record<string, string>;
    expect(g["functional_amount"]).toBe("400.00000000");
    expect(g["functional_currency"]).toBe("VES");
    expect(await saldoDe(ZELLE)).toBe("-10.00000000");
  });

  it("cerrar con diferencia y sin motivo no pasa; con motivo, el saldo queda en lo contado", async () => {
    const mudo = await pedir("POST", "/v1/cash-closings", GESTOR, {
      company_id: COMPANY,
      account_id: CAJA,
      counted_amount: "0.00000000",
    });
    expect(mudo.status).toBe(422);

    const r = await pedir("POST", "/v1/cash-closings", GESTOR, {
      company_id: COMPANY,
      account_id: CAJA,
      counted_amount: "0.00000000",
      reason: "el alquiler se pagó de la caja antes de existir la cuenta",
    });
    expect(r.status).toBe(201);
    const c = (await r.json()) as Record<string, unknown>;
    expect(c["expected_amount"]).toBe("-250.00000000");
    expect(c["counted_amount"]).toBe("0.00000000");
    expect(c["difference"]).toBe("250.00000000");
    expect(c["accounting"]).toBe("queued");
    expect(await saldoDe(CAJA)).toBe("0.00000000");
  });

  it("un cierre exacto ni exige motivo ni asienta: cuadrar no es un movimiento", async () => {
    const r = await pedir("POST", "/v1/cash-closings", GESTOR, {
      company_id: COMPANY,
      account_id: CAJA,
      counted_amount: "0.00000000",
    });
    expect(r.status).toBe(201);
    const c = (await r.json()) as Record<string, unknown>;
    expect(c["difference"]).toBe("0.00000000");
    expect(c["accounting"]).toBe("none");
    expect(c["journal_entry_id"]).toBeNull();
    expect(await saldoDe(CAJA)).toBe("0.00000000");
  });

  it("con el plan y el preset importados, el gasto se asienta SOLO", async () => {
    const plan = await pedir("POST", "/v1/accounts/import-template", GESTOR, {
      company_id: COMPANY,
      template_code: "ve_basico",
    });
    expect(plan.status).toBe(201);
    const preset = await pedir("POST", "/v1/journal-templates/import-preset", GESTOR, {
      company_id: COMPANY,
      preset_code: "ve_basico",
    });
    expect(preset.status).toBe(201);

    const r = await pedir("POST", "/v1/expenses", GESTOR, {
      company_id: COMPANY,
      category: "Luz",
      account_id: CAJA,
      amount: "100.00000000",
    });
    expect(r.status).toBe(201);
    const g = (await r.json()) as Record<string, unknown>;
    expect(g["accounting"]).toBe("posted");
    expect(g["journal_entry_id"]).not.toBeNull();
    expect(await saldoDe(CAJA)).toBe("-100.00000000");
  });

  it("y el cierre con diferencia también: sobrante contra faltantes y sobrantes de caja", async () => {
    const r = await pedir("POST", "/v1/cash-closings", GESTOR, {
      company_id: COMPANY,
      account_id: CAJA,
      counted_amount: "0.00000000",
      reason: "la luz salió del bolsillo del dueño, no de la caja",
    });
    expect(r.status).toBe(201);
    const c = (await r.json()) as Record<string, unknown>;
    expect(c["difference"]).toBe("100.00000000");
    expect(c["accounting"]).toBe("posted");
    expect(c["journal_entry_id"]).not.toBeNull();
  });

  it("el resumen del negocio: cifras del servidor, coherentes con lo que pasó", async () => {
    const r = await pedir("GET", "/v1/negocio/resumen", GESTOR);
    expect(r.status).toBe(200);
    const res = (await r.json()) as {
      functional_currency: string;
      mi_dinero: { currency: string; balance: string }[];
      lo_que_me_deben: string;
      lo_que_debo: string;
      tasa_del_dia: { rate: string; source: string } | null;
      vendido_hoy: string;
    };
    expect(res.functional_currency).toBe("VES");
    // Caja quedó en 0 tras el último cierre; Zelle en −10 por el gasto en USD.
    const porMoneda = new Map(res.mi_dinero.map((m) => [m.currency, m.balance]));
    expect(porMoneda.get("VES")).toBe("0.00000000");
    expect(porMoneda.get("USD")).toBe("-10.00000000");
    // Sin ventas ni compras en esta empresa: deudas en cero, no en null.
    expect(res.lo_que_me_deben).toBe("0");
    expect(res.lo_que_debo).toBe("0");
    expect(res.tasa_del_dia).not.toBeNull();
    expect(res.tasa_del_dia!.rate).toBe("40.00000000");

    const sinPermiso = await pedir("GET", "/v1/negocio/resumen", MIRON);
    // El mirón SÍ tiene treasury.read en esta fixture: también ve el resumen.
    expect(sinPermiso.status).toBe(200);
  });

  it("los listados responden y la conciliación cuadra al final", async () => {
    const gastos = await pedir("GET", "/v1/expenses", GESTOR);
    expect(gastos.status).toBe(200);
    const lg = (await gastos.json()) as { items: unknown[]; total: number };
    expect(lg.total).toBe(3);

    const cierres = await pedir("GET", "/v1/cash-closings", GESTOR);
    expect(cierres.status).toBe(200);
    const lc = (await cierres.json()) as { items: unknown[]; total: number };
    expect(lc.total).toBe(3);

    // materializado == recomputado, y cobertura sin huecos: los DOS invariantes
    // cruzados, al cierre del fichero y con todos los hechos dentro.
    const recon = await sql<{ ok: boolean }[]>`
      select ok from platform.treasury_reconciliation(${COMPANY})`;
    expect(recon.length).toBeGreaterThan(0);
    expect(recon.every((r) => r.ok)).toBe(true);
    const gaps = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.accounting_coverage_gaps(${COMPANY})`;
    expect(gaps[0]!.n).toBe(0);
  });
});

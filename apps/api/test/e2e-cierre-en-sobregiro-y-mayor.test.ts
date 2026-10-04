import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";

/**
 * J-02 · EL SOBREGIRO QUE SE CUBRE AL CERRAR ES DINERO DEL DUEÑO, NO UNA GANANCIA.
 * K-07 · EL SALDO INICIAL DEL MAYOR ES LO ACUMULADO ANTES DEL RANGO.
 *
 * J-02 (RESPUESTA del 2026-09-28): una caja en negativo que se cuenta en cero (o más) no tuvo un
 * «sobrante»: alguien pagó de su bolsillo. La parte que lleva la caja de negativo a cero va a
 * «Cuentas por pagar a socios (aportes del dueño)» (papel `owner_payable`, pasivo); lo que se
 * cuente POR ENCIMA de cero sigue siendo sobrante (5.1.06). Sin sobregiro, el cierre asienta
 * igual que siempre. Cada aserción mira lo que SOLO produce esa rama: la cuenta de la línea.
 *
 * K-07: sin «desde», el inicial era igual al final (y `running_balance` contaba doble). El
 * invariante se asevera en tres rangos, con fechas `date` contra `date` (día de Caracas):
 * inicial + Σ(debe − haber) = final, y el último `running_balance` = final.
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
const ROL = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const AYER = diaCaracas(-1);
const MANANA = diaCaracas(1);
// El evento es el del outbox, el mismo en los dos casos; el hecho contable va en el ORIGEN
// (migración 20261004180200), como `purchase_revaluation / ap.invoice_posted`.
const EVENTO = "treasury.cash_register.closed";
const ORIGEN_SOBREGIRO = "cash_closing_overdraft";
const ORIGEN_DE_SIEMPRE = "cash_closing";

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let CAJA = "";
let SUB_CAJA = "";
let DEL_DUENO = "";
let FALTANTES_SOBRANTES = "";

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

type Linea = { account_id: string; lado: "debe" | "haber"; importe: string };

/** El asiento VIGENTE de un cierre: origen, evento y líneas (cuenta, lado e importe al céntimo). */
async function asientoDe(
  cierreId: string,
): Promise<{ origen: string; evento: string; lineas: Linea[] }> {
  const filas = await sql<(Linea & { origen: string; evento: string })[]>`
    select e.source_kind as origen, e.source_event as evento, l.account_id,
           case when l.functional_debit > 0 then 'debe' else 'haber' end as lado,
           (l.functional_debit + l.functional_credit)::numeric(24,2)::text as importe
      from public.journal_entries e
      join public.journal_lines l on l.entry_id = e.id
     where e.company_id = ${COMPANY}
       and e.source_kind in ('cash_closing', 'cash_closing_overdraft')
       and e.source_id = ${cierreId} and e.status = 'posted'
     order by l.line_number`;
  return {
    origen: filas[0]?.origen ?? "",
    evento: filas[0]?.evento ?? "",
    lineas: filas.map(({ account_id, lado, importe }) => ({ account_id, lado, importe })),
  };
}

async function gastar(importe: string, cuando?: string): Promise<void> {
  const r = await pedir("POST", "/v1/expenses", {
    company_id: COMPANY,
    category: "Café",
    account_id: CAJA,
    amount: importe,
    ...(cuando === undefined ? {} : { paid_at: cuando }),
    allow_negative_balance: true,
    overdraft_reason: "Fixture E2E: el pago del café salió del bolsillo de la dueña",
  });
  expect(r.status).toBe(201);
  expect(((await r.json()) as { accounting: string }).accounting).toBe("posted");
}

async function cerrar(
  contado: string,
): Promise<{ id: string; difference: string; owner_contribution: string | null }> {
  const r = await pedir("POST", "/v1/cash-closings", {
    company_id: COMPANY,
    account_id: CAJA,
    counted_amount: contado,
    reason: "el pago del café salió de mi bolsillo",
  });
  expect(r.status).toBe(201);
  const c = (await r.json()) as {
    id: string;
    accounting: string;
    difference: string;
    owner_contribution: string | null;
  };
  expect(c.accounting).toBe("posted");
  return c;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e sobregiro al cierre')`;
    // La empresa empezó hace un mes: el gasto fechado AYER se asienta ayer (K-04: antes del
    // inicio de actividades iría al día de hoy, y el mayor no tendría un «antes»).
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code,
                                           activity_start_date)
             values (${COMPANY}, ${TENANT}, ${`J-SOBC-${RUN}`}, 'Bodega sobregiro al cierre', 'VES',
                     'ordinario', ${diaCaracas(-31)}::date)`;
    await declararTipoDeFixture(tx, COMPANY);
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2esobc_${RUN}`}, 'Dueño', false)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'treasury.overdraft'), (${ROL}, 'expense.register'),
             (${ROL}, 'expense.read'), (${ROL}, 'cash.close'), (${ROL}, 'treasury.read'),
             (${ROL}, 'treasury.account.manage'), (${ROL}, 'accounting.account.manage'),
             (${ROL}, 'accounting.template.manage'), (${ROL}, 'accounting.entry.post'),
             (${ROL}, 'accounting.read')
             on conflict do nothing`;
    const mem = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${mem}, ${TENANT}, ${DUENO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${crypto.randomUUID()}, ${TENANT}, ${mem}, ${ROL}, null)`;
    // La caja en dólares necesita la tasa del día, que es global y compartida: se siembra solo
    // si falta, bajo su candado. Las aserciones leen la tasa que el cierre USÓ, no esta.
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40.123456, ${HOY}::date, now(), 'e2e-sobregiro-al-cierre'
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
  // El plan se importó hoy y sus papeles rigen desde hoy: para que un gasto de AYER se asiente
  // ayer, el fixture los pone a regir desde siempre (como en una empresa con un mes de vida).
  await sql`update public.company_account_settings set effective_from = '-infinity'
             where company_id = ${COMPANY}`;
  const caja = await pedir("POST", "/v1/treasury/accounts", {
    company_id: COMPANY,
    name: `Caja Bs ${RUN}`,
    currency: "VES",
    kind: "cash",
  });
  expect(caja.status).toBe(201);
  const c = (await caja.json()) as { id: string; ledger_account_id: string };
  CAJA = c.id;
  SUB_CAJA = c.ledger_account_id;
  const papeles = await sql<{ purpose: string; account_id: string }[]>`
    select purpose, account_id from public.company_account_settings
     where company_id = ${COMPANY} and purpose in ('owner_payable', 'cash_over_short')
       and effective_to is null`;
  DEL_DUENO = papeles.find((p) => p.purpose === "owner_payable")?.account_id ?? "";
  FALTANTES_SOBRANTES = papeles.find((p) => p.purpose === "cash_over_short")?.account_id ?? "";
  // Importar plan y preset son cientos de inserciones: con la base local compartida pasa de 10 s.
}, 60_000);

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("J-02 · cerrar una caja en sobregiro", () => {
  it("el plan ve_basico trae la cuenta del dueño: pasivo, acreedora, con su papel", async () => {
    const [cuenta] = await sql<{ kind: string; nature: string }[]>`
      select kind, nature from public.accounts where id = ${DEL_DUENO || null}`;
    expect(cuenta).toEqual({ kind: "pasivo", nature: "acreedora" });
    expect(FALTANTES_SOBRANTES).not.toBe("");
  });

  it("caja en −120 contada en 0: los 120 son del dueño (pasivo), no un sobrante", async () => {
    await gastar("120.00000000", `${AYER}T12:00:00-04:00`);
    const c = await cerrar("0.00000000");
    expect(c.difference).toBe("120.00");
    // Lo que la pantalla dice sin restar nada: lo que puso el dueño lo da el servidor.
    expect(c.owner_contribution).toBe("120.00");
    const a = await asientoDe(c.id);
    expect(a.origen).toBe(ORIGEN_SOBREGIRO);
    expect(a.evento).toBe(EVENTO);
    expect(a.lineas).toEqual([
      { account_id: SUB_CAJA, lado: "debe", importe: "120.00" },
      { account_id: DEL_DUENO, lado: "haber", importe: "120.00" },
    ]);
  });

  it("caja en −80 contada en 30: 80 del dueño y 30 de sobrante, en un solo asiento", async () => {
    await gastar("80.00000000");
    const c = await cerrar("30.00000000");
    expect(c.difference).toBe("110.00");
    expect(c.owner_contribution).toBe("80.00");
    const a = await asientoDe(c.id);
    expect(a.origen).toBe(ORIGEN_SOBREGIRO);
    expect(a.evento).toBe(EVENTO);
    expect(a.lineas).toEqual([
      { account_id: SUB_CAJA, lado: "debe", importe: "110.00" },
      { account_id: DEL_DUENO, lado: "haber", importe: "80.00" },
      { account_id: FALTANTES_SOBRANTES, lado: "haber", importe: "30.00" },
    ]);
  });

  it("sin sobregiro, el sobrante se asienta como siempre (30 → 45)", async () => {
    const c = await cerrar("45.00000000");
    expect(c.owner_contribution).toBeNull();
    const a = await asientoDe(c.id);
    expect(a.origen).toBe(ORIGEN_DE_SIEMPRE);
    expect(a.evento).toBe(EVENTO);
    expect(a.lineas).toEqual([
      { account_id: SUB_CAJA, lado: "debe", importe: "15.00" },
      { account_id: FALTANTES_SOBRANTES, lado: "haber", importe: "15.00" },
    ]);
  });

  it("y el faltante también (45 → 40)", async () => {
    const c = await cerrar("40.00000000");
    const a = await asientoDe(c.id);
    expect(a.origen).toBe(ORIGEN_DE_SIEMPRE);
    expect(a.evento).toBe(EVENTO);
    expect(a.lineas).toEqual([
      { account_id: FALTANTES_SOBRANTES, lado: "debe", importe: "5.00" },
      { account_id: SUB_CAJA, lado: "haber", importe: "5.00" },
    ]);
  });

  it("caja en USD en −10 contada en 0: la línea de la caja lleva sus dólares (ADR-0075 §6)", async () => {
    const usd = await pedir("POST", "/v1/treasury/accounts", {
      company_id: COMPANY,
      name: `Caja USD ${RUN}`,
      currency: "USD",
      kind: "cash",
    });
    expect(usd.status).toBe(201);
    const cajaUsd = (await usd.json()) as { id: string; ledger_account_id: string };
    const gasto = await pedir("POST", "/v1/expenses", {
      company_id: COMPANY,
      category: "Café",
      account_id: cajaUsd.id,
      amount: "10.00000000",
      allow_negative_balance: true,
      overdraft_reason: "Fixture E2E: el pago del café salió del bolsillo de la dueña",
    });
    expect(gasto.status).toBe(201);
    const r = await pedir("POST", "/v1/cash-closings", {
      company_id: COMPANY,
      account_id: cajaUsd.id,
      counted_amount: "0.00000000",
      reason: "el pago del café salió de mi bolsillo",
    });
    expect(r.status).toBe(201);
    const c = (await r.json()) as {
      id: string;
      accounting: string;
      difference: string;
      owner_contribution: string | null;
    };
    expect(c).toMatchObject({ accounting: "posted", difference: "10.00" });
    // Lo que puso el dueño, en la moneda de la caja: dólares.
    expect(c.owner_contribution).toBe("10.00");
    // En bolívares, a la tasa que el cierre usó: round(10 × tasa, 2). A 40,123456 son 401,23
    // (401,23 = 401,23 del dueño + 0 de sobrante; la aritmética la fija el unitario del dominio).
    const lineas = await sql<
      { account_id: string; lado: string; importe: string; moneda: string; original: string }[]
    >`
      select l.account_id, case when l.functional_debit > 0 then 'debe' else 'haber' end as lado,
             (l.functional_debit + l.functional_credit)::numeric(24,2)::text as importe,
             l.transaction_currency as moneda,
             l.amount_transaction_currency::numeric(24,2)::text as original
        from public.journal_entries e join public.journal_lines l on l.entry_id = e.id
       where e.company_id = ${COMPANY} and e.source_kind = ${ORIGEN_SOBREGIRO}
         and e.source_id = ${c.id} and e.status = 'posted'
       order by l.line_number`;
    const [f] = await sql<{ bs: string }[]>`
      select round(10 * k.fx_rate, 2)::numeric(24,2)::text as bs
        from public.cash_closings k where k.id = ${c.id}`;
    expect(lineas).toEqual([
      {
        account_id: cajaUsd.ledger_account_id,
        lado: "debe",
        importe: f!.bs,
        moneda: "USD",
        original: "10.00",
      },
      { account_id: DEL_DUENO, lado: "haber", importe: f!.bs, moneda: "VES", original: f!.bs },
    ]);
  });

  it("un cierre viejo o sin sobregiro no dice «lo puso el dueño»: la lista lo saca del asiento", async () => {
    const r = await pedir("GET", "/v1/cash-closings");
    expect(r.status).toBe(200);
    const { items } = (await r.json()) as {
      items: { expected_amount: string; owner_contribution: string | null }[];
    };
    // Cinco cierres: tres en sobregiro (−120, −80 y USD −10) y dos sin él.
    expect(
      items
        .map((i) => [i.expected_amount, i.owner_contribution])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual(
      [
        ["-120.00", "120.00"],
        ["-80.00", "80.00"],
        ["-10.00", "10.00"],
        ["30.00", null],
        ["45.00", null],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  });

  it("los invariantes que cruzan tesorería y contabilidad siguen en cero", async () => {
    const [n] = await sql<Record<string, number>[]>`
      select (select count(*)::int from platform.treasury_ledger_gaps(${COMPANY})) as tesoreria,
             (select count(*)::int from platform.treasury_currency_gaps(${COMPANY})) as divisa,
             (select count(*)::int from platform.overdraft_closing_gaps(${COMPANY})) as sobregiro,
             (select count(*)::int from platform.accounting_coverage_gaps(${COMPANY})) as cobertura,
             (select count(*)::int from platform.cent_gaps(${COMPANY})) as centimo`;
    expect(n).toEqual({ tesoreria: 0, divisa: 0, sobregiro: 0, cobertura: 0, centimo: 0 });
    const [b] = await sql<{ debe: string; haber: string }[]>`
      select coalesce(sum(period_debit), 0)::text as debe,
             coalesce(sum(period_credit), 0)::text as haber
        from platform.trial_balance(${COMPANY}, ${HOY}::date)`;
    expect(b!.debe).toBe(b!.haber);
  });
});

type Mayor = {
  opening_balance: string;
  closing_balance: string;
  movements: { debit: string; credit: string; running_balance: string; posting_date: string }[];
};

async function mayor(rango: string): Promise<Mayor> {
  const r = await pedir("GET", `/v1/ledger?account=${SUB_CAJA}&${rango}`);
  expect(r.status).toBe(200);
  return (await r.json()) as Mayor;
}

/** inicial + Σ(debe − haber), con la aritmética de Postgres: ningún `number` toca el dinero. */
async function inicialMasMovimientos(m: Mayor): Promise<string> {
  const [s] = await sql<{ total: string }[]>`
    select (${m.opening_balance}::numeric
            + coalesce((select sum((x->>'debit')::numeric - (x->>'credit')::numeric)
                          from jsonb_array_elements(${sql.json(m.movements)}::jsonb) x), 0))::text
           as total`;
  return s!.total;
}

const igual = async (a: string, b: string): Promise<boolean> =>
  (await sql<{ ok: boolean }[]>`select ${a}::numeric = ${b}::numeric as ok`)[0]!.ok;

describe("K-07 · el mayor: saldo inicial + movimientos = saldo final", () => {
  // La subcuenta de la caja: −120 ayer; hoy +120, −80, +110, +15, −5. Saldo final: 40.
  it("sin «desde»: el inicial es CERO, no el final, y el acumulado termina en el final", async () => {
    const m = await mayor(`to=${HOY}`);
    expect(m.movements.length).toBe(6);
    expect(await igual(m.closing_balance, "40")).toBe(true);
    expect(await igual(m.opening_balance, "0")).toBe(true);
    expect(await igual(await inicialMasMovimientos(m), m.closing_balance)).toBe(true);
    expect(await igual(m.movements.at(-1)!.running_balance, m.closing_balance)).toBe(true);
  });

  it("con «desde» hoy: el inicial es lo acumulado hasta AYER (−120), día contra día", async () => {
    const m = await mayor(`from=${HOY}&to=${HOY}`);
    expect(m.movements.length).toBe(5);
    expect(m.movements.every((x) => x.posting_date === HOY)).toBe(true);
    expect(await igual(m.opening_balance, "-120")).toBe(true);
    expect(await igual(await inicialMasMovimientos(m), m.closing_balance)).toBe(true);
    expect(await igual(m.movements.at(-1)!.running_balance, m.closing_balance)).toBe(true);
  });

  it("con «desde» ayer: el movimiento de ayer entra en el rango y el inicial es cero", async () => {
    const m = await mayor(`from=${AYER}&to=${AYER}`);
    expect(m.movements.length).toBe(1);
    expect(await igual(m.opening_balance, "0")).toBe(true);
    expect(await igual(m.closing_balance, "-120")).toBe(true);
    expect(await igual(await inicialMasMovimientos(m), m.closing_balance)).toBe(true);
  });

  it("con «desde» mañana: sin movimientos, inicial = final = todo lo anterior", async () => {
    const m = await mayor(`from=${MANANA}&to=${MANANA}`);
    expect(m.movements).toEqual([]);
    expect(await igual(m.opening_balance, "40")).toBe(true);
    expect(await igual(m.closing_balance, "40")).toBe(true);
  });
});

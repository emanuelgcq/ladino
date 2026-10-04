import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { sembrarTasaOficial, borrarTasasOficiales } from "./_tasa-oficial.js";
import { diaCaracas } from "./_dia-caracas.js";

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
const CERRADOR = crypto.randomUUID();
const CAJERA = crypto.randomUUID();
const ROL_CAJERA = crypto.randomUUID();
const MEM_CAJERA = crypto.randomUUID();
const ASIG_CAJERA = crypto.randomUUID();
const ROL_CERRADOR = crypto.randomUUID();
const MEM_CERRADOR = crypto.randomUUID();
const ASIG_CERRADOR = crypto.randomUUID();
const MEM = crypto.randomUUID();
const MEM_MIRON = crypto.randomUUID();
const ASIG = crypto.randomUUID();
const ASIG_MIRON = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const FUENTE_TASA = `Carga E2E tesorería ${RUN}`;

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let CAJA = "";
let ZELLE = "";
let BANESCO = "";
let MERCANTIL = "";

/** Lo que devuelve `/v1/treasury/accounts/candidates` por instrumento (ADR-0067 §1). */
interface Candidatas {
  instrument: string;
  currency: string;
  accounts: { id: string; name: string; currency: string; kind: string }[];
  fixed_by_method: string | null;
}

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

/** El saldo TAL COMO LO SIRVE la API: en céntimos de su moneda (ADR-0063 §4). */
async function saldoDe(cuenta: string): Promise<string> {
  const r = await pedir("GET", "/v1/treasury/accounts", GESTOR);
  const { accounts } = (await r.json()) as { accounts: { id: string; balance: string }[] };
  return accounts.find((a) => a.id === cuenta)?.balance ?? "?";
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${GESTOR}), (${MIRON}), (${CERRADOR}), (${CAJERA})
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
             (${ROL_MIRON}, null, ${`e2eteso_miron_${RUN}`}, 'Mirón tesorería', false),
             (${ROL_CERRADOR}, null, ${`e2eteso_cierre_${RUN}`}, 'Cerrador', false),
             (${ROL_CAJERA}, null, ${`e2eteso_cajera_${RUN}`}, 'Cajera', false)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'treasury.overdraft'),
             (${ROL}, 'treasury.read'), (${ROL}, 'treasury.account.manage'),
             (${ROL}, 'expense.register'), (${ROL}, 'expense.read'),
             (${ROL}, 'cash.close'), (${ROL}, 'fx.rate.manage'),
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.read'),
             (${ROL_MIRON}, 'treasury.read'),
             (${ROL_CERRADOR}, 'cash.close'),
             (${ROL_CAJERA}, 'sales.payment.register')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${MEM}, ${TENANT}, ${GESTOR}), (${MEM_MIRON}, ${TENANT}, ${MIRON}),
             (${MEM_CERRADOR}, ${TENANT}, ${CERRADOR}),
             (${MEM_CAJERA}, ${TENANT}, ${CAJERA})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${ASIG}, ${TENANT}, ${MEM}, ${ROL}, null),
             (${ASIG_MIRON}, ${TENANT}, ${MEM_MIRON}, ${ROL_MIRON}, null),
             (${ASIG_CERRADOR}, ${TENANT}, ${MEM_CERRADOR}, ${ROL_CERRADOR}, null),
             (${ASIG_CAJERA}, ${TENANT}, ${MEM_CAJERA}, ${ROL_CAJERA}, null)`;
  });
});

afterAll(async () => {
  if (sql !== undefined) await borrarTasasOficiales(sql, FUENTE_TASA);
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

    expect(await saldoDe(CAJA)).toBe("0.00");
    expect(await saldoDe(ZELLE)).toBe("0.00");
  });

  it("con SOLO cash.close se ve LA CAJA y nada más: el banco y el Zelle no son suyos de ver (ADR-0048)", async () => {
    const r = await pedir("GET", "/v1/treasury/accounts", CERRADOR);
    expect(r.status).toBe(200);
    const { accounts } = (await r.json()) as {
      accounts: { id: string; kind: string; is_system: boolean }[];
    };
    // Solo efectivo no de sistema: la caja que va a contar, sin la foto del dinero.
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts.every((a) => a.kind === "cash" && !a.is_system)).toBe(true);
    expect(accounts.some((a) => a.id === ZELLE)).toBe(false);
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
    const cuerpo = {
      company_id: COMPANY,
      category: "Alquiler",
      description: "Alquiler del local",
      account_id: CAJA,
      amount: "250.00000000",
    };
    // La caja está en cero: sin confirmar, el gasto no pasa (ADR-0062 §4).
    const sinConfirmar = await pedir("POST", "/v1/expenses", GESTOR, cuerpo);
    expect(sinConfirmar.status).toBe(409);
    expect(((await sinConfirmar.json()) as { code: string }).code).toBe("INSUFFICIENT_FUNDS");

    const r = await pedir("POST", "/v1/expenses", GESTOR, {
      ...cuerpo,
      allow_negative_balance: true,
      overdraft_reason: "Fixture E2E: se confirma el sobregiro con su motivo",
    });
    expect(r.status).toBe(201);
    const g = (await r.json()) as Record<string, unknown>;
    expect(g["accounting"]).toBe("queued");
    expect(g["journal_entry_id"]).toBeNull();
    expect(g["amount"]).toBe("250.00000000");
    expect(g["currency"]).toBe("VES");
    expect(await saldoDe(CAJA)).toBe("-250.00");

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
    // El Zelle también está en cero, y aun así el motivo es la TASA: sin ella el gasto no se
    // puede ni valorar, y decir «no alcanza» taparía el motivo real (ADR-0062 §4).
    expect(((await r.json()) as { code: string }).code).toBe("EXCHANGE_RATE_MISSING");
  });

  // Ola 4. `platform.supplier_debt_today` LANZABA (LAD51) sin tasa, y un error de Postgres
  // condena la transacción: una sola factura de proveedor en dólares sin tasa del día tumbaba el
  // resumen ENTERO. Desde 20261004200000 ya NO lanza: devuelve NULL para lo que se debe y no se
  // puede valorar hoy, y 0 para lo que no se debe. El resumen mira ese NULL (no lo tapa con
  // `greatest(x, 0)`) y es la FUNCIÓN quien decide si falta la tasa.
  //
  // El par SIN tasa es VES→USD: la tabla de tasas es global y otros E2E siembran USD→VES en
  // paralelo, así que «no hay tasa USD→VES» no se puede sostener aquí; VES→USD no lo siembra
  // nadie (solo existe la oficial, USD→VES: ADR-0064). La fila del montaje es por eso una factura
  // en VES con moneda funcional USD: artificial, y ejerce el mismo camino —la moneda de la factura
  // no tiene tasa hacia su funcional— sin tocar las tasas de nadie.
  it("ola 4 · una factura de proveedor en divisa SIN tasa no tumba el resumen: 200, `lo_que_debo` null con `sin_tasa` y su nominal", async () => {
    const [tasas] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.exchange_rates
       where from_currency = 'VES' and to_currency = 'USD'`;
    expect(tasas!.n, "alguien sembró una tasa VES→USD: este caso ya no demuestra nada").toBe(0);
    const proveedor = crypto.randomUUID();
    const factura = crypto.randomUUID();
    const saldada = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${GESTOR}, true)`;
      await tx`insert into public.suppliers
                 (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code,
                  taxpayer_type_code)
               values (${proveedor}, ${TENANT}, ${COMPANY},
                       ${`J${String(Date.now()).slice(-9)}`}, 'Proveedor en dólares sin tasa',
                       'nacional', 'juridica', 'ordinario')`;
      // 100 + 16 de IVA = 116,00 en la moneda de la factura, con su tasa de entonces congelada.
      await tx`insert into public.supplier_invoices
                 (id, tenant_id, company_id, supplier_id, supplier_document_number,
                  supplier_control_number, invoice_date, status, posted_at, subtotal_amount,
                  tax_amount, total_amount, tax_is_recoverable, transaction_currency,
                  functional_currency, fx_rate, amount_transaction_currency, functional_amount)
               values (${factura}, ${TENANT}, ${COMPANY}, ${proveedor}, ${`FP-${RUN}`},
                       ${`CT-${RUN}`}, ${HOY}::date, 'posted', now(), 100, 16, 116, true, 'VES',
                       'USD', 0.025, 116, 2.9)`;
    });
    type Debo = {
      lo_que_debo: string | null;
      lo_que_debo_motivo: string | null;
      lo_que_debo_por_moneda: { currency: string; nominal: string }[];
    };
    let visto: Response;
    let sinApRead: Response;
    let conLaPagada: Response;
    try {
      // Sin ap.read el motivo es el permiso, no la tasa: la factura ni se mira.
      sinApRead = await pedir("GET", "/v1/negocio/resumen", MIRON);
      await sql`insert into public.role_permissions (role_id, permission_key)
                values (${ROL_MIRON}, 'ap.read')`;
      visto = await pedir("GET", "/v1/negocio/resumen", MIRON);
      // LA FUNCIÓN DECIDE, no una pre-comprobación. Se retira la factura que se debe y queda
      // OTRA en la misma divisa sin tasa, `posted` y con saldo CERO (lo retenido la cubre
      // entera: 2,90 ÷ 0,025 = 116,00). No se le debe nada: no hace falta tasa para decirlo, y
      // el resumen NO dice `sin_tasa`.
      await sql.begin(async (tx) => {
        await tx`select set_config('ladino.actor_id', ${GESTOR}, true)`;
        await tx`update public.supplier_invoices set status = 'annulled' where id = ${factura}`;
        await tx`insert into public.supplier_invoices
                   (id, tenant_id, company_id, supplier_id, supplier_document_number,
                    supplier_control_number, invoice_date, status, posted_at, subtotal_amount,
                    tax_amount, total_amount, tax_is_recoverable, transaction_currency,
                    functional_currency, fx_rate, amount_transaction_currency, functional_amount,
                    retention_total)
                 values (${saldada}, ${TENANT}, ${COMPANY}, ${proveedor}, ${`FS-${RUN}`},
                         ${`CS-${RUN}`}, ${HOY}::date, 'posted', now(), 100, 16, 116, true,
                         'VES', 'USD', 0.025, 116, 2.9, 2.9)`;
      });
      const [saldo] = await sql<{ s: string; estado: string; hoy: string | null }[]>`
        select platform.supplier_invoice_balance(${COMPANY}, ${saldada})::numeric(24,8)::text as s,
               (select status from public.supplier_invoices where id = ${saldada}) as estado,
               platform.supplier_debt_today(${COMPANY}, ${saldada})::numeric(24,8)::text as hoy`;
      expect({ ...saldo }).toEqual({ s: "0.00000000", estado: "posted", hoy: "0.00000000" });
      conLaPagada = await pedir("GET", "/v1/negocio/resumen", MIRON);
    } finally {
      await sql`delete from public.role_permissions
                 where role_id = ${ROL_MIRON} and permission_key = 'ap.read'`;
      // La factura del montaje se retira como se retira una factura: anulada.
      await sql.begin(async (tx) => {
        await tx`select set_config('ladino.actor_id', ${GESTOR}, true)`;
        await tx`update public.supplier_invoices
                    set status = 'annulled'
                  where id in (${factura}, ${saldada}) and status <> 'annulled'`;
      });
    }
    expect(sinApRead.status).toBe(200);
    expect((await sinApRead.json()) as Debo).toMatchObject({
      lo_que_debo: null,
      lo_que_debo_motivo: "sin_permiso",
      lo_que_debo_por_moneda: [],
    });
    expect(visto.status, await visto.clone().text()).toBe(200);
    expect((await visto.json()) as Debo).toMatchObject({
      lo_que_debo: null,
      lo_que_debo_motivo: "sin_tasa",
      lo_que_debo_por_moneda: [{ currency: "VES", nominal: "116.00" }],
    });
    // Pagada (saldo 0) y sin tasa: una cifra, sin motivo. Antes la pre-comprobación decía
    // `sin_tasa` por el mero hecho de existir una factura `posted` en divisa.
    expect(conLaPagada.status, await conLaPagada.clone().text()).toBe(200);
    const pagada = (await conLaPagada.json()) as Debo;
    expect([pagada.lo_que_debo_motivo, pagada.lo_que_debo_por_moneda]).toEqual([null, []]);
    expect(pagada.lo_que_debo).toMatch(/^\d+\.\d{2}$/);
  });

  // Revisión de la ola 4 (B3). Una factura en divisa con saldo NEGATIVO (se le retuvo o se le
  // pagó de más) y sin tasa: `supplier_debt_today` da NULL —no se puede valorar hoy—. El estado
  // de cuenta respondía total NULL y `sin_tasa` con el nominal VACÍO («falta la tasa», sin deber
  // nada), y en la MISMA respuesta la antigüedad (`ap_aging`) no la contaba y daba su total.
  // `sin_tasa` quiere decir «hay DEUDA en divisa y no se puede valorar» (el contrato lo dice así):
  // las dos lecturas preguntan lo mismo, y solo lo que se debe pide tasa.
  it("ola 4 · el estado de cuenta de un proveedor con una factura en divisa de saldo NEGATIVO y sin tasa NO dice `sin_tasa` —no se debe nada—, como la antigüedad; con otra que SÍ se debe, las dos lo dicen con el mismo nominal", async () => {
    const [tasas] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.exchange_rates
       where from_currency = 'VES' and to_currency = 'USD'`;
    expect(tasas!.n, "alguien sembró una tasa VES→USD: este caso ya no demuestra nada").toBe(0);
    const proveedor = crypto.randomUUID();
    const factura = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${GESTOR}, true)`;
      await tx`insert into public.suppliers
                 (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code,
                  taxpayer_type_code)
               values (${proveedor}, ${TENANT}, ${COMPANY},
                       ${`J${String(Date.now() + 7).slice(-9)}`}, 'Proveedor con saldo a nuestro favor',
                       'nacional', 'juridica', 'ordinario')`;
      // 116,00 de total y 3,00 retenidos en funcional: 3,00 ÷ 0,025 = 120,00 → saldo −4,00.
      await tx`insert into public.supplier_invoices
                 (id, tenant_id, company_id, supplier_id, supplier_document_number,
                  supplier_control_number, invoice_date, status, posted_at, subtotal_amount,
                  tax_amount, total_amount, tax_is_recoverable, transaction_currency,
                  functional_currency, fx_rate, amount_transaction_currency, functional_amount,
                  retention_total)
               values (${factura}, ${TENANT}, ${COMPANY}, ${proveedor}, ${`FN-${RUN}`},
                       ${`CN-${RUN}`}, ${HOY}::date, 'posted', now(), 100, 16, 116, true, 'VES',
                       'USD', 0.025, 116, 2.9, 3.0)`;
    });
    const debida = crypto.randomUUID();
    let estado: Response;
    let estadoConDeuda: Response;
    try {
      const [f] = await sql<{ saldo: string; hoy: string | null; tramos: number }[]>`
        select platform.supplier_invoice_balance(${COMPANY}, ${factura})::numeric(24,8)::text as saldo,
               platform.supplier_debt_today(${COMPANY}, ${factura})::text as hoy,
               (select count(*)::int from platform.ap_aging(${COMPANY}, ${proveedor})) as tramos`;
      expect({ ...f }).toEqual({ saldo: "-4.00000000", hoy: null, tramos: 0 });
      await sql`insert into public.role_permissions (role_id, permission_key)
                values (${ROL_MIRON}, 'ap.read') on conflict do nothing`;
      estado = await pedir("GET", `/v1/suppliers/${proveedor}/statement`, MIRON);
      // Y con OTRA factura del mismo proveedor que sí se debe (116,00), sin tasa.
      await sql.begin(async (tx) => {
        await tx`select set_config('ladino.actor_id', ${GESTOR}, true)`;
        await tx`insert into public.supplier_invoices
                   (id, tenant_id, company_id, supplier_id, supplier_document_number,
                    supplier_control_number, invoice_date, status, posted_at, subtotal_amount,
                    tax_amount, total_amount, tax_is_recoverable, transaction_currency,
                    functional_currency, fx_rate, amount_transaction_currency, functional_amount)
                 values (${debida}, ${TENANT}, ${COMPANY}, ${proveedor}, ${`FD-${RUN}`},
                         ${`CD-${RUN}`}, ${HOY}::date, 'posted', now(), 100, 16, 116, true, 'VES',
                         'USD', 0.025, 116, 2.9)`;
      });
      estadoConDeuda = await pedir("GET", `/v1/suppliers/${proveedor}/statement`, MIRON);
    } finally {
      await sql`delete from public.role_permissions
                 where role_id = ${ROL_MIRON} and permission_key = 'ap.read'`;
      await sql.begin(async (tx) => {
        await tx`select set_config('ladino.actor_id', ${GESTOR}, true)`;
        await tx`update public.supplier_invoices set status = 'annulled'
                  where id in (${factura}, ${debida}) and status <> 'annulled'`;
      });
    }
    type Estado = {
      total_outstanding: string | null;
      total_outstanding_motivo: string | null;
      total_outstanding_por_moneda: { currency: string; nominal: string }[];
      aging: {
        buckets: { document_count: number; amount: string | null }[];
        total: string | null;
        total_motivo: string | null;
        total_por_moneda: { currency: string; nominal: string }[];
      };
    };
    const lecturas = (c: Estado): Record<string, unknown> => ({
      estado: [c.total_outstanding_motivo, c.total_outstanding_por_moneda],
      antiguedad: [c.aging.total_motivo, c.aging.total_por_moneda],
    });
    // Solo la de saldo negativo: nada se debe, nada pide tasa. Las dos lecturas, lo mismo.
    expect(estado.status, await estado.clone().text()).toBe(200);
    const cuerpo = (await estado.json()) as Estado;
    expect(lecturas(cuerpo)).toEqual({ estado: [null, []], antiguedad: [null, []] });
    expect(Number(cuerpo.total_outstanding)).toBe(0);
    expect(Number(cuerpo.aging.total)).toBe(0);
    expect(cuerpo.aging.buckets).toEqual([]);
    // Con la que se debe: las dos dicen `sin_tasa`, con el mismo nominal (lo que SE DEBE).
    expect(estadoConDeuda.status, await estadoConDeuda.clone().text()).toBe(200);
    const conDeuda = (await estadoConDeuda.json()) as Estado;
    expect(lecturas(conDeuda)).toEqual({
      estado: ["sin_tasa", [{ currency: "VES", nominal: "116.00" }]],
      antiguedad: ["sin_tasa", [{ currency: "VES", nominal: "116.00" }]],
    });
    expect([conDeuda.total_outstanding, conDeuda.aging.total]).toEqual([null, null]);
    expect(conDeuda.aging.buckets.map((b) => [b.document_count, b.amount])).toEqual([[1, null]]);
  });

  it("la tasa ni se escribe ni se «confirma» a mano: solo existe la del BCV (ADR-0064 §1)", async () => {
    const keep = await pedir("POST", "/v1/exchange-rates/keep", GESTOR, {
      from_currency: "USD",
      to_currency: "VES",
    });
    expect(keep.status).toBe(409);
    const k = (await keep.json()) as { code: string; message: string };
    expect(k.code).toBe("RATE_ONLY_FROM_BCV");
    // El mensaje, no solo el código: EXCHANGE_RATE_MISSING también es 409.
    expect(k.message).toContain("ya no se confirma a mano");

    const carga = await pedir("POST", "/v1/exchange-rates", GESTOR, {
      from_currency: "USD",
      to_currency: "VES",
      rate: "40.00000000",
      source: FUENTE_TASA,
      rate_date: HOY,
    });
    expect(carga.status).toBe(409);
    const m = (await carga.json()) as { code: string; message: string };
    expect(m.code).toBe("RATE_ONLY_FROM_BCV");
    expect(m.message).toContain("ya no se escribe a mano");
    const [filas] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.exchange_rates where source = ${FUENTE_TASA}`;
    expect(filas!.n).toBe("0");

    // La tasa oficial del día, como la guardaría el refresco.
    await sembrarTasaOficial(sql, { rate: "40.00000000", source: FUENTE_TASA, rate_date: HOY });

    // Y con tasa, el gasto en divisa sale — convertido a la tasa del día.
    const gasto = await pedir("POST", "/v1/expenses", GESTOR, {
      company_id: COMPANY,
      category: "Publicidad",
      account_id: ZELLE,
      amount: "10.00000000",
      allow_negative_balance: true,
      overdraft_reason: "Fixture E2E: se confirma el sobregiro con su motivo",
    });
    expect(gasto.status).toBe(201);
    const g = (await gasto.json()) as Record<string, string>;
    expect(g["functional_amount"]).toBe("400.00000000");
    expect(g["functional_currency"]).toBe("VES");
    expect(await saldoDe(ZELLE)).toBe("-10.00");
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
    expect(c["expected_amount"]).toBe("-250.00");
    expect(c["counted_amount"]).toBe("0.00");
    expect(c["difference"]).toBe("250.00");
    expect(c["accounting"]).toBe("queued");
    expect(await saldoDe(CAJA)).toBe("0.00");
  });

  it("un cierre exacto ni exige motivo ni asienta: cuadrar no es un movimiento", async () => {
    const r = await pedir("POST", "/v1/cash-closings", GESTOR, {
      company_id: COMPANY,
      account_id: CAJA,
      counted_amount: "0.00000000",
    });
    expect(r.status).toBe(201);
    const c = (await r.json()) as Record<string, unknown>;
    expect(c["difference"]).toBe("0.00");
    expect(c["accounting"]).toBe("none");
    expect(c["journal_entry_id"]).toBeNull();
    expect(await saldoDe(CAJA)).toBe("0.00");
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
      allow_negative_balance: true,
      overdraft_reason: "Fixture E2E: se confirma el sobregiro con su motivo",
    });
    expect(r.status).toBe(201);
    const g = (await r.json()) as Record<string, unknown>;
    expect(g["accounting"]).toBe("posted");
    expect(g["journal_entry_id"]).not.toBeNull();
    expect(await saldoDe(CAJA)).toBe("-100.00");
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
    expect(c["difference"]).toBe("100.00");
    expect(c["accounting"]).toBe("posted");
    expect(c["journal_entry_id"]).not.toBeNull();
  });

  it("el resumen del negocio: cifras del servidor, coherentes con lo que pasó", async () => {
    const r = await pedir("GET", "/v1/negocio/resumen", GESTOR);
    expect(r.status).toBe(200);
    const res = (await r.json()) as {
      functional_currency: string;
      mi_dinero: { currency: string; balance: string }[];
      lo_que_me_deben: string | null;
      lo_que_debo: string | null;
      tasa_del_dia: { rate: string; source: string } | null;
      vendido_hoy: string;
    };
    expect(res.functional_currency).toBe("VES");
    // Caja quedó en 0 tras el último cierre; Zelle en −10 por el gasto en USD.
    const porMoneda = new Map(res.mi_dinero.map((m) => [m.currency, m.balance]));
    expect(porMoneda.get("VES")).toBe("0.00");
    expect(porMoneda.get("USD")).toBe("-10.00");
    // El gestor tiene treasury.read, pero NO ar.read ni ap.read: el resumen se sirve y los dos
    // totales de deuda llegan en null —«no tienes acceso», nunca «0.00»— (N-07/P-04, ADR-0048
    // nota de la re-revisión). Antes aseveraba "0.00": pasaba gracias al permiso anidado.
    expect(res.lo_que_me_deben).toBeNull();
    expect(res.lo_que_debo).toBeNull();
    expect(res.tasa_del_dia).not.toBeNull();
    expect(res.tasa_del_dia!.rate).toBe("40.00000000");

    const sinPermiso = await pedir("GET", "/v1/negocio/resumen", MIRON);
    // El mirón SÍ tiene treasury.read en esta fixture: también ve el resumen.
    expect(sinPermiso.status).toBe(200);
    const deMiron = async (): Promise<{
      lo_que_me_deben: string | null;
      lo_que_debo: string | null;
    }> =>
      (await (await pedir("GET", "/v1/negocio/resumen", MIRON)).json()) as {
        lo_que_me_deben: string | null;
        lo_que_debo: string | null;
      };
    expect(await deMiron()).toMatchObject({ lo_que_me_deben: null, lo_que_debo: null });
    // Con ar.read ve lo que le deben (cero, a dos decimales: sin ventas aquí) y sigue sin ver lo
    // que debe; con ap.read además, ve las dos. Cada cifra, su permiso.
    try {
      await sql`insert into public.role_permissions (role_id, permission_key)
                values (${ROL_MIRON}, 'ar.read')`;
      expect(await deMiron()).toMatchObject({ lo_que_me_deben: "0.00", lo_que_debo: null });
      await sql`insert into public.role_permissions (role_id, permission_key)
                values (${ROL_MIRON}, 'ap.read')`;
      expect(await deMiron()).toMatchObject({ lo_que_me_deben: "0.00", lo_que_debo: "0.00" });
      await sql`delete from public.role_permissions
                 where role_id = ${ROL_MIRON} and permission_key = 'ar.read'`;
      expect(await deMiron()).toMatchObject({ lo_que_me_deben: null, lo_que_debo: "0.00" });
    } finally {
      await sql`delete from public.role_permissions
                 where role_id = ${ROL_MIRON} and permission_key in ('ar.read', 'ap.read')`;
    }
  });

  // Ola 4 (familia de N-05): un `null` del resumen dice POR QUÉ. Un 403 o un null leídos como
  // «no hay» son ausencia de fallo leída como éxito.
  it("el null de cada total de deuda lleva su motivo: sin_permiso sin el permiso, null con la cifra", async () => {
    type Motivos = {
      lo_que_me_deben: string | null;
      lo_que_me_deben_motivo: string | null;
      lo_que_me_deben_por_moneda: unknown[];
      lo_que_debo: string | null;
      lo_que_debo_motivo: string | null;
      lo_que_debo_por_moneda: unknown[];
    };
    const deMiron = async (): Promise<Motivos> =>
      (await (await pedir("GET", "/v1/negocio/resumen", MIRON)).json()) as Motivos;
    expect(await deMiron()).toMatchObject({
      lo_que_me_deben: null,
      lo_que_me_deben_motivo: "sin_permiso",
      lo_que_me_deben_por_moneda: [],
      lo_que_debo: null,
      lo_que_debo_motivo: "sin_permiso",
      lo_que_debo_por_moneda: [],
    });
    try {
      await sql`insert into public.role_permissions (role_id, permission_key)
                values (${ROL_MIRON}, 'ar.read'), (${ROL_MIRON}, 'ap.read')`;
      expect(await deMiron()).toMatchObject({
        lo_que_me_deben: "0.00",
        lo_que_me_deben_motivo: null,
        lo_que_me_deben_por_moneda: [],
        lo_que_debo: "0.00",
        lo_que_debo_motivo: null,
        lo_que_debo_por_moneda: [],
      });
    } finally {
      await sql`delete from public.role_permissions
                 where role_id = ${ROL_MIRON} and permission_key in ('ar.read', 'ap.read')`;
    }
  });

  // N-05: «Mi dinero» le decía al encargado «Todavía no hay tasa BCV» habiéndola, porque la tasa
  // solo salía del resumen (treasury.read). La tasa del día tiene su lectura propia.
  it("N-05 · quien solo cierra caja no abre el resumen (403), pero SÍ lee la tasa del día — la misma del resumen", async () => {
    const vedado = await pedir("GET", "/v1/negocio/resumen", CERRADOR);
    expect(vedado.status).toBe(403);
    const r = await pedir("GET", "/v1/negocio/tasa", CERRADOR);
    expect(r.status, await r.clone().text()).toBe(200);
    const suya = (await r.json()) as {
      tasa_del_dia: {
        rate: string;
        rate_date: string;
        source: string;
        es_de_hoy: boolean;
        dias_de_antiguedad: number;
      } | null;
    };
    const delGestor = (await (await pedir("GET", "/v1/negocio/resumen", GESTOR)).json()) as {
      tasa_del_dia: Record<string, unknown> | null;
    };
    expect(suya.tasa_del_dia).not.toBeNull();
    // El objeto ENTERO: una sola consulta sirve a las dos lecturas.
    expect(suya.tasa_del_dia).toEqual(delGestor.tasa_del_dia);
    // Y quien no es de la empresa no la lee por aquí. Un usuario REAL, con su propio negocio en
    // OTRO tenant: en el suyo la lee; en esta empresa recibe el MISMO 404 que por una empresa que
    // no existe (el alcance no confirma que la empresa exista).
    const OTRO = crypto.randomUUID();
    const TENANT_2 = crypto.randomUUID();
    const COMPANY_2 = crypto.randomUUID();
    const MEM_2 = crypto.randomUUID();
    await sql`insert into auth.users (id) values (${OTRO})`;
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${OTRO}, true)`;
      await tx`insert into public.tenants (id, name) values (${TENANT_2}, 'Tenant e2e tesorería 2')`;
      await tx`insert into public.companies
                 (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
               values (${COMPANY_2}, ${TENANT_2}, ${`J-TESO2-${RUN}`}, 'Otra empresa e2e tesorería',
                       'VES', 'ordinario')`;
      await tx`insert into public.memberships (id, tenant_id, user_id)
               values (${MEM_2}, ${TENANT_2}, ${OTRO})`;
      await tx`insert into public.user_role_assignments
                 (id, tenant_id, membership_id, role_id, company_id)
               values (${crypto.randomUUID()}, ${TENANT_2}, ${MEM_2}, ${ROL_CERRADOR}, null)`;
    });
    const comoOtro = async (company: string): Promise<Response> =>
      app.request("/v1/negocio/tasa", {
        method: "GET",
        headers: { Authorization: `Bearer ${await tokenDe(OTRO)}`, "X-Company-Id": company },
      });
    const enLaSuya = await comoOtro(COMPANY_2);
    expect(enLaSuya.status, await enLaSuya.clone().text()).toBe(200);
    const enLaAjena = await comoOtro(COMPANY);
    const enNinguna = await comoOtro(crypto.randomUUID());
    expect(enLaAjena.status).toBe(404);
    expect(enNinguna.status).toBe(404);
    const cuerpo = async (r: Response): Promise<{ code: string; message: string }> => {
      const { code, message } = (await r.json()) as { code: string; message: string };
      return { code, message };
    };
    // Indistinguibles: mismo código y mismo mensaje.
    expect(await cuerpo(enLaAjena)).toEqual(await cuerpo(enNinguna));
  });

  // ── ADR-0067: la cuenta se pregunta, no se adivina ───────────────────────
  it("con dos bancos, las candidatas son LAS DOS y en el orden en que el servidor resolvería", async () => {
    // Dos cuentas de la MISMA familia y moneda: aquí es donde la escalera de ADR-0062 §1
    // deja de ser una regla y pasa a ser un desempate por antigüedad.
    const banesco = await pedir("POST", "/v1/treasury/accounts", GESTOR, {
      company_id: COMPANY,
      name: "Banesco",
      currency: "VES",
      kind: "bank",
    });
    expect(banesco.status).toBe(201);
    BANESCO = ((await banesco.json()) as { id: string }).id;
    const mercantil = await pedir("POST", "/v1/treasury/accounts", GESTOR, {
      company_id: COMPANY,
      name: "Banco Mercantil",
      currency: "VES",
      kind: "bank",
    });
    expect(mercantil.status).toBe(201);
    MERCANTIL = ((await mercantil.json()) as { id: string }).id;

    const r = await pedir("GET", "/v1/treasury/accounts/candidates", GESTOR);
    expect(r.status, await r.clone().text()).toBe(200);
    const c = (await r.json()) as { instruments: Candidatas[] };
    const transferencia = c.instruments.find((i) => i.instrument === "transferencia");
    expect(transferencia).toBeDefined();
    expect(transferencia!.accounts.map((a) => a.name)).toEqual(["Banesco", "Banco Mercantil"]);
    expect(transferencia!.fixed_by_method).toBeNull();

    // El efectivo NO ve los bancos: el arqueo contaría billetes que no están (ADR-0062 §1).
    const efectivo = c.instruments.find((i) => i.instrument === "efectivo_bs");
    expect(efectivo!.accounts.map((a) => a.name)).toEqual(["Caja Bs"]);

    // Y el dólar tiene lo suyo, no lo de bolívares.
    const zelle = c.instruments.find((i) => i.instrument === "zelle");
    expect(zelle!.accounts.map((a) => a.name)).toEqual(["Zelle"]);

    // NINGUNA trae saldo: elegir la cuenta no es ver el dinero (ADR-0067 §1).
    const conSaldo = c.instruments.flatMap((i) => i.accounts).filter((a) => "balance" in a);
    expect(conSaldo).toEqual([]);
  });

  it("con una forma configurada no hay nada que preguntar: la cuenta viene fijada", async () => {
    const m = await pedir("POST", "/v1/payment-methods", GESTOR, {
      company_id: COMPANY,
      name: "Mercantil transferencias",
      kind: "transferencia",
      account_id: MERCANTIL,
    });
    expect(m.status, await m.clone().text()).toBe(201);

    const r = await pedir("GET", "/v1/treasury/accounts/candidates", GESTOR);
    const c = (await r.json()) as { instruments: Candidatas[] };
    const transferencia = c.instruments.find((i) => i.instrument === "transferencia");
    expect(transferencia!.fixed_by_method).toBe(MERCANTIL);
    // Las candidatas siguen ahí: la pantalla decide con `fixed_by_method`, no adivinando.
    expect(transferencia!.accounts).toHaveLength(2);
  });

  it("quien COBRA puede elegir la cuenta, pero no puede ver el dinero", async () => {
    // El permiso de las candidatas es el de quien REGISTRA el movimiento. La cajera tiene que
    // poder decir «entró por Mercantil» sin que la pantalla le enseñe cuánto hay en Mercantil.
    const candidatas = await pedir("GET", "/v1/treasury/accounts/candidates", CAJERA);
    expect(candidatas.status, await candidatas.clone().text()).toBe(200);
    const c = (await candidatas.json()) as { instruments: Candidatas[] };
    expect(c.instruments.find((i) => i.instrument === "transferencia")!.accounts).toHaveLength(2);

    const cuentas = await pedir("GET", "/v1/treasury/accounts", CAJERA);
    expect(cuentas.status).toBe(403);
  });

  it("el informe enseña lo que cayó en «Sin asignar» y calla lo que cayó bien", async () => {
    // Un gasto pagado de una cuenta propia: normal, no se informa.
    const bueno = await pedir("POST", "/v1/expenses", GESTOR, {
      company_id: COMPANY,
      category: "Luz",
      account_id: BANESCO,
      amount: "10",
      allow_negative_balance: true,
      overdraft_reason: "Fixture E2E: se confirma el sobregiro con su motivo",
    });
    expect(bueno.status, await bueno.clone().text()).toBe(201);

    const antes = await pedir("GET", "/v1/treasury/landing-gaps", GESTOR);
    expect(antes.status).toBe(200);
    expect(((await antes.json()) as { items: unknown[] }).items).toEqual([]);

    // Y ahora uno que cae en la cuenta de sistema, que es lo que pasaba cuando nadie elegía.
    const [sinAsignar] = await sql<{ id: string }[]>`
      insert into public.company_accounts
        (tenant_id, company_id, name, currency, kind, is_system)
      values (${TENANT}, ${COMPANY}, 'Sin asignar (VES)', 'VES', 'cash', true)
      returning id`;
    const malo = await pedir("POST", "/v1/expenses", GESTOR, {
      company_id: COMPANY,
      category: "Agua",
      account_id: sinAsignar!.id,
      amount: "20",
      allow_negative_balance: true,
      overdraft_reason: "Fixture E2E: se confirma el sobregiro con su motivo",
    });
    expect(malo.status, await malo.clone().text()).toBe(201);

    const r = await pedir("GET", "/v1/treasury/landing-gaps", GESTOR);
    const filas = (await r.json()) as { items: { problem: string; account_name: string }[] };
    expect(filas.items).toHaveLength(1);
    expect(filas.items[0]!.problem).toBe("sin_asignar");
    expect(filas.items[0]!.account_name).toBe("Sin asignar (VES)");

    // Es un INFORME: no arregla nada y el dinero sigue donde cayó.
    const [saldo] = await sql<{ balance: string }[]>`
      select balance::text from public.company_account_balances
       where account_id = ${sinAsignar!.id}`;
    expect(Number(saldo!.balance)).toBe(-20);
  });

  it("y el informe no lo ve quien no puede ver el dinero", async () => {
    const r = await pedir("GET", "/v1/treasury/landing-gaps", CAJERA);
    expect(r.status).toBe(403);
  });
  it("los listados responden y la conciliación cuadra al final", async () => {
    const gastos = await pedir("GET", "/v1/expenses", GESTOR);
    expect(gastos.status).toBe(200);
    const lg = (await gastos.json()) as { items: unknown[]; total: number };
    // Eran 3 hasta ADR-0067: los dos gastos que registra el test del informe —uno pagado de una
    // cuenta propia y otro de «Sin asignar»— son los que hacen 5. El número cuenta lo que este
    // fichero creó, no un invariante del negocio.
    expect(lg.total).toBe(5);

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

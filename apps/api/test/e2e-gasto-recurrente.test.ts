import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";

/**
 * H-07 (recorrido 2026-09-24, ola 5): EL GASTO QUE SE REPITE AVISA CUANDO TOCA.
 * De extremo a extremo, como `ladino_api` con JWT real. Lo que demuestra:
 *
 *   · registrar un gasto con «se repite» y su periodicidad crea el recordatorio; sin
 *     periodicidad, cada mes (lo que la pantalla prometía);
 *   · «toca» es el día de CARACAS contra un día: un pago de las 23:30 de Caracas ancla en ESE
 *     día, no en el siguiente de Greenwich;
 *   · «registrar ahora» es `POST /v1/expenses` —la puerta de siempre— y deja el período
 *     atendido: el segundo clic es 409 y NO registra otro gasto; dos intentos a la vez dejan
 *     UN gasto; la misma Idempotency-Key devuelve el mismo;
 *   · omitir esta vez y dejar de avisar; quien no tiene `expense.read` no ve el aviso (403) y
 *     quien solo lee no omite ni detiene (403);
 *   · con factura fiscal, el período queda atado a la factura del gasto.
 *
 * Todo en VES: no depende de `exchange_rates`.
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
const LECTOR = crypto.randomUUID();
const ROL = crypto.randomUUID();
const ROL_CAJERO = crypto.randomUUID();
const ROL_LECTOR = crypto.randomUUID();
const MEM = crypto.randomUUID();
const MEM_CAJERO = crypto.randomUUID();
const MEM_LECTOR = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const AYER = diaCaracas(-1);
const SOBREGIRO = {
  allow_negative_balance: true,
  overdraft_reason: "Fixture E2E: se confirma el sobregiro con su motivo",
};

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let BANCO = "";
let PROV = "";
let ALQUILER = "";

interface Recordatorio {
  id: string;
  category: string;
  account_id: string | null;
  suggested_amount: string | null;
  currency: string | null;
  with_invoice: boolean;
  periodicity: string;
  next_due_on: string;
  following_due_on: string;
  is_due: boolean;
  days_overdue: number;
  status: string;
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

async function pedir(
  metodo: string,
  path: string,
  body?: unknown,
  quien: string = DUENO,
  clave: string = crypto.randomUUID(),
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(quien)}`,
    "X-Company-Id": COMPANY,
  };
  if (metodo !== "GET") headers["Idempotency-Key"] = clave;
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

const gasto = (categoria: string, importe: string, extra: Record<string, unknown> = {}) => ({
  company_id: COMPANY,
  category: categoria,
  account_id: BANCO,
  amount: importe,
  ...SOBREGIRO,
  ...extra,
});

const recordatorios = async (quien: string = DUENO): Promise<Recordatorio[]> => {
  const r = await pedir("GET", "/v1/recurring-expenses", undefined, quien);
  expect(r.status).toBe(200);
  return ((await r.json()) as { items: Recordatorio[] }).items;
};
const elDe = async (categoria: string): Promise<Recordatorio | undefined> =>
  (await recordatorios()).find((x) => x.category === categoria);

/** Cuántos gastos (llanos o con factura) hay de una categoría: lo que NO debe duplicarse. */
const gastosDe = async (categoria: string): Promise<number> => {
  const [f] = await sql<{ n: number }[]>`
    select (select count(*) from public.expenses
             where company_id = ${COMPANY} and lower(btrim(category)) = lower(${categoria}))::int
         + (select count(*) from public.supplier_invoices
             where company_id = ${COMPANY} and expense_category = ${categoria})::int as n`;
  return f!.n;
};

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}), (${CAJERO}), (${LECTOR})
            on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e gasto recurrente')`;
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code,
                fiscal_address)
             values (${COMPANY}, ${TENANT}, ${`J-E2EGRE-${RUN}`}, 'Gastos que se repiten e2e, C.A.',
                     'VES', 'ordinario', 'Av. Principal, Caracas')`;
    await declararTipoDeFixture(tx, COMPANY);
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, ${`e2egre_${RUN}`}, 'Lleva los gastos', false),
                    (${ROL_CAJERO}, null, ${`e2egrec_${RUN}`}, 'Cajero', false),
                    (${ROL_LECTOR}, null, ${`e2egrel_${RUN}`}, 'Solo lee gastos', false)`;
    await tx`insert into public.role_permissions (role_id, permission_key)
             select ${ROL}, key from public.permissions
              where key not like 'purchase.%' and not is_scoped`;
    await tx`insert into public.role_permissions (role_id, permission_key)
             values (${ROL_CAJERO}, 'sales.invoice.issue'), (${ROL_LECTOR}, 'expense.read')`;
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${MEM}, ${TENANT}, ${DUENO}), (${MEM_CAJERO}, ${TENANT}, ${CAJERO}),
                    (${MEM_LECTOR}, ${TENANT}, ${LECTOR})`;
    await tx`insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
             values (${TENANT}, ${MEM}, ${ROL}, null), (${TENANT}, ${MEM_CAJERO}, ${ROL_CAJERO}, null),
                    (${TENANT}, ${MEM_LECTOR}, ${ROL_LECTOR}, null)`;
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
    await tx`
      insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, transaction_type,
                                    product_tax_category, rate, effective_from, legal_source,
                                    priority)
      select 'VE', 'iva', null, 'purchase', 'gravado_general', 0.16, ${AYER}::date,
             ${`REGLA DE PRUEBA E2E gasto recurrente ${RUN}`}, 50
       where not exists (select 1 from public.tax_rules
                          where company_id is null and transaction_type = 'purchase'
                            and jurisdiction = 'VE' and tax_code = 'iva'
                            and taxpayer_type is null
                            and product_tax_category = 'gravado_general')`;
  });
  const banco = await pedir("POST", "/v1/treasury/accounts", {
    company_id: COMPANY,
    name: "Banco Bs",
    currency: "VES",
    kind: "bank",
  });
  expect(banco.status).toBe(201);
  BANCO = ((await banco.json()) as { id: string }).id;
  const prov = await pedir("POST", "/v1/suppliers", {
    company_id: COMPANY,
    tax_id: `J-3${String(Date.now()).slice(-7)}-0`,
    legal_name: "Internet de Caracas e2e",
    supplier_kind: "nacional",
    person_type_code: "juridica",
    taxpayer_type_code: "ordinario",
    fiscal_address: "Av. Vollmer, Caracas",
  });
  expect(prov.status).toBe(201);
  PROV = ((await prov.json()) as { id: string }).id;
}, 120_000);

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("H-07 · el gasto que se repite avisa cuando toca", () => {
  it("antes de registrar nada no hay avisos; quien no tiene `expense.read` no los ve (403)", async () => {
    expect(await recordatorios()).toEqual([]);
    const r = await pedir("GET", "/v1/recurring-expenses", undefined, CAJERO);
    expect(r.status).toBe(403);
  });

  it("un gasto semanal pagado a las 23:30 de Caracas de hace ocho días ancla en ESE día: tocó ayer y lleva un día de atraso", async () => {
    // 03:30Z del día -7 son las 23:30 de Caracas del día -8. Con el día de Greenwich el ancla
    // sería el -7, tocaría HOY y no habría atraso: la aserción distingue las dos lecturas.
    const r = await pedir(
      "POST",
      "/v1/expenses",
      gasto("Alquiler", "500", {
        is_recurring: true,
        recurrence: "weekly",
        paid_at: `${diaCaracas(-7)}T03:30:00.000Z`,
      }),
    );
    expect(r.status).toBe(201);
    const a = await elDe("Alquiler");
    expect(a).toMatchObject({
      periodicity: "weekly",
      next_due_on: AYER,
      // El período que le sigue lo dice el servidor (la pantalla lo cita al omitir).
      following_due_on: diaCaracas(6),
      is_due: true,
      days_overdue: 1,
      suggested_amount: "500.00000000",
      currency: "VES",
      account_id: BANCO,
      with_invoice: false,
      status: "active",
    });
    ALQUILER = a!.id;
    // El primer gasto es el primer período, atado a ESE gasto.
    const [p] = await sql<{ due_on: string; outcome: string; expense_id: string }[]>`
      select due_on::text as due_on, outcome, expense_id
        from public.recurring_expense_periods where recurring_expense_id = ${ALQUILER}`;
    expect(p).toMatchObject({ due_on: diaCaracas(-8), outcome: "registered" });
    expect(p!.expense_id).toBe(((await r.json()) as { id: string }).id);
  });

  it("sin periodicidad es cada mes, y un gasto de hoy todavía no toca", async () => {
    const r = await pedir(
      "POST",
      "/v1/expenses",
      gasto("Condominio", "80", { is_recurring: true }),
    );
    expect(r.status).toBe(201);
    const c = await elDe("Condominio");
    expect(c).toMatchObject({ periodicity: "monthly", is_due: false, days_overdue: 0 });
    expect(c!.next_due_on > HOY).toBe(true);
  });

  it("registrar otra vez la misma categoría a mano NO crea un segundo aviso ni mueve el que hay, y la RESPUESTA dice que el recordatorio sigue como estaba", async () => {
    const r = await pedir(
      "POST",
      "/v1/expenses",
      gasto("  ALQUILER ", "510", { is_recurring: true, recurrence: "yearly" }),
    );
    expect(r.status).toBe(201);
    // Se pidió «cada año» y el recordatorio es semanal: el gasto entra y se DICE que sigue igual.
    expect(((await r.json()) as { recurrence_kept?: unknown }).recurrence_kept).toEqual({
      periodicity: "weekly",
      next_due_on: AYER,
    });
    // Un gasto que no topa con un recordatorio previo no trae el aviso.
    const otro = await pedir(
      "POST",
      "/v1/expenses",
      gasto(`Sin aviso ${RUN}`, "5", { is_recurring: true }),
    );
    expect(otro.status).toBe(201);
    expect(((await otro.json()) as { recurrence_kept?: unknown }).recurrence_kept ?? null).toBe(
      null,
    );
    const todos = (await recordatorios()).filter((x) => x.category.toLowerCase() === "alquiler");
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({ id: ALQUILER, periodicity: "weekly", next_due_on: AYER });
  });

  it("la periodicidad sin la marca, o el recordatorio sin su período, son 422 y no escriben nada", async () => {
    const antes = await gastosDe("Alquiler");
    const sinMarca = await pedir(
      "POST",
      "/v1/expenses",
      gasto("Alquiler", "1", { recurrence: "weekly" }),
    );
    expect(sinMarca.status).toBe(422);
    const sinPeriodo = await pedir(
      "POST",
      "/v1/expenses",
      gasto("Alquiler", "1", { recurring_expense_id: ALQUILER }),
    );
    expect(sinPeriodo.status).toBe(422);
    const inventada = await pedir(
      "POST",
      "/v1/expenses",
      gasto("Alquiler", "1", { is_recurring: true, recurrence: "cada_luna_llena" }),
    );
    expect(inventada.status).toBe(422);
    expect(await gastosDe("Alquiler")).toBe(antes);
  });

  it("«registrar ahora» sobre un período que no es el que toca es 409, sobre un recordatorio que no existe 404 — y ninguno registra el gasto", async () => {
    const antes = await gastosDe("Alquiler");
    const otro = await pedir(
      "POST",
      "/v1/expenses",
      gasto("Alquiler", "520", { recurring_expense_id: ALQUILER, recurring_due_on: HOY }),
    );
    expect(otro.status).toBe(409);
    expect(((await otro.json()) as { code: string }).code).toBe("CONFLICT");
    const fantasma = await pedir(
      "POST",
      "/v1/expenses",
      gasto("Alquiler", "520", {
        recurring_expense_id: crypto.randomUUID(),
        recurring_due_on: AYER,
      }),
    );
    expect(fantasma.status).toBe(404);
    const cajero = await pedir(
      "POST",
      "/v1/expenses",
      gasto("Alquiler", "520", { recurring_expense_id: ALQUILER, recurring_due_on: AYER }),
      CAJERO,
    );
    expect(cajero.status).toBe(403);
    expect(await gastosDe("Alquiler")).toBe(antes);
    expect((await elDe("Alquiler"))!.next_due_on).toBe(AYER);
  });

  it("«registrar ahora» con OTRA categoría que la del recordatorio es 422 con su mensaje: no registra el gasto, no atiende el período y no le cambia los datos al recordatorio", async () => {
    const antes = (await elDe("Alquiler"))!;
    const luz = await pedir(
      "POST",
      "/v1/expenses",
      gasto("Luz", "77", { recurring_expense_id: ALQUILER, recurring_due_on: AYER }),
    );
    expect(luz.status).toBe(422);
    const fallo = (await luz.json()) as { code: string; message: string };
    expect(fallo.code).toBe("VALIDATION_FAILED");
    expect(fallo.message).toContain("«Alquiler»");
    expect(fallo.message).toContain("«Luz»");
    expect(await gastosDe("Luz")).toBe(0);
    expect(await elDe("Alquiler")).toEqual(antes);
    // Mayúsculas y espacios de los bordes no son otra categoría (la regla del único de la tabla).
    const mismo = await pedir(
      "POST",
      "/v1/expenses",
      gasto("  alquiler ", "1", { recurring_expense_id: ALQUILER, recurring_due_on: HOY }),
    );
    // Pasa la comprobación de categoría y cae en la del período (HOY no es el que toca).
    expect(mismo.status).toBe(409);
  });

  it("«registrar ahora» registra el gasto por la puerta de siempre y deja el período atendido; la misma clave devuelve el mismo gasto y el segundo clic es 409 sin otro gasto", async () => {
    const antes = await gastosDe("Alquiler");
    const cuerpo = gasto("Alquiler", "520", {
      recurring_expense_id: ALQUILER,
      recurring_due_on: AYER,
    });
    const clave = crypto.randomUUID();
    const r = await pedir("POST", "/v1/expenses", cuerpo, DUENO, clave);
    expect(r.status).toBe(201);
    const registrado = (await r.json()) as { id: string; is_recurring: boolean; amount: string };
    expect(registrado).toMatchObject({ is_recurring: true, amount: "520.00000000" });
    expect(await gastosDe("Alquiler")).toBe(antes + 1);

    // La cuenta bajó de verdad: es un gasto, con su movimiento, no una marca.
    const [mov] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.expenses
       where id = ${registrado.id} and account_id = ${BANCO} and amount_transaction_currency = 520`;
    expect(mov!.n).toBe(1);

    const a = await elDe("Alquiler");
    // Semanal desde el ancla (-8): atendido el de ayer (-1), el siguiente es dentro de 6 días.
    expect(a).toMatchObject({
      next_due_on: diaCaracas(6),
      is_due: false,
      days_overdue: 0,
      suggested_amount: "520.00000000",
    });
    const [p] = await sql<{ outcome: string; expense_id: string }[]>`
      select outcome, expense_id from public.recurring_expense_periods
       where recurring_expense_id = ${ALQUILER} and due_on = ${AYER}::date`;
    expect(p).toEqual({ outcome: "registered", expense_id: registrado.id });

    // El reintento del MISMO intento (misma clave): el mismo gasto, no otro.
    const repetido = await pedir("POST", "/v1/expenses", cuerpo, DUENO, clave);
    expect(repetido.status).toBe(201);
    expect(((await repetido.json()) as { id: string }).id).toBe(registrado.id);
    // El segundo clic (otra clave): lo para la clave natural, no la idempotencia.
    const segundo = await pedir("POST", "/v1/expenses", cuerpo);
    expect(segundo.status).toBe(409);
    const error = (await segundo.json()) as { code: string; message: string };
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain("ya se atendió");
    expect(await gastosDe("Alquiler")).toBe(antes + 1);
  });

  it("dos «registrar ahora» A LA VEZ sobre el mismo período dejan UN gasto: uno 201 y el otro 409", async () => {
    const antes = await gastosDe("Alquiler");
    const toca = (await elDe("Alquiler"))!.next_due_on;
    const cuerpo = gasto("Alquiler", "530", {
      recurring_expense_id: ALQUILER,
      recurring_due_on: toca,
    });
    const [a, b] = await Promise.all([
      pedir("POST", "/v1/expenses", cuerpo),
      pedir("POST", "/v1/expenses", cuerpo),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await gastosDe("Alquiler")).toBe(antes + 1);
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.recurring_expense_periods
       where recurring_expense_id = ${ALQUILER} and due_on = ${toca}::date`;
    expect(n!.n).toBe(1);
  });

  it("omitir esta vez pasa el aviso al siguiente sin registrar gasto; repetirlo es 409; quien solo lee no omite ni detiene (403)", async () => {
    const antes = await gastosDe("Alquiler");
    const toca = (await elDe("Alquiler"))!.next_due_on;
    // Quien solo lee SÍ ve el aviso…
    expect((await recordatorios(LECTOR)).some((x) => x.id === ALQUILER)).toBe(true);
    // …pero no lo mueve.
    const lectorOmite = await pedir(
      "POST",
      `/v1/recurring-expenses/${ALQUILER}/skip`,
      { company_id: COMPANY, due_on: toca },
      LECTOR,
    );
    expect(lectorOmite.status).toBe(403);
    const lectorDetiene = await pedir(
      "POST",
      `/v1/recurring-expenses/${ALQUILER}/stop`,
      { company_id: COMPANY },
      LECTOR,
    );
    expect(lectorDetiene.status).toBe(403);
    expect((await elDe("Alquiler"))!.next_due_on).toBe(toca);

    const r = await pedir("POST", `/v1/recurring-expenses/${ALQUILER}/skip`, {
      company_id: COMPANY,
      due_on: toca,
    });
    expect(r.status).toBe(200);
    const despues = (await r.json()) as Recordatorio;
    expect(despues.next_due_on > toca).toBe(true);
    const otra = await pedir("POST", `/v1/recurring-expenses/${ALQUILER}/skip`, {
      company_id: COMPANY,
      due_on: toca,
    });
    expect(otra.status).toBe(409);
    expect((await elDe("Alquiler"))!.next_due_on).toBe(despues.next_due_on);
    expect(await gastosDe("Alquiler")).toBe(antes);
    const [p] = await sql<{ outcome: string; expense_id: string | null }[]>`
      select outcome, expense_id from public.recurring_expense_periods
       where recurring_expense_id = ${ALQUILER} and due_on = ${toca}::date`;
    expect(p).toEqual({ outcome: "skipped", expense_id: null });
  });

  it("con factura fiscal: el recordatorio nace atado a la FACTURA del gasto, y «registrar ahora» con otra factura atiende el período", async () => {
    const conFactura = (numero: string, extra: Record<string, unknown> = {}) => ({
      company_id: COMPANY,
      category: "Internet",
      account_id: BANCO,
      ...SOBREGIRO,
      invoice: {
        supplier_id: PROV,
        document_number: numero,
        control_number: `00-${numero}`,
        invoice_date: HOY,
        lines: [{ tax_category_code: "gravado_general", base: "100" }],
      },
      ...extra,
    });
    const r = await pedir(
      "POST",
      "/v1/expenses",
      conFactura(`NET-${RUN}-1`, { is_recurring: true, recurrence: "semimonthly" }),
    );
    expect(r.status).toBe(201);
    const primera = (await r.json()) as { id: string; supplier_invoice_id: string; amount: string };
    expect(primera.supplier_invoice_id).toBe(primera.id);
    const net = (await elDe("Internet"))!;
    expect(net).toMatchObject({
      periodicity: "semimonthly",
      with_invoice: true,
      next_due_on: diaCaracas(15),
      suggested_amount: primera.amount,
      is_due: false,
    });
    const segunda = await pedir(
      "POST",
      "/v1/expenses",
      conFactura(`NET-${RUN}-2`, {
        recurring_expense_id: net.id,
        recurring_due_on: net.next_due_on,
      }),
    );
    expect(segunda.status).toBe(201);
    const idSegunda = ((await segunda.json()) as { id: string }).id;
    const periodos = await sql<
      { outcome: string; expense_id: string | null; supplier_invoice_id: string | null }[]
    >`
      select outcome, expense_id, supplier_invoice_id from public.recurring_expense_periods
       where recurring_expense_id = ${net.id} order by due_on`;
    expect(periodos).toEqual([
      { outcome: "registered", expense_id: null, supplier_invoice_id: primera.id },
      { outcome: "registered", expense_id: null, supplier_invoice_id: idSegunda },
    ]);
    // El segundo clic con OTRA factura tampoco entra: ni período ni factura.
    const tercera = await pedir(
      "POST",
      "/v1/expenses",
      conFactura(`NET-${RUN}-3`, {
        recurring_expense_id: net.id,
        recurring_due_on: net.next_due_on,
      }),
    );
    expect(tercera.status).toBe(409);
    const [f] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.supplier_invoices
       where company_id = ${COMPANY} and supplier_document_number = ${`NET-${RUN}-3`}`;
    expect(f!.n).toBe(0);
  });

  it("«ya no se paga»: deja de avisar, repetirlo no es un error, no se le registran más períodos, y la categoría puede volver a empezar", async () => {
    const r = await pedir("POST", `/v1/recurring-expenses/${ALQUILER}/stop`, {
      company_id: COMPANY,
    });
    expect(r.status).toBe(200);
    const detenido = (await r.json()) as Recordatorio;
    expect(detenido.status).toBe("stopped");
    expect(await elDe("Alquiler")).toBeUndefined();
    const otra = await pedir("POST", `/v1/recurring-expenses/${ALQUILER}/stop`, {
      company_id: COMPANY,
    });
    expect(otra.status).toBe(200);

    const antes = await gastosDe("Alquiler");
    const tarde = await pedir(
      "POST",
      "/v1/expenses",
      gasto("Alquiler", "540", {
        recurring_expense_id: ALQUILER,
        recurring_due_on: detenido.next_due_on,
      }),
    );
    expect(tarde.status).toBe(409);
    expect(((await tarde.json()) as { message: string }).message).toContain("ya no se paga");
    expect(await gastosDe("Alquiler")).toBe(antes);

    const nuevo = await pedir(
      "POST",
      "/v1/expenses",
      gasto("Alquiler", "600", { is_recurring: true }),
    );
    expect(nuevo.status).toBe(201);
    const vivo = (await elDe("Alquiler"))!;
    expect(vivo.id).not.toBe(ALQUILER);
    expect(vivo.periodicity).toBe("monthly");
  });

  it("cada paso deja su acta", async () => {
    const actas = await sql<{ event_type: string; n: number }[]>`
      select event_type, count(*)::int as n from public.audit_events
       where company_id = ${COMPANY} and aggregate_type = 'recurring_expense'
       group by event_type order by event_type`;
    expect(Object.fromEntries(actas.map((a) => [a.event_type, a.n]))).toEqual({
      "recurring_expense.created": 5,
      "recurring_expense.registered": 3,
      "recurring_expense.skipped": 1,
      "recurring_expense.stopped": 1,
    });
  });
});

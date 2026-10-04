import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { sembrarTasaOficial, borrarTasasOficiales } from "./_tasa-oficial.js";
import { diaCaracas } from "./_dia-caracas.js";
import { fiadoDeFixture } from "./_fiado-de-fixture.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";

/**
 * El IGTF del contribuyente especial, de punta a punta (ADR-0072 §2; RESPUESTA §2.6) — E-02,
 * E-03, F-05, G-06 y L-15. RIGOR MÁXIMO: dinero, documento fiscal y libro.
 *
 *   · E-02: un SPE que NUNCA abrió /admin/igtf cobra en divisas y percibe — el interruptor ya no
 *     la apaga; el aviso de la caja dice lo mismo que el cobro;
 *   · F-05: en la ficha, «¿cuánto pagó?» es lo ENTREGADO: 10 USD son 9,71 a la factura y 0,29 de
 *     IGTF, y la cuenta sube 10 — no 10,30; con `absorb_igtf` el cliente paga el documento justo,
 *     la caja sube lo que entró y el IGTF se asienta como gasto;
 *   · E-03: la factura de la caja imprime alícuota y monto, en divisa y en Bs, en los tres
 *     destinos; el abono posterior emite la Nota de Débito por IGTF (control consumido, una
 *     línea no sujeta, libro con base 0 e IVA 0, nace pagada);
 *   · G-06: la devolución deja el IGTF percibido, la NC sin él y la pantalla recibe el aviso;
 *   · un ordinario no percibe;
 *   · los invariantes que cruzan módulos (cobertura contable, caja = mayor, libro = mayor) en 0.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const AYER = diaCaracas(-1);
const FUENTE = `BCV e2e-igtf-especial-${RUN}`;
const DUENO = crypto.randomUUID();
const ROL = crypto.randomUUID();

interface Empresa {
  tenant: string;
  company: string;
  w: string;
  cliente: string;
  producto: string;
  tipo: "especial" | "ordinario";
}
const nueva = (tipo: Empresa["tipo"]): Empresa => ({
  tenant: crypto.randomUUID(),
  company: crypto.randomUUID(),
  w: crypto.randomUUID(),
  cliente: crypto.randomUUID(),
  producto: "",
  tipo,
});
const SPE = nueva("especial");
const ORD = nueva("ordinario");
const SPE_USD = { producto: "", cliente: "" };

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

async function pedir(e: Empresa, metodo: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(DUENO)}`,
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

/** El TEXTO del PDF (misma técnica que e2e-checklist-factura: streams inflados, hex en WinAnsi). */
async function textoDelPdf(r: Response): Promise<string> {
  expect(r.status).toBe(200);
  const bruto = Buffer.from(await r.arrayBuffer());
  const { inflateSync } = await import("node:zlib");
  let texto = "";
  let i = 0;
  for (;;) {
    const s = bruto.indexOf("stream", i);
    if (s === -1) break;
    let inicio = s + 6;
    if (bruto[inicio] === 0x0d) inicio++;
    if (bruto[inicio] === 0x0a) inicio++;
    const fin = bruto.indexOf("endstream", inicio);
    if (fin === -1) break;
    const trozo = bruto.subarray(inicio, fin);
    try {
      texto += inflateSync(trozo).toString("latin1");
    } catch {
      texto += trozo.toString("latin1");
    }
    i = fin + 9;
  }
  const win = new TextDecoder("windows-1252");
  return [...texto.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map((m) => win.decode(Buffer.from(m[1]!, "hex")))
    .join("");
}
const plano = (s: string): string => s.replace(/\s+/g, "");
const tiene = (t: string, aguja: string): boolean => plano(t).includes(plano(aguja));
async function tresDestinos(e: Empresa, id: string): Promise<string[]> {
  return Promise.all(
    ["", "?destino=papel", "?destino=vista"].map(
      async (q) => await textoDelPdf(await pedir(e, "GET", `/v1/documents/${id}/pdf${q}`)),
    ),
  );
}

async function sembrar(e: Empresa): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${e.tenant}, ${`IGTF ${e.tipo}`})`;
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, fiscal_address, functional_currency_code,
                taxpayer_type_code)
             values (${e.company}, ${e.tenant}, ${`J-IGE-${e.tipo}-${RUN}`},
                     ${`IGTF ${e.tipo}, C.A.`}, 'Av. Lara, Barquisimeto', 'VES', ${e.tipo})`;
    // El especial lo es desde 2000 (fixture) y NUNCA activa el IGTF en /admin/igtf: es E-02.
    await declararTipoDeFixture(tx, e.company);
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${e.w}, ${e.tenant}, ${e.company}, 'IGE-W1', 'Principal')`;
    const mem = crypto.randomUUID();
    const asig = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${mem}, ${e.tenant}, ${DUENO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id)
             values (${asig}, ${e.tenant}, ${mem}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${e.tenant}, ${e.company}, ${asig}, 'warehouse', ${e.w})`;
    await tx`insert into public.customers
               (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                taxpayer_type_code, fiscal_address)
             values (${e.cliente}, ${e.tenant}, ${e.company}, ${`J-CIE-${e.tipo}-${RUN}`},
                     'Cliente del especial', 'juridica', 'ordinario', 'Calle 8, Maracay')`;
    // R-82.1: la factura de administración nace fiada — la empresa de prueba declara que fía.
    await fiadoDeFixture(tx, e.company, [ROL]);
    const [p] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${e.tenant}, ${e.company}, ${`IGE-${e.tipo}-${RUN}`}, 'Producto gravado', 'good',
              'active', 'unidad', 'gravado_general')
      returning id`;
    e.producto = p!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${e.tenant}, ${e.company}, ${`ige-${RUN}`}, 'VES') returning id`;
    // 1.000 Bs + IVA 16 % = 1.160 Bs; a 40 Bs/USD, 29 USD.
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${e.tenant}, ${e.company}, ${l!.id}, ${e.producto}, '1000.00000000',
                     ${AYER}::date)`;
    await tx`update public.customers set default_price_list_id = ${l!.id} where id = ${e.cliente}`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${e.tenant}, ${e.company}, 'formatos_libres', ${AYER}::timestamptz)`;
    await tx`insert into public.inventory_moves
               (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
                amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
                functional_currency, rate_source, rate_timestamp, rounding_policy_id,
                occurred_at, reference)
             values (${e.tenant}, ${e.company}, ${e.w}, ${e.producto}, 'entrada', 100, 50000,
                     'VES', 1, 50000, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP',
                     now(), ${`ige-seed-${e.tipo}-${RUN}`})`;
  });
  expect((await pedir(e, "POST", "/v1/fiscal/iva-general", { rate: "0.16" })).status).toBe(201);
  const rango = await pedir(e, "POST", "/v1/fiscal-number-ranges", {
    company_id: e.company,
    series: "A",
    range_from: "1",
    range_to: "500",
    printer_source: "Imprenta E2E igtf especial",
    printer_legal_name: "Imprenta E2E, C.A.",
    printer_tax_id: "J-12345678-9",
    printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
    printer_authorization_date: "2020-01-15",
    printed_on: "2026-09-01",
  });
  expect(rango.status, await rango.clone().text()).toBe(201);
  const plan = await pedir(e, "POST", "/v1/accounts/import-template", {
    company_id: e.company,
    template_code: "ve_basico",
  });
  expect(plan.status).toBe(201);
  const preset = await pedir(e, "POST", "/v1/journal-templates/import-preset", {
    company_id: e.company,
    preset_code: "ve_basico",
  });
  expect(preset.status).toBe(201);
}

interface Igtf {
  id: string;
  base_amount: string;
  amount: string;
  functional_amount: string;
  absorbed: boolean;
}
interface Cobro {
  payment: { id: string; amount: string; account_id: string | null; fx_rate: string };
  igtf: Igtf | null;
  balance: string;
  document_status: string;
  igtf_debit_note?: {
    id: string;
    series: string;
    document_number: number | null;
    control_display: string | null;
  } | null;
}
interface Venta {
  document: { id: string; total_amount: string; status: string };
  payments: Cobro[];
  igtf: { functional_amount: string } | null;
}

const venta = (e: Empresa, payments: unknown[]) =>
  pedir(e, "POST", "/v1/pos/sales", {
    company_id: e.company,
    customer_id: e.cliente,
    warehouse_id: e.w,
    lines: [{ product_id: e.producto, quantity: "1" }],
    payments,
  });
const facturar = async (e: Empresa): Promise<string> => {
  const f = await pedir(e, "POST", "/v1/invoices", {
    company_id: e.company,
    customer_id: e.cliente,
    warehouse_id: e.w,
    lines: [{ product_id: e.producto, quantity: "1" }],
  });
  expect(f.status, await f.clone().text()).toBe(201);
  return ((await f.json()) as { id: string }).id;
};
const saldoCuenta = async (cuenta: string): Promise<string> => {
  const [r] = await sql<{ b: string }[]>`
    select coalesce((select balance from public.company_account_balances
                      where account_id = ${cuenta}), 0)::text as b`;
  return r!.b;
};

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, ${`e2eige_${RUN}`}, 'Dueño igtf especial', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.payment.register'),
             (${ROL}, 'sales.return.manage'), (${ROL}, 'inventory.move'), (${ROL}, 'ar.read'),
             (${ROL}, 'fiscal.range.manage'), (${ROL}, 'tax.rules.manage'),
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.read'), (${ROL}, 'fiscal_book.read'),
             (${ROL}, 'company.settings.manage'), (${ROL}, 'accounting.entry.post'),
             (${ROL}, 'treasury.account.manage'), (${ROL}, 'treasury.read')
             on conflict do nothing`;
  });
  await sembrarTasaOficial(sql, { rate: "40", rate_date: HOY, source: FUENTE });
  await sembrar(SPE);
  await sembrar(ORD);
});

afterAll(async () => {
  await borrarTasasOficiales(sql, FUENTE);
  await sql.end();
  await sqlApi.end();
});

describe("E-02 · un especial percibe siempre, sin activar nada", () => {
  it("el estado dice que percibe, y la quincena en curso la da el servidor (L-15)", async () => {
    const r = await pedir(SPE, "GET", "/v1/igtf/status");
    expect(r.status).toBe(200);
    const e = (await r.json()) as {
      enabled: boolean;
      perceiving: boolean;
      absorbs: boolean;
      fortnight: { from: string; to: string };
    };
    expect(e.enabled).toBe(false); // nunca se activó el acta
    expect(e.perceiving).toBe(true);
    expect(e.absorbs).toBe(false);
    const [q] = await sql<{ desde: string; hasta: string }[]>`
      with d as (select ${HOY}::date as d)
      select (case when extract(day from d) <= 15 then date_trunc('month', d)::date
                   else date_trunc('month', d)::date + 15 end)::text as desde,
             (case when extract(day from d) <= 15 then date_trunc('month', d)::date + 14
                   else (date_trunc('month', d) + interval '1 month - 1 day')::date end)::text
               as hasta from d`;
    expect({ from: e.fortnight.from, to: e.fortnight.to }).toEqual({
      from: q!.desde,
      to: q!.hasta,
    });
  });

  it("el vencimiento de la quincena viene del calendario, o se dice que no hay (L-15)", async () => {
    const r = await pedir(SPE, "GET", "/v1/igtf/status");
    const e = (await r.json()) as {
      fortnight: { from: string; to: string; due: { date: string | null; status: string } };
    };
    // El oráculo es la función de la familia de la declaración, leída aparte (ADR-0072 §8).
    const [fila] = await sql<{ due_date: string | null; review_status: string }[]>`
      select due_date::text as due_date, review_status
        from platform.tax_due_date(${SPE.company}, 'igtf', ${e.fortnight.from}::date,
                                   ${e.fortnight.to}::date)`;
    if (fila === undefined) {
      expect(e.fortnight.due).toEqual({ date: null, status: "not_available", legal_source: null });
    } else {
      expect(e.fortnight.due.status).toBe(fila.review_status);
      // Pendiente de cotejo: la fecha va en null, nunca inventada.
      expect(e.fortnight.due.date).toBe(fila.due_date);
    }
  });

  it("un catálogo con zelle apagado (dato viejo) no apaga la percepción del especial", async () => {
    await sql`
      insert into public.igtf_company_instruments (tenant_id, company_id, instrument, causes)
      values (${SPE.tenant}, ${SPE.company}, 'zelle', false)
      on conflict (company_id, instrument) do update set causes = false`;
    const r = await pedir(SPE, "GET", "/v1/pos/igtf?amount=10.00&currency=USD&instrument=zelle");
    expect(((await r.json()) as { applies: boolean }).applies).toBe(true);
  });

  it("el aviso de la caja dice que causa, con la tasa de la regla", async () => {
    const r = await pedir(SPE, "GET", "/v1/pos/igtf?amount=10.00&currency=USD&instrument=zelle");
    const a = (await r.json()) as { applies: boolean; amount: string | null };
    expect(a.applies).toBe(true);
    expect(a.amount).toBe("0.30000000");
  });
});

describe("E-03 · la factura de la caja imprime el IGTF; F-05 · la caja lo suma al total", () => {
  let FACTURA = "";
  it("29,87 USD por Zelle pagan los 29 de la factura y los 0,87 de IGTF", async () => {
    const r = await venta(SPE, [{ instrument: "zelle", currency: "USD", amount: "29.87" }]);
    expect(r.status, await r.clone().text()).toBe(201);
    const v = (await r.json()) as Venta;
    expect(v.document.status).toBe("paid");
    expect(v.payments[0]!.igtf!.amount).toBe("0.87000000");
    expect(v.payments[0]!.igtf!.base_amount).toBe("29.00000000");
    // El cobro de la propia venta NO emite ND: su IGTF va en la factura.
    expect(v.payments[0]!.igtf_debit_note ?? null).toBeNull();
    FACTURA = v.document.id;
  });

  it("FC-27 · la factura imprime alícuota y monto, en divisa y en Bs a la tasa del cobro, en los tres destinos", async () => {
    for (const t of await tresDestinos(SPE, FACTURA)) {
      expect(tiene(t, "IGTF 3 % sobre USD 29,00 pagados en divisas: USD 0,87")).toBe(true);
      expect(tiene(t, `Bs. 34,80 a la tasa del ${HOY.slice(8, 10)}/${HOY.slice(5, 7)}`)).toBe(true);
    }
  });
});

describe("F-05 y E-03 · el abono posterior en la ficha: lo entregado incluye el IGTF y lleva su ND", () => {
  let COBRO: Cobro;
  let FACTURA = "";
  it("10 USD entregados son 9,71 a la factura y 0,29 de IGTF; la cuenta sube 10, no 10,30", async () => {
    FACTURA = await facturar(SPE);
    const r = await pedir(SPE, "POST", "/v1/payments", {
      company_id: SPE.company,
      document_id: FACTURA,
      currency: "USD",
      amount: "10",
      instrument: "zelle",
      igtf_included: true,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    COBRO = (await r.json()) as Cobro;
    expect(COBRO.payment.amount).toBe("9.71000000");
    expect(COBRO.igtf!.amount).toBe("0.29000000");
    expect(COBRO.igtf!.base_amount).toBe("9.71000000");
    // Nunca dinero que no entró: lo que falta sigue en la factura.
    expect(COBRO.document_status).toBe("issued");
    const [s] = await sql<{ entro: string }[]>`
      select (p.amount + ip.amount)::text as entro
        from public.payments p join public.igtf_perceptions ip on ip.payment_id = p.id
       where p.id = ${COBRO.payment.id}`;
    expect(s!.entro).toBe("10.00000000");
  });

  it("la ND por IGTF: referencia la factura, consume control, una línea no sujeta y nace pagada", async () => {
    const nd = COBRO.igtf_debit_note!;
    expect(nd).not.toBeNull();
    expect(nd.control_display).not.toBeNull();
    const [d] = await sql<
      {
        kind: string;
        status: string;
        source_document_id: string;
        total_amount: string;
        tax_amount: string;
        saldo: string;
        lineas: string;
        tratamiento: string;
        descripcion: string;
      }[]
    >`
      select d.kind, d.status, d.source_document_id, d.total_amount::text as total_amount,
             d.tax_amount::text as tax_amount,
             platform.document_balance(d.company_id, d.id)::text as saldo,
             (select count(*) from public.document_lines l where l.document_id = d.id)::text
               as lineas,
             (select l.tax_treatment from public.document_lines l where l.document_id = d.id)
               as tratamiento,
             (select l.description from public.document_lines l where l.document_id = d.id)
               as descripcion
        from public.documents d where d.id = ${nd.id}`;
    expect(d!.kind).toBe("debit_note");
    expect(d!.source_document_id).toBe(FACTURA);
    expect(d!.status).toBe("paid");
    expect(d!.lineas).toBe("1");
    expect(d!.tratamiento).toBe("no_sujeto");
    expect(d!.descripcion).toBe("IGTF 3 % sobre pago en divisas");
    expect(d!.tax_amount).toBe("0.00000000");
    expect(d!.total_amount).toBe(COBRO.igtf!.functional_amount);
    expect(d!.saldo).toBe("0.00000000");
  });

  it("el libro de ventas la lleva con base 0 e IVA 0, y el IGTF en lo no sujeto", async () => {
    const [l] = await sql<{ base: string; iva: string; no_sujeta: string; total: string }[]>`
      select base_gravada::text as base, iva_debito::text as iva,
             base_no_sujeta::text as no_sujeta, total_amount::text as total
        from platform.sales_book(${SPE.company}, ${HOY}::date, ${HOY}::date)
       where document_id = ${COBRO.igtf_debit_note!.id}`;
    expect(Number(l!.base)).toBe(0);
    expect(Number(l!.iva)).toBe(0);
    expect(l!.no_sujeta).toBe(l!.total);
  });

  it("su PDF imprime alícuota y monto en los tres destinos", async () => {
    for (const t of await tresDestinos(SPE, COBRO.igtf_debit_note!.id)) {
      expect(tiene(t, "IGTF 3 % sobre USD 9,71 pagados en divisas: USD 0,29")).toBe(true);
    }
  });
});

describe("F-05 · absorb_igtf: la empresa asume el IGTF", () => {
  afterAll(async () => {
    await pedir(SPE, "PUT", "/v1/company-settings", { absorb_igtf: false });
  });

  it("el cliente paga 29 justos, la caja sube 29 y el IGTF se asienta como gasto", async () => {
    const ajuste = await pedir(SPE, "PUT", "/v1/company-settings", { absorb_igtf: true });
    expect(ajuste.status).toBe(200);
    expect(((await ajuste.json()) as { absorb_igtf: boolean }).absorb_igtf).toBe(true);

    const r = await venta(SPE, [{ instrument: "zelle", currency: "USD", amount: "29.00" }]);
    expect(r.status, await r.clone().text()).toBe(201);
    const v = (await r.json()) as Venta;
    expect(v.document.status).toBe("paid");
    const cobro = v.payments[0]!;
    expect(cobro.igtf!.absorbed).toBe(true);
    expect(cobro.igtf!.amount).toBe("0.87000000");
    expect(v.igtf).toBeNull(); // el cliente no pagó IGTF
    const [s] = await sql<{ entro: string }[]>`
      select (p.amount + coalesce((select sum(ip.amount) from public.igtf_perceptions ip
                                    where ip.payment_id = p.id and not ip.absorbed), 0))::text
               as entro
        from public.payments p where p.id = ${cobro.payment.id}`;
    expect(s!.entro).toBe("29.00000000");
    const [a] = await sql<{ code: string; evento: string }[]>`
      select a.code, e.source_event as evento
        from public.journal_entries e
        join public.journal_lines jl on jl.entry_id = e.id and jl.debit_amount > 0
        join public.accounts a on a.id = jl.account_id
       where e.source_kind = 'igtf_perception' and e.source_id = ${cobro.igtf!.id}`;
    expect(a).toEqual({ code: "5.1.05", evento: "igtf.perception_absorbed" });
    // Lo absorbido no se le cobró al cliente: la factura no lo imprime.
    for (const t of await tresDestinos(SPE, v.document.id)) {
      expect(tiene(t, "IGTF 3 %")).toBe(false);
    }
  });
});

describe("G-06 · la devolución: el IGTF queda percibido", () => {
  it("la NC no lo lleva, el saldo a favor lo excluye y la respuesta trae el aviso", async () => {
    const r = await venta(SPE, [{ instrument: "zelle", currency: "USD", amount: "29.87" }]);
    expect(r.status, await r.clone().text()).toBe(201);
    const v = (await r.json()) as Venta;
    const [linea] = await sql<{ id: string }[]>`
      select id from public.document_lines where document_id = ${v.document.id}`;
    const borrador = await pedir(SPE, "POST", "/v1/returns", {
      company_id: SPE.company,
      source_document_id: v.document.id,
      warehouse_id: SPE.w,
      reason: "El cliente devolvió la mercancía",
      lines: [{ source_line_id: linea!.id, quantity: "1" }],
    });
    expect(borrador.status, await borrador.clone().text()).toBe(201);
    const dev = ((await borrador.json()) as { id: string }).id;
    const conf = await pedir(SPE, "POST", `/v1/returns/${dev}/confirm`, {});
    expect(conf.status, await conf.clone().text()).toBe(200);
    const c = (await conf.json()) as {
      credit_note_id: string;
      customer_credit_id: string;
      igtf_not_refunded: { amount: string; notice: string } | null;
    };
    expect(c.igtf_not_refunded!.amount).toBe("0.87000000");
    expect(c.igtf_not_refunded!.notice).toBe(
      "El IGTF de 0,87 $ ya fue enterado al SENIAT y no se devuelve.",
    );
    const [p] = await sql<{ status: string; nc: string; credito: string }[]>`
      select ip.status,
             (select total_amount::text from public.documents where id = ${c.credit_note_id})
               as nc,
             (select amount::text from public.customer_credits where id = ${c.customer_credit_id})
               as credito
        from public.igtf_perceptions ip where ip.document_id = ${v.document.id}`;
    expect(p!.status).toBe("percibido");
    expect(p!.nc).toBe(v.document.total_amount); // 1.160 Bs, sin el IGTF
    expect(p!.credito).toBe(v.document.total_amount);
  });
});

describe("A1 · PA SNAT/2022/000013 art. 1: causa el pago en divisas SIN mediación financiera", () => {
  const cobrar = async (instrument: string) => {
    const factura = await facturar(SPE);
    const r = await pedir(SPE, "POST", "/v1/payments", {
      company_id: SPE.company,
      document_id: factura,
      currency: "USD",
      amount: "5.00",
      instrument,
      igtf_included: false,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    return (await r.json()) as Cobro;
  };
  it("una transferencia en USD por un banco NO percibe", async () => {
    expect((await cobrar("transferencia")).igtf).toBeNull();
  });
  it("el efectivo en USD percibe", async () => {
    expect((await cobrar("efectivo_usd")).igtf?.amount).toBe("0.15000000");
  });
  it("Zelle percibe (decidido por criterio, VALIDAR-TRIBUTARIO P-66)", async () => {
    expect((await cobrar("zelle")).igtf?.amount).toBe("0.15000000");
  });
  it("la empresa no cambia la clasificación: 422 en los dos sentidos", async () => {
    for (const [instrument, causes] of [
      ["transferencia", true],
      ["efectivo_usd", false],
    ] as const) {
      const r = await pedir(SPE, "PUT", "/v1/igtf/instruments", {
        company_id: SPE.company,
        instrument,
        causes,
      });
      expect(r.status).toBe(422);
      expect(((await r.json()) as { message: string }).message).toContain(
        "no la decide la empresa",
      );
    }
  });
});

describe("revisión 1 · lo pendiente es la deuda de hoy, no el saldo de la emisión", () => {
  const FUENTE_50 = `${FUENTE}-50`;
  afterAll(async () => {
    await borrarTasasOficiales(sql, FUENTE_50);
  });
  it("factura de 100 USD a 40, cobro a 50: entregados 103 = 100 a la factura + 3 de IGTF, pagada", async () => {
    // Un cliente con lista en USD y un producto exento de 100 USD: la factura vale 100 USD justos.
    const cliente = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      const [p] = await tx<{ id: string }[]>`
        insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                     tax_category_code)
        values (${SPE.tenant}, ${SPE.company}, ${`IGE-USD-${RUN}`}, 'Servicio en dólares',
                'service', 'active', 'unidad', 'exento') returning id`;
      const [l] = await tx<{ id: string }[]>`
        insert into public.price_lists (tenant_id, company_id, name, currency_code)
        values (${SPE.tenant}, ${SPE.company}, ${`ige-usd-${RUN}`}, 'USD') returning id`;
      await tx`insert into public.price_list_items
                 (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
               values (${SPE.tenant}, ${SPE.company}, ${l!.id}, ${p!.id}, '100', ${AYER}::date)`;
      await tx`insert into public.customers
                 (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                  taxpayer_type_code, fiscal_address, default_price_list_id)
               values (${cliente}, ${SPE.tenant}, ${SPE.company}, ${`J-CUS-${RUN}`},
                       'Cliente en dólares', 'juridica', 'ordinario', 'Calle 9, Valencia',
                       ${l!.id})`;
      await fiadoDeFixture(tx, SPE.company);
      SPE_USD.producto = p!.id;
    });
    const f = await pedir(SPE, "POST", "/v1/invoices", {
      company_id: SPE.company,
      customer_id: cliente,
      warehouse_id: SPE.w,
      lines: [{ product_id: SPE_USD.producto, quantity: "1" }],
    });
    expect(f.status, await f.clone().text()).toBe(201);
    const factura = (await f.json()) as { id: string; fx_rate: string };
    expect(Number(factura.fx_rate)).toBe(40);
    await sembrarTasaOficial(sql, { rate: "50", rate_date: HOY, source: FUENTE_50 });
    const r = await pedir(SPE, "POST", "/v1/payments", {
      company_id: SPE.company,
      document_id: factura.id,
      currency: "USD",
      amount: "103",
      instrument: "zelle",
    });
    await borrarTasasOficiales(sql, FUENTE_50);
    expect(r.status, await r.clone().text()).toBe(201);
    const c = (await r.json()) as Cobro;
    expect(c.payment.amount).toBe("100.00000000");
    expect(c.igtf!.amount).toBe("3.00000000");
    expect(c.document_status).toBe("paid");
    SPE_USD.cliente = cliente;
  });

  it("F1 · cobro con paid_at de AYER, a la tasa de ayer: 103 entregado = 100 + 3, pagada", async () => {
    const FUENTE_AYER = `${FUENTE}-ayer`;
    const f = await pedir(SPE, "POST", "/v1/invoices", {
      company_id: SPE.company,
      customer_id: SPE_USD.cliente,
      warehouse_id: SPE.w,
      lines: [{ product_id: SPE_USD.producto, quantity: "1" }],
    });
    expect(f.status, await f.clone().text()).toBe(201);
    const factura = (await f.json()) as { id: string; fx_rate: string };
    await sembrarTasaOficial(sql, { rate: "45", rate_date: AYER, source: FUENTE_AYER });
    try {
      const r = await pedir(SPE, "POST", "/v1/payments", {
        company_id: SPE.company,
        document_id: factura.id,
        currency: "USD",
        amount: "103",
        instrument: "zelle",
        paid_at: `${AYER}T16:00:00.000Z`,
      });
      expect(r.status, await r.clone().text()).toBe(201);
      const c = (await r.json()) as Cobro;
      expect(Number(c.payment.fx_rate)).not.toBe(Number(factura.fx_rate));
      expect(c.payment.amount).toBe("100.00000000");
      expect(c.igtf!.amount).toBe("3.00000000");
      expect(c.document_status).toBe("paid");
    } finally {
      await borrarTasasOficiales(sql, FUENTE_AYER);
    }
  });
});

describe("revisión 3 · la ND por IGTF encolada recupera su asiento al importar el pendiente", () => {
  it("caja sin cuenta contable → cola → se mapea → importar → cobertura en cero", async () => {
    const r0 = await pedir(SPE, "POST", "/v1/treasury/accounts", {
      company_id: SPE.company,
      name: `Zelle sin mapear ${RUN}`,
      currency: "USD",
      kind: "wallet",
    });
    expect(r0.status, await r0.clone().text()).toBe(201);
    const cuenta = ((await r0.json()) as { id: string }).id;
    const [antes] = await sql<{ ledger: string }[]>`
      select ledger_account_id::text as ledger from public.company_accounts where id = ${cuenta}`;
    await sql`update public.company_accounts set ledger_account_id = null where id = ${cuenta}`;
    const factura = await facturar(SPE);
    const r = await pedir(SPE, "POST", "/v1/payments", {
      company_id: SPE.company,
      document_id: factura,
      currency: "USD",
      amount: "10",
      instrument: "zelle",
      account_id: cuenta,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const nd = ((await r.json()) as Cobro).igtf_debit_note!;
    const huecos = await sql<{ source_id: string }[]>`
      select source_id from platform.accounting_coverage_gaps(${SPE.company})`;
    // Re-revisión 3 (20261002100200): la ND está cubierta por su percepción EN COLA — el
    // enunciado del invariante lo dice; no aparece como hueco mientras el pendiente espera.
    expect(huecos.map((h) => h.source_id)).not.toContain(nd.id);
    const [cola] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.journal_generation_queue q
        join public.igtf_perceptions ip on ip.id = q.source_id
       where ip.debit_note_id = ${nd.id} and q.status = 'pending'`;
    expect(cola!.n).toBe(1);
    await sql`update public.company_accounts set ledger_account_id = ${antes!.ledger}::uuid
               where id = ${cuenta}`;
    const imp = await pedir(SPE, "POST", "/v1/accounting/pending/process", {});
    expect(imp.status, await imp.clone().text()).toBe(200);
    expect(await sql`select * from platform.accounting_coverage_gaps(${SPE.company})`).toEqual([]);
    const [d] = await sql<{ con: boolean }[]>`
      select journal_entry_id is not null as con from public.documents where id = ${nd.id}`;
    expect(d!.con).toBe(true);
  });
});

describe("revisión 2 · la cartera no cuenta como deuda la ND por IGTF pagada por su percepción", () => {
  it("Σ antigüedad = Σ saldo único de los documentos con saldo", async () => {
    const [r] = await sql<{ cartera: string; saldos: string }[]>`
      select (select coalesce(sum(amount), 0) from platform.ar_aging(${SPE.company}, ${SPE.cliente}))::text
               as cartera,
             (select coalesce(sum(s), 0) from (
                select platform.document_balance(${SPE.company}, d.id) as s
                  from public.documents d
                 where d.company_id = ${SPE.company} and d.customer_id = ${SPE.cliente}
                   and d.kind in ('invoice', 'receipt', 'debit_note')
                   and d.status in ('issued', 'paid')) x where s > 0)::text as saldos`;
    expect(r!.cartera).toBe(r!.saldos);
    // Y la cartera es exactamente la de los documentos que NO son ND por IGTF: el total de esas
    // ND (pagadas por su percepción) no aparece en ningún tramo.
    const [sinNd] = await sql<{ t: string; nd_total: string }[]>`
      select coalesce(sum(platform.document_balance(${SPE.company}, d.id))
                        filter (where platform.document_balance(${SPE.company}, d.id) > 0
                                  and not exists (select 1 from public.igtf_perceptions ip
                                                   where ip.debit_note_id = d.id)), 0)::text as t,
             coalesce(sum(d.total_amount) filter (where exists (
                 select 1 from public.igtf_perceptions ip where ip.debit_note_id = d.id)), 0)::text
               as nd_total
        from public.documents d
       where d.company_id = ${SPE.company} and d.customer_id = ${SPE.cliente}
         and d.kind in ('invoice', 'receipt', 'debit_note') and d.status in ('issued', 'paid')`;
    expect(r!.cartera).toBe(sinNd!.t);
    expect(Number(sinNd!.nd_total)).toBeGreaterThan(0);
    const [nd] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.igtf_perceptions ip
       where ip.company_id = ${SPE.company} and ip.debit_note_id is not null`;
    expect(nd!.n).toBeGreaterThan(0);
  });
});

describe("revisión 4 · el producto de sistema no es catálogo", () => {
  it("existe por su marca, no sale en /v1/products y no se vende", async () => {
    const [p] = await sql<{ id: string }[]>`
      select id from public.products where company_id = ${SPE.company} and system_code = 'igtf'`;
    expect(p).toBeDefined();
    const r = await pedir(SPE, "GET", "/v1/products?per_page=200&include_inactive=true");
    const lista = (await r.json()) as { items: { id: string }[] };
    expect(lista.items.map((i) => i.id)).not.toContain(p!.id);
    const intento = await pedir(SPE, "POST", "/v1/invoices", {
      company_id: SPE.company,
      customer_id: SPE.cliente,
      warehouse_id: SPE.w,
      lines: [{ product_id: p!.id, quantity: "1" }],
    });
    expect(intento.status).toBe(422);
    // El rechazo es el del producto de SISTEMA, no el de «inactivo» (re-revisión 4).
    expect(((await intento.json()) as { message: string }).message).toContain(
      "es un producto de sistema: solo lo usa la Nota de Débito por IGTF",
    );
  });

  it("una ND tecleada tampoco lo usa: 422 con el mensaje del producto de sistema", async () => {
    const [p] = await sql<{ id: string }[]>`
      select id from public.products where company_id = ${SPE.company} and system_code = 'igtf'`;
    const factura = await facturar(SPE);
    const nd = await pedir(SPE, "POST", "/v1/debit-notes", {
      company_id: SPE.company,
      source_document_id: factura,
      reason: "Intento de usar el producto de sistema",
      lines: [{ product_id: p!.id, quantity: "1", unit_price: "10" }],
    });
    expect(nd.status).toBe(422);
    expect(((await nd.json()) as { message: string }).message).toContain(
      "es un producto de sistema: solo lo usa la Nota de Débito por IGTF",
    );
  });
});

describe("re-revisión 6 · un especial no cobra en divisas como «otro»", () => {
  it("422: regístralo con su instrumento verdadero", async () => {
    const factura = await facturar(SPE);
    const r = await pedir(SPE, "POST", "/v1/payments", {
      company_id: SPE.company,
      document_id: factura,
      currency: "USD",
      amount: "5",
      instrument: "otro",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain(
      "regístralo con su instrumento verdadero",
    );
  });
});

describe("un ordinario no percibe", () => {
  it("ni en la caja ni en la ficha, y no hay ND", async () => {
    const r = await venta(ORD, [{ instrument: "zelle", currency: "USD", amount: "29.00" }]);
    expect(r.status, await r.clone().text()).toBe(201);
    expect(((await r.json()) as Venta).payments[0]!.igtf).toBeNull();
    const factura = await facturar(ORD);
    const c = await pedir(ORD, "POST", "/v1/payments", {
      company_id: ORD.company,
      document_id: factura,
      currency: "USD",
      amount: "10",
      instrument: "zelle",
      igtf_included: true,
    });
    expect(c.status, await c.clone().text()).toBe(201);
    const cobro = (await c.json()) as Cobro;
    expect(cobro.igtf).toBeNull();
    expect(cobro.payment.amount).toBe("10.00000000");
    expect(cobro.igtf_debit_note ?? null).toBeNull();
  });
});

describe("los invariantes que cruzan módulos siguen en cero", () => {
  it("cobertura contable, caja = mayor y libro = mayor + cola", async () => {
    for (const e of [SPE, ORD]) {
      const gaps = await sql`select * from platform.accounting_coverage_gaps(${e.company})`;
      expect(gaps).toEqual([]);
      const caja = await sql`select * from platform.treasury_ledger_gaps(${e.company})`;
      expect(caja).toEqual([]);
      const libro = await sql<{ concepto: string; cuadra: boolean }[]>`
        select concepto, cuadra
          from platform.book_ledger_reconciliation(${e.company}, ${HOY}::date, ${HOY}::date)
         where not cuadra`;
      expect(libro).toEqual([]);
    }
  });
});

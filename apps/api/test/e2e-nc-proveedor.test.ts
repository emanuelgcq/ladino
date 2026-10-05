import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";

/**
 * H-03 (ola 5, ADR-0083), segunda pasada: LA NOTA DE CRÉDITO DEL PROVEEDOR, de extremo a extremo
 * en una empresa PROPIA con contabilidad, para poder aseverar los invariantes en cero ABSOLUTO.
 *
 * Lo que demuestra, caso por caso (cada uno nació en rojo):
 *   · el saldo a favor con el proveedor va a SU cuenta (un activo), la cuenta por pagar de la
 *     factura saldada queda en cero y `supplier_credit_ledger_gap` cuadra lo declarado con el mayor;
 *   · una línea de factura no se abona dos veces en la misma nota;
 *   · con recepción manda el depósito de la recepción; el enviado solo vale para la línea sin ella;
 *   · no se devuelve lo que no está, aunque la empresa permita existencia negativa;
 *   · lotes: la rebaja revaloriza lo que quede del producto donde esté, y la devolución sale del
 *     lote que diga la persona (nunca por FEFO);
 *   · con el ajuste del kardex en la cola y el asiento de la nota posteado, el movimiento no
 *     sale «duplicated»;
 *   · quien solo lleva gastos no lee las líneas de una factura de mercancía;
 *   · el IVA que manda el cliente no puede diferir del que calcula el servidor.
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
const W1 = crypto.randomUUID();
const W2 = crypto.randomUUID();
const DUENO = crypto.randomUUID();
/** Quien SOLO lleva gastos: `expense.register`, nada de compras. */
const GASTOS = crypto.randomUUID();
const PROVEEDOR = crypto.randomUUID();
const ROL = crypto.randomUUID();
const ROL_GASTOS = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const AYER = diaCaracas(-1);
/** El último día del mes pasado (K-04). */
const FIN_MES_PASADO = new Date(Date.UTC(Number(HOY.slice(0, 4)), Number(HOY.slice(5, 7)) - 1, 0))
  .toISOString()
  .slice(0, 10);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let HARINA = "";
let ACEITE = "";
let SAL = "";
let LECHE = "";

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
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(quien)}`,
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

async function saldoPapel(purpose: string): Promise<number> {
  const [s] = await sql<{ s: string }[]>`
    select coalesce(sum(jl.functional_debit - jl.functional_credit), 0)::text as s
      from public.journal_lines jl
      join public.journal_entries e on e.id = jl.entry_id
     where jl.company_id = ${COMPANY} and e.status in ('posted', 'reversed')
       and jl.account_id in (select account_id from public.company_account_settings
                              where company_id = ${COMPANY} and purpose = ${purpose})`;
  return Number(s!.s);
}

async function existencia(
  producto: string,
  deposito: string,
  lote: string | null = null,
): Promise<{ q: number; v: number }> {
  const [b] = await sql<{ q: string; v: string }[]>`
    select coalesce(sum(quantity), 0)::text as q, coalesce(sum(value), 0)::text as v
      from public.stock_balances
     where company_id = ${COMPANY} and warehouse_id = ${deposito} and product_id = ${producto}
       and (${lote}::uuid is null or lot_id = ${lote}::uuid)`;
  return { q: Number(b!.q), v: Number(b!.v) };
}

/** Los invariantes que esta familia cruza, en cero ABSOLUTO. */
async function invariantes(): Promise<Record<string, number>> {
  const [n] = await sql<Record<string, string>[]>`
    select (select count(*) from platform.accounting_coverage_gaps(${COMPANY}))::text as cobertura,
           (select count(*) from platform.inventory_coverage_gaps(${COMPANY}))::text as kardex,
           (select diferencia from platform.inventory_ledger_gap(${COMPANY}))::text as brecha,
           (select count(*) from platform.settled_ledger_gaps(${COMPANY}))::text as saldados,
           (select count(*) from platform.supplier_credit_ledger_gap(${COMPANY}))::text as a_favor,
           (select count(*)
              from platform.supplier_credit_subledger_gaps(${COMPANY}))::text as auxiliar,
           (select count(*) from platform.cent_gaps(${COMPANY}))::text as centimo,
           (select count(*) from platform.retention_voucher_gaps(${COMPANY}))::text as comprobantes,
           (select count(*)
              from platform.book_ledger_reconciliation(${COMPANY}, ${HOY}::date, ${HOY}::date) b
             where not b.cuadra)::text as libro`;
  return Object.fromEntries(Object.entries(n!).map(([k, v]) => [k, Number(v)]));
}
const EN_CERO = {
  cobertura: 0,
  kardex: 0,
  brecha: 0,
  saldados: 0,
  a_favor: 0,
  auxiliar: 0,
  centimo: 0,
  comprobantes: 0,
  libro: 0,
};

/** Recibe en un depósito y devuelve la línea de la recepción. */
async function recibir(
  deposito: string,
  producto: string,
  cantidad: string,
  precio: string,
  lote?: { lot_code: string; lot_expires_at: string },
): Promise<string> {
  const rec = await pedir("POST", "/v1/goods-receipts", {
    company_id: COMPANY,
    supplier_id: PROVEEDOR,
    warehouse_id: deposito,
    currency: "VES",
    lines: [{ product_id: producto, quantity: cantidad, unit_price: precio, ...(lote ?? {}) }],
  });
  expect(rec.status, await rec.clone().text()).toBe(201);
  const [linea] = await sql<{ id: string }[]>`
    select id from public.goods_receipt_lines
     where goods_receipt_id = ${((await rec.json()) as { id: string }).id}`;
  return linea!.id;
}

let nFactura = 0;
/** Registra una factura y devuelve su id y los de sus líneas, en orden. */
async function facturar(
  lineas: { product_id: string; quantity: string; unit_price: string; recepcion?: string }[],
  fecha: string = HOY,
): Promise<{ id: string; lineas: string[] }> {
  nFactura += 1;
  const f = await pedir("POST", "/v1/supplier-invoices", {
    company_id: COMPANY,
    supplier_id: PROVEEDOR,
    supplier_document_number: `F-NCP-${RUN}-${nFactura}`,
    supplier_control_number: `00-${RUN}-${nFactura}`,
    invoice_date: fecha,
    currency: "VES",
    lines: lineas.map((l) => ({
      product_id: l.product_id,
      quantity: l.quantity,
      unit_price: l.unit_price,
      ...(l.recepcion === undefined ? {} : { goods_receipt_line_id: l.recepcion }),
    })),
  });
  expect(f.status, await f.clone().text()).toBe(201);
  const id = ((await f.json()) as { id: string }).id;
  const filas = await sql<{ id: string }[]>`
    select id from public.supplier_invoice_lines
     where supplier_invoice_id = ${id} order by line_number`;
  return { id, lineas: filas.map((x) => x.id) };
}

let nPago = 0;
/** Paga (o intenta pagar) una factura en bolívares, por transferencia. */
function pagar(factura: string, importe: string): Promise<Response> {
  nPago += 1;
  return pedir("POST", "/v1/supplier-payments", {
    company_id: COMPANY,
    supplier_invoice_id: factura,
    gross_amount: importe,
    currency: "VES",
    instrument: "transferencia",
    reference: `TRF-NCP-${RUN}-${nPago}`,
    allow_negative_balance: true,
    overdraft_reason: "Fixture E2E: se confirma el sobregiro con su motivo",
  });
}

let nNota = 0;
function nota(factura: string, extra: Record<string, unknown>, quien: string = DUENO) {
  nNota += 1;
  return pedir(
    "POST",
    "/v1/supplier-credit-notes",
    {
      company_id: COMPANY,
      supplier_invoice_id: factura,
      supplier_document_number: `NC-NCP-${RUN}-${nNota}`,
      supplier_control_number: `00-NC-${RUN}-${nNota}`,
      note_date: HOY,
      currency: "VES",
      reason: "Fixture H-03, segunda pasada",
      ...extra,
    },
    quien,
  );
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}), (${GASTOS}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e nc proveedor')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code,
                                           activity_start_date)
             values (${COMPANY}, ${TENANT}, ${`J-NCP-${RUN}`}, 'Bodega nc proveedor', 'VES',
                     'ordinario',
                     -- K-04: la empresa opera desde antes del mes pasado, para poder CERRARLO.
                     (date_trunc('month', ${HOY}::date) - interval '2 month')::date)`;
    await declararTipoDeFixture(tx, COMPANY);
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'NCP-W1', 'Local'),
                    (${W2}, ${TENANT}, ${COMPANY}, 'NCP-W2', 'Depósito')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2encp_${RUN}`}, 'Dueño', true),
             (${ROL_GASTOS}, null, ${`e2encpg_${RUN}`}, 'Solo gastos', false)`;
    // Todo, MENOS despachar lo vencido: ese permiso tiene su propio caso.
    await tx`insert into public.role_permissions (role_id, permission_key)
             select ${ROL}, key from public.permissions where key <> 'inventory.expired'`;
    await tx`insert into public.role_permissions (role_id, permission_key)
             values (${ROL_GASTOS}, 'expense.register')`;
    const mem = crypto.randomUUID();
    const memGastos = crypto.randomUUID();
    const asig = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${mem}, ${TENANT}, ${DUENO}), (${memGastos}, ${TENANT}, ${GASTOS})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${asig}, ${TENANT}, ${mem}, ${ROL}, null)`;
    await tx`insert into public.user_role_assignments
               (tenant_id, membership_id, role_id, company_id) values
             (${TENANT}, ${memGastos}, ${ROL_GASTOS}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, ${asig}, 'warehouse', ${W1}),
                    (${TENANT}, ${COMPANY}, ${asig}, 'warehouse', ${W2})`;
    await tx`insert into public.suppliers
               (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code,
                taxpayer_type_code)
             values (${PROVEEDOR}, ${TENANT}, ${COMPANY}, ${`J-PRV-NCP-${RUN}`},
                     'Mayorista nc proveedor', 'nacional', 'juridica', 'ordinario')`;
    const prods = await tx<{ id: string; sku: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code, tracks_lots, tracks_expiry)
      values (${TENANT}, ${COMPANY}, ${`NCP-HAR-${RUN}`}, 'Harina', 'good', 'active', 'unidad',
              'gravado_general', false, false),
             (${TENANT}, ${COMPANY}, ${`NCP-ACE-${RUN}`}, 'Aceite', 'good', 'active', 'unidad',
              'gravado_general', false, false),
             (${TENANT}, ${COMPANY}, ${`NCP-SAL-${RUN}`}, 'Sal', 'good', 'active', 'unidad',
              'gravado_general', false, false),
             (${TENANT}, ${COMPANY}, ${`NCP-LEC-${RUN}`}, 'Leche', 'good', 'active', 'unidad',
              'gravado_general', true, true)
      returning id, sku`;
    HARINA = prods.find((p) => p.sku.startsWith("NCP-HAR"))!.id;
    ACEITE = prods.find((p) => p.sku.startsWith("NCP-ACE"))!.id;
    SAL = prods.find((p) => p.sku.startsWith("NCP-SAL"))!.id;
    LECHE = prods.find((p) => p.sku.startsWith("NCP-LEC"))!.id;
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
    await tx`
      insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                                    rate, effective_from, legal_source, priority, transaction_type)
      select 'VE', 'iva', 'ordinario', 'gravado_general', 0.16, ${AYER}::date,
             'Carga de prueba E2E — VALIDAR-SENIAT antes de producción.', 10, 'purchase'
       where not exists (select 1 from public.tax_rules
                          where company_id is null and jurisdiction = 'VE' and tax_code = 'iva'
                            and taxpayer_type = 'ordinario'
                            and product_tax_category = 'gravado_general'
                            and transaction_type = 'purchase')`;
    // K-04: la factura del mes pasado necesita su regla vigente ESE día. Propia de la empresa,
    // para no mover la regla global que comparten los demás E2E.
    await tx`
      insert into public.tax_rules (tenant_id, company_id, jurisdiction, tax_code, taxpayer_type,
                                    product_tax_category, rate, effective_from, legal_source,
                                    priority, transaction_type)
      values (${TENANT}, ${COMPANY}, 'VE', 'iva', 'ordinario', 'gravado_general', 0.16,
              (date_trunc('month', ${HOY}::date) - interval '2 month')::date,
              'Carga de prueba E2E — VALIDAR-SENIAT antes de producción.', 10, 'purchase')`;
  });
  for (const [ruta, cuerpo] of [
    ["/v1/accounts/import-template", { company_id: COMPANY, template_code: "ve_basico" }],
    ["/v1/journal-templates/import-preset", { company_id: COMPANY, preset_code: "ve_basico" }],
  ] as const) {
    expect((await pedir("POST", ruta, cuerpo)).status).toBe(201);
  }
  // K-04: el plan y las plantillas rigen desde siempre (importados hoy, regirían desde hoy y un
  // asiento fechado el mes pasado iría a la cola por «falta configurar la cuenta»).
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`update public.company_account_settings set effective_from = '-infinity'
              where company_id = ${COMPANY}`;
    await tx`update public.journal_templates set effective_from = '-infinity'
              where company_id = ${COMPANY}`;
  });
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("H-03 · la nota de crédito del proveedor, segunda pasada", () => {
  it("1 · sobre una factura PAGADA, el saldo a favor va a su cuenta de activo y la cuenta por pagar de la factura queda en cero", async () => {
    const rec = await recibir(W1, HARINA, "4", "50");
    const f = await facturar([
      { product_id: HARINA, quantity: "4", unit_price: "50", recepcion: rec },
    ]);
    // 4 × 50 + 16 % = 232, pagados enteros.
    const pago = await pedir("POST", "/v1/supplier-payments", {
      company_id: COMPANY,
      supplier_invoice_id: f.id,
      gross_amount: "232.00000000",
      currency: "VES",
      instrument: "transferencia",
      reference: `TRF-NCP-${RUN}`,
      allow_negative_balance: true,
      overdraft_reason: "Fixture E2E: se confirma el sobregiro con su motivo",
    });
    expect(pago.status, await pago.clone().text()).toBe(201);
    expect(((await pago.json()) as { invoice_status: string }).invoice_status).toBe("paid");

    // El proveedor rebaja 10 por unidad en 2 unidades: 20 + 3,20 de IVA.
    const r = await nota(f.id, {
      kind: "rebaja",
      lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "2", unit_price: "10" }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const n = (await r.json()) as { id: string; total_amount: string };
    expect(n.total_amount).toBe("23.20000000");

    const [fila] = await sql<{ favor: string; abierto: string }[]>`
      select n.credit_in_favor_functional::text as favor,
             platform.settlement_ledger_open(${COMPANY}, 'ap', ${f.id})::text as abierto
        from public.supplier_credit_notes n where n.id = ${n.id}`;
    expect(Number(fila!.favor)).toBe(23.2);
    // La cuenta por pagar de la factura saldada queda en CERO: el saldo a favor no vive ahí.
    expect(Number(fila!.abierto)).toBe(0);
    expect(await saldoPapel("supplier_credit_receivable")).toBe(23.2);
    expect(await invariantes()).toEqual(EN_CERO);
  });

  it("1b · sobre una factura que todavía se debe, la nota baja la deuda y NO deja saldo a favor", async () => {
    const antes = await saldoPapel("supplier_credit_receivable");
    const rec = await recibir(W1, HARINA, "2", "50");
    const f = await facturar([
      { product_id: HARINA, quantity: "2", unit_price: "50", recepcion: rec },
    ]);
    const r = await nota(f.id, {
      kind: "rebaja",
      lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "2", unit_price: "5" }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const n = (await r.json()) as { id: string; balance: string };
    // 116 − 11,60.
    expect(n.balance).toBe("104.40000000");
    const [fila] = await sql<{ favor: string }[]>`
      select credit_in_favor_functional::text as favor
        from public.supplier_credit_notes where id = ${n.id}`;
    expect(Number(fila!.favor)).toBe(0);
    expect(await saldoPapel("supplier_credit_receivable")).toBe(antes);
    expect(await invariantes()).toEqual(EN_CERO);
  });

  it("2 · la misma línea de la factura no se abona dos veces en una nota (3 + 3 sobre 4 facturadas): 422 y no queda nada", async () => {
    const rec = await recibir(W1, HARINA, "4", "50");
    const f = await facturar([
      { product_id: HARINA, quantity: "4", unit_price: "50", recepcion: rec },
    ]);
    const stock = await existencia(HARINA, W1);
    const r = await nota(f.id, {
      kind: "devolucion",
      lines: [
        { supplier_invoice_line_id: f.lineas[0], quantity: "3", unit_price: "10" },
        { supplier_invoice_line_id: f.lineas[0], quantity: "3", unit_price: "10" },
      ],
    });
    expect(r.status, await r.clone().text()).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain("más de una vez");
    expect(await existencia(HARINA, W1)).toEqual(stock);
  });

  it("3 · factura MIXTA: con recepción manda el depósito de la recepción; el enviado solo vale para la línea sin recepción", async () => {
    const rec = await recibir(W1, HARINA, "2", "50");
    // El aceite está en el OTRO depósito y su línea de factura no viene de una recepción.
    await recibir(W2, ACEITE, "3", "20");
    const f = await facturar([
      { product_id: HARINA, quantity: "2", unit_price: "50", recepcion: rec },
      { product_id: ACEITE, quantity: "3", unit_price: "20" },
    ]);
    const harina = { w1: await existencia(HARINA, W1), w2: await existencia(HARINA, W2) };
    const aceite = await existencia(ACEITE, W2);
    const r = await nota(f.id, {
      kind: "devolucion",
      warehouse_id: W2,
      lines: [
        { supplier_invoice_line_id: f.lineas[0], quantity: "1", unit_price: "50" },
        { supplier_invoice_line_id: f.lineas[1], quantity: "1", unit_price: "20" },
      ],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    // La harina sale de W1 (su recepción), no de W2 (el enviado); el aceite, de W2.
    expect((await existencia(HARINA, W1)).q).toBe(harina.w1.q - 1);
    expect((await existencia(HARINA, W2)).q).toBe(harina.w2.q);
    expect((await existencia(ACEITE, W2)).q).toBe(aceite.q - 1);
    expect(await invariantes()).toEqual(EN_CERO);
  });

  it("4 · no se devuelve lo que no está, AUNQUE la empresa permita existencia negativa: 409 con su mensaje", async () => {
    const rec = await recibir(W1, SAL, "2", "10");
    const f = await facturar([
      { product_id: SAL, quantity: "2", unit_price: "10", recepcion: rec },
    ]);
    // La sal ya no está: se dio de baja entera.
    const baja = await pedir("POST", "/v1/inventory/adjustments", {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: SAL,
      delta: "-2",
      reason: "merma por rotura",
    });
    expect(baja.status, await baja.clone().text()).toBe(201);
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`insert into public.inventory_settings (tenant_id, company_id, allow_negative_stock)
               values (${TENANT}, ${COMPANY}, true)
               on conflict (company_id) do update set allow_negative_stock = true`;
    });
    try {
      const r = await nota(f.id, {
        kind: "devolucion",
        lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "1", unit_price: "10" }],
      });
      expect(r.status, await r.clone().text()).toBe(409);
      expect(((await r.json()) as { message: string }).message).toContain(
        "Ya no tienes esa mercancía para devolverla",
      );
      expect((await existencia(SAL, W1)).q).toBe(0);
    } finally {
      await sql.begin(async (tx) => {
        await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
        await tx`update public.inventory_settings set allow_negative_stock = false
                  where company_id = ${COMPANY}`;
      });
    }
    // Lo que sí vale: el proveedor la abonó igual → rebaja, toda a variación (no queda nada).
    const rebaja = await nota(f.id, {
      kind: "rebaja",
      lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "1", unit_price: "10" }],
    });
    expect(rebaja.status, await rebaja.clone().text()).toBe(201);
    expect(await invariantes()).toEqual(EN_CERO);
  });

  it("5 · LOTES: la rebaja de una línea sin recepción revaloriza lo que quede del producto donde esté; la devolución sale del lote que diga la persona, no por FEFO", async () => {
    // Dos lotes de leche en W1: el A vence antes (FEFO lo elegiría), el B después.
    await recibir(W1, LECHE, "2", "30", { lot_code: `A-${RUN}`, lot_expires_at: diaCaracas(20) });
    await recibir(W1, LECHE, "2", "30", { lot_code: `B-${RUN}`, lot_expires_at: diaCaracas(90) });
    const lotes = await sql<{ id: string; code: string }[]>`
      select id, code from public.lots where company_id = ${COMPANY} and product_id = ${LECHE}`;
    const loteA = lotes.find((l) => l.code.startsWith("A-"))!.id;
    const loteB = lotes.find((l) => l.code.startsWith("B-"))!.id;
    // La factura llega aparte, sin enlazar la recepción.
    const f = await facturar([{ product_id: LECHE, quantity: "4", unit_price: "30" }]);

    // (a) Rebaja de 5 por unidad en 2 unidades: hay 4 en existencia → 10 al kardex, 0 a variación.
    const variacion = await saldoPapel("purchase_cost_variance");
    const valor = (await existencia(LECHE, W1)).v;
    const rebaja = await nota(f.id, {
      kind: "rebaja",
      lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "2", unit_price: "5" }],
    });
    expect(rebaja.status, await rebaja.clone().text()).toBe(201);
    expect(valor - (await existencia(LECHE, W1)).v).toBe(10);
    expect(await saldoPapel("purchase_cost_variance")).toBe(variacion);

    // (b) Devolución sin decir el lote: no se adivina.
    const sinLote = await nota(f.id, {
      kind: "devolucion",
      warehouse_id: W1,
      lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "1", unit_price: "30" }],
    });
    expect(sinLote.status, await sinLote.clone().text()).toBe(422);
    expect(((await sinLote.json()) as { message: string }).message).toContain("lote");
    // Con el lote B —el que FEFO NO elegiría—: sale de B y A no se toca.
    const a = await existencia(LECHE, W1, loteA);
    const b = await existencia(LECHE, W1, loteB);
    const conLote = await nota(f.id, {
      kind: "devolucion",
      warehouse_id: W1,
      lines: [
        { supplier_invoice_line_id: f.lineas[0], quantity: "1", unit_price: "30", lot_id: loteB },
      ],
    });
    expect(conLote.status, await conLote.clone().text()).toBe(201);
    expect((await existencia(LECHE, W1, loteA)).q).toBe(a.q);
    expect((await existencia(LECHE, W1, loteB)).q).toBe(b.q - 1);
    expect(await invariantes()).toEqual(EN_CERO);
  });

  it("6 · ESTADO MIXTO: el asiento de la nota posteado y el ajuste del kardex en la COLA no dan «duplicated», y al procesar la cola todo vuelve a cero", async () => {
    const rec = await recibir(W2, SAL, "2", "10");
    const f = await facturar([
      { product_id: SAL, quantity: "2", unit_price: "10", recepcion: rec },
    ]);
    await sql`update public.journal_templates set is_active = false
               where company_id = ${COMPANY} and source_kind = 'purchase_revaluation'
                 and source_event = 'ap.credit_note_received'`;
    try {
      // Devuelve 1 a 8: el kardex baja 10 y el asiento acredita 8 → el ajuste (2) va a la cola.
      const r = await nota(f.id, {
        kind: "devolucion",
        lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "1", unit_price: "8" }],
      });
      expect(r.status, await r.clone().text()).toBe(201);
      const n = (await r.json()) as { id: string };
      const [cola] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.journal_generation_queue
         where company_id = ${COMPANY} and source_id = ${n.id} and status = 'pending'
           and source_kind = 'purchase_revaluation'`;
      expect(cola!.n).toBe(1);
      // El movimiento TIENE su asiento (el de la nota): no es un hueco ni un duplicado.
      expect(
        await sql`select kind, problem from platform.inventory_coverage_gaps(${COMPANY})`,
      ).toEqual([]);
      // Y lo que la brecha kardex ↔ mayor tiene de más es exactamente lo que espera en la cola.
      const [g] = await sql<{ d: string; q: string }[]>`
        select diferencia::text as d, en_cola::text as q
          from platform.inventory_ledger_gap(${COMPANY})`;
      expect(Number(g!.d)).toBe(-2);
      expect(Number(g!.q)).toBe(-2);
    } finally {
      await sql`update public.journal_templates set is_active = true
                 where company_id = ${COMPANY} and source_kind = 'purchase_revaluation'
                   and source_event = 'ap.credit_note_received'`;
    }
    expect((await pedir("POST", "/v1/accounting/pending/process", {})).status).toBe(200);
    expect(await invariantes()).toEqual(EN_CERO);
  });

  it("7 · quien SOLO lleva gastos no lee las líneas de una factura de mercancía (403), y la respuesta no trae costos", async () => {
    const f = await facturar([{ product_id: HARINA, quantity: "1", unit_price: "50" }]);
    const ajeno = await pedir("GET", `/v1/supplier-invoices/${f.id}/lines`, undefined, GASTOS);
    expect(ajeno.status).toBe(403);
    expect(((await ajeno.json()) as { message: string }).message).toContain(
      "solo se abren las facturas de un gasto",
    );
    const propio = await pedir("GET", `/v1/supplier-invoices/${f.id}/lines`);
    expect(propio.status).toBe(200);
    const cuerpo = (await propio.json()) as { lines: Record<string, unknown>[] };
    expect(Object.keys(cuerpo.lines[0]!).sort()).toEqual([
      "description",
      "has_receipt",
      "id",
      "line_number",
      "product_id",
      "quantity",
      "returned_quantity",
      "tracks_lots",
    ]);
  });

  it("8 · el IVA lo calcula el servidor: uno enviado que difiere en más de un céntimo se rechaza (422); el que coincide entra", async () => {
    const f = await facturar([{ product_id: HARINA, quantity: "2", unit_price: "50" }]);
    const mal = await nota(f.id, {
      kind: "rebaja",
      lines: [
        { supplier_invoice_line_id: f.lineas[0], quantity: "1", unit_price: "10", tax_amount: "5" },
      ],
    });
    expect(mal.status, await mal.clone().text()).toBe(422);
    expect(((await mal.json()) as { message: string }).message).toContain("1.60");
    const bien = await nota(f.id, {
      kind: "rebaja",
      lines: [
        {
          supplier_invoice_line_id: f.lineas[0],
          quantity: "1",
          unit_price: "10",
          tax_amount: "1.60",
        },
      ],
    });
    expect(bien.status, await bien.clone().text()).toBe(201);
    expect(await invariantes()).toEqual(EN_CERO);
  });

  it("6b · LOS OTROS DOS ESTADOS (tercera ronda, C1): con la nota EN COLA, `en_cola` no cuenta dos veces su ajuste —ni cuando el ajuste espera con ella, ni cuando ya se posteó—; y un movimiento de la nota sin asiento ni cola da fila", async () => {
    const rec = await recibir(W2, SAL, "2", "10");
    const f = await facturar([
      { product_id: SAL, quantity: "2", unit_price: "10", recepcion: rec },
    ]);
    const plantilla = (kind: string, activa: boolean) =>
      sql`update public.journal_templates set is_active = ${activa}
           where company_id = ${COMPANY} and source_kind = ${kind}
             and source_event = 'ap.credit_note_received'`;
    const brecha = async (): Promise<{ d: number; q: number }> => {
      const [g] = await sql<{ d: string; q: string }[]>`
        select diferencia::text as d, en_cola::text as q
          from platform.inventory_ledger_gap(${COMPANY})`;
      return { d: Number(g!.d), q: Number(g!.q) };
    };
    await plantilla("purchase_credit_note", false);
    await plantilla("purchase_revaluation", false);
    try {
      // NOTA EN COLA × AJUSTE EN COLA. Devuelve 1 a 7: el kardex baja 10 y el mayor no se ha
      // movido. La brecha es −10 y lo que espera en la cola la explica ENTERA: el asiento de la
      // nota (−7) y su ajuste (−3). Antes `en_cola` sumaba además el ajuste: −13.
      const a = await nota(f.id, {
        kind: "devolucion",
        lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "1", unit_price: "7" }],
      });
      expect(a.status, await a.clone().text()).toBe(201);
      expect(await brecha()).toEqual({ d: -10, q: -10 });
      expect(
        await sql`select kind, problem from platform.inventory_coverage_gaps(${COMPANY})`,
      ).toEqual([]);

      // NOTA EN COLA × AJUSTE POSTEADO. Devuelve 1 a 6: el kardex baja otros 10 y el ajuste
      // (−4) SÍ se asienta. A la brecha le faltan los −6 que acreditará la nota: con la primera,
      // −16 de cada lado. Antes `en_cola` contaba el movimiento entero (−10): −20.
      await plantilla("purchase_revaluation", true);
      const b = await nota(f.id, {
        kind: "devolucion",
        lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "1", unit_price: "6" }],
      });
      expect(b.status, await b.clone().text()).toBe(201);
      const nb = (await b.json()) as { id: string };
      const [ajuste] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.journal_entries
         where company_id = ${COMPANY} and source_id = ${nb.id} and status = 'posted'
           and source_kind = 'purchase_revaluation'`;
      expect(ajuste!.n).toBe(1);
      expect(await brecha()).toEqual({ d: -16, q: -16 });
      expect(
        await sql`select kind, problem from platform.inventory_coverage_gaps(${COMPANY})`,
      ).toEqual([]);

      // VARIANTE ROTA DE LA COBERTURA: la nota pierde su fila de cola. Su movimiento queda sin
      // el asiento de la nota y sin cola; el ajuste posteado NO lo cubre. Una fila, «missing».
      let huecos: { kind: string; problem: string }[] = [];
      await sql
        .begin(async (tx) => {
          await tx`delete from public.journal_generation_queue
                    where company_id = ${COMPANY} and source_id = ${nb.id}
                      and source_kind = 'purchase_credit_note'`;
          huecos = await tx<{ kind: string; problem: string }[]>`
            select kind, problem from platform.inventory_coverage_gaps(${COMPANY})`;
          throw new Error("deshacer");
        })
        .catch((e: unknown) => {
          if (!(e instanceof Error) || e.message !== "deshacer") throw e;
        });
      expect(huecos).toEqual([{ kind: "salida", problem: "missing" }]);
    } finally {
      await plantilla("purchase_credit_note", true);
      await plantilla("purchase_revaluation", true);
    }
    expect((await pedir("POST", "/v1/accounting/pending/process", {})).status).toBe(200);
    expect(await invariantes()).toEqual(EN_CERO);
  });

  it("C6a · una nota que EXCEDE sobre una factura a MEDIO pagar: la cuenta por pagar queda en cero y solo el exceso va al saldo a favor", async () => {
    const antes = await saldoPapel("supplier_credit_receivable");
    const rec = await recibir(W1, HARINA, "4", "50");
    const f = await facturar([
      { product_id: HARINA, quantity: "4", unit_price: "50", recepcion: rec },
    ]);
    // 232 facturados, 132 pagados: se deben 100.
    const pago = await pagar(f.id, "132.00000000");
    expect(pago.status, await pago.clone().text()).toBe(201);
    // El proveedor rebaja 25 por unidad: 100 + 16 de IVA = 116. Pasa en 16 de lo que se debía.
    const r = await nota(f.id, {
      kind: "rebaja",
      lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "4", unit_price: "25" }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const n = (await r.json()) as { id: string; balance: string; left_credit_in_favor: boolean };
    expect(n.balance).toBe("-16.00000000");
    expect(n.left_credit_in_favor).toBe(true);
    const [fila] = await sql<{ bs: string; nominal: string; abierto: string; estado: string }[]>`
      select n.credit_in_favor_functional::text as bs,
             n.credit_in_favor_transaction::text as nominal,
             platform.settlement_ledger_open(${COMPANY}, 'ap', ${f.id})::text as abierto,
             (select status from public.supplier_invoices where id = ${f.id}) as estado
        from public.supplier_credit_notes n where n.id = ${n.id}`;
    expect(Number(fila!.bs)).toBe(16);
    expect(Number(fila!.nominal)).toBe(16);
    expect(Number(fila!.abierto)).toBe(0);
    expect(fila!.estado).toBe("posted");
    expect(await saldoPapel("supplier_credit_receivable")).toBe(antes + 16);
    expect(await invariantes()).toEqual(EN_CERO);
  });

  it("C6b · empresa SIN la cuenta de saldos a favor: la nota con exceso va a la cola diciendo el papel que falta, y el invariante cuenta la cola", async () => {
    const f = await facturar([{ product_id: HARINA, quantity: "1", unit_price: "50" }]);
    expect((await pagar(f.id, "58.00000000")).status).toBe(201);
    // Lo que las notas anteriores ya asentaron en la cuenta de saldos a favor.
    const asentado = await saldoPapel("supplier_credit_receivable");
    expect(asentado).toBeGreaterThan(0);
    expect(await sql`select 1 from platform.supplier_credit_ledger_gap(${COMPANY})`).toEqual([]);
    const [papel] = await sql<{ account_id: string }[]>`
      select account_id from public.company_account_settings
       where company_id = ${COMPANY} and purpose = 'supplier_credit_receivable'`;
    const conActor = (fn: (tx: typeof sql) => Promise<unknown>) =>
      sql.begin(async (tx) => {
        await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
        await fn(tx as unknown as typeof sql);
      });
    await conActor(
      (tx) => tx`delete from public.company_account_settings
                  where company_id = ${COMPANY} and purpose = 'supplier_credit_receivable'`,
    );
    try {
      const r = await nota(f.id, {
        kind: "rebaja",
        lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "1", unit_price: "10" }],
      });
      expect(r.status, await r.clone().text()).toBe(201);
      const n = (await r.json()) as { id: string; left_credit_in_favor: boolean };
      expect(n.left_credit_in_favor).toBe(true);
      const cola = await sql<{ reason: string }[]>`
        select reason from public.journal_generation_queue
         where company_id = ${COMPANY} and source_id = ${n.id} and status = 'pending'
           and source_kind = 'purchase_credit_note'`;
      expect(cola.length).toBe(1);
      expect(cola[0]!.reason).toContain("supplier_credit_receivable");
      // El invariante CUENTA LA COLA: los 11,60 declarados por esta nota están en `en_cola`. Con el
      // papel quitado, la función ya no encuentra la cuenta y deja de ver lo que las notas
      // ANTERIORES tenían asentado en ella: la diferencia que enseña es exactamente ese saldo
      // (el del mayor antes de quitar el papel), ni un céntimo de esta nota.
      const [g] = await sql<{ cola: string; mayor: string; dif: string }[]>`
        select en_cola::text as cola, mayor::text as mayor, diferencia::text as dif
          from platform.supplier_credit_ledger_gap(${COMPANY})`;
      expect([Number(g!.cola), Number(g!.mayor), Number(g!.dif)]).toEqual([11.6, 0, asentado]);
    } finally {
      await conActor(
        (tx) => tx`insert into public.company_account_settings
                     (tenant_id, company_id, purpose, account_id, effective_from)
                   values (${TENANT}, ${COMPANY}, 'supplier_credit_receivable',
                           ${papel!.account_id}, '-infinity')`,
      );
    }
    expect((await pedir("POST", "/v1/accounting/pending/process", {})).status).toBe(200);
    expect(await invariantes()).toEqual(EN_CERO);
  });

  it("C3 · la nota que CIERRA una factura sin pagarla: la factura sigue `posted` y `settled_ledger_gaps` la mira (variante rota: la cuenta por pagar no bajó ⇒ 1 fila)", async () => {
    const f = await facturar([{ product_id: HARINA, quantity: "2", unit_price: "50" }]);
    const r = await nota(f.id, {
      kind: "rebaja",
      lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "2", unit_price: "50" }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    expect(((await r.json()) as { balance: string }).balance).toBe("0.00000000");
    const [estado] = await sql<{ status: string }[]>`
      select status from public.supplier_invoices where id = ${f.id}`;
    expect(estado!.status).toBe("posted");
    expect(await sql`select 1 from platform.settled_ledger_gaps(${COMPANY})`).toEqual([]);

    // VARIANTE ROTA: otra factura queda en cero en el AUXILIAR por una nota cuyo asiento no bajó
    // la cuenta por pagar (lleva el asiento de la propia factura). El mayor sigue debiendo 116.
    const rota = await facturar([{ product_id: HARINA, quantity: "2", unit_price: "50" }]);
    let filas: { side: string; document_id: string; residual: string }[] = [];
    await sql
      .begin(async (tx) => {
        await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
        await tx`
          insert into public.supplier_credit_notes
            (tenant_id, company_id, supplier_id, supplier_invoice_id, supplier_document_number,
             supplier_control_number, note_date, status, posted_at, reason, transaction_currency,
             functional_currency, subtotal_amount, tax_amount, total_amount, is_fiscal,
             document_incomplete, correction_kind, journal_entry_id)
          select i.tenant_id, i.company_id, i.supplier_id, i.id, ${`NC-ROTA-${RUN}`}, 'C-ROTA',
                 ${HOY}::date, 'posted', now(), 'Variante rota C3', 'VES', 'VES', 100, 16, 116,
                 true, false, 'rebaja', i.journal_entry_id
            from public.supplier_invoices i where i.id = ${rota.id}`;
        filas = await tx<{ side: string; document_id: string; residual: string }[]>`
          select side, document_id, residual::text as residual
            from platform.settled_ledger_gaps(${COMPANY})`;
        throw new Error("deshacer");
      })
      .catch((e: unknown) => {
        if (!(e instanceof Error) || e.message !== "deshacer") throw e;
      });
    expect(filas.map((x) => [x.side, x.document_id, Number(x.residual)])).toEqual([
      ["ap", rota.id, 116],
    ]);
    expect(await invariantes()).toEqual(EN_CERO);
  });

  it("C2 · «lo que se debe» no resta el saldo a favor: el total del estado de cuenta es la suma de los tramos de su antigüedad, el saldo a favor va aparte y la nota sin control sale marcada", async () => {
    // Una nota SIN número de control: se registra y queda «documento incompleto».
    const f = await facturar([{ product_id: HARINA, quantity: "1", unit_price: "50" }]);
    const sinControl = await nota(f.id, {
      kind: "rebaja",
      supplier_control_number: undefined,
      lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "1", unit_price: "1" }],
    });
    expect(sinControl.status, await sinControl.clone().text()).toBe(201);
    const incompleta = (await sinControl.json()) as { id: string; document_incomplete: boolean };
    expect(incompleta.document_incomplete).toBe(true);

    const r = await pedir("GET", `/v1/suppliers/${PROVEEDOR}/statement`);
    expect(r.status, await r.clone().text()).toBe(200);
    const e = (await r.json()) as {
      total_outstanding: string;
      aging: { total: string; buckets: { amount: string }[] };
      invoices: { balance: string }[];
      credit_in_favor: { currency: string; nominal: string }[];
      credit_in_favor_functional: string;
      credit_notes: {
        id: string;
        supplier_document_number: string;
        supplier_control_number: string | null;
        total_amount: string;
        document_incomplete: boolean;
      }[];
    };
    // Hay facturas con saldo NEGATIVO (el caso 1 dejó 23,20 a favor; C6a, 16; C6b, 11,60).
    const aFavor = await sql<{ v: string; bs: string }[]>`
      select (select coalesce(sum(-platform.supplier_invoice_balance(${COMPANY}, i.id)), 0)
                from public.supplier_invoices i
               where i.company_id = ${COMPANY}
                 and platform.supplier_invoice_balance(${COMPANY}, i.id) < 0)::text as v,
             (select coalesce(sum(credit_in_favor_functional), 0)
                from public.supplier_credit_notes
               where company_id = ${COMPANY} and status = 'posted')::text as bs`;
    expect(Number(aFavor[0]!.v)).toBeGreaterThan(50);
    // El total ES la suma de los tramos de la misma respuesta. Antes: esa suma MENOS el saldo a favor.
    const tramos = e.aging.buckets.reduce((s, b) => s + Math.round(Number(b.amount) * 100), 0);
    expect(Math.round(Number(e.total_outstanding) * 100)).toBe(tramos);
    expect(Number(e.total_outstanding)).toBe(Number(e.aging.total));
    // Y el saldo a favor se ENSEÑA aparte: en su moneda (del auxiliar) y en Bs (lo declarado).
    expect(e.credit_in_favor.map((x) => [x.currency, Number(x.nominal)])).toEqual([
      ["VES", Number(aFavor[0]!.v)],
    ]);
    expect(Number(e.credit_in_favor_functional)).toBe(Number(aFavor[0]!.bs));
    // «Documento incompleto» se ve donde se listan las notas del proveedor.
    const marcada = e.credit_notes.filter((n) => n.document_incomplete);
    expect(marcada.map((n) => [n.id, n.supplier_control_number])).toEqual([[incompleta.id, null]]);
    expect(e.credit_notes.length).toBeGreaterThan(5);
  });

  it("un PAGO sobre una factura que ya no debe nada (saldo cero o a favor) se rechaza: no mueve el auxiliar por debajo de lo declarado", async () => {
    const facturas = await sql<{ id: string; saldo: string }[]>`
      select i.id, platform.supplier_invoice_balance(${COMPANY}, i.id)::text as saldo
        from public.supplier_invoices i
       where i.company_id = ${COMPANY} and i.status = 'posted'
         and platform.supplier_invoice_balance(${COMPANY}, i.id) <= 0
       order by 2`;
    // Una con saldo a favor (C6a, −16) y una en cero (C3).
    expect(Number(facturas[0]!.saldo)).toBeLessThan(0);
    expect(Number(facturas.at(-1)!.saldo)).toBe(0);
    for (const f of [facturas[0]!, facturas.at(-1)!]) {
      const pagos =
        await sql`select 1 from public.supplier_payments where supplier_invoice_id = ${f.id}`;
      const p = await pagar(f.id, "1.00000000");
      expect(p.status, await p.clone().text()).toBe(422);
      expect(((await p.json()) as { message: string }).message).toContain("ya no debe nada");
      expect(
        (await sql`select 1 from public.supplier_payments where supplier_invoice_id = ${f.id}`)
          .length,
      ).toBe(pagos.length);
    }
    expect(await invariantes()).toEqual(EN_CERO);
  });

  it("VARIANTE ROTA · auxiliar ↔ declarado: un céntimo que el auxiliar se mueve sin que una nota lo declare da UNA fila en supplier_credit_subledger_gaps", async () => {
    expect(await sql`select 1 from platform.supplier_credit_subledger_gaps(${COMPANY})`).toEqual(
      [],
    );
    const [f] = await sql<{ id: string; saldo: string }[]>`
      select i.id, platform.supplier_invoice_balance(${COMPANY}, i.id)::text as saldo
        from public.supplier_invoices i
       where i.company_id = ${COMPANY} and i.status = 'posted'
         and platform.supplier_invoice_balance(${COMPANY}, i.id) < 0
       order by 2 limit 1`;
    let filas: { id: string; auxiliar: string; declarado: string; diferencia: string }[] = [];
    await sql
      .begin(async (tx) => {
        await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
        // Una nota de un céntimo que NO declara su saldo a favor (lo que haría un cálculo malo).
        await tx`
          insert into public.supplier_credit_notes
            (tenant_id, company_id, supplier_id, supplier_invoice_id, supplier_document_number,
             supplier_control_number, note_date, status, posted_at, reason, transaction_currency,
             functional_currency, subtotal_amount, tax_amount, total_amount, is_fiscal,
             document_incomplete, correction_kind)
          select i.tenant_id, i.company_id, i.supplier_id, i.id, ${`NC-CENT-${RUN}`}, 'C-CENT',
                 ${HOY}::date, 'posted', now(), 'Variante rota auxiliar', 'VES', 'VES', 0.01, 0,
                 0.01, true, false, 'rebaja'
            from public.supplier_invoices i where i.id = ${f!.id}`;
        filas = await tx`
          select supplier_invoice_id as id, auxiliar::text, declarado::text, diferencia::text
            from platform.supplier_credit_subledger_gaps(${COMPANY})`;
        throw new Error("deshacer");
      })
      .catch((e: unknown) => {
        if (!(e instanceof Error) || e.message !== "deshacer") throw e;
      });
    expect(filas.map((x) => [x.id, Number(x.diferencia)])).toEqual([[f!.id, 0.01]]);
    expect(Number(filas[0]!.auxiliar)).toBe(-Number(f!.saldo) + 0.01);
  });

  it("c · LOTE VENCIDO: devolverlo exige el permiso `inventory.expired` (403 que lo dice); con él, sale. Un lote que no está en el depósito elegido: 422 con mensaje de persona", async () => {
    await recibir(W1, LECHE, "2", "30", { lot_code: `V-${RUN}`, lot_expires_at: diaCaracas(5) });
    const [lote] = await sql<{ id: string }[]>`
      select id from public.lots where company_id = ${COMPANY} and code = ${`V-${RUN}`}`;
    const f = await facturar([{ product_id: LECHE, quantity: "2", unit_price: "30" }]);
    // La pantalla lista los lotes con existencia de ese producto, con su depósito y su vencimiento.
    const lineas = await pedir("GET", `/v1/supplier-invoices/${f.id}/lines`);
    const { lots } = (await lineas.json()) as {
      lots: { lot_id: string; warehouse_id: string; product_id: string; expired: boolean }[];
    };
    expect(lots.filter((l) => l.lot_id === lote!.id)).toMatchObject([
      { warehouse_id: W1, product_id: LECHE, expired: false },
    ]);
    // El lote vence: ayer.
    await sql`update public.lots set expires_at = ${AYER}::date where id = ${lote!.id}`;
    const devolver = (deposito: string) =>
      nota(f.id, {
        kind: "devolucion",
        warehouse_id: deposito,
        lines: [
          {
            supplier_invoice_line_id: f.lineas[0],
            quantity: "1",
            unit_price: "30",
            lot_id: lote!.id,
          },
        ],
      });
    // En el OTRO depósito ese lote no está.
    const ajeno = await devolver(W2);
    expect(ajeno.status, await ajeno.clone().text()).toBe(422);
    expect(((await ajeno.json()) as { message: string }).message).toContain(
      "no está en el depósito elegido",
    );
    // Sin el permiso de despachar lo vencido.
    const antes = await existencia(LECHE, W1, lote!.id);
    const sinPermiso = await devolver(W1);
    expect(sinPermiso.status, await sinPermiso.clone().text()).toBe(403);
    expect(((await sinPermiso.json()) as { message: string }).message).toContain(
      "inventory.expired",
    );
    expect(await existencia(LECHE, W1, lote!.id)).toEqual(antes);
    // Con él: devolverle al proveedor la mercancía vencida es justo el caso.
    await sql`insert into public.role_permissions (role_id, permission_key)
              values (${ROL}, 'inventory.expired')`;
    try {
      const conPermiso = await devolver(W1);
      expect(conPermiso.status, await conPermiso.clone().text()).toBe(201);
      expect((await existencia(LECHE, W1, lote!.id)).q).toBe(antes.q - 1);
    } finally {
      await sql`delete from public.role_permissions
                 where role_id = ${ROL} and permission_key = 'inventory.expired'`;
    }
    expect(await invariantes()).toEqual(EN_CERO);
  });

  it("A (AF5-11) · la fecha de la nota: ni FUTURA ni ANTERIOR a la factura que corrige (422 con su mensaje, y no queda nada)", async () => {
    const f = await facturar([{ product_id: HARINA, quantity: "1", unit_price: "50" }]);
    const con = (fecha: string) =>
      nota(f.id, {
        kind: "rebaja",
        note_date: fecha,
        lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "1", unit_price: "1" }],
      });
    const futura = await con(diaCaracas(1));
    expect(futura.status, await futura.clone().text()).toBe(422);
    expect(((await futura.json()) as { message: string }).message).toContain(
      "La nota no puede tener fecha futura",
    );
    const anterior = await con(AYER);
    expect(anterior.status, await anterior.clone().text()).toBe(422);
    expect(((await anterior.json()) as { message: string }).message).toContain(
      "La nota no puede ser anterior a la factura que corrige",
    );
    expect(
      await sql`select 1 from public.supplier_credit_notes where supplier_invoice_id = ${f.id}`,
    ).toEqual([]);
    // El mismo día de la factura, y hoy, sí.
    expect((await con(HOY)).status).toBe(201);
  });

  it("B (AF5-14) · sin número de control la nota fiscal queda «documento incompleto» AUNQUE traiga una referencia", async () => {
    const f = await facturar([{ product_id: HARINA, quantity: "1", unit_price: "50" }]);
    const r = await nota(f.id, {
      kind: "rebaja",
      supplier_control_number: undefined,
      supplier_document_ref: "Correo del proveedor del lunes",
      lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "1", unit_price: "1" }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const n = (await r.json()) as { id: string; document_incomplete: boolean };
    expect(n.document_incomplete).toBe(true);
    const [fila] = await sql<{ marca: boolean }[]>`
      select document_incomplete as marca from public.supplier_credit_notes where id = ${n.id}`;
    expect(fila!.marca).toBe(true);
  });

  it("K-04 · una nota fechada en un período CERRADO entra al período en curso con su fecha original, «recibida con retraso»", async () => {
    // La factura también es del mes pasado: una nota no es anterior a la factura que corrige.
    const f = await facturar(
      [{ product_id: HARINA, quantity: "2", unit_price: "50" }],
      FIN_MES_PASADO,
    );
    const [mes] = await sql<{ dia: string; anio: number; mes: number }[]>`
      select (date_trunc('month', ${HOY}::date) - interval '1 day')::date::text as dia,
             extract(year from date_trunc('month', ${HOY}::date) - interval '1 day')::int as anio,
             extract(month from date_trunc('month', ${HOY}::date) - interval '1 day')::int as mes`;
    // Con el mes pasado ABIERTO, la nota fechada en él entra en él: sin fecha contable aparte.
    const abierta = await nota(f.id, {
      kind: "rebaja",
      note_date: mes!.dia,
      lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "1", unit_price: "1" }],
    });
    expect(abierta.status, await abierta.clone().text()).toBe(201);
    expect(((await abierta.json()) as { accounting_date: string | null }).accounting_date).toBe(
      null,
    );
    // El mes pasado se CIERRA, por la ruta de cierre.
    const periodos = (await (await pedir("GET", "/v1/fiscal-periods")).json()) as {
      id: string;
      year: number;
      month: number;
      status: string;
    }[];
    const pasado = periodos.find((p) => p.year === mes!.anio && p.month === mes!.mes);
    expect(pasado, JSON.stringify(periodos)).toBeDefined();
    const cierre = await pedir("POST", `/v1/fiscal-periods/${pasado!.id}/close`, {
      company_id: COMPANY,
    });
    expect(cierre.status, await cierre.clone().text()).toBe(200);
    // La misma nota, ahora: se registra HOY, con su fecha original.
    const r = await nota(f.id, {
      kind: "rebaja",
      note_date: mes!.dia,
      lines: [{ supplier_invoice_line_id: f.lineas[0], quantity: "1", unit_price: "2" }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const n = (await r.json()) as { id: string; accounting_date: string | null };
    expect(n.accounting_date).toBe(HOY);
    const [fila] = await sql<{ fecha: string; contable: string; asiento: string }[]>`
      select n.note_date::text as fecha, n.accounting_date::text as contable,
             (select e.posting_date::text from public.journal_entries e
               where e.company_id = ${COMPANY} and e.source_id = n.id
                 and e.source_kind = 'purchase_credit_note' and e.status = 'posted') as asiento
        from public.supplier_credit_notes n where n.id = ${n.id}`;
    expect(fila).toEqual({ fecha: mes!.dia, contable: HOY, asiento: HOY });
    // Y el libro de compras de ESTE mes la trae, con su fecha original y «recibida con retraso».
    const libro = await sql<{ fecha: string; registrada: string; tarde: boolean }[]>`
      select b.invoice_date::text as fecha, b.booked_on::text as registrada,
             b.received_late as tarde
        from platform.purchases_book(${COMPANY}, date_trunc('month', ${HOY}::date)::date,
                                     ${HOY}::date) b
       where b.invoice_id = ${n.id}`;
    expect(libro).toEqual([{ fecha: mes!.dia, registrada: HOY, tarde: true }]);
    expect(await invariantes()).toEqual(EN_CERO);
  });

  it("VARIANTE ROTA (va la última) · un céntimo de diferencia entre lo declarado y el mayor de saldos a favor da fila en supplier_credit_ledger_gap", async () => {
    // Hasta aquí lo declarado por las notas y el mayor dicen lo mismo: cero filas.
    expect(await sql`select 1 from platform.supplier_credit_ledger_gap(${COMPANY})`).toEqual([]);
    const [declarado] = await sql<{ v: string }[]>`
      select coalesce(sum(credit_in_favor_functional), 0)::text as v
        from public.supplier_credit_notes where company_id = ${COMPANY} and status = 'posted'`;
    expect(Number(declarado!.v)).toBeGreaterThan(0);
    // Un asiento manual saca UN céntimo de la cuenta de saldos a favor: el mayor deja de decir
    // lo que las notas declaran. El invariante no lee la cifra de la nota: discrepa.
    const cuentas = await sql<{ purpose: string; id: string }[]>`
      select purpose, account_id as id from public.company_account_settings
       where company_id = ${COMPANY}
         and purpose in ('supplier_credit_receivable', 'operating_expense')`;
    const de = (p: string) => cuentas.find((x) => x.purpose === p)!.id;
    const borrador = await pedir("POST", "/v1/journal-entries", {
      company_id: COMPANY,
      posting_date: HOY,
      description: "Variante rota e2e: un céntimo fuera de saldos a favor con proveedores",
      lines: [
        { account_id: de("operating_expense"), debit: "0.01" },
        { account_id: de("supplier_credit_receivable"), credit: "0.01" },
      ],
    });
    expect(borrador.status, await borrador.clone().text()).toBe(201);
    const { id } = (await borrador.json()) as { id: string };
    const posteo = await pedir("POST", `/v1/journal-entries/${id}/post`, { company_id: COMPANY });
    expect(posteo.status, await posteo.clone().text()).toBe(200);
    const filas = await sql<{ declarado: string; mayor: string; diferencia: string }[]>`
      select declarado::text, mayor::text, diferencia::text
        from platform.supplier_credit_ledger_gap(${COMPANY})`;
    expect(filas.length).toBe(1);
    expect(Number(filas[0]!.declarado)).toBe(Number(declarado!.v));
    expect(Number(filas[0]!.diferencia)).toBe(0.01);
  });
});

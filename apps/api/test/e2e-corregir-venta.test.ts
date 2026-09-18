import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * CORREGIR UNA VENTA (ADR-0061 · migración 59), en un negocio que vende con
 * recibos, con plan y preset contables importados.
 *
 *   · anular un recibo SIN cobros repone la mercancía al lote y valor con que
 *     salió, revierte su costo de ventas, y deja todos los invariantes en cero;
 *   · un recibo cobrado NO se anula: 409 con el camino escrito;
 *   · una nota o un recibo de devolución no se anulan (422);
 *   · la devolución de un recibo emite RECIBO DE DEVOLUCIÓN (sin IVA, no fiscal),
 *     reingresa al lote y costo de la venta —de un producto con lotes, que antes
 *     no se podía devolver—, deja saldo a favor, y el reembolso saca el dinero de
 *     la caja real, con su asiento;
 *   · el tope de devolución es ACUMULADO;
 *   · VARIANTE ROTA: un recibo marcado anulado sin reponer aparece en
 *     `annulled_stock_gaps`.
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
let QUESO = "";
let PAN = "";
let PRONTO = "";
let LEJOS = "";
let CAJA = "";

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

async function lote(id: string): Promise<{ q: string; v: string }> {
  const [b] = await sql<{ q: string; v: string }[]>`
    select quantity::text as q, value::text as v from public.stock_balances
     where company_id = ${COMPANY} and warehouse_id = ${W1} and lot_id = ${id}`;
  return b ?? { q: "0", v: "0" };
}

async function posicionPan(): Promise<{ q: string; v: string }> {
  const [b] = await sql<{ q: string; v: string }[]>`
    select coalesce(sum(quantity), 0)::text as q, coalesce(sum(value), 0)::text as v
      from public.stock_balances
     where company_id = ${COMPANY} and warehouse_id = ${W1} and product_id = ${PAN}`;
  return b!;
}

/** Todos los invariantes que tocan esta ola, a la vez. */
async function invariantesEnCero(): Promise<void> {
  const [r] = await sql<
    { gap: string; inv: number; docs: number; anuladas: number; caja: number }[]
  >`
    select (select diferencia::text from platform.inventory_ledger_gap(${COMPANY})) as gap,
           (select count(*)::int from platform.inventory_coverage_gaps(${COMPANY})) as inv,
           (select count(*)::int from platform.accounting_coverage_gaps(${COMPANY})) as docs,
           (select count(*)::int from platform.annulled_stock_gaps(${COMPANY})) as anuladas,
           (select count(*)::int from platform.treasury_reconciliation(${COMPANY}) where not ok) as caja`;
  expect(r).toEqual({ gap: "0.00000000", inv: 0, docs: 0, anuladas: 0, caja: 0 });
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e corregir venta')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code)
             values (${COMPANY}, ${TENANT}, ${`PEND-CV-${RUN}`}, 'Charcutería corregir', 'VES')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-CVW1', 'Local')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2ecv_${RUN}`}, 'Dueño', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.invoice.annul'),
             (${ROL}, 'sales.payment.register'), (${ROL}, 'sales.return.manage'),
             (${ROL}, 'ar.read'), (${ROL}, 'inventory.move'), (${ROL}, 'treasury.read'),
             (${ROL}, 'treasury.account.manage'), (${ROL}, 'accounting.account.manage'),
             (${ROL}, 'accounting.template.manage'), (${ROL}, 'accounting.entry.reverse'),
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
    await tx`insert into public.customers (id, tenant_id, company_id, legal_name,
                                           person_type_code, taxpayer_type_code)
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, 'Señora Inés', 'natural',
                     'consumidor_final')`;
    const prods = await tx<{ id: string; sku: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code, tracks_lots, tracks_expiry)
      values (${TENANT}, ${COMPANY}, ${`CV-QUESO-${RUN}`}, 'Queso de mano', 'good', 'active',
              'unidad', 'gravado_general', true, true),
             (${TENANT}, ${COMPANY}, ${`CV-PAN-${RUN}`}, 'Pan campesino', 'good', 'active',
              'unidad', 'gravado_general', false, false)
      returning id, sku`;
    QUESO = prods.find((p) => p.sku.startsWith("CV-QUESO"))!.id;
    PAN = prods.find((p) => p.sku.startsWith("CV-PAN"))!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, 'detal', 'VES') returning id`;
    await tx`insert into public.company_settings (company_id, tenant_id, default_price_list_id)
             values (${COMPANY}, ${TENANT}, ${l!.id})`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${l!.id}, ${QUESO}, 100, now() - interval '1 day'),
                    (${TENANT}, ${COMPANY}, ${l!.id}, ${PAN}, 20, now() - interval '1 day')`;
    const lotes = await tx<{ id: string; code: string }[]>`
      insert into public.lots (tenant_id, company_id, product_id, code, expires_at) values
        (${TENANT}, ${COMPANY}, ${QUESO}, ${`CV-PRONTO-${RUN}`}, current_date + 5),
        (${TENANT}, ${COMPANY}, ${QUESO}, ${`CV-LEJOS-${RUN}`}, current_date + 60)
      returning id, code`;
    PRONTO = lotes.find((x) => x.code.startsWith("CV-PRONTO"))!.id;
    LEJOS = lotes.find((x) => x.code.startsWith("CV-LEJOS"))!.id;
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), 'e2e-corregir'
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
  const caja = await pedir("POST", "/v1/treasury/accounts", {
    company_id: COMPANY,
    name: `Caja Bs ${RUN}`,
    currency: "VES",
    kind: "cash",
  });
  expect(caja.status).toBe(201);
  CAJA = ((await caja.json()) as { id: string }).id;
  for (const [producto, loteId, cantidad, total] of [
    [QUESO, PRONTO, "3", "120"],
    [QUESO, LEJOS, "5", "250"],
    [PAN, null, "10", "80"],
  ] as const) {
    const r = await pedir("POST", "/v1/inventory/receipts", {
      origin: "aporte",
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: producto,
      ...(loteId === null ? {} : { lot_id: loteId }),
      quantity: cantidad,
      amount: total,
      currency: "VES",
    });
    expect(r.status).toBe(201);
  }
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("corregir una venta", () => {
  it("ANULAR un recibo SIN cobros repone la mercancía al lote y valor con que salió, y revierte su costo", async () => {
    const antesPronto = await lote(PRONTO);
    const antesLejos = await lote(LEJOS);
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: QUESO, quantity: "4" }],
    });
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;
    expect((await lote(PRONTO)).q).toBe("0.00000000");

    const anular = await pedir("POST", `/v1/invoices/${doc}/annul`, {
      company_id: COMPANY,
      reason: "Recibo emitido por error",
    });
    expect(anular.status).toBe(200);
    expect(await lote(PRONTO)).toEqual(antesPronto);
    expect(await lote(LEJOS)).toEqual(antesLejos);

    const [reverso] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.journal_entries
       where company_id = ${COMPANY} and source_kind = 'sales_cost'
         and source_event = 'stock.received' and source_id = ${doc} and status = 'posted'`;
    expect(reverso!.n).toBe(1);
    const [evento] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where aggregate_id = ${doc} and event_type = 'sales.receipt.annulled'`;
    expect(evento!.n).toBe(1);
    await invariantesEnCero();
  });

  it("un recibo COBRADO no se anula: 409 que dice el camino", async () => {
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: PAN, quantity: "1" }],
      payments: [
        { instrument: "efectivo_bs", amount: "20.00000000", currency: "VES", account_id: CAJA },
      ],
    });
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;
    const anular = await pedir("POST", `/v1/invoices/${doc}/annul`, {
      company_id: COMPANY,
      reason: "El cliente se arrepintió",
    });
    expect(anular.status).toBe(409);
    const cuerpo = (await anular.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("DOCUMENT_HAS_PAYMENTS");
    expect(cuerpo.message).toContain("recibo ya tiene cobros");
    expect(cuerpo.message).toContain("registra una devolución");
  });

  it("DEVOLUCIÓN de un recibo cobrado: recibo de devolución sin IVA, reingreso al lote y costo de la venta, saldo a favor y REEMBOLSO desde la caja", async () => {
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: QUESO, quantity: "5" }],
      payments: [
        { instrument: "efectivo_bs", amount: "500.00000000", currency: "VES", account_id: CAJA },
      ],
    });
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;
    // Salieron 3 del lote PRONTO (a 40) y 2 del LEJOS (a 50).
    const [linea] = await sql<{ id: string }[]>`
      select id from public.document_lines where document_id = ${doc}`;

    const borrador = await pedir("POST", "/v1/returns", {
      company_id: COMPANY,
      source_document_id: doc,
      warehouse_id: W1,
      reason: "Dos quesos salieron en mal estado",
      lines: [{ source_line_id: linea!.id, quantity: "4" }],
    });
    expect(borrador.status).toBe(201);
    const dev = ((await borrador.json()) as { id: string }).id;
    const confirmada = await pedir("POST", `/v1/returns/${dev}/confirm`, {});
    expect(confirmada.status).toBe(200);
    const c = (await confirmada.json()) as {
      credit_note_id: string;
      customer_credit_id: string;
    };

    const [rd] = await sql<{ kind: string; tax: string; total: string; tratamientos: string[] }[]>`
      select d.kind, d.tax_amount::text as tax, d.total_amount::text as total,
             array(select distinct tax_treatment from public.document_lines
                    where document_id = d.id) as tratamientos
        from public.documents d where d.id = ${c.credit_note_id}`;
    expect(rd!.kind).toBe("receipt_return");
    expect(rd!.tax).toBe("0.00000000");
    expect(rd!.tratamientos).toEqual(["no_fiscal"]);
    expect(rd!.total).toBe("400.00000000");

    // Reingreso: los 3 del lote PRONTO a su valor (120) y 1 del LEJOS (50).
    const vuelta = await sql<{ lot_id: string; q: string; v: string }[]>`
      select lot_id, quantity::text as q, functional_amount::text as v
        from public.inventory_moves
       where company_id = ${COMPANY} and source_document_id = ${dev}
       order by lot_id = ${PRONTO} desc`;
    expect(vuelta).toEqual([
      { lot_id: PRONTO, q: "3.00000000", v: "120.00000000" },
      { lot_id: LEJOS, q: "1.00000000", v: "50.00000000" },
    ]);

    const saldoAntes = async (): Promise<string> => {
      const [b] = await sql<{ b: string }[]>`
        select coalesce(balance, 0)::text as b from public.company_account_balances
         where account_id = ${CAJA}`;
      return b?.b ?? "0";
    };
    const antes = await saldoAntes();
    const reembolso = await pedir("POST", `/v1/customer-credits/${c.customer_credit_id}/refunds`, {
      company_id: COMPANY,
      account_id: CAJA,
      amount: "400.00000000",
      reason: "Se le devuelve el dinero en efectivo",
    });
    expect(reembolso.status).toBe(201);
    const r = (await reembolso.json()) as {
      accounting: string;
      journal_entry_id: string;
      credit_remaining: string;
    };
    expect(r.accounting).toBe("posted");
    expect(r.credit_remaining).toBe("0.00000000");
    const [baja] = await sql<{ ok: boolean }[]>`
      select ${await saldoAntes()}::numeric = ${antes}::numeric - 400 as ok`;
    expect(baja!.ok).toBe(true);

    // El asiento del reembolso: el pasivo con el cliente contra la cuenta de ESA caja.
    const lineas = await sql<{ cuenta: string; lado: string }[]>`
      select case when jl.account_id = (select ledger_account_id from public.company_accounts
                                          where id = ${CAJA}) then 'caja'
                  else (select purpose from public.company_account_settings s
                         where s.company_id = ${COMPANY} and s.account_id = jl.account_id
                         limit 1) end as cuenta,
             case when jl.debit_amount > 0 then 'debe' else 'haber' end as lado
        from public.journal_lines jl where jl.entry_id = ${r.journal_entry_id}
       order by jl.line_number`;
    expect(lineas).toEqual([
      { cuenta: "customer_credit_liability", lado: "debe" },
      { cuenta: "caja", lado: "haber" },
    ]);
    await invariantesEnCero();
  });

  it("el tope de devolución es ACUMULADO: lo ya devuelto cuenta", async () => {
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: PAN, quantity: "3" }],
      payments: [
        { instrument: "efectivo_bs", amount: "60.00000000", currency: "VES", account_id: CAJA },
      ],
    });
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;
    const [linea] = await sql<{ id: string }[]>`
      select id from public.document_lines where document_id = ${doc}`;
    const primera = await pedir("POST", "/v1/returns", {
      company_id: COMPANY,
      source_document_id: doc,
      warehouse_id: W1,
      reason: "Primera devolución",
      lines: [{ source_line_id: linea!.id, quantity: "2" }],
    });
    const idPrimera = ((await primera.json()) as { id: string }).id;
    expect((await pedir("POST", `/v1/returns/${idPrimera}/confirm`, {})).status).toBe(200);

    const segunda = await pedir("POST", "/v1/returns", {
      company_id: COMPANY,
      source_document_id: doc,
      warehouse_id: W1,
      reason: "Segunda devolución, de más",
      lines: [{ source_line_id: linea!.id, quantity: "2" }],
    });
    expect(segunda.status).toBe(422);
    expect(((await segunda.json()) as { message: string }).message).toContain(
      "ya se devolvieron 2",
    );
  });

  it("una devolución o un recibo de devolución no se anulan: 422", async () => {
    const [rd] = await sql<{ id: string }[]>`
      select id from public.documents where company_id = ${COMPANY} and kind = 'receipt_return'
       limit 1`;
    const r = await pedir("POST", `/v1/invoices/${rd!.id}/annul`, {
      company_id: COMPANY,
      reason: "Intento de anular la devolución",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain(
      "Solo se anula una factura o un recibo",
    );
  });

  it("VARIANTE ROTA · un recibo marcado anulado SIN reponer aparece en annulled_stock_gaps", async () => {
    const antes = await posicionPan();
    const venta = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: PAN, quantity: "2" }],
    });
    expect(venta.status).toBe(201);
    const doc = ((await venta.json()) as { document: { id: string } }).document.id;
    // Se anula POR DEBAJO del caso de uso: sin la reposición que él hace.
    await sql`update public.documents
                 set status = 'annulled', annulled_at = now(), annul_reason = 'variante rota'
               where id = ${doc}`;
    const huecos = await sql<{ document_id: string; quantity: string }[]>`
      select document_id, quantity::text as quantity
        from platform.annulled_stock_gaps(${COMPANY})`;
    expect(huecos).toEqual([{ document_id: doc, quantity: "-2.00000000" }]);
    const [bajo] = await sql<{ ok: boolean }[]>`
      select ${(await posicionPan()).q}::numeric = ${antes.q}::numeric - 2 as ok`;
    expect(bajo!.ok).toBe(true);
  });
});

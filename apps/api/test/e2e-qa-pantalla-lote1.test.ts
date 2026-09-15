import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * QA DE PANTALLA 2026-09-15 — LOTE 1, lo que el servidor tiene que sostener aunque la pantalla
 * cambie. Empresa nueva por el registro, como la bodega del QA:
 *
 *   h. 82 — el registro terminado deja la empresa ACTIVA, no «onboarding» para siempre;
 *   h. 79 — un cliente bloqueado por cobranzas SE LE VENDE DE CONTADO; fiarle no;
 *   h. 55 — una devolución en borrador se CANCELA (no queda huérfana); una cancelada no vuelve;
 *   h. 67 — un asiento GENERADO por un documento no se reversa suelto (409), el manual sí;
 *   h. 66 — el balance general cuadra con ventas: el resultado sin cerrar es patrimonio;
 *   h. 74 — agregar a quien no tiene cuenta dice qué hacer, no «eso no existe».
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const DUENO = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let COMPANY = "";
let W1 = "";
let PRODUCTO = "";
let CLIENTE = "";
let RECIBO = "";

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
  const headers: Record<string, string> = { Authorization: `Bearer ${await tokenDe(DUENO)}` };
  if (COMPANY !== "") headers["X-Company-Id"] = COMPANY;
  if (metodo !== "GET" && path !== "/v1/onboarding") {
    headers["Idempotency-Key"] = crypto.randomUUID();
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(path, {
    method: metodo,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function cotizar(customerId?: string): Promise<Response> {
  return pedir("POST", "/v1/pos/quote", {
    company_id: COMPANY,
    ...(customerId === undefined ? {} : { customer_id: customerId }),
    lines: [{ product_id: PRODUCTO, quantity: "1" }],
  });
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id, email) values (${DUENO}, ${`lote1-${RUN}@e2e.ladino`})
            on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), 'e2e-qa-lote1'
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = ${HOY}::date)`;
  });
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("QA de pantalla — lote 1", () => {
  it("h. 82: el registro terminado deja la empresa activa", async () => {
    const r = await pedir("POST", "/v1/onboarding", { business_name: `Lote1 ${RUN}` });
    expect(r.status).toBe(201);
    const f = (await r.json()) as { company_id: string; warehouse_id: string };
    COMPANY = f.company_id;
    W1 = f.warehouse_id;
    const [c] = await sql<
      { status: string }[]
    >`select status from public.companies where id = ${COMPANY}`;
    expect(c!.status).toBe("active");

    const p = await pedir("POST", "/v1/products/simple", {
      company_id: COMPANY,
      name: "Queso",
      price: { amount: "5", currency: "USD" },
      initial_stock: { quantity: "20", unit_cost: { amount: "100", currency: "VES" } },
    });
    expect(p.status).toBe(201);
    PRODUCTO = ((await p.json()) as { product: { id: string } }).product.id;
  });

  it("h. 79: al cliente bloqueado se le cotiza y se le vende de contado; fiarle no", async () => {
    const cr = await pedir("POST", "/v1/customers", {
      company_id: COMPANY,
      tax_id: "V12345678",
      legal_name: "Cliente moroso",
    });
    expect(cr.status).toBe(201);
    CLIENTE = ((await cr.json()) as { id: string }).id;
    const bl = await pedir("PUT", `/v1/customers/${CLIENTE}/blocked`, {
      company_id: COMPANY,
      blocked: true,
      reason: "cheque devuelto",
    });
    expect(bl.status).toBe(200);

    const q = await cotizar(CLIENTE);
    expect(q.status).toBe(200);
    const total = ((await q.json()) as { functional_total: string }).functional_total;

    const deContado = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
      payments: [{ instrument: "efectivo_bs", amount: total, currency: "VES" }],
    });
    expect(deContado.status).toBe(201);
    RECIBO = ((await deContado.json()) as { document: { id: string } }).document.id;

    const fiado = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: W1,
      customer_id: CLIENTE,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
    });
    expect(fiado.status).toBe(422);
    const cuerpo = (await fiado.json()) as { message: string };
    expect(cuerpo.message).toContain("no se le fía");
    // Y la venta fiada no dejó rastro: withTransaction la revirtió entera.
    const [n] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.documents
       where company_id = ${COMPANY} and customer_id = ${CLIENTE}`;
    expect(n!.n).toBe("1");
  });

  it("h. 55: una devolución en borrador se cancela, y una cancelada no se cancela otra vez", async () => {
    const [linea] = await sql<{ id: string }[]>`
      select id from public.document_lines where document_id = ${RECIBO}`;
    const borrador = await pedir("POST", "/v1/returns", {
      company_id: COMPANY,
      source_document_id: RECIBO,
      warehouse_id: W1,
      reason: "Se arrepintió",
      lines: [{ source_line_id: linea!.id, quantity: "1" }],
    });
    expect(borrador.status).toBe(201);
    const dev = ((await borrador.json()) as { id: string }).id;

    const cancelada = await pedir("POST", `/v1/returns/${dev}/cancel`, {});
    expect(cancelada.status).toBe(200);
    expect(((await cancelada.json()) as { status: string }).status).toBe("cancelled");
    const otra = await pedir("POST", `/v1/returns/${dev}/cancel`, {});
    expect(otra.status).toBe(422);
    const confirmar = await pedir("POST", `/v1/returns/${dev}/confirm`, {});
    expect(confirmar.status).toBe(422);
  });

  it("h. 67: el asiento del costo de una venta no se reversa suelto — 409 con el camino", async () => {
    const [costo] = await sql<{ id: string }[]>`
      select id from public.journal_entries
       where company_id = ${COMPANY} and source_kind = 'sales_cost' and source_id = ${RECIBO}`;
    expect(costo).toBeDefined();
    const r = await pedir("POST", `/v1/journal-entries/${costo!.id}/reverse`, {
      company_id: COMPANY,
      reason: "prueba de QA",
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("ENTRY_GENERATED_BY_DOCUMENT");
    const [gap] = await sql<{ d: string }[]>`
      select diferencia::text as d from platform.inventory_ledger_gap(${COMPANY})`;
    expect(Number(gap!.d)).toBe(0);
  });

  it("h. 66: con ventas, el balance general cuadra — el resultado sin cerrar va al patrimonio", async () => {
    const r = await pedir("GET", `/v1/accounting/reports/balance-sheet?date=${HOY}`);
    expect(r.status).toBe(200);
    const b = (await r.json()) as {
      balanced: boolean;
      equity: { account_name: string }[];
      total_assets: string;
      total_liabilities_and_equity: string;
    };
    expect(b.balanced).toBe(true);
    expect(b.equity.some((e) => e.account_name.startsWith("Resultado del ejercicio"))).toBe(true);
    const [igual] = await sql<{ ok: boolean }[]>`
      select ${b.total_assets}::numeric = ${b.total_liabilities_and_equity}::numeric as ok`;
    expect(igual!.ok).toBe(true);
  });

  it("h. 74: agregar a quien no tiene cuenta responde 404 con el mensaje que dice qué hacer", async () => {
    const r = await pedir("POST", "/v1/members", {
      company_id: COMPANY,
      email: `nadie-${RUN}@e2e.ladino`,
      role_key: "cashier",
    });
    expect(r.status).toBe(404);
    const cuerpo = (await r.json()) as { code: string; person_message: string };
    expect(cuerpo.code).toBe("MEMBER_NOT_REGISTERED");
    expect(cuerpo.person_message).toContain("todavía no tiene cuenta");
  });
});

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * ANULAR O NOTA DE CRÉDITO, Y LA DEVOLUCIÓN DEL CAJERO (ola 4 · G-10, G-14, G-07; ADR-0061, notas
 * de la ola 4).
 *
 * G-10 (PA 00071 arts. 22 y 36): una factura se ANULA solo si el papel no salió del
 * establecimiento y la operación no ocurrió — mismo día de Caracas, antes del cierre de caja,
 * período sin declarar, y la persona confirma que tiene el original y las copias. Lo demás es
 * nota de crédito. La regla la aplica el SERVIDOR, y la dice el detalle del documento
 * (`annulment`) para que la pantalla no la calcule (G-14).
 *
 * G-07: el cajero INICIA la devolución y la confirma (saldo a favor); sacar el dinero de la caja
 * exige `sales.refund`, que el cajero no tiene.
 *
 * Cada caso asevera lo que SOLO su camino produce: el `details.reason` del 409 y el permiso que
 * nombra el 403. «Otro día» no se puede fabricar por la API (el servidor fecha la emisión): lo
 * prueba el pgTAP 126 sobre `platform.invoice_annulment_blockers`.
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
const FUENTE_TASA = `BCV e2e-anular-${RUN}`;
const FUENTE_REGLA = "Carga de prueba E2E — VALIDAR-SENIAT antes de producción.";

const FUNDADOR = crypto.randomUUID();
const CAJERO = crypto.randomUUID();
const ADMINISTRATIVO = crypto.randomUUID();

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let COMPANY = "";
let DEPOSITO = "";
let PRODUCTO = "";
let CLIENTE = "";
let TOTAL_USD = "";
let CAJA = "";
/** Una caja en USD con dinero dentro: de ella sale el reembolso del administrativo. */
let CAJA_USD = "";

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
  sub: string,
  body?: unknown,
  /** La llave de idempotencia, cuando el caso la repite a propósito; si no, una nueva. */
  llave?: string,
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await tokenDe(sub)}` };
  if (COMPANY !== "") headers["X-Company-Id"] = COMPANY;
  if (metodo !== "GET" && path !== "/v1/onboarding") {
    headers["Idempotency-Key"] = llave ?? crypto.randomUUID();
  }
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

/** Una factura de UNA unidad a un cliente identificado; con `pagada`, cobrada exacta en USD. */
async function facturar(sub: string, pagada: boolean, cuenta?: string): Promise<string> {
  const r = await pedir("POST", "/v1/pos/sales", sub, {
    company_id: COMPANY,
    warehouse_id: DEPOSITO,
    customer_id: CLIENTE,
    lines: [{ product_id: PRODUCTO, quantity: "1" }],
    // P-05: una venta que deja saldo dice cuándo se paga (entrada del fixture).
    ...(pagada ? {} : { due_date: diaCaracas(15) }),
    ...(pagada
      ? {
          payments: [
            {
              instrument: "efectivo_usd",
              currency: "USD",
              amount: TOTAL_USD,
              ...(cuenta === undefined ? {} : { account_id: cuenta }),
            },
          ],
        }
      : {}),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { document: { id: string } }).document.id;
}

type Anulacion = { allowed: boolean; reason: string | null; message: string | null };
async function anulacionDe(sub: string, doc: string): Promise<Anulacion | undefined> {
  const r = await pedir("GET", `/v1/documents/${doc}`, sub);
  expect(r.status).toBe(200);
  return ((await r.json()) as { annulment?: Anulacion }).annulment;
}

async function rango(kind: string, desde: string, hasta: string): Promise<void> {
  const r = await pedir("POST", "/v1/fiscal-number-ranges", FUNDADOR, {
    company_id: COMPANY,
    kind,
    series: "A",
    range_from: desde,
    range_to: hasta,
    printer_source: "Imprenta E2E anular, autorización de prueba",
    printer_legal_name: "Imprenta E2E, C.A.",
    printer_tax_id: "J-12345678-9",
    printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
    printer_authorization_date: "2020-01-15",
    printed_on: "2026-09-01",
    alert_threshold_pct: 50,
  });
  expect(r.status).toBe(201);
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id, email) values
            (${FUNDADOR}, ${`fundador-anular-${RUN}@e2e.ladino`}),
            (${CAJERO}, ${`cajero-anular-${RUN}@e2e.ladino`}),
            (${ADMINISTRATIVO}, ${`administrativo-anular-${RUN}@e2e.ladino`})
            on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), ${FUENTE_TASA}
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = ${HOY}::date)`;
  });
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
    await tx`
      insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                                    rate, effective_from, legal_source, priority)
      select 'VE', 'iva', 'ordinario', 'gravado_general', 0.16, ${AYER}::date,
             ${FUENTE_REGLA}, 10
       where not exists (select 1 from public.tax_rules
                          where company_id is null and jurisdiction = 'VE' and tax_code = 'iva'
                            and taxpayer_type = 'ordinario'
                            and product_tax_category = 'gravado_general')`;
    await tx`
      insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                                    rate, effective_from, legal_source, priority, transaction_type)
      select 'VE', 'iva', null, 'gravado_general', 0.16, ${AYER}::date, ${FUENTE_REGLA}, 5, 'sale'
       where not exists (select 1 from public.tax_rules
                          where company_id is null and jurisdiction = 'VE' and tax_code = 'iva'
                            and taxpayer_type is null
                            and product_tax_category = 'gravado_general'
                            and transaction_type = 'sale')`;
  });
});

afterAll(async () => {
  if (sql) {
    await sql`delete from public.exchange_rates where company_id is null and source = ${FUENTE_TASA}`;
  }
  await sql?.end();
  await sqlApi?.end();
});

describe("anular o nota de crédito, y la devolución del cajero", () => {
  it("el fundador funda la empresa, factura sobre forma libre y agrega al cajero y al administrativo", async () => {
    const r = await pedir("POST", "/v1/onboarding", FUNDADOR, {
      business_name: `Bodega Anular ${RUN}`,
      tax_id: `J-76${RUN.slice(-6)
        .replace(/[^0-9]/g, "6")
        .padStart(6, "6")}-1`,
      legal_name: `Bodega Anular ${RUN}, C.A.`,
      fiscal_address: "Calle 20 con carrera 21, Barquisimeto, Lara",
      taxpayer: { taxpayer_type_code: "ordinario" },
    });
    expect(r.status).toBe(201);
    const f = (await r.json()) as { company_id: string; warehouse_id: string };
    COMPANY = f.company_id;
    DEPOSITO = f.warehouse_id;
    const regimen = await pedir("POST", "/v1/fiscal/regime", FUNDADOR, {
      regime_code: "formatos_libres",
    });
    expect(regimen.status).toBe(201);
    await rango("invoice", "1", "100");
    await rango("credit_note", "101", "200");

    const p = await pedir("POST", "/v1/products/simple", FUNDADOR, {
      company_id: COMPANY,
      name: `Producto anular ${RUN}`,
      price: { amount: "5", currency: "USD" },
      initial_stock: { quantity: "20", unit_cost: { amount: "120", currency: "VES" } },
    });
    expect(p.status).toBe(201);
    PRODUCTO = ((await p.json()) as { product: { id: string } }).product.id;
    const cliente = await pedir("POST", "/v1/customers", FUNDADOR, {
      company_id: COMPANY,
      tax_id: `V${String(Date.now()).slice(-8)}`,
      legal_name: `Cliente anular ${RUN}`,
      person_type_code: "natural",
    });
    expect(cliente.status).toBe(201);
    CLIENTE = ((await cliente.json()) as { id: string }).id;
    // Las facturas SIN cobro de este fichero son fiado (E-09): el cliente necesita su límite.
    const limite = await pedir("PUT", `/v1/customers/${CLIENTE}/credit-limit`, FUNDADOR, {
      company_id: COMPANY,
      credit_limit_usd: "500.00",
    });
    expect(limite.status).toBe(200);
    const cot = await pedir("POST", "/v1/pos/quote", FUNDADOR, {
      company_id: COMPANY,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
    });
    expect(cot.status).toBe(200);
    TOTAL_USD = ((await cot.json()) as { total: string }).total;

    const caja = await pedir("POST", "/v1/treasury/accounts", FUNDADOR, {
      company_id: COMPANY,
      name: "Caja Bs",
      currency: "VES",
      kind: "cash",
    });
    expect(caja.status).toBe(201);
    CAJA = ((await caja.json()) as { id: string }).id;
    const cajaUsd = await pedir("POST", "/v1/treasury/accounts", FUNDADOR, {
      company_id: COMPANY,
      name: "Caja USD",
      currency: "USD",
      kind: "cash",
    });
    expect(cajaUsd.status).toBe(201);
    CAJA_USD = ((await cajaUsd.json()) as { id: string }).id;

    for (const [rol, sub, correo] of [
      ["cashier", CAJERO, `cajero-anular-${RUN}@e2e.ladino`],
      ["back_office", ADMINISTRATIVO, `administrativo-anular-${RUN}@e2e.ladino`],
    ] as const) {
      const m = await pedir("POST", "/v1/members", FUNDADOR, {
        company_id: COMPANY,
        email: correo,
        role_key: rol,
      });
      expect(m.status).toBe(201);
      expect(sub).not.toBe("");
    }
    // Fundar, cargar rangos, producto, cliente, caja y dos personas: con la base compartida
    // ocupada no cabe en los 5 s por omisión.
  }, 60_000);

  // ── G-10: la persona confirma que el papel no salió ───────────────────────
  it("G-10 — sin confirmar el original y las copias, la factura NO se anula: 409 que lo dice", async () => {
    const doc = await facturar(ADMINISTRATIVO, false);
    expect(await anulacionDe(ADMINISTRATIVO, doc)).toEqual({
      allowed: true,
      reason: null,
      message: null,
    });

    const sinPapel = await pedir("POST", `/v1/invoices/${doc}/annul`, ADMINISTRATIVO, {
      company_id: COMPANY,
      reason: "G-10 — se intenta anular sin confirmar el papel",
    });
    expect(sinPapel.status).toBe(409);
    const cuerpo = (await sinPapel.json()) as { code: string; details?: { reason: string } };
    expect(cuerpo.code).toBe("ANNULMENT_NOT_ALLOWED");
    expect(cuerpo.details?.reason).toBe("originals_not_confirmed");
    const [sigue] = await sql<{ status: string }[]>`
      select status from public.documents where id = ${doc}`;
    expect(sigue?.status).toBe("issued");

    const conPapel = await pedir("POST", `/v1/invoices/${doc}/annul`, ADMINISTRATIVO, {
      company_id: COMPANY,
      reason: "G-10 — se dañó al imprimir; original y copias en mano",
      originals_in_hand: true,
    });
    expect(conPapel.status).toBe(200);
    // El acta guarda la confirmación: es lo único que dice que alguien respondió por el papel.
    const [acta] = await sql<{ payload: { originals_in_hand?: boolean } }[]>`
      select payload from public.audit_events
       where company_id = ${COMPANY} and aggregate_id = ${doc}
         and event_type = 'fiscal.invoice.annulled'`;
    expect(acta?.payload.originals_in_hand).toBe(true);
    // Y el libro de ventas la conserva con su número, «annulled» e importes en cero.
    const [fila] = await sql<{ status: string; base: string; iva: string; total: string }[]>`
      select status, base_gravada::text as base, iva_debito::text as iva,
             total_amount::text as total
        from platform.sales_book(${COMPANY}, ${HOY}::date, ${HOY}::date)
       where document_id = ${doc}`;
    expect(fila?.status).toBe("annulled");
    expect(Number(fila?.base)).toBe(0);
    expect(Number(fila?.iva)).toBe(0);
    expect(Number(fila?.total)).toBe(0);
  }, 60_000);

  // ── G-10: antes del cierre de caja ────────────────────────────────────────
  it("G-10 — con la caja ya cerrada después de emitirla, la factura no se anula: nota de crédito", async () => {
    const doc = await facturar(ADMINISTRATIVO, false);
    const [esperado] = await sql<{ b: string }[]>`
      select coalesce((select balance from public.company_account_balances
                        where account_id = ${CAJA}), 0)::text as b`;
    const cierre = await pedir("POST", "/v1/cash-closings", FUNDADOR, {
      company_id: COMPANY,
      account_id: CAJA,
      counted_amount: esperado!.b,
    });
    expect(cierre.status).toBe(201);

    const r = await pedir("POST", `/v1/invoices/${doc}/annul`, ADMINISTRATIVO, {
      company_id: COMPANY,
      reason: "G-10 — después del cierre de caja",
      originals_in_hand: true,
    });
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as {
      code: string;
      message: string;
      details?: { reason: string };
    };
    expect(cuerpo.code).toBe("ANNULMENT_NOT_ALLOWED");
    expect(cuerpo.details?.reason).toBe("cash_closed");
    expect(cuerpo.message).toContain("nota de crédito");
    const a = await anulacionDe(ADMINISTRATIVO, doc);
    expect(a?.allowed).toBe(false);
    expect(a?.reason).toBe("cash_closed");

    // El CAJERO, sobre esa misma factura ya bloqueada por el papel: 403 por el permiso de anular,
    // NO el 409 de la regla. La regla del papel se evalúa después de autorizar y no le revela a
    // quien no puede anular por qué esa factura no se anularía.
    const cajero = await pedir("POST", `/v1/invoices/${doc}/annul`, CAJERO, {
      company_id: COMPANY,
      reason: "G-10 — el cajero intenta anular una factura bloqueada por el papel",
      originals_in_hand: true,
    });
    expect(cajero.status).toBe(403);
    const negado = (await cajero.json()) as {
      code: string;
      message: string;
      person_message: string;
      details?: { reason?: string };
    };
    expect(negado.code).toBe("PERMISSION_REQUIRED");
    expect(negado.message).toBe(
      "La operación exige el permiso sales.invoice.annul sobre esta empresa.",
    );
    expect(negado.person_message).toBe(
      "Necesitas el permiso para anular ventas. Pídeselo a quien administra el negocio.",
    );
    expect(negado.details?.reason).toBeUndefined();
    expect(JSON.stringify(negado)).not.toContain("cash_closed");
  }, 60_000);

  // ── G-10: la misma llave tras un 409 ──────────────────────────────────────
  it("G-10 — tras un 409, la MISMA llave reejecuta (otro 409 de la regla, no un replay); con otro cuerpo no ejecuta nada; con llave nueva, anula", async () => {
    const doc = await facturar(ADMINISTRATIVO, false);
    const llave = crypto.randomUUID();
    const sinPapel = {
      company_id: COMPANY,
      reason: "G-10 — reintento con la misma llave",
    };
    const estado = async (): Promise<string | undefined> => {
      const [d] = await sql<{ status: string }[]>`
        select status from public.documents where id = ${doc}`;
      return d?.status;
    };

    const primero = await pedir(
      "POST",
      `/v1/invoices/${doc}/annul`,
      ADMINISTRATIVO,
      sinPapel,
      llave,
    );
    expect(primero.status).toBe(409);
    expect(((await primero.json()) as { details?: { reason: string } }).details?.reason).toBe(
      "originals_not_confirmed",
    );
    const [trasElPrimero] = await sql<{ status: string }[]>`
      select status from public.idempotency_keys where key = ${llave}`;
    expect(trasElPrimero?.status).toBe("failed");

    // Misma llave, mismo cuerpo: el 409 dejó la llave `failed`, así que se REEJECUTA. Lo que solo
    // produce este camino es el 409 de la regla (ni IN_PROGRESS ni un replay de otra respuesta).
    const segundo = await pedir(
      "POST",
      `/v1/invoices/${doc}/annul`,
      ADMINISTRATIVO,
      sinPapel,
      llave,
    );
    expect(segundo.status).toBe(409);
    const cuerpo2 = (await segundo.json()) as { code: string; details?: { reason: string } };
    expect(cuerpo2.code).toBe("ANNULMENT_NOT_ALLOWED");
    expect(cuerpo2.details?.reason).toBe("originals_not_confirmed");
    expect(await estado()).toBe("issued");

    // Misma llave, cuerpo CORREGIDO: no se ejecuta nada bajo la llave vieja (ADR-0076).
    const corregido = { ...sinPapel, originals_in_hand: true };
    const tercero = await pedir(
      "POST",
      `/v1/invoices/${doc}/annul`,
      ADMINISTRATIVO,
      corregido,
      llave,
    );
    expect(tercero.status).toBe(409);
    const cuerpo3 = (await tercero.json()) as {
      code: string;
      details?: { previous_status: string };
    };
    expect(cuerpo3.code).toBe("IDEMPOTENCY_BODY_MISMATCH");
    expect(cuerpo3.details?.previous_status).toBe("failed");
    expect(await estado()).toBe("issued");

    // Con llave nueva, la anulación ocurre, una vez.
    const cuarto = await pedir("POST", `/v1/invoices/${doc}/annul`, ADMINISTRATIVO, corregido);
    expect(cuarto.status).toBe(200);
    expect(await estado()).toBe("annulled");
    const [actas] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where company_id = ${COMPANY} and aggregate_id = ${doc}
         and event_type = 'fiscal.invoice.annulled'`;
    expect(actas?.n).toBe(1);
  }, 60_000);

  // ── G-14: la cobrada dice por qué no se anula y cuál es el camino ─────────
  it("G-14 — el detalle de una factura cobrada dice que no se anula y nombra la Devolución", async () => {
    const doc = await facturar(FUNDADOR, true);
    const a = await anulacionDe(FUNDADOR, doc);
    expect(a?.allowed).toBe(false);
    expect(a?.reason).toBe("has_payments");
    expect(a?.message).toContain("Devolución");
  }, 60_000);

  // ── G-07: el cajero inicia y confirma la devolución; el reembolso es de otro ─
  it("G-07 — el cajero devuelve una venta cobrada: saldo a favor; sacar el dinero exige sales.refund, y el administrativo lo tiene", async () => {
    const doc = await facturar(CAJERO, true, CAJA_USD);
    await facturar(CAJERO, true, CAJA_USD);
    const [linea] = await sql<{ id: string }[]>`
      select id from public.document_lines where document_id = ${doc}`;
    const borrador = await pedir("POST", "/v1/returns", CAJERO, {
      company_id: COMPANY,
      source_document_id: doc,
      warehouse_id: DEPOSITO,
      reason: "G-07 — el cliente devolvió el producto",
      lines: [{ source_line_id: linea!.id, quantity: "1" }],
    });
    expect(borrador.status).toBe(201);
    const dev = ((await borrador.json()) as { id: string }).id;
    const confirmada = await pedir("POST", `/v1/returns/${dev}/confirm`, CAJERO, {});
    expect(confirmada.status).toBe(200);
    const c = (await confirmada.json()) as {
      credit_note_id: string | null;
      customer_credit_id: string | null;
    };
    expect(c.credit_note_id).not.toBeNull();
    expect(c.customer_credit_id).not.toBeNull();
    const [nc] = await sql<{ kind: string; status: string }[]>`
      select kind, status from public.documents where id = ${c.credit_note_id}`;
    expect(nc).toEqual({ kind: "credit_note", status: "issued" });

    const [credito] = await sql<{ amount: string }[]>`
      select amount::text as amount from public.customer_credits
       where id = ${c.customer_credit_id}`;
    const reembolso = await pedir(
      "POST",
      `/v1/customer-credits/${c.customer_credit_id}/refunds`,
      CAJERO,
      {
        company_id: COMPANY,
        account_id: CAJA,
        amount: credito!.amount,
        reason: "G-07 — el cajero intenta sacar el dinero",
      },
    );
    expect(reembolso.status).toBe(403);
    // Lo que SOLO produce este camino: el permiso que falta es el de reembolsar.
    const negado = (await reembolso.json()) as { message: string; person_message: string };
    expect(negado.message).toBe("La operación exige el permiso sales.refund sobre esta empresa.");
    // Y la persona lee QUÉ permiso le falta, no un «no autorizado».
    expect(negado.person_message).toBe(
      "Necesitas el permiso para devolver dinero a un cliente. Pídeselo a quien administra el negocio.",
    );
    // El saldo a favor sigue entero: queda para quien pueda reembolsar o para la próxima compra.
    const [queda] = await sql<{ applied: string; status: string }[]>`
      select applied_amount::text as applied, status from public.customer_credits
       where id = ${c.customer_credit_id}`;
    expect(Number(queda?.applied)).toBe(0);
    expect(queda?.status).not.toBe("applied");

    // El camino del cajero termina en alguien: el ADMINISTRATIVO reembolsa (migración
    // 20261004160200: `back_office` tiene `sales.refund`), todo el saldo, desde la caja en USD.
    const pagado = await pedir(
      "POST",
      `/v1/customer-credits/${c.customer_credit_id}/refunds`,
      ADMINISTRATIVO,
      {
        company_id: COMPANY,
        account_id: CAJA_USD,
        // `whole` o `amount`, EXACTAMENTE uno (G-15): todo lo disponible lo decide el servidor.
        whole: true,
        reason: "G-07 — el administrativo devuelve el dinero al cliente",
      },
    );
    expect(pagado.status).toBe(201);
    const r = (await pagado.json()) as { customer_credit_id: string; credit_remaining: string };
    expect(r.customer_credit_id).toBe(c.customer_credit_id);
    expect(Number(r.credit_remaining)).toBe(0);
    const [consumido] = await sql<{ status: string; n: number }[]>`
      select cc.status,
             (select count(*)::int from public.customer_refunds cr
               where cr.customer_credit_id = cc.id) as n
        from public.customer_credits cc where cc.id = ${c.customer_credit_id}`;
    expect(consumido).toEqual({ status: "applied", n: 1 });
  }, 60_000);

  // ── G-07: la nota de crédito DIRECTA no es del cajero ─────────────────────
  it("G-07 — el cajero NO emite una nota de crédito directa (403 de sales.credit_note.direct); el administrativo sí", async () => {
    const doc = await facturar(CAJERO, true, CAJA_USD);
    const [linea] = await sql<{ id: string }[]>`
      select id from public.document_lines where document_id = ${doc}`;
    const nota = {
      company_id: COMPANY,
      source_document_id: doc,
      reason: "G-07 — descuento acordado después de la venta",
      lines: [{ source_line_id: linea!.id, quantity: "1" }],
    };
    const notasDe = async (): Promise<number> => {
      const [n] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.documents
         where company_id = ${COMPANY} and kind = 'credit_note' and source_document_id = ${doc}`;
      return n?.n ?? -1;
    };

    const negada = await pedir("POST", "/v1/credit-notes", CAJERO, nota);
    expect(negada.status).toBe(403);
    // Lo que SOLO produce este camino: el permiso que falta es el de la nota directa, no el de
    // las devoluciones (que el cajero SÍ tiene: el caso anterior las crea y las confirma).
    const cuerpo = (await negada.json()) as { message: string; person_message: string };
    expect(cuerpo.message).toBe(
      "La operación exige el permiso sales.credit_note.direct sobre esta empresa.",
    );
    expect(cuerpo.person_message).toBe(
      "Necesitas el permiso para emitir notas de crédito sin devolución de mercancía. Pídeselo a quien administra el negocio.",
    );
    expect(await notasDe()).toBe(0);

    const emitida = await pedir("POST", "/v1/credit-notes", ADMINISTRATIVO, nota);
    expect(emitida.status).toBe(201);
    const nc = (await emitida.json()) as { document: { kind: string; status: string } };
    expect(nc.document.kind).toBe("credit_note");
    expect(await notasDe()).toBe(1);
  }, 60_000);

  // ── Los invariantes que cruzan ────────────────────────────────────────────
  it("los invariantes siguen en cero: kardex de anuladas, cobertura contable, controles y libro = mayor", async () => {
    const [stock] = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.annulled_stock_gaps(${COMPANY})`;
    expect(stock?.n).toBe(0);
    const [cobertura] = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.accounting_coverage_gaps(${COMPANY})`;
    expect(cobertura?.n).toBe(0);
    const [controles] = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.control_number_collisions()
       where company_id = ${COMPANY}`;
    expect(controles?.n).toBe(0);
    const [libro] = await sql<{ n: number }[]>`
      select count(*)::int as n
        from platform.book_ledger_reconciliation(${COMPANY}, ${HOY}::date, ${HOY}::date)
       where not cuadra`;
    expect(libro?.n).toBe(0);
    // G-10: las facturas anuladas en este fichero pasaron por la regla del papel.
    const [papel] = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.annulment_paper_gaps(${COMPANY})`;
    expect(papel?.n).toBe(0);
    const [anuladas] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.documents
       where company_id = ${COMPANY} and kind = 'invoice' and status = 'annulled'`;
    expect(anuladas?.n).toBeGreaterThan(0);
  }, 60_000);
});

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * LA LLEGADA DE MERCANCÍA, DE EXTREMO A EXTREMO (ADR-0066).
 *
 * Lo que este fichero está aquí para demostrar, y que ningún test unitario ve:
 *   1. las CUATRO salidas contables de una sola puerta —ya era mía · con factura · la factura
 *      viene después · no va a haber factura— con sus cifras en el libro, en la declaración y
 *      en el mayor;
 *   2. el CICLO COMPLETO de la cuenta puente: recibir sin factura la deja con saldo, y
 *      engancharla después la devuelve a CERO. No existía ningún test de esto;
 *   3. la fecha acotada: más de dos días atrás no es una llegada, y lo vendido entre medias se
 *      enseña antes de confirmar;
 *   4. el permiso POR CAMINO: quien solo puede recibir, recibe — y no registra facturas;
 *   5. lote y vencimiento sobreviven a la llegada (sin ellos muere el FEFO);
 *   6. la idempotencia de un flujo de seis pantallas: la misma clave no crea dos llegadas;
 *   7. y al final, los invariantes en cero por cualquiera de los cuatro caminos.
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
const JEFE = crypto.randomUUID();
const RECIBIDOR = crypto.randomUUID();
const PROV = crypto.randomUUID();
const ROL_JEFE = crypto.randomUUID();
const ROL_REC = crypto.randomUUID();
const MEM_JEFE = crypto.randomUUID();
const MEM_REC = crypto.randomUUID();
const ASIG_JEFE = crypto.randomUUID();
const ASIG_REC = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const AYER = diaCaracas(-1);
const HACE_TRES = diaCaracas(-3);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PROD = "";
let PROD_LOTE = "";
let COMPUESTO = "";

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
  clave?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(sub)}`,
    "X-Company-Id": COMPANY,
  };
  if (metodo !== "GET") headers["Idempotency-Key"] = clave ?? crypto.randomUUID();
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

/** El saldo de una cuenta por su PAPEL, que es como se configura (nunca por código). */
async function saldoDePapel(purpose: string): Promise<{ debe: string; haber: string }> {
  const [cuenta] = await sql<{ account_id: string }[]>`
    select account_id from public.company_account_settings
     where company_id = ${COMPANY} and purpose = ${purpose} and effective_to is null`;
  if (!cuenta) return { debe: "0", haber: "0" };
  const [b] = await sql<{ debit_total: string; credit_total: string }[]>`
    select debit_total::text, credit_total::text
      from platform.recompute_ledger(${COMPANY}, ${cuenta.account_id})`;
  return { debe: b?.debit_total ?? "0", haber: b?.credit_total ?? "0" };
}

async function existencia(producto: string): Promise<number> {
  const [s] = await sql<{ q: string }[]>`
    select coalesce(sum(quantity), 0)::text as q from public.stock_balances
     where company_id = ${COMPANY} and product_id = ${producto}`;
  return Number(s!.q);
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${JEFE}), (${RECIBIDOR})
            on conflict (id) do nothing`;

  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${JEFE}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant llegada')`;
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-LLEG-${RUN}`}, 'Bodega de la llegada', 'VES',
                     'ordinario')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'LLEG-W1', 'Depósito')`;
    await tx`insert into public.suppliers
               (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code,
                taxpayer_type_code)
             values (${PROV}, ${TENANT}, ${COMPANY}, ${`J-PRV-${RUN}`}, 'Distribuidora Andina',
                     'nacional', 'juridica', 'ordinario')`;

    // Dos roles: el que puede todo, y el que SOLO puede recibir (recepción a ciegas).
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL_JEFE}, null, ${`lleg_jefe_${RUN}`}, 'Jefe llegada', true),
             (${ROL_REC}, null, ${`lleg_rec_${RUN}`}, 'Recibidor', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL_JEFE}, 'inventory.move'), (${ROL_JEFE}, 'inventory.adjust'),
             (${ROL_JEFE}, 'purchase.receive'), (${ROL_JEFE}, 'purchase.invoice.register'),
             (${ROL_JEFE}, 'purchase.payment.register'), (${ROL_JEFE}, 'purchase.order.manage'),
             (${ROL_JEFE}, 'supplier.manage'), (${ROL_JEFE}, 'ap.read'),
             (${ROL_JEFE}, 'product.manage'), (${ROL_JEFE}, 'fx.rate.manage'),
             (${ROL_JEFE}, 'accounting.account.manage'), (${ROL_JEFE}, 'accounting.template.manage'),
             (${ROL_JEFE}, 'accounting.read'), (${ROL_JEFE}, 'treasury.read'),
             (${ROL_REC}, 'purchase.receive'), (${ROL_REC}, 'inventory.move')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${MEM_JEFE}, ${TENANT}, ${JEFE}), (${MEM_REC}, ${TENANT}, ${RECIBIDOR})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${ASIG_JEFE}, ${TENANT}, ${MEM_JEFE}, ${ROL_JEFE}, null),
             (${ASIG_REC}, ${TENANT}, ${MEM_REC}, ${ROL_REC}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id) values
             (${TENANT}, ${COMPANY}, ${ASIG_JEFE}, 'warehouse', ${W1}),
             (${TENANT}, ${COMPANY}, ${ASIG_REC}, 'warehouse', ${W1})`;

    const [p] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`LLEG-${RUN}`}, 'Harina PAN', 'good', 'active', 'unidad',
              'gravado_general')
      returning id`;
    PROD = p!.id;
    const [pl] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code, tracks_lots, tracks_expiry)
      values (${TENANT}, ${COMPANY}, ${`LLEG-LOTE-${RUN}`}, 'Leche en polvo', 'good', 'active',
              'unidad', 'gravado_general', true, true)
      returning id`;
    PROD_LOTE = pl!.id;
    const [pc] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code, is_composed)
      values (${TENANT}, ${COMPANY}, ${`LLEG-COMP-${RUN}`}, 'Arepa rellena', 'good', 'active',
              'unidad', 'gravado_general', true)
      returning id`;
    COMPUESTO = pc!.id;

    // La regla de IVA de compra, global y guardada: cuatro ficheros la siembran en paralelo.
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
  });

  // La contabilidad, para poder mirar el MAYOR y no solo la cola.
  const plan = await pedir("POST", "/v1/accounts/import-template", JEFE, {
    company_id: COMPANY,
    template_code: "ve_basico",
  });
  if (plan.status !== 201) throw new Error(`plan: ${plan.status} ${await plan.text()}`);
  const preset = await pedir("POST", "/v1/journal-templates/import-preset", JEFE, {
    company_id: COMPANY,
    preset_code: "ve_basico",
  });
  if (preset.status !== 201) throw new Error(`preset: ${preset.status} ${await preset.text()}`);
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("llegó mercancía — la única puerta (ADR-0066)", () => {
  // ── 1. «Ya era mía» ───────────────────────────────────────────────────────
  it("sin proveedor entra como mercancía tuya: contra aportes, sin deuda y fuera del libro", async () => {
    const antes = await existencia(PROD);
    const r = await pedir("POST", "/v1/arrivals", JEFE, {
      company_id: COMPANY,
      warehouse_id: W1,
      currency: "VES",
      lines: [{ product_id: PROD, quantity: "10", unit_amount: "100" }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const a = (await r.json()) as { kind: string; moves: { id: string }[]; invoice: unknown };
    expect(a.kind).toBe("own");
    expect(a.invoice).toBeNull();
    expect(a.moves).toHaveLength(1);
    expect(await existencia(PROD)).toBe(antes + 10);

    // Aportes en inventario acreditado por el costo: nadie queda debiendo nada.
    const aportes = await saldoDePapel("opening_equity");
    expect(Number(aportes.haber)).toBeGreaterThanOrEqual(1000);
    // Y no hay documento de compra ninguno.
    const [n] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.supplier_invoices where company_id = ${COMPANY}`;
    expect(n!.n).toBe("0");
  });

  // ── 2. Con factura ────────────────────────────────────────────────────────
  it("con factura: entra al depósito, al libro de compras y al crédito fiscal, y queda la deuda", async () => {
    const [antes] = await sql<{ c: string }[]>`
      select creditos::text as c
        from platform.recompute_iva_period(${COMPANY}, ${HOY}::date, ${HOY}::date, 0)`;
    const stockAntes = await existencia(PROD);

    const r = await pedir("POST", "/v1/arrivals", JEFE, {
      company_id: COMPANY,
      warehouse_id: W1,
      currency: "VES",
      supplier_id: PROV,
      invoice: "present",
      supplier_document_number: `F-${RUN}-1`,
      supplier_control_number: `00-${RUN}1`,
      lines: [{ product_id: PROD, quantity: "20", unit_amount: "500" }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const a = (await r.json()) as {
      kind: string;
      invoice: { id: string; total_amount: string; tax_amount: string; fiscal_support: boolean };
      receipt: { id: string };
      payment: unknown;
    };
    expect(a.kind).toBe("invoiced");
    expect(a.payment).toBeNull();
    expect(a.invoice.fiscal_support).toBe(true);
    // 20 × 500 = 10.000 de base, 16 % = 1.600 de IVA.
    expect(a.invoice.tax_amount).toBe("1600.00000000");
    expect(a.invoice.total_amount).toBe("11600.00000000");
    expect(await existencia(PROD)).toBe(stockAntes + 20);

    // El libro la trae…
    const [enLibro] = await sql<{ iva: string }[]>`
      select iva_credito::text as iva
        from platform.purchases_book(${COMPANY}, ${HOY}::date, ${HOY}::date)
       where invoice_id = ${a.invoice.id}`;
    expect(enLibro!.iva).toBe("1600.00000000");
    // …y la declaración sube por lo mismo.
    const [despues] = await sql<{ c: string }[]>`
      select creditos::text as c
        from platform.recompute_iva_period(${COMPANY}, ${HOY}::date, ${HOY}::date, 0)`;
    expect(Number(despues!.c) - Number(antes!.c)).toBe(1600);
    // Y se le debe el total al proveedor.
    const [saldo] = await sql<{ s: string }[]>`
      select platform.supplier_invoice_balance(${COMPANY}, ${a.invoice.id})::text as s`;
    expect(saldo!.s).toBe("11600.00000000");
  });

  // ── 3 y 4. La factura viene después, y el ciclo de la cuenta puente ───────
  it("«todavía no me la dan»: recibe contra la cuenta puente, y la factura de después la deja en CERO", async () => {
    const puenteAntes = await saldoDePapel("goods_received_not_invoiced");
    const stockAntes = await existencia(PROD);

    const r = await pedir("POST", "/v1/arrivals", JEFE, {
      company_id: COMPANY,
      warehouse_id: W1,
      currency: "VES",
      supplier_id: PROV,
      invoice: "pending",
      reference: `GUIA-${RUN}`,
      lines: [{ product_id: PROD, quantity: "5", amount: "2500" }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const a = (await r.json()) as { kind: string; receipt: { id: string }; invoice: unknown };
    expect(a.kind).toBe("receipt");
    expect(a.invoice).toBeNull();
    expect(await existencia(PROD)).toBe(stockAntes + 5);

    // La mercancía está dentro y la cuenta puente la debe: 5 × 500 = 2.500.
    const puenteDespues = await saldoDePapel("goods_received_not_invoiced");
    expect(Number(puenteDespues.haber) - Number(puenteAntes.haber)).toBe(2500);

    // No está en el libro: todavía no hay documento.
    const [enLibro] = await sql<{ n: string }[]>`
      select count(*)::text as n
        from platform.purchases_book(${COMPANY}, ${HOY}::date, ${HOY}::date)
       where supplier_document_number = ${`GUIA-${RUN}`}`;
    expect(enLibro!.n).toBe("0");

    // Y aparece en «Falta la factura».
    const pendientes = await pedir("GET", "/v1/goods-receipts?pending_invoice=1", JEFE);
    expect(pendientes.status).toBe(200);
    const lista = (await pendientes.json()) as { items: { id: string; age_days: number }[] };
    expect(lista.items.some((i) => i.id === a.receipt.id)).toBe(true);

    // EL CICLO: llega la factura y se engancha a lo recibido.
    const lineas = await sql<{ id: string; product_id: string; quantity: string }[]>`
      select id, product_id, quantity::text as quantity from public.goods_receipt_lines
       where goods_receipt_id = ${a.receipt.id} order by line_number`;
    const factura = await pedir("POST", "/v1/supplier-invoices", JEFE, {
      company_id: COMPANY,
      supplier_id: PROV,
      supplier_document_number: `F-${RUN}-2`,
      supplier_control_number: `00-${RUN}2`,
      invoice_date: HOY,
      currency: "VES",
      lines: lineas.map((l) => ({
        goods_receipt_line_id: l.id,
        product_id: l.product_id,
        quantity: l.quantity,
        unit_price: "500",
      })),
    });
    expect(factura.status, await factura.clone().text()).toBe(201);

    // La cuenta puente vuelve a CERO: lo recibido ya está facturado. Este es el invariante que
    // no tenía test — la cuenta puede crecer para siempre sin que nada lo note.
    const puenteFinal = await saldoDePapel("goods_received_not_invoiced");
    expect(Number(puenteFinal.debe) - Number(puenteAntes.debe)).toBe(2500);
    expect(Number(puenteFinal.haber) - Number(puenteFinal.debe)).toBe(
      Number(puenteAntes.haber) - Number(puenteAntes.debe),
    );

    // Y ya no está en «Falta la factura».
    const despues = await pedir("GET", "/v1/goods-receipts?pending_invoice=1", JEFE);
    const lista2 = (await despues.json()) as { items: { id: string }[] };
    expect(lista2.items.some((i) => i.id === a.receipt.id)).toBe(false);
  });

  // ── 5. No va a haber factura ──────────────────────────────────────────────
  it("«no va a haber factura»: entra al costo pagado y a la deuda, pero NO al libro ni al crédito fiscal", async () => {
    const [antes] = await sql<{ c: string }[]>`
      select creditos::text as c
        from platform.recompute_iva_period(${COMPANY}, ${HOY}::date, ${HOY}::date, 0)`;
    const stockAntes = await existencia(PROD);

    const r = await pedir("POST", "/v1/arrivals", JEFE, {
      company_id: COMPANY,
      warehouse_id: W1,
      currency: "VES",
      supplier_id: PROV,
      invoice: "none",
      lines: [{ product_id: PROD, quantity: "4", amount: "1200" }],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const a = (await r.json()) as {
      kind: string;
      invoice: {
        id: string;
        total_amount: string;
        tax_amount: string;
        fiscal_support: boolean;
        supplier_document_number: string | null;
      };
    };
    expect(a.kind).toBe("unsupported");
    expect(a.invoice.fiscal_support).toBe(false);
    expect(a.invoice.supplier_document_number).toBeNull();
    // Lo pagado ES el costo: sin IVA que discriminar.
    expect(a.invoice.tax_amount).toBe("0.00000000");
    expect(a.invoice.total_amount).toBe("1200.00000000");
    expect(await existencia(PROD)).toBe(stockAntes + 4);

    const [enLibro] = await sql<{ n: string }[]>`
      select count(*)::text as n
        from platform.purchases_book(${COMPANY}, ${HOY}::date, ${HOY}::date)
       where invoice_id = ${a.invoice.id}`;
    expect(enLibro!.n).toBe("0");
    const [despues] = await sql<{ c: string }[]>`
      select creditos::text as c
        from platform.recompute_iva_period(${COMPANY}, ${HOY}::date, ${HOY}::date, 0)`;
    expect(despues!.c).toBe(antes!.c);
    const [saldo] = await sql<{ s: string }[]>`
      select platform.supplier_invoice_balance(${COMPANY}, ${a.invoice.id})::text as s`;
    expect(saldo!.s).toBe("1200.00000000");
  });

  // ── 5b. Con factura y pagada en el acto ──────────────────────────────────
  it("pagada en el acto: la factura queda saldada y el dinero sale de la cuenta", async () => {
    const r = await pedir("POST", "/v1/arrivals", JEFE, {
      company_id: COMPANY,
      warehouse_id: W1,
      currency: "VES",
      supplier_id: PROV,
      invoice: "present",
      supplier_document_number: `F-${RUN}-3`,
      supplier_control_number: `00-${RUN}3`,
      lines: [{ product_id: PROD, quantity: "2", unit_amount: "250" }],
      // Sin forma de pago configurada, el servidor resuelve «Sin asignar (Bs.)»; aquí se prueba
      // el PAGO, no el saldo, así que el sobregiro se confirma explícitamente (ADR-0062 §4).
      payment: { instrument: "transferencia", allow_negative_balance: true },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const a = (await r.json()) as {
      kind: string;
      invoice: { id: string; total_amount: string };
      payment: { balance: string; invoice_status: string; payment: { net_amount: string } } | null;
    };
    expect(a.kind).toBe("invoiced");
    expect(a.payment).not.toBeNull();
    // 2 × 250 = 500 de base, 16 % = 80: se pagan 580 y no queda debiendo nada.
    expect(a.invoice.total_amount).toBe("580.00000000");
    expect(a.payment!.payment.net_amount).toBe("580.00000000");
    expect(a.payment!.balance).toBe("0.00000000");
    expect(a.payment!.invoice_status).toBe("paid");

    // Y el dinero salió de una cuenta de verdad: la de sistema queda en negativo.
    const [cuenta] = await sql<{ balance: string }[]>`
      select b.balance::text as balance
        from public.company_accounts ca
        join public.company_account_balances b on b.account_id = ca.id
       where ca.company_id = ${COMPANY} and ca.is_system and ca.currency = 'VES'`;
    expect(Number(cuenta!.balance)).toBeLessThanOrEqual(-580);
  });

  // ── 6. La fecha, acotada ──────────────────────────────────────────────────
  it("una llegada de hace tres días se rechaza y remite a Conteo; la de ayer entra", async () => {
    const vieja = await pedir("POST", "/v1/arrivals", JEFE, {
      company_id: COMPANY,
      warehouse_id: W1,
      currency: "VES",
      arrived_on: HACE_TRES,
      lines: [{ product_id: PROD, quantity: "1", unit_amount: "100" }],
    });
    expect(vieja.status).toBe(422);
    const motivo = (await vieja.json()) as { message: string };
    expect(motivo.message).toMatch(/Conteo, ajustes y traslados/);

    const ayer = await pedir("POST", "/v1/arrivals", JEFE, {
      company_id: COMPANY,
      warehouse_id: W1,
      currency: "VES",
      arrived_on: AYER,
      lines: [{ product_id: PROD, quantity: "1", unit_amount: "100" }],
    });
    expect(ayer.status, await ayer.clone().text()).toBe(201);
  });

  it("lo vendido desde esa fecha se puede contar antes de confirmar", async () => {
    const r = await pedir("GET", `/v1/arrivals/impact?from=${AYER}&product_ids=${PROD}`, JEFE);
    expect(r.status).toBe(200);
    const cuerpo = (await r.json()) as { sales_since: { product_id: string }[] };
    // Sin ventas en este fichero, la lista está vacía — y eso es exactamente lo que la
    // pantalla necesita saber para no asustar a nadie sin motivo.
    expect(Array.isArray(cuerpo.sales_since)).toBe(true);
  });

  // ── 7. Idempotencia ───────────────────────────────────────────────────────
  it("la misma clave de idempotencia no crea dos llegadas", async () => {
    const clave = crypto.randomUUID();
    const cuerpo = {
      company_id: COMPANY,
      warehouse_id: W1,
      currency: "VES",
      lines: [{ product_id: PROD, quantity: "3", unit_amount: "100" }],
    };
    const antes = await existencia(PROD);
    const uno = await pedir("POST", "/v1/arrivals", JEFE, cuerpo, clave);
    expect(uno.status, await uno.clone().text()).toBe(201);
    const dos = await pedir("POST", "/v1/arrivals", JEFE, cuerpo, clave);
    expect(dos.status).toBe(201);
    // La existencia subió UNA vez: la segunda llamada devolvió la misma respuesta.
    expect(await existencia(PROD)).toBe(antes + 3);
    // Y la respuesta es LA MISMA (el orden de las claves no: la guarda la almacena como jsonb).
    expect(await dos.json()).toEqual(await uno.json());
  });

  // ── 8. Lote y vencimiento ─────────────────────────────────────────────────
  it("el producto que lleva lote entra con su lote y su vencimiento: el FEFO sigue vivo", async () => {
    const vence = diaCaracas(60);
    const r = await pedir("POST", "/v1/arrivals", JEFE, {
      company_id: COMPANY,
      warehouse_id: W1,
      currency: "VES",
      supplier_id: PROV,
      invoice: "pending",
      lines: [
        {
          product_id: PROD_LOTE,
          quantity: "12",
          unit_amount: "80",
          lot_code: `L-${RUN}`,
          lot_expires_at: vence,
        },
      ],
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const [lote] = await sql<{ code: string; expires_at: string; q: string }[]>`
      select l.code, l.expires_at::text as expires_at,
             coalesce(sum(b.quantity), 0)::text as q
        from public.lots l
        left join public.stock_balances b on b.lot_id = l.id
       where l.company_id = ${COMPANY} and l.product_id = ${PROD_LOTE}
       group by l.code, l.expires_at`;
    expect(lote!.code).toBe(`L-${RUN}`);
    expect(lote!.expires_at).toBe(vence);
    expect(Number(lote!.q)).toBe(12);
  });

  // ── 9. El compuesto ───────────────────────────────────────────────────────
  it("un producto que se arma con receta no entra por la puerta: lo que entra son sus ingredientes", async () => {
    const r = await pedir("POST", "/v1/arrivals", JEFE, {
      company_id: COMPANY,
      warehouse_id: W1,
      currency: "VES",
      lines: [{ product_id: COMPUESTO, quantity: "1", unit_amount: "10" }],
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("COMPOSED_HAS_NO_STOCK");
  });

  // ── 10. El permiso por camino ─────────────────────────────────────────────
  it("quien solo puede recibir, recibe — y no registra facturas", async () => {
    const recibe = await pedir("POST", "/v1/arrivals", RECIBIDOR, {
      company_id: COMPANY,
      warehouse_id: W1,
      currency: "VES",
      supplier_id: PROV,
      invoice: "pending",
      lines: [{ product_id: PROD, quantity: "2", unit_amount: "500" }],
    });
    expect(recibe.status, await recibe.clone().text()).toBe(201);

    const factura = await pedir("POST", "/v1/arrivals", RECIBIDOR, {
      company_id: COMPANY,
      warehouse_id: W1,
      currency: "VES",
      supplier_id: PROV,
      invoice: "present",
      supplier_document_number: `F-${RUN}-9`,
      supplier_control_number: `00-${RUN}9`,
      lines: [{ product_id: PROD, quantity: "2", unit_amount: "500" }],
    });
    expect(factura.status).toBe(403);
    // Mover existencia SÍ puede —recibir es mover—, pero registrar la factura del proveedor es
    // otro oficio y otro permiso. Esa es la recepción a ciegas: cuenta, no valora.
  });

  // ── 11. EL CRITERIO: los invariantes, en cero por los cuatro caminos ──────
  it("EL CRITERIO: cobertura contable vacía, kardex materializado = recalculado, kardex = mayor", async () => {
    const huecos = await sql<{ source_kind: string; problem: string }[]>`
      select source_kind, problem from platform.accounting_coverage_gaps(${COMPANY})`;
    expect(huecos).toEqual([]);

    const descuadres = await sql<{ product_id: string }[]>`
      select product_id from platform.stock_reconciliation(${COMPANY})
       where materialized_quantity <> recomputed_quantity
          or materialized_value <> recomputed_value`;
    expect(descuadres).toEqual([]);

    const inv = await sql<{ move_id: string; problem: string }[]>`
      select move_id, problem from platform.inventory_coverage_gaps(${COMPANY})`;
    expect(inv).toEqual([]);

    // Kardex = mayor + lo que está en cola (ADR-0060). La llegada fechada AYER se encola a
    // propósito: las plantillas se importaron hoy y la vigencia se elige por la fecha del
    // hecho (ADR-0055). Lo que no puede haber es diferencia que la cola no explique.
    const [gap] = await sql<
      { kardex: string; mayor: string; diferencia: string; en_cola: string }[]
    >`
      select kardex::text, mayor::text, diferencia::text, en_cola::text
        from platform.inventory_ledger_gap(${COMPANY})`;
    expect(gap!.diferencia).toBe(gap!.en_cola);
  });
});

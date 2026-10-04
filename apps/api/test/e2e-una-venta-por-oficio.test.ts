import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * UNA VENTA POR CADA OFICIO (ADR-0068; hallazgos N-01, N-02, N-04, B-16).
 *
 * Una sola empresa, fundada por un dueño real, con un producto con existencia y CUATRO personas
 * agregadas con su rol de sistema: cajero, encargado, administrativo y un «Dueño» invitado por
 * el fundador (asignación ACOTADA a la empresa, no de negocio). Cada oficio hace su trabajo por
 * el camino real de la API, y cada caso asevera lo que SOLO ese camino produce:
 *   · el cajero y el Dueño invitado venden de contado: 201, factura pagada y un movimiento de
 *     kardex con el documento como origen. La salida la autoriza la venta
 *     (`sales.invoice.issue`), no `inventory.move`, que ninguno de los dos tiene;
 *   · el cajero NO saca mercancía por la ruta suelta: 403 con el mensaje de `inventory.move`
 *     (la venta abre el paso interior, no la ruta suelta);
 *   · el encargado y el administrativo venden igual, con su binding de almacén (ADR-0025 §4);
 *   · el Dueño invitado lista a las personas de su empresa, fundador incluido;
 *   · el encargado da de alta un producto CON precio (el precio lo autoriza `product.manage`);
 *   · el administrativo anula una factura sin cobro: 200 y el asiento original REVERSADO, leído
 *     de la base (la reversa la autoriza `sales.invoice.annul`).
 * El fiado con límite de crédito (E-09) queda fuera de este fichero.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";

const RUN = Date.now().toString(36);
const HOY = diaCaracas();
// Las reglas y la tasa GLOBALES se siembran desde AYER, como en los demás E2E: si este fichero
// corriera primero y las sembrara desde HOY, el `where not exists` de los demás no sembraría la
// suya, y un E2E que emite con fecha de ayer (e2e-sales, «el caso del dueño») se quedaría sin regla.
const AYER = diaCaracas(-1);
const FUENTE_TASA = `BCV e2e-oficio-${RUN}`;
const FUENTE_REGLA = "Carga de prueba E2E — VALIDAR-SENIAT antes de producción.";

const FUNDADOR = crypto.randomUUID();
const CAJERO = crypto.randomUUID();
const ENCARGADO = crypto.randomUUID();
const ADMINISTRATIVO = crypto.randomUUID();
const DUENO_INVITADO = crypto.randomUUID();

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let COMPANY = "";
let DEPOSITO = "";
let PRODUCTO = "";
let CLIENTE = "";
/** El total (USD, con IVA) de vender UNA unidad — igual para todos los oficios. */
let TOTAL_USD = "";

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
  };
  if (COMPANY !== "") headers["X-Company-Id"] = COMPANY;
  if (metodo !== "GET" && path !== "/v1/onboarding") {
    headers["Idempotency-Key"] = crypto.randomUUID();
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

/** Agrega a `sub` con `roleKey` y devuelve el cuerpo de POST /v1/members. */
async function agregar(roleKey: string, sub: string, correo: string) {
  const r = await pedir("POST", "/v1/members", FUNDADOR, {
    company_id: COMPANY,
    email: correo,
    role_key: roleKey,
  });
  return r;
}

/**
 * Una venta de contado de UNA unidad, pagada en USD exacto. A un cliente IDENTIFICADO: sobre forma
 * libre la factura no va al «Consumidor final» (PA 00071 art. 13.7, P-57).
 */
async function venderContado(sub: string) {
  return pedir("POST", "/v1/pos/sales", sub, {
    company_id: COMPANY,
    warehouse_id: DEPOSITO,
    customer_id: CLIENTE,
    lines: [{ product_id: PRODUCTO, quantity: "1" }],
    payments: [{ instrument: "efectivo_usd", currency: "USD", amount: TOTAL_USD }],
  });
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id, email) values
            (${FUNDADOR}, ${`fundador-oficio-${RUN}@e2e.ladino`}),
            (${CAJERO}, ${`cajero-oficio-${RUN}@e2e.ladino`}),
            (${ENCARGADO}, ${`encargado-oficio-${RUN}@e2e.ladino`}),
            (${ADMINISTRATIVO}, ${`administrativo-oficio-${RUN}@e2e.ladino`}),
            (${DUENO_INVITADO}, ${`dueno-invitado-oficio-${RUN}@e2e.ladino`})
            on conflict (id) do nothing`;
  // La tasa oficial del día: GLOBAL, con guardia de carrera (varios ficheros
  // E2E la siembran en paralelo — vitest corre los ficheros en paralelo).
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
  // La regla de IVA general, 16 %: GLOBAL y sin clave única (ADR-0038), con el
  // mismo guardia que usan los demás E2E de ventas.
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
  // La tasa sembrada es GLOBAL: se borra al terminar, como manda _tasa-oficial.ts.
  if (sql) {
    await sql`delete from public.exchange_rates where company_id is null and source = ${FUENTE_TASA}`;
  }
  await sql?.end();
  await sqlApi?.end();
});

describe("una venta por cada oficio", () => {
  it("el fundador funda la empresa y activa la facturación", async () => {
    const r = await pedir("POST", "/v1/onboarding", FUNDADOR, {
      business_name: `Bodega Oficios ${RUN}`,
      tax_id: `J-78${RUN.slice(-6)
        .replace(/[^0-9]/g, "7")
        .padStart(6, "7")}-1`,
      legal_name: `Bodega Oficios ${RUN}, C.A.`,
      fiscal_address: "Calle 20 con carrera 21, Barquisimeto, Lara",
      // ADR-0072 §1: con RIF, el registro declara el tipo; sin él no se factura.
      taxpayer: { taxpayer_type_code: "ordinario" },
    });
    expect(r.status).toBe(201);
    const f = (await r.json()) as { company_id: string; warehouse_id: string };
    COMPANY = f.company_id;
    DEPOSITO = f.warehouse_id;

    // El régimen de forma libre, por el MISMO camino que la puesta a punto: sin esto la
    // empresa no factura y ninguno de los casos de este fichero se ejercería.
    const regimen = await pedir("POST", "/v1/fiscal/regime", FUNDADOR, {
      regime_code: "formatos_libres",
    });
    expect(regimen.status).toBe(201);

    const rango = await pedir("POST", "/v1/fiscal-number-ranges", FUNDADOR, {
      company_id: COMPANY,
      kind: "invoice",
      series: "A",
      range_from: "1",
      range_to: "100",
      printer_source: "Imprenta E2E oficios, autorización de prueba",
      printer_legal_name: "Imprenta E2E, C.A.",
      printer_tax_id: "J-12345678-9",
      printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
      printer_authorization_date: "2020-01-15",
      printed_on: "2026-09-01",
      alert_threshold_pct: 50,
    });
    expect(rango.status).toBe(201);
  });

  it("el fundador carga UN producto con existencia y UN cliente con nombre", async () => {
    const p = await pedir("POST", "/v1/products/simple", FUNDADOR, {
      company_id: COMPANY,
      name: `Producto oficio ${RUN}`,
      price: { amount: "5", currency: "USD" },
      initial_stock: { quantity: "20", unit_cost: { amount: "120", currency: "VES" } },
    });
    expect(p.status).toBe(201);
    PRODUCTO = ((await p.json()) as { product: { id: string } }).product.id;

    const cliente = await pedir("POST", "/v1/customers", FUNDADOR, {
      company_id: COMPANY,
      tax_id: `V${String(Date.now()).slice(-8)}`,
      legal_name: `Cliente oficio ${RUN}`,
      person_type_code: "natural",
    });
    expect(cliente.status).toBe(201);
    CLIENTE = ((await cliente.json()) as { id: string }).id;

    // El total con IVA de UNA unidad: 5 + 16 % = 5.80 USD. Lo confirma el
    // servidor (no aritmética en el test) con la MISMA cotización que usa la
    // caja, para que cada venta de este fichero pague EXACTO.
    const cot = await pedir("POST", "/v1/pos/quote", FUNDADOR, {
      company_id: COMPANY,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
    });
    expect(cot.status).toBe(200);
    TOTAL_USD = ((await cot.json()) as { total: string }).total;
  });

  it("el fundador agrega a los cuatro oficios, cada uno con SU rol de sistema", async () => {
    const cajero = await agregar("cashier", CAJERO, `cajero-oficio-${RUN}@e2e.ladino`);
    expect(cajero.status).toBe(201);
    const encargado = await agregar(
      "store_manager",
      ENCARGADO,
      `encargado-oficio-${RUN}@e2e.ladino`,
    );
    expect(encargado.status).toBe(201);
    const administrativo = await agregar(
      "back_office",
      ADMINISTRATIVO,
      `administrativo-oficio-${RUN}@e2e.ladino`,
    );
    expect(administrativo.status).toBe(201);
    // El «Dueño invitado»: lo agrega OTRO fundador (el que fundó la empresa),
    // con el rol `owner` — la asignación nace ACOTADA a esta empresa
    // (members.ts:174-182), nunca a nivel de negocio como la del fundador.
    const dueno = await agregar("owner", DUENO_INVITADO, `dueno-invitado-oficio-${RUN}@e2e.ladino`);
    expect(dueno.status).toBe(201);
  });

  // ── N-01: el cajero vende mercancía ───────────────────────────────────────
  it("N-01 — el cajero vende de contado como cualquier otro oficio: 201, documento y kardex", async () => {
    const r = await venderContado(CAJERO);
    expect(r.status).toBe(201);
    const cuerpo = (await r.json()) as {
      document: { id: string; kind: string; status: string };
      document_status: string;
    };
    expect(cuerpo.document_status).toBe("paid");
    const [mov] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.inventory_moves
         where company_id = ${COMPANY} and source_document_id = ${cuerpo.document.id}`;
    expect(mov?.n).toBeGreaterThan(0);
  });

  // ── N-01, el negativo: la ruta SUELTA sigue cerrada al cajero ───────────────
  it("el cajero NO saca mercancía por la ruta suelta: 403 de inventory.move", async () => {
    const r = await pedir("POST", "/v1/inventory/issues", CAJERO, {
      company_id: COMPANY,
      warehouse_id: DEPOSITO,
      product_id: PRODUCTO,
      quantity: "1",
      reason: "merma",
      reference: `suelta-cajero-${RUN}`,
    });
    expect(r.status).toBe(403);
    const cuerpo = (await r.json()) as { message: string; person_message: string };
    // Lo que SOLO produce la ruta suelta: el permiso que falta es inventory.move, no el de vender.
    expect(cuerpo.message).toBe("La operación exige el permiso inventory.move sobre esta empresa.");
    expect(cuerpo.person_message).toBe(
      "Necesitas el permiso para mover mercancía en el almacén. Pídeselo a quien administra el negocio.",
    );
  });

  // ── el encargado vende: tiene sales.invoice.issue con su binding ─────────
  it("el encargado vende de contado: 201, documento emitido y kardex con su source_document_id", async () => {
    const r = await venderContado(ENCARGADO);
    expect(r.status).toBe(201);
    const cuerpo = (await r.json()) as {
      document: { id: string; kind: string; status: string };
      document_status: string;
    };
    expect(cuerpo.document.kind).toBe("invoice");
    expect(cuerpo.document_status).toBe("paid");
    const [mov] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.inventory_moves
       where company_id = ${COMPANY} and source_document_id = ${cuerpo.document.id}`;
    expect(mov?.n).toBeGreaterThan(0);
  });

  // ── el administrativo vende: misma razón que el encargado ────────────────
  it("el administrativo vende de contado: 201, documento emitido y kardex con su source_document_id", async () => {
    const r = await venderContado(ADMINISTRATIVO);
    expect(r.status).toBe(201);
    const cuerpo = (await r.json()) as {
      document: { id: string; kind: string; status: string };
      document_status: string;
    };
    expect(cuerpo.document.kind).toBe("invoice");
    expect(cuerpo.document_status).toBe("paid");
    const [mov] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.inventory_moves
       where company_id = ${COMPANY} and source_document_id = ${cuerpo.document.id}`;
    expect(mov?.n).toBeGreaterThan(0);
  });

  // ── N-02: el Dueño invitado vende ─────────────────────────────────────────
  it("N-02 — el Dueño invitado vende de contado como el fundador: 201, documento y kardex", async () => {
    const r = await venderContado(DUENO_INVITADO);
    expect(r.status).toBe(201);
    const cuerpo = (await r.json()) as {
      document: { id: string; kind: string; status: string };
      document_status: string;
    };
    expect(cuerpo.document_status).toBe("paid");
    const [mov] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.inventory_moves
         where company_id = ${COMPANY} and source_document_id = ${cuerpo.document.id}`;
    expect(mov?.n).toBeGreaterThan(0);
  });

  // ── N-02: el Dueño invitado lista los miembros de SU empresa ─────────────
  it("N-02 — el Dueño invitado ve la lista de miembros de la empresa a la que lo invitaron", async () => {
    const r = await pedir("GET", "/v1/members", DUENO_INVITADO);
    expect(r.status).toBe(200);
    // No basta un 200: la lista trae al fundador y a los cuatro que agregó, que es lo que
    // SOLO produce un listado con el alcance correcto (un filtro mal puesto daría 200 vacío).
    const { members } = (await r.json()) as { members: { user_id: string }[] };
    const ids = new Set(members.map((m) => m.user_id));
    for (const esperado of [FUNDADOR, CAJERO, ENCARGADO, ADMINISTRATIVO, DUENO_INVITADO]) {
      expect(ids.has(esperado)).toBe(true);
    }
  });

  // ── B-16: el encargado da de alta un producto CON precio ─────────────────
  it("B-16 — el encargado da de alta un producto con precio por el alta simple: 201 y el precio en la lista", async () => {
    const alta = await pedir("POST", "/v1/products/simple", ENCARGADO, {
      company_id: COMPANY,
      name: `Producto del encargado ${RUN}`,
      price: { amount: "3", currency: "USD" },
    });
    expect(alta.status).toBe(201);
    const producto = ((await alta.json()) as { product: { id: string } }).product;

    const lista = await pedir(
      "GET",
      `/v1/products?only_active=1&with_price=1&search=${encodeURIComponent(`Producto del encargado ${RUN}`)}`,
      ENCARGADO,
    );
    expect(lista.status).toBe(200);
    const items = ((await lista.json()) as { items: Record<string, unknown>[] }).items;
    const fila = items.find((i) => i["id"] === producto.id);
    expect(fila?.["price_amount"]).toBe("3.00000000");
  });

  // ── N-04: el administrativo anula una factura sin cobro ──────────────────
  it("N-04 — el administrativo anula una factura sin cobro: 200 y el asiento original queda REVERSADO", async () => {
    const emitida = await pedir("POST", "/v1/pos/sales", ADMINISTRATIVO, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: DEPOSITO,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
      // SIN payments: factura emitida, sin cobro — la única que se anula
      // (ADR-0061 §8, «una venta cobrada no se anula, se devuelve»).
    });
    expect(emitida.status).toBe(201);
    const doc = (await emitida.json()) as { document: { id: string } };
    // El asiento se lee de la BASE: la respuesta de la caja no trae `journal_entry_id`, y leerlo
    // de ahí daba `undefined` — `not.toBeNull()` pasaba sin mirar nada (antitest de la ola 0).
    const [emitido] = await sql<{ journal_entry_id: string | null }[]>`
        select journal_entry_id from public.documents where id = ${doc.document.id}`;
    expect(emitido?.journal_entry_id ?? null).not.toBeNull();

    const anular = await pedir("POST", `/v1/invoices/${doc.document.id}/annul`, ADMINISTRATIVO, {
      company_id: COMPANY,
      reason: "N-04 — venta de prueba, se anula sin cobro",
    });
    expect(anular.status).toBe(200);

    const [entry] = await sql<{ status: string }[]>`
        select status from public.journal_entries where id = ${emitido!.journal_entry_id}`;
    expect(entry?.status).toBe("reversed");
  });
});

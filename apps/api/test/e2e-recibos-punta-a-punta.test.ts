import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * EL NEGOCIO SIN RIF, DE PUNTA A PUNTA (plan «Ladino sin RIF», cierre de la Ola 1).
 *
 * Un usuario recién registrado funda su negocio SIN RIF por HTTP —nada sembrado
 * por SQL salvo la tasa del día— y recorre su primer día: crea un producto,
 * cotiza, vende, cobra y mira Inicio. Criterio: CERO 409 en el recorrido.
 * Cada caso asevera lo que SOLO produce el arreglo que dice probar:
 *
 *   A2 · la empresa nace en modo recibos (antes, sin régimen → 409 en la caja);
 *   A3 · la cotización se guarda sin buscar regla de IVA (antes 409 TAX_RULE_MISSING);
 *   A5 · la línea del recibo congela 'no_fiscal' y ningún tipo de operación;
 *   A1 · Inicio cuenta el recibo en «vendido hoy» y en «últimas ventas»;
 *   B12 · la tasa del día trae su antigüedad en días;
 *   A6 · la API no sirve «copia fiscal» de un recibo;
 *   A7 · IGTF, contribuyente especial y talonarios responden 409 con la salida escrita.
 *
 * BUG VIVO FUERA DE LOS PLANES (hallado por este E2E, 2026-09-14, confirmado en
 * producción en «Pollos y víveres paola»): el alta simple con precio en USD
 * guarda el precio en la lista «detal USD», pero una empresa nueva nace con
 * «detal» y «mayor» en su moneda funcional (create-company.ts) y la caja elige
 * «detal» — donde ese producto NO tiene precio. Sin fijar la lista
 * predeterminada, el negocio no puede vender lo que acaba de cargar. Queda como
 * `it.fails` hasta la decisión del dueño (choca con ADR-0046 / R1); el resto del
 * recorrido fija la predeterminada como lo haría el dueño desde Ajustes.
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
let DEPOSITO = "";
let PRODUCTO = "";
let RECIBO = "";
let TOTAL_RECIBO = "";
const respuestas409: string[] = [];

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
  const r = await app.request(path, {
    method: metodo,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 409) respuestas409.push(`${metodo} ${path}: ${await r.clone().text()}`);
  if (process.env["LADINO_E2E_DEBUG"] === "1" && r.status >= 400) {
    // eslint-disable-next-line no-console
    console.log(metodo, path, r.status, await r.clone().text());
  }
  return r;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id, email) values (${DUENO}, ${`sinrif-${RUN}@e2e.ladino`})
            on conflict (id) do nothing`;
  // La única siembra: la tasa oficial del día, GLOBAL y compartida con otros E2E
  // (la trae el refresco del BCV en producción). Nada de cifras funcionales fijas.
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), 'e2e-sin-rif'
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = ${HOY}::date)`;
  });
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("negocio sin RIF, de punta a punta", () => {
  it("A2 · funda su negocio sin RIF y nace vendiendo con recibos, con su acta", async () => {
    const r = await pedir("POST", "/v1/onboarding", { business_name: `Abasto sin RIF ${RUN}` });
    expect(r.status).toBe(201);
    const fundado = (await r.json()) as { company_id: string; warehouse_id: string };
    COMPANY = fundado.company_id;
    DEPOSITO = fundado.warehouse_id;

    const setup = (await (await pedir("GET", "/v1/fiscal/setup")).json()) as {
      current_regime: string | null;
      sales_mode: string;
    };
    expect(setup.current_regime).toBe("sin_facturacion");
    expect(setup.sales_mode).toBe("recibos");

    const [acta] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where company_id = ${COMPANY} and event_type = 'fiscal.regime.assigned'
         and payload->>'to' = 'sin_facturacion' and payload->>'origin' = 'onboarding'`;
    expect(acta!.n).toBe(1);
  });

  it("crea un producto con precio en USD y existencia", async () => {
    const r = await pedir("POST", "/v1/products/simple", {
      company_id: COMPANY,
      name: "Harina precocida",
      price: { amount: "2", currency: "USD" },
      initial_stock: { quantity: "10", unit_cost: { amount: "40", currency: "VES" } },
    });
    expect(r.status).toBe(201);
    PRODUCTO = ((await r.json()) as { product: { id: string } }).product.id;
  });

  it.fails(
    "BUG VIVO · lo cargado por el alta simple en USD se vende sin tocar Ajustes",
    async () => {
      const r = await pedir("POST", "/v1/pos/quote", {
        company_id: COMPANY,
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
      });
      expect(r.status).toBe(200);
    },
  );

  it("el dueño fija como predeterminada la lista donde quedó el precio", async () => {
    const [lista] = await sql<{ id: string }[]>`
      select l.id from public.price_lists l
        join public.price_list_items i on i.price_list_id = l.id
       where l.company_id = ${COMPANY} and i.product_id = ${PRODUCTO}`;
    const r = await pedir("PUT", "/v1/company-settings", { default_price_list_id: lista!.id });
    expect(r.status).toBe(200);
  });

  it("A3 · la cotización se guarda sin IVA y sin reglas cargadas", async () => {
    const r = await pedir("POST", "/v1/quotes", {
      company_id: COMPANY,
      customer_id: (
        await sql<{ id: string }[]>`
          select id from public.customers where company_id = ${COMPANY} and is_system`
      )[0]!.id,
      lines: [{ product_id: PRODUCTO, quantity: "3" }],
    });
    expect(r.status).toBe(201);
    const q = (await r.json()) as {
      tax_amount: string;
      subtotal_amount: string;
      total_amount: string;
    };
    expect(q.tax_amount).toBe("0.00000000");
    expect(q.total_amount).toBe(q.subtotal_amount);
  });

  it("A5 · vende y cobra con recibo; la línea congela 'no_fiscal' y ningún tipo de operación", async () => {
    const cot = await pedir("POST", "/v1/pos/quote", {
      company_id: COMPANY,
      lines: [{ product_id: PRODUCTO, quantity: "1.5" }],
    });
    expect(cot.status).toBe(200);
    // La lista está en USD: se cobra en Bs el total FUNCIONAL que dijo el servidor.
    const total = ((await cot.json()) as { functional_total: string }).functional_total;

    const v = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      warehouse_id: DEPOSITO,
      lines: [{ product_id: PRODUCTO, quantity: "1.5" }],
      payments: [{ instrument: "efectivo_bs", amount: total, currency: "VES" }],
    });
    expect(v.status).toBe(201);
    const venta = (await v.json()) as {
      document: { id: string; kind: string };
      document_status: string;
    };
    expect(venta.document.kind).toBe("receipt");
    expect(venta.document_status).toBe("paid");
    RECIBO = venta.document.id;
    TOTAL_RECIBO = total;

    const [linea] = await sql<
      { categoria: string; operacion: string | null; tratamiento: string }[]
    >`
      select tax_category_snapshot as categoria, operation_type as operacion,
             tax_treatment as tratamiento
        from public.document_lines where document_id = ${RECIBO}`;
    expect(linea).toEqual({ categoria: "no_fiscal", operacion: null, tratamiento: "no_fiscal" });
  });

  it("A1 · Inicio cuenta el recibo en «vendido hoy» y lo lista en «últimas ventas»; B12 · la tasa trae su antigüedad", async () => {
    const r = await pedir("GET", "/v1/negocio/resumen");
    expect(r.status).toBe(200);
    const resumen = (await r.json()) as {
      vendido_hoy: string;
      ultimas_ventas: { id: string }[];
      tasa_del_dia: { dias_de_antiguedad: number } | null;
    };
    // Dinero comparado como numeric en la base, nunca como float (regla 7).
    const [igual] = await sql<{ ok: boolean }[]>`
      select ${resumen.vendido_hoy}::numeric = ${TOTAL_RECIBO}::numeric as ok`;
    expect(igual!.ok).toBe(true);
    expect(resumen.ultimas_ventas.map((u) => u.id)).toContain(RECIBO);
    expect(resumen.tasa_del_dia).not.toBeNull();
    expect(resumen.tasa_del_dia!.dias_de_antiguedad).toBe(0);
  });

  it("el recorrido completo no dio ni un 409", () => {
    expect(respuestas409).toEqual([]);
  });

  it("A6 · la API no sirve copia fiscal de un recibo", async () => {
    const copia = await pedir("GET", `/v1/documents/${RECIBO}/pdf?copia=1`);
    expect(copia.status).toBe(422);
    expect(((await copia.json()) as { message: string }).message).toContain(
      "no tiene copia fiscal",
    );
    const original = await pedir("GET", `/v1/documents/${RECIBO}/pdf`);
    expect(original.status).toBe(200);
  });

  it("A7 · IGTF, contribuyente especial y talonario responden 409 con la salida escrita", async () => {
    const especial = await pedir("PUT", "/v1/companies/taxpayer-type", {
      company_id: COMPANY,
      taxpayer_type_code: "especial",
    });
    expect(especial.status).toBe(409);
    const cuerpoEspecial = (await especial.json()) as { code: string; message: string };
    expect(cuerpoEspecial.code).toBe("REGIME_KIND_NOT_ALLOWED");
    expect(cuerpoEspecial.message).toContain("activa la facturación en Empezar");

    const igtf = await pedir("POST", "/v1/igtf/enable", {
      company_id: COMPANY,
      reason: "Designación de prueba del e2e",
    });
    expect(igtf.status).toBe(409);
    expect(((await igtf.json()) as { message: string }).message).toContain("Percibir IGTF");

    const rango = await pedir("POST", "/v1/fiscal-number-ranges", {
      company_id: COMPANY,
      kind: "invoice",
      series: "A",
      range_from: "1",
      range_to: "100",
      printer_source: "Imprenta e2e",
    });
    expect(rango.status).toBe(409);
    expect(((await rango.json()) as { message: string }).message).toContain("talonario");

    // Ninguno de los tres dejó huella: la empresa sigue sin clasificación
    // especial, sin IGTF y sin talonarios.
    const [empresa] = await sql<{ tipo: string | null; igtf: boolean; rangos: number }[]>`
      select c.taxpayer_type_code as tipo, c.igtf_enabled_at is not null as igtf,
             (select count(*)::int from public.fiscal_number_ranges r
               where r.company_id = c.id) as rangos
        from public.companies c where c.id = ${COMPANY}`;
    expect(empresa).toEqual({ tipo: null, igtf: false, rangos: 0 });
  });
});

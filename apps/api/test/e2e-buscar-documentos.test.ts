import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { borrarTasasOficiales } from "./_tasa-oficial.js";

/**
 * LA PALETA ENCUENTRA DOCUMENTOS POR SU NÚMERO (recorrido 2026-09-24, P-06; ADR-0081).
 *
 * `GET /v1/search/documents?q=` responde solo con lo que el rol puede leer en la empresa de la
 * pestaña. Cada caso asevera lo que SOLO produce su camino:
 *   · el dueño encuentra el recibo por el número exacto, por una parte y por la forma con ceros;
 *   · el dueño encuentra la compra por el número del proveedor, exacto y parcial;
 *   · el CAJERO encuentra el recibo y NO la compra (misma consulta, mismo número, cero filas);
 *   · el ALMACÉN no encuentra ni la venta ni la compra;
 *   · el dueño de OTRA empresa no encuentra nada de esta, y quien es miembro de las DOS solo
 *     encuentra lo de la empresa que pide (el atacante realista);
 *   · un `%` de la persona es una letra, no un comodín; menos de dos caracteres, 422.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";

const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const FUENTE_TASA = `BCV e2e-buscar-${RUN}`;
const NUMERO_COMPRA = `FC-${RUN}`;
const NUMERO_COMPRA_AJENA = `FX-${RUN}`;

const DUENO = crypto.randomUUID();
const CAJERO = crypto.randomUUID();
const ALMACEN = crypto.randomUUID();
const OTRO_DUENO = crypto.randomUUID();

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let COMPANY = "";
let OTRA = "";
let RECIBO = "";
let COMPRA = "";

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
  company: string = COMPANY,
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await tokenDe(sub)}` };
  if (company !== "") headers["X-Company-Id"] = company;
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

interface Hallado {
  type: string;
  id: string;
  number: string;
  party_name: string | null;
  date: string;
  status: string;
}

async function buscar(q: string, sub: string, company: string = COMPANY): Promise<Hallado[]> {
  const r = await pedir(
    "GET",
    `/v1/search/documents?q=${encodeURIComponent(q)}`,
    sub,
    undefined,
    company,
  );
  expect(r.status).toBe(200);
  const cuerpo = (await r.json()) as { items: Hallado[] };
  // «No se cuenta»: la respuesta no lleva más que la lista.
  expect(Object.keys(cuerpo)).toEqual(["items"]);
  return cuerpo.items;
}

/** Funda un negocio sin RIF, le carga un producto y registra una compra por pagar. */
async function fundarConCompra(
  dueno: string,
  nombre: string,
  numeroCompra: string,
): Promise<{ company: string; deposito: string; producto: string; compra: string }> {
  const f = await pedir("POST", "/v1/onboarding", dueno, { business_name: nombre }, "");
  expect(f.status).toBe(201);
  const { company_id: company, warehouse_id: deposito } = (await f.json()) as {
    company_id: string;
    warehouse_id: string;
  };
  const p = await pedir(
    "POST",
    "/v1/products/simple",
    dueno,
    {
      company_id: company,
      name: `Harina ${nombre}`,
      price: { amount: "2", currency: "USD" },
      initial_stock: { quantity: "10", unit_cost: { amount: "40", currency: "VES" } },
    },
    company,
  );
  expect(p.status).toBe(201);
  const producto = ((await p.json()) as { product: { id: string } }).product.id;
  // La compra con factura calcula su IVA: el dueño acepta el suyo por la puerta del producto
  // (regla de la EMPRESA; no se siembra ninguna regla global en la base compartida).
  const iva = await pedir("POST", "/v1/fiscal/iva-general", dueno, { rate: "0.16" }, company);
  expect(iva.status).toBeLessThan(300);
  const s = await pedir(
    "POST",
    "/v1/suppliers",
    dueno,
    {
      company_id: company,
      // La factura de compra lleva impreso el RIF del proveedor: sin él no se registra.
      tax_id: `J-5${String(Date.now()).slice(-7)}-0`,
      legal_name: `Proveedor de ${nombre}`,
      supplier_kind: "nacional",
      person_type_code: "juridica",
      taxpayer_type_code: "ordinario",
    },
    company,
  );
  expect(s.status).toBe(201);
  const proveedor = ((await s.json()) as { id: string }).id;
  const c = await pedir(
    "POST",
    "/v1/purchases/simple",
    dueno,
    {
      company_id: company,
      supplier_id: proveedor,
      warehouse_id: deposito,
      currency: "VES",
      supplier_document_number: numeroCompra,
      supplier_control_number: `CTRL-${numeroCompra}`,
      lines: [{ product_id: producto, quantity: "2", unit_price: "40" }],
    },
    company,
  );
  expect(c.status).toBe(201);
  const compra = ((await c.json()) as { invoice: { id: string } }).invoice.id;
  return { company, deposito, producto, compra };
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id, email) values
            (${DUENO}, ${`dueno-buscar-${RUN}@e2e.ladino`}),
            (${CAJERO}, ${`cajero-buscar-${RUN}@e2e.ladino`}),
            (${ALMACEN}, ${`almacen-buscar-${RUN}@e2e.ladino`}),
            (${OTRO_DUENO}, ${`otro-buscar-${RUN}@e2e.ladino`})
            on conflict (id) do nothing`;
  // La tasa oficial del día, con fuente propia y solo si nadie la sembró (tabla GLOBAL compartida).
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), ${FUENTE_TASA}
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD'
                            and to_currency = 'VES' and rate_date = ${HOY}::date)`;
  });
});

afterAll(async () => {
  if (sql) await borrarTasasOficiales(sql, FUENTE_TASA);
  await sql?.end();
  await sqlApi?.end();
});

describe("la paleta encuentra documentos por su número", { timeout: 60_000 }, () => {
  it("dos negocios: cada uno vende con recibo y registra una compra; el primero suma a su gente", async () => {
    const a = await fundarConCompra(DUENO, `Abasto Buscar ${RUN}`, NUMERO_COMPRA);
    COMPANY = a.company;
    COMPRA = a.compra;
    const b = await fundarConCompra(OTRO_DUENO, `Bodega Ajena ${RUN}`, NUMERO_COMPRA_AJENA);
    OTRA = b.company;

    for (const [correo, rol] of [
      [`cajero-buscar-${RUN}@e2e.ladino`, "cashier"],
      [`almacen-buscar-${RUN}@e2e.ladino`, "warehouse_ops"],
    ] as const) {
      const m = await pedir("POST", "/v1/members", DUENO, {
        company_id: COMPANY,
        email: correo,
        role_key: rol,
      });
      expect(m.status).toBe(201);
    }

    for (const [quien, empresa, deposito, producto] of [
      [CAJERO, a.company, a.deposito, a.producto],
      [OTRO_DUENO, b.company, b.deposito, b.producto],
    ] as const) {
      const cot = await pedir(
        "POST",
        "/v1/pos/quote",
        quien,
        { company_id: empresa, lines: [{ product_id: producto, quantity: "1" }] },
        empresa,
      );
      expect(cot.status).toBe(200);
      const total = ((await cot.json()) as { functional_total: string }).functional_total;
      const v = await pedir(
        "POST",
        "/v1/pos/sales",
        quien,
        {
          company_id: empresa,
          warehouse_id: deposito,
          lines: [{ product_id: producto, quantity: "1" }],
          payments: [{ instrument: "efectivo_bs", amount: total, currency: "VES" }],
        },
        empresa,
      );
      expect(v.status).toBe(201);
      const venta = (await v.json()) as {
        document: { id: string; kind: string; series: string; document_number: number };
      };
      expect(venta.document.kind).toBe("receipt");
      expect(`${venta.document.series}-${venta.document.document_number}`).toBe("R-1");
      if (empresa === a.company) RECIBO = venta.document.id;
    }
  });

  it("el dueño encuentra el recibo: número exacto, una parte, y la forma con ceros", async () => {
    for (const q of ["R-1", "r-", "R-00000001", "0000001"]) {
      const items = await buscar(q, DUENO);
      const recibo = items.find((i) => i.id === RECIBO);
      expect(recibo, `con «${q}»`).toBeDefined();
      expect(recibo).toMatchObject({ type: "receipt", number: "R-1", date: HOY, status: "paid" });
    }
    // El exacto va primero.
    expect((await buscar("R-1", DUENO))[0]!.id).toBe(RECIBO);
  });

  it("el dueño encuentra la compra por el número del proveedor, exacto y parcial", async () => {
    // …y por el número de control del proveedor, que también viene en su papel.
    for (const q of [NUMERO_COMPRA, RUN, NUMERO_COMPRA.toLowerCase(), `CTRL-${NUMERO_COMPRA}`]) {
      const items = await buscar(q, DUENO);
      expect(items, `con «${q}»`).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "purchase",
        id: COMPRA,
        number: NUMERO_COMPRA,
        party_name: `Proveedor de Abasto Buscar ${RUN}`,
      });
    }
  });

  it("el cajero encuentra el recibo y NO la compra", async () => {
    expect((await buscar("R-1", CAJERO)).map((i) => i.id)).toContain(RECIBO);
    // El mismo número que el dueño sí encuentra: lo que cambia es el rol, no el dato.
    expect(await buscar(NUMERO_COMPRA, CAJERO)).toEqual([]);
    expect(await buscar(RUN, CAJERO)).toEqual([]);
  });

  it("el almacén no encuentra ni la venta ni la compra", async () => {
    expect(await buscar("R-1", ALMACEN)).toEqual([]);
    expect(await buscar(NUMERO_COMPRA, ALMACEN)).toEqual([]);
  });

  it("otra empresa no encuentra nada de esta; quien es de las dos, solo lo de la que pide", async () => {
    // El dueño ajeno, en SU empresa: su R-1 es otro documento, y la compra de aquí no existe.
    const suyos = await buscar("R-1", OTRO_DUENO, OTRA);
    expect(suyos.map((i) => i.id)).not.toContain(RECIBO);
    expect(suyos).toHaveLength(1);
    expect(await buscar(NUMERO_COMPRA, OTRO_DUENO, OTRA)).toEqual([]);
    // Pidiendo la empresa de la que NO es miembro: el contexto lo rechaza antes de buscar.
    const r = await pedir(
      "GET",
      `/v1/search/documents?q=${NUMERO_COMPRA}`,
      OTRO_DUENO,
      undefined,
      COMPANY,
    );
    expect(r.status).toBe(404);

    // El atacante realista: miembro de las DOS (dueño aquí, cajero allá).
    const m = await pedir(
      "POST",
      "/v1/members",
      OTRO_DUENO,
      { company_id: OTRA, email: `dueno-buscar-${RUN}@e2e.ladino`, role_key: "owner" },
      OTRA,
    );
    expect(m.status).toBe(201);
    expect((await buscar(NUMERO_COMPRA_AJENA, DUENO, OTRA)).map((i) => i.number)).toEqual([
      NUMERO_COMPRA_AJENA,
    ]);
    // Con la empresa de la pestaña en la primera, la compra de la segunda no aparece.
    expect(await buscar(NUMERO_COMPRA_AJENA, DUENO, COMPANY)).toEqual([]);
    expect(await buscar(NUMERO_COMPRA, DUENO, OTRA)).toEqual([]);
  });

  it("un comodín de la persona es una letra; menos de dos caracteres, 422", async () => {
    expect(await buscar("%%", DUENO)).toEqual([]);
    expect(await buscar("__", DUENO)).toEqual([]);
    const corto = await pedir("GET", "/v1/search/documents?q=R", DUENO);
    expect(corto.status).toBe(422);
    const vacio = await pedir("GET", "/v1/search/documents", DUENO);
    expect(vacio.status).toBe(422);
  });
});

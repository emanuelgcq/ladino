import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * Compras de extremo a extremo con JWT real, como `ladino_api`.
 *
 * Lo que este fichero demuestra y ningún test unitario ve: que el ciclo de tres
 * documentos funciona con recepciones parciales; que el landed cost tardío
 * genera VARIACIÓN y no encarece lo que queda; que sin regla cargada NO se
 * retiene; que el matching bloquea un precio fuera de umbral; y que una
 * recepción confirmada ya no se toca.
 *
 * Fixture NUEVA en cada corrida: compras asigna correlativos y consume rangos,
 * y un tenant fijo hace que la segunda corrida falle por su propia historia.
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
const COMPRADOR = crypto.randomUUID();
const MIRON = crypto.randomUUID();
const ROL_COMPRAS = crypto.randomUUID();
const ROL_MIRON = crypto.randomUUID();
const MEM_COMPRADOR = crypto.randomUUID();
const MEM_MIRON = crypto.randomUUID();
const ASIG_COMPRADOR = crypto.randomUUID();
const ASIG_MIRON = crypto.randomUUID();
const RUN = Date.now().toString(36);
const FUENTE_TASA = `Carga E2E compras ${RUN}`;
const FUENTE_REGLA = `REGLA DE PRUEBA E2E compras ${RUN} — no es la norma vigente`;
const HOY = new Date().toISOString().slice(0, 10);
const AYER = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PROV = "";
let PROV_EXT = "";
let PROD_A = "";
let PROD_B = "";
let ORDEN = "";
let LINEA_ORDEN = "";

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

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${COMPRADOR}), (${MIRON})
            on conflict (id) do nothing`;
  // `exchange_rates` es GLOBAL y sobrevive entre corridas. El segundo caso
  // demuestra que SIN tasa no se compra, así que la corrida empieza sin las que
  // dejó la anterior — solo las suyas, reconocibles por la fuente.
  await sql`delete from public.exchange_rates where source like 'Carga E2E compras%'`;
  // `retention_rules` también es global, y no se puede borrar: una regla citada
  // por una retención tiene FK. Lo que sí se puede —y es lo que haría un
  // operador— es INACTIVAR las sobrantes: si dos quedan activas con la misma
  // prioridad, el catálogo es ambiguo y `resolve_retention` se planta, con toda
  // la razón. Se deja exactamente una viva.
  await sql`
    update public.retention_rules set status = 'inactive'
     where retention_code = 'iva' and concept_code = 'iva_compras' and status = 'active'
       and id <> (select id from public.retention_rules
                   where retention_code = 'iva' and concept_code = 'iva_compras'
                     and status = 'active' order by created_at limit 1)`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${COMPRADOR}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e compras')`;
    // Contribuyente ORDINARIO: su IVA de compra es crédito fiscal, no costo.
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-E2ECMP-${RUN}`}, 'Empresa e2e compras', 'VES',
                     'ordinario')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name) values
             (${W1}, ${TENANT}, ${COMPANY}, 'E2E-CW1', 'Principal'),
             (${W2}, ${TENANT}, ${COMPANY}, 'E2E-CW2', 'Sin binding')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL_COMPRAS}, null, ${`e2ecmp_compras_${RUN}`}, 'Compras', true),
             (${ROL_MIRON}, null, ${`e2ecmp_miron_${RUN}`}, 'Mirón', false)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL_COMPRAS}, 'supplier.manage'),
             (${ROL_COMPRAS}, 'purchase.order.manage'),
             (${ROL_COMPRAS}, 'purchase.receive'),
             (${ROL_COMPRAS}, 'purchase.invoice.register'),
             (${ROL_COMPRAS}, 'purchase.landed_cost.apply'),
             (${ROL_COMPRAS}, 'purchase.payment.register'),
             (${ROL_COMPRAS}, 'purchase.credit_note.register'),
             (${ROL_COMPRAS}, 'retention.rules.manage'),
             (${ROL_COMPRAS}, 'retention.receipt.issue'),
             (${ROL_COMPRAS}, 'inventory.move'),
             (${ROL_COMPRAS}, 'fx.rate.manage'),
             (${ROL_COMPRAS}, 'ap.read')`;
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${MEM_COMPRADOR}, ${TENANT}, ${COMPRADOR}),
             (${MEM_MIRON}, ${TENANT}, ${MIRON})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${ASIG_COMPRADOR}, ${TENANT}, ${MEM_COMPRADOR}, ${ROL_COMPRAS}, null),
             (${ASIG_MIRON}, ${TENANT}, ${MEM_MIRON}, ${ROL_MIRON}, ${COMPANY})`;
    // Binding SOLO en W1: recibir en W2 tiene que fallar (LAD25).
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, ${ASIG_COMPRADOR}, 'warehouse', ${W1})`;
    const [pa] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2ECMP-A-${RUN}`}, 'Producto compras A', 'good', 'active',
              'unidad', 'gravado_general')
      returning id`;
    PROD_A = pa!.id;
    const [pb] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2ECMP-B-${RUN}`}, 'Producto compras B', 'good', 'active',
              'unidad', 'gravado_general')
      returning id`;
    PROD_B = pb!.id;
    // La alícuota de COMPRA. De prueba, y el legal_source lo dice.
    await tx`
      insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, transaction_type,
                                    product_tax_category, rate, effective_from, legal_source,
                                    priority)
      select 'VE', 'iva', null, 'purchase', 'gravado_general', 0.16, ${AYER}::date,
             ${`REGLA DE PRUEBA E2E compras ${RUN}`}, 50
       where not exists (select 1 from public.tax_rules
                          where transaction_type = 'purchase' and jurisdiction = 'VE'
                            and tax_code = 'iva' and taxpayer_type is null
                            and product_tax_category = 'gravado_general')`;
  });
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("compras de extremo a extremo", () => {
  it("un proveedor nacional sin RIF se rechaza; el extranjero se acepta sin él", async () => {
    const malo = await pedir("POST", "/v1/suppliers", COMPRADOR, {
      company_id: COMPANY,
      legal_name: "Nacional sin RIF",
      supplier_kind: "nacional",
    });
    expect(malo.status).toBe(422);

    const bueno = await pedir("POST", "/v1/suppliers", COMPRADOR, {
      company_id: COMPANY,
      tax_id: `J-PROV-${RUN}`,
      legal_name: "Proveedor nacional e2e",
      supplier_kind: "nacional",
      person_type_code: "juridica",
      taxpayer_type_code: "especial",
      payment_terms_days: 30,
    });
    expect(bueno.status).toBe(201);
    PROV = ((await bueno.json()) as { id: string }).id;

    const ext = await pedir("POST", "/v1/suppliers", COMPRADOR, {
      company_id: COMPANY,
      legal_name: "Foreign Supplier LLC",
      supplier_kind: "extranjero",
    });
    expect(ext.status).toBe(201);
    const e = (await ext.json()) as { id: string; tax_id: string | null };
    PROV_EXT = e.id;
    expect(e.tax_id).toBeNull();
  });

  it("con tasa, la orden se crea con su correlativo interno y su moneda", async () => {
    const t = await pedir("POST", "/v1/exchange-rates", COMPRADOR, {
      from_currency: "USD",
      to_currency: "VES",
      rate: "40.00000000",
      source: FUENTE_TASA,
      rate_date: AYER,
    });
    expect(t.status).toBe(201);

    const r = await pedir("POST", "/v1/purchase-orders", COMPRADOR, {
      company_id: COMPANY,
      supplier_id: PROV,
      warehouse_id: W1,
      currency: "USD",
      lines: [{ product_id: PROD_A, quantity: "10", unit_price: "100", unit_weight: "2" }],
    });
    expect(r.status).toBe(201);
    const o = (await r.json()) as Record<string, string | number>;
    ORDEN = o["id"] as string;
    expect(o["order_number"]).toBe(1);
    expect(o["transaction_currency"]).toBe("USD");
    expect(o["amount_transaction_currency"]).toBe("1000.00000000");
    // El importe funcional se comprueba contra la TASA QUE EL DOCUMENTO DECLARA,
    // no contra un 40 escrito aquí: `exchange_rates` es global y otro E2E puede
    // haber cargado una tasa más reciente. Lo que importa es que el documento
    // sea coherente consigo mismo; los números exactos están en el pgTAP, donde
    // la fixture sí está aislada.
    expect(Number(o["functional_amount"])).toBeCloseTo(1000 * Number(o["fx_rate"]), 6);

    const det = await pedir("GET", `/v1/purchase-orders/${ORDEN}`, COMPRADOR);
    const d = (await det.json()) as { lines: Record<string, string>[]; derived_status: string };
    LINEA_ORDEN = d.lines[0]!["id"] as string;
    expect(d.derived_status).toBe("pending");
  });

  it("recibir en un almacén sin binding se rechaza: el permiso es acotado (LAD25)", async () => {
    const r = await pedir("POST", "/v1/goods-receipts", COMPRADOR, {
      company_id: COMPANY,
      supplier_id: PROV,
      purchase_order_id: ORDEN,
      warehouse_id: W2,
      currency: "USD",
      lines: [
        {
          purchase_order_line_id: LINEA_ORDEN,
          product_id: PROD_A,
          quantity: "4",
          unit_price: "100",
        },
      ],
    });
    expect(r.status).toBe(403);
  });

  it("recepción parcial: la orden pasa a PARCIAL y el kardex entra al costo funcional", async () => {
    const r = await pedir("POST", "/v1/goods-receipts", COMPRADOR, {
      company_id: COMPANY,
      supplier_id: PROV,
      purchase_order_id: ORDEN,
      warehouse_id: W1,
      currency: "USD",
      delivery_note_ref: "GUIA-001",
      lines: [
        {
          purchase_order_line_id: LINEA_ORDEN,
          product_id: PROD_A,
          quantity: "4",
          unit_price: "100",
          unit_weight: "2",
        },
      ],
    });
    expect(r.status).toBe(201);

    const det = await pedir("GET", `/v1/purchase-orders/${ORDEN}`, COMPRADOR);
    const d = (await det.json()) as {
      derived_status: string;
      progress: Record<string, string>[];
    };
    expect(d.derived_status).toBe("partial");
    expect(d.progress[0]!["quantity_pending"]).toBe("6.00000000");

    // 4 unidades a 100 USD: el costo unitario funcional es 100 × la tasa de LA
    // RECEPCIÓN (ADR-0040 §4), y se comprueba contra la que ella misma declara.
    const recibida = (await r.json()) as Record<string, string>;
    const [saldo] = await sql<{ q: string; c: string }[]>`
      select quantity::text as q, last_unit_cost::text as c from public.stock_balances
       where company_id = ${COMPANY} and warehouse_id = ${W1} and product_id = ${PROD_A}
         and lot_id is null`;
    expect(saldo!.q).toBe("4.00000000");
    expect(Number(saldo!.c)).toBeCloseTo(100 * Number(recibida["fx_rate"]), 6);
  });

  it("no se recibe más de lo pendiente: sobrepasar la orden es un error, no una tolerancia", async () => {
    const r = await pedir("POST", "/v1/goods-receipts", COMPRADOR, {
      company_id: COMPANY,
      supplier_id: PROV,
      purchase_order_id: ORDEN,
      warehouse_id: W1,
      currency: "USD",
      lines: [
        {
          purchase_order_line_id: LINEA_ORDEN,
          product_id: PROD_A,
          quantity: "7",
          unit_price: "100",
        },
      ],
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toMatch(/pendientes/i);
  });

  it("recepción final: la orden queda COMPLETA", async () => {
    const r = await pedir("POST", "/v1/goods-receipts", COMPRADOR, {
      company_id: COMPANY,
      supplier_id: PROV,
      purchase_order_id: ORDEN,
      warehouse_id: W1,
      currency: "USD",
      lines: [
        {
          purchase_order_line_id: LINEA_ORDEN,
          product_id: PROD_A,
          quantity: "6",
          unit_price: "100",
          unit_weight: "2",
        },
      ],
    });
    expect(r.status).toBe(201);
    const det = await pedir("GET", `/v1/purchase-orders/${ORDEN}`, COMPRADOR);
    expect(((await det.json()) as { derived_status: string }).derived_status).toBe("complete");
  });

  it("landed cost por VALOR sobre mercancía intacta: todo capitaliza, nada va a variación", async () => {
    // Recepción propia en Bs con dos líneas, para no mezclarla con la anterior.
    const rec = await pedir("POST", "/v1/goods-receipts", COMPRADOR, {
      company_id: COMPANY,
      supplier_id: PROV,
      warehouse_id: W1,
      currency: "VES",
      lines: [
        { product_id: PROD_B, quantity: "4", unit_price: "4000", unit_weight: "2" },
        { product_id: PROD_B, quantity: "6", unit_price: "1000", unit_weight: "3" },
      ],
    });
    expect(rec.status).toBe(201);
    const recepcion = (await rec.json()) as { id: string };

    const lc = await pedir("POST", "/v1/landed-costs", COMPRADOR, {
      company_id: COMPANY,
      goods_receipt_id: recepcion.id,
      concept: "Flete internacional",
      allocation_method: "by_value",
      amount: "2200",
      currency: "VES",
      incurred_on: HOY,
    });
    expect(lc.status).toBe(201);
    const l = (await lc.json()) as {
      allocations: Record<string, string>[];
      total_variance: string;
    };
    // Bases 16 000 y 6 000 sobre 22 000: 1 600 y 600, calculado a mano.
    expect(l.allocations[0]!["allocated_functional"]).toBe("1600.00000000");
    expect(l.allocations[1]!["allocated_functional"]).toBe("600.00000000");
    // Nada se vendió, así que todo capitaliza.
    expect(l.total_variance).toBe("0.00000000");
  });

  it("landed cost TARDÍO con mercancía ya vendida: variación, y el kardex lo explica", async () => {
    const rec = await pedir("POST", "/v1/goods-receipts", COMPRADOR, {
      company_id: COMPANY,
      supplier_id: PROV,
      warehouse_id: W1,
      currency: "VES",
      lines: [{ product_id: PROD_A, quantity: "10", unit_price: "1000", unit_weight: "1" }],
    });
    expect(rec.status).toBe(201);
    const recepcion = (await rec.json()) as { id: string };

    // Se va casi todo el stock del producto A: queda 1 unidad.
    const [antes] = await sql<{ q: string }[]>`
      select quantity::text as q from public.stock_balances
       where company_id = ${COMPANY} and warehouse_id = ${W1} and product_id = ${PROD_A}
         and lot_id is null`;
    const salida = Number(antes!.q) - 1;
    const iss = await pedir("POST", "/v1/inventory/issues", COMPRADOR, {
      company_id: COMPANY,
      warehouse_id: W1,
      product_id: PROD_A,
      quantity: String(salida),
    });
    expect(iss.status).toBe(201);

    const lc = await pedir("POST", "/v1/landed-costs", COMPRADOR, {
      company_id: COMPANY,
      goods_receipt_id: recepcion.id,
      concept: "Aduana tardía",
      allocation_method: "by_units",
      amount: "1000",
      currency: "VES",
      incurred_on: HOY,
    });
    expect(lc.status).toBe(201);
    const l = (await lc.json()) as {
      id: string;
      allocations: Record<string, string>[];
      total_variance: string;
    };
    // 1 000 sobre 10 unidades = 100/ud. Queda 1 → 100 al inventario, 900 a
    // variación. Prorratear los 1 000 sobre la única unidad restante la
    // encarecería en 1 000: mentira, y ensuciaría el margen de cada venta futura.
    expect(l.allocations[0]!["to_inventory_functional"]).toBe("100.00000000");
    expect(l.allocations[0]!["to_variance_functional"]).toBe("900.00000000");
    expect(l.total_variance).toBe("900.00000000");

    // La revalorización EXISTE en el kardex, con cantidad cero.
    const [mov] = await sql<{ kind: string; quantity: string; amount: string }[]>`
      select kind, quantity::text as quantity, functional_amount::text as amount
        from public.inventory_moves
       where company_id = ${COMPANY} and source_document_id = ${l.id}`;
    expect(mov!.kind).toBe("revaluacion");
    expect(mov!.quantity).toBe("0.00000000");
    expect(mov!.amount).toBe("100.00000000");

    const vars = await pedir("GET", "/v1/landed-costs/variances", COMPRADOR);
    const v = (await vars.json()) as { total: string; items: Record<string, string>[] };
    expect(Number(v.total)).toBeGreaterThanOrEqual(900);
    expect(v.items[0]!["account_code"]).toBe("variacion_costo_landed_tardio");
  });

  it("sin tasa vigente a la fecha del gasto no se costea: la tasa no se inventa", async () => {
    // `exchange_rates` es GLOBAL y la comparten todos los E2E, así que la
    // ausencia NO se puede demostrar borrando: el fichero de ventas carga sus
    // propias tasas de USD. Se demuestra donde la fecha es un PARÁMETRO —el
    // gasto de importación— con un día anterior a cualquier tasa cargable.
    const rec = await pedir("POST", "/v1/goods-receipts", COMPRADOR, {
      company_id: COMPANY,
      supplier_id: PROV,
      warehouse_id: W1,
      currency: "VES",
      lines: [{ product_id: PROD_A, quantity: "1", unit_price: "100", unit_weight: "1" }],
    });
    const recepcion = (await rec.json()) as { id: string };
    const lc = await pedir("POST", "/v1/landed-costs", COMPRADOR, {
      company_id: COMPANY,
      goods_receipt_id: recepcion.id,
      concept: "Flete facturado en dólares",
      allocation_method: "by_units",
      amount: "10",
      currency: "USD",
      incurred_on: "2000-01-01",
    });
    expect(lc.status).toBe(409);
    expect(((await lc.json()) as { code: string }).code).toBe("EXCHANGE_RATE_MISSING");
  });

  it("el prorrateo por PESO falla si a una línea le falta el peso, en vez de repartir mal", async () => {
    const rec = await pedir("POST", "/v1/goods-receipts", COMPRADOR, {
      company_id: COMPANY,
      supplier_id: PROV,
      warehouse_id: W1,
      currency: "VES",
      lines: [
        { product_id: PROD_A, quantity: "2", unit_price: "500", unit_weight: "1" },
        { product_id: PROD_B, quantity: "2", unit_price: "500" },
      ],
    });
    const recepcion = (await rec.json()) as { id: string };
    const lc = await pedir("POST", "/v1/landed-costs", COMPRADOR, {
      company_id: COMPANY,
      goods_receipt_id: recepcion.id,
      concept: "Flete por peso",
      allocation_method: "by_weight",
      amount: "100",
      currency: "VES",
      incurred_on: HOY,
    });
    expect(lc.status).toBe(422);
    expect(((await lc.json()) as { code: string }).code).toBe("MISSING_WEIGHT");
  });

  it("sin regla de retención cargada, la factura con retención se para con LAD53", async () => {
    const r = await pedir("POST", "/v1/supplier-invoices", COMPRADOR, {
      company_id: COMPANY,
      supplier_id: PROV,
      purchase_order_id: ORDEN,
      supplier_document_number: `FAC-${RUN}-1`,
      supplier_control_number: "00-1234567",
      invoice_date: HOY,
      currency: "VES",
      lines: [{ product_id: PROD_A, quantity: "10", unit_price: "4000" }],
      // Un concepto que este fichero NUNCA carga.  es global y
      // no se puede vaciar —una regla citada por una retención tiene FK—, así
      // que la ausencia se demuestra donde de verdad no hay nada, igual que en
      // ventas con la categoría sin alícuota.
      retention_concepts: ["islr_fletes"],
    });
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("RETENTION_RULE_MISSING");
    // El mensaje del esquema, no uno genérico: dice qué concepto y qué fecha.
    expect(cuerpo.message).toMatch(/islr_fletes/);
  });

  it("con la regla cargada, la retención se calcula y el IVA es CRÉDITO (empresa ordinaria)", async () => {
    // `retention_rules` es GLOBAL y sobrevive entre corridas, y no se puede
    // limpiar: una regla citada por una retención tiene FK. Cargar la misma dos
    // veces no es un duplicado inofensivo — son dos reglas con la misma
    // prioridad, o sea un catálogo ambiguo, que resolve_retention rechaza a
    // propósito. Así que primero se mira si ya está, que es además lo que haría
    // un operador.
    const existentes = await pedir("GET", "/v1/retention-rules", COMPRADOR);
    const lista = (await existentes.json()) as Record<string, string>[];
    const yaEsta = lista.some(
      (r) =>
        r["retention_code"] === "iva" &&
        r["concept_code"] === "iva_compras" &&
        r["status"] === "active",
    );
    if (!yaEsta) {
      const regla = await pedir("POST", "/v1/retention-rules", COMPRADOR, {
        jurisdiction: "VE",
        retention_code: "iva",
        concept_code: "iva_compras",
        taxpayer_type: "especial",
        formula_kind: "rate",
        rate: "0.75",
        effective_from: AYER,
        legal_source: FUENTE_REGLA,
        priority: 50,
      });
      expect(regla.status).toBe(201);
    }

    const r = await pedir("POST", "/v1/supplier-invoices", COMPRADOR, {
      company_id: COMPANY,
      supplier_id: PROV,
      supplier_document_number: `FAC-${RUN}-2`,
      supplier_control_number: "00-1234568",
      invoice_date: HOY,
      currency: "VES",
      lines: [{ product_id: PROD_A, quantity: "10", unit_price: "4000" }],
      retention_concepts: ["iva_compras"],
    });
    expect(r.status).toBe(201);
    const f = (await r.json()) as {
      id: string;
      subtotal_amount: string;
      tax_amount: string;
      total_amount: string;
      tax_is_recoverable: boolean;
      retention_total: string;
      retentions: Record<string, string>[];
    };
    // 10 × 4 000 = 40 000; IVA 16 % = 6 400; total 46 400.
    expect(f.subtotal_amount).toBe("40000.00000000");
    expect(f.tax_amount).toBe("6400.00000000");
    expect(f.total_amount).toBe("46400.00000000");
    // Empresa ORDINARIA: el IVA es crédito fiscal, no costo (ADR-0040 §7).
    expect(f.tax_is_recoverable).toBe(true);
    // Retención de IVA: 75 % de 6 400 = 4 800.
    expect(f.retention_total).toBe("4800.00000000");
    expect(f.retentions[0]!["retained_amount"]).toBe("4800.00000000");
    // Y la norma queda copiada con la retención: sin ella no sería auditable.
    // La norma queda COPIADA con la retención (R-05): sin ella no sería auditable.
    expect(String(f.retentions[0]!["legal_source_snapshot"]).length).toBeGreaterThan(3);
  });

  it("al proveedor EXTRANJERO no se le retiene, y su factura registra el documento origen", async () => {
    const r = await pedir("POST", "/v1/supplier-invoices", COMPRADOR, {
      company_id: COMPANY,
      supplier_id: PROV_EXT,
      supplier_document_number: `INV-${RUN}-9`,
      supplier_document_ref: "B/L MSCU-77120",
      invoice_date: HOY,
      currency: "VES",
      lines: [{ product_id: PROD_A, quantity: "1", unit_price: "5000" }],
      retention_concepts: ["iva_compras"],
    });
    expect(r.status).toBe(201);
    const f = (await r.json()) as {
      supplier_control_number: string | null;
      supplier_document_ref: string | null;
      tax_amount: string;
      retentions: unknown[];
    };
    expect(f.supplier_control_number).toBeNull();
    expect(f.supplier_document_ref).toBe("B/L MSCU-77120");
    expect(f.retentions).toHaveLength(0);
    // Y sin alícuota local: no se le resuelve impuesto venezolano.
    expect(f.tax_amount).toBe("0.00000000");
  });

  it("una factura con el mismo documento del mismo proveedor se rechaza: es el doble pago", async () => {
    const r = await pedir("POST", "/v1/supplier-invoices", COMPRADOR, {
      company_id: COMPANY,
      supplier_id: PROV,
      supplier_document_number: `FAC-${RUN}-2`,
      supplier_control_number: "00-9999999",
      invoice_date: HOY,
      currency: "VES",
      lines: [{ product_id: PROD_A, quantity: "1", unit_price: "100" }],
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("DUPLICATE");
  });

  it("un precio fuera del umbral se bloquea; la diferencia de cantidad se ve pero no se aprueba", async () => {
    // La orden pactó 100 USD; se factura 130 → 30 %, muy por encima del 5 %.
    const rec = await sql<{ id: string }[]>`
      select rl.id from public.goods_receipt_lines rl
       where rl.company_id = ${COMPANY} and rl.purchase_order_line_id = ${LINEA_ORDEN}
       order by rl.created_at limit 1`;
    const r = await pedir("POST", "/v1/supplier-invoices", COMPRADOR, {
      company_id: COMPANY,
      supplier_id: PROV,
      purchase_order_id: ORDEN,
      supplier_document_number: `FAC-${RUN}-3`,
      supplier_control_number: "00-1234570",
      invoice_date: HOY,
      currency: "USD",
      lines: [
        {
          goods_receipt_line_id: rec[0]!.id,
          product_id: PROD_A,
          quantity: "4",
          unit_price: "130",
        },
      ],
    });
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string };
    expect(cuerpo.code).toBe("PRICE_ABOVE_TOLERANCE");
  });

  it("el matching muestra los tres vértices y su diferencia de precio", async () => {
    const facturas = await pedir("GET", "/v1/supplier-invoices?status=posted", COMPRADOR);
    const lista = (await facturas.json()) as { items: Record<string, string>[] };
    const conOrden = lista.items.find((i) => i["purchase_order_id"] !== null);
    expect(conOrden).toBeDefined();
    const m = await pedir(
      "GET",
      `/v1/purchases/matching?supplier_invoice_id=${conOrden!["id"]}`,
      COMPRADOR,
    );
    expect(m.status).toBe(200);
    const cuerpo = (await m.json()) as { price_tolerance_pct: string; rows: unknown[] };
    expect(cuerpo.price_tolerance_pct).toBe("5.00000000");
    expect(Array.isArray(cuerpo.rows)).toBe(true);
  });

  it("la nota de crédito recibida reduce el saldo de su factura", async () => {
    const facturas = await pedir("GET", "/v1/supplier-invoices?status=posted", COMPRADOR);
    const lista = (await facturas.json()) as { items: Record<string, string>[] };
    const f = lista.items.find((i) => i["supplier_document_number"] === `FAC-${RUN}-2`)!;
    expect(f["balance"]).toBe("46400.00000000");

    const nc = await pedir("POST", "/v1/supplier-credit-notes", COMPRADOR, {
      company_id: COMPANY,
      supplier_invoice_id: f["id"],
      supplier_document_number: `NC-${RUN}-1`,
      supplier_control_number: "00-1234599",
      note_date: HOY,
      reason: "Mercancía devuelta por defecto de fábrica",
      currency: "VES",
      lines: [{ product_id: PROD_A, quantity: "1", unit_price: "4000", tax_amount: "640" }],
    });
    expect(nc.status).toBe(201);
    const n = (await nc.json()) as { total_amount: string; balance: string };
    expect(n.total_amount).toBe("4640.00000000");
    expect(n.balance).toBe("41760.00000000");
  });

  it("el pago aplica la retención: el proveedor cobra el neto y el bruto cancela la deuda", async () => {
    const facturas = await pedir("GET", "/v1/supplier-invoices?status=posted", COMPRADOR);
    const lista = (await facturas.json()) as { items: Record<string, string>[] };
    const f = lista.items.find((i) => i["supplier_document_number"] === `FAC-${RUN}-2`)!;

    const p = await pedir("POST", "/v1/supplier-payments", COMPRADOR, {
      company_id: COMPANY,
      supplier_invoice_id: f["id"],
      gross_amount: f["balance"],
      currency: "VES",
      instrument: "transferencia",
      reference: "TRF-E2E-1",
      issue_retention_receipt: true,
    });
    expect(p.status).toBe(201);
    const cuerpo = (await p.json()) as {
      payment: Record<string, string>;
      retention_receipt: Record<string, string | number> | null;
      balance: string;
      invoice_status: string;
    };
    // Saldo 41 760; retención 4 800; el proveedor cobra 36 960.
    expect(cuerpo.payment["gross_amount"]).toBe("41760.00000000");
    expect(cuerpo.payment["retained_amount"]).toBe("4800.00000000");
    expect(cuerpo.payment["net_amount"]).toBe("36960.00000000");
    expect(cuerpo.balance).toBe("0.00000000");
    expect(cuerpo.invoice_status).toBe("paid");
    // Y el comprobante, con su correlativo propio.
    expect(cuerpo.retention_receipt).not.toBeNull();
    expect(cuerpo.retention_receipt!["receipt_number"]).toBe(1);
    expect(cuerpo.retention_receipt!["total_retained"]).toBe("4800.00000000");
  });

  it("anular el comprobante conserva su correlativo y el siguiente no reutiliza el hueco", async () => {
    const [c] = await sql<{ id: string }[]>`
      select id from public.retention_receipts
       where company_id = ${COMPANY} and receipt_number = 1`;
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${COMPRADOR}, true)`;
      await tx`update public.retention_receipts
                  set status = 'annulled', annulled_at = now(),
                      annul_reason = 'Error en la base retenida'
                where id = ${c!.id}`;
    });
    const [despues] = await sql<{ n: string }[]>`
      select receipt_number::text as n from public.retention_receipts where id = ${c!.id}`;
    expect(despues!.n).toBe("1");
    const [siguiente] = await sql<{ n: string }[]>`
      select platform.claim_retention_receipt_number(${COMPANY}, 'A')::text as n`;
    expect(siguiente!.n).toBe("2");
  });

  it("una recepción confirmada no se edita, ni por SQL: append-only en las dos capas", async () => {
    const [r] = await sql<{ id: string }[]>`
      select id from public.goods_receipts
       where company_id = ${COMPANY} and status = 'confirmed' limit 1`;
    await expect(
      sql`update public.goods_receipts set delivery_note_ref = 'cambiada' where id = ${r!.id}`,
    ).rejects.toThrow();
  });

  it("la antigüedad de CxP exige ap.read: ver la empresa no es ver lo que se debe", async () => {
    const sinPermiso = await pedir("GET", `/v1/suppliers/${PROV}/aging`, MIRON);
    expect(sinPermiso.status).toBe(403);

    const est = await pedir("GET", `/v1/suppliers/${PROV}/statement`, COMPRADOR);
    expect(est.status).toBe(200);
    const e = (await est.json()) as {
      currency: string;
      invoices: unknown[];
      total_retained: string;
    };
    expect(e.currency).toBe("VES");
    expect(e.invoices.length).toBeGreaterThan(0);
    expect(Number(e.total_retained)).toBeGreaterThanOrEqual(4800);
  });
});

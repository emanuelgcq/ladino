import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { sembrarTasaOficial, borrarTasasOficiales } from "./_tasa-oficial.js";

/**
 * EL TIPO DE CONTRIBUYENTE TIENE VIGENCIA, Y LA RETENCIÓN QUE NOS PRACTICAN ABONA A LA TASA DE
 * LA FACTURA (ADR-0072 §1 y §5; A-03, B-07, F-11; migración 20260928190000).
 *
 * Lo que este fichero demuestra por el camino real:
 *   1. una empresa con RIF que no declaró su tipo NO factura: 409 TAXPAYER_TYPE_REQUIRED con el
 *      camino para declararlo — o «pídeselo a quien administra» si el usuario no puede;
 *   2. declarar «especial» exige la fecha de notificación, rige desde ella, y entonces se factura;
 *   3. la vigencia: una factura fechada ANTES de la declaración no tiene tipo, y declarar un tipo
 *      desde una fecha anterior la deja emitir — leyendo el tipo de SU fecha, no el de hoy;
 *   4. el comprobante soportado: 14 dígitos, único por cliente, 75 % o 100 % del IVA en Bs de la
 *      factura, abona la CxC a la tasa de la factura SIN diferencial; lo carga quien tiene
 *      `ar.retention.register` (el cajero) y no basta con `sales.payment.register`.
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
const GERENTE = crypto.randomUUID();
const CAJERO = crypto.randomUUID();
const COBRADOR = crypto.randomUUID();
const CLIENTE = crypto.randomUUID();
const CLIENTE_MINI = crypto.randomUUID();
const RUN = Date.now().toString(36);
// rate_for prefiere la fuente oficial «BCV…»: con otra, una tasa sobrante de otro fichero manda.
const FUENTE = `BCV e2e-tipo-${RUN}`;
const HOY = diaCaracas();
const AYER = diaCaracas(-1);
// Mediodía de Caracas de ayer: el día del documento no depende del reloj del runner.
const AYER_MEDIODIA = `${AYER}T16:00:00.000Z`;
const COMPROBANTE = `${HOY.replace(/-/g, "").slice(0, 6)}${String(Date.now()).slice(-8)}`;

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PRODUCTO = "";
let PRODUCTO_MINI = "";
let FACTURA_AYER = "";
let FACTURA_HOY = "";

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
  quien: string,
  body?: unknown,
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

const factura = (quien: string, issuedAt?: string) =>
  pedir("POST", "/v1/invoices", quien, {
    company_id: COMPANY,
    customer_id: CLIENTE,
    warehouse_id: W1,
    ...(issuedAt === undefined ? {} : { issued_at: issuedAt }),
    lines: [{ product_id: PRODUCTO, quantity: "1" }],
  });

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  for (const u of [GERENTE, CAJERO, COBRADOR]) {
    await sql`insert into auth.users (id) values (${u}) on conflict (id) do nothing`;
  }
  // La tasa del día de la factura y la de hoy, DISTINTAS: sin eso, «a la tasa de la factura» y
  // «a la tasa del día» dan lo mismo y el test no distinguiría nada.
  await sembrarTasaOficial(sql, { rate: "100", rate_date: AYER, source: FUENTE });
  await sembrarTasaOficial(sql, { rate: "110", rate_date: HOY, source: FUENTE });

  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${GERENTE}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e tipo')`;
    // SIN taxpayer_type_code: la empresa con RIF nace sin tipo declarado.
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, activity_start_date)
             values (${COMPANY}, ${TENANT}, ${`J${String(Date.now()).slice(-9)}`},
                     'Empresa e2e tipo', 'VES', '2026-01-01')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-TW1', 'Principal')`;
    const roles: Array<[string, string, string[]]> = [
      [
        GERENTE,
        "gerente",
        [
          "sales.invoice.issue",
          "sales.payment.register",
          "ar.retention.register",
          "ar.read",
          "fiscal.range.manage",
          "company.settings.manage",
        ],
      ],
      [CAJERO, "cajero", ["sales.invoice.issue", "ar.retention.register", "ar.read"]],
      [COBRADOR, "cobrador", ["sales.payment.register", "ar.read"]],
    ];
    for (const [usuario, nombre, permisos] of roles) {
      const rol = crypto.randomUUID();
      const mem = crypto.randomUUID();
      await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
               values (${rol}, null, ${`e2etipo_${nombre}_${RUN}`}, ${nombre}, false)`;
      for (const p of permisos) {
        await tx`insert into public.role_permissions (role_id, permission_key)
                 values (${rol}, ${p})`;
      }
      await tx`insert into public.memberships (id, tenant_id, user_id)
               values (${mem}, ${TENANT}, ${usuario})`;
      await tx`insert into public.user_role_assignments
                 (tenant_id, membership_id, role_id, company_id)
               values (${TENANT}, ${mem}, ${rol}, null)`;
    }
    await tx`insert into public.customers
               (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                taxpayer_type_code)
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, ${`J${String(Date.now() + 7).slice(-9)}`},
                     'Agente e2e tipo', 'juridica', 'ordinario')`;
    // Un SERVICIO: sin kardex, la factura fechada ayer no depende de existencias.
    const [p] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2ETIPO-${RUN}`}, 'Servicio gravado', 'service', 'active',
              'unidad', 'gravado_general')
      returning id`;
    PRODUCTO = p!.id;
    // B4: un servicio de Bs 0,13 en una lista en bolívares — IVA Bs 0,02: las dos porciones caben en
    // ± 0,01. (En la lista en USD el mínimo es 0,01 USD, que ya son Bs 1,10.)
    const [mini] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2ETIPO-MINI-${RUN}`}, 'Servicio mínimo', 'service',
              'active', 'unidad', 'gravado_general')
      returning id`;
    PRODUCTO_MINI = mini!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, ${`e2e-tipo-${RUN}`}, 'USD') returning id`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${l!.id}, ${PRODUCTO}, '10.00000000', '2026-01-01')`;
    const [lv] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, ${`e2e-tipo-ves-${RUN}`}, 'VES') returning id`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${lv!.id}, ${PRODUCTO_MINI}, '0.13000000', '2026-01-01')`;
    await tx`insert into public.customers
               (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                taxpayer_type_code, default_price_list_id)
             values (${CLIENTE_MINI}, ${TENANT}, ${COMPANY}, ${`J${String(Date.now() + 11).slice(-9)}`},
                     'Agente mínimo e2e', 'juridica', 'ordinario', ${lv!.id})`;
    await tx`update public.customers set default_price_list_id = ${l!.id} where id = ${CLIENTE}`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${TENANT}, ${COMPANY}, 'formatos_libres', '2026-01-01'::timestamptz)`;
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
    await tx`
      insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                                    rate, effective_from, legal_source, priority, transaction_type)
      select 'VE', 'iva', 'ordinario', 'gravado_general', 0.16, ${AYER}::date,
             'Carga de prueba E2E — VALIDAR-SENIAT antes de producción.', 10, 'sale'
       where not exists (select 1 from public.tax_rules
                          where company_id is null and jurisdiction = 'VE' and tax_code = 'iva'
                            and taxpayer_type = 'ordinario'
                            and product_tax_category = 'gravado_general'
                            and transaction_type = 'sale')`;
  });

  const rango = await pedir("POST", "/v1/fiscal-number-ranges", GERENTE, {
    company_id: COMPANY,
    kind: "invoice",
    series: "A",
    range_from: "1",
    range_to: "500",
    printer_source: "Imprenta E2E tipo",
    printer_legal_name: "Imprenta E2E, C.A.",
    printer_tax_id: "J-12345678-9",
    printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
    printer_authorization_date: "2020-01-15",
    printed_on: "2026-01-01",
  });
  if (rango.status !== 201) throw new Error(`rango: ${rango.status} ${await rango.text()}`);
});

afterAll(async () => {
  await borrarTasasOficiales(sql, FUENTE);
  await sql.end();
  await sqlApi.end();
});

describe("sin tipo declarado no se factura (A-03)", () => {
  it("quien puede declararlo recibe 409 TAXPAYER_TYPE_REQUIRED con el camino", async () => {
    const r = await factura(GERENTE);
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string; message: string; person_message: string };
    expect(cuerpo.code).toBe("TAXPAYER_TYPE_REQUIRED");
    expect(cuerpo.person_message).toContain("Configuración");
    expect(cuerpo.person_message).toContain("tipo de contribuyente");
  });

  it("quien no puede, recibe «pídeselo a quien administra»", async () => {
    const r = await factura(CAJERO);
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string; person_message: string };
    expect(cuerpo.code).toBe("TAXPAYER_TYPE_REQUIRED");
    expect(cuerpo.person_message).toContain("quien administra");
  });

  it("la lectura del tipo dice que no hay ninguno vigente, sin inventar «ordinario»", async () => {
    const r = await pedir("GET", "/v1/companies/taxpayer-type", GERENTE);
    expect(r.status).toBe(200);
    const cuerpo = (await r.json()) as { current: unknown; history: unknown[] };
    expect(cuerpo.current).toBeNull();
    expect(cuerpo.history).toHaveLength(0);
  });
});

describe("declarar especial con fechas, y la vigencia (B-07)", () => {
  it("especial sin fecha de notificación: 422", async () => {
    const r = await pedir("PUT", "/v1/companies/taxpayer-type", GERENTE, {
      company_id: COMPANY,
      taxpayer_type_code: "especial",
      reason: "Providencia de calificación recibida",
    });
    expect(r.status).toBe(422);
  });

  it("especial notificado hoy rige desde hoy, y entonces se factura", async () => {
    const r = await pedir("PUT", "/v1/companies/taxpayer-type", GERENTE, {
      company_id: COMPANY,
      taxpayer_type_code: "especial",
      notified_on: HOY,
      reason: "Providencia de calificación notificada hoy",
    });
    expect(r.status).toBe(200);
    const cuerpo = (await r.json()) as Record<string, unknown>;
    expect(cuerpo["taxpayer_type_code"]).toBe("especial");
    expect(cuerpo["effective_from"]).toBe(HOY);
    expect(cuerpo["notified_on"]).toBe(HOY);

    const f = await factura(GERENTE);
    expect(f.status).toBe(201);
    FACTURA_HOY = ((await f.json()) as Record<string, string>)["id"]!;
  });

  it("«formal» no se declara hasta construir M-10 (PA 00071 art. 15, P-38): 422", async () => {
    const r = await pedir("PUT", "/v1/companies/taxpayer-type", GERENTE, {
      company_id: COMPANY,
      taxpayer_type_code: "formal",
      reason: "Intento de declararse formal",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain("M-10");
  });

  it("una factura fechada AYER no tiene tipo: la declaración de hoy no rige hacia atrás", async () => {
    const r = await factura(GERENTE, AYER_MEDIODIA);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("TAXPAYER_TYPE_REQUIRED");
  });

  it("«no contribuyente» no se declara (se deriva de no tener RIF): 422 legible", async () => {
    const r = await pedir("PUT", "/v1/companies/taxpayer-type", GERENTE, {
      company_id: COMPANY,
      taxpayer_type_code: "no_contribuyente",
      reason: "Intento de declararse no contribuyente",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain("no se declara");
  });

  it("ordinario con fecha de notificación: 422, no un 23514 de la base", async () => {
    const r = await pedir("PUT", "/v1/companies/taxpayer-type", GERENTE, {
      company_id: COMPANY,
      taxpayer_type_code: "ordinario",
      notified_on: HOY,
      reason: "Ordinario con notificación",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { code: string }).code).toBe("VALIDATION_FAILED");
  });

  it("declarar ordinario desde enero deja emitir la de ayer, y hoy sigue siendo especial", async () => {
    const r = await pedir("PUT", "/v1/companies/taxpayer-type", GERENTE, {
      company_id: COMPANY,
      taxpayer_type_code: "ordinario",
      effective_from: "2026-01-01",
      reason: "Antes de la calificación la empresa era contribuyente ordinario",
    });
    expect(r.status).toBe(200);

    const f = await factura(GERENTE, AYER_MEDIODIA);
    expect(f.status).toBe(201);
    const doc = (await f.json()) as Record<string, string>;
    FACTURA_AYER = doc["id"]!;
    expect(doc["fx_rate"]).toBe("100.00000000");

    const tipo = (await (await pedir("GET", "/v1/companies/taxpayer-type", GERENTE)).json()) as {
      current: { taxpayer_type_code: string; effective_from: string } | null;
      history: unknown[];
    };
    expect(tipo.current?.taxpayer_type_code).toBe("especial");
    expect(tipo.history).toHaveLength(2);
    const [espejo] = await sql<{ t: string | null; ayer: string | null }[]>`
      select taxpayer_type_code as t,
             platform.taxpayer_type_at(${COMPANY}, ${AYER}::date) as ayer
        from public.companies where id = ${COMPANY}`;
    expect(espejo!.t).toBe("especial");
    expect(espejo!.ayer).toBe("ordinario");
  });
});

describe("declaración retroactiva (decidido por criterio, ADR-0072 nota de aplicación)", () => {
  it("la vista previa y la respuesta dicen cuántos documentos fiscales hay desde esa fecha", async () => {
    const previa = await pedir(
      "GET",
      `/v1/companies/taxpayer-type?effective_from=${AYER}`,
      GERENTE,
    );
    expect(previa.status).toBe(200);
    const n = ((await previa.json()) as { documents_issued_since: number }).documents_issued_since;
    // La de hoy y la de ayer, como mínimo.
    expect(n).toBeGreaterThanOrEqual(2);

    const r = await pedir("PUT", "/v1/companies/taxpayer-type", GERENTE, {
      company_id: COMPANY,
      taxpayer_type_code: "especial",
      notified_on: AYER,
      reason: "La providencia se notificó ayer: corrijo la fecha con acta",
    });
    expect(r.status).toBe(200);
    const cuerpo = (await r.json()) as {
      effective_from: string;
      documents_issued_since: number;
      retroactive_warning: string | null;
    };
    expect(cuerpo.effective_from).toBe(AYER);
    expect(cuerpo.documents_issued_since).toBe(n);
    expect(cuerpo.retroactive_warning).toContain("No se reemiten");
    const [acta] = await sql<{ n: number }[]>`
      select (payload->>'documents_issued_since')::int as n from public.audit_events
       where company_id = ${COMPANY} and event_type = 'company.taxpayer_type.set'
       order by occurred_at desc, id desc limit 1`;
    expect(acta!.n).toBe(n);
  });
});

describe("retenciones que nos practicaron (F-01, F-11)", () => {
  const retencion = (quien: string, cambios: Record<string, string> = {}) =>
    pedir("POST", "/v1/fiscal-declarations/supported-retentions", quien, {
      company_id: COMPANY,
      customer_id: CLIENTE,
      document_id: FACTURA_AYER,
      receipt_number: COMPROBANTE,
      retained_on: HOY,
      base: "160.00",
      rate: "0.75",
      amount: "120.00",
      ...cambios,
    });

  it("un número que no tiene 14 dígitos: 422", async () => {
    const r = await retencion(CAJERO, { receipt_number: "AG-0001" });
    expect(r.status).toBe(422);
  });

  it("un monto que no es el 75 % ni el 100 % del IVA en Bs de la factura: 422 legible", async () => {
    const r = await retencion(CAJERO, { amount: "100.00" });
    expect(r.status).toBe(422);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.message).toContain("75 %");
    expect(cuerpo.message).toContain("120,00");
    expect(cuerpo.message).toContain("160,00");
  });

  it("con solo sales.payment.register no se carga: hace falta ar.retention.register", async () => {
    const r = await retencion(COBRADOR);
    expect(r.status).toBe(403);
  });

  it("el cajero la carga y abona la CxC a la tasa de la factura, sin diferencial", async () => {
    const r = await retencion(CAJERO);
    expect(r.status).toBe(201);
    const cuerpo = (await r.json()) as {
      retention: Record<string, string>;
      payment: { payment: Record<string, string | null>; exchange_difference: unknown };
    };
    expect(cuerpo.payment.exchange_difference).toBeNull();
    const pagoId = cuerpo.payment.payment["id"]!;
    const [dif] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.exchange_gain_loss where payment_id = ${pagoId}`;
    expect(dif!.n).toBe(0);
    // 10 USD + 16 % = 11,60 USD; la retención de Bs 120 a la tasa de la factura (100) salda
    // 1,20 USD — a la de hoy (110) habría saldado 1,0909 y dejado un diferencial.
    const [saldo] = await sql<{ usd: string }[]>`
      select platform.document_balance_transaction(${COMPANY}, ${FACTURA_AYER})::text as usd`;
    expect(saldo!.usd).toBe("10.40000000");
    // El saldo en Bs: 1.160 − 120 = 1.040 (la retención baja el funcional por su importe).
    const [bs] = await sql<{ bs: string }[]>`
      select platform.document_balance(${COMPANY}, ${FACTURA_AYER})::text as bs`;
    expect(bs!.bs).toBe("1040.00000000");
    // Sin plan contable, el abono entra a la COLA con su evento — nunca se pierde.
    const [cola] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.journal_generation_queue
       where company_id = ${COMPANY} and source_id = ${pagoId}
         and source_event = 'ar.retention_applied'`;
    expect(cola!.n).toBe(1);
    // El invariante que cruza ventas con contabilidad: documento posteado ⇒ asiento o cola.
    const [huecos] = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.accounting_coverage_gaps(${COMPANY})`;
    expect(huecos!.n).toBe(0);
  });

  it("el mismo número del mismo cliente no entra dos veces", async () => {
    const r = await retencion(GERENTE);
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("DUPLICATE");
    // El mensaje del caso de uso (contra ESA factura), no el genérico del mapeo de 23505.
    expect(cuerpo.message).toContain(
      `El comprobante ${COMPROBANTE} de ese cliente ya está cargado contra esa factura`,
    );
  });

  it("PA 000054 art. 16: el MISMO comprobante (quincenal) cubre otra factura del mismo cliente", async () => {
    // La de hoy: 10 USD a 110 = Bs 1.100 de base, Bs 176 de IVA; el 75 % son Bs 132.
    const r = await retencion(CAJERO, {
      document_id: FACTURA_HOY,
      base: "176.00",
      amount: "132.00",
    });
    expect(r.status).toBe(201);
    const otra = await retencion(CAJERO, {
      document_id: FACTURA_HOY,
      base: "176.00",
      amount: "132.00",
    });
    expect(otra.status).toBe(409);
    const cuerpo = (await otra.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("DUPLICATE");
    expect(cuerpo.message).toContain(
      `El comprobante ${COMPROBANTE} de ese cliente ya está cargado contra esa factura`,
    );
  });

  it("B4: con un IVA de Bs 0,02 o menos, manda la porción indicada si cabe en la tolerancia", async () => {
    const f = await pedir("POST", "/v1/invoices", GERENTE, {
      company_id: COMPANY,
      customer_id: CLIENTE_MINI,
      warehouse_id: W1,
      lines: [{ product_id: PRODUCTO_MINI, quantity: "1" }],
    });
    expect(f.status).toBe(201);
    const mini = (await f.json()) as Record<string, string>;
    // El 75 % y el 100 % de un IVA tan pequeño caen los dos dentro de ± Bs 0,01: el comprobante
    // dice 100 % y eso es lo que vale, no la primera porción del catálogo.
    const r = await retencion(CAJERO, {
      customer_id: CLIENTE_MINI,
      document_id: mini["id"]!,
      receipt_number: `${COMPROBANTE.slice(0, 6)}99999999`,
      base: "0.01",
      rate: "1.00",
      amount: "0.02",
    });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { retention: { rate: string } }).retention.rate).toBe("1.00000000");
  });

  it("el prefijo AAAAMM del comprobante es un año y un mes válidos: mes 13 → 422", async () => {
    const r = await retencion(CAJERO, { receipt_number: "20261399999999" });
    expect(r.status).toBe(422);
  });

  it("la porción sale del catálogo vigente a la fecha del comprobante: antes de la PA 000054, 422", async () => {
    const r = await retencion(CAJERO, {
      receipt_number: "20250100000001",
      retained_on: "2025-01-15",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain("2025-01-15");
  });
});

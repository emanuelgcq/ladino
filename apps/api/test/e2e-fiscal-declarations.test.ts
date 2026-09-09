import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * DECLARACIONES DE IVA de extremo a extremo (migración 46).
 *
 * Lo que este fichero está aquí para demostrar, y que ningún test unitario ve:
 *   1. registrar una retención SOPORTADA abona la factura por el camino real:
 *      pago sin cuenta, evento `ar.retention_applied`, asiento del preset
 *      (Dr IVA retenido por cobrar / Cr cuentas por cobrar) POSTEADO y cuadrado;
 *   2. el mismo comprobante NO abona dos veces, ni con otro número de intento;
 *   3. el período se ENCADENA: el excedente que dejó un período aparece como
 *      excedente anterior del siguiente, y saltarse un eslabón responde 422;
 *   4. un período SIN actividad se genera en cero — la cadena no se rompe;
 *   5. el TXT de retenciones practicadas se exporta (deja run, .txt) — con el
 *      libro vacío produce contenido vacío, nunca una cabecera fantasma;
 *   6. el calendario se carga con fuente y recargarlo CORRIGE, no duplica.
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
const CONTADOR = crypto.randomUUID();
const AGENTE = crypto.randomUUID();
const ROL = crypto.randomUUID();
const MEM = crypto.randomUUID();
const ASIG = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = new Date().toISOString().slice(0, 10);
const AYER = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const MANANA = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PRODUCTO = "";
let FACTURA1 = "";
let FACTURA2 = "";
let RETENCION = "";

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
    Authorization: `Bearer ${await tokenDe(CONTADOR)}`,
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
  await sql`insert into auth.users (id) values (${CONTADOR}) on conflict (id) do nothing`;

  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${CONTADOR}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e declaraciones')`;
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-DEC-${RUN}`}, 'Empresa e2e declaraciones',
                     'VES', 'ordinario')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-DW1', 'Principal')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, ${`e2edecl_${RUN}`}, 'Contador declaraciones e2e', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.payment.register'),
             -- Emitir GENERA el kardex, así que el permiso de inventario
             -- acompaña al de emisión (igual que en el E2E de libros).
             (${ROL}, 'inventory.move'),
             (${ROL}, 'ar.read'), (${ROL}, 'fiscal.range.manage'),
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.read'),
             (${ROL}, 'fiscal_book.read'), (${ROL}, 'fiscal_book.export'),
             (${ROL}, 'company.settings.manage')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${MEM}, ${TENANT}, ${CONTADOR})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id)
             values (${ASIG}, ${TENANT}, ${MEM}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, ${ASIG}, 'warehouse', ${W1})`;
    // El AGENTE que nos retiene: un cliente sujeto pasivo especial, con RIF —
    // la clasificación `especial` lo exige.
    await tx`insert into public.customers
               (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                taxpayer_type_code)
             values (${AGENTE}, ${TENANT}, ${COMPANY}, ${`J-AGE-${RUN}`}, 'Agente e2e',
                     'juridica', 'especial')`;

    const [p] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2EDEC-G-${RUN}`}, 'Producto gravado', 'good', 'active',
              'unidad', 'gravado_general')
      returning id`;
    PRODUCTO = p!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, ${`e2e-decl-${RUN}`}, 'VES') returning id`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${l!.id}, ${PRODUCTO}, '1000.00000000', ${AYER}::date)`;
    await tx`update public.customers set default_price_list_id = ${l!.id} where id = ${AGENTE}`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${TENANT}, ${COMPANY}, 'formatos_libres', ${AYER}::timestamptz)`;

    // La regla de IVA global de prueba, con el mismo advisory lock que usan
    // los otros E2E que siembran en paralelo.
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
    for (const tipo of ["sale", "purchase"] as const) {
      await tx`
        insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type,
                                      product_tax_category, rate, effective_from, legal_source,
                                      priority, transaction_type)
        select 'VE', 'iva', 'ordinario', 'gravado_general', 0.16, ${AYER}::date,
               'Carga de prueba E2E — VALIDAR-SENIAT antes de producción.', 10, ${tipo}
         where not exists (select 1 from public.tax_rules
                            where jurisdiction = 'VE' and tax_code = 'iva'
                              and taxpayer_type = 'ordinario'
                              and product_tax_category = 'gravado_general'
                              and transaction_type = ${tipo})`;
    }

    await tx`insert into public.inventory_moves
               (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
                amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
                functional_currency, rate_source, rate_timestamp, rounding_policy_id,
                occurred_at, reference)
             values (${TENANT}, ${COMPANY}, ${W1}, ${PRODUCTO}, 'entrada', 100, 50000, 'VES',
                     1, 50000, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', now(),
                     ${`e2e-decl-seed-${RUN}`})`;
  });

  const rango = await pedir("POST", "/v1/fiscal-number-ranges", {
    company_id: COMPANY,
    kind: "invoice",
    series: "A",
    range_from: "1",
    range_to: "500",
    printer_source: "Imprenta E2E declaraciones",
  });
  if (rango.status !== 201) throw new Error(`rango: ${rango.status} ${await rango.text()}`);

  // Contabilidad montada a propósito: el asiento del abono por retención es
  // parte de lo que este fichero afirma.
  const plan = await pedir("POST", "/v1/accounts/import-template", {
    company_id: COMPANY,
    template_code: "ve_basico",
  });
  if (plan.status !== 201) throw new Error(`plan: ${plan.status} ${await plan.text()}`);
  const preset = await pedir("POST", "/v1/journal-templates/import-preset", {
    company_id: COMPANY,
    preset_code: "ve_basico",
  });
  if (preset.status !== 201) throw new Error(`preset: ${preset.status} ${await preset.text()}`);
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("retenciones soportadas — el comprobante abona la factura", () => {
  it("registra el comprobante y abona por el camino real: sin cuenta, con su asiento", async () => {
    const f = await pedir("POST", "/v1/invoices", {
      company_id: COMPANY,
      customer_id: AGENTE,
      warehouse_id: W1,
      lines: [{ product_id: PRODUCTO, quantity: "2" }],
    });
    expect(f.status).toBe(201);
    const doc = (await f.json()) as Record<string, string>;
    FACTURA1 = doc["id"]!;
    // 2 × 1 000 = 2 000 de base, 320 de IVA, 2 320 de total.
    expect(doc["total_amount"]).toBe("2320.00000000");

    // El agente retuvo el 75 % del IVA: 240. Todo transcrito de su comprobante.
    const r = await pedir("POST", "/v1/fiscal-declarations/supported-retentions", {
      company_id: COMPANY,
      customer_id: AGENTE,
      document_id: FACTURA1,
      receipt_number: `AG-${RUN}-0001`,
      retained_on: AYER,
      base: "320.00",
      rate: "0.75",
      amount: "240.00",
    });
    expect(r.status).toBe(201);
    const cuerpo = (await r.json()) as {
      retention: Record<string, string>;
      payment: { payment: Record<string, string | null>; balance: string };
    };
    RETENCION = cuerpo.retention["id"]!;
    expect(cuerpo.retention["status"]).toBe("registered");
    expect(cuerpo.payment.payment["instrument"]).toBe("retencion_iva");
    expect(cuerpo.payment.payment["supported_retention_id"]).toBe(RETENCION);
    // 2 320 − 240 = 2 080 pendientes.
    expect(cuerpo.payment.balance).toBe("2080.00000000");

    // El asiento del preset, POSTEADO y cuadrado — la aserción que distingue
    // «el evento existe» de «el evento contabiliza».
    const [asiento] = await sql<{ status: string; debe: string; haber: string }[]>`
      select e.status,
             sum(l.debit_amount)::text as debe, sum(l.credit_amount)::text as haber
        from public.journal_entries e
        join public.journal_lines l on l.entry_id = e.id
       where e.company_id = ${COMPANY} and e.source_event = 'ar.retention_applied'
       group by e.id, e.status`;
    expect(asiento).toBeDefined();
    expect(asiento!.status).toBe("posted");
    expect(asiento!.debe).toBe(asiento!.haber);
    expect(asiento!.debe).toBe("240.00000000");
  });

  it("el mismo comprobante del mismo agente NO se registra dos veces", async () => {
    const r = await pedir("POST", "/v1/fiscal-declarations/supported-retentions", {
      company_id: COMPANY,
      customer_id: AGENTE,
      document_id: FACTURA1,
      receipt_number: `AG-${RUN}-0001`,
      retained_on: AYER,
      base: "320.00",
      rate: "0.75",
      amount: "240.00",
    });
    expect(r.status).toBe(409);
  });

  it("un comprobante usado no abona otra vez, y no abona la factura que no afecta", async () => {
    const f = await pedir("POST", "/v1/invoices", {
      company_id: COMPANY,
      customer_id: AGENTE,
      warehouse_id: W1,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
    });
    expect(f.status).toBe(201);
    FACTURA2 = ((await f.json()) as Record<string, string>)["id"]!;

    // Contra OTRA factura: el comprobante afecta a la primera.
    const ajena = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: FACTURA2,
      currency: "VES",
      amount: "240.00",
      instrument: "retencion_iva",
      supported_retention_id: RETENCION,
    });
    expect(ajena.status).toBe(422);

    // Contra la suya, pero YA usado.
    const repetido = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: FACTURA1,
      currency: "VES",
      amount: "240.00",
      instrument: "retencion_iva",
      supported_retention_id: RETENCION,
    });
    expect(repetido.status).toBe(422);
    const cuerpo = (await repetido.json()) as { message: string };
    // El MENSAJE del camino que dice probar, no solo el código (regla S0.5).
    expect(cuerpo.message).toContain("ya abonó");

    // Y sin comprobante, el instrumento ni arranca.
    const sinComprobante = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: FACTURA2,
      currency: "VES",
      amount: "1.00",
      instrument: "retencion_iva",
    });
    expect(sinComprobante.status).toBe(422);
  });
});

describe("el período de IVA — la cadena de excedentes", () => {
  it("saltarse el eslabón anterior responde 422, no un cero en silencio", async () => {
    // Hay una retención de AYER sin período generado: HOY no puede ir primero.
    const r = await pedir("POST", "/v1/fiscal-declarations/iva-periods", {
      company_id: COMPANY,
      period_from: HOY,
      period_to: HOY,
    });
    expect(r.status).toBe(422);
    const cuerpo = (await r.json()) as { message: string };
    expect(cuerpo.message).toContain("encadenado");
  });

  it("el período de la retención deja excedente, y el siguiente lo recibe", async () => {
    // AYER: sin ventas, con la retención de 240 → excedente 240, cuota 0.
    const r1 = await pedir("POST", "/v1/fiscal-declarations/iva-periods", {
      company_id: COMPANY,
      period_from: AYER,
      period_to: AYER,
    });
    expect(r1.status).toBe(201);
    const p1 = (await r1.json()) as Record<string, string>;
    expect(p1["retenciones_soportadas"]).toBe("240.00000000");
    // La fila PERSISTIDA: numeric(24,8), así que el cero vuelve con escala.
    expect(p1["cuota_a_pagar"]).toBe("0.00000000");
    expect(p1["excedente_siguiente"]).toBe("240.00000000");
    expect(p1["dataset_hash"]).toMatch(/^[0-9a-f]{64}$/);

    // HOY: débitos 320 + 160 = 480, y el excedente de AYER se descuenta.
    const r2 = await pedir("POST", "/v1/fiscal-declarations/iva-periods", {
      company_id: COMPANY,
      period_from: HOY,
      period_to: HOY,
    });
    expect(r2.status).toBe(201);
    const p2 = (await r2.json()) as Record<string, string | { alicuota: string }[]>;
    expect(p2["debitos"]).toBe("480.00000000");
    expect(p2["excedente_anterior"]).toBe("240.00000000");
    expect(p2["cuota_a_pagar"]).toBe("240.00000000");
    expect(p2["excedente_siguiente"]).toBe("0.00000000");
    const detalle = p2["detalle"] as { alicuota: string }[];
    expect(detalle.some((d) => d.alicuota === "0.16000000")).toBe(true);
  });

  it("un período SIN actividad se genera en cero — la cadena no se rompe", async () => {
    const r = await pedir("POST", "/v1/fiscal-declarations/iva-periods", {
      company_id: COMPANY,
      period_from: MANANA,
      period_to: MANANA,
    });
    expect(r.status).toBe(201);
    const p = (await r.json()) as Record<string, string>;
    expect(p["debitos"]).toBe("0.00000000");
    expect(p["cuota_a_pagar"]).toBe("0.00000000");
    expect(p["excedente_anterior"]).toBe("0.00000000");
    expect(p["excedente_siguiente"]).toBe("0.00000000");
  });

  it("las generaciones se listan, la última primero", async () => {
    const r = await pedir("GET", "/v1/fiscal-declarations/iva-periods");
    expect(r.status).toBe(200);
    const { items } = (await r.json()) as { items: Record<string, string>[] };
    expect(items.length).toBe(3);
    expect(items[0]!["period_from"]).toBe(MANANA);
  });
});

describe("el TXT de retenciones practicadas", () => {
  it("figura como implementado en el catálogo", async () => {
    const r = await pedir("GET", "/v1/fiscal-books/formats");
    expect(r.status).toBe(200);
    const formatos = (await r.json()) as { code: string; implemented: boolean }[];
    const txt = formatos.find((f) => f.code === "txt_retenciones_iva");
    expect(txt).toBeDefined();
    expect(txt!.implemented).toBe(true);
  });

  it("exporta dejando run y .txt; el libro vacío da contenido vacío", async () => {
    const r = await pedir("POST", "/v1/fiscal-books/export", {
      company_id: COMPANY,
      book_kind: "retenciones_iva",
      period_from: AYER,
      period_to: HOY,
      format_code: "txt_retenciones_iva",
      timezone: "America/Caracas",
    });
    expect(r.status).toBe(201);
    const cuerpo = (await r.json()) as {
      run: Record<string, string>;
      content: string;
      content_type: string;
      filename: string;
    };
    expect(cuerpo.run["format_code"]).toBe("txt_retenciones_iva");
    expect(cuerpo.filename.endsWith(".txt")).toBe(true);
    expect(cuerpo.content_type).toContain("text/plain");
    // Esta empresa no practicó retenciones: NADA, ni una cabecera fantasma.
    expect(cuerpo.content).toBe("");
  });
});

describe("el calendario de vencimientos", () => {
  it("se carga con fuente, y recargar el mismo período CORRIGE en vez de duplicar", async () => {
    const carga = await pedir("PUT", "/v1/fiscal-declarations/deadlines", {
      company_id: COMPANY,
      deadlines: [
        {
          obligation: "iva",
          period_from: AYER,
          period_to: HOY,
          due_date: MANANA,
          legal_source: "Carga de prueba E2E — calendario por dígito de RIF, VALIDAR-SENIAT.",
        },
      ],
    });
    expect(carga.status).toBe(200);

    const otraVez = await pedir("PUT", "/v1/fiscal-declarations/deadlines", {
      company_id: COMPANY,
      deadlines: [
        {
          obligation: "iva",
          period_from: AYER,
          period_to: HOY,
          due_date: HOY,
          legal_source: "Corrección de prueba E2E — VALIDAR-SENIAT.",
        },
      ],
    });
    expect(otraVez.status).toBe(200);

    const r = await pedir("GET", "/v1/fiscal-declarations/deadlines");
    expect(r.status).toBe(200);
    const { items } = (await r.json()) as { items: Record<string, string>[] };
    expect(items.length).toBe(1);
    expect(items[0]!["due_date"]).toBe(HOY);
  });
});

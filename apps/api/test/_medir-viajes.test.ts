import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * MEDIDOR DE ROUND-TRIPS — herramienta temporal, NO es un test de verdad.
 *
 * Cuenta las sentencias que una venta REAL manda a Postgres. La medición se
 * hace donde no puede mentir: en la propia base, leyendo `pg_stat_statements`
 * antes y después. No instrumenta el cliente ni cambia una línea del código
 * de producción — solo mira.
 *
 * Se corre a mano con:
 *   npx vitest run test/_medir-viajes.test.ts
 *
 * El número que imprime es el que va al informe. Sin esto se optimiza contra
 * estimaciones, que es como no medir.
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
const CAJERO = crypto.randomUUID();
const CLIENTE = crypto.randomUUID();
const ROL = crypto.randomUUID();
const MEM = crypto.randomUUID();
const ASIG = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = new Date().toISOString().slice(0, 10);
const AYER = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
const PRODUCTOS: string[] = [];

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
    Authorization: `Bearer ${await tokenDe(CAJERO)}`,
    "X-Company-Id": COMPANY,
  };
  if (metodo !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await app.request(path, {
    method: metodo,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status >= 400) {
    // eslint-disable-next-line no-console
    console.log(metodo, path, r.status, await r.clone().text());
  }
  return r;
}

/**
 * LO QUE DE VERDAD CUESTA LATENCIA.
 *
 * No es el número de sentencias: es el número de veces que el cliente ESPERA
 * una respuesta antes de mandar la siguiente. Varias sentencias lanzadas
 * juntas (un `Promise.all` dentro de la transacción) viajan pipelineadas y
 * pagan UNA latencia, no N.
 *
 * Se distinguen por el instante de emisión: las que salen en la misma
 * milésima pertenecen a la misma tanda. Contar `pg_stat_statements` daría el
 * total de sentencias y no vería el pipelining — es lo que no hay que medir.
 */
const emisiones: number[] = [];
const textos: string[] = [];
function tandas(desde: number): { sentencias: number; esperas: number } {
  const t = emisiones.slice(desde);
  let esperas = 0;
  let ultimo = -Infinity;
  for (const ms of t) {
    if (ms - ultimo > 1) esperas += 1;
    ultimo = ms;
  }
  return { sentencias: t.length, esperas };
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API, (q) => {
    emisiones.push(performance.now());
    textos.push(q);
  });
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${CAJERO}) on conflict (id) do nothing`;

  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${CAJERO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant medicion')`;
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-MED-${RUN}`}, 'Empresa medicion',
                     'VES', 'ordinario')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'MED-W1', 'Principal')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, ${`medicion_${RUN}`}, 'Cajero medicion', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.payment.register'),
             (${ROL}, 'inventory.move'), (${ROL}, 'ar.read'), (${ROL}, 'fiscal.range.manage'),
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.read')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${MEM}, ${TENANT}, ${CAJERO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id)
             values (${ASIG}, ${TENANT}, ${MEM}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, ${ASIG}, 'warehouse', ${W1})`;
    await tx`insert into public.customers
               (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                taxpayer_type_code, fiscal_address)
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, ${`J-CLI-${RUN}`}, 'Cliente medicion',
                     'juridica', 'ordinario', 'Av. Principal, Caracas')`;

    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, ${`medicion-${RUN}`}, 'VES') returning id`;
    for (let i = 1; i <= 4; i++) {
      const [p] = await tx<{ id: string }[]>`
        insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                     tax_category_code)
        values (${TENANT}, ${COMPANY}, ${`MED-${RUN}-${i}`}, ${`Producto medicion ${i}`},
                'good', 'active', 'unidad', 'gravado_general')
        returning id`;
      PRODUCTOS.push(p!.id);
      await tx`insert into public.price_list_items
                 (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
               values (${TENANT}, ${COMPANY}, ${l!.id}, ${p!.id}, ${`${1000 * i}.00000000`},
                       ${AYER}::date)`;
      await tx`insert into public.inventory_moves
                 (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
                  amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
                  functional_currency, rate_source, rate_timestamp, rounding_policy_id,
                  occurred_at, reference)
               values (${TENANT}, ${COMPANY}, ${W1}, ${p!.id}, 'entrada', 500, 250000, 'VES',
                       1, 250000, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', now(),
                       ${`med-seed-${RUN}-${i}`})`;
    }
    await tx`update public.customers set default_price_list_id = ${l!.id} where id = ${CLIENTE}`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${TENANT}, ${COMPANY}, 'formatos_libres', ${AYER}::timestamptz)`;

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
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), 'medicion'
       where not exists (select 1 from public.exchange_rates
                          where from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = ${HOY}::date)`;
  });

  const rango = await pedir("POST", "/v1/fiscal-number-ranges", {
    company_id: COMPANY,
    kind: "invoice",
    series: "A",
    range_from: "1",
    range_to: "500",
    printer_source: "Imprenta medicion",
  });
  if (rango.status !== 201) throw new Error(`rango: ${rango.status}`);
  const plan = await pedir("POST", "/v1/accounts/import-template", {
    company_id: COMPANY,
    template_code: "ve_basico",
  });
  if (plan.status !== 201) throw new Error(`plan: ${plan.status}`);
  const preset = await pedir("POST", "/v1/journal-templates/import-preset", {
    company_id: COMPANY,
    preset_code: "ve_basico",
  });
  if (preset.status !== 201) throw new Error(`preset: ${preset.status}`);
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("MEDICION de round-trips", () => {
  it("venta de 4 lineas con un pago en divisa", async () => {
    // Una venta previa para no contar el calentamiento (primeras resoluciones,
    // catálogos que se leen una vez). La que se mide es la SEGUNDA.
    const calentar = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: PRODUCTOS.map((id) => ({ product_id: id, quantity: "1" })),
      payments: [{ instrument: "efectivo_usd", amount: "1.00", currency: "USD" }],
    });
    expect(calentar.status).toBe(201);

    const antes = emisiones.length;
    const r = await pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: PRODUCTOS.map((id) => ({ product_id: id, quantity: "2" })),
      payments: [{ instrument: "efectivo_usd", amount: "5.00", currency: "USD" }],
    });
    expect(r.status).toBe(201);

    const m = tandas(antes);
    // eslint-disable-next-line no-console
    console.log(
      `\n=== venta de 4 lineas + 1 pago en divisa: ${m.sentencias} sentencias, ` +
        `${m.esperas} ESPERAS DE RED (lo que paga latencia) ===\n`,
    );
    const conteo = new Map<string, number>();
    for (const q of textos.slice(antes)) {
      const k = q.replace(/s+/g, " ").trim().slice(0, 52);
      conteo.set(k, (conteo.get(k) ?? 0) + 1);
    }
    const top = [...conteo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    // eslint-disable-next-line no-console
    for (const [q, n] of top) console.log(`  ${String(n).padStart(3)}x ${q}`);
    expect(m.esperas).toBeGreaterThan(0);
  });
});

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { sembrarTasaOficial, borrarTasasOficiales } from "./_tasa-oficial.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * IGTF de extremo a extremo (migración 46) — RIGOR MÁXIMO.
 *
 * Lo que este fichero está aquí para demostrar, y que ningún test unitario ve:
 *   1. sin activar NO se percibe, aunque el pago sea en divisas: la percepción
 *      nace de una designación del SENIAT, no de la moneda;
 *   2. activar exige ser sujeto pasivo ESPECIAL, y el acta queda;
 *   3. **el pago MIXTO Bs + Zelle percibe SOLO la porción en divisa** — el
 *      encargo lo pidió explícito, y es la aserción que distingue «percibe por
 *      venta» de «percibe por pago»;
 *   4. la percepción tiene su asiento POSTEADO y cuadrado (Dr caja divisas /
 *      Cr IGTF por enterar), y NO es ingreso;
 *   5. **una factura cobrada no se anula** (ADR-0061): 409 que lleva a la
 *      devolución, y lo percibido no se toca; sin cobros, anular repone la
 *      existencia y su valor exactos;
 *   6. el aviso `/v1/pos/igtf` da la MISMA cifra que luego cobra el servidor:
 *      un preview que difiere del cargo real es peor que no tenerlo;
 *   7. dejar de ser `especial` APAGA la percepción en el mismo acto.
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
const DUENO = crypto.randomUUID();
const CLIENTE = crypto.randomUUID();
const ROL = crypto.randomUUID();
const MEM = crypto.randomUUID();
const ASIG = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const AYER = diaCaracas(-1);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PRODUCTO = "";

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
    Authorization: `Bearer ${await tokenDe(DUENO)}`,
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

/** Emite una factura y la deja lista para cobrar. */
async function facturar(cantidad: string): Promise<Record<string, string>> {
  const f = await pedir("POST", "/v1/invoices", {
    company_id: COMPANY,
    customer_id: CLIENTE,
    warehouse_id: W1,
    lines: [{ product_id: PRODUCTO, quantity: cantidad }],
  });
  expect(f.status).toBe(201);
  return (await f.json()) as Record<string, string>;
}

interface CobroHecho {
  payment: { fx_rate: string };
  igtf: {
    id: string;
    base_amount: string;
    currency: string;
    amount: string;
    functional_amount: string;
  } | null;
  balance: string;
  document_status: string;
}

/**
 * Lo que DEBE valer la percepción de un pago, calculado en Postgres con
 * `numeric` — la regla 7 no tiene excepción para los tests: un `Number` aquí
 * probaría la aritmética de coma flotante, no la del sistema.
 *
 * A dos decimales desde ADR-0053, que son las minor units de USD y de VES, y
 * el funcional desde el importe YA redondeado. El `round()` de Postgres es
 * half-away-from-zero, que sobre importes positivos es el HALF_UP de la
 * política: el oráculo no reusa la función que prueba.
 */
async function percepcionEsperada(
  montoDivisa: string,
  tasa: string,
): Promise<{ enDivisa: string; funcional: string }> {
  const [r] = await sql<{ divisa: string; funcional: string }[]>`
    with igtf as (select round(${montoDivisa}::numeric * 0.03, 2) as monto)
    select round(monto, 8)::text as divisa,
           round(round(monto * ${tasa}::numeric, 2), 8)::text as funcional
      from igtf`;
  return { enDivisa: r!.divisa, funcional: r!.funcional };
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;

  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e igtf')`;
    // Nace ORDINARIO a propósito: el primer test comprueba que activar exige
    // ser especial, y el cambio de clasificación pasa por su endpoint.
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-IGT-${RUN}`}, 'Empresa e2e igtf',
                     'VES', 'ordinario')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-IW1', 'Principal')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, ${`e2eigtf_${RUN}`}, 'Dueño igtf e2e', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.invoice.annul'),
             (${ROL}, 'sales.payment.register'), (${ROL}, 'inventory.move'),
             (${ROL}, 'ar.read'), (${ROL}, 'fiscal.range.manage'),
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.read'), (${ROL}, 'accounting.entry.reverse'),
             (${ROL}, 'fiscal_book.read'), (${ROL}, 'company.settings.manage')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${MEM}, ${TENANT}, ${DUENO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id)
             values (${ASIG}, ${TENANT}, ${MEM}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, ${ASIG}, 'warehouse', ${W1})`;
    await tx`insert into public.customers
               (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                taxpayer_type_code)
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, ${`J-CLI-${RUN}`}, 'Cliente e2e igtf',
                     'juridica', 'ordinario')`;

    const [p] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2EIGT-${RUN}`}, 'Producto gravado', 'good', 'active',
              'unidad', 'gravado_general')
      returning id`;
    PRODUCTO = p!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, ${`e2e-igtf-${RUN}`}, 'VES') returning id`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${l!.id}, ${PRODUCTO}, '1000.00000000', ${AYER}::date)`;
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
                            where company_id is null and jurisdiction = 'VE' and tax_code = 'iva'
                              and taxpayer_type = 'ordinario'
                              and product_tax_category = 'gravado_general'
                              and transaction_type = ${tipo})`;
    }
    // La tasa USD→VES del día: sin ella no hay cobro en divisas que valorar.
    // Es GLOBAL y compartida —otro fichero E2E la reescribe para lo suyo—, así
    // que este fichero no asevera ninguna cifra funcional contra un número
    // fijo: las deriva del `fx_rate` que el propio cobro devuelve. Lo que se
    // prueba es la COHERENCIA (percepción = 3 % del pago, valorada a la tasa
    // de ESE cobro), y eso no depende de cuál sea la tasa del día.
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), 'e2e-igtf'
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = ${HOY}::date)`;

    await tx`insert into public.inventory_moves
               (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
                amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
                functional_currency, rate_source, rate_timestamp, rounding_policy_id,
                occurred_at, reference)
             values (${TENANT}, ${COMPANY}, ${W1}, ${PRODUCTO}, 'entrada', 500, 250000, 'VES',
                     1, 250000, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', now(),
                     ${`e2e-igtf-seed-${RUN}`})`;
  });

  const rango = await pedir("POST", "/v1/fiscal-number-ranges", {
    company_id: COMPANY,
    kind: "invoice",
    series: "A",
    range_from: "1",
    range_to: "500",
    printer_source: "Imprenta E2E igtf",
  });
  if (rango.status !== 201) throw new Error(`rango: ${rango.status} ${await rango.text()}`);
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

describe("IGTF — la activación es una designación, no una moneda", () => {
  it("sin activar, un cobro en divisas NO percibe", async () => {
    const doc = await facturar("1");
    const r = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: doc["id"],
      currency: "USD",
      amount: "5.00",
      instrument: "zelle",
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const cuerpo = (await r.json()) as CobroHecho;
    expect(cuerpo.igtf).toBeNull();
  });

  it("activar exige ser sujeto pasivo ESPECIAL", async () => {
    const r = await pedir("POST", "/v1/igtf/enable", {
      company_id: COMPANY,
      reason: "Designada sujeto pasivo especial según notificación del SENIAT.",
    });
    expect(r.status).toBe(422);
    const cuerpo = (await r.json()) as { message: string };
    expect(cuerpo.message).toContain("ESPECIAL");
  });

  it("clasificada especial, se activa y siembra el catálogo conservador", async () => {
    const clas = await pedir("PUT", "/v1/companies/taxpayer-type", {
      company_id: COMPANY,
      taxpayer_type_code: "especial",
    });
    expect(clas.status).toBe(200);

    const r = await pedir("POST", "/v1/igtf/enable", {
      company_id: COMPANY,
      reason: "Designada sujeto pasivo especial según notificación del SENIAT.",
    });
    expect(r.status).toBe(201);
    const estado = (await r.json()) as {
      enabled: boolean;
      rate: string;
      instruments: { instrument: string; causes: boolean }[];
    };
    expect(estado.enabled).toBe(true);
    expect(estado.rate).toBe("0.03000000");
    const porInstrumento = new Map(estado.instruments.map((i) => [i.instrument, i.causes]));
    expect(porInstrumento.get("zelle")).toBe(true);
    expect(porInstrumento.get("efectivo_usd")).toBe(true);
    // El default conservador de H-8: `otro` NO causa — puede ser un pago en
    // bolívares con otro nombre, y percibir de más es cobrarle al cliente un
    // impuesto que no causó.
    expect(porInstrumento.get("otro")).toBe(false);
    expect(porInstrumento.get("efectivo_bs")).toBe(false);

    // El acta quedó en la auditoría, con la providencia citada.
    const [audit] = await sql<{ payload: Record<string, string> }[]>`
      select payload from public.audit_events
       where company_id = ${COMPANY} and event_type = 'igtf.enabled'`;
    expect(audit!.payload["reason"]).toContain("SENIAT");
    expect(audit!.payload["legal_source"]).toContain("000013");
  });
});

describe("IGTF — la percepción es POR PAGO", () => {
  it("el aviso previo da la misma cifra que luego cobra el servidor", async () => {
    const r = await pedir("GET", "/v1/pos/igtf?amount=10.00&currency=USD&instrument=zelle");
    expect(r.status).toBe(200);
    const aviso = (await r.json()) as { applies: boolean; rate: string; amount: string };
    expect(aviso.applies).toBe(true);
    expect(aviso.rate).toBe("0.03000000");
    // En la MONEDA del pago, así que no depende de la tasa del día.
    expect(aviso.amount).toBe("0.30000000");

    // Y en bolívares (la funcional) no aplica, aunque la empresa esté activa.
    const bs = await pedir("GET", "/v1/pos/igtf?amount=100.00&currency=VES&instrument=efectivo_bs");
    const avisoBs = (await bs.json()) as { applies: boolean; amount: string | null };
    expect(avisoBs.applies).toBe(false);
    expect(avisoBs.amount).toBeNull();
  });

  it("un pago MIXTO Bs + Zelle percibe SOLO sobre la porción en divisa", async () => {
    const doc = await facturar("1");
    expect(doc["total_amount"]).toBe("1160.00000000");

    // LA PORCIÓN EN DIVISA, primero: 10 USD. Causa, y sobre los 10 — no sobre
    // el total de la venta ni sobre lo que se pague después en bolívares.
    const enUsd = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: doc["id"],
      currency: "USD",
      amount: "10.00",
      instrument: "zelle",
    });
    expect(enUsd.status).toBe(201);
    const cobro = (await enUsd.json()) as CobroHecho;
    expect(cobro.igtf).not.toBeNull();
    expect(cobro.igtf!.base_amount).toBe("10.00000000");
    expect(cobro.igtf!.currency).toBe("USD");
    // El 3 % en la moneda del pago es fijo; su funcional se DERIVA de la tasa
    // con la que se valoró ESE cobro, que el propio pago declara.
    const esperado = await percepcionEsperada("10.00", cobro.payment.fx_rate);
    expect(cobro.igtf!.amount).toBe(esperado.enDivisa);
    expect(cobro.igtf!.functional_amount).toBe(esperado.funcional);

    // LA PORCIÓN EN BOLÍVARES, después: el resto exacto, y NO causa.
    const enBs = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: doc["id"],
      currency: "VES",
      amount: cobro.balance,
      instrument: "efectivo_bs",
    });
    expect(enBs.status).toBe(201);
    const resto = (await enBs.json()) as CobroHecho;
    expect(resto.igtf).toBeNull();
    expect(resto.document_status).toBe("paid");

    // El asiento de la percepción: POSTEADO, cuadrado y por el funcional.
    const [asiento] = await sql<{ status: string; debe: string; haber: string }[]>`
      select e.status, sum(l.debit_amount)::text as debe, sum(l.credit_amount)::text as haber
        from public.journal_entries e
        join public.journal_lines l on l.entry_id = e.id
       where e.company_id = ${COMPANY} and e.source_kind = 'igtf_perception'
         and e.source_id = ${cobro.igtf!.id}
       group by e.id, e.status`;
    expect(asiento).toBeDefined();
    expect(asiento!.status).toBe("posted");
    expect(asiento!.debe).toBe(esperado.funcional);
    expect(asiento!.haber).toBe(esperado.funcional);
  });

  it("QUINTO CAMINO (ADR-0060 §4) · el IGTF percibido se debita en la cuenta contable de la caja del pago, no en cash_usd fijo", async () => {
    // Toda percepción asentada de la empresa: su débito es la cuenta contable
    // mapeada a la caja donde entró el pago que la originó.
    const filas = await sql<{ debe: string; esperada: string | null }[]>`
      select l.account_id as debe, ca.ledger_account_id as esperada
        from public.igtf_perceptions ip
        join public.payments p on p.id = ip.payment_id
        join public.company_accounts ca on ca.id = p.account_id
        join public.journal_entries e
          on e.company_id = ip.company_id and e.source_kind = 'igtf_perception'
         and e.source_id = ip.id and e.status = 'posted'
        join public.journal_lines l on l.entry_id = e.id and l.debit_amount > 0
       where ip.company_id = ${COMPANY}`;
    expect(filas.length).toBeGreaterThan(0);
    for (const f of filas) {
      expect(f.esperada).not.toBeNull();
      expect(f.debe).toBe(f.esperada);
    }
  });

  it("las percepciones se listan con el total a enterar", async () => {
    const r = await pedir("GET", `/v1/igtf/perceptions?from=${HOY}&to=${HOY}`);
    expect(r.status).toBe(200);
    const cuerpo = (await r.json()) as {
      items: { status: string; functional_amount: string }[];
      total_functional: string;
      functional_currency: string;
    };
    expect(cuerpo.items.length).toBe(1);
    expect(cuerpo.items[0]!.status).toBe("percibido");
    expect(cuerpo.total_functional).toBe(cuerpo.items[0]!.functional_amount);
    expect(cuerpo.functional_currency).toBe("VES");
  });
});

describe("IGTF — ADR-0053: se percibe lo que la moneda sabe cobrar", () => {
  it("un 3 % que no cae en un céntimo se redondea, y el aviso dice lo MISMO que el cobro", async () => {
    // 35,45 × 3 % = 1,0635 — antes se cobraba así, cuatro decimales de un
    // dólar que nadie puede pagar. 1,06 es lo que la moneda sabe cobrar.
    const r = await pedir("GET", "/v1/pos/igtf?amount=35.45&currency=USD&instrument=zelle");
    expect(r.status).toBe(200);
    const aviso = (await r.json()) as { amount: string };
    expect(aviso.amount).toBe("1.06000000");

    const doc = await facturar("2");
    const pago = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: doc["id"],
      currency: "USD",
      amount: "35.45",
      instrument: "zelle",
    });
    expect(pago.status).toBe(201);
    const cobro = (await pago.json()) as CobroHecho;
    // LA MISMA cifra que enseñó la caja: una sola regla en el dominio.
    expect(cobro.igtf!.amount).toBe(aviso.amount);
    const esperado = await percepcionEsperada("35.45", cobro.payment.fx_rate);
    expect(cobro.igtf!.amount).toBe(esperado.enDivisa);
    expect(cobro.igtf!.functional_amount).toBe(esperado.funcional);

    // Y la fila dice con qué regla se calculó (la spec no admite un
    // functional_amount sin su rounding_policy_id).
    const [fila] = await sql<{ rounding_policy_id: string }[]>`
      select rounding_policy_id from public.igtf_perceptions where id = ${cobro.igtf!.id}`;
    expect(fila!.rounding_policy_id).toBe("igtf:perception:2:HALF_UP");

    // El asiento, cuadrado por el funcional REDONDEADO: lo que entró en caja.
    const [asiento] = await sql<{ debe: string; haber: string }[]>`
      select sum(l.debit_amount)::text as debe, sum(l.credit_amount)::text as haber
        from public.journal_entries e
        join public.journal_lines l on l.entry_id = e.id
       where e.company_id = ${COMPANY} and e.source_kind = 'igtf_perception'
         and e.source_id = ${cobro.igtf!.id}`;
    expect(asiento!.debe).toBe(esperado.funcional);
    expect(asiento!.haber).toBe(esperado.funcional);
  });

  it("en el empate exacto manda HALF_UP (el modo con nombre, VALIDAR-SENIAT)", async () => {
    // 1,50 × 3 % = 0,045: HALF_UP da 0,05; HALF_EVEN daría 0,04. Si alguien
    // cambia el modo sin cambiar la política, este caso lo ve.
    const r = await pedir("GET", "/v1/pos/igtf?amount=1.50&currency=USD&instrument=zelle");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { amount: string }).amount).toBe("0.05000000");
  });
});

describe("LA CAJA (ADR-0059): IGTF dentro de lo recibido, vuelto y formas mezcladas", () => {
  // Una tasa PROPIA de esta empresa (ADR-0057): gana a la de la plataforma que
  // otros ficheros reescriben, y las cifras de la caja dejan de depender de ellos.
  // Producto: 1.000 Bs + IVA 16 % = 1.160 Bs; a 40 Bs/USD son 29,00 USD, y su
  // IGTF 0,87 USD — lo necesario para cerrar en divisa, 29,87.
  const TOTAL = "1160.00000000";
  const venta = (payments: unknown[]) =>
    pedir("POST", "/v1/pos/sales", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
      payments,
    });
  const tender = (payments: unknown[]) =>
    pedir("POST", "/v1/pos/tender", {
      company_id: COMPANY,
      total: TOTAL,
      payments,
      offer: [
        { instrument: "efectivo_bs", currency: "VES" },
        { instrument: "efectivo_usd", currency: "USD" },
        { instrument: "zelle", currency: "USD" },
      ],
    });
  interface Previa {
    complete: boolean;
    remaining_functional: string;
    change: { amount: string; currency: string } | null;
    rows: {
      applied: string | null;
      igtf: string | null;
      change: string | null;
      error: string | null;
    }[];
    suggestions: { instrument: string; amount: string | null; igtf: string | null }[];
  }
  interface Vendida {
    change: { amount: string; currency: string } | null;
    balance: string;
    document_status: string;
    igtf: { functional_amount: string } | null;
    payments: {
      payment: { amount: string; currency: string; instrument: string };
      igtf: { amount: string } | null;
    }[];
  }
  const saldoDe = async (cuenta: string): Promise<string> => {
    const [r] = await sql<{ b: string }[]>`
      select coalesce((select balance from public.company_account_balances
                        where account_id = ${cuenta}), 0)::text as b`;
    return r!.b;
  };

  // La tasa de 40 que estos importes suponen, OFICIAL (solo existe la del BCV: ADR-0064 §1),
  // guardada después de cualquier otra del día para que mande en este bloque.
  beforeAll(async () => {
    await sembrarTasaOficial(sql, { rate: "40", source: "BCV e2e-igtf-caja", rate_date: HOY });
  });
  afterAll(async () => {
    await borrarTasasOficiales(sql, "BCV e2e-igtf-caja");
  });

  it("la vista previa dice cuánto pedir en cada forma: en divisa, IGTF incluido", async () => {
    const r = await tender([]);
    expect(r.status, await r.clone().text()).toBe(200);
    const p = (await r.json()) as Previa;
    const de = (i: string) => p.suggestions.find((s) => s.instrument === i)!;
    expect(de("efectivo_bs").amount).toBe("1160.00000000");
    expect(de("efectivo_bs").igtf).toBeNull();
    expect(de("efectivo_usd").amount).toBe("29.87000000");
    expect(de("efectivo_usd").igtf).toBe("0.87000000");
    expect(p.complete).toBe(false);
  });

  it("50 USD en efectivo: la venta recibe 29, el fisco 0,87 y el vuelto es 20,13 — no 21", async () => {
    const previa = (await (
      await tender([{ instrument: "efectivo_usd", currency: "USD", amount: "50" }])
    ).json()) as Previa;
    expect(previa.complete).toBe(true);
    expect(previa.rows[0]!.applied).toBe("29.00000000");
    expect(previa.rows[0]!.igtf).toBe("0.87000000");
    expect(previa.change).toEqual({ amount: "20.13000000", currency: "USD" });

    const r = await venta([{ instrument: "efectivo_usd", currency: "USD", amount: "50" }]);
    expect(r.status, await r.clone().text()).toBe(201);
    const v = (await r.json()) as Vendida;
    // La venta dice LO MISMO que la vista previa: un solo cálculo.
    expect(v.change).toEqual({ amount: "20.13000000", currency: "USD" });
    expect(v.document_status).toBe("paid");
    expect(v.payments[0]!.payment.amount).toBe("29.00000000");
    expect(v.payments[0]!.igtf!.amount).toBe("0.87000000");
    expect(v.igtf!.functional_amount).toBe("34.80000000");
  });

  it("el IGTF cobrado entra a la caja: el saldo sube 29,87, no 29 (migración 53)", async () => {
    const primera = await venta([{ instrument: "efectivo_usd", currency: "USD", amount: "29.87" }]);
    expect(primera.status, await primera.clone().text()).toBe(201);
    const docPrimera = ((await primera.json()) as { document: { id: string } }).document.id;
    const [pago] = await sql<{ account_id: string | null }[]>`
      select account_id from public.payments where document_id = ${docPrimera} limit 1`;
    // El efectivo cae en una cuenta (la configurada o «Sin asignar»): sin cuenta
    // no habría saldo que mirar, y eso ya sería el defecto.
    expect(pago!.account_id).not.toBeNull();
    const cuenta = pago!.account_id!;
    const antes = await saldoDe(cuenta);
    const r = await venta([{ instrument: "efectivo_usd", currency: "USD", amount: "29.87" }]);
    expect(r.status).toBe(201);
    expect(((await r.json()) as Vendida).change).toBeNull();
    const despues = await saldoDe(cuenta);
    const [d] = await sql<{ delta: string; recomputo: string }[]>`
      select (${despues}::numeric - ${antes}::numeric)::text as delta,
             platform.recompute_account_balance(${cuenta})::text as recomputo`;
    expect(d!.delta).toBe("29.87000000");
    expect(d!.recomputo).toBe(despues);
  });

  it("Zelle exacto con IGTF cierra; Zelle de más se rechaza porque no da vuelto", async () => {
    const exacto = await venta([{ instrument: "zelle", currency: "USD", amount: "29.87" }]);
    expect(exacto.status, await exacto.clone().text()).toBe(201);
    expect(((await exacto.json()) as Vendida).document_status).toBe("paid");

    const demas = await venta([{ instrument: "zelle", currency: "USD", amount: "30.00" }]);
    expect(demas.status).toBe(422);
    const cuerpo = (await demas.json()) as { message: string };
    expect(cuerpo.message).toMatch(/no da vuelto/);
    expect(cuerpo.message).toMatch(/29\.87 USD con IGTF/);
  });

  it("menos de un céntimo por debajo cierra: no existe moneda de medio céntimo", async () => {
    const r = await venta([{ instrument: "zelle", currency: "USD", amount: "29.865" }]);
    expect(r.status, await r.clone().text()).toBe(201);
    expect(((await r.json()) as Vendida).document_status).toBe("paid");
  });

  it("mezclado: 580 Bs por pago móvil y 20 USD en efectivo — IGTF solo sobre la parte en divisa", async () => {
    const pagos = [
      { instrument: "pago_movil", currency: "VES", amount: "580" },
      { instrument: "efectivo_usd", currency: "USD", amount: "20" },
    ];
    const previa = (await (await tender(pagos)).json()) as Previa;
    expect(previa.rows[0]!.igtf).toBeNull();
    expect(previa.rows[1]!.applied).toBe("14.50000000");
    expect(previa.rows[1]!.igtf).toBe("0.44000000");
    expect(previa.change).toEqual({ amount: "5.06000000", currency: "USD" });

    const r = await venta(pagos);
    expect(r.status, await r.clone().text()).toBe(201);
    const v = (await r.json()) as Vendida;
    expect(v.change).toEqual({ amount: "5.06000000", currency: "USD" });
    expect(v.payments.map((p) => p.igtf?.amount ?? null)).toEqual([null, "0.44000000"]);
  });

  it("lo que le falta al segundo pago se sugiere en su moneda, con su IGTF", async () => {
    const previa = (await (
      await tender([{ instrument: "pago_movil", currency: "VES", amount: "580" }])
    ).json()) as Previa;
    expect(previa.remaining_functional).toBe("580.00000000");
    const usd = previa.suggestions.find((s) => s.instrument === "efectivo_usd")!;
    expect(usd.amount).toBe("14.94000000");
    expect(usd.igtf).toBe("0.44000000");
  });

  it("un abono parcial en divisa reparte lo recibido: 10,30 USD son 10 a la deuda y 0,30 de IGTF", async () => {
    const r = await venta([{ instrument: "zelle", currency: "USD", amount: "10.30" }]);
    expect(r.status, await r.clone().text()).toBe(201);
    const v = (await r.json()) as Vendida;
    expect(v.payments[0]!.payment.amount).toBe("10.00000000");
    expect(v.payments[0]!.igtf!.amount).toBe("0.30000000");
    expect(v.document_status).toBe("issued");
    expect(v.balance).toBe("760.00000000");
  });

  it("hasta cuatro formas de pago; la quinta no", async () => {
    const cuatro = [
      { instrument: "efectivo_bs", currency: "VES", amount: "100" },
      { instrument: "pago_movil", currency: "VES", amount: "100" },
      { instrument: "punto_venta", currency: "VES", amount: "100" },
      { instrument: "efectivo_bs", currency: "VES", amount: "860" },
    ];
    const ok4 = await venta(cuatro);
    expect(ok4.status, await ok4.clone().text()).toBe(201);
    expect(((await ok4.json()) as Vendida).document_status).toBe("paid");
    const cinco = await venta([
      ...cuatro,
      { instrument: "efectivo_bs", currency: "VES", amount: "1" },
    ]);
    expect(cinco.status).toBe(422);
  });
});

describe("IGTF — los bordes", () => {
  /*
   * REEMPLAZO AUTORIZADO (dueño, 2026-09-15 · ADR-0061). Aquí vivía «anular
   * DESPUÉS de percibir deja la percepción pendiente de reintegro», que anulaba
   * una factura CON un cobro y esperaba 200. Esa aserción era incorrecta: anular
   * una venta ya cobrada sin tratar el dinero es justo lo que no debe permitirse
   * —el cobro es un hecho de caja que ocurrió, y anular fingía que el dinero
   * nunca entró—. No se ajustó: se reemplazó por los dos tests de abajo.
   */
  it("(a) anular una factura CON cobro aplicado → 409, y el mensaje lleva a la devolución; lo percibido no se toca", async () => {
    const doc = await facturar("2");
    const cobro = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: doc["id"],
      currency: "USD",
      amount: "20.00",
      instrument: "zelle",
    });
    expect(cobro.status).toBe(201);
    const percibido = (await cobro.json()) as CobroHecho;
    expect(percibido.igtf).not.toBeNull();

    const anular = await pedir("POST", `/v1/invoices/${doc["id"]}/annul`, {
      company_id: COMPANY,
      reason: "Error de facturación en la prueba E2E",
    });
    expect(anular.status).toBe(409);
    const cuerpo = (await anular.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("DOCUMENT_HAS_PAYMENTS");
    expect(cuerpo.message).toContain("registra una devolución");

    const [estado] = await sql<{ status: string }[]>`
      select status from public.documents where id = ${doc["id"]!}`;
    expect(estado!.status).toBe("issued");
    const [fila] = await sql<{ status: string }[]>`
      select status from public.igtf_perceptions where id = ${percibido.igtf!.id}`;
    expect(fila!.status).toBe("percibido");
  });

  it("(b) anular una factura SIN cobros → 200, y la existencia y su VALOR vuelven exactamente a los de antes de la venta", async () => {
    const posicion = async (): Promise<{ q: string; v: string }> => {
      const [p] = await sql<{ q: string; v: string }[]>`
        select coalesce(sum(quantity), 0)::text as q, coalesce(sum(value), 0)::text as v
          from public.stock_balances
         where company_id = ${COMPANY} and warehouse_id = ${W1} and product_id = ${PRODUCTO}`;
      return p!;
    };
    const antes = await posicion();
    const doc = await facturar("3");
    const vendida = await posicion();
    // La venta sí sacó mercancía: si no, el test no probaría la reposición.
    const [bajo] = await sql<{ ok: boolean }[]>`
      select ${vendida.q}::numeric = ${antes.q}::numeric - 3
             and ${vendida.v}::numeric < ${antes.v}::numeric as ok`;
    expect(bajo!.ok).toBe(true);

    const anular = await pedir("POST", `/v1/invoices/${doc["id"]}/annul`, {
      company_id: COMPANY,
      reason: "Factura emitida por error, sin cobrar",
    });
    expect(anular.status).toBe(200);
    expect(await posicion()).toEqual(antes);

    const [neto] = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.annulled_stock_gaps(${COMPANY})`;
    expect(neto!.n).toBe(0);
  });

  it("un instrumento que se apaga deja de percibir en el cobro siguiente", async () => {
    const apagar = await pedir("PUT", "/v1/igtf/instruments", {
      company_id: COMPANY,
      instrument: "zelle",
      causes: false,
    });
    expect(apagar.status).toBe(200);

    const doc = await facturar("1");
    const cobro = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: doc["id"],
      currency: "USD",
      amount: "5.00",
      instrument: "zelle",
    });
    expect(cobro.status).toBe(201);
    expect(((await cobro.json()) as CobroHecho).igtf).toBeNull();

    // Se vuelve a encender para no dejar el estado torcido a los que sigan.
    await pedir("PUT", "/v1/igtf/instruments", {
      company_id: COMPANY,
      instrument: "zelle",
      causes: true,
    });
  });

  it("dejar de ser especial APAGA la percepción en el mismo acto", async () => {
    const r = await pedir("PUT", "/v1/companies/taxpayer-type", {
      company_id: COMPANY,
      taxpayer_type_code: "ordinario",
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { igtf_disabled: boolean }).igtf_disabled).toBe(true);

    const estado = await pedir("GET", "/v1/igtf/status");
    expect(((await estado.json()) as { enabled: boolean }).enabled).toBe(false);

    // Y el cobro en divisas vuelve a no percibir: no hay designación.
    const doc = await facturar("1");
    const cobro = await pedir("POST", "/v1/payments", {
      company_id: COMPANY,
      document_id: doc["id"],
      currency: "USD",
      amount: "5.00",
      instrument: "zelle",
    });
    expect(cobro.status).toBe(201);
    expect(((await cobro.json()) as CobroHecho).igtf).toBeNull();
  });
});

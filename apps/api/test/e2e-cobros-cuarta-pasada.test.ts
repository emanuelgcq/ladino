import { describe, expect, it, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { esMarcadorSinRif, formatearDocumento } from "@ladino/schemas";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";
import { fiadoDeFixture, venceDeFixture } from "./_fiado-de-fixture.js";
import { borrarTasasOficiales } from "./_tasa-oficial.js";

/**
 * OLA 4 · COBROS, CUARTA PASADA (ADR-0075; R-84): los casos que la tercera ronda dejó sin test.
 * Fichero propio porque cada uno pide una empresa distinta de las de `e2e-moneda-diferencial`:
 *
 *   a. el pago de más CON IGTF — una empresa sujeto pasivo especial: se rechaza, y el mensaje
 *      habla en la moneda del PAGO;
 *   b. el pago de más con RETENCIÓN — el comprobante de retención que sobra: se rechaza;
 *   c. el marcador `PEND-` — una empresa SIN RIF de verdad (fundada por /v1/onboarding): ni el
 *      comprobante del cobro ni el del reembolso lo imprimen;
 *   d. un saldo a favor usado en MUCHAS partes pequeñas: su pasivo termina en 0,00 exacto.
 *
 * Cada caso asevera el MENSAJE (CLAUDE.md §3: dos caminos pueden dar el mismo `code`) y que no
 * se escribió nada.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";

const DUENO = crypto.randomUUID();
const SIN_RIF = crypto.randomUUID();
const ROL = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const AYER = diaCaracas(-1);
const FUENTE = `e2e-cobros-4-${RUN}`;

interface Empresa {
  tipo: "especial" | "ordinario";
  nombre: string;
  tenant: string;
  company: string;
  w: string;
  cliente: string;
  brocha: string;
  listaBs: string;
  bancoUsd: string;
  bancoBs: string;
}
const nueva = (tipo: Empresa["tipo"], nombre: string): Empresa => ({
  tipo,
  nombre,
  tenant: crypto.randomUUID(),
  company: crypto.randomUUID(),
  w: crypto.randomUUID(),
  cliente: crypto.randomUUID(),
  brocha: "",
  listaBs: "",
  bancoUsd: "",
  bancoBs: "",
});
const SPE = nueva("especial", "Ferretería especial de los cobros");
const ORD = nueva("ordinario", "Ferretería ordinaria de los cobros");

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;

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
  empresa: string | null,
  body?: unknown,
  quien: string = DUENO,
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await tokenDe(quien)}` };
  if (empresa !== null) headers["X-Company-Id"] = empresa;
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

// La tabla de tasas es GLOBAL: cada caso corre con el candado común de los E2E tomado, y bajo él
// pone LA tasa de hoy (como e2e-moneda-diferencial).
let candado: Awaited<ReturnType<ReturnType<typeof createClient>["reserve"]>>;
const tomarCandado = async (): Promise<void> => {
  await candado`select pg_advisory_lock(hashtext('ladino-e2e-rates'))`;
};
const soltarCandado = async (): Promise<void> => {
  await candado`select pg_advisory_unlock_all()`;
};
async function tasa(rate: string): Promise<void> {
  await candado`
    delete from public.exchange_rates
     where company_id is null and from_currency = 'USD' and to_currency = 'VES'
       and rate_date = ${HOY}::date`;
  await candado`
    insert into public.exchange_rates
      (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
    values ('USD', 'VES', ${rate}::numeric, ${FUENTE}, ${HOY}::date, now())`;
}
beforeEach(tomarCandado);
afterEach(soltarCandado);

/** Funda una empresa con RIF: brocha a 2,40 USD (o 1.000 Bs), plan, plantillas, talonario, bancos. */
async function fundar(e: Empresa, salto: number): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${e.tenant}, ${`Tenant ${e.nombre}`})`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name, fiscal_address,
                                           functional_currency_code, taxpayer_type_code)
             values (${e.company}, ${e.tenant}, ${`J${String(Date.now() + salto).slice(-9)}`},
                     ${e.nombre}, 'Av. Lara, Barquisimeto', 'VES', ${e.tipo})`;
    await declararTipoDeFixture(tx, e.company);
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${e.w}, ${e.tenant}, ${e.company}, 'E2E-COB4', 'Local')`;
    const mem = crypto.randomUUID();
    const asig = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${mem}, ${e.tenant}, ${DUENO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${asig}, ${e.tenant}, ${mem}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${e.tenant}, ${e.company}, ${asig}, 'warehouse', ${e.w})`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${e.tenant}, ${e.company}, 'formatos_libres', '2026-01-01'::timestamptz)`;
    await tx`insert into public.customers
               (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                taxpayer_type_code, fiscal_address)
             values (${e.cliente}, ${e.tenant}, ${e.company},
                     ${`J${String(Date.now() + salto + 7).slice(-9)}`},
                     'Constructora e2e cobros 4', 'juridica', 'ordinario', 'Calle 8, Maracay')`;
    await fiadoDeFixture(tx, e.company, [ROL]);
    const [b] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${e.tenant}, ${e.company}, ${`COB4-${e.tipo}-${RUN}`},
              'Brocha (servicio de pintura)', 'service', 'active', 'unidad', 'gravado_general')
      returning id`;
    e.brocha = b!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${e.tenant}, ${e.company}, 'detal', 'USD') returning id`;
    const [lb] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${e.tenant}, ${e.company}, 'detal en bolívares', 'VES') returning id`;
    e.listaBs = lb!.id;
    await tx`insert into public.company_settings (company_id, tenant_id, default_price_list_id)
             values (${e.company}, ${e.tenant}, ${l!.id})`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${e.tenant}, ${e.company}, ${l!.id}, ${e.brocha}, 2.40,
                     now() - interval '1 day'),
                    (${e.tenant}, ${e.company}, ${lb!.id}, ${e.brocha}, 1000,
                     now() - interval '1 day')`;
  });
  const iva = await pedir("POST", "/v1/fiscal/iva-general", e.company, { rate: "0.16" });
  if (iva.status !== 201) throw new Error(`iva: ${iva.status} ${await iva.text()}`);
  for (const [ruta, cuerpo] of [
    ["/v1/accounts/import-template", { company_id: e.company, template_code: "ve_basico" }],
    ["/v1/journal-templates/import-preset", { company_id: e.company, preset_code: "ve_basico" }],
  ] as const) {
    const r = await pedir("POST", ruta, e.company, cuerpo);
    if (r.status !== 201) throw new Error(`${ruta}: ${r.status} ${await r.text()}`);
  }
  const rango = await pedir("POST", "/v1/fiscal-number-ranges", e.company, {
    company_id: e.company,
    kind: "invoice",
    series: "A",
    range_from: "1",
    range_to: "500",
    printer_source: "Imprenta E2E cobros 4",
    printer_legal_name: "Imprenta E2E, C.A.",
    printer_tax_id: "J-12345678-9",
    printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
    printer_authorization_date: "2020-01-15",
    printed_on: "2026-01-01",
  });
  if (rango.status !== 201) throw new Error(`rango: ${rango.status} ${await rango.text()}`);
  for (const moneda of ["USD", "VES"] as const) {
    const r = await pedir("POST", "/v1/treasury/accounts", e.company, {
      company_id: e.company,
      name: `Banco ${moneda} cobros 4 ${RUN}`,
      currency: moneda,
      kind: "bank",
    });
    if (r.status !== 201) throw new Error(`cuenta: ${r.status} ${await r.text()}`);
    const id = ((await r.json()) as { id: string }).id;
    if (moneda === "USD") e.bancoUsd = id;
    else e.bancoBs = id;
  }
}

/** Factura de N brochas (2,40 USD c/u, o 1.000 Bs en la lista en bolívares). */
async function facturar(e: Empresa, cantidad: string, lista?: string): Promise<string> {
  const r = await pedir("POST", "/v1/invoices", e.company, {
    company_id: e.company,
    customer_id: e.cliente,
    warehouse_id: e.w,
    series: "A",
    ...(lista === undefined ? {} : { price_list_id: lista }),
    lines: [{ product_id: e.brocha, quantity: cantidad }],
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

interface Cobro {
  payment: Record<string, string>;
  document_status: string;
  customer_credit?: { id: string } | null;
}
async function cobrar(e: Empresa, doc: string, cuerpo: Record<string, string>): Promise<Cobro> {
  const r = await pedir("POST", "/v1/payments", e.company, {
    company_id: e.company,
    document_id: doc,
    ...cuerpo,
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return (await r.json()) as Cobro;
}

/** Lo que una empresa tiene escrito de cobros: para aseverar «nada escrito» comparando antes y después. */
async function huella(e: Empresa): Promise<Record<string, string | number>> {
  const [f] = await sql<Record<string, string | number>[]>`
    select (select count(*)::int from public.payments where company_id = ${e.company}) as cobros,
           (select count(*)::int from public.customer_credits
             where company_id = ${e.company}) as saldos_a_favor,
           (select count(*)::int from public.supported_retention_receipts
             where company_id = ${e.company}) as retenciones,
           (select count(*)::int from public.journal_entries
             where company_id = ${e.company}) as asientos,
           (select count(*)::int from public.documents where company_id = ${e.company}) as documentos,
           (select coalesce(sum(balance), 0)::text from public.company_account_balances
             where account_id in (${e.bancoUsd}, ${e.bancoBs})) as saldo_de_bancos`;
  return { ...f! };
}
const saldoDe = async (e: Empresa, doc: string): Promise<string> => {
  const [b] = await sql<{ s: string }[]>`
    select platform.document_balance(${e.company}, ${doc})::text as s`;
  return b!.s;
};

/** Infla los streams del PDF y decodifica los <hex> de los TJ (como en e2e-fiscal-legal). */
async function textoDelPdf(r: Response): Promise<string> {
  const bruto = Buffer.from(await r.arrayBuffer());
  const { inflateSync } = await import("node:zlib");
  let texto = "";
  let i = 0;
  for (;;) {
    const s = bruto.indexOf("stream", i);
    if (s === -1) break;
    let inicio = s + 6;
    if (bruto[inicio] === 0x0d) inicio++;
    if (bruto[inicio] === 0x0a) inicio++;
    const fin = bruto.indexOf("endstream", inicio);
    if (fin === -1) break;
    const trozo = bruto.subarray(inicio, fin);
    try {
      texto += inflateSync(trozo).toString("latin1");
    } catch {
      texto += trozo.toString("latin1");
    }
    i = fin + 9;
  }
  return [...texto.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map((m) => Buffer.from(m[1]!, "hex").toString("latin1"))
    .join("");
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  await sql`insert into auth.users (id, email) values (${SIN_RIF}, ${`cobros4-${RUN}@e2e.ladino`})
            on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2ecobros4_${RUN}`}, 'Dueño cobros 4', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.payment.register'),
             (${ROL}, 'ar.read'), (${ROL}, 'treasury.read'),
             (${ROL}, 'treasury.account.manage'), (${ROL}, 'inventory.move'),
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.entry.post'), (${ROL}, 'accounting.read'),
             (${ROL}, 'fiscal.range.manage'), (${ROL}, 'sales.price_list.override'),
             (${ROL}, 'ar.retention.register'), (${ROL}, 'ar.payment.reverse'),
             (${ROL}, 'tax.rules.manage'), (${ROL}, 'sales.refund')
             on conflict do nothing`;
  });
  candado = await sql.reserve();
  await tomarCandado();
  await tasa("854.46370000");
  await fundar(SPE, 311);
  await fundar(ORD, 331);
  await soltarCandado();
});

afterAll(async () => {
  await borrarTasasOficiales(sql, FUENTE);
  candado?.release();
  await sql?.end();
  await sqlApi?.end();
});

describe("ola 4 · cobros, cuarta pasada: el pago de más que NO se acepta, el papel sin RIF y el saldo a favor en muchas partes", () => {
  it("a · pago de más CON IGTF: un especial que recibe en divisa más de lo debido responde 422 con el mensaje del vuelto, en la moneda del PAGO, y no escribe nada", async () => {
    await tasa("854.46370000");
    // Factura en USD (2,78) y factura en BOLÍVARES (1.160,00 = 1,36 USD a 854,4637). El IGTF es
    // el 3 %: cerrar la primera pide 2,86 USD entregados; la segunda, 1,40.
    const enUsd = await facturar(SPE, "1");
    const enBs = await facturar(SPE, "1", SPE.listaBs);
    const antes = await huella(SPE);

    // TRES CAMINOS rechazan un pago de más que causa IGTF, y los tres responden el MISMO
    // `VALIDATION_FAILED/422`: solo el mensaje dice cuál habló (CLAUDE.md §3). Todos hablan en la
    // moneda del PAGO —dólares—, también cuando la factura es en bolívares.
    //   · por omisión, `amount` es lo ENTREGADO con el IGTF dentro (F-05): lo reparte
    //     `pasoDeCobro`. Una forma sin vuelto (Zelle) pide ajustar el importe; el efectivo dice
    //     cuánto vuelto entregar;
    //   · con `igtf_included: false` (el importe es lo que ABONA; así llama la caja), el sobrante
    //     llega al tope del cobro y lo rechaza la regla F-10 + IGTF: no nace un anticipo.
    const intentos: [string, Record<string, unknown>, string][] = [
      [
        enUsd,
        { amount: "5.00000000", instrument: "zelle" },
        "Lo recibido (5.00 USD) supera lo que falta (2.86 USD con IGTF) y esta forma de pago no da vuelto. Ajusta el monto.",
      ],
      [
        enUsd,
        { amount: "5.00000000", instrument: "efectivo_usd" },
        "Lo recibido supera lo que falta con IGTF: sobran 2.14 USD. Registra lo que queda en caja y entrega el vuelto.",
      ],
      [
        enUsd,
        { amount: "5.00000000", instrument: "zelle", igtf_included: false },
        "Lo recibido supera lo que falta y este pago causa IGTF: sobran 2.22 USD. Registra lo que queda y entrega el vuelto.",
      ],
      [
        enBs,
        { amount: "2.00000000", instrument: "zelle" },
        "Lo recibido (2.00 USD) supera lo que falta (1.40 USD con IGTF) y esta forma de pago no da vuelto. Ajusta el monto.",
      ],
      // Entran 1.708,93 Bs y sobran 548,93 Bs: el mensaje los dice en DÓLARES (0,64), que es lo
      // que el cliente puso sobre el mostrador.
      [
        enBs,
        { amount: "2.00000000", instrument: "zelle", igtf_included: false },
        "Lo recibido supera lo que falta y este pago causa IGTF: sobran 0.64 USD. Registra lo que queda y entrega el vuelto.",
      ],
    ];
    for (const [doc, cuerpo, mensaje] of intentos) {
      const r = await pedir("POST", "/v1/payments", SPE.company, {
        company_id: SPE.company,
        document_id: doc,
        currency: "USD",
        account_id: SPE.bancoUsd,
        ...cuerpo,
      });
      expect(r.status, await r.clone().text()).toBe(422);
      const e = (await r.json()) as { code: string; message: string };
      expect(e.code).toBe("VALIDATION_FAILED");
      expect(e.message).toBe(mensaje);
    }

    // Nada escrito: ni cobro, ni saldo a favor, ni percepción, ni asiento, ni nota de débito.
    expect(await huella(SPE)).toEqual(antes);
    const [igtf] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.igtf_perceptions where company_id = ${SPE.company}`;
    expect(igtf!.n).toBe(0);
    expect(await saldoDe(SPE, enUsd)).toBe("2378.82000000");
    expect(await saldoDe(SPE, enBs)).toBe("1160.00000000");

    // LA VARIANTE QUE DISTINGUE EL CAMINO: el MISMO pago de más, por una forma que no causa IGTF
    // (transferencia en Bs), sí se acepta y deja su saldo a favor. Lo que rechazó arriba fue la
    // regla del IGTF, no el tope del cobro.
    const sinIgtf = await cobrar(SPE, enBs, {
      currency: "VES",
      amount: "1500.00000000",
      instrument: "transferencia",
      account_id: SPE.bancoBs,
    });
    expect(sinIgtf.document_status).toBe("paid");
    expect(sinIgtf.customer_credit?.id).toBeTruthy();
  });

  it("b · pago de más con RETENCIÓN: un comprobante de retención mayor que lo pendiente se rechaza con su mensaje y no escribe nada", async () => {
    await tasa("854.46370000");
    const doc = await facturar(ORD, "4"); // 11,14 USD · 9.515,31 Bs · IVA 1.312,46
    await cobrar(ORD, doc, {
      currency: "USD",
      amount: "9.99000000", // quedan 1,15 USD por cobrar
      instrument: "zelle",
      account_id: ORD.bancoUsd,
    });
    const antes = await huella(ORD);
    const saldoAntes = await saldoDe(ORD, doc);

    // El cliente retiene el 100 % del IVA (1.312,46 Bs = 1,54 USD a la tasa de la factura): más
    // de lo que la factura todavía debe.
    const r = await pedir("POST", "/v1/fiscal-declarations/supported-retentions", ORD.company, {
      company_id: ORD.company,
      customer_id: ORD.cliente,
      document_id: doc,
      receipt_number: `${HOY.slice(0, 4)}${HOY.slice(5, 7)}00004001`,
      retained_on: HOY,
      base: "1312.46",
      rate: "1",
      amount: "1312.46",
    });
    expect(r.status, await r.clone().text()).toBe(422);
    const e = (await r.json()) as { code: string; message: string };
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(e.message).toBe(
      "El abono supera lo pendiente: quedan 1.15 USD por cobrar. Ajusta el importe.",
    );

    // Nada escrito: ni el comprobante, ni su cobro, ni un saldo a favor, ni un asiento.
    expect(await huella(ORD)).toEqual(antes);
    expect(await saldoDe(ORD, doc)).toBe(saldoAntes);

    // LA VARIANTE QUE DISTINGUE EL CAMINO: el mismo comprobante al 75 % (984,35 Bs = 1,15 USD)
    // cabe en lo pendiente, se acepta y cierra la factura. Lo rechazado fue el sobrante.
    const justo = await pedir("POST", "/v1/fiscal-declarations/supported-retentions", ORD.company, {
      company_id: ORD.company,
      customer_id: ORD.cliente,
      document_id: doc,
      receipt_number: `${HOY.slice(0, 4)}${HOY.slice(5, 7)}00004001`,
      retained_on: HOY,
      base: "1312.46",
      rate: "0.75",
      amount: "984.35",
    });
    expect(justo.status, await justo.clone().text()).toBe(201);
    const cuerpo = (await justo.json()) as { payment: { document_status: string } };
    expect(cuerpo.payment.document_status).toBe("paid");
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.customer_credits where company_id = ${ORD.company}`;
    expect(n!.n).toBe(0);
  });

  it("d · un saldo a favor de 2,22 USD usado en siete partes de 0,30 y una de 0,12: ningún uso baja un importe negativo, el pasivo termina en 0,00 exacto y customer_credit_ledger_gap da cero filas", async () => {
    await tasa("854.46370000");
    const origen = await facturar(ORD, "1"); // 2,78 USD
    const pago = await cobrar(ORD, origen, {
      currency: "USD",
      amount: "5.00000000",
      instrument: "zelle",
      account_id: ORD.bancoUsd,
    });
    const credito = pago.customer_credit!.id;
    const [nace] = await sql<{ amount: string; currency: string; funcional: string }[]>`
      select amount::text as amount, currency, functional_amount::text as funcional
        from public.customer_credits where id = ${credito}`;
    // 2,22 USD × 854,4637 = 1.896,91 Bs: lo que el pasivo carga al nacer.
    expect(nace).toEqual({ amount: "2.22000000", currency: "USD", funcional: "1896.91000000" });

    const destino = await facturar(ORD, "4"); // 11,14 USD: ningún uso la cierra
    const partes = [...Array<string>(7).fill("0.30000000"), "0.12000000"];
    const usos: string[] = [];
    for (const parte of partes) {
      const uso = await cobrar(ORD, destino, {
        currency: "USD",
        amount: parte,
        instrument: "saldo_a_favor",
        customer_credit_id: credito,
      });
      usos.push(uso.payment["id"]!);
    }

    // Lo que cada uso bajó del pasivo, en orden.
    const bajas = await sql<{ debe: string; haber: string }[]>`
      select l.functional_debit::text as debe, l.functional_credit::text as haber
        from public.payments p
        join public.journal_entries e
          on e.company_id = p.company_id and e.source_id = p.id and e.status = 'posted'
        join public.journal_lines l on l.entry_id = e.id
       where p.id = any(${usos}::uuid[])
         and l.account_id in (select s.account_id from public.company_account_settings s
                               where s.company_id = ${ORD.company}
                                 and s.purpose = 'customer_credit_liability')
       order by p.created_at, p.id`;
    expect(bajas).toHaveLength(8);
    // Ningún uso baja un importe negativo ni nulo, y ninguno ABONA el pasivo.
    for (const b of bajas) {
      expect(Number(b.debe)).toBeGreaterThan(0);
      expect(b.haber).toBe("0.00000000");
    }
    // 0,30 × 1.896,91 ÷ 2,22 = 256,34 cada uno de los siete; el que AGOTA se lleva el resto
    // exacto (1.896,91 − 7 × 256,34 = 102,53), no su parte proporcional (102,54).
    expect(bajas.map((b) => b.debe)).toEqual([
      ...Array<string>(7).fill("256.34000000"),
      "102.53000000",
    ]);

    const [fin] = await sql<{ status: string; applied: string }[]>`
      select status, applied_amount::text as applied from public.customer_credits
       where id = ${credito}`;
    expect(fin).toEqual({ status: "applied", applied: "2.22000000" });

    // El pasivo de ESE saldo en el mayor: lo que nació − lo que bajaron sus usos = 0,00 exacto.
    const [pasivo] = await sql<{ v: string }[]>`
      select coalesce(sum(l.functional_credit - l.functional_debit), 0)::text as v
        from public.journal_entries e
        join public.journal_lines l on l.entry_id = e.id
       where e.company_id = ${ORD.company} and e.status = 'posted'
         and l.account_id in (select s.account_id from public.company_account_settings s
                               where s.company_id = ${ORD.company}
                                 and s.purpose = 'customer_credit_liability')
         and (e.source_id = ${pago.payment["id"]!} or e.source_id = any(${usos}::uuid[]))`;
    expect(pasivo!.v).toBe("0.00000000");

    const brecha = await sql`select * from platform.customer_credit_ledger_gap(${ORD.company})`;
    expect(brecha).toEqual([]);
  });

  it("c · el marcador PEND-: una empresa SIN RIF cobra con sobrante y reembolsa, y ninguno de los dos comprobantes imprime «PEND-» ni un renglón de RIF del emisor", async () => {
    await tasa("854.46370000");
    const pedirSinRif = (metodo: string, path: string, empresa: string | null, body?: unknown) =>
      pedir(metodo, path, empresa, body, SIN_RIF);
    const alta = await pedirSinRif("POST", "/v1/onboarding", null, {
      business_name: `Abasto de la vecina ${RUN}`,
    });
    expect(alta.status, await alta.clone().text()).toBe(201);
    const fundado = (await alta.json()) as { company_id: string; warehouse_id: string };
    const EMPRESA = fundado.company_id;

    // La precondición, sin la cual el caso no probaría nada: el RIF guardado ES el marcador.
    const [emp] = await sql<{ tax_id: string; legal_name: string }[]>`
      select tax_id, legal_name from public.companies where id = ${EMPRESA}`;
    expect(emp!.tax_id.startsWith("PEND-")).toBe(true);
    expect(esMarcadorSinRif(emp!.tax_id)).toBe(true);

    const prod = await pedirSinRif("POST", "/v1/products/simple", EMPRESA, {
      company_id: EMPRESA,
      name: "Harina precocida",
      price: { amount: "2", currency: "USD" },
      initial_stock: { quantity: "10", unit_cost: { amount: "40", currency: "VES" } },
    });
    expect(prod.status, await prod.clone().text()).toBe(201);
    const PRODUCTO = ((await prod.json()) as { product: { id: string } }).product.id;
    const [lista] = await sql<{ id: string }[]>`
      select l.id from public.price_lists l
        join public.price_list_items i on i.price_list_id = l.id
       where l.company_id = ${EMPRESA} and i.product_id = ${PRODUCTO}`;
    const aj = await pedirSinRif("PUT", "/v1/company-settings", EMPRESA, {
      default_price_list_id: lista!.id,
    });
    expect(aj.status, await aj.clone().text()).toBe(200);

    const cli = await pedirSinRif("POST", "/v1/customers", EMPRESA, {
      company_id: EMPRESA,
      tax_id: `V${String(Date.now() + 41).slice(-8)}`,
      legal_name: `Vecina que fía ${RUN}`,
      person_type_code: "natural",
      fiscal_address: "Av. Lara con calle 8, Barquisimeto",
    });
    expect(cli.status, await cli.clone().text()).toBe(201);
    const CLIENTE = ((await cli.json()) as { id: string }).id;
    const lim = await pedirSinRif("PUT", `/v1/customers/${CLIENTE}/credit-limit`, EMPRESA, {
      company_id: EMPRESA,
      credit_limit_usd: "100",
    });
    expect(lim.status, await lim.clone().text()).toBe(200);

    // Un recibo FIADO (2,00 USD), que después se cobra de más.
    const v = await pedirSinRif("POST", "/v1/pos/sales", EMPRESA, {
      company_id: EMPRESA,
      warehouse_id: fundado.warehouse_id,
      customer_id: CLIENTE,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
      due_date: venceDeFixture(),
    });
    expect(v.status, await v.clone().text()).toBe(201);
    const venta = (await v.json()) as { document: { id: string; kind: string } };
    expect(venta.document.kind).toBe("receipt");

    // Una caja en bolívares propia: una empresa recién fundada que solo ha fiado no tiene aún
    // ninguna cuenta de dinero.
    const cta = await pedirSinRif("POST", "/v1/treasury/accounts", EMPRESA, {
      company_id: EMPRESA,
      name: `Caja Bs ${RUN}`,
      currency: "VES",
      kind: "cash",
    });
    expect(cta.status, await cta.clone().text()).toBe(201);
    const caja = (await cta.json()) as { id: string };
    const p = await pedirSinRif("POST", "/v1/payments", EMPRESA, {
      company_id: EMPRESA,
      document_id: venta.document.id,
      currency: "VES",
      amount: "2500.00000000", // debe 2,00 USD = 1.708,93 Bs: sobran 791,07 Bs
      instrument: "efectivo_bs",
      account_id: caja.id,
    });
    expect(p.status, await p.clone().text()).toBe(201);
    const pago = (await p.json()) as Cobro;
    expect(pago.document_status).toBe("paid");
    expect(pago.customer_credit?.id).toBeTruthy();

    const re = await pedirSinRif(
      "POST",
      `/v1/customer-credits/${pago.customer_credit!.id}/refunds`,
      EMPRESA,
      {
        company_id: EMPRESA,
        account_id: caja.id,
        whole: true,
        reason: "La vecina pidió su vuelto",
      },
    );
    expect(re.status, await re.clone().text()).toBe(201);
    const reembolso = (await re.json()) as { id: string };

    for (const [ruta, titulo] of [
      [`/v1/payments/${pago.payment["id"]!}/pdf`, "COMPROBANTE DE COBRO"],
      [`/v1/customer-refunds/${reembolso.id}/pdf`, "COMPROBANTE DE REEMBOLSO"],
    ] as const) {
      const pdf = await pedirSinRif("GET", ruta, EMPRESA);
      expect(pdf.status, await pdf.clone().text()).toBe(200);
      expect(pdf.headers.get("content-type")).toBe("application/pdf");
      const texto = await textoDelPdf(pdf);
      // El papel es el de ESTA empresa (no un PDF vacío ni el de otra)…
      expect(texto).toContain(titulo);
      expect(texto).toContain(emp!.legal_name);
      // …y no lleva el marcador ni renglón alguno de RIF del emisor.
      expect(texto, ruta).not.toContain("PEND-");
      expect(texto, ruta).not.toContain("RIF");
    }

    // LA VARIANTE ROTA, hasta donde es honesta. `componer` (receipts-pdf.ts) no es exportable y
    // la guarda no se puede apagar desde un test; lo que sí se demuestra es que la guarda es LO
    // ÚNICO entre el marcador y el papel:
    //  1. el renglón que se imprimiría sin ella es `RIF ${formatearDocumento(tax_id)}`, y esa
    //     expresión, con el RIF guardado de esta empresa, TRAE el marcador;
    const sinGuarda = `RIF ${formatearDocumento(emp!.tax_id)}`;
    expect(sinGuarda).toContain("PEND-");
    //  2. y el renglón existe de verdad en el mismo papel cuando la empresa SÍ tiene RIF: el
    //     comprobante de un cobro de la empresa ordinaria lo lleva.
    const [conRif] = await sql<{ id: string; tax_id: string }[]>`
      select p.id, c.tax_id from public.payments p
        join public.companies c on c.id = p.company_id
       where p.company_id = ${ORD.company} and p.instrument = 'zelle' limit 1`;
    const papel = await textoDelPdf(
      await pedir("GET", `/v1/payments/${conRif!.id}/pdf`, ORD.company),
    );
    expect(papel).toContain(`RIF ${formatearDocumento(conRif!.tax_id)}`);
  });

  it("y los invariantes que cruzan siguen en cero en las dos empresas con contabilidad", async () => {
    for (const e of [SPE, ORD]) {
      const [n] = await sql<Record<string, number>[]>`
        select (select count(*)::int from platform.accounting_coverage_gaps(${e.company})) as cobertura,
               (select count(*)::int from platform.settled_ledger_gaps(${e.company})) as saldados,
               (select count(*)::int from platform.treasury_ledger_gaps(${e.company})) as tesoreria,
               (select count(*)::int from platform.treasury_currency_gaps(${e.company})) as divisa,
               (select count(*)::int from platform.cent_gaps(${e.company})) as centimo,
               (select count(*)::int from platform.customer_credit_ledger_gap(${e.company}))
                 as saldo_a_favor`;
      expect({ ...n }, e.nombre).toEqual({
        cobertura: 0,
        saldados: 0,
        tesoreria: 0,
        divisa: 0,
        centimo: 0,
        saldo_a_favor: 0,
      });
    }
  });
});

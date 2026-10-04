import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * EL FIADO TIENE VENCIMIENTO (recorrido 2026-09-24: P-05, E-22; migración 20261004210000).
 *
 * Cada caso asevera lo que SOLO produce su camino (el mensaje, y el dato en la base):
 *   · la caja que fía SIN fecha: 422 «Di cuándo paga el cliente», y NINGÚN documento;
 *   · con una fecha anterior al día de la venta: 422, y ningún documento;
 *   · con fecha: 201, el documento la lleva y después no se puede cambiar (LAD06);
 *   · la factura de administración SIN fecha entra (vence el día de su emisión);
 *   · la cotización de la caja avisa de que hará falta la fecha;
 *   · la lista de clientes por lo VENCIDO: encabeza el que tiene deuda vencida, aunque otro
 *     deba más; sin `ar.read`, 403; un `sort` desconocido, 422;
 *   · el papel: la venta con saldo dice «A CRÉDITO», «Saldo pendiente» y «Vence»; la pagada no,
 *     y la factura sobre la forma libre (`destino=papel`) tampoco.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";

const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const AYER = diaCaracas(-1);
const EN_QUINCE = diaCaracas(15);
const FUENTE_TASA = `BCV e2e-vence-${RUN}`;
const FUENTE_REGLA = "Carga de prueba E2E — VALIDAR-SENIAT antes de producción.";

const FUNDADOR = crypto.randomUUID();
const CAJERO = crypto.randomUUID();
const SIN_CXC = crypto.randomUUID();
const ROL_SIN_CXC = crypto.randomUUID();
const KEY_SIN_CXC = `e2evence_sincxc_${RUN}`;
const FUNDADOR_SIN_RIF = crypto.randomUUID();

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let COMPANY = "";
let DEPOSITO = "";
let PRODUCTO = "";
let TOTAL_USD = "";
/** Debe mucho y está al día · debe poco y está vencido · no debe. */
let GRANDE = "";
let VENCIDO = "";
let SIN_DEUDA = "";
let FIADA = "";
let PAGADA = "";

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

type Fallo = { code: string; message: string; details?: Record<string, unknown> };

/** Vende por la caja; sin `pago` la venta entera queda fiada. `vence` es el `due_date`. */
function vender(cliente: string, cantidad: string, vence?: string, pago?: string) {
  return pedir("POST", "/v1/pos/sales", CAJERO, {
    company_id: COMPANY,
    warehouse_id: DEPOSITO,
    customer_id: cliente,
    lines: [{ product_id: PRODUCTO, quantity: cantidad }],
    ...(vence === undefined ? {} : { due_date: vence }),
    ...(pago === undefined
      ? {}
      : { payments: [{ instrument: "efectivo_usd", currency: "USD", amount: pago }] }),
  });
}

async function documentosDe(cliente: string, company: string = COMPANY): Promise<number> {
  const [f] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.documents
     where company_id = ${company} and customer_id = ${cliente}`;
  return f!.n;
}

async function clienteCon(nombre: string, limite: string | null, salto: number): Promise<string> {
  const alta = await pedir("POST", "/v1/customers", FUNDADOR, {
    company_id: COMPANY,
    tax_id: `V${String(Date.now() + salto).slice(-8)}`,
    legal_name: `${nombre} ${RUN}`,
    person_type_code: "natural",
    fiscal_address: "Av. Lara con calle 8, Barquisimeto",
  });
  expect(alta.status).toBe(201);
  const id = ((await alta.json()) as { id: string }).id;
  if (limite !== null) {
    const l = await pedir("PUT", `/v1/customers/${id}/credit-limit`, FUNDADOR, {
      company_id: COMPANY,
      credit_limit_usd: limite,
    });
    expect(l.status).toBe(200);
  }
  return id;
}

/** El texto del PDF (la técnica de e2e-checklist-factura: infla los streams, decodifica WinAnsi). */
async function textoDelPdf(r: Response): Promise<string> {
  expect(r.status).toBe(200);
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
  const win = new TextDecoder("windows-1252");
  return [...texto.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map((m) => win.decode(Buffer.from(m[1]!, "hex")))
    .join("")
    .replace(/\s+/g, "");
}
const ddmmaaaa = (iso: string): string =>
  `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id, email) values
            (${FUNDADOR}, ${`fundador-vence-${RUN}@e2e.ladino`}),
            (${CAJERO}, ${`cajero-vence-${RUN}@e2e.ladino`}),
            (${SIN_CXC}, ${`sincxc-vence-${RUN}@e2e.ladino`}),
            (${FUNDADOR_SIN_RIF}, ${`sinrif-vence-${RUN}@e2e.ladino`})
            on conflict (id) do nothing`;
  // Vende y administra clientes, pero NO lee lo que deben (sin `ar.read`).
  await sql`insert into public.roles (id, tenant_id, key, name, requires_scope)
            values (${ROL_SIN_CXC}, null, ${KEY_SIN_CXC}, 'Vende sin ver deudas', false)`;
  await sql`insert into public.role_permissions (role_id, permission_key) values
            (${ROL_SIN_CXC}, 'sales.invoice.issue'), (${ROL_SIN_CXC}, 'customer.manage')`;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    // Hoy y AYER: la factura vencida se emite con fecha de ayer.
    for (const dia of [AYER, HOY]) {
      await tx`
        insert into public.exchange_rates
          (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
        select 'USD', 'VES', 40, ${dia}::date, now(), ${FUENTE_TASA}
         where not exists (select 1 from public.exchange_rates
                            where company_id is null and from_currency = 'USD'
                              and to_currency = 'VES' and rate_date = ${dia}::date)`;
    }
  });
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
  if (sql) {
    await sql`delete from public.exchange_rates where company_id is null and source = ${FUENTE_TASA}`;
  }
  await sql?.end();
  await sqlApi?.end();
});

describe("el fiado tiene vencimiento", { timeout: 60_000 }, () => {
  it("el fundador funda, factura sobre forma libre, carga un producto y suma a su gente", async () => {
    const r = await pedir("POST", "/v1/onboarding", FUNDADOR, {
      business_name: `Bodega Vence ${RUN}`,
      tax_id: `J-76${RUN.slice(-6)
        .replace(/[^0-9]/g, "4")
        .padStart(6, "4")}-1`,
      legal_name: `Bodega Vence ${RUN}, C.A.`,
      fiscal_address: "Calle 20 con carrera 21, Barquisimeto, Lara",
      taxpayer: { taxpayer_type_code: "ordinario" },
    });
    expect(r.status).toBe(201);
    const f = (await r.json()) as { company_id: string; warehouse_id: string };
    COMPANY = f.company_id;
    DEPOSITO = f.warehouse_id;

    expect(
      (await pedir("POST", "/v1/fiscal/regime", FUNDADOR, { regime_code: "formatos_libres" }))
        .status,
    ).toBe(201);
    const rango = await pedir("POST", "/v1/fiscal-number-ranges", FUNDADOR, {
      company_id: COMPANY,
      kind: "invoice",
      series: "A",
      range_from: "1",
      range_to: "100",
      printer_source: "Imprenta E2E vence, autorización de prueba",
      printer_legal_name: "Imprenta E2E, C.A.",
      printer_tax_id: "J-12345678-9",
      printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
      printer_authorization_date: "2020-01-15",
      printed_on: "2026-09-01",
      alert_threshold_pct: 50,
    });
    expect(rango.status).toBe(201);

    const p = await pedir("POST", "/v1/products/simple", FUNDADOR, {
      company_id: COMPANY,
      name: `Producto vence ${RUN}`,
      price: { amount: "5", currency: "USD" },
      initial_stock: { quantity: "40", unit_cost: { amount: "120", currency: "VES" } },
    });
    expect(p.status).toBe(201);
    PRODUCTO = ((await p.json()) as { product: { id: string } }).product.id;

    for (const correo of [`cajero-vence-${RUN}@e2e.ladino`, `sincxc-vence-${RUN}@e2e.ladino`]) {
      const m = await pedir("POST", "/v1/members", FUNDADOR, {
        company_id: COMPANY,
        email: correo,
        role_key: "cashier",
      });
      expect(m.status).toBe(201);
    }
    const cambiado = await sql`
      update public.user_role_assignments a set role_id = ${ROL_SIN_CXC}
        from public.memberships m
       where m.id = a.membership_id and m.user_id = ${SIN_CXC}
      returning a.id`;
    expect(cambiado).toHaveLength(1);

    const cot = await pedir("POST", "/v1/pos/quote", FUNDADOR, {
      company_id: COMPANY,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
    });
    expect(cot.status).toBe(200);
    const q = (await cot.json()) as { total: string; credit_due_date: unknown };
    TOTAL_USD = q.total;
    // La venta de mostrador no se fía: no hay vencimiento que pedir.
    expect(q.credit_due_date).toBeNull();

    GRANDE = await clienteCon("Debe mucho y al día", "1000", 1);
    VENCIDO = await clienteCon("Debe poco y vencido", "100", 2);
    SIN_DEUDA = await clienteCon("No debe", "100", 3);
  });

  it("D2 · fiar por la caja SIN fecha: 422 «Di cuándo paga el cliente», y ningún documento", async () => {
    const r = await vender(GRANDE, "1");
    expect(r.status).toBe(422);
    const cuerpo = (await r.json()) as Fallo;
    expect(cuerpo.code).toBe("VALIDATION_FAILED");
    expect(cuerpo.message).toMatch(/Di cuándo paga el cliente/);
    expect(cuerpo.details?.["reason"]).toBe("due_date_required");
    // La transacción entera se deshizo: ni factura, ni número gastado.
    expect(await documentosDe(GRANDE)).toBe(0);

    // El pago parcial que deja saldo también es fiado, y también la pide.
    const parcial = await vender(GRANDE, "1", undefined, "1");
    expect(parcial.status).toBe(422);
    expect(((await parcial.json()) as Fallo).details?.["reason"]).toBe("due_date_required");
    expect(await documentosDe(GRANDE)).toBe(0);
    const [cobros] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.payments p
        join public.documents d on d.id = p.document_id
       where d.company_id = ${COMPANY} and d.customer_id = ${GRANDE}`;
    expect(cobros!.n).toBe(0);
  });

  it("una fecha anterior al día de la venta: 422, y ningún documento", async () => {
    const r = await vender(GRANDE, "1", AYER);
    expect(r.status).toBe(422);
    const cuerpo = (await r.json()) as Fallo;
    expect(cuerpo.message).toMatch(/no puede ser anterior al día de la venta/);
    expect(cuerpo.details?.["reason"]).toBe("due_date_before_sale");
    expect(await documentosDe(GRANDE)).toBe(0);

    // Un día que no existe en el calendario tampoco entra (ni la forma equivocada).
    const imposible = await vender(GRANDE, "1", `${HOY.slice(0, 4)}-02-31`);
    expect(imposible.status).toBe(422);
    const malFormada = await vender(GRANDE, "1", "15/10/2026");
    expect(malFormada.status).toBe(422);
    expect(await documentosDe(GRANDE)).toBe(0);
  });

  it("con fecha: 201, el documento la lleva, y después no se puede cambiar", async () => {
    const r = await vender(GRANDE, "3", EN_QUINCE);
    expect(r.status).toBe(201);
    const v = (await r.json()) as {
      document: { id: string; due_date: string | null };
      document_status: string;
    };
    expect(v.document_status).toBe("issued");
    expect(v.document.due_date).toBe(EN_QUINCE);
    FIADA = v.document.id;
    const [fila] = await sql<{ d: string }[]>`
      select due_date::text as d from public.documents where id = ${FIADA}`;
    expect(fila!.d).toBe(EN_QUINCE);

    // Congelada: ni siquiera el dueño de la base la mueve (trigger, LAD06).
    let codigo = "";
    try {
      await sql`update public.documents set due_date = ${diaCaracas(60)}::date where id = ${FIADA}`;
    } catch (e) {
      codigo = (e as { code?: string }).code ?? "";
    }
    expect(codigo).toBe("LAD06");
    try {
      codigo = "";
      await sql`update public.documents set due_date = null where id = ${FIADA}`;
    } catch (e) {
      codigo = (e as { code?: string }).code ?? "";
    }
    expect(codigo).toBe("LAD06");
    const [intacta] = await sql<{ d: string }[]>`
      select due_date::text as d from public.documents where id = ${FIADA}`;
    expect(intacta!.d).toBe(EN_QUINCE);

    // El detalle la sirve igual.
    const det = (await (await pedir("GET", `/v1/documents/${FIADA}`, FUNDADOR)).json()) as {
      document: { due_date: string | null };
    };
    expect(det.document.due_date).toBe(EN_QUINCE);
  });

  it("la venta que queda PAGADA no necesita fecha", async () => {
    const r = await vender(SIN_DEUDA, "1", undefined, TOTAL_USD);
    expect(r.status).toBe(201);
    const v = (await r.json()) as {
      document: { id: string; due_date: string | null };
      document_status: string;
    };
    expect(v.document_status).toBe("paid");
    expect(v.document.due_date).toBeNull();
    PAGADA = v.document.id;
  });

  it("la caja lo sabe ANTES: la cotización dice que fiar exige la fecha y desde qué día", async () => {
    const cot = await pedir("POST", "/v1/pos/quote", CAJERO, {
      company_id: COMPANY,
      customer_id: GRANDE,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
    });
    expect(cot.status).toBe(200);
    const q = (await cot.json()) as { credit_due_date: { required: boolean; min: string } | null };
    expect(q.credit_due_date).toEqual({ required: true, min: HOY });
  });

  it("D3 · la factura de administración SIN fecha entra y vence el día de su emisión", async () => {
    const r = await pedir("POST", "/v1/invoices", FUNDADOR, {
      company_id: COMPANY,
      customer_id: VENCIDO,
      warehouse_id: DEPOSITO,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
    });
    expect(r.status).toBe(201);
    const doc = (await r.json()) as { id: string; due_date: string | null; status: string };
    expect(doc.status).toBe("issued");
    expect(doc.due_date).toBeNull();

    // Emitida HOY y sin plazo: vence hoy, y hoy todavía NO está vencida (vencido = día anterior a hoy).
    type Cuenta = {
      documents: { id: string; due_date: string | null; overdue: boolean }[];
      total_outstanding: string | null;
      aging: { overdue: string | null; overdue_reason: string | null; total: string | null };
    };
    const hoy = (await (
      await pedir("GET", `/v1/customers/${VENCIDO}/statement`, FUNDADOR)
    ).json()) as Cuenta;
    expect(hoy.documents[0]!.due_date).toBe(HOY);
    expect(hoy.documents[0]!.overdue).toBe(false);
    expect(hoy.aging.overdue).toBe("0.00");

    // MONTAJE: la factura «se emitió ayer». Una empresa fundada hoy no puede fechar ayer por la
    // API (ni régimen, ni precio, ni existencia a esa fecha), y un documento emitido no se edita:
    // se envejece POR DEBAJO, en una transacción con los triggers apagados solo para ella
    // (`session_replication_role`, sin candado sobre la tabla). Es una ENTRADA, no una cifra.
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update public.documents set issued_at = issued_at - interval '1 day'
                where id = ${doc.id}`;
    });

    // Con fecha anterior al día del documento: 422, y no queda una segunda factura.
    const mal = await pedir("POST", "/v1/invoices", FUNDADOR, {
      company_id: COMPANY,
      customer_id: VENCIDO,
      warehouse_id: DEPOSITO,
      lines: [{ product_id: PRODUCTO, quantity: "1" }],
      due_date: AYER,
    });
    expect(mal.status).toBe(422);
    expect(((await mal.json()) as Fallo).details?.["reason"]).toBe("due_date_before_sale");
    expect(await documentosDe(VENCIDO)).toBe(1);

    // El estado de cuenta dice cuándo vence cada documento y si ya venció.
    const ec = (await (
      await pedir("GET", `/v1/customers/${VENCIDO}/statement`, FUNDADOR)
    ).json()) as Cuenta;
    expect(ec.documents).toHaveLength(1);
    expect(ec.documents[0]!.due_date).toBe(AYER);
    expect(ec.documents[0]!.overdue).toBe(true);
    // Todo lo que debe está vencido: lo vencido ES su deuda (la misma función).
    expect(ec.aging.overdue_reason).toBeNull();
    expect(ec.aging.overdue).toBe(ec.total_outstanding);

    const alDia = (await (
      await pedir("GET", `/v1/customers/${GRANDE}/statement`, FUNDADOR)
    ).json()) as {
      documents: { id: string; due_date: string | null; overdue: boolean }[];
      aging: { overdue: string | null };
    };
    expect(alDia.documents[0]!.due_date).toBe(EN_QUINCE);
    expect(alDia.documents[0]!.overdue).toBe(false);
    expect(alDia.aging.overdue).toBe("0.00");
  });

  it("P-05 · la lista por lo VENCIDO: encabeza el vencido aunque otro deba más", async () => {
    type Fila = {
      id: string;
      debt: string | null;
      overdue: string | null;
      overdue_reason: string | null;
    };
    const lista = async (orden: string): Promise<Fila[]> => {
      const r = await pedir(
        "GET",
        `/v1/customers?with_debt=1&exclude_system=1&per_page=100&sort=${orden}`,
        FUNDADOR,
      );
      expect(r.status).toBe(200);
      return ((await r.json()) as { items: Fila[] }).items;
    };

    const porVencido = await lista("overdue_desc");
    expect(porVencido).toHaveLength(3);
    expect(porVencido[0]!.id).toBe(VENCIDO);
    // Después, a igual vencido (cero), por deuda: el que debe y está al día; al final, el que no debe.
    expect(porVencido[1]!.id).toBe(GRANDE);
    expect(porVencido[2]!.id).toBe(SIN_DEUDA);

    const vencido = porVencido[0]!;
    const grande = porVencido[1]!;
    const sinDeuda = porVencido[2]!;
    // Lo vencido del vencido es toda su deuda; el que está al día debe y no tiene nada vencido.
    expect(vencido.overdue).toBe(vencido.debt);
    expect(vencido.overdue_reason).toBeNull();
    expect(grande.overdue).toBe("0.00");
    expect(sinDeuda.overdue).toBe("0.00");
    expect(sinDeuda.debt).toBe("0.00");
    const [mayor] = await sql<{ ok: boolean }[]>`
      select ${grande.debt}::numeric > ${vencido.debt}::numeric
             and ${vencido.debt}::numeric > 0 as ok`;
    expect(mayor!.ok).toBe(true);

    // Por deuda TOTAL el orden es otro: encabeza el que más debe. Los dos órdenes existen.
    const porDeuda = await lista("debt_desc");
    expect(porDeuda[0]!.id).toBe(GRANDE);
    expect(porDeuda[1]!.id).toBe(VENCIDO);

    const ascendente = await lista("overdue_asc");
    expect(ascendente[2]!.id).toBe(VENCIDO);
  });

  it("P-05 · sin `ar.read`, 403; un orden desconocido o sin pedir la deuda, 422", async () => {
    const sinPermiso = await pedir("GET", "/v1/customers?with_debt=1&sort=overdue_desc", SIN_CXC);
    expect(sinPermiso.status).toBe(403);
    const cuerpo = (await sinPermiso.json()) as Fallo;
    expect(cuerpo.code).toBe("PERMISSION_REQUIRED");
    expect(cuerpo.message).toMatch(/ar\.read/);

    const desconocido = await pedir("GET", "/v1/customers?with_debt=1&sort=vencido", FUNDADOR);
    expect(desconocido.status).toBe(422);
    expect(((await desconocido.json()) as Fallo).message).toMatch(/overdue_desc/);

    const sinDeuda = await pedir("GET", "/v1/customers?sort=overdue_desc", FUNDADOR);
    expect(sinDeuda.status).toBe(422);
  });

  it("E-22 · el papel de la factura con saldo dice A CRÉDITO, el saldo y cuándo vence; la pagada no", async () => {
    const cortesia = await textoDelPdf(await pedir("GET", `/v1/documents/${FIADA}/pdf`, FUNDADOR));
    expect(cortesia).toContain("ACRÉDITO");
    // 3 × 5,80 USD: la deuda se debe en la moneda del documento.
    expect(cortesia).toContain("Saldopendiente:USD17,40");
    expect(cortesia).toContain(`Vence:${ddmmaaaa(EN_QUINCE)}`);

    // Sobre la forma libre NO se añaden renglones (art. 33: el tope de filas está medido).
    const papel = await textoDelPdf(
      await pedir("GET", `/v1/documents/${FIADA}/pdf?destino=papel`, FUNDADOR),
    );
    expect(papel).not.toContain("ACRÉDITO");
    expect(papel).not.toContain("Saldopendiente");

    const pagada = await textoDelPdf(await pedir("GET", `/v1/documents/${PAGADA}/pdf`, FUNDADOR));
    expect(pagada).not.toContain("ACRÉDITO");
    expect(pagada).not.toContain("Saldopendiente");
    expect(pagada).not.toContain("Vence:");
  });

  it("E-22 · el RECIBO de una venta fiada (empresa sin RIF) lo dice; el recibo pagado no", async () => {
    const alta = await pedir(
      "POST",
      "/v1/onboarding",
      FUNDADOR_SIN_RIF,
      { business_name: `Abasto vence ${RUN}` },
      "",
    );
    expect(alta.status).toBe(201);
    const f = (await alta.json()) as { company_id: string; warehouse_id: string };
    const p = await pedir(
      "POST",
      "/v1/products/simple",
      FUNDADOR_SIN_RIF,
      {
        company_id: f.company_id,
        name: `Harina ${RUN}`,
        price: { amount: "2", currency: "USD" },
        initial_stock: { quantity: "20", unit_cost: { amount: "40", currency: "VES" } },
      },
      f.company_id,
    );
    expect(p.status).toBe(201);
    const producto = ((await p.json()) as { product: { id: string } }).product.id;
    const c = await pedir(
      "POST",
      "/v1/customers",
      FUNDADOR_SIN_RIF,
      {
        company_id: f.company_id,
        tax_id: `V${String(Date.now() + 9).slice(-8)}`,
        legal_name: `Vecina ${RUN}`,
        person_type_code: "natural",
      },
      f.company_id,
    );
    expect(c.status).toBe(201);
    const vecina = ((await c.json()) as { id: string }).id;
    expect(
      (
        await pedir(
          "PUT",
          `/v1/customers/${vecina}/credit-limit`,
          FUNDADOR_SIN_RIF,
          { company_id: f.company_id, credit_limit_usd: "50" },
          f.company_id,
        )
      ).status,
    ).toBe(200);

    const venta = (cuerpo: Record<string, unknown>) =>
      pedir(
        "POST",
        "/v1/pos/sales",
        FUNDADOR_SIN_RIF,
        {
          company_id: f.company_id,
          warehouse_id: f.warehouse_id,
          customer_id: vecina,
          lines: [{ product_id: producto, quantity: "2" }],
          ...cuerpo,
        },
        f.company_id,
      );

    // También el recibo exige la fecha.
    const sinFecha = await venta({});
    expect(sinFecha.status).toBe(422);
    expect(((await sinFecha.json()) as Fallo).details?.["reason"]).toBe("due_date_required");
    expect(await documentosDe(vecina, f.company_id)).toBe(0);

    const fiado = await venta({ due_date: EN_QUINCE });
    expect(fiado.status).toBe(201);
    const recibo = (await fiado.json()) as { document: { id: string; kind: string } };
    expect(recibo.document.kind).toBe("receipt");
    const texto = await textoDelPdf(
      await pedir(
        "GET",
        `/v1/documents/${recibo.document.id}/pdf`,
        FUNDADOR_SIN_RIF,
        undefined,
        f.company_id,
      ),
    );
    expect(texto).toContain("ACRÉDITO");
    expect(texto).toContain("Saldopendiente:USD4,00");
    expect(texto).toContain(`Vence:${ddmmaaaa(EN_QUINCE)}`);

    const contado = await venta({
      payments: [{ instrument: "efectivo_usd", currency: "USD", amount: "4" }],
    });
    expect(contado.status).toBe(201);
    const pagado = (await contado.json()) as { document: { id: string } };
    const textoPagado = await textoDelPdf(
      await pedir(
        "GET",
        `/v1/documents/${pagado.document.id}/pdf`,
        FUNDADOR_SIN_RIF,
        undefined,
        f.company_id,
      ),
    );
    expect(textoPagado).not.toContain("ACRÉDITO");
    expect(textoPagado).not.toContain("Saldopendiente");
  });
});

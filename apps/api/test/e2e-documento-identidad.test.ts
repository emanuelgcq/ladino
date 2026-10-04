import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * EL DOCUMENTO DE IDENTIDAD, de punta a punta (recorrido 2026-09-24: M-05, A-08, O-04, P-02,
 * A-17; regla del dueño del 2026-09-28):
 *
 *  - la estructura del RIF bloquea con 422 legible; el dígito verificador (módulo 11 del
 *    SENIAT) NO bloquea: se acepta y queda en la auditoría;
 *  - todo camino guarda el documento NORMALIZADO (`V123456789`) y la búsqueda encuentra con
 *    cualquier grafía;
 *  - la corrección del RIF rechaza el marcador `PEND-…` (A-17);
 *  - el PDF imprime el RIF de persona natural como RIF (`V-12345678-9`), no como cédula (M-05).
 *
 * Asevera el MENSAJE, no solo el 422: la estructura, el marcador y el domicilio fiscal
 * producen el mismo código por caminos distintos.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const DUENA = crypto.randomUUID();
const RUN = Date.now().toString(36);
/** El RIF del dueño: persona natural, V de 9 dígitos. Su dígito no cuadra (el SENIAT da 1). */
const RIF_V = "V-12345678-9";

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let COMPANY = "";
let TENANT = "";

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
  const headers: Record<string, string> = { Authorization: `Bearer ${await tokenDe(DUENA)}` };
  if (COMPANY !== "") headers["X-Company-Id"] = COMPANY;
  if (metodo !== "GET" && path !== "/v1/onboarding") {
    headers["Idempotency-Key"] = crypto.randomUUID();
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(path, {
    method: metodo,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

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
  await sql`insert into auth.users (id, email) values
            (${DUENA}, ${`doc-${RUN}@e2e.ladino`}) on conflict (id) do nothing`;
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("el RIF de la empresa", () => {
  it("un RIF sin estructura no funda la empresa: 422 con el mensaje de la forma", async () => {
    const r = await pedir("POST", "/v1/onboarding", {
      business_name: `Mal RIF ${RUN}`,
      tax_id: "J-1",
      legal_name: `Mal RIF ${RUN}, C.A.`,
      fiscal_address: "Calle 1, Valencia, Carabobo",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain(
      "una letra (V, E, J, G, P o C) y nueve dígitos",
    );
  });

  it("con el dígito que no cuadra SÍ funda, lo guarda normalizado y registra la excepción", async () => {
    const r = await pedir("POST", "/v1/onboarding", {
      business_name: `Doc Identidad ${RUN}`,
      tax_id: RIF_V,
      legal_name: `María Pérez ${RUN}`,
      fiscal_address: "Av. Lara, local 3, Barquisimeto, Lara",
    });
    expect(r.status).toBe(201);
    const f = (await r.json()) as { tenant_id: string; company_id: string };
    COMPANY = f.company_id;
    TENANT = f.tenant_id;
    const [c] = await sql<{ tax_id: string }[]>`
      select tax_id from public.companies where id = ${COMPANY}`;
    expect(c!.tax_id).toBe("V123456789");
    const [acta] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from public.audit_events
       where company_id = ${COMPANY} and event_type = 'company.tax_id_check_digit_mismatch'`;
    expect(acta?.payload).toMatchObject({
      tax_id: "V123456789",
      check_digit_ok: false,
      digito_recibido: 9,
      digito_esperado: 1,
    });
    // La fundación importa el plan de cuentas: con el equipo ocupado pasa de los 5 s por omisión.
  }, 30_000);

  it("A-17: la corrección del RIF rechaza el marcador PEND- con su propio mensaje", async () => {
    const r = await pedir("POST", "/v1/companies/tax-id/correct", {
      tax_id: "PEND-X",
      reason: "Probar que el marcador no es un RIF",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain(
      "«PEND-…» es la marca de una empresa que todavía no tiene RIF",
    );
    const poner = await pedir("PUT", "/v1/companies/tax-id", { tax_id: "PEND-X" });
    expect(poner.status).toBe(422);
    const [c] = await sql<{ tax_id: string }[]>`
      select tax_id from public.companies where id = ${COMPANY}`;
    expect(c!.tax_id).toBe("V123456789");
  });

  it("la corrección con algo que no es un RIF también es 422, y con un RIF válido lo normaliza", async () => {
    const malo = await pedir("PUT", "/v1/companies/tax-id", { tax_id: "12345678" });
    expect(malo.status).toBe(422);
    expect(((await malo.json()) as { message: string }).message).toContain("nueve dígitos");
    // G-20000303-0: el RIF de referencia del algoritmo, dígito correcto → sin acta de excepción.
    const bueno = await pedir("PUT", "/v1/companies/tax-id", { tax_id: "g-20000303-0" });
    expect(bueno.status).toBe(200);
    expect(((await bueno.json()) as { tax_id: string }).tax_id).toBe("G200003030");
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where company_id = ${COMPANY} and event_type = 'company.tax_id_check_digit_mismatch'`;
    expect(n!.n).toBe(1);
    // Y se vuelve al V del dueño para el PDF de abajo.
    expect((await pedir("PUT", "/v1/companies/tax-id", { tax_id: RIF_V })).status).toBe(200);
  });
});

describe("clientes y proveedores (P-02)", () => {
  let CLIENTE = "";

  it("el alta de la administración guarda el RIF normalizado, y buscar sin guiones lo encuentra", async () => {
    const r = await pedir("POST", "/v1/customers", {
      company_id: COMPANY,
      tax_id: "J-40888777-6",
      legal_name: `Bodegón Mayorista Los Andes ${RUN}`,
      fiscal_address: "Av. Los Andes, Mérida",
    });
    expect(r.status).toBe(201);
    const c = (await r.json()) as { id: string; tax_id: string };
    CLIENTE = c.id;
    expect(c.tax_id).toBe("J408887776");

    for (const grafia of ["J40888777", "J-40888777", "j-40888777-6"]) {
      const b = await pedir("GET", `/v1/customers?search=${encodeURIComponent(grafia)}`);
      const pagina = (await b.json()) as { items: { id: string }[] };
      expect(
        pagina.items.map((x) => x.id),
        `buscar «${grafia}»`,
      ).toContain(CLIENTE);
    }
  });

  it("la cédula del mostrador se guarda normalizada; un documento sin forma es 422", async () => {
    const r = await pedir("POST", "/v1/customers", {
      company_id: COMPANY,
      tax_id: "V-18.222.333",
      legal_name: `Cliente de mostrador ${RUN}`,
    });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { tax_id: string }).tax_id).toBe("V18222333");

    const malo = await pedir("POST", "/v1/customers", {
      company_id: COMPANY,
      tax_id: "J-1",
      legal_name: `Cliente sin forma ${RUN}`,
    });
    expect(malo.status).toBe(422);
    expect(((await malo.json()) as { message: string }).message).toContain(
      "un RIF (V, E, J, G, P o C y nueve dígitos",
    );
  });

  it("el proveedor nacional exige un RIF con forma; el que tiene el dígito mal entra con acta", async () => {
    const malo = await pedir("POST", "/v1/suppliers", {
      company_id: COMPANY,
      tax_id: "V-18222333",
      legal_name: `Proveedor con cédula ${RUN}`,
      supplier_kind: "nacional",
    });
    expect(malo.status).toBe(422);
    expect(((await malo.json()) as { message: string }).message).toContain("nueve dígitos");

    const bueno = await pedir("POST", "/v1/suppliers", {
      company_id: COMPANY,
      tax_id: "J-40555123-4",
      legal_name: `Proveedor del escenario ${RUN}`,
      supplier_kind: "nacional",
    });
    expect(bueno.status).toBe(201);
    const p = (await bueno.json()) as { id: string; tax_id: string };
    expect(p.tax_id).toBe("J405551234");
    const [acta] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from public.audit_events
       where aggregate_id = ${p.id} and event_type = 'supplier.tax_id_check_digit_mismatch'`;
    expect(acta?.payload).toMatchObject({ digito_recibido: 4, digito_esperado: 2 });
  });
});

describe("el PDF (M-05)", () => {
  it("el membrete imprime el RIF V de 9 dígitos como RIF, no como cédula", async () => {
    const REGIMEN = crypto.randomUUID();
    const DOC = crypto.randomUUID();
    await sql`insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
              values (${REGIMEN}, ${TENANT}, ${COMPANY}, 'formatos_libres', '2026-01-01')`;
    // Desde 20260928190000 (ADR-0072) emitir exige el tipo de contribuyente declarado vigente.
    await sql`insert into public.company_taxpayer_types
                (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason,
                 rules_version)
              values (${TENANT}, ${COMPANY}, 'ordinario', '2026-01-01', null,
                      'Fixture e2e documento de identidad', 'domain-s0.5')`;
    // PA 00071 art. 13.7 (P-57, migración 20260928190400): sobre forma libre la factura lleva al
    // adquirente identificado; el «Consumidor final» de sistema es solo para recibos.
    const [cf] = await sql<{ id: string }[]>`
      insert into public.customers (tenant_id, company_id, tax_id, legal_name, person_type_code,
                                    taxpayer_type_code)
      values (${TENANT}, ${COMPANY}, 'V12345678', 'Cliente identificado', 'natural',
              'consumidor_final')
      returning id`;
    await sql`insert into public.documents
        (id, tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
         control_number, regime_version_id, rules_version,
         issuer_name_snapshot, issuer_tax_id_snapshot, issuer_address_snapshot,
         transaction_currency, functional_currency, fx_rate, rate_source,
         amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
      values (${DOC}, ${TENANT}, ${COMPANY}, 'invoice', 'A', ${cf!.id}, 'issued', now(), 1,
              1, ${REGIMEN}, 'e2e-documento',
              ${`María Pérez ${RUN}`}, 'V123456789', 'Av. Lara, local 3, Barquisimeto, Lara',
              'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116)`;
    const r = await pedir("GET", `/v1/documents/${DOC}/pdf`);
    expect(r.status).toBe(200);
    const texto = await textoDelPdf(r);
    expect(texto).toContain("RIF: V-12345678-9");
    expect(texto).not.toContain("V-123.456.789");
  });
});

/**
 * Segunda ronda (revisión del coordinador, 2026-09-28). Cada caso asevera lo que SOLO produce
 * el camino que dice probar: el mensaje, el acta, o la ausencia de escritura.
 */
describe("revisión: marcador, pasaporte, mismo documento y actas", () => {
  async function actas(evento: string, agregado: string): Promise<number> {
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where aggregate_id = ${agregado} and event_type = ${evento}`;
    return n!.n;
  }

  it("hallazgo 2: POST /v1/companies no guarda un marcador tecleado, en ninguna caja", async () => {
    for (const marcador of ["pend-x", "PEND-X", "PEND-0123456789"]) {
      const r = await pedir("POST", "/v1/companies", {
        tenant_id: TENANT,
        legal_name: `Marcador ${marcador} ${RUN}`,
        tax_id: marcador,
      });
      expect(r.status, marcador).toBe(422);
      expect(((await r.json()) as { message: string }).message).toContain(
        "«PEND-…» es la marca de una empresa que todavía no tiene RIF",
      );
    }
  });

  it("hallazgo 8: el PUT del RIF con «PEND-X» es 422 con el mensaje del marcador", async () => {
    const r = await pedir("PUT", "/v1/companies/tax-id", { tax_id: "PEND-X" });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain(
      "«PEND-…» es la marca de una empresa que todavía no tiene RIF",
    );
  });

  it("hallazgo 5: poner el MISMO RIF con otra grafía es ok y no escribe ni acta ni outbox", async () => {
    // El dato viejo, anterior a la reparación P-02: guardado CON guiones (por SQL, como la base
    // de producción antes de normalizar). La empresa ya tiene una factura emitida: si el caso de
    // uso no lo reconociera como el mismo documento, el cambio sería un 422 de «nivel 2».
    await sql`update public.companies set tax_id = 'V-12345678-9' where id = ${COMPANY}`;
    const [antes] = await sql<{ a: number; o: number }[]>`
      select (select count(*)::int from public.audit_events where aggregate_id = ${COMPANY}) as a,
             (select count(*)::int from public.outbox where aggregate_id = ${COMPANY}) as o`;
    const r = await pedir("PUT", "/v1/companies/tax-id", { tax_id: "v123456789" });
    expect(r.status).toBe(200);
    const [despues] = await sql<{ a: number; o: number }[]>`
      select (select count(*)::int from public.audit_events where aggregate_id = ${COMPANY}) as a,
             (select count(*)::int from public.outbox where aggregate_id = ${COMPANY}) as o`;
    expect(despues).toEqual(antes);
    await sql`update public.companies set tax_id = 'V123456789' where id = ${COMPANY}`;
  });

  it("hallazgo 8: cambiarRif con un dígito que no cuadra deja su acta", async () => {
    const antes = await actas("company.tax_id_check_digit_mismatch", COMPANY);
    // Con la factura emitida, el camino es la corrección con motivo (nivel 3).
    const motivo = "Comprobar el acta del dígito verificador";
    const r = await pedir("POST", "/v1/companies/tax-id/correct", {
      tax_id: "J-40555123-4",
      reason: motivo,
    });
    expect(r.status).toBe(200);
    expect(await actas("company.tax_id_check_digit_mismatch", COMPANY)).toBe(antes + 1);
    const vuelta = await pedir("POST", "/v1/companies/tax-id/correct", {
      tax_id: RIF_V,
      reason: motivo,
    });
    expect(vuelta.status).toBe(200);
  });

  it("hallazgo 8 y 5: el cliente deja el acta del dígito al alta y al cambio; el mismo documento no escribe", async () => {
    const r = await pedir("POST", "/v1/customers", {
      company_id: COMPANY,
      tax_id: "J-40555123-4",
      legal_name: `Cliente dígito ${RUN}`,
      fiscal_address: "Calle 4, Mérida",
    });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as { id: string }).id;
    expect(await actas("customer.tax_id_check_digit_mismatch", id)).toBe(1);

    // J-41234567: el SENIAT calcula 2; el 1 no cuadra.
    const cambio = await pedir("PUT", `/v1/customers/${id}/tax-id`, {
      company_id: COMPANY,
      tax_id: "J-41234567-1",
    });
    expect(cambio.status).toBe(200);
    expect(await actas("customer.tax_id_check_digit_mismatch", id)).toBe(2);

    // El dato viejo con guiones (anterior a la reparación), y el mismo documento sin ellos.
    await sql`update public.customers set tax_id = 'J-41234567-1' where id = ${id}`;
    const cambiosAntes = await actas("customer.tax_id_changed", id);

    const [o] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.outbox where aggregate_id = ${id}`;
    const mismo = await pedir("PUT", `/v1/customers/${id}/tax-id`, {
      company_id: COMPANY,
      tax_id: "J412345671",
    });
    expect(mismo.status).toBe(200);
    const [o2] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.outbox where aggregate_id = ${id}`;
    expect(o2!.n).toBe(o!.n);
    expect(await actas("customer.tax_id_changed", id)).toBe(cambiosAntes);
  });

  it("hallazgo 8: la importación CSV también deja el acta del dígito", async () => {
    const dig = String(Date.now()).slice(-7);
    const base = `J7${dig}`;
    const csv =
      "RIF o cédula;Nombre o razón social;Teléfono;Correo;Dirección\r\n" +
      // Un dígito que seguro no cuadra: el correcto más uno, módulo 10.
      `${base}X;"Importado dígito ${RUN}";;;"Zona Sur, galpón 9"\r\n`;
    const { digitoVerificadorRif } = await import("@ladino/schemas");
    const malo = (Number(digitoVerificadorRif(base)) + 1) % 10;
    const form = new FormData();
    form.append(
      "file",
      new File([csv.replace(`${base}X`, `${base}${malo}`)], "clientes.csv", { type: "text/csv" }),
    );
    const r = await app.request("/v1/customers/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${await tokenDe(DUENA)}`, "X-Company-Id": COMPANY },
      body: form,
    });
    expect(r.status).toBe(201);
    const res = (await r.json()) as { rows: { customer_id?: string }[] };
    const id = res.rows[0]!.customer_id!;
    expect(await actas("customer.tax_id_check_digit_mismatch", id)).toBe(1);
  });

  it("0 (a): el cliente con pasaporte se registra y se guarda «P» + mayúsculas sin separadores", async () => {
    const r = await pedir("POST", "/v1/customers", {
      company_id: COMPANY,
      tax_id: "P-ab 123.4567",
      legal_name: `John Smith ${RUN}`,
    });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { tax_id: string }).tax_id).toBe("PAB1234567");
    // P + 9 dígitos es RIF P, no pasaporte: y un P de 4 caracteres no es nada.
    const corto = await pedir("POST", "/v1/customers", {
      company_id: COMPANY,
      tax_id: "P-123",
      legal_name: `Pasaporte corto ${RUN}`,
    });
    expect(corto.status).toBe(422);
  });

  it("0 (b): la búsqueda de proveedores encuentra con cualquier grafía", async () => {
    for (const grafia of ["J40555123", "J-40555123-4"]) {
      const b = await pedir("GET", `/v1/suppliers?search=${encodeURIComponent(grafia)}`);
      expect(b.status).toBe(200);
      const pagina = (await b.json()) as { items: { tax_id: string }[] };
      expect(
        pagina.items.map((x) => x.tax_id),
        grafia,
      ).toContain("J405551234");
    }
  });
});

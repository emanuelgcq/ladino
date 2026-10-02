import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * LAS ALÍCUOTAS SON UN CATÁLOGO CON FUENTE (ADR-0073), de punta a punta:
 *
 *   · B-02: aceptar la general desde el catálogo — el 0 % y lo que cae fuera de 8–16,5 % se
 *     rechazan con el mensaje de la base; aceptar OTRA tasa se aplica (antes: acta nueva, regla
 *     vieja);
 *   · B-11: la puesta a punto trae la referencia del catálogo con su cita, para que la web no
 *     escriba «hoy 16 %»;
 *   · B-04: una factura con líneas al 16 %, al 8 % y exentas se emite (antes: 409);
 *   · E-04 / E-10 (FC-08, FC-10, FC-11, FC-31): el PDF discrimina base e IVA por alícuota con su
 *     porcentaje, marca «(E)» y sus columnas van sin IVA, con subtotal = suma de la columna;
 *   · L-08: el libro de ventas separa por alícuota y trae el resumen del art. 72 del RLIVA;
 *   · la declaración suma por alícuota.
 *
 * Empresa propia: ninguna regla de plataforma sembrada a mano. Todo lo que resuelve sale de la
 * aceptación y del catálogo.
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
const ROL_GERENTE = crypto.randomUUID();
const CLIENTE = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
const PROD: Record<"general" | "reducida" | "exento", string> = {
  general: "",
  reducida: "",
  exento: "",
};
let DOC = "";

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
    Authorization: `Bearer ${await tokenDe(GERENTE)}`,
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
  await sql`insert into auth.users (id) values (${GERENTE}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${GERENTE}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e alícuotas')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-E2EALI-${RUN}`}, 'Alícuotas Tres, C.A.',
                     'VES', 'ordinario')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-AW1', 'Principal')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL_GERENTE}, null, ${`e2eali_gerente_${RUN}`}, 'Gerente', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL_GERENTE}, 'tax.rules.manage'),
             (${ROL_GERENTE}, 'fiscal.range.manage'),
             (${ROL_GERENTE}, 'sales.invoice.issue'),
             (${ROL_GERENTE}, 'fiscal_book.read'),
             (${ROL_GERENTE}, 'fiscal_book.export'),
             (${ROL_GERENTE}, 'company.settings.manage'),
             (${ROL_GERENTE}, 'purchase.invoice.register'),
             (${ROL_GERENTE}, 'ap.read'),
             (${ROL_GERENTE}, 'ar.read')`;
    const mem = crypto.randomUUID();
    const asig = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${mem}, ${TENANT}, ${GERENTE})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id)
             values (${asig}, ${TENANT}, ${mem}, ${ROL_GERENTE}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, ${asig}, 'warehouse', ${W1})`;
    await tx`insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                                           person_type_code, taxpayer_type_code, fiscal_address)
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, ${`J-ALI-${RUN}`}, 'Cliente Alícuotas',
                     'juridica', 'ordinario', 'Calle 8, Maracay')`;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, ${`e2eali-${RUN}`}, 'VES') returning id`;
    for (const [clave, categoria, nombre] of [
      ["general", "gravado_general", "Producto general"],
      ["reducida", "gravado_reducida", "Producto reducida"],
      ["exento", "exento", "Harina de maiz"],
    ] as const) {
      const [p] = await tx<{ id: string }[]>`
        insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                     tax_category_code)
        values (${TENANT}, ${COMPANY}, ${`E2EALI-${clave}-${RUN}`}, ${nombre}, 'service', 'active',
                'unidad', ${categoria}) returning id`;
      PROD[clave] = p!.id;
      await tx`insert into public.price_list_items
                 (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
               values (${TENANT}, ${COMPANY}, ${l!.id}, ${p!.id}, 100, now() - interval '1 day')`;
    }
    await tx`update public.customers set default_price_list_id = ${l!.id} where id = ${CLIENTE}`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${TENANT}, ${COMPANY}, 'formatos_libres', now() - interval '30 days')`;
    // El tipo de contribuyente con su vigencia (migración 20260928190000): sin él no se factura.
    await tx`insert into public.company_taxpayer_types
               (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason,
                rules_version)
             values (${TENANT}, ${COMPANY}, 'ordinario', (now() - interval '30 days')::date, null,
                     'Fixture de alícuotas', 'e2e')`;
  });
  const rango = await pedir("POST", "/v1/fiscal-number-ranges", {
    company_id: COMPANY,
    kind: "invoice",
    series: "T",
    range_from: "1",
    range_to: "500",
    printer_source: "Imprenta E2E alícuotas",
    printer_legal_name: "Imprenta E2E, C.A.",
    printer_tax_id: "J-12345678-9",
    printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
    printer_authorization_date: "2020-01-15",
    printed_on: "2026-09-01",
  });
  expect(rango.status).toBe(201);
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("B-02 · la general se acepta desde el catálogo, con acta", () => {
  it("el 0 % no es una alícuota general: 422 con el mensaje de la base, sin reglas", async () => {
    const r = await pedir("POST", "/v1/fiscal/iva-general", { rate: "0" });
    expect(r.status).toBe(422);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("VALIDATION_FAILED");
    // El mensaje: solo lo produce la función de aceptación (LAD97), no la regex del esquema.
    expect(cuerpo.message).toMatch(/0 % no es una alícuota general/);
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.tax_rules where company_id = ${COMPANY}`;
    expect(n!.n).toBe(0);
  });

  it("fuera de 8–16,5 % (art. 27): 422", async () => {
    const r = await pedir("POST", "/v1/fiscal/iva-general", { rate: "0.2" });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toMatch(/8 % y 16,5 %/);
  });

  it("B-11 · la puesta a punto trae la referencia del catálogo con su cita", async () => {
    const r = await pedir("GET", "/v1/fiscal/setup");
    expect(r.status).toBe(200);
    const cuerpo = (await r.json()) as {
      iva_catalog: { rate: string; rate_min: string; rate_max: string; legal_source: string };
    };
    expect(cuerpo.iva_catalog.rate).toBe("0.16000000");
    expect(cuerpo.iva_catalog.rate_min).toBe("0.08000000");
    expect(cuerpo.iva_catalog.rate_max).toBe("0.16500000");
    expect(cuerpo.iva_catalog.legal_source).toMatch(/Decreto N\.º 4\.079/);
  });

  it("aceptar el 16 % crea la general y lo que viene del catálogo", async () => {
    const r = await pedir("POST", "/v1/fiscal/iva-general", { rate: "0.16" });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { rules_created: number }).rules_created).toBe(8);
  });
});

describe("B-04 · E-04 · E-10 · una factura al 16 %, al 8 % y exenta", () => {
  it("se emite, con la alícuota de cada línea copiada", async () => {
    const r = await pedir("POST", "/v1/invoices", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      series: "T",
      lines: [
        { product_id: PROD.general, quantity: "1" },
        { product_id: PROD.reducida, quantity: "2" },
        { product_id: PROD.exento, quantity: "1" },
      ],
    });
    expect(r.status).toBe(201);
    DOC = ((await r.json()) as { id: string }).id;
    const lineas = await sql<{ tax_rate_snapshot: string; tax_treatment: string }[]>`
      select tax_rate_snapshot::text, tax_treatment from public.document_lines
       where document_id = ${DOC} order by line_number`;
    expect(lineas.map((l) => [l.tax_rate_snapshot, l.tax_treatment])).toEqual([
      ["0.16000000", "gravado"],
      ["0.08000000", "gravado"],
      ["0.00000000", "exento"],
    ]);
  });

  it("el PDF discrimina base e IVA por alícuota, marca (E) y sus columnas van sin IVA", async () => {
    const r = await pedir("GET", `/v1/documents/${DOC}/pdf`);
    expect(r.status).toBe(200);
    const texto = await textoDelPdf(r);
    // FC-10 y FC-11: una base y un IVA por alícuota, con su porcentaje.
    expect(texto).toContain("Base imponible 16 %:");
    expect(texto).toContain("IVA 16 %:");
    expect(texto).toContain("Base imponible 8 %:");
    expect(texto).toContain("IVA 8 %:");
    expect(texto).toContain("Exento (E):");
    expect(texto).toContain("Bs. 16,00");
    // FC-08: la exenta con (E); las gravadas sin él.
    expect(texto).toContain("Harina de maiz (E)");
    expect(texto).not.toContain("Producto reducida (E)");
    // FC-31: el total de la línea al 8 % va SIN IVA (2 × 100 = 200, no 216); subtotal = 400.
    expect(texto).toContain("200,00");
    expect(texto).not.toContain("216,00");
    expect(texto).toContain("Bs. 400,00");
    expect(texto).toContain("Bs. 432,00");
  });

  it("L-08 · el libro de ventas separa por alícuota y trae el resumen del art. 72", async () => {
    const r = await pedir("GET", `/v1/fiscal-books/ventas?from=${HOY}&to=${HOY}`);
    expect(r.status).toBe(200);
    const libro = (await r.json()) as {
      rows: Record<string, string>[];
      summary: { concept: string; rate: string | null; base: string; tax: string }[];
    };
    const fila = libro.rows.find((f) => f["document_id"] === DOC)!;
    expect(fila["base_alicuota_general"]).toBe("100.00000000");
    expect(fila["iva_alicuota_general"]).toBe("16.00000000");
    expect(fila["alicuota_general"]).toBe("0.16000000");
    expect(fila["base_alicuota_reducida"]).toBe("200.00000000");
    expect(fila["iva_alicuota_reducida"]).toBe("16.00000000");
    expect(fila["alicuota_reducida"]).toBe("0.08000000");
    expect(fila["base_exenta"]).toBe("100.00000000");
    const resumen = Object.fromEntries(libro.summary.map((s) => [s.concept, s]));
    expect(resumen["gravado_general"]).toMatchObject({
      rate: "0.16000000",
      base: "100.00000000",
      tax: "16.00000000",
    });
    expect(resumen["gravado_reducida"]).toMatchObject({
      rate: "0.08000000",
      base: "200.00000000",
      tax: "16.00000000",
    });
    expect(resumen["exento"]).toMatchObject({ base: "100.00000000", tax: "0.00000000" });
  });

  it("la declaración suma por alícuota", async () => {
    const [p] = await sql<{ detalle: { alicuota: string; base: string; impuesto: string }[] }[]>`
      select detalle from platform.recompute_iva_period(${COMPANY}, ${HOY}::date, ${HOY}::date, 0)`;
    const por = Object.fromEntries(p!.detalle.map((d) => [Number(d.alicuota).toFixed(2), d]));
    expect(Object.keys(por).sort()).toEqual(["0.00", "0.08", "0.16"]);
    expect(por["0.08"]!.impuesto).toMatch(/^16(\.0+)?$/);
  });
});

describe("H6 · el resumen del art. 72 entra en el hash del libro exportado", () => {
  it("el hash del run firma los renglones Y el resumen, y es determinista", async () => {
    const cuerpo = {
      company_id: COMPANY,
      book_kind: "ventas",
      period_from: HOY,
      period_to: HOY,
      format_code: "csv_columnas_legales",
      timezone: "America/Caracas",
    };
    const r = await pedir("POST", "/v1/fiscal-books/export", cuerpo);
    expect(r.status).toBe(201);
    const uno = (await r.json()) as { run: { dataset_hash: string } };
    // El bloque del resumen en el CSV queda PENDIENTE: rompería la aserción existente de
    // e2e-fiscal-books (CSV = cabecera + renglones). Decisión del coordinador.
    // El hash de los renglones SOLOS (como se calculaba antes): el del run tiene que ser otro,
    // porque firma también el resumen.
    const [soloFilas] = await sql<{ h: string }[]>`
      with filas as (select * from platform.sales_book_by_rate(${COMPANY}, ${HOY}::date, ${HOY}::date))
      select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(f)::text, chr(10)
               order by to_jsonb(f)::text), ''), 'utf8')), 'hex') as h from filas f`;
    expect(uno.run.dataset_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(uno.run.dataset_hash).not.toBe(soloFilas!.h);
    // Y es determinista: repetir la exportación da el mismo hash.
    const dos = (await (await pedir("POST", "/v1/fiscal-books/export", cuerpo)).json()) as {
      run: { dataset_hash: string };
    };
    expect(dos.run.dataset_hash).toBe(uno.run.dataset_hash);
  });

  it("el resumen del art. 72 se descarga como fichero propio de esa generación, sin tocar el hash", async () => {
    const cuerpo = {
      company_id: COMPANY,
      book_kind: "ventas",
      period_from: HOY,
      period_to: HOY,
      format_code: "csv_columnas_legales",
      timezone: "America/Caracas",
    };
    const gen = (await (await pedir("POST", "/v1/fiscal-books/export", cuerpo)).json()) as {
      run: { id: string; dataset_hash: string };
    };
    const [antes] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.fiscal_book_runs where company_id = ${COMPANY}`;

    const r = await pedir("POST", `/v1/fiscal-books/runs/${gen.run.id}/summary-art72`, {
      company_id: COMPANY,
    });
    expect(r.status).toBe(201);
    const res = (await r.json()) as {
      run_id: string;
      dataset_hash: string;
      content: string;
      filename: string;
    };
    expect(res.filename).toBe("resumen-art72.csv");
    expect(res.run_id).toBe(gen.run.id);
    expect(res.dataset_hash).toBe(gen.run.dataset_hash);
    const lineas = res.content.trimEnd().split(/\r?\n/);
    expect(lineas[0]).toBe("RESUMEN (RLIVA art. 72)");
    expect(lineas[1]).toBe("concept,rate,base,tax,adjustments_base,adjustments_tax,documents");
    expect(lineas.slice(2).some((l) => l.startsWith("gravado_reducida,0.08000000,"))).toBe(true);

    // Pedir el resumen no crea otra generación ni cambia la firmada.
    const [despues] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.fiscal_book_runs where company_id = ${COMPANY}`;
    expect(despues!.n).toBe(antes!.n);
    const [run] = await sql<{ dataset_hash: string }[]>`
      select dataset_hash from public.fiscal_book_runs where id = ${gen.run.id}`;
    expect(run!.dataset_hash).toBe(gen.run.dataset_hash);

    // Un libro de retenciones no tiene resumen del art. 72 (ventas y compras sí, hallazgo 6).
    const retenciones = (await (
      await pedir("POST", "/v1/fiscal-books/export", { ...cuerpo, book_kind: "retenciones_iva" })
    ).json()) as { run: { id: string } };
    const sinResumen = await pedir(
      "POST",
      `/v1/fiscal-books/runs/${retenciones.run.id}/summary-art72`,
      { company_id: COMPANY },
    );
    expect(sinResumen.status).toBe(422);
    expect(((await sinResumen.json()) as { message: string }).message).toMatch(
      /libros de ventas y de compras/,
    );
  });
});

describe("H6 · el libro de compras por alícuota, con su resumen", () => {
  it("una compra al 16 %, al 8 % y exenta: el libro la separa por alícuota y la exportación trae el resumen", async () => {
    const PROV = crypto.randomUUID();
    await sql`insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name,
                                             supplier_kind, taxpayer_type_code, person_type_code)
              values (${PROV}, ${TENANT}, ${COMPANY}, ${`J-PROVALI-${RUN}`}, 'Proveedor alícuotas',
                      'nacional', 'ordinario', 'juridica')`;
    const f = await pedir("POST", "/v1/supplier-invoices", {
      company_id: COMPANY,
      supplier_id: PROV,
      supplier_document_number: `FAC-ALI-${RUN}`,
      supplier_control_number: "00-7654321",
      invoice_date: HOY,
      currency: "VES",
      lines: [
        { product_id: PROD.general, quantity: "1", unit_price: "100" },
        { product_id: PROD.reducida, quantity: "2", unit_price: "100" },
        { product_id: PROD.exento, quantity: "1", unit_price: "100" },
      ],
    });
    expect(f.status).toBe(201);
    const factura = ((await f.json()) as { id: string }).id;

    const r = await pedir("GET", `/v1/fiscal-books/compras?from=${HOY}&to=${HOY}`);
    expect(r.status).toBe(200);
    const libro = (await r.json()) as {
      rows: Record<string, string>[];
      summary?: { concept: string; base: string; tax: string }[];
    };
    const fila = libro.rows.find((x) => x["invoice_id"] === factura)!;
    expect(fila["base_alicuota_general"]).toBe("100.00000000");
    expect(fila["iva_alicuota_general"]).toBe("16.00000000");
    expect(fila["base_alicuota_reducida"]).toBe("200.00000000");
    expect(fila["iva_alicuota_reducida"]).toBe("16.00000000");
    expect(fila["alicuota_reducida"]).toBe("0.08000000");
    expect(fila["base_exenta"]).toBe("100.00000000");
    expect(fila["iva_sin_clasificar"]).toBe("0.00000000");
    const reducida = libro.summary?.find((s) => s.concept === "gravado_reducida");
    expect(reducida).toMatchObject({ base: "200.00000000", tax: "16.00000000" });

    const exp = await pedir("POST", "/v1/fiscal-books/export", {
      company_id: COMPANY,
      book_kind: "compras",
      period_from: HOY,
      period_to: HOY,
      format_code: "csv_columnas_legales",
      timezone: "America/Caracas",
    });
    expect(exp.status).toBe(201);
    const gen = (await exp.json()) as {
      content: string;
      summary_content?: string;
      summary_filename?: string;
    };
    expect(gen.content.split(/\r?\n/)[0]).toContain("base_alicuota_reducida");
    expect(gen.summary_filename).toBe("resumen-art72-compras.csv");
    expect(gen.summary_content?.startsWith("RESUMEN (RLIVA art. 72)")).toBe(true);
  });

  it("F6: un renglón con base gravada sin alícuota cuenta como no clasificado", async () => {
    const PROV2 = crypto.randomUUID();
    const FAC = crypto.randomUUID();
    await sql`insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name,
                                             supplier_kind, taxpayer_type_code, person_type_code)
              values (${PROV2}, ${TENANT}, ${COMPANY}, ${`J-PROVF6-${RUN}`}, 'Proveedor F6',
                      'nacional', 'ordinario', 'juridica')`;
    const antes = (await (
      await pedir("GET", `/v1/fiscal-books/compras?from=${HOY}&to=${HOY}`)
    ).json()) as { unclassified_rows: number };
    // Una línea GRAVADA sin categoría congelada: el libro la lleva a gravadas, y ninguna alícuota
    // la explica.
    await sql`insert into public.supplier_invoices
                 (id, tenant_id, company_id, supplier_id, supplier_document_number,
                  supplier_control_number, invoice_date, status, posted_at, subtotal_amount,
                  tax_amount, total_amount, tax_is_recoverable, transaction_currency,
                  functional_currency, fx_rate, rate_source)
               values (${FAC}, ${TENANT}, ${COMPANY}, ${PROV2}, ${`F6-${RUN}`}, '00-6666666',
                       ${HOY}::date, 'posted', now(), 100, 16, 116, true, 'VES', 'VES', 1,
                       'identidad')`;
    await sql`insert into public.supplier_invoice_lines
                 (tenant_id, company_id, supplier_invoice_id, line_number, product_id, description,
                  quantity, unit_price_transaction, unit_price_functional,
                  line_subtotal_transaction, line_total_transaction, tax_amount,
                  tax_rate_snapshot, tax_category_snapshot, tax_treatment,
                  amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
                  functional_currency, rate_source, rate_timestamp, rounding_policy_id)
               values (${TENANT}, ${COMPANY}, ${FAC}, 1, ${PROD.general}, 'Sin categoría', 1, 100,
                       100, 100, 116, 16, 0.16, null, 'gravado', 116, 'VES', 1, 116, 'VES',
                       'identidad', now(), 'purchases:document:8:HALF_UP')`;
    const despues = (await (
      await pedir("GET", `/v1/fiscal-books/compras?from=${HOY}&to=${HOY}`)
    ).json()) as { unclassified_rows: number; rows: Record<string, string>[] };
    const fila = despues.rows.find((x) => x["invoice_id"] === FAC)!;
    expect(fila["base_sin_clasificar"]).toBe("0.00000000");
    expect(fila["base_gravada_sin_alicuota"]).toBe("100.00000000");
    expect(despues.unclassified_rows).toBe(antes.unclassified_rows + 1);
  });

  it("H11: el libro de ventas lleva el identificador del control junto al control", async () => {
    const r = await pedir("GET", `/v1/fiscal-books/ventas?from=${HOY}&to=${HOY}`);
    const libro = (await r.json()) as { rows: Record<string, string | null>[] };
    const fila = libro.rows.find((x) => x["document_id"] === DOC)!;
    expect(Object.keys(fila)).toContain("control_identifier");
    expect(fila["control_identifier"]).toMatch(/^[0-9]{2}$/);
  });
});

describe("B1 · el libro legal, su hash y su resumen", () => {
  const cuerpo = () => ({
    company_id: COMPANY,
    book_kind: "ventas",
    period_from: HOY,
    period_to: HOY,
    format_code: "csv_columnas_legales",
    timezone: "America/Caracas",
  });

  it("exportar ventas trae el resumen del art. 72 en la misma respuesta", async () => {
    const r = await pedir("POST", "/v1/fiscal-books/export", cuerpo());
    expect(r.status).toBe(201);
    const gen = (await r.json()) as { summary_content?: string; summary_filename?: string };
    expect(gen.summary_filename).toBe("resumen-art72.csv");
    expect(gen.summary_content?.startsWith("RESUMEN (RLIVA art. 72)")).toBe(true);
  });

  it("cobrar una factura del período no cambia el hash ni impide descargar el resumen", async () => {
    const uno = (await (await pedir("POST", "/v1/fiscal-books/export", cuerpo())).json()) as {
      run: { id: string; dataset_hash: string };
      summary_content: string;
    };
    // Lo que un cobro le hace al renglón del libro: el estado pasa a pagada y el asiento llega.
    await sql`update public.documents set status = 'paid' where id = ${DOC}`;
    const dos = (await (await pedir("POST", "/v1/fiscal-books/export", cuerpo())).json()) as {
      run: { dataset_hash: string };
    };
    expect(dos.run.dataset_hash).toBe(uno.run.dataset_hash);
    const r = await pedir("POST", `/v1/fiscal-books/runs/${uno.run.id}/summary-art72`, {
      company_id: COMPANY,
    });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { content: string }).content).toBe(uno.summary_content);
  });

  it("si el libro cambió de verdad, el resumen de la generación vieja da 422 con su mensaje", async () => {
    const uno = (await (await pedir("POST", "/v1/fiscal-books/export", cuerpo())).json()) as {
      run: { id: string };
    };
    const f = await pedir("POST", "/v1/invoices", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      series: "T",
      lines: [{ product_id: PROD.exento, quantity: "1" }],
    });
    expect(f.status).toBe(201);
    const r = await pedir("POST", `/v1/fiscal-books/runs/${uno.run.id}/summary-art72`, {
      company_id: COMPANY,
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toMatch(
      /El libro de ventas cambió desde esa generación: vuelve a exportarlo/,
    );
  });
});

describe("B4 · la categoría por omisión también pasa por el catálogo", () => {
  it("poner no_sujeto como categoría por omisión: 422 con el porqué", async () => {
    const r = await pedir("PUT", "/v1/company-settings", {
      default_tax_category_code: "no_sujeto",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toMatch(/no se ofrece en ventas/);
  });
});

describe("B-02 · aceptar otra tasa se aplica", () => {
  it("B5: aceptar la MISMA tasa responde changed = false (la web dice «Ya regía esa alícuota»)", async () => {
    const r = await pedir("POST", "/v1/fiscal/iva-general", { rate: "0.16" });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { changed: boolean }).changed).toBe(false);
  });

  it("H2: el mismo día en que ya se facturó al 16 %, el 15 % no se aplica hoy: 422 y la persona elige mañana", async () => {
    const r = await pedir("POST", "/v1/fiscal/iva-general", { rate: "0.15" });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toMatch(
      /Hoy ya se facturó al 16 %: la nueva tasa puede regir desde mañana/,
    );
    // Una fecha efectiva en el pasado no se acepta: reinterpretaría lo ya emitido.
    const ayer = await pedir("POST", "/v1/fiscal/iva-general", {
      rate: "0.15",
      effective_from: "2020-01-01",
    });
    expect(ayer.status).toBe(422);
    expect(((await ayer.json()) as { message: string }).message).toMatch(
      /no puede regir antes de hoy/,
    );
  });

  it("el 15 % desde mañana cierra el 16 % en mañana; hoy sigue el 16 % y lo emitido conserva su copia", async () => {
    const [d] = await sql<{ manana: string }[]>`
      select ((now() at time zone 'America/Caracas')::date + 1)::text as manana`;
    const r = await pedir("POST", "/v1/fiscal/iva-general", {
      rate: "0.15",
      effective_from: d!.manana,
    });
    expect(r.status).toBe(201);
    const estado = (await (await pedir("GET", "/v1/fiscal/setup")).json()) as {
      iva_general: { rate: string };
    };
    expect(estado.iva_general.rate).toBe("0.16000000");
    const [manana] = await sql<{ rate: string }[]>`
      select rate::text as rate from platform.resolve_tax(${COMPANY}, ${d!.manana}::date, 'VE',
                                                          'iva', 'ordinario', 'gravado_general')`;
    expect(manana!.rate).toBe("0.15000000");
    const [acta] = await sql<
      { payload: { rate: string; previous_rate: string | null; effective_from: string } }[]
    >`
      select payload from public.audit_events
       where company_id = ${COMPANY} and event_type = 'fiscal.iva.accepted'
       order by occurred_at desc limit 1`;
    expect(acta!.payload).toMatchObject({
      rate: "0.15",
      previous_rate: "0.16000000",
      effective_from: d!.manana,
    });
    const [linea] = await sql<{ t: string }[]>`
      select tax_rate_snapshot::text as t from public.document_lines
       where document_id = ${DOC} and line_number = 1`;
    expect(linea!.t).toBe("0.16000000");
  });
});

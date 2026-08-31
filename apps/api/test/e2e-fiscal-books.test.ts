import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * LIBROS FISCALES de extremo a extremo (ADR-0044).
 *
 * Lo que este fichero está aquí para demostrar, y que ningún test unitario ve:
 *   1. una factura emitida HOY llega al libro de ventas con su base separada
 *      por tratamiento — o sea que el gancho de emisión rellena el snapshot
 *      ampliado de verdad, no solo que la columna existe;
 *   2. **exento y gravado NO se mezclan**, que es la razón entera del módulo;
 *   3. la ANULADA aparece marcada y NO suma en la conciliación;
 *   4. `libro = mayor + cola` cuadra sobre datos que produjo la API;
 *   5. exportar deja UNA fila con hash, y **exportar dos veces el mismo período
 *      da el MISMO hash** — que es lo que hace la generación reproducible;
 *   6. consultar en pantalla NO deja fila: si la dejara, el rastro de
 *      presentaciones se llenaría de ruido y dejaría de probar nada;
 *   7. pedir un adaptador que está en el catálogo SIN implementación responde
 *      409 LAD65 y **no escribe** una generación. La variante rota: se carga un
 *      adaptador falso a propósito, porque si no ese camino sería código muerto.
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
const CLIENTE = crypto.randomUUID();
const PROVEEDOR = crypto.randomUUID();
const ROL = crypto.randomUUID();
const MEM = crypto.randomUUID();
const ASIG = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = new Date().toISOString().slice(0, 10);
const AYER = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
// El período que se consulta: de ayer a hoy. Explícito y no «el mes en curso»,
// porque un libro con período implícito no se puede volver a generar igual.
const DESDE = AYER;
const HASTA = HOY;
const ADAPTADOR_FALSO = `falso_sin_impl_${RUN.slice(0, 6)}`.slice(0, 40);

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PROD_GRAVADO = "";
let PROD_EXENTO = "";
let LISTA = "";

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

interface FilaVenta {
  document_id: string;
  status: string;
  base_gravada: string;
  base_exenta: string;
  base_sin_clasificar: string;
  iva_debito: string;
}

async function libroVentas(): Promise<{ rows: FilaVenta[]; unclassified_rows: number }> {
  const r = await pedir("GET", `/v1/fiscal-books/ventas?from=${DESDE}&to=${HASTA}`);
  expect(r.status).toBe(200);
  return (await r.json()) as { rows: FilaVenta[]; unclassified_rows: number };
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${CONTADOR}) on conflict (id) do nothing`;

  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${CONTADOR}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e libros')`;
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-LIB-${RUN}`}, 'Empresa e2e libros',
                     'VES', 'ordinario')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-LW1', 'Principal')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, ${`e2elibros_${RUN}`}, 'Contador libros e2e', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.invoice.annul'),
             (${ROL}, 'ar.read'), (${ROL}, 'supplier.manage'),
             (${ROL}, 'purchase.invoice.register'), (${ROL}, 'ap.read'),
             (${ROL}, 'inventory.move'), (${ROL}, 'fiscal.range.manage'),
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.read'),
             -- Anular una factura REVERSA su asiento (ADR-0042), así que el
             -- permiso contable hace falta aunque el acto se pida en ventas.
             (${ROL}, 'accounting.entry.reverse'),
             (${ROL}, 'fiscal_book.read'), (${ROL}, 'fiscal_book.export')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${MEM}, ${TENANT}, ${CONTADOR})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id)
             values (${ASIG}, ${TENANT}, ${MEM}, ${ROL}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${COMPANY}, ${ASIG}, 'warehouse', ${W1})`;
    await tx`insert into public.customers
               (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                taxpayer_type_code)
             values (${CLIENTE}, ${TENANT}, ${COMPANY}, ${`J-CLI-${RUN}`}, 'Cliente e2e libros',
                     'juridica', 'ordinario')`;
    await tx`insert into public.suppliers
               (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code,
                taxpayer_type_code)
             values (${PROVEEDOR}, ${TENANT}, ${COMPANY}, ${`J-PRV-${RUN}`}, 'Proveedor e2e libros',
                     'nacional', 'juridica', 'ordinario')`;

    // DOS productos con tratamiento DISTINTO. Es el corazón del módulo: si el
    // libro los mezclara, la declaración saldría mal y nadie se enteraría.
    const [g] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2ELIB-G-${RUN}`}, 'Producto gravado', 'good', 'active',
              'unidad', 'gravado_general')
      returning id`;
    PROD_GRAVADO = g!.id;
    const [e] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${COMPANY}, ${`E2ELIB-E-${RUN}`}, 'Producto exento', 'good', 'active',
              'unidad', 'exento')
      returning id`;
    PROD_EXENTO = e!.id;

    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${COMPANY}, ${`e2e-libros-${RUN}`}, 'VES') returning id`;
    LISTA = l!.id;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${COMPANY}, ${LISTA}, ${PROD_GRAVADO}, '1000.00000000',
                     ${AYER}::date),
                    (${TENANT}, ${COMPANY}, ${LISTA}, ${PROD_EXENTO}, '500.00000000',
                     ${AYER}::date)`;
    await tx`update public.customers set default_price_list_id = ${LISTA} where id = ${CLIENTE}`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${TENANT}, ${COMPANY}, 'formatos_libres', ${AYER}::timestamptz)`;

    // Reglas de IVA de prueba, guardadas porque `tax_rules` es global. La del
    // exento existe y vale CERO: es una regla, no una ausencia — sin ella la
    // emisión fallaría con TAX_RULE_MISSING, que es lo correcto (ADR-0038).
    for (const [cat, tasa] of [
      ["gravado_general", 0.16],
      ["exento", 0],
    ] as const) {
      for (const tipo of ["sale", "purchase"] as const) {
        await tx`
          insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type,
                                        product_tax_category, rate, effective_from, legal_source,
                                        priority, transaction_type)
          select 'VE', 'iva', 'ordinario', ${cat}, ${tasa}, ${AYER}::date,
                 'Carga de prueba E2E — VALIDAR-SENIAT antes de producción.', 10, ${tipo}
           where not exists (select 1 from public.tax_rules
                              where jurisdiction = 'VE' and tax_code = 'iva'
                                and taxpayer_type = 'ordinario'
                                and product_tax_category = ${cat}
                                and transaction_type = ${tipo})`;
      }
    }

    await tx`insert into public.inventory_moves
               (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
                amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
                functional_currency, rate_source, rate_timestamp, rounding_policy_id,
                occurred_at, reference)
             values (${TENANT}, ${COMPANY}, ${W1}, ${PROD_GRAVADO}, 'entrada', 100, 50000, 'VES',
                     1, 50000, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', now(),
                     ${`e2e-libros-seed-g-${RUN}`}),
                    (${TENANT}, ${COMPANY}, ${W1}, ${PROD_EXENTO}, 'entrada', 100, 20000, 'VES',
                     1, 20000, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', now(),
                     ${`e2e-libros-seed-e-${RUN}`})`;
  });

  const rango = await pedir("POST", "/v1/fiscal-number-ranges", {
    company_id: COMPANY,
    kind: "invoice",
    series: "A",
    range_from: "1",
    range_to: "500",
    printer_source: "Imprenta E2E libros",
  });
  if (rango.status !== 201) throw new Error(`rango: ${rango.status} ${await rango.text()}`);

  // Contabilidad configurada: sin ella todo iría a la cola y la conciliación
  // sería trivial. Se monta a propósito para que el mayor tenga algo que decir.
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
  await sql`delete from public.book_format_adapters where code = ${ADAPTADOR_FALSO}`;
  await sql.end();
  await sqlApi.end();
});

describe("libros fiscales — el snapshot ampliado llega al libro", () => {
  it("una factura con línea gravada y línea EXENTA las separa en columnas distintas", async () => {
    const r = await pedir("POST", "/v1/invoices", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: [
        { product_id: PROD_GRAVADO, quantity: "2" },
        { product_id: PROD_EXENTO, quantity: "1" },
      ],
    });
    expect(r.status).toBe(201);
    const doc = (await r.json()) as Record<string, string>;
    // 2 × 1 000 gravado + 1 × 500 exento = 2 500 de base, 320 de IVA.
    expect(doc["total_amount"]).toBe("2820.00000000");

    const libro = await libroVentas();
    const fila = libro.rows.find((f) => f.document_id === doc["id"]);
    expect(fila).toBeDefined();
    expect(fila!.base_gravada).toBe("2000.00000000");
    expect(fila!.base_exenta).toBe("500.00000000");
    expect(fila!.iva_debito).toBe("320.00000000");
    // Y NADA sin clasificar: el gancho de emisión rellenó el snapshot. Esta es
    // la aserción que distingue «la columna existe» de «la columna se usa».
    expect(fila!.base_sin_clasificar).toBe("0");
    expect(libro.unclassified_rows).toBe(0);
  });

  it("un documento del PASADO, sin tratamiento, cae en `sin_clasificar` y no en gravada", async () => {
    /**
     * Se construye por SQL directo, y no hay otra forma: la API de hoy SIEMPRE
     * rellena el snapshot, y las líneas de un documento emitido no se editan
     * (LAD06). O sea que un documento sin tratamiento solo puede existir por
     * haber nacido antes de la migración 27 — que es exactamente lo que hay que
     * simular para probar que el libro no lo adivina.
     */
    const DOC = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${CONTADOR}, true)`;
      const [reg] = await tx<{ regime_version_id: string }[]>`
        select regime_version_id from platform.regime_at(${COMPANY}, now())`;
      const [num] = await tx<{ n: string }[]>`
        select platform.claim_document_number(${COMPANY}, 'invoice', 'A')::text as n`;
      const [ctrl] = await tx<{ n: string }[]>`
        select platform.claim_control_number(${COMPANY}, 'invoice', 'A')::text as n`;
      await tx`
        insert into public.documents
          (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
           status, issued_at, regime_version_id, rules_version, transaction_currency,
           functional_currency, fx_rate, rate_source, amount_transaction_currency,
           functional_amount, subtotal_amount, tax_amount, total_amount)
        values (${DOC}, ${TENANT}, ${COMPANY}, 'invoice', 'A', ${CLIENTE}, ${num!.n}::bigint,
                ${ctrl!.n}::bigint, 'issued', now(), ${reg!.regime_version_id}, 'legacy-pre-27',
                'VES', 'VES', 1, 'identidad', 1160, 1160, 1000, 160, 1160)`;
      // La línea SIN tratamiento ni categoría: el snapshot que no existía.
      await tx`
        insert into public.document_lines
          (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
           unit_price_transaction, unit_price_functional, tax_rate_snapshot, tax_amount,
           line_subtotal_transaction, line_subtotal_functional, line_total_transaction,
           line_total_functional, amount_transaction_currency, transaction_currency, fx_rate,
           functional_amount, functional_currency, rate_source, rate_timestamp,
           rounding_policy_id)
        values (${TENANT}, ${COMPANY}, ${DOC}, 1, ${PROD_GRAVADO}, 'Línea del pasado', 1,
                1000, 1000, 0.16, 160, 1000, 1000, 1160, 1160, 1160, 'VES', 1, 1160, 'VES',
                'identidad', now(), 'sales:document:8:HALF_UP')`;
    });

    const libro = await libroVentas();
    const fila = libro.rows.find((f) => f.document_id === DOC)!;
    expect(fila).toBeDefined();
    expect(fila.base_gravada).toBe("0");
    expect(fila.base_sin_clasificar).toBe("1000.00000000");
    // El IVA sigue saliendo de la CABECERA: el libro no pierde el impuesto solo
    // porque no sepa clasificar la base. Perderlo sería declarar de menos.
    expect(fila.iva_debito).toBe("160.00000000");
    expect(libro.unclassified_rows).toBe(1);
  });

  it("la ANULADA aparece marcada — el correlativo se consumió y el libro lo registra", async () => {
    const r = await pedir("POST", "/v1/invoices", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: [{ product_id: PROD_GRAVADO, quantity: "1" }],
    });
    expect(r.status).toBe(201);
    const doc = (await r.json()) as Record<string, string>;
    const anul = await pedir("POST", `/v1/invoices/${doc["id"]}/annul`, {
      company_id: COMPANY,
      reason: "error de digitación en la cantidad",
    });
    expect(anul.status).toBe(200);

    const libro = await libroVentas();
    const fila = libro.rows.find((f) => f.document_id === doc["id"])!;
    expect(fila.status).toBe("annulled");
  });
});

describe("libros fiscales — conciliación con el mayor", () => {
  it("libro = mayor + cola sobre datos que produjo la API", async () => {
    const r = await pedir(
      "GET",
      `/v1/fiscal-books/reports/reconciliation?from=${DESDE}&to=${HASTA}`,
    );
    expect(r.status).toBe(200);
    const rec = (await r.json()) as {
      balanced: boolean;
      rows: { concepto: string; libro: string; mayor: string; en_cola: string }[];
    };
    const debito = rec.rows.find((x) => x.concepto === "iva_debito_fiscal")!;
    // Las tres cifras existen y la identidad se cumple. Se comprueba `balanced`
    // Y la fila, porque un `balanced` que saliera de una lista vacía sería un
    // verde que no verificó nada — el patrón de ADR-0023.
    expect(debito).toBeDefined();
    expect(rec.balanced).toBe(true);
    expect(debito.libro).not.toBe("0");
  });
});

describe("libros fiscales — la exportación y su rastro", () => {
  it("consultar en pantalla NO deja fila en fiscal_book_runs", async () => {
    const antes = await sql<{ n: string }[]>`
      select count(*)::text as n from public.fiscal_book_runs where company_id = ${COMPANY}`;
    await libroVentas();
    await pedir("GET", `/v1/fiscal-books/compras?from=${DESDE}&to=${HASTA}`);
    const despues = await sql<{ n: string }[]>`
      select count(*)::text as n from public.fiscal_book_runs where company_id = ${COMPANY}`;
    expect(despues[0]!.n).toBe(antes[0]!.n);
  });

  it("exportar deja UNA fila con hash, y repetirla da el MISMO hash", async () => {
    const cuerpo = {
      company_id: COMPANY,
      book_kind: "ventas" as const,
      period_from: DESDE,
      period_to: HASTA,
      format_code: "csv_columnas_legales",
      timezone: "America/Caracas",
    };
    const uno = await pedir("POST", "/v1/fiscal-books/export", cuerpo);
    expect(uno.status).toBe(201);
    const a = (await uno.json()) as {
      run: { dataset_hash: string; row_count: number; created_by: string | null };
      content: string;
      filename: string;
    };
    expect(a.run.dataset_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.run.row_count).toBeGreaterThan(0);
    // El «quién» no puede faltar: es uno de los siete campos.
    expect(a.run.created_by).toBe(CONTADOR);
    expect(a.filename).toContain("libro-ventas-");
    // El CSV trae cabecera + una línea por renglón.
    expect(a.content.split("\r\n")).toHaveLength(a.run.row_count + 1);
    expect(a.content.split("\r\n")[0]).toContain("base_gravada");

    const dos = await pedir("POST", "/v1/fiscal-books/export", cuerpo);
    expect(dos.status).toBe(201);
    const b = (await dos.json()) as { run: { dataset_hash: string } };
    // MISMO dataset, MISMO hash. Es lo que hace demostrable que dos
    // presentaciones del mismo período dijeron lo mismo.
    expect(b.run.dataset_hash).toBe(a.run.dataset_hash);

    const filas = await sql<{ n: string }[]>`
      select count(*)::text as n from public.fiscal_book_runs
       where company_id = ${COMPANY} and book_kind = 'ventas'`;
    expect(Number(filas[0]!.n)).toBe(2);
  });

  it("un documento nuevo CAMBIA el hash del mismo período: el rastro delata el cambio", async () => {
    const cuerpo = {
      company_id: COMPANY,
      book_kind: "ventas" as const,
      period_from: DESDE,
      period_to: HASTA,
      format_code: "csv_columnas_legales",
      timezone: "America/Caracas",
    };
    const antes = (await (await pedir("POST", "/v1/fiscal-books/export", cuerpo)).json()) as {
      run: { dataset_hash: string };
    };
    const r = await pedir("POST", "/v1/invoices", {
      company_id: COMPANY,
      customer_id: CLIENTE,
      warehouse_id: W1,
      lines: [{ product_id: PROD_EXENTO, quantity: "3" }],
    });
    expect(r.status).toBe(201);
    const despues = (await (await pedir("POST", "/v1/fiscal-books/export", cuerpo)).json()) as {
      run: { dataset_hash: string };
    };
    expect(despues.run.dataset_hash).not.toBe(antes.run.dataset_hash);
  });

  it("una generación registrada NO se puede reescribir ni borrar", async () => {
    const [fila] = await sql<{ id: string }[]>`
      select id from public.fiscal_book_runs where company_id = ${COMPANY} limit 1`;
    await expect(
      sql`update public.fiscal_book_runs set row_count = 999 where id = ${fila!.id}`,
    ).rejects.toMatchObject({ code: "LAD06" });
    await expect(
      sql`delete from public.fiscal_book_runs where id = ${fila!.id}`,
    ).rejects.toMatchObject({ code: "LAD06" });
  });

  it("el catálogo de formatos no ofrece NINGUNO oficial", async () => {
    const r = await pedir("GET", "/v1/fiscal-books/formats");
    expect(r.status).toBe(200);
    const formatos = (await r.json()) as {
      code: string;
      is_official: boolean;
      implemented: boolean;
    }[];
    expect(formatos.length).toBeGreaterThan(0);
    expect(formatos.filter((f) => f.is_official)).toHaveLength(0);
    expect(formatos.find((f) => f.code === "csv_columnas_legales")?.implemented).toBe(true);
  });

  it("VARIANTE ROTA: un adaptador en el catálogo SIN implementación responde 409 y no escribe", async () => {
    // Se carga a propósito, porque si no este camino sería código muerto que
    // parece funcionar — y el día que llegue el layout del SENIAT es el camino
    // que tiene que impedir exportar un CSV con nombre de fichero oficial.
    await sql`
      insert into public.book_format_adapters
        (code, book_kind, name, description, is_official, legal_source)
      values (${ADAPTADOR_FALSO}, 'todos', 'Adaptador sin implementación',
              'VALIDAR-SENIAT: fila de prueba del E2E, sin implementación en el código.',
              false, 'Ninguna: fila de prueba.')`;
    const antes = await sql<{ n: string }[]>`
      select count(*)::text as n from public.fiscal_book_runs where company_id = ${COMPANY}`;

    const r = await pedir("POST", "/v1/fiscal-books/export", {
      company_id: COMPANY,
      book_kind: "ventas",
      period_from: DESDE,
      period_to: HASTA,
      format_code: ADAPTADOR_FALSO,
      timezone: "America/Caracas",
    });
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("BOOK_FORMAT_UNAVAILABLE");
    // Se asevera el MENSAJE, no solo el código: hay dos caminos que producen
    // este mismo 409 —el adaptador ausente del catálogo y el presente sin
    // implementación— y solo el mensaje distingue cuál se probó.
    expect(cuerpo.message).toContain("LAD65");

    const despues = await sql<{ n: string }[]>`
      select count(*)::text as n from public.fiscal_book_runs where company_id = ${COMPANY}`;
    expect(despues[0]!.n).toBe(antes[0]!.n);
  });

  it("y un formato que ni siquiera está en el catálogo da OTRO mensaje", async () => {
    const r = await pedir("POST", "/v1/fiscal-books/export", {
      company_id: COMPANY,
      book_kind: "ventas",
      period_from: DESDE,
      period_to: HASTA,
      format_code: "no_existe_en_el_catalogo",
      timezone: "America/Caracas",
    });
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.message).toContain("no está en el catálogo");
    expect(cuerpo.message).not.toContain("LAD65");
  });

  it("el libro exige período explícito: sin `from` y `to` no se sirve", async () => {
    const r = await pedir("GET", "/v1/fiscal-books/ventas");
    expect(r.status).toBe(422);
  });

  it("las generaciones se pueden listar, con su hash", async () => {
    const r = await pedir("GET", "/v1/fiscal-books/runs?kind=ventas");
    expect(r.status).toBe(200);
    const { runs } = (await r.json()) as { runs: { dataset_hash: string; book_kind: string }[] };
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(runs.every((x) => x.book_kind === "ventas")).toBe(true);
    expect(runs.every((x) => /^[0-9a-f]{64}$/.test(x.dataset_hash))).toBe(true);
  });
});

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";
import { fiadoDeFixture, venceDeFixture } from "./_fiado-de-fixture.js";
import { borrarTasasOficiales, sembrarTasaOficial } from "./_tasa-oficial.js";

/**
 * SALIDAS Y RETIROS DE INVENTARIO (ADR-0078 · migración 20261003110000 · I-01, I-02, I-07, I-08,
 * I-11, I-12, P-10).
 *
 * Tres verbos: traslado (sin valor), conteo (lo contado menos el sistema, con motivo) y salida con
 * motivo de una lista cerrada. Lo que se mira en cada salida es lo que SOLO produce el camino que
 * dice probar (CLAUDE.md §3): el motivo guardado en su columna, la cuenta del asiento por su papel,
 * la Nota de retiro con su correlativo y su renglón en el libro de ventas. Y después de cada paso,
 * los invariantes que cruzan módulos: kardex ↔ mayor, movimiento ⇒ asiento, libro ↔ mayor.
 *
 * I-02 era el antitest: las salidas de los tests no mandaban el motivo que la web siempre manda, y
 * la base lo rechazaba. Aquí toda salida lo manda, y una sin motivo tiene que fallar por el esquema
 * (con el campo `reason` nombrado), no por un CHECK genérico.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const RUN = Date.now().toString(36);
const AYER = diaCaracas(-1);
const DESDE = diaCaracas(-3);
const HASTA = diaCaracas(3);
const DUENO = crypto.randomUUID();
/** AF5-02: mueve mercancía (`inventory.move`) y NO factura. */
const ALMACENISTA = crypto.randomUUID();
/** La tasa oficial que este fichero siembra para su venta a crédito, con fuente propia. */
const FUENTE_TASA = `e2e-salidas-${RUN}`;
/** Un RIF con forma de RIF (prefijo y dígitos): el que `/v1/customers/lookup` acepta buscar. */
const rifNumerico = (): string =>
  `J${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`;

/** ¿Está la migración del céntimo que libera mover un inactivo (apply_inventory_move)? */
const sondeo = createClient(URL_LOCAL);
const [centimo] = await sondeo<{ ok: boolean }[]>`
  select exists (select 1 from supabase_migrations.schema_migrations
                  where version = '20261003140000') as ok`;
await sondeo.end();
const CENTIMO_APLICADO = centimo?.ok === true;

interface Empresa {
  tenant: string;
  company: string;
  rif: string;
  rol: string;
  w1: string;
  w2: string;
  harina: string;
  cloro: string;
  lotes: string;
}

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let F: Empresa; // factura (formatos_libres)
let R: Empresa; // sin RIF (sin_facturacion)

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
  e: Empresa,
  metodo: string,
  path: string,
  body?: unknown,
  quien: string = DUENO,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(quien)}`,
    "X-Company-Id": e.company,
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

async function crearEmpresa(
  regimen: "formatos_libres" | "sin_facturacion",
  /** Para una segunda empresa del mismo régimen (ADR-0082: la ficha del adquirente). */
  sufijo = "",
  /** Un RIF concreto (el de `rifNumerico`), para los casos que lo buscan por la API. */
  rifPropio?: string,
): Promise<Empresa> {
  const e: Empresa = {
    tenant: crypto.randomUUID(),
    company: crypto.randomUUID(),
    rif:
      rifPropio ??
      (regimen === "formatos_libres"
        ? `J-SAL-${RUN}-${regimen.length}${sufijo}`
        : `PEND-SAL-${RUN}`),
    rol: crypto.randomUUID(),
    w1: crypto.randomUUID(),
    w2: crypto.randomUUID(),
    harina: "",
    cloro: "",
    lotes: "",
  };
  const rol = e.rol;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${e.tenant}, ${`Salidas ${regimen}`})`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code)
             values (${e.company}, ${e.tenant}, ${e.rif}, ${`Bodega salidas ${regimen}`}, 'VES',
                     ${regimen === "formatos_libres" ? "ordinario" : null})`;
    await declararTipoDeFixture(tx, e.company);
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name) values
             (${e.w1}, ${e.tenant}, ${e.company}, 'SAL-W1', 'Principal'),
             (${e.w2}, ${e.tenant}, ${e.company}, 'SAL-W2', 'Centro')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${rol}, null, ${`e2esal_${regimen}${sufijo}_${RUN}`}, 'Dueño', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${rol}, 'inventory.move'), (${rol}, 'inventory.adjust'),
             (${rol}, 'inventory.transfer'), (${rol}, 'accounting.account.manage'),
             (${rol}, 'sales.invoice.issue'), (${rol}, 'sales.payment.register'),
             (${rol}, 'accounting.template.manage'), (${rol}, 'accounting.read'),
             (${rol}, 'sales.invoice.annul'),
             -- Tercera ronda: leer el estado de cuenta, dar de alta un cliente y llegar hasta la
             -- guarda de la nota de crédito general (sin este permiso, el 403 la tapaba).
             (${rol}, 'ar.read'), (${rol}, 'customer.manage'),
             (${rol}, 'sales.credit_note.direct')
             on conflict do nothing`;
    // ADR-0082: el retiro se FACTURA, y sobre forma libre la factura gasta papel del talonario.
    if (regimen === "formatos_libres") {
      await tx`
        insert into public.fiscal_number_ranges
          (tenant_id, company_id, kind, series, printer_identifier, range_from, range_to,
           next_available, printer_source, printer_legal_name, printer_tax_id,
           printer_authorization, printer_authorization_date, printed_on, created_at, version)
        values (${e.tenant}, ${e.company}, 'invoice', 'A', '00', 1, 500, 1, 'Imprenta E2E',
                'Imprenta E2E, C.A.', 'J123456789', 'SNAT/INTI/GRTI/RCO/2020/000123',
                '2020-01-15', '2026-09-01', now(), 1)`;
    }
    const mem = crypto.randomUUID();
    const asig = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${mem}, ${e.tenant}, ${DUENO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${asig}, ${e.tenant}, ${mem}, ${rol}, null)`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${e.tenant}, ${e.company}, ${asig}, 'warehouse', ${e.w1}),
                    (${e.tenant}, ${e.company}, ${asig}, 'warehouse', ${e.w2})`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${e.tenant}, ${e.company}, ${regimen}, now() - interval '10 days')`;
    const prods = await tx<{ id: string; sku: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code, tracks_lots)
      values (${e.tenant}, ${e.company}, ${`SAL-HAR-${RUN}`}, 'Harina', 'good', 'active',
              'unidad', 'gravado_general', false),
             (${e.tenant}, ${e.company}, ${`SAL-CLO-${RUN}`}, 'Cloro', 'good', 'active',
              'unidad', 'gravado_general', false),
             (${e.tenant}, ${e.company}, ${`SAL-LOT-${RUN}`}, 'Yogur', 'good', 'active',
              'unidad', 'gravado_general', true)
      returning id, sku`;
    e.harina = prods.find((p) => p.sku.startsWith("SAL-HAR"))!.id;
    e.cloro = prods.find((p) => p.sku.startsWith("SAL-CLO"))!.id;
    e.lotes = prods.find((p) => p.sku.startsWith("SAL-LOT"))!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${e.tenant}, ${e.company}, 'detal', 'VES') returning id`;
    await tx`insert into public.company_settings (company_id, tenant_id, default_price_list_id)
             values (${e.company}, ${e.tenant}, ${l!.id})`;
    // El precio de la lista detal: el valor de mercado del retiro (decidido por criterio).
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${e.tenant}, ${e.company}, ${l!.id}, ${e.harina}, 100, now() - interval '3 days'),
                    (${e.tenant}, ${e.company}, ${l!.id}, ${e.cloro}, 50, now() - interval '3 days')`;
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
  for (const [ruta, cuerpo] of [
    ["/v1/accounts/import-template", { company_id: e.company, template_code: "ve_basico" }],
    ["/v1/journal-templates/import-preset", { company_id: e.company, preset_code: "ve_basico" }],
  ] as const) {
    expect((await pedir(e, "POST", ruta, cuerpo)).status).toBe(201);
  }
  // ENTRADA del fixture (ADR-0082, AF3-06): la empresa lleva su contabilidad desde antes de hoy.
  // El plan recién importado rige desde el instante de la importación, y un retiro fechado AYER
  // no encontraría sus cuentas: iría a la cola de pendientes en vez de asentarse. Un negocio real
  // que corrige un retiro de ayer tenía su plan ayer.
  await sql`update public.company_account_settings
               set effective_from = now() - interval '5 days'
             where company_id = ${e.company} and effective_from > now() - interval '5 days'`;
  await sql`update public.companies
               set activity_start_date = platform.caracas_day(now() - interval '5 days')
             where id = ${e.company}`;
  // Existencia inicial: 20 harinas a 40 Bs, 10 cloros a 20 Bs, en el Principal.
  for (const [producto, cantidad, unitario] of [
    [e.harina, "20", "40"],
    [e.cloro, "10", "20"],
  ] as const) {
    const r = await pedir(e, "POST", "/v1/inventory/receipts", {
      company_id: e.company,
      warehouse_id: e.w1,
      product_id: producto,
      quantity: cantidad,
      unit_amount: unitario,
      currency: "VES",
      origin: "aporte",
    });
    expect(r.status).toBe(201);
  }
  return e;
}

async function enVerde(e: Empresa): Promise<void> {
  const [g] = await sql<{ diferencia: string }[]>`
    select diferencia::text from platform.inventory_ledger_gap(${e.company})`;
  expect(Number(g!.diferencia), "inventory_ledger_gap").toBe(0);
  expect(
    await sql`select * from platform.inventory_coverage_gaps(${e.company})`,
    "inventory_coverage_gaps",
  ).toHaveLength(0);
  expect(
    await sql`select * from platform.stock_reconciliation(${e.company})`,
    "stock_reconciliation",
  ).toHaveLength(0);
  const libro = await sql<{ concepto: string; cuadra: boolean; diferencia: string }[]>`
    select concepto, cuadra, diferencia::text
      from platform.book_ledger_reconciliation(${e.company}, ${DESDE}::date, ${HASTA}::date)`;
  for (const fila of libro) expect(fila.cuadra, JSON.stringify(fila)).toBe(true);
  expect(
    await sql`select * from platform.book_ledger_discrepancies(${e.company}, ${DESDE}::date, ${HASTA}::date)`,
    "book_ledger_discrepancies",
  ).toHaveLength(0);
  expect(
    await sql`select * from platform.withdrawal_note_gaps(${e.company})`,
    "withdrawal_note_gaps",
  ).toHaveLength(0);
  // ADR-0082: la factura de retiro es factura para lo fiscal y NO es cartera para nadie. Los
  // invariantes que la cruzan con ventas, contabilidad, talonario y deuda, en cero.
  for (const invariante of [
    "accounting_coverage_gaps",
    "fiscal_amount_gaps",
    "annulled_stock_gaps",
    "annulment_paper_gaps",
    "cent_gaps",
    "receivables_ledger_gap",
    "customer_credit_ledger_gap",
    "settled_ledger_gaps",
    "rules_version_gaps",
  ]) {
    expect(
      await sql`select * from ${sql.unsafe(`platform.${invariante}`)}(${e.company})`,
      invariante,
    ).toHaveLength(0);
  }
  // Global (sin argumentos): ningún número de control repetido por emisor e identificador.
  expect(
    await sql`select * from platform.control_number_collisions()`,
    "control_number_collisions",
  ).toHaveLength(0);
  const [deuda] = await sql<{ deuda: string | null }[]>`
    select platform.customer_debt_today(${e.company})::text as deuda`;
  expect(Number(deuda!.deuda), "customer_debt_today").toBe(0);
  expect(await sql`select * from platform.ar_aging(${e.company})`, "ar_aging").toHaveLength(0);
  expect(
    await sql`select * from platform.customer_overdue_today(${e.company})`,
    "customer_overdue_today",
  ).toHaveLength(0);
}

/** El RIF como lo congela un documento: sin guiones y en mayúsculas. */
const rifCongelado = (rif: string): string => rif.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

interface SalidaConFactura {
  id: string;
  withdrawal_note_number: number | null;
  withdrawal_invoice: {
    id: string;
    number: string;
    control_number: string | null;
    tax_amount: string;
    total_amount: string;
    currency: string;
  } | null;
}

/** Las líneas del asiento de un movimiento, por papel de su cuenta. */
async function asientoDe(
  e: Empresa,
  moveId: string,
): Promise<{ purpose: string; debe: string; haber: string; descripcion: string }[]> {
  return sql<{ purpose: string; debe: string; haber: string; descripcion: string }[]>`
    select s.purpose, jl.functional_debit::text as debe, jl.functional_credit::text as haber,
           e.description as descripcion
      from public.journal_entries e
      join public.journal_lines jl on jl.entry_id = e.id
      join public.company_account_settings s
        on s.account_id = jl.account_id and s.company_id = e.company_id and s.effective_to is null
     where e.company_id = ${e.company} and e.source_id = ${moveId} and e.status = 'posted'
     order by jl.functional_debit desc, s.purpose`;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  F = await crearEmpresa("formatos_libres");
  R = await crearEmpresa("sin_facturacion");
}, 60_000);

afterAll(async () => {
  if (sql) await borrarTasasOficiales(sql, FUENTE_TASA);
  await sql?.end();
  await sqlApi?.end();
});

describe("salida con motivo (I-01, I-02, I-11)", () => {
  it("una salida SIN motivo se rechaza por el esquema, nombrando el campo", async () => {
    const r = await pedir(F, "POST", "/v1/inventory/issues", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.harina,
      quantity: "1",
    });
    expect(r.status).toBe(422);
    const b = (await r.json()) as { code: string; details?: { path: unknown[] }[] };
    expect(b.code).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(b.details ?? [])).toContain("reason");
  });

  it("un motivo fuera de la lista cerrada se rechaza por el esquema", async () => {
    const r = await pedir(F, "POST", "/v1/inventory/issues", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.harina,
      quantity: "1",
      reason: "se lo llevó alguien",
    });
    expect(r.status).toBe(422);
    const b = (await r.json()) as { details?: unknown };
    expect(JSON.stringify(b.details ?? [])).toContain("reason");
  });

  it("una merma SIN evidencia no es faltante justificado: 422 (RLIVA art. 14)", async () => {
    const r = await pedir(F, "POST", "/v1/inventory/issues", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.harina,
      quantity: "1",
      reason: "merma",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain("evidencia");
  });

  it("un retiro fechado en un período ya declarado se rechaza (criterio B-1)", async () => {
    await sql`insert into public.iva_period_results
                (tenant_id, company_id, period_from, period_to, debitos, creditos,
                 creditos_deducibles, retenciones_soportadas, excedente_anterior, cuota_a_pagar,
                 excedente_siguiente, detalle, generator_version, dataset_hash)
              values (${F.tenant}, ${F.company}, ${diaCaracas(-40)}::date, ${diaCaracas(-10)}::date,
                      0, 0, 0, 0, 0, 0, 0, '{}'::jsonb, 'e2e', 'e2e')`;
    const r = await pedir(F, "POST", "/v1/inventory/issues", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.harina,
      quantity: "1",
      reason: "muestra",
      occurred_at: `${diaCaracas(-15)}T16:00:00.000Z`,
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain("ya se declaró");
  });

  it("la merma se guarda con su motivo y va a «Pérdidas por mermas y faltantes», no a 5.1.04", async () => {
    const r = await pedir(F, "POST", "/v1/inventory/issues", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.harina,
      quantity: "2",
      reason: "merma",
      evidence: "acta 12, foto del saco roto",
      reference: "saco roto",
    });
    expect(r.status).toBe(201);
    const m = (await r.json()) as { id: string; exit_reason: string; functional_amount: string };
    expect(m.exit_reason).toBe("merma");
    const [fila] = await sql<{ exit_reason: string }[]>`
      select exit_reason from public.inventory_moves where id = ${m.id}`;
    expect(fila!.exit_reason).toBe("merma");
    const lineas = await asientoDe(F, m.id);
    expect(lineas.map((l) => [l.purpose, l.debe, l.haber])).toEqual([
      ["inventory_shrinkage", "80.00000000", "0.00000000"],
      ["inventory_general", "0.00000000", "80.00000000"],
    ]);
    expect(lineas[0]!.descripcion).toContain("merma");
    const [cuenta] = await sql<{ code: string; name: string }[]>`
      select a.code, a.name from public.accounts a
        join public.company_account_settings s on s.account_id = a.id
       where s.company_id = ${F.company} and s.purpose = 'inventory_shrinkage'
         and s.effective_to is null`;
    expect(cuenta!.name).toBe("Pérdidas por mermas y faltantes de inventario");
    await enVerde(F);
  });

  it("el consumo propio es un RETIRO y se FACTURA (RLIVA art. 31, ADR-0082): factura con control del talonario, a nombre de la propia empresa, sin cuenta por cobrar, y va al libro de ventas", async () => {
    const r = await pedir(F, "POST", "/v1/inventory/issues", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.harina,
      quantity: "2",
      reason: "consumo_propio",
    });
    expect(r.status).toBe(201);
    const m = (await r.json()) as SalidaConFactura;
    // Ya no hay Nota de retiro (serie NR, sin control): ni en la respuesta ni en su tabla.
    expect(m.withdrawal_note_number).toBeNull();
    expect(
      await sql`select 1 from public.inventory_withdrawal_notes where company_id = ${F.company}`,
    ).toHaveLength(0);
    // 2 × 100 Bs de la lista detal = 200; IVA 16 % = 32.
    expect(m.withdrawal_invoice).toMatchObject({
      tax_amount: "32.00000000",
      total_amount: "232.00000000",
      currency: "VES",
    });
    expect(m.withdrawal_invoice!.control_number).not.toBeNull();
    const [doc] = await sql<Record<string, string | null>[]>`
      select d.kind, d.status, d.series, d.document_number::text as document_number,
             d.control_number::text as control_number, d.control_identifier,
             d.subtotal_amount::text as subtotal_amount, d.tax_amount::text as tax_amount,
             d.customer_tax_id_snapshot, d.issuer_tax_id_snapshot, d.customer_name_snapshot,
             d.customer_taxpayer_type_snapshot, d.withdrawal_move_id, d.due_date::text as due_date,
             platform.taxpayer_type_at(d.company_id, platform.caracas_day(d.issued_at)) as tipo_historia,
             (select m.source_document_id from public.inventory_moves m
               where m.id = d.withdrawal_move_id) as documento_de_la_salida
        from public.documents d where d.id = ${m.withdrawal_invoice!.id}`;
    expect(doc).toEqual({
      kind: "withdrawal_invoice",
      status: "issued",
      series: "A",
      // El correlativo de la serie de FACTURAS y el control del talonario: los dos consumidos.
      document_number: "1",
      control_number: "1",
      control_identifier: "00",
      subtotal_amount: "200.00000000",
      tax_amount: "32.00000000",
      // El adquirente es la propia empresa, congelado.
      customer_tax_id_snapshot: rifCongelado(F.rif),
      issuer_tax_id_snapshot: rifCongelado(F.rif),
      customer_name_snapshot: "Bodega salidas formatos_libres",
      // AF3-07: el tipo de la HISTORIA a la fecha, no un «ordinario por omisión».
      customer_taxpayer_type_snapshot: doc!["tipo_historia"],
      tipo_historia: "ordinario",
      withdrawal_move_id: m.id,
      due_date: null,
      documento_de_la_salida: m.withdrawal_invoice!.id,
    });
    const [talonario] = await sql<{ next_available: string }[]>`
      select next_available::text from public.fiscal_number_ranges
       where company_id = ${F.company} and series = 'A'`;
    expect(talonario!.next_available).toBe("2");
    // Sin cuenta por cobrar: ni un cobro posible, ni una línea en cuentas por cobrar.
    const cobro = await pedir(F, "POST", "/v1/payments", {
      company_id: F.company,
      document_id: m.withdrawal_invoice!.id,
      currency: "VES",
      amount: "232.00",
      instrument: "transferencia",
      reference: "no debe entrar",
    });
    expect(cobro.status).toBe(422);
    expect(((await cobro.json()) as { message: string }).message).toContain(
      "Una factura de retiro no se cobra",
    );
    expect(
      await sql`select 1 from public.payments where document_id = ${m.withdrawal_invoice!.id}`,
    ).toHaveLength(0);
    const lineas = await asientoDe(F, m.id);
    expect(lineas.map((l) => [l.purpose, l.debe, l.haber])).toEqual([
      ["inventory_withdrawal", "80.00000000", "0.00000000"],
      ["inventory_withdrawal", "32.00000000", "0.00000000"],
      ["inventory_general", "0.00000000", "80.00000000"],
      ["iva_debit_fiscal", "0.00000000", "32.00000000"],
    ]);
    expect(lineas[0]!.descripcion).toContain("Factura de retiro");
    const libro = await sql<
      {
        kind: string;
        customer_tax_id: string;
        control_number: string | null;
        base_gravada: string;
        iva_debito: string;
        con_asiento: boolean;
      }[]
    >`select kind, customer_tax_id, control_number::text as control_number, base_gravada::text,
             iva_debito::text, journal_entry_id is not null as con_asiento
        from platform.sales_book(${F.company}, ${DESDE}::date, ${HASTA}::date)`;
    expect(libro).toEqual([
      {
        kind: "withdrawal_invoice",
        customer_tax_id: rifCongelado(F.rif),
        control_number: "1",
        base_gravada: "200.00000000",
        iva_debito: "32.00000000",
        con_asiento: true,
      },
    ]);
    const [porTasa] = await sql<{ base_alicuota_general: string; iva_alicuota_general: string }[]>`
      select base_alicuota_general::text, iva_alicuota_general::text
        from platform.sales_book_by_rate(${F.company}, ${DESDE}::date, ${HASTA}::date)`;
    expect(porTasa).toEqual({
      base_alicuota_general: "200.00000000",
      iva_alicuota_general: "32.00000000",
    });
    const [declara] = await sql<{ debitos: string }[]>`
      select debitos::text from platform.recompute_iva_period(${F.company}, ${DESDE}::date,
                                                              ${HASTA}::date, 0)`;
    expect(Number(declara!.debitos)).toBe(32);
    await enVerde(F);
  });

  it("el regalo es otro retiro: su factura sigue el correlativo y el control del talonario", async () => {
    const r = await pedir(F, "POST", "/v1/inventory/issues", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.cloro,
      quantity: "1",
      reason: "regalo",
    });
    expect(r.status).toBe(201);
    const m = (await r.json()) as SalidaConFactura;
    expect(m.withdrawal_note_number).toBeNull();
    const [doc] = await sql<{ n: string; c: string }[]>`
      select document_number::text as n, control_number::text as c
        from public.documents where id = ${m.withdrawal_invoice!.id}`;
    expect(doc).toEqual({ n: "2", c: "2" });
    await enVerde(F);
  });

  it("en una empresa sin RIF el retiro deja solo la salida y el gasto: sin nota y sin débito", async () => {
    const r = await pedir(R, "POST", "/v1/inventory/issues", {
      company_id: R.company,
      warehouse_id: R.w1,
      product_id: R.harina,
      quantity: "1",
      reason: "donacion",
    });
    expect(r.status).toBe(201);
    const m = (await r.json()) as SalidaConFactura;
    expect(m.withdrawal_note_number).toBeNull();
    expect(m.withdrawal_invoice).toBeNull();
    expect(
      await sql`select 1 from public.inventory_withdrawal_notes where company_id = ${R.company}`,
    ).toHaveLength(0);
    expect(await sql`select 1 from public.documents where company_id = ${R.company}`).toHaveLength(
      0,
    );
    const lineas = await asientoDe(R, m.id);
    expect(lineas.map((l) => [l.purpose, l.debe, l.haber])).toEqual([
      ["inventory_withdrawal", "40.00000000", "0.00000000"],
      ["inventory_general", "0.00000000", "40.00000000"],
    ]);
    await enVerde(R);
  });
});

describe("conteo (I-07)", () => {
  it("la persona escribe lo contado; el sistema calcula la diferencia y la propone", async () => {
    const vista = await pedir(F, "POST", "/v1/inventory/counts", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.harina,
      counted: "15",
      reason: "conteo de fin de mes",
      preview: true,
    });
    expect(vista.status).toBe(200);
    const v = (await vista.json()) as { system_quantity: string; delta: string; move: unknown };
    // 20 − 2 (merma) − 2 (consumo propio) = 16 en el sistema; contadas 15.
    expect(v).toMatchObject({ system_quantity: "16.00000000", delta: "-1.00000000", move: null });
    const [antes] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.inventory_moves where company_id = ${F.company}`;

    const hecho = await pedir(F, "POST", "/v1/inventory/counts", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.harina,
      counted: "15",
      reason: "conteo de fin de mes",
      evidence: "acta de conteo 2026-10 firmada",
    });
    expect(hecho.status).toBe(201);
    const h = (await hecho.json()) as {
      delta: string;
      move: { kind: string; quantity: string; quantity_after: string; reason: string };
    };
    expect(h.delta).toBe("-1.00000000");
    expect(h.move).toMatchObject({
      kind: "ajuste",
      quantity: "-1.00000000",
      quantity_after: "15.00000000",
    });
    expect(h.move.reason).toContain("conteo de fin de mes");
    const [despues] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.inventory_moves where company_id = ${F.company}`;
    expect(Number(despues!.n) - Number(antes!.n)).toBe(1);
    await enVerde(F);
  });

  it("si el sistema cambió desde la vista previa, el conteo responde 409 y no escribe", async () => {
    const r = await pedir(F, "POST", "/v1/inventory/counts", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.harina,
      counted: "14",
      reason: "conteo viejo",
      expected_system_quantity: "16",
    });
    expect(r.status).toBe(409);
    const b = (await r.json()) as { code: string; message: string };
    expect(b.code).toBe("CONFLICT");
    expect(b.message).toContain("15");
  });

  it("un producto con lotes exige el lote contado, antes de tocar la posición", async () => {
    const r = await pedir(F, "POST", "/v1/inventory/counts", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.lotes,
      counted: "3",
      reason: "conteo de lotes",
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain(
      "Elige el lote que contaste",
    );
    expect(
      await sql`select 1 from public.stock_balances where product_id = ${F.lotes} and lot_id is null`,
    ).toHaveLength(0);
  });

  it("lo contado igual al sistema no inventa un ajuste", async () => {
    const r = await pedir(F, "POST", "/v1/inventory/counts", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.harina,
      counted: "15",
      reason: "recuento",
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ delta: "0.00000000", move: null });
  });
});

describe("conteo: el faltante es pérdida (I-07 + §2.13)", () => {
  it("el faltante de un conteo con motivo va a 5.1.08, no a 5.1.04", async () => {
    const r = await pedir(F, "POST", "/v1/inventory/counts", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.harina,
      counted: "14",
      reason: "faltó un saco en el conteo",
      expected_system_quantity: "15",
      evidence: "foto del estante y acta 0042",
    });
    expect(r.status).toBe(201);
    const h = (await r.json()) as { move: { id: string } };
    const lineas = await asientoDe(F, h.move.id);
    expect(lineas.map((l) => [l.purpose, l.debe, l.haber])).toEqual([
      ["inventory_shrinkage", "40.00000000", "0.00000000"],
      ["inventory_general", "0.00000000", "40.00000000"],
    ]);
    // La evidencia queda en el movimiento, en su columna (re-revisión B1).
    const [m] = await sql<{ exit_evidence: string | null }[]>`
      select exit_evidence from public.inventory_moves where id = ${h.move.id}`;
    expect(m!.exit_evidence).toBe("foto del estante y acta 0042");
    await enVerde(F);
  });

  it("un conteo con faltante SIN evidencia se rechaza y no escribe (RLIVA art. 14)", async () => {
    const [antes] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.inventory_moves where company_id = ${F.company}`;
    const r = await pedir(F, "POST", "/v1/inventory/counts", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.harina,
      counted: "13",
      reason: "faltó otro saco",
    });
    expect(r.status).toBe(422);
    const b = (await r.json()) as { code: string; message: string };
    expect(b.code).toBe("VALIDATION_FAILED");
    // El mensaje que SOLO produce el conteo (no el de la salida ni el del esquema).
    expect(b.message).toContain("El conteo dio un faltante");
    const [despues] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.inventory_moves where company_id = ${F.company}`;
    expect(despues!.n).toBe(antes!.n);
    // La vista previa no la pide: la persona todavía no sabe que falta.
    const vista = await pedir(F, "POST", "/v1/inventory/counts", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.harina,
      counted: "13",
      reason: "faltó otro saco",
      preview: true,
    });
    expect(vista.status).toBe(200);
  });

  it("un sobrante no pide evidencia y va contra ajuste de inventario", async () => {
    const r = await pedir(F, "POST", "/v1/inventory/counts", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.harina,
      counted: "15",
      reason: "apareció un saco detrás",
    });
    expect(r.status).toBe(201);
    const h = (await r.json()) as { delta: string; move: { id: string } };
    expect(h.delta).toBe("1.00000000");
    const lineas = await asientoDe(F, h.move.id);
    expect(lineas.map((l) => [l.purpose, l.debe, l.haber])).toEqual([
      ["inventory_general", "40.00000000", "0.00000000"],
      ["inventory_adjustment", "0.00000000", "40.00000000"],
    ]);
    await enVerde(F);
  });
});

describe("un evento por hecho, con el nombre de su hecho contable (pgTAP 026)", () => {
  it("el outbox, el acta y el asiento de cada movimiento llevan el MISMO nombre", async () => {
    // Todo movimiento suelto de F hasta aquí: mermas, retiros, conteos (faltante y sobrante).
    const filas = await sql<
      {
        kind: string;
        exit_reason: string | null;
        outbox: string | null;
        acta: string | null;
        asiento: string | null;
      }[]
    >`
      select m.kind, m.exit_reason,
             (select string_agg(o.event_type, ',' order by o.event_type) from public.outbox o
               where o.aggregate_type = 'inventory_move' and o.aggregate_id = m.id) as outbox,
             (select string_agg(a.event_type, ',' order by a.event_type) from public.audit_events a
               where a.aggregate_type = 'inventory_move' and a.aggregate_id = m.id
                 and a.event_type like 'stock.%') as acta,
             (select string_agg(e.source_event, ',' order by e.source_event)
                from public.journal_entries e
               where e.source_kind = 'inventory_move' and e.source_id = m.id) as asiento
        from public.inventory_moves m
       where m.company_id = ${F.company} and (m.kind = 'ajuste' or m.exit_reason is not null)`;
    const esperado = (f: { kind: string; exit_reason: string | null }): string =>
      f.kind === "ajuste"
        ? "stock.counted"
        : ["merma", "rotura", "vencido", "faltante"].includes(f.exit_reason ?? "")
          ? "stock.shrinkage"
          : "stock.withdrawn";
    for (const f of filas) {
      expect(f, JSON.stringify(f)).toMatchObject({
        outbox: esperado(f),
        acta: esperado(f),
        asiento: esperado(f),
      });
    }
    // Los tres hechos están de verdad en la muestra (que el bucle no pase vacío).
    expect(new Set(filas.map(esperado))).toEqual(
      new Set(["stock.counted", "stock.shrinkage", "stock.withdrawn"]),
    );
  });
});

describe("inactivo = no se vende (I-05, §2.12)", () => {
  it("la venta de un producto inactivo se rechaza", async () => {
    const cliente = crypto.randomUUID();
    await sql`insert into public.customers (id, tenant_id, company_id, legal_name,
                                            person_type_code, taxpayer_type_code)
              values (${cliente}, ${R.tenant}, ${R.company}, 'Vecino', 'natural', 'consumidor_final')`;
    await sql`update public.products set status = 'inactive' where id = ${R.cloro}`;
    const v = await pedir(R, "POST", "/v1/pos/sales", {
      company_id: R.company,
      warehouse_id: R.w1,
      customer_id: cliente,
      lines: [{ product_id: R.cloro, quantity: "1" }],
      payments: [{ instrument: "efectivo_bs", amount: "50.00000000", currency: "VES" }],
    });
    expect(v.status).toBe(422);
    expect(((await v.json()) as { message: string }).message).toContain("no está activo");
  });

  // El cambio de apply_inventory_move lo hace la familia del céntimo (migración 20261003140000):
  // este caso corre en cuanto esa migración está aplicada (se pregunta a la base al cargar).
  it.runIf(CENTIMO_APLICADO)("una salida por vencido de un producto inactivo entra", async () => {
    const r = await pedir(R, "POST", "/v1/inventory/issues", {
      company_id: R.company,
      warehouse_id: R.w1,
      product_id: R.cloro,
      quantity: "1",
      reason: "vencido",
      evidence: "lote vencido, acta 3",
    });
    expect(r.status).toBe(201);
    await enVerde(R);
  });
});

describe("«por agotarse» (I-12, P-10)", () => {
  it("cuenta la existencia que está en lotes y excluye los inactivos", async () => {
    const llegada = await pedir(F, "POST", "/v1/inventory/receipts", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.lotes,
      quantity: "10",
      unit_amount: "5",
      currency: "VES",
      origin: "aporte",
      lot_code: `L-${RUN}`,
      lot_expires_at: diaCaracas(60),
    });
    expect(llegada.status).toBe(201);
    await sql`insert into public.product_stock_thresholds
                (tenant_id, company_id, warehouse_id, product_id, stock_min)
              values (${F.tenant}, ${F.company}, ${F.w1}, ${F.lotes}, 5),
                     (${F.tenant}, ${F.company}, ${F.w1}, ${F.cloro}, 50)`;
    const antes = await sql<{ product_id: string }[]>`
      select product_id from platform.low_stock_products(${F.company})`;
    // El yogur tiene 10 en lote frente a un mínimo de 5: no está por agotarse.
    expect(antes.map((x) => x.product_id)).toEqual([F.cloro]);
    await sql`update public.products set status = 'inactive' where id = ${F.cloro}`;
    expect(await sql`select 1 from platform.low_stock_products(${F.company})`).toHaveLength(0);
  });
});

/**
 * EL RETIRO SE FACTURA (ADR-0082; auditoría fiscal de la ola 3, AF3-01 a AF3-07). Va al final del
 * fichero: estas salidas mueven existencia y no deben cambiar las cifras de los bloques de arriba.
 */
describe("el retiro se factura (ADR-0082)", () => {
  const salir = (e: Empresa, cuerpo: Record<string, unknown>) =>
    pedir(e, "POST", "/v1/inventory/issues", {
      company_id: e.company,
      warehouse_id: e.w1,
      ...cuerpo,
    });
  const movimientos = async (e: Empresa): Promise<number> =>
    (await sql`select 1 from public.inventory_moves where company_id = ${e.company}`).length;

  it("AF3-03 · uso en el negocio, activo fijo e inmueble del negocio NO son gravados: salen del kardex sin factura y sin débito", async () => {
    const [antes] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.documents where company_id = ${F.company}`;
    for (const motivo of ["uso_en_negocio", "activo_fijo", "incorporado_inmueble"]) {
      // AF5-07: sin su nota de destino —o con una que no dice nada— no sale: es la puerta por
      // la que un consumo propio saldría sin IVA.
      const n = await movimientos(F);
      for (const destino of [undefined, "abc", "deposito"]) {
        const sin = await salir(F, {
          product_id: F.harina,
          quantity: "1",
          reason: motivo,
          ...(destino === undefined ? {} : { evidence: destino }),
        });
        expect(sin.status, `${motivo} ${destino}`).toBe(422);
        expect(((await sin.json()) as { message: string }).message).toContain("di adónde fue");
      }
      expect(await movimientos(F)).toBe(n);
      const destino = `Harina para ${motivo}, depósito de la sede`;
      const r = await salir(F, {
        product_id: F.harina,
        quantity: "1",
        reason: motivo,
        evidence: destino,
      });
      expect(r.status, motivo).toBe(201);
      const m = (await r.json()) as SalidaConFactura & { exit_reason: string };
      expect(m.exit_reason).toBe(motivo);
      const [guardado] = await sql<{ exit_evidence: string | null }[]>`
        select exit_evidence from public.inventory_moves where id = ${m.id}`;
      expect(guardado!.exit_evidence).toBe(destino);
      expect(m.withdrawal_invoice, motivo).toBeNull();
      const lineas = await asientoDe(F, m.id);
      // Al costo (40 Bs la harina), sin una línea de débito fiscal, y a la cuenta de SU papel:
      // lo usado en el giro es gasto de operación; lo que se queda en el negocio es activo fijo.
      const papel = motivo === "uso_en_negocio" ? "operating_expense" : "fixed_assets";
      expect(
        lineas.map((l) => [l.purpose, l.debe, l.haber]),
        motivo,
      ).toEqual([
        [papel, "40.00000000", "0.00000000"],
        ["inventory_general", "0.00000000", "40.00000000"],
      ]);
      expect(lineas[0]!.descripcion).toContain("Salida no gravada");
      // Un evento por hecho, con el nombre de su hecho contable (pgTAP 026).
      const evento = motivo === "uso_en_negocio" ? "stock.used_in_business" : "stock.capitalized";
      const [nombres] = await sql<{ outbox: string; asiento: string }[]>`
        select (select o.event_type from public.outbox o
                 where o.aggregate_type = 'inventory_move' and o.aggregate_id = ${m.id}) as outbox,
               (select e.source_event from public.journal_entries e
                 where e.source_kind = 'inventory_move' and e.source_id = ${m.id}) as asiento`;
      expect(nombres, motivo).toEqual({ outbox: evento, asiento: evento });
    }
    // La cuenta de activo es la provisional del plan (P-82): 1.2.01 bajo 1.2.
    const [activo] = await sql<{ code: string; name: string; padre: string }[]>`
      select a.code, a.name, p.code as padre
        from public.company_account_settings s
        join public.accounts a on a.id = s.account_id
        join public.accounts p on p.id = a.parent_id
       where s.company_id = ${F.company} and s.purpose = 'fixed_assets'`;
    expect(activo).toEqual({ code: "1.2.01", name: "Propiedad, planta y equipo", padre: "1.2" });
    const [despues] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.documents where company_id = ${F.company}`;
    expect(despues!.n).toBe(antes!.n);
    await enVerde(F);
  });

  it("AF3-05 · sin precio de venta, o con precio cero, el retiro se rechaza y no escribe nada", async () => {
    const n = await movimientos(F);
    // El yogur no tiene precio en la lista principal.
    const sinPrecio = await salir(F, { product_id: F.lotes, quantity: "1", reason: "muestra" });
    expect(sinPrecio.status).toBe(422);
    expect(((await sinPrecio.json()) as { message: string }).message).toContain(
      "no tiene precio en tu lista de precios principal",
    );
    await sql`insert into public.price_list_items
                (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
              select ${F.tenant}, ${F.company}, cs.default_price_list_id, ${F.lotes}, 0,
                     now() - interval '1 hour'
                from public.company_settings cs where cs.company_id = ${F.company}`;
    const enCero = await salir(F, { product_id: F.lotes, quantity: "1", reason: "muestra" });
    expect(enCero.status).toBe(422);
    expect(((await enCero.json()) as { message: string }).message).toContain("precio cero");
    expect(await movimientos(F)).toBe(n);
    const [talonario] = await sql<{ next_available: string }[]>`
      select next_available::text from public.fiscal_number_ranges
       where company_id = ${F.company} and series = 'A'`;
    // Ni un número de control gastado en un retiro que no ocurrió.
    expect(talonario!.next_available).toBe("3");
  });

  it("AF3-04 · la evidencia de una pérdida dice algo: «abc» ya no pasa", async () => {
    const n = await movimientos(F);
    for (const evidencia of ["abc", "acta", "1234567890"]) {
      const r = await salir(F, {
        product_id: F.harina,
        quantity: "1",
        reason: "rotura",
        evidence: evidencia,
      });
      expect(r.status, evidencia).toBe(422);
      expect(((await r.json()) as { message: string }).message).toContain("al menos dos palabras");
    }
    expect(await movimientos(F)).toBe(n);
    // AF3-02b: el faltante sin evidencia sigue rechazado (no se factura con una base inventada).
    const faltante = await salir(F, { product_id: F.harina, quantity: "1", reason: "faltante" });
    expect(faltante.status).toBe(422);
    expect(await movimientos(F)).toBe(n);
  });

  it("si el stock no alcanza, ni la factura ni su número de control quedan: todo o nada", async () => {
    const [antes] = await sql<{ docs: number; proximo: string }[]>`
      select (select count(*)::int from public.documents where company_id = ${F.company}) as docs,
             (select next_available::text from public.fiscal_number_ranges
               where company_id = ${F.company} and series = 'A') as proximo`;
    const r = await salir(F, { product_id: F.harina, quantity: "9999", reason: "regalo" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const [despues] = await sql<{ docs: number; proximo: string }[]>`
      select (select count(*)::int from public.documents where company_id = ${F.company}) as docs,
             (select next_available::text from public.fiscal_number_ranges
               where company_id = ${F.company} and series = 'A') as proximo`;
    expect(despues).toEqual(antes);
    await enVerde(F);
  });

  it("AF3-06 · un retiro emitido por error se anula el mismo día con el papel en la mano: vuelve la mercancía y se revierte el débito", async () => {
    const [stock0] = await sql<{ q: string; v: string }[]>`
      select quantity::text as q, value::text as v from public.stock_balances
       where company_id = ${F.company} and warehouse_id = ${F.w1} and product_id = ${F.harina}
         and lot_id is null`;
    const r = await salir(F, { product_id: F.harina, quantity: "1", reason: "donacion" });
    expect(r.status).toBe(201);
    const m = (await r.json()) as SalidaConFactura;
    const factura = m.withdrawal_invoice!.id;

    // Sin confirmar el original y las copias, la regla del papel no deja (G-10).
    const sinPapel = await pedir(F, "POST", `/v1/invoices/${factura}/annul`, {
      company_id: F.company,
      reason: "se registró por error",
    });
    expect(sinPapel.status).toBe(409);
    expect(((await sinPapel.json()) as { code: string }).code).toBe("ANNULMENT_NOT_ALLOWED");

    const anular = await pedir(F, "POST", `/v1/invoices/${factura}/annul`, {
      company_id: F.company,
      reason: "se registró por error",
      originals_in_hand: true,
    });
    expect(anular.status).toBe(200);
    const [doc] = await sql<{ status: string; n: string; c: string }[]>`
      select status, document_number::text as n, control_number::text as c
        from public.documents where id = ${factura}`;
    // Anulada, y conserva su correlativo y su control (ADR-0037).
    expect(doc!.status).toBe("annulled");
    expect(doc!.n).not.toBeNull();
    expect(doc!.c).not.toBeNull();
    // La mercancía volvió, a su valor.
    const [stock1] = await sql<{ q: string; v: string }[]>`
      select quantity::text as q, value::text as v from public.stock_balances
       where company_id = ${F.company} and warehouse_id = ${F.w1} and product_id = ${F.harina}
         and lot_id is null`;
    expect(stock1).toEqual(stock0);
    // El asiento del retiro quedó reversado: ni gasto ni débito fiscal de esa factura.
    const [asiento] = await sql<{ status: string }[]>`
      select status from public.journal_entries
       where company_id = ${F.company} and source_kind = 'inventory_move'
         and source_id = ${m.id} and source_event = 'stock.withdrawn'
         and is_reversal_of is null`;
    expect(asiento!.status).toBe("reversed");
    const [renglon] = await sql<{ status: string; iva: string }[]>`
      select status, iva_debito::text as iva
        from platform.sales_book(${F.company}, ${DESDE}::date, ${HASTA}::date)
       where document_id = ${factura}`;
    expect(renglon).toEqual({ status: "annulled", iva: "0.00000000" });
    await enVerde(F);
  });

  // ── Segunda ronda (migraciones 20261005100400 y 100500) ───────────────────────────────────
  const estado = async (e: Empresa) => {
    const [x] = await sql<Record<string, string | number | null>[]>`
      select (select count(*)::int from public.inventory_moves where company_id = ${e.company})
               as movimientos,
             (select count(*)::int from public.documents where company_id = ${e.company})
               as documentos,
             (select count(*)::int from public.journal_entries where company_id = ${e.company})
               as asientos,
             (select next_available::text from public.fiscal_number_ranges
               where company_id = ${e.company} and series = 'A') as control,
             platform.claim_document_number(${e.company}, 'invoice', 'A')::text as numero`;
    return x!;
  };

  it("la vista previa dice qué se va a emitir con sus cifras, y NO gasta número ni control", async () => {
    const antes = await estado(F);
    const previa = (motivo: string, e: Empresa = F, extra: Record<string, unknown> = {}) =>
      pedir(e, "POST", "/v1/inventory/issues/preview", {
        company_id: e.company,
        warehouse_id: e.w1,
        product_id: e.harina,
        quantity: "1",
        reason: motivo,
        ...extra,
      });
    const retiro = await previa("consumo_propio");
    expect(retiro.status).toBe(200);
    // 1 × 100 Bs de la lista = 100; IVA 16 % = 16. La serie, sin número: se asigna al emitir.
    expect(await retiro.json()).toEqual({
      emits: "withdrawal_invoice",
      why: "retiro",
      series: "A",
      subtotal_amount: "100.00000000",
      tax_amount: "16.00000000",
      total_amount: "116.00000000",
      currency: "VES",
    });
    const nada = {
      series: null,
      subtotal_amount: null,
      tax_amount: null,
      total_amount: null,
      currency: null,
    };
    expect(
      await (await previa("activo_fijo", F, { evidence: "Estante para el depósito" })).json(),
    ).toEqual({
      emits: "nothing",
      why: "no_gravado",
      ...nada,
    });
    expect(
      await (await previa("merma", F, { evidence: "acta 77 del conteo de octubre" })).json(),
    ).toEqual({ emits: "nothing", why: "perdida", ...nada });
    expect(await (await previa("regalo", R)).json()).toEqual({
      emits: "nothing",
      why: "sin_rif",
      ...nada,
    });
    // Un rechazo sale en la vista previa igual que saldría al confirmar.
    const sinStock = await previa("regalo", F, { quantity: "9999" });
    expect(sinStock.status).toBe(409);
    // Nada se movió y nada se gastó: ni kardex, ni documento, ni asiento, ni control, ni número.
    expect(await estado(F)).toEqual(antes);
  });

  // El «día siguiente» aquí es la REGLA (`invoice_annulment_blockers` con el reloj de mañana), no
  // la puerta: por la API no se fabrica otro día. La factura del mes anterior con su nota hoy la
  // fabrica el pgTAP 134c.
  it("AF3-06 · la REGLA de la anulación dice que mañana este retiro ya no se anula (not_same_day); se corrige con su nota de crédito, que devuelve la mercancía, revierte el débito y resta en el libro y en la declaración", async () => {
    const saldo = async () => {
      const [s] = await sql<{ q: string; v: string }[]>`
        select quantity::text as q, value::text as v from public.stock_balances
         where company_id = ${F.company} and warehouse_id = ${F.w1} and product_id = ${F.harina}
           and lot_id is null`;
      return s;
    };
    const declarado = async () => {
      const [d] = await sql<{ debitos: string }[]>`
        select debitos::text from platform.recompute_iva_period(${F.company}, ${DESDE}::date,
                                                                ${HASTA}::date, 0)`;
      return Number(d!.debitos);
    };
    const stock0 = await saldo();
    const debitos0 = await declarado();
    const r = await salir(F, {
      product_id: F.harina,
      quantity: "2",
      reason: "muestra",
    });
    expect(r.status).toBe(201);
    const m = (await r.json()) as SalidaConFactura;
    const factura = m.withdrawal_invoice!.id;
    expect(await declarado()).toBe(debitos0 + 32);

    // AL DÍA SIGUIENTE la regla del papel ya no deja anularla. «Otro día» no se fabrica por la API
    // (AF5-08: la factura de retiro lleva la fecha de hoy, y el servidor fecha la anulación): se
    // le pregunta a la MISMA regla que usa `annulInvoice`, con el reloj de mañana.
    const manana = await sql<{ reason: string }[]>`
      select reason from platform.invoice_annulment_blockers(
        ${F.company}, ${factura}, now() + interval '1 day')`;
    expect(manana.map((b) => b.reason)).toContain("not_same_day");
    const hoy = await sql<{ reason: string }[]>`
      select reason from platform.invoice_annulment_blockers(${F.company}, ${factura}, now())`;
    expect(hoy.map((b) => b.reason)).not.toContain("not_same_day");

    // Y la nota de crédito GENERAL sigue cerrada: mueve cartera. Con un cuerpo VÁLIDO (la línea
    // de la factura, su cantidad) y el permiso de la nota directa, para llegar hasta la guarda
    // del retiro: el mensaje es el que SOLO ella produce.
    const [lineaDeLaFactura] = await sql<{ id: string }[]>`
      select id from public.document_lines where document_id = ${factura}`;
    const general = await pedir(F, "POST", "/v1/credit-notes", {
      company_id: F.company,
      source_document_id: factura,
      reason: "no debe entrar",
      lines: [{ source_line_id: lineaDeLaFactura!.id, quantity: "2" }],
    });
    expect(general.status).toBe(422);
    // Quien la rechaza por la API es la regla del dominio —una nota general corrige una FACTURA
    // (kind invoice), y una factura de retiro no lo es—, con su mensaje EXACTO: antes, con
    // `lines: []`, cualquier 4xx del esquema pasaba la aserción. La guarda de la base (LAD72,
    // «se corrige con su propia nota de crédito») es la segunda capa y la ejerce el pgTAP 134.
    expect(((await general.json()) as { message: string }).message).toBe(
      "Una nota corrige una FACTURA emitida o pagada, nada más.",
    );
    expect(
      await sql`select 1 from public.documents
                 where company_id = ${F.company} and kind = 'credit_note'`,
    ).toHaveLength(0);

    const antes = await estado(F);
    const corregir = await pedir(F, "POST", `/v1/invoices/${factura}/withdrawal-credit-note`, {
      company_id: F.company,
      reason: "la muestra no llegó a salir del negocio",
    });
    expect(corregir.status).toBe(201);
    const nota = (await corregir.json()) as { id: string; kind: string };
    expect(nota.kind).toBe("withdrawal_credit_note");
    const [doc] = await sql<Record<string, string | null>[]>`
      select n.status, n.source_document_id, n.document_number::text as document_number,
             n.control_number::text as control_number, n.rate_basis,
             n.subtotal_amount::text as subtotal_amount, n.tax_amount::text as tax_amount,
             n.total_amount::text as total_amount, n.customer_tax_id_snapshot, n.notes
        from public.documents n where n.id = ${nota.id}`;
    expect(doc).toEqual({
      status: "issued",
      source_document_id: factura,
      // El correlativo es el de las NOTAS DE CRÉDITO (la primera) y el control, el del talonario.
      document_number: "1",
      control_number: String(antes["control"]),
      rate_basis: "origin",
      // Total: los importes de su factura.
      subtotal_amount: "200.00000000",
      tax_amount: "32.00000000",
      total_amount: "232.00000000",
      customer_tax_id_snapshot: rifCongelado(F.rif),
      notes: "la muestra no llegó a salir del negocio",
    });
    // La mercancía volvió, al costo con que salió.
    expect(await saldo()).toEqual(stock0);
    const [entrada] = await sql<{ id: string; q: string; v: string }[]>`
      select id, quantity::text as q, functional_amount::text as v from public.inventory_moves
       where company_id = ${F.company} and source_document_id = ${nota.id}`;
    expect([entrada!.q, entrada!.v]).toEqual(["2.00000000", "80.00000000"]);
    // Su asiento es el contra-asiento del retiro: inventario y débito fiscal contra el gasto.
    const lineas = await asientoDe(F, entrada!.id);
    // (Las dos líneas del haber van a la misma cuenta: se comparan sin orden.)
    expect(lineas.map((l) => [l.purpose, l.debe, l.haber].join(" ")).sort()).toEqual(
      [
        "inventory_general 80.00000000 0.00000000",
        "iva_debit_fiscal 32.00000000 0.00000000",
        "inventory_withdrawal 0.00000000 80.00000000",
        "inventory_withdrawal 0.00000000 32.00000000",
      ].sort(),
    );
    // Un evento por hecho, con el nombre PROPIO del hecho (20261005100900): no el genérico de
    // toda entrada, cuya plantilla iría contra gasto por retiro.
    const [nombres] = await sql<{ outbox: string; asiento: string }[]>`
      select (select o.event_type from public.outbox o
               where o.aggregate_type = 'inventory_move' and o.aggregate_id = ${entrada!.id}) as outbox,
             (select e.source_event from public.journal_entries e
               where e.source_kind = 'inventory_move' and e.source_id = ${entrada!.id}) as asiento`;
    expect(nombres).toEqual({
      outbox: "stock.withdrawal_returned",
      asiento: "stock.withdrawal_returned",
    });
    // El asiento del retiro sigue vigente en SU día: no se reescribe el pasado.
    const [original] = await sql<{ status: string }[]>`
      select status from public.journal_entries
       where company_id = ${F.company} and source_kind = 'inventory_move'
         and source_id = ${m.id} and source_event = 'stock.withdrawn'`;
    expect(original!.status).toBe("posted");
    // Libro: la nota, en negativo, con su control; la factura sigue con su renglón.
    const libro = await sql<Record<string, string | boolean | null>[]>`
      select kind, base_gravada::text as base, iva_debito::text as iva,
             control_number is not null as con_control, journal_entry_id is not null as con_asiento
        from platform.sales_book(${F.company}, ${DESDE}::date, ${HASTA}::date)
       where document_id in (${factura}, ${nota.id}) order by kind desc`;
    expect(libro).toEqual([
      {
        kind: "withdrawal_invoice",
        base: "200.00000000",
        iva: "32.00000000",
        con_control: true,
        con_asiento: true,
      },
      {
        kind: "withdrawal_credit_note",
        base: "-200.00000000",
        iva: "-32.00000000",
        con_control: true,
        con_asiento: true,
      },
    ]);
    // Declaración: el débito del retiro quedó restado.
    expect(await declarado()).toBe(debitos0);
    // Sin cartera: ni saldo a favor ni cobro.
    expect(
      await sql`select 1 from public.customer_credits where company_id = ${F.company}`,
    ).toHaveLength(0);
    // Una factura, una nota; y corregida, ya no se anula.
    const otra = await pedir(F, "POST", `/v1/invoices/${factura}/withdrawal-credit-note`, {
      company_id: F.company,
      reason: "otra vez",
    });
    expect(otra.status).toBe(422);
    expect(((await otra.json()) as { message: string }).message).toContain("ya se corrigió");
    await enVerde(F);
  });

  it("el papel: la factura de retiro y su nota imprimen lo del art. 13 y la leyenda de retiro", async () => {
    const [f] = await sql<{ id: string; n: string; c: string }[]>`
      select id, document_number::text as n, control_number::text as c from public.documents
       where company_id = ${F.company} and kind = 'withdrawal_invoice' and document_number = 1`;
    const papel = await textoDelPdf(await pedir(F, "GET", `/v1/documents/${f!.id}/pdf`));
    for (const aguja of [
      "FACTURA",
      "Factura por retiro de inventario.",
      "Motivo del retiro: consumo propio.",
      "El adquirente es el propio emisor. No genera cuenta por cobrar.",
      // Emisor y adquirente: la misma razón social (el RIF se viste con guiones al imprimir).
      "Bodega salidas formatos_libres",
      // Base, IVA y total del primer retiro: 200 + 32 = 232.
      "200,00",
      "32,00",
      "232,00",
    ]) {
      expect(tiene(papel, aguja), aguja).toBe(true);
    }
    // AF5-04: el papel no cita un artículo (ni del Reglamento ni de la Ley).
    expect(tiene(papel, "art. 31"), "sin número de artículo").toBe(false);
    expect(tiene(papel, "Reglamento"), "sin cita legal").toBe(false);
    // La razón social sale dos veces: como emisor y como adquirente.
    expect(
      plano(papel).split(plano("Bodega salidas formatos_libres")).length - 1,
    ).toBeGreaterThanOrEqual(2);
    const [n] = await sql<{ id: string }[]>`
      select id from public.documents
       where company_id = ${F.company} and kind = 'withdrawal_credit_note'`;
    const nota = await textoDelPdf(await pedir(F, "GET", `/v1/documents/${n!.id}/pdf`));
    for (const aguja of [
      "NOTA DE CRÉDITO",
      "Factura que corrige:",
      "la muestra no llegó a salir del negocio",
      "Deja sin efecto el retiro de inventario de esa factura",
    ]) {
      expect(tiene(nota, aguja), aguja).toBe(true);
    }
  });

  it("la ficha del adquirente es UNA aunque dos primeros retiros lleguen a la vez, y nace inactiva", async () => {
    const G = await crearEmpresa("formatos_libres", "b", rifNumerico());
    // Otro cliente, de verdad: tiene que SALIR en las tres lecturas (si no saliera, «la ficha
    // propia no aparece» lo cumpliría también una lista vacía o un 403).
    const rifVecino = rifNumerico();
    const [vecino] = await sql<{ id: string }[]>`
      insert into public.customers (tenant_id, company_id, tax_id, legal_name, person_type_code,
                                    taxpayer_type_code)
      values (${G.tenant}, ${G.company}, ${rifVecino}, 'Bodega vecina', 'juridica', 'ordinario')
      returning id`;
    const [a, b] = await Promise.all([
      salir(G, { product_id: G.harina, quantity: "1", reason: "regalo" }),
      salir(G, { product_id: G.cloro, quantity: "1", reason: "muestra" }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const fichas = await sql<
      { id: string; status: string; legal_name: string; own_company: boolean }[]
    >`
      select id, status, legal_name, own_company from public.customers
       where company_id = ${G.company} and id <> ${vecino!.id}`;
    expect(fichas.map(({ id: _id, ...resto }) => resto)).toEqual([
      { status: "inactive", legal_name: "Bodega salidas formatos_libres", own_company: true },
    ]);
    // No es un cliente más: el buscador y la lista no la traen, ni por nombre ni por su RIF…
    for (const ruta of ["/v1/customers?search=Bodega&per_page=8", "/v1/customers?per_page=100"]) {
      const lista = await pedir(G, "GET", ruta);
      expect(lista.status, ruta).toBe(200);
      const cuerpo = JSON.stringify(await lista.json());
      expect(cuerpo, ruta).toContain(vecino!.id);
      expect(cuerpo, ruta).not.toContain(fichas[0]!.id);
    }
    // El buscador exacto por RIF: al vecino lo encuentra; a la ficha propia, 404 (con un RIF que
    // la ruta SÍ acepta buscar: con uno malformado respondía 422 y el filtro no se ejercía).
    const alVecino = await pedir(G, "GET", `/v1/customers/lookup?document=${rifVecino}`);
    expect(alVecino.status).toBe(200);
    expect(((await alVecino.json()) as { id: string }).id).toBe(vecino!.id);
    const aLaPropia = await pedir(G, "GET", `/v1/customers/lookup?document=${G.rif}`);
    expect(aLaPropia.status).toBe(404);
    // Punto 9c: dar de alta un cliente con el RIF del propio negocio choca con la ficha oculta.
    // «Ya existe un cliente con ese RIF» mandaría a buscar algo que no se ve: se dice lo que pasa.
    const alta = await pedir(G, "POST", "/v1/customers", {
      company_id: G.company,
      tax_id: G.rif,
      legal_name: "Mi propio negocio",
      fiscal_address: "Av. Principal, local 3, Caracas",
    });
    expect(alta.status).toBe(422);
    expect(((await alta.json()) as { message: string }).message).toBe(
      "Ese es el RIF de tu propio negocio: no se registra como cliente.",
    );
    // …y no se le vende, aunque alguien mande su id a mano.
    const venta = await pedir(G, "POST", "/v1/invoices", {
      company_id: G.company,
      customer_id: fichas[0]!.id,
      warehouse_id: G.w1,
      lines: [{ product_id: G.harina, quantity: "1" }],
    });
    expect(venta.status).toBe(422);
    expect(((await venta.json()) as { message: string }).message).toContain(
      "es la del propio negocio",
    );
    const numeros = await sql<{ n: string }[]>`
      select document_number::text as n from public.documents
       where company_id = ${G.company} and kind = 'withdrawal_invoice' order by document_number`;
    expect(numeros.map((x) => x.n)).toEqual(["1", "2"]);
    await enVerde(G);
  }, 60_000);

  // ── Tercera ronda ────────────────────────────────────────────────────────────────────────
  it("AF5-02 · el retiro que emite factura lo registra quien puede facturar: el almacenista, 403 con su porqué; la merma, sí", async () => {
    // Un almacenista: mueve mercancía en los dos depósitos y NO tiene sales.invoice.issue.
    const rol = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`insert into auth.users (id) values (${ALMACENISTA}) on conflict (id) do nothing`;
      await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
               (${rol}, null, ${`e2esal_alm_${RUN}`}, 'Almacenista', true)`;
      await tx`insert into public.role_permissions (role_id, permission_key) values
               (${rol}, 'inventory.move')`;
      const mem = crypto.randomUUID();
      const asig = crypto.randomUUID();
      await tx`insert into public.memberships (id, tenant_id, user_id) values
               (${mem}, ${F.tenant}, ${ALMACENISTA})`;
      await tx`insert into public.user_role_assignments
                 (id, tenant_id, membership_id, role_id, company_id) values
               (${asig}, ${F.tenant}, ${mem}, ${rol}, null)`;
      await tx`insert into public.scope_bindings
                 (tenant_id, company_id, assignment_id, scope_type, scope_id)
               values (${F.tenant}, ${F.company}, ${asig}, 'warehouse', ${F.w1})`;
    });
    const antes = await estado(F);
    const cuerpo = {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.harina,
      quantity: "1",
    };
    for (const ruta of ["/v1/inventory/issues", "/v1/inventory/issues/preview"]) {
      const r = await pedir(F, "POST", ruta, { ...cuerpo, reason: "regalo" }, ALMACENISTA);
      expect(r.status, ruta).toBe(403);
      const e = (await r.json()) as { code: string; message: string; person_message: string };
      expect(e.code).toBe("PERMISSION_REQUIRED");
      // Lo que SOLO produce este camino: no «necesitas el permiso para vender».
      expect(e.message, ruta).toContain(
        "Este retiro emite una factura a nombre de tu negocio: lo registra quien puede facturar.",
      );
      expect(e.person_message, ruta).toBe(
        "Este retiro emite una factura a nombre de tu negocio: lo registra quien puede facturar.",
      );
    }
    // Ni kardex, ni documento, ni asiento, ni control, ni número.
    expect(await estado(F)).toEqual(antes);
    // Lo que no emite documento sigue pidiendo solo inventory.move: una merma con su evidencia…
    const merma = await pedir(
      F,
      "POST",
      "/v1/inventory/issues",
      { ...cuerpo, reason: "merma", evidence: "Acta 0031 del conteo de octubre" },
      ALMACENISTA,
    );
    expect(merma.status).toBe(201);
    // …y una salida no gravada con su destino.
    const uso = await pedir(
      F,
      "POST",
      "/v1/inventory/issues",
      { ...cuerpo, reason: "uso_en_negocio", evidence: "Harina para la cocina del personal" },
      ALMACENISTA,
    );
    expect(uso.status).toBe(201);
    // Y en la empresa SIN RIF el mismo almacenista SÍ registra el mismo regalo: allí no se emite
    // factura, y el permiso de facturar se pide solo cuando la hay.
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      const mem = crypto.randomUUID();
      const asig = crypto.randomUUID();
      await tx`insert into public.memberships (id, tenant_id, user_id) values
               (${mem}, ${R.tenant}, ${ALMACENISTA})`;
      await tx`insert into public.user_role_assignments
                 (id, tenant_id, membership_id, role_id, company_id) values
               (${asig}, ${R.tenant}, ${mem}, ${rol}, null)`;
      await tx`insert into public.scope_bindings
                 (tenant_id, company_id, assignment_id, scope_type, scope_id)
               values (${R.tenant}, ${R.company}, ${asig}, 'warehouse', ${R.w1})`;
    });
    const documentosDeR = async (): Promise<number> =>
      (await sql`select 1 from public.documents where company_id = ${R.company}`).length;
    const docsAntes = await documentosDeR();
    const regaloSinRif = await pedir(
      R,
      "POST",
      "/v1/inventory/issues",
      {
        company_id: R.company,
        warehouse_id: R.w1,
        product_id: R.harina,
        quantity: "1",
        reason: "regalo",
      },
      ALMACENISTA,
    );
    expect(regaloSinRif.status).toBe(201);
    expect(((await regaloSinRif.json()) as SalidaConFactura).withdrawal_invoice ?? null).toBeNull();
    expect(await documentosDeR()).toBe(docsAntes);
    await enVerde(F);
  });

  it("AF5-08 · una factura de retiro lleva la fecha de hoy: con otra fecha se rechaza y no escribe; lo que no emite documento conserva la suya", async () => {
    const antes = await estado(F);
    for (const fecha of [`${AYER}T16:00:00.000Z`, `${diaCaracas(-2)}T16:00:00.000Z`]) {
      const r = await salir(F, {
        product_id: F.harina,
        quantity: "1",
        reason: "consumo_propio",
        occurred_at: fecha,
      });
      expect(r.status, fecha).toBe(422);
      expect(((await r.json()) as { message: string }).message).toContain(
        "Una factura de retiro lleva la fecha de hoy",
      );
    }
    expect(await estado(F)).toEqual(antes);
    // Con la fecha de HOY explícita, sí. El instante es de hoy y ya pasó: hace un minuto o, si
    // hace un minuto era ayer, la medianoche de Caracas con que empezó hoy. Siempre es hoy.
    const [inst] = await sql<{ t: string; hoy: boolean }[]>`
      with i as (
        select greatest(now() - interval '1 minute',
                        platform.caracas_day(now())::timestamp at time zone 'America/Caracas') as t)
      select to_char(i.t at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as t,
             platform.caracas_day(i.t) = platform.caracas_day(now()) as hoy
        from i`;
    expect(inst!.hoy).toBe(true);
    const deHoy = await salir(F, {
      product_id: F.harina,
      quantity: "1",
      reason: "consumo_propio",
      occurred_at: inst!.t,
    });
    expect(deHoy.status).toBe(201);
    // Una merma de ayer conserva su fecha: no emite documento.
    const merma = await salir(F, {
      product_id: F.harina,
      quantity: "1",
      reason: "merma",
      evidence: "Acta 0032 del conteo de ayer",
      occurred_at: `${AYER}T16:00:00.000Z`,
    });
    expect(merma.status).toBe(201);
    const m = (await merma.json()) as { id: string };
    const [dia] = await sql<{ dia: string }[]>`
      select platform.caracas_day(occurred_at)::text as dia from public.inventory_moves
       where id = ${m.id}`;
    expect(dia!.dia).toBe(AYER);
    await enVerde(F);
  });

  it("punto 9d · anular y corregir con nota la MISMA factura de retiro a la vez: una gana, la otra se rechaza, y kardex y asientos netean", async () => {
    const [stock0] = await sql<{ q: string; v: string }[]>`
      select quantity::text as q, value::text as v from public.stock_balances
       where company_id = ${F.company} and warehouse_id = ${F.w1} and product_id = ${F.cloro}
         and lot_id is null`;
    const r = await salir(F, { product_id: F.cloro, quantity: "1", reason: "regalo" });
    expect(r.status).toBe(201);
    const factura = ((await r.json()) as SalidaConFactura).withdrawal_invoice!.id;
    const [anular, corregir] = await Promise.all([
      pedir(F, "POST", `/v1/invoices/${factura}/annul`, {
        company_id: F.company,
        reason: "se registró por error",
        originals_in_hand: true,
      }),
      pedir(F, "POST", `/v1/invoices/${factura}/withdrawal-credit-note`, {
        company_id: F.company,
        reason: "el regalo no llegó a salir",
      }),
    ]);
    const ganaron = [anular.status === 200, corregir.status === 201].filter(Boolean).length;
    expect(ganaron, `anular ${anular.status} · nota ${corregir.status}`).toBe(1);
    expect([409, 422]).toContain(anular.status === 200 ? corregir.status : anular.status);
    // Corregida UNA vez: o anulada sin nota, o vigente con su nota. Nunca las dos.
    const [fin] = await sql<{ status: string; notas: number }[]>`
      select d.status,
             (select count(*)::int from public.documents n
               where n.source_document_id = d.id and n.kind = 'withdrawal_credit_note') as notas
        from public.documents d where d.id = ${factura}`;
    expect([
      { status: "annulled", notas: 0 },
      { status: "issued", notas: 1 },
    ]).toContainEqual(fin);
    // La mercancía volvió UNA vez.
    const [stock1] = await sql<{ q: string; v: string }[]>`
      select quantity::text as q, value::text as v from public.stock_balances
       where company_id = ${F.company} and warehouse_id = ${F.w1} and product_id = ${F.cloro}
         and lot_id is null`;
    expect(stock1).toEqual(stock0);
    await enVerde(F);
  });

  it("punto 9a · el retiro de un producto EXENTO se factura sin IVA y va a la columna de exentas", async () => {
    const [exento] = await sql<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code, tracks_lots)
      values (${F.tenant}, ${F.company}, ${`SAL-EXE-${RUN}`}, 'Arroz', 'good', 'active',
              'unidad', 'exento', false)
      returning id`;
    await sql`insert into public.price_list_items
                (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
              select ${F.tenant}, ${F.company}, cs.default_price_list_id, ${exento!.id}, 30,
                     now() - interval '1 hour'
                from public.company_settings cs where cs.company_id = ${F.company}`;
    // La regla del exento: alícuota 0, cargada como la del fixture (sin regla no se emite).
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
      await tx`
        insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                                      rate, effective_from, legal_source, priority, transaction_type)
        select 'VE', 'iva', 'ordinario', 'exento', 0, ${AYER}::date,
               'Carga de prueba E2E — VALIDAR-SENIAT antes de producción.', 10, 'sale'
         where not exists (select 1 from public.tax_rules
                            where company_id is null and jurisdiction = 'VE' and tax_code = 'iva'
                              and taxpayer_type = 'ordinario' and product_tax_category = 'exento'
                              and transaction_type = 'sale')`;
    });
    const entra = await pedir(F, "POST", "/v1/inventory/receipts", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: exento!.id,
      quantity: "5",
      unit_amount: "12",
      currency: "VES",
      origin: "aporte",
    });
    expect(entra.status).toBe(201);
    const r = await salir(F, { product_id: exento!.id, quantity: "2", reason: "consumo_propio" });
    expect(r.status).toBe(201);
    const m = (await r.json()) as SalidaConFactura;
    // Se factura (decidido por criterio, ADR-0082; VALIDAR en P-78): 2 × 30 = 60, IVA 0.
    expect(m.withdrawal_invoice).toMatchObject({
      tax_amount: "0.00000000",
      total_amount: "60.00000000",
    });
    expect(m.withdrawal_invoice!.control_number).not.toBeNull();
    const [renglon] = await sql<Record<string, string>[]>`
      select base_gravada::text as gravada, iva_debito::text as iva, base_exenta::text as exenta
        from platform.sales_book(${F.company}, ${DESDE}::date, ${HASTA}::date)
       where document_id = ${m.withdrawal_invoice!.id}`;
    expect([
      Number(renglon!["gravada"]),
      Number(renglon!["iva"]),
      Number(renglon!["exenta"]),
    ]).toEqual([0, 0, 60]);
    // El asiento: al costo (2 × 12 = 24), sin una línea de débito fiscal.
    const lineas = await asientoDe(F, m.id);
    expect(lineas.map((l) => l.purpose)).not.toContain("iva_debit_fiscal");
    await enVerde(F);
  });

  it("punto 4 y punto 1 · el cliente real que comparte RIF con el negocio no ve retiros en su estado de cuenta; y una factura y un retiro simultáneos numeran sin hueco ni repetición", async () => {
    const rif = rifNumerico();
    const H = await crearEmpresa("formatos_libres", "c", rif);
    // El caso SIN MARCAR (20261005100600): el negocio ya tenía un cliente con su propio RIF.
    const [cliente] = await sql<{ id: string }[]>`
      insert into public.customers (tenant_id, company_id, tax_id, legal_name, person_type_code,
                                    taxpayer_type_code)
      values (${H.tenant}, ${H.company}, ${rif}, 'Bodega salidas formatos_libres', 'juridica',
              'ordinario')
      returning id`;
    await fiadoDeFixture(sql, H.company, [H.rol]);
    await sembrarTasaOficial(sql, { rate: "40", rate_date: diaCaracas(0), source: FUENTE_TASA });

    const retiro = await salir(H, {
      product_id: H.harina,
      quantity: "1",
      reason: "consumo_propio",
    });
    expect(retiro.status).toBe(201);
    const facturaDeRetiro = ((await retiro.json()) as SalidaConFactura).withdrawal_invoice!.id;
    // Se usó la ficha existente, sin marcar y sin crear otra.
    const fichas = await sql<{ id: string; own_company: boolean }[]>`
      select id, own_company from public.customers where company_id = ${H.company}`;
    expect(fichas).toEqual([{ id: cliente!.id, own_company: false }]);
    const [adquirente] = await sql<{ customer_id: string }[]>`
      select customer_id from public.documents where id = ${facturaDeRetiro}`;
    expect(adquirente!.customer_id).toBe(cliente!.id);

    // Punto 1: una factura normal (a ese mismo cliente, a crédito) y un retiro, A LA VEZ, en la
    // misma serie. Comparten correlativo y talonario: sin hueco y sin repetición.
    const [venta, otroRetiro] = await Promise.all([
      pedir(H, "POST", "/v1/invoices", {
        company_id: H.company,
        customer_id: cliente!.id,
        warehouse_id: H.w1,
        due_date: venceDeFixture(),
        lines: [{ product_id: H.cloro, quantity: "1" }],
      }),
      salir(H, { product_id: H.harina, quantity: "1", reason: "regalo" }),
    ]);
    expect([venta.status, otroRetiro.status]).toEqual([201, 201]);
    const numerados = await sql<{ kind: string; n: string; c: string }[]>`
      select kind, document_number::text as n, control_number::text as c from public.documents
       where company_id = ${H.company} and kind in ('invoice', 'withdrawal_invoice')
         and document_number is not null
       order by document_number`;
    expect(numerados.map((d) => d.n)).toEqual(["1", "2", "3"]);
    expect(numerados.map((d) => d.c).sort()).toEqual(["1", "2", "3"]);
    expect(numerados.map((d) => d.kind).sort()).toEqual([
      "invoice",
      "withdrawal_invoice",
      "withdrawal_invoice",
    ]);
    expect(await sql`select * from platform.control_number_collisions()`).toHaveLength(0);

    // Punto 4: el estado de cuenta lista CARTERA. Trae la venta; no trae ningún retiro.
    const estadoDeCuenta = await pedir(H, "GET", `/v1/customers/${cliente!.id}/statement`);
    expect(estadoDeCuenta.status).toBe(200);
    const texto = JSON.stringify(await estadoDeCuenta.json());
    const idVenta = (await venta.json()) as { id?: string; document?: { id: string } };
    expect(texto).toContain(idVenta.document?.id ?? idVenta.id!);
    expect(texto).not.toContain(facturaDeRetiro);
    expect(texto).not.toContain("withdrawal_invoice");
    expect(await sql`select * from platform.withdrawal_note_gaps(${H.company})`).toHaveLength(0);
    expect(await sql`select * from platform.receivables_ledger_gap(${H.company})`).toHaveLength(0);
  }, 120_000);
});

/** El TEXTO del PDF (la misma técnica de e2e-checklist-factura): infla los streams y decodifica. */
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
    .join("");
}
/** Sin espacios: pdfkit parte las líneas largas y el espacio del corte desaparece. */
const plano = (s: string): string => s.replace(/\s+/g, "");
const tiene = (texto: string, aguja: string): boolean => plano(texto).includes(plano(aguja));

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";

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

async function pedir(e: Empresa, metodo: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(DUENO)}`,
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

async function crearEmpresa(regimen: "formatos_libres" | "sin_facturacion"): Promise<Empresa> {
  const e: Empresa = {
    tenant: crypto.randomUUID(),
    company: crypto.randomUUID(),
    rif: regimen === "formatos_libres" ? `J-SAL-${RUN}-${regimen.length}` : `PEND-SAL-${RUN}`,
    w1: crypto.randomUUID(),
    w2: crypto.randomUUID(),
    harina: "",
    cloro: "",
    lotes: "",
  };
  const rol = crypto.randomUUID();
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
             (${rol}, null, ${`e2esal_${regimen}_${RUN}`}, 'Dueño', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${rol}, 'inventory.move'), (${rol}, 'inventory.adjust'),
             (${rol}, 'inventory.transfer'), (${rol}, 'accounting.account.manage'),
             (${rol}, 'sales.invoice.issue'), (${rol}, 'sales.payment.register'),
             (${rol}, 'accounting.template.manage'), (${rol}, 'accounting.read')
             on conflict do nothing`;
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
             values (${e.tenant}, ${e.company}, ${l!.id}, ${e.harina}, 100, now() - interval '1 day'),
                    (${e.tenant}, ${e.company}, ${l!.id}, ${e.cloro}, 50, now() - interval '1 day')`;
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

  it("el consumo propio es un RETIRO: Nota de retiro numerada, débito fiscal al valor de mercado, y va al libro de ventas", async () => {
    const r = await pedir(F, "POST", "/v1/inventory/issues", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.harina,
      quantity: "2",
      reason: "consumo_propio",
    });
    expect(r.status).toBe(201);
    const m = (await r.json()) as { id: string; withdrawal_note_number: number | null };
    expect(m.withdrawal_note_number).toBe(1);
    const [nota] = await sql<
      { note_number: string; base_functional: string; tax_functional: string; move_id: string }[]
    >`select note_number::text, base_functional::text, tax_functional::text, move_id
        from public.inventory_withdrawal_notes where move_id = ${m.id}`;
    // 2 × 100 Bs de la lista detal = 200; IVA 16 % = 32.
    expect(nota).toMatchObject({
      note_number: "1",
      base_functional: "200.00000000",
      tax_functional: "32.00000000",
    });
    const lineas = await asientoDe(F, m.id);
    expect(lineas.map((l) => [l.purpose, l.debe, l.haber])).toEqual([
      ["inventory_withdrawal", "80.00000000", "0.00000000"],
      ["inventory_withdrawal", "32.00000000", "0.00000000"],
      ["inventory_general", "0.00000000", "80.00000000"],
      ["iva_debit_fiscal", "0.00000000", "32.00000000"],
    ]);
    const libro = await sql<
      { kind: string; customer_tax_id: string; base_gravada: string; iva_debito: string }[]
    >`select kind, customer_tax_id, base_gravada::text, iva_debito::text
        from platform.sales_book(${F.company}, ${DESDE}::date, ${HASTA}::date)`;
    expect(libro).toEqual([
      {
        kind: "withdrawal_note",
        customer_tax_id: F.rif,
        base_gravada: "200.00000000",
        iva_debito: "32.00000000",
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

  it("el regalo es otro retiro: la Nota de retiro sigue el correlativo", async () => {
    const r = await pedir(F, "POST", "/v1/inventory/issues", {
      company_id: F.company,
      warehouse_id: F.w1,
      product_id: F.cloro,
      quantity: "1",
      reason: "regalo",
    });
    expect(r.status).toBe(201);
    const m = (await r.json()) as { withdrawal_note_number: number | null };
    expect(m.withdrawal_note_number).toBe(2);
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
    const m = (await r.json()) as { id: string; withdrawal_note_number: number | null };
    expect(m.withdrawal_note_number).toBeNull();
    expect(
      await sql`select 1 from public.inventory_withdrawal_notes where company_id = ${R.company}`,
    ).toHaveLength(0);
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

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";

/**
 * LA DECLARACIÓN DEL ESPECIAL ES QUINCENAL, CON DOS ARRASTRES (L-04, L-05; ADR-0072 §7).
 *
 * Lo que este fichero demuestra de extremo a extremo:
 *   1. un especial que pide un rango MENSUAL recibe 422 con sus dos quincenas; una ordinaria que
 *      pide una quincena recibe 422 diciendo que declara por mes;
 *   2. dos quincenas encadenadas: en la primera, la retención soportada (fecha del comprobante)
 *      no tiene cuota que absorber y pasa APARTE, como retenciones acumuladas por descontar — no
 *      como excedente de crédito fiscal —; en la segunda descuenta el débito de la factura;
 *   3. el hash firma el arrastre de retenciones (generador 1.1.0);
 *   4. la propuesta de período la da el servidor según el tipo: quincena para el especial, mes
 *      para el ordinario.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";

const TENANT = crypto.randomUUID();
const ESPECIAL = crypto.randomUUID();
const ORDINARIA = crypto.randomUUID();
const W1 = crypto.randomUUID();
const W2 = crypto.randomUUID();
// H4: ordinaria que pasa a especial el 10-03-2025, a mitad de mes.
const TRANSICION = crypto.randomUUID();
const W3 = crypto.randomUUID();
const CONTADOR = crypto.randomUUID();
const AGENTE = crypto.randomUUID();
const ROL = crypto.randomUUID();
const MEM = crypto.randomUUID();
const ASIG = crypto.randomUUID();
const RUN = Date.now().toString(36);
const DIGITOS = String(Date.now()).slice(-8);
const COMPROBANTE = `202609${DIGITOS}`;
// H4: dos comprobantes más, únicos por cliente y factura (14 dígitos).
const COMPROBANTE_TARDIO = `202610${DIGITOS}`;
const COMPROBANTE_MAL = `202611${DIGITOS}`;
const HOY = diaCaracas();
const AYER = diaCaracas(-1);

/** Fechas civiles del TEST (no del producto): la quincena en curso y la anterior. */
function ultimoDia(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}
const [ANIO, MES, DIA] = HOY.split("-").map(Number) as [number, number, number];
const mm = String(MES).padStart(2, "0");
const C_DESDE = DIA <= 15 ? `${ANIO}-${mm}-01` : `${ANIO}-${mm}-16`;
const C_HASTA =
  DIA <= 15 ? `${ANIO}-${mm}-15` : `${ANIO}-${mm}-${String(ultimoDia(ANIO, MES)).padStart(2, "0")}`;
const [P_DESDE, P_HASTA] = (() => {
  if (DIA > 15) return [`${ANIO}-${mm}-01`, `${ANIO}-${mm}-15`];
  const a = MES === 1 ? ANIO - 1 : ANIO;
  const m = MES === 1 ? 12 : MES - 1;
  const m2 = String(m).padStart(2, "0");
  return [`${a}-${m2}-16`, `${a}-${m2}-${String(ultimoDia(a, m)).padStart(2, "0")}`];
})();
const MES_DESDE = `${ANIO}-${mm}-01`;
const MES_HASTA = `${ANIO}-${mm}-${String(ultimoDia(ANIO, MES)).padStart(2, "0")}`;
const dmy = (f: string): string => f.split("-").reverse().join("-");

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let PRODUCTO = "";
let FACTURA = "";

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
  body?: unknown,
  empresa: string = ESPECIAL,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(CONTADOR)}`,
    "X-Company-Id": empresa,
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
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e quincenal')`;
    // Terminal 6 y 7: el RIF termina en dígito, como uno real.
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
             values (${ESPECIAL}, ${TENANT}, ${`J${DIGITOS}6`}, 'Especial e2e quincenal', 'VES',
                     'especial'),
                    (${ORDINARIA}, ${TENANT}, ${`J${DIGITOS}7`}, 'Ordinaria e2e quincenal', 'VES',
                     'ordinario'),
                    (${TRANSICION}, ${TENANT}, ${`J${DIGITOS}8`}, 'Transición e2e quincenal',
                     'VES', 'ordinario')`;
    await declararTipoDeFixture(tx, ESPECIAL);
    await declararTipoDeFixture(tx, ORDINARIA);
    await declararTipoDeFixture(tx, TRANSICION);
    await tx`insert into public.company_taxpayer_types
               (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason,
                rules_version)
             values (${TENANT}, ${TRANSICION}, 'especial', '2025-03-10', '2025-03-10',
                     'E2E: calificada especial a mitad de marzo de 2025', 'e2e')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${ESPECIAL}, 'E2E-QW1', 'Principal')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, ${`e2equinc_${RUN}`}, 'Contador quincenal e2e', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'sales.invoice.issue'), (${ROL}, 'sales.payment.register'),
             (${ROL}, 'ar.retention.register'), (${ROL}, 'inventory.move'),
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
             values (${TENANT}, ${ESPECIAL}, ${ASIG}, 'warehouse', ${W1})`;
    // El rol pide alcance: la ordinaria necesita su almacén y su vínculo para que el contador la vea.
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W2}, ${TENANT}, ${ORDINARIA}, 'E2E-QW2', 'Principal')`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${ORDINARIA}, ${ASIG}, 'warehouse', ${W2})`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W3}, ${TENANT}, ${TRANSICION}, 'E2E-QW3', 'Principal')`;
    await tx`insert into public.scope_bindings
               (tenant_id, company_id, assignment_id, scope_type, scope_id)
             values (${TENANT}, ${TRANSICION}, ${ASIG}, 'warehouse', ${W3})`;
    await tx`insert into public.customers
               (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                taxpayer_type_code)
             values (${AGENTE}, ${TENANT}, ${ESPECIAL}, ${`J-AGQ-${RUN}`}, 'Agente e2e quincenal',
                     'juridica', 'especial')`;
    const [p] = await tx<{ id: string }[]>`
      insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code,
                                   tax_category_code)
      values (${TENANT}, ${ESPECIAL}, ${`E2EQ-G-${RUN}`}, 'Producto gravado', 'good', 'active',
              'unidad', 'gravado_general')
      returning id`;
    PRODUCTO = p!.id;
    const [l] = await tx<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      values (${TENANT}, ${ESPECIAL}, ${`e2e-quinc-${RUN}`}, 'VES') returning id`;
    await tx`insert into public.price_list_items
               (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
             values (${TENANT}, ${ESPECIAL}, ${l!.id}, ${PRODUCTO}, '1000.00000000', ${AYER}::date)`;
    await tx`update public.customers set default_price_list_id = ${l!.id} where id = ${AGENTE}`;
    await tx`insert into public.company_fiscal_regimes
               (tenant_id, company_id, regime_code, effective_from)
             values (${TENANT}, ${ESPECIAL}, 'formatos_libres', ${AYER}::timestamptz)`;
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-tax-rules'))`;
    // El agente es ESPECIAL: la regla de su contraparte también, con el mismo patrón.
    for (const contraparte of ["ordinario", "especial"] as const) {
      for (const tipo of ["sale", "purchase"] as const) {
        await tx`
          insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type,
                                        product_tax_category, rate, effective_from, legal_source,
                                        priority, transaction_type)
          select 'VE', 'iva', ${contraparte}, 'gravado_general', 0.16, ${AYER}::date,
                 'Carga de prueba E2E — VALIDAR-SENIAT antes de producción.', 10, ${tipo}
           where not exists (select 1 from public.tax_rules
                              where company_id is null and jurisdiction = 'VE' and tax_code = 'iva'
                                and taxpayer_type = ${contraparte}
                                and product_tax_category = 'gravado_general'
                                and transaction_type = ${tipo})`;
      }
    }
    await tx`insert into public.inventory_moves
               (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
                amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
                functional_currency, rate_source, rate_timestamp, rounding_policy_id,
                occurred_at, reference)
             values (${TENANT}, ${ESPECIAL}, ${W1}, ${PRODUCTO}, 'entrada', 100, 50000, 'VES',
                     1, 50000, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', now(),
                     ${`e2e-quinc-seed-${RUN}`})`;
  });

  const rango = await pedir("POST", "/v1/fiscal-number-ranges", {
    company_id: ESPECIAL,
    kind: "invoice",
    series: "A",
    range_from: "1",
    range_to: "500",
    printer_source: "Imprenta E2E quincenal",
    printer_legal_name: "Imprenta E2E, C.A.",
    printer_tax_id: "J-12345678-9",
    printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
    printer_authorization_date: "2020-01-15",
    printed_on: "2026-09-01",
  });
  if (rango.status !== 201) throw new Error(`rango: ${rango.status} ${await rango.text()}`);
  const plan = await pedir("POST", "/v1/accounts/import-template", {
    company_id: ESPECIAL,
    template_code: "ve_basico",
  });
  if (plan.status !== 201) throw new Error(`plan: ${plan.status} ${await plan.text()}`);
  const preset = await pedir("POST", "/v1/journal-templates/import-preset", {
    company_id: ESPECIAL,
    preset_code: "ve_basico",
  });
  if (preset.status !== 201) throw new Error(`preset: ${preset.status} ${await preset.text()}`);

  // La factura de HOY (quincena en curso): 2 × 1 000, IVA 320.
  const f = await pedir("POST", "/v1/invoices", {
    company_id: ESPECIAL,
    customer_id: AGENTE,
    warehouse_id: W1,
    lines: [{ product_id: PRODUCTO, quantity: "2" }],
  });
  if (f.status !== 201) throw new Error(`factura: ${f.status} ${await f.text()}`);
  const factura = ((await f.json()) as Record<string, string>)["id"]!;
  FACTURA = factura;
  // El comprobante del agente, fechado el ÚLTIMO día de la quincena ANTERIOR: entra en esa.
  const r = await pedir("POST", "/v1/fiscal-declarations/supported-retentions", {
    company_id: ESPECIAL,
    customer_id: AGENTE,
    document_id: factura,
    receipt_number: COMPROBANTE,
    retained_on: P_HASTA,
    base: "320.00",
    rate: "0.75",
    amount: "240.00",
  });
  if (r.status !== 201) throw new Error(`retención: ${r.status} ${await r.text()}`);
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("L-04 · el período según el tipo", () => {
  it("el especial que pide el MES recibe 422 con sus dos quincenas", async () => {
    const r = await pedir("POST", "/v1/fiscal-declarations/iva-periods", {
      company_id: ESPECIAL,
      period_from: MES_DESDE,
      period_to: MES_HASTA,
    });
    expect(r.status).toBe(422);
    const { message } = (await r.json()) as { message: string };
    expect(message).toContain("por quincena");
    expect(message).toContain(`del ${dmy(MES_DESDE)} al ${dmy(`${ANIO}-${mm}-15`)}`);
    expect(message).toContain(`del ${dmy(`${ANIO}-${mm}-16`)} al ${dmy(MES_HASTA)}`);
  });

  it("la ordinaria que pide una QUINCENA recibe 422: declara por mes", async () => {
    const r = await pedir(
      "POST",
      "/v1/fiscal-declarations/iva-periods",
      { company_id: ORDINARIA, period_from: C_DESDE, period_to: C_HASTA },
      ORDINARIA,
    );
    expect(r.status).toBe(422);
    const { message } = (await r.json()) as { message: string };
    expect(message).toContain("por mes");
    expect(message).toContain(`del ${dmy(MES_DESDE)} al ${dmy(MES_HASTA)}`);
  });

  it("la propuesta del especial es la última quincena cerrada, con su vencimiento por terminal", async () => {
    const r = await pedir("GET", "/v1/fiscal-declarations/iva-periods/proposal");
    expect(r.status, await r.clone().text()).toBe(200);
    const p = (await r.json()) as Record<string, string | null>;
    expect(p["taxpayer_type"]).toBe("especial");
    expect(p["periodicity"]).toBe("quincenal");
    expect(p["period_from"]).toBe(P_DESDE);
    expect(p["period_to"]).toBe(P_HASTA);
    // El vencimiento es el de la tabla para el terminal 6, si la celda está ofrecida.
    const [celda] = await sql<{ due: string | null }[]>`
      select case when review_status = 'secondary_source' then due_date::text end as due
        from public.tax_calendar_entries
       where obligation = 'iva' and period_from = ${P_DESDE}::date
         and period_to = ${P_HASTA}::date and rif_terminal = 6`;
    expect(p["due_date"]).toBe(celda?.due ?? null);
  });

  it("la propuesta de la ordinaria es el mes anterior", async () => {
    const r = await pedir(
      "GET",
      "/v1/fiscal-declarations/iva-periods/proposal",
      undefined,
      ORDINARIA,
    );
    expect(r.status).toBe(200);
    const p = (await r.json()) as Record<string, string | null>;
    expect(p["periodicity"]).toBe("mensual");
    const a = MES === 1 ? ANIO - 1 : ANIO;
    const m = MES === 1 ? 12 : MES - 1;
    const m2 = String(m).padStart(2, "0");
    expect(p["period_from"]).toBe(`${a}-${m2}-01`);
    expect(p["period_to"]).toBe(`${a}-${m2}-${String(ultimoDia(a, m)).padStart(2, "0")}`);
    expect(p["due_date"]).toBeNull();
  });
});

describe("L-05 · dos quincenas, dos arrastres", () => {
  it("1.ª quincena: la retención no se absorbe y pasa APARTE, no como crédito fiscal", async () => {
    const r = await pedir("POST", "/v1/fiscal-declarations/iva-periods", {
      company_id: ESPECIAL,
      period_from: P_DESDE,
      period_to: P_HASTA,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const p = (await r.json()) as Record<string, string>;
    expect(p["generator_version"]).toBe("iva-declarations/1.1.0");
    expect(p["debitos"]).toBe("0.00000000");
    expect(p["retenciones_soportadas"]).toBe("240.00000000");
    expect(p["cuota_a_pagar"]).toBe("0.00000000");
    // Lo que solo produce el arreglo: antes, 240 salían aquí, mezclados con el crédito.
    expect(p["excedente_siguiente"]).toBe("0.00000000");
    expect(p["retenciones_acumuladas_por_descontar"]).toBe("240.00000000");
    expect(p["retenciones_acumuladas_anteriores"]).toBe("0.00000000");

    // El hash firma el arrastre de retenciones: el canónico del dominio, reconstruido.
    const [c] = await sql<Record<string, unknown>[]>`
      select debitos::text as debitos, creditos::text as creditos,
             creditos_deducibles::text as creditos_deducibles, prorrata_pct::text as prorrata_pct,
             retenciones_soportadas::text as retenciones_soportadas,
             cuota_a_pagar::text as cuota_a_pagar, excedente_siguiente::text as excedente_siguiente,
             detalle,
             retenciones_acumuladas_por_descontar::text as por_descontar
        from platform.recompute_iva_period(${ESPECIAL}, ${P_DESDE}::date, ${P_HASTA}::date, 0, 0)`;
    const canonico = {
      period_from: P_DESDE,
      period_to: P_HASTA,
      excedente_anterior: "0",
      debitos: c!["debitos"],
      creditos: c!["creditos"],
      creditos_deducibles: c!["creditos_deducibles"],
      prorrata_pct: c!["prorrata_pct"],
      retenciones_soportadas: c!["retenciones_soportadas"],
      cuota_a_pagar: c!["cuota_a_pagar"],
      excedente_siguiente: c!["excedente_siguiente"],
      detalle: c!["detalle"],
      retenciones_acumuladas_por_descontar: c!["por_descontar"],
      generator_version: "iva-declarations/1.1.0",
    };
    const sha = createHash("sha256").update(JSON.stringify(canonico), "utf8").digest("hex");
    expect(p["dataset_hash"]).toBe(sha);
  });

  it("2.ª quincena: la retención arrastrada descuenta el débito; el crédito no la ve", async () => {
    const r = await pedir("POST", "/v1/fiscal-declarations/iva-periods", {
      company_id: ESPECIAL,
      period_from: C_DESDE,
      period_to: C_HASTA,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const p = (await r.json()) as Record<string, string>;
    expect(p["debitos"]).toBe("320.00000000");
    expect(p["excedente_anterior"]).toBe("0.00000000");
    expect(p["retenciones_acumuladas_anteriores"]).toBe("240.00000000");
    expect(p["retenciones_soportadas"]).toBe("0.00000000");
    // 320 − 240 = 80.
    expect(p["cuota_a_pagar"]).toBe("80.00000000");
    expect(p["excedente_siguiente"]).toBe("0.00000000");
    expect(p["retenciones_acumuladas_por_descontar"]).toBe("0.00000000");
  });

  it("la lista devuelve los dos arrastres de cada generación", async () => {
    const r = await pedir("GET", "/v1/fiscal-declarations/iva-periods");
    expect(r.status).toBe(200);
    const { items } = (await r.json()) as { items: Record<string, string>[] };
    const primera = items.find((i) => i["period_from"] === P_DESDE);
    expect(primera?.["retenciones_acumuladas_por_descontar"]).toBe("240.00000000");
    expect(primera?.["excedente_siguiente"]).toBe("0.00000000");
  });

  it("una generación 1.0.0 con excedente (la cifra mezclada) no se encadena: pide regenerarla", async () => {
    // Una fila del generador viejo en la ordinaria, enero de 2025: excedente 100 «combinado».
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${CONTADOR}, true)`;
      await tx`
        insert into public.iva_period_results
          (tenant_id, company_id, period_from, period_to, debitos, creditos, creditos_deducibles,
           prorrata_pct, retenciones_soportadas, excedente_anterior, cuota_a_pagar,
           excedente_siguiente, detalle, generator_version, dataset_hash)
        values (${TENANT}, ${ORDINARIA}, '2025-01-01', '2025-01-31', 0, 0, 0, null, 100, 0, 0,
                100, '[]'::jsonb, 'iva-declarations/1.0.0', ${"0".repeat(64)})`;
    });
    const r = await pedir(
      "POST",
      "/v1/fiscal-declarations/iva-periods",
      { company_id: ORDINARIA, period_from: "2025-02-01", period_to: "2025-02-28" },
      ORDINARIA,
    );
    expect(r.status).toBe(422);
    const { message } = (await r.json()) as { message: string };
    // El mensaje de ESTE camino, no el del eslabón que falta (que también da 422).
    expect(message).toContain("Vuelve a generarlo");
  });
});

describe("revisión · H4, H5, H6, H9", () => {
  it("H5: la ordinaria que pide UN DÍA recibe 422: declara el mes completo", async () => {
    const r = await pedir(
      "POST",
      "/v1/fiscal-declarations/iva-periods",
      { company_id: ORDINARIA, period_from: HOY, period_to: HOY },
      ORDINARIA,
    );
    expect(r.status).toBe(422);
    const { message } = (await r.json()) as { message: string };
    expect(message).toContain("por mes");
    expect(message).toContain(`del ${dmy(MES_DESDE)} al ${dmy(MES_HASTA)}`);
  });

  it("H4: la ordinaria que pasa a especial a mitad de mes: 422 «cambia dentro de ese rango»", async () => {
    const r = await pedir(
      "POST",
      "/v1/fiscal-declarations/iva-periods",
      { company_id: TRANSICION, period_from: "2025-03-01", period_to: "2025-03-31" },
      TRANSICION,
    );
    expect(r.status).toBe(422);
    const { message } = (await r.json()) as { message: string };
    expect(message).toContain("cambia dentro de ese rango");
  });

  it("H9: una 1.0.0 con excedente 0 y retenciones distintas de cero tampoco se encadena", async () => {
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${CONTADOR}, true)`;
      await tx`
        insert into public.iva_period_results
          (tenant_id, company_id, period_from, period_to, debitos, creditos, creditos_deducibles,
           prorrata_pct, retenciones_soportadas, excedente_anterior, cuota_a_pagar,
           excedente_siguiente, detalle, generator_version, dataset_hash)
        values (${TENANT}, ${ORDINARIA}, '2025-04-01', '2025-04-30', 100, 0, 0, null, 50, 0, 50,
                0, '[]'::jsonb, 'iva-declarations/1.0.0', ${"1".repeat(64)})`;
    });
    const r = await pedir(
      "POST",
      "/v1/fiscal-declarations/iva-periods",
      { company_id: ORDINARIA, period_from: "2025-05-01", period_to: "2025-05-31" },
      ORDINARIA,
    );
    expect(r.status).toBe(422);
    const { message } = (await r.json()) as { message: string };
    expect(message).toContain("Vuelve a generarlo");
  });

  it("H6: el calendario dice si aplica — al especial sí, a la ordinaria no", async () => {
    const e = await pedir("GET", "/v1/fiscal-declarations/calendar?from=2026-01-01&to=2026-12-31");
    expect(e.status).toBe(200);
    const ce = (await e.json()) as { applies: boolean; rif_terminal: number | null };
    expect(ce.applies).toBe(true);
    expect(ce.rif_terminal).toBe(6);
    const o = await pedir(
      "GET",
      "/v1/fiscal-declarations/calendar?from=2026-01-01&to=2026-12-31",
      undefined,
      ORDINARIA,
    );
    expect(o.status).toBe(200);
    const co = (await o.json()) as { applies: boolean; items: unknown[] };
    expect(co.applies).toBe(false);
    expect(co.items).toEqual([]);
  });
});

describe("auditoría fiscal 2.ª ronda · H4: la retención entregada después de declarar su quincena", () => {
  it("cuenta en el período de su ENTREGA, no en el de su fecha ya declarado (PA 000054 art. 7)", async () => {
    // Retenida el último día de la quincena ANTERIOR (ya declarada arriba), entregada HOY.
    const r = await pedir("POST", "/v1/fiscal-declarations/supported-retentions", {
      company_id: ESPECIAL,
      customer_id: AGENTE,
      document_id: FACTURA,
      receipt_number: COMPROBANTE_TARDIO,
      retained_on: P_HASTA,
      received_on: HOY,
      base: "320.00",
      rate: "0.75",
      amount: "240.00",
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const cuerpo = (await r.json()) as { retention: Record<string, string | null> };
    expect(cuerpo.retention["received_on"]).toBe(HOY);

    // La quincena en curso, regenerada: la retención tardía entra aquí.
    const c = await pedir("POST", "/v1/fiscal-declarations/iva-periods", {
      company_id: ESPECIAL,
      period_from: C_DESDE,
      period_to: C_HASTA,
    });
    expect(c.status, await c.clone().text()).toBe(201);
    const p = (await c.json()) as Record<string, string>;
    expect(p["retenciones_soportadas"]).toBe("240.00000000");
    // 320 − (240 arrastradas + 240 del período) → cuota 0 y 160 por descontar.
    expect(p["cuota_a_pagar"]).toBe("0.00000000");
    expect(p["retenciones_acumuladas_por_descontar"]).toBe("160.00000000");
  });

  it("una fecha de entrega anterior a la retención se rechaza con 422", async () => {
    const r = await pedir("POST", "/v1/fiscal-declarations/supported-retentions", {
      company_id: ESPECIAL,
      customer_id: AGENTE,
      document_id: FACTURA,
      receipt_number: COMPROBANTE_MAL,
      retained_on: HOY,
      received_on: P_HASTA,
      base: "320.00",
      rate: "0.75",
      amount: "240.00",
    });
    expect(r.status).toBe(422);
    const { message } = (await r.json()) as { message: string };
    expect(message).toContain("entrega");
  });

  it("B-2: una fecha de entrega posterior a hoy (Caracas) se rechaza con 422", async () => {
    const r = await pedir("POST", "/v1/fiscal-declarations/supported-retentions", {
      company_id: ESPECIAL,
      customer_id: AGENTE,
      document_id: FACTURA,
      receipt_number: COMPROBANTE_MAL,
      retained_on: HOY,
      received_on: diaCaracas(1),
      base: "320.00",
      rate: "0.75",
      amount: "240.00",
    });
    expect(r.status).toBe(422);
    const { message } = (await r.json()) as { message: string };
    expect(message).toContain("no puede ser posterior a hoy");
  });
});

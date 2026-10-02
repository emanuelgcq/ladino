import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * R-2 AMPLIADA, DE PUNTA A PUNTA: la casilla «ajustes a los créditos fiscales de períodos
 * anteriores» cuando NO es cero (migración 20260928120000; revisión de la ola 1, punto 4).
 *
 * Una factura de proveedor del mes pasado, con su período CERRADO y su libro de compras
 * GENERADO, se anula hoy (sembrado por SQL: el producto no tiene todavía la vía de anular una
 * compra). Se genera la planilla del mes en curso POR LA API, y se comprueba lo que solo produce
 * el camino de la casilla:
 *   · la respuesta de la ruta la trae, en negativo y APARTE de creditos_deducibles (que nunca es
 *     negativo, migración 120300): entra en la cuota y en el excedente;
 *   · la fila persistida en iva_period_results la guarda;
 *   · el dataset_hash la FIRMA: es el sha256 del canónico CON la casilla, y no el de sin ella;
 *   · el listado GET la devuelve.
 */

const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  process.env["SUPABASE_JWT_SECRET"] ?? "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";

const TENANT = crypto.randomUUID();
const COMPANY = crypto.randomUUID();
const W1 = crypto.randomUUID();
const CONTADOR = crypto.randomUUID();
const ROL = crypto.randomUUID();
const MEM = crypto.randomUUID();
const ASIG = crypto.randomUUID();
const PROV = crypto.randomUUID();
const FACTURA = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const DESDE = `${HOY.slice(0, 8)}01`;
// H5 (2026-10-02): el ordinario declara el mes calendario completo, hasta su último día.
const HASTA = (() => {
  const [a, m] = HOY.split("-").map(Number) as [number, number];
  return `${HOY.slice(0, 8)}${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`;
})();

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

async function pedir(metodo: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await tokenDe(CONTADOR)}`,
    "X-Company-Id": COMPANY,
  };
  if (metodo !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(path, {
    method: metodo,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${CONTADOR}) on conflict (id) do nothing`;

  // Transacción 1: la compra del mes pasado, su período CERRADO y su libro GENERADO.
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${CONTADOR}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e ajuste')`;
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, taxpayer_type_code)
             values (${COMPANY}, ${TENANT}, ${`J-AJU-${RUN}`}, 'Empresa e2e ajuste', 'VES',
                     'ordinario')`;
    await tx`insert into public.warehouses (id, tenant_id, company_id, code, name)
             values (${W1}, ${TENANT}, ${COMPANY}, 'E2E-AJW1', 'Principal')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, ${`e2eajuste_${RUN}`}, 'Contador ajuste e2e', true)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
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
    await tx`insert into public.suppliers
               (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, taxpayer_type_code,
                person_type_code)
             values (${PROV}, ${TENANT}, ${COMPANY}, ${`J-PAJ-${RUN}`}, 'Proveedor e2e ajuste',
                     'nacional', 'ordinario', 'juridica')`;
    await tx`insert into public.supplier_invoices
               (id, tenant_id, company_id, supplier_id, supplier_document_number,
                supplier_control_number, invoice_date, status, posted_at, subtotal_amount,
                tax_amount, total_amount, tax_is_recoverable, transaction_currency,
                functional_currency, fx_rate, rate_source)
             values (${FACTURA}, ${TENANT}, ${COMPANY}, ${PROV}, ${`FAJ-${RUN}`}, '00-AJ1',
                     (date_trunc('month', ${DESDE}::date) - interval '1 month'
                        + interval '9 days')::date,
                     'posted', now(), 5000, 800, 5800, true, 'VES', 'VES', 1, 'identidad')`;
    await tx`insert into public.fiscal_periods
               (tenant_id, company_id, year, month, status, closed_at, closed_by)
             select ${TENANT}, ${COMPANY}, extract(year from d)::int, extract(month from d)::int,
                    'closed', now(), ${CONTADOR}
               from (select (${DESDE}::date - interval '1 month')::date as d) x`;
    await tx`insert into public.fiscal_book_runs
               (tenant_id, company_id, book_kind, period_from, period_to, timezone,
                generator_version, dataset_hash, row_count, format_code)
             select ${TENANT}, ${COMPANY}, 'compras', d, (d + interval '1 month - 1 day')::date,
                    'America/Caracas', 'e2e', repeat('a', 64), 1, 'csv_columnas_legales'
               from (select (${DESDE}::date - interval '1 month')::date as d) x`;
  });
  // Transacción 2, POSTERIOR: la anulación. El trigger sella annulled_at con su now().
  await sql`update public.supplier_invoices set status = 'annulled' where id = ${FACTURA}`;
});

afterAll(async () => {
  await sql.end();
  await sqlApi.end();
});

describe("R-2 ampliada — la casilla de ajustes de créditos anteriores, distinta de cero", () => {
  it("la planilla del mes la trae en la respuesta, la persiste y la firma en el hash", async () => {
    const r = await pedir("POST", "/v1/fiscal-declarations/iva-periods", {
      company_id: COMPANY,
      period_from: DESDE,
      period_to: HASTA,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const p = (await r.json()) as Record<string, unknown>;
    expect(p["ajuste_creditos_anteriores"]).toBe("-800.00000000");
    expect(p["creditos"]).toBe("0.00000000");
    // La casilla va APARTE del crédito deducible (migración 20260928120300): el CHECK
    // ipr_amounts_chk no admite un deducible negativo, y el ajuste entra en la cuota.
    expect(p["creditos_deducibles"]).toBe("0.00000000");
    // Revertir 800 de crédito deja 800 que pagar, sin ventas en el mes.
    expect(p["cuota_a_pagar"]).toBe("800.00000000");

    const [fila] = await sql<{ ajuste: string; hash: string; version: string }[]>`
      select ajuste_creditos_anteriores::text as ajuste, dataset_hash as hash,
             generator_version as version
        from public.iva_period_results where id = ${p["id"] as string}`;
    expect(fila!.ajuste).toBe("-800.00000000");
    expect(fila!.hash).toBe(p["dataset_hash"]);

    // El hash: el canónico del dominio, reconstruido con las cifras de la función.
    const [c] = await sql<
      {
        debitos: string;
        creditos: string;
        creditos_deducibles: string;
        prorrata_pct: string | null;
        retenciones_soportadas: string;
        cuota_a_pagar: string;
        excedente_siguiente: string;
        detalle: unknown;
        ajuste_creditos_anteriores: string;
      }[]
    >`select debitos::text as debitos, creditos::text as creditos,
             creditos_deducibles::text as creditos_deducibles, prorrata_pct::text as prorrata_pct,
             retenciones_soportadas::text as retenciones_soportadas,
             cuota_a_pagar::text as cuota_a_pagar, excedente_siguiente::text as excedente_siguiente,
             detalle, ajuste_creditos_anteriores::text as ajuste_creditos_anteriores
        from platform.recompute_iva_period(${COMPANY}, ${DESDE}::date, ${HASTA}::date, 0)`;
    const base = {
      period_from: DESDE,
      period_to: HASTA,
      excedente_anterior: "0",
      debitos: c!.debitos,
      creditos: c!.creditos,
      creditos_deducibles: c!.creditos_deducibles,
      prorrata_pct: c!.prorrata_pct,
      retenciones_soportadas: c!.retenciones_soportadas,
      cuota_a_pagar: c!.cuota_a_pagar,
      excedente_siguiente: c!.excedente_siguiente,
      detalle: c!.detalle,
    };
    const sha = (o: object): string =>
      createHash("sha256").update(JSON.stringify(o), "utf8").digest("hex");
    const conCasilla = sha({
      ...base,
      ajuste_creditos_anteriores: c!.ajuste_creditos_anteriores,
      generator_version: fila!.version,
    });
    const sinCasilla = sha({ ...base, generator_version: fila!.version });
    expect(fila!.hash).toBe(conCasilla);
    expect(fila!.hash).not.toBe(sinCasilla);

    const lista = await pedir("GET", "/v1/fiscal-declarations/iva-periods");
    expect(lista.status).toBe(200);
    const { items } = (await lista.json()) as { items: Record<string, unknown>[] };
    expect(items[0]!["ajuste_creditos_anteriores"]).toBe("-800.00000000");
  });
});

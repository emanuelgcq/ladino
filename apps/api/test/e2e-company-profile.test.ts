import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";

/**
 * REGISTRO PREMIUM, el backend de punta a punta: la fundación con RIF exige
 * su trío (RIF + razón social + dirección), el perfil se edita, y la política
 * de RIF en TRES NIVELES se cumple en el servidor — no solo en la UI:
 *
 *   nivel 1: sin documentos, el RIF se pone/cambia con confirmación simple;
 *   nivel 2: UNA factura emitida lo bloquea (422 con la voz de persona), y la
 *            razón social exige motivo, que queda en acta;
 *   nivel 3: la corrección excepcional funciona AUN con documentos, con
 *            motivo obligatorio y acta propia.
 *
 * Además: el logo sube por el patrón product-images y el PDF lo incrusta
 * (variante PNG — pdfkit no lee webp), y el cambio de régimen con documentos
 * exige motivo (el hueco de fiscal-setup que cerró la migración 43).
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const DUENA = crypto.randomUUID();
const RUN = Date.now().toString(36);

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

async function pedir(
  metodo: string,
  path: string,
  body?: unknown,
  conEmpresa = true,
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await tokenDe(DUENA)}` };
  if (conEmpresa && COMPANY !== "") headers["X-Company-Id"] = COMPANY;
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

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  const serviceKey = await new SignJWT({ role: "service_role" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("supabase-demo")
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(JWT_SECRET);
  app = buildApp({
    sql: sqlApi,
    auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER },
    storage: { url: "http://127.0.0.1:54321/storage/v1", serviceKey },
  });
  await sql`insert into auth.users (id, email) values
            (${DUENA}, ${`duena-${RUN}@e2e.ladino`}) on conflict (id) do nothing`;
});

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("registro premium: perfil, política de RIF y logo", () => {
  it("con RIF pero sin dirección fiscal, la fundación rechaza: la regla dura vive en dominio", async () => {
    const r = await pedir(
      "POST",
      "/v1/onboarding",
      {
        business_name: `Abasto Premium ${RUN}`,
        tax_id: `J-77${RUN.slice(0, 6)}-1`,
        legal_name: `Abasto Premium ${RUN}, C.A.`,
      },
      false,
    );
    expect(r.status).toBe(422);
    const cuerpo = (await r.json()) as { message: string };
    expect(cuerpo.message).toContain("dirección fiscal");
  });

  it("la fundación premium completa: perfil entero, razón social aparte del nombre, y la ficha del responsable", async () => {
    const r = await pedir(
      "POST",
      "/v1/onboarding",
      {
        business_name: `Abasto Premium ${RUN}`,
        tax_id: `J-77${RUN.slice(0, 6)}-1`,
        legal_name: `Inversiones Premium ${RUN}, C.A.`,
        fiscal_address: "Av. Bolívar, local 7, Valencia, Carabobo",
        business_type: "bodega",
        phone: "0241-5550001",
        whatsapp: "0414-5550001",
        city: "Valencia",
        state: "Carabobo",
        owner_full_name: "Ana Premium",
        owner_national_id: "V-11222333",
      },
      false,
    );
    expect(r.status).toBe(201);
    const fundado = (await r.json()) as { tenant_id: string; company_id: string };
    COMPANY = fundado.company_id;
    TENANT = fundado.tenant_id;

    const lista = (await (await pedir("GET", "/v1/companies", undefined, false)).json()) as Record<
      string,
      unknown
    >[];
    const mia = lista.find((x) => x["id"] === COMPANY)!;
    expect(mia["legal_name"]).toBe(`Inversiones Premium ${RUN}, C.A.`);
    expect(mia["trade_name"]).toBe(`Abasto Premium ${RUN}`);
    expect(mia["fiscal_address"]).toBe("Av. Bolívar, local 7, Valencia, Carabobo");
    expect(mia["business_type"]).toBe("bodega");
    expect(mia["city"]).toBe("Valencia");
    expect(mia["logo_url"]).toBeNull();

    const ficha = (await (await pedir("GET", "/v1/me/profile", undefined, false)).json()) as {
      full_name: string | null;
      national_id: string | null;
    };
    expect(ficha).toEqual({ full_name: "Ana Premium", national_id: "V-11222333" });
  });

  it("nivel 1: sin documentos, el RIF se cambia con confirmación simple y el trigger deja el acta", async () => {
    const r = await pedir("PUT", "/v1/companies/tax-id", { tax_id: `J-88${RUN.slice(0, 6)}-2` });
    expect(r.status).toBe(200);
    const [acta] = await sql<{ payload: Record<string, string> }[]>`
      select payload from public.audit_events
       where company_id = ${COMPANY} and event_type = 'company.tax_id_changed'
       order by occurred_at desc limit 1`;
    expect(acta!.payload["tax_id_nuevo"]).toBe(`J-88${RUN.slice(0, 6)}-2`);
  });

  it("nivel 2: UNA factura emitida bloquea el RIF y la razón social exige motivo con acta", async () => {
    // La factura se planta por SQL (fixture del esquema, como en pgTAP 043):
    // el punto es la POLÍTICA, no el POS.
    const REGIMEN = crypto.randomUUID();
    const DOC = crypto.randomUUID();
    await sql`insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
              values (${REGIMEN}, ${TENANT}, ${COMPANY}, 'formatos_libres', '2026-01-01')`;
    const [cf] = await sql<{ id: string }[]>`
      select id from public.customers where company_id = ${COMPANY} and is_system`;
    await sql`insert into public.documents
        (id, tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
         control_number, regime_version_id, rules_version,
         issuer_name_snapshot, issuer_tax_id_snapshot, issuer_address_snapshot,
         transaction_currency, functional_currency, fx_rate, rate_source,
         amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
      values (${DOC}, ${TENANT}, ${COMPANY}, 'invoice', 'A', ${cf!.id}, 'issued', now(), 1,
              1, ${REGIMEN}, 'e2e-perfil',
              ${`Inversiones Premium ${RUN}, C.A.`}, ${`J-88${RUN.slice(0, 6)}-2`},
              'Av. Bolívar, local 7, Valencia, Carabobo',
              'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116)`;

    const bloqueado = await pedir("PUT", "/v1/companies/tax-id", { tax_id: "J-00000000-0" });
    expect(bloqueado.status).toBe(422);
    expect(((await bloqueado.json()) as { message: string }).message).toContain("entidad nueva");

    const sinMotivo = await pedir("PATCH", "/v1/companies/profile", {
      legal_name: `Renombrada ${RUN}, C.A.`,
    });
    expect(sinMotivo.status).toBe(422);

    const conMotivo = await pedir("PATCH", "/v1/companies/profile", {
      legal_name: `Renombrada ${RUN}, C.A.`,
      reason: "Cambio de denominación registrado ante el Registro Mercantil",
    });
    expect(conMotivo.status).toBe(200);
    const [acta] = await sql<{ payload: { cambios: object; reason: string } }[]>`
      select payload from public.audit_events
       where company_id = ${COMPANY} and event_type = 'company.profile_updated'
       order by occurred_at desc limit 1`;
    expect(acta!.payload.reason).toContain("Registro Mercantil");
    // Y el documento emitido NO cambió: su snapshot es de su día.
    const [snap] = await sql<{ issuer_name_snapshot: string }[]>`
      select issuer_name_snapshot from public.documents where id = ${DOC}`;
    expect(snap!.issuer_name_snapshot).not.toContain("Renombrada");
  });

  it("nivel 3: la corrección excepcional exige motivo y deja su acta propia", async () => {
    const zodazo = await pedir("POST", "/v1/companies/tax-id/correct", {
      tax_id: `J-99${RUN.slice(0, 6)}-3`,
    });
    expect(zodazo.status).toBe(422);

    const r = await pedir("POST", "/v1/companies/tax-id/correct", {
      tax_id: `J-99${RUN.slice(0, 6)}-3`,
      reason: "Dedazo en el registro: el RIF real es el del certificado",
    });
    expect(r.status).toBe(200);
    const [acta] = await sql<{ payload: { from: string; to: string; reason: string } }[]>`
      select payload from public.audit_events
       where company_id = ${COMPANY} and event_type = 'company.tax_id_corrected'
       order by occurred_at desc limit 1`;
    expect(acta!.payload.to).toBe(`J-99${RUN.slice(0, 6)}-3`);
    expect(acta!.payload.reason).toContain("certificado");
  });

  it("el cambio de régimen con documentos emitidos exige motivo: el hueco quedó cerrado", async () => {
    const r = await pedir("POST", "/v1/fiscal/regime", { regime_code: "sin_emision" });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toContain("motivo");
  });

  it("el logo sube por el patrón product-images y el PDF lo incrusta (PNG, pdfkit no lee webp)", async () => {
    const { default: sharp } = await import("sharp");
    const png = await sharp({
      create: { width: 300, height: 300, channels: 4, background: "#059669" },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append("file", new File([new Uint8Array(png)], "logo.png", { type: "image/png" }));
    const subida = await app.request("/v1/companies/logo", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await tokenDe(DUENA)}`,
        "X-Company-Id": COMPANY,
      },
      body: form,
    });
    expect(subida.status).toBe(201);
    const { logo_path, logo_url } = (await subida.json()) as {
      logo_path: string;
      logo_url: string | null;
    };
    expect(logo_path.endsWith("/logo-256.webp")).toBe(true);
    expect(logo_path.startsWith(`${COMPANY}/logo/`)).toBe(true);
    expect(logo_url).toContain("token=");

    const lista = (await (await pedir("GET", "/v1/companies", undefined, false)).json()) as Record<
      string,
      unknown
    >[];
    expect(String(lista.find((x) => x["id"] === COMPANY)!["logo_url"])).toContain("token=");

    // El PDF de la factura plantada lleva la IMAGEN de verdad: un XObject
    // /Image en el binario. Sin logo no existía ninguno (el layout es texto).
    const [doc] = await sql<{ id: string }[]>`
      select id from public.documents where company_id = ${COMPANY} and kind = 'invoice' limit 1`;
    const pdf = await pedir("GET", `/v1/documents/${doc!.id}/pdf`);
    expect(pdf.status).toBe(200);
    const bruto = Buffer.from(await pdf.arrayBuffer());
    expect(bruto.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bruto.toString("latin1")).toContain("/Subtype /Image");
  });
});

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * LA CAJA, OLA 4 (recorrido 2026-09-24: E-09, E-07, E-13, E-14).
 *
 * E-09 · FIAR EXIGE PERMISO Y LÍMITE. Una empresa con cajero, administrativo y una persona que
 * vende pero no tiene `sales.credit`. Cada caso asevera lo que SOLO produce su camino (el `code`
 * y el MENSAJE, y el dato en la base: un rechazo no deja documento):
 *   · el cliente recién creado nace con límite 0: el cajero no le fía (409 CREDIT_LIMIT_EXCEEDED);
 *   · el cajero no fija el límite (403, `customers.credit.set`); el administrativo sí, y queda
 *     el acta con el valor anterior y el nuevo;
 *   · dentro del límite se fía; pasado el límite, no — y de contado se le sigue vendiendo;
 *   · quien vende sin `sales.credit` no fía aunque el cliente tenga límite (403, `sales.credit`);
 *   · dos fiados simultáneos que juntos pasan el límite: entra UNO;
 *   · la caja lo sabe ANTES: la cotización dice el disponible y si cubre el total.
 * E-07 · la cuadrícula cotiza por la lista del cliente elegido: lo que enseña es lo que cobra.
 * E-13 · el ajuste «vender sin existencia» ya no se lee ni se ofrece.
 * E-14 · la caja crea un J «especial» si se le dice, y la clasificación se cambia después con
 *        permiso (el cajero no).
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
const FUENTE_TASA = `BCV e2e-fiar-${RUN}`;
const FUENTE_REGLA = "Carga de prueba E2E — VALIDAR-SENIAT antes de producción.";

const FUNDADOR = crypto.randomUUID();
const CAJERO = crypto.randomUUID();
const ADMINISTRATIVO = crypto.randomUUID();
const SIN_CREDITO = crypto.randomUUID();
const ROL_SIN_CREDITO = crypto.randomUUID();
const KEY_SIN_CREDITO = `e2efiar_sincredito_${RUN}`;

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let COMPANY = "";
let DEPOSITO = "";
let PRODUCTO = "";
let CLIENTE = "";
/** El total (USD, con IVA) de UNA unidad, dicho por el servidor. */
let TOTAL_USD = "";

const tokenDe = (sub: string) =>
  new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);

async function pedir(metodo: string, path: string, sub: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await tokenDe(sub)}` };
  if (COMPANY !== "") headers["X-Company-Id"] = COMPANY;
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

type Fallo = { code: string; message: string };

/** Vende `cantidad` unidades a `cliente`; sin `pago`, la venta entera queda fiada. */
function vender(sub: string, cliente: string, cantidad: string, pago?: string) {
  return pedir("POST", "/v1/pos/sales", sub, {
    company_id: COMPANY,
    warehouse_id: DEPOSITO,
    customer_id: cliente,
    lines: [{ product_id: PRODUCTO, quantity: cantidad }],
    // P-05: una venta que deja saldo dice cuándo se paga (entrada del fixture: hoy + 15 días).
    due_date: diaCaracas(15),
    ...(pago === undefined
      ? {}
      : { payments: [{ instrument: "efectivo_usd", currency: "USD", amount: pago }] }),
  });
}

async function documentosDe(cliente: string): Promise<number> {
  const [f] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.documents
     where company_id = ${COMPANY} and customer_id = ${cliente}`;
  return f!.n;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id, email) values
            (${FUNDADOR}, ${`fundador-fiar-${RUN}@e2e.ladino`}),
            (${CAJERO}, ${`cajero-fiar-${RUN}@e2e.ladino`}),
            (${ADMINISTRATIVO}, ${`administrativo-fiar-${RUN}@e2e.ladino`}),
            (${SIN_CREDITO}, ${`sincredito-fiar-${RUN}@e2e.ladino`})
            on conflict (id) do nothing`;
  // Vende y cobra, crea clientes y ve la deuda: todo lo del cajero MENOS `sales.credit`.
  await sql`insert into public.roles (id, tenant_id, key, name, requires_scope)
            values (${ROL_SIN_CREDITO}, null, ${KEY_SIN_CREDITO}, 'Vende sin fiar', false)`;
  await sql`insert into public.role_permissions (role_id, permission_key) values
            (${ROL_SIN_CREDITO}, 'sales.invoice.issue'), (${ROL_SIN_CREDITO}, 'sales.payment.register'),
            (${ROL_SIN_CREDITO}, 'ar.read'), (${ROL_SIN_CREDITO}, 'customer.manage')`;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40, ${HOY}::date, now(), ${FUENTE_TASA}
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = ${HOY}::date)`;
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

describe(
  "la caja: fiar con permiso y límite, y lo que la tarjeta enseña",
  { timeout: 60_000 },
  () => {
    it("el fundador funda, factura sobre forma libre, carga un producto y suma a su gente", async () => {
      const r = await pedir("POST", "/v1/onboarding", FUNDADOR, {
        business_name: `Bodega Fiado ${RUN}`,
        tax_id: `J-77${RUN.slice(-6)
          .replace(/[^0-9]/g, "3")
          .padStart(6, "3")}-1`,
        legal_name: `Bodega Fiado ${RUN}, C.A.`,
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
        printer_source: "Imprenta E2E fiado, autorización de prueba",
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
        name: `Producto fiado ${RUN}`,
        price: { amount: "5", currency: "USD" },
        initial_stock: { quantity: "40", unit_cost: { amount: "120", currency: "VES" } },
      });
      expect(p.status).toBe(201);
      PRODUCTO = ((await p.json()) as { product: { id: string } }).product.id;

      for (const [rol, sub, correo] of [
        ["cashier", CAJERO, `cajero-fiar-${RUN}@e2e.ladino`],
        ["back_office", ADMINISTRATIVO, `administrativo-fiar-${RUN}@e2e.ladino`],
        // Entra como cajero y se le cambia el rol por el suyo: la API solo invita con roles de sistema.
        ["cashier", SIN_CREDITO, `sincredito-fiar-${RUN}@e2e.ladino`],
      ] as const) {
        void sub;
        const m = await pedir("POST", "/v1/members", FUNDADOR, {
          company_id: COMPANY,
          email: correo,
          role_key: rol,
        });
        expect(m.status).toBe(201);
      }

      const cambiado = await sql`
      update public.user_role_assignments a set role_id = ${ROL_SIN_CREDITO}
        from public.memberships m
       where m.id = a.membership_id and m.user_id = ${SIN_CREDITO}
      returning a.id`;
      expect(cambiado).toHaveLength(1);

      const cot = await pedir("POST", "/v1/pos/quote", FUNDADOR, {
        company_id: COMPANY,
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
      });
      expect(cot.status).toBe(200);
      TOTAL_USD = ((await cot.json()) as { total: string }).total;
      expect(TOTAL_USD).toBe("5.80000000");
    });

    it("E-09 · el cliente que el cajero acaba de crear nace con límite 0, y no se le fía", async () => {
      const alta = await pedir("POST", "/v1/customers", CAJERO, {
        company_id: COMPANY,
        tax_id: `V${String(Date.now()).slice(-8)}`,
        legal_name: `Cliente fiado ${RUN}`,
        person_type_code: "natural",
      });
      expect(alta.status).toBe(201);
      const c = (await alta.json()) as { id: string; credit_limit_usd: string };
      CLIENTE = c.id;
      expect(c.credit_limit_usd).toBe("0.00000000");

      const r = await vender(CAJERO, CLIENTE, "1");
      expect(r.status).toBe(409);
      const cuerpo = (await r.json()) as Fallo;
      expect(cuerpo.code).toBe("CREDIT_LIMIT_EXCEEDED");
      expect(cuerpo.message).toMatch(/límite de fiado es 0/);
      // El rechazo no deja ni factura ni número gastado.
      expect(await documentosDe(CLIENTE)).toBe(0);
    });

    it("E-09 · el alta no acepta un límite: nace en 0 y lo fija otro permiso", async () => {
      const r = await pedir("POST", "/v1/customers", CAJERO, {
        company_id: COMPANY,
        tax_id: `V${String(Date.now() + 7).slice(-8)}`,
        legal_name: `Cliente con límite de regalo ${RUN}`,
        person_type_code: "natural",
        credit_limit_usd: "500",
      });
      expect(r.status).toBe(422);
    });

    it("E-09 · el cajero NO fija el límite; el administrativo sí, y queda el acta", async () => {
      const cajero = await pedir("PUT", `/v1/customers/${CLIENTE}/credit-limit`, CAJERO, {
        company_id: COMPANY,
        credit_limit_usd: "1000",
      });
      expect(cajero.status).toBe(403);
      const fallo = (await cajero.json()) as Fallo;
      expect(fallo.code).toBe("PERMISSION_REQUIRED");
      expect(fallo.message).toMatch(/customers\.credit\.set/);
      const [intacto] = await sql<{ l: string }[]>`
      select credit_limit_usd::text as l from public.customers where id = ${CLIENTE}`;
      expect(intacto!.l).toBe("0.00000000");

      // Un límite negativo o que no es un importe no entra.
      for (const malo of ["-1", "diez", "10.123"]) {
        const m = await pedir("PUT", `/v1/customers/${CLIENTE}/credit-limit`, ADMINISTRATIVO, {
          company_id: COMPANY,
          credit_limit_usd: malo,
        });
        expect(m.status).toBe(422);
      }

      const admin = await pedir("PUT", `/v1/customers/${CLIENTE}/credit-limit`, ADMINISTRATIVO, {
        company_id: COMPANY,
        credit_limit_usd: "10",
      });
      expect(admin.status).toBe(200);
      expect(((await admin.json()) as { credit_limit_usd: string }).credit_limit_usd).toBe(
        "10.00000000",
      );
      const actas = await sql<{ antes: string; despues: string; actor_type: string }[]>`
      select payload->>'credit_limit_usd_anterior' as antes,
             payload->>'credit_limit_usd_nuevo' as despues, actor_type
        from public.audit_events
       where company_id = ${COMPANY} and aggregate_id = ${CLIENTE}
         and event_type = 'customer.credit_limit_set'`;
      expect(actas).toHaveLength(1);
      expect(actas[0]!.antes).toBe("0.00000000");
      expect(actas[0]!.despues).toBe("10.00000000");
      expect(actas[0]!.actor_type).toBe("user");
    });

    it("E-09 · dentro del límite se fía; pasado el límite no; de contado se le sigue vendiendo", async () => {
      const dentro = await vender(CAJERO, CLIENTE, "1");
      expect(dentro.status).toBe(201);
      expect(((await dentro.json()) as { document_status: string }).document_status).toBe("issued");

      // Debe 5,80 y el límite es 10: otra unidad lo dejaría en 11,60.
      const fuera = await vender(CAJERO, CLIENTE, "1");
      expect(fuera.status).toBe(409);
      const cuerpo = (await fuera.json()) as Fallo;
      expect(cuerpo.code).toBe("CREDIT_LIMIT_EXCEEDED");
      expect(cuerpo.message).toMatch(/10\.00/);
      expect(cuerpo.message).toMatch(/11\.60/);
      expect(await documentosDe(CLIENTE)).toBe(1);

      // El pago parcial que se queda corto también es fiado: 1 USD de 5,80 deja 4,80 más.
      const parcial = await vender(CAJERO, CLIENTE, "1", "1");
      expect(parcial.status).toBe(409);
      expect(((await parcial.json()) as Fallo).code).toBe("CREDIT_LIMIT_EXCEEDED");
      expect(await documentosDe(CLIENTE)).toBe(1);

      const contado = await vender(CAJERO, CLIENTE, "1", TOTAL_USD);
      expect(contado.status).toBe(201);
      expect(((await contado.json()) as { document_status: string }).document_status).toBe("paid");
    });

    it("E-09 · quien vende sin `sales.credit` no fía, aunque el cliente tenga límite", async () => {
      // Un cliente con límite de sobra: lo único que falta es el permiso.
      const alta = await pedir("POST", "/v1/customers", FUNDADOR, {
        company_id: COMPANY,
        tax_id: `V${String(Date.now() + 13).slice(-8)}`,
        legal_name: `Cliente con límite ${RUN}`,
        person_type_code: "natural",
      });
      const holgado = ((await alta.json()) as { id: string }).id;
      expect(
        (
          await pedir("PUT", `/v1/customers/${holgado}/credit-limit`, FUNDADOR, {
            company_id: COMPANY,
            credit_limit_usd: "100",
          })
        ).status,
      ).toBe(200);

      const r = await vender(SIN_CREDITO, holgado, "1");
      expect(r.status).toBe(403);
      const cuerpo = (await r.json()) as Fallo;
      expect(cuerpo.code).toBe("PERMISSION_REQUIRED");
      expect(cuerpo.message).toMatch(/sales\.credit/);
      expect(await documentosDe(holgado)).toBe(0);

      // De contado sí vende: el permiso gobierna el fiado, no la venta.
      const contado = await vender(SIN_CREDITO, holgado, "1", TOTAL_USD);
      expect(contado.status).toBe(201);
    });

    it("E-09 · la caja lo sabe ANTES: la cotización dice el disponible y si cubre", async () => {
      const cot = await pedir("POST", "/v1/pos/quote", CAJERO, {
        company_id: COMPANY,
        customer_id: CLIENTE,
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
      });
      expect(cot.status).toBe(200);
      const q = (await cot.json()) as {
        credit: {
          permitted: boolean;
          limit_usd: string;
          debt_usd: string | null;
          available_usd: string | null;
          covers_total: boolean;
        } | null;
      };
      expect(q.credit).toEqual({
        permitted: true,
        limit_usd: "10.00",
        debt_usd: "5.80",
        available_usd: "4.20",
        covers_total: false,
      });

      const sin = await pedir("POST", "/v1/pos/quote", SIN_CREDITO, {
        company_id: COMPANY,
        customer_id: CLIENTE,
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
      });
      expect(((await sin.json()) as { credit: { permitted: boolean } }).credit.permitted).toBe(
        false,
      );

      // Al mostrador no se le fía: no hay crédito que enseñar.
      const mostrador = await pedir("POST", "/v1/pos/quote", CAJERO, {
        company_id: COMPANY,
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
      });
      expect(((await mostrador.json()) as { credit: unknown }).credit).toBeNull();
    });

    it("E-09 · dos fiados simultáneos que juntos pasan el límite: entra UNO", async () => {
      // Debe 5,80. Con límite 12, cada fiado de 5,80 cabe por separado (11,60); los dos, no (17,40).
      expect(
        (
          await pedir("PUT", `/v1/customers/${CLIENTE}/credit-limit`, ADMINISTRATIVO, {
            company_id: COMPANY,
            credit_limit_usd: "12",
          })
        ).status,
      ).toBe(200);
      const [a, b] = await Promise.all([
        vender(CAJERO, CLIENTE, "1"),
        vender(CAJERO, CLIENTE, "1"),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const perdedor = a.status === 409 ? a : b;
      expect(((await perdedor.json()) as Fallo).code).toBe("CREDIT_LIMIT_EXCEEDED");
      const [credito] = await sql<{ deuda: string }[]>`
      select debt_usd::text as deuda from platform.customer_credit(${COMPANY}, ${CLIENTE})`;
      expect(credito!.deuda).toBe("11.60");
    });

    it("R-82.1 · UNA SOLA PUERTA: la factura de administración fía con la MISMA regla que la caja", async () => {
      // `POST /v1/invoices` nace sin cobro: es crédito por definición. El cajero tiene
      // `sales.invoice.issue`; sin la regla, por aquí fiaba sin permiso ni límite.
      const facturar = (sub: string, cliente: string) =>
        pedir("POST", "/v1/invoices", sub, {
          company_id: COMPANY,
          customer_id: cliente,
          warehouse_id: DEPOSITO,
          lines: [{ product_id: PRODUCTO, quantity: "1" }],
        });
      const alta = await pedir("POST", "/v1/customers", FUNDADOR, {
        company_id: COMPANY,
        tax_id: `V${String(Date.now() + 29).slice(-8)}`,
        legal_name: `Cliente de administración ${RUN}`,
        person_type_code: "natural",
      });
      expect(alta.status).toBe(201);
      const nuevo = ((await alta.json()) as { id: string }).id;

      // Límite 0: el mismo rechazo que en la caja, y ni factura ni número gastado.
      const cero = await facturar(CAJERO, nuevo);
      expect(cero.status).toBe(409);
      const falloCero = (await cero.json()) as Fallo;
      expect(falloCero.code).toBe("CREDIT_LIMIT_EXCEEDED");
      expect(falloCero.message).toMatch(/límite de fiado es 0/);
      expect(await documentosDe(nuevo)).toBe(0);

      expect(
        (
          await pedir("PUT", `/v1/customers/${nuevo}/credit-limit`, ADMINISTRATIVO, {
            company_id: COMPANY,
            credit_limit_usd: "10",
          })
        ).status,
      ).toBe(200);

      // Con límite y sin el permiso: 403 por `sales.credit`, no por emitir (que sí lo tiene).
      const sinPermiso = await facturar(SIN_CREDITO, nuevo);
      expect(sinPermiso.status).toBe(403);
      const falloPermiso = (await sinPermiso.json()) as Fallo;
      expect(falloPermiso.code).toBe("PERMISSION_REQUIRED");
      expect(falloPermiso.message).toMatch(/sales\.credit/);
      expect(await documentosDe(nuevo)).toBe(0);

      // Con límite y permiso: se emite, y queda debiendo.
      const dentro = await facturar(CAJERO, nuevo);
      expect(dentro.status).toBe(201);
      expect(((await dentro.json()) as { status: string }).status).toBe("issued");

      // Por encima del límite (5,80 + 5,80 contra 10): rechazo, con las dos cifras.
      const fuera = await facturar(CAJERO, nuevo);
      expect(fuera.status).toBe(409);
      const falloFuera = (await fuera.json()) as Fallo;
      expect(falloFuera.code).toBe("CREDIT_LIMIT_EXCEEDED");
      expect(falloFuera.message).toMatch(/10\.00/);
      expect(falloFuera.message).toMatch(/11\.60/);
      expect(await documentosDe(nuevo)).toBe(1);
    });

    // ── R-82.5 · EL CANDADO DEL FIADO, AISLADO DEL TALONARIO ──────────────────────────────────
    // El test «dos fiados simultáneos» de arriba va por LA MISMA serie: el correlativo
    // (`claim_document_number`, advisory por empresa|clase|serie) ya los pone en fila y pasaría
    // igual sin el candado por cliente. Aquí los dos fiados no comparten NADA más que el cliente:
    // la caja emite por la serie A con un producto, la factura de administración por la serie B
    // con otro (otro correlativo, otro talonario, otra posición de kardex).
    let PRODUCTO_B = "";
    let altas = 0;

    /** Un cliente nuevo con su límite de fiado ya fijado. */
    async function clienteConLimite(nombre: string, limite: string): Promise<string> {
      altas += 1;
      const alta = await pedir("POST", "/v1/customers", FUNDADOR, {
        company_id: COMPANY,
        tax_id: `V${String(Date.now() + 1000 + altas * 37).slice(-8)}`,
        legal_name: `${nombre} ${RUN}`,
        person_type_code: "natural",
      });
      expect(alta.status).toBe(201);
      const id = ((await alta.json()) as { id: string }).id;
      const limiteFijado = await pedir("PUT", `/v1/customers/${id}/credit-limit`, ADMINISTRATIVO, {
        company_id: COMPANY,
        credit_limit_usd: limite,
      });
      expect(limiteFijado.status).toBe(200);
      return id;
    }

    /** Fiado por LA CAJA: serie A, el producto de siempre, sin cobro. */
    const fiarPorCaja = (cliente: string) =>
      pedir("POST", "/v1/pos/sales", CAJERO, {
        company_id: COMPANY,
        warehouse_id: DEPOSITO,
        customer_id: cliente,
        series: "A",
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
        due_date: diaCaracas(15),
      });

    /** Fiado por ADMINISTRACIÓN: serie B, otro producto. Nace sin cobro. */
    const fiarPorAdministracion = (cliente: string) =>
      pedir("POST", "/v1/invoices", CAJERO, {
        company_id: COMPANY,
        customer_id: cliente,
        warehouse_id: DEPOSITO,
        series: "B",
        lines: [{ product_id: PRODUCTO_B, quantity: "1" }],
      });

    /** Quién tiene y quién espera EL candado de este cliente (la misma clave que `candadoDeFiado`). */
    async function candadoDe(
      cliente: string,
    ): Promise<{ lo_tiene_parado: number; en_cola: number }> {
      const [f] = await sql<{ lo_tiene_parado: number; en_cola: number }[]>`
        select count(*) filter (where l.granted and a.wait_event_type = 'Lock')::int
                 as lo_tiene_parado,
               count(*) filter (where not l.granted)::int as en_cola
          from pg_locks l
          join pg_stat_activity a on a.pid = l.pid
         where l.locktype = 'advisory' and l.objsubid = 1
           and ((l.classid::bigint << 32) | l.objid::bigint)
               = hashtextextended(${"customer_credit:" + cliente}, 0)`;
      return f!;
    }

    async function esperarA(
      cliente: string,
      condicion: (c: { lo_tiene_parado: number; en_cola: number }) => boolean,
    ): Promise<{ lo_tiene_parado: number; en_cola: number }> {
      let visto = await candadoDe(cliente);
      for (let i = 0; i < 200 && !condicion(visto); i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        visto = await candadoDe(cliente);
      }
      return visto;
    }

    it("R-82.5 · un segundo talonario y un segundo producto: dos caminos que no comparten serie", async () => {
      const rango = await pedir("POST", "/v1/fiscal-number-ranges", FUNDADOR, {
        company_id: COMPANY,
        kind: "invoice",
        series: "B",
        range_from: "101",
        range_to: "200",
        printer_source: "Imprenta E2E fiado, autorización de prueba",
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
        name: `Producto fiado B ${RUN}`,
        price: { amount: "5", currency: "USD" },
        initial_stock: { quantity: "40", unit_cost: { amount: "120", currency: "VES" } },
      });
      expect(p.status).toBe(201);
      PRODUCTO_B = ((await p.json()) as { product: { id: string } }).product.id;

      // Los dos caminos, cada uno por su serie: es la premisa de los tests que siguen.
      const holgado = await clienteConLimite("Cliente de dos series", "100");
      const caja = await fiarPorCaja(holgado);
      expect(caja.status).toBe(201);
      const administracion = await fiarPorAdministracion(holgado);
      expect(administracion.status).toBe(201);
      const series = await sql<{ series: string }[]>`
        select series from public.documents
         where company_id = ${COMPANY} and customer_id = ${holgado} order by series`;
      expect(series.map((s) => s.series)).toEqual(["A", "B"]);
    });

    it(
      "R-82.5 · dos fiados simultáneos por series DISTINTAS (caja y administración): entra UNO, diez rondas",
      { timeout: 180_000 },
      async () => {
        // Límite 6: un fiado de 5,80 cabe; los dos (11,60), no. Es una carrera: se repite.
        const ganadores: string[] = [];
        for (let ronda = 1; ronda <= 10; ronda += 1) {
          const cliente = await clienteConLimite(`Cliente de carrera ${ronda}`, "6");
          const [caja, administracion] = await Promise.all([
            fiarPorCaja(cliente),
            fiarPorAdministracion(cliente),
          ]);
          expect([caja.status, administracion.status].sort(), `ronda ${ronda}`).toEqual([201, 409]);
          const perdedor = caja.status === 409 ? caja : administracion;
          ganadores.push(caja.status === 201 ? "caja" : "administración");
          const fallo = (await perdedor.json()) as Fallo;
          expect(fallo.code, `ronda ${ronda}`).toBe("CREDIT_LIMIT_EXCEEDED");
          expect(fallo.message).toMatch(/6\.00/);
          expect(fallo.message).toMatch(/11\.60/);
          const [credito] = await sql<{ deuda: string }[]>`
            select debt_usd::text as deuda from platform.customer_credit(${COMPANY}, ${cliente})`;
          expect(credito!.deuda, `ronda ${ronda}`).toBe("5.80");
          expect(await documentosDe(cliente), `ronda ${ronda}`).toBe(1);
        }
        expect(ganadores).toHaveLength(10);
      },
    );

    // LA VARIANTE ROTA Y EL CANDADO, SIN AZAR. La carrera de arriba es muestral: un verde dice
    // «no vi entrar a las dos», no «no pueden». Aquí el entrelazado se FABRICA: una sesión aparte
    // retiene la posición de kardex del primer fiado, que queda parado con su documento emitido y
    // sin commitear. En ese instante se mide:
    //   (1) LO QUE LEERÍA UN SEGUNDO FIADO SIN CANDADO: la deuda del cliente, leída desde otra
    //       sesión, NO incluye el documento del primero — la comprobación sola diría «cabe» a los
    //       dos. Es la variante rota: no es el código corriendo sin el candado (no hay interruptor
    //       para quitarlo, ni debe haberlo), es la lectura que el candado impide que ocurra;
    //   (2) QUE EL SEGUNDO FIADO ESPERA EN EL CANDADO DEL CLIENTE, por su clave, y no en otro
    //       sitio: si `quickSale` o `emitirVenta` dejaran de tomarlo, nadie quedaría en cola.
    // En los dos sentidos: administración primero y caja después, y al revés.
    for (const caso of [
      { primero: "administración", segundo: "caja" },
      { primero: "caja", segundo: "administración" },
    ] as const) {
      it(`R-82.5 · variante rota: sin el candado, el segundo fiado (${caso.segundo}) leería una deuda sin el primero (${caso.primero}); con él, espera`, async () => {
        const cliente = await clienteConLimite(`Cliente del candado ${caso.primero}`, "6");
        const productoDelPrimero = caso.primero === "caja" ? PRODUCTO : PRODUCTO_B;
        const fiar = (camino: "caja" | "administración") =>
          camino === "caja" ? fiarPorCaja(cliente) : fiarPorAdministracion(cliente);

        let soltar!: () => void;
        const suelta = new Promise<void>((r) => (soltar = r));
        let retenido!: () => void;
        const yaRetenido = new Promise<void>((r) => (retenido = r));
        const retencion = sql.begin(async (tx) => {
          await tx`select 1 from public.stock_balances
                    where company_id = ${COMPANY} and product_id = ${productoDelPrimero}
                      for update`;
          retenido();
          await suelta;
        });
        let primero: Promise<Response> | undefined;
        let segundo: Promise<Response> | undefined;
        try {
          await yaRetenido;
          primero = fiar(caso.primero);
          // El primero tomó el candado del cliente, emitió, y está parado en el kardex.
          const parado = await esperarA(cliente, (c) => c.lo_tiene_parado === 1);
          expect(parado).toEqual({ lo_tiene_parado: 1, en_cola: 0 });

          // (1) La variante rota: otra sesión, sin candado, no ve la venta del primero.
          const [sinCandado] = await sql<{ deuda: string; disponible: string }[]>`
            select debt_usd::text as deuda, available_usd::text as disponible
              from platform.customer_credit(${COMPANY}, ${cliente})`;
          expect(sinCandado).toEqual({ deuda: "0", disponible: "6.00000000" });

          // (2) El segundo fiado, por la otra serie, se queda en la cola de ESTE candado.
          let segundoTermino = false;
          segundo = fiar(caso.segundo).then((r) => {
            segundoTermino = true;
            return r;
          });
          const enCola = await esperarA(cliente, (c) => c.en_cola === 1);
          expect(enCola).toEqual({ lo_tiene_parado: 1, en_cola: 1 });
          expect(segundoTermino).toBe(false);
        } finally {
          soltar();
          await retencion;
        }

        const r1 = await primero;
        expect(r1.status).toBe(201);
        const r2 = await segundo;
        expect(r2.status).toBe(409);
        const fallo = (await r2.json()) as Fallo;
        expect(fallo.code).toBe("CREDIT_LIMIT_EXCEEDED");
        expect(fallo.message).toMatch(/6\.00/);
        expect(fallo.message).toMatch(/11\.60/);
        const [credito] = await sql<{ deuda: string }[]>`
          select debt_usd::text as deuda from platform.customer_credit(${COMPANY}, ${cliente})`;
        expect(credito!.deuda).toBe("5.80");
        expect(await documentosDe(cliente)).toBe(1);
      });
    }

    it("regla 4 · fijar el límite de fiado exige `Idempotency-Key`, y la misma clave deja UNA sola acta", async () => {
      const cliente = await clienteConLimite("Cliente de la clave", "10");
      const cabeceras = async (): Promise<Record<string, string>> => ({
        Authorization: `Bearer ${await tokenDe(ADMINISTRATIVO)}`,
        "X-Company-Id": COMPANY,
        "Content-Type": "application/json",
      });
      const cuerpo = JSON.stringify({ company_id: COMPANY, credit_limit_usd: "25" });

      const sinClave = await app.request(`/v1/customers/${cliente}/credit-limit`, {
        method: "PUT",
        headers: await cabeceras(),
        body: cuerpo,
      });
      expect(sinClave.status).toBe(400);
      expect(((await sinClave.json()) as Fallo).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
      const [intacto] = await sql<{ l: string }[]>`
        select credit_limit_usd::text as l from public.customers where id = ${cliente}`;
      expect(intacto!.l).toBe("10.00000000");

      const clave = crypto.randomUUID();
      for (let i = 0; i < 2; i += 1) {
        const r = await app.request(`/v1/customers/${cliente}/credit-limit`, {
          method: "PUT",
          headers: { ...(await cabeceras()), "Idempotency-Key": clave },
          body: cuerpo,
        });
        expect(r.status).toBe(200);
        expect(((await r.json()) as { credit_limit_usd: string }).credit_limit_usd).toBe(
          "25.00000000",
        );
      }
      const actas = await sql<{ despues: string }[]>`
        select payload->>'credit_limit_usd_nuevo' as despues from public.audit_events
         where company_id = ${COMPANY} and aggregate_id = ${cliente}
           and event_type = 'customer.credit_limit_set' order by occurred_at`;
      expect(actas.map((a) => a.despues)).toEqual(["10.00000000", "25.00000000"]);
    });

    it("E-07 · la cuadrícula cotiza por la lista del cliente: lo que enseña es lo que cobra", async () => {
      const [lista] = await sql<{ id: string }[]>`
      insert into public.price_lists (tenant_id, company_id, name, currency_code)
      select tenant_id, id, 'mayor e2e', 'USD' from public.companies where id = ${COMPANY}
      returning id`;
      await sql`
      insert into public.price_list_items
        (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
      select tenant_id, id, ${lista!.id}, ${PRODUCTO}, 4, now() - interval '1 day'
        from public.companies where id = ${COMPANY}`;
      const alta = await pedir("POST", "/v1/customers", FUNDADOR, {
        company_id: COMPANY,
        tax_id: "J-40888777-6",
        legal_name: `Bodegón Mayorista ${RUN}, C.A.`,
        fiscal_address: "Zona industrial I, Barquisimeto",
        default_price_list_id: lista!.id,
      });
      expect(alta.status).toBe(201);
      const mayorista = ((await alta.json()) as { id: string }).id;

      type Cuadricula = { items: { id: string; price_amount: string; price_list_id: string }[] };
      const base = `/v1/products?only_active=1&with_price=1&with_stock=1&per_page=60`;
      const mostrador = (await (await pedir("GET", base, CAJERO)).json()) as Cuadricula;
      const delCliente = (await (
        await pedir("GET", `${base}&customer_id=${mayorista}`, CAJERO)
      ).json()) as Cuadricula;
      const tarjetaMostrador = mostrador.items.find((i) => i.id === PRODUCTO)!;
      const tarjetaCliente = delCliente.items.find((i) => i.id === PRODUCTO)!;
      expect(tarjetaMostrador.price_amount).toBe("5.00000000");
      expect(tarjetaCliente.price_amount).toBe("4.00000000");
      expect(tarjetaCliente.price_list_id).toBe(lista!.id);

      // Y el carrito cobra exactamente eso.
      const cot = await pedir("POST", "/v1/pos/quote", CAJERO, {
        company_id: COMPANY,
        customer_id: mayorista,
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
      });
      const q = (await cot.json()) as { lines: { unit_price: string }[] };
      expect(q.lines[0]!.unit_price).toBe(tarjetaCliente.price_amount);

      // Un cliente sin lista preferida ve el precio de mostrador, igual que el carrito.
      const sinLista = (await (
        await pedir("GET", `${base}&customer_id=${CLIENTE}`, CAJERO)
      ).json()) as Cuadricula;
      expect(sinLista.items.find((i) => i.id === PRODUCTO)!.price_amount).toBe("5.00000000");
      // Un cliente que no es de la empresa no cotiza nada.
      const ajeno = await pedir("GET", `${base}&customer_id=${crypto.randomUUID()}`, CAJERO);
      expect(ajeno.status).toBe(404);
    });

    it("C-06 · «Vendo al mayor» lo enciende el dueño (el cajero, 403), y encenderlo o apagarlo no crea ni duplica listas: la «mayor» nace con la empresa", async () => {
      const listas = async (): Promise<string[]> => {
        const filas = await sql<{ name: string }[]>`
          select name from public.price_lists where company_id = ${COMPANY} order by name`;
        return filas.map((f) => f.name);
      };
      const antes = await listas();
      expect(antes).toContain("mayor");
      const leer = async (): Promise<boolean> =>
        (
          (await (await pedir("GET", "/v1/company-settings", FUNDADOR)).json()) as {
            sells_wholesale: boolean;
          }
        ).sells_wholesale;
      expect(await leer()).toBe(false);

      const [lista] = await sql<{ id: string }[]>`
        select id from public.price_lists where company_id = ${COMPANY} and name = 'mayor e2e'`;
      const conLista = async (cliente: string): Promise<number> => {
        const [n] = await sql<{ n: number }[]>`
          select count(*)::int as n from public.documents
           where company_id = ${COMPANY} and customer_id = ${cliente}
             and price_list_id = ${lista!.id}`;
        return n!.n;
      };
      // La lista ASIGNADA AL CLIENTE sigue aplicando con el ajuste apagado, como en HEAD: el
      // mayorista de E-07 se cobra por la suya, de contado, sin permiso alguno.
      const [mayorista] = await sql<{ id: string }[]>`
        select id from public.customers
         where company_id = ${COMPANY} and default_price_list_id = ${lista!.id}`;
      const ventaMayorista = await pedir("POST", "/v1/pos/sales", CAJERO, {
        company_id: COMPANY,
        warehouse_id: DEPOSITO,
        customer_id: mayorista!.id,
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
        payments: [{ instrument: "efectivo_usd", currency: "USD", amount: "4.64" }],
      });
      expect(ventaMayorista.status).toBe(201);
      expect(await conLista(mayorista!.id)).toBe(1);

      // CON EL AJUSTE APAGADO LA CAJA no cobra con otra lista, ni a quien tiene el permiso: el
      // ajuste no es solo de la pantalla. Ni al cotizar ni al cobrar.
      const APAGADO = "no tiene activado vender al mayor";
      const cotApagado = await pedir("POST", "/v1/pos/quote", ADMINISTRATIVO, {
        company_id: COMPANY,
        customer_id: CLIENTE,
        price_list_id: lista!.id,
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
      });
      expect(cotApagado.status).toBe(422);
      expect(((await cotApagado.json()) as Fallo).message).toContain(APAGADO);
      const ventaApagado = await pedir("POST", "/v1/pos/sales", ADMINISTRATIVO, {
        company_id: COMPANY,
        warehouse_id: DEPOSITO,
        customer_id: CLIENTE,
        price_list_id: lista!.id,
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
        payments: [{ instrument: "efectivo_usd", currency: "USD", amount: "4.64" }],
      });
      expect(ventaApagado.status).toBe(422);
      expect(((await ventaApagado.json()) as Fallo).message).toContain(APAGADO);
      expect(await conLista(CLIENTE)).toBe(0);
      // EL PERMISO VA PRIMERO: el cajero, que no lo tiene, recibe su 403 de siempre y no el
      // rechazo del ajuste.
      const cajeroApagado = await pedir("POST", "/v1/pos/quote", CAJERO, {
        company_id: COMPANY,
        customer_id: CLIENTE,
        price_list_id: lista!.id,
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
      });
      expect(cajeroApagado.status).toBe(403);
      expect(((await cajeroApagado.json()) as Fallo).message).toContain(
        "sales.price_list.override",
      );
      // LA FACTURA DE ADMINISTRACIÓN no depende del ajuste (como en HEAD): con el permiso y el
      // ajuste apagado, se emite con otra lista.
      const altaAdmin = await pedir("POST", "/v1/customers", FUNDADOR, {
        company_id: COMPANY,
        tax_id: `V${String(Date.now() + 61).slice(-8)}`,
        legal_name: `Cliente de otra lista ${RUN}`,
        person_type_code: "natural",
      });
      expect(altaAdmin.status).toBe(201);
      const clienteAdmin = ((await altaAdmin.json()) as { id: string }).id;
      expect(
        (
          await pedir("PUT", `/v1/customers/${clienteAdmin}/credit-limit`, ADMINISTRATIVO, {
            company_id: COMPANY,
            credit_limit_usd: "50",
          })
        ).status,
      ).toBe(200);
      const facturaAdmin = await pedir("POST", "/v1/invoices", FUNDADOR, {
        company_id: COMPANY,
        customer_id: clienteAdmin,
        warehouse_id: DEPOSITO,
        price_list_id: lista!.id,
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
      });
      expect(facturaAdmin.status).toBe(201);
      expect(await conLista(clienteAdmin)).toBe(1);

      const cajero = await pedir("PUT", "/v1/company-settings", CAJERO, { sells_wholesale: true });
      expect(cajero.status).toBe(403);
      expect(await leer()).toBe(false);
      const encendido = await pedir("PUT", "/v1/company-settings", FUNDADOR, {
        sells_wholesale: true,
      });
      expect(encendido.status).toBe(200);
      expect(await leer()).toBe(true);
      expect(await listas()).toEqual(antes);
    });

    it("C-06 · cambiar la lista de una venta exige `sales.price_list.override` EN EL SERVIDOR: el cajero recibe 403 con su mensaje y no vende; quien puede, vende al precio de esa lista y el documento la guarda", async () => {
      const [lista] = await sql<{ id: string }[]>`
        select id from public.price_lists where company_id = ${COMPANY} and name = 'mayor e2e'`;
      const cuerpo = (extra: Record<string, unknown>) => ({
        company_id: COMPANY,
        warehouse_id: DEPOSITO,
        customer_id: CLIENTE,
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
        ...extra,
      });
      const conLista = async (): Promise<number> => {
        const [n] = await sql<{ n: number }[]>`
          select count(*)::int as n from public.documents
           where company_id = ${COMPANY} and customer_id = ${CLIENTE}
             and price_list_id = ${lista!.id}`;
        return n!.n;
      };
      expect(await conLista()).toBe(0);

      // El cajero (sin el permiso) ni cotiza ni vende con otra lista.
      const cotCajero = await pedir("POST", "/v1/pos/quote", CAJERO, {
        company_id: COMPANY,
        customer_id: CLIENTE,
        price_list_id: lista!.id,
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
      });
      expect(cotCajero.status).toBe(403);
      const ventaCajero = await pedir(
        "POST",
        "/v1/pos/sales",
        CAJERO,
        cuerpo({
          price_list_id: lista!.id,
          payments: [{ instrument: "efectivo_usd", currency: "USD", amount: "4.64" }],
        }),
      );
      expect(ventaCajero.status).toBe(403);
      const fallo = (await ventaCajero.json()) as Fallo & { person_message: string };
      expect(fallo.code).toBe("PERMISSION_REQUIRED");
      // El mensaje de ESTE permiso, no el genérico: dos caminos dan 403.
      expect(fallo.message).toContain("sales.price_list.override");
      expect(fallo.person_message).toContain("cambiar la lista de precios de una venta");
      expect(await conLista()).toBe(0);

      // Quien puede (administrativo): cotiza a 4 y vende a 4.
      const cot = await pedir("POST", "/v1/pos/quote", ADMINISTRATIVO, {
        company_id: COMPANY,
        customer_id: CLIENTE,
        price_list_id: lista!.id,
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
      });
      expect(cot.status).toBe(200);
      const q = (await cot.json()) as {
        price_list_id: string;
        total: string;
        lines: { unit_price: string }[];
      };
      expect(q.price_list_id).toBe(lista!.id);
      expect(q.lines[0]!.unit_price).toBe("4.00000000");
      expect(q.total).toBe("4.64000000");
      const venta = await pedir(
        "POST",
        "/v1/pos/sales",
        ADMINISTRATIVO,
        cuerpo({
          price_list_id: lista!.id,
          payments: [{ instrument: "efectivo_usd", currency: "USD", amount: q.total }],
        }),
      );
      expect(venta.status).toBe(201);
      expect(await conLista()).toBe(1);
      // El documento guarda la lista que aplicó, en la cabecera y en cada línea.
      const [doc] = await sql<{ lineas: number; con_lista: number }[]>`
        select count(*)::int as lineas,
               count(*) filter (where l.price_list_applied_id = ${lista!.id})::int as con_lista
          from public.documents d
          join public.document_lines l on l.document_id = d.id
         where d.company_id = ${COMPANY} and d.customer_id = ${CLIENTE}
           and d.price_list_id = ${lista!.id}`;
      expect(doc).toEqual({ lineas: 1, con_lista: 1 });

      // Pedir la MISMA lista que ya aplicaría no es cambiarla: el cajero no necesita permiso.
      const sinPedir = await pedir("POST", "/v1/pos/quote", CAJERO, {
        company_id: COMPANY,
        customer_id: CLIENTE,
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
      });
      const laQueAplica = ((await sinPedir.json()) as { price_list_id: string }).price_list_id;
      expect(laQueAplica).not.toBe(lista!.id);
      const misma = await pedir("POST", "/v1/pos/quote", CAJERO, {
        company_id: COMPANY,
        customer_id: CLIENTE,
        price_list_id: laQueAplica,
        lines: [{ product_id: PRODUCTO, quantity: "1" }],
      });
      expect(misma.status).toBe(200);
    });

    it("C-06 · un producto sin precio en la lista que aplica no se vende por ella, y el mensaje dice cuál producto y cuál lista", async () => {
      const [lista] = await sql<{ id: string }[]>`
        select id from public.price_lists where company_id = ${COMPANY} and name = 'mayor e2e'`;
      const p = await pedir("POST", "/v1/products/simple", FUNDADOR, {
        company_id: COMPANY,
        name: `Solo al detal ${RUN}`,
        price: { amount: "9", currency: "USD" },
      });
      expect(p.status).toBe(201);
      const soloDetal = ((await p.json()) as { product: { id: string } }).product.id;
      const cot = await pedir("POST", "/v1/pos/quote", ADMINISTRATIVO, {
        company_id: COMPANY,
        customer_id: CLIENTE,
        price_list_id: lista!.id,
        lines: [{ product_id: soloDetal, quantity: "1" }],
      });
      expect(cot.status).toBe(422);
      const fallo = (await cot.json()) as Fallo;
      expect(fallo.message).toContain(
        `«Solo al detal ${RUN}» no tiene precio en la lista «mayor e2e»`,
      );
      // Por la lista de mostrador sí se cotiza: no cayó a ella en silencio, se eligió.
      const mostrador = await pedir("POST", "/v1/pos/quote", ADMINISTRATIVO, {
        company_id: COMPANY,
        customer_id: CLIENTE,
        lines: [{ product_id: soloDetal, quantity: "1" }],
      });
      expect(mostrador.status).toBe(200);
      const m = (await mostrador.json()) as { lines: { unit_price: string }[] };
      expect(m.lines[0]!.unit_price).toBe("9.00000000");
    });

    it("E-13 · el ajuste «vender sin existencia» ya no se lee ni se ofrece", async () => {
      const r = await pedir("GET", "/v1/company-settings", FUNDADOR);
      expect(r.status).toBe(200);
      expect(await r.json()).not.toHaveProperty("block_sale_without_stock");
      const put = await pedir("PUT", "/v1/company-settings", FUNDADOR, {
        block_sale_without_stock: false,
      });
      expect(put.status).toBe(422);
    });

    it("E-14 · la caja crea un J especial si se le dice; cambiarlo después exige permiso", async () => {
      const alta = await pedir("POST", "/v1/customers", CAJERO, {
        company_id: COMPANY,
        tax_id: "J-30555444-2",
        legal_name: `Distribuidora Especial ${RUN}, C.A.`,
        fiscal_address: "Av. Lara, Barquisimeto",
        person_type_code: "juridica",
        taxpayer_type_code: "especial",
      });
      expect(alta.status).toBe(201);
      const especial = (await alta.json()) as { id: string; taxpayer_type_code: string };
      expect(especial.taxpayer_type_code).toBe("especial");

      const cajero = await pedir("PUT", `/v1/customers/${especial.id}/taxpayer-type`, CAJERO, {
        company_id: COMPANY,
        taxpayer_type_code: "ordinario",
      });
      expect(cajero.status).toBe(403);
      expect(((await cajero.json()) as Fallo).message).toMatch(/customer\.tax_id\.manage/);

      const admin = await pedir(
        "PUT",
        `/v1/customers/${especial.id}/taxpayer-type`,
        ADMINISTRATIVO,
        {
          company_id: COMPANY,
          taxpayer_type_code: "ordinario",
        },
      );
      expect(admin.status).toBe(200);
      expect(((await admin.json()) as { taxpayer_type_code: string }).taxpayer_type_code).toBe(
        "ordinario",
      );
      const actas = await sql<{ antes: string; despues: string }[]>`
      select payload->>'from' as antes, payload->>'to' as despues from public.audit_events
       where company_id = ${COMPANY} and aggregate_id = ${especial.id}
         and event_type = 'customer.taxpayer_type_changed'`;
      expect(actas).toEqual([{ antes: "especial", despues: "ordinario" }]);
    });

    it("los invariantes: todo documento posteado tiene su asiento o su cola", async () => {
      const huecos = await sql`select * from platform.accounting_coverage_gaps(${COMPANY})`;
      expect(huecos).toHaveLength(0);
    });
  },
);

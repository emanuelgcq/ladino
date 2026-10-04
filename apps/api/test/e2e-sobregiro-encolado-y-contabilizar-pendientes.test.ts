import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import {
  generateJournalFromDocument,
  repairOverdraftClosings,
  repairTreasurySubaccounts,
} from "@ladino/domain";
import { buildApp } from "../src/app.js";
import { diaCaracas } from "./_dia-caracas.js";
import { declararTipoDeFixture } from "./_tipo-de-fixture.js";

/**
 * J-02, REVISIÓN EN CONTEXTO LIMPIO · tres bordes de la reparación del sobregiro al cierre.
 *
 *   A1 · LA VENTANA. Entre el git pull y la reparación, un cierre en sobregiro que la API anterior
 *        dejó en la cola (origen `cash_closing`) se asentaba como INGRESO al pulsar «contabilizar
 *        pendientes». Ahora el reproceso lee el cierre y decide el hecho con la misma definición que
 *        el cierre y la reparación: la fila vieja se descarta con su acta y la contrapartida es el
 *        pasivo del dueño. Un cierre SIN sobregiro en la cola sigue su camino de siempre.
 *   A3 · EL CÉNTIMO. Un cierre viejo cuya cifra funcional guarda más de dos decimales produce un
 *        asiento nuevo al céntimo (no LAD71, no fracción en el mayor).
 *   A2 · LA CONTRAPARTIDA QUE PASÓ A AGRUPAR. La reversa solo traslada a la subcuenta de la caja la
 *        línea asentada en el PADRE de esa subcuenta. Otra cuenta que hoy agrupe (aquí, «Faltantes
 *        y sobrantes») no se redirige a la caja: la reparación se niega y no escribe nada.
 *   A6 · EL ORDEN DE R-71. La reparación J-02 es la última: corrida antes que la de subcuentas
 *        (ADR-0070) o que la del céntimo (ADR-0075 §7), se niega con un mensaje que dice qué
 *        correr antes, y no escribe nada. Y el guion del recorrido la corre la última.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const TENANT = crypto.randomUUID();
let COMPANY = crypto.randomUUID();
const COMPANY_ORDEN = crypto.randomUUID();
const DUENO = crypto.randomUUID();
const ROL = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
const EVENTO = "treasury.cash_register.closed";

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let DEL_DUENO = "";
let SOBRANTES = "";
let FAMILIA_BS = "";
const caja: Record<string, string> = {};
const cierre: Record<string, string> = {};
const asientoViejo: Record<string, string> = {};

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
    Authorization: `Bearer ${await tokenDe(DUENO)}`,
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

async function crearCaja(clave: string, mayor?: string): Promise<void> {
  const r = await pedir("POST", "/v1/treasury/accounts", {
    company_id: COMPANY,
    name: `Caja ${clave} ${RUN}`,
    currency: "VES",
    kind: "cash",
    ...(mayor === undefined ? {} : { ledger_account_id: mayor }),
  });
  expect(r.status).toBe(201);
  caja[clave] = ((await r.json()) as { id: string }).id;
}

/** Un cierre como lo dejó la API anterior: la fila y su hecho con el origen de siempre. */
async function cierreViejo(
  clave: string,
  o: { esperado: string; contado: string; enCola?: boolean; funcional?: string },
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`select set_config('ladino.rules_version', 'domain-s0.5', true)`;
    const [c] = await tx<{ id: string; funcional: string }[]>`
      insert into public.cash_closings
        (tenant_id, company_id, account_id, closing_date, closed_at, expected_amount,
         counted_amount, reason, amount_transaction_currency, transaction_currency, fx_rate,
         functional_amount, functional_currency, rate_source, rate_timestamp, rounding_policy_id)
      select ${TENANT}, ${COMPANY}, ca.id, ${HOY}::date, now(), ${o.esperado}::numeric,
             ${o.contado}::numeric, 'el pago del café salió de mi bolsillo',
             ${o.contado}::numeric - ${o.esperado}::numeric, ca.currency, 1,
             coalesce(${o.funcional ?? null}::numeric,
                      round(${o.contado}::numeric - ${o.esperado}::numeric, 2)),
             'VES', 'e2e', now(), 'treasury:cash_closing:8:HALF_UP'
        from public.company_accounts ca where ca.id = ${caja[clave]!}
      returning id, functional_amount::text as funcional`;
    cierre[clave] = c!.id;
    if (o.enCola === true) {
      await tx`
        insert into public.journal_generation_queue
          (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
        values (${TENANT}, ${COMPANY}, 'cash_closing', ${c!.id}, ${EVENTO},
                ${tx.json({
                  functional_amount: c!.funcional,
                  functional_currency: "VES",
                  posting_date: HOY,
                  description: `Cierre de caja ${clave}: sobrante`,
                })},
                'Falta configurar la cuenta de: cash_over_short (API anterior)')`;
      return;
    }
    const g = await generateJournalFromDocument(tx, {
      tenantId: TENANT,
      companyId: COMPANY,
      sourceKind: "cash_closing",
      sourceEvent: EVENTO,
      sourceId: c!.id,
      postingDate: HOY,
      postedBy: DUENO,
      description: `Cierre de caja ${clave}: sobrante`,
      functionalCurrency: "VES",
      amounts: { functional_amount: c!.funcional },
      backlink: { table: "cash_closings", id: c!.id },
    });
    if (!g.ok || g.value.kind !== "posted") {
      throw new Error(`fixture: el cierre viejo «${clave}» no se asentó: ${JSON.stringify(g)}`);
    }
    asientoViejo[clave] = g.value.entryId;
  });
}

type Linea = { cuenta: string; lado: "debe" | "haber"; importe: string };

/** El asiento vigente del cierre, con sus importes SIN redondear al leer: la fracción se vería. */
async function vigenteDe(
  clave: string,
): Promise<{ origen: string; posteo: string; lineas: Linea[] }> {
  const [e] = await sql<{ id: string; origen: string; posteo: string }[]>`
    select e.id, e.source_kind as origen, e.posted_by::text as posteo
      from public.cash_closings k join public.journal_entries e on e.id = k.journal_entry_id
     where k.id = ${cierre[clave]!} and e.status = 'posted'`;
  const lineas = await sql<Linea[]>`
    select l.account_id as cuenta,
           case when l.functional_debit > 0 then 'debe' else 'haber' end as lado,
           trim(trailing '.' from trim(trailing '0' from
             (l.functional_debit + l.functional_credit)::text)) as importe
      from public.journal_lines l where l.entry_id = ${e!.id} order by l.line_number`;
  return { origen: e!.origen, posteo: e!.posteo, lineas };
}

const subcuentaDe = async (clave: string): Promise<string> =>
  (
    await sql<{ id: string }[]>`
      select ledger_account_id as id from public.company_accounts where id = ${caja[clave]!}`
  )[0]!.id;

async function huecos(): Promise<string[]> {
  const filas = await sql<{ problem: string }[]>`
    select problem from platform.overdraft_closing_gaps(${COMPANY}) order by problem`;
  return filas.map((f) => f.problem);
}

async function rastro(): Promise<{ actas: number; asientos: number; lineas: number }> {
  const [n] = await sql<{ actas: number; asientos: number; lineas: number }[]>`
    select (select count(*)::int from public.audit_events where company_id = ${COMPANY}) as actas,
           (select count(*)::int from public.journal_entries where company_id = ${COMPANY})
             as asientos,
           (select count(*)::int from public.journal_lines where company_id = ${COMPANY}) as lineas`;
  return n!;
}

/** Una empresa con su plan y sus plantillas; deja en COMPANY la empresa activa del fichero. */
async function fundarEmpresa(id: string, rif: string, nombre: string): Promise<void> {
  COMPANY = id;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code,
                                           activity_start_date)
             values (${id}, ${TENANT}, ${rif}, ${nombre}, 'VES', 'ordinario',
                     ${diaCaracas(-120)}::date)`;
    await declararTipoDeFixture(tx, id);
  });
  for (const [ruta, cuerpo] of [
    ["/v1/accounts/import-template", { company_id: id, template_code: "ve_basico" }],
    ["/v1/journal-templates/import-preset", { company_id: id, preset_code: "ve_basico" }],
  ] as const) {
    expect((await pedir("POST", ruta, cuerpo)).status).toBe(201);
  }
  const papeles = await sql<{ purpose: string; account_id: string }[]>`
    select purpose, account_id from public.company_account_settings
     where company_id = ${id} and effective_to is null
       and purpose in ('owner_payable', 'cash_over_short', 'cash_bs')`;
  DEL_DUENO = papeles.find((p) => p.purpose === "owner_payable")!.account_id;
  SOBRANTES = papeles.find((p) => p.purpose === "cash_over_short")!.account_id;
  FAMILIA_BS = papeles.find((p) => p.purpose === "cash_bs")!.account_id;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e J-02 ventana')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2evj02_${RUN}`}, 'Dueño', false)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'treasury.read'), (${ROL}, 'treasury.account.manage'),
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.entry.post'), (${ROL}, 'accounting.read')
             on conflict do nothing`;
    const mem = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${mem}, ${TENANT}, ${DUENO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${crypto.randomUUID()}, ${TENANT}, ${mem}, ${ROL}, null)`;
  });
  await fundarEmpresa(COMPANY, `J-VJ02-${RUN}`, "Bodega entre el pull y la reparación");
  for (const clave of ["COLA", "NORMAL", "FRACCION", "AGRUPA"]) await crearCaja(clave);
  await cierreViejo("COLA", { esperado: "-50", contado: "20", enCola: true });
  await cierreViejo("NORMAL", { esperado: "10", contado: "15", enCola: true });
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("A1 · «contabilizar pendientes» antes de la reparación no asienta el sobregiro como ingreso", () => {
  it("antes: el invariante acusa el cierre en sobregiro que espera con el origen de siempre", async () => {
    expect(await huecos()).toEqual(["queued_as_surplus"]);
  });

  it("contabilizar pendientes: los dos hechos se asientan y overdraft_closing_gaps queda en cero", async () => {
    const r = await pedir("POST", "/v1/accounting/pending/process", {});
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      revisados: 2,
      contabilizados: 2,
      pendientes: 0,
      primer_motivo: null,
    });
    expect(await huecos()).toEqual([]);
  }, 60_000);

  it("el cierre en sobregiro: 50 al pasivo del dueño, 20 de sobrante, firmado por quien lo importó", async () => {
    const sub = await subcuentaDe("COLA");
    const v = await vigenteDe("COLA");
    expect(v.origen).toBe("cash_closing_overdraft");
    expect(v.posteo).toBe(DUENO);
    expect(v.lineas).toEqual([
      { cuenta: sub, lado: "debe", importe: "70" },
      { cuenta: DEL_DUENO, lado: "haber", importe: "50" },
      { cuenta: SOBRANTES, lado: "haber", importe: "20" },
    ]);
    // Ningún asiento del origen de siempre para ese cierre: el ingreso de 70 no existió nunca.
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.journal_entries
       where company_id = ${COMPANY} and source_id = ${cierre["COLA"]!}
         and source_kind = 'cash_closing'`;
    expect(n!.n).toBe(0);
  });

  it("la fila vieja queda descartada con su acta, y la reclasificación con la suya", async () => {
    const [q] = await sql<{ status: string; id: string }[]>`
      select status, id from public.journal_generation_queue
       where company_id = ${COMPANY} and source_id = ${cierre["COLA"]!}
         and source_kind = 'cash_closing'`;
    expect(q!.status).toBe("discarded");
    const actas = await sql<{ event_type: string; actor_type: string }[]>`
      select event_type, actor_type from public.audit_events
       where company_id = ${COMPANY}
         and ((event_type = 'accounting.pending_discarded' and payload ->> 'queue_id' = ${q!.id})
           or (event_type = 'treasury.overdraft_closing_reclassified'
               and aggregate_id = ${cierre["COLA"]!}))
       order by event_type`;
    expect(actas).toEqual([
      { event_type: "accounting.pending_discarded", actor_type: "user" },
      { event_type: "treasury.overdraft_closing_reclassified", actor_type: "user" },
    ]);
  });

  it("el cierre SIN sobregiro de la cola sigue siendo un sobrante, con el origen de siempre", async () => {
    const sub = await subcuentaDe("NORMAL");
    const v = await vigenteDe("NORMAL");
    expect(v.origen).toBe("cash_closing");
    expect(v.lineas).toEqual([
      { cuenta: sub, lado: "debe", importe: "5" },
      { cuenta: SOBRANTES, lado: "haber", importe: "5" },
    ]);
  });

  it("y la reparación, corrida después, no encuentra nada que mover", async () => {
    const antes = await rastro();
    const r = await sql.begin((tx) => repairOverdraftClosings(tx, COMPANY));
    expect(r.reclassified).toEqual([]);
    expect(r.requeued).toEqual([]);
    expect(await rastro()).toEqual(antes);
  }, 60_000);
});

describe("A3 · un cierre viejo con la cifra funcional a más de dos decimales", () => {
  it("el asiento nuevo nace al céntimo y cuadra: 70,00 = 50,00 + 20,00", async () => {
    // La cifra funcional guardada trae fracción (70,00456); el asiento viejo, como todo asiento
    // del generador, salió al céntimo.
    await cierreViejo("FRACCION", { esperado: "-50", contado: "20", funcional: "70.00456" });
    const r = await sql.begin((tx) => repairOverdraftClosings(tx, COMPANY));
    expect(r.reclassified.map((x) => x.cash_closing_id)).toEqual([cierre["FRACCION"]]);
    const sub = await subcuentaDe("FRACCION");
    const v = await vigenteDe("FRACCION");
    expect(v.origen).toBe("cash_closing_overdraft");
    expect(v.lineas).toEqual([
      { cuenta: sub, lado: "debe", importe: "70" },
      { cuenta: DEL_DUENO, lado: "haber", importe: "50" },
      { cuenta: SOBRANTES, lado: "haber", importe: "20" },
    ]);
    const [n] = await sql<Record<string, number>[]>`
      select (select count(*)::int from platform.cent_gaps(${COMPANY})) as centimo,
             (select count(*)::int from platform.treasury_ledger_gaps(${COMPANY})) as tesoreria,
             (select count(*)::int from platform.accounting_coverage_gaps(${COMPANY})) as cobertura`;
    expect(n).toEqual({ centimo: 0, tesoreria: 0, cobertura: 0 });
  }, 60_000);
});

describe("A2 · la contrapartida del asiento viejo pasó a agrupar", () => {
  it("la reparación se niega: no traslada a la caja una línea que no es de la caja, y no escribe nada", async () => {
    await cierreViejo("AGRUPA", { esperado: "-30", contado: "0" });
    // «Faltantes y sobrantes de caja» recibe una hija: desde hoy agrupa y no recibe asientos.
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`
        insert into public.accounts (tenant_id, company_id, code, name, parent_id, kind, nature)
        select tenant_id, company_id, code || '.01', 'Sobrantes de la caja chica', id, kind, nature
          from public.accounts where id = ${SOBRANTES}`;
    });
    const [hoja] = await sql<{ is_leaf: boolean }[]>`
      select is_leaf from public.accounts where id = ${SOBRANTES}`;
    expect(hoja!.is_leaf).toBe(false);

    const antes = await rastro();
    await expect(sql.begin((tx) => repairOverdraftClosings(tx, COMPANY))).rejects.toThrow(
      new RegExp(cierre["AGRUPA"]!),
    );
    expect(await rastro()).toEqual(antes);
    const [v] = await sql<{ status: string }[]>`
      select status from public.journal_entries where id = ${asientoViejo["AGRUPA"]!}`;
    expect(v!.status).toBe("posted");
    // Nada se movió a la subcuenta de la caja por una línea que era de resultado.
    const sub = await subcuentaDe("AGRUPA");
    const [m] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.journal_lines l
        join public.journal_entries e on e.id = l.entry_id
       where l.company_id = ${COMPANY} and l.account_id = ${sub} and e.source_kind = 'manual'`;
    expect(m!.n).toBe(0);
  }, 60_000);
});

describe("A6 · la reparación J-02 es la última de R-71, y se niega si se corre antes", () => {
  beforeAll(async () => {
    await fundarEmpresa(COMPANY_ORDEN, `J-OJ02-${RUN}`, "Bodega reparada en desorden");
    // Dos cajas anteriores a ADR-0070, las dos en la cuenta de familia (aún hoja).
    await crearCaja("FAM1", FAMILIA_BS);
    await crearCaja("FAM2", FAMILIA_BS);
    await cierreViejo("FAM1", { esperado: "-60", contado: "0" });
  }, 120_000);

  it("antes de las subcuentas (ADR-0070): se niega, dice qué correr antes y no escribe nada", async () => {
    const antes = await rastro();
    await expect(sql.begin((tx) => repairOverdraftClosings(tx, COMPANY))).rejects.toThrow(
      /Corre ANTES la reparación de subcuentas de tesorería \(scripts\/reparar\/adr-0070-subcuentas\.mjs\)/,
    );
    expect(await rastro()).toEqual(antes);
    const [v] = await sql<{ status: string }[]>`
      select status from public.journal_entries where id = ${asientoViejo["FAM1"]!}`;
    expect(v!.status).toBe("posted");
  }, 60_000);

  it("en su orden: corridas las subcuentas, la misma reparación termina el trabajo", async () => {
    const sub = await sql.begin((tx) => repairTreasurySubaccounts(tx, COMPANY));
    expect(sub.repaired).toBe(2);
    const r = await sql.begin((tx) => repairOverdraftClosings(tx, COMPANY));
    expect(r.reclassified.map((x) => x.cash_closing_id)).toEqual([cierre["FAM1"]]);
    expect(await huecos()).toEqual([]);
  }, 60_000);

  it("antes del céntimo (ADR-0075 §7): se niega, dice qué correr antes y no escribe nada", async () => {
    // Historia heredada con fracción de céntimo, como la deja una base anterior al corte: hoy no
    // entraría (LAD71), así que el guarda se apaga SOLO dentro de esta transacción.
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
      await tx`select set_config('ladino.rules_version', 'domain-s0.5', true)`;
      await tx`set constraints all immediate`;
      await tx`set local lock_timeout = '4s'`;
      const id = crypto.randomUUID();
      await tx`
        insert into public.journal_entries
          (id, tenant_id, company_id, period_id, posting_date, source_kind, description,
           rules_version)
        values (${id}, ${TENANT}, ${COMPANY}, platform.period_for_date(${COMPANY}, ${HOY}::date),
                ${HOY}::date, 'manual', 'Historia anterior al céntimo (e2e J-02)', 'domain-s0.5')`;
      let n = 0;
      for (const [cuenta, debe, haber] of [
        [SOBRANTES, "10.00456", "0"],
        [DEL_DUENO, "0", "10.00456"],
      ] as const) {
        n += 1;
        await tx`
          insert into public.journal_lines
            (tenant_id, company_id, entry_id, line_number, account_id, debit_amount,
             credit_amount, amount_transaction_currency, transaction_currency, fx_rate,
             functional_amount, functional_currency, rate_source, rate_timestamp,
             functional_debit, functional_credit)
          values (${TENANT}, ${COMPANY}, ${id}, ${n}, ${cuenta}, ${debe}::numeric,
                  ${haber}::numeric, 10.00456, 'VES', 1, 10.00456, 'VES', 'identidad', now(),
                  ${debe}::numeric, ${haber}::numeric)`;
      }
      await tx`alter table public.journal_entries disable trigger journal_entries_02_balanced`;
      await tx`
        update public.journal_entries
           set status = 'posted', posted_at = now(), posted_by = ${DUENO},
               entry_number = platform.claim_entry_number(${COMPANY},
                                extract(year from ${HOY}::date)::int)
         where id = ${id}`;
      await tx`alter table public.journal_entries enable trigger journal_entries_02_balanced`;
    });
    const [g] = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.cent_gaps(${COMPANY})`;
    expect(g!.n).toBeGreaterThan(0);

    await crearCaja("CENT");
    await cierreViejo("CENT", { esperado: "-25", contado: "0" });
    const antes = await rastro();
    await expect(sql.begin((tx) => repairOverdraftClosings(tx, COMPANY))).rejects.toThrow(
      /Corre ANTES la regularización del céntimo \(scripts\/reparar\/adr-0075-centimo\.mjs\)/,
    );
    expect(await rastro()).toEqual(antes);
    expect(await huecos()).toEqual(["posted_as_surplus"]);
  }, 60_000);

  it("el guion que restaura el escenario corre la de J-02 la ÚLTIMA de las reparaciones", () => {
    const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const guion = fs.readFileSync(path.join(raiz, "scripts", "recorrido", "correr.mjs"), "utf8");
    const orden = [...guion.matchAll(/"reparar",\s*"([a-z0-9-]+\.mjs)"/g)].map((m) => m[1]);
    expect(orden.at(-1)).toBe("j-02-sobregiro-al-cierre.mjs");
    expect(orden.indexOf("adr-0075-centimo.mjs")).toBeGreaterThanOrEqual(0);
    expect(orden.indexOf("adr-0075-centimo.mjs")).toBeLessThan(
      orden.indexOf("adr-0070-subcuentas.mjs"),
    );
    expect(orden.indexOf("adr-0070-subcuentas.mjs")).toBeLessThan(
      orden.indexOf("j-02-sobregiro-al-cierre.mjs"),
    );
    expect(orden.filter((x) => x === "j-02-sobregiro-al-cierre.mjs").length).toBe(1);
  });
});

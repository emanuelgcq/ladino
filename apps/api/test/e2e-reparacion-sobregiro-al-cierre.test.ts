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
 * REPARACIÓN J-02 · `repairOverdraftClosings` POSTEA EN PRODUCCIÓN: aquí está en el gate.
 *
 * Los cierres «viejos» se fabrican como los dejó la API anterior a la migración 20261004180000:
 * la fila de `cash_closings` con lo esperado en negativo y su asiento generado con el origen de
 * siempre (`cash_closing`: D caja / H «Faltantes y sobrantes de caja»), o su fila en la cola.
 *
 * Cinco cierres viejos en una empresa, y uno más para el fallo:
 *   · FAMILIA  caja anterior a ADR-0070, asentada en 1.1.01, que hoy agrupa        −60 → 0
 *   · CERRADO  cierre de un mes que después se cerró: la corrección va a HOY        −40 → 0
 *   · HOY      el caso llano                                                       −100 → 0
 *   · USD      caja en divisa: la línea de la caja conserva sus dólares             −10 → 0
 *   · COLA     encolado por la API vieja: al importarse sería un ingreso            −50 → 20
 *   · SIN PAPEL  la empresa pierde `owner_payable`: lanza y no deja una reversa suelta
 * Y la idempotencia de verdad: la segunda corrida no escribe NADA (ni actas ni asientos).
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";
const TENANT = crypto.randomUUID();
const COMPANY = crypto.randomUUID();
const DUENO = crypto.randomUUID();
const ROL = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();
/** El día 15 del mes anterior al de hoy (Caracas): un `date`, nunca un instante. */
const MES_PASADO = ((): string => {
  const [a, m] = HOY.split("-").map(Number) as [number, number];
  const anio = m === 1 ? a - 1 : a;
  const mes = m === 1 ? 12 : m - 1;
  return `${anio}-${String(mes).padStart(2, "0")}-15`;
})();
const EVENTO = "treasury.cash_register.closed";

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let FAMILIA_BS = "";
let DEL_DUENO = "";
let SOBRANTES = "";
let TASA_USD = "";
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

async function crearCaja(clave: string, moneda: string, mayor?: string): Promise<void> {
  const r = await pedir("POST", "/v1/treasury/accounts", {
    company_id: COMPANY,
    name: `Caja ${clave} ${RUN}`,
    currency: moneda,
    kind: "cash",
    ...(mayor === undefined ? {} : { ledger_account_id: mayor }),
  });
  expect(r.status).toBe(201);
  caja[clave] = ((await r.json()) as { id: string }).id;
}

/**
 * Un cierre como lo dejó la API anterior: la fila, y su hecho con el origen de siempre
 * —asentado por el generador con la plantilla de la empresa, o esperando en la cola—.
 */
async function cierreViejo(
  clave: string,
  o: { esperado: string; contado: string; fecha: string; tasa?: string; enCola?: boolean },
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`select set_config('ladino.rules_version', 'e2e-api-anterior', true)`;
    const tasa = o.tasa ?? "1";
    const [c] = await tx<{ id: string; funcional: string; moneda: string }[]>`
      insert into public.cash_closings
        (tenant_id, company_id, account_id, closing_date, closed_at, expected_amount,
         counted_amount, reason, amount_transaction_currency, transaction_currency, fx_rate,
         functional_amount, functional_currency, rate_source, rate_timestamp, rounding_policy_id)
      select ${TENANT}, ${COMPANY}, ca.id, ${o.fecha}::date, now(), ${o.esperado}::numeric,
             ${o.contado}::numeric, 'el pago del café salió de mi bolsillo',
             ${o.contado}::numeric - ${o.esperado}::numeric, ca.currency, ${tasa}::numeric,
             round((${o.contado}::numeric - ${o.esperado}::numeric) * ${tasa}::numeric, 2),
             'VES', 'e2e', now(), 'treasury:cash_closing:8:HALF_UP'
        from public.company_accounts ca where ca.id = ${caja[clave]!}
      returning id, functional_amount::text as funcional, transaction_currency as moneda`;
    cierre[clave] = c!.id;
    if (o.enCola === true) {
      await tx`
        insert into public.journal_generation_queue
          (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
        values (${TENANT}, ${COMPANY}, 'cash_closing', ${c!.id}, ${EVENTO},
                ${tx.json({
                  functional_amount: c!.funcional,
                  functional_currency: "VES",
                  posting_date: o.fecha,
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
      postingDate: o.fecha,
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

type Linea = {
  cuenta: string;
  lado: "debe" | "haber";
  importe: string;
  moneda: string;
  original: string;
};

async function lineasDe(entryId: string): Promise<Linea[]> {
  return sql<Linea[]>`
    select l.account_id as cuenta,
           case when l.functional_debit > 0 then 'debe' else 'haber' end as lado,
           (l.functional_debit + l.functional_credit)::numeric(24,2)::text as importe,
           l.transaction_currency as moneda,
           l.amount_transaction_currency::numeric(24,2)::text as original
      from public.journal_lines l where l.entry_id = ${entryId} order by l.line_number`;
}

/** El asiento vigente del cierre: su origen, su fecha y sus líneas. */
async function vigenteDe(clave: string): Promise<{
  id: string;
  origen: string;
  fecha: string;
  posteo: string;
  lineas: Linea[];
}> {
  const [e] = await sql<{ id: string; origen: string; fecha: string; posteo: string }[]>`
    select e.id, e.source_kind as origen, e.posting_date::text as fecha,
           e.posted_by::text as posteo
      from public.cash_closings k join public.journal_entries e on e.id = k.journal_entry_id
     where k.id = ${cierre[clave]!} and e.status = 'posted'`;
  return { ...e!, lineas: await lineasDe(e!.id) };
}

async function reversaDe(clave: string): Promise<{ id: string; fecha: string; lineas: Linea[] }> {
  const [r] = await sql<{ id: string; fecha: string }[]>`
    select r.id, r.posting_date::text as fecha
      from public.journal_entries v join public.journal_entries r on r.id = v.reversed_by_entry_id
     where v.id = ${asientoViejo[clave]!} and v.status = 'reversed' and r.status = 'posted'`;
  return { ...r!, lineas: await lineasDe(r!.id) };
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

async function rastro(): Promise<{
  actas: number;
  asientos: number;
  lineas: number;
  cola: number;
}> {
  const [n] = await sql<{ actas: number; asientos: number; lineas: number; cola: number }[]>`
    select (select count(*)::int from public.audit_events where company_id = ${COMPANY}) as actas,
           (select count(*)::int from public.journal_entries where company_id = ${COMPANY})
             as asientos,
           (select count(*)::int from public.journal_lines where company_id = ${COMPANY}) as lineas,
           (select count(*)::int from public.journal_generation_queue
             where company_id = ${COMPANY}) as cola`;
  return n!;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${DUENO}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${DUENO}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e reparación J-02')`;
    await tx`insert into public.companies (id, tenant_id, tax_id, legal_name,
                                           functional_currency_code, taxpayer_type_code,
                                           activity_start_date)
             values (${COMPANY}, ${TENANT}, ${`J-RJ02-${RUN}`}, 'Bodega con cierres viejos', 'VES',
                     'ordinario', ${diaCaracas(-120)}::date)`;
    await declararTipoDeFixture(tx, COMPANY);
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope) values
             (${ROL}, null, ${`e2erj02_${RUN}`}, 'Dueño', false)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'treasury.read'), (${ROL}, 'treasury.account.manage'),
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.template.manage'),
             (${ROL}, 'accounting.entry.post'), (${ROL}, 'accounting.read'),
             (${ROL}, 'accounting.period.close')
             on conflict do nothing`;
    const mem = crypto.randomUUID();
    await tx`insert into public.memberships (id, tenant_id, user_id) values
             (${mem}, ${TENANT}, ${DUENO})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id) values
             (${crypto.randomUUID()}, ${TENANT}, ${mem}, ${ROL}, null)`;
    // La tasa del día es global y compartida: se siembra solo si falta, bajo su candado.
    await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
    await tx`
      insert into public.exchange_rates
        (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
      select 'USD', 'VES', 40.123456, ${HOY}::date, now(), 'e2e-reparacion-j02'
       where not exists (select 1 from public.exchange_rates
                          where company_id is null and from_currency = 'USD' and to_currency = 'VES'
                            and rate_date = ${HOY}::date)`;
  });
  for (const [ruta, cuerpo] of [
    ["/v1/accounts/import-template", { company_id: COMPANY, template_code: "ve_basico" }],
    ["/v1/journal-templates/import-preset", { company_id: COMPANY, preset_code: "ve_basico" }],
  ] as const) {
    expect((await pedir("POST", ruta, cuerpo)).status).toBe(201);
  }
  // Una empresa con meses de vida: sus papeles rigen desde siempre (un cierre del mes pasado).
  await sql`update public.company_account_settings set effective_from = '-infinity'
             where company_id = ${COMPANY}`;
  const papeles = await sql<{ purpose: string; account_id: string }[]>`
    select purpose, account_id from public.company_account_settings
     where company_id = ${COMPANY} and effective_to is null
       and purpose in ('owner_payable', 'cash_over_short', 'cash_bs')`;
  DEL_DUENO = papeles.find((p) => p.purpose === "owner_payable")!.account_id;
  SOBRANTES = papeles.find((p) => p.purpose === "cash_over_short")!.account_id;
  FAMILIA_BS = papeles.find((p) => p.purpose === "cash_bs")!.account_id;

  // 1. Las cajas anteriores a ADR-0070: dos, mapeadas a mano a la cuenta de familia (aún hoja).
  await crearCaja("FAMILIA", "VES", FAMILIA_BS);
  await crearCaja("CERRADO", "VES", FAMILIA_BS);
  await cierreViejo("FAMILIA", { esperado: "-60", contado: "0", fecha: HOY });
  // 2. Un cierre del mes pasado, y ese mes se cierra después.
  await cierreViejo("CERRADO", { esperado: "-40", contado: "0", fecha: MES_PASADO });
  const [periodo] = await sql<{ id: string }[]>`
    select period_id as id from public.journal_entries where id = ${asientoViejo["CERRADO"]!}`;
  const cerrar = await pedir("POST", `/v1/fiscal-periods/${periodo!.id}/close`, {
    company_id: COMPANY,
  });
  expect(cerrar.status).toBe(200);
  // 3. ADR-0070: cada caja a su subcuenta; 1.1.01 pasa a agrupar y ya no recibe asientos.
  const sub = await sql.begin((tx) => repairTreasurySubaccounts(tx, COMPANY));
  expect(sub.repaired).toBe(2);
  // 4. Las cajas de hoy, con su subcuenta desde que nacen.
  await crearCaja("HOY", "VES");
  await crearCaja("USD", "USD");
  await crearCaja("COLA", "VES");
  await crearCaja("SINPAPEL", "VES");
  const [t] = await sql<{ rate: string }[]>`
    select rate::text as rate from platform.rate_for(${COMPANY}, 'USD', 'VES', ${HOY}::date)`;
  TASA_USD = t!.rate;
  await cierreViejo("HOY", { esperado: "-100", contado: "0", fecha: HOY });
  await cierreViejo("USD", { esperado: "-10", contado: "0", fecha: HOY, tasa: TASA_USD });
  await cierreViejo("COLA", { esperado: "-50", contado: "20", fecha: HOY, enCola: true });
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await sqlApi?.end();
});

describe("J-02 · repairOverdraftClosings sobre una empresa con cierres viejos", () => {
  it("antes: el invariante acusa los cuatro asentados como sobrante y el que espera en la cola", async () => {
    expect(await huecos()).toEqual([
      "posted_as_surplus",
      "posted_as_surplus",
      "posted_as_surplus",
      "posted_as_surplus",
      "queued_as_surplus",
    ]);
    // Y la lista de cierres NO dice «lo puso el dueño» de un cierre que sigue en resultado.
    const r = await pedir("GET", "/v1/cash-closings");
    const { items } = (await r.json()) as {
      items: { id: string; owner_contribution: string | null }[];
    };
    expect(items.length).toBe(5);
    expect(items.every((i) => i.owner_contribution === null)).toBe(true);
  });

  it("repara: cuatro reclasificados, uno sacado de la cola, y el invariante en cero", async () => {
    const r = await sql.begin((tx) => repairOverdraftClosings(tx, COMPANY));
    expect(r.reclassified.map((x) => x.cash_closing_id).sort()).toEqual(
      [cierre["FAMILIA"], cierre["CERRADO"], cierre["HOY"], cierre["USD"]].sort(),
    );
    expect(r.requeued.map((x) => [x.cash_closing_id, x.accounting])).toEqual([
      [cierre["COLA"], "posted"],
    ]);
    expect(await huecos()).toEqual([]);
    // Cinco cierres, cuatro reversas y cinco asientos: con la base local compartida pasa de 5 s.
  }, 60_000);

  it("HOY · el caso llano: reversa del sistema con su acta, y el asiento nuevo contra el pasivo", async () => {
    const sub = await subcuentaDe("HOY");
    const v = await vigenteDe("HOY");
    expect(v.origen).toBe("cash_closing_overdraft");
    expect(v.posteo).toBe("00000000-0000-0000-0000-000000000000");
    expect(v.lineas).toEqual([
      { cuenta: sub, lado: "debe", importe: "100.00", moneda: "VES", original: "100.00" },
      { cuenta: DEL_DUENO, lado: "haber", importe: "100.00", moneda: "VES", original: "100.00" },
    ]);
    const rev = await reversaDe("HOY");
    expect(rev.lineas).toEqual([
      { cuenta: sub, lado: "haber", importe: "100.00", moneda: "VES", original: "100.00" },
      { cuenta: SOBRANTES, lado: "debe", importe: "100.00", moneda: "VES", original: "100.00" },
    ]);
    // La reversa canónica deja su rastro, firmado por el sistema.
    const [a] = await sql<{ actor_type: string; reversal_of: string }[]>`
      select actor_type, payload ->> 'reversal_of' as reversal_of from public.audit_events
       where aggregate_id = ${rev.id} and event_type = 'journal.reversed'`;
    expect(a).toEqual({ actor_type: "system", reversal_of: asientoViejo["HOY"] });
  });

  it("CERRADO · el mes del cierre está cerrado: reversa y asiento nuevo van a HOY", async () => {
    expect((await reversaDe("CERRADO")).fecha).toBe(HOY);
    const v = await vigenteDe("CERRADO");
    expect(v.fecha).toBe(HOY);
    expect(v.origen).toBe("cash_closing_overdraft");
  });

  it("FAMILIA · la línea vieja en 1.1.01 (que hoy agrupa) se reversa en la subcuenta de la caja", async () => {
    const viejas = await lineasDe(asientoViejo["FAMILIA"]!);
    expect(viejas.map((l) => l.cuenta)).toContain(FAMILIA_BS);
    const sub = await subcuentaDe("FAMILIA");
    expect(sub).not.toBe(FAMILIA_BS);
    const rev = await reversaDe("FAMILIA");
    expect(rev.lineas.map((l) => l.cuenta)).not.toContain(FAMILIA_BS);
    expect(rev.lineas).toContainEqual({
      cuenta: sub,
      lado: "haber",
      importe: "60.00",
      moneda: "VES",
      original: "60.00",
    });
  });

  it("USD · la caja en divisa conserva sus dólares en la reversa y en el asiento nuevo", async () => {
    const sub = await subcuentaDe("USD");
    const [f] = await sql<{ funcional: string }[]>`
      select round(10 * ${TASA_USD}::numeric, 2)::numeric(24,2)::text as funcional`;
    const v = await vigenteDe("USD");
    expect(v.lineas).toEqual([
      { cuenta: sub, lado: "debe", importe: f!.funcional, moneda: "USD", original: "10.00" },
      {
        cuenta: DEL_DUENO,
        lado: "haber",
        importe: f!.funcional,
        moneda: "VES",
        original: f!.funcional,
      },
    ]);
    const rev = await reversaDe("USD");
    expect(rev.lineas).toContainEqual({
      cuenta: sub,
      lado: "haber",
      importe: f!.funcional,
      moneda: "USD",
      original: "10.00",
    });
  });

  it("COLA · la fila vieja se descarta con acta y el hecho se asienta partido: 50 del dueño, 20 de sobrante", async () => {
    const [q] = await sql<{ status: string; id: string }[]>`
      select status, id from public.journal_generation_queue
       where company_id = ${COMPANY} and source_id = ${cierre["COLA"]!}
         and source_kind = 'cash_closing'`;
    expect(q!.status).toBe("discarded");
    const [acta] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where company_id = ${COMPANY} and event_type = 'accounting.pending_discarded'
         and payload ->> 'queue_id' = ${q!.id}`;
    expect(acta!.n).toBe(1);
    const sub = await subcuentaDe("COLA");
    const v = await vigenteDe("COLA");
    expect(v.origen).toBe("cash_closing_overdraft");
    expect(v.lineas).toEqual([
      { cuenta: sub, lado: "debe", importe: "70.00", moneda: "VES", original: "70.00" },
      { cuenta: DEL_DUENO, lado: "haber", importe: "50.00", moneda: "VES", original: "50.00" },
      { cuenta: SOBRANTES, lado: "haber", importe: "20.00", moneda: "VES", original: "20.00" },
    ]);
  });

  it("después: los invariantes que cruzan tesorería y contabilidad en cero, y la lista ya lo dice", async () => {
    const [n] = await sql<Record<string, number>[]>`
      select (select count(*)::int from platform.treasury_ledger_gaps(${COMPANY})) as tesoreria,
             (select count(*)::int from platform.treasury_currency_gaps(${COMPANY})) as divisa,
             (select count(*)::int from platform.accounting_coverage_gaps(${COMPANY})) as cobertura,
             (select count(*)::int from platform.cent_gaps(${COMPANY})) as centimo`;
    expect(n).toEqual({ tesoreria: 0, divisa: 0, cobertura: 0, centimo: 0 });
    const [b] = await sql<{ debe: string; haber: string }[]>`
      select coalesce(sum(period_debit), 0)::text as debe,
             coalesce(sum(period_credit), 0)::text as haber
        from platform.trial_balance(${COMPANY}, ${HOY}::date)`;
    expect(b!.debe).toBe(b!.haber);
    const r = await pedir("GET", "/v1/cash-closings");
    const { items } = (await r.json()) as {
      items: { id: string; owner_contribution: string | null }[];
    };
    const de = (clave: string) => items.find((i) => i.id === cierre[clave])?.owner_contribution;
    expect([de("HOY"), de("USD"), de("COLA")]).toEqual(["100.00", "10.00", "50.00"]);
  });

  it("es idempotente: la segunda corrida no encuentra nada y no escribe NADA", async () => {
    const antes = await rastro();
    const r = await sql.begin((tx) => repairOverdraftClosings(tx, COMPANY));
    expect(r.reclassified).toEqual([]);
    expect(r.requeued).toEqual([]);
    expect(await rastro()).toEqual(antes);
  }, 60_000);

  it("SIN PAPEL · sin la cuenta de owner_payable lanza, y no deja una reversa suelta", async () => {
    await cierreViejo("SINPAPEL", { esperado: "-30", contado: "0", fecha: HOY });
    await sql`update public.company_account_settings set effective_to = now()
               where company_id = ${COMPANY} and purpose = 'owner_payable'
                 and effective_to is null`;
    const antes = await rastro();
    await expect(sql.begin((tx) => repairOverdraftClosings(tx, COMPANY))).rejects.toThrow(
      /owner_payable/,
    );
    // La transacción entera se deshizo: ni reversa, ni acta, ni fila de cola; el viejo sigue vivo.
    expect(await rastro()).toEqual(antes);
    const [v] = await sql<{ status: string }[]>`
      select status from public.journal_entries where id = ${asientoViejo["SINPAPEL"]!}`;
    expect(v!.status).toBe("posted");
    expect(await huecos()).toEqual(["posted_as_surplus"]);
  }, 60_000);

  it("SIN PAPEL · asignado el papel, la misma reparación termina el trabajo", async () => {
    // Lo que hace el contador en Contabilidad: volver a asignar la cuenta al papel.
    await sql`
      insert into public.company_account_settings
        (tenant_id, company_id, purpose, account_id, effective_from)
      values (${TENANT}, ${COMPANY}, 'owner_payable', ${DEL_DUENO}, now())`;
    const r = await sql.begin((tx) => repairOverdraftClosings(tx, COMPANY));
    expect(r.reclassified.map((x) => x.cash_closing_id)).toEqual([cierre["SINPAPEL"]]);
    expect(await huecos()).toEqual([]);
  }, 60_000);
});

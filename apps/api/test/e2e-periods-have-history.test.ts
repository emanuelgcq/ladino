import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { createClient } from "@ladino/db";
import { buildApp } from "../src/app.js";
import { repairCents } from "@ladino/domain";
import { diaCaracas } from "./_dia-caracas.js";

/**
 * LOS PERÍODOS TIENEN HISTORIA (ADR-0069; recorrido 2026-09-24, K-01, K-02, K-03, K-05, K-06).
 *
 * Por la API real, como `ladino_api`:
 *   1. K-01 + K-02: cerrar → reabrir (con motivo) → cerrar → reabrir el MISMO período; cada
 *      paso deja su evento en `fiscal_period_events`. Antes, reabrir daba 422 SIEMPRE;
 *   2. K-05: un borrador NO se crea en un período cerrado (409 con la salida), y una fecha
 *      antes del inicio de actividades da un 422 legible;
 *   3. K-06: un borrador se descarta (con rastro en auditoría); un posteado, nunca;
 *   4. K-03: el cierre del ejercicio con diciembre CERRADO entra en el «13», pasa por
 *      «Resultado del ejercicio» y deja el 13 cerrado.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";
const JWT_SECRET = new TextEncoder().encode(
  "super-secret-jwt-token-with-at-least-32-characters-long",
);
const ISSUER = "http://127.0.0.1:54321/auth/v1";

const TENANT = crypto.randomUUID();
const COMPANY = crypto.randomUUID();
const CONTADOR = crypto.randomUUID();
const ROL = crypto.randomUUID();
const MEM = crypto.randomUUID();
const ASIG = crypto.randomUUID();
const RUN = Date.now().toString(36);
const HOY = diaCaracas();

let sql: ReturnType<typeof createClient>;
let sqlApi: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
const cuenta: Record<string, string> = {};

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

async function asiento(fecha: string, importe: string, debe: string, haber: string) {
  return pedir("POST", "/v1/journal-entries", {
    company_id: COMPANY,
    posting_date: fecha,
    description: `Asiento e2e ${fecha}`,
    lines: [
      { account_id: cuenta[debe], debit: importe },
      { account_id: cuenta[haber], credit: importe },
    ],
  });
}

/** El período de una fecha, creado como lo haría cualquier asiento. */
async function periodoDe(fecha: string): Promise<string> {
  const [p] = await sql<
    { id: string }[]
  >`select platform.period_for_date(${COMPANY}, ${fecha}::date) as id`;
  return p!.id;
}

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  app = buildApp({ sql: sqlApi, auth: { mode: "hs256", jwtSecret: JWT_SECRET, issuer: ISSUER } });
  await sql`insert into auth.users (id) values (${CONTADOR}) on conflict (id) do nothing`;
  await sql.begin(async (tx) => {
    await tx`select set_config('ladino.actor_id', ${CONTADOR}, true)`;
    await tx`insert into public.tenants (id, name) values (${TENANT}, 'Tenant e2e períodos')`;
    // Inicio de actividades explícito en 2025: el cierre del ejercicio 2025 necesita pasado.
    await tx`insert into public.companies
               (id, tenant_id, tax_id, legal_name, functional_currency_code, activity_start_date)
             values (${COMPANY}, ${TENANT}, ${`J-PER-${RUN}`}, 'Empresa e2e períodos', 'VES',
                     '2025-01-01')`;
    await tx`insert into public.roles (id, tenant_id, key, name, requires_scope)
             values (${ROL}, null, ${`e2eper_${RUN}`}, 'Contador e2e períodos', false)`;
    await tx`insert into public.role_permissions (role_id, permission_key) values
             (${ROL}, 'accounting.account.manage'), (${ROL}, 'accounting.entry.create'),
             (${ROL}, 'accounting.entry.post'), (${ROL}, 'accounting.entry.reverse'),
             (${ROL}, 'accounting.read'), (${ROL}, 'accounting.period.close'),
             (${ROL}, 'accounting.period.reopen'), (${ROL}, 'company.settings.manage')
             on conflict do nothing`;
    await tx`insert into public.memberships (id, tenant_id, user_id)
             values (${MEM}, ${TENANT}, ${CONTADOR})`;
    await tx`insert into public.user_role_assignments
               (id, tenant_id, membership_id, role_id, company_id)
             values (${ASIG}, ${TENANT}, ${MEM}, ${ROL}, ${COMPANY})`;
  });
  const imp = await pedir("POST", "/v1/accounts/import-template", {
    company_id: COMPANY,
    template_code: "ve_basico",
  });
  expect(imp.status).toBeLessThan(300);
  const filas = await sql<{ code: string; id: string }[]>`
    select code, id from public.accounts where company_id = ${COMPANY}
       and code in ('1.1.01', '4.1.01', '5.1.01', '3.1.01', '3.1.02')`;
  for (const f of filas) cuenta[f.code] = f.id;
});

afterAll(async () => {
  await sqlApi.end();
  await sql.end();
});

describe("K-01 + K-02 · el ciclo cerrar → reabrir → cerrar → reabrir", () => {
  it("funciona n veces sobre el mismo período, y la historia guarda cada paso", async () => {
    const periodo = await periodoDe("2025-05-15");
    const cerrar = () =>
      pedir("POST", `/v1/fiscal-periods/${periodo}/close`, { company_id: COMPANY });
    const reabrir = (reason: string) =>
      pedir("POST", `/v1/fiscal-periods/${periodo}/reopen`, { company_id: COMPANY, reason });

    expect((await cerrar()).status).toBe(200);
    const r1 = await reabrir("Llegó una factura de mayo que faltaba");
    expect(r1.status).toBe(200); // antes: 422 «Revisa los campos marcados», SIEMPRE
    expect(((await r1.json()) as { status: string }).status).toBe("reopened");
    expect((await cerrar()).status).toBe(200); // K-02: antes violaba fiscal_periods_reopened_chk
    expect((await reabrir("Segunda reapertura: ajuste del contador")).status).toBe(200);

    const eventos = await sql<{ event_type: string; reason: string | null; actor_id: string }[]>`
      select event_type, reason, actor_id from public.fiscal_period_events
       where period_id = ${periodo} order by occurred_at, id`;
    expect(eventos.map((e) => e.event_type)).toEqual(["closed", "reopened", "closed", "reopened"]);
    expect(eventos.filter((e) => e.reason !== null).map((e) => e.reason)).toEqual([
      "Llegó una factura de mayo que faltaba",
      "Segunda reapertura: ajuste del contador",
    ]);
    expect(eventos.every((e) => e.actor_id === CONTADOR)).toBe(true);
  });

  it("la reapertura sin motivo suficiente se rechaza en el borde", async () => {
    const periodo = await periodoDe("2025-06-15");
    await pedir("POST", `/v1/fiscal-periods/${periodo}/close`, { company_id: COMPANY });
    const r = await pedir("POST", `/v1/fiscal-periods/${periodo}/reopen`, {
      company_id: COMPANY,
      reason: "corto",
    });
    expect(r.status).toBe(422);
  });
});

describe("K-05 · fechas", () => {
  it("un borrador NO se crea en un período cerrado: 409 con la salida", async () => {
    const periodo = await periodoDe("2025-07-15");
    expect(
      (await pedir("POST", `/v1/fiscal-periods/${periodo}/close`, { company_id: COMPANY })).status,
    ).toBe(200);
    const r = await asiento("2025-07-20", "100", "1.1.01", "4.1.01");
    expect(r.status).toBe(409);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("PERIOD_CLOSED");
    // Asevera lo que SOLO produce la comprobación al crear (no la de postear, LAD61 también).
    expect(cuerpo.message).toContain("tampoco en borrador");
    expect(cuerpo.message).toContain("Reábrelo con motivo");
  });

  it("una fecha antes del inicio de actividades da un 422 legible, y no crea período", async () => {
    const r = await asiento("2024-12-31", "100", "1.1.01", "4.1.01");
    expect(r.status).toBe(422);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe("PERIOD_OUT_OF_RANGE");
    expect(cuerpo.message).toContain("inicio de actividades");
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.fiscal_periods
       where company_id = ${COMPANY} and year = 2024`;
    expect(n!.n).toBe(0);
  });
});

describe("K-06 · descartar un borrador", () => {
  it("el borrador pasa a descartado con rastro; un posteado no se descarta", async () => {
    const creado = await asiento(HOY, "50", "1.1.01", "4.1.01");
    expect(creado.status).toBe(201);
    const { id } = (await creado.json()) as { id: string };
    const d = await pedir("POST", `/v1/journal-entries/${id}/discard`, {
      company_id: COMPANY,
      reason: "Duplicado del de ayer",
    });
    expect(d.status).toBe(200);
    expect(((await d.json()) as { status: string }).status).toBe("discarded");
    const [a] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where aggregate_id = ${id} and event_type = 'journal.discarded'
         and payload ->> 'reason' = 'Duplicado del de ayer'`;
    expect(a!.n).toBe(1);

    const otro = await asiento(HOY, "60", "1.1.01", "4.1.01");
    const { id: otroId } = (await otro.json()) as { id: string };
    expect(
      (await pedir("POST", `/v1/journal-entries/${otroId}/post`, { company_id: COMPANY })).status,
    ).toBe(200);
    const nunca = await pedir("POST", `/v1/journal-entries/${otroId}/discard`, {
      company_id: COMPANY,
      reason: "Intento indebido",
    });
    expect(nunca.status).toBe(422);
    expect(((await nunca.json()) as { message: string }).message).toContain("reversándolo");
  });
});

describe("K-03 · el cierre del ejercicio con diciembre cerrado", () => {
  it("entra en el «13», pasa por Resultado del ejercicio y deja el 13 cerrado", async () => {
    // Ingresos 1000, gastos 300 en 2025: utilidad 700.
    for (const [fecha, imp, debe, haber] of [
      ["2025-03-10", "1000", "1.1.01", "4.1.01"],
      ["2025-03-11", "300", "5.1.01", "1.1.01"],
    ] as const) {
      const r = await asiento(fecha, imp, debe, haber);
      expect(r.status).toBe(201);
      const { id } = (await r.json()) as { id: string };
      expect(
        (await pedir("POST", `/v1/journal-entries/${id}/post`, { company_id: COMPANY })).status,
      ).toBe(200);
    }
    const diciembre = await periodoDe("2025-12-15");
    expect(
      (await pedir("POST", `/v1/fiscal-periods/${diciembre}/close`, { company_id: COMPANY }))
        .status,
    ).toBe(200);

    const r = await pedir("POST", "/v1/fiscal-periods/year-end-close", {
      company_id: COMPANY,
      year: 2025,
    });
    expect(r.status).toBe(201); // antes: LAD61, diciembre cerrado
    const cierre = (await r.json()) as { id: string; period_id: string; posting_date: string };
    expect(cierre.posting_date).toBe("2025-12-31");
    const [p13] = await sql<{ month: number; kind: string; status: string }[]>`
      select month, kind, status from public.fiscal_periods where id = ${cierre.period_id}`;
    expect(p13).toEqual({ month: 13, kind: "closing", status: "closed" });

    const lineas = await sql<{ code: string; d: string; c: string }[]>`
      select a.code, jl.functional_debit::text as d, jl.functional_credit::text as c
        from public.journal_lines jl join public.accounts a on a.id = jl.account_id
       where jl.entry_id = ${cierre.id} order by jl.line_number`;
    const de = (code: string) => lineas.filter((l) => l.code === code);
    // El resultado PASA por 3.1.01 (entra y sale 700) y termina en 3.1.02.
    expect(de("3.1.01").map((l) => [l.d, l.c])).toEqual([
      ["0.00000000", "700.00000000"],
      ["700.00000000", "0.00000000"],
    ]);
    expect(de("3.1.02").map((l) => [l.d, l.c])).toEqual([["0.00000000", "700.00000000"]]);
  });
});

describe("K-03 · reabrir el ejercicio y volver a cerrarlo", () => {
  it("reabrir el 13 revierte el cierre; con un ajuste en el 13, se cierra otra vez y refleja el ajuste", async () => {
    const [p13] = await sql<{ id: string }[]>`
      select id from public.fiscal_periods where company_id = ${COMPANY} and year = 2025 and month = 13`;
    const reabrir = await pedir("POST", `/v1/fiscal-periods/${p13!.id}/reopen`, {
      company_id: COMPANY,
      reason: "Ajuste del contador después del cierre",
    });
    expect(reabrir.status).toBe(200);
    const [revertido] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.journal_entries
       where company_id = ${COMPANY} and source_kind = 'year_end_close' and status = 'reversed'`;
    expect(revertido!.n).toBe(1);
    // El contra-asiento vive en el 13 y está fechado el 31-12, que es lo que añade `alCierre`, y la
    // reversa deja su acta con el motivo de la reapertura (revisor de la ola 1).
    const [contra] = await sql<{ periodo: number; fecha: string }[]>`
      select p.month as periodo, to_char(r.posting_date, 'YYYY-MM-DD') as fecha
        from public.journal_entries c
        join public.journal_entries r on r.id = c.reversed_by_entry_id
        join public.fiscal_periods p on p.id = r.period_id
       where c.company_id = ${COMPANY} and c.source_kind = 'year_end_close' and c.status = 'reversed'`;
    expect(contra).toEqual({ periodo: 13, fecha: "2025-12-31" });
    const [acta] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where company_id = ${COMPANY} and event_type = 'journal.reversed'
         and payload::text like '%Reapertura del ejercicio 2025%'`;
    expect(acta!.n).toBe(1);

    // El ajuste del contador, en el 13 (gasto de 100 más).
    const ajuste = await pedir("POST", "/v1/journal-entries", {
      company_id: COMPANY,
      posting_date: "2025-12-31",
      closing_period: true,
      description: "Ajuste de cierre: gasto no registrado",
      lines: [
        { account_id: cuenta["5.1.01"], debit: "100" },
        { account_id: cuenta["1.1.01"], credit: "100" },
      ],
    });
    expect(ajuste.status).toBe(201);
    const { id: ajusteId } = (await ajuste.json()) as { id: string };
    expect(
      (await pedir("POST", `/v1/journal-entries/${ajusteId}/post`, { company_id: COMPANY })).status,
    ).toBe(200);

    const r = await pedir("POST", "/v1/fiscal-periods/year-end-close", {
      company_id: COMPANY,
      year: 2025,
    });
    expect(r.status).toBe(201); // antes: 23505 por journal_entries_source_event_key
    const cierre = (await r.json()) as { id: string };
    const lineas = await sql<{ code: string; d: string; c: string }[]>`
      select a.code, jl.functional_debit::text as d, jl.functional_credit::text as c
        from public.journal_lines jl join public.accounts a on a.id = jl.account_id
       where jl.entry_id = ${cierre.id} order by jl.line_number`;
    // 1000 de ingresos − 400 de gastos (300 + el ajuste de 100) = 600.
    expect(lineas.filter((l) => l.code === "3.1.02").map((l) => [l.d, l.c])).toEqual([
      ["0.00000000", "600.00000000"],
    ]);
  });
});

describe("K-05 · el inicio de actividades se corrige desde Mi empresa", () => {
  it("no puede ser posterior al primer asiento; antes sí, y queda en el acta", async () => {
    const tarde = await pedir("PATCH", "/v1/companies/profile", {
      activity_start_date: "2025-06-01",
    });
    expect(tarde.status).toBe(422);
    expect(((await tarde.json()) as { message: string }).message).toContain("primer asiento");

    const bien = await pedir("PATCH", "/v1/companies/profile", {
      activity_start_date: "2024-11-01",
    });
    expect(bien.status).toBe(200);
    const [c] = await sql<{ d: string }[]>`
      select activity_start_date::text as d from public.companies where id = ${COMPANY}`;
    expect(c!.d).toBe("2024-11-01");
    const [acta] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where aggregate_id = ${COMPANY} and event_type = 'company.profile_updated'
         and payload -> 'cambios' -> 'activity_start_date' ->> 'to' = '2024-11-01'`;
    expect(acta!.n).toBe(1);
  });
});

describe("S1 · el cierre del ejercicio se arma al céntimo (ADR-0075 §7)", () => {
  it("fracción heredada en 2024, regularización HOY, cierre de 2024: cierra, cuadra y cent_gaps = 0", async () => {
    // EL CASO CRUZADO. El saldo que cierra el ejercicio está acotado al año; la regularización
    // corrige el saldo de toda la vida con un asiento fechado hoy. La fracción vieja (2024) y la
    // regularización (hoy) caen en ejercicios distintos: el saldo de 2024 de «Ventas» SIGUE
    // trayendo fracción. Antes el cierre copiaba ese saldo a 8 decimales y moría en LAD71 con el
    // mensaje del asiento manual, sin salida por la API.
    const heredado = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('ladino.actor_id', ${CONTADOR}, true)`;
      await tx`select set_config('ladino.rules_version', 'e2e-cierre-heredado', true)`;
      await tx`set constraints all immediate`;
      // El ALTER TABLE de abajo pide un candado sobre la tabla: si otra sesión la tiene ocupada,
      // falla en 4 s en vez de quedarse en la cola bloqueando a todo el que venga detrás.
      await tx`set local lock_timeout = '4s'`;
      await tx`
        insert into public.journal_entries
          (id, tenant_id, company_id, period_id, posting_date, source_kind, description,
           rules_version)
        values (${heredado}, ${TENANT}, ${COMPANY},
                platform.period_for_date(${COMPANY}, '2024-11-15'::date), '2024-11-15', 'manual',
                'Venta de 2024, anterior al céntimo (e2e)', 'e2e-cierre-heredado')`;
      let n = 0;
      for (const [codigo, debe, haber] of [
        ["1.1.01", "10.126", "0"],
        ["4.1.01", "0", "10.126"],
      ] as const) {
        n += 1;
        await tx`
          insert into public.journal_lines
            (tenant_id, company_id, entry_id, line_number, account_id, debit_amount,
             credit_amount, amount_transaction_currency, transaction_currency, fx_rate,
             functional_amount, functional_currency, rate_source, rate_timestamp,
             functional_debit, functional_credit)
          values (${TENANT}, ${COMPANY}, ${heredado}, ${n}, ${cuenta[codigo]!}, ${debe}::numeric,
                  ${haber}::numeric, 10.126, 'VES', 1, 10.126, 'VES', 'identidad', now(),
                  ${debe}::numeric, ${haber}::numeric)`;
      }
      // El guarda que hoy lo impide (LAD71) se apaga SOLO dentro de esta transacción.
      await tx`alter table public.journal_entries disable trigger journal_entries_02_balanced`;
      await tx`
        update public.journal_entries
           set status = 'posted', posted_at = now(), posted_by = ${CONTADOR},
               entry_number = platform.claim_entry_number(${COMPANY}, 2024)
         where id = ${heredado}`;
      await tx`alter table public.journal_entries enable trigger journal_entries_02_balanced`;
    });
    const regularizada = await sql.begin((tx) => repairCents(tx, COMPANY));
    expect(regularizada.regularized).toBe(true);
    // Lo que hace el caso: el saldo de Ventas ACOTADO A 2024 sigue con fracción.
    const [del2024] = await sql<{ s: string }[]>`
      select sum(jl.functional_credit - jl.functional_debit)::text as s
        from public.journal_lines jl join public.journal_entries e on e.id = jl.entry_id
       where jl.company_id = ${COMPANY} and jl.account_id = ${cuenta["4.1.01"]!}
         and e.status in ('posted', 'reversed')
         and e.posting_date between '2024-01-01' and '2024-12-31'`;
    expect(del2024!.s).toBe("10.12600000");

    const diciembre = await periodoDe("2024-12-15");
    const cerrado = await pedir("POST", `/v1/fiscal-periods/${diciembre}/close`, {
      company_id: COMPANY,
    });
    expect(cerrado.status, await cerrado.clone().text()).toBe(200);
    const r = await pedir("POST", "/v1/fiscal-periods/year-end-close", {
      company_id: COMPANY,
      year: 2024,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const cierre = (await r.json()) as { id: string };
    const lineas = await sql<{ code: string; d: string; c: string }[]>`
      select a.code, jl.functional_debit::text as d, jl.functional_credit::text as c
        from public.journal_lines jl join public.accounts a on a.id = jl.account_id
       where jl.entry_id = ${cierre.id} order by jl.line_number`;
    // Ventas se cierra por su saldo del año AL CÉNTIMO (10,126 → 10,13) y el resultado pasa por
    // 3.1.01 a 3.1.02 por ese mismo importe: cuadra por construcción.
    expect(lineas).toEqual([
      { code: "4.1.01", d: "10.13000000", c: "0.00000000" },
      { code: "3.1.01", d: "0.00000000", c: "10.13000000" },
      { code: "3.1.01", d: "10.13000000", c: "0.00000000" },
      { code: "3.1.02", d: "0.00000000", c: "10.13000000" },
    ]);
    const [inv] = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.cent_gaps(${COMPANY})`;
    expect(inv!.n).toBe(0);
  });
});

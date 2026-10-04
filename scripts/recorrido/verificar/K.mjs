/**
 * Bloque K · Contabilidad: períodos (ADR-0069). Comprobaciones de `pnpm recorrido K`.
 *
 * K-06: el borrador zombi del 21/08 de E2, en agosto cerrado, se descarta → 200.
 * K-01: el contador reabre agosto de E2 con motivo → 200, y lo vuelve a cerrar → 200 (K-02).
 * K-05: un asiento fechado antes del inicio de actividades de E2 → 4xx con mensaje legible.
 *
 * El orden importa: agosto no se puede volver a cerrar con el zombi dentro. Y es re-ejecutable:
 * si el zombi ya se descartó en una pasada anterior, lo comprueba; si agosto quedó abierto,
 * lo cierra antes de probar la reapertura.
 */
import { comprobaciones, pedir, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";

const c = comprobaciones("K");
const E2 = EMPRESAS.E2;

async function agosto() {
  const [p] = await sql`
    select id, status from public.fiscal_periods
     where company_id = ${E2} and year = 2026 and month = 8`;
  afirmar(p, "E2 no tiene el período 2026-08 del escenario");
  return p;
}

c.caso("K-06", "contador descarta el borrador zombi del 21/08 de E2 → 200", async () => {
  const [zombi] = await sql`
    select id, status from public.journal_entries
     where company_id = ${E2} and posting_date = '2026-08-21'
       and status in ('draft', 'discarded')
     order by (status = 'draft') desc, created_at limit 1`;
  afirmar(zombi, "no está el borrador del 21/08 de E2");
  if (zombi.status === "discarded") return; // ya descartado en una pasada anterior
  const r = await pedir(
    PERSONAS.contador,
    "E2",
    "POST",
    `/v1/journal-entries/${zombi.id}/discard`,
    {
      company_id: E2,
      reason: "Verificación K-06 del recorrido: borrador zombi de agosto",
    },
  );
  afirmar(r.status === 200, `esperaba 200, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
  afirmar(r.json?.status === "discarded", `quedó en ${r.json?.status}`);
});

c.caso(
  "K-01",
  "contador reabre agosto de E2 con motivo → 200, y lo vuelve a cerrar → 200",
  async () => {
    let p = await agosto();
    if (p.status !== "closed") {
      const pre = await pedir(PERSONAS.contador, "E2", "POST", `/v1/fiscal-periods/${p.id}/close`, {
        company_id: E2,
      });
      afirmar(
        pre.status === 200,
        `no se pudo dejar agosto cerrado: ${pre.status} ${pre.texto.slice(0, 200)}`,
      );
      p = await agosto();
    }
    const antes = await sql`
    select count(*)::int as n from public.fiscal_period_events where period_id = ${p.id}`;
    const r = await pedir(PERSONAS.contador, "E2", "POST", `/v1/fiscal-periods/${p.id}/reopen`, {
      company_id: E2,
      reason: "Llegó la factura de agosto que faltaba (verificación K-01)",
    });
    afirmar(r.status === 200, `reabrir: esperaba 200, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
    const r2 = await pedir(PERSONAS.contador, "E2", "POST", `/v1/fiscal-periods/${p.id}/close`, {
      company_id: E2,
    });
    afirmar(
      r2.status === 200,
      `volver a cerrar: esperaba 200, llegó ${r2.status}: ${r2.texto.slice(0, 200)}`,
    );
    // Lo que solo produce el arreglo: dos eventos nuevos en la historia, reabierto y cerrado.
    const despues = await sql`
    select event_type from public.fiscal_period_events where period_id = ${p.id}
     order by occurred_at desc, id desc limit 2`;
    const [n] = await sql`
    select count(*)::int as n from public.fiscal_period_events where period_id = ${p.id}`;
    afirmar(n.n === antes[0].n + 2, `esperaba ${antes[0].n + 2} eventos, hay ${n.n}`);
    afirmar(
      despues.map((e) => e.event_type).join(",") === "closed,reopened",
      `la historia no dice reabierto → cerrado: ${despues.map((e) => e.event_type)}`,
    );
  },
);

c.caso(
  "K-05",
  "un asiento de E2 fechado antes de su inicio de actividades → 4xx legible",
  async () => {
    const [emp] = await sql`
    select activity_start_date::text as inicio from public.companies where id = ${E2}`;
    afirmar(emp?.inicio, "E2 no tiene inicio de actividades");
    const cuentas = await sql`
    select id from public.accounts where company_id = ${E2} and is_leaf and is_active
     order by code limit 2`;
    afirmar(cuentas.length === 2, "E2 no tiene dos cuentas de detalle");
    const [antes] = await sql`select (${emp.inicio}::date - 1)::text as d`;
    const r = await pedir(PERSONAS.contador, "E2", "POST", "/v1/journal-entries", {
      company_id: E2,
      posting_date: antes.d,
      description: "Verificación K-05: antes del inicio de actividades",
      lines: [
        { account_id: cuentas[0].id, debit: "1" },
        { account_id: cuentas[1].id, credit: "1" },
      ],
    });
    afirmar(r.status >= 400 && r.status < 500, `esperaba 4xx, llegó ${r.status}`);
    afirmar(r.json?.code === "PERIOD_OUT_OF_RANGE", `código ${r.json?.code}`);
    afirmar(
      String(r.json?.message ?? "").includes("inicio de actividades"),
      `mensaje no legible: ${r.json?.message}`,
    );
  },
);

// ── ADR-0077 §3 (K-09): la rama «te invitaron» ───────────────────────────────────────────────────
// Escribe UNA invitación pendiente en E2 (no se acepta: el escenario no cambia de miembros).
c.caso(
  "K-09",
  "el dueño de E2 invita y quien abre el enlace ve «Te invitaron a <empresa>» con su oficio",
  async () => {
    const inv = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/invitations", {
      company_id: EMPRESAS.E2,
      role_key: "accountant",
    });
    afirmar(inv.status === 201, `POST /v1/invitations dio ${inv.status}`);
    afirmar(/^[0-9a-f]{64}$/.test(inv.json?.token ?? ""), "el token no tiene forma");
    const v = await pedir(PERSONAS.contador, null, "POST", "/v1/invitations/preview", {
      token: inv.json.token,
    });
    afirmar(v.status === 200, `preview dio ${v.status}`);
    afirmar(
      v.json.status === "pending" && v.json.role_key === "accountant",
      JSON.stringify(v.json),
    );
    const [e] = await sql`select coalesce(trade_name, legal_name) as n from public.companies
                           where id = ${EMPRESAS.E2}`;
    afirmar(v.json.company_name === e.n, `empresa: ${v.json.company_name}`);
  },
);

// K-08 (ola 3, ADR-0075 §7): los estados financieros de E2 llegan al céntimo y la regularización
// dejó su acta y su cuenta.
c.caso("K-08", "estado de resultados y balance de E2: todo importe con dos decimales", async () => {
  const [d] = await sql`select (now() at time zone 'America/Caracas')::date::text as hoy`;
  const er = await pedir(
    PERSONAS.duenoE2E3,
    "E2",
    "GET",
    `/v1/accounting/reports/income-statement?from=2026-01-01&to=${d.hoy}`,
  );
  const bs = await pedir(
    PERSONAS.duenoE2E3,
    "E2",
    "GET",
    `/v1/accounting/reports/balance-sheet?date=${d.hoy}`,
  );
  afirmar(er.status === 200 && bs.status === 200, `estados: ${er.status} / ${bs.status}`);
  const malos = [];
  const mirar = (o, ruta) => {
    if (typeof o === "string" && /^-?\d+\.\d+$/.test(o) && !/^-?\d+\.\d{2}$/.test(o)) {
      malos.push(`${ruta}=${o}`);
    } else if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) mirar(v, `${ruta}.${k}`);
    }
  };
  mirar(er.json, "er");
  mirar(bs.json, "bs");
  afirmar(malos.length === 0, malos.slice(0, 5).join(", "));
});
c.caso("K-08", "E2 tiene el acta de la regularización del céntimo y la cuenta 5.1.10", async () => {
  const [f] = await sql`
    select (select count(*)::int from public.audit_events
             where company_id = ${EMPRESAS.E2}
               and event_type = 'accounting.cent_regularized') as actas,
           (select count(*)::int from public.company_account_settings s
              join public.accounts a on a.id = s.account_id
             where s.company_id = ${EMPRESAS.E2} and s.purpose = 'rounding_difference'
               and a.code = '5.1.10') as cuenta`;
  afirmar(f.actas >= 1, `actas: ${f.actas}`);
  afirmar(f.cuenta === 1, `cuenta 5.1.10: ${f.cuenta}`);
});

// Revisión de la ola 3 (migraciones 20261003190000 y 190100): el céntimo no tiene excepciones.
c.caso(
  "K-08",
  "un asiento manual con más de dos decimales → 422 «llevan como máximo dos decimales»",
  async () => {
    const [d] = await sql`select (now() at time zone 'America/Caracas')::date::text as hoy`;
    const cuentas = await sql`
      select code, id from public.accounts
       where company_id = ${E2} and code in ('1.1.03', '4.1.01')`;
    afirmar(cuentas.length === 2, "E2 no tiene las cuentas 1.1.03 y 4.1.01 del plan");
    const de = (codigo) => cuentas.find((x) => x.code === codigo).id;
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/journal-entries", {
      company_id: E2,
      posting_date: d.hoy,
      description: "Recorrido K-08: un asiento a 8 decimales",
      lines: [
        { account_id: de("1.1.03"), debit: "10.12345678" },
        { account_id: de("4.1.01"), credit: "10.12345678" },
      ],
    });
    afirmar(r.status === 422, `esperaba 422, llegó ${r.status}`);
    afirmar(
      JSON.stringify(r.json).includes("como máximo dos decimales"),
      `el mensaje no dice la regla: ${JSON.stringify(r.json).slice(0, 200)}`,
    );
  },
);
c.caso(
  "K-08",
  "libro de compras por alícuota: en cada renglón las alícuotas suman la base y el IVA, con su signo",
  async () => {
    const [f] = await sql`
      select count(*)::int as renglones,
             count(*) filter (where b.base_alicuota_general + b.base_alicuota_adicional
                                    + b.base_alicuota_reducida + b.base_gravada_sin_alicuota
                                    <> b.base_gravada
                                 or b.iva_alicuota_general + b.iva_alicuota_adicional
                                    + b.iva_alicuota_reducida + b.iva_sin_clasificar
                                    <> b.iva_credito + b.iva_al_costo)::int as malos
        from unnest(${Object.values(EMPRESAS)}::uuid[]) as e(id),
             lateral platform.purchases_book_by_rate(e.id, '2026-01-01', '2026-12-31') b`;
    afirmar(f.malos === 0, `${f.malos} de ${f.renglones} renglón(es) no cuadran por alícuota`);
  },
);
c.caso(
  "K-08",
  "el crédito fiscal de la declaración es el del libro de compras, mes a mes; y al céntimo después del corte",
  async () => {
    const filas = await sql`
      select e.id, m.desde::text as desde,
             (select d.creditos from platform.recompute_iva_period(
                e.id, m.desde, (m.desde + interval '1 month - 1 day')::date, 0, 0) d) as declarado,
             coalesce((select sum(b.iva_credito)
                         from platform.purchases_book(
                           e.id, m.desde, (m.desde + interval '1 month - 1 day')::date) b
                        where b.status <> 'ajuste_periodo_anterior'), 0) as libro,
             -- 20261003190400: lo registrado ANTES del corte del céntimo se reproduce a 8
             -- decimales; el mes del corte es mixto. Dos decimales se exigen en los meses
             -- ENTEROS posteriores al corte (o en todos, si la empresa nunca regularizó).
             coalesce(m.desde > platform.caracas_day(platform.cent_cutover_at(e.id)), true)
               as posterior
        from unnest(${Object.values(EMPRESAS)}::uuid[]) as e(id),
             lateral (select make_date(2026, n, 1) as desde from generate_series(1, 12) n) m`;
    const malas = filas.filter(
      (x) =>
        Number(x.declarado) !== Number(x.libro) ||
        (x.posterior && !/^-?\d+(\.\d{2}0*)?$/.test(String(x.declarado))),
    );
    afirmar(
      malas.length === 0,
      malas
        .slice(0, 3)
        .map((x) => `${x.id} ${x.desde}: declarado ${x.declarado}, libro ${x.libro}`)
        .join(" · "),
    );
  },
);
c.caso(
  "AF3-13",
  "una empresa sin RIF (PEND-) no tiene renglones en el libro de compras",
  async () => {
    const [f] = await sql`
    select count(*)::int as empresas,
           coalesce(sum((select count(*) from platform.purchases_book(
                           c.id, '2026-01-01', '2026-12-31'))), 0)::int as renglones
      from public.companies c
     where upper(btrim(c.tax_id)) like 'PEND-%'
       and exists (select 1 from public.supplier_invoices i
                    where i.company_id = c.id and i.fiscal_support)`;
    afirmar(f.renglones === 0, `${f.renglones} renglón(es) en ${f.empresas} empresa(s) sin RIF`);
  },
);

export default c.correr;

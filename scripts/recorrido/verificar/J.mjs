/**
 * Bloque J · Mi dinero. Comprobaciones de `pnpm recorrido J` (ver `_app.mjs`).
 *
 * J-01 (ADR-0070): «Mover plata» entre dos cuentas en bolívares de la misma empresa daba 500
 * («ON CONFLICT DO UPDATE command cannot affect row a second time»). Ya no debe reproducir.
 * J-04 (base): el invariante tesorería ↔ mayor da cero en las tres empresas.
 */
import { comprobaciones, pedir, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";

const c = comprobaciones("J");

async function cuentaDe(empresa, nombre) {
  const [fila] = await sql`
    select id from public.company_accounts
     where company_id = ${EMPRESAS[empresa]} and name = ${nombre}`;
  afirmar(fila, `no existe la cuenta «${nombre}» en ${empresa}`);
  return fila.id;
}

c.caso(
  "J-01",
  "dueno.andina mueve 10 Bs en E2 de «Banco Mercantil» a «Caja Bs» → 201",
  async () => {
    const desde = await cuentaDe("E2", "Banco Mercantil");
    const hacia = await cuentaDe("E2", "Caja Bs");
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/treasury/transfers", {
      company_id: EMPRESAS.E2,
      from_account_id: desde,
      to_account_id: hacia,
      amount: "10.00",
      reason: "Verificación J-01 del recorrido",
    });
    afirmar(r.status === 201, `esperaba 201, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
    afirmar(r.json?.accounting === "posted", `el asiento no quedó posteado: ${r.json?.accounting}`);
    // Lo que solo produce el arreglo: el asiento mueve DOS cuentas contables distintas.
    const lineas = await sql`
    select count(distinct account_id)::int as n from public.journal_lines
     where entry_id = ${r.json.journal_entry_id}`;
    afirmar(lineas[0].n === 2, `el asiento debía mover dos subcuentas; movió ${lineas[0].n}`);
  },
);

c.caso("J-04", "platform.treasury_ledger_gaps da 0 en E1, E2 y E3", async () => {
  for (const e of ["E1", "E2", "E3"]) {
    const filas = await sql`
      select account_name, problem from platform.treasury_ledger_gaps(${EMPRESAS[e]})`;
    afirmar(
      filas.length === 0,
      `${e}: ${filas.map((f) => `${f.account_name}/${f.problem}`).join(", ")}`,
    );
  }
});

// J-03 (ola 3, ADR-0068 §8): el cierre de caja solo acepta cajas y no revela el saldo de lo que el
// rol no ve. El encargado de E2 (cash.close sin treasury.read) contra «Banco Mercantil».
c.caso(
  "J-03",
  "el encargado cierra «Banco Mercantil» de E2 → 404, sin saldo y sin escribir",
  async () => {
    const banco = await cuentaDe("E2", "Banco Mercantil");
    const [antes] = await sql`
    select count(*)::int as n from public.cash_closings where account_id = ${banco}`;
    const r = await pedir(PERSONAS.encargado, "E2", "POST", "/v1/cash-closings", {
      company_id: EMPRESAS.E2,
      account_id: banco,
      counted_amount: "0.00",
      reason: "Verificación J-03 del recorrido",
    });
    afirmar(r.status === 404, `esperaba 404, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
    afirmar(!r.texto.includes("esperaba"), "el mensaje revela el saldo del banco");
    const [despues] = await sql`
    select count(*)::int as n from public.cash_closings where account_id = ${banco}`;
    afirmar(despues.n === antes.n, "se escribió un cierre sobre el banco");
  },
);
c.caso(
  "J-03",
  "el dueño de E2 cierra «Banco Mercantil» → 422 «Solo se cierran cajas», sin saldo",
  async () => {
    const banco = await cuentaDe("E2", "Banco Mercantil");
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/cash-closings", {
      company_id: EMPRESAS.E2,
      account_id: banco,
      counted_amount: "0.00",
      reason: "Verificación J-03 del recorrido",
    });
    afirmar(r.status === 422, `esperaba 422, llegó ${r.status}`);
    afirmar(r.json?.message?.includes("Solo se cierran cajas"), `mensaje: ${r.json?.message}`);
    afirmar(!r.texto.includes("esperaba"), "el mensaje revela el saldo del banco");
  },
);

// J-04 (ADR-0075 §6, familia «moneda B»): la igualdad EN LA MONEDA DE LA CAJA. El saldo en USD de cada
// caja en divisa es la suma de los importes originales en USD de su subcuenta (y en Bs, su saldo
// funcional). Lo anterior a E-11 lo llevó al mayor la reparación adr-0075-divisa-del-mayor.
c.caso("J-04", "platform.treasury_currency_gaps da 0 en E1, E2 y E3", async () => {
  for (const e of ["E1", "E2", "E3"]) {
    const filas = await sql`
      select account_name, currency, treasury_balance::text as caja, ledger_original::text as mayor
        from platform.treasury_currency_gaps(${EMPRESAS[e]})`;
    afirmar(
      filas.length === 0,
      `${e}: ${filas.map((f) => `${f.account_name} ${f.currency} caja ${f.caja} ≠ mayor ${f.mayor}`).join("; ")}`,
    );
  }
});

c.caso(
  "J-04",
  "la caja en dólares de E1 tiene sus dólares en el mayor, no solo sus bolívares",
  async () => {
    const cajas = await sql`
    select ca.name, coalesce(b.balance, 0)::text as saldo,
           platform.treasury_ledger_original(ca.company_id, ca.ledger_account_id, ca.currency, null)::text
             as original
      from public.company_accounts ca
      join public.companies co on co.id = ca.company_id
      left join public.company_account_balances b on b.account_id = ca.id
     where ca.company_id = ${EMPRESAS.E1} and ca.currency <> co.functional_currency_code
       and ca.ledger_account_id is not null and coalesce(b.balance, 0) <> 0`;
    afirmar(cajas.length > 0, "E1 no tiene ninguna caja en divisa con saldo: el caso no mide nada");
    for (const k of cajas) {
      afirmar(
        Number(k.original) === Number(k.saldo),
        `«${k.name}»: caja ${k.saldo}, mayor ${k.original}`,
      );
    }
  },
);

// ── Moneda B, revisión (ADR-0075 §6; H2, H5, H7) ─────────────────────────────
// H7: la tasa de cierre no puede ser rancia. A 30 días vista de hoy EXISTE una oficial anterior
// (la que el cierre usaba antes del margen) y `closing_rate` no devuelve ninguna. Desde
// 20261004195900 `rate_at` aplica el mismo margen (una sola regla), así que la precondición ya
// no puede medirse con `rate_at`: se mide en la tabla, que es donde la tasa rancia sigue estando.
c.caso("J-04", "la tasa de cierre no admite una tasa más vieja que el margen", async () => {
  const [p] = await sql`
    select value::int as dias from platform.parameters where key = 'closing_rate_max_age_days'`;
  afirmar(p && p.dias >= 0, "falta el parámetro closing_rate_max_age_days");
  afirmar(p.dias < 30, `el margen (${p.dias} días) alcanza los 30 días del caso: no mide nada`);
  const [t] = await sql`
    select (select max(r.rate_date)::text from public.exchange_rates r
             where r.company_id is null and r.from_currency = 'USD' and r.to_currency = 'VES'
               and r.rate_date <= platform.caracas_day(now()) + 30) as rancia,
           platform.closing_rate(${EMPRESAS.E1}, 'USD', 'VES',
                                 platform.caracas_day(now()) + 30) as cierre`;
  afirmar(t.rancia !== null, "no hay ninguna tasa oficial USD→VES: el caso no mide nada");
  afirmar(t.cierre === null, `closing_rate devolvió ${t.cierre} con una tasa de hace 30 días`);
});

// H2: la revaluación da UNA fila por cuenta y ninguna «prior»: nunca ganancia y pérdida a la vez.
c.caso("J-04", "la revaluación al cierre netea por cuenta en E1, E2 y E3", async () => {
  for (const e of ["E1", "E2", "E3"]) {
    let filas;
    try {
      filas = await sql`
        select item_kind, account_id from platform.fx_revaluation_items(
          ${EMPRESAS[e]}, platform.caracas_day(now()))`;
    } catch (err) {
      // Sin tasa de cierre dentro del margen la función se detiene (LAD51): es H7, no un fallo.
      afirmar(err?.code === "LAD51", `${e}: ${err?.message}`);
      continue;
    }
    afirmar(
      filas.every((f) => !f.item_kind.endsWith("_prior")),
      `${e}: la revaluación trae filas «prior»`,
    );
    const cuentas = filas.map((f) => f.account_id);
    afirmar(
      new Set(cuentas).size === cuentas.length,
      `${e}: la revaluación trae dos filas para una misma cuenta`,
    );
  }
});

// H5: el asiento de la regularización de la divisa no nace manual (no se reversa suelto). Lo
// EJERCE pgTAP 110 §13; aquí se comprueba que la base lleva esa definición. Los asientos que se
// postearon antes de 20261003210000 nacieron manuales y así quedan (append-only).
c.caso("J-04", "la regularización de la divisa no nace como asiento manual", async () => {
  const [f] = await sql`
    select pg_get_functiondef('platform.treasury_currency_regularization_prepare(uuid)'::regprocedure)
             as def`;
  afirmar(
    f.def.includes("'treasury.currency_regularized'") && !f.def.includes("v_fecha, 'manual'"),
    "la función de regularización sigue escribiendo un asiento manual",
  );
});

// ── J-02 (ola 4, migración 20261004180000) ──────────────────────────────────
// El sobregiro que se cubre al cerrar la caja es dinero del dueño: pasivo, nunca ingreso. No se
// cierra ninguna caja aquí (el escenario es compartido): se mira el cierre de «Caja Bs» de E2
// (esperado −120.000, contado 0) tal como lo dejó la reparación `j-02-sobregiro-al-cierre.mjs`.
c.caso(
  "J-02",
  "ningún cierre en sobregiro de E1, E2 o E3 tiene vigente el asiento contra resultado",
  async () => {
    for (const e of ["E1", "E2", "E3"]) {
      const viejos = await sql`
        select k.id from public.cash_closings k
          join public.journal_entries a on a.id = k.journal_entry_id
         where k.company_id = ${EMPRESAS[e]} and k.expected_amount < 0
           and a.source_kind = 'cash_closing'`;
      afirmar(
        viejos.length === 0,
        `${e}: ${viejos.length} cierre(s) en sobregiro siguen en 5.1.06`,
      );
    }
  },
);

c.caso(
  "J-02",
  "el cierre de «Caja Bs» de E2 en −120.000 abona 120.000 a un PASIVO del dueño, no a resultado",
  async () => {
    const lineas = await sql`
      select c.kind, s.purpose, l.functional_credit::numeric(24,2)::text as haber,
             a.source_kind, a.source_event, a.status
        from public.cash_closings k
        join public.journal_entries a on a.id = k.journal_entry_id
        join public.journal_lines l on l.entry_id = a.id and l.functional_credit > 0
        join public.accounts c on c.id = l.account_id
        left join public.company_account_settings s
               on s.company_id = k.company_id and s.account_id = l.account_id
              and s.effective_to is null
       where k.company_id = ${EMPRESAS.E2} and k.expected_amount = -120000 and k.counted_amount = 0`;
    afirmar(lineas.length === 1, `esperaba una línea al haber, hay ${lineas.length}`);
    const [l] = lineas;
    afirmar(l.status === "posted", `el asiento vigente está ${l.status}`);
    // El hecho va en el ORIGEN, con el evento real del outbox (migración 20261004180200).
    afirmar(
      l.source_kind === "cash_closing_overdraft" &&
        l.source_event === "treasury.cash_register.closed",
      `el hecho es ${l.source_kind} / ${l.source_event}`,
    );
    afirmar(l.kind === "pasivo", `la contrapartida es una cuenta de ${l.kind}`);
    afirmar(l.purpose === "owner_payable", `el papel de la contrapartida es ${l.purpose}`);
    afirmar(l.haber === "120000.00", `abonó ${l.haber}`);
  },
);

c.caso(
  "J-02",
  "la reclasificación de E2 dejó reversa y acta, y volver a correr la reparación no escribe nada",
  async () => {
    // La idempotencia, de verdad: se cuenta todo lo que la reparación puede escribir, se corre
    // sobre E2 (ya reparada: no hay nada que mover en el escenario compartido) y se vuelve a contar.
    const { repairOverdraftClosings } = await import(
      new URL("../../../packages/domain/dist/index.js", import.meta.url).href
    );
    const rastro = async () =>
      (
        await sql`
          select (select count(*)::int from public.audit_events
                   where company_id = ${EMPRESAS.E2}) as actas,
                 (select count(*)::int from public.journal_entries
                   where company_id = ${EMPRESAS.E2}) as asientos,
                 (select count(*)::int from public.journal_lines
                   where company_id = ${EMPRESAS.E2}) as lineas,
                 (select count(*)::int from public.journal_generation_queue
                   where company_id = ${EMPRESAS.E2} and status = 'pending') as cola`
      )[0];
    const antes = await rastro();
    const r = await sql.begin((tx) => repairOverdraftClosings(tx, EMPRESAS.E2));
    afirmar(
      r.reclassified.length === 0 && r.requeued.length === 0,
      `la reparación volvió a mover ${r.reclassified.length + r.requeued.length} cierre(s)`,
    );
    const despues = await rastro();
    afirmar(
      JSON.stringify(antes) === JSON.stringify(despues),
      `la segunda corrida escribió algo: ${JSON.stringify(antes)} → ${JSON.stringify(despues)}`,
    );
    const [n] = await sql`
      select (select count(*)::int from public.audit_events
               where company_id = ${EMPRESAS.E2}
                 and event_type = 'treasury.overdraft_closing_reclassified') as actas,
             (select count(*)::int from public.journal_entries v
                join public.journal_entries r on r.id = v.reversed_by_entry_id
               where v.company_id = ${EMPRESAS.E2} and v.source_kind = 'cash_closing'
                 and v.status = 'reversed' and r.status = 'posted') as reversas`;
    // Exactamente una: con el escenario restaurado la reparación pasa UNA vez por este cierre. Una
    // base local que conoció el nombre anterior del hecho (antes de 20261004180200) puede traer
    // dos: ahí el caso sale rojo hasta restaurar, y es lo correcto.
    afirmar(n.actas === 1, `esperaba exactamente 1 acta, hay ${n.actas}`);
    afirmar(
      n.reversas === 1,
      `esperaba exactamente 1 asiento reversado con su contra-asiento, hay ${n.reversas}`,
    );
  },
);

c.caso(
  "J-02",
  "E1, E2 y E3: balance cuadrado, cobertura y céntimo en cero tras la reclasificación",
  async () => {
    for (const e of ["E1", "E2", "E3"]) {
      const [n] = await sql`
        select (select count(*)::int from platform.accounting_coverage_gaps(${EMPRESAS[e]})) as cobertura,
               (select count(*)::int from platform.cent_gaps(${EMPRESAS[e]})) as centimo,
               (select coalesce(sum(period_debit), 0) = coalesce(sum(period_credit), 0)
                  from platform.trial_balance(${EMPRESAS[e]}, platform.caracas_day(now()))) as cuadra`;
      afirmar(n.cobertura === 0, `${e}: accounting_coverage_gaps = ${n.cobertura}`);
      afirmar(n.centimo === 0, `${e}: cent_gaps = ${n.centimo}`);
      afirmar(n.cuadra === true, `${e}: el balance de comprobación no cuadra`);
    }
  },
);

export default c.correr;

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
// H7: la tasa de cierre no puede ser rancia. A 30 días vista de hoy, `rate_at` sigue devolviendo
// la última tasa (lo que el cierre usaba) y `closing_rate` no devuelve ninguna.
c.caso("J-04", "la tasa de cierre no admite una tasa más vieja que el margen", async () => {
  const [p] = await sql`
    select value::int as dias from platform.parameters where key = 'closing_rate_max_age_days'`;
  afirmar(p && p.dias >= 0, "falta el parámetro closing_rate_max_age_days");
  const [t] = await sql`
    select platform.rate_at(${EMPRESAS.E1}, 'USD', 'VES', platform.caracas_day(now()) + 30) as rancia,
           platform.closing_rate(${EMPRESAS.E1}, 'USD', 'VES',
                                 platform.caracas_day(now()) + 30) as cierre`;
  afirmar(t.rancia !== null, "no hay ninguna tasa USD→VES: el caso no mide nada");
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

export default c.correr;

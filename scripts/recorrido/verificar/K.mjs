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

export default c.correr;

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

export default c.correr;

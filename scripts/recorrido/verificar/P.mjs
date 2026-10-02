/**
 * Bloque P · Datos. Comprobaciones de `pnpm recorrido P` (ver `_app.mjs`).
 *
 * P-02: el documento se guarda NORMALIZADO en todos los caminos (la reparación
 *   scripts/reparar/p-02-rif-normalizado.mjs corre tras la restauración) y la búsqueda encuentra
 *   con cualquier grafía.
 */
import { comprobaciones, pedir, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";

const c = comprobaciones("P");

c.caso("P-02", "buscar «J40999888» y «J-40999888-1» encuentra a Abastos El Sol", async () => {
  for (const grafia of ["J40999888", "J-40999888-1"]) {
    const r = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "GET",
      `/v1/customers?search=${encodeURIComponent(grafia)}`,
    );
    afirmar(r.status === 200, `«${grafia}» dio ${r.status}`);
    const nombres = r.json.items.map((x) => x.legal_name);
    afirmar(nombres.includes("Abastos El Sol, C.A."), `«${grafia}» → ${JSON.stringify(nombres)}`);
  }
});

c.caso(
  "P-02",
  "ningún cliente, proveedor ni empresa de E1-E3 guarda el documento con separadores",
  async () => {
    const ids = Object.values(EMPRESAS);
    const [f] = await sql`
    select (select count(*) from public.customers where company_id = any(${ids}::uuid[])
              and tax_id <> upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')))
         + (select count(*) from public.suppliers where company_id = any(${ids}::uuid[])
              and tax_id <> upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')))
         + (select count(*) from public.companies where id = any(${ids}::uuid[])
              and upper(tax_id) not like 'PEND-%'
              and tax_id <> upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g'))) as n`;
    afirmar(Number(f.n) === 0, `${f.n} documento(s) sin normalizar`);
  },
);

export default c.correr;

/**
 * Bloque M · Mostrador y documentos. Comprobaciones de `pnpm recorrido M` (ver `_app.mjs`).
 *
 * M-05 (regla del dueño, 2026-09-28): el RIF de persona natural (V de 9 dígitos) se enseña
 *   `V-12345678-9`, nunca agrupado como cédula («V-123.456.789»). La web y el PDF usan UNA sola
 *   función (`formatearDocumento` de @ladino/schemas).
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { comprobaciones, pedir, pedirBytes, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { formatearDocumento } = await import(
  pathToFileURL(path.join(RAIZ, "packages", "schemas", "dist", "index.js")).href
);

/** Infla los streams del PDF y decodifica los <hex> de los TJ (como en los E2E). */
function textoDelPdf(bruto) {
  let texto = "";
  let i = 0;
  for (;;) {
    const s = bruto.indexOf("stream", i);
    if (s === -1) break;
    let inicio = s + 6;
    if (bruto[inicio] === 0x0d) inicio++;
    if (bruto[inicio] === 0x0a) inicio++;
    const fin = bruto.indexOf("endstream", inicio);
    if (fin === -1) break;
    const trozo = bruto.subarray(inicio, fin);
    try {
      texto += inflateSync(trozo).toString("latin1");
    } catch {
      texto += trozo.toString("latin1");
    }
    i = fin + 9;
  }
  return [...texto.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map((m) => Buffer.from(m[1], "hex").toString("latin1"))
    .join("");
}

const c = comprobaciones("M");

// Lógica, no pantalla: el runner no levanta la web (ver O.mjs). La pantalla de Mi empresa usa
// esta misma función (comunes.tsx la reexporta); el PDF, el caso de abajo, sí es el documento real.
c.caso(
  "M-05 (lógica, no pantalla)",
  "el RIF V de 9 dígitos de E1 se formatea como RIF, no como cédula",
  async () => {
    const r = await pedir(PERSONAS.duenaE1, "E1", "GET", "/v1/companies");
    afirmar(r.status === 200, `GET /v1/companies dio ${r.status}`);
    const e1 = r.json.find((x) => x.id === EMPRESAS.E1);
    afirmar(e1, "E1 no está en la lista de su dueña");
    afirmar(e1.tax_id === "V123456789", `E1 guarda «${e1.tax_id}», no el RIF normalizado`);
    const visto = formatearDocumento(e1.tax_id);
    afirmar(visto === "V-12345678-9", `se enseña «${visto}»`);
  },
);

c.caso("M-05", "el membrete del PDF de una factura de E2 imprime el RIF con guiones", async () => {
  const [doc] = await sql`
    select id from public.documents
     where company_id = ${EMPRESAS.E2} and kind = 'invoice' and status = 'issued'
     order by issued_at desc limit 1`;
  afirmar(doc, "E2 no tiene facturas emitidas");
  const r = await pedirBytes(PERSONAS.duenoE2E3, "E2", `/v1/documents/${doc.id}/pdf`);
  afirmar(r.status === 200, `el PDF dio ${r.status}`);
  const texto = textoDelPdf(r.bytes);
  afirmar(texto.includes("RIF: J-40555123-4"), "el membrete no dice «RIF: J-40555123-4»");
});

export default c.correr;

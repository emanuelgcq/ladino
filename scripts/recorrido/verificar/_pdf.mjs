/**
 * El TEXTO de un PDF de Ladino, para las comprobaciones del papel (ADR-0071 §4; A-06, A-11, G-02,
 * G-03, G-09, G-11): infla los streams y decodifica los <hex> de los TJ en WinAnsi, la
 * codificación de las fuentes estándar de pdfkit. La misma técnica que
 * apps/api/test/e2e-checklist-factura.test.ts, sin dependencias.
 */
import { inflateSync } from "node:zlib";
import { pedirBytes, sql, EMPRESAS } from "./_app.mjs";

export function textoDelPdf(bytes) {
  let texto = "";
  let i = 0;
  for (;;) {
    const s = bytes.indexOf("stream", i);
    if (s === -1) break;
    let inicio = s + 6;
    if (bytes[inicio] === 0x0d) inicio++;
    if (bytes[inicio] === 0x0a) inicio++;
    const fin = bytes.indexOf("endstream", inicio);
    if (fin === -1) break;
    const trozo = bytes.subarray(inicio, fin);
    try {
      texto += inflateSync(trozo).toString("latin1");
    } catch {
      texto += trozo.toString("latin1");
    }
    i = fin + 9;
  }
  const win = new TextDecoder("windows-1252");
  return [...texto.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map((m) => win.decode(Buffer.from(m[1], "hex")))
    .join("");
}

/** pdfkit parte las líneas largas y el espacio del corte desaparece: se compara sin espacios. */
export const tiene = (texto, aguja) =>
  texto.replace(/\s+/g, "").includes(aguja.replace(/\s+/g, ""));

/** El id de un documento del escenario por empresa, clase, serie y número. */
export async function idDocumento(empresa, kind, series, numero) {
  const [d] = await sql`
    select id from public.documents
     where company_id = ${EMPRESAS[empresa]} and kind = ${kind} and series = ${series}
       and document_number = ${numero}`;
  return d?.id ?? null;
}

/** El texto del PDF de un documento, como `correo` en `empresa`; `query` sin «?». */
export async function textoDe(correo, empresa, id, query = "") {
  const r = await pedirBytes(
    correo,
    empresa,
    `/v1/documents/${id}/pdf${query === "" ? "" : `?${query}`}`,
  );
  return { status: r.status, texto: r.status === 200 ? textoDelPdf(r.bytes) : "" };
}

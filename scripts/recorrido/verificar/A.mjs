/**
 * Bloque A · Registro y Mi empresa. Comprobaciones de `pnpm recorrido A` (ver `_app.mjs`).
 *
 * A-08 (regla del dueño, 2026-09-28): la ESTRUCTURA del RIF bloquea (422 legible); el dígito
 *   verificador del módulo 11 solo avisa — el RIF del escenario (J-40555123-4) no cuadra y se
 *   aceptó.
 * A-17: la corrección del RIF rechaza el marcador `PEND-…`.
 * Ninguna comprobación cambia el RIF: todas son rechazos, y se mira que el dato no se movió.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { comprobaciones, pedir, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";
import { textoDe, tiene, idDocumento } from "./_pdf.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { leerRif } = await import(
  pathToFileURL(path.join(RAIZ, "packages", "schemas", "dist", "index.js")).href
);

const c = comprobaciones("A");

async function rifDe(empresa) {
  const [fila] = await sql`select tax_id from public.companies where id = ${EMPRESAS[empresa]}`;
  return fila.tax_id;
}

c.caso(
  "A-08",
  "un RIF sin estructura es 422 con el mensaje de la forma, y no cambia nada",
  async () => {
    const antes = await rifDe("E2");
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/companies/tax-id/correct", {
      tax_id: "J-1",
      reason: "Comprobación del recorrido A-08",
    });
    afirmar(r.status === 422, `dio ${r.status}`);
    afirmar(String(r.json?.message).includes("nueve dígitos"), `mensaje: ${r.json?.message}`);
    afirmar((await rifDe("E2")) === antes, "el RIF de E2 cambió");
  },
);

c.caso(
  "A-08",
  "el RIF del escenario tiene la forma y un dígito que no cuadra: aceptado con aviso",
  async () => {
    const l = leerRif(await rifDe("E2"));
    afirmar(l.valido && l.digito === "incorrecto" && l.esperado === 2, JSON.stringify(l));
  },
);

c.caso(
  "A-17",
  "la corrección con «PEND-X» es 422 con su propio mensaje, y no cambia nada",
  async () => {
    const antes = await rifDe("E2");
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/companies/tax-id/correct", {
      tax_id: "PEND-X",
      reason: "Comprobación del recorrido A-17",
    });
    afirmar(r.status === 422, `dio ${r.status}`);
    afirmar(
      String(r.json?.message).includes("«PEND-…» es la marca"),
      `mensaje: ${r.json?.message}`,
    );
    afirmar((await rifDe("E2")) === antes, "el RIF de E2 cambió");
  },
);

// ── Ola 2 · el papel (ADR-0071 §4) ───────────────────────────────────────────
c.caso(
  "A-06",
  "el recibo de devolución de E1 (sin RIF) no imprime «P-END…», ni IVA, ni la PA 00071",
  async () => {
    const id = await idDocumento("E1", "receipt_return", "D", 1);
    afirmar(id, "no está el recibo de devolución D-1 de E1");
    const { texto } = await textoDe(PERSONAS.duenaE1, "E1", id);
    afirmar(
      tiene(texto, "Documento no fiscal: no es factura ni nota de crédito"),
      "falta la leyenda",
    );
    afirmar(!/P-END|PEND-/.test(texto), "imprime el marcador sin RIF como si fuera un RIF");
    afirmar(!/IVA|PA 00071/.test(texto), "finge campos de factura");
  },
);

c.caso(
  "A-11",
  "ningún papel de E2 cita la homologación ni la PA 121: factura, NC y ND, en sus tres destinos",
  async () => {
    for (const [kind, n] of [
      ["invoice", 1],
      ["credit_note", 1],
      ["debit_note", 1],
    ]) {
      const id = await idDocumento("E2", kind, "A", n);
      afirmar(id, `no está ${kind} A-${n} de E2`);
      for (const q of ["", "destino=papel", "destino=vista", "destino=papel&copia=1"]) {
        const { status, texto } = await textoDe(PERSONAS.duenoE2E3, "E2", id, q);
        afirmar(status === 200, `${kind} ${q}: ${status}`);
        afirmar(
          !/homolog/i.test(texto) && !/000121|PA 121|VALIDAR-/.test(texto),
          `${kind} A-${n} (${q || "cortesía"}) cita la homologación derogada`,
        );
      }
    }
  },
);

// ── A-03 (ADR-0072 §1): el tipo de contribuyente se declara; nunca «ordinario por omisión» ──
c.caso("A-03", "E3 lee su tipo por la historia: especial, con su notificación", async () => {
  const r = await pedir(PERSONAS.duenoE2E3, "E3", "GET", "/v1/companies/taxpayer-type");
  afirmar(r.status === 200, `dio ${r.status}`);
  afirmar(r.json?.current?.taxpayer_type_code === "especial", JSON.stringify(r.json?.current));
  afirmar(r.json?.current?.notified_on === "2026-09-24", JSON.stringify(r.json?.current));
});
c.caso("A-03", "una empresa nueva con RIF nace SIN tipo y no factura sin declararlo", async () => {
  // La empresa nueva: ninguna fila de historia ⇒ la única lectura devuelve NULL, y la puerta de
  // la emisión (exigeTipoParaFacturar) responde TAXPAYER_TYPE_REQUIRED (E2E e2e-tipo-contribuyente).
  const [f] = await sql`
    select platform.taxpayer_type_at(gen_random_uuid(), current_date) as tipo,
           (select column_default from information_schema.columns
             where table_schema = 'public' and table_name = 'company_taxpayer_types'
               and column_name = 'taxpayer_type_code') as omision`;
  afirmar(f.tipo === null && f.omision === null, JSON.stringify(f));
});

export default c.correr;

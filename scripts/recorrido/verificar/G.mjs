/**
 * Bloque G · Corregir. Comprobaciones de `pnpm recorrido G` (ver `_app.mjs`).
 *
 * G-01 (ADR-0071, PA 00071 art. 44): un correlativo de control por emisor e identificador. El
 * rango de notas de crédito A 1-500 que el recorrido cargó sobre el de facturas A 1-5000 de E2 ya
 * no se puede cargar (409 que dice cuál pisa), y en E2 no queda ningún control repetido: las NC
 * A-1 y A-2 tomaron el siguiente control libre en `corregir-escenario.sql` (solo local).
 * G-16: el aviso de «no hay rango» sale en español («notas de débito»), nunca «debit_note».
 */
import { comprobaciones, pedir, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";
import { textoDe, tiene, idDocumento } from "./_pdf.mjs";

const c = comprobaciones("G");
const E2 = EMPRESAS.E2;

c.caso("G-01", "cargar en E2 un rango de NC A 1-500 que pisa el de facturas → 409", async () => {
  const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/fiscal-number-ranges", {
    company_id: E2,
    kind: "credit_note",
    series: "A",
    range_from: "1",
    range_to: "500",
    printer_legal_name: "Gráficas Lara, C.A.",
    printer_tax_id: "J-12345678-9",
    printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
    printer_authorization_date: "2020-01-15",
    printed_on: "2026-09-01",
  });
  afirmar(r.status === 409, `esperaba 409, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
  afirmar(
    /pisa el talonario serie A 1–5000/.test(r.json?.message ?? ""),
    `el mensaje no dice cuál pisa: ${r.json?.message}`,
  );
});

c.caso("G-01", "en E2 ningún control se repite, sea factura o nota", async () => {
  const repetidos = await sql`
    select control_number, documents from platform.control_number_collisions()
     where company_id = ${E2}`;
  afirmar(
    repetidos.length === 0,
    `controles repetidos: ${repetidos.map((x) => `${x.control_number} (${x.documents})`).join("; ")}`,
  );
  const [nc] = await sql`
    select control_number::int as control from public.documents
     where company_id = ${E2} and kind = 'credit_note' and series = 'A' and document_number = 1`;
  afirmar(nc, "no está la NC A-1 de E2");
  afirmar(nc.control !== 1, "la NC A-1 sigue con el control 1 de la factura A-1");
});

c.caso("G-01", "ningún rango de control se solapa en el escenario", async () => {
  const solapes = await sql`select company_id from platform.control_range_overlaps()`;
  afirmar(solapes.length === 0, `rangos solapados: ${solapes.length}`);
});

c.caso(
  "G-16",
  "sin talonario, el aviso de una ND dice «notas de débito», no «debit_note»",
  async () => {
    let mensaje = "";
    try {
      await sql`select * from platform.claim_fiscal_control(${E2}, 'debit_note', 'SIN-TALONARIO')`;
    } catch (e) {
      mensaje = e instanceof Error ? e.message : String(e);
    }
    afirmar(
      mensaje ===
        "No quedan números de control para notas de débito (identificador 00). Carga el talonario nuevo.",
      `mensaje: ${mensaje}`,
    );
  },
);

// ── Ola 2 · el papel de la NC y la ND (ADR-0071 §4; RESPUESTA §2.4) ──────────
c.caso(
  "G-02",
  "la NC A-1 de E2 cita la factura que corrige: número, control, fecha y monto",
  async () => {
    const id = await idDocumento("E2", "credit_note", "A", 1);
    afirmar(id, "no está la NC A-1 de E2");
    const { status, texto } = await textoDe(PERSONAS.duenoE2E3, "E2", id);
    afirmar(status === 200, `PDF: ${status}`);
    afirmar(
      // Con serie, el número impreso lleva la palabra «Serie» (PA 00071 arts. 26-27).
      /Factura que corrige: Serie A N° \d{8} · Control \d{2}-\d{8} · del \d{2}\/\d{2}\/\d{4} · por Bs\. [\d.]+,\d{2}/.test(
        texto,
      ),
      `sin referencia completa a la factura: ${texto.slice(0, 400)}`,
    );
  },
);

c.caso(
  "G-09",
  "la ND A-1 de E2 describe el ajuste, trae el motivo guardado y el IVA con su porcentaje",
  async () => {
    const id = await idDocumento("E2", "debit_note", "A", 1);
    afirmar(id, "no está la ND A-1 de E2");
    const { texto } = await textoDe(PERSONAS.duenoE2E3, "E2", id);
    afirmar(tiene(texto, "Descripción del ajuste: débito de Bs."), "la ND no describe el ajuste");
    afirmar(tiene(texto, "Motivo: Diferencia de precio"), "la ND no imprime su motivo");
    afirmar(/IVA \d+(,\d+)? %:/.test(texto), "el IVA sale sin porcentaje");
  },
);

c.caso(
  "G-09",
  "la NC A-2 de E2 (de una devolución) imprime el motivo de la devolución, no un texto inventado",
  async () => {
    const id = await idDocumento("E2", "credit_note", "A", 2);
    afirmar(id, "no está la NC A-2 de E2");
    const [dev] = await sql`select reason from public.returns where credit_note_id = ${id}`;
    const { texto } = await textoDe(PERSONAS.duenoE2E3, "E2", id);
    const esperado = dev ? `Motivo: ${dev.reason}` : "Motivo: —";
    afirmar(tiene(texto, esperado), `esperaba «${esperado}»`);
  },
);

c.caso(
  "G-11",
  "las notas de E2 van a la tasa de la factura, impresa con su número y su fecha",
  async () => {
    const id = await idDocumento("E2", "credit_note", "A", 1);
    const { texto } = await textoDe(PERSONAS.duenoE2E3, "E2", id);
    afirmar(
      // «Tasa BCV» si la fuente es el BCV; si no, «Tipo de cambio»: el PDF nombra lo que hay.
      /(Tasa BCV|Tipo de cambio) de la factura Serie A N° \d{8} del \d{2}\/\d{2}\/\d{4}: Bs [\d.,]+/.test(
        texto,
      ),
      `la tasa de la nota no dice de qué factura ni de qué día es: ${texto.slice(0, 600)}`,
    );
  },
);

c.caso(
  "G-03",
  "el recibo de devolución D-1 de E1: su leyenda, sin RIF inventado, sin IVA y sin providencia",
  async () => {
    const id = await idDocumento("E1", "receipt_return", "D", 1);
    afirmar(id, "no está el recibo de devolución D-1 de E1");
    const { status, texto } = await textoDe(PERSONAS.duenaE1, "E1", id);
    afirmar(status === 200, `PDF: ${status}`);
    afirmar(
      tiene(
        texto,
        "Recibo de devolución · Documento no fiscal: no es factura ni nota de crédito y no otorga derecho a crédito fiscal",
      ),
      "falta la leyenda del recibo de devolución",
    );
    afirmar(
      texto.includes("RECIBO DE DEVOLUCIÓN") && !texto.includes("RECEIPT_RETURN"),
      "el título sale en inglés",
    );
    afirmar(!/P-END|PEND-|RIF:/.test(texto), "imprime un RIF (el marcador sin RIF)");
    afirmar(!/IVA/.test(texto), "imprime una fila de IVA");
    afirmar(!/PA 00071|art\. 13/.test(texto), "cita la providencia de la factura");
    const copia = await textoDe(PERSONAS.duenaE1, "E1", id, "copia=1");
    afirmar(
      copia.status === 422,
      `la copia fiscal de un recibo de devolución debía ser 422: ${copia.status}`,
    );
  },
);

export default c.correr;

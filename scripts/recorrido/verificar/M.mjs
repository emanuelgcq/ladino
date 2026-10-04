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
import * as v0076 from "./_app.mjs";

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

// ── ADR-0076 · la cuenta vendida muere en el servidor ─────────────────────────────────────────
const CUENTA_VENDIDA = "0076a000-0000-4000-8000-0000000000e2";
async function lapidaEnE2() {
  const [doc] = await v0076.sql`
    select id, tenant_id from public.documents
     where company_id = ${v0076.EMPRESAS.E2} and kind in ('invoice', 'receipt') and status <> 'draft'
     order by created_at desc limit 1`;
  v0076.afirmar(doc, "E2 no tiene ventas emitidas");
  await v0076.sql`
    insert into public.pos_carts (id, tenant_id, company_id, label, lines, sold_at, sale_id)
    values (${CUENTA_VENDIDA}, ${doc.tenant_id}, ${v0076.EMPRESAS.E2}, 'Cuenta cobrada', '[]',
            now(), ${doc.id})
    on conflict (id) do nothing`;
  const [fila] = await v0076.sql`select sale_id from public.pos_carts where id = ${CUENTA_VENDIDA}`;
  return fila.sale_id;
}

c.caso(
  "M-01 (ADR-0076)",
  "el PUT de una cuenta ya cobrada da 409 POS_CART_SOLD y no la resucita",
  async () => {
    await lapidaEnE2();
    const r = await v0076.pedir(
      v0076.PERSONAS.duenoE2E3,
      "E2",
      "PUT",
      `/v1/pos/carts/${CUENTA_VENDIDA}`,
      {
        company_id: v0076.EMPRESAS.E2,
        label: "Cuenta 11",
        customer_id: null,
        lines: [],
      },
    );
    v0076.afirmar(r.status === 409, `el PUT dio ${r.status}`);
    v0076.afirmar(r.json?.code === "POS_CART_SOLD", `code ${r.json?.code}`);
    const lista = await v0076.pedir(v0076.PERSONAS.duenoE2E3, "E2", "GET", "/v1/pos/carts");
    v0076.afirmar(
      !lista.json.items.some((x) => x.id === CUENTA_VENDIDA),
      "la vendida volvió a la lista",
    );
  },
);

c.caso(
  "M-02 (ADR-0076)",
  "cobrar otra vez la cuenta vendida (otra llave) da 409 con la venta vieja, no un replay 201",
  async () => {
    const venta = await lapidaEnE2();
    const [antes] =
      await v0076.sql`select count(*)::int as n from public.documents where company_id = ${v0076.EMPRESAS.E2}`;
    const r = await v0076.pedir(v0076.PERSONAS.duenoE2E3, "E2", "POST", "/v1/pos/sales", {
      company_id: v0076.EMPRESAS.E2,
      warehouse_id: (
        await v0076.sql`select id from public.warehouses where company_id = ${v0076.EMPRESAS.E2} limit 1`
      )[0].id,
      cart_id: CUENTA_VENDIDA,
      cart_version: 2,
      attempt_id: crypto.randomUUID(),
      lines: [{ product_id: crypto.randomUUID(), quantity: "1" }],
    });
    v0076.afirmar(
      r.status === 409 && r.json?.code === "POS_CART_SOLD",
      `dio ${r.status} ${r.json?.code}`,
    );
    v0076.afirmar(
      r.json?.details?.sale_id === venta,
      "el 409 no nombra la venta que cerró la cuenta",
    );
    const [despues] =
      await v0076.sql`select count(*)::int as n from public.documents where company_id = ${v0076.EMPRESAS.E2}`;
    v0076.afirmar(despues.n === antes.n, "se creó un documento");
  },
);

c.caso(
  "M-04 (ADR-0076)",
  "el aviso de la cuenta cobrada dice que ya se cobró y la salida (cuenta nueva), no «revisa y repite»",
  async () => {
    await lapidaEnE2();
    const r = await v0076.pedir(
      v0076.PERSONAS.duenoE2E3,
      "E2",
      "PUT",
      `/v1/pos/carts/${CUENTA_VENDIDA}`,
      {
        company_id: v0076.EMPRESAS.E2,
        label: "Cuenta 11",
        customer_id: null,
        lines: [],
      },
    );
    const m = r.json?.person_message ?? "";
    v0076.afirmar(/ya se cobró/.test(m) && /cuenta nueva/.test(m), `dice «${m}»`);
    v0076.afirmar(!/ya se registró/.test(m), "sigue diciendo «ya se registró»");
  },
);

c.caso(
  "M-03 (ADR-0076)",
  "una cuenta vendida no se borra ni se edita en la base: es la lápida",
  async () => {
    await lapidaEnE2();
    let rechazo = null;
    try {
      await v0076.sql`update public.pos_carts set label = 'Resucitada' where id = ${CUENTA_VENDIDA}`;
    } catch (e) {
      rechazo = e.code;
    }
    v0076.afirmar(rechazo === "LAD06", `el UPDATE de la lápida dio ${rechazo}`);
  },
);

export default c.correr;

/**
 * Bloque M · Mostrador y documentos. Comprobaciones de `pnpm recorrido M` (ver `_app.mjs`).
 *
 * M-05 (regla del dueño, 2026-09-28): el RIF de persona natural (V de 9 dígitos) se enseña
 *   `V-12345678-9`, nunca agrupado como cédula («V-123.456.789»). La web y el PDF usan UNA sola
 *   función (`formatearDocumento` de @ladino/schemas).
 */
import fs from "node:fs";
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

// ── Ola 4 · M-06, M-07, M-09, M-10, M-11, M-12: de recibos a facturas ────────────────────────
const fuenteWebM = (ruta) => fs.readFileSync(path.join(RAIZ, "apps/web/src", ruta), "utf8");

c.caso("M-06", "la banda «Con tu RIF puedes facturar» lleva al paso de las facturas", async () => {
  const aviso = fuenteWebM("components/capa-fiscal/AvisoFacturacion.tsx");
  afirmar(aviso.includes('to="/empezar?paso=facturas"'), "la banda no enlaza a ?paso=facturas");
  afirmar(!aviso.includes('to="/empezar"'), "la banda sigue enlazando a /empezar a secas");
  const paso = fuenteWebM("pages/negocio/empezar-paso.ts");
  afirmar(/facturas: 3/.test(paso) && /recibos: 3/.test(paso), "?paso=facturas no es el paso 4");
});

c.caso("M-07", "la escalera de /empezar dice con texto qué es cada paso", async () => {
  const empezar = fuenteWebM("pages/negocio/Empezar.tsx");
  afirmar(/\{i \+ 1\}\. \{p\.titulo\}/.test(empezar), "los pasos de la escalera no llevan texto");
  afirmar(empezar.includes("min-h-11"), "el botón de cada paso no tiene alto de toque");
});

c.caso(
  "M-09",
  "E1 (pasó de recibos a facturas el 25/09) recibe el aviso «ya facturas»; E2, que nació con RIF, no",
  async () => {
    const e1 = await pedir(PERSONAS.duenaE1, "E1", "GET", "/v1/fiscal/setup");
    afirmar(e1.status === 200, `setup de E1: ${e1.status}`);
    afirmar(e1.json.sales_mode === "facturas", `E1 vende con ${e1.json.sales_mode}`);
    afirmar(e1.json.invoicing_notice === true, `E1: invoicing_notice ${e1.json.invoicing_notice}`);
    const e2 = await pedir(PERSONAS.duenoE2E3, "E2", "GET", "/v1/fiscal/setup");
    afirmar(e2.json.invoicing_notice === false, `E2: invoicing_notice ${e2.json.invoicing_notice}`);
    const textos = fuenteWebM("components/capa-fiscal/textos.ts");
    afirmar(
      textos.includes("Ya facturas con tu RIF: tus ventas salen como factura."),
      "la banda no lleva el texto de la respuesta",
    );
    afirmar(
      fuenteWebM("pages/negocio/Vender.tsx").includes("<AvisoYaFacturas />"),
      "la caja no pinta la banda",
    );
  },
);

c.caso(
  "M-10",
  "«Formal» sigue sin poder declararse (P-38) y la base ya rechaza su línea gravada",
  async () => {
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "PUT", "/v1/companies/taxpayer-type", {
      company_id: EMPRESAS.E2,
      taxpayer_type_code: "formal",
      reason: "Verificación M-10",
    });
    afirmar(r.status === 422, `declarar formal dio ${r.status}`);
    const pantalla = fuenteWebM("components/capa-fiscal/TipoDeContribuyente.tsx");
    afirmar(/OCULTOS = new Set\(\["formal"\]\)/.test(pantalla), "«Formal» dejó de estar oculto");
    const [g] = await sql`
      select pg_get_functiondef('platform.assert_document_issuance()'::regprocedure) as def,
             (select count(*)::int from pg_trigger
               where tgrelid = 'public.document_lines'::regclass
                 and tgname = 'document_lines_formal') as puerta`;
    afirmar(/v_tipo = 'formal'/.test(g.def), "el gate de emisión no juzga al formal");
    afirmar(/no puedes vender productos gravados/.test(g.def), "el rechazo no lleva el texto");
    afirmar(g.puerta === 1, "falta la puerta de la línea agregada después de emitir");
  },
);

c.caso(
  "M-11",
  "los recibos de E1 de antes del RIF siguen como historia: su régimen, y ninguno en el libro",
  async () => {
    const [f] = await sql`
      select count(*)::int as recibos,
             count(*) filter (where r.regime_code <> 'sin_facturacion')::int as fuera,
             (select count(*)::int from public.documents x
               where x.company_id = ${EMPRESAS.E1}
                 and x.kind in ('invoice', 'credit_note', 'debit_note')
                 and x.issued_at < (select min(effective_from)
                                      from public.company_fiscal_regimes
                                     where company_id = ${EMPRESAS.E1}
                                       and regime_code = 'formatos_libres')) as fiscales_antes
        from public.documents d
        join public.company_fiscal_regimes r on r.id = d.regime_version_id
       where d.company_id = ${EMPRESAS.E1} and d.kind = 'receipt'`;
    afirmar(f.recibos >= 7, `E1 tiene ${f.recibos} recibos`);
    afirmar(f.fuera === 0, `${f.fuera} recibos cambiaron de régimen`);
    afirmar(f.fiscales_antes === 0, "hay documentos fiscales de antes de facturar");
  },
);

c.caso(
  "M-12",
  "E1, que ya factura, puede emitir el recibo de devolución de su recibo R-1 (se deshace)",
  async () => {
    class Deshacer extends Error {}
    let emitido = null;
    let rechazo = null;
    try {
      await sql.begin(async (tx) => {
        const [r1] = await tx`
          select id, tenant_id, customer_id, created_by from public.documents
           where company_id = ${EMPRESAS.E1} and kind = 'receipt' and series = 'R'
             and document_number = 1`;
        afirmar(r1, "E1 no tiene el recibo R-1");
        const [reg] = await tx`
          select regime_version_id as id, regime_code
            from platform.regime_at(${EMPRESAS.E1}, now())`;
        afirmar(reg.regime_code === "formatos_libres", `E1 está en ${reg.regime_code}`);
        await tx`select set_config('ladino.actor_id', ${r1.created_by}, true)`;
        const [doc] = await tx`
          insert into public.documents
            (tenant_id, company_id, kind, series, customer_id, status, issued_at,
             document_number, regime_version_id, rules_version, source_document_id,
             transaction_currency, functional_currency, fx_rate, rate_source,
             amount_transaction_currency, functional_amount, subtotal_amount, tax_amount,
             total_amount)
          values (${r1.tenant_id}, ${EMPRESAS.E1}, 'receipt_return', 'D', ${r1.customer_id},
                  'issued', now(), 999999, ${reg.id}, 'verificar-M-12', ${r1.id},
                  'VES', 'VES', 1, 'identidad', 1, 1, 1, 0, 1)
          returning kind, control_number`;
        emitido = doc;
        throw new Deshacer();
      });
    } catch (e) {
      if (!(e instanceof Deshacer)) rechazo = `${e.code ?? ""} ${e.message}`;
    }
    afirmar(rechazo === null, `la base lo rechazó: ${rechazo}`);
    afirmar(emitido?.kind === "receipt_return", "no se emitió el recibo de devolución");
    afirmar(emitido.control_number === null, "el recibo de devolución tomó número de control");
    const [queda] = await sql`
      select count(*)::int as n from public.documents
       where company_id = ${EMPRESAS.E1} and document_number = 999999`;
    afirmar(queda.n === 0, "la verificación dejó un documento en el escenario");
  },
);

export default c.correr;

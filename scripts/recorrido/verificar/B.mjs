/**
 * Bloque B · Primer día. Comprobaciones de `pnpm recorrido B` (ver `_app.mjs`).
 *
 * B-16 (ADR-0068 §1): el encargado tiene `product.manage` y no `price_list.manage`, y el alta
 * simple con precio le daba 403. El precio del alta lo autoriza el alta. Ya no debe reproducir.
 *
 * B-02, B-04, B-11 (ADR-0073, migración 20260928150000): la general se acepta desde el catálogo y
 * aceptar otra tasa SE APLICA; la reducida, la adicional y la exenta vienen del catálogo y se
 * venden; la ayuda del porcentaje sale del catálogo, no de un «hoy 16 %» escrito en la web.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { comprobaciones, pedir, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";

const c = comprobaciones("B");

c.caso(
  "B-16",
  "encargado@ da de alta en E2 un producto con precio → 201 y el precio puesto",
  async () => {
    const nombre = `Verificación B-16 ${Date.now().toString(36)}`;
    const r = await pedir(PERSONAS.encargado, "E2", "POST", "/v1/products/simple", {
      company_id: EMPRESAS.E2,
      name: nombre,
      price: { amount: "3", currency: "USD" },
    });
    afirmar(r.status === 201, `esperaba 201, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
    // Lo que solo produce el arreglo: el precio quedó en una lista, no solo el producto.
    const [precio] = await sql`
    select amount::text as amount from public.price_list_items
     where company_id = ${EMPRESAS.E2} and product_id = ${r.json.product.id}`;
    afirmar(precio?.amount === "3.00000000", `el precio quedó en ${precio?.amount}`);
  },
);

const tasaGeneral = async () => {
  const r = await pedir(PERSONAS.duenoE2E3, "E2", "GET", "/v1/fiscal/setup");
  afirmar(r.status === 200, `GET /v1/fiscal/setup: ${r.status}`);
  return r.json.iva_general?.rate ?? null;
};

c.caso("B-02", "dueño de E2 acepta 0 % → 422 «0 % no es una alícuota general»", async () => {
  const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/fiscal/iva-general", { rate: "0" });
  afirmar(r.status === 422, `esperaba 422, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
  afirmar(/0 % no es una alícuota general/.test(r.json?.message ?? ""), r.json?.message);
});

c.caso(
  "B-02",
  "dueño de E2 acepta 0.15 → la regla vigente pasa a 0.15 (y se deja en 0.16)",
  async () => {
    const antes = await tasaGeneral();
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/fiscal/iva-general", {
      rate: "0.15",
    });
    afirmar(r.status === 201, `aceptar 0.15: ${r.status}: ${r.texto.slice(0, 200)}`);
    // Lo que solo produce el arreglo: la regla que resuelve la empresa, no solo el acta.
    const ahora = await tasaGeneral();
    // Se devuelve el escenario a su tasa (el mismo día: la del 15 % queda inactiva, con historia).
    const vuelta = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/fiscal/iva-general", {
      rate: "0.16",
    });
    afirmar(vuelta.status === 201, `volver a 0.16: ${vuelta.status}`);
    afirmar(
      ahora === "0.15000000",
      `tras aceptar 0.15 la regla vigente es ${ahora} (antes ${antes})`,
    );
    afirmar((await tasaGeneral()) === "0.16000000", "no volvió a 0.16");
  },
);

c.caso(
  "B-04",
  "E2 resuelve la reducida (8 %), la adicional (16 % + 15 %) y la exenta con su cita",
  async () => {
    const esperado = {
      gravado_reducida: "0.08000000",
      gravado_adicional: "0.31000000",
      exento: "0.00000000",
    };
    for (const [cat, tasa] of Object.entries(esperado)) {
      const [r] = await sql`
      select rate::text as rate, legal_source
        from platform.resolve_tax(${EMPRESAS.E2}, (now() at time zone 'America/Caracas')::date,
                                  'VE', 'iva', 'ordinario', ${cat})`;
      afirmar(r?.rate === tasa, `${cat}: ${r?.rate}, esperaba ${tasa}`);
      afirmar(/LIVA art/.test(r.legal_source), `${cat} sin cita: ${r.legal_source}`);
    }
  },
);

c.caso(
  "B-04",
  "lo pendiente de fuente (no sujeto) y lo exonerado no se ofrecen al clasificar",
  async () => {
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "GET", "/v1/tax-categories");
    afirmar(r.status === 200, `GET /v1/tax-categories: ${r.status}`);
    const ofrecidas = r.json
      .filter((t) => t.offered_in_sales)
      .map((t) => t.code)
      .sort();
    afirmar(
      JSON.stringify(ofrecidas) ===
        // La reducida no se ofrece mientras la lista cerrada del art. 64 esté vacía (hallazgo 10).
        JSON.stringify(["exento", "gravado_adicional", "gravado_general"]),
      `ofrecidas: ${ofrecidas.join(", ")}`,
    );
  },
);

c.caso(
  "B-11",
  "la puesta a punto trae la general del catálogo con su cita; la web no escribe «16 %»",
  async () => {
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "GET", "/v1/fiscal/setup");
    afirmar(
      r.json?.iva_catalog?.rate === "0.16000000",
      `catálogo: ${JSON.stringify(r.json?.iva_catalog)}`,
    );
    afirmar(
      /Decreto N\.º 4\.079/.test(r.json.iva_catalog.legal_source),
      r.json.iva_catalog.legal_source,
    );
    const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const fuente = fs.readFileSync(
      path.join(raiz, "apps", "web", "src", "components", "capa-fiscal", "IvaQueCobras.tsx"),
      "utf8",
    );
    afirmar(!/16[\s\u00a0]*%|"16"/.test(fuente), "IvaQueCobras.tsx sigue escribiendo un 16 fijo");
  },
);

// ── Ola 2 · B-08: «formas libres», no «formatos libres» (PA 00071 arts. 6, 30 y 31) ─
c.caso(
  "B-08",
  "el régimen se llama «Formas libres» en la puesta a punto de E2, y /empezar lo dice igual",
  async () => {
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "GET", "/v1/fiscal/setup");
    afirmar(r.status === 200, `setup: ${r.status}`);
    const reg = (r.json?.regimes ?? []).find((x) => x.code === "formatos_libres");
    afirmar(reg?.name === "Formas libres", `nombre del régimen: ${reg?.name}`);
    const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const empezar = fs.readFileSync(
      path.join(raiz, "apps/web/src/pages/negocio/Empezar.tsx"),
      "utf8",
    );
    afirmar(!/formatos libres/i.test(empezar), "/empezar sigue diciendo «formatos libres»");
  },
);

// ── B-07 (ADR-0072 §1): «especial» tiene vigencia; no rige hacia atrás ──
c.caso("B-07", "E3 es especial desde el 24/09 y no el 23/09: la vigencia manda", async () => {
  const [f] = await sql`
    select platform.taxpayer_type_at(${EMPRESAS.E3}, '2026-09-23') as antes,
           platform.taxpayer_type_at(${EMPRESAS.E3}, '2026-09-24') as desde,
           platform.taxpayer_type_at(${EMPRESAS.E2}, '2026-09-24') as e2`;
  afirmar(f.antes === null && f.desde === "especial" && f.e2 === "ordinario", JSON.stringify(f));
});
c.caso("B-07", "la historia es append-only: un UPDATE es LAD06", async () => {
  let codigo = null;
  try {
    await sql`update public.company_taxpayer_types set reason = 'x' where company_id = ${EMPRESAS.E3}`;
  } catch (e) {
    codigo = e.code;
  }
  afirmar(codigo === "LAD06", `dio ${codigo}`);
});

export default c.correr;

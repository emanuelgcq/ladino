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

// ── Ola 4 · B-09, B-10, B-12: el asistente de /empezar (texto y forma: se mira la fuente) ──
const fuenteWeb = (ruta) =>
  fs.readFileSync(
    path.join(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
      "apps/web/src",
      ruta,
    ),
    "utf8",
  );

c.caso("B-09", "la tasa «se actualiza sola»: /empezar ya no dice «Un toque al día»", async () => {
  const empezar = fuenteWeb("pages/negocio/Empezar.tsx");
  afirmar(!/Un toque al día/.test(empezar), "/empezar sigue diciendo «Un toque al día»");
  afirmar(/Se actualiza sola/.test(empezar), "/empezar ya no dice «Se actualiza sola»");
});

// La lógica de `pasoInicial` la ejerce el unitario `apps/web/test/empezar-paso.test.ts` (el runner
// no carga TypeScript de la web); aquí se comprueba que la pantalla la usa.
c.caso("B-10", "/empezar recuerda el paso: arranca donde iba, no siempre en el 1", async () => {
  const empezar = fuenteWeb("pages/negocio/Empezar.tsx");
  afirmar(!/useState\(0\)/.test(empezar), "el paso sigue naciendo en useState(0)");
  afirmar(
    /pasoInicial\(window\.location\.search, pasoGuardado\(empresa\.id\)\)/.test(empezar),
    "el paso inicial no sale de lo recordado",
  );
  afirmar(/recordarPaso\(empresa\.id, i\)/.test(empezar), "cambiar de paso no lo recuerda");
  const paso = fuenteWeb("pages/negocio/empezar-paso.ts");
  afirmar(/sessionStorage/.test(paso), "el paso no se guarda por pestaña");
});

c.caso("B-12", "el paso 4 de /empezar dice que está cargando: no queda en blanco", async () => {
  const empezar = fuenteWeb("pages/negocio/Empezar.tsx");
  afirmar(
    /paso === 3 && fiscal\.isPending/.test(empezar),
    "el paso 4 no pinta nada mientras /v1/fiscal/setup responde",
  );
});

// ── Ola 4 · actas, origen y versión de reglas (RESPUESTA §2.15, ADR-0079): B-05, B-06, B-14 ──
const raizActas = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fuenteActas = (...ruta) => fs.readFileSync(path.join(raizActas, ...ruta), "utf8");
const versionVigente = async (empresa) => {
  const [v] = await sql`select version from platform.current_rules_version(${empresa})`;
  return v.version;
};

c.caso(
  "B-05",
  "dueño de E2 carga un talonario → acta fiscal.range.registered con canal, build y versión registrada",
  async () => {
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/fiscal-number-ranges", {
      company_id: EMPRESAS.E2,
      series: "ZA",
      printer_identifier: "77",
      range_from: "900001",
      range_to: "900010",
      printer_legal_name: "Gráficas de la Verificación, C.A.",
      printer_tax_id: "J-12345678-9",
      printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
      printer_authorization_date: "2020-01-15",
      printed_on: "2026-09-01",
    });
    afirmar(r.status === 201, `registrar: ${r.status}: ${r.texto.slice(0, 200)}`);
    const actas = await sql`
      select a.channel, a.app_build, a.rules_version, a.created_by,
             exists (select 1 from platform.rules_versions v where v.version = a.rules_version)
               as registrada
        from public.audit_events a
       where a.company_id = ${EMPRESAS.E2} and a.event_type = 'fiscal.range.registered'
         and a.aggregate_id = ${r.json.id}`;
    // Se retira el papel de prueba antes de afirmar: el escenario queda como estaba.
    const anulado = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "POST",
      `/v1/fiscal-number-ranges/${r.json.id}/cancel`,
      { company_id: EMPRESAS.E2, reason: "Talonario de la verificación B-05: no es papel real" },
    );
    afirmar(anulado.status === 200, `anular: ${anulado.status}: ${anulado.texto.slice(0, 200)}`);
    afirmar(actas.length === 1, `actas del talonario: ${actas.length} (antes del arreglo, 0)`);
    const [a] = actas;
    afirmar(a.created_by !== null, "el acta no dice quién");
    // A-16: el origen lo puso el middleware, no el caso de uso.
    afirmar(a.channel === "api", `canal: ${a.channel}`);
    afirmar(/^api@/.test(a.app_build ?? ""), `build: ${a.app_build}`);
    // B-06: una versión registrada, no la cadena fija.
    afirmar(a.registrada && a.rules_version !== "domain-s0.5", `versión: ${a.rules_version}`);
  },
);

c.caso(
  "B-06",
  "una regla nueva de E2 cambia la versión de reglas de E2 y no la de E3 (en una transacción que se revierte)",
  async () => {
    // La aceptación en pantalla ES un insert en tax_rules con la empresa (fiscal-setup.ts): se
    // hace aquí el mismo insert dentro de una transacción que se revierte, para no depender de
    // si hoy ya se facturó en E2 (la API rechaza cambiar la alícuota el mismo día).
    class Reversa extends Error {}
    const antes = { e2: await versionVigente(EMPRESAS.E2), e3: await versionVigente(EMPRESAS.E3) };
    let tras = null;
    await sql
      .begin(async (tx) => {
        await tx`
          insert into public.tax_rules
            (jurisdiction, tax_code, transaction_type, product_tax_category, rate, effective_from,
             legal_source, priority, status, tenant_id, company_id)
          select 'VE', 'iva', 'sale', 'exento', 0, platform.caracas_day(now()) + 1,
                 'Verificación B-06: regla de prueba, se revierte', 5, 'active', e.tenant_id, e.id
            from public.companies e where e.id = ${EMPRESAS.E2}`;
        const [e2] = await tx`select version from platform.current_rules_version(${EMPRESAS.E2})`;
        const [e3] = await tx`select version from platform.current_rules_version(${EMPRESAS.E3})`;
        tras = { e2: e2.version, e3: e3.version };
        throw new Reversa();
      })
      .catch((e) => {
        if (!(e instanceof Reversa)) throw e;
      });
    afirmar(/^\d+\.\d+\.\d+\+[0-9a-f]{16}$/.test(antes.e2), `forma de la versión: ${antes.e2}`);
    afirmar(tras.e2 !== antes.e2, `la versión de E2 no cambió: ${antes.e2}`);
    afirmar(tras.e3 === antes.e3, `la versión de E3 cambió: ${antes.e3} → ${tras.e3}`);
    afirmar(
      (await versionVigente(EMPRESAS.E2)) === antes.e2,
      "la regla de prueba no se revirtió: la versión de E2 quedó cambiada",
    );
    // Y sin now() dentro: dos cálculos seguidos, la misma versión.
    afirmar((await versionVigente(EMPRESAS.E3)) === antes.e3, "la versión no es determinista");
  },
);

c.caso(
  "B-14",
  "la tasa oficial solo se guarda por guardarTasaOficial, que deja el acta de plataforma",
  async () => {
    const dominio = fuenteActas("packages", "domain", "src", "tasa-oficial.ts");
    afirmar(
      /insert into public\.system_audit_events/.test(dominio) &&
        /'fx\.rate\.captured'/.test(dominio) &&
        /source_url/.test(dominio) &&
        /captured_at/.test(dominio) &&
        /response_sha256/.test(dominio),
      "guardarTasaOficial no deja el acta con URL, hora de captura y hash",
    );
    for (const ruta of [
      ["apps", "api", "src", "tasa-oficial.ts"],
      ["apps", "api", "src", "routes", "sales.ts"],
    ]) {
      const f = fuenteActas(...ruta);
      afirmar(/guardarTasaOficial\(/.test(f), `${ruta.at(-1)} no guarda por guardarTasaOficial`);
      afirmar(
        !/insert into public\.exchange_rates/.test(f),
        `${ruta.at(-1)} sigue insertando la tasa por su cuenta, sin acta`,
      );
    }
    // Y el acta es de verdad append-only y de sistema: lo dice la base.
    const [t] = await sql`
      select count(*)::int as n from pg_trigger
       where tgrelid = 'public.system_audit_events'::regclass and not tgisinternal
         and tgfoid = 'platform.reject_mutation'::regproc`;
    afirmar(t.n === 2, `system_audit_events tiene ${t.n} triggers de append-only (esperaba 2)`);
  },
);

export default c.correr;

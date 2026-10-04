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

// A-07 (ola 3): el logo se autoriza ANTES de tocar el almacenamiento. Sin Storage en el recorrido,
// antes llegaba al 422 «no tiene almacenamiento» (el permiso se miraba después); ahora, 403.
c.caso("A-07", "el cajero sube el logo de E2 → 403 antes de cualquier escritura", async () => {
  const r = await pedir(PERSONAS.cajero, "E2", "POST", "/v1/companies/logo", {});
  afirmar(r.status === 403, `esperaba 403, llegó ${r.status}: ${r.texto.slice(0, 160)}`);
});
// A-14 (ola 3): la purga nunca ofrece el logo vigente.
c.caso(
  "A-14",
  "company_logo_purgeable no ofrece ningún objeto del logo vigente de E2",
  async () => {
    const filas = await sql.begin(async (tx) => {
      const [d] = await tx`select id from auth.users where email = ${PERSONAS.duenoE2E3}`;
      await tx`select set_config('ladino.actor_id', ${d.id}, true)`;
      return tx`
      select o.object_name from platform.company_logo_purgeable(${EMPRESAS.E2}) o
        join public.companies c on c.id = ${EMPRESAS.E2}
       where c.logo_path is not null
         and o.object_name like regexp_replace(c.logo_path, '/[^/]+$', '') || '/%'`;
    });
    afirmar(filas.length === 0, `ofrece el vigente: ${filas.map((f) => f.object_name).join(", ")}`);
  },
);

// ── ADR-0077 §2 (A-13): crear otra empresa desde dentro ─────────────────────────────────────────
// Sin escribir nada en el escenario: el dueño de E2 pide «otra» con el nombre de su propio negocio
// (la clave natural responde 409 legible) y el cajero, que no es Titular de ninguna cuenta, 403.
c.caso(
  "A-13",
  "«Crear otra empresa» existe: el Titular choca con su clave natural, el cajero no es Titular",
  async () => {
    const [t] = await sql`
      select t.name from public.tenants t join public.companies c on c.tenant_id = t.id
       where c.id = ${EMPRESAS.E2}`;
    const mismo = await pedir(PERSONAS.duenoE2E3, null, "POST", "/v1/onboarding/another-company", {
      business_name: t.name.toUpperCase(),
    });
    afirmar(mismo.status === 409, `el Titular con el mismo nombre dio ${mismo.status}`);
    afirmar(
      mismo.json?.message?.includes("Ya tienes un negocio con ese nombre"),
      `mensaje: ${mismo.json?.message}`,
    );
    const cajero = await pedir(PERSONAS.cajero, null, "POST", "/v1/onboarding/another-company", {
      business_name: "Negocio del cajero",
    });
    afirmar(cajero.status === 403, `el cajero dio ${cajero.status}`);
    afirmar(cajero.json?.message?.includes("Titular"), `mensaje: ${cajero.json?.message}`);
  },
);

// ── Ola 4 · el registro: A-01, A-02, A-04, A-05, A-09 y A-12 ────────────────────────────────────
// Ninguna comprobación escribe en el escenario. Lo que es texto o forma del asistente se mira en
// la fuente (regla de la ola: en lo que es solo texto o forma, la fuente vale como test); lo que
// decide el servidor, por la API.
import fs from "node:fs";
const fuente = (rel) => fs.readFileSync(path.join(RAIZ, ...rel.split("/")), "utf8");

c.caso("A-12", "la bienvenida dice «Te toma unos minutos», sin número", async () => {
  const registro = fuente("apps/web/src/pages/registro/Registro.tsx");
  afirmar(registro.includes("Te toma unos minutos."), "falta «Te toma unos minutos»");
  afirmar(
    !/menos de dos minutos|\d+\s+minutos/.test(registro),
    "la bienvenida sigue dando un número",
  );
});

c.caso(
  "A-09",
  'toda opción del asistente es type="button": elegir marca, «Continuar» avanza',
  async () => {
    const registro = fuente("apps/web/src/pages/registro/Registro.tsx");
    // Cada <button> del asistente que es una opción (role="radio"): sus atributos, del «<button»
    // a su className. (Una expresión con [^>] no vale: los atributos llevan flechas «=>».)
    const opciones = registro
      .split("<button")
      .slice(1)
      .map((t) => t.slice(0, t.indexOf("className=")))
      .filter((t) => t.includes('role="radio"'));
    afirmar(opciones.length >= 2, `esperaba los grupos de rubro y de RIF, hay ${opciones.length}`);
    for (const o of opciones) {
      afirmar(/type="button"/.test(o), `una opción es submit y avanza sola: ${o.slice(0, 120)}`);
      afirmar(!/onDoubleClick/.test(o), "una opción avanza con doble clic y las demás no");
    }
  },
);

c.caso(
  "A-01",
  "el registro mira el resultado de subir el logo y, si no quedó, lo dice antes de entrar",
  async () => {
    const registro = fuente("apps/web/src/pages/registro/Registro.tsx");
    afirmar(
      /logoGuardado = subida !== null && subida\.ok/.test(registro),
      "la subida del logo sigue sin mirar el status",
    );
    // La subida se ASIGNA (antes era un `await fetch(…).catch(() => null)` suelto).
    const subidas = registro.split("/v1/companies/logo`").length - 1;
    afirmar(
      subidas === 1 &&
        registro.includes("const subida = await fetch(`${API_URL}/v1/companies/logo`"),
      "el resultado de la subida se sigue descartando",
    );
    afirmar(
      registro.includes("el logo no se pudo guardar") &&
        registro.includes("el logo que elegiste no se guardó"),
      "falta el aviso del logo que no quedó (fallo de la subida y negocio que ya existía)",
    );
    afirmar(/role="alert"[\s\S]{0,300}\{sinLogo\.texto\}/.test(registro), "el aviso no se pinta");
    // Los TRES caminos en que el logo elegido no queda: la subida falla, el negocio ya existía
    // (registro) y el negocio ya existía («Crear otra empresa»).
    const avisos = registro.split("setSinLogo({").length - 1;
    afirmar(avisos === 3, `esperaba el aviso en tres caminos, está en ${avisos}`);
  },
);

c.caso(
  "A-04",
  "la sonda es solo del menú: ninguna pantalla decide «hay contabilidad» con ella, y se repite tras emitir",
  async () => {
    const paginas = path.join(RAIZ, "apps", "web", "src", "pages");
    const conLaSonda = fs
      .readdirSync(paginas, { recursive: true })
      .filter((f) => /\.tsx?$/.test(String(f)))
      .filter((f) =>
        fs.readFileSync(path.join(paginas, String(f)), "utf8").includes("useModulosActivos"),
      );
    afirmar(conLaSonda.length === 0, `usan la sonda del menú: ${conLaSonda.join(", ")}`);
    for (const rel of ["pages/ventas/DetalleFactura.tsx", "pages/Dashboard.tsx"]) {
      afirmar(
        fuente(`apps/web/src/${rel}`).includes("useContabilidadConfigurada()"),
        `${rel} no pregunta por la contabilidad configurada`,
      );
    }
    for (const [rel, hecho] of [
      ["pages/negocio/Vender.tsx", 'refrescarModulos(conFacturas ? "factura" : "recibo")'],
      ["pages/ventas/NuevaFactura.tsx", 'refrescarModulos("factura")'],
      ["pages/contabilidad/Contabilidad.tsx", 'refrescarModulos("asiento")'],
    ]) {
      afirmar(fuente(`apps/web/src/${rel}`).includes(hecho), `${rel} no repite la sonda`);
    }
  },
);

c.caso(
  "A-02",
  "«Facturas legales desde tu primer talonario», y el alta con RIF aterriza en el paso de las facturas",
  async () => {
    const registro = fuente("apps/web/src/pages/registro/Registro.tsx");
    afirmar(registro.includes("Facturas legales desde tu primer talonario."), "falta el texto");
    afirmar(!registro.includes("desde el primer día"), "sigue prometiendo «desde el primer día»");
    afirmar(
      registro.includes('conRif ? "/empezar?paso=facturas" : "/empezar"'),
      "el alta con RIF no aterriza en el paso de las facturas",
    );
    // /empezar abre el paso que le piden por nombre (la función es de B-10: empezar-paso.ts).
    const empezar = fuente("apps/web/src/pages/negocio/Empezar.tsx");
    const pasos = fuente("apps/web/src/pages/negocio/empezar-paso.ts");
    afirmar(
      empezar.includes("pasoInicial(window.location.search") &&
        pasos.includes('.get("paso")') &&
        /facturas:\s*3/.test(pasos),
      "/empezar no abre el paso de las facturas con ?paso=facturas",
    );
  },
);

c.caso(
  "A-02",
  "la caja con RIF y sin talonario con papel está en pausa; E2 y E3, con talonario, venden",
  async () => {
    const vender = fuente("apps/web/src/pages/negocio/Vender.tsx");
    afirmar(
      vender.includes("{pausa !== null && <CajaEnPausa motivo={pausa} />}"),
      "la caja no pinta la pausa",
    );
    afirmar(/!excedeForma &&\s+pausa === null;/.test(vender), "«Cobrar» se ofrece en pausa");
    // Los dos datos que lee la pausa, de la API real: el escenario tiene papel y no se pausa. La
    // regla misma (sin régimen, sin papel, sin imprenta) la prueba apps/web/test/caja-en-pausa.
    for (const e of ["E2", "E3"]) {
      const setup = await pedir(PERSONAS.duenoE2E3, e, "GET", "/v1/fiscal/setup");
      const rangos = await pedir(PERSONAS.duenoE2E3, e, "GET", "/v1/fiscal-number-ranges");
      afirmar(
        setup.status === 200 && rangos.status === 200,
        `${e}: ${setup.status}/${rangos.status}`,
      );
      afirmar(
        setup.json.current_regime === "formatos_libres",
        `${e}: ${setup.json.current_regime}`,
      );
      const conPapel = rangos.json.filter(
        (r) =>
          r.status === "active" && r.remaining > 0 && !r.is_contingency && r.printer_data_complete,
      );
      afirmar(conPapel.length > 0, `${e} no tiene talonario listo: la caja quedaría en pausa`);
    }
  },
);

c.caso(
  "A-04",
  "la sonda del menú pregunta por DATOS (asiento posteado, factura), no por el plan de cuentas",
  async () => {
    // Solo el cuerpo de la sonda del MENÚ: el mismo fichero tiene la pregunta de las pantallas
    // (`sondearContabilidadConfigurada`), que sí mira el plan de cuentas, y con razón.
    const fichero = fuente("apps/web/src/app/modulos-activos.ts");
    const desde = fichero.indexOf("export async function sondearModulosActivos");
    const hasta = fichero.indexOf("\n}\n", desde);
    afirmar(desde >= 0 && hasta > desde, "no encuentro sondearModulosActivos");
    const sonda = fichero.slice(desde, hasta);
    afirmar(!sonda.includes("/v1/accounts"), "la sonda sigue mirando el plan de cuentas");
    afirmar(
      sonda.includes("/v1/journal-entries?status=posted&per_page=1") &&
        sonda.includes("/v1/documents?kind=invoice&per_page=1"),
      "la sonda no pregunta por el asiento posteado y la factura",
    );
    // Las dos preguntas de la sonda responden con `total`, y coinciden con la base.
    for (const e of ["E1", "E2"]) {
      const quien = e === "E1" ? PERSONAS.duenaE1 : PERSONAS.duenoE2E3;
      const asientos = await pedir(quien, e, "GET", "/v1/journal-entries?status=posted&per_page=1");
      const facturas = await pedir(quien, e, "GET", "/v1/documents?kind=invoice&per_page=1");
      const [base] = await sql`
        select (select count(*)::int from public.journal_entries
                 where company_id = ${EMPRESAS[e]} and status = 'posted') as asientos,
               (select count(*)::int from public.documents
                 where company_id = ${EMPRESAS[e]} and kind = 'invoice') as facturas`;
      afirmar(asientos.status === 200 && asientos.json.total === base.asientos, `${e} asientos`);
      afirmar(facturas.status === 200 && facturas.json.total === base.facturas, `${e} facturas`);
    }
    // El cajero no lee el diario: 403, que la sonda lee como «este módulo no es tuyo».
    const cajero = await pedir(PERSONAS.cajero, "E2", "GET", "/v1/journal-entries?status=posted");
    afirmar(cajero.status === 403, `el cajero leyó el diario: ${cajero.status}`);
  },
);

c.caso(
  "A-04",
  "/v1/me/permissions dice el rol: el contador es «accountant»; el dueño y el cajero, no",
  async () => {
    const contador = await pedir(PERSONAS.contador, "E2", "GET", "/v1/me/permissions");
    afirmar(contador.status === 200, `contador: ${contador.status}`);
    afirmar(contador.json.roles?.includes("accountant"), JSON.stringify(contador.json.roles));
    const dueno = await pedir(PERSONAS.duenoE2E3, "E2", "GET", "/v1/me/permissions");
    afirmar(
      dueno.json.roles?.includes("owner") && !dueno.json.roles.includes("accountant"),
      JSON.stringify(dueno.json.roles),
    );
    const cajero = await pedir(PERSONAS.cajero, "E2", "GET", "/v1/me/permissions");
    afirmar(
      cajero.json.roles?.includes("cashier") && !cajero.json.roles.includes("accountant"),
      JSON.stringify(cajero.json.roles),
    );
  },
);

c.caso(
  "A-05",
  "con RIF ya puesto, la razón social no entra por la puerta del RIF: 422 y nada cambia",
  async () => {
    // El primer RIF SIN razón social (422) y con ella (queda guardada, con acta) lo prueba
    // apps/api/test/e2e-el-primer-rif-y-el-rol.test.ts: aquí no se le pone RIF a nadie.
    const [antes] = await sql`
      select tax_id, legal_name from public.companies where id = ${EMPRESAS.E2}`;
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "PUT", "/v1/companies/tax-id", {
      tax_id: antes.tax_id,
      legal_name: "Otra Razón Social, C.A.",
    });
    afirmar(r.status === 422, `dio ${r.status}`);
    afirmar(
      String(r.json?.message).includes("La razón social se cambia en «Editar»"),
      `mensaje: ${r.json?.message}`,
    );
    const [despues] = await sql`
      select tax_id, legal_name from public.companies where id = ${EMPRESAS.E2}`;
    afirmar(
      despues.tax_id === antes.tax_id && despues.legal_name === antes.legal_name,
      "la empresa cambió",
    );
    const dialogo = fuente("apps/web/src/pages/configuracion/MiEmpresa.tsx");
    afirmar(
      dialogo.includes('label="Razón social"') && dialogo.includes("legal_name: razon.trim()"),
      "«Poner mi RIF» no pide ni envía la razón social",
    );
  },
);

// ── Ola 4 · A-16 (RESPUESTA §2.15): el acta guarda de dónde vino, y lo pone el middleware ─────
c.caso(
  "A-16",
  "el origen lo aterriza withTransaction desde el middleware; ninguna ruta devuelve ip ni user-agent",
  async () => {
    const tx = fuente("packages/db/src/transaction.ts");
    afirmar(
      /set_config\('ladino\.origin_channel'/.test(tx) && /set_config\('ladino\.origin_ip'/.test(tx),
      "withTransaction no aterriza el origen",
    );
    const appTs = fuente("apps/api/src/app.ts");
    afirmar(/originMiddleware\(/.test(appTs), "la API no monta el middleware de origen");
    // Ningún caso de uso lo pasa: el dominio no nombra esas columnas.
    const dir = path.join(RAIZ, "packages", "domain", "src");
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const t = fs.readFileSync(path.join(dir, f), "utf8");
      afirmar(!/ladino\.origin_|\buser_agent\b/.test(t), `${f} toca el origen del acta`);
    }
    // Privacidad: ninguna ruta lee audit_events (ni, por tanto, su ip o su user-agent).
    const rutas = path.join(RAIZ, "apps", "api", "src", "routes");
    for (const f of fs.readdirSync(rutas).filter((n) => n.endsWith(".ts"))) {
      const t = fs.readFileSync(path.join(rutas, f), "utf8");
      afirmar(
        !/from public\.audit_events[\s\S]{0,400}\b(ip|user_agent)\b/.test(t) &&
          !/\buser_agent\b/.test(t),
        `${f} devuelve datos del origen de un acta`,
      );
    }
    // Y en la base: todo acta escrita desde la migración DEL CANAL lleva canal (cero sin él).
    // La referencia es el instante en que se aplicó la 20261004120000, que es la que añade la
    // columna y su trigger: lo guarda la fila 1.0.0 de platform.rules_releases, que inserta esa
    // misma migración. NO el corte de rules_version_gaps: ese invariante mide otra cosa y su
    // corte se movió a la 20261004205000. Sin referencia el caso falla: comparar contra NULL
    // daría cero filas y un verde que no mide nada.
    const [ref] = await sql`
      select (select released_at from platform.rules_releases where semver = '1.0.0') as desde`;
    afirmar(
      ref.desde !== null,
      "no hay fila 1.0.0 en platform.rules_releases: no se sabe desde cuándo exigir el canal",
    );
    const [sin] = await sql`
      select count(*)::int as n,
             (select count(*)::int from public.audit_events
               where created_at >= ${ref.desde}) as medidas
        from public.audit_events
       where channel is null and created_at >= ${ref.desde}`;
    afirmar(
      sin.medidas > 0,
      "ningún acta posterior a la migración del canal: el caso no mide nada",
    );
    afirmar(sin.n === 0, `${sin.n} actas posteriores a la migración del canal sin canal`);
  },
);

export default c.correr;

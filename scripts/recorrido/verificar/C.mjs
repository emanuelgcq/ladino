/**
 * Bloque C · Catálogo e importación. Comprobaciones de `pnpm recorrido C` (ver `_app.mjs`).
 *
 * ADR-0074 (la importación es un trabajo, no una petición):
 *   C-01: la importación leía «0.500» como 500 y «0.125» como 125, y terminaba en verde. Ahora,
 *         con el formato venezolano (el de omisión), la fila se rechaza como AMBIGUA con su número.
 *   C-04: una importación grande agotaba la petición y al reintentar duplicaba. Ahora la petición
 *         crea un TRABAJO; el mismo archivo devuelve el mismo trabajo y procesarlo no duplica.
 *   C-05: la existencia de un servicio se descartaba en silencio. Ahora sale como aviso en la
 *         vista previa.
 *
 * `_app.mjs` solo habla JSON; la importación es multipart, así que este bloque firma su propio
 * token con el mismo secreto de desarrollo y llama a la MISMA `app` en proceso.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { comprobaciones, afirmar, app, sql, EMPRESAS, PERSONAS } from "./_app.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const desdeApi = createRequire(path.join(RAIZ, "apps", "api", "package.json"));
const { SignJWT } = await import(pathToFileURL(desdeApi.resolve("jose")).href);
const { createClient } = await import(pathToFileURL(desdeApi.resolve("@ladino/db")).href);
const { procesarTrabajoImportacion } = await import(
  pathToFileURL(desdeApi.resolve("@ladino/domain")).href
);
const sqlApi = createClient("postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres");

const SECRETO = new TextEncoder().encode("super-secret-jwt-token-with-at-least-32-characters-long");
const EMISOR = "http://127.0.0.1:54321/auth/v1";
const TITULOS =
  "Nombre,Precio,Moneda,Código,Código de barras,Categoría,Existencia,Costo,Moneda costo,Es servicio";

async function idDe(correo) {
  const [fila] = await sql`select id from auth.users where email = ${correo}`;
  afirmar(fila, `no existe ${correo} en el escenario`);
  return fila.id;
}

/** Sube `csv` como multipart a `ruta`, como `correo`, en la empresa `empresa`. */
async function subir(correo, empresa, ruta, csv, numberFormat) {
  const token = await new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(await idDe(correo))
    .setIssuer(EMISOR)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(SECRETO);
  const form = new FormData();
  form.append("file", new File([csv], "recorrido.csv", { type: "text/csv" }));
  if (numberFormat) form.append("number_format", numberFormat);
  const r = await app.request(ruta, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Company-Id": EMPRESAS[empresa],
      // H4: confirmar exige Idempotency-Key; una llave por intento.
      ...(ruta.endsWith("/jobs") ? { "Idempotency-Key": crypto.randomUUID() } : {}),
    },
    body: form,
  });
  const texto = await r.text();
  let json = null;
  try {
    json = JSON.parse(texto);
  } catch {
    /* no JSON */
  }
  return { status: r.status, json, texto };
}

const c = comprobaciones("C");

c.caso(
  "C-01",
  "E3 · «Arandela plana 1/4,0.500,…,0.125» con el formato venezolano → rechazada como ambigua",
  async () => {
    const csv = `${TITULOS}\r\nArandela plana 1/4,0.500,USD,ARA-14,,Tornillería,1,0.125,USD,no\r\n`;
    const previa = await subir(PERSONAS.duenoE2E3, "E3", "/v1/products/import/preview", csv);
    afirmar(
      previa.status === 200,
      `la vista previa dio ${previa.status}: ${previa.texto.slice(0, 200)}`,
    );
    afirmar(
      previa.json.number_format === "comma_decimal",
      "el formato por omisión no es el venezolano",
    );
    const fila = previa.json.rows[0];
    afirmar(fila.row === 2 && fila.status === "rejected", `la fila 2 quedó ${fila.status}`);
    afirmar(fila.message.includes("ambiguo"), `el motivo no dice «ambiguo»: ${fila.message}`);
    // Y por el camino de siempre: la fila no entra como 500.
    const vieja = await subir(PERSONAS.duenoE2E3, "E3", "/v1/products/import", csv);
    afirmar(vieja.status === 201, `/v1/products/import dio ${vieja.status}`);
    afirmar(
      vieja.json.created === 0,
      `el camino de siempre creó ${vieja.json.created} producto(s)`,
    );
    // «0,500» con el mismo formato sí es 0,5.
    const bien = await subir(
      PERSONAS.duenoE2E3,
      "E3",
      "/v1/products/import/preview",
      `${TITULOS}\r\nArandela plana 1/4,"0,500",USD,ARA-14,,Tornillería,1,"0,125",USD,no\r\n`,
    );
    afirmar(
      bien.json.rows[0].price.amount === "0.5",
      `«0,500» dio ${bien.json.rows[0].price?.amount}`,
    );
  },
);

c.caso(
  "C-05",
  "E2 · «Transporte especial … 10 … sí» → la existencia del servicio sale como AVISO",
  async () => {
    const csv = `${TITULOS}\r\nTransporte especial,"50,00",USD,ERR-7,,Servicios,10,,,sí\r\n`;
    const previa = await subir(PERSONAS.duenoE2E3, "E2", "/v1/products/import/preview", csv);
    afirmar(
      previa.status === 200,
      `la vista previa dio ${previa.status}: ${previa.texto.slice(0, 200)}`,
    );
    const fila = previa.json.rows[0];
    afirmar(fila.status === "ready", `la fila quedó ${fila.status}: ${fila.message}`);
    afirmar(!fila.initial_stock, "el servicio trae existencia");
    const avisos = fila.warnings.join(" ");
    afirmar(avisos.includes("servicio") && avisos.includes("existencia"), `sin aviso: «${avisos}»`);
  },
);

c.caso(
  "C-04",
  "E2 · el mismo archivo dos veces → el MISMO trabajo; procesarlo y reimportar no duplica",
  async () => {
    // Contenido FIJO: correr el recorrido dos veces sobre la misma base reutiliza el trabajo.
    const csv = `${TITULOS}\r\nProducto del recorrido C-04,"1,00",USD,REC-C04,,Recorrido,,,,no\r\n`;
    const a = await subir(PERSONAS.duenoE2E3, "E2", "/v1/products/import/jobs", csv);
    afirmar(
      a.status === 202 || a.status === 200,
      `crear el trabajo dio ${a.status}: ${a.texto.slice(0, 200)}`,
    );
    const b = await subir(PERSONAS.duenoE2E3, "E2", "/v1/products/import/jobs", csv);
    afirmar(
      b.status === 200 && b.json.reused === true,
      `el reintento dio ${b.status} reused=${b.json?.reused}`,
    );
    afirmar(b.json.id === a.json.id, "el reintento creó un segundo trabajo");
    await procesarTrabajoImportacion(sqlApi, a.json.id, await idDe(PERSONAS.duenoE2E3));
    await procesarTrabajoImportacion(sqlApi, a.json.id, await idDe(PERSONAS.duenoE2E3));
    const [t] = await sql`
      select status, processed_rows, created_count + updated_count as hechos
        from public.product_import_jobs where id = ${a.json.id}`;
    afirmar(
      t.status === "done" && t.processed_rows === 1,
      `el trabajo quedó ${t.status}/${t.processed_rows}`,
    );
    const [n] = await sql`
      select count(*)::int as n from public.products
       where company_id = ${EMPRESAS.E2} and sku = 'REC-C04'`;
    afirmar(n.n === 1, `hay ${n.n} productos REC-C04`);
  },
);

// C-09 (ola 3): la foto se autoriza (permiso y producto) ANTES de procesarla y subirla.
c.caso(
  "C-09",
  "foto a un producto inventado: cajero → 403 y dueño → 404, antes del almacenamiento",
  async () => {
    const { pedir } = await import("./_app.mjs");
    const inventado = crypto.randomUUID();
    const cajero = await pedir(
      PERSONAS.cajero,
      "E2",
      "POST",
      `/v1/products/${inventado}/image`,
      {},
    );
    afirmar(cajero.status === 403, `cajero: esperaba 403, llegó ${cajero.status}`);
    const dueno = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "POST",
      `/v1/products/${inventado}/image`,
      {},
    );
    afirmar(dueno.status === 404, `dueño: esperaba 404, llegó ${dueno.status}`);
  },
);

export default c.correr;

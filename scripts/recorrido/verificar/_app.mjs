/**
 * Andamiaje de las comprobaciones de `pnpm recorrido <B>` (verificar/<B>.mjs).
 *
 * La API corre EN PROCESO (el mismo `buildApp` que usan los E2E, desde `apps/api/dist`), contra la
 * base LOCAL restaurada, con tokens HS256 firmados con el secreto de desarrollo de Supabase local:
 * no hace falta levantar la API, la web ni el servicio de auth. Cada persona del escenario se
 * identifica por su correo; el token lleva su id real de `auth.users`.
 *
 * Una comprobación es el REPRODUCIR de un hallazgo cerrado, que ya no debe reproducir, o una de
 * «Lo que se comprobó y está bien», que debe seguir bien.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const desdeApi = createRequire(path.join(RAIZ, "apps", "api", "package.json"));
const { SignJWT } = await import(pathToFileURL(desdeApi.resolve("jose")).href);
const { createClient } = await import(pathToFileURL(desdeApi.resolve("@ladino/db")).href);
const { buildApp } = await import(
  pathToFileURL(path.join(RAIZ, "apps", "api", "dist", "app.js")).href
);

const SECRETO = new TextEncoder().encode("super-secret-jwt-token-with-at-least-32-characters-long");
const EMISOR = "http://127.0.0.1:54321/auth/v1";

export const sql = createClient("postgres://postgres:postgres@127.0.0.1:54322/postgres");
const sqlApi = createClient("postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres");
export const app = buildApp({
  sql: sqlApi,
  auth: { mode: "hs256", jwtSecret: SECRETO, issuer: EMISOR },
});

export const EMPRESAS = {
  E1: "01a0d547-9c92-7121-9d82-438e2e322415",
  E2: "01a0d548-82bb-783e-909e-643fc473d458",
  E3: "01a0d549-6587-703a-be13-da740c2750d3",
};
export const PERSONAS = {
  duenaE1: "bodega.esquina@example.com",
  duenoE2E3: "dueno.andina@example.com",
  registraE3: "tornillo@example.com",
  cajero: "cajero@example.com",
  encargado: "encargado@example.com",
  administrativo: "administrativo@example.com",
  contador: "contador@example.com",
  almacenista: "almacenista@example.com",
};

const ids = new Map();
async function idDe(correo) {
  if (!ids.has(correo)) {
    const [fila] = await sql`select id from auth.users where email = ${correo}`;
    if (!fila) throw new Error(`no existe ${correo} en el escenario`);
    ids.set(correo, fila.id);
  }
  return ids.get(correo);
}

/** Una llamada a la API como `correo`, en la empresa `empresa` (E1/E2/E3 o un uuid). */
/** `llave` (opcional, ADR-0076): la Idempotency-Key del intento, para los casos que la repiten. */
export async function pedir(correo, empresa, metodo, ruta, cuerpo, llave) {
  const token = await new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(await idDe(correo))
    .setIssuer(EMISOR)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(SECRETO);
  const headers = { Authorization: `Bearer ${token}` };
  const companyId = EMPRESAS[empresa] ?? empresa;
  if (companyId) headers["X-Company-Id"] = companyId;
  if (metodo !== "GET") headers["Idempotency-Key"] = llave ?? crypto.randomUUID();
  if (cuerpo !== undefined) headers["Content-Type"] = "application/json";
  const r = await app.request(ruta, {
    method: metodo,
    headers,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
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

/** Un GET que devuelve BYTES (un PDF): `pedir` lo leería como texto UTF-8 y lo estropearía. */
export async function pedirBytes(correo, empresa, ruta) {
  const token = await new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(await idDe(correo))
    .setIssuer(EMISOR)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(SECRETO);
  const r = await app.request(ruta, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, "X-Company-Id": EMPRESAS[empresa] ?? empresa },
  });
  return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
}

export function afirmar(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje);
}

/**
 * `const c = comprobaciones("N"); c.caso("N-01", "…", async () => {…}); export default c.correr;`
 * `correr()` devuelve el número de fallos, que suma al veredicto de `pnpm recorrido`.
 */
export function comprobaciones(bloque) {
  const casos = [];
  return {
    caso(id, descripcion, fn) {
      casos.push({ id, descripcion, fn });
    },
    async correr() {
      console.log(`· ${bloque}: ${casos.length} comprobación(es)`);
      let fallos = 0;
      for (const { id, descripcion, fn } of casos) {
        try {
          await fn();
          console.log(`  ✓ ${id} · ${descripcion}`);
        } catch (e) {
          fallos += 1;
          console.log(`  ✗ ${id} · ${descripcion}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Las conexiones se cierran al salir el proceso: varios bloques comparten este módulo.
      return fallos;
    },
  };
}

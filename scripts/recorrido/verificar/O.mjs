/**
 * Bloque O · Varias empresas. Comprobaciones de `pnpm recorrido O` (ver `_app.mjs`).
 *
 * O-04: «Elige la empresa» y «Cambiar de empresa» enseñaban el RIF crudo («J405551234»). Ahora
 *   `rifParaMostrar` (apps/web/src/app/rif.ts) delega en `formatearDocumento` de @ladino/schemas,
 *   la misma función de Mi empresa: aquí se aplica a la lista que esas pantallas reciben.
 *
 * NO LEE LA PANTALLA, y por eso el caso no dice que la cierra: este runner levanta la API en
 * proceso, sin web ni servicio de auth, y leer «Elige la empresa» con Playwright exige la web
 * (:5174), la API (:3000) y un inicio de sesión real (`scripts/recorrido/lib.mjs`). La pantalla la
 * cubre el unitario `apps/web/test/rif.test.ts` («rifParaMostrar — O-04»), que es la función que
 * pintan session.tsx y shell.tsx; la lectura de pantalla queda para el guion del bloque (--guion).
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { comprobaciones, pedir, afirmar, PERSONAS } from "./_app.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { formatearDocumento, esMarcadorSinRif } = await import(
  pathToFileURL(path.join(RAIZ, "packages", "schemas", "dist", "index.js")).href
);

const c = comprobaciones("O");

c.caso(
  "O-04 (lógica, no pantalla)",
  "el formateador del selector viste con guiones cada RIF del dueño",
  async () => {
    const r = await pedir(PERSONAS.duenoE2E3, null, "GET", "/v1/companies");
    afirmar(r.status === 200 && Array.isArray(r.json), `GET /v1/companies dio ${r.status}`);
    const conRif = r.json.filter((e) => !esMarcadorSinRif(e.tax_id));
    afirmar(conRif.length >= 2, `el dueño ve ${conRif.length} empresa(s) con RIF`);
    for (const e of conRif) {
      const visto = formatearDocumento(e.tax_id);
      afirmar(/^[VEJGPC]-\d{8}-\d$/.test(visto), `${e.legal_name}: «${visto}»`);
    }
  },
);

export default c.correr;

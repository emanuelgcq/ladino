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
import * as v0076 from "./_app.mjs";

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

// O-03 (ola 3): toda tabla de public con created_by lleva set_row_provenance, y el alta de un rol
// por la API guarda a su autor. Ciclo: el dueño de E2 da y quita un rol al contador.
c.caso(
  "O-03",
  "cero tablas con created_by sin procedencia; la asignación nueva lleva autor",
  async () => {
    const { sql, EMPRESAS } = await import("./_app.mjs");
    const [inv] = await sql`
    select count(*)::int as n from information_schema.columns c
      join pg_class t on t.relname = c.table_name
      join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
     where c.table_schema = 'public' and c.column_name = 'created_by' and t.relkind = 'r'
       and not exists (select 1 from pg_trigger g
                        where g.tgrelid = t.oid and not g.tgisinternal
                          and g.tgfoid = 'platform.set_row_provenance'::regproc)`;
    afirmar(inv.n === 0, `${inv.n} tablas con created_by sin set_row_provenance`);
    const alta = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/members", {
      company_id: EMPRESAS.E2,
      email: PERSONAS.contador,
      role_key: "cashier",
    });
    afirmar(alta.status === 201, `alta: ${alta.status} ${alta.texto.slice(0, 160)}`);
    const [a] = await sql`
    select a.id, a.created_by = u2.id as del_dueno
      from public.user_role_assignments a
      join public.memberships m on m.id = a.membership_id
      join auth.users u on u.id = m.user_id and u.email = ${PERSONAS.contador}
      join public.roles r on r.id = a.role_id and r.key = 'cashier'
      join auth.users u2 on u2.email = ${PERSONAS.duenoE2E3}
     where a.company_id = ${EMPRESAS.E2}`;
    const quitar = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "DELETE",
      `/v1/members/assignments/${a.id}`,
    );
    afirmar(quitar.status === 200, `quitar: ${quitar.status}`);
    afirmar(a.del_dueno === true, "la asignación nueva no guarda al dueño como autor");
  },
);

// ── ADR-0076 · quién armó y quién cobra (O-02) ──────────────────────────────────────────────
c.caso(
  "O-02 (ADR-0076)",
  "la cuenta ajena no la cobra quien no es su autor ni tiene pos.carts.manage; la cuenta dice quién la armó",
  async () => {
    const id = crypto.randomUUID();
    await v0076.pedir(v0076.PERSONAS.duenoE2E3, "E2", "PUT", `/v1/pos/carts/${id}`, {
      company_id: v0076.EMPRESAS.E2,
      label: "Armada por el dueño",
      customer_id: null,
      lines: [],
    });
    try {
      const [dueno] =
        await v0076.sql`select id from auth.users where email = ${v0076.PERSONAS.duenoE2E3}`;
      const [fila] = await v0076.sql`select created_by from public.pos_carts where id = ${id}`;
      v0076.afirmar(fila.created_by === dueno.id, "la cuenta no guarda quién la armó");
      const [antes] =
        await v0076.sql`select count(*)::int as n from public.documents where company_id = ${v0076.EMPRESAS.E2}`;
      const r = await v0076.pedir(v0076.PERSONAS.cajero, "E2", "POST", "/v1/pos/sales", {
        company_id: v0076.EMPRESAS.E2,
        warehouse_id: (
          await v0076.sql`select id from public.warehouses where company_id = ${v0076.EMPRESAS.E2} limit 1`
        )[0].id,
        cart_id: id,
        lines: [{ product_id: crypto.randomUUID(), quantity: "1" }],
      });
      v0076.afirmar(r.status === 403, `el cajero cobró la cuenta ajena: ${r.status}`);
      const [despues] =
        await v0076.sql`select count(*)::int as n from public.documents where company_id = ${v0076.EMPRESAS.E2}`;
      v0076.afirmar(despues.n === antes.n, "se creó un documento");
    } finally {
      await v0076.pedir(v0076.PERSONAS.duenoE2E3, "E2", "DELETE", `/v1/pos/carts/${id}`);
    }
  },
);

const { EMPRESAS } = v0076;

// ── ADR-0077 §1 (O-01): la empresa por pestaña ──────────────────────────────────────────────────
// La lógica que usa session.tsx, importada del fuente (Node quita los tipos): dos pestañas con su
// sessionStorage y un disco compartido. La pantalla la cubre apps/web/test/empresa-pestana.test.ts.
c.caso(
  "O-01 (lógica, no pantalla)",
  "la pestaña 1 recarga y sigue en E2 aunque la 2 eligió E3",
  async () => {
    const m = await import(
      pathToFileURL(path.join(RAIZ, "apps", "web", "src", "app", "empresa-pestana.ts")).href
    );
    const almacen = () => {
      const mapa = new Map();
      return { getItem: (k) => mapa.get(k) ?? null, setItem: (k, v) => void mapa.set(k, v) };
    };
    const r = await pedir(PERSONAS.duenoE2E3, null, "GET", "/v1/companies");
    const e2 = r.json.find((e) => e.id === EMPRESAS.E2);
    const e3 = r.json.find((e) => e.id === EMPRESAS.E3);
    afirmar(e2 && e3, "el dueño no ve E2 y E3");
    const disco = almacen();
    const p1 = almacen();
    const p2 = almacen();
    // El camino de session.tsx (H3): la última elegida es E2; la pestaña 1, NUEVA, la resuelve
    // con resolverEmpresaDePestana (que la fija en su sessionStorage, sin escribir nada más); la 2
    // arranca igual y ELIGE E3; F5 en la 1 vuelve a resolver.
    m.recordarEmpresa("dueno", e2.id, almacen(), disco);
    afirmar(
      m.resolverEmpresaDePestana("dueno", r.json, p1, disco)?.id === EMPRESAS.E2,
      "la 1 no arrancó en E2",
    );
    m.resolverEmpresaDePestana("dueno", r.json, p2, disco);
    m.recordarEmpresa("dueno", e3.id, p2, disco);
    const tras = m.resolverEmpresaDePestana("dueno", r.json, p1, disco);
    afirmar(tras?.id === EMPRESAS.E2, `tras F5 la pestaña 1 quedó en ${tras?.legal_name}`);
  },
);

export default c.correr;

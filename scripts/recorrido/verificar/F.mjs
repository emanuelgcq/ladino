/**
 * Bloque F · Cobros y deudas. Comprobaciones de `pnpm recorrido F` (ver `_app.mjs`).
 *
 * F-11 (ADR-0072 §5): el comprobante de retención soportada lo carga quien cobra
 *   (`ar.retention.register`: dueño, administrativo y cajero; el encargado no cobra, §2.8) y lo corrige el contador
 *   (`ar.retention.correct`). Ya no basta `sales.payment.register`.
 * F-09: tras cargar, la lista salta al período del comprobante (pantalla; se comprueba el código).
 */
import fs from "node:fs";
import { comprobaciones, afirmar, sql } from "./_app.mjs";

const c = comprobaciones("F");

c.caso("F-11", "quien cobra carga; el contador corrige; el cajero no corrige", async () => {
  const filas = await sql`
    select r.key, rp.permission_key from public.role_permissions rp
      join public.roles r on r.id = rp.role_id and r.tenant_id is null
     where rp.permission_key in ('ar.retention.register', 'ar.retention.correct')`;
  const tiene = (rol, p) => filas.some((f) => f.key === rol && f.permission_key === p);
  for (const rol of ["owner", "back_office", "cashier"]) {
    afirmar(tiene(rol, "ar.retention.register"), `${rol} no carga`);
  }
  afirmar(!tiene("store_manager", "ar.retention.register"), "el encargado carga y no cobra (§2.8)");
  afirmar(
    tiene("accountant", "ar.retention.correct") && tiene("owner", "ar.retention.correct"),
    "nadie corrige",
  );
  afirmar(!tiene("cashier", "ar.retention.correct"), "el cajero corrige");
});

c.caso("F-09", "la carga salta la lista al mes del comprobante", async () => {
  const dec = fs.readFileSync("apps/web/src/pages/libros/Declaraciones.tsx", "utf8");
  afirmar(dec.includes("onCargado={(fecha) => setRango(mesDe(fecha))}"), "la lista no salta");
});

export default c.correr;

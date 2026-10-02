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
import { pedir as pedirIgtf, EMPRESAS as EMP_IGTF, PERSONAS as PER_IGTF } from "./_app.mjs";
import { textoDe as textoIgtf, tiene as tieneIgtf } from "./_pdf.mjs";

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

// ── IGTF del especial (ADR-0072 §2; RESPUESTA §2.6) ─────────────────────────────────────────
/** Una venta de caja de E3 con 1,03 USD por Zelle (1 a la venta, 0,03 de IGTF) y el resto fiado. */
async function ventaZelleIgtfE3() {
  const E3i = EMP_IGTF.E3;
  await sql`
    insert into public.exchange_rates
      (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
    select 'USD', 'VES', 854.46, 'BCV', (now() at time zone 'America/Caracas')::date, now()
     where not exists (
       select 1 from public.exchange_rates
        where from_currency = 'USD' and to_currency = 'VES'
          and rate_date = (now() at time zone 'America/Caracas')::date)`;
  const [w] = await sql`select id from public.warehouses where company_id = ${E3i} limit 1`;
  const [p] = await sql`
    select sb.product_id from public.stock_balances sb
      join public.products pr on pr.id = sb.product_id
     where sb.company_id = ${E3i} and sb.quantity > 1 and pr.status = 'active'
       and pr.name ilike 'tornillo%'
     limit 1`;
  const [cl] = await sql`
    select id from public.customers where company_id = ${E3i} and not is_system
       and status <> 'blocked' order by legal_name limit 1`;
  afirmar(w && p && cl, "E3 no trae depósito, tornillos con existencia o un cliente");
  const r = await pedirIgtf(PER_IGTF.duenoE2E3, "E3", "POST", "/v1/pos/sales", {
    company_id: E3i,
    customer_id: cl.id,
    warehouse_id: w.id,
    lines: [{ product_id: p.product_id, quantity: "1" }],
    payments: [{ instrument: "zelle", currency: "USD", amount: "1.03" }],
  });
  afirmar(r.status === 201, `venta de caja de E3: ${r.status} ${r.texto}`);
  return r.json;
}

c.caso(
  "F-05",
  "en la ficha, 1 USD entregado por Zelle son 0,97 a la factura y 0,03 de IGTF, con su ND por IGTF",
  async () => {
    const v = await ventaZelleIgtfE3();
    const r = await pedirIgtf(PER_IGTF.duenoE2E3, "E3", "POST", "/v1/payments", {
      company_id: EMP_IGTF.E3,
      document_id: v.document.id,
      currency: "USD",
      amount: "1",
      instrument: "zelle",
      igtf_included: true,
    });
    afirmar(r.status === 201, `abono: ${r.status} ${r.texto}`);
    afirmar(r.json.payment.amount === "0.97000000", `abonó ${r.json.payment.amount}, no 0,97`);
    afirmar(r.json.igtf?.amount === "0.03000000", "el IGTF no es 0,03");
    const nd = r.json.igtf_debit_note;
    afirmar(nd && nd.control_display, "el abono posterior no emitió la ND por IGTF con su control");
    const [d] =
      await sql`select status, tax_amount::text as iva from public.documents where id = ${nd.id}`;
    afirmar(d.status === "paid" && Number(d.iva) === 0, "la ND por IGTF no nació pagada y sin IVA");
  },
);

export default c.correr;

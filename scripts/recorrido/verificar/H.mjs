/**
 * Bloque H · Compras y gastos. Comprobaciones de `pnpm recorrido H` (ver `_app.mjs`).
 *
 * H-01 (ADR-0072 §3, migración 20261002110000): un especial con su regla cargada registraba
 * compras SIN retener, porque el servidor solo retenía si el cuerpo traía `retention_concepts` y
 * ninguna pantalla lo enviaba. Ahora la retención se practica sola al registrar. F-88771 y F-89002
 * NO se regularizan solas: están abonadas en cuenta desde su registro (R-3) y su regularización es
 * VALIDAR-TRIBUTARIO (PENDIENTES_ASESOR, «H-01 · regularizar F-88771 y F-89002»).
 * H-04: el comprobante es un documento (AAAAMM + 8, vencimiento de entrega, identidad congelada).
 * H-12: el libro de compras identifica el comprobante emitido en el período.
 */
import fs from "node:fs";
import { comprobaciones, pedir, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";

const c = comprobaciones("H");
const RUN = Date.now().toString(36);
let factura = null;

/** Registra en E3 una compra nueva al proveedor ordinario de F-89002, sin retention_concepts. */
async function registrarEnE3() {
  if (factura !== null) return factura;
  const [base] = await sql`
    select i.supplier_id, l.product_id
      from public.supplier_invoices i
      join public.supplier_invoice_lines l on l.supplier_invoice_id = i.id
     where i.company_id = ${EMPRESAS.E3} and i.supplier_document_number = 'F-89002'
     limit 1`;
  afirmar(base, "no está F-89002 en E3: el escenario no es el del recorrido");
  const [hoy] = await sql`select (now() at time zone 'America/Caracas')::date::text as d`;
  const r = await pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/supplier-invoices", {
    company_id: EMPRESAS.E3,
    supplier_id: base.supplier_id,
    supplier_document_number: `H01-${RUN}`,
    supplier_control_number: `00-${RUN}`,
    invoice_date: hoy.d,
    currency: "VES",
    lines: [{ product_id: base.product_id, quantity: "2", unit_price: "1000" }],
  });
  afirmar(
    r.status === 201,
    `registrar en E3: esperaba 201, llegó ${r.status}: ${r.texto.slice(0, 300)}`,
  );
  factura = r.json;
  return factura;
}

c.caso(
  "H-01",
  "E3 (especial, regla del 75 %) registra una compra SIN retention_concepts y retiene sola",
  async () => {
    const f = await registrarEnE3();
    // 2 × 1 000 = 2 000; IVA 320; retención 75 % = 240 (lo que solo produce el arreglo: antes, 0).
    afirmar(f.tax_amount === "320.00000000", `IVA de la compra: ${f.tax_amount}`);
    afirmar(
      f.retention_total === "240.00000000",
      `retenido: ${f.retention_total} (antes del arreglo, 0)`,
    );
    afirmar(
      Array.isArray(f.retentions) && f.retentions[0]?.concept_code === "iva_compras",
      `concepto: ${JSON.stringify(f.retentions)?.slice(0, 200)}`,
    );
  },
);

c.caso(
  "H-04",
  "nace el comprobante AAAAMM########, con vencimiento de entrega e identidad congelada",
  async () => {
    const f = await registrarEnE3();
    afirmar(
      /^\d{14}$/.test(f.retention_voucher_number ?? ""),
      `número: ${f.retention_voucher_number}`,
    );
    const r = await pedir(
      PERSONAS.duenoE2E3,
      "E3",
      "GET",
      `/v1/retention-vouchers/${f.retention_voucher_id}`,
    );
    afirmar(r.status === 200, `GET comprobante: ${r.status} ${r.texto.slice(0, 200)}`);
    const v = r.json;
    afirmar(
      v.voucher_number.startsWith(v.issued_on.slice(0, 7).replace("-", "")),
      `período del número: ${v.voucher_number} / ${v.issued_on}`,
    );
    afirmar(
      v.delivery_due_on > v.fortnight_end,
      `vence ${v.delivery_due_on}, quincena hasta ${v.fortnight_end}`,
    );
    afirmar(
      v.status === "issued" && v.lines.length === 1,
      `estado ${v.status}, renglones ${v.lines.length}`,
    );
    afirmar(
      v.lines[0].iva_amount === "320.00000000" && v.lines[0].retained_amount === "240.00000000",
      `renglón: ${JSON.stringify(v.lines[0]).slice(0, 200)}`,
    );
  },
);

c.caso(
  "H-12",
  "el libro de compras del período identifica el comprobante: número, fecha e IVA retenido",
  async () => {
    const f = await registrarEnE3();
    const [fila] = await sql`
    select retention_voucher_number as n, retention_voucher_date::text as d,
           retention_voucher_iva::text as iva
      from platform.purchases_book_with_vouchers(${EMPRESAS.E3}, ${f.invoice_date}::date,
                                                 ${f.invoice_date}::date)
     where invoice_id = ${f.id}`;
    afirmar(fila, "la compra no está en el libro de su día");
    afirmar(fila.n === f.retention_voucher_number, `comprobante en el libro: ${fila.n}`);
    afirmar(fila.iva === "240.00000000", `IVA retenido en el libro: ${fila.iva}`);
  },
);

c.caso(
  "H-01",
  "F-88771 y F-89002 NO se regularizan solas, y el procedimiento está con el asesor",
  async () => {
    const filas = await sql`
    select i.supplier_document_number as n, i.retention_total::text as t,
           (select count(*) from public.retention_voucher_lines l
             where l.supplier_invoice_id = i.id)::int as comprobantes
      from public.supplier_invoices i
     where i.company_id = ${EMPRESAS.E3} and i.supplier_document_number in ('F-88771', 'F-89002')`;
    afirmar(filas.length === 2, `esperaba las dos facturas, hay ${filas.length}`);
    for (const f of filas) {
      afirmar(Number(f.comprobantes) === 0, `${f.n} tiene comprobante: se regularizó sola`);
    }
    const pendientes = fs.readFileSync("docs/02_COMPLIANCE/PENDIENTES_ASESOR.md", "utf8");
    afirmar(
      pendientes.includes("F-88771") && pendientes.includes("F-89002"),
      "PENDIENTES_ASESOR no tiene el VALIDAR-TRIBUTARIO de F-88771 y F-89002",
    );
  },
);

export default c.correr;

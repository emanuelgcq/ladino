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
import * as monedaA from "./_moneda.mjs";

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

// ── Moneda A (ADR-0075 §4) ───────────────────────────────────────────────────
c.caso(
  "H-02",
  "abonar la 000123 de E2 (registrada a 854,4637) cancela la CxP a ESA tasa y lleva la diferencia al diferencial",
  async () => {
    const [f] = await sql`
      select id from public.supplier_invoices
       where company_id = ${EMPRESAS.E2} and supplier_document_number = '000123'`;
    afirmar(f, "no está la 000123 en E2");
    const banco = await monedaA.bancoBsE2();
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/supplier-payments", {
      company_id: EMPRESAS.E2,
      supplier_invoice_id: f.id,
      gross_amount: "1.00000000",
      currency: "USD",
      instrument: "transferencia",
      account_id: banco.id,
      allow_negative_balance: true,
      overdraft_reason: "Comprobación del recorrido: abono de 1 USD a la 000123",
    });
    afirmar(r.status === 201, `abonar 1 USD: ${r.status} ${r.texto.slice(0, 300)}`);
    const [p] = await sql`
      select functional_amount::text as salio, exchange_difference::text as dif
        from public.supplier_payments where id = ${r.json.payment.id}`;
    const lineas = await sql`
      select s.purpose, l.functional_debit::text as debe, l.functional_credit::text as haber
        from public.journal_entries e
        join public.journal_lines l on l.entry_id = e.id
        join public.company_account_settings s
          on s.company_id = l.company_id and s.account_id = l.account_id
         and s.purpose in ('ap_general', 'exchange_loss', 'exchange_gain')
       where e.company_id = ${EMPRESAS.E2} and e.source_kind = 'payment_made'
         and e.source_id = ${r.json.payment.id}`;
    const cxp = lineas.find((l) => l.purpose === "ap_general");
    afirmar(cxp, "el pago no tiene asiento con línea de cuentas por pagar");
    // 1 USD a la tasa de REGISTRO (854,4637) son 854,46; antes se debitaba lo que salía hoy.
    afirmar(Number(cxp.debe) === 854.46, `la CxP se debitó por ${cxp.debe}, no por 854,46`);
    afirmar(
      Number(p.dif) === Number((Number(p.salio) - 854.46).toFixed(2)),
      `diferencial ${p.dif} con ${p.salio} salidos`,
    );
    if (Number(p.dif) !== 0) {
      const papel = Number(p.dif) > 0 ? "exchange_loss" : "exchange_gain";
      afirmar(
        lineas.some((l) => l.purpose === papel),
        `falta la línea de ${papel}`,
      );
    }
  },
);

c.caso(
  "H-02",
  "ningún documento saldado desde el corte tiene residuo en el mayor (settled_ledger_gaps = 0 en E2 y E3)",
  async () => {
    await monedaA.compraUsdPagadaEnBs();
    for (const e of [EMPRESAS.E2, EMPRESAS.E3]) {
      const filas = await sql`select * from platform.settled_ledger_gaps(${e})`;
      afirmar(
        filas.length === 0,
        `${filas.length} saldado(s) con residuo: ${JSON.stringify(filas[0])}`,
      );
    }
  },
);

c.caso(
  "H-06",
  "el pedido nace en la moneda del precio y el campo de precio dice su moneda",
  async () => {
    const web = fs.readFileSync("apps/web/src/components/HacerPedido.tsx", "utf8");
    afirmar(!web.includes('useState("VES")'), "la moneda del pedido sigue naciendo fija en VES");
    // La propuesta sale de `monedaDelPedido` a través de `monedaQueSeEnsena`, que no propone nada
    // mientras las listas cargan y no pisa lo que la persona ya eligió (revisión de moneda, X8).
    const helper = fs.readFileSync("apps/web/src/moneda-del-pedido.ts", "utf8");
    afirmar(
      web.includes("monedaQueSeEnsena(monedaElegida, listas.isLoading, listas.data)") &&
        helper.includes("return monedaDelPedido(listas);"),
      "no propone la moneda de la lista",
    );
    afirmar(
      web.includes("` en ${nombreCortoDeMoneda(moneda)}`") &&
        web.includes("`Precio c/u${enMoneda}`"),
      "el precio no dice en qué moneda va",
    );
    afirmar(
      web.indexOf("¿En qué moneda van los precios?") < web.indexOf("`Precio c/u${enMoneda}`"),
      "la moneda se elige después de escribir los precios",
    );
    // E2 vende con una lista en USD: es la que la pantalla propone.
    const listas = await pedir(PERSONAS.duenoE2E3, "E2", "GET", "/v1/price-lists");
    afirmar(listas.status === 200, `listas de E2: ${listas.status}`);
    const activas = listas.json.filter((l) => l.status === "active");
    const propuesta = (activas.find((l) => l.is_caja_default === true) ?? activas[0])
      ?.currency_code;
    afirmar(propuesta === "USD", `la lista con la que vende E2 está en ${propuesta}`);
  },
);

export default c.correr;

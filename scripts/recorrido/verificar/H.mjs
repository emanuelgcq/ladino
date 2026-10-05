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

// ── Ola 4 · H-05, H-08, H-09, H-10 y H-15 ───────────────────────────────────

c.caso(
  "H-05",
  "pagar al proveedor desde /admin/compras sin saldo abre EL MISMO diálogo de tesorería, y el importe no se prellena crudo",
  async () => {
    const web = fs.readFileSync("apps/web/src/pages/compras/Compras.tsx", "utf8");
    afirmar(
      web.includes(
        'import { ConfirmarSobregiro, esSinSaldo } from "../../components/sobregiro.js";',
      ),
      "/admin/compras no usa el componente de sobregiro de tesorería",
    );
    const dialogo = web.slice(web.indexOf("function PagarProveedor("));
    afirmar(
      dialogo.includes("<ConfirmarSobregiro") && dialogo.includes("esSinSaldo(e)"),
      "el diálogo de pagar no ofrece «elige otra cuenta» / sobregirar",
    );
    afirmar(
      dialogo.includes("overdraft_reason: motivoSobregiro"),
      "el sobregiro confirmado no manda su motivo",
    );
    afirmar(
      !dialogo.includes('useState(factura.balance ?? "")'),
      "el importe se sigue prellenando crudo, con ocho decimales",
    );
    // El servidor ya no propone «confirma que quieres registrarlo igual» sin con qué (D-11).
    const dominio = fs.readFileSync("packages/domain/src/treasury.ts", "utf8");
    afirmar(
      !dominio.includes("confirma que quieres registrarlo igual"),
      "el mensaje sin salida sigue en el servidor",
    );
  },
);

c.caso(
  "H-08",
  "el comprobante del gasto: lo lee quien tiene expense.read, se adjunta con teclado y guarda su extensión real",
  async () => {
    const [p] = await sql`
      select qual from pg_policies
       where schemaname = 'storage' and tablename = 'objects' and policyname = 'receipts_select'`;
    afirmar(
      p?.qual?.includes("ladino_has_permission('expense.read'"),
      `la policy del bucket no mira expense.read: ${p?.qual}`,
    );
    const [b] = await sql`
      select file_size_limit::text as limite, allowed_mime_types as tipos
        from storage.buckets where id = 'receipts'`;
    afirmar(b?.limite === "6291456", `límite del bucket: ${b?.limite}`);
    afirmar(
      Array.isArray(b?.tipos) && b.tipos.includes("image/png") && b.tipos.length === 4,
      `tipos del bucket: ${b?.tipos}`,
    );
    // LA CONDUCTA DE LA SUBIDA no se comprueba leyendo el fuente: la ejerce el E2E, que sí tiene
    // Storage (el recorrido corre la API sin él). Ver apps/api/test/e2e-gasto-con-factura.test.ts,
    // «H-08 · el comprobante…»: más de 6 MB → 422, PNG → `.png`, contenido distinto del declarado
    // → 422, sin expense.register → 403, y en los rechazos ningún objeto en el bucket; y la ruta
    // de otra empresa en `attachment_path` → 422. Aquí se comprueba que ese test sigue existiendo.
    const e2e = fs.readFileSync("apps/api/test/e2e-gasto-con-factura.test.ts", "utf8");
    afirmar(
      e2e.includes('it("H-08 · el comprobante') && e2e.includes("/v1/expenses/attachment"),
      "falta el E2E de conducta de la subida del comprobante",
    );
    const web = fs.readFileSync("apps/web/src/pages/negocio/Compras.tsx", "utf8");
    const campo = web.slice(web.indexOf("Adjuntar el comprobante"));
    afirmar(
      campo.slice(0, 400).includes('className="sr-only"') &&
        !campo.slice(0, 400).includes('className="hidden"'),
      "el campo del comprobante sigue fuera del orden de tabulación",
    );
  },
);

c.caso(
  "H-09",
  "E3 registra la luz CON factura fiscal: va al libro de compras, da crédito, retiene el 75 % con su comprobante y de la cuenta sale el neto",
  async () => {
    const [base] = await sql`
      select i.supplier_id from public.supplier_invoices i
       where i.company_id = ${EMPRESAS.E3} and i.supplier_document_number = 'F-89002' limit 1`;
    afirmar(base, "no está F-89002 en E3: el escenario no es el del recorrido");
    const [cuenta] = await sql`
      select id from public.company_accounts
       where company_id = ${EMPRESAS.E3} and currency = 'VES' and is_active and not is_system
       order by (kind = 'bank') desc, name limit 1`;
    afirmar(cuenta, "E3 no tiene una cuenta en Bs");
    const [hoy] = await sql`select (now() at time zone 'America/Caracas')::date::text as d`;
    const [antes] = await sql`
      select count(*)::int as n from public.expenses where company_id = ${EMPRESAS.E3}`;
    const r = await pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/expenses", {
      company_id: EMPRESAS.E3,
      category: "Luz",
      account_id: cuenta.id,
      allow_negative_balance: true,
      overdraft_reason: "Recorrido H-09: la luz del mes, con su factura",
      invoice: {
        supplier_id: base.supplier_id,
        document_number: `LUZ-${RUN}`,
        control_number: `00-L${RUN}`,
        invoice_date: hoy.d,
        lines: [
          { tax_category_code: "gravado_general", base: "1000" },
          { tax_category_code: "exento", base: "200" },
        ],
      },
    });
    afirmar(r.status === 201, `gasto con factura: ${r.status}: ${r.texto.slice(0, 300)}`);
    const g = r.json;
    afirmar(g.invoice?.tax_amount === "160.00000000", `IVA: ${g.invoice?.tax_amount}`);
    afirmar(
      g.invoice?.retention_total === "120.00000000",
      `retenido: ${g.invoice?.retention_total}`,
    );
    afirmar(
      /^\d{14}$/.test(g.invoice?.retention_voucher_number ?? ""),
      `comprobante: ${g.invoice?.retention_voucher_number}`,
    );
    afirmar(g.amount === "1240.00000000", `salió de la cuenta: ${g.amount} (el neto es 1 240)`);
    afirmar(g.invoice?.tax_is_recoverable === true, "el IVA no quedó como crédito fiscal");
    // El gasto ES la factura: no hay fila nueva en `expenses` (el dinero no sale dos veces).
    const [despues] = await sql`
      select count(*)::int as n from public.expenses where company_id = ${EMPRESAS.E3}`;
    afirmar(despues.n === antes.n, "se escribió además un gasto llano");
    const libro = await sql`
      select invoice_id from platform.purchases_book_with_vouchers(
        ${EMPRESAS.E3}, ${hoy.d}::date, ${hoy.d}::date)
       where invoice_id = ${g.supplier_invoice_id}`;
    afirmar(libro.length === 1, "la factura del gasto no está en el libro de compras");
    // El historial de gastos la lista.
    const lista = await pedir(PERSONAS.duenoE2E3, "E3", "GET", `/v1/expenses?from=${hoy.d}`);
    afirmar(
      lista.json.items.some((x) => x.supplier_invoice_id === g.supplier_invoice_id),
      "el gasto con factura no sale en el historial de gastos",
    );
    // Los invariantes cruzados, en cero.
    const [inv] = await sql`
      select (select count(*)::int from platform.accounting_coverage_gaps(${EMPRESAS.E3})) as cobertura,
             (select count(*)::int from platform.retention_voucher_gaps(${EMPRESAS.E3})) as comprobantes,
             (select count(*)::int from platform.treasury_ledger_gaps(${EMPRESAS.E3})) as tesoreria,
             (select count(*)::int from platform.book_ledger_reconciliation(
                ${EMPRESAS.E3}, ${hoy.d}::date, ${hoy.d}::date) b where not b.cuadra) as libro`;
    afirmar(
      inv.cobertura === 0 && inv.comprobantes === 0 && inv.tesoreria === 0 && inv.libro === 0,
      `invariantes: ${JSON.stringify(inv)}`,
    );
    // La exclusión del art. 3 num. 8 es DATA marcable, con su norma.
    const [ex] = await sql`
      select applies, legal_article from public.retention_exclusions
       where code = 'servicio_publico_domiciliado' and effective_to is null`;
    afirmar(
      ex?.applies === "marked" && ex.legal_article === "art. 3 num. 8",
      `la exclusión del servicio público domiciliado: ${JSON.stringify(ex)}`,
    );
    // La pantalla ofrece «con factura fiscal» / «sin factura», con sus textos en la capa fiscal.
    const web = fs.readFileSync("apps/web/src/pages/negocio/Compras.tsx", "utf8");
    const textos = fs.readFileSync("apps/web/src/components/capa-fiscal/textos.ts", "utf8");
    afirmar(
      web.includes("GASTO_CON_FACTURA.con") && web.includes("GASTO_CON_FACTURA.sin"),
      "la pantalla no ofrece con / sin factura fiscal",
    );
    afirmar(
      textos.includes('con: "Con factura fiscal"') && textos.includes('sin: "Sin factura"'),
      "los textos fiscales del gasto no están en capa-fiscal/textos.ts",
    );
  },
);

c.caso(
  "H-10",
  "«Lo que debo → Ver qué debo» lleva a las compras a proveedores, no a los gastos",
  async () => {
    const dinero = fs.readFileSync("apps/web/src/pages/negocio/Dinero.tsx", "utf8");
    const enlace = dinero.slice(
      dinero.indexOf("Ver qué debo") - 260,
      dinero.indexOf("Ver qué debo"),
    );
    afirmar(
      enlace.includes('to="/compras?ver=compras"'),
      "el enlace sigue yendo a /compras a secas",
    );
    const compras = fs.readFileSync("apps/web/src/pages/negocio/Compras.tsx", "utf8");
    afirmar(
      compras.includes('parametros.get("ver")') && compras.includes('pedida === "compras"'),
      "la pantalla de compras no abre la pestaña que se le pide",
    );
  },
);

c.caso(
  "H-15",
  "registrar un gasto hace menos viajes a la base: una lectura donde había cinco",
  async () => {
    const dominio = fs.readFileSync("packages/domain/src/treasury.ts", "utf8");
    const gasto = dominio.slice(
      dominio.indexOf("export async function registerExpense("),
      dominio.indexOf("// ── Cierre de caja"),
    );
    afirmar(
      !gasto.includes("select functional_currency_code as moneda from public.companies") &&
        !gasto.includes("await sql`select set_config('ladino.rules_version'"),
      "registerExpense sigue leyendo en sentencias sueltas lo que cabe en una",
    );
    // Y el gasto sigue funcionando igual. En Bs, a propósito: el flete del hallazgo fue en USD,
    // pero un gasto en divisa exige la tasa BCV del día y este caso no puede depender de que el
    // escenario la tenga cargada para HOY (pasada la medianoche no la hay y daba 409).
    const [cuenta] = await sql`
    select id from public.company_accounts
     where company_id = ${EMPRESAS.E2} and currency = 'VES' and is_active and not is_system
     order by name limit 1`;
    afirmar(cuenta, "E2 no tiene una cuenta en Bs");
    const t0 = Date.now();
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/expenses", {
      company_id: EMPRESAS.E2,
      category: "Flete",
      account_id: cuenta.id,
      amount: "5",
      allow_negative_balance: true,
      overdraft_reason: "Recorrido H-15: el flete de la medición",
    });
    const ms = Date.now() - t0;
    afirmar(r.status === 201, `el flete: ${r.status}: ${r.texto.slice(0, 300)}`);
    afirmar(r.json.accounting === "posted", `el flete no se asentó: ${r.json.accounting}`);
    // El hallazgo fue 3 862 ms. No es un gate de tiempo (la máquina compartida no lo permite):
    // el presupuesto de viajes vive en apps/api/test/e2e-gasto-con-factura.test.ts.
    process.stdout.write(`      H-15: POST /v1/expenses tardó ${ms} ms en este recorrido
`);
  },
);

c.caso(
  "H-09",
  "antes de confirmar, la pantalla del gasto con factura enseña las cifras del servidor (vista previa que no escribe nada), y el evento es ap.expense_invoice_posted",
  async () => {
    const [base] = await sql`
      select i.supplier_id from public.supplier_invoices i
       where i.company_id = ${EMPRESAS.E3} and i.supplier_document_number = 'F-89002' limit 1`;
    const [cuenta] = await sql`
      select id from public.company_accounts
       where company_id = ${EMPRESAS.E3} and currency = 'VES' and is_active and not is_system
       order by (kind = 'bank') desc, name limit 1`;
    afirmar(base && cuenta, "el escenario no es el del recorrido");
    const [hoy] = await sql`select (now() at time zone 'America/Caracas')::date::text as d`;
    const [antes] = await sql`
      select count(*)::int as n from public.supplier_invoices where company_id = ${EMPRESAS.E3}`;
    const r = await pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/expenses/preview", {
      company_id: EMPRESAS.E3,
      category: "Teléfono",
      account_id: cuenta.id,
      invoice: {
        supplier_id: base.supplier_id,
        document_number: `TEL-${RUN}`,
        control_number: `00-T${RUN}`,
        invoice_date: hoy.d,
        lines: [{ tax_category_code: "gravado_general", base: "500" }],
      },
    });
    afirmar(r.status === 200, `vista previa: ${r.status}: ${r.texto.slice(0, 300)}`);
    const v = r.json;
    // 500 al 16 %: IVA 80, total 580; retención 75 % = 60; salen 520.
    afirmar(v.tax_amount === "80.00000000", `IVA: ${v.tax_amount}`);
    afirmar(v.total_amount === "580.00000000", `total: ${v.total_amount}`);
    afirmar(v.retention_total === "60.00000000", `retenido: ${v.retention_total}`);
    afirmar(v.amount === "520.00000000", `sale de la cuenta: ${v.amount}`);
    afirmar(v.lines?.[0]?.tax_rate === "0.16000000", `alícuota: ${v.lines?.[0]?.tax_rate}`);
    const [despues] = await sql`
      select count(*)::int as n from public.supplier_invoices where company_id = ${EMPRESAS.E3}`;
    afirmar(despues.n === antes.n, "la vista previa dejó una factura escrita");
    const web = fs.readFileSync("apps/web/src/pages/negocio/Compras.tsx", "utf8");
    afirmar(
      web.includes('"/v1/expenses/preview"') &&
        web.includes('data-testid="gasto-con-factura-resumen"') &&
        web.includes("facturaLista && vista !== undefined"),
      "la pantalla deja confirmar el gasto con factura sin enseñar sus cifras",
    );
    // El hecho contable y el evento del outbox llevan el mismo nombre.
    const eventos = await sql`
      select distinct o.event_type from public.outbox o
        join public.supplier_invoices i on i.id = o.aggregate_id
       where i.company_id = ${EMPRESAS.E3} and i.expense_category is not null
         and i.supplier_document_number = ${`LUZ-${RUN}`}
         and o.event_type like 'ap.%invoice_posted'`;
    afirmar(
      eventos.length === 1 && eventos[0].event_type === "ap.expense_invoice_posted",
      `eventos de la factura del gasto: ${JSON.stringify(eventos)}`,
    );
  },
);

// ── Auditoría fiscal de la ola 4 · AF4-01 ───────────────────────────────────

c.caso(
  "H-09",
  "AF4-01: la exclusión del servicio público domiciliado exige cuenta bancaria; desde una caja la vista previa la rechaza y el catálogo no la ofrece",
  async () => {
    const [base] = await sql`
      select i.supplier_id from public.supplier_invoices i
       where i.company_id = ${EMPRESAS.E3} and i.supplier_document_number = 'F-89002' limit 1`;
    afirmar(base, "no está F-89002 en E3: el escenario no es el del recorrido");
    const [caja] = await sql`
      select id, name from public.company_accounts
       where company_id = ${EMPRESAS.E3} and kind = 'cash' and is_active
       order by (currency = 'VES') desc, is_system, name limit 1`;
    afirmar(caja, "E3 no tiene una caja");
    const [hoy] = await sql`select (now() at time zone 'America/Caracas')::date::text as d`;
    const [antes] = await sql`
      select count(*)::int as n from public.supplier_invoices where company_id = ${EMPRESAS.E3}`;
    // Solo la vista previa: no deja nada escrito en el escenario.
    const r = await pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/expenses/preview", {
      company_id: EMPRESAS.E3,
      category: "Luz",
      account_id: caja.id,
      invoice: {
        supplier_id: base.supplier_id,
        document_number: `LUZ-AF4-${RUN}`,
        control_number: `00-A${RUN}`,
        invoice_date: hoy.d,
        lines: [{ tax_category_code: "gravado_general", base: "500" }],
        retention_exclusion: {
          code: "servicio_publico_domiciliado",
          reason: "Recorrido AF4-01: la luz pagada en efectivo",
        },
      },
    });
    afirmar(r.status === 422, `exclusión desde una caja: ${r.status}: ${r.texto.slice(0, 300)}`);
    afirmar(
      String(r.json?.message ?? "").includes("domiciliación desde una cuenta bancaria") &&
        String(r.json?.message ?? "").includes(caja.name),
      `el mensaje no es el de la domiciliación: ${r.json?.message}`,
    );
    const [despues] = await sql`
      select count(*)::int as n from public.supplier_invoices where company_id = ${EMPRESAS.E3}`;
    afirmar(despues.n === antes.n, "el rechazo dejó una factura escrita");
    const paraCaja = await pedir(
      PERSONAS.duenoE2E3,
      "E3",
      "GET",
      `/v1/retention-exclusions?account_id=${caja.id}`,
    );
    afirmar(paraCaja.status === 200, `catálogo para la caja: ${paraCaja.status}`);
    afirmar(
      !paraCaja.json.items.some((x) => x.code === "servicio_publico_domiciliado") &&
        paraCaja.json.items.length > 0,
      "el catálogo sigue ofreciendo la exclusión para una caja (o vino vacío)",
    );
    const entero = await pedir(PERSONAS.duenoE2E3, "E3", "GET", "/v1/retention-exclusions");
    afirmar(
      entero.json.items.some((x) => x.code === "servicio_publico_domiciliado"),
      "sin cuenta, el catálogo dejó de traer la exclusión",
    );
    // La pantalla le pasa la cuenta al servidor: no decide nada.
    const web = fs.readFileSync("apps/web/src/pages/negocio/Compras.tsx", "utf8");
    const campos = fs.readFileSync("apps/web/src/components/RetencionIva.tsx", "utf8");
    afirmar(
      web.includes("cuentaId={cuenta}") && campos.includes("/v1/retention-exclusions?account_id="),
      "la pantalla del gasto no pide el catálogo con la cuenta elegida",
    );
    afirmar(
      !campos.includes("servicio_publico_domiciliado"),
      "el componente nombra la exclusión: la regla tiene que vivir en el servidor",
    );
  },
);

// ── Ola 5 · H-03: la nota de crédito del proveedor ──────────────────────────

c.caso(
  "H-03",
  "la nota de crédito del proveedor se registra con lo que manda la pantalla (línea de la factura, sin IVA tecleado), sin control queda incompleta, resta el crédito del libro y no mueve el invariante kardex ↔ mayor",
  async () => {
    const [base] = await sql`
      select i.supplier_id, l.product_id
        from public.supplier_invoices i
        join public.supplier_invoice_lines l on l.supplier_invoice_id = i.id
       where i.company_id = ${EMPRESAS.E3} and i.supplier_document_number = 'F-89002'
       limit 1`;
    afirmar(base, "no está F-89002 en E3: el escenario no es el del recorrido");
    const [hoy] = await sql`select (now() at time zone 'America/Caracas')::date::text as d`;
    // Una factura PROPIA de esta comprobación: no consume la de H-01 ni la de nadie.
    const f = await pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/supplier-invoices", {
      company_id: EMPRESAS.E3,
      supplier_id: base.supplier_id,
      supplier_document_number: `H03-${RUN}`,
      supplier_control_number: `00-H03${RUN}`,
      invoice_date: hoy.d,
      currency: "VES",
      lines: [{ product_id: base.product_id, quantity: "2", unit_price: "1000" }],
    });
    afirmar(f.status === 201, `factura para la nota: ${f.status}: ${f.texto.slice(0, 300)}`);
    const brecha = async () =>
      (
        await sql`
          select diferencia::text as d,
                 (select count(*)::int from platform.inventory_coverage_gaps(${EMPRESAS.E3})) as huecos
            from platform.inventory_ledger_gap(${EMPRESAS.E3})`
      )[0];
    const antes = await brecha();

    // Lo que la pantalla lee antes de preguntar nada.
    const lineas = await pedir(
      PERSONAS.duenoE2E3,
      "E3",
      "GET",
      `/v1/supplier-invoices/${f.json.id}/lines`,
    );
    afirmar(lineas.status === 200, `líneas de la factura: ${lineas.status}`);
    afirmar(
      lineas.json.is_expense === false &&
        lineas.json.fiscal_support === true &&
        lineas.json.lines.length === 1 &&
        lineas.json.lines[0].product_id === base.product_id,
      `las líneas no describen la factura: ${JSON.stringify(lineas.json).slice(0, 300)}`,
    );
    const cuerpo = {
      company_id: EMPRESAS.E3,
      supplier_invoice_id: f.json.id,
      supplier_document_number: `NC-H03-${RUN}`,
      note_date: hoy.d,
      reason: "Recorrido H-03: el proveedor rebajó el precio",
      currency: "VES",
      lines: [
        { supplier_invoice_line_id: lineas.json.lines[0].id, quantity: "1", unit_price: "100" },
      ],
    };
    // Sin decir qué pasó con la mercancía no se registra: la pantalla lo pregunta.
    const sinClase = await pedir(
      PERSONAS.duenoE2E3,
      "E3",
      "POST",
      "/v1/supplier-credit-notes",
      cuerpo,
    );
    afirmar(sinClase.status === 422, `sin clase: ${sinClase.status}`);
    // Sin número de control (el defecto original: 422 sin salida): ahora entra, incompleta.
    const nota = await pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/supplier-credit-notes", {
      ...cuerpo,
      kind: "rebaja",
    });
    afirmar(nota.status === 201, `nota sin control: ${nota.status}: ${nota.texto.slice(0, 300)}`);
    afirmar(
      nota.json.document_incomplete === true && nota.json.is_fiscal === true,
      `la nota sin control no quedó incompleta: ${JSON.stringify(nota.json)}`,
    );
    // El IVA lo puso el servidor (la pantalla no lo manda) y el libro de compras lo resta.
    const [fila] = await sql`
      select n.tax_amount > 0 as con_iva, n.correction_kind,
             (select b.iva_credito < 0
                from platform.purchases_book(${EMPRESAS.E3}, ${hoy.d}::date, ${hoy.d}::date) b
               where b.supplier_document_number = ${`NC-H03-${RUN}`}) as resta_credito
        from public.supplier_credit_notes n where n.id = ${nota.json.id}`;
    afirmar(
      fila.con_iva === true && fila.correction_kind === "rebaja" && fila.resta_credito === true,
      `la nota no lleva IVA o no resta el crédito del libro: ${JSON.stringify(fila)}`,
    );
    const despues = await brecha();
    afirmar(
      despues.d === antes.d && despues.huecos === antes.huecos,
      `la nota movió el invariante kardex ↔ mayor: ${JSON.stringify({ antes, despues })}`,
    );
  },
);

// H-11 (ola 5): «Qué debo» sale SIN elegir proveedor: por proveedor, monto y vencimiento, y cuadra
// con platform.ap_aging (que valora con platform.supplier_debt_today).
c.caso(
  "H-11",
  "la cartera de proveedores de E2 y E3 cuadra con ap_aging, trae el vencimiento y exige ap.read",
  async () => {
    for (const e of ["E2", "E3"]) {
      const r = await pedir(PERSONAS.duenoE2E3, e, "GET", "/v1/reports/payables");
      afirmar(r.status === 200, `${e}: la cartera dio ${r.status}`);
      const t = r.json;
      const fuente = await sql`
        select a.supplier_id::text as id,
               (case when bool_or(a.amount is null) then null
                     else round(sum(a.amount), 2) end)::text as deuda,
               sum(a.document_count)::text as n
          from platform.ap_aging(${EMPRESAS[e]}, null, ${t.as_of}::date) a
         group by a.supplier_id`;
      afirmar(
        t.rows.length === fuente.length,
        `${e}: ${t.rows.length} filas, ap_aging tiene ${fuente.length} proveedores`,
      );
      for (const f of fuente) {
        const fila = t.rows.find((x) => x.id === f.id);
        afirmar(fila !== undefined, `${e}: falta el proveedor ${f.id}`);
        afirmar(
          fila.debt === f.deuda,
          `${e}: ${fila.label} dice ${fila.debt}, ap_aging ${f.deuda}`,
        );
        afirmar(
          fila.documents === f.n,
          `${e}: ${fila.label} cuenta ${fila.documents} facturas, no ${f.n}`,
        );
        afirmar(
          /^\d{4}-\d{2}-\d{2}$/.test(fila.next_due ?? ""),
          `${e}: ${fila.label} sin vencimiento`,
        );
      }
      const [total] = await sql`
        select (case when bool_or(amount is null) then null
                     else round(coalesce(sum(amount), 0), 2) end)::text as deuda
          from platform.ap_aging(${EMPRESAS[e]}, null, ${t.as_of}::date)`;
      afirmar(
        t.totals.debt === total.deuda,
        `${e}: total ${t.totals.debt} ≠ ap_aging ${total.deuda}`,
      );
      // Sin tasa la deuda es null con su motivo, nunca «0»: o hay cifra, o hay motivo.
      const resumen = t.summary.find((s) => s.key === "debt");
      afirmar(
        resumen.value === total.deuda && (resumen.value !== null || resumen.reason === "sin_tasa"),
        `${e}: el resumen dice ${JSON.stringify(resumen)}`,
      );
    }
    const cajero = await pedir(PERSONAS.cajero, "E2", "GET", "/v1/reports/payables");
    afirmar(cajero.status === 403, `el cajero recibió ${cajero.status}`);
    const almacen = await pedir(PERSONAS.almacenista, "E2", "GET", "/v1/reports/payables");
    afirmar(almacen.status === 403, `el almacenista recibió ${almacen.status}`);
  },
);

// H-07 (ola 5): el gasto que se repite AVISA cuando toca, y «registrar ahora» pasa por la puerta
// de siempre sin duplicar. Escribe en E2 tres gastos de 1 Bs con una categoría propia de la
// corrida y deja el recordatorio detenido: no queda aviso vivo para nadie más.
c.caso(
  "H-07",
  "un gasto semanal de hace ocho días toca; «registrar ahora» lo atiende una vez (el segundo clic es 409) y el cajero no ve el aviso",
  async () => {
    const categoria = `Recordatorio ${RUN}`;
    const [cuenta] = await sql`
      select ca.id from public.company_accounts ca
        left join public.company_account_balances b on b.account_id = ca.id
       where ca.company_id = ${EMPRESAS.E2} and ca.is_active and ca.currency = 'VES'
       order by coalesce(b.balance, 0) desc limit 1`;
    afirmar(cuenta, "E2 no tiene una cuenta activa en Bs: el escenario no es el del recorrido");
    const [dias] = await sql`
      select ((now() at time zone 'America/Caracas')::date - 8)::text as ancla,
             ((now() at time zone 'America/Caracas')::date - 1)::text as ayer,
             ((now() at time zone 'America/Caracas')::date + 6)::text as proximo`;
    const cuerpo = (extra) => ({
      company_id: EMPRESAS.E2,
      category: categoria,
      account_id: cuenta.id,
      amount: "1",
      allow_negative_balance: true,
      overdraft_reason: "Comprobación H-07 del recorrido",
      ...extra,
    });
    const primero = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "POST",
      "/v1/expenses",
      // Mediodía de Caracas de hace ocho días.
      cuerpo({ is_recurring: true, recurrence: "weekly", paid_at: `${dias.ancla}T16:00:00.000Z` }),
    );
    afirmar(
      primero.status === 201,
      `el primer gasto dio ${primero.status}: ${primero.texto.slice(0, 300)}`,
    );

    const lista = await pedir(PERSONAS.duenoE2E3, "E2", "GET", "/v1/recurring-expenses");
    afirmar(lista.status === 200, `la lista de recordatorios dio ${lista.status}`);
    const aviso = lista.json.items.find((x) => x.category === categoria);
    afirmar(aviso !== undefined, "el gasto marcado «se repite» no creó su recordatorio");
    afirmar(
      aviso.is_due === true && aviso.next_due_on === dias.ayer && aviso.days_overdue === 1,
      `no toca como debía (ayer, un día de atraso): ${JSON.stringify(aviso)}`,
    );
    afirmar(
      aviso.suggested_amount === "1.00000000" && aviso.account_id === cuenta.id,
      `los datos de la última vez no quedaron para precargar: ${JSON.stringify(aviso)}`,
    );
    const cajero = await pedir(PERSONAS.cajero, "E2", "GET", "/v1/recurring-expenses");
    afirmar(cajero.status === 403, `el cajero (sin expense.read) recibió ${cajero.status}`);

    const ahora = cuerpo({ recurring_expense_id: aviso.id, recurring_due_on: aviso.next_due_on });
    const registrado = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/expenses", ahora);
    afirmar(
      registrado.status === 201,
      `«registrar ahora» dio ${registrado.status}: ${registrado.texto.slice(0, 300)}`,
    );
    const segundo = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/expenses", ahora);
    afirmar(
      segundo.status === 409 && segundo.json.code === "CONFLICT",
      `el segundo clic debía ser 409 CONFLICT: ${segundo.status} ${segundo.texto.slice(0, 200)}`,
    );
    const [n] = await sql`
      select count(*)::int as n from public.expenses
       where company_id = ${EMPRESAS.E2} and category = ${categoria}`;
    afirmar(
      n.n === 2,
      `debía haber 2 gastos de la categoría (el primero y el de ahora), hay ${n.n}`,
    );

    const despues = await pedir(PERSONAS.duenoE2E3, "E2", "GET", "/v1/recurring-expenses");
    const ya = despues.json.items.find((x) => x.id === aviso.id);
    afirmar(
      ya.is_due === false && ya.next_due_on === dias.proximo,
      `atendido el período, el aviso debía pasar al ${dias.proximo}: ${JSON.stringify(ya)}`,
    );
    const fin = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "POST",
      `/v1/recurring-expenses/${aviso.id}/stop`,
      { company_id: EMPRESAS.E2 },
    );
    afirmar(fin.status === 200 && fin.json.status === "stopped", `detenerlo dio ${fin.status}`);
  },
);

// ── Ola 5 · H-03, tercera ronda: lo que se debe no resta el saldo a favor, y la nota que cierra ──

c.caso(
  "H-03",
  "tercera ronda: la nota que cierra una factura la deja sin deuda y sin pago posible; el estado de cuenta suma lo que se debe sin restar el saldo a favor y enseña las notas con su marca",
  async () => {
    const [base] = await sql`
      select i.supplier_id, l.product_id
        from public.supplier_invoices i
        join public.supplier_invoice_lines l on l.supplier_invoice_id = i.id
       where i.company_id = ${EMPRESAS.E3} and i.supplier_document_number = 'F-89002'
       limit 1`;
    afirmar(base, "no está F-89002 en E3: el escenario no es el del recorrido");
    const [hoy] = await sql`select (now() at time zone 'America/Caracas')::date::text as d`;
    const f = await pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/supplier-invoices", {
      company_id: EMPRESAS.E3,
      supplier_id: base.supplier_id,
      supplier_document_number: `H03C-${RUN}`,
      supplier_control_number: `00-H03C${RUN}`,
      invoice_date: hoy.d,
      currency: "VES",
      lines: [{ product_id: base.product_id, quantity: "1", unit_price: "1000" }],
    });
    afirmar(f.status === 201, `factura: ${f.status}: ${f.texto.slice(0, 300)}`);
    const lineas = await pedir(
      PERSONAS.duenoE2E3,
      "E3",
      "GET",
      `/v1/supplier-invoices/${f.json.id}/lines`,
    );
    afirmar(
      lineas.status === 200 && Array.isArray(lineas.json.lots),
      `las líneas no traen la lista de lotes: ${lineas.status}`,
    );
    const cuerpo = {
      company_id: EMPRESAS.E3,
      supplier_invoice_id: f.json.id,
      supplier_document_number: `NC-H03C-${RUN}`,
      supplier_control_number: `00-NCH03C${RUN}`,
      reason: "Recorrido H-03: factura registrada por error",
      currency: "VES",
      kind: "rebaja",
      lines: [
        { supplier_invoice_line_id: lineas.json.lines[0].id, quantity: "1", unit_price: "1000" },
      ],
    };
    // AF5-11: ni futura ni anterior a su factura.
    const [fechas] = await sql`
      select (${hoy.d}::date + 1)::text as manana, (${hoy.d}::date - 1)::text as ayer`;
    for (const [fecha, texto] of [
      [fechas.manana, "fecha futura"],
      [fechas.ayer, "anterior a la factura"],
    ]) {
      const mal = await pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/supplier-credit-notes", {
        ...cuerpo,
        note_date: fecha,
      });
      afirmar(
        mal.status === 422 && String(mal.json.message).includes(texto),
        `la nota del ${fecha} debía rechazarse («${texto}»): ${mal.status} ${mal.texto.slice(0, 200)}`,
      );
    }
    const nota = await pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/supplier-credit-notes", {
      ...cuerpo,
      note_date: hoy.d,
    });
    afirmar(nota.status === 201, `la nota que cierra: ${nota.status}: ${nota.texto.slice(0, 300)}`);
    // E3 es contribuyente especial: la factura nació con su retención practicada, así que la
    // nota por todo el importe pasa de lo que se debía y lo retenido queda a favor (P-103).
    afirmar(
      Number(nota.json.balance) <= 0 &&
        nota.json.left_credit_in_favor === Number(nota.json.balance) < 0,
      `la nota por todo el importe debía dejar la factura sin deuda: ${JSON.stringify(nota.json)}`,
    );
    // La factura sigue asentada (no «pagada»), no debe nada y no admite un pago.
    const [estado] = await sql`
      select i.status,
             platform.settlement_ledger_open(${EMPRESAS.E3}, 'ap', i.id)::text as abierto
        from public.supplier_invoices i where i.id = ${f.json.id}`;
    afirmar(
      estado.status === "posted" && (estado.abierto === null || Number(estado.abierto) === 0),
      `la factura cerrada por la nota: ${JSON.stringify(estado)}`,
    );
    const pago = await pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/supplier-payments", {
      company_id: EMPRESAS.E3,
      supplier_invoice_id: f.json.id,
      gross_amount: "1.00000000",
      currency: "VES",
      instrument: "transferencia",
      reference: `H03C-${RUN}`,
    });
    afirmar(
      pago.status === 422 && String(pago.json.message).includes("ya no debe nada"),
      `el pago de una factura sin deuda debía rechazarse: ${pago.status} ${pago.texto.slice(0, 200)}`,
    );
    // El estado de cuenta: lo que se debe ES la antigüedad; el saldo a favor, aparte.
    const ec = await pedir(
      PERSONAS.duenoE2E3,
      "E3",
      "GET",
      `/v1/suppliers/${base.supplier_id}/statement`,
    );
    afirmar(ec.status === 200, `estado de cuenta: ${ec.status}`);
    afirmar(
      ec.json.total_outstanding === ec.json.aging.total ||
        Number(ec.json.total_outstanding) === Number(ec.json.aging.total),
      `el total (${ec.json.total_outstanding}) no es la antigüedad (${ec.json.aging.total})`,
    );
    afirmar(
      Array.isArray(ec.json.credit_in_favor) &&
        (Number(nota.json.balance) === 0 ||
          ec.json.credit_in_favor.some((x) => x.currency === "VES" && Number(x.nominal) > 0)) &&
        ec.json.credit_notes.some((n) => n.id === nota.json.id && n.document_incomplete === false),
      `el estado de cuenta no enseña el saldo a favor aparte o no lista la nota: ${JSON.stringify(ec.json).slice(0, 300)}`,
    );
  },
);

export default c.correr;

/**
 * BLOQUE H · COMPRAS Y GASTOS — como el dueño.
 *   E2: gasto de luz con categoría, en Bs, recurrente y CON FOTO del recibo; gasto «Otro…» (flete) en USD;
 *       el historial de gastos; «Lo que debo» (Compras a proveedores y Mi dinero → «Ver qué debo»); abono de
 *       100 USD en efectivo a la factura 000123 (USD, del 24/09) con la tasa de hoy — ¿diferencial? (D-07);
 *       «Hacer un pedido» (orden de compra) a Alimentos del Centro; nota de crédito del proveedor sobre LM-5501.
 *   E3 (especial, agente de retención): la regla de retención de IVA 75 % (PA SNAT/2025/000054, citada en
 *       docs/02_COMPLIANCE/RETENTIONS_SPEC.md) — el catálogo nace vacío y F-88771 se registró en D sin
 *       retener; compra nueva en Bs CON factura a crédito (¿retiene al registrarla, «abono en cuenta»?);
 *       pagarla entera en Bs (el proveedor cobra el neto) y abonar 50 USD por Zelle a F-88771.
 */
import {
  abrir,
  BASE,
  dialogo,
  esperar,
  estado,
  guardarEstado,
  login,
  nuevaEvidencia,
  sql,
  cronometrar,
} from "./lib.mjs";

const E = estado();
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);
const hoy = new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10); // día de Caracas (UTC−4)
const ayer = new Date(Date.now() - 28 * 3600e3).toISOString().slice(0, 10);

async function elegirOpcion(page, etiqueta, opcion) {
  await clic(page.getByLabel(etiqueta).first());
  await esperar(page, 400);
  return clic(page.getByRole("option", { name: opcion }).first());
}
async function elegirEnPicker(page, input, texto) {
  await input.fill(texto);
  await esperar(page, 1300);
  return clic(page.getByRole("option", { name: new RegExp(texto.slice(0, 16), "i") }).first());
}

async function llegada(page, ev, clave, l) {
  const pasos = {};
  await page.goto(BASE + "/admin/llego-mercancia");
  await esperar(page, 2500);
  await ev(page, `${clave}-${l.id}-entrada`);
  const sinPedido = page.getByText("No, llegó sin pedido");
  if ((await sinPedido.count()) > 0) await clic(sinPedido.first());
  await esperar(page, 600);
  // ¿De quién vino?
  pasos.origen = await clic(
    page.getByText(l.proveedor ? "Me la trajo un proveedor" : "Ya era mía").first(),
  );
  await esperar(page, 900);
  // ¿Qué llegó?
  if (l.proveedor) {
    const pick = page.locator('input[role="combobox"]').first();
    await pick.fill(l.proveedor.nombre.slice(0, 12));
    await esperar(page, 1300);
    const opc = page.getByRole("option", {
      name: new RegExp(l.proveedor.nombre.slice(0, 12), "i"),
    });
    if ((await opc.count()) > 0) {
      await clic(opc.first());
    } else {
      await page.keyboard.press("Escape");
      await clic(page.getByRole("button", { name: /Nuevo/ }).first());
      await esperar(page, 500);
      await page.getByLabel(/^Nombre del proveedor/).fill(l.proveedor.nombre);
      if (l.proveedor.rif) await page.getByLabel(/^Cédula o RIF/).fill(l.proveedor.rif);
      await ev(page, `${clave}-${l.id}-proveedor-nuevo`);
      pasos.proveedor = await clic(page.getByRole("button", { name: /^Agregar$/ }));
      await esperar(page, 1500);
    }
  }
  for (const [i, lin] of l.lineas.entries()) {
    if (i > 0) {
      await clic(page.getByRole("button", { name: /Otro producto/ }));
      await esperar(page, 500);
    }
    await elegirEnPicker(page, page.getByLabel(`Producto de la línea ${i + 1}`), lin.producto);
    await esperar(page, 500);
    await page.getByLabel(`Cantidad de la línea ${i + 1}`).fill(lin.cantidad);
    // El precio de cada línea es un campo DOBLE (Bs | USD): se escribe en el de la moneda, en SU línea.
    if (lin.total) {
      await clic(page.getByLabel(/¿Qué precio vas a escribir\?/).nth(i));
      await esperar(page, 400);
      await clic(page.getByRole("option", { name: /El total de todas/ }).first());
      await esperar(page, 300);
    }
    const sufijo = (lin.monedaPrecio ?? l.moneda) === "VES" ? "-ves" : "-usd";
    await page
      .locator(`input[id$="${sufijo}"]`)
      .nth(i)
      .fill(lin.total ?? lin.unidad);
    await esperar(page, 1500); // el otro campo lo rellena el servidor
  }
  if (l.moneda)
    await elegirOpcion(
      page,
      /¿En qué moneda está la factura\?/,
      l.moneda === "USD" ? /Dólares/ : /Bolívares/,
    );
  if (l.fecha) await page.getByLabel(/¿Qué día llegó\?/).fill(l.fecha);
  await esperar(page, 1200);
  await ev(page, `${clave}-${l.id}-que-lleno`);
  pasos.seguirQue = await clic(page.getByRole("button", { name: /^Seguir$/ }));
  await esperar(page, 1000);
  // ¿Tienes la factura?
  if (l.proveedor) {
    const r = await ev(page, `${clave}-${l.id}-tarjetas-factura`);
    pasos.tarjetas = (
      r.texto.match(/Sí, aquí está|Todavía no me la dan|No va a haber factura/g) ?? []
    ).join(" | ");
    pasos.factura = await clic(page.getByText(l.factura).first());
    await esperar(page, 600);
    if (l.numero) {
      await page
        .getByLabel(/^N° de la factura/)
        .fill(l.numero)
        .catch(() => {});
      await page
        .getByLabel(/^N° de control/)
        .fill(l.control ?? "")
        .catch(() => {});
    }
    pasos.seguirFactura = await clic(page.getByRole("button", { name: /^Seguir$/ }));
    await esperar(page, 1000);
    // ¿Ya la pagaste?
    if (l.pago !== undefined) {
      await ev(page, `${clave}-${l.id}-pago`);
      pasos.pago = await clic(
        page.getByText(l.pago ? "Sí, ya la pagué" : "No, quedo debiendo").first(),
      );
      await esperar(page, 700);
      if (l.pago) {
        pasos.instrumento = await elegirOpcion(page, /¿Con qué la pagaste\?/, l.instrumento);
        await esperar(page, 700);
        if ((await page.getByLabel(/¿De qué cuenta salió\?/).count()) > 0)
          pasos.cuenta = await elegirOpcion(page, /¿De qué cuenta salió\?/, l.cuenta);
      }
      await ev(page, `${clave}-${l.id}-pago-lleno`);
      pasos.seguirPago = await clic(page.getByRole("button", { name: /^Seguir$/ }));
      await esperar(page, 1000);
    }
  }
  // ¿A qué depósito? (si hay más de uno) y ¿Todo bien?
  const r2 = await ev(page, `${clave}-${l.id}-antes-de-confirmar`);
  if (/¿A qué depósito\?/.test(r2.texto)) {
    await clic(page.getByText("Principal").first());
    await esperar(page, 800);
  }
  const t = await cronometrar(async () => {
    pasos.confirmar = await clic(page.getByRole("button", { name: /Sí, registrar la llegada/ }));
    await esperar(page, 3000);
  });
  let fin = await ev(page, `${clave}-${l.id}-registrada`, { ms: t.ms });
  if (l.sobregiro && (await page.getByRole("button", { name: /Registrarlo igual/ }).count()) > 0) {
    pasos.sobregiro = await clic(page.getByRole("button", { name: /Registrarlo igual/ }));
    await esperar(page, 3000);
    fin = await ev(page, `${clave}-${l.id}-registrada-con-sobregiro`);
  }
  return { pasos, avisos: fin.avisos, red: fin.red, texto: fin.texto.slice(0, 500) };
}

const r = {};
const resumen = (x) => ({ avisos: x.avisos, red: x.red, texto: x.texto.slice(0, 900) });
const FOTO = ".recorrido/2026-09-24/F/007-E1-mi-dinero.png"; // una imagen cualquiera como «foto del recibo»

async function gasto(page, ev, etq, { categoria, otra, cuenta, monto, nota, recurrente, foto }) {
  await page.goto(BASE + "/compras");
  await esperar(page, 2500);
  await clic(page.getByRole("button", { name: /^Registrar gasto$/ }).first());
  await esperar(page, 900);
  const d = dialogo(page);
  await clic(d.getByRole("button", { name: categoria, exact: true }));
  if (otra) await d.getByLabel("Categoría del gasto").fill(otra);
  await elegirOpcion(page, /^¿De qué cuenta salió\?/, cuenta);
  await d.getByLabel(/^¿Cuánto\?/).fill(monto);
  if (nota) await d.getByLabel(/^Algo más que anotar/).fill(nota);
  if (recurrente) await clic(d.getByLabel("Se paga todos los meses"));
  if (foto) await d.locator('input[type="file"]').setInputFiles(foto);
  await esperar(page, 800);
  await ev(page, `${etq}-lleno`);
  const t = await cronometrar(async () => {
    await clic(d.getByRole("button", { name: /^Registrar gasto$/ }));
    await esperar(page, 3000);
  });
  let x = await ev(page, `${etq}-hecho`, { ms: t.ms });
  if ((await page.getByRole("button", { name: /Registrarlo igual/ }).count()) > 0) {
    await clic(page.getByRole("button", { name: /Registrarlo igual/ }));
    await esperar(page, 3000);
    x = await ev(page, `${etq}-hecho-con-sobregiro`);
  }
  return { ms: t.ms, ...resumen(x) };
}

// ════════════════ E2 ════════════════
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("H", eventos);
  await login(page, E.personas.duenoE2E3, E.clave);

  r.gastoLuz = await gasto(page, ev, "E2-gasto-luz", {
    categoria: "Luz",
    cuenta: /Banco Mercantil/,
    monto: "1850",
    nota: "Luz de septiembre",
    recurrente: true,
    foto: FOTO,
  });
  r.gastoFlete = await gasto(page, ev, "E2-gasto-flete-usd", {
    categoria: "Otro…",
    otra: "Flete",
    cuenta: /Caja USD/,
    monto: "5",
    nota: "Flete del pedido de harina",
  });
  await page.goto(BASE + "/compras");
  await esperar(page, 2500);
  r.historialGastos = (await ev(page, "E2-historial-gastos")).texto.slice(0, 1500);
  await clic(page.getByRole("tab", { name: /Compras a proveedores/ }));
  await esperar(page, 1500);
  r.comprasProveedores = (await ev(page, "E2-compras-a-proveedores")).texto.slice(0, 1800);
  await page.goto(BASE + "/dinero");
  await esperar(page, 2500);
  r.miDineroDebo = (await ev(page, "E2-mi-dinero")).texto.slice(0, 900);
  await clic(page.getByRole("link", { name: /Ver qué debo/ }).first());
  await esperar(page, 2500);
  r.verQueDebo = {
    url: page.url(),
    texto: (await ev(page, "E2-ver-que-debo")).texto.slice(0, 900),
  };

  // abono de 20 USD en efectivo a la 000123 (USD, 24/09) con la tasa de hoy
  await page.goto(BASE + "/compras");
  await esperar(page, 2500);
  await clic(page.getByRole("tab", { name: /Compras a proveedores/ }));
  await esperar(page, 1500);
  const fila = page
    .locator("div")
    .filter({ hasText: /Factura 000123/ })
    .last();
  await clic(fila.getByRole("button", { name: /^Pagar/ }).first());
  await esperar(page, 1200);
  {
    const d = dialogo(page);
    await d.getByLabel(/^¿Cuánto pagas\?/).fill("20");
    r.pagoForma = await elegirOpcion(
      page,
      /^¿Con qué pagas\?/,
      /Efectivo USD|Efectivo \$|Efectivo en dólares/,
    );
    await esperar(page, 800);
    if ((await d.getByLabel(/^¿De qué cuenta sale\?/).count()) > 0)
      r.pagoCuenta = await elegirOpcion(page, /^¿De qué cuenta sale\?/, /Caja USD/);
    await ev(page, "E2-pago-000123-lleno");
    const t = await cronometrar(async () => {
      await clic(d.getByRole("button", { name: /^Registrar pago$/ }));
      await esperar(page, 3000);
    });
    r.pago000123 = { ms: t.ms, ...resumen(await ev(page, "E2-pago-000123-hecho", { ms: t.ms })) };
  }

  // Hacer un pedido
  await page.goto(BASE + "/compras");
  await esperar(page, 2500);
  await clic(page.getByRole("button", { name: /Hacer un pedido/ }));
  await esperar(page, 1000);
  {
    const d = dialogo(page);
    await elegirEnPicker(page, d.getByPlaceholder("Busca el proveedor…"), "Alimentos del Centro");
    await elegirEnPicker(
      page,
      d.getByPlaceholder("Busca el producto…").first(),
      "Harina precocida caja",
    );
    await d.getByLabel("Cuántos pides de la línea 1").fill("15");
    await d.getByLabel(/^Precio acordado de cada uno, línea 1/).fill("18");
    await esperar(page, 700);
    await ev(page, "E2-pedido-lleno");
    await clic(d.getByRole("button", { name: /^Hacer el pedido$/ }));
    await esperar(page, 3000);
    r.pedido = resumen(await ev(page, "E2-pedido-hecho"));
  }

  // Nota de crédito del proveedor sobre LM-5501 (admin → Compras → Cuentas por pagar)
  await page.goto(BASE + "/admin/compras");
  await esperar(page, 2500);
  await clic(page.getByRole("tab", { name: /Cuentas por pagar/ }));
  await esperar(page, 2000);
  r.cxp = (await ev(page, "E2-cuentas-por-pagar")).texto.slice(0, 1800);
  const filaLm = page
    .getByRole("row")
    .filter({ hasText: /LM-5501/ })
    .first();
  await clic(filaLm.getByRole("button", { name: /^NC/ }));
  await esperar(page, 1200);
  {
    const d = dialogo(page);
    await d.getByLabel(/^Nº de la nota/).fill("NC-0091");
    await d.getByLabel(/^Motivo/).fill("Devolución de 1 caja de aceite que llegó rota.");
    await elegirEnPicker(page, d.getByPlaceholder("Producto…").first(), "Aceite de soya");
    await d.getByLabel("Cantidad de la línea 1").fill("1");
    await d.getByLabel("Precio unitario de la línea 1").fill("20.50");
    await esperar(page, 700);
    await ev(page, "E2-nc-proveedor-lleno");
    await clic(d.getByRole("button", { name: /^Registrar/ }).last());
    await esperar(page, 3000);
    r.ncProveedor = resumen(await ev(page, "E2-nc-proveedor-hecha"));
  }
  await browser.close();
}

// ════════════════ E3 · retenciones ════════════════
{
  const cid = E.empresas.E3.id;
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("H", eventos);
  await login(page, E.personas.registraE3, E.clave);

  await page.goto(BASE + "/admin/compras");
  await esperar(page, 2500);
  await clic(page.getByRole("tab", { name: /Reglas de retención/ }));
  await esperar(page, 1800);
  r.reglasAntes = (await ev(page, "E3-reglas-vacias")).texto.slice(0, 1200);
  r.reglaConcepto = await elegirOpcion(page, /^Concepto/, /Retención de IVA en compras/);
  await page.getByLabel(/^Tasa/).fill("0.75");
  await page
    .getByLabel(/^Norma \(obligatoria\)/)
    .fill("PA SNAT/2025/000054 (vigente desde el 01/08/2025): 75 % general");
  await esperar(page, 600);
  await ev(page, "E3-regla-llena");
  await clic(page.getByRole("button", { name: /^Cargar( la)? regla/ }).first());
  await esperar(page, 900);
  await clic(page.getByRole("button", { name: /^Cargar la regla$/ }).last());
  await esperar(page, 2500);
  r.regla = resumen(await ev(page, "E3-regla-cargada"));
  r.reglasBase = sql(
    `select retention_code, concept_code, formula_kind, rate::text, effective_from, legal_source from public.retention_rules where company_id='${cid}'`,
  );

  r.compraBs = await llegada(page, ev, "E3", {
    id: "con-factura-bs",
    proveedor: { nombre: "Ferretería Industrial Lara, C.A." },
    lineas: [{ producto: "Cemento gris 42,5 kg", cantidad: "20", unidad: "9500" }],
    moneda: "VES",
    factura: "Sí, aquí está",
    numero: "F-89002",
    control: "00-004455",
    pago: false,
  });
  r.facturasE3 =
    sql(`select supplier_document_number, transaction_currency, subtotal_amount::text, tax_amount::text, total_amount::text,
                             retention_total::text, status from public.supplier_invoices where company_id='${cid}' order by created_at`);

  async function pagarAdmin(numero, { instrumento, moneda, importe, cuenta, ref }, etq) {
    await page.goto(BASE + "/admin/compras");
    await esperar(page, 2500);
    await clic(page.getByRole("tab", { name: /Cuentas por pagar/ }));
    await esperar(page, 2000);
    const fila = page
      .getByRole("row")
      .filter({ hasText: new RegExp(numero) })
      .first();
    await clic(fila.getByRole("button", { name: /^Pagar/ }));
    await esperar(page, 1200);
    const d = dialogo(page);
    const pasos = {};
    pasos.instrumento = await elegirOpcion(page, /^Instrumento/, instrumento);
    await esperar(page, 500);
    if (moneda && (await d.getByLabel(/^Moneda del pago/).count()) > 0)
      pasos.moneda = await elegirOpcion(page, /^Moneda del pago/, moneda);
    if (importe) await d.getByLabel(/^Importe bruto/).fill(importe);
    if (cuenta) pasos.cuenta = await elegirOpcion(page, /^Cuenta de la que sale/, cuenta);
    if (ref) await d.getByLabel(/^Referencia/).fill(ref);
    await esperar(page, 800);
    pasos.textoLleno = (await ev(page, `${etq}-lleno`)).texto.slice(0, 700);
    await clic(d.getByRole("button", { name: /^Pagar|^Registrar/ }).last());
    await esperar(page, 3000);
    let x = await ev(page, `${etq}-hecho`);
    if ((await page.getByRole("button", { name: /Registrarlo igual/ }).count()) > 0) {
      await clic(page.getByRole("button", { name: /Registrarlo igual/ }));
      await esperar(page, 3000);
      x = await ev(page, `${etq}-hecho-con-sobregiro`);
    }
    return { pasos, ...resumen(x) };
  }
  await page.goto(BASE + "/admin/compras");
  await esperar(page, 2500);
  await clic(page.getByRole("tab", { name: /Cuentas por pagar/ }));
  await esperar(page, 2000);
  r.cxpE3 = (await ev(page, "E3-cuentas-por-pagar")).texto.slice(0, 1800);
  r.pagoBs = await pagarAdmin(
    "F-89002",
    { instrumento: /^Transferencia/, cuenta: /Banesco/, ref: "TRF-5566" },
    "E3-pago-F89002",
  );
  r.pagoUsd = await pagarAdmin(
    "F-88771",
    { instrumento: /^Zelle/, importe: "50", cuenta: /Zelle/, ref: "ZL-7788" },
    "E3-pago-F88771-usd",
  );
  await page.goto(BASE + "/admin/compras");
  await esperar(page, 2500);
  await clic(page.getByRole("tab", { name: /Reglas de retención/ }));
  await esperar(page, 1800);
  r.comprobantes = (await ev(page, "E3-comprobantes")).texto.slice(0, 1500);
  await browser.close();
}

const intento = (q) => {
  try {
    return sql(q).map((x) => x.join(" | ").slice(0, 300));
  } catch (e) {
    return String(e).slice(0, 200);
  }
};
r.enBase = {
  gastos: intento(`select * from public.expenses order by created_at`),
  pagosProveedor: intento(`select * from public.supplier_payments order by created_at`),
  retenciones: intento(`select * from public.supplier_retentions order by created_at`),
  comprobantesRet: intento(`select * from public.retention_receipts order by created_at`),
  pedidos: intento(`select * from public.purchase_orders order by created_at`),
};
guardarEstado({ h: r });
console.log(JSON.stringify(r, null, 1).slice(0, 20000));

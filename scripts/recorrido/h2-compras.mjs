/**
 * BLOQUE H (2) · lo que h-compras.mjs no alcanzó: «Cuentas por pagar» (/admin/compras) pide ELEGIR un
 * proveedor antes de enseñar nada (el guion buscaba la fila directamente). Aquí: la nota de crédito del
 * proveedor sobre LM-5501 (E2) y toda la parte de E3 (regla de retención de IVA 75 %, compra en Bs con
 * factura a crédito, pago entero en Bs con retención, abono de 50 USD por Zelle a F-88771).
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

/** /admin/compras → «Cuentas por pagar» → elegir el proveedor. */
async function cxpDe(page, ev, etq, proveedor) {
  await page.goto(BASE + "/admin/compras");
  await esperar(page, 2500);
  await clic(page.getByRole("tab", { name: /Cuentas por pagar/ }));
  await esperar(page, 1500);
  await elegirEnPicker(
    page,
    page.getByPlaceholder("Elige un proveedor para ver su cuenta…"),
    proveedor,
  );
  await esperar(page, 2500);
  return (await ev(page, etq)).texto.slice(0, 1800);
}

// ════════════════ E2 · nota de crédito del proveedor ════════════════
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("H", eventos);
  await login(page, E.personas.duenoE2E3, E.clave);
  r.cxpLaMontana = await cxpDe(page, ev, "E2-cxp-la-montana", "Distribuidora La Montaña");
  const filaLm = page
    .getByRole("row")
    .filter({ hasText: /LM-5501/ })
    .first();
  r.botonNC = await clic(filaLm.getByRole("button", { name: /^NC/ }));
  await esperar(page, 1200);
  {
    const d = dialogo(page);
    await d
      .getByLabel(/^Nº de la nota/)
      .fill("NC-0091")
      .catch((e) => (r.faltaCampo = String(e).slice(0, 100)));
    await d
      .getByLabel(/^Motivo/)
      .fill("Devolución de 1 caja de aceite que llegó rota.")
      .catch(() => {});
    await elegirEnPicker(page, d.getByPlaceholder("Producto…").first(), "Aceite de soya");
    await d
      .getByLabel("Cantidad de la línea 1")
      .fill("1")
      .catch(() => {});
    await d
      .getByLabel("Precio unitario de la línea 1")
      .fill("20.50")
      .catch(() => {});
    await esperar(page, 700);
    await ev(page, "E2-nc-proveedor-lleno");
    await clic(d.getByRole("button", { name: /^Registrar/ }).last());
    await esperar(page, 3000);
    r.ncProveedor = resumen(await ev(page, "E2-nc-proveedor-hecha"));
  }
  r.cxpLaMontanaDespues = await cxpDe(
    page,
    ev,
    "E2-cxp-la-montana-despues",
    "Distribuidora La Montaña",
  );
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
    r[`cxp-${numero}`] = await cxpDe(page, ev, `${etq}-cxp`, "Ferretería Industrial Lara");
    const fila = page
      .getByRole("row")
      .filter({ hasText: new RegExp(numero) })
      .first();
    const pasos = {};
    pasos.boton = await clic(fila.getByRole("button", { name: /^Pagar/ }));
    await esperar(page, 1200);
    const d = dialogo(page);
    pasos.instrumento = await elegirOpcion(page, /^Instrumento/, instrumento);
    await esperar(page, 500);
    if (moneda && (await d.getByLabel(/^Moneda del pago/).count()) > 0)
      pasos.moneda = await elegirOpcion(page, /^Moneda del pago/, moneda);
    if (importe) await d.getByLabel(/^Importe bruto/).fill(importe);
    if (cuenta) pasos.cuenta = await elegirOpcion(page, /^Cuenta de la que sale/, cuenta);
    if (ref)
      await d
        .getByLabel(/^Referencia/)
        .fill(ref)
        .catch(() => {});
    await esperar(page, 800);
    pasos.textoLleno = (await ev(page, `${etq}-lleno`)).texto.slice(0, 900);
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
    return sql(q).map((x) => x.join(" | ").slice(0, 400));
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
  notasProveedor: intento(`select * from public.supplier_credit_notes order by created_at`),
};
guardarEstado({ h2: r });
console.log(JSON.stringify(r, null, 1).slice(0, 24000));

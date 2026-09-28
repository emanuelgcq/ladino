/**
 * BLOQUE D · LLEGÓ MERCANCÍA (ADR-0066) — cada camino que la pantalla tiene hoy, como el dueño.
 *   E2: con factura (USD, pagada desde un banco en Bs; por unidad, por total y por kilo) ·
 *       todavía sin factura (ayer, a crédito) · sin factura (en Bs, pagada en efectivo) · ya era mía.
 *   E1 (sin RIF): de un proveedor sin RIF (¿qué tarjetas de factura ofrece?) · ya era mía por kilo.
 *   E3: con factura a crédito (para pagarla con retenciones en el bloque H).
 * Después, en E2: «Falta la factura» → «Ya llegó la factura».
 * Pendiente para después (no se puede aún): la fecha hacia atrás CON ventas intermedias (tras E),
 * el almacenista recibiendo (tras N). No se puede nunca: lote/vencimiento, receta, producto al vuelo.
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

const PLAN = {
  E2: {
    correo: E.personas.duenoE2E3,
    llegadas: [
      {
        id: "con-factura",
        hecho:
          "select count(*) from public.supplier_invoices where supplier_document_number = '000123'",
        proveedor: { nombre: "Alimentos del Centro, C.A.", rif: "J-40111222-3" },
        lineas: [
          { producto: "Harina precocida caja x20", cantidad: "30", unidad: "18.00" },
          { producto: "Arroz caja x24", cantidad: "20", total: "440.00" },
          { producto: "Queso blanco a granel", cantidad: "25", unidad: "5.20" },
        ],
        moneda: "USD",
        factura: "Sí, aquí está",
        numero: "000123",
        control: "00-004511",
        pago: false,
      },
      {
        id: "falta-factura",
        proveedor: { nombre: "Distribuidora La Montaña", rif: "J-41222333-0" },
        hecho: `select count(*) from public.goods_receipts g join public.suppliers s on s.id = g.supplier_id where s.legal_name = 'Distribuidora La Montaña'`,
        lineas: [{ producto: "Aceite de soya", cantidad: "10", unidad: "20.50" }],
        moneda: "USD",
        factura: "Todavía no me la dan",
      },
      {
        id: "sin-factura",
        proveedor: { nombre: "Mercado Mayorista Informal", rif: "V-14555666" },
        hecho: `select count(*) from public.goods_receipts g join public.suppliers s on s.id = g.supplier_id where s.legal_name = 'Mercado Mayorista Informal'`,
        lineas: [{ producto: "Café molido caja x12", cantidad: "5", total: "120000.00" }],
        moneda: "VES",
        factura: "No va a haber factura",
        pago: true,
        instrumento: /Efectivo/,
        cuenta: /Caja Bs/,
        sobregiro: true,
      },
      {
        id: "ya-era-mia",
        omitir: "ya registrada en la pasada anterior",
        lineas: [{ producto: "Galletas surtidas caja x24", cantidad: "10", unidad: "16.00" }],
        moneda: "USD",
      },
    ],
  },
  E1: {
    correo: E.personas.duenaE1,
    llegadas: [
      {
        id: "proveedor-sin-rif",
        omitir:
          "bloqueado: exige el tipo de contribuyente y E1 (sin RIF) no tiene dónde declararlo",
        proveedor: { nombre: "Distribuidora El Carmen", rif: "V-10999888" },
        hecho: `select count(*) from public.goods_receipts g join public.suppliers s on s.id = g.supplier_id where s.legal_name = 'Distribuidora El Carmen'`,
        lineas: [{ producto: "Harina de maíz precocida", cantidad: "40", total: "36000.00" }],
        moneda: "VES",
        factura: "No va a haber factura",
        pago: true,
        instrumento: /Efectivo/,
        cuenta: /Caja de la bodega/,
      },
      {
        id: "kilo-ya-era-mia",
        omitir: "ya registrada en la pasada anterior",
        lineas: [{ producto: "Queso blanco a granel", cantidad: "10", unidad: "4.10" }],
        moneda: "USD",
      },
    ],
  },
  E3: {
    correo: E.personas.registraE3,
    llegadas: [
      {
        id: "con-factura-a-credito",
        hecho:
          "select count(*) from public.supplier_invoices where supplier_document_number = 'F-88771'",
        proveedor: { nombre: "Ferretería Industrial Lara, C.A.", rif: "J-30999888-7" },
        lineas: [
          { producto: "Clavos de 2 pulgadas", cantidad: "50", unidad: "1.60" },
          { producto: "Cemento gris", cantidad: "20", unidad: "8.70" },
        ],
        moneda: "USD",
        factura: "Sí, aquí está",
        numero: "F-88771",
        control: "00-120034",
        pago: false,
      },
    ],
  },
};

const resultados = {};
for (const [clave, p] of Object.entries(PLAN)) {
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("D", eventos);
  await login(page, p.correo, E.clave);
  resultados[clave] = {};
  for (const l of p.llegadas) {
    // Reanudable: cada llegada dice cómo reconocer que ya se hizo.
    if (l.omitir) {
      resultados[clave][l.id] = { saltado: l.omitir };
      continue;
    }
    if (l.hecho && Number(sql(l.hecho)[0]?.[0] ?? 0) > 0) {
      resultados[clave][l.id] = { saltado: "ya registrada" };
      continue;
    }
    try {
      resultados[clave][l.id] = await llegada(page, ev, clave, l);
    } catch (e) {
      resultados[clave][l.id] = { error: String(e).slice(0, 300) };
      await ev(page, `${clave}-${l.id}-FALLO`).catch(() => {});
    }
    guardarEstado({ d: resultados });
  }
  // E2: «Falta la factura» → «Ya llegó la factura».
  if (clave === "E2") {
    await page.goto(BASE + "/compras");
    await esperar(page, 2500);
    await clic(page.getByRole("tab", { name: /Falta la factura/ }));
    await esperar(page, 1500);
    await ev(page, "E2-falta-la-factura");
    if ((await page.getByRole("button", { name: /Ya llegó la factura/ }).count()) === 0) {
      resultados.E2.enganche = { saltado: "no hay nada en «Falta la factura»" };
      await browser.close();
      continue;
    }
    await clic(page.getByRole("button", { name: /Ya llegó la factura/ }).first());
    await esperar(page, 800);
    const d = dialogo(page);
    await d.getByLabel(/^N° de la factura/).fill("LM-5501");
    await d.getByLabel(/^N° de control/).fill("00-778812");
    await ev(page, "E2-enganchar-lleno");
    await clic(d.getByRole("button", { name: /Registrar la factura/ }));
    await esperar(page, 2500);
    const r = await ev(page, "E2-factura-enganchada");
    resultados.E2.enganche = { avisos: r.avisos, red: r.red };
  }
  const cid = E.empresas[clave].id;
  resultados[clave].base = {
    recepciones: sql(
      `select count(*) from public.goods_receipts where company_id='${cid}'`,
    )[0]?.[0],
    facturasProveedor: sql(
      `select count(*) from public.supplier_invoices where company_id='${cid}'`,
    )[0]?.[0],
    proveedores: sql(
      `select string_agg(legal_name||' ['||coalesce(tax_id,'sin RIF')||']', ', ') from public.suppliers where company_id='${cid}'`,
    )[0]?.[0],
  };
  guardarEstado({ d: resultados });
  await browser.close();
}
console.log(JSON.stringify(resultados, null, 1).slice(0, 7000));

/**
 * BLOQUE G · CORREGIR UNA VENTA — como el dueño.
 *   E2: factura fiada nueva → anularla (sin cobro); A-1 cobrada: ¿se puede anular? (pantalla y API);
 *       devolución de A-1 SIN rango de notas (¿qué pasa?), cargar los rangos de notas de crédito y débito
 *       (el de crédito, SOLAPADO con el de facturas A 1-5000: ¿lo acepta?), devolución de A-1 con saldo a
 *       favor, nota de crédito directa a A-4, nota de débito a A-3, y el saldo a favor APLICADO a una
 *       factura nueva de Abastos El Sol (lo que F no pudo probar).
 *   E1: devolución de R-6 con el dinero desde la caja → recibo de devolución (serie D) y su PDF.
 *   E3: rango de notas de crédito; devolución de A-4 (cobrada en Zelle CON IGTF): ¿qué pasa con el IGTF?
 */
import fs from "node:fs";
import path from "node:path";
import {
  abrir,
  API,
  BASE,
  DIR,
  dialogo,
  esperar,
  estado,
  guardarEstado,
  login,
  nuevaEvidencia,
  sql,
  cronometrar,
} from "./lib.mjs";
import { token, llamar } from "./api.mjs";

const E = estado();
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);
const r = {};
async function elegir(page, loc, opcion) {
  const a = await clic(loc);
  await esperar(page, 500);
  const b = await clic(page.getByRole("option", { name: opcion }).first());
  return [a, b].filter((x) => typeof x === "string").join(" / ") || "ok";
}
const idDoc = (cid, kind, serie, num) =>
  sql(
    `select id from public.documents where company_id='${cid}' and kind='${kind}' and series='${serie}' and document_number=${num}`,
  )[0]?.[0];
async function abrirDoc(page, id) {
  await page.goto(`${BASE}/admin/ventas/${id}`);
  await esperar(page, 3000);
}
const resumen = (x) => ({ avisos: x.avisos, red: x.red, texto: x.texto.slice(0, 900) });

async function facturaNueva(page, ev, etq, { cliente, producto, cantidad }) {
  await page.goto(BASE + "/admin/ventas/nueva");
  await esperar(page, 2500);
  await page.getByPlaceholder("Buscar por nombre o RIF…").fill(cliente);
  await esperar(page, 1300);
  await clic(page.getByRole("option", { name: new RegExp(cliente) }).first());
  await esperar(page, 600);
  await elegir(
    page,
    page
      .getByRole("combobox", { name: /Almacén/ })
      .or(page.getByText("¿De dónde sale?"))
      .first(),
    /Principal/,
  );
  await page.getByPlaceholder("Producto (nombre o SKU)…").first().fill(producto);
  await esperar(page, 1300);
  await clic(page.getByRole("option", { name: new RegExp(producto) }).first());
  await page.getByLabel("Cantidad").first().fill(cantidad);
  await esperar(page, 800);
  await ev(page, `${etq}-lleno`);
  await clic(page.getByRole("button", { name: /^Emitir factura/ }));
  await esperar(page, 900);
  await clic(page.getByRole("button", { name: /^Emitir la factura$/ }).last());
  await esperar(page, 3000);
  const x = await ev(page, `${etq}-emitida`);
  return { ...resumen(x), url: page.url() };
}

async function cargarRango(page, ev, etq, { clase, serie, desde, hasta }) {
  await page.goto(BASE + "/admin/facturacion-fiscal");
  await esperar(page, 3000);
  await clic(page.getByRole("button", { name: /Cargar ahora|Cargar otra/ }).first());
  await esperar(page, 900);
  const pasos = await elegir(page, page.getByLabel(/^Para qué documento/).first(), clase);
  await page
    .getByLabel(/^Serie/)
    .first()
    .fill(serie);
  await page
    .getByLabel(/^Desde/)
    .first()
    .fill(desde);
  await page
    .getByLabel(/^Hasta/)
    .first()
    .fill(hasta);
  await page
    .getByLabel(/^Imprenta autorizada/)
    .first()
    .fill("Gráficas Lara, C.A.");
  await ev(page, `${etq}-lleno`);
  await clic(page.getByRole("button", { name: /^Cargar rango$/ }).first());
  await esperar(page, 2500);
  const x = await ev(page, `${etq}-cargado`);
  return { pasos, ...resumen(x) };
}

async function devolucion(page, ev, etq, { lineas, desde, motivo }) {
  await clic(page.getByRole("button", { name: /^Devolución$/ }));
  await esperar(page, 1200);
  const d = dialogo(page);
  for (const [linea, cant] of lineas)
    await d
      .getByLabel(new RegExp(`^Cantidad a devolver de ${linea}`))
      .first()
      .fill(cant)
      .catch((e) => console.error("linea", linea, String(e).slice(0, 120)));
  if (desde) await elegir(page, d.getByLabel("Devolver el dinero desde"), desde);
  await d.getByLabel("Motivo de la devolución").fill(motivo);
  await esperar(page, 700);
  await ev(page, `${etq}-lleno`);
  const t = await cronometrar(async () => {
    await clic(d.getByRole("button", { name: /^Devolver|^Reintentar la confirmación/ }));
    await esperar(page, 3500);
  });
  const x = await ev(page, `${etq}-hecha`, { ms: t.ms });
  return { ms: t.ms, ...resumen(x) };
}

// ════════════════ E2 ════════════════
{
  const cid = E.empresas.E2.id;
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("G", eventos);
  await login(page, E.personas.duenoE2E3, E.clave);

  // 1 · factura fiada y anularla sin cobro
  r.fiadaParaAnular = await facturaNueva(page, ev, "E2-fiada-para-anular", {
    cliente: "Abastos El Sol",
    producto: "Pasta caja x20",
    cantidad: "2",
  });
  await clic(page.getByRole("button", { name: /^Anular$/ }));
  await esperar(page, 900);
  await page
    .getByLabel("Motivo de anulación")
    .fill("Se facturó al cliente equivocado; el pedido era de otra tienda.");
  // G-10 (PA 00071 art. 36): la factura es de hoy y no salió del negocio; la persona confirma
  // que tiene el original y las copias. Sin la casilla, «Anular la factura» queda apagado.
  await page.getByLabel(/original y todas las copias/).check();
  await ev(page, "E2-anular-lleno");
  await clic(page.getByRole("button", { name: /^Anular la factura$/ }).last());
  await esperar(page, 3000);
  r.anulada = resumen(await ev(page, "E2-anulada"));

  // 2 · A-1 cobrada: ¿hay «Anular»? Y por la API
  const a1 = idDoc(cid, "invoice", "A", 1);
  await abrirDoc(page, a1);
  const detA1 = await ev(page, "E2-A1-detalle");
  r.a1Botones = (detA1.interactivo?.botones ?? []).filter((b) =>
    /Anular|Devoluci|Nota|cobro|PDF/i.test(b),
  );
  const tk = await token(E.personas.duenoE2E3, E.clave);
  const x = await llamar(tk, cid, "POST", `/v1/invoices/${a1}/annul`, {
    company_id: cid,
    reason: "Prueba del recorrido: anular una factura cobrada",
    // G-10: se confirma el papel para que el 409 hable de la factura (cobrada, de otro día) y no
    // de la casilla que falta. No se anula: lo que sigue es la devolución, que es lo que ofrece la pantalla.
    originals_in_hand: true,
  });
  r.anularCobradaApi = { status: x.status, json: JSON.stringify(x.json).slice(0, 400) };

  // 3 · devolución de A-1 SIN rango de notas de crédito
  r.devolucionSinRango = await devolucion(page, ev, "E2-A1-devolucion-sin-rango", {
    lineas: [["Harina precocida", "2"]],
    motivo: "Dos bultos de harina llegaron mojados.",
  });
  await clic(dialogo(page).getByRole("button", { name: /Descartar el borrador|Cancelar/ }));
  await esperar(page, 1500);
  r.borradoresTrasDescartar = sql(
    `select kind, status, count(*) from public.documents where company_id='${cid}' and kind in ('credit_note','return') group by 1,2`,
  );

  // 4 · rangos de notas: crédito SOLAPADO con facturas (A 1-500), débito aparte (A 5001-5500)
  r.rangoNC = await cargarRango(page, ev, "E2-rango-nc-solapado", {
    clase: /Notas de crédito/,
    serie: "A",
    desde: "1",
    hasta: "500",
  });
  r.rangoND = await cargarRango(page, ev, "E2-rango-nd", {
    clase: /Notas de débito/,
    serie: "A",
    desde: "5001",
    hasta: "5500",
  });
  r.rangos = sql(
    `select kind, series, range_from, range_to, next_available from public.fiscal_number_ranges where company_id='${cid}' order by created_at`,
  );

  // 5 · devolución de A-1 con saldo a favor
  await abrirDoc(page, a1);
  r.devolucion = await devolucion(page, ev, "E2-A1-devolucion", {
    lineas: [["Harina precocida", "2"]],
    desde: /saldo a favor/i,
    motivo: "Dos bultos de harina llegaron mojados.",
  });

  // 6 · nota de crédito directa a A-4 (descuento en el queso)
  const a4 = idDoc(cid, "invoice", "A", 4);
  await abrirDoc(page, a4);
  await clic(page.getByRole("button", { name: /^Nota de crédito/ }));
  await esperar(page, 1200);
  {
    const d = dialogo(page);
    await d
      .getByLabel(/^Cantidad a acreditar de /)
      .first()
      .fill("0.5");
    await d
      .getByLabel("Motivo de la nota de crédito")
      .fill("Se cobró medio kilo de más en la balanza.");
    await ev(page, "E2-A4-nc-lleno");
    await clic(d.getByRole("button", { name: /^Emitir/ }));
    await esperar(page, 3000);
    r.ncDirecta = resumen(await ev(page, "E2-A4-nc-hecha"));
  }

  // 7 · nota de débito a A-3 (diferencia de precio)
  const a3 = idDoc(cid, "invoice", "A", 3);
  await abrirDoc(page, a3);
  await clic(page.getByRole("button", { name: /^Nota de débito/ }));
  await esperar(page, 1200);
  {
    const d = dialogo(page);
    await d.getByPlaceholder("Producto o servicio…").first().fill("Pasta caja x20");
    await esperar(page, 1300);
    await clic(page.getByRole("option", { name: /Pasta caja x20/ }).first());
    await d.getByLabel("Cantidad").first().fill("1");
    await d
      .getByLabel(/^Precio unitario en/)
      .first()
      .fill("2.00");
    await d
      .getByLabel("Motivo de la nota de débito")
      .fill("Diferencia de precio: la pasta subió el día de la venta.");
    await ev(page, "E2-A3-nd-lleno");
    await clic(d.getByRole("button", { name: /^Emitir/ }));
    await esperar(page, 3000);
    r.nd = resumen(await ev(page, "E2-A3-nd-hecha"));
  }

  // 8 · saldo a favor APLICADO: factura fiada nueva de Abastos El Sol, cobrada con su saldo a favor
  r.fiadaParaSaldo = await facturaNueva(page, ev, "E2-fiada-para-saldo", {
    cliente: "Abastos El Sol",
    producto: "Pasta caja x20",
    cantidad: "1",
  });
  await clic(page.getByRole("button", { name: /Registrar cobro/ }));
  await esperar(page, 1200);
  {
    const d = dialogo(page);
    r.saldoForma = await elegir(page, d.getByLabel(/^¿Cómo pagó\?/), /Saldo a favor/);
    await esperar(page, 900);
    await ev(page, "E2-saldo-a-favor-lleno");
    await clic(d.getByRole("button", { name: /^Registrar cobro$/ }));
    await esperar(page, 3000);
    r.saldoAplicado = resumen(await ev(page, "E2-saldo-a-favor-aplicado"));
  }
  await browser.close();
}

// ════════════════ E1 · recibo de devolución ════════════════
{
  const cid = E.empresas.E1.id;
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("G", eventos);
  await login(page, E.personas.duenaE1, E.clave);
  await abrirDoc(page, idDoc(cid, "receipt", "R", 6));
  await ev(page, "E1-R6-detalle");
  r.devolucionRecibo = await devolucion(page, ev, "E1-R6-devolucion", {
    lineas: [["Café", "1"]],
    desde: /Caja de la bodega/,
    motivo: "El café venía abierto.",
  });
  await browser.close();
}

// ════════════════ E3 · devolución de una factura cobrada con IGTF ════════════════
{
  const cid = E.empresas.E3.id;
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("G", eventos);
  await login(page, E.personas.registraE3, E.clave);
  r.rangoNCE3 = await cargarRango(page, ev, "E3-rango-nc", {
    clase: /Notas de crédito/,
    serie: "A",
    desde: "10001",
    hasta: "10500",
  });
  await abrirDoc(page, idDoc(cid, "invoice", "A", 4));
  const det = await ev(page, "E3-A4-detalle");
  r.e3A4Lineas = det.texto.slice(0, 900);
  const lineasA4 =
    sql(`select description, quantity::text from public.document_lines l join public.documents d on d.id = l.document_id
                         where d.company_id='${cid}' and d.series='A' and d.document_number=4 and d.kind='invoice'`);
  r.devolucionIgtf = await devolucion(page, ev, "E3-A4-devolucion", {
    lineas: lineasA4.map(([desc, q]) => [
      desc.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      String(Number(q)),
    ]),
    desde: /saldo a favor/i,
    motivo: "El cliente devolvió todo: se equivocó de medida.",
  });
  await browser.close();
}

// ── PDF de las notas y del recibo de devolución (la llamada del botón «PDF») ──
{
  const destino = path.join(DIR, "G", "pdf");
  fs.mkdirSync(destino, { recursive: true });
  const dueños = { E1: E.personas.duenaE1, E2: E.personas.duenoE2E3, E3: E.personas.registraE3 };
  r.pdfs = [];
  for (const [clave, correo] of Object.entries(dueños)) {
    const cid = E.empresas[clave].id;
    const tk = await token(correo, E.clave);
    const docs =
      sql(`select id, kind, series||'-'||coalesce(document_number::text,'borrador') from public.documents
                       where company_id='${cid}' and kind in ('credit_note','debit_note','receipt_return','invoice')
                         and created_at > now() - interval '40 minutes' order by created_at`);
    for (const [id, kind, num] of docs) {
      const res = await fetch(`${API}/v1/documents/${id}/pdf`, {
        headers: { Authorization: `Bearer ${tk}`, "X-Company-Id": cid },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const nombre = `${clave}-${kind}-${num}.pdf`;
      if (res.status === 200) fs.writeFileSync(path.join(destino, nombre), buf);
      r.pdfs.push(`${res.status} ${nombre} ${buf.length}`);
    }
  }
}

r.documentos =
  sql(`select c.trade_name, d.kind, d.series||'-'||coalesce(d.document_number::text,'—'), d.status, d.total_amount::text,
                           coalesce(d.control_number::text, '—'), coalesce(src.series||'-'||src.document_number, '—')
                      from public.documents d join public.companies c on c.id = d.company_id
                      left join public.documents src on src.id = d.source_document_id
                     where d.created_at > now() - interval '40 minutes' order by d.created_at`);
r.creditos =
  sql(`select c.trade_name, cc.amount::text, cc.applied_amount::text, cc.status, cc.currency
                    from public.customer_credits cc join public.companies c on c.id = cc.company_id order by cc.created_at`);
guardarEstado({ g: r });
console.log(JSON.stringify(r, null, 1).slice(0, 16000));

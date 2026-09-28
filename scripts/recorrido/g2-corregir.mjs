/**
 * BLOQUE G (2) · lo que g-corregir.mjs no hizo por un error del GUION (el botón de la devolución se llama
 * «Confirmar la devolución»): la devolución de A-1 en E2 con saldo a favor y ese saldo APLICADO a la A-7
 * fiada de Abastos El Sol; el recibo de devolución de R-6 en E1 con su PDF; la devolución de A-4 en E3
 * (cobrada en Zelle con IGTF). Y, como sustituto de «devolución sin rango» (E2 ya tiene el rango): una
 * nota de débito en E3, que NO tiene rango de notas de débito. Más: el saldo a favor de Pedro Rivas (nota
 * de crédito directa) en /admin/cuentas — ¿se puede devolver en dinero?
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
    await clic(
      d.getByRole("button", { name: /^Confirmar la devolución|^Reintentar la confirmación/ }),
    );
    await esperar(page, 3500);
  });
  const x = await ev(page, `${etq}-hecha`, { ms: t.ms });
  return { ms: t.ms, ...resumen(x) };
}

async function cobrarConSaldo(page, ev, etq) {
  await clic(page.getByRole("button", { name: /Registrar cobro/ }));
  await esperar(page, 1200);
  const d = dialogo(page);
  const forma = await elegir(page, d.getByLabel(/^¿Cómo pagó\?/), /Saldo a favor/);
  await esperar(page, 900);
  const cual = await elegir(page, d.getByLabel(/^Saldo a favor a aplicar/), /./);
  await esperar(page, 700);
  await ev(page, `${etq}-lleno`);
  await clic(d.getByRole("button", { name: /^Registrar cobro$/ }));
  await esperar(page, 3000);
  return { forma, cual, ...resumen(await ev(page, `${etq}-hecho`)) };
}

// ════════════════ E2 ════════════════
{
  const cid = E.empresas.E2.id;
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("G", eventos);
  await login(page, E.personas.duenoE2E3, E.clave);
  await abrirDoc(page, idDoc(cid, "invoice", "A", 1));
  r.devolucion = await devolucion(page, ev, "E2-A1-devolucion", {
    lineas: [["Harina precocida", "2"]],
    desde: /saldo a favor/i,
    motivo: "Dos bultos de harina llegaron mojados.",
  });
  await abrirDoc(page, idDoc(cid, "invoice", "A", 1));
  r.a1TrasDevolucion = (await ev(page, "E2-A1-tras-devolucion")).texto.slice(0, 1400);
  // el saldo a favor de Abastos, aplicado a su A-7 fiada
  await abrirDoc(page, idDoc(cid, "invoice", "A", 7));
  r.saldoAplicado = await cobrarConSaldo(page, ev, "E2-A7-saldo-a-favor");
  await abrirDoc(page, idDoc(cid, "invoice", "A", 7));
  r.a7TrasSaldo = (await ev(page, "E2-A7-tras-saldo")).texto.slice(0, 1200);
  // el saldo a favor de Pedro Rivas (nota de crédito directa): ¿se puede devolver en dinero?
  const pedro = sql(
    `select id from public.customers where company_id='${cid}' and legal_name='Pedro Rivas'`,
  )[0]?.[0];
  await page.goto(`${BASE}/admin/cuentas?cliente=${pedro}`);
  await esperar(page, 3000);
  const cp = await ev(page, "E2-pedro-saldo-a-favor");
  r.pedro = { texto: cp.texto.slice(0, 1500), botones: (cp.interactivo?.botones ?? []).slice(-12) };
  await browser.close();
}

// ════════════════ E1 · recibo de devolución ════════════════
{
  const cid = E.empresas.E1.id;
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("G", eventos);
  await login(page, E.personas.duenaE1, E.clave);
  await abrirDoc(page, idDoc(cid, "receipt", "R", 6));
  r.devolucionRecibo = await devolucion(page, ev, "E1-R6-devolucion", {
    lineas: [["Café", "1"]],
    desde: /Caja de la bodega/,
    motivo: "El café venía abierto.",
  });
  await abrirDoc(page, idDoc(cid, "receipt", "R", 6));
  r.r6TrasDevolucion = (await ev(page, "E1-R6-tras-devolucion")).texto.slice(0, 1400);
  await browser.close();
}

// ════════════════ E3 · devolución con IGTF; nota de débito sin rango ════════════════
{
  const cid = E.empresas.E3.id;
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("G", eventos);
  await login(page, E.personas.registraE3, E.clave);
  await abrirDoc(page, idDoc(cid, "invoice", "A", 4));
  r.devolucionIgtf = await devolucion(page, ev, "E3-A4-devolucion", {
    lineas: [["Destornillador", "2"]],
    desde: /saldo a favor/i,
    motivo: "El cliente devolvió todo: se equivocó de medida.",
  });
  await abrirDoc(page, idDoc(cid, "invoice", "A", 4));
  r.a4TrasDevolucion = (await ev(page, "E3-A4-tras-devolucion")).texto.slice(0, 1400);
  // nota de débito en E3, que no tiene rango de notas de débito
  await abrirDoc(page, idDoc(cid, "invoice", "A", 3));
  await clic(page.getByRole("button", { name: /^Nota de débito/ }));
  await esperar(page, 1200);
  {
    const d = dialogo(page);
    await d.getByPlaceholder("Producto o servicio…").first().fill("Brocha");
    await esperar(page, 1300);
    await clic(page.getByRole("option", { name: /Brocha/ }).first());
    await d.getByLabel("Cantidad").first().fill("1");
    await d
      .getByLabel(/^Precio unitario en/)
      .first()
      .fill("1.00");
    await d.getByLabel("Motivo de la nota de débito").fill("Flete de la entrega a la obra.");
    await ev(page, "E3-A3-nd-sin-rango-lleno");
    await clic(d.getByRole("button", { name: /^Emitir/ }));
    await esperar(page, 3000);
    r.ndSinRango = resumen(await ev(page, "E3-A3-nd-sin-rango-hecha"));
  }
  await browser.close();
}

// ── PDF de los documentos nuevos ──
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
                       where company_id='${cid}' and kind in ('credit_note','debit_note','receipt_return')
                       order by created_at`);
    for (const [id, kind, num] of docs) {
      for (const copia of kind === "receipt_return" ? [false] : [false, true]) {
        const res = await fetch(`${API}/v1/documents/${id}/pdf${copia ? "?copia=1" : ""}`, {
          headers: { Authorization: `Bearer ${tk}`, "X-Company-Id": cid },
        });
        const buf = Buffer.from(await res.arrayBuffer());
        const nombre = `${clave}-${kind}-${num}${copia ? "-COPIA" : ""}.pdf`;
        if (res.status === 200) fs.writeFileSync(path.join(destino, nombre), buf);
        r.pdfs.push(`${res.status} ${nombre} ${buf.length}`);
      }
    }
  }
}

r.documentos =
  sql(`select c.trade_name, d.kind, d.series||'-'||coalesce(d.document_number::text,'—'), d.status, d.total_amount::text,
                           coalesce(d.control_number::text, '—'), coalesce(src.series||'-'||src.document_number, '—')
                      from public.documents d join public.companies c on c.id = d.company_id
                      left join public.documents src on src.id = d.source_document_id
                     where d.created_at > now() - interval '25 minutes' order by d.created_at`);
r.creditos =
  sql(`select c.trade_name, cu.legal_name, cc.amount::text, cc.applied_amount::text, cc.status, cc.currency
                    from public.customer_credits cc join public.companies c on c.id = cc.company_id
                    join public.customers cu on cu.id = cc.customer_id order by cc.created_at`);
r.igtfE3 =
  sql(`select d.series||'-'||d.document_number, i.amount::text, i.currency, i.status, coalesce(i.status_reason,'')
                  from public.igtf_perceptions i join public.documents d on d.id = i.document_id
                 where i.company_id='${E.empresas.E3.id}' order by i.created_at`);
guardarEstado({ g2: r });
console.log(JSON.stringify(r, null, 1).slice(0, 16000));

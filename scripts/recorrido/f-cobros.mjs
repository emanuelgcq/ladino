/**
 * BLOQUE F · COBROS Y DEUDAS — como el dueño.
 *   · E1: cobrar PARTE de la deuda de Luisa Pérez (R-5, fiado) desde su ficha en /admin/clientes;
 *     «Lo que me debe»; el enlace de WhatsApp. «Desde Mi dinero»: ¿dónde se cobra una deuda?
 *   · E2: cobrar DE MÁS a la Alcaldía (A-2) — el servidor lo rechaza y manda a una nota de crédito —,
 *     corregir el importe y reintentar EN EL MISMO DIÁLOGO (la llave de idempotencia nace una vez por
 *     apertura: ¿el reintento corregido pasa?). Después, /admin/cuentas: saldo, aging y colores.
 *   · E3: la RETENCIÓN SOPORTADA de Inversiones Metálicas (cliente especial, A-5 fiada) en
 *     /admin/declaraciones → «Retenciones que nos hicieron»; un abono en Zelle a esa factura fiada (¿se
 *     percibe IGTF al cobrar una factura ya emitida? — pregunta de E-03) y el cobro del resto.
 *   · El paso del tiempo (aging 30/60/90): una factura con fecha de hace 40 días por la API.
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
import { token, llamar } from "./api.mjs";

const E = estado();
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);
const r = {};

async function elegir(page, loc, opcion) {
  const a = await clic(loc);
  await esperar(page, 500);
  const b = await clic(page.getByRole("option", { name: opcion }).first());
  return [a, b].filter(Boolean).join(" / ") || "ok";
}
async function abrirCliente(page, nombre) {
  await page.goto(BASE + "/admin/clientes");
  await esperar(page, 2500);
  await clic(page.getByText(nombre, { exact: true }).first());
  await esperar(page, 2000);
}
/** Llena el diálogo de cobro abierto. No pulsa «Registrar cobro». */
async function llenarCobro(page, { forma, monto, cuenta, ref }) {
  const d = dialogo(page);
  const pasos = {};
  if (forma) pasos.forma = await elegir(page, d.getByLabel(/^¿Cómo pagó\?/), forma);
  await esperar(page, 600);
  if (monto !== undefined)
    await d
      .getByLabel(/^¿Cuánto pagó\?/)
      .fill(monto)
      .catch((e) => (pasos.monto = String(e).slice(0, 80)));
  if (ref)
    await d
      .getByLabel(/^Referencia/)
      .fill(ref)
      .catch(() => (pasos.ref = "sin campo"));
  if (cuenta) pasos.cuenta = await elegir(page, d.getByLabel(/^¿A qué cuenta entra\?/), cuenta);
  await esperar(page, 1200);
  return pasos;
}
async function registrar(page, ev, etq) {
  const d = dialogo(page);
  const t = await cronometrar(async () => {
    await clic(d.getByRole("button", { name: /^Registrar cobro$/ }));
    await esperar(page, 2800);
  });
  const x = await ev(page, etq, { ms: t.ms });
  return { avisos: x.avisos, red: x.red, ms: t.ms, texto: x.texto.slice(0, 700) };
}

// ── E1 · cobro parcial desde la ficha del cliente; «Lo que me debe»; Mi dinero ──
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("F", eventos);
  await login(page, E.personas.duenaE1, E.clave);
  await abrirCliente(page, "Luisa Pérez");
  const ficha = await ev(page, "E1-ficha-luisa");
  r.fichaLuisa = ficha.texto.slice(0, 1000);
  r.whatsapp = (ficha.interactivo?.enlaces ?? []).filter((e) => /wa\.me/.test(e));
  await clic(
    dialogo(page)
      .getByRole("button", { name: /^Cobrar$/ })
      .first(),
  );
  await esperar(page, 1500);
  await ev(page, "E1-cobrar-abierto");
  r.pasosE1 = await llenarCobro(page, { forma: /Pago móvil/i, monto: "1500", ref: "PM-7788" });
  await ev(page, "E1-cobro-parcial-lleno");
  r.cobroParcialE1 = await registrar(page, ev, "E1-cobro-parcial-hecho");
  await page.keyboard.press("Escape");
  await esperar(page, 800);
  await abrirCliente(page, "Luisa Pérez");
  r.fichaLuisaDespues = (await ev(page, "E1-ficha-luisa-despues")).texto.slice(0, 1000);
  // «Lo que me debe» → /admin/cuentas?cliente=…
  await clic(
    dialogo(page)
      .getByRole("link", { name: /Lo que me debe|Estado de cuenta/ })
      .first(),
  );
  await esperar(page, 3000);
  r.cuentaLuisa = (await ev(page, "E1-lo-que-me-debe")).texto.slice(0, 1500);
  // «Desde Mi dinero»: ¿hay dónde cobrar una deuda?
  await page.goto(BASE + "/dinero");
  await esperar(page, 3000);
  const dinero = await ev(page, "E1-mi-dinero");
  r.miDinero = {
    botones: (dinero.interactivo?.botones ?? []).slice(0, 40),
    texto: dinero.texto.slice(0, 1200),
  };
  await browser.close();
}

// ── E2 · cobro de más (rechazo), corregir y reintentar en el mismo diálogo; aging ──
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("F", eventos);
  await login(page, E.personas.duenoE2E3, E.clave);
  await abrirCliente(page, "Alcaldía de Iribarren");
  r.fichaAlcaldia = (await ev(page, "E2-ficha-alcaldia")).texto.slice(0, 1000);
  await clic(
    dialogo(page)
      .getByRole("button", { name: /^Cobrar$/ })
      .first(),
  );
  await esperar(page, 1500);
  r.pasosE2 = await llenarCobro(page, {
    forma: /Transferencia/i,
    monto: "150000",
    ref: "TRF-9001",
  });
  await ev(page, "E2-cobro-de-mas-lleno");
  r.cobroDeMas = await registrar(page, ev, "E2-cobro-de-mas-rechazo");
  // La persona corrige el importe en el mismo diálogo y vuelve a registrar.
  await dialogo(page)
    .getByLabel(/^¿Cuánto pagó\?/)
    .fill("50000")
    .catch(() => {});
  await esperar(page, 800);
  await ev(page, "E2-corregido-lleno");
  r.corregido = await registrar(page, ev, "E2-corregido-reintento");
  const pagosA2 = () =>
    sql(`select count(*) from public.payments p join public.documents d on d.id = p.document_id
          where d.company_id='${E.empresas.E2.id}' and d.series='A' and d.document_number=2`)[0]?.[0];
  r.pagosA2TrasReintento = pagosA2();
  if (r.pagosA2TrasReintento === "1") {
    // El reintento no pasó: cerrar, volver a abrir (llave nueva) y cobrar 50.000.
    await page.keyboard.press("Escape");
    await esperar(page, 800);
    await abrirCliente(page, "Alcaldía de Iribarren");
    await clic(
      dialogo(page)
        .getByRole("button", { name: /^Cobrar$/ })
        .first(),
    );
    await esperar(page, 1500);
    await llenarCobro(page, { forma: /Transferencia/i, monto: "50000", ref: "TRF-9001" });
    r.cobroNuevoDialogo = await registrar(page, ev, "E2-cobro-dialogo-nuevo");
    r.pagosA2Final = pagosA2();
  }
  await page.keyboard.press("Escape");
  await esperar(page, 800);
  await abrirCliente(page, "Alcaldía de Iribarren");
  await clic(
    dialogo(page)
      .getByRole("link", { name: /Estado de cuenta|Lo que me debe/ })
      .first(),
  );
  await esperar(page, 3000);
  r.cuentasAlcaldia = (await ev(page, "E2-cuentas-alcaldia")).texto.slice(0, 1800);
  // /admin/cuentas sin cliente: ¿hay una vista de TODOS los que deben?
  await page.goto(BASE + "/admin/cuentas");
  await esperar(page, 2500);
  r.cuentasEntrada = (await ev(page, "E2-cuentas-entrada")).texto.slice(0, 800);
  await browser.close();
}

// ── E3 · retención soportada, abono en Zelle a la factura fiada, cobro del resto ──
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("F", eventos);
  await login(page, E.personas.registraE3, E.clave);
  await page.goto(BASE + "/admin/declaraciones");
  await esperar(page, 3000);
  await ev(page, "E3-declaraciones");
  await clic(page.getByRole("tab", { name: /Retenciones que nos hicieron/ }));
  await esperar(page, 1500);
  await ev(page, "E3-retenciones-tab");
  await clic(page.getByRole("button", { name: /^Cargar un comprobante$/ }).first());
  await esperar(page, 1000);
  await page.getByPlaceholder("Buscar cliente…").fill("Inversiones");
  await esperar(page, 1500);
  await clic(page.getByRole("option", { name: /Inversiones Metálicas/ }).first());
  await esperar(page, 900);
  await page
    .getByPlaceholder("Buscar factura…")
    .click()
    .catch(() => {});
  await page.getByPlaceholder("Buscar factura…").fill("5");
  await esperar(page, 1500);
  await clic(page.getByRole("option", { name: /A-5/ }).first());
  await esperar(page, 900);
  await page.getByLabel(/^Nº del comprobante/).fill("20260900000123");
  // Base = el IVA de la factura A-5 (3.580,20); 75 % → 2.685,15.
  await page.getByLabel(/^Base \(el IVA/).fill("3580.20");
  await page.getByLabel(/^Monto retenido/).fill("2685.15");
  await esperar(page, 800);
  await ev(page, "E3-retencion-llena");
  const t = await cronometrar(async () => {
    await clic(page.getByRole("button", { name: /^Guardar y abonar la factura$/ }));
    await esperar(page, 2800);
  });
  const ret = await ev(page, "E3-retencion-guardada", { ms: t.ms });
  r.retencion = { avisos: ret.avisos, red: ret.red, ms: t.ms, texto: ret.texto.slice(0, 900) };

  await abrirCliente(page, "Inversiones Metálicas Lara, C.A.");
  r.fichaEspecial = (await ev(page, "E3-ficha-especial")).texto.slice(0, 1000);
  // Abono de 10 USD por Zelle a la factura fiada: ¿percibe IGTF al cobrar?
  await clic(
    dialogo(page)
      .getByRole("button", { name: /^Cobrar$/ })
      .first(),
  );
  await esperar(page, 1500);
  r.pasosZelle = await llenarCobro(page, { forma: /Zelle/i, monto: "10", ref: "ZL-4455" });
  await ev(page, "E3-abono-zelle-lleno");
  r.abonoZelle = await registrar(page, ev, "E3-abono-zelle-hecho");
  await page.keyboard.press("Escape");
  await esperar(page, 800);
  // El resto por transferencia (el importe que propone el diálogo = el saldo).
  await abrirCliente(page, "Inversiones Metálicas Lara, C.A.");
  await clic(
    dialogo(page)
      .getByRole("button", { name: /^Cobrar$/ })
      .first(),
  );
  await esperar(page, 1500);
  r.pasosResto = await llenarCobro(page, { forma: /Transferencia/i, ref: "TRF-3301" });
  await ev(page, "E3-cobro-resto-lleno");
  r.cobroResto = await registrar(page, ev, "E3-cobro-resto-hecho");
  await page.keyboard.press("Escape");
  await esperar(page, 800);
  await abrirCliente(page, "Inversiones Metálicas Lara, C.A.");
  r.fichaEspecialDespues = (await ev(page, "E3-ficha-especial-despues")).texto.slice(0, 800);
  await browser.close();
}

// ── El paso del tiempo: ¿se puede crear una factura de hace 40 días? (API) ──
{
  const tk = await token(E.personas.duenoE2E3, E.clave);
  const cid = E.empresas.E2.id;
  const cliente = sql(
    `select id from public.customers where company_id='${cid}' and legal_name ilike 'Abastos El Sol%'`,
  )[0]?.[0];
  const almacen = sql(
    `select id from public.warehouses where company_id='${cid}' order by created_at limit 1`,
  )[0]?.[0];
  const producto = sql(
    `select id from public.products where company_id='${cid}' and name ilike 'Pasta caja x20%'`,
  )[0]?.[0];
  const hace40 = new Date(Date.now() - 40 * 86400e3).toISOString();
  const x = await llamar(tk, cid, "POST", "/v1/invoices", {
    company_id: cid,
    customer_id: cliente,
    warehouse_id: almacen,
    issued_at: hace40,
    lines: [{ product_id: producto, quantity: "1" }],
  });
  r.facturaHace40 = { status: x.status, json: JSON.stringify(x.json).slice(0, 500) };
}

r.cobros =
  sql(`select c.trade_name, p.instrument, p.amount::text||' '||p.currency, p.functional_amount::text,
                       coalesce(d.series||'-'||d.document_number,'-'), p.supported_retention_id is not null
                  from public.payments p join public.companies c on c.id = p.company_id
                  left join public.documents d on d.id = p.document_id
                 where p.created_at > now() - interval '30 minutes' order by p.created_at`);
r.igtf =
  sql(`select d.series||'-'||d.document_number, i.base_amount::text, i.amount::text, i.currency
                from public.igtf_perceptions i join public.payments p on p.id = i.payment_id
                join public.documents d on d.id = p.document_id
               where i.created_at > now() - interval '30 minutes'`);
guardarEstado({ f: r });
console.log(JSON.stringify(r, null, 1).slice(0, 12000));

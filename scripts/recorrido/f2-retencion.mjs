/**
 * BLOQUE F (2) · la retención soportada con la MISMA tasa del día.
 *   En f-cobros.mjs, cargar el comprobante de retención de la A-5 de E3 (emitida el 24/09 a 854,4637) el
 *   25/09 (tasa 855,6625) falló: «La plantilla de payment_received/ar.retention_applied produce un asiento
 *   descuadrado». Aquí: una venta fiada nueva al mismo cliente especial HOY, y su comprobante HOY, para
 *   separar «falla siempre» de «falla cuando la tasa cambió». Después, el cobro del resto.
 */
import {
  abrir,
  BASE,
  dialogo,
  esperar,
  estado,
  fijarLimiteDeFiado,
  guardarEstado,
  login,
  nuevaEvidencia,
  rellenarCuandoPaga,
  sql,
  cronometrar,
} from "./lib.mjs";

const E = estado();
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);
const r = {};
const cid = E.empresas.E3.id;
// R-82.7: fiar exige límite (E-09). Antes de abrir la caja: la cotización lo lee al identificar.
fijarLimiteDeFiado(cid);

const { browser, page, eventos } = await abrir();
const ev = nuevaEvidencia("F", eventos);
await login(page, E.personas.registraE3, E.clave);

// ── venta fiada en la caja al cliente especial ──────────────────────────────
await page.goto(BASE + "/vender");
await esperar(page, 3000);
if ((await page.getByLabel("Cédula o RIF del cliente").count()) === 0)
  await clic(page.getByRole("button", { name: /Poner cliente/ }).first(), 3000);
await clic(page.locator("#pos-prefijo"));
await clic(page.getByRole("option", { name: "J", exact: true }).first());
await page.getByLabel("Cédula o RIF del cliente").fill("307776665");
await page.getByLabel("Cédula o RIF del cliente").press("Enter");
await esperar(page, 1800);
for (const p of ["Llave inglesa", "Pintura de caucho"]) {
  await page.getByLabel("Buscar productos para vender").fill(p);
  await esperar(page, 1400);
  await clic(page.getByRole("button", { name: new RegExp(p) }).first());
  await esperar(page, 900);
}
await ev(page, "E3-mismo-dia-carrito");
await clic(page.getByRole("button", { name: /Cobrar\s*·\s*F2/ }).first());
await esperar(page, 1200);
await clic(
  dialogo(page)
    .getByRole("button", { name: /Fiar todo/ })
    .first(),
);
await esperar(page, 800);
await rellenarCuandoPaga(page); // P-05: sin la fecha, la caja no deja confirmar
await clic(page.getByRole("button", { name: /Fiar y registrar/ }).first());
await esperar(page, 3000);
const vendida = await ev(page, "E3-mismo-dia-fiado");
r.venta = { avisos: vendida.avisos, red: vendida.red };
await clic(page.getByRole("button", { name: /Nueva venta/ }).first(), 3000);

const [doc] = sql(`select id, series||'-'||document_number, tax_amount::text, total_amount::text
                     from public.documents where company_id='${cid}' and kind='invoice' and status='issued'
                     order by created_at desc limit 1`);
r.documento = doc;
const iva = Number(doc?.[2] ?? "0");
const retenido = (Math.round(iva * 0.75 * 100) / 100).toFixed(2);
r.base = iva.toFixed(2);
r.retenido = retenido;

// ── el comprobante de retención, el mismo día ───────────────────────────────
await page.goto(BASE + "/admin/declaraciones");
await esperar(page, 3000);
await clic(page.getByRole("tab", { name: /Retenciones que nos hicieron/ }));
await esperar(page, 1500);
await clic(page.getByRole("button", { name: /^Cargar un comprobante$/ }).first());
await esperar(page, 1000);
await page.getByPlaceholder("Buscar cliente…").fill("Inversiones");
await esperar(page, 1500);
await clic(page.getByRole("option", { name: /Inversiones Metálicas/ }).first());
await esperar(page, 900);
await page.getByPlaceholder("Buscar factura…").fill(String(doc?.[1] ?? "").replace(/^A-/, ""));
await esperar(page, 1500);
await clic(page.getByRole("option", { name: new RegExp(`^${doc?.[1]}`) }).first());
await esperar(page, 900);
await page.getByLabel(/^Nº del comprobante/).fill("20260900000124");
await page.getByLabel(/^Base \(el IVA/).fill(r.base);
await page.getByLabel(/^Monto retenido/).fill(retenido);
await esperar(page, 800);
await ev(page, "E3-mismo-dia-retencion-llena");
const t = await cronometrar(async () => {
  await clic(page.getByRole("button", { name: /^Guardar y abonar la factura$/ }));
  await esperar(page, 2800);
});
const ret = await ev(page, "E3-mismo-dia-retencion-guardada", { ms: t.ms });
r.retencion = { avisos: ret.avisos, red: ret.red, ms: t.ms, texto: ret.texto.slice(0, 1400) };

r.enBase = {
  retenciones: sql(`select receipt_number, base::text, rate::text, amount::text, retained_on
                      from public.supported_retention_receipts where company_id='${cid}'`),
  pagos:
    sql(`select instrument, amount::text, currency, functional_amount::text, supported_retention_id is not null
                from public.payments where document_id='${doc?.[0]}' order by created_at`),
  asiento: sql(`select a.code, l.debit::text, l.credit::text from public.journal_lines l
                  join public.journal_entries e on e.id = l.journal_entry_id
                  join public.accounts a on a.id = l.account_id
                 where e.company_id='${cid}' and e.source_kind = 'payment_received'
                   and e.created_at > now() - interval '5 minutes' order by l.debit desc`),
};
await browser.close();
guardarEstado({ f2: r });
console.log(JSON.stringify(r, null, 1).slice(0, 8000));

/**
 * BLOQUE M · DE RECIBOS A FACTURAS — E1 (Bodega La Esquina) saca su RIF y pasa a ser E4.
 *   Desde la caja («Con tu RIF puedes facturar →») → /empezar → «¿Ya sacaste tu RIF? Ponlo aquí» → Mi empresa →
 *   «Poner mi RIF» (RIF de persona natural de la dueña, V-12345678-9) → /empezar «Ya puse mi RIF: activar facturas»
 *   → a quién vende, máquina fiscal, tipo de contribuyente, IVA con acta, talonario → la primera FACTURA en la caja
 *   (y su PDF) → ¿qué pasó con los recibos viejos, los fiados y lo que no se podía antes (D-01: comprar a un
 *   proveedor)?
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
import { token } from "./api.mjs";

const E = estado();
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);
const r = {};
const resumen = (x) => ({ avisos: x.avisos, red: x.red, texto: x.texto.slice(0, 1500) });
const cid = E.empresas.E1.id;

const { browser, page, eventos } = await abrir();
const ev = nuevaEvidencia("M", eventos);
await login(page, E.personas.duenaE1, E.clave);

// 1 · desde la caja
await page.goto(BASE + "/vender");
await esperar(page, 3000);
await ev(page, "E1-caja-banda-recibos");
await clic(page.getByRole("link", { name: /Con tu RIF puedes facturar/ }));
await esperar(page, 2500);
r.empezar = { url: page.url(), ...resumen(await ev(page, "E1-empezar-desde-caja")) };

// 2 · «¿Ya sacaste tu RIF? Ponlo aquí» → Mi empresa → Poner mi RIF
await clic(page.getByRole("link", { name: /Ya sacaste tu RIF/ }));
await esperar(page, 2500);
if (!/configuracion/.test(page.url())) {
  await page.goto(BASE + "/admin/configuracion");
  await esperar(page, 2500);
}
await clic(page.getByRole("button", { name: /^Poner mi RIF$/ }).first());
await esperar(page, 900);
{
  const d = dialogo(page);
  await d.getByLabel(/^El RIF/).fill("V-12345678-9");
  await d
    .getByLabel(/^Dirección fiscal/)
    .fill("Calle 5 con carrera 3, sector La Esquina, Barquisimeto, Lara")
    .catch(() => {});
  await ev(page, "E1-poner-rif-lleno");
  await clic(d.getByRole("button", { name: /^Guardar$/ }));
  await esperar(page, 2500);
  r.ponerRif = resumen(await ev(page, "E1-poner-rif-hecho"));
}
r.rifEnBase = sql(
  `select coalesce(tax_id,'(null)'), coalesce(taxpayer_type_code,'(null)') from public.companies where id='${cid}'`,
)[0];

// 3 · /empezar: activar facturas
await page.goto(BASE + "/empezar");
await esperar(page, 3000);
await ev(page, "E1-empezar-con-rif");
await clic(page.getByRole("button", { name: /Ya puse mi RIF: activar facturas/ }));
await esperar(page, 1500);
await ev(page, "E1-activar-facturas");
r.pasos = {};
r.pasos.vendeA = await clic(page.getByRole("radio", { name: "A personas", exact: true }));
await esperar(page, 500);
r.pasos.maquina = await clic(page.getByRole("radio", { name: "No", exact: true }));
await esperar(page, 700);
await ev(page, "E1-regimen-elegido");
r.pasos.asiFacturo = await clic(page.getByRole("button", { name: /^Así facturo$/ }));
await esperar(page, 2200);
r.regimen = resumen(await ev(page, "E1-regimen-asignado"));
r.pasos.tipo = await clic(page.getByRole("button", { name: /^Ordinario$/ }));
await esperar(page, 800);
await ev(page, "E1-tipo-confirmacion");
r.pasos.tipoOk = await clic(page.getByRole("button", { name: /Guardar el tipo de contribuyente/ }));
await esperar(page, 1800);
await ev(page, "E1-tipo-guardado");
if ((await page.getByLabel(/Porcentaje \(%\)/).count()) > 0) {
  await page.getByLabel(/Porcentaje \(%\)/).fill("16");
  r.pasos.iva = await clic(page.getByRole("button", { name: /Acepto este porcentaje/ }));
  await esperar(page, 1800);
  await ev(page, "E1-iva-aceptado");
}
if ((await page.getByLabel(/^Del número/).count()) > 0) {
  await page.getByLabel(/^Del número/).fill("1");
  await page.getByLabel(/^Al número/).fill("2000");
  await page.getByLabel(/^Serie/).fill("A");
  await page.getByLabel(/^Imprenta/).fill("Tipografía Barquisimeto, C.A.");
  await ev(page, "E1-talonario-lleno");
  r.pasos.talonario = await clic(page.getByRole("button", { name: /Registrar talonario/ }));
  await esperar(page, 2000);
}
r.finEmpezar = resumen(await ev(page, "E1-empezar-final"));

// 4 · la primera venta con RIF en la caja
await page.goto(BASE + "/vender");
await esperar(page, 3000);
r.cajaConRif = (await ev(page, "E1-caja-con-rif")).texto.slice(0, 600);
for (const lb of ["Abrir otra cuenta"]) void lb; // la caja puede traer cuentas de la nube (E-08): se usa la activa
await page.getByLabel("Buscar productos para vender").fill("Harina de maíz");
await esperar(page, 1500);
await clic(page.getByRole("button", { name: /Harina de maíz precocida/ }).first());
await esperar(page, 1200);
await clic(page.getByRole("button", { name: /Cobrar\s*·\s*F2/ }).first());
await esperar(page, 1200);
await clic(
  dialogo(page)
    .getByRole("button", { name: /Efectivo Bs|Efectivo en bolívares/ })
    .first(),
);
await esperar(page, 900);
await ev(page, "E1-primera-factura-cobro");
const t = await cronometrar(async () => {
  await clic(
    dialogo(page)
      .getByRole("button", { name: /^Cobrar / })
      .first(),
  );
  await esperar(page, 3500);
});
r.primeraVenta = { ms: t.ms, ...resumen(await ev(page, "E1-primera-factura-hecha", { ms: t.ms })) };

// 5 · ¿y comprar a un proveedor (D-01)? — el primer paso de la llegada con proveedor
await page.goto(BASE + "/admin/llego-mercancia");
await esperar(page, 2500);
const sinPedido = page.getByText("No, llegó sin pedido");
if ((await sinPedido.count()) > 0) await clic(sinPedido.first());
await clic(page.getByText("Me la trajo un proveedor").first());
await esperar(page, 900);
r.llegadaConRif = (await ev(page, "E1-llegada-con-rif")).texto.slice(0, 800);
await browser.close();

// PDF de la primera factura (la llamada del botón «Imprimir»)
{
  const tk = await token(E.personas.duenaE1, E.clave);
  const docs =
    sql(`select id, kind, series||'-'||coalesce(document_number::text,'—'), coalesce(control_number::text,'—') from public.documents
                     where company_id='${cid}' and created_at > now() - interval '20 minutes' order by created_at`);
  r.documentos = docs;
  const destino = path.join(DIR, "M", "pdf");
  fs.mkdirSync(destino, { recursive: true });
  for (const [id, kind, num] of docs) {
    const res = await fetch(`${API}/v1/documents/${id}/pdf`, {
      headers: { Authorization: `Bearer ${tk}`, "X-Company-Id": cid },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.status === 200) fs.writeFileSync(path.join(destino, `E4-${kind}-${num}.pdf`), buf);
  }
}
r.base = {
  empresa: sql(
    `select coalesce(tax_id,'(null)'), coalesce(taxpayer_type_code,'(null)'), coalesce(legal_name,''), coalesce(fiscal_address,'') from public.companies where id='${cid}'`,
  )[0],
  regimen: sql(
    `select regime_code, effective_from from public.company_fiscal_regimes where company_id='${cid}' order by effective_from`,
  ),
  rangos: sql(
    `select kind, series, range_from, range_to, next_available from public.fiscal_number_ranges where company_id='${cid}'`,
  ),
  recibosViejos: sql(
    `select kind, series||'-'||document_number, status from public.documents where company_id='${cid}' and kind in ('receipt','receipt_return') order by created_at`,
  ),
};
guardarEstado({ m: r });
console.log(JSON.stringify(r, null, 1).slice(0, 16000));

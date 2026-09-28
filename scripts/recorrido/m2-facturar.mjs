/**
 * BLOQUE M (2) · lo que m-rif.mjs no alcanzó: /empezar abre en el PASO 1 y el camino «activar facturas» está en el
 * paso 4 (se llega por la escalera de la cabecera). Activar facturas (a quién vende, máquina fiscal, tipo, IVA,
 * talonario), y la primera venta en la caja con «Venta sin identificar» y con cliente. PDF de lo emitido.
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
const r = { pasos: {} };
const resumen = (x) => ({ avisos: x.avisos, red: x.red, texto: x.texto.slice(0, 1500) });
const cid = E.empresas.E1.id;
const { browser, page, eventos } = await abrir();
const ev = nuevaEvidencia("M", eventos);
await login(page, E.personas.duenaE1, E.clave);
await page.goto(BASE + "/empezar");
await esperar(page, 3000);
const escalera = page.locator("header button[aria-label]");
r.escalera = await escalera.evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")));
await clic(page.getByRole("button", { name: /^Tus facturas/ }));
await esperar(page, 1500);
r.paso4 = resumen(await ev(page, "E1-empezar-paso-4"));
r.pasos.activar = await clic(
  page.getByRole("button", { name: /Ya puse mi RIF: activar facturas/ }),
);
await esperar(page, 1500);
r.activar = resumen(await ev(page, "E1-activar-facturas-2"));
r.pasos.vendeA = await clic(page.getByRole("radio", { name: "A personas", exact: true }));
await esperar(page, 500);
r.pasos.maquina = await clic(page.getByRole("radio", { name: "No", exact: true }));
await esperar(page, 700);
await ev(page, "E1-regimen-elegido-2");
r.pasos.asiFacturo = await clic(page.getByRole("button", { name: /^Así facturo$/ }));
await esperar(page, 2200);
r.regimen = resumen(await ev(page, "E1-regimen-asignado-2"));
r.pasos.tipo = await clic(page.getByRole("button", { name: /^Ordinario$/ }));
await esperar(page, 800);
r.pasos.tipoOk = await clic(page.getByRole("button", { name: /Guardar el tipo de contribuyente/ }));
await esperar(page, 1800);
await ev(page, "E1-tipo-guardado-2");
if ((await page.getByLabel(/Porcentaje \(%\)/).count()) > 0) {
  await page.getByLabel(/Porcentaje \(%\)/).fill("16");
  r.pasos.iva = await clic(page.getByRole("button", { name: /Acepto este porcentaje/ }));
  await esperar(page, 1800);
  await ev(page, "E1-iva-aceptado-2");
}
if ((await page.getByLabel(/^Del número/).count()) > 0) {
  await page.getByLabel(/^Del número/).fill("1");
  await page.getByLabel(/^Al número/).fill("2000");
  await page.getByLabel(/^Serie/).fill("A");
  await page.getByLabel(/^Imprenta/).fill("Tipografía Barquisimeto, C.A.");
  r.pasos.talonario = await clic(page.getByRole("button", { name: /Registrar talonario/ }));
  await esperar(page, 2000);
}
r.finEmpezar = resumen(await ev(page, "E1-empezar-final-2"));
// primera venta con RIF, sin identificar
await page.goto(BASE + "/vender");
await esperar(page, 3000);
r.caja = (await ev(page, "E1-caja-con-rif-2")).texto.slice(0, 500);
await page.getByLabel("Buscar productos para vender").fill("Harina de maíz");
await esperar(page, 1500);
await clic(page.getByRole("button", { name: /Harina de maíz precocida/ }).first());
await esperar(page, 1000);
r.pasos.sinIdentificar = await clic(
  page.getByRole("button", { name: /Venta sin identificar/ }).first(),
);
await esperar(page, 800);
await clic(page.getByRole("button", { name: /Cobrar\s*·\s*F2/ }).first());
await esperar(page, 1200);
await clic(
  dialogo(page)
    .getByRole("button", { name: /Efectivo Bs|Efectivo en bolívares/ })
    .first(),
);
await esperar(page, 900);
await ev(page, "E1-primera-factura-cobro-2");
await clic(
  dialogo(page)
    .getByRole("button", { name: /^Cobrar / })
    .first(),
);
await esperar(page, 3500);
r.venta = resumen(await ev(page, "E1-primera-factura-hecha-2"));
await clic(page.getByRole("button", { name: /Nueva venta/ }).first(), 3000);
await browser.close();
const tk = await token(E.personas.duenaE1, E.clave);
r.documentos =
  sql(`select id, kind, series||'-'||coalesce(document_number::text,'—'), coalesce(control_number::text,'—'), status, total_amount::text, tax_amount::text
                      from public.documents where company_id='${cid}' and created_at > now() - interval '20 minutes' order by created_at`);
const destino = path.join(DIR, "M", "pdf");
fs.mkdirSync(destino, { recursive: true });
for (const [id, kind, num] of r.documentos) {
  const res = await fetch(`${API}/v1/documents/${id}/pdf`, {
    headers: { Authorization: `Bearer ${tk}`, "X-Company-Id": cid },
  });
  if (res.status === 200)
    fs.writeFileSync(
      path.join(destino, `E4-${kind}-${num}.pdf`),
      Buffer.from(await res.arrayBuffer()),
    );
}
r.base = {
  empresa: sql(
    `select coalesce(tax_id,'(null)'), coalesce(taxpayer_type_code,'(null)') from public.companies where id='${cid}'`,
  )[0],
  regimen: sql(
    `select regime_code, effective_from from public.company_fiscal_regimes where company_id='${cid}' order by effective_from`,
  ),
  rangos: sql(
    `select kind, series, range_from, range_to, next_available from public.fiscal_number_ranges where company_id='${cid}'`,
  ),
  alicuotas: sql(
    `select rate::text, effective_from from public.tax_rules where company_id='${cid}' order by effective_from`,
  ),
};
guardarEstado({ m2: r });
console.log(JSON.stringify(r, null, 1).slice(0, 14000));

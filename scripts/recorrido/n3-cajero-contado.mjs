/**
 * BLOQUE N · 3.ª pasada — ¿el cajero puede vender DE CONTADO un producto con existencia?
 *   En N el cajero no pudo fiar: el 403 fue «exige el permiso inventory.move», que su rol no tiene. Si el kardex de
 *   cualquier venta pide ese permiso, tampoco puede vender de contado. Una venta en efectivo, sin identificar, de
 *   una Pasta en E2.
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
} from "./lib.mjs";

const E = estado();
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);
const resumen = (x) => ({ avisos: x.avisos, red: x.red, texto: x.texto.slice(0, 700) });
const r = {};
const { browser, page, eventos } = await abrir();
const ev = nuevaEvidencia("N", eventos);
await login(page, E.personas.cajero, E.clave);
await page.goto(BASE + "/vender");
await esperar(page, 3000);
r.caja = resumen(await ev(page, "cajero-contado-caja"));
await page.getByLabel("Buscar productos para vender").fill("Pasta caja x20");
await esperar(page, 1500);
await clic(page.getByRole("button", { name: /Pasta caja x20/ }).first());
await esperar(page, 1000);
r.sinIdentificar = await clic(
  page.getByRole("button", { name: /Venta sin identificar/ }).first(),
  3000,
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
await ev(page, "cajero-contado-cobro");
await clic(
  dialogo(page)
    .getByRole("button", { name: /^Cobrar / })
    .first(),
);
await esperar(page, 3500);
r.cobro = resumen(await ev(page, "cajero-contado-resultado"));
await browser.close();
r.documentos = sql(`select d.series||'-'||d.document_number, d.status, d.total_amount::text, u.email
                      from public.documents d left join auth.users u on u.id = d.created_by
                     where d.company_id = '${E.empresas.E2.id}' and d.created_at > now() - interval '5 minutes'`).map(
  (x) => x.join(" | "),
);
guardarEstado({ n3: r });
console.log(JSON.stringify(r, null, 1).slice(0, 6000));

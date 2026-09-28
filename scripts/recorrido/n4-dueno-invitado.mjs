/**
 * BLOQUE N · 4.ª pasada — el «Dueño» invitado. dueno.andina@ es Dueño de E3 desde este bloque (lo agregó tornillo@),
 * pero su rol nació acotado a la empresa. En E3: ¿ve y gestiona «Usuarios y roles»? ¿Vende un producto con existencia?
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
const resumen = (x) => ({ avisos: x.avisos, red: x.red, texto: x.texto.slice(0, 900) });
const r = {};
const { browser, page, eventos } = await abrir();
const ev = nuevaEvidencia("N", eventos);
await login(page, E.personas.duenoE2E3, E.clave);
if ((await page.getByText("Elige la empresa").count()) > 0)
  await clic(page.getByRole("button", { name: /Ferretería El Tornillo/ }).first());
await esperar(page, 2500);
await page.goto(BASE + "/admin/configuracion");
await esperar(page, 3000);
r.configuracion = resumen(await ev(page, "dueno-invitado-E3-configuracion"));
await page.goto(BASE + "/vender");
await esperar(page, 3000);
await page.getByLabel("Buscar productos para vender").fill("Cemento");
await esperar(page, 1500);
await clic(page.getByRole("button", { name: /Cemento/ }).first());
await esperar(page, 1000);
await clic(page.getByRole("button", { name: /Venta sin identificar/ }).first(), 3000);
await esperar(page, 800);
await clic(page.getByRole("button", { name: /Cobrar\s*·\s*F2/ }).first());
await esperar(page, 1200);
await clic(
  dialogo(page)
    .getByRole("button", { name: /Efectivo Bs|Efectivo en bolívares/ })
    .first(),
);
await esperar(page, 900);
await clic(
  dialogo(page)
    .getByRole("button", { name: /^Cobrar / })
    .first(),
);
await esperar(page, 3500);
r.venta = resumen(await ev(page, "dueno-invitado-E3-vende"));
await browser.close();
r.documentos =
  sql(`select d.series||'-'||d.document_number, d.status, d.total_amount::text from public.documents d
                     where d.company_id = '${E.empresas.E3.id}' and d.created_at > now() - interval '5 minutes'`).map(
    (x) => x.join(" | "),
  );
guardarEstado({ n4: r });
console.log(JSON.stringify(r, null, 1).slice(0, 5000));

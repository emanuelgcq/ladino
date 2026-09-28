/**
 * BLOQUE O · VARIAS EMPRESAS — dueno.andina@ es Dueño de E2 y (desde N) de E3.
 *   ¿Dónde aterriza? «Cambiar de empresa». ¿Nada se mezcla? productos, clientes, ventas, Mi dinero y la caja de cada
 *   una. Y la prueba dura: DOS pestañas del mismo navegador, una en E2 y otra en E3; se cambia de empresa en la
 *   segunda y se cobra en la primera sin recargar — ¿en qué empresa queda la venta?
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
const r = {};
const resumen = (x) => ({ avisos: x.avisos, red: x.red, texto: x.texto.slice(0, 900) });
const E2 = E.empresas.E2.id;
const E3 = E.empresas.E3.id;

async function cambiarA(page, nombre) {
  await clic(page.getByRole("button", { name: "Cambiar de empresa" }));
  await esperar(page, 700);
  await clic(page.getByRole("menuitem", { name: new RegExp(nombre) }).first());
  await esperar(page, 2500);
}
// Desde N, el dueño tiene dos empresas: al entrar (o al abrir una pestaña nueva) puede caer en «Elige la empresa».
async function selector(page, nombre) {
  const b = page.getByRole("button", { name: new RegExp(nombre) }).first();
  if ((await page.getByText("Elige la empresa").count()) > 0 && (await b.count()) > 0) {
    await clic(b);
    await esperar(page, 2500);
    return true;
  }
  return false;
}
async function foto(page, ev, etq) {
  const out = {};
  for (const [ruta, clave] of [
    ["/productos", "productos"],
    ["/clientes", "clientes"],
    ["/dinero", "dinero"],
    ["/admin/ventas", "ventas"],
  ]) {
    await page.goto(BASE + ruta);
    await esperar(page, 2500);
    out[clave] = (await ev(page, `${etq}-${clave}`)).texto.slice(0, 600);
  }
  return out;
}

const { browser, page, eventos, contexto } = await abrir();
const ev = nuevaEvidencia("O", eventos);
await login(page, E.personas.duenoE2E3, E.clave);
await esperar(page, 2500);
const at = await ev(page, "dueno-aterriza");
r.aterriza = { url: page.url(), texto: at.texto.slice(0, 500) };
r.selectorAlEntrar = await selector(page, "Distribuidora Andina");
if (r.selectorAlEntrar)
  r.trasSelector = {
    url: page.url(),
    texto: (await ev(page, "dueno-tras-elegir-E2")).texto.slice(0, 400),
  };
await clic(page.getByRole("button", { name: "Cambiar de empresa" }));
await esperar(page, 700);
r.menuEmpresas = await page
  .getByRole("menuitem")
  .allInnerTexts()
  .catch(() => []);
await ev(page, "dueno-menu-empresas");
await page.keyboard.press("Escape");

await cambiarA(page, "Distribuidora Andina");
r.fotoE2 = await foto(page, ev, "E2");
await cambiarA(page, "Ferretería El Tornillo");
r.fotoE3 = await foto(page, ev, "E3");

// Dos pestañas: la 1 en E2 con un carrito; la 2 cambia a E3; se cobra en la 1 sin recargar.
await cambiarA(page, "Distribuidora Andina");
await page.goto(BASE + "/vender");
await esperar(page, 3000);
await page.getByLabel("Buscar productos para vender").fill("Pasta caja x20");
await esperar(page, 1500);
await clic(page.getByRole("button", { name: /Pasta caja x20/ }).first());
await esperar(page, 1200);
r.sinIdentificar = await clic(
  page.getByRole("button", { name: /Venta sin identificar/ }).first(),
  3000,
);
await esperar(page, 800);
await ev(page, "pestana1-E2-carrito");
const ctx = page.context();
const page2 = await ctx.newPage();
await page2.goto(BASE + "/");
await esperar(page2, 3000);
r.pestana2Selector = await selector(page2, "Distribuidora Andina");
r.pestana2Aterriza = (await ev(page2, "pestana2-aterriza")).texto.slice(0, 300);
await cambiarA(page2, "Ferretería El Tornillo");
r.pestana2 = { empresa: (await ev(page2, "pestana2-cambio-a-E3")).texto.slice(0, 200) };
await page.bringToFront();
await esperar(page, 1500);
r.pestana1Antes = (await ev(page, "pestana1-tras-cambio-en-2")).texto.slice(0, 300);
const antes = sql(
  `select company_id, count(*) from public.documents where created_at > now() - interval '1 hour' group by 1`,
);
await clic(page.getByRole("button", { name: /Cobrar\s*·\s*F2/ }).first());
await esperar(page, 1200);
await clic(
  dialogo(page)
    .getByRole("button", { name: /Efectivo USD|Transferencia/ })
    .first(),
);
await esperar(page, 900);
await clic(
  dialogo(page)
    .getByRole("button", { name: /^Cobrar / })
    .first(),
);
await esperar(page, 3500);
r.cobroPestana1 = resumen(await ev(page, "pestana1-cobro"));
r.ultimoDocumento =
  sql(`select c.trade_name, d.kind, d.series||'-'||d.document_number, d.total_amount::text, d.created_at
                           from public.documents d join public.companies c on c.id = d.company_id
                          order by d.created_at desc limit 1`)[0];
r.docsAntes = antes;
await page2.close();
await browser.close();

guardarEstado({ o: r });
console.log(JSON.stringify(r, null, 1).slice(0, 12000));

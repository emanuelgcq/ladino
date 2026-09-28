/**
 * BLOQUE O · 2.ª pasada — la pestaña que recarga. Dos pestañas del mismo navegador: la 1 en E2 (Distribuidora Andina),
 * la 2 cambia a E3 (Ferretería El Tornillo). La 1 recarga (F5): ¿en qué empresa queda, y lo dice?
 */
import { abrir, BASE, esperar, estado, guardarEstado, login, nuevaEvidencia } from "./lib.mjs";

const E = estado();
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);
const r = {};
const cabecera = async (p) =>
  (
    await p
      .locator("header")
      .first()
      .innerText()
      .catch(() => "")
  ).split("\n")[0];
const { browser, page, eventos } = await abrir();
const ev = nuevaEvidencia("O", eventos);
await login(page, E.personas.duenoE2E3, E.clave);
if ((await page.getByText("Elige la empresa").count()) > 0)
  await clic(page.getByRole("button", { name: /Distribuidora Andina/ }).first());
await esperar(page, 2500);
await page.goto(BASE + "/vender");
await esperar(page, 3000);
r.p1Antes = await cabecera(page);
await ev(page, "recarga-pestana1-antes");
const page2 = await page.context().newPage();
await page2.goto(BASE + "/");
await esperar(page2, 3000);
await clic(page2.getByRole("button", { name: "Cambiar de empresa" }));
await esperar(page2, 700);
await clic(page2.getByRole("menuitem", { name: /Ferretería El Tornillo/ }).first());
await esperar(page2, 2500);
r.p2 = await cabecera(page2);
await page.bringToFront();
await page.reload();
await esperar(page, 3500);
r.p1TrasRecargar = await cabecera(page);
const x = await ev(page, "recarga-pestana1-tras-F5");
r.p1Avisos = x.avisos;
r.p1Texto = x.texto.slice(0, 300);
await browser.close();
guardarEstado({ o2: r });
console.log(JSON.stringify(r, null, 1));

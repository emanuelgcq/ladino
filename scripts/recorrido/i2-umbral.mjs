/**
 * BLOQUE I (2) · el umbral de reposición que SÍ dispara: Café molido caja (23 en Principal), mínimo 30.
 * ¿Aparece en «Por reponer» y en «Por agotarse» de /inventario? (El de la harina, mínimo 50 con 66, no disparaba.)
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
} from "./lib.mjs";
const E = estado();
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);
const r = {};
const { browser, page, eventos } = await abrir();
const ev = nuevaEvidencia("I", eventos);
await login(page, E.personas.duenoE2E3, E.clave);
await page.goto(BASE + "/admin/inventario");
await esperar(page, 2500);
await clic(page.getByRole("tab", { name: /Alertas/ }));
await esperar(page, 1500);
await clic(page.getByRole("button", { name: /Definir umbral/ }));
await esperar(page, 900);
const d = dialogo(page);
await d.getByPlaceholder("SKU o nombre…").first().fill("Café molido caja");
await esperar(page, 1300);
await clic(page.getByRole("option", { name: /Café molido caja/i }).first());
await clic(d.getByLabel(/^Almacén/).first());
await esperar(page, 500);
await clic(page.getByRole("option", { name: /Principal/ }).first());
await d.getByLabel(/^Mínimo/).fill("30");
await clic(d.getByRole("button", { name: /^Guardar umbral$/ }));
await esperar(page, 2500);
r.alertas = (await ev(page, "E2-umbral-cafe-alertas")).texto.slice(-900);
await page.goto(BASE + "/inventario");
await esperar(page, 3000);
r.inventario = (await ev(page, "E2-inventario-por-agotarse")).texto.slice(0, 400);
await page.goto(BASE + "/");
await esperar(page, 3000);
r.inicio = (await ev(page, "E2-inicio-tras-umbral")).texto.slice(0, 1500);
await browser.close();
guardarEstado({ i2: r });
console.log(JSON.stringify(r, null, 1));

/**
 * BLOQUE P · INICIO, REPORTES Y BÚSQUEDA — las tres empresas, con su dueña o dueño.
 *   Inicio: «Hoy» y «Este mes» (¿cuadran con lo que pasó? ventas, lo que gané, lo que me deben, mi dinero, por agotarse,
 *   últimas ventas). Reportes (/admin/reportes): cada tarjeta y su destino; el reporte de diferencial cambiario.
 *   Búsqueda (Ctrl+K): un cliente, un producto, una factura por número, una pantalla. Y la forma: Inicio a 390 px y
 *   en oscuro.
 */
import { abrir, BASE, esperar, estado, guardarEstado, login, nuevaEvidencia } from "./lib.mjs";

const E = estado();
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);
const r = {};

async function inicio(page, ev, clave) {
  const out = {};
  await page.goto(BASE + "/");
  await esperar(page, 3500);
  out.hoy = (await ev(page, `${clave}-inicio-hoy`)).texto.slice(0, 1800);
  await clic(
    page
      .getByRole("tab", { name: /Este mes/ })
      .or(page.getByRole("button", { name: /Este mes/ }))
      .first(),
  );
  await esperar(page, 2500);
  out.mes = (await ev(page, `${clave}-inicio-mes`)).texto.slice(0, 1800);
  return out;
}
async function buscar(page, ev, clave, termino) {
  await page.keyboard.press("Control+k");
  await esperar(page, 900);
  await page.keyboard.type(termino);
  await esperar(page, 1500);
  const x = await ev(page, `${clave}-buscar-${termino.replace(/\W+/g, "-")}`);
  const opciones = await page
    .getByRole("option")
    .allInnerTexts()
    .catch(() => []);
  await page.keyboard.press("Escape");
  await esperar(page, 400);
  return { opciones: opciones.slice(0, 12), texto: x.texto.slice(-400) };
}

for (const [clave, correo, empresa, terminos] of [
  ["E1", E.personas.duenaE1, null, ["Luisa", "Harina", "R-5", "cierre"]],
  ["E2", E.personas.duenoE2E3, "Distribuidora Andina", ["Alcaldía", "Pasta", "A-2", "libro"]],
  ["E3", E.personas.duenoE2E3, "Ferretería El Tornillo", ["Inversiones", "Cemento", "A-5", "igtf"]],
]) {
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("P", eventos);
  await login(page, correo, E.clave);
  await esperar(page, 2500);
  // Desde N, el dueño de E2 también lo es de E3: al entrar puede caer en «Elige la empresa».
  if (empresa && (await page.getByText("Elige la empresa").count()) > 0) {
    await clic(page.getByRole("button", { name: new RegExp(empresa) }).first());
    await esperar(page, 2500);
  } else if (empresa) {
    await clic(page.getByRole("button", { name: "Cambiar de empresa" }));
    await esperar(page, 700);
    await clic(page.getByRole("menuitem", { name: new RegExp(empresa) }).first());
    await esperar(page, 2500);
  }
  const o = { inicio: await inicio(page, ev, clave) };
  await page.goto(BASE + "/admin/reportes");
  await esperar(page, 3000);
  const rep = await ev(page, `${clave}-reportes`);
  o.reportes = {
    texto: rep.texto.slice(0, 2500),
    enlaces: (rep.interactivo?.enlaces ?? []).slice(-15),
  };
  o.busquedas = {};
  for (const t of terminos) o.busquedas[t] = await buscar(page, ev, clave, t);
  await browser.close();
  r[clave] = o;
}

// Inicio a 390 px en oscuro (E1) y a 1024 px (E2)
for (const [clave, correo, forma, oscuro] of [
  ["E1-movil-oscuro", E.personas.duenaE1, "movil", true],
  ["E2-tablet", E.personas.duenoE2E3, "tablet", false],
]) {
  const { browser, page, eventos } = await abrir({ forma, oscuro });
  const ev = nuevaEvidencia("P", eventos);
  await login(page, correo, E.clave);
  if ((await page.getByText("Elige la empresa").count()) > 0) {
    await clic(page.getByRole("button", { name: /Distribuidora Andina/ }).first());
    await esperar(page, 2500);
  }
  await page.goto(BASE + "/");
  await esperar(page, 3500);
  const x = await ev(page, `${clave}-inicio`);
  r[clave] = { desborde: x.desborde ?? null, texto: x.texto.slice(0, 600) };
  await page.goto(BASE + "/vender");
  await esperar(page, 3500);
  const v = await ev(page, `${clave}-vender`);
  r[clave].vender = { desborde: v.desborde ?? null, texto: v.texto.slice(0, 400) };
  await browser.close();
}
guardarEstado({ p: r });
console.log(JSON.stringify(r, null, 1).slice(0, 30000));

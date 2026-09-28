/**
 * BLOQUE C (3) · AL MAYOR Y PRECIOS DE E1/E3 (continuación de c2) — listas (detal/mayor), cargar precio y su HISTORIAL de vigencias, lista
 * predeterminada de la caja (ida y vuelta), precio dual (la columna en bolívares), el precio de los
 * productos por kilo, editar un producto, pausarlo, y «vender al mayor» activado y desactivado.
 *
 * «Vender al mayor» NO tiene interruptor en la web (hallazgo): se activa por la API con el token
 * del dueño (`PUT /v1/company-settings`) y se ANOTA en el informe como creado por API.
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
import { token, llamar } from "./api.mjs";

const E = estado();
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);
const r = {};

async function abrirLista(page, nombre) {
  await clic(page.getByRole("button", { name: new RegExp(`^${nombre}\\b`, "i") }).first());
  await esperar(page, 1500);
}
async function cargarPrecio(page, ev, etiqueta, producto, importe, lista, cid) {
  if (lista && cid) {
    const ya =
      sql(`select count(*) from public.price_list_items i join public.price_lists pl on pl.id = i.price_list_id
      join public.products p on p.id = i.product_id where pl.company_id = '${cid}' and pl.name = '${lista}'
      and p.name ilike '${producto.replace(/'/g, "''")}%' and i.amount = ${importe} and i.effective_to is null`)[0]?.[0];
    if (Number(ya) > 0) return { avisos: ["(ya cargado: no se repite)"], red: [] };
  }
  // El selector se queda con el producto anterior como ficha: se quita antes de buscar otro.
  const quitar = page.getByRole("button", { name: "Quitar selección" });
  if ((await quitar.count()) > 0) {
    await clic(quitar.first());
    await esperar(page, 400);
  }
  const campo = page.locator('input[role="combobox"]').first();
  await campo.fill(producto);
  await esperar(page, 1200);
  await clic(page.getByRole("option", { name: new RegExp(producto.slice(0, 18), "i") }).first());
  await esperar(page, 500);
  await page.getByLabel(/^Importe/).fill(importe);
  await clic(page.getByRole("button", { name: /Cargar precio…/ }));
  await esperar(page, 700);
  await ev(page, `${etiqueta}-confirmar`);
  await clic(dialogo(page).getByRole("button", { name: /^Cargar el precio$/ }));
  await esperar(page, 2000);
  return ev(page, `${etiqueta}-cargado`);
}

// ── E2 · «vender al mayor» activado (por API: no hay interruptor en la web) ─
{
  const tk = await token(E.personas.duenoE2E3, E.clave);
  const on = await llamar(tk, E.empresas.E2.id, "PUT", "/v1/company-settings", {
    sells_wholesale: true,
  });
  r.mayoristaOn = { status: on.status, json: on.json };
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("C", eventos);
  await login(page, E.personas.duenoE2E3, E.clave);
  await page.goto(BASE + "/empezar");
  await esperar(page, 2500);
  await clic(page.getByRole("button", { name: /Tus productos/ }).first(), 3000);
  await esperar(page, 800);
  await clic(page.getByRole("button", { name: /^Agregar producto$/ }).first());
  await esperar(page, 900);
  const d = dialogo(page);
  await d.getByLabel(/^Nombre/).fill("Galletas de soda caja x24");
  await d.getByLabel(/^Precio de venta/).fill("20.00");
  await d.getByLabel(/¿Cuántos tienes hoy\?/).fill("15");
  await d.getByLabel(/¿Cuánto te costó cada uno\?/).fill("14.00");
  await clic(d.getByRole("button", { name: /Más detalles/ }));
  await esperar(page, 400);
  const hayMayor = (await d.getByLabel(/Precio al mayor/).count()) > 0;
  if (hayMayor) await d.getByLabel(/Precio al mayor/).fill("17.00");
  await ev(page, "E2-alta-con-precio-mayor", { hayMayor });
  await clic(d.getByRole("button", { name: /^Agregar producto$/ }));
  await esperar(page, 2500);
  r.altaMayor = { hayMayor, avisos: (await ev(page, "E2-alta-mayor-guardada")).avisos };
  await page.goto(BASE + "/admin/precios");
  await esperar(page, 2500);
  await ev(page, "E2-precios-con-mayorista");
  // Y desactivado otra vez: ¿qué muestra el alta y la lista?
  const off = await llamar(tk, E.empresas.E2.id, "PUT", "/v1/company-settings", {
    sells_wholesale: false,
  });
  r.mayoristaOff = { status: off.status };
  await page.goto(BASE + "/empezar");
  await esperar(page, 2500);
  await clic(page.getByRole("button", { name: /Tus productos/ }).first(), 3000);
  await esperar(page, 800);
  await clic(page.getByRole("button", { name: /^Agregar producto$/ }).first());
  await esperar(page, 900);
  await clic(dialogo(page).getByRole("button", { name: /Más detalles/ }));
  await esperar(page, 400);
  r.mayorTrasApagar =
    (await dialogo(page)
      .getByLabel(/Precio al mayor/)
      .count()) > 0;
  await ev(page, "E2-alta-sin-mayorista", { hayMayor: r.mayorTrasApagar });
  await page.keyboard.press("Escape");
  // Se deja ACTIVADO: E2 es mayorista en el escenario (bloque E vende al mayor).
  await llamar(tk, E.empresas.E2.id, "PUT", "/v1/company-settings", { sells_wholesale: true });
  await browser.close();
}

// ── E1 y E3 · precio del kilo; E1 · un cambio de precio con historial ──────
for (const [clave, correo, kiloNombre, kiloPrecio] of [
  ["E1", E.personas.duenaE1, "Queso blanco a granel", "6.00"],
  ["E3", E.personas.registraE3, "Clavos de 2 pulgadas", "2.50"],
]) {
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("C", eventos);
  await login(page, correo, E.clave);
  await page.goto(BASE + "/admin/precios");
  await esperar(page, 2500);
  await abrirLista(page, "detal");
  const k = await cargarPrecio(page, ev, `${clave}-kilo`, kiloNombre, kiloPrecio);
  r[`${clave}-kilo`] = { avisos: k.avisos, red: k.red };
  if (clave === "E1") {
    const c = await cargarPrecio(page, ev, "E1-harina-1.20", "Harina de maíz precocida", "1.20");
    r.E1cambio = { avisos: c.avisos, red: c.red };
    await ev(page, "E1-detal-con-historial");
  }
  await browser.close();
}

guardarEstado({ c3: r });
console.log(JSON.stringify(r, null, 1).slice(0, 5000));

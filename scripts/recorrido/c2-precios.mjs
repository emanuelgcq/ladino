/**
 * BLOQUE C (2) · PRECIOS — listas (detal/mayor), cargar precio y su HISTORIAL de vigencias, lista
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

// ── E2 · listas, historial, predeterminada, precio dual, kilo, editar, pausar ─
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("C", eventos);
  await login(page, E.personas.duenoE2E3, E.clave);
  await page.goto(BASE + "/admin/precios");
  await esperar(page, 2500);
  await ev(page, "E2-precios-entrada");

  // Lista «mayor»: tres precios.
  await abrirLista(page, "mayor");
  await ev(page, "E2-lista-mayor");
  const mayor = [];
  for (const [prod, imp] of [
    ["Harina precocida caja x20", "22.00"],
    ["Arroz caja x24", "27.50"],
    ["Aceite de soya", "25.00"],
  ]) {
    const x = await cargarPrecio(
      page,
      ev,
      `E2-mayor-${prod.slice(0, 12)}`,
      prod,
      imp,
      "mayor",
      E.empresas.E2.id,
    );
    mayor.push({ prod, imp, avisos: x.avisos, red: x.red });
  }
  r.mayor = mayor;
  // Hacerla predeterminada de la caja, y volver a «detal».
  await clic(page.getByRole("button", { name: /^Hacer predeterminada$/ }).first());
  await esperar(page, 700);
  await ev(page, "E2-predeterminada-confirmar");
  await clic(dialogo(page).getByRole("button", { name: /^Hacer predeterminada$/ }));
  await esperar(page, 2000);
  r.predMayor = (await ev(page, "E2-mayor-predeterminada")).avisos;
  // Lista «detal»: cambio de precio del aceite (28 → 29) y su historial; precio del kilo.
  await abrirLista(page, "detal");
  await clic(page.getByRole("button", { name: /^Hacer predeterminada$/ }).first());
  await esperar(page, 700);
  await clic(dialogo(page).getByRole("button", { name: /^Hacer predeterminada$/ }));
  await esperar(page, 2000);
  r.predDetal = (await ev(page, "E2-detal-predeterminada-otra-vez")).avisos;
  const cambio = await cargarPrecio(page, ev, "E2-detal-aceite-29", "Aceite de soya", "29.00");
  r.cambioPrecio = { avisos: cambio.avisos, red: cambio.red };
  const kilo = await cargarPrecio(page, ev, "E2-detal-queso-kilo", "Queso blanco a granel", "7.00");
  r.precioKilo = { avisos: kilo.avisos, red: kilo.red };
  await ev(page, "E2-detal-historial");
  r.historialAceite = sql(
    `select pl.name, pp.amount::text, pp.effective_from::text, coalesce(pp.effective_to::text,'(vigente)')
       from public.price_list_items pp join public.price_lists pl on pl.id = pp.price_list_id
       join public.products p on p.id = pp.product_id
      where p.company_id = '${E.empresas.E2.id}' and p.name ilike 'Aceite de soya%' order by pp.effective_from`,
  );

  // Editar un producto y pausar otro.
  await page.goto(BASE + "/admin/productos");
  await esperar(page, 2500);
  await clic(page.getByText("Salsa de tomate caja x12", { exact: true }).first());
  await esperar(page, 900);
  await clic(dialogo(page).getByRole("button", { name: /Editar/ }));
  await esperar(page, 500);
  await dialogo(page)
    .getByLabel(/^Nombre/)
    .fill("Salsa de tomate 397g caja x12");
  await ev(page, "E2-editar-lleno");
  await clic(dialogo(page).getByRole("button", { name: /Guardar/ }));
  await esperar(page, 1800);
  r.editar = (await ev(page, "E2-editado")).avisos;
  await page.keyboard.press("Escape").catch(() => {});
  await esperar(page, 600);
  await clic(page.getByText("Cloro caja x12", { exact: true }).first());
  await esperar(page, 900);
  await clic(dialogo(page).getByRole("button", { name: /Editar/ }));
  await esperar(page, 500);
  await dialogo(page)
    .getByLabel(/^Estado/)
    .click();
  await esperar(page, 400);
  await clic(page.getByRole("option", { name: /Inactivo/ }).first());
  await ev(page, "E2-pausar-lleno");
  await clic(dialogo(page).getByRole("button", { name: /Guardar/ }));
  await esperar(page, 1800);
  r.pausar = (await ev(page, "E2-pausado")).avisos;
  await page.keyboard.press("Escape").catch(() => {});
  // ¿El pausado sigue en la caja?
  await page.goto(BASE + "/vender");
  await esperar(page, 2500);
  await page.getByLabel(/Buscar productos para vender/).fill("Cloro");
  await esperar(page, 1500);
  r.cloroEnCaja = (await ev(page, "E2-caja-busca-pausado")).texto.slice(0, 400);
  await browser.close();
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
  await page.goto(BASE + "/productos");
  await esperar(page, 2500);
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
  await page.goto(BASE + "/productos");
  await esperar(page, 2500);
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

guardarEstado({ c2: r });
console.log(JSON.stringify(r, null, 1).slice(0, 5000));

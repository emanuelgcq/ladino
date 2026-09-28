/**
 * BLOQUE K (2) · lo que k-contabilidad.mjs no hizo por errores del GUION: postear el borrador (en el diario los
 * borradores no tienen número y quedan en la última página: se filtra por «Borrador»), «Generar» la comprobación
 * (hoy y al 24/09) y los estados financieros, y el cierre del período de AGOSTO (que no existía y nació solo cuando
 * el guion creó por la API un borrador fechado el 20/08): cerrarlo, intentar postear el borrador de agosto con el
 * período cerrado, reabrirlo con motivo y postearlo. Y el mayor de CxC con fecha «desde» (¿inicial ≠ final?).
 */
import { abrir, BASE, esperar, estado, guardarEstado, login, nuevaEvidencia, sql } from "./lib.mjs";

const E = estado();
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);
const r = {};
const resumen = (x) => ({ avisos: x.avisos, red: x.red, texto: x.texto.slice(0, 2500) });
const cid = E.empresas.E2.id;
async function elegir(page, loc, opcion) {
  const a = await clic(loc);
  await esperar(page, 500);
  const b = await clic(page.getByRole("option", { name: opcion }).first());
  return [a, b].filter((x) => typeof x === "string").join(" / ") || "ok";
}
async function tab(page, nombre) {
  await page.goto(BASE + "/admin/contabilidad");
  await esperar(page, 2500);
  await clic(page.getByRole("tab", { name: nombre }));
  await esperar(page, 1800);
}
async function postearBorrador(page, ev, etq, descripcion) {
  await tab(page, /^Diario$/);
  await elegir(page, page.getByLabel("Estado del asiento"), /^Borrador$/);
  await esperar(page, 1800);
  const fila = page.getByRole("row").filter({ hasText: descripcion }).first();
  await clic(fila.getByRole("button", { name: /^Postear$/ }));
  await esperar(page, 900);
  await clic(page.getByRole("button", { name: /^Postear el asiento$/ }).last());
  await esperar(page, 2500);
  return resumen(await ev(page, etq));
}

const { browser, page, eventos } = await abrir();
const ev = nuevaEvidencia("K", eventos);
await login(page, E.personas.contador, E.clave);

r.postearReclasificacion = await postearBorrador(
  page,
  ev,
  "contador-postea-reclasificacion",
  /Reclasificación/,
);

// Comprobación: hoy y al 24/09
await tab(page, /Comprobación/);
await clic(page.getByRole("button", { name: /^Generar$/ }).first());
await esperar(page, 3500);
r.comprobacionHoy = resumen(await ev(page, "contador-comprobacion-hoy-generada"));
const fechas = page.locator('input[type="date"]');
if ((await fechas.count()) >= 2) {
  await fechas.nth(1).fill("2026-09-24");
  await clic(page.getByRole("button", { name: /^Generar$/ }).first());
  await esperar(page, 3500);
  r.comprobacion24 = resumen(await ev(page, "contador-comprobacion-24-generada"));
}

// Estados financieros
await tab(page, /^Estados$/);
await clic(page.getByRole("button", { name: /^Generar$/ }).first());
await esperar(page, 3500);
r.estados = resumen(await ev(page, "contador-estados-generados"));

// Mayor de CxC desde el 25/09
await tab(page, /^Mayor$/);
await elegir(page, page.getByLabel(/^Cuenta/).first(), /1\.1\.03/);
const fm = page.locator('input[type="date"]');
if ((await fm.count()) > 0) await fm.first().fill("2026-09-25");
await clic(page.getByRole("button", { name: /Consultar/ }).first());
await esperar(page, 2500);
r.mayorDesde25 = resumen(await ev(page, "contador-mayor-cxc-desde-25"));

// Cierre: agosto
await tab(page, /^Cierre$/);
r.periodos = (await ev(page, "contador-periodos")).texto.slice(0, 1500);
const agosto = page
  .getByRole("row")
  .filter({ hasText: /2026-08/ })
  .first();
r.botonCerrar = await clic(agosto.getByRole("button", { name: /Cerrar/ }));
await esperar(page, 900);
await clic(page.getByRole("button", { name: /^Cerrar el período$/ }).last());
await esperar(page, 2500);
r.cerrarAgosto = resumen(await ev(page, "contador-cerrar-agosto"));
r.postearEnCerrado = await postearBorrador(
  page,
  ev,
  "contador-postea-en-agosto-cerrado",
  /período cerrado/,
);
await tab(page, /^Cierre$/);
const agosto2 = page
  .getByRole("row")
  .filter({ hasText: /2026-08/ })
  .first();
r.botonReabrir = await clic(agosto2.getByRole("button", { name: /Reabrir/ }));
await esperar(page, 900);
await page
  .getByLabel("Motivo de la reapertura")
  .fill("Falta registrar una factura de agosto que llegó tarde.")
  .catch(() => {});
await ev(page, "contador-reabrir-lleno");
await clic(page.getByRole("button", { name: /^Reabrir el período$/ }).last());
await esperar(page, 2500);
r.reabrir = resumen(await ev(page, "contador-reabrir-hecho"));
r.postearTrasReabrir = await postearBorrador(
  page,
  ev,
  "contador-postea-en-agosto-reabierto",
  /período cerrado/,
);
await browser.close();

r.enBase = {
  periodos: sql(
    `select year, month, status, coalesce(reopened_reason,'') from public.fiscal_periods where company_id='${cid}' order by year, month`,
  ),
  manuales: sql(
    `select coalesce(entry_number::text,'—'), status, posting_date, description from public.journal_entries where company_id='${cid}' and source_kind='manual' order by created_at`,
  ),
};
guardarEstado({ k2: r });
console.log(JSON.stringify(r, null, 1).slice(0, 20000));

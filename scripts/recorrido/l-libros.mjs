/**
 * BLOQUE L · LIBROS Y DECLARACIONES — E2 (ordinario) y E3 (especial).
 *   Libro de ventas y de compras de septiembre (con la anulada, las notas de crédito y débito y la compra sin factura);
 *   conciliación libro ↔ mayor; generaciones; exportar (¿qué formatos?); retenciones de IVA (E3: vacío por H-01).
 *   Declarar IVA: agosto (vacío) y septiembre «encadenados» — el excedente de agosto pasa a septiembre; la planilla.
 *   IGTF de la quincena (E3). Vencimientos (calendario). El paso del tiempo real (dos meses con datos) no se
 *   puede producir en una empresa creada el 24/09: se documenta.
 */
import { abrir, BASE, esperar, estado, guardarEstado, login, nuevaEvidencia, sql } from "./lib.mjs";

const E = estado();
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);
const r = {};
const resumen = (x) => ({ avisos: x.avisos, red: x.red, texto: x.texto.slice(0, 2500) });
async function elegir(page, loc, opcion) {
  const a = await clic(loc);
  await esperar(page, 500);
  const b = await clic(page.getByRole("option", { name: opcion }).first());
  return [a, b].filter((x) => typeof x === "string").join(" / ") || "ok";
}
async function periodo(page, desde, hasta) {
  const f = page.locator('input[type="date"]');
  await f.nth(0).fill(desde);
  await f.nth(1).fill(hasta);
  await esperar(page, 2500);
}

async function libros(page, ev, clave, kinds) {
  const out = {};
  for (const [kind, etiqueta] of kinds) {
    await page.goto(BASE + "/admin/libros");
    await esperar(page, 2500);
    await elegir(page, page.getByLabel(/^Libro/).first(), etiqueta);
    await periodo(page, "2026-09-01", "2026-09-30");
    const lib = await ev(page, `${clave}-${kind}-libro`);
    out[kind] = { libro: lib.texto.slice(0, 3000), red: lib.red };
    await clic(page.getByRole("tab", { name: /Conciliación con el mayor/ }));
    await esperar(page, 2500);
    out[kind].conciliacion = (await ev(page, `${clave}-${kind}-conciliacion`)).texto.slice(0, 2000);
    await clic(page.getByRole("tab", { name: /Generaciones/ }));
    await esperar(page, 2000);
    const gen = await ev(page, `${clave}-${kind}-generaciones`);
    out[kind].generaciones = gen.texto.slice(0, 1500);
    // formatos de exportación ofrecidos
    const selector = page.getByLabel("Formato de exportación");
    if ((await selector.count()) > 0) {
      await clic(selector.first());
      await esperar(page, 600);
      out[kind].formatos = await page
        .getByRole("option")
        .allInnerTexts()
        .catch(() => []);
      await page.keyboard.press("Escape");
      const boton = page.getByRole("button", { name: /Exportar y registrar…/ });
      if ((await boton.count()) > 0 && (await boton.first().isEnabled())) {
        const descarga = page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
        await clic(boton.first());
        await esperar(page, 700);
        await clic(page.getByRole("button", { name: /^Exportar y registrar$/ }).last());
        const d = await descarga;
        out[kind].exportado = d ? d.suggestedFilename() : "sin descarga";
        await esperar(page, 1500);
        out[kind].trasExportar = resumen(await ev(page, `${clave}-${kind}-exportado`));
      }
    }
  }
  return out;
}

async function declarar(page, ev, clave) {
  const out = {};
  for (const [desde, hasta, etq] of [
    ["2026-08-01", "2026-08-31", "agosto"],
    ["2026-09-01", "2026-09-30", "septiembre"],
  ]) {
    await page.goto(BASE + "/admin/declaraciones");
    await esperar(page, 2500);
    await periodo(page, desde, hasta);
    await clic(page.getByRole("button", { name: /Generar el período|Volver a generar/ }));
    await esperar(page, 3500);
    out[etq] = resumen(await ev(page, `${clave}-iva-${etq}`));
  }
  await clic(page.getByRole("tab", { name: /Vencimientos/ }));
  await esperar(page, 2000);
  out.vencimientos = (await ev(page, `${clave}-vencimientos`)).texto.slice(0, 1500);
  return out;
}

// ════════════════ E2 ════════════════
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("L", eventos);
  await login(page, E.personas.duenoE2E3, E.clave);
  r.E2libros = await libros(page, ev, "E2", [
    ["ventas", /Libro de ventas/],
    ["compras", /Libro de compras/],
  ]);
  r.E2iva = await declarar(page, ev, "E2");
  await browser.close();
}

// ════════════════ E3 ════════════════
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("L", eventos);
  await login(page, E.personas.registraE3, E.clave);
  r.E3libros = await libros(page, ev, "E3", [
    ["ventas", /Libro de ventas/],
    ["compras", /Libro de compras/],
    ["retenciones_iva", /Retenciones de IVA/],
  ]);
  r.E3iva = await declarar(page, ev, "E3");
  await page.goto(BASE + "/admin/igtf");
  await esperar(page, 3000);
  r.E3igtf = resumen(await ev(page, "E3-igtf-quincena"));
  await browser.close();
}

r.enBase = {
  ivaResultados: sql(
    `select c.trade_name, p.* from public.iva_period_results p join public.companies c on c.id=p.company_id order by p.created_at`,
  ).map((x) => x.join(" | ").slice(0, 400)),
};
guardarEstado({ l: r });
console.log(JSON.stringify(r, null, 1).slice(0, 30000));

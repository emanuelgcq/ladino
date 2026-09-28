/**
 * BLOQUE L (2) · exportar el libro de ventas de E2 de septiembre (el botón vive en la pestaña «El libro»; la 1.ª
 * pasada lo buscaba en «Generaciones»). Se guarda el CSV para ver cómo salen las notas de crédito, y se mira la
 * pestaña «Generaciones» después (hash).
 */
import fs from "node:fs";
import path from "node:path";
import {
  abrir,
  BASE,
  DIR,
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
const { browser, page, eventos } = await abrir();
const ev = nuevaEvidencia("L", eventos);
await login(page, E.personas.duenoE2E3, E.clave);
await page.goto(BASE + "/admin/libros");
await esperar(page, 2500);
const f = page.locator('input[type="date"]');
await f.nth(1).fill("2026-09-30");
await f.nth(0).fill("2026-09-01");
await esperar(page, 2500);
await clic(page.getByLabel("Formato de exportación").first());
await esperar(page, 600);
r.formatos = await page
  .getByRole("option")
  .allInnerTexts()
  .catch(() => []);
await page.keyboard.press("Escape");
const descarga = page.waitForEvent("download", { timeout: 10000 }).catch(() => null);
r.boton = await clic(page.getByRole("button", { name: /Exportar y registrar…/ }).first());
await esperar(page, 800);
await ev(page, "E2-exportar-confirmacion");
await clic(page.getByRole("button", { name: /^Exportar y registrar$/ }).last());
const d = await descarga;
if (d) {
  const destino = path.join(DIR, "L", d.suggestedFilename());
  await d.saveAs(destino);
  r.archivo = destino;
  r.contenido = fs.readFileSync(destino, "utf8").slice(0, 3000);
} else r.archivo = "sin descarga";
await esperar(page, 1500);
const x = await ev(page, "E2-exportado");
r.avisos = x.avisos;
r.red = x.red;
await clic(page.getByRole("tab", { name: /Generaciones/ }));
await esperar(page, 2000);
r.generaciones = (await ev(page, "E2-generaciones-tras-exportar")).texto.slice(-900);
await browser.close();
r.runs = sql(
  `select book_kind, period_from, period_to, row_count, left(dataset_hash, 16), format_code from public.fiscal_book_runs order by created_at`,
);
guardarEstado({ l2: r });
console.log(JSON.stringify(r, null, 1));

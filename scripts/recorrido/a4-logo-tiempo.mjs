/**
 * BLOQUE A (4) · ¿el avatar queda en blanco tras «Logo actualizado», o solo un instante? Y cuánto
 * tarda DE VERDAD la subida del logo (tiempo de la petición, no del guion).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { browser, page, eventos } = await abrir();
const ev = nuevaEvidencia("A", eventos);
await login(page, E.personas.duenaE1, E.clave);
await page.goto(BASE + "/admin/configuracion");
await esperar(page, 3500);
const avatar = async () =>
  page.evaluate(() => {
    const b = document.querySelector('button[aria-label="Cambiar el logo"]');
    const img = b?.querySelector("img");
    return img
      ? { img: true, cargada: img.complete && img.naturalWidth > 0 }
      : { img: false, texto: b?.innerText ?? "" };
  });
const antes = await avatar();
await ev(page, "logo2-antes", { avatar: antes });
await page.getByRole("button", { name: "Cambiar el logo" }).click();
await esperar(page, 700);
const t0 = Date.now();
await dialogo(page)
  .locator('input[type="file"]')
  .setInputFiles(path.join(RAIZ, "apps/web/public/favicon-512.png"));
const resp = await page.waitForResponse((r) => r.url().includes("/v1/companies/logo"), {
  timeout: 30000,
});
const msHastaRespuesta = Date.now() - t0;
await esperar(page, 300);
const alAviso = await avatar();
await ev(page, "logo2-al-aviso", { avatar: alAviso, msHastaRespuesta, status: resp.status() });
await page.keyboard.press("Escape");
await esperar(page, 2500);
const despues = await avatar();
await ev(page, "logo2-2s-despues", { avatar: despues });
guardarEstado({ a4: { antes, alAviso, despues, msHastaRespuesta, status: resp.status() } });
console.log(JSON.stringify({ antes, alAviso, despues, msHastaRespuesta, status: resp.status() }));
await browser.close();

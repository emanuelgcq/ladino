/**
 * BLOQUE A (2) · MI EMPRESA, TECLADO Y FORMA DEL REGISTRO.
 *
 *   · E1: el logo por «Mi empresa» (en el registro se perdió: el servidor no tenía almacenamiento).
 *   · E2: editar el perfil; cambiar el RIF SIN documentos emitidos, y devolverlo.
 *   · TECLADO: el asistente de registro solo con teclado (cuenta del encargado; se abandona antes de
 *     «Crear mi negocio»: esa persona entra luego por invitación).
 *   · FORMA: el asistente a 390 px en modo oscuro (cuenta del cajero; se abandona igual), y
 *     «Mi empresa» a 1024 px en oscuro.
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
  sql,
  cronometrar,
  textoMain,
  avisos,
} from "./lib.mjs";

const E = estado();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOGO = path.join(RAIZ, "apps/web/public/favicon-512.png");
const resultado = {};

async function desborde(page) {
  return page.evaluate(() => ({
    anchoDoc: document.documentElement.scrollWidth,
    anchoVentana: document.documentElement.clientWidth,
  }));
}

// ── E1 · el logo por Mi empresa ─────────────────────────────────────────────
const DESDE = process.env.A2_DESDE ?? "";
if (DESDE === "") {
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("A", eventos);
  await login(page, E.personas.duenaE1, E.clave);
  await page.goto(BASE + "/admin/configuracion");
  await esperar(page, 2500);
  await ev(page, "E1-configuracion");
  await page.getByRole("button", { name: "Cambiar el logo" }).click();
  await esperar(page, 800);
  await ev(page, "E1-dialogo-logo");
  const { ms } = await cronometrar(async () => {
    await dialogo(page).locator('input[type="file"]').setInputFiles(LOGO);
    await page
      .waitForResponse((r) => r.url().includes("/v1/companies/logo"), { timeout: 15000 })
      .catch(() => null);
    await esperar(page, 1200);
  });
  const r = await ev(page, "E1-logo-subido", { ms });
  resultado.logoE1 = {
    avisos: r.avisos,
    ms,
    base: sql(
      `select coalesce(logo_path,'(null)') from public.companies where id='${E.empresas.E1.id}'`,
    ),
  };
  await page.keyboard.press("Escape");
  await browser.close();
}

// ── E2 · editar perfil y cambiar el RIF sin documentos ──────────────────────
if (DESDE === "") {
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("A", eventos);
  await login(page, E.personas.duenoE2E3, E.clave);
  await page.goto(BASE + "/admin/configuracion");
  await esperar(page, 2500);
  await ev(page, "E2-configuracion");

  await page
    .getByRole("button", { name: /Editar/ })
    .first()
    .click();
  await esperar(page, 800);
  await ev(page, "E2-editar-abierto");
  const d = dialogo(page);
  await d.getByLabel(/^Teléfono/).fill("0251-5550299");
  const { ms: msEditar } = await cronometrar(async () => {
    await d.getByRole("button", { name: /^Guardar/ }).click();
    await esperar(page, 1800);
  });
  const rEd = await ev(page, "E2-editar-guardado", { ms: msEditar });
  resultado.editarE2 = {
    avisos: rEd.avisos,
    ms: msEditar,
    base: sql(`select phone from public.companies where id='${E.empresas.E2.id}'`),
  };

  for (const [paso, rif] of [
    ["cambio", "J-40555123-5"],
    ["vuelta", "J-40555123-4"],
  ]) {
    await page.getByRole("button", { name: /^Cambiar el RIF$/ }).click();
    await esperar(page, 800);
    await ev(page, `E2-rif-${paso}-abierto`);
    const dr = dialogo(page);
    await dr.getByLabel(/^El RIF/).fill(rif);
    const { ms } = await cronometrar(async () => {
      await dr.getByRole("button", { name: /^Guardar|Corregir con acta/ }).click();
      await esperar(page, 2000);
    });
    const rr = await ev(page, `E2-rif-${paso}-guardado`, { ms });
    resultado[`rif-${paso}`] = {
      pedido: rif,
      avisos: rr.avisos,
      ms,
      base: sql(`select tax_id from public.companies where id='${E.empresas.E2.id}'`),
    };
    await page.keyboard.press("Escape");
    await esperar(page, 500);
  }
  resultado.auditoriaRif = sql(
    `select event_type, occurred_at::text from public.audit_events where company_id='${E.empresas.E2.id}' and event_type ilike '%tax%' order by occurred_at`,
  );
  await browser.close();
}

// ── Mi empresa a 1024 px en oscuro ──────────────────────────────────────────
{
  const { browser, page, eventos } = await abrir({ forma: "tablet", oscuro: true });
  const ev = nuevaEvidencia("A", eventos);
  await login(page, E.personas.duenoE2E3, E.clave);
  await page.goto(BASE + "/admin/configuracion");
  await esperar(page, 2500);
  await ev(page, "E2-configuracion-tablet-oscuro", { desborde: await desborde(page) });
  await browser.close();
}

// ── El asistente de registro, solo con TECLADO ──────────────────────────────
async function crearCuentaTeclado(page, correo) {
  await page.goto(BASE);
  await esperar(page, 2500);
  await page.getByRole("button", { name: /Crea tu cuenta/ }).click();
  await esperar(page, 800);
  await page.locator('input[type="email"]').first().fill(correo);
  const claves = page.locator('input[type="password"]');
  await claves.nth(0).fill(E.clave);
  if ((await claves.count()) > 1) await claves.nth(1).fill(E.clave);
  await page.keyboard.press("Enter"); // enviar con Enter, no con clic
  await esperar(page, 4000);
}
async function ordenDeFoco(page, n = 8) {
  const orden = [];
  for (let i = 0; i < n; i += 1) {
    await page.keyboard.press("Tab");
    orden.push(
      await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "(body)";
        const s = getComputedStyle(el);
        const visible =
          (s.outlineStyle !== "none" && s.outlineWidth !== "0px") || s.boxShadow !== "none";
        const nombre = (
          el.getAttribute("aria-label") ||
          el.innerText ||
          el.getAttribute("placeholder") ||
          el.getAttribute("name") ||
          ""
        )
          .trim()
          .slice(0, 40);
        return `${el.tagName.toLowerCase()}${el.getAttribute("role") ? "[" + el.getAttribute("role") + "]" : ""} «${nombre}»${visible ? "" : " (SIN FOCO VISIBLE)"}`;
      }),
    );
  }
  return orden;
}
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("A", eventos);
  await crearCuentaTeclado(page, E.personas.encargado);
  const teclado = { pasos: [] };
  for (let paso = 0; paso < 9; paso += 1) {
    const antes = await textoMain(page, 300);
    if (/Crear mi negocio/.test(antes)) {
      teclado.pasos.push({ paso, llegoAlResumen: true });
      break;
    }
    const foco = await ordenDeFoco(page, 6);
    // Contesta con el teclado lo que la pantalla pregunte: escribe si hay un campo de texto
    // enfocable, elige con flechas si hay radios, y avanza con Enter.
    const campo = page.locator("main input[type=text], main input:not([type])").first();
    if ((await campo.count()) > 0 && (await campo.isVisible())) {
      await campo.focus();
      await page.keyboard.type(paso === 1 ? "Abastos Teclado" : "Dato de prueba");
    } else if ((await page.getByRole("radio").count()) > 0) {
      await page.getByRole("radio").first().focus();
      await page.keyboard.press("Space");
    }
    await page.keyboard.press("Enter");
    await esperar(page, 1200);
    const despues = await textoMain(page, 300);
    teclado.pasos.push({
      paso,
      pantalla: antes.split("\n").slice(0, 3).join(" · "),
      foco,
      avanzoConEnter: antes !== despues,
    });
    await ev(page, `teclado-paso-${paso}`);
    if (antes === despues) {
      // Enter no avanzó: se intenta con Tab hasta «Continuar»/«Empezar» y Enter.
      for (let t = 0; t < 12; t += 1) {
        await page.keyboard.press("Tab");
        const txt = await page.evaluate(() => document.activeElement?.innerText ?? "");
        if (/^(Continuar|Empezar|Después)$/.test(txt.trim())) {
          await page.keyboard.press("Enter");
          await esperar(page, 1000);
          break;
        }
      }
    }
  }
  resultado.teclado = teclado;
  await browser.close();
}

// ── El asistente a 390 px y en oscuro ───────────────────────────────────────
{
  const { browser, page, eventos } = await abrir({ forma: "movil", oscuro: true });
  const ev = nuevaEvidencia("A", eventos);
  await page.goto(BASE);
  await esperar(page, 2500);
  await ev(page, "movil-entrada", { desborde: await desborde(page) });
  await page.getByRole("button", { name: /Crea tu cuenta/ }).click();
  await esperar(page, 800);
  await page.locator('input[type="email"]').first().fill(E.personas.cajero);
  const claves = page.locator('input[type="password"]');
  await claves.nth(0).fill(E.clave);
  if ((await claves.count()) > 1) await claves.nth(1).fill(E.clave);
  await page.locator('button[type="submit"]').first().click();
  await esperar(page, 4000);
  const movil = [];
  for (let paso = 0; paso < 10; paso += 1) {
    const t = await textoMain(page, 400);
    const d = await desborde(page);
    const r = await ev(page, `movil-paso-${paso}`, { desborde: d });
    movil.push({
      paso,
      pantalla: t.split("\n").slice(0, 2).join(" · "),
      desborde: d.anchoDoc > d.anchoVentana,
      red: r.red,
    });
    if (/Crear mi negocio/.test(t)) break;
    const emp = page.getByRole("button", { name: /^Empezar$/ });
    if ((await emp.count()) > 0) {
      await emp.click();
    } else if ((await page.getByPlaceholder("Abastos La Bendición").count()) > 0) {
      await page.getByPlaceholder("Abastos La Bendición").fill("Kiosco Móvil");
      await page.getByRole("button", { name: /^Continuar$/ }).click();
    } else if ((await page.getByRole("radio", { name: /Todavía no/ }).count()) > 0) {
      await page.getByRole("radio", { name: /Todavía no/ }).click();
      await page.getByRole("button", { name: /^Continuar$/ }).click();
    } else if ((await page.getByRole("radio").count()) > 0) {
      await page.getByRole("radio").first().click();
      await page.getByRole("button", { name: /^Continuar$/ }).click();
    } else if ((await page.getByRole("button", { name: /^Después$/ }).count()) > 0) {
      await page.getByRole("button", { name: /^Después$/ }).click();
    } else if ((await page.getByPlaceholder("0414-1234567").count()) > 0) {
      await page.getByPlaceholder("0414-1234567").fill("0414-5550404");
      await page
        .getByLabel("Estado")
        .selectOption({ label: "Lara" })
        .catch(() => {});
      await page
        .locator('select[aria-label="Ciudad"]')
        .selectOption({ index: 1 })
        .catch(() => {});
      await page.getByRole("button", { name: /^Continuar$/ }).click();
    } else if ((await page.getByPlaceholder("Tu nombre completo").count()) > 0) {
      await page.getByPlaceholder("Tu nombre completo").fill("Carla Cajera");
      await page.getByRole("button", { name: /^Continuar$/ }).click();
    } else {
      await page
        .getByRole("button", { name: /^Continuar$/ })
        .click()
        .catch(() => {});
    }
    await esperar(page, 1000);
  }
  resultado.movil = movil;
  await browser.close();
}

guardarEstado({ a2: resultado });
console.log(JSON.stringify(resultado, null, 1).slice(0, 6000));

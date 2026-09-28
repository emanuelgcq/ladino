/**
 * BLOQUE A (3) · el asistente de registro con TECLADO y a 390 px en oscuro, guardando en la
 * evidencia el orden de foco de cada pantalla. Se abandona antes de «Crear mi negocio»: estas
 * cuentas son de personas que entran luego por INVITACIÓN (bloque N).
 *   TECLADO → administrativo@ (cuenta nueva).  MÓVIL → cajero@ (ya creada en a2: entra y sigue).
 */
import {
  abrir,
  BASE,
  esperar,
  estado,
  guardarEstado,
  login,
  nuevaEvidencia,
  textoMain,
} from "./lib.mjs";

const E = estado();
const resultado = {};

async function foco(page, n = 7) {
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
        const n = (
          el.getAttribute("aria-label") ||
          el.innerText ||
          el.getAttribute("placeholder") ||
          ""
        )
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 40);
        return `${el.tagName.toLowerCase()}${el.getAttribute("role") ? "[" + el.getAttribute("role") + "]" : ""} «${n}»${visible ? "" : " ·SIN FOCO VISIBLE·"}`;
      }),
    );
  }
  return orden;
}

// ── TECLADO ─────────────────────────────────────────────────────────────────
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("A", eventos);
  await page.goto(BASE);
  await esperar(page, 2500);
  // Hasta el registro, también con teclado: Tab hasta «Crea tu cuenta» y Enter.
  const focoEntrada = await foco(page, 6);
  await page.getByRole("button", { name: /Crea tu cuenta/ }).focus();
  await page.keyboard.press("Enter");
  await esperar(page, 800);
  await page.locator('input[type="email"]').first().focus();
  await page.keyboard.type(E.personas.administrativo);
  await page.keyboard.press("Tab");
  await page.keyboard.type(E.clave);
  const claves = page.locator('input[type="password"]');
  if ((await claves.count()) > 1) {
    await page.keyboard.press("Tab");
    await page.keyboard.type(E.clave);
  }
  await page.keyboard.press("Enter");
  await esperar(page, 4000);
  await ev(page, "teclado2-entrada", { foco: focoEntrada });

  const pasos = [];
  for (let paso = 0; paso < 12; paso += 1) {
    const antes = await textoMain(page, 400);
    if (/Crear mi negocio/.test(antes)) {
      pasos.push({ paso, resumen: true, foco: await foco(page, 8) });
      await ev(page, "teclado2-resumen", { foco: pasos.at(-1).foco });
      break;
    }
    const orden = await foco(page, 7);
    const campo = page
      .locator("main input[type=text], main input:not([type]), main textarea")
      .first();
    let accion = "Enter";
    if ((await campo.count()) > 0 && (await campo.isVisible())) {
      await campo.focus();
      await page.keyboard.type(
        /nombre|llama/i.test(antes) ? "Abastos Teclado" : "Dato de prueba 123",
      );
      accion = "escribir + Enter";
    } else if ((await page.getByRole("radio").count()) > 0) {
      await page
        .getByRole("radio", { name: /Todavía no/ })
        .or(page.getByRole("radio").first())
        .first()
        .focus();
      await page.keyboard.press("Space");
      accion = "Espacio en la opción + Enter";
    }
    await page.keyboard.press("Enter");
    await esperar(page, 1200);
    let despues = await textoMain(page, 400);
    let avanzo = despues !== antes;
    let tabsHastaContinuar = null;
    if (!avanzo) {
      for (let t = 1; t <= 15; t += 1) {
        await page.keyboard.press("Tab");
        const txt = (await page.evaluate(() => document.activeElement?.innerText ?? "")).trim();
        if (/^(Continuar|Empezar|Después)$/.test(txt)) {
          await page.keyboard.press("Enter");
          await esperar(page, 1000);
          tabsHastaContinuar = t;
          break;
        }
      }
      despues = await textoMain(page, 400);
    }
    pasos.push({
      paso,
      pantalla: antes.split("\n")[0],
      accion,
      avanzoConEnter: avanzo,
      tabsHastaContinuar,
      foco: orden,
    });
    await ev(page, `teclado2-paso-${paso}`, {
      foco: orden,
      avanzoConEnter: avanzo,
      tabsHastaContinuar,
    });
  }
  resultado.teclado = pasos;
  guardarEstado({ a3: resultado });
  await browser.close();
}

// ── MÓVIL 390 px, OSCURO ────────────────────────────────────────────────────
{
  const { browser, page, eventos } = await abrir({ forma: "movil", oscuro: true });
  const ev = nuevaEvidencia("A", eventos);
  await login(page, E.personas.cajero, E.clave);
  const pasos = [];
  const clic = (loc) => loc.click({ timeout: 3000 }).catch(() => {});
  for (let paso = 0; paso < 12; paso += 1) {
    const t = await textoMain(page, 400);
    const d = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      vent: document.documentElement.clientWidth,
    }));
    await ev(page, `movil2-paso-${paso}`, { desborde: d });
    pasos.push({ paso, pantalla: t.split("\n")[0], desborda: d.doc > d.vent });
    if (/Crear mi negocio/.test(t)) break;
    if ((await page.getByRole("button", { name: /^Empezar$/ }).count()) > 0) {
      await clic(page.getByRole("button", { name: /^Empezar$/ }));
    } else if ((await page.getByPlaceholder("Abastos La Bendición").count()) > 0) {
      await page.getByPlaceholder("Abastos La Bendición").fill("Kiosco Móvil");
      await clic(page.getByRole("button", { name: /^Continuar$/ }));
    } else if ((await page.getByRole("radio", { name: /Todavía no/ }).count()) > 0) {
      await clic(page.getByRole("radio", { name: /Todavía no/ }));
      await clic(page.getByRole("button", { name: /^Continuar$/ }));
    } else if ((await page.getByRole("radio").count()) > 0) {
      await clic(page.getByRole("radio").first());
      await clic(page.getByRole("button", { name: /^Continuar$/ }));
    } else if ((await page.getByRole("button", { name: /^Después$/ }).count()) > 0) {
      await clic(page.getByRole("button", { name: /^Después$/ }));
    } else if ((await page.getByPlaceholder("0414-1234567").count()) > 0) {
      await page.getByPlaceholder("0414-1234567").fill("0414-5550404");
      await page
        .getByLabel("Estado")
        .selectOption({ label: "Lara" })
        .catch(() => {});
      await esperar(page, 400);
      await page
        .locator('select[aria-label="Ciudad"]')
        .selectOption({ index: 1 })
        .catch(() => {});
      await clic(page.getByRole("button", { name: /^Continuar$/ }));
    } else if ((await page.getByPlaceholder("Tu nombre completo").count()) > 0) {
      await page.getByPlaceholder("Tu nombre completo").fill("Carla Cajera");
      await clic(page.getByRole("button", { name: /^Continuar$/ }));
    } else {
      await clic(page.getByRole("button", { name: /^Continuar$/ }));
    }
    await esperar(page, 1000);
  }
  resultado.movil = pasos;
  guardarEstado({ a3: resultado });
  await browser.close();
}
console.log(JSON.stringify(resultado, null, 1));

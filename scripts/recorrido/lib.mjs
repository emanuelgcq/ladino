/**
 * Herramientas del RECORRIDO (skill /recorrido) — Playwright contra el entorno LOCAL.
 *
 * Nada de aquí toca el remoto: la base es la local (127.0.0.1:54322), la web la de 5174 y la API la
 * de 3000. La evidencia cruda de cada pantalla (captura, texto, red, consola, tiempos) va a
 * `.recorrido/<fecha>/<bloque>/`, fuera de git, donde los agentes la leen. Solo las capturas de los
 * HALLAZGOS se copian a `docs/08_UX/capturas-recorrido/<bloque>/`.
 *
 * Playwright es dependencia de desarrollo del repo desde 2026-09-28 (`pnpm recorrido` es la
 * regresión del recorrido); PLAYWRIGHT_PATH permite usar otro. Los navegadores se instalan con
 * `npx playwright install chromium`.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASE = process.env.RECORRIDO_WEB ?? "http://localhost:5174";
export const API = process.env.RECORRIDO_API ?? "http://127.0.0.1:3000";
// El día de Caracas, no el UTC: después de las 20:00 de Caracas el día UTC ya es mañana (familia F1).
export const FECHA =
  process.env.RECORRIDO_FECHA ??
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(new Date());
export const DIR = path.join(RAIZ, ".recorrido", FECHA);
fs.mkdirSync(DIR, { recursive: true });

async function cargarPlaywright() {
  const candidatos = [process.env.PLAYWRIGHT_PATH, "playwright"].filter(Boolean);
  for (const c of candidatos) {
    try {
      const url = c.includes("/") || c.includes("\\") ? pathToFileURL(c).href : c;
      return await import(url);
    } catch {
      /* siguiente */
    }
  }
  throw new Error(
    "No encuentro Playwright. Instálalo (npx playwright install chromium) o da PLAYWRIGHT_PATH.",
  );
}
const { chromium } = await cargarPlaywright();

// ── Estado compartido entre guiones: usuarios, empresas, ids ──────────────────
const ESTADO = path.join(DIR, "estado.json");
export function estado() {
  try {
    return JSON.parse(fs.readFileSync(ESTADO, "utf8"));
  } catch {
    return {};
  }
}
export function guardarEstado(parcial) {
  fs.writeFileSync(ESTADO, JSON.stringify({ ...estado(), ...parcial }, null, 2));
}

// ── Navegador ───────────────────────────────────────────────────────────────
const TAMANOS = {
  escritorio: { width: 1366, height: 900 },
  tablet: { width: 1024, height: 768 },
  movil: { width: 390, height: 844 },
};
export async function abrir({ forma = "escritorio", oscuro = false } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: TAMANOS[forma] ?? TAMANOS.escritorio,
    locale: "es-VE",
    colorScheme: oscuro ? "dark" : "light",
    ...(forma === "movil" ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  const eventos = { consola: [], red: [], api: [] };
  // TIEMPO (dimensión 12): lo que tarda de verdad cada petición a la API, sin las esperas del guion.
  page.on("requestfinished", (req) => {
    const u = req.url();
    if (!u.includes(":3000")) return;
    const t = req.timing();
    eventos.api.push({
      m: req.method(),
      ruta: u.replace(/^https?:\/\/[^/]+/, "").slice(0, 120),
      ms: Math.round(t.responseEnd),
    });
  });
  page.on("console", (m) => {
    if (m.type() === "error") eventos.consola.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => eventos.consola.push("PAGEERROR " + String(e).slice(0, 300)));
  page.on("response", async (r) => {
    const u = r.url();
    if (r.status() >= 400 && (u.includes(":3000") || u.includes("54321"))) {
      let cuerpo = "";
      try {
        cuerpo = (await r.text()).slice(0, 300);
      } catch {
        /* sin cuerpo */
      }
      eventos.red.push(
        `${r.request().method()} ${u.replace(/^https?:\/\/[^/]+/, "")} → ${r.status()} ${cuerpo}`,
      );
    }
  });
  return { browser, context, page, eventos };
}

export async function login(page, email, clave) {
  await page.goto(BASE);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(clave);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(3500);
}

export const esperar = (page, ms = 1500) => page.waitForTimeout(ms);

export async function textoMain(page, max = 4000) {
  const t = await page
    .locator("main")
    .innerText()
    .catch(() => page.locator("body").innerText());
  return t.replace(/\n{2,}/g, "\n").slice(0, max);
}

/** Avisos (toasts) y alertas visibles. */
export async function avisos(page) {
  const t = await page
    .locator("[role=status], [role=alert], [role=dialog][data-type]")
    .allInnerTexts()
    .catch(() => []);
  return t.map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
}
export async function cerrarAvisos(page) {
  for (const b of await page.getByRole("button", { name: "Cerrar aviso" }).all()) {
    await b.click().catch(() => {});
  }
}
/** El diálogo real, no un toast (los toasts también son role=dialog, con data-type). */
export const dialogo = (page) => page.locator("[role=dialog]:not([data-type])").last();

/** Lo interactivo visible: botones, enlaces y campos con su etiqueta. */
export async function interactivo(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const nombre = (el) =>
      (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || "")
        .trim()
        .slice(0, 60);
    const botones = [...document.querySelectorAll("button, [role=button]")]
      .filter(vis)
      .map(nombre)
      .filter(Boolean);
    const enlaces = [...document.querySelectorAll("a[href]")]
      .filter(vis)
      .map((a) => `${nombre(a)} → ${a.getAttribute("href")}`);
    const campos = [...document.querySelectorAll("input, textarea, [role=combobox], select")]
      .filter(vis)
      .map((el) => {
        const lab = el.id ? document.querySelector(`label[for="${el.id}"]`)?.innerText : "";
        return `${el.tagName.toLowerCase()}[${el.getAttribute("type") || el.getAttribute("role") || ""}] ${lab || nombre(el)}`;
      });
    return { botones: [...new Set(botones)], enlaces: [...new Set(enlaces)], campos };
  });
}

/**
 * EVIDENCIA de una pantalla: captura, texto, lo interactivo, avisos, red y consola. Es lo que leen
 * los agentes. Devuelve el objeto y lo escribe en `.recorrido/<fecha>/<bloque>/<nn>-<paso>.json`.
 */
const contadores = {};
export function nuevaEvidencia(bloque, eventos) {
  const carpeta = path.join(DIR, bloque);
  fs.mkdirSync(carpeta, { recursive: true });
  // El número sigue al último que haya en la carpeta: cada guion es un proceso, y empezar en 001
  // desordenaría la evidencia de un bloque hecho en varias pasadas.
  contadores[bloque] ??= Math.max(
    0,
    ...fs
      .readdirSync(carpeta)
      .map((f) => Number.parseInt(f.slice(0, 3), 10))
      .filter((n) => Number.isInteger(n)),
  );
  return async function evidencia(page, paso, extra = {}) {
    contadores[bloque] += 1;
    const n = String(contadores[bloque]).padStart(3, "0");
    const base = path.join(carpeta, `${n}-${paso}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    const registro = {
      paso,
      url: page.url(),
      texto: await textoMain(page).catch(() => ""),
      avisos: await avisos(page),
      interactivo: await interactivo(page).catch(() => null),
      consola: [...eventos.consola],
      red: [...eventos.red],
      api: [...eventos.api],
      ...extra,
      captura: `${base}.png`,
    };
    eventos.consola.length = 0;
    eventos.red.length = 0;
    eventos.api.length = 0;
    fs.writeFileSync(`${base}.json`, JSON.stringify(registro, null, 2));
    return registro;
  };
}

/** Cronometra una acción de la persona (dimensión 12: más de 3 s es hallazgo). */
export async function cronometrar(fn) {
  const t0 = Date.now();
  const r = await fn();
  return { ms: Date.now() - t0, r };
}

// ── Base LOCAL — solo lectura desde los guiones ─────────────────────────────
export function sql(consulta) {
  const salida = execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "supabase_db_ladino",
      "psql",
      "-U",
      "postgres",
      "-At",
      "-F",
      "\t",
      "-c",
      consulta,
    ],
    { encoding: "utf8" },
  );
  return salida
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));
}
/**
 * R-82.7 · EL MONTAJE DEL FIADO. Desde E-09, fiar exige que el cliente tenga límite; un guion que
 * fía lo fija ANTES. Es la ÚNICA escritura que un guion hace por la base (lo demás es lectura):
 * como soporte, sin actor —el trigger deja su acta `system`—, igual que `fiadoDeFixture` de los
 * E2E. Solo toca a los clientes con nombre que siguen en 0.
 */
export function fijarLimiteDeFiado(companyId, limiteUsd = "100000") {
  if (!/^[0-9a-f-]{36}$/i.test(String(companyId)) || !/^\d+(\.\d+)?$/.test(String(limiteUsd))) {
    throw new Error("fijarLimiteDeFiado: empresa o límite no válidos");
  }
  sql(
    `update public.customers set credit_limit_usd = ${limiteUsd}
      where company_id = '${companyId}' and not is_system and credit_limit_usd = 0`,
  );
}

/**
 * P-05 · «¿Cuándo paga?»: la caja pide la fecha al fiar y no deja confirmar sin ella. Rellena el
 * campo del diálogo «Fiar esta venta» con el día de CARACAS más `dias` (nunca `toISOString()`).
 * Si el campo no está (el servidor no la pide), no hace nada.
 */
export async function rellenarCuandoPaga(page, dias = 15) {
  const campo = page.getByLabel("¿Cuándo paga?").first();
  if ((await campo.count()) === 0) return;
  const dia = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(
    new Date(Date.now() + dias * 86_400_000),
  );
  await campo.fill(dia);
}

export function empresaPorNombre(nombre) {
  const f = sql(
    `select id from public.companies where trade_name = '${nombre.replace(/'/g, "''")}' or legal_name = '${nombre.replace(/'/g, "''")}' limit 1`,
  );
  return f[0]?.[0] ?? null;
}

/** Los invariantes que cruzan módulos. Todos deberían dar cero (salvo los que son informe). */
export function invariantes(cid) {
  const q = (s) => {
    try {
      return sql(s);
    } catch (e) {
      return [["ERROR " + String(e.message).slice(0, 200)]];
    }
  };
  return {
    stock_reconciliation: q(
      `select count(*) from platform.stock_reconciliation('${cid}') where materialized_quantity <> recomputed_quantity or materialized_value <> recomputed_value`,
    )[0]?.[0],
    accounting_coverage_gaps: q(
      `select count(*) from platform.accounting_coverage_gaps('${cid}')`,
    )[0]?.[0],
    inventory_coverage_gaps: q(
      `select count(*) from platform.inventory_coverage_gaps('${cid}')`,
    )[0]?.[0],
    annulled_stock_gaps: q(`select count(*) from platform.annulled_stock_gaps('${cid}')`)[0]?.[0],
    inventory_ledger_gap: q(
      `select diferencia::text from platform.inventory_ledger_gap('${cid}')`,
    )[0]?.[0],
    treasury_no_ok: q(
      `select count(*) from platform.treasury_reconciliation('${cid}') where not ok`,
    )[0]?.[0],
    trial_balance: q(
      `select coalesce(sum(period_debit) - sum(period_credit), 0)::text from platform.trial_balance('${cid}', current_date, null)`,
    )[0]?.[0],
    cola_pendiente: q(
      `select count(*) from public.journal_generation_queue where status = 'pending' and company_id = '${cid}'`,
    )[0]?.[0],
  };
}

/** Registro de hallazgos del bloque, en crudo; la sesión principal los consolida. */
export function anotar(bloque, hallazgo) {
  const f = path.join(DIR, bloque, "hallazgos-guion.jsonl");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify({ ...hallazgo, ts: new Date().toISOString() }) + "\n");
}

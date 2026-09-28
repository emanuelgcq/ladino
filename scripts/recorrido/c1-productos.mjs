/**
 * BLOQUE C (1) · PRODUCTOS — el alta simple (con foto, código de barras, existencia, servicio), el
 * intento de arrastrar una foto, la importación (con errores a propósito en E2) y el producto por
 * KILO desde administración (el CSV no trae unidad). Con eso cada empresa pasa de 15 productos.
 */
import fs from "node:fs";
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
} from "./lib.mjs";

const E = estado();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FOTO = path.join(RAIZ, "apps/web/public/favicon-512.png");
const DATOS = path.join(RAIZ, ".recorrido", "2026-09-24", "C", "datos");
const clic = (loc, t = 5000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);

const PLAN = {
  E1: {
    correo: E.personas.duenaE1,
    altas: [
      {
        nombre: "Queso blanco duro 1kg",
        precio: "5.20",
        cantidad: "12",
        costo: "3.80",
        barras: "7591111000011",
        foto: true,
      },
      {
        nombre: "Refresco de cola 2L",
        precio: "2.10",
        cantidad: "24",
        costo: "1.40",
        barras: "7591111000028",
      },
      { nombre: "Recarga telefónica", precio: "1.00", servicio: true },
      { nombre: "Pan canilla", precio: "0.50", cantidad: "30", costo: "0.30", arrastrar: true },
      { nombre: "Recarga de saldo (servicio)", precio: "1.00", servicio: true },
    ],
    csv: ["E1-limpio.csv"],
    kilo: { sku: "QUE-KG", nombre: "Queso blanco a granel (por kilo)" },
  },
  E2: {
    correo: E.personas.duenoE2E3,
    altas: [
      {
        nombre: "Galletas surtidas caja x24",
        precio: "22.00",
        cantidad: "20",
        costo: "16.00",
        barras: "7592000000035",
        foto: true,
      },
      { nombre: "Servicio de paletizado", precio: "10.00", servicio: true },
    ],
    csv: ["E2-con-errores.csv", "E2-limpio.csv"],
    kilo: { sku: "QUE-GRA", nombre: "Queso blanco a granel (por kilo)" },
  },
  E3: {
    correo: E.personas.registraE3,
    altas: [
      {
        nombre: "Taladro percutor 1/2",
        precio: "65.00",
        cantidad: "6",
        costo: "44.00",
        barras: "7593000000035",
        foto: true,
      },
      { nombre: "Corte de llave", precio: "3.00", servicio: true },
    ],
    csv: ["E3-limpio.csv", "E3-extra-limpio.csv"],
    kilo: { sku: "CLA-2", nombre: "Clavos de 2 pulgadas (por kilo)" },
  },
};

const resultados = {};
const existe = (cid, nombre) =>
  Number(
    sql(
      `select count(*) from public.products where company_id='${cid}' and name = '${nombre.replace(/'/g, "''")}'`,
    )[0]?.[0] ?? 0,
  ) > 0;
for (const [clave, p] of Object.entries(PLAN)) {
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("C", eventos);
  const r = { altas: [], importaciones: [] };
  const cidE = E.empresas[clave].id;
  await login(page, p.correo, E.clave);

  // ── Alta simple: /productos es de SOLO CONSULTA (negocio/Productos.tsx:173-175); el diálogo con
  // foto, precio y existencia vive en /empezar, que ya no sale en el menú. Se entra por la URL.
  await page.goto(BASE + "/productos");
  await esperar(page, 2500);
  await ev(page, `${clave}-productos-antes`);
  await page.goto(BASE + "/empezar");
  await esperar(page, 2500);
  await clic(page.getByRole("button", { name: /Tus productos/ }).first(), 3000);
  await esperar(page, 900);
  await ev(page, `${clave}-empezar-paso-productos`);
  for (const a of p.altas) {
    if (existe(cidE, a.nombre)) {
      r.altas.push({ nombre: a.nombre, saltado: "ya existía" });
      continue;
    }
    await clic(page.getByRole("button", { name: /^Agregar producto$/ }).first());
    await esperar(page, 900);
    const d = dialogo(page);
    await d.getByLabel(/^Nombre/).fill(a.nombre);
    await d.getByLabel(/^Precio de venta/).fill(a.precio);
    if (a.servicio) {
      // El interruptor, no su texto (el primer intento pulsó el texto y no se activó).
      r.servicioClic = await clic(d.getByRole("switch", { name: /Es un servicio/ }));
      await esperar(page, 300);
    } else {
      await d.getByLabel(/¿Cuántos tienes hoy\?/).fill(a.cantidad);
      await d.getByLabel(/¿Cuánto te costó cada uno\?/).fill(a.costo);
    }
    if (a.barras) {
      await clic(d.getByRole("button", { name: /Más detalles/ }));
      await esperar(page, 400);
      await d.getByLabel(/^Código de barras/).fill(a.barras);
    }
    let arrastre = null;
    if (a.foto) {
      await d.locator('input[type="file"]').first().setInputFiles(FOTO);
      await esperar(page, 1200);
    }
    if (a.arrastrar) {
      // ¿Acepta la foto ARRASTRADA? Se suelta un archivo sobre el recuadro «Agregar foto».
      const b64 = fs.readFileSync(FOTO).toString("base64");
      const zona = d.getByRole("button", { name: /Agregar foto/ });
      const dt = await page.evaluateHandle((datos) => {
        const bytes = Uint8Array.from(atob(datos), (c) => c.charCodeAt(0));
        const t = new DataTransfer();
        t.items.add(new File([bytes], "foto.png", { type: "image/png" }));
        return t;
      }, b64);
      for (const tipo of ["dragenter", "dragover", "drop"]) {
        await zona.dispatchEvent(tipo, { dataTransfer: dt }).catch(() => {});
      }
      await esperar(page, 1200);
      arrastre = await d
        .getByRole("button", { name: /Cambiar la foto/ })
        .count()
        .then((n) => (n > 0 ? "la foto arrastrada QUEDÓ" : "la foto arrastrada NO quedó"));
      await ev(page, `${clave}-foto-arrastrada`, { arrastre });
    }
    await ev(page, `${clave}-alta-llena-${a.nombre.slice(0, 20)}`);
    const t = await cronometrar(async () => {
      await clic(d.getByRole("button", { name: /^Agregar producto$/ }));
      await esperar(page, 2500);
    });
    const ra = await ev(page, `${clave}-alta-guardada-${a.nombre.slice(0, 20)}`, { ms: t.ms });
    r.altas.push({ nombre: a.nombre, avisos: ra.avisos, red: ra.red, arrastre });
    await page.keyboard.press("Escape").catch(() => {});
  }

  // ── Importar en /admin/productos ──────────────────────────────────────────
  await page.goto(BASE + "/admin/productos");
  await esperar(page, 2500);
  await ev(page, `${clave}-admin-productos-antes`);
  for (const archivo of p.csv) {
    const primera = fs
      .readFileSync(path.join(DATOS, archivo), "utf8")
      .split(/\r?\n/)[1]
      .split(",")[0];
    if (archivo.includes("limpio") && existe(cidE, primera)) {
      r.importaciones.push({ archivo, saltado: "ya importado" });
      continue;
    }
    await clic(page.getByRole("button", { name: /^Importar$/ }).first());
    await esperar(page, 900);
    const d = dialogo(page);
    await d.locator('input[type="file"]').setInputFiles(path.join(DATOS, archivo));
    const t = await cronometrar(async () => {
      await clic(d.getByRole("button", { name: /^Importar$/ }));
      await esperar(page, 5000);
    });
    const ri = await ev(page, `${clave}-importado-${archivo.replace(/\.csv$/, "")}`, { ms: t.ms });
    const texto = await d.innerText().catch(() => "");
    r.importaciones.push({
      archivo,
      resultado: texto.replace(/\s+/g, " ").slice(0, 1500),
      red: ri.red,
    });
    await page.keyboard.press("Escape").catch(() => {});
    await esperar(page, 800);
  }

  // ── Un producto POR KILO desde administración ─────────────────────────────
  if (existe(cidE, p.kilo.nombre)) {
    r.kilo = { saltado: "ya existía" };
  } else {
    await clic(page.getByRole("button", { name: /Nuevo producto/ }).first());
    await esperar(page, 900);
    const dn = dialogo(page);
    await dn.getByRole("textbox", { name: /^(Código|SKU)\s*\*?$/ }).fill(p.kilo.sku);
    await dn.getByLabel(/^Nombre/).fill(p.kilo.nombre);
    await dn.getByLabel(/^Unidad/).click();
    await esperar(page, 400);
    await clic(page.getByRole("option", { name: /Kilogramo/ }).first());
    await esperar(page, 300);
    await ev(page, `${clave}-kilo-lleno`);
    await clic(dn.getByRole("button", { name: /Crear|Guardar/ }).last());
    await esperar(page, 2500);
    const rk = await ev(page, `${clave}-kilo-creado`);
    r.kilo = { avisos: rk.avisos, red: rk.red };
  }

  const cid = E.empresas[clave].id;
  r.base = {
    productos: sql(`select count(*) from public.products where company_id='${cid}'`)[0]?.[0],
    conFoto: sql(
      `select count(*) from public.products where company_id='${cid}' and image_path is not null`,
    )[0]?.[0],
    conBarras: sql(
      `select count(*) from public.products where company_id='${cid}' and barcode is not null`,
    )[0]?.[0],
    servicios: sql(
      `select count(*) from public.products where company_id='${cid}' and kind='service'`,
    )[0]?.[0],
    porKilo: sql(
      `select string_agg(name||' ['||status||']', ', ') from public.products where company_id='${cid}' and unit_code='kg'`,
    )[0]?.[0],
  };
  resultados[clave] = r;
  guardarEstado({ c1: resultados });
  await browser.close();
}
console.log(JSON.stringify(resultados, null, 1));

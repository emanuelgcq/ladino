/**
 * BLOQUE B · PRIMER DÍA (/empezar) — los cuatro pasos en cada empresa, como su dueño.
 *
 *   Paso 1 productos · Paso 2 cuentas · Paso 3 tasa BCV · Paso 4 facturas (o recibos).
 *
 * E1 (sin RIF) recorre la rama de recibos. E2 y E3 la de facturas: a quién vende, máquina fiscal,
 * tipo de contribuyente (E2 ordinario, E3 ESPECIAL), el IVA con acta y el talonario de imprenta.
 * En E2, además, se SALTA el paso de productos y se intenta vender antes de hacerlo bien.
 * Todo con los textos reales de apps/web/src/pages/negocio/Empezar.tsx.
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
  cronometrar,
  textoMain,
} from "./lib.mjs";

const E = estado();
if (!E.empresas) throw new Error("Falta el estado del bloque A.");

const PLAN = [
  {
    clave: "E1",
    correo: E.personas.duenaE1,
    producto: {
      nombre: "Harina de maíz precocida 1kg",
      precio: "1.10",
      cantidad: "40",
      costo: "0.80",
    },
    cuentas: [
      { nombre: "Caja de la bodega", moneda: /Bolívares/, tipo: /Caja/ },
      { nombre: "Caja en dólares", moneda: /Dólares/, tipo: /Caja/ },
      { nombre: "Banesco", moneda: /Bolívares/, tipo: /^Banco$/ },
    ],
    rif: false,
  },
  {
    clave: "E2",
    correo: E.personas.duenoE2E3,
    saltar: true,
    producto: {
      nombre: "Aceite de soya 1L (caja x12)",
      precio: "28.00",
      cantidad: "30",
      costo: "21.00",
    },
    cuentas: [
      { nombre: "Banco Mercantil", moneda: /Bolívares/, tipo: /^Banco$/ },
      { nombre: "Caja Bs", moneda: /Bolívares/, tipo: /Caja/ },
      { nombre: "Caja USD", moneda: /Dólares/, tipo: /Caja/ },
    ],
    rif: true,
    vendeA: "A negocios y empresas",
    tipo: "Ordinario",
    talonario: { desde: "1", hasta: "5000", serie: "A", imprenta: "Gráficas Lara, C.A." },
  },
  {
    clave: "E3",
    correo: E.personas.registraE3,
    producto: {
      nombre: "Tornillo autorroscante 1/2 (caja x100)",
      precio: "6.50",
      cantidad: "60",
      costo: "4.00",
    },
    cuentas: [
      { nombre: "Banesco", moneda: /Bolívares/, tipo: /^Banco$/ },
      { nombre: "Caja Bs", moneda: /Bolívares/, tipo: /Caja/ },
      { nombre: "Zelle", moneda: /Dólares/, tipo: /Billetera/ },
    ],
    rif: true,
    vendeA: "Mitad y mitad",
    tipo: "Especial",
    talonario: { desde: "1", hasta: "5000", serie: "B", imprenta: "Gráficas Lara, C.A." },
  },
];

async function elegir(page, contenedor, etiqueta, opcion) {
  await contenedor.getByLabel(etiqueta).click();
  await esperar(page, 400);
  await page.getByRole("option", { name: opcion }).first().click();
  await esperar(page, 300);
}
const clic = (loc, t = 5000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 80)}`);

const resultados = {};
for (const p of PLAN) {
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("B", eventos);
  const r = { clics: {} };
  await login(page, p.correo, E.clave);
  await page.goto(BASE + "/empezar");
  await esperar(page, 2500);
  await ev(page, `${p.clave}-entrada`);

  // ── Saltarse el paso y tratar de vender (E2) ────────────────────────────────
  if (p.saltar) {
    r.clics.saltar = await clic(page.getByRole("button", { name: /Lo hago después/ }));
    await esperar(page, 1000);
    await ev(page, `${p.clave}-salto-productos`);
    await page.goto(BASE + "/vender");
    await esperar(page, 3000);
    await ev(page, `${p.clave}-vender-sin-productos-ni-cuentas`);
    await page.goto(BASE + "/empezar");
    await esperar(page, 2500);
    await ev(page, `${p.clave}-vuelta-a-empezar`);
    // Si el asistente ya está en el paso 2, se vuelve al 1 para cargar el producto.
    const paso1 = page.getByRole("button", { name: /Tus productos/ });
    if ((await paso1.count()) > 0) await clic(paso1.first());
    await esperar(page, 800);
  }

  // ── Paso 1 · un producto ──────────────────────────────────────────────────
  const prod = p.producto;
  r.clics.agregar = await clic(page.getByRole("button", { name: /^Agregar producto$/ }).first());
  await esperar(page, 900);
  const d = dialogo(page);
  await d.getByLabel(/^Nombre/).fill(prod.nombre);
  await d.getByLabel(/^Precio de venta/).fill(prod.precio);
  await d.getByLabel(/¿Cuántos tienes hoy\?/).fill(prod.cantidad);
  await d.getByLabel(/¿Cuánto te costó cada uno\?/).fill(prod.costo);
  await ev(page, `${p.clave}-producto-lleno`);
  const alta = await cronometrar(async () => {
    await d.getByRole("button", { name: /^Agregar producto$/ }).click();
    await esperar(page, 2500);
  });
  await ev(page, `${p.clave}-producto-guardado`, { ms: alta.ms });
  r.clics.seguir1 = await clic(page.getByRole("button", { name: /^Seguir/ }).first());
  await esperar(page, 1200);

  // ── Paso 2 · cuentas ──────────────────────────────────────────────────────
  await ev(page, `${p.clave}-paso-cuentas`);
  for (const c of p.cuentas) {
    await clic(page.getByRole("button", { name: /Agregar cuenta/ }).first());
    await esperar(page, 800);
    const dc = dialogo(page);
    await dc.getByLabel(/^Nombre/).fill(c.nombre);
    await elegir(page, dc, /^Moneda/, c.moneda);
    await elegir(page, dc, /^Tipo/, c.tipo);
    await ev(page, `${p.clave}-cuenta-llena-${c.nombre}`);
    await clic(dc.getByRole("button", { name: /^Crear cuenta$/ }));
    await esperar(page, 1800);
  }
  await ev(page, `${p.clave}-cuentas-creadas`);
  r.clics.seguir2 = await clic(page.getByRole("button", { name: /^Seguir/ }).first());
  await esperar(page, 1200);

  // ── Paso 3 · tasa ─────────────────────────────────────────────────────────
  await ev(page, `${p.clave}-paso-tasa`);
  const traer = page.getByRole("button", { name: /Traer del BCV/ });
  if ((await traer.count()) > 0) {
    const t = await cronometrar(async () => {
      await traer.first().click();
      await esperar(page, 4000);
    });
    await ev(page, `${p.clave}-tasa-traida`, { ms: t.ms });
  }
  r.clics.seguir3 = await clic(page.getByRole("button", { name: /^Seguir/ }).first());
  await esperar(page, 1500);

  // ── Paso 4 · facturas o recibos ───────────────────────────────────────────
  await ev(page, `${p.clave}-paso-4`);
  if (!p.rif) {
    r.clics.todaviaNo = await clic(page.getByRole("radio", { name: "Todavía no", exact: true }));
    await esperar(page, 700);
    await ev(page, `${p.clave}-sin-rif-elegido`);
    r.clics.recibos = await clic(
      page.getByRole("button", { name: /Vender con recibos desde hoy/ }),
    );
    await esperar(page, 2000);
  } else {
    r.clics.vendeA = await clic(page.getByRole("radio", { name: p.vendeA, exact: true }));
    await esperar(page, 500);
    r.clics.maquina = await clic(page.getByRole("radio", { name: "No", exact: true }));
    await esperar(page, 700);
    await ev(page, `${p.clave}-regimen-elegido`);
    r.clics.asiFacturo = await clic(page.getByRole("button", { name: /^Así facturo$/ }));
    await esperar(page, 2200);
    await ev(page, `${p.clave}-regimen-asignado`);
    // Tipo de contribuyente, con su confirmación.
    r.clics.tipo = await clic(page.getByRole("button", { name: new RegExp(`^${p.tipo}$`) }));
    await esperar(page, 800);
    await ev(page, `${p.clave}-tipo-confirmacion`);
    r.clics.tipoOk = await clic(
      page.getByRole("button", { name: /Guardar el tipo de contribuyente/ }),
    );
    await esperar(page, 1800);
    await ev(page, `${p.clave}-tipo-guardado`);
    // El IVA que cobras: lo escribe la persona (la alícuota no está fija en el código).
    await page.getByLabel(/Porcentaje \(%\)/).fill("16");
    r.clics.iva = await clic(page.getByRole("button", { name: /Acepto este porcentaje/ }));
    await esperar(page, 1800);
    await ev(page, `${p.clave}-iva-aceptado`);
    // Talonario de la imprenta.
    const t = p.talonario;
    await page.getByLabel(/^Del número/).fill(t.desde);
    await page.getByLabel(/^Al número/).fill(t.hasta);
    await page.getByLabel(/^Serie/).fill(t.serie);
    await page.getByLabel(/^Imprenta/).fill(t.imprenta);
    await ev(page, `${p.clave}-talonario-lleno`);
    r.clics.talonario = await clic(page.getByRole("button", { name: /Registrar talonario/ }));
    await esperar(page, 2000);
  }
  const fin = await ev(page, `${p.clave}-final`);
  r.textoFinal = (fin.texto ?? "").slice(0, 600);

  // ── Lo que quedó en la base ─────────────────────────────────────────────
  const cid = E.empresas[p.clave].id;
  r.base = {
    productos: sql(`select count(*) from public.products where company_id='${cid}'`)[0]?.[0],
    cuentas: sql(
      `select string_agg(name||'/'||currency||'/'||kind, ', ' order by name) from public.company_accounts where company_id='${cid}'`,
    )[0]?.[0],
    tasa: sql(
      `select rate::text||' '||rate_date::text||' '||coalesce(source,'') from public.exchange_rates where from_currency='USD' and to_currency='VES' order by rate_date desc, created_at desc limit 1`,
    )[0]?.join(" "),
    regimen: sql(
      `select string_agg(regime_code||' desde '||effective_from::text, ', ') from public.company_fiscal_regimes where company_id='${cid}'`,
    )[0]?.[0],
    contribuyente: sql(
      `select coalesce(taxpayer_type_code,'(null)') from public.companies where id='${cid}'`,
    )[0]?.[0],
    talonarios: sql(
      `select string_agg(kind||' '||coalesce(series,'')||' '||range_from||'-'||range_to||' '||coalesce(printer_source,''), ', ') from public.fiscal_number_ranges where company_id='${cid}'`,
    )[0]?.[0],
  };
  resultados[p.clave] = r;
  guardarEstado({ b: resultados });
  await browser.close();
}
console.log(JSON.stringify(resultados, null, 1));

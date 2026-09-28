/**
 * BLOQUE I · INVENTARIO — como el dueño.
 *   E2: /inventario (con existencia, por agotarse, sin existencia; pedidos por recibir); un segundo depósito
 *       («Depósito Centro»); traslado de 5 Harina caja; conteo con diferencia (ajuste del queso); merma (galletas
 *       mojadas); vencido (café); el kardex de la harina; umbral de reposición; recetas (¿hay compuestos?); y el
 *       paso «¿A qué depósito?» de la llegada con dos depósitos, CON TECLADO (D-14).
 *   E1: la tarjeta «Agotado» en la caja (E-13: el aviso quedó sin verificar limpio).
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
} from "./lib.mjs";

const E = estado();
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);
const r = {};
const resumen = (x) => ({ avisos: x.avisos, red: x.red, texto: x.texto.slice(0, 900) });
async function elegir(page, loc, opcion) {
  const a = await clic(loc);
  await esperar(page, 500);
  const b = await clic(page.getByRole("option", { name: opcion }).first());
  return [a, b].filter((x) => typeof x === "string").join(" / ") || "ok";
}
async function picker(page, input, texto) {
  await input.fill(texto);
  await esperar(page, 1300);
  return clic(page.getByRole("option", { name: new RegExp(texto.slice(0, 16), "i") }).first());
}

async function movimiento(page, ev, etq, { op, producto, desde, hacia, cantidad, motivo }) {
  await page.goto(BASE + "/admin/inventario");
  await esperar(page, 2500);
  await clic(page.getByRole("button", { name: new RegExp(`^${op}$`) }).first());
  await esperar(page, 1000);
  const d = dialogo(page);
  const pasos = {};
  pasos.producto = await picker(page, d.getByPlaceholder(/SKU o nombre/).first(), producto);
  pasos.desde = await elegir(page, d.getByLabel(/^Depósito( de origen)?\b/).first(), desde);
  if (hacia) pasos.hacia = await elegir(page, d.getByLabel(/^Depósito de destino/).first(), hacia);
  await d
    .getByLabel(/^(Cantidad|Delta)/)
    .first()
    .fill(cantidad);
  if (motivo) await d.getByLabel(/^Motivo/).fill(motivo);
  await esperar(page, 600);
  await ev(page, `${etq}-lleno`);
  await clic(d.getByRole("button", { name: /^Registrar .*…$/ }));
  await esperar(page, 900);
  const t = await cronometrar(async () => {
    await clic(page.getByRole("button", { name: /^Registrar (el|la) / }).last());
    await esperar(page, 2800);
  });
  const x = await ev(page, `${etq}-hecho`, { ms: t.ms });
  return { pasos, ms: t.ms, ...resumen(x) };
}

// ════════════════ E2 ════════════════
{
  const cid = E.empresas.E2.id;
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("I", eventos);
  await login(page, E.personas.duenoE2E3, E.clave);

  await page.goto(BASE + "/inventario");
  await esperar(page, 3000);
  r.inventario = (await ev(page, "E2-inventario")).texto.slice(0, 1600);
  await clic(page.getByRole("tab", { name: /Movimientos/ }));
  await esperar(page, 1500);
  r.movimientos = (await ev(page, "E2-inventario-movimientos")).texto.slice(0, 1600);

  // segundo depósito
  await page.goto(BASE + "/admin/configuracion");
  await esperar(page, 2500);
  if ((await page.getByText("Depósito Centro").count()) === 0) {
    await clic(page.getByRole("button", { name: /Nuevo depósito/ }));
    await esperar(page, 900);
    const d = dialogo(page);
    await d.getByLabel(/^Nombre/).fill("Depósito Centro");
    await d
      .getByLabel(/^Código/)
      .fill("CEN")
      .catch(() => {});
    await ev(page, "E2-deposito-lleno");
    await clic(d.getByRole("button", { name: /^Crear depósito$/ }));
    await esperar(page, 2500);
    r.deposito = resumen(await ev(page, "E2-deposito-creado"));
  }

  r.traslado = await movimiento(page, ev, "E2-traslado", {
    op: "Transferencia",
    producto: "Harina precocida caja",
    desde: /Principal/,
    hacia: /Centro/,
    cantidad: "5",
  });
  r.conteo = await movimiento(page, ev, "E2-conteo", {
    op: "Ajuste",
    producto: "Queso blanco a granel",
    desde: /Principal/,
    cantidad: "-0.8",
    motivo: "Conteo físico del 25/09: la balanza da 0,8 kg menos que el sistema.",
  });
  r.merma = await movimiento(page, ev, "E2-merma", {
    op: "Salida",
    producto: "Galletas surtidas caja",
    desde: /Principal/,
    cantidad: "2",
    motivo: "Merma: dos cajas mojadas por una gotera.",
  });
  r.vencido = await movimiento(page, ev, "E2-vencido", {
    op: "Salida",
    producto: "Café molido caja",
    desde: /Principal/,
    cantidad: "1",
    motivo: "Vencido: lote de agosto.",
  });

  // existencias por depósito y kardex de la harina
  await page.goto(BASE + "/admin/inventario");
  await esperar(page, 2500);
  r.existencias = (await ev(page, "E2-existencias")).texto.slice(0, 2000);
  await clic(
    page
      .getByRole("row")
      .filter({ hasText: /Harina precocida caja/ })
      .first(),
  );
  await esperar(page, 2000);
  r.kardex = (await ev(page, "E2-kardex-harina")).texto.slice(0, 2500);
  await page.keyboard.press("Escape");

  // umbral de reposición
  await page.goto(BASE + "/admin/inventario");
  await esperar(page, 2500);
  await clic(page.getByRole("tab", { name: /Alertas/ }));
  await esperar(page, 1500);
  await clic(page.getByRole("button", { name: /Definir umbral/ }));
  await esperar(page, 900);
  {
    const d = dialogo(page);
    await picker(page, d.getByPlaceholder("SKU o nombre…").first(), "Harina precocida caja");
    await elegir(page, d.getByLabel(/^Almacén/).first(), /Principal/);
    await d.getByLabel(/^Mínimo/).fill("50");
    await ev(page, "E2-umbral-lleno");
    await clic(d.getByRole("button", { name: /^Guardar umbral$/ }));
    await esperar(page, 2500);
    r.umbral = resumen(await ev(page, "E2-umbral-guardado"));
  }
  await page.goto(BASE + "/inventario");
  await esperar(page, 3000);
  r.inventarioDespues = (await ev(page, "E2-inventario-despues")).texto.slice(0, 1200);

  // recetas
  await page.goto(BASE + "/admin/inventario");
  await esperar(page, 2500);
  await clic(page.getByRole("tab", { name: /Recetas/ }));
  await esperar(page, 1500);
  r.recetasTab = (await ev(page, "E2-recetas")).texto.slice(0, 1200);
  const def = page
    .getByRole("button", { name: /Definir la receta|Definir receta|Nueva receta/ })
    .first();
  if ((await def.count()) > 0) {
    await clic(def);
    await esperar(page, 900);
    await page.getByPlaceholder("Buscar compuesto…").first().fill("a");
    await esperar(page, 1500);
    r.compuestos = (await ev(page, "E2-receta-buscar-compuesto")).texto.slice(-500);
    await page.keyboard.press("Escape");
  }
  r.compuestosEnBase = sql(
    `select count(*) from public.products where company_id='${cid}' and is_composed`,
  )[0]?.[0];

  // «¿A qué depósito?» con dos depósitos, con teclado (D-14): «Ya era mía», 1 Galletas
  await page.goto(BASE + "/admin/llego-mercancia");
  await esperar(page, 2500);
  const sinPedido = page.getByText("No, llegó sin pedido");
  if ((await sinPedido.count()) > 0) await clic(sinPedido.first());
  await esperar(page, 600);
  await clic(page.getByText("Ya era mía").first());
  await esperar(page, 900);
  await picker(page, page.getByLabel("Producto de la línea 1"), "Galletas surtidas caja");
  await page.getByLabel("Cantidad de la línea 1").fill("1");
  await page
    .locator('input[id$="-usd"]')
    .first()
    .fill("16")
    .catch(() => {});
  await esperar(page, 1500);
  await clic(page.getByRole("button", { name: /^Seguir$/ }));
  await esperar(page, 1200);
  const paso = await ev(page, "E2-a-que-deposito");
  r.aQueDeposito = paso.texto.slice(0, 700);
  if (/¿A qué depósito\?/.test(paso.texto)) {
    // Con teclado: Tab hasta la tarjeta del Centro y Enter.
    const tarjeta = page.getByRole("button", { name: /Depósito Centro/ }).first();
    await tarjeta.focus().catch(() => {});
    await page.keyboard.press("Enter");
    await esperar(page, 1200);
    const tras = await ev(page, "E2-a-que-deposito-tras-enter");
    r.trasEnter = {
      avanzo: /¿Todo bien\?/.test(tras.texto),
      texto: tras.texto.slice(0, 600),
      botones: (tras.interactivo?.botones ?? []).slice(-8),
    };
    if (!r.trasEnter.avanzo) {
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await esperar(page, 1200);
      const tras2 = await ev(page, "E2-a-que-deposito-tab-enter");
      r.trasTabEnter = {
        avanzo: /¿Todo bien\?/.test(tras2.texto),
        texto: tras2.texto.slice(0, 400),
      };
    }
  }
  await browser.close();
}

// ════════════════ E1 · la tarjeta «Agotado» en la caja ════════════════
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("I", eventos);
  await login(page, E.personas.duenaE1, E.clave);
  await page.goto(BASE + "/vender");
  await esperar(page, 3000);
  await page.getByLabel("Buscar productos para vender").fill("Recarga");
  await esperar(page, 1500);
  await ev(page, "E1-agotado-antes");
  await clic(page.getByRole("button", { name: /Recarga telefónica/ }).first());
  await esperar(page, 700);
  const x = await ev(page, "E1-agotado-tocado");
  r.agotado = { avisos: x.avisos, carrito: x.texto.slice(-400) };
  await browser.close();
}

r.enBase = {
  depositos: sql(
    `select w.code, w.name, w.status from public.warehouses w where company_id='${E.empresas.E2.id}' order by created_at`,
  ),
  movimientos:
    sql(`select m.kind, p.name, w.name, m.quantity::text, m.unit_cost::text, coalesce(m.reason,'') from public.inventory_moves m
                      join public.products p on p.id=m.product_id join public.warehouses w on w.id=m.warehouse_id
                     where m.company_id='${E.empresas.E2.id}' and m.created_at > now() - interval '20 minutes' order by m.created_at`),
};
guardarEstado({ i: r });
console.log(JSON.stringify(r, null, 1).slice(0, 20000));

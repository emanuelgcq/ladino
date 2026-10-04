/**
 * BLOQUE E (2) · lo que falta del bloque E y lo que A dejó para cuando hubiera documentos.
 *   1. E2: un cliente MARCADO AL MAYOR (lista preferida «mayor», solo se puede al crearlo en
 *      /admin/clientes) y una venta en caja a él: ¿cobra el precio al mayor?
 *   2. E3: un cliente ESPECIAL (agente de retención) y una venta fiada a él, para cobrarla con
 *      retención en el bloque F.
 *   3. E2: cotización y pedido en /admin/ventas/nueva.
 *   4. (de A) E2 con documentos emitidos: «Cambiar el RIF» (¿qué dice?) y «Corregir RIF» con motivo,
 *      ida y vuelta.
 */
import {
  abrir,
  BASE,
  dialogo,
  esperar,
  estado,
  fijarLimiteDeFiado,
  guardarEstado,
  login,
  nuevaEvidencia,
  rellenarCuandoPaga,
  sql,
} from "./lib.mjs";

const E = estado();
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);
const r = {};

async function elegir(page, loc, opcion) {
  await clic(loc);
  await esperar(page, 400);
  return clic(page.getByRole("option", { name: opcion }).first());
}

async function nuevoCliente(page, ev, etq, c) {
  await page.goto(BASE + "/admin/clientes");
  await esperar(page, 2500);
  if ((await page.getByText(c.nombre, { exact: true }).count()) > 0) return "ya existía";
  await clic(page.getByRole("button", { name: /Nuevo cliente/ }).first());
  await esperar(page, 900);
  const d = dialogo(page);
  await d
    .getByLabel(/^(RIF|Cédula o RIF)/)
    .first()
    .fill(c.rif);
  await d
    .getByLabel(/^(Razón social|Nombre)/)
    .first()
    .fill(c.nombre);
  await elegir(page, d.getByLabel(/^Tipo de persona/), c.persona);
  await elegir(page, d.getByLabel(/^Clasificación fiscal/), c.fiscal);
  if (c.lista) await elegir(page, d.getByLabel(/^Lista de precios preferida/), c.lista);
  await d.getByLabel(/^(Dirección fiscal|Dirección)/).fill(c.direccion);
  await ev(page, `${etq}-cliente-lleno`);
  await clic(d.getByRole("button", { name: /^Crear cliente$/ }));
  await esperar(page, 2000);
  const x = await ev(page, `${etq}-cliente-creado`);
  return { avisos: x.avisos, red: x.red };
}

// ── 1 · E2: cliente al mayor y venta en caja ────────────────────────────────
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("E", eventos);
  await login(page, E.personas.duenoE2E3, E.clave);
  r.clienteMayor = await nuevoCliente(page, ev, "E2-mayor", {
    rif: "J-40888777-6",
    nombre: "Bodegón Mayorista Los Andes, C.A.",
    persona: /Jurídica/i,
    fiscal: /Ordinario/i,
    lista: /^mayor/i,
    direccion: "Carrera 19 con calle 25, Barquisimeto",
  });
  // Venta en caja al cliente al mayor: el precio de la Harina debería salir de «mayor» (22 frente a 24).
  await page.goto(BASE + "/vender");
  await esperar(page, 2500);
  if ((await page.getByLabel("Cédula o RIF del cliente").count()) === 0)
    await clic(page.getByRole("button", { name: /Poner cliente/ }).first(), 3000);
  await clic(page.locator("#pos-prefijo"));
  await clic(page.getByRole("option", { name: "J", exact: true }).first());
  await page.getByLabel("Cédula o RIF del cliente").fill("408887776");
  await page.getByLabel("Cédula o RIF del cliente").press("Enter");
  await esperar(page, 1800);
  await page.getByLabel("Buscar productos para vender").fill("Harina precocida caja");
  await esperar(page, 1500);
  await clic(page.getByRole("button", { name: /Harina precocida caja/ }).first());
  await esperar(page, 1800);
  const carrito = await ev(page, "E2-mayor-carrito");
  r.carritoMayor = carrito.texto.slice(-500);
  await clic(page.getByRole("button", { name: /Cobrar\s*·\s*F2/ }).first());
  await esperar(page, 1200);
  await clic(
    dialogo(page)
      .getByRole("button", { name: /Transferencia/ })
      .first(),
  );
  await esperar(page, 900);
  await clic(
    dialogo(page)
      .getByRole("button", { name: /^Cobrar / })
      .first(),
  );
  await esperar(page, 3000);
  const hecho = await ev(page, "E2-mayor-hecho");
  r.ventaMayor = { avisos: hecho.avisos, red: hecho.red };
  await clic(page.getByRole("button", { name: /Nueva venta/ }).first(), 3000);

  // ── 3 · cotización y pedido ─────────────────────────────────────────────
  for (const [tipo, boton] of [
    ["cotizacion", /^Guardar cotización$/],
    ["pedido", /^Guardar pedido$/],
  ]) {
    await page.goto(BASE + "/admin/ventas/nueva");
    await esperar(page, 2500);
    const cli = page.getByPlaceholder("Buscar por nombre o RIF…");
    await cli.fill("Abastos El Sol");
    await esperar(page, 1300);
    await clic(page.getByRole("option", { name: /Abastos El Sol/ }).first());
    await esperar(page, 600);
    await elegir(
      page,
      page
        .getByRole("combobox", { name: /Almacén/ })
        .or(page.getByText("¿De dónde sale?"))
        .first(),
      /Principal/,
    );
    await page.getByPlaceholder("Producto (nombre o SKU)…").first().fill("Pasta caja x20");
    await esperar(page, 1300);
    await clic(page.getByRole("option", { name: /Pasta caja x20/ }).first());
    await page.getByLabel("Cantidad").first().fill("8");
    await esperar(page, 800);
    await ev(page, `E2-${tipo}-lleno`);
    await clic(page.getByRole("button", { name: boton }));
    await esperar(page, 2500);
    const x = await ev(page, `E2-${tipo}-guardado`);
    r[tipo] = { avisos: x.avisos, red: x.red, url: page.url() };
  }

  // ── 4 · (de A) el RIF con documentos emitidos ───────────────────────────
  await page.goto(BASE + "/admin/configuracion");
  await esperar(page, 2500);
  await clic(page.getByRole("button", { name: /^Cambiar el RIF$/ }));
  await esperar(page, 800);
  await ev(page, "E2-rif-con-documentos-abierto");
  await dialogo(page)
    .getByLabel(/^El RIF/)
    .fill("J-40555123-7");
  await clic(dialogo(page).getByRole("button", { name: /^Guardar/ }));
  await esperar(page, 2000);
  const c1 = await ev(page, "E2-rif-con-documentos-intento");
  r.cambiarConDocs = { avisos: c1.avisos, red: c1.red };
  await page.keyboard.press("Escape");
  await esperar(page, 600);
  for (const [paso, rif] of [
    ["correccion", "J-40555123-9"],
    ["correccion-vuelta", "J-40555123-4"],
  ]) {
    await clic(page.getByRole("button", { name: /Corregir RIF/ }));
    await esperar(page, 800);
    const d = dialogo(page);
    await d.getByLabel(/^El RIF correcto/).fill(rif);
    await d
      .getByLabel(/^¿Qué pasó\?/)
      .fill("Error de tipeo en el último dígito al registrar la empresa.");
    await ev(page, `E2-rif-${paso}-lleno`);
    await clic(d.getByRole("button", { name: /Corregir con acta|Guardar/ }));
    await esperar(page, 2200);
    const x = await ev(page, `E2-rif-${paso}-hecha`);
    r[paso] = {
      avisos: x.avisos,
      red: x.red,
      rif: sql(`select tax_id from public.companies where id='${E.empresas.E2.id}'`)[0]?.[0],
    };
    await page.keyboard.press("Escape");
    await esperar(page, 600);
  }
  await browser.close();
}

// ── 2 · E3: cliente especial y venta fiada (para la retención de F) ─────────
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("E", eventos);
  await login(page, E.personas.registraE3, E.clave);
  r.clienteEspecial = await nuevoCliente(page, ev, "E3-especial", {
    rif: "J-30777666-5",
    nombre: "Inversiones Metálicas Lara, C.A.",
    persona: /Jurídica/i,
    fiscal: /Especial/i,
    direccion: "Zona Industrial I, Barquisimeto",
  });
  // R-82.7: el cliente recién creado nace con límite 0 (E-09); este guion le fía.
  fijarLimiteDeFiado(E.empresas.E3.id);
  await page.goto(BASE + "/vender");
  await esperar(page, 2500);
  if ((await page.getByLabel("Cédula o RIF del cliente").count()) === 0)
    await clic(page.getByRole("button", { name: /Poner cliente/ }).first(), 3000);
  await clic(page.locator("#pos-prefijo"));
  await clic(page.getByRole("option", { name: "J", exact: true }).first());
  await page.getByLabel("Cédula o RIF del cliente").fill("307776665");
  await page.getByLabel("Cédula o RIF del cliente").press("Enter");
  await esperar(page, 1800);
  for (const p of ["Pintura de caucho", "Llave inglesa"]) {
    await page.getByLabel("Buscar productos para vender").fill(p);
    await esperar(page, 1400);
    await clic(page.getByRole("button", { name: new RegExp(p) }).first());
    await esperar(page, 900);
  }
  await ev(page, "E3-especial-carrito");
  await clic(page.getByRole("button", { name: /Cobrar\s*·\s*F2/ }).first());
  await esperar(page, 1200);
  await clic(
    dialogo(page)
      .getByRole("button", { name: /Fiar todo/ })
      .first(),
  );
  await esperar(page, 800);
  await rellenarCuandoPaga(page); // P-05: sin la fecha, la caja no deja confirmar
  await clic(page.getByRole("button", { name: /Fiar y registrar/ }).first());
  await esperar(page, 3000);
  const x = await ev(page, "E3-especial-fiado");
  r.ventaEspecial = { avisos: x.avisos, red: x.red };
  await browser.close();
}
r.docs =
  sql(`select c.trade_name, d.kind, d.series||'-'||coalesce(d.document_number::text,''), d.status, d.total_amount::text
                from public.documents d join public.companies c on c.id = d.company_id
               where d.created_at > now() - interval '15 minutes' order by d.created_at`);
guardarEstado({ e2: r });
console.log(JSON.stringify(r, null, 1).slice(0, 5000));

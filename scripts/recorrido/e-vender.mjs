/**
 * BLOQUE E · VENDER (/vender) — como el dueño en el mostrador.
 *   · Cédula nueva y existente, con cada prefijo (V, E, J, G, P).
 *   · Cada forma de pago, pago mixto, vuelto, fiar todo y fiar lo que falta.
 *   · Cantidades con decimales (por kilo), código de barras escrito como lo haría el lector.
 *   · Venta de un producto sin existencia, varias cuentas abiertas a la vez.
 *   · E1 vende con RECIBO, E2 y E3 con FACTURA; E3 (especial) cobra en divisas → IGTF.
 *   · El PDF de cada documento se GUARDA en .recorrido/<fecha>/E/pdf/ para leerlo texto a texto.
 * Uso: node scripts/recorrido/e-vender.mjs [E1|E2|E3]   (sin argumento, las tres)
 */
import fs from "node:fs";
import path from "node:path";
import {
  abrir,
  BASE,
  DIR,
  dialogo,
  esperar,
  estado,
  fijarLimiteDeFiado,
  guardarEstado,
  login,
  nuevaEvidencia,
  rellenarCuandoPaga,
  sql,
  cronometrar,
} from "./lib.mjs";

const E = estado();
const PDF = path.join(DIR, "E", "pdf");
fs.mkdirSync(PDF, { recursive: true });
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);

async function identificar(page, ev, etq, cli) {
  // Sin cliente es lo de fábrica: el campo del documento vive detrás de «Poner cliente (opcional)».
  if (!cli) return "sin identificar";
  if ((await page.getByLabel("Cédula o RIF del cliente").count()) === 0) {
    await clic(page.getByRole("button", { name: /Poner cliente/ }).first(), 3000);
    await esperar(page, 500);
  }
  const [prefijo, digitos] = [cli.doc[0], cli.doc.slice(1).replace(/\D/g, "")];
  await clic(page.locator("#pos-prefijo"));
  await esperar(page, 300);
  await clic(page.getByRole("option", { name: prefijo, exact: true }).first());
  await page.getByLabel("Cédula o RIF del cliente").fill(digitos);
  await page.getByLabel("Cédula o RIF del cliente").press("Enter");
  await esperar(page, 1800);
  // ¿No existe? Se crea ahí mismo.
  const guardar = page.getByRole("button", { name: /Guardar y seguir/ });
  if ((await guardar.count()) > 0) {
    await page
      .getByLabel(/^(Nombre completo|Razón social|Nombre de la empresa)/)
      .first()
      .fill(cli.nombre);
    if (cli.telefono)
      await page
        .getByLabel(/^Teléfono/)
        .fill(cli.telefono)
        .catch(() => {});
    if (cli.direccion)
      await page
        .getByLabel(/^Dirección/)
        .fill(cli.direccion)
        .catch(() => {});
    await ev(page, `${etq}-cliente-nuevo`);
    await clic(guardar.first());
    await esperar(page, 1800);
    return "nuevo";
  }
  return "existente";
}

async function agregar(page, producto, cantidad) {
  const buscar = page.getByLabel("Buscar productos para vender");
  await buscar.fill(producto);
  await esperar(page, 1500);
  if (producto.match(/^\d{8,}$/)) {
    // Como el lector de código de barras: escribe el código y Enter.
    await buscar.press("Enter");
    await esperar(page, 1500);
  } else {
    // La TARJETA del producto (el «Agregar uno de…» es el «+» del carrito, no la tarjeta).
    await clic(
      page
        .getByRole("button", {
          name: new RegExp(producto.slice(0, 18).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        })
        .filter({ hasNotText: /^$/ })
        .first(),
    );
    await esperar(page, 900);
  }
  if (cantidad && cantidad !== "1") {
    const nombre = producto.match(/^\d{8,}$/) ? null : producto.slice(0, 14);
    const campo = nombre
      ? page.getByLabel(new RegExp(`Cantidad de ${nombre}`, "i")).first()
      : page.getByLabel(/^Cantidad de /).last();
    await campo.fill(cantidad);
    await campo.press("Tab");
    await esperar(page, 1200);
  }
  await buscar.fill("");
}

async function guardarPdf(page, etq) {
  const [resp] = await Promise.all([
    page
      .waitForResponse((r) => /\/pdf(\?|$)/.test(r.url()) && r.status() === 200, { timeout: 15000 })
      .catch(() => null),
    clic(page.getByRole("button", { name: /Imprimir/ }).first()),
  ]);
  if (!resp) return null;
  const archivo = path.join(PDF, `${etq}.pdf`);
  fs.writeFileSync(archivo, await resp.body());
  return archivo;
}

async function venta(page, ev, clave, v) {
  const etq = `${clave}-${v.id}`;
  const r = { id: v.id };
  await page.goto(BASE + "/vender");
  await esperar(page, 2500);
  // Las cuentas abiertas vuelven de la NUBE (PUT /v1/pos/carts): se descartan las que haya, como lo
  // haría la persona, para que cada venta empiece limpia (salvo la que se deja en espera a propósito).
  if (!v.otraCuenta) {
    // «Cerrar» solo aparece con más de una cuenta: se abre una nueva y se descartan las viejas.
    const sucia =
      (await page.getByRole("button", { name: /^Quitar uno de |^Cambiar$/ }).count()) > 0 ||
      (await page.getByRole("button", { name: /^Cerrar / }).count()) > 0;
    if (sucia) {
      await clic(page.getByRole("button", { name: "Abrir otra cuenta" }), 3000);
      await esperar(page, 600);
      for (let i = 0; i < 8; i += 1) {
        const cerrar = page.getByRole("button", { name: /^Cerrar / });
        if ((await cerrar.count()) <= 1) break; // queda la nueva, vacía y activa
        await clic(cerrar.first(), 3000);
        await esperar(page, 500);
        const descartar = page.getByRole("button", { name: /^Descartar$/ });
        if ((await descartar.count()) > 0) await clic(descartar.first(), 3000);
        await esperar(page, 700);
      }
    }
  }
  if (v.otraCuenta) {
    await clic(page.getByRole("button", { name: "Abrir otra cuenta" }));
    await esperar(page, 800);
  }
  r.cliente = await identificar(page, ev, etq, v.cliente);
  // R-82.7: fiar exige límite (E-09). Con el cliente ya identificado (o recién creado) y ANTES de
  // cargar el carrito: la cotización que decide si «Fiar» se ofrece se pide después.
  if (v.fiar) fijarLimiteDeFiado(E.empresas[clave].id);
  for (const [p, c] of v.lineas) await agregar(page, p, c);
  if (v.documento) {
    await clic(page.getByLabel("Tipo de documento"));
    await esperar(page, 300);
    await clic(page.getByRole("option", { name: v.documento }).first());
    await esperar(page, 800);
  }
  const carrito = await ev(page, `${etq}-carrito`);
  r.carrito = carrito.texto.slice(0, 700);
  if (v.soloCarrito) return r; // p. ej. una cuenta que queda en espera
  // Cobrar
  await clic(page.getByRole("button", { name: /Cobrar\s*·\s*F2/ }).first());
  await esperar(page, 1200);
  await ev(page, `${etq}-cobrar-abierto`);
  const d = dialogo(page);
  for (const [i, p] of (v.pagos ?? []).entries()) {
    await clic(d.getByRole("button", { name: p.forma }).first());
    await esperar(page, 900);
    if (p.monto) {
      await d.locator(`#pos-pago-${i}`).fill(p.monto);
      await esperar(page, 1400);
    }
    if (p.ref)
      await d
        .getByLabel("Referencia del pago")
        .nth(i)
        .fill(p.ref)
        .catch(() => {});
  }
  const lleno = await ev(page, `${etq}-cobro-lleno`);
  r.cobro = lleno.texto.slice(0, 900);
  const t = await cronometrar(async () => {
    if (v.fiar) {
      await clic(d.getByRole("button", { name: /Fiar (todo|lo que falta)/ }).first());
      await esperar(page, 800);
      // P-05: la caja pide «¿Cuándo paga?» y no deja confirmar sin la fecha.
      await rellenarCuandoPaga(page);
      await ev(page, `${etq}-fiar-confirmar`);
      await clic(page.getByRole("button", { name: /Fiar y registrar/ }).first());
    } else {
      await clic(d.getByRole("button", { name: /^Cobrar / }).first());
    }
    await esperar(page, 3000);
  });
  const hecho = await ev(page, `${etq}-hecho`, { ms: t.ms });
  r.hecho = { ms: t.ms, avisos: hecho.avisos, red: hecho.red };
  const ult = sql(
    `select kind||' '||coalesce(series,'')||'-'||coalesce(document_number::text,'')||' '||status||' '||total_amount::text from public.documents where company_id='${E.empresas[clave].id}' and created_at > now() - interval '40 seconds' order by created_at desc limit 1`,
  );
  r.hecho.doc = ult[0]?.[0] ?? null;
  r.pdf = await guardarPdf(page, etq);
  await esperar(page, 1000);
  await clic(page.getByRole("button", { name: /Nueva venta/ }).first(), 3000);
  return r;
}

const PLAN = {
  E1: {
    correo: E.personas.duenaE1,
    ventas: [
      {
        id: "sin-identificar-efectivo",
        lineas: [
          ["Harina de maíz precocida", "2"],
          ["Refresco de cola", "1"],
        ],
        pagos: [{ forma: /Efectivo Bs/ }],
      },
      {
        id: "V-nueva-kilo-pago-movil",
        cliente: { doc: "V18222333", nombre: "Luisa Pérez", telefono: "0414-5550111" },
        lineas: [
          ["Queso blanco a granel", "1.35"],
          ["Pan canilla", "4"],
        ],
        pagos: [{ forma: /Pago móvil/, ref: "0102-889911" }],
      },
      {
        id: "V-existente-fiar-todo",
        cliente: { doc: "V18222333" },
        lineas: [["Arroz blanco 1kg", "3"]],
        fiar: true,
      },
      {
        id: "E-nueva-mixto-vuelto",
        cliente: { doc: "E84111222", nombre: "Jean Pierre Dubois" },
        lineas: [
          ["Aceite vegetal 1L", "2"],
          ["Café molido 250g", "1"],
        ],
        pagos: [
          { forma: /Efectivo (USD|\$|dólares)/i, monto: "5" },
          { forma: /Efectivo Bs/, monto: "3000" },
        ],
      },
      {
        id: "codigo-de-barras",
        lineas: [["7591111000011", "1"]],
        pagos: [{ forma: /Efectivo Bs/ }],
      },
      {
        id: "sin-existencia",
        lineas: [["Recarga telefónica", "1"]],
        pagos: [{ forma: /Efectivo Bs/ }],
      },
      { id: "dos-cuentas-a", lineas: [["Sardinas en lata", "2"]], soloCarrito: true },
      {
        id: "dos-cuentas-b",
        otraCuenta: true,
        lineas: [["Atún en lata", "1"]],
        pagos: [{ forma: /Efectivo Bs/ }],
      },
    ],
  },
  E2: {
    correo: E.personas.duenoE2E3,
    ventas: [
      {
        id: "J-nueva-transferencia",
        cliente: {
          doc: "J409998881",
          nombre: "Abastos El Sol, C.A.",
          direccion: "Calle 30 con carrera 21, Barquisimeto",
        },
        lineas: [
          ["Harina precocida caja x20", "10"],
          ["Arroz caja x24", "5"],
        ],
        pagos: [{ forma: /Transferencia/, ref: "TRF-778812" }],
      },
      {
        id: "G-nueva-fiar-parcial",
        cliente: {
          doc: "G200001234",
          nombre: "Alcaldía de Iribarren",
          direccion: "Plaza Bolívar, Barquisimeto",
        },
        lineas: [
          ["Café molido caja x12", "2"],
          ["Azúcar caja x24", "3"],
        ],
        pagos: [{ forma: /Pago móvil/, monto: "20000", ref: "PM-1122" }],
        fiar: true,
      },
      {
        id: "P-nueva-efectivo-usd",
        cliente: { doc: "PAB1234567", nombre: "John Smith" },
        lineas: [["Galletas surtidas caja x24", "1"]],
        pagos: [{ forma: /Efectivo (USD|\$|dólares)/i }],
      },
      {
        id: "V-nueva-kilo",
        cliente: { doc: "V12345678", nombre: "Pedro Rivas" },
        lineas: [["Queso blanco a granel", "2.5"]],
        pagos: [{ forma: /Punto|Débito|Tarjeta/i }],
      },
    ],
  },
  E3: {
    correo: E.personas.registraE3,
    ventas: [
      {
        id: "J-nueva-mixto-igtf",
        cliente: {
          doc: "J301112223",
          nombre: "Constructora Lara, C.A.",
          direccion: "Av. Libertador, Barquisimeto",
        },
        lineas: [
          ["Cemento gris", "4"],
          ["Cabilla 3/8", "10"],
        ],
        pagos: [
          { forma: /Zelle/, monto: "50", ref: "ZL-9981" },
          { forma: /Transferencia/, ref: "TRF-5510" },
        ],
      },
      {
        id: "V-nueva-zelle-igtf",
        cliente: { doc: "V9876543", nombre: "Ramón Díaz" },
        lineas: [
          ["Clavos de 2 pulgadas", "2.5"],
          ["Martillo de uña", "1"],
        ],
        pagos: [{ forma: /Zelle/, ref: "ZL-9982" }],
      },
      // Con la percepción YA activada en /admin/igtf (se activó a mano tras ver que no percibía).
      {
        id: "J-existente-mixto-igtf-activado",
        cliente: { doc: "J301112223" },
        lineas: [
          ["Tubo PVC", "5"],
          ["Brocha 2 pulgadas", "4"],
        ],
        pagos: [
          { forma: /Zelle/, monto: "20", ref: "ZL-9983" },
          { forma: /Transferencia/, ref: "TRF-5511" },
        ],
      },
      {
        id: "V-existente-zelle-igtf-activado",
        cliente: { doc: "V9876543" },
        lineas: [["Destornillador plano", "2"]],
        pagos: [{ forma: /Zelle/, ref: "ZL-9984" }],
      },
    ],
  },
};

const solo = process.argv[2];
const resultados = estado().e ?? {};
for (const [clave, p] of Object.entries(PLAN)) {
  if (solo && solo !== clave) continue;
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("E", eventos);
  await login(page, p.correo, E.clave);
  resultados[clave] ??= {};
  for (const v of p.ventas) {
    if (resultados[clave][v.id]?.hecho?.doc) continue; // reanudable: solo lo que dejó documento
    try {
      resultados[clave][v.id] = await venta(page, ev, clave, v);
    } catch (e) {
      resultados[clave][v.id] = { error: String(e).slice(0, 300) };
      await ev(page, `${clave}-${v.id}-FALLO`).catch(() => {});
    }
    guardarEstado({ e: resultados });
  }
  await browser.close();
}
const cids = Object.fromEntries(Object.entries(E.empresas).map(([k, v]) => [k, v.id]));
for (const [k, cid] of Object.entries(cids)) {
  resultados[k] ??= {};
  resultados[k].base = sql(
    `select kind, status, count(*)::text, sum(total_amount)::text from public.documents where company_id='${cid}' group by kind, status order by 1`,
  );
}
guardarEstado({ e: resultados });
console.log(JSON.stringify(resultados, null, 1).slice(0, 6000));

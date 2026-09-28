/**
 * BLOQUE N · USUARIOS Y ROLES — E2 (y el dueño en E3, para el bloque O).
 *   El almacenista se crea su cuenta. El dueño de E2 agrega a cajero@ (Cajero), encargado@ (Encargado),
 *   administrativo@ (Administrador) y almacenista@ (Operación de almacén); el contador ya entró en K. tornillo@ agrega
 *   a dueno.andina@ como Dueño de E3.
 *   Con cada rol: dónde aterriza, qué menú ve, qué da Ctrl+K, y una muestra de lo que puede y no puede hacer:
 *     cajero: vender y FIAR a un cliente nuevo (E-09), ver las cuentas de otros en la caja (E-08), abrir Ventas por URL;
 *     encargado: productos (C-08: «Importar»), cerrar caja;
 *     administrativo: anular una factura fiada (G-08), registrar gasto;
 *     contador: /vender (¿puede vender?), contabilidad;
 *     almacenista: recibir el pedido n.º 1 en «Llegó mercancía» (pendiente de D).
 *   Después: quitar el rol al encargado y desactivar al cajero — ¿qué ven al entrar? — y reactivar.
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
const r = { roles: {} };
const resumen = (x) => ({ avisos: x.avisos, red: x.red, texto: x.texto.slice(0, 1200) });
async function elegir(page, loc, opcion) {
  const a = await clic(loc);
  await esperar(page, 500);
  const b = await clic(page.getByRole("option", { name: opcion }).first());
  return [a, b].filter((x) => typeof x === "string").join(" / ") || "ok";
}
const P = E.personas;

async function crearCuenta(correo, ev, page) {
  await page.goto(BASE);
  await esperar(page, 2500);
  await clic(page.getByRole("button", { name: /Crea tu cuenta/ }));
  await esperar(page, 800);
  await page.locator('input[type="email"]').first().fill(correo);
  const claves = page.locator('input[type="password"]');
  await claves.nth(0).fill(E.clave);
  if ((await claves.count()) > 1) await claves.nth(1).fill(E.clave);
  await page.locator('button[type="submit"]').first().click();
  await esperar(page, 4000);
  return { url: page.url(), ...resumen(await ev(page, `cuenta-${correo.split("@")[0]}`)) };
}
async function agregar(page, ev, etq, correo, oficio) {
  await page.goto(BASE + "/admin/configuracion");
  await esperar(page, 2500);
  if ((await page.getByText(correo, { exact: false }).count()) > 0) return "ya estaba";
  await clic(page.getByRole("button", { name: /Agregar persona/ }));
  await esperar(page, 900);
  const d = dialogo(page);
  await d.getByLabel(/^Correo/).fill(correo);
  await elegir(page, d.getByLabel(/^Oficio/), oficio);
  await ev(page, `${etq}-lleno`);
  await clic(d.getByRole("button", { name: /^Agregar$/ }));
  await esperar(page, 2500);
  return resumen(await ev(page, `${etq}-hecho`));
}
async function recorridoSeco(page, ev, clave) {
  await esperar(page, 2500);
  const a = await ev(page, `${clave}-aterriza`);
  const out = {
    url: page.url(),
    texto: a.texto.slice(0, 700),
    enlaces: (a.interactivo?.enlaces ?? []).map((e) => e.split(" → ")[0]).slice(0, 40),
  };
  await page.keyboard.press("Control+k");
  await esperar(page, 900);
  await page.keyboard.type("factura");
  await esperar(page, 1200);
  const k = await ev(page, `${clave}-ctrl-k`);
  out.ctrlK = k.texto.slice(-500);
  out.ctrlKOpciones = await page
    .getByRole("option")
    .allInnerTexts()
    .catch(() => []);
  await page.keyboard.press("Escape");
  return out;
}

// ── cuentas y altas ──
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("N", eventos);
  if (sql(`select count(*) from auth.users where email='${P.almacenista}'`)[0]?.[0] === "0")
    r.cuentaAlmacenista = await crearCuenta(P.almacenista, ev, page);
  await login(page, P.duenoE2E3, E.clave);
  r.altas = {
    cajero: await agregar(page, ev, "E2-agregar-cajero", P.cajero, /^Cajero/),
    encargado: await agregar(page, ev, "E2-agregar-encargado", P.encargado, /^Encargado/),
    administrativo: await agregar(
      page,
      ev,
      "E2-agregar-administrativo",
      P.administrativo,
      /^Administrador/,
    ),
    almacenista: await agregar(
      page,
      ev,
      "E2-agregar-almacenista",
      P.almacenista,
      /Operación de almacén/,
    ),
  };
  // un correo que no se registró todavía
  await clic(page.getByRole("button", { name: /Agregar persona/ }));
  await esperar(page, 900);
  await dialogo(page)
    .getByLabel(/^Correo/)
    .fill("nadie.registrado@example.com");
  await elegir(page, dialogo(page).getByLabel(/^Oficio/), /^Cajero/);
  await clic(dialogo(page).getByRole("button", { name: /^Agregar$/ }));
  await esperar(page, 2000);
  r.altaSinCuenta = resumen(await ev(page, "E2-agregar-sin-cuenta"));
  await page.keyboard.press("Escape");
  await page.goto(BASE + "/admin/configuracion");
  await esperar(page, 2500);
  r.usuariosE2 = (await ev(page, "E2-usuarios")).texto.slice(0, 2500);
  await browser.close();
}
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("N", eventos);
  await login(page, P.registraE3, E.clave);
  r.altaDuenoE3 = await agregar(page, ev, "E3-agregar-dueno", P.duenoE2E3, /^Dueño/);
  await browser.close();
}

// ── con cada rol ──
async function comoRol(clave, correo, muestra) {
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("N", eventos);
  await login(page, correo, E.clave);
  const out = await recorridoSeco(page, ev, clave);
  try {
    out.muestra = await muestra(page, ev);
  } catch (e) {
    out.muestra = `ERROR DEL GUION: ${String(e).slice(0, 200)}`;
  }
  await browser.close();
  r.roles[clave] = out;
}

await comoRol("cajero", P.cajero, async (page, ev) => {
  const m = {};
  await page.goto(BASE + "/vender");
  await esperar(page, 3000);
  const caja = await ev(page, "cajero-caja");
  m.cuentasVisibles = (caja.interactivo?.botones ?? [])
    .filter((b) => /Cuenta|Luisa|Pérez|Abastos|Cerrar/.test(b))
    .slice(0, 12);
  // fiar a un cliente nuevo creado en la caja
  if ((await page.getByLabel("Cédula o RIF del cliente").count()) === 0)
    await clic(page.getByRole("button", { name: /Poner cliente/ }).first(), 3000);
  await clic(page.locator("#pos-prefijo"));
  await clic(page.getByRole("option", { name: "V", exact: true }).first());
  await page.getByLabel("Cédula o RIF del cliente").fill("25111222");
  await page.getByLabel("Cédula o RIF del cliente").press("Enter");
  await esperar(page, 1800);
  const nombre = page.getByLabel(/Nombre del cliente|Nombre/).first();
  if ((await nombre.count()) > 0) {
    await nombre.fill("Carlos Fiado Nuevo").catch(() => {});
    await clic(page.getByRole("button", { name: /Guardar y seguir/ }));
    await esperar(page, 1500);
  }
  await page.getByLabel("Buscar productos para vender").fill("Harina precocida caja");
  await esperar(page, 1500);
  await clic(page.getByRole("button", { name: /Harina precocida caja/ }).first());
  await esperar(page, 1000);
  await clic(page.getByRole("button", { name: /Cobrar\s*·\s*F2/ }).first());
  await esperar(page, 1200);
  await clic(
    dialogo(page)
      .getByRole("button", { name: /Fiar todo/ })
      .first(),
  );
  await esperar(page, 800);
  await clic(page.getByRole("button", { name: /Fiar y registrar/ }).first());
  await esperar(page, 3000);
  m.fiar = resumen(await ev(page, "cajero-fiar-cliente-nuevo"));
  await clic(page.getByRole("button", { name: /Nueva venta/ }).first(), 3000);
  await page.goto(BASE + "/admin/ventas");
  await esperar(page, 2500);
  m.ventasPorUrl = resumen(await ev(page, "cajero-admin-ventas-por-url"));
  await page.goto(BASE + "/dinero");
  await esperar(page, 2500);
  m.dinero = resumen(await ev(page, "cajero-dinero"));
  return m;
});

await comoRol("encargado", P.encargado, async (page, ev) => {
  const m = {};
  await page.goto(BASE + "/productos");
  await esperar(page, 2500);
  const prod = await ev(page, "encargado-productos");
  m.productos = {
    texto: prod.texto.slice(0, 500),
    botones: (prod.interactivo?.botones ?? []).slice(-15),
  };
  await page.goto(BASE + "/admin/productos");
  await esperar(page, 2500);
  const adm = await ev(page, "encargado-admin-productos");
  m.adminProductos = {
    texto: adm.texto.slice(0, 500),
    botones: (adm.interactivo?.botones ?? []).slice(-15),
  };
  await page.goto(BASE + "/dinero");
  await esperar(page, 2500);
  m.dinero = resumen(await ev(page, "encargado-dinero"));
  return m;
});

await comoRol("administrativo", P.administrativo, async (page, ev) => {
  const m = {};
  // una factura fiada nueva a Abastos y anularla (G-08)
  await page.goto(BASE + "/admin/ventas/nueva");
  await esperar(page, 2500);
  await page.getByPlaceholder("Buscar por nombre o RIF…").fill("Abastos El Sol");
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
  await page.getByLabel("Cantidad").first().fill("1");
  await clic(page.getByRole("button", { name: /^Emitir factura/ }));
  await esperar(page, 900);
  await clic(page.getByRole("button", { name: /^Emitir la factura$/ }).last());
  await esperar(page, 3000);
  m.emitida = resumen(await ev(page, "administrativo-factura-emitida"));
  await clic(page.getByRole("button", { name: /^Anular$/ }));
  await esperar(page, 900);
  await page
    .getByLabel("Motivo de anulación")
    .fill("Prueba de permisos del administrativo: la factura se emitió duplicada.");
  await clic(page.getByRole("button", { name: /^Anular la factura$/ }).last());
  await esperar(page, 3000);
  m.anular = resumen(await ev(page, "administrativo-anular"));
  return m;
});

await comoRol("contador", P.contador, async (page, ev) => {
  const m = {};
  await page.goto(BASE + "/vender");
  await esperar(page, 3000);
  m.vender = resumen(await ev(page, "contador-vender"));
  return m;
});

await comoRol("almacenista", P.almacenista, async (page, ev) => {
  const m = {};
  await page.goto(BASE + "/admin/llego-mercancia");
  await esperar(page, 3000);
  const ent = await ev(page, "almacenista-llego-mercancia");
  m.entrada = ent.texto.slice(0, 900);
  // recibir el pedido n.º 1 si la pantalla lo ofrece
  const pedido = page.getByText(/Pedido n\.º 1/).first();
  if ((await pedido.count()) > 0) {
    await clic(pedido);
    await esperar(page, 1500);
    m.pedido = resumen(await ev(page, "almacenista-pedido-1"));
  }
  await page.goto(BASE + "/inventario");
  await esperar(page, 2500);
  m.inventario = resumen(await ev(page, "almacenista-inventario"));
  return m;
});

// ── quitar el rol al encargado, desactivar al cajero, y ver qué ven ──
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("N", eventos);
  await login(page, P.duenoE2E3, E.clave);
  await page.goto(BASE + "/admin/configuracion");
  await esperar(page, 2500);
  await clic(page.getByRole("button", { name: /^Quitar el rol Encargado$/ }).first());
  await esperar(page, 800);
  await clic(page.getByRole("button", { name: /^Quitar el rol$/ }).last());
  await esperar(page, 2000);
  r.quitarRol = resumen(await ev(page, "E2-quitar-rol-encargado"));
  const filaCajero = page
    .locator("div")
    .filter({ hasText: P.cajero })
    .filter({ has: page.getByRole("button", { name: /Desactivar/ }) })
    .last();
  await clic(filaCajero.getByRole("button", { name: /Desactivar/ }));
  await esperar(page, 800);
  await clic(page.getByRole("button", { name: /^Desactivar$/ }).last());
  await esperar(page, 2000);
  r.desactivar = resumen(await ev(page, "E2-desactivar-cajero"));
  await browser.close();
}
for (const [clave, correo] of [
  ["encargado-sin-rol", P.encargado],
  ["cajero-desactivado", P.cajero],
]) {
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("N", eventos);
  await login(page, correo, E.clave);
  await esperar(page, 3000);
  r[clave] = { url: page.url(), ...resumen(await ev(page, `${clave}-entra`)) };
  await page.goto(BASE + "/vender");
  await esperar(page, 2500);
  r[clave].vender = resumen(await ev(page, `${clave}-vender`));
  await browser.close();
}
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("N", eventos);
  await login(page, P.duenoE2E3, E.clave);
  await page.goto(BASE + "/admin/configuracion");
  await esperar(page, 2500);
  await clic(page.getByRole("button", { name: /Reactivar/ }).first());
  await esperar(page, 800);
  await clic(page.getByRole("button", { name: /^Reactivar$/ }).last());
  await esperar(page, 2000);
  r.reactivar = resumen(await ev(page, "E2-reactivar-cajero"));
  await browser.close();
}

r.enBase = {
  miembros:
    sql(`select coalesce(c.trade_name, '(tenant)'), u.email, m.status, string_agg(ro.key, ',')
                   from public.user_role_assignments ra join public.memberships m on m.id = ra.membership_id
                   join auth.users u on u.id = m.user_id join public.roles ro on ro.id = ra.role_id
                   left join public.companies c on c.id = ra.company_id group by 1,2,3 order by 1,2`).map(
      (x) => x.join(" | "),
    ),
};
guardarEstado({ n: r });
console.log(JSON.stringify(r, null, 1).slice(0, 30000));

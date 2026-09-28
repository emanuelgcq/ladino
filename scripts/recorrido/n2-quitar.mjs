/**
 * BLOQUE N · 2.ª pasada — quitar el rol, desactivar y reactivar. La 1.ª no llegó: desde que el dueño de E2 es también
 * dueño de E3 (alta de este mismo bloque), al entrar cae en «Elige la empresa» y el guion no la elegía.
 *   1. El cajero abre la caja y arma una venta (la sesión queda abierta).
 *   2. El dueño elige E2, quita el rol Encargado al encargado y desactiva al cajero.
 *   3. Sin recargar, el cajero cobra en efectivo la venta armada: ¿«quitar el rol corta el acceso en el momento»?
 *   4. El encargado sin rol y el cajero desactivado entran de nuevo: ¿qué ven?
 *   5. El dueño reactiva al cajero y le devuelve el rol al encargado.
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
} from "./lib.mjs";

const E = estado();
const P = E.personas;
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);
const resumen = (x) => ({ avisos: x.avisos, red: x.red, texto: x.texto.slice(0, 1000) });
const r = {};

async function entrarE2(page) {
  await login(page, P.duenoE2E3, E.clave);
  const elegir = page.getByRole("button", { name: /Distribuidora Andina/ }).first();
  if ((await elegir.count()) > 0) await clic(elegir);
  await esperar(page, 2500);
}

// 1 · el cajero con la caja abierta y una venta armada
const cajero = await abrir();
const evC = nuevaEvidencia("N", cajero.eventos);
await login(cajero.page, P.cajero, E.clave);
await cajero.page.goto(BASE + "/vender");
await esperar(cajero.page, 3000);
await cajero.page.getByLabel("Buscar productos para vender").fill("Pasta caja x20");
await esperar(cajero.page, 1500);
await clic(cajero.page.getByRole("button", { name: /Pasta caja x20/ }).first());
await esperar(cajero.page, 1000);
r.sinIdentificar = await clic(
  cajero.page.getByRole("button", { name: /Venta sin identificar/ }).first(),
  3000,
);
await esperar(cajero.page, 800);
r.cajeroArmada = resumen(await evC(cajero.page, "cajero-venta-armada-antes-de-desactivar"));

// 2 · el dueño quita el rol y desactiva
const dueno = await abrir();
const evD = nuevaEvidencia("N", dueno.eventos);
await entrarE2(dueno.page);
await dueno.page.goto(BASE + "/admin/configuracion");
await esperar(dueno.page, 2500);
r.quitarBoton = await clic(
  dueno.page.getByRole("button", { name: /Quitar el rol Encargado/ }).first(),
);
await esperar(dueno.page, 900);
await evD(dueno.page, "E2-quitar-rol-confirmacion");
r.quitarConfirmar = await clic(
  dialogo(dueno.page)
    .getByRole("button", { name: /Quitar/ })
    .last(),
);
await esperar(dueno.page, 2000);
r.quitarRol = resumen(await evD(dueno.page, "E2-quitar-rol-encargado-2"));
const filaCajero = dueno.page
  .locator("div")
  .filter({ hasText: P.cajero })
  .filter({ has: dueno.page.getByRole("button", { name: /Desactivar/ }) })
  .last();
r.desactivarBoton = await clic(filaCajero.getByRole("button", { name: /Desactivar/ }));
await esperar(dueno.page, 900);
await evD(dueno.page, "E2-desactivar-confirmacion");
r.desactivarConfirmar = await clic(
  dialogo(dueno.page)
    .getByRole("button", { name: /Desactivar/ })
    .last(),
);
await esperar(dueno.page, 2000);
r.desactivar = resumen(await evD(dueno.page, "E2-desactivar-cajero-2"));
r.enBaseTrasQuitar = sql(`select u.email, m.status, coalesce(string_agg(ro.key, ','), '(sin roles)')
                            from public.memberships m join auth.users u on u.id = m.user_id
                            left join public.user_role_assignments ra on ra.membership_id = m.id
                            left join public.roles ro on ro.id = ra.role_id
                           where u.email in ('${P.cajero}', '${P.encargado}') group by 1, 2`).map(
  (x) => x.join(" | "),
);

// 3 · el cajero, sin recargar, cobra
await clic(cajero.page.getByRole("button", { name: /Cobrar\s*·\s*F2/ }).first());
await esperar(cajero.page, 1200);
await clic(
  dialogo(cajero.page)
    .getByRole("button", { name: /Efectivo Bs|Efectivo en bolívares/ })
    .first(),
);
await esperar(cajero.page, 900);
await clic(
  dialogo(cajero.page)
    .getByRole("button", { name: /^Cobrar / })
    .first(),
);
await esperar(cajero.page, 3500);
r.cajeroCobraDesactivado = resumen(await evC(cajero.page, "cajero-cobra-ya-desactivado"));
await cajero.page.reload();
await esperar(cajero.page, 3000);
r.cajeroRecarga = {
  url: cajero.page.url(),
  ...resumen(await evC(cajero.page, "cajero-recarga-desactivado")),
};
await cajero.browser.close();
r.ventaDelDesactivado =
  sql(`select d.series||'-'||d.document_number, d.kind, d.status, d.total_amount::text, u.email
                               from public.documents d left join auth.users u on u.id = d.created_by
                              where d.company_id = '${E.empresas.E2.id}' and d.created_at > now() - interval '10 minutes'`).map(
    (x) => x.join(" | "),
  );

// 4 · entran de nuevo
for (const [clave, correo] of [
  ["encargado-sin-rol", P.encargado],
  ["cajero-desactivado", P.cajero],
]) {
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("N", eventos);
  await login(page, correo, E.clave);
  await esperar(page, 3000);
  r[clave] = { url: page.url(), ...resumen(await ev(page, `${clave}-entra-2`)) };
  await page.goto(BASE + "/vender");
  await esperar(page, 2500);
  r[clave].vender = { url: page.url(), ...resumen(await ev(page, `${clave}-vender-2`)) };
  await browser.close();
}

// 5 · el dueño deshace
await dueno.page.goto(BASE + "/admin/configuracion");
await esperar(dueno.page, 2500);
r.reactivarBoton = await clic(dueno.page.getByRole("button", { name: /Reactivar/ }).first());
await esperar(dueno.page, 900);
r.reactivarConfirmar = await clic(
  dialogo(dueno.page)
    .getByRole("button", { name: /Reactivar/ })
    .last(),
);
await esperar(dueno.page, 2000);
r.reactivar = resumen(await evD(dueno.page, "E2-reactivar-cajero-2"));
// devolver el rol: «Agregar persona» con el mismo correo
await clic(dueno.page.getByRole("button", { name: /Agregar persona/ }));
await esperar(dueno.page, 900);
await dialogo(dueno.page)
  .getByLabel(/^Correo/)
  .fill(P.encargado);
await clic(dialogo(dueno.page).getByLabel(/^Oficio/));
await esperar(dueno.page, 500);
await clic(dueno.page.getByRole("option", { name: /^Encargado/ }).first());
await clic(dialogo(dueno.page).getByRole("button", { name: /^Agregar$/ }));
await esperar(dueno.page, 2500);
r.devolverRol = resumen(await evD(dueno.page, "E2-devolver-rol-encargado"));
await dueno.browser.close();
r.enBaseFinal = sql(`select u.email, m.status, coalesce(string_agg(ro.key, ','), '(sin roles)')
                       from public.memberships m join auth.users u on u.id = m.user_id
                       left join public.user_role_assignments ra on ra.membership_id = m.id
                       left join public.roles ro on ro.id = ra.role_id
                      where u.email in ('${P.cajero}', '${P.encargado}') group by 1, 2`).map((x) =>
  x.join(" | "),
);
guardarEstado({ n2: r });
console.log(JSON.stringify(r, null, 1).slice(0, 20000));
